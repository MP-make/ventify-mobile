import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  Download,
  FileSpreadsheet,
  FileText,
  Lock,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { FinancialPnlModal } from '@/components/FinancialPnlModal';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import { getProductKardex } from '@/services/inventory-kardex-service';
import {
  exportPnlReportPDF,
  type PnlPeriodType,
  type PnlReportResult,
} from '@/services/pnl-report-service';
import {
  type CashClosureReportItem,
  type DashboardOperationalSummary,
  type DateRangePreset,
  downloadAndShareExportFile,
  type ExpensesReportSummary,
  fetchCanonicalPnlReport,
  fetchCashClosureReports,
  fetchDashboardOperationalSummary,
  fetchExpensesReport,
  fetchReceivablesReport,
  fetchSellerPerformanceReport,
  getDateRangeBounds,
  type ReceivablesSummary,
  type SellerPerformanceApiResponse,
  toEpochMs,
} from '@/services/dashboard-reports-service';

type ReportTab =
  | 'sales'
  | 'pnl'
  | 'inventory'
  | 'kardex'
  | 'closures'
  | 'receivables'
  | 'sellers'
  | 'expenses';

type KardexTypeFilter = 'all' | 'in' | 'out' | 'adjustment' | 'transfer';

const REPORT_TABS: Array<{ key: ReportTab; label: string }> = [
  { key: 'sales', label: 'Ventas' },
  { key: 'pnl', label: 'P&L' },
  { key: 'inventory', label: 'Inventario' },
  { key: 'kardex', label: 'Kardex' },
  { key: 'closures', label: 'Cierres Z' },
  { key: 'receivables', label: 'Clientes / CxC' },
  { key: 'sellers', label: 'Vendedores' },
  { key: 'expenses', label: 'Egresos' },
];

const PRESETS: Array<{ key: DateRangePreset; label: string }> = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
  { key: 'month', label: 'Este mes' },
];

const KARDEX_FILTERS: Array<{ key: KardexTypeFilter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'in', label: 'Entradas' },
  { key: 'out', label: 'Salidas' },
  { key: 'adjustment', label: 'Ajustes' },
  { key: 'transfer', label: 'Traslados' },
];

const MIME_CSV = 'text/csv;charset=utf-8';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function mapPresetToPnlPeriod(preset: DateRangePreset): PnlPeriodType {
  switch (preset) {
    case 'today':
      return 'today';
    case '7d':
      return 'last_7_days';
    case '30d':
      return 'last_30_days';
    case 'month':
      return 'this_month';
  }
}

