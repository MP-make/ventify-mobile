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
import { InteractionManager } from 'react-native';
import { collection, query, where, onSnapshot, getDocs, limit } from 'firebase/firestore';
import NetInfo from '@react-native-community/netinfo';
import { catalogKVStorage } from '@/lib/native-kv-storage';
import { db } from '@/lib/firebase';
import { apiRequest } from '@/lib/api-client';
import { useAuth } from './AuthContext';
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
  ProductCatalogCategoryIndex,
  removeCatalogProduct,
  type CatalogInventoryAlert,
} from '@/lib/product-catalog-index';
import {
  buildCatalogProductIndex,
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
  loadProductCatalogCache,
  productCatalogCacheKey,
  writeProductCatalogCache,
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

export interface ProductsContextType {
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

function shallowRecordNumbersEqual(
  a: Record<string, number> | undefined | null,
  b: Record<string, number> | undefined | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const k = keysA[i];
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function productsDifferForCache(prev: Product | undefined, next: Product): boolean {
  if (!prev) return true;
  if (
    prev.name !== next.name ||
    prev.category !== next.category ||
    prev.sku !== next.sku ||
    prev.barcode !== next.barcode ||
    prev.costPrice !== next.costPrice ||
    prev.suggestedPrice !== next.suggestedPrice ||
    prev.price !== next.price ||
    prev.minSalePrice !== next.minSalePrice ||
    prev.imageUrl !== next.imageUrl ||
    prev.thumbUrl !== next.thumbUrl ||
    prev.active !== next.active ||
    prev.brand !== next.brand ||
    prev.sizeLabel !== next.sizeLabel ||
    prev.unitOfMeasure !== next.unitOfMeasure ||
    prev.allowDecimals !== next.allowDecimals ||
    prev.stepDecimal !== next.stepDecimal ||
    prev.taxExemptionCode !== next.taxExemptionCode ||
    (prev as any).updatedAt !== (next as any).updatedAt
  ) {
    return true;
  }
  if (
    !shallowRecordNumbersEqual(prev.stock, next.stock) ||
    !shallowRecordNumbersEqual(prev.reservedStock, next.reservedStock)
  ) {
    return true;
  }
  if (
    (prev.barcodes?.length || 0) !== (next.barcodes?.length || 0) ||
    (prev.presentations?.length || 0) !== (next.presentations?.length || 0) ||
    (prev.variants?.length || 0) !== (next.variants?.length || 0) ||
    (prev.priceTiers?.length || 0) !== (next.priceTiers?.length || 0) ||
    (prev.galleryImages?.length || 0) !== (next.galleryImages?.length || 0)
  ) {
    return true;
  }
  try {
    return (
      JSON.stringify(prev.barcodes) !== JSON.stringify(next.barcodes) ||
      JSON.stringify(prev.presentations) !== JSON.stringify(next.presentations) ||
      JSON.stringify(prev.variants) !== JSON.stringify(next.variants) ||
      JSON.stringify(prev.branchPrices) !== JSON.stringify(next.branchPrices) ||
      JSON.stringify(prev.priceTiers) !== JSON.stringify(next.priceTiers) ||
      JSON.stringify(prev.attributes) !== JSON.stringify(next.attributes)
    );
  } catch {
    return true;
  }
}

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
  const { user, accountId, branchId, limits, isOnline, refreshAccess } = useAuth();
  const [productsState, setProductsState] = useState<{
    products: Product[];
    byId: ReadonlyMap<string, Product>;
    scopeKey: string | null;
  }>({
    products: EMPTY_PRODUCTS,
    byId: EMPTY_PRODUCT_MAP,
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
  const localRecentProductsRef = useRef<Map<string, Product>>(new Map());
  const productMapRef = useRef<Map<string, Product>>(new Map());
  const barcodeIndexRef = useRef(new ProductCatalogIndex());
  const inventoryIndexRef = useRef(new ProductCatalogInventoryIndex(effectiveBranchId));
  const categoryIndexRef = useRef(new ProductCatalogCategoryIndex());
  const barcodeIndexScopeRef = useRef<string | null>(null);
  const activeScopeRef = useRef<string | null>(null);
  const effectGenerationRef = useRef(0);
  const authoritativeSnapshotReadyRef = useRef(false);
  const cacheWriterRef = useRef<(nextProducts?: Product[], incremental?: boolean) => void>(() => {});
  const catalogCompleteRef = useRef(catalogComplete);
  catalogCompleteRef.current = catalogComplete;

  // Account-scoped cache key so branch switches only recompute branch stock KPIs in memory
  const activeCacheKey = user?.uid && accountId
    ? productCatalogCacheKey(user.uid, accountId, 'account')
    : null;

  const visibleProducts = productsForCatalogScope(
    productsState.products,
    productsState.scopeKey,
    activeCacheKey
  );
  const visibleProductsById =
    productsState.scopeKey && productsState.scopeKey === activeCacheKey
      ? productsState.byId
      : EMPTY_PRODUCT_MAP;

  const catalogIndex = useMemo<CatalogProductIndex>(
    () => (visibleProducts.length === 0 ? EMPTY_CATALOG_INDEX : buildCatalogProductIndex(visibleProducts)),
    [visibleProducts]
  );

  // Recompute only branch inventory KPIs when branchId changes without tearing down Firestore/MMKV
  useEffect(() => {
    if (branchIdRef.current === effectiveBranchId) return;
    branchIdRef.current = effectiveBranchId;
    const nextIndex = new ProductCatalogInventoryIndex(effectiveBranchId);
    for (const product of productMapRef.current.values()) {
      nextIndex.upsert(product);
    }
    inventoryIndexRef.current = nextIndex;
    if (catalogCompleteRef.current && activeScopeRef.current === activeCacheKey) {
      setInventorySummary(nextIndex.snapshot());
    }
  }, [effectiveBranchId, activeCacheKey]);

  const upsertProductsBatch = useCallback(
    (items: Product[]) => {
      if (!items || items.length === 0) return;
      if (!activeCacheKey || activeScopeRef.current !== activeCacheKey) return;

      let categoryChanged = false;
      let updatedCount = 0;

      for (let i = 0; i < items.length; i += 1) {
        const product = items[i];
        if (!product || !product.id) continue;
        if (product.accountId && accountId && product.accountId !== accountId) continue;

        localRecentProductsRef.current.set(product.id, product);
        getIndexedCatalogProduct(product);
        productMapRef.current.set(product.id, product);
        barcodeIndexRef.current.upsert(product);
        inventoryIndexRef.current.upsert(product);
        if (categoryIndexRef.current.upsert(product)) {
          categoryChanged = true;
        }
        updatedCount += 1;
      }

      if (updatedCount === 0) return;

      const nextProducts = Array.from(productMapRef.current.values());
      const nextById = new Map(productMapRef.current);
      setProductsState({ products: nextProducts, byId: nextById, scopeKey: activeCacheKey });
      if (categoryChanged) {
        setCategories(categoryIndexRef.current.snapshot());
      }
      if (catalogCompleteRef.current) {
        setInventorySummary(inventoryIndexRef.current.snapshot());
        cacheWriterRef.current(nextProducts, true);
      }
    },
    [accountId, activeCacheKey]
  );

  const upsertProduct = useCallback(
    (product: Product) => {
      upsertProductsBatch([product]);
    },
    [upsertProductsBatch]
  );

  const mapSnapshotDoc = useCallback(
    (docSnap: any): Product => {
      const data = docSnap.data();
      const baseCost = Number(data.costPrice ?? 0);
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
        typeof data.imageUrl === 'string' && data.imageUrl.trim() && sanitizedGallery.includes(data.imageUrl.trim())
          ? data.imageUrl.trim()
          : sanitizedGallery[0] || (typeof data.imageUrl === 'string' ? data.imageUrl : '');

      return {
        ...data,
        id: docSnap.id,
        name: data.name || 'Sin nombre',
        category: data.category || 'General',
        sku: data.sku || '',
        barcode: data.barcode || '',
        barcodes: Array.isArray(data.barcodes) ? data.barcodes : [],
        costPrice: baseCost,
        suggestedPrice: baseSuggested,
        price: baseSuggested,
        minSalePrice: baseMin,
        stock: typeof data.stock === 'object' && data.stock !== null ? data.stock : {},
        reservedStock:
          typeof data.reservedStock === 'object' && data.reservedStock !== null
            ? data.reservedStock
            : {},
        branchIds: Array.isArray(data.branchIds) ? data.branchIds : [],
        lowStockBranches: Array.isArray(data.lowStockBranches) ? data.lowStockBranches : [],
        branchPrices:
          typeof data.branchPrices === 'object' && data.branchPrices !== null
            ? data.branchPrices
            : {},
        variants: Array.isArray(data.variants) ? data.variants : [],
        priceTiers: Array.isArray(data.priceTiers) ? normalizePriceTiers(data.priceTiers) : [],
        presentations: Array.isArray(data.presentations)
          ? data.presentations.map(normalizePresentation)
          : [],
        galleryImages: sanitizedGallery,
        attributes:
          typeof data.attributes === 'object' && data.attributes !== null
            ? data.attributes
            : {},
        taxExemptionCode: data.taxExemptionCode || '10',
        imageUrl: safeImageUrl,
        thumbUrl: data.thumbUrl || safeImageUrl || '',
        hint: data.hint || '',
        unitOfMeasure: data.unitOfMeasure || 'unit',
        allowDecimals: Boolean(data.allowDecimals),
        stepDecimal: data.stepDecimal ? Number(data.stepDecimal) : undefined,
        active: data.active !== false,
        accountId: accountId || data.accountId || '',
      };
    },
    [accountId]
  );

  // Cache complete snapshots first, then load a small network batch and reconcile one full listener.
  useEffect(() => {
    const scopeKey = activeCacheKey;
    const generation = ++effectGenerationRef.current;
    const isCurrent = () => effectGenerationRef.current === generation && activeScopeRef.current === scopeKey;
    if (!user?.uid || !accountId || !scopeKey) {
      activeScopeRef.current = null;
      authoritativeSnapshotReadyRef.current = false;
      barcodeIndexScopeRef.current = null;
      productMapRef.current.clear();
      barcodeIndexRef.current.clear();
      inventoryIndexRef.current.clear();
      categoryIndexRef.current.clear();
      localRecentProductsRef.current.clear();
      previousAlertCount.current = 0;
      setProductsState({ products: EMPTY_PRODUCTS, byId: EMPTY_PRODUCT_MAP, scopeKey: null });
      setRefreshing(false);
      setCatalogComplete(false);
      setError(null);
      setInventorySummary({ stats: DEFAULT_STATS, alerts: EMPTY_ALERTS });
      setCategories(DEFAULT_CATEGORIES);
      cacheWriterRef.current = () => {};
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
      categoryIndexRef.current.clear();
      localRecentProductsRef.current.clear();
      previousAlertCount.current = 0;
      setProductsState({ products: EMPTY_PRODUCTS, byId: EMPTY_PRODUCT_MAP, scopeKey });
      setCatalogComplete(false);
      setError(null);
      setInventorySummary({ stats: DEFAULT_STATS, alerts: EMPTY_ALERTS });
      setCategories(DEFAULT_CATEGORIES);
    }
    setRefreshing(true);

    let unsubscribe: (() => void) | undefined;
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    let processing = Promise.resolve();
    let cacheChunkPublished = false;
    let cacheHydrated = false;
    let categoriesDirty = false;
    let publishedOnce = false;

    const publishMap = () => {
      if (!isCurrent()) return;
      publishedOnce = true;
      setProductsState({
        products: Array.from(productMapRef.current.values()),
        byId: new Map(productMapRef.current),
        scopeKey,
      });
      if (categoriesDirty) {
        categoriesDirty = false;
        setCategories(categoryIndexRef.current.snapshot());
      }
    };

    const upsertMapped = (product: Product): boolean => {
      const existing = productMapRef.current.get(product.id);
      if (existing && !productsDifferForCache(existing, product)) {
        return false;
      }
      getIndexedCatalogProduct(product);
      productMapRef.current.set(product.id, product);
      barcodeIndexRef.current.upsert(product);
      inventoryIndexRef.current.upsert(product);
      categoriesDirty = categoryIndexRef.current.upsert(product) || categoriesDirty;
      return true;
    };

    let interactionTask: { cancel?: () => void } | undefined;
    const scheduleCacheWrite = (sourceProducts?: Product[], incremental = false) => {
      if (cacheTimer) clearTimeout(cacheTimer);
      if (interactionTask?.cancel) interactionTask.cancel();
      const delayMs = incremental ? 8000 : 1500;
      cacheTimer = setTimeout(() => {
        interactionTask = InteractionManager.runAfterInteractions(() => {
          if (!isCurrent()) return;
          const toPersist = sourceProducts || Array.from(productMapRef.current.values());
          const cacheGeneration = `${Date.now()}-${generation}-${Math.random().toString(36).slice(2, 8)}`;
          writeProductCatalogCache(catalogKVStorage, scopeKey, toPersist, {
            generation: cacheGeneration,
            isCurrent,
          }).catch((cacheError) => {
            console.warn('[ProductsContext] Could not persist catalog cache:', cacheError);
          });
        });
      }, delayMs);
    };
    cacheWriterRef.current = (nextProducts, incremental = true) =>
      scheduleCacheWrite(nextProducts, incremental);

    let serverSnapshotApplied = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let latestCachedDocs: any[] | null = null;

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
              if (productMapRef.current.has(productId)) {
                removeCatalogProduct(productMapRef.current, barcodeIndexRef.current, productId);
                inventoryIndexRef.current.remove(productId);
                categoriesDirty = categoryIndexRef.current.remove(productId) || categoriesDirty;
                dirtyCount += 1;
              }
            } else {
              const mapped = mapSnapshotDoc(change.doc);
              localRecentProductsRef.current.delete(productId);
              if (upsertMapped(mapped)) {
                dirtyCount += 1;
              }
            }
          }
        });
      }

      if (!isCurrent()) return;
      if (completesFirstSnapshot && isServerAuthoritative) {
        const serverIds = new Set<string>();
        let publishedFirstNetBatch = productMapRef.current.size > 0;
        await processCatalogInBatches(authoritativeDocs, (batch) => {
          if (!isCurrent()) return;
          for (const docSnap of batch) {
            serverIds.add(docSnap.id);
            localRecentProductsRef.current.delete(docSnap.id);
            if (upsertMapped(mapSnapshotDoc(docSnap))) {
              dirtyCount += 1;
            }
          }
          if (!publishedFirstNetBatch && productMapRef.current.size > 0) {
            publishedFirstNetBatch = true;
            publishMap();
          }
        });
        await processCatalogIteratorInBatches(productMapRef.current.keys(), (batch) => {
          if (!isCurrent()) return;
          for (const productId of batch) {
            if (!shouldRetainCatalogProduct(productId, serverIds, localRecentProductsRef.current)) {
              removeCatalogProduct(productMapRef.current, barcodeIndexRef.current, productId);
              inventoryIndexRef.current.remove(productId);
              categoriesDirty = categoryIndexRef.current.remove(productId) || categoriesDirty;
              dirtyCount += 1;
            }
          }
        });
      } else if (completesFirstSnapshot) {
        await processCatalogInBatches(authoritativeDocs, (batch) => {
          if (!isCurrent()) return;
          for (const docSnap of batch) {
            if (upsertMapped(mapSnapshotDoc(docSnap))) {
              dirtyCount += 1;
            }
          }
        });
      }
      if (!isCurrent()) return;
      if (dirtyCount > 0 || !publishedOnce) {
        publishMap();
      }
      if (completesFirstSnapshot) {
        setCatalogComplete(true);
        if (isServerAuthoritative) {
          authoritativeSnapshotReadyRef.current = true;
        }
        if (dirtyCount > 0 || !cacheHydrated) {
          setInventorySummary(inventoryIndexRef.current.snapshot());
        }
        setRefreshing(false);
        setError(null);
        if (isServerAuthoritative && (dirtyCount > 0 || !cacheHydrated)) {
          scheduleCacheWrite(undefined, false);
        }
      } else if (catalogCompleteRef.current && dirtyCount > 0) {
        setInventorySummary(inventoryIndexRef.current.snapshot());
        if (isServerAuthoritative) {
          scheduleCacheWrite(undefined, true);
        }
      }
    };

    const startNetworkLoad = () => {
      if (!isCurrent()) return;
      const realtimeQuery = query(collection(db, 'products'), where('accountId', '==', accountId));
      if (productMapRef.current.size === 0) {
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
              publishMap();
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
            processing = processing
              .then(() =>
                applySnapshotChanges(
                  changes,
                  isFirstServerSnapshot ? snapshot.docs : [],
                  isFirstServerSnapshot,
                  true
                )
              )
              .catch((processingError) => {
                if (!isCurrent()) return;
                const message =
                  processingError instanceof Error ? processingError.message : String(processingError);
                setError(message);
                setRefreshing(false);
                console.error('[ProductsContext] Error processing products snapshot:', processingError);
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
            processing = processing
              .then(() => applySnapshotChanges([], snapshot.docs, true, false))
              .catch((processingError) => {
                if (!isCurrent()) return;
                const message =
                  processingError instanceof Error ? processingError.message : String(processingError);
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
              const stillOffline = net ? !(net.isConnected && net.isInternetReachable !== false) : !isOnlineRef.current;
              if (stillOffline && latestCachedDocs) {
                processing = processing
                  .then(() => applySnapshotChanges([], latestCachedDocs || [], true, false))
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
          const message = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
          setError(message);
          setRefreshing(false);
          console.error('[ProductsContext] Error loading products snapshot:', snapshotError);
        }
      );
    };

    const hydrateCache = async () => {
      if (scopeChanged) {
        try {
          const cacheResult = await loadProductCatalogCache(catalogKVStorage, scopeKey, (chunk) => {
            if (!isCurrent()) return;
            for (let i = 0; i < chunk.length; i += 1) {
              const cachedProduct = chunk[i];
              productMapRef.current.set(cachedProduct.id, cachedProduct);
              getIndexedCatalogProduct(cachedProduct);
              barcodeIndexRef.current.upsert(cachedProduct);
              inventoryIndexRef.current.upsert(cachedProduct);
              categoriesDirty = categoryIndexRef.current.upsert(cachedProduct) || categoriesDirty;
            }
            if (!cacheChunkPublished) {
              cacheChunkPublished = true;
              publishMap();
            }
          });
          if (!isCurrent()) return;
          if (cacheResult && !cacheResult.expired) {
            cacheHydrated = true;
            publishMap();
            setInventorySummary(inventoryIndexRef.current.snapshot());
            setCatalogComplete(true);
            setRefreshing(false);
          } else if (!cacheResult?.expired && productMapRef.current.size) {
            // A corrupt/incomplete cache must not leak partial stale data into an offline session.
            productMapRef.current.clear();
            barcodeIndexRef.current.clear();
            inventoryIndexRef.current.clear();
            categoryIndexRef.current.clear();
            publishMap();
          }
        } catch (cacheError) {
          if (isCurrent() && scopeChanged) {
            productMapRef.current.clear();
            barcodeIndexRef.current.clear();
            inventoryIndexRef.current.clear();
            categoryIndexRef.current.clear();
            publishMap();
          }
          console.warn('[ProductsContext] Could not load catalog cache:', cacheError);
        }
      }
      if (isCurrent()) void startNetworkLoad();
    };

    void hydrateCache();

    return () => {
      if (effectGenerationRef.current === generation) effectGenerationRef.current += 1;
      if (cacheTimer) clearTimeout(cacheTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (interactionTask?.cancel) interactionTask.cancel();
      unsubscribe?.();
      cacheWriterRef.current = () => {};
    };
  }, [accountId, activeCacheKey, mapSnapshotDoc, refreshTick, user?.uid]);

  const getProductById = useCallback(
    (id: string): Product | undefined => {
      if (!id) return undefined;
      return visibleProductsById.get(id);
    },
    [visibleProductsById]
  );

  // 2. Construcción de Índice en Memoria Hash O(1) para Códigos de Barras y SKUs
  // 3. Búsqueda instantánea O(1) por código de barras
  const findByBarcode = useCallback(
    (code: string): ScannedProductMatch | null => {
      if (!code) return null;
      const normalized = normalizeCode(code);
      if (!normalized) return null;

      if (barcodeIndexScopeRef.current === activeCacheKey) {
        return barcodeIndexRef.current.get(normalized) || null;
      }

      const searchMatch = findProductByBarcode(Array.from(productMapRef.current.values()), code);
      return searchMatch || null;
    },
    [activeCacheKey]
  );

  const findByBarcodeRemote = useCallback(async (code: string): Promise<ScannedProductMatch | null> => {
    if (!accountId || !code?.trim()) return null;
    const localMatch = barcodeIndexScopeRef.current === activeCacheKey
      ? barcodeIndexRef.current.get(code)
      : findProductByBarcode(Array.from(productMapRef.current.values()), code);
    if (localMatch) return localMatch;
    if (catalogComplete && authoritativeSnapshotReadyRef.current && !refreshing && !error) return null;
    const { findByBarcodeRemote: findRemote } = await import('@/services/inventory-kardex-service');
    return findRemote(accountId, code);
  }, [accountId, activeCacheKey, catalogComplete, error, refreshing]);

  const isCurrentScopePublished = catalogComplete && productsState.scopeKey === activeCacheKey;
  const stats = isCurrentScopePublished ? inventorySummary.stats : DEFAULT_STATS;
  const criticalAlerts = isCurrentScopePublished ? inventorySummary.alerts : EMPTY_ALERTS;
  const visibleCategories = productsState.scopeKey === activeCacheKey ? categories : DEFAULT_CATEGORIES;

  // 6. Monitoreo de stock crítico para alertas locales
  useEffect(() => {
    if (criticalAlerts.length > previousAlertCount.current && previousAlertCount.current > 0) {
      console.log(`[ProductsContext] Alerta: ${criticalAlerts.length} productos con stock crítico en sucursal ${effectiveBranchId}`);
    }
    previousAlertCount.current = criticalAlerts.length;
  }, [criticalAlerts.length, effectiveBranchId]);

  // 7. Helpers de stock por sucursal
  const getProductStockHelper = useCallback(
    (product: Product, branchIdOverride?: string): number => {
      const targetBranch = branchIdOverride || effectiveBranchId;
      return getBranchStock(product, targetBranch);
    },
    [effectiveBranchId]
  );

  const getProductAvailableStockHelper = useCallback(
    (product: Product, branchIdOverride?: string): number => {
      const targetBranch = branchIdOverride || effectiveBranchId;
      return getAvailableStock(product, targetBranch);
    },
    [effectiveBranchId]
  );

  const refreshProducts = useCallback(() => {
    setRefreshing(true);
    setRefreshTick((t) => t + 1);
  }, []);

  const productPlanLimit = useMemo<ProductPlanLimitSummary | null>(() => {
    const entry = limits?.products;
    if (!entry) return null;
    const max = Number(entry.max ?? 0);
    if (max <= 0) {
      return {
        current: visibleProducts.length || Number(entry.current ?? 0),
        max: 0,
        type: entry.type || 'soft',
        isAtLimit: false,
        isNearLimit: false,
      };
    }
    const current = Math.max(Number(entry.current ?? 0), visibleProducts.length);
    return {
      current,
      max,
      type: entry.type || 'soft',
      isAtLimit: current >= max,
      isNearLimit: current >= Math.floor(max * 0.8) && current < max,
    };
  }, [limits?.products, visibleProducts.length]);

  const validateProductCreation = useCallback(async (): Promise<ProductPlanValidationResult> => {
    if (!accountId) {
      return { allowed: false, reason: 'Cuenta no detectada.' };
    }

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
          body: { accountId, operation: 'createProduct' },
        });
        const allowed = res?.allowed !== false;
        const current = res?.current ?? res?.currentCount ?? productPlanLimit?.current;
        const max = res?.max ?? res?.limit ?? productPlanLimit?.max;
        if (!allowed) {
          void refreshAccess?.().catch(() => {});
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

    if (productPlanLimit && productPlanLimit.type === 'hard' && productPlanLimit.isAtLimit) {
      return {
        allowed: false,
        reason: `Alcanzaste el límite de ${productPlanLimit.max} productos de tu plan actual.`,
        current: productPlanLimit.current,
        max: productPlanLimit.max,
      };
    }

    return {
      allowed: true,
      current: productPlanLimit?.current,
      max: productPlanLimit?.max,
    };
  }, [accountId, productPlanLimit, refreshAccess]);

  const contextValue = useMemo<ProductsContextType>(
    () => ({
      products: visibleProducts,
      productsById: visibleProductsById,
      catalogIndex,
      loading: visibleProducts.length === 0 && !catalogComplete && refreshing,
      refreshing,
      catalogComplete: catalogComplete && productsState.scopeKey === activeCacheKey,
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
      productsState.scopeKey,
      activeCacheKey,
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

  return <ProductsContext.Provider value={contextValue}>{children}</ProductsContext.Provider>;
};

export const useProducts = () => useContext(ProductsContext);
