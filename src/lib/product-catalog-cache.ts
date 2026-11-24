import type { Product } from '@/types';

export interface CatalogCacheStorage {
  readonly isSyncCapable?: boolean;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
  multiRemove?(keys: string[]): Promise<void>;
  trim?: () => Promise<void>;
  getItemSync?(key: string): string | null;
  setItemSync?(key: string, value: string): void;
  removeItemSync?(key: string): void;
}

export interface ProductCatalogCacheManifest {
  schema: 1;
  generation: string;
  count: number;
  chunks: number;
  cachedAt: number;
  lastSyncMs?: number;
  allDocsHaveUpdatedAt?: boolean;
}

export interface ProductCatalogDelta {
  upsertedById: Record<string, Product>;
  deletedIds: string[];
  updatedAtMs: number;
}

export interface CatalogCacheLoadResult {
  count: number;
  cachedAt: number;
  expired: boolean;
  lastSyncMs?: number;
  allDocsHaveUpdatedAt?: boolean;
}

export const PRODUCT_CATALOG_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PRODUCT_CATALOG_CACHE_CHUNK_SIZE = 60;
const CACHE_YIELD_BUDGET_MS = 3.5;
const writesByScope = new Map<string, Promise<void>>();
const latestWriteIdByScope = new Map<string, number>();
const deltaWritesByKey = new Map<string, Promise<unknown>>();
let nextWriteId = 0;

function getDefaultCatalogStorage(): CatalogCacheStorage {
  // Lazy require so Node/Vitest callers with custom MemoryStorage do not load RN native modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('./native-kv-storage') as typeof import('./native-kv-storage')).catalogKVStorage;
}

function encodeScopePart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function productCatalogCacheKey(uid: string, accountId: string, branchId: string): string {
  return `@ventify_product_catalog:v1:${encodeScopePart(uid)}:${encodeScopePart(accountId)}:${encodeScopePart(branchId)}`;
}

export function productCatalogDeltaKey(accountId: string): string {
  return `@ventify_catalog_delta_v1:${accountId.trim()}`;
}

function extractAccountIdFromCacheKey(key: string): string | null {
  const prefix = '@ventify_product_catalog:v1:';
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = rest.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const encodedAccountId = rest.slice(firstColon + 1, secondColon);
  if (!encodedAccountId) return null;
  try {
    return decodeURIComponent(encodedAccountId);
  } catch {
    return encodedAccountId;
  }
}

function manifestKey(key: string): string {
  return key.endsWith(':manifest') ? key : `${key}:manifest`;
}

function chunkKey(key: string, generation: string, index: number): string {
  return `${key}:data:${generation}:${index}`;
}

async function readStorageItem(storage: CatalogCacheStorage, key: string): Promise<string | null> {
  if (storage.isSyncCapable === true && typeof storage.getItemSync === 'function') {
    return storage.getItemSync(key);
  }
  return storage.getItem(key);
}

function parseManifest(raw: string | null): ProductCatalogCacheManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ProductCatalogCacheManifest>;
    if (
      value.schema !== 1 ||
      typeof value.generation !== 'string' ||
      !Number.isInteger(value.count) ||
      !Number.isInteger(value.chunks) ||
      typeof value.cachedAt !== 'number' ||
      (value.count as number) < 0 ||
      (value.chunks as number) < 0
    ) return null;
    const manifest: ProductCatalogCacheManifest = {
      schema: 1,
      generation: value.generation,
      count: value.count as number,
      chunks: value.chunks as number,
      cachedAt: value.cachedAt,
    };
    if (typeof value.lastSyncMs === 'number' && Number.isFinite(value.lastSyncMs)) {
      manifest.lastSyncMs = value.lastSyncMs;
    }
    if (typeof value.allDocsHaveUpdatedAt === 'boolean') {
      manifest.allDocsHaveUpdatedAt = value.allDocsHaveUpdatedAt;
    }
    return manifest;
  } catch {
    return null;
  }
}

