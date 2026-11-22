/**
 * Ventify Mobile - Offline Sync Service
 * 
 * Gestor robusto de ventas offline y sincronización idempotente para React Native + Expo SDK 52.
 * Basado en AsyncStorage y NetInfo con control de concurrencia mediante candado (mutex),
 * clasificación automática de errores de negocio vs red, deduplicación en Firestore y
 * sistema de cuarentena para no bloquear ventas válidas en cola.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { db, auth } from '@/lib/firebase';
import { sharedRequestCache } from '@/lib/request-cache';
import { collection, query, where, limit, getDocs, getDoc, doc } from 'firebase/firestore';
import {
  createSaleTransaction,
  CreateSaleTransactionParams,
  CreateSaleTransactionResult,
} from './sale-service';

// ============================================================================
// CONSTANTES Y CLAVES DE ALMACENAMIENTO
// ============================================================================

export const OFFLINE_QUEUE_STORAGE_KEY = 'ventify_offline_sales_queue_v2';
export const QUARANTINED_STORAGE_KEY = 'ventify_quarantined_offline_sales_v2';
export const OFFLINE_SYNC_LOCK_KEY = 'ventify_offline_sync_lock_v2';

export const MAX_OFFLINE_RETRIES = 5;
export const MAX_QUARANTINED_SALES = 100;
export const NETWORK_RECONNECT_DEBOUNCE_MS = 2_500;
export const RETRY_BACKOFF_BASE_MS = 5_000;
export const RETRY_BACKOFF_MAX_MS = 300_000;
export const SYNC_LOCK_TTL_MS = 45_000;

// ============================================================================
// TIPOS E INTERFACES
// ============================================================================

export type OfflineFailureCategory =
  | 'network_error'
  | 'stock_rejected'
  | 'permission_denied'
  | 'cash_session_invalid'
  | 'price_rejected'
  | 'unknown_error';

export interface PendingOfflineSale {
  id: string;
  offlineId: string;
  salePayload: CreateSaleTransactionParams;
  timestamp: number;
  retryCount: number;
  nextRetryAt?: number;
  status: 'pending_offline' | 'quarantined' | 'synced';
  lastErrorReason?: string;
  failureCategory?: OfflineFailureCategory;
}

export interface QuarantinedOfflineSale extends PendingOfflineSale {
  status: 'quarantined';
  quarantinedAt: number;
  lastErrorReason: string;
  failureCategory: OfflineFailureCategory;
}

export interface SyncProcessResult {
  total: number;
  processed: number;
  successful: number;
  quarantined: number;
  retried: number;
  errors: Array<{ offlineId: string; reason: string }>;
}

export interface OfflineQueueChangeEvent {
  type: 'enqueued' | 'synced' | 'updated' | 'quarantined_changed';
  queueCount: number;
  count?: number;
  items?: PendingOfflineSale[];
  successful?: number;
  quarantined?: number;
}

export const offlineSaleBelongsToIdentity = (
  payload: Pick<CreateSaleTransactionParams, 'accountId' | 'userId'>,
  userId: string,
  accountId: string,
): boolean => payload.userId === userId && payload.accountId === accountId;

export const resolveOfflineSyncAccountId = (
  claimAccountId: unknown,
  profileAccountId: unknown,
  ownedAccountId: unknown,
): string | null => {
  const claim = typeof claimAccountId === 'string' ? claimAccountId : '';
  const profile = typeof profileAccountId === 'string' ? profileAccountId : '';
  const owned = typeof ownedAccountId === 'string' ? ownedAccountId : '';
  return profile || claim || owned || null;
};

// ============================================================================
// HELPERS DE SANITIZACIÓN Y CLASIFICACIÓN DE ERRORES
// ============================================================================

/**
 * Sanitiza mensajes de error eliminando PII, tokens, RUCs y credenciales
 */
