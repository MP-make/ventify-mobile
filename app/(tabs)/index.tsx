import { reservationCartLines } from '@/lib/presentation-parity';
import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  Search,
  Camera,
  CameraOff,
  Zap,
  ZapOff,
  Pause,
  Play,
  Scale,
  Plus,
  Minus,
  Trash2,
  Maximize2,
  Flashlight,
  FlashlightOff,
  ChevronUp,
  ChevronDown,
  ShoppingBag,
  X,
  Clock,
  Edit3,
  Layers,
  ArrowRight,
  Package,
  FileText,
  Laptop,
  Barcode,
  Tag,
  Check,
  CheckCircle2,
  CalendarClock,
  User,
  Gift,
  Sparkles,
} from 'lucide-react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { useIsFocused } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import NetInfo from '@react-native-community/netinfo';

import { useCart } from '@/context/CartContext';
import { useProducts } from '@/context/ProductsContext';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { formatPEN, ui } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { PresentationVariantModal } from '@/components/PresentationVariantModal';
import { WeightQuantityModal } from '@/components/WeightQuantityModal';
import { CheckoutModal } from '@/components/CheckoutModal';
import { CompanionScannerModal } from '@/components/CompanionScannerModal';
import { QuotesManagerModal } from '@/components/QuotesManagerModal';
import { InlineFilterBar, FilterGroup } from '@/components/InlineFilterBar';
import { createReservationOrOrder } from '@/services/crm-operations-service';
import { createSaleTransaction, type CreateSaleTransactionParams } from '@/services/sale-service';
import { enqueueOfflineSale } from '@/services/offline-sync-service';
import { lookupDocument } from '@/lib/dni-ruc-service';
import { isValidDNI } from '@/lib/invoicing/types';
import { computeSaleTaxBreakdown } from '@/lib/invoicing/receipt-amounts';
import {
  resolveCartItemMinPrice,
  getEligibleGiftProducts,
  evaluateCartPromotions,
  cartHasPlasticBagProducts,
  parseNormalizedDecimal,
  resolveProductBranchStock,
  ICBPER_BAG_FEE,
  ICBPER_CART_ITEM_ID,
} from '@/lib/product-search';
import { resolveCheckoutPayment } from '@/lib/checkout-payment';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { presentationFactor } from '@/lib/presentation-parity';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';
import {
  DEFAULT_CATALOG_BRANDS,
  DEFAULT_CATALOG_SIZES,
  mergeCatalogOptions,
  filterCatalogIndex,
  getCatalogCategoryCounts,
} from '@/lib/catalog-filters';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { catalogSizeInput } from '@/lib/product-attributes';
import type { Product, CartItem, PausedSale, ProductPresentation } from '@/types';

const BARCODE_SCANNER_SETTINGS: any = {
  barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e'],
};

