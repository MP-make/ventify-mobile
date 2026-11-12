import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collections: new Map<string, Map<string, Record<string, unknown>>>(),
  writes: [] as Array<{ type: string; path: string; value: any }>,
  txReads: [] as string[],
  txWriteStarted: false,
  id: 0,
}));

vi.mock('@/lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));
vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: vi.fn(), addEventListener: vi.fn() } }));
vi.mock('firebase/firestore', () => {
  const ref = (path: string) => ({ path, id: path.split('/').at(-1) });
  const snapshot = (path: string) => {
    const parts = path.split('/');
    const data = mocks.collections.get(parts[0])?.get(parts[1]);
    return {
      id: parts[1],
      ref: ref(path),
      exists: () => data !== undefined,
      data: () => data,
    };
  };
  const write = (type: string, document: { path: string }, value: unknown) => {
    mocks.txWriteStarted = true;
    mocks.writes.push({ type, path: document.path, value });
  };
  return {
    collection: (_db: unknown, name: string) => ({ path: name }),
    doc: (_dbOrCollection: any, name?: string, id?: string) => {
      if (typeof name === 'string' && id) return ref(`${name}/${id}`);
      if (typeof name === 'string' && _dbOrCollection?.path) return ref(`${_dbOrCollection.path}/${name}`);
      const collectionName = _dbOrCollection?.path || name || 'generated';
      mocks.id += 1;
      return ref(`${collectionName}/generated-${mocks.id}`);
    },
    runTransaction: async (_db: unknown, callback: (tx: any) => Promise<unknown>) => {
      mocks.txReads = [];
      mocks.txWriteStarted = false;
      return callback({
        get: async (document: { path: string }) => {
          if (mocks.txWriteStarted) throw new Error(`Firestore read after write: ${document.path}`);
          mocks.txReads.push(document.path);
          return snapshot(document.path);
        },
        set: (document: { path: string }, value: unknown) => write('set', document, value),
        update: (document: { path: string }, value: unknown) => write('update', document, value),
        delete: (document: { path: string }) => write('delete', document, undefined),
      });
    },
    serverTimestamp: () => 'server-timestamp',
    updateDoc: vi.fn(),
    query: (...args: unknown[]) => ({ args }),
    where: (...args: unknown[]) => ({ args }),
    getDocs: async (request: any) => {
      const collectionName = request.args?.[0]?.path;
      const docs = collectionName === 'accounts_receivable'
        ? [...(mocks.collections.get(collectionName) || [])].map(([id]) => ({ ...snapshot(`${collectionName}/${id}`), ref: ref(`${collectionName}/${id}`) })) : [];
      return { empty: docs.length === 0, docs };
    },
    getDoc: async (document: { path: string }) => snapshot(document.path),
    limit: (count: number) => ({ count }),
    Timestamp: class Timestamp {},
  };
});

import { buildAttributedSalePayload, cancelSaleWithReversal, createSaleTransaction } from '../sale-service';
import { calculateCashAudit, cashAuditSnapshotMatches, clearActiveCashSessionPointer } from '../cash-register-service';
import { offlineSaleBelongsToIdentity, resolveOfflineSyncAccountId } from '../offline-sync-service';

const seed = (collectionName: string, id: string, data: Record<string, unknown>) => {
  const collection = mocks.collections.get(collectionName) || new Map();
  collection.set(id, data);
  mocks.collections.set(collectionName, collection);
};

