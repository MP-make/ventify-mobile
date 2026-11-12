import { describe, expect, it } from 'vitest';
import {
  PRODUCT_CATALOG_FIRST_BATCH_SIZE,
  PRODUCT_CATALOG_WORK_BATCH_SIZE,
  isAuthoritativeCatalogSnapshot,
  processCatalogInBatches,
  productsForCatalogScope,
  shouldRetainCatalogProduct,
} from '@/lib/product-catalog-loader';
import {
  ProductCatalogIndex,
  ProductCatalogInventoryIndex,
  removeCatalogProduct,
} from '@/lib/product-catalog-index';
import type { Product } from '@/types';

const product = (id: string, values: Partial<Product> = {}): Product => ({
  id,
  name: id,
  category: 'General',
  sku: '',
  barcode: '',
  barcodes: [],
  costPrice: 1,
  suggestedPrice: 1,
  price: 1,
  minSalePrice: 1,
  stock: {},
  reservedStock: {},
  branchIds: [],
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
  accountId: 'account',
  presentations: [],
  ...values,
});

describe('product catalog loading', () => {
  it('hides the previous account or branch until the new scoped catalog is published', () => {
    const previousScopeProducts = [product('old')];
    expect(productsForCatalogScope(previousScopeProducts, 'uid-a:account-a:main', 'uid-b:account-b:main'))
      .toEqual([]);
    expect(productsForCatalogScope(previousScopeProducts, 'uid-a:account-a:main', 'uid-a:account-a:main'))
      .toBe(previousScopeProducts);
  });

  it('does not treat a partial Firestore cache snapshot as complete and drops cached products missing from server truth', () => {
    expect(isAuthoritativeCatalogSnapshot(true)).toBe(false);
    expect(isAuthoritativeCatalogSnapshot(false)).toBe(true);

    const serverIds = new Set(['live']);
    const pendingLocalIds = new Set(['local-pending']);
    expect(shouldRetainCatalogProduct('cached-deleted', serverIds, pendingLocalIds)).toBe(false);
    expect(shouldRetainCatalogProduct('live', serverIds, pendingLocalIds)).toBe(true);
    expect(shouldRetainCatalogProduct('local-pending', serverIds, pendingLocalIds)).toBe(true);
  });

  it('keeps the first network batch small and yields between bounded tasks for 10k products', async () => {
    const fixture = Array.from({ length: 10_000 }, (_, index) => product(`p-${index}`));
    const processed: string[] = [];
    const taskSizes: number[] = [];
    let yields = 0;

    const metrics = await processCatalogInBatches(
      fixture,
      (batch) => {
        taskSizes.push(batch.length);
        processed.push(...batch.map((item) => item.id));
      },
      { yieldControl: async () => { yields += 1; } }
    );

    expect(PRODUCT_CATALOG_FIRST_BATCH_SIZE).toBe(80);
    expect(metrics).toEqual({ itemCount: 10_000, batchCount: 100, maxItemsPerBatch: 100 });
    expect(Math.max(...taskSizes)).toBe(100);
    expect(yields).toBe(99);
    expect(processed).toHaveLength(10_000);
  });

  it('updates and removes barcode, presentation, and variant entries without rebuilding unrelated entries', () => {
    const index = new ProductCatalogIndex();
    const original = product('p1', {
      barcode: 'base-1',
      presentations: [{ id: 'case', name: 'Caja', multiplier: 12, barcode: 'case-1' } as any],
      variants: [{ id: 'red', name: 'Rojo', barcode: 'variant-1', sku: 'sku-red' } as any],
    });
    const untouched = product('p2', { barcode: 'base-2' });
    index.upsert(original);
    index.upsert(untouched);

    expect(index.get('CASE 1')?.matchedPresentation?.id).toBe('case');
    expect(index.get('variant-1')?.matchedVariant?.id).toBe('red');
    expect(index.get('sku-red')?.matchedVariant?.id).toBe('red');

    index.upsert({ ...original, barcode: 'base-new', presentations: [], variants: [] });
    expect(index.get('base-1')).toBeUndefined();
    expect(index.get('case-1')).toBeUndefined();
    expect(index.get('variant-1')).toBeUndefined();
    expect(index.get('base-new')?.product.id).toBe('p1');
    expect(index.get('base-2')?.product.id).toBe('p2');

    index.remove('p1');
    expect(index.get('base-new')).toBeUndefined();
    expect(index.get('base-2')?.product.id).toBe('p2');
  });

  it('removes a cached document and all of its index aliases during authoritative reconciliation', () => {
    const index = new ProductCatalogIndex();
    const cachedDeleted = product('cached-deleted', { barcode: 'gone-code' });
    const live = product('live', { barcode: 'live-code' });
    const map = new Map([[cachedDeleted.id, cachedDeleted], [live.id, live]]);
    index.upsert(cachedDeleted);
    index.upsert(live);

    removeCatalogProduct(map, index, cachedDeleted.id);

    expect(map.has('cached-deleted')).toBe(false);
    expect(index.get('gone-code')).toBeUndefined();
    expect(map.has('live')).toBe(true);
    expect(index.get('live-code')?.product.id).toBe('live');
  });

  it('keeps barcode collision priority compatible with the previous full index', () => {
    const index = new ProductCatalogIndex();
    index.upsert(product('a-sku', { sku: 'duplicate' }));
    index.upsert(product('z-sku', { sku: 'duplicate' }));
    index.upsert(product('a-primary', { barcode: 'barcode-wins' }));
    index.upsert(product('z-conditional', { sku: 'barcode-wins' }));
    index.upsert(product('z-primary', { barcode: 'duplicate-primary' }));
    index.upsert(product('a-primary-later', { barcode: 'duplicate-primary' }));

    expect(index.get('duplicate')?.product.id).toBe('a-sku');
    expect(index.get('barcode-wins')?.product.id).toBe('a-primary');
    expect(index.get('duplicate-primary')?.product.id).toBe('z-primary');
  });

  it('updates inventory KPIs and alerts incrementally with branch, inactive, and price rules', () => {
    const index = new ProductCatalogInventoryIndex('north');
    index.upsert(product('low', {
      costPrice: 5,
      stock: { north: 2, south: 20 },
    }));
    index.upsert(product('empty', { stock: { north: 0 } }));
    index.upsert(product('inactive', { active: false, stock: { north: 100 }, costPrice: 10 }));

    expect(index.snapshot()).toEqual({
      stats: {
        totalProducts: 2,
        skuCount: 2,
        totalInventoryValue: 10,
        valuation: 10,
        lowStockCount: 1,
        outOfStockCount: 1,
      },
      alerts: [
        { productId: 'low', name: 'low', currentStock: 2, minStock: 3 },
        { productId: 'empty', name: 'empty', currentStock: 0, minStock: 3 },
      ],
    });

    index.upsert(product('low', { costPrice: 5, stock: { north: 10 } }));
    index.remove('empty');
    expect(index.snapshot().stats).toEqual({
      totalProducts: 1,
      skuCount: 1,
      totalInventoryValue: 50,
      valuation: 50,
      lowStockCount: 0,
      outOfStockCount: 0,
    });
  });
});
