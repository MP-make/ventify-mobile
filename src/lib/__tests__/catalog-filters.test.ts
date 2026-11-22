import { describe, it, expect } from 'vitest';
import {
  catalogBrand,
  catalogSizes,
  mergeCatalogOptions,
  uniqueCatalogValues,
  normalizeCatalogLabel,
  buildCatalogProductIndex,
  MutableCatalogProductIndex,
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

  it('returns cached products array zero-copy when filterCatalogIndex has no active filters', () => {
    const products = [
      { id: '1', name: 'Alpha', category: 'General', brand: 'Nike', sizeLabel: 'M' },
      { id: '2', name: 'Beta', category: 'General', brand: 'Adidas', sizeLabel: 'L' },
    ] as any[];
    const index = buildCatalogProductIndex(products);
    const unfiltered = filterCatalogIndex(index, { category: 'Todas', brand: 'Todas', size: 'Todas' });
    expect(unfiltered).toBe(index.products);
    expect(unfiltered).toBe(products);
  });

  it('maintains incremental category/brand/size counters and preserves array identity on stock-only updates in MutableCatalogProductIndex', () => {
    const p1 = { id: '1', name: 'Café', category: 'Bebidas', brand: 'Ventify', sizeLabel: '500 ml', stock: { main: 5 } } as any;
    const p2 = { id: '2', name: 'Galleta', category: 'Snacks', brand: 'Inka', sizes: ['S', 'M'], stock: { main: 10 } } as any;
    const p3 = { id: '3', name: 'Bolsa', category: '', stock: { main: 20 } } as any;

    const mutable = new MutableCatalogProductIndex();
    mutable.rebuildFrom([p1, p2, p3]);
    const snap1 = mutable.snapshot();

    expect(mutable.snapshot()).toBe(snap1);
    expect(filterCatalogIndex(snap1, {})).toBe(snap1.products);
    expect(snap1.brands).toEqual(['Ventify', 'Inka']);
    expect(snap1.sizes).toEqual(['500 ml', 'S', 'M']);
    expect(getCatalogCategoryCounts(['Bebidas', 'Snacks', 'Sin Categoría'], snap1)).toEqual([
      { name: 'Todas', count: 3 },
      { name: 'Bebidas', count: 1 },
      { name: 'Snacks', count: 1 },
      { name: 'Sin Categoría', count: 1 },
    ]);

    // Stock-only update keeps exact brands & sizes array references
    mutable.upsert({ ...p1, stock: { main: 99 } });
    const snap2 = mutable.snapshot();
    expect(snap2).not.toBe(snap1);
    expect(snap2.brands).toBe(snap1.brands);
    expect(snap2.sizes).toBe(snap1.sizes);
    expect(filterCatalogIndex(snap2, { query: 'cafe' })[0].stock.main).toBe(99);

    // Category & brand change updates counters accurately
    mutable.upsert({ ...p1, category: 'Snacks', brand: 'NuevaMarca', stock: { main: 99 } });
    const snap3 = mutable.snapshot();
    expect(snap3.brands).toEqual(['Inka', 'NuevaMarca']);
    expect(snap3.categoryCounts.get('Bebidas')).toBeUndefined();
    expect(snap3.categoryCounts.get('Snacks')).toBe(2);

    // Removal cleans up uncategorized & sizes
    mutable.remove('3');
    mutable.remove('2');
    const snap4 = mutable.snapshot();
    expect(snap4.uncategorizedCount).toBe(0);
    expect(snap4.brands).toEqual(['NuevaMarca']);
    expect(snap4.sizes).toEqual(['500 ml']);
    expect(filterCatalogIndex(snap4, {})).toHaveLength(1);
  });
});
