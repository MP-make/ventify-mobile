import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { auth } from '@/lib/firebase';
import { withTimeout } from '@/lib/online-guard';
import {
  registerCashMovement,
  type CashMovementCategory,
  type CashMovementType,
  type ExpenseCategoryId,
  type ExpenseReceiptType,
} from './cash-register-service';

export const OFFLINE_CASH_MOVEMENTS_KEY = 'ventify_offline_cash_movements_v1';
export const MAX_CASH_RETRIES = 5;
export const CASH_SYNC_ITEM_TIMEOUT_MS = 25_000;

export interface PendingOfflineCashMovement {
  id: string;
  offlineId: string;
  accountId: string;
  userId: string;
  userName: string;
  userRole?: string;
  branchId: string;
  sessionId: string;
  type: CashMovementType;
  amount: number;
  category?: CashMovementCategory;
  description: string;
  reason?: string;
  expenseCategoryId?: ExpenseCategoryId;
  receiptType?: ExpenseReceiptType;
  receiptNumber?: string;
  timestamp: number;
  retryCount: number;
  nextRetryAt?: number;
  lastErrorReason?: string;
}

export interface CashSyncResult {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  errors: Array<{ offlineId: string; reason: string }>;
}

export interface OfflineCashChangeEvent {
  type: 'enqueued' | 'item_synced' | 'synced' | 'updated';
  queueCount: number;
  items: PendingOfflineCashMovement[];
  successful?: number;
}

type CashQueueListener = (event: OfflineCashChangeEvent) => void;

class OfflineCashService {
  private queueMutex: Promise<unknown> = Promise.resolve();
  private queueCache: PendingOfflineCashMovement[] | null = null;
  private listeners = new Set<CashQueueListener>();
  private activeSyncPromise: Promise<CashSyncResult> | null = null;
  private resyncRequested = false;

