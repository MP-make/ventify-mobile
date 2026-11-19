import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collections: new Map<string, Map<string, Record<string, unknown>>>(),
  writes: [] as Array<{ type: string; path: string; value: any }>,
  txWriteStarted: false,
  id: 0,
}));

vi.mock('@/lib/firebase', () => ({
  db: {},
  auth: {
    currentUser: {
      uid: 'uid_cashier_1',
      getIdToken: vi.fn(async () => 'jwt_test_token'),
    },
  },
  APP_URL: 'https://ventify.com.pe',
}));

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('@react-native-community/netinfo', () => ({
  default: { fetch: vi.fn(async () => ({ isConnected: true })), addEventListener: vi.fn(() => () => {}) },
}));

vi.mock('firebase/firestore', () => {
  const ref = (path: string) => ({ path, id: path.split('/').at(-1) || path });
  const getDocData = (path: string) => {
    const [col, id] = path.split('/');
    return mocks.collections.get(col)?.get(id);
  };
  const snapshot = (path: string) => {
    const data = getDocData(path);
    return {
      id: path.split('/').at(-1) || '',
      ref: ref(path),
      exists: () => data !== undefined,
      data: () => data,
    };
  };
  const recordWrite = (type: string, document: { path: string }, value: unknown) => {
    mocks.txWriteStarted = true;
    mocks.writes.push({ type, path: document.path, value });
  };

  return {
    collection: (_db: unknown, name: string) => ({ path: name }),
    doc: (_dbOrCol: any, name?: string, id?: string) => {
      if (typeof name === 'string' && id) return ref(`${name}/${id}`);
      if (typeof name === 'string' && _dbOrCol?.path) return ref(`${_dbOrCol.path}/${name}`);
      const colName = _dbOrCol?.path || name || 'generated';
      mocks.id += 1;
      return ref(`${colName}/gen_${mocks.id}`);
    },
    getDoc: async (document: { path: string }) => snapshot(document.path),
    getDocs: async () => ({ empty: true, docs: [], forEach: () => {} }),
    query: (...args: any[]) => ({ args }),
    where: (...args: any[]) => ({ args }),
    limit: (n: number) => ({ n }),
    runTransaction: async (_db: unknown, cb: (tx: any) => Promise<unknown>) => {
      mocks.txWriteStarted = false;
      return cb({
        get: async (document: { path: string }) => {
          if (mocks.txWriteStarted) {
            throw new Error(`Firestore read after write: ${document.path}`);
          }
          return snapshot(document.path);
        },
        set: (document: { path: string }, val: unknown) => recordWrite('set', document, val),
        update: (document: { path: string }, val: unknown) => recordWrite('update', document, val),
        delete: (document: { path: string }) => recordWrite('delete', document, null),
      });
    },
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    increment: (n: number) => ({ __increment: n }),
    writeBatch: () => ({
      set: (d: { path: string }, v: unknown) => recordWrite('set', d, v),
      update: (d: { path: string }, v: unknown) => recordWrite('update', d, v),
      delete: (d: { path: string }) => recordWrite('delete', d, null),
      commit: async () => {},
    }),
  };
});

import { buildAttributedSalePayload, createSaleTransaction } from '../../services/sale-service';

const seedDoc = (col: string, id: string, data: Record<string, unknown>) => {
  if (!mocks.collections.has(col)) mocks.collections.set(col, new Map());
  mocks.collections.get(col)!.set(id, data);
};

