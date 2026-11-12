import type { Product } from '@/types';
import { getAllPresentations, getBranchStock, normalizeCode, type ScannedProductMatch } from '@/lib/product-search';

export interface CatalogInventoryStats {
  totalProducts: number;
  skuCount: number;
  totalInventoryValue: number;
  valuation: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface CatalogInventorySummary {
  stats: CatalogInventoryStats;
  alerts: Array<{ productId: string; name: string; currentStock: number; minStock: number }>;
}

interface ProductInventoryContribution {
  active: boolean;
  inventoryValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  alert: { productId: string; name: string; currentStock: number; minStock: number } | null;
}

/** Maintains stock KPIs from changed documents instead of rescanning the full catalog. */
export class ProductCatalogInventoryIndex {
  private readonly contributions = new Map<string, ProductInventoryContribution>();
  private readonly alerts = new Map<string, { productId: string; name: string; currentStock: number; minStock: number }>();
  private activeProducts = 0;
  private inventoryValue = 0;
  private lowStockCount = 0;
  private outOfStockCount = 0;

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
    this.alerts.delete(productId);
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
        alert: null,
      });
      return;
    }

    const currentStock = getBranchStock(product, this.branchId);
    const minStock = Number((product as any).minStock ?? 3);
    const costPrice = Number(product.costPrice ?? (product.suggestedPrice ? product.suggestedPrice * 0.7 : 0));
    const inventoryValue = currentStock > 0 ? currentStock * costPrice : 0;
    const outOfStockCount = currentStock <= 0 ? 1 : 0;
    const lowStockCount = currentStock > 0 && currentStock <= minStock ? 1 : 0;
    const alert = outOfStockCount || lowStockCount
      ? { productId: product.id, name: product.name, currentStock, minStock }
      : null;

    this.contributions.set(product.id, { active: true, inventoryValue, lowStockCount, outOfStockCount, alert });
    this.activeProducts += 1;
    this.inventoryValue += inventoryValue;
    this.lowStockCount += lowStockCount;
    this.outOfStockCount += outOfStockCount;
    if (alert) this.alerts.set(product.id, alert);
  }

  remove(productId: string): void {
    this.subtract(productId);
  }

  clear(): void {
    this.contributions.clear();
    this.alerts.clear();
    this.activeProducts = 0;
    this.inventoryValue = 0;
    this.lowStockCount = 0;
    this.outOfStockCount = 0;
  }

  snapshot(): CatalogInventorySummary {
    const roundedValue = Math.round(this.inventoryValue * 100) / 100;
    return {
      stats: {
        totalProducts: this.activeProducts,
        skuCount: this.activeProducts,
        totalInventoryValue: roundedValue,
        valuation: roundedValue,
        lowStockCount: this.lowStockCount,
        outOfStockCount: this.outOfStockCount,
      },
      alerts: Array.from(this.alerts.values()),
    };
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

/** Indexes only codes owned by each product, so snapshot changes touch O(codes in changed docs). */
export class ProductCatalogIndex {
  private readonly byCode = new Map<string, Map<string, { match: ScannedProductMatch; unconditional: boolean }>>();
  private readonly codesByProduct = new Map<string, Set<string>>();

  get(code: string): ScannedProductMatch | undefined {
    const normalized = normalizeCode(code);
    const candidates = this.byCode.get(normalized);
    if (!candidates?.size) return undefined;
    // Firestore's un-ordered account query yields stable document-id ordering. Preserve its
    // previous last-writer behavior for duplicate codes without rebuilding the whole index.
    let unconditionalMatch: ScannedProductMatch | undefined;
    let unconditionalId = '';
    let conditionalMatch: ScannedProductMatch | undefined;
    let conditionalId = '';
    for (const [productId, candidate] of candidates) {
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

  remove(productId: string): void {
    const codes = this.codesByProduct.get(productId);
    if (!codes) return;
    for (const code of codes) {
      const matches = this.byCode.get(code);
      matches?.delete(productId);
      if (matches?.size === 0) this.byCode.delete(code);
    }
    this.codesByProduct.delete(productId);
  }

  upsert(product: Product): void {
    this.remove(product.id);
    if (product.active === false) return;
    const productMatches = new Map<string, { match: ScannedProductMatch; unconditional: boolean }>();
    const set = (code: string | undefined, match: ScannedProductMatch, overwrite: boolean) => {
      const normalized = normalizeCode(code);
      if (normalized && (overwrite || !productMatches.has(normalized))) {
        productMatches.set(normalized, { match, unconditional: overwrite });
      }
    };

    set(product.barcode, { product }, true);
    set(product.sku, { product }, false);
    for (const code of Array.isArray(product.barcodes) ? product.barcodes : []) set(code, { product }, false);
    for (const presentation of getAllPresentations(product)) {
      set(presentation.barcode, { product, matchedPresentation: presentation }, true);
    }
    for (const variant of Array.isArray(product.variants) ? product.variants : []) {
      set(variant.barcode, { product, matchedVariant: variant }, true);
      set(variant.sku, { product, matchedVariant: variant }, false);
    }

    const ownedCodes = new Set(productMatches.keys());
    this.codesByProduct.set(product.id, ownedCodes);
    for (const [code, candidate] of productMatches) {
      let matches = this.byCode.get(code);
      if (!matches) {
        matches = new Map();
        this.byCode.set(code, matches);
      }
      matches.set(product.id, candidate);
    }
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
