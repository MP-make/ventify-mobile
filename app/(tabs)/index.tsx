import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  Search,
  Plus,
  ShoppingBag,
  X,
  Package,
  Barcode,
  CheckCircle2,
} from 'lucide-react-native';
import { Camera, type BarcodeScanningResult } from 'expo-camera';
import { useIsFocused } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';

import { useCartActions } from '@/context/CartContext';
import { useProducts } from '@/context/ProductsContext';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { formatPEN, ui } from '@/lib/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { PresentationVariantModal } from '@/components/PresentationVariantModal';
import { WeightQuantityModal } from '@/components/WeightQuantityModal';
import { CheckoutModal } from '@/components/CheckoutModal';
import { CompanionScannerModal } from '@/components/CompanionScannerModal';
import { QuotesManagerModal } from '@/components/QuotesManagerModal';
import { InlineFilterBar, type FilterGroup, type FilterOption } from '@/components/InlineFilterBar';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';
import { PosInlineScannerCard } from '@/components/pos/PosInlineScannerCard';
import { PosPausedSalesBadge } from '@/components/pos/PosPausedSalesBadge';
import { PosBottomCartBar } from '@/components/pos/PosBottomCartBar';
import { PosCartDrawerModal } from '@/components/pos/PosCartDrawerModal';
import { PosPromoGiftModal } from '@/components/pos/PosPromoGiftModal';
import { PosPausedSalesModal } from '@/components/pos/PosPausedSalesModal';
import { PosWeighablePickerModal } from '@/components/pos/PosWeighablePickerModal';
import { PosReservationModal } from '@/components/pos/PosReservationModal';
import { PosQuickConceptModal } from '@/components/pos/PosQuickConceptModal';
import type { QuickSaleBannerPayload } from '@/components/pos/useQuickSaleAction';
import {
  DEFAULT_CATALOG_BRANDS,
  DEFAULT_CATALOG_SIZES,
  mergeCatalogOptions,
  filterCatalogIndex,
  getCatalogCategoryCounts,
} from '@/lib/catalog-filters';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { catalogSizeInput } from '@/lib/product-attributes';
import type { Product, ProductPresentation, ProductVariant } from '@/types';

const EMPTY_PRODUCTS: Product[] = [];
const EMPTY_OPTIONS: string[] = ['Todas'];
const EMPTY_CATEGORY_OPTIONS: FilterOption[] = [{ name: 'Todas' }];

