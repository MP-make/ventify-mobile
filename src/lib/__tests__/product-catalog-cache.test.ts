import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@/types';
import {
  clearProductCatalogDelta,
  getProductCatalogDeltaCount,
  loadProductCatalogCache,
  productCatalogCacheKey,
  productCatalogDeltaKey,
  readProductCatalogManifestSync,
  writeProductCatalogCache,
  writeProductCatalogDelta,
} from '@/lib/product-catalog-cache';

class MemoryStorage {
  values = new Map<string, string>();
  trimCalls = 0;
  isSyncCapable = false;
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
  async trim() { this.trimCalls += 1; }
}

class SyncMemoryStorage extends MemoryStorage {
  override isSyncCapable = true;
  getItemSync(key: string) { return this.values.get(key) ?? null; }
  setItemSync(key: string, value: string) { this.values.set(key, value); }
  removeItemSync(key: string) { this.values.delete(key); }
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
    expect(storage.trimCalls).toBe(0);

    await writeProductCatalogCache(storage, key, [fixture('compacted')], {
      generation: 'compacted-generation',
      trimAfterWrite: true,
      lastSyncMs: 555_000,
      allDocsHaveUpdatedAt: true,
    });
    expect(storage.trimCalls).toBe(1);
    expect(JSON.parse(storage.values.get(`${key}:manifest`)!)).toMatchObject({
      generation: 'compacted-generation',
      lastSyncMs: 555_000,
      allDocsHaveUpdatedAt: true,
    });
  });

  it('reads manifests synchronously only when storage is sync-capable', async () => {
    const asyncStorage = new MemoryStorage();
    const syncStorage = new SyncMemoryStorage();
    const key = productCatalogCacheKey('u1', 'acc-sync', 'account');

    await writeProductCatalogCache(asyncStorage, key, [fixture('p-1')], {
      generation: 'g-async',
      now: 200,
    });
    expect(readProductCatalogManifestSync(key, asyncStorage)).toBeNull();

    await writeProductCatalogCache(syncStorage, key, [fixture('p-1')], {
      generation: 'g-sync',
      now: 300,
      lastSyncMs: 310,
      allDocsHaveUpdatedAt: true,
    });
    expect(readProductCatalogManifestSync(key, syncStorage)).toEqual({
      schema: 1,
      generation: 'g-sync',
      count: 1,
      chunks: 1,
      cachedAt: 300,
      lastSyncMs: 310,
      allDocsHaveUpdatedAt: true,
    });
  });

  it('merges delta upserts and deletes without trimming and overlays them during load', async () => {
    const storage = new SyncMemoryStorage();
    const accountId = 'acc-delta';
    const key = productCatalogCacheKey('u1', accountId, 'account');

    await writeProductCatalogCache(
      storage,
      key,
      [fixture('p-1'), fixture('p-2'), fixture('p-3')],
      { generation: 'base-gen', now: 1000, chunkSize: 2 }
    );

    const trimSpy = vi.spyOn(storage, 'trim');
    const res1 = await writeProductCatalogDelta(
      accountId,
      [{ ...fixture('p-2'), name: 'Updated P2' }, fixture('p-4')],
      ['p-1'],
      { storage, lastSyncMs: 1200 }
    );
    expect(res1.deltaCount).toBe(3);
    expect(trimSpy).not.toHaveBeenCalled();

    // Subsequent delta re-creates p-1 and deletes p-4 and p-3
    const res2 = await writeProductCatalogDelta(
      accountId,
      [{ ...fixture('p-1'), name: 'Recreated P1' }],
      ['p-4', 'p-3'],
      { storage, lastSyncMs: 1500 }
    );
    expect(res2.deltaCount).toBe(4); // upserted: p-2, p-1; deleted: p-4, p-3
    expect(await getProductCatalogDeltaCount(accountId, storage)).toBe(4);
    expect(storage.values.has(productCatalogDeltaKey(accountId))).toBe(true);

    const loaded: Product[] = [];
    const result = await loadProductCatalogCache(
      storage,
      key,
      (chunk) => {
        loaded.push(...chunk);
      },
      { now: 1600, chunkSize: 2 }
    );

    expect(result).toEqual({ count: 2, cachedAt: 1000, expired: false });
    expect(loaded.map((p) => `${p.id}:${p.name}`)).toEqual([
      'p-1:Recreated P1',
      'p-2:Updated P2',
    ]);

    await clearProductCatalogDelta(accountId, storage);
    expect(await getProductCatalogDeltaCount(accountId, storage)).toBe(0);
    expect(storage.values.has(productCatalogDeltaKey(accountId))).toBe(false);
  });
});
