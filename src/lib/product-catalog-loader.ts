/** Small first render batch and bounded mapping work for large Firestore snapshots. */
export const PRODUCT_CATALOG_FIRST_BATCH_SIZE = 80;
export const PRODUCT_CATALOG_WORK_BATCH_SIZE = 100;
export const PRODUCT_CATALOG_YIELD_BUDGET_MS = 3.5;
const EMPTY_ARRAY: never[] = [];

export interface CatalogBatchMetrics {
  itemCount: number;
  batchCount: number;
  maxItemsPerBatch: number;
}

export type YieldToEventLoop = () => Promise<void>;

export interface CatalogBatchOptions {
  batchSize?: number;
  yieldControl?: YieldToEventLoop;
  yieldBudgetMs?: number;
}

/** Prevents one account or branch from rendering the previous scope during an effect transition. */
export function productsForCatalogScope<T>(
  products: T[],
  productsScopeKey: string | null,
  activeScopeKey: string | null
): T[] {
  return productsScopeKey && productsScopeKey === activeScopeKey ? products : (EMPTY_ARRAY as T[]);
}

export function isAuthoritativeCatalogSnapshot(
  fromCache: boolean,
  options?: { allowOffline?: boolean }
): boolean {
  if (options?.allowOffline) return true;
  return !fromCache;
}

export function shouldRetainCatalogProduct(
  productId: string,
  authoritativeIds: { has(value: string): boolean },
  pendingLocalIds: { has(value: string): boolean }
): boolean {
  return authoritativeIds.has(productId) || pendingLocalIds.has(productId);
}

export const yieldToEventLoop: YieldToEventLoop = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

function resolveYieldBudgetMs(options: CatalogBatchOptions): number {
  if (typeof options.yieldBudgetMs === 'number') {
    return Math.max(0, options.yieldBudgetMs);
  }
  return options.yieldControl ? 0 : PRODUCT_CATALOG_YIELD_BUDGET_MS;
}

/** Processes bounded index ranges without slicing the source array and yields on a time-slice budget. */
export async function processCatalogRangeInBatches<T>(
  items: readonly T[],
  processRange: (items: readonly T[], start: number, end: number) => void | Promise<void>,
  options: CatalogBatchOptions = {}
): Promise<CatalogBatchMetrics> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? PRODUCT_CATALOG_WORK_BATCH_SIZE));
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const yieldBudgetMs = resolveYieldBudgetMs(options);
  let batchCount = 0;
  let sliceStart = performance.now();

  for (let start = 0; start < items.length; start += batchSize) {
    const end = Math.min(start + batchSize, items.length);
    await processRange(items, start, end);
    batchCount += 1;
    if (end < items.length && performance.now() - sliceStart >= yieldBudgetMs) {
      await yieldControl();
      sliceStart = performance.now();
    }
  }

  return {
    itemCount: items.length,
    batchCount,
    maxItemsPerBatch: Math.min(batchSize, items.length),
  };
}

/** Processes bounded chunks and yields on a time-slice budget so UI work can run. */
export async function processCatalogInBatches<T>(
  items: readonly T[],
  processBatch: (batch: readonly T[], offset: number) => void | Promise<void>,
  options: CatalogBatchOptions = {}
): Promise<CatalogBatchMetrics> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? PRODUCT_CATALOG_WORK_BATCH_SIZE));
  if (items.length === 0) {
    return { itemCount: 0, batchCount: 0, maxItemsPerBatch: 0 };
  }
  if (items.length <= batchSize) {
    await processBatch(items, 0);
    return { itemCount: items.length, batchCount: 1, maxItemsPerBatch: items.length };
  }
  return processCatalogRangeInBatches(
    items,
    (source, start, end) => processBatch(source.slice(start, end), start),
    options
  );
}

/** Processes an iterator in bounded batches without first materializing a large array. */
export async function processCatalogIteratorInBatches<T>(
  items: Iterator<T>,
  processBatch: (batch: readonly T[], offset: number) => void | Promise<void>,
  options: CatalogBatchOptions = {}
): Promise<CatalogBatchMetrics> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? PRODUCT_CATALOG_WORK_BATCH_SIZE));
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const yieldBudgetMs = resolveYieldBudgetMs(options);
  let offset = 0;
  let maxItemsPerBatch = 0;
  let lookahead = items.next();
  let sliceStart = performance.now();

  while (!lookahead.done) {
    const batch: T[] = [];
    while (batch.length < batchSize && !lookahead.done) {
      batch.push(lookahead.value);
      lookahead = items.next();
    }
    if (batch.length === 0) break;
    await processBatch(batch, offset);
    offset += batch.length;
    maxItemsPerBatch = Math.max(maxItemsPerBatch, batch.length);
    if (!lookahead.done && performance.now() - sliceStart >= yieldBudgetMs) {
      await yieldControl();
      sliceStart = performance.now();
    }
  }

  return { itemCount: offset, batchCount: Math.ceil(offset / batchSize), maxItemsPerBatch };
}
