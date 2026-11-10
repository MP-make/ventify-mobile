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
} from 'lucide-react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';

import { useCart } from '@/context/CartContext';
import { useProducts } from '@/context/ProductsContext';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { formatPEN, ui } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { PresentationVariantModal } from '@/components/PresentationVariantModal';
import { WeightQuantityModal } from '@/components/WeightQuantityModal';
import { CheckoutModal } from '@/components/CheckoutModal';
import { CompanionScannerModal } from '@/components/CompanionScannerModal';
import { QuotesManagerModal } from '@/components/QuotesManagerModal';
import type { Product, CartItem, PausedSale, ProductPresentation } from '@/types';

export const triggerScanHaptic = () => {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

export default function PosCounterScreen() {
  const insets = useSafeAreaInsets();
  const { branchId, accountId } = useAuth();
  const { products, categories, loading: productsLoading, findByBarcode, getProductStock } = useProducts();
  const {
    items,
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

  // 1. Buscador y Visor de Cámara Embebido
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [fullscreenScannerOpen, setFullscreenScannerOpen] = useState(false);
  const lastScannedCodeRef = useRef<string>('');
  const scanCooldownRef = useRef<boolean>(false);

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
      }, 1000);

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
    if (result.data && result.data !== lastScannedCodeRef.current) {
      lastScannedCodeRef.current = result.data;
      handleBarcodeDetected(result.data);
    }
  };

  // Filtrado de productos por categoría y texto
  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      const matchCat =
        selectedCategory === 'Todas' ||
        (selectedCategory === 'Sin Categoría' ? !p.category : p.category === selectedCategory);

      if (!matchCat) return false;
      if (!q) return true;

      const nameMatch = p.name?.toLowerCase().includes(q);
      const barcodeMatch = p.barcode?.toLowerCase().includes(q);
      const skuMatch = p.sku?.toLowerCase().includes(q);
      return nameMatch || barcodeMatch || skuMatch;
    });
  }, [products, searchQuery, selectedCategory]);

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
    const label = `Cuenta ${pausedSales.length + 1} (${items.length} ítems)`;
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
        <ScreenHeading
          title="Nueva venta"
          subtitle="Busca un producto o escanea su código"
          action={(
            <TouchableOpacity
              style={styles.quickSaleHeaderAction}
              onPress={() => setQuickSaleModalOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Agregar venta rápida"
            >
              <Plus size={18} color={ui.onPrimary} />
              <Text style={styles.quickSaleHeaderActionText}>Venta rápida</Text>
            </TouchableOpacity>
          )}
        />
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

          {/* Escaneo como acción contextual del buscador */}
          <TouchableOpacity
            style={[styles.cameraActionBtn, styles.scanActionBtn, isCameraActive && styles.cameraActionBtnActive]}
            onPress={() => setFullscreenScannerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Escanear producto"
            activeOpacity={0.7}
          >
            <Barcode size={20} color={ui.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.cameraActionBtn}
            onPress={toggleInlineCamera}
            accessibilityRole="button"
            accessibilityLabel={isCameraActive ? 'Ocultar cámara integrada' : 'Abrir cámara integrada'}
            accessibilityState={{ selected: isCameraActive }}
            activeOpacity={0.7}
          >
            {isCameraActive ? <CameraOff size={18} color={ui.primary} /> : <Maximize2 size={18} color={ui.textSecondary} />}
          </TouchableOpacity>
        </View>

        {/* Visor de Cámara Embebida */}
        {isCameraActive ? (
          <View style={styles.inlineCameraContainer}>
            <CameraView
              style={styles.inlineCamera}
              enableTorch={torchOn}
              barcodeScannerSettings={{
                barcodeTypes: ['ean13', 'ean8', 'qr', 'code128', 'code39', 'upc_a', 'upc_e'],
              }}
              onBarcodeScanned={handleCameraScan}
            >
              <View style={styles.cameraOverlayInner}>
                <View style={styles.scanTargetBox} />
                <View style={styles.cameraControlsBar}>
                  <TouchableOpacity
                    style={styles.torchBtn}
                    onPress={() => setTorchOn((prev) => !prev)}
                  >
                    {torchOn ? (
                      <FlashlightOff size={18} color={ui.onPrimary} />
                    ) : (
                      <Flashlight size={18} color={ui.onPrimary} />
                    )}
                    <Text style={styles.torchText}>{torchOn ? 'Linterna ON' : 'Linterna'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.closeCameraMiniBtn}
                    onPress={() => setIsCameraActive(false)}
                  >
                    <Text style={styles.closeCameraMiniText}>Ocultar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </CameraView>
          </View>
        ) : null}

        {/* 2. ACCIONES RÁPIDAS DE MOSTRADOR */}
        <View style={styles.quickActionsGroup}>
          <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.quickActionsBar}
          >
          {/* Botón Ventas en Pausa */}
          <TouchableOpacity
            style={[styles.quickActionPill, pausedSales.length > 0 && styles.quickActionPillActive]}
            onPress={() => setPausedModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Ventas en pausa${pausedSales.length ? `, ${pausedSales.length}` : ''}`}
            activeOpacity={0.7}
          >
            <Pause size={15} color={pausedSales.length > 0 ? ui.primary : ui.textSecondary} />
            <Text
              style={[
                styles.quickActionPillText,
                pausedSales.length > 0 && { color: ui.primary, fontWeight: '700' },
              ]}
            >
              En Pausa
            </Text>
            {pausedSales.length > 0 ? (
              <View style={styles.pausedBadge}>
                <Text style={styles.pausedBadgeText}>{pausedSales.length}</Text>
              </View>
            ) : null}
          </TouchableOpacity>

          {/* Botón Peso / Fracción */}
          <TouchableOpacity
            style={styles.quickActionPill}
            onPress={() => setWeightSelectorOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Productos por peso o fracción"
            activeOpacity={0.7}
          >
            <Scale size={15} color={ui.accent} />
            <Text style={styles.quickActionPillText}>Peso / Fracción</Text>
          </TouchableOpacity>

          {/* Botón Cotizaciones */}
          <TouchableOpacity
            style={styles.quickActionPill}
            onPress={() => setQuotesModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir cotizaciones"
            activeOpacity={0.7}
          >
            <FileText size={15} color={ui.accent} />
            <Text style={styles.quickActionPillText}>Cotizaciones</Text>
          </TouchableOpacity>

          {/* Botón Escáner Remoto PC */}
          <TouchableOpacity
            style={styles.quickActionPill}
            onPress={() => setCompanionScannerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir escáner conectado a PC"
            activeOpacity={0.7}
          >
            <Laptop size={15} color={ui.primary} />
            <Text style={styles.quickActionPillText}>Escáner PC</Text>
          </TouchableOpacity>
          </ScrollView>
        </View>

        {/* 3. PILLS HORIZONTALES DE CATEGORÍAS */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoriesScroll}
          contentContainerStyle={styles.categoriesContent}
        >
          {['Todas', ...categories.filter((c) => c !== 'Todas' && c !== 'Todos')].map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.catPill, isSelected && styles.catPillSelected]}
                onPress={() => setSelectedCategory(cat)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`Categoría ${cat}`}
                activeOpacity={0.7}
              >
                <Text style={[styles.catPillText, isSelected && styles.catPillTextSelected]}>
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* 4. CATÁLOGO VISUAL DE PRODUCTOS (FLASHLIST DE ALTO RENDIMIENTO) */}
      <View style={styles.catalogArea}>
        <View style={styles.catalogHeading}>
          <SectionHeading
            title="Catálogo"
            subtitle={productsLoading ? 'Cargando catálogo…' : `${filteredProducts.length} productos`}
          />
        </View>
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
                        ) : (
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
                  <Pause size={16} color={ui.primary} />
                  <Text style={styles.pauseSaleFooterText}>Pausar Cuenta</Text>
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

      {/* MODAL DE VENTA RÁPIDA (CONCEPTO LIBRE) */}
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
                <Zap size={18} color={ui.warning} />
                <Text style={styles.subModalTitle}>Venta Rápida (Concepto Libre)</Text>
              </View>
              <TouchableOpacity onPress={() => setQuickSaleModalOpen(false)}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Descripción / Concepto</Text>
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
  inlineCameraContainer: {
    height: 180,
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 10,
    backgroundColor: '#000000',
  },
  inlineCamera: {
    flex: 1,
  },
  cameraOverlayInner: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'space-between',
    padding: 10,
    alignItems: 'center',
  },
  scanTargetBox: {
    width: 200,
    height: 80,
    borderWidth: 2,
    borderColor: ui.primary,
    borderRadius: 10,
    marginTop: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  cameraControlsBar: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  torchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 16,
  },
  torchText: {
    color: ui.surface,
    fontSize: 11,
    fontWeight: '600',
  },
  closeCameraMiniBtn: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 16,
  },
  closeCameraMiniText: {
    color: ui.surface,
    fontSize: 11,
    fontWeight: '600',
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
  categoriesScroll: {
    marginTop: 8,
    marginHorizontal: 20,
  },
  categoriesContent: {
    gap: 6,
  },
  catPill: {
    paddingHorizontal: 12,
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  catPillSelected: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  catPillText: {
    fontSize: 12,
    fontWeight: '500',
    color: ui.textSecondary,
  },
  catPillTextSelected: {
    color: ui.onPrimary,
    fontWeight: '700',
  },
  catalogArea: {
    flex: 1,
    paddingTop: 8,
  },
  catalogHeading: {
    paddingHorizontal: 20,
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
});
