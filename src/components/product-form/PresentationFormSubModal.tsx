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
import { presentationFactor } from '@/lib/presentation-parity';
import { normalizePresentationBidirectional } from '@/services/inventory-kardex-service';
import { ui } from '@/lib/theme';
import type { ProductPresentation } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

export interface PresentationFormSubModalProps {
  visible: boolean;
  editingPresentation: ProductPresentation | null;
  compactLayout: boolean;
  onClose: () => void;
  onSubmit: (presentation: ProductPresentation, isEditing: boolean) => void;
}

export const PresentationFormSubModal: React.FC<PresentationFormSubModalProps> = React.memo(({
  visible,
  editingPresentation,
  compactLayout,
  onClose,
  onSubmit,
}) => {
  const [presName, setPresName] = useState(() => editingPresentation?.name || '');
  const [presFactor, setPresFactor] = useState(() =>
    editingPresentation ? String(presentationFactor(editingPresentation)) : ''
  );
  const [presPrice, setPresPrice] = useState(() =>
    editingPresentation ? String(editingPresentation.price ?? '') : ''
  );
  const [presBarcode, setPresBarcode] = useState(() => editingPresentation?.barcode || '');

  useEffect(() => {
    setPresName(editingPresentation?.name || '');
    setPresFactor(editingPresentation ? String(presentationFactor(editingPresentation)) : '');
    setPresPrice(editingPresentation ? String(editingPresentation.price ?? '') : '');
    setPresBarcode(editingPresentation?.barcode || '');
  }, [editingPresentation]);

  const handleConfirm = useCallback(() => {
    const factorNum = parseFloat(presFactor);
    const priceNum = parseFloat(presPrice);
    if (!presName.trim() || isNaN(factorNum) || factorNum <= 1 || isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Datos Inválidos', 'Ingresa un nombre, factor de unidades mayor a 1 y precio válido.');
      return;
    }

    const isEditing = Boolean(editingPresentation);
    const updatedPres = normalizePresentationBidirectional({
      id: editingPresentation?.id || `pres_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: presName.trim(),
      conversionFactor: factorNum,
      quantity: factorNum,
      price: priceNum,
      barcode: presBarcode.trim() || undefined,
      active: true,
    });

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSubmit(updatedPres, isEditing);
  }, [presName, presFactor, presPrice, presBarcode, editingPresentation, onSubmit]);

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
              {editingPresentation ? 'Editar Presentación' : 'Nueva Presentación'}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Cerrar presentación"
            >
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Nombre de Presentación</Text>
            <TextInput
              style={styles.input}
              value={presName}
              onChangeText={setPresName}
              accessibilityLabel="Nombre de la presentación"
              placeholder="Ej. Pack x6 o Caja x12"
              placeholderTextColor={ui.textMuted}
            />
          </View>

          <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>Unidades Contenidas</Text>
              <TextInput
                style={styles.input}
                value={presFactor}
                onChangeText={setPresFactor}
                accessibilityLabel="Unidades contenidas en la presentación"
                placeholder="Ej. 6"
                keyboardType="numeric"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>Precio Especial (S/)</Text>
              <TextInput
                style={styles.input}
                value={presPrice}
                onChangeText={setPresPrice}
                accessibilityLabel="Precio especial en soles"
                placeholder="S/ 0.00"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Código de Barras Propio (Opcional)</Text>
            <TextInput
              style={styles.input}
              value={presBarcode}
              onChangeText={setPresBarcode}
              accessibilityLabel="Código de barras propio de la presentación, opcional"
              placeholder="Código del empaque"
              placeholderTextColor={ui.textMuted}
            />
          </View>

          <View style={styles.subModalActions}>
            <TouchableOpacity
              style={styles.subModalCancel}
              onPress={onClose}
              accessibilityRole="button"
            >
              <Text style={styles.subModalCancelText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.subModalConfirm}
              onPress={handleConfirm}
              accessibilityRole="button"
            >
              <Check size={16} color={ui.surface} />
              <Text style={styles.subModalConfirmText}>
                {editingPresentation ? 'Guardar' : 'Agregar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});
