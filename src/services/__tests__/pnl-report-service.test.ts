import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest, getDocsMock } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  getDocsMock: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiRequest }));
vi.mock('@/lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ name })),
  query: vi.fn((...args: unknown[]) => args),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  orderBy: vi.fn((field: string, dir: string) => ({ field, dir })),
  getDocs: getDocsMock,
  Timestamp: { fromMillis: vi.fn((ms: number) => ({ ms })) },
}));
vi.mock('expo-print', () => ({ printToFileAsync: vi.fn() }));
vi.mock('expo-sharing', () => ({ shareAsync: vi.fn() }));

import { generatePnlReport } from '../pnl-report-service';

const report = {
  salesClosed: 100,
  fiadosIssued: 40,
  returns: 10,
  accruedSales: 130,
  cmv: 70,
  grossProfit: 60,
  cashOperatingExpenses: 5,
  operatingExpenses: 20,
  terminalCommissions: 3,
  badDebt: 12,
  employeeAdvances: 9,
  netProfit: 40,
  fromMs: 1_700_000_000_000,
  toMs: 1_700_086_400_000,
  generatedAt: 1_700_090_000_000,
  branchId: 'branch-1',
};

const makeSnap = (rows: Array<{ id: string; data: Record<string, any> }>) => ({
  docs: rows.map((row) => ({
    id: row.id,
    data: () => row.data,
  })),
});

beforeEach(() => {
  apiRequest.mockReset();
  getDocsMock.mockReset();
});

