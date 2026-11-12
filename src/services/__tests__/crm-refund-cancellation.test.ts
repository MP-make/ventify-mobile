import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ docs: new Map<string, any>(), serial: 0, afterQuery: undefined as (() => void) | undefined }));

vi.mock('@/lib/firebase', () => ({ db: {}, auth: { currentUser: { uid: 'u1' } } }));
vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  collection: (_db: any, name: string) => ({ name }),
  doc: (source: any, name?: string, id?: string) => {
    if (typeof source?.name === 'string') return { path: `${source.name}/generated-${++fake.serial}` };
    return { path: `${name}/${id}` };
  },
  query: (source: any, ...constraints: any[]) => ({ source, constraints }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  limit: (value: number) => ({ limit: value }),
  getDocs: async (query: any) => {
    const filters = query.constraints.filter((c: any) => c.field);
    const docs = [...fake.docs.entries()]
      .filter(([path]) => path.startsWith(`${query.source.name}/`))
      .filter(([, data]) => filters.every((filter: any) => data[filter.field] === filter.value))
      .map(([path, data]) => ({ id: path.split('/').at(-1), ref: { path }, exists: () => true, data: () => structuredClone(data) }));
    const snapshot = { docs, empty: docs.length === 0 };
    const afterQuery = fake.afterQuery;
    fake.afterQuery = undefined;
    afterQuery?.();
    return snapshot;
  },
  serverTimestamp: () => 'server-now',
  runTransaction: async (_db: any, callback: any) => {
    let written = false;
    const pending: Array<() => void> = [];
    await callback({
      get: async (ref: any) => {
        if (written) throw new Error('read after write');
        const data = fake.docs.get(ref.path);
        return { exists: () => Boolean(data), data: () => structuredClone(data) };
      },
      update: (ref: any, fields: any) => {
        written = true;
        pending.push(() => {
          const current = structuredClone(fake.docs.get(ref.path));
          for (const [key, value] of Object.entries(fields)) {
            const parts = key.split('.');
            let node = current;
            for (const part of parts.slice(0, -1)) node = node[part] ||= {};
            node[parts.at(-1)!] = value;
          }
          fake.docs.set(ref.path, current);
        });
      },
      set: (ref: any, data: any) => {
        written = true;
        pending.push(() => fake.docs.set(ref.path, structuredClone(data)));
      },
    });
    pending.forEach((apply) => apply());
  },
}));

import { completeOrCancelReservation } from '../crm-operations-service';

const actor = { uid: 'u1', displayName: 'Operador' };
const reservation = {
  id: 'r1', type: 'reservation', accountId: 'a1', branchId: 'b1',
  items: [{ id: 'p1', quantity: 1, price: 10 }], total: 100, depositAmount: 100,
} as any;

