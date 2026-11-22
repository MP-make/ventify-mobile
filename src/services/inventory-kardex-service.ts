import { normalizePresentation, presentationFactor } from '@/lib/presentation-parity';
/**
 * Ventify Mobile - Inventory & Kardex Service
 * 
 * Gestión integral de inventario, catálogo de productos, movimientos de Kardex oficial
 * (`inventory_movements`), ajustes atómicos de stock y circuito de transferencias entre sucursales.
 * 
 * Paridad 100% con Ventify Web y firestore.rules:
 * - lowStockBranches con sentinel __any__ al inicio y exclusión de stock negativo.
 * - deriveBranchIds para persistencia de sucursales en productos nuevos con stock 0.
 * - Kardex con campos canónicos Web (movementType, quantityBefore, quantityAfter, quantityChanged)
 *   y campos alias Mobile (type, previousStock, newStock, quantity).
 * - Ajuste y transferencias sin updatedAt en products para cumplimiento de firestore.rules para cajeros.
 * - Transferencias con reserva de stock en pending y transición pending -> approved -> completed.
 */

import { db, app } from '@/lib/firebase';
import type {
  Product,
  InventoryMovement,
  ProductPresentation,
  ProductVariant,
  PriceTier,
  BranchPriceConfig,
} from '@/types';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  Timestamp,
} from 'firebase/firestore';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { apiRequest } from '@/lib/api-client';
import { sharedRequestCache } from '@/lib/request-cache';
import {
  findProductByBarcode,
  getAvailableStock,
  getBranchPricingConfig,
  type ScannedProductMatch,
} from '@/lib/product-search';

declare module '@/types' {
  interface Product {
    taxExemptionCode?: '10' | '20' | '30' | string;
  }
}

// ============================================================================
// CONSTANTES
// ============================================================================

export const PRODUCTS_COLLECTION = 'products';
export const INVENTORY_MOVEMENTS_COLLECTION = 'inventory_movements';
export const TRANSFERS_COLLECTION = 'transfers';
export const INVENTORY_ADJUSTMENTS_COLLECTION = 'inventory_adjustments';

export const LOW_STOCK_THRESHOLD = 5;
export const LOW_STOCK_ANY = '__any__';
export const DEFAULT_MIN_STOCK_THRESHOLD = LOW_STOCK_THRESHOLD;

const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

import type { UserProfileInfo } from './sale-service';

