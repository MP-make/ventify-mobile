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
import { db } from '@/lib/firebase';
import { collection, query, where, limit, getDocs } from 'firebase/firestore';
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

export const MAX_OFFLINE_RETRIES = 3;
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

  // Precios mínimos o reglas de margen
  if (
    lower.includes('precio mínimo') ||
    lower.includes('precio no permitido') ||
    lower.includes('min price')
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
    lower.includes('no autorizado')
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
    lower.includes('unavailable') ||
    lower.includes('failed-precondition') ||
    lower.includes('deadline-exceeded') ||
    lower.includes('offline')
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

class OfflineSyncService {
  private isProcessingInMemory = false;
  private netInfoUnsubscribe: (() => void) | null = null;

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
    const enrichedPayload: CreateSaleTransactionParams = {
      ...salePayload,
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
      const currentQueue = await this.getOfflineQueue();
      // Evitar duplicados por offlineId
      const filtered = currentQueue.filter((q) => q.offlineId !== offlineId);
      filtered.push(pendingItem);

      await AsyncStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(filtered));
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
    try {
      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[OfflineSync] Error al leer cola offline:', err);
      return [];
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

  /**
   * Mueve una venta de cuarentena de regreso a la cola activa para reintento manual
   */
  public async retryQuarantinedSale(offlineId: string): Promise<boolean> {
    try {
      const quarantined = await this.getQuarantinedSales();
      const target = quarantined.find((q) => q.offlineId === offlineId);

      if (!target) {
        console.warn(`[OfflineSync] No se encontró la venta ${offlineId} en cuarentena.`);
        return false;
      }

      // Remover de cuarentena
      const remainingQuarantine = quarantined.filter((q) => q.offlineId !== offlineId);
      await AsyncStorage.setItem(
        QUARANTINED_STORAGE_KEY,
        JSON.stringify(remainingQuarantine)
      );

      // Re-encolar con retryCount reseteado
      const resetItem: PendingOfflineSale = {
        ...target,
        retryCount: 0,
        status: 'pending_offline',
        lastErrorReason: undefined,
        failureCategory: undefined,
      };

      const queue = await this.getOfflineQueue();
      queue.push(resetItem);
      await AsyncStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(queue));

      // Disparar procesamiento si hay internet
      const net = await NetInfo.fetch();
      if (net.isConnected) {
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
      const quarantined = await this.getQuarantinedSales();
      const filtered = quarantined.filter((q) => q.offlineId !== offlineId);
      await AsyncStorage.setItem(QUARANTINED_STORAGE_KEY, JSON.stringify(filtered));
      return true;
    } catch (err) {
      console.error('[OfflineSync] Error eliminando venta en cuarentena:', err);
      return false;
    }
  }

  /**
   * Procesa la cola de ventas offline pendientes con candado de sincronización y deduplicación
   */
  public async processOfflineQueue(): Promise<SyncProcessResult> {
    const summary: SyncProcessResult = {
      total: 0,
      processed: 0,
      successful: 0,
      quarantined: 0,
      retried: 0,
      errors: [],
    };

    // 1. Verificar estado de red
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) {
      console.log('[OfflineSync] Sin conexión a internet. Omitiendo sincronización.');
      return summary;
    }

    // 2. Control de concurrencia con Mutex Lock
    if (this.isProcessingInMemory) {
      console.log('[OfflineSync] Proceso de sincronización ya en curso en memoria.');
      return summary;
    }

    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      console.log('[OfflineSync] Candado de sincronización ocupado por otro hilo.');
      return summary;
    }

    this.isProcessingInMemory = true;

    try {
      const queue = await this.getOfflineQueue();
      summary.total = queue.length;

      if (queue.length === 0) {
        return summary;
      }

      console.log(`[OfflineSync] Procesando ${queue.length} ventas offline pendientes...`);

      const nextQueue: PendingOfflineSale[] = [];
      const quarantinedToAdd: QuarantinedOfflineSale[] = [];

      for (const item of queue) {
        summary.processed++;

        try {
          // A. DEDUPLICACIÓN EN FIRESTORE
          // Verifica si la venta ya fue registrada previamente en el servidor
          const existingQ = query(
            collection(db, 'sales'),
            where('offlineId', '==', item.offlineId),
            limit(1)
          );
          const existingSnap = await getDocs(existingQ);

          if (!existingSnap.empty) {
            console.log(
              `[OfflineSync] Venta ${item.offlineId} ya existe en Firestore (id: ${existingSnap.docs[0].id}). Marcada como exitosa.`
            );
            summary.successful++;
            continue; // Se descarta de la cola activa
          }

          // B. EJECUTAR TRANSACCIÓN ATÓMICA DE VENTA
          await createSaleTransaction(item.salePayload);

          console.log(`[OfflineSync] Venta sincronizada con éxito: ${item.offlineId}`);
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
              quarantinedAt: Date.now(),
              lastErrorReason: classified.sanitizedReason,
              failureCategory: classified.category,
            });

            summary.quarantined++;
          } else {
            // Reintento permitido en la próxima pasada
            nextQueue.push({
              ...item,
              retryCount: currentRetries,
              lastErrorReason: classified.sanitizedReason,
              failureCategory: classified.category,
            });
            summary.retried++;
          }
        }
      }

      // Guardar cola activa actualizada
      await AsyncStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(nextQueue));

      // Guardar cuarentena acumulada
      if (quarantinedToAdd.length > 0) {
        const existingQuarantine = await this.getQuarantinedSales();
        const combined = [...existingQuarantine, ...quarantinedToAdd];
        await AsyncStorage.setItem(QUARANTINED_STORAGE_KEY, JSON.stringify(combined));
      }

      console.log(
        `[OfflineSync] Sincronización completada. Éxitos: ${summary.successful}, Cuarentena: ${summary.quarantined}, Pendientes: ${nextQueue.length}`
      );
      return summary;
    } finally {
      this.isProcessingInMemory = false;
      await this.releaseLock();
    }
  }

  /**
   * Inicia el listener automático de NetInfo para sincronizar cuando regresa la conexión
   */
  public initNetworkListener(): () => void {
    if (this.netInfoUnsubscribe) {
      this.netInfoUnsubscribe();
    }

    this.netInfoUnsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        console.log('[OfflineSync] Red restaurada. Disparando sincronización automática...');
        this.processOfflineQueue().catch((err) =>
          console.warn('[OfflineSync] Error en sincronización por evento de red:', err)
        );
      }
    });

    return () => {
      if (this.netInfoUnsubscribe) {
        this.netInfoUnsubscribe();
        this.netInfoUnsubscribe = null;
      }
    };
  }

  // ============================================================================
  // MUTEX LOCK HELPERS
  // ============================================================================

  private async acquireLock(): Promise<boolean> {
    try {
      const now = Date.now();
      const rawLock = await AsyncStorage.getItem(OFFLINE_SYNC_LOCK_KEY);
      if (rawLock) {
        const lockTime = parseInt(rawLock, 10);
        if (now - lockTime < SYNC_LOCK_TTL_MS) {
          return false;
        }
      }
      await AsyncStorage.setItem(OFFLINE_SYNC_LOCK_KEY, now.toString());
      return true;
    } catch (_) {
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await AsyncStorage.removeItem(OFFLINE_SYNC_LOCK_KEY);
    } catch (_) {}
  }
}

export const offlineSyncService = new OfflineSyncService();

// Exportaciones directas de funciones para ergonomía de importación
export const enqueueOfflineSale = (payload: CreateSaleTransactionParams) =>
  offlineSyncService.enqueueOfflineSale(payload);

export const processOfflineQueue = () =>
  offlineSyncService.processOfflineQueue();

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
