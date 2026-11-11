/**
 * Ventify Mobile High-Speed Product Search & Pricing Engine
 * In-memory fuzzy and barcode search, stock availability, and tiered pricing
 */

import {
  Product,
  ProductPresentation,
  ProductVariant,
  PriceTier,
  BranchPriceConfig,
} from '../types';

// ============================================================================
// 1. TEXT & CODE NORMALIZATION
// ============================================================================

/**
 * Normalizes text for search comparison:
 * lowercase, removes accents/diacritics, strips extra whitespace
 * e.g. "Sábana Polar" -> "sabana polar"
 */
export function normalizeSearchText(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalizes barcode or SKU for exact scanning comparison:
 * lowercases and strips spaces, hyphens, periods, underscores
 */
export function normalizeCode(code: string | undefined | null): string {
  if (!code) return '';
  return code.toLowerCase().replace(/[\s\-_.]/g, '');
}

// ============================================================================
// 2. STOCK HELPERS (PHYSICAL & AVAILABLE)
// ============================================================================

/**
 * Returns physical recorded stock for a branch
 */
export function getBranchStock(product: Product, branchId: string): number {
  if (!product.stock) return 0;
  if (branchId && product.stock[branchId] !== undefined) {
    return Number(product.stock[branchId] ?? 0);
  }
  if (!branchId || branchId === 'main') {
    const firstVal = Object.values(product.stock)[0];
    return Number(firstVal ?? 0);
  }
  return 0;
}

/**
 * Returns reserved stock committed in pending reservations/orders
 */
export function getReservedStock(product: Product, branchId: string): number {
  if (!product.reservedStock || !branchId) return 0;
  return Number(product.reservedStock[branchId] ?? 0);
}

/**
 * Returns real available stock (physical stock minus reserved stock, minimum 0)
 */
export function getAvailableStock(product: Product, branchId: string): number {
  const physical = getBranchStock(product, branchId);
  const reserved = getReservedStock(product, branchId);
  return Math.max(0, physical - reserved);
}

// ============================================================================
// 3. BARCODE & SCANNER RESOLUTION
// ============================================================================

export interface ScannedProductMatch {
  product: Product;
  matchedPresentation?: ProductPresentation;
  matchedVariant?: ProductVariant;
}

/**
 * Collects all presentations of a product (base + branch overrides)
 */
export function getAllPresentations(product: Product): ProductPresentation[] {
  const presentations: ProductPresentation[] = [];
  if (Array.isArray(product.presentations)) {
    presentations.push(...product.presentations);
  }
  if (product.branchPrices) {
    for (const config of Object.values(product.branchPrices)) {
      if (Array.isArray(config?.presentations)) {
        presentations.push(...config.presentations);
      }
    }
  }
  return presentations;
}

/**
 * Exact match by barcode or SKU for hardware laser guns or camera scanners.
 * Evaluates:
 * 1. product.barcode
 * 2. product.sku
 * 3. product.barcodes[]
 * 4. product.presentations[].barcode
 * 5. product.variants[].barcode and product.variants[].sku
 */
export function findProductByBarcode(
  products: Product[],
  code: string
): ScannedProductMatch | undefined {
  const normalized = normalizeCode(code);
  if (!normalized) return undefined;

  for (const product of products) {
    // 1. Direct barcode
    if (product.barcode && normalizeCode(product.barcode) === normalized) {
      return { product };
    }

    // 2. Direct SKU
    if (product.sku && normalizeCode(product.sku) === normalized) {
      return { product };
    }

    // 3. Secondary barcode aliases
    if (Array.isArray(product.barcodes)) {
      if (product.barcodes.some((b) => normalizeCode(b) === normalized)) {
        return { product };
      }
    }

    // 4. Presentation barcodes
    const presentations = getAllPresentations(product);
    const matchedPresentation = presentations.find(
      (p) => p.barcode && normalizeCode(p.barcode) === normalized
    );
    if (matchedPresentation) {
      return { product, matchedPresentation };
    }

    // 5. Variant barcodes & variant SKUs
    if (Array.isArray(product.variants)) {
      const matchedVariant = product.variants.find((v) => {
        const vBarcode = v.barcode ? normalizeCode(v.barcode) : '';
        const vSku = v.sku ? normalizeCode(v.sku) : '';
        return vBarcode === normalized || vSku === normalized;
      });
      if (matchedVariant) {
        return { product, matchedVariant };
      }
    }
  }

  return undefined;
}

// ============================================================================
// 4. INSTANT CATALOG FILTERING
// ============================================================================

/**
 * High-speed catalog filter for mobile search bar and category pills.
 * Computes real branch availability.
 */
export function filterProducts(
  products: Product[],
  query: string,
  category: string,
  branchId?: string
): Product[] {
  const normQuery = normalizeSearchText(query);
  const normCategory = normalizeSearchText(category);
  const isAllCategories = !normCategory || normCategory === 'all' || normCategory === 'todos';

  return products.filter((product) => {
    // 1. Active status check
    if (product.active === false) return false;

    // 2. Branch filter: if branchId specified, check if product belongs to branch
    if (branchId) {
      if (
        Array.isArray(product.branchIds) &&
        product.branchIds.length > 0 &&
        !product.branchIds.includes(branchId)
      ) {
        return false;
      }
    }

    // 3. Category filter
    if (!isAllCategories) {
      const prodCategory = normalizeSearchText(product.category);
      if (prodCategory !== normCategory) {
        return false;
      }
    }

    // 4. Query text filter
    if (normQuery) {
      // Check pre-indexed search string
      if (product._searchStr && normalizeSearchText(product._searchStr).includes(normQuery)) {
        return true;
      }

      // Check name, SKU, barcode
      if (normalizeSearchText(product.name).includes(normQuery)) return true;
      if (normalizeCode(product.sku).includes(normQuery.replace(/\s+/g, ''))) return true;
      if (product.barcode && normalizeCode(product.barcode).includes(normQuery.replace(/\s+/g, ''))) return true;

      // Check secondary barcodes
      if (Array.isArray(product.barcodes)) {
        if (product.barcodes.some((b) => normalizeCode(b).includes(normQuery.replace(/\s+/g, '')))) return true;
      }

      // Check brand and supplier
      if (product.brand && normalizeSearchText(product.brand).includes(normQuery)) return true;
      if (product.supplier && normalizeSearchText(product.supplier).includes(normQuery)) return true;

      // Check presentations
      if (Array.isArray(product.presentations)) {
        if (product.presentations.some((p) => normalizeSearchText(p.name).includes(normQuery))) return true;
      }

      // Check variants
      if (Array.isArray(product.variants)) {
        if (product.variants.some((v) => normalizeSearchText(v.name).includes(normQuery))) return true;
      }

      return false;
    }

    return true;
  });
}

// ============================================================================
// 5. EFFECTIVE UNIT PRICE RESOLUTION
// ============================================================================

/**
 * Resolves the branch pricing configuration with fallbacks
 */
export function getBranchPricingConfig(
  product: Product,
  branchId?: string,
  enableMinSalePrice: boolean = true
): BranchPriceConfig {
  const branchOverride = branchId ? product.branchPrices?.[branchId] : undefined;
  const basePrice = Number(product.suggestedPrice ?? product.price ?? 0);
  const baseCost = Number(product.costPrice ?? 0);

  const rawBaseMin = (enableMinSalePrice && product.minSalePrice !== undefined && product.minSalePrice !== null && Number(product.minSalePrice) > 0)
    ? Math.max(Number(product.minSalePrice), baseCost)
    : baseCost;

  const baseMin = (basePrice > 0 && rawBaseMin > basePrice)
    ? baseCost
    : rawBaseMin;

  const overridePrice =
    branchOverride?.suggestedPrice !== undefined
      ? Number(branchOverride.suggestedPrice)
      : basePrice;
  const overrideCost =
    branchOverride?.costPrice !== undefined
      ? Number(branchOverride.costPrice)
      : baseCost;

  const rawOverrideMin = (enableMinSalePrice && branchOverride?.minSalePrice !== undefined && branchOverride.minSalePrice !== null && Number(branchOverride.minSalePrice) > 0)
    ? Math.max(Number(branchOverride.minSalePrice), overrideCost)
    : (branchOverride?.costPrice !== undefined ? Number(branchOverride.costPrice) : baseMin);

  const overrideMin = (overridePrice > 0 && rawOverrideMin > overridePrice)
    ? overrideCost
    : rawOverrideMin;

  return {
    suggestedPrice: overridePrice,
    costPrice: overrideCost,
    minSalePrice: overrideMin,
    priceTiers:
      branchOverride?.priceTiers && branchOverride.priceTiers.length > 0
        ? branchOverride.priceTiers
        : product.priceTiers,
    presentations:
      branchOverride?.presentations && branchOverride.presentations.length > 0
        ? branchOverride.presentations
        : product.presentations,
  };
}

/**
 * Resolves the effective unit price for a sale item, taking into account:
 * - Branch price overrides (branchPrices)
 * - Selected presentation (caja, pack, etc.)
 * - Selected variant adjustments
 * - Tiered wholesale volume pricing (priceTiers)
 * - Floor price protection (minSalePrice)
 */
export function resolveEffectiveUnitPrice(
  product: Product,
  branchId: string,
  quantity: number,
  presentation?: ProductPresentation,
  variant?: ProductVariant,
  enableMinSalePrice: boolean = true
): number {
  const pricing = getBranchPricingConfig(product, branchId, enableMinSalePrice);

  // 1. If presentation is selected, use presentation price
  if (presentation) {
    // Check if branch has presentation override
    const branchPresentations = pricing.presentations || [];
    const overridePres = branchPresentations.find((p) => p.id === presentation.id);
    const presPrice = overridePres?.price ?? presentation.price;
    const presMin = overridePres?.minSalePrice ?? presentation.minSalePrice ?? 0;

    return Math.max(presPrice, presMin);
  }

  // 2. Base price from branch or product
  let unitPrice = Number(pricing.suggestedPrice ?? 0);

  // 3. Apply volume pricing tiers (tiered pricing)
  const tiers = Array.isArray(pricing.priceTiers) ? pricing.priceTiers : [];
  if (tiers.length > 0 && quantity >= 1) {
    const applicableTiers = tiers
      .filter((t) => {
        const minQty = Number(t.minQuantity ?? t.minQty ?? 0);
        return minQty > 0 && quantity >= minQty;
      })
      .sort((a, b) => {
        const qtyA = Number(a.minQuantity ?? a.minQty ?? 0);
        const qtyB = Number(b.minQuantity ?? b.minQty ?? 0);
        return qtyB - qtyA; // Highest threshold first
      });

    if (applicableTiers.length > 0) {
      const topTier = applicableTiers[0];
      unitPrice = Number(topTier.unitPrice ?? topTier.price ?? unitPrice);
    }
  }

  // 4. Variant adjustments
  if (variant) {
    if (variant.price !== undefined && variant.price > 0) {
      unitPrice = Number(variant.price);
    } else if (variant.priceAdjustment) {
      unitPrice += Number(variant.priceAdjustment);
    }
  }

  // 5. Floor protection (minSalePrice)
  const floorPrice = Number(pricing.minSalePrice ?? product.minSalePrice ?? 0);
  if (floorPrice > 0 && unitPrice < floorPrice) {
    unitPrice = floorPrice;
  }

  return Math.round(unitPrice * 100) / 100;
}
