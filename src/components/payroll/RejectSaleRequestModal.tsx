import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, XCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ui } from '@/lib/theme';
import { resolveSaleRequest, type SaleRequest } from '@/services/enterprise-ops-service';
import type { UserProfile } from '@/types';
import { payrollModalStyles as styles } from './payroll-modal-styles';

export interface RejectSaleRequestModalProps {
  visible: boolean;
  target: SaleRequest;
  userProfile: UserProfile | null;
  branchId: string;
  onClose: () => void;
}

/** Cross-platform rejection dialog with isolated reason input state. */
export const RejectSaleRequestModal = React.memo<RejectSaleRequestModalProps>(({
  visible,
  target,
  userProfile,
  branchId,
  onClose,
}) => {
  const insets = useSafeAreaInsets();
  const [rejectReason, setRejectReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    setRejectReason('');
  }, [target.id]);

  const handleRequestClose = useCallback(() => {
    if (!isSubmitting) {
      onClose();
    }
  }, [isSubmitting, onClose]);

  const handleConfirmRejectRequest = useCallback(async () => {
    try {
      setIsSubmitting(true);
      await resolveSaleRequest(
        target.id,
        'rejected',
        userProfile,
        rejectReason.trim() || 'Descuento no autorizado',
        branchId
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      onClose();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo rechazar la solicitud.');
    } finally {
      setIsSubmitting(false);
    }
  }, [target.id, userProfile, rejectReason, branchId, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={handleRequestClose}
    >
      <View
        style={[styles.modalSafe, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        collapsable={false}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalDialog} collapsable={false}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Rechazar Solicitud</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={handleRequestClose}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Cerrar rechazo de solicitud"
              >
                <X size={18} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtext}>
              {`${target.requestNumber} · ${target.customerName}`}
            </Text>

            <Text style={styles.dialogInputLabel}>Motivo del rechazo:</Text>
            <TextInput
              style={[styles.dialogInput, styles.dialogTextArea]}
              placeholder="Ej: Descuento excede el margen permitido"
              placeholderTextColor={ui.textMuted}
              value={rejectReason}
              onChangeText={setRejectReason}
              multiline
              textAlignVertical="top"
            />

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                onPress={handleRequestClose}
                disabled={isSubmitting}
              >
                <Text style={styles.dialogCancelText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.dialogDangerBtn, isSubmitting && styles.buttonDisabled]}
                onPress={handleConfirmRejectRequest}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator color={ui.onPrimary} size="small" />
                ) : (
                  <>
                    <XCircle size={15} color={ui.onPrimary} />
                    <Text style={styles.dialogSubmitText}>Rechazar</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
});
