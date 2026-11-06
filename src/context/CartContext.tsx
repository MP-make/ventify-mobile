import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

export interface MobileProduct {
  id: string;
  name: string;
  price: number;
  costPrice?: number;
  barcode?: string;
  sku?: string;
  category?: string;
  imageUrl?: string;
  stock?: Record<string, number>;
  unitOfMeasure?: string;
  [key: string]: any;
}

export interface CartItem {
  id: string; // product id
  product: MobileProduct;
  quantity: number;
  price: number;
}

interface CartContextType {
  items: CartItem[];
  addItem: (product: MobileProduct, qty?: number) => void;
  updateQuantity: (productId: string, qty: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
  setCartItems: (items: CartItem[]) => void;
  itemCount: number;
  totalAmount: number;
}

const CartContext = createContext<CartContextType>({
  items: [],
  addItem: () => {},
  updateQuantity: () => {},
  removeItem: () => {},
  clearCart: () => {},
  setCartItems: () => {},
  itemCount: 0,
  totalAmount: 0,
});

export const CartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem('ventify_mobile_cart');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('ventify_mobile_cart', JSON.stringify(items));
    } catch {}
  }, [items]);

  const addItem = (product: MobileProduct, qty = 1) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      const price = Number(product.price ?? (product as any).suggestedPrice ?? 0);
      if (existing) {
        return prev.map((i) =>
          i.id === product.id ? { ...i, quantity: i.quantity + qty } : i
        );
      }
      return [...prev, { id: product.id, product, quantity: qty, price }];
    });
  };

  const updateQuantity = (productId: string, qty: number) => {
    setItems((prev) => {
      if (qty <= 0) {
        return prev.filter((i) => i.id !== productId);
      }
      return prev.map((i) =>
        i.id === productId ? { ...i, quantity: qty } : i
      );
    });
  };

  const removeItem = (productId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== productId));
  };

  const clearCart = () => {
    setItems([]);
    try {
      localStorage.removeItem('ventify_mobile_cart');
    } catch {}
  };

  const setCartItems = (newItems: CartItem[]) => {
    setItems(newItems);
  };

  const itemCount = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity, 0),
    [items]
  );

  const totalAmount = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items]
  );

  return (
    <CartContext.Provider
      value={{
        items,
        addItem,
        updateQuantity,
        removeItem,
        clearCart,
        setCartItems,
        itemCount,
        totalAmount,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => useContext(CartContext);
