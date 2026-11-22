import type { Product } from '@/types';

export interface IndexedCatalogProduct {
  product: Product;
  category: string;
  brand: string;
  sizes: string[];
  normalizedCategory: string;
  normalizedBrand: string;
  normalizedSizes: string[];
  normalizedSearchText: string;
}

export interface CatalogProductIndex {
  entries: IndexedCatalogProduct[];
  products?: Product[];
  entriesByCategory: Map<string, IndexedCatalogProduct[]>;
  uncategorizedEntries: IndexedCatalogProduct[];
  categoryCounts: Map<string, number>;
  uncategorizedCount: number;
  brands: string[];
  sizes: string[];
}

const indexedProductCache = new WeakMap<Product, IndexedCatalogProduct>();
const NON_ASCII_RE = /[^\x00-\x7F]/;
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;
const COLLAPSE_WS_TEST_RE = /[^\S ]|\s{2,}/;
const WHITESPACE_RUN_RE = /\s+/g;
const BRAND_ATTR_NAMES = ['marca', 'brand'] as const;
const SIZE_ATTR_NAMES = ['medida', 'talla', 'size'] as const;
const esCollator =
  typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
    ? new Intl.Collator('es-PE', { sensitivity: 'base' })
    : null;

const compareEs = (a: string, b: string): number =>
  esCollator ? esCollator.compare(a, b) : a.localeCompare(b, 'es-PE', { sensitivity: 'base' });

export const normalizeCatalogLabel = (label: string | undefined | null): string => {
  if (!label) return '';
  let str = label.trim();
  if (!str) return '';
  if (COLLAPSE_WS_TEST_RE.test(str)) {
    str = str.replace(WHITESPACE_RUN_RE, ' ');
  }
  if (NON_ASCII_RE.test(str)) {
    str = str.normalize('NFD').replace(COMBINING_MARKS_RE, '');
  }
  return str.toLowerCase();
};

const NORMALIZED_ALL = normalizeCatalogLabel('Todas');
const NORMALIZED_UNCATEGORIZED = normalizeCatalogLabel('Sin Categoría');

/** Normalize one immutable product ahead of publishing a catalog batch. */
export const getIndexedCatalogProduct = (product: Product): IndexedCatalogProduct => {
  const cached = indexedProductCache.get(product);
  if (cached) return cached;

  const category = product.category?.trim() || '';
  const brand = catalogBrand(product);
  const baseSize = catalogSize(product);
  const displaySizes = catalogSizes(product, baseSize);
  const normalizedSizes: string[] = displaySizes.length > 0 ? new Array(displaySizes.length) : [];
  for (let i = 0; i < displaySizes.length; i += 1) {
    normalizedSizes[i] = normalizeCatalogLabel(displaySizes[i]);
  }
  const normalizedCategory = normalizeCatalogLabel(category);
  const normalizedBrand = normalizeCatalogLabel(brand);

  const searchParts: string[] = [];
  const pushNorm = (raw: string | undefined | null) => {
    const n = normalizeCatalogLabel(raw);
    if (n) searchParts.push(n);
  };
  pushNorm(product.id);
  pushNorm(product.name);
  pushNorm(product.sku);
  pushNorm(product.barcode);
  const extraBarcodes = (product as any).barcodes;
  if (Array.isArray(extraBarcodes)) {
    for (let i = 0; i < extraBarcodes.length; i += 1) {
      pushNorm(String(extraBarcodes[i] || ''));
    }
  }
  if (normalizedBrand) searchParts.push(normalizedBrand);
  const normBaseSize = normalizeCatalogLabel(baseSize);
  if (normBaseSize && !normalizedSizes.includes(normBaseSize)) {
    searchParts.push(normBaseSize);
  }
  for (let i = 0; i < normalizedSizes.length; i += 1) {
    if (normalizedSizes[i]) searchParts.push(normalizedSizes[i]);
  }

  const entry: IndexedCatalogProduct = {
    product,
    category,
    brand,
    sizes: displaySizes,
    normalizedCategory,
    normalizedBrand,
    normalizedSizes,
    normalizedSearchText: searchParts.join('\u0000'),
  };
  indexedProductCache.set(product, entry);
  return entry;
};

