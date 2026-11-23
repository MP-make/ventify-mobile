import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { X, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings, useOfflineStatus } from '@/context/SettingsContext';
import { useProductsActions } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { checkIsOnlineLive } from '@/lib/online-guard';
import { enqueueOfflineStockAdjust } from '@/services/offline-inventory-service';
import {
  adjustProductStock,
  getVariantBranchStock,
} from '@/services/inventory-kardex-service';
import { ui } from '@/lib/theme';
import type { Product } from '@/types';
import { catalogModalStyles as styles } from './catalogModalStyles';

const KARDEX_REASONS = [
  'Ingreso de mercadería',
  'Ajuste de inventario',
  'Merma / Deterioro',
  'Consumo interno',
] as const;

const ADJUST_MODES = [
  { id: 'add', label: 'Sumar (+)' },
  { id: 'subtract', label: 'Restar (-)' },
  { id: 'set', label: 'Fijar (=)' },
] as const;

export interface QuickStockAdjustModalProps {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  onStockAdjusted?: () => void;
}

/** Isolates quick stock adjustment form state so typing never re-renders the catalog list. */
export const QuickStockAdjustModal: React.FC<QuickStockAdjustModalProps> = React.memo(
  ({ visible, product, onClose, onStockAdjusted }) => {
    const { accountId, branchId, user, userProfile } = useAuthSession();
    const { activeBranchName } = useBusinessSettings();
    const { isOnline: settingsIsOnline } = useOfflineStatus();
    const { getProductStock, applyAuthoritativeStockUpdates } = useProductsActions();
    const { canManageInventoryAdjustments } = usePermissions();

    const [adjustVariantId, setAdjustVariantId] = useState<string | null>(null);
    const [adjustMode, setAdjustMode] = useState<'add' | 'subtract' | 'set'>('add');
    const [adjustAmountStr, setAdjustAmountStr] = useState('');
    const [adjustReason, setAdjustReason] = useState<string>(KARDEX_REASONS[0]);
    const [adjustNotes, setAdjustNotes] = useState('');
    const [isAdjustingStock, setIsAdjustingStock] = useState(false);

    useEffect(() => {
      if (!visible || !product) return;
      const hasVars = Array.isArray(product.variants) && product.variants.length > 0;
      setAdjustVariantId(hasVars ? product.variants![0].id : null);
      setAdjustMode('add');
      setAdjustAmountStr('');
      setAdjustReason(KARDEX_REASONS[0]);
      setAdjustNotes('');
    }, [visible, product]);

    const headerSubtitle = useMemo(() => {
      if (!product) return '';
      const hasVars = Array.isArray(product.variants) && product.variants.length > 0;
      const activeVar = hasVars
        ? product.variants!.find((v) => v.id === adjustVariantId) || null
        : null;
      const currentQty = activeVar
        ? getVariantBranchStock(activeVar, branchId)
        : getProductStock(product);
      return `${product.name}${activeVar ? ` (${activeVar.name})` : ''} · Actual: ${currentQty} uds`;
    }, [product, adjustVariantId, branchId, getProductStock]);

    const handleConfirmStockAdjustment = useCallback(async () => {
      if (!canManageInventoryAdjustments) {
        Alert.alert(
          'Acceso Denegado',
          'No cuentas con permisos para realizar ajustes manuales de stock.'
        );
        return;
      }
      if (!product || !accountId || !branchId) return;

      const amount = parseFloat(adjustAmountStr);
      if (isNaN(amount) || amount <= 0) {
        Alert.alert('Cantidad Inválida', 'Por favor ingresa una cantidad mayor a cero.');
        return;
      }

      const selectedVariant =
        Array.isArray(product.variants) && product.variants.length > 0
          ? product.variants.find((v) => v.id === adjustVariantId) || null
          : null;

      const currentStock = selectedVariant
        ? getVariantBranchStock(selectedVariant, branchId)
        : getProductStock(product);
      let targetStock = currentStock;

      if (adjustMode === 'add') {
        targetStock = currentStock + amount;
      } else if (adjustMode === 'subtract') {
        targetStock = Math.max(0, currentStock - amount);
      } else {
        targetStock = amount;
      }

      try {
        setIsAdjustingStock(true);
        const targetLabel = selectedVariant
          ? `${product.name} (${selectedVariant.name})`
          : product.name;
        const operatorProfile = {
          uid: user?.uid || 'user_pos',
          displayName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero',
          email: user?.email || '',
          role: userProfile?.role,
        };

        const online = await checkIsOnlineLive(settingsIsOnline);
        if (!online) {
          await enqueueOfflineStockAdjust({
            accountId,
            userId: operatorProfile.uid,
            branchId,
            branchName: activeBranchName || 'Sucursal Principal',
            productId: product.id,
            productName: product.name,
            productSku: product.sku,
            variantId: selectedVariant?.id,
            variantName: selectedVariant?.name,
            mode: adjustMode,
            amount,
            expectedBeforeStock: currentStock,
            reason: adjustReason,
            notes: adjustNotes.trim() || undefined,
            userProfile: operatorProfile,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert(
            'Ajuste Guardado Offline',
            `${targetLabel}: ${currentStock} ➔ ${targetStock} unidades (se sincronizará al volver la conexión).`
          );
          onStockAdjusted?.();
          onClose();
          return;
        }

        const res = await adjustProductStock({
          product,
          branchId,
          branchName: activeBranchName || 'Sucursal Principal',
          newStock: targetStock,
          mode: adjustMode,
          deltaAmount: adjustMode === 'set' ? undefined : amount,
          reason: adjustReason,
          notes: adjustNotes.trim(),
          variantId: selectedVariant?.id,
          variantName: selectedVariant?.name,
          userProfile: operatorProfile,
        });

        if (res?.updatedProductStock) {
          applyAuthoritativeStockUpdates([res.updatedProductStock]);
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Stock Actualizado',
          `${targetLabel}: ${currentStock} ➔ ${targetStock} unidades.`
        );
        onStockAdjusted?.();
        onClose();
      } catch (err: any) {
        Alert.alert(
          'Error al Ajustar',
          err?.message || 'No se pudo registrar el ajuste de stock.'
        );
      } finally {
        setIsAdjustingStock(false);
      }
    }, [
      accountId,
      activeBranchName,
      adjustAmountStr,
      adjustMode,
      adjustNotes,
      adjustReason,
      adjustVariantId,
      applyAuthoritativeStockUpdates,
      branchId,
      canManageInventoryAdjustments,
      getProductStock,
      onClose,
      onStockAdjusted,
      product,
      settingsIsOnline,
      user?.displayName,
      user?.email,
      user?.uid,
      userProfile?.displayName,
      userProfile?.role,
    ]);

    return (
      <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
        <KeyboardAvoidingView
          style={styles.subModalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.subModalCard, { maxHeight: '90%' }]}>
            <View style={styles.subModalHeader}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={styles.subModalTitle}>Ajuste Rápido de Stock</Text>
                <Text style={styles.subModalSubtitle} numberOfLines={1}>
                  {headerSubtitle}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Cerrar ajuste de stock"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {product && Array.isArray(product.variants) && product.variants.length > 0 && (
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.inputLabel}>Variante a Ajustar</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.variantChipsRow}
                  >
                    {product.variants.map((v) => {
                      const isSelected = adjustVariantId === v.id;
                      const vStock = getVariantBranchStock(v, branchId);
                      return (
                        <TouchableOpacity
                          key={v.id}
                          style={[
                            styles.variantPickChip,
                            isSelected && styles.variantPickChipActive,
                          ]}
                          onPress={() => {
                            setAdjustVariantId(v.id);
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isSelected }}
                          accessibilityLabel={`Variante ${v.name}, stock actual ${vStock} unidades`}
                        >
                          {v.colorHex ? (
                            <View
                              style={[
                                styles.variantColorDot,
                                { backgroundColor: v.colorHex },
                                isSelected && { borderColor: ui.surface },
                              ]}
                            />
                          ) : null}
                          <Text
                            style={[
                              styles.variantPickChipText,
                              isSelected && styles.variantPickChipTextActive,
                            ]}
                          >
                            {v.name}
                            {v.sizeLabel ? ` (${v.sizeLabel})` : ''} · {vStock} u.
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              <View style={styles.adjustModeRow}>
                {ADJUST_MODES.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.adjustModeBtn, adjustMode === m.id && styles.adjustModeBtnActive]}
                    onPress={() => setAdjustMode(m.id)}
                  >
                    <Text
                      style={[
                        styles.adjustModeBtnText,
                        adjustMode === m.id && styles.adjustModeBtnTextActive,
                      ]}
                    >
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.inputLabel}>Cantidad de Unidades</Text>
              <TextInput
                style={[styles.formInput, styles.quickAmountHighlight]}
                value={adjustAmountStr}
                onChangeText={setAdjustAmountStr}
                placeholder="0"
                placeholderTextColor={ui.textMuted}
                keyboardType={product?.allowDecimals ? 'decimal-pad' : 'numeric'}
                autoFocus
              />

              <Text style={styles.inputLabel}>Motivo Obligatorio Kardex</Text>
              <View style={styles.reasonsGrid}>
                {KARDEX_REASONS.map((r) => (
                  <TouchableOpacity
                    key={r}
                    style={[styles.reasonChip, adjustReason === r && styles.reasonChipActive]}
                    onPress={() => setAdjustReason(r)}
                  >
                    <Text
                      style={[
                        styles.reasonChipText,
                        adjustReason === r && styles.reasonChipTextActive,
                      ]}
                    >
                      {r}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.inputLabel}>Observación (Opcional)</Text>
              <TextInput
                style={styles.formInput}
                value={adjustNotes}
                onChangeText={setAdjustNotes}
                placeholder="Ej. Factura de proveedor F001-209"
                placeholderTextColor={ui.textMuted}
              />
            </ScrollView>

            <View style={styles.subModalActions}>
              <TouchableOpacity
                style={styles.subModalCancelBtn}
                onPress={onClose}
                disabled={isAdjustingStock}
              >
                <Text style={styles.subModalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.subModalConfirmBtn, isAdjustingStock && { opacity: 0.6 }]}
                onPress={handleConfirmStockAdjustment}
                disabled={isAdjustingStock}
              >
                {isAdjustingStock ? (
                  <ActivityIndicator size="small" color={ui.surface} />
                ) : (
                  <>
                    <Check size={16} color={ui.surface} />
                    <Text style={styles.subModalConfirmText}>Aplicar Ajuste</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }
);
