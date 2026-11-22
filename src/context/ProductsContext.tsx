import { normalizePresentation } from '@/lib/presentation-parity';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import { AppState, InteractionManager } from 'react-native';
import {
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  limit,
  Timestamp,
} from 'firebase/firestore';
import NetInfo from '@react-native-community/netinfo';
import { catalogKVStorage } from '@/lib/native-kv-storage';
import { db } from '@/lib/firebase';
import { apiRequest } from '@/lib/api-client';
import { useAuthSession, useNetworkStatus, usePlanAccess } from './AuthContext';
import { Product } from '@/types';
import {
  findProductByBarcode,
  getBranchStock,
  getAvailableStock,
  normalizeCode,
  ScannedProductMatch,
} from '@/lib/product-search';
import {
  ProductCatalogIndex,
  ProductCatalogInventoryIndex,
  removeCatalogProduct,
  type CatalogInventoryAlert,
} from '@/lib/product-catalog-index';
import {
  MutableCatalogProductIndex,
  getIndexedCatalogProduct,
  type CatalogProductIndex,
} from '@/lib/catalog-filters';
import {
  PRODUCT_CATALOG_FIRST_BATCH_SIZE,
  isAuthoritativeCatalogSnapshot,
  processCatalogInBatches,
  processCatalogIteratorInBatches,
  productsForCatalogScope,
  shouldRetainCatalogProduct,
} from '@/lib/product-catalog-loader';
import {
  PRODUCT_CATALOG_CACHE_TTL_MS,
  getProductCatalogDeltaCount,
  getProductCatalogDeltaCountSync,
  loadProductCatalogCache,
  productCatalogCacheKey,
  readProductCatalogManifestSync,
  writeProductCatalogCache,
  writeProductCatalogDelta,
} from '@/lib/product-catalog-cache';
import {
  normalizePriceTiers,
  sanitizeRemoteImageUrls,
} from '@/lib/product-normalization';

export interface InventoryStats {
  totalProducts: number;
  skuCount: number;
  totalInventoryValue: number;
  valuation: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface ProductPlanLimitSummary {
  current: number;
  max: number;
  type: 'hard' | 'soft';
  isAtLimit: boolean;
  isNearLimit: boolean;
}

export interface ProductPlanValidationResult {
  allowed: boolean;
  reason?: string;
  current?: number;
  max?: number;
}

export interface ProductsActionsContextType {
  getProductById: (id: string) => Product | undefined;
  findByBarcode: (code: string) => ScannedProductMatch | null;
  findByBarcodeRemote: (code: string) => Promise<ScannedProductMatch | null>;
  getProductStock: (product: Product, branchIdOverride?: string) => number;
  getProductAvailableStock: (product: Product, branchIdOverride?: string) => number;
  refreshProducts: () => void;
  upsertProduct: (product: Product) => void;
  upsertProductsBatch: (items: Product[]) => void;
  validateProductCreation: () => Promise<ProductPlanValidationResult>;
}

export interface ProductsContextType extends ProductsActionsContextType {
  products: Product[];
  productsById: ReadonlyMap<string, Product>;
  catalogIndex: CatalogProductIndex;
  loading: boolean;
  refreshing: boolean;
  catalogComplete: boolean;
  error: string | null;
  categories: string[];
  stats: InventoryStats;
  criticalAlerts: CatalogInventoryAlert[];
  productPlanLimit: ProductPlanLimitSummary | null;
}

const DELTA_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DELTA_SYNC_OVERLAP_MS = 60_000;
const DELTA_COMPACTION_THRESHOLD = 200;
const PUBLISH_COALESCE_MS = 70;
const DELTA_PERSIST_DEBOUNCE_MS = 1200;

let deltaQueryIndexMissing = false;

const EMPTY_PRODUCTS: Product[] = [];
const EMPTY_PRODUCT_MAP: ReadonlyMap<string, Product> = new Map();
const EMPTY_ALERTS: CatalogInventoryAlert[] = [];
const DEFAULT_CATEGORIES: string[] = ['Todos'];
const EMPTY_CATALOG_INDEX: CatalogProductIndex = {
  entries: [],
  entriesByCategory: new Map(),
  uncategorizedEntries: [],
  categoryCounts: new Map(),
  uncategorizedCount: 0,
  brands: [],
  sizes: [],
};

const DEFAULT_STATS: InventoryStats = {
  totalProducts: 0,
  skuCount: 0,
  totalInventoryValue: 0,
  valuation: 0,
  lowStockCount: 0,
  outOfStockCount: 0,
};

function toEpochMs(val: unknown): number | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return undefined;
    return val < 1e11 ? Math.round(val * 1000) : Math.round(val);
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.toMillis === 'function') {
      const ms = Number((obj as { toMillis: () => unknown }).toMillis());
      return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
    }
    if (typeof obj.toDate === 'function') {
      const d = (obj as { toDate: () => Date }).toDate();
      const ms = d instanceof Date ? d.getTime() : Number.NaN;
      return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
    }
    if (typeof obj.seconds === 'number' && Number.isFinite(obj.seconds)) {
      const nanos =
        typeof obj.nanoseconds === 'number' && Number.isFinite(obj.nanoseconds)
          ? obj.nanoseconds
          : 0;
      const ms = Math.round(obj.seconds * 1000 + nanos / 1e6);
      return ms > 0 ? ms : undefined;
    }
  }
  if (typeof val === 'string') {
    const num = Number(val);
    if (Number.isFinite(num) && num > 0) {
      return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
    }
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function isPlainRecord(val: unknown): val is Record<string, any> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isDeletedProduct(
  product: (Product & { deletedAt?: unknown; deleted?: unknown }) | null | undefined
): boolean {
  if (!product) return false;
  const candidate = product as { deletedAt?: unknown; deleted?: unknown };
  if (candidate.deleted === true) return true;
  if (
    candidate.deletedAt !== undefined &&
    candidate.deletedAt !== null &&
    candidate.deletedAt !== 0
  ) {
    return Boolean(toEpochMs(candidate.deletedAt) ?? candidate.deletedAt);
  }
  return false;
}

function isMissingFirestoreIndexError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = String(e.code || '').toLowerCase();
  const msg = String(e.message || '').toLowerCase();
  return (
    code === 'failed-precondition' ||
    msg.includes('requires an index') ||
    msg.includes('failed-precondition')
  );
}

