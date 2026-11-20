import { ReservationCompletionModal } from '@/components/ReservationCompletionModal';
import { ReservationCancellationModal } from '@/components/ReservationCancellationModal';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
  InteractionManager,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import * as Haptics from 'expo-haptics';
import {
  Wallet,
  Users,
  CalendarClock,
  ArrowUpRight,
  ArrowDownRight,
  PlusCircle,
  Search,
  CheckCircle2,
  XCircle,
  Printer,
  Receipt,
  UserCheck,
  AlertCircle,
  Building2,
  Coins,
  CreditCard,
  Smartphone,
  Phone,
  FileText,
  RefreshCw,
  Package,
  Clock,
  ChevronRight,
  Percent,
  Check,
  X,
  Lock,
  Sparkles,
  Send,
  BarChart3,
  RotateCcw,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react-native';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { Header } from '@/components/Header';
import { ui, theme, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDoc,
  query,
  where,
  limit,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';

import {
  openCashSession,
  closeCashSession,
  registerCashMovement,
  subscribeToSessionMovements,
  getActiveCashSession,
  DEFAULT_EXPENSE_CATEGORIES,
  EMPLOYEE_ADVANCE_CATEGORY_ID,
  expenseCategoryLabel,
  cashierNeedsPinAuthorization,
  authorizeCashExpenseViaPin,
  ExpenseCategoryId,
  ExpenseReceiptType,
  CashMovement,
  CashMovementType,
  CashSession,
} from '@/services/cash-register-service';

import {
  getCustomers,
  saveCustomer,
  registerFiadoPayment,
  getReservationsAndOrders,
  createReservationOrOrder,
  approveOrder,
  completeOrCancelReservation,
  getCustomerOpenFiados,
  getCustomerFiadoHistory,
  returnFiadoMerchandise,
  writeOffFiado,
  recalculateCustomerDebt,
  askVentyAI,
  FiadoHistoryEntry,
  OpenFiado,
  CustomerData,
  ReservationOrder,
  ReservationOrderItem,
} from '@/services/crm-operations-service';

import {
  getTeamMembers,
  TeamMember,
} from '@/services/enterprise-ops-service';

import {
  printRawEscPos,
  buildCashClosureEscPos,
  printTicketPDF,
} from '@/services/thermal-printer-service';

import { lookupDocument } from '@/lib/dni-ruc-service';
import { isValidDNI } from '@/lib/invoicing/types';
import { usePermissions } from '@/hooks/usePermissions';
import { PayrollUsersModal } from '@/components/PayrollUsersModal';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';
import { FinancialPnlModal } from '@/components/FinancialPnlModal';
import { mergeSalesWithOfflinePending, computeOfflineCashDelta } from '@/lib/offline-sales-helpers';
import { processOfflineQueue } from '@/services/offline-sync-service';

type OperationsTab = 'cash' | 'crm' | 'orders';

const VENTY_ICON = require('../../assets/venty-icon.webp');
const YAPE_LOGO = require('../../assets/payment/yape.jpeg');
const PLIN_LOGO = require('../../assets/payment/plin.png');
const MASTERCARD_LOGO = require('../../assets/payment/mastercard.webp');
const VENTY_QUICK_CHIPS = [
  '¿Cuánto efectivo hay en caja?',
  '¿Quiénes tienen fiados pendientes?',
  'Resumen de ventas del turno',
] as const;

interface NewReservationModalProps {
  visible: boolean;
  onClose: () => void;
  accountId?: string | null;
  branchId?: string | null;
  activeCashSession: { id?: string; sessionId?: string } | null;
  user: { uid: string; email?: string | null } | null;
  userProfile?: { displayName?: string | null } | null;
  role?: string | null;
  onCreated: (ticket: any) => void;
}

const NewReservationModal = React.memo<NewReservationModalProps>(({
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
  const { products: productCatalog } = useProducts();
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
    const q = productSearchQuery.trim().toLowerCase();
    if (!q) return [];
    return productCatalog.filter((p) => p.name?.toLowerCase().includes(q)).slice(0, 5);
  }, [productCatalog, productSearchQuery]);

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
      Alert.alert('Cliente Requerido', 'Ingrese el nombre del cliente para el pedido/reserva.');
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
          <View style={[styles.modalContent, { maxHeight: '92%' }]}>
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
                  style={[styles.docTypeBtn, orderType === 'reservation' && styles.docTypeBtnActive]}
                  onPress={() => setOrderType('reservation')}
                >
                  <Text style={[styles.docTypeText, orderType === 'reservation' && styles.docTypeTextActive]}>
                    Reserva (Apartado)
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.docTypeBtn, orderType === 'order' && styles.docTypeBtnActive]}
                  onPress={() => setOrderType('order')}
                >
                  <Text style={[styles.docTypeText, orderType === 'order' && styles.docTypeTextActive]}>
                    Pedido con Entrega
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={styles.label}>DNI / Doc (opcional)</Text>
                    {isSearchingOrderDni && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                        <ActivityIndicator size="small" color={ui.primary} style={{ transform: [{ scale: 0.7 }] }} />
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
                    <View key={`${it.id || it.productId || it.productName}-${it.variantId || 'base'}-${it.presentationId || 'base'}`} style={styles.orderItemCard}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.orderItemName}>{it.productName}</Text>
                        <Text style={styles.orderItemSub}>
                          {it.quantity} x {formatPEN(it.price)} = {formatPEN(it.price * it.quantity)}
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
                  style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
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

interface VentyChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  isError?: boolean;
  timestamp: number;
}

const ListGap16 = () => <View style={{ height: 16 }} />;

const SalePaymentBadges = React.memo(({ sale }: { sale: any }) => {
  if (Array.isArray(sale.payments) && sale.payments.length > 0) {
    return (
      <>
        {sale.payments.map((p: any, idx: number) => {
          const cat = (p.category || '').toLowerCase();
          const prov = (p.digitalProvider || '').toLowerCase();
          let label = 'Otro';
          let color: string = ui.textSecondary;
          let bg: string = ui.surfaceMuted;

          if (cat === 'cash') {
            label = 'Efectivo';
            color = '#16A34A';
            bg = '#DCFCE7';
          } else if (cat === 'card') {
            label = 'Tarjeta';
            color = '#2563EB';
            bg = '#EFF6FF';
          } else if (cat === 'credit') {
            label = 'Fiado';
            color = '#EA580C';
            bg = '#FFEDD5';
          } else if (cat === 'digital') {
            if (prov === 'yape') {
              label = 'Yape';
              color = '#7E22CE';
              bg = '#F3E8FF';
            } else if (prov === 'plin') {
              label = 'Plin';
              color = '#0284C7';
              bg = '#E0F2FE';
            } else {
              label = 'Transf.';
              color = '#4F46E5';
              bg = '#EEF2FF';
            }
          }
          return (
            <View key={idx} style={[styles.methodBadgePill, { backgroundColor: bg }]}>
              <Text style={[styles.methodBadgeText, { color }]}>
                {label} {p.amount ? formatPEN(p.amount) : ''}
              </Text>
            </View>
          );
        })}
      </>
    );
  }

  const m = (sale.paymentMethod || '').toLowerCase();
  let label = 'Efectivo';
  let color: string = '#16A34A';
  let bg: string = '#DCFCE7';

  if (m === 'yape') {
    label = 'Yape';
    color = '#7E22CE';
    bg = '#F3E8FF';
  } else if (m === 'plin') {
    label = 'Plin';
    color = '#0284C7';
    bg = '#E0F2FE';
  } else if (m === 'tarjeta' || m === 'card') {
    label = 'Tarjeta';
    color = '#2563EB';
    bg = '#EFF6FF';
  } else if (m === 'transferencia' || m === 'transfer') {
    label = 'Transferencia';
    color = '#4F46E5';
    bg = '#EEF2FF';
  } else if (m === 'fiado' || m === 'credit') {
    label = 'Fiado';
    color = '#EA580C';
    bg = '#FFEDD5';
  }

  return (
    <View style={[styles.methodBadgePill, { backgroundColor: bg }]}>
      <Text style={[styles.methodBadgeText, { color }]}>{label}</Text>
    </View>
  );
});

const CashMovementRow = React.memo(({ movement }: { movement: CashMovement }) => {
  const numericAmt = Number(movement.amount) || 0;
  const isIncome = movement.type ? movement.type === 'income' : numericAmt >= 0;
  const catLabel = expenseCategoryLabel(movement.expenseCategoryId, movement.category);
  const hasReceipt = Boolean(movement.receiptType && movement.receiptType !== 'ninguno');
  return (
    <View style={styles.movementItem}>
      <View
        style={[
          styles.movementBadge,
          { backgroundColor: isIncome ? ui.successSoft : ui.dangerSoft },
        ]}
      >
        {isIncome ? (
          <ArrowUpRight size={16} color={ui.success} />
        ) : (
          <ArrowDownRight size={16} color={ui.danger} />
        )}
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.movementTitle}>{movement.reason || movement.description || 'Movimiento de caja'}</Text>
        <Text style={styles.movementSub}>
          {formatDatePE(movement.createdAt)} • {catLabel} • {movement.createdByName || 'Operador'}
          {hasReceipt
            ? ` • ${String(movement.receiptType).toUpperCase()}${movement.receiptNumber ? ` ${movement.receiptNumber}` : ''}`
            : ''}
        </Text>
      </View>
      <Text
        style={[
          styles.movementAmount,
          { color: isIncome ? ui.success : ui.danger },
        ]}
      >
        {isIncome ? '+' : '-'}{formatPEN(Math.abs(numericAmt))}
      </Text>
    </View>
  );
});

const formatMethodCountLabel = (
  count: number,
  amount: number,
  usingSessionFallback: boolean
): string => {
  if (usingSessionFallback) {
    if (count === 0 && amount > 0) return 'En sesión';
    if (count > 0) return `${count} pend. offline`;
  }
  return `${count} ${count === 1 ? 'venta' : 'ventas'}`;
};

const SessionSaleRow = React.memo(({ sale }: { sale: any }) => {
  const isCancelled = sale.status === 'cancelled';
  const isOfflinePending = Boolean(sale.isOfflinePending || sale.offlineQueued);
  const timeStr = formatDatePE(sale.createdAt || sale.date);
  const saleTitle =
    sale.correlative ||
    (sale.saleNumber
      ? `#VTA-${String(sale.saleNumber).padStart(5, '0')}`
      : sale.documentNumber || '#VTA-00000');
  return (
    <View style={styles.saleItemRow}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={styles.movementTitle}>{saleTitle}</Text>
          {isCancelled && (
            <View style={[styles.methodBadgePill, { backgroundColor: ui.dangerSoft }]}>
              <Text style={[styles.methodBadgeText, { color: ui.danger }]}>Anulada</Text>
            </View>
          )}
          {isOfflinePending && (
            <View style={[styles.methodBadgePill, { backgroundColor: ui.warningSoft }]}>
              <Text style={[styles.methodBadgeText, { color: ui.warning }]}>Pendiente offline</Text>
            </View>
          )}
        </View>
        <Text style={styles.movementSub}>
          {timeStr} • {sale.customerName || 'Cliente Varios'}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
          <SalePaymentBadges sale={sale} />
        </View>
      </View>
      <Text
        style={[
          styles.movementAmount,
          { color: isCancelled ? ui.textMuted : ui.text },
        ]}
      >
        {formatPEN(sale.total || 0)}
      </Text>
    </View>
  );
});

const CustomerCardItem = React.memo(
  ({
    cust,
    onCollectDebt,
    onOpenDetail,
  }: {
    cust: CustomerData;
    onCollectDebt: (cust: CustomerData) => void;
    onOpenDetail: (cust: CustomerData) => void;
  }) => {
    const debt = Number(cust.currentDebt) || 0;
    const credits = Number(cust.credits) || 0;
    const creditLim = Number(cust.maxCreditLimit ?? cust.creditLimit) || 0;
    const debtRatio = creditLim > 0 ? Math.min(1, debt / creditLim) : 0;

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        style={styles.customerCard}
        onPress={() => onOpenDetail(cust)}
        accessibilityRole="button"
        accessibilityLabel={`Ver detalle de ${cust.name}`}
      >
        <View style={styles.customerTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.customerName}>{cust.name}</Text>
            <Text style={styles.customerDoc}>
              {cust.documentType || 'DOC'}: {cust.documentNumber || 'Sin número'}
              {cust.phone ? ` • Tel: ${cust.phone}` : ''}
            </Text>
          </View>

          {debt > 0 ? (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.debtLabel}>DEUDA ACTIVA</Text>
              <Text style={styles.debtValue}>{formatPEN(debt)}</Text>
            </View>
          ) : (
            <View style={styles.cleanDebtBadge}>
              <Text style={styles.cleanDebtText}>AL DÍA</Text>
            </View>
          )}
        </View>

        {credits > 0 && (
          <View style={styles.creditWalletRow}>
            <Coins size={13} color={ui.primary} />
            <Text style={styles.creditWalletText}>
              Créditos a favor: {formatPEN(credits)}
            </Text>
          </View>
        )}

        <View style={styles.creditLineBox}>
          <View style={styles.creditLineLabels}>
            <Text style={styles.creditLineText}>
              Línea: {creditLim > 0 ? formatPEN(creditLim) : 'Sin límite'}
            </Text>
            {creditLim > 0 && (
              <Text style={styles.creditLineText}>
                Uso: {Math.round(debtRatio * 100)}%
              </Text>
            )}
          </View>
          {creditLim > 0 && (
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    width: `${debtRatio * 100}%`,
                    backgroundColor:
                      debtRatio > 0.8
                        ? ui.danger
                        : debtRatio > 0.5
                        ? ui.warning
                        : ui.primary,
                  },
                ]}
              />
            </View>
          )}
        </View>

        <View style={styles.customerActionsRow}>
          <TouchableOpacity
            style={styles.detailButton}
            onPress={() => onOpenDetail(cust)}
          >
            <FileText size={15} color={ui.primary} />
            <Text style={styles.detailButtonText}>Detalle y Fiados</Text>
          </TouchableOpacity>
          {debt > 0 && (
            <TouchableOpacity
              style={[styles.abonoButton, { flex: 1 }]}
              onPress={() => onCollectDebt(cust)}
            >
              <Receipt size={15} color={ui.onPrimary} />
              <Text style={styles.abonoButtonText}>Cobrar Abono</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  }
);

