import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { Lock, X } from 'lucide-react-native';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatPEN, ui } from '@/lib/theme';
import {
  authorizeCashExpenseViaPin,
  cashierNeedsPinAuthorization,
  DEFAULT_EXPENSE_CATEGORIES,
  EMPLOYEE_ADVANCE_CATEGORY_ID,
  registerCashMovement,
  type CashMovementType,
  type ExpenseCategoryId,
  type ExpenseReceiptType,
} from '@/services/cash-register-service';
import { getTeamMembers, type TeamMember } from '@/services/enterprise-ops-service';
import { useOfflineStatus } from '@/context/SettingsContext';
import { assertOnlineForWrite, checkIsOnlineLive } from '@/lib/online-guard';
import { enqueueOfflineCashMovement } from '@/services/offline-cash-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

interface PendingPinExpense {
  sessionId: string;
  amount: number;
  reason: string;
  expenseCategoryId: ExpenseCategoryId;
  employeeId?: string;
  receiptType?: ExpenseReceiptType;
  receiptNumber?: string;
}

const RECEIPT_TYPE_OPTIONS: Array<{ id: ExpenseReceiptType; label: string }> = [
  { id: 'ninguno', label: 'Sin comprobante' },
  { id: 'recibo', label: 'Recibo' },
  { id: 'boleta', label: 'Boleta' },
  { id: 'factura', label: 'Factura' },
];

export interface CashMovementModalProps {
  visible: boolean;
  initialType: CashMovementType;
  onClose: () => void;
  accountId?: string | null;
  branchId?: string | null;
  activeCashSession: { id?: string; sessionId?: string; cashierExpenseLimit?: number } | null;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  role?: string | null;
  isCashier: boolean;
  onSuccess: () => void;
}

