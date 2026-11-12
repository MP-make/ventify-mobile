import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  documents: new Map<string, any>(),
  writes: [] as Array<{ kind: string; ref: any; data: any }>,
  generatedId: 0,
  queryConstraints: [] as any[],
}));

vi.mock('@/lib/firebase', () => ({ db: { test: true } }));
vi.mock('firebase/firestore', () => {
  const makeRef = (collectionName: string, id: string) => ({ collectionName, id });
  const keyFor = (ref: any) => `${ref.collectionName}/${ref.id}`;
  return {
    collection: (_db: any, collectionName: string) => ({ collectionName }),
    doc: (...args: any[]) => {
      if (args.length === 1) {
        const coll = args[0];
        return makeRef(coll.collectionName, `generated-${++fake.generatedId}`);
      }
      return makeRef(args[1], args[2]);
    },
    query: (_collection: any, ...constraints: any[]) => ({ constraints }),
    where: (...args: any[]) => ({ type: 'where', args }),
    orderBy: vi.fn(),
    limit: vi.fn(),
    serverTimestamp: () => 'server-timestamp',
    Timestamp: class Timestamp {},
    setDoc: vi.fn(async (ref: any, data: any) => {
      fake.writes.push({ kind: 'setDoc', ref, data });
      fake.documents.set(keyFor(ref), { ...data });
    }),
    updateDoc: vi.fn(async (ref: any, data: any) => {
      fake.writes.push({ kind: 'updateDoc', ref, data });
      fake.documents.set(keyFor(ref), { ...(fake.documents.get(keyFor(ref)) || {}), ...data });
    }),
    getDoc: vi.fn(async (ref: any) => {
      const data = fake.documents.get(keyFor(ref));
      return { exists: () => !!data, data: () => data };
    }),
    getDocs: vi.fn(async (q: any) => {
      const accountId = q.constraints?.find((constraint: any) => constraint.type === 'where')?.args?.[2];
      const docs = [...fake.documents.entries()]
        .filter(([key, data]) => key.startsWith('products/') && data.accountId === accountId)
        .map(([key, data]) => {
          const id = key.slice('products/'.length);
          return { id, data: () => data };
        });
      return { docs };
    }),
    runTransaction: vi.fn(async (_db: any, callback: (tx: any) => any) => {
      let hasWritten = false;
      const tx = {
        get: async (ref: any) => {
          if (hasWritten) throw new Error('strict transaction: read after write');
          const data = fake.documents.get(keyFor(ref));
          return { exists: () => !!data, data: () => data };
        },
        update: (ref: any, data: any) => {
          hasWritten = true;
          fake.writes.push({ kind: 'tx.update', ref, data });
          fake.documents.set(keyFor(ref), { ...(fake.documents.get(keyFor(ref)) || {}), ...data });
        },
        set: (ref: any, data: any) => {
          hasWritten = true;
          fake.writes.push({ kind: 'tx.set', ref, data });
          fake.documents.set(keyFor(ref), { ...data });
        },
      };
      return callback(tx);
    }),
  };
});

import {
  approveStockTransfer,
  cancelStockTransfer,
  completeStockTransfer,
  createStockTransfer,
  findByBarcodeRemote,
  rejectStockTransfer,
  saveProduct,
  sendStockTransfer,
} from '../inventory-kardex-service';

const actor = { uid: 'manager-1', displayName: 'Manager', role: 'manager' };