export interface AdjustStockParams {
  product: {
    id: string;
    name: string;
    sku?: string;
    accountId: string;
    stock?: Record<string, number>;
    reservedStock?: Record<string, number>;
    minStock?: number;
    variants?: ProductVariant[];
  };
  branchId: string;
  branchName?: string;
  newStock: number;
  variantId?: string;
  variantName?: string;
  reason: 'adjustment' | 'damage' | 'loss' | 'count_audit' | 'restock' | 'return' | string;
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface AdjustStockResult {
  previousStock: number;
  newStock: number;
  diff: number;
  before: Record<string, number>;
  after: Record<string, number>;
  variantId?: string;
}

export interface TransferItem {
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
  variantId?: string;
  variantName?: string;
}

export interface TransferItem {
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
  variantId?: string;
  variantName?: string;
}

export interface CreateTransferParams {
  accountId: string;
  fromBranchId: string;
  fromBranchName?: string;
  toBranchId: string;
  toBranchName?: string;
  sourceBranchId?: string;
  sourceBranchName?: string;
  destinationBranchId?: string;
  destinationBranchName?: string;
  items: TransferItem[];
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface StockTransfer {
  id: string;
  transferNumber?: string;
  accountId: string;
  sourceBranchId?: string;
  sourceBranchName?: string;
  destinationBranchId?: string;
  destinationBranchName?: string;
  fromBranchId: string;
  fromBranchName?: string;
  toBranchId: string;
  toBranchName?: string;
  items: TransferItem[];
  products?: Array<{
    productId: string;
    productName?: string;
    name?: string;
    sku?: string;
    quantity: number;
    variantId?: string;
    variantName?: string;
  }>;
  status: 'pending' | 'approved' | 'in_transit' | 'completed' | 'cancelled' | 'rejected';
  notes?: string;
  requestedBy?: string;
  requestedByName?: string;
  requestedAt?: number | Timestamp | any;
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: number | Timestamp | any;
  sentBy?: string;
  sentByName?: string;
  sentAt?: number | Timestamp | any;
  shippedAt?: number | Timestamp | any;
  receivedBy?: string;
  receivedByName?: string;
  receivedAt?: number | Timestamp | any;
  completedAt?: number | Timestamp | any;
  createdAt?: number | Timestamp | any;
  updatedAt?: number | Timestamp | any;
}

// ============================================================================
// HELPERS PUROS (COMPARTIDOS ENTRE UI Y TESTS)
// ============================================================================

import {
  isLocalFileUri,
  normalizePriceTiers,
  sanitizeRemoteImageUrls,
} from '@/lib/product-normalization';
export { isLocalFileUri, normalizePriceTiers, sanitizeRemoteImageUrls };

const roundToCents = (value: number): number => {
  const n = Number(value) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/**
 * Calcula peso y precio unitario ajustado en el modal de pesables para evitar
 * desvíos de S/ 0.01 cuando el cajero ingresa un monto exacto en Soles.
 */
export const calculateWeightEntry = (params: {
  mode: 'weight' | 'amount';
  rawValue: number;
  unitPrice: number;
  minSalePrice?: number;
}): { weight: number; subtotal: number; customPrice?: number } => {
  const safeRaw = Number.isFinite(params.rawValue) ? Math.max(0, params.rawValue) : 0;
  const unitPrice = Number.isFinite(params.unitPrice) ? Math.max(0, params.unitPrice) : 0;

  if (params.mode === 'weight') {
    const weight = Math.round(safeRaw * 1000) / 1000;
    const subtotal = roundToCents(weight * unitPrice);
    return { weight, subtotal, customPrice: undefined };
  }

  const money = roundToCents(safeRaw);
  if (money <= 0 || unitPrice <= 0) {
    return { weight: 0, subtotal: money, customPrice: undefined };
  }

  const roundedWeight = Math.round((money / unitPrice) * 1000) / 1000;
  const flooredWeight = Math.floor((money / unitPrice) * 1000) / 1000;
  const rawMin = Number(params.minSalePrice ?? 0);
  const safeFloor = rawMin > 0 && rawMin <= unitPrice ? rawMin : 0;

  let weight = roundedWeight > 0 ? roundedWeight : 0.001;
  if (safeFloor > 0 && money / weight < safeFloor) {
    weight = flooredWeight > 0 ? flooredWeight : 0.001;
  }

  const exactUnitPrice = money / weight;
  const candidate6 = Math.round(exactUnitPrice * 1_000_000) / 1_000_000;
  const customPrice = roundToCents(weight * candidate6) === money ? candidate6 : exactUnitPrice;

  return { weight, subtotal: money, customPrice };
};

/** Resuelve el stock físico de una variante en la sucursal dada. */
export const getVariantBranchStock = (
  variant: Pick<ProductVariant, 'stock'> | null | undefined,
  branchId: string
): number => {
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
};

/**
 * Calcula el precio combinado de presentación + variante y genera una presentación
 * normalizada lista para carrito/checkout.
 */
export const resolvePresentationVariantPrice = (params: {
  basePrice: number;
  presentation?: (Partial<ProductPresentation> & { factor?: number }) | null;
  variant?: Partial<ProductVariant> | null;
  minSalePrice?: number;
  enableMinSalePrice?: boolean;
}): {
  unitPrice: number;
  factor: number;
  effectivePresentation?: ProductPresentation;
} => {
  const basePrice = Math.max(0, Number(params.basePrice) || 0);
  const pres = params.presentation || null;
  const variant = params.variant || null;
  const factor = pres ? presentationFactor(pres) : 1;
  const enforceFloor = params.enableMinSalePrice !== false;
  const baseMin = enforceFloor ? Math.max(0, Number(params.minSalePrice) || 0) : 0;

  let variantDelta = 0;
  if (variant) {
    if (variant.price !== undefined && variant.price !== null && Number(variant.price) > 0) {
      variantDelta = Number(variant.price) - basePrice;
    } else if (variant.priceAdjustment !== undefined && variant.priceAdjustment !== null) {
      variantDelta = Number(variant.priceAdjustment) || 0;
    }
  }

  if (pres) {
    const rawPresPrice = Number(pres.price ?? 0);
    const presBasePrice = rawPresPrice > 0 ? rawPresPrice : roundToCents(basePrice * factor);
    let combined = roundToCents(Math.max(0, presBasePrice + variantDelta * factor));
    const presFloor = enforceFloor ? Math.max(0, Number(pres.minSalePrice ?? 0)) : 0;
    if (presFloor > 0 && combined < presFloor) {
      combined = presFloor;
    }
    const effectivePresentation: ProductPresentation = {
      ...(pres as ProductPresentation),
      id: String(pres.id || ''),
      name: String(pres.name || ''),
      conversionFactor: factor,
      quantity: factor,
      price: combined,
      active: pres.active !== false,
    };
    return { unitPrice: combined, factor, effectivePresentation };
  }

  let unitPrice = roundToCents(Math.max(0, basePrice + variantDelta));
  if (baseMin > 0 && unitPrice < baseMin) {
    unitPrice = baseMin;
  }
  return { unitPrice, factor: 1, effectivePresentation: undefined };
};

/**
 * Calcula disponibilidad real respetando stock del producto, stock reservado
 * por transferencias/reservas y stock de la variante seleccionada.
 */
export const resolvePresentationVariantStock = (params: {
  product: Pick<Product, 'stock' | 'reservedStock'>;
  branchId: string;
  presentation?: (Partial<ProductPresentation> & { factor?: number }) | null;
  variant?: Pick<ProductVariant, 'stock'> | null;
}): {
  productAvailable: number;
  variantStock: number | null;
  effectiveAvailable: number;
  factor: number;
  maxUnits: number;
} => {
  const productAvailable = getAvailableStock(params.product as Product, params.branchId);
  const factor = params.presentation ? presentationFactor(params.presentation) : 1;
  const variantStock = params.variant ? getVariantBranchStock(params.variant, params.branchId) : null;
  const effectiveAvailable = variantStock !== null
    ? Math.min(productAvailable, variantStock)
    : productAvailable;
  const maxUnits = factor > 0 ? Math.floor(effectiveAvailable / factor) : 0;
  return {
    productAvailable,
    variantStock,
    effectiveAvailable,
    factor,
    maxUnits: Math.max(0, maxUnits),
  };
};

/**
 * Fusiona el stock editado desde el formulario de producto respetando cuentas
 * mono-sucursal, multi-sucursal y agregación automática desde variantes.
 */
export const mergeSingleBranchStock = (params: {
  existingStock?: Record<string, number> | null;
  stockByBranch?: Record<string, number> | null;
  singleBranchStock?: number;
  branchId: string;
  isMultiBranch: boolean;
  variants?: Array<{ stock?: Record<string, number> | number }> | null;
}): Record<string, number> => {
  const targetBranch = params.branchId || 'main';
  if (Array.isArray(params.variants) && params.variants.length > 0) {
    const aggregated: Record<string, number> = {};
    for (const v of params.variants) {
      if (typeof v?.stock === 'number') {
        aggregated[targetBranch] = (aggregated[targetBranch] || 0) + Math.max(0, Number(v.stock) || 0);
      } else if (v?.stock && typeof v.stock === 'object') {
        for (const [bId, qty] of Object.entries(v.stock)) {
          if (bId) {
            aggregated[bId] = (aggregated[bId] || 0) + Math.max(0, Number(qty) || 0);
          }
        }
      }
    }
    if (Object.keys(aggregated).length > 0) {
      return aggregated;
    }
  }

  const base: Record<string, number> = { ...(params.existingStock || {}) };
  const byBranch = params.stockByBranch || {};

  if (params.isMultiBranch) {
    for (const [bId, qty] of Object.entries(byBranch)) {
      const num = Number(qty);
      if (bId && Number.isFinite(num) && num >= 0) {
        base[bId] = num;
      }
    }
    if (Object.keys(base).length === 0 && targetBranch) {
      base[targetBranch] = Math.max(0, Number(params.singleBranchStock) || 0);
    }
    return base;
  }

  for (const [bId, qty] of Object.entries(byBranch)) {
    const num = Number(qty);
    if (bId && bId !== targetBranch && Number.isFinite(num) && num >= 0) {
      base[bId] = num;
    }
  }

  const explicitSingle =
    params.singleBranchStock !== undefined && Number.isFinite(Number(params.singleBranchStock))
      ? Math.max(0, Number(params.singleBranchStock))
      : undefined;
  const existingKeys = Object.keys(base);
  const activeKey =
    base[targetBranch] !== undefined
      ? targetBranch
      : existingKeys.length === 1
      ? existingKeys[0]
      : targetBranch;

  if (explicitSingle !== undefined) {
    base[activeKey] = explicitSingle;
  } else if (byBranch[activeKey] !== undefined && Number.isFinite(Number(byBranch[activeKey]))) {
    base[activeKey] = Math.max(0, Number(byBranch[activeKey]));
  } else if (base[activeKey] === undefined) {
    base[activeKey] = 0;
  }

  return base;
};

/** Sincroniza presentaciones para lectura bidireccional Web (`quantity`) y Mobile (`conversionFactor`). */
export const normalizePresentationBidirectional = <T extends Partial<ProductPresentation> & { factor?: number }>(
  presentation: T
): T & { conversionFactor: number; quantity: number; active: boolean } => {
  const normalized = normalizePresentation(presentation);
  return {
    ...normalized,
    quantity: normalized.conversionFactor,
    active: presentation.active !== false,
  };
};

/** Limpia overrides de precios por sucursal replicando `serializeBranchPrices` de Ventify Web. */
export const serializeBranchPrices = (
  editors: Record<string, BranchPriceConfig> | undefined | null,
  options: { baseSuggested: number; baseCost: number; showMinSalePrice: boolean }
): Record<string, BranchPriceConfig> => {
  if (!editors || typeof editors !== 'object') return {};
  const entries = Object.entries(editors)
    .map(([bId, cfg]) => {
      const sPrice = cfg?.suggestedPrice === undefined ? undefined : Number(cfg.suggestedPrice);
      const cPrice = cfg?.costPrice === undefined ? undefined : Number(cfg.costPrice);
      let mPrice = !options.showMinSalePrice
        ? undefined
        : cfg?.minSalePrice === undefined
        ? undefined
        : Number(cfg.minSalePrice);
      const effPrice = sPrice ?? options.baseSuggested;
      const effCost = cPrice ?? options.baseCost;

      if (options.showMinSalePrice) {
        if (mPrice === undefined && cPrice !== undefined) {
          mPrice = cPrice;
        }
        if (mPrice !== undefined && effCost > 0 && mPrice < effCost) {
          mPrice = effCost;
        }
        if (mPrice !== undefined && effPrice > 0 && mPrice > effPrice) {
          mPrice = effCost > 0 && effCost <= effPrice ? effCost : undefined;
        }
      } else {
        mPrice = undefined;
      }

      const cleanedTiers = Array.isArray(cfg?.priceTiers) && cfg.priceTiers.length > 0
        ? normalizePriceTiers(cfg.priceTiers)
        : undefined;
      const cleanedPres = Array.isArray(cfg?.presentations) && cfg.presentations.length > 0
        ? cfg.presentations.map(normalizePresentationBidirectional)
        : undefined;

      return [
        bId,
        {
          ...(sPrice !== undefined && Number.isFinite(sPrice) ? { suggestedPrice: roundToCents(sPrice) } : {}),
          ...(cPrice !== undefined && Number.isFinite(cPrice) ? { costPrice: roundToCents(cPrice) } : {}),
          ...(mPrice !== undefined && Number.isFinite(mPrice) ? { minSalePrice: roundToCents(mPrice) } : {}),
          ...(cleanedTiers ? { priceTiers: cleanedTiers } : {}),
          ...(cleanedPres ? { presentations: cleanedPres } : {}),
        } as BranchPriceConfig,
      ] as const;
    })
    .filter(([, cfg]) =>
      (cfg.suggestedPrice !== undefined && cfg.suggestedPrice > 0) ||
      (cfg.costPrice !== undefined && cfg.costPrice > 0) ||
      (cfg.minSalePrice !== undefined && cfg.minSalePrice > 0) ||
      (Array.isArray(cfg.priceTiers) && cfg.priceTiers.length > 0) ||
      (Array.isArray(cfg.presentations) && cfg.presentations.length > 0)
    );

  return Object.fromEntries(entries);
};

/**
 * Deriva el campo denormalizado branchIds de un producto a partir de su mapa de stock.
 * Si el producto no tiene ninguna entrada de stock, se usa fallbackBranchIds.
 */
export const deriveBranchIds = (
  stockMap: Record<string, number> | null | undefined,
  fallbackBranchIds: string[] = []
): string[] => {
  const ids = Object.keys(stockMap || {});
  return ids.length > 0 ? ids : fallbackBranchIds;
};

/**
 * Recalcula la lista de sucursales con stock bajo o agotado para consultas rápidas.
 * Excluye stock negativo (un disponible menor que cero es descuadre, no reposición).
 * Coloca LOW_STOCK_ANY ('__any__') al inicio del array.
 */
export const calculateLowStockBranches = (
  stockMap: Record<string, number> = {},
  reservedMap: Record<string, number> = {},
  threshold: number = LOW_STOCK_THRESHOLD
): string[] => {
  const branches = Object.keys(stockMap || {}).filter((branchId) => {
    const reserved = reservedMap?.[branchId] || 0;
    const available = (stockMap?.[branchId] || 0) - reserved;
    return available <= threshold && available >= 0;
  });

  return branches.length > 0 ? [LOW_STOCK_ANY, ...branches] : [];
};

export const deriveLowStockBranches = calculateLowStockBranches;

const aggregateTransferItems = <T extends { productId: string; productName?: string; name?: string; sku?: string; quantity: number; variantId?: string; variantName?: string }>(
  items: T[]
): Array<T & { quantity: number }> => {
  const aggregated = new Map<string, T & { quantity: number }>();
  for (const item of items) {
    const key = item.variantId ? `${item.productId}::${item.variantId}` : item.productId;
    const existing = aggregated.get(key);
    if (existing) existing.quantity += Number(item.quantity) || 0;
    else aggregated.set(key, { ...item, quantity: Number(item.quantity) || 0 });
  }
  return [...aggregated.values()];
};

const aggregateTransferQuantitiesByProduct = (
  items: Array<{ productId: string; quantity: number }>
): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (!item.productId) continue;
    totals.set(item.productId, (totals.get(item.productId) || 0) + (Number(item.quantity) || 0));
  }
  return totals;
};

/**
 * Normaliza bidireccionalmente los documentos de `inventory_movements`
 * para paridad 100% entre Ventify Web y Mobile.
 */
export const normalizeInventoryMovement = (data: any, id: string): any => {
  const raw = { id, ...data };

  // Si viene de la Web (con movementType, quantityBefore, quantityAfter, quantityChanged)
  if (raw.quantityChanged !== undefined && raw.quantity === undefined) {
    const qChanged = Number(raw.quantityChanged) || 0;
    raw.quantity = Math.abs(qChanged);
    raw.type = qChanged >= 0 ? 'in' : 'out';
    raw.previousStock = raw.quantityBefore !== undefined ? Number(raw.quantityBefore) : 0;
    raw.newStock = raw.quantityAfter !== undefined ? Number(raw.quantityAfter) : 0;
  }
  // Si viene de Mobile (con type, previousStock, newStock, quantity)
  else if (raw.quantity !== undefined && raw.quantityChanged === undefined) {
    const qty = Number(raw.quantity) || 0;
    const isIn = raw.type === 'in';
    raw.quantityChanged = isIn ? qty : -qty;
    raw.quantityBefore = raw.previousStock !== undefined ? Number(raw.previousStock) : 0;
    raw.newStock = raw.newStock !== undefined ? Number(raw.newStock) : 0;
    raw.movementType = raw.movementType || (isIn ? 'add' : (raw.reason === 'sale' ? 'sale' : 'edit'));
  }

  // Asegurar campos bidireccionales
  if (raw.quantity === undefined) raw.quantity = Math.abs(Number(raw.quantityChanged) || 0);
  if (raw.type === undefined) raw.type = (Number(raw.quantityChanged) || 0) >= 0 ? 'in' : 'out';
  if (raw.previousStock === undefined) raw.previousStock = Number(raw.quantityBefore) || 0;
  if (raw.newStock === undefined) raw.newStock = Number(raw.quantityAfter) || 0;
  if (raw.quantityChanged === undefined) raw.quantityChanged = raw.type === 'in' ? raw.quantity : -raw.quantity;
  if (raw.quantityBefore === undefined) raw.quantityBefore = raw.previousStock;
  if (raw.quantityAfter === undefined) raw.quantityAfter = raw.newStock;
  if (raw.movementType === undefined) raw.movementType = raw.type === 'in' ? 'add' : 'edit';
  if (!raw.productSku && raw.sku) raw.productSku = raw.sku;

  return raw;
};

// ============================================================================
// FIREBASE STORAGE - SUBIDA DE IMÁGENES DE PRODUCTOS
// ============================================================================

/**
 * Sube una imagen local (`file://` / `content://`) a Firebase Storage bajo
 * `products/{accountId}/{file}` cumpliendo estrictamente `storage.rules`.
 */
export const uploadProductImageToStorage = async (
  localUri: string,
  accountId: string,
  productId?: string
): Promise<string> => {
  const cleanUri = (localUri || '').trim();
  if (!cleanUri) {
    throw new Error('La URI de la imagen es obligatoria.');
  }
  if (/^https?:\/\//i.test(cleanUri)) {
    return cleanUri;
  }
  if (!accountId) {
    throw new Error('El identificador de cuenta (accountId) es obligatorio para subir imágenes.');
  }

  const response = await fetch(cleanUri);
  if (!response.ok) {
    throw new Error('No se pudo leer la imagen seleccionada desde el dispositivo.');
  }

  const blob = await response.blob();
  try {
    if (!blob || blob.size <= 0) {
      throw new Error('La imagen seleccionada está vacía o dañada.');
    }
    if (blob.size > MAX_PRODUCT_IMAGE_BYTES) {
      throw new Error('La imagen supera el límite permitido de 10 MB.');
    }

    const rawMime = (blob.type || '').toLowerCase().trim();
    const uriExt = cleanUri.split('?')[0].split('.').pop()?.toLowerCase() || '';
    let contentType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    if (!contentType || contentType === 'application/octet-stream') {
      contentType = EXTENSION_TO_MIME[uriExt] || 'image/jpeg';
    }
    const ext = ALLOWED_IMAGE_MIME_TYPES[contentType];
    if (!ext) {
      throw new Error('Formato de imagen no permitido. Usa JPG, PNG, WebP, GIF o AVIF.');
    }

    const safePrefix = productId ? `${productId.replace(/[^a-zA-Z0-9_-]/g, '')}-` : '';
    const fileName = `${safePrefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    // Debe mantener un solo segmento tras accountId para cumplir storage.rules (`match /products/{accountId}/{file}`).
    const storagePath = `products/${accountId}/${fileName}`;
    const { getStorage, ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
    const storage = app ? getStorage(app) : getStorage();
    const storageRef = ref(storage, storagePath);

    const snapshot = await uploadBytes(storageRef, blob, { contentType });
    return await getDownloadURL(snapshot.ref);
  } finally {
    if (typeof (blob as any)?.close === 'function') {
      try {
        (blob as any).close();
      } catch {
        // Ignorar en entornos sin Blob.close()
      }
    }
  }
};

// ============================================================================
// SERVICIOS DE INVENTARIO
// ============================================================================

/**
 * Crea o actualiza un producto en el catálogo `products` y registra
 * los movimientos iniciales en el Kardex si es un producto nuevo con stock.
 */
export const saveProduct = async (
  productData: Partial<Product> & {
    id?: string;
    accountId: string;
    name: string;
    sku?: string;
    branchId?: string;
    branchIds?: string[];
    costPrice?: number;
    minSalePrice?: number;
    suggestedPrice?: number;
    minStock?: number;
    stock?: Record<string, number>;
    reservedStock?: Record<string, number>;
    presentations?: any[];
    variants?: any[];
    priceTiers?: PriceTier[];
    branchPrices?: Record<string, BranchPriceConfig>;
    attributes?: Array<{ name: string; value: string }>;
    galleryImages?: string[];
    allowDecimals?: boolean;
    unitOfMeasure?: string;
    taxExemptionCode?: '10' | '20' | '30' | string;
    category?: string;
    imageUrl?: string;
    thumbUrl?: string;
    barcode?: string;
    barcodes?: string[];
  },
  isNew: boolean,
  userProfile: UserProfileInfo
): Promise<string> => {
  if (!productData.name || productData.name.trim().length === 0) {
    throw new Error('El nombre del producto es obligatorio.');
  }

  if (!productData.accountId) {
    throw new Error('El identificador de cuenta (accountId) es obligatorio.');
  }

  if (isLocalFileUri(productData.imageUrl) || isLocalFileUri(productData.thumbUrl)) {
    throw new Error('La imagen principal debe subirse a Firebase Storage antes de guardar.');
  }
  if (Array.isArray(productData.galleryImages) && productData.galleryImages.some((u) => isLocalFileUri(u))) {
    throw new Error('Todas las imágenes de la galería deben subirse a Firebase Storage antes de guardar.');
  }
  if (
    Array.isArray(productData.variants) &&
    productData.variants.some((v) => Array.isArray(v?.images) && v.images.some((u: string) => isLocalFileUri(u)))
  ) {
    throw new Error('Las imágenes de variantes deben subirse a Firebase Storage antes de guardar.');
  }

  const creating = isNew || !productData.id;
  const existingRef = !creating && productData.id
    ? doc(db, PRODUCTS_COLLECTION, productData.id)
    : null;
  const existingSnapshot = existingRef ? await getDoc(existingRef) : null;
  const existingData = existingSnapshot?.exists() ? existingSnapshot.data() : {};
  if (existingRef && !existingSnapshot?.exists()) {
    throw new Error(`El producto "${productData.id}" no existe.`);
  }

  const stockMap: Record<string, number> = productData.stock ?? existingData.stock ?? {};
  const reservedMap: Record<string, number> = productData.reservedStock ?? existingData.reservedStock ?? {};
  const fallbackBranchIds = (productData.branchIds && productData.branchIds.length > 0)
    ? productData.branchIds
    : (productData.branchId ? [productData.branchId] : (existingData.branchIds || []));
  const branchIds = deriveBranchIds(stockMap, fallbackBranchIds);
  const minStock = productData.minStock ?? existingData.minStock ?? LOW_STOCK_THRESHOLD;

  const lowStockBranches = calculateLowStockBranches(stockMap, reservedMap, minStock);

  const payload: any = {
    ...productData,
    name: productData.name.trim(),
    sku: productData.sku ? productData.sku.trim() : (existingData.sku || `SKU-${Date.now().toString().slice(-6)}`),
    stock: stockMap,
    branchIds,
    lowStockBranches,
    minStock,
    updatedAt: serverTimestamp(),
  };

  if (creating || productData.costPrice !== undefined) {
    payload.costPrice = typeof productData.costPrice === 'number' ? roundToCents(productData.costPrice) : 0;
  }
  if (creating || productData.minSalePrice !== undefined) {
    payload.minSalePrice = typeof productData.minSalePrice === 'number' ? roundToCents(productData.minSalePrice) : 0;
  }
  if (creating || productData.suggestedPrice !== undefined) {
    const sp = typeof productData.suggestedPrice === 'number' ? roundToCents(productData.suggestedPrice) : 0;
    payload.suggestedPrice = sp;
    payload.price = sp;
  }
  if (creating || productData.unitOfMeasure !== undefined) {
    payload.unitOfMeasure = productData.unitOfMeasure || 'unit';
  }
  if (creating || productData.category !== undefined) {
    payload.category = productData.category || 'General';
  }
  if (creating || productData.imageUrl !== undefined) {
    payload.imageUrl = productData.imageUrl || '';
  }
  if (creating || productData.barcode !== undefined) {
    payload.barcode = productData.barcode || '';
  }
  if (creating || productData.barcodes !== undefined) {
    payload.barcodes = Array.isArray(productData.barcodes) ? productData.barcodes : [];
  }
  if (creating || productData.presentations !== undefined) {
    payload.presentations = Array.isArray(productData.presentations)
      ? productData.presentations.map(normalizePresentationBidirectional)
      : [];
  }
  if (productData.priceTiers !== undefined) {
    payload.priceTiers = normalizePriceTiers(productData.priceTiers);
  }
  if (productData.galleryImages !== undefined) {
    payload.galleryImages = sanitizeRemoteImageUrls(productData.galleryImages);
  }
  if (productData.attributes !== undefined) {
    payload.attributes = Array.isArray(productData.attributes)
      ? productData.attributes
          .map((a) => ({ name: (a.name || '').trim(), value: (a.value || '').trim() }))
          .filter((a) => a.name.length > 0 && a.value.length > 0)
      : [];
  }

  // Edición es parcial: la ausencia de un campo significa “no fue editado”.
  // En particular, reservas solo cambian por operaciones de inventario y no
  // deben desaparecer al guardar el formulario general del producto.
  if (creating) {
    payload.reservedStock = reservedMap;
    payload.variants = Array.isArray(productData.variants) ? productData.variants : [];
    payload.allowDecimals = Boolean(productData.allowDecimals);
  } else {
    if (productData.reservedStock !== undefined) payload.reservedStock = productData.reservedStock;
    if (productData.variants !== undefined) payload.variants = productData.variants;
    if (productData.allowDecimals !== undefined) payload.allowDecimals = productData.allowDecimals;
  }

  // Limpiar campos undefined
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  const productsColl = collection(db, PRODUCTS_COLLECTION);
  let productId = productData.id;

  if (isNew || !productId) {
    const newDocRef = doc(productsColl);
    productId = newDocRef.id;
    payload.id = productId;
    payload.createdAt = serverTimestamp();

    await setDoc(newDocRef, cleanFirestoreData(payload));

    // Si tiene stock inicial en alguna sucursal, registrar movimientos en inventory_movements usando writeBatch
    const initialMovements = Object.entries(stockMap).filter(([_, qty]) => typeof qty === 'number' && qty > 0);
    if (initialMovements.length > 0) {
      try {
        const buildInitialMovement = (branchId: string, qty: number) =>
          cleanFirestoreData({
            accountId: productData.accountId,
            branchId,
            productId,
            productName: payload.name,
            productSku: payload.sku,
            // Campos canónicos Web
            movementType: 'add',
            quantityBefore: 0,
            quantityAfter: qty,
            quantityChanged: qty,
            userId: userProfile.uid,
            userName: userProfile.displayName || userProfile.email || 'Usuario',
            userRole: (userProfile as any)?.role || 'user',
            // Campos alias Mobile
            type: 'in',
            previousStock: 0,
            newStock: qty,
            quantity: qty,
            reason: 'initial_stock',
            notes: 'Inventario inicial al crear producto',
            createdAt: serverTimestamp(),
            date: Date.now(),
          });

        let writeBatchFn: ((firestore: typeof db) => any) | null = null;
        try {
          const firestoreMod = await import('firebase/firestore');
          if (typeof firestoreMod.writeBatch === 'function') {
            writeBatchFn = firestoreMod.writeBatch;
          }
        } catch {
          writeBatchFn = null;
        }
        if (writeBatchFn) {
          const batch = writeBatchFn(db);
          for (const [branchId, qty] of initialMovements) {
            const mvRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
            batch.set(mvRef, buildInitialMovement(branchId, qty));
          }
          await batch.commit();
        } else {
          await Promise.all(
            initialMovements.map(async ([branchId, qty]) => {
              const mvRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
              await setDoc(mvRef, buildInitialMovement(branchId, qty));
            })
          );
        }
      } catch (err) {
        console.warn(`[InventoryService] Error registrando Kardex inicial para ${productId}:`, err);
      }
    }
  } else {
    await updateDoc(existingRef!, cleanFirestoreData(payload));
  }

  sharedRequestCache.invalidatePrefix(`barcode_remote:${productData.accountId}:`);
  return productId;
};

/**
 * Resuelve códigos contra el catálogo completo de una cuenta. El catálogo
 * visual puede estar paginado/cargado parcialmente, pero el POS necesita una
 * respuesta de barcode que no dependa del límite de productos en memoria.
 */
export const findByBarcodeRemote = async (
  accountId: string,
  code: string
): Promise<ScannedProductMatch | null> => {
  if (!accountId || !code?.trim()) return null;
  const cleanCode = code.trim();
  const cacheKey = `barcode_remote:${accountId}:${cleanCode}`;

  return sharedRequestCache.getOrLoad<ScannedProductMatch | null>(
    cacheKey,
    30_000,
    async () => {
      const productsColl = collection(db, PRODUCTS_COLLECTION);

      // Consultar barcode, SKU y barcodes alternativos en paralelo manteniendo precedencia
      const [barcodeSnap, skuSnap, barcodesSnap] = await Promise.all([
        getDocs(
          query(
            productsColl,
            where('accountId', '==', accountId),
            where('barcode', '==', cleanCode),
            firestoreLimit(1)
          )
        ),
        getDocs(
          query(
            productsColl,
            where('accountId', '==', accountId),
            where('sku', '==', cleanCode),
            firestoreLimit(1)
          )
        ),
        getDocs(
          query(
            productsColl,
            where('accountId', '==', accountId),
            where('barcodes', 'array-contains', cleanCode),
            firestoreLimit(1)
          )
        ),
      ]);

      for (const snap of [barcodeSnap, skuSnap, barcodesSnap]) {
        if (snap.docs?.length) {
          const products = snap.docs.map((productDoc) => ({
            id: productDoc.id,
            ...productDoc.data(),
          })) as Product[];
          const match = findProductByBarcode(products, cleanCode);
          if (match) return match;
        }
      }

      return null;
    }
  );
};


/**
 * Realiza un ajuste de stock atómico en una sucursal dada,
 * recalculando lowStockBranches e insertando el registro auditado en `inventory_movements`.
 * En products actualiza únicamente stock, branchIds y lowStockBranches (SIN updatedAt)
 * para cumplir con la regla de cajeros en firestore.rules línea 514.
 */
export const adjustProductStock = async (
  params: AdjustStockParams
): Promise<AdjustStockResult> => {
  const { product, branchId, branchName, newStock, variantId, variantName, reason, notes, userProfile } = params;

  if (!product.id || !branchId) {
    throw new Error('Parámetros de producto y sucursal requeridos para ajuste de stock.');
  }

  if (typeof newStock !== 'number' || newStock < 0 || isNaN(newStock)) {
    throw new Error('El nuevo stock debe ser un número mayor o igual a cero.');
  }

  const productRef = doc(db, PRODUCTS_COLLECTION, product.id);
  const normalizedNewStock = Math.round(newStock * 10000) / 10000;

  let resultSnapshot: AdjustStockResult = {
    previousStock: 0,
    newStock: normalizedNewStock,
    diff: 0,
    before: {},
    after: {},
    variantId,
  };

  await runTransaction(db, async (tx) => {
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) {
      throw new Error(`El producto con ID ${product.id} no existe.`);
    }

    const pData = productSnap.data();
    const beforeStockSnapshot: Record<string, number> = { ...(pData.stock || {}) };
    const currentStockMap: Record<string, number> = { ...beforeStockSnapshot };

    let previousQty = Number(currentStockMap[branchId]) || 0;
    let diff = Math.round((normalizedNewStock - previousQty) * 10000) / 10000;
    let updatedVariants: any[] | undefined;

    if (variantId) {
      const variantsList = Array.isArray(pData.variants) ? pData.variants : [];
      const targetVariant = variantsList.find((v: any) => v.id === variantId);
      if (!targetVariant) {
        throw new Error(`La variante "${variantName || variantId}" no existe en el producto.`);
      }

      previousQty = getVariantBranchStock(targetVariant, branchId);
      diff = Math.round((normalizedNewStock - previousQty) * 10000) / 10000;

      if (diff === 0) {
        resultSnapshot = {
          previousStock: previousQty,
          newStock: normalizedNewStock,
          diff: 0,
          before: beforeStockSnapshot,
          after: beforeStockSnapshot,
          variantId,
        };
        return;
      }

      updatedVariants = variantsList.map((v: any) => {
        if (v.id !== variantId) return v;
        if (typeof v.stock === 'object' && v.stock !== null) {
          return {
            ...v,
            stock: {
              ...v.stock,
              [branchId]: normalizedNewStock,
            },
          };
        }
        return {
          ...v,
          stock: { [branchId]: normalizedNewStock },
        };
      });

      const aggregatedBranchStock = updatedVariants.reduce(
        (sum: number, v: any) => sum + getVariantBranchStock(v, branchId),
        0
      );
      currentStockMap[branchId] = Math.round(aggregatedBranchStock * 10000) / 10000;
    } else {
      if (diff === 0) {
        resultSnapshot = {
          previousStock: previousQty,
          newStock: normalizedNewStock,
          diff: 0,
          before: beforeStockSnapshot,
          after: beforeStockSnapshot,
        };
        return;
      }
      currentStockMap[branchId] = normalizedNewStock;
    }

    const lowStockBranches = calculateLowStockBranches(
      currentStockMap,
      pData.reservedStock || {},
      pData.minStock ?? product.minStock ?? LOW_STOCK_THRESHOLD
    );
    const branchIds = deriveBranchIds(currentStockMap, pData.branchIds || [branchId]);

    // 1. Actualizar producto únicamente en campos permitidos para cajeros SIN updatedAt
    const productUpdate: Record<string, any> = {
      stock: currentStockMap,
      branchIds,
      lowStockBranches,
    };
    if (updatedVariants !== undefined) {
      productUpdate.variants = updatedVariants;
    }
    tx.update(productRef, productUpdate);

    // 2. Registrar movimiento en Kardex con campos Web canónicos y alias Mobile
    const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
    tx.set(movementRef, cleanFirestoreData({
      accountId: product.accountId || pData.accountId,
      branchId,
      branchName: branchName || '',
      productId: product.id,
      productName: product.name || pData.name,
      productSku: product.sku || pData.sku || '',
      ...(variantId ? { variantId, variantName: variantName || '' } : {}),
      // Campos canónicos Web
      movementType: diff > 0 ? 'add' : 'edit',
      quantityBefore: previousQty,
      quantityAfter: normalizedNewStock,
      quantityChanged: diff,
      userId: userProfile.uid,
      userName: userProfile.displayName || userProfile.email || 'Usuario',
      userRole: (userProfile as any)?.role || 'user',
      // Campos alias Mobile
      type: diff > 0 ? 'in' : 'out',
      previousStock: previousQty,
      newStock: normalizedNewStock,
      quantity: Math.abs(diff),
      reason: reason || 'adjustment',
      notes: notes || '',
      createdAt: serverTimestamp(),
      date: Date.now(),
    }));

    resultSnapshot = {
      previousStock: previousQty,
      newStock: normalizedNewStock,
      diff,
      before: beforeStockSnapshot,
      after: { ...currentStockMap },
      variantId,
    };
  });

  // Registro de auditoría en inventory_adjustments (solo admins por firestore.rules)
  if (resultSnapshot.diff !== 0 && ((userProfile as any)?.role === 'owner' || (userProfile as any)?.role === 'admin')) {
    try {
      const adjRef = doc(collection(db, INVENTORY_ADJUSTMENTS_COLLECTION));
      await setDoc(adjRef, cleanFirestoreData({
        accountId: product.accountId,
        productId: product.id,
        productName: product.name,
        ...(variantId ? { variantId, variantName: variantName || '' } : {}),
        before: resultSnapshot.before,
        after: resultSnapshot.after,
        mode: resultSnapshot.diff > 0 ? 'add' : 'edit',
        reason: reason || 'adjustment',
        notes: notes || '',
        changedAt: Date.now(),
        user: {
          uid: userProfile.uid,
          name: userProfile.displayName || userProfile.email || 'Usuario',
          role: (userProfile as any)?.role || 'admin',
        },
      }));
    } catch (auditErr) {
      console.warn('[InventoryService] No se pudo registrar inventory_adjustments:', auditErr);
    }
  }

  return resultSnapshot;
};

/**
 * Consulta los movimientos del Kardex oficial en `inventory_movements`
 * normalizando automáticamente campos bidireccionales Web y Mobile.
 * Usa las combinaciones cubiertas por los índices compuestos de firestore.indexes.json:
 * - (accountId, branchId, productId, createdAt DESC)
 * - (accountId, branchId, createdAt DESC)
 * - (accountId, productId, createdAt DESC)
 * - (accountId, createdAt DESC)
 */
const missingInventoryIndexes = new Set<string>();

const isMissingInventoryIndexError = (err: any): boolean => {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'failed-precondition' ||
    msg.includes('requires an index') ||
    msg.includes('failed-precondition')
  );
};

export const getProductKardex = async (
  accountId: string,
  branchId: string,
  productId?: string,
  limitCount: number = 50
): Promise<any[]> => {
  const coll = collection(db, INVENTORY_MOVEMENTS_COLLECTION);
  const constraints: any[] = [where('accountId', '==', accountId)];
  if (branchId && branchId !== 'all') {
    constraints.push(where('branchId', '==', branchId));
  }
  if (productId) {
    constraints.push(where('productId', '==', productId));
  }

  const indexKey = `kardex:${branchId && branchId !== 'all' ? 'b' : 'all'}:${productId ? 'p' : 'all'}`;

  const runFallback = async (): Promise<any[]> => {
    const fallbackQuery = query(coll, ...constraints, firestoreLimit(limitCount));
    const snap = await getDocs(fallbackQuery);
    const items = snap.docs.map((d) => normalizeInventoryMovement(d.data(), d.id));

    items.sort((a: any, b: any) => {
      const tA = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Number(a.createdAt) || a.date || 0;
      const tB = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Number(b.createdAt) || b.date || 0;
      return tB - tA;
    });

    return items;
  };

  try {
    if (missingInventoryIndexes.has(indexKey)) {
      return await runFallback();
    }
    const q = query(
      coll,
      ...constraints,
      orderBy('createdAt', 'desc'),
      firestoreLimit(limitCount)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => normalizeInventoryMovement(d.data(), d.id));
  } catch (err: any) {
    if (isMissingInventoryIndexError(err)) {
      missingInventoryIndexes.add(indexKey);
    }
    console.warn('[InventoryService] Error consultando Kardex (posible índice requerido):', err?.message);
    try {
      return await runFallback();
    } catch (fallbackErr) {
      console.error('[InventoryService] Fallback de Kardex falló:', fallbackErr);
      return [];
    }
  }
};

// ============================================================================
// CIRCUITO DE TRANSFERENCIAS DE MERCADERÍA ENTRE SUCURSALES
// ============================================================================

/**
 * Crea una orden de transferencia de mercadería entre sucursales (`transfers`),
 * reservando el stock en la sucursal de origen (`reservedStock.${fromBranchId}`)
 * con estado inicial 'pending' para estricta paridad con firestore.rules líneas 890-902.
 */
export const createStockTransfer = async (
  params: CreateTransferParams
): Promise<string> => {
  const {
    accountId,
    fromBranchId,
    fromBranchName,
    toBranchId,
    toBranchName,
    items,
    notes,
    userProfile,
  } = params;

  const srcBranchId = params.sourceBranchId || fromBranchId;
  const dstBranchId = params.destinationBranchId || toBranchId;
  const srcBranchName = params.sourceBranchName || fromBranchName || srcBranchId;
  const dstBranchName = params.destinationBranchName || toBranchName || dstBranchId;

  if (!accountId || !srcBranchId || !dstBranchId) {
    throw new Error('Sucursal de origen, sucursal de destino y cuenta son obligatorias.');
  }

  if (srcBranchId === dstBranchId) {
    throw new Error('La sucursal de origen y destino no pueden ser la misma.');
  }

  if (!items || items.length === 0) {
    throw new Error('La transferencia debe incluir al menos un ítem.');
  }

  const transferDocRef = doc(collection(db, TRANSFERS_COLLECTION));
  const transferId = transferDocRef.id;
  const aggregatedLines = aggregateTransferItems(items);
  const productTotals = aggregateTransferQuantitiesByProduct(aggregatedLines);
  const uniqueProductIds = Array.from(productTotals.keys());

  await runTransaction(db, async (tx) => {
    // Firestore requiere completar todas las lecturas antes de la primera escritura.
    for (const line of aggregatedLines) {
      if (line.quantity <= 0) {
        throw new Error(`La cantidad a transferir de "${line.productName}" debe ser mayor a cero.`);
      }
    }

    const productReads = new Map<string, { ref: ReturnType<typeof doc>; snap: Awaited<ReturnType<typeof tx.get>> }>(
      await Promise.all(
        uniqueProductIds.map(async (productId) => {
          const pRef = doc(db, PRODUCTS_COLLECTION, productId);
          const pSnap = await tx.get(pRef);
          return [productId, { ref: pRef, snap: pSnap }] as const;
        })
      )
    );

    // Validar stock por variante cuando se transfieren variantes específicas
    for (const line of aggregatedLines) {
      const read = productReads.get(line.productId);
      if (!read?.snap.exists()) {
        throw new Error(`El producto "${line.productName}" no fue encontrado.`);
      }
      if (line.variantId) {
        const pData = read.snap.data() as Record<string, any>;
        const variants = Array.isArray(pData.variants) ? pData.variants : [];
        const variant = variants.find((v: any) => v.id === line.variantId);
        if (!variant) {
          throw new Error(`La variante "${line.variantName || line.variantId}" de "${line.productName}" no fue encontrada.`);
        }
        const varStock = getVariantBranchStock(variant, srcBranchId);
        if (varStock < line.quantity) {
          throw new Error(
            `Stock insuficiente en variante "${variant.name || line.variantName}" de "${line.productName}". Disponible: ${varStock}, Requerido: ${line.quantity}.`
          );
        }
      }
    }

    // 1. Validar y reservar stock total por producto en sucursal origen
    for (const [productId, totalQty] of productTotals.entries()) {
      const read = productReads.get(productId)!;
      const pRef = read.ref;
      const pData = read.snap.data() as Record<string, any>;
      const firstLine = aggregatedLines.find((l) => l.productId === productId);
      const productLabel = firstLine?.productName || pData.name || productId;

      const currentStockMap = { ...(pData.stock || {}) };
      const currentReservedMap = { ...(pData.reservedStock || {}) };

      const currentOriginStock = Number(currentStockMap[srcBranchId]) || 0;
      const currentOriginReserved = Number(currentReservedMap[srcBranchId]) || 0;
      const availableOrigin = currentOriginStock - currentOriginReserved;

      if (availableOrigin < totalQty) {
        throw new Error(
          `Stock insuficiente en sucursal origen para "${productLabel}". Disponible: ${availableOrigin}, Requerido: ${totalQty}.`
        );
      }

      const newReservedOrigin = Math.round((currentOriginReserved + totalQty) * 10000) / 10000;
      currentReservedMap[srcBranchId] = newReservedOrigin;

      const lowStockBranches = calculateLowStockBranches(
        currentStockMap,
        currentReservedMap,
        pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
      );

      // Actualizar reservedStock en producto sin updatedAt (cumple firestore.rules para cajeros)
      tx.update(pRef, {
        reservedStock: currentReservedMap,
        lowStockBranches,
      });
    }

    // 2. Guardar documento de transferencia con estado 'pending' (requerido por firestore.rules líneas 898-901)
    const transferPayload: any = {
      id: transferId,
      accountId,
      sourceBranchId: srcBranchId,
      sourceBranchName: srcBranchName,
      destinationBranchId: dstBranchId,
      destinationBranchName: dstBranchName,
      fromBranchId: srcBranchId,
      fromBranchName: srcBranchName,
      toBranchId: dstBranchId,
      toBranchName: dstBranchName,
      items: aggregatedLines.map((it) => ({
        productId: it.productId,
        productName: it.productName,
        sku: it.sku || '',
        quantity: it.quantity,
        ...(it.variantId ? { variantId: it.variantId, variantName: it.variantName || '' } : {}),
      })),
      products: aggregatedLines.map((it) => ({
        productId: it.productId,
        name: it.productName,
        productName: it.productName,
        sku: it.sku || '',
        quantity: it.quantity,
        ...(it.variantId ? { variantId: it.variantId, variantName: it.variantName || '' } : {}),
      })),
      status: 'pending',
      requestedBy: userProfile.uid,
      requestedByName: userProfile.displayName || userProfile.email || 'Usuario',
      requestedAt: serverTimestamp(),
      notes: notes || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    tx.set(transferDocRef, cleanFirestoreData(transferPayload));
  });

  sharedRequestCache.invalidatePrefix(`stock_transfers:${accountId}:`);
  return transferId;
};

/**
 * Aprueba una transferencia pendiente (`pending` -> `approved`)
 */
export const approveStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) throw new Error('ID de transferencia requerido.');

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(transferRef);
    if (!snap.exists()) throw new Error(`La transferencia "${transferId}" no existe.`);
    const data = snap.data();
    if (data.status !== 'pending') {
      throw new Error(`Solo se pueden aprobar transferencias pendientes (estado actual: ${data.status}).`);
    }
    tx.update(transferRef, {
      status: 'approved',
      approvedBy: userProfile.uid,
      approvedByName: userProfile.displayName || userProfile.email || 'Usuario',
      approvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  sharedRequestCache.invalidatePrefix('stock_transfers:');
};

/** Marca el despacho físico de una transferencia aprobada. */
export const sendStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) throw new Error('ID de transferencia requerido.');
  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(transferRef);
    if (!snap.exists()) throw new Error(`La transferencia "${transferId}" no existe.`);
    if (snap.data().status !== 'approved') throw new Error('Solo se pueden enviar transferencias aprobadas.');
    tx.update(transferRef, {
      status: 'in_transit', sentBy: userProfile.uid,
      sentByName: userProfile.displayName || userProfile.email || 'Usuario',
      sentAt: serverTimestamp(), shippedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  });
  sharedRequestCache.invalidatePrefix('stock_transfers:');
};

/**
 * Emite la Guía de Remisión Electrónica (09) de una transferencia en tránsito
 * a través del endpoint del servidor (`/api/invoicing/despatch`).
 */
export const emitTransferDespatchGuide = async (
  accountId: string,
  transferId: string
): Promise<{ success: boolean; einvoice?: { id?: string; documentNumber?: string; status?: string } | null }> => {
  if (!accountId || !transferId) {
    throw new Error('accountId y transferId son obligatorios para emitir la Guía de Remisión.');
  }
  return apiRequest<{ success: boolean; einvoice?: { id?: string; documentNumber?: string; status?: string } | null }>(
    '/api/invoicing/despatch',
    {
      method: 'POST',
      body: { accountId, transferId },
    }
  );
};

/**
 * Cancela una transferencia pendiente o aprobada y libera el stock reservado en la sucursal de origen.
 */
export const cancelStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo,
  reason: string = 'Transferencia cancelada',
  finalStatus: 'cancelled' | 'rejected' = 'cancelled'
): Promise<void> => {
  if (!transferId) throw new Error('ID de transferencia requerido.');

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);

  await runTransaction(db, async (tx) => {
    const tSnap = await tx.get(transferRef);
    if (!tSnap.exists()) {
      throw new Error(`La transferencia "${transferId}" no existe.`);
    }

    const tData = tSnap.data();
    if (tData.status === 'completed' || tData.status === 'in_transit') {
      throw new Error('No se puede cancelar una transferencia completada o en tránsito.');
    }
    if (tData.status === 'cancelled' || tData.status === 'rejected') {
      return;
    }
    if (finalStatus === 'rejected' && tData.status !== 'pending') {
      throw new Error('Solo se pueden rechazar transferencias pendientes.');
    }
    if (finalStatus === 'cancelled' && !['pending', 'approved'].includes(tData.status)) {
      throw new Error(`No se puede cancelar una transferencia en estado ${tData.status}.`);
    }

    const srcBranchId = tData.sourceBranchId || tData.fromBranchId;
    if (!srcBranchId) throw new Error('La transferencia no tiene una sucursal de origen válida.');
    const productTotals = aggregateTransferQuantitiesByProduct(tData.products || tData.items || []);

    // Leer productos en paralelo antes de liberar reservas para respetar el protocolo de Firestore.
    const productReads = await Promise.all(
      Array.from(productTotals.entries()).map(async ([productId, qty]) => {
        const pRef = doc(db, PRODUCTS_COLLECTION, productId);
        const pSnap = await tx.get(pRef);
        return { productId, qty, ref: pRef, snap: pSnap };
      })
    );

    // Liberar reserva de stock en origen
    for (const { qty, ref: pRef, snap: pSnap } of productReads) {
      if (pSnap.exists()) {
        const pData = pSnap.data() as Record<string, any>;
        const currentReservedMap = { ...(pData.reservedStock || {}) };
        const currentSrcReserved = Number(currentReservedMap[srcBranchId]) || 0;
        const newReserved = Math.max(0, currentSrcReserved - qty);
        if (newReserved > 0) {
          currentReservedMap[srcBranchId] = newReserved;
        } else {
          delete currentReservedMap[srcBranchId];
        }

        const lowStockBranches = calculateLowStockBranches(
          pData.stock || {},
          currentReservedMap,
          pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
        );

        tx.update(pRef, {
          reservedStock: currentReservedMap,
          lowStockBranches,
        });
      }
    }

    tx.update(transferRef, {
      status: finalStatus,
      rejectionReason: reason,
      cancelledBy: userProfile.uid,
      cancelledByName: userProfile.displayName || userProfile.email || 'Usuario',
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  sharedRequestCache.invalidatePrefix('stock_transfers:');
};

export const rejectStockTransfer = (
  transferId: string,
  userProfile: UserProfileInfo,
  reason = 'Transferencia rechazada'
): Promise<void> => cancelStockTransfer(transferId, userProfile, reason, 'rejected');

/**
 * Completa la recepción de una transferencia en la sucursal de destino.
 * Cumple con el flujo de firestore.rules (pending -> approved -> completed):
 * Acredita el stock físico en destino (y en variantes si aplica),
 * descuenta y libera el reservado en origen, y genera ambos registros
 * de Kardex oficial (`movementType: 'transfer'`).
 */
export const completeStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) {
    throw new Error('Identificador de transferencia requerido.');
  }

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);

  await runTransaction(db, async (tx) => {
    const tSnap = await tx.get(transferRef);
    if (!tSnap.exists()) {
      throw new Error(`La transferencia "${transferId}" no existe.`);
    }

    const tData = tSnap.data();
    if (tData.status === 'completed') {
      throw new Error('La transferencia ya ha sido completada.');
    }

    if (tData.status === 'pending') {
      throw new Error('La transferencia debe aprobarse antes de recibirla.');
    }

    if (tData.status !== 'approved' && tData.status !== 'in_transit') {
      throw new Error(`La transferencia se encuentra en estado "${tData.status}" y no puede ser completada.`);
    }

    const accountId = tData.accountId;
    const srcBranchId = tData.sourceBranchId || tData.fromBranchId;
    const dstBranchId = tData.destinationBranchId || tData.toBranchId;
    if (!srcBranchId || !dstBranchId || srcBranchId === dstBranchId) {
      throw new Error('La transferencia no tiene sucursales de origen y destino válidas.');
    }
    const srcBranchName = tData.sourceBranchName || tData.fromBranchName || srcBranchId;
    const dstBranchName = tData.destinationBranchName || tData.toBranchName || dstBranchId;

    const rawItems = aggregateTransferItems(tData.products || tData.items || []);
    if (rawItems.length === 0) {
      throw new Error('La transferencia no contiene productos para ingresar a stock.');
    }

    const transferItems = rawItems.map((item: any) => ({
      productId: item.productId,
      productName: item.productName || item.name || 'Producto',
      sku: item.sku || '',
      quantity: Number(item.quantity) || 0,
      variantId: item.variantId,
      variantName: item.variantName,
    }));

    // Agrupar líneas por productId para leer/actualizar cada producto exactamente una vez
    const linesByProduct = new Map<string, typeof transferItems>();
    for (const item of transferItems) {
      if (!item.productId) continue;
      const list = linesByProduct.get(item.productId) || [];
      list.push(item);
      linesByProduct.set(item.productId, list);
    }

    // FASE 1: LECTURAS (todos los gets en paralelo antes de updates)
    const productReads = await Promise.all(
      Array.from(linesByProduct.entries()).map(async ([productId, lines]) => {
        const pRef = doc(db, PRODUCTS_COLLECTION, productId);
        const pSnap = await tx.get(pRef);
        return { productId, ref: pRef, snap: pSnap, lines };
      })
    );

    // FASE 2: ESCRITURAS
    const effectiveTransferNumber = tData.transferNumber || `TRF-${transferId.slice(-4).toUpperCase()}`;

    for (const { productId, ref: pRef, snap: pSnap, lines } of productReads) {
      if (!pSnap.exists()) {
        throw new Error(`El producto "${lines[0]?.productName || productId}" no fue encontrado.`);
      }

      const pData = pSnap.data() as Record<string, any>;
      const currentStockMap = { ...(pData.stock || {}) };
      const currentReservedMap = { ...(pData.reservedStock || {}) };

      const totalProductQty = lines.reduce((sum, l) => sum + l.quantity, 0);
      const currentSrcStock = Number(currentStockMap[srcBranchId]) || 0;
      const currentDstStock = Number(currentStockMap[dstBranchId]) || 0;
      const currentSrcReserved = Number(currentReservedMap[srcBranchId]) || 0;

      if (currentSrcStock < totalProductQty || currentSrcReserved < totalProductQty) {
        throw new Error('La reserva del producto ya no está disponible para recibir la transferencia.');
      }

      // 1. Restar stock físico en origen
      const newSrcStock = Math.max(0, Math.round((currentSrcStock - totalProductQty) * 10000) / 10000);
      currentStockMap[srcBranchId] = newSrcStock;

      // 2. Liberar stock reservado en origen
      const newSrcReserved = Math.max(0, Math.round((currentSrcReserved - totalProductQty) * 10000) / 10000);
      if (newSrcReserved > 0) {
        currentReservedMap[srcBranchId] = newSrcReserved;
      } else {
        delete currentReservedMap[srcBranchId];
      }

      // 3. Sumar stock físico en destino
      const newDstStock = Math.round((currentDstStock + totalProductQty) * 10000) / 10000;
      currentStockMap[dstBranchId] = newDstStock;

      // 4. Actualizar stock de variantes si las líneas incluyen variantId
      let updatedVariants: any[] | undefined;
      const variantLines = lines.filter((l) => Boolean(l.variantId));
      if (variantLines.length > 0 && Array.isArray(pData.variants)) {
        const qtyByVariant = new Map<string, number>();
        for (const vl of variantLines) {
          qtyByVariant.set(vl.variantId!, (qtyByVariant.get(vl.variantId!) || 0) + vl.quantity);
        }
        updatedVariants = pData.variants.map((variant: any) => {
          const vQty = qtyByVariant.get(variant.id) || 0;
          if (!vQty) return variant;
          const vSrcBefore = getVariantBranchStock(variant, srcBranchId);
          if (vSrcBefore < vQty) {
            throw new Error(
              `Stock insuficiente para la variante "${variant.name || variant.id}" en sucursal origen.`
            );
          }
          const vDstBefore = getVariantBranchStock(variant, dstBranchId);
          const baseStockObj =
            typeof variant.stock === 'object' && variant.stock !== null ? { ...variant.stock } : {};
          return {
            ...variant,
            stock: {
              ...baseStockObj,
              [srcBranchId]: Math.max(0, Math.round((vSrcBefore - vQty) * 10000) / 10000),
              [dstBranchId]: Math.round((vDstBefore + vQty) * 10000) / 10000,
            },
          };
        });
      }

      const lowStockBranches = calculateLowStockBranches(
        currentStockMap,
        currentReservedMap,
        pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
      );

      const branchIds = deriveBranchIds(currentStockMap, pData.branchIds || [srcBranchId, dstBranchId]);

      // 5. Actualizar producto SIN updatedAt (cumple firestore.rules para rol cajero)
      const productUpdate: Record<string, any> = {
        stock: currentStockMap,
        reservedStock: currentReservedMap,
        branchIds,
        lowStockBranches,
      };
      if (updatedVariants !== undefined) {
        productUpdate.variants = updatedVariants;
      }
      tx.update(pRef, productUpdate);

      // 6. Kardex salida en origen y entrada en destino por línea
      let runningSrc = currentSrcStock;
      let runningDst = currentDstStock;
      for (const line of lines) {
        const lineSrcAfter = Math.max(0, Math.round((runningSrc - line.quantity) * 10000) / 10000);
        const lineDstAfter = Math.round((runningDst + line.quantity) * 10000) / 10000;

        const mvOutRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        tx.set(mvOutRef, cleanFirestoreData({
          accountId,
          branchId: srcBranchId,
          branchName: srcBranchName,
          productId: line.productId,
          productName: line.productName,
          productSku: line.sku || pData.sku || '',
          ...(line.variantId ? { variantId: line.variantId, variantName: line.variantName || '' } : {}),
          movementType: 'transfer',
          quantityBefore: runningSrc,
          quantityAfter: lineSrcAfter,
          quantityChanged: -line.quantity,
          referenceNumber: effectiveTransferNumber,
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          userRole: (userProfile as any)?.role || 'user',
          type: 'out',
          previousStock: runningSrc,
          newStock: lineSrcAfter,
          quantity: line.quantity,
          reason: 'transfer_out',
          notes: `Transferencia #${transferId} hacia ${dstBranchName}`,
          createdAt: serverTimestamp(),
          date: Date.now(),
        }));

        const mvInRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        tx.set(mvInRef, cleanFirestoreData({
          accountId,
          branchId: dstBranchId,
          branchName: dstBranchName,
          productId: line.productId,
          productName: line.productName,
          productSku: line.sku || pData.sku || '',
          ...(line.variantId ? { variantId: line.variantId, variantName: line.variantName || '' } : {}),
          movementType: 'transfer',
          quantityBefore: runningDst,
          quantityAfter: lineDstAfter,
          quantityChanged: line.quantity,
          referenceNumber: effectiveTransferNumber,
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          userRole: (userProfile as any)?.role || 'user',
          type: 'in',
          previousStock: runningDst,
          newStock: lineDstAfter,
          quantity: line.quantity,
          reason: 'transfer_in',
          notes: `Recepción de transferencia #${transferId} desde ${srcBranchName}`,
          createdAt: serverTimestamp(),
          date: Date.now(),
        }));

        runningSrc = lineSrcAfter;
        runningDst = lineDstAfter;
      }
    }

    // 7. Marcar transferencia como 'completed'
    tx.update(transferRef, {
      status: 'completed',
      receivedBy: userProfile.uid,
      receivedByName: userProfile.displayName || userProfile.email || 'Usuario',
      receivedAt: serverTimestamp(),
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  sharedRequestCache.invalidatePrefix('stock_transfers:');
};

/**
 * Obtiene la lista de transferencias de inventario de la cuenta
 */
export const getStockTransfers = async (
  accountId: string,
  branchId?: string,
  status?: string,
  options?: { forceRefresh?: boolean }
): Promise<StockTransfer[]> => {
  if (!accountId) return [];
  const cacheKey = `stock_transfers:${accountId}:${branchId || 'all'}:${status || 'all'}`;
  try {
    return await sharedRequestCache.getOrLoad(
      cacheKey,
      45_000,
      async () => {
        const coll = collection(db, TRANSFERS_COLLECTION);
        const constraints: any[] = [where('accountId', '==', accountId)];

        if (status) {
          constraints.push(where('status', '==', status));
        }

        const indexKey = `transfers:${status ? 'status' : 'all'}`;
        let snapshot;
        if (missingInventoryIndexes.has(indexKey)) {
          snapshot = await getDocs(query(coll, ...constraints, firestoreLimit(100)));
        } else {
          try {
            const q = query(
              coll,
              ...constraints,
              orderBy('createdAt', 'desc'),
              firestoreLimit(100)
            );
            snapshot = await getDocs(q);
          } catch (err: any) {
            if (!isMissingInventoryIndexError(err)) throw err;
            missingInventoryIndexes.add(indexKey);
            console.warn('[InventoryService] Índice faltante en getStockTransfers, usando fallback sin orderBy:', err?.message || err);
            const fallbackQ = query(coll, ...constraints, firestoreLimit(100));
            snapshot = await getDocs(fallbackQ);
          }
        }

        let transfers: StockTransfer[] = snapshot.docs.map((d) => {
          const data = d.data();
          const srcId = data.sourceBranchId || data.fromBranchId || '';
          const destId = data.destinationBranchId || data.toBranchId || '';
          const srcName = data.sourceBranchName || data.fromBranchName || '';
          const destName = data.destinationBranchName || data.toBranchName || '';

          const rawItems: any[] = data.items || data.products || [];
          const normalizedItems: TransferItem[] = rawItems.map((it: any) => ({
            productId: it.productId,
            productName: it.productName || it.name || 'Producto',
            sku: it.sku || '',
            quantity: Number(it.quantity) || 0,
            ...(it.variantId ? { variantId: it.variantId, variantName: it.variantName || '' } : {}),
          }));

          const normalizedProducts = rawItems.map((it: any) => ({
            productId: it.productId,
            name: it.productName || it.name || 'Producto',
            productName: it.productName || it.name || 'Producto',
            sku: it.sku || '',
            quantity: Number(it.quantity) || 0,
            ...(it.variantId ? { variantId: it.variantId, variantName: it.variantName || '' } : {}),
          }));

          return {
            id: d.id,
            transferNumber: data.transferNumber || `TRF-${d.id.slice(-4).toUpperCase()}`,
            ...data,
            sourceBranchId: srcId,
            destinationBranchId: destId,
            fromBranchId: srcId,
            toBranchId: destId,
            sourceBranchName: srcName,
            destinationBranchName: destName,
            fromBranchName: srcName,
            toBranchName: destName,
            items: normalizedItems,
            products: normalizedProducts,
          } as StockTransfer;
        });

        if (branchId && branchId !== 'all') {
          transfers = transfers.filter(
            (t) =>
              t.sourceBranchId === branchId ||
              t.destinationBranchId === branchId ||
              t.fromBranchId === branchId ||
              t.toBranchId === branchId
          );
        }

        // Ordenar descendente por fecha
        transfers.sort((a, b) => {
          const getTimestamp = (obj: any) => {
            const t = obj?.requestedAt || obj?.sentAt || obj?.createdAt;
            if (!t) return 0;
            if (typeof t === 'object' && 'seconds' in t) return t.seconds * 1000;
            if (t instanceof Date) return t.getTime();
            return Number(t) || 0;
          };
          return getTimestamp(b) - getTimestamp(a);
        });

        return transfers;
      },
      { forceRefresh: options?.forceRefresh }
    );
  } catch (err) {
    console.error('[InventoryService] Error obteniendo transferencias:', err);
    return [];
  }
};

// ============================================================================
// EXPORT DEFAULT COMO SERVICIO UNIFICADO
// ============================================================================

export const InventoryKardexService = {
  saveProduct,
  uploadProductImageToStorage,
  findByBarcodeRemote,
  adjustProductStock,
  getProductKardex,
  createStockTransfer,
  approveStockTransfer,
  rejectStockTransfer,
  cancelStockTransfer,
  sendStockTransfer,
  emitTransferDespatchGuide,
  completeStockTransfer,
  getStockTransfers,
  calculateLowStockBranches,
  deriveLowStockBranches,
  deriveBranchIds,
  normalizeInventoryMovement,
  calculateWeightEntry,
  resolvePresentationVariantPrice,
  resolvePresentationVariantStock,
  mergeSingleBranchStock,
  normalizePriceTiers,
  serializeBranchPrices,
};

export default InventoryKardexService;
