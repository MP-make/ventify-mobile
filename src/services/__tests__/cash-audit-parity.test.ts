import { describe, expect, it, vi } from 'vitest';
import { getDocs } from 'firebase/firestore';

vi.mock('@/lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(), doc: vi.fn(), addDoc: vi.fn(), runTransaction: vi.fn(), serverTimestamp: vi.fn(),
  query: vi.fn(), where: vi.fn(), orderBy: vi.fn(), getDocs: vi.fn(), getDoc: vi.fn(),
  onSnapshot: vi.fn(), limit: vi.fn(), Timestamp: class Timestamp {},
}));

import { calculateCashAudit, getSessionMovements } from '../cash-register-service';

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1', accountId: 'account-1', branchId: 'branch-1', initialAmount: 20,
  openingBalance: 20, status: 'open', ...overrides,
}) as any;

const movement = (overrides: Record<string, unknown> = {}) => ({
  id: 'movement-1', sessionId: 'session-1', amount: -100, category: 'sale_refund',
  method: 'Efectivo', saleId: 'sale-1', ...overrides,
}) as any;

describe('calculateCashAudit parity', () => {
  it('does not subtract a cancellation refund after excluding its cancelled cash sale', () => {
    const audit = calculateCashAudit(session(), [movement({ type: 'expense', category: 'refund' })], [
      { id: 'sale-1', sessionId: 'session-1', status: 'cancelled', paymentMethod: 'efectivo', total: 100 },
    ]);

    expect(audit.cashSales).toBe(0);
    expect(audit.cashRefunds).toBe(0);
    expect(audit.expectedCashInDrawer).toBe(20);
  });

  it('subtracts a canonical cash sale_refund once even when its movement has no type', () => {
    const audit = calculateCashAudit(session(), [movement({ amount: -30 })], [
      { id: 'sale-1', sessionId: 'session-1', status: 'completed', paymentMethod: 'efectivo', total: 100 },
    ]);

    expect(audit.cashSales).toBe(100);
    expect(audit.cashRefunds).toBe(30);
    expect(audit.expectedCashInDrawer).toBe(90);
  });

  it('excludes deposit payments from commercial sales while including their cash in the drawer', () => {
    const audit = calculateCashAudit(session({ cashReservationDeposits: 25 }), [], [
      { id: 'deposit-1', sessionId: 'session-1', status: 'completed', isDepositPayment: true, paymentMethod: 'efectivo', total: 25, depositInfo: { type: 'reservation', depositAmount: 25 } },
      { id: 'sale-2', sessionId: 'session-1', status: 'completed', paymentMethod: 'efectivo', total: 40 },
    ]);

    expect(audit.cashSales).toBe(40);
    expect(audit.totalSales).toBe(40);
    expect(audit.salesCount).toBe(1);
    expect(audit.expectedCashInDrawer).toBe(85);
  });

  it('does not count noncash deposits or deposit refunds as physical cash', () => {
    const audit = calculateCashAudit(session({ digitalReservationDeposits: 25 }), [
      movement({ amount: -25, category: 'reservation_refund', method: 'Yape', saleId: undefined }),
    ], [
      { id: 'deposit-1', sessionId: 'session-1', status: 'completed', isDepositPayment: true, paymentMethod: 'yape', total: 25, depositInfo: { type: 'reservation', depositAmount: 25 } },
    ]);

    expect(audit.cashSales).toBe(0);
    expect(audit.cashRefunds).toBe(0);
    expect(audit.expectedCashInDrawer).toBe(20);
  });

  it('counts a completed sale carrying depositInfo only for the remaining amount collected now', () => {
    const audit = calculateCashAudit(session(), [], [
      { id: 'sale-1', sessionId: 'session-1', status: 'completed', paymentMethod: 'efectivo', total: 150, amountReceived: null, chargedAmount: null, depositInfo: { type: 'reservation', depositAmount: 100, remainingAmount: 50, depositSessionId: 'old-session' } },
    ]);

    expect(audit.cashSales).toBe(50);
    expect(audit.totalSales).toBe(50);
    expect(audit.expectedCashInDrawer).toBe(70);
  });

  it('does not subtract a digital sale refund from physical cash', () => {
    const audit = calculateCashAudit(session(), [
      movement({ amount: -30, method: 'Yape' }),
    ], [
      { id: 'sale-1', sessionId: 'session-1', status: 'completed', paymentMethod: 'yape', total: 100 },
    ]);

    expect(audit.cashRefunds).toBe(0);
    expect(audit.expectedCashInDrawer).toBe(20);
  });

  it('keeps cash in the drawer when a cash deposit is refunded by card', () => {
    const audit = calculateCashAudit(session({ cashReservationDeposits: 0 }), [
      movement({ amount: 0, refundAmount: 100, category: 'reservation_refund', method: 'Tarjeta', originalPaymentMethod: 'Efectivo', saleId: undefined }),
    ], []);

    expect(audit.cashRefunds).toBe(0);
    expect(audit.expectedCashInDrawer).toBe(120);
  });

  it('subtracts cash when a digital deposit is refunded in cash', () => {
    const audit = calculateCashAudit(session({ cashReservationDeposits: 0, digitalReservationDeposits: 0 }), [
      movement({ amount: -100, refundAmount: 100, category: 'reservation_refund', method: 'Efectivo', originalPaymentMethod: 'Yape', saleId: undefined }),
    ], []);

    expect(audit.cashRefunds).toBe(100);
    expect(audit.expectedCashInDrawer).toBe(-80);
  });

  it('preserves refund metadata needed to resolve the physical method', async () => {
    vi.mocked(getDocs).mockResolvedValueOnce({
      docs: [{ id: 'refund-1', data: () => ({ sessionId: 'session-1', accountId: 'account-1', branchId: 'branch-1', amount: 0, method: 'Tarjeta', paymentMethod: 'Tarjeta', originalPaymentMethod: 'Efectivo', refundAmount: 100, saleId: 'sale-1', category: 'reservation_refund' }) }],
    } as any);

    const movements = await getSessionMovements('account-1', 'branch-1', 'session-1');

    expect(movements[0]).toMatchObject({
      method: 'Tarjeta', paymentMethod: 'Tarjeta', originalPaymentMethod: 'Efectivo',
      refundAmount: 100, saleId: 'sale-1', category: 'reservation_refund',
    });
  });

  it('propagates movement query failures so a close cannot audit an empty movement list', async () => {
    const queryError = new Error('Firestore unavailable');
    vi.mocked(getDocs).mockRejectedValueOnce(queryError);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getSessionMovements('account-1', 'branch-1', 'session-1')).rejects.toBe(queryError);

    logError.mockRestore();
  });

  it('uses the charged amount, including a customer surcharge, for drawer cash', () => {
    const audit = calculateCashAudit(session(), [], [
      { id: 'sale-1', sessionId: 'session-1', status: 'completed', paymentMethod: 'efectivo', total: 100, amountReceived: null, chargedAmount: 105, surchargeAmount: 5 },
    ]);

    expect(audit.cashSales).toBe(105);
    expect(audit.expectedCashInDrawer).toBe(125);
  });
});
