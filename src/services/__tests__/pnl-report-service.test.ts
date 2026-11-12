import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiRequest }));
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

beforeEach(() => apiRequest.mockReset());

describe('shared canonical P&L report', () => {
  it('uses the authenticated report API and exposes its real accrued metrics without fabricating details', async () => {
    apiRequest.mockResolvedValue(report);
    const result = await generatePnlReport({
      accountId: 'account-1', branchId: 'branch-1', startDate: report.fromMs, endDate: report.toMs,
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
    expect(result.payrollExpenses).toBeUndefined();
  });

  it('fails visibly when the server omits a canonical financial value', async () => {
    const { salesClosed: _unused, ...missingSalesClosed } = report;
    apiRequest.mockResolvedValue(missingSalesClosed);
    await expect(generatePnlReport({
      accountId: 'account-1', startDate: report.fromMs, endDate: report.toMs,
    })).rejects.toThrow('salesClosed');
  });
});
