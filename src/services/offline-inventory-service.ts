import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, doc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { checkIsOnlineLive, withTimeout } from '@/lib/online-guard';
import type { Product } from '@/types';
import type {
  AuthoritativeProductStockPatch,
  OfflineInventoryOperation,
  OfflineProductCreateOp,
  OfflineProductUpdateOp,
  OfflineStockAdjustOp,
} from '@/lib/offline-stock-helpers';
import {
  adjustProductStock,
  PRODUCTS_COLLECTION,
  saveProduct,
} from './inventory-kardex-service';

export const OFFLINE_INVENTORY_QUEUE_KEY = 'ventify_offline_inventory_queue_v1';
export const OFFLINE_INVENTORY_QUARANTINE_KEY = 'ventify_offline_inventory_quarantine_v1';
export const MAX_INVENTORY_RETRIES = 5;
export const INVENTORY_SYNC_LOCK_TTL_MS = 45_000;
export const INVENTORY_SYNC_ITEM_TIMEOUT_MS = 30_000;

export type QuarantinedInventoryOp = OfflineInventoryOperation & {
  quarantinedAt: number;
  lastErrorReason: string;
};

export interface InventorySyncResult {
  total: number;
  processed: number;
  successful: number;
  quarantined: number;
  retried: number;
  errors: Array<{ offlineOpId: string; reason: string }>;
}

export interface OfflineInventoryChangeEvent {
  type: 'enqueued' | 'item_synced' | 'synced' | 'updated' | 'quarantined_changed';
  queueCount: number;
  items?: OfflineInventoryOperation[];
  offlineOpId?: string;
  opType?: OfflineInventoryOperation['type'];
  updatedProductStock?: AuthoritativeProductStockPatch;
  createdProduct?: Product;
  successful?: number;
  quarantined?: number;
}

type InventoryQueueListener = (event: OfflineInventoryChangeEvent) => void;

const generateOpId = (prefix: string): string => {
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
};

export function generateOfflineProductId(): string {
  try {
    return doc(collection(db, PRODUCTS_COLLECTION)).id;
  } catch {
    return generateOpId('offprod');
  }
}

const isRetriableInventoryError = (err: any): boolean => {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  if (code === 'permission-denied' || msg.includes('permission-denied')) return false;
  if (msg.includes('obligatorio') || msg.includes('no existe') || msg.includes('inválid')) {
    return false;
  }
  return true;
};

class OfflineInventoryService {
  private queueMutex: Promise<unknown> = Promise.resolve();
  private queueCache: OfflineInventoryOperation[] | null = null;
  private listeners = new Set<InventoryQueueListener>();
  private activeSyncPromise: Promise<InventorySyncResult> | null = null;
  private resyncRequested = false;
  private lockAcquiredAt = 0;

