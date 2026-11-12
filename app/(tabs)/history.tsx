import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
  FlatList,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
  Image,
  InteractionManager,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import {
  Receipt,
  Bot,
  Search,
  Filter,
  Calendar,
  DollarSign,
  TrendingUp,
  CreditCard,
  Banknote,
  Printer,
  Share2,
  Trash2,
  RefreshCw,
  Send,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Clock,
  XCircle,
  FileText,
  ChevronRight,
  Info,
  X,
  MessageSquare,
  HelpCircle,
  ArrowUpRight,
  Barcode,
  Phone,
  Zap,
  ZapOff,
} from 'lucide-react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Header } from '@/components/Header';
import { ui, theme, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
} from 'firebase/firestore';

import { Sale, CartItem } from '@/types';
import { cancelSaleWithReversal, refundSaleLines } from '@/services/sale-service';
import {
  askVentyAI,
  getCustomers,
  BusinessKPIContext,
  completeOrCancelReservation,
} from '@/services/crm-operations-service';
import { getHistoryDateBounds, toEpochMillis } from '@/services/crm-compat';

import {
  buildSaleReceiptEscPos,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import { FinancialPnlModal } from '@/components/FinancialPnlModal';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';
import { ReservationCancellationModal } from '@/components/ReservationCancellationModal';

// Sub-módulos de Historial
type HistoryTab = 'sales' | 'reservations' | 'ai';
type DateRange = 'today' | 'week' | 'month' | 'custom' | 'all';
type DocFilter = 'all' | 'factura' | 'boleta' | 'nota_venta';

interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: number;
}

interface DocBadgeProps {
  sale: Sale;
}

const DocBadge = React.memo<DocBadgeProps>(({ sale }) => {
  const typeStr = String(sale.documentType || '').toLowerCase();
  const isCancelled = sale.status === 'cancelled';

  if (isCancelled) {
    return (
      <View style={[styles.badge, { backgroundColor: ui.dangerSoft }]}>
        <Text style={[styles.badgeText, { color: ui.danger, textDecorationLine: 'line-through' }]}>
          ANULADO
        </Text>
      </View>
    );
  }

  if (typeStr.includes('factura') || typeStr === '01') {
    return (
      <View style={[styles.badge, { backgroundColor: ui.accentSoft }]}>
        <Text style={[styles.badgeText, { color: ui.accent }]}>FACTURA</Text>
      </View>
    );
  }

  if (typeStr.includes('boleta') || typeStr === '03') {
    return (
      <View style={[styles.badge, { backgroundColor: ui.primarySoft }]}>
        <Text style={[styles.badgeText, { color: ui.primary }]}>BOLETA</Text>
      </View>
    );
  }

  return (
    <View style={[styles.badge, { backgroundColor: ui.surfaceMuted }]}>
      <Text style={[styles.badgeText, { color: ui.textSecondary }]}>NOTA VENTA</Text>
    </View>
  );
});

interface SunatBadgeProps {
  sale: Sale;
}

const SunatBadge = React.memo<SunatBadgeProps>(({ sale }) => {
  const status = sale.sunatStatus || 'not_applicable';
  if (status === 'accepted') {
    return (
      <View style={[styles.miniBadge, { backgroundColor: ui.primarySoft }]}>
        <CheckCircle2 size={12} color={ui.primary} />
        <Text style={[styles.miniBadgeText, { color: ui.primary }]}>SUNAT Aceptado</Text>
      </View>
    );
  }
  if (status === 'pending') {
    return (
      <View style={[styles.miniBadge, { backgroundColor: ui.warningSoft }]}>
        <Clock size={12} color={ui.warning} />
        <Text style={[styles.miniBadgeText, { color: ui.warning }]}>SUNAT Pendiente</Text>
      </View>
    );
  }
  if (status === 'rejected') {
    return (
      <View style={[styles.miniBadge, { backgroundColor: ui.dangerSoft }]}>
        <AlertTriangle size={12} color={ui.danger} />
        <Text style={[styles.miniBadgeText, { color: ui.danger }]}>SUNAT Observado</Text>
      </View>
    );
  }
  return null;
});

interface SaleCardItemProps {
  sale: Sale;
  onPress: (sale: Sale) => void;
}

