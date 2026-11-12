import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { cartKVStorage } from '@/lib/native-kv-storage';
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
import { cartStorageKeys, canResumeCart } from '@/lib/cart-scope';
import { normalizePresentation, presentationFactor } from '@/lib/presentation-parity';

declare module '@/types' {
  interface CartItem {
    notes?: string;
    product?: Product;
  }
  interface PausedSale {
    sourceSaleRequestId?: string | null;
    sourceQuoteId?: string | null;
    shippingAmount?: number;
    discountAmount?: number;
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
  saleRequestId: string | null;
  sourceQuoteId: string | null;
  shippingAmount: number;
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
  setSaleRequestId: (requestId: string | null) => void;
  setSourceQuoteId: (quoteId: string | null) => void;
  setShippingAmount: (amount: number) => void;
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


const CartContext = createContext<CartContextType>({
  items: [],
  customer: null,
  discount: 0,
  notes: '',
  saleRequestId: null,
  sourceQuoteId: null,
  shippingAmount: 0,
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
  setSaleRequestId: () => {},
  setSourceQuoteId: () => {},
  setShippingAmount: () => {},
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
  const { branchId, accountId, user } = useAuth();
  const storageKeys = useMemo(() => cartStorageKeys(accountId || "", branchId, user?.uid || ""), [accountId, branchId, user?.uid]);

  const [items, setItems] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [discount, setDiscount] = useState<number>(0);
  const [notes, setNotes] = useState<string>('');
  const [saleRequestId, setSaleRequestId] = useState<string | null>(null);
  const [sourceQuoteId, setSourceQuoteId] = useState<string | null>(null);
  const [shippingAmount, setShippingAmountState] = useState(0);
  const setShippingAmount = useCallback((amount: number) => {
    setShippingAmountState(Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0);
  }, []);
  const [pausedSales, setPausedSales] = useState<PausedSale[]>([]);

  const isRestored = useRef<boolean>(false);

  // 1. Restaurar carrito y ventas en pausa desde AsyncStorage al iniciar
  useEffect(() => {
    let alive = true;
    isRestored.current = false;
    setItems([]); setCustomer(null); setDiscount(0); setNotes(''); setSaleRequestId(null); setSourceQuoteId(null); setShippingAmountState(0); setPausedSales([]);
    async function restoreCartData() {
      try {
        const [savedCartRaw, savedPausedRaw] = await Promise.all([
          cartKVStorage.getItem(storageKeys.cart),
          cartKVStorage.getItem(storageKeys.paused),
        ]);

        if (!alive) return;
        if (savedCartRaw) {
          const parsed = JSON.parse(savedCartRaw);
          if (Array.isArray(parsed.items)) setItems(parsed.items.map((item: CartItem) => ({
            ...item,
            presentation: item.presentation ? normalizePresentation(item.presentation) : item.presentation,
            presentationQty: item.presentationQty || item.conversionFactor || presentationFactor(item.presentation),
          })));
          if (parsed.customer) setCustomer(parsed.customer);
          if (typeof parsed.discount === 'number') setDiscount(parsed.discount);
          if (typeof parsed.notes === 'string') setNotes(parsed.notes);
          if (typeof parsed.saleRequestId === 'string') setSaleRequestId(parsed.saleRequestId);
          if (typeof parsed.sourceQuoteId === 'string') setSourceQuoteId(parsed.sourceQuoteId);
          if (typeof parsed.shippingAmount === 'number') setShippingAmount(parsed.shippingAmount);
        }

        if (savedPausedRaw) {
          const parsedPaused = JSON.parse(savedPausedRaw);
          if (Array.isArray(parsedPaused)) setPausedSales(parsedPaused
            .filter(sale => canResumeCart(sale, accountId || "", branchId))
            .map((sale: PausedSale) => ({
              ...sale,
              items: sale.items.map((item) => ({
                ...item,
                presentation: item.presentation ? normalizePresentation(item.presentation) : item.presentation,
                presentationQty: item.presentationQty || item.conversionFactor || presentationFactor(item.presentation),
              })),
            })));
        }
      } catch (err) {
        console.warn('[CartContext] Error restoring cart from storage:', err);
      } finally {
        if (alive) isRestored.current = true;
      }
    }

    if (accountId && user) void restoreCartData();
    return () => { alive = false; };
  }, [storageKeys.cart, storageKeys.paused, accountId, branchId, user?.uid, setShippingAmount]);

  // 2. Persistir carrito actual reactivamente con debounce (350ms) y payload ligero
  useEffect(() => {
    if (!isRestored.current) return;

    const timer = setTimeout(() => {
      // Omitir objeto pesado item.product en la serialización para máxima velocidad MMKV
      const lightweightItems = items.map((item) => {
        if (!item.product) return item;
        const { product, ...rest } = item;
        return rest;
      });

      const payload = JSON.stringify({
        items: lightweightItems,
        customer,
        discount,
        notes,
        saleRequestId,
        sourceQuoteId,
        shippingAmount,
      });

      cartKVStorage.setItem(storageKeys.cart, payload).catch((err) => {
        console.warn('[CartContext] Error saving cart to storage:', err);
      });
    }, 350);

    return () => clearTimeout(timer);
  }, [items, customer, discount, notes, saleRequestId, sourceQuoteId, shippingAmount, storageKeys.cart]);

  // 3. Persistir lista de ventas en pausa cuando cambie
  const persistPausedSales = useCallback(async (list: PausedSale[]) => {
    setPausedSales(list);
    const lightweightList = list.map((sale) => ({
      ...sale,
      items: sale.items.map((item) => {
        if (!item.product) return item;
        const { product, ...rest } = item;
        return rest;
      }),
    }));
    await cartKVStorage.setItem(storageKeys.paused, JSON.stringify(lightweightList)).catch(() => {});
  }, [storageKeys.paused]);

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
          presentationQty: presentationFactor(presentation),
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
              const productToUse: Product = item.product
                ? {
                    ...item.product,
                    costPrice: item.costPrice ?? item.product.costPrice,
                    minSalePrice: item.minSalePrice ?? item.product.minSalePrice,
                  }
                : {
                    id: item.productId || item.id.split('_')[0],
                    name: item.name,
                    category: item.category || 'General',
                    sku: item.sku,
                    costPrice: item.costPrice || 0,
                    minSalePrice: item.minSalePrice || 0,
                    suggestedPrice: item.suggestedPrice || item.price,
                    stock: item.stock || {},
                    accountId: accountId || '',
                    priceTiers: (item as any).priceTiers,
                    branchPrices: (item as any).branchPrices,
                    presentations: (item as any).presentations,
                  };

              unitPrice = resolveEffectiveUnitPrice(
                productToUse,
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
    setSaleRequestId(null);
    setSourceQuoteId(null);
    setShippingAmountState(0);
    cartKVStorage.removeItem(storageKeys.cart).catch(() => {});
  }, [storageKeys.cart]);

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
      const currentTotal = Math.max(0, currentSubtotal - discount) + shippingAmount;

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
        sourceSaleRequestId: saleRequestId,
        sourceQuoteId,
        shippingAmount,
        discountAmount: discount,
      };