export const triggerScanHaptic = () => {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

interface PosProductCardProps {
  item: Product;
  stock: number;
  showAttributes?: boolean;
  onSelect: (product: Product) => void;
}

const PosProductCard = React.memo<PosProductCardProps>(
  ({ item, stock, showAttributes = false, onSelect }) => {
    const handlePress = useCallback(() => {
      onSelect(item);
    }, [onSelect, item]);

    const minStock = (item as any).minStock || 3;
    const isOutOfStock = stock <= 0;
    const isLowStock = stock > 0 && stock <= minStock;
    const price = Number(item.suggestedPrice ?? item.price ?? 0);
    const formattedPrice = formatPEN(price);
    const brandLabel = showAttributes ? (item.brand || '').trim() : '';
    const sizeLabel = showAttributes ? catalogSizeInput(item).trim() : '';

    return (
      <TouchableOpacity
        style={[styles.productCard, isOutOfStock && styles.productCardDisabled]}
        onPress={handlePress}
        disabled={isOutOfStock}
        accessibilityRole="button"
        accessibilityState={{ disabled: isOutOfStock }}
        accessibilityLabel={`Agregar ${item.name}, ${formattedPrice}${isOutOfStock ? ', agotado' : `, stock ${stock}`}`}
        activeOpacity={isOutOfStock ? 1 : 0.7}
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
          {brandLabel || sizeLabel ? (
            <Text style={styles.productAttrText} numberOfLines={1}>
              {[brandLabel ? `Marca: ${brandLabel}` : '', sizeLabel ? `Medida: ${sizeLabel}` : '']
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ) : null}
        </View>

        <View style={styles.productPriceCol}>
          <Text style={styles.productPrice}>{formattedPrice}</Text>
          <View style={[styles.addPlusBtn, isOutOfStock && styles.addPlusBtnDisabled]}>
            <Plus size={16} color={isOutOfStock ? ui.textMuted : ui.onPrimary} />
          </View>
        </View>
      </TouchableOpacity>
    );
  }
);

export default function PosCounterScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { branchId, accountId, user } = useAuthSession();
  const scanScope = `${user?.uid}:${accountId}:${branchId}`;
  const scanScopeRef = useRef(scanScope);
  const scanLookupInFlight = useRef(false);
  scanScopeRef.current = scanScope;
  useEffect(() => {
    scanScopeRef.current = scanScope;
    return () => {
      scanScopeRef.current = '';
    };
  }, [scanScope]);

  const { posSettings, businessSettings, activeBranch } = useBusinessSettings();
  const {
    products,
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
  const { addItem } = useCartActions();

  // 1. Buscador, Categorías y Filtros de Catálogo
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [selectedBrand, setSelectedBrand] = useState('Todas');
  const [selectedSize, setSelectedSize] = useState('Todas');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const isCameraActiveRef = useRef(false);
  isCameraActiveRef.current = isCameraActive;
  const [torchOn, setTorchOn] = useState(false);
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

  // 2. Modales Especiales
  const [reservationModalOpen, setReservationModalOpen] = useState(false);
  const [createdResTicket, setCreatedResTicket] = useState<any | null>(null);
  const [resTicketModalOpen, setResTicketModalOpen] = useState(false);
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [variantModalProduct, setVariantModalProduct] = useState<Product | null>(null);
  const [weightModalProduct, setWeightModalProduct] = useState<Product | null>(null);
  const [weightSelectorOpen, setWeightSelectorOpen] = useState(false);
  const [companionScannerOpen, setCompanionScannerOpen] = useState(false);
  const [quotesModalOpen, setQuotesModalOpen] = useState(false);
  const [promoModalOpen, setPromoModalOpen] = useState(false);
  const [quickSaleModalOpen, setQuickSaleModalOpen] = useState(false);
  const [pausedModalOpen, setPausedModalOpen] = useState(false);
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);

  const [quickSaleBanner, setQuickSaleBanner] = useState<QuickSaleBannerPayload | null>(null);
  const quickSaleBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (quickSaleBannerTimerRef.current) {
        clearTimeout(quickSaleBannerTimerRef.current);
      }
    };
  }, []);

  const handleShowQuickSaleBanner = useCallback((banner: QuickSaleBannerPayload) => {
    if (quickSaleBannerTimerRef.current) {
      clearTimeout(quickSaleBannerTimerRef.current);
    }
    setQuickSaleBanner(banner);
    quickSaleBannerTimerRef.current = setTimeout(() => {
      setQuickSaleBanner(null);
      quickSaleBannerTimerRef.current = null;
    }, 3500);
  }, []);

  const handleDismissQuickSaleBanner = useCallback(() => {
    if (quickSaleBannerTimerRef.current) {
      clearTimeout(quickSaleBannerTimerRef.current);
      quickSaleBannerTimerRef.current = null;
    }
    setQuickSaleBanner(null);
  }, []);

  // Permisos de cámara bajo demanda (solo al abrir el escáner inline)
  const toggleInlineCamera = useCallback(async () => {
    if (!isCameraActiveRef.current) {
      try {
        const currentPerm = await Camera.getCameraPermissionsAsync();
        if (!currentPerm.granted) {
          const res = await Camera.requestCameraPermissionsAsync();
          if (!res.granted) {
            Alert.alert(
              'Cámara Requerida',
              'Se requiere permiso de cámara para el escáner POS.'
            );
            return;
          }
        }
        setIsCameraActive(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {
        Alert.alert(
          'Cámara no Disponible',
          'No se pudieron verificar los permisos de cámara.'
        );
      }
    } else {
      setIsCameraActive(false);
      setTorchOn(false);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, []);

  const handleToggleTorch = useCallback(() => {
    setTorchOn((prev) => !prev);
  }, []);

  const handleCloseInlineScanner = useCallback(() => {
    setIsCameraActive(false);
    setTorchOn(false);
  }, []);

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
        try {
          match = await findByBarcodeRemote(cleanCode);
        } catch {
          if (scanScopeRef.current === requestScope) {
            Alert.alert(
              'No se pudo consultar el catálogo',
              'Comprueba tu conexión y vuelve a escanear.'
            );
          }
          return;
        } finally {
          scanLookupInFlight.current = false;
        }
      }
      if (scanScopeRef.current !== requestScope) return;
      if (!match) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          'Código no Encontrado',
          `No se encontró producto con código o SKU: ${cleanCode}`
        );
        return;
      }

      const { product, matchedPresentation, matchedVariant } = match;

      if (matchedPresentation) {
        triggerScanHaptic();
        addItem(product, {
          presentation: matchedPresentation,
          quantity: 1,
        });
        return;
      }

      if (matchedVariant) {
        triggerScanHaptic();
        addItem(product, {
          variant: matchedVariant,
          quantity: 1,
        });
        return;
      }

      const hasPresentations =
        Array.isArray(product.presentations) && product.presentations.length > 0;
      const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
      if (hasPresentations || hasVariants) {
        setVariantModalProduct(product);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }

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

      triggerScanHaptic();
      addItem(product, { quantity: 1 });
    },
    [findByBarcode, findByBarcodeRemote, addItem, scanScope]
  );

  const handleCameraScan = useCallback(
    (result: BarcodeScanningResult) => {
      if (result.data && (!scanCooldownRef.current || result.data !== lastScannedCodeRef.current)) {
        lastScannedCodeRef.current = result.data;
        void handleBarcodeDetected(result.data);
      }
    },
    [handleBarcodeDetected]
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const handleSearchSubmit = useCallback(() => {
    if (searchQuery.trim()) {
      void handleBarcodeDetected(searchQuery);
    }
  }, [searchQuery, handleBarcodeDetected]);

  const enableCatalogFilters = !!posSettings?.enableCatalogFilters;
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 150);

  // Focus-gated memos: freeze cached snapshots while the POS tab is blurred
  const availableBrandsCacheRef = useRef<string[] | null>(null);
  const availableBrands = useMemo(() => {
    if (!isFocused && availableBrandsCacheRef.current !== null) {
      return availableBrandsCacheRef.current;
    }
    if (!isFocused) return EMPTY_OPTIONS;
    const next = ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_BRANDS, catalogIndex.brands)];
    availableBrandsCacheRef.current = next;
    return next;
  }, [isFocused, catalogIndex]);

  const availableSizesCacheRef = useRef<string[] | null>(null);
  const availableSizes = useMemo(() => {
    if (!isFocused && availableSizesCacheRef.current !== null) {
      return availableSizesCacheRef.current;
    }
    if (!isFocused) return EMPTY_OPTIONS;
    const next = ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_SIZES, catalogIndex.sizes)];
    availableSizesCacheRef.current = next;
    return next;
  }, [isFocused, catalogIndex]);

  const filteredProductsCacheRef = useRef<Product[] | null>(null);
  const filteredProducts = useMemo(() => {
    if (!isFocused && filteredProductsCacheRef.current !== null) {
      return filteredProductsCacheRef.current;
    }
    if (!isFocused) return EMPTY_PRODUCTS;
    const next = filterCatalogIndex(catalogIndex, {
      query: debouncedSearchQuery,
      category: selectedCategory,
      brand: selectedBrand,
      size: selectedSize,
    });
    filteredProductsCacheRef.current = next;
    return next;
  }, [isFocused, catalogIndex, debouncedSearchQuery, selectedCategory, selectedBrand, selectedSize]);

  const categoryCountsCacheRef = useRef<FilterOption[] | null>(null);
  const categoryListWithCounts = useMemo(() => {
    if (!isFocused && categoryCountsCacheRef.current !== null) {
      return categoryCountsCacheRef.current;
    }
    if (!isFocused) return EMPTY_CATEGORY_OPTIONS;
    const next = getCatalogCategoryCounts(categories, catalogIndex).map((option) => ({
      ...option,
      count: catalogComplete ? option.count : undefined,
    }));
    categoryCountsCacheRef.current = next;
    return next;
  }, [isFocused, categories, catalogIndex, catalogComplete]);

  const brandOptions = useMemo(() => availableBrands.map((b) => ({ name: b })), [availableBrands]);
  const sizeOptions = useMemo(() => availableSizes.map((s) => ({ name: s })), [availableSizes]);

  const handleSelectCategory = useCallback((cat: string) => setSelectedCategory(cat), []);
  const handleClearCategory = useCallback(() => setSelectedCategory('Todas'), []);
  const handleSelectBrand = useCallback((b: string) => setSelectedBrand(b), []);
  const handleClearBrand = useCallback(() => setSelectedBrand('Todas'), []);
  const handleSelectSize = useCallback((s: string) => setSelectedSize(s), []);
  const handleClearSize = useCallback(() => setSelectedSize('Todas'), []);

  const posFilterGroups: FilterGroup[] = useMemo(() => {
    const groups: FilterGroup[] = [
      {
        id: 'category',
        label: 'Categorías',
        selectedValue: selectedCategory,
        options: categoryListWithCounts,
        onSelect: handleSelectCategory,
        onClear: handleClearCategory,
        icon: 'category',
      },
    ];
    if (enableCatalogFilters) {
      groups.push(
        {
          id: 'brand',
          label: 'Marcas',
          selectedValue: selectedBrand,
          options: brandOptions,
          onSelect: handleSelectBrand,
          onClear: handleClearBrand,
          icon: 'brand' as const,
        },
        {
          id: 'size',
          label: 'Medidas',
          selectedValue: selectedSize,
          options: sizeOptions,
          onSelect: handleSelectSize,
          onClear: handleClearSize,
          icon: 'size' as const,
        }
      );
    }
    return groups;
  }, [
    enableCatalogFilters,
    selectedCategory,
    categoryListWithCounts,
    handleSelectCategory,
    handleClearCategory,
    selectedBrand,
    brandOptions,
    handleSelectBrand,
    handleClearBrand,
    selectedSize,
    sizeOptions,
    handleSelectSize,
    handleClearSize,
  ]);

  const handleOpenPausedModal = useCallback(() => setPausedModalOpen(true), []);
  const handleClosePausedModal = useCallback(() => setPausedModalOpen(false), []);
  const pausedRightElement = useMemo(
    () => <PosPausedSalesBadge onPress={handleOpenPausedModal} />,
    [handleOpenPausedModal]
  );

  // Selección manual de producto desde el catálogo
  const handleProductSelect = useCallback(
    (product: Product) => {
      if (getProductStock(product) <= 0) {
        return;
      }
      const hasPresentations =
        Array.isArray(product.presentations) && product.presentations.length > 0;
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
    },
    [addItem, getProductStock]
  );

  const keyExtractor = useCallback((item: Product) => item.id, []);
  const getItemType = useCallback(
    (item: Product) =>
      enableCatalogFilters && (item.brand || Boolean(item.sizes?.length || item.sizeLabel))
        ? 'product_attr'
        : 'product',
    [enableCatalogFilters]
  );
  const renderPosItem = useCallback(
    ({ item }: { item: Product }) => (
      <PosProductCard
        item={item}
        stock={getProductStock(item)}
        showAttributes={enableCatalogFilters}
        onSelect={handleProductSelect}
      />
    ),
    [getProductStock, enableCatalogFilters, handleProductSelect]
  );

  // Callbacks estables para modales y barra inferior
  const handleOpenCartDrawer = useCallback(() => setCartDrawerOpen(true), []);
  const handleCloseCartDrawer = useCallback(() => setCartDrawerOpen(false), []);
  const handleOpenCheckout = useCallback(() => setCheckoutModalOpen(true), []);
  const handleCloseCheckout = useCallback(() => setCheckoutModalOpen(false), []);
  const handleOpenPromos = useCallback(() => setPromoModalOpen(true), []);
  const handleClosePromos = useCallback(() => setPromoModalOpen(false), []);
  const handleOpenReservation = useCallback(() => setReservationModalOpen(true), []);
  const handleCloseReservation = useCallback(() => setReservationModalOpen(false), []);
  const handleReservationCreated = useCallback((ticket: any) => {
    setCreatedResTicket(ticket);
    setReservationModalOpen(false);
    setCartDrawerOpen(false);
    setResTicketModalOpen(true);
  }, []);
  const handleCloseResTicket = useCallback(() => {
    setResTicketModalOpen(false);
    setCreatedResTicket(null);
  }, []);
  const handleCloseQuickSaleModal = useCallback(() => setQuickSaleModalOpen(false), []);
  const handleCloseWeightSelector = useCallback(() => setWeightSelectorOpen(false), []);
  const handleSelectWeighableProduct = useCallback((product: Product) => {
    setWeightSelectorOpen(false);
    setWeightModalProduct(product);
  }, []);
  const handleCloseFullscreenScanner = useCallback(() => setFullscreenScannerOpen(false), []);
  const handleFullscreenScan = useCallback(
    (code: string) => {
      setFullscreenScannerOpen(false);
      void handleBarcodeDetected(code);
    },
    [handleBarcodeDetected]
  );
  const handleCloseVariantModal = useCallback(() => setVariantModalProduct(null), []);
  const handleConfirmVariantModal = useCallback(
    (
      prod: Product,
      opts: { presentation?: ProductPresentation; variant?: ProductVariant; quantity: number }
    ) => {
      setVariantModalProduct(null);
      triggerScanHaptic();
      addItem(prod, {
        presentation: opts.presentation,
        variant: opts.variant,
        quantity: opts.quantity,
      });
    },
    [addItem, getProductStock]
  );
  const handleCloseWeightModal = useCallback(() => setWeightModalProduct(null), []);
  const handleConfirmWeightModal = useCallback(
    (prod: Product, qty: number, customPrice?: number) => {
      setWeightModalProduct(null);
      triggerScanHaptic();
      addItem(prod, {
        quantity: qty,
        customPrice,
        isWeightBased: true,
      });
    },
    [addItem, getProductStock]
  );
  const handleCloseCompanionScanner = useCallback(() => setCompanionScannerOpen(false), []);
  const handleCloseQuotesModal = useCallback(() => setQuotesModalOpen(false), []);

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
              onSubmitEditing={handleSearchSubmit}
            />
            {searchQuery ? (
              <TouchableOpacity
                onPress={handleClearSearch}
                style={styles.clearSearchBtn}
                accessibilityRole="button"
                accessibilityLabel="Limpiar búsqueda"
                hitSlop={4}
              >
                <X size={16} color={ui.textSecondary} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.searchCountBadge}>
            <Text style={styles.searchCountBadgeNumber}>
              {!catalogComplete ? '…' : filteredProducts.length}
            </Text>
            <Text style={styles.searchCountBadgeLabel}>prod.</Text>
          </View>

          <TouchableOpacity
            style={[
              styles.cameraActionBtn,
              styles.scanActionBtn,
              isCameraActive && styles.scanActionBtnActive,
            ]}
            onPress={toggleInlineCamera}
            accessibilityRole="button"
            accessibilityLabel={
              isCameraActive ? 'Cerrar lector de código de barras' : 'Escanear producto'
            }
            activeOpacity={0.7}
          >
            <Barcode size={20} color={isCameraActive ? ui.onPrimary : ui.primary} />
          </TouchableOpacity>
        </View>

        {isCameraActive && isFocused && (
          <PosInlineScannerCard
            torchOn={torchOn}
            onToggleTorch={handleToggleTorch}
            onClose={handleCloseInlineScanner}
            onBarcodeScanned={handleCameraScan}
          />
        )}

        {/* 2. SELECTORES DE CATEGORÍA, MARCA Y MEDIDA (INLINE BUSCADOR) */}
        <InlineFilterBar groups={posFilterGroups} rightElement={pausedRightElement} />
      </View>

      {/* 3. CATÁLOGO VISUAL DE PRODUCTOS (FLASHLIST DE ALTO RENDIMIENTO) */}
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
              <TouchableOpacity
                onPress={refreshProducts}
                accessibilityRole="button"
                accessibilityLabel="Reintentar sincronización del catálogo"
              >
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
          onPress={handleDismissQuickSaleBanner}
          style={[styles.quickSaleToast, { bottom: Math.max(insets.bottom, 12) + 74 }]}
        >
          <CheckCircle2 size={18} color={ui.primary} />
          <Text style={styles.quickSaleToastText} numberOfLines={1}>
            {quickSaleBanner.text}
          </Text>
          <X size={16} color={ui.surface} />
        </TouchableOpacity>
      ) : null}

      {/* 4. BARRA FLOTANTE INFERIOR (AISLADA CON useCart()) */}
      <PosBottomCartBar
        onOpenCartDrawer={handleOpenCartDrawer}
        onOpenCheckout={handleOpenCheckout}
        onShowQuickSaleBanner={handleShowQuickSaleBanner}
      />

      {/* 5. MODALES AISLADOS */}
      {cartDrawerOpen && (
        <PosCartDrawerModal
          visible={cartDrawerOpen}
          onClose={handleCloseCartDrawer}
          onOpenPromos={handleOpenPromos}
          onOpenReservation={handleOpenReservation}
          onOpenCheckout={handleOpenCheckout}
          onShowQuickSaleBanner={handleShowQuickSaleBanner}
        />
      )}

      {quickSaleModalOpen && (
        <PosQuickConceptModal
          visible={quickSaleModalOpen}
          onClose={handleCloseQuickSaleModal}
        />
      )}

      {reservationModalOpen && (
        <PosReservationModal
          visible={reservationModalOpen}
          onClose={handleCloseReservation}
          onCreated={handleReservationCreated}
        />
      )}

      {pausedModalOpen && (
        <PosPausedSalesModal
          visible={pausedModalOpen}
          onClose={handleClosePausedModal}
        />
      )}

      {weightSelectorOpen && (
        <PosWeighablePickerModal
          visible={weightSelectorOpen}
          onClose={handleCloseWeightSelector}
          onSelectProduct={handleSelectWeighableProduct}
        />
      )}

      {fullscreenScannerOpen && (
        <BarcodeScannerModal
          visible={fullscreenScannerOpen}
          onClose={handleCloseFullscreenScanner}
          onScan={handleFullscreenScan}
        />
      )}

      {variantModalProduct !== null && (
        <PresentationVariantModal
          visible={Boolean(variantModalProduct)}
          product={variantModalProduct}
          onClose={handleCloseVariantModal}
          onConfirm={handleConfirmVariantModal}
        />
      )}

      {weightModalProduct !== null && (
        <WeightQuantityModal
          visible={Boolean(weightModalProduct)}
          product={weightModalProduct}
          onClose={handleCloseWeightModal}
          onConfirm={handleConfirmWeightModal}
        />
      )}

      {promoModalOpen && (
        <PosPromoGiftModal
          visible={promoModalOpen}
          onClose={handleClosePromos}
        />
      )}

      {checkoutModalOpen && (
        <CheckoutModal
          visible={checkoutModalOpen}
          onClose={handleCloseCheckout}
          branch={activeBranch}
        />
      )}

      {companionScannerOpen && (
        <CompanionScannerModal
          visible={companionScannerOpen}
          onClose={handleCloseCompanionScanner}
        />
      )}

      {quotesModalOpen && (
        <QuotesManagerModal
          visible={quotesModalOpen}
          onClose={handleCloseQuotesModal}
        />
      )}

      {resTicketModalOpen && (
        <ReservationReceiptModal
          visible={resTicketModalOpen}
          onClose={handleCloseResTicket}
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
  scanActionBtn: {
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primarySoft,
  },
  scanActionBtnActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
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
  productAttrText: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 4,
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
  addPlusBtnDisabled: {
    backgroundColor: ui.border,
  },
  productCardDisabled: {
    opacity: 0.72,
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
});