function isEmptyContainer(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object') {
    for (const key in val as Record<string, unknown>) {
      if (
        Object.prototype.hasOwnProperty.call(val, key) &&
        (val as Record<string, unknown>)[key] !== undefined
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function shallowRecordNumbersEqual(
  a: Record<string, number> | undefined | null,
  b: Record<string, number> | undefined | null
): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return isEmptyContainer(a) && isEmptyContainer(b);
  let countA = 0;
  for (const k in a) {
    if (!Object.prototype.hasOwnProperty.call(a, k) || a[k] === undefined) continue;
    countA += 1;
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  let countB = 0;
  for (const k in b) {
    if (Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined) {
      countB += 1;
    }
  }
  return countA === countB;
}

function primitiveArraysEqual(
  a: readonly unknown[] | undefined | null,
  b: readonly unknown[] | undefined | null
): boolean {
  if (a === b) return true;
  const lenA = a ? a.length : 0;
  const lenB = b ? b.length : 0;
  if (lenA !== lenB) return false;
  if (lenA === 0) return true;
  for (let i = 0; i < lenA; i += 1) {
    if (a![i] !== b![i]) return false;
  }
  return true;
}

function deepValuesEqual(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth > 8) return false;

  const isArrA = Array.isArray(a);
  const isArrB = Array.isArray(b);
  if (isArrA || isArrB) {
    if (!isArrA || !isArrB) return false;
    const arrA = a as readonly unknown[];
    const arrB = b as readonly unknown[];
    if (arrA.length !== arrB.length) return false;
    if (arrA.length === 0) return true;
    for (let i = 0; i < arrA.length; i += 1) {
      if (!deepValuesEqual(arrA[i], arrB[i], depth + 1)) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  if (typeof objA.toMillis === 'function' || typeof objB.toMillis === 'function') {
    return toEpochMs(objA) === toEpochMs(objB);
  }
  if (isEmptyContainer(objA) && isEmptyContainer(objB)) return true;

  let countA = 0;
  for (const k in objA) {
    if (!Object.prototype.hasOwnProperty.call(objA, k)) continue;
    const valA = objA[k];
    if (valA === undefined) continue;
    countA += 1;
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepValuesEqual(valA, objB[k], depth + 1)) return false;
  }
  let countB = 0;
  for (const k in objB) {
    if (Object.prototype.hasOwnProperty.call(objB, k) && objB[k] !== undefined) {
      countB += 1;
    }
  }
  return countA === countB;
}

function containersEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isEmptyContainer(a) && isEmptyContainer(b)) return true;
  if (isEmptyContainer(a) || isEmptyContainer(b)) return false;
  return deepValuesEqual(a, b, 0);
}

function productsDifferForCache(prev: Product | undefined, next: Product): boolean {
  if (prev === next) return false;
  if (!prev) return true;

  const p = prev as Record<string, any>;
  const n = next as Record<string, any>;

  if (
    (toEpochMs(p.updatedAt) ?? 0) !== (toEpochMs(n.updatedAt) ?? 0) ||
    (toEpochMs(p.createdAt) ?? 0) !== (toEpochMs(n.createdAt) ?? 0) ||
    (toEpochMs(p.deletedAt) ?? 0) !== (toEpochMs(n.deletedAt) ?? 0)
  ) {
    return true;
  }

  if (
    prev.name !== next.name ||
    prev.category !== next.category ||
    prev.sku !== next.sku ||
    prev.barcode !== next.barcode ||
    prev.costPrice !== next.costPrice ||
    p.cost !== n.cost ||
    prev.suggestedPrice !== next.suggestedPrice ||
    prev.price !== next.price ||
    prev.minSalePrice !== next.minSalePrice ||
    prev.minStock !== next.minStock ||
    prev.imageUrl !== next.imageUrl ||
    prev.thumbUrl !== next.thumbUrl ||
    prev.hint !== next.hint ||
    prev.active !== next.active ||
    p.deleted !== n.deleted ||
    prev.brand !== next.brand ||
    p.marca !== n.marca ||
    prev.sizeLabel !== next.sizeLabel ||
    p.size !== n.size ||
    p.medida !== n.medida ||
    prev.supplier !== next.supplier ||
    p.description !== n.description ||
    prev.ecommerceDescription !== next.ecommerceDescription ||
    prev.slug !== next.slug ||
    prev.modelUrl !== next.modelUrl ||
    prev.unitOfMeasure !== next.unitOfMeasure ||
    p.unit !== n.unit ||
    prev.allowDecimals !== next.allowDecimals ||
    prev.stepDecimal !== next.stepDecimal ||
    prev.taxExemptionCode !== next.taxExemptionCode ||
    p.taxCode !== n.taxCode ||
    p.isWeighable !== n.isWeighable ||
    p.trackInventory !== n.trackInventory ||
    p.allowNegativeStock !== n.allowNegativeStock ||
    prev.isFeatured !== next.isFeatured ||
    prev.isAmazonExempt !== next.isAmazonExempt ||
    p.icbper !== n.icbper ||
    p.branchId !== n.branchId ||
    prev.accountId !== next.accountId ||
    prev.weight !== next.weight ||
    prev._searchStr !== next._searchStr
  ) {
    return true;
  }

  if (
    !shallowRecordNumbersEqual(prev.stock, next.stock) ||
    !shallowRecordNumbersEqual(prev.reservedStock, next.reservedStock) ||
    !shallowRecordNumbersEqual(p.stockByBranch, n.stockByBranch) ||
    !shallowRecordNumbersEqual(p.reservedStockByBranch, n.reservedStockByBranch)
  ) {
    return true;
  }

  if (
    !primitiveArraysEqual(prev.barcodes, next.barcodes) ||
    !primitiveArraysEqual(prev.branchIds, next.branchIds) ||
    !primitiveArraysEqual(prev.lowStockBranches, next.lowStockBranches) ||
    !primitiveArraysEqual(prev.galleryImages, next.galleryImages) ||
    !primitiveArraysEqual(p.images, n.images) ||
    !primitiveArraysEqual(prev.sizes, next.sizes) ||
    !primitiveArraysEqual(prev.tags, next.tags)
  ) {
    return true;
  }

  if (
    !containersEqual(prev.presentations, next.presentations) ||
    !containersEqual(prev.variants, next.variants) ||
    !containersEqual(prev.branchPrices, next.branchPrices) ||
    !containersEqual(prev.priceTiers, next.priceTiers) ||
    !containersEqual(prev.attributes, next.attributes) ||
    !containersEqual(p.branchPricing, n.branchPricing) ||
    !containersEqual(prev.dimensions, next.dimensions) ||
    !containersEqual(prev.seo, next.seo)
  ) {
    return true;
  }

  return false;
}

function createReadonlyMapView<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = {
    get size() {
      return source.size;
    },
    get(key: K) {
      return source.get(key);
    },
    has(key: K) {
      return source.has(key);
    },
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      source.forEach((value, key) => {
        callbackfn.call(thisArg, value, key, view);
      });
    },
    entries() {
      return source.entries();
    },
    keys() {
      return source.keys();
    },
    values() {
      return source.values();
    },
    [Symbol.iterator]() {
      return source.entries();
    },
  };
  return view;
}

