import type { Product } from '@/types';
import { normalizePresentation } from '@/lib/presentation-parity';
import { getBranchStock, normalizeCode, type ScannedProductMatch } from '@/lib/product-search';

export interface CatalogInventoryStats {
  totalProducts: number;
  skuCount: number;
  totalInventoryValue: number;
  valuation: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface CatalogInventoryAlert {
  productId: string;
  name: string;
  currentStock: number;
  minStock: number;
}

export type CriticalInventoryAlert = CatalogInventoryAlert;

export interface CatalogInventorySummary {
  stats: CatalogInventoryStats;
  alerts: CatalogInventoryAlert[];
}

export const EMPTY_CRITICAL_ALERTS: readonly CatalogInventoryAlert[] = Object.freeze([]);

interface ProductInventoryContribution {
  active: boolean;
  inventoryValue: number;
  lowStockCount: number;
  outOfStockCount: number;
}

/** Maintains stock KPIs from changed documents instead of rescanning the full catalog. */
export class ProductCatalogInventoryIndex {
  private readonly contributions = new Map<string, ProductInventoryContribution>();
  private activeProducts = 0;
  private inventoryValue = 0;
  private lowStockCount = 0;
  private outOfStockCount = 0;
  private lastSnapshot: CatalogInventorySummary | null = null;

  constructor(private readonly branchId: string) {}

  private subtract(productId: string): void {
    const contribution = this.contributions.get(productId);
    if (!contribution) return;
    this.contributions.delete(productId);
    if (!contribution.active) return;
    this.activeProducts -= 1;
    this.inventoryValue -= contribution.inventoryValue;
    this.lowStockCount -= contribution.lowStockCount;
    this.outOfStockCount -= contribution.outOfStockCount;
  }

  upsert(product: Product): void {
    this.subtract(product.id);
    const active = product.active !== false;
    if (!active) {
      this.contributions.set(product.id, {
        active: false,
        inventoryValue: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
      });
      return;
    }

    const currentStock = getBranchStock(product, this.branchId);
    const minStock = Number((product as any).minStock ?? 3);
    const costPrice = Number(product.costPrice ?? (product.suggestedPrice ? product.suggestedPrice * 0.7 : 0));
    const inventoryValue = currentStock > 0 ? currentStock * costPrice : 0;
    const outOfStockCount = currentStock <= 0 ? 1 : 0;
    const lowStockCount = currentStock > 0 && currentStock <= minStock ? 1 : 0;

    this.contributions.set(product.id, { active: true, inventoryValue, lowStockCount, outOfStockCount });
    this.activeProducts += 1;
    this.inventoryValue += inventoryValue;
    this.lowStockCount += lowStockCount;
    this.outOfStockCount += outOfStockCount;
  }

  remove(productId: string): void {
    this.subtract(productId);
  }

  clear(): void {
    this.contributions.clear();
    this.activeProducts = 0;
    this.inventoryValue = 0;
    this.lowStockCount = 0;
    this.outOfStockCount = 0;
    this.lastSnapshot = null;
  }

  snapshot(): CatalogInventorySummary {
    const roundedValue = Math.round(this.inventoryValue * 100) / 100;
    if (
      this.lastSnapshot &&
      this.lastSnapshot.stats.totalProducts === this.activeProducts &&
      this.lastSnapshot.stats.skuCount === this.activeProducts &&
      this.lastSnapshot.stats.totalInventoryValue === roundedValue &&
      this.lastSnapshot.stats.valuation === roundedValue &&
      this.lastSnapshot.stats.lowStockCount === this.lowStockCount &&
      this.lastSnapshot.stats.outOfStockCount === this.outOfStockCount
    ) {
      return this.lastSnapshot;
    }
    this.lastSnapshot = {
      stats: {
        totalProducts: this.activeProducts,
        skuCount: this.activeProducts,
        totalInventoryValue: roundedValue,
        valuation: roundedValue,
        lowStockCount: this.lowStockCount,
        outOfStockCount: this.outOfStockCount,
      },
      alerts: EMPTY_CRITICAL_ALERTS as CatalogInventoryAlert[],
    };
    return this.lastSnapshot;
  }
}

/** Tracks category membership per product so stock-only updates do not rescan all products. */
export class ProductCatalogCategoryIndex {
  private readonly categoryByProduct = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  private subtract(productId: string): string | null {
    const category = this.categoryByProduct.get(productId);
    if (category === undefined) return null;
    this.categoryByProduct.delete(productId);
    const count = this.counts.get(category) || 0;
    if (count <= 1) this.counts.delete(category);
    else this.counts.set(category, count - 1);
    return category;
  }

