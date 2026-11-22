import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiState = vi.hoisted(() => ({
  user: { uid: 'u1', getIdToken: vi.fn(async () => 'token-123') } as any,
}));

vi.mock('@/lib/firebase', () => ({
  auth: {
    get currentUser() {
      return apiState.user;
    },
  },
  APP_URL: 'https://example.test',
}));

import { ProductCatalogIndex, removeCatalogProduct } from '../product-catalog-index';
import { buildCatalogProductIndex, filterCatalogIndex } from '../catalog-filters';
import { ApiError, apiRawRequest, apiRequest, getApiRequestInit } from '../api-client';
import { MemoryTtlCache } from '../request-cache';
import { formatPEN } from '../theme';
import { sanitizeRemoteImageUrls } from '../product-normalization';
import { findProductByBarcode, resolveProductBranchStock } from '../product-search';
import { buildQrSvgMarkup, generateQrMatrix } from '../invoicing/qr-matrix';
import { uint8ArrayToBase64 } from '../printing/escpos-builder';

function extractSvgPathData(svg: string): string {
  const match = svg.match(/<path d="([^"]*)"/);
  return match ? match[1] : '';
}

function rasterizeHorizontalRunPath(pathData: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const cmdRegex = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  let match: RegExpExecArray | null;
  while ((match = cmdRegex.exec(pathData)) !== null) {
    const startX = Number(match[1]);
    const y = Number(match[2]);
    const width = Number(match[3]);
    for (let dx = 0; dx < width; dx++) {
      grid[y][startX + dx] = true;
    }
  }
  return grid;
}

