import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { AlertTriangle, Check, X } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import { writeOffFiado, type OpenFiado } from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

export interface FiadoWriteOffModalProps {
  fiado: OpenFiado | null;
  accountId?: string | null;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  role?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

export const FiadoWriteOffModal = React.memo<FiadoWriteOffModalProps>(({
  fiado,
  accountId,
  user,
  userProfile,
  role,
  onClose,
  onSuccess,
}) => {
  const [writeOffReasonInput, setWriteOffReasonInput] = useState<string>('');
  const [writeOffConfirmed, setWriteOffConfirmed] = useState<boolean>(false);
  const [isSubmittingWriteOff, setIsSubmittingWriteOff] = useState<boolean>(false);

  useEffect(() => {
    if (fiado) {
      setWriteOffReasonInput('');
      setWriteOffConfirmed(false);
      setIsSubmittingWriteOff(false);
    }
  }, [fiado]);

  const handleSubmitWriteOff = useCallback(async () => {
    if (!fiado || !accountId || !user) return;
    if (writeOffReasonInput.trim().length < 3) {
      Alert.alert(
        'Motivo requerido',
        'Indica por qué se castiga la deuda (mínimo 3 caracteres).'
      );
      return;
    }
    if (!writeOffConfirmed) {
      Alert.alert('Confirmación requerida', 'Confirma que la deuda es incobrable.');
      return;
    }

    setIsSubmittingWriteOff(true);
    try {
      const res = await writeOffFiado({
        accountId,
        reservationId: fiado.id,
        reason: writeOffReasonInput.trim(),
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Administrador',
          email: user.email,
          role: role || undefined,
        },
      });
      onClose();
      onSuccess();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(
        'Deuda Castigada',
        `Se excluyeron ${formatPEN(res.writeOffAmount)} de la deuda del cliente. Nuevo saldo total: ${formatPEN(
          res.nextDebt
        )}.`
      );
    } catch (err: any) {
      Alert.alert('No se pudo castigar', err?.message || 'Error al castigar deuda.');
    } finally {
      setIsSubmittingWriteOff(false);
    }
  }, [
    fiado,
    accountId,
    user,
    writeOffReasonInput,
    writeOffConfirmed,
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
        if (!isSubmittingWriteOff) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <AlertTriangle size={20} color={ui.danger} />
                <Text style={styles.modalTitle}>Castigar Deuda Incobrable</Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  if (!isSubmittingWriteOff) onClose();
                }}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar castigo de deuda"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.pinSubtitle}>
              Se excluirán {formatPEN(fiado.remainingAmount)} de la deuda del cliente sin mover
              inventario ni caja.
            </Text>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Motivo del castigo *</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline80]}
                placeholder="Indica por qué esta deuda es incobrable..."
                placeholderTextColor={ui.textMuted}
                multiline
                value={writeOffReasonInput}
                onChangeText={setWriteOffReasonInput}
              />
            </View>

            <TouchableOpacity
              style={styles.confirmCheckboxRow}
              onPress={() => setWriteOffConfirmed((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: writeOffConfirmed }}
            >
              <View
                style={[
                  styles.confirmCheckboxBox,
                  writeOffConfirmed && styles.confirmCheckboxBoxChecked,
                ]}
              >
                {writeOffConfirmed && <Check size={13} color={ui.onPrimary} />}
              </View>
              <Text style={styles.confirmCheckboxText}>
                Confirmo que esta deuda es incobrable y el castigo quedará registrado a mi nombre.
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.closeZConfirmButton,
                (isSubmittingWriteOff ||
                  !writeOffConfirmed ||
                  writeOffReasonInput.trim().length < 3) &&
                  styles.buttonDisabled,
              ]}
              onPress={handleSubmitWriteOff}
              disabled={
                isSubmittingWriteOff ||
                !writeOffConfirmed ||
                writeOffReasonInput.trim().length < 3
              }
            >
              {isSubmittingWriteOff ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.closeZConfirmButtonText}>Castigar Deuda</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
