import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { InteractionManager } from 'react-native';
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
import {
  getEffectiveProductPrice,
  resolveCartItemMinPrice,
} from '@/lib/product-search';
import { useAuthSession } from './AuthContext';
import { useBusinessSettings } from './SettingsContext';
import { cartStorageKeys, canResumeCart } from '@/lib/cart-scope';
import { normalizePresentation, presentationFactor } from '@/lib/presentation-parity';

const normalizeMoneyAmount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : 0;

const isValidInvoiceIntent = (value: unknown): value is Exclude<CartInvoiceIntent, null> =>
  value === 'nota_venta' || value === 'boleta' || value === 'factura' || value === 'quote';

const stripProductFromCartItems = (cartItems: CartItem[]): CartItem[] =>
  cartItems.map((item) => {
    if (!item.product) return item;
    const { product: _omit, ...rest } = item;
    return rest;
  });

const minimizeCartItemProduct = (product: Product | undefined): Product | undefined => {
  if (!product) return undefined;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    sku: product.sku,
    accountId: product.accountId,
    costPrice: product.costPrice,
    minSalePrice: product.minSalePrice,
    suggestedPrice: product.suggestedPrice,
    ...(product.price !== undefined ? { price: product.price } : {}),
    stock: product.stock,
    ...(product.priceTiers ? { priceTiers: product.priceTiers } : {}),
    ...(product.branchPrices ? { branchPrices: product.branchPrices } : {}),
    ...(product.presentations ? { presentations: product.presentations } : {}),
    ...(product.variants ? { variants: product.variants } : {}),
  };
};

interface ParsedCartSnapshot {
  items: CartItem[];
  customer: Customer | null;
  discount: number;
  notes: string;
  saleRequestId: string | null;
  sourceQuoteId: string | null;
  invoiceIntent: CartInvoiceIntent;
  shippingAmount: number;
}

const parseCartSnapshot = (raw: string | null, activeBranch: string): ParsedCartSnapshot | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const items = Array.isArray(parsed.items)
      ? parsed.items.map((item: CartItem) => ({
          ...item,
          presentation: item.presentation
            ? normalizePresentation(item.presentation)
            : item.presentation,
          presentationQty:
            item.presentationQty ||
            item.conversionFactor ||
            presentationFactor(item.presentation),
          stockBranchId: item.stockBranchId || activeBranch || 'main',
        }))
      : [];
    return {
      items,
      customer: parsed.customer ?? null,
      discount: typeof parsed.discount === 'number' ? normalizeMoneyAmount(parsed.discount) : 0,
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      saleRequestId: typeof parsed.saleRequestId === 'string' ? parsed.saleRequestId : null,
      sourceQuoteId: typeof parsed.sourceQuoteId === 'string' ? parsed.sourceQuoteId : null,
      invoiceIntent: isValidInvoiceIntent(parsed.invoiceIntent) ? parsed.invoiceIntent : null,
      shippingAmount:
        typeof parsed.shippingAmount === 'number'
          ? normalizeMoneyAmount(parsed.shippingAmount)
          : 0,
    };
  } catch {
    return null;
  }
};

const parsePausedSalesSnapshot = (
  raw: string | null,
  targetAccountId: string,
  targetBranchId: string
): PausedSale[] => {
  if (!raw) return [];
  try {
    const parsedPaused = JSON.parse(raw);
    if (!Array.isArray(parsedPaused)) return [];
    return parsedPaused
      .filter((sale) => canResumeCart(sale, targetAccountId, targetBranchId))
      .map((sale: PausedSale) => ({
        ...sale,
        items: sale.items.map((item) => ({
          ...item,
          presentation: item.presentation
            ? normalizePresentation(item.presentation)
            : item.presentation,
          presentationQty:
            item.presentationQty ||
            item.conversionFactor ||
            presentationFactor(item.presentation),
          stockBranchId: item.stockBranchId || sale.branchId || targetBranchId || 'main',
        })),
      }));
  } catch {
    return [];
  }
};

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
  isGift?: boolean;
  enableMinSalePrice?: boolean;
}

