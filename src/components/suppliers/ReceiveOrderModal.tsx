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
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { ui } from '@/lib/theme';
import { assertOnlineForWrite } from '@/lib/online-guard';
import {
  SuppliersPOService,
  PurchaseOrder,
  ReceivePurchaseOrderResult,
  resolvePackagingFactor,
} from '@/services/suppliers-po-service';
import { suppliersStyles as styles } from './suppliersStyles';

function buildInitialReceiveInputs(order: PurchaseOrder): Record<string, string> {
  const initialInputs: Record<string, string> = {};
  (order.items || []).forEach((it, idx) => {
    const remaining = Math.max(
      0,
      Math.round(((Number(it.quantity) || 0) - (Number(it.receivedQuantity) || 0)) * 10000) / 10000
    );
    initialInputs[`${it.productId}:${idx}`] = String(remaining);
  });
  return initialInputs;
}

export interface ReceiveOrderModalProps {
  order: PurchaseOrder;
  onClose: () => void;
  onReceivingStateChange: (orderId: string | null) => void;
  onReceiptSuccess: (order: PurchaseOrder, result: ReceivePurchaseOrderResult) => void;
}

export const ReceiveOrderModal: React.FC<ReceiveOrderModalProps> = React.memo(({
  order,
  onClose,
  onReceivingStateChange,
  onReceiptSuccess,
}) => {
  const { userProfile, branchId } = useAuthSession();
  const { activeBranchName } = useBusinessSettings();
  const insets = useSafeAreaInsets();

  const [receiveQtyInputs, setReceiveQtyInputs] = useState<Record<string, string>>(() =>
    buildInitialReceiveInputs(order)
  );
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    setReceiveQtyInputs(buildInitialReceiveInputs(order));
  }, [order]);

  const handleFillRemaining = useCallback(() => {
    setReceiveQtyInputs(buildInitialReceiveInputs(order));
  }, [order]);

  const handleConfirmReceipt = useCallback(async () => {
    const partialTotals = new Map<string, number>();
    let totalEntered = 0;
    let isFullReceipt = true;

    (order.items || []).forEach((it, idx) => {
      const remaining = Math.max(
        0,
        Math.round(((Number(it.quantity) || 0) - (Number(it.receivedQuantity) || 0)) * 10000) / 10000
      );
      const rawStr = receiveQtyInputs[`${it.productId}:${idx}`] ?? String(remaining);
      const parsed = Math.max(0, Math.min(remaining, parseFloat(rawStr) || 0));
      if (parsed + 0.00001 < remaining) {
        isFullReceipt = false;
      }
      totalEntered += parsed;
      partialTotals.set(it.productId, (partialTotals.get(it.productId) || 0) + parsed);
    });

    if (totalEntered <= 0) {
      Alert.alert('Cantidad inválida', 'Ingresa al menos una cantidad mayor a 0 para recibir.');
      return;
    }

    const partialItems = Array.from(partialTotals.entries()).map(([productId, receivedQty]) => ({
      productId,
      receivedQty,
    }));

    setIsSubmitting(true);
    onReceivingStateChange(order.id);
    try {
      await assertOnlineForWrite('recibir una orden de compra');
      const result = await SuppliersPOService.receivePurchaseOrder(
        order,
        userProfile,
        branchId,
        activeBranchName,
        isFullReceipt ? undefined : { partialItems }
      );

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onReceiptSuccess(order, result);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      console.error('[SuppliersPurchaseModal] Error al recibir orden:', err);
      Alert.alert(
        'Error en Recepción',
        err?.message || 'No se pudo completar la recepción de la orden de compra.'
      );
    } finally {
      setIsSubmitting(false);
      onReceivingStateChange(null);
    }
  }, [
    order,
    receiveQtyInputs,
    userProfile,
    branchId,
    activeBranchName,
    onReceivingStateChange,
    onReceiptSuccess,
  ]);

  return (
    <Modal
      visible={true}
      animationType="slide"
      transparent={true}
      statusBarTranslucent
      onRequestClose={() => {
        if (!isSubmitting) onClose();
      }}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={[styles.modalSheetContainer, { paddingBottom: Math.max(12, insets.bottom) }]}
          collapsable={false}
        >
          <View style={styles.subModalHeader}>
            <View>
              <Text style={styles.subModalTitle}>
                Recibir {order.orderNumber || 'Orden'}
              </Text>
              <Text style={styles.subModalSubtitle}>
                Ingresa la cantidad recibida por ítem (sucursal: {activeBranchName || branchId})
              </Text>
            </View>
            <TouchableOpacity
              style={styles.closeSubModalBtn}
              onPress={() => {
                if (!isSubmitting) onClose();
              }}
            >
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.subModalBody} keyboardShouldPersistTaps="handled">
            {(order.items || []).map((it, idx) => {
              const ordered = Number(it.quantity) || 0;
              const alreadyRec = Number(it.receivedQuantity) || 0;
              const remaining = Math.max(0, Math.round((ordered - alreadyRec) * 10000) / 10000);
              const factor = resolvePackagingFactor(it.packagingFactor);
              const key = `${it.productId}:${idx}`;
              const val = receiveQtyInputs[key] ?? String(remaining);
              const isLegacyPack = factor > 1 && it.packagingTotalCost == null;

              return (
                <View key={key} style={styles.receiveItemCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.orderItemName}>{it.productName}</Text>
                    <Text style={styles.orderItemDetails}>
                      Pedido: {ordered}
                      {alreadyRec > 0 ? ` • Ya recibido: ${alreadyRec}` : ''} • Pendiente: {remaining}
                      {factor > 1 ? ` (${it.packagingLabel || `×${factor}`})` : ''}
                    </Text>
                    {isLegacyPack && (
                      <Text style={styles.packagingHintText}>
                        Convertirá {(parseFloat(val) || 0) * factor} u. al confirmar
                      </Text>
                    )}
                  </View>
                  {remaining > 0 ? (
                    <View style={{ width: 92 }}>
                      <TextInput
                        style={styles.inputMini}
                        keyboardType="numeric"
                        value={val}
                        onChangeText={(txt) =>
                          setReceiveQtyInputs((prev) => ({ ...prev, [key]: txt }))
                        }
                      />
                    </View>
                  ) : (
                    <Text style={[styles.statusBadgeText, styles.statusBadgeTextReceived]}>
                      Completo
                    </Text>
                  )}
                </View>
              );
            })}
          </ScrollView>

          <View style={styles.subModalFooter}>
            <TouchableOpacity
              style={styles.subModalCancelBtn}
              onPress={handleFillRemaining}
              disabled={isSubmitting}
            >
              <Text style={styles.subModalCancelBtnText}>Todo restante</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveSupplierSubmitBtn, isSubmitting && styles.btnDisabled]}
              onPress={handleConfirmReceipt}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color={ui.surface} />
              ) : (
                <>
                  <Check size={18} color={ui.surface} />
                  <Text style={styles.saveSupplierSubmitBtnText}>Confirmar Recepción</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});
