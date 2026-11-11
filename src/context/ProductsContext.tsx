import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import { collection, query, where, onSnapshot, getDocs, limit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from './AuthContext';
import { Product, ProductPresentation, ProductVariant } from '@/types';
import {
  findProductByBarcode,
  getBranchStock,
  getAvailableStock,
  getAllPresentations,
  normalizeCode,
  ScannedProductMatch,
} from '@/lib/product-search';

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
  categories: string[];
  stats: InventoryStats;
  criticalAlerts: Array<{ productId: string; name: string; currentStock: number; minStock: number }>;
  findByBarcode: (code: string) => ScannedProductMatch | null;
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
  categories: ['Todos'],
  stats: DEFAULT_STATS,
  criticalAlerts: [],
  findByBarcode: () => null,
  getProductStock: () => 0,
  getProductAvailableStock: () => 0,
  refreshProducts: () => {},
  upsertProduct: () => {},
});

export const ProductsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { accountId, branchId } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshTick, setRefreshTick] = useState<number>(0);
  const [criticalAlerts, setCriticalAlerts] = useState<
    Array<{ productId: string; name: string; currentStock: number; minStock: number }>
  >([]);

  const previousAlertCount = useRef<number>(0);
  const localRecentProductsRef = useRef<Map<string, Product>>(new Map());

  const upsertProduct = useCallback((product: Product) => {
    if (!product || !product.id) return;
    localRecentProductsRef.current.set(product.id, product);
    setProducts((prev) => {
      const filtered = prev.filter((p) => p.id !== product.id);
      return [product, ...filtered];
    });
  }, []);

  const mapSnapshotDocs = useCallback(
    (docs: any[]): Product[] =>
      docs.map((docSnap) => {
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
          presentations: Array.isArray(data.presentations) ? data.presentations : [],
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
        };
      }),
    [accountId]
  );

  // 1. Carga progresiva en 2 etapas (Etapa 1: 150 productos en <300ms + Etapa 2: Catálogo ampliado en tiempo real)
  useEffect(() => {
    if (!accountId) {
      setProducts([]);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);

    const mergeWithLocals = (incoming: Product[]): Product[] => {
      const incomingIds = new Set(incoming.map((p) => p.id));
      const locals: Product[] = [];
      for (const [id, localProd] of localRecentProductsRef.current.entries()) {
        if (!incomingIds.has(id)) {
          locals.push(localProd);
        }
      }
      return [...locals, ...incoming];
    };

    // Etapa 1: Carga rápida de los primeros 150 productos vía HTTP RPC para que cuentas con 8,000+ SKUs (ej. demo@ventify.pe) pinten en <300ms
    const fastQuery = query(
      collection(db, 'products'),
      where('accountId', '==', accountId),
      limit(150)
    );

    getDocs(fastQuery)
      .then((snap) => {
        if (!isMounted) return;
        const mapped = mapSnapshotDocs(snap.docs);
        setProducts((prev) => (prev.length > snap.docs.length ? prev : mergeWithLocals(mapped)));
        setLoading(false);
      })
      .catch((err) => {
        console.warn('[ProductsContext] Initial fast getDocs warning:', err);
        if (isMounted) setLoading(false);
      });

    // Etapa 2: Sincronización en tiempo real ampliada a 1200 productos para fluidez en móvil
    const realtimeQuery = query(
      collection(db, 'products'),
      where('accountId', '==', accountId),
      limit(1200)
    );

    const unsubscribe = onSnapshot(
      realtimeQuery,
      (snapshot) => {
        if (!isMounted) return;
        setProducts(mergeWithLocals(mapSnapshotDocs(snapshot.docs)));
        setLoading(false);
      },
      (err) => {
        console.error('[ProductsContext] Error loading products snapshot:', err);
        if (isMounted) setLoading(false);
      }
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [accountId, refreshTick, mapSnapshotDocs]);

  // 2. Construcción de Índice en Memoria Hash O(1) para Códigos de Barras y SKUs
  const barcodeIndex = useMemo(() => {
    const map = new Map<string, ScannedProductMatch>();

    for (const prod of products) {
      if (prod.active === false) continue;

      // 1. Código de barras principal
      if (prod.barcode) {
        const norm = normalizeCode(prod.barcode);
        if (norm) map.set(norm, { product: prod });
      }

      // 2. SKU principal
      if (prod.sku) {
        const norm = normalizeCode(prod.sku);
        if (norm && !map.has(norm)) map.set(norm, { product: prod });
      }

      // 3. Códigos de barras alternativos o secundarios
      if (Array.isArray(prod.barcodes)) {
        for (const altCode of prod.barcodes) {
          const norm = normalizeCode(altCode);
          if (norm && !map.has(norm)) map.set(norm, { product: prod });
        }
      }

      // 4. Códigos de barras de presentaciones (caja x24, pack x6, etc.)
      const presentations = getAllPresentations(prod);
      for (const pres of presentations) {
        if (pres.barcode) {
          const norm = normalizeCode(pres.barcode);
          if (norm) {
            map.set(norm, { product: prod, matchedPresentation: pres });
          }
        }
      }

      // 5. Códigos de barras o SKUs de variantes (talla / color)
      if (Array.isArray(prod.variants)) {
        for (const variant of prod.variants) {
          if (variant.barcode) {
            const norm = normalizeCode(variant.barcode);
            if (norm) {
              map.set(norm, { product: prod, matchedVariant: variant });
            }
          }
          if (variant.sku) {
            const norm = normalizeCode(variant.sku);
            if (norm && !map.has(norm)) {
              map.set(norm, { product: prod, matchedVariant: variant });
            }
          }
        }
      }
    }

    return map;
  }, [products]);

  // 3. Búsqueda instantánea O(1) por código de barras
  const findByBarcode = useCallback(
    (code: string): ScannedProductMatch | null => {
      if (!code) return null;
      const normalized = normalizeCode(code);

      // Intento en O(1) con el Map hash
      const indexedMatch = barcodeIndex.get(normalized);
      if (indexedMatch) return indexedMatch;

      // Fallback a motor exhaustivo de product-search
      const searchMatch = findProductByBarcode(products, code);
      return searchMatch || null;
    },
    [barcodeIndex, products]
  );

  // 4. Lista de categorías únicas ordenadas alfabéticamente
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) {
      if (p.active !== false && p.category) {
        set.add(p.category.trim());
      }
    }
    const sorted = Array.from(set).sort((a, b) => a.localeCompare(b));
    return ['Todos', ...sorted];
  }, [products]);

  // 5. Cálculo reactivo de KPIs de inventario y detección de alertas críticas
  const { stats, alerts } = useMemo(() => {
    let totalVal = 0;
    let lowCount = 0;
    let outCount = 0;
    const criticalList: Array<{ productId: string; name: string; currentStock: number; minStock: number }> = [];

    const activeBranchId = branchId || 'main';

    for (const p of products) {
      if (p.active === false) continue;

      const physicalStock = getBranchStock(p, activeBranchId);
      const minStock = Number((p as any).minStock ?? 3);
      const costPrice = Number(p.costPrice ?? (p.suggestedPrice ? p.suggestedPrice * 0.7 : 0));

      if (physicalStock > 0) {
        totalVal += physicalStock * costPrice;
      }

      if (physicalStock <= 0) {
        outCount++;
        criticalList.push({
          productId: p.id,
          name: p.name,
          currentStock: physicalStock,
          minStock,
        });
      } else if (physicalStock <= minStock) {
        lowCount++;
        criticalList.push({
          productId: p.id,
          name: p.name,
          currentStock: physicalStock,
          minStock,
        });
      }
    }

    const calculatedStats: InventoryStats = {
      totalProducts: products.filter((p) => p.active !== false).length,
      skuCount: products.filter((p) => p.active !== false).length,
      totalInventoryValue: Math.round(totalVal * 100) / 100,
      valuation: Math.round(totalVal * 100) / 100,
      lowStockCount: lowCount,
      outOfStockCount: outCount,
    };

    return { stats: calculatedStats, alerts: criticalList };
  }, [products, branchId]);

  // 6. Monitoreo de stock crítico para alertas locales
  useEffect(() => {
    setCriticalAlerts(alerts);

    // Si hay un incremento súbito de productos con stock agotado o bajo, registrar log
    if (alerts.length > previousAlertCount.current && previousAlertCount.current > 0) {
      console.log(`[ProductsContext] Alerta: ${alerts.length} productos con stock crítico en sucursal ${branchId}`);
    }
    previousAlertCount.current = alerts.length;
  }, [alerts, branchId]);

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
    setRefreshTick((t) => t + 1);
  }, []);

  const contextValue = useMemo(
    () => ({
      products,
      loading,
      categories,
      stats,
      criticalAlerts,
      findByBarcode,
      getProductStock: getProductStockHelper,
      getProductAvailableStock: getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
    }),
    [
      products,
      loading,
      categories,
      stats,
      criticalAlerts,
      findByBarcode,
      getProductStockHelper,
      getProductAvailableStockHelper,
      refreshProducts,
      upsertProduct,
    ]
  );

  return <ProductsContext.Provider value={contextValue}>{children}</ProductsContext.Provider>;
};

export const useProducts = () => useContext(ProductsContext);
