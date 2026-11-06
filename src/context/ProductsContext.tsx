import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthContext';
import { MobileProduct } from './CartContext';

interface ProductsContextType {
  products: MobileProduct[];
  loading: boolean;
  categories: string[];
  stats: {
    skuCount: number;
    valuation: number;
    lowStockCount: number;
    outOfStockCount: number;
  };
}

const ProductsContext = createContext<ProductsContextType>({
  products: [],
  loading: true,
  categories: ['Todos'],
  stats: { skuCount: 0, valuation: 0, lowStockCount: 0, outOfStockCount: 0 },
});

export const ProductsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { accountId, branchId } = useAuth();
  const [products, setProducts] = useState<MobileProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(collection(db, 'products'), where('accountId', '==', accountId));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: MobileProduct[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          const price = Number(data.suggestedPrice ?? data.price ?? 0);
          return {
            id: docSnap.id,
            name: data.name || 'Sin nombre',
            category: data.category || 'General',
            price,
            costPrice: Number(data.costPrice ?? 0),
            stock: data.stock || {},
            barcode: data.barcode || '',
            sku: data.sku || '',
            imageUrl: data.imageUrl || '',
            unitOfMeasure: data.unitOfMeasure || 'unit',
            minStock: Number(data.minStock ?? 3),
            active: data.active !== false,
          };
        });

        setProducts(list);
        setLoading(false);
      },
      (err) => {
        console.error('[ProductsContext] Error loading products:', err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [accountId]);

  const categories = useMemo(() => {
    const set = new Set(
      products
        .map((p) => p.category)
        .filter((c): c is string => Boolean(c))
    );
    const arr = Array.from(set);
    arr.sort();
    return ['Todos', ...arr];
  }, [products]);

  const stats = useMemo(() => {
    let totalVal = 0;
    let lowCount = 0;
    let outCount = 0;

    products.forEach((p) => {
      const stock =
        p.stock && p.stock[branchId] !== undefined
          ? p.stock[branchId]
          : Object.values(p.stock || {})[0] || 0;
      const min = p.minStock || 3;
      const cost = p.costPrice || 0;
      totalVal += stock * cost;

      if (stock <= 0) {
        outCount++;
      } else if (stock <= min) {
        lowCount++;
      }
    });

    return {
      skuCount: products.length,
      valuation: totalVal,
      lowStockCount: lowCount,
      outOfStockCount: outCount,
    };
  }, [products, branchId]);

  return (
    <ProductsContext.Provider value={{ products, loading, categories, stats }}>
      {children}
    </ProductsContext.Provider>
  );
};

export const useProducts = () => useContext(ProductsContext);
