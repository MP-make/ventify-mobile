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

vi.mock('@/services/inventory-kardex-service', () => ({
  PRODUCTS_COLLECTION: 'products',
  adjustProductStock: vi.fn(),
  saveProduct: vi.fn(),
}));

import { shouldDeactivateUserOnMissingDoc } from '../access-policy';
import { buildSaleQrContent } from '../invoicing/qr-content';
import { generateQrMatrix, generateQrSvgData } from '../invoicing/qr-matrix';
import { buildReservationReceiptHtml, EscPosBuilder } from '../printing/escpos-builder';
import { effectivePermissions, ROLE_PERMISSIONS } from '../role-permissions';
import {
  computeOfflineCashDelta,
  mergeSalesWithOfflinePending,
  pendingOfflineSaleToSaleRecord,
} from '../offline-sales-helpers';
import {
  cancelPendingOfflineSale,
  classifySyncError,
  enqueueOfflineSale,
  getOfflineQueue,
  getQuarantinedSalesForIdentity,
  offlineSyncService,
  processOfflineQueue,
  retryQuarantinedSale,
  subscribeOfflineQueueChanges,
  type OfflineQueueChangeEvent,
  type PendingOfflineSale,
} from '@/services/offline-sync-service';
import {
  cancelPendingInventoryOp,
  enqueueOfflineStockAdjust,
  getOfflineInventoryQueueForIdentity,
  offlineInventoryService,
} from '@/services/offline-inventory-service';