describe('Sale Payload Parity & Canonical Fiado Reservations', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.writes = [];
    mocks.txWriteStarted = false;
    mocks.id = 0;
  });

  it('builds server /api/sales/finalize payload with tax: 0, gross commercial subtotal, normalized documentType, and complete metadata', () => {
    const payload = buildAttributedSalePayload(
      {
        accountId: 'acc_1',
        branchId: 'branch_north',
        userId: 'uid_cashier_1',
        userName: 'Ana Cajera',
        documentType: 'factura',
        paymentMethod: 'digital',
        paymentMethodId: 'yape_1',
        paymentMethodName: 'Yape Tienda',
        digitalProvider: 'yape',
        commissionPercent: 2.5,
        commissionRule: 'customer',
        commissionAmount: 2.95,
        surchargeAmount: 2.95,
        chargedAmount: 120.95,
        netAmount: 118,
        subtotal: 100,
        tax: 18,
        total: 118,
        shippingAmount: 0,
        discountAmount: 0,
        isStaffConsumption: false,
        employeeId: 'emp_1',
        employeeName: 'Ana',
        customer: {
          id: 'cust_1',
          name: 'COMERCIAL ANDINA SAC',
          documentType: 'RUC',
          documentNumber: '20512345678',
          address: 'Av. Lima 100',
        },
        items: [
          {
            productId: 'prod_1',
            name: 'Café 250g',
            sku: 'CAF-250',
            price: 59,
            quantity: 2,
            subtotal: 118,
            total: 118,
            stockBranchId: 'branch_north',
            isGift: false,
          },
        ],
      },
      'sess_123'
    );

    expect(payload.documentType).toBe('01');
    expect(payload.tax).toBe(0);
    expect(payload.subtotal).toBe(118);
    expect(payload.total).toBe(118);
    expect(payload.sessionId).toBe('sess_123');
    expect(payload.paymentMethod).toBe('Yape Tienda');
    expect(payload.digitalProvider).toBe('yape');
    expect(payload.commissionPercent).toBe(2.5);
    expect(payload.commissionRule).toBe('customer');
    expect(payload.chargedAmount).toBe(120.95);
    expect(payload.customerRuc).toBe('20512345678');
    expect(payload.items[0].stockBranchId).toBe('branch_north');

    expect(
      buildAttributedSalePayload({
        accountId: 'acc_1',
        branchId: 'main',
        userId: 'u1',
        userName: 'U',
        documentType: 'boleta',
        paymentMethod: 'efectivo',
        subtotal: 50,
        tax: 0,
        total: 50,
        items: [{ productId: 'p1', name: 'Agua', price: 50, quantity: 1, subtotal: 50, total: 50 }],
      }).documentType
    ).toBe('03');

    expect(
      buildAttributedSalePayload({
        accountId: 'acc_1',
        branchId: 'main',
        userId: 'u1',
        userName: 'U',
        documentType: 'cotizacion',
        paymentMethod: 'efectivo',
        subtotal: 50,
        tax: 0,
        total: 50,
        items: [{ productId: 'p1', name: 'Agua', price: 50, quantity: 1, subtotal: 50, total: 50 }],
      }).documentType
    ).toBe('cot');
  });

  it('writes canonical reservations fiado record (never accounts_receivable) and bypasses minSalePrice on gift items', async () => {
    seedDoc('settings', 'acc_1_pos', { enableSellerAttribution: false });
    seedDoc('cash_register_sessions', 'sess_open', {
      accountId: 'acc_1',
      branchId: 'main',
      status: 'open',
    });
    seedDoc('customers', 'cust_fiado', {
      accountId: 'acc_1',
      name: 'Carlos Fiado',
      phone: '999111222',
      currentDebt: 10,
    });
    seedDoc('products', 'prod_paid', {
      accountId: 'acc_1',
      name: 'Arroz Costeño',
      minSalePrice: 18,
      costPrice: 12,
      stock: { main: 20 },
    });
    seedDoc('products', 'prod_gift', {
      accountId: 'acc_1',
      name: 'Muestra Gratis',
      minSalePrice: 10,
      costPrice: 2,
      stock: { main: 15 },
    });
    seedDoc('nota_counters', 'main', { counter: 7 });

    await createSaleTransaction({
      accountId: 'acc_1',
      branchId: 'main',
      sessionId: 'sess_open',
      userId: 'uid_cashier_1',
      userName: 'Ana',
      documentType: 'nota_venta',
      paymentMethod: 'fiado',
      paymentMethodId: 'credit_store',
      creditDays: 15,
      payments: [{ methodId: 'credit_store', methodName: 'Crédito / Fiado', category: 'credit', amount: 25 }],
      subtotal: 25,
      tax: 0,
      total: 25,
      customerId: 'cust_fiado',
      customerName: 'Carlos Fiado',
      customer: { id: 'cust_fiado', name: 'Carlos Fiado', phone: '999111222' },
      items: [
        {
          productId: 'prod_paid',
          name: 'Arroz Costeño',
          price: 25,
          quantity: 1,
          subtotal: 25,
          total: 25,
        },
        {
          productId: 'prod_gift',
          name: 'Muestra Gratis',
          price: 0,
          quantity: 1,
          subtotal: 0,
          total: 0,
          isGift: true,
        },
      ],
    });

    const receivableWrites = mocks.writes.filter((w) => w.path.startsWith('accounts_receivable/'));
    expect(receivableWrites).toHaveLength(0);

    const reservationWrites = mocks.writes.filter((w) => w.path.startsWith('reservations/'));
    expect(reservationWrites).toHaveLength(1);
    expect(reservationWrites[0].value).toMatchObject({
      accountId: 'acc_1',
      branchId: 'main',
      type: 'fiado',
      isFiado: true,
      customerId: 'cust_fiado',
      customerName: 'Carlos Fiado',
      currentDebt: 25,
      status: 'pending',
    });
    expect(reservationWrites[0].value.dueDate).toBeGreaterThan(reservationWrites[0].value.date);
  });
});
