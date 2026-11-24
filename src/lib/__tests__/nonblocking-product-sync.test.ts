import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  PRODUCTS_REST_PAGE_SIZE,
  FirestoreRestError,
  decodeFirestoreDocument,
  decodeFirestoreValue,
  fetchProductsPageViaRest,
} from '@/lib/firestore-rest-products';
import {
  writeProductCatalogCache,
  updateProductCatalogManifestMeta,
  readProductCatalogManifestSync,
  type CatalogCacheStorage,
} from '@/lib/product-catalog-cache';
import type { Product } from '@/types';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

const makeProduct = (id: string): Product => ({
  id,
  name: `Product ${id}`,
  category: 'General',
  sku: id,
  barcode: '',
  barcodes: [],
  costPrice: 5,
  suggestedPrice: 10,
  price: 10,
  minSalePrice: 5,
  stock: { main: 10 },
  reservedStock: {},
  branchIds: ['main'],
  lowStockBranches: [],
  branchPrices: {},
  variants: [],
  priceTiers: [],
  imageUrl: '',
  thumbUrl: '',
  hint: '',
  unitOfMeasure: 'unit',
  allowDecimals: false,
  active: true,
  accountId: 'acc-1',
  presentations: [],
});

function createTrackedSyncStorage() {
  const values = new Map<string, string>();
  const setCalls: string[] = [];
  const storage: CatalogCacheStorage = {
    isSyncCapable: true,
    getItem: async (k: string) => values.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      setCalls.push(k);
      values.set(k, v);
    },
    removeItem: async (k: string) => {
      values.delete(k);
    },
    getItemSync: (k: string) => values.get(k) ?? null,
    setItemSync: (k: string, v: string) => {
      setCalls.push(k);
      values.set(k, v);
    },
    removeItemSync: (k: string) => {
      values.delete(k);
    },
  };
  return { values, setCalls, storage };
}

