import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Wave 1 performance service optimizations', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('account-notifications-feed multiplexing & foreground deferral', () => {
    it('shares one onSnapshot per accountId across different branchId filters and cleans up on last unsub', async () => {
      let appStateHandler: ((state: string) => void) | null = null;
      const appStateMock = {
        currentState: 'active',
        addEventListener: vi.fn((_event: string, cb: (state: string) => void) => {
          appStateHandler = cb;
          return { remove: vi.fn() };
        }),
      };

      const unsubFirestore = vi.fn();
      let snapshotCallback: ((snap: any) => void) | null = null;
      const onSnapshotMock = vi.fn((_q: any, onNext: (snap: any) => void) => {
        snapshotCallback = onNext;
        return unsubFirestore;
      });

      vi.doMock('react-native', () => ({ AppState: appStateMock }));
      vi.doMock('@/lib/firebase', () => ({ db: { mocked: true } }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn((_db: any, name: string) => ({ name })),
        doc: vi.fn((_db: any, col: string, id: string) => ({ col, id })),
        query: vi.fn((...args: any[]) => ({ args })),
        where: vi.fn((...args: any[]) => ({ type: 'where', args })),
        orderBy: vi.fn((...args: any[]) => ({ type: 'orderBy', args })),
        limit: vi.fn((n: number) => ({ type: 'limit', n })),
        onSnapshot: onSnapshotMock,
        updateDoc: vi.fn(),
        writeBatch: vi.fn(),
      }));

      const { subscribeAccountNotifications } = await import('../account-notifications-feed');

      const branch1Cb = vi.fn();
      const branch2Cb = vi.fn();

      const unsub1 = subscribeAccountNotifications('acc-1', 'branch-1', branch1Cb);
      const unsub2 = subscribeAccountNotifications('acc-1', 'branch-2', branch2Cb);

      // Only ONE Firestore listener created for account 'acc-1' despite two distinct branchIds
      expect(onSnapshotMock).toHaveBeenCalledTimes(1);
      expect(typeof appStateHandler).toBe('function');

      snapshotCallback!({
        forEach: (fn: (d: any) => void) => {
          fn({
            id: 'n1',
            data: () => ({ accountId: 'acc-1', branchId: 'branch-1', title: 'B1', body: '', type: 'system', read: false, createdAt: 100 }),
          });
          fn({
            id: 'n2',
            data: () => ({ accountId: 'acc-1', branchId: 'branch-2', title: 'B2', body: '', type: 'system', read: false, createdAt: 200 }),
          });
          fn({
            id: 'n3',
            data: () => ({ accountId: 'acc-1', title: 'Global', body: '', type: 'system', read: false, createdAt: 300 }),
          });
        },
      });

      expect(branch1Cb).toHaveBeenLastCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'n1' }),
          expect.objectContaining({ id: 'n3' }),
        ])
      );
      expect(branch1Cb.mock.calls[0][0].map((n: any) => n.id)).toEqual(['n1', 'n3']);
      expect(branch2Cb.mock.calls[0][0].map((n: any) => n.id)).toEqual(['n2', 'n3']);

      unsub1();
      expect(unsubFirestore).not.toHaveBeenCalled();
      unsub2();
      expect(unsubFirestore).toHaveBeenCalledTimes(1);
    });

    it('defers onSnapshot attach when AppState is backgrounded until returning to active', async () => {
      let appStateHandler: ((state: string) => void) | null = null;
      const appStateMock = {
        currentState: 'background',
        addEventListener: vi.fn((_event: string, cb: (state: string) => void) => {
          appStateHandler = cb;
          return { remove: vi.fn() };
        }),
      };
      const onSnapshotMock = vi.fn(() => vi.fn());

      vi.doMock('react-native', () => ({ AppState: appStateMock }));
      vi.doMock('@/lib/firebase', () => ({ db: { mocked: true } }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn((_db: any, name: string) => ({ name })),
        doc: vi.fn((_db: any, col: string, id: string) => ({ col, id })),
        query: vi.fn((...args: any[]) => ({ args })),
        where: vi.fn(),
        orderBy: vi.fn(),
        limit: vi.fn(),
        onSnapshot: onSnapshotMock,
        updateDoc: vi.fn(),
        writeBatch: vi.fn(),
      }));

      const { subscribeAccountNotifications } = await import('../account-notifications-feed');

      const unsub = subscribeAccountNotifications('acc-bg', 'b1', vi.fn());
      expect(onSnapshotMock).not.toHaveBeenCalled();

      appStateMock.currentState = 'active';
      appStateHandler!('active');
      expect(onSnapshotMock).toHaveBeenCalledTimes(1);

      unsub();
    });
  });

  describe('offline-sync-service cache, skipOfflineDedup, claims bypass & reachability backoff', () => {
    it('hydrates queueCache once, emits { count, items }, skips users/{uid} lookup when claim exists, and passes skipOfflineDedup=true', async () => {
      const storage = new Map<string, string>();
      const getItemMock = vi.fn(async (key: string) => storage.get(key) ?? null);
      const setItemMock = vi.fn(async (key: string, val: string) => {
        storage.set(key, val);
      });
      const removeItemMock = vi.fn(async (key: string) => {
        storage.delete(key);
      });

      const getDocMock = vi.fn();
      const getDocsMock = vi.fn(async () => ({ empty: true, docs: [] }));
      const createSaleTransactionMock = vi.fn(async () => ({ saleId: 'sale-1', notaNumber: 'NV-001', total: 25 }));
      const netFetchMock = vi.fn(async () => ({ isConnected: true, isInternetReachable: true }));

      vi.doMock('@react-native-async-storage/async-storage', () => ({
        default: {
          getItem: getItemMock,
          setItem: setItemMock,
          removeItem: removeItemMock,
        },
      }));
      vi.doMock('@react-native-community/netinfo', () => ({
        default: {
          fetch: netFetchMock,
          addEventListener: vi.fn(() => vi.fn()),
        },
      }));
      vi.doMock('@/lib/firebase', () => ({
        db: { mocked: true },
        auth: {
          currentUser: {
            uid: 'u1',
            getIdTokenResult: vi.fn(async () => ({ claims: { accountId: 'acc-1' } })),
          },
        },
      }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn((_db: any, name: string) => ({ name })),
        query: vi.fn((...args: any[]) => ({ args })),
        where: vi.fn(),
        limit: vi.fn(),
        getDocs: getDocsMock,
        getDoc: getDocMock,
        doc: vi.fn((_db: any, col: string, id: string) => ({ col, id })),
      }));
      vi.doMock('../sale-service', () => ({
        createSaleTransaction: createSaleTransactionMock,
      }));

      const {
        enqueueOfflineSale,
        getOfflineQueue,
        processOfflineQueue,
        subscribeOfflineQueueChanges,
        OFFLINE_QUEUE_STORAGE_KEY,
      } = await import('../offline-sync-service');

      const events: any[] = [];
      const unsub = subscribeOfflineQueueChanges((ev) => events.push(ev));

      await enqueueOfflineSale({
        accountId: 'acc-1',
        branchId: 'b1',
        userId: 'u1',
        userName: 'Cajero',
        items: [{ productId: 'p1', name: 'Agua', price: 25, quantity: 1 }],
        paymentMethod: 'cash',
        documentType: 'nota_venta',
        total: 25,
        offlineId: 'off-1',
      });

      expect(events[0]).toMatchObject({
        type: 'enqueued',
        queueCount: 1,
        count: 1,
      });
      expect(events[0].items).toHaveLength(1);

      const queueReadsBefore = getItemMock.mock.calls.filter(([k]) => k === OFFLINE_QUEUE_STORAGE_KEY).length;
      expect(queueReadsBefore).toBe(1);

      // Repeated getOfflineQueue calls must read from in-memory queueCache without touching AsyncStorage
      const q1 = await getOfflineQueue();
      const q2 = await getOfflineQueue();
      expect(q1).toHaveLength(1);
      expect(q2).toHaveLength(1);
      expect(getItemMock.mock.calls.filter(([k]) => k === OFFLINE_QUEUE_STORAGE_KEY).length).toBe(1);

      const summary = await processOfflineQueue();
      expect(summary.successful).toBe(1);
      // Claim accountId resolved account without reading users/{uid}
      expect(getDocMock).not.toHaveBeenCalled();
      expect(getDocsMock).toHaveBeenCalledTimes(1);
      expect(createSaleTransactionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          offlineId: 'off-1',
          skipOfflineDedup: true,
        })
      );
      expect(events[1]).toMatchObject({
        type: 'synced',
        queueCount: 0,
        count: 0,
        items: [],
        successful: 1,
      });

      unsub();
    });

    it('applies exponential reachability backoff [5000, 15000, 30000, 60000] when connected without internet', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const pendingSale = JSON.stringify([
        {
          id: 'id-1',
          offlineId: 'off-backoff-1',
          timestamp: Date.now(),
          retryCount: 0,
          status: 'pending_offline',
          salePayload: {
            accountId: 'acc-1',
            branchId: 'b1',
            userId: 'u1',
            userName: 'Cajero',
            items: [],
            paymentMethod: 'cash',
            documentType: 'nota_venta',
            total: 10,
          },
        },
      ]);

      vi.doMock('@react-native-async-storage/async-storage', () => ({
        default: {
          getItem: vi.fn(async () => pendingSale),
          setItem: vi.fn(async () => {}),
          removeItem: vi.fn(async () => {}),
        },
      }));
      vi.doMock('@react-native-community/netinfo', () => ({
        default: {
          fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: false })),
          addEventListener: vi.fn(() => vi.fn()),
        },
      }));
      vi.doMock('@/lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn(),
        query: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(),
        getDocs: vi.fn(),
        getDoc: vi.fn(),
        doc: vi.fn(),
      }));
      vi.doMock('../sale-service', () => ({ createSaleTransaction: vi.fn() }));

      const { offlineSyncService } = await import('../offline-sync-service');
      const delays: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const prevCalls = setTimeoutSpy.mock.calls.length;
        await offlineSyncService.processOfflineQueue('acc-1');
        const lastCall = setTimeoutSpy.mock.calls[prevCalls];
        delays.push(Number(lastCall?.[1]));
      }

      expect(delays).toEqual([5_000, 15_000, 30_000, 60_000, 60_000]);
    });
  });

  describe('cash-register-service compact projection & 250-entry cap', () => {
    it('projects compact sales/movements and flags truncation when > 250 entries while auditing full totals', async () => {
      const txSets: Array<{ ref: any; data: any }> = [];
      let reportIdCounter = 0;

      const manySales = Array.from({ length: 260 }, (_, idx) => ({
        id: `sale-${idx}`,
        total: 10,
        status: 'completed',
        paymentMethod: 'cash',
        payments: [{ category: 'cash', amount: 10 }],
        items: [{ productId: 'p1', name: 'Bloated item array', metadata: 'x'.repeat(200) }],
        sunatXmlBlob: 'very-large-unused-blob',
        date: 1700000000000 + idx,
      }));
      const manyMovements = Array.from({ length: 255 }, (_, idx) => ({
        id: `mov-${idx}`,
        type: 'income',
        category: 'other_income',
        amount: 2,
        method: 'cash',
        createdAt: 1700000000000 + idx,
        bulkyNestedDebug: { payload: 'x'.repeat(200) },
      }));

      vi.doMock('@/lib/firebase', () => ({
        db: { mocked: true },
        auth: { currentUser: { uid: 'u1', displayName: 'Cajero' } },
      }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn((_db: any, name: string) => ({ name })),
        doc: vi.fn((...args: any[]) => {
          if (args.length === 1) {
            return { col: args[0].name, id: `rep-${++reportIdCounter}` };
          }
          return { col: args[1], id: args[2] };
        }),
        query: vi.fn((...args: any[]) => ({ args })),
        where: vi.fn((...args: any[]) => ({ args })),
        orderBy: vi.fn(),
        limit: vi.fn(),
        getDoc: vi.fn(async (ref: any) => {
          if (ref.id === 's1') {
            return {
              exists: () => true,
              data: () => ({
                id: 's1',
                accountId: 'acc-1',
                branchId: 'b1',
                status: 'open',
                openingBalance: 100,
                startedBy: 'u1',
                startedByName: 'Cajero',
                openedAt: 1700000000000,
              }),
            };
          }
          return { exists: () => false, data: () => ({}) };
        }),
        getDocs: vi.fn(async (q: any) => {
          const colName = q.args?.[0]?.name;
          if (colName === 'cash_register_movements') {
            return {
              docs: manyMovements.map((m) => ({ id: m.id, data: () => m })),
            };
          }
          if (colName === 'sales') {
            return {
              docs: manySales.map((s) => ({ id: s.id, data: () => s })),
            };
          }
          return { docs: [] };
        }),
        setDoc: vi.fn(),
        updateDoc: vi.fn(async () => {}),
        deleteDoc: vi.fn(async () => {}),
        addDoc: vi.fn(),
        onSnapshot: vi.fn(),
        serverTimestamp: () => 'server-ts',
        runTransaction: vi.fn(async (_db: any, cb: (tx: any) => Promise<void>) => {
          const tx = {
            get: async () => ({
              exists: () => true,
              data: () => ({ id: 's1', accountId: 'acc-1', branchId: 'b1', status: 'open', openingBalance: 100 }),
            }),
            update: vi.fn(),
            set: vi.fn((ref: any, data: any) => txSets.push({ ref, data })),
          };
          await cb(tx);
        }),
      }));

      const { closeCashSession } = await import('../cash-register-service');

      // Audit expects: 100 opening + 260*10 cash sales + 255*2 manual incomes = 3210
      const res = await closeCashSession({
        accountId: 'acc-1',
        branchId: 'b1',
        sessionId: 's1',
        countedAmount: 3210,
      });

      expect(res.audit.expectedCashInDrawer).toBe(3210);
      expect(res.audit.salesCount).toBe(260);
      expect(res.difference).toBe(0);

      const reportWrite = txSets.find((w) => w.ref.col === 'cash_register_reports');
      expect(reportWrite).toBeDefined();
      expect(reportWrite!.data.sales).toHaveLength(250);
      expect(reportWrite!.data.movements).toHaveLength(250);
      expect(reportWrite!.data.salesTruncated).toBe(true);
      expect(reportWrite!.data.movementsTruncated).toBe(true);
      expect(reportWrite!.data.sales[0]).not.toHaveProperty('items');
      expect(reportWrite!.data.sales[0]).not.toHaveProperty('sunatXmlBlob');
      expect(reportWrite!.data.sales[0]).toMatchObject({ id: 'sale-0', total: 10, paymentMethod: 'cash' });
      expect(reportWrite!.data.movements[0]).not.toHaveProperty('bulkyNestedDebug');
      expect(reportWrite!.data.movements[0]).toMatchObject({ id: 'mov-0', amount: 2, category: 'other_income' });
    });
  });

  describe('suppliers-po-service batch price updates', () => {
    it('commits multiple product price updates using writeBatch instead of per-doc updateDoc', async () => {
      const batchUpdate = vi.fn();
      const batchCommit = vi.fn(async () => {});
      const updateDocMock = vi.fn();

      vi.doMock('@/lib/firebase', () => ({ db: { mocked: true } }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn(),
        doc: vi.fn((_db: any, col: string, id: string) => ({ col, id })),
        getDoc: vi.fn(async (ref: any) => ({
          exists: () => ref.id !== 'missing',
          data: () => ({ id: ref.id, price: 10, costPrice: 6 }),
        })),
        getDocs: vi.fn(),
        setDoc: vi.fn(),
        updateDoc: updateDocMock,
        deleteDoc: vi.fn(),
        addDoc: vi.fn(),
        query: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn(),
        limit: vi.fn(),
        onSnapshot: vi.fn(),
        runTransaction: vi.fn(),
        serverTimestamp: () => 'server-ts',
        writeBatch: vi.fn(() => ({ update: batchUpdate, commit: batchCommit })),
      }));

      const { applyBatchProductSuggestedPrices } = await import('../suppliers-po-service');

      const updatedCount = await applyBatchProductSuggestedPrices([
        { productId: 'p1', suggestedPrice: 12 },
        { productId: 'p2', suggestedPrice: 18 },
        { productId: 'missing', suggestedPrice: 20 },
      ]);

      expect(updatedCount).toBe(2);
      expect(batchUpdate).toHaveBeenCalledTimes(2);
      expect(batchCommit).toHaveBeenCalledTimes(1);
      expect(updateDocMock).not.toHaveBeenCalled();
    });
  });
});
