import type { Product } from '@/types';

export interface CatalogCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
  multiRemove?(keys: string[]): Promise<void>;
}

interface CatalogCacheManifest {
  schema: 1;
  generation: string;
  count: number;
  chunks: number;
  cachedAt: number;
}

export interface CatalogCacheLoadResult {
  count: number;
  cachedAt: number;
  expired: boolean;
}

export const PRODUCT_CATALOG_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PRODUCT_CATALOG_CACHE_CHUNK_SIZE = 150;
const writesByScope = new Map<string, Promise<void>>();

function encodeScopePart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function productCatalogCacheKey(uid: string, accountId: string, branchId: string): string {
  return `@ventify_product_catalog:v1:${encodeScopePart(uid)}:${encodeScopePart(accountId)}:${encodeScopePart(branchId)}`;
}

function manifestKey(key: string): string {
  return `${key}:manifest`;
}

function chunkKey(key: string, generation: string, index: number): string {
  return `${key}:data:${generation}:${index}`;
}

function parseManifest(raw: string | null): CatalogCacheManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CatalogCacheManifest>;
    if (
      value.schema !== 1 ||
      typeof value.generation !== 'string' ||
      !Number.isInteger(value.count) ||
      !Number.isInteger(value.chunks) ||
      typeof value.cachedAt !== 'number' ||
      (value.count as number) < 0 ||
      (value.chunks as number) < 0
    ) return null;
    return value as CatalogCacheManifest;
  } catch {
    return null;
  }
}

/** Reads bounded JSON chunks and publishes them one at a time to keep parsing work small. */
export async function loadProductCatalogCache(
  storage: CatalogCacheStorage,
  key: string,
  onChunk: (products: Product[], offset: number) => void | Promise<void>,
  options: { now?: number; chunkSize?: number; yieldControl?: () => Promise<void> } = {}
): Promise<CatalogCacheLoadResult | null> {
  const manifest = parseManifest(await storage.getItem(manifestKey(key)));
  if (!manifest) return null;
  const now = options.now ?? Date.now();
  const expired = now - manifest.cachedAt > PRODUCT_CATALOG_CACHE_TTL_MS;
  if (expired) {
    await removeGeneration(storage, key, manifest);
    const currentManifest = parseManifest(await storage.getItem(manifestKey(key)));
    if (currentManifest?.generation === manifest.generation) {
      await storage.removeItem?.(manifestKey(key));
    }
    return { count: 0, cachedAt: manifest.cachedAt, expired: true };
  }

  let offset = 0;
  const chunkSize = Math.max(1, options.chunkSize ?? PRODUCT_CATALOG_CACHE_CHUNK_SIZE);
  for (let index = 0; index < manifest.chunks; index += 1) {
    const raw = await storage.getItem(chunkKey(key, manifest.generation, index));
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
    await onChunk(products, offset);
    offset += products.length;
    if (index + 1 < manifest.chunks) {
      await (options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))))();
    }
  }
  if (offset !== manifest.count) {
    await invalidateGeneration(storage, key, manifest);
    return null;
  }
  return { count: offset, cachedAt: manifest.cachedAt, expired: false };
}

/** Writes immutable chunks, then atomically exposes them by switching the manifest. */
export async function writeProductCatalogCache(
  storage: CatalogCacheStorage,
  key: string,
  products: readonly Product[],
  options: { generation: string; now?: number; isCurrent?: () => boolean; chunkSize?: number }
): Promise<boolean> {
  const previous = writesByScope.get(key) || Promise.resolve();
  let committed = false;
  const writeOperation = previous.catch(() => {}).then(async () => {
    committed = await writeProductCatalogCacheNow(storage, key, products, options);
  });
  writesByScope.set(key, writeOperation);
  try {
    await writeOperation;
  } finally {
    if (writesByScope.get(key) === writeOperation) writesByScope.delete(key);
  }
  return committed;
}

async function writeProductCatalogCacheNow(
  storage: CatalogCacheStorage,
  key: string,
  products: readonly Product[],
  options: { generation: string; now?: number; isCurrent?: () => boolean; chunkSize?: number }
): Promise<boolean> {
  const generation = options.generation;
  const chunkSize = Math.max(1, options.chunkSize ?? PRODUCT_CATALOG_CACHE_CHUNK_SIZE);
  const chunks = Math.ceil(products.length / chunkSize);
  const previousManifest = parseManifest(await storage.getItem(manifestKey(key)));
  let writtenChunks = 0;
  for (let index = 0; index < chunks; index += 1) {
    if (options.isCurrent && !options.isCurrent()) {
      await removeGeneration(storage, key, { schema: 1, generation, count: 0, chunks: writtenChunks, cachedAt: 0 });
      return false;
    }
    const chunk = products.slice(index * chunkSize, (index + 1) * chunkSize);
    await storage.setItem(chunkKey(key, generation, index), JSON.stringify(chunk));
    writtenChunks += 1;
  }
  if (options.isCurrent && !options.isCurrent()) {
    await removeGeneration(storage, key, { schema: 1, generation, count: 0, chunks: writtenChunks, cachedAt: 0 });
    return false;
  }
  const manifest: CatalogCacheManifest = {
    schema: 1,
    generation,
    count: products.length,
    chunks,
    cachedAt: options.now ?? Date.now(),
  };
  await storage.setItem(manifestKey(key), JSON.stringify(manifest));
  if (previousManifest && previousManifest.generation !== generation) {
    await removeGeneration(storage, key, previousManifest);
  }
  return true;
}

async function removeGeneration(
  storage: CatalogCacheStorage,
  key: string,
  manifest: CatalogCacheManifest
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
  manifest: CatalogCacheManifest
): Promise<void> {
  await removeGeneration(storage, key, manifest);
  const currentManifest = parseManifest(await storage.getItem(manifestKey(key)));
  if (currentManifest?.generation === manifest.generation) {
    await storage.removeItem?.(manifestKey(key));
  }
}