describe('shared canonical P&L report', () => {
  it('uses the authenticated report API and falls back cleanly when Firestore detail queries throw', async () => {
    apiRequest.mockResolvedValue(report);
    getDocsMock.mockRejectedValue(new Error('Missing composite index'));

    const result = await generatePnlReport({
      accountId: 'account-1',
      branchId: 'branch-1',
      startDate: report.fromMs,
      endDate: report.toMs,
    });

    expect(apiRequest).toHaveBeenCalledWith(expect.stringContaining('/api/reports/pnl?'));
    expect(apiRequest.mock.calls[0][0]).toContain('branchId=branch-1');
    expect(result).toMatchObject({
      grossSales: 140,
      salesClosed: 100,
      fiadosIssued: 40,
      returns: 10,
      netRevenue: 130,
      badDebt: 12,
      cashOperatingExpenses: 5,
      terminalCommissions: 3,
      employeeAdvances: 9,
      operatingExpenses: 20,
      detailsAvailable: false,
    });
    expect(result.paymentBreakdown).toBeUndefined();
    expect(result.topProductsByProfit).toBeUndefined();
    expect(result.topProductsByRevenue).toBeUndefined();
    expect(result.sellerPerformance).toBeUndefined();
    expect(result.expenseBreakdown).toBeUndefined();
    expect(result.payrollExpenses).toBeUndefined();
  });

  it('aggregates real payment, product, seller, and expense breakdowns when Firestore queries succeed', async () => {
    apiRequest.mockResolvedValue(report);

    const salesRows = [
      {
        id: 'sale-1',
        data: {
          status: 'completed',
          branchId: 'branch-1',
          total: 100,
          sellerId: 'seller-1',
          sellerName: 'Ana Ventas',
          payments: [
            { category: 'digital', digitalProvider: 'yape', amount: 60 },
            { category: 'card', amount: 40 },
          ],
          items: [
            { productId: 'prod-1', name: 'Café Molido', sku: 'CAF-1', quantity: 2, price: 50 },
          ],
        },
      },
      {
        id: 'sale-2',
        data: {
          status: 'completed',
          branchId: 'branch-1',
          total: 60,
          paymentMethod: 'efectivo',
          cashierId: 'cashier-1',
          cashierName: 'Luis Caja',
          items: [
            {
              productId: 'prod-2',
              name: 'Pack Azúcar',
              quantity: 1,
              presentationQty: 2,
              price: 60,
              costPrice: 10,
            },
          ],
        },
      },
      {
        id: 'sale-return',
        data: {
          status: 'completed',
          isReturn: true,
          branchId: 'branch-1',
          total: 25,
          refundAmount: 25,
          sellerId: 'seller-1',
          sellerName: 'Ana Ventas',
          items: [
            { productId: 'prod-1', name: 'Café Molido', quantity: 0.5, price: 50 },
          ],
        },
      },
      {
        id: 'sale-deposit-ignored',
        data: {
          status: 'completed',
          isDepositPayment: true,
          branchId: 'branch-1',
          total: 30,
          paymentMethod: 'efectivo',
          items: [{ productId: 'prod-1', name: 'Café Molido', quantity: 1, price: 30 }],
        },
      },
      {
        id: 'sale-cancelled-ignored',
        data: {
          status: 'cancelled',
          branchId: 'branch-1',
          total: 99,
          paymentMethod: 'efectivo',
          items: [{ productId: 'prod-1', name: 'Café Molido', quantity: 2, price: 49.5 }],
        },
      },
      {
        id: 'sale-staff-consumption',
        data: {
          status: 'completed',
          isStaffConsumption: true,
          branchId: 'branch-1',
          total: 20,
          paymentMethod: 'plin',
          sellerId: 'seller-1',
          sellerName: 'Ana Ventas',
          items: [],
        },
      },
    ];

    const reservationRows = [
      {
        id: 'res-fiado-1',
        data: {
          type: 'fiado',
          isCreditSale: true,
          status: 'pending',
          branchId: 'branch-1',
          total: 40,
          sellerId: 'seller-2',
          sellerName: 'Carla Crédito',
          items: [
            { productId: 'prod-2', name: 'Pack Azúcar', quantity: 1, price: 40, costPrice: 15 },
          ],
        },
      },
      {
        id: 'res-regular-ignored',
        data: {
          type: 'reservation',
          isCreditSale: false,
          status: 'pending',
          branchId: 'branch-1',
          total: 500,
          items: [{ productId: 'prod-1', name: 'Café Molido', quantity: 10, price: 50 }],
        },
      },
    ];

    const movementRows = [
      {
        id: 'mov-rent',
        data: {
          type: 'expense',
          category: 'rent',
          expenseCategoryId: 'rent',
          amount: -5,
        },
      },
      {
        id: 'mov-advance-excluded',
        data: {
          type: 'expense',
          category: 'payroll_advance',
          expenseCategoryId: 'employee_advance',
          isEmployeeAdvance: true,
          amount: -9,
        },
      },
      {
        id: 'mov-income-excluded',
        data: {
          type: 'income',
          category: 'manual_income',
          amount: 50,
        },
      },
    ];

    getDocsMock
      .mockResolvedValueOnce(makeSnap(salesRows))
      .mockResolvedValueOnce(makeSnap(reservationRows))
      .mockResolvedValueOnce(makeSnap(movementRows));

    const productsMap = {
      'prod-1': {
        id: 'prod-1',
        name: 'Café Molido',
        costPrice: 30,
        branchPricing: { 'branch-1': { costPrice: 20 } },
      } as any,
    };

    const result = await generatePnlReport({
      accountId: 'account-1',
      branchId: 'branch-1',
      startDate: report.fromMs,
      endDate: report.toMs,
      productsMap,
    });

    expect(result.detailsAvailable).toBe(true);
    // 4 non-return valid docs: sale-1, sale-2, sale-staff-consumption, res-fiado-1
    expect(result.transactionCount).toBe(4);

    // Payment breakdown: cash=60, yape=60, card=40, plin=20, fiado=40 -> total=220
    expect(result.paymentBreakdown).toEqual({
      cash: { amount: 60, percentage: 27.27 },
      yape: { amount: 60, percentage: 27.27 },
      plin: { amount: 20, percentage: 9.09 },
      card: { amount: 40, percentage: 18.18 },
      transfer: { amount: 0, percentage: 0 },
      fiado: { amount: 40, percentage: 18.18 },
      other: { amount: 0, percentage: 0 },
      total: 220,
    });

    // Top products:
    // prod-2: qty 2 (1 + 1), rev 60 + 40 = 100, cogs (10*2 + 15*1) = 35, profit = 65, margin = 65%
    // prod-1: qty 1.5 (2 - 0.5), rev 100 - 25 = 75, cogs (20*2 - 20*0.5) = 30, profit = 45, margin = 60%
    expect(result.topProductsByRevenue?.map((p) => p.productId)).toEqual(['prod-2', 'prod-1']);
    expect(result.topProductsByProfit?.map((p) => p.productId)).toEqual(['prod-2', 'prod-1']);
    expect(result.topProductsByProfit?.[0]).toMatchObject({
      productId: 'prod-2',
      quantitySold: 2,
      revenue: 100,
      cogs: 35,
      profit: 65,
      marginPercent: 65,
    });
    expect(result.topProductsByProfit?.[1]).toMatchObject({
      productId: 'prod-1',
      sku: 'CAF-1',
      quantitySold: 1.5,
      revenue: 75,
      cogs: 30,
      profit: 45,
      marginPercent: 60,
    });

    // Sellers (sorted by revenue desc; staff consumption excluded):
    // seller-1 (Ana): rev 100 - 25 = 75, cogs 40 - 10 = 30, profit 45, tx 1
    // cashier-1 (Luis): rev 60, cogs 20, profit 40, tx 1
    // seller-2 (Carla): rev 40, cogs 15, profit 25, tx 1
    expect(result.sellerPerformance).toEqual([
      {
        sellerId: 'seller-1',
        sellerName: 'Ana Ventas',
        transactionsCount: 1,
        revenue: 75,
        cogs: 30,
        profit: 45,
        marginPercent: 60,
      },
      {
        sellerId: 'cashier-1',
        sellerName: 'Luis Caja',
        transactionsCount: 1,
        revenue: 60,
        cogs: 20,
        profit: 40,
        marginPercent: 66.67,
      },
      {
        sellerId: 'seller-2',
        sellerName: 'Carla Crédito',
        transactionsCount: 1,
        revenue: 40,
        cogs: 15,
        profit: 25,
        marginPercent: 62.5,
      },
    ]);

    // Expenses: rent=5, terminal_commissions=3, bad_debt=12 -> total=20
    expect(result.expensesByCategory).toEqual({
      rent: 5,
      terminal_commissions: 3,
      bad_debt: 12,
    });
    expect(result.expenseBreakdown).toEqual([
      { category: 'bad_debt', label: 'Cuentas Incobrables (Castigos)', amount: 12, percentage: 60 },
      { category: 'rent', label: 'Alquiler', amount: 5, percentage: 25 },
      { category: 'terminal_commissions', label: 'Comisiones POS / Pasarela', amount: 3, percentage: 15 },
    ]);
  });

  it('fails visibly when the server omits a canonical financial value', async () => {
    const { salesClosed: _unused, ...missingSalesClosed } = report;
    apiRequest.mockResolvedValue(missingSalesClosed);
    await expect(
      generatePnlReport({
        accountId: 'account-1',
        startDate: report.fromMs,
        endDate: report.toMs,
      })
    ).rejects.toThrow('salesClosed');
  });
});