describe('sales and cash transaction regressions', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.writes = [];
    mocks.txReads = [];
    mocks.txWriteStarted = false;
    mocks.id = 0;
  });

  it('reads session and active pointers before writing a cash sale', async () => {
    seed('products', 'p1', { stock: { b1: 4 }, reservedStock: {}, costPrice: 2 });
    seed('cash_register_sessions', 's1', { status: 'open', activeSessionId: 's1', cashSalesTotal: 0, totalSales: 0, transactionCount: 0 });
    seed('cash_register_sessions', 'active_b1', { status: 'open', activeSessionId: 's1', cashSalesTotal: 0, totalSales: 0, transactionCount: 0 });
    seed('cash_register_sessions', 'active_a1_b1_u1', { status: 'open', activeSessionId: 's1', cashSalesTotal: 0, totalSales: 0, transactionCount: 0 });

    const result = await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 10, quantity: 1 }],
      paymentMethod: 'cash', documentType: 'nota_venta', total: 10, sessionId: 's1',
      payments: [{ category: 'cash', amount: 10 } as any],
    });

    expect(result.status).toBe('completed');
    expect(mocks.txReads).toContain('cash_register_sessions/s1');
    expect(mocks.txReads).toContain('cash_register_sessions/active_b1');
    expect(mocks.txReads).toContain('cash_register_sessions/active_a1_b1_u1');
    expect(mocks.writes.filter((write) => write.path.startsWith('inventory_movements/'))).toHaveLength(1);
    expect(mocks.writes.find((write) => write.path === 'products/p1')?.value).toMatchObject({ stock: { b1: 3 } });
  });

  it('reads the customer before the counter is updated for a credit sale', async () => {
    seed('products', 'p1', { stock: { b1: 4 }, reservedStock: {}, costPrice: 2 });
    seed('customers', 'c1', { currentDebt: 5 });
    seed('cash_register_sessions', 's1', { status: 'open', cashSales: 0, totalSales: 0, transactionCount: 0, expectedAmount: 0 });

    await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 10, quantity: 1 }],
      paymentMethod: 'credit', documentType: 'nota_venta', total: 10, sessionId: 's1', customerId: 'c1',
      payments: [{ category: 'credit', amount: 10 } as any],
    });

    expect(mocks.txReads.indexOf('customers/c1')).toBeGreaterThan(-1);
    expect(mocks.txReads).toContain('nota-counters/b1');
    expect(mocks.writes.find((write) => write.path === 'customers/c1')?.value).toMatchObject({ currentDebt: 15 });
  });

  it('deducts prepaid credits without creating fiado debt', async () => {
    seed('products', 'p1', { stock: { b1: 4 }, reservedStock: {} });
    seed('customers', 'c1', { currentDebt: 7, credits: 20 });

    await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 10, quantity: 1 }],
      paymentMethod: 'creditos', documentType: 'nota_venta', total: 10, customerId: 'c1',
      payments: [{ category: 'credit', amount: 10 } as any],
    });

    expect(mocks.writes.find((write) => write.path === 'customers/c1')?.value).toMatchObject({ credits: 10 });
    expect(mocks.writes.find((write) => write.path === 'customers/c1')?.value).not.toHaveProperty('currentDebt');
  });

  it('sends seller, variant and the web checkout tax convention in the attributed DTO', () => {
    const payload = buildAttributedSalePayload({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Variant product', price: 100, quantity: 1, variantId: 'v1', variantName: 'Blue' }],
      paymentMethod: 'cash', documentType: 'nota_venta', total: 100, sellerId: 'seller1', sellerName: 'Ana',
    });

    expect(payload).toMatchObject({ subtotal: 100, tax: 0, sellerId: 'seller1', sellerName: 'Ana' });
    expect(payload.items[0]).toMatchObject({ variantId: 'v1', variantName: 'Blue' });
  });

  it('preserves the configured payment identity in the server DTO', () => {
    const payload = buildAttributedSalePayload({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 100, quantity: 1 }],
      paymentMethod: 'digital', paymentMethodId: 'wallet-custom', paymentMethodName: 'Billetera propia',
      documentType: 'nota_venta', total: 100,
    });
    expect(payload).toMatchObject({ paymentMethodId: 'wallet-custom', paymentMethod: 'Billetera propia' });
  });

  it.each([['cash', undefined, 'efectivo'], ['digital', 'plin', 'plin'], ['credit', undefined, 'creditos']])('normalizes legacy queued %s payment identity for server checkout', (method, provider, expectedId) => {
    const payload = buildAttributedSalePayload({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier', items: [],
      paymentMethod: method!, documentType: 'nota_venta', total: 10,
      payments: [{ category: method === 'credit' ? 'credit' : method === 'cash' ? 'cash' : 'digital', amount: 10, digitalProvider: provider as any }],
    });
    expect(payload.paymentMethodId).toBe(expectedId);
    if (method === 'credit') expect(payload.creditMode).toBe('receivable');
  });

  it('uses charged split amounts in cash counters and persists fees without increasing commercial total', async () => {
    seed('products', 'p1', { stock: { b1: 4 }, reservedStock: {} });
    seed('cash_register_sessions', 's1', { status: 'open', totalSales: 0, cardSales: 0 });
    await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 100, quantity: 1 }],
      paymentMethod: 'card', paymentMethodId: 'terminal-1', paymentMethodName: 'Terminal',
      documentType: 'nota_venta', total: 100, sessionId: 's1',
      chargedAmount: 103, commissionAmount: 3, surchargeAmount: 3, netAmount: 100,
      payments: [{ methodId: 'terminal-1', category: 'card', amount: 100, chargedAmount: 103, commissionAmount: 3, surchargeAmount: 3 }],
    });
    expect(mocks.writes.find(w => w.path === 'cash_register_sessions/s1')?.value)
      .toMatchObject({ cardSales: 103, totalSales: 103, totalCommissionAmount: 3, totalSurchargeAmount: 3 });
    expect(mocks.writes.find(w => w.path.startsWith('sales/'))?.value)
      .toMatchObject({ total: 100, chargedAmount: 103, commissionAmount: 3, surchargeAmount: 3, paymentMethodId: 'terminal-1' });
  });

  it('rejects an offline sale when its original session is already closed', async () => {
    seed('products', 'p1', { stock: { b1: 4 }, reservedStock: {} });
    seed('cash_register_sessions', 's1', { status: 'closed', expectedAmount: 10 });

    await expect(createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 10, quantity: 1 }],
      paymentMethod: 'cash', documentType: 'nota_venta', total: 10, sessionId: 's1', saleDate: 123,
    })).rejects.toThrow('sesión de caja asociada');
  });

  it('reads stock, session, and customer before writing a cancellation reversal', async () => {
    seed('sales', 'sale1', {
      id: 'sale1', accountId: 'a1', branchId: 'b1', status: 'completed', correlative: 'NV01-000001',
      items: [{ productId: 'p1', name: 'Product', quantity: 1, price: 10 }],
      cashAmount: 10, paymentMethod: 'credit', paymentCategory: 'credit', creditAmount: 10,
      customerId: 'c1', sessionId: 's1', total: 10,
    });
    seed('products', 'p1', { stock: { b1: 0 }, reservedStock: {} });
    seed('cash_register_sessions', 's1', { status: 'open', expectedAmount: 10, totalExpenses: 0 });
    seed('customers', 'c1', { currentDebt: 10 });

    const result = await cancelSaleWithReversal('sale1', 'Devolución', { uid: 'u1', role: 'cashier' });

    expect(result.status).toBe('cancelled');
    expect(mocks.writes.find((write) => write.path === 'products/p1')?.value).toMatchObject({ stock: { b1: 1 } });
    expect(mocks.writes.find((write) => write.path === 'cash_register_sessions/s1')?.value).toMatchObject({ expectedAmount: 0 });
    expect(mocks.writes.find((write) => write.path === 'customers/c1')?.value).toMatchObject({ currentDebt: 0 });
  });

  it('refuses a cash cancellation against a closed original session before any write', async () => {
    seed('sales', 'closed-cash-sale', {
      id: 'closed-cash-sale', accountId: 'a1', branchId: 'b1', status: 'completed',
      items: [{ productId: 'p1', name: 'Product', quantity: 1, price: 10 }],
      cashAmount: 10, paymentMethod: 'cash', sessionId: 's1', total: 10,
    });
    seed('products', 'p1', { stock: { b1: 0 }, reservedStock: {} });
    seed('cash_register_sessions', 's1', { status: 'closed', expectedAmount: 10 });

    await expect(cancelSaleWithReversal('closed-cash-sale', 'Reversa', { uid: 'u1', role: 'cashier' }))
      .rejects.toThrow('caja cerrada');
    expect(mocks.writes).toHaveLength(0);
  });

  it.each(['refunded', 'partial'])('rejects cancellation after a %s return before any business write', async (state) => {
    seed('sales', 'returned', { accountId: 'a1', branchId: 'b1', status: state === 'refunded' ? 'refunded' : 'completed',
      refundedLineIndices: state === 'partial' ? [0] : [], items: [], total: 10 });
    await expect(cancelSaleWithReversal('returned', 'Reversa', { uid: 'u1', role: 'admin' })).rejects.toThrow('devolución');
    expect(mocks.writes).toHaveLength(0);
  });

  it('restores a custom prepaid method using its persisted credit mode', async () => {
    seed('sales', 'prepaid', { accountId: 'a1', branchId: 'b1', status: 'completed', items: [], total: 100,
      paymentMethod: 'Saldo tienda', paymentMethodId: 'custom-credit', paymentCategory: 'credit', creditMode: 'prepaid',
      customerId: 'c1', payments: [{ category: 'credit', amount: 40 }, { category: 'digital', amount: 60 }] });
    seed('customers', 'c1', { credits: 5, currentDebt: 80 });
    await cancelSaleWithReversal('prepaid', 'Reversa', { uid: 'u1', role: 'admin' });
    expect(mocks.writes.find(w => w.path === 'customers/c1')?.value).toMatchObject({ credits: 45 });
    expect(mocks.writes.find(w => w.path === 'customers/c1')?.value).not.toHaveProperty('currentDebt');
  });

  it('cancels only outstanding linked fiado debt after previous customer payments', async () => {
    seed('sales', 'fiado-sale', { accountId: 'a1', branchId: 'b1', status: 'completed', items: [], total: 100,
      paymentMethod: 'credit', paymentCategory: 'credit', creditMode: 'receivable', customerId: 'c1' });
    seed('customers', 'c1', { currentDebt: 70 });
    seed('accounts_receivable', 'ar1', { accountId: 'a1', saleId: 'fiado-sale', customerId: 'c1', currentDebt: 30, status: 'pending' });
    await cancelSaleWithReversal('fiado-sale', 'Reversa', { uid: 'u1', role: 'admin' });
    expect(mocks.writes.find(w => w.path === 'customers/c1')?.value).toMatchObject({ currentDebt: 40 });
    expect(mocks.writes.find(w => w.path === 'accounts_receivable/ar1')?.value).toMatchObject({ currentDebt: 0, status: 'cancelled' });
  });

  it('aggregates multiple variant lines for one product into one stock update', async () => {
    seed('products', 'p1', {
      stock: { b1: 4 }, reservedStock: {},
      variants: [
        { id: 'red', stock: { b1: 2 } },
        { id: 'blue', stock: { b1: 2 } },
      ],
    });
    seed('cash_register_sessions', 's1', { status: 'open', expectedAmount: 0, cashSales: 0, totalSales: 0 });
    await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [
        { productId: 'p1', name: 'Product', price: 10, quantity: 1, variantId: 'red' },
        { productId: 'p1', name: 'Product', price: 10, quantity: 1, variantId: 'blue' },
      ],
      paymentMethod: 'cash', documentType: 'nota_venta', total: 20, sessionId: 's1',
    });

    const productWrites = mocks.writes.filter((write) => write.path === 'products/p1');
    expect(productWrites).toHaveLength(1);
    expect(productWrites[0].value).toMatchObject({
      stock: { b1: 2 },
      variants: [
        { id: 'red', stock: { b1: 1 } },
        { id: 'blue', stock: { b1: 1 } },
      ],
    });
  });

  it('aggregates presentation quantities for one product into one stock update', async () => {
    seed('products', 'p1', { stock: { b1: 20 }, reservedStock: {} });
    seed('cash_register_sessions', 's1', { status: 'open', expectedAmount: 0, cashSales: 0, totalSales: 0 });
    await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [
        { productId: 'p1', name: 'Product', price: 10, quantity: 1, presentationQty: 2 },
        { productId: 'p1', name: 'Product', price: 10, quantity: 2, presentationQty: 3 },
      ],
      paymentMethod: 'cash', documentType: 'nota_venta', total: 30, sessionId: 's1',
    });

    const productWrites = mocks.writes.filter((write) => write.path === 'products/p1');
    expect(productWrites).toHaveLength(1);
    expect(productWrites[0].value).toMatchObject({ stock: { b1: 12 } });
  });

  it('persists the canonical Principal stock key used by the sale', async () => {
    seed('products', 'p1', { stock: { Principal: 3 }, reservedStock: {} });
    seed('cash_register_sessions', 's1', { status: 'open', expectedAmount: 0, cashSales: 0, totalSales: 0 });
    await createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 10, quantity: 1 }],
      paymentMethod: 'cash', documentType: 'nota_venta', total: 10, sessionId: 's1',
    });

    expect(mocks.writes.find((write) => write.path === 'products/p1')?.value).toMatchObject({ stock: { Principal: 2 } });
    const saleWrite = mocks.writes.find((write) => write.path.startsWith('sales/'));
    expect(saleWrite?.value.items[0].stockBranchId).toBe('Principal');
  });

  it('does not consume stock from an unrelated branch when the active branch key is missing', async () => {
    seed('products', 'p1', { stock: { b2: 3 }, reservedStock: {} });
    await expect(createSaleTransaction({
      accountId: 'a1', branchId: 'b1', userId: 'u1', userName: 'Cashier',
      items: [{ productId: 'p1', name: 'Product', price: 10, quantity: 1 }],
      paymentMethod: 'credit', documentType: 'nota_venta', total: 10,
      customerId: 'c1', payments: [{ category: 'credit', amount: 10 } as any],
    })).rejects.toThrow('no tiene stock asociado a la sucursal activa');
  });

  it('restores legacy Principal stock key on cancellation', async () => {
    seed('sales', 'legacy-sale', {
      id: 'legacy-sale', accountId: 'a1', branchId: 'b1', status: 'completed', total: 10,
      items: [{ productId: 'p1', name: 'Product', quantity: 1, price: 10, stockBranchId: 'Principal' }],
    });
    seed('products', 'p1', { stock: { Principal: 0 }, reservedStock: {} });

    await cancelSaleWithReversal('legacy-sale', 'Reversa', { uid: 'u1', role: 'cashier' });

    expect(mocks.writes.find((write) => write.path === 'products/p1')?.value).toMatchObject({ stock: { Principal: 1 } });
    expect(mocks.writes.find((write) => write.path === 'products/p1')?.value.stock).not.toHaveProperty('b1');
  });

  it('aggregates same-product variant lines when a sale is cancelled', async () => {
    seed('sales', 'variant-sale', {
      id: 'variant-sale', accountId: 'a1', branchId: 'b1', status: 'completed', total: 20,
      items: [
        { productId: 'p1', name: 'Product', quantity: 1, price: 10, variantId: 'red' },
        { productId: 'p1', name: 'Product', quantity: 1, price: 10, variantId: 'blue' },
      ],
    });
    seed('products', 'p1', {
      stock: { b1: 0 }, reservedStock: {},
      variants: [
        { id: 'red', stock: { b1: 0 } },
        { id: 'blue', stock: { b1: 0 } },
      ],
    });

    await cancelSaleWithReversal('variant-sale', 'Reversa', { uid: 'u1', role: 'cashier' });

    const productWrites = mocks.writes.filter((write) => write.path === 'products/p1');
    expect(productWrites).toHaveLength(1);
    expect(productWrites[0].value).toMatchObject({
      stock: { b1: 2 },
      variants: [
        { id: 'red', stock: { b1: 1 } },
        { id: 'blue', stock: { b1: 1 } },
      ],
    });
  });

  it('counts chargedAmount in split payments when closing cash', () => {
    const audit = calculateCashAudit(
      { id: 's1', accountId: 'a1', branchId: 'b1', status: 'open', startedBy: 'u1', startedByName: 'Cashier', initialAmount: 0, openingBalance: 0, openedAt: 0 },
      [],
      [{ id: 'sale1', sessionId: 's1', status: 'completed', total: 100, payments: [{ category: 'cash', amount: 100, chargedAmount: 105 }] }]
    );

    expect(audit.cashSales).toBe(105);
    expect(audit.expectedCashInDrawer).toBe(105);
  });

  it('excludes cash change from the amount charged in checkout', () => {
    const audit = calculateCashAudit(
      { id: 's1', accountId: 'a1', branchId: 'b1', status: 'open', startedBy: 'u1', startedByName: 'Cashier', initialAmount: 0, openingBalance: 0, openedAt: 0 },
      [],
      [{ id: 'sale1', sessionId: 's1', status: 'completed', total: 100, cashReceived: 150, changeGiven: 50, payments: [{ category: 'cash', amount: 100, chargedAmount: 100 }] }]
    );

    expect(audit.cashSales).toBe(100);
    expect(audit.expectedCashInDrawer).toBe(100);
  });

  it('rejects a close snapshot when cash-affecting sale counters changed', () => {
    const calculated = { id: 's1', status: 'open', expectedAmount: 100, totalSales: 100, transactionCount: 1 } as any;
    const current = { ...calculated, expectedAmount: 110, totalSales: 110, transactionCount: 2 };

    expect(cashAuditSnapshotMatches(calculated, current)).toBe(false);
    expect(cashAuditSnapshotMatches(calculated, calculated)).toBe(true);
  });

  it('rejects a close snapshot when card order deposits change but cash stays constant', () => {
    const calculated = { id: 's1', status: 'open', expectedAmount: 100, totalSales: 100, transactionCount: 1, totalOrderDeposits: 20, orderDepositsCount: 1, cardOrderDeposits: 20 } as any;
    const current = { ...calculated, cardOrderDeposits: 40 };

    expect(cashAuditSnapshotMatches(calculated, current)).toBe(false);
  });

  it('does not clear an operator pointer that has moved to a newer cash session', async () => {
    const { doc } = await import('firebase/firestore');
    const pointerRef = doc({} as any, 'cash_register_sessions', 'active_a1_b1_u1');
    seed('cash_register_sessions', 'active_a1_b1_u1', {
      activeSessionId: 'new-session', accountId: 'a1', branchId: 'b1', status: 'open',
    });

    await clearActiveCashSessionPointer(pointerRef, 'closed-session');

    expect(mocks.txReads).toContain('cash_register_sessions/active_a1_b1_u1');
    expect(mocks.writes).toHaveLength(0);
  });

  it('keeps queued sales scoped to the original user and account', () => {
    const payload = { userId: 'u1', accountId: 'a1' } as any;

    expect(offlineSaleBelongsToIdentity(payload, 'u1', 'a1')).toBe(true);
    expect(offlineSaleBelongsToIdentity(payload, 'u2', 'a1')).toBe(false);
    expect(offlineSaleBelongsToIdentity(payload, 'u1', 'a2')).toBe(false);
  });

  it('resolves a legacy offline identity from its account claim when the profile omits accountId', () => {
    expect(resolveOfflineSyncAccountId('claimed-account', undefined, null)).toBe('claimed-account');
    expect(resolveOfflineSyncAccountId(null, undefined, 'owned-account')).toBe('owned-account');
    expect(resolveOfflineSyncAccountId(null, 'assigned-account', 'owned-account')).toBe('assigned-account');
  });
});
