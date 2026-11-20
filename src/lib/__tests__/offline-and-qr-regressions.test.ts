import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncMocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  netState: { isConnected: true, isInternetReachable: true },
  user: {
    uid: 'user-1',
    getIdTokenResult: vi.fn(async () => ({ claims: { accountId: 'acc-1' } })),
  } as any,
  getDocsImpl: vi.fn(),
  getDocImpl: vi.fn(),
  createSaleTransactionImpl: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => syncMocks.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      syncMocks.storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      syncMocks.storage.delete(key);
    }),
  },
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    fetch: vi.fn(async () => syncMocks.netState),
    addEventListener: vi.fn(() => () => {}),
  },
}));

vi.mock('@/lib/firebase', () => ({
  db: {},
  auth: {
    get currentUser() {
      return syncMocks.user;
    },
  },
}));

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ path: name }),
  doc: (_db: unknown, coll: string, id: string) => ({ path: `${coll}/${id}`, id }),
  query: (...args: unknown[]) => ({ args }),
  where: (...args: unknown[]) => ({ args }),
  limit: (n: number) => ({ n }),
  getDocs: (...args: unknown[]) => syncMocks.getDocsImpl(...args),
  getDoc: (...args: unknown[]) => syncMocks.getDocImpl(...args),
}));

vi.mock('@/services/sale-service', () => ({
  createSaleTransaction: (...args: unknown[]) => syncMocks.createSaleTransactionImpl(...args),
}));

import { shouldDeactivateUserOnMissingDoc } from '../access-policy';
import {
  computeOfflineCashDelta,
  mergeSalesWithOfflinePending,
  pendingOfflineSaleToSaleRecord,
} from '../offline-sales-helpers';
import {
  enqueueOfflineSale,
  getOfflineQueue,
  processOfflineQueue,
  subscribeOfflineQueueChanges,
  type OfflineQueueChangeEvent,
  type PendingOfflineSale,
} from '@/services/offline-sync-service';

