import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  StyleSheet,
} from 'react-native';
import { CalendarClock, Search, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { useCashSession } from '@/context/SettingsContext';
import {
  createReservationOrOrder,
  getCustomers,
  syncCustomerContactInfo,
} from '@/services/crm-operations-service';
import { sharedRequestCache } from '@/lib/request-cache';
import { lookupDocument } from '@/lib/dni-ruc-service';
import { isValidDNI } from '@/lib/invoicing/types';
import { parseNormalizedDecimal } from '@/lib/product-search';
import { reservationCartLines } from '@/lib/presentation-parity';
import { formatPEN, ui } from '@/lib/theme';
import { assertOnlineForWrite } from '@/lib/online-guard';
import type { Customer } from '@/types';
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
    const [dniLookupMsg, setDniLookupMsg] = useState<string | null>(null);
    const [dniLookupError, setDniLookupError] = useState<string | null>(null);
    const [showCustomerPicker, setShowCustomerPicker] = useState(false);
    const [customerSearchQuery, setCustomerSearchQuery] = useState('');
    const [customersList, setCustomersList] = useState<Customer[]>([]);
    const [loadingCustomers, setLoadingCustomers] = useState(false);
    const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
    const skipDniLookupRef = useRef<string | null>(null);
    const lastAutoLookedUpDniRef = useRef<string>('');
    const lookupAbortRef = useRef<AbortController | null>(null);
    const lookupSeqRef = useRef(0);

    useEffect(() => {
      if (!visible || !showCustomerPicker || !accountId) return;
      let active = true;
      setLoadingCustomers(true);
      sharedRequestCache
        .getOrLoad(`customers:${accountId}`, 180_000, () => getCustomers(accountId))
        .then((list) => {
          if (active) setCustomersList(list || []);
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoadingCustomers(false);
        });
      return () => {
        active = false;
      };
    }, [visible, showCustomerPicker, accountId]);

    const filteredCustomers = useMemo(() => {
      const q = customerSearchQuery.trim().toLowerCase();
      if (!q) return customersList.slice(0, 6);
      return customersList
        .filter((c) => {
          const name = (c.name || '').toLowerCase();
          const doc = (
            c.dni ||
            c.ruc ||
            (c as any).documentNumber ||
            ''
          ).toLowerCase();
          const phone = (c.phone || (c as any).whatsapp || '').toLowerCase();
          return name.includes(q) || doc.includes(q) || phone.includes(q);
        })
        .slice(0, 12);
    }, [customersList, customerSearchQuery]);

    const handleSelectCustomer = useCallback((c: Customer) => {
      setSelectedCustomer(c);
      setResCustomerName(c.name || '');
      const docVal = (c.dni || c.ruc || (c as any).documentNumber || '').trim();
      if (docVal) {
        skipDniLookupRef.current = docVal.replace(/\D/g, '');
      }
      setResCustomerDoc(docVal);
      setResCustomerPhone((c.phone || (c as any).whatsapp || '').trim());
      setCustomerSearchQuery('');
      setShowCustomerPicker(false);
      setDniLookupError(null);
      setDniLookupMsg(`Cliente: ${c.name}`);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    useEffect(() => {
      if (!visible) {
        lookupAbortRef.current?.abort();
        lookupAbortRef.current = null;
        return;
      }
      const cleanDni = resCustomerDoc.trim().replace(/\D/g, '');
      if (cleanDni.length !== 8 || !isValidDNI(cleanDni)) {
        lastAutoLookedUpDniRef.current = '';
        setDniLookupError(null);
        if (cleanDni.length < 8) setDniLookupMsg(null);
        return;
      }
      if (skipDniLookupRef.current && skipDniLookupRef.current === cleanDni) {
        skipDniLookupRef.current = null;
        lastAutoLookedUpDniRef.current = cleanDni;
        return;
      }
      if (lastAutoLookedUpDniRef.current === cleanDni) {
        return;
      }

      const timer = setTimeout(() => {
        lastAutoLookedUpDniRef.current = cleanDni;
        lookupAbortRef.current?.abort();
        const controller = new AbortController();
        lookupAbortRef.current = controller;
        const reqId = ++lookupSeqRef.current;

        setIsSearchingDni(true);
        setDniLookupError(null);
        setDniLookupMsg(null);

        lookupDocument('dni', cleanDni, { signal: controller.signal })
          .then((res) => {
            if (controller.signal.aborted || lookupSeqRef.current !== reqId) {
              if (lastAutoLookedUpDniRef.current === cleanDni) {
                lastAutoLookedUpDniRef.current = '';
              }
              return;
            }
            if (res && res.name) {
              setResCustomerName(res.name);
              setDniLookupMsg(`DNI verificado: ${res.name}`);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          })
          .catch((err: any) => {
            if (
              err?.code === 'ABORTED' ||
              controller.signal.aborted ||
              lookupSeqRef.current !== reqId
            ) {
              if (lastAutoLookedUpDniRef.current === cleanDni) {
                lastAutoLookedUpDniRef.current = '';
              }
              return;
            }
            setDniLookupError(err?.message || 'No se encontró información para este DNI');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          })
          .finally(() => {
            if (lookupSeqRef.current === reqId) {
              setIsSearchingDni(false);
            }
          });
      }, 450);

      return () => {
        clearTimeout(timer);
        lookupAbortRef.current?.abort();
      };
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
        await assertOnlineForWrite('registrar una reserva');
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

        const cleanPhone = resCustomerPhone.trim();
        const cleanDoc = resCustomerDoc.trim();
        const cleanDigits = cleanDoc.replace(/\D/g, '');
        if (cleanPhone) {
          void syncCustomerContactInfo({
            accountId,
            customerId: selectedCustomer?.id,
            name: resCustomerName.trim(),
            documentNumber: cleanDoc || undefined,
            dni: cleanDigits.length === 8 ? cleanDigits : undefined,
            ruc: cleanDigits.length === 11 ? cleanDigits : undefined,
            phone: cleanPhone,
          });
        }

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
        setSelectedCustomer(null);
        setShowCustomerPicker(false);
        setCustomerSearchQuery('');
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
      selectedCustomer?.id,
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

              <View style={localStyles.customerLabelRow}>
                <Text style={styles.inputLabel}>
                  Nombre del Cliente <Text style={{ color: ui.danger }}>*</Text>
                </Text>
                <TouchableOpacity
                  style={localStyles.searchCustomerBtn}
                  onPress={() => {
                    if (showCustomerPicker) setCustomerSearchQuery('');
                    setShowCustomerPicker((prev) => !prev);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={showCustomerPicker ? 'Cerrar búsqueda de clientes' : 'Buscar cliente registrado'}
                >
                  {showCustomerPicker ? (
                    <X size={12} color={ui.primary} />
                  ) : (
                    <Search size={12} color={ui.primary} />
                  )}
                  <Text style={localStyles.searchCustomerBtnText}>
                    {showCustomerPicker ? 'Cerrar' : 'Buscar'}
                  </Text>
                </TouchableOpacity>
              </View>

              {showCustomerPicker ? (
                <View style={localStyles.pickerBox}>
                  <View style={localStyles.pickerSearchRow}>
                    <Search size={14} color={ui.textMuted} />
                    <TextInput
                      style={localStyles.pickerSearchInput}
                      placeholder="Buscar por nombre, DNI o WhatsApp..."
                      placeholderTextColor={ui.textMuted}
                      value={customerSearchQuery}
                      onChangeText={setCustomerSearchQuery}
                      autoCorrect={false}
                      autoFocus
                    />
                    {customerSearchQuery.length > 0 ? (
                      <TouchableOpacity onPress={() => setCustomerSearchQuery('')}>
                        <X size={14} color={ui.textMuted} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  {loadingCustomers ? (
                    <ActivityIndicator size="small" color={ui.primary} style={{ marginVertical: 10 }} />
                  ) : filteredCustomers.length === 0 ? (
                    <Text style={localStyles.pickerEmptyText}>
                      No se encontraron clientes registrados.
                    </Text>
                  ) : (
                    filteredCustomers.map((c) => {
                      const docText = c.ruc
                        ? `RUC: ${c.ruc}`
                        : c.dni
                          ? `DNI: ${c.dni}`
                          : (c as any).documentNumber
                            ? `Doc: ${(c as any).documentNumber}`
                            : 'Sin doc';
                      const phoneText = (c.phone || (c as any).whatsapp || '').trim();
                      return (
                        <TouchableOpacity
                          key={c.id}
                          style={localStyles.pickerItem}
                          onPress={() => handleSelectCustomer(c)}
                        >
                          <Text style={localStyles.pickerItemName} numberOfLines={1}>
                            {c.name}
                          </Text>
                          <Text style={localStyles.pickerItemMeta} numberOfLines={1}>
                            {phoneText ? `${docText} · WhatsApp: ${phoneText}` : docText}
                          </Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </View>
              ) : (
                <>
                  <TextInput
                    style={styles.formInput}
                    value={resCustomerName}
                    onChangeText={(val) => {
                      setResCustomerName(val);
                      if (selectedCustomer && val.trim() !== (selectedCustomer.name || '').trim()) {
                        setSelectedCustomer(null);
                      }
                    }}
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
                        onChangeText={(val) => {
                          setResCustomerDoc(val);
                          if (selectedCustomer) {
                            const prevDoc = (
                              selectedCustomer.dni ||
                              selectedCustomer.ruc ||
                              (selectedCustomer as any).documentNumber ||
                              ''
                            ).trim();
                            if (val.trim() !== prevDoc) setSelectedCustomer(null);
                          }
                        }}
                        placeholder="8 dígitos"
                        keyboardType="numeric"
                        maxLength={8}
                        placeholderTextColor={ui.textMuted}
                      />
                    </View>
                  </View>
                  {dniLookupMsg ? (
                    <Text style={localStyles.lookupSuccess}>{dniLookupMsg}</Text>
                  ) : dniLookupError ? (
                    <Text style={localStyles.lookupError}>{dniLookupError}</Text>
                  ) : null}
                </>
              )}

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

const localStyles = StyleSheet.create({
  customerLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    marginBottom: 4,
  },
  searchCustomerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  searchCustomerBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  pickerBox: {
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    padding: 8,
    marginBottom: 8,
  },
  pickerSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
  },
  pickerSearchInput: {
    flex: 1,
    fontSize: 13,
    color: ui.text,
    paddingVertical: 0,
  },
  pickerEmptyText: {
    fontSize: 12,
    color: ui.textMuted,
    textAlign: 'center',
    paddingVertical: 10,
  },
  pickerItem: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  pickerItemName: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  pickerItemMeta: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  lookupSuccess: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.success,
    marginTop: 4,
    marginBottom: 4,
  },
  lookupError: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.danger,
    marginTop: 4,
    marginBottom: 4,
  },
});