  upsert(product: Product): boolean {
    const previousCategory = this.categoryByProduct.get(product.id) || '';
    const category = product.active === false ? '' : product.category?.trim() || '';
    if (previousCategory === category) return false;
    this.subtract(product.id);
    if (!category) return true;
    this.categoryByProduct.set(product.id, category);
    this.counts.set(category, (this.counts.get(category) || 0) + 1);
    return true;
  }

  remove(productId: string): boolean {
    return Boolean(this.subtract(productId));
  }

  clear(): void {
    this.categoryByProduct.clear();
    this.counts.clear();
  }

  snapshot(): string[] {
    return ['Todos', ...Array.from(this.counts.keys()).sort((a, b) => a.localeCompare(b))];
  }
}

interface CodeCandidate {
  match: ScannedProductMatch;
  unconditional: boolean;
}

interface SingleCodeEntry {
  productId: string;
  match: ScannedProductMatch;
  unconditional: boolean;
}

/** Indexes only codes owned by each product, so snapshot changes touch O(codes in changed docs). */
export class ProductCatalogIndex {
  private readonly byCode = new Map<string, SingleCodeEntry | Map<string, CodeCandidate>>();
  private readonly codesByProduct = new Map<string, string | string[]>();

  get(code: string): ScannedProductMatch | undefined {
    const normalized = normalizeCode(code);
    if (!normalized) return undefined;
    const entry = this.byCode.get(normalized);
    if (!entry) return undefined;
    if (!(entry instanceof Map)) return entry.match;
    if (!entry.size) return undefined;

    // Firestore's un-ordered account query yields stable document-id ordering. Preserve its
    // previous last-writer behavior for duplicate codes without rebuilding the whole index.
    let unconditionalMatch: ScannedProductMatch | undefined;
    let unconditionalId = '';
    let conditionalMatch: ScannedProductMatch | undefined;
    let conditionalId = '';
    for (const [productId, candidate] of entry) {
      if (candidate.unconditional) {
        if (!unconditionalMatch || productId.localeCompare(unconditionalId) > 0) {
          unconditionalId = productId;
          unconditionalMatch = candidate.match;
        }
      } else if (!conditionalMatch || productId.localeCompare(conditionalId) < 0) {
        conditionalId = productId;
        conditionalMatch = candidate.match;
      }
    }
    return unconditionalMatch || conditionalMatch;
  }

  private removeCodeForProduct(code: string, productId: string): void {
    const entry = this.byCode.get(code);
    if (!entry) return;
    if (!(entry instanceof Map)) {
      if (entry.productId === productId) {
        this.byCode.delete(code);
      }
      return;
    }
    entry.delete(productId);
    if (entry.size === 0) {
      this.byCode.delete(code);
    } else if (entry.size === 1) {
      const first = entry.entries().next().value;
      if (first) {
        this.byCode.set(code, {
          productId: first[0],
          match: first[1].match,
          unconditional: first[1].unconditional,
        });
      }
    }
  }

  remove(productId: string): void {
    const codes = this.codesByProduct.get(productId);
    if (!codes) return;
    if (typeof codes === 'string') {
      this.removeCodeForProduct(codes, productId);
    } else {
      for (let i = 0; i < codes.length; i += 1) {
        this.removeCodeForProduct(codes[i], productId);
      }
    }
    this.codesByProduct.delete(productId);
  }

