import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check } from 'lucide-react-native';
import { useProductsActions } from '@/context/ProductsContext';
import { formatPEN, ui } from '@/lib/theme';
import {
  ReceivedProductCostChange,
  BatchProductSuggestedPriceUpdate,
  roundToCents,
  suggestedSalePriceAfterCostChange,
  suggestedPresentationPrices,
  applyBatchProductSuggestedPrices,
} from '@/services/suppliers-po-service';
import type { Product } from '@/types';
import { suppliersStyles as styles } from './suppliersStyles';

interface PriceSuggestionEntry {
  change: ReceivedProductCostChange;
  unitPriceInput: string;
  selected: boolean;
}

function buildInitialEntries(costChanges: ReceivedProductCostChange[]): PriceSuggestionEntry[] {
  return costChanges.map((change) => {
    const suggestion = suggestedSalePriceAfterCostChange({
      previousCost: change.previousCost,
      newCost: change.newCost,
      currentSalePrice: change.suggestedPrice || 0,
      minSalePrice: change.minSalePrice,
    });
    return {
      change,
      unitPriceInput: suggestion.unit.toFixed(2),
      selected: true,
    };
  });
}

export interface PriceSuggestionModalProps {
  visible: boolean;
  costChanges: ReceivedProductCostChange[];
  onClose: () => void;
  onApplied: () => void;
}