describe('non-blocking paginated REST catalog sync', () => {
  it('decodes every Firestore v1 REST field type cleanly', () => {
    expect(decodeFirestoreValue({ nullValue: null })).toBeNull();
    expect(decodeFirestoreValue({ stringValue: 'Cafe' })).toBe('Cafe');
    expect(decodeFirestoreValue({ integerValue: '9007199254740991' })).toBe(9007199254740991);
    expect(decodeFirestoreValue({ doubleValue: 12.5 })).toBe(12.5);
    expect(decodeFirestoreValue({ booleanValue: true })).toBe(true);
    expect(decodeFirestoreValue({ timestampValue: '2026-11-24T10:00:00.000Z' })).toBe(
      Date.parse('2026-11-24T10:00:00.000Z')
    );
    expect(decodeFirestoreValue({ timestampValue: 'not-a-date' })).toBeUndefined();
    expect(decodeFirestoreValue({ referenceValue: 'projects/p/databases/(default)/documents/a/b' })).toBe(
      'projects/p/databases/(default)/documents/a/b'
    );
    expect(decodeFirestoreValue({ bytesValue: 'AQID' })).toBe('AQID');
    expect(decodeFirestoreValue({ geoPointValue: { latitude: -12.04, longitude: -77.04 } })).toEqual({
      latitude: -12.04,
      longitude: -77.04,
    });
    expect(decodeFirestoreValue({ arrayValue: {} })).toEqual([]);
    expect(decodeFirestoreValue({ mapValue: {} })).toEqual({});

    const docSnap = decodeFirestoreDocument({
      name: 'projects/ventify-xead3/databases/(default)/documents/products/prod-123',
      fields: {
        name: { stringValue: 'Arroz Costeno' },
        stock: { mapValue: { fields: { main: { integerValue: '42' } } } },
        price: { doubleValue: 19.9 },
        active: { booleanValue: true },
        note: { nullValue: null },
        tags: { arrayValue: { values: [{ stringValue: 'grano' }] } },
        updatedAt: { timestampValue: '2026-11-24T10:00:00.000Z' },
      },
    });

    expect(docSnap).not.toBeNull();
    expect(docSnap!.id).toBe('prod-123');
    expect(docSnap!.data()).toEqual({
      name: 'Arroz Costeno',
      stock: { main: 42 },
      price: 19.9,
      active: true,
      note: null,
      tags: ['grano'],
      updatedAt: Date.parse('2026-11-24T10:00:00.000Z'),
    });
    expect(decodeFirestoreDocument({ fields: {} })).toBeNull();
  });

  it('builds paginated REST runQuery requests with exclusive startAt cursor and surfaces 401 status', async () => {
    expect(PRODUCTS_REST_PAGE_SIZE).toBe(250);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          document: {
            name: 'projects/ventify-xead3/databases/(default)/documents/products/p1',
            fields: { accountId: { stringValue: 'acc-1' }, name: { stringValue: 'Item 1' } },
          },
        },
        {
          document: {
            name: 'projects/ventify-xead3/databases/(default)/documents/products/p2',
            fields: { accountId: { stringValue: 'acc-1' }, name: { stringValue: 'Item 2' } },
          },
        },
      ],
    })) as unknown as typeof fetch;

    const page1 = await fetchProductsPageViaRest({
      projectId: 'ventify-xead3',
      accountId: 'acc-1',
      idToken: 'tok-1',
      pageSize: 2,
      fetchImpl: fetchMock,
    });

    expect(page1.docs.map((d) => d.id)).toEqual(['p1', 'p2']);
    expect(page1.lastDocName).toBe('projects/ventify-xead3/databases/(default)/documents/products/p2');
    expect(page1.hasMore).toBe(true);

    const [url1, init1] = (fetchMock as any).mock.calls[0];
    expect(url1).toBe(
      'https://firestore.googleapis.com/v1/projects/ventify-xead3/databases/(default)/documents:runQuery'
    );
    expect(init1.headers.Authorization).toBe('Bearer tok-1');
    const body1 = JSON.parse(init1.body);
    expect(body1.structuredQuery.where).toEqual({
      fieldFilter: {
        field: { fieldPath: 'accountId' },
        op: 'EQUAL',
        value: { stringValue: 'acc-1' },
      },
    });
    expect(body1.structuredQuery.orderBy).toEqual([
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
    ]);
    expect(body1.structuredQuery.limit).toBe(2);
    expect(body1.structuredQuery.startAt).toBeUndefined();

    (fetchMock as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          document: {
            name: 'projects/ventify-xead3/databases/(default)/documents/products/p3',
            fields: { accountId: { stringValue: 'acc-1' }, name: { stringValue: 'Item 3' } },
          },
        },
      ],
    });

    const page2 = await fetchProductsPageViaRest({
      projectId: 'ventify-xead3',
      accountId: 'acc-1',
      idToken: 'tok-1',
      pageSize: 2,
      startAfterDocName: page1.lastDocName,
      fetchImpl: fetchMock,
    });

    const [, init2] = (fetchMock as any).mock.calls[1];
    const body2 = JSON.parse(init2.body);
    expect(body2.structuredQuery.startAt).toEqual({
      values: [{ referenceValue: page1.lastDocName }],
      before: false,
    });
    expect(page2.docs.map((d) => d.id)).toEqual(['p3']);
    expect(page2.hasMore).toBe(false);

    (fetchMock as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    await expect(
      fetchProductsPageViaRest({
        projectId: 'ventify-xead3',
        accountId: 'acc-1',
        idToken: 'expired',
        fetchImpl: fetchMock,
      })
    ).rejects.toMatchObject({ name: 'FirestoreRestError', status: 401 });
    expect(FirestoreRestError).toBeTypeOf('function');
  });

  it('updates only manifest metadata without rewriting catalog chunks', async () => {
    const { values, setCalls, storage } = createTrackedSyncStorage();
    const key = '@ventify_product_catalog:v1:u1:acc-1:account';

    await writeProductCatalogCache(storage, key, [makeProduct('p1'), makeProduct('p2')], {
      generation: 'gen-1',
      chunkSize: 1,
      lastSyncMs: 1000,
      allDocsHaveUpdatedAt: false,
      now: 1000,
      yieldControl: async () => {},
    });

    setCalls.length = 0;

    const updated = await updateProductCatalogManifestMeta(storage, key, {
      lastSyncMs: 5000,
      allDocsHaveUpdatedAt: true,
      cachedAt: 5000,
    });

    expect(updated).toBe(true);
    expect(setCalls).toEqual([`${key}:manifest`]);
    const manifest = readProductCatalogManifestSync(key, storage);
    expect(manifest).toMatchObject({
      generation: 'gen-1',
      count: 2,
      chunks: 2,
      lastSyncMs: 5000,
      allDocsHaveUpdatedAt: true,
      cachedAt: 5000,
    });
    expect(values.get(`${key}:data:gen-1:0`)).toContain('"p1"');

    const missing = await updateProductCatalogManifestMeta(
      storage,
      '@ventify_product_catalog:v1:u1:missing:account',
      { lastSyncMs: 2000 }
    );
    expect(missing).toBe(false);
  });

  it('eliminates unbounded full-collection onSnapshot listener from ProductsContext', () => {
    const src = fs.readFileSync(
      path.join(WORKSPACE_ROOT, 'src/context/ProductsContext.tsx'),
      'utf8'
    );
    expect(src).not.toContain('startFullListener');
    expect(src).toContain('fetchProductsPageViaRest');
    expect(src).toContain('updateProductCatalogManifestMeta');

    const onSnapshotCalls = src.match(/onSnapshot\(/g) || [];
    expect(onSnapshotCalls).toHaveLength(1);
  });
});