function parseDelta(raw: string | null): ProductCatalogDelta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProductCatalogDelta>;
    if (!parsed || typeof parsed !== 'object') return null;
    const upsertedById =
      parsed.upsertedById && typeof parsed.upsertedById === 'object' && !Array.isArray(parsed.upsertedById)
        ? (parsed.upsertedById as Record<string, Product>)
        : {};
    const deletedIds = Array.isArray(parsed.deletedIds)
      ? parsed.deletedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const updatedAtMs = typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
      ? parsed.updatedAtMs
      : 0;
    return { upsertedById, deletedIds, updatedAtMs };
  } catch {
    return null;
  }
}

function countDeltaEntries(delta: ProductCatalogDelta | null): number {
  if (!delta) return 0;
  return Object.keys(delta.upsertedById).length + delta.deletedIds.length;
}

/** Synchronously reads the catalog manifest when the underlying storage supports sync JSI access (MMKV). */
export function readProductCatalogManifestSync(
  accountIdOrKey: string,
  storage: CatalogCacheStorage = getDefaultCatalogStorage()
): ProductCatalogCacheManifest | null {
  if (!accountIdOrKey || storage.isSyncCapable === false || typeof storage.getItemSync !== 'function') {
    return null;
  }
  return parseManifest(storage.getItemSync(manifestKey(accountIdOrKey)));
}

/** Synchronously returns the pending delta entry count when MMKV sync access is available. */
export function getProductCatalogDeltaCountSync(
  accountId: string,
  storage: CatalogCacheStorage = getDefaultCatalogStorage()
): number {
  if (!accountId?.trim() || storage.isSyncCapable === false || typeof storage.getItemSync !== 'function') {
    return 0;
  }
  return countDeltaEntries(parseDelta(storage.getItemSync(productCatalogDeltaKey(accountId))));
}

export async function getProductCatalogDeltaCount(
  accountId: string,
  storage: CatalogCacheStorage = getDefaultCatalogStorage()
): Promise<number> {
  if (!accountId?.trim()) return 0;
  const raw = await readStorageItem(storage, productCatalogDeltaKey(accountId));
  return countDeltaEntries(parseDelta(raw));
}

export async function clearProductCatalogDelta(
  accountId: string,
  storage: CatalogCacheStorage = getDefaultCatalogStorage()
): Promise<void> {
  if (!accountId?.trim()) return;
  const dKey = productCatalogDeltaKey(accountId);
  const previous = deltaWritesByKey.get(dKey) || Promise.resolve();
  const op = previous
    .catch(() => {})
    .then(async () => {
      await storage.removeItem?.(dKey);
    });
  deltaWritesByKey.set(dKey, op);
  try {
    await op;
  } finally {
    if (deltaWritesByKey.get(dKey) === op) deltaWritesByKey.delete(dKey);
  }
}

