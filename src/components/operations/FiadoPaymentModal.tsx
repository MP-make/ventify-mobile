import React, { useCallback, useEffect, useState } from 'react';
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
import { X } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import { assertOnlineForWrite } from '@/lib/online-guard';
import {
  getCustomerOpenFiados,
  registerFiadoPayment,
  type CustomerData,
  type OpenFiado,
} from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

const FIADO_PAYMENT_METHODS = [
  { id: 'efectivo', label: 'Efectivo' },
  { id: 'yape', label: 'Yape' },
  { id: 'plin', label: 'Plin' },
  { id: 'tarjeta', label: 'Tarjeta' },
  { id: 'transferencia', label: 'Transf.' },
] as const;

type FiadoPaymentMethod = (typeof FIADO_PAYMENT_METHODS)[number]['id'];

export interface FiadoPaymentModalProps {
  visible: boolean;
  customer: CustomerData | null;
  initialOpenFiados?: OpenFiado[];
  initialSelectedFiado?: OpenFiado | null;
  accountId?: string | null;
  branchId?: string | null;
  activeCashSession: { id?: string; sessionId?: string } | null;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  role?: string | null;
  onClose: () => void;
  onPaymentSuccess: (customerId?: string) => void;
}

export const FiadoPaymentModal = React.memo<FiadoPaymentModalProps>(({
  visible,
  customer,
  initialOpenFiados,
  initialSelectedFiado,
  accountId,
  branchId,
  activeCashSession,
  user,
  userProfile,
  role,
  onClose,
  onPaymentSuccess,
}) => {
  const [openFiados, setOpenFiados] = useState<OpenFiado[]>([]);
  const [selectedFiado, setSelectedFiado] = useState<OpenFiado | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<FiadoPaymentMethod>('efectivo');
  const [paymentNotes, setPaymentNotes] = useState<string>('');
  const [isProcessingPayment, setIsProcessingPayment] = useState<boolean>(false);

  useEffect(() => {
    if (!visible || !customer) return;

    setPaymentMethod('efectivo');
    setPaymentNotes('');
    setIsProcessingPayment(false);

    if (initialOpenFiados) {
      setOpenFiados(initialOpenFiados);
      const chosen =
        initialSelectedFiado ??
        (initialOpenFiados.length === 1 ? initialOpenFiados[0] : null);
      setSelectedFiado(chosen);
      setPaymentAmount(chosen ? String(chosen.remainingAmount) : '');
      return;
    }

    setOpenFiados([]);
    setSelectedFiado(null);
    setPaymentAmount('');

    let cancelled = false;
    getCustomerOpenFiados(accountId || '', customer.id || '')
      .then((records) => {
        if (cancelled) return;
        setOpenFiados(records);
        if (records.length === 1) {
          setSelectedFiado(records[0]);
          setPaymentAmount(String(records[0].remainingAmount));
        }
      })
      .catch((error: any) => {
        if (!cancelled) {
          Alert.alert('Error', error?.message || 'No se pudieron cargar los fiados.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [visible, customer, initialOpenFiados, initialSelectedFiado, accountId]);

  const handleRegisterPayment = useCallback(async () => {
    if (!customer) return;
    const amt = parseFloat(paymentAmount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('Monto Inválido', 'Ingrese un importe mayor a S/ 0.00.');
      return;
    }

    if (amt > (customer.currentDebt || 0)) {
      Alert.alert(
        'Monto Excesivo',
        `El abono no puede superar la deuda actual de ${formatPEN(customer.currentDebt || 0)}.`
      );
      return;
    }
    if (selectedFiado && amt > selectedFiado.remainingAmount) {
      Alert.alert(
        'Monto Excesivo',
        `El abono no puede superar el saldo del fiado seleccionado (${formatPEN(
          selectedFiado.remainingAmount
        )}).`
      );
      return;
    }
    if (openFiados.length > 0 && !selectedFiado) {
      Alert.alert('Seleccione un fiado', 'Elija el fiado al que desea aplicar este abono.');
      return;
    }

    if (!accountId || !branchId || !user) return;

    setIsProcessingPayment(true);
    try {
      await assertOnlineForWrite('registrar un abono de fiado');
      const sessId = activeCashSession?.sessionId || activeCashSession?.id;
      const paymentId = await registerFiadoPayment({
        accountId,
        branchId,
        sessionId: sessId,
        customer: {
          id: customer.id || '',
          name: customer.name,
          currentDebt: customer.currentDebt,
        },
        reservationId: selectedFiado?.id,
        amount: amt,
        paymentMethod,
        notes: paymentNotes.trim() || undefined,
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Operador',
          email: user.email,
          role: role || undefined,
        },
      });

      const paidCustId = customer.id;
      onClose();
      onPaymentSuccess(paidCustId);

      Alert.alert(
        '¡Abono Registrado!',
        `Se descontó ${formatPEN(amt)} de la deuda del cliente con el recibo #${paymentId.slice(-6)}.`
      );
    } catch (err: any) {
      Alert.alert('Error al Registrar Abono', err?.message || 'No se pudo procesar el pago.');
    } finally {
      setIsProcessingPayment(false);
    }
  }, [
    customer,
    paymentAmount,
    selectedFiado,
    openFiados.length,
    accountId,
    branchId,
    user,
    activeCashSession,
    paymentMethod,
    paymentNotes,
    userProfile?.displayName,
    role,
    onClose,
    onPaymentSuccess,
  ]);

  if (!visible || !customer) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!isProcessingPayment) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, styles.modalContentTall90]}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Abonar a Deuda</Text>
                <Text style={styles.modalSub}>{customer.name}</Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  if (!isProcessingPayment) onClose();
                }}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar abono de deuda"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.auditSummaryBox}>
                <Text style={styles.auditLabel}>Deuda Total Pendiente:</Text>
                <Text style={[styles.auditAmount, { color: ui.warning }]}>
                  {formatPEN(customer.currentDebt ?? 0)}
                </Text>
              </View>

              {openFiados.length > 0 && (
                <View style={[styles.inputGroup, { marginTop: 10 }]}>
                  <Text style={styles.label}>Fiado que desea abonar</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {openFiados.map((fiado) => (
                        <TouchableOpacity
                          key={fiado.id}
                          style={[
                            styles.methodChip,
                            selectedFiado?.id === fiado.id && styles.methodChipActive,
                          ]}
                          onPress={() => {
                            setSelectedFiado(fiado);
                            setPaymentAmount(String(fiado.remainingAmount));
                          }}
                        >
                          <Text
                            style={[
                              styles.methodChipText,
                              selectedFiado?.id === fiado.id && styles.methodChipTextActive,
                            ]}
                          >
                            #{fiado.reservationNumber ?? fiado.id.slice(-6)} ·{' '}
                            {formatPEN(fiado.remainingAmount)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              )}

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Monto a Cobrar (S/)</Text>
                <TextInput
                  style={[styles.input, styles.inputAmountLarge]}
                  placeholder="0.00"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="decimal-pad"
                  value={paymentAmount}
                  onChangeText={setPaymentAmount}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Método de Pago</Text>
                <View style={styles.paymentMethodRow}>
                  {FIADO_PAYMENT_METHODS.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      style={[
                        styles.methodChip,
                        paymentMethod === m.id && styles.methodChipActive,
                      ]}
                      onPress={() => setPaymentMethod(m.id)}
                    >
                      <Text
                        style={[
                          styles.methodChipText,
                          paymentMethod === m.id && styles.methodChipTextActive,
                        ]}
                      >
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Notas / Referencia</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej. Recibo manual 0023"
                  placeholderTextColor={ui.textMuted}
                  value={paymentNotes}
                  onChangeText={setPaymentNotes}
                />
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.primaryButton, isProcessingPayment && styles.buttonDisabled]}
              onPress={handleRegisterPayment}
              disabled={isProcessingPayment}
            >
              {isProcessingPayment ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.primaryButtonText}>Registrar Cobro de Abono</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
