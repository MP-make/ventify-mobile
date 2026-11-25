import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  InteractionManager,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  BarChart3,
  CalendarClock,
  Lock,
  UserCheck,
  Users,
  Wallet,
} from 'lucide-react-native';
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';

import { useAuthSession, useNetworkStatus, usePlanFeatures } from '@/context/AuthContext';
import { type PlanFeatureKey } from '@/lib/plan-entitlements';
import { PlanUpgradeModal } from '@/components/PlanFeatureGate';
import {
  useBusinessSettings,
  useCashSession,
  useOfflineStatus,
} from '@/context/SettingsContext';
import { useFocusMemo } from '@/hooks/use-focus-memo';
import { usePermissions } from '@/hooks/usePermissions';
import { db } from '@/lib/firebase';
import {
  computeOfflineCashDelta,
  mergeSalesWithOfflinePending,
  type OfflineCashBreakdownDelta,
} from '@/lib/offline-sales-helpers';
import { formatPEN, ui } from '@/lib/theme';
import {
  getActiveCashSession,
  subscribeToSessionMovements,
  type CashMovement,
  type CashMovementType,
  type CashSession,
} from '@/services/cash-register-service';
import {
  approveOrder,
  completeOrCancelReservation,
  getCustomerFiadoHistory,
  getCustomerOpenFiados,
  getCustomers,
  getReservationsAndOrders,
  recalculateCustomerDebt,
  type CustomerData,
  type FiadoHistoryEntry,
  type OpenFiado,
  type ReservationOrder,
} from '@/services/crm-operations-service';

import { FinancialPnlModal } from '@/components/FinancialPnlModal';
import { PayrollUsersModal } from '@/components/PayrollUsersModal';
import { ReservationCancellationModal } from '@/components/ReservationCancellationModal';
import { ReservationCompletionModal } from '@/components/ReservationCompletionModal';
import { ReservationReceiptModal } from '@/components/ReservationReceiptModal';

import { CashMovementModal } from '@/components/operations/CashMovementModal';
import { CashTabView } from '@/components/operations/CashTabView';
import {
  CloseCashModal,
  ClosureSuccessModal,
} from '@/components/operations/CloseCashModal';
import { CrmTabView } from '@/components/operations/CrmTabView';
import { CustomerDetailModal } from '@/components/operations/CustomerDetailModal';
import { CustomerFormModal } from '@/components/operations/CustomerFormModal';
import { FiadoPaymentModal } from '@/components/operations/FiadoPaymentModal';
import { FiadoReturnModal } from '@/components/operations/FiadoReturnModal';
import { FiadoWriteOffModal } from '@/components/operations/FiadoWriteOffModal';
import { NewReservationModal } from '@/components/operations/NewReservationModal';
import { OrdersTabView } from '@/components/operations/OrdersTabView';
import { VentyAiModal } from '@/components/operations/VentyAiModal';
import { operationsStyles as styles } from '@/components/operations/operationsStyles';
import type {
  OperationsTab,
  PaymentModalState,
  SalesBreakdown,
} from '@/components/operations/types';

const VENTY_ICON = require('../../assets/venty-icon.webp');
const BRANCH_SESSIONS_TTL_MS = 45_000;
const CASH_LISTENER_BLUR_GRACE_MS = 30_000;
const EMPTY_SESSION_SALES: any[] = [];
const EMPTY_OFFLINE_CASH_DELTA: OfflineCashBreakdownDelta = {
  cash: 0,
  yape: 0,
  plin: 0,
  card: 0,
  transfer: 0,
  credit: 0,
  totalDigital: 0,
  totalAll: 0,
  count: 0,
  counts: {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    credit: 0,
    total: 0,
  },
};
const EMPTY_SALES_BREAKDOWN: SalesBreakdown = {
  cash: 0,
  yape: 0,
  plin: 0,
  card: 0,
  transfer: 0,
  credit: 0,
  totalDigital: 0,
  totalAll: 0,
  usingSessionFallback: false,
  counts: {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    credit: 0,
    total: 0,
  },
};

