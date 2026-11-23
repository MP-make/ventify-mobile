import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Check, CheckCircle2, Lock, Printer, X } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import { checkIsOnlineLive } from '@/lib/online-guard';
import { closeCashSession } from '@/services/cash-register-service';
import { processOfflineQueue } from '@/services/offline-sync-service';
import {
  buildCashClosureEscPos,
  printRawEscPos,
  printTicketPDF,
} from '@/services/thermal-printer-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

export interface CloseCashModalProps {
  visible: boolean;
  onClose: () => void;
  accountId?: string | null;
  branchId?: string | null;
  activeCashSession: { id?: string; sessionId?: string } | null;
  expectedCashAmount: number;
  offlinePendingCount: number;
  quarantinedCount?: number;
  isOnline: boolean;
  isSupervisor: boolean;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  onSyncNow?: () => Promise<any>;
  onSyncedOffline: () => void;
  onClosed: (report: any) => void;
}

export const CloseCashModal = React.memo<CloseCashModalProps>(({
  visible,
  onClose,
  accountId,
  branchId,
  activeCashSession,
  expectedCashAmount,
  offlinePendingCount,
  quarantinedCount = 0,
  isOnline,
  isSupervisor,
  user,
  userProfile,
  onSyncNow,
  onSyncedOffline,
  onClosed,
}) => {
  const [countedAmountInput, setCountedAmountInput] = useState<string>('');
  const [closeNotesInput, setCloseNotesInput] = useState<string>('');
  const [isClosingSession, setIsClosingSession] = useState<boolean>(false);
  const wasVisibleRef = useRef<boolean>(false);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      wasVisibleRef.current = true;
      setCountedAmountInput(
        isSupervisor && activeCashSession ? String(expectedCashAmount) : ''
      );
      setCloseNotesInput('');
      setIsClosingSession(false);
    } else if (!visible) {
      wasVisibleRef.current = false;
    }
  }, [visible, isSupervisor, activeCashSession, expectedCashAmount]);

  const calculatedDifference = useMemo(() => {
    const counted = parseFloat(countedAmountInput.replace(',', '.'));
    if (isNaN(counted)) return null;
    return Math.round((counted - expectedCashAmount) * 100) / 100;
  }, [expectedCashAmount, countedAmountInput]);

  const handleCloseCash = useCallback(async () => {
    const online = await checkIsOnlineLive(isOnline);
    if (!online) {
      Alert.alert(
        'Sin Conexión',
        'Conéctate a internet para sincronizar operaciones pendientes y realizar el Cierre Z de caja.'
      );
      return;
    }

    if (quarantinedCount > 0) {
      Alert.alert(
        'Operaciones en Cuarentena',
        `Tienes ${quarantinedCount} venta(s) offline en cuarentena que requieren revisión en Ajustes → Impresora y Modo Offline antes de cerrar caja.`
      );
      return;
    }

    if (offlinePendingCount > 0) {
      const message = `Tienes ${offlinePendingCount} operación(es) offline pendiente(s) de sincronizar en este turno. Sincronízalas antes de cerrar caja para que el arqueo Z sea exacto.`;
      if (accountId) {
        Alert.alert('Operaciones Offline Pendientes', message, [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Sincronizar ahora',
            onPress: async () => {
              setIsClosingSession(true);
              try {
                if (onSyncNow) {
                  await onSyncNow();
                } else {
                  await processOfflineQueue({ accountId, force: true });
                }
                onSyncedOffline();
              } catch (err: any) {
                Alert.alert(
                  'Error de sincronización',
                  err?.message || 'No se pudieron sincronizar las operaciones pendientes.'
                );
              } finally {
                setIsClosingSession(false);
              }
            },
          },
        ]);
      } else {
        Alert.alert('Operaciones Offline Pendientes', message);
      }
      return;
    }

    const counted = parseFloat(countedAmountInput.replace(',', '.'));
    if (isNaN(counted) || counted < 0) {
      Alert.alert('Efectivo Recontado Inválido', 'Ingrese el dinero físico contado en la gaveta.');
      return;
    }

    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !accountId || !branchId || !user) {
      Alert.alert('Error', 'No hay sesión activa para cerrar.');
      return;
    }

    setIsClosingSession(true);
    try {
      const result = await closeCashSession({
        sessionId: sessId,
        accountId,
        branchId,
        countedAmount: counted,
        userId: user.uid,
        userName: userProfile?.displayName || user.email || 'Operador',
        notes: closeNotesInput.trim() || undefined,
      });

      setCountedAmountInput('');
      setCloseNotesInput('');
      onClosed(result);
    } catch (err: any) {
      Alert.alert('Error al Cerrar Caja', err?.message || 'No se pudo completar el Cierre Z.');
    } finally {
      setIsClosingSession(false);
    }
  }, [
    offlinePendingCount,
    quarantinedCount,
    isOnline,
    accountId,
    onSyncNow,
    onSyncedOffline,
    countedAmountInput,
    activeCashSession,
    branchId,
    user,
    userProfile?.displayName,
    closeNotesInput,
    onClosed,
  ]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!isClosingSession) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Arqueo y Cierre Z</Text>
                <Text style={styles.modalSub}>
                  {isSupervisor
                    ? 'Cuadre final de gaveta de efectivo'
                    : 'Arqueo ciego de efectivo en gaveta'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  if (!isClosingSession) onClose();
                }}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar arqueo de caja"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {isSupervisor ? (
              <View style={styles.auditSummaryBox}>
                <Text style={styles.auditLabel}>Efectivo Esperado Según Sistema:</Text>
                <Text style={styles.auditAmount}>{formatPEN(expectedCashAmount)}</Text>
              </View>
            ) : (
              <View style={styles.blindNoticeBox}>
                <Lock size={16} color={ui.primary} />
                <Text style={styles.blindNoticeText}>
                  Arqueo ciego activo: cuenta el efectivo físico de la gaveta e ingresa el total encontrado.
                </Text>
              </View>
            )}

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Efectivo Físico Recontado (Billetes y Monedas S/)</Text>
              <TextInput
                style={[styles.input, styles.inputAmountLarge]}
                placeholder="0.00"
                placeholderTextColor={ui.textMuted}
                keyboardType="decimal-pad"
                value={countedAmountInput}
                onChangeText={setCountedAmountInput}
              />
            </View>

            {isSupervisor && calculatedDifference !== null && (
              <View
                style={[
                  styles.differenceResultBox,
                  {
                    backgroundColor:
                      calculatedDifference >= 0 ? ui.primarySoft : ui.dangerSoft,
                  },
                ]}
              >
                <Text style={styles.diffLabel}>Resultado del Arqueo:</Text>
                <Text
                  style={[
                    styles.diffValue,
                    {
                      color: calculatedDifference >= 0 ? ui.primary : ui.danger,
                    },
                  ]}
                >
                  {calculatedDifference === 0
                    ? 'Cuadre Exacto (S/ 0.00)'
                    : calculatedDifference > 0
                    ? `Sobrante: +${formatPEN(calculatedDifference)}`
                    : `Faltante: ${formatPEN(calculatedDifference)}`}
                </Text>
              </View>
            )}

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Observaciones de Cierre (Opcional)</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline60]}
                placeholder="Comentarios sobre el cuadre..."
                placeholderTextColor={ui.textMuted}
                multiline
                value={closeNotesInput}
                onChangeText={setCloseNotesInput}
              />
            </View>

            <TouchableOpacity
              style={[styles.closeZConfirmButton, isClosingSession && styles.buttonDisabled]}
              onPress={handleCloseCash}
              disabled={isClosingSession}
            >
              {isClosingSession ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Check size={20} color={ui.onPrimary} />
                  <Text style={styles.closeZConfirmButtonText}>Confirmar y Cerrar Turno</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});