export type CartInvoiceIntent = 'nota_venta' | 'boleta' | 'factura' | 'quote' | null;

export interface CartContextType {
  items: CartItem[];
  customer: Customer | null;
  discount: number;
  notes: string;
  saleRequestId: string | null;
  sourceQuoteId: string | null;
  shippingAmount: number;
  invoiceIntent: CartInvoiceIntent;
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
  setInvoiceIntent: (intent: CartInvoiceIntent) => void;
  addItem: (product: Product, options?: AddItemOptions) => void;
  addGiftItem: (product: Product, options?: Omit<AddItemOptions, 'isGift' | 'customPrice'>) => void;
  updateQuantity: (cartItemId: string, newQty: number) => void;
  updateItemPrice: (cartItemId: string, newPrice: number, enableMinSalePrice?: boolean) => boolean;
  removeItem: (cartItemId: string) => void;
  clearCart: () => void;
  pauseCurrentSale: (label?: string) => Promise<string | null>;
  resumePausedSale: (pausedId: string) => Promise<boolean>;
  deletePausedSale: (pausedId: string) => Promise<boolean>;
  getItemQuantity: (productId: string) => number;
}


export type CartActionsContextType = Pick<
  CartContextType,
  | 'setCustomer'
  | 'setDiscount'
  | 'setNotes'
  | 'setSaleRequestId'
  | 'setSourceQuoteId'
  | 'setShippingAmount'
  | 'setInvoiceIntent'
  | 'addItem'
  | 'addGiftItem'
  | 'updateQuantity'
  | 'updateItemPrice'
  | 'removeItem'
  | 'clearCart'
  | 'pauseCurrentSale'
  | 'resumePausedSale'
  | 'deletePausedSale'
  | 'getItemQuantity'
>;

const CartActionsContext = createContext<CartActionsContextType>({
  setCustomer: () => {},
  setDiscount: () => {},
  setNotes: () => {},
  setSaleRequestId: () => {},
  setSourceQuoteId: () => {},
  setShippingAmount: () => {},
  setInvoiceIntent: () => {},
  addItem: () => {},
  addGiftItem: () => {},
  updateQuantity: () => {},
  updateItemPrice: () => false,
  removeItem: () => {},
  clearCart: () => {},
  pauseCurrentSale: async () => null,
  resumePausedSale: async () => false,
  deletePausedSale: async () => false,
  getItemQuantity: () => 0,
});

const CartContext = createContext<CartContextType>({
  items: [],
  customer: null,
  discount: 0,
  notes: '',
  saleRequestId: null,
  sourceQuoteId: null,
  shippingAmount: 0,
  invoiceIntent: null,
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
  setInvoiceIntent: () => {},
  addItem: () => {},
  addGiftItem: () => {},
  updateQuantity: () => {},
  updateItemPrice: () => false,
  removeItem: () => {},
  clearCart: () => {},
  pauseCurrentSale: async () => null,
  resumePausedSale: async () => false,
  deletePausedSale: async () => false,
  getItemQuantity: () => 0,
});

const CartBadgeContext = createContext<number>(0);