export const PriceSuggestionModal: React.FC<PriceSuggestionModalProps> = React.memo(({
  visible,
  costChanges,
  onClose,
  onApplied,
}) => {
  const { getProductById, upsertProductsBatch } = useProductsActions();
  const insets = useSafeAreaInsets();

  const [priceSuggestionItems, setPriceSuggestionItems] = useState<PriceSuggestionEntry[]>(() =>
    buildInitialEntries(costChanges)
  );
  const [isApplyingPriceSuggestions, setIsApplyingPriceSuggestions] = useState<boolean>(false);

  useEffect(() => {
    setPriceSuggestionItems(buildInitialEntries(costChanges));
  }, [costChanges]);

  const handleToggleItem = useCallback((idx: number) => {
    setPriceSuggestionItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, selected: !item.selected } : item))
    );
  }, []);

  const handleChangePriceInput = useCallback((idx: number, txt: string) => {
    setPriceSuggestionItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, unitPriceInput: txt, selected: true } : item))
    );
  }, []);

  const handleApplySuggestedPrices = useCallback(async () => {
    const selectedEntries = priceSuggestionItems.filter((entry) => entry.selected);
    if (selectedEntries.length === 0) {
      onClose();
      return;
    }

    setIsApplyingPriceSuggestions(true);
    try {
      const batchUpdates: BatchProductSuggestedPriceUpdate[] = [];
      const localUpdatedProducts: Product[] = [];

      for (const entry of selectedEntries) {
        const parsedUnit = roundToCents(parseFloat(entry.unitPriceInput) || 0);
        if (parsedUnit <= 0) continue;
        const { change } = entry;
        const costRose = change.newCost > change.previousCost;
        const updatedPresentations =
          Array.isArray(change.presentations) && change.presentations.length > 0
            ? suggestedPresentationPrices(change.presentations, parsedUnit, {
                previousUnitPrice: change.suggestedPrice,
                costRose,
              })
            : undefined;

        batchUpdates.push({
          productId: change.productId,
          suggestedPrice: parsedUnit,
          presentations: updatedPresentations,
        });

        const cachedProduct = getProductById(change.productId);
        if (cachedProduct) {
          const floor = Number(cachedProduct.minSalePrice ?? 0);
          const safeSuggested = roundToCents(Math.max(floor, parsedUnit));
          const safePresentations = Array.isArray(updatedPresentations)
            ? updatedPresentations.map((p) => {
                const factor = Number(p.conversionFactor ?? p.quantity) || 1;
                const presMin = p.minSalePrice != null ? Number(p.minSalePrice) : 0;
                const safePresPrice = roundToCents(Math.max(presMin, Number(p.price) || 0));
                return {
                  ...p,
                  quantity: factor,
                  conversionFactor: factor,
                  price: safePresPrice,
                };
              })
            : cachedProduct.presentations;

          localUpdatedProducts.push({
            ...cachedProduct,
            price: safeSuggested,
            suggestedPrice: safeSuggested,
            presentations: safePresentations,
          });
        }
      }

      if (batchUpdates.length > 0) {
        await applyBatchProductSuggestedPrices(batchUpdates);
        if (localUpdatedProducts.length > 0) {
          upsertProductsBatch(localUpdatedProducts);
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onApplied();
      Alert.alert('Precios actualizados', 'Se actualizaron los precios de venta sugeridos.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudieron actualizar algunos precios.');
    } finally {
      setIsApplyingPriceSuggestions(false);
    }
  }, [priceSuggestionItems, getProductById, upsertProductsBatch, onClose, onApplied]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={() => {
        if (!isApplyingPriceSuggestions) onClose();
      }}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.modalSheetContainer, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <View style={styles.subModalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.subModalTitle}>Actualizar Precios de Venta</Text>
              <Text style={styles.subModalSubtitle}>
                El costo CPP cambió al recibir. Revisa los precios unitarios sugeridos:
              </Text>
            </View>
            <TouchableOpacity
              style={styles.closeSubModalBtn}
              onPress={() => {
                if (!isApplyingPriceSuggestions) onClose();
              }}
            >
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.subModalBody} keyboardShouldPersistTaps="handled">
            {priceSuggestionItems.map((entry, idx) => {
              const { change } = entry;
              const parsedUnit = roundToCents(parseFloat(entry.unitPriceInput) || 0);
              const costRose = change.newCost > change.previousCost;
              const previewPres = Array.isArray(change.presentations)
                ? suggestedPresentationPrices(change.presentations, parsedUnit, {
                    previousUnitPrice: change.suggestedPrice,
                    costRose,
                  })
                : [];

              return (
                <View key={change.productId} style={styles.receiveItemCard}>
                  <View style={{ flex: 1 }}>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}
                      onPress={() => handleToggleItem(idx)}
                    >
                      <View
                        style={[
                          styles.suggestionCheck,
                          entry.selected && styles.suggestionCheckActive,
                        ]}
                      >
                        {entry.selected && <Check size={12} color={ui.surface} />}
                      </View>
                      <Text style={styles.orderItemName}>{change.productName}</Text>
                    </TouchableOpacity>

                    <Text style={styles.orderItemDetails}>
                      Costo CPP: {formatPEN(change.previousCost)} → {formatPEN(change.newCost)}
                    </Text>
                    <Text style={styles.orderItemDetails}>
                      Venta actual: {formatPEN(change.suggestedPrice || 0)}
                      {change.minSalePrice ? ` • Piso: ${formatPEN(change.minSalePrice)}` : ''}
                    </Text>

                    {previewPres.length > 0 && (
                      <Text style={styles.packagingHintText}>
                        Presentaciones:{' '}
                        {previewPres
                          .map((p) => `${p.name}: ${formatPEN(p.price)}`)
                          .join(' • ')}
                      </Text>
                    )}
                  </View>

                  <View style={{ width: 96 }}>
                    <Text style={styles.inputMiniLabel}>Nuevo S/</Text>
                    <TextInput
                      style={styles.inputMini}
                      keyboardType="numeric"
                      value={entry.unitPriceInput}
                      onChangeText={(txt) => handleChangePriceInput(idx, txt)}
                    />
                  </View>
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.subModalFooter}>
            <TouchableOpacity
              style={styles.subModalCancelBtn}
              onPress={onClose}
              disabled={isApplyingPriceSuggestions}
            >
              <Text style={styles.subModalCancelBtnText}>Mantener Actuales</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.saveSupplierSubmitBtn,
                isApplyingPriceSuggestions && styles.btnDisabled,
              ]}
              onPress={handleApplySuggestedPrices}
              disabled={isApplyingPriceSuggestions}
            >
              {isApplyingPriceSuggestions ? (
                <ActivityIndicator size="small" color={ui.surface} />
              ) : (
                <>
                  <Check size={18} color={ui.surface} />
                  <Text style={styles.saveSupplierSubmitBtnText}>Aplicar Precios</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});