export const sanitizeErrorMessage = (error: unknown): string => {
  if (!error) return 'Error desconocido';

  let raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
      ? error.message
      : typeof error === 'object' && 'message' in (error as any)
      ? String((error as any).message)
      : String(error);

  // Eliminar tokens de portador
  raw = raw.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, '[REDACTED_TOKEN]');
  // Eliminar JWTs
  raw = raw.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  // Eliminar API Keys
  raw = raw.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED_KEY]');
  // Eliminar correos electrónicos
  raw = raw.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]');
  // Eliminar identificadores largos de Firebase (20+ chars)
  raw = raw.replace(/\b[A-Za-z0-9]{20,}\b/g, '[REDACTED_ID]');

  return raw;
};

/**
 * Determina si el error es transitorio (red) o un conflicto de negocio permanente
 */
export const classifySyncError = (
  error: unknown
): {
  category: OfflineFailureCategory;
  retriable: boolean;
  sanitizedReason: string;
} => {
  const sanitizedReason = sanitizeErrorMessage(error);
  const lower = sanitizedReason.toLowerCase();

  // Stock insuficiente o inexistente
  if (
    lower.includes('stock insuficiente') ||
    lower.includes('insufficient stock') ||
    lower.includes('disponible') ||
    lower.includes('no existe en el catálogo')
  ) {
    return {
      category: 'stock_rejected',
      retriable: false,
      sanitizedReason,
    };
  }

  // Precios mínimos, reglas de margen o discrepancia de total comercial
  if (
    lower.includes('precio mínimo') ||
    lower.includes('precio no permitido') ||
    lower.includes('min price') ||
    lower.includes('modificar precios') ||
    lower.includes('total no coincide') ||
    lower.includes('presentación ya no está disponible') ||
    lower.includes('factor de stock') ||
    lower.includes('ruc válido') ||
    lower.includes('venta incompatible') ||
    lower.includes('créditos suficientes') ||
    lower.includes('límite de crédito')
  ) {
    return {
      category: 'price_rejected',
      retriable: false,
      sanitizedReason,
    };
  }

  // Sesión de caja cerrada o ausente
  if (
    lower.includes('sesión de caja') ||
    lower.includes('sesion de caja') ||
    lower.includes('caja abierta') ||
    lower.includes('caja cerrada') ||
    lower.includes('abre tu caja') ||
    lower.includes('cash session')
  ) {
    return {
      category: 'cash_session_invalid',
      retriable: false,
      sanitizedReason,
    };
  }

  // Permisos o autenticación
  if (
    lower.includes('permission-denied') ||
    lower.includes('permiso') ||
    lower.includes('unauthenticated') ||
    lower.includes('no autorizado') ||
    lower.includes('atribución por vendedor')
  ) {
    return {
      category: 'permission_denied',
      retriable: false,
      sanitizedReason,
    };
  }

  // Problemas transitorios de red
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('timeout') ||
    lower.includes('abort') ||
    lower.includes('unavailable') ||
    lower.includes('failed-precondition') ||
    lower.includes('deadline-exceeded') ||
    lower.includes('offline') ||
    lower.includes('could not reach') ||
    lower.includes('connection') ||
    lower.includes('socket') ||
    lower.includes('dns') ||
    lower.includes('timed out') ||
    lower.includes('tiempo de espera') ||
    lower.includes('sin conexión') ||
    lower.includes('network-request-failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout')
  ) {
    return {
      category: 'network_error',
      retriable: true,
      sanitizedReason,
    };
  }

  return {
    category: 'unknown_error',
    retriable: true,
    sanitizedReason,
  };
};

// ============================================================================
// SERVICIO OFFLINE SYNC
// ============================================================================

