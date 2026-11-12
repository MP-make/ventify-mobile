import { describe, it } from 'vitest';
import type { Product } from '@/types';
import {
  ProductCatalogCategoryIndex,
  ProductCatalogIndex,
  ProductCatalogInventoryIndex,
} from '@/lib/product-catalog-index';
import { getIndexedCatalogProduct } from '@/lib/catalog-filters';
import { PRODUCT_CATALOG_FIRST_BATCH_SIZE, processCatalogInBatches } from '@/lib/product-catalog-loader';
import {
  getAllPresentations,
  getBranchStock,
  normalizeCode,
  type ScannedProductMatch,
} from '@/lib/product-search';

type FixtureDoc = { id: string; data: Record<string, unknown> };
type InventoryTotals = { totalProducts: number; totalInventoryValue: number; lowStockCount: number; outOfStockCount: number };
type Timings = { totalMs: number; maxSyncBlockMs: number; heartbeatMaxDelayMs: number };

const BRANCH_ID = 'branch-a';

function createFixture(count: number): FixtureDoc[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `product-${String(i).padStart(5, '0')}`;
    return {
      id,
      data: {
        accountId: 'account-fixture',
        name: `Producto de prueba ${i}`,
        category: `Categoría ${i % 20}`,
        sku: `SKU-${i}`,
        barcode: `750000${String(i).padStart(7, '0')}`,
        barcodes: [`ALT-${i}`],
        costPrice: 2.5 + (i % 100),
        suggestedPrice: 5 + (i % 200),
        minSalePrice: 2.5,
        stock: { [BRANCH_ID]: i % 25 },
        reservedStock: { [BRANCH_ID]: i % 7 },
        branchIds: [BRANCH_ID],
        lowStockBranches: [],
        branchPrices: {},
        imageUrl: '',
        thumbUrl: '',
        unitOfMeasure: 'unit',
        active: true,
        presentations: [
          { id: 'pack-6', name: 'Pack x6', conversionFactor: 6, barcode: `PACK6-${i}` },
          { id: 'box-12', name: 'Caja x12', conversionFactor: 12, barcode: `BOX12-${i}` },
        ],
        variants: [
          { id: 'red', name: 'Rojo', sku: `SKU-${i}-R`, barcode: `VAR-R-${i}`, stock: { [BRANCH_ID]: 1 } },
          { id: 'blue', name: 'Azul', sku: `SKU-${i}-B`, barcode: `VAR-B-${i}`, stock: { [BRANCH_ID]: 2 } },
        ],
      },
    };
  });
}

/** Mirrors ProductsContext.mapSnapshotDocs so both pipelines consume the same mapped shape. */
function mapSnapshotDoc(doc: FixtureDoc): Product {
  const data = doc.data;
  const baseCost = Number(data.costPrice ?? 0);
  const baseSuggested = Number(data.suggestedPrice ?? data.price ?? 0);
  const baseMin = Number(data.minSalePrice ?? baseCost);
  return {
    id: doc.id,
    name: String(data.name || 'Sin nombre'),
    category: String(data.category || 'General'),
    sku: String(data.sku || ''),
    barcode: String(data.barcode || ''),
    barcodes: Array.isArray(data.barcodes) ? data.barcodes as string[] : [],
    costPrice: baseCost,
    suggestedPrice: baseSuggested,
    price: baseSuggested,
    minSalePrice: baseMin,
    stock: typeof data.stock === 'object' && data.stock !== null ? data.stock as Record<string, number> : {},
    reservedStock: typeof data.reservedStock === 'object' && data.reservedStock !== null ? data.reservedStock as Record<string, number> : {},
    branchIds: Array.isArray(data.branchIds) ? data.branchIds as string[] : [],
    lowStockBranches: Array.isArray(data.lowStockBranches) ? data.lowStockBranches as string[] : [],
    branchPrices: data.branchPrices || {},
    variants: Array.isArray(data.variants) ? data.variants as Product['variants'] : [],
    priceTiers: Array.isArray(data.priceTiers) ? data.priceTiers as Product['priceTiers'] : [],
    imageUrl: String(data.imageUrl || ''),
    thumbUrl: String(data.thumbUrl || data.imageUrl || ''),
    hint: String(data.hint || ''),
    unitOfMeasure: (data.unitOfMeasure || 'unit') as Product['unitOfMeasure'],
    allowDecimals: Boolean(data.allowDecimals),
    stepDecimal: data.stepDecimal ? Number(data.stepDecimal) : undefined,
    active: data.active !== false,
    accountId: String(data.accountId || ''),
    ...data,
  } as Product;
}

