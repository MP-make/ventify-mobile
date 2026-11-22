import React, { useState, useCallback } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, Alert } from 'react-native';
import { Plus, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession } from '@/context/AuthContext';
import { useCartActions } from '@/context/CartContext';
import { parseNormalizedDecimal } from '@/lib/product-search';
import { ui } from '@/lib/theme';
import type { Product } from '@/types';
import { posStyles as styles } from './posStyles';

interface PosQuickConceptModalProps {
  visible: boolean;
  onClose: () => void;
}

export const PosQuickConceptModal: React.FC<PosQuickConceptModalProps> = React.memo(
  ({ visible, onClose }) => {
    const { accountId, branchId } = useAuthSession();
    const { addItem } = useCartActions();
    const [quickConcept, setQuickConcept] = useState('Venta Rápida');
    const [quickAmountStr, setQuickAmountStr] = useState('');

    const handleConfirmQuickSale = useCallback(() => {
      const amountNum = parseNormalizedDecimal(quickAmountStr);
      if (!quickConcept.trim() || isNaN(amountNum) || amountNum <= 0) {
        Alert.alert(
          'Datos Inválidos',
          'Ingresa un concepto y un importe en soles mayor a S/ 0.00.'
        );
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
      onClose();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, [quickAmountStr, quickConcept, branchId, accountId, addItem, onClose]);

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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Plus size={18} color={ui.primary} />
                <Text style={styles.subModalTitle}>Monto Libre (Ítem no catalogado)</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Concepto o Descripción</Text>
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
              <TouchableOpacity style={styles.subModalCancelBtn} onPress={onClose}>
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
    );
  }
);
