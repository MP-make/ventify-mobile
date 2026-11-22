import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { X } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import { returnFiadoMerchandise, type OpenFiado } from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

export interface FiadoReturnModalProps {
  fiado: OpenFiado | null;
  accountId?: string | null;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  role?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

export const FiadoReturnModal = React.memo<FiadoReturnModalProps>(({
  fiado,
  accountId,
  user,
  userProfile,
  role,
  onClose,
  onSuccess,
}) => {
  const [returnQtyMap, setReturnQtyMap] = useState<Record<string, string>>({});
  const [returnReasonInput, setReturnReasonInput] = useState<string>('');
  const [isSubmittingFiadoReturn, setIsSubmittingFiadoReturn] = useState<boolean>(false);

  useEffect(() => {
    if (fiado) {
      setReturnQtyMap({});
      setReturnReasonInput('');
      setIsSubmittingFiadoReturn(false);
    }
  }, [fiado]);

  const returnedByProductMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!fiado) return map;
    for (const ret of fiado.returnHistory || []) {
      for (const line of ret.items || []) {
        const pid = String(line.productId || '');
        if (!pid) continue;
        map.set(pid, (map.get(pid) || 0) + (Number(line.quantity) || 0));
      }
    }
    return map;
  }, [fiado]);

  const handleSubmitReturnFiado = useCallback(async () => {
    if (!fiado || !accountId || !user) return;

    const itemsPayload: Array<{ productId: string; quantity: number }> = [];
    for (const it of fiado.items || []) {
      const pid = String(it.productId || it.id || '');
      if (!pid) continue;
      const qty = parseFloat((returnQtyMap[pid] || '').replace(',', '.'));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const already = returnedByProductMap.get(pid) || 0;
      const maxQty = Math.max(0, Number(it.quantity || 0) - already);
      if (qty > maxQty) {
        Alert.alert(
          'Cantidad inválida',
          `Solo puedes devolver hasta ${maxQty} unidad(es) de ${
            it.productName || it.name || pid
          }.`
        );
        return;
      }
      itemsPayload.push({ productId: pid, quantity: qty });
    }

    if (itemsPayload.length === 0) {
      Alert.alert(
        'Cantidad requerida',
        'Ingresa la cantidad de al menos un producto a devolver.'
      );
      return;
    }
    if (returnReasonInput.trim().length < 3) {
      Alert.alert(
        'Motivo requerido',
        'Indica el motivo de la devolución (mínimo 3 caracteres).'
      );
      return;
    }

    setIsSubmittingFiadoReturn(true);
    try {
      const res = await returnFiadoMerchandise({
        accountId,
        reservationId: fiado.id,
        items: itemsPayload,
        reason: returnReasonInput.trim(),
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Operador',
          email: user.email,
          role: role || undefined,
        },
      });

      onClose();
      onSuccess();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert(
        res.settled ? 'Fiado Liquidado por Devolución' : 'Devolución Registrada',
        res.creditApplied > 0
          ? `Se reingresó el stock (${formatPEN(res.returnAmount)}) y el excedente de ${formatPEN(
              res.creditApplied
            )} pasó a créditos del cliente.`
          : `Se reingresó el stock (${formatPEN(
              res.returnAmount
            )}). Saldo pendiente del fiado: ${formatPEN(res.remaining)}.`
      );
    } catch (err: any) {
      Alert.alert(
        'No se pudo devolver',
        err?.message || 'Error al registrar devolución de fiado.'
      );
    } finally {
      setIsSubmittingFiadoReturn(false);
    }
  }, [
    fiado,
    accountId,
    user,
    returnQtyMap,
    returnedByProductMap,
    returnReasonInput,
    userProfile?.displayName,
    role,
    onClose,
    onSuccess,
  ]);

  if (!fiado) return null;

  return (
    <Modal
      visible={Boolean(fiado)}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!isSubmittingFiadoReturn) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, styles.modalContentTall90]}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Devolver Mercadería</Text>
                <Text style={styles.modalSub}>
                  Fiado #{fiado.reservationNumber ?? fiado.id.slice(-6).toUpperCase()}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  if (!isSubmittingFiadoReturn) onClose();
                }}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar devolución de fiado"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.helperText}>
              El stock reingresa hoy al inventario. No se entrega efectivo: cualquier excedente se
              abona a créditos del cliente.
            </Text>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {(fiado.items || []).map((it, idx) => {
                const pid = String(it.productId || it.id || '');
                const alreadyReturned = returnedByProductMap.get(pid) || 0;
                const maxQty = Math.max(0, (Number(it.quantity) || 0) - alreadyReturned);
                return (
                  <View key={`${pid}_${idx}`} style={styles.returnItemRow}>
                    <View style={{ flex: 1, marginRight: 10 }}>
                      <Text style={styles.returnItemName} numberOfLines={2}>
                        {it.productName || it.name || 'Producto'}
                      </Text>
                      <Text style={styles.returnItemMeta}>
                        P.U. {formatPEN(Number(it.price) || 0)} · Máx. devolvible: {maxQty}
                      </Text>
                    </View>
                    <TextInput
                      style={styles.returnQtyInput}
                      placeholder="0"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="decimal-pad"
                      value={returnQtyMap[pid] ?? ''}
                      editable={maxQty > 0}
                      onChangeText={(txt) =>
                        setReturnQtyMap((prev) => ({
                          ...prev,
                          [pid]: txt.replace(/[^\d.,]/g, ''),
                        }))
                      }
                    />
                  </View>
                );
              })}

              <View style={[styles.inputGroup, { marginTop: 10 }]}>
                <Text style={styles.label}>Motivo de la devolución *</Text>
                <TextInput
                  style={[styles.input, styles.inputMultiline70]}
                  placeholder="Ej. Producto con falla o cliente desistió"
                  placeholderTextColor={ui.textMuted}
                  multiline
                  value={returnReasonInput}
                  onChangeText={setReturnReasonInput}
                />
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.primaryButton, isSubmittingFiadoReturn && styles.buttonDisabled]}
              onPress={handleSubmitReturnFiado}
              disabled={isSubmittingFiadoReturn}
            >
              {isSubmittingFiadoReturn ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.primaryButtonText}>Confirmar Devolución</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
