interface CatalogAttributes { brand?: string; sizeLabel?: string; sizes?: string[] }

export function catalogSizeInput(product?: CatalogAttributes | null): string {
  return product?.sizes?.length ? product.sizes.join(', ') : product?.sizeLabel || '';
}

/** Matches web editing: preserve hidden attributes and serialize all explicit sizes. */
export function catalogAttributeUpdate(product: CatalogAttributes | null | undefined, enabled: boolean, brand: string, sizeInput: string) {
  if (!enabled) return {
    brand: product?.brand || '',
    sizeLabel: product?.sizeLabel || '',
    sizes: product?.sizes || (product?.sizeLabel ? [product.sizeLabel] : []),
  };
  const sizes = [...new Set(sizeInput.split(',').map(size => size.trim()).filter(Boolean))];
  return { brand: brand.trim(), sizeLabel: sizes[0] || '', sizes };
}
