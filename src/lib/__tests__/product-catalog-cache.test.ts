import { describe, expect, it } from 'vitest';
import type { Product } from '@/types';
import {
  loadProductCatalogCache,
  productCatalogCacheKey,
  writeProductCatalogCache,
} from '@/lib/product-catalog-cache';

class MemoryStorage {
  values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

const fixture = (id: string): Product => ({
  id,
  name: `Product ${id}`,
  category: 'General',
  sku: id,
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
});

describe('product catalog persistent cache', () => {
  it('isolates snapshots by uid, account, and branch', () => {
    expect(productCatalogCacheKey('u1', 'a', 'b')).not.toBe(productCatalogCacheKey('u2', 'a', 'b'));
    expect(productCatalogCacheKey('u1', 'a', 'b')).not.toBe(productCatalogCacheKey('u1', 'a', 'c'));
    expect(productCatalogCacheKey('u1', 'a', 'b')).not.toBe(productCatalogCacheKey('u1', 'x', 'b'));
  });

  it('round-trips all 10k products through bounded chunks and publishes the manifest last', async () => {
    const storage = new MemoryStorage();
    const key = productCatalogCacheKey('u1', 'a', 'main');
    const products = Array.from({ length: 10_000 }, (_, index) => fixture(`p-${index}`));
    const committed = await writeProductCatalogCache(storage, key, products, {
      generation: 'generation-1', now: 100, chunkSize: 150,
    });

    expect(committed).toBe(true);
    expect(JSON.parse(storage.values.get(`${key}:manifest`)!).count).toBe(10_000);
    const restored: string[] = [];
    let chunkSizes: number[] = [];
    const result = await loadProductCatalogCache(storage, key, (chunk) => {
      chunkSizes.push(chunk.length);
      restored.push(...chunk.map((item) => item.id));
    }, { now: 101, chunkSize: 150, yieldControl: async () => {} });

    expect(result).toEqual({ count: 10_000, cachedAt: 100, expired: false });
    expect(restored).toHaveLength(10_000);
    expect(restored[0]).toBe('p-0');
    expect(restored.at(-1)).toBe('p-9999');
    expect(Math.max(...chunkSizes)).toBe(150);
  });

  it('does not expose a write from a stale account scope', async () => {
    const storage = new MemoryStorage();
    const key = productCatalogCacheKey('u1', 'a', 'main');
    const committed = await writeProductCatalogCache(storage, key, [fixture('old')], {
      generation: 'stale', isCurrent: () => false,
    });

    expect(committed).toBe(false);
    expect(storage.values.has(`${key}:manifest`)).toBe(false);
    expect(await loadProductCatalogCache(storage, key, () => {})).toBeNull();
  });

  it('removes the previous generation chunks only after a replacement manifest is committed', async () => {
    const storage = new MemoryStorage();
    const key = productCatalogCacheKey('u1', 'a', 'main');
    await writeProductCatalogCache(storage, key, [fixture('old-1'), fixture('old-2')], {
      generation: 'old-generation', chunkSize: 1,
    });
    await writeProductCatalogCache(storage, key, [fixture('new')], {
      generation: 'new-generation', chunkSize: 1,
    });

    expect(storage.values.has(`${key}:data:old-generation:0`)).toBe(false);
    expect(storage.values.has(`${key}:data:old-generation:1`)).toBe(false);
    expect(storage.values.has(`${key}:data:new-generation:0`)).toBe(true);
    expect(JSON.parse(storage.values.get(`${key}:manifest`)!).generation).toBe('new-generation');
  });
});
