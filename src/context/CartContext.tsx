import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import {
  CartItem,
  Customer,
  Product,
  ProductPresentation,
  ProductVariant,
  PausedSale,
} from '@/types';
import { resolveEffectiveUnitPrice } from '@/lib/product-search';
import { useAuth } from './AuthContext';

declare module '@/types' {
  interface CartItem {
    notes?: string;
    product?: Product;
  }
}

export interface AddItemOptions {
  quantity?: number;
  presentation?: ProductPresentation;
  variant?: ProductVariant;
  customPrice?: number;
  isWeightBased?: boolean;
  notes?: string;
  discount?: number;
}

export interface CartContextType {
  items: CartItem[];
  customer: Customer | null;
  discount: number;
  notes: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  netAmount: number;
  total: number;
  totalItemsCount: number;
  totalAmount: number; // Alias para total
  itemCount: number; // Alias para totalItemsCount
  pausedSales: PausedSale[];
  setCustomer: (customer: Customer | null) => void;
  setDiscount: (discount: number) => void;
  setNotes: (notes: string) => void;
  addItem: (product: Product, options?: AddItemOptions) => void;
  updateQuantity: (cartItemId: string, newQty: number) => void;
  updateItemPrice: (cartItemId: string, newPrice: number) => boolean;
  removeItem: (cartItemId: string) => void;
  clearCart: () => void;
  pauseCurrentSale: (label?: string) => Promise<string | null>;
  resumePausedSale: (pausedId: string) => Promise<boolean>;
  deletePausedSale: (pausedId: string) => Promise<boolean>;
  getItemQuantity: (productId: string) => number;
}

const CART_STORAGE_KEY = '@ventify_pos_cart';
const PAUSED_SALES_STORAGE_KEY = '@ventify_paused_sales';

const CartContext = createContext<CartContextType>({
  items: [],
  customer: null,
  discount: 0,
  notes: '',
  subtotal: 0,
  discountAmount: 0,
  taxAmount: 0,
  netAmount: 0,
  total: 0,
  totalItemsCount: 0,
  totalAmount: 0,
  itemCount: 0,
  pausedSales: [],
  setCustomer: () => {},
  setDiscount: () => {},
  setNotes: () => {},
  addItem: () => {},
  updateQuantity: () => {},
  updateItemPrice: () => false,
  removeItem: () => {},
  clearCart: () => {},
  pauseCurrentSale: async () => null,
  resumePausedSale: async () => false,
  deletePausedSale: async () => false,
  getItemQuantity: () => 0,
});

