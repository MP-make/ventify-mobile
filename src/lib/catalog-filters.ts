import type { Product } from '@/types';

export const normalizeCatalogLabel = (label: string | undefined | null): string =>
  (label || '')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

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