describe('CRM cancellation deposit refunds', () => {
  beforeEach(() => {
    fake.docs.clear();
    fake.serial = 0;
    fake.afterQuery = undefined;
    fake.docs.set('reservations/r1', {
      accountId: 'a1', branchId: 'b1', status: 'pending', attributionVersion: 1,
      items: [{ id: 'p1', quantity: 1, price: 10 }], total: 100, depositAmount: 100,
    });
    fake.docs.set('products/p1', { accountId: 'a1', stock: { b1: 10 }, reservedStock: { b1: 1 } });
    fake.docs.set('reservation_deposits/d1', {
      reservationId: 'r1', accountId: 'a1', branchId: 'b1', amount: 100,
      paymentMethod: 'efectivo', status: 'active', refundable: true, refundedAmount: 20,
    });
    fake.docs.set('cash_register_sessions/s1', {
      accountId: 'a1', branchId: 'b1', status: 'open', expectedAmount: 300,
      totalReservationDeposits: 100, reservationDepositsCount: 1, cashReservationDeposits: 100,
    });
  });

  it('atomically refunds the selected percentage in cash and releases stock', async () => {
    await completeOrCancelReservation(reservation, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'efectivo', refundPercent: 25,
    });

    expect(fake.docs.get('reservation_deposits/d1')).toMatchObject({ status: 'active', refundedAmount: 45, refundMethod: 'efectivo' });
    expect(fake.docs.get('cash_register_sessions/s1')).toMatchObject({
      expectedAmount: 275, totalReservationDeposits: 75, reservationDepositsCount: 1, cashReservationDeposits: 75,
    });
    expect(fake.docs.get('cash_register_movements/generated-1')).toMatchObject({
      sessionId: 's1', accountId: 'a1', branchId: 'b1', amount: -25, refundAmount: 25, category: 'reservation_refund',
    });
    expect(fake.docs.get('products/p1')?.reservedStock.b1).toBe(0);
    expect(fake.docs.get('reservations/r1')?.status).toBe('cancelled');
  });

  it('keeps the deposit and leaves cash counters alone when no refund method is selected', async () => {
    await completeOrCancelReservation(reservation, 'cancel', actor);

    expect(fake.docs.get('reservation_deposits/d1')?.status).toBe('active');
    expect(fake.docs.get('cash_register_sessions/s1')?.expectedAmount).toBe(300);
    expect([...fake.docs.keys()].filter((path) => path.startsWith('cash_register_movements/'))).toHaveLength(0);
  });

  it('records a full non-cash refund without reducing expected cash', async () => {
    fake.docs.set('reservation_deposits/d1', {
      ...fake.docs.get('reservation_deposits/d1'), paymentMethod: 'tarjeta', refundedAmount: 0,
    });
    fake.docs.set('cash_register_sessions/s1', {
      ...fake.docs.get('cash_register_sessions/s1'), cardReservationDeposits: 100,
    });
    await completeOrCancelReservation(reservation, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'tarjeta', refundPercent: 100,
    });

    expect(fake.docs.get('reservation_deposits/d1')).toMatchObject({ status: 'refunded', refundedAmount: 100 });
    expect(fake.docs.get('cash_register_sessions/s1')).toMatchObject({
      expectedAmount: 300, totalReservationDeposits: 0, reservationDepositsCount: 0, cardReservationDeposits: 0,
    });
    expect(fake.docs.get('cash_register_movements/generated-1')).toMatchObject({ amount: 0, refundAmount: 100, method: 'tarjeta' });
  });

  it('rejects cash refunds above the session expected amount without partial writes', async () => {
    fake.docs.set('cash_register_sessions/s1', { ...fake.docs.get('cash_register_sessions/s1'), expectedAmount: 10 });
    await expect(completeOrCancelReservation(reservation, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'efectivo', refundPercent: 50,
    })).rejects.toThrow(/efectivo esperado/);
    expect(fake.docs.get('reservations/r1')?.status).toBe('pending');
    expect(fake.docs.get('reservation_deposits/d1')?.refundedAmount).toBe(20);
  });

  it('revalidates deposit ownership and reservation link inside the transaction', async () => {
    fake.afterQuery = () => fake.docs.set('reservation_deposits/d1', {
      ...fake.docs.get('reservation_deposits/d1'), accountId: 'other-account',
    });
    await expect(completeOrCancelReservation(reservation, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'efectivo', refundPercent: 25,
    })).rejects.toThrow();
    expect(fake.docs.get('reservations/r1')?.status).toBe('pending');
    expect(fake.docs.get('products/p1')?.reservedStock.b1).toBe(1);
  });

  it('rejects NaN or out-of-range refund percentages before writing', async () => {
    for (const refundPercent of [Number.NaN, 101, 0]) {
      await expect(completeOrCancelReservation(reservation, 'cancel', actor, {
        sessionId: 's1', refundMethod: 'efectivo', refundPercent,
      })).rejects.toThrow();
      expect(fake.docs.get('reservations/r1')?.status).toBe('pending');
      expect(fake.docs.get('reservation_deposits/d1')?.refundedAmount).toBe(20);
    }
  });

  it('records a manual cash movement for a legacy order deposit with no order_deposits record', async () => {
    fake.docs.set('orders/r1', {
      accountId: 'a1', branchId: 'b1', status: 'pending', items: [], total: 100, depositAmount: 100,
    });
    fake.docs.delete('reservation_deposits/d1');
    await completeOrCancelReservation({ ...reservation, type: 'order' }, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'efectivo', refundPercent: 25,
    });
    expect(fake.docs.get('cash_register_sessions/s1')?.expectedAmount).toBe(275);
    expect(fake.docs.get('cash_register_movements/generated-1')).toMatchObject({ amount: -25, refundAmount: 25, category: 'efectivo' });
    expect(fake.docs.get('orders/r1')?.status).toBe('cancelled');
  });

  it('keeps expected cash unchanged for a non-cash refund on a legacy order', async () => {
    fake.docs.set('orders/r1', {
      accountId: 'a1', branchId: 'b1', status: 'pending', items: [], total: 100, depositAmount: 100,
    });
    fake.docs.delete('reservation_deposits/d1');
    await completeOrCancelReservation({ ...reservation, type: 'order' }, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'tarjeta', refundPercent: 25,
    });
    expect(fake.docs.get('cash_register_sessions/s1')?.expectedAmount).toBe(300);
    expect(fake.docs.get('cash_register_sessions/s1')?.auditRevision).toBe(1);
    expect(fake.docs.get('cash_register_movements/generated-1')).toMatchObject({ amount: 0, refundAmount: 25, category: 'tarjeta' });
  });

  it('rejects a legacy order cash refund when expected cash is insufficient', async () => {
    fake.docs.set('orders/r1', {
      accountId: 'a1', branchId: 'b1', status: 'pending', items: [], total: 100, depositAmount: 100,
    });
    fake.docs.delete('reservation_deposits/d1');
    fake.docs.set('cash_register_sessions/s1', { ...fake.docs.get('cash_register_sessions/s1'), expectedAmount: 10 });
    await expect(completeOrCancelReservation({ ...reservation, type: 'order' }, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'efectivo', refundPercent: 25,
    })).rejects.toThrow(/efectivo esperado/);
    expect(fake.docs.get('orders/r1')?.status).toBe('pending');
    expect([...fake.docs.keys()].filter((path) => path.startsWith('cash_register_movements/'))).toHaveLength(0);
  });

  it('does not mutate cancellation or deposit when cash session is closed or deposit is non-refundable', async () => {
    fake.docs.set('cash_register_sessions/s1', { ...fake.docs.get('cash_register_sessions/s1'), status: 'closed' });
    await expect(completeOrCancelReservation(reservation, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'cash', refundPercent: 100,
    })).rejects.toThrow();
    expect(fake.docs.get('reservations/r1')?.status).toBe('pending');
    expect(fake.docs.get('reservation_deposits/d1')?.status).toBe('active');

    fake.docs.set('cash_register_sessions/s1', { ...fake.docs.get('cash_register_sessions/s1'), status: 'open' });
    fake.docs.set('reservation_deposits/d1', { ...fake.docs.get('reservation_deposits/d1'), refundable: false });
    await expect(completeOrCancelReservation(reservation, 'cancel', actor, {
      sessionId: 's1', refundMethod: 'cash', refundPercent: 100,
    })).rejects.toThrow();
    expect(fake.docs.get('reservations/r1')?.status).toBe('pending');
  });
});
