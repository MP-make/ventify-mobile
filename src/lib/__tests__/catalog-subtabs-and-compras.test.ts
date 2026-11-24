import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

function createSyncMemoryKV() {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      isSyncCapable: true,
      getItem: async (k: string) => map.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: async (k: string) => {
        map.delete(k);
      },
      multiRemove: async (keys: string[]) => {
        for (const k of keys) map.delete(k);
      },
      getAllKeys: async () => Array.from(map.keys()),
      getItemSync: (k: string) => map.get(k) ?? null,
      setItemSync: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItemSync: (k: string) => {
        map.delete(k);
      },
    },
  };
}

function makeFirestoreDoc(id: string, data: Record<string, any>) {
  return {
    id,
    data: () => data,
  };
}

describe('catalog sub-tabs & Compras regressions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@/lib/firebase');
    vi.doUnmock('@/lib/native-kv-storage');
    vi.doUnmock('firebase/firestore');
    vi.doUnmock('react-native');
  });

  it('removes display:none from catalog.tsx and hardens panel wrappers with collapsable={false}', () => {
    const catalogSource = fs.readFileSync(
      path.join(WORKSPACE_ROOT, 'app/(tabs)/catalog.tsx'),
      'utf8'
    );
    expect(catalogSource).not.toMatch(/display:\s*['"]none['"]/);
    expect(catalogSource).toContain('panelsStage');
    expect(catalogSource).toContain('collapsable={false}');
    expect(catalogSource).not.toContain('getSuppliersPurchaseModal');
  });

  it('wraps SuppliersPurchaseModal in an outer SuppliersErrorBoundary with collapsable={false} and listFlex', () => {
    const modalSource = fs.readFileSync(
      path.join(WORKSPACE_ROOT, 'src/components/SuppliersPurchaseModal.tsx'),
      'utf8'
    );
    const exportIdx = modalSource.indexOf('export const SuppliersPurchaseModal');
    expect(exportIdx).toBeGreaterThan(-1);
    const exportedBlock = modalSource.slice(exportIdx);
    expect(exportedBlock).toContain('<SuppliersErrorBoundary>');
    expect(exportedBlock).toContain('<SuppliersPurchaseContent');
    expect(modalSource).toContain('collapsable={false}');
    expect(modalSource).toContain('style={styles.listFlex}');
    expect(modalSource).toContain('componentDidCatch');
  });

  it('caches getStockTransfers across branches, honors forceRefresh, falls back on 10s timeout, and hydrates SWR sync cache', async () => {
    const kv = createSyncMemoryKV();
    const orderByMock = vi.fn((field: string, dir: string) => ({ type: 'orderBy', field, dir }));
    const getDocsMock = vi.fn(async () => ({
      docs: [
        makeFirestoreDoc('trf-1', {
          accountId: 'acc-1',
          sourceBranchId: 'b1',
          destinationBranchId: 'b2',
          status: 'pending',
          items: [{ productId: 'p1', productName: 'Prod 1', quantity: 2 }],
          createdAt: { seconds: 1700000100, nanoseconds: 0 },
        }),
        makeFirestoreDoc('trf-2', {
          accountId: 'acc-1',
          sourceBranchId: 'b3',
          destinationBranchId: 'b4',
          status: 'completed',
          items: [{ productId: 'p2', productName: 'Prod 2', quantity: 1 }],
          createdAt: { seconds: 1700000000, nanoseconds: 0 },
        }),
      ],
    }));

    vi.doMock('@/lib/firebase', () => ({ db: { mocked: true }, app: {} }));
    vi.doMock('@/lib/native-kv-storage', () => ({
      catalogKVStorage: kv.storage,
      cartKVStorage: kv.storage,
      metaKVStorage: kv.storage,
    }));
    vi.doMock('firebase/firestore', () => ({
      collection: vi.fn((_db: any, name: string) => ({ name })),
      doc: vi.fn(),
      runTransaction: vi.fn(),
      serverTimestamp: () => 'ts',
      query: vi.fn((...parts: any[]) => ({ parts })),
      where: vi.fn((f: string, op: string, v: any) => ({ f, op, v })),
      orderBy: orderByMock,
      limit: vi.fn((n: number) => ({ limit: n })),
      getDocs: getDocsMock,
      getDoc: vi.fn(),
      setDoc: vi.fn(),
      updateDoc: vi.fn(),
      Timestamp: { fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0 }) },
    }));

    const { getStockTransfers, getCachedStockTransfersSync } = await import(
      '../../services/inventory-kardex-service'
    );

    // 1. First load for b1 hits Firestore once; second load for b3 hits account-level sharedRequestCache!
    const branch1Transfers = await getStockTransfers('acc-1', 'b1');
    const branch3Transfers = await getStockTransfers('acc-1', 'b3');
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    expect(branch1Transfers.map((t) => t.id)).toEqual(['trf-1']);
    expect(branch3Transfers.map((t) => t.id)).toEqual(['trf-2']);

    // 2. Synchronous MMKV SWR cache returns branch-filtered cached records immediately
    const cachedBranch1 = getCachedStockTransfersSync('acc-1', 'b1');
    const cachedAll = getCachedStockTransfersSync('acc-1', 'all');
    expect(cachedBranch1.map((t) => t.id)).toEqual(['trf-1']);
    expect(cachedAll).toHaveLength(2);
    expect(typeof cachedAll[0].createdAt).toBe('number');

    // 3. forceRefresh bypasses TTL cache
    await getStockTransfers('acc-1', 'b1', undefined, { forceRefresh: true });
    expect(getDocsMock).toHaveBeenCalledTimes(2);

    // 4. Hung Firestore request times out at 10s and returns [] cleanly without infinite wait
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started: (() => void) | null = null;
    const waitStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    getDocsMock.mockImplementationOnce(
      () =>
        new Promise(() => {
          started?.();
        })
    );
    const pending = getStockTransfers('acc-1', 'b1', undefined, { forceRefresh: true });
    await waitStarted;
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual([]);
  });

  it('deduplicates getProductKardex via sharedRequestCache, respects forceRefresh, and skips unordered fallback on non-index errors', async () => {
    const kv = createSyncMemoryKV();
    const orderByMock = vi.fn((field: string, dir: string) => ({ type: 'orderBy', field, dir }));
    const getDocsMock = vi.fn(async () => ({
      docs: [
        makeFirestoreDoc('mov-1', {
          accountId: 'acc-1',
          branchId: 'b1',
          productId: 'p1',
          productName: 'Cafe',
          quantityChanged: 5,
          createdAt: { seconds: 1700000200, nanoseconds: 0 },
        }),
      ],
    }));

    vi.doMock('@/lib/firebase', () => ({ db: { mocked: true }, app: {} }));
    vi.doMock('@/lib/native-kv-storage', () => ({
      catalogKVStorage: kv.storage,
      cartKVStorage: kv.storage,
      metaKVStorage: kv.storage,
    }));
    vi.doMock('firebase/firestore', () => ({
      collection: vi.fn((_db: any, name: string) => ({ name })),
      doc: vi.fn(),
      runTransaction: vi.fn(),
      serverTimestamp: () => 'ts',
      query: vi.fn((...parts: any[]) => ({ parts })),
      where: vi.fn((f: string, op: string, v: any) => ({ f, op, v })),
      orderBy: orderByMock,
      limit: vi.fn((n: number) => ({ limit: n })),
      getDocs: getDocsMock,
      getDoc: vi.fn(),
      setDoc: vi.fn(),
      updateDoc: vi.fn(),
      Timestamp: { fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0 }) },
    }));

    const { getProductKardex, getCachedProductKardexSync } = await import(
      '../../services/inventory-kardex-service'
    );

    const first = await getProductKardex('acc-1', 'b1');
    const second = await getProductKardex('acc-1', 'b1');
    expect(getDocsMock).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(getCachedProductKardexSync('acc-1', 'b1')).toHaveLength(1);

    await getProductKardex('acc-1', 'b1', undefined, 50, { forceRefresh: true });
    expect(getDocsMock).toHaveBeenCalledTimes(2);

    // Non-index error MUST NOT run a second unordered fallback query
    getDocsMock.mockRejectedValueOnce(new Error('network unavailable'));
    const errored = await getProductKardex('acc-1', 'b1', undefined, 50, { forceRefresh: true });
    expect(errored).toEqual([]);
    expect(getDocsMock).toHaveBeenCalledTimes(3);
  });

  it('attaches subscribePurchaseOrders across active/inactive/undefined AppState and limits getPurchaseOrdersAsync fallback to missing-index errors', async () => {
    const kv = createSyncMemoryKV();
    const appStateObj: { currentState?: string; addEventListener: any } = {
      currentState: 'inactive',
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    };

    const onSnapshotMock = vi.fn((_q: any, onNext: any) => {
      onNext({
        docs: [
          makeFirestoreDoc('po-1', {
            accountId: 'acc-1',
            branchId: 'b1',
            supplierName: 'Distribuidora',
            status: 'pending',
            items: [],
            subtotal: 100,
            totalCost: 100,
            createdAt: new Date(1700000300000),
          }),
        ],
      });
      return vi.fn();
    });

    const getDocsMock = vi.fn(async (): Promise<{ docs: any[] }> => ({ docs: [] }));

    // suppliers-po-service loads react-native via CommonJS require() inside try/catch
    // so Node/Vitest callers without RN mocks never crash on RN's Flow entrypoint.
    const NativeModule = require('module');
    const originalLoad = NativeModule._load;
    const loadSpy = vi
      .spyOn(NativeModule, '_load')
      .mockImplementation((request: unknown, ...args: unknown[]) => {
        if (request === 'react-native') {
          return { AppState: appStateObj };
        }
        return originalLoad.call(NativeModule, request, ...args);
      });

    try {
      vi.doMock('@/lib/firebase', () => ({ db: { mocked: true }, app: {} }));
      vi.doMock('@/lib/native-kv-storage', () => ({
        catalogKVStorage: kv.storage,
        cartKVStorage: kv.storage,
        metaKVStorage: kv.storage,
      }));
      vi.doMock('firebase/firestore', () => ({
        collection: vi.fn((_db: any, name: string) => ({ name })),
        doc: vi.fn(),
        addDoc: vi.fn(),
        setDoc: vi.fn(),
        getDoc: vi.fn(),
        getDocs: getDocsMock,
        updateDoc: vi.fn(),
        query: vi.fn((...parts: any[]) => ({ parts })),
        where: vi.fn((f: string, op: string, v: any) => ({ f, op, v })),
        orderBy: vi.fn((field: string, dir: string) => ({ field, dir })),
        limit: vi.fn((n: number) => ({ limit: n })),
        onSnapshot: onSnapshotMock,
        runTransaction: vi.fn(),
        serverTimestamp: () => 'ts',
        Timestamp: class MockTimestamp {},
        getCountFromServer: vi.fn(),
      }));

      const { subscribePurchaseOrders, getPurchaseOrdersAsync, getCachedPurchaseOrdersSync } =
        await import('../../services/suppliers-po-service');

      // Attaches on 'inactive'
      const cbInactive = vi.fn();
      const unsub1 = subscribePurchaseOrders('acc-1', cbInactive);
      expect(onSnapshotMock).toHaveBeenCalledTimes(1);
      expect(cbInactive).toHaveBeenCalledTimes(1);
      expect(getCachedPurchaseOrdersSync('acc-1')).toHaveLength(1);
      unsub1();

      // Attaches on 'active'
      appStateObj.currentState = 'active';
      const cbActive = vi.fn();
      const unsub2 = subscribePurchaseOrders('acc-1', cbActive);
      expect(onSnapshotMock).toHaveBeenCalledTimes(2);
      unsub2();

      // Attaches on undefined
      appStateObj.currentState = undefined;
      const cbUndef = vi.fn();
      const unsub3 = subscribePurchaseOrders('acc-1', cbUndef);
      expect(onSnapshotMock).toHaveBeenCalledTimes(3);
      unsub3();

      // Does NOT attach when initially 'background'
      appStateObj.currentState = 'background';
      const cbBg = vi.fn();
      const unsub4 = subscribePurchaseOrders('acc-1', cbBg);
      expect(onSnapshotMock).toHaveBeenCalledTimes(3);
      unsub4();

      // Non-index error in getPurchaseOrdersAsync does NOT retry unordered query
      getDocsMock.mockRejectedValueOnce(new Error('permission-denied'));
      await expect(getPurchaseOrdersAsync('acc-1')).resolves.toEqual([]);
      expect(getDocsMock).toHaveBeenCalledTimes(1);

      // Missing-index error triggers unordered fallback once and caches indexKey
      const indexErr = Object.assign(new Error('The query requires an index'), {
        code: 'failed-precondition',
      });
      getDocsMock.mockRejectedValueOnce(indexErr);
      getDocsMock.mockResolvedValueOnce({
        docs: [
          makeFirestoreDoc('po-2', {
            accountId: 'acc-1',
            branchId: 'b1',
            supplierName: 'Fallback',
            status: 'pending',
            items: [],
            subtotal: 50,
            totalCost: 50,
          }),
        ],
      });
      const fallbackOrders = await getPurchaseOrdersAsync('acc-1');
      expect(getDocsMock).toHaveBeenCalledTimes(3);
      expect(fallbackOrders.map((o) => o.id)).toEqual(['po-2']);
    } finally {
      loadSpy.mockRestore();
    }
  });
});
