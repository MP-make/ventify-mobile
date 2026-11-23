import type { CartItem, Product, ProductVariant } from '@/types';
import type { PendingOfflineSale } from '@/services/offline-sync-service';
import { deriveBranchIds, deriveLowStockBranches } from '@/lib/product-branch-ids';
import { presentationFactor } from '@/lib/presentation-parity';
import {
  getAvailableStock,
  getReservedStock,
  resolveProductBranchStock,
} from '@/lib/product-search';

export interface AuthoritativeProductStockPatch {
  productId: string;
  stock: Record<string, number>;
  branchIds: string[];
  lowStockBranches: string[];
  variants?: ProductVariant[];
  reservedStock?: Record<string, number>;
}

export interface OfflineStockAdjustOp {
  id: string;
  offlineOpId: string;
  type: 'stock_adjust';
  accountId: string;
  userId: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  productSku?: string;
  variantId?: string;
  variantName?: string;
  mode: 'add' | 'subtract' | 'set';
  amount: number;
  expectedBeforeStock: number;
  reason: string;
  notes?: string;
  userProfile?: any;
  timestamp: number;
  retryCount: number;
  nextRetryAt?: number;
  lastErrorReason?: string;
}

export interface OfflineProductCreateOp {
  id: string;
  offlineOpId: string;
  type: 'product_create';
  accountId: string;
  userId: string;
  branchId: string;
  productId: string;
  productData: Record<string, any>;
  previewProduct: Product;
  userProfile?: any;
  timestamp: number;
  retryCount: number;
  nextRetryAt?: number;
  lastErrorReason?: string;
}

export interface OfflineProductUpdateOp {
  id: string;
  offlineOpId: string;
  type: 'product_update';
  accountId: string;
  userId: string;
  branchId: string;
  productId: string;
  productData: Record<string, any>;
  previewPatch: Partial<Product>;
  userProfile?: any;
  timestamp: number;
  retryCount: number;
  nextRetryAt?: number;
  lastErrorReason?: string;
}

export type OfflineInventoryOperation =
  | OfflineStockAdjustOp
  | OfflineProductCreateOp
  | OfflineProductUpdateOp;

export const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function resolveItemBaseProductId(
  item: { productId?: string; id?: string },
  productsById: Pick<ReadonlyMap<string, Product>, 'has'>
): string {
  const rawProductId = String(item?.productId || '').trim();
  if (rawProductId) {
    if (productsById.has(rawProductId)) return rawProductId;
    if (rawProductId.includes('_')) {
      const base = rawProductId.split('_')[0];
      if (base && productsById.has(base)) return base;
    }
    return rawProductId;
  }

  const rawId = String(item?.id || '').trim();
  if (rawId) {
    if (productsById.has(rawId)) return rawId;
    if (rawId.includes('_')) {
      const base = rawId.split('_')[0];
      if (base && productsById.has(base)) return base;
    }
    return rawId;
  }

  return '';
}

export function resolveItemBaseUnits(item: {
  quantity?: number;
  presentationQty?: number;
  conversionFactor?: number;
  presentation?: any;
}): number {
  const qty = Number(item?.quantity || 0);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const factorRaw =
    item?.presentationQty ??
    item?.conversionFactor ??
    (item?.presentation ? presentationFactor(item.presentation) : 1);
  const factor = Number(factorRaw);
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return round4(qty * safeFactor);
}

export function resolveProductStockBranchKey(
  stock: Record<string, number> | number | null | undefined,
  branchId: string = 'main'
): string {
  const target = branchId || 'main';
  if (!stock || typeof stock !== 'object') return target;
  if (typeof stock[target] === 'number') return target;
  for (const key in stock) {
    if (!Object.prototype.hasOwnProperty.call(stock, key)) continue;
    const lower = key.toLowerCase();
    if (lower.includes('principal') || lower.includes('main')) {
      return key;
    }
  }
  return target;
}

export function resolveVariantBranchStock(
  variant: Pick<ProductVariant, 'stock'> | null | undefined,
  branchId: string
): number {
  if (!variant || variant.stock === undefined || variant.stock === null) return 0;
  if (typeof variant.stock === 'number') return Math.max(0, Number(variant.stock) || 0);
  if (branchId && variant.stock[branchId] !== undefined) {
    return Math.max(0, Number(variant.stock[branchId] ?? 0));
  }
  if (!branchId || branchId === 'main') {
    const firstVal = Object.values(variant.stock)[0];
    return Math.max(0, Number(firstVal ?? 0));
  }
  return 0;
}

function normalizeStockMap(
  rawStock: Record<string, number> | number | null | undefined,
  fallbackBranchId: string
): Record<string, number> {
  if (typeof rawStock === 'number') {
    return { [fallbackBranchId || 'main']: Number.isFinite(rawStock) ? rawStock : 0 };
  }
  if (rawStock && typeof rawStock === 'object') {
    return { ...rawStock };
  }
  return {};
}