/** Mirrors the previous full barcodeIndex useMemo in ProductsContext. */
function buildBaselineIndex(products: Product[]): Map<string, ScannedProductMatch> {
  const map = new Map<string, ScannedProductMatch>();
  for (const product of products) {
    if (product.active === false) continue;
    if (product.barcode) {
      const normalized = normalizeCode(product.barcode);
      if (normalized) map.set(normalized, { product });
    }
    if (product.sku) {
      const normalized = normalizeCode(product.sku);
      if (normalized && !map.has(normalized)) map.set(normalized, { product });
    }
    for (const code of Array.isArray(product.barcodes) ? product.barcodes : []) {
      const normalized = normalizeCode(code);
      if (normalized && !map.has(normalized)) map.set(normalized, { product });
    }
    for (const presentation of getAllPresentations(product)) {
      if (!presentation.barcode) continue;
      const normalized = normalizeCode(presentation.barcode);
      if (normalized) map.set(normalized, { product, matchedPresentation: presentation });
    }
    for (const variant of Array.isArray(product.variants) ? product.variants : []) {
      if (variant.barcode) {
        const normalized = normalizeCode(variant.barcode);
        if (normalized) map.set(normalized, { product, matchedVariant: variant });
      }
      if (variant.sku) {
        const normalized = normalizeCode(variant.sku);
        if (normalized && !map.has(normalized)) map.set(normalized, { product, matchedVariant: variant });
      }
    }
  }
  return map;
}

function calculateInventoryTotals(products: Product[]): InventoryTotals {
  let totalInventoryValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  let totalProducts = 0;
  for (const product of products) {
    if (product.active === false) continue;
    totalProducts += 1;
    const stock = getBranchStock(product, BRANCH_ID);
    const minimum = Number((product as any).minStock ?? 3);
    const cost = Number(product.costPrice ?? (product.suggestedPrice ? product.suggestedPrice * 0.7 : 0));
    if (stock > 0) totalInventoryValue += stock * cost;
    if (stock <= 0) outOfStockCount += 1;
    else if (stock <= minimum) lowStockCount += 1;
  }
  return {
    totalProducts,
    totalInventoryValue: Math.round(totalInventoryValue * 100) / 100,
    lowStockCount,
    outOfStockCount,
  };
}

function calculateCategories(products: Product[]): string[] {
  const categories = new Set<string>();
  for (const product of products) {
    if (product.active !== false && product.category) categories.add(product.category.trim());
  }
  return ['Todos', ...Array.from(categories).sort((a, b) => a.localeCompare(b))];
}

function startHeartbeat() {
  let stopped = false;
  let maxDelayMs = 0;
  let dueAt = performance.now() + 1;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, Math.max(0, now - dueAt));
    dueAt = now + 1;
    timer = setTimeout(tick, 1);
  };
  timer = setTimeout(tick, 1);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      return maxDelayMs;
    },
  };
}

