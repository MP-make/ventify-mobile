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
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { catalogKVStorage } from '@/lib/native-kv-storage';
import { db } from '@/lib/firebase';
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
} from '@/lib/product-catalog-index';
import { getIndexedCatalogProduct } from '@/lib/catalog-filters';
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

export interface InventoryStats {
  totalProducts: number;
  skuCount: number;
  totalInventoryValue: number;
  valuation: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface ProductsContextType {
  products: Product[];
  loading: boolean;
  refreshing: boolean;
  catalogComplete: boolean;
  error: string | null;
  categories: string[];
  stats: InventoryStats;
  criticalAlerts: Array<{ productId: string; name: string; currentStock: number; minStock: number }>;
  findByBarcode: (code: string) => ScannedProductMatch | null;
  findByBarcodeRemote: (code: string) => Promise<ScannedProductMatch | null>;
  getProductStock: (product: Product, branchIdOverride?: string) => number;
  getProductAvailableStock: (product: Product, branchIdOverride?: string) => number;
  refreshProducts: () => void;
  upsertProduct: (product: Product) => void;
}

const DEFAULT_STATS: InventoryStats = {
  totalProducts: 0,
  skuCount: 0,
  totalInventoryValue: 0,
  valuation: 0,
  lowStockCount: 0,
  outOfStockCount: 0,
};

const ProductsContext = createContext<ProductsContextType>({
  products: [],
  loading: true,
  refreshing: false,
  catalogComplete: false,
  error: null,
  categories: ['Todos'],
  stats: DEFAULT_STATS,
  criticalAlerts: [],
  findByBarcode: () => null,
  findByBarcodeRemote: async () => null,
  getProductStock: () => 0,
  getProductAvailableStock: () => 0,
  refreshProducts: () => {},
  upsertProduct: () => {},
});

export const ProductsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, accountId, branchId } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [productsScopeKey, setProductsScopeKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [catalogComplete, setCatalogComplete] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(['Todos']);
  const [refreshTick, setRefreshTick] = useState<number>(0);
  const [inventorySummary, setInventorySummary] = useState<{
    stats: InventoryStats;
    alerts: Array<{ productId: string; name: string; currentStock: number; minStock: number }>;
  }>({ stats: DEFAULT_STATS, alerts: [] });

  const previousAlertCount = useRef<number>(0);
  const localRecentProductsRef = useRef<Map<string, Product>>(new Map());
  const productMapRef = useRef<Map<string, Product>>(new Map());
  const barcodeIndexRef = useRef(new ProductCatalogIndex());
  const inventoryIndexRef = useRef(new ProductCatalogInventoryIndex(branchId || 'main'));
  const categoryIndexRef = useRef(new ProductCatalogCategoryIndex());
  const barcodeIndexScopeRef = useRef<string | null>(null);
  const activeScopeRef = useRef<string | null>(null);
  const effectGenerationRef = useRef(0);
  const authoritativeSnapshotReadyRef = useRef(false);
  const cacheWriterRef = useRef<(nextProducts: Product[]) => void>(() => {});
  const catalogCompleteRef = useRef(catalogComplete);
  catalogCompleteRef.current = catalogComplete;

  const activeCacheKey = user?.uid && accountId
    ? productCatalogCacheKey(user.uid, accountId, branchId || 'main')
    : null;
  const visibleProducts = productsForCatalogScope(products, productsScopeKey, activeCacheKey);

  const upsertProduct = useCallback((product: Product) => {
    if (!product || !product.id) return;
    if (product.accountId && accountId && product.accountId !== accountId) return;
    if (!activeCacheKey || activeScopeRef.current !== activeCacheKey) return;
    localRecentProductsRef.current.set(product.id, product);
    getIndexedCatalogProduct(product);
    productMapRef.current.set(product.id, product);
    barcodeIndexRef.current.upsert(product);
    inventoryIndexRef.current.upsert(product);
    if (categoryIndexRef.current.upsert(product)) {
      setCategories(categoryIndexRef.current.snapshot());
    }
    const nextProducts = Array.from(productMapRef.current.values());
    setProductsScopeKey(activeCacheKey);
    setProducts((prev) => {
      const scoped = productsScopeKey === activeCacheKey ? prev : [];
      return [product, ...scoped.filter((p) => p.id !== product.id)];
    });
    if (catalogCompleteRef.current) {
      setInventorySummary(inventoryIndexRef.current.snapshot());
      setCategories(categoryIndexRef.current.snapshot());
      cacheWriterRef.current(nextProducts);
    }
  }, [accountId, activeCacheKey, catalogComplete, productsScopeKey]);

  const mapSnapshotDoc = useCallback(
      (docSnap: any): Product => {
        const data = docSnap.data();
        const baseCost = Number(data.costPrice ?? 0);
        const baseSuggested = Number(data.suggestedPrice ?? data.price ?? 0);
        const baseMin = Number(data.minSalePrice ?? baseCost);

        return {
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
          branchPrices: data.branchPrices || {},
          variants: Array.isArray(data.variants) ? data.variants : [],
          priceTiers: Array.isArray(data.priceTiers) ? data.priceTiers : [],
          imageUrl: data.imageUrl || '',
          thumbUrl: data.thumbUrl || data.imageUrl || '',
          hint: data.hint || '',
          unitOfMeasure: data.unitOfMeasure || 'unit',
          allowDecimals: Boolean(data.allowDecimals),
          stepDecimal: data.stepDecimal ? Number(data.stepDecimal) : undefined,
          active: data.active !== false,
          accountId: accountId || data.accountId || '',
          ...data,
          presentations: Array.isArray(data.presentations) ? data.presentations.map(normalizePresentation) : [],
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
      setProducts([]);
      setProductsScopeKey(null);
      setRefreshing(false);
      setCatalogComplete(false);
      setError(null);
      setInventorySummary({ stats: DEFAULT_STATS, alerts: [] });
      setCategories(['Todos']);
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
      inventoryIndexRef.current = new ProductCatalogInventoryIndex(branchId || 'main');
      categoryIndexRef.current.clear();
      localRecentProductsRef.current.clear();
      previousAlertCount.current = 0;
      setProducts([]);
      setProductsScopeKey(scopeKey);
      setCatalogComplete(false);
      setError(null);
      setInventorySummary({ stats: DEFAULT_STATS, alerts: [] });
      setCategories(['Todos']);
    }
    setRefreshing(true);

    let unsubscribe: (() => void) | undefined;
    let cacheTimer: ReturnType<typeof setTimeout> | undefined;
    let processing = Promise.resolve();
    let firstSnapshot = true;
    let cacheChunkPublished = false;
    let categoriesDirty = false;

    const publishMap = () => {
      if (!isCurrent()) return;
      setProductsScopeKey(scopeKey);
      setProducts(Array.from(productMapRef.current.values()));
      if (categoriesDirty) {
        categoriesDirty = false;
        setCategories(categoryIndexRef.current.snapshot());
      }
    };

    const upsertMapped = (product: Product) => {
      getIndexedCatalogProduct(product);
      productMapRef.current.set(product.id, product);
      barcodeIndexRef.current.upsert(product);
      inventoryIndexRef.current.upsert(product);
      categoriesDirty = categoryIndexRef.current.upsert(product) || categoriesDirty;
    };

    let interactionTask: { cancel?: () => void } | undefined;
    const scheduleCacheWrite = (sourceProducts?: Product[]) => {
      if (cacheTimer) clearTimeout(cacheTimer);
      if (interactionTask?.cancel) interactionTask.cancel();
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
      }, 1500);
    };
    cacheWriterRef.current = (nextProducts) => scheduleCacheWrite(nextProducts);

    const applySnapshotChanges = async (
      changes: any[],
      authoritativeDocs: any[],
      completesFirstSnapshot: boolean
    ) => {
      await processCatalogInBatches(changes, (batch) => {
        if (!isCurrent()) return;
        for (const change of batch) {
          const productId = change.doc.id;
          if (change.type === 'removed') {
            localRecentProductsRef.current.delete(productId);
            removeCatalogProduct(productMapRef.current, barcodeIndexRef.current, productId);
            inventoryIndexRef.current.remove(productId);
            categoriesDirty = categoryIndexRef.current.remove(productId) || categoriesDirty;
          } else {
            const mapped = mapSnapshotDoc(change.doc);
            localRecentProductsRef.current.delete(productId);
            upsertMapped(mapped);
          }
        }
      });

      if (!isCurrent()) return;
      if (completesFirstSnapshot) {
        const serverIds = new Set<string>();
        await processCatalogInBatches(authoritativeDocs, (batch) => {
          if (!isCurrent()) return;
          for (const docSnap of batch) {
            serverIds.add(docSnap.id);
            localRecentProductsRef.current.delete(docSnap.id);
            upsertMapped(mapSnapshotDoc(docSnap));
          }
        });
        await processCatalogIteratorInBatches(productMapRef.current.keys(), (batch) => {
          if (!isCurrent()) return;
          for (const productId of batch) {
            if (!shouldRetainCatalogProduct(productId, serverIds, localRecentProductsRef.current)) {
              removeCatalogProduct(productMapRef.current, barcodeIndexRef.current, productId);
              inventoryIndexRef.current.remove(productId);
              categoriesDirty = categoryIndexRef.current.remove(productId) || categoriesDirty;
            }
          }
        });
      }
      if (!isCurrent()) return;
      publishMap();
      if (completesFirstSnapshot) {
        // A cache entry represents a complete catalog only after Firestore's initial full snapshot.
        setCatalogComplete(true);
        authoritativeSnapshotReadyRef.current = true;
        setInventorySummary(inventoryIndexRef.current.snapshot());
        setRefreshing(false);
        setError(null);
        scheduleCacheWrite();
      } else if (catalogCompleteRef.current) {
        setInventorySummary(inventoryIndexRef.current.snapshot());
        scheduleCacheWrite();
      }
    };

    const startNetworkLoad = () => {
      if (!isCurrent()) return;
      const realtimeQuery = query(collection(db, 'products'), where('accountId', '==', accountId));
      unsubscribe = onSnapshot(
        realtimeQuery,
        (snapshot) => {
          if (!isCurrent()) return;
          const fromCache = snapshot.metadata?.fromCache === true;
          const allowOffline = productMapRef.current.size === 0;
          if (!isAuthoritativeCatalogSnapshot(fromCache, { allowOffline })) return;
          const completesFirstSnapshot = firstSnapshot;
          firstSnapshot = false;
          const changes = completesFirstSnapshot ? [] : snapshot.docChanges();
          processing = processing.then(() => applySnapshotChanges(
            changes,
            completesFirstSnapshot ? snapshot.docs : [],
            completesFirstSnapshot
          )).catch((processingError) => {
            if (!isCurrent()) return;
            const message = processingError instanceof Error ? processingError.message : String(processingError);
            setError(message);
            setRefreshing(false);
            console.error('[ProductsContext] Error processing products snapshot:', processingError);
          });
        },
        (snapshotError) => {
          if (!isCurrent()) return;
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
          const cacheResult = await loadProductCatalogCache(catalogKVStorage, scopeKey, async (chunk) => {
            if (!isCurrent()) return;
            await processCatalogInBatches(chunk, (batch) => {
              if (!isCurrent()) return;
              for (const cachedProduct of batch) {
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
          });
          if (!isCurrent()) return;
          if (cacheResult?.expired) {
            await catalogKVStorage.removeItem?.(`${scopeKey}:manifest`);
          } else if (cacheResult) {
            publishMap();
            setInventorySummary(inventoryIndexRef.current.snapshot());
            setCatalogComplete(true);
            setRefreshing(false);
          } else if (productMapRef.current.size) {
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
      if (interactionTask?.cancel) interactionTask.cancel();
      unsubscribe?.();
      cacheWriterRef.current = () => {};
    };
  }, [accountId, activeCacheKey, mapSnapshotDoc, refreshTick, user?.uid]);

  // 2. Construcción de Índice en Memoria Hash O(1) para Códigos de Barras y SKUs
  // 3. Búsqueda instantánea O(1) por código de barras
  const findByBarcode = useCallback(
    (code: string): ScannedProductMatch | null => {
      if (!code) return null;
      const normalized = normalizeCode(code);

      // Intento en O(1) con el Map hash
      const indexedMatch = barcodeIndexScopeRef.current === activeCacheKey
        ? barcodeIndexRef.current.get(normalized)
        : undefined;
      if (indexedMatch) return indexedMatch;

      // Fallback a motor exhaustivo de product-search usando productMapRef para mantener identidad de función estable
      const searchMatch = findProductByBarcode(Array.from(productMapRef.current.values()), code);
      return searchMatch || null;
    },
    [activeCacheKey]
  );

  const findByBarcodeRemote = useCallback(async (code: string): Promise<ScannedProductMatch | null> => {
    if (!accountId || !code?.trim()) return null;
    const indexedMatch = barcodeIndexScopeRef.current === activeCacheKey
      ? barcodeIndexRef.current.get(code)
      : undefined;
    const localMatch = indexedMatch || findProductByBarcode(Array.from(productMapRef.current.values()), code);
    if (localMatch) return localMatch;
    if (catalogComplete && authoritativeSnapshotReadyRef.current && !refreshing && !error) return null;
    const { findByBarcodeRemote: findRemote } = await import('@/services/inventory-kardex-service');
    return findRemote(accountId, code);
  }, [accountId, activeCacheKey, catalogComplete, error, refreshing]);

  // Product changes adjust categories and stock KPIs incrementally.
  const stats = catalogComplete && productsScopeKey === activeCacheKey
    ? inventorySummary.stats
    : DEFAULT_STATS;
  const criticalAlerts = catalogComplete && productsScopeKey === activeCacheKey
    ? inventorySummary.alerts
    : [];
  const visibleCategories = productsScopeKey === activeCacheKey ? categories : ['Todos'];

  // 6. Monitoreo de stock crítico para alertas locales
  useEffect(() => {
    if (criticalAlerts.length > previousAlertCount.current && previousAlertCount.current > 0) {
      console.log(`[ProductsContext] Alerta: ${criticalAlerts.length} productos con stock crítico en sucursal ${branchId}`);
    }
    previousAlertCount.current = criticalAlerts.length;
  }, [criticalAlerts.length, branchId]);

  // 7. Helpers de stock por sucursal
  const getProductStockHelper = useCallback(
    (product: Product, branchIdOverride?: string): number => {
      const targetBranch = branchIdOverride || branchId || 'main';
      return getBranchStock(product, targetBranch);
    },
    [branchId]
  );

  const getProductAvailableStockHelper = useCallback(
    (product: Product, branchIdOverride?: string): number => {
      const targetBranch = branchIdOverride || branchId || 'main';
      return getAvailableStock(product, targetBranch);
    },
    [branchId]
  );

  const refreshProducts = useCallback(() => {
    setRefreshing(true);
    setRefreshTick((t) => t + 1);
  }, []);

  const contextValue = useMemo(
    () => ({
      products: visibleProducts,
      loading: visibleProducts.length === 0 && !catalogComplete && refreshing,
      refreshing,
      catalogComplete: catalogComplete && productsScopeKey === activeCacheKey,
      error,
      categories: visibleCategories,
      stats,
      criticalAlerts,
      findByBarcode,
      findByBarcodeRemote,
      getProductStock: getProductStockHelper,
      getProductAvailableStock: getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
    }),
    [
      visibleProducts,
      catalogComplete,
      refreshing,
      productsScopeKey,
      activeCacheKey,
      error,
      visibleCategories,
      stats,
      criticalAlerts,
      findByBarcode,
      findByBarcodeRemote,
      getProductStockHelper,
      getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
    ]
  );

  return <ProductsContext.Provider value={contextValue}>{children}</ProductsContext.Provider>;
};

export const useProducts = () => useContext(ProductsContext);
