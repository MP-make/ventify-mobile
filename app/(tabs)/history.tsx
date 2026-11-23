import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Modal,
  ScrollView,
  Alert,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
  InteractionManager,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import {
  Receipt,
  Calendar,
  TrendingUp,
  Printer,
  Share2,
  Trash2,
  RefreshCw,
  CheckCircle2,
  FileText,
  X,
  AlertTriangle,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';

import { useAuthSession, useNetworkStatus } from '@/context/AuthContext';
import {
  useBusinessSettings,
  useCashSession,
  useOfflineStatus,
} from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { ui, formatPEN, formatDatePE } from '@/lib/theme';
import { apiRequest } from '@/lib/api-client';
import { parseNormalizedDecimal } from '@/lib/product-search';
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

import { Sale } from '@/types';
import { cancelSaleWithReversal, refundSaleLines } from '@/services/sale-service';
import { completeOrCancelReservation } from '@/services/crm-operations-service';
import { getHistoryDateBounds, toEpochMillis } from '@/services/crm-compat';
import {
  emitEinvoiceDocument,
  fetchEinvoices,
  formatLocalIsoDate,
  retryEinvoiceDocument,
  type PublicEinvoice,
} from '@/services/dashboard-reports-service';

import {
  buildSaleReceiptEscPos,
  getPrinterConfig,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import { resolveReceiptDocumentMeta } from '@/lib/printing/escpos-builder';
import { ReceiptTicketPreview } from '@/components/ReceiptTicketPreview';
import { receiptAmountsForSale } from '@/lib/invoicing/receipt-amounts';
import { EinvoiceActionsModal } from '@/components/EinvoiceActionsModal';
import { FinancialPnlModal } from '@/components/FinancialPnlModal';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';
import { ReservationCancellationModal } from '@/components/ReservationCancellationModal';
import { mergeSalesWithOfflinePending } from '@/lib/offline-sales-helpers';
import { assertOnlineForWrite } from '@/lib/online-guard';
import { cancelPendingOfflineSale } from '@/services/offline-sync-service';

import { historyStyles as styles } from '@/components/history/historyStyles';
import {
  AI_WELCOME_MESSAGE,
  VENTY_ICON,
  type ChatMessage,
  type DateRange,
  type DocFilter,
  type HistorySale,
  type HistoryTab,
} from '@/components/history/historyTypes';
import { HistorySalesTab } from '@/components/history/HistorySalesTab';
import { HistoryReservationsTab } from '@/components/history/HistoryReservationsTab';
import { HistoryAiChatTab } from '@/components/history/HistoryAiChatTab';

let reservationsMissingCompositeIndex = false;

const isOfflinePendingSale = (sale: Sale | null | undefined): boolean =>
  Boolean(sale && ((sale as any).isOfflinePending || (sale as any).offlineQueued));

const guardOfflinePendingSaleAction = (
  sale: Sale | null | undefined,
  actionLabel: string
): boolean => {
  if (!isOfflinePendingSale(sale)) return false;
  Alert.alert(
    'Venta pendiente de sincronización',
    `Esta venta está esperando sincronización offline antes de poder ${actionLabel}. Sincronízala cuando tengas conexión.`
  );
  return true;
};

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const router = useRouter();
  const { user, userProfile, accountId, branchId, role } = useAuthSession();
  const { isOnline } = useNetworkStatus();
  const { canViewReports, canProcessReturn, canCreateCreditNotes } = usePermissions();
  const {
    businessSettings,
    businessData,
    activeBranch,
    branches,
    posSettings,
    invoicingEnabled,
    taxProfile,
    emitterInfo,
  } = useBusinessSettings();
  const { activeCashSession, refreshCashStatus } = useCashSession();
  const {
    pendingOfflineSales,
    offlineQueueCount,
    quarantinedCount,
    lastSyncSuccessAt,
    refreshOfflineCount,
  } = useOfflineStatus();

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const receiptBusiness = useMemo(
    () => ({
      ...(businessData || {}),
      ...(businessSettings || {}),
      ...(emitterInfo || {}),
      printedFormatResolution: emitterInfo?.printedFormatResolution || undefined,
      businessName:
        emitterInfo?.nombreComercial ||
        emitterInfo?.razonSocial ||
        businessSettings?.businessName ||
        businessData?.businessName ||
        'VENTIFY',
      ruc: emitterInfo?.ruc || businessSettings?.ruc || businessData?.ruc || '',
      address:
        (businessSettings as any)?.commercialAddress ||
        businessSettings?.address ||
        activeBranch?.address ||
        '',
      phone:
        activeBranch?.phone ||
        (businessSettings as any)?.commercialPhone ||
        businessSettings?.phone ||
        '',
      consultUrl:
        (businessSettings as any)?.consultUrl ||
        (businessData as any)?.consultUrl ||
        'https://ventify.com.pe/comprobantes',
    }),
    [businessData, businessSettings, emitterInfo, activeBranch]
  );

  const resolveSaleBranch = useCallback(
    (sale?: Sale | null) => {
      if (!sale?.branchId) return activeBranch || null;
      return branches?.find((b) => b.id === sale.branchId) || activeBranch || null;
    },
    [branches, activeBranch]
  );

  const reservationBusiness = useMemo(
    () => ({ ...(businessSettings || {}), ...(activeBranch || {}) }),
    [businessSettings, activeBranch]
  );

  const [activeTab, setActiveTab] = useState<HistoryTab>('sales');
  const [pnlModalOpen, setPnlModalOpen] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 1: HISTORIAL DE VENTAS Y SUNAT
  // ============================================================================
  const [sales, setSales] = useState<HistorySale[]>([]);
  const [loadingSales, setLoadingSales] = useState<boolean>(true);
  const [loadingMoreSales, setLoadingMoreSales] = useState<boolean>(false);
  const salesCursorRef = useRef<any>(null);
  const salesGenerationRef = useRef(0);
  const salesScopeRef = useRef('');
  const lastFetchedScopeRef = useRef('');
  const [salesHasMore, setSalesHasMore] = useState<boolean>(false);

  // Preserve search & doc filter across tab switches without causing keystroke re-renders
  const lastSalesSearchRef = useRef<string>('');
  const lastSalesDocFilterRef = useRef<DocFilter>('all');
  const handleSalesSearchTextChange = useCallback((text: string) => {
    lastSalesSearchRef.current = text;
  }, []);
  const handleSalesDocFilterChange = useCallback((next: DocFilter) => {
    lastSalesDocFilterRef.current = next;
  }, []);

  const [dateRange, setDateRange] = useState<DateRange>('today');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
  const [draftStartDate, setDraftStartDate] = useState<string>('');
  const [draftEndDate, setDraftEndDate] = useState<string>('');
  const [customDateModalOpen, setCustomDateModalOpen] = useState<boolean>(false);
  const effectiveCustomStart = dateRange === 'custom' ? customStartDate : '';
  const effectiveCustomEnd = dateRange === 'custom' ? customEndDate : '';
  const salesScope = `${accountId || ''}|${branchId || ''}|${dateRange}|${effectiveCustomStart}|${effectiveCustomEnd}`;
  salesScopeRef.current = salesScope;

  // Modal de Detalle de Comprobante
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const detailMeta = useMemo(
    () => (selectedSale ? resolveReceiptDocumentMeta(selectedSale) : null),
    [selectedSale]
  );
  const selectedSaleBranch = useMemo(
    () => (selectedSale ? resolveSaleBranch(selectedSale) : null),
    [resolveSaleBranch, selectedSale]
  );
  const detailReceiptAmounts = useMemo(
    () =>
      selectedSale
        ? receiptAmountsForSale(selectedSale, selectedSale.fiscalAmounts, taxProfile)
        : null,
    [selectedSale, taxProfile]
  );
  const [saleDetailModalVisible, setSaleDetailModalVisible] = useState<boolean>(false);
  const [detailViewMode, setDetailViewMode] = useState<'ticket' | 'summary'>('ticket');
  const [detailPaperWidth, setDetailPaperWidth] = useState<58 | 80>(80);

  // Gestión SUNAT (NC / ND / Sustituto / Consultar / Reintentar / XML-CDR)
  const [einvoiceModalVisible, setEinvoiceModalVisible] = useState<boolean>(false);
  const [activeEinvoice, setActiveEinvoice] = useState<PublicEinvoice | null>(null);
  const [allAccountEinvoices, setAllAccountEinvoices] = useState<PublicEinvoice[]>([]);
  const [loadingSunatAction, setLoadingSunatAction] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    getPrinterConfig()
      .then((cfg) => {
        if (active && (cfg?.paperWidth === 58 || cfg?.paperWidth === 80)) {
          setDetailPaperWidth(cfg.paperWidth);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Modal de Anulación y Devolución
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

  // Estados del Sub-Módulo de Reservas
  const [reservations, setReservations] = useState<any[]>([]);
  const [loadingReservations, setLoadingReservations] = useState<boolean>(false);
  const reservationsScope = `${accountId || ''}|${branchId || ''}`;
  const lastReservationsScopeRef = useRef(reservationsScope);

  useEffect(() => {
    if (lastReservationsScopeRef.current !== reservationsScope) {
      lastReservationsScopeRef.current = reservationsScope;
      setReservations([]);
    }
  }, [reservationsScope]);

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

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 2: ASISTENTE VENTY IA
  // ============================================================================
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [
    { ...AI_WELCOME_MESSAGE, timestamp: Date.now() },
  ]);

  // ============================================================================
  // ACCIONES DE RESERVAS
  // ============================================================================
  const handleOpenPayReservation = useCallback((res: any) => {
    setReservationToPay(res);
    const totalVal = Number(res.total || 0);
    const depositVal = Number(res.depositAmount || 0);
    const remaining = Math.max(0, totalVal - depositVal);
    setPayCashReceived(remaining.toFixed(2));
    setPayMethod('efectivo');
    setPaymentModalVisible(true);
  }, []);

  const handleConfirmCompletePayment = async () => {
    if (!reservationToPay) return;
    const totalVal = Number(reservationToPay.total || 0);
    const depositVal = Number(reservationToPay.depositAmount || 0);
    const remaining = Math.max(0, totalVal - depositVal);

    setIsCompletingPayment(true);
    try {
      await assertOnlineForWrite('cobrar y entregar una reserva', isOnlineRef.current);
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

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPaymentModalVisible(false);
      void refreshCashStatus();

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

  const handleCompleteReservation = useCallback(
    (res: any) => {
      Alert.alert(
        'Confirmar Entrega',
        `¿Confirmas la entrega de los productos a ${res.customer?.name || 'Cliente General'}? Se descontará el inventario físico y se marcará como entregado.`,
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Confirmar Entrega',
            onPress: async () => {
              try {
                await assertOnlineForWrite('confirmar la entrega de una reserva', isOnlineRef.current);
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
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setReceiptReservation({ ...res, status: 'completed' });
                setReceiptModalVisible(true);
              } catch (err: any) {
                Alert.alert('Error', err?.message || 'No se pudo completar la entrega.');
              }
            },
          },
        ]
      );
    },
    [
      activeCashSession?.sessionId,
      activeCashSession?.id,
      accountId,
      branchId,
      user?.uid,
      user?.email,
      userProfile?.displayName,
    ]
  );

  const handleCancelReservation = useCallback((res: any) => setCancellationTarget(res), []);

  const handleViewReservationTicket = useCallback((res: any) => {
    setReceiptReservation(res);
    setReceiptModalVisible(true);
  }, []);

  const confirmReservationCancellation = async (refund: {
    refundMethod?: string;
    refundPercent?: number;
  }) => {
    if (!cancellationTarget) return;
    const res = cancellationTarget;
    const totalVal = Number(res.total || 0);
    const depositVal = Number(res.depositAmount || 0);
    try {
      await assertOnlineForWrite('cancelar una reserva', isOnlineRef.current);
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
        { sessionId: activeCashSession?.sessionId || activeCashSession?.id, ...refund }
      );
      setCancellationTarget(null);
      void refreshCashStatus();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Cancelación completada',
        refund.refundMethod
          ? 'Se liberó el stock y se registró el reembolso.'
          : 'Se liberó el stock. El adelanto quedó retenido.'
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo cancelar la reserva.');
    }
  };

  // ============================================================================
  // CARGA PAGINADA DE VENTAS CON RANGO APLICADO EN FIRESTORE
  // ============================================================================
  const fetchSalesPage = useCallback(
    async (reset: boolean) => {
      if (!accountId) {
        setSales([]);
        setLoadingSales(false);
        setSalesHasMore(false);
        salesCursorRef.current = null;
        return;
      }
      if (!isOnlineRef.current) {
        if (reset) {
          setLoadingSales(false);
        } else {
          setLoadingMoreSales(false);
        }
        return;
      }
      if (reset) {
        salesGenerationRef.current += 1;
        salesScopeRef.current = salesScope;
        salesCursorRef.current = null;
        setLoadingSales(isOnlineRef.current);
      } else {
        setLoadingMoreSales(true);
      }
      const generation = salesGenerationRef.current;
      const requestScope = salesScope;
      try {
        const bounds = getHistoryDateBounds(dateRange, effectiveCustomStart, effectiveCustomEnd);
        const constraints: any[] = [where('accountId', '==', accountId)];
        if (branchId && branchId !== 'main') constraints.push(where('branchId', '==', branchId));
        if (bounds.start !== undefined) constraints.push(where('date', '>=', bounds.start));
        if (bounds.end !== undefined) constraints.push(where('date', '<=', bounds.end));
        constraints.push(orderBy('date', 'desc'));
        if (!reset && salesCursorRef.current) constraints.push(startAfter(salesCursorRef.current));
        constraints.push(limit(100));
        const snapshot = await getDocs(query(collection(db, 'sales'), ...constraints));
        if (generation !== salesGenerationRef.current || requestScope !== salesScopeRef.current) return;
        const page: HistorySale[] = snapshot.docs.map((entry) => {
          const data = entry.data() as any;
          return {
            id: entry.id,
            ...data,
            _dateMs: toEpochMillis(data.date || data.createdAt),
          };
        });
        setSales((current) => {
          if (reset) return page;
          const byId = new Map(current.map((sale) => [sale.id, sale]));
          page.forEach((sale) => byId.set(sale.id, sale));
          return [...byId.values()];
        });
        salesCursorRef.current = snapshot.docs.at(-1) || null;
        setSalesHasMore(snapshot.docs.length === 100);
        if (reset && isOnlineRef.current) {
          lastFetchedScopeRef.current = requestScope;
        }
      } catch (err: any) {
        if (generation !== salesGenerationRef.current || requestScope !== salesScopeRef.current) return;
        console.warn('Error cargando página de ventas:', err);
        if (isOnlineRef.current) {
          if (reset) setSales([]);
          Alert.alert(
            'No se pudo cargar el historial',
            err?.message || 'Revisa tu conexión y vuelve a intentar.'
          );
        }
      } finally {
        if (generation === salesGenerationRef.current && requestScope === salesScopeRef.current) {
          setLoadingSales(false);
          setLoadingMoreSales(false);
        }
      }
    },
    [accountId, branchId, dateRange, effectiveCustomStart, effectiveCustomEnd, salesScope]
  );

  const prevOfflineQueueCountRef = useRef(offlineQueueCount);
  const pendingSyncRefreshRef = useRef(false);
  const lastHandledSyncAtRef = useRef<number | null>(lastSyncSuccessAt);

  useEffect(() => {
    if (prevOfflineQueueCountRef.current > offlineQueueCount) {
      pendingSyncRefreshRef.current = true;
    }
    prevOfflineQueueCountRef.current = offlineQueueCount;
    if (lastSyncSuccessAt && lastSyncSuccessAt !== lastHandledSyncAtRef.current) {
      lastHandledSyncAtRef.current = lastSyncSuccessAt;
      pendingSyncRefreshRef.current = true;
    }
    if (pendingSyncRefreshRef.current && isOnline && isFocused) {
      pendingSyncRefreshRef.current = false;
      void fetchSalesPage(true);
    }
  }, [offlineQueueCount, lastSyncSuccessAt, isOnline, isFocused, fetchSalesPage]);

  useEffect(() => {
    if (!isFocused) return;
    if (!isOnline) {
      setLoadingSales(false);
      return;
    }
    if (lastFetchedScopeRef.current === salesScope) return;
    setSalesHasMore(false);
    const task = InteractionManager.runAfterInteractions(() => {
      void fetchSalesPage(true);
    });
    return () => task.cancel();
  }, [isFocused, isOnline, salesScope, fetchSalesPage]);

  // Escuchar Reservas de la Sucursal
  useEffect(() => {
    if (!accountId || !isFocused || activeTab !== 'reservations') return;
    if (!isOnline) {
      setLoadingReservations(false);
      return;
    }
    setLoadingReservations(true);

    let cancelled = false;
    let unsubscribeActive: (() => void) | null = null;

    const attachListener = (useOrderedQuery: boolean) => {
      const q = useOrderedQuery
        ? query(
            collection(db, 'reservations'),
            where('accountId', '==', accountId),
            where('branchId', '==', branchId),
            orderBy('date', 'desc'),
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
              const tA = toEpochMillis(a.date || a.createdAt);
              const tB = toEpochMillis(b.date || b.createdAt);
              return tB - tA;
            });
          }
          setReservations(list);
          setLoadingReservations(false);
        },
        (error: any) => {
          if (cancelled) return;
          if (useOrderedQuery && String(error?.code || '').includes('failed-precondition')) {
            reservationsMissingCompositeIndex = true;
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
        attachListener(!reservationsMissingCompositeIndex);
      }
    });

    return () => {
      cancelled = true;
      task.cancel();
      if (unsubscribeActive) unsubscribeActive();
    };
  }, [accountId, branchId, isFocused, activeTab, isOnline]);

  // ============================================================================
  // FUSIÓN CON VENTAS OFFLINE PENDIENTES (focus-gated)
  // ============================================================================
  const lastMergedSalesRef = useRef<HistorySale[]>([]);
  const mergedSales = useMemo(() => {
    if (!isFocused) return lastMergedSalesRef.current;
    const next = mergeSalesWithOfflinePending(sales, pendingOfflineSales, {
      accountId,
      branchId,
      userId: user?.uid || null,
    }) as HistorySale[];
    lastMergedSalesRef.current = next;
    return next;
  }, [isFocused, sales, pendingOfflineSales, accountId, branchId, user?.uid]);

  // ============================================================================
  // ACCIONES DEL COMPROBANTE: REIMPRESIÓN, COMPARTIR Y ANULACIÓN
  // ============================================================================
  const handlePrintSale = async (sale: Sale) => {
    setIsPrinting(true);
    try {
      const cfg = await getPrinterConfig();
      const saleBranch = resolveSaleBranch(sale);
      const effectivePaperWidth: 58 | 80 =
        detailPaperWidth || (cfg.paperWidth === 58 ? 58 : 80);
      const docMeta = resolveReceiptDocumentMeta(sale);
      const printOptions = {
        paperWidth: effectivePaperWidth,
        autoCut: cfg.autoCut !== false,
        openDrawer: false,
        branch: saleBranch,
        taxProfile,
        consultUrl: receiptBusiness.consultUrl,
        receiptFooter:
          posSettings?.ticketFooterMessage ||
          businessSettings?.receiptFooter ||
          '¡Gracias por su compra!',
      };

      let printedViaBluetooth = false;
      if (cfg.connectionType === 'bluetooth' && cfg.selectedDevice?.address) {
        const bytes = buildSaleReceiptEscPos(sale, receiptBusiness, printOptions);
        printedViaBluetooth = await printRawEscPos(bytes, cfg.selectedDevice.address);
      }

      if (!printedViaBluetooth) {
        await printTicketPDF(
          {
            title: `Ticket_${docMeta.docNumber || sale.id}`,
            sale,
            business: receiptBusiness,
            options: printOptions,
          },
          printOptions
        );
      }
      Alert.alert(
        printedViaBluetooth ? 'Ticket Impreso' : 'Ticket Generado',
        printedViaBluetooth
          ? 'El comprobante ha sido enviado a la impresora Bluetooth.'
          : 'No hay impresora Bluetooth conectada; se generó el ticket en PDF para imprimir.'
      );
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
      const saleBranch = resolveSaleBranch(sale);
      const shareConfig = {
        phone,
        paperWidth: detailPaperWidth,
        branch: saleBranch,
        taxProfile,
        consultUrl: receiptBusiness.consultUrl,
        receiptFooter:
          posSettings?.ticketFooterMessage ||
          businessSettings?.receiptFooter ||
          '¡Gracias por su compra!',
      };
      await shareTicketWhatsApp(
        {
          sale,
          business: receiptBusiness,
          options: shareConfig,
        },
        receiptBusiness,
        shareConfig
      );
    } catch (err: any) {
      Alert.alert('Error al Compartir', err?.message || 'No se pudo generar el documento PDF.');
    } finally {
      setIsSharing(false);
    }
  };

  const applyEinvoiceToSalesState = useCallback((saleId: string, einvoice: PublicEinvoice | null) => {
    if (!einvoice) return;
    const patch = (s: Sale): Sale =>
      s.id !== saleId
        ? s
        : ({
            ...s,
            sunatStatus: einvoice.status as Sale['sunatStatus'],
            documentNumber: einvoice.documentNumber || s.documentNumber,
            cdrDescription: einvoice.cdr?.description || (s as any).cdrDescription,
            sunatHash: (einvoice as any).sunatHash || (s as any).sunatHash,
          } as Sale);
    setSales((prev) => prev.map(patch));
    setSelectedSale((prev) => (prev && prev.id === saleId ? patch(prev) : prev));
  }, []);

  const fetchSaleEinvoice = useCallback(
    async (saleId: string): Promise<PublicEinvoice | null> => {
      if (!accountId) return null;
      const res = await apiRequest<{ success: boolean; einvoice: PublicEinvoice | null }>(
        `/api/invoicing/status?accountId=${encodeURIComponent(accountId)}&saleId=${encodeURIComponent(saleId)}`,
        { timeoutMs: 45000 }
      );
      return res?.einvoice || null;
    },
    [accountId]
  );

  const refreshSelectedSaleSunat = useCallback(
    async (sale: Sale): Promise<PublicEinvoice | null> => {
      const einvoice = await fetchSaleEinvoice(sale.id);
      applyEinvoiceToSalesState(sale.id, einvoice);
      if (einvoice) {
        setActiveEinvoice(einvoice);
      }
      return einvoice;
    },
    [fetchSaleEinvoice, applyEinvoiceToSalesState]
  );

  const handleEmitMissingSunat = useCallback(
    async (sale: Sale) => {
      if (guardOfflinePendingSaleAction(sale, 'emitir en SUNAT')) return;
      if (!accountId) return;
      const meta = resolveReceiptDocumentMeta(sale);
      const docType: '01' | '03' = meta.isFacturaDoc ? '01' : '03';
      const cleanRuc = String(sale.customerRuc || sale.receiptCustomer?.identityNumber || '').trim();
      const cleanDni = String(sale.customerDni || sale.receiptCustomer?.identityNumber || '').trim();
      if (docType === '01' && !/^\d{11}$/.test(cleanRuc)) {
        Alert.alert(
          'RUC requerido',
          'Esta venta no tiene un RUC válido de 11 dígitos. Puedes revisarlo en el módulo de Facturación.'
        );
        return;
      }
      setLoadingSunatAction(true);
      try {
        await assertOnlineForWrite('emitir el comprobante en SUNAT', isOnlineRef.current);
        const customerPayload =
          docType === '01'
            ? {
                identityType: '6' as const,
                identityNumber: cleanRuc,
                name: sale.customerName || 'Cliente',
              }
            : /^\d{8}$/.test(cleanDni)
              ? {
                  identityType: '1' as const,
                  identityNumber: cleanDni,
                  name: sale.customerName || 'Cliente',
                }
              : undefined;

        const emitted = await emitEinvoiceDocument({
          accountId,
          saleId: sale.id,
          documentType: docType,
          customer: customerPayload,
        });
        applyEinvoiceToSalesState(sale.id, emitted);
        setActiveEinvoice(emitted);
        setEinvoiceModalVisible(true);
      } catch (err: any) {
        Alert.alert('Error SUNAT', err?.message || 'No se pudo emitir el comprobante.');
      } finally {
        setLoadingSunatAction(false);
      }
    },
    [accountId, applyEinvoiceToSalesState]
  );

  const handleOpenSunatActions = useCallback(
    async (sale: Sale) => {
      if (guardOfflinePendingSaleAction(sale, 'emitir o gestionar en SUNAT')) return;
      if (!accountId) return;
      setLoadingSunatAction(true);
      try {
        await assertOnlineForWrite('consultar comprobantes en SUNAT', isOnlineRef.current);
        const saleDateMs = toEpochMillis(sale.date || (sale as any).createdAt);
        const nowMs = Date.now();
        const fromMs = saleDateMs > 0 ? saleDateMs - 3 * 86_400_000 : nowMs - 30 * 86_400_000;
        const toMs = saleDateMs > 0 ? saleDateMs + 3 * 86_400_000 : nowMs + 30 * 86_400_000;
        const from = formatLocalIsoDate(new Date(fromMs));
        const to = formatLocalIsoDate(new Date(toMs));

        const [einvoice, allDocs] = await Promise.all([
          refreshSelectedSaleSunat(sale),
          fetchEinvoices(accountId, {
            branchId: sale.branchId || branchId || undefined,
            from,
            to,
          }).catch(() => []),
        ]);
        if (einvoice) {
          setActiveEinvoice(einvoice);
          setAllAccountEinvoices(allDocs);
          setEinvoiceModalVisible(true);
          return;
        }
        Alert.alert(
          'Sin registro SUNAT',
          'Este comprobante aún no fue enviado a SUNAT. ¿Deseas emitirlo ahora o ir al módulo de Facturación?',
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Ir a Facturación',
              onPress: () => {
                setSaleDetailModalVisible(false);
                router.push('/facturacion' as Href);
              },
            },
            {
              text: 'Emitir ahora',
              onPress: () => void handleEmitMissingSunat(sale),
            },
          ]
        );
      } catch (err: any) {
        Alert.alert('Error SUNAT', err?.message || 'No se pudo consultar el estado en SUNAT.');
      } finally {
        setLoadingSunatAction(false);
      }
    },
    [accountId, branchId, refreshSelectedSaleSunat, router, handleEmitMissingSunat]
  );

  const handleQuickConsultOrRetrySunat = useCallback(
    async (sale: Sale) => {
      if (guardOfflinePendingSaleAction(sale, 'consultar o reintentar en SUNAT')) return;
      if (!accountId) return;
      setLoadingSunatAction(true);
      try {
        await assertOnlineForWrite('consultar o reintentar en SUNAT', isOnlineRef.current);
        const existing = await refreshSelectedSaleSunat(sale);
        if (!existing) {
          await handleEmitMissingSunat(sale);
          return;
        }
        if (existing.status === 'accepted') {
          Alert.alert(
            'SUNAT Aceptado',
            `${existing.documentNumber || 'Comprobante'} ya fue aceptado por SUNAT.`
          );
          return;
        }
        const retried = await retryEinvoiceDocument(accountId, existing.id);
        applyEinvoiceToSalesState(sale.id, retried);
        setActiveEinvoice(retried);
        Alert.alert(
          retried.status === 'accepted' ? 'Comprobante Aceptado' : 'Estado Actualizado',
          retried.cdr?.description || retried.lastError || `Estado actual: ${retried.status}`
        );
      } catch (err: any) {
        Alert.alert('Error SUNAT', err?.message || 'No se pudo consultar o reintentar el envío.');
      } finally {
        setLoadingSunatAction(false);
      }
    },
    [accountId, refreshSelectedSaleSunat, handleEmitMissingSunat, applyEinvoiceToSalesState]
  );

  const handleConfirmCancelSale = async () => {
    if (!selectedSale) return;
    if (guardOfflinePendingSaleAction(selectedSale, 'anularla')) return;
    if (!canProcessReturn) {
      Alert.alert(
        'Acceso Denegado',
        'No cuentas con permisos para anular ventas ni revertir inventario.'
      );
      return;
    }
    if (!cancelReason.trim()) {
      Alert.alert('Motivo Requerido', 'Indique la razón justificada de la anulación.');
      return;
    }
    if (!user) return;

    setIsCancelling(true);
    try {
      await assertOnlineForWrite('anular una venta', isOnlineRef.current);
      await cancelSaleWithReversal(
        selectedSale.id,
        cancelReason.trim(),
        {
          uid: user.uid,
          displayName: userProfile?.displayName || user.email || 'Operador',
          email: user.email,
          role,
        },
        { enableSellerAttribution: posSettings?.enableSellerAttribution === true }
      );

      setCancelModalVisible(false);
      setSaleDetailModalVisible(false);
      setCancelReason('');
      setSelectedSale(null);
      void fetchSalesPage(true);
      void refreshCashStatus();

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
    if (guardOfflinePendingSaleAction(selectedSale, 'procesar una devolución')) return;
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
      return (
        sum + (Number(line?.lineTotal) || Number(line?.price || 0) * Number(line?.quantity || 0))
      );
    }, 0);
    setIsRefunding(true);
    try {
      await assertOnlineForWrite('registrar una devolución', isOnlineRef.current);
      const sessionId = activeCashSession?.sessionId || activeCashSession?.id;
      if (!sessionId) throw new Error('Abre una caja antes de registrar una devolución.');
      const refundBranchId = selectedSale.branchId || branchId;
      if (!accountId || !refundBranchId) {
        throw new Error('No se pudo determinar la cuenta y sucursal de la venta.');
      }
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
      Alert.alert(
        'Devolución registrada',
        `${formatPEN(amount)} se registró como devolución parcial y el stock retornó al inventario.`
      );
    } catch (error: any) {
      Alert.alert(
        'No se pudo devolver',
        error?.message || 'Revisa la venta e inténtalo nuevamente.'
      );
    } finally {
      setIsRefunding(false);
    }
  };

  const handleSelectSale = useCallback((sale: Sale) => {
    setSelectedSale(sale);
    setSaleDetailModalVisible(true);
  }, []);

  const handleLoadMoreSales = useCallback(() => {
    void fetchSalesPage(false);
  }, [fetchSalesPage]);

  const handleOpenCustomDateModal = useCallback(() => {
    if (!customStartDate || !customEndDate) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const endStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const sevenAgo = new Date(Date.now() - 7 * 86400000);
      const startStr = `${sevenAgo.getFullYear()}-${pad(sevenAgo.getMonth() + 1)}-${pad(sevenAgo.getDate())}`;
      setDraftStartDate(startStr);
      setDraftEndDate(endStr);
    } else {
      setDraftStartDate(customStartDate);
      setDraftEndDate(customEndDate);
    }
    setCustomDateModalOpen(true);
  }, [customStartDate, customEndDate]);

  const handleCloseEinvoiceModal = useCallback(() => {
    setEinvoiceModalVisible(false);
    setActiveEinvoice(null);
    setAllAccountEinvoices([]);
  }, []);

  const handleEinvoiceUpdated = useCallback(() => {
    void fetchSalesPage(true);
    if (selectedSale) {
      void refreshSelectedSaleSunat(selectedSale);
    }
  }, [fetchSalesPage, selectedSale, refreshSelectedSaleSunat]);

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <View style={styles.screen}>
      <View style={styles.compactHeaderRow}>
        <Text style={styles.compactHeaderTitle}>
          {activeTab === 'sales' ? 'Ventas' : activeTab === 'reservations' ? 'Reservas' : 'Venty IA'}
        </Text>
        {activeTab === 'sales' ? (
          <View style={styles.compactHeaderActions}>
            {(canViewReports ||
              canCreateCreditNotes ||
              ['owner', 'admin', 'manager'].includes(role || '')) && (
              <TouchableOpacity
                style={styles.compactSunatButton}
                onPress={() => router.push('/facturacion' as Href)}
                accessibilityRole="button"
                accessibilityLabel="Ir a Facturación Electrónica SUNAT"
              >
                <FileText size={14} color={ui.primary} />
                <Text style={styles.compactSunatButtonText}>Facturación</Text>
              </TouchableOpacity>
            )}
            {canViewReports && (
              <TouchableOpacity
                style={styles.compactPnlButton}
                onPress={() => setPnlModalOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Abrir estado de resultados"
              >
                <TrendingUp size={15} color={ui.primary} />
                <Text style={styles.compactPnlButtonText}>Estado de resultados</Text>
              </TouchableOpacity>
            )}
          </View>
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
          <Calendar
            size={17}
            color={activeTab === 'reservations' ? ui.primary : ui.textSecondary}
          />
          <Text
            style={[
              styles.tabButtonText,
              activeTab === 'reservations' && styles.tabButtonTextActive,
            ]}
          >
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
          <Image source={VENTY_ICON} style={styles.tabIconImg} contentFit="contain" />
          <Text style={[styles.tabButtonText, activeTab === 'ai' && styles.tabButtonTextActive]}>
            Asistente IA
          </Text>
        </TouchableOpacity>
      </View>

      {/* SUB-MÓDULO 1: HISTORIAL DE VENTAS Y SUNAT */}
      {activeTab === 'sales' && (
        <>
          {quarantinedCount > 0 && (
            <TouchableOpacity
              onPress={() => router.push('/(tabs)/settings')}
              activeOpacity={0.8}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                marginHorizontal: 14,
                marginTop: 8,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: ui.dangerSoft,
                borderWidth: 1,
                borderColor: ui.danger,
              }}
              accessibilityRole="button"
              accessibilityLabel="Revisar ventas offline en cuarentena en Ajustes"
            >
              <AlertTriangle size={16} color={ui.danger} />
              <Text style={{ flex: 1, fontSize: 12.5, fontWeight: '700', color: ui.danger }}>
                {quarantinedCount} {quarantinedCount === 1 ? 'venta offline en cuarentena' : 'ventas offline en cuarentena'} — Toca para revisar en Ajustes
              </Text>
            </TouchableOpacity>
          )}
          <HistorySalesTab
          isFocused={isFocused}
          isOnline={isOnline}
          mergedSales={mergedSales}
          loadingSales={loadingSales}
          loadingMoreSales={loadingMoreSales}
          salesHasMore={salesHasMore}
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
          invoicingEnabled={invoicingEnabled}
          bottomInset={insets.bottom}
          defaultSearchQuery={lastSalesSearchRef.current}
          defaultDocFilter={lastSalesDocFilterRef.current}
          onSearchTextChange={handleSalesSearchTextChange}
          onDocFilterChange={handleSalesDocFilterChange}
          onSelectDateRange={setDateRange}
          onOpenCustomDateModal={handleOpenCustomDateModal}
          onSelectSale={handleSelectSale}
          onLoadMoreSales={handleLoadMoreSales}
        />
        </>
      )}

      {/* SUB-MÓDULO 2: RESERVAS Y STOCK APARTADO */}
      {activeTab === 'reservations' && (
        <HistoryReservationsTab
          reservations={reservations}
          loadingReservations={loadingReservations}
          bottomInset={insets.bottom}
          onViewTicket={handleViewReservationTicket}
          onOpenPay={handleOpenPayReservation}
          onComplete={handleCompleteReservation}
          onCancel={handleCancelReservation}
        />
      )}

      {/* SUB-MÓDULO 3: ASISTENTE VENTY IA */}
      {activeTab === 'ai' && (
        <HistoryAiChatTab
          accountId={accountId}
          branchId={branchId}
          bottomInset={insets.bottom}
          chatMessages={chatMessages}
          setChatMessages={setChatMessages}
        />
      )}

      {/* ==================================================================== */}
      {/* MODAL: DETALLE DEL COMPROBANTE Y ACCIONES */}
      {/* ==================================================================== */}
      {saleDetailModalVisible && (
        <Modal
          visible={saleDetailModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setSaleDetailModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { maxHeight: '90%' }]}>
              {selectedSale && detailMeta && (
                <>
                  <View style={styles.modalHeader}>
                    <View>
                      <Text style={styles.modalTitle}>{detailMeta.displayTitle}</Text>
                      <Text style={styles.modalSub}>{detailMeta.docNumber}</Text>
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
                    <View style={styles.detailSwitchRow}>
                      <View style={styles.detailSegmentGroup}>
                        {([
                          { id: 'ticket', label: 'Ticket' },
                          { id: 'summary', label: 'Detalle' },
                        ] as const).map((tabOpt) => {
                          const active = detailViewMode === tabOpt.id;
                          return (
                            <TouchableOpacity
                              key={tabOpt.id}
                              style={[
                                styles.detailSegmentBtn,
                                active && styles.detailSegmentBtnActive,
                              ]}
                              onPress={() => setDetailViewMode(tabOpt.id)}
                            >
                              <Text
                                style={[
                                  styles.detailSegmentText,
                                  active && styles.detailSegmentTextActive,
                                ]}
                              >
                                {tabOpt.label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      {detailViewMode === 'ticket' ? (
                        <View style={styles.detailPaperGroup}>
                          {([80, 58] as const).map((width) => {
                            const active = detailPaperWidth === width;
                            return (
                              <TouchableOpacity
                                key={width}
                                style={[
                                  styles.detailPaperChip,
                                  active && styles.detailPaperChipActive,
                                ]}
                                onPress={() => setDetailPaperWidth(width)}
                              >
                                <Text
                                  style={[
                                    styles.detailPaperText,
                                    active && styles.detailPaperTextActive,
                                  ]}
                                >
                                  {width}mm
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      ) : null}
                    </View>

                    {detailViewMode === 'ticket' ? (
                      <View style={{ alignItems: 'center', marginBottom: 14 }}>
                        <ReceiptTicketPreview
                          sale={selectedSale}
                          business={receiptBusiness}
                          branch={selectedSaleBranch}
                          taxProfile={taxProfile}
                          receiptFooter={
                            posSettings?.ticketFooterMessage ||
                            businessSettings?.receiptFooter ||
                            '¡Gracias por su compra!'
                          }
                          paperWidth={detailPaperWidth}
                        />
                      </View>
                    ) : (
                      <>
                        <View style={styles.detailSection}>
                          <Text style={styles.detailSectionTitle}>DATOS DEL COMPROBANTE</Text>
                          <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>Fecha y Hora:</Text>
                            <Text style={styles.detailValue}>
                              {formatDatePE(selectedSale.date || (selectedSale as any).createdAt)}
                            </Text>
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
                              {(
                                (selectedSale as any).paymentMethodName ||
                                selectedSale.paymentMethod ||
                                'Efectivo'
                              ).toUpperCase()}
                            </Text>
                          </View>
                        </View>

                        <View style={styles.detailSection}>
                          <Text style={styles.detailSectionTitle}>ÍTEMS VENDIDOS</Text>
                          {selectedSale.items?.map((it, idx) => (
                            <View key={idx} style={styles.itemRow}>
                              <View style={styles.flex1}>
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

                        {detailReceiptAmounts ? (
                          <View style={styles.detailSection}>
                            {detailReceiptAmounts.taxed > 0 && (
                              <View style={styles.detailRow}>
                                <Text style={styles.detailLabel}>Op. Gravada:</Text>
                                <Text style={styles.detailValue}>
                                  {formatPEN(detailReceiptAmounts.taxed)}
                                </Text>
                              </View>
                            )}
                            {detailReceiptAmounts.exempt > 0 && (
                              <View style={styles.detailRow}>
                                <Text style={styles.detailLabel}>Op. Exonerada:</Text>
                                <Text style={styles.detailValue}>
                                  {formatPEN(detailReceiptAmounts.exempt)}
                                </Text>
                              </View>
                            )}
                            {detailReceiptAmounts.unaffected > 0 && (
                              <View style={styles.detailRow}>
                                <Text style={styles.detailLabel}>Op. Inafecta:</Text>
                                <Text style={styles.detailValue}>
                                  {formatPEN(detailReceiptAmounts.unaffected)}
                                </Text>
                              </View>
                            )}
                            {(detailReceiptAmounts.igv > 0 || detailReceiptAmounts.taxed > 0) && (
                              <View style={styles.detailRow}>
                                <Text style={styles.detailLabel}>IGV:</Text>
                                <Text style={styles.detailValue}>
                                  {formatPEN(detailReceiptAmounts.igv)}
                                </Text>
                              </View>
                            )}
                            {(selectedSale.discountAmount || 0) > 0 && (
                              <View style={styles.detailRow}>
                                <Text style={styles.detailLabel}>Descuento:</Text>
                                <Text style={styles.detailValue}>
                                  -{formatPEN(selectedSale.discountAmount || 0)}
                                </Text>
                              </View>
                            )}
                            <View
                              style={[
                                styles.detailRow,
                                { borderTopWidth: 1, borderTopColor: ui.border, paddingTop: 6 },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.detailLabel,
                                  { fontWeight: 'bold', fontSize: 16, color: ui.text },
                                ]}
                              >
                                TOTAL:
                              </Text>
                              <Text
                                style={[
                                  styles.detailValue,
                                  { fontWeight: 'bold', fontSize: 18, color: ui.primary },
                                ]}
                              >
                                {formatPEN(detailReceiptAmounts.total || selectedSale.total)}
                              </Text>
                            </View>
                          </View>
                        ) : null}

                        {!detailMeta.isQuote &&
                        !detailMeta.isOfflinePending &&
                        (detailMeta.isFiscal ||
                          detailMeta.isFacturaDoc ||
                          Boolean(
                            selectedSale.sunatStatus &&
                              selectedSale.sunatStatus !== 'not_applicable'
                          )) ? (
                          <View style={styles.detailSection}>
                            <Text style={styles.detailSectionTitle}>ESTADO TRIBUTARIO SUNAT</Text>
                            <View style={styles.detailRow}>
                              <Text style={styles.detailLabel}>Estado / CDR:</Text>
                              <Text
                                style={[
                                  styles.detailValue,
                                  {
                                    color:
                                      selectedSale.sunatStatus === 'accepted'
                                        ? ui.primary
                                        : selectedSale.sunatStatus === 'rejected'
                                          ? ui.danger
                                          : ui.warning,
                                    fontWeight: 'bold',
                                  },
                                ]}
                              >
                                {selectedSale.sunatStatus === 'accepted'
                                  ? (selectedSale as any).cdrDescription || 'Comprobante Aceptado'
                                  : (selectedSale as any).cdrDescription ||
                                    selectedSale.sunatStatus ||
                                    'Pendiente de envío'}
                              </Text>
                            </View>
                            <View style={styles.sunatActionRow}>
                              <TouchableOpacity
                                style={[
                                  styles.sunatActionBtn,
                                  loadingSunatAction && styles.buttonDisabled,
                                ]}
                                onPress={() => void handleOpenSunatActions(selectedSale)}
                                disabled={loadingSunatAction}
                                accessibilityRole="button"
                                accessibilityLabel="Gestionar comprobante SUNAT, notas y XML/CDR"
                              >
                                {loadingSunatAction ? (
                                  <ActivityIndicator size="small" color={ui.onPrimary} />
                                ) : (
                                  <>
                                    <FileText size={15} color={ui.onPrimary} />
                                    <Text style={styles.sunatActionBtnText}>
                                      {selectedSale.sunatStatus === 'accepted'
                                        ? 'NC / ND / Sustituto / XML'
                                        : 'Gestionar / Emitir SUNAT'}
                                    </Text>
                                  </>
                                )}
                              </TouchableOpacity>
                              {selectedSale.sunatStatus !== 'accepted' && (
                                <TouchableOpacity
                                  style={[
                                    styles.sunatActionSecondaryBtn,
                                    loadingSunatAction && styles.buttonDisabled,
                                  ]}
                                  onPress={() => void handleQuickConsultOrRetrySunat(selectedSale)}
                                  disabled={loadingSunatAction}
                                  accessibilityRole="button"
                                  accessibilityLabel="Consultar o reintentar envío SUNAT"
                                >
                                  <RefreshCw size={15} color={ui.text} />
                                  <Text style={styles.sunatActionSecondaryText}>
                                    Consultar / Reintentar
                                  </Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          </View>
                        ) : null}
                      </>
                    )}
                  </ScrollView>

                  <View style={styles.actionGrid}>
                    <TouchableOpacity
                      style={[styles.modalActionBtn, { borderColor: ui.primary }]}
                      onPress={() => void handlePrintSale(selectedSale)}
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
                      onPress={() => void handleShareWhatsApp(selectedSale)}
                      disabled={isSharing}
                      accessibilityRole="button"
                      accessibilityLabel={
                        isSharing
                          ? 'Preparando envío por WhatsApp'
                          : 'Enviar comprobante por WhatsApp'
                      }
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

                  {detailViewMode === 'ticket' &&
                  !detailMeta.isQuote &&
                  !detailMeta.isOfflinePending &&
                  (detailMeta.isFiscal ||
                    detailMeta.isFacturaDoc ||
                    Boolean(
                      selectedSale.sunatStatus && selectedSale.sunatStatus !== 'not_applicable'
                    )) ? (
                    <TouchableOpacity
                      style={[styles.sunatActionSecondaryBtn, { marginBottom: 8, flex: undefined }]}
                      onPress={() => void handleOpenSunatActions(selectedSale)}
                      disabled={loadingSunatAction}
                      accessibilityRole="button"
                      accessibilityLabel="Gestionar comprobante SUNAT"
                    >
                      <FileText size={16} color={ui.primary} />
                      <Text style={[styles.sunatActionSecondaryText, { color: ui.primary }]}>
                        {selectedSale.sunatStatus === 'accepted'
                          ? 'SUNAT: Emitir NC / ND / Sustituto / XML-CDR'
                          : 'SUNAT: Consultar / Reintentar Comprobante'}
                      </Text>
                    </TouchableOpacity>
                  ) : null}

                  {selectedSale.status === 'completed' &&
                    !(selectedSale as any).refundedLineIndices?.length &&
                    !Number((selectedSale as any).refundedAmount || 0) &&
                    canProcessReturn &&
                    (['owner', 'admin'].includes(role || '') ||
                      posSettings?.enableSellerAttribution ||
                      (selectedSale as any).attributionVersion === 1) && (
                      <TouchableOpacity
                        style={styles.cancelSaleBtn}
                        onPress={() => {
                          if (guardOfflinePendingSaleAction(selectedSale, 'anularla')) return;
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

                  {selectedSale.status === 'completed' &&
                    !selectedSale.isReturn &&
                    !detailMeta.isQuote &&
                    canProcessReturn && (
                      <TouchableOpacity
                        style={[styles.cancelSaleBtn, { borderColor: ui.warning, marginTop: 8 }]}
                        onPress={() => {
                          if (
                            guardOfflinePendingSaleAction(selectedSale, 'procesar una devolución')
                          ) {
                            return;
                          }
                          setRefundLineIndices([]);
                          setRefundPaymentMethod('cash');
                          setRefundModalVisible(true);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Devolver uno o más artículos de la venta"
                      >
                        <RefreshCw size={18} color={ui.warning} />
                        <Text style={[styles.cancelSaleText, { color: ui.warning }]}>
                          Devolver artículos
                        </Text>
                      </TouchableOpacity>
                    )}

                  {detailMeta.isOfflinePending && (
                    <TouchableOpacity
                      style={[styles.cancelSaleBtn, { marginTop: 8 }]}
                      onPress={() => {
                        const targetOfflineId =
                          (selectedSale as any).offlineId || selectedSale.id;
                        if (!targetOfflineId) return;
                        Alert.alert(
                          'Descartar venta offline',
                          'Esta venta aún no se ha subido al servidor. Al descartarla se eliminará de la cola pendiente y se restaurará el stock local. ¿Continuar?',
                          [
                            { text: 'Volver', style: 'cancel' },
                            {
                              text: 'Descartar',
                              style: 'destructive',
                              onPress: async () => {
                                await cancelPendingOfflineSale(targetOfflineId);
                                void refreshOfflineCount();
                                setSaleDetailModalVisible(false);
                                setSelectedSale(null);
                              },
                            },
                          ]
                        );
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Descartar venta offline pendiente"
                    >
                      <Trash2 size={18} color={ui.danger} />
                      <Text style={styles.cancelSaleText}>Descartar venta offline</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </View>
        </Modal>
      )}

      {refundModalVisible && (
        <Modal
          visible={refundModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setRefundModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { maxHeight: '85%' }]}>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.modalTitle}>Devolución parcial</Text>
                  <Text style={styles.modalSub}>Selecciona los artículos que regresan</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setRefundModalVisible(false)}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar devolución"
                >
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>
              <ScrollView>
                {selectedSale?.items?.map((line, index) => {
                  const selected = refundLineIndices.includes(index);
                  const lineAmount =
                    Number(line.lineTotal) || Number(line.price || 0) * Number(line.quantity || 0);
                  return (
                    <TouchableOpacity
                      key={`${line.id}-${index}`}
                      style={[
                        styles.itemRow,
                        selected && { backgroundColor: ui.warningSoft, borderRadius: 8 },
                      ]}
                      onPress={() =>
                        setRefundLineIndices((current) =>
                          selected
                            ? current.filter((itemIndex) => itemIndex !== index)
                            : [...current, index]
                        )
                      }
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                    >
                      <View style={styles.flex1}>
                        <Text style={styles.itemName}>{line.name}</Text>
                        <Text style={styles.itemSub}>
                          {line.quantity} x {formatPEN(line.price)}
                        </Text>
                      </View>
                      <Text style={styles.itemTotal}>{formatPEN(lineAmount)}</Text>
                      {selected && (
                        <CheckCircle2 size={18} color={ui.warning} style={{ marginLeft: 8 }} />
                      )}
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
                  <TouchableOpacity
                    key={method.id}
                    style={[
                      styles.refundMethodChip,
                      refundPaymentMethod === method.id && styles.refundMethodChipActive,
                    ]}
                    onPress={() => setRefundPaymentMethod(method.id as any)}
                  >
                    <Text
                      style={[
                        styles.refundMethodChipText,
                        refundPaymentMethod === method.id && styles.refundMethodChipTextActive,
                      ]}
                    >
                      {method.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.confirmCancelBtn, isRefunding && styles.buttonDisabled]}
                onPress={handleRefundSelectedLines}
                disabled={isRefunding}
              >
                {isRefunding ? (
                  <ActivityIndicator color={ui.onPrimary} />
                ) : (
                  <Text style={styles.confirmCancelBtnText}>Registrar devolución</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* MODAL: CONFIRMACIÓN Y MOTIVO DE ANULACIÓN */}
      {cancelModalVisible && (
        <Modal
          visible={cancelModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setCancelModalVisible(false)}
        >
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
                accessibilityLabel={
                  isCancelling
                    ? 'Procesando anulación'
                    : 'Confirmar anulación y actualizar kardex'
                }
                accessibilityState={{ disabled: isCancelling, busy: isCancelling }}
              >
                {isCancelling ? (
                  <ActivityIndicator color={ui.onPrimary} />
                ) : (
                  <>
                    <Trash2 size={18} color={ui.onPrimary} />
                    <Text style={styles.confirmCancelBtnText}>
                      Confirmar Anulación y Kardex
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}

      {pnlModalOpen && (
        <FinancialPnlModal visible={pnlModalOpen} onClose={() => setPnlModalOpen(false)} />
      )}

      {/* Modal de Rango de Fechas Personalizado */}
      {customDateModalOpen && (
        <Modal
          visible={customDateModalOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setCustomDateModalOpen(false)}
        >
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
                        setDraftStartDate(yStr);
                        setDraftEndDate(yStr);
                      } else {
                        const endStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                        const past = new Date(Date.now() - shortcut.days * 86400000);
                        const startStr = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}`;
                        setDraftStartDate(startStr);
                        setDraftEndDate(endStr);
                      }
                    }}
                  >
                    <Text style={styles.quickDateChipText}>{shortcut.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.dateInputsRow}>
                <View style={[styles.inputGroup, styles.flex1]}>
                  <Text style={styles.label}>Desde (AAAA-MM-DD)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="2026-01-01"
                    placeholderTextColor={ui.textMuted}
                    value={draftStartDate}
                    onChangeText={setDraftStartDate}
                    keyboardType="numbers-and-punctuation"
                    maxLength={10}
                  />
                </View>
                <View style={[styles.inputGroup, styles.flex1]}>
                  <Text style={styles.label}>Hasta (AAAA-MM-DD)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="2026-01-31"
                    placeholderTextColor={ui.textMuted}
                    value={draftEndDate}
                    onChangeText={setDraftEndDate}
                    keyboardType="numbers-and-punctuation"
                    maxLength={10}
                  />
                </View>
              </View>

              <View style={styles.customDateActions}>
                <TouchableOpacity
                  style={styles.cancelDateBtn}
                  onPress={() => setCustomDateModalOpen(false)}
                >
                  <Text style={styles.cancelDateBtnText}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.applyDateBtn}
                  onPress={() => {
                    if (draftStartDate && draftEndDate) {
                      setCustomStartDate(draftStartDate);
                      setCustomEndDate(draftEndDate);
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
          business={reservationBusiness}
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
        <Modal
          visible={paymentModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setPaymentModalVisible(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.modalOverlay}
          >
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.modalTitle}>Cobrar Saldo y Entregar</Text>
                  <Text style={styles.modalSub}>
                    {reservationToPay?.customer?.name || 'Cliente General'} · #
                    {String(reservationToPay?.id || '').slice(-6).toUpperCase()}
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
                  <View
                    style={{
                      backgroundColor: '#F8FAFC',
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 14,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        marginBottom: 4,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: '#64748B' }}>Total de la Reserva:</Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#0F172A' }}>
                        {formatPEN(reservationToPay.total)}
                      </Text>
                    </View>
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        marginBottom: 4,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: '#15803D' }}>
                        Adelanto / Seña pagada:
                      </Text>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#15803D' }}>
                        - {formatPEN(reservationToPay.depositAmount || 0)}
                      </Text>
                    </View>
                    <View style={{ height: 1, backgroundColor: '#E2E8F0', marginVertical: 6 }} />
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 15, fontWeight: '800', color: ui.danger }}>
                        SALDO A COBRAR:
                      </Text>
                      <Text style={{ fontSize: 18, fontWeight: '800', color: ui.danger }}>
                        {formatPEN(
                          Math.max(
                            0,
                            Number(reservationToPay.total || 0) -
                              Number(reservationToPay.depositAmount || 0)
                          )
                        )}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.label}>Método de Pago para el Saldo</Text>
                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      gap: 6,
                      marginVertical: 8,
                    }}
                  >
                    {(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'] as const).map(
                      (m) => (
                        <TouchableOpacity
                          key={m}
                          style={{
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: payMethod === m ? ui.primary : ui.border,
                            backgroundColor: payMethod === m ? ui.primarySoft : ui.surface,
                          }}
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
                      )
                    )}
                  </View>

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
                      {(parseNormalizedDecimal(payCashReceived) ?? 0) >
                      Math.max(
                        0,
                        Number(reservationToPay.total || 0) -
                          Number(reservationToPay.depositAmount || 0)
                      ) ? (
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: '700',
                            color: ui.success,
                            marginTop: 4,
                          }}
                        >
                          Vuelto:{' '}
                          {formatPEN(
                            (parseNormalizedDecimal(payCashReceived) ?? 0) -
                              Math.max(
                                0,
                                Number(reservationToPay.total || 0) -
                                  Number(reservationToPay.depositAmount || 0)
                              )
                          )}
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

      {einvoiceModalVisible && activeEinvoice && (
        <EinvoiceActionsModal
          visible={einvoiceModalVisible}
          einvoice={activeEinvoice}
          allEinvoices={allAccountEinvoices}
          accountId={accountId || ''}
          taxRate={taxProfile.taxRate}
          invoicingEnabled={invoicingEnabled}
          onClose={handleCloseEinvoiceModal}
          onUpdated={handleEinvoiceUpdated}
        />
      )}
    </View>
  );
}
