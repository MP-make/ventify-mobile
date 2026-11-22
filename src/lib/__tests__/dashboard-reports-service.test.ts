import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: {
    uid: 'user-1',
    getIdToken: vi.fn(async () => 'firebase-jwt-token'),
  } as any,
  fileSystem: {
    cacheDirectory: 'file:///tmp/cache/',
    documentDirectory: 'file:///tmp/docs/',
    downloadAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
    deleteAsync: vi.fn(async () => {}),
  },
  sharing: {
    isAvailableAsync: vi.fn(async () => true),
    shareAsync: vi.fn(async () => {}),
  },
}));

vi.mock('@/lib/firebase', () => ({
  auth: {
    get currentUser() {
      return state.user;
    },
  },
  APP_URL: 'https://ventify.test',
  db: {},
}));

vi.mock('expo-file-system', () => state.fileSystem);
vi.mock('expo-sharing', () => state.sharing);

import {
  aggregatePeriodSalesSummary,
  calculateVariationPercent,
  downloadAndShareExportFile,
  emitEinvoiceDocument,
  fetchEinvoices,
  fetchInventoryIntelligence,
  fetchPeriodComparison,
  fetchSellerPerformanceReport,
  getDateRangeBounds,
  retryEinvoiceDocument,
  summarizeEinvoices,
} from '@/services/dashboard-reports-service';
import { ApiError } from '@/lib/api-client';
import { clearRequestCache } from '@/lib/request-cache';

