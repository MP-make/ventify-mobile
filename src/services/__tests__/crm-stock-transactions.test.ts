import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ docs: new Map<string, Record<string, any>>(), nextId: 0 }));

vi.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('firebase/firestore', () => {
  const path = (ref: any) => ref.path;
  const collection = (_db: unknown, name: string) => ({ name });
  const doc = (dbOrCollection: any, collectionName?: string, id?: string) => {
    if (typeof dbOrCollection?.name === 'string') {
      return { path: `${dbOrCollection.name}/${collectionName || `test-${++store.nextId}`}`, id: collectionName || `test-${store.nextId}` };
    }
    return { path: `${collectionName}/${id}`, id };
  };
  return {
    collection,
    doc,
    runTransaction: async (_db: unknown, callback: (tx: any) => Promise<unknown>) => {
      const pending: Array<() => void> = [];
      const result = await callback({
        get: async (ref: any) => {
          if (ref?.isQuery) throw new Error('Client transactions only accept document references');
          if (pending.length) throw new Error('Read after write');
          return { exists: () => store.docs.has(path(ref)), data: () => store.docs.get(path(ref)) };
        },
        set: (ref: any, data: Record<string, any>) => pending.push(() => store.docs.set(path(ref), data)),
        update: (ref: any, updates: Record<string, any>) => pending.push(() => {
          const current = store.docs.get(path(ref)) || {};
          const next = { ...current, ...updates };
          for (const [key, value] of Object.entries(updates)) {
            if (key.includes('.')) {
              const [parent, child] = key.split('.');
              next[parent] = { ...(current[parent] || {}), [child]: value };
            }
          }
          store.docs.set(path(ref), next);
        }),
      });
      pending.forEach((write) => write());
      return result;
    },
    serverTimestamp: () => 'server-time',
    query: (collection: any, ...constraints: unknown[]) => ({ isQuery: true, collection, constraints }),
    where: (...args: unknown[]) => args, orderBy: (...args: unknown[]) => ['__orderBy__',...args],
    getDocs: vi.fn(async (ref: any) => ({ docs: [...store.docs.entries()]
      .filter(([key, data]) => key.startsWith(`${ref.collection.name}/`) && ref.constraints.every(([field, op, value]: any[]) =>
        field === '__orderBy__' ? true : op === '==' ? data[field] === value : op === '>=' ? data[field] >= value : data[field] <= value))
      .map(([key, data]) => ({id:key.split('/')[1],data:()=>data})) })), setDoc: vi.fn(), updateDoc: vi.fn(),
  };
});

import { approveOrder, createReservationOrOrder } from '../crm-operations-service';

const profile = { uid: 'user-1', displayName: 'Cajero', email: 'cashier@example.test' } as any;

beforeEach(() => {
  store.docs.clear();
  store.nextId = 0;
  store.docs.set('products/p1', {
    id: 'p1', accountId: 'account-1', stock: { 'branch-1': 5 }, reservedStock: { 'branch-1': 1 },
    name: 'Arroz', costPrice: 2, minStock: 1,
  });
});

describe('CRM stock transactions with duplicate product lines', () => {
  it('reserves the sum of duplicate reservation lines with a single aggregate update', async () => {
    const first = await createReservationOrOrder({
      accountId: 'account-1', branchId: 'branch-1', type: 'reservation', depositAmount: 0,
      paymentMethod: 'efectivo', total: 20,
      customer: { name: 'Cliente' }, userProfile: profile,
      items: [
        { id: 'p1', name: 'Arroz', price: 10, quantity: 1, variantId: 'small' },
        { productId: 'p1', productName: 'Arroz', price: 10, quantity: 1, variantId: 'large' },
      ],
    });
    const second = await createReservationOrOrder({
      accountId: 'account-1', branchId: 'branch-1', type: 'reservation', depositAmount: 0,
      paymentMethod: 'efectivo', total: 10,
      customer: { name: 'Cliente' }, userProfile: profile,
      items: [{ id: 'p1', name: 'Arroz', price: 10, quantity: 1 }],
    });
    expect(store.docs.get('products/p1')?.reservedStock).toEqual({ 'branch-1': 4 });
    expect(store.docs.get(`reservations/${first}`)?.reservationNumber).toBe(1);
    expect(store.docs.get(`reservations/${first}`)?.attributionVersion).toBe(1);
    expect(store.docs.get(`reservations/${second}`)?.reservationNumber).toBe(2);
  });

  it('continues the Web daily reservation sequence from the highest existing number', async () => {
    const today = new Date();
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    store.docs.set('reservations/existing', { accountId: 'account-1', branchId: 'branch-1', date: dayStart + 1, reservationNumber: 8 });
    const createdId = await createReservationOrOrder({
      accountId: 'account-1', branchId: 'branch-1', type: 'reservation', depositAmount: 0,
      paymentMethod: 'efectivo', total: 10,
      customer: { name: 'Cliente' }, userProfile: profile,
      items: [{ id: 'p1', name: 'Arroz', price: 10, quantity: 1 }],
    });
    expect(store.docs.get(`reservations/${createdId}`)?.reservationNumber).toBe(9);
  });

  it('approves only when the combined duplicate-line demand fits available stock', async () => {
    store.docs.set('orders/order-1', {
      accountId: 'account-1', branchId: 'branch-1', status: 'pending',
      items: [
        { id: 'p1', name: 'Arroz', price: 10, quantity: 1 },
        { productId: 'p1', productName: 'Arroz', price: 10, quantity: 1 },
      ],
    });
    // Available stock is 4; both lines together demand 2.
    await approveOrder('order-1');
    expect(store.docs.get('products/p1')?.reservedStock['branch-1']).toBe(3);
    expect(store.docs.get('orders/order-1')?.status).toBe('approved');
  });

  it('rejects duplicate-line overcommit atomically', async () => {
    store.docs.set('products/p1', { ...store.docs.get('products/p1'), stock: { 'branch-1': 3 }, reservedStock: { 'branch-1': 2 } });
    store.docs.set('orders/order-1', {
      accountId: 'account-1', branchId: 'branch-1', status: 'pending',
      items: [
        { id: 'p1', name: 'Arroz', price: 10, quantity: 1 },
        { productId: 'p1', productName: 'Arroz', price: 10, quantity: 1 },
      ],
    });
    await expect(approveOrder('order-1')).rejects.toThrow('Stock insuficiente');
    expect(store.docs.get('products/p1')?.reservedStock['branch-1']).toBe(2);
    expect(store.docs.get('orders/order-1')?.status).toBe('pending');
  });
});
