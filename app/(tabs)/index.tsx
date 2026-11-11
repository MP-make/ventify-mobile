import React, { useState, useRef, useMemo, useCallback } from 'react';
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
  CalendarClock,
  User,
} from 'lucide-react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';

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
import { InlineFilterBar } from '@/components/InlineFilterBar';
import { createReservationOrOrder } from '@/services/crm-operations-service';
import { lookupDocument } from '@/lib/dni-ruc-service';
import { isValidDNI } from '@/lib/invoicing/types';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';
import {
  catalogBrand,
  catalogSizes,
  DEFAULT_CATALOG_BRANDS,
  DEFAULT_CATALOG_SIZES,
  mergeCatalogOptions,
  normalizeCatalogLabel,
} from '@/lib/catalog-filters';
import type { Product, CartItem, PausedSale, ProductPresentation } from '@/types';

export const triggerScanHaptic = () => {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

const normalizeStr = (str: string = '') =>
  str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

export default function PosCounterScreen() {
  const insets = useSafeAreaInsets();
  const { branchId, accountId, user, userProfile } = useAuth();
  const { posSettings, activeCashSession, businessSettings } = useSettings();
  const { canModifyPrice } = usePermissions();
  const { products, categories, loading: productsLoading, findByBarcode, getProductStock } = useProducts();
  const {
    items,
    customer,
    total,
    totalAmount,
    itemCount,
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
  } = useCart();

  const safeTotal = totalAmount ?? total ?? 0;
  const safeCount = itemCount ?? totalItemsCount ?? 0;

  // 1. Buscador, Categorías y Filtros de Catálogo
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [categoryDropdownExpanded, setCategoryDropdownExpanded] = useState(false);
  const [categorySearchQuery, setCategorySearchQuery] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('Todas');
  const [selectedSize, setSelectedSize] = useState('Todas');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [fullscreenScannerOpen, setFullscreenScannerOpen] = useState(false);
  const lastScannedCodeRef = useRef<string>('');
  const scanCooldownRef = useRef<boolean>(false);

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

  // Detección automática de DNI al ingresar 8 dígitos
  React.useEffect(() => {
    const cleanDni = resCustomerDoc.trim().replace(/\D/g, '');
    if (cleanDni.length === 8 && isValidDNI(cleanDni)) {
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
    }
  }, [resCustomerDoc]);

  // 2. Modales Especiales
  const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
  const [variantModalProduct, setVariantModalProduct] = useState<Product | null>(null);
  const [weightModalProduct, setWeightModalProduct] = useState<Product | null>(null);
  const [weightSelectorOpen, setWeightSelectorOpen] = useState(false);
  const [companionScannerOpen, setCompanionScannerOpen] = useState(false);
  const [quotesModalOpen, setQuotesModalOpen] = useState(false);

  // 3. Venta Rápida (Concepto Libre)
  const [quickSaleModalOpen, setQuickSaleModalOpen] = useState(false);
  const [quickConcept, setQuickConcept] = useState('Venta Rápida');
  const [quickAmountStr, setQuickAmountStr] = useState('');

  // 4. Ventas en Pausa
  const [pausedModalOpen, setPausedModalOpen] = useState(false);

  // 5. Drawer del Carrito
  const [cartDrawerOpen, setCartDrawerOpen] = useState(false);
  const [editingPriceItemId, setEditingPriceItemId] = useState<string | null>(null);
  const [newPriceStr, setNewPriceStr] = useState('');

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
    (code: string) => {
      const cleanCode = code.trim();
      if (!cleanCode || scanCooldownRef.current) return;

      scanCooldownRef.current = true;
      setTimeout(() => {
        scanCooldownRef.current = false;
        lastScannedCodeRef.current = '';
      }, 1200);

      const match = findByBarcode(cleanCode);
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
          customPrice: matchedPresentation.price,
        });
        return;
      }

      // 2. Si se escaneó un código propio de variante
      if (matchedVariant) {
        triggerScanHaptic();
        addItem(product, {
          variant: matchedVariant,
          quantity: 1,
          customPrice: matchedVariant.price ?? product.price,
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
    [findByBarcode, addItem]
  );

  // Escaneo desde la cámara embebida
  const handleCameraScan = (result: BarcodeScanningResult) => {
    if (result.data && (!scanCooldownRef.current || result.data !== lastScannedCodeRef.current)) {
      lastScannedCodeRef.current = result.data;
      handleBarcodeDetected(result.data);
    }
  };

  const enableCatalogFilters = !!posSettings?.enableCatalogFilters;

  // Marcas únicas del catálogo (incluye atributos y marcas predeterminadas como en la web)
  const availableBrands = useMemo(() => {
    const extracted = products.map(catalogBrand).filter(Boolean);
    return ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_BRANDS, extracted)];
  }, [products]);

  // Tallas / Medidas únicas del catálogo
  const availableSizes = useMemo(() => {
    const extracted = products.flatMap(catalogSizes).filter(Boolean);
    return ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_SIZES, extracted)];
  }, [products]);

  // Filtrado de productos por categoría, marca, talla y texto (insensible a tildes)
  const filteredProducts = useMemo(() => {
    const q = normalizeCatalogLabel(searchQuery);
    return products.filter((p) => {
      // 1. Filtro Categoría
      const matchCat =
        selectedCategory === 'Todas' ||
        (selectedCategory === 'Sin Categoría'
          ? !p.category
          : normalizeCatalogLabel(p.category) === normalizeCatalogLabel(selectedCategory));
      if (!matchCat) return false;

      // 2. Filtro Marca
      if (selectedBrand !== 'Todas') {
        const pBrand = normalizeCatalogLabel(catalogBrand(p));
        if (pBrand !== normalizeCatalogLabel(selectedBrand)) {
          return false;
        }
      }

      // 3. Filtro Talla / Medida
      if (selectedSize !== 'Todas') {
        const pSizes = catalogSizes(p).map(normalizeCatalogLabel);
        if (!pSizes.includes(normalizeCatalogLabel(selectedSize))) {
          return false;
        }
      }

      // 4. Texto libre (nombre, sku, código o marca)
      if (!q) return true;

      const normName = normalizeCatalogLabel(p.name);
      const normBarcode = normalizeCatalogLabel(p.barcode || '');
      const normSku = normalizeCatalogLabel(p.sku || '');
      const normBrand = normalizeCatalogLabel(catalogBrand(p));
      return (
        normName.includes(q) ||
        normBarcode.includes(q) ||
        normSku.includes(q) ||
        normBrand.includes(q)
      );
    });
  }, [products, searchQuery, selectedCategory, selectedBrand, selectedSize]);

  // Lista de categorías con conteo de productos
  const categoryListWithCounts = useMemo(() => {
    const rawCategories = ['Todas', ...categories.filter((c) => c !== 'Todas' && c !== 'Todos')];
    return rawCategories.map((cat) => {
      const count =
        cat === 'Todas'
          ? products.length
          : cat === 'Sin Categoría'
          ? products.filter((p) => !p.category).length
          : products.filter((p) => p.category === cat).length;
      return { name: cat, count };
    });
  }, [categories, products]);

  // Categorías filtradas por el buscador del selector (insensible a tildes e iniciales)
  const filteredCategoriesList = useMemo(() => {
    const q = normalizeStr(categorySearchQuery);
    if (!q) return categoryListWithCounts;
    return categoryListWithCounts.filter((c) => {
      const norm = normalizeStr(c.name);
      return norm.includes(q) || norm.startsWith(q);
    });
  }, [categoryListWithCounts, categorySearchQuery]);

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

    const depositNum = parseFloat(resDepositStr) || 0;
    if (depositNum < 0) {
      Alert.alert('Monto Inválido', 'El adelanto no puede ser negativo.');
      return;
    }
    if (depositNum > safeTotal) {
      Alert.alert('Adelanto Excedido', 'El adelanto no puede ser mayor al total de la reserva.');
      return;
    }

    try {
      setIsSavingRes(true);
      const days = parseInt(resDays, 10) || 7;
      const pickupDate = new Date();
      pickupDate.setDate(pickupDate.getDate() + days);
      const pad = (n: number) => String(n).padStart(2, '0');
      const pickupDateStr = `${pickupDate.getFullYear()}-${pad(pickupDate.getMonth() + 1)}-${pad(pickupDate.getDate())}`;

      const reservationId = await createReservationOrOrder({
        accountId: accountId || 'default',
        branchId: branchId || 'main',
        sessionId: activeCashSession?.sessionId || (activeCashSession as any)?.id,
        type: 'reservation',
        items: items.map((it) => ({
          productId: it.id,
          productName: it.name,
          quantity: it.quantity,
          price: it.price,
          sku: it.sku || '',
          presentationQty: it.presentation?.conversionFactor || 1,
        })),
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
        accountId: accountId || 'default',
        branchId: branchId || 'main',
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
  const handleProductSelect = (product: Product) => {
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
  };

  // Confirmar Venta Rápida (concepto libre)
  const handleConfirmQuickSale = () => {
    const amountNum = parseFloat(quickAmountStr);
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

  // Guardar Nuevo Precio Editado
  const handleSaveItemPrice = (item: CartItem) => {
    const priceVal = parseFloat(newPriceStr);
    if (isNaN(priceVal) || priceVal <= 0) {
      Alert.alert('Precio Inválido', 'Ingresa un precio válido en soles.');
      return;
    }

    const minFloor = item.minSalePrice ?? item.product?.minSalePrice ?? 0;
    if (priceVal < minFloor) {
      Alert.alert(
        'Precio Mínimo no Permitido',
        `El precio no puede ser menor al precio mínimo autorizado (${formatPEN(minFloor)}).`
      );
      return;
    }

    const ok = updateItemPrice(item.id, priceVal);
    if (ok) {
      setEditingPriceItemId(null);
      setNewPriceStr('');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
              {productsLoading ? '…' : filteredProducts.length}
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
        {isCameraActive && (
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
                barcodeScannerSettings={{
                  barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e'],
                }}
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
          groups={[
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
              options: availableBrands.map((b) => ({ name: b })),
              onSelect: (b: string) => setSelectedBrand(b),
              onClear: () => setSelectedBrand('Todas'),
              icon: 'brand' as const,
            },
            {
              id: 'size',
              label: 'Medidas',
              selectedValue: selectedSize,
              options: availableSizes.map((s) => ({ name: s })),
              onSelect: (s: string) => setSelectedSize(s),
              onClear: () => setSelectedSize('Todas'),
              icon: 'size' as const,
            },
          ]}
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
            estimatedItemSize={76}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const stock = getProductStock(item);
              const minStock = (item as any).minStock || 3;
              const isOutOfStock = stock <= 0;
              const isLowStock = stock > 0 && stock <= minStock;

              const price = Number(item.suggestedPrice ?? item.price ?? 0);

              return (
                <TouchableOpacity
                  style={styles.productCard}
                  onPress={() => handleProductSelect(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Agregar ${item.name}, ${formatPEN(price)}${isOutOfStock ? ', agotado' : `, stock ${stock}`}`}
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
                  </View>

                  <View style={styles.productPriceCol}>
                    <Text style={styles.productPrice}>{formatPEN(price)}</Text>
                    <View style={styles.addPlusBtn}>
                      <Plus size={16} color={ui.onPrimary} />
                    </View>
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>

      {/* 5. BARRA FLOTANTE INFERIOR Y RESUMEN DEL CARRITO */}
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TouchableOpacity
          style={styles.cartSummaryToggle}
          onPress={() => setCartDrawerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Ver carrito, ${safeCount} ${safeCount === 1 ? 'ítem' : 'ítems'}, total ${formatPEN(safeTotal)}`}
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
              {safeCount} {safeCount === 1 ? 'producto' : 'productos'}
            </Text>
            <Text style={styles.cartTotalSummaryText}>Ver carrito</Text>
          </View>
          <ChevronUp size={16} color={ui.textSecondary} />
        </TouchableOpacity>

        {/* BOTÓN GRANDE COBRAR */}
        <TouchableOpacity
          style={[styles.checkoutBtn, (safeCount === 0 || safeTotal <= 0) && styles.checkoutBtnDisabled]}
          onPress={() => setCheckoutModalOpen(true)}
          disabled={safeCount === 0 || safeTotal <= 0}
          accessibilityRole="button"
          accessibilityLabel={`Cobrar ${formatPEN(safeTotal)}`}
          activeOpacity={0.8}
        >
            <Text style={styles.checkoutBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>Cobrar · {formatPEN(safeTotal)}</Text>
          <ArrowRight size={20} color={ui.onPrimary} />
        </TouchableOpacity>
      </View>

      {/* DRAWER / MODAL DEL DETALLE DEL CARRITO */}
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
            <ScrollView style={styles.drawerItemsList}>
              {items.length === 0 ? (
                <View style={styles.drawerEmptyBox}>
                  <ShoppingBag size={36} color={ui.border} />
                  <Text style={styles.drawerEmptyText}>El carrito está vacío</Text>
                </View>
              ) : (
                items.map((item) => {
                  const itemPrice = item.price;
                  const itemSubtotal = item.lineTotal !== undefined ? item.lineTotal : itemPrice * item.quantity;
                  const isEditingPrice = editingPriceItemId === item.id;

                  return (
                    <View key={item.id} style={styles.drawerCartItem}>
                      <View style={styles.drawerCartItemTop}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.drawerCartItemName}>{item.name}</Text>
                          {item.presentation ? (
                            <Text style={styles.drawerCartItemSub}>
                              Pres: {item.presentation.name} (x{item.presentation.conversionFactor})
                            </Text>
                          ) : item.variant ? (
                            <Text style={styles.drawerCartItemSub}>Var: {item.variant.name}</Text>
                          ) : null}
                        </View>
                        <Text style={styles.drawerCartItemSubtotal}>{formatPEN(itemSubtotal)}</Text>
                      </View>

                      {/* Fila de Controles de Cantidad y Precio */}
                      <View style={styles.drawerCartItemControls}>
                        {/* Selector de Cantidad */}
                        <View style={styles.qtyControlRow}>
                          <TouchableOpacity
                            style={styles.qtyBtn}
                            onPress={() => updateQuantity(item.id, item.quantity - 1)}
                            accessibilityRole="button"
                            accessibilityLabel={`Reducir cantidad de ${item.name}`}
                          >
                            <Minus size={15} color={ui.text} />
                          </TouchableOpacity>
                          <Text style={styles.qtyNumberText}>{item.quantity}</Text>
                          <TouchableOpacity
                            style={styles.qtyBtn}
                            onPress={() => updateQuantity(item.id, item.quantity + 1)}
                            accessibilityRole="button"
                            accessibilityLabel={`Aumentar cantidad de ${item.name}`}
                          >
                            <Plus size={15} color={ui.text} />
                          </TouchableOpacity>
                        </View>

                        {/* Editor de Precio Unitario */}
                        {isEditingPrice ? (
                          <View style={styles.editPriceInputRow}>
                            <TextInput
                              style={styles.editPriceInput}
                              value={newPriceStr}
                              onChangeText={setNewPriceStr}
                              keyboardType="decimal-pad"
                              placeholder="0.00"
                              autoFocus
                            />
                            <TouchableOpacity
                              style={styles.savePriceBtn}
                              onPress={() => handleSaveItemPrice(item)}
                            >
                              <Text style={styles.savePriceBtnText}>OK</Text>
                            </TouchableOpacity>
                          </View>
                        ) : canModifyPrice ? (
                          <TouchableOpacity
                            style={styles.unitPriceBadge}
                            accessibilityRole="button"
                            accessibilityLabel={`Editar precio de ${item.name}, ${formatPEN(itemPrice)} por ${item.unitOfMeasure || 'unidad'}`}
                            onPress={() => {
                              setEditingPriceItemId(item.id);
                              setNewPriceStr(String(item.price));
                            }}
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
                          onPress={() => removeItem(item.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`Quitar ${item.name} del carrito`}
                        >
                          <Trash2 size={16} color={ui.danger} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>

            {/* Footer del Carrito */}
            <View style={styles.drawerFooter}>
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
                <TouchableOpacity
                  style={[styles.checkoutBtn, (safeCount === 0 || safeTotal <= 0) && styles.checkoutBtnDisabled]}
                  onPress={() => {
                    setCartDrawerOpen(false);
                    setCheckoutModalOpen(true);
                  }}
                  disabled={safeCount === 0 || safeTotal <= 0}
                >
                  <Text style={styles.checkoutBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>Cobrar · {formatPEN(safeTotal)}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* MODAL DE MONTO LIBRE (ÍTEM SIN CATALOGAR) */}
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

      {/* MODAL DE RESERVA DE PRODUCTOS */}
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

      {/* MODAL DE CUENTAS EN PAUSA */}
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

      {/* SELECTOR RÁPIDO PARA PRODUCTO POR PESO */}
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
              {products
                .filter(
                  (p) =>
                    p.allowDecimals ||
                    p.unitOfMeasure === 'kg' ||
                    p.unitOfMeasure === 'KGM' ||
                    (p as any).unit === 'kg'
                )
                .map((p) => (
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

      {/* MODALES EXTERNOS */}
      <BarcodeScannerModal
        visible={fullscreenScannerOpen}
        onClose={() => setFullscreenScannerOpen(false)}
        onScan={(code) => {
          setFullscreenScannerOpen(false);
          handleBarcodeDetected(code);
        }}
      />

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
            customPrice: opts.presentation?.price ?? opts.variant?.price,
          });
        }}
      />

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

      <CheckoutModal
        visible={checkoutModalOpen}
        onClose={() => setCheckoutModalOpen(false)}
      />

      <CompanionScannerModal
        visible={companionScannerOpen}
        onClose={() => setCompanionScannerOpen(false)}
      />

      <QuotesManagerModal
        visible={quotesModalOpen}
        onClose={() => setQuotesModalOpen(false)}
      />

      <ReservationReceiptModal
        visible={resTicketModalOpen}
        onClose={() => {
          setResTicketModalOpen(false);
          setCreatedResTicket(null);
        }}
        reservation={createdResTicket}
        business={businessSettings}
      />
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
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 12,
  },
  cartSummaryToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
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
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  checkoutBtn: {
    flex: 1.2,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: ui.primary,
    borderRadius: 14,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 10,
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
    padding: 14,
    maxHeight: 320,
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
});