const deduplicateAndCapQuarantine = (
  items: QuarantinedOfflineSale[]
): QuarantinedOfflineSale[] => {
  const byKey = new Map<string, QuarantinedOfflineSale>();
  for (const item of items) {
    const key = item.offlineId || item.id;
    if (!key) continue;
    const existing = byKey.get(key);
    const existingTs = existing ? (existing.quarantinedAt || existing.timestamp || 0) : -1;
    const nextTs = item.quarantinedAt || item.timestamp || 0;
    if (!existing || nextTs >= existingTs) {
      if (existing) byKey.delete(key);
      byKey.set(key, item);
    }
  }
  const deduped = Array.from(byKey.values());
  deduped.sort(
    (a, b) => (a.quarantinedAt || a.timestamp || 0) - (b.quarantinedAt || b.timestamp || 0)
  );
  return deduped.length > MAX_QUARANTINED_SALES
    ? deduped.slice(-MAX_QUARANTINED_SALES)
    : deduped;
};

class OfflineSyncService {
  private static readonly REACHABILITY_BACKOFF_STEPS_MS = [5_000, 15_000, 30_000, 60_000] as const;

  private isProcessingInMemory = false;
  private netInfoUnsubscribe: (() => void) | null = null;
  private networkSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private retryWakeupTimer: ReturnType<typeof setTimeout> | null = null;
  private queueMutex: Promise<void> = Promise.resolve();
  private queueCache: PendingOfflineSale[] | null = null;
  private reachabilityBackoffIndex = 0;
  private listeners = new Set<(event: OfflineQueueChangeEvent) => void>();

  public resetQueueCache(): void {
    this.queueCache = null;
    this.reachabilityBackoffIndex = 0;
  }

