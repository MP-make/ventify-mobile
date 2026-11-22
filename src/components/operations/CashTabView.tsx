import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { FlashList, type ContentStyle } from '@shopify/flash-list';
import { Image } from 'expo-image';
import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  ChevronRight,
  Coins,
  FileText,
  Receipt,
  RefreshCw,
  Wallet,
} from 'lucide-react-native';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import {
  expenseCategoryLabel,
  type CashMovement,
  type CashSession,
} from '@/services/cash-register-service';
import type { OfflineCashBreakdownDelta } from '@/lib/offline-sales-helpers';
import type { Branch } from '@/types';
import { OpenCashCard } from './OpenCashCard';
import { operationsStyles as styles } from './operationsStyles';
import type {
  OperationsUserProfileRef,
  OperationsUserRef,
  SalesBreakdown,
} from './types';

const YAPE_LOGO = require('../../../assets/payment/yape.jpeg');
const PLIN_LOGO = require('../../../assets/payment/plin.png');
const MASTERCARD_LOGO = require('../../../assets/payment/mastercard.webp');

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
        <Text style={styles.movementTitle}>
          {movement.reason || movement.description || 'Movimiento de caja'}
        </Text>
        <Text style={styles.movementSub}>
          {formatDatePE(movement.createdAt)} • {catLabel} • {movement.createdByName || 'Operador'}
          {hasReceipt
            ? ` • ${String(movement.receiptType).toUpperCase()}${
                movement.receiptNumber ? ` ${movement.receiptNumber}` : ''
              }`
            : ''}
        </Text>
      </View>
      <Text
        style={[
          styles.movementAmount,
          { color: isIncome ? ui.success : ui.danger },
        ]}
      >
        {isIncome ? '+' : '-'}
        {formatPEN(Math.abs(numericAmt))}
      </Text>
    </View>
  );
});

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

export interface CashTabViewProps {
  isFocused: boolean;
  isCashOpen: boolean;
  accountId?: string | null;
  branchId?: string | null;
  role?: string | null;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  activeBranch: Branch | null;
  branches: Branch[];
  activeCashSession: any;
  movements: CashMovement[];
  loadingMovements: boolean;
  sessionSalesLength: number;
  mergedSessionSales: any[];
  loadingSessionSales: boolean;
  offlineCashDelta: OfflineCashBreakdownDelta;
  salesBreakdown: SalesBreakdown;
  expectedCashAmount: number;
  branchSessions: Record<string, CashSession | null>;
  loadingBranchSessions: boolean;
  listContentContainerStyle: ContentStyle;
  bottomInsetPadding: number;
  onCashOpened: () => void;
  onRefreshBranchSessions: () => void;
  onSwitchBranchCash: (targetBranchId: string, branchName: string) => void;
  onOpenIncomeModal: () => void;
  onOpenExpenseModal: () => void;
  onOpenCloseModal: () => void;
}

