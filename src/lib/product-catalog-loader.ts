/** Small first render batch and bounded mapping work for large Firestore snapshots. */
export const PRODUCT_CATALOG_FIRST_BATCH_SIZE = 80;
export const PRODUCT_CATALOG_WORK_BATCH_SIZE = 100;

export interface CatalogBatchMetrics {
  itemCount: number;
  batchCount: number;
  maxItemsPerBatch: number;
}

export type YieldToEventLoop = () => Promise<void>;

/** Prevents one account or branch from rendering the previous scope during an effect transition. */
export function productsForCatalogScope<T>(
  products: T[],
  productsScopeKey: string | null,
  activeScopeKey: string | null
): T[] {
  return productsScopeKey && productsScopeKey === activeScopeKey ? products : [];
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

/** Processes bounded chunks and yields between them so UI work can run. */
export async function processCatalogInBatches<T>(
  items: readonly T[],
  processBatch: (batch: readonly T[], offset: number) => void | Promise<void>,
  options: { batchSize?: number; yieldControl?: YieldToEventLoop } = {}
): Promise<CatalogBatchMetrics> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? PRODUCT_CATALOG_WORK_BATCH_SIZE));
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  let batchCount = 0;

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    await processBatch(batch, offset);
    batchCount += 1;
    if (offset + batch.length < items.length) await yieldControl();
  }

  return {
    itemCount: items.length,
    batchCount,
    maxItemsPerBatch: Math.min(batchSize, items.length),
  };
}

/** Processes an iterator in bounded batches without first materializing a large array. */
export async function processCatalogIteratorInBatches<T>(
  items: Iterator<T>,
  processBatch: (batch: readonly T[], offset: number) => void | Promise<void>,
  options: { batchSize?: number; yieldControl?: YieldToEventLoop } = {}
): Promise<CatalogBatchMetrics> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? PRODUCT_CATALOG_WORK_BATCH_SIZE));
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  let offset = 0;
  let maxItemsPerBatch = 0;

  while (true) {
    const batch: T[] = [];
    while (batch.length < batchSize) {
      const next = items.next();
      if (next.done) break;
      batch.push(next.value);
    }
    if (batch.length === 0) break;
    await processBatch(batch, offset);
    offset += batch.length;
    maxItemsPerBatch = Math.max(maxItemsPerBatch, batch.length);
    if (batch.length === batchSize) await yieldControl();
  }

  return { itemCount: offset, batchCount: Math.ceil(offset / batchSize), maxItemsPerBatch };
}