describe('offline auth policy, offline Caja/Ventas helpers, and offline sync regressions', () => {
  beforeEach(() => {
    syncMocks.storage.clear();
    offlineSyncService.resetQueueCache();
    offlineInventoryService.resetQueueCache();
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

    it('returns the exact serverSales array reference when pending offline queue has no new scoped records', () => {
      const serverSales: Array<Record<string, any>> = [
        { id: 'srv-1', offlineId: yape63Pending.offlineId, date: 1795136100000, total: 63 },
        { id: 'srv-0', date: 1795135000000, total: 25 },
      ];

      // 1. Empty offline queue -> zero-copy fast-path
      expect(mergeSalesWithOfflinePending(serverSales, [], scope)).toBe(serverSales);

      // 2. Pending list only contains already-synced or out-of-scope sales -> zero-copy fast-path
      const otherBranchPending: PendingOfflineSale = {
        ...mixedPending,
        id: 'offline_other_branch',
        offlineId: 'offline_other_branch',
        salePayload: {
          ...mixedPending.salePayload,
          branchId: 'branch-other',
        },
      };
      expect(
        mergeSalesWithOfflinePending(serverSales, [yape63Pending, otherBranchPending], scope)
      ).toBe(serverSales);
    });

    it('pre-extracts createdAt.toMillis once per sale instead of repeating inside the sort comparator', () => {
      const toMillisSpy1 = vi.fn(() => 1795136100000);
      const toMillisSpy2 = vi.fn(() => 1795136300000);
      const toMillisSpy3 = vi.fn(() => 1795135000000);

      const serverSales: Array<Record<string, any>> = [
        { id: 'srv-mid', createdAt: { toMillis: toMillisSpy1 }, total: 10 },
        { id: 'srv-top', createdAt: { toMillis: toMillisSpy2 }, total: 20 },
        { id: 'srv-low', createdAt: { toMillis: toMillisSpy3 }, total: 30 },
      ];

      const merged = mergeSalesWithOfflinePending(serverSales, [mixedPending], scope);
      expect(merged.map((s) => s.id)).toEqual(['srv-top', mixedPending.offlineId, 'srv-mid', 'srv-low']);
      expect(toMillisSpy1).toHaveBeenCalledTimes(1);
      expect(toMillisSpy2).toHaveBeenCalledTimes(1);
      expect(toMillisSpy3).toHaveBeenCalledTimes(1);
    });
  });

  describe('qr-matrix generateQrSvgData parity', () => {
    it('returns null for empty input and matches generateQrMatrix size/pathData across QR versions', () => {
      expect(generateQrSvgData('')).toBeNull();

      const payloads = [
        '20512345678|03|B001|42|7.63|50.00|2026-11-12|1|12345678',
        '20512345678|01|F001|123|18.00|118.00|2026-11-12|6|20100070970',
        'https://ventify.com.pe/comprobantes/verificacion?ruc=20512345678&tipo=01&serie=F001&correlativo=00001234&total=1480.50&fecha=2026-11-12&hash=AbCdEf1234567890XyZ',
      ];

      const expected = payloads.map((payload) => {
        const matrixRes = generateQrMatrix(payload);
        const svgRes = generateQrSvgData(payload);
        expect(svgRes).toEqual({
          size: matrixRes.size,
          pathData: matrixRes.pathData,
        });
        return svgRes;
      });

      // Re-generating and checking first entry ensures scratch buffers never corrupt cached outputs
      expect(generateQrSvgData(payloads[0])).toEqual(expected[0]);
    });

    it('reuses precomputedAmounts in buildSaleQrContent without altering output', () => {
      const sale = {
        documentType: 'factura' as const,
        documentNumber: 'F001-000123',
        sunatStatus: 'accepted' as const,
        customerRuc: '20100070970',
        subtotal: 100,
        tax: 18,
        total: 118,
        date: new Date('2026-11-12T15:30:00-05:00').getTime(),
      };
      const standard = buildSaleQrContent(sale, { emitterRuc: '20512345678' });
      const withPrecomputed = buildSaleQrContent(sale, {
        emitterRuc: '20512345678',
        precomputedAmounts: { igv: 18, total: 118 },
      });
      expect(withPrecomputed).toBe(standard);
    });
  });

  describe('EscPosBuilder, reservation HTML, and effectivePermissions optimizations', () => {
    it('grows Uint8Array buffer past 2048 bytes and preserves sanitizeText rules', () => {
      const builder = new EscPosBuilder({ paperWidth: 80 });
      builder.line('ASCII\tTab-stripped Café • ñÑ ¿Hola!');
      for (let i = 0; i < 60; i++) {
        builder.twoColumns(`Item ${i} pure ASCII`, `S/ ${(i + 1).toFixed(2)}`);
      }
      const bytes = builder.build();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(2048);
      const decoded = Buffer.from(bytes).toString('latin1');
      expect(decoded).toContain('ASCIITab-stripped Cafe - nN Hola!');
      expect(decoded).not.toContain('\t');
    });

    it('formats numeric HH:MM time in buildReservationReceiptHtml and fast-returns base permissions', () => {
      const html = buildReservationReceiptHtml({
        id: 'res_1',
        reservationNumber: 7,
        createdAt: new Date(2026, 10, 12, 9, 5),
        total: 100,
        depositAmount: 40,
        items: [{ productName: 'Producto', quantity: 1, price: 100 }],
      });
      expect(html).toContain('12/11/2026 09:05 09:05');

      expect(effectivePermissions('cashier', { granted: [], revoked: [] })).toBe(
        ROLE_PERMISSIONS.cashier
      );
      expect(effectivePermissions('seller', { granted: [], revoked: [] })).toBe(
        ROLE_PERMISSIONS.seller
      );
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
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'enqueued', queueCount: 1, count: 1 });
      expect(events[0].items).toHaveLength(1);

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

    it('classifies transient unavailable errors as network_error instead of stock_rejected', () => {
      expect(
        classifySyncError(new Error('Servicio no disponible temporalmente, intenta de nuevo'))
      ).toMatchObject({ category: 'network_error', retriable: true });
      expect(classifySyncError(new Error('temporalmente no disponible'))).toMatchObject({
        category: 'network_error',
        retriable: true,
      });
      expect(
        classifySyncError(new Error('Stock insuficiente para Polo. Stock disponible: 2, requerido: 5'))
      ).toMatchObject({ category: 'stock_rejected', retriable: false });
    });

    it('bypasses nextRetryAt backoff when processOfflineQueue is called with force: true', async () => {
      await enqueueOfflineSale({
        accountId: 'acc-1',
        branchId: 'b-1',
        userId: 'user-1',
        userName: 'Cajero',
        sessionId: 'sess-1',
        items: [{ productId: 'p1', name: 'Detergente', price: 63, quantity: 1 }],
        paymentMethod: 'cash',
        documentType: 'nota_venta',
        total: 63,
        offlineId: 'offline_force_backoff',
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      syncMocks.createSaleTransactionImpl.mockRejectedValueOnce(new Error('network timeout'));
      const firstRun = await processOfflineQueue('acc-1');
      expect(firstRun.retried).toBe(1);

      // Without force, nextRetryAt defers processing
      const skippedRun = await processOfflineQueue('acc-1');
      expect(skippedRun.processed).toBe(0);

      // With force: true, processes immediately despite future nextRetryAt
      syncMocks.createSaleTransactionImpl.mockResolvedValueOnce({ saleId: 'srv-1' });
      const forcedRun = await processOfflineQueue({ accountId: 'acc-1', force: true });
      warnSpy.mockRestore();

      expect(forcedRun.processed).toBe(1);
      expect(forcedRun.successful).toBe(1);
      expect(await getOfflineQueue()).toHaveLength(0);
    });

    it('cancels pending offline sale and notifies subscribers', async () => {
      await enqueueOfflineSale({
        accountId: 'acc-1',
        branchId: 'b-1',
        userId: 'user-1',
        userName: 'Cajero',
        items: [{ productId: 'p1', name: 'Item', price: 10, quantity: 1 }],
        paymentMethod: 'cash',
        documentType: 'nota_venta',
        total: 10,
        offlineId: 'offline_cancel_me',
      });

      const events: OfflineQueueChangeEvent[] = [];
      const unsub = subscribeOfflineQueueChanges((ev) => events.push(ev));
      const cancelled = await cancelPendingOfflineSale('offline_cancel_me');
      unsub();

      expect(cancelled).toBe(true);
      expect(await getOfflineQueue()).toHaveLength(0);
      expect(events.some((e) => e.queueCount === 0)).toBe(true);
    });

    it('reassigns sessionId when retryQuarantinedSale is called with newSessionId', async () => {
      await enqueueOfflineSale({
        accountId: 'acc-1',
        branchId: 'b-1',
        userId: 'user-1',
        userName: 'Cajero',
        sessionId: 'sess-closed',
        items: [{ productId: 'p1', name: 'Item', price: 20, quantity: 1 }],
        paymentMethod: 'cash',
        documentType: 'nota_venta',
        total: 20,
        offlineId: 'offline_quarantine_sess',
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      syncMocks.createSaleTransactionImpl.mockRejectedValueOnce(
        new Error('La sesión de caja ya se encuentra cerrada')
      );
      const runRes = await processOfflineQueue('acc-1');
      warnSpy.mockRestore();
      expect(runRes.quarantined).toBe(1);

      const quar = await getQuarantinedSalesForIdentity('user-1', 'acc-1');
      expect(quar).toHaveLength(1);
      expect(quar[0].failureCategory).toBe('cash_session_invalid');

      const requeued = await retryQuarantinedSale('offline_quarantine_sess', {
        newSessionId: 'sess-new-open',
        accountId: 'acc-1',
      });
      expect(requeued).toBe(true);

      const queueAfter = await getOfflineQueue();
      expect(queueAfter).toHaveLength(1);
      expect(queueAfter[0].salePayload.sessionId).toBe('sess-new-open');
      expect(await getQuarantinedSalesForIdentity('user-1', 'acc-1')).toHaveLength(0);
    });

    it('enqueues, scopes by identity, and cancels offline inventory operations', async () => {
      const op = await enqueueOfflineStockAdjust({
        accountId: 'acc-1',
        userId: 'user-1',
        branchId: 'b-1',
        branchName: 'Principal',
        productId: 'prod-1',
        productName: 'Gaseosa',
        mode: 'add',
        amount: 5,
        expectedBeforeStock: 10,
        reason: 'Ingreso',
      });

      expect(await getOfflineInventoryQueueForIdentity('user-1', 'acc-1')).toHaveLength(1);
      expect(await getOfflineInventoryQueueForIdentity('other-user', 'acc-1')).toHaveLength(0);
      expect(op.type).toBe('stock_adjust');

      const removed = await cancelPendingInventoryOp(op.offlineOpId);
      expect(removed).toBe(true);
      expect(await getOfflineInventoryQueueForIdentity('user-1', 'acc-1')).toHaveLength(0);
    });
  });
});
