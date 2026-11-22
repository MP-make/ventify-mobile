import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Alert,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { X, Check } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import type { ProductVariant } from '@/types';
import { VARIANT_COLORS } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

export interface VariantFormSubModalProps {
  visible: boolean;
  editingVariant: ProductVariant | null;
  branchId: string;
  allowDecimals: boolean;
  compactLayout: boolean;
  onClose: () => void;
  onSubmit: (variant: ProductVariant, isEditing: boolean) => void;
}

export const VariantFormSubModal: React.FC<VariantFormSubModalProps> = React.memo(({
  visible,
  editingVariant,
  branchId,
  allowDecimals,
  compactLayout,
  onClose,
  onSubmit,
}) => {
  const [varName, setVarName] = useState(() => editingVariant?.name || '');
  const [varSize, setVarSize] = useState(() => editingVariant?.sizeLabel || '');
  const [varColorHex, setVarColorHex] = useState(() => editingVariant?.colorHex || '#111827');
  const [varSku, setVarSku] = useState(() => editingVariant?.sku || '');
  const [varBarcode, setVarBarcode] = useState(() => editingVariant?.barcode || '');
  const [varPriceAdjStr, setVarPriceAdjStr] = useState(() =>
    editingVariant?.priceAdjustment !== undefined ? String(editingVariant.priceAdjustment) : ''
  );
  const [varStockStr, setVarStockStr] = useState(() =>
    editingVariant ? String(editingVariant.stock?.[branchId] ?? 0) : '0'
  );

  useEffect(() => {
    setVarName(editingVariant?.name || '');
    setVarSize(editingVariant?.sizeLabel || '');
    setVarColorHex(editingVariant?.colorHex || '#111827');
    setVarSku(editingVariant?.sku || '');
    setVarBarcode(editingVariant?.barcode || '');
    setVarPriceAdjStr(
      editingVariant?.priceAdjustment !== undefined ? String(editingVariant.priceAdjustment) : ''
    );
    setVarStockStr(editingVariant ? String(editingVariant.stock?.[branchId] ?? 0) : '0');
  }, [editingVariant, branchId]);

  const handleConfirm = useCallback(() => {
    if (!varName.trim()) {
      Alert.alert('Variante requerida', 'Ingresa un nombre para la variante (ej. Rojo / Talla M).');
      return;
    }
    const vStockNum = Math.max(0, parseFloat(varStockStr) || 0);
    const adjNum = parseFloat(varPriceAdjStr) || 0;
    const isEditing = Boolean(editingVariant);
    const nextVariant: ProductVariant = {
      ...(editingVariant || {}),
      id: editingVariant?.id || `var_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: varName.trim(),
      sizeLabel: varSize.trim() || undefined,
      colorHex: varColorHex || undefined,
      sku: varSku.trim() || undefined,
      barcode: varBarcode.trim() || undefined,
      priceAdjustment: adjNum !== 0 ? adjNum : undefined,
      stock: {
        ...(editingVariant?.stock || {}),
        [branchId]: vStockNum,
      },
    };

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSubmit(nextVariant, isEditing);
  }, [
    varName,
    varSize,
    varColorHex,
    varSku,
    varBarcode,
    varPriceAdjStr,
    varStockStr,
    editingVariant,
    branchId,
    onSubmit,
  ]);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.subModalOverlay}>
        <View style={styles.subModalCard}>
          <View style={styles.subModalHeader}>
            <Text style={styles.subModalTitle}>
              {editingVariant ? 'Editar Variante' : 'Nueva Variante'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Nombre *</Text>
            <TextInput
              style={styles.input}
              value={varName}
              onChangeText={setVarName}
              placeholder="Ej. Rojo / Vainilla"
              placeholderTextColor={ui.textMuted}
            />
          </View>

          <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
            <View style={[styles.formGroup, styles.colFlex]}>
              <Text style={styles.label}>Talla / Medida</Text>
              <TextInput
                style={styles.input}
                value={varSize}
                onChangeText={setVarSize}
                placeholder="Ej. M, L, 500ml"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroup, styles.colFlex]}>
              <Text style={styles.label}>Stock ({branchId})</Text>
              <TextInput
                style={styles.input}
                value={varStockStr}
                onChangeText={setVarStockStr}
                keyboardType={allowDecimals ? 'decimal-pad' : 'numeric'}
                placeholder="0"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>

          <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
            <View style={[styles.formGroup, styles.colFlex]}>
              <Text style={styles.label}>Ajuste Precio (S/)</Text>
              <TextInput
                style={styles.input}
                value={varPriceAdjStr}
                onChangeText={setVarPriceAdjStr}
                keyboardType="numeric"
                placeholder="0.00"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroup, styles.colFlex]}>
              <Text style={styles.label}>SKU Variante</Text>
              <TextInput
                style={styles.input}
                value={varSku}
                onChangeText={setVarSku}
                placeholder="Opcional"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Código de Barras Variante</Text>
            <TextInput
              style={styles.input}
              value={varBarcode}
              onChangeText={setVarBarcode}
              placeholder="Opcional"
              placeholderTextColor={ui.textMuted}
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Color identificador</Text>
            <View style={styles.colorSwatchesRow}>
              {VARIANT_COLORS.map((hex) => (
                <TouchableOpacity
                  key={hex}
                  onPress={() => setVarColorHex(hex)}
                  style={[
                    styles.colorSwatchBtn,
                    { backgroundColor: hex },
                    varColorHex === hex && styles.colorSwatchSelected,
                  ]}
                />
              ))}
            </View>
          </View>

          <View style={styles.subModalActions}>
            <TouchableOpacity style={styles.subModalCancel} onPress={onClose}>
              <Text style={styles.subModalCancelText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.subModalConfirm} onPress={handleConfirm}>
              <Check size={16} color={ui.surface} />
              <Text style={styles.subModalConfirmText}>
                {editingVariant ? 'Guardar' : 'Agregar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});
