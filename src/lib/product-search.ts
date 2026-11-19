import { normalizePresentation } from '@/lib/presentation-parity';
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
  CartItem,
  DiscountSettings,
  PromotionRule,
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
  return presentations.map(normalizePresentation);
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
    const presPrice = Number(overridePres?.price ?? presentation.price ?? 0);
    const presMin = Number(overridePres?.minSalePrice ?? presentation.minSalePrice ?? 0);

    const resolvedPresPrice =
      enableMinSalePrice && presMin > 0 ? Math.max(presPrice, presMin) : presPrice;
    return Math.round(resolvedPresPrice * 100) / 100;
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

/**
 * Alias de paridad Web (`getEffectiveProductPrice`) para resolver el precio unitario vigente
 * según sucursal (`branchPrices`), escalas por volumen (`priceTiers`) y presentación/variante.
 */
export function getEffectiveProductPrice(
  product: Product,
  branchId: string,
  quantity: number = 1,
  presentation?: ProductPresentation,
  variant?: ProductVariant,
  enableMinSalePrice: boolean = true
): number {
  return resolveEffectiveUnitPrice(
    product,
    branchId,
    quantity,
    presentation,
    variant,
    enableMinSalePrice
  );
}

/**
 * Resuelve el precio mínimo permitido para una línea del carrito con paridad Web (`resolveMinSalePriceFloor`):
 * - Si `enableMinSalePrice !== false` y `minSalePrice > 0`: usa `Math.max(minSalePrice, costPrice)`.
 * - Si `minSalePrice` es 0 o no está configurado: respalda con `costPrice` para nunca vender debajo del costo.
 */
export function resolveCartItemMinPrice(
  item: {
    minSalePrice?: number;
    costPrice?: number;
    product?: { minSalePrice?: number; costPrice?: number };
    presentation?: { minSalePrice?: number; conversionFactor?: number; costPrice?: number };
  },
  enableMinSalePrice: boolean = true
): number {
  const presFactor = Math.max(1, Number(item.presentation?.conversionFactor ?? 1) || 1);
  const rawCost =
    item.presentation?.costPrice ??
    item.costPrice ??
    item.product?.costPrice;
  const cost =
    rawCost !== undefined && rawCost !== null && Number.isFinite(Number(rawCost))
      ? Number(rawCost) * (item.presentation && item.presentation.costPrice === undefined ? presFactor : 1)
      : undefined;

  const rawMin =
    item.presentation?.minSalePrice ??
    item.minSalePrice ??
    item.product?.minSalePrice;

  if (enableMinSalePrice && rawMin !== undefined && rawMin !== null) {
    const configured = Number(rawMin);
    if (Number.isFinite(configured) && configured > 0) {
      if (cost !== undefined && cost > configured) {
        return Math.round(cost * 100) / 100;
      }
      return Math.round(configured * 100) / 100;
    }
  }

  if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
    return Math.round(cost * 100) / 100;
  }

  return 0;
}

// ============================================================================
// 6. PROMOTIONS, GIFTS, ICBPER & DECIMAL HELPERS
// ============================================================================

export const ICBPER_BAG_FEE = 0.5;
export const ICBPER_CART_ITEM_ID = 'icbper_plastic_bag_fee';

/**
 * Parses decimal inputs normalizing Peru comma separators (`12,50` -> `12.50`).
 */
export function parseNormalizedDecimal(raw: string | number | undefined | null): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const cleaned = String(raw || '').trim().replace(',', '.');
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolves available physical stock for a product in the given branch (with legacy Principal fallback).
 */
export function resolveProductBranchStock(product: Product, branchId: string = 'main'): number {
  const stockMap = product.stock;
  if (typeof stockMap === 'number') return Number(stockMap) || 0;
  if (!stockMap || typeof stockMap !== 'object') return 0;
  if (typeof stockMap[branchId] === 'number') return Number(stockMap[branchId]) || 0;
  const fallbackKey = Object.keys(stockMap).find(
    (k) => k.toLowerCase().includes('principal') || k.toLowerCase().includes('main')
  );
  return fallbackKey ? Number(stockMap[fallbackKey] || 0) : 0;
}

/**
 * Checks whether any item in the cart is marked as ICBPER / plastic bag product.
 */
export function cartHasPlasticBagProducts(items: readonly CartItem[]): boolean {
  return items.some((item) => {
    if (item.id.startsWith(ICBPER_CART_ITEM_ID) || item.productId === ICBPER_CART_ITEM_ID) {
      return false;
    }
    const raw = item as any;
    const prod = raw.product as any;
    if (raw.icbper === true || prod?.icbper === true) return true;
    const text = normalizeSearchText(
      [
        item.name,
        item.category,
        ...(Array.isArray(prod?.tags) ? prod.tags : []),
        ...(Array.isArray(raw.tags) ? raw.tags : []),
      ]
        .filter(Boolean)
        .join(' ')
    );
    return (
      text.includes('icbper') ||
      text.includes('bolsa') ||
      text.includes('plastica') ||
      text.includes('plastic')
    );
  });
}

/**
 * Returns eligible gift products respecting Web rules:
 * - `enableGifts === false` -> `[]`
 * - `giftProductIds` defined as `[]` -> `[]` (no gifts permitted)
 * - `giftProductIds === undefined` -> all active in-stock products for the branch
 */
export function getEligibleGiftProducts(
  products: readonly Product[],
  discountSettings: DiscountSettings | null | undefined,
  branchId: string = 'main'
): Product[] {
  if (discountSettings?.enableGifts === false) return [];
  const configuredIds = discountSettings?.giftProductIds;
  if (Array.isArray(configuredIds) && configuredIds.length === 0) return [];
  const allowedSet = Array.isArray(configuredIds) ? new Set(configuredIds) : null;

  return products.filter((p) => {
    if (p.active === false) return false;
    if (allowedSet && !allowedSet.has(p.id)) return false;
    return resolveProductBranchStock(p, branchId) > 0;
  });
}