export const CartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { branchId, accountId } = useAuth();

  const [items, setItems] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [discount, setDiscount] = useState<number>(0);
  const [notes, setNotes] = useState<string>('');
  const [pausedSales, setPausedSales] = useState<PausedSale[]>([]);

  const isRestored = useRef<boolean>(false);

  // 1. Restaurar carrito y ventas en pausa desde AsyncStorage al iniciar
  useEffect(() => {
    async function restoreCartData() {
      try {
        const [savedCartRaw, savedPausedRaw] = await Promise.all([
          AsyncStorage.getItem(CART_STORAGE_KEY),
          AsyncStorage.getItem(PAUSED_SALES_STORAGE_KEY),
        ]);

        if (savedCartRaw) {
          const parsed = JSON.parse(savedCartRaw);
          if (Array.isArray(parsed.items)) setItems(parsed.items);
          if (parsed.customer) setCustomer(parsed.customer);
          if (typeof parsed.discount === 'number') setDiscount(parsed.discount);
          if (typeof parsed.notes === 'string') setNotes(parsed.notes);
        }

        if (savedPausedRaw) {
          const parsedPaused = JSON.parse(savedPausedRaw);
          if (Array.isArray(parsedPaused)) setPausedSales(parsedPaused);
        }
      } catch (err) {
        console.warn('[CartContext] Error restoring cart from storage:', err);
      } finally {
        isRestored.current = true;
      }
    }

    restoreCartData();
  }, []);

  // 2. Persistir carrito actual reactivamente cuando cambie
  useEffect(() => {
    if (!isRestored.current) return;

    const payload = JSON.stringify({
      items,
      customer,
      discount,
      notes,
    });

    AsyncStorage.setItem(CART_STORAGE_KEY, payload).catch((err) => {
      console.warn('[CartContext] Error saving cart to storage:', err);
    });
  }, [items, customer, discount, notes]);

  // 3. Persistir lista de ventas en pausa cuando cambie
  const persistPausedSales = useCallback(async (list: PausedSale[]) => {
    setPausedSales(list);
    await AsyncStorage.setItem(PAUSED_SALES_STORAGE_KEY, JSON.stringify(list)).catch(() => {});
  }, []);

  // 4. Agregar producto al carrito resolviendo reglas de precios
  const addItem = useCallback(
    (product: Product, options: AddItemOptions = {}) => {
      const quantityToAdd = options.quantity !== undefined ? options.quantity : 1;
      const { presentation, variant, customPrice, isWeightBased } = options;
      const activeBranch = branchId || 'main';

      // Disparar feedback háptico ligero
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

      // Generar ID único del ítem en carrito según variantes y presentaciones
      const presentationKey = presentation?.id || 'base';
      const variantKey = variant?.id || 'base';
      const cartItemId = `${product.id}_${presentationKey}_${variantKey}`;

      setItems((prevItems) => {
        const existingIndex = prevItems.findIndex((i) => i.id === cartItemId);

        if (existingIndex > -1) {
          const existingItem = prevItems[existingIndex];
          const newQty =
            product.allowDecimals || isWeightBased
              ? Math.round((existingItem.quantity + quantityToAdd) * 1000) / 1000
              : existingItem.quantity + quantityToAdd;

          // Si el precio fue modificado manualmente por el usuario, respetar customPrice
          let effectivePrice = existingItem.price;
          if (customPrice !== undefined) {
            effectivePrice = customPrice;
          } else if (!existingItem.modifiedPrice) {
            // Recalcular según nueva cantidad por escalas mayoristas (tiered pricing)
            effectivePrice = resolveEffectiveUnitPrice(
              product,
              activeBranch,
              newQty,
              presentation,
              variant
            );
          }

          const updatedItems = [...prevItems];
          updatedItems[existingIndex] = {
            ...existingItem,
            quantity: newQty,
            price: effectivePrice,
            lineTotal: Math.round(newQty * effectivePrice * 100) / 100,
            notes: options.notes || existingItem.notes,
          };
          return updatedItems;
        }

        // Nuevo ítem en carrito
        let initialPrice: number;
        if (customPrice !== undefined) {
          const floor = Number(product.minSalePrice ?? 0);
          initialPrice = floor > 0 ? Math.max(customPrice, floor) : customPrice;
        } else {
          initialPrice = resolveEffectiveUnitPrice(
            product,
            activeBranch,
            quantityToAdd,
            presentation,
            variant
          );
        }

        const isDecimalsAllowed =
          Boolean(product.allowDecimals) ||
          Boolean(isWeightBased) ||
          product.unitOfMeasure === 'kg' ||
          product.unitOfMeasure === 'g' ||
          product.unitOfMeasure === 'lt' ||
          product.unitOfMeasure === 'm';

        const newItem: CartItem = {
          id: cartItemId,
          productId: product.id,
          product,
          notes: options.notes,
          name: product.name,
          sku: variant?.sku || product.sku,
          price: initialPrice,
          quantity: quantityToAdd,
          presentation,
          variant,
          isWeightBased: Boolean(isWeightBased),
          customPrice,
          suggestedPrice: product.suggestedPrice ?? product.price,
          minSalePrice: presentation?.minSalePrice ?? product.minSalePrice,
          category: product.category,
          costPrice: product.costPrice,
          stock: product.stock,
          imageUrl: product.thumbUrl || product.imageUrl,
          unitOfMeasure: product.unitOfMeasure || 'unit',
          allowDecimals: isDecimalsAllowed,
          stepDecimal: product.stepDecimal,
          presentationId: presentation?.id,
          presentationName: presentation?.name,
          presentationQty: presentation?.conversionFactor ?? presentation?.quantity,
          variantId: variant?.id,
          variantName: variant?.name,
          lineTotal: Math.round(quantityToAdd * initialPrice * 100) / 100,
        };

        return [...prevItems, newItem];
      });
    },
    [branchId]
  );

  // 5. Actualizar cantidad de un ítem existente
  const updateQuantity = useCallback(
    (cartItemId: string, newQty: number) => {
      setItems((prevItems) => {
        if (newQty <= 0) {
          return prevItems.filter((i) => i.id !== cartItemId);
        }

        return prevItems.map((item) => {
          if (item.id === cartItemId) {
            const activeBranch = branchId || 'main';

            // Si el precio no fue editado a mano, recalcular escalas de precio
            let unitPrice = item.price;
            if (!item.modifiedPrice) {
              const dummyProduct: Product = {
                id: item.id.split('_')[0],
                name: item.name,
                category: item.category || 'General',
                sku: item.sku,
                costPrice: item.costPrice || 0,
                minSalePrice: item.minSalePrice || 0,
                suggestedPrice: item.suggestedPrice || item.price,
                stock: item.stock || {},
                accountId: accountId || '',
              };
              unitPrice = resolveEffectiveUnitPrice(
                dummyProduct,
                activeBranch,
                newQty,
                item.presentation,
                item.variant
              );
            }

            return {
              ...item,
              quantity: newQty,
              price: unitPrice,
              lineTotal: Math.round(newQty * unitPrice * 100) / 100,
            };
          }
          return item;
        });
      });
    },
    [branchId, accountId]
  );

  // 6. Actualizar precio unitario de un ítem con validación de piso (minSalePrice)
  const updateItemPrice = useCallback(
    (cartItemId: string, newPrice: number): boolean => {
      let success = true;

      setItems((prevItems) => {
        return prevItems.map((item) => {
          if (item.id === cartItemId) {
            const floor = Number(item.minSalePrice ?? 0);
            if (floor > 0 && newPrice < floor) {
              console.warn(`[CartContext] Precio S/ ${newPrice} inferior al piso permitido de S/ ${floor}`);
              success = false;
              return item;
            }

            return {
              ...item,
              price: newPrice,
              modifiedPrice: newPrice,
              lineTotal: Math.round(item.quantity * newPrice * 100) / 100,
            };
          }
          return item;
        });
      });

      return success;
    },
    []
  );

  // 7. Remover ítem del carrito
  const removeItem = useCallback((cartItemId: string) => {
    setItems((prevItems) => prevItems.filter((i) => i.id !== cartItemId));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  // 8. Vaciar carrito completo
  const clearCart = useCallback(() => {
    setItems([]);
    setCustomer(null);
    setDiscount(0);
    setNotes('');
    AsyncStorage.removeItem(CART_STORAGE_KEY).catch(() => {});
  }, []);

  // 9. Ventas en Pausa (Hold Carts)
  const pauseCurrentSale = useCallback(
    async (label?: string): Promise<string | null> => {
      if (items.length === 0) return null;

      const pausedId = `hold_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const defaultLabel =
        label ||
        (customer ? `Cliente: ${customer.name}` : `Venta en espera #${pausedSales.length + 1}`);

      const currentSubtotal = items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      );
      const currentTotal = Math.max(0, currentSubtotal - discount);

      const newPausedSale: PausedSale = {
        id: pausedId,
        label: defaultLabel,
        savedAt: Date.now(),
        items: [...items],
        customer,
        note: notes,
        branchId,
        accountId: accountId || undefined,
        total: Math.round(currentTotal * 100) / 100,
      };

      const updatedList = [newPausedSale, ...pausedSales];
      await persistPausedSales(updatedList);

      // Limpiar carrito actual para atender al siguiente cliente
      clearCart();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      return pausedId;
    },
    [items, customer, discount, notes, branchId, accountId, pausedSales, persistPausedSales, clearCart]
  );

  // 10. Reanudar una venta en pausa
  const resumePausedSale = useCallback(
    async (pausedId: string): Promise<boolean> => {
      const target = pausedSales.find((s) => s.id === pausedId);
      if (!target) return false;

      // Cargar en carrito activo
      setItems(target.items);
      setCustomer(target.customer || null);
      setNotes(target.note || '');
      setDiscount(0);

      // Remover de lista de pausadas
      const filtered = pausedSales.filter((s) => s.id !== pausedId);
      await persistPausedSales(filtered);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      return true;
    },
    [pausedSales, persistPausedSales]
  );

  // 11. Eliminar venta en pausa
  const deletePausedSale = useCallback(
    async (pausedId: string): Promise<boolean> => {
      const filtered = pausedSales.filter((s) => s.id !== pausedId);
      await persistPausedSales(filtered);
      return true;
    },
    [pausedSales, persistPausedSales]
  );

  // 12. Helper para obtener cantidad ya existente de un producto en carrito
  const getItemQuantity = useCallback(
    (productId: string): number => {
      return items
        .filter((item) => item.id.startsWith(productId))
        .reduce((sum, item) => sum + item.quantity, 0);
    },
    [items]
  );

  // 13. Cálculos financieros contables (IGV 18% incluido según normativa SUNAT Perú)
  const { subtotal, discountAmount, taxAmount, netAmount, total, totalItemsCount } =
    useMemo(() => {
      const calculatedSubtotal = items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      );

      const dAmount = Math.min(calculatedSubtotal, Math.max(0, discount));
      const calculatedTotal = Math.max(0, calculatedSubtotal - dAmount);

      // En el sistema de facturación peruano (precios con IGV incluido):
      // Base imponible = Total / 1.18
      // IGV (18%) = Total - Base imponible
      const net = Math.round((calculatedTotal / 1.18) * 100) / 100;
      const tax = Math.round((calculatedTotal - net) * 100) / 100;

      const count = items.reduce((sum, item) => sum + item.quantity, 0);

      return {
        subtotal: Math.round(calculatedSubtotal * 100) / 100,
        discountAmount: Math.round(dAmount * 100) / 100,
        taxAmount: tax,
        netAmount: net,
        total: Math.round(calculatedTotal * 100) / 100,
        totalItemsCount: Math.round(count * 1000) / 1000,
      };
    }, [items, discount]);

  const contextValue = useMemo(
    () => ({
      items,
      customer,
      discount,
      notes,
      subtotal,
      discountAmount,
      taxAmount,
      netAmount,
      total,
      totalItemsCount,
      totalAmount: total,
      itemCount: totalItemsCount,
      pausedSales,
      setCustomer,
      setDiscount,
      setNotes,
      addItem,
      updateQuantity,
      updateItemPrice,
      removeItem,
      clearCart,
      pauseCurrentSale,
      resumePausedSale,
      deletePausedSale,
      getItemQuantity,
    }),
    [
      items,
      customer,
      discount,
      notes,
      subtotal,
      discountAmount,
      taxAmount,
      netAmount,
      total,
      totalItemsCount,
      pausedSales,
      addItem,
      updateQuantity,
      updateItemPrice,
      removeItem,
      clearCart,
      pauseCurrentSale,
      resumePausedSale,
      deletePausedSale,
      getItemQuantity,
    ]
  );

  return <CartContext.Provider value={contextValue}>{children}</CartContext.Provider>;
};

export const useCart = () => useContext(CartContext);