function deriveCategoriesFromCounts(categoryCounts: ReadonlyMap<string, number>): string[] {
  if (categoryCounts.size === 0) return DEFAULT_CATEGORIES;
  return ['Todos', ...Array.from(categoryCounts.keys()).sort((a, b) => a.localeCompare(b))];
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function computeProductPlanLimit(
  entry: { current?: number; max?: number; type?: 'hard' | 'soft' } | undefined,
  visibleCount: number
): ProductPlanLimitSummary | null {
  if (!entry) return null;
  const max = Number(entry.max ?? 0);
  if (max <= 0) {
    return {
      current: visibleCount || Number(entry.current ?? 0),
      max: 0,
      type: entry.type || 'soft',
      isAtLimit: false,
      isNearLimit: false,
    };
  }
  const current = Math.max(Number(entry.current ?? 0), visibleCount);
  return {
    current,
    max,
    type: entry.type || 'soft',
    isAtLimit: current >= max,
    isNearLimit: current >= Math.floor(max * 0.8) && current < max,
  };
}

const ProductsActionsContext = createContext<ProductsActionsContextType>({
  getProductById: () => undefined,
  findByBarcode: () => null,
  findByBarcodeRemote: async () => null,
  getProductStock: () => 0,
  getProductAvailableStock: () => 0,
  refreshProducts: () => {},
  upsertProduct: () => {},
  upsertProductsBatch: () => {},
  validateProductCreation: async () => ({ allowed: true }),
});

const ProductsContext = createContext<ProductsContextType>({
  products: EMPTY_PRODUCTS,
  productsById: EMPTY_PRODUCT_MAP,
  catalogIndex: EMPTY_CATALOG_INDEX,
  loading: true,
  refreshing: false,
  catalogComplete: false,
  error: null,
  categories: DEFAULT_CATEGORIES,
  stats: DEFAULT_STATS,
  criticalAlerts: EMPTY_ALERTS,
  productPlanLimit: null,
  getProductById: () => undefined,
  findByBarcode: () => null,
  findByBarcodeRemote: async () => null,
  getProductStock: () => 0,
  getProductAvailableStock: () => 0,
  refreshProducts: () => {},
  upsertProduct: () => {},
  upsertProductsBatch: () => {},
  validateProductCreation: async () => ({ allowed: true }),
});

export const ProductsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, accountId, branchId } = useAuthSession();
  const { isOnline } = useNetworkStatus();
  const { limits, refreshAccess } = usePlanAccess();

  const [productsState, setProductsState] = useState<{
    products: Product[];
    byId: ReadonlyMap<string, Product>;
    catalogIndex: CatalogProductIndex;
    scopeKey: string | null;
  }>({
    products: EMPTY_PRODUCTS,
    byId: EMPTY_PRODUCT_MAP,
    catalogIndex: EMPTY_CATALOG_INDEX,
    scopeKey: null,
  });
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [catalogComplete, setCatalogComplete] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [refreshTick, setRefreshTick] = useState<number>(0);
  const [inventorySummary, setInventorySummary] = useState<{
    stats: InventoryStats;
    alerts: CatalogInventoryAlert[];
  }>({ stats: DEFAULT_STATS, alerts: EMPTY_ALERTS });

  const previousAlertCount = useRef<number>(0);
  const isOnlineRef = useRef<boolean>(isOnline);
  isOnlineRef.current = isOnline;
  const effectiveBranchId = branchId || 'main';
  const branchIdRef = useRef<string>(effectiveBranchId);
  const effectiveBranchIdRef = useRef<string>(effectiveBranchId);
  effectiveBranchIdRef.current = effectiveBranchId;

  const accountIdRef = useRef<string | null>(accountId);
  accountIdRef.current = accountId;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const refreshAccessRef = useRef(refreshAccess);
  refreshAccessRef.current = refreshAccess;
  const refreshingRef = useRef<boolean>(refreshing);
  refreshingRef.current = refreshing;
  const errorRef = useRef<string | null>(error);
  errorRef.current = error;
  const catalogCompleteRef = useRef(catalogComplete);
  catalogCompleteRef.current = catalogComplete;

  const localRecentProductsRef = useRef<Map<string, Product>>(new Map());
  const productMapRef = useRef<Map<string, Product>>(new Map());
  const barcodeIndexRef = useRef(new ProductCatalogIndex());
  const inventoryIndexRef = useRef(new ProductCatalogInventoryIndex(effectiveBranchId));
  const catalogFilterIndexRef = useRef(new MutableCatalogProductIndex());
  const barcodeIndexScopeRef = useRef<string | null>(null);
  const activeScopeRef = useRef<string | null>(null);
  const effectGenerationRef = useRef(0);
  const authoritativeSnapshotReadyRef = useRef(false);
  const lastCategoriesRef = useRef<string[]>(DEFAULT_CATEGORIES);
  const lastSyncMsRef = useRef<number>(0);
  const allDocsHaveUpdatedAtRef = useRef<boolean>(false);
  const forceFullRefreshRef = useRef<boolean>(false);
  const pendingDeltaUpsertsRef = useRef<Map<string, Product>>(new Map());
  const pendingDeltaDeletesRef = useRef<Set<string>>(new Set());
  const publishCatalogStateRef = useRef<(scopeKey: string) => void>(() => {});
  const scheduleDeltaFlushRef = useRef<() => void>(() => {});

  // Account-scoped cache key so branch switches only recompute branch stock KPIs in memory
  const activeCacheKey =
    user?.uid && accountId ? productCatalogCacheKey(user.uid, accountId, 'account') : null;
  const activeCacheKeyRef = useRef<string | null>(activeCacheKey);
  activeCacheKeyRef.current = activeCacheKey;

  const hasMatchingScope = Boolean(activeCacheKey && productsState.scopeKey === activeCacheKey);
  const visibleProducts = productsForCatalogScope(
    productsState.products,
    productsState.scopeKey,
    activeCacheKey
  );
  const visibleProductsById = hasMatchingScope ? productsState.byId : EMPTY_PRODUCT_MAP;
  const catalogIndex = hasMatchingScope ? productsState.catalogIndex : EMPTY_CATALOG_INDEX;

  // Time-slice branch-switch inventory KPI rebuild so UI animations remain responsive
  useEffect(() => {
    if (branchIdRef.current === effectiveBranchId) return;
    branchIdRef.current = effectiveBranchId;
    const nextIndex = new ProductCatalogInventoryIndex(effectiveBranchId);
    inventoryIndexRef.current = nextIndex;

    if (productMapRef.current.size === 0) {
      if (catalogCompleteRef.current && activeScopeRef.current === activeCacheKey) {
        setInventorySummary(nextIndex.snapshot());
      }
      return;
    }

    let cancelled = false;
    const interactionHandle = InteractionManager.runAfterInteractions(() => {
      if (cancelled || inventoryIndexRef.current !== nextIndex) return;
      const productsSnapshot = Array.from(productMapRef.current.values());
      void processCatalogInBatches(productsSnapshot, (batch) => {
        if (cancelled || inventoryIndexRef.current !== nextIndex) return;
        for (let i = 0; i < batch.length; i += 1) {
          const product = batch[i];
          if (product && productMapRef.current.get(product.id) === product) {
            nextIndex.upsert(product);
          }
        }
      }).then(() => {
        if (cancelled || inventoryIndexRef.current !== nextIndex) return;
        if (catalogCompleteRef.current && activeScopeRef.current === activeCacheKey) {
          setInventorySummary(nextIndex.snapshot());
        }
      });
    }) as { cancel?: () => void } | undefined;

    return () => {
      cancelled = true;
      interactionHandle?.cancel?.();
    };
  }, [effectiveBranchId, activeCacheKey]);

  const upsertProductsBatch = useCallback((items: Product[]) => {
    if (!items || items.length === 0) return;
    const scopeKey = activeCacheKeyRef.current;
    const currentAccountId = accountIdRef.current;
    if (!scopeKey || activeScopeRef.current !== scopeKey) return;

    let updatedCount = 0;

    for (let i = 0; i < items.length; i += 1) {
      const product = items[i];
      if (!product || !product.id) continue;
      if (product.accountId && currentAccountId && product.accountId !== currentAccountId) continue;

      if (isDeletedProduct(product)) {
        localRecentProductsRef.current.delete(product.id);
        removeCatalogProduct(productMapRef.current, barcodeIndexRef.current, product.id);
        inventoryIndexRef.current.remove(product.id);
        catalogFilterIndexRef.current.remove(product.id);
        pendingDeltaUpsertsRef.current.delete(product.id);
        pendingDeltaDeletesRef.current.add(product.id);
        updatedCount += 1;
        continue;
      }

      localRecentProductsRef.current.set(product.id, product);
      getIndexedCatalogProduct(product);
      productMapRef.current.set(product.id, product);
      barcodeIndexRef.current.upsert(product);
      inventoryIndexRef.current.upsert(product);
      if (product.active === false) {
        catalogFilterIndexRef.current.remove(product.id);
      } else {
        catalogFilterIndexRef.current.upsert(product);
      }
      pendingDeltaDeletesRef.current.delete(product.id);
      pendingDeltaUpsertsRef.current.set(product.id, product);
      updatedCount += 1;
    }

    if (updatedCount === 0) return;

    publishCatalogStateRef.current(scopeKey);
    if (catalogCompleteRef.current) {
      setInventorySummary(inventoryIndexRef.current.snapshot());
      scheduleDeltaFlushRef.current();
    }
  }, []);

  const upsertProduct = useCallback(
    (product: Product) => {
      upsertProductsBatch([product]);
    },
    [upsertProductsBatch]
  );

  const mapSnapshotDoc = useCallback(
    (docSnap: any): Product => {
      const data = (typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data) || {};
      const baseCost = Number(data.costPrice ?? data.cost ?? 0);
      const baseSuggested = Number(data.suggestedPrice ?? data.price ?? 0);
      const baseMin = Number(data.minSalePrice ?? baseCost);
      const sanitizedGallery = sanitizeRemoteImageUrls(
        Array.isArray(data.galleryImages)
          ? data.galleryImages
          : data.imageUrl
          ? [data.imageUrl]
          : []
      );
      const safeImageUrl =
        typeof data.imageUrl === 'string' &&
        data.imageUrl.trim() &&
        sanitizedGallery.includes(data.imageUrl.trim())
          ? data.imageUrl.trim()
          : sanitizedGallery[0] || (typeof data.imageUrl === 'string' ? data.imageUrl : '');

      const mapped: Record<string, any> = {
        id: docSnap.id,
        accountId: accountId || data.accountId || '',
        name: data.name || 'Sin nombre',
        category: data.category || 'General',
        sku: data.sku || '',
        barcode: data.barcode || '',
        barcodes: Array.isArray(data.barcodes) ? data.barcodes : [],
        costPrice: baseCost,
        suggestedPrice: baseSuggested,
        price: baseSuggested,
        minSalePrice: baseMin,
        stock: isPlainRecord(data.stock) ? data.stock : {},
        reservedStock: isPlainRecord(data.reservedStock) ? data.reservedStock : {},
        branchIds: Array.isArray(data.branchIds) ? data.branchIds : [],
        lowStockBranches: Array.isArray(data.lowStockBranches) ? data.lowStockBranches : [],
        branchPrices: isPlainRecord(data.branchPrices) ? data.branchPrices : {},
        variants: Array.isArray(data.variants) ? data.variants : [],
        priceTiers: Array.isArray(data.priceTiers) ? normalizePriceTiers(data.priceTiers) : [],
        presentations: Array.isArray(data.presentations)
          ? data.presentations.map(normalizePresentation)
          : [],
        galleryImages: sanitizedGallery,
        attributes:
          typeof data.attributes === 'object' && data.attributes !== null ? data.attributes : {},
        taxExemptionCode: data.taxExemptionCode || '10',
        imageUrl: safeImageUrl,
        thumbUrl: data.thumbUrl || safeImageUrl || '',
        hint: data.hint || '',
        unitOfMeasure: data.unitOfMeasure || 'unit',
        allowDecimals: Boolean(data.allowDecimals),
        active: data.active !== false,
      };

      if (data.stepDecimal) mapped.stepDecimal = Number(data.stepDecimal);
      if (typeof data.description === 'string') mapped.description = data.description;
      if (data.cost !== undefined && data.cost !== null) mapped.cost = Number(data.cost);
      if (isPlainRecord(data.stockByBranch)) mapped.stockByBranch = data.stockByBranch;
      if (isPlainRecord(data.reservedStockByBranch)) {
        mapped.reservedStockByBranch = data.reservedStockByBranch;
      }
      if (data.minStock !== undefined && data.minStock !== null) {
        mapped.minStock = Number(data.minStock);
      }
      if (typeof data.supplier === 'string') mapped.supplier = data.supplier;
      if (typeof data.brand === 'string') mapped.brand = data.brand;
      if (typeof data.marca === 'string') mapped.marca = data.marca;
      if (typeof data.sizeLabel === 'string') mapped.sizeLabel = data.sizeLabel;
      if (typeof data.size === 'string') mapped.size = data.size;
      if (typeof data.medida === 'string') mapped.medida = data.medida;
      if (Array.isArray(data.sizes)) mapped.sizes = data.sizes;
      if (Array.isArray(data.images)) mapped.images = data.images;
      if (typeof data.branchId === 'string') mapped.branchId = data.branchId;
      if (isPlainRecord(data.branchPricing)) mapped.branchPricing = data.branchPricing;
      if (typeof data.unit === 'string') mapped.unit = data.unit;
      if (typeof data.taxCode === 'string') mapped.taxCode = data.taxCode;
      if (typeof data.isWeighable === 'boolean') mapped.isWeighable = data.isWeighable;
      if (typeof data.trackInventory === 'boolean') mapped.trackInventory = data.trackInventory;
      if (typeof data.allowNegativeStock === 'boolean') {
        mapped.allowNegativeStock = data.allowNegativeStock;
      }
      if (typeof data.isFeatured === 'boolean') mapped.isFeatured = data.isFeatured;
      if (typeof data.modelUrl === 'string') mapped.modelUrl = data.modelUrl;
      if (typeof data.ecommerceDescription === 'string') {
        mapped.ecommerceDescription = data.ecommerceDescription;
      }
      if (typeof data.slug === 'string') mapped.slug = data.slug;
      if (Array.isArray(data.tags)) mapped.tags = data.tags;
      if (data.weight !== undefined && data.weight !== null) mapped.weight = Number(data.weight);
      if (isPlainRecord(data.dimensions)) mapped.dimensions = data.dimensions;
      if (isPlainRecord(data.seo)) mapped.seo = data.seo;
      if (typeof data.isAmazonExempt === 'boolean') mapped.isAmazonExempt = data.isAmazonExempt;
      if (typeof data.icbper === 'boolean') mapped.icbper = data.icbper;
      if (typeof data._searchStr === 'string') mapped._searchStr = data._searchStr;

      const updatedAtMs = toEpochMs(data.updatedAt);
      if (updatedAtMs !== undefined) mapped.updatedAt = updatedAtMs;
      const createdAtMs = toEpochMs(data.createdAt);
      if (createdAtMs !== undefined) mapped.createdAt = createdAtMs;
      const deletedAtMs = toEpochMs(data.deletedAt);
      if (deletedAtMs !== undefined) mapped.deletedAt = deletedAtMs;
      if (typeof data.deleted === 'boolean') mapped.deleted = data.deleted;

      return mapped as Product;
    },
    [accountId]
  );

  // Hydrate MMKV cache concurrently with Firestore sync (delta when safe, full when required)
  useEffect(() => {
    const scopeKey = activeCacheKey;
    const generation = ++effectGenerationRef.current;
    const isCurrent = () =>
      effectGenerationRef.current === generation && activeScopeRef.current === scopeKey;

    if (!user?.uid || !accountId || !scopeKey) {
      activeScopeRef.current = null;
      authoritativeSnapshotReadyRef.current = false;
      barcodeIndexScopeRef.current = null;
      productMapRef.current.clear();
      barcodeIndexRef.current.clear();
      inventoryIndexRef.current.clear();
      catalogFilterIndexRef.current.clear();
      localRecentProductsRef.current.clear();
      pendingDeltaUpsertsRef.current.clear();
      pendingDeltaDeletesRef.current.clear();
      previousAlertCount.current = 0;
      lastCategoriesRef.current = DEFAULT_CATEGORIES;
      lastSyncMsRef.current = 0;
      allDocsHaveUpdatedAtRef.current = false;
      setProductsState({
        products: EMPTY_PRODUCTS,
        byId: EMPTY_PRODUCT_MAP,
        catalogIndex: EMPTY_CATALOG_INDEX,
        scopeKey: null,
      });
      setRefreshing(false);
      setCatalogComplete(false);
      setError(null);
      setInventorySummary({ stats: DEFAULT_STATS, alerts: EMPTY_ALERTS });
      setCategories(DEFAULT_CATEGORIES);
      publishCatalogStateRef.current = () => {};
      scheduleDeltaFlushRef.current = () => {};
      return;
    }

    const scopeChanged = activeScopeRef.current !== scopeKey;
    activeScopeRef.current = scopeKey;
    barcodeIndexScopeRef.current = scopeKey;
    authoritativeSnapshotReadyRef.current = false;
    if (scopeChanged) {
      productMapRef.current.clear();
      barcodeIndexRef.current.clear();
      inventoryIndexRef.current = new ProductCatalogInventoryIndex(branchIdRef.current);
      catalogFilterIndexRef.current.clear();
      localRecentProductsRef.current.clear();
      pendingDeltaUpsertsRef.current.clear();
      pendingDeltaDeletesRef.current.clear();
      previousAlertCount.current = 0;
      lastCategoriesRef.current = DEFAULT_CATEGORIES;
      lastSyncMsRef.current = 0;
      allDocsHaveUpdatedAtRef.current = false;
      setProductsState({
        products: EMPTY_PRODUCTS,
        byId: EMPTY_PRODUCT_MAP,
        catalogIndex: EMPTY_CATALOG_INDEX,
        scopeKey,
      });
      setCatalogComplete(false);
      setError(null);
      setInventorySummary({ stats: DEFAULT_STATS, alerts: EMPTY_ALERTS });
      setCategories(DEFAULT_CATEGORIES);
    }
    setRefreshing(true);

    const nowMs = Date.now();
    const syncManifest = readProductCatalogManifestSync(scopeKey, catalogKVStorage);
    const hasValidManifest = Boolean(
      syncManifest && nowMs - syncManifest.cachedAt <= PRODUCT_CATALOG_CACHE_TTL_MS
    );
    const forceFullRefresh = forceFullRefreshRef.current;
    forceFullRefreshRef.current = false;

    if (hasValidManifest && syncManifest) {
      if (typeof syncManifest.lastSyncMs === 'number') {
        lastSyncMsRef.current = syncManifest.lastSyncMs;
      }
      if (typeof syncManifest.allDocsHaveUpdatedAt === 'boolean') {
        allDocsHaveUpdatedAtRef.current = syncManifest.allDocsHaveUpdatedAt;
      }
    }

    const canStartDeltaSync = Boolean(
      scopeChanged &&
        !deltaQueryIndexMissing &&
        !forceFullRefresh &&
        hasValidManifest &&
        syncManifest?.allDocsHaveUpdatedAt === true &&
        typeof syncManifest.lastSyncMs === 'number' &&
        nowMs - syncManifest.lastSyncMs < DELTA_SYNC_MAX_AGE_MS
    );

    let unsubscribe: (() => void) | undefined;
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    let compactTimer: ReturnType<typeof setTimeout> | undefined;
    let coalescePublishTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let deltaInteractionTask: { cancel?: () => void } | undefined;
    let compactInteractionTask: { cancel?: () => void } | undefined;
    let processing = Promise.resolve();
    let cacheChunkPublished = false;
    let cacheHydrated = false;
    let cacheLoadFinished = !scopeChanged;
    let publishedOnce = false;
    let serverSnapshotApplied = false;
    let isDeltaMode = canStartDeltaSync;
    let latestCachedDocs: any[] | null = null;

    const publishNow = () => {
      if (!isCurrent()) return;
      if (coalescePublishTimer) {
        clearTimeout(coalescePublishTimer);
        coalescePublishTimer = undefined;
      }
      publishedOnce = true;
      const nextCatalogIndex = catalogFilterIndexRef.current.snapshot();
      const nextProducts =
        nextCatalogIndex.products &&
        nextCatalogIndex.products.length === productMapRef.current.size
          ? nextCatalogIndex.products
          : Array.from(productMapRef.current.values());

      setProductsState({
        products: nextProducts,
        byId: createReadonlyMapView(productMapRef.current),
        catalogIndex: nextCatalogIndex,
        scopeKey,
      });

      const nextCategories = deriveCategoriesFromCounts(nextCatalogIndex.categoryCounts);
      if (!stringArraysEqual(lastCategoriesRef.current, nextCategories)) {
        lastCategoriesRef.current = nextCategories;
        setCategories(nextCategories);
      }
    };

    publishCatalogStateRef.current = (targetScopeKey: string) => {
      if (targetScopeKey === scopeKey) {
        publishNow();
      }
    };

    const scheduleCoalescedPublish = () => {
      if (!isCurrent()) return;
      if (coalescePublishTimer) return;
      coalescePublishTimer = setTimeout(() => {
        coalescePublishTimer = undefined;
        if (!isCurrent()) return;
        publishNow();
        if (catalogCompleteRef.current) {
          setInventorySummary(inventoryIndexRef.current.snapshot());
        }
      }, PUBLISH_COALESCE_MS);
    };

    const removeProductFromRefs = (productId: string): boolean => {
      const existed = productMapRef.current.has(productId);
      if (existed) {
        removeCatalogProduct(productMapRef.current, barcodeIndexRef.current, productId);
      } else {
        barcodeIndexRef.current.remove(productId);
      }
      inventoryIndexRef.current.remove(productId);
      catalogFilterIndexRef.current.remove(productId);
      return existed;
    };

    const upsertMapped = (product: Product): boolean => {
      if (isDeletedProduct(product)) {
        return removeProductFromRefs(product.id);
      }
      const existing = productMapRef.current.get(product.id);
      if (existing && !productsDifferForCache(existing, product)) {
        return false;
      }
      getIndexedCatalogProduct(product);
      productMapRef.current.set(product.id, product);
      barcodeIndexRef.current.upsert(product);
      inventoryIndexRef.current.upsert(product);
      if (product.active === false) {
        catalogFilterIndexRef.current.remove(product.id);
      } else {
        catalogFilterIndexRef.current.upsert(product);
      }
      return true;
    };

    const runFullCompactionNow = (sourceProducts?: Product[]) => {
      if (!isCurrent()) return;
      if (deltaTimer) {
        clearTimeout(deltaTimer);
        deltaTimer = undefined;
      }
      if (deltaInteractionTask?.cancel) {
        deltaInteractionTask.cancel();
        deltaInteractionTask = undefined;
      }
      pendingDeltaUpsertsRef.current.clear();
      pendingDeltaDeletesRef.current.clear();

      const toPersist = sourceProducts || Array.from(productMapRef.current.values());
      const cacheGeneration = `${Date.now()}-${generation}-${Math.random().toString(36).slice(2, 8)}`;
      writeProductCatalogCache(catalogKVStorage, scopeKey, toPersist, {
        generation: cacheGeneration,
        isCurrent,
        trimAfterWrite: true,
        clearDelta: true,
        accountId,
        lastSyncMs: lastSyncMsRef.current || Date.now(),
        allDocsHaveUpdatedAt: allDocsHaveUpdatedAtRef.current,
      }).catch((cacheError) => {
        console.warn('[ProductsContext] Could not persist catalog cache:', cacheError);
      });
    };

    const scheduleFullCompaction = (sourceProducts?: Product[], delayMs = 1500) => {
      if (compactTimer) clearTimeout(compactTimer);
      if (compactInteractionTask?.cancel) compactInteractionTask.cancel();
      compactTimer = setTimeout(() => {
        compactTimer = undefined;
        compactInteractionTask = InteractionManager.runAfterInteractions(() => {
          compactInteractionTask = undefined;
          runFullCompactionNow(sourceProducts);
        });
      }, delayMs);
    };

    const flushDeltaOverlayNow = async () => {
      if (!isCurrent()) return;
      const upserted = Array.from(pendingDeltaUpsertsRef.current.values());
      const deletedIds = Array.from(pendingDeltaDeletesRef.current);
      if (upserted.length === 0 && deletedIds.length === 0) return;
      pendingDeltaUpsertsRef.current.clear();
      pendingDeltaDeletesRef.current.clear();

      try {
        const { deltaCount } = await writeProductCatalogDelta(
          accountId,
          upserted,
          deletedIds,
          {
            storage: catalogKVStorage,
            lastSyncMs: lastSyncMsRef.current || Date.now(),
          }
        );
        if (isCurrent() && deltaCount > DELTA_COMPACTION_THRESHOLD) {
          scheduleFullCompaction(undefined, 500);
        }
      } catch (deltaError) {
        console.warn('[ProductsContext] Could not persist catalog delta:', deltaError);
      }
    };

    const scheduleDeltaPersist = () => {
      if (!isCurrent()) return;
      if (
        pendingDeltaUpsertsRef.current.size === 0 &&
        pendingDeltaDeletesRef.current.size === 0
      ) {
        return;
      }
      if (deltaTimer) clearTimeout(deltaTimer);
      if (deltaInteractionTask?.cancel) deltaInteractionTask.cancel();
      deltaTimer = setTimeout(() => {
        deltaTimer = undefined;
        deltaInteractionTask = InteractionManager.runAfterInteractions(() => {
          deltaInteractionTask = undefined;
          void flushDeltaOverlayNow();
        });
      }, DELTA_PERSIST_DEBOUNCE_MS);
    };

    scheduleDeltaFlushRef.current = scheduleDeltaPersist;

    let appStateSubscription: { remove: () => void } | undefined;
    if (typeof AppState?.addEventListener === 'function') {
      appStateSubscription = AppState.addEventListener('change', (nextState) => {
        if (nextState !== 'background' || !isCurrent()) return;
        if (!cacheLoadFinished && !authoritativeSnapshotReadyRef.current) return;
        if (productMapRef.current.size === 0 && !authoritativeSnapshotReadyRef.current) return;

        const hasInMemoryDeltas =
          pendingDeltaUpsertsRef.current.size > 0 ||
          pendingDeltaDeletesRef.current.size > 0;
        if (hasInMemoryDeltas) {
          if (compactTimer) {
            clearTimeout(compactTimer);
            compactTimer = undefined;
          }
          runFullCompactionNow();
          return;
        }

        if (catalogKVStorage.isSyncCapable) {
          if (getProductCatalogDeltaCountSync(accountId, catalogKVStorage) > 0) {
            if (compactTimer) {
              clearTimeout(compactTimer);
              compactTimer = undefined;
            }
            runFullCompactionNow();
          }
        } else {
          void getProductCatalogDeltaCount(accountId, catalogKVStorage)
            .then((count) => {
              if (count > 0 && isCurrent()) {
                if (compactTimer) {
                  clearTimeout(compactTimer);
                  compactTimer = undefined;
                }
                runFullCompactionNow();
              }
            })
            .catch(() => {});
        }
      });
    }

    const applySnapshotChanges = async (
      changes: any[],
      authoritativeDocs: any[],
      completesFirstSnapshot: boolean,
      isServerAuthoritative: boolean
    ) => {
      let dirtyCount = 0;

      if (changes.length > 0) {
        await processCatalogInBatches(changes, (batch) => {
          if (!isCurrent()) return;
          for (const change of batch) {
            const productId = change.doc.id;
            if (change.type === 'removed') {
              localRecentProductsRef.current.delete(productId);
              if (removeProductFromRefs(productId)) {
                if (isServerAuthoritative) {
                  pendingDeltaUpsertsRef.current.delete(productId);
                  pendingDeltaDeletesRef.current.add(productId);
                }
                dirtyCount += 1;
              }
            } else {
              const mapped = mapSnapshotDoc(change.doc);
              localRecentProductsRef.current.delete(productId);
              if (isDeletedProduct(mapped)) {
                if (removeProductFromRefs(productId)) {
                  if (isServerAuthoritative) {
                    pendingDeltaUpsertsRef.current.delete(productId);
                    pendingDeltaDeletesRef.current.add(productId);
                  }
                  dirtyCount += 1;
                }
              } else if (upsertMapped(mapped)) {
                if (isServerAuthoritative) {
                  pendingDeltaDeletesRef.current.delete(productId);
                  pendingDeltaUpsertsRef.current.set(productId, mapped);
                  if (!(mapped as { updatedAt?: number }).updatedAt) {
                    allDocsHaveUpdatedAtRef.current = false;
                  }
                }
                dirtyCount += 1;
              }
            }
          }
        });
      }

      if (!isCurrent()) return;
      let serverAllDocsHaveUpdatedAt = true;

      if (completesFirstSnapshot && isServerAuthoritative) {
        const serverIds = new Set<string>();
        let publishedFirstNetBatch = productMapRef.current.size > 0;
        await processCatalogInBatches(authoritativeDocs, (batch) => {
          if (!isCurrent()) return;
          for (const docSnap of batch) {
            const mapped = mapSnapshotDoc(docSnap);
            localRecentProductsRef.current.delete(docSnap.id);
            if (isDeletedProduct(mapped)) {
              if (removeProductFromRefs(docSnap.id)) {
                dirtyCount += 1;
              }
              continue;
            }
            serverIds.add(docSnap.id);
            if (!(mapped as { updatedAt?: number }).updatedAt) {
              serverAllDocsHaveUpdatedAt = false;
            }
            if (upsertMapped(mapped)) {
              dirtyCount += 1;
            }
          }
          if (!publishedFirstNetBatch && productMapRef.current.size > 0) {
            publishedFirstNetBatch = true;
            publishNow();
          }
        });

        if (productMapRef.current.size > serverIds.size) {
          await processCatalogIteratorInBatches(productMapRef.current.keys(), (batch) => {
            if (!isCurrent()) return;
            for (const productId of batch) {
              if (!shouldRetainCatalogProduct(productId, serverIds, localRecentProductsRef.current)) {
                removeProductFromRefs(productId);
                dirtyCount += 1;
              }
            }
          });
        }
      } else if (completesFirstSnapshot) {
        await processCatalogInBatches(authoritativeDocs, (batch) => {
          if (!isCurrent()) return;
          for (const docSnap of batch) {
            const mapped = mapSnapshotDoc(docSnap);
            if (upsertMapped(mapped)) {
              dirtyCount += 1;
            }
          }
        });
      }

      if (!isCurrent()) return;

      if (completesFirstSnapshot) {
        publishNow();
        setCatalogComplete(true);
        if (isServerAuthoritative) {
          authoritativeSnapshotReadyRef.current = true;
          lastSyncMsRef.current = Date.now();
          allDocsHaveUpdatedAtRef.current = serverAllDocsHaveUpdatedAt;
        }
        if (dirtyCount > 0 || !cacheHydrated) {
          setInventorySummary(inventoryIndexRef.current.snapshot());
        }
        setRefreshing(false);
        setError(null);
        if (isServerAuthoritative) {
          const hasStoredDelta =
            catalogKVStorage.isSyncCapable &&
            getProductCatalogDeltaCountSync(accountId, catalogKVStorage) > 0;
          const manifestNeedsRefresh =
            !hasValidManifest ||
            forceFullRefresh ||
            !syncManifest?.lastSyncMs ||
            Date.now() - syncManifest.lastSyncMs >= DELTA_SYNC_MAX_AGE_MS ||
            syncManifest.allDocsHaveUpdatedAt !== serverAllDocsHaveUpdatedAt ||
            pendingDeltaUpsertsRef.current.size > 0 ||
            pendingDeltaDeletesRef.current.size > 0 ||
            hasStoredDelta;

          if (dirtyCount > 0 || !cacheHydrated || manifestNeedsRefresh) {
            scheduleFullCompaction(undefined, 1500);
          }
        }
      } else if (catalogCompleteRef.current && dirtyCount > 0) {
        scheduleCoalescedPublish();
        if (isServerAuthoritative) {
          lastSyncMsRef.current = Date.now();
          scheduleDeltaPersist();
        }
      } else if (dirtyCount > 0 || !publishedOnce) {
        publishNow();
      }
    };

    const applyDeltaSnapshotChanges = async (
      items: any[],
      isDocsArray: boolean,
      isServerAuthoritative: boolean
    ) => {
      let dirtyCount = 0;

      if (items.length > 0) {
        await processCatalogInBatches(items, (batch) => {
          if (!isCurrent()) return;
          for (const entry of batch) {
            const changeType = isDocsArray ? 'modified' : entry.type;
            const docSnap = isDocsArray ? entry : entry.doc;
            if (!docSnap?.id) continue;
            const productId = docSnap.id;

            if (changeType === 'removed') {
              localRecentProductsRef.current.delete(productId);
              if (removeProductFromRefs(productId)) {
                if (isServerAuthoritative) {
                  pendingDeltaUpsertsRef.current.delete(productId);
                  pendingDeltaDeletesRef.current.add(productId);
                }
                dirtyCount += 1;
              }
            } else {
              const mapped = mapSnapshotDoc(docSnap);
              localRecentProductsRef.current.delete(productId);
              if (isDeletedProduct(mapped)) {
                if (removeProductFromRefs(productId)) {
                  if (isServerAuthoritative) {
                    pendingDeltaUpsertsRef.current.delete(productId);
                    pendingDeltaDeletesRef.current.add(productId);
                  }
                  dirtyCount += 1;
                }
              } else if (upsertMapped(mapped)) {
                if (isServerAuthoritative) {
                  pendingDeltaDeletesRef.current.delete(productId);
                  pendingDeltaUpsertsRef.current.set(productId, mapped);
                  if (!(mapped as { updatedAt?: number }).updatedAt) {
                    allDocsHaveUpdatedAtRef.current = false;
                  }
                }
                dirtyCount += 1;
              }
            }
          }
        });
      }

      if (!isCurrent()) return;
      if (isServerAuthoritative) {
        lastSyncMsRef.current = Date.now();
        authoritativeSnapshotReadyRef.current = true;
        setCatalogComplete(true);
        setRefreshing(false);
        setError(null);
      }

      if (dirtyCount > 0) {
        if (isDocsArray) {
          publishNow();
          setInventorySummary(inventoryIndexRef.current.snapshot());
        } else {
          scheduleCoalescedPublish();
        }
        if (isServerAuthoritative) {
          scheduleDeltaPersist();
        }
      }
    };

    let hydratePromise = Promise.resolve();

    const startFullListener = () => {
      if (!isCurrent()) return;
      isDeltaMode = false;
      const realtimeQuery = query(
        collection(db, 'products'),
        where('accountId', '==', accountId)
      );

      if (!hasValidManifest && productMapRef.current.size === 0) {
        getDocs(query(realtimeQuery, limit(PRODUCT_CATALOG_FIRST_BATCH_SIZE)))
          .then((quickSnap) => {
            if (!isCurrent() || serverSnapshotApplied || quickSnap.empty) return;
            let added = 0;
            for (const docSnap of quickSnap.docs) {
              if (!productMapRef.current.has(docSnap.id)) {
                if (upsertMapped(mapSnapshotDoc(docSnap))) added += 1;
              }
            }
            if (added > 0 && productMapRef.current.size > 0) {
              publishNow();
            }
          })
          .catch(() => {
            // El listener completo de abajo maneja errores y reconexión.
          });
      }

      unsubscribe = onSnapshot(
        realtimeQuery,
        (snapshot) => {
          if (!isCurrent()) return;
          const fromCache = snapshot.metadata?.fromCache === true;

          if (!fromCache) {
            if (fallbackTimer) {
              clearTimeout(fallbackTimer);
              fallbackTimer = undefined;
            }
            latestCachedDocs = null;
            const isFirstServerSnapshot = !serverSnapshotApplied;
            serverSnapshotApplied = true;
            const changes = isFirstServerSnapshot ? [] : snapshot.docChanges();
            const docs = isFirstServerSnapshot ? snapshot.docs : [];
            processing = processing
              .then(async () => {
                await hydratePromise;
                if (!isCurrent()) return;
                await applySnapshotChanges(changes, docs, isFirstServerSnapshot, true);
              })
              .catch((processingError) => {
                if (!isCurrent()) return;
                const message =
                  processingError instanceof Error
                    ? processingError.message
                    : String(processingError);
                setError(message);
                setRefreshing(false);
                console.error(
                  '[ProductsContext] Error processing products snapshot:',
                  processingError
                );
              });
            return;
          }

          latestCachedDocs = snapshot.docs;
          const allowOfflineNow = !isOnlineRef.current;
          if (isAuthoritativeCatalogSnapshot(fromCache, { allowOffline: allowOfflineNow })) {
            if (fallbackTimer) {
              clearTimeout(fallbackTimer);
              fallbackTimer = undefined;
            }
            const docs = snapshot.docs;
            processing = processing
              .then(async () => {
                await hydratePromise;
                if (!isCurrent() || serverSnapshotApplied) return;
                await applySnapshotChanges([], docs, true, false);
              })
              .catch((processingError) => {
                if (!isCurrent()) return;
                const message =
                  processingError instanceof Error
                    ? processingError.message
                    : String(processingError);
                setError(message);
                setRefreshing(false);
              });
            return;
          }

          if (!fallbackTimer && !serverSnapshotApplied) {
            fallbackTimer = setTimeout(async () => {
              fallbackTimer = undefined;
              if (!isCurrent() || serverSnapshotApplied) return;
              const net = await NetInfo.fetch().catch(() => null);
              const stillOffline = net
                ? !(net.isConnected && net.isInternetReachable !== false)
                : !isOnlineRef.current;
              if (stillOffline && latestCachedDocs) {
                const docs = latestCachedDocs;
                processing = processing
                  .then(async () => {
                    await hydratePromise;
                    if (!isCurrent() || serverSnapshotApplied) return;
                    await applySnapshotChanges([], docs, true, false);
                  })
                  .catch(() => setRefreshing(false));
              } else {
                setRefreshing(false);
              }
            }, 4500);
          }
        },
        (snapshotError) => {
          if (!isCurrent()) return;
          if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = undefined;
          }
          const message =
            snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
          setError(message);
          setRefreshing(false);
          console.error('[ProductsContext] Error loading products snapshot:', snapshotError);
        }
      );
    };

    const startDeltaListener = () => {
      if (!isCurrent() || !syncManifest || typeof syncManifest.lastSyncMs !== 'number') {
        startFullListener();
        return;
      }
      isDeltaMode = true;
      const sinceMs = Math.max(0, syncManifest.lastSyncMs - DELTA_SYNC_OVERLAP_MS);
      const deltaQuery = query(
        collection(db, 'products'),
        where('accountId', '==', accountId),
        where('updatedAt', '>', Timestamp.fromMillis(sinceMs))
      );

      unsubscribe = onSnapshot(
        deltaQuery,
        (snapshot) => {
          if (!isCurrent() || !isDeltaMode) return;
          const fromCache = snapshot.metadata?.fromCache === true;

          if (!fromCache) {
            const isFirstServerDelta = !serverSnapshotApplied;
            serverSnapshotApplied = true;
            const items = isFirstServerDelta ? snapshot.docs : snapshot.docChanges();
            processing = processing
              .then(async () => {
                await hydratePromise;
                if (!isCurrent() || !isDeltaMode || !cacheHydrated) return;
                await applyDeltaSnapshotChanges(items, isFirstServerDelta, true);
              })
              .catch((processingError) => {
                if (!isCurrent()) return;
                const message =
                  processingError instanceof Error
                    ? processingError.message
                    : String(processingError);
                setError(message);
                setRefreshing(false);
                console.error(
                  '[ProductsContext] Error processing delta products snapshot:',
                  processingError
                );
              });
            return;
          }

          if (!snapshot.empty) {
            const docs = snapshot.docs;
            processing = processing
              .then(async () => {
                await hydratePromise;
                if (!isCurrent() || !isDeltaMode || !cacheHydrated || serverSnapshotApplied) return;
                await applyDeltaSnapshotChanges(docs, true, false);
              })
              .catch(() => {});
          }
        },
        (snapshotError) => {
          if (!isCurrent()) return;
          if (isMissingFirestoreIndexError(snapshotError)) {
            deltaQueryIndexMissing = true;
            isDeltaMode = false;
            serverSnapshotApplied = false;
            unsubscribe?.();
            unsubscribe = undefined;
            startFullListener();
            return;
          }
          const message =
            snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
          setError(message);
          setRefreshing(false);
          console.error('[ProductsContext] Error loading delta products snapshot:', snapshotError);
        }
      );
    };

    const hydrateCache = async (): Promise<void> => {
      if (!scopeChanged) {
        cacheLoadFinished = true;
        return;
      }
      try {
        const skipIntermediatePublish = Boolean(syncManifest && syncManifest.chunks <= 4);
        const cacheResult = await loadProductCatalogCache(catalogKVStorage, scopeKey, (chunk) => {
          if (!isCurrent() || (!isDeltaMode && serverSnapshotApplied)) return;
          for (let i = 0; i < chunk.length; i += 1) {
            const cachedProduct = chunk[i];
            if (!cachedProduct || !cachedProduct.id) continue;
            if (isDeletedProduct(cachedProduct)) continue;
            productMapRef.current.set(cachedProduct.id, cachedProduct);
            getIndexedCatalogProduct(cachedProduct);
            barcodeIndexRef.current.upsert(cachedProduct);
            inventoryIndexRef.current.upsert(cachedProduct);
            if (cachedProduct.active !== false) {
              catalogFilterIndexRef.current.upsert(cachedProduct);
            }
          }
          if (!skipIntermediatePublish && !cacheChunkPublished) {
            cacheChunkPublished = true;
            publishNow();
          }
        });
        if (!isCurrent()) return;
        if (!isDeltaMode && serverSnapshotApplied) {
          return;
        }
        if (cacheResult && !cacheResult.expired) {
          cacheHydrated = true;
          if (typeof cacheResult.lastSyncMs === 'number') {
            lastSyncMsRef.current = cacheResult.lastSyncMs;
          }
          if (typeof cacheResult.allDocsHaveUpdatedAt === 'boolean') {
            allDocsHaveUpdatedAtRef.current = cacheResult.allDocsHaveUpdatedAt;
          }
          publishNow();
          setInventorySummary(inventoryIndexRef.current.snapshot());
          setCatalogComplete(true);
          setRefreshing(false);
        } else {
          if (!cacheResult?.expired && productMapRef.current.size) {
            // A corrupt/incomplete cache must not leak partial stale data into an offline session.
            productMapRef.current.clear();
            barcodeIndexRef.current.clear();
            inventoryIndexRef.current.clear();
            catalogFilterIndexRef.current.clear();
            publishNow();
          }
          if (isDeltaMode && isCurrent()) {
            isDeltaMode = false;
            serverSnapshotApplied = false;
            unsubscribe?.();
            unsubscribe = undefined;
            startFullListener();
          }
        }
      } catch (cacheError) {
        if (isCurrent() && scopeChanged) {
          productMapRef.current.clear();
          barcodeIndexRef.current.clear();
          inventoryIndexRef.current.clear();
          catalogFilterIndexRef.current.clear();
          publishNow();
          if (isDeltaMode) {
            isDeltaMode = false;
            serverSnapshotApplied = false;
            unsubscribe?.();
            unsubscribe = undefined;
            startFullListener();
          }
        }
        console.warn('[ProductsContext] Could not load catalog cache:', cacheError);
      } finally {
        cacheLoadFinished = true;
      }
    };

    // Start MMKV hydration and Firestore network listener concurrently
    hydratePromise = hydrateCache();
    if (canStartDeltaSync) {
      startDeltaListener();
    } else {
      startFullListener();
    }

    return () => {
      if (effectGenerationRef.current === generation) effectGenerationRef.current += 1;
      if (deltaTimer) clearTimeout(deltaTimer);
      if (compactTimer) clearTimeout(compactTimer);
      if (coalescePublishTimer) clearTimeout(coalescePublishTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (deltaInteractionTask?.cancel) deltaInteractionTask.cancel();
      if (compactInteractionTask?.cancel) compactInteractionTask.cancel();
      appStateSubscription?.remove();
      unsubscribe?.();
      publishCatalogStateRef.current = () => {};
      scheduleDeltaFlushRef.current = () => {};
    };
  }, [accountId, activeCacheKey, mapSnapshotDoc, refreshTick, user?.uid]);

  const getProductById = useCallback((id: string): Product | undefined => {
    if (!id) return undefined;
    const scope = activeCacheKeyRef.current;
    if (!scope || activeScopeRef.current !== scope) return undefined;
    return productMapRef.current.get(id);
  }, []);

  const findByBarcode = useCallback((code: string): ScannedProductMatch | null => {
    if (!code) return null;
    const normalized = normalizeCode(code);
    if (!normalized) return null;

    const scope = activeCacheKeyRef.current;
    if (!scope || activeScopeRef.current !== scope) return null;

    if (barcodeIndexScopeRef.current === scope) {
      return barcodeIndexRef.current.get(normalized) || null;
    }

    const searchMatch = findProductByBarcode(Array.from(productMapRef.current.values()), code);
    return searchMatch || null;
  }, []);

  const findByBarcodeRemote = useCallback(
    async (code: string): Promise<ScannedProductMatch | null> => {
      const currentAccountId = accountIdRef.current;
      if (!currentAccountId || !code?.trim()) return null;
      const scope = activeCacheKeyRef.current;
      const localMatch =
        scope && barcodeIndexScopeRef.current === scope
          ? barcodeIndexRef.current.get(code)
          : findProductByBarcode(Array.from(productMapRef.current.values()), code);
      if (localMatch) return localMatch;
      if (
        catalogCompleteRef.current &&
        authoritativeSnapshotReadyRef.current &&
        !refreshingRef.current &&
        !errorRef.current
      ) {
        return null;
      }
      const { findByBarcodeRemote: findRemote } = await import(
        '@/services/inventory-kardex-service'
      );
      return findRemote(currentAccountId, code);
    },
    []
  );

  const isCurrentScopePublished = catalogComplete && hasMatchingScope;
  const stats = isCurrentScopePublished ? inventorySummary.stats : DEFAULT_STATS;
  const criticalAlerts = isCurrentScopePublished ? inventorySummary.alerts : EMPTY_ALERTS;
  const visibleCategories = hasMatchingScope ? categories : DEFAULT_CATEGORIES;

  // Monitoreo de stock crítico para alertas locales
  useEffect(() => {
    if (criticalAlerts.length > previousAlertCount.current && previousAlertCount.current > 0) {
      console.log(
        `[ProductsContext] Alerta: ${criticalAlerts.length} productos con stock crítico en sucursal ${effectiveBranchId}`
      );
    }
    previousAlertCount.current = criticalAlerts.length;
  }, [criticalAlerts.length, effectiveBranchId]);

  const getProductStockHelper = useCallback(
    (product: Product, branchIdOverride?: string): number => {
      const targetBranch = branchIdOverride || effectiveBranchIdRef.current;
      return getBranchStock(product, targetBranch);
    },
    []
  );

  const getProductAvailableStockHelper = useCallback(
    (product: Product, branchIdOverride?: string): number => {
      const targetBranch = branchIdOverride || effectiveBranchIdRef.current;
      return getAvailableStock(product, targetBranch);
    },
    []
  );

  const refreshProducts = useCallback(() => {
    forceFullRefreshRef.current = true;
    setRefreshing(true);
    setRefreshTick((t) => t + 1);
  }, []);

  const productPlanLimit = useMemo<ProductPlanLimitSummary | null>(
    () => computeProductPlanLimit(limits?.products, visibleProducts.length),
    [limits?.products, visibleProducts.length]
  );

  const validateProductCreation = useCallback(async (): Promise<ProductPlanValidationResult> => {
    const currentAccountId = accountIdRef.current;
    if (!currentAccountId) {
      return { allowed: false, reason: 'Cuenta no detectada.' };
    }

    const activeCount =
      activeScopeRef.current && activeScopeRef.current === activeCacheKeyRef.current
        ? productMapRef.current.size
        : 0;
    const planSummary = computeProductPlanLimit(limitsRef.current?.products, activeCount);

    if (isOnlineRef.current) {
      try {
        const res = await apiRequest<{
          allowed?: boolean;
          reason?: string;
          current?: number;
          max?: number;
          currentCount?: number;
          limit?: number;
        }>('/api/plan-limits/validate', {
          method: 'POST',
          body: { accountId: currentAccountId, operation: 'createProduct' },
        });
        const allowed = res?.allowed !== false;
        const current = res?.current ?? res?.currentCount ?? planSummary?.current;
        const max = res?.max ?? res?.limit ?? planSummary?.max;
        if (!allowed) {
          void refreshAccessRef.current?.().catch(() => {});
          return {
            allowed: false,
            reason:
              res?.reason ||
              (max
                ? `Alcanzaste el límite de ${max} productos de tu plan actual. Mejora tu plan para agregar más.`
                : 'Alcanzaste el límite de productos de tu plan actual.'),
            current,
            max,
          };
        }
        return { allowed: true, current, max };
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 403 || status === 402) {
          return {
            allowed: false,
            reason:
              err instanceof Error
                ? err.message
                : 'Alcanzaste el límite de productos de tu plan actual.',
          };
        }
      }
    }

    if (planSummary && planSummary.type === 'hard' && planSummary.isAtLimit) {
      return {
        allowed: false,
        reason: `Alcanzaste el límite de ${planSummary.max} productos de tu plan actual.`,
        current: planSummary.current,
        max: planSummary.max,
      };
    }

    return {
      allowed: true,
      current: planSummary?.current,
      max: planSummary?.max,
    };
  }, []);

  const actionsValue = useMemo<ProductsActionsContextType>(
    () => ({
      getProductById,
      findByBarcode,
      findByBarcodeRemote,
      getProductStock: getProductStockHelper,
      getProductAvailableStock: getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
      upsertProductsBatch,
      validateProductCreation,
    }),
    [
      getProductById,
      findByBarcode,
      findByBarcodeRemote,
      getProductStockHelper,
      getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
      upsertProductsBatch,
      validateProductCreation,
    ]
  );

  const contextValue = useMemo<ProductsContextType>(
    () => ({
      products: visibleProducts,
      productsById: visibleProductsById,
      catalogIndex,
      loading: visibleProducts.length === 0 && !catalogComplete && refreshing,
      refreshing,
      catalogComplete: catalogComplete && hasMatchingScope,
      error,
      categories: visibleCategories,
      stats,
      criticalAlerts,
      productPlanLimit,
      getProductById,
      findByBarcode,
      findByBarcodeRemote,
      getProductStock: getProductStockHelper,
      getProductAvailableStock: getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
      upsertProductsBatch,
      validateProductCreation,
    }),
    [
      visibleProducts,
      visibleProductsById,
      catalogIndex,
      catalogComplete,
      refreshing,
      hasMatchingScope,
      error,
      visibleCategories,
      stats,
      criticalAlerts,
      productPlanLimit,
      getProductById,
      findByBarcode,
      findByBarcodeRemote,
      getProductStockHelper,
      getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
      upsertProductsBatch,
      validateProductCreation,
    ]
  );

  return (
    <ProductsActionsContext.Provider value={actionsValue}>
      <ProductsContext.Provider value={contextValue}>{children}</ProductsContext.Provider>
    </ProductsActionsContext.Provider>
  );
};

export const useProducts = () => useContext(ProductsContext);
export const useProductsActions = () => useContext(ProductsActionsContext);