/** Build once per products-array change so input keystrokes only scan normalized strings. */
export const buildCatalogProductIndex = (products: Product[]): CatalogProductIndex => {
  const entries: IndexedCatalogProduct[] = new Array(products.length);
  const entriesByCategory = new Map<string, IndexedCatalogProduct[]>();
  const uncategorizedEntries: IndexedCatalogProduct[] = [];
  const categoryCounts = new Map<string, number>();
  const brands = new Map<string, string>();
  const sizes = new Map<string, string>();
  let uncategorizedCount = 0;

  for (let i = 0; i < products.length; i += 1) {
    const product = products[i];
    const entry = getIndexedCatalogProduct(product);
    entries[i] = entry;

    if (entry.category) {
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
      let bucket = entriesByCategory.get(entry.normalizedCategory);
      if (!bucket) {
        bucket = [];
        entriesByCategory.set(entry.normalizedCategory, bucket);
      }
      bucket.push(entry);
    } else {
      uncategorizedCount += 1;
      uncategorizedEntries.push(entry);
    }

    if (entry.normalizedBrand && entry.brand && !brands.has(entry.normalizedBrand)) {
      brands.set(entry.normalizedBrand, entry.brand);
    }

    const entrySizes = entry.sizes;
    const entryNormSizes = entry.normalizedSizes;
    for (let j = 0; j < entrySizes.length; j += 1) {
      const normalizedSize = entryNormSizes[j];
      if (normalizedSize && !sizes.has(normalizedSize)) {
        sizes.set(normalizedSize, entrySizes[j]);
      }
    }
  }

  return {
    entries,
    products,
    entriesByCategory,
    uncategorizedEntries,
    categoryCounts,
    uncategorizedCount,
    brands: [...brands.values()],
    sizes: [...sizes.values()],
  };
};

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Incrementally maintains catalog filter buckets and brand/size/category counters so
 * stock-only or price-only updates touch O(1) structures without rebuilding full Maps.
 */
export class MutableCatalogProductIndex {
  private entries: IndexedCatalogProduct[] = [];
  private products: Product[] = [];
  private readonly indexById = new Map<string, number>();
  private readonly catBucketIndexById = new Map<string, number>();
  private readonly entriesByCategory = new Map<string, IndexedCatalogProduct[]>();
  private uncategorizedEntries: IndexedCatalogProduct[] = [];
  private readonly categoryCounts = new Map<string, number>();
  private uncategorizedCount = 0;
  private readonly brandCounts = new Map<string, { label: string; count: number }>();
  private readonly sizeCounts = new Map<string, { label: string; count: number }>();
  private brandsDirty = false;
  private sizesDirty = false;
  private cachedBrands: string[] = [];
  private cachedSizes: string[] = [];
  private dirty = false;
  private lastSnapshot: CatalogProductIndex | null = null;

  private addToCategoryBucket(entry: IndexedCatalogProduct): void {
    const id = entry.product.id;
    if (entry.category) {
      this.categoryCounts.set(entry.category, (this.categoryCounts.get(entry.category) || 0) + 1);
      let bucket = this.entriesByCategory.get(entry.normalizedCategory);
      if (!bucket) {
        bucket = [];
        this.entriesByCategory.set(entry.normalizedCategory, bucket);
      }
      this.catBucketIndexById.set(id, bucket.length);
      bucket.push(entry);
    } else {
      this.uncategorizedCount += 1;
      this.catBucketIndexById.set(id, this.uncategorizedEntries.length);
      this.uncategorizedEntries.push(entry);
    }
  }

  private removeFromCategoryBucket(productId: string, entry: IndexedCatalogProduct): void {
    const bucketIdx = this.catBucketIndexById.get(productId);
    this.catBucketIndexById.delete(productId);
    if (bucketIdx === undefined) return;

    if (entry.category) {
      const prevCount = this.categoryCounts.get(entry.category) || 0;
      if (prevCount <= 1) {
        this.categoryCounts.delete(entry.category);
      } else {
        this.categoryCounts.set(entry.category, prevCount - 1);
      }

      const bucket = this.entriesByCategory.get(entry.normalizedCategory);
      if (!bucket) return;
      const lastIdx = bucket.length - 1;
      if (bucketIdx !== lastIdx) {
        const moved = bucket[lastIdx];
        bucket[bucketIdx] = moved;
        this.catBucketIndexById.set(moved.product.id, bucketIdx);
      }
      bucket.pop();
      if (bucket.length === 0) {
        this.entriesByCategory.delete(entry.normalizedCategory);
      }
    } else {
      this.uncategorizedCount = Math.max(0, this.uncategorizedCount - 1);
      const lastIdx = this.uncategorizedEntries.length - 1;
      if (bucketIdx !== lastIdx) {
        const moved = this.uncategorizedEntries[lastIdx];
        this.uncategorizedEntries[bucketIdx] = moved;
        this.catBucketIndexById.set(moved.product.id, bucketIdx);
      }
      this.uncategorizedEntries.pop();
    }
  }