  private runWithMutex<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queueMutex.then(fn, fn);
    this.queueMutex = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private emit(event: OfflineCashChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[OfflineCash] Listener error:', err);
      }
    }
  }

  subscribe(listener: CashQueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancelPendingWork(): void {
    this.resyncRequested = false;
  }

  private async loadQueueLocked(): Promise<PendingOfflineCashMovement[]> {
    if (this.queueCache !== null) {
      return [...this.queueCache];
    }
    const raw = await AsyncStorage.getItem(OFFLINE_CASH_MOVEMENTS_KEY);
    if (!raw) {
      this.queueCache = [];
      return [];
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? (parsed as PendingOfflineCashMovement[]) : [];
    this.queueCache = list;
    return [...list];
  }

  private async writeQueueLocked(items: PendingOfflineCashMovement[]): Promise<void> {
    const seen = new Set<string>();
    const deduped = items.filter((it) => {
      if (!it?.offlineId || seen.has(it.offlineId)) return false;
      seen.add(it.offlineId);
      return true;
    });
    await AsyncStorage.setItem(OFFLINE_CASH_MOVEMENTS_KEY, JSON.stringify(deduped));
    this.queueCache = [...deduped];
  }

  async getQueue(): Promise<PendingOfflineCashMovement[]> {
    try {
      return await this.runWithMutex(() => this.loadQueueLocked());
    } catch {
      return this.queueCache ? [...this.queueCache] : [];
    }
  }

  async getQueueForIdentity(
    userId: string,
    accountId: string
  ): Promise<PendingOfflineCashMovement[]> {
    const all = await this.getQueue();
    return all.filter((m) => m.accountId === accountId && (!userId || m.userId === userId));
  }

  async enqueueMovement(
    params: Omit<PendingOfflineCashMovement, 'id' | 'offlineId' | 'timestamp' | 'retryCount'>
  ): Promise<PendingOfflineCashMovement> {
    const offlineId = `offcash_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const entry: PendingOfflineCashMovement = {
      ...params,
      id: offlineId,
      offlineId,
      timestamp: Date.now(),
      retryCount: 0,
    };

    const next = await this.runWithMutex(async () => {
      const current = await this.loadQueueLocked();
      const updated = [...current, entry];
      await this.writeQueueLocked(updated);
      return updated;
    });

    if (this.activeSyncPromise) {
      this.resyncRequested = true;
    }

    this.emit({ type: 'enqueued', queueCount: next.length, items: next });
    return entry;
  }

  async cancelPendingMovement(offlineId: string): Promise<boolean> {
    if (!offlineId) return false;
    const res = await this.runWithMutex(async () => {
      const current = await this.loadQueueLocked();
      const filtered = current.filter((m) => m.offlineId !== offlineId);
      if (filtered.length === current.length) return { removed: false, items: current };
      await this.writeQueueLocked(filtered);
      return { removed: true, items: filtered };
    });
    if (res.removed) {
      this.emit({ type: 'updated', queueCount: res.items.length, items: res.items });
    }
    return res.removed;
  }

  async processQueue(options?: { accountId?: string; force?: boolean }): Promise<CashSyncResult> {
    const force = options?.force === true;
    if (this.activeSyncPromise) {
      if (force) {
        this.resyncRequested = true;
      }
      return this.activeSyncPromise;
    }

    const run = (async (): Promise<CashSyncResult> => {
      const summary: CashSyncResult = {
        total: 0,
        processed: 0,
        successful: 0,
        failed: 0,
        errors: [],
      };

      const initial = await this.getQueue();
      if (initial.length === 0) return summary;

      try {
        const netState = await NetInfo.fetch();
        if (!netState.isConnected || netState.isInternetReachable === false) {
          return summary;
        }
      } catch {
        return summary;
      }

      const currentUser = auth.currentUser;
      if (!currentUser) return summary;

      let queue: PendingOfflineCashMovement[];
      try {
        queue = await this.runWithMutex(() => this.loadQueueLocked());
      } catch {
        return summary;
      }
      summary.total = queue.length;

      for (const item of queue) {
        if (auth.currentUser?.uid !== currentUser.uid) break;
        if (options?.accountId && item.accountId !== options.accountId) continue;
        if (!force && typeof item.nextRetryAt === 'number' && Date.now() < item.nextRetryAt) {
          continue;
        }

        summary.processed += 1;

        try {
          await withTimeout(
            registerCashMovement({
              accountId: item.accountId,
              branchId: item.branchId,
              sessionId: item.sessionId,
              type: item.type,
              amount: item.amount,
              category: item.category,
              description: item.description,
              reason: item.reason,
              expenseCategoryId: item.expenseCategoryId,
              receiptType: item.receiptType,
              receiptNumber: item.receiptNumber,
              userId: item.userId,
              userName: item.userName,
              userRole: item.userRole,
              offlineId: item.offlineId,
            }),
            CASH_SYNC_ITEM_TIMEOUT_MS,
            'Tiempo de espera agotado al sincronizar movimiento de caja.'
          );

          const remaining = await this.runWithMutex(async () => {
            const cur = await this.loadQueueLocked();
            const next = cur.filter((m) => m.offlineId !== item.offlineId);
            await this.writeQueueLocked(next);
            return next;
          });
          summary.successful += 1;
          this.emit({ type: 'item_synced', queueCount: remaining.length, items: remaining });
        } catch (err: any) {
          const reason = err?.message || 'Error al sincronizar movimiento de caja.';
          summary.errors.push({ offlineId: item.offlineId, reason });
          summary.failed += 1;
          const nextRetries = (item.retryCount || 0) + 1;
          const delay = Math.min(300_000, 5_000 * Math.pow(3, Math.max(0, nextRetries - 1)));
          const remaining = await this.runWithMutex(async () => {
            const cur = await this.loadQueueLocked();
            const next = cur.map((m) =>
              m.offlineId === item.offlineId
                ? {
                    ...m,
                    retryCount: nextRetries,
                    nextRetryAt:
                      nextRetries < MAX_CASH_RETRIES ? Date.now() + delay : Date.now() + 300_000,
                    lastErrorReason: reason,
                  }
                : m
            );
            await this.writeQueueLocked(next);
            return next;
          });
          this.emit({ type: 'updated', queueCount: remaining.length, items: remaining });
        }
      }

      if (summary.successful > 0) {
        const finalQueue = await this.getQueue();
        this.emit({
          type: 'synced',
          queueCount: finalQueue.length,
          items: finalQueue,
          successful: summary.successful,
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

export const offlineCashService = new OfflineCashService();

export const enqueueOfflineCashMovement = (
  params: Omit<PendingOfflineCashMovement, 'id' | 'offlineId' | 'timestamp' | 'retryCount'>
) => offlineCashService.enqueueMovement(params);

export const getOfflineCashQueue = () => offlineCashService.getQueue();

export const getOfflineCashQueueForIdentity = (userId: string, accountId: string) =>
  offlineCashService.getQueueForIdentity(userId, accountId);

export const cancelPendingCashMovement = (offlineId: string) =>
  offlineCashService.cancelPendingMovement(offlineId);

export const processOfflineCashQueue = (options?: { accountId?: string; force?: boolean }) =>
  offlineCashService.processQueue(options);

export const subscribeOfflineCashChanges = (listener: CashQueueListener) =>
  offlineCashService.subscribe(listener);
