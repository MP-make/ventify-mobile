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
  entriesByCategory: Map<string, IndexedCatalogProduct[]>;
  uncategorizedEntries: IndexedCatalogProduct[];
  categoryCounts: Map<string, number>;
  uncategorizedCount: number;
  brands: string[];
  sizes: string[];
}

const indexedProductCache = new WeakMap<Product, IndexedCatalogProduct>();

export const normalizeCatalogLabel = (label: string | undefined | null): string =>
  (label || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const NORMALIZED_ALL = normalizeCatalogLabel('Todas');
const NORMALIZED_UNCATEGORIZED = normalizeCatalogLabel('Sin Categoría');

/** Normalize one immutable product ahead of publishing a catalog batch. */
export const getIndexedCatalogProduct = (product: Product): IndexedCatalogProduct => {
  const cached = indexedProductCache.get(product);
  if (cached) return cached;

  const category = product.category?.trim() || '';
  const brand = catalogBrand(product);
  const displaySizes = catalogSizes(product);
  const normalizedSizes = displaySizes.map(normalizeCatalogLabel);
  const normalizedCategory = normalizeCatalogLabel(category);
  const normalizedBrand = normalizeCatalogLabel(brand);
  const baseSize = catalogSize(product);

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
  pushNorm(baseSize);
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
    entriesByCategory,
    uncategorizedEntries,
    categoryCounts,
    uncategorizedCount,
    brands: [...brands.values()],
    sizes: [...sizes.values()],
  };
};

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
  const uncategorized = category === NORMALIZED_UNCATEGORIZED;
  const maxResults = filters.limit && filters.limit > 0 ? filters.limit : Infinity;

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

const attribute = (product: Product, names: string[]): string => {
  if (!product.attributes) return '';
  if (Array.isArray(product.attributes)) {
    return (
      product.attributes
        .find((a: any) => names.includes(normalizeCatalogLabel(a?.name)))
        ?.value?.trim() || ''
    );
  }
  if (typeof product.attributes === 'object') {
    for (const [key, val] of Object.entries(product.attributes)) {
      if (names.includes(normalizeCatalogLabel(key)) && typeof val === 'string') {
        return val.trim();
      }
    }
  }
  return '';
};

export const catalogBrand = (product: Product): string =>
  product.brand?.trim() || (product as any).marca?.trim() || attribute(product, ['marca', 'brand']);

export const catalogCategory = (product: Product): string =>
  product.category?.trim() || '';

export const catalogSize = (product: Product): string =>
  product.sizeLabel?.trim() ||
  (product as any).size?.trim() ||
  (product as any).medida?.trim() ||
  attribute(product, ['medida', 'talla', 'size']);

export const catalogSizes = (product: Product): string[] => {
  const extra = Array.isArray(product.sizes)
    ? product.sizes.map((s) => s?.trim()).filter(Boolean) as string[]
    : [];
  const baseSize = catalogSize(product);

  if (product.variants?.length) {
    return [
      ...new Set([
        ...product.variants
          .map((v) => (v as any).sizeLabel?.trim() || baseSize)
          .filter(Boolean),
        ...extra,
      ]),
    ];
  }

  return [
    ...new Set([
      baseSize,
      ...extra,
    ].filter(Boolean)),
  ];
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
  return result.sort((a, b) => a.localeCompare(b, 'es-PE', { sensitivity: 'base' }));
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

  return result.sort((a, b) => a.localeCompare(b, 'es-PE', { sensitivity: 'base' }));
};
