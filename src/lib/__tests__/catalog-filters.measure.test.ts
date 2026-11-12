import { it } from 'vitest';
import { buildCatalogProductIndex, filterCatalogIndex, getIndexedCatalogProduct } from '../catalog-filters';

/** Informational fixture benchmark. Run directly to compare changes; timings are not assertions. */
it('reports legacy and indexed search work for an 8k product catalog', () => {
  const products = Array.from({ length: 8000 }, (_, index) => ({
    id: `ref-${index}`,
    name: `Café producto ${index}`,
    category: `Categoría ${index % 40}`,
    sku: `SKU-${index}`,
    barcode: `775000${index}`,
    brand: `Marca ${index % 20}`,
    sizeLabel: index % 2 ? 'Queen' : 'King',
  })) as any[];
  const categories = Array.from({ length: 40 }, (_, index) => `Categoría ${index}`);
  const queries = ['cafe', 'sku-78', '7750004', 'marca 17', 'ref-6'];
  const legacyStart = performance.now();
  for (const query of queries) {
    const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    products.filter((product) =>
      [product.name, product.sku, product.barcode, product.brand, product.sizeLabel].some((value) =>
        String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(q)
      )
    );
  }
  for (const category of categories) products.filter((product) => product.category === category).length;
  const legacyMs = performance.now() - legacyStart;

  const buildStart = performance.now();
  const index = buildCatalogProductIndex(products as any);
  const indexBuildMs = performance.now() - buildStart;
  const searchStart = performance.now();
  for (const query of queries) filterCatalogIndex(index, { query });
  for (const category of categories) index.categoryCounts.get(category);
  const indexedSearchAndCountsMs = performance.now() - searchStart;

  const batchesStart = performance.now();
  let maxPrewarmBatchMs = 0;
  const incrementallyPublishedProducts = products.map((product) => ({ ...product }));
  for (let end = 100; end <= incrementallyPublishedProducts.length; end += 100) {
    const prewarmStart = performance.now();
    for (let index = end - 100; index < end; index++) {
      getIndexedCatalogProduct(incrementallyPublishedProducts[index] as any);
    }
    maxPrewarmBatchMs = Math.max(maxPrewarmBatchMs, performance.now() - prewarmStart);
  }
  const prewarmBatchesMs = performance.now() - batchesStart;
  const finalBuildStart = performance.now();
  buildCatalogProductIndex(incrementallyPublishedProducts as any);
  const finalBuildMs = performance.now() - finalBuildStart;

  console.log(JSON.stringify({ fixtureProducts: products.length, queries: queries.length, categories: categories.length, legacyMs, coldIndexBuildMs: indexBuildMs, indexedSearchAndCountsMs, prewarmBatchesMs, maxPrewarmBatchMs, finalBuildAfterPrewarmMs: finalBuildMs }));
});