const ReservationCardItem = React.memo(
  ({
    item,
    onViewTicket,
    onCancel,
    onApprove,
    onDeliver,
  }: {
    item: ReservationOrder;
    onViewTicket: (item: ReservationOrder) => void;
    onCancel: (item: ReservationOrder) => void;
    onApprove: (item: ReservationOrder) => void;
    onDeliver: (item: ReservationOrder) => void;
  }) => {
    const isPending = item.status === 'pending' || item.status === 'ready';
    const canDeliver =
      item.type === 'reservation'
        ? isPending
        : item.status === 'approved' || item.status === 'production';
    const canCancel = isPending || item.status === 'approved' || item.status === 'production';
    const isDelivered = item.status === 'completed';
    const isCancelled = item.status === 'cancelled';

    return (
      <View style={styles.reservationCard}>
        <View style={styles.reservationTop}>
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.typeBadge,
                { backgroundColor: item.type === 'order' ? ui.primarySoft : ui.accentSoft },
              ]}
            >
              <Text
                style={[
                  styles.typeBadgeText,
                  { color: item.type === 'order' ? ui.primary : ui.accent },
                ]}
              >
                {item.type === 'order' ? 'PEDIDO' : 'RESERVA'} #{item.id.slice(-6).toUpperCase()}
              </Text>
            </View>

            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: isDelivered
                    ? ui.successSoft
                    : isCancelled
                    ? ui.dangerSoft
                    : ui.warningSoft,
                },
              ]}
            >
              <Text
                style={[
                  styles.statusBadgeText,
                  {
                    color: isDelivered
                      ? ui.success
                      : isCancelled
                      ? ui.danger
                      : ui.warning,
                  },
                ]}
              >
                {isDelivered
                  ? 'ENTREGADO'
                  : isCancelled
                  ? 'CANCELADO'
                  : ['approved', 'production'].includes(item.status)
                  ? 'APROBADO'
                  : 'PENDIENTE'}
              </Text>
            </View>
          </View>

          <Text style={styles.resClientName}>{item.customer?.name || 'Cliente sin nombre'}</Text>
          {item.customer?.phone && (
            <Text style={styles.resClientPhone}>Tel: {item.customer.phone}</Text>
          )}
        </View>

        <View style={styles.resItemsList}>
          {item.items?.map((it, idx) => (
            <View key={idx} style={styles.resItemRow}>
              <Text style={styles.resItemName}>
                • {it.quantity}x {it.productName}
              </Text>
              <Text style={styles.resItemPrice}>
                {formatPEN(it.price * it.quantity)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.resFinancialRow}>
          <View>
            <Text style={styles.resFinLabel}>Total</Text>
            <Text style={styles.resFinValue}>{formatPEN(item.total)}</Text>
          </View>
          <View>
            <Text style={styles.resFinLabel}>Adelanto Pagado</Text>
            <Text style={[styles.resFinValue, { color: ui.success }]}>
              {formatPEN(item.depositAmount || 0)}
            </Text>
          </View>
          <View>
            <Text style={styles.resFinLabel}>Saldo Pendiente</Text>
            <Text style={[styles.resFinValue, { color: ui.warning }]}>
              {formatPEN(item.remainingAmount || 0)}
            </Text>
          </View>
        </View>

        <View style={[styles.resActionRow, { marginTop: 12, flexWrap: 'wrap', gap: 8 }]}>
          <TouchableOpacity
            style={[
              styles.resActionButton,
              { borderColor: ui.border, backgroundColor: ui.surface, flex: 1, minWidth: 100 },
            ]}
            onPress={() => onViewTicket(item)}
            activeOpacity={0.7}
          >
            <FileText size={15} color={ui.primary} />
            <Text style={[styles.resActionText, { color: ui.primary, fontWeight: '700' }]}>
              Ver Ticket
            </Text>
          </TouchableOpacity>

          {canCancel && (
            <TouchableOpacity
              style={[styles.resActionButton, { borderColor: ui.danger, flex: 1, minWidth: 90 }]}
              onPress={() => onCancel(item)}
              activeOpacity={0.7}
            >
              <XCircle size={15} color={ui.danger} />
              <Text style={[styles.resActionText, { color: ui.danger }]}>
                Cancelar
              </Text>
            </TouchableOpacity>
          )}

          {item.type === 'order' && item.status === 'pending' && (
            <TouchableOpacity
              style={[
                styles.resActionButton,
                { backgroundColor: ui.accent, borderColor: ui.accent, flex: 1.2, minWidth: 110 },
              ]}
              onPress={() => onApprove(item)}
              activeOpacity={0.7}
            >
              <CheckCircle2 size={15} color={ui.onPrimary} />
              <Text style={[styles.resActionText, { color: ui.onPrimary, fontWeight: 'bold' }]}>
                Aprobar pedido
              </Text>
            </TouchableOpacity>
          )}

          {canDeliver && (
            <TouchableOpacity
              style={[
                styles.resActionButton,
                { backgroundColor: ui.primary, borderColor: ui.primary, flex: 1.2, minWidth: 110 },
              ]}
              onPress={() => onDeliver(item)}
              activeOpacity={0.7}
            >
              <CheckCircle2 size={15} color={ui.onPrimary} />
              <Text style={[styles.resActionText, { color: ui.onPrimary, fontWeight: 'bold' }]}>
                {item.remainingAmount && item.remainingAmount > 0 ? 'Cobrar y Entregar' : 'Entregar'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }
);

export default function OperationsScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const router = useRouter();
  const { user, userProfile, accountId, branchId, role, setActiveBranchId } = useAuth();
  const {
    canManageUsers,
    canViewAllCashSessions,
    isOwner,
    isAdmin,
    isCashier,
    canManageCustomers,
    canProcessReturn,
    canViewMargins,
    canViewReports,
  } = usePermissions();
  const isSupervisor = isOwner || isAdmin;
  const {
    businessSettings,
    activeBranch,
    branches,
    isCashOpen,
    activeCashSession,
    refreshCashStatus,
    pendingOfflineSales,
    isOnline,
  } = useSettings();

  const [activeTab, setActiveTab] = useState<OperationsTab>('cash');
  const [payrollModalOpen, setPayrollModalOpen] = useState<boolean>(false);
  const [pnlModalOpen, setPnlModalOpen] = useState<boolean>(false);

  // Venty AI Modal con streaming progresivo y control de error/offline
  const [ventyModalVisible, setVentyModalVisible] = useState<boolean>(false);
  const [ventyInput, setVentyInput] = useState<string>('');
  const [ventyLoading, setVentyLoading] = useState<boolean>(false);
  const [ventyError, setVentyError] = useState<string | null>(null);
  const [ventyMessages, setVentyMessages] = useState<VentyChatMessage[]>([
    {
      id: 'venty_welcome',
      sender: 'ai',
      text: '¡Hola! Soy Venty IA. Puedo analizar tu caja actual, ventas, stock crítico o cuentas por cobrar. ¿Qué deseas consultar?',
      timestamp: Date.now(),
    },
  ]);
  const ventyScrollRef = useRef<ScrollView | null>(null);
  const ventyStreamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ventyScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ventyLatestChunkRef = useRef<string>('');
  const ventyLastFlushAtRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (ventyStreamTimerRef.current) clearTimeout(ventyStreamTimerRef.current);
      if (ventyScrollTimerRef.current) clearTimeout(ventyScrollTimerRef.current);
    };
  }, []);

  // Multi-caja para Dueños y Administradores
  const [branchSessions, setBranchSessions] = useState<Record<string, CashSession | null>>({});
  const [loadingBranchSessions, setLoadingBranchSessions] = useState<boolean>(false);

  const fetchBranchSessions = useCallback(async () => {
    if ((role !== 'owner' && role !== 'admin') || !branches || branches.length <= 1) return;
    setLoadingBranchSessions(true);
    try {
      const entries = await Promise.all(
        branches.map(async (b) => {
          const bId = b.id || 'main';
          const sess = await getActiveCashSession(bId, accountId || undefined);
          return [bId, sess] as const;
        })
      );
      setBranchSessions(Object.fromEntries(entries));
    } catch (err) {
      console.warn('[Operations] Error al obtener sesiones multicaja:', err);
    } finally {
      setLoadingBranchSessions(false);
    }
  }, [branches, role, accountId]);

  useEffect(() => {
    if (!isFocused || activeTab !== 'cash') return;
    const task = InteractionManager.runAfterInteractions(() => {
      void fetchBranchSessions();
    });
    return () => task.cancel();
  }, [fetchBranchSessions, isCashOpen, branchId, isFocused, activeTab]);

  const handleSwitchBranchCash = (targetBranchId: string, branchName: string) => {
    setActiveBranchId(targetBranchId);
    refreshCashStatus();
    Alert.alert('Caja Cambiada', `Ahora estás operando en la caja de "${branchName}".`);
  };

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 1: CONTROL DE CAJA Y ARQUEO
  // ============================================================================
  const [openingBalanceInput, setOpeningBalanceInput] = useState<string>('');
  const [openingNotesInput, setOpeningNotesInput] = useState<string>('');
  const [isOpeningSession, setIsOpeningSession] = useState<boolean>(false);

  // Movimientos de caja en vivo
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [loadingMovements, setLoadingMovements] = useState<boolean>(false);

  // Ventas del turno activo en vivo para desglose detallado de pagos
  const [sessionSales, setSessionSales] = useState<any[]>([]);
  const [loadingSessionSales, setLoadingSessionSales] = useState<boolean>(false);
  const [cashSubView, setCashSubView] = useState<'movements' | 'sales'>('movements');

  // Modales de movimiento manual (Ingreso / Egreso)
  const [movementModalVisible, setMovementModalVisible] = useState<boolean>(false);
  const [movementType, setMovementType] = useState<CashMovementType>('expense');
  const [movementAmount, setMovementAmount] = useState<string>('');
  const [movementReason, setMovementReason] = useState<string>('');
  const [movementCategory, setMovementCategory] = useState<string>('other');
  const [movementReceiptType, setMovementReceiptType] = useState<ExpenseReceiptType>('ninguno');
  const [movementReceiptNumber, setMovementReceiptNumber] = useState<string>('');
  const [movementEmployeeId, setMovementEmployeeId] = useState<string>('');
  const [teamEmployees, setTeamEmployees] = useState<TeamMember[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState<boolean>(false);
  const [accountExpenseLimit, setAccountExpenseLimit] = useState<number | undefined>(undefined);
  const [isSavingMovement, setIsSavingMovement] = useState<boolean>(false);

  // Modal de Autorización por PIN (para egresos de cajero que superan cashierExpenseLimit)
  const [pinModalVisible, setPinModalVisible] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [pinError, setPinError] = useState<string>('');
  const [isAuthorizingPin, setIsAuthorizingPin] = useState<boolean>(false);
  const [pendingPinExpense, setPendingPinExpense] = useState<{
    sessionId: string;
    amount: number;
    reason: string;
    expenseCategoryId: ExpenseCategoryId;
    employeeId?: string;
    receiptType?: ExpenseReceiptType;
    receiptNumber?: string;
  } | null>(null);

  // Modal de Cierre de Caja (Corte Z)
  const [closeModalVisible, setCloseModalVisible] = useState<boolean>(false);
  const [countedAmountInput, setCountedAmountInput] = useState<string>('');
  const [closeNotesInput, setCloseNotesInput] = useState<string>('');
  const [isClosingSession, setIsClosingSession] = useState<boolean>(false);
  const [lastClosureReport, setLastClosureReport] = useState<any | null>(null);
  const [closureSuccessModal, setClosureSuccessModal] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 2: CLIENTES Y FIADOS
  // ============================================================================
  const [customers, setCustomers] = useState<CustomerData[]>([]);
  const [customerSearch, setCustomerSearch] = useState<string>('');
  const debouncedCustomerSearch = useDebouncedValue(customerSearch, 150);
  const [customerFilter, setCustomerFilter] = useState<'all' | 'with_debt' | 'no_debt'>('all');
  const [loadingCustomers, setLoadingCustomers] = useState<boolean>(false);
  const hasLoadedCustomersRef = useRef<string | null>(null);
  const hasLoadedReservationsRef = useRef<string | null>(null);
  const teamEmployeesLoadedAccountRef = useRef<string | null>(null);

  // Modal Nuevo Cliente
  const [newCustomerModalVisible, setNewCustomerModalVisible] = useState<boolean>(false);
  const [docType, setDocType] = useState<'DNI' | 'RUC'>('DNI');
  const [docNumber, setDocNumber] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string>('');
  const [customerAddress, setCustomerAddress] = useState<string>('');
  const [creditLimitInput, setCreditLimitInput] = useState<string>('200');
  const [isLookingUpDoc, setIsLookingUpDoc] = useState<boolean>(false);
  const [isSavingCustomer, setIsSavingCustomer] = useState<boolean>(false);

  // Modal Abono de Deuda
  const [paymentModalVisible, setPaymentModalVisible] = useState<boolean>(false);
  const [selectedDebtor, setSelectedDebtor] = useState<CustomerData | null>(null);
  const [openFiados, setOpenFiados] = useState<OpenFiado[]>([]);
  const [selectedFiado, setSelectedFiado] = useState<OpenFiado | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'efectivo' | 'yape' | 'plin' | 'tarjeta' | 'transferencia'>('efectivo');
  const [paymentNotes, setPaymentNotes] = useState<string>('');
  const [isProcessingPayment, setIsProcessingPayment] = useState<boolean>(false);

  // Modal Detalle de Cliente + Devolución / Castigo / Recalcular Deuda
  const [customerDetailModalVisible, setCustomerDetailModalVisible] = useState<boolean>(false);
  const [detailCustomer, setDetailCustomer] = useState<CustomerData | null>(null);
  const [detailOpenFiados, setDetailOpenFiados] = useState<OpenFiado[]>([]);
  const [detailFiadoHistory, setDetailFiadoHistory] = useState<FiadoHistoryEntry[]>([]);
  const [loadingCustomerDetail, setLoadingCustomerDetail] = useState<boolean>(false);
  const [isRecalculatingDebt, setIsRecalculatingDebt] = useState<boolean>(false);

  // Modal Devolver Mercadería de Fiado
  const [returnFiadoTarget, setReturnFiadoTarget] = useState<OpenFiado | null>(null);
  const [returnQtyMap, setReturnQtyMap] = useState<Record<string, string>>({});
  const [returnReasonInput, setReturnReasonInput] = useState<string>('');
  const [isSubmittingFiadoReturn, setIsSubmittingFiadoReturn] = useState<boolean>(false);

  // Modal Castigar Deuda (Write-off Owner/Admin)
  const [writeOffTarget, setWriteOffTarget] = useState<OpenFiado | null>(null);
  const [writeOffReasonInput, setWriteOffReasonInput] = useState<string>('');
  const [writeOffConfirmed, setWriteOffConfirmed] = useState<boolean>(false);
  const [isSubmittingWriteOff, setIsSubmittingWriteOff] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 3: PEDIDOS Y RESERVAS
  // ============================================================================
  const [completionTarget, setCompletionTarget] = useState<ReservationOrder | null>(null);
  const [cancellationTarget, setCancellationTarget] = useState<ReservationOrder | null>(null);
  const [reservations, setReservations] = useState<ReservationOrder[]>([]);
  const [loadingReservations, setLoadingReservations] = useState<boolean>(false);
  const [reservationTypeFilter, setReservationTypeFilter] = useState<'all' | 'reservation' | 'order'>('all');
  const [reservationStatusFilter, setReservationStatusFilter] = useState<'all' | 'pending' | 'completed' | 'cancelled'>('all');

  // Modal Crear Reserva/Pedido
  const [newReservationModalVisible, setNewReservationModalVisible] = useState<boolean>(false);
  const [createdOrderTicket, setCreatedOrderTicket] = useState<any | null>(null);
  const [orderTicketModalOpen, setOrderTicketModalOpen] = useState<boolean>(false);

  // ============================================================================
  // EFECTO: CARGAR MOVIMIENTOS DE CAJA EN VIVO
  // ============================================================================
  useEffect(() => {
    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !isCashOpen) {
      setMovements([]);
      return;
    }
    if (!isFocused || activeTab !== 'cash') return;

    setLoadingMovements(true);
    let cancelled = false;
    let unsubscribeFn: (() => void) | undefined;

    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      unsubscribeFn = subscribeToSessionMovements(sessId, (movs) => {
        if (!cancelled) {
          setMovements(movs);
          setLoadingMovements(false);
        }
      });
    });

    return () => {
      cancelled = true;
      task.cancel();
      if (typeof unsubscribeFn === 'function') {
        unsubscribeFn();
      }
    };
  }, [activeCashSession?.sessionId, activeCashSession?.id, isCashOpen, isFocused, activeTab]);

  // ============================================================================
  // EFECTO: CARGAR VENTAS DEL TURNO EN VIVO (DESGLOSE MULTI-PAGO)
  // ============================================================================
  useEffect(() => {
    if (!isOnline) {
      setLoadingSessionSales(false);
    }
  }, [isOnline]);

  useEffect(() => {
    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !accountId || !isCashOpen) {
      setSessionSales([]);
      setLoadingSessionSales(false);
      return;
    }
    if (!isFocused || activeTab !== 'cash') return;

    setLoadingSessionSales(isOnline);
    let cancelled = false;
    let unsubscribeFn: (() => void) | undefined;

    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      const q = query(
        collection(db, 'sales'),
        where('accountId', '==', accountId),
        where('sessionId', '==', sessId),
        limit(150)
      );

      unsubscribeFn = onSnapshot(
        q,
        (snapshot) => {
          if (cancelled) return;
          const salesList = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
          salesList.sort((a: any, b: any) => {
            const tA = a.createdAt?.toMillis?.() || a.date || 0;
            const tB = b.createdAt?.toMillis?.() || b.date || 0;
            return tB - tA;
          });
          setSessionSales(salesList);
          setLoadingSessionSales(false);
        },
        (err) => {
          if (!cancelled) {
            console.warn('[Operations] Error cargando ventas del turno:', err);
            setLoadingSessionSales(false);
          }
        }
      );
    });

    return () => {
      cancelled = true;
      task.cancel();
      if (unsubscribeFn) {
        unsubscribeFn();
      }
    };
  }, [activeCashSession?.sessionId, activeCashSession?.id, accountId, isCashOpen, isFocused, activeTab, isOnline]);

  const currentSessionId = activeCashSession?.sessionId || activeCashSession?.id || null;

  const offlineCashScope = useMemo(
    () => ({
      accountId,
      branchId,
      sessionId: currentSessionId,
      userId: user?.uid || null,
    }),
    [accountId, branchId, currentSessionId, user?.uid]
  );

  const syncedOfflineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessionSales) {
      if (s?.offlineId) ids.add(String(s.offlineId));
    }
    return ids;
  }, [sessionSales]);

  const mergedSessionSales = useMemo(
    () => mergeSalesWithOfflinePending(sessionSales, pendingOfflineSales, offlineCashScope),
    [sessionSales, pendingOfflineSales, offlineCashScope]
  );

  const offlineCashDelta = useMemo(
    () => computeOfflineCashDelta(pendingOfflineSales, syncedOfflineIds, offlineCashScope),
    [pendingOfflineSales, syncedOfflineIds, offlineCashScope]
  );

  // Desglose de ventas por método de pago calculado en vivo
  const salesBreakdown = useMemo(() => {
    let cash = 0;
    let yape = 0;
    let plin = 0;
    let card = 0;
    let transfer = 0;
    let credit = 0;

    let countCash = 0;
    let countYape = 0;
    let countPlin = 0;
    let countCard = 0;
    let countTransfer = 0;
    let countCredit = 0;
    let usingSessionFallback = false;

    if (sessionSales.length > 0) {
      for (const sale of mergedSessionSales) {
        if (sale.status === 'cancelled') continue;
        const total = sale.total || 0;
        const pMethod = (sale.paymentMethod || '').toLowerCase();

        // Si tiene desglose de pagos múltiples (payments)
        if (Array.isArray(sale.payments) && sale.payments.length > 0) {
          for (const split of sale.payments) {
            const cat = (split.category || '').toLowerCase();
            const amt = split.amount || 0;
            const provider = (split.digitalProvider || '').toLowerCase();

            if (cat === 'cash') {
              cash += amt;
              countCash++;
            } else if (cat === 'card') {
              card += amt;
              countCard++;
            } else if (cat === 'digital') {
              if (provider === 'yape') {
                yape += amt;
                countYape++;
              } else if (provider === 'plin') {
                plin += amt;
                countPlin++;
              } else {
                transfer += amt;
                countTransfer++;
              }
            } else if (cat === 'credit') {
              credit += amt;
              countCredit++;
            }
          }
        } else {
          if (pMethod === 'efectivo' || pMethod === 'cash') {
            cash += total;
            countCash++;
          } else if (pMethod === 'tarjeta' || pMethod === 'card') {
            card += total;
            countCard++;
          } else if (pMethod === 'yape') {
            yape += total;
            countYape++;
          } else if (pMethod === 'plin') {
            plin += total;
            countPlin++;
          } else if (pMethod === 'transferencia' || pMethod === 'transfer') {
            transfer += total;
            countTransfer++;
          } else if (pMethod === 'fiado' || pMethod === 'credit') {
            credit += total;
            countCredit++;
          } else {
            if (sale.cashAmount && sale.cashAmount > 0) {
              cash += sale.cashAmount;
              countCash++;
            }
            if (sale.cardAmount && sale.cardAmount > 0) {
              card += sale.cardAmount;
              countCard++;
            }
            if (sale.digitalAmount && sale.digitalAmount > 0) {
              yape += sale.digitalAmount;
              countYape++;
            }
          }
        }
      }
    } else if (activeCashSession) {
      // Fallback con acumuladores de la sesión si la lista aún está vacía + ventas offline pendientes
      usingSessionFallback = true;
      cash = activeCashSession.cashSales || 0;
      card = activeCashSession.cardSales || 0;
      const dig = (activeCashSession as any).digitalSales;
      if (typeof dig === 'number') {
        yape = dig;
      } else if (typeof dig === 'object' && dig !== null) {
        yape = dig.yape || 0;
        plin = dig.plin || 0;
        transfer = dig.transfer || 0;
        card = dig.card || card;
      }
      credit = (activeCashSession as any).creditSales || 0;

      cash += offlineCashDelta.cash;
      yape += offlineCashDelta.yape;
      plin += offlineCashDelta.plin;
      card += offlineCashDelta.card;
      transfer += offlineCashDelta.transfer;
      credit += offlineCashDelta.credit;

      countCash = offlineCashDelta.counts.cash;
      countYape = offlineCashDelta.counts.yape;
      countPlin = offlineCashDelta.counts.plin;
      countCard = offlineCashDelta.counts.card;
      countTransfer = offlineCashDelta.counts.transfer;
      countCredit = offlineCashDelta.counts.credit;
    }

    const totalDigital = yape + plin + card + transfer;
    const totalAll = cash + totalDigital + credit;

    return {
      cash: Math.round(cash * 100) / 100,
      yape: Math.round(yape * 100) / 100,
      plin: Math.round(plin * 100) / 100,
      card: Math.round(card * 100) / 100,
      transfer: Math.round(transfer * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      totalDigital: Math.round(totalDigital * 100) / 100,
      totalAll: Math.round(totalAll * 100) / 100,
      usingSessionFallback,
      counts: {
        cash: countCash,
        yape: countYape,
        plin: countPlin,
        card: countCard,
        transfer: countTransfer,
        credit: countCredit,
        total: sessionSales.length > 0 ? mergedSessionSales.length : offlineCashDelta.counts.total,
      },
    };
  }, [sessionSales.length, mergedSessionSales, activeCashSession, offlineCashDelta]);

  // ============================================================================
  // EFECTO: CARGAR CLIENTES Y FIADOS
  // ============================================================================
  useEffect(() => {
    hasLoadedCustomersRef.current = null;
    teamEmployeesLoadedAccountRef.current = null;
    setTeamEmployees([]);
  }, [accountId]);

  useEffect(() => {
    hasLoadedReservationsRef.current = null;
  }, [accountId, branchId]);

  const loadCustomersData = useCallback(async () => {
    if (!accountId) return;
    hasLoadedCustomersRef.current = accountId;
    setLoadingCustomers(true);
    try {
      const data = await getCustomers(accountId);
      setCustomers(data);
    } catch (err) {
      hasLoadedCustomersRef.current = null;
      console.error('Error cargando clientes:', err);
    } finally {
      setLoadingCustomers(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (!isFocused || activeTab !== 'crm' || !accountId) return;
    if (hasLoadedCustomersRef.current === accountId) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void loadCustomersData();
    });
    return () => task.cancel();
  }, [isFocused, activeTab, accountId, loadCustomersData]);

  // ============================================================================
  // EFECTO: CARGAR PEDIDOS Y RESERVAS
  // ============================================================================
  const loadReservationsData = useCallback(async () => {
    if (!accountId || !branchId) return;
    const scopeKey = `${accountId}:${branchId}`;
    hasLoadedReservationsRef.current = scopeKey;
    setLoadingReservations(true);
    try {
      const data = await getReservationsAndOrders(accountId, branchId);
      setReservations(data);
    } catch (err) {
      hasLoadedReservationsRef.current = null;
      console.error('Error cargando pedidos y reservas:', err);
    } finally {
      setLoadingReservations(false);
    }
  }, [accountId, branchId]);

  useEffect(() => {
    if (!isFocused || activeTab !== 'orders' || !accountId || !branchId) return;
    const scopeKey = `${accountId}:${branchId}`;
    if (hasLoadedReservationsRef.current === scopeKey) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void loadReservationsData();
    });
    return () => task.cancel();
  }, [isFocused, activeTab, accountId, branchId, loadReservationsData]);

  // ============================================================================
  // EFECTO: CARGAR CONFIGURACIÓN DE GASTOS Y EQUIPO PARA ADELANTOS (DIFERIDO)
  // ============================================================================
  useEffect(() => {
    if (!accountId) {
      setAccountExpenseLimit(undefined);
      return;
    }
    let alive = true;
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
        if (alive) setAccountExpenseLimit(undefined);
      });

    return () => {
      alive = false;
    };
  }, [accountId]);

  useEffect(() => {
    if (
      !accountId ||
      !movementModalVisible ||
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
  }, [accountId, movementModalVisible, movementType, movementCategory]);

  const resetMovementForm = useCallback(() => {
    setMovementAmount('');
    setMovementReason('');
    setMovementCategory('other');
    setMovementReceiptType('ninguno');
    setMovementReceiptNumber('');
    setMovementEmployeeId('');
  }, []);

  // ============================================================================
  // ACCIONES SUB-MÓDULO 1: CAJA Y CIERRE Z
  // ============================================================================
  const handleOpenCash = async () => {
    const cleanInput = openingBalanceInput.trim().replace(',', '.');
    const initialAmt = cleanInput === '' ? 0 : parseFloat(cleanInput);
    if (isNaN(initialAmt) || initialAmt < 0) {
      Alert.alert('Monto Inválido', 'Ingrese un fondo inicial en efectivo válido (mínimo S/ 0.00).');
      return;
    }

    if (!accountId || !branchId || !user) {
      Alert.alert('Error', 'Datos de sesión incompletos para abrir caja.');
      return;
    }

    setIsOpeningSession(true);
    try {
      await openCashSession({
        accountId,
        branchId,
        userId: user.uid,
        userName: userProfile?.displayName || user.email || 'Operador',
        openingBalance: initialAmt,
        notes: openingNotesInput.trim() || undefined,
      });

      setOpeningBalanceInput('');
      setOpeningNotesInput('');
      refreshCashStatus();
      Alert.alert('¡Caja Abierta!', `Se abrió el turno exitosamente con un fondo inicial de ${formatPEN(initialAmt)}.`);
    } catch (err: any) {
      Alert.alert('Error al Abrir Caja', err?.message || 'No se pudo abrir la sesión de caja.');
    } finally {
      setIsOpeningSession(false);
    }
  };

  const handleRegisterMovement = async () => {
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
    const effectiveRole = isCashier ? 'cashier' : role;
    if (isExpense && cashierNeedsPinAuthorization(effectiveRole, -amt, { cashierExpenseLimit: effectiveLimit })) {
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
      setMovementModalVisible(false);
      setPinModalVisible(true);
      return;
    }

    setIsSavingMovement(true);
    try {
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

      resetMovementForm();
      setMovementModalVisible(false);
      refreshCashStatus();
      Alert.alert(
        'Movimiento Registrado',
        `Se registró el ${movementType === 'income' ? 'ingreso' : isAdvance ? 'adelanto' : 'egreso/gasto'} de ${formatPEN(amt)} con éxito.`
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo registrar el movimiento.');
    } finally {
      setIsSavingMovement(false);
    }
  };

  const handleAuthorizeExpenseWithPin = async () => {
    if (!pendingPinExpense) return;
    const cleanPin = pinInput.replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(cleanPin)) {
      setPinError('Ingresa un PIN numérico de 4 a 8 dígitos.');
      return;
    }

    setIsAuthorizingPin(true);
    setPinError('');
    try {
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
      resetMovementForm();
      refreshCashStatus();
      Alert.alert(
        'Egreso Autorizado',
        `Se autorizó y registró el retiro de ${formatPEN(authorizedAmount)} correctamente.`
      );
    } catch (err: any) {
      setPinError(err?.message || 'PIN incorrecto o no se pudo autorizar el egreso.');
    } finally {
      setIsAuthorizingPin(false);
    }
  };

  // Cálculo de arqueo en vivo (incluye efectivo de ventas offline pendientes del turno)
  const expectedCashAmount = useMemo(
    () => Math.round(((activeCashSession?.expectedAmount ?? 0) + offlineCashDelta.cash) * 100) / 100,
    [activeCashSession?.expectedAmount, offlineCashDelta.cash]
  );

  const calculatedDifference = useMemo(() => {
    const counted = parseFloat(countedAmountInput.replace(',', '.'));
    if (isNaN(counted)) return null;
    return Math.round((counted - expectedCashAmount) * 100) / 100;
  }, [expectedCashAmount, countedAmountInput]);

  const handleCloseCash = async () => {
    if (offlineCashDelta.count > 0) {
      const message = `Tienes ${offlineCashDelta.count} venta(s) offline pendientes de sincronizar en este turno. Sincronízalas antes de cerrar caja para que el arqueo Z sea exacto.`;
      if (isOnline && accountId) {
        Alert.alert('Ventas Offline Pendientes', message, [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Sincronizar ahora',
            onPress: async () => {
              setIsClosingSession(true);
              try {
                await processOfflineQueue(accountId);
                refreshCashStatus();
              } catch (err: any) {
                Alert.alert(
                  'Error de sincronización',
                  err?.message || 'No se pudieron sincronizar las ventas pendientes.'
                );
              } finally {
                setIsClosingSession(false);
              }
            },
          },
        ]);
      } else {
        Alert.alert('Ventas Offline Pendientes', message);
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

      setLastClosureReport(result);
      setCloseModalVisible(false);
      setCountedAmountInput('');
      setCloseNotesInput('');
      refreshCashStatus();
      setClosureSuccessModal(true);
    } catch (err: any) {
      Alert.alert('Error al Cerrar Caja', err?.message || 'No se pudo completar el Cierre Z.');
    } finally {
      setIsClosingSession(false);
    }
  };

  const handlePrintClosureTicket = async () => {
    if (!lastClosureReport) return;
    try {
      const sessionData = lastClosureReport.session || activeCashSession;
      const closureDetails = {
        totalIncomes: lastClosureReport.audit?.manualIncomes || 0,
        totalExpenses: lastClosureReport.audit?.manualExpenses || 0,
        expectedAmount: lastClosureReport.expectedAmount ?? lastClosureReport.expectedCash ?? 0,
        countedAmount: lastClosureReport.countedAmount ?? lastClosureReport.countedCash ?? 0,
        difference: lastClosureReport.difference ?? 0,
        closedByName: userProfile?.displayName || user?.email || 'Operador',
        notes: lastClosureReport.notes,
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
        // Generar mediante ticket PDF
        await printTicketPDF({
          title: 'Cierre Z',
          htmlContent: `<h2>Cierre de Caja</h2><p>Diferencia: ${formatPEN(lastClosureReport.difference || 0)}</p>`,
        });
      }
    } catch (err: any) {
      Alert.alert('Error al Imprimir', err?.message || 'No se pudo emitir el ticket.');
    }
  };

  // ============================================================================
  // ACCIONES SUB-MÓDULO 2: CLIENTES Y FIADOS
  // ============================================================================
  const filteredCustomers = useMemo(() => {
    const term = debouncedCustomerSearch.trim().toLowerCase();
    return customers.filter((c) => {
      const debt = Number(c.currentDebt) || 0;
      if (customerFilter === 'with_debt' && debt <= 0) return false;
      if (customerFilter === 'no_debt' && debt > 0) return false;
      if (!term) return true;
      const name = (c.name || '').toLowerCase();
      const docNum = (c.documentNumber || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      return name.includes(term) || docNum.includes(term) || phone.includes(term);
    });
  }, [customers, customerFilter, debouncedCustomerSearch]);

  const displayedCustomers = useMemo(() => {
    return filteredCustomers.slice(0, 30);
  }, [filteredCustomers]);

  const kpisCartera = useMemo(() => {
    let totalDebt = 0;
    let debtorsCount = 0;
    customers.forEach((c) => {
      const debt = Number(c.currentDebt) || 0;
      if (debt > 0) {
        totalDebt += debt;
        debtorsCount += 1;
      }
    });
    return {
      totalDebt: Math.round(totalDebt * 100) / 100,
      debtorsCount,
      totalCustomers: customers.length,
    };
  }, [customers]);

  const handleLookupDoc = async () => {
    if (!docNumber.trim()) {
      Alert.alert('Número Vacío', 'Ingrese el DNI o RUC a consultar.');
      return;
    }

    setIsLookingUpDoc(true);
    try {
      const res = await lookupDocument(docType.toLowerCase() as 'dni' | 'ruc', docNumber.trim());
      if (res && res.name) {
        setCustomerName(res.name);
        if (res.address) {
          setCustomerAddress(res.address);
        }
      } else {
        Alert.alert('No Encontrado', 'No se hallaron datos para este documento en RENIEC/SUNAT.');
      }
    } catch (err: any) {
      Alert.alert('Consulta Fallida', err?.message || 'Error consultando padrón oficial.');
    } finally {
      setIsLookingUpDoc(false);
    }
  };

  const handleSaveCustomer = async () => {
    if (!customerName.trim()) {
      Alert.alert('Nombre Requerido', 'Ingrese la razón social o nombre completo del cliente.');
      return;
    }
    if (!accountId) return;

    const limitVal = parseFloat(creditLimitInput.replace(',', '.'));

    setIsSavingCustomer(true);
    try {
      await saveCustomer({
        accountId,
        name: customerName.trim(),
        documentType: docType,
        documentNumber: docNumber.trim() || undefined,
        phone: customerPhone.trim() || undefined,
        email: customerEmail.trim() || undefined,
        address: customerAddress.trim() || undefined,
        creditLimit: isNaN(limitVal) ? 200 : limitVal,
        currentDebt: 0,
      });

      setNewCustomerModalVisible(false);
      setDocNumber('');
      setCustomerName('');
      setCustomerPhone('');
      setCustomerEmail('');
      setCustomerAddress('');
      setCreditLimitInput('200');
      loadCustomersData();
      Alert.alert('Cliente Guardado', 'El cliente ha sido registrado exitosamente en la cartera.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar el cliente.');
    } finally {
      setIsSavingCustomer(false);
    }
  };

  const handleRegisterPayment = async () => {
    if (!selectedDebtor) return;
    const amt = parseFloat(paymentAmount.replace(',', '.'));
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('Monto Inválido', 'Ingrese un importe mayor a S/ 0.00.');
      return;
    }

    if (amt > (selectedDebtor.currentDebt || 0)) {
      Alert.alert('Monto Excesivo', `El abono no puede superar la deuda actual de ${formatPEN(selectedDebtor.currentDebt || 0)}.`);
      return;
    }
    if (selectedFiado && amt > selectedFiado.remainingAmount) {
      Alert.alert('Monto Excesivo', `El abono no puede superar el saldo del fiado seleccionado (${formatPEN(selectedFiado.remainingAmount)}).`);
      return;
    }
    if (openFiados.length > 0 && !selectedFiado) {
      Alert.alert('Seleccione un fiado', 'Elija el fiado al que desea aplicar este abono.');
      return;
    }

    if (!accountId || !branchId || !user) return;

    setIsProcessingPayment(true);
    try {
      const sessId = activeCashSession?.sessionId || activeCashSession?.id;
      const paymentId = await registerFiadoPayment({
        accountId,
        branchId,
        sessionId: sessId,
        customer: {
          id: selectedDebtor.id || '',
          name: selectedDebtor.name,
          currentDebt: selectedDebtor.currentDebt,
        },
        reservationId: selectedFiado?.id,
        amount: amt,
        paymentMethod,
        notes: paymentNotes.trim() || undefined,
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Operador',
          email: user.email,
          role,
        },
      });

      const paidCustId = selectedDebtor.id;
      setPaymentModalVisible(false);
      setPaymentAmount('');
      setPaymentNotes('');
      setSelectedDebtor(null);
      setSelectedFiado(null);
      setOpenFiados([]);
      if (customerDetailModalVisible && detailCustomer?.id && detailCustomer.id === paidCustId) {
        void loadCustomerDetailData(detailCustomer);
      } else {
        void loadCustomersData();
      }
      refreshCashStatus();

      Alert.alert(
        '¡Abono Registrado!',
        `Se descontó ${formatPEN(amt)} de la deuda del cliente con el recibo #${paymentId.slice(-6)}.`
      );
    } catch (err: any) {
      Alert.alert('Error al Registrar Abono', err?.message || 'No se pudo procesar el pago.');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  // ============================================================================
  // ACCIONES DE DETALLE CRM: FIADOS, DEVOLUCIONES, CASTIGO Y RECÁLCULO
  // ============================================================================
  const loadCustomerDetailData = useCallback(
    async (cust: CustomerData) => {
      if (!accountId || !cust.id) return;
      setLoadingCustomerDetail(true);
      try {
        const [fiados, history, custSnap] = await Promise.all([
          getCustomerOpenFiados(accountId, cust.id),
          getCustomerFiadoHistory(accountId, cust.id),
          getDoc(doc(db, 'customers', cust.id)),
        ]);
        setDetailOpenFiados(fiados);
        setDetailFiadoHistory(history);
        if (custSnap.exists()) {
          const refreshed: CustomerData = { id: custSnap.id, ...(custSnap.data() as any) };
          setDetailCustomer(refreshed);
          setCustomers((prev) => prev.map((c) => (c.id === refreshed.id ? refreshed : c)));
        }
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudieron cargar los detalles del cliente.');
      } finally {
        setLoadingCustomerDetail(false);
      }
    },
    [accountId]
  );

  const handleOpenCustomerDetail = useCallback(
    (cust: CustomerData) => {
      setDetailCustomer(cust);
      setDetailOpenFiados([]);
      setDetailFiadoHistory([]);
      setCustomerDetailModalVisible(true);
      void loadCustomerDetailData(cust);
    },
    [loadCustomerDetailData]
  );

  const handleRecalculateDebt = async () => {
    if (!accountId || !detailCustomer?.id) return;
    setIsRecalculatingDebt(true);
    try {
      const res = await recalculateCustomerDebt(accountId, detailCustomer.id);
      const before = Number((res as any).before ?? res.previousDebt ?? detailCustomer.currentDebt ?? 0);
      const after = Number((res as any).after ?? res.recalculatedDebt ?? before);
      const corrected = typeof (res as any).corrected === 'boolean' ? (res as any).corrected : before !== after;

      setDetailCustomer((prev) => (prev ? { ...prev, currentDebt: after } : prev));
      setCustomers((prev) =>
        prev.map((c) => (c.id === detailCustomer.id ? { ...c, currentDebt: after } : c))
      );
      await loadCustomerDetailData({ ...detailCustomer, currentDebt: after });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert(
        corrected ? 'Deuda Recalculada y Corregida' : 'Deuda Verificada',
        `Saldo anterior: ${formatPEN(before)}\nSaldo actual: ${formatPEN(after)}`
      );
    } catch (err: any) {
      Alert.alert('No se pudo recalcular', err?.message || 'Error al recalcular la deuda del cliente.');
    } finally {
      setIsRecalculatingDebt(false);
    }
  };

  const returnedByProductMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!returnFiadoTarget) return map;
    for (const ret of returnFiadoTarget.returnHistory || []) {
      for (const line of ret.items || []) {
        const pid = String(line.productId || '');
        if (!pid) continue;
        map.set(pid, (map.get(pid) || 0) + (Number(line.quantity) || 0));
      }
    }
    return map;
  }, [returnFiadoTarget]);

  const handleOpenReturnFiado = (fiado: OpenFiado) => {
    setReturnFiadoTarget(fiado);
    setReturnQtyMap({});
    setReturnReasonInput('');
  };

  const handleSubmitReturnFiado = async () => {
    if (!returnFiadoTarget || !accountId || !user) return;

    const itemsPayload: Array<{ productId: string; quantity: number }> = [];
    for (const it of returnFiadoTarget.items || []) {
      const pid = String(it.productId || it.id || '');
      if (!pid) continue;
      const qty = parseFloat((returnQtyMap[pid] || '').replace(',', '.'));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const already = returnedByProductMap.get(pid) || 0;
      const maxQty = Math.max(0, Number(it.quantity || 0) - already);
      if (qty > maxQty) {
        Alert.alert('Cantidad inválida', `Solo puedes devolver hasta ${maxQty} unidad(es) de ${it.productName || it.name || pid}.`);
        return;
      }
      itemsPayload.push({ productId: pid, quantity: qty });
    }

    if (itemsPayload.length === 0) {
      Alert.alert('Cantidad requerida', 'Ingresa la cantidad de al menos un producto a devolver.');
      return;
    }
    if (returnReasonInput.trim().length < 3) {
      Alert.alert('Motivo requerido', 'Indica el motivo de la devolución (mínimo 3 caracteres).');
      return;
    }

    setIsSubmittingFiadoReturn(true);
    try {
      const res = await returnFiadoMerchandise({
        accountId,
        reservationId: returnFiadoTarget.id,
        items: itemsPayload,
        reason: returnReasonInput.trim(),
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Operador',
          email: user.email,
          role,
        },
      });

      setReturnFiadoTarget(null);
      setReturnQtyMap({});
      setReturnReasonInput('');
      if (detailCustomer) {
        await loadCustomerDetailData(detailCustomer);
      } else {
        await loadCustomersData();
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert(
        res.settled ? 'Fiado Liquidado por Devolución' : 'Devolución Registrada',
        res.creditApplied > 0
          ? `Se reingresó el stock (${formatPEN(res.returnAmount)}) y el excedente de ${formatPEN(res.creditApplied)} pasó a créditos del cliente.`
          : `Se reingresó el stock (${formatPEN(res.returnAmount)}). Saldo pendiente del fiado: ${formatPEN(res.remaining)}.`
      );
    } catch (err: any) {
      Alert.alert('No se pudo devolver', err?.message || 'Error al registrar devolución de fiado.');
    } finally {
      setIsSubmittingFiadoReturn(false);
    }
  };

  const handleOpenWriteOff = (fiado: OpenFiado) => {
    setWriteOffTarget(fiado);
    setWriteOffReasonInput('');
    setWriteOffConfirmed(false);
  };

  const handleSubmitWriteOff = async () => {
    if (!writeOffTarget || !accountId || !user) return;
    if (writeOffReasonInput.trim().length < 3) {
      Alert.alert('Motivo requerido', 'Indica por qué se castiga la deuda (mínimo 3 caracteres).');
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
        reservationId: writeOffTarget.id,
        reason: writeOffReasonInput.trim(),
        userProfile: {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Administrador',
          email: user.email,
          role,
        },
      });
      setWriteOffTarget(null);
      setWriteOffReasonInput('');
      setWriteOffConfirmed(false);
      if (detailCustomer) {
        await loadCustomerDetailData(detailCustomer);
      } else {
        await loadCustomersData();
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(
        'Deuda Castigada',
        `Se excluyeron ${formatPEN(res.writeOffAmount)} de la deuda del cliente. Nuevo saldo total: ${formatPEN(res.nextDebt)}.`
      );
    } catch (err: any) {
      Alert.alert('No se pudo castigar', err?.message || 'Error al castigar deuda.');
    } finally {
      setIsSubmittingWriteOff(false);
    }
  };

  // ============================================================================
  // ACCIONES: VENTY IA STREAMING
  // ============================================================================
  const handleSendVentyMessage = async (customText?: string) => {
    const question = (customText ?? ventyInput).trim();
    if (!question || ventyLoading) return;

    setVentyError(null);
    if (!isOnline) {
      setVentyError('Sin conexión a internet. Venty IA necesita conexión activa.');
      return;
    }

    const userMsg: VentyChatMessage = {
      id: `v_u_${Date.now()}`,
      sender: 'user',
      text: question,
      timestamp: Date.now(),
    };
    const streamAiId = `v_ai_${Date.now() + 1}`;
    const placeholderAi: VentyChatMessage = {
      id: streamAiId,
      sender: 'ai',
      text: '',
      timestamp: Date.now(),
    };

    const historyPayload = ventyMessages
      .filter((m) => m.id !== 'venty_welcome' && !m.isError && m.text.trim().length > 0)
      .slice(-8)
      .map((m) => ({
        role: m.sender === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      }));

    setVentyMessages((prev) => [...prev, userMsg, placeholderAi]);
    if (!customText) setVentyInput('');
    setVentyLoading(true);
    ventyLatestChunkRef.current = '';
    ventyLastFlushAtRef.current = 0;
    if (ventyScrollTimerRef.current) clearTimeout(ventyScrollTimerRef.current);
    ventyScrollTimerRef.current = setTimeout(() => {
      ventyScrollRef.current?.scrollToEnd({ animated: true });
      ventyScrollTimerRef.current = null;
    }, 80);

    const flushVentyChunk = (text: string) => {
      ventyLastFlushAtRef.current = Date.now();
      setVentyMessages((prev) =>
        prev.map((m) => (m.id === streamAiId ? { ...m, text } : m))
      );
      ventyScrollRef.current?.scrollToEnd({ animated: false });
    };

    try {
      const finalReply = await askVentyAI({
        question,
        accountId: accountId || undefined,
        branchId: branchId || undefined,
        conversationHistory: historyPayload,
        onChunk: (accumulatedText) => {
          ventyLatestChunkRef.current = accumulatedText;
          const elapsed = Date.now() - ventyLastFlushAtRef.current;
          if (elapsed >= 60) {
            if (ventyStreamTimerRef.current) {
              clearTimeout(ventyStreamTimerRef.current);
              ventyStreamTimerRef.current = null;
            }
            flushVentyChunk(accumulatedText);
          } else if (!ventyStreamTimerRef.current) {
            ventyStreamTimerRef.current = setTimeout(() => {
              ventyStreamTimerRef.current = null;
              flushVentyChunk(ventyLatestChunkRef.current);
            }, 60 - elapsed);
          }
        },
      });

      if (ventyStreamTimerRef.current) {
        clearTimeout(ventyStreamTimerRef.current);
        ventyStreamTimerRef.current = null;
      }

      const resolvedText = finalReply?.trim() || 'No se recibió respuesta de Venty IA.';
      const looksLikeError =
        resolvedText.startsWith('Sin conexión') ||
        resolvedText.startsWith('Venty IA tardó') ||
        resolvedText.startsWith('Venty IA no pudo') ||
        resolvedText.startsWith('No se pudo validar') ||
        resolvedText.startsWith('No se pudo identificar');

      setVentyMessages((prev) =>
        prev.map((m) =>
          m.id === streamAiId ? { ...m, text: resolvedText, isError: looksLikeError } : m
        )
      );
      if (looksLikeError) {
        setVentyError(resolvedText);
      }
    } catch (err: any) {
      if (ventyStreamTimerRef.current) {
        clearTimeout(ventyStreamTimerRef.current);
        ventyStreamTimerRef.current = null;
      }
      const errText = err?.message || 'Ocurrió un error al consultar a Venty IA.';
      setVentyError(errText);
      setVentyMessages((prev) =>
        prev.map((m) => (m.id === streamAiId ? { ...m, text: errText, isError: true } : m))
      );
    } finally {
      if (ventyStreamTimerRef.current) {
        clearTimeout(ventyStreamTimerRef.current);
        ventyStreamTimerRef.current = null;
      }
      setVentyLoading(false);
      if (ventyScrollTimerRef.current) clearTimeout(ventyScrollTimerRef.current);
      ventyScrollTimerRef.current = setTimeout(() => {
        ventyScrollRef.current?.scrollToEnd({ animated: true });
        ventyScrollTimerRef.current = null;
      }, 80);
    }
  };

  // ============================================================================
  // ACCIONES SUB-MÓDULO 3: PEDIDOS Y RESERVAS
  // ============================================================================
  const filteredReservations = useMemo(() => {
    return reservations.filter((r) => {
      if (reservationTypeFilter !== 'all' && r.type !== reservationTypeFilter) return false;
      if (reservationStatusFilter !== 'all') {
        const statusFilterValue = ['approved', 'production'].includes(r.status) ? 'pending' : r.status;
        if (statusFilterValue !== reservationStatusFilter) return false;
      }
      return true;
    });
  }, [reservations, reservationTypeFilter, reservationStatusFilter]);

  const displayedReservations = useMemo(() => {
    return filteredReservations.slice(0, 30);
  }, [filteredReservations]);

  const handleReservationCreated = useCallback((newResObj: any) => {
    setCreatedOrderTicket(newResObj);
    setNewReservationModalVisible(false);
    void loadReservationsData();
    refreshCashStatus();
    setOrderTicketModalOpen(true);
  }, [loadReservationsData, refreshCashStatus]);

  const handleCompleteOrCancelOrder = async (item: ReservationOrder, action: 'complete' | 'cancel') => {
    if (action === 'complete') { setCompletionTarget(item); return; }
    setCancellationTarget(item);
  };

  const confirmReservationCancellation = async (refund: { refundMethod?: string; refundPercent?: number }) => {
    if (!cancellationTarget || !user) return;
    try {
      await completeOrCancelReservation(cancellationTarget, 'cancel', {
        uid: user.uid,
        displayName: userProfile?.displayName || user.email || 'Operador',
        email: user.email,
        role,
      }, {
        sessionId: activeCashSession?.sessionId || activeCashSession?.id,
        ...refund,
      });
      setCancellationTarget(null);
      void loadReservationsData();
      void refreshCashStatus();
    } catch (err) {
      Alert.alert('No se pudo cancelar', err instanceof Error ? err.message : 'Actualiza los datos y vuelve a intentarlo.');
    }
  };
  const handleApproveOrder = useCallback(
    (item: ReservationOrder) => {
      Alert.alert('¿Aprobar pedido?', 'Se reservará el stock de catálogo para iniciar su preparación.', [
        { text: 'Volver', style: 'cancel' },
        {
          text: 'Aprobar',
          onPress: async () => {
            try {
              await approveOrder(item.id);
              await loadReservationsData();
              Alert.alert(
                'Pedido aprobado',
                'El stock quedó reservado y el pedido puede entregarse desde esta pantalla.'
              );
            } catch (error: any) {
              Alert.alert('No se pudo aprobar', error?.message || 'Revisa el stock e inténtalo nuevamente.');
            }
          },
        },
      ]);
    },
    [loadReservationsData]
  );

  const handleViewReservationTicket = useCallback((item: ReservationOrder) => {
    setCreatedOrderTicket(item);
    setOrderTicketModalOpen(true);
  }, []);

  const handleCancelReservationCard = useCallback((item: ReservationOrder) => {
    void handleCompleteOrCancelOrder(item, 'cancel');
  }, []);

  const handleDeliverReservationCard = useCallback((item: ReservationOrder) => {
    void handleCompleteOrCancelOrder(item, 'complete');
  }, []);

  const handleCollectDebt = useCallback(
    (cust: CustomerData) => {
      setSelectedDebtor(cust);
      setSelectedFiado(null);
      setPaymentAmount('');
      getCustomerOpenFiados(accountId || '', cust.id || '')
        .then((records) => {
          setOpenFiados(records);
          if (records.length === 1) {
            setSelectedFiado(records[0]);
            setPaymentAmount(String(records[0].remainingAmount));
          }
        })
        .catch((error) => Alert.alert('Error', error?.message || 'No se pudieron cargar los fiados.'));
      setPaymentModalVisible(true);
    },
    [accountId]
  );

  const listContentContainerStyle = useMemo(
    () => ({ paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 80 }),
    [insets.bottom]
  );

  const movementKeyExtractor = useCallback((item: CashMovement, index: number) => item.id || `mov_${index}`, []);
  const renderMovementItem = useCallback(
    ({ item }: { item: CashMovement }) => <CashMovementRow movement={item} />,
    []
  );

  const sessionSaleKeyExtractor = useCallback((item: any, index: number) => item.id || item.offlineId || `sale_${index}`, []);
  const renderSessionSaleItem = useCallback(
    ({ item }: { item: any }) => <SessionSaleRow sale={item} />,
    []
  );

  const cashListData = useMemo(
    () => (
      cashSubView === 'movements'
        ? (loadingMovements ? [] : movements)
        : (loadingSessionSales ? [] : mergedSessionSales)
    ),
    [cashSubView, loadingMovements, movements, loadingSessionSales, mergedSessionSales]
  );

  const cashKeyExtractor = useCallback(
    (item: any, index: number) => (cashSubView === 'movements' ? movementKeyExtractor(item, index) : sessionSaleKeyExtractor(item, index)),
    [cashSubView, movementKeyExtractor, sessionSaleKeyExtractor]
  );

  const getCashItemType = useCallback(() => cashSubView, [cashSubView]);

  const renderCashItem = useCallback(
    ({ item }: { item: any }) => (
      <View style={styles.cashVirtualRowWrap}>
        {cashSubView === 'movements'
          ? renderMovementItem({ item })
          : renderSessionSaleItem({ item })}
      </View>
    ),
    [cashSubView, renderMovementItem, renderSessionSaleItem]
  );

  const multiCashSectionElement = useMemo(() => {
    if (!((role === 'owner' || role === 'admin') && branches.length > 1)) return null;
    return (
      <View style={styles.card}>
        <View style={styles.multiCashHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
            <Building2 size={20} color={ui.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.cardTitle}>Monitoreo Multi-caja</Text>
            <Text style={styles.cardSubtitle}>
              Supervisión y control de sucursales en tiempo real
            </Text>
          </View>
          <TouchableOpacity
            onPress={fetchBranchSessions}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Recargar estado de sucursales"
          >
            <RefreshCw size={16} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {loadingBranchSessions ? (
          <ActivityIndicator color={ui.primary} style={{ marginVertical: 16 }} />
        ) : (
          <View style={styles.branchesList}>
            {branches.map((b) => {
              const bId = b.id || 'main';
              const isCurrent = bId === branchId;
              const session = branchSessions[bId];
              const isOpen = session?.status === 'open';

              return (
                <View
                  key={bId}
                  style={[
                    styles.branchItemCard,
                    isCurrent && styles.branchItemCardActive,
                  ]}
                >
                  <View style={styles.branchItemTop}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.branchItemName}>{b.name || 'Sucursal'}</Text>
                        {isCurrent ? (
                          <View style={styles.currentBranchBadge}>
                            <Text style={styles.currentBranchBadgeText}>Caja Actual</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.branchItemCode}>
                        {b.address || 'Tienda física'}
                      </Text>
                    </View>

                    <View
                      style={[
                        styles.branchStatusBadge,
                        { backgroundColor: isOpen ? ui.primarySoft : ui.surfaceMuted },
                      ]}
                    >
                      <View
                        style={[
                          styles.branchStatusDot,
                          { backgroundColor: isOpen ? ui.primary : ui.textMuted },
                        ]}
                      />
                      <Text
                        style={[
                          styles.branchStatusBadgeText,
                          { color: isOpen ? ui.primary : ui.textSecondary },
                        ]}
                      >
                        {isOpen ? 'ABIERTA' : 'CERRADA'}
                      </Text>
                    </View>
                  </View>

                  {isOpen && session ? (
                    <View style={styles.branchSessionMetrics}>
                      <View style={styles.branchMetricCol}>
                        <Text style={styles.branchMetricLabel}>Cajero:</Text>
                        <Text style={styles.branchMetricValue} numberOfLines={1}>
                          {session.startedByName || 'Cajero'}
                        </Text>
                      </View>
                      <View style={styles.branchMetricCol}>
                        <Text style={styles.branchMetricLabel}>Apertura:</Text>
                        <Text style={styles.branchMetricValue}>
                          {formatPEN(session.openingBalance || session.initialAmount || 0)}
                        </Text>
                      </View>
                      <View style={styles.branchMetricCol}>
                        <Text style={styles.branchMetricLabel}>Efectivo Actual:</Text>
                        <Text style={[styles.branchMetricValue, { color: ui.primary, fontWeight: '700' }]}>
                          {formatPEN(session.expectedAmount || 0)}
                        </Text>
                      </View>
                    </View>
                  ) : null}

                  {!isCurrent ? (
                    <TouchableOpacity
                      style={styles.switchBranchBtn}
                      onPress={() => handleSwitchBranchCash(bId, b.name || 'Sucursal')}
                      accessibilityRole="button"
                      accessibilityLabel={`Entrar a la caja de ${b.name}`}
                    >
                      <Text style={styles.switchBranchBtnText}>Entrar a esta caja</Text>
                      <ChevronRight size={14} color={ui.primary} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  }, [role, branches, fetchBranchSessions, loadingBranchSessions, branchId, branchSessions]);

  const cashHeaderElement = useMemo(() => (
    <View style={styles.moduleWrapper}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
            <Wallet size={24} color={ui.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>Turno Activo</Text>
              <View style={styles.liveIndicator}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>EN VIVO</Text>
              </View>
            </View>
            <Text style={styles.cardSubtitle}>
              Operador: {activeCashSession?.startedByName || userProfile?.displayName || 'Cajero'}
            </Text>
          </View>
        </View>

        <View style={styles.mainKpiBox}>
          <Text style={styles.mainKpiLabel}>EFECTIVO ESPERADO EN GAVETA</Text>
          <Text style={styles.mainKpiValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
            {formatPEN(expectedCashAmount)}
          </Text>
          <Text style={styles.mainKpiFoot}>
            Apertura: {formatDatePE(activeCashSession?.openedAt || activeCashSession?.openTime)}
          </Text>
        </View>

        <View style={styles.grid2Col}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Fondo Inicial</Text>
            <Text style={styles.statValue}>
              {formatPEN(activeCashSession?.initialAmount || activeCashSession?.openingBalance || 0)}
            </Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Ventas Efectivo</Text>
            <Text style={[styles.statValue, { color: ui.success }]}>
              +{formatPEN(
                salesBreakdown.cash > 0
                  ? salesBreakdown.cash
                  : (activeCashSession?.cashSales ?? 0) +
                      (salesBreakdown.usingSessionFallback ? offlineCashDelta.cash : 0)
              )}
            </Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Ventas Digitales</Text>
            <Text style={[styles.statValue, { color: ui.success }]}>
              {formatPEN(
                salesBreakdown.totalDigital > 0
                  ? salesBreakdown.totalDigital
                  : (typeof activeCashSession?.digitalSales === 'number'
                      ? activeCashSession.digitalSales
                      : 0) +
                      (salesBreakdown.usingSessionFallback ? offlineCashDelta.totalDigital : 0)
              )}
            </Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Ingresos Extra</Text>
            <Text style={[styles.statValue, { color: ui.success }]}>
              +{formatPEN(activeCashSession?.totalIncome ?? 0)}
            </Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Egresos / Gastos</Text>
            <Text style={[styles.statValue, { color: ui.danger }]}>
              -{formatPEN(activeCashSession?.totalExpenses ?? 0)}
            </Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Transacciones</Text>
            <Text style={styles.statValue}>
              {sessionSales.length > 0
                ? mergedSessionSales.length
                : (activeCashSession?.transactionCount ?? movements.length) + offlineCashDelta.count}
            </Text>
          </View>
        </View>

        <View style={styles.paymentBreakdownCard}>
          <View style={styles.paymentBreakdownHeader}>
            <View style={styles.paymentBreakdownTitleWrap}>
              <Coins size={18} color={ui.primary} />
              <Text style={styles.paymentBreakdownTitle} numberOfLines={1}>Desglose por Método de Pago</Text>
            </View>
            <Text style={styles.paymentBreakdownTotal} numberOfLines={1}>
              Total: {formatPEN(salesBreakdown.totalAll)}
            </Text>
          </View>

          <View style={styles.paymentBreakdownGrid}>
            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <View style={[styles.methodIconBadge, { backgroundColor: '#DCFCE7' }]}>
                  <Coins size={13} color="#16A34A" />
                </View>
                <Text style={styles.methodName}>Efectivo</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#16A34A' }]}>{formatPEN(salesBreakdown.cash)}</Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(salesBreakdown.counts.cash, salesBreakdown.cash, salesBreakdown.usingSessionFallback)}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <Image
                  source={YAPE_LOGO}
                  style={styles.methodLogoImg}
                  contentFit="cover"
                />
                <Text style={styles.methodName}>Yape</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#7E22CE' }]}>{formatPEN(salesBreakdown.yape)}</Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(salesBreakdown.counts.yape, salesBreakdown.yape, salesBreakdown.usingSessionFallback)}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <Image
                  source={PLIN_LOGO}
                  style={styles.methodLogoImg}
                  contentFit="cover"
                />
                <Text style={styles.methodName}>Plin</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#0284C7' }]}>{formatPEN(salesBreakdown.plin)}</Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(salesBreakdown.counts.plin, salesBreakdown.plin, salesBreakdown.usingSessionFallback)}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <Image
                  source={MASTERCARD_LOGO}
                  style={styles.methodLogoImg}
                  contentFit="contain"
                />
                <Text style={styles.methodName}>Tarjeta</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#2563EB' }]}>{formatPEN(salesBreakdown.card)}</Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(salesBreakdown.counts.card, salesBreakdown.card, salesBreakdown.usingSessionFallback)}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <View style={[styles.methodIconBadge, { backgroundColor: '#EEF2FF' }]}>
                  <Building2 size={13} color="#4F46E5" />
                </View>
                <Text style={styles.methodName}>Transferencia</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#4F46E5' }]}>{formatPEN(salesBreakdown.transfer)}</Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(salesBreakdown.counts.transfer, salesBreakdown.transfer, salesBreakdown.usingSessionFallback)}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <View style={[styles.methodIconBadge, { backgroundColor: '#FFEDD5' }]}>
                  <FileText size={13} color="#EA580C" />
                </View>
                <Text style={styles.methodName}>Fiado / Crédito</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#EA580C' }]}>{formatPEN(salesBreakdown.credit)}</Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(salesBreakdown.counts.credit, salesBreakdown.credit, salesBreakdown.usingSessionFallback)}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.actionButtonGroup}>
          <TouchableOpacity
            style={[styles.outlineActionButton, { borderColor: ui.primary }]}
            onPress={() => {
              resetMovementForm();
              setMovementType('income');
              setMovementCategory('manual_income');
              setMovementModalVisible(true);
            }}
          >
            <ArrowUpRight size={18} color={ui.success} />
            <Text style={[styles.outlineActionText, { color: ui.success }]}>
              + Ingreso Manual
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.outlineActionButton, { borderColor: ui.danger }]}
            onPress={() => {
              resetMovementForm();
              setMovementType('expense');
              setMovementCategory('other');
              setMovementModalVisible(true);
            }}
          >
            <ArrowDownRight size={18} color={ui.danger} />
            <Text style={[styles.outlineActionText, { color: ui.danger }]}>
              - Registrar Gasto
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.closeZButton}
          onPress={() => {
            setCountedAmountInput(
              isSupervisor && activeCashSession ? String(expectedCashAmount) : ''
            );
            setCloseNotesInput('');
            setCloseModalVisible(true);
          }}
        >
          <Receipt size={20} color={ui.onPrimary} />
          <Text style={styles.closeZButtonText}>Arqueo y Cierre Z del Turno</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.cashListHeaderCard}>
        <View style={styles.cashSubTabSelector}>
          <TouchableOpacity
            style={[styles.cashSubTabBtn, cashSubView === 'movements' && styles.cashSubTabBtnActive]}
            onPress={() => setCashSubView('movements')}
          >
            <Receipt size={16} color={cashSubView === 'movements' ? ui.primary : ui.textSecondary} />
            <Text style={[styles.cashSubTabText, cashSubView === 'movements' && styles.cashSubTabTextActive]}>
              Movimientos ({movements.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.cashSubTabBtn, cashSubView === 'sales' && styles.cashSubTabBtnActive]}
            onPress={() => setCashSubView('sales')}
          >
            <Coins size={16} color={cashSubView === 'sales' ? ui.primary : ui.textSecondary} />
            <Text style={[styles.cashSubTabText, cashSubView === 'sales' && styles.cashSubTabTextActive]}>
              Ventas del Turno ({mergedSessionSales.length})
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  ), [
    activeCashSession,
    expectedCashAmount,
    offlineCashDelta.cash,
    offlineCashDelta.totalDigital,
    offlineCashDelta.count,
    userProfile?.displayName,
    salesBreakdown,
    sessionSales.length,
    mergedSessionSales.length,
    movements.length,
    resetMovementForm,
    isSupervisor,
    cashSubView,
  ]);

  const cashEmptyElement = useMemo(() => (
    <View style={styles.cashVirtualEmptyCard}>
      {cashSubView === 'movements' ? (
        loadingMovements ? (
          <ActivityIndicator color={ui.primary} style={{ marginVertical: 20 }} />
        ) : (
          <View style={styles.emptyContainer}>
            <Receipt size={32} color={ui.textMuted} />
            <Text style={styles.emptyText}>No hay movimientos registrados en este turno.</Text>
          </View>
        )
      ) : loadingSessionSales ? (
        <ActivityIndicator color={ui.primary} style={{ marginVertical: 20 }} />
      ) : (
        <View style={styles.emptyContainer}>
          <Coins size={32} color={ui.textMuted} />
          <Text style={styles.emptyText}>No hay ventas realizadas en este turno todavía.</Text>
        </View>
      )}
    </View>
  ), [cashSubView, loadingMovements, loadingSessionSales]);

  const cashFooterElement = useMemo(() => (
    <View style={{ gap: 16 }}>
      {cashListData.length > 0 && <View style={styles.cashVirtualFooterCap} />}
      {multiCashSectionElement}
    </View>
  ), [cashListData.length, multiCashSectionElement]);

  const customerKeyExtractor = useCallback((item: CustomerData, index: number) => item.id || `cust_${index}`, []);
  const getCustomerItemType = useCallback(
    (item: CustomerData) => ((Number(item.currentDebt) || 0) > 0 ? 'debtor' : 'clear'),
    []
  );
  const renderCustomerItem = useCallback(
    ({ item }: { item: CustomerData }) => (
      <CustomerCardItem
        cust={item}
        onCollectDebt={handleCollectDebt}
        onOpenDetail={handleOpenCustomerDetail}
      />
    ),
    [handleCollectDebt, handleOpenCustomerDetail]
  );

  const reservationKeyExtractor = useCallback(
    (item: ReservationOrder, index: number) => item.id || `res_${index}`,
    []
  );
  const getReservationItemType = useCallback(
    (item: ReservationOrder) =>
      item.status === 'pending' || item.status === 'approved' || item.status === 'production'
        ? 'pending'
        : 'settled',
    []
  );
  const renderReservationItem = useCallback(
    ({ item }: { item: ReservationOrder }) => (
      <ReservationCardItem
        item={item}
        onViewTicket={handleViewReservationTicket}
        onCancel={handleCancelReservationCard}
        onApprove={handleApproveOrder}
        onDeliver={handleDeliverReservationCard}
      />
    ),
    [
      handleViewReservationTicket,
      handleCancelReservationCard,
      handleApproveOrder,
      handleDeliverReservationCard,
    ]
  );

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <View style={styles.screen}>
      <Header />

      <View style={styles.compactHeaderRow}>
        <Text style={styles.compactHeaderTitle}>
          {activeTab === 'cash' ? 'Caja' : activeTab === 'crm' ? 'Clientes' : 'Pedidos'}
        </Text>
        <View style={styles.compactHeaderActions}>
          <TouchableOpacity
            style={styles.compactTeamButton}
            onPress={() => setVentyModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir asistente Venty IA"
          >
            <Image
              source={VENTY_ICON}
              style={styles.ventyBtnIcon}
              contentFit="contain"
            />
            <Text style={styles.compactTeamButtonText}>Venty IA</Text>
          </TouchableOpacity>
          {(canViewMargins || canViewReports) ? (
            <TouchableOpacity
              style={styles.compactTeamButton}
              onPress={() => setPnlModalOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Abrir reporte de ganancias y resultados"
            >
              <BarChart3 size={16} color={ui.primary} />
              <Text style={styles.compactTeamButtonText}>Ganancias</Text>
            </TouchableOpacity>
          ) : null}
          {canManageUsers ? (
            <TouchableOpacity
              style={styles.compactTeamButton}
              onPress={() => setPayrollModalOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Abrir equipo y planilla"
            >
              <UserCheck size={16} color={ui.primary} />
              <Text style={styles.compactTeamButtonText}>Equipo</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Navegación entre áreas de operación centrada */}
      <View style={styles.centeredTabsContainer}>
        <TouchableOpacity
          style={[styles.centeredTabButton, activeTab === 'cash' && styles.centeredTabButtonActive]}
          onPress={() => setActiveTab('cash')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'cash' }}
          accessibilityLabel="Caja"
        >
          <Wallet size={17} color={activeTab === 'cash' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.centeredTabText, activeTab === 'cash' && styles.centeredTabTextActive]}>
            Caja
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.centeredTabButton, activeTab === 'crm' && styles.centeredTabButtonActive]}
          onPress={() => setActiveTab('crm')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'crm' }}
          accessibilityLabel="Clientes"
        >
          <Users size={17} color={activeTab === 'crm' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.centeredTabText, activeTab === 'crm' && styles.centeredTabTextActive]}>
            Clientes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.centeredTabButton, activeTab === 'orders' && styles.centeredTabButtonActive]}
          onPress={() => setActiveTab('orders')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'orders' }}
          accessibilityLabel="Pedidos"
        >
          <CalendarClock size={17} color={activeTab === 'orders' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.centeredTabText, activeTab === 'orders' && styles.centeredTabTextActive]}>
            Pedidos
          </Text>
        </TouchableOpacity>
      </View>

        {/* ==================================================================== */}
        {/* SUB-MÓDULO 1: CONTROL DE CAJA Y ARQUEO */}
        {/* ==================================================================== */}
        {activeTab === 'cash' && (
          !isCashOpen ? (
            <ScrollView
              style={styles.contentContainer}
              contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.moduleWrapper}>
                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={[styles.iconBadge, { backgroundColor: ui.warningSoft }]}>
                      <Coins size={24} color={ui.warning} />
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.cardTitle}>Caja Cerrada</Text>
                      <Text style={styles.cardSubtitle}>
                        {activeBranch?.name || 'Tienda Principal'} — Turno sin iniciar
                      </Text>
                    </View>
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Fondo Inicial en Efectivo (S/)</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="0.00"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="decimal-pad"
                      value={openingBalanceInput}
                      onChangeText={setOpeningBalanceInput}
                    />
                    <Text style={styles.helperText}>
                      Ingrese el dinero en efectivo que hay en la gaveta para dar vuelto.
                    </Text>
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Notas de Apertura (Opcional)</Text>
                    <TextInput
                      style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
                      placeholder="Ej. Billetes de S/10 y monedas"
                      placeholderTextColor={ui.textMuted}
                      multiline
                      value={openingNotesInput}
                      onChangeText={setOpeningNotesInput}
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryButton, isOpeningSession && styles.buttonDisabled]}
                    onPress={handleOpenCash}
                    disabled={isOpeningSession}
                  >
                    {isOpeningSession ? (
                      <ActivityIndicator color={ui.onPrimary} />
                    ) : (
                      <>
                        <CheckCircle2 size={20} color={ui.onPrimary} />
                        <Text style={styles.primaryButtonText}>Abrir Turno de Caja</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {multiCashSectionElement}
              </View>
            </ScrollView>
          ) : (
            <View style={{ flex: 1 }}>
              <FlashList
                data={cashListData}
                renderItem={renderCashItem}
                keyExtractor={cashKeyExtractor}
                getItemType={getCashItemType}
                estimatedItemSize={76}
                contentContainerStyle={listContentContainerStyle}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                ListHeaderComponent={cashHeaderElement}
                ListEmptyComponent={cashEmptyElement}
                ListFooterComponent={cashFooterElement}
              />
            </View>
          )
        )}

        {/* ==================================================================== */}
        {/* SUB-MÓDULO 2: CLIENTES Y FIADOS */}
        {/* ==================================================================== */}
        {activeTab === 'crm' && (
          <View style={{ flex: 1 }}>
            <FlashList
              data={loadingCustomers ? [] : displayedCustomers}
              renderItem={renderCustomerItem}
              keyExtractor={customerKeyExtractor}
              getItemType={getCustomerItemType}
              estimatedItemSize={155}
              contentContainerStyle={listContentContainerStyle}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={ListGap16}
              ListHeaderComponent={
                <View style={[styles.moduleWrapper, { marginBottom: 16 }]}>
            <SectionHeading title="Cartera de clientes" subtitle="Saldos pendientes y directorio" />
            {/* KPIs de Cartera */}
            <View style={styles.kpiRow}>
              <View style={[styles.kpiCard, { borderColor: ui.warning }]}>
                <Text style={styles.kpiLabel}>TOTAL POR COBRAR</Text>
                <Text style={[styles.kpiValue, { color: ui.warning }]}>
                  {formatPEN(kpisCartera.totalDebt)}
                </Text>
                <Text style={styles.kpiSub}>{kpisCartera.debtorsCount} clientes con deuda</Text>
              </View>

              <View style={[styles.kpiCard, { borderColor: ui.primary }]}>
                <Text style={styles.kpiLabel}>DIRECTORIO</Text>
                <Text style={[styles.kpiValue, { color: ui.primary }]}>
                  {kpisCartera.totalCustomers}
                </Text>
                <Text style={styles.kpiSub}>Clientes registrados</Text>
              </View>
            </View>

            {/* Buscador y Filtro */}
            <View style={styles.searchRow}>
              <View style={styles.searchBox}>
                <Search size={18} color={ui.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Nombre, DNI o RUC"
                  placeholderTextColor={ui.textMuted}
                  value={customerSearch}
                  accessibilityLabel="Buscar cliente por nombre, DNI o RUC"
                  onChangeText={(text) => {
                    setCustomerSearch(text);
                  }}
                />
                {customerSearch.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setCustomerSearch('')}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Borrar búsqueda de clientes"
                  >
                    <X size={16} color={ui.textMuted} />
                  </TouchableOpacity>
                )}
              </View>

              <TouchableOpacity
                style={styles.iconAddButton}
                onPress={() => setNewCustomerModalVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Agregar cliente"
              >
                <PlusCircle size={22} color={ui.onPrimary} />
              </TouchableOpacity>
            </View>

            {/* Chips de Filtro */}
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.filterChip, customerFilter === 'all' && styles.filterChipActive]}
                onPress={() => setCustomerFilter('all')}
                accessibilityRole="button"
                accessibilityState={{ selected: customerFilter === 'all' }}
                accessibilityLabel="Ver todos los clientes"
              >
                <Text style={[styles.filterChipText, customerFilter === 'all' && styles.filterChipTextActive]}>
                  Todos ({customers.length})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.filterChip, customerFilter === 'with_debt' && styles.filterChipActive]}
                onPress={() => setCustomerFilter('with_debt')}
                accessibilityRole="button"
                accessibilityState={{ selected: customerFilter === 'with_debt' }}
                accessibilityLabel="Ver clientes con deuda"
              >
                <Text style={[styles.filterChipText, customerFilter === 'with_debt' && styles.filterChipTextActive]}>
                  Con Deuda ({kpisCartera.debtorsCount})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.filterChip, customerFilter === 'no_debt' && styles.filterChipActive]}
                onPress={() => setCustomerFilter('no_debt')}
                accessibilityRole="button"
                accessibilityState={{ selected: customerFilter === 'no_debt' }}
                accessibilityLabel="Ver clientes sin deuda"
              >
                <Text style={[styles.filterChipText, customerFilter === 'no_debt' && styles.filterChipTextActive]}>
                  Sin Deuda
                </Text>
              </TouchableOpacity>
            </View>

              </View>
              }
              ListEmptyComponent={
                loadingCustomers ? (
                  <ActivityIndicator color={ui.primary} style={{ marginVertical: 30 }} />
                ) : (
                  <View style={styles.emptyContainer}>
                    <Users size={40} color={ui.textMuted} />
                    <Text style={styles.emptyText}>No se encontraron clientes en esta vista.</Text>
                  </View>
                )
              }
              ListFooterComponent={
                filteredCustomers.length > 30 ? (
                  <View style={{ paddingTop: 16, paddingBottom: 14, alignItems: 'center' }}>
                    <Text style={{ fontSize: 13, color: ui.textMuted }}>
                      Mostrando 30 de {filteredCustomers.length} clientes. Use el buscador para afinar.
                    </Text>
                  </View>
                ) : null
              }
            />
          </View>
        )}

        {/* ==================================================================== */}
        {/* SUB-MÓDULO 3: PEDIDOS Y RESERVAS */}
        {/* ==================================================================== */}
        {activeTab === 'orders' && (
          <View style={{ flex: 1 }}>
            <FlashList
              data={loadingReservations ? [] : displayedReservations}
              renderItem={renderReservationItem}
              keyExtractor={reservationKeyExtractor}
              getItemType={getReservationItemType}
              estimatedItemSize={220}
              contentContainerStyle={listContentContainerStyle}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={ListGap16}
              ListHeaderComponent={
                <View style={[styles.moduleWrapper, { marginBottom: 16 }]}>
            <SectionHeading
              title="Reservas y pedidos"
              subtitle="Los productos reservados se mantienen apartados hasta la entrega."
              action={<TouchableOpacity
                style={styles.primaryMiniButton}
                onPress={() => {
                  setNewReservationModalVisible(true);
                }}
              >
                <PlusCircle size={18} color={ui.onPrimary} />
                <Text style={styles.primaryMiniButtonText}>Nueva Reserva</Text>
              </TouchableOpacity>}
            />

            {/* Filtros */}
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.filterChip, reservationTypeFilter === 'all' && styles.filterChipActive]}
                onPress={() => setReservationTypeFilter('all')}
                accessibilityRole="button"
                accessibilityState={{ selected: reservationTypeFilter === 'all' }}
                accessibilityLabel="Ver pedidos y reservas"
              >
                <Text style={[styles.filterChipText, reservationTypeFilter === 'all' && styles.filterChipTextActive]}>
                  Todos ({reservations.length})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.filterChip, reservationTypeFilter === 'reservation' && styles.filterChipActive]}
                onPress={() => setReservationTypeFilter('reservation')}
                accessibilityRole="button"
                accessibilityState={{ selected: reservationTypeFilter === 'reservation' }}
                accessibilityLabel="Ver reservas"
              >
                <Text style={[styles.filterChipText, reservationTypeFilter === 'reservation' && styles.filterChipTextActive]}>
                  Reservas
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.filterChip, reservationTypeFilter === 'order' && styles.filterChipActive]}
                onPress={() => setReservationTypeFilter('order')}
                accessibilityRole="button"
                accessibilityState={{ selected: reservationTypeFilter === 'order' }}
                accessibilityLabel="Ver pedidos"
              >
                <Text style={[styles.filterChipText, reservationTypeFilter === 'order' && styles.filterChipTextActive]}>
                  Pedidos
                </Text>
              </TouchableOpacity>
            </View>

            </View>
            }
            ListEmptyComponent={
              loadingReservations ? (
                <ActivityIndicator color={ui.primary} style={{ marginVertical: 30 }} />
              ) : (
                <View style={styles.emptyContainer}>
                  <Package size={40} color={ui.textMuted} />
                  <Text style={styles.emptyText}>No hay pedidos ni reservas activos.</Text>
                </View>
              )
            }
            ListFooterComponent={
              filteredReservations.length > 30 ? (
                <View style={{ paddingTop: 16, paddingBottom: 14, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: ui.textMuted }}>
                    Mostrando 30 de {filteredReservations.length} pedidos/reservas.
                  </Text>
                </View>
              ) : null
            }
          />
        </View>
      )}

      {/* ==================================================================== */}
      {/* MODAL: REGISTRAR INGRESO / EGRESO MANUAL DE CAJA (PARIDAD WEB) */}
      {/* ==================================================================== */}
      {movementModalVisible && (
        <Modal
          visible={movementModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isSavingMovement) setMovementModalVisible(false);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <View style={[styles.modalContent, { maxHeight: '92%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {movementType === 'income' ? 'Registrar Ingreso Manual' : 'Registrar Egreso / Gasto'}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (!isSavingMovement) setMovementModalVisible(false);
                    }}
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
                          {(
                            [
                              { id: 'ninguno', label: 'Sin comprobante' },
                              { id: 'recibo', label: 'Recibo' },
                              { id: 'boleta', label: 'Boleta' },
                              { id: 'factura', label: 'Factura' },
                            ] as Array<{ id: ExpenseReceiptType; label: string }>
                          ).map((rt) => (
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
                          Límite de cajero sin PIN: {formatPEN(Number(activeCashSession?.cashierExpenseLimit ?? accountExpenseLimit ?? 0))}. Montos mayores solicitan PIN de autorización.
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

      {/* ==================================================================== */}
      {/* MODAL: AUTORIZACIÓN CON PIN DE SUPERVISOR PARA EGRESO DE CAJERO */}
      {/* ==================================================================== */}
      {pinModalVisible && (
        <Modal
          visible={pinModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isAuthorizingPin) {
              setPinModalVisible(false);
              setPendingPinExpense(null);
              setPinInput('');
              setPinError('');
            }
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
                    <Lock size={20} color={ui.warning} />
                    <Text style={styles.modalTitle}>Autorizar Egreso</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      if (!isAuthorizingPin) {
                        setPinModalVisible(false);
                        setPendingPinExpense(null);
                        setPinInput('');
                        setPinError('');
                      }
                    }}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar autorización de PIN"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.pinSubtitle}>
                  Este retiro de {formatPEN(pendingPinExpense?.amount ?? 0)} supera el tope permitido para cajeros. Ingresa el PIN de autorización (4 a 8 dígitos).
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>PIN Numérico</Text>
                  <TextInput
                    style={[styles.input, { fontSize: 20, letterSpacing: 6, textAlign: 'center', fontWeight: '700' }]}
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
                    onPress={() => {
                      setPinModalVisible(false);
                      setPinInput('');
                      setPinError('');
                      setMovementModalVisible(true);
                    }}
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

      {/* ==================================================================== */}
      {/* MODAL: ARQUEO Y CIERRE Z DE CAJA (CIERRE CIEGO PARA NO SUPERVISORES) */}
      {/* ==================================================================== */}
      {Boolean(completionTarget) && (
        <ReservationCompletionModal
          item={completionTarget}
          onClose={() => setCompletionTarget(null)}
          onCompleted={(item) => {
            setCompletionTarget(null);
            void loadReservationsData();
            refreshCashStatus();
            setCreatedOrderTicket({ ...item, status: 'completed', depositAmount: item.total, remainingAmount: 0 });
            setOrderTicketModalOpen(true);
          }}
        />
      )}
      {Boolean(cancellationTarget) && (
        <ReservationCancellationModal
          visible={Boolean(cancellationTarget)}
          item={cancellationTarget}
          sessionId={activeCashSession?.sessionId || activeCashSession?.id}
          onClose={() => setCancellationTarget(null)}
          onConfirm={confirmReservationCancellation}
        />
      )}
      {closeModalVisible && (
        <Modal
          visible={closeModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isClosingSession) setCloseModalVisible(false);
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
                      if (!isClosingSession) setCloseModalVisible(false);
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
                    <Text style={styles.auditAmount}>
                      {formatPEN(expectedCashAmount)}
                    </Text>
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
                    style={[styles.input, { fontSize: 20, fontWeight: 'bold' }]}
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
                          calculatedDifference === 0
                            ? ui.primarySoft
                            : calculatedDifference > 0
                            ? ui.primarySoft
                            : ui.dangerSoft,
                      },
                    ]}
                  >
                    <Text style={styles.diffLabel}>Resultado del Arqueo:</Text>
                    <Text
                      style={[
                        styles.diffValue,
                        {
                          color:
                            calculatedDifference === 0
                              ? ui.primary
                              : calculatedDifference > 0
                              ? ui.primary
                              : ui.danger,
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
                    style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
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
      )}

      {/* ==================================================================== */}
      {/* MODAL: CIERRE EXITOSO Y TICKET TÉRMICO */}
      {/* ==================================================================== */}
      {closureSuccessModal && (
        <Modal
          visible={closureSuccessModal}
          transparent
          animationType="fade"
          onRequestClose={() => setClosureSuccessModal(false)}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <View style={styles.modalOverlay}>
              <View style={styles.modalContent}>
                <View style={{ alignItems: 'center', marginVertical: 12 }}>
                  <CheckCircle2 size={48} color={ui.primary} />
                  <Text style={[styles.modalTitle, { marginTop: 8 }]}>¡Turno Cerrado con Éxito!</Text>
                  <Text style={styles.modalSub}>El reporte de Cierre Z ha sido guardado.</Text>
                </View>

                <TouchableOpacity
                  style={styles.printTicketButton}
                  onPress={handlePrintClosureTicket}
                >
                  <Printer size={20} color={ui.onPrimary} />
                  <Text style={styles.printTicketButtonText}>Imprimir Ticket Térmico Z</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryDismissButton}
                  onPress={() => setClosureSuccessModal(false)}
                >
                  <Text style={styles.secondaryDismissText}>Finalizar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </SafeAreaView>
        </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: CREAR NUEVO CLIENTE (CON CONSULTA DNI/RUC) */}
      {/* ==================================================================== */}
      {newCustomerModalVisible && (
        <Modal
          visible={newCustomerModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => {
            if (!isSavingCustomer) setNewCustomerModalVisible(false);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <View style={[styles.modalContent, { maxHeight: '90%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Nuevo Cliente en Cartera</Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (!isSavingCustomer) setNewCustomerModalVisible(false);
                    }}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar formulario de cliente"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  {/* Tipo y Consulta */}
                  <View style={styles.docTypeRow}>
                    <TouchableOpacity
                      style={[styles.docTypeBtn, docType === 'DNI' && styles.docTypeBtnActive]}
                      onPress={() => setDocType('DNI')}
                    >
                      <Text style={[styles.docTypeText, docType === 'DNI' && styles.docTypeTextActive]}>
                        DNI (RENIEC)
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.docTypeBtn, docType === 'RUC' && styles.docTypeBtnActive]}
                      onPress={() => setDocType('RUC')}
                    >
                      <Text style={[styles.docTypeText, docType === 'RUC' && styles.docTypeTextActive]}>
                        RUC (SUNAT)
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Número de Documento</Text>
                    <View style={styles.lookupInputRow}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        placeholder={docType === 'DNI' ? '8 dígitos' : '11 dígitos'}
                        placeholderTextColor={ui.textMuted}
                        keyboardType="numeric"
                        value={docNumber}
                        onChangeText={setDocNumber}
                      />
                      <TouchableOpacity
                        style={styles.lookupButton}
                        onPress={handleLookupDoc}
                        disabled={isLookingUpDoc}
                      >
                        {isLookingUpDoc ? (
                          <ActivityIndicator color={ui.onPrimary} size="small" />
                        ) : (
                          <Text style={styles.lookupButtonText}>Consultar</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Nombre o Razón Social</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Nombre completo"
                      placeholderTextColor={ui.textMuted}
                      value={customerName}
                      onChangeText={setCustomerName}
                    />
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Teléfono / WhatsApp</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="987654321"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="phone-pad"
                      value={customerPhone}
                      onChangeText={setCustomerPhone}
                    />
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Dirección Fiscal / Entrega</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Av. Principal 123"
                      placeholderTextColor={ui.textMuted}
                      value={customerAddress}
                      onChangeText={setCustomerAddress}
                    />
                  </View>

                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Línea de Crédito Máxima (S/)</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="200.00"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="decimal-pad"
                      value={creditLimitInput}
                      onChangeText={setCreditLimitInput}
                    />
                  </View>
                </ScrollView>

                <TouchableOpacity
                  style={[styles.primaryButton, isSavingCustomer && styles.buttonDisabled]}
                  onPress={handleSaveCustomer}
                  disabled={isSavingCustomer}
                >
                  {isSavingCustomer ? (
                    <ActivityIndicator color={ui.onPrimary} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Guardar Cliente</Text>
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: REGISTRAR ABONO DE FIADO */}
      {/* ==================================================================== */}
      {paymentModalVisible && (
        <Modal
          visible={paymentModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isProcessingPayment) setPaymentModalVisible(false);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <View style={[styles.modalContent, { maxHeight: '90%' }]}>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>Abonar a Deuda</Text>
                    <Text style={styles.modalSub}>{selectedDebtor?.name}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      if (!isProcessingPayment) setPaymentModalVisible(false);
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
                      {formatPEN(selectedDebtor?.currentDebt ?? 0)}
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
                              style={[styles.methodChip, selectedFiado?.id === fiado.id && styles.methodChipActive]}
                              onPress={() => {
                                setSelectedFiado(fiado);
                                setPaymentAmount(String(fiado.remainingAmount));
                              }}
                            >
                              <Text style={[styles.methodChipText, selectedFiado?.id === fiado.id && styles.methodChipTextActive]}>
                                #{fiado.reservationNumber ?? fiado.id.slice(-6)} · {formatPEN(fiado.remainingAmount)}
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
                      style={[styles.input, { fontSize: 20, fontWeight: 'bold' }]}
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
                      {[
                        { id: 'efectivo', label: 'Efectivo' },
                        { id: 'yape', label: 'Yape' },
                        { id: 'plin', label: 'Plin' },
                        { id: 'tarjeta', label: 'Tarjeta' },
                        { id: 'transferencia', label: 'Transf.' },
                      ].map((m) => (
                        <TouchableOpacity
                          key={m.id}
                          style={[
                            styles.methodChip,
                            paymentMethod === m.id && styles.methodChipActive,
                          ]}
                          onPress={() => setPaymentMethod(m.id as any)}
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
      )}

      {/* ==================================================================== */}
      {/* MODAL: NUEVA RESERVA O PEDIDO */}
      {/* ==================================================================== */}
      {newReservationModalVisible && (
        <NewReservationModal
          visible={newReservationModalVisible}
          onClose={() => setNewReservationModalVisible(false)}
          accountId={accountId}
          branchId={branchId}
          activeCashSession={activeCashSession}
          user={user}
          userProfile={userProfile}
          role={role}
          onCreated={handleReservationCreated}
        />
      )}

      {/* ==================================================================== */}
      {/* MODAL: DETALLE DE CLIENTE, FIADOS, DEVOLUCIÓN, CASTIGO Y RECÁLCULO */}
      {/* ==================================================================== */}
      {customerDetailModalVisible && detailCustomer && (
        <Modal
          visible={customerDetailModalVisible && !returnFiadoTarget && !writeOffTarget && !paymentModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setCustomerDetailModalVisible(false)}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.fullSheetContainer}>
            <View style={styles.fullSheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle} numberOfLines={1}>{detailCustomer.name}</Text>
                <Text style={styles.modalSub}>
                  {detailCustomer.documentType || 'DOC'}: {detailCustomer.documentNumber || 'Sin número'}
                  {detailCustomer.phone ? ` · ${detailCustomer.phone}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setCustomerDetailModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar detalle del cliente"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.fullSheetContent} showsVerticalScrollIndicator={false}>
              {(detailCustomer.email || detailCustomer.address) ? (
                <View style={styles.detailInfoCard}>
                  {detailCustomer.email ? (
                    <Text style={styles.detailInfoLine}>Correo: {detailCustomer.email}</Text>
                  ) : null}
                  {detailCustomer.address ? (
                    <Text style={styles.detailInfoLine}>Dirección: {detailCustomer.address}</Text>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.detailKpiGrid}>
                <View style={styles.detailKpiTile}>
                  <Text style={styles.detailKpiLabel}>DEUDA ACTUAL</Text>
                  <Text style={[styles.detailKpiValue, { color: (detailCustomer.currentDebt || 0) > 0 ? ui.danger : ui.success }]}>
                    {formatPEN(Number(detailCustomer.currentDebt) || 0)}
                  </Text>
                </View>
                <View style={styles.detailKpiTile}>
                  <Text style={styles.detailKpiLabel}>CRÉDITOS</Text>
                  <Text style={[styles.detailKpiValue, { color: ui.primary }]}>
                    {formatPEN(Number(detailCustomer.credits) || 0)}
                  </Text>
                </View>
                <View style={styles.detailKpiTile}>
                  <Text style={styles.detailKpiLabel}>LÍMITE CRÉDITO</Text>
                  <Text style={styles.detailKpiValue}>
                    {formatPEN(Number(detailCustomer.maxCreditLimit ?? detailCustomer.creditLimit) || 0)}
                  </Text>
                </View>
              </View>

              <View style={styles.detailActionsBar}>
                {(Number(detailCustomer.currentDebt) || 0) > 0 && (
                  <TouchableOpacity
                    style={[styles.primaryButton, { flex: 1 }]}
                    onPress={() => handleCollectDebt(detailCustomer)}
                  >
                    <Receipt size={16} color={ui.onPrimary} />
                    <Text style={styles.primaryButtonText}>Abonar Deuda</Text>
                  </TouchableOpacity>
                )}

                {isSupervisor && canManageCustomers && (
                  <TouchableOpacity
                    style={[styles.recalcButton, { flex: 1 }, isRecalculatingDebt && styles.buttonDisabled]}
                    onPress={handleRecalculateDebt}
                    disabled={isRecalculatingDebt}
                  >
                    {isRecalculatingDebt ? (
                      <ActivityIndicator size="small" color={ui.primary} />
                    ) : (
                      <>
                        <RotateCcw size={15} color={ui.primary} />
                        <Text style={styles.recalcButtonText}>Recalcular deuda</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
              </View>

              <Text style={styles.detailSectionTitle}>
                Fiados Pendientes ({detailOpenFiados.length})
              </Text>

              {loadingCustomerDetail ? (
                <ActivityIndicator color={ui.primary} style={{ marginVertical: 20 }} />
              ) : detailOpenFiados.length === 0 ? (
                <View style={styles.detailEmptyBox}>
                  <Text style={styles.emptyText}>Este cliente no tiene fiados pendientes.</Text>
                </View>
              ) : (
                detailOpenFiados.map((fiado) => {
                  const canReturnItems =
                    (fiado.items?.length || 0) > 0 &&
                    (canProcessReturn || isSupervisor || role === 'manager' || isCashier);
                  return (
                    <View key={fiado.id} style={styles.fiadoDetailCard}>
                      <View style={styles.fiadoDetailHeader}>
                        <View>
                          <Text style={styles.fiadoDetailTitle}>
                            Fiado #{fiado.reservationNumber ?? fiado.id.slice(-6).toUpperCase()}
                          </Text>
                          <Text style={styles.fiadoDetailDate}>{formatDatePE(fiado.date)}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={styles.fiadoBalanceLabel}>PENDIENTE</Text>
                          <Text style={styles.fiadoBalanceValue}>{formatPEN(fiado.remainingAmount)}</Text>
                        </View>
                      </View>

                      <View style={styles.fiadoMetricsRow}>
                        <Text style={styles.fiadoMetricText}>Total: {formatPEN(fiado.total)}</Text>
                        <Text style={styles.fiadoMetricText}>Pagado: {formatPEN(fiado.paidAmount)}</Text>
                        {(fiado.returnedAmount || 0) > 0 && (
                          <Text style={styles.fiadoMetricText}>Devuelto: {formatPEN(fiado.returnedAmount || 0)}</Text>
                        )}
                      </View>

                      {Array.isArray(fiado.items) && fiado.items.length > 0 && (
                        <View style={styles.fiadoItemsBox}>
                          {fiado.items.map((it, idx) => (
                            <View key={`${it.productId || it.id || idx}`} style={styles.fiadoItemLine}>
                              <Text style={styles.fiadoItemName} numberOfLines={1}>
                                {it.quantity}x {it.productName || it.name || 'Producto'}
                              </Text>
                              <Text style={styles.fiadoItemPrice}>
                                {formatPEN((Number(it.price) || 0) * (Number(it.quantity) || 0))}
                              </Text>
                            </View>
                          ))}
                        </View>
                      )}

                      <View style={styles.fiadoButtonsRow}>
                        <TouchableOpacity
                          style={styles.fiadoActionPrimary}
                          onPress={() => {
                            setSelectedDebtor(detailCustomer);
                            setOpenFiados(detailOpenFiados);
                            setSelectedFiado(fiado);
                            setPaymentAmount(String(fiado.remainingAmount));
                            setPaymentModalVisible(true);
                          }}
                        >
                          <Receipt size={14} color={ui.onPrimary} />
                          <Text style={styles.fiadoActionPrimaryText}>Abonar</Text>
                        </TouchableOpacity>

                        {canReturnItems && (
                          <TouchableOpacity
                            style={styles.fiadoActionOutline}
                            onPress={() => handleOpenReturnFiado(fiado)}
                          >
                            <RotateCcw size={14} color={ui.primary} />
                            <Text style={styles.fiadoActionOutlineText}>Devolver</Text>
                          </TouchableOpacity>
                        )}

                        {isSupervisor && (
                          <TouchableOpacity
                            style={styles.fiadoActionDanger}
                            onPress={() => handleOpenWriteOff(fiado)}
                          >
                            <ShieldAlert size={14} color={ui.danger} />
                            <Text style={styles.fiadoActionDangerText}>Castigar</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })
              )}

              <Text style={[styles.detailSectionTitle, { marginTop: 8 }]}>
                Historial de Abonos y Créditos ({detailFiadoHistory.length})
              </Text>
              {detailFiadoHistory.length === 0 ? (
                <View style={styles.detailEmptyBox}>
                  <Text style={styles.emptyText}>Sin movimientos registrados aún.</Text>
                </View>
              ) : (
                detailFiadoHistory.slice(0, 15).map((entry) => (
                  <View key={entry.id} style={styles.historyRowItem}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyRowTitle}>
                        {entry.paymentMethod || 'Abono'} · {entry.createdByName || 'Operador'}
                      </Text>
                      <Text style={styles.historyRowSub}>
                        {formatDatePE(entry.date)}
                        {entry.notes ? ` · ${entry.notes}` : ''}
                      </Text>
                    </View>
                    <Text style={styles.historyRowAmt}>+{formatPEN(entry.amount)}</Text>
                  </View>
                ))
              )}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: DEVOLVER MERCADERÍA DE FIADO                                  */}
      {/* ==================================================================== */}
      {Boolean(returnFiadoTarget) && returnFiadoTarget && (
        <Modal
          visible={Boolean(returnFiadoTarget)}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isSubmittingFiadoReturn) setReturnFiadoTarget(null);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.modalOverlay}
            >
              <View style={[styles.modalContent, { maxHeight: '90%' }]}>
                <View style={styles.modalHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalTitle}>Devolver Mercadería</Text>
                    <Text style={styles.modalSub}>
                      Fiado #{returnFiadoTarget.reservationNumber ?? returnFiadoTarget.id.slice(-6).toUpperCase()}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      if (!isSubmittingFiadoReturn) setReturnFiadoTarget(null);
                    }}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar devolución de fiado"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.helperText}>
                  El stock reingresa hoy al inventario. No se entrega efectivo: cualquier excedente se abona a créditos del cliente.
                </Text>

                <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                  {(returnFiadoTarget.items || []).map((it, idx) => {
                    const pid = String(it.productId || it.id || '');
                    const alreadyReturned = returnedByProductMap.get(pid) || 0;
                    const maxQty = Math.max(0, (Number(it.quantity) || 0) - alreadyReturned);
                    return (
                      <View key={`${pid}_${idx}`} style={styles.returnItemRow}>
                        <View style={{ flex: 1, marginRight: 10 }}>
                          <Text style={styles.returnItemName} numberOfLines={2}>
                            {it.productName || it.name || 'Producto'}
                          </Text>
                          <Text style={styles.returnItemMeta}>
                            P.U. {formatPEN(Number(it.price) || 0)} · Máx. devolvible: {maxQty}
                          </Text>
                        </View>
                        <TextInput
                          style={styles.returnQtyInput}
                          placeholder="0"
                          placeholderTextColor={ui.textMuted}
                          keyboardType="decimal-pad"
                          value={returnQtyMap[pid] ?? ''}
                          editable={maxQty > 0}
                          onChangeText={(txt) =>
                            setReturnQtyMap((prev) => ({
                              ...prev,
                              [pid]: txt.replace(/[^\d.,]/g, ''),
                            }))
                          }
                        />
                      </View>
                    );
                  })}

                  <View style={[styles.inputGroup, { marginTop: 10 }]}>
                    <Text style={styles.label}>Motivo de la devolución *</Text>
                    <TextInput
                      style={[styles.input, { height: 70, textAlignVertical: 'top' }]}
                      placeholder="Ej. Producto con falla o cliente desistió"
                      placeholderTextColor={ui.textMuted}
                      multiline
                      value={returnReasonInput}
                      onChangeText={setReturnReasonInput}
                    />
                  </View>
                </ScrollView>

                <TouchableOpacity
                  style={[styles.primaryButton, isSubmittingFiadoReturn && styles.buttonDisabled]}
                  onPress={handleSubmitReturnFiado}
                  disabled={isSubmittingFiadoReturn}
                >
                  {isSubmittingFiadoReturn ? (
                    <ActivityIndicator color={ui.onPrimary} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Confirmar Devolución</Text>
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: CASTIGAR DEUDA INCOBRABLE (OWNER / ADMIN)                     */}
      {/* ==================================================================== */}
      {Boolean(writeOffTarget) && writeOffTarget && (
        <Modal
          visible={Boolean(writeOffTarget)}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isSubmittingWriteOff) setWriteOffTarget(null);
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
                      if (!isSubmittingWriteOff) setWriteOffTarget(null);
                    }}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar castigo de deuda"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.pinSubtitle}>
                  Se excluirán {formatPEN(writeOffTarget.remainingAmount)} de la deuda del cliente sin mover inventario ni caja.
                </Text>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Motivo del castigo *</Text>
                  <TextInput
                    style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
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
                  <View style={[styles.confirmCheckboxBox, writeOffConfirmed && styles.confirmCheckboxBoxChecked]}>
                    {writeOffConfirmed && <Check size={13} color={ui.onPrimary} />}
                  </View>
                  <Text style={styles.confirmCheckboxText}>
                    Confirmo que esta deuda es incobrable y el castigo quedará registrado a mi nombre.
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.closeZConfirmButton,
                    (isSubmittingWriteOff || !writeOffConfirmed || writeOffReasonInput.trim().length < 3) && styles.buttonDisabled,
                  ]}
                  onPress={handleSubmitWriteOff}
                  disabled={isSubmittingWriteOff || !writeOffConfirmed || writeOffReasonInput.trim().length < 3}
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
      )}

      {/* ==================================================================== */}
      {/* MODAL: ASISTENTE VENTY IA (STREAMING PROGRESIVO Y ESTADO OFFLINE)    */}
      {/* ==================================================================== */}
      {ventyModalVisible && (
        <Modal
          visible={ventyModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setVentyModalVisible(false)}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.fullSheetContainer}>
            <View style={styles.fullSheetHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <Sparkles size={20} color={ui.primary} />
                <View>
                  <Text style={styles.modalTitle}>Venty IA</Text>
                  <Text style={styles.modalSub}>Asistente operativo en tiempo real</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setVentyModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar Venty IA"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {!isOnline && (
              <View style={styles.ventyOfflineBanner}>
                <AlertTriangle size={16} color={ui.warning} />
                <Text style={styles.ventyOfflineText}>
                  Sin conexión a internet. Conéctate para consultar a Venty IA.
                </Text>
              </View>
            )}

            {ventyError && isOnline ? (
              <View style={styles.ventyErrorBanner}>
                <AlertCircle size={16} color={ui.danger} />
                <Text style={styles.ventyErrorText} numberOfLines={2}>
                  {ventyError}
                </Text>
              </View>
            ) : null}

            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <ScrollView
                ref={ventyScrollRef}
                style={{ flex: 1 }}
                contentContainerStyle={styles.ventyMessagesContainer}
                keyboardShouldPersistTaps="handled"
              >
                {ventyMessages.map((msg) => {
                  const isAi = msg.sender === 'ai';
                  return (
                    <View
                      key={msg.id}
                      style={[
                        styles.ventyBubble,
                        isAi ? styles.ventyBubbleAi : styles.ventyBubbleUser,
                        msg.isError && styles.ventyBubbleError,
                      ]}
                    >
                      <Text
                        style={[
                          styles.ventyBubbleText,
                          isAi ? styles.ventyBubbleTextAi : styles.ventyBubbleTextUser,
                          msg.isError && { color: ui.danger },
                        ]}
                      >
                        {msg.text || (isAi && ventyLoading ? 'Analizando datos en tiempo real...' : '')}
                      </Text>
                    </View>
                  );
                })}

                <View style={styles.ventyChipsWrap}>
                  {VENTY_QUICK_CHIPS.map((chip) => (
                    <TouchableOpacity
                      key={chip}
                      style={styles.ventyQuickChip}
                      onPress={() => void handleSendVentyMessage(chip)}
                      disabled={ventyLoading}
                    >
                      <Text style={styles.ventyQuickChipText}>{chip}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>

              <View style={styles.ventyInputBar}>
                <TextInput
                  style={styles.ventyTextInput}
                  placeholder="Pregúntale a Venty IA..."
                  placeholderTextColor={ui.textMuted}
                  value={ventyInput}
                  onChangeText={setVentyInput}
                  onSubmitEditing={() => void handleSendVentyMessage()}
                  returnKeyType="send"
                />
                <TouchableOpacity
                  style={[
                    styles.ventySendBtn,
                    (!ventyInput.trim() || ventyLoading) && styles.buttonDisabled,
                  ]}
                  onPress={() => void handleSendVentyMessage()}
                  disabled={!ventyInput.trim() || ventyLoading}
                >
                  {ventyLoading ? (
                    <ActivityIndicator size="small" color={ui.onPrimary} />
                  ) : (
                    <Send size={18} color={ui.onPrimary} />
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      )}

      {payrollModalOpen && (
        <PayrollUsersModal
          visible={payrollModalOpen}
          onClose={() => setPayrollModalOpen(false)}
          onLoadSaleRequestToPos={() => router.replace('/(tabs)')}
        />
      )}

      {pnlModalOpen && (
        <FinancialPnlModal
          visible={pnlModalOpen}
          onClose={() => setPnlModalOpen(false)}
        />
      )}

      {orderTicketModalOpen && (
        <ReservationReceiptModal
          visible={orderTicketModalOpen}
          onClose={() => setOrderTicketModalOpen(false)}
          reservation={createdOrderTicket}
          business={businessSettings}
        />
      )}
    </View>
  );
}

// ============================================================================
// ESTILOS NATIVOS REACT NATIVE
// ============================================================================
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  teamButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
  },
  teamButtonText: {
    fontSize: ui.font.small,
    color: ui.primary,
    fontWeight: '700',
  },
  tabSelector: {
    minWidth: '100%',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 4,
  },
  tabSelectorScroll: {
    flexGrow: 0,
  },
  tabButton: {
    flexGrow: 0,
    minWidth: 100,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    gap: 7,
  },
  tabButtonActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  tabButtonText: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
    fontWeight: theme.typography.weights.medium,
  },
  tabButtonTextActive: {
    color: ui.primary,
    fontWeight: theme.typography.weights.bold,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  moduleWrapper: {
    gap: 16,
  },
  card: {
    backgroundColor: ui.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBadge: {
    width: 48,
    height: 48,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: theme.typography.sizes.lg,
    fontWeight: theme.typography.weights.bold,
    color: ui.text,
  },
  cardSubtitle: {
    fontSize: theme.typography.sizes.sm,
    color: ui.textSecondary,
    marginTop: 2,
  },
  liveIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.successSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    gap: 5,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: ui.success,
  },
  liveText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ui.success,
  },
  mainKpiBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: ui.border,
  },
  mainKpiLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: ui.textMuted,
    letterSpacing: 1,
  },
  mainKpiValue: {
    fontSize: 32,
    fontWeight: '900',
    color: ui.primary,
    marginVertical: 4,
  },
  mainKpiFoot: {
    fontSize: theme.typography.sizes.xs,
    color: ui.textSecondary,
  },
  grid2Col: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statBox: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.sm,
    padding: 12,
  },
  paymentBreakdownCard: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 10,
    marginTop: 4,
  },
  paymentBreakdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  paymentBreakdownTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  paymentBreakdownTitle: {
    flexShrink: 1,
    fontSize: theme.typography.sizes.sm,
    fontWeight: '700',
    color: ui.text,
  },
  paymentBreakdownTotal: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: '800',
    color: ui.primary,
    flexShrink: 0,
  },
  ventyBtnIcon: {
    width: 18,
    height: 18,
    borderRadius: 4,
  },
  methodLogoImg: {
    width: 22,
    height: 22,
    borderRadius: 6,
  },
  paymentBreakdownGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  methodBox: {
    width: '48%',
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.sm,
    padding: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  methodHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  methodIconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodName: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  methodAmount: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
    marginTop: 2,
  },
  methodCount: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 1,
  },
  cashSubTabSelector: {
    flexDirection: 'row',
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 4,
    gap: 4,
    marginBottom: 12,
  },
  cashSubTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: theme.borderRadius.sm,
    gap: 6,
  },
  cashSubTabBtnActive: {
    backgroundColor: ui.surface,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 1,
  },
  cashSubTabText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  cashSubTabTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  saleItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    gap: 10,
  },
  methodBadgePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 4,
    marginTop: 2,
  },
  methodBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
  },
  statValue: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
    marginTop: 4,
  },
  actionButtonGroup: {
    flexDirection: 'row',
    gap: 10,
  },
  outlineActionButton: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1.5,
    gap: 6,
  },
  outlineActionText: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: 'bold',
  },
  closeZButton: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.danger,
    paddingVertical: 14,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  closeZButtonText: {
    color: ui.onPrimary,
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  emptyText: {
    fontSize: theme.typography.sizes.sm,
    color: ui.textMuted,
  },
  movementItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  movementBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  movementTitle: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: '600',
    color: ui.text,
  },
  movementSub: {
    fontSize: theme.typography.sizes.xs,
    color: ui.textSecondary,
    marginTop: 2,
  },
  movementAmount: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  kpiRow: {
    flexDirection: 'row',
    gap: 12,
  },
  kpiCard: {
    flex: 1,
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  kpiLabel: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ui.textMuted,
    letterSpacing: 0.5,
  },
  kpiValue: {
    fontSize: 22,
    fontWeight: 'bold',
    marginVertical: 4,
  },
  kpiSub: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: ui.border,
    height: 48,
  },
  searchInput: {
    flex: 1,
    color: ui.text,
    fontSize: theme.typography.sizes.sm,
    marginLeft: 8,
  },
  iconAddButton: {
    width: 48,
    height: 48,
    backgroundColor: ui.primary,
    borderRadius: theme.borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  filterChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  filterChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  filterChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  customerCard: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 12,
  },
  customerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  customerName: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
  },
  customerDoc: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  debtLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    color: ui.danger,
    letterSpacing: 0.5,
  },
  debtValue: {
    fontSize: 18,
    fontWeight: '900',
    color: ui.danger,
  },
  cleanDebtBadge: {
    backgroundColor: ui.successSoft,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  cleanDebtText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ui.success,
  },
  creditLineBox: {
    gap: 4,
  },
  creditLineLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  creditLineText: {
    fontSize: 11,
    color: ui.textMuted,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
  },
  abonoButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    gap: 6,
  },
  abonoButtonText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.onPrimary,
  },
  ordersHeaderRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  primaryMiniButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    gap: 6,
  },
  primaryMiniButtonText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.onPrimary,
  },
  reservationCard: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 12,
  },
  reservationTop: {
    gap: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 6,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  typeBadgeText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  resClientName: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
    marginTop: 4,
  },
  resClientPhone: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  resItemsList: {
    backgroundColor: ui.surfaceMuted,
    padding: 10,
    borderRadius: theme.borderRadius.sm,
    gap: 4,
  },
  resItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  resItemName: {
    fontSize: 12,
    color: ui.text,
  },
  resItemPrice: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.text,
  },
  resFinancialRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 8,
  },
  resFinLabel: {
    fontSize: 10,
    color: ui.textMuted,
  },
  resFinValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: ui.text,
    marginTop: 2,
  },
  resActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
  },
  resActionButton: {
    flex: 1,
    minWidth: '46%',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    gap: 6,
  },
  resActionText: {
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: theme.typography.sizes.lg,
    fontWeight: 'bold',
    color: ui.text,
  },
  modalSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  input: {
    minHeight: 48,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: ui.text,
    fontSize: theme.typography.sizes.base,
  },
  helperText: {
    fontSize: 11,
    color: ui.textMuted,
  },
  primaryButton: {
    minHeight: 48,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  primaryButtonText: {
    color: ui.onPrimary,
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  categoryPickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  catChip: {
    paddingHorizontal: 10,
    minHeight: 48,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  catChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  catChipText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  catChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  auditSummaryBox: {
    backgroundColor: ui.surfaceMuted,
    padding: 12,
    borderRadius: theme.borderRadius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: ui.border,
  },
  auditLabel: {
    fontSize: 11,
    color: ui.textMuted,
  },
  auditAmount: {
    fontSize: 24,
    fontWeight: '900',
    color: ui.primary,
    marginTop: 4,
  },
  differenceResultBox: {
    padding: 12,
    borderRadius: theme.borderRadius.md,
    alignItems: 'center',
  },
  diffLabel: {
    fontSize: 11,
    color: ui.textMuted,
  },
  diffValue: {
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 2,
  },
  closeZConfirmButton: {
    backgroundColor: ui.danger,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  closeZConfirmButtonText: {
    color: ui.onPrimary,
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  printTicketButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    paddingVertical: 14,
    borderRadius: theme.borderRadius.md,
    gap: 8,
    width: '100%',
  },
  printTicketButtonText: {
    color: ui.onPrimary,
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  secondaryDismissButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryDismissText: {
    color: ui.textSecondary,
    fontSize: theme.typography.sizes.sm,
  },
  docTypeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  docTypeBtn: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: ui.border,
  },
  docTypeBtnActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  docTypeText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  docTypeTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  lookupInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  lookupButton: {
    backgroundColor: ui.primary,
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: theme.borderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lookupButtonText: {
    color: ui.onPrimary,
    fontWeight: 'bold',
    fontSize: 12,
  },
  paymentMethodRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  methodChip: {
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  methodChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  methodChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  methodChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  searchProductDropdown: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: ui.border,
    marginTop: 4,
    maxHeight: 160,
  },
  dropdownItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  dropdownName: {
    fontSize: 12,
    color: ui.text,
  },
  dropdownPrice: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.primary,
  },
  orderItemsList: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.sm,
    padding: 10,
    gap: 6,
    marginVertical: 4,
  },
  orderItemCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderItemName: {
    fontSize: 12,
    color: ui.text,
    fontWeight: '600',
  },
  orderItemSub: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 8,
    marginTop: 4,
  },
  totalText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.text,
  },
  totalAmount: {
    fontSize: 14,
    fontWeight: 'bold',
    color: ui.primary,
  },
  compactHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 6,
  },
  compactHeaderTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: ui.text,
    letterSpacing: -0.5,
  },
  compactTeamButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.md,
    backgroundColor: ui.primarySoft,
  },
  compactTeamButtonText: {
    fontSize: ui.font.small,
    color: ui.primary,
    fontWeight: '700',
  },
  centeredTabsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  centeredTabButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    gap: 6,
  },
  centeredTabButtonActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  centeredTabText: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
    fontWeight: theme.typography.weights.medium,
  },
  centeredTabTextActive: {
    color: ui.primary,
    fontWeight: theme.typography.weights.bold,
  },
  multiCashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  branchesList: {
    gap: 10,
  },
  branchItemCard: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 8,
  },
  branchItemCardActive: {
    borderColor: ui.primary,
    backgroundColor: ui.surface,
  },
  branchItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  branchItemName: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  currentBranchBadge: {
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  currentBranchBadgeText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ui.primary,
  },
  branchItemCode: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  branchStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  branchStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  branchStatusBadgeText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  branchSessionMetrics: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: ui.surface,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  branchMetricCol: {
    flex: 1,
  },
  branchMetricLabel: {
    fontSize: 10,
    color: ui.textSecondary,
  },
  branchMetricValue: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    marginTop: 1,
  },
  switchBranchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    marginTop: 4,
  },
  switchBranchBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  compactHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalSafe: {
    flex: 1,
  },
  creditWalletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  creditWalletText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  customerActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  detailButton: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    gap: 6,
  },
  detailButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  employeeSelectorRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  limitNoticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.warningSoft,
    borderRadius: theme.borderRadius.md,
    padding: 10,
    marginTop: 8,
  },
  limitNoticeText: {
    flex: 1,
    fontSize: 12,
    color: ui.warning,
    fontWeight: '600',
  },
  pinSubtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    lineHeight: 19,
  },
  pinErrorText: {
    fontSize: 12,
    color: ui.danger,
    fontWeight: '600',
    marginTop: 4,
  },
  pinActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryActionButton: {
    minHeight: 48,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  secondaryActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  blindNoticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: ui.primarySoft,
    borderRadius: theme.borderRadius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  blindNoticeText: {
    flex: 1,
    fontSize: 12.5,
    color: ui.primary,
    fontWeight: '600',
    lineHeight: 18,
  },
  fullSheetContainer: {
    flex: 1,
    backgroundColor: ui.background,
  },
  fullSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  fullSheetContent: {
    padding: 20,
    gap: 14,
    paddingBottom: 40,
  },
  detailInfoCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 4,
  },
  detailInfoLine: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  detailKpiGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  detailKpiTile: {
    flex: 1,
    backgroundColor: ui.surface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  detailKpiLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.textMuted,
  },
  detailKpiValue: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
    marginTop: 4,
  },
  detailActionsBar: {
    flexDirection: 'row',
    gap: 10,
  },
  recalcButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 12,
  },
  recalcButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  detailSectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  detailEmptyBox: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: ui.border,
  },
  fiadoDetailCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 10,
  },
  fiadoDetailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  fiadoDetailTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: ui.text,
  },
  fiadoDetailDate: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  fiadoBalanceLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: ui.danger,
  },
  fiadoBalanceValue: {
    fontSize: 16,
    fontWeight: '900',
    color: ui.danger,
  },
  fiadoMetricsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  fiadoMetricText: {
    fontSize: 12,
    color: ui.textSecondary,
    fontWeight: '600',
  },
  fiadoItemsBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  fiadoItemLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  fiadoItemName: {
    flex: 1,
    fontSize: 12,
    color: ui.text,
  },
  fiadoItemPrice: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  fiadoButtonsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  fiadoActionPrimary: {
    flex: 1,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: ui.primary,
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  fiadoActionPrimaryText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  fiadoActionOutline: {
    flex: 1,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  fiadoActionOutlineText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  fiadoActionDanger: {
    flex: 1,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: ui.dangerSoft,
    borderWidth: 1,
    borderColor: ui.danger,
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  fiadoActionDangerText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.danger,
  },
  historyRowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surface,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.border,
  },
  historyRowTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  historyRowSub: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  historyRowAmt: {
    fontSize: 14,
    fontWeight: '800',
    color: ui.success,
  },
  returnItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  returnItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  returnItemMeta: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 2,
  },
  returnQtyInput: {
    width: 72,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  confirmCheckboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 4,
  },
  confirmCheckboxBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  confirmCheckboxBoxChecked: {
    backgroundColor: ui.danger,
    borderColor: ui.danger,
  },
  confirmCheckboxText: {
    flex: 1,
    fontSize: 12.5,
    color: ui.textSecondary,
    lineHeight: 18,
  },
  ventyOfflineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.warningSoft,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  ventyOfflineText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: ui.warning,
  },
  ventyErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.dangerSoft,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  ventyErrorText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: ui.danger,
  },
  ventyMessagesContainer: {
    padding: 16,
    gap: 12,
    paddingBottom: 24,
  },
  ventyBubble: {
    maxWidth: '88%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  ventyBubbleAi: {
    alignSelf: 'flex-start',
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  ventyBubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: ui.primary,
  },
  ventyBubbleError: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.danger,
  },
  ventyBubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  ventyBubbleTextAi: {
    color: ui.text,
  },
  ventyBubbleTextUser: {
    color: ui.onPrimary,
  },
  ventyChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  ventyQuickChip: {
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  ventyQuickChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  ventyInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: ui.surface,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  ventyTextInput: {
    flex: 1,
    minHeight: 46,
    maxHeight: 100,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    paddingHorizontal: 12,
    fontSize: 14,
    color: ui.text,
  },
  ventySendBtn: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cashListHeaderCard: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: ui.border,
  },
  cashVirtualRowWrap: {
    backgroundColor: ui.surface,
    paddingHorizontal: 20,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: ui.border,
  },
  cashVirtualEmptyCard: {
    backgroundColor: ui.surface,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: ui.border,
  },
  cashVirtualFooterCap: {
    height: 14,
    backgroundColor: ui.surface,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: ui.border,
  },
});
