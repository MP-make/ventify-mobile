import { describe, it, expect } from 'vitest';
import {
  catalogBrand,
  catalogSizes,
  mergeCatalogOptions,
  uniqueCatalogValues,
  normalizeCatalogLabel,
  buildCatalogProductIndex,
  filterCatalogIndex,
  getCatalogCategoryCounts,
} from '../catalog-filters';

describe('catalog-filters', () => {
  it('extracts brand from product.brand, product.marca, and attributes', () => {
    expect(catalogBrand({ id: '1', name: 'P1', brand: 'Nike' } as any)).toBe('Nike');
    expect(catalogBrand({ id: '2', name: 'P2', marca: 'Adidas' } as any)).toBe('Adidas');
    expect(
      catalogBrand({
        id: '3',
        name: 'P3',
        attributes: { Marca: 'Puma' },
      } as any)
    ).toBe('Puma');
    expect(
      catalogBrand({
        id: '4',
        name: 'P4',
        attributes: [{ name: 'Marca', value: 'Under Armour' }],
      } as any)
    ).toBe('Under Armour');
    expect(catalogBrand({ id: '5', name: 'P5' } as any)).toBe('');
  });

  it('extracts sizes from size, sizes, medida, and attributes', () => {
    expect(catalogSizes({ id: '1', name: 'P1', size: 'M' } as any)).toEqual(['M']);
    expect(catalogSizes({ id: '2', name: 'P2', sizes: ['S', 'M', 'L'] } as any)).toEqual(['S', 'M', 'L']);
    expect(
      catalogSizes({
        id: '3',
        name: 'P3',
        attributes: { Medida: '1 Litro' },
      } as any)
    ).toEqual(['1 Litro']);
  });

  it('normalizes catalog labels and merges options cleanly', () => {
    expect(normalizeCatalogLabel('  NIKE  ')).toBe('nike');
    expect(uniqueCatalogValues(['nike', 'Nike', 'NIKE', 'Adidas'])).toEqual(['Adidas', 'nike']);

    const merged = mergeCatalogOptions(['Coca Cola'], ['Inca Kola', 'coca cola']);
    expect(merged).toContain('coca cola');
    expect(merged).toContain('Inca Kola');
    expect(merged.length).toBe(2);
  });

  it('matches products by main barcode or any secondary barcodes', () => {
    const product = {
      id: 'p1',
      name: 'Pisco Vargas 750ml',
      barcode: '7751234567890',
      barcodes: ['7759999999999', 'PACK-6-VARGAS'],
      brand: 'Vargas',
      sizeLabel: '750 ml',
    } as any;

    const matchQuery = (p: any, q: string) => {
      const clean = q.trim().toLowerCase();
      const nameMatch = p.name?.toLowerCase().includes(clean);
      const barcodeMatch = p.barcode?.toLowerCase().includes(clean);
      const extraMatch = Array.isArray(p.barcodes) && p.barcodes.some((b: string) => b.toLowerCase().includes(clean));
      const brandMatch = p.brand?.toLowerCase().includes(clean);
      const sizeMatch = p.sizeLabel?.toLowerCase().includes(clean);
      return Boolean(nameMatch || barcodeMatch || extraMatch || brandMatch || sizeMatch);
    };

    expect(matchQuery(product, 'pisco')).toBe(true);
    expect(matchQuery(product, 'vargas')).toBe(true);
    expect(matchQuery(product, '7751234567890')).toBe(true);
    expect(matchQuery(product, '7759999999999')).toBe(true);
    expect(matchQuery(product, 'PACK-6')).toBe(true);
    expect(matchQuery(product, '750 ml')).toBe(true);
    expect(matchQuery(product, 'cerveza')).toBe(false);
  });

  it('indexes and searches names, product references, IDs, barcodes, brands, and sizes accent-insensitively', () => {
    const products = [
      { id: 'ref-001', name: 'Café Molido', category: 'Bebidas', sku: 'CAF-1', barcode: '123', brand: 'El Cisne', sizeLabel: 'Tamaño XL' },
      { id: 'ref-002', name: 'Arroz', category: 'Abarrotes', barcodes: ['PACK-6'], attributes: { Talla: 'Medida Grande' } },
    ] as any[];
    const index = buildCatalogProductIndex(products as any);

    expect(filterCatalogIndex(index, { query: 'cafe' })).toEqual([products[0]]);
    expect(filterCatalogIndex(index, { query: 'ref-001' })).toEqual([products[0]]);
    expect(filterCatalogIndex(index, { query: 'pack-6' })).toEqual([products[1]]);
    expect(filterCatalogIndex(index, { query: 'cisne' })).toEqual([products[0]]);
    expect(filterCatalogIndex(index, { query: 'tamano xl' })).toEqual([products[0]]);
    expect(filterCatalogIndex(index, { query: 'medida grande' })).toEqual([products[1]]);
    expect(filterCatalogIndex(index, { category: 'Bebídas', brand: 'el cisne', size: 'Tamaño XL' })).toEqual([products[0]]);
  });

  it('computes category counts in one index pass, including uncategorized products', () => {
    const products = [
      { id: '1', name: 'A', category: 'Bebidas' },
      { id: '2', name: 'B', category: 'Bebidas' },
      { id: '3', name: 'C', category: 'Abarrotes' },
      { id: '4', name: 'D' },
    ] as any[];
    const index = buildCatalogProductIndex(products as any);

    expect(getCatalogCategoryCounts(['Bebidas', 'Abarrotes', 'Sin Categoría'], index)).toEqual([
      { name: 'Todas', count: 4 },
      { name: 'Bebidas', count: 2 },
      { name: 'Abarrotes', count: 1 },
      { name: 'Sin Categoría', count: 1 },
    ]);
  });
});