      const updatedList = [newPausedSale, ...pausedSales];
      await persistPausedSales(updatedList);

      // Limpiar carrito actual para atender al siguiente cliente
      clearCart();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      return pausedId;
    },
    [items, customer, discount, notes, saleRequestId, sourceQuoteId, shippingAmount, branchId, accountId, pausedSales, persistPausedSales, clearCart]
  );

  // 10. Reanudar una venta en pausa
  const resumePausedSale = useCallback(
    async (pausedId: string): Promise<boolean> => {
      const target = pausedSales.find((s) => s.id === pausedId);
      if (!target || !canResumeCart(target, accountId || "", branchId)) return false;

      // Cargar en carrito activo
      setItems(target.items);
      setCustomer(target.customer || null);
      setNotes(target.note || '');
      setDiscount(target.discountAmount || 0);
      setSaleRequestId(target.sourceSaleRequestId || null);
      setSourceQuoteId(target.sourceQuoteId || null);
      setShippingAmount(target.shippingAmount || 0);

      // Remover de lista de pausadas
      const filtered = pausedSales.filter((s) => s.id !== pausedId);
      await persistPausedSales(filtered);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      return true;
    },
    [pausedSales, persistPausedSales, accountId, branchId, setShippingAmount]
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
      const calculatedItemsTotal = Math.max(0, calculatedSubtotal - dAmount);

      // En el sistema de facturación peruano (precios con IGV incluido):
      // Base imponible = Total / 1.18
      // IGV (18%) = Total - Base imponible
      const net = Math.round((calculatedItemsTotal / 1.18) * 100) / 100;
      const tax = Math.round((calculatedItemsTotal - net) * 100) / 100;

      const count = items.reduce((sum, item) => sum + item.quantity, 0);

      return {
        subtotal: Math.round(calculatedSubtotal * 100) / 100,
        discountAmount: Math.round(dAmount * 100) / 100,
        taxAmount: tax,
        netAmount: net,
        total: Math.round((calculatedItemsTotal + shippingAmount) * 100) / 100,
        totalItemsCount: Math.round(count * 1000) / 1000,
      };
    }, [items, discount, shippingAmount]);

  const contextValue = useMemo(
    () => ({
      items,
      customer,
      discount,
      notes,
      saleRequestId,
      sourceQuoteId,
      shippingAmount,
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
      setSaleRequestId,
      setSourceQuoteId,
      setShippingAmount,
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
      saleRequestId,
      sourceQuoteId,
      shippingAmount,
      setShippingAmount,
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
