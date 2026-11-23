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
import { withTimeout } from '@/lib/online-guard';
import type { AuthoritativeProductStockPatch } from '@/lib/offline-stock-helpers';
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
  type: 'enqueued' | 'synced' | 'item_synced' | 'updated' | 'quarantined_changed';
  queueCount: number;
  count?: number;
  items?: PendingOfflineSale[];
  successful?: number;
  quarantined?: number;
  offlineId?: string;
  syncedOfflineIds?: string[];
  updatedProductStocks?: AuthoritativeProductStockPatch[];
  quarantinedCount?: number;
}

export interface OfflineItemSyncedEvent {
  offlineId: string;
  affectedProductIds: string[];
  updatedProductStocks: AuthoritativeProductStockPatch[];
  items: PendingOfflineSale[];
  queueCount: number;
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

  // Problemas transitorios de red (evaluar antes que "disponible" para no confundir "servicio no disponible")
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('timeout') ||
    lower.includes('abort') ||
    lower.includes('unavailable') ||
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
    lower.includes('etimedout') ||
    lower.includes('servicio no disponible') ||
    lower.includes('temporalmente no disponible') ||
    lower.includes('red no disponible') ||
    lower.includes('servidor no disponible')
  ) {
    return {
      category: 'network_error',
      retriable: true,
      sanitizedReason,
    };
  }

  // Stock insuficiente o inexistente
  if (
    lower.includes('stock insuficiente') ||
    lower.includes('insufficient stock') ||
    lower.includes('stock disponible') ||
    lower.includes('disponible:') ||
    lower.includes('sin stock') ||
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

  if (lower.includes('failed-precondition')) {
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
  private lockAcquiredAt = 0;
  private activeSyncPromise: Promise<SyncProcessResult> | null = null;
  private resyncRequested = false;
  private netInfoUnsubscribe: (() => void) | null = null;
  private networkSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private retryWakeupTimer: ReturnType<typeof setTimeout> | null = null;
  private queueMutex: Promise<void> = Promise.resolve();
  private queueCache: PendingOfflineSale[] | null = null;
  private reachabilityBackoffIndex = 0;
  private listeners = new Set<(event: OfflineQueueChangeEvent) => void>();
  private itemSyncedListeners = new Set<(event: OfflineItemSyncedEvent) => void>();

  public resetQueueCache(): void {
    this.queueCache = null;
    this.reachabilityBackoffIndex = 0;
  }

  public cancelPendingWork(): void {
    this.resyncRequested = false;
    this.clearNetworkSyncTimer();
    this.clearRetryWakeupTimer();
  }

  private async loadQueueLocked(): Promise<PendingOfflineSale[]> {
    if (this.queueCache !== null) {
      return [...this.queueCache];
    }
    const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    if (!raw) {
      this.queueCache = [];
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Formato inválido en cola offline almacenada.');
    }
    this.queueCache = parsed;
    return [...parsed];
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

  public subscribeItemSynced(
    listener: (event: OfflineItemSyncedEvent) => void
  ): () => void {
    this.itemSyncedListeners.add(listener);
    return () => {
      this.itemSyncedListeners.delete(listener);
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

  private emitItemSynced(event: OfflineItemSyncedEvent): void {
    for (const listener of Array.from(this.itemSyncedListeners)) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[OfflineSync] Item synced listener error:', err);
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
    const {
      skipOfflineDedup: _omitDedup,
      onSunatResult: _omitSunatCb,
      ...sanitizedPayload
    } = salePayload as CreateSaleTransactionParams & {
      skipOfflineDedup?: unknown;
      onSunatResult?: unknown;
    };
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
        const filtered = currentQueue.filter((q) => q.offlineId !== offlineId);
        filtered.push(pendingItem);

        return await this.writeQueueLocked(filtered);
      });
      if (this.activeSyncPromise) {
        this.resyncRequested = true;
      }
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
    try {
      return await this.runWithQueueMutex(() => this.loadQueueLocked());
    } catch (err) {
      console.error('[OfflineSync] Error al leer cola offline:', err);
      return [];
    }
  }

  public async getOfflineQueueForIdentity(
    userId: string,
    accountId: string
  ): Promise<PendingOfflineSale[]> {
    const queue = await this.getOfflineQueue();
    return queue.filter((item) =>
      offlineSaleBelongsToIdentity(item.salePayload, userId, accountId)
    );
  }

  /**
   * Cancela y elimina una venta offline aún no sincronizada de la cola activa
   */
  public async cancelPendingOfflineSale(offlineId: string): Promise<boolean> {
    if (!offlineId) return false;
    try {
      const result = await this.runWithQueueMutex(async () => {
        const currentQueue = await this.loadQueueLocked();
        const filtered = currentQueue.filter((q) => q.offlineId !== offlineId);
        if (filtered.length === currentQueue.length) {
          return { removed: false, items: currentQueue };
        }
        const persisted = await this.writeQueueLocked(filtered);
        return { removed: true, items: persisted };
      });
      if (!result.removed) return false;
      this.emitQueueChange({
        type: 'updated',
        queueCount: result.items.length,
        count: result.items.length,
        items: result.items,
      });
      return true;
    } catch (err) {
      console.error('[OfflineSync] Error cancelando venta offline pendiente:', err);
      return false;
    }
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

  public async getQuarantinedSalesForIdentity(
    userId: string,
    accountId: string
  ): Promise<QuarantinedOfflineSale[]> {
    const all = await this.getQuarantinedSales();
    return all.filter((item) =>
      offlineSaleBelongsToIdentity(item.salePayload, userId, accountId)
    );
  }

  /**
   * Mueve una venta de cuarentena de regreso a la cola activa para reintento manual
   */
  public async retryQuarantinedSale(
    offlineId: string,
    options?: { newSessionId?: string; accountId?: string }
  ): Promise<boolean> {
    try {
      const result = await this.runWithQueueMutex(async () => {
        const quarantined = await this.getQuarantinedSales();
        const target = quarantined.find((q) => q.offlineId === offlineId);

        if (!target) {
          console.warn(`[OfflineSync] No se encontró la venta ${offlineId} en cuarentena.`);
          return { moved: false, items: [] as PendingOfflineSale[], accountId: undefined as string | undefined };
        }

        const updatedPayload: CreateSaleTransactionParams = options?.newSessionId
          ? { ...target.salePayload, sessionId: options.newSessionId }
          : target.salePayload;

        const resetItem: PendingOfflineSale = {
          ...target,
          salePayload: updatedPayload,
          retryCount: 0,
          nextRetryAt: undefined,
          status: 'pending_offline',
          lastErrorReason: undefined,
          failureCategory: undefined,
        };

        // Escritura atómica segura: escribir cola activa PRIMERO, luego remover de cuarentena
        const queue = await this.loadQueueLocked();
        const filteredQueue = queue.filter((q) => q.offlineId !== offlineId);
        filteredQueue.push(resetItem);
        const persisted = await this.writeQueueLocked(filteredQueue);

        const remainingQuarantine = quarantined.filter((q) => q.offlineId !== offlineId);
        await AsyncStorage.setItem(
          QUARANTINED_STORAGE_KEY,
          JSON.stringify(remainingQuarantine)
        );

        return {
          moved: true,
          items: persisted,
          accountId: options?.accountId || updatedPayload.accountId,
        };
      });

      if (!result.moved) return false;

      if (this.activeSyncPromise) {
        this.resyncRequested = true;
      }

      this.emitQueueChange({
        type: 'quarantined_changed',
        queueCount: result.items.length,
        count: result.items.length,
        items: result.items,
      });

      const net = await NetInfo.fetch();
      if (net.isConnected && net.isInternetReachable !== false) {
        this.processOfflineQueue({ accountId: result.accountId, force: true }).catch((e) =>
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
  public async processOfflineQueue(
    accountIdOrOpts?: string | { accountId?: string; force?: boolean }
  ): Promise<SyncProcessResult> {
    const accountIdOverride =
      typeof accountIdOrOpts === 'string' ? accountIdOrOpts : accountIdOrOpts?.accountId;
    const force = typeof accountIdOrOpts === 'object' && accountIdOrOpts?.force === true;

    const emptySummary: SyncProcessResult = {
      total: 0,
      processed: 0,
      successful: 0,
      quarantined: 0,
      retried: 0,
      errors: [],
    };

    if (this.activeSyncPromise) {
      if (Date.now() - this.lockAcquiredAt > SYNC_LOCK_TTL_MS) {
        this.isProcessingInMemory = false;
        this.activeSyncPromise = null;
      } else {
        if (force) {
          this.resyncRequested = true;
        }
        return this.activeSyncPromise;
      }
    }

    if (this.isProcessingInMemory) {
      if (Date.now() - this.lockAcquiredAt > SYNC_LOCK_TTL_MS) {
        this.isProcessingInMemory = false;
      } else {
        console.log('[OfflineSync] Candado de sincronización ocupado por otro proceso.');
        return emptySummary;
      }
    }

    const executeSync = async (): Promise<SyncProcessResult> => {
      const summary: SyncProcessResult = {
        total: 0,
        processed: 0,
        successful: 0,
        quarantined: 0,
        retried: 0,
        errors: [],
      };

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
      const accumulatedStockPatches: AuthoritativeProductStockPatch[] = [];
      const syncedOfflineIds: string[] = [];

      try {
        const queue = await this.runWithQueueMutex(() => this.loadQueueLocked());
        summary.total = queue.length;

        if (queue.length === 0) {
          this.clearRetryWakeupTimer();
          return summary;
        }

        const checkNow = Date.now();
        const hasDueItems =
          force ||
          queue.some(
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
            // Unavailable claims read may still resolve from profile/ownership.
          }
          let profileAccountId: string | null = null;
          if (!claimAccountId) {
            try {
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
            } catch {
              profileAccountId = null;
            }
            if (auth.currentUser?.uid !== currentUser.uid) return summary;
          }
          let ownedAccountId: string | null = null;
          if (!profileAccountId && !claimAccountId) {
            try {
              const ownedAccounts = await getDocs(query(
                collection(db, 'accounts'),
                where('ownerId', '==', currentUser.uid),
                limit(1),
              ));
              if (ownedAccounts.docs[0]) ownedAccountId = ownedAccounts.docs[0].id;
            } catch {
              ownedAccountId = null;
            }
          }
          if (auth.currentUser?.uid !== currentUser.uid) return summary;
          currentAccountId = resolveOfflineSyncAccountId(claimAccountId, profileAccountId, ownedAccountId) || '';
        }
        if (!currentAccountId) return summary;

        console.log(`[OfflineSync] Procesando ${queue.length} ventas offline pendientes...`);

        let latestQueueSnapshot: PendingOfflineSale[] = queue;

        for (const item of queue) {
          // Verificar sesión activa en cada iteración para nunca cuarentenar ventas tras logout
          if (auth.currentUser?.uid !== currentUser.uid) {
            console.warn('[OfflineSync] Usuario cambió o cerró sesión durante sincronización; abortando lote.');
            break;
          }

          if (!offlineSaleBelongsToIdentity(item.salePayload, currentUser.uid, currentAccountId)) {
            continue;
          }
          if (!force && typeof item.nextRetryAt === 'number' && Date.now() < item.nextRetryAt) {
            continue;
          }
          summary.processed++;

          const affectedProductIds = Array.from(
            new Set(
              (Array.isArray(item.salePayload?.items) ? item.salePayload.items : [])
                .map((it: any) => String(it?.productId || '').split('_')[0])
                .filter(Boolean)
            )
          );

          try {
            // A. DEDUPLICACIÓN EN FIRESTORE
            let alreadySynced = false;
            let dedupConfirmedNoDuplicate = false;
            try {
              const existingQ = query(
                collection(db, 'sales'),
                where('accountId', '==', item.salePayload.accountId),
                where('offlineId', '==', item.offlineId),
                limit(1)
              );
              const existingSnap = await withTimeout(
                getDocs(existingQ),
                15_000,
                'Tiempo de espera agotado al verificar duplicado offline.'
              );

              if (!existingSnap.empty) {
                console.log(
                  `[OfflineSync] Venta ${item.offlineId} ya existe en Firestore (id: ${existingSnap.docs[0].id}). Marcada como exitosa.`
                );
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

            let txResult: CreateSaleTransactionResult | null = null;
            if (!alreadySynced) {
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

              const runCreateSale = () =>
                withTimeout(
                  createSaleTransaction(payloadToSync),
                  30_000,
                  'Tiempo de espera agotado al sincronizar venta.'
                );

              try {
                txResult = await runCreateSale();
              } catch (firstErr: any) {
                const lowerMsg = String(firstErr?.message || firstErr?.code || '').toLowerCase();
                if (lowerMsg.includes('unauthenticated') && typeof currentUser.getIdToken === 'function') {
                  try {
                    await currentUser.getIdToken(true);
                    txResult = await runCreateSale();
                  } catch (retryAuthErr) {
                    throw retryAuthErr;
                  }
                } else {
                  throw firstErr;
                }
              }
            }

            // Checkpoint por ítem inmediatamente después del éxito
            latestQueueSnapshot = await this.runWithQueueMutex(async () => {
              const latestQueue = await this.loadQueueLocked();
              const remaining = latestQueue.filter(
                (q) => !(q.offlineId === item.offlineId && q.timestamp <= item.timestamp)
              );
              return await this.writeQueueLocked(remaining);
            });

            const itemStockPatches = Array.isArray(txResult?.updatedProductStocks)
              ? txResult.updatedProductStocks
              : [];
            if (itemStockPatches.length > 0) {
              accumulatedStockPatches.push(...itemStockPatches);
            }
            syncedOfflineIds.push(item.offlineId);
            summary.successful++;

            this.emitItemSynced({
              offlineId: item.offlineId,
              affectedProductIds,
              updatedProductStocks: itemStockPatches,
              items: latestQueueSnapshot,
              queueCount: latestQueueSnapshot.length,
            });
            console.log(`[OfflineSync] Venta sincronizada con éxito: ${item.offlineId}`);
          } catch (itemErr: any) {
            if (auth.currentUser?.uid !== currentUser.uid) {
              console.warn('[OfflineSync] Error causado por cierre de sesión; preservando venta en cola.');
              break;
            }

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

            if (!classified.retriable || currentRetries >= MAX_OFFLINE_RETRIES) {
              console.error(
                `[OfflineSync] Moviendo venta ${item.offlineId} a CUARENTENA (${classified.category}): ${classified.sanitizedReason}`
              );
              const quarantinedEntry: QuarantinedOfflineSale = {
                ...item,
                status: 'quarantined',
                retryCount: currentRetries,
                nextRetryAt: undefined,
                quarantinedAt: Date.now(),
                lastErrorReason: classified.sanitizedReason,
                failureCategory: classified.category,
              };

              // Orden atómico seguro: escribir cuarentena PRIMERO, luego remover de cola activa
              latestQueueSnapshot = await this.runWithQueueMutex(async () => {
                const existingQuarantine = await this.getQuarantinedSales();
                const combined = deduplicateAndCapQuarantine([
                  ...existingQuarantine,
                  quarantinedEntry,
                ]);
                await AsyncStorage.setItem(QUARANTINED_STORAGE_KEY, JSON.stringify(combined));

                const latestQueue = await this.loadQueueLocked();
                const remaining = latestQueue.filter(
                  (q) => !(q.offlineId === item.offlineId && q.timestamp <= item.timestamp)
                );
                return await this.writeQueueLocked(remaining);
              });
              summary.quarantined++;
            } else {
              const backoffMs = Math.min(
                RETRY_BACKOFF_MAX_MS,
                RETRY_BACKOFF_BASE_MS * Math.pow(3, item.retryCount || 0)
              );
              const retriedItem: PendingOfflineSale = {
                ...item,
                retryCount: currentRetries,
                nextRetryAt: Date.now() + backoffMs,
                lastErrorReason: classified.sanitizedReason,
                failureCategory: classified.category,
              };

              latestQueueSnapshot = await this.runWithQueueMutex(async () => {
                const latestQueue = await this.loadQueueLocked();
                const updated = latestQueue.map((q) =>
                  q.offlineId === item.offlineId && q.timestamp <= item.timestamp
                    ? retriedItem
                    : q
                );
                return await this.writeQueueLocked(updated);
              });
              summary.retried++;
            }
          }
        }

        const remainingCount = latestQueueSnapshot.length;
        const nowAfter = Date.now();
        const pendingRetryTimes = latestQueueSnapshot
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
            items: latestQueueSnapshot,
            successful: summary.successful,
            quarantined: summary.quarantined,
            syncedOfflineIds,
            updatedProductStocks: accumulatedStockPatches,
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
    };

    const syncPromise = executeSync().finally(() => {
      if (this.activeSyncPromise === syncPromise) {
        this.activeSyncPromise = null;
      }
      if (this.resyncRequested) {
        this.resyncRequested = false;
        void this.processOfflineQueue({ accountId: accountIdOverride, force: true });
      }
    });

    this.activeSyncPromise = syncPromise;
    return syncPromise;
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
      if (Date.now() - this.lockAcquiredAt <= SYNC_LOCK_TTL_MS) {
        return false;
      }
    }
    this.isProcessingInMemory = true;
    this.lockAcquiredAt = Date.now();
    return true;
  }

  private async releaseLock(): Promise<void> {
    this.isProcessingInMemory = false;
    this.lockAcquiredAt = 0;
  }
}

export const offlineSyncService = new OfflineSyncService();

// Exportaciones directas de funciones para ergonomía de importación
export const enqueueOfflineSale = (payload: CreateSaleTransactionParams) =>
  offlineSyncService.enqueueOfflineSale(payload);

export const processOfflineQueue = (
  accountIdOrOpts?: string | { accountId?: string; force?: boolean }
) => offlineSyncService.processOfflineQueue(accountIdOrOpts);

export const getOfflineQueue = () =>
  offlineSyncService.getOfflineQueue();

export const getOfflineQueueForIdentity = (userId: string, accountId: string) =>
  offlineSyncService.getOfflineQueueForIdentity(userId, accountId);

export const cancelPendingOfflineSale = (offlineId: string) =>
  offlineSyncService.cancelPendingOfflineSale(offlineId);

export const getQuarantinedSales = () =>
  offlineSyncService.getQuarantinedSales();

export const getQuarantinedSalesForIdentity = (userId: string, accountId: string) =>
  offlineSyncService.getQuarantinedSalesForIdentity(userId, accountId);

export const retryQuarantinedSale = (
  offlineId: string,
  options?: { newSessionId?: string; accountId?: string }
) => offlineSyncService.retryQuarantinedSale(offlineId, options);

export const removeQuarantinedSale = (offlineId: string) =>
  offlineSyncService.removeQuarantinedSale(offlineId);

export const initOfflineSyncListener = () =>
  offlineSyncService.initNetworkListener();

export const subscribeOfflineQueueChanges = (
  listener: (event: OfflineQueueChangeEvent) => void
): (() => void) => offlineSyncService.subscribeQueueChanges(listener);

export const subscribeOfflineItemSynced = (
  listener: (event: OfflineItemSyncedEvent) => void
): (() => void) => offlineSyncService.subscribeItemSynced(listener);