/** Merges changed and deleted products into a compact per-account delta overlay without trimming MMKV. */
export async function writeProductCatalogDelta(
  accountId: string,
  upserted: readonly Product[],
  deletedIds: readonly string[],
  options: { storage?: CatalogCacheStorage; lastSyncMs?: number } = {}
): Promise<{ deltaCount: number }> {
  const cleanAccountId = accountId?.trim();
  if (!cleanAccountId) return { deltaCount: 0 };
  const storage = options.storage ?? getDefaultCatalogStorage();
  const dKey = productCatalogDeltaKey(cleanAccountId);
  const previous = deltaWritesByKey.get(dKey) || Promise.resolve();

  const op = previous
    .catch(() => {})
    .then(async (): Promise<{ deltaCount: number }> => {
      const existing = parseDelta(await readStorageItem(storage, dKey));
      const upsertedById: Record<string, Product> = existing ? { ...existing.upsertedById } : {};
      const deletedSet = new Set<string>(existing ? existing.deletedIds : []);

      for (let i = 0; i < deletedIds.length; i += 1) {
        const id = deletedIds[i];
        if (!id) continue;
        delete upsertedById[id];
        deletedSet.add(id);
      }

      for (let i = 0; i < upserted.length; i += 1) {
        const product = upserted[i];
        if (!product || !product.id) continue;
        deletedSet.delete(product.id);
        upsertedById[product.id] = product;
      }

      const mergedDeletedIds = Array.from(deletedSet);
      const deltaCount = Object.keys(upsertedById).length + mergedDeletedIds.length;

      if (deltaCount === 0) {
        if (existing) {
          await storage.removeItem?.(dKey);
        }
        return { deltaCount: 0 };
      }

      const payload: ProductCatalogDelta = {
        upsertedById,
        deletedIds: mergedDeletedIds,
        updatedAtMs: options.lastSyncMs ?? Date.now(),
      };
      await storage.setItem(dKey, JSON.stringify(payload));
      return { deltaCount };
    });

  deltaWritesByKey.set(dKey, op);
  try {
    return await op;
  } finally {
    if (deltaWritesByKey.get(dKey) === op) deltaWritesByKey.delete(dKey);
  }
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const defaultWriteYield = () => new Promise<void>((resolve) => setTimeout(resolve, 16));

/** Reads bounded JSON chunks and overlays any pending delta while honoring a 6ms yield budget. */
export async function loadProductCatalogCache(
  storage: CatalogCacheStorage,
  key: string,
  onChunk: (products: Product[], offset: number) => void | Promise<void>,
  options: { now?: number; chunkSize?: number; yieldControl?: () => Promise<void>; accountId?: string } = {}
): Promise<CatalogCacheLoadResult | null> {
  const manifestRaw =
    storage.isSyncCapable === true && typeof storage.getItemSync === 'function'
      ? storage.getItemSync(manifestKey(key))
      : await storage.getItem(manifestKey(key));
  const manifest = parseManifest(manifestRaw);
  if (!manifest) return null;
  const now = options.now ?? Date.now();
  const expired = now - manifest.cachedAt > PRODUCT_CATALOG_CACHE_TTL_MS;
  const accountId = options.accountId ?? extractAccountIdFromCacheKey(key);
  if (expired) {
    await removeGeneration(storage, key, manifest);
    const currentManifest = parseManifest(await readStorageItem(storage, manifestKey(key)));
    if (currentManifest?.generation === manifest.generation) {
      await storage.removeItem?.(manifestKey(key));
      if (accountId) {
        await clearProductCatalogDelta(accountId, storage);
      }
    }
    return { count: 0, cachedAt: manifest.cachedAt, expired: true };
  }

  const delta = accountId
    ? parseDelta(await readStorageItem(storage, productCatalogDeltaKey(accountId)))
    : null;
  const deletedSet = delta && delta.deletedIds.length > 0 ? new Set(delta.deletedIds) : null;
  const remainingUpserts = delta ? { ...delta.upsertedById } : null;
  const hasUpserts = remainingUpserts ? Object.keys(remainingUpserts).length > 0 : false;
  const hasDelta = Boolean((deletedSet && deletedSet.size > 0) || hasUpserts);

  let offset = 0;
  let baseReadCount = 0;
  const chunkSize = Math.max(1, options.chunkSize ?? PRODUCT_CATALOG_CACHE_CHUNK_SIZE);
  const yieldControl = options.yieldControl ?? defaultYield;
  let sliceStart = performance.now();

  for (let index = 0; index < manifest.chunks; index += 1) {
    const raw = await readStorageItem(storage, chunkKey(key, manifest.generation, index));
    if (!raw) {
      await invalidateGeneration(storage, key, manifest);
      return null;
    }
    let products: Product[];
    try {
      products = JSON.parse(raw) as Product[];
    } catch {
      await invalidateGeneration(storage, key, manifest);
      return null;
    }
    if (!Array.isArray(products) || products.length > chunkSize) {
      await invalidateGeneration(storage, key, manifest);
      return null;
    }

    baseReadCount += products.length;

    let chunkToEmit = products;
    if (hasDelta) {
      const overlaid: Product[] = [];
      for (let i = 0; i < products.length; i += 1) {
        const item = products[i];
        if (deletedSet && deletedSet.has(item.id)) {
          continue;
        }
        if (remainingUpserts && Object.prototype.hasOwnProperty.call(remainingUpserts, item.id)) {
          overlaid.push(remainingUpserts[item.id]);
          delete remainingUpserts[item.id];
        } else {
          overlaid.push(item);
        }
      }
      chunkToEmit = overlaid;
    }

    if (chunkToEmit.length > 0) {
      await onChunk(chunkToEmit, offset);
      offset += chunkToEmit.length;
    }

    const hasMore = index + 1 < manifest.chunks || (remainingUpserts ? Object.keys(remainingUpserts).length > 0 : false);
    if (hasMore && performance.now() - sliceStart >= CACHE_YIELD_BUDGET_MS) {
      await yieldControl();
      sliceStart = performance.now();
    }
  }

  if (baseReadCount !== manifest.count) {
    await invalidateGeneration(storage, key, manifest);
    return null;
  }

  if (remainingUpserts) {
    const remainingKeys = Object.keys(remainingUpserts);
    for (let i = 0; i < remainingKeys.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, remainingKeys.length);
      const batch: Product[] = [];
      for (let j = i; j < end; j += 1) {
        batch.push(remainingUpserts[remainingKeys[j]]);
      }
      await onChunk(batch, offset);
      offset += batch.length;
      if (end < remainingKeys.length && performance.now() - sliceStart >= CACHE_YIELD_BUDGET_MS) {
        await yieldControl();
        sliceStart = performance.now();
      }
    }
  }

  const result: CatalogCacheLoadResult = {
    count: offset,
    cachedAt: manifest.cachedAt,
    expired: false,
  };
  if (manifest.lastSyncMs !== undefined) result.lastSyncMs = manifest.lastSyncMs;
  if (manifest.allDocsHaveUpdatedAt !== undefined) {
    result.allDocsHaveUpdatedAt = manifest.allDocsHaveUpdatedAt;
  }
  return result;
}

