import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  Check,
  Plus,
  Minus,
  Barcode,
  Package,
  AlertTriangle,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Product, ProductPresentation, ProductVariant } from '@/types';
import { formatPEN, ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import { getAllPresentations, getBranchPricingConfig } from '@/lib/product-search';
import { presentationFactor } from '@/lib/presentation-parity';
import { useAuthSession } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { getCartReservedUnitsForProduct, round4 } from '@/lib/offline-stock-helpers';
import {
  getVariantBranchStock,
  resolvePresentationVariantPrice,
  resolvePresentationVariantStock,
} from '@/services/inventory-kardex-service';

export interface PresentationVariantModalProps {
  product: Product | null;
  visible?: boolean;
  isOpen?: boolean;
  onClose: () => void;
  onConfirm: (
    product: Product,
    options: {
      presentation?: ProductPresentation;
      variant?: ProductVariant;
      quantity: number;
    }
  ) => void;
}

const PresentationVariantModalContent: React.FC<
  PresentationVariantModalProps & { product: Product; isModalVisible: boolean }
> = React.memo(({
  product,
  isModalVisible,
  onClose,
  onConfirm,
}) => {
  const insets = useSafeAreaInsets();
  const { branchId } = useAuthSession();
  const { items: cartItems } = useCart();
  const { posSettings } = useBusinessSettings();
  const effectiveBranchId = branchId || 'main';
  const enableMinSalePrice = posSettings?.enableMinSalePrice !== false;

  const [selectedPresentation, setSelectedPresentation] = useState<ProductPresentation | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [quantity, setQuantity] = useState<number>(1);

  const branchPricing = useMemo(
    () => getBranchPricingConfig(product, effectiveBranchId, enableMinSalePrice),
    [product, effectiveBranchId, enableMinSalePrice]
  );

  const presentations = useMemo(() => {
    const raw =
      branchPricing?.presentations && branchPricing.presentations.length > 0
        ? branchPricing.presentations
        : getAllPresentations(product);
    return raw.filter((p) => p.active !== false);
  }, [product, branchPricing]);

  // Inicializar selecciones cuando se abre el modal
  useEffect(() => {
    setQuantity(1);

    if (presentations.length > 0) {
      setSelectedPresentation(presentations[0]);
    } else {
      setSelectedPresentation(null);
    }

    if (Array.isArray(product.variants) && product.variants.length > 0) {
      const firstInStock = product.variants.find(
        (v) => getVariantBranchStock(v, effectiveBranchId) > 0
      );
      setSelectedVariant(firstInStock ?? product.variants[0]);
    } else {
      setSelectedVariant(null);
    }
  }, [isModalVisible, product, presentations, effectiveBranchId]);

  const basePrice = Number(
    branchPricing?.suggestedPrice ?? product.suggestedPrice ?? product.price ?? 0
  );
  const effectiveMinSalePrice = enableMinSalePrice
    ? Number(branchPricing?.minSalePrice ?? product.minSalePrice ?? 0)
    : 0;

  // Calcular precio unitario e importe total de la combinación presentación + variante
  const { unitPrice, factor, effectivePresentation } = useMemo(
    () =>
      resolvePresentationVariantPrice({
        basePrice,
        presentation: selectedPresentation,
        variant: selectedVariant,
        minSalePrice: effectiveMinSalePrice > 0 ? effectiveMinSalePrice : undefined,
        enableMinSalePrice,
      }),
    [basePrice, selectedPresentation, selectedVariant, effectiveMinSalePrice, enableMinSalePrice]
  );

  // Memoizar precios de unidad base y de cada presentación para evitar recálculos al cambiar cantidad
  const { baseWithVariantPrice, presentationPricingList } = useMemo(() => {
    const baseVariantPrice = resolvePresentationVariantPrice({
      basePrice,
      presentation: null,
      variant: selectedVariant,
      minSalePrice: effectiveMinSalePrice > 0 ? effectiveMinSalePrice : undefined,
      enableMinSalePrice,
    }).unitPrice;

    const list = presentations.map((pres) => {
      const presFactor = presentationFactor(pres);
      const presPrice = resolvePresentationVariantPrice({
        basePrice,
        presentation: pres,
        variant: selectedVariant,
        minSalePrice: effectiveMinSalePrice > 0 ? effectiveMinSalePrice : undefined,
        enableMinSalePrice,
      }).unitPrice;
      const singleEquivalent = presFactor > 0 ? presPrice / presFactor : presPrice;
      const savings =
        baseVariantPrice > singleEquivalent
          ? Math.round(((baseVariantPrice - singleEquivalent) / baseVariantPrice) * 100)
          : 0;
      return {
        pres,
        presFactor,
        presPrice,
        singleEquivalent,
        savings,
      };
    });

    return {
      baseWithVariantPrice: baseVariantPrice,
      presentationPricingList: list,
    };
  }, [product, selectedVariant, branchId, posSettings, presentations, basePrice, effectiveMinSalePrice, enableMinSalePrice]);

  const variantStockList = useMemo(
    () =>
      Array.isArray(product.variants) && product.variants.length > 0
        ? product.variants.map((v) => ({
            variant: v,
            stock: Math.max(
              0,
              round4(
                getVariantBranchStock(v, effectiveBranchId) -
                  getCartReservedUnitsForProduct(cartItems, product.id, v.id)
              )
            ),
          }))
        : [],
    [product, effectiveBranchId, cartItems]
  );

  const lineTotal = Math.round(unitPrice * quantity * 100) / 100;

  // Validar disponibilidad real considerando stock reservado, variantes y unidades ya en el carrito
  const { productAvailable, variantStock, effectiveAvailable, maxUnits } = useMemo(() => {
    const raw = resolvePresentationVariantStock({
      product,
      branchId: effectiveBranchId,
      presentation: selectedPresentation,
      variant: selectedVariant,
    });
    const cartReservedTotal = getCartReservedUnitsForProduct(cartItems, product.id);
    const cartReservedVariant = selectedVariant
      ? getCartReservedUnitsForProduct(cartItems, product.id, selectedVariant.id)
      : 0;
    const remProductAvailable = Math.max(0, round4(raw.productAvailable - cartReservedTotal));
    const remVariantAvailable =
      selectedVariant && raw.variantStock !== null
        ? Math.max(0, round4(raw.variantStock - cartReservedVariant))
        : null;
    const adjustedAvailable =
      remVariantAvailable !== null
        ? Math.min(remProductAvailable, remVariantAvailable)
        : remProductAvailable;
    const adjustedMaxUnits =
      factor > 0 ? Math.max(0, Math.floor((adjustedAvailable + 0.00001) / factor)) : 0;
    return {
      productAvailable: remProductAvailable,
      variantStock: remVariantAvailable,
      effectiveAvailable: adjustedAvailable,
      maxUnits: adjustedMaxUnits,
    };
  }, [product, effectiveBranchId, selectedPresentation, selectedVariant, cartItems, factor]);

  const requiredUnits = Math.round(quantity * factor * 10000) / 10000;
  const isStockInsufficient = effectiveAvailable <= 0 || requiredUnits > effectiveAvailable;

  // Mantener quantity dentro de maxUnits cuando cambia de presentación/variante
  useEffect(() => {
    if (maxUnits >= 1 && quantity > maxUnits) {
      setQuantity(maxUnits);
    }
  }, [maxUnits, quantity]);

  const hasVariants = variantStockList.length > 0;

  const handleConfirm = () => {
    if (isStockInsufficient) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onConfirm(product, {
      presentation: effectivePresentation,
      variant: selectedVariant || undefined,
      quantity,
    });
    onClose();
  };

  const incrementQty = () => {
    if (maxUnits <= 0 || quantity >= maxUnits) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setQuantity((q) => Math.min(maxUnits, q + 1));
  };

  const decrementQty = () => {
    if (quantity > 1) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setQuantity((q) => q - 1);
    }
  };

  return (
    <Modal
      visible={isModalVisible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.sheetContainer,
            { paddingBottom: Math.max(insets.bottom, 20) },
          ]}
        >
          {/* Cabecera del Modal */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              {product.thumbUrl || product.imageUrl ? (
                <Image
                  source={{ uri: product.thumbUrl || product.imageUrl }}
                  style={styles.productThumb}
                  cachePolicy="memory-disk"
                  recyclingKey={product.id}
                />
              ) : (
                <View style={styles.productThumbPlaceholder}>
                  <Package size={22} color={ui.primary} />
                </View>
              )}
              <View style={styles.headerTextContainer}>
                <Text style={styles.productName} numberOfLines={1}>
                  {product.name}
                </Text>
                <Text style={styles.productMeta}>
                  Disp.: {productAvailable}
                  {variantStock !== null ? ` • Var.: ${variantStock}` : ''} • Base: {formatPEN(basePrice)}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Cerrar selección">
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.bodyScroll} showsVerticalScrollIndicator={false}>
            {/* Sección 1: Selección de Presentaciones */}
            {presentations.length > 0 && (
              <View style={styles.section}>
                <SectionHeading title="Presentación" subtitle="Elige cómo vender este producto" />

                {/* Opción Unidad Simple */}
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                    setSelectedPresentation(null);
                    setQuantity(1);
                  }}
                  style={[
                    styles.optionCard,
                    selectedPresentation === null && styles.optionCardSelected,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Unidad base, ${formatPEN(baseWithVariantPrice)}`}
                  accessibilityState={{ selected: selectedPresentation === null }}
                  activeOpacity={0.7}
                >
                  <View style={styles.optionCardLeft}>
                    <Text
                      style={[
                        styles.optionTitle,
                        selectedPresentation === null && styles.optionTitleSelected,
                      ]}
                    >
                      Unidad Base (1 {product.unitOfMeasure || 'unidad'})
                    </Text>
                    <Text style={styles.optionFactor}>Consume 1 unidad de stock</Text>
                  </View>
                  <Text style={styles.optionPrice}>{formatPEN(baseWithVariantPrice)}</Text>
                </TouchableOpacity>

                {/* Opciones de Presentaciones (Packs, Cajas) */}
                {presentationPricingList.map(({ pres, presFactor, presPrice, singleEquivalent, savings }) => {
                  const isSelected = selectedPresentation?.id === pres.id;

                  return (
                    <TouchableOpacity
                      key={pres.id}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                        setSelectedPresentation(pres);
                        setQuantity(1);
                      }}
                      style={[
                        styles.optionCard,
                        isSelected && styles.optionCardSelected,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`${pres.name}, ${formatPEN(presPrice)}, ${presFactor} unidades`}
                      accessibilityState={{ selected: isSelected }}
                      activeOpacity={0.7}
                    >
                      <View style={styles.optionCardLeft}>
                        <View style={styles.optionNameBadgeRow}>
                          <Text
                            style={[
                              styles.optionTitle,
                              isSelected && styles.optionTitleSelected,
                            ]}
                          >
                            {pres.name}
                          </Text>
                          {savings > 0 && (
                            <View style={styles.savingsBadge}>
                              <Text style={styles.savingsText}>-{savings}%</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.optionFactor}>
                          Consume {presFactor} unidades • {formatPEN(singleEquivalent)} c/u
                        </Text>
                        {pres.barcode ? (
                          <View style={styles.barcodeRow}>
                            <Barcode size={12} color={ui.textSecondary} />
                            <Text style={styles.barcodeText}>{pres.barcode}</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.optionPrice}>{formatPEN(presPrice)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Sección 2: Selección de Variantes (Talla / Color) */}
            {hasVariants && (
              <View style={styles.section}>
                <SectionHeading title="Variante" subtitle="Selecciona color o talla" />

                <View style={styles.variantsGrid}>
                  {variantStockList.map(({ variant: v, stock: vStock }) => {
                    const isSelected = selectedVariant?.id === v.id;

                    return (
                      <TouchableOpacity
                        key={v.id}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                          setSelectedVariant(v);
                        }}
                        style={[
                          styles.variantChip,
                          isSelected && styles.variantChipSelected,
                          vStock <= 0 && styles.variantChipOutOfStock,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`${v.name}${v.sizeLabel ? `, talla ${v.sizeLabel}` : ''}, stock ${vStock}`}
                        accessibilityState={{ selected: isSelected }}
                        activeOpacity={0.7}
                      >
                        {v.colorHex && (
                          <View
                            style={[
                              styles.variantColorDot,
                              { backgroundColor: v.colorHex },
                            ]}
                          />
                        )}
                        <View>
                          <Text
                            style={[
                              styles.variantName,
                              isSelected && styles.variantNameSelected,
                            ]}
                          >
                            {v.name}
                          </Text>
                          <Text style={[styles.variantStock, vStock <= 0 && styles.variantStockEmpty]}>
                            {v.sizeLabel ? `Talla: ${v.sizeLabel} • ` : ''}
                            {vStock <= 0 ? 'Sin stock' : `Stock: ${vStock}`}
                          </Text>
                        </View>
                        {isSelected && (
                          <Check size={14} color={ui.primary} style={{ marginLeft: 6 }} />
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}
          </ScrollView>

          {isStockInsufficient && (
            <View style={styles.stockWarningBanner}>
              <AlertTriangle size={15} color={ui.danger} />
              <Text style={styles.stockWarningText}>
                {effectiveAvailable <= 0
                  ? 'Sin stock disponible para la selección actual en esta sucursal.'
                  : `Stock insuficiente: requiere ${requiredUnits} u. y hay ${effectiveAvailable} u. disponibles (máx. ${maxUnits}).`}
              </Text>
            </View>
          )}

          {/* Selector de Cantidad */}
          <View style={styles.quantityRow}>
            <View>
              <Text style={styles.quantityLabel}>Cantidad:</Text>
              {factor > 1 && (
                <Text style={styles.quantitySubLabel}>
                  Descuenta {requiredUnits} u. ({maxUnits} máx.)
                </Text>
              )}
            </View>
            <View style={styles.quantityControls}>
              <TouchableOpacity
                onPress={decrementQty}
                style={[styles.qtyButton, quantity <= 1 && styles.qtyButtonDisabled]}
                disabled={quantity <= 1}
                accessibilityRole="button"
                accessibilityLabel="Reducir cantidad"
                accessibilityState={{ disabled: quantity <= 1 }}
              >
                <Minus size={16} color={quantity <= 1 ? ui.textMuted : ui.text} />
              </TouchableOpacity>
              <Text style={styles.quantityValue}>{quantity}</Text>
              <TouchableOpacity
                onPress={incrementQty}
                style={[styles.qtyButton, (maxUnits <= 0 || quantity >= maxUnits) && styles.qtyButtonDisabled]}
                disabled={maxUnits <= 0 || quantity >= maxUnits}
                accessibilityRole="button"
                accessibilityLabel="Aumentar cantidad"
                accessibilityState={{ disabled: maxUnits <= 0 || quantity >= maxUnits }}
              >
                <Plus size={16} color={maxUnits <= 0 || quantity >= maxUnits ? ui.textMuted : ui.text} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Botón de Confirmación */}
          <TouchableOpacity
            onPress={handleConfirm}
            disabled={isStockInsufficient}
            style={[styles.confirmButton, isStockInsufficient && styles.confirmButtonDisabled]}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={
              isStockInsufficient
                ? 'Stock insuficiente'
                : `Agregar ${quantity} al carrito por ${formatPEN(lineTotal)}`
            }
            accessibilityState={{ disabled: isStockInsufficient }}
          >
            <Check size={18} color={ui.onPrimary} style={{ marginRight: 6 }} />
            <Text style={styles.confirmButtonText}>
              {isStockInsufficient
                ? 'Stock insuficiente'
                : `Agregar ${formatPEN(lineTotal)} al Carrito`}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
});

export const PresentationVariantModal: React.FC<PresentationVariantModalProps> = React.memo((props) => {
  const isModalVisible = props.visible !== undefined ? props.visible : Boolean(props.isOpen);
  if (!isModalVisible || !props.product) return null;
  return (
    <PresentationVariantModalContent
      {...props}
      product={props.product}
      isModalVisible={isModalVisible}
    />
  );
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 20,
    maxHeight: '90%',
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    marginRight: 10,
  },
  productThumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
  },
  productThumbPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextContainer: {
    flex: 1,
  },
  productName: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  productMeta: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyScroll: {
    marginTop: 12,
    maxHeight: 380,
  },
  section: {
    marginBottom: 18,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: ui.surface,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  optionCardSelected: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  optionCardLeft: {
    flex: 1,
    marginRight: 10,
  },
  optionNameBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  optionTitleSelected: {
    color: ui.primary,
    fontWeight: '700',
  },
  savingsBadge: {
    backgroundColor: ui.successSoft,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  savingsText: {
    color: ui.success,
    fontSize: 10,
    fontWeight: '700',
  },
  optionFactor: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  barcodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  },
  barcodeText: {
    fontSize: 10,
    color: ui.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  optionPrice: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  variantsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  variantChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    minHeight: 52,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  variantChipSelected: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  variantColorDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginRight: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  variantName: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
  },
  variantNameSelected: {
    color: ui.primary,
  },
  variantStock: {
    fontSize: 10,
    color: ui.textSecondary,
    marginTop: 1,
  },
  variantChipOutOfStock: {
    opacity: 0.65,
    borderStyle: 'dashed',
  },
  variantStockEmpty: {
    color: ui.danger,
    fontWeight: '600',
  },
  stockWarningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.dangerSoft,
    borderWidth: 1,
    borderColor: ui.danger,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  stockWarningText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: ui.danger,
  },
  quantityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    marginTop: 6,
    marginBottom: 12,
  },
  quantityLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  quantitySubLabel: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  quantityControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  qtyButton: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyButtonDisabled: {
    backgroundColor: ui.surfaceMuted,
    borderColor: ui.border,
  },
  quantityValue: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
    minWidth: 24,
    textAlign: 'center',
  },
  confirmButton: {
    flexDirection: 'row',
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButtonDisabled: {
    backgroundColor: ui.textMuted,
    opacity: 0.65,
  },
  confirmButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.onPrimary,
  },
});
