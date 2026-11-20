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

export interface CatalogInventorySummary {
  stats: CatalogInventoryStats;
  alerts: CatalogInventoryAlert[];
}

interface ProductInventoryContribution {
  active: boolean;
  inventoryValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  alert: CatalogInventoryAlert | null;
}

/** Maintains stock KPIs from changed documents instead of rescanning the full catalog. */
export class ProductCatalogInventoryIndex {
  private readonly contributions = new Map<string, ProductInventoryContribution>();
  private readonly alerts = new Map<string, CatalogInventoryAlert>();
  private activeProducts = 0;
  private inventoryValue = 0;
  private lowStockCount = 0;
  private outOfStockCount = 0;
  private alertsDirty = true;
  private cachedAlerts: CatalogInventoryAlert[] = [];

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
    if (this.alerts.delete(productId)) {
      this.alertsDirty = true;
    }
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
    if (alert) {
      this.alerts.set(product.id, alert);
      this.alertsDirty = true;
    }
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
    this.alertsDirty = false;
    this.cachedAlerts = [];
  }

  snapshot(): CatalogInventorySummary {
    const roundedValue = Math.round(this.inventoryValue * 100) / 100;
    if (this.alertsDirty) {
      this.cachedAlerts = Array.from(this.alerts.values());
      this.alertsDirty = false;
    }
    return {
      stats: {
        totalProducts: this.activeProducts,
        skuCount: this.activeProducts,
        totalInventoryValue: roundedValue,
        valuation: roundedValue,
        lowStockCount: this.lowStockCount,
        outOfStockCount: this.outOfStockCount,
      },
      alerts: this.cachedAlerts,
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

  upsert(product: Product): void {
    this.remove(product.id);
    if (product.active === false) return;
    const productMatches = new Map<string, CodeCandidate>();
    const set = (code: string | undefined, match: ScannedProductMatch, overwrite: boolean) => {
      const normalized = normalizeCode(code);
      if (normalized && (overwrite || !productMatches.has(normalized))) {
        productMatches.set(normalized, { match, unconditional: overwrite });
      }
    };

    if (product.barcode) set(product.barcode, { product }, true);
    if (product.sku) set(product.sku, { product }, false);
    if (Array.isArray(product.barcodes)) {
      for (let i = 0; i < product.barcodes.length; i += 1) {
        set(product.barcodes[i], { product }, false);
      }
    }
    if (Array.isArray(product.presentations)) {
      for (let i = 0; i < product.presentations.length; i += 1) {
        const presentation = product.presentations[i];
        if (presentation?.barcode) {
          set(presentation.barcode, { product, matchedPresentation: normalizePresentation(presentation) }, true);
        }
      }
    }
    if (product.branchPrices) {
      for (const config of Object.values(product.branchPrices)) {
        if (Array.isArray(config?.presentations)) {
          for (let i = 0; i < config.presentations.length; i += 1) {
            const presentation = config.presentations[i];
            if (presentation?.barcode) {
              set(
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
        if (variant?.barcode) set(variant.barcode, { product, matchedVariant: variant }, true);
        if (variant?.sku) set(variant.sku, { product, matchedVariant: variant }, false);
      }
    }

    if (productMatches.size === 0) return;

    if (productMatches.size === 1) {
      const onlyCode = productMatches.keys().next().value as string;
      this.codesByProduct.set(product.id, onlyCode);
    } else {
      this.codesByProduct.set(product.id, Array.from(productMatches.keys()));
    }

    for (const [code, candidate] of productMatches) {
      const existing = this.byCode.get(code);
      if (!existing) {
        this.byCode.set(code, {
          productId: product.id,
          match: candidate.match,
          unconditional: candidate.unconditional,
        });
      } else if (!(existing instanceof Map)) {
        if (existing.productId === product.id) {
          existing.match = candidate.match;
          existing.unconditional = candidate.unconditional;
        } else {
          const bucket = new Map<string, CodeCandidate>();
          bucket.set(existing.productId, {
            match: existing.match,
            unconditional: existing.unconditional,
          });
          bucket.set(product.id, candidate);
          this.byCode.set(code, bucket);
        }
      } else {
        existing.set(product.id, candidate);
      }
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