/** Writes immutable chunks, then atomically exposes them by switching the manifest. */
export async function writeProductCatalogCache(
  storage: CatalogCacheStorage,
  key: string,
  products: readonly Product[],
  options: {
    generation: string;
    now?: number;
    isCurrent?: () => boolean;
    chunkSize?: number;
    yieldControl?: () => Promise<void>;
    trimAfterWrite?: boolean;
    lastSyncMs?: number;
    allDocsHaveUpdatedAt?: boolean;
    clearDelta?: boolean;
    accountId?: string;
  }
): Promise<boolean> {
  const writeId = ++nextWriteId;
  latestWriteIdByScope.set(key, writeId);
  const previous = writesByScope.get(key) || Promise.resolve();
  let committed = false;
  const writeOperation = previous.catch(() => {}).then(async () => {
    committed = await writeProductCatalogCacheNow(storage, key, products, options, writeId);
  });
  writesByScope.set(key, writeOperation);
  try {
    await writeOperation;
  } finally {
    if (writesByScope.get(key) === writeOperation) writesByScope.delete(key);
    if (latestWriteIdByScope.get(key) === writeId) latestWriteIdByScope.delete(key);
  }
  return committed;
}

/** Updates metadata fields on an existing catalog manifest without rewriting chunk data. */
export async function updateProductCatalogManifestMeta(
  storage: CatalogCacheStorage,
  key: string,
  patch: { lastSyncMs?: number; allDocsHaveUpdatedAt?: boolean; cachedAt?: number }
): Promise<boolean> {
  const previous = writesByScope.get(key) || Promise.resolve();
  let updated = false;
  const writeOperation = previous.catch(() => {}).then(async () => {
    const manifest = parseManifest(await readStorageItem(storage, manifestKey(key)));
    if (!manifest) return;
    const nextManifest: ProductCatalogCacheManifest = {
      ...manifest,
      ...(typeof patch.lastSyncMs === 'number' && Number.isFinite(patch.lastSyncMs)
        ? { lastSyncMs: patch.lastSyncMs }
        : {}),
      ...(typeof patch.allDocsHaveUpdatedAt === 'boolean'
        ? { allDocsHaveUpdatedAt: patch.allDocsHaveUpdatedAt }
        : {}),
      ...(typeof patch.cachedAt === 'number' && Number.isFinite(patch.cachedAt)
        ? { cachedAt: patch.cachedAt }
        : {}),
    };
    await storage.setItem(manifestKey(key), JSON.stringify(nextManifest));
    updated = true;
  });
  writesByScope.set(key, writeOperation);
  try {
    await writeOperation;
  } finally {
    if (writesByScope.get(key) === writeOperation) writesByScope.delete(key);
  }
  return updated;
}

