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
  categoryCounts: Map<string, number>;
  uncategorizedCount: number;
  brands: string[];
  sizes: string[];
}

const indexedProductCache = new WeakMap<Product, IndexedCatalogProduct>();

/** Normalize one immutable product ahead of publishing a catalog batch. */
export const getIndexedCatalogProduct = (product: Product): IndexedCatalogProduct => {
  const cached = indexedProductCache.get(product);
  if (cached) return cached;

  const category = product.category?.trim() || '';
  const brand = catalogBrand(product);
  const displaySizes = catalogSizes(product);
  const sizes = displaySizes.map(normalizeCatalogLabel);
  const references = [
    product.id,
    product.name,
    product.sku,
    product.barcode,
    ...(Array.isArray((product as any).barcodes) ? (product as any).barcodes : []),
    brand,
    catalogSize(product),
    ...sizes,
  ];
  const entry: IndexedCatalogProduct = {
    product,
    category,
    brand,
    sizes: displaySizes,
    normalizedCategory: normalizeCatalogLabel(category),
    normalizedBrand: normalizeCatalogLabel(brand),
    normalizedSizes: sizes,
    normalizedSearchText: references.map((value) => normalizeCatalogLabel(String(value || ''))).filter(Boolean).join('\u0000'),
  };
  indexedProductCache.set(product, entry);
  return entry;
};

export const normalizeCatalogLabel = (label: string | undefined | null): string =>
  (label || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Build once per products-array change so input keystrokes only scan normalized strings. */
export const buildCatalogProductIndex = (products: Product[]): CatalogProductIndex => {
  const entries: IndexedCatalogProduct[] = [];
  const categoryCounts = new Map<string, number>();
  const brands = new Map<string, string>();
  const sizes = new Map<string, string>();
  let uncategorizedCount = 0;

  for (const product of products) {
    const category = product.category?.trim() || '';
    if (category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    else uncategorizedCount++;
    const entry = getIndexedCatalogProduct(product);
    entries.push(entry);
    if (entry.brand) {
      const normalizedBrand = normalizeCatalogLabel(entry.brand);
      if (!brands.has(normalizedBrand)) brands.set(normalizedBrand, entry.brand);
    }
    for (const size of entry.sizes) {
      const normalizedSize = normalizeCatalogLabel(size);
      if (normalizedSize && !sizes.has(normalizedSize)) sizes.set(normalizedSize, size);
    }
  }

  return { entries, categoryCounts, uncategorizedCount, brands: [...brands.values()], sizes: [...sizes.values()] };
};

export interface CatalogProductFilters {
  query?: string;
  category?: string;
  brand?: string;
  size?: string;
  include?: (product: Product) => boolean;
}

export const filterCatalogIndex = (
  index: CatalogProductIndex,
  filters: CatalogProductFilters = {}
): Product[] => {
  const query = normalizeCatalogLabel(filters.query);
  const category = normalizeCatalogLabel(filters.category);
  const brand = normalizeCatalogLabel(filters.brand);
  const size = normalizeCatalogLabel(filters.size);
  const allCategories = !category || category === normalizeCatalogLabel('Todas');
  const allBrands = !brand || brand === normalizeCatalogLabel('Todas');
  const allSizes = !size || size === normalizeCatalogLabel('Todas');

  const filtered: Product[] = [];
  const uncategorized = category === normalizeCatalogLabel('Sin Categoría');
  for (const entry of index.entries) {
    if (filters.include && !filters.include(entry.product)) continue;
    if (!allCategories && (uncategorized ? !!entry.category : entry.normalizedCategory !== category)) continue;
    if (!allBrands && entry.normalizedBrand !== brand) continue;
    if (!allSizes && !entry.normalizedSizes.includes(size)) continue;
    if (query && !entry.normalizedSearchText.includes(query)) continue;
    filtered.push(entry.product);
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

  if (product.variants?.length) {
    return [
      ...new Set([
        ...product.variants
          .map((v) => (v as any).sizeLabel?.trim() || catalogSize(product))
          .filter(Boolean),
        ...extra,
      ]),
    ];
  }

  return [
    ...new Set([
      catalogSize(product),
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