export const triggerScanHaptic = () => {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

interface PosProductCardProps {
  item: Product;
  stock: number;
  showAttributes?: boolean;
  onSelect: (product: Product) => void;
}

const PosProductCard = React.memo<PosProductCardProps>(({ item, stock, showAttributes = false, onSelect }) => {
  const minStock = (item as any).minStock || 3;
  const isOutOfStock = stock <= 0;
  const isLowStock = stock > 0 && stock <= minStock;
  const price = Number(item.suggestedPrice ?? item.price ?? 0);
  const formattedPrice = formatPEN(price);
  const brandLabel = showAttributes ? (item.brand || '').trim() : '';
  const sizeLabel = showAttributes ? catalogSizeInput(item).trim() : '';

  return (
    <TouchableOpacity
      style={styles.productCard}
      onPress={() => onSelect(item)}
      accessibilityRole="button"
      accessibilityLabel={`Agregar ${item.name}, ${formattedPrice}${isOutOfStock ? ', agotado' : `, stock ${stock}`}`}
      activeOpacity={0.7}
    >
      <View style={styles.productInfo}>
        <Text style={styles.productName} numberOfLines={1}>
          {item.name}
        </Text>
        <View style={styles.productMetaRow}>
          <Text style={styles.productSku}>{item.sku || item.barcode || 'General'}</Text>
          <View
            style={[
              styles.stockBadge,
              isOutOfStock && styles.stockBadgeRed,
              isLowStock && styles.stockBadgeAmber,
              !isOutOfStock && !isLowStock && styles.stockBadgeGreen,
            ]}
          >
            <Text
              style={[
                styles.stockBadgeText,
                isOutOfStock && styles.stockBadgeTextRed,
                isLowStock && styles.stockBadgeTextAmber,
                !isOutOfStock && !isLowStock && styles.stockBadgeTextGreen,
              ]}
            >
              {isOutOfStock ? 'Agotado' : isLowStock ? `Bajo: ${stock}` : `Stock: ${stock}`}
            </Text>
          </View>
        </View>
        {(brandLabel || sizeLabel) ? (
          <Text style={styles.productAttrText} numberOfLines={1}>
            {[brandLabel ? `Marca: ${brandLabel}` : '', sizeLabel ? `Medida: ${sizeLabel}` : ''].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>

      <View style={styles.productPriceCol}>
        <Text style={styles.productPrice}>{formattedPrice}</Text>
        <View style={styles.addPlusBtn}>
          <Plus size={16} color={ui.onPrimary} />
        </View>
      </View>
    </TouchableOpacity>
  );
});

interface CartItemRowProps {
  item: CartItem;
  isEditingPrice: boolean;
  newPriceStr: string;
  canModifyPrice: boolean;
  onUpdateQuantity: (id: string, qty: number) => void;
  onRemoveItem: (id: string) => void;
  onStartEditPrice: (item: CartItem) => void;
  onChangeNewPrice: (val: string) => void;
  onSavePrice: (item: CartItem) => void;
}

const CartItemRow = React.memo<CartItemRowProps>(({
  item,
  isEditingPrice,
  newPriceStr,
  canModifyPrice,
  onUpdateQuantity,
  onRemoveItem,
  onStartEditPrice,
  onChangeNewPrice,
  onSavePrice,
}) => {
  const itemPrice = item.price;
  const itemSubtotal = item.lineTotal !== undefined ? item.lineTotal : itemPrice * item.quantity;

  return (
    <View style={styles.drawerCartItem}>
      <View style={styles.drawerCartItemTop}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={styles.drawerCartItemName}>{item.name}</Text>
            {item.isGift ? (
              <View style={styles.giftBadgePill}>
                <Gift size={10} color={ui.primary} />
                <Text style={styles.giftBadgePillText}>REGALO</Text>
              </View>
            ) : null}
          </View>
          {item.presentation ? (
            <Text style={styles.drawerCartItemSub}>
              Pres: {item.presentation.name} (x{item.presentation.conversionFactor})
            </Text>
          ) : item.variant ? (
            <Text style={styles.drawerCartItemSub}>Var: {item.variant.name}</Text>
          ) : null}
        </View>
        <Text style={styles.drawerCartItemSubtotal}>
          {item.isGift ? 'GRATIS' : formatPEN(itemSubtotal)}
        </Text>
      </View>

      {/* Fila de Controles de Cantidad y Precio */}
      <View style={styles.drawerCartItemControls}>
        {/* Selector de Cantidad */}
        <View style={styles.qtyControlRow}>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={() => onUpdateQuantity(item.id, item.quantity - 1)}
            accessibilityRole="button"
            accessibilityLabel={`Reducir cantidad de ${item.name}`}
          >
            <Minus size={15} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.qtyNumberText}>{item.quantity}</Text>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={() => onUpdateQuantity(item.id, item.quantity + 1)}
            accessibilityRole="button"
            accessibilityLabel={`Aumentar cantidad de ${item.name}`}
          >
            <Plus size={15} color={ui.text} />
          </TouchableOpacity>
        </View>

        {/* Editor de Precio Unitario */}
        {item.isGift ? (
          <View style={styles.unitPriceBadge}>
            <Text style={[styles.unitPriceBadgeText, { color: ui.primary }]}>
              S/ 0.00 (Regalo)
            </Text>
          </View>
        ) : isEditingPrice ? (
          <View style={styles.editPriceInputRow}>
            <TextInput
              style={styles.editPriceInput}
              value={newPriceStr}
              onChangeText={onChangeNewPrice}
              keyboardType="decimal-pad"
              placeholder="0.00"
              autoFocus
            />
            <TouchableOpacity
              style={styles.savePriceBtn}
              onPress={() => onSavePrice(item)}
            >
              <Text style={styles.savePriceBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        ) : canModifyPrice ? (
          <TouchableOpacity
            style={styles.unitPriceBadge}
            accessibilityRole="button"
            accessibilityLabel={`Editar precio de ${item.name}, ${formatPEN(itemPrice)} por ${item.unitOfMeasure || 'unidad'}`}
            onPress={() => onStartEditPrice(item)}
          >
            <Text style={styles.unitPriceBadgeText}>
              {formatPEN(itemPrice)} / {item.unitOfMeasure || 'und'}
            </Text>
            <Edit3 size={12} color={ui.textSecondary} style={{ marginLeft: 4 }} />
          </TouchableOpacity>
        ) : (
          <View style={styles.unitPriceBadge}>
            <Text style={styles.unitPriceBadgeText}>
              {formatPEN(itemPrice)} / {item.unitOfMeasure || 'und'}
            </Text>
          </View>
        )}

        {/* Eliminar Ítem */}
        <TouchableOpacity
          style={styles.deleteItemBtn}
          onPress={() => onRemoveItem(item.id)}
          accessibilityRole="button"
          accessibilityLabel={`Quitar ${item.name} del carrito`}
        >
          <Trash2 size={16} color={ui.danger} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default function PosCounterScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { branchId, accountId, user, userProfile } = useAuth();
  const scanScope = `${user?.uid}:${accountId}:${branchId}`;
  const scanScopeRef = useRef(scanScope);
  const scanLookupInFlight = useRef(false);
  scanScopeRef.current = scanScope;
  useEffect(() => {
    scanScopeRef.current = scanScope;
    return () => { scanScopeRef.current = ''; };
  }, [scanScope]);
  const {
    posSettings,
    discountSettings,
    activeCashSession,
    businessSettings,
    activeBranch,
    paymentMethods,
    invoicingEnabled,
    taxProfile,
    isOnline: settingsIsOnline,
    refreshOfflineCount,
  } = useSettings();
  const { canModifyPrice } = usePermissions();
  const {
    products,
    productsById,
    catalogIndex,
    categories,
    loading: productsLoading,
    refreshing,
    catalogComplete,
    error: productsError,
    refreshProducts,
    findByBarcode,
    findByBarcodeRemote,
    getProductStock,
  } = useProducts();
  const {
    items,
    customer,
    subtotal: cartSubtotal,
    discountAmount,
    shippingAmount,
    invoiceIntent,
    saleRequestId,
    sourceQuoteId,
    total,
    totalAmount,
    itemCount,
    totalItemsCount,
    pausedSales,
    addItem,
    addGiftItem,
    updateQuantity,
    updateItemPrice,
    setDiscount,
    setCustomer,
    setInvoiceIntent,
    removeItem,
    clearCart,
    pauseCurrentSale,
    resumePausedSale,
    deletePausedSale,
  } = useCart();

  const safeTotal = totalAmount ?? total ?? 0;
  const formattedTotal = formatPEN(safeTotal);
  const safeCount = itemCount ?? totalItemsCount ?? 0;

  // 1. Buscador, Categorías y Filtros de Catálogo
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [selectedBrand, setSelectedBrand] = useState('Todas');
  const [selectedSize, setSelectedSize] = useState('Todas');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [fullscreenScannerOpen, setFullscreenScannerOpen] = useState(false);
  const lastScannedCodeRef = useRef<string>('');
  const scanCooldownRef = useRef<boolean>(false);
  const scanCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isFocused) {
      setIsCameraActive(false);
      setTorchOn(false);
    }
  }, [isFocused]);

  useEffect(() => {
    return () => {
      if (scanCooldownTimerRef.current) {
        clearTimeout(scanCooldownTimerRef.current);
      }
    };
  }, []);

  // Modal Reserva
  const [reservationModalOpen, setReservationModalOpen] = useState(false);
  const [resCustomerName, setResCustomerName] = useState('');
  const [resCustomerPhone, setResCustomerPhone] = useState('');
  const [resCustomerDoc, setResCustomerDoc] = useState('');
  const [resDepositStr, setResDepositStr] = useState('');
  const [resDepositMethod, setResDepositMethod] = useState<'cash' | 'yape' | 'plin' | 'card'>('cash');
  const [resDays, setResDays] = useState('7');
  const [resNotes, setResNotes] = useState('');
  const [isSavingRes, setIsSavingRes] = useState(false);
  const [isSearchingDni, setIsSearchingDni] = useState(false);
  const [createdResTicket, setCreatedResTicket] = useState<any | null>(null);
  const [resTicketModalOpen, setResTicketModalOpen] = useState(false);

  // Detección automática de DNI al ingresar 8 dígitos con debounce de 250ms
  React.useEffect(() => {
    const cleanDni = resCustomerDoc.trim().replace(/\D/g, '');
    if (cleanDni.length === 8 && isValidDNI(cleanDni)) {
      const timer = setTimeout(() => {
        setIsSearchingDni(true);
        lookupDocument('dni', cleanDni)
          .then((res) => {
            if (res && res.name) {
              setResCustomerName(res.name);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          })
          .catch(() => {})
          .finally(() => setIsSearchingDni(false));
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [resCustomerDoc]);

  // 2. Modales Especiales
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [variantModalProduct, setVariantModalProduct] = useState<Product | null>(null);
  const [weightModalProduct, setWeightModalProduct] = useState<Product | null>(null);
  const [weightSelectorOpen, setWeightSelectorOpen] = useState(false);
  const [companionScannerOpen, setCompanionScannerOpen] = useState(false);
  const [quotesModalOpen, setQuotesModalOpen] = useState(false);
  const [promoModalOpen, setPromoModalOpen] = useState(false);
  const [giftSearchQuery, setGiftSearchQuery] = useState('');

  // 3. Venta Rápida (Concepto Libre) y Venta Rápida Express (1 toque)
  const [quickSaleModalOpen, setQuickSaleModalOpen] = useState(false);
  const [quickConcept, setQuickConcept] = useState('Venta Rápida');
  const [quickAmountStr, setQuickAmountStr] = useState('');
  const [isProcessingQuickSale, setIsProcessingQuickSale] = useState(false);
  const [quickSaleBanner, setQuickSaleBanner] = useState<{ text: string; isOffline?: boolean } | null>(null);
  const quickSaleInFlightRef = useRef(false);
  const quickSaleBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (quickSaleBannerTimerRef.current) {
        clearTimeout(quickSaleBannerTimerRef.current);
      }
    };
  }, []);

  // 4. Ventas en Pausa
  const [pausedModalOpen, setPausedModalOpen] = useState(false);

  // 5. Drawer del Carrito
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [editingPriceItemId, setEditingPriceItemId] = useState<string | null>(null);
  const [newPriceStr, setNewPriceStr] = useState('');
  const newPriceStrRef = useRef(newPriceStr);
  newPriceStrRef.current = newPriceStr;
  const [drawerDiscountStr, setDrawerDiscountStr] = useState('');
  const [showDrawerDiscount, setShowDrawerDiscount] = useState(false);

  // Promociones, regalos e ICBPER
  const eligibleGiftProducts = useMemo(() => {
    if (!promoModalOpen) return [];
    return getEligibleGiftProducts(products, discountSettings, branchId || 'main');
  }, [promoModalOpen, products, discountSettings, branchId]);
  const filteredGiftProducts = useMemo(() => {
    if (!promoModalOpen) return [];
    const q = giftSearchQuery.trim().toLowerCase();
    if (!q) return eligibleGiftProducts.slice(0, 40);
    return eligibleGiftProducts
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          String(p.sku || '').toLowerCase().includes(q) ||
          String(p.category || '').toLowerCase().includes(q)
      )
      .slice(0, 40);
  }, [promoModalOpen, eligibleGiftProducts, giftSearchQuery]);
  const weighableProducts = useMemo(() => {
    if (!weightSelectorOpen) return [];
    return products.filter(
      (p) =>
        p.allowDecimals ||
        p.unitOfMeasure === 'kg' ||
        p.unitOfMeasure === 'KGM' ||
        (p as any).unit === 'kg'
    );
  }, [weightSelectorOpen, products]);
  const promoSuggestions = useMemo(() => {
    if (items.length === 0 || (!cartDrawerOpen && !promoModalOpen)) return [];
    return evaluateCartPromotions(items, discountSettings?.promotions, products, productsById);
  }, [items, cartDrawerOpen, promoModalOpen, discountSettings?.promotions, products, productsById]);
  const hasBagOrPlasticItem = useMemo(() => {
    if (items.length === 0 || !cartDrawerOpen) return false;
    return cartHasPlasticBagProducts(items);
  }, [items, cartDrawerOpen]);
  const icbperCartItem = useMemo(
    () => items.find((i) => i.id.startsWith(ICBPER_CART_ITEM_ID)),
    [items]
  );

  const handleToggleIcbper = useCallback(() => {
    if (icbperCartItem) {
      removeItem(icbperCartItem.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    }
    const bagProduct: Product = {
      id: ICBPER_CART_ITEM_ID,
      name: 'Bolsa Plástica (ICBPER)',
      category: 'Impuesto ICBPER',
      sku: 'ICBPER',
      suggestedPrice: ICBPER_BAG_FEE,
      price: ICBPER_BAG_FEE,
      costPrice: 0,
      minSalePrice: 0,
      stock: { [branchId || 'main']: 99999 },
      accountId: accountId || 'default',
      taxExemptionCode: '30',
    };
    addItem(bagProduct, { quantity: 1, customPrice: ICBPER_BAG_FEE });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [icbperCartItem, removeItem, addItem, branchId, accountId]);

  // Activar visor de cámara embebida
  const toggleInlineCamera = async () => {
    if (!isCameraActive) {
      if (!cameraPermission?.granted) {
        const res = await requestCameraPermission();
        if (!res.granted) {
          Alert.alert('Cámara Requerida', 'Se requiere permiso de cámara para el escáner POS.');
          return;
        }
      }
      setIsCameraActive(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      setIsCameraActive(false);
      setTorchOn(false);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // Manejo centralizado al escanear un código
  const handleBarcodeDetected = useCallback(
    async (code: string) => {
      const requestScope = scanScope;
      const cleanCode = code.trim();
      if (!cleanCode || scanCooldownRef.current || scanLookupInFlight.current) return;

      scanCooldownRef.current = true;
      if (scanCooldownTimerRef.current) {
        clearTimeout(scanCooldownTimerRef.current);
      }
      scanCooldownTimerRef.current = setTimeout(() => {
        scanCooldownRef.current = false;
        lastScannedCodeRef.current = '';
        scanCooldownTimerRef.current = null;
      }, 1200);

      let match = findByBarcode(cleanCode);
      if (!match) {
        scanLookupInFlight.current = true;
        try { match = await findByBarcodeRemote(cleanCode); }
        catch {
          if (scanScopeRef.current === requestScope) Alert.alert('No se pudo consultar el catálogo', 'Comprueba tu conexión y vuelve a escanear.');
          return;
        } finally { scanLookupInFlight.current = false; }
      }
      if (scanScopeRef.current !== requestScope) return;
      if (!match) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Código no Encontrado', `No se encontró producto con código o SKU: ${cleanCode}`);
        return;
      }

      const { product, matchedPresentation, matchedVariant } = match;

      // 1. Si se escaneó un código propio de presentación
      if (matchedPresentation) {
        triggerScanHaptic();
        addItem(product, {
          presentation: matchedPresentation,
          quantity: 1,
        });
        return;
      }

      // 2. Si se escaneó un código propio de variante
      if (matchedVariant) {
        triggerScanHaptic();
        addItem(product, {
          variant: matchedVariant,
          quantity: 1,
        });
        return;
      }

      // 3. Si tiene múltiples presentaciones o variantes configuradas
      const hasPresentations = Array.isArray(product.presentations) && product.presentations.length > 0;
      const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
      if (hasPresentations || hasVariants) {
        setVariantModalProduct(product);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }

      // 4. Si es por peso / fracción
      const isWeighable =
        product.allowDecimals ||
        product.unitOfMeasure === 'kg' ||
        product.unitOfMeasure === 'KGM' ||
        (product as any).unit === 'kg' ||
        (product as any).unit === 'kilo';

      if (isWeighable) {
        setWeightModalProduct(product);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }

      // 5. Agregar directo
      triggerScanHaptic();
      addItem(product, { quantity: 1 });
    },
    [findByBarcode, findByBarcodeRemote, addItem, scanScope]
  );

  // Escaneo desde la cámara embebida
  const handleCameraScan = useCallback((result: BarcodeScanningResult) => {
    if (result.data && (!scanCooldownRef.current || result.data !== lastScannedCodeRef.current)) {
      lastScannedCodeRef.current = result.data;
      handleBarcodeDetected(result.data);
    }
  }, [handleBarcodeDetected]);

  const enableCatalogFilters = !!posSettings?.enableCatalogFilters;
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 150);

  // Marcas únicas del catálogo (incluye atributos y marcas predeterminadas como en la web)
  const availableBrands = useMemo(() => {
    return ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_BRANDS, catalogIndex.brands)];
  }, [catalogIndex]);

  // Tallas / Medidas únicas del catálogo
  const availableSizes = useMemo(() => {
    return ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_SIZES, catalogIndex.sizes)];
  }, [catalogIndex]);

  // Filtrado de productos por categoría, marca, talla y texto (insensible a tildes)
  const filteredProducts = useMemo(() => filterCatalogIndex(catalogIndex, {
    query: debouncedSearchQuery,
    category: selectedCategory,
    brand: selectedBrand,
    size: selectedSize,
  }), [catalogIndex, debouncedSearchQuery, selectedCategory, selectedBrand, selectedSize]);

  // Lista de categorías con conteo de productos
  const categoryListWithCounts = useMemo(() => {
    return getCatalogCategoryCounts(categories, catalogIndex).map((option) => ({
      ...option,
      count: catalogComplete ? option.count : undefined,
    }));
  }, [categories, catalogIndex, catalogComplete]);

  const brandOptions = useMemo(() => availableBrands.map((b) => ({ name: b })), [availableBrands]);
  const sizeOptions = useMemo(() => availableSizes.map((s) => ({ name: s })), [availableSizes]);

  const posFilterGroups: FilterGroup[] = useMemo(() => [
    {
      id: 'category',
      label: 'Categorías',
      selectedValue: selectedCategory,
      options: categoryListWithCounts,
      onSelect: (cat) => setSelectedCategory(cat),
      onClear: () => setSelectedCategory('Todas'),
      icon: 'category',
    },
    {
      id: 'brand',
      label: 'Marcas',
      selectedValue: selectedBrand,
      options: brandOptions,
      onSelect: (b: string) => setSelectedBrand(b),
      onClear: () => setSelectedBrand('Todas'),
      icon: 'brand' as const,
    },
    {
      id: 'size',
      label: 'Medidas',
      selectedValue: selectedSize,
      options: sizeOptions,
      onSelect: (s: string) => setSelectedSize(s),
      onClear: () => setSelectedSize('Todas'),
      icon: 'size' as const,
    },
  ], [selectedCategory, categoryListWithCounts, selectedBrand, brandOptions, selectedSize, sizeOptions]);

  // Confirmar y Guardar Reserva desde POS
  const handleConfirmReservation = async () => {
    if (!resCustomerName.trim()) {
      Alert.alert('Datos Incompletos', 'Por favor ingresa el nombre del cliente para la reserva.');
      return;
    }
    if (items.length === 0) {
      Alert.alert('Carrito Vacío', 'Agrega productos para reservar.');
      return;
    }

    const depositNum = parseNormalizedDecimal(resDepositStr);
    if (depositNum < 0) {
      Alert.alert('Monto Inválido', 'El adelanto no puede ser negativo.');
      return;
    }
    if (depositNum > safeTotal) {
      Alert.alert('Adelanto Excedido', 'El adelanto no puede ser mayor al total de la reserva.');
      return;
    }

    try {
      if (!accountId || !branchId) throw new Error('No se pudo determinar la cuenta y sucursal.');
      setIsSavingRes(true);
      const days = parseInt(resDays, 10) || 7;
      const pickupDate = new Date();
      pickupDate.setDate(pickupDate.getDate() + days);
      const pad = (n: number) => String(n).padStart(2, '0');
      const pickupDateStr = `${pickupDate.getFullYear()}-${pad(pickupDate.getMonth() + 1)}-${pad(pickupDate.getDate())}`;

      const reservationId = await createReservationOrOrder({
        accountId: accountId!,
        branchId,
        sessionId: activeCashSession?.sessionId || (activeCashSession as any)?.id,
        type: 'reservation',
        items: reservationCartLines(items),
        total: safeTotal,
        depositAmount: depositNum,
        paymentMethod: depositNum > 0 ? resDepositMethod : 'cash',
        customer: {
          name: resCustomerName.trim(),
          phone: resCustomerPhone.trim() || undefined,
          documentNumber: resCustomerDoc.trim() || undefined,
        },
        pickupDate: pickupDateStr,
        notes: resNotes.trim() || undefined,
        userProfile: {
          uid: user?.uid || 'user_pos',
          displayName: userProfile?.displayName || user?.displayName || 'Vendedor',
          email: user?.email || '',
        },
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const newResObj = {
        id: reservationId,
        accountId: accountId!,
        branchId,
        type: 'reservation',
        items: items.map((it) => ({
          productId: it.id,
          productName: it.name,
          quantity: it.quantity,
          price: it.price,
        })),
        total: safeTotal,
        depositAmount: depositNum,
        remainingAmount: Math.max(0, safeTotal - depositNum),
        depositPaymentMethod: depositNum > 0 ? resDepositMethod : undefined,
        status: 'pending',
        customer: {
          name: resCustomerName.trim(),
          phone: resCustomerPhone.trim() || undefined,
          documentNumber: resCustomerDoc.trim() || undefined,
        },
        pickupDate: pickupDateStr,
        notes: resNotes.trim() || undefined,
        createdAt: Date.now(),
      };

      setCreatedResTicket(newResObj);
      setReservationModalOpen(false);
      setCartDrawerOpen(false);
      clearCart();
      setResCustomerName('');
      setResCustomerPhone('');
      setResCustomerDoc('');
      setResDepositStr('');
      setResNotes('');
      setResTicketModalOpen(true);
    } catch (err: any) {
      Alert.alert('Error al Reservar', err?.message || 'No se pudo crear la reserva.');
    } finally {
      setIsSavingRes(false);
    }
  };

  // Selección manual de producto desde el catálogo
  const handleProductSelect = useCallback((product: Product) => {
    const hasPresentations = Array.isArray(product.presentations) && product.presentations.length > 0;
    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    const isWeighable =
      product.allowDecimals ||
      product.unitOfMeasure === 'kg' ||
      product.unitOfMeasure === 'KGM' ||
      (product as any).unit === 'kg';

    if (hasPresentations || hasVariants) {
      setVariantModalProduct(product);
    } else if (isWeighable) {
      setWeightModalProduct(product);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      addItem(product, { quantity: 1 });
    }
  }, [addItem]);

  const keyExtractor = useCallback((item: Product) => item.id, []);
  const getItemType = useCallback(
    (item: Product) => (enableCatalogFilters && (item.brand || catalogSizeInput(item)) ? 'product_attr' : 'product'),
    [enableCatalogFilters]
  );
  const renderPosItem = useCallback(({ item }: { item: Product }) => (
    <PosProductCard
      item={item}
      stock={getProductStock(item)}
      showAttributes={enableCatalogFilters}
      onSelect={handleProductSelect}
    />
  ), [getProductStock, enableCatalogFilters, handleProductSelect]);

  const handleUpdateCartQty = useCallback((id: string, qty: number) => {
    updateQuantity(id, qty);
  }, [updateQuantity]);

  const handleRemoveCartItem = useCallback((id: string) => {
    removeItem(id);
  }, [removeItem]);

  const handleStartEditPrice = useCallback((cartItem: CartItem) => {
    setEditingPriceItemId(cartItem.id);
    setNewPriceStr(String(cartItem.price));
  }, []);

  const enableMinSalePrice =
    posSettings?.enableMinSalePrice !== false &&
    businessSettings?.enableMinSalePrice !== false;

  // Guardar Nuevo Precio Editado
  const handleSaveItemPrice = useCallback((item: CartItem) => {
    const priceVal = parseNormalizedDecimal(newPriceStrRef.current);
    if (isNaN(priceVal) || priceVal <= 0) {
      Alert.alert('Precio Inválido', 'Ingresa un precio válido en soles.');
      return;
    }

    const minFloor = resolveCartItemMinPrice(item, enableMinSalePrice);
    if (minFloor > 0 && priceVal < minFloor) {
      Alert.alert(
        'Precio Mínimo no Permitido',
        `El precio no puede ser menor al precio mínimo autorizado (${formatPEN(minFloor)}).`
      );
      return;
    }

    const ok = updateItemPrice(item.id, priceVal, enableMinSalePrice);
    if (ok) {
      setEditingPriceItemId(null);
      setNewPriceStr('');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [enableMinSalePrice, updateItemPrice]);

  const cartKeyExtractor = useCallback((item: CartItem) => item.id, []);
  const renderCartItem = useCallback(({ item }: { item: CartItem }) => {
    const isEditing = editingPriceItemId === item.id;
    return (
      <CartItemRow
        item={item}
        isEditingPrice={isEditing}
        newPriceStr={isEditing ? newPriceStr : ''}
        canModifyPrice={canModifyPrice}
        onUpdateQuantity={handleUpdateCartQty}
        onRemoveItem={handleRemoveCartItem}
        onStartEditPrice={handleStartEditPrice}
        onChangeNewPrice={setNewPriceStr}
        onSavePrice={handleSaveItemPrice}
      />
    );
  }, [
    editingPriceItemId,
    newPriceStr,
    canModifyPrice,
    handleUpdateCartQty,
    handleRemoveCartItem,
    handleStartEditPrice,
    handleSaveItemPrice,
  ]);

  // Confirmar Venta Rápida (concepto libre)
  const handleConfirmQuickSale = () => {
    const amountNum = parseNormalizedDecimal(quickAmountStr);
    if (!quickConcept.trim() || isNaN(amountNum) || amountNum <= 0) {
      Alert.alert('Datos Inválidos', 'Ingresa un concepto y un importe en soles mayor a S/ 0.00.');
      return;
    }

    const quickProduct: Product = {
      id: `quick_${Date.now()}`,
      name: quickConcept.trim(),
      category: 'Venta Rápida',
      sku: 'QUICK',
      suggestedPrice: amountNum,
      price: amountNum,
      costPrice: 0,
      minSalePrice: 0,
      stock: { [branchId]: 9999 },
      accountId: accountId || 'default',
    };

    addItem(quickProduct, { quantity: 1, customPrice: amountNum });
    setQuickConcept('Venta Rápida');
    setQuickAmountStr('');
    setQuickSaleModalOpen(false);
    triggerScanHaptic();
  };

  // Pausar Carrito Actual
  const handlePauseCurrentSale = async () => {
    if (items.length === 0) {
      Alert.alert('Carrito Vacío', 'Agrega productos antes de pausar la venta.');
      return;
    }
    const customerName = customer?.name?.trim();
    const itemsCountStr = `${items.length} ${items.length === 1 ? 'ítem' : 'ítems'}`;
    const label = customerName
      ? `${customerName} (${itemsCountStr})`
      : `Cuenta ${pausedSales.length + 1} (${itemsCountStr})`;

    await pauseCurrentSale(label);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Venta en Espera', `La cuenta "${label}" ha sido retenida.`);
  };

  // Reanudar Venta Pausada
  const handleResumePausedSale = async (id: string) => {
    await resumePausedSale(id);
    setPausedModalOpen(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // Venta Rápida Express (1 toque: Efectivo exacto -> Nota de Venta sin abrir comprobante)
  const handleInstantQuickSale = async () => {
    if (quickSaleInFlightRef.current || items.length === 0 || safeTotal <= 0 || !accountId) return;
    if (posSettings?.enableQuickSale === false) return;

    if (invoiceIntent && invoiceIntent !== 'nota_venta') {
      Alert.alert(
        'Comprobante Seleccionado',
        'La Venta Rápida solo emite Nota de Venta en efectivo. Para emitir Boleta, Factura o Cotización pulsa "Cobrar".',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Ir a Cobrar',
            onPress: () => {
              setCartDrawerOpen(false);
              setCheckoutModalOpen(true);
            },
          },
        ]
      );
      return;
    }

    if ((posSettings as any)?.requireCashRegister !== false && !activeCashSession) {
      Alert.alert('Caja Cerrada', 'Abre un turno de caja para usar Venta Rápida o usa Cobrar.');
      return;
    }

    if (posSettings?.enableSellerAttribution === true && posSettings?.requireSellerSelection === true) {
      Alert.alert(
        'Vendedor Requerido',
        'Esta cuenta requiere elegir vendedor antes de cobrar.',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Ir a Cobrar',
            onPress: () => {
              setCartDrawerOpen(false);
              setCheckoutModalOpen(true);
            },
          },
        ]
      );
      return;
    }

    quickSaleInFlightRef.current = true;
    setIsProcessingQuickSale(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const configuredMethodsRaw =
        Array.isArray(posSettings?.methods) && posSettings.methods.length > 0
          ? posSettings.methods
          : Array.isArray(paymentMethods) && paymentMethods.length > 0
          ? paymentMethods
          : [{ id: 'efectivo', name: 'Efectivo', kind: 'cash', enabled: true, order: 0 }];

      const configuredMethods = configuredMethodsRaw.map((m: any) => ({
        ...m,
        reportCategory:
          m.reportCategory ||
          (m.kind === 'terminal' || m.kind === 'mixed'
            ? 'card'
            : m.kind === 'credit'
            ? 'credit'
            : m.kind === 'digital'
            ? 'digital'
            : 'cash'),
      }));

      const cashMethod = configuredMethods.find(
        (m: any) => m.enabled !== false && (m.kind === 'cash' || String(m.id).toLowerCase() === 'efectivo')
      );
      const selectedMethodId = cashMethod?.id || 'efectivo';
      const payment = resolveCheckoutPayment({
        methods: configuredMethods,
        selectedMethodId,
        category: 'cash',
        total: safeTotal,
      });

      const saleItems = cleanFirestoreData(
        items.map((i) => {
          const resolvedId =
            (i as any).productId ||
            (i as any).product?.id ||
            (i.id.includes('_') ? i.id.split('_')[0] : i.id);
          const { product, ...cleanI } = i as any;
          const factor =
            cleanI.presentationQty || cleanI.conversionFactor || presentationFactor(cleanI.presentation);
          return {
            productId: resolvedId,
            name: cleanI.name,
            quantity: cleanI.quantity,
            price: cleanI.price,
            costPrice: cleanI.costPrice || 0,
            total: cleanI.lineTotal !== undefined ? cleanI.lineTotal : cleanI.price * cleanI.quantity,
            sku: cleanI.sku || '',
            unitOfMeasure: cleanI.unitOfMeasure || 'NIU',
            presentation: cleanI.presentation || null,
            variant: cleanI.variant || null,
            variantId: cleanI.variantId || cleanI.variant?.id,
            variantName: cleanI.variantName || cleanI.variant?.name,
            presentationId: cleanI.presentationId,
            presentationName: cleanI.presentationName,
            presentationQty: factor,
            conversionFactor: factor,
            stockBranchId: cleanI.stockBranchId || branchId || 'main',
            isGift: Boolean(cleanI.isGift),
            originalPrice: cleanI.originalPrice,
            priceModificationReason: cleanI.priceModificationReason,
            isWeightBased: cleanI.isWeightBased || false,
          };
        })
      );

      const saleTimestamp = Date.now();
      const opId = `quick_${saleTimestamp}_${Math.random().toString(36).slice(2, 9)}`;
      const isServerAttributed = posSettings?.enableSellerAttribution === true;
      const itemsGrossSubtotal =
        Math.round(
          items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0), 0) *
            100
        ) / 100;
      const netSubtotal = Math.max(0, safeTotal - shippingAmount);
      const breakdown = computeSaleTaxBreakdown(netSubtotal, 'nota_venta', taxProfile);
      const netInfo = await NetInfo.fetch();
      const isOnline =
        settingsIsOnline && Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

      const salePayload: CreateSaleTransactionParams = {
        accountId,
        branchId: branchId || 'main',
        userId: user?.uid || 'user_mobile',
        userName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero POS',
        userRole: userProfile?.role || undefined,
        items: saleItems,
        paymentMethod: 'cash',
        paymentMethodId: payment.paymentMethodId,
        paymentMethodName: payment.paymentMethodName,
        commissionPercent: cashMethod?.commissionPercent,
        commissionRule: cashMethod?.commissionRule,
        chargedAmount: payment.chargedAmount,
        commissionAmount: payment.commissionAmount,
        surchargeAmount: payment.surchargeAmount,
        netAmount: payment.netAmount,
        documentType: 'nota_venta',
        subtotal: isServerAttributed ? itemsGrossSubtotal : breakdown.subtotal,
        tax: 0,
        taxExemptionCode: breakdown.taxExemptionCode,
        isAmazonExempt: breakdown.isAmazonExempt,
        total: safeTotal,
        shippingAmount,
        discountAmount,
        payments: cleanFirestoreData(payment.payments),
        cashReceived: payment.chargedAmount,
        changeGiven: 0,
        customer: customer
          ? {
              id: customer.id,
              name: customer.name || 'Cliente Varios',
              dni: customer.dni || undefined,
              ruc: customer.ruc || undefined,
              phone: customer.phone || undefined,
              address: customer.address || undefined,
              documentType: customer.ruc ? 'RUC' : customer.dni ? 'DNI' : undefined,
              documentNumber: customer.ruc || customer.dni || undefined,
            }
          : { name: 'Cliente Varios' },
        customerId: customer?.id,
        customerName: customer?.name || 'Cliente Varios',
        sessionId: activeCashSession?.sessionId || activeCashSession?.id,
        saleDate: saleTimestamp,
        offlineId: opId,
        isQuote: false,
      };

      let labelText = '';
      if (isOnline) {
        const result = await createSaleTransaction(salePayload);
        const corr = result?.correlative || `#${result?.saleNumber || ''}`;
        labelText = `Venta rápida ${corr} · ${formatPEN(safeTotal)}`;
      } else {
        await enqueueOfflineSale(salePayload);
        void refreshOfflineCount();
        labelText = `Venta rápida offline · ${formatPEN(safeTotal)}`;
      }

      clearCart();
      setCustomer(null);
      setInvoiceIntent(null);
      setCartDrawerOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (quickSaleBannerTimerRef.current) {
        clearTimeout(quickSaleBannerTimerRef.current);
      }
      setQuickSaleBanner({ text: labelText, isOffline: !isOnline });
      quickSaleBannerTimerRef.current = setTimeout(() => {
        setQuickSaleBanner(null);
      }, 3500);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error en Venta Rápida', err?.message || 'No se pudo procesar la venta rápida.');
    } finally {
      quickSaleInFlightRef.current = false;
      setIsProcessingQuickSale(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* 1. BARRA DE BÚSQUEDA Y CONTROL DEL ESCÁNER */}
      <View style={styles.topBar}>
        <View style={styles.searchRow}>
          <View style={styles.searchInputWrapper}>
            <Search size={18} color={ui.textSecondary} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              accessibilityLabel="Buscar productos por nombre, SKU o código"
              placeholder="Buscar productos"
              placeholderTextColor={ui.textMuted}
              returnKeyType="search"
              onSubmitEditing={() => {
                if (searchQuery.trim()) {
                  handleBarcodeDetected(searchQuery);
                }
              }}
            />
            {searchQuery ? (
              <TouchableOpacity
                onPress={() => setSearchQuery('')}
                style={styles.clearSearchBtn}
                accessibilityRole="button"
                accessibilityLabel="Limpiar búsqueda"
                hitSlop={4}
              >
                <X size={16} color={ui.textSecondary} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Contador compacto de productos en la fila superior */}
          <View style={styles.searchCountBadge}>
            <Text style={styles.searchCountBadgeNumber}>
              {!catalogComplete ? '…' : filteredProducts.length}
            </Text>
            <Text style={styles.searchCountBadgeLabel}>prod.</Text>
          </View>

          {/* Escaneo como acción contextual del buscador */}
          <TouchableOpacity
            style={[
              styles.cameraActionBtn,
              styles.scanActionBtn,
              isCameraActive && styles.scanActionBtnActive,
            ]}
            onPress={toggleInlineCamera}
            accessibilityRole="button"
            accessibilityLabel={isCameraActive ? 'Cerrar lector de código de barras' : 'Escanear producto'}
            activeOpacity={0.7}
          >
            <Barcode size={20} color={isCameraActive ? ui.onPrimary : ui.primary} />
          </TouchableOpacity>
        </View>

        {/* Ventanita de Lector de Código de Barras Inline (sin cambiar de página ni abrir modal) */}
        {isCameraActive && isFocused && (
          <View style={styles.inlineScannerCard}>
            <View style={styles.inlineScannerTopBar}>
              <View style={styles.inlineScannerTitleWrap}>
                <Barcode size={16} color={ui.primary} />
                <Text style={styles.inlineScannerTitle}>Escáner de Productos</Text>
              </View>
              <View style={styles.inlineScannerActions}>
                <TouchableOpacity
                  style={[styles.inlineScannerActionBtn, torchOn && styles.inlineScannerActionBtnActive]}
                  onPress={() => setTorchOn((prev) => !prev)}
                  accessibilityRole="button"
                  accessibilityLabel="Alternar linterna"
                >
                  {torchOn ? <ZapOff size={14} color={ui.onPrimary} /> : <Zap size={14} color={ui.textSecondary} />}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.inlineScannerActionBtn}
                  onPress={() => {
                    setIsCameraActive(false);
                    setTorchOn(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar lector"
                >
                  <X size={14} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.inlineCameraBox}>
              <CameraView
                style={styles.inlineCamera}
                facing="back"
                enableTorch={torchOn}
                barcodeScannerSettings={BARCODE_SCANNER_SETTINGS}
                onBarcodeScanned={handleCameraScan}
              />
              <View style={styles.inlineReticle} />
              <View style={styles.inlineScanBanner}>
                <Text style={styles.inlineScanBannerText}>Apunta al código de barras del producto</Text>
              </View>
            </View>
          </View>
        )}

        {/* 2. SELECTORES DE CATEGORÍA, MARCA Y MEDIDA (INLINE BUSCADOR) */}
        <InlineFilterBar
          groups={posFilterGroups}
          rightElement={
            pausedSales.length > 0 ? (
              <TouchableOpacity
                style={styles.pausedBadgeChip}
                onPress={() => setPausedModalOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`Ventas en pausa: ${pausedSales.length}`}
              >
                <Pause size={12} color={ui.primary} />
                <Text style={styles.pausedBadgeChipText}>Pausa ({pausedSales.length})</Text>
              </TouchableOpacity>
            ) : undefined
          }
        />
      </View>

      {/* 4. CATÁLOGO VISUAL DE PRODUCTOS (FLASHLIST DE ALTO RENDIMIENTO) */}
      <View style={styles.catalogArea}>
        {(refreshing || productsError) && (
          <View style={styles.catalogSyncNotice}>
            <View style={styles.catalogSyncCopy}>
              {refreshing ? <ActivityIndicator size="small" color={ui.primary} /> : null}
              <Text style={styles.catalogSyncText}>
                {productsError ? productsError : 'Sincronizando catálogo…'}
              </Text>
            </View>
            {productsError ? (
              <TouchableOpacity onPress={refreshProducts} accessibilityRole="button" accessibilityLabel="Reintentar sincronización del catálogo">
                <Text style={styles.catalogRetryText}>Reintentar</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
        {productsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.loadingText}>Cargando catálogo POS...</Text>
          </View>
        ) : filteredProducts.length === 0 ? (
          <View style={styles.emptyBox}>
            <Package size={44} color={ui.textMuted} />
            <Text style={styles.emptyTitle}>
              {products.length === 0 ? 'Aún no hay productos' : 'No se encontraron productos'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {products.length === 0
                ? 'Cuando agregues productos, aparecerán aquí para iniciar una venta.'
                : 'Prueba otra búsqueda o selecciona una categoría distinta.'}
            </Text>
          </View>
        ) : (
          <FlashList
            data={filteredProducts}
            estimatedItemSize={enableCatalogFilters ? 94 : 82}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            contentContainerStyle={styles.listContent}
            renderItem={renderPosItem}
          />
        )}
      </View>

      {quickSaleBanner ? (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setQuickSaleBanner(null)}
          style={[styles.quickSaleToast, { bottom: Math.max(insets.bottom, 12) + 74 }]}
        >
          <CheckCircle2 size={18} color={ui.primary} />
          <Text style={styles.quickSaleToastText} numberOfLines={1}>
            {quickSaleBanner.text}
          </Text>
          <X size={16} color={ui.surface} />
        </TouchableOpacity>
      ) : null}

      {/* 5. BARRA FLOTANTE INFERIOR Y RESUMEN DEL CARRITO */}
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TouchableOpacity
          style={styles.cartSummaryToggle}
          onPress={() => setCartDrawerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Ver carrito, ${safeCount} ${safeCount === 1 ? 'ítem' : 'ítems'}, total ${formattedTotal}`}
          activeOpacity={0.8}
        >
          <View style={styles.cartIconWrapper}>
            <ShoppingBag size={20} color={ui.text} />
            {safeCount > 0 ? (
              <View style={styles.cartItemCountBadge}>
                <Text style={styles.cartItemCountText}>{safeCount}</Text>
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.cartDrawerHint} numberOfLines={1}>
              {safeCount} {safeCount === 1 ? 'prod.' : 'prods.'}
            </Text>
            <Text style={styles.cartTotalSummaryText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
              Ver carrito
            </Text>
          </View>
          <ChevronUp size={16} color={ui.textSecondary} />
        </TouchableOpacity>

        {/* BOTÓN 1-TAP VENTA RÁPIDA (Efectivo exacto sin comprobante en pantalla) */}
        {safeCount > 0 && safeTotal > 0 && posSettings?.enableQuickSale !== false && !sourceQuoteId && !saleRequestId ? (
          <TouchableOpacity
            style={styles.quickSaleBtn}
            onPress={handleInstantQuickSale}
            disabled={isProcessingQuickSale}
            accessibilityRole="button"
            accessibilityLabel={`Venta rápida en efectivo por ${formattedTotal}`}
            activeOpacity={0.8}
          >
            {isProcessingQuickSale ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <>
                <Zap size={17} color={ui.primary} />
                <Text style={styles.quickSaleBtnText}>Rápida</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}

        {/* BOTÓN GRANDE COBRAR */}
        <TouchableOpacity
          style={[styles.checkoutBtn, (safeCount === 0 || safeTotal <= 0) && styles.checkoutBtnDisabled]}
          onPress={() => setCheckoutModalOpen(true)}
          disabled={safeCount === 0 || safeTotal <= 0}
          accessibilityRole="button"
          accessibilityLabel={`Cobrar ${formattedTotal}`}
          activeOpacity={0.8}
        >
            <Text style={styles.checkoutBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>Cobrar · {formattedTotal}</Text>
          <ArrowRight size={20} color={ui.onPrimary} />
        </TouchableOpacity>
      </View>

      {/* DRAWER / MODAL DEL DETALLE DEL CARRITO */}
      {cartDrawerOpen && (
        <Modal
          visible={cartDrawerOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setCartDrawerOpen(false)}
        >
          <View style={styles.drawerBackdrop}>
            <Pressable style={styles.drawerDismissArea} onPress={() => setCartDrawerOpen(false)} />
            <View style={styles.drawerSheet}>
              {/* Header del Carrito */}
              <View style={styles.drawerHeader}>
                <View style={styles.drawerHeaderTitleRow}>
                  <ShoppingBag size={20} color={ui.text} />
                    <Text style={styles.drawerTitle}>Tu venta</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  {items.length > 0 ? (
                    <TouchableOpacity
                      style={styles.drawerIconButton}
                      accessibilityRole="button"
                      accessibilityLabel="Vaciar carrito"
                      onPress={() => {
                        Alert.alert('Vaciar Carrito', '¿Deseas eliminar todos los productos agregados?', [
                          { text: 'Cancelar', style: 'cancel' },
                          { text: 'Vaciar', style: 'destructive', onPress: clearCart },
                        ]);
                      }}
                    >
                      <Trash2 size={18} color={ui.danger} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    onPress={() => setCartDrawerOpen(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar detalle de venta"
                    style={styles.drawerIconButton}
                  >
                    <X size={22} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Lista de Ítems en Carrito */}
              {items.length === 0 ? (
                <View style={styles.drawerEmptyBox}>
                  <ShoppingBag size={36} color={ui.border} />
                  <Text style={styles.drawerEmptyText}>El carrito está vacío</Text>
                </View>
              ) : (
                <View
                  style={{
                    height: Math.min(320, Math.max(120, items.length * 104 + 20)),
                  }}
                >
                  <FlashList
                    data={items}
                    estimatedItemSize={94}
                    extraData={editingPriceItemId ? `${editingPriceItemId}:${newPriceStr}` : null}
                    keyExtractor={cartKeyExtractor}
                    renderItem={renderCartItem}
                    contentContainerStyle={styles.drawerItemsList}
                    keyboardShouldPersistTaps="handled"
                  />
                </View>
              )}

              {/* Footer del Carrito */}
              <View style={styles.drawerFooter}>
                {items.length > 0 ? (
                  <View style={styles.drawerMetaBlock}>
                    <View style={styles.docIntentRow}>
                      {(invoicingEnabled
                        ? ([
                            { value: 'nota_venta', label: 'NTV' },
                            { value: 'boleta', label: 'BOL' },
                            { value: 'factura', label: 'FAC' },
                            { value: 'quote', label: 'COT' },
                          ] as const)
                        : ([
                            { value: 'nota_venta', label: 'NTV' },
                            { value: 'quote', label: 'COT' },
                          ] as const)
                      ).map((opt) => {
                        const active = invoiceIntent === opt.value;
                        return (
                          <TouchableOpacity
                            key={opt.value}
                            style={[styles.docIntentChip, active && styles.docIntentChipActive]}
                            onPress={() =>
                              setInvoiceIntent(invoiceIntent === opt.value ? null : opt.value)
                            }
                            accessibilityRole="button"
                            accessibilityLabel={`Tipo comprobante ${opt.label}`}
                          >
                            <Text style={[styles.docIntentChipText, active && styles.docIntentChipTextActive]}>
                              {opt.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={styles.drawerDiscountHeader}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: ui.textSecondary }}>
                        Subtotal: {formatPEN(cartSubtotal)}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <TouchableOpacity
                          style={[
                            styles.drawerDiscountBadgeBtn,
                            promoSuggestions.length > 0 && { backgroundColor: ui.primarySoft },
                          ]}
                          onPress={() => setPromoModalOpen(true)}
                          accessibilityRole="button"
                          accessibilityLabel="Abrir promociones y regalos"
                        >
                          <Gift size={12} color={ui.primary} />
                          <Text style={[styles.drawerDiscountBadgeText, promoSuggestions.length > 0 && { color: ui.primary }]}>
                            {promoSuggestions.length > 0
                              ? `Promos/Regalos (${promoSuggestions.length})`
                              : 'Promos y Regalos'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.drawerDiscountBadgeBtn}
                          onPress={() => {
                            setDrawerDiscountStr(discountAmount > 0 ? discountAmount.toFixed(2) : '');
                            setShowDrawerDiscount((v) => !v);
                          }}
                        >
                          <Tag size={12} color={ui.primary} />
                          <Text style={styles.drawerDiscountBadgeText}>
                            {discountAmount > 0 ? `Desc: -${formatPEN(discountAmount)}` : 'Descuento'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    {promoSuggestions.length > 0 ? (
                      <TouchableOpacity
                        style={styles.promoHintBanner}
                        onPress={() => setPromoModalOpen(true)}
                        activeOpacity={0.8}
                      >
                        <Sparkles size={13} color={ui.primary} />
                        <Text style={styles.promoHintBannerText} numberOfLines={1}>
                          {promoSuggestions[0].name}: {promoSuggestions[0].description}
                        </Text>
                        <Text style={styles.promoHintBannerCta}>Ver</Text>
                      </TouchableOpacity>
                    ) : null}

                    {(hasBagOrPlasticItem || Boolean(icbperCartItem)) ? (
                      <View style={styles.icbperRow}>
                        <Text style={styles.icbperLabel}>
                          Impuesto bolsa plástica (ICBPER)
                        </Text>
                        <TouchableOpacity
                          style={[
                            styles.icbperToggleBtn,
                            Boolean(icbperCartItem) && styles.icbperToggleBtnActive,
                          ]}
                          onPress={handleToggleIcbper}
                          accessibilityRole="button"
                          accessibilityState={{ checked: Boolean(icbperCartItem) }}
                        >
                          <Text
                            style={[
                              styles.icbperToggleText,
                              Boolean(icbperCartItem) && styles.icbperToggleTextActive,
                            ]}
                          >
                            {icbperCartItem ? `ICBPER activo (${icbperCartItem.quantity}x)` : '+ Agregar S/ 0.50'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}

                    {showDrawerDiscount ? (
                      <View style={styles.drawerDiscountRow}>
                        <TextInput
                          style={styles.drawerDiscountInput}
                          value={drawerDiscountStr}
                          onChangeText={setDrawerDiscountStr}
                          placeholder="Monto descuento (S/)"
                          placeholderTextColor={ui.textMuted}
                          keyboardType="decimal-pad"
                        />
                        <TouchableOpacity
                          style={styles.drawerDiscountApplyBtn}
                          onPress={() => {
                            const val = Math.max(
                              0,
                              Math.min(cartSubtotal, parseNormalizedDecimal(drawerDiscountStr))
                            );
                            setDiscount(val);
                            setShowDrawerDiscount(false);
                          }}
                        >
                          <Text style={styles.drawerDiscountApplyText}>Aplicar</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                <View style={styles.drawerFooterRow}>
                  <TouchableOpacity
                    style={styles.pauseSaleFooterBtn}
                    onPress={handlePauseCurrentSale}
                  >
                    <Pause size={15} color={ui.textSecondary} />
                    <Text style={styles.pauseSaleFooterText}>Pausar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.reserveFooterBtn}
                    onPress={() => {
                      if (items.length === 0) {
                        Alert.alert('Carrito Vacío', 'Agrega productos al carrito para crear una reserva.');
                        return;
                      }
                      setReservationModalOpen(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Reservar productos del carrito"
                  >
                    <CalendarClock size={15} color={ui.accent} />
                    <Text style={styles.reserveFooterText}>Reservar</Text>
                  </TouchableOpacity>
                  {safeCount > 0 && safeTotal > 0 && posSettings?.enableQuickSale !== false && !sourceQuoteId && !saleRequestId ? (
                    <TouchableOpacity
                      style={styles.drawerQuickSaleBtn}
                      onPress={handleInstantQuickSale}
                      disabled={isProcessingQuickSale}
                      accessibilityRole="button"
                      accessibilityLabel={`Venta rápida en efectivo por ${formattedTotal}`}
                    >
                      {isProcessingQuickSale ? (
                        <ActivityIndicator size="small" color={ui.primary} />
                      ) : (
                        <>
                          <Zap size={15} color={ui.primary} />
                          <Text style={styles.quickSaleBtnText}>Rápida</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={[styles.checkoutBtn, (safeCount === 0 || safeTotal <= 0) && styles.checkoutBtnDisabled]}
                    onPress={() => {
                      setCartDrawerOpen(false);
                      setCheckoutModalOpen(true);
                    }}
                    disabled={safeCount === 0 || safeTotal <= 0}
                  >
                    <Text style={styles.checkoutBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>Cobrar · {formattedTotal}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* MODAL DE MONTO LIBRE (ÍTEM SIN CATALOGAR) */}
      {quickSaleModalOpen && (
        <Modal
          visible={quickSaleModalOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setQuickSaleModalOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Plus size={18} color={ui.primary} />
                  <Text style={styles.subModalTitle}>Monto Libre (Ítem no catalogado)</Text>
                </View>
                <TouchableOpacity onPress={() => setQuickSaleModalOpen(false)}>
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>Concepto o Descripción</Text>
              <TextInput
                style={styles.formInput}
                value={quickConcept}
                onChangeText={setQuickConcept}
                placeholder="Ej. Servicio, Fotocopia, Varios..."
                placeholderTextColor={ui.textMuted}
              />

              <Text style={styles.inputLabel}>Importe en Soles (S/)</Text>
              <TextInput
                style={[styles.formInput, styles.quickAmountHighlight]}
                value={quickAmountStr}
                onChangeText={setQuickAmountStr}
                placeholder="0.00"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
                autoFocus
              />

              <View style={styles.subModalActions}>
                <TouchableOpacity
                  style={styles.subModalCancelBtn}
                  onPress={() => setQuickSaleModalOpen(false)}
                >
                  <Text style={styles.subModalCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.subModalConfirmBtn}
                  onPress={handleConfirmQuickSale}
                >
                  <Plus size={16} color={ui.onPrimary} />
                  <Text style={styles.subModalConfirmText}>Agregar al Carrito</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* MODAL DE RESERVA DE PRODUCTOS */}
      {reservationModalOpen && (
        <Modal
          visible={reservationModalOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setReservationModalOpen(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.subModalOverlay}
          >
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <CalendarClock size={18} color={ui.accent} />
                  <Text style={styles.subModalTitle}>Crear Reserva</Text>
                </View>
                <TouchableOpacity onPress={() => setReservationModalOpen(false)}>
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
                {/* Resumen de items a reservar */}
                <View style={styles.resSummaryCard}>
                  <Text style={styles.resSummaryTitle}>
                    {items.length} {items.length === 1 ? 'producto' : 'productos'} · Total: {formatPEN(safeTotal)}
                  </Text>
                  <Text style={styles.resSummarySub}>
                    El stock se apartará automáticamente de la sucursal actual.
                  </Text>
                </View>

                <Text style={styles.inputLabel}>
                  Nombre del Cliente <Text style={{ color: ui.danger }}>*</Text>
                </Text>
                <TextInput
                  style={styles.formInput}
                  value={resCustomerName}
                  onChangeText={setResCustomerName}
                  placeholder="Ej. Juan Pérez"
                  placeholderTextColor={ui.textMuted}
                />

                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Teléfono / WhatsApp</Text>
                    <TextInput
                      style={styles.formInput}
                      value={resCustomerPhone}
                      onChangeText={setResCustomerPhone}
                      placeholder="999 999 999"
                      keyboardType="phone-pad"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={styles.inputLabel}>DNI (opcional)</Text>
                      {isSearchingDni && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <ActivityIndicator size="small" color={ui.primary} style={{ transform: [{ scale: 0.7 }] }} />
                          <Text style={{ fontSize: 10, color: ui.primary }}>RENIEC...</Text>
                        </View>
                      )}
                    </View>
                    <TextInput
                      style={styles.formInput}
                      value={resCustomerDoc}
                      onChangeText={setResCustomerDoc}
                      placeholder="8 dígitos"
                      keyboardType="numeric"
                      maxLength={8}
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Adelanto / Seña (S/)</Text>
                    <TextInput
                      style={[styles.formInput, { fontWeight: '700', color: ui.primary }]}
                      value={resDepositStr}
                      onChangeText={setResDepositStr}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Días límite</Text>
                    <TextInput
                      style={styles.formInput}
                      value={resDays}
                      onChangeText={setResDays}
                      placeholder="7"
                      keyboardType="numeric"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                </View>

                {/* Si hay adelanto, método de pago */}
                {parseFloat(resDepositStr) > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={styles.inputLabel}>Método del Adelanto</Text>
                    <View style={styles.resMethodRow}>
                      {(['cash', 'yape', 'plin', 'card'] as const).map((m) => (
                        <TouchableOpacity
                          key={m}
                          style={[
                            styles.resMethodChip,
                            resDepositMethod === m && styles.resMethodChipActive,
                          ]}
                          onPress={() => setResDepositMethod(m)}
                        >
                          <Text
                            style={[
                              styles.resMethodChipText,
                              resDepositMethod === m && styles.resMethodChipTextActive,
                            ]}
                          >
                            {m === 'cash' ? 'Efectivo' : m === 'card' ? 'Tarjeta' : m.toUpperCase()}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}

                <Text style={styles.inputLabel}>Notas / Observaciones</Text>
                <TextInput
                  style={[styles.formInput, { height: 60, textAlignVertical: 'top' }]}
                  value={resNotes}
                  onChangeText={setResNotes}
                  placeholder="Ej. Recoge el fin de semana..."
                  placeholderTextColor={ui.textMuted}
                  multiline
                />
              </ScrollView>

              <View style={styles.subModalActions}>
                <TouchableOpacity
                  style={styles.subModalCancelBtn}
                  onPress={() => setReservationModalOpen(false)}
                  disabled={isSavingRes}
                >
                  <Text style={styles.subModalCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.subModalConfirmBtn, isSavingRes && { opacity: 0.6 }]}
                  onPress={handleConfirmReservation}
                  disabled={isSavingRes}
                >
                  {isSavingRes ? (
                    <ActivityIndicator size="small" color={ui.onPrimary} />
                  ) : (
                    <>
                      <CalendarClock size={16} color={ui.onPrimary} />
                      <Text style={styles.subModalConfirmText}>Confirmar Reserva</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}

      {/* MODAL DE CUENTAS EN PAUSA */}
      {pausedModalOpen && (
        <Modal
          visible={pausedModalOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setPausedModalOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Clock size={18} color={ui.primary} />
                  <Text style={styles.subModalTitle}>Ventas en Pausa ({pausedSales.length})</Text>
                </View>
                <TouchableOpacity onPress={() => setPausedModalOpen(false)}>
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              {pausedSales.length === 0 ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                  <Text style={{ color: ui.textSecondary, fontSize: 13 }}>No hay ventas en espera actualmente.</Text>
                </View>
              ) : (
                <ScrollView style={{ maxHeight: 300 }}>
                  {pausedSales.map((ps) => (
                    <View key={ps.id} style={styles.pausedItemCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pausedItemTitle}>{ps.label}</Text>
                        {Boolean(ps.customer?.name) && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2, marginBottom: 2 }}>
                            <User size={12} color={ui.primary} />
                            <Text style={{ fontSize: 12, color: ui.text, fontWeight: '600' }} numberOfLines={1}>
                              {ps.customer?.name}
                            </Text>
                          </View>
                        )}
                        <Text style={styles.pausedItemDetails}>
                          {ps.items?.length || 0} ítems | Total: {formatPEN(ps.total || 0)}
                        </Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        <TouchableOpacity
                          style={styles.pausedResumeBtn}
                          onPress={() => handleResumePausedSale(ps.id)}
                        >
                          <Play size={14} color={ui.onPrimary} />
                          <Text style={styles.pausedResumeBtnText}>Recuperar</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.pausedDeleteBtn}
                          onPress={() => deletePausedSale(ps.id)}
                        >
                          <Trash2 size={14} color={ui.danger} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}

              <TouchableOpacity
                style={styles.pauseCurrentActionBtn}
                onPress={() => {
                  setPausedModalOpen(false);
                  handlePauseCurrentSale();
                }}
              >
                <Pause size={16} color={ui.text} />
                <Text style={styles.pauseCurrentActionText}>Pausar Carrito Actual</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* SELECTOR RÁPIDO PARA PRODUCTO POR PESO */}
      {weightSelectorOpen && (
        <Modal
          visible={weightSelectorOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setWeightSelectorOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Scale size={18} color={ui.accent} />
                  <Text style={styles.subModalTitle}>Productos Pesables</Text>
                </View>
                <TouchableOpacity onPress={() => setWeightSelectorOpen(false)}>
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 320 }}>
                {weighableProducts.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      style={styles.weightItemRow}
                      onPress={() => {
                        setWeightSelectorOpen(false);
                        setWeightModalProduct(p);
                      }}
                    >
                      <Text style={styles.weightItemName}>{p.name}</Text>
                      <Text style={styles.weightItemPrice}>
                        {formatPEN(p.suggestedPrice ?? p.price ?? 0)} / kg
                      </Text>
                    </TouchableOpacity>
                  ))}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* MODALES EXTERNOS */}
      {fullscreenScannerOpen && (
        <BarcodeScannerModal
          visible={fullscreenScannerOpen}
          onClose={() => setFullscreenScannerOpen(false)}
          onScan={(code) => {
            setFullscreenScannerOpen(false);
            handleBarcodeDetected(code);
          }}
        />
      )}

      {variantModalProduct !== null && (
        <PresentationVariantModal
          visible={Boolean(variantModalProduct)}
          product={variantModalProduct}
          onClose={() => setVariantModalProduct(null)}
          onConfirm={(prod, opts) => {
            setVariantModalProduct(null);
            triggerScanHaptic();
            addItem(prod, {
              presentation: opts.presentation,
              variant: opts.variant,
              quantity: opts.quantity,
            });
          }}
        />
      )}

      {weightModalProduct !== null && (
        <WeightQuantityModal
          visible={Boolean(weightModalProduct)}
          product={weightModalProduct}
          onClose={() => setWeightModalProduct(null)}
          onConfirm={(prod, qty, customPrice) => {
            setWeightModalProduct(null);
            triggerScanHaptic();
            addItem(prod, {
              quantity: qty,
              customPrice,
              isWeightBased: true,
            });
          }}
        />
      )}

      {promoModalOpen && (
        <Modal
          visible={promoModalOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setPromoModalOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={[styles.subModalCard, { maxHeight: '84%' }]}>
              <View style={styles.subModalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Gift size={18} color={ui.primary} />
                  <Text style={styles.subModalTitle}>Promociones y Regalos</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setPromoModalOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar promociones y regalos"
                >
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 460 }}>
                {/* Promociones aplicables al carrito */}
                <Text style={styles.promoSectionTitle}>Promociones Aplicables</Text>
                {promoSuggestions.length === 0 ? (
                  <Text style={styles.promoEmptyText}>
                    {(discountSettings?.promotions || []).some((p) => p.active !== false)
                      ? 'Los productos del carrito aún no alcanzan una promoción activa.'
                      : 'No hay reglas de promoción activas configuradas.'}
                  </Text>
                ) : (
                  promoSuggestions.map((s) => (
                    <View key={s.promotionId} style={styles.promoCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.promoCardTitle}>{s.name}</Text>
                        <Text style={styles.promoCardDesc}>{s.description}</Text>
                      </View>
                      {s.freeProduct && s.freeQuantity ? (
                        <TouchableOpacity
                          style={styles.promoActionBtn}
                          onPress={() => {
                            addGiftItem(s.freeProduct!, { quantity: s.freeQuantity });
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          }}
                        >
                          <Text style={styles.promoActionBtnText}>
                            +{s.freeQuantity} Gratis
                          </Text>
                        </TouchableOpacity>
                      ) : s.suggestedDiscountAmount > 0 ? (
                        <TouchableOpacity
                          style={styles.promoActionBtn}
                          onPress={() => {
                            const nextDiscount = Math.min(cartSubtotal, s.suggestedDiscountAmount);
                            setDiscount(nextDiscount);
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          }}
                        >
                          <Text style={styles.promoActionBtnText}>
                            Aplicar -{formatPEN(s.suggestedDiscountAmount)}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ))
                )}

                {/* Catálogo de Regalos S/ 0.00 */}
                <Text style={[styles.promoSectionTitle, { marginTop: 14 }]}>
                  Agregar Producto como Regalo (S/ 0.00)
                </Text>
                {discountSettings?.enableGifts === false ? (
                  <Text style={styles.promoEmptyText}>
                    Los regalos están deshabilitados en la configuración del negocio.
                  </Text>
                ) : (
                  <>
                    <TextInput
                      style={[styles.formInput, { marginBottom: 8 }]}
                      value={giftSearchQuery}
                      onChangeText={setGiftSearchQuery}
                      placeholder="Buscar producto elegible para regalo..."
                      placeholderTextColor={ui.textMuted}
                    />
                    {filteredGiftProducts.length === 0 ? (
                      <Text style={styles.promoEmptyText}>
                        No hay productos elegibles con stock en esta sucursal.
                      </Text>
                    ) : (
                      filteredGiftProducts.map((p) => {
                        const stockQty = resolveProductBranchStock(p, branchId || 'main');
                        return (
                          <View key={p.id} style={styles.giftProductRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.giftProductName} numberOfLines={1}>
                                {p.name}
                              </Text>
                              <Text style={styles.giftProductMeta}>
                                Stock: {stockQty} · Valor ref: {formatPEN(p.suggestedPrice ?? p.price ?? 0)}
                              </Text>
                            </View>
                            <TouchableOpacity
                              style={styles.giftAddBtn}
                              onPress={() => {
                                addGiftItem(p, { quantity: 1 });
                                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                              }}
                            >
                              <Gift size={13} color={ui.onPrimary} />
                              <Text style={styles.giftAddBtnText}>Regalar</Text>
                            </TouchableOpacity>
                          </View>
                        );
                      })
                    )}
                  </>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {checkoutModalOpen && (
        <CheckoutModal
          visible={checkoutModalOpen}
          onClose={() => setCheckoutModalOpen(false)}
          initialDocType={invoiceIntent || undefined}
          branch={activeBranch}
        />
      )}

      {companionScannerOpen && (
        <CompanionScannerModal
          visible={companionScannerOpen}
          onClose={() => setCompanionScannerOpen(false)}
        />
      )}

      {quotesModalOpen && (
        <QuotesManagerModal
          visible={quotesModalOpen}
          onClose={() => setQuotesModalOpen(false)}
        />
      )}

      {resTicketModalOpen && (
        <ReservationReceiptModal
          visible={resTicketModalOpen}
          onClose={() => {
            setResTicketModalOpen(false);
            setCreatedResTicket(null);
          }}
          reservation={createdResTicket}
          business={businessSettings}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  topBar: {
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    paddingTop: 0,
    paddingBottom: 14,
  },
  quickSaleHeaderAction: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: ui.primary,
  },
  quickSaleHeaderActionText: {
    color: ui.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginTop: 4,
  },
  searchCountBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    height: 48,
  },
  searchCountBadgeNumber: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
    lineHeight: 15,
  },
  searchCountBadgeLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: ui.textSecondary,
    lineHeight: 11,
  },
  searchInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 10,
    minHeight: 48,
  },
  searchIcon: {
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: ui.text,
    paddingVertical: 0,
  },
  clearSearchBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraActionBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraActionBtnActive: {
    backgroundColor: ui.primarySoft,
  },
  scanActionBtn: {
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primarySoft,
  },
  scanActionBtnActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  inlineScannerCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.primary,
    overflow: 'hidden',
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 4,
  },
  inlineScannerTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ui.surfaceMuted,
  },
  inlineScannerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inlineScannerTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.text,
  },
  inlineScannerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inlineScannerActionBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineScannerActionBtnActive: {
    backgroundColor: ui.primary,
  },
  inlineCameraBox: {
    height: 160,
    backgroundColor: '#000',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineCamera: {
    ...StyleSheet.absoluteFillObject,
  },
  inlineReticle: {
    width: '75%',
    height: 90,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: ui.primary,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  inlineScanBanner: {
    position: 'absolute',
    bottom: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  inlineScanBannerText: {
    fontSize: 11,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  quickActionsBar: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 8,
  },
  quickActionsGroup: {
    marginTop: 8,
    marginHorizontal: 20,
  },
  quickActionsLabel: {
    color: ui.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  quickActionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 10,
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 20,
  },
  quickActionPillActive: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  quickActionPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  pausedBadge: {
    backgroundColor: ui.primary,
    borderRadius: 10,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  pausedBadgeText: {
    color: ui.surface,
    fontSize: 10,
    fontWeight: '700',
  },
  catalogTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginTop: 10,
  },
  categoryPickerBtn: {
    flex: 1,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  categoryPickerBtnActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  categoryPickerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  categoryPickerTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  clearCategoryBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catalogItemsCount: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textMuted,
  },
  categoryModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(17,28,49,0.40)',
    justifyContent: 'flex-end',
  },
  categoryModalSheet: {
    backgroundColor: ui.surface,
    padding: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '75%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  categoryModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  categoryModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: ui.text,
  },
  modalCloseCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catIconBoxActive: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categorySearchWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
    marginBottom: 12,
  },
  categorySearchInput: {
    flex: 1,
    fontSize: 14,
    color: ui.text,
    paddingVertical: 0,
  },
  categoryListScroll: {
    maxHeight: 320,
  },
  categoryItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 4,
  },
  categoryItemRowSelected: {
    backgroundColor: ui.primarySoft,
  },
  catIconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryItemName: {
    fontSize: 14,
    color: ui.text,
    fontWeight: '500',
  },
  categoryCountBadge: {
    backgroundColor: ui.surfaceMuted,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  categoryCountBadgeSelected: {
    backgroundColor: '#FFFFFF',
  },
  categoryCountBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  catalogArea: {
    flex: 1,
    paddingTop: 4,
  },
  catalogSyncNotice: {
    minHeight: 38,
    marginHorizontal: 14,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  catalogSyncCopy: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  catalogSyncText: { flex: 1, color: ui.textSecondary, fontSize: 11, fontWeight: '600' },
  catalogRetryText: { color: ui.primary, fontSize: 11, fontWeight: '800' },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 2,
    paddingBottom: 112,
  },
  loadingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  loadingText: {
    marginTop: 10,
    fontSize: 13,
    color: ui.textSecondary,
  },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
    marginTop: 10,
  },
  emptySubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 4,
    textAlign: 'center',
  },
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surface,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 15,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  productInfo: {
    flex: 1,
    marginRight: 10,
  },
  productName: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  productMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  productSku: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  stockBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  stockBadgeGreen: {
    backgroundColor: ui.successSoft,
  },
  stockBadgeAmber: {
    backgroundColor: ui.warningSoft,
  },
  stockBadgeRed: {
    backgroundColor: ui.dangerSoft,
  },
  stockBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  stockBadgeTextGreen: {
    color: ui.success,
  },
  stockBadgeTextAmber: {
    color: ui.warning,
  },
  stockBadgeTextRed: {
    color: ui.danger,
  },
  productPriceCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  productPrice: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  addPlusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: ui.surface,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
  },
  cartSummaryToggle: {
    flex: 1.1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 46,
  },
  cartIconWrapper: {
    width: 32,
    height: 36,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  cartItemCountBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: ui.text,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  cartItemCountText: {
    color: ui.onPrimary,
    fontSize: 10,
    fontWeight: '700',
  },
  cartDrawerHint: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  cartTotalSummaryText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  checkoutBtn: {
    flex: 1.15,
    flexDirection: 'row',
    gap: 6,
    backgroundColor: ui.primary,
    borderRadius: 12,
    minHeight: 46,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkoutBtnDisabled: {
    backgroundColor: ui.textMuted,
  },
  checkoutBtnText: {
    flexShrink: 1,
    color: ui.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  drawerDismissArea: {
    flex: 1,
  },
  drawerSheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '88%',
    paddingBottom: 12,
  },
  drawerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  drawerHeaderTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  drawerIconButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  drawerItemsList: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  drawerEmptyBox: {
    alignItems: 'center',
    padding: 30,
  },
  drawerEmptyText: {
    fontSize: 13,
    color: ui.textMuted,
    marginTop: 8,
  },
  drawerCartItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  drawerCartItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  drawerCartItemName: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  drawerCartItemSub: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  drawerCartItemSubtotal: {
    fontSize: 14,
    fontWeight: '800',
    color: ui.text,
  },
  drawerCartItemControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  qtyControlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    padding: 2,
  },
  qtyBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyNumberText: {
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 8,
    color: ui.text,
  },
  unitPriceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.background,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: ui.border,
    minHeight: 48,
  },
  unitPriceBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  editPriceInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  editPriceInput: {
    width: 60,
    height: 30,
    borderWidth: 1,
    borderColor: ui.primary,
    borderRadius: 6,
    textAlign: 'center',
    fontSize: 12,
    color: ui.text,
    padding: 0,
  },
  savePriceBtn: {
    backgroundColor: ui.primary,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  savePriceBtnText: {
    color: ui.surface,
    fontSize: 11,
    fontWeight: '700',
  },
  deleteItemBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerFooter: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: ui.surfaceMuted,
  },
  drawerFooterRow: {
    flexDirection: 'row',
    gap: 10,
  },
  pauseSaleFooterBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primarySoft,
    borderRadius: 12,
    paddingVertical: 12,
  },
  pauseSaleFooterText: {
    color: ui.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  subModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  subModalCard: {
    width: '100%',
    backgroundColor: ui.surface,
    borderRadius: 16,
    padding: 16,
  },
  subModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  subModalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 4,
  },
  formInput: {
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: ui.text,
    marginBottom: 12,
  },
  quickAmountHighlight: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    color: ui.warning,
    borderColor: ui.warning,
  },
  subModalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  subModalCancelBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
  },
  subModalCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  subModalConfirmBtn: {
    flex: 1.5,
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: ui.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subModalConfirmText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.surface,
  },
  pausedItemCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  pausedItemTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  pausedItemDetails: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  pausedResumeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  pausedResumeBtnText: {
    color: ui.surface,
    fontSize: 11,
    fontWeight: '700',
  },
  pausedDeleteBtn: {
    padding: 6,
    backgroundColor: ui.dangerSoft,
    borderRadius: 6,
  },
  pauseCurrentActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
  },
  pauseCurrentActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  weightItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  weightItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  weightItemPrice: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.success,
  },
  pausedBadgeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  pausedBadgeChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  inlineCategoryDropdown: {
    backgroundColor: ui.surface,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    gap: 8,
  },
  inlineCatSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 8,
    height: 32,
  },
  inlineCatSearchInput: {
    flex: 1,
    fontSize: 12,
    color: ui.text,
    paddingVertical: 0,
  },
  inlineChipsScroll: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 2,
  },
  inlineCatChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: ui.surfaceMuted,
  },
  inlineCatChipActive: {
    backgroundColor: ui.primary,
  },
  inlineCatChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  inlineCatChipTextActive: {
    color: ui.surface,
    fontWeight: '700',
  },
  filterSectionCompact: {
    marginTop: 4,
  },
  filterSectionTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inlineFilterChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  inlineFilterChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  inlineFilterChipText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  inlineFilterChipTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  reserveFooterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: ui.accentSoft,
  },
  reserveFooterText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.accent,
  },
  resSummaryCard: {
    backgroundColor: ui.accentSoft,
    padding: 10,
    borderRadius: 8,
    marginBottom: 10,
  },
  resSummaryTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  resSummarySub: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  resMethodRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  resMethodChip: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
  },
  resMethodChipActive: {
    backgroundColor: ui.primary,
  },
  resMethodChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  resMethodChipTextActive: {
    color: ui.surface,
    fontWeight: '700',
  },
  quickSaleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    borderWidth: 1.5,
    borderColor: ui.primary,
    borderRadius: 12,
    minHeight: 46,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  quickSaleBtnText: {
    color: ui.primary,
    fontSize: 12,
    fontWeight: '800',
  },
  productAttrText: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 4,
  },
  drawerQuickSaleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: ui.primarySoft,
    borderWidth: 1.5,
    borderColor: ui.primary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  quickSaleToast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
  },
  quickSaleToastText: {
    flex: 1,
    color: ui.surface,
    fontSize: 13,
    fontWeight: '700',
  },
  drawerMetaBlock: {
    marginBottom: 10,
    gap: 8,
  },
  docIntentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  docIntentChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
  },
  docIntentChipActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  docIntentChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  docIntentChipTextActive: {
    color: ui.onPrimary,
  },
  drawerDiscountHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  drawerDiscountBadgeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
  },
  drawerDiscountBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  drawerDiscountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  drawerDiscountInput: {
    flex: 1,
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  drawerDiscountApplyBtn: {
    backgroundColor: ui.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  drawerDiscountApplyText: {
    color: ui.onPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  giftBadgePill: {
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: ui.successSoft,
    borderWidth: 1,
    borderColor: ui.success,
  },
  giftBadgePillText: {
    fontSize: 10,
    fontWeight: '800',
    color: ui.success,
  },
  promoHintBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: ui.accentSoft,
    borderWidth: 1,
    borderColor: ui.accent,
  },
  promoHintBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: ui.accent,
  },
  promoHintBannerCta: {
    fontSize: 12,
    fontWeight: '800',
    color: ui.accent,
  },
  icbperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  icbperLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  icbperToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
  },
  icbperToggleBtnActive: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  icbperToggleText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  icbperToggleTextActive: {
    color: ui.primary,
  },
  promoSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  promoEmptyText: {
    fontSize: 13,
    color: ui.textSecondary,
    paddingVertical: 8,
  },
  promoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    marginBottom: 8,
  },
  promoCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  promoCardDesc: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  promoActionBtn: {
    backgroundColor: ui.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  promoActionBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  giftProductRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  giftProductName: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  giftProductMeta: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  giftAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.successSoft,
    borderWidth: 1,
    borderColor: ui.success,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  giftAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.success,
  },
});