async function writeProductCatalogCacheNow(
  storage: CatalogCacheStorage,
  key: string,
  products: readonly Product[],
  options: {
    generation: string;
    now?: number;
    isCurrent?: () => boolean;
    chunkSize?: number;
    yieldControl?: () => Promise<void>;
    trimAfterWrite?: boolean;
    lastSyncMs?: number;
    allDocsHaveUpdatedAt?: boolean;
    clearDelta?: boolean;
    accountId?: string;
  },
  writeId: number
): Promise<boolean> {
  const isSuperseded = () =>
    latestWriteIdByScope.get(key) !== writeId ||
    (options.isCurrent ? !options.isCurrent() : false);

  if (isSuperseded()) return false;

  const generation = options.generation;
  const chunkSize = Math.max(1, options.chunkSize ?? PRODUCT_CATALOG_CACHE_CHUNK_SIZE);
  const chunks = Math.ceil(products.length / chunkSize);
  const yieldControl = options.yieldControl ?? defaultWriteYield;
  const previousManifest = parseManifest(await readStorageItem(storage, manifestKey(key)));
  let writtenChunks = 0;
  let sliceStart = performance.now();

  for (let index = 0; index < chunks; index += 1) {
    if (isSuperseded()) {
      await removeGeneration(storage, key, { schema: 1, generation, count: 0, chunks: writtenChunks, cachedAt: 0 });
      return false;
    }
    const chunk = products.slice(index * chunkSize, (index + 1) * chunkSize);
    await storage.setItem(chunkKey(key, generation, index), JSON.stringify(chunk));
    writtenChunks += 1;
    if (index + 1 < chunks && performance.now() - sliceStart >= CACHE_YIELD_BUDGET_MS) {
      await yieldControl();
      sliceStart = performance.now();
    }
  }
  if (isSuperseded()) {
    await removeGeneration(storage, key, { schema: 1, generation, count: 0, chunks: writtenChunks, cachedAt: 0 });
    return false;
  }
  const manifest: ProductCatalogCacheManifest = {
    schema: 1,
    generation,
    count: products.length,
    chunks,
    cachedAt: options.now ?? Date.now(),
    ...(typeof options.lastSyncMs === 'number' && Number.isFinite(options.lastSyncMs)
      ? { lastSyncMs: options.lastSyncMs }
      : {}),
    ...(typeof options.allDocsHaveUpdatedAt === 'boolean'
      ? { allDocsHaveUpdatedAt: options.allDocsHaveUpdatedAt }
      : {}),
  };
  await storage.setItem(manifestKey(key), JSON.stringify(manifest));
  if (options.clearDelta) {
    const accountId = options.accountId ?? extractAccountIdFromCacheKey(key);
    if (accountId) {
      await clearProductCatalogDelta(accountId, storage);
    }
  }
  if (previousManifest && previousManifest.generation !== generation) {
    await removeGeneration(storage, key, previousManifest);
    if (options.trimAfterWrite) {
      await storage.trim?.().catch(() => {});
    }
  }
  return true;
}

async function removeGeneration(
  storage: CatalogCacheStorage,
  key: string,
  manifest: ProductCatalogCacheManifest
): Promise<void> {
  if (!storage.removeItem && !storage.multiRemove) return;
  const keys: string[] = [];
  for (let index = 0; index < manifest.chunks; index += 1) {
    keys.push(chunkKey(key, manifest.generation, index));
  }
  if (storage.multiRemove) {
    await storage.multiRemove(keys);
  } else if (storage.removeItem) {
    await Promise.all(keys.map((k) => storage.removeItem!(k)));
  }
}

async function invalidateGeneration(
  storage: CatalogCacheStorage,
  key: string,
  manifest: ProductCatalogCacheManifest
): Promise<void> {
  await removeGeneration(storage, key, manifest);
  const currentManifest = parseManifest(await readStorageItem(storage, manifestKey(key)));
  if (currentManifest?.generation === manifest.generation) {
    await storage.removeItem?.(manifestKey(key));
  }
}
