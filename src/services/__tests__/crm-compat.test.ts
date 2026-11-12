import { describe, expect, it } from 'vitest';
import { getDepositSessionUpdates, getHistoryDateBounds, normalizeOrderItems, toEpochMillis } from '../crm-compat';

describe('CRM cross-platform contracts', () => {
  it('normalizes reservation and order lines to Web id/name fields while preserving variant data', () => {
    expect(normalizeOrderItems([{
      productId: 'p1', productName: 'Harina', price: 3.5, quantity: 2,
      variantId: 'v1', presentationId: 'box',
    }])).toEqual([{
      productId: 'p1', productName: 'Harina', id: 'p1', name: 'Harina', price: 3.5,
      quantity: 2, variantId: 'v1', presentationId: 'box',
    }]);
  });

  it('credits order deposits to order buckets and cash only to drawer totals', () => {
    expect(getDepositSessionUpdates({ expectedAmount: 10, totalIncome: 2 }, 'order', 'efectivo', 12)).toEqual({
      totalOrderDeposits: 12, orderDepositsCount: 1, cashOrderDeposits: 12,
      expectedAmount: 22, totalIncome: 14,
    });
    expect(getDepositSessionUpdates({}, 'reservation', 'yape', 4)).toEqual({
      totalReservationDeposits: 4, reservationDepositsCount: 1, digitalReservationDeposits: 4,
    });
  });

  it('normalizes Firestore, ISO, second and millisecond dates', () => {
    expect(toEpochMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMillis({ seconds: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(toEpochMillis('2025-01-01T00:00:00Z')).toBe(Date.parse('2025-01-01T00:00:00Z'));
    expect(toEpochMillis('bad')).toBe(0);
  });

  it('builds inclusive date filters for today, month and custom ranges', () => {
    const now = new Date(2025, 3, 15, 12);
    expect(getHistoryDateBounds('today', '', '', now)).toEqual({
      start: new Date(2025, 3, 15).getTime(), end: new Date(2025, 3, 15, 23, 59, 59, 999).getTime(),
    });
    expect(getHistoryDateBounds('month', '', '', now).start).toBe(new Date(2025, 3, 1).getTime());
    expect(getHistoryDateBounds('custom', '2025-01-02', '2025-01-04', now)).toEqual({
      start: new Date(2025, 0, 2).getTime(), end: new Date(2025, 0, 4, 23, 59, 59, 999).getTime(),
    });
  });
});
