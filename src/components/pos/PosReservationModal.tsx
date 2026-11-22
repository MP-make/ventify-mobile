import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { CalendarClock, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { useCashSession } from '@/context/SettingsContext';
import { createReservationOrOrder } from '@/services/crm-operations-service';
import { lookupDocument } from '@/lib/dni-ruc-service';
import { isValidDNI } from '@/lib/invoicing/types';
import { parseNormalizedDecimal } from '@/lib/product-search';
import { reservationCartLines } from '@/lib/presentation-parity';
import { formatPEN, ui } from '@/lib/theme';
import { posStyles as styles } from './posStyles';

interface PosReservationModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (reservationTicket: any) => void;
}

export const PosReservationModal: React.FC<PosReservationModalProps> = React.memo(
  ({ visible, onClose, onCreated }) => {
    const { accountId, branchId, user, userProfile } = useAuthSession();
    const { activeCashSession } = useCashSession();
    const { items, total, totalAmount, clearCart } = useCart();

    const safeTotal = totalAmount ?? total ?? 0;

    const [resCustomerName, setResCustomerName] = useState('');
    const [resCustomerPhone, setResCustomerPhone] = useState('');
    const [resCustomerDoc, setResCustomerDoc] = useState('');
    const [resDepositStr, setResDepositStr] = useState('');
    const [resDepositMethod, setResDepositMethod] = useState<'cash' | 'yape' | 'plin' | 'card'>(
      'cash'
    );
    const [resDays, setResDays] = useState('7');
    const [resNotes, setResNotes] = useState('');
    const [isSavingRes, setIsSavingRes] = useState(false);
    const [isSearchingDni, setIsSearchingDni] = useState(false);

    useEffect(() => {
      if (!visible) return;
      const cleanDni = resCustomerDoc.trim().replace(/\D/g, '');
      if (cleanDni.length === 8 && isValidDNI(cleanDni)) {
        let active = true;
        const timer = setTimeout(() => {
          setIsSearchingDni(true);
          lookupDocument('dni', cleanDni)
            .then((res) => {
              if (active && res && res.name) {
                setResCustomerName(res.name);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (active) setIsSearchingDni(false);
            });
        }, 250);
        return () => {
          active = false;
          clearTimeout(timer);
        };
      }
    }, [visible, resCustomerDoc]);

    const handleConfirmReservation = useCallback(async () => {
      if (!resCustomerName.trim()) {
        Alert.alert('Datos Incompletos', 'Por favor ingresa el nombre del cliente para la reserva.');
        return;
      }
      if (items.length === 0) {
        Alert.alert('Carrito Vacío', 'Agrega productos para reservar.');
        return;
      }

      const depositNum = parseNormalizedDecimal(resDepositStr);
      if (depositNum < 0) {
        Alert.alert('Monto Inválido', 'El adelanto no puede ser negativo.');
        return;
      }
      if (depositNum > safeTotal) {
        Alert.alert('Adelanto Excedido', 'El adelanto no puede ser mayor al total de la reserva.');
        return;
      }

      try {
        if (!accountId || !branchId) throw new Error('No se pudo determinar la cuenta y sucursal.');
        setIsSavingRes(true);
        const days = parseInt(resDays, 10) || 7;
        const pickupDate = new Date();
        pickupDate.setDate(pickupDate.getDate() + days);
        const pad = (n: number) => String(n).padStart(2, '0');
        const pickupDateStr = `${pickupDate.getFullYear()}-${pad(pickupDate.getMonth() + 1)}-${pad(pickupDate.getDate())}`;

        const reservationId = await createReservationOrOrder({
          accountId,
          branchId,
          sessionId: activeCashSession?.sessionId || (activeCashSession as any)?.id,
          type: 'reservation',
          items: reservationCartLines(items),
          total: safeTotal,
          depositAmount: depositNum,
          paymentMethod: depositNum > 0 ? resDepositMethod : 'cash',
          customer: {
            name: resCustomerName.trim(),
            phone: resCustomerPhone.trim() || undefined,
            documentNumber: resCustomerDoc.trim() || undefined,
          },
          pickupDate: pickupDateStr,
          notes: resNotes.trim() || undefined,
          userProfile: {
            uid: user?.uid || 'user_pos',
            displayName: userProfile?.displayName || user?.displayName || 'Vendedor',
            email: user?.email || '',
          },
        });

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        const newResObj = {
          id: reservationId,
          accountId,
          branchId,
          type: 'reservation',
          items: items.map((it) => ({
            productId: it.id,
            productName: it.name,
            quantity: it.quantity,
            price: it.price,
          })),
          total: safeTotal,
          depositAmount: depositNum,
          remainingAmount: Math.max(0, safeTotal - depositNum),
          depositPaymentMethod: depositNum > 0 ? resDepositMethod : undefined,
          status: 'pending',
          customer: {
            name: resCustomerName.trim(),
            phone: resCustomerPhone.trim() || undefined,
            documentNumber: resCustomerDoc.trim() || undefined,
          },
          pickupDate: pickupDateStr,
          notes: resNotes.trim() || undefined,
          createdAt: Date.now(),
        };

        clearCart();
        setResCustomerName('');
        setResCustomerPhone('');
        setResCustomerDoc('');
        setResDepositStr('');
        setResNotes('');
        onCreated(newResObj);
      } catch (err: any) {
        Alert.alert('Error al Reservar', err?.message || 'No se pudo crear la reserva.');
      } finally {
        setIsSavingRes(false);
      }
    }, [
      accountId,
      activeCashSession,
      branchId,
      clearCart,
      items,
      onCreated,
      resCustomerDoc,
      resCustomerName,
      resCustomerPhone,
      resDays,
      resDepositMethod,
      resDepositStr,
      resNotes,
      safeTotal,
      user?.displayName,
      user?.email,
      user?.uid,
      userProfile?.displayName,
    ]);

    return (
      <Modal
        visible={visible}
        animationType="fade"
        transparent
        onRequestClose={onClose}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.subModalOverlay}
        >
          <View style={styles.subModalCard}>
            <View style={styles.subModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <CalendarClock size={18} color={ui.accent} />
                <Text style={styles.subModalTitle}>Crear Reserva</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              <View style={styles.resSummaryCard}>
                <Text style={styles.resSummaryTitle}>
                  {items.length} {items.length === 1 ? 'producto' : 'productos'} · Total:{' '}
                  {formatPEN(safeTotal)}
                </Text>
                <Text style={styles.resSummarySub}>
                  El stock se apartará automáticamente de la sucursal actual.
                </Text>
              </View>

              <Text style={styles.inputLabel}>
                Nombre del Cliente <Text style={{ color: ui.danger }}>*</Text>
              </Text>
              <TextInput
                style={styles.formInput}
                value={resCustomerName}
                onChangeText={setResCustomerName}
                placeholder="Ej. Juan Pérez"
                placeholderTextColor={ui.textMuted}
              />

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Teléfono / WhatsApp</Text>
                  <TextInput
                    style={styles.formInput}
                    value={resCustomerPhone}
                    onChangeText={setResCustomerPhone}
                    placeholder="999 999 999"
                    keyboardType="phone-pad"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text style={styles.inputLabel}>DNI (opcional)</Text>
                    {isSearchingDni && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                        <ActivityIndicator
                          size="small"
                          color={ui.primary}
                          style={{ transform: [{ scale: 0.7 }] }}
                        />
                        <Text style={{ fontSize: 10, color: ui.primary }}>RENIEC...</Text>
                      </View>
                    )}
                  </View>
                  <TextInput
                    style={styles.formInput}
                    value={resCustomerDoc}
                    onChangeText={setResCustomerDoc}
                    placeholder="8 dígitos"
                    keyboardType="numeric"
                    maxLength={8}
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Adelanto / Seña (S/)</Text>
                  <TextInput
                    style={[styles.formInput, { fontWeight: '700', color: ui.primary }]}
                    value={resDepositStr}
                    onChangeText={setResDepositStr}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>Días límite</Text>
                  <TextInput
                    style={styles.formInput}
                    value={resDays}
                    onChangeText={setResDays}
                    placeholder="7"
                    keyboardType="numeric"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>

              {parseFloat(resDepositStr) > 0 && (
                <View style={{ marginTop: 8 }}>
                  <Text style={styles.inputLabel}>Método del Adelanto</Text>
                  <View style={styles.resMethodRow}>
                    {(['cash', 'yape', 'plin', 'card'] as const).map((m) => (
                      <TouchableOpacity
                        key={m}
                        style={[
                          styles.resMethodChip,
                          resDepositMethod === m && styles.resMethodChipActive,
                        ]}
                        onPress={() => setResDepositMethod(m)}
                      >
                        <Text
                          style={[
                            styles.resMethodChipText,
                            resDepositMethod === m && styles.resMethodChipTextActive,
                          ]}
                        >
                          {m === 'cash' ? 'Efectivo' : m === 'card' ? 'Tarjeta' : m.toUpperCase()}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}

              <Text style={styles.inputLabel}>Notas / Observaciones</Text>
              <TextInput
                style={[styles.formInput, { height: 60, textAlignVertical: 'top' }]}
                value={resNotes}
                onChangeText={setResNotes}
                placeholder="Ej. Recoge el fin de semana..."
                placeholderTextColor={ui.textMuted}
                multiline
              />
            </ScrollView>

            <View style={styles.subModalActions}>
              <TouchableOpacity
                style={styles.subModalCancelBtn}
                onPress={onClose}
                disabled={isSavingRes}
              >
                <Text style={styles.subModalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.subModalConfirmBtn, isSavingRes && { opacity: 0.6 }]}
                onPress={handleConfirmReservation}
                disabled={isSavingRes}
              >
                {isSavingRes ? (
                  <ActivityIndicator size="small" color={ui.onPrimary} />
                ) : (
                  <>
                    <CalendarClock size={16} color={ui.onPrimary} />
                    <Text style={styles.subModalConfirmText}>Confirmar Reserva</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }
);