const SaleCardItem = React.memo<SaleCardItemProps>(({ sale, onPress }) => {
  const isCancelled = sale.status === 'cancelled';
  const docNumber =
    sale.documentNumber || `V-${String(sale.saleNumber || 1).padStart(6, '0')}`;

  return (
    <TouchableOpacity
      style={[styles.saleCard, isCancelled && styles.saleCardCancelled]}
      onPress={() => onPress(sale)}
      accessibilityRole="button"
      accessibilityLabel={`Ver comprobante ${docNumber}, ${formatPEN(sale.total)}, ${sale.customerName || 'Cliente General'}${isCancelled ? ', anulada' : ''}`}
    >
      <View style={styles.saleCardTop}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <DocBadge sale={sale} />
            <Text style={styles.saleDocNumber}>{docNumber}</Text>
          </View>
          <Text style={styles.saleDateText}>{formatDatePE(sale.date)}</Text>
        </View>

        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={[
              styles.saleTotalText,
              isCancelled && { color: ui.textMuted, textDecorationLine: 'line-through' },
            ]}
          >
            {formatPEN(sale.total)}
          </Text>
          <Text style={styles.salePaymentMethod}>
            {(sale.paymentMethod || 'Efectivo').toUpperCase()}
          </Text>
        </View>
      </View>

      {/* Fila Cliente & SUNAT */}
      <View style={styles.saleCardBottom}>
        <Text style={styles.saleCustomerText} numberOfLines={1}>
          {sale.customerName ? `Cliente: ${sale.customerName}` : 'Cliente General'}
        </Text>
        <SunatBadge sale={sale} />
      </View>
    </TouchableOpacity>
  );
});

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { user, userProfile, accountId, branchId, role } = useAuth();
  const { canViewReports, canProcessReturn } = usePermissions();
  const {
    businessSettings,
    activeBranch,
    isCashOpen,
    activeCashSession,
    refreshCashStatus,
    posSettings,
  } = useSettings();

  const [activeTab, setActiveTab] = useState<HistoryTab>('sales');
  const [pnlModalOpen, setPnlModalOpen] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 1: HISTORIAL DE VENTAS Y SUNAT
  // ============================================================================
  const [sales, setSales] = useState<Sale[]>([]);
  const [loadingSales, setLoadingSales] = useState<boolean>(true);
  const [loadingMoreSales, setLoadingMoreSales] = useState<boolean>(false);
  const salesCursorRef = useRef<any>(null);
  const salesGenerationRef = useRef(0);
  const salesScopeRef = useRef('');
  const [salesHasMore, setSalesHasMore] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [customDateModalOpen, setCustomDateModalOpen] = useState<boolean>(false);
  const [docFilter, setDocFilter] = useState<DocFilter>('all');
  const salesScope = `${accountId || ''}|${branchId || ''}|${dateRange}|${customStartDate}|${customEndDate}`;
  // Keep the latest scope visible synchronously so an old request cannot commit
  // in the render/effect gap after the account, branch, or date range changes.
  salesScopeRef.current = salesScope;

  // Modal de Detalle de Comprobante
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [saleDetailModalVisible, setSaleDetailModalVisible] = useState<boolean>(false);

  // Modal de Anulación
  const [cancelModalVisible, setCancelModalVisible] = useState<boolean>(false);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [refundModalVisible, setRefundModalVisible] = useState(false);
  const [refundLineIndices, setRefundLineIndices] = useState<number[]>([]);
  const [refundPaymentMethod, setRefundPaymentMethod] = useState<'cash' | 'card' | 'digital'>('cash');
  const [isRefunding, setIsRefunding] = useState(false);

  // Impresión y compartir
  const [isPrinting, setIsPrinting] = useState<boolean>(false);
  const [isSharing, setIsSharing] = useState<boolean>(false);

  // Escáner de tickets inline (en ventanita embebida sin modal ni navegación)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [inlineScannerActive, setInlineScannerActive] = useState<boolean>(false);
  const [inlineTorchOn, setInlineTorchOn] = useState<boolean>(false);
  const scanCooldownRef = useRef<boolean>(false);

  const toggleInlineScanner = async () => {
    if (!inlineScannerActive) {
      if (!cameraPermission?.granted) {
        const res = await requestCameraPermission();
        if (!res.granted) {
          Alert.alert('Cámara Requerida', 'Se requiere permiso de cámara para escanear tickets o comprobantes.');
          return;
        }
      }
      setInlineScannerActive(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      setInlineScannerActive(false);
      setInlineTorchOn(false);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleInlineBarcodeScanned = useCallback((code: string) => {
    const clean = code?.trim();
    if (!clean || scanCooldownRef.current) return;
    scanCooldownRef.current = true;
    setTimeout(() => {
      scanCooldownRef.current = false;
    }, 1200);

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSearchQuery(clean);
  }, []);

  // Estados del Sub-Módulo de Reservas
  const [reservations, setReservations] = useState<any[]>([]);
  const [loadingReservations, setLoadingReservations] = useState<boolean>(false);
  const [reservationSearch, setReservationSearch] = useState<string>('');
  const [reservationStatusFilter, setReservationStatusFilter] = useState<'all' | 'pending' | 'completed' | 'cancelled'>('all');

  // Modal de Comprobante / Ticket de Reserva
  const [receiptReservation, setReceiptReservation] = useState<any | null>(null);
  const [receiptModalVisible, setReceiptModalVisible] = useState(false);
  const [cancellationTarget, setCancellationTarget] = useState<any | null>(null);

  // Modal de Cobro de Saldo Pendiente de Reserva
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [reservationToPay, setReservationToPay] = useState<any | null>(null);
  const [payMethod, setPayMethod] = useState<'efectivo' | 'yape' | 'plin' | 'tarjeta' | 'transferencia'>('efectivo');
  const [payCashReceived, setPayCashReceived] = useState<string>('');
  const [isCompletingPayment, setIsCompletingPayment] = useState(false);

  // Filtrado de Reservas por texto y estado
  const filteredReservations = useMemo(() => {
    const q = reservationSearch.trim().toLowerCase();
    return reservations.filter((res) => {
      if (reservationStatusFilter !== 'all') {
        const status = res.status || 'pending';
        if (status !== reservationStatusFilter) return false;
      }
      if (!q) return true;
      const custName = (res.customer?.name || '').toLowerCase();
      const custPhone = (res.customer?.phone || '').toLowerCase();
      const notes = (res.notes || '').toLowerCase();
      const correlative = (res.correlative || '').toLowerCase();
      const itemsMatch =
        Array.isArray(res.items) &&
        res.items.some((it: any) =>
          (it.productName || it.name || '').toLowerCase().includes(q)
        );
      return (
        custName.includes(q) ||
        custPhone.includes(q) ||
        notes.includes(q) ||
        correlative.includes(q) ||
        itemsMatch
      );
    });
  }, [reservations, reservationSearch, reservationStatusFilter]);

  const handleOpenPayReservation = (res: any) => {
    setReservationToPay(res);
    const totalVal = Number(res.total || 0);
    const depositVal = Number(res.depositAmount || 0);
    const remaining = Math.max(0, totalVal - depositVal);
    setPayCashReceived(remaining.toFixed(2));
    setPayMethod('efectivo');
    setPaymentModalVisible(true);
  };

  const handleConfirmCompletePayment = async () => {
    if (!reservationToPay) return;
    const totalVal = Number(reservationToPay.total || 0);
    const depositVal = Number(reservationToPay.depositAmount || 0);
    const remaining = Math.max(0, totalVal - depositVal);

    setIsCompletingPayment(true);
    try {
      const sessId = activeCashSession?.sessionId || activeCashSession?.id;
      await completeOrCancelReservation(
        {
          id: reservationToPay.id,
          accountId: reservationToPay.accountId || accountId,
          branchId: reservationToPay.branchId || branchId,
          type: reservationToPay.type || 'reservation',
          items: reservationToPay.items || [],
          total: totalVal,
          depositAmount: depositVal,
          remainingAmount: remaining,
          status: 'pending',
          customer: reservationToPay.customer || { name: 'Cliente General' },
          createdBy: reservationToPay.createdBy || user?.uid || 'user',
          createdAt: reservationToPay.createdAt || Date.now(),
        },
        'complete',
        {
          uid: user?.uid || 'user',
          displayName: userProfile?.displayName || user?.email || 'Usuario',
          email: user?.email || '',
        },
        {
          paymentMethod: payMethod,
          amount: remaining,
          sessionId: sessId,
        }
      );

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPaymentModalVisible(false);
      refreshCashStatus();

      // Abrir comprobante final entregado
      setReceiptReservation({
        ...reservationToPay,
        status: 'completed',
        depositAmount: totalVal,
        remainingAmount: 0,
      });
      setReceiptModalVisible(true);
    } catch (err: any) {
      Alert.alert('Error al Cobrar', err?.message || 'No se pudo completar el cobro y entrega.');
    } finally {
      setIsCompletingPayment(false);
    }
  };

  const handleCompleteReservation = async (res: any) => {
    Alert.alert(
      'Confirmar Entrega',
      `¿Confirmas la entrega de los productos a ${res.customer?.name || 'Cliente General'}? Se descontará el inventario físico y se marcará como entregado.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar Entrega',
          onPress: async () => {
            try {
              const totalVal = Number(res.total || 0);
              const depositVal = Number(res.depositAmount || 0);
              const sessId = activeCashSession?.sessionId || activeCashSession?.id;
              await completeOrCancelReservation(
                {
                  id: res.id,
                  accountId: res.accountId || accountId,
                  branchId: res.branchId || branchId,
                  type: res.type || 'reservation',
                  items: res.items || [],
                  total: totalVal,
                  depositAmount: depositVal,
                  remainingAmount: 0,
                  status: 'pending',
                  customer: res.customer || { name: 'Cliente General' },
                  createdBy: res.createdBy || user?.uid || 'user',
                  createdAt: res.createdAt || Date.now(),
                },
                'complete',
                {
                  uid: user?.uid || 'user',
                  displayName: userProfile?.displayName || user?.email || 'Usuario',
                  email: user?.email || '',
                },
                {
                  paymentMethod: 'efectivo',
                  amount: 0,
                  sessionId: sessId,
                }
              );
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setReceiptReservation({ ...res, status: 'completed' });
              setReceiptModalVisible(true);
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'No se pudo completar la entrega.');
            }
          },
        },
      ]
    );
  };

  const handleCancelReservation = async (res: any) => setCancellationTarget(res);

  const confirmReservationCancellation = async (refund: { refundMethod?: string; refundPercent?: number }) => {
    if (!cancellationTarget) return;
    const res = cancellationTarget;
    const totalVal = Number(res.total || 0);
    const depositVal = Number(res.depositAmount || 0);
    try {
      await completeOrCancelReservation(
        {
          id: res.id,
          accountId: res.accountId || accountId,
          branchId: res.branchId || branchId,
          type: res.type || 'reservation',
          items: res.items || [],
          total: totalVal,
          depositAmount: depositVal,
          remainingAmount: Math.max(0, totalVal - depositVal),
          status: 'pending',
          customer: res.customer || { name: 'Cliente General' },
          createdBy: res.createdBy || user?.uid || 'user',
          createdAt: res.createdAt || Date.now(),
        },
        'cancel',
        {
          uid: user?.uid || 'user',
          displayName: userProfile?.displayName || user?.email || 'Usuario',
          email: user?.email || '',
        },
        { sessionId: activeCashSession?.sessionId || activeCashSession?.id, ...refund },
      );
      setCancellationTarget(null);
      void refreshCashStatus();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Cancelación completada', refund.refundMethod ? 'Se liberó el stock y se registró el reembolso.' : 'Se liberó el stock. El adelanto quedó retenido.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo cancelar la reserva.');
    }
  };

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 2: ASISTENTE VENTY IA
  // ============================================================================
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'ai',
      text: '¡Hola! Soy Venty IA, tu asistente inteligente de negocio. Puedo ayudarte con métricas de ventas en tiempo real, control de gaveta de efectivo, productos críticos y cuentas de fiado. ¿Qué te gustaría consultar hoy?',
      timestamp: Date.now(),
    },
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);
  const chatScrollRef = useRef<ScrollView>(null);

  // Contexto en vivo para la IA
  const [kpiContext, setKpiContext] = useState<BusinessKPIContext>({});

  // ============================================================================
  // CARGA PAGINADA DE VENTAS CON RANGO APLICADO EN FIRESTORE
  // ============================================================================
  const fetchSalesPage = useCallback(async (reset: boolean) => {
    if (!accountId) {
      setSales([]);
      setLoadingSales(false);
      setSalesHasMore(false);
      salesCursorRef.current = null;
      return;
    }
    if (reset) {
      salesGenerationRef.current += 1;
      salesScopeRef.current = salesScope;
      salesCursorRef.current = null;
      setLoadingSales(true);
    }
    else setLoadingMoreSales(true);
    const generation = salesGenerationRef.current;
    const requestScope = salesScope;
    try {
      const bounds = getHistoryDateBounds(dateRange, customStartDate, customEndDate);
      const constraints: any[] = [where('accountId', '==', accountId)];
      if (branchId && branchId !== 'main') constraints.push(where('branchId', '==', branchId));
      if (bounds.start !== undefined) constraints.push(where('date', '>=', bounds.start));
      if (bounds.end !== undefined) constraints.push(where('date', '<=', bounds.end));
      constraints.push(orderBy('date', 'desc'));
      if (!reset && salesCursorRef.current) constraints.push(startAfter(salesCursorRef.current));
      constraints.push(limit(100));
      const snapshot = await getDocs(query(collection(db, 'sales'), ...constraints));
      if (generation !== salesGenerationRef.current || requestScope !== salesScopeRef.current) return;
      const page: Sale[] = snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as any) }));
      setSales((current) => {
        if (reset) return page;
        const byId = new Map(current.map((sale) => [sale.id, sale]));
        page.forEach((sale) => byId.set(sale.id, sale));
        return [...byId.values()];
      });
      salesCursorRef.current = snapshot.docs.at(-1) || null;
      setSalesHasMore(snapshot.docs.length === 100);
    } catch (err: any) {
      if (generation !== salesGenerationRef.current || requestScope !== salesScopeRef.current) return;
      console.warn('Error cargando página de ventas:', err);
      if (reset) setSales([]);
      Alert.alert('No se pudo cargar el historial', err?.message || 'Revisa tu conexión y vuelve a intentar.');
    } finally {
      if (generation === salesGenerationRef.current && requestScope === salesScopeRef.current) {
        setLoadingSales(false);
        setLoadingMoreSales(false);
      }
    }
  }, [accountId, branchId, dateRange, customStartDate, customEndDate, salesScope]);

  useEffect(() => {
    setSalesHasMore(false);
    const task = InteractionManager.runAfterInteractions(() => {
      void fetchSalesPage(true);
    });
    return () => task.cancel();
  }, [fetchSalesPage]);

  // Escuchar Reservas de la Sucursal
  useEffect(() => {
    if (!accountId || activeTab !== 'reservations') return;
    setLoadingReservations(true);

    let cancelled = false;
    let unsubscribeActive: (() => void) | null = null;

    const attachListener = (useOrderedQuery: boolean) => {
      const q = useOrderedQuery
        ? query(
            collection(db, 'reservations'),
            where('accountId', '==', accountId),
            where('branchId', '==', branchId),
            orderBy('createdAt', 'desc'),
            limit(50)
          )
        : query(
            collection(db, 'reservations'),
            where('accountId', '==', accountId),
            where('branchId', '==', branchId),
            limit(50)
          );

      unsubscribeActive = onSnapshot(
        q,
        (snapshot) => {
          if (cancelled) return;
          const list: any[] = [];
          snapshot.forEach((d) => {
            list.push({ id: d.id, ...d.data() });
          });
          if (!useOrderedQuery) {
            list.sort((a, b) => {
              const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt || 0);
              const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt || 0);
              return tB - tA;
            });
          }
          setReservations(list);
          setLoadingReservations(false);
        },
        (error: any) => {
          if (cancelled) return;
          if (useOrderedQuery && String(error?.code || '').includes('failed-precondition')) {
            if (unsubscribeActive) {
              unsubscribeActive();
              unsubscribeActive = null;
            }
            attachListener(false);
            return;
          }
          console.warn('Error loading reservations:', error);
          setLoadingReservations(false);
        }
      );
    };

    const task = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) {
        attachListener(true);
      }
    });

    return () => {
      cancelled = true;
      task.cancel();
      if (unsubscribeActive) unsubscribeActive();
    };
  }, [accountId, branchId, activeTab]);

  // ============================================================================
  // FILTRADO DE VENTAS POR FECHA, TIPO Y BÚSQUEDA
  // ============================================================================
  const filteredSales = useMemo(() => {
    const bounds = getHistoryDateBounds(dateRange, customStartDate, customEndDate);

    return sales.filter((sale) => {
      const saleDate = toEpochMillis(sale.date || (sale as any).createdAt);

      // 1. Filtro por Rango de Fechas
      if (bounds.start !== undefined && saleDate < bounds.start) return false;
      if (bounds.end !== undefined && saleDate > bounds.end) return false;

      // 2. Filtro por Tipo de Comprobante
      if (docFilter !== 'all') {
        const docTypeStr = String(sale.documentType || '').toLowerCase();
        if (docFilter === 'factura' && !docTypeStr.includes('factura') && docTypeStr !== '01') return false;
        if (docFilter === 'boleta' && !docTypeStr.includes('boleta') && docTypeStr !== '03') return false;
        if (docFilter === 'nota_venta' && docTypeStr.includes('factura') && docTypeStr.includes('boleta')) return false;
      }

      // 3. Filtro por Búsqueda
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase().trim();
        const docNum = String(sale.documentNumber || sale.saleNumber || '').toLowerCase();
        const custName = String(sale.customerName || '').toLowerCase();
        const custDoc = String(sale.customerDni || sale.customerRuc || '').toLowerCase();
        if (!docNum.includes(q) && !custName.includes(q) && !custDoc.includes(q)) {
          return false;
        }
      }

      return true;
    });
  }, [sales, dateRange, customStartDate, customEndDate, docFilter, searchQuery]);

  // ============================================================================
  // KPIS FINANCIEROS DEL PERIODO SELECCIONADO
  // ============================================================================
  const periodKpis = useMemo(() => {
    let totalSales = 0;
    let totalCost = 0;
    let cashSales = 0;
    let digitalSales = 0;
    let completedCount = 0;

    filteredSales.forEach((s) => {
      if (s.status === 'cancelled') return; // Excluir ventas anuladas

      const total = Number(s.total) || 0;
      totalSales += total;
      completedCount += 1;

      // Costo o margen
      if (s.totalCost) {
        totalCost += s.totalCost;
      } else {
        totalCost += total * 0.7; // Estimación base del 30% margen si no está explícito
      }

      // Desglose Efectivo vs Digital
      const method = String(s.paymentMethod || '').toLowerCase();
      if (method.includes('efectivo') || method.includes('cash')) {
        cashSales += total;
      } else {
        digitalSales += total;
      }
    });

    const grossProfit = Math.max(0, totalSales - totalCost);
    const avgTicket = completedCount > 0 ? totalSales / completedCount : 0;
    const cashPercent = totalSales > 0 ? Math.round((cashSales / totalSales) * 100) : 0;
    const digitalPercent = totalSales > 0 ? Math.round((digitalSales / totalSales) * 100) : 0;

    return {
      totalSales: Math.round(totalSales * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      avgTicket: Math.round(avgTicket * 100) / 100,
      cashSales: Math.round(cashSales * 100) / 100,
      digitalSales: Math.round(digitalSales * 100) / 100,
      cashPercent,
      digitalPercent,
      salesCount: completedCount,
    };
  }, [filteredSales]);

  // ============================================================================
  // ACTUALIZAR CONTEXTO PARA VENTY IA
  // ============================================================================
  const [totalCustomerDebt, setTotalCustomerDebt] = useState<number>(0);

  useEffect(() => {
    if (!accountId || activeTab !== 'ai') return;
    let isCancelled = false;
    getCustomers(accountId).then((custs) => {
      if (isCancelled) return;
      let totalDebt = 0;
      custs.forEach((c) => {
        totalDebt += Number(c.currentDebt) || 0;
      });
      setTotalCustomerDebt(Math.round(totalDebt * 100) / 100);
    }).catch(() => {});
    return () => {
      isCancelled = true;
    };
  }, [accountId, activeTab]);

  useEffect(() => {
    if (!accountId) return;
    setKpiContext({
      todaySales: periodKpis.totalSales,
      salesCount: periodKpis.salesCount,
      cashInDrawer: activeCashSession?.expectedAmount || 0,
      totalDebt: totalCustomerDebt,
      branchName: activeBranch?.name || 'Tienda Principal',
      activeOperator: userProfile?.displayName || user?.email || 'Operador',
    });
  }, [accountId, periodKpis, activeCashSession?.expectedAmount, totalCustomerDebt, activeBranch?.name, userProfile?.displayName, user?.email, setKpiContext]);

  // ============================================================================
  // ACCIONES DEL COMPROBANTE: REIMPRESIÓN, COMPARTIR Y ANULACIÓN
  // ============================================================================
  const handlePrintSale = async (sale: Sale) => {
    setIsPrinting(true);
    try {
      const bytes = buildSaleReceiptEscPos(
        sale,
        { ...businessSettings, ...activeBranch },
        { autoCut: true, openDrawer: false }
      );

      const success = await printRawEscPos(bytes);
      if (!success) {
        // Fallback a impresión nativa PDF
        await printTicketPDF({
          title: `Ticket_${sale.documentNumber || sale.id}`,
          sale,
          business: { ...businessSettings, ...activeBranch },
        });
      }
      Alert.alert('Ticket Enviado', 'El comprobante ha sido enviado a la impresora.');
    } catch (err: any) {
      Alert.alert('Error de Impresión', err?.message || 'No se pudo emitir el ticket.');
    } finally {
      setIsPrinting(false);
    }
  };

  const handleShareWhatsApp = async (sale: Sale) => {
    setIsSharing(true);
    try {
      const phone = sale.customerPhone || '';
      await shareTicketWhatsApp(sale, { ...businessSettings, ...activeBranch }, phone);
    } catch (err: any) {
      Alert.alert('Error al Compartir', err?.message || 'No se pudo generar el documento PDF.');
    } finally {
      setIsSharing(false);
    }
  };

  const handleConfirmCancelSale = async () => {
    if (!selectedSale) return;
    if (!canProcessReturn) {
      Alert.alert('Acceso Denegado', 'No cuentas con permisos para anular ventas ni revertir inventario.');
      return;
    }
    if (!cancelReason.trim()) {
      Alert.alert('Motivo Requerido', 'Indique la razón justificada de la anulación.');
      return;
    }
    if (!user) return;

    setIsCancelling(true);
    try {
      await cancelSaleWithReversal(selectedSale.id, cancelReason.trim(), {
        uid: user.uid,
        displayName: userProfile?.displayName || user.email || 'Operador',
        email: user.email,
        role,
      });

      setCancelModalVisible(false);
      setSaleDetailModalVisible(false);
      setCancelReason('');
      setSelectedSale(null);
      refreshCashStatus();

      Alert.alert(
        'Venta Anulada',
        'El comprobante ha sido marcado como ANULADO, el stock físico fue restaurado en inventario y registrado en Kardex.'
      );
    } catch (err: any) {
      Alert.alert('Error al Anular Venta', err?.message || 'No se pudo anular la venta.');
    } finally {
      setIsCancelling(false);
    }
  };

  const handleRefundSelectedLines = async () => {
    if (!selectedSale || !user) return;
    if (!canProcessReturn) {
      Alert.alert('Acceso Denegado', 'No cuentas con permisos para procesar devoluciones.');
      return;
    }
    if (refundLineIndices.length === 0) {
      Alert.alert('Seleccione artículos', 'Seleccione al menos un artículo para devolver.');
      return;
    }
    const amount = refundLineIndices.reduce((sum, index) => {
      const line = selectedSale.items?.[index];
      return sum + (Number(line?.lineTotal) || Number(line?.price || 0) * Number(line?.quantity || 0));
    }, 0);
    setIsRefunding(true);
    try {
      const sessionId = activeCashSession?.sessionId || activeCashSession?.id;
      if (!sessionId) throw new Error('Abre una caja antes de registrar una devolución.');
      const refundBranchId = selectedSale.branchId || branchId;
      if (!accountId || !refundBranchId) throw new Error('No se pudo determinar la cuenta y sucursal de la venta.');
      await refundSaleLines(selectedSale.id, refundLineIndices, {
        accountId,
        branchId: refundBranchId,
        sessionId,
        method: refundPaymentMethod,
        cashAmount: refundPaymentMethod === 'cash' ? amount : 0,
        cardAmount: refundPaymentMethod === 'card' ? amount : 0,
        digitalAmount: refundPaymentMethod === 'digital' ? amount : 0,
        operationId: `refund-${selectedSale.id}-${refundLineIndices.slice().sort((a, b) => a - b).join('-')}`,
      });
      setRefundModalVisible(false);
      setSaleDetailModalVisible(false);
      setRefundLineIndices([]);
      await fetchSalesPage(true);
      await refreshCashStatus();
      Alert.alert('Devolución registrada', `${formatPEN(amount)} se registró como devolución parcial y el stock retornó al inventario.`);
    } catch (error: any) {
      Alert.alert('No se pudo devolver', error?.message || 'Revisa la venta e inténtalo nuevamente.');
    } finally {
      setIsRefunding(false);
    }
  };

  // ============================================================================
  // ACCIONES DE VENTY IA
  // ============================================================================
  const handleSendAiMessage = async (customText?: string) => {
    const textToSend = customText || chatInput;
    if (!textToSend.trim()) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sender: 'user',
      text: textToSend.trim(),
      timestamp: Date.now(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    if (!customText) setChatInput('');
    setIsAiLoading(true);

    setTimeout(() => {
      chatScrollRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await askVentyAI({
        prompt: textToSend.trim(),
        contextSummary: kpiContext,
      });

      const aiMsg: ChatMessage = {
        id: `ai_${Date.now()}`,
        sender: 'ai',
        text: typeof response === 'string' ? response : (response as any)?.reply || '',
        timestamp: Date.now(),
      };

      setChatMessages((prev) => [...prev, aiMsg]);
    } catch (err: any) {
      const errReply: ChatMessage = {
        id: `err_${Date.now()}`,
        sender: 'ai',
        text: 'Lo siento, ocurrió un error temporal al procesar la respuesta. Por favor intenta nuevamente.',
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, errReply]);
    } finally {
      setIsAiLoading(false);
      setTimeout(() => {
        chatScrollRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  // Chips de preguntas rápidas
  const quickChips = [
    '¿Cuánto vendí hoy y cuál es mi ganancia?',
    '¿Qué productos están por agotarse?',
    '¿Cuánto efectivo debe haber en caja?',
    '¿Qué clientes tienen deuda de fiado?',
  ];

  const handleSelectSale = useCallback((sale: Sale) => {
    setSelectedSale(sale);
    setSaleDetailModalVisible(true);
  }, []);

  const renderHistorySaleItem = useCallback(
    ({ item }: { item: Sale }) => <SaleCardItem sale={item} onPress={handleSelectSale} />,
    [handleSelectSale]
  );

  const saleKeyExtractor = useCallback((item: Sale) => item.id, []);

  const saleItemType = useCallback(() => 'sale', []);

  const handleSalesEndReached = useCallback(() => {
    if (salesHasMore && !loadingSales && !loadingMoreSales) {
      void fetchSalesPage(false);
    }
  }, [salesHasMore, loadingSales, loadingMoreSales, fetchSalesPage]);

  const salesListContentStyle = useMemo(
    () => ({ paddingHorizontal: 20, paddingTop: 12, paddingBottom: insets.bottom + 80 }),
    [insets.bottom]
  );

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <View style={styles.screen}>
      <Header />

      <View style={styles.compactHeaderRow}>
        <Text style={styles.compactHeaderTitle}>
          {activeTab === 'sales' ? 'Ventas' : activeTab === 'reservations' ? 'Reservas' : 'Venty IA'}
        </Text>
        {activeTab === 'sales' && canViewReports ? (
          <TouchableOpacity
            style={styles.compactPnlButton}
            onPress={() => setPnlModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir estado de resultados"
          >
            <TrendingUp size={15} color={ui.primary} />
            <Text style={styles.compactPnlButtonText}>Estado de resultados</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Navegación principal de ventas */}
      <View style={styles.tabSelectorRowCentered}>
        <TouchableOpacity
          style={[styles.tabButtonCentered, activeTab === 'sales' && styles.tabButtonActive]}
          onPress={() => setActiveTab('sales')}
          accessibilityRole="tab"
          accessibilityLabel="Comprobantes y reportes"
          accessibilityState={{ selected: activeTab === 'sales' }}
        >
          <Receipt size={17} color={activeTab === 'sales' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.tabButtonText, activeTab === 'sales' && styles.tabButtonTextActive]}>
            Comprobantes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButtonCentered, activeTab === 'reservations' && styles.tabButtonActive]}
          onPress={() => setActiveTab('reservations')}
          accessibilityRole="tab"
          accessibilityLabel="Reservas activas"
          accessibilityState={{ selected: activeTab === 'reservations' }}
        >
          <Calendar size={17} color={activeTab === 'reservations' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.tabButtonText, activeTab === 'reservations' && styles.tabButtonTextActive]}>
            Reservas
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButtonCentered, activeTab === 'ai' && styles.tabButtonActive]}
          onPress={() => setActiveTab('ai')}
          accessibilityRole="tab"
          accessibilityLabel="Asistente Venty IA"
          accessibilityState={{ selected: activeTab === 'ai' }}
        >
          <Image
            source={require('../../assets/venty-icon.webp')}
            style={{ width: 18, height: 18 }}
            resizeMode="contain"
          />
          <Text style={[styles.tabButtonText, activeTab === 'ai' && styles.tabButtonTextActive]}>
            Asistente IA
          </Text>
        </TouchableOpacity>
      </View>

      {/* ==================================================================== */}
      {/* SUB-MÓDULO 1: HISTORIAL DE VENTAS Y SUNAT */}
      {/* ==================================================================== */}
      {activeTab === 'sales' && (
        <View style={{ flex: 1 }}>
          <FlashList
            data={loadingSales ? [] : filteredSales}
            renderItem={renderHistorySaleItem}
            keyExtractor={saleKeyExtractor}
            getItemType={saleItemType}
            estimatedItemSize={94}
            contentContainerStyle={salesListContentStyle}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            onEndReachedThreshold={0.4}
            onEndReached={handleSalesEndReached}
            ListHeaderComponent={
              <>
          {/* Fila unificada: Resumen del período + Filtros de fecha */}
          <View style={styles.summaryWithFiltersRow}>
            <View style={styles.summaryTitleCol}>
              <Text style={styles.summaryTitleText}>Resumen</Text>
              <Text style={styles.summarySubText}>{periodKpis.salesCount} comp.</Text>
            </View>

            <View style={styles.filterChipRowCompact}>
              {[
                { id: 'today', label: 'Hoy' },
                { id: 'week', label: '7d' },
                { id: 'month', label: 'Mes' },
                {
                  id: 'custom',
                  label:
                    dateRange === 'custom' && customStartDate && customEndDate
                      ? `${customStartDate.slice(5)}`
                      : 'Pers.',
                },
                { id: 'all', label: 'Todos' },
              ].map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[
                    styles.rangeChipCompact,
                    dateRange === item.id && styles.rangeChipCompactActive,
                  ]}
                  onPress={() => {
                    if (item.id === 'custom') {
                      if (!customStartDate) {
                        const now = new Date();
                        const pad = (n: number) => String(n).padStart(2, '0');
                        const endStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                        const sevenAgo = new Date(Date.now() - 7 * 86400000);
                        const startStr = `${sevenAgo.getFullYear()}-${pad(sevenAgo.getMonth() + 1)}-${pad(sevenAgo.getDate())}`;
                        setCustomStartDate(startStr);
                        setCustomEndDate(endStr);
                      }
                      setCustomDateModalOpen(true);
                    } else {
                      setDateRange(item.id as DateRange);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Filtrar por fecha: ${item.label}`}
                  accessibilityState={{ selected: dateRange === item.id }}
                >
                  <Text
                    style={[
                      styles.rangeChipTextCompact,
                      dateRange === item.id && styles.rangeChipTextCompactActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {/* Resumen principal y métricas de apoyo */}
          <View style={styles.kpiContainer}>
            <View style={styles.kpiGrid}>
              <View style={[styles.kpiBox, styles.totalSalesHero]}>
                <Text style={styles.kpiBoxLabel}>Ventas totales</Text>
                <Text style={[styles.kpiBoxValue, styles.totalSalesValue]}>
                  {formatPEN(periodKpis.totalSales)}
                </Text>
                <Text style={styles.kpiBoxFoot}>En el período seleccionado</Text>
              </View>

              <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
                <Text style={styles.kpiBoxLabel}>Ganancia bruta</Text>
                <Text style={[styles.kpiBoxValue, { color: ui.primary }]}>
                  {formatPEN(periodKpis.grossProfit)}
                </Text>
                <Text style={styles.kpiBoxFoot}>Margen estimado</Text>
              </View>

              <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
                <Text style={styles.kpiBoxLabel}>Ticket promedio</Text>
                <Text style={[styles.kpiBoxValue, { color: ui.accent }]}>
                  {formatPEN(periodKpis.avgTicket)}
                </Text>
                <Text style={styles.kpiBoxFoot}>Por venta</Text>
              </View>

              <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
                <Text style={styles.kpiBoxLabel}>Efectivo y digital</Text>
                <Text style={[styles.kpiBoxValue, { color: ui.warning, fontSize: 16 }]}>
                  {periodKpis.cashPercent}% / {periodKpis.digitalPercent}%
                </Text>
                <Text style={styles.kpiBoxFoot}>
                  {formatPEN(periodKpis.cashSales)} / {formatPEN(periodKpis.digitalSales)}
                </Text>
              </View>
            </View>
          </View>

          {/* Buscador de Ventas */}
          <View style={styles.searchRow}>
            <View style={[styles.searchBox, { flex: 1 }]}>
              <Search size={18} color={ui.textMuted} />
              <TextInput
                style={styles.searchInput}
                accessibilityLabel="Buscar comprobantes por número, cliente o DNI/RUC"
                placeholder="Buscar por N°, cliente o DNI/RUC..."
                placeholderTextColor={ui.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearchQuery('')}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel="Limpiar búsqueda"
                >
                  <X size={16} color={ui.textMuted} />
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={[
                styles.barcodeScanBtn,
                inlineScannerActive && { backgroundColor: ui.primary, borderColor: ui.primary },
              ]}
              onPress={toggleInlineScanner}
              accessibilityRole="button"
              accessibilityLabel="Escanear ticket o comprobante"
              activeOpacity={0.7}
            >
              <Barcode size={20} color={inlineScannerActive ? ui.onPrimary : ui.primary} />
            </TouchableOpacity>
          </View>

          {/* Ventanita de Lector de Código de Barras Inline (sin cambiar de página) */}
          {inlineScannerActive && (
            <View style={styles.inlineScannerCard}>
              <View style={styles.inlineScannerTopBar}>
                <View style={styles.inlineScannerTitleWrap}>
                  <Barcode size={16} color={ui.primary} />
                  <Text style={styles.inlineScannerTitle}>Lector de Tickets</Text>
                </View>
                <View style={styles.inlineScannerActions}>
                  <TouchableOpacity
                    style={[styles.inlineScannerActionBtn, inlineTorchOn && styles.inlineScannerActionBtnActive]}
                    onPress={() => setInlineTorchOn((prev) => !prev)}
                    accessibilityRole="button"
                    accessibilityLabel="Alternar linterna"
                  >
                    {inlineTorchOn ? <ZapOff size={14} color={ui.onPrimary} /> : <Zap size={14} color={ui.textSecondary} />}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.inlineScannerActionBtn}
                    onPress={() => {
                      setInlineScannerActive(false);
                      setInlineTorchOn(false);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar lector"
                  >
                    <X size={14} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.inlineCameraBox}>
                <CameraView
                  style={styles.inlineCamera}
                  facing="back"
                  enableTorch={inlineTorchOn}
                  barcodeScannerSettings={{
                    barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e'],
                  }}
                  onBarcodeScanned={(result) => handleInlineBarcodeScanned(result.data)}
                />
                <View style={styles.inlineReticle} />
                <View style={styles.inlineScanBanner}>
                  <Text style={styles.inlineScanBannerText}>Apunta la cámara al código del comprobante</Text>
                </View>
              </View>
            </View>
          )}

          {/* Filtros de Tipo de Documento */}
          <View style={styles.docFilterRow}>
            {(
              [
                { id: 'all', label: 'Todos' },
                { id: 'factura', label: 'Facturas' },
                { id: 'boleta', label: 'Boletas' },
                { id: 'nota_venta', label: 'Notas' },
              ] as const
            ).map((d) => (
              <TouchableOpacity
                key={d.id}
                style={[styles.docChip, docFilter === d.id && styles.docChipActive]}
                onPress={() => setDocFilter(d.id)}
                accessibilityRole="button"
                accessibilityLabel={`Filtrar comprobantes: ${d.label}`}
                accessibilityState={{ selected: docFilter === d.id }}
              >
                <Text style={[styles.docChipText, docFilter === d.id && styles.docChipTextActive]}>
                  {d.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

              </>
            }
            ListEmptyComponent={
              loadingSales ? (
                <ActivityIndicator color={ui.primary} style={{ marginVertical: 40 }} />
              ) : (
                <View style={styles.emptyContainer}>
                  <Receipt size={44} color={ui.textMuted} />
                  <Text style={styles.emptyTitle}>
                    {sales.length === 0 ? 'Aún no hay comprobantes' : 'Sin ventas con estos filtros'}
                  </Text>
                  <Text style={styles.emptySub}>
                    {sales.length === 0
                      ? 'Las ventas registradas aparecerán aquí.'
                      : 'Prueba otro periodo, tipo de comprobante o búsqueda.'}
                  </Text>
                </View>
              )
            }
            ListFooterComponent={
              salesHasMore && !loadingSales ? (
                <TouchableOpacity
                  style={[styles.confirmCancelBtn, { marginHorizontal: 20, marginTop: 12, marginBottom: 20 }]}
                  onPress={() => void fetchSalesPage(false)}
                  disabled={loadingMoreSales}
                >
                  {loadingMoreSales ? (
                    <ActivityIndicator color={ui.onPrimary} />
                  ) : (
                    <Text style={styles.confirmCancelBtnText}>Cargar más ventas</Text>
                  )}
                </TouchableOpacity>
              ) : null
            }
          />
        </View>
      )}

      {/* ==================================================================== */}
      {/* SUB-MÓDULO: RESERVAS Y STOCK APARTADO */}
      {/* ==================================================================== */}
      {activeTab === 'reservations' && (
        <ScrollView
          style={styles.contentContainer}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.reservationsHeaderBanner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.reservationsBannerTitle}>Reservas en Sucursal</Text>
              <Text style={styles.reservationsBannerSub}>
                {filteredReservations.length} {filteredReservations.length === 1 ? 'reserva encontrada' : 'reservas encontradas'}
              </Text>
            </View>
          </View>

          {/* Buscador de Reservas */}
          <View style={[styles.searchRow, { marginTop: 10 }]}>
            <View style={[styles.searchBox, { flex: 1 }]}>
              <Search size={18} color={ui.textMuted} />
              <TextInput
                style={styles.searchInput}
                accessibilityLabel="Buscar reservas por cliente, teléfono o producto"
                placeholder="Buscar por cliente, teléfono o producto..."
                placeholderTextColor={ui.textMuted}
                value={reservationSearch}
                onChangeText={setReservationSearch}
              />
              {reservationSearch.length > 0 && (
                <TouchableOpacity
                  onPress={() => setReservationSearch('')}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel="Limpiar búsqueda"
                >
                  <X size={16} color={ui.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Filtros de estado de reserva */}
          <View style={[styles.docFilterRow, { marginBottom: 12 }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {[
                { id: 'all', label: 'Todas' },
                { id: 'pending', label: 'Pendientes' },
                { id: 'completed', label: 'Entregadas' },
                { id: 'cancelled', label: 'Canceladas' },
              ].map((f) => (
                <TouchableOpacity
                  key={f.id}
                  style={[
                    styles.docChip,
                    reservationStatusFilter === f.id && styles.docChipActive,
                  ]}
                  onPress={() => setReservationStatusFilter(f.id as any)}
                  accessibilityRole="button"
                  accessibilityLabel={`Filtrar reservas por ${f.label}`}
                >
                  <Text
                    style={[
                      styles.docChipText,
                      reservationStatusFilter === f.id && styles.docChipTextActive,
                    ]}
                  >
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {loadingReservations ? (
            <ActivityIndicator color={ui.primary} style={{ marginVertical: 40 }} />
          ) : filteredReservations.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Calendar size={44} color={ui.textMuted} />
              <Text style={styles.emptyTitle}>
                {reservations.length === 0 ? 'No hay reservas registradas' : 'No se encontraron reservas'}
              </Text>
              <Text style={styles.emptySub}>
                {reservations.length === 0
                  ? 'Las reservas creadas desde el POS aparecerán aquí con su estado, seña recibida y saldo pendiente.'
                  : 'Prueba otro término de búsqueda o cambia el filtro de estado.'}
              </Text>
            </View>
          ) : (
            <View style={styles.reservationsList}>
              {filteredReservations.map((res) => {
                const isPending = res.status === 'pending' || !res.status;
                const isCompleted = res.status === 'completed';
                const isCancelled = res.status === 'cancelled';
                const deposit = Number(res.depositAmount || 0);
                const total = Number(res.total || 0);
                const remaining = Math.max(0, total - deposit);

                return (
                  <View key={res.id} style={styles.reservationCard}>
                    <View style={styles.resCardHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.resCustomerName}>{res.customer?.name || 'Cliente General'}</Text>
                        {res.customer?.phone ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Phone size={12} color={ui.textSecondary} />
                            <Text style={styles.resCustomerPhone}>{res.customer.phone}</Text>
                          </View>
                        ) : null}
                      </View>
                      <View
                        style={[
                          styles.badge,
                          isPending && { backgroundColor: ui.warningSoft },
                          isCompleted && { backgroundColor: ui.primarySoft },
                          isCancelled && { backgroundColor: ui.dangerSoft },
                        ]}
                      >
                        <Text
                          style={[
                            styles.badgeText,
                            isPending && { color: ui.warning },
                            isCompleted && { color: ui.primary },
                            isCancelled && { color: ui.danger },
                          ]}
                        >
                          {isCompleted ? 'ENTREGADO' : isCancelled ? 'CANCELADO' : 'PENDIENTE'}
                        </Text>
                      </View>
                    </View>

                    {/* Detalle de ítems */}
                    {Array.isArray(res.items) && res.items.length > 0 ? (
                      <View style={styles.resItemsBox}>
                        {res.items.map((it: any, i: number) => (
                          <Text key={i} style={styles.resItemLine} numberOfLines={1}>
                            • {it.quantity}x {it.productName || it.name || 'Producto'} ({formatPEN(it.price || 0)})
                          </Text>
                        ))}
                      </View>
                    ) : null}

                    {/* Fila Financiera */}
                    <View style={styles.resFinancialRow}>
                      <View>
                        <Text style={styles.resFinLabel}>Total</Text>
                        <Text style={styles.resFinValue}>{formatPEN(total)}</Text>
                      </View>
                      <View>
                        <Text style={styles.resFinLabel}>Adelanto</Text>
                        <Text style={[styles.resFinValue, { color: ui.primary }]}>{formatPEN(deposit)}</Text>
                      </View>
                      <View>
                        <Text style={styles.resFinLabel}>Saldo Pendiente</Text>
                        <Text style={[styles.resFinValue, { color: remaining > 0 ? ui.danger : ui.textSecondary }]}>
                          {formatPEN(remaining)}
                        </Text>
                      </View>
                    </View>

                    {res.pickupDate ? (
                      <View style={styles.resPickupRow}>
                        <Clock size={12} color={ui.textSecondary} />
                        <Text style={styles.resPickupText}>
                          Límite de recojo: {String(res.pickupDate).slice(0, 10)}
                        </Text>
                      </View>
                    ) : null}

                    {/* Botones de acción para reservas */}
                    <View style={styles.resActionsRow}>
                      <TouchableOpacity
                        style={styles.resViewTicketBtn}
                        onPress={() => {
                          setReceiptReservation(res);
                          setReceiptModalVisible(true);
                        }}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel="Ver comprobante o ticket de reserva"
                      >
                        <FileText size={14} color={ui.primary} />
                        <Text style={styles.resViewTicketBtnText}>Ver Ticket</Text>
                      </TouchableOpacity>

                      {isPending && remaining > 0 && (
                        <TouchableOpacity
                          style={styles.resCompleteBtn}
                          onPress={() => handleOpenPayReservation(res)}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel="Cobrar saldo y entregar productos"
                        >
                          <CreditCard size={14} color={ui.onPrimary} />
                          <Text style={styles.resCompleteBtnText}>Cobrar y Entregar</Text>
                        </TouchableOpacity>
                      )}

                      {isPending && remaining === 0 && (
                        <TouchableOpacity
                          style={styles.resCompleteBtn}
                          onPress={() => handleCompleteReservation(res)}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel="Entregar productos"
                        >
                          <CheckCircle2 size={14} color={ui.onPrimary} />
                          <Text style={styles.resCompleteBtnText}>Entregar</Text>
                        </TouchableOpacity>
                      )}

                      {isPending && (
                        <TouchableOpacity
                          style={styles.resCancelBtn}
                          onPress={() => handleCancelReservation(res)}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel="Cancelar reserva"
                        >
                          <X size={14} color={ui.danger} />
                          <Text style={styles.resCancelBtnText}>Cancelar</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}

      {/* ==================================================================== */}
      {/* SUB-MÓDULO 2: ASISTENTE VENTY IA */}
      {/* ==================================================================== */}
      {activeTab === 'ai' && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            ref={chatScrollRef}
            style={styles.chatScroll}
            contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
            {/* Mensajes del Chat */}
            {chatMessages.map((msg) => {
              const isAi = msg.sender === 'ai';
              return (
                <View
                  key={msg.id}
                  style={[
                    styles.chatBubbleWrapper,
                    isAi ? styles.chatBubbleAiWrapper : styles.chatBubbleUserWrapper,
                  ]}
                >
                  {isAi && (
                    <View style={styles.aiAvatar}>
                      <Image
                        source={require('../../assets/venty-icon.webp')}
                        style={{ width: 28, height: 28 }}
                        resizeMode="contain"
                      />
                    </View>
                  )}
                  <View
                    style={[
                      styles.chatBubble,
                      isAi ? styles.chatBubbleAi : styles.chatBubbleUser,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chatText,
                        isAi ? styles.chatTextAi : styles.chatTextUser,
                      ]}
                    >
                      {msg.text}
                    </Text>
                  </View>
                </View>
              );
            })}

            {isAiLoading && (
              <View style={styles.aiTypingBox}>
                <Image
                  source={require('../../assets/venty-icon.webp')}
                  style={{ width: 18, height: 18, marginRight: 6 }}
                  resizeMode="contain"
                />
                <ActivityIndicator size="small" color={ui.primary} />
                <Text style={styles.aiTypingText}>Venty IA está analizando los datos...</Text>
              </View>
            )}

            {/* Chips de Preguntas Rápidas */}
            <View style={styles.quickQuestionsContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Sparkles size={16} color={ui.primary} />
                <Text style={styles.quickQuestionsTitle}>Consultas rápidas:</Text>
              </View>
              <View style={styles.quickChipsGrid}>
                {quickChips.map((chip, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.quickChip}
                    onPress={() => handleSendAiMessage(chip)}
                  >
                    <Text style={styles.quickChipText}>{chip}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </ScrollView>

          {/* Barra de Entrada de Chat */}
          <View style={[styles.chatInputBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <TextInput
              style={styles.chatTextInput}
              accessibilityLabel="Escribe una pregunta para Venty IA"
              placeholder="Pregúntale a Venty IA sobre tu negocio..."
              placeholderTextColor={ui.textMuted}
              value={chatInput}
              onChangeText={setChatInput}
              onSubmitEditing={() => handleSendAiMessage()}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={[styles.chatSendButton, !chatInput.trim() && { opacity: 0.5 }]}
              onPress={() => handleSendAiMessage()}
              disabled={!chatInput.trim() || isAiLoading}
              accessibilityRole="button"
              accessibilityLabel={isAiLoading ? 'Venty IA está respondiendo' : 'Enviar pregunta'}
              accessibilityState={{ disabled: !chatInput.trim() || isAiLoading, busy: isAiLoading }}
            >
              <Send size={18} color={ui.onPrimary} />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* ==================================================================== */}
      {/* MODAL: DETALLE DEL COMPROBANTE Y ACCIONES */}
      {/* ==================================================================== */}
      {saleDetailModalVisible && (
        <Modal visible={saleDetailModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '90%' }]}>
            {selectedSale && (
              <>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>
                      {selectedSale.documentType === 'factura' ? 'Factura Electrónica' : selectedSale.documentType === 'boleta' ? 'Boleta de Venta' : 'Nota de Venta'}
                    </Text>
                    <Text style={styles.modalSub}>
                      {selectedSale.documentNumber || `V-${String(selectedSale.saleNumber || 1).padStart(6, '0')}`}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setSaleDetailModalVisible(false)}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar comprobante"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                >
                  {/* Datos del Cliente */}
                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>DATOS DEL COMPROBANTE</Text>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Fecha y Hora:</Text>
                      <Text style={styles.detailValue}>{formatDatePE(selectedSale.date)}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Cliente:</Text>
                      <Text style={styles.detailValue}>
                        {selectedSale.customerName || 'Cliente General'}
                      </Text>
                    </View>
                    {selectedSale.customerRuc && (
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>RUC:</Text>
                        <Text style={styles.detailValue}>{selectedSale.customerRuc}</Text>
                      </View>
                    )}
                    {selectedSale.customerDni && (
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>DNI:</Text>
                        <Text style={styles.detailValue}>{selectedSale.customerDni}</Text>
                      </View>
                    )}
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Forma de Pago:</Text>
                      <Text style={styles.detailValue}>
                        {(selectedSale.paymentMethod || 'Efectivo').toUpperCase()}
                      </Text>
                    </View>
                  </View>

                  {/* Ítems Vendidos */}
                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>ÍTEMS VENDIDOS</Text>
                    {selectedSale.items?.map((it, idx) => (
                      <View key={idx} style={styles.itemRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemName}>{it.name}</Text>
                          <Text style={styles.itemSub}>
                            {it.quantity} x {formatPEN(it.price)}
                          </Text>
                        </View>
                        <Text style={styles.itemTotal}>
                          {formatPEN((it.lineTotal ?? it.quantity * it.price) || 0)}
                        </Text>
                      </View>
                    ))}
                  </View>

                  {/* Desglose Tributario */}
                  <View style={styles.detailSection}>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Op. Gravada:</Text>
                      <Text style={styles.detailValue}>
                        {formatPEN(selectedSale.fiscalAmounts?.taxed || selectedSale.subtotal || selectedSale.total / 1.18)}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>IGV (18%):</Text>
                      <Text style={styles.detailValue}>
                        {formatPEN(selectedSale.fiscalAmounts?.igv || selectedSale.tax || selectedSale.total - (selectedSale.total / 1.18))}
                      </Text>
                    </View>
                    <View style={[styles.detailRow, { borderTopWidth: 1, borderTopColor: ui.border, paddingTop: 6 }]}>
                      <Text style={[styles.detailLabel, { fontWeight: 'bold', fontSize: 16, color: ui.text }]}>
                        TOTAL:
                      </Text>
                      <Text style={[styles.detailValue, { fontWeight: 'bold', fontSize: 18, color: ui.primary }]}>
                        {formatPEN(selectedSale.total)}
                      </Text>
                    </View>
                  </View>

                  {/* Estado SUNAT / CDR */}
                  {selectedSale.sunatStatus && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>ESTADO TRIBUTARIO SUNAT</Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Respuesta CDR:</Text>
                        <Text style={[styles.detailValue, { color: ui.primary, fontWeight: 'bold' }]}>
                          {selectedSale.sunatStatus === 'accepted' ? 'Comprobante Aceptado' : selectedSale.sunatStatus}
                        </Text>
                      </View>
                    </View>
                  )}
                </ScrollView>

                {/* Botones de Acción */}
                <View style={styles.actionGrid}>
                  <TouchableOpacity
                    style={[styles.modalActionBtn, { borderColor: ui.primary }]}
                    onPress={() => handlePrintSale(selectedSale)}
                    disabled={isPrinting}
                    accessibilityRole="button"
                    accessibilityLabel={isPrinting ? 'Imprimiendo ticket' : 'Reimprimir ticket'}
                    accessibilityState={{ disabled: isPrinting, busy: isPrinting }}
                  >
                    {isPrinting ? (
                      <ActivityIndicator color={ui.primary} size="small" />
                    ) : (
                      <>
                        <Printer size={18} color={ui.primary} />
                        <Text style={[styles.modalActionText, { color: ui.primary }]}>
                          Reimprimir Ticket
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.modalActionBtn, { borderColor: ui.primary }]}
                    onPress={() => handleShareWhatsApp(selectedSale)}
                    disabled={isSharing}
                    accessibilityRole="button"
                    accessibilityLabel={isSharing ? 'Preparando envío por WhatsApp' : 'Enviar comprobante por WhatsApp'}
                    accessibilityState={{ disabled: isSharing, busy: isSharing }}
                  >
                    {isSharing ? (
                      <ActivityIndicator color={ui.primary} size="small" />
                    ) : (
                      <>
                        <Share2 size={18} color={ui.primary} />
                        <Text style={[styles.modalActionText, { color: ui.primary }]}>
                          Enviar WhatsApp
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {/* Botón de Anulación si no está anulada y tiene permisos */}
                {selectedSale.status === 'completed' && !(selectedSale as any).refundedLineIndices?.length && !Number((selectedSale as any).refundedAmount || 0) && canProcessReturn && ['owner', 'admin'].includes(role || '') && (
                  <TouchableOpacity
                    style={styles.cancelSaleBtn}
                    onPress={() => {
                      setCancelReason('');
                      setCancelModalVisible(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Anular venta y revertir stock"
                  >
                    <Trash2 size={18} color={ui.danger} />
                    <Text style={styles.cancelSaleText}>Anular Venta y Revertir Stock</Text>
                  </TouchableOpacity>
                )}
                {selectedSale.status === 'completed' && !selectedSale.isReturn && canProcessReturn && (posSettings.enableSellerAttribution || (selectedSale as any).attributionVersion === 1) && (
                  <TouchableOpacity
                    style={[styles.cancelSaleBtn, { borderColor: ui.warning, marginTop: 8 }]}
                    onPress={() => {
                      setRefundLineIndices([]);
                      setRefundPaymentMethod('cash');
                      setRefundModalVisible(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Devolver uno o más artículos de la venta"
                  >
                    <RefreshCw size={18} color={ui.warning} />
                    <Text style={[styles.cancelSaleText, { color: ui.warning }]}>Devolver artículos</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>
      )}

      {refundModalVisible && (
        <Modal visible={refundModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Devolución parcial</Text>
                <Text style={styles.modalSub}>Selecciona los artículos que regresan</Text>
              </View>
              <TouchableOpacity onPress={() => setRefundModalVisible(false)} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Cerrar devolución">
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              {selectedSale?.items?.map((line, index) => {
                const selected = refundLineIndices.includes(index);
                const lineAmount = Number(line.lineTotal) || Number(line.price || 0) * Number(line.quantity || 0);
                return (
                  <TouchableOpacity
                    key={`${line.id}-${index}`}
                    style={[styles.itemRow, selected && { backgroundColor: ui.warningSoft, borderRadius: 8 }]}
                    onPress={() => setRefundLineIndices((current) => selected
                      ? current.filter((itemIndex) => itemIndex !== index)
                      : [...current, index])}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{line.name}</Text>
                      <Text style={styles.itemSub}>{line.quantity} x {formatPEN(line.price)}</Text>
                    </View>
                    <Text style={styles.itemTotal}>{formatPEN(lineAmount)}</Text>
                    {selected && <CheckCircle2 size={18} color={ui.warning} style={{ marginLeft: 8 }} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <Text style={styles.detailSectionTitle}>MÉTODO DE REEMBOLSO</Text>
            <View style={styles.actionGrid}>
              {[
                { id: 'cash', label: 'Efectivo' },
                { id: 'card', label: 'Tarjeta' },
                { id: 'digital', label: 'Digital' },
              ].map((method) => (
                <TouchableOpacity key={method.id} style={[styles.refundMethodChip, refundPaymentMethod === method.id && styles.refundMethodChipActive]} onPress={() => setRefundPaymentMethod(method.id as any)}>
                  <Text style={[styles.refundMethodChipText, refundPaymentMethod === method.id && styles.refundMethodChipTextActive]}>{method.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={[styles.confirmCancelBtn, isRefunding && styles.buttonDisabled]} onPress={handleRefundSelectedLines} disabled={isRefunding}>
              {isRefunding ? <ActivityIndicator color={ui.onPrimary} /> : <Text style={styles.confirmCancelBtnText}>Registrar devolución</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      )}

      {/* ==================================================================== */}
      {/* MODAL: CONFIRMACIÓN Y MOTIVO DE ANULACIÓN */}
      {/* ==================================================================== */}
      {cancelModalVisible && (
        <Modal visible={cancelModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={[styles.modalTitle, { color: ui.danger }]}>Anular Venta</Text>
                <Text style={styles.modalSub}>
                  Reversión de stock en inventario y contra-movimiento de caja
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setCancelModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar anulación"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Motivo Justificado de Anulación *</Text>
              <TextInput
                style={[styles.input, { height: 70, textAlignVertical: 'top' }]}
                accessibilityLabel="Motivo justificado de anulación, obligatorio"
                placeholder="Ej. Devolución de producto por falla, error en cobro..."
                placeholderTextColor={ui.textMuted}
                multiline
                value={cancelReason}
                onChangeText={setCancelReason}
              />
            </View>

            <TouchableOpacity
              style={[styles.confirmCancelBtn, isCancelling && styles.buttonDisabled]}
              onPress={handleConfirmCancelSale}
              disabled={isCancelling}
              accessibilityRole="button"
              accessibilityLabel={isCancelling ? 'Procesando anulación' : 'Confirmar anulación y actualizar kardex'}
              accessibilityState={{ disabled: isCancelling, busy: isCancelling }}
            >
              {isCancelling ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Trash2 size={18} color={ui.onPrimary} />
                  <Text style={styles.confirmCancelBtnText}>Confirmar Anulación y Kardex</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      )}

      {pnlModalOpen && (
        <FinancialPnlModal
          visible={pnlModalOpen}
          onClose={() => setPnlModalOpen(false)}
        />
      )}

      {/* Modal de Rango de Fechas Personalizado */}
      {customDateModalOpen && (
        <Modal visible={customDateModalOpen} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Filtrar por Fecha</Text>
                <Text style={styles.modalSub}>Selecciona un rango personalizado</Text>
              </View>
              <TouchableOpacity
                onPress={() => setCustomDateModalOpen(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar selector de fecha"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Accesos rápidos */}
            <View style={styles.quickDateRow}>
              {[
                { label: 'Ayer', days: 1 },
                { label: 'Últimos 15 días', days: 15 },
                { label: 'Últimos 30 días', days: 30 },
              ].map((shortcut) => (
                <TouchableOpacity
                  key={shortcut.label}
                  style={styles.quickDateChip}
                  onPress={() => {
                    const pad = (n: number) => String(n).padStart(2, '0');
                    const now = new Date();
                    if (shortcut.days === 1) {
                      const yesterday = new Date(Date.now() - 86400000);
                      const yStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
                      setCustomStartDate(yStr);
                      setCustomEndDate(yStr);
                    } else {
                      const endStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                      const past = new Date(Date.now() - shortcut.days * 86400000);
                      const startStr = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}`;
                      setCustomStartDate(startStr);
                      setCustomEndDate(endStr);
                    }
                  }}
                >
                  <Text style={styles.quickDateChipText}>{shortcut.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.dateInputsRow}>
              <View style={[styles.inputGroup, { flex: 1 }]}>
                <Text style={styles.label}>Desde (AAAA-MM-DD)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="2026-01-01"
                  placeholderTextColor={ui.textMuted}
                  value={customStartDate}
                  onChangeText={setCustomStartDate}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                />
              </View>
              <View style={[styles.inputGroup, { flex: 1 }]}>
                <Text style={styles.label}>Hasta (AAAA-MM-DD)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="2026-01-31"
                  placeholderTextColor={ui.textMuted}
                  value={customEndDate}
                  onChangeText={setCustomEndDate}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                />
              </View>
            </View>

            <View style={styles.customDateActions}>
              <TouchableOpacity
                style={styles.cancelDateBtn}
                onPress={() => {
                  setCustomDateModalOpen(false);
                }}
              >
                <Text style={styles.cancelDateBtnText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.applyDateBtn}
                onPress={() => {
                  if (customStartDate && customEndDate) {
                    setDateRange('custom');
                  }
                  setCustomDateModalOpen(false);
                }}
              >
                <Calendar size={16} color={ui.onPrimary} />
                <Text style={styles.applyDateBtnText}>Aplicar Filtro</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      )}

      {/* Modal de Comprobante / Ticket de Reserva */}
      {receiptModalVisible && (
        <ReservationReceiptModal
          visible={receiptModalVisible}
          onClose={() => {
            setReceiptModalVisible(false);
            setReceiptReservation(null);
          }}
          reservation={receiptReservation}
          business={{ ...businessSettings, ...activeBranch }}
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

      {/* Modal para Cobrar Saldo Pendiente de Reserva */}
      {paymentModalVisible && (
        <Modal visible={paymentModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Cobrar Saldo y Entregar</Text>
                <Text style={styles.modalSub}>
                  {reservationToPay?.customer?.name || 'Cliente General'} · #{String(reservationToPay?.id || '').slice(-6).toUpperCase()}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setPaymentModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar cobro de reserva"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {reservationToPay && (
              <View style={{ marginVertical: 12 }}>
                <View style={{ backgroundColor: '#F8FAFC', borderRadius: 8, padding: 12, marginBottom: 14 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ fontSize: 13, color: '#64748B' }}>Total de la Reserva:</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>{formatPEN(reservationToPay.total)}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ fontSize: 13, color: '#15803D' }}>Adelanto / Seña pagada:</Text>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#15803D' }}>- {formatPEN(reservationToPay.depositAmount || 0)}</Text>
                  </View>
                  <View style={{ height: 1, backgroundColor: '#E2E8F0', marginVertical: 6 }} />
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: ui.danger }}>SALDO A COBRAR:</Text>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: ui.danger }}>
                      {formatPEN(Math.max(0, Number(reservationToPay.total || 0) - Number(reservationToPay.depositAmount || 0)))}
                    </Text>
                  </View>
                </View>

                {/* Métodos de Pago */}
                <Text style={styles.label}>Método de Pago para el Saldo</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 }}>
                  {(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'] as const).map((m) => (
                    <TouchableOpacity
                      key={m}
                      style={[
                        {
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: payMethod === m ? ui.primary : ui.border,
                          backgroundColor: payMethod === m ? ui.primarySoft : ui.surface,
                        },
                      ]}
                      onPress={() => setPayMethod(m)}
                    >
                      <Text
                        style={{
                          fontSize: 12.5,
                          fontWeight: '700',
                          color: payMethod === m ? ui.primary : ui.textSecondary,
                          textTransform: 'capitalize',
                        }}
                      >
                        {m}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Si es efectivo, cálculo de vuelto */}
                {payMethod === 'efectivo' && (
                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Monto Recibido en Efectivo (S/)</Text>
                    <TextInput
                      style={styles.input}
                      value={payCashReceived}
                      onChangeText={setPayCashReceived}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                    />
                    {parseFloat(payCashReceived) > Math.max(0, Number(reservationToPay.total || 0) - Number(reservationToPay.depositAmount || 0)) ? (
                      <Text style={{ fontSize: 12, fontWeight: '700', color: ui.success, marginTop: 4 }}>
                        Vuelto: {formatPEN(parseFloat(payCashReceived) - Math.max(0, Number(reservationToPay.total || 0) - Number(reservationToPay.depositAmount || 0)))}
                      </Text>
                    ) : null}
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.applyDateBtn, { marginTop: 14 }]}
                  onPress={handleConfirmCompletePayment}
                  disabled={isCompletingPayment}
                >
                  {isCompletingPayment ? (
                    <ActivityIndicator size="small" color={ui.onPrimary} />
                  ) : (
                    <>
                      <CheckCircle2 size={16} color={ui.onPrimary} />
                      <Text style={styles.applyDateBtnText}>Confirmar Cobro y Entregar</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  compactHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  compactHeaderTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: ui.text,
  },
  compactPnlButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
  },
  compactPnlButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  summaryWithFiltersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 10,
  },
  summaryTitleCol: {
    justifyContent: 'center',
  },
  summaryTitleText: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },
  summarySubText: {
    fontSize: 10,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  filterChipScrollCompact: {
    flex: 1,
  },
  filterChipRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 6,
  },
  rangeChipCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  rangeChipCompactActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  rangeChipTextCompact: {
    fontSize: 11,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  rangeChipTextCompactActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  quickDateRow: {
    flexDirection: 'row',
    gap: 8,
  },
  quickDateChip: {
    flex: 1,
    backgroundColor: ui.surfaceMuted,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: ui.border,
  },
  quickDateChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  dateInputsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  customDateActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  cancelDateBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
  },
  cancelDateBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  applyDateBtn: {
    flex: 1.5,
    flexDirection: 'row',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    gap: 6,
  },
  applyDateBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  pnlHeaderButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 13,
    backgroundColor: ui.primarySoft,
    borderRadius: 12,
  },
  pnlHeaderButtonText: {
    color: ui.primary,
    fontSize: ui.font.small,
    fontWeight: '700',
  },
  tabSelector: {
    minWidth: '100%',
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 4,
  },
  tabButton: {
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    gap: 8,
  },
  tabSelectorScroll: {
    flexGrow: 0,
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
  filterChipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 12,
  },
  filterChipScroll: {
    flexGrow: 0,
  },
  rangeChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  rangeChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  rangeChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  rangeChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  kpiContainer: {
    marginBottom: 16,
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  kpiBox: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: ui.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: ui.border,
  },
  totalSalesHero: {
    flexBasis: '100%',
    backgroundColor: ui.primarySoft,
    borderColor: ui.primarySoft,
    paddingVertical: 20,
  },
  secondaryKpiBox: {
    minHeight: 112,
    justifyContent: 'center',
  },
  kpiBoxLabel: {
    fontSize: ui.font.small,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  kpiBoxValue: {
    fontSize: 19,
    fontWeight: 'bold',
    marginVertical: 4,
  },
  totalSalesValue: {
    fontSize: 30,
    color: ui.primary,
    fontWeight: '800',
    marginVertical: 8,
  },
  kpiBoxFoot: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: ui.border,
    minHeight: 48,
  },
  searchInput: {
    flex: 1,
    color: ui.text,
    fontSize: theme.typography.sizes.base,
    marginLeft: 8,
  },
  docFilterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  docChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  docChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  docChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  docChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 50,
    gap: 8,
  },
  emptyTitle: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
  },
  emptySub: {
    fontSize: theme.typography.sizes.sm,
    color: ui.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  saleCard: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
    marginBottom: 10,
    gap: 10,
  },
  saleCardCancelled: {
    opacity: 0.65,
    borderColor: ui.dangerSoft,
  },
  saleCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  saleDocNumber: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
  },
  saleDateText: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  saleTotalText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: ui.primary,
  },
  salePaymentMethod: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 2,
  },
  saleCardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 8,
  },
  saleCustomerText: {
    flex: 1,
    fontSize: 12,
    color: ui.textSecondary,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  miniBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    gap: 4,
  },
  miniBadgeText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  chatScroll: {
    flex: 1,
  },
  chatBubbleWrapper: {
    flexDirection: 'row',
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  chatBubbleAiWrapper: {
    justifyContent: 'flex-start',
  },
  chatBubbleUserWrapper: {
    justifyContent: 'flex-end',
  },
  aiAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    overflow: 'hidden',
  },
  chatBubble: {
    maxWidth: '82%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chatBubbleAi: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderBottomLeftRadius: 4,
  },
  chatBubbleUser: {
    backgroundColor: ui.primary,
    borderBottomRightRadius: 4,
  },
  chatText: {
    fontSize: 14,
    lineHeight: 20,
  },
  chatTextAi: {
    color: ui.text,
  },
  chatTextUser: {
    color: ui.onPrimary,
    fontWeight: '500',
  },
  aiTypingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  aiTypingText: {
    fontSize: 12,
    color: ui.textSecondary,
    fontStyle: 'italic',
  },
  quickQuestionsContainer: {
    marginTop: 16,
    backgroundColor: ui.surfaceMuted,
    padding: 14,
    borderRadius: theme.borderRadius.md,
  },
  quickQuestionsTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.text,
  },
  quickChipsGrid: {
    gap: 8,
  },
  quickChip: {
    minHeight: 48,
    justifyContent: 'center',
    backgroundColor: ui.surface,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  quickChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  chatInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    paddingHorizontal: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    gap: 10,
  },
  chatTextInput: {
    flex: 1,
    minHeight: 48,
    backgroundColor: ui.surface,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: ui.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  chatSendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
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
  iconButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
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
  detailSection: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 12,
    marginBottom: 10,
    gap: 6,
  },
  detailSectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ui.textMuted,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  detailValue: {
    fontSize: 12,
    color: ui.text,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  itemName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.text,
  },
  itemSub: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  itemTotal: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.text,
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  modalActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1.5,
    gap: 6,
  },
  modalActionText: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  cancelSaleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 10,
    gap: 6,
  },
  cancelSaleText: {
    color: ui.danger,
    fontSize: 12,
    fontWeight: 'bold',
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
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    color: ui.text,
    fontSize: theme.typography.sizes.base,
  },
  confirmCancelBtn: {
    backgroundColor: ui.danger,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  confirmCancelBtnText: {
    color: ui.onPrimary,
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  tabSelectorRowCentered: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  tabButtonCentered: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: theme.borderRadius.md,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  barcodeScanBtn: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.md,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reservationsHeaderBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: ui.border,
    marginBottom: 12,
  },
  reservationsBannerTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: ui.text,
  },
  reservationsBannerSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  reservationsList: {
    gap: 12,
  },
  reservationCard: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 10,
  },
  resCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  resCustomerName: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  resCustomerPhone: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  resItemsBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 10,
    gap: 4,
  },
  resItemLine: {
    fontSize: 12,
    color: ui.text,
  },
  resFinancialRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  resFinLabel: {
    fontSize: 11,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  resFinValue: {
    fontSize: 14,
    fontWeight: 'bold',
    color: ui.text,
  },
  resPickupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  resPickupText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  resActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  resViewTicketBtn: {
    flex: 1.2,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.primary,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  resViewTicketBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  resCancelBtn: {
    flex: 1,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: ui.dangerSoft,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.danger,
    paddingVertical: 6,
  },
  resCancelBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.danger,
  },
  resCompleteBtn: {
    flex: 2,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primary,
    borderRadius: 8,
    paddingVertical: 6,
  },
  resCompleteBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  refundMethodChip: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  refundMethodChipActive: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  refundMethodChipText: {
    color: ui.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  refundMethodChipTextActive: {
    color: ui.primary,
  },
  inlineScannerCard: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: ui.primary,
    overflow: 'hidden',
    marginBottom: 12,
  },
  inlineScannerTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ui.surfaceMuted,
  },
  inlineScannerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inlineScannerTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.text,
  },
  inlineScannerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inlineScannerActionBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineScannerActionBtnActive: {
    backgroundColor: ui.primary,
  },
  inlineCameraBox: {
    height: 160,
    backgroundColor: '#000',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineCamera: {
    ...StyleSheet.absoluteFillObject,
  },
  inlineReticle: {
    width: '75%',
    height: 90,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: ui.primary,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  inlineScanBanner: {
    position: 'absolute',
    bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  inlineScanBannerText: {
    fontSize: 11,
    color: '#FFF',
    fontWeight: '500',
  },
});
