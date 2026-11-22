import React, { useState, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  ShoppingBag,
  Trash2,
  X,
  Gift,
  Tag,
  Pause,
  CalendarClock,
  Zap,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useCart } from '@/context/CartContext';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { formatPEN, ui } from '@/lib/theme';
import {
  resolveCartItemMinPrice,
  evaluateCartPromotions,
  cartHasPlasticBagProducts,
  parseNormalizedDecimal,
  ICBPER_BAG_FEE,
  ICBPER_CART_ITEM_ID,
} from '@/lib/product-search';
import type { CartItem, Product } from '@/types';
import { PosCartItemRow } from './PosCartItemRow';
import { posStyles as styles } from './posStyles';
import { useQuickSaleAction, type QuickSaleBannerPayload } from './useQuickSaleAction';

interface PosCartDrawerModalProps {
  visible: boolean;
  onClose: () => void;
  onOpenPromos: () => void;
  onOpenReservation: () => void;
  onOpenCheckout: () => void;
  onShowQuickSaleBanner: (banner: QuickSaleBannerPayload) => void;
}

const DOC_INTENT_INVOICING = [
  { value: 'nota_venta', label: 'NTV' },
  { value: 'boleta', label: 'BOL' },
  { value: 'factura', label: 'FAC' },
  { value: 'quote', label: 'COT' },
] as const;

const DOC_INTENT_SIMPLE = [
  { value: 'nota_venta', label: 'NTV' },
  { value: 'quote', label: 'COT' },
] as const;

const cartKeyExtractor = (item: CartItem) => item.id;