describe('offline auth policy, offline Caja/Ventas helpers, and offline sync regressions', () => {
  beforeEach(() => {
    syncMocks.storage.clear();
    syncMocks.netState = { isConnected: true, isInternetReachable: true };
    syncMocks.user = {
      uid: 'user-1',
      getIdTokenResult: vi.fn(async () => ({ claims: { accountId: 'acc-1' } })),
    };
    vi.clearAllMocks();

    syncMocks.getDocImpl.mockResolvedValue({
      exists: () => true,
      data: () => ({ accountId: 'acc-1' }),
    });
    syncMocks.getDocsImpl.mockResolvedValue({ empty: true, docs: [] });
    syncMocks.createSaleTransactionImpl.mockResolvedValue({
      saleId: 'sale-srv-1',
      saleNumber: 120,
      correlative: 'NV01-000120',
      documentType: 'nota_venta',
      total: 63,
      status: 'completed',
      sunatStatus: 'not_applicable',
      sessionId: 'sess-1',
      offlineId: 'off_yape_63',
    });
  });

  describe('shouldDeactivateUserOnMissingDoc', () => {
    it('returns false when doc exists, snapshot is from cache, or device is offline', () => {
      expect(shouldDeactivateUserOnMissingDoc({ exists: true, fromCache: false, isOnline: true })).toBe(false);
      expect(shouldDeactivateUserOnMissingDoc({ exists: false, fromCache: true, isOnline: true })).toBe(false);
      expect(shouldDeactivateUserOnMissingDoc({ exists: false, fromCache: false, isOnline: false })).toBe(false);
      expect(shouldDeactivateUserOnMissingDoc({ exists: false, fromCache: true, isOnline: false })).toBe(false);
    });

    it('returns true only when missing doc is confirmed online from server', () => {
      expect(shouldDeactivateUserOnMissingDoc({ exists: false, fromCache: false, isOnline: true })).toBe(true);
      expect(shouldDeactivateUserOnMissingDoc({ exists: false, isOnline: true })).toBe(true);
    });
  });

  describe('offline-sales-helpers', () => {
    const scope = {
      accountId: 'acc-1',
      branchId: 'branch-1',
      sessionId: 'sess-1',
      userId: 'user-1',
    };

    const yape63Pending: PendingOfflineSale = {
      id: 'offline_1795136100_abc123',
      offlineId: 'offline_1795136100_abc123',
      timestamp: 1795136100000,
      retryCount: 0,
      status: 'pending_offline',
      salePayload: {
        accountId: 'acc-1',
        branchId: 'branch-1',
        userId: 'user-1',
        userName: 'Usuario Demo',
        sessionId: 'sess-1',
        documentType: 'nota_venta',
        paymentMethod: 'yape',
        paymentMethodId: 'yape',
        paymentMethodName: 'Yape',
        digitalProvider: 'yape',
        total: 63,
        subtotal: 63,
        tax: 0,
        saleDate: 1795136100000,
        items: [{ productId: 'p1', name: 'Detergente saturno 15kg', price: 63, quantity: 1 }],
        payments: [{ category: 'digital', digitalProvider: 'yape', amount: 63, methodId: 'yape', methodName: 'Yape' } as any],
        customerName: 'PECHO PECHO MARLON YOHEL',
      },
    };

    const mixedPending: PendingOfflineSale = {
      id: 'offline_1795136200_def456',
      offlineId: 'offline_1795136200_def456',
      timestamp: 1795136200000,
      retryCount: 0,
      status: 'pending_offline',
      salePayload: {
        accountId: 'acc-1',
        branchId: 'branch-1',
        userId: 'user-1',
        userName: 'Usuario Demo',
        sessionId: 'sess-1',
        documentType: 'nota_venta',
        paymentMethod: 'efectivo',
        total: 50,
        subtotal: 50,
        tax: 0,
        saleDate: 1795136200000,
        items: [{ productId: 'p2', name: 'Arroz', price: 50, quantity: 1 }],
        payments: [
          { category: 'cash', amount: 20 } as any,
          { category: 'digital', digitalProvider: 'plin', amount: 15 } as any,
          { category: 'card', amount: 15 } as any,
        ],
      },
    };

    it('maps pending offline sale to canonical OFF- sale record', () => {
      const record = pendingOfflineSaleToSaleRecord(yape63Pending);
      expect(record.id).toBe(yape63Pending.offlineId);
      expect(record.offlineId).toBe(yape63Pending.offlineId);
      expect(record.correlative).toBe('OFF-ABC123');
      expect(record.documentNumber).toBe('OFF-ABC123');
      expect(record.isOfflinePending).toBe(true);
      expect(record.offlineQueued).toBe(true);
      expect(record.status).toBe('pending_offline');
      expect(record.total).toBe(63);
      expect(record.digitalAmount).toBe(63);
      expect(record.customerName).toBe('PECHO PECHO MARLON YOHEL');
    });

    it('computes cash/digital/mixed deltas accurately and skips already-synced offlineIds', () => {
      const deltaYape = computeOfflineCashDelta([yape63Pending], new Set(), scope);
      expect(deltaYape.yape).toBe(63);
      expect(deltaYape.totalDigital).toBe(63);
      expect(deltaYape.totalAll).toBe(63);
      expect(deltaYape.counts.yape).toBe(1);
      expect(deltaYape.count).toBe(1);

      const deltaBoth = computeOfflineCashDelta([yape63Pending, mixedPending], new Set(), scope);
      expect(deltaBoth.cash).toBe(20);
      expect(deltaBoth.yape).toBe(63);
      expect(deltaBoth.plin).toBe(15);
      expect(deltaBoth.card).toBe(15);
      expect(deltaBoth.totalDigital).toBe(93);
      expect(deltaBoth.totalAll).toBe(113);
      expect(deltaBoth.count).toBe(2);

      // Already synced on server -> no double count
      const deltaDeduped = computeOfflineCashDelta(
        [yape63Pending, mixedPending],
        new Set([yape63Pending.offlineId]),
        scope
      );
      expect(deltaDeduped.yape).toBe(0);
      expect(deltaDeduped.cash).toBe(20);
      expect(deltaDeduped.count).toBe(1);
    });

    it('merges server sales and unsynced pending offline sales without duplicating synced records', () => {
      const serverSales: Array<Record<string, any>> = [
        {
          id: 'srv-1',
          offlineId: yape63Pending.offlineId,
          date: 1795136100000,
          total: 63,
          status: 'completed',
        },
        {
          id: 'srv-0',
          date: 1795135000000,
          total: 25,
          status: 'completed',
        },
      ];

      const merged = mergeSalesWithOfflinePending(
        serverSales,
        [yape63Pending, mixedPending],
        scope
      );

      expect(merged.map((s) => s.id)).toEqual([mixedPending.offlineId, 'srv-1', 'srv-0']);
      expect(merged[0].isOfflinePending).toBe(true);
    });
  });

  describe('offline-sync-service enqueue & pre-check index tolerance', () => {
    it('strips skipOfflineDedup on enqueue and emits queue change events', async () => {
      const events: OfflineQueueChangeEvent[] = [];
      const unsub = subscribeOfflineQueueChanges((ev) => events.push(ev));

      await enqueueOfflineSale({
        accountId: 'acc-1',
        branchId: 'b-1',
        userId: 'user-1',
        userName: 'Cajero',
        items: [{ productId: 'p1', name: 'Test', price: 63, quantity: 1 }],
        paymentMethod: 'yape',
        documentType: 'nota_venta',
        total: 63,
        offlineId: 'offline_strip_test',
        skipOfflineDedup: true,
      });

      const queue = await getOfflineQueue();
      expect(queue).toHaveLength(1);
      expect((queue[0].salePayload as any).skipOfflineDedup).toBeUndefined();
      expect(events).toEqual([{ type: 'enqueued', queueCount: 1 }]);

      unsub();
    });

    it('proceeds with createSaleTransaction when Firestore dedup pre-check throws missing-index error', async () => {
      const events: OfflineQueueChangeEvent[] = [];
      const unsub = subscribeOfflineQueueChanges((ev) => events.push(ev));

      await enqueueOfflineSale({
        accountId: 'acc-1',
        branchId: 'b-1',
        userId: 'user-1',
        userName: 'Cajero',
        sessionId: 'sess-1',
        items: [{ productId: 'p1', name: 'Detergente', price: 63, quantity: 1 }],
        paymentMethod: 'yape',
        documentType: 'nota_venta',
        total: 63,
        offlineId: 'offline_idx_fallback',
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      syncMocks.getDocsImpl.mockRejectedValueOnce(
        Object.assign(new Error('The query requires an index'), { code: 'failed-precondition' })
      );

      const summary = await processOfflineQueue('acc-1');
      warnSpy.mockRestore();
      unsub();

      expect(summary.processed).toBe(1);
      expect(summary.successful).toBe(1);
      expect(summary.quarantined).toBe(0);
      expect(syncMocks.createSaleTransactionImpl).toHaveBeenCalledTimes(1);
      expect((await getOfflineQueue()).length).toBe(0);
      expect(events.some((e) => e.type === 'synced' && e.successful === 1 && e.queueCount === 0)).toBe(true);
    });
  });
});