  private incrementBrand(entry: IndexedCatalogProduct): void {
    if (!entry.normalizedBrand || !entry.brand) return;
    const existing = this.brandCounts.get(entry.normalizedBrand);
    if (existing) {
      existing.count += 1;
    } else {
      this.brandCounts.set(entry.normalizedBrand, { label: entry.brand, count: 1 });
      this.brandsDirty = true;
    }
  }

  private decrementBrand(entry: IndexedCatalogProduct): void {
    if (!entry.normalizedBrand) return;
    const existing = this.brandCounts.get(entry.normalizedBrand);
    if (!existing) return;
    if (existing.count <= 1) {
      this.brandCounts.delete(entry.normalizedBrand);
      this.brandsDirty = true;
    } else {
      existing.count -= 1;
    }
  }

  private incrementSizes(entry: IndexedCatalogProduct): void {
    const normSizes = entry.normalizedSizes;
    const rawSizes = entry.sizes;
    for (let i = 0; i < normSizes.length; i += 1) {
      const norm = normSizes[i];
      if (!norm) continue;
      const existing = this.sizeCounts.get(norm);
      if (existing) {
        existing.count += 1;
      } else {
        this.sizeCounts.set(norm, { label: rawSizes[i], count: 1 });
        this.sizesDirty = true;
      }
    }
  }

  private decrementSizes(entry: IndexedCatalogProduct): void {
    const normSizes = entry.normalizedSizes;
    for (let i = 0; i < normSizes.length; i += 1) {
      const norm = normSizes[i];
      if (!norm) continue;
      const existing = this.sizeCounts.get(norm);
      if (!existing) continue;
      if (existing.count <= 1) {
        this.sizeCounts.delete(norm);
        this.sizesDirty = true;
      } else {
        existing.count -= 1;
      }
    }
  }

  upsert(product: Product): void {
    if (!product || !product.id) return;
    const existingIdx = this.indexById.get(product.id);
    if (existingIdx !== undefined) {
      if (this.products[existingIdx] === product) return;

      const oldEntry = this.entries[existingIdx];
      const newEntry = getIndexedCatalogProduct(product);
      this.entries[existingIdx] = newEntry;
      this.products[existingIdx] = product;

      if (
        oldEntry.normalizedCategory === newEntry.normalizedCategory &&
        Boolean(oldEntry.category) === Boolean(newEntry.category)
      ) {
        const catIdx = this.catBucketIndexById.get(product.id);
        if (catIdx !== undefined) {
          if (newEntry.category) {
            const bucket = this.entriesByCategory.get(newEntry.normalizedCategory);
            if (bucket) bucket[catIdx] = newEntry;
          } else {
            this.uncategorizedEntries[catIdx] = newEntry;
          }
        }
        if (oldEntry.category !== newEntry.category) {
          const prevCount = this.categoryCounts.get(oldEntry.category) || 0;
          if (prevCount <= 1) this.categoryCounts.delete(oldEntry.category);
          else this.categoryCounts.set(oldEntry.category, prevCount - 1);
          this.categoryCounts.set(newEntry.category, (this.categoryCounts.get(newEntry.category) || 0) + 1);
        }
      } else {
        this.removeFromCategoryBucket(product.id, oldEntry);
        this.addToCategoryBucket(newEntry);
      }

      if (oldEntry.normalizedBrand !== newEntry.normalizedBrand) {
        this.decrementBrand(oldEntry);
        this.incrementBrand(newEntry);
      }

      if (!sameStringArray(oldEntry.normalizedSizes, newEntry.normalizedSizes)) {
        this.decrementSizes(oldEntry);
        this.incrementSizes(newEntry);
      }

      this.dirty = true;
      return;
    }

    const entry = getIndexedCatalogProduct(product);
    const idx = this.entries.length;
    this.indexById.set(product.id, idx);
    this.entries.push(entry);
    this.products.push(product);
    this.addToCategoryBucket(entry);
    this.incrementBrand(entry);
    this.incrementSizes(entry);
    this.dirty = true;
  }