  private async loadQueueLocked(): Promise<PendingOfflineSale[]> {
    if (this.queueCache !== null) {
      return [...this.queueCache];
    }
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (!raw) {
        this.queueCache = [];
        return [];
      }
      const parsed = JSON.parse(raw);
      const normalized = Array.isArray(parsed) ? parsed : [];
      this.queueCache = normalized;
      return [...normalized];
    } catch (err) {
      console.error('[OfflineSync] Error al leer cola offline:', err);
      return [];
    }
  }

  private async writeQueueLocked(nextQueue: PendingOfflineSale[]): Promise<PendingOfflineSale[]> {
    const snapshot = [...nextQueue];
    await AsyncStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(snapshot));
    this.queueCache = snapshot;
    return [...snapshot];
  }

  public subscribeQueueChanges(
    listener: (event: OfflineQueueChangeEvent) => void
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitQueueChange(event: OfflineQueueChangeEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[OfflineSync] Queue change listener error:', err);
      }
    }
  }

  private runWithQueueMutex<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queueMutex.then(task);
    this.queueMutex = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Genera un identificador único e idempotente para la venta offline
   */
  public generateOfflineId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `offline_${timestamp}_${random}`;
  }

  /**
   * Guarda una venta en la cola local de AsyncStorage cuando el dispositivo no tiene red
   */
  public async enqueueOfflineSale(
    salePayload: CreateSaleTransactionParams
  ): Promise<PendingOfflineSale> {
    const offlineId = salePayload.offlineId || this.generateOfflineId();
    const { skipOfflineDedup: _omit, ...sanitizedPayload } =
      salePayload as CreateSaleTransactionParams & { skipOfflineDedup?: unknown };
    const enrichedPayload: CreateSaleTransactionParams = {
      ...(sanitizedPayload as CreateSaleTransactionParams),
      offlineId,
    };

    const pendingItem: PendingOfflineSale = {
      id: offlineId,
      offlineId,
      salePayload: enrichedPayload,
      timestamp: Date.now(),
      retryCount: 0,
      status: 'pending_offline',
    };

    try {
      const updatedQueue = await this.runWithQueueMutex(async () => {
        const currentQueue = await this.loadQueueLocked();
        // Evitar duplicados por offlineId
        const filtered = currentQueue.filter((q) => q.offlineId !== offlineId);
        filtered.push(pendingItem);

        return await this.writeQueueLocked(filtered);
      });
      this.emitQueueChange({
        type: 'enqueued',
        queueCount: updatedQueue.length,
        count: updatedQueue.length,
        items: updatedQueue,
      });
      console.log(`[OfflineSync] Venta encolada exitosamente: ${offlineId}`);
      return pendingItem;
    } catch (err) {
      console.error('[OfflineSync] Error al encolar venta offline:', err);
      throw new Error(`Fallo al guardar venta offline en almacenamiento local: ${sanitizeErrorMessage(err)}`);
    }
  }

  /**
   * Obtiene la cola de ventas pendientes de sincronización
   */
  public async getOfflineQueue(): Promise<PendingOfflineSale[]> {
    if (this.queueCache !== null) {
      return [...this.queueCache];
    }
    return this.runWithQueueMutex(() => this.loadQueueLocked());
  }

  /**
   * Obtiene la lista de ventas en cuarentena que requieren revisión manual
   */
  public async getQuarantinedSales(): Promise<QuarantinedOfflineSale[]> {
    try {
      const raw = await AsyncStorage.getItem(QUARANTINED_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[OfflineSync] Error al leer ventas en cuarentena:', err);
      return [];
    }
  }

  /**
   * Mueve una venta de cuarentena de regreso a la cola activa para reintento manual
   */
  public async retryQuarantinedSale(offlineId: string): Promise<boolean> {
    try {
      const result = await this.runWithQueueMutex(async () => {
        const quarantined = await this.getQuarantinedSales();
        const target = quarantined.find((q) => q.offlineId === offlineId);

        if (!target) {
          console.warn(`[OfflineSync] No se encontró la venta ${offlineId} en cuarentena.`);
          return { moved: false, items: [] as PendingOfflineSale[] };
        }

        // Remover de cuarentena
        const remainingQuarantine = quarantined.filter((q) => q.offlineId !== offlineId);
        await AsyncStorage.setItem(
          QUARANTINED_STORAGE_KEY,
          JSON.stringify(remainingQuarantine)
        );

        // Re-encolar con retryCount y nextRetryAt reseteados
        const resetItem: PendingOfflineSale = {
          ...target,
          retryCount: 0,
          nextRetryAt: undefined,
          status: 'pending_offline',
          lastErrorReason: undefined,
          failureCategory: undefined,
        };

        const queue = await this.loadQueueLocked();
        const filteredQueue = queue.filter((q) => q.offlineId !== offlineId);
        filteredQueue.push(resetItem);
        const persisted = await this.writeQueueLocked(filteredQueue);
        return { moved: true, items: persisted };
      });

      if (!result.moved) return false;

      this.emitQueueChange({
        type: 'quarantined_changed',
        queueCount: result.items.length,
        count: result.items.length,
        items: result.items,
      });

      // Disparar procesamiento si hay internet
      const net = await NetInfo.fetch();
      if (net.isConnected && net.isInternetReachable !== false) {
        this.processOfflineQueue().catch((e) =>
          console.warn('[OfflineSync] Error in background retry trigger:', e)
        );
      }

      return true;
    } catch (err) {
      console.error('[OfflineSync] Error reintentando venta en cuarentena:', err);
      return false;
    }
  }

  /**
   * Descarta permanentemente una venta en cuarentena
   */
  public async removeQuarantinedSale(offlineId: string): Promise<boolean> {
    try {
      const queueItems = await this.runWithQueueMutex(async () => {
        const quarantined = await this.getQuarantinedSales();
        const filtered = quarantined.filter((q) => q.offlineId !== offlineId);
        await AsyncStorage.setItem(QUARANTINED_STORAGE_KEY, JSON.stringify(filtered));
        return await this.loadQueueLocked();
      });
      this.emitQueueChange({
        type: 'quarantined_changed',
        queueCount: queueItems.length,
        count: queueItems.length,
        items: queueItems,
      });
      return true;
    } catch (err) {
      console.error('[OfflineSync] Error eliminando venta en cuarentena:', err);
      return false;
    }
  }

  /**
   * Procesa la cola de ventas offline pendientes con candado de sincronización y deduplicación
   */
  public async processOfflineQueue(accountIdOverride?: string): Promise<SyncProcessResult> {
    const summary: SyncProcessResult = {
      total: 0,
      processed: 0,
      successful: 0,
      quarantined: 0,
      retried: 0,
      errors: [],
    };

    if (this.isProcessingInMemory) {
      console.log('[OfflineSync] Candado de sincronización ocupado por otro proceso.');
      return summary;
    }

    // 0. Verificar cola local PRIMERO antes de consultar NetInfo, claims o Firestore
    const initialQueue = await this.getOfflineQueue();
    if (initialQueue.length === 0) {
      this.reachabilityBackoffIndex = 0;
      this.clearRetryWakeupTimer();
      return summary;
    }

    // 1. Verificar estado de red
    const netState = await NetInfo.fetch();
    if (!netState.isConnected || netState.isInternetReachable === false) {
      if (netState.isConnected && netState.isInternetReachable === false) {
        const steps = OfflineSyncService.REACHABILITY_BACKOFF_STEPS_MS;
        const delay = steps[Math.min(this.reachabilityBackoffIndex, steps.length - 1)];
        this.reachabilityBackoffIndex = Math.min(this.reachabilityBackoffIndex + 1, steps.length - 1);
        this.scheduleRetryWakeup(delay, accountIdOverride);
      } else {
        this.reachabilityBackoffIndex = 0;
        this.clearRetryWakeupTimer();
      }
      console.log('[OfflineSync] Sin conexión a internet. Omitiendo sincronización.');
      return summary;
    }
    this.reachabilityBackoffIndex = 0;

    // 2. Control de concurrencia con Mutex Lock exclusivo en memoria
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      console.log('[OfflineSync] Candado de sincronización ocupado por otro proceso.');
      return summary;
    }

    let emittedEvent: OfflineQueueChangeEvent | null = null;

    try {
      const queue = await this.runWithQueueMutex(() => this.loadQueueLocked());
      summary.total = queue.length;

      if (queue.length === 0) {
        this.clearRetryWakeupTimer();
        return summary;
      }

      const checkNow = Date.now();
      const hasDueItems = queue.some(
        (item) => typeof item.nextRetryAt !== 'number' || checkNow >= item.nextRetryAt
      );
      if (!hasDueItems) {
        const futureRetryTimes = queue
          .map((item) => item.nextRetryAt)
          .filter((t): t is number => typeof t === 'number' && t > checkNow);
        if (futureRetryTimes.length > 0) {
          const earliestNextRetryAt = Math.min(...futureRetryTimes);
          const delay = Math.max(1_500, Math.min(60_000, earliestNextRetryAt - checkNow));
          this.scheduleRetryWakeup(delay, accountIdOverride);
        }
        return summary;
      }

      const currentUser = auth.currentUser;
      if (!currentUser) return summary;

      let currentAccountId = accountIdOverride || '';
      if (!currentAccountId) {
        let claimAccountId: string | null = null;
        try {
          const tokenResult = await currentUser.getIdTokenResult();
          if (auth.currentUser?.uid !== currentUser.uid) return summary;
          claimAccountId = typeof tokenResult.claims.accountId === 'string'
            ? tokenResult.claims.accountId
            : null;
        } catch {
          // Match AuthContext: an unavailable claims read may still resolve from profile/ownership.
        }
        let profileAccountId: string | null = null;
        if (!claimAccountId) {
          profileAccountId = await sharedRequestCache.getOrLoad(
            `user_account:${currentUser.uid}`,
            120_000,
            async () => {
              const userSnapshot = await getDoc(doc(db, 'users', currentUser.uid));
              return userSnapshot.exists() && typeof userSnapshot.data()?.accountId === 'string'
                ? String(userSnapshot.data()?.accountId)
                : null;
            },
            { cacheNullish: false }
          );
          if (auth.currentUser?.uid !== currentUser.uid) return summary;
        }
        let ownedAccountId: string | null = null;
        if (!profileAccountId && !claimAccountId) {
          const ownedAccounts = await getDocs(query(
            collection(db, 'accounts'),
            where('ownerId', '==', currentUser.uid),
            limit(1),
          ));
          if (ownedAccounts.docs[0]) ownedAccountId = ownedAccounts.docs[0].id;
        }
        if (auth.currentUser?.uid !== currentUser.uid) return summary;
        currentAccountId = resolveOfflineSyncAccountId(claimAccountId, profileAccountId, ownedAccountId) || '';
      }
      if (!currentAccountId) return summary;

      console.log(`[OfflineSync] Procesando ${queue.length} ventas offline pendientes...`);

      const completedTimestamps = new Map<string, number>();
      const retriedByOfflineId = new Map<string, PendingOfflineSale>();
      const quarantinedToAdd: QuarantinedOfflineSale[] = [];

      for (const item of queue) {
        if (!offlineSaleBelongsToIdentity(item.salePayload, currentUser.uid, currentAccountId)) {
          continue;
        }
        if (typeof item.nextRetryAt === 'number' && Date.now() < item.nextRetryAt) {
          continue;
        }
        summary.processed++;

        try {
          // A. DEDUPLICACIÓN EN FIRESTORE
          // Verifica si la venta ya fue registrada previamente en el servidor
          let alreadySynced = false;
          let dedupConfirmedNoDuplicate = false;
          try {
            const existingQ = query(
              collection(db, 'sales'),
              where('accountId', '==', item.salePayload.accountId),
              where('offlineId', '==', item.offlineId),
              limit(1)
            );
            const existingSnap = await getDocs(existingQ);

            if (!existingSnap.empty) {
              console.log(
                `[OfflineSync] Venta ${item.offlineId} ya existe en Firestore (id: ${existingSnap.docs[0].id}). Marcada como exitosa.`
              );
              completedTimestamps.set(item.offlineId, item.timestamp);
              summary.successful++;
              alreadySynced = true;
            } else {
              dedupConfirmedNoDuplicate = true;
            }
          } catch (dedupErr) {
            console.warn(
              `[OfflineSync] Pre-check de deduplicación falló para ${item.offlineId}; continuando con createSaleTransaction:`,
              sanitizeErrorMessage(dedupErr)
            );
          }

          if (alreadySynced) {
            continue; // Se descarta de la cola activa
          }

          // B. EJECUTAR TRANSACCIÓN ATÓMICA DE VENTA (omitir dedup duplicada cuando pre-check ya la confirmó)
          const rawPayload = item.salePayload as CreateSaleTransactionParams & {
            skipOfflineDedup?: unknown;
          };
          let payloadToSync: CreateSaleTransactionParams;
          if (dedupConfirmedNoDuplicate) {
            payloadToSync = {
              ...(rawPayload as CreateSaleTransactionParams),
              skipOfflineDedup: true,
            };
          } else if ('skipOfflineDedup' in rawPayload) {
            const { skipOfflineDedup: _omit, ...rest } = rawPayload;
            payloadToSync = rest as CreateSaleTransactionParams;
          } else {
            payloadToSync = item.salePayload;
          }
          await createSaleTransaction(payloadToSync);

          console.log(`[OfflineSync] Venta sincronizada con éxito: ${item.offlineId}`);
          completedTimestamps.set(item.offlineId, item.timestamp);
          summary.successful++;
        } catch (itemErr: any) {
          const classified = classifySyncError(itemErr);
          const currentRetries = (item.retryCount || 0) + 1;

          console.warn(
            `[OfflineSync] Error en venta ${item.offlineId} (intento ${currentRetries}/${MAX_OFFLINE_RETRIES}):`,
            classified.sanitizedReason
          );

          summary.errors.push({
            offlineId: item.offlineId,
            reason: classified.sanitizedReason,
          });

          // Si el error no es reintentable (conflicto de stock, precio, etc.) o excedió el límite de reintentos
          if (!classified.retriable || currentRetries >= MAX_OFFLINE_RETRIES) {
            console.error(
              `[OfflineSync] Moviendo venta ${item.offlineId} a CUARENTENA (${classified.category}): ${classified.sanitizedReason}`
            );

            quarantinedToAdd.push({
              ...item,
              status: 'quarantined',
              retryCount: currentRetries,
              nextRetryAt: undefined,
              quarantinedAt: Date.now(),
              lastErrorReason: classified.sanitizedReason,
              failureCategory: classified.category,
            });
            completedTimestamps.set(item.offlineId, item.timestamp);
            summary.quarantined++;
          } else {
            // Reintento diferido con backoff exponencial
            const backoffMs = Math.min(
              RETRY_BACKOFF_MAX_MS,
              RETRY_BACKOFF_BASE_MS * Math.pow(3, item.retryCount || 0)
            );
            retriedByOfflineId.set(item.offlineId, {
              ...item,
              retryCount: currentRetries,
              nextRetryAt: Date.now() + backoffMs,
              lastErrorReason: classified.sanitizedReason,
              failureCategory: classified.category,
            });
            summary.retried++;
          }
        }
      }

      let remainingCount = queue.length;
      let nextQueueSnapshot: PendingOfflineSale[] = queue;
      if (summary.processed > 0) {
        nextQueueSnapshot = await this.runWithQueueMutex(async () => {
          const latestQueue = await this.loadQueueLocked();
          const nextQueue: PendingOfflineSale[] = [];

          for (const latestItem of latestQueue) {
            const removedTs = completedTimestamps.get(latestItem.offlineId);
            if (removedTs !== undefined && latestItem.timestamp <= removedTs) {
              continue;
            }

            const retriedItem = retriedByOfflineId.get(latestItem.offlineId);
            if (retriedItem && latestItem.timestamp <= retriedItem.timestamp) {
              nextQueue.push(retriedItem);
              continue;
            }

            nextQueue.push(latestItem);
          }

          // Guardar cola activa actualizada y refrescar cache en memoria
          const persisted = await this.writeQueueLocked(nextQueue);

          // Guardar cuarentena acumulada (deduplicada y acotada a 100 entradas)
          if (quarantinedToAdd.length > 0) {
            const existingQuarantine = await this.getQuarantinedSales();
            const combined = deduplicateAndCapQuarantine([
              ...existingQuarantine,
              ...quarantinedToAdd,
            ]);
            await AsyncStorage.setItem(QUARANTINED_STORAGE_KEY, JSON.stringify(combined));
          }

          return persisted;
        });
        remainingCount = nextQueueSnapshot.length;
      }

      const nowAfter = Date.now();
      const pendingRetryTimes = nextQueueSnapshot
        .map((item) => item.nextRetryAt)
        .filter((t): t is number => typeof t === 'number' && t > nowAfter);
      if (pendingRetryTimes.length > 0) {
        const earliestNextRetryAt = Math.min(...pendingRetryTimes);
        const delay = Math.max(1_500, Math.min(60_000, earliestNextRetryAt - nowAfter));
        this.scheduleRetryWakeup(delay, accountIdOverride);
      } else if (remainingCount === 0) {
        this.clearRetryWakeupTimer();
      }

      if (summary.processed > 0 || summary.successful > 0 || summary.quarantined > 0) {
        emittedEvent = {
          type:
            summary.successful > 0
              ? 'synced'
              : summary.quarantined > 0
              ? 'quarantined_changed'
              : 'updated',
          queueCount: remainingCount,
          count: remainingCount,
          items: nextQueueSnapshot,
          successful: summary.successful,
          quarantined: summary.quarantined,
        };
      }

      console.log(
        `[OfflineSync] Sincronización completada. Éxitos: ${summary.successful}, Cuarentena: ${summary.quarantined}, Pendientes: ${remainingCount}`
      );
      return summary;
    } finally {
      await this.releaseLock();
      if (emittedEvent) {
        this.emitQueueChange(emittedEvent);
      }
    }
  }

  private clearNetworkSyncTimer(): void {
    if (this.networkSyncTimer) {
      clearTimeout(this.networkSyncTimer);
      this.networkSyncTimer = null;
    }
  }

  private clearRetryWakeupTimer(): void {
    if (this.retryWakeupTimer) {
      clearTimeout(this.retryWakeupTimer);
      this.retryWakeupTimer = null;
    }
  }

  private scheduleRetryWakeup(delayMs: number, accountIdOverride?: string): void {
    this.clearRetryWakeupTimer();
    this.retryWakeupTimer = setTimeout(() => {
      this.retryWakeupTimer = null;
      void this.processOfflineQueue(accountIdOverride).catch((err) =>
        console.warn('[OfflineSync] Error en reintento automático de cola offline:', err)
      );
    }, delayMs);
  }

  private teardownNetworkListener(): void {
    this.clearNetworkSyncTimer();
    this.clearRetryWakeupTimer();
    if (this.netInfoUnsubscribe) {
      this.netInfoUnsubscribe();
      this.netInfoUnsubscribe = null;
    }
  }

  /**
   * Inicia el listener automático de NetInfo para sincronizar cuando regresa la conexión
   */
  public initNetworkListener(): () => void {
    this.teardownNetworkListener();

    let wasOffline = false;

    this.netInfoUnsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const isOnline = Boolean(state.isConnected && state.isInternetReachable !== false);

      if (!isOnline) {
        wasOffline = true;
        this.clearNetworkSyncTimer();
        return;
      }

      if (wasOffline) {
        wasOffline = false;
        this.reachabilityBackoffIndex = 0;
        this.clearNetworkSyncTimer();
        this.networkSyncTimer = setTimeout(() => {
          this.networkSyncTimer = null;
          console.log('[OfflineSync] Red restaurada. Disparando sincronización automática...');
          this.processOfflineQueue().catch((err) =>
            console.warn('[OfflineSync] Error en sincronización por evento de red:', err)
          );
        }, NETWORK_RECONNECT_DEBOUNCE_MS);
      } else {
        this.reachabilityBackoffIndex = 0;
      }
    });

    return () => {
      this.teardownNetworkListener();
    };
  }

  // ============================================================================
  // MUTEX LOCK HELPERS
  // ============================================================================

  private async acquireLock(): Promise<boolean> {
    if (this.isProcessingInMemory) {
      return false;
    }
    this.isProcessingInMemory = true;
    return true;
  }

  private async releaseLock(): Promise<void> {
    this.isProcessingInMemory = false;
  }
}

export const offlineSyncService = new OfflineSyncService();

// Exportaciones directas de funciones para ergonomía de importación
export const enqueueOfflineSale = (payload: CreateSaleTransactionParams) =>
  offlineSyncService.enqueueOfflineSale(payload);

export const processOfflineQueue = (accountIdOverride?: string) =>
  offlineSyncService.processOfflineQueue(accountIdOverride);

export const getOfflineQueue = () =>
  offlineSyncService.getOfflineQueue();

export const getQuarantinedSales = () =>
  offlineSyncService.getQuarantinedSales();

export const retryQuarantinedSale = (offlineId: string) =>
  offlineSyncService.retryQuarantinedSale(offlineId);

export const removeQuarantinedSale = (offlineId: string) =>
  offlineSyncService.removeQuarantinedSale(offlineId);

export const initOfflineSyncListener = () =>
  offlineSyncService.initNetworkListener();

export const subscribeOfflineQueueChanges = (
  listener: (event: OfflineQueueChangeEvent) => void
): (() => void) => offlineSyncService.subscribeQueueChanges(listener);