export const CashTabView = React.memo<CashTabViewProps>(({
  isFocused,
  isCashOpen,
  accountId,
  branchId,
  role,
  user,
  userProfile,
  activeBranch,
  branches,
  activeCashSession,
  movements,
  loadingMovements,
  sessionSalesLength,
  mergedSessionSales,
  loadingSessionSales,
  offlineCashDelta,
  salesBreakdown,
  expectedCashAmount,
  branchSessions,
  loadingBranchSessions,
  listContentContainerStyle,
  bottomInsetPadding,
  onCashOpened,
  onRefreshBranchSessions,
  onSwitchBranchCash,
  onOpenIncomeModal,
  onOpenExpenseModal,
  onOpenCloseModal,
}) => {
  const { width } = useWindowDimensions();
  const isCompactWidth = width < 360;
  const [cashSubView, setCashSubView] = useState<'movements' | 'sales'>('movements');

  const lastCashListDataRef = useRef<any[] | null>(null);
  const cashListData = useMemo(() => {
    if (!isFocused && lastCashListDataRef.current !== null) {
      return lastCashListDataRef.current;
    }
    const next = cashSubView === 'movements' ? movements : mergedSessionSales;
    lastCashListDataRef.current = next;
    return next;
  }, [isFocused, cashSubView, movements, mergedSessionSales]);

  const movementKeyExtractor = useCallback(
    (item: CashMovement, index: number) => item.id || `mov_${index}`,
    []
  );
  const sessionSaleKeyExtractor = useCallback(
    (item: any, index: number) => item.id || item.offlineId || `sale_${index}`,
    []
  );

  const cashKeyExtractor = useCallback(
    (item: any, index: number) =>
      cashSubView === 'movements'
        ? movementKeyExtractor(item, index)
        : sessionSaleKeyExtractor(item, index),
    [cashSubView, movementKeyExtractor, sessionSaleKeyExtractor]
  );

  const getCashItemType = useCallback(() => cashSubView, [cashSubView]);

  const renderCashItem = useCallback(
    ({ item }: { item: any }) => (
      <View style={styles.cashVirtualRowWrap}>
        {cashSubView === 'movements' ? (
          <CashMovementRow movement={item} />
        ) : (
          <SessionSaleRow sale={item} />
        )}
      </View>
    ),
    [cashSubView]
  );

  const hasMultiBranchAccess = (role === 'owner' || role === 'admin') && branches.length > 1;
  const hasBranchSessionEntries = Object.keys(branchSessions).length > 0;

  const multiCashSectionElement = useMemo(() => {
    if (!hasMultiBranchAccess) return null;
    return (
      <View style={styles.card}>
        <View style={styles.multiCashHeader}>
          <View style={[styles.iconBadge, styles.iconBadgePrimary]}>
            <Building2 size={20} color={ui.primary} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.cardTitle}>Monitoreo Multi-caja</Text>
            <Text style={styles.cardSubtitle}>
              Supervisión y control de sucursales en tiempo real
            </Text>
          </View>
          <TouchableOpacity
            onPress={onRefreshBranchSessions}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Recargar estado de sucursales"
          >
            <RefreshCw size={16} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {loadingBranchSessions && !hasBranchSessionEntries ? (
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
                        <Text
                          style={[
                            styles.branchMetricValue,
                            { color: ui.primary, fontWeight: '700' },
                          ]}
                        >
                          {formatPEN(session.expectedAmount || 0)}
                        </Text>
                      </View>
                    </View>
                  ) : null}

                  {!isCurrent ? (
                    <TouchableOpacity
                      style={styles.switchBranchBtn}
                      onPress={() => onSwitchBranchCash(bId, b.name || 'Sucursal')}
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
  }, [
    hasMultiBranchAccess,
    hasBranchSessionEntries,
    onRefreshBranchSessions,
    loadingBranchSessions,
    branches,
    branchId,
    branchSessions,
    onSwitchBranchCash,
  ]);

  const cashHeaderElement = useMemo(() => (
    <View style={styles.moduleWrapper}>
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, styles.iconBadgePrimary]}>
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
          <Text
            style={isCompactWidth ? styles.mainKpiValueCompact : styles.mainKpiValue}
            numberOfLines={1}
          >
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
              {formatPEN(
                activeCashSession?.initialAmount || activeCashSession?.openingBalance || 0
              )}
            </Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Ventas Efectivo</Text>
            <Text style={[styles.statValue, { color: ui.success }]}>
              +
              {formatPEN(
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
              {sessionSalesLength > 0
                ? mergedSessionSales.length
                : (activeCashSession?.transactionCount ?? movements.length) +
                  offlineCashDelta.count}
            </Text>
          </View>
        </View>

        <View style={styles.paymentBreakdownCard}>
          <View style={styles.paymentBreakdownHeader}>
            <View style={styles.paymentBreakdownTitleWrap}>
              <Coins size={18} color={ui.primary} />
              <Text style={styles.paymentBreakdownTitle} numberOfLines={1}>
                Desglose por Método de Pago
              </Text>
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
              <Text style={[styles.methodAmount, { color: '#16A34A' }]}>
                {formatPEN(salesBreakdown.cash)}
              </Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(
                  salesBreakdown.counts.cash,
                  salesBreakdown.cash,
                  salesBreakdown.usingSessionFallback
                )}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <Image source={YAPE_LOGO} style={styles.methodLogoImg} contentFit="cover" />
                <Text style={styles.methodName}>Yape</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#7E22CE' }]}>
                {formatPEN(salesBreakdown.yape)}
              </Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(
                  salesBreakdown.counts.yape,
                  salesBreakdown.yape,
                  salesBreakdown.usingSessionFallback
                )}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <Image source={PLIN_LOGO} style={styles.methodLogoImg} contentFit="cover" />
                <Text style={styles.methodName}>Plin</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#0284C7' }]}>
                {formatPEN(salesBreakdown.plin)}
              </Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(
                  salesBreakdown.counts.plin,
                  salesBreakdown.plin,
                  salesBreakdown.usingSessionFallback
                )}
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
              <Text style={[styles.methodAmount, { color: '#2563EB' }]}>
                {formatPEN(salesBreakdown.card)}
              </Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(
                  salesBreakdown.counts.card,
                  salesBreakdown.card,
                  salesBreakdown.usingSessionFallback
                )}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <View style={[styles.methodIconBadge, { backgroundColor: '#EEF2FF' }]}>
                  <Building2 size={13} color="#4F46E5" />
                </View>
                <Text style={styles.methodName}>Transferencia</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#4F46E5' }]}>
                {formatPEN(salesBreakdown.transfer)}
              </Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(
                  salesBreakdown.counts.transfer,
                  salesBreakdown.transfer,
                  salesBreakdown.usingSessionFallback
                )}
              </Text>
            </View>

            <View style={styles.methodBox}>
              <View style={styles.methodHeader}>
                <View style={[styles.methodIconBadge, { backgroundColor: '#FFEDD5' }]}>
                  <FileText size={13} color="#EA580C" />
                </View>
                <Text style={styles.methodName}>Fiado / Crédito</Text>
              </View>
              <Text style={[styles.methodAmount, { color: '#EA580C' }]}>
                {formatPEN(salesBreakdown.credit)}
              </Text>
              <Text style={styles.methodCount}>
                {formatMethodCountLabel(
                  salesBreakdown.counts.credit,
                  salesBreakdown.credit,
                  salesBreakdown.usingSessionFallback
                )}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.actionButtonGroup}>
          <TouchableOpacity
            style={[styles.outlineActionButton, { borderColor: ui.primary }]}
            onPress={onOpenIncomeModal}
          >
            <ArrowUpRight size={18} color={ui.success} />
            <Text style={[styles.outlineActionText, { color: ui.success }]}>
              + Ingreso Manual
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.outlineActionButton, { borderColor: ui.danger }]}
            onPress={onOpenExpenseModal}
          >
            <ArrowDownRight size={18} color={ui.danger} />
            <Text style={[styles.outlineActionText, { color: ui.danger }]}>
              - Registrar Gasto
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.closeZButton} onPress={onOpenCloseModal}>
          <Receipt size={20} color={ui.onPrimary} />
          <Text style={styles.closeZButtonText}>Arqueo y Cierre Z del Turno</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.cashListHeaderCard}>
        <View style={styles.cashSubTabSelector}>
          <TouchableOpacity
            style={[
              styles.cashSubTabBtn,
              cashSubView === 'movements' && styles.cashSubTabBtnActive,
            ]}
            onPress={() => setCashSubView('movements')}
          >
            <Receipt
              size={16}
              color={cashSubView === 'movements' ? ui.primary : ui.textSecondary}
            />
            <Text
              style={[
                styles.cashSubTabText,
                cashSubView === 'movements' && styles.cashSubTabTextActive,
              ]}
            >
              Movimientos ({movements.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.cashSubTabBtn,
              cashSubView === 'sales' && styles.cashSubTabBtnActive,
            ]}
            onPress={() => setCashSubView('sales')}
          >
            <Coins size={16} color={cashSubView === 'sales' ? ui.primary : ui.textSecondary} />
            <Text
              style={[
                styles.cashSubTabText,
                cashSubView === 'sales' && styles.cashSubTabTextActive,
              ]}
            >
              Ventas del Turno ({mergedSessionSales.length})
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  ), [
    activeCashSession,
    userProfile?.displayName,
    isCompactWidth,
    expectedCashAmount,
    salesBreakdown,
    offlineCashDelta.cash,
    offlineCashDelta.totalDigital,
    offlineCashDelta.count,
    sessionSalesLength,
    mergedSessionSales.length,
    movements.length,
    onOpenIncomeModal,
    onOpenExpenseModal,
    onOpenCloseModal,
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

  if (!isCashOpen) {
    return (
      <ScrollView
        style={styles.contentContainer}
        contentContainerStyle={{ paddingBottom: bottomInsetPadding }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.moduleWrapper}>
          <OpenCashCard
            accountId={accountId}
            branchId={branchId}
            branchName={activeBranch?.name || 'Tienda Principal'}
            user={user}
            userProfile={userProfile}
            onOpened={onCashOpened}
          />
          {multiCashSectionElement}
        </View>
      </ScrollView>
    );
  }

  return (
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
  );
});