function cloneProductWithStock(
  product: Product,
  nextStock: Record<string, number>,
  nextVariants?: ProductVariant[]
): Product {
  const nextReserved = product.reservedStock ? { ...product.reservedStock } : undefined;
  return {
    ...product,
    stock: nextStock,
    branchIds: deriveBranchIds(nextStock, product.branchIds),
    lowStockBranches: deriveLowStockBranches(nextStock, nextReserved),
    ...(nextVariants !== undefined ? { variants: nextVariants } : {}),
  };
}

export interface OfflineProductProjectionsResult {
  overlayProducts: Map<string, Product>;
  createdIds: Set<string>;
  affectedIds: Set<string>;
}

/**
 * Projects pending offline inventory operations (creates/updates/adjustments)
 * followed by pending offline sales on top of authoritative base products.
 */
export function computeOfflineProductProjections(
  baseProductsById: ReadonlyMap<string, Product>,
  pendingSales: readonly PendingOfflineSale[],
  pendingInventoryOps: readonly OfflineInventoryOperation[],
  fallbackBranchId: string = 'main',
  accountId?: string
): OfflineProductProjectionsResult {
  const workingMap = new Map<string, Product>();
  const createdIds = new Set<string>();
  const affectedIds = new Set<string>();

  const getWorkingProduct = (productId: string): Product | undefined =>
    workingMap.get(productId) ?? baseProductsById.get(productId);

  const sortedOps = [...pendingInventoryOps].sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
  );

  for (const op of sortedOps) {
    if (!op || !op.productId) continue;
    if (accountId && op.accountId && op.accountId !== accountId) continue;

    if (op.type === 'product_create') {
      const preview = op.previewProduct;
      if (!preview) continue;
      const stockMap = normalizeStockMap(preview.stock, op.branchId || fallbackBranchId);
      const cloned: Product = {
        ...preview,
        id: op.productId,
        stock: stockMap,
        reservedStock: preview.reservedStock ? { ...preview.reservedStock } : {},
        branchIds: deriveBranchIds(stockMap, preview.branchIds),
        lowStockBranches: deriveLowStockBranches(stockMap, preview.reservedStock),
        variants: Array.isArray(preview.variants)
          ? preview.variants.map((v) => ({
              ...v,
              stock:
                typeof v.stock === 'object' && v.stock !== null ? { ...v.stock } : v.stock,
            }))
          : preview.variants,
      };
      workingMap.set(op.productId, cloned);
      createdIds.add(op.productId);
      affectedIds.add(op.productId);
      continue;
    }

    if (op.type === 'product_update') {
      const current = getWorkingProduct(op.productId);
      if (!current) continue;
      const { stock: _ignoredStock, reservedStock: _ignoredReserved, ...safePatch } =
        (op.previewPatch || {}) as Partial<Product>;
      const updated: Product = {
        ...current,
        ...safePatch,
        id: current.id,
        stock: current.stock ? { ...current.stock } : {},
        reservedStock: current.reservedStock ? { ...current.reservedStock } : {},
      };
      workingMap.set(op.productId, updated);
      affectedIds.add(op.productId);
      continue;
    }

    if (op.type === 'stock_adjust') {
      const current = getWorkingProduct(op.productId);
      if (!current) continue;

      const opBranch = op.branchId || fallbackBranchId || 'main';
      const nextStock = normalizeStockMap(current.stock, opBranch);
      const branchKey = resolveProductStockBranchKey(nextStock, opBranch);
      let nextVariants: any[] | undefined = Array.isArray(current.variants)
        ? current.variants.map((v: any) => ({
            ...v,
            stock: typeof v.stock === 'object' && v.stock !== null ? { ...v.stock } : v.stock,
          }))
        : undefined;

      if (op.variantId && nextVariants) {
        let matchedVariant = false;
        let aggregatedBranchStock = 0;
        nextVariants = nextVariants.map((variant) => {
          if (variant.id === op.variantId) {
            matchedVariant = true;
            const prevVarQty = resolveVariantBranchStock(variant, branchKey);
            let nextVarQty = prevVarQty;
            if (op.mode === 'add') {
              nextVarQty = round4(prevVarQty + op.amount);
            } else if (op.mode === 'subtract') {
              nextVarQty = Math.max(0, round4(prevVarQty - op.amount));
            } else {
              nextVarQty = Math.max(0, round4(op.amount));
            }
            aggregatedBranchStock += nextVarQty;
            if (typeof variant.stock === 'object' && variant.stock !== null) {
              return {
                ...variant,
                stock: { ...variant.stock, [branchKey]: nextVarQty },
              };
            }
            return { ...variant, stock: nextVarQty };
          }
          aggregatedBranchStock += resolveVariantBranchStock(variant, branchKey);
          return variant;
        });

        if (matchedVariant) {
          nextStock[branchKey] = round4(aggregatedBranchStock);
          workingMap.set(
            op.productId,
            cloneProductWithStock(current, nextStock, nextVariants)
          );
          affectedIds.add(op.productId);
          continue;
        }
      }

      const prevBranchQty = Number(nextStock[branchKey] ?? 0);
      let nextBranchQty = prevBranchQty;
      if (op.mode === 'add') {
        nextBranchQty = round4(prevBranchQty + op.amount);
      } else if (op.mode === 'subtract') {
        nextBranchQty = Math.max(0, round4(prevBranchQty - op.amount));
      } else {
        nextBranchQty = Math.max(0, round4(op.amount));
      }
      nextStock[branchKey] = nextBranchQty;
      workingMap.set(op.productId, cloneProductWithStock(current, nextStock, nextVariants));
      affectedIds.add(op.productId);
    }
  }

  const sortedSales = [...pendingSales].sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
  );

  const workingOrBaseLookup = {
    has: (id: string) => workingMap.has(id) || baseProductsById.has(id),
  };

  for (const sale of sortedSales) {
    const payload = sale?.salePayload as Record<string, any> | undefined;
    if (!payload) continue;
    if (accountId && payload.accountId && payload.accountId !== accountId) continue;
    if (payload.isQuote === true || payload.documentType === 'cotizacion') continue;

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (items.length === 0) continue;

    const saleBranchId = String(payload.branchId || fallbackBranchId || 'main');

    // Group deductions per resolved base product inside this sale
    const productItemGroups = new Map<
      string,
      Array<{ branchId: string; variantId?: string; units: number }>
    >();

    for (const rawItem of items) {
      if (!rawItem) continue;
      const baseProductId = resolveItemBaseProductId(rawItem, workingOrBaseLookup);
      if (!baseProductId) continue;
      const currentProduct = getWorkingProduct(baseProductId);
      if (!currentProduct) continue; // Safely skip synthetic items (e.g. ICBPER, quick concepts)

      const units = resolveItemBaseUnits(rawItem);
      if (units <= 0) continue;

      const itemBranch = String(rawItem.stockBranchId || saleBranchId || 'main');
      const variantId = rawItem.variantId || rawItem.variant?.id;

      const group = productItemGroups.get(baseProductId) || [];
      group.push({ branchId: itemBranch, variantId, units });
      productItemGroups.set(baseProductId, group);
    }

    for (const [productId, entries] of productItemGroups) {
      const current = getWorkingProduct(productId);
      if (!current) continue;

      const nextStock = normalizeStockMap(current.stock, saleBranchId);
      const variantDeductionsByKey = new Map<string, Map<string, number>>();

      for (const entry of entries) {
        const branchKey = resolveProductStockBranchKey(nextStock, entry.branchId);
        const curQty = Number(nextStock[branchKey] ?? 0);
        nextStock[branchKey] = Math.max(0, round4(curQty - entry.units));

        if (entry.variantId) {
          let branchVarMap = variantDeductionsByKey.get(branchKey);
          if (!branchVarMap) {
            branchVarMap = new Map<string, number>();
            variantDeductionsByKey.set(branchKey, branchVarMap);
          }
          branchVarMap.set(
            entry.variantId,
            round4((branchVarMap.get(entry.variantId) || 0) + entry.units)
          );
        }
      }

      let nextVariants = current.variants;
      if (Array.isArray(current.variants) && variantDeductionsByKey.size > 0) {
        nextVariants = current.variants.map((variant) => {
          let updatedVariant = variant;
          for (const [branchKey, varMap] of variantDeductionsByKey) {
            const units = varMap.get(variant.id) || 0;
            if (!units) continue;
            const curVarQty = resolveVariantBranchStock(updatedVariant, branchKey);
            const nextVarQty = Math.max(0, round4(curVarQty - units));
            if (typeof updatedVariant.stock === 'object' && updatedVariant.stock !== null) {
              updatedVariant = {
                ...updatedVariant,
                stock: { ...updatedVariant.stock, [branchKey]: nextVarQty },
              };
            } else {
              updatedVariant = { ...updatedVariant, stock: nextVarQty as any };
            }
          }
          return updatedVariant;
        });
      }

      workingMap.set(productId, cloneProductWithStock(current, nextStock, nextVariants));
      affectedIds.add(productId);
    }
  }

  return {
    overlayProducts: workingMap,
    createdIds,
    affectedIds,
  };
}

