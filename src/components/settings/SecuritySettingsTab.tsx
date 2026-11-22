import React, { useEffect, useState } from 'react';
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
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { KeyRound, Lock, LogOut, Save, Shield, User, Wallet, X } from 'lucide-react-native';

import { SectionHeading } from '@/components/ui';
import { apiRequest } from '@/lib/api-client';
import { db } from '@/lib/firebase';
import { ui } from '@/lib/theme';

import { settingsStyles as styles } from './settingsStyles';

const getRoleLabel = (role?: string): string => {
  switch (role) {
    case 'owner':
      return 'Propietario';
    case 'admin':
      return 'Administrador';
    case 'manager':
      return 'Encargado';
    case 'seller':
      return 'Vendedor';
    default:
      return 'Cajero';
  }
};

export interface SecuritySettingsTabProps {
  accountId: string | null;
  canManageSettings: boolean;
  role: string;
  userEmail: string | null | undefined;
  displayName: string | null | undefined;
  lockTerminal: () => void;
  updatePinCode: (newPin: string) => Promise<void>;
  onLogoutPress: () => void;
}

export const SecuritySettingsTab = React.memo<SecuritySettingsTabProps>(
  ({
    accountId,
    canManageSettings,
    role,
    userEmail,
    displayName,
    lockTerminal,
    updatePinCode,
    onLogoutPress,
  }) => {
    const [pinModalVisible, setPinModalVisible] = useState(false);
    const [newPinInput, setNewPinInput] = useState('');
    const [confirmPinInput, setConfirmPinInput] = useState('');
    const [isUpdatingPin, setIsUpdatingPin] = useState(false);

    const [cashierExpenseLimitStr, setCashierExpenseLimitStr] = useState('0');
    const [suggestedMarginStr, setSuggestedMarginStr] = useState('25');
    const [hasExpensePin, setHasExpensePin] = useState(false);
    const [expensePinInput, setExpensePinInput] = useState('');
    const [expensePinConfirm, setExpensePinConfirm] = useState('');
    const [isSavingExpenseConfig, setIsSavingExpenseConfig] = useState(false);
    const [isUpdatingExpensePin, setIsUpdatingExpensePin] = useState(false);

    useEffect(() => {
      if (!accountId) return;
      let active = true;

      getDoc(doc(db, 'settings', `${accountId}_expenses`))
        .then((expSnap) => {
          if (!active || !expSnap?.exists()) return;
          const eData = expSnap.data() || {};
          setCashierExpenseLimitStr(String(Number(eData.cashierExpenseLimit ?? 0)));
          setSuggestedMarginStr(String(Number(eData.suggestedMarginPercent ?? 25)));
          setHasExpensePin(Boolean(eData.authorizationPinHash));
        })
        .catch((err) => {
          console.warn('[Settings] Error loading expenses settings doc:', err);
        });

      return () => {
        active = false;
      };
    }, [accountId]);

    const handleChangeTerminalPin = async () => {
      if (!/^\d{4,8}$/.test(newPinInput)) {
        Alert.alert(
          'PIN Inválido',
          'El PIN del terminal debe tener entre 4 y 8 dígitos numéricos.'
        );
        return;
      }
      if (newPinInput !== confirmPinInput) {
        Alert.alert('No Coincide', 'La confirmación del PIN no coincide.');
        return;
      }

      setIsUpdatingPin(true);
      try {
        await updatePinCode(newPinInput);
        setPinModalVisible(false);
        setNewPinInput('');
        setConfirmPinInput('');
        Alert.alert(
          'PIN Actualizado',
          `El PIN de bloqueo rápido (${newPinInput.length} dígitos) fue configurado.`
        );
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudo actualizar el PIN.');
      } finally {
        setIsUpdatingPin(false);
      }
    };

    const handleSaveExpenseLimits = async () => {
      if (!canManageSettings || !accountId) return;
      const limit = Number(cashierExpenseLimitStr);
      const margin = Number(suggestedMarginStr);
      if (!Number.isFinite(limit) || limit < 0) {
        Alert.alert('Tope Inválido', 'Ingresa 0 (sin límite) o un monto positivo.');
        return;
      }
      if (!Number.isFinite(margin) || margin <= 0 || margin > 500) {
        Alert.alert('Margen Inválido', 'Ingresa un porcentaje de margen entre 1 y 500.');
        return;
      }

      setIsSavingExpenseConfig(true);
      try {
        await setDoc(
          doc(db, 'settings', `${accountId}_expenses`),
          {
            accountId,
            cashierExpenseLimit: limit,
            suggestedMarginPercent: margin,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        Alert.alert(
          'Límites Guardados',
          'El tope de egresos se aplicará a las próximas aperturas de caja.'
        );
      } catch (err: any) {
        Alert.alert(
          'Error',
          err?.message || 'No se pudo guardar la configuración de egresos.'
        );
      } finally {
        setIsSavingExpenseConfig(false);
      }
    };

    const handleSaveExpenseAuthPin = async () => {
      if (!canManageSettings || !accountId) return;
      if (!/^\d{4,8}$/.test(expensePinInput)) {
        Alert.alert(
          'PIN Inválido',
          'El PIN de egresos debe tener entre 4 y 8 dígitos numéricos.'
        );
        return;
      }
      if (expensePinInput !== expensePinConfirm) {
        Alert.alert('PIN no Coincide', 'Ambos campos del PIN de autorización deben ser iguales.');
        return;
      }

      setIsUpdatingExpensePin(true);
      try {
        await apiRequest<{ success: boolean }>('/api/expenses/pin', {
          method: 'POST',
          body: { accountId, pin: expensePinInput },
        });
        setHasExpensePin(true);
        setExpensePinInput('');
        setExpensePinConfirm('');
        Alert.alert(
          'PIN de Egresos Actualizado',
          'Los cajeros podrán usar este PIN para autorizar egresos sobre su límite.'
        );
      } catch (err: any) {
        Alert.alert(
          'Error al Guardar PIN',
          err?.message || 'No se pudo configurar el PIN de autorización de egresos.'
        );
      } finally {
        setIsUpdatingExpensePin(false);
      }
    };

    return (
      <>
        <SectionHeading title="Bloqueo de Terminal" subtitle="PIN rápido local del dispositivo" />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
              <Shield size={22} color={ui.accent} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Seguridad de Terminal</Text>
              <Text style={styles.cardSubtitle}>Bloqueo inmediato y PIN de 4 a 8 dígitos</Text>
            </View>
          </View>

          <View style={styles.actionButtonGroup}>
            <TouchableOpacity
              style={[styles.outlineActionBtn, { borderColor: ui.primary }]}
              onPress={() => setPinModalVisible(true)}
            >
              <KeyRound size={18} color={ui.primary} />
              <Text style={[styles.outlineActionBtnText, { color: ui.primary }]}>
                Cambiar PIN (4-8 Dígitos)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.outlineActionBtn, { borderColor: ui.warning }]}
              onPress={lockTerminal}
            >
              <Lock size={18} color={ui.warning} />
              <Text style={[styles.outlineActionBtnText, { color: ui.warning }]}>
                Bloquear Terminal
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <SectionHeading
          title="Egresos y PIN de Autorización"
          subtitle="Control de caja chica y rotación del PIN de supervisor"
        />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
              <Wallet size={22} color={ui.primary} />
            </View>
            <View style={styles.cardHeaderText}>
              <View style={styles.inlineRow}>
                <Text style={styles.cardTitle}>Límite de Egreso & PIN</Text>
                <View
                  style={[
                    styles.pillBadge,
                    { backgroundColor: hasExpensePin ? ui.successSoft : ui.surfaceMuted },
                  ]}
                >
                  <Text
                    style={[
                      styles.pillBadgeText,
                      { color: hasExpensePin ? ui.success : ui.textSecondary },
                    ]}
                  >
                    {hasExpensePin ? 'PIN Configurado' : 'Sin PIN'}
                  </Text>
                </View>
              </View>
              <Text style={styles.cardSubtitle}>
                El hash nunca se expone; los cajeros usan este PIN para superar su tope
              </Text>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>
              Tope de Egreso del Cajero (S/, 0 = sin límite)
            </Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              keyboardType="decimal-pad"
              value={cashierExpenseLimitStr}
              onChangeText={setCashierExpenseLimitStr}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Margen Sugerido en Recepción (%)</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              keyboardType="decimal-pad"
              value={suggestedMarginStr}
              onChangeText={setSuggestedMarginStr}
              editable={canManageSettings}
            />
          </View>

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.secondaryOutlineBtn, isSavingExpenseConfig && styles.buttonDisabled]}
              onPress={handleSaveExpenseLimits}
              disabled={isSavingExpenseConfig}
            >
              {isSavingExpenseConfig ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <>
                  <Save size={16} color={ui.primary} />
                  <Text style={styles.secondaryOutlineBtnText}>Guardar Tope y Margen</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          {canManageSettings ? (
            <View style={styles.digitalPayBox}>
              <Text style={styles.digitalPayTitle}>
                {hasExpensePin
                  ? 'Rotar PIN de Autorización de Egresos'
                  : 'Crear PIN de Autorización de Egresos'}
              </Text>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Nuevo PIN (4 a 8 dígitos)</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="••••••"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="numeric"
                  secureTextEntry
                  maxLength={8}
                  value={expensePinInput}
                  onChangeText={(t) => setExpensePinInput(t.replace(/\D/g, '').slice(0, 8))}
                  accessibilityLabel="Nuevo PIN de autorización de egresos"
                />
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Confirmar PIN</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="••••••"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="numeric"
                  secureTextEntry
                  maxLength={8}
                  value={expensePinConfirm}
                  onChangeText={(t) => setExpensePinConfirm(t.replace(/\D/g, '').slice(0, 8))}
                  accessibilityLabel="Confirmar PIN de autorización de egresos"
                />
              </View>
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  (isUpdatingExpensePin || !expensePinInput) && styles.buttonDisabled,
                ]}
                onPress={handleSaveExpenseAuthPin}
                disabled={isUpdatingExpensePin || !expensePinInput}
              >
                {isUpdatingExpensePin ? (
                  <ActivityIndicator color={ui.onPrimary} />
                ) : (
                  <>
                    <KeyRound size={18} color={ui.onPrimary} />
                    <Text style={styles.saveButtonText}>
                      {hasExpensePin ? 'Rotar PIN de Egresos' : 'Guardar PIN de Egresos'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        <SectionHeading title="Cuenta" />
        <View style={styles.card}>
          <View style={styles.userProfileRow}>
            <View style={styles.userAvatar}>
              <User size={24} color={ui.primary} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.userName}>{displayName || userEmail || 'Usuario'}</Text>
              <Text style={styles.userRole}>Rol: {getRoleLabel(role)}</Text>
              <Text style={styles.userEmail}>{userEmail || 'Sin correo'}</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.logoutButton} onPress={onLogoutPress}>
            <LogOut size={18} color={ui.danger} />
            <Text style={styles.logoutText}>Cerrar Sesión del Terminal</Text>
          </TouchableOpacity>
        </View>

        {pinModalVisible && (
          <Modal
            visible={pinModalVisible}
            transparent
            animationType="fade"
            onRequestClose={() => setPinModalVisible(false)}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <SafeAreaView style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <View style={styles.flex1}>
                    <Text style={styles.modalTitle}>Cambiar PIN de Terminal</Text>
                    <Text style={styles.modalSub}>
                      Código de 4 a 8 dígitos para desbloqueo rápido
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setPinModalVisible(false)}
                    style={styles.modalCloseButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar cambio de PIN"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Nuevo PIN (4 a 8 dígitos numéricos)</Text>
                  <TextInput
                    style={[styles.textInput, styles.pinInput]}
                    placeholder="••••"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    maxLength={8}
                    secureTextEntry
                    value={newPinInput}
                    onChangeText={setNewPinInput}
                    accessibilityLabel="Nuevo PIN, cuatro a ocho dígitos"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Confirmar Nuevo PIN</Text>
                  <TextInput
                    style={[styles.textInput, styles.pinInput]}
                    placeholder="••••"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    maxLength={8}
                    secureTextEntry
                    value={confirmPinInput}
                    onChangeText={setConfirmPinInput}
                    accessibilityLabel="Confirmar nuevo PIN"
                  />
                </View>

                <TouchableOpacity
                  style={[styles.saveButton, isUpdatingPin && styles.buttonDisabled]}
                  onPress={handleChangeTerminalPin}
                  disabled={isUpdatingPin}
                >
                  {isUpdatingPin ? (
                    <ActivityIndicator color={ui.onPrimary} />
                  ) : (
                    <Text style={styles.saveButtonText}>Guardar Nuevo PIN</Text>
                  )}
                </TouchableOpacity>
              </SafeAreaView>
            </KeyboardAvoidingView>
          </Modal>
        )}
      </>
    );
  }
);