export const CashMovementModal = React.memo<CashMovementModalProps>(({
  visible,
  initialType,
  onClose,
  accountId,
  branchId,
  activeCashSession,
  user,
  userProfile,
  role,
  isCashier,
  onSuccess,
}) => {
  const { isOnline } = useOfflineStatus();
  const [movementType, setMovementType] = useState<CashMovementType>(initialType);
  const [movementAmount, setMovementAmount] = useState<string>('');
  const [movementReason, setMovementReason] = useState<string>('');
  const [movementCategory, setMovementCategory] = useState<string>(
    initialType === 'income' ? 'manual_income' : 'other'
  );
  const [movementReceiptType, setMovementReceiptType] = useState<ExpenseReceiptType>('ninguno');
  const [movementReceiptNumber, setMovementReceiptNumber] = useState<string>('');
  const [movementEmployeeId, setMovementEmployeeId] = useState<string>('');
  const [teamEmployees, setTeamEmployees] = useState<TeamMember[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState<boolean>(false);
  const [accountExpenseLimit, setAccountExpenseLimit] = useState<number | undefined>(undefined);
  const [isSavingMovement, setIsSavingMovement] = useState<boolean>(false);

  const [pinModalVisible, setPinModalVisible] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [pinError, setPinError] = useState<string>('');
  const [isAuthorizingPin, setIsAuthorizingPin] = useState<boolean>(false);
  const [pendingPinExpense, setPendingPinExpense] = useState<PendingPinExpense | null>(null);

  const teamEmployeesLoadedAccountRef = useRef<string | null>(null);
  const expenseLimitLoadedAccountRef = useRef<string | null>(null);
  const wasVisibleRef = useRef<boolean>(false);

  const resetMovementForm = useCallback((nextType: CashMovementType) => {
    setMovementType(nextType);
    setMovementAmount('');
    setMovementReason('');
    setMovementCategory(nextType === 'income' ? 'manual_income' : 'other');
    setMovementReceiptType('ninguno');
    setMovementReceiptNumber('');
    setMovementEmployeeId('');
  }, []);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      resetMovementForm(initialType);
    }
    wasVisibleRef.current = visible;
  }, [visible, initialType, resetMovementForm]);

  useEffect(() => {
    if (!accountId) {
      teamEmployeesLoadedAccountRef.current = null;
      expenseLimitLoadedAccountRef.current = null;
      setTeamEmployees([]);
      setAccountExpenseLimit(undefined);
      return;
    }
    if (expenseLimitLoadedAccountRef.current === accountId) return;

    let alive = true;
    expenseLimitLoadedAccountRef.current = accountId;
    getDoc(doc(db, 'settings', `${accountId}_expenses`))
      .then((snap) => {
        if (!alive) return;
        if (snap.exists()) {
          const val = Number(snap.data()?.cashierExpenseLimit);
          setAccountExpenseLimit(Number.isFinite(val) && val > 0 ? val : undefined);
        } else {
          setAccountExpenseLimit(undefined);
        }
      })
      .catch(() => {
        expenseLimitLoadedAccountRef.current = null;
        if (alive) setAccountExpenseLimit(undefined);
      });

    return () => {
      alive = false;
    };
  }, [accountId]);

  useEffect(() => {
    if (
      !accountId ||
      !visible ||
      movementType !== 'expense' ||
      movementCategory !== EMPLOYEE_ADVANCE_CATEGORY_ID
    ) {
      return;
    }
    if (teamEmployeesLoadedAccountRef.current === accountId) return;

    let alive = true;
    teamEmployeesLoadedAccountRef.current = accountId;
    setLoadingEmployees(true);
    getTeamMembers(accountId)
      .then((members) => {
        if (!alive) return;
        setTeamEmployees(members.filter((m) => m.isActive !== false));
      })
      .catch(() => {
        teamEmployeesLoadedAccountRef.current = null;
        if (alive) setTeamEmployees([]);
      })
      .finally(() => {
        if (alive) setLoadingEmployees(false);
      });

    return () => {
      alive = false;
    };
  }, [accountId, visible, movementType, movementCategory]);

  const handleRegisterMovement = useCallback(async () => {
    const amt = parseFloat(movementAmount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('Monto Requerido', 'Ingrese un monto mayor a S/ 0.00.');
      return;
    }
    if (!movementReason.trim()) {
      Alert.alert('Concepto Requerido', 'Indique el motivo o concepto del movimiento.');
      return;
    }

    const isExpense = movementType === 'expense';
    const isAdvance = isExpense && movementCategory === EMPLOYEE_ADVANCE_CATEGORY_ID;
    if (isAdvance && !movementEmployeeId) {
      Alert.alert('Trabajador Requerido', 'Selecciona el trabajador que recibe el adelanto.');
      return;
    }

    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !accountId || !branchId || !user) {
      Alert.alert('Error', 'No hay una sesión de caja activa disponible.');
      return;
    }

    const effectiveLimit = activeCashSession?.cashierExpenseLimit ?? accountExpenseLimit;
    const effectiveRole = isCashier ? 'cashier' : role || undefined;
    const online = await checkIsOnlineLive(isOnline);

    if (
      isExpense &&
      cashierNeedsPinAuthorization(effectiveRole, -amt, { cashierExpenseLimit: effectiveLimit })
    ) {
      if (!online) {
        Alert.alert(
          'Sin Conexión',
          'Los egresos que requieren PIN de autorización solo pueden registrarse con internet.'
        );
        return;
      }
      setPendingPinExpense({
        sessionId: sessId,
        amount: amt,
        reason: movementReason.trim(),
        expenseCategoryId: movementCategory as ExpenseCategoryId,
        ...(isAdvance ? { employeeId: movementEmployeeId } : {}),
        receiptType: movementReceiptType,
        ...(movementReceiptType !== 'ninguno' && movementReceiptNumber.trim()
          ? { receiptNumber: movementReceiptNumber.trim() }
          : {}),
      });
      setPinInput('');
      setPinError('');
      setPinModalVisible(true);
      return;
    }

    if (isAdvance && !online) {
      Alert.alert('Sin Conexión', 'Los adelantos a trabajadores requieren conexión a internet.');
      return;
    }

    setIsSavingMovement(true);
    try {
      if (!online) {
        await enqueueOfflineCashMovement({
          accountId,
          userId: user.uid,
          userName: userProfile?.displayName || user.email || 'Operador',
          userRole: effectiveRole,
          branchId,
          sessionId: sessId,
          type: movementType,
          amount: amt,
          category: isExpense ? movementCategory : 'manual_income',
          description: movementReason.trim(),
          reason: movementReason.trim(),
          expenseCategoryId: isExpense ? (movementCategory as ExpenseCategoryId) : undefined,
          receiptType: isExpense ? movementReceiptType : undefined,
          receiptNumber:
            isExpense && movementReceiptType !== 'ninguno' && movementReceiptNumber.trim()
              ? movementReceiptNumber.trim()
              : undefined,
        });

        resetMovementForm(movementType);
        onClose();
        onSuccess();
        Alert.alert(
          'Movimiento Guardado Offline',
          `El ${
            movementType === 'income' ? 'ingreso' : 'egreso'
          } de ${formatPEN(amt)} quedó guardado localmente y se sincronizará al volver la conexión.`
        );
        return;
      }

      await registerCashMovement({
        accountId,
        branchId,
        sessionId: sessId,
        type: movementType,
        amount: amt,
        category: isExpense ? movementCategory : 'manual_income',
        expenseCategoryId: isExpense ? (movementCategory as ExpenseCategoryId) : undefined,
        employeeId: isAdvance ? movementEmployeeId : undefined,
        receiptType: isExpense ? movementReceiptType : undefined,
        receiptNumber:
          isExpense && movementReceiptType !== 'ninguno' && movementReceiptNumber.trim()
            ? movementReceiptNumber.trim()
            : undefined,
        description: movementReason.trim(),
        reason: movementReason.trim(),
        userId: user.uid,
        userName: userProfile?.displayName || user.email || 'Operador',
        userRole: effectiveRole,
      });

      resetMovementForm(movementType);
      onClose();
      onSuccess();
      Alert.alert(
        'Movimiento Registrado',
        `Se registró el ${
          movementType === 'income' ? 'ingreso' : isAdvance ? 'adelanto' : 'egreso/gasto'
        } de ${formatPEN(amt)} con éxito.`
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo registrar el movimiento.');
    } finally {
      setIsSavingMovement(false);
    }
  }, [
    movementAmount,
    movementReason,
    movementType,
    movementCategory,
    movementEmployeeId,
    movementReceiptType,
    movementReceiptNumber,
    activeCashSession,
    accountId,
    branchId,
    user,
    userProfile?.displayName,
    accountExpenseLimit,
    isCashier,
    role,
    isOnline,
    resetMovementForm,
    onClose,
    onSuccess,
  ]);

  const handleAuthorizeExpenseWithPin = useCallback(async () => {
    if (!pendingPinExpense) return;
    const cleanPin = pinInput.replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(cleanPin)) {
      setPinError('Ingresa un PIN numérico de 4 a 8 dígitos.');
      return;
    }

    setIsAuthorizingPin(true);
    setPinError('');
    try {
      await assertOnlineForWrite('autorizar egresos con PIN', isOnline);
      await authorizeCashExpenseViaPin({
        sessionId: pendingPinExpense.sessionId,
        amount: pendingPinExpense.amount,
        reason: pendingPinExpense.reason,
        expenseCategoryId: pendingPinExpense.expenseCategoryId,
        employeeId: pendingPinExpense.employeeId,
        receiptType: pendingPinExpense.receiptType,
        receiptNumber: pendingPinExpense.receiptNumber,
        pin: cleanPin,
      });

      const authorizedAmount = pendingPinExpense.amount;
      setPinModalVisible(false);
      setPendingPinExpense(null);
      setPinInput('');
      setPinError('');
      resetMovementForm(movementType);
      onClose();
      onSuccess();
      Alert.alert(
        'Egreso Autorizado',
        `Se autorizó y registró el retiro de ${formatPEN(authorizedAmount)} correctamente.`
      );
    } catch (err: any) {
      setPinError(err?.message || 'PIN incorrecto o no se pudo autorizar el egreso.');
    } finally {
      setIsAuthorizingPin(false);
    }
  }, [pendingPinExpense, pinInput, isOnline, movementType, resetMovementForm, onClose, onSuccess]);

  const handleCloseMovement = useCallback(() => {
    if (!isSavingMovement) onClose();
  }, [isSavingMovement, onClose]);

  const handleCancelPin = useCallback(() => {
    if (!isAuthorizingPin) {
      setPinModalVisible(false);
      setPendingPinExpense(null);
      setPinInput('');
      setPinError('');
      onClose();
    }
  }, [isAuthorizingPin, onClose]);

  const handleBackToForm = useCallback(() => {
    setPinModalVisible(false);
    setPinInput('');
    setPinError('');
  }, []);

  if (!visible && !pinModalVisible) return null;

  return (
    <>
      {visible && !pinModalVisible && (
        <Modal
          visible={visible && !pinModalVisible}
          transparent
          animationType="fade"
          onRequestClose={handleCloseMovement}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <View style={[styles.modalContent, styles.modalContentTall92]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {movementType === 'income'
                      ? 'Registrar Ingreso Manual'
                      : 'Registrar Egreso / Gasto'}
                  </Text>
                  <TouchableOpacity
                    onPress={handleCloseMovement}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar registro de movimiento"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Importe (S/)</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="0.00"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="decimal-pad"
                      value={movementAmount}
                      onChangeText={setMovementAmount}
                    />
                  </View>

                  {movementType === 'expense' && (
                    <View style={styles.inputGroup}>
                      <Text style={styles.label}>Categoría de Gasto</Text>
                      <View style={styles.categoryPickerRow}>
                        {DEFAULT_EXPENSE_CATEGORIES.map((cat) => (
                          <TouchableOpacity
                            key={cat.id}
                            style={[
                              styles.catChip,
                              movementCategory === cat.id && styles.catChipActive,
                            ]}
                            onPress={() => {
                              setMovementCategory(cat.id);
                              if (cat.id !== EMPLOYEE_ADVANCE_CATEGORY_ID) {
                                setMovementEmployeeId('');
                              }
                            }}
                          >
                            <Text
                              style={[
                                styles.catChipText,
                                movementCategory === cat.id && styles.catChipTextActive,
                              ]}
                            >
                              {cat.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      {movementCategory === EMPLOYEE_ADVANCE_CATEGORY_ID && (
                        <Text style={styles.helperText}>
                          Los adelantos se descuentan en Planilla y no reducen la utilidad operativa del P&L.
                        </Text>
                      )}
                    </View>
                  )}

                  {movementType === 'expense' && movementCategory === EMPLOYEE_ADVANCE_CATEGORY_ID && (
                    <View style={styles.inputGroup}>
                      <Text style={styles.label}>Trabajador que recibe el adelanto *</Text>
                      {loadingEmployees ? (
                        <ActivityIndicator size="small" color={ui.primary} style={{ marginVertical: 8 }} />
                      ) : teamEmployees.length === 0 ? (
                        <Text style={styles.helperText}>
                          No hay colaboradores activos registrados en la cuenta.
                        </Text>
                      ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                          <View style={styles.employeeSelectorRow}>
                            {teamEmployees.map((emp) => {
                              const selected = movementEmployeeId === emp.id;
                              return (
                                <TouchableOpacity
                                  key={emp.id}
                                  style={[styles.catChip, selected && styles.catChipActive]}
                                  onPress={() => setMovementEmployeeId(emp.id)}
                                >
                                  <Text style={[styles.catChipText, selected && styles.catChipTextActive]}>
                                    {emp.name} ({emp.roleLabel})
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </ScrollView>
                      )}
                    </View>
                  )}

                  {movementType === 'expense' && (
                    <>
                      <View style={styles.inputGroup}>
                        <Text style={styles.label}>Comprobante</Text>
                        <View style={styles.categoryPickerRow}>
                          {RECEIPT_TYPE_OPTIONS.map((rt) => (
                            <TouchableOpacity
                              key={rt.id}
                              style={[
                                styles.catChip,
                                movementReceiptType === rt.id && styles.catChipActive,
                              ]}
                              onPress={() => {
                                setMovementReceiptType(rt.id);
                                if (rt.id === 'ninguno') setMovementReceiptNumber('');
                              }}
                            >
                              <Text
                                style={[
                                  styles.catChipText,
                                  movementReceiptType === rt.id && styles.catChipTextActive,
                                ]}
                              >
                                {rt.label}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>

                      {movementReceiptType !== 'ninguno' && (
                        <View style={styles.inputGroup}>
                          <Text style={styles.label}>N.º de Comprobante (opcional)</Text>
                          <TextInput
                            style={styles.input}
                            placeholder="Ej. B001-00142"
                            placeholderTextColor={ui.textMuted}
                            value={movementReceiptNumber}
                            onChangeText={setMovementReceiptNumber}
                          />
                        </View>
                      )}
                    </>
                  )}

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>
                      {movementType === 'income' ? 'Motivo o Descripción' : 'Detalle o Motivo'}
                    </Text>
                    <TextInput
                      style={styles.input}
                      placeholder={
                        movementType === 'income'
                          ? 'Ej. Cambio adicional'
                          : movementCategory === EMPLOYEE_ADVANCE_CATEGORY_ID
                          ? 'Ej. Adelanto quincena'
                          : 'Ej. Compra de bolsas, pasajes, agua'
                      }
                      placeholderTextColor={ui.textMuted}
                      value={movementReason}
                      onChangeText={setMovementReason}
                    />
                  </View>

                  {movementType === 'expense' &&
                    isCashier &&
                    Number(activeCashSession?.cashierExpenseLimit ?? accountExpenseLimit ?? 0) > 0 && (
                      <View style={styles.limitNoticeBox}>
                        <Lock size={14} color={ui.warning} />
                        <Text style={styles.limitNoticeText}>
                          Límite de cajero sin PIN:{' '}
                          {formatPEN(
                            Number(activeCashSession?.cashierExpenseLimit ?? accountExpenseLimit ?? 0)
                          )}
                          . Montos mayores solicitan PIN de autorización.
                        </Text>
                      </View>
                    )}
                </ScrollView>

                <TouchableOpacity
                  style={[styles.primaryButton, isSavingMovement && styles.buttonDisabled]}
                  onPress={handleRegisterMovement}
                  disabled={isSavingMovement}
                >
                  {isSavingMovement ? (
                    <ActivityIndicator color={ui.onPrimary} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Guardar Movimiento</Text>
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      )}

      {pinModalVisible && (
        <Modal
          visible={pinModalVisible}
          transparent
          animationType="fade"
          onRequestClose={handleCancelPin}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Lock size={20} color={ui.warning} />
                    <Text style={styles.modalTitle}>Autorizar Egreso</Text>
                  </View>
                  <TouchableOpacity
                    onPress={handleCancelPin}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar autorización de PIN"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.pinSubtitle}>
                  Este retiro de {formatPEN(pendingPinExpense?.amount ?? 0)} supera el tope permitido
                  para cajeros. Ingresa el PIN de autorización (4 a 8 dígitos).
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>PIN Numérico</Text>
                  <TextInput
                    style={[styles.input, styles.inputPin]}
                    placeholder="••••"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={8}
                    value={pinInput}
                    onChangeText={(txt) => {
                      setPinInput(txt.replace(/\D/g, '').slice(0, 8));
                      if (pinError) setPinError('');
                    }}
                  />
                  {pinError ? <Text style={styles.pinErrorText}>{pinError}</Text> : null}
                </View>

                <View style={styles.pinActionsRow}>
                  <TouchableOpacity
                    style={[styles.secondaryActionButton, { flex: 1 }]}
                    onPress={handleBackToForm}
                    disabled={isAuthorizingPin}
                  >
                    <Text style={styles.secondaryActionText}>Volver</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.primaryButton,
                      { flex: 1.4 },
                      (isAuthorizingPin || pinInput.length < 4) && styles.buttonDisabled,
                    ]}
                    onPress={handleAuthorizeExpenseWithPin}
                    disabled={isAuthorizingPin || pinInput.length < 4}
                  >
                    {isAuthorizingPin ? (
                      <ActivityIndicator color={ui.onPrimary} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Autorizar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      )}
    </>
  );
});