export default function OperationsScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const router = useRouter();

  const { user, userProfile, accountId, branchId, role, setActiveBranchId } =
    useAuthSession();
  const { isOnline } = useNetworkStatus();
  const { businessSettings, activeBranch, branches } = useBusinessSettings();
  const { isCashOpen, activeCashSession, refreshCashStatus } = useCashSession();
  const {
    pendingOfflineSales,
    pendingCashMovements,
    quarantinedCount,
    lastSyncSuccessAt,
    triggerManualSync,
  } = useOfflineStatus();
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const {
    canManageUsers,
    isOwner,
    isAdmin,
    isCashier,
    canManageCustomers,
    canProcessReturn,
    canViewMargins,
    canViewReports,
  } = usePermissions();
  const { features, planName } = usePlanFeatures();
  const isSupervisor = isOwner || isAdmin;

  const [activeTab, setActiveTab] = useState<OperationsTab>('cash');
  const [payrollModalOpen, setPayrollModalOpen] = useState<boolean>(false);
  const [pnlModalOpen, setPnlModalOpen] = useState<boolean>(false);
  const [ventyModalVisible, setVentyModalVisible] = useState<boolean>(false);
  const [upgradeFeature, setUpgradeFeature] = useState<PlanFeatureKey | null>(null);

  // Multi-caja para Dueños y Administradores (con TTL de 45s en retorno a foco)
  const [branchSessions, setBranchSessions] = useState<
    Record<string, CashSession | null>
  >({});
  const [loadingBranchSessions, setLoadingBranchSessions] =
    useState<boolean>(false);
  const lastBranchSessionsFetchRef = useRef<number>(0);
  const lastBranchSessionsScopeRef = useRef<string>('');
  const branchSessionsGenerationRef = useRef<number>(0);

  // Caja y turno activo
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [loadingMovements, setLoadingMovements] = useState<boolean>(false);
  const [sessionSales, setSessionSales] = useState<any[]>([]);
  const [loadingSessionSales, setLoadingSessionSales] = useState<boolean>(false);
  const loadedMovementsSessionRef = useRef<string | null>(null);
  const loadedSalesSessionRef = useRef<string | null>(null);

  const [movementModalState, setMovementModalState] = useState<{
    visible: boolean;
    initialType: CashMovementType;
  }>({ visible: false, initialType: 'expense' });
  const [closeModalVisible, setCloseModalVisible] = useState<boolean>(false);
  const [closureReport, setClosureReport] = useState<any | null>(null);

  // CRM y Fiados
  const [customers, setCustomers] = useState<CustomerData[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState<boolean>(false);
  const hasLoadedCustomersRef = useRef<string | null>(null);
  const [newCustomerModalVisible, setNewCustomerModalVisible] =
    useState<boolean>(false);
  const [paymentModalState, setPaymentModalState] = useState<PaymentModalState>({
    visible: false,
    customer: null,
  });

  // Detalle de cliente y acciones sobre fiado
  const [customerDetailModalVisible, setCustomerDetailModalVisible] =
    useState<boolean>(false);
  const [detailCustomer, setDetailCustomer] = useState<CustomerData | null>(null);
  const [detailOpenFiados, setDetailOpenFiados] = useState<OpenFiado[]>([]);
  const [detailFiadoHistory, setDetailFiadoHistory] = useState<
    FiadoHistoryEntry[]
  >([]);
  const [loadingCustomerDetail, setLoadingCustomerDetail] =
    useState<boolean>(false);
  const [isRecalculatingDebt, setIsRecalculatingDebt] =
    useState<boolean>(false);
  const [returnFiadoTarget, setReturnFiadoTarget] = useState<OpenFiado | null>(
    null
  );
  const [writeOffTarget, setWriteOffTarget] = useState<OpenFiado | null>(null);

  // Pedidos y Reservas
  const [completionTarget, setCompletionTarget] =
    useState<ReservationOrder | null>(null);
  const [cancellationTarget, setCancellationTarget] =
    useState<ReservationOrder | null>(null);
  const [reservations, setReservations] = useState<ReservationOrder[]>([]);
  const [loadingReservations, setLoadingReservations] = useState<boolean>(false);
  const hasLoadedReservationsRef = useRef<string | null>(null);
  const [newReservationModalVisible, setNewReservationModalVisible] =
    useState<boolean>(false);
  const [createdOrderTicket, setCreatedOrderTicket] = useState<any | null>(
    null
  );
  const [orderTicketModalOpen, setOrderTicketModalOpen] =
    useState<boolean>(false);

  // ============================================================================
  // MULTI-CAJA CON TTL DE 45_000 MS
  // ============================================================================
  useEffect(() => {
    branchSessionsGenerationRef.current += 1;
    lastBranchSessionsFetchRef.current = 0;
    lastBranchSessionsScopeRef.current = '';
    setBranchSessions({});
  }, [accountId]);

  const fetchBranchSessions = useCallback(
    async (options?: { force?: boolean }) => {
      if (
        !features.multiBranch ||
        (role !== 'owner' && role !== 'admin') ||
        !branches ||
        branches.length <= 1
      ) {
        return;
      }

      const scopeKey = `${accountId || ''}:${branchId || ''}:${
        isCashOpen ? 'open' : 'closed'
      }`;
      const now = Date.now();
      const scopeChanged = lastBranchSessionsScopeRef.current !== scopeKey;
      if (
        !options?.force &&
        !scopeChanged &&
        lastBranchSessionsFetchRef.current > 0 &&
        now - lastBranchSessionsFetchRef.current < BRANCH_SESSIONS_TTL_MS
      ) {
        return;
      }

      const requestGen = ++branchSessionsGenerationRef.current;
      lastBranchSessionsScopeRef.current = scopeKey;
      lastBranchSessionsFetchRef.current = now;
      setLoadingBranchSessions(true);
      try {
        const entries = await Promise.all(
          branches.map(async (b) => {
            const bId = b.id || 'main';
            const sess = await getActiveCashSession(bId, accountId || undefined);
            return [bId, sess] as const;
          })
        );
        if (branchSessionsGenerationRef.current === requestGen) {
          setBranchSessions(Object.fromEntries(entries));
        }
      } catch (err) {
        if (branchSessionsGenerationRef.current === requestGen) {
          lastBranchSessionsFetchRef.current = 0;
        }
        console.warn('[Operations] Error al obtener sesiones multicaja:', err);
      } finally {
        if (branchSessionsGenerationRef.current === requestGen) {
          setLoadingBranchSessions(false);
        }
      }
    },
    [features.multiBranch, branches, role, accountId, branchId, isCashOpen]
  );

  useEffect(() => {
    if (!features.multiBranch) {
      branchSessionsGenerationRef.current += 1;
      lastBranchSessionsFetchRef.current = 0;
      lastBranchSessionsScopeRef.current = '';
      setBranchSessions((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    }
  }, [features.multiBranch]);

  useEffect(() => {
    if (!features.aiAssistant && ventyModalVisible) setVentyModalVisible(false);
    if (!features.teamManagement && payrollModalOpen) setPayrollModalOpen(false);
    if (!features.advancedAnalytics && pnlModalOpen) setPnlModalOpen(false);
  }, [
    features.aiAssistant,
    ventyModalVisible,
    features.teamManagement,
    payrollModalOpen,
    features.advancedAnalytics,
    pnlModalOpen,
  ]);

  useEffect(() => {
    if (!features.multiBranch || !isFocused || activeTab !== 'cash') return;
    const task = InteractionManager.runAfterInteractions(() => {
      void fetchBranchSessions();
    });
    return () => task.cancel();
  }, [features.multiBranch, fetchBranchSessions, isFocused, activeTab]);

  const handleRefreshBranchSessions = useCallback(() => {
    void fetchBranchSessions({ force: true });
  }, [fetchBranchSessions]);

  const handleSwitchBranchCash = useCallback(
    (targetBranchId: string, branchName: string) => {
      setActiveBranchId(targetBranchId);
      refreshCashStatus();
      Alert.alert(
        'Caja Cambiada',
        `Ahora estás operando en la caja de "${branchName}".`
      );
    },
    [setActiveBranchId, refreshCashStatus]
  );

  // ============================================================================
  // EFECTO: MOVIMIENTOS Y VENTAS DEL TURNO EN VIVO (GRACE PERIOD 30S EN BLUR)
  // ============================================================================
  const currentSessionId =
    activeCashSession?.sessionId || activeCashSession?.id || null;

  const movementsUnsubRef = useRef<(() => void) | null>(null);
  const salesUnsubRef = useRef<(() => void) | null>(null);
  const cashListenersScopeRef = useRef<string | null>(null);
  const cashListenersBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cashListenersTaskRef = useRef<{ cancel?: () => void } | null>(null);

  const cleanupCashListeners = useCallback((resetData: boolean) => {
    if (cashListenersBlurTimerRef.current) {
      clearTimeout(cashListenersBlurTimerRef.current);
      cashListenersBlurTimerRef.current = null;
    }
    if (cashListenersTaskRef.current) {
      cashListenersTaskRef.current.cancel?.();
      cashListenersTaskRef.current = null;
    }
    if (typeof movementsUnsubRef.current === 'function') {
      movementsUnsubRef.current();
      movementsUnsubRef.current = null;
    }
    if (typeof salesUnsubRef.current === 'function') {
      salesUnsubRef.current();
      salesUnsubRef.current = null;
    }
    cashListenersScopeRef.current = null;

    if (resetData) {
      loadedMovementsSessionRef.current = null;
      setMovements([]);
      setLoadingMovements(false);
      loadedSalesSessionRef.current = null;
      setSessionSales([]);
      setLoadingSessionSales(false);
    }
  }, []);

  useEffect(() => {
    if (!isOnline) {
      setLoadingSessionSales(false);
      setLoadingMovements(false);
    }
  }, [isOnline]);

  useEffect(() => {
    if (!currentSessionId || !accountId || !isCashOpen) {
      cleanupCashListeners(true);
      return;
    }

    if (activeTab !== 'cash') {
      cleanupCashListeners(false);
      return;
    }

    const listenerScope = `${accountId}:${branchId || ''}:${currentSessionId}`;
    if (cashListenersScopeRef.current && cashListenersScopeRef.current !== listenerScope) {
      cleanupCashListeners(false);
    }

    if (!isFocused) {
      if (
        !cashListenersBlurTimerRef.current &&
        (movementsUnsubRef.current || salesUnsubRef.current || cashListenersTaskRef.current)
      ) {
        cashListenersBlurTimerRef.current = setTimeout(() => {
          cashListenersBlurTimerRef.current = null;
          cleanupCashListeners(false);
        }, CASH_LISTENER_BLUR_GRACE_MS);
      }
      return;
    }

    if (cashListenersBlurTimerRef.current) {
      clearTimeout(cashListenersBlurTimerRef.current);
      cashListenersBlurTimerRef.current = null;
    }

    if (
      cashListenersScopeRef.current === listenerScope &&
      (movementsUnsubRef.current || salesUnsubRef.current || cashListenersTaskRef.current)
    ) {
      return;
    }

    if (loadedMovementsSessionRef.current !== currentSessionId) {
      setMovements([]);
      setLoadingMovements(isOnlineRef.current);
    }
    if (loadedSalesSessionRef.current !== currentSessionId) {
      setSessionSales([]);
      setLoadingSessionSales(isOnlineRef.current);
    }

    cashListenersScopeRef.current = listenerScope;
    cashListenersTaskRef.current = InteractionManager.runAfterInteractions(() => {
      if (cashListenersScopeRef.current !== listenerScope) return;
      cashListenersTaskRef.current = null;

      movementsUnsubRef.current = subscribeToSessionMovements(
        currentSessionId,
        accountId,
        (movs) => {
          if (cashListenersScopeRef.current !== listenerScope) return;
          loadedMovementsSessionRef.current = currentSessionId;
          setMovements(movs);
          setLoadingMovements(false);
        }
      );

      const q = query(
        collection(db, 'sales'),
        where('accountId', '==', accountId),
        where('sessionId', '==', currentSessionId),
        limit(150)
      );

      salesUnsubRef.current = onSnapshot(
        q,
        (snapshot) => {
          if (cashListenersScopeRef.current !== listenerScope) return;
          const salesList = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
          salesList.sort((a: any, b: any) => {
            const tA = a.createdAt?.toMillis?.() || a.date || 0;
            const tB = b.createdAt?.toMillis?.() || b.date || 0;
            return tB - tA;
          });
          loadedSalesSessionRef.current = currentSessionId;
          setSessionSales(salesList);
          setLoadingSessionSales(false);
        },
        (err) => {
          if (cashListenersScopeRef.current !== listenerScope) return;
          console.warn('[Operations] Error cargando ventas del turno:', err);
          setLoadingSessionSales(false);
        }
      );
    });
  }, [
    currentSessionId,
    accountId,
    branchId,
    isCashOpen,
    isFocused,
    activeTab,
    cleanupCashListeners,
  ]);

  useEffect(() => {
    return () => {
      cleanupCashListeners(false);
    };
  }, [cleanupCashListeners]);

  // ============================================================================
  // MEMOS FOCUS-GATEADOS DE CAJA Y DESGLOSE DE PAGOS
  // ============================================================================
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

  const syncedMovementOfflineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const mov of movements) {
      if (mov?.id) ids.add(String(mov.id));
      if ((mov as any)?.offlineId) ids.add(String((mov as any).offlineId));
    }
    return ids;
  }, [movements]);

  const scopedOfflineCashMovements = useMemo(() => {
    if (!accountId || !user?.uid) return [];
    const effectiveBranch = branchId || 'main';
    return (pendingCashMovements || []).filter(
      (m) =>
        m.accountId === accountId &&
        m.userId === user.uid &&
        (!m.branchId || m.branchId === effectiveBranch) &&
        (!currentSessionId || m.sessionId === currentSessionId) &&
        !syncedMovementOfflineIds.has(m.offlineId)
    );
  }, [pendingCashMovements, accountId, user?.uid, branchId, currentSessionId, syncedMovementOfflineIds]);

  const offlineManualCashNet = useMemo(() => {
    let net = 0;
    for (const m of scopedOfflineCashMovements) {
      const amt = Math.abs(Number(m.amount) || 0);
      net += m.type === 'income' ? amt : -amt;
    }
    return Math.round(net * 100) / 100;
  }, [scopedOfflineCashMovements]);

  const mergedMovements = useMemo<CashMovement[]>(() => {
    if (scopedOfflineCashMovements.length === 0) return movements;
    const pendingRows: CashMovement[] = scopedOfflineCashMovements.map((m) => ({
      id: m.offlineId,
      sessionId: m.sessionId,
      accountId: m.accountId,
      branchId: m.branchId,
      type: m.type,
      amount: m.amount,
      category: m.category || (m.type === 'income' ? 'manual_income' : 'other'),
      expenseCategoryId: m.expenseCategoryId as any,
      receiptType: m.receiptType as any,
      receiptNumber: m.receiptNumber,
      description: m.description,
      reason: m.reason || m.description,
      createdBy: m.userId,
      createdByName: m.userName,
      createdAt: m.timestamp,
      isOfflinePending: true as any,
    }));
    return [...pendingRows, ...movements];
  }, [scopedOfflineCashMovements, movements]);

  const cashScopeKey = `${accountId || ''}:${branchId || ''}:${
    currentSessionId || ''
  }`;

  const mergedSessionSales = useFocusMemo<any[]>(
    () =>
      mergeSalesWithOfflinePending(
        sessionSales,
        pendingOfflineSales,
        offlineCashScope
      ),
    [cashScopeKey, sessionSales, pendingOfflineSales, offlineCashScope],
    isFocused,
    EMPTY_SESSION_SALES
  );

  const offlineCashDelta = useFocusMemo<OfflineCashBreakdownDelta>(
    () =>
      computeOfflineCashDelta(
        pendingOfflineSales,
        syncedOfflineIds,
        offlineCashScope
      ),
    [cashScopeKey, pendingOfflineSales, syncedOfflineIds, offlineCashScope],
    isFocused,
    EMPTY_OFFLINE_CASH_DELTA
  );

  const salesBreakdown = useFocusMemo<SalesBreakdown>(
    () => {
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
          if (
            sale.status === 'cancelled' ||
            sale.isDeposit ||
            sale.isReturn ||
            sale.type === 'deposit' ||
            sale.type === 'return'
          ) {
            continue;
          }
          const total = Number(sale.chargedAmount ?? sale.total ?? 0);
          const pMethod = (sale.paymentMethod || '').toLowerCase();

          if (Array.isArray(sale.payments) && sale.payments.length > 0) {
            for (const split of sale.payments) {
              const cat = (split.category || '').toLowerCase();
              const amt = Number(split.chargedAmount ?? split.amount ?? 0);
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
          total:
            sessionSales.length > 0
              ? mergedSessionSales.length
              : offlineCashDelta.counts.total,
        },
      };
    },
    [
      cashScopeKey,
      sessionSales.length,
      mergedSessionSales,
      activeCashSession,
      offlineCashDelta,
    ],
    isFocused,
    EMPTY_SALES_BREAKDOWN
  );

  const expectedCashAmount = useFocusMemo<number>(
    () =>
      Math.round(
        ((activeCashSession?.expectedAmount ?? 0) +
          offlineCashDelta.cash +
          offlineManualCashNet) *
          100
      ) / 100,
    [
      cashScopeKey,
      activeCashSession?.expectedAmount,
      offlineCashDelta.cash,
      offlineManualCashNet,
    ],
    isFocused,
    0
  );

  // ============================================================================
  // CARGA DE CLIENTES Y RESERVAS
  // ============================================================================
  const wasOpsOfflineRef = useRef(!isOnline);
  useEffect(() => {
    hasLoadedCustomersRef.current = null;
  }, [accountId]);

  useEffect(() => {
    hasLoadedReservationsRef.current = null;
  }, [accountId, branchId]);

  useEffect(() => {
    const cameBackOnline = wasOpsOfflineRef.current && isOnline;
    wasOpsOfflineRef.current = !isOnline;
    if (isOnline && (cameBackOnline || lastSyncSuccessAt)) {
      hasLoadedCustomersRef.current = null;
      hasLoadedReservationsRef.current = null;
    }
  }, [isOnline, lastSyncSuccessAt]);

  const loadCustomersData = useCallback(async () => {
    if (!accountId) return;
    setLoadingCustomers(true);
    try {
      const data = await getCustomers(accountId);
      setCustomers(data);
      if (isOnlineRef.current) {
        hasLoadedCustomersRef.current = accountId;
      }
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
  }, [isFocused, activeTab, accountId, isOnline, lastSyncSuccessAt, loadCustomersData]);

  const loadReservationsData = useCallback(async () => {
    if (!accountId || !branchId) return;
    if (!isOnlineRef.current) {
      setLoadingReservations(false);
      return;
    }
    const scopeKey = `${accountId}:${branchId}`;
    setLoadingReservations(true);
    try {
      const data = await getReservationsAndOrders(accountId, branchId);
      setReservations(data);
      if (isOnlineRef.current) {
        hasLoadedReservationsRef.current = scopeKey;
      }
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
  }, [isFocused, activeTab, accountId, branchId, isOnline, lastSyncSuccessAt, loadReservationsData]);

  // ============================================================================
  // DETALLE CLIENTE (EVITA DOBLE ESCANEO DE `reservations` PASANDO knownFiadoIds)
  // ============================================================================
  const loadCustomerDetailData = useCallback(
    async (cust: CustomerData) => {
      if (!accountId || !cust.id) return;
      setLoadingCustomerDetail(true);
      try {
        const [fiados, custSnap] = await Promise.all([
          getCustomerOpenFiados(accountId, cust.id),
          getDoc(doc(db, 'customers', cust.id)),
        ]);
        const history = await getCustomerFiadoHistory(accountId, cust.id, {
          knownFiadoIds: fiados.map((f) => f.id),
        });
        setDetailOpenFiados(fiados);
        setDetailFiadoHistory(history);
        if (custSnap.exists()) {
          const refreshed: CustomerData = {
            id: custSnap.id,
            ...(custSnap.data() as any),
          };
          setDetailCustomer(refreshed);
          setCustomers((prev) =>
            prev.map((c) => (c.id === refreshed.id ? refreshed : c))
          );
        }
      } catch (err: any) {
        Alert.alert(
          'Error',
          err?.message || 'No se pudieron cargar los detalles del cliente.'
        );
      } finally {
        setLoadingCustomerDetail(false);
      }
    },
    [accountId]
  );

  // ============================================================================
  // CALLBACKS ESTABILIZADOS PARA SUBCOMPONENTES Y MODALES
  // ============================================================================
  const handleOpenVentyModal = useCallback(() => {
    if (!features.aiAssistant) {
      setUpgradeFeature('aiAssistant');
      return;
    }
    setVentyModalVisible(true);
  }, [features.aiAssistant]);
  const handleCloseVentyModal = useCallback(() => setVentyModalVisible(false), []);
  const handleOpenPnlModal = useCallback(() => {
    if (!features.advancedAnalytics) {
      setUpgradeFeature('advancedAnalytics');
      return;
    }
    setPnlModalOpen(true);
  }, [features.advancedAnalytics]);
  const handleClosePnlModal = useCallback(() => setPnlModalOpen(false), []);
  const handleOpenPayrollModal = useCallback(() => {
    if (!features.teamManagement) return;
    setPayrollModalOpen(true);
  }, [features.teamManagement]);
  const handleClosePayrollModal = useCallback(() => setPayrollModalOpen(false), []);
  const handleCloseUpgradeModal = useCallback(() => setUpgradeFeature(null), []);
  const handleLoadSaleRequestToPos = useCallback(
    () => router.replace('/(tabs)'),
    [router]
  );

  const handleCashOpened = useCallback(() => {
    refreshCashStatus();
    void fetchBranchSessions({ force: true });
  }, [refreshCashStatus, fetchBranchSessions]);

  const handleOpenIncomeModal = useCallback(() => {
    setMovementModalState({ visible: true, initialType: 'income' });
  }, []);

  const handleOpenExpenseModal = useCallback(() => {
    setMovementModalState({ visible: true, initialType: 'expense' });
  }, []);

  const handleCloseMovementModal = useCallback(() => {
    setMovementModalState((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleMovementSuccess = useCallback(() => {
    refreshCashStatus();
  }, [refreshCashStatus]);

  const handleOpenCloseModal = useCallback(() => {
    setCloseModalVisible(true);
  }, []);

  const handleCloseCloseModal = useCallback(() => {
    setCloseModalVisible(false);
  }, []);

  const handleCashClosed = useCallback(
    (result: any) => {
      setCloseModalVisible(false);
      setClosureReport(result);
      refreshCashStatus();
      void fetchBranchSessions({ force: true });
    },
    [refreshCashStatus, fetchBranchSessions]
  );

  const handleCloseClosureSuccessModal = useCallback(() => {
    setClosureReport(null);
  }, []);

  const handleOpenNewCustomerModal = useCallback(() => {
    setNewCustomerModalVisible(true);
  }, []);

  const handleCloseNewCustomerModal = useCallback(() => {
    setNewCustomerModalVisible(false);
  }, []);

  const handleCustomerSaved = useCallback(() => {
    void loadCustomersData();
  }, [loadCustomersData]);

  const handleCollectDebt = useCallback((cust: CustomerData) => {
    setPaymentModalState({
      visible: true,
      customer: cust,
    });
  }, []);

  const handlePaySpecificFiado = useCallback(
    (customer: CustomerData, fiado: OpenFiado) => {
      setPaymentModalState({
        visible: true,
        customer,
        initialOpenFiados: detailOpenFiados,
        initialSelectedFiado: fiado,
      });
    },
    [detailOpenFiados]
  );

  const handleClosePaymentModal = useCallback(() => {
    setPaymentModalState({ visible: false, customer: null });
  }, []);

  const handlePaymentSuccess = useCallback(
    (paidCustId?: string) => {
      if (
        customerDetailModalVisible &&
        detailCustomer?.id &&
        detailCustomer.id === paidCustId
      ) {
        void loadCustomerDetailData(detailCustomer);
      } else {
        void loadCustomersData();
      }
      refreshCashStatus();
    },
    [
      customerDetailModalVisible,
      detailCustomer,
      loadCustomerDetailData,
      loadCustomersData,
      refreshCashStatus,
    ]
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

  const handleCloseCustomerDetail = useCallback(() => {
    setCustomerDetailModalVisible(false);
  }, []);

  const handleRecalculateDebt = useCallback(async () => {
    if (!accountId || !detailCustomer?.id) return;
    setIsRecalculatingDebt(true);
    try {
      const res = await recalculateCustomerDebt(accountId, detailCustomer.id);
      const before = Number(
        (res as any).before ??
          res.previousDebt ??
          detailCustomer.currentDebt ??
          0
      );
      const after = Number(
        (res as any).after ?? res.recalculatedDebt ?? before
      );
      const corrected =
        typeof (res as any).corrected === 'boolean'
          ? (res as any).corrected
          : before !== after;

      setDetailCustomer((prev) =>
        prev ? { ...prev, currentDebt: after } : prev
      );
      setCustomers((prev) =>
        prev.map((c) =>
          c.id === detailCustomer.id ? { ...c, currentDebt: after } : c
        )
      );
      await loadCustomerDetailData({ ...detailCustomer, currentDebt: after });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {}
      );
      Alert.alert(
        corrected ? 'Deuda Recalculada y Corregida' : 'Deuda Verificada',
        `Saldo anterior: ${formatPEN(before)}\nSaldo actual: ${formatPEN(
          after
        )}`
      );
    } catch (err: any) {
      Alert.alert(
        'No se pudo recalcular',
        err?.message || 'Error al recalcular la deuda del cliente.'
      );
    } finally {
      setIsRecalculatingDebt(false);
    }
  }, [accountId, detailCustomer, loadCustomerDetailData]);

  const handleOpenReturnFiado = useCallback((fiado: OpenFiado) => {
    setReturnFiadoTarget(fiado);
  }, []);

  const handleCloseReturnFiado = useCallback(() => {
    setReturnFiadoTarget(null);
  }, []);

  const handleReturnFiadoSuccess = useCallback(() => {
    if (detailCustomer) {
      void loadCustomerDetailData(detailCustomer);
    } else {
      void loadCustomersData();
    }
  }, [detailCustomer, loadCustomerDetailData, loadCustomersData]);

  const handleOpenWriteOff = useCallback((fiado: OpenFiado) => {
    setWriteOffTarget(fiado);
  }, []);

  const handleCloseWriteOff = useCallback(() => {
    setWriteOffTarget(null);
  }, []);

  const handleWriteOffSuccess = useCallback(() => {
    if (detailCustomer) {
      void loadCustomerDetailData(detailCustomer);
    } else {
      void loadCustomersData();
    }
  }, [detailCustomer, loadCustomerDetailData, loadCustomersData]);

  const handleOpenNewReservationModal = useCallback(() => {
    setNewReservationModalVisible(true);
  }, []);

  const handleCloseNewReservationModal = useCallback(() => {
    setNewReservationModalVisible(false);
  }, []);

  const handleReservationCreated = useCallback(
    (newResObj: any) => {
      setCreatedOrderTicket(newResObj);
      setNewReservationModalVisible(false);
      void loadReservationsData();
      refreshCashStatus();
      setOrderTicketModalOpen(true);
    },
    [loadReservationsData, refreshCashStatus]
  );

  const handleViewReservationTicket = useCallback((item: ReservationOrder) => {
    setCreatedOrderTicket(item);
    setOrderTicketModalOpen(true);
  }, []);

  const handleCloseOrderTicketModal = useCallback(() => {
    setOrderTicketModalOpen(false);
  }, []);

  const handleCancelReservationCard = useCallback((item: ReservationOrder) => {
    setCancellationTarget(item);
  }, []);

  const handleDeliverReservationCard = useCallback((item: ReservationOrder) => {
    setCompletionTarget(item);
  }, []);

  const handleCloseCancellationModal = useCallback(() => {
    setCancellationTarget(null);
  }, []);

  const handleCloseCompletionModal = useCallback(() => {
    setCompletionTarget(null);
  }, []);

  const handleCompletionCompleted = useCallback(
    (item: ReservationOrder) => {
      setCompletionTarget(null);
      void loadReservationsData();
      refreshCashStatus();
      setCreatedOrderTicket({
        ...item,
        status: 'completed',
        depositAmount: item.total,
        remainingAmount: 0,
      });
      setOrderTicketModalOpen(true);
    },
    [loadReservationsData, refreshCashStatus]
  );

  const confirmReservationCancellation = useCallback(
    async (refund: { refundMethod?: string; refundPercent?: number }) => {
      if (!cancellationTarget || !user) return;
      try {
        await completeOrCancelReservation(
          cancellationTarget,
          'cancel',
          {
            uid: user.uid,
            displayName: userProfile?.displayName || user.email || 'Operador',
            email: user.email,
            role,
          },
          {
            sessionId: currentSessionId || undefined,
            ...refund,
          }
        );
        setCancellationTarget(null);
        void loadReservationsData();
        void refreshCashStatus();
      } catch (err) {
        Alert.alert(
          'No se pudo cancelar',
          err instanceof Error
            ? err.message
            : 'Actualiza los datos y vuelve a intentarlo.'
        );
      }
    },
    [
      cancellationTarget,
      user,
      userProfile?.displayName,
      role,
      currentSessionId,
      loadReservationsData,
      refreshCashStatus,
    ]
  );

  const handleApproveOrder = useCallback(
    (item: ReservationOrder) => {
      Alert.alert(
        '¿Aprobar pedido?',
        'Se reservará el stock de catálogo para iniciar su preparación.',
        [
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
                Alert.alert(
                  'No se pudo aprobar',
                  error?.message || 'Revisa el stock e inténtalo nuevamente.'
                );
              }
            },
          },
        ]
      );
    },
    [loadReservationsData]
  );

  const handleSyncNow = useCallback(
    () => triggerManualSync(true),
    [triggerManualSync]
  );

  const bottomInsetPadding = insets.bottom + 80;
  const listContentContainerStyle = useMemo(
    () => ({
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: bottomInsetPadding,
    }),
    [bottomInsetPadding]
  );

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <View style={styles.screen}>
      <View style={styles.compactHeaderRow}>
        <Text style={styles.compactHeaderTitle}>
          {activeTab === 'cash'
            ? 'Caja'
            : activeTab === 'crm'
            ? 'Clientes'
            : 'Pedidos'}
        </Text>
        <View style={styles.compactHeaderActions}>
          <TouchableOpacity
            style={styles.compactTeamButton}
            onPress={handleOpenVentyModal}
            accessibilityRole="button"
            accessibilityLabel={
              features.aiAssistant
                ? 'Abrir asistente Venty IA'
                : 'Asistente Venty IA (requiere mejora de plan)'
            }
          >
            <Image
              source={VENTY_ICON}
              style={styles.ventyBtnIcon}
              contentFit="contain"
            />
            <Text style={styles.compactTeamButtonText}>Venty IA</Text>
            {!features.aiAssistant && <Lock size={12} color={ui.accent} />}
          </TouchableOpacity>
          {(canViewMargins || canViewReports) ? (
            <TouchableOpacity
              style={styles.compactTeamButton}
              onPress={handleOpenPnlModal}
              accessibilityRole="button"
              accessibilityLabel={
                features.advancedAnalytics
                  ? 'Abrir reporte de ganancias y resultados'
                  : 'Reporte de ganancias (requiere mejora de plan)'
              }
            >
              <BarChart3 size={16} color={ui.primary} />
              <Text style={styles.compactTeamButtonText}>Ganancias</Text>
              {!features.advancedAnalytics && <Lock size={12} color={ui.accent} />}
            </TouchableOpacity>
          ) : null}
          {canManageUsers && features.teamManagement ? (
            <TouchableOpacity
              style={styles.compactTeamButton}
              onPress={handleOpenPayrollModal}
              accessibilityRole="button"
              accessibilityLabel="Abrir equipo y planilla"
            >
              <UserCheck size={16} color={ui.primary} />
              <Text style={styles.compactTeamButtonText}>Equipo</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={styles.centeredTabsContainer}>
        <TouchableOpacity
          style={[
            styles.centeredTabButton,
            activeTab === 'cash' && styles.centeredTabButtonActive,
          ]}
          onPress={() => setActiveTab('cash')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'cash' }}
          accessibilityLabel="Caja"
        >
          <Wallet
            size={17}
            color={activeTab === 'cash' ? ui.primary : ui.textSecondary}
          />
          <Text
            style={[
              styles.centeredTabText,
              activeTab === 'cash' && styles.centeredTabTextActive,
            ]}
          >
            Caja
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.centeredTabButton,
            activeTab === 'crm' && styles.centeredTabButtonActive,
          ]}
          onPress={() => setActiveTab('crm')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'crm' }}
          accessibilityLabel="Clientes"
        >
          <Users
            size={17}
            color={activeTab === 'crm' ? ui.primary : ui.textSecondary}
          />
          <Text
            style={[
              styles.centeredTabText,
              activeTab === 'crm' && styles.centeredTabTextActive,
            ]}
          >
            Clientes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.centeredTabButton,
            activeTab === 'orders' && styles.centeredTabButtonActive,
          ]}
          onPress={() => setActiveTab('orders')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'orders' }}
          accessibilityLabel="Pedidos"
        >
          <CalendarClock
            size={17}
            color={activeTab === 'orders' ? ui.primary : ui.textSecondary}
          />
          <Text
            style={[
              styles.centeredTabText,
              activeTab === 'orders' && styles.centeredTabTextActive,
            ]}
          >
            Pedidos
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'cash' && (
        <CashTabView
          isFocused={isFocused}
          isCashOpen={isCashOpen}
          accountId={accountId}
          branchId={branchId}
          role={role}
          user={user}
          userProfile={userProfile}
          activeBranch={activeBranch}
          branches={branches}
          activeCashSession={activeCashSession}
          movements={mergedMovements}
          loadingMovements={loadingMovements}
          sessionSalesLength={sessionSales.length}
          mergedSessionSales={mergedSessionSales}
          loadingSessionSales={loadingSessionSales}
          offlineCashDelta={offlineCashDelta}
          salesBreakdown={salesBreakdown}
          expectedCashAmount={expectedCashAmount}
          branchSessions={branchSessions}
          loadingBranchSessions={loadingBranchSessions}
          listContentContainerStyle={listContentContainerStyle}
          bottomInsetPadding={bottomInsetPadding}
          onCashOpened={handleCashOpened}
          onRefreshBranchSessions={handleRefreshBranchSessions}
          onSwitchBranchCash={handleSwitchBranchCash}
          onOpenIncomeModal={handleOpenIncomeModal}
          onOpenExpenseModal={handleOpenExpenseModal}
          onOpenCloseModal={handleOpenCloseModal}
        />
      )}

      {activeTab === 'crm' && (
        <CrmTabView
          customers={customers}
          loadingCustomers={loadingCustomers}
          listContentContainerStyle={listContentContainerStyle}
          onOpenNewCustomer={handleOpenNewCustomerModal}
          onCollectDebt={handleCollectDebt}
          onOpenDetail={handleOpenCustomerDetail}
        />
      )}

      {activeTab === 'orders' && (
        <OrdersTabView
          reservations={reservations}
          loadingReservations={loadingReservations}
          listContentContainerStyle={listContentContainerStyle}
          onOpenNewReservation={handleOpenNewReservationModal}
          onViewTicket={handleViewReservationTicket}
          onCancel={handleCancelReservationCard}
          onApprove={handleApproveOrder}
          onDeliver={handleDeliverReservationCard}
        />
      )}

      {movementModalState.visible && (
        <CashMovementModal
          visible={movementModalState.visible}
          initialType={movementModalState.initialType}
          onClose={handleCloseMovementModal}
          accountId={accountId}
          branchId={branchId}
          activeCashSession={activeCashSession}
          user={user}
          userProfile={userProfile}
          role={role}
          isCashier={isCashier}
          onSuccess={handleMovementSuccess}
        />
      )}

      {Boolean(completionTarget) && (
        <ReservationCompletionModal
          item={completionTarget}
          onClose={handleCloseCompletionModal}
          onCompleted={handleCompletionCompleted}
        />
      )}

      {Boolean(cancellationTarget) && (
        <ReservationCancellationModal
          visible={Boolean(cancellationTarget)}
          item={cancellationTarget}
          sessionId={currentSessionId || undefined}
          onClose={handleCloseCancellationModal}
          onConfirm={confirmReservationCancellation}
        />
      )}

      {closeModalVisible && (
        <CloseCashModal
          visible={closeModalVisible}
          onClose={handleCloseCloseModal}
          accountId={accountId}
          branchId={branchId}
          activeCashSession={activeCashSession}
          expectedCashAmount={expectedCashAmount}
          offlinePendingCount={offlineCashDelta.count + scopedOfflineCashMovements.length}
          quarantinedCount={quarantinedCount}
          isOnline={isOnline}
          isSupervisor={isSupervisor}
          user={user}
          userProfile={userProfile}
          onSyncNow={handleSyncNow}
          onSyncedOffline={refreshCashStatus}
          onClosed={handleCashClosed}
        />
      )}

      {Boolean(closureReport) && (
        <ClosureSuccessModal
          report={closureReport}
          activeCashSession={activeCashSession}
          businessSettings={businessSettings}
          activeBranch={activeBranch}
          user={user}
          userProfile={userProfile}
          onClose={handleCloseClosureSuccessModal}
        />
      )}

      {newCustomerModalVisible && (
        <CustomerFormModal
          visible={newCustomerModalVisible}
          accountId={accountId}
          onClose={handleCloseNewCustomerModal}
          onSaved={handleCustomerSaved}
        />
      )}

      {paymentModalState.visible && (
        <FiadoPaymentModal
          visible={paymentModalState.visible}
          customer={paymentModalState.customer}
          initialOpenFiados={paymentModalState.initialOpenFiados}
          initialSelectedFiado={paymentModalState.initialSelectedFiado}
          accountId={accountId}
          branchId={branchId}
          activeCashSession={activeCashSession}
          user={user}
          userProfile={userProfile}
          role={role}
          onClose={handleClosePaymentModal}
          onPaymentSuccess={handlePaymentSuccess}
        />
      )}

      {newReservationModalVisible && (
        <NewReservationModal
          visible={newReservationModalVisible}
          onClose={handleCloseNewReservationModal}
          accountId={accountId}
          branchId={branchId}
          activeCashSession={activeCashSession}
          user={user}
          userProfile={userProfile}
          role={role}
          onCreated={handleReservationCreated}
        />
      )}

      {customerDetailModalVisible && (
        <CustomerDetailModal
          visible={
            customerDetailModalVisible &&
            !returnFiadoTarget &&
            !writeOffTarget &&
            !paymentModalState.visible
          }
          customer={detailCustomer}
          openFiados={detailOpenFiados}
          fiadoHistory={detailFiadoHistory}
          loading={loadingCustomerDetail}
          isRecalculatingDebt={isRecalculatingDebt}
          isSupervisor={isSupervisor}
          canManageCustomers={canManageCustomers}
          canProcessReturn={canProcessReturn}
          isCashier={isCashier}
          role={role}
          onClose={handleCloseCustomerDetail}
          onCollectDebt={handleCollectDebt}
          onRecalculateDebt={handleRecalculateDebt}
          onPayFiado={handlePaySpecificFiado}
          onOpenReturnFiado={handleOpenReturnFiado}
          onOpenWriteOff={handleOpenWriteOff}
        />
      )}

      {Boolean(returnFiadoTarget) && (
        <FiadoReturnModal
          fiado={returnFiadoTarget}
          accountId={accountId}
          user={user}
          userProfile={userProfile}
          role={role}
          onClose={handleCloseReturnFiado}
          onSuccess={handleReturnFiadoSuccess}
        />
      )}

      {Boolean(writeOffTarget) && (
        <FiadoWriteOffModal
          fiado={writeOffTarget}
          accountId={accountId}
          user={user}
          userProfile={userProfile}
          role={role}
          onClose={handleCloseWriteOff}
          onSuccess={handleWriteOffSuccess}
        />
      )}

      {features.aiAssistant && ventyModalVisible && (
        <VentyAiModal
          visible={ventyModalVisible}
          onClose={handleCloseVentyModal}
          accountId={accountId}
          branchId={branchId}
          isOnline={isOnline}
        />
      )}

      {features.teamManagement && payrollModalOpen && (
        <PayrollUsersModal
          visible={payrollModalOpen}
          onClose={handleClosePayrollModal}
          onLoadSaleRequestToPos={handleLoadSaleRequestToPos}
        />
      )}

      {features.advancedAnalytics && pnlModalOpen && (
        <FinancialPnlModal
          visible={pnlModalOpen}
          onClose={handleClosePnlModal}
        />
      )}

      <PlanUpgradeModal
        visible={upgradeFeature !== null}
        feature={upgradeFeature}
        currentPlanName={planName}
        onClose={handleCloseUpgradeModal}
      />

      {orderTicketModalOpen && (
        <ReservationReceiptModal
          visible={orderTicketModalOpen}
          onClose={handleCloseOrderTicketModal}
          reservation={createdOrderTicket}
          business={businessSettings}
        />
      )}
    </View>
  );
}