export interface PromotionSuggestion {
  promotionId: string;
  name: string;
  type: 'percentage' | 'fixed' | 'buy_x_get_y' | 'free_product' | string;
  description: string;
  suggestedDiscountAmount: number;
  freeProduct?: Product;
  freeQuantity?: number;
}

const getBaseProductIdFromCartItem = (item: CartItem): string => {
  if (item.productId) return item.productId;
  if (item.product?.id) return item.product.id;
  return item.id.includes('_') ? item.id.split('_')[0] : item.id;
};

/**
 * Evaluates active promotion rules against current cart lines and catalog products
 * to produce actionable discount or free-gift suggestions.
 */
export function evaluateCartPromotions(
  items: readonly CartItem[],
  promotions: readonly PromotionRule[] | undefined | null,
  products: readonly Product[] = []
): PromotionSuggestion[] {
  if (!Array.isArray(promotions) || promotions.length === 0 || items.length === 0) {
    return [];
  }

  const paidItems = items.filter((item) => !item.isGift && item.price > 0 && item.quantity > 0);
  const giftItems = items.filter((item) => item.isGift);
  const suggestions: PromotionSuggestion[] = [];

  for (const promo of promotions) {
    if (!promo || promo.active === false) continue;

    const promoType = String(promo.type || '').toLowerCase();
    const cond = (promo.conditions || {}) as Record<string, any>;
    const ben = (promo.benefits || {}) as Record<string, any>;

    const targetIds = new Set<string>(
      [
        promo.productId,
        cond.productId,
        ...(Array.isArray(cond.productIds) ? cond.productIds : []),
        ...(Array.isArray(cond.targetProductIds) ? cond.targetProductIds : []),
      ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    );
    const targetCategory = normalizeSearchText(cond.category || cond.targetCategory);

    const matchingPaid = paidItems.filter((item) => {
      const baseId = getBaseProductIdFromCartItem(item);
      if (targetIds.size > 0 && !targetIds.has(baseId)) return false;
      if (targetCategory && normalizeSearchText(item.category) !== targetCategory) return false;
      return true;
    });

    if (matchingPaid.length === 0) continue;

    const matchedQty = matchingPaid.reduce((sum, it) => sum + Number(it.quantity || 0), 0);
    const matchedSubtotal = matchingPaid.reduce(
      (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
      0
    );

    if (promoType === 'percentage' || promoType === 'fixed') {
      const minQty = Number(promo.minQuantity ?? cond.minQuantity ?? 0);
      const minAmount = Number(cond.minAmount ?? 0);
      if (minQty > 0 && matchedQty < minQty) continue;
      if (minAmount > 0 && matchedSubtotal < minAmount) continue;

      const pct = Number(promo.discountPercent ?? ben.discountPercent ?? 0);
      const fixed = Number(ben.discountAmount ?? ben.amount ?? 0);
      const rawDiscount =
        promoType === 'percentage' ? (matchedSubtotal * pct) / 100 : fixed;
      const suggestedDiscountAmount = Math.min(
        matchedSubtotal,
        Math.max(0, Math.round(rawDiscount * 100) / 100)
      );
      if (suggestedDiscountAmount > 0) {
        suggestions.push({
          promotionId: promo.id,
          name: promo.name,
          type: promoType,
          description:
            promo.description ||
            (promoType === 'percentage'
              ? `${pct}% de descuento (${matchingPaid.length} ${matchingPaid.length === 1 ? 'línea' : 'líneas'})`
              : `Descuento fijo de S/ ${suggestedDiscountAmount.toFixed(2)}`),
          suggestedDiscountAmount,
        });
      }
      continue;
    }

    if (promoType === 'buy_x_get_y' || promoType === 'free_product') {
      const minQty = Math.max(
        1,
        Number(promo.minQuantity ?? cond.minQuantity ?? cond.buyQuantity ?? cond.buyQty ?? 1)
      );
      if (matchedQty < minQty) continue;

      const sets = Math.floor(matchedQty / minQty);
      const perSetGiftQty = Math.max(
        1,
        Number(promo.freeQuantity ?? ben.freeQuantity ?? ben.getQuantity ?? ben.getQty ?? 1)
      );
      const totalRewardQty = sets * perSetGiftQty;

      const preferredGiftId =
        promo.freeProductId ||
        ben.freeProductId ||
        promo.productId ||
        Array.from(targetIds)[0] ||
        getBaseProductIdFromCartItem(matchingPaid[0]);

      const freeProduct =
        products.find((p) => p.id === preferredGiftId && p.active !== false) ||
        matchingPaid.find((it) => getBaseProductIdFromCartItem(it) === preferredGiftId)?.product;

      if (!freeProduct) continue;

      const alreadyGifted = giftItems
        .filter((g) => getBaseProductIdFromCartItem(g) === freeProduct.id)
        .reduce((sum, g) => sum + Number(g.quantity || 0), 0);
      const remainingGiftQty = Math.max(0, totalRewardQty - alreadyGifted);

      if (remainingGiftQty > 0) {
        suggestions.push({
          promotionId: promo.id,
          name: promo.name,
          type: promoType,
          description:
            promo.description ||
            `Califica a ${remainingGiftQty}x ${freeProduct.name} gratis (compra ${minQty}+).`,
          suggestedDiscountAmount: 0,
          freeProduct,
          freeQuantity: remainingGiftQty,
        });
      }
    }
  }

  return suggestions;
}
