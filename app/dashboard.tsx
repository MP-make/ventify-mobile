import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Award,
  BarChart3,
  ChevronRight,
  CreditCard,
  Package,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { formatPEN, ui } from '@/lib/theme';
import {
  calculateVariationPercent,
  type DashboardOperationalSummary,
  type DateRangePreset,
  fetchDashboardOperationalSummary,
  fetchInventoryIntelligence,
  fetchPeriodComparison,
  getDateRangeBounds,
  type InventoryIntelligenceResponse,
  type PeriodComparisonResult,
} from '@/services/dashboard-reports-service';

const PRESETS: Array<{ key: DateRangePreset; label: string }> = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
  { key: 'month', label: 'Este mes' },
];

const PAYMENT_COLORS: Record<string, string> = {
  cash: '#087F5B',
  yape: '#742284',
  plin: '#00A8B5',
  card: '#315BE8',
  transfer: '#A65E09',
  fiado: '#D97706',
  other: '#65748B',
};

const WEEKDAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export default function DashboardScreen() {
  const router = useRouter();
  const { accountId, branchId } = useAuth();
  const { activeBranchName } = useSettings();
  const { products } = useProducts();
  const { canAccessDashboard, canViewMargins, hasAllBranchesAccess } = usePermissions();

  const [preset, setPreset] = useState<DateRangePreset>('7d');
  const [scopeAllBranches, setScopeAllBranches] = useState(false);
  const [selectedTrendIndex, setSelectedTrendIndex] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [comparison, setComparison] = useState<PeriodComparisonResult | null>(null);
  const [summary, setSummary] = useState<DashboardOperationalSummary | null>(null);
  const [intelligence, setIntelligence] = useState<InventoryIntelligenceResponse | null>(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelError, setIntelError] = useState<string | null>(null);

  const intelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intelAbortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  const effectiveBranch = useMemo(() => {
    if (hasAllBranchesAccess && scopeAllBranches) return undefined;
    return branchId || undefined;
  }, [hasAllBranchesAccess, scopeAllBranches, branchId]);

  const bounds = useMemo(() => getDateRangeBounds(preset), [preset]);

  const productsMap = useMemo(() => {
    const map = new Map<string, Record<string, any>>();
    for (const p of products) {
      if (p?.id) map.set(p.id, p as unknown as Record<string, any>);
    }
    return map;
  }, [products]);
  const productsMapRef = useRef(productsMap);
  productsMapRef.current = productsMap;

  const loadIntelligence = useCallback(async () => {
    if (!accountId || !canAccessDashboard) return;
    if (intelTimerRef.current) {
      clearTimeout(intelTimerRef.current);
      intelTimerRef.current = null;
    }
    intelAbortRef.current?.abort();
    const controller = new AbortController();
    intelAbortRef.current = controller;

    setIntelLoading(true);
    setIntelError(null);
    try {
      const res = await fetchInventoryIntelligence(accountId, effectiveBranch, {
        signal: controller.signal,
      });
      if (!isMountedRef.current || controller.signal.aborted) return;
      setIntelligence(res);
      if ('building' in res && res.building) {
        const delayMs = Math.min(Math.max(res.retryAfter || 5, 3), 20) * 1000;
        intelTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) void loadIntelligence();
        }, delayMs);
      }
    } catch (err: any) {
      if (!isMountedRef.current || controller.signal.aborted || err?.code === 'ABORTED') return;
      setIntelError(err?.message || 'No se pudo cargar inteligencia de inventario.');
    } finally {
      if (isMountedRef.current && intelAbortRef.current === controller) {
        setIntelLoading(false);
      }
    }
  }, [accountId, canAccessDashboard, effectiveBranch]);

  const loadDashboard = useCallback(
    async (isRefresh = false) => {
      if (!accountId || !canAccessDashboard) {
        setLoading(false);
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      setSelectedTrendIndex(null);

      try {
        const [compResult, opsResult] = await Promise.allSettled([
          fetchPeriodComparison(accountId, bounds.fromMs, bounds.toMs, effectiveBranch),
          fetchDashboardOperationalSummary(
            accountId,
            effectiveBranch,
            bounds.fromMs,
            bounds.toMs,
            productsMapRef.current
          ),
        ]);

        if (opsResult.status === 'fulfilled') {
          setSummary(opsResult.value);
        } else {
          throw opsResult.reason;
        }

        if (compResult.status === 'fulfilled') {
          setComparison(compResult.value);
        } else {
          setComparison(null);
        }
      } catch (err: any) {
        setError(err?.message || 'No se pudieron cargar las métricas del dashboard.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [accountId, canAccessDashboard, bounds.fromMs, bounds.toMs, effectiveBranch]
  );

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    isMountedRef.current = true;
    void loadIntelligence();
    return () => {
      isMountedRef.current = false;
      intelAbortRef.current?.abort();
      intelAbortRef.current = null;
      if (intelTimerRef.current) {
        clearTimeout(intelTimerRef.current);
        intelTimerRef.current = null;
      }
    };
  }, [loadIntelligence]);

  const trendBars = useMemo(() => {
    const rawTrend = comparison?.trend?.length ? comparison.trend : [0, 0, 0, 0, 0, 0, 0];
    const maxVal = Math.max(...rawTrend, 1);
    const len = rawTrend.length;
    return rawTrend.map((val, idx) => {
      const dayMs = bounds.toMs - (len - 1 - idx) * 86_400_000;
      const d = new Date(dayMs);
      const dayLabel = WEEKDAY_SHORT[d.getDay()] || '';
      const dateShort = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      return {
        value: Number(val) || 0,
        heightPct: Math.max(6, Math.round(((Number(val) || 0) / maxVal) * 100)),
        dayLabel,
        dateShort,
      };
    });
  }, [comparison, bounds.toMs]);

  if (!canAccessDashboard) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
            <ArrowLeft size={20} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Dashboard Ejecutivo</Text>
          <View style={styles.iconBtn} />
        </View>
        <View style={styles.deniedBox}>
          <ShieldAlert size={36} color={ui.danger} />
          <Text style={styles.deniedTitle}>Acceso restringido</Text>
          <Text style={styles.deniedText}>
            Tu rol actual no tiene permiso para visualizar el Dashboard Ejecutivo.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const salesSummary = summary?.salesSummary;
  const revenueDelta =
    salesSummary && comparison
      ? calculateVariationPercent(salesSummary.totalRevenue, comparison.previousTotal)
      : null;
  const txDelta =
    salesSummary && comparison
      ? calculateVariationPercent(salesSummary.transactionCount, comparison.previousTransactions)
      : null;

  const isIntelBuilding = Boolean(intelligence && 'building' in intelligence && intelligence.building);
  const intelMetrics =
    intelligence && !('building' in intelligence && intelligence.building)
      ? intelligence
      : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* Header Bar */}
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Volver"
        >
          <ArrowLeft size={20} color={ui.text} />
        </TouchableOpacity>
        <View style={styles.titleCopy}>
          <Text style={styles.topTitle}>Dashboard Ejecutivo</Text>
          <Text style={styles.topSub} numberOfLines={1}>
            {effectiveBranch ? activeBranchName || 'Sucursal activa' : 'Todas las sucursales'} ·{' '}
            {bounds.label}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => {
            void loadDashboard(true);
            void loadIntelligence();
          }}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Actualizar dashboard"
        >
          <RefreshCw size={18} color={ui.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void loadDashboard(true);
              void loadIntelligence();
            }}
            colors={[ui.primary]}
          />
        }
      >
        {/* Date range selector + branch scope */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillsRow}
        >
          {PRESETS.map((p) => {
            const active = preset === p.key;
            return (
              <TouchableOpacity
                key={p.key}
                onPress={() => setPreset(p.key)}
                style={[styles.pill, active && styles.pillActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
          {hasAllBranchesAccess && (
            <TouchableOpacity
              onPress={() => setScopeAllBranches((v) => !v)}
              style={[styles.pill, scopeAllBranches && styles.pillActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: scopeAllBranches }}
            >
              <Text style={[styles.pillText, scopeAllBranches && styles.pillTextActive]}>
                {scopeAllBranches ? 'Todas las sedes' : 'Esta sucursal'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.mutedText}>Consolidando métricas en tiempo real...</Text>
          </View>
        ) : error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => void loadDashboard()} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : summary && salesSummary ? (
          <>
            {/* 4 KPI Cards */}
            <View style={styles.kpiGrid}>
              {/* 1. Ventas Totales */}
              <View style={styles.kpiCard}>
                <View style={styles.kpiTopRow}>
                  <Text style={styles.kpiLabel}>Ventas Totales</Text>
                  <TrendingUp size={15} color={ui.primary} />
                </View>
                <Text style={styles.kpiValue}>{formatPEN(salesSummary.totalRevenue)}</Text>
                {revenueDelta !== null ? (
                  <View style={styles.deltaRow}>
                    {revenueDelta >= 0 ? (
                      <ArrowUpRight size={13} color={ui.success} />
                    ) : (
                      <ArrowDownRight size={13} color={ui.danger} />
                    )}
                    <Text
                      style={[
                        styles.deltaText,
                        { color: revenueDelta >= 0 ? ui.success : ui.danger },
                      ]}
                    >
                      {revenueDelta >= 0 ? '+' : ''}
                      {revenueDelta}% vs previo
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.kpiMeta}>
                    {comparison ? 'Sin ventas en período previo' : bounds.label}
                  </Text>
                )}
              </View>

              {/* 2. Transacciones */}
              <View style={styles.kpiCard}>
                <View style={styles.kpiTopRow}>
                  <Text style={styles.kpiLabel}>Transacciones</Text>
                  <BarChart3 size={15} color={ui.accent} />
                </View>
                <Text style={styles.kpiValue}>{salesSummary.transactionCount}</Text>
                <Text style={styles.kpiMeta} numberOfLines={1}>
                  Ticket prom: {formatPEN(salesSummary.averageTicket)}
                  {txDelta !== null ? ` (${txDelta >= 0 ? '+' : ''}${txDelta}%)` : ''}
                </Text>
              </View>

              {/* 3. Caja en Turno */}
              <View style={styles.kpiCard}>
                <View style={styles.kpiTopRow}>
                  <Text style={styles.kpiLabel}>Caja en Turno</Text>
                  <Wallet
                    size={15}
                    color={summary.openCashSessions.count > 0 ? ui.success : ui.warning}
                  />
                </View>
                <Text style={styles.kpiValue}>
                  {summary.openCashSessions.count > 0
                    ? formatPEN(
                        summary.openCashSessions.totalOpeningBalance +
                          summary.openCashSessions.totalSalesInOpenShifts
                      )
                    : 'Cerrada'}
                </Text>
                <Text style={styles.kpiMeta} numberOfLines={1}>
                  {summary.openCashSessions.count > 0
                    ? `${summary.openCashSessions.count} caja${
                        summary.openCashSessions.count === 1 ? '' : 's'
                      } abierta${summary.openCashSessions.count === 1 ? '' : 's'}`
                    : 'Sin turno abierto'}
                </Text>
              </View>

              {/* 4. Margen Estimado / Inventario en riesgo */}
              <View style={styles.kpiCard}>
                <View style={styles.kpiTopRow}>
                  <Text style={styles.kpiLabel}>
                    {canViewMargins ? 'Margen Estimado' : 'Stock en Riesgo'}
                  </Text>
                  <Package
                    size={15}
                    color={summary.lowStockCount > 0 ? ui.warning : ui.success}
                  />
                </View>
                <Text style={styles.kpiValue}>
                  {canViewMargins
                    ? `${salesSummary.estimatedMarginPercent.toFixed(1)}%`
                    : `${summary.lowStockCount} prod.`}
                </Text>
                <Text style={styles.kpiMeta} numberOfLines={1}>
                  Stock bajo: {summary.lowStockCount} · Fiados venc.: {summary.overdueFiadosCount}
                </Text>
              </View>
            </View>

            {/* 7-Day Daily Sales Bar Visualization */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Tendencia Últimos 7 Días</Text>
                {selectedTrendIndex !== null && trendBars[selectedTrendIndex] ? (
                  <Text style={styles.trendHighlight}>
                    {trendBars[selectedTrendIndex].dateShort}:{' '}
                    {formatPEN(trendBars[selectedTrendIndex].value)}
                  </Text>
                ) : (
                  <Text style={styles.cardSubtitle}>Toca una barra para ver monto</Text>
                )}
              </View>
              <View style={styles.chartArea}>
                {trendBars.map((bar, idx) => {
                  const isSelected = selectedTrendIndex === idx;
                  const hasValue = bar.value > 0;
                  return (
                    <TouchableOpacity
                      key={`${bar.dateShort}-${idx}`}
                      style={styles.barCol}
                      onPress={() => setSelectedTrendIndex(idx)}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={`${bar.dayLabel} ${bar.dateShort}: ${formatPEN(bar.value)}`}
                    >
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              height: `${bar.heightPct}%`,
                              backgroundColor: isSelected
                                ? ui.accent
                                : hasValue
                                  ? ui.primary
                                  : ui.border,
                            },
                          ]}
                        />
                      </View>
                      <Text style={[styles.barDay, isSelected && { color: ui.primary, fontWeight: '800' }]}>
                        {bar.dayLabel}
                      </Text>
                      <Text style={styles.barDate}>{bar.dateShort}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Operational Alerts */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Alertas Operativas</Text>
                <TouchableOpacity onPress={() => router.push('/notifications' as Href)}>
                  <Text style={styles.linkText}>Ver buzón</Text>
                </TouchableOpacity>
              </View>
              {summary.alerts.length === 0 ? (
                <Text style={styles.mutedText}>
                  Todo en orden: sin stock crítico, sin fiados vencidos ni traslados pendientes.
                </Text>
              ) : (
                <View style={styles.alertsList}>
                  {summary.alerts.map((alert) => {
                    const palette =
                      alert.severity === 'danger'
                        ? { bg: ui.dangerSoft, fg: ui.danger }
                        : alert.severity === 'warning'
                          ? { bg: ui.warningSoft, fg: ui.warning }
                          : { bg: ui.primarySoft, fg: ui.primary };
                    return (
                      <TouchableOpacity
                        key={alert.id}
                        onPress={() => router.push(alert.route as Href)}
                        style={[styles.alertRow, { backgroundColor: palette.bg }]}
                        activeOpacity={0.78}
                        accessibilityRole="button"
                      >
                        <AlertTriangle size={18} color={palette.fg} />
                        <View style={styles.alertCopy}>
                          <Text style={[styles.alertTitle, { color: palette.fg }]}>
                            {alert.title}
                          </Text>
                          <Text style={styles.alertDesc}>{alert.description}</Text>
                        </View>
                        <View style={styles.alertAction}>
                          <Text style={[styles.alertActionText, { color: palette.fg }]}>
                            {alert.actionLabel}
                          </Text>
                          <ChevronRight size={14} color={palette.fg} />
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>

            {/* Inventory Intelligence Card */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Inteligencia de Inventario</Text>
                <TouchableOpacity onPress={() => void loadIntelligence()} disabled={intelLoading}>
                  <Text style={styles.linkText}>
                    {intelLoading ? 'Calculando...' : 'Recalcular'}
                  </Text>
                </TouchableOpacity>
              </View>

              {isIntelBuilding ? (
                <View style={styles.buildingBox}>
                  <ActivityIndicator size="small" color={ui.primary} />
                  <View style={styles.buildingCopy}>
                    <Text style={styles.buildingTitle}>
                      Preparando análisis de 90 días...
                    </Text>
                    <Text style={styles.mutedText}>
                      El servidor está calculando GMROI, DSI y stock muerto. Reintento automático en{' '}
                      {intelligence && 'retryAfter' in intelligence ? intelligence.retryAfter : 5}s.
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => void loadIntelligence()}
                    style={styles.smallRetryBtn}
                  >
                    <Text style={styles.smallRetryText}>Reintentar</Text>
                  </TouchableOpacity>
                </View>
              ) : intelError ? (
                <View style={styles.errorInline}>
                  <Text style={styles.errorText}>{intelError}</Text>
                  <TouchableOpacity
                    onPress={() => void loadIntelligence()}
                    style={styles.smallRetryBtn}
                  >
                    <Text style={styles.smallRetryText}>Reintentar</Text>
                  </TouchableOpacity>
                </View>
              ) : intelMetrics ? (
                <View style={styles.intelGrid}>
                  <View style={styles.intelCell}>
                    <Text style={styles.intelLabel}>GMROI</Text>
                    <Text style={styles.intelValue}>{intelMetrics.gmroi.toFixed(2)}x</Text>
                    <Text style={styles.intelHint}>Retorno bruto / inv.</Text>
                  </View>
                  <View style={styles.intelCell}>
                    <Text style={styles.intelLabel}>DSI</Text>
                    <Text style={styles.intelValue}>{Math.round(intelMetrics.dsi)} d</Text>
                    <Text style={styles.intelHint}>Días de inventario</Text>
                  </View>
                  <View style={styles.intelCell}>
                    <Text style={styles.intelLabel}>Rotación</Text>
                    <Text style={styles.intelValue}>
                      {intelMetrics.inventoryTurnover.toFixed(2)}x
                    </Text>
                    <Text style={styles.intelHint}>Últimos 90 días</Text>
                  </View>
                  <View style={styles.intelCell}>
                    <Text style={styles.intelLabel}>Stock Muerto</Text>
                    <Text
                      style={[
                        styles.intelValue,
                        intelMetrics.deadStockCount > 0 && { color: ui.warning },
                      ]}
                    >
                      {intelMetrics.deadStockCount} prod.
                    </Text>
                    <Text style={styles.intelHint}>{formatPEN(intelMetrics.deadStockValue)}</Text>
                  </View>
                </View>
              ) : (
                <ActivityIndicator size="small" color={ui.primary} />
              )}
            </View>

            {/* Payment Distribution */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Distribución de Pagos</Text>
                <CreditCard size={16} color={ui.textSecondary} />
              </View>
              {salesSummary.paymentDistribution.length === 0 ? (
                <Text style={styles.mutedText}>Sin cobros registrados en este período.</Text>
              ) : (
                <View style={styles.progressList}>
                  {salesSummary.paymentDistribution.map((item) => {
                    const color = PAYMENT_COLORS[item.key] || ui.primary;
                    return (
                      <View key={item.key} style={styles.progressItem}>
                        <View style={styles.progressTop}>
                          <Text style={styles.progressLabel}>
                            {item.label} ({item.count})
                          </Text>
                          <Text style={styles.progressValue}>
                            {formatPEN(item.amount)} · {item.percentage.toFixed(1)}%
                          </Text>
                        </View>
                        <View style={styles.progressTrack}>
                          <View
                            style={[
                              styles.progressFill,
                              {
                                width: `${Math.min(100, Math.max(3, item.percentage))}%`,
                                backgroundColor: color,
                              },
                            ]}
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>

            {/* Top Products */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Top Productos del Período</Text>
                <Award size={16} color={ui.warning} />
              </View>
              {salesSummary.topProducts.length === 0 ? (
                <Text style={styles.mutedText}>Sin productos vendidos en este rango.</Text>
              ) : (
                <View style={styles.rankList}>
                  {salesSummary.topProducts.slice(0, 5).map((prod, idx) => (
                    <View key={prod.productId} style={styles.rankRow}>
                      <View style={styles.rankNum}>
                        <Text style={styles.rankNumText}>#{idx + 1}</Text>
                      </View>
                      <View style={styles.rankCopy}>
                        <Text style={styles.rankName} numberOfLines={1}>
                          {prod.name}
                        </Text>
                        <Text style={styles.rankSub}>{prod.quantity} unid.</Text>
                      </View>
                      <Text style={styles.rankVal}>{formatPEN(prod.revenue)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {/* Top Customers */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Top Clientes del Período</Text>
                <Users size={16} color={ui.primary} />
              </View>
              {salesSummary.topCustomers.length === 0 ? (
                <Text style={styles.mutedText}>
                  No hubo ventas asociadas a clientes nominales en este período.
                </Text>
              ) : (
                <View style={styles.rankList}>
                  {salesSummary.topCustomers.slice(0, 5).map((cust, idx) => (
                    <View key={cust.customerKey} style={styles.rankRow}>
                      <View style={styles.rankNum}>
                        <Text style={styles.rankNumText}>#{idx + 1}</Text>
                      </View>
                      <View style={styles.rankCopy}>
                        <Text style={styles.rankName} numberOfLines={1}>
                          {cust.name}
                        </Text>
                        <Text style={styles.rankSub}>
                          {cust.purchasesCount} compra{cust.purchasesCount === 1 ? '' : 's'}
                        </Text>
                      </View>
                      <Text style={styles.rankVal}>{formatPEN(cust.revenue)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleCopy: {
    flex: 1,
    minWidth: 0,
  },
  topTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
  },
  topSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 1,
  },
  scrollContent: {
    padding: 14,
    gap: 12,
    paddingBottom: 32,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  pillActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  pillTextActive: {
    color: ui.primary,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
  },
  mutedText: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  errorCard: {
    backgroundColor: ui.dangerSoft,
    borderRadius: 14,
    padding: 16,
    gap: 10,
    alignItems: 'flex-start',
  },
  errorText: {
    fontSize: 13,
    color: ui.danger,
  },
  retryBtn: {
    backgroundColor: ui.danger,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  kpiCard: {
    width: '48.2%',
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 13,
    gap: 4,
  },
  kpiTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textMuted,
  },
  kpiValue: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
    letterSpacing: -0.3,
  },
  kpiMeta: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  deltaText: {
    fontSize: 11,
    fontWeight: '700',
  },
  card: {
    backgroundColor: ui.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 15,
    gap: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  cardSubtitle: {
    fontSize: 11,
    color: ui.textMuted,
  },
  trendHighlight: {
    fontSize: 12,
    fontWeight: '800',
    color: ui.accent,
  },
  linkText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  chartArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: 150,
    paddingTop: 10,
    gap: 6,
  },
  barCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  barTrack: {
    width: '100%',
    maxWidth: 28,
    height: 102,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  barFill: {
    width: '100%',
    borderRadius: 8,
  },
  barDay: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  barDate: {
    fontSize: 10,
    color: ui.textMuted,
  },
  alertsList: {
    gap: 8,
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
  },
  alertCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  alertTitle: {
    fontSize: 13,
    fontWeight: '800',
  },
  alertDesc: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  alertAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  alertActionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  buildingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: ui.primarySoft,
    padding: 12,
    borderRadius: 12,
  },
  buildingCopy: {
    flex: 1,
    gap: 2,
  },
  buildingTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  errorInline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  smallRetryBtn: {
    backgroundColor: ui.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  smallRetryText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  intelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  intelCell: {
    width: '48.2%',
    backgroundColor: ui.background,
    borderRadius: 12,
    padding: 11,
    gap: 2,
  },
  intelLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textMuted,
  },
  intelValue: {
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
  },
  intelHint: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  progressList: {
    gap: 10,
  },
  progressItem: {
    gap: 4,
  },
  progressTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  progressValue: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  progressTrack: {
    height: 8,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  rankList: {
    gap: 8,
  },
  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  rankNum: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankNumText: {
    fontSize: 11,
    fontWeight: '800',
    color: ui.textSecondary,
  },
  rankCopy: {
    flex: 1,
    minWidth: 0,
  },
  rankName: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  rankSub: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  rankVal: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },
  deniedBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 10,
  },
  deniedTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  deniedText: {
    fontSize: 14,
    color: ui.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