describe('dashboard-reports-service', () => {
  beforeEach(() => {
    clearRequestCache();
    state.user = {
      uid: 'user-1',
      getIdToken: vi.fn(async () => 'firebase-jwt-token'),
    };
    state.fileSystem.downloadAsync.mockReset();
    state.fileSystem.readAsStringAsync.mockReset();
    state.fileSystem.deleteAsync.mockReset();
    state.fileSystem.deleteAsync.mockResolvedValue(undefined);
    state.sharing.isAvailableAsync.mockReset();
    state.sharing.isAvailableAsync.mockResolvedValue(true);
    state.sharing.shareAsync.mockReset();
    state.sharing.shareAsync.mockResolvedValue(undefined);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('fetchPeriodComparison', () => {
    it('queries /api/dashboard/period-comparison with scoped branchId and parses comparison data', async () => {
      const payload = {
        previousTotal: 1850.5,
        previousTransactions: 22,
        trend: [120, 250, 310, 400, 190, 280, 330],
        generatedAt: 1700000000000,
      };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await fetchPeriodComparison('acc-1', 1000, 2000, 'branch-2');
      expect(res).toEqual(payload);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ventify.test/api/dashboard/period-comparison?accountId=acc-1&from=1000&to=2000&branchId=branch-2',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer firebase-jwt-token',
            'x-ventify-client': 'v3',
          }),
        })
      );
    });

    it('omits branchId when "all" is passed and rejects invalid time bounds', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ previousTotal: 0, previousTransactions: 0, trend: [], generatedAt: 1 }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await fetchPeriodComparison('acc-1', 1000, 2000, 'all');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ventify.test/api/dashboard/period-comparison?accountId=acc-1&from=1000&to=2000',
        expect.anything()
      );

      await expect(fetchPeriodComparison('acc-1', 5000, 2000)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('fetchInventoryIntelligence', () => {
    it('returns parsed GMROI, DSI, turnover and dead stock on HTTP 200', async () => {
      const payload = {
        gmroi: 2.34,
        dsi: 18.5,
        deadStockValue: 450.25,
        deadStockCount: 3,
        inventoryTurnover: 1.8,
      };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await fetchInventoryIntelligence('acc-1', 'branch-1');
      expect(res).toEqual(payload);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ventify.test/api/dashboard/inventory-intelligence?accountId=acc-1&branchId=branch-1',
        expect.anything()
      );
    });

    it('handles HTTP 503 building state gracefully using Retry-After header or fallback 5s', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: 'Analysis is being prepared' }), {
          status: 503,
          headers: { 'Retry-After': '9' },
        }))
      );

      const buildingWithHeader = await fetchInventoryIntelligence('acc-1');
      expect(buildingWithHeader).toEqual({ building: true, retryAfter: 9 });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: 'Analysis is being prepared' }), { status: 503 }))
      );

      const buildingDefault = await fetchInventoryIntelligence('acc-1');
      expect(buildingDefault).toEqual({ building: true, retryAfter: 5 });
    });

    it('propagates 403/500 errors as ApiError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
      );

      await expect(fetchInventoryIntelligence('acc-1')).rejects.toMatchObject({
        name: 'ApiError',
        status: 403,
        message: 'Forbidden',
      });
    });
  });

  describe('fetchSellerPerformanceReport', () => {
    it('calls /api/reports/sellers with business dates and branch filter', async () => {
      const payload = {
        report: {
          version: 1,
          rows: [{ sellerId: 's1', sellerName: 'Ana', gross: 500, refunds: 50, net: 450, salesCount: 4, participation: 100 }],
          totalGross: 500,
          totalRefunds: 50,
          totalNet: 450,
        },
        timeZone: 'America/Lima',
        from: 1000,
        to: 2000,
      };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await fetchSellerPerformanceReport('acc-1', '2026-11-01', '2026-11-16', 'b-1');
      expect(res.report.totalNet).toBe(450);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ventify.test/api/reports/sellers?fromDay=2026-11-01&toDay=2026-11-16&branchId=b-1',
        expect.anything()
      );
    });

    it('propagates 403 when seller attribution is disabled on the account', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ error: 'La función está desactivada.' }), { status: 403 }))
      );

      await expect(
        fetchSellerPerformanceReport('acc-1', '2026-11-01', '2026-11-16')
      ).rejects.toMatchObject({ status: 403, message: 'La función está desactivada.' });
    });
  });

  describe('SUNAT e-invoicing endpoints', () => {
    it('fetchEinvoices queries /api/invoicing/status and applies branch filter', async () => {
      const docs = [
        { id: 'e1', saleId: 's1', branchId: 'b1', documentType: '01', documentNumber: 'F001-0001', status: 'accepted', amount: 118, currency: 'PEN', createdAt: 100 },
        { id: 'e2', saleId: 's2', branchId: 'b2', documentType: '03', documentNumber: 'B001-0002', status: 'pending', amount: 50, currency: 'PEN', createdAt: 200 },
      ];
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, einvoices: docs }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const scoped = await fetchEinvoices('acc-1', { branchId: 'b1', from: '2026-11-01', to: '2026-11-16' });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].id).toBe('e1');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ventify.test/api/invoicing/status?accountId=acc-1&from=2026-11-01&to=2026-11-16&branchId=b1',
        expect.anything()
      );
    });

    it('retryEinvoiceDocument posts { accountId, id } to /api/invoicing/status', async () => {
      const updated = { id: 'e2', saleId: 's2', documentType: '03', documentNumber: 'B001-0002', status: 'accepted', amount: 50, currency: 'PEN', createdAt: 200 };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, einvoice: updated }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await retryEinvoiceDocument('acc-1', 'e2');
      expect(res.status).toBe('accepted');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ventify.test/api/invoicing/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ accountId: 'acc-1', id: 'e2' }),
        })
      );
    });

    it('emitEinvoiceDocument supports 01, 03, 07, 08 and replacement documents via POST /api/invoicing/emit', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            einvoice: { id: 'nc-1', saleId: 's1', documentType: '07', documentNumber: 'FC01-0001', status: 'accepted', amount: 118, currency: 'PEN', createdAt: 300 },
          }),
          { status: 200 }
        )
      );
      vi.stubGlobal('fetch', fetchMock);

      const ncRes = await emitEinvoiceDocument({
        accountId: 'acc-1',
        saleId: 's1',
        documentType: '07',
        reference: {
          type: '01',
          number: 'F001-0001',
          reasonCode: '01',
          reasonDescription: 'Anulación de la operación',
        },
      });
      expect(ncRes.documentType).toBe('07');

      await emitEinvoiceDocument({
        accountId: 'acc-1',
        saleId: 's1',
        documentType: '01',
        replacesInvoiceId: 'e1',
        creditNoteId: 'nc-1',
        customer: {
          identityType: '6',
          identityNumber: '20611526572',
          name: 'EMPRESA DEMO SAC',
        },
      });

      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://ventify.test/api/invoicing/emit',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"replacesInvoiceId":"e1"'),
        })
      );
    });
  });

  describe('downloadAndShareExportFile', () => {
    it('downloads binary/text export into cacheDirectory with auth headers and shares it', async () => {
      state.fileSystem.downloadAsync.mockResolvedValue({
        uri: 'file:///tmp/cache/ventas_202611.xlsx',
        status: 200,
      });

      const uri = await downloadAndShareExportFile(
        '/api/reports/export/sales?accountId=acc-1&from=2026-11-01&to=2026-11-16&format=xlsx',
        'ventas/202611.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      expect(uri).toBe('file:///tmp/cache/ventas_202611.xlsx');
      expect(state.fileSystem.downloadAsync).toHaveBeenCalledWith(
        'https://ventify.test/api/reports/export/sales?accountId=acc-1&from=2026-11-01&to=2026-11-16&format=xlsx',
        'file:///tmp/cache/ventas_202611.xlsx',
        {
          headers: expect.objectContaining({
            Authorization: 'Bearer firebase-jwt-token',
            'x-ventify-client': 'v3',
          }),
        }
      );
      expect(state.sharing.shareAsync).toHaveBeenCalledWith('file:///tmp/cache/ventas_202611.xlsx', {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dialogTitle: 'ventas_202611.xlsx',
      });
    });

    it('cleans up failed downloads and throws ApiError with server error message', async () => {
      state.fileSystem.downloadAsync.mockResolvedValue({
        uri: 'file:///tmp/cache/report.xlsx',
        status: 400,
      });
      state.fileSystem.readAsStringAsync.mockResolvedValue('{"error":"El Excel supera el límite de filas"}');

      await expect(
        downloadAndShareExportFile('/api/reports/export/sales?accountId=acc-1', 'report.xlsx', 'application/octet-stream')
      ).rejects.toThrowError(ApiError);

      expect(state.fileSystem.deleteAsync).toHaveBeenCalledWith('file:///tmp/cache/report.xlsx', { idempotent: true });
      expect(state.sharing.shareAsync).not.toHaveBeenCalled();
    });
  });

  describe('pure helpers', () => {
    it('computes range bounds, variations, sales summary, and einvoice summary accurately', () => {
      const refNow = new Date(2026, 10, 16, 14, 30, 0);
      const sevenDays = getDateRangeBounds('7d', refNow);
      expect(sevenDays.fromIso).toBe('2026-11-10');
      expect(sevenDays.toIso).toBe('2026-11-16');

      const month = getDateRangeBounds('month', refNow);
      expect(month.fromIso).toBe('2026-11-01');
      expect(month.toIso).toBe('2026-11-16');

      expect(calculateVariationPercent(150, 100)).toBe(50);
      expect(calculateVariationPercent(80, 100)).toBe(-20);
      expect(calculateVariationPercent(0, 0)).toBe(0);
      expect(calculateVariationPercent(100, 0)).toBeNull();

      const summary = aggregatePeriodSalesSummary([
        {
          id: 's1',
          total: 100,
          documentType: '03',
          paymentCategory: 'cash',
          customerName: 'Juan Pérez',
          items: [{ id: 'p1', name: 'Café', quantity: 2, price: 50, costPrice: 30 }],
        },
        {
          id: 's2',
          total: 200,
          documentType: '01',
          payments: [
            { category: 'digital', digitalProvider: 'yape', amount: 120 },
            { category: 'card', methodName: 'Tarjeta', amount: 80 },
          ],
          customerName: 'ACME SAC',
          items: [{ id: 'p2', name: 'Torta', quantity: 4, price: 50, costPrice: 25 }],
        },
        {
          id: 's3',
          total: 999,
          status: 'cancelled',
          items: [{ id: 'p2', name: 'Torta', quantity: 10, price: 99.9 }],
        },
        {
          id: 's4',
          total: 30,
          isReturn: true,
          refundAmount: 30,
          items: [{ id: 'p1', name: 'Café', quantity: 1, price: 30, costPrice: 15 }],
        },
      ]);

      expect(summary.grossRevenue).toBe(300);
      expect(summary.returnsTotal).toBe(30);
      expect(summary.totalRevenue).toBe(270);
      expect(summary.transactionCount).toBe(2);
      expect(summary.averageTicket).toBe(135);
      expect(summary.paymentDistribution.map((p) => [p.key, p.amount])).toEqual([
        ['yape', 120],
        ['cash', 100],
        ['card', 80],
      ]);
      expect(summary.topProducts[0].productId).toBe('p2');
      expect(summary.topCustomers[0].name).toBe('ACME SAC');

      const einvSummary = summarizeEinvoices([
        { documentType: '01', status: 'accepted', amount: 200 },
        { documentType: '03', status: 'accepted', amount: 150 },
        { documentType: '07', status: 'accepted', amount: 50 },
        { documentType: '01', status: 'rejected', amount: 900 },
      ]);
      expect(einvSummary.totalFacturado).toBe(300);
      expect(einvSummary.rejectedOrErrorCount).toBe(1);
    });
  });
});