export const CartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { branchId, accountId, user } = useAuthSession();
  const { posSettings } = useBusinessSettings();
  const defaultMinPriceEnabled = posSettings?.enableMinSalePrice !== false;
  const storageKeys = useMemo(
    () => cartStorageKeys(accountId || '', branchId, user?.uid || ''),
    [accountId, branchId, user?.uid]
  );

  const initialSyncCartRef = useRef<
    | {
        scopeKey: string;
        cartKey: string;
        cart: ParsedCartSnapshot | null;
        paused: PausedSale[];
      }
    | null
    | undefined
  >(undefined);

  if (initialSyncCartRef.current === undefined) {
    if (accountId && user?.uid && cartKVStorage?.isSyncCapable) {
      let parsedCart: ParsedCartSnapshot | null = null;
      let parsedPaused: PausedSale[] = [];
      try {
        const rawCart = cartKVStorage.getItemSync(storageKeys.cart);
        const rawPaused = cartKVStorage.getItemSync(storageKeys.paused);
        parsedCart = parseCartSnapshot(rawCart, branchId);
        parsedPaused = parsePausedSalesSnapshot(rawPaused, accountId, branchId);
      } catch {
        // Fallback to async restore on error
      }
      initialSyncCartRef.current = {
        scopeKey: `${storageKeys.cart}|${storageKeys.paused}`,
        cartKey: storageKeys.cart,
        cart: parsedCart,
        paused: parsedPaused,
      };
    } else {
      initialSyncCartRef.current = null;
    }
  }

  const initialCart = initialSyncCartRef.current?.cart ?? null;
  const initialPaused = initialSyncCartRef.current?.paused ?? [];

  const [items, setItems] = useState<CartItem[]>(() => initialCart?.items ?? []);
  const [customer, setCustomer] = useState<Customer | null>(() => initialCart?.customer ?? null);
  const [discount, setDiscountState] = useState<number>(() => initialCart?.discount ?? 0);
  const setDiscount = useCallback((value: number) => {
    setDiscountState(normalizeMoneyAmount(value));
  }, []);
  const [notes, setNotes] = useState<string>(() => initialCart?.notes ?? '');
  const [saleRequestId, setSaleRequestId] = useState<string | null>(
    () => initialCart?.saleRequestId ?? null
  );
  const [sourceQuoteId, setSourceQuoteId] = useState<string | null>(
    () => initialCart?.sourceQuoteId ?? null
  );
  const [invoiceIntent, setInvoiceIntent] = useState<CartInvoiceIntent>(
    () => initialCart?.invoiceIntent ?? null
  );
  const [shippingAmount, setShippingAmountState] = useState<number>(
    () => initialCart?.shippingAmount ?? 0
  );
  const setShippingAmount = useCallback((amount: number) => {
    setShippingAmountState(normalizeMoneyAmount(amount));
  }, []);
  const [pausedSales, setPausedSales] = useState<PausedSale[]>(() => initialPaused);

  const isRestored = useRef<boolean>(Boolean(initialSyncCartRef.current));
  const syncHydratedScopeRef = useRef<string | null>(
    initialSyncCartRef.current?.scopeKey ?? null
  );
  const hydratedStorageKeyRef = useRef<string | null>(
    initialSyncCartRef.current?.cartKey ?? null
  );
  const hydratedTokenRef = useRef<{
    items: CartItem[];
    customer: Customer | null;
    discount: number;
    notes: string;
    saleRequestId: string | null;
    sourceQuoteId: string | null;
    invoiceIntent: CartInvoiceIntent;
    shippingAmount: number;
  } | null>(
    initialSyncCartRef.current
      ? {
          items,
          customer,
          discount,
          notes,
          saleRequestId,
          sourceQuoteId,
          invoiceIntent,
          shippingAmount,
        }
      : null
  );

  const itemsRef = useRef<CartItem[]>(items);
  itemsRef.current = items;
  const pausedSalesRef = useRef<PausedSale[]>(pausedSales);
  pausedSalesRef.current = pausedSales;
  const customerRef = useRef<Customer | null>(customer);
  customerRef.current = customer;
  const discountRef = useRef<number>(discount);
  discountRef.current = discount;
  const notesRef = useRef<string>(notes);
  notesRef.current = notes;
  const saleRequestIdRef = useRef<string | null>(saleRequestId);
  saleRequestIdRef.current = saleRequestId;
  const sourceQuoteIdRef = useRef<string | null>(sourceQuoteId);
  sourceQuoteIdRef.current = sourceQuoteId;
  const invoiceIntentRef = useRef<CartInvoiceIntent>(invoiceIntent);
  invoiceIntentRef.current = invoiceIntent;
  const shippingAmountRef = useRef<number>(shippingAmount);
  shippingAmountRef.current = shippingAmount;
  const pausedPersistTaskRef = useRef<{ cancel?: () => void } | null>(null);
  const pausedPersistTargetKeyRef = useRef<string | null>(null);

  // 1. Restaurar carrito y ventas en pausa desde KV storage al iniciar / cambiar scope
  useEffect(() => {
    const scopeKey = `${storageKeys.cart}|${storageKeys.paused}`;
    if (syncHydratedScopeRef.current === scopeKey) {
      syncHydratedScopeRef.current = null;
      isRestored.current = true;
      return;
    }
    syncHydratedScopeRef.current = null;

    const resetIfNonEmpty = () => {
      if (itemsRef.current.length > 0) setItems([]);
      if (customerRef.current !== null) setCustomer(null);
      if (discountRef.current !== 0) setDiscountState(0);
      if (notesRef.current !== '') setNotes('');
      if (saleRequestIdRef.current !== null) setSaleRequestId(null);
      if (sourceQuoteIdRef.current !== null) setSourceQuoteId(null);
      if (invoiceIntentRef.current !== null) setInvoiceIntent(null);
      if (shippingAmountRef.current !== 0) setShippingAmountState(0);
      if (pausedSalesRef.current.length > 0) setPausedSales([]);
    };

    if (!accountId || !user?.uid) {
      isRestored.current = false;
      hydratedStorageKeyRef.current = null;
      hydratedTokenRef.current = null;
      resetIfNonEmpty();
      return;
    }

    const applyRestoredSnapshot = (
      parsedCart: ParsedCartSnapshot | null,
      parsedPaused: PausedSale[]
    ) => {
      const nextItems = parsedCart?.items ?? (itemsRef.current.length === 0 ? itemsRef.current : []);
      const nextCustomer = parsedCart?.customer ?? null;
      const nextDiscount = parsedCart?.discount ?? 0;
      const nextNotes = parsedCart?.notes ?? '';
      const nextSaleRequestId = parsedCart?.saleRequestId ?? null;
      const nextSourceQuoteId = parsedCart?.sourceQuoteId ?? null;
      const nextInvoiceIntent = parsedCart?.invoiceIntent ?? null;
      const nextShipping = parsedCart?.shippingAmount ?? 0;

      if (nextItems !== itemsRef.current) setItems(nextItems);
      if (customerRef.current !== nextCustomer) setCustomer(nextCustomer);
      if (discountRef.current !== nextDiscount) setDiscountState(nextDiscount);
      if (notesRef.current !== nextNotes) setNotes(nextNotes);
      if (saleRequestIdRef.current !== nextSaleRequestId) setSaleRequestId(nextSaleRequestId);
      if (sourceQuoteIdRef.current !== nextSourceQuoteId) setSourceQuoteId(nextSourceQuoteId);
      if (invoiceIntentRef.current !== nextInvoiceIntent) setInvoiceIntent(nextInvoiceIntent);
      if (shippingAmountRef.current !== nextShipping) setShippingAmountState(nextShipping);

      if (parsedPaused.length > 0 || pausedSalesRef.current.length > 0) {
        setPausedSales(parsedPaused);
      }

      hydratedStorageKeyRef.current = storageKeys.cart;
      hydratedTokenRef.current = {
        items: nextItems,
        customer: nextCustomer,
        discount: nextDiscount,
        notes: nextNotes,
        saleRequestId: nextSaleRequestId,
        sourceQuoteId: nextSourceQuoteId,
        invoiceIntent: nextInvoiceIntent,
        shippingAmount: nextShipping,
      };
    };

    if (cartKVStorage?.isSyncCapable) {
      try {
        const savedCartRaw = cartKVStorage.getItemSync(storageKeys.cart);
        const savedPausedRaw = cartKVStorage.getItemSync(storageKeys.paused);
        const parsedCart = parseCartSnapshot(savedCartRaw, branchId);
        const parsedPaused = parsePausedSalesSnapshot(savedPausedRaw, accountId, branchId);
        applyRestoredSnapshot(parsedCart, parsedPaused);
      } catch (err) {
        console.warn('[CartContext] Error restoring cart synchronously from storage:', err);
        resetIfNonEmpty();
      } finally {
        isRestored.current = true;
      }
      return;
    }

    let alive = true;
    isRestored.current = false;
    hydratedStorageKeyRef.current = null;
    hydratedTokenRef.current = null;
    resetIfNonEmpty();

    async function restoreCartData() {
      try {
        const [savedCartRaw, savedPausedRaw] = await Promise.all([
          cartKVStorage.getItem(storageKeys.cart),
          cartKVStorage.getItem(storageKeys.paused),
        ]);

        if (!alive) return;
        const parsedCart = parseCartSnapshot(savedCartRaw, branchId);
        const parsedPaused = parsePausedSalesSnapshot(savedPausedRaw, accountId || '', branchId);
        applyRestoredSnapshot(parsedCart, parsedPaused);
      } catch (err) {
        console.warn('[CartContext] Error restoring cart from storage:', err);
      } finally {
        if (alive) isRestored.current = true;
      }
    }

    void restoreCartData();
    return () => {
      alive = false;
    };
  }, [storageKeys.cart, storageKeys.paused, accountId, branchId, user?.uid]);

  // 2. Persistir carrito actual reactivamente con debounce (350ms) tras interacciones y payload ligero
  useEffect(() => {
    if (!isRestored.current) return;

    const hydratedToken = hydratedTokenRef.current;
    if (
      hydratedStorageKeyRef.current === storageKeys.cart &&
      hydratedToken &&
      Object.is(hydratedToken.items, items) &&
      Object.is(hydratedToken.customer, customer) &&
      Object.is(hydratedToken.discount, discount) &&
      Object.is(hydratedToken.notes, notes) &&
      Object.is(hydratedToken.saleRequestId, saleRequestId) &&
      Object.is(hydratedToken.sourceQuoteId, sourceQuoteId) &&
      Object.is(hydratedToken.invoiceIntent, invoiceIntent) &&
      Object.is(hydratedToken.shippingAmount, shippingAmount)
    ) {
      return;
    }

    hydratedTokenRef.current = null;

    if (
      items.length === 0 &&
      !customer &&
      !discount &&
      !notes &&
      !saleRequestId &&
      !sourceQuoteId &&
      !shippingAmount &&
      !invoiceIntent
    ) {
      cartKVStorage.removeItem(storageKeys.cart).catch(() => {});
      return;
    }

    let interactionTask: { cancel?: () => void } | undefined;
    const timer = setTimeout(() => {
      interactionTask = InteractionManager.runAfterInteractions(() => {
        // Omitir objeto pesado item.product en la serialización para máxima velocidad MMKV
        const lightweightItems = stripProductFromCartItems(items);

        const payload = JSON.stringify({
          items: lightweightItems,
          customer,
          discount,
          notes,
          saleRequestId,
          sourceQuoteId,
          ...(invoiceIntent ? { invoiceIntent } : {}),
          shippingAmount,
        });

        cartKVStorage.setItem(storageKeys.cart, payload).catch((err) => {
          console.warn('[CartContext] Error saving cart to storage:', err);
        });
      });
    }, 350);

    return () => {
      clearTimeout(timer);
      if (interactionTask?.cancel) interactionTask.cancel();
    };
  }, [
    items,
    customer,
    discount,
    notes,
    saleRequestId,
    sourceQuoteId,
    invoiceIntent,
    shippingAmount,
    storageKeys.cart,
  ]);

  // 3. Persistir lista de ventas en pausa cuando cambie (diferido tras animaciones/interacciones)
  const persistPausedSales = useCallback(
    async (list: PausedSale[]) => {
      setPausedSales(list);
      const targetKey = storageKeys.paused;
      if (
        pausedPersistTargetKeyRef.current === targetKey &&
        pausedPersistTaskRef.current?.cancel
      ) {
        pausedPersistTaskRef.current.cancel();
        pausedPersistTaskRef.current = null;
      }
      pausedPersistTargetKeyRef.current = targetKey;
      pausedPersistTaskRef.current = InteractionManager.runAfterInteractions(() => {
        if (pausedPersistTargetKeyRef.current === targetKey) {
          pausedPersistTaskRef.current = null;
        }
        const lightweightList = list.map((sale) => ({
          ...sale,
          items: stripProductFromCartItems(sale.items),
        }));
        cartKVStorage
          .setItem(targetKey, JSON.stringify(lightweightList))
          .catch(() => {});
      });
    },
    [storageKeys.paused]
  );

  // 4. Agregar producto al carrito resolviendo reglas de precios por sucursal/escala
  const addItem = useCallback(
    (product: Product, options: AddItemOptions = {}) => {
      const quantityToAdd = options.quantity !== undefined ? options.quantity : 1;
      const { presentation, variant, customPrice, isWeightBased, isGift } = options;
      const activeBranch = branchId || 'main';
      const minPriceEnabled =
        options.enableMinSalePrice !== undefined
          ? options.enableMinSalePrice
          : defaultMinPriceEnabled;

      // Disparar feedback háptico ligero
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

      // Generar ID único del ítem en carrito según variantes, presentaciones y condición de regalo
      const presentationKey = presentation?.id || 'base';
      const variantKey = variant?.id || 'base';
      const cartItemId = isGift
        ? `${product.id}_${presentationKey}_${variantKey}_gift`
        : `${product.id}_${presentationKey}_${variantKey}`;

      setItems((prevItems) => {
        const existingIndex = prevItems.findIndex((i) => i.id === cartItemId);

        if (existingIndex > -1) {
          const existingItem = prevItems[existingIndex];
          const newQty =
            product.allowDecimals || isWeightBased
              ? Math.round((existingItem.quantity + quantityToAdd) * 1000) / 1000
              : existingItem.quantity + quantityToAdd;

          let effectivePrice = existingItem.price;
          if (isGift || existingItem.isGift) {
            effectivePrice = 0;
          } else if (customPrice !== undefined) {
            effectivePrice = customPrice;
          } else if (!existingItem.modifiedPrice) {
            // Recalcular según nueva cantidad por escalas mayoristas (tiered pricing)
            effectivePrice = getEffectiveProductPrice(
              product,
              activeBranch,
              newQty,
              presentation,
              variant,
              minPriceEnabled
            );
          }

          const updatedItems = [...prevItems];
          updatedItems[existingIndex] = {
            ...existingItem,
            quantity: newQty,
            price: effectivePrice,
            lineTotal: Math.round(newQty * effectivePrice * 100) / 100,
            stockBranchId: existingItem.stockBranchId || activeBranch,
            notes: options.notes || existingItem.notes,
          };
          return updatedItems;
        }

        const regularUnitPrice = getEffectiveProductPrice(
          product,
          activeBranch,
          quantityToAdd,
          presentation,
          variant,
          minPriceEnabled
        );

        let initialPrice: number;
        if (isGift) {
          initialPrice = 0;
        } else if (customPrice !== undefined) {
          const floor = minPriceEnabled ? Number(product.minSalePrice ?? 0) : 0;
          initialPrice = floor > 0 ? Math.max(customPrice, floor) : customPrice;
        } else {
          initialPrice = regularUnitPrice;
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
          isGift: Boolean(isGift),
          originalPrice: isGift ? regularUnitPrice : undefined,
          priceModificationReason: isGift ? 'Regalo / Promoción' : undefined,
          customPrice: isGift ? 0 : customPrice,
          suggestedPrice: product.suggestedPrice ?? product.price,
          minSalePrice: presentation?.minSalePrice ?? product.minSalePrice,
          category: product.category,
          costPrice: product.costPrice,
          stock: product.stock,
          stockBranchId: activeBranch,
          imageUrl: product.thumbUrl || product.imageUrl,
          unitOfMeasure: product.unitOfMeasure || 'unit',
          allowDecimals: isDecimalsAllowed,
          stepDecimal: product.stepDecimal,
          presentationId: presentation?.id,
          presentationName: presentation?.name,
          presentationQty: presentationFactor(presentation),
          variantId: variant?.id,
          variantName: variant?.name,
          taxExemptionCode: product.taxExemptionCode,
          lineTotal: Math.round(quantityToAdd * initialPrice * 100) / 100,
        };

        return [...prevItems, newItem];
      });
    },
    [branchId, defaultMinPriceEnabled]
  );

  const addGiftItem = useCallback(
    (product: Product, options: Omit<AddItemOptions, 'isGift' | 'customPrice'> = {}) => {
      addItem(product, { ...options, isGift: true, customPrice: 0 });
    },
    [addItem]
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
            const activeBranch = item.stockBranchId || branchId || 'main';

            let unitPrice = item.price;
            if (item.isGift) {
              unitPrice = 0;
            } else if (!item.modifiedPrice) {
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

              unitPrice = getEffectiveProductPrice(
                productToUse,
                activeBranch,
                newQty,
                item.presentation,
                item.variant,
                defaultMinPriceEnabled
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
    [branchId, accountId, defaultMinPriceEnabled]
  );

  // 6. Actualizar precio unitario de un ítem con validación de piso (minSalePrice o costPrice)
  const updateItemPrice = useCallback(
    (cartItemId: string, newPrice: number, enableMinSalePrice: boolean = defaultMinPriceEnabled): boolean => {
      if (!Number.isFinite(newPrice) || newPrice < 0) return false;
      const target = itemsRef.current.find((i) => i.id === cartItemId);
      if (!target) return false;

      if (!target.isGift) {
        const floor = resolveCartItemMinPrice(target, enableMinSalePrice);
        if (floor > 0 && newPrice < floor) {
          console.warn(`[CartContext] Precio S/ ${newPrice} inferior al piso permitido de S/ ${floor}`);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
          return false;
        }
      }

      const rounded = Math.round(newPrice * 100) / 100;
      setItems((prevItems) =>
        prevItems.map((item) =>
          item.id === cartItemId
            ? {
                ...item,
                price: rounded,
                modifiedPrice: rounded,
                lineTotal: Math.round(item.quantity * rounded * 100) / 100,
              }
            : item
        )
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      return true;
    },
    [defaultMinPriceEnabled]
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
    setInvoiceIntent(null);
    setShippingAmountState(0);
    cartKVStorage.removeItem(storageKeys.cart).catch(() => {});
  }, [storageKeys.cart, setDiscount]);

  // 9. Ventas en Pausa (Hold Carts)
  const pauseCurrentSale = useCallback(
    async (label?: string): Promise<string | null> => {
      const currentItems = itemsRef.current;
      if (currentItems.length === 0) return null;

      const currentPaused = pausedSalesRef.current;
      const currentCustomer = customerRef.current;
      const currentDiscount = discountRef.current;
      const currentShipping = shippingAmountRef.current;

      const pausedId = `hold_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const defaultLabel =
        label ||
        (currentCustomer ? `Cliente: ${currentCustomer.name}` : `Venta en espera #${currentPaused.length + 1}`);

      let currentSubtotal = 0;
      const minimizedItems: CartItem[] = new Array(currentItems.length);
      for (let i = 0; i < currentItems.length; i += 1) {
        const item = currentItems[i];
        currentSubtotal += item.price * item.quantity;
        minimizedItems[i] = item.product
          ? { ...item, product: minimizeCartItemProduct(item.product) }
          : item;
      }
      const currentTotal = Math.max(0, currentSubtotal - currentDiscount) + currentShipping;

      const newPausedSale: PausedSale = {
        id: pausedId,
        label: defaultLabel,
        savedAt: Date.now(),
        items: minimizedItems,
        customer: currentCustomer,
        note: notesRef.current,
        branchId,
        accountId: accountId || undefined,
        total: Math.round(currentTotal * 100) / 100,
        sourceSaleRequestId: saleRequestIdRef.current,
        sourceQuoteId: sourceQuoteIdRef.current,
        shippingAmount: currentShipping,
        discountAmount: currentDiscount,
      };

      const updatedList = [newPausedSale, ...currentPaused];
      await persistPausedSales(updatedList);

      // Limpiar carrito actual para atender al siguiente cliente
      clearCart();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      return pausedId;
    },
    [branchId, accountId, persistPausedSales, clearCart]
  );

  // 10. Reanudar una venta en pausa
  const resumePausedSale = useCallback(
    async (pausedId: string): Promise<boolean> => {
      const currentPaused = pausedSalesRef.current;
      const target = currentPaused.find((s) => s.id === pausedId);
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
      const filtered = currentPaused.filter((s) => s.id !== pausedId);
      await persistPausedSales(filtered);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      return true;
    },
    [persistPausedSales, accountId, branchId, setDiscount, setShippingAmount]
  );

  // 11. Eliminar venta en pausa
  const deletePausedSale = useCallback(
    async (pausedId: string): Promise<boolean> => {
      const filtered = pausedSalesRef.current.filter((s) => s.id !== pausedId);
      await persistPausedSales(filtered);
      return true;
    },
    [persistPausedSales]
  );

  // 12. Helper para obtener cantidad ya existente de un producto en carrito
  const getItemQuantity = useCallback((productId: string): number => {
    const currentItems = itemsRef.current;
    let sum = 0;
    for (let i = 0; i < currentItems.length; i += 1) {
      const item = currentItems[i];
      if (item.id.startsWith(productId)) {
        sum += item.quantity;
      }
    }
    return sum;
  }, []);

  // 13. Cálculos financieros contables (IGV 18% incluido según normativa SUNAT Perú)
  const { subtotal, discountAmount, taxAmount, netAmount, total, totalItemsCount } =
    useMemo(() => {
      let calculatedSubtotal = 0;
      let count = 0;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        calculatedSubtotal += item.price * item.quantity;
        count += item.quantity;
      }

      const dAmount = Math.min(calculatedSubtotal, Math.max(0, discount));
      const calculatedItemsTotal = Math.max(0, calculatedSubtotal - dAmount);

      // En el sistema de facturación peruano (precios con IGV incluido):
      // Base imponible = Total / 1.18
      // IGV (18%) = Total - Base imponible
      const net = Math.round((calculatedItemsTotal / 1.18) * 100) / 100;
      const tax = Math.round((calculatedItemsTotal - net) * 100) / 100;

      return {
        subtotal: Math.round(calculatedSubtotal * 100) / 100,
        discountAmount: Math.round(dAmount * 100) / 100,
        taxAmount: tax,
        netAmount: net,
        total: Math.round((calculatedItemsTotal + shippingAmount) * 100) / 100,
        totalItemsCount: Math.round(count * 1000) / 1000,
      };
    }, [items, discount, shippingAmount]);

  const badgeCount = Math.round(totalItemsCount);

  const actionsValue = useMemo<CartActionsContextType>(
    () => ({
      setCustomer,
      setDiscount,
      setNotes,
      setSaleRequestId,
      setSourceQuoteId,
      setShippingAmount,
      setInvoiceIntent,
      addItem,
      addGiftItem,
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
      setDiscount,
      setShippingAmount,
      addItem,
      addGiftItem,
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

  const contextValue = useMemo(
    () => ({
      items,
      customer,
      discount,
      notes,
      saleRequestId,
      sourceQuoteId,
      shippingAmount,
      invoiceIntent,
      subtotal,
      discountAmount,
      taxAmount,
      netAmount,
      total,
      totalItemsCount,
      totalAmount: total,
      itemCount: totalItemsCount,
      pausedSales,
      ...actionsValue,
    }),
    [
      items,
      customer,
      discount,
      notes,
      saleRequestId,
      sourceQuoteId,
      shippingAmount,
      invoiceIntent,
      subtotal,
      discountAmount,
      taxAmount,
      netAmount,
      total,
      totalItemsCount,
      pausedSales,
      actionsValue,
    ]
  );

  return (
    <CartBadgeContext.Provider value={badgeCount}>
      <CartActionsContext.Provider value={actionsValue}>
        <CartContext.Provider value={contextValue}>{children}</CartContext.Provider>
      </CartActionsContext.Provider>
    </CartBadgeContext.Provider>
  );
};

export const useCart = () => useContext(CartContext);
export const useCartActions = () => useContext(CartActionsContext);
export const useCartBadgeCount = (): number => useContext(CartBadgeContext);