  remove(productId: string): void {
    const idx = this.indexById.get(productId);
    if (idx === undefined) return;
    const oldEntry = this.entries[idx];
    this.indexById.delete(productId);

    const lastIdx = this.entries.length - 1;
    if (idx !== lastIdx) {
      const movedEntry = this.entries[lastIdx];
      const movedProduct = this.products[lastIdx];
      this.entries[idx] = movedEntry;
      this.products[idx] = movedProduct;
      this.indexById.set(movedEntry.product.id, idx);
    }
    this.entries.pop();
    this.products.pop();

    this.removeFromCategoryBucket(productId, oldEntry);
    this.decrementBrand(oldEntry);
    this.decrementSizes(oldEntry);
    this.dirty = true;
  }

  clear(): void {
    this.entries = [];
    this.products = [];
    this.indexById.clear();
    this.catBucketIndexById.clear();
    this.entriesByCategory.clear();
    this.uncategorizedEntries = [];
    this.categoryCounts.clear();
    this.uncategorizedCount = 0;
    this.brandCounts.clear();
    this.sizeCounts.clear();
    this.brandsDirty = false;
    this.sizesDirty = false;
    this.cachedBrands = [];
    this.cachedSizes = [];
    this.dirty = true;
    this.lastSnapshot = null;
  }

  rebuildFrom(products: readonly Product[]): void {
    this.clear();
    for (let i = 0; i < products.length; i += 1) {
      this.upsert(products[i]);
    }
  }

  snapshot(): CatalogProductIndex {
    if (!this.dirty && this.lastSnapshot) {
      return this.lastSnapshot;
    }
    if (this.brandsDirty) {
      const nextBrands: string[] = [];
      for (const record of this.brandCounts.values()) {
        nextBrands.push(record.label);
      }
      this.cachedBrands = nextBrands;
      this.brandsDirty = false;
    }
    if (this.sizesDirty) {
      const nextSizes: string[] = [];
      for (const record of this.sizeCounts.values()) {
        nextSizes.push(record.label);
      }
      this.cachedSizes = nextSizes;
      this.sizesDirty = false;
    }
    this.lastSnapshot = {
      entries: this.entries.slice(),
      products: this.products.slice(),
      entriesByCategory: this.entriesByCategory,
      uncategorizedEntries: this.uncategorizedEntries,
      categoryCounts: this.categoryCounts,
      uncategorizedCount: this.uncategorizedCount,
      brands: this.cachedBrands,
      sizes: this.cachedSizes,
    };
    this.dirty = false;
    return this.lastSnapshot;
  }
}

export interface CatalogProductFilters {
  query?: string;
  category?: string;
  brand?: string;
  size?: string;
  include?: (product: Product) => boolean;
  limit?: number;
}

export const filterCatalogIndex = (
  index: CatalogProductIndex,
  filters: CatalogProductFilters = {}
): Product[] => {
  const query = normalizeCatalogLabel(filters.query);
  const category = normalizeCatalogLabel(filters.category);
  const brand = normalizeCatalogLabel(filters.brand);
  const size = normalizeCatalogLabel(filters.size);
  const allCategories = !category || category === NORMALIZED_ALL;
  const allBrands = !brand || brand === NORMALIZED_ALL;
  const allSizes = !size || size === NORMALIZED_ALL;
  const maxResults = filters.limit && filters.limit > 0 ? filters.limit : Infinity;

  if (allCategories && allBrands && allSizes && !query && !filters.include && maxResults === Infinity) {
    if (index.products) return index.products;
    if (index.entries.length === 0) return [];
    const fallback = new Array<Product>(index.entries.length);
    for (let i = 0; i < index.entries.length; i += 1) {
      fallback[i] = index.entries[i].product;
    }
    return fallback;
  }

  const uncategorized = category === NORMALIZED_UNCATEGORIZED;
  const sourceEntries = allCategories
    ? index.entries
    : uncategorized
      ? index.uncategorizedEntries
      : index.entriesByCategory.get(category) || [];

  if (sourceEntries.length === 0) return [];

  const filtered: Product[] = [];
  for (let i = 0; i < sourceEntries.length; i += 1) {
    const entry = sourceEntries[i];
    if (filters.include && !filters.include(entry.product)) continue;
    if (!allBrands && entry.normalizedBrand !== brand) continue;
    if (!allSizes && !entry.normalizedSizes.includes(size)) continue;
    if (query && !entry.normalizedSearchText.includes(query)) continue;
    filtered.push(entry.product);
    if (filtered.length >= maxResults) break;
  }
  return filtered;
};

