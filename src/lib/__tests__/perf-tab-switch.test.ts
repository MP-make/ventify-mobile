import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const netInfoState = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    fetch: () => netInfoState.fetch(),
  },
}));

import type { Product } from '@/types';
import { MutableCatalogProductIndex } from '@/lib/catalog-filters';
import { checkIsOnlineLive } from '@/lib/online-guard';
import {
  PRODUCT_CATALOG_CACHE_CHUNK_SIZE,
  productCatalogCacheKey,
  writeProductCatalogCache,
  writeProductCatalogDelta,
} from '@/lib/product-catalog-cache';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const makeProduct = (id: string, overrides: Partial<Product> = {}): Product => ({
  id,
  name: `Product ${id}`,
  category: 'Bebidas',
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
  ...overrides,
});

describe('tab-switch and 8k catalog performance regressions', () => {
  afterEach(() => {
    vi.useRealTimers();
    netInfoState.fetch.mockReset();
    netInfoState.fetch.mockImplementation(async () => ({
      isConnected: true,
      isInternetReachable: true,
    }));
  });

  it('resolves every lucide-react-native named import in app/ and src/ to an existing icon module', () => {
    const pluginFactory = require(path.join(
      WORKSPACE_ROOT,
      'plugins/babel-plugin-lucide-direct-imports.js'
    ));
    const t = require('@babel/types');
    const plugin = pluginFactory({ types: t });

    const files = [
      ...collectTsFiles(path.join(WORKSPACE_ROOT, 'app')),
      ...collectTsFiles(path.join(WORKSPACE_ROOT, 'src')),
    ];
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react-native['"]\s*;/g;
    const importedNames = new Set<string>();

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        for (const rawPart of match[1].split(',')) {
          const clean = rawPart.trim();
          if (!clean || clean.startsWith('type ')) continue;
          const [imported] = clean.split(/\s+as\s+/);
          if (imported) importedNames.add(imported.trim());
        }
      }
    }

    expect(importedNames.size).toBeGreaterThan(20);

    for (const iconName of importedNames) {
      let replacedTargets: string[] | null = null;
      const spec = t.importSpecifier(t.identifier(iconName), t.identifier(iconName));
      const decl = t.importDeclaration([spec], t.stringLiteral('lucide-react-native'));
      plugin.visitor.ImportDeclaration({
        node: decl,
        replaceWith: () => {},
        replaceWithMultiple: (nodes: any[]) => {
          replacedTargets = nodes.map((n) => n.source.value);
        },
      });
      expect(replacedTargets, `Expected direct import rewrite for ${iconName}`).toBeTruthy();
      const iconPath = path.join(WORKSPACE_ROOT, 'node_modules', replacedTargets![0]);
      expect(fs.existsSync(iconPath), `Missing lucide icon module: ${iconPath}`).toBe(true);
    }
  });

  it('keeps MutableCatalogProductIndex.categoryCountsVersion constant on stock/price-only updates', () => {
    const index = new MutableCatalogProductIndex();
    const p1 = makeProduct('p1', { category: 'Abarrotes', stock: { main: 5 }, price: 10 });
    index.upsert(p1);
    const vAfterInsert = index.snapshot().categoryCountsVersion!;
    expect(vAfterInsert).toBeGreaterThan(0);

    // Stock + price + name update (same category) must NOT bump categoryCountsVersion
    index.upsert(
      makeProduct('p1', {
        name: 'Updated p1',
        category: 'Abarrotes',
        stock: { main: 4 },
        price: 12,
      })
    );
    expect(index.snapshot().categoryCountsVersion).toBe(vAfterInsert);

    // Category change MUST bump categoryCountsVersion
    index.upsert(makeProduct('p1', { category: 'Lacteos' }));
    const vAfterMove = index.snapshot().categoryCountsVersion!;
    expect(vAfterMove).toBeGreaterThan(vAfterInsert);

    // Removal MUST bump categoryCountsVersion
    index.remove('p1');
    expect(index.snapshot().categoryCountsVersion).toBeGreaterThan(vAfterMove);
  });

  it('times out hung NetInfo.fetch() calls in checkIsOnlineLive after 2.5s', async () => {
    let onFetchStarted: (() => void) | null = null;
    netInfoState.fetch.mockImplementation(
      () =>
        new Promise(() => {
          onFetchStarted?.();
        })
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const startedFalse = new Promise<void>((resolve) => {
      onFetchStarted = resolve;
    });
    const pendingFalse = checkIsOnlineLive(false);
    await startedFalse;
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pendingFalse).resolves.toBe(false);

    const startedTrue = new Promise<void>((resolve) => {
      onFetchStarted = resolve;
    });
    const pendingTrue = checkIsOnlineLive(true);
    await startedTrue;
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pendingTrue).resolves.toBe(true);
  });

  it('uses smaller default catalog cache chunks and writes deltas without calling trim', async () => {
    expect(PRODUCT_CATALOG_CACHE_CHUNK_SIZE).toBe(60);

    const values = new Map<string, string>();
    let trimCalls = 0;
    const storage = {
      isSyncCapable: true,
      getItemSync: (key: string) => values.get(key) ?? null,
      setItemSync: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItemSync: (key: string) => {
        values.delete(key);
      },
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
      trim: async () => {
        trimCalls += 1;
      },
    };

    const key = productCatalogCacheKey('u1', 'acc-chunk', 'account');
    const items = Array.from({ length: 130 }, (_, i) => makeProduct(`item-${i}`));
    const committed = await writeProductCatalogCache(storage, key, items, {
      generation: 'g1',
      yieldControl: async () => {},
    });
    expect(committed).toBe(true);
    expect(JSON.parse(values.get(`${key}:manifest`)!).chunks).toBe(3);

    const delta = await writeProductCatalogDelta('acc-chunk', [makeProduct('item-1', { price: 99 })], [], {
      storage,
    });
    expect(delta.deltaCount).toBe(1);
    expect(trimCalls).toBe(0);
  });
});