function timeSyncBlock<T>(work: () => T, timings: Timings): T {
  const startedAt = performance.now();
  const result = work();
  timings.maxSyncBlockMs = Math.max(timings.maxSyncBlockMs, performance.now() - startedAt);
  return result;
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

describe('catalog performance benchmark (informational timings)', () => {
  it('compares full snapshot work with bounded initial batches and one stock update', async () => {
    const reports: string[] = [];
    for (const count of [1_500, 8_000, 20_000]) {
      const docs = createFixture(count);
      const changedDocIndex = Math.floor(count / 2);
      const changedDoc = {
        ...docs[changedDocIndex],
        data: { ...docs[changedDocIndex].data, stock: { [BRANCH_ID]: 99 } },
      };

      const baselineHeartbeat = startHeartbeat();
      const baselineTiming: Timings = { totalMs: 0, maxSyncBlockMs: 0, heartbeatMaxDelayMs: 0 };
      const baselineStart = performance.now();
      const baselineProducts = timeSyncBlock(() => docs.map(mapSnapshotDoc), baselineTiming);
      const baselineIndex = timeSyncBlock(() => buildBaselineIndex(baselineProducts), baselineTiming);
      timeSyncBlock(() => calculateCategories(baselineProducts), baselineTiming);
      const baselineStats = timeSyncBlock(() => calculateInventoryTotals(baselineProducts), baselineTiming);
      baselineTiming.totalMs = performance.now() - baselineStart;
      await new Promise((resolve) => setTimeout(resolve, 2));
      baselineTiming.heartbeatMaxDelayMs = baselineHeartbeat.stop();

      const optimizedHeartbeat = startHeartbeat();
      const optimizedTiming: Timings = { totalMs: 0, maxSyncBlockMs: 0, heartbeatMaxDelayMs: 0 };
      const optimizedStart = performance.now();
      const optimizedProductMap = new Map<string, Product>();
      let optimizedProducts: Product[] = [];
      const optimizedIndex = new ProductCatalogIndex();
      const optimizedInventory = new ProductCatalogInventoryIndex(BRANCH_ID);
      const optimizedCategory = new ProductCatalogCategoryIndex();
      const firstBatchMetrics = await processCatalogInBatches(
        docs.slice(0, PRODUCT_CATALOG_FIRST_BATCH_SIZE),
        (batch) => timeSyncBlock(() => {
          for (const doc of batch) {
            const product = mapSnapshotDoc(doc);
            getIndexedCatalogProduct(product);
            optimizedProductMap.set(product.id, product);
            optimizedIndex.upsert(product);
            optimizedInventory.upsert(product);
            optimizedCategory.upsert(product);
          }
        }, optimizedTiming),
      );
      // The provider publishes the small first query before processing the complete listener snapshot.
      optimizedProducts = timeSyncBlock(() => Array.from(optimizedProductMap.values()), optimizedTiming);
      const firstBatchInventory = timeSyncBlock(() => optimizedInventory.snapshot(), optimizedTiming);
      const firstBatchCategories = timeSyncBlock(() => optimizedCategory.snapshot(), optimizedTiming);
      const batchMetrics = await processCatalogInBatches(
        docs,
        (batch) => timeSyncBlock(() => {
          const mappedBatch = batch.map(mapSnapshotDoc);
          for (const product of mappedBatch) {
            getIndexedCatalogProduct(product);
            optimizedProductMap.set(product.id, product);
            optimizedIndex.upsert(product);
            optimizedInventory.upsert(product);
            optimizedCategory.upsert(product);
          }
        }, optimizedTiming),
      );
      // The provider publishes the completed full snapshot once, after all bounded mapping tasks.
      optimizedProducts = timeSyncBlock(() => Array.from(optimizedProductMap.values()), optimizedTiming);
      const optimizedSummary = timeSyncBlock(() => optimizedInventory.snapshot(), optimizedTiming);
      const optimizedCategories = timeSyncBlock(() => optimizedCategory.snapshot(), optimizedTiming);
      optimizedTiming.totalMs = performance.now() - optimizedStart;
      await new Promise((resolve) => setTimeout(resolve, 2));
      optimizedTiming.heartbeatMaxDelayMs = optimizedHeartbeat.stop();

      const baselineMutationTiming: Timings = { totalMs: 0, maxSyncBlockMs: 0, heartbeatMaxDelayMs: 0 };
      const baselineMutationStart = performance.now();
      const nextDocs = docs.slice();
      nextDocs[changedDocIndex] = changedDoc;
      const baselineMutationProducts = timeSyncBlock(() => nextDocs.map(mapSnapshotDoc), baselineMutationTiming);
      const baselineMutationIndex = timeSyncBlock(() => buildBaselineIndex(baselineMutationProducts), baselineMutationTiming);
      timeSyncBlock(() => calculateCategories(baselineMutationProducts), baselineMutationTiming);
      const baselineMutationStats = timeSyncBlock(() => calculateInventoryTotals(baselineMutationProducts), baselineMutationTiming);
      const baselineMutationMs = performance.now() - baselineMutationStart;

      const optimizedMutationTiming: Timings = { totalMs: 0, maxSyncBlockMs: 0, heartbeatMaxDelayMs: 0 };
      const optimizedMutationStart = performance.now();
      const changedProduct = timeSyncBlock(() => mapSnapshotDoc(changedDoc), optimizedMutationTiming);
      timeSyncBlock(() => getIndexedCatalogProduct(changedProduct), optimizedMutationTiming);
      timeSyncBlock(() => optimizedProductMap.set(changedProduct.id, changedProduct), optimizedMutationTiming);
      timeSyncBlock(() => optimizedIndex.upsert(changedProduct), optimizedMutationTiming);
      timeSyncBlock(() => optimizedInventory.upsert(changedProduct), optimizedMutationTiming);
      const categoryChanged = timeSyncBlock(() => optimizedCategory.upsert(changedProduct), optimizedMutationTiming);
      optimizedProducts = timeSyncBlock(() => Array.from(optimizedProductMap.values()), optimizedMutationTiming);
      const optimizedMutationSummary = timeSyncBlock(() => optimizedInventory.snapshot(), optimizedMutationTiming);
      if (categoryChanged) timeSyncBlock(() => optimizedCategory.snapshot(), optimizedMutationTiming);
      const optimizedMutationMs = performance.now() - optimizedMutationStart;

      // Functional checks are stable; recorded timings are informational and have no threshold.
      if (baselineProducts.length !== count || optimizedProducts.length !== count) throw new Error(`Expected ${count} products`);
      if (baselineStats.totalProducts !== count || optimizedSummary.stats.totalProducts !== count) throw new Error('Initial KPI totals differ');
      if (baselineStats.totalInventoryValue !== optimizedSummary.stats.totalInventoryValue) throw new Error('Initial inventory values differ');
      if (JSON.stringify(calculateCategories(baselineProducts)) !== JSON.stringify(optimizedCategories)) throw new Error('Initial category totals differ');
      if (baselineMutationStats.totalInventoryValue !== optimizedMutationSummary.stats.totalInventoryValue) throw new Error('Mutation KPI totals differ');
      const changedProductNumber = String(Number(changedDoc.id.split('-').at(-1)));
      if (baselineIndex.get(normalizeCode(`BOX12-${changedProductNumber}`))?.matchedPresentation?.id !== 'box-12') throw new Error('Baseline presentation barcode lookup failed');
      if (optimizedIndex.get(`BOX12-${changedProductNumber}`)?.matchedPresentation?.id !== 'box-12') throw new Error('Optimized presentation barcode lookup failed');
      if (baselineMutationIndex.get(normalizeCode(`SKU-${changedProductNumber}`))?.product.id !== changedProduct.id) throw new Error('Baseline SKU lookup failed');
      if (optimizedIndex.get(`SKU-${changedProductNumber}`)?.product.id !== changedProduct.id) throw new Error('Optimized SKU lookup failed');

      reports.push(
        `N=${count}: load baseline ${formatMs(baselineTiming.totalMs)} ms, max sync ${formatMs(baselineTiming.maxSyncBlockMs)} ms, heartbeat delay ${formatMs(baselineTiming.heartbeatMaxDelayMs)} ms; ` +
        `batched/index ${formatMs(optimizedTiming.totalMs)} ms, max chunk ${formatMs(optimizedTiming.maxSyncBlockMs)} ms, heartbeat delay ${formatMs(optimizedTiming.heartbeatMaxDelayMs)} ms, batches=${firstBatchMetrics.batchCount + batchMetrics.batchCount}, maxItems=${Math.max(firstBatchMetrics.maxItemsPerBatch, batchMetrics.maxItemsPerBatch)}; ` +
        `stock update baseline ${formatMs(baselineMutationMs)} ms (max sync ${formatMs(baselineMutationTiming.maxSyncBlockMs)} ms) vs changed-doc/index + incremental KPI ${formatMs(optimizedMutationMs)} ms (max sync ${formatMs(optimizedMutationTiming.maxSyncBlockMs)} ms)`,
      );
    }
    console.info(`Catalog benchmark (synthetic fixtures; no device/network):\n${reports.join('\n')}`);
  }, 30_000);
});
