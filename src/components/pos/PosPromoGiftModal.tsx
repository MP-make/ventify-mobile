import React, { useMemo, useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Gift, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { useProducts } from '@/context/ProductsContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { filterCatalogIndex } from '@/lib/catalog-filters';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { evaluateCartPromotions, resolveProductBranchStock } from '@/lib/product-search';
import { formatPEN, ui } from '@/lib/theme';
import type { Product } from '@/types';
import { posStyles as styles } from './posStyles';

interface PosPromoGiftModalProps {
  visible: boolean;
  onClose: () => void;
}

export const PosPromoGiftModal: React.FC<PosPromoGiftModalProps> = React.memo(
  ({ visible, onClose }) => {
    const { branchId } = useAuthSession();
    const { discountSettings } = useBusinessSettings();
    const { products, productsById, catalogIndex } = useProducts();
    const { items, subtotal: cartSubtotal, addGiftItem, setDiscount } = useCart();

    const [giftSearchQuery, setGiftSearchQuery] = useState('');
    const debouncedGiftSearchQuery = useDebouncedValue(giftSearchQuery, 150);

    const promoSuggestions = useMemo(() => {
      if (!visible || items.length === 0) return [];
      return evaluateCartPromotions(items, discountSettings?.promotions, products, productsById);
    }, [visible, items, discountSettings?.promotions, products, productsById]);

    const allowedGiftIdsSet = useMemo(() => {
      const configuredIds = discountSettings?.giftProductIds;
      if (!Array.isArray(configuredIds)) return null;
      return new Set(configuredIds);
    }, [discountSettings?.giftProductIds]);

    const effectiveBranchId = branchId || 'main';
    const includeGiftProduct = useCallback(
      (p: Product) => {
        if (p.active === false) return false;
        if (allowedGiftIdsSet && !allowedGiftIdsSet.has(p.id)) return false;
        return resolveProductBranchStock(p, effectiveBranchId) > 0;
      },
      [allowedGiftIdsSet, effectiveBranchId]
    );

    const filteredGiftProducts = useMemo(() => {
      if (!visible || discountSettings?.enableGifts === false) return [];
      if (allowedGiftIdsSet && allowedGiftIdsSet.size === 0) return [];
      return filterCatalogIndex(catalogIndex, {
        query: debouncedGiftSearchQuery,
        include: includeGiftProduct,
        limit: 40,
      });
    }, [
      visible,
      discountSettings?.enableGifts,
      allowedGiftIdsSet,
      catalogIndex,
      debouncedGiftSearchQuery,
      includeGiftProduct,
    ]);

    return (
      <Modal
        visible={visible}
        animationType="slide"
        transparent
        onRequestClose={onClose}
      >
        <View style={styles.subModalOverlay}>
          <View style={[styles.subModalCard, { maxHeight: '84%' }]}>
            <View style={styles.subModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Gift size={18} color={ui.primary} />
                <Text style={styles.subModalTitle}>Promociones y Regalos</Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Cerrar promociones y regalos"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 460 }}>
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
                      const stockQty = resolveProductBranchStock(p, effectiveBranchId);
                      return (
                        <View key={p.id} style={styles.giftProductRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.giftProductName} numberOfLines={1}>
                              {p.name}
                            </Text>
                            <Text style={styles.giftProductMeta}>
                              Stock: {stockQty} · Valor ref:{' '}
                              {formatPEN(p.suggestedPrice ?? p.price ?? 0)}
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
    );
  }
);