describe('inventory parity regressions', () => {
  beforeEach(() => {
    fake.documents.clear();
    fake.writes.length = 0;
    fake.generatedId = 0;
  });

  it('preserves reserved stock, variants and decimal sales when only editing product basics', async () => {
    fake.documents.set('products/p1', {
      accountId: 'a1', name: 'Old name', stock: { north: 10 },
      reservedStock: { north: 3 }, variants: [{ id: 'red' }], allowDecimals: true,
    });

    await saveProduct({ id: 'p1', accountId: 'a1', name: 'New name', stock: { north: 10 } }, false, actor);

    const update = fake.writes.find((write) => write.kind === 'updateDoc')!.data;
    expect(update.name).toBe('New name');
    expect(update).not.toHaveProperty('reservedStock');
    expect(update).not.toHaveProperty('variants');
    expect(update).not.toHaveProperty('allowDecimals');
  });

  it('persists the canonical conversion factor for legacy box presentations', async () => {
    fake.documents.set('products/p1', {accountId:'a1', stock:{north:24}});
    await saveProduct({id:'p1',accountId:'a1',name:'Boxes',stock:{north:24},presentations:[{id:'box',name:'Caja x12',factor:12,price:30}] as any},false,actor);
    const saved = fake.writes.find(write => write.kind === 'updateDoc')!.data;
    expect(saved.presentations[0].conversionFactor).toBe(12);
  });

  it('keeps existing branch keys and calculates low-stock availability from stored reservations', async () => {
    fake.documents.set('products/p1', {
      accountId: 'a1', name: 'Item', stock: { north: 10 }, reservedStock: { north: 8 },
      branchIds: ['north'], minStock: 5,
    });

    await saveProduct({ id: 'p1', accountId: 'a1', name: 'Renamed' }, false, actor);

    const update = fake.writes.find((write) => write.kind === 'updateDoc')!.data;
    expect(update.stock).toEqual({ north: 10 });
    expect(update.branchIds).toEqual(['north']);
    expect(update.lowStockBranches).toEqual(['__any__', 'north']);
  });

  it('reserves transfer stock with all reads before any transaction write', async () => {
    fake.documents.set('products/p1', { accountId: 'a1', stock: { north: 10 }, reservedStock: {} });

    const id = await createStockTransfer({
      accountId: 'a1', fromBranchId: 'north', toBranchId: 'south',
      items: [
        { productId: 'p1', productName: 'Item', quantity: 2 },
        { productId: 'p1', productName: 'Item', quantity: 3 },
      ], userProfile: actor,
    });

    expect(fake.documents.get('products/p1').reservedStock.north).toBe(5);
    expect(fake.documents.get(`transfers/${id}`).status).toBe('pending');
  });

  it('scopes remote barcode lookup to the account and searches alternate codes', async () => {
    fake.documents.set('products/p1', { accountId: 'a1', name: 'Milk', barcode: '111', barcodes: ['222'], stock: {} });
    fake.documents.set('products/p2', { accountId: 'a2', name: 'Other milk', barcode: '222', stock: {} });

    const match = await findByBarcodeRemote('a1', '222');

    expect(match?.product.id).toBe('p1');
    expect(match?.product.name).toBe('Milk');
  });

  it('supports the pending to approved to in-transit transition atomically', async () => {
    fake.documents.set('transfers/t1', { accountId: 'a1', status: 'pending' });

    await approveStockTransfer('t1', actor);
    await sendStockTransfer('t1', actor);

    expect(fake.documents.get('transfers/t1').status).toBe('in_transit');
    expect(fake.documents.get('transfers/t1').sentBy).toBe(actor.uid);
  });

  it('releases reserved stock when a transfer is rejected', async () => {
    fake.documents.set('products/p1', { accountId: 'a1', stock: { north: 10 }, reservedStock: { north: 3 } });
    fake.documents.set('transfers/t1', {
      accountId: 'a1', status: 'pending', sourceBranchId: 'north',
      items: [{ productId: 'p1', productName: 'Item', quantity: 3 }],
    });

    await rejectStockTransfer('t1', actor);

    expect(fake.documents.get('products/p1').reservedStock).toEqual({});
    expect(fake.documents.get('transfers/t1').status).toBe('rejected');
  });

  it('releases reserved stock when a pending transfer is cancelled', async () => {
    fake.documents.set('products/p1', { accountId: 'a1', stock: { north: 10 }, reservedStock: { north: 2 } });
    fake.documents.set('transfers/t1', {
      accountId: 'a1', status: 'pending', sourceBranchId: 'north',
      items: [{ productId: 'p1', productName: 'Item', quantity: 2 }],
    });

    await cancelStockTransfer('t1', actor);

    expect(fake.documents.get('products/p1').reservedStock).toEqual({});
    expect(fake.documents.get('transfers/t1').status).toBe('cancelled');
  });

  it('receives an in-transit transfer with stock, status and both Kardex rows in one transaction', async () => {
    fake.documents.set('products/p1', { accountId: 'a1', name: 'Item', sku: 'I1', stock: { north: 5, south: 1 }, reservedStock: { north: 2 } });
    fake.documents.set('transfers/t1', {
      id: 't1', accountId: 'a1', status: 'in_transit', sourceBranchId: 'north',
      sourceBranchName: 'Norte', destinationBranchId: 'south', destinationBranchName: 'Sur',
      items: [{ productId: 'p1', productName: 'Item', quantity: 2 }],
    });

    await completeStockTransfer('t1', actor);

    expect(fake.documents.get('products/p1').stock).toEqual({ north: 3, south: 3 });
    expect(fake.documents.get('products/p1').reservedStock).toEqual({});
    expect(fake.documents.get('transfers/t1').status).toBe('completed');
    const kardexWrites = fake.writes.filter((write) => write.kind === 'tx.set' && write.ref.collectionName === 'inventory_movements');
    expect(kardexWrites).toHaveLength(2);
  });
});