export interface ClosureSuccessModalProps {
  report: any | null;
  activeCashSession: any;
  businessSettings: any;
  activeBranch: any;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  onClose: () => void;
}

export const ClosureSuccessModal = React.memo<ClosureSuccessModalProps>(({
  report,
  activeCashSession,
  businessSettings,
  activeBranch,
  user,
  userProfile,
  onClose,
}) => {
  const handlePrintClosureTicket = useCallback(async () => {
    if (!report) return;
    try {
      const sessionData = report.session || activeCashSession;
      const closureDetails = {
        totalIncomes: report.audit?.manualIncomes || 0,
        totalExpenses: report.audit?.manualExpenses || 0,
        expectedAmount: report.expectedAmount ?? report.expectedCash ?? 0,
        countedAmount: report.countedAmount ?? report.countedCash ?? 0,
        difference: report.difference ?? 0,
        closedByName: userProfile?.displayName || user?.email || 'Operador',
        notes: report.notes,
      };

      const bytes = buildCashClosureEscPos(
        sessionData,
        closureDetails,
        { ...businessSettings, ...activeBranch },
        { autoCut: true, openDrawer: true }
      );

      const printed = await printRawEscPos(bytes);
      if (!printed) {
        Alert.alert('Aviso', 'Impresora Bluetooth no conectada. Generando impresión del sistema...');
        await printTicketPDF({
          title: 'Cierre Z',
          htmlContent: `<h2>Cierre de Caja</h2><p>Diferencia: ${formatPEN(report.difference || 0)}</p>`,
        });
      }
    } catch (err: any) {
      Alert.alert('Error al Imprimir', err?.message || 'No se pudo emitir el ticket.');
    }
  }, [report, activeCashSession, businessSettings, activeBranch, userProfile?.displayName, user?.email]);

  if (!report) return null;

  return (
    <Modal
      visible={Boolean(report)}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={{ alignItems: 'center', marginVertical: 12 }}>
              <CheckCircle2 size={48} color={ui.primary} />
              <Text style={[styles.modalTitle, { marginTop: 8 }]}>¡Turno Cerrado con Éxito!</Text>
              <Text style={styles.modalSub}>El reporte de Cierre Z ha sido guardado.</Text>
            </View>

            <TouchableOpacity style={styles.printTicketButton} onPress={handlePrintClosureTicket}>
              <Printer size={20} color={ui.onPrimary} />
              <Text style={styles.printTicketButtonText}>Imprimir Ticket Térmico Z</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryDismissButton} onPress={onClose}>
              <Text style={styles.secondaryDismissText}>Finalizar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
});