export const PosCartDrawerModal: React.FC<PosCartDrawerModalProps> = React.memo(
  ({
    visible,
    onClose,
    onOpenPromos,
    onOpenReservation,
    onOpenCheckout,
    onShowQuickSaleBanner,
  }) => {
    const { width } = useWindowDimensions();
    const isCompact = width < 360;
    const { accountId, branchId } = useAuthSession();
    const { posSettings, businessSettings, discountSettings, invoicingEnabled } =
      useBusinessSettings();
    const { canModifyPrice } = usePermissions();
    const { products, productsById } = useProducts();
    const {
      items,
      customer,
      subtotal: cartSubtotal,
      discountAmount,
      invoiceIntent,
      saleRequestId,
      sourceQuoteId,
      total,
      totalAmount,
      itemCount,
      totalItemsCount,
      pausedSales,
      addItem,
      updateQuantity,
      updateItemPrice,
      setDiscount,
      setInvoiceIntent,
      removeItem,
      clearCart,
      pauseCurrentSale,
    } = useCart();

    const [editingPriceItemId, setEditingPriceItemId] = useState<string | null>(null);
    const [drawerDiscountStr, setDrawerDiscountStr] = useState('');
    const [showDrawerDiscount, setShowDrawerDiscount] = useState(false);

    const safeTotal = totalAmount ?? total ?? 0;
    const formattedTotal = formatPEN(safeTotal);
    const safeCount = itemCount ?? totalItemsCount ?? 0;

    const enableMinSalePrice =
      posSettings?.enableMinSalePrice !== false &&
      businessSettings?.enableMinSalePrice !== false;

    const handleGoToCheckout = useCallback(() => {
      onClose();
      onOpenCheckout();
    }, [onClose, onOpenCheckout]);

    const { isProcessingQuickSale, handleInstantQuickSale } = useQuickSaleAction({
      onOpenCheckout: handleGoToCheckout,
      onShowQuickSaleBanner,
      onAfterSuccess: onClose,
    });

    const promoSuggestions = useMemo(() => {
      if (!visible || items.length === 0) return [];
      return evaluateCartPromotions(items, discountSettings?.promotions, products, productsById);
    }, [visible, items, discountSettings?.promotions, products, productsById]);

    const hasBagOrPlasticItem = useMemo(() => {
      if (!visible || items.length === 0) return false;
      return cartHasPlasticBagProducts(items);
    }, [visible, items]);

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

    const handleClearCartPrompt = useCallback(() => {
      Alert.alert('Vaciar Carrito', '¿Deseas eliminar todos los productos agregados?', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Vaciar', style: 'destructive', onPress: clearCart },
      ]);
    }, [clearCart]);

    const handlePauseCurrentSale = useCallback(async () => {
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
    }, [items.length, customer?.name, pausedSales.length, pauseCurrentSale]);

    const handleOpenReservationPress = useCallback(() => {
      if (items.length === 0) {
        Alert.alert('Carrito Vacío', 'Agrega productos al carrito para crear una reserva.');
        return;
      }
      onOpenReservation();
    }, [items.length, onOpenReservation]);

    const handleToggleDiscountEditor = useCallback(() => {
      setDrawerDiscountStr(discountAmount > 0 ? discountAmount.toFixed(2) : '');
      setShowDrawerDiscount((v) => !v);
    }, [discountAmount]);

    const handleApplyDiscount = useCallback(() => {
      const val = Math.max(
        0,
        Math.min(cartSubtotal, parseNormalizedDecimal(drawerDiscountStr))
      );
      setDiscount(val);
      setShowDrawerDiscount(false);
    }, [cartSubtotal, drawerDiscountStr, setDiscount]);

    const handleUpdateCartQty = useCallback(
      (id: string, qty: number) => {
        updateQuantity(id, qty);
      },
      [updateQuantity]
    );

    const handleRemoveCartItem = useCallback(
      (id: string) => {
        removeItem(id);
      },
      [removeItem]
    );

    const handleStartEditPrice = useCallback((cartItem: CartItem) => {
      setEditingPriceItemId(cartItem.id);
    }, []);

    const handleSaveItemPrice = useCallback(
      (item: CartItem, rawPriceStr: string) => {
        const priceVal = parseNormalizedDecimal(rawPriceStr);
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
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      },
      [enableMinSalePrice, updateItemPrice]
    );

    const renderCartItem = useCallback(
      ({ item }: { item: CartItem }) => (
        <PosCartItemRow
          item={item}
          isEditingPrice={editingPriceItemId === item.id}
          canModifyPrice={canModifyPrice}
          onUpdateQuantity={handleUpdateCartQty}
          onRemoveItem={handleRemoveCartItem}
          onStartEditPrice={handleStartEditPrice}
          onSavePrice={handleSaveItemPrice}
        />
      ),
      [
        editingPriceItemId,
        canModifyPrice,
        handleUpdateCartQty,
        handleRemoveCartItem,
        handleStartEditPrice,
        handleSaveItemPrice,
      ]
    );

    const docIntentOptions = invoicingEnabled ? DOC_INTENT_INVOICING : DOC_INTENT_SIMPLE;

    return (
      <Modal
        visible={visible}
        animationType="slide"
        transparent
        onRequestClose={onClose}
      >
        <View style={styles.drawerBackdrop}>
          <Pressable style={styles.drawerDismissArea} onPress={onClose} />
          <View style={styles.drawerSheet}>
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
                    onPress={handleClearCartPrompt}
                  >
                    <Trash2 size={18} color={ui.danger} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar detalle de venta"
                  style={styles.drawerIconButton}
                >
                  <X size={22} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

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
                  extraData={editingPriceItemId}
                  keyExtractor={cartKeyExtractor}
                  renderItem={renderCartItem}
                  contentContainerStyle={styles.drawerItemsList}
                  keyboardShouldPersistTaps="handled"
                />
              </View>
            )}

            <View style={styles.drawerFooter}>
              {items.length > 0 ? (
                <View style={styles.drawerMetaBlock}>
                  <View style={styles.docIntentRow}>
                    {docIntentOptions.map((opt) => {
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
                          <Text
                            style={[
                              styles.docIntentChipText,
                              active && styles.docIntentChipTextActive,
                            ]}
                          >
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
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                    >
                      <TouchableOpacity
                        style={[
                          styles.drawerDiscountBadgeBtn,
                          promoSuggestions.length > 0 && { backgroundColor: ui.primarySoft },
                        ]}
                        onPress={onOpenPromos}
                        accessibilityRole="button"
                        accessibilityLabel="Abrir promociones y regalos"
                      >
                        <Gift size={12} color={ui.primary} />
                        <Text
                          style={[
                            styles.drawerDiscountBadgeText,
                            promoSuggestions.length > 0 && { color: ui.primary },
                          ]}
                        >
                          {promoSuggestions.length > 0
                            ? `Promos/Regalos (${promoSuggestions.length})`
                            : 'Promos y Regalos'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.drawerDiscountBadgeBtn}
                        onPress={handleToggleDiscountEditor}
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
                      onPress={onOpenPromos}
                      activeOpacity={0.8}
                    >
                      <Tag size={13} color={ui.primary} />
                      <Text style={styles.promoHintBannerText} numberOfLines={1}>
                        {promoSuggestions[0].name}: {promoSuggestions[0].description}
                      </Text>
                      <Text style={styles.promoHintBannerCta}>Ver</Text>
                    </TouchableOpacity>
                  ) : null}

                  {hasBagOrPlasticItem || Boolean(icbperCartItem) ? (
                    <View style={styles.icbperRow}>
                      <Text style={styles.icbperLabel}>Impuesto bolsa plástica (ICBPER)</Text>
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
                          {icbperCartItem
                            ? `ICBPER activo (${icbperCartItem.quantity}x)`
                            : '+ Agregar S/ 0.50'}
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
                        onPress={handleApplyDiscount}
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
                  onPress={handleOpenReservationPress}
                  accessibilityRole="button"
                  accessibilityLabel="Reservar productos del carrito"
                >
                  <CalendarClock size={15} color={ui.accent} />
                  <Text style={styles.reserveFooterText}>Reservar</Text>
                </TouchableOpacity>
                {safeCount > 0 &&
                safeTotal > 0 &&
                posSettings?.enableQuickSale !== false &&
                !sourceQuoteId &&
                !saleRequestId ? (
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
                  style={[
                    styles.checkoutBtn,
                    (safeCount === 0 || safeTotal <= 0) && styles.checkoutBtnDisabled,
                  ]}
                  onPress={handleGoToCheckout}
                  disabled={safeCount === 0 || safeTotal <= 0}
                >
                  <Text
                    style={[styles.checkoutBtnText, isCompact && styles.checkoutBtnTextCompact]}
                    numberOfLines={1}
                  >
                    Cobrar · {formattedTotal}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    );
  }
);