export const getCatalogCategoryCounts = (
  categories: string[],
  index: CatalogProductIndex
): Array<{ name: string; count: number }> => {
  const categoryNames = ['Todas', ...categories.filter((category) => category !== 'Todas' && category !== 'Todos')];
  return categoryNames.map((name) => ({
    name,
    count: name === 'Todas'
      ? index.entries.length
      : name === 'Sin Categoría'
      ? index.uncategorizedCount
      : index.categoryCounts.get(name) || 0,
  }));
};

const attribute = (product: Product, names: readonly string[]): string => {
  const attrs = product.attributes;
  if (!attrs) return '';
  if (Array.isArray(attrs)) {
    for (let i = 0; i < attrs.length; i += 1) {
      const a = attrs[i] as any;
      if (a && names.includes(normalizeCatalogLabel(a.name))) {
        return typeof a.value === 'string' ? a.value.trim() : '';
      }
    }
    return '';
  }
  if (typeof attrs === 'object') {
    for (const key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      const val = (attrs as Record<string, unknown>)[key];
      if (typeof val === 'string' && names.includes(normalizeCatalogLabel(key))) {
        return val.trim();
      }
    }
  }
  return '';
};

export const catalogBrand = (product: Product): string =>
  product.brand?.trim() || (product as any).marca?.trim() || attribute(product, BRAND_ATTR_NAMES);

export const catalogCategory = (product: Product): string =>
  product.category?.trim() || '';

export const catalogSize = (product: Product): string =>
  product.sizeLabel?.trim() ||
  (product as any).size?.trim() ||
  (product as any).medida?.trim() ||
  attribute(product, SIZE_ATTR_NAMES);

export const catalogSizes = (product: Product, precomputedBaseSize?: string): string[] => {
  const baseSize = precomputedBaseSize !== undefined ? precomputedBaseSize : catalogSize(product);
  const variants = product.variants;
  const extra = product.sizes;

  if ((!variants || variants.length === 0) && (!Array.isArray(extra) || extra.length === 0)) {
    return baseSize ? [baseSize] : [];
  }

  const result: string[] = [];
  const pushUnique = (val: string | undefined | null) => {
    const trimmed = typeof val === 'string' ? val.trim() : '';
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  };

  if (variants && variants.length > 0) {
    for (let i = 0; i < variants.length; i += 1) {
      pushUnique((variants[i] as any)?.sizeLabel?.trim() || baseSize);
    }
  } else if (baseSize) {
    result.push(baseSize);
  }

  if (Array.isArray(extra)) {
    for (let i = 0; i < extra.length; i += 1) {
      pushUnique(extra[i]);
    }
  }

  return result;
};

export const DEFAULT_CATALOG_BRANDS: string[] = [
  'Casatex',
  'Torero',
  'Goldsun',
  'Cisne',
  'Cannon',
  'El Cisne',
  'Komfort',
  'Paraíso',
  'Rosen',
];

export const DEFAULT_CATALOG_SIZES: string[] = [
  '1.5 Plazas',
  '2 Plazas',
  'Queen',
  'King',
  'Estándar',
  'S',
  'M',
  'L',
  'XL',
];

export const uniqueCatalogValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    const trimmed = v?.trim();
    if (!trimmed) continue;
    const normalized = normalizeCatalogLabel(trimmed);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(trimmed);
    }
  }
  return result.sort(compareEs);
};

export const mergeCatalogOptions = (defaults: string[], extracted: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of extracted) {
    const trimmed = item?.trim();
    if (!trimmed) continue;
    const norm = normalizeCatalogLabel(trimmed);
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(trimmed);
    }
  }

  for (const item of defaults) {
    const norm = normalizeCatalogLabel(item);
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(item);
    }
  }

  return result.sort(compareEs);
};