  private insertCodeEntry(
    code: string,
    productId: string,
    match: ScannedProductMatch,
    unconditional: boolean
  ): void {
    const existing = this.byCode.get(code);
    if (!existing) {
      this.byCode.set(code, { productId, match, unconditional });
      return;
    }
    if (!(existing instanceof Map)) {
      if (existing.productId === productId) {
        existing.match = match;
        existing.unconditional = unconditional;
        return;
      }
      const bucket = new Map<string, CodeCandidate>();
      bucket.set(existing.productId, {
        match: existing.match,
        unconditional: existing.unconditional,
      });
      bucket.set(productId, { match, unconditional });
      this.byCode.set(code, bucket);
      return;
    }
    existing.set(productId, { match, unconditional });
  }

  upsert(product: Product): void {
    this.remove(product.id);
    if (product.active === false) return;

    let firstCode: string | null = null;
    let firstMatch: ScannedProductMatch | undefined;
    let firstUnconditional = false;
    let productMatches: Map<string, CodeCandidate> | null = null;

    const addCode = (
      rawCode: string | undefined,
      match: ScannedProductMatch,
      overwrite: boolean
    ) => {
      const normalized = normalizeCode(rawCode);
      if (!normalized) return;

      if (productMatches === null) {
        if (firstCode === null) {
          firstCode = normalized;
          firstMatch = match;
          firstUnconditional = overwrite;
          return;
        }
        if (normalized === firstCode) {
          if (overwrite) {
            firstMatch = match;
            firstUnconditional = true;
          }
          return;
        }
        productMatches = new Map<string, CodeCandidate>();
        productMatches.set(firstCode, {
          match: firstMatch!,
          unconditional: firstUnconditional,
        });
      }

      if (overwrite || !productMatches.has(normalized)) {
        productMatches.set(normalized, { match, unconditional: overwrite });
      }
    };

    if (product.barcode) addCode(product.barcode, { product }, true);
    if (product.sku) addCode(product.sku, { product }, false);
    if (Array.isArray(product.barcodes)) {
      for (let i = 0; i < product.barcodes.length; i += 1) {
        addCode(product.barcodes[i], { product }, false);
      }
    }
    if (Array.isArray(product.presentations)) {
      for (let i = 0; i < product.presentations.length; i += 1) {
        const presentation = product.presentations[i];
        if (presentation?.barcode) {
          addCode(presentation.barcode, { product, matchedPresentation: normalizePresentation(presentation) }, true);
        }
      }
    }
    const branchPrices = product.branchPrices;
    if (branchPrices) {
      for (const branchKey in branchPrices) {
        if (!Object.prototype.hasOwnProperty.call(branchPrices, branchKey)) continue;
        const config = branchPrices[branchKey];
        const branchPresentations = config?.presentations;
        if (Array.isArray(branchPresentations)) {
          for (let i = 0; i < branchPresentations.length; i += 1) {
            const presentation = branchPresentations[i];
            if (presentation?.barcode) {
              addCode(
                presentation.barcode,
                { product, matchedPresentation: normalizePresentation(presentation) },
                true
              );
            }
          }
        }
      }
    }
    if (Array.isArray(product.variants)) {
      for (let i = 0; i < product.variants.length; i += 1) {
        const variant = product.variants[i];
        if (variant?.barcode) addCode(variant.barcode, { product, matchedVariant: variant }, true);
        if (variant?.sku) addCode(variant.sku, { product, matchedVariant: variant }, false);
      }
    }

    if (firstCode === null) return;

    const multiMatches = productMatches as Map<string, CodeCandidate> | null;
    if (multiMatches === null) {
      this.codesByProduct.set(product.id, firstCode);
      this.insertCodeEntry(firstCode, product.id, firstMatch!, firstUnconditional);
      return;
    }

    const codeList: string[] = [];
    for (const [code, candidate] of multiMatches) {
      codeList.push(code);
      this.insertCodeEntry(code, product.id, candidate.match, candidate.unconditional);
    }
    this.codesByProduct.set(product.id, codeList);
  }

  clear(): void {
    this.byCode.clear();
    this.codesByProduct.clear();
  }
}

export function removeCatalogProduct(
  productsById: Map<string, Product>,
  index: ProductCatalogIndex,
  productId: string
): void {
  productsById.delete(productId);
  index.remove(productId);
}
