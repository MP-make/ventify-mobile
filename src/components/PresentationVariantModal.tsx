import React, { useState, useEffect } from 'react';
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
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Product, ProductPresentation, ProductVariant } from '@/types';
import { formatPEN, ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import { getAllPresentations, getBranchStock } from '@/lib/product-search';
import { useAuth } from '@/context/AuthContext';

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

export const PresentationVariantModal: React.FC<PresentationVariantModalProps> = React.memo(({
  product,
  visible,
  isOpen,
  onClose,
  onConfirm,
}) => {
  const insets = useSafeAreaInsets();
  const { branchId } = useAuth();
  const isModalVisible = visible !== undefined ? visible : Boolean(isOpen);

  const [selectedPresentation, setSelectedPresentation] = useState<ProductPresentation | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [quantity, setQuantity] = useState<number>(1);

  // Inicializar selecciones cuando se abre el modal
  useEffect(() => {
    if (isModalVisible && product) {
      setQuantity(1);

      // Si tiene presentaciones, seleccionar la primera por defecto o dejar null para unidad
      const presentations = getAllPresentations(product);
      if (presentations.length > 0) {
        setSelectedPresentation(presentations[0]);
      } else {
        setSelectedPresentation(null);
      }

      // Si tiene variantes, seleccionar la primera
      if (Array.isArray(product.variants) && product.variants.length > 0) {
        setSelectedVariant(product.variants[0]);
      } else {
        setSelectedVariant(null);
      }
    }
  }, [isModalVisible, product]);

  if (!isModalVisible || !product) return null;

  const basePrice = Number(product.suggestedPrice ?? product.price ?? 0);
  const physicalStock = getBranchStock(product, branchId || 'main');
  const presentations = getAllPresentations(product);
  const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

  // Calcular precio unitario e importe total de la selección actual
  const { unitPrice, lineTotal } = (() => {
    let price = basePrice;

    if (selectedPresentation) {
      price = Number(selectedPresentation.price ?? basePrice);
    } else if (selectedVariant) {
      if (selectedVariant.price && selectedVariant.price > 0) {
        price = Number(selectedVariant.price);
      } else if (selectedVariant.priceAdjustment) {
        price += Number(selectedVariant.priceAdjustment);
      }
    }

    const total = Math.round(price * quantity * 100) / 100;
    return { unitPrice: price, lineTotal: total };
  })();

  const handleConfirm = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onConfirm(product, {
      presentation: selectedPresentation || undefined,
      variant: selectedVariant || undefined,
      quantity,
    });
    onClose();
  };

  const incrementQty = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setQuantity((q) => q + 1);
  };

  const decrementQty = () => {
    if (quantity > 1) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setQuantity((q) => q - 1);
    }
  };

  if (!isModalVisible || !product) return null;

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
                  Stock: {physicalStock} • Base: {formatPEN(basePrice)}
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
                  }}
                  style={[
                    styles.optionCard,
                    selectedPresentation === null && styles.optionCardSelected,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Unidad base, ${formatPEN(basePrice)}`}
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
                  <Text style={styles.optionPrice}>{formatPEN(basePrice)}</Text>
                </TouchableOpacity>

                {/* Opciones de Presentaciones (Packs, Cajas) */}
                {presentations.map((pres) => {
                  const isSelected = selectedPresentation?.id === pres.id;
                  const factor = pres.conversionFactor || pres.quantity || 1;
                  const presPrice = Number(pres.price ?? 0);

                  // Ahorro estimado por unidad comparado con precio base
                  const singleEquivalent = factor > 0 ? presPrice / factor : presPrice;
                  const savings = basePrice > singleEquivalent
                    ? Math.round(((basePrice - singleEquivalent) / basePrice) * 100)
                    : 0;

                  return (
                    <TouchableOpacity
                      key={pres.id}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                        setSelectedPresentation(pres);
                      }}
                      style={[
                        styles.optionCard,
                        isSelected && styles.optionCardSelected,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`${pres.name}, ${formatPEN(presPrice)}, ${factor} unidades`}
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
                          Consume {factor} unidades • {formatPEN(singleEquivalent)} c/u
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
                  {product.variants!.map((v) => {
                    const isSelected = selectedVariant?.id === v.id;
                    const vStock = v.stock?.[branchId || 'main'] ?? 0;

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
                          <Text style={styles.variantStock}>
                            {v.sizeLabel ? `Talla: ${v.sizeLabel} • ` : ''}
                            Stock: {vStock}
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

          {/* Selector de Cantidad */}
          <View style={styles.quantityRow}>
            <Text style={styles.quantityLabel}>Cantidad:</Text>
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
              <TouchableOpacity onPress={incrementQty} style={styles.qtyButton} accessibilityRole="button" accessibilityLabel="Aumentar cantidad">
                <Plus size={16} color={ui.onPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Botón de Confirmación */}
          <TouchableOpacity
            onPress={handleConfirm}
            style={styles.confirmButton}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Agregar ${quantity} al carrito por ${formatPEN(lineTotal)}`}
          >
            <Check size={18} color={ui.onPrimary} style={{ marginRight: 6 }} />
            <Text style={styles.confirmButtonText}>
              Agregar {formatPEN(lineTotal)} al Carrito
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
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
  confirmButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.onPrimary,
  },
});
