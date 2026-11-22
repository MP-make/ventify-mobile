import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { Check, Gift, Save, Search, X } from 'lucide-react-native';

import { SectionHeading } from '@/components/ui';
import { useProducts } from '@/context/ProductsContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { filterCatalogIndex } from '@/lib/catalog-filters';
import { db } from '@/lib/firebase';
import { formatPEN, ui } from '@/lib/theme';
import type { DiscountSettings, Product } from '@/types';

import { settingsStyles as styles } from './settingsStyles';

const isActiveGiftProduct = (product: Product): boolean => product.active !== false;

export interface GiftsSettingsTabProps {
  accountId?: string | null;
  canManageSettings: boolean;
  discountSettings: DiscountSettings;
}

export const GiftsSettingsTab = React.memo<GiftsSettingsTabProps>(
  ({ accountId, canManageSettings, discountSettings }) => {
    const { catalogIndex, productsById } = useProducts();
    const [enableGifts, setEnableGifts] = useState(discountSettings.enableGifts !== false);
    const [giftProductIds, setGiftProductIds] = useState<string[]>(
      Array.isArray(discountSettings.giftProductIds) ? discountSettings.giftProductIds : []
    );
    const [promotionsList, setPromotionsList] = useState<any[]>(
      Array.isArray(discountSettings.promotions) ? discountSettings.promotions : []
    );
    const [giftSearch, setGiftSearch] = useState('');
    const debouncedGiftSearch = useDebouncedValue(giftSearch, 150);
    const [isSavingDiscounts, setIsSavingDiscounts] = useState(false);

    useEffect(() => {
      setEnableGifts(discountSettings.enableGifts !== false);
      setGiftProductIds(
        Array.isArray(discountSettings.giftProductIds) ? discountSettings.giftProductIds : []
      );
      setPromotionsList(
        Array.isArray(discountSettings.promotions) ? discountSettings.promotions : []
      );
    }, [discountSettings]);

    const giftProductIdSet = useMemo(() => new Set(giftProductIds), [giftProductIds]);

    const filteredGiftCatalog = useMemo(
      () =>
        filterCatalogIndex(catalogIndex, {
          query: debouncedGiftSearch,
          include: isActiveGiftProduct,
          limit: 30,
        }),
      [catalogIndex, debouncedGiftSearch]
    );

    const toggleGiftProductId = useCallback(
      (productId: string) => {
        if (!canManageSettings) return;
        setGiftProductIds((prev) =>
          prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
        );
      },
      [canManageSettings]
    );

    const handleSaveDiscounts = async () => {
      if (!canManageSettings || !accountId) {
        Alert.alert(
          'Acceso Denegado',
          'Solo administradores pueden editar regalos y promociones.'
        );
        return;
      }
      setIsSavingDiscounts(true);
      try {
        await setDoc(
          doc(db, 'settings', `${accountId}_discounts`),
          {
            accountId,
            enableGifts,
            giftProductIds,
            promotions: promotionsList,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        Alert.alert(
          'Regalos Actualizados',
          'La lista de productos elegibles como regalo se actualizó en el Punto de Venta.'
        );
      } catch (err: any) {
        Alert.alert(
          'Error al Guardar',
          err?.message || 'No se pudo guardar la configuración de regalos.'
        );
      } finally {
        setIsSavingDiscounts(false);
      }
    };

    return (
      <>
        <SectionHeading
          title="Promociones y Regalos"
          subtitle="Productos elegibles como cortesía en el Punto de Venta"
        />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
              <Gift size={22} color={ui.accent} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Regalos en Checkout</Text>
              <Text style={styles.cardSubtitle}>
                Sincronizado con settings/{accountId}_discounts
              </Text>
            </View>
          </View>

          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Habilitar Regalos en Punto de Venta</Text>
              <Text style={styles.switchSubtitle}>
                Muestra la opción de cortesías y regalos al cobrar en caja
              </Text>
            </View>
            <Switch
              value={enableGifts}
              onValueChange={setEnableGifts}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>
              Productos Elegibles Seleccionados ({giftProductIds.length})
            </Text>
            {giftProductIds.length === 0 ? (
              <Text style={styles.settingSubtext}>
                Sin restricción o sin productos seleccionados aún.
              </Text>
            ) : (
              <View style={styles.giftChipWrap}>
                {giftProductIds.map((pid) => {
                  const prod = productsById.get(pid);
                  return (
                    <View key={pid} style={styles.giftChip}>
                      <Text style={styles.giftChipText} numberOfLines={1}>
                        {prod?.name || pid}
                      </Text>
                      {canManageSettings ? (
                        <TouchableOpacity
                          onPress={() => toggleGiftProductId(pid)}
                          accessibilityLabel={`Quitar ${prod?.name || pid}`}
                        >
                          <X size={14} color={ui.textSecondary} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Buscar Productos del Catálogo</Text>
            <View style={styles.searchRow}>
              <Search size={18} color={ui.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder="Nombre, SKU o código de barras..."
                placeholderTextColor={ui.textMuted}
                value={giftSearch}
                onChangeText={setGiftSearch}
              />
              {giftSearch ? (
                <TouchableOpacity onPress={() => setGiftSearch('')}>
                  <X size={16} color={ui.textMuted} />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <View style={styles.giftCatalogList}>
            {filteredGiftCatalog.length === 0 ? (
              <Text style={styles.emptySub}>No se encontraron productos con ese criterio.</Text>
            ) : (
              filteredGiftCatalog.map((prod) => {
                const selected = giftProductIdSet.has(prod.id);
                const price = Number(prod.suggestedPrice ?? prod.price ?? 0);
                return (
                  <TouchableOpacity
                    key={prod.id}
                    style={[styles.giftCatalogRow, selected && styles.giftCatalogRowSelected]}
                    onPress={() => toggleGiftProductId(prod.id)}
                    disabled={!canManageSettings}
                  >
                    <View style={styles.flex1}>
                      <Text style={styles.giftProdName} numberOfLines={1}>
                        {prod.name}
                      </Text>
                      <Text style={styles.giftProdMeta}>
                        {prod.sku ? `SKU: ${prod.sku} · ` : ''}
                        {formatPEN(price)}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.giftTogglePill,
                        selected && { backgroundColor: ui.primary },
                      ]}
                    >
                      {selected ? (
                        <Check size={14} color={ui.onPrimary} />
                      ) : (
                        <Text style={styles.giftToggleText}>Agregar</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.saveButton, isSavingDiscounts && styles.buttonDisabled]}
              onPress={handleSaveDiscounts}
              disabled={isSavingDiscounts}
            >
              {isSavingDiscounts ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Save size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>Guardar Regalos y Promociones</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </>
    );
  }
);
