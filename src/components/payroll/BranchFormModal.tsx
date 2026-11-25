import React, { useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ui } from '@/lib/theme';
import { saveBranchRecord, type BranchItem } from '@/services/enterprise-ops-service';
import { payrollModalStyles as styles } from './payroll-modal-styles';

export interface BranchFormModalProps {
  visible: boolean;
  editingBranch: BranchItem | null;
  accountId: string | null;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

/** Sub-modal for creating or editing a branch with isolated form state. */
export const BranchFormModal = React.memo<BranchFormModalProps>(({
  visible,
  editingBranch,
  accountId,
  onSaved,
  onClose,
}) => {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState<string>(() => editingBranch?.name || '');
  const [address, setAddress] = useState<string>(() => editingBranch?.address || '');
  const [phone, setPhone] = useState<string>(() => editingBranch?.phone || '');
  const [email, setEmail] = useState<string>(() => editingBranch?.email || '');
  const [manager, setManager] = useState<string>(() => editingBranch?.manager || '');
  const [businessName, setBusinessName] = useState<string>(
    () => editingBranch?.businessName || ''
  );
  const [ruc, setRuc] = useState<string>(() => editingBranch?.ruc || '');
  const [footer, setFooter] = useState<string>(() => editingBranch?.receiptFooter || '');
  const [isActive, setIsActive] = useState<boolean>(() =>
    editingBranch ? editingBranch.isActive !== false : true
  );
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const handleRequestClose = useCallback(() => {
    if (!isSubmitting) {
      onClose();
    }
  }, [isSubmitting, onClose]);

  const handleSaveBranch = useCallback(async () => {
    if (!accountId) return;
    if (!name.trim()) {
      Alert.alert('Nombre requerido', 'Ingresa el nombre de la sucursal.');
      return;
    }
    try {
      setIsSubmitting(true);
      await saveBranchRecord({
        id: editingBranch?.id,
        accountId,
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
        email: email.trim(),
        manager: manager.trim(),
        businessName: businessName.trim(),
        ruc: ruc.trim(),
        receiptFooter: footer.trim(),
        isActive,
      });
      await onSaved();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onClose();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar la sucursal.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    accountId,
    editingBranch?.id,
    name,
    address,
    phone,
    email,
    manager,
    businessName,
    ruc,
    footer,
    isActive,
    onSaved,
    onClose,
  ]);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="slide"
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
          <View style={[styles.modalDialog, styles.modalDialogTall]} collapsable={false}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingBranch ? 'Editar Sucursal' : 'Nueva Sucursal'}
              </Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={handleRequestClose}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de sucursal"
              >
                <X size={18} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.dialogInputLabel}>Nombre de sucursal *:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Ej: Sede Centro"
                placeholderTextColor={ui.textMuted}
                value={name}
                onChangeText={setName}
              />

              <Text style={styles.dialogInputLabel}>Dirección:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Av. Principal 123"
                placeholderTextColor={ui.textMuted}
                value={address}
                onChangeText={setAddress}
              />

              <View style={styles.twoColRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogInputLabel}>Teléfono:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="987654321"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="phone-pad"
                    value={phone}
                    onChangeText={setPhone}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogInputLabel}>RUC (opcional):</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="20XXXXXXXXX"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    maxLength={11}
                    value={ruc}
                    onChangeText={setRuc}
                  />
                </View>
              </View>

              <Text style={styles.dialogInputLabel}>Correo de sucursal:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="sucursal@negocio.com"
                placeholderTextColor={ui.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
              />

              <Text style={styles.dialogInputLabel}>Encargado / Administrador:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Nombre del encargado"
                placeholderTextColor={ui.textMuted}
                value={manager}
                onChangeText={setManager}
              />

              <Text style={styles.dialogInputLabel}>Razón Social / Nombre Comercial:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Opcional para comprobantes"
                placeholderTextColor={ui.textMuted}
                value={businessName}
                onChangeText={setBusinessName}
              />

              <Text style={styles.dialogInputLabel}>Pie de Ticket:</Text>
              <TextInput
                style={[styles.dialogInput, styles.dialogTextArea]}
                placeholder="Mensaje al pie del comprobante"
                placeholderTextColor={ui.textMuted}
                value={footer}
                onChangeText={setFooter}
                multiline
                textAlignVertical="top"
              />

              {editingBranch && (
                <View style={styles.switchFieldRow}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={styles.switchTitle}>Sucursal activa</Text>
                    <Text style={styles.switchDesc}>
                      Las sucursales inactivas no aparecen al abrir caja o vender.
                    </Text>
                  </View>
                  <Switch
                    value={isActive}
                    onValueChange={setIsActive}
                    trackColor={{ false: ui.border, true: ui.primarySoft }}
                    thumbColor={isActive ? ui.primary : ui.textMuted}
                  />
                </View>
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                onPress={handleRequestClose}
                disabled={isSubmitting}
              >
                <Text style={styles.dialogCancelText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.dialogSubmitBtn, isSubmitting && styles.buttonDisabled]}
                onPress={handleSaveBranch}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator color={ui.onPrimary} size="small" />
                ) : (
                  <>
                    <Check size={15} color={ui.onPrimary} />
                    <Text style={styles.dialogSubmitText}>
                      {editingBranch ? 'Guardar sucursal' : 'Crear sucursal'}
                    </Text>
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