  private runWithMutex<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queueMutex.then(fn, fn);
    this.queueMutex = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private emit(event: OfflineInventoryChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[OfflineInventory] Error in listener:', err);
      }
    }
  }

  subscribe(listener: InventoryQueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancelPendingWork(): void {
    this.resyncRequested = false;
  }

  resetQueueCache(): void {
    this.queueCache = null;
    this.resyncRequested = false;
    this.lockAcquiredAt = 0;
  }

  private async loadQueueLocked(): Promise<OfflineInventoryOperation[]> {
    if (this.queueCache !== null) {
      return [...this.queueCache];
    }
    const raw = await AsyncStorage.getItem(OFFLINE_INVENTORY_QUEUE_KEY);
    if (!raw) {
      this.queueCache = [];
      return [];
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? (parsed as OfflineInventoryOperation[]) : [];
    this.queueCache = list;
    return [...list];
  }

  private async writeQueueLocked(items: OfflineInventoryOperation[]): Promise<void> {
    const seen = new Set<string>();
    const deduped = items.filter((it) => {
      if (!it?.offlineOpId || seen.has(it.offlineOpId)) return false;
      seen.add(it.offlineOpId);
      return true;
    });
    await AsyncStorage.setItem(OFFLINE_INVENTORY_QUEUE_KEY, JSON.stringify(deduped));
    this.queueCache = [...deduped];
  }

  private async loadQuarantineLocked(): Promise<QuarantinedInventoryOp[]> {
    const raw = await AsyncStorage.getItem(OFFLINE_INVENTORY_QUARANTINE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QuarantinedInventoryOp[]) : [];
  }

  private async writeQuarantineLocked(items: QuarantinedInventoryOp[]): Promise<void> {
    const seen = new Set<string>();
    const deduped: QuarantinedInventoryOp[] = [];
    for (const it of items) {
      if (!it?.offlineOpId || seen.has(it.offlineOpId)) continue;
      seen.add(it.offlineOpId);
      deduped.push(it);
      if (deduped.length >= 100) break;
    }
    await AsyncStorage.setItem(OFFLINE_INVENTORY_QUARANTINE_KEY, JSON.stringify(deduped));
  }

  async getQueue(): Promise<OfflineInventoryOperation[]> {
    try {
      return await this.runWithMutex(() => this.loadQueueLocked());
    } catch {
      return this.queueCache ? [...this.queueCache] : [];
    }
  }

  async getQueueForIdentity(userId: string, accountId: string): Promise<OfflineInventoryOperation[]> {
    const all = await this.getQueue();
    return all.filter((op) => op.accountId === accountId && (!userId || op.userId === userId));
  }

  async getQuarantinedForIdentity(
    userId: string,
    accountId: string
  ): Promise<QuarantinedInventoryOp[]> {
    try {
      const all = await this.runWithMutex(() => this.loadQuarantineLocked());
      return all.filter((op) => op.accountId === accountId && (!userId || op.userId === userId));
    } catch {
      return [];
    }
  }

  async enqueueStockAdjust(
    params: Omit<OfflineStockAdjustOp, 'id' | 'offlineOpId' | 'type' | 'timestamp' | 'retryCount'>
  ): Promise<OfflineStockAdjustOp> {
    const opId = generateOpId('offinv_adj');
    const op: OfflineStockAdjustOp = {
      ...params,
      id: opId,
      offlineOpId: opId,
      type: 'stock_adjust',
      timestamp: Date.now(),
      retryCount: 0,
    };
    const next = await this.runWithMutex(async () => {
      const current = await this.loadQueueLocked();
      const updated = [...current, op];
      await this.writeQueueLocked(updated);
      return updated;
    });
    if (this.activeSyncPromise) {
      this.resyncRequested = true;
    }
    this.emit({ type: 'enqueued', queueCount: next.length, items: next });
    return op;
  }

  async enqueueProductCreate(
    params: Omit<OfflineProductCreateOp, 'id' | 'offlineOpId' | 'type' | 'timestamp' | 'retryCount'>
  ): Promise<OfflineProductCreateOp> {
    const opId = generateOpId('offinv_new');
    const op: OfflineProductCreateOp = {
      ...params,
      id: opId,
      offlineOpId: opId,
      type: 'product_create',
      timestamp: Date.now(),
      retryCount: 0,
    };
    const next = await this.runWithMutex(async () => {
      const current = await this.loadQueueLocked();
      const updated = [...current, op];
      await this.writeQueueLocked(updated);
      return updated;
    });
    if (this.activeSyncPromise) {
      this.resyncRequested = true;
    }
    this.emit({ type: 'enqueued', queueCount: next.length, items: next });
    return op;
  }

  async enqueueProductUpdate(
    params: Omit<OfflineProductUpdateOp, 'id' | 'offlineOpId' | 'type' | 'timestamp' | 'retryCount'>
  ): Promise<OfflineProductUpdateOp> {
    const opId = generateOpId('offinv_upd');
    const op: OfflineProductUpdateOp = {
      ...params,
      id: opId,
      offlineOpId: opId,
      type: 'product_update',
      timestamp: Date.now(),
      retryCount: 0,
    };
    const next = await this.runWithMutex(async () => {
      const current = await this.loadQueueLocked();
      const updated = [...current, op];
      await this.writeQueueLocked(updated);
      return updated;
    });
    if (this.activeSyncPromise) {
      this.resyncRequested = true;
    }
    this.emit({ type: 'enqueued', queueCount: next.length, items: next });
    return op;
  }

  async cancelPendingOp(offlineOpId: string): Promise<boolean> {
    if (!offlineOpId) return false;
    const result = await this.runWithMutex(async () => {
      const current = await this.loadQueueLocked();
      const filtered = current.filter((it) => it.offlineOpId !== offlineOpId);
      if (filtered.length === current.length) return { removed: false, items: current };
      await this.writeQueueLocked(filtered);
      return { removed: true, items: filtered };
    });
    if (result.removed) {
      this.emit({ type: 'updated', queueCount: result.items.length, items: result.items });
    }
    return result.removed;
  }

  async retryQuarantinedOp(offlineOpId: string): Promise<boolean> {
    const res = await this.runWithMutex(async () => {
      const qList = await this.loadQuarantineLocked();
      const target = qList.find((it) => it.offlineOpId === offlineOpId);
      if (!target) return null;
      const { quarantinedAt: _q, ...baseOp } = target;
      const resetOp: OfflineInventoryOperation = {
        ...baseOp,
        retryCount: 0,
        nextRetryAt: undefined,
        lastErrorReason: undefined,
      };
      // Atomic order: write active queue FIRST, then remove from quarantine
      const active = await this.loadQueueLocked();
      const nextActive = [...active.filter((it) => it.offlineOpId !== offlineOpId), resetOp];
      await this.writeQueueLocked(nextActive);
      const nextQ = qList.filter((it) => it.offlineOpId !== offlineOpId);
      await this.writeQuarantineLocked(nextQ);
      return nextActive;
    });
    if (!res) return false;
    this.emit({ type: 'updated', queueCount: res.length, items: res });
    this.emit({ type: 'quarantined_changed', queueCount: res.length, items: res });
    return true;
  }

  async removeQuarantinedOp(offlineOpId: string): Promise<void> {
    await this.runWithMutex(async () => {
      const qList = await this.loadQuarantineLocked();
      await this.writeQuarantineLocked(qList.filter((it) => it.offlineOpId !== offlineOpId));
    });
    const active = await this.getQueue();
    this.emit({ type: 'quarantined_changed', queueCount: active.length, items: active });
  }

  async processQueue(options?: { accountId?: string; force?: boolean }): Promise<InventorySyncResult> {
    const force = options?.force === true;
    if (this.activeSyncPromise) {
      if (Date.now() - this.lockAcquiredAt > INVENTORY_SYNC_LOCK_TTL_MS) {
        this.activeSyncPromise = null;
      } else {
        if (force) {
          this.resyncRequested = true;
        }
        return this.activeSyncPromise;
      }
    }

    const run = (async (): Promise<InventorySyncResult> => {
      this.lockAcquiredAt = Date.now();
      const summary: InventorySyncResult = {
        total: 0,
        processed: 0,
        successful: 0,
        quarantined: 0,
        retried: 0,
        errors: [],
      };

      const initialQueue = await this.getQueue();
      if (initialQueue.length === 0) {
        return summary;
      }

      if (!(await checkIsOnlineLive(false))) {
        return summary;
      }

      const currentUser = auth.currentUser;
      if (!currentUser) return summary;

      let queue: OfflineInventoryOperation[];
      try {
        queue = await this.runWithMutex(() => this.loadQueueLocked());
      } catch {
        return summary;
      }

      // Execute product_create -> product_update -> stock_adjust chronologically
      const priority = (t: OfflineInventoryOperation['type']) =>
        t === 'product_create' ? 0 : t === 'product_update' ? 1 : 2;
      const orderedQueue = [...queue].sort((a, b) => {
        const pDiff = priority(a.type) - priority(b.type);
        return pDiff !== 0 ? pDiff : (a.timestamp || 0) - (b.timestamp || 0);
      });
      summary.total = orderedQueue.length;

      for (const op of orderedQueue) {
        if (auth.currentUser?.uid !== currentUser.uid) {
          break;
        }
        if (options?.accountId && op.accountId && op.accountId !== options.accountId) {
          continue;
        }

        const now = Date.now();
        if (!force && typeof op.nextRetryAt === 'number' && now < op.nextRetryAt) {
          continue;
        }

        summary.processed += 1;

        try {
          if (op.type === 'product_create') {
            await withTimeout(
              saveProduct(
                op.productData as any,
                true,
                op.userProfile || { uid: currentUser.uid, displayName: 'Usuario' },
                { preallocatedId: op.productId, offlineId: op.offlineOpId }
              ),
              INVENTORY_SYNC_ITEM_TIMEOUT_MS,
              'Tiempo de espera agotado al crear producto offline.'
            );

            const remaining = await this.runWithMutex(async () => {
              const cur = await this.loadQueueLocked();
              const next = cur.filter((it) => it.offlineOpId !== op.offlineOpId);
              await this.writeQueueLocked(next);
              return next;
            });
            summary.successful += 1;
            this.emit({
              type: 'item_synced',
              queueCount: remaining.length,
              items: remaining,
              offlineOpId: op.offlineOpId,
              opType: op.type,
              createdProduct: op.previewProduct,
            });
          } else if (op.type === 'product_update') {
            await withTimeout(
              saveProduct(
                op.productData as any,
                false,
                op.userProfile || { uid: currentUser.uid, displayName: 'Usuario' },
                { skipStockField: true }
              ),
              INVENTORY_SYNC_ITEM_TIMEOUT_MS,
              'Tiempo de espera agotado al actualizar producto offline.'
            );

            const remaining = await this.runWithMutex(async () => {
              const cur = await this.loadQueueLocked();
              const next = cur.filter((it) => it.offlineOpId !== op.offlineOpId);
              await this.writeQueueLocked(next);
              return next;
            });
            summary.successful += 1;
            this.emit({
              type: 'item_synced',
              queueCount: remaining.length,
              items: remaining,
              offlineOpId: op.offlineOpId,
              opType: op.type,
            });
          } else if (op.type === 'stock_adjust') {
            const adjResult = await withTimeout(
              adjustProductStock({
                product: {
                  id: op.productId,
                  name: op.productName,
                  sku: op.productSku,
                  accountId: op.accountId,
                },
                branchId: op.branchId,
                branchName: op.branchName,
                newStock: op.amount,
                mode: op.mode,
                deltaAmount: op.mode === 'set' ? undefined : op.amount,
                variantId: op.variantId,
                variantName: op.variantName,
                reason: op.reason,
                notes: op.notes,
                userProfile: op.userProfile || { uid: currentUser.uid, displayName: 'Usuario' },
                offlineId: op.offlineOpId,
              }),
              INVENTORY_SYNC_ITEM_TIMEOUT_MS,
              'Tiempo de espera agotado al sincronizar ajuste de stock.'
            );

            const remaining = await this.runWithMutex(async () => {
              const cur = await this.loadQueueLocked();
              const next = cur.filter((it) => it.offlineOpId !== op.offlineOpId);
              await this.writeQueueLocked(next);
              return next;
            });
            summary.successful += 1;
            this.emit({
              type: 'item_synced',
              queueCount: remaining.length,
              items: remaining,
              offlineOpId: op.offlineOpId,
              opType: op.type,
              updatedProductStock: adjResult.updatedProductStock,
            });
          }
        } catch (err: any) {
          const reason = err?.message || 'Error desconocido al sincronizar inventario offline.';
          summary.errors.push({ offlineOpId: op.offlineOpId, reason });
          const nextRetries = (op.retryCount || 0) + 1;

          if (isRetriableInventoryError(err) && nextRetries < MAX_INVENTORY_RETRIES) {
            summary.retried += 1;
            const delay = Math.min(300_000, 5_000 * Math.pow(3, Math.max(0, nextRetries - 1)));
            const remaining = await this.runWithMutex(async () => {
              const cur = await this.loadQueueLocked();
              const next = cur.map((it) =>
                it.offlineOpId === op.offlineOpId
                  ? { ...it, retryCount: nextRetries, nextRetryAt: Date.now() + delay, lastErrorReason: reason }
                  : it
              );
              await this.writeQueueLocked(next);
              return next;
            });
            this.emit({ type: 'updated', queueCount: remaining.length, items: remaining });
          } else {
            summary.quarantined += 1;
            const remaining = await this.runWithMutex(async () => {
              // Write quarantine FIRST, then remove from active queue
              const qList = await this.loadQuarantineLocked();
              const entry: QuarantinedInventoryOp = {
                ...op,
                retryCount: nextRetries,
                lastErrorReason: reason,
                quarantinedAt: Date.now(),
              };
              await this.writeQuarantineLocked([entry, ...qList]);
              const cur = await this.loadQueueLocked();
              const next = cur.filter((it) => it.offlineOpId !== op.offlineOpId);
              await this.writeQueueLocked(next);
              return next;
            });
            this.emit({
              type: 'quarantined_changed',
              queueCount: remaining.length,
              items: remaining,
              quarantined: 1,
            });
          }
        }
      }

      if (summary.successful > 0) {
        const finalQueue = await this.getQueue();
        this.emit({
          type: 'synced',
          queueCount: finalQueue.length,
          items: finalQueue,
          successful: summary.successful,
          quarantined: summary.quarantined,
        });
      }

      return summary;
    })().finally(() => {
      this.activeSyncPromise = null;
      if (this.resyncRequested) {
        this.resyncRequested = false;
        void this.processQueue(options);
      }
    });

    this.activeSyncPromise = run;
    return run;
  }
}

export const offlineInventoryService = new OfflineInventoryService();

export const enqueueOfflineStockAdjust = (
  params: Omit<OfflineStockAdjustOp, 'id' | 'offlineOpId' | 'type' | 'timestamp' | 'retryCount'>
) => offlineInventoryService.enqueueStockAdjust(params);

export const enqueueOfflineProductCreate = (
  params: Omit<OfflineProductCreateOp, 'id' | 'offlineOpId' | 'type' | 'timestamp' | 'retryCount'>
) => offlineInventoryService.enqueueProductCreate(params);

export const enqueueOfflineProductUpdate = (
  params: Omit<OfflineProductUpdateOp, 'id' | 'offlineOpId' | 'type' | 'timestamp' | 'retryCount'>
) => offlineInventoryService.enqueueProductUpdate(params);

export const getOfflineInventoryQueue = () => offlineInventoryService.getQueue();

export const getOfflineInventoryQueueForIdentity = (userId: string, accountId: string) =>
  offlineInventoryService.getQueueForIdentity(userId, accountId);

export const getQuarantinedInventoryOpsForIdentity = (userId: string, accountId: string) =>
  offlineInventoryService.getQuarantinedForIdentity(userId, accountId);

export const cancelPendingInventoryOp = (offlineOpId: string) =>
  offlineInventoryService.cancelPendingOp(offlineOpId);

export const retryQuarantinedInventoryOp = (offlineOpId: string) =>
  offlineInventoryService.retryQuarantinedOp(offlineOpId);

export const removeQuarantinedInventoryOp = (offlineOpId: string) =>
  offlineInventoryService.removeQuarantinedOp(offlineOpId);

export const processOfflineInventoryQueue = (options?: { accountId?: string; force?: boolean }) =>
  offlineInventoryService.processQueue(options);

export const subscribeOfflineInventoryChanges = (listener: InventoryQueueListener) =>
  offlineInventoryService.subscribe(listener);