export default function ReportsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accountId, branchId } = useAuth();
  const { businessName, activeBranchName, branches, posSettings } = useSettings();
  const { products } = useProducts();
  const {
    canViewReports,
    canViewMargins,
    canViewInventoryValue,
    hasAllBranchesAccess,
    isOwner,
    isAdmin,
  } = usePermissions();

  const [activeTab, setActiveTab] = useState<ReportTab>('sales');
  const [preset, setPreset] = useState<DateRangePreset>('month');
  const [scopeAllBranches, setScopeAllBranches] = useState(false);

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [tabError, setTabError] = useState<string | null>(null);

  // Per-tab data
  const [salesData, setSalesData] = useState<DashboardOperationalSummary | null>(null);
  const [pnlReport, setPnlReport] = useState<PnlReportResult | null>(null);
  const [pnlModalVisible, setPnlModalVisible] = useState(false);
  const [kardexItems, setKardexItems] = useState<any[]>([]);
  const [kardexFilter, setKardexFilter] = useState<KardexTypeFilter>('all');
  const [kardexBranchId, setKardexBranchId] = useState<string>('');
  const [closures, setClosures] = useState<CashClosureReportItem[]>([]);
  const [selectedClosure, setSelectedClosure] = useState<CashClosureReportItem | null>(null);
  const [receivables, setReceivables] = useState<ReceivablesSummary | null>(null);
  const [sellersData, setSellersData] = useState<SellerPerformanceApiResponse | null>(null);
  const [commissionRateInput, setCommissionRateInput] = useState('0');
  const [expensesData, setExpensesData] = useState<ExpensesReportSummary | null>(null);

  const effectiveBranch = useMemo(() => {
    if (hasAllBranchesAccess && scopeAllBranches) return undefined;
    return branchId || undefined;
  }, [hasAllBranchesAccess, scopeAllBranches, branchId]);

  useEffect(() => {
    setKardexBranchId(effectiveBranch || 'all');
  }, [effectiveBranch]);

  const bounds = useMemo(() => getDateRangeBounds(preset), [preset]);

  const productsMap = useMemo(() => {
    const map = new Map<string, any>();
    for (const p of products) {
      if (p?.id) map.set(p.id, p);
    }
    return map;
  }, [products]);

  const inventorySummary = useMemo(() => {
    let activeCount = 0;
    let totalUnits = 0;
    let costValuation = 0;
    let retailValuation = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    const criticalList: Array<{ id: string; name: string; qty: number; minStock: number }> = [];

    for (const p of products) {
      if (p.active === false) continue;
      activeCount += 1;
      const stockMap = p.stock || {};
      const qty = effectiveBranch
        ? Number(stockMap[effectiveBranch]) || 0
        : Object.values(stockMap).reduce((sum, v) => sum + (Number(v) || 0), 0);

      const safeQty = Math.max(0, qty);
      totalUnits += safeQty;
      const cost = Number(p.costPrice) || 0;
      const retail = Number(p.suggestedPrice ?? p.price) || 0;
      costValuation += safeQty * cost;
      retailValuation += safeQty * retail;

      const minStock = Number(p.minStock) || 5;
      if (qty <= 0) {
        outOfStockCount += 1;
        criticalList.push({ id: p.id, name: p.name, qty, minStock });
      } else if (qty <= minStock) {
        lowStockCount += 1;
        criticalList.push({ id: p.id, name: p.name, qty, minStock });
      }
    }

    criticalList.sort((a, b) => a.qty - b.qty);

    return {
      activeCount,
      totalUnits: Math.round(totalUnits * 100) / 100,
      costValuation: Math.round(costValuation * 100) / 100,
      retailValuation: Math.round(retailValuation * 100) / 100,
      lowStockCount,
      outOfStockCount,
      criticalList: criticalList.slice(0, 15),
    };
  }, [products, effectiveBranch]);

  const loadTabData = useCallback(
    async (isRefresh = false) => {
      if (!accountId || !canViewReports) return;
      if (activeTab === 'inventory') {
        setTabError(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setTabError(null);

      try {
        switch (activeTab) {
          case 'sales': {
            const res = await fetchDashboardOperationalSummary(
              accountId,
              effectiveBranch,
              bounds.fromMs,
              bounds.toMs,
              productsMap
            );
            setSalesData(res);
            break;
          }
          case 'pnl': {
            if (!canViewMargins) {
              setPnlReport(null);
              break;
            }
            const res = await fetchCanonicalPnlReport({
              accountId,
              branchId: effectiveBranch,
              startDate: bounds.fromMs,
              endDate: bounds.toMs,
              productsMap,
            });
            setPnlReport(res);
            break;
          }
          case 'kardex': {
            const branchScope = hasAllBranchesAccess ? kardexBranchId || 'all' : effectiveBranch || 'all';
            const list = await getProductKardex(accountId, branchScope, undefined, 80);
            setKardexItems(list);
            break;
          }
          case 'closures': {
            const list = await fetchCashClosureReports(
              accountId,
              effectiveBranch,
              bounds.fromMs,
              bounds.toMs
            );
            setClosures(list);
            break;
          }
          case 'receivables': {
            const res = await fetchReceivablesReport(accountId, effectiveBranch);
            setReceivables(res);
            break;
          }
          case 'sellers': {
            const res = await fetchSellerPerformanceReport(
              accountId,
              bounds.fromIso,
              bounds.toIso,
              effectiveBranch
            );
            setSellersData(res);
            break;
          }
          case 'expenses': {
            const res = await fetchExpensesReport(
              accountId,
              effectiveBranch,
              bounds.fromMs,
              bounds.toMs
            );
            setExpensesData(res);
            break;
          }
        }
      } catch (err: any) {
        setTabError(err?.message || 'No se pudo cargar este reporte.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [
      accountId,
      canViewReports,
      activeTab,
      effectiveBranch,
      bounds.fromMs,
      bounds.toMs,
      bounds.fromIso,
      bounds.toIso,
      productsMap,
      canViewMargins,
      hasAllBranchesAccess,
      kardexBranchId,
    ]
  );

  useEffect(() => {
    void loadTabData();
  }, [loadTabData]);

  const handleServerExport = async (
    kind: 'sales' | 'expenses' | 'inventory' | 'payroll' | 'receivables',
    format: 'csv' | 'xlsx'
  ) => {
    if (!accountId) return;
    const key = `${kind}_${format}`;
    setExportingKey(key);
    try {
      const params = new URLSearchParams({ accountId, format });
      if (kind !== 'inventory') {
        params.set('from', bounds.fromIso);
        params.set('to', bounds.toIso);
      }
      if (effectiveBranch) params.set('branchId', effectiveBranch);
      const path = `/api/reports/export/${kind}?${params.toString()}`;
      const filename =
        kind === 'inventory'
          ? `inventario_${bounds.toIso}.${format}`
          : `${kind}_${bounds.fromIso}_${bounds.toIso}.${format}`;
      await downloadAndShareExportFile(path, filename, format === 'xlsx' ? MIME_XLSX : MIME_CSV);
    } catch (err: any) {
      Alert.alert('Error al exportar', err?.message || 'No se pudo descargar el archivo.');
    } finally {
      setExportingKey(null);
    }
  };

  const handleExportPnlPdf = async () => {
    if (!pnlReport) return;
    setExportingKey('pnl_pdf');
    try {
      await exportPnlReportPDF(
        pnlReport,
        businessName || 'Mi Negocio',
        effectiveBranch ? activeBranchName || 'Sucursal' : 'Todas las sucursales',
        bounds.label
      );
    } catch (err: any) {
      Alert.alert('Error al exportar PDF', err?.message || 'No se pudo generar el PDF.');
    } finally {
      setExportingKey(null);
    }
  };

  const filteredKardex = useMemo(() => {
    if (kardexFilter === 'all') return kardexItems;
    return kardexItems.filter((item) => {
      const mt = String(item.movementType || '').toLowerCase();
      const t = String(item.type || '').toLowerCase();
      if (kardexFilter === 'transfer') return mt.includes('transfer') || t === 'transfer';
      if (kardexFilter === 'adjustment') {
        return mt.includes('adjust') || mt.includes('audit') || mt.includes('damage') || t === 'adjustment';
      }
      if (kardexFilter === 'in') return t === 'in';
      if (kardexFilter === 'out') return t === 'out';
      return true;
    });
  }, [kardexItems, kardexFilter]);

  const visibleTabs = useMemo(() => {
    return REPORT_TABS.filter((tab) => {
      if (tab.key === 'sellers') {
        return Boolean(posSettings.enableSellerAttribution) || canViewReports;
      }
      return true;
    });
  }, [posSettings.enableSellerAttribution, canViewReports]);

  if (!canViewReports) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
            <ArrowLeft size={20} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Reportes y Exportación</Text>
          <View style={styles.iconBtn} />
        </View>
        <View style={styles.deniedBox}>
          <ShieldAlert size={36} color={ui.danger} />
          <Text style={styles.deniedTitle}>Acceso restringido</Text>
          <Text style={styles.deniedText}>
            Tu rol actual no tiene permisos para consultar reportes ni exportar archivos.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const commissionPct = Math.max(0, Math.min(100, Number(commissionRateInput) || 0));

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* Top Bar */}
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
          <Text style={styles.topTitle}>Reportes y Exportación</Text>
          <Text style={styles.topSub} numberOfLines={1}>
            {effectiveBranch ? activeBranchName || 'Sucursal' : 'Todas las sedes'} · {bounds.label}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => void loadTabData(true)}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Actualizar reporte"
        >
          <RefreshCw size={18} color={ui.primary} />
        </TouchableOpacity>
      </View>

      {/* Date presets & branch scope */}
      <View style={styles.controlsBar}>
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
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
          {hasAllBranchesAccess && (
            <TouchableOpacity
              onPress={() => setScopeAllBranches((v) => !v)}
              style={[styles.pill, scopeAllBranches && styles.pillActive]}
            >
              <Text style={[styles.pillText, scopeAllBranches && styles.pillTextActive]}>
                {scopeAllBranches ? 'Todas las sedes' : 'Esta sucursal'}
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* 8 Report Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
        >
          {visibleTabs.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={[styles.tabItem, active && styles.tabItemActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadTabData(true)}
            colors={[ui.primary]}
          />
        }
      >
        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.mutedText}>Generando reporte...</Text>
          </View>
        ) : tabError ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{tabError}</Text>
            <TouchableOpacity onPress={() => void loadTabData()} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* 1. VENTAS */}
        {!loading && !tabError && activeTab === 'sales' && salesData && (
          <View style={styles.section}>
            <View style={styles.exportRow}>
              <TouchableOpacity
                onPress={() => void handleServerExport('sales', 'csv')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'sales_csv' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <Download size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Exportar CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void handleServerExport('sales', 'xlsx')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'sales_xlsx' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <FileSpreadsheet size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Exportar XLSX</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Ventas Netas</Text>
                <Text style={styles.kpiValue}>{formatPEN(salesData.salesSummary.totalRevenue)}</Text>
                <Text style={styles.kpiMeta}>
                  Devoluciones: {formatPEN(salesData.salesSummary.returnsTotal)}
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Transacciones</Text>
                <Text style={styles.kpiValue}>{salesData.salesSummary.transactionCount}</Text>
                <Text style={styles.kpiMeta}>
                  Ticket prom: {formatPEN(salesData.salesSummary.averageTicket)}
                </Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Comprobantes por Tipo</Text>
              {salesData.salesSummary.documentTypeBreakdown.length === 0 ? (
                <Text style={styles.mutedText}>Sin comprobantes en este período.</Text>
              ) : (
                salesData.salesSummary.documentTypeBreakdown.map((doc) => (
                  <View key={doc.typeKey} style={styles.lineRow}>
                    <Text style={styles.lineLabel}>
                      {doc.label} ({doc.count})
                    </Text>
                    <Text style={styles.lineValue}>{formatPEN(doc.total)}</Text>
                  </View>
                ))
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Top Ítems Vendidos</Text>
              {salesData.salesSummary.topProducts.length === 0 ? (
                <Text style={styles.mutedText}>Sin ítems vendidos en este período.</Text>
              ) : (
                salesData.salesSummary.topProducts.map((prod, idx) => (
                  <View key={prod.productId} style={styles.lineRow}>
                    <Text style={styles.lineLabel} numberOfLines={1}>
                      #{idx + 1} {prod.name} ({prod.quantity} u.)
                    </Text>
                    <Text style={styles.lineValue}>{formatPEN(prod.revenue)}</Text>
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* 2. P&L */}
        {!loading && !tabError && activeTab === 'pnl' && (
          <View style={styles.section}>
            {!canViewMargins ? (
              <View style={styles.card}>
                <View style={styles.lockRow}>
                  <Lock size={20} color={ui.warning} />
                  <Text style={styles.cardTitle}>Acceso financiero restringido</Text>
                </View>
                <Text style={styles.mutedText}>
                  El Estado de Resultados (P&L) requiere el permiso `view_margins`.
                </Text>
              </View>
            ) : pnlReport ? (
              <>
                <View style={styles.exportRow}>
                  <TouchableOpacity
                    onPress={() => setPnlModalVisible(true)}
                    style={styles.primaryActionBtn}
                  >
                    <FileText size={16} color={ui.onPrimary} />
                    <Text style={styles.primaryActionBtnText}>Abrir P&L Completo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void handleExportPnlPdf()}
                    disabled={exportingKey !== null}
                    style={styles.exportBtn}
                  >
                    {exportingKey === 'pnl_pdf' ? (
                      <ActivityIndicator size="small" color={ui.primary} />
                    ) : (
                      <Download size={15} color={ui.primary} />
                    )}
                    <Text style={styles.exportBtnText}>Exportar PDF</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.kpiRow}>
                  <View style={styles.kpiBox}>
                    <Text style={styles.kpiLabel}>Ventas Netas Devengadas</Text>
                    <Text style={styles.kpiValue}>{formatPEN(pnlReport.netRevenue)}</Text>
                    <Text style={styles.kpiMeta}>
                      Cerradas {formatPEN(pnlReport.salesClosed)} · Fiados {formatPEN(pnlReport.fiadosIssued)}
                    </Text>
                  </View>
                  <View style={styles.kpiBox}>
                    <Text style={styles.kpiLabel}>Utilidad Neta</Text>
                    <Text
                      style={[
                        styles.kpiValue,
                        { color: pnlReport.netProfit >= 0 ? ui.success : ui.danger },
                      ]}
                    >
                      {formatPEN(pnlReport.netProfit)}
                    </Text>
                    <Text style={styles.kpiMeta}>
                      Margen neto: {pnlReport.netMarginPercent.toFixed(1)}%
                    </Text>
                  </View>
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Cascada Operativa (P&L)</Text>
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>Ventas Brutas</Text>
                    <Text style={styles.lineValue}>{formatPEN(pnlReport.grossSales)}</Text>
                  </View>
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>(-) Devoluciones</Text>
                    <Text style={[styles.lineValue, { color: ui.danger }]}>
                      -{formatPEN(pnlReport.returns)}
                    </Text>
                  </View>
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>(-) Costo de Mercadería (CMV)</Text>
                    <Text style={[styles.lineValue, { color: ui.danger }]}>
                      -{formatPEN(pnlReport.cogs)}
                    </Text>
                  </View>
                  <View style={[styles.lineRow, styles.subtotalRow]}>
                    <Text style={[styles.lineLabel, { fontWeight: '800' }]}>
                      Utilidad Bruta ({pnlReport.grossMarginPercent.toFixed(1)}%)
                    </Text>
                    <Text style={[styles.lineValue, { color: ui.success }]}>
                      {formatPEN(pnlReport.grossProfit)}
                    </Text>
                  </View>
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>(-) Gastos Operativos</Text>
                    <Text style={[styles.lineValue, { color: ui.danger }]}>
                      -{formatPEN(pnlReport.operatingExpenses)}
                    </Text>
                  </View>
                  <View style={styles.lineRow}>
                    <Text style={styles.lineLabel}>Comisiones POS / Incobrables</Text>
                    <Text style={styles.lineValue}>
                      {formatPEN(pnlReport.terminalCommissions + pnlReport.badDebt)}
                    </Text>
                  </View>
                </View>
              </>
            ) : null}
          </View>
        )}

        {/* 3. INVENTARIO */}
        {activeTab === 'inventory' && (
          <View style={styles.section}>
            <View style={styles.exportRow}>
              <TouchableOpacity
                onPress={() => void handleServerExport('inventory', 'csv')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'inventory_csv' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <Download size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Exportar CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void handleServerExport('inventory', 'xlsx')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'inventory_xlsx' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <FileSpreadsheet size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Exportar XLSX</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Valor al Precio Venta</Text>
                <Text style={styles.kpiValue}>{formatPEN(inventorySummary.retailValuation)}</Text>
                <Text style={styles.kpiMeta}>
                  {inventorySummary.activeCount} SKUs · {inventorySummary.totalUnits} u.
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>
                  {canViewInventoryValue || isOwner || isAdmin ? 'Valorizado al Costo' : 'Alertas Stock'}
                </Text>
                <Text style={styles.kpiValue}>
                  {canViewInventoryValue || isOwner || isAdmin
                    ? formatPEN(inventorySummary.costValuation)
                    : `${inventorySummary.lowStockCount + inventorySummary.outOfStockCount}`}
                </Text>
                <Text style={styles.kpiMeta}>
                  Bajo: {inventorySummary.lowStockCount} · Agotado: {inventorySummary.outOfStockCount}
                </Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Productos con Stock Bajo o Agotado</Text>
              {inventorySummary.criticalList.length === 0 ? (
                <Text style={styles.mutedText}>Todos los productos tienen stock saludable.</Text>
              ) : (
                inventorySummary.criticalList.map((p) => (
                  <View key={p.id} style={styles.lineRow}>
                    <Text style={styles.lineLabel} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text
                      style={[
                        styles.lineValue,
                        { color: p.qty <= 0 ? ui.danger : ui.warning },
                      ]}
                    >
                      {p.qty} / mín {p.minStock}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* 4. KARDEX */}
        {!loading && !tabError && activeTab === 'kardex' && (
          <View style={styles.section}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pillsRow}
            >
              {KARDEX_FILTERS.map((f) => {
                const active = kardexFilter === f.key;
                return (
                  <TouchableOpacity
                    key={f.key}
                    onPress={() => setKardexFilter(f.key)}
                    style={[styles.pill, active && styles.pillActive]}
                  >
                    <Text style={[styles.pillText, active && styles.pillTextActive]}>{f.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {hasAllBranchesAccess && branches.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pillsRow}
              >
                <TouchableOpacity
                  onPress={() => setKardexBranchId('all')}
                  style={[styles.pill, kardexBranchId === 'all' && styles.pillActive]}
                >
                  <Text
                    style={[styles.pillText, kardexBranchId === 'all' && styles.pillTextActive]}
                  >
                    Todas las sedes
                  </Text>
                </TouchableOpacity>
                {branches.map((b) => {
                  if (!b.id) return null;
                  const active = kardexBranchId === b.id;
                  return (
                    <TouchableOpacity
                      key={b.id}
                      onPress={() => setKardexBranchId(b.id!)}
                      style={[styles.pill, active && styles.pillActive]}
                    >
                      <Text style={[styles.pillText, active && styles.pillTextActive]}>{b.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            {filteredKardex.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.mutedText}>No hay movimientos Kardex en este filtro.</Text>
              </View>
            ) : (
              filteredKardex.map((mov, index) => {
                const delta = Number(mov.quantityChanged ?? (mov.type === 'in' ? mov.quantity : -mov.quantity)) || 0;
                const isPositive = delta >= 0;
                return (
                  <View key={mov.id || `${index}`} style={styles.card}>
                    <View style={styles.lineRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {mov.productName || 'Producto'}
                      </Text>
                      <Text
                        style={[
                          styles.lineValue,
                          { color: isPositive ? ui.success : ui.danger },
                        ]}
                      >
                        {isPositive ? '+' : ''}
                        {delta}
                      </Text>
                    </View>
                    <Text style={styles.mutedText}>
                      Stock: {mov.quantityBefore ?? mov.previousStock ?? 0} →{' '}
                      {mov.quantityAfter ?? mov.newStock ?? 0} ·{' '}
                      {mov.reason || mov.movementType || 'Movimiento'}
                    </Text>
                    <Text style={styles.metaSmall}>
                      {formatDatePE(toEpochMs(mov.createdAt || mov.date))}
                      {mov.userName ? ` · ${mov.userName}` : ''}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* 5. CIERRES Z */}
        {!loading && !tabError && activeTab === 'closures' && (
          <View style={styles.section}>
            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Cierres en Período</Text>
                <Text style={styles.kpiValue}>{closures.length}</Text>
                <Text style={styles.kpiMeta}>
                  Esperado: {formatPEN(closures.reduce((s, c) => s + c.expectedAmount, 0))}
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Diferencia Acumulada</Text>
                {(() => {
                  const totalDiff = closures.reduce((s, c) => s + c.difference, 0);
                  return (
                    <>
                      <Text
                        style={[
                          styles.kpiValue,
                          { color: totalDiff >= 0 ? ui.success : ui.danger },
                        ]}
                      >
                        {totalDiff >= 0 ? '+' : ''}
                        {formatPEN(totalDiff)}
                      </Text>
                      <Text style={styles.kpiMeta}>
                        {closures.filter((c) => c.difference < 0).length} con faltante
                      </Text>
                    </>
                  );
                })()}
              </View>
            </View>

            {closures.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.mutedText}>Sin cierres Z registrados en este rango.</Text>
              </View>
            ) : (
              closures.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => setSelectedClosure(c)}
                  style={styles.card}
                  activeOpacity={0.78}
                >
                  <View style={styles.lineRow}>
                    <Text style={styles.cardTitle}>
                      {c.branchName || 'Caja'} · {c.closedByName || c.startedByName || 'Operador'}
                    </Text>
                    <Text
                      style={[
                        styles.lineValue,
                        {
                          color:
                            c.difference === 0
                              ? ui.success
                              : c.difference > 0
                                ? ui.primary
                                : ui.danger,
                        },
                      ]}
                    >
                      {c.difference === 0
                        ? 'Cuadrado'
                        : `${c.difference > 0 ? '+' : ''}${formatPEN(c.difference)}`}
                    </Text>
                  </View>
                  <Text style={styles.mutedText}>
                    Esperado: {formatPEN(c.expectedAmount)} · Contado: {formatPEN(c.countedAmount)}
                  </Text>
                  <Text style={styles.metaSmall}>
                    {formatDatePE(c.closeTime || c.createdAt)} · Tocar para detalle
                  </Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {/* 6. CLIENTES / CXC */}
        {!loading && !tabError && activeTab === 'receivables' && receivables && (
          <View style={styles.section}>
            <View style={styles.exportRow}>
              <TouchableOpacity
                onPress={() => void handleServerExport('receivables', 'csv')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'receivables_csv' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <Download size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Exportar CxC CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void handleServerExport('receivables', 'xlsx')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'receivables_xlsx' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <FileSpreadsheet size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Exportar CxC XLSX</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Deuda Fiados Pendiente</Text>
                <Text style={[styles.kpiValue, { color: ui.warning }]}>
                  {formatPEN(receivables.totalDebt)}
                </Text>
                <Text style={styles.kpiMeta}>
                  {receivables.activeFiadosCount} cuentas · {receivables.overdueFiadosCount} venc.
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Créditos a Favor</Text>
                <Text style={[styles.kpiValue, { color: ui.success }]}>
                  {formatPEN(receivables.totalCreditsInFavor)}
                </Text>
                <Text style={styles.kpiMeta}>
                  Vencido: {formatPEN(receivables.overdueDebt)}
                </Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Fiados Pendientes</Text>
              {receivables.fiados.length === 0 ? (
                <Text style={styles.mutedText}>No hay fiados pendientes por cobrar.</Text>
              ) : (
                receivables.fiados.slice(0, 15).map((f) => (
                  <View key={f.id} style={styles.lineRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.lineLabel} numberOfLines={1}>
                        {f.customerName}
                      </Text>
                      <Text
                        style={[
                          styles.metaSmall,
                          f.isOverdue && { color: ui.danger, fontWeight: '700' },
                        ]}
                      >
                        {f.isOverdue ? 'VENCIDO · ' : ''}
                        {f.dueDate ? `Vence: ${formatDatePE(f.dueDate, false)}` : formatDatePE(f.date, false)}
                      </Text>
                    </View>
                    <Text style={[styles.lineValue, f.isOverdue && { color: ui.danger }]}>
                      {formatPEN(f.remainingAmount)}
                    </Text>
                  </View>
                ))
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Top Clientes (Deuda / Compras)</Text>
              {receivables.topCustomers.length === 0 ? (
                <Text style={styles.mutedText}>Sin clientes registrados.</Text>
              ) : (
                receivables.topCustomers.slice(0, 10).map((c) => (
                  <View key={c.id} style={styles.lineRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.lineLabel} numberOfLines={1}>
                        {c.name}
                      </Text>
                      <Text style={styles.metaSmall}>
                        {c.totalPurchases} compras · Gastado {formatPEN(c.totalSpent)}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.lineValue,
                        c.currentDebt > 0 && { color: ui.warning },
                      ]}
                    >
                      {c.currentDebt > 0 ? `Debe ${formatPEN(c.currentDebt)}` : 'Al día'}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </View>
        )}

        {/* 7. VENDEDORES */}
        {!loading && !tabError && activeTab === 'sellers' && sellersData && (
          <View style={styles.section}>
            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Neto Atribuido</Text>
                <Text style={styles.kpiValue}>{formatPEN(sellersData.report.totalNet)}</Text>
                <Text style={styles.kpiMeta}>
                  Bruto: {formatPEN(sellersData.report.totalGross)}
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Devoluciones</Text>
                <Text style={[styles.kpiValue, { color: ui.danger }]}>
                  {formatPEN(sellersData.report.totalRefunds)}
                </Text>
                <Text style={styles.kpiMeta}>{sellersData.timeZone}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.commissionRow}>
                <Text style={styles.lineLabel}>Simular Comisión (% sobre Neto):</Text>
                <TextInput
                  value={commissionRateInput}
                  onChangeText={setCommissionRateInput}
                  keyboardType="decimal-pad"
                  maxLength={5}
                  style={styles.commissionInput}
                />
              </View>
            </View>

            {sellersData.report.rows.length === 0 ? (
              <View style={styles.card}>
                <Text style={styles.mutedText}>
                  No hay ventas comerciales atribuidas en este período.
                </Text>
              </View>
            ) : (
              sellersData.report.rows.map((row, idx) => {
                const commissionAmt = Math.round(row.net * (commissionPct / 100) * 100) / 100;
                return (
                  <View key={row.sellerId || `unassigned-${idx}`} style={styles.card}>
                    <View style={styles.lineRow}>
                      <Text style={styles.cardTitle}>
                        #{idx + 1} {row.sellerName}
                      </Text>
                      <Text style={[styles.lineValue, { color: ui.primary }]}>
                        {formatPEN(row.net)}
                      </Text>
                    </View>
                    <Text style={styles.mutedText}>
                      {row.salesCount} ventas · Bruto {formatPEN(row.gross)} · Dev.{' '}
                      {formatPEN(row.refunds)}
                    </Text>
                    <Text style={styles.metaSmall}>
                      Participación:{' '}
                      {row.participation !== null ? `${row.participation.toFixed(1)}%` : '—'}
                      {commissionPct > 0 ? ` · Comisión est.: ${formatPEN(commissionAmt)}` : ''}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* 8. EGRESOS & NÓMINA */}
        {!loading && !tabError && activeTab === 'expenses' && expensesData && (
          <View style={styles.section}>
            <View style={styles.exportRow}>
              <TouchableOpacity
                onPress={() => void handleServerExport('expenses', 'csv')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'expenses_csv' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <Download size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Egresos CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void handleServerExport('expenses', 'xlsx')}
                disabled={exportingKey !== null}
                style={styles.exportBtn}
              >
                {exportingKey === 'expenses_xlsx' ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <FileSpreadsheet size={15} color={ui.primary} />
                )}
                <Text style={styles.exportBtnText}>Egresos XLSX</Text>
              </TouchableOpacity>
            </View>

            {canViewMargins && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Exportar Nómina Aprobada</Text>
                <Text style={styles.mutedText}>
                  Liquidaciones aprobadas que traslapan con el rango {bounds.fromIso} a {bounds.toIso}.
                </Text>
                <View style={styles.exportRow}>
                  <TouchableOpacity
                    onPress={() => void handleServerExport('payroll', 'csv')}
                    disabled={exportingKey !== null}
                    style={styles.exportBtn}
                  >
                    {exportingKey === 'payroll_csv' ? (
                      <ActivityIndicator size="small" color={ui.primary} />
                    ) : (
                      <Download size={15} color={ui.primary} />
                    )}
                    <Text style={styles.exportBtnText}>Nómina CSV</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void handleServerExport('payroll', 'xlsx')}
                    disabled={exportingKey !== null}
                    style={styles.exportBtn}
                  >
                    {exportingKey === 'payroll_xlsx' ? (
                      <ActivityIndicator size="small" color={ui.primary} />
                    ) : (
                      <FileSpreadsheet size={15} color={ui.primary} />
                    )}
                    <Text style={styles.exportBtnText}>Nómina XLSX</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Egresos Operativos</Text>
                <Text style={[styles.kpiValue, { color: ui.danger }]}>
                  {formatPEN(expensesData.totalOperatingExpenses)}
                </Text>
                <Text style={styles.kpiMeta}>
                  Adelantos: {formatPEN(expensesData.totalEmployeeAdvances)}
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Devoluciones Caja</Text>
                <Text style={styles.kpiValue}>{formatPEN(expensesData.totalRefunds)}</Text>
                <Text style={styles.kpiMeta}>{expensesData.movementsCount} mov. analizados</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Resumen por Categoría</Text>
              {expensesData.categories.length === 0 ? (
                <Text style={styles.mutedText}>Sin gastos operativos registrados en este período.</Text>
              ) : (
                expensesData.categories.map((cat) => (
                  <View key={cat.category} style={styles.lineRow}>
                    <Text style={styles.lineLabel}>
                      {cat.label} ({cat.count}) · {cat.percentage}%
                    </Text>
                    <Text style={[styles.lineValue, { color: ui.danger }]}>
                      {formatPEN(cat.amount)}
                    </Text>
                  </View>
                ))
              )}
            </View>

            {expensesData.recentExpenses.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Últimos Egresos</Text>
                {expensesData.recentExpenses.slice(0, 12).map((exp) => (
                  <View key={exp.id} style={styles.lineRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.lineLabel} numberOfLines={1}>
                        {exp.reason}
                      </Text>
                      <Text style={styles.metaSmall}>
                        {exp.label} · {formatDatePE(exp.createdAt)}
                      </Text>
                    </View>
                    <Text style={[styles.lineValue, { color: ui.danger }]}>
                      -{formatPEN(exp.amount)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* P&L Full Modal */}
      {pnlModalVisible && (
        <FinancialPnlModal
          visible={pnlModalVisible}
          onClose={() => setPnlModalVisible(false)}
          initialPeriod={mapPresetToPnlPeriod(preset)}
        />
      )}

      {/* Cierre Z Detail Modal */}
      <Modal
        visible={Boolean(selectedClosure)}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedClosure(null)}
      >
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={() => setSelectedClosure(null)}
        >
          <View
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Detalle de Cierre Z</Text>
              <TouchableOpacity onPress={() => setSelectedClosure(null)} style={styles.iconBtn}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>
            {selectedClosure && (
              <ScrollView contentContainerStyle={styles.sheetBody}>
                <View style={styles.lineRow}>
                  <Text style={styles.lineLabel}>Sucursal / Operador</Text>
                  <Text style={styles.lineValue}>
                    {selectedClosure.branchName || 'Principal'} ·{' '}
                    {selectedClosure.closedByName || selectedClosure.startedByName || '—'}
                  </Text>
                </View>
                <View style={styles.lineRow}>
                  <Text style={styles.lineLabel}>Fecha Cierre</Text>
                  <Text style={styles.lineValue}>
                    {formatDatePE(selectedClosure.closeTime || selectedClosure.createdAt)}
                  </Text>
                </View>
                <View style={styles.lineRow}>
                  <Text style={styles.lineLabel}>Efectivo Esperado</Text>
                  <Text style={styles.lineValue}>{formatPEN(selectedClosure.expectedAmount)}</Text>
                </View>
                <View style={styles.lineRow}>
                  <Text style={styles.lineLabel}>Efectivo Contado</Text>
                  <Text style={styles.lineValue}>{formatPEN(selectedClosure.countedAmount)}</Text>
                </View>
                <View style={styles.lineRow}>
                  <Text style={styles.lineLabel}>Diferencia</Text>
                  <Text
                    style={[
                      styles.lineValue,
                      {
                        color:
                          selectedClosure.difference === 0
                            ? ui.success
                            : selectedClosure.difference > 0
                              ? ui.primary
                              : ui.danger,
                      },
                    ]}
                  >
                    {selectedClosure.difference >= 0 ? '+' : ''}
                    {formatPEN(selectedClosure.difference)}
                  </Text>
                </View>
                {selectedClosure.computed && (
                  <>
                    <View style={styles.divider} />
                    <View style={styles.lineRow}>
                      <Text style={styles.lineLabel}>Ventas Totales Turno</Text>
                      <Text style={styles.lineValue}>
                        {formatPEN(selectedClosure.computed.totalSales || 0)}
                      </Text>
                    </View>
                    <View style={styles.lineRow}>
                      <Text style={styles.lineLabel}>Ventas Efectivo</Text>
                      <Text style={styles.lineValue}>
                        {formatPEN(selectedClosure.computed.cashSalesOnly || 0)}
                      </Text>
                    </View>
                    <View style={styles.lineRow}>
                      <Text style={styles.lineLabel}>Ventas Tarjeta</Text>
                      <Text style={styles.lineValue}>
                        {formatPEN(selectedClosure.computed.cardSalesOnly || 0)}
                      </Text>
                    </View>
                    <View style={styles.lineRow}>
                      <Text style={styles.lineLabel}>Yape / Plin</Text>
                      <Text style={styles.lineValue}>
                        {formatPEN(
                          (selectedClosure.computed.yapeSalesOnly || 0) +
                            (selectedClosure.computed.plinSalesOnly || 0)
                        )}
                      </Text>
                    </View>
                    <View style={styles.lineRow}>
                      <Text style={styles.lineLabel}>Ingresos / Egresos Caja</Text>
                      <Text style={styles.lineValue}>
                        +{formatPEN(selectedClosure.computed.cashIncomes || 0)} / -
                        {formatPEN(selectedClosure.computed.cashWithdrawals || 0)}
                      </Text>
                    </View>
                  </>
                )}
                {selectedClosure.notes ? (
                  <Text style={styles.mutedText}>Notas: {selectedClosure.notes}</Text>
                ) : null}
              </ScrollView>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
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
  controlsBar: {
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    paddingTop: 10,
    gap: 10,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: ui.surfaceMuted,
  },
  pillActive: {
    backgroundColor: ui.primarySoft,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  pillTextActive: {
    color: ui.primary,
  },
  tabsRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  tabItem: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
  },
  tabItemActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  tabTextActive: {
    color: ui.onPrimary,
  },
  scrollContent: {
    padding: 14,
    gap: 12,
    paddingBottom: 36,
  },
  section: {
    gap: 12,
  },
  exportRow: {
    flexDirection: 'row',
    gap: 10,
  },
  exportBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  exportBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  primaryActionBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  primaryActionBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  kpiRow: {
    flexDirection: 'row',
    gap: 10,
  },
  kpiBox: {
    flex: 1,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 14,
    padding: 12,
    gap: 3,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textMuted,
  },
  kpiValue: {
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
  },
  kpiMeta: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  card: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: ui.text,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  subtotalRow: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: ui.border,
    paddingVertical: 8,
    marginVertical: 2,
  },
  lineLabel: {
    flex: 1,
    fontSize: 13,
    color: ui.textSecondary,
  },
  lineValue: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  mutedText: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  metaSmall: {
    fontSize: 11,
    color: ui.textMuted,
  },
  lockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  commissionInput: {
    width: 72,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
  },
  errorCard: {
    backgroundColor: ui.dangerSoft,
    borderRadius: 12,
    padding: 14,
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
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,28,49,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    paddingTop: 18,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  sheetBody: {
    padding: 18,
    gap: 10,
  },
  divider: {
    height: 1,
    backgroundColor: ui.border,
    marginVertical: 4,
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