/**
 * Sums total base units currently sitting in the cart for a given product
 * (or specific variant), including presentations and gift lines.
 */
export function getCartReservedUnitsForProduct(
  cartItems: readonly CartItem[],
  productId: string,
  variantId?: string
): number {
  if (!productId || !Array.isArray(cartItems) || cartItems.length === 0) return 0;
  let total = 0;
  for (const item of cartItems) {
    if (!item || item.productId !== productId) continue;
    if (variantId !== undefined) {
      const itemVarId = item.variantId || item.variant?.id;
      if (itemVarId !== variantId) continue;
    }
    total = round4(total + resolveItemBaseUnits(item));
  }
  return total;
}

/**
 * Aggregates cart/sale items by product and variant to validate that enough
 * available stock exists before committing or enqueuing an offline sale.
 */
export function validateCartStockForCheckout(
  items: readonly any[],
  productsById: ReadonlyMap<string, Product>,
  branchId: string = 'main'
): { ok: boolean; error?: string } {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true };
  }

  const productNeeds = new Map<
    string,
    {
      name: string;
      branchId: string;
      totalUnits: number;
      variantUnits: Map<string, { name: string; units: number }>;
    }
  >();

  for (const item of items) {
    if (!item) continue;
    const baseProductId = resolveItemBaseProductId(item, productsById);
    if (!baseProductId) continue;
    const product = productsById.get(baseProductId);
    if (!product) continue; // Ignore synthetic fees/concepts not in catalog

    const units = resolveItemBaseUnits(item);
    if (units <= 0) continue;

    const itemBranch = String(item.stockBranchId || branchId || 'main');
    const existing = productNeeds.get(baseProductId) || {
      name: product.name || item.name || 'Producto',
      branchId: itemBranch,
      totalUnits: 0,
      variantUnits: new Map<string, { name: string; units: number }>(),
    };
    existing.totalUnits = round4(existing.totalUnits + units);

    const variantId = item.variantId || item.variant?.id;
    if (variantId) {
      const prevVar = existing.variantUnits.get(variantId) || {
        name: item.variantName || item.variant?.name || variantId,
        units: 0,
      };
      prevVar.units = round4(prevVar.units + units);
      existing.variantUnits.set(variantId, prevVar);
    }

    productNeeds.set(baseProductId, existing);
  }

  for (const [productId, need] of productNeeds) {
    const product = productsById.get(productId);
    if (!product) continue;

    const stockKey = resolveProductStockBranchKey(product.stock, need.branchId);
    const reserved = Number(
      product.reservedStock?.[stockKey] ?? product.reservedStock?.[need.branchId] ?? 0
    );
    const physical =
      typeof product.stock === 'number'
        ? Number(product.stock)
        : typeof product.stock === 'object' && product.stock?.[stockKey] !== undefined
        ? resolveProductBranchStock(product, stockKey)
        : getAvailableStock(product, stockKey) + getReservedStock(product, stockKey);
    const effectiveAvailable = Math.max(0, physical - reserved);

    if (effectiveAvailable < need.totalUnits - 0.00001) {
      return {
        ok: false,
        error: `Stock insuficiente para "${need.name}". Disponible: ${effectiveAvailable.toFixed(2)}, Requerido: ${need.totalUnits.toFixed(2)}.`,
      };
    }

    if (Array.isArray(product.variants) && need.variantUnits.size > 0) {
      for (const [variantId, varNeed] of need.variantUnits) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (!variant) continue;
        const varStock = resolveVariantBranchStock(variant, stockKey);
        if (varStock < varNeed.units - 0.00001) {
          return {
            ok: false,
            error: `Stock insuficiente para la variante "${varNeed.name}" de "${need.name}". Disponible: ${varStock.toFixed(2)}, Requerido: ${varNeed.units.toFixed(2)}.`,
          };
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Builds a minimal read-only map view (get/has) from a product getter so callers
 * holding only `getProductById` (actions context) can validate cart stock
 * without subscribing to the full catalog.
 */
export function createProductLookup(
  getProductById: (id: string) => Product | undefined
): ReadonlyMap<string, Product> {
  return {
    get: (id: string) => getProductById(id),
    has: (id: string) => getProductById(id) !== undefined,
  } as unknown as ReadonlyMap<string, Product>;
}

/**
 * Returns true for errors raised before a sale transaction reached the server
 * (network down, timeout, unavailable). Used to fall back to the offline queue.
 */
export function isLikelyNetworkError(err: unknown): boolean {
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = String((err as any)?.message || err || '').toLowerCase();
  if (code === 'unavailable' || code === 'deadline-exceeded' || code.includes('network')) {
    return true;
  }
  return (
    msg.includes('network') ||
    msg.includes('sin conexión') ||
    msg.includes('tiempo de espera') ||
    msg.includes('timeout') ||
    msg.includes('unavailable') ||
    msg.includes('offline') ||
    msg.includes('failed to fetch') ||
    msg.includes('servicio no disponible')
  );
}
