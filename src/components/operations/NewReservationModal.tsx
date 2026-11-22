import React, { useEffect, useMemo, useState } from 'react';
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
import { useProducts } from '@/context/ProductsContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { filterCatalogIndex } from '@/lib/catalog-filters';
import { lookupDocument } from '@/lib/dni-ruc-service';
import { isValidDNI } from '@/lib/invoicing/types';
import { formatPEN, ui } from '@/lib/theme';
import {
  createReservationOrOrder,
  type ReservationOrderItem,
} from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

export interface NewReservationModalProps {
  visible: boolean;
  onClose: () => void;
  accountId?: string | null;
  branchId?: string | null;
  activeCashSession: { id?: string; sessionId?: string } | null;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  role?: string | null;
  onCreated: (ticket: any) => void;
}

export const NewReservationModal = React.memo<NewReservationModalProps>(({
  visible,
  onClose,
  accountId,
  branchId,
  activeCashSession,
  user,
  userProfile,
  role,
  onCreated,
}) => {
  const { catalogIndex } = useProducts();
  const [orderType, setOrderType] = useState<'reservation' | 'order'>('reservation');
  const [orderCustomerName, setOrderCustomerName] = useState<string>('');
  const [orderCustomerPhone, setOrderCustomerPhone] = useState<string>('');
  const [orderCustomerDoc, setOrderCustomerDoc] = useState<string>('');
  const [orderDeposit, setOrderDeposit] = useState<string>('');
  const [orderPaymentMethod] = useState<string>('efectivo');
  const [orderPickupDate, setOrderPickupDate] = useState<string>('');
  const [orderNotes, setOrderNotes] = useState<string>('');
  const [orderItems, setOrderItems] = useState<ReservationOrderItem[]>([]);
  const [isSavingReservation, setIsSavingReservation] = useState<boolean>(false);
  const [isSearchingOrderDni, setIsSearchingOrderDni] = useState<boolean>(false);
  const [productSearchQuery, setProductSearchQuery] = useState<string>('');
  const debouncedProductSearchQuery = useDebouncedValue(productSearchQuery, 150);

  useEffect(() => {
    const cleanDoc = orderCustomerDoc.trim().replace(/\D/g, '');
    if (cleanDoc.length !== 8 || !isValidDNI(cleanDoc)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setIsSearchingOrderDni(true);
      lookupDocument('dni', cleanDoc)
        .then((res) => {
          if (!cancelled && res && res.name) {
            setOrderCustomerName(res.name);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setIsSearchingOrderDni(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderCustomerDoc]);

  const filteredCatalogSuggestions = useMemo(() => {
    const q = debouncedProductSearchQuery.trim();
    if (!q) return [];
    return filterCatalogIndex(catalogIndex, { query: q, limit: 5 });
  }, [catalogIndex, debouncedProductSearchQuery]);

  const handleAddProductToReservation = (prod: any) => {
    setOrderItems((prev) => {
      const existing = prev.find((it) => it.productId === prod.id);
      if (existing) {
        return prev.map((it) =>
          it.productId === prod.id ? { ...it, quantity: it.quantity + 1 } : it
        );
      }
      return [
        ...prev,
        {
          productId: prod.id,
          productName: prod.name,
          sku: prod.sku,
          price: prod.price || prod.suggestedPrice || 0,
          quantity: 1,
          conversionFactor: 1,
        },
      ];
    });
  };

  const handleRemoveItemFromReservation = (pId: string) => {
    setOrderItems((prev) => prev.filter((it) => it.productId !== pId));
  };

  const reservationOrderTotal = useMemo(
    () => orderItems.reduce((acc, it) => acc + it.price * it.quantity, 0),
    [orderItems]
  );

  const handleCreateReservationOrder = async () => {
    if (!orderCustomerName.trim()) {
      Alert.alert(
        'Cliente Requerido',
        'Ingrese el nombre del cliente para el pedido/reserva.'
      );
      return;
    }
    if (orderItems.length === 0) {
      Alert.alert('Productos Requeridos', 'Agregue al menos un producto a la reserva.');
      return;
    }

    const depositVal = parseFloat(orderDeposit.replace(',', '.')) || 0;
    if (depositVal > reservationOrderTotal) {
      Alert.alert('Adelanto Excesivo', 'El adelanto no puede superar el total del pedido.');
      return;
    }

    if (!accountId || !branchId || !user) return;

    setIsSavingReservation(true);
    try {
      const sessId = activeCashSession?.sessionId || activeCashSession?.id;
      const reservationId = await createReservationOrOrder({
        accountId,
        branchId,
        sessionId: sessId,
        type: orderType,
        items: orderItems,
        total: reservationOrderTotal,
        depositAmount: depositVal,
        paymentMethod: orderPaymentMethod,
        customer: {
          name: orderCustomerName.trim(),
          phone: orderCustomerPhone.trim() || undefined,
          documentNumber: orderCustomerDoc.trim() || undefined,
        },
        pickupDate: orderPickupDate.trim() || undefined,
        notes: orderNotes.trim() || undefined,
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Operador',
          email: user.email || undefined,
          role: role || undefined,
        },
      });

      const newResObj = {
        id: reservationId,
        accountId,
        branchId,
        type: orderType,
        items: orderItems.map((it) => ({
          productId: it.productId,
          productName: it.productName,
          quantity: it.quantity,
          price: it.price,
        })),
        total: reservationOrderTotal,
        depositAmount: depositVal,
        remainingAmount: Math.max(0, reservationOrderTotal - depositVal),
        depositPaymentMethod: depositVal > 0 ? orderPaymentMethod : undefined,
        status: 'pending',
        customer: {
          name: orderCustomerName.trim(),
          phone: orderCustomerPhone.trim() || undefined,
          documentNumber: orderCustomerDoc.trim() || undefined,
        },
        pickupDate: orderPickupDate.trim() || undefined,
        notes: orderNotes.trim() || undefined,
        createdAt: Date.now(),
      };

      onCreated(newResObj);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar la reserva.');
    } finally {
      setIsSavingReservation(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!isSavingReservation) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, styles.modalContentTall92]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nueva Reserva / Pedido</Text>
              <TouchableOpacity
                onPress={() => {
                  if (!isSavingReservation) onClose();
                }}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de reserva o pedido"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.docTypeRow}>
                <TouchableOpacity
                  style={[
                    styles.docTypeBtn,
                    orderType === 'reservation' && styles.docTypeBtnActive,
                  ]}
                  onPress={() => setOrderType('reservation')}
                >
                  <Text
                    style={[
                      styles.docTypeText,
                      orderType === 'reservation' && styles.docTypeTextActive,
                    ]}
                  >
                    Reserva (Apartado)
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.docTypeBtn, orderType === 'order' && styles.docTypeBtnActive]}
                  onPress={() => setOrderType('order')}
                >
                  <Text
                    style={[
                      styles.docTypeText,
                      orderType === 'order' && styles.docTypeTextActive,
                    ]}
                  >
                    Pedido con Entrega
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text style={styles.label}>DNI / Doc (opcional)</Text>
                    {isSearchingOrderDni && (
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
                    style={styles.input}
                    placeholder="8 dígitos"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    maxLength={8}
                    value={orderCustomerDoc}
                    onChangeText={setOrderCustomerDoc}
                  />
                </View>

                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>Teléfono</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="987654321"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="phone-pad"
                    value={orderCustomerPhone}
                    onChangeText={setOrderCustomerPhone}
                  />
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Nombre del Cliente</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Nombre completo"
                  placeholderTextColor={ui.textMuted}
                  value={orderCustomerName}
                  onChangeText={setOrderCustomerName}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Seleccionar Productos a Retener</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Buscar en inventario..."
                  placeholderTextColor={ui.textMuted}
                  value={productSearchQuery}
                  onChangeText={setProductSearchQuery}
                />

                {filteredCatalogSuggestions.length > 0 && (
                  <View style={styles.searchProductDropdown}>
                    {filteredCatalogSuggestions.map((p: any) => (
                      <TouchableOpacity
                        key={p.id}
                        style={styles.dropdownItem}
                        onPress={() => {
                          handleAddProductToReservation(p);
                          setProductSearchQuery('');
                        }}
                      >
                        <Text style={styles.dropdownName}>{p.name}</Text>
                        <Text style={styles.dropdownPrice}>
                          {formatPEN(p.price || p.suggestedPrice || 0)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {orderItems.length > 0 && (
                <View style={styles.orderItemsList}>
                  {orderItems.map((it) => (
                    <View
                      key={`${it.id || it.productId || it.productName}-${
                        it.variantId || 'base'
                      }-${it.presentationId || 'base'}`}
                      style={styles.orderItemCard}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.orderItemName}>{it.productName}</Text>
                        <Text style={styles.orderItemSub}>
                          {it.quantity} x {formatPEN(it.price)} ={' '}
                          {formatPEN(it.price * it.quantity)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => {
                          const productId = it.productId || it.id;
                          if (productId) handleRemoveItemFromReservation(productId);
                        }}
                        style={styles.iconButton}
                        accessibilityRole="button"
                        accessibilityLabel={`Quitar ${it.productName} de la reserva`}
                      >
                        <X size={18} color={ui.danger} />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <View style={styles.totalRow}>
                    <Text style={styles.totalText}>TOTAL RESERVA:</Text>
                    <Text style={styles.totalAmount}>{formatPEN(reservationOrderTotal)}</Text>
                  </View>
                </View>
              )}

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Adelanto Pagado Hoy (S/)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="decimal-pad"
                  value={orderDeposit}
                  onChangeText={setOrderDeposit}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Fecha Programada de Entrega / Recojo</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej. Mañana a las 4pm / 15/11/2026"
                  placeholderTextColor={ui.textMuted}
                  value={orderPickupDate}
                  onChangeText={setOrderPickupDate}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Notas Adicionales</Text>
                <TextInput
                  style={[styles.input, styles.inputMultiline60]}
                  placeholder="Detalles sobre empaque, color o indicaciones..."
                  placeholderTextColor={ui.textMuted}
                  multiline
                  value={orderNotes}
                  onChangeText={setOrderNotes}
                />
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.primaryButton, isSavingReservation && styles.buttonDisabled]}
              onPress={handleCreateReservationOrder}
              disabled={isSavingReservation}
            >
              {isSavingReservation ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.primaryButtonText}>Crear y Retener Stock</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