describe('performance optimization regressions & utilities', () => {
  beforeEach(() => {
    apiState.user = { uid: 'u1', getIdToken: vi.fn(async () => 'token-123') };
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('ProductCatalogIndex', () => {
    it('indexes single entries, handles collisions/tie-breaks, and cleans up on remove', () => {
      const index = new ProductCatalogIndex();
      const prodA = {
        id: 'prod-a',
        name: 'Producto A',
        barcode: '7750001',
        sku: 'SHARED-CODE',
        active: true,
      } as any;
      const prodB = {
        id: 'prod-b',
        name: 'Producto B',
        barcode: '7750002',
        sku: 'SHARED-CODE',
        active: true,
      } as any;
      const prodC = {
        id: 'prod-c',
        name: 'Producto C',
        barcode: 'SHARED-CODE',
        presentations: [{ id: 'pack', name: 'Pack x6', factor: 6, price: 30, barcode: 'PACK-01' }],
        active: true,
      } as any;

      index.upsert(prodA);
      expect(index.get('7750001')?.product.id).toBe('prod-a');
      expect(index.get('shared-code')?.product.id).toBe('prod-a');

      // Both prodA & prodB only claim SHARED-CODE via conditional SKU: lowest id ('prod-a') wins
      index.upsert(prodB);
      expect(index.get('SHARED-CODE')?.product.id).toBe('prod-a');

      // prodC claims SHARED-CODE via primary unconditional barcode: unconditional wins over conditional SKUs
      index.upsert(prodC);
      expect(index.get('SHARED-CODE')?.product.id).toBe('prod-c');
      expect(index.get('pack-01')?.matchedPresentation?.id).toBe('pack');

      // Multiple unconditional writers tie-break by highest productId localeCompare
      const prodD = {
        id: 'prod-d',
        name: 'Producto D',
        barcode: 'SHARED-CODE',
        active: true,
      } as any;
      index.upsert(prodD);
      expect(index.get('SHARED-CODE')?.product.id).toBe('prod-d');

      // Removing prodD and prodC restores prodA; removing remaining leaves undefined
      const map = new Map<string, any>([
        ['prod-a', prodA],
        ['prod-b', prodB],
        ['prod-c', prodC],
        ['prod-d', prodD],
      ]);
      removeCatalogProduct(map, index, 'prod-d');
      expect(map.has('prod-d')).toBe(false);
      expect(index.get('SHARED-CODE')?.product.id).toBe('prod-c');

      index.remove('prod-c');
      expect(index.get('PACK-01')).toBeUndefined();
      expect(index.get('SHARED-CODE')?.product.id).toBe('prod-a');

      index.remove('prod-a');
      expect(index.get('7750001')).toBeUndefined();
      expect(index.get('SHARED-CODE')?.product.id).toBe('prod-b');

      index.remove('prod-b');
      expect(index.get('SHARED-CODE')).toBeUndefined();
    });
  });

  describe('buildCatalogProductIndex & filterCatalogIndex', () => {
    it('supports accent-insensitive categories, uncategorized lookup, and result limits', () => {
      const products = [
        { id: '1', name: 'Té Helado Durazno', category: 'Bebidas Frías', brand: 'Ventify', sizeLabel: '500 ml' },
        { id: '2', name: 'Gaseosa Cola', category: 'Bebidas Frías', brand: 'Inka', sizeLabel: '1L' },
        { id: '3', name: 'Café Espresso', category: 'Bebidas Frías', brand: 'Ventify', sizeLabel: '250 ml' },
        { id: '4', name: 'Bolsa Ecológica', category: '' },
      ] as any[];

      const index = buildCatalogProductIndex(products);

      const accentInsensitive = filterCatalogIndex(index, { category: 'bebidas frias' });
      expect(accentInsensitive.map((p) => p.id)).toEqual(['1', '2', '3']);

      const limited = filterCatalogIndex(index, { category: 'BEBIDAS FRIAS', limit: 2 });
      expect(limited.map((p) => p.id)).toEqual(['1', '2']);

      const uncategorized = filterCatalogIndex(index, { category: 'sin categoria' });
      expect(uncategorized.map((p) => p.id)).toEqual(['4']);

      const combined = filterCatalogIndex(index, { category: 'bebidas frias', brand: 'ventify', query: 'cafe' });
      expect(combined.map((p) => p.id)).toEqual(['3']);
    });
  });

  describe('api-client timeout, signal cancellation & GET headers', () => {
    it('omits Content-Type on bodyless GET requests and keeps it on JSON POST bodies', async () => {
      const getInit = await getApiRequestInit('/api/orders');
      const getHeaders = getInit.init.headers as Record<string, string>;
      expect(getInit.init.method).toBe('GET');
      expect(getHeaders['Content-Type']).toBeUndefined();
      expect(getHeaders['x-ventify-client']).toBe('v3');

      const postInit = await getApiRequestInit('/api/orders', { method: 'POST', body: { ok: true } });
      const postHeaders = postInit.init.headers as Record<string, string>;
      expect(postHeaders['Content-Type']).toBe('application/json');
    });

    it('enforces timeout (408) even when an external AbortSignal is passed', async () => {
      vi.useFakeTimers();
      const externalController = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })
        )
      );

      const pending = apiRequest('/api/slow', {
        signal: externalController.signal,
        timeoutMs: 1500,
      });
      const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    });

    it('distinguishes external AbortSignal (499 ABORTED) from timeout (408)', async () => {
      vi.useFakeTimers();
      const externalController = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })
        )
      );

      const pending = apiRawRequest('/api/stream', {
        signal: externalController.signal,
        timeoutMs: 5000,
      });
      externalController.abort();

      await expect(pending).rejects.toBeInstanceOf(ApiError);
      await expect(pending).rejects.toMatchObject({ status: 499, code: 'ABORTED' });
    });
  });

  describe('qr-matrix horizontal-run SVG & LRU cache', () => {
    it('merges contiguous dark modules horizontally and matches boolean matrix parity + LRU hits', () => {
      const payload = '20512345678|01|F001|123|18.00|118.00|2026-11-12|6|20100070970';
      const qr = generateQrMatrix(payload);
      const svgFirst = buildQrSvgMarkup(payload, 128, 2);
      const svgSecond = buildQrSvgMarkup(payload, 128, 2);

      expect(svgSecond).toBe(svgFirst);
      const pathData = extractSvgPathData(svgFirst);
      expect(pathData).toBe(qr.pathData);
      // Finder top bar spans 7 horizontal modules -> merged into h7 runs instead of 7x h1 runs
      expect(pathData).toContain('h7v1h-7z');

      const rasterized = rasterizeHorizontalRunPath(pathData, qr.size);
      expect(rasterized).toEqual(qr.matrix);
    });
  });

  describe('uint8ArrayToBase64', () => {
    it('matches Node Buffer base64 across 0, 1, 2, 3, and 0..255 byte patterns', () => {
      const patterns = [
        new Uint8Array([]),
        new Uint8Array([0x1b]),
        new Uint8Array([0x1b, 0x40]),
        new Uint8Array([0x1b, 0x40, 0x41]),
        new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x0a, 0x1d, 0x56]),
        Uint8Array.from({ length: 256 }, (_, idx) => idx),
        Uint8Array.from({ length: 257 }, (_, idx) => (idx * 37) & 0xff),
      ];

      for (const bytes of patterns) {
        const expected = Buffer.from(bytes).toString('base64');
        expect(uint8ArrayToBase64(bytes)).toBe(expected);
      }
    });
  });

  describe('MemoryTtlCache epoch / generation guards', () => {
    it('prevents an older in-flight loader from populating cache after clear()', async () => {
      const cache = new MemoryTtlCache(10);
      let resolveOld!: (v: string) => void;
      const oldLoad = cache.getOrLoad('sellers:b1', 60_000, () => new Promise<string>((r) => { resolveOld = r; }));

      cache.clear();
      resolveOld('stale-after-clear');
      await expect(oldLoad).resolves.toBe('stale-after-clear');
      expect(cache.get('sellers:b1')).toBeUndefined();
    });

    it('prevents an older in-flight loader from populating cache after invalidate(key) or invalidatePrefix()', async () => {
      const cache = new MemoryTtlCache(10);
      let resolveOld!: (v: string) => void;
      const oldLoad = cache.getOrLoad('sellers:b1', 60_000, () => new Promise<string>((r) => { resolveOld = r; }));

      cache.invalidate('sellers:b1');
      let resolveFresh!: (v: string) => void;
      const freshLoad = cache.getOrLoad('sellers:b1', 60_000, () => new Promise<string>((r) => { resolveFresh = r; }));

      resolveFresh('fresh');
      await expect(freshLoad).resolves.toBe('fresh');
      expect(cache.get('sellers:b1')).toBe('fresh');

      resolveOld('stale-after-invalidate');
      await expect(oldLoad).resolves.toBe('stale-after-invalidate');
      expect(cache.get('sellers:b1')).toBe('fresh');

      let resolvePrefixed!: (v: string) => void;
      const prefixedLoad = cache.getOrLoad('sellers:b2', 60_000, () => new Promise<string>((r) => { resolvePrefixed = r; }));
      cache.invalidatePrefix('sellers:');
      resolvePrefixed('stale-prefixed');
      await expect(prefixedLoad).resolves.toBe('stale-prefixed');
      expect(cache.get('sellers:b2')).toBeUndefined();
    });

    it('bypasses inFlight and prevents stale overwrite when forceRefresh is true', async () => {
      const cache = new MemoryTtlCache(10);
      let resolveOld!: (v: string) => void;
      let resolveForced!: (v: string) => void;

      const oldPromise = cache.getOrLoad('k', 60_000, () => new Promise<string>((r) => { resolveOld = r; }));
      const forcedPromise = cache.getOrLoad(
        'k',
        60_000,
        () => new Promise<string>((r) => { resolveForced = r; }),
        { forceRefresh: true }
      );
      expect(forcedPromise).not.toBe(oldPromise);

      resolveForced('forced-value');
      await expect(forcedPromise).resolves.toBe('forced-value');
      expect(cache.get('k')).toBe('forced-value');

      resolveOld('stale-value');
      await expect(oldPromise).resolves.toBe('stale-value');
      expect(cache.get('k')).toBe('forced-value');
    });
  });

  describe('Single-code index, branch prices, currency & image fast-paths', () => {
    it('indexes single-code products and branch presentation barcodes cleanly', () => {
      const index = new ProductCatalogIndex();
      const single = { id: 's1', name: 'Single', barcode: '7759001', sku: '7759001', active: true } as any;
      const multi = {
        id: 'm1',
        name: 'Multi',
        branchPrices: {
          b1: { presentations: [{ id: 'bp-1', name: 'Pack', conversionFactor: 6, price: 20, barcode: 'BP-CODE' }] },
        },
        active: true,
      } as any;

      index.upsert(single);
      index.upsert(multi);
      expect(index.get('7759001')?.product.id).toBe('s1');
      expect(index.get('bp-code')?.matchedPresentation?.id).toBe('bp-1');
      expect(findProductByBarcode([single, multi], 'bp-code')?.matchedPresentation?.id).toBe('bp-1');

      index.remove('s1');
      expect(index.get('7759001')).toBeUndefined();
    });

    it('fast-paths formatPEN under 1000 without losing rounding boundary commas', () => {
      expect(formatPEN(0)).toBe('S/ 0.00');
      expect(formatPEN(999.99)).toBe('S/ 999.99');
      expect(formatPEN(-42.5)).toBe('-S/ 42.50');
      expect(formatPEN(999.999)).toBe('S/ 1,000.00');
      expect(formatPEN(1234567.8)).toBe('S/ 1,234,567.80');
      expect(formatPEN(Number.NaN)).toBe('S/ 0.00');
    });

    it('fast-paths 1-element remote URLs and resolves principal fallback branch stock', () => {
      expect(sanitizeRemoteImageUrls([' https://cdn.test/img.jpg '])).toEqual(['https://cdn.test/img.jpg']);
      expect(sanitizeRemoteImageUrls(['file:///local/photo.jpg'])).toEqual([]);
      expect(sanitizeRemoteImageUrls(['https://cdn.test/a.jpg', 'https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'])).toEqual([
        'https://cdn.test/a.jpg',
        'https://cdn.test/b.jpg',
      ]);

      expect(resolveProductBranchStock({ stock: { 'Sucursal Principal': 14 } } as any, 'branch-2')).toBe(14);
      expect(resolveProductBranchStock({ stock: { 'branch-2': 7, main: 14 } } as any, 'branch-2')).toBe(7);
    });
  });

  describe('native-kv-storage sync methods, metaKVStorage, and multiRemove chunk yielding', () => {
    it('provides non-sync fallback with chunked multiRemove and exposes metaKVStorage', async () => {
      vi.resetModules();
      const removedBatches: string[][] = [];
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      vi.doMock('@react-native-async-storage/async-storage', () => ({
        default: {
          getItem: vi.fn(async () => null),
          setItem: vi.fn(async () => {}),
          removeItem: vi.fn(async () => {}),
          multiRemove: vi.fn(async (keys: string[]) => {
            removedBatches.push(keys);
          }),
        },
      }));

      const { createNativeKVStorage, metaKVStorage } = await import('../native-kv-storage');
      expect(metaKVStorage).toBeDefined();
      expect(metaKVStorage.isSyncCapable).toBe(false);
      expect(metaKVStorage.getItemSync('missing')).toBeNull();
      metaKVStorage.setItemSync('k', 'v');
      metaKVStorage.removeItemSync('k');

      const storage = createNativeKVStorage('test-async');
      const keys = Array.from({ length: 45 }, (_, i) => `k-${i}`);
      await storage.multiRemove(keys);

      expect(removedBatches.map((b) => b.length)).toEqual([20, 20, 5]);
      // 45 keys -> 3 batches -> 2 inter-batch yields
      expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 0).length).toBeGreaterThanOrEqual(2);
      setTimeoutSpy.mockRestore();
      vi.doUnmock('@react-native-async-storage/async-storage');
    });
  });
});
