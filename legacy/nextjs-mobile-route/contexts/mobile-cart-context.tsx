"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Product } from '@/types/product';
import { useToast } from '@/hooks/use-toast';

export interface MobileCartItem {
  product: Product;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  notes?: string;
  isWeighable?: boolean;
}

interface MobileCartContextType {
  items: MobileCartItem[];
  addItem: (product: Product, quantity?: number, unitPrice?: number, notes?: string) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
  totalAmount: number;
  itemCount: number;
  getItemQuantity: (productId: string) => number;
}

const MobileCartContext = createContext<MobileCartContextType | null>(null);

const CART_STORAGE_KEY = 'ventify_mobile_pos_cart';

export function MobileCartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<MobileCartItem[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const saved = sessionStorage.getItem(CART_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const { toast } = useToast();

  useEffect(() => {
    try {
      sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Storage limits or private mode
    }
  }, [items]);

  const addItem = useCallback((product: Product, quantity = 1, customPrice?: number, notes?: string) => {
    const unitPrice = customPrice !== undefined ? customPrice : (product.price || 0);

    setItems((prev) => {
      const existingIndex = prev.findIndex((item) => item.product.id === product.id);
      if (existingIndex > -1) {
        const updated = [...prev];
        const newQty = Math.round((updated[existingIndex].quantity + quantity) * 1000) / 1000;
        const subtotal = Math.round(newQty * updated[existingIndex].unitPrice * 100) / 100;
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: newQty,
          subtotal,
          notes: notes || updated[existingIndex].notes,
        };
        return updated;
      } else {
        const subtotal = Math.round(quantity * unitPrice * 100) / 100;
        return [
          ...prev,
          {
            product,
            quantity,
            unitPrice,
            subtotal,
            notes,
            isWeighable:
              product.allowDecimals ||
              product.unitOfMeasure === 'kg' ||
              (product as any).unit === 'kg' ||
              (product as any).unit === 'kilo',
          },
        ];
      }
    });

    // Feedback háptico en dispositivos móviles compatibles
    if (typeof window !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(40);
      } catch {
        // Ignorar si el navegador restringe vibración sin interacción previa
      }
    }

    toast({
      title: "Producto agregado",
      description: `${product.name} (${quantity}) - S/ ${(quantity * unitPrice).toFixed(2)}`,
      duration: 1800,
    });
  }, [toast]);

  const updateQuantity = useCallback((productId: string, quantity: number) => {
    if (quantity <= 0) {
      removeItem(productId);
      return;
    }
    setItems((prev) =>
      prev.map((item) => {
        if (item.product.id === productId) {
          const subtotal = Math.round(quantity * item.unitPrice * 100) / 100;
          return { ...item, quantity, subtotal };
        }
        return item;
      })
    );
  }, []);

  const removeItem = useCallback((productId: string) => {
    setItems((prev) => prev.filter((item) => item.product.id !== productId));
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(CART_STORAGE_KEY);
    }
  }, []);

  const totalAmount = useMemo(() => {
    const sum = items.reduce((acc, item) => acc + item.subtotal, 0);
    return Math.round(sum * 100) / 100;
  }, [items]);

  const itemCount = useMemo(() => {
    return items.reduce((acc, item) => acc + item.quantity, 0);
  }, [items]);

  const getItemQuantity = useCallback((productId: string) => {
    const found = items.find((item) => item.product.id === productId);
    return found ? found.quantity : 0;
  }, [items]);

  return (
    <MobileCartContext.Provider
      value={{
        items,
        addItem,
        updateQuantity,
        removeItem,
        clearCart,
        totalAmount,
        itemCount,
        getItemQuantity,
      }}
    >
      {children}
    </MobileCartContext.Provider>
  );
}

export function useMobileCart() {
  const context = useContext(MobileCartContext);
  if (!context) {
    throw new Error('useMobileCart must be used within a MobileCartProvider');
  }
  return context;
}
