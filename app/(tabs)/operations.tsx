import { ReservationCompletionModal } from '@/components/ReservationCompletionModal';
import { ReservationCancellationModal } from '@/components/ReservationCancellationModal';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  OpenFiado,
  CustomerData,
  ReservationOrder,
  ReservationOrderItem,
} from '@/services/crm-operations-service';

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

type OperationsTab = 'cash' | 'crm' | 'orders';

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
  const isIncome = movement.type === 'income';
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
        <Text style={styles.movementTitle}>{movement.description || 'Movimiento de caja'}</Text>
        <Text style={styles.movementSub}>
          {formatDatePE(movement.createdAt)} • {movement.createdByName || 'Operador'}
        </Text>
      </View>
      <Text
        style={[
          styles.movementAmount,
          { color: isIncome ? ui.success : ui.danger },
        ]}
      >
        {isIncome ? '+' : '-'}{formatPEN(movement.amount)}
      </Text>
    </View>
  );
});

const SessionSaleRow = React.memo(({ sale }: { sale: any }) => {
  const isCancelled = sale.status === 'cancelled';
  const timeStr = formatDatePE(sale.createdAt || sale.date);
  return (
    <View style={styles.saleItemRow}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={styles.movementTitle}>
            {sale.correlative || `#VTA-${String(sale.saleNumber || '').padStart(5, '0')}`}
          </Text>
          {isCancelled && (
            <View style={[styles.methodBadgePill, { backgroundColor: ui.dangerSoft }]}>
              <Text style={[styles.methodBadgeText, { color: ui.danger }]}>Anulada</Text>
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
  }: {
    cust: CustomerData;
    onCollectDebt: (cust: CustomerData) => void;
  }) => {
    const debt = Number(cust.currentDebt) || 0;
    const creditLim = Number(cust.creditLimit) || 1;
    const debtRatio = Math.min(1, debt / creditLim);

    return (
      <View style={styles.customerCard}>
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

        <View style={styles.creditLineBox}>
          <View style={styles.creditLineLabels}>
            <Text style={styles.creditLineText}>Línea: {formatPEN(creditLim)}</Text>
            <Text style={styles.creditLineText}>
              Uso: {Math.round(debtRatio * 100)}%
            </Text>
          </View>
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
        </View>

        {debt > 0 && (
          <TouchableOpacity
            style={styles.abonoButton}
            onPress={() => onCollectDebt(cust)}
          >
            <Receipt size={16} color={ui.onPrimary} />
            <Text style={styles.abonoButtonText}>Cobrar Abono de Deuda</Text>
          </TouchableOpacity>
        )}
      </View>
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
  const { user, userProfile, accountId, branchId, role, setActiveBranchId } = useAuth();
  const { canManageUsers, canViewAllCashSessions } = usePermissions();
  const { products: productCatalog } = useProducts();
  const {
    businessSettings,
    activeBranch,
    branches,
    isCashOpen,
    activeCashSession,
    refreshCashStatus,
    isOnline,
  } = useSettings();

  const [activeTab, setActiveTab] = useState<OperationsTab>('cash');
  const [payrollModalOpen, setPayrollModalOpen] = useState<boolean>(false);

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
    const task = InteractionManager.runAfterInteractions(() => {
      void fetchBranchSessions();
    });
    return () => task.cancel();
  }, [fetchBranchSessions, isCashOpen, branchId]);

  const handleSwitchBranchCash = (targetBranchId: string, branchName: string) => {
    setActiveBranchId(targetBranchId);
    setTimeout(() => {
      refreshCashStatus();
      fetchBranchSessions();
    }, 200);
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
  const [movementCategory, setMovementCategory] = useState<string>('petty_cash');
  const [isSavingMovement, setIsSavingMovement] = useState<boolean>(false);

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
  const [customerFilter, setCustomerFilter] = useState<'all' | 'with_debt' | 'no_debt'>('all');
  const [loadingCustomers, setLoadingCustomers] = useState<boolean>(false);

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
  const [orderType, setOrderType] = useState<'reservation' | 'order'>('reservation');
  const [orderCustomerName, setOrderCustomerName] = useState<string>('');
  const [orderCustomerPhone, setOrderCustomerPhone] = useState<string>('');
  const [orderCustomerDoc, setOrderCustomerDoc] = useState<string>('');
  const [orderDeposit, setOrderDeposit] = useState<string>('');
  const [orderPaymentMethod, setOrderPaymentMethod] = useState<string>('efectivo');
  const [orderPickupDate, setOrderPickupDate] = useState<string>('');
  const [orderNotes, setOrderNotes] = useState<string>('');
  const [orderItems, setOrderItems] = useState<ReservationOrderItem[]>([]);
  const [isSavingReservation, setIsSavingReservation] = useState<boolean>(false);
  const [isSearchingOrderDni, setIsSearchingOrderDni] = useState<boolean>(false);
  const [createdOrderTicket, setCreatedOrderTicket] = useState<any | null>(null);
  const [orderTicketModalOpen, setOrderTicketModalOpen] = useState<boolean>(false);

  // DNI auto-lookup cuando alcanza 8 dígitos (con debounce de 250ms)
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

  // Búsqueda de producto para agregar a la reserva
  const [productSearchQuery, setProductSearchQuery] = useState<string>('');

  // ============================================================================
  // EFECTO: CARGAR MOVIMIENTOS DE CAJA EN VIVO
  // ============================================================================
  useEffect(() => {
    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !isCashOpen) {
      setMovements([]);
      return;
    }

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
  }, [activeCashSession?.sessionId, activeCashSession?.id, isCashOpen]);

  // ============================================================================
  // EFECTO: CARGAR VENTAS DEL TURNO EN VIVO (DESGLOSE MULTI-PAGO)
  // ============================================================================
  useEffect(() => {
    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !accountId || !isCashOpen) {
      setSessionSales([]);
      return;
    }

    setLoadingSessionSales(true);
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
  }, [activeCashSession?.sessionId, activeCashSession?.id, accountId, isCashOpen]);

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

    for (const sale of sessionSales) {
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

    // Fallback con acumuladores de la sesión si la lista aún está vacía
    if (sessionSales.length === 0 && activeCashSession) {
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
      counts: {
        cash: countCash,
        yape: countYape,
        plin: countPlin,
        card: countCard,
        transfer: countTransfer,
        credit: countCredit,
        total: sessionSales.length,
      },
    };
  }, [sessionSales, activeCashSession]);

  // ============================================================================
  // EFECTO: CARGAR CLIENTES Y FIADOS
  // ============================================================================
  const loadCustomersData = useCallback(async () => {
    if (!accountId) return;
    setLoadingCustomers(true);
    try {
      const data = await getCustomers(accountId);
      setCustomers(data);
    } catch (err) {
      console.error('Error cargando clientes:', err);
    } finally {
      setLoadingCustomers(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (activeTab !== 'crm' || customers.length > 0) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void loadCustomersData();
    });
    return () => task.cancel();
  }, [activeTab, customers.length, loadCustomersData]);

  // ============================================================================
  // EFECTO: CARGAR PEDIDOS Y RESERVAS
  // ============================================================================
  const loadReservationsData = useCallback(async () => {
    if (!accountId || !branchId) return;
    setLoadingReservations(true);
    try {
      const data = await getReservationsAndOrders(accountId, branchId);
      setReservations(data);
    } catch (err) {
      console.error('Error cargando pedidos y reservas:', err);
    } finally {
      setLoadingReservations(false);
    }
  }, [accountId, branchId]);

  useEffect(() => {
    if (activeTab !== 'orders' || reservations.length > 0) return;
    const task = InteractionManager.runAfterInteractions(() => {
      void loadReservationsData();
    });
    return () => task.cancel();
  }, [activeTab, reservations.length, loadReservationsData]);

  // Sugerencias memoizadas desde ProductsContext (sin descargar catálogo de Firestore)
  const filteredCatalogSuggestions = useMemo(() => {
    const q = productSearchQuery.trim().toLowerCase();
    if (!q) return [];
    return productCatalog.filter((p) => p.name?.toLowerCase().includes(q)).slice(0, 5);
  }, [productCatalog, productSearchQuery]);

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

    const sessId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!sessId || !accountId || !branchId || !user) {
      Alert.alert('Error', 'No hay una sesión de caja activa disponible.');
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
        category: movementCategory,
        description: movementReason.trim(),
        userId: user.uid,
        userName: userProfile?.displayName || user.email || 'Operador',
      });

      setMovementAmount('');
      setMovementReason('');
      setMovementModalVisible(false);
      refreshCashStatus();
      Alert.alert(
        'Movimiento Registrado',
        `Se registró el ${movementType === 'income' ? 'ingreso' : 'egreso/gasto'} de ${formatPEN(amt)} con éxito.`
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo registrar el movimiento.');
    } finally {
      setIsSavingMovement(false);
    }
  };

  // Cálculo de arqueo en vivo
  const calculatedDifference = useMemo(() => {
    const expected = activeCashSession?.expectedAmount ?? 0;
    const counted = parseFloat(countedAmountInput.replace(',', '.'));
    if (isNaN(counted)) return null;
    return Math.round((counted - expected) * 100) / 100;
  }, [activeCashSession?.expectedAmount, countedAmountInput]);

  const handleCloseCash = async () => {
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
        expectedAmount: lastClosureReport.expectedAmount,
        countedAmount: lastClosureReport.countedAmount,
        difference: lastClosureReport.difference,
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
    const term = customerSearch.trim().toLowerCase();
    return customers.filter((c) => {
      const debt = Number(c.currentDebt) || 0;
      if (customerFilter === 'with_debt' && debt <= 0) return false;
      if (customerFilter === 'no_debt' && debt > 0) return false;
      if (!term) return true;
      const name = (c.name || '').toLowerCase();
      const doc = (c.documentNumber || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      return name.includes(term) || doc.includes(term) || phone.includes(term);
    });
  }, [customers, customerFilter, customerSearch]);

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

      setPaymentModalVisible(false);
      setPaymentAmount('');
      setPaymentNotes('');
      setSelectedDebtor(null);
      setSelectedFiado(null);
      setOpenFiados([]);
      loadCustomersData();
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

  const handleAddProductToReservation = (prod: any) => {
    const existing = orderItems.find((it) => it.productId === prod.id);
    if (existing) {
      setOrderItems(
        orderItems.map((it) =>
          it.productId === prod.id ? { ...it, quantity: it.quantity + 1 } : it
        )
      );
    } else {
      setOrderItems([
        ...orderItems,
        {
          productId: prod.id,
          productName: prod.name,
          sku: prod.sku,
          price: prod.price || prod.suggestedPrice || 0,
          quantity: 1,
          conversionFactor: 1,
        },
      ]);
    }
  };

  const handleRemoveItemFromReservation = (pId: string) => {
    setOrderItems(orderItems.filter((it) => it.productId !== pId));
  };

  const reservationOrderTotal = useMemo(() => {
    return orderItems.reduce((acc, it) => acc + it.price * it.quantity, 0);
  }, [orderItems]);

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
          email: user.email,
          role,
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

      setCreatedOrderTicket(newResObj);
      setNewReservationModalVisible(false);
      setOrderCustomerName('');
      setOrderCustomerPhone('');
      setOrderCustomerDoc('');
      setOrderDeposit('');
      setOrderPickupDate('');
      setOrderNotes('');
      setOrderItems([]);
      loadReservationsData();
      refreshCashStatus();
      setOrderTicketModalOpen(true);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar la reserva.');
    } finally {
      setIsSavingReservation(false);
    }
  };

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

  const sessionSaleKeyExtractor = useCallback((item: any, index: number) => item.id || `sale_${index}`, []);
  const renderSessionSaleItem = useCallback(
    ({ item }: { item: any }) => <SessionSaleRow sale={item} />,
    []
  );

  const customerKeyExtractor = useCallback((item: CustomerData, index: number) => item.id || `cust_${index}`, []);
  const renderCustomerItem = useCallback(
    ({ item }: { item: CustomerData }) => (
      <CustomerCardItem cust={item} onCollectDebt={handleCollectDebt} />
    ),
    [handleCollectDebt]
  );

  const reservationKeyExtractor = useCallback(
    (item: ReservationOrder, index: number) => item.id || `res_${index}`,
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
          <ScrollView
            style={styles.contentContainer}
            contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
            keyboardShouldPersistTaps="handled"
          >
          <View style={styles.moduleWrapper}>
            {!isCashOpen ? (
              // TARJETA DE APERTURA DE CAJA
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
            ) : (
              // PANEL EN VIVO DEL TURNO ABIERTO
              <>
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

                  {/* KPI Principal: Efectivo en Gaveta */}
                  <View style={styles.mainKpiBox}>
                    <Text style={styles.mainKpiLabel}>EFECTIVO ESPERADO EN GAVETA</Text>
                    <Text style={styles.mainKpiValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                      {formatPEN(activeCashSession?.expectedAmount ?? 0)}
                    </Text>
                    <Text style={styles.mainKpiFoot}>
                      Apertura: {formatDatePE(activeCashSession?.openedAt || activeCashSession?.openTime)}
                    </Text>
                  </View>

                  {/* Grid de Desglose de Caja */}
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
                        +{formatPEN(salesBreakdown.cash > 0 ? salesBreakdown.cash : (activeCashSession?.cashSales ?? 0))}
                      </Text>
                    </View>

                    <View style={styles.statBox}>
                      <Text style={styles.statLabel}>Ventas Digitales</Text>
                      <Text style={[styles.statValue, { color: ui.success }]}>
                        {formatPEN(salesBreakdown.totalDigital > 0 ? salesBreakdown.totalDigital : (activeCashSession?.digitalSales ?? 0))}
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
                        {sessionSales.length > 0 ? sessionSales.length : (activeCashSession?.transactionCount ?? movements.length)}
                      </Text>
                    </View>
                  </View>

                  {/* Desglose Detallado por Método de Pago */}
                  <View style={styles.paymentBreakdownCard}>
                    <View style={styles.paymentBreakdownHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Coins size={18} color={ui.primary} />
                        <Text style={styles.paymentBreakdownTitle}>Desglose por Método de Pago</Text>
                      </View>
                      <Text style={styles.paymentBreakdownTotal}>
                        Total: {formatPEN(salesBreakdown.totalAll)}
                      </Text>
                    </View>

                    <View style={styles.paymentBreakdownGrid}>
                      {/* Efectivo */}
                      <View style={styles.methodBox}>
                        <View style={styles.methodHeader}>
                          <View style={[styles.methodIconBadge, { backgroundColor: '#DCFCE7' }]}>
                            <Coins size={13} color="#16A34A" />
                          </View>
                          <Text style={styles.methodName}>Efectivo</Text>
                        </View>
                        <Text style={[styles.methodAmount, { color: '#16A34A' }]}>{formatPEN(salesBreakdown.cash)}</Text>
                        <Text style={styles.methodCount}>{salesBreakdown.counts.cash} {salesBreakdown.counts.cash === 1 ? 'venta' : 'ventas'}</Text>
                      </View>

                      {/* Yape */}
                      <View style={styles.methodBox}>
                        <View style={styles.methodHeader}>
                          <View style={[styles.methodIconBadge, { backgroundColor: '#F3E8FF' }]}>
                            <Smartphone size={13} color="#7E22CE" />
                          </View>
                          <Text style={styles.methodName}>Yape</Text>
                        </View>
                        <Text style={[styles.methodAmount, { color: '#7E22CE' }]}>{formatPEN(salesBreakdown.yape)}</Text>
                        <Text style={styles.methodCount}>{salesBreakdown.counts.yape} {salesBreakdown.counts.yape === 1 ? 'venta' : 'ventas'}</Text>
                      </View>

                      {/* Plin */}
                      <View style={styles.methodBox}>
                        <View style={styles.methodHeader}>
                          <View style={[styles.methodIconBadge, { backgroundColor: '#E0F2FE' }]}>
                            <Smartphone size={13} color="#0284C7" />
                          </View>
                          <Text style={styles.methodName}>Plin</Text>
                        </View>
                        <Text style={[styles.methodAmount, { color: '#0284C7' }]}>{formatPEN(salesBreakdown.plin)}</Text>
                        <Text style={styles.methodCount}>{salesBreakdown.counts.plin} {salesBreakdown.counts.plin === 1 ? 'venta' : 'ventas'}</Text>
                      </View>

                      {/* Tarjeta */}
                      <View style={styles.methodBox}>
                        <View style={styles.methodHeader}>
                          <View style={[styles.methodIconBadge, { backgroundColor: '#EFF6FF' }]}>
                            <CreditCard size={13} color="#2563EB" />
                          </View>
                          <Text style={styles.methodName}>Tarjeta</Text>
                        </View>
                        <Text style={[styles.methodAmount, { color: '#2563EB' }]}>{formatPEN(salesBreakdown.card)}</Text>
                        <Text style={styles.methodCount}>{salesBreakdown.counts.card} {salesBreakdown.counts.card === 1 ? 'venta' : 'ventas'}</Text>
                      </View>

                      {/* Transferencia */}
                      <View style={styles.methodBox}>
                        <View style={styles.methodHeader}>
                          <View style={[styles.methodIconBadge, { backgroundColor: '#EEF2FF' }]}>
                            <Building2 size={13} color="#4F46E5" />
                          </View>
                          <Text style={styles.methodName}>Transferencia</Text>
                        </View>
                        <Text style={[styles.methodAmount, { color: '#4F46E5' }]}>{formatPEN(salesBreakdown.transfer)}</Text>
                        <Text style={styles.methodCount}>{salesBreakdown.counts.transfer} {salesBreakdown.counts.transfer === 1 ? 'venta' : 'ventas'}</Text>
                      </View>

                      {/* Fiado / Crédito */}
                      <View style={styles.methodBox}>
                        <View style={styles.methodHeader}>
                          <View style={[styles.methodIconBadge, { backgroundColor: '#FFEDD5' }]}>
                            <FileText size={13} color="#EA580C" />
                          </View>
                          <Text style={styles.methodName}>Fiado / Crédito</Text>
                        </View>
                        <Text style={[styles.methodAmount, { color: '#EA580C' }]}>{formatPEN(salesBreakdown.credit)}</Text>
                        <Text style={styles.methodCount}>{salesBreakdown.counts.credit} {salesBreakdown.counts.credit === 1 ? 'venta' : 'ventas'}</Text>
                      </View>
                    </View>
                  </View>

                  {/* Botones de Operación Rápida */}
                  <View style={styles.actionButtonGroup}>
                    <TouchableOpacity
                      style={[styles.outlineActionButton, { borderColor: ui.primary }]}
                      onPress={() => {
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
                        setMovementType('expense');
                        setMovementCategory('petty_cash');
                        setMovementModalVisible(true);
                      }}
                    >
                      <ArrowDownRight size={18} color={ui.danger} />
                      <Text style={[styles.outlineActionText, { color: ui.danger }]}>
                        - Registrar Gasto
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Botón Cierre Z */}
                  <TouchableOpacity
                    style={styles.closeZButton}
                    onPress={() => {
                      setCountedAmountInput(String(activeCashSession?.expectedAmount ?? ''));
                      setCloseModalVisible(true);
                    }}
                  >
                    <Receipt size={20} color={ui.onPrimary} />
                    <Text style={styles.closeZButtonText}>Arqueo y Cierre Z del Turno</Text>
                  </TouchableOpacity>
                </View>

                {/* Lista de Movimientos de Caja y Ventas del Turno */}
                <View style={styles.card}>
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
                        Ventas del Turno ({sessionSales.length})
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {cashSubView === 'movements' ? (
                    loadingMovements ? (
                      <ActivityIndicator color={ui.primary} style={{ marginVertical: 20 }} />
                    ) : movements.length === 0 ? (
                      <View style={styles.emptyContainer}>
                        <Receipt size={32} color={ui.textMuted} />
                        <Text style={styles.emptyText}>No hay movimientos registrados en este turno.</Text>
                      </View>
                    ) : (
                      movements.map((m, idx) => (
                        <CashMovementRow key={m.id || `mov_${idx}`} movement={m} />
                      ))
                    )
                  ) : (
                    loadingSessionSales ? (
                      <ActivityIndicator color={ui.primary} style={{ marginVertical: 20 }} />
                    ) : sessionSales.length === 0 ? (
                      <View style={styles.emptyContainer}>
                        <Coins size={32} color={ui.textMuted} />
                        <Text style={styles.emptyText}>No hay ventas realizadas en este turno todavía.</Text>
                      </View>
                    ) : (
                      sessionSales.map((sale, idx) => (
                        <SessionSaleRow key={sale.id || `sale_${idx}`} sale={sale} />
                      ))
                    )
                  )}
                </View>
              </>
            )}

            {/* Monitoreo Multi-caja para Dueños y Administradores */}
            {(role === 'owner' || role === 'admin') && branches.length > 1 && (
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
            )}
          </View>
        </ScrollView>
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
                  onSubmitEditing={loadCustomersData}
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
                  setOrderItems([]);
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
      {/* MODAL: REGISTRAR INGRESO / EGRESO MANUAL DE CAJA */}
      {/* ==================================================================== */}
      {movementModalVisible && (
        <Modal visible={movementModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {movementType === 'income' ? 'Registrar Ingreso Manual' : 'Registrar Egreso / Gasto'}
              </Text>
              <TouchableOpacity
                onPress={() => setMovementModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar registro de movimiento"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

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

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Concepto o Descripción</Text>
              <TextInput
                style={styles.input}
                placeholder={movementType === 'income' ? 'Ej. Cambio adicional' : 'Ej. Compra de bolsas, pasajes'}
                placeholderTextColor={ui.textMuted}
                value={movementReason}
                onChangeText={setMovementReason}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Categoría</Text>
              <View style={styles.categoryPickerRow}>
                {['petty_cash', 'services', 'supplies', 'payroll_advance'].map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[
                      styles.catChip,
                      movementCategory === cat && styles.catChipActive,
                    ]}
                    onPress={() => setMovementCategory(cat)}
                  >
                    <Text
                      style={[
                        styles.catChipText,
                        movementCategory === cat && styles.catChipTextActive,
                      ]}
                    >
                      {cat === 'petty_cash'
                        ? 'Caja Chica'
                        : cat === 'services'
                        ? 'Servicios'
                        : cat === 'supplies'
                        ? 'Insumos'
                        : 'Adelanto'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

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
      </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: ARQUEO Y CIERRE Z DE CAJA */}
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
        <Modal visible={closeModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Arqueo y Cierre Z</Text>
                <Text style={styles.modalSub}>Cuadre final de gaveta de efectivo</Text>
              </View>
              <TouchableOpacity
                onPress={() => setCloseModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar arqueo de caja"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.auditSummaryBox}>
              <Text style={styles.auditLabel}>Efectivo Esperado Según Sistema:</Text>
              <Text style={styles.auditAmount}>
                {formatPEN(activeCashSession?.expectedAmount ?? 0)}
              </Text>
            </View>

            {openFiados.length > 0 && (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Fiado que desea abonar</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
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
                </ScrollView>
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

            {calculatedDifference !== null && (
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
      </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: CIERRE EXITOSO Y TICKET TÉRMICO */}
      {/* ==================================================================== */}
      {closureSuccessModal && (
        <Modal visible={closureSuccessModal} transparent animationType="fade">
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
        </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: CREAR NUEVO CLIENTE (CON CONSULTA DNI/RUC) */}
      {/* ==================================================================== */}
      {newCustomerModalVisible && (
        <Modal visible={newCustomerModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { maxHeight: '90%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nuevo Cliente en Cartera</Text>
              <TouchableOpacity
                onPress={() => setNewCustomerModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de cliente"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
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
      </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: REGISTRAR ABONO DE FIADO */}
      {/* ==================================================================== */}
      {paymentModalVisible && (
        <Modal visible={paymentModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Abonar a Deuda</Text>
                <Text style={styles.modalSub}>{selectedDebtor?.name}</Text>
              </View>
              <TouchableOpacity
                onPress={() => setPaymentModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar abono de deuda"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.auditSummaryBox}>
              <Text style={styles.auditLabel}>Deuda Total Pendiente:</Text>
              <Text style={[styles.auditAmount, { color: ui.warning }]}>
                {formatPEN(selectedDebtor?.currentDebt ?? 0)}
              </Text>
            </View>

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
      </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: NUEVA RESERVA O PEDIDO */}
      {/* ==================================================================== */}
      {newReservationModalVisible && (
        <Modal visible={newReservationModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { maxHeight: '92%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nueva Reserva / Pedido</Text>
              <TouchableOpacity
                onPress={() => setNewReservationModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de reserva o pedido"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Selector de Tipo */}
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

              {/* Datos del Cliente */}
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

              {/* Selector de Productos */}
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

              {/* Lista de Ítems en la Reserva */}
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

              {/* Adelanto y Fechas */}
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
      </Modal>
      )}

      {payrollModalOpen && (
        <PayrollUsersModal
          visible={payrollModalOpen}
          onClose={() => setPayrollModalOpen(false)}
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
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  paymentBreakdownTitle: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: '700',
    color: ui.text,
  },
  paymentBreakdownTotal: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: '800',
    color: ui.primary,
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
});
