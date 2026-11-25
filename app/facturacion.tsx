import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Download,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react-native';
import { useAuthSession, usePlanFeatures } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { EinvoiceActionsModal } from '@/components/EinvoiceActionsModal';
import { PlanLockedView } from '@/components/PlanFeatureGate';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import {
  type DateRangePreset,
  downloadAndShareExportFile,
  EINVOICE_STATUS_LABELS,
  EINVOICE_TYPE_LABELS,
  fetchEinvoices,
  getDateRangeBounds,
  summarizeEinvoices,
  type PublicEinvoice,
} from '@/services/dashboard-reports-service';

type TypeFilter = 'all' | '01' | '03' | '07' | '08' | '09';
type StatusFilter = 'all' | 'accepted' | 'pending' | 'rejected' | 'error';

const DOC_TYPE_FILTERS: Array<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: '01', label: '01 Factura' },
  { key: '03', label: '03 Boleta' },
  { key: '07', label: '07 NC' },
  { key: '08', label: '08 ND' },
  { key: '09', label: '09 Guía' },
];

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'accepted', label: 'Aceptados' },
  { key: 'pending', label: 'Pendientes' },
  { key: 'rejected', label: 'Rechazados' },
  { key: 'error', label: 'Error' },
];

const PRESETS: Array<{ key: DateRangePreset; label: string }> = [
  { key: 'today', label: 'Hoy' },
  { key: '7d', label: '7 días' },
  { key: '30d', label: '30 días' },
  { key: 'month', label: 'Este mes' },
];

const getEinvoiceItemType = (item: PublicEinvoice) => {
  const hasCustomer = item.receiptCustomer?.name ? 'c' : '';
  const hasRef = item.reference?.number ? 'r' : '';
  const hasErr =
    (item.status === 'rejected' || item.status === 'error') &&
    (item.lastError || item.cdr?.description)
      ? 'e'
      : '';
  return `inv_${hasCustomer}${hasRef}${hasErr}` || 'inv_base';
};

const ListGap10 = () => <View style={styles.listGap10} />;

interface FacturacionSearchBarProps {
  onSearchChange: (debouncedQuery: string) => void;
}

const FacturacionSearchBar = React.memo<FacturacionSearchBarProps>(({ onSearchChange }) => {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 150);

  useEffect(() => {
    onSearchChange(debouncedQuery);
  }, [debouncedQuery, onSearchChange]);

  return (
    <View style={styles.searchBox}>
      <Search size={16} color={ui.textMuted} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Buscar serie, correlativo, cliente o RUC/DNI..."
        placeholderTextColor={ui.textMuted}
        style={styles.searchInput}
      />
      {query.length > 0 && (
        <TouchableOpacity onPress={() => setQuery('')}>
          <X size={16} color={ui.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
});

interface FacturacionTopFiltersProps {
  invoicingEnabled: boolean;
  preset: DateRangePreset;
  hasAllBranchesAccess: boolean;
  scopeAllBranches: boolean;
  onSelectPreset: (preset: DateRangePreset) => void;
  onToggleScopeAllBranches: () => void;
}

const FacturacionTopFilters = React.memo<FacturacionTopFiltersProps>(
  ({
    invoicingEnabled,
    preset,
    hasAllBranchesAccess,
    scopeAllBranches,
    onSelectPreset,
    onToggleScopeAllBranches,
  }) => (
    <>
      {!invoicingEnabled && (
        <View style={styles.warnBanner}>
          <AlertTriangle size={16} color={ui.warning} />
          <Text style={styles.warnBannerText}>
            Facturación electrónica no activa en la cuenta. Puedes consultar documentos históricos aquí.
          </Text>
        </View>
      )}

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
              onPress={() => onSelectPreset(p.key)}
              style={[styles.pill, active && styles.pillActive]}
            >
              <Text style={[styles.pillText, active && styles.pillTextActive]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
        {hasAllBranchesAccess && (
          <TouchableOpacity
            onPress={onToggleScopeAllBranches}
            style={[styles.pill, scopeAllBranches && styles.pillActive]}
          >
            <Text style={[styles.pillText, scopeAllBranches && styles.pillTextActive]}>
              {scopeAllBranches ? 'Todas las sedes' : 'Solo esta sede'}
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  )
);

interface FacturacionTypeStatusFiltersProps {
  typeFilter: TypeFilter;
  statusFilter: StatusFilter;
  onSelectTypeFilter: (filter: TypeFilter) => void;
  onSelectStatusFilter: (filter: StatusFilter) => void;
}

const FacturacionTypeStatusFilters = React.memo<FacturacionTypeStatusFiltersProps>(
  ({ typeFilter, statusFilter, onSelectTypeFilter, onSelectStatusFilter }) => (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillsRow}
      >
        {DOC_TYPE_FILTERS.map((f) => {
          const active = typeFilter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              onPress={() => onSelectTypeFilter(f.key)}
              style={[styles.pill, active && styles.pillActive]}
            >
              <Text style={[styles.pillText, active && styles.pillTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillsRow}
      >
        {STATUS_FILTERS.map((s) => {
          const active = statusFilter === s.key;
          return (
            <TouchableOpacity
              key={s.key}
              onPress={() => onSelectStatusFilter(s.key)}
              style={[styles.pill, active && styles.pillActive]}
            >
              <Text style={[styles.pillText, active && styles.pillTextActive]}>{s.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </>
  )
);

interface FacturacionSummaryBarProps {
  summary: ReturnType<typeof summarizeEinvoices>;
  canViewReports: boolean;
  exporting: 'csv' | 'xlsx' | null;
  onExport: (format: 'csv' | 'xlsx') => void;
}

const FacturacionSummaryBar = React.memo<FacturacionSummaryBarProps>(
  ({ summary, canViewReports, exporting, onExport }) => (
    <>
      <View style={styles.kpiRow}>
        <View style={styles.kpiBox}>
          <Text style={styles.kpiLabel}>Facturado Neto</Text>
          <Text style={styles.kpiValue}>{formatPEN(summary.totalFacturado)}</Text>
          <Text style={styles.kpiMeta}>
            {summary.facturaCount} Fact. · {summary.boletaCount} Bol.
          </Text>
        </View>
        <View style={styles.kpiBox}>
          <Text style={styles.kpiLabel}>Estado SUNAT</Text>
          <Text style={[styles.kpiValue, { color: ui.success }]}>
            {summary.acceptedCount} acept.
          </Text>
          <Text style={styles.kpiMeta}>
            {summary.pendingCount} pend. · {summary.rejectedOrErrorCount} obs.
          </Text>
        </View>
      </View>

      {canViewReports && (
        <View style={styles.exportRow}>
          <TouchableOpacity
            onPress={() => onExport('csv')}
            disabled={exporting !== null}
            style={styles.exportBtn}
          >
            {exporting === 'csv' ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <Download size={15} color={ui.primary} />
            )}
            <Text style={styles.exportBtnText}>Exportar CSV</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onExport('xlsx')}
            disabled={exporting !== null}
            style={styles.exportBtn}
          >
            {exporting === 'xlsx' ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <Download size={15} color={ui.primary} />
            )}
            <Text style={styles.exportBtnText}>Exportar XLSX</Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  )
);

interface EinvoiceRowProps {
  item: PublicEinvoice;
  onSelect: (item: PublicEinvoice) => void;
}

const EinvoiceRow = React.memo<EinvoiceRowProps>(({ item, onSelect }) => {
  const badgeStyle =
    item.status === 'accepted'
      ? { bg: ui.successSoft, color: ui.success }
      : item.status === 'rejected' || item.status === 'error'
        ? { bg: ui.dangerSoft, color: ui.danger }
        : { bg: ui.warningSoft, color: ui.warning };

  return (
    <TouchableOpacity
      onPress={() => onSelect(item)}
      style={styles.rowCard}
      activeOpacity={0.78}
      accessibilityRole="button"
      accessibilityLabel={`Comprobante ${item.documentNumber}, ${EINVOICE_STATUS_LABELS[item.status] || item.status}`}
    >
      <View style={styles.rowTop}>
        <View style={styles.rowLeft}>
          <View style={styles.typeChip}>
            <Text style={styles.typeChipText}>
              {EINVOICE_TYPE_LABELS[item.documentType] || item.documentType}
            </Text>
          </View>
          <Text style={styles.docNumber}>{item.documentNumber}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: badgeStyle.bg }]}>
          <Text style={[styles.statusBadgeText, { color: badgeStyle.color }]}>
            {EINVOICE_STATUS_LABELS[item.status] || item.status}
          </Text>
        </View>
      </View>

      <View style={styles.rowMiddle}>
        <Text style={styles.rowDate}>{formatDatePE(item.createdAt)}</Text>
        <Text style={styles.rowAmount}>
          {item.documentType === '09' ? 'Guía' : formatPEN(item.amount)}
        </Text>
      </View>

      {item.receiptCustomer?.name ? (
        <Text style={styles.rowSub} numberOfLines={1}>
          {item.receiptCustomer.name} · {item.receiptCustomer.identityNumber}
        </Text>
      ) : null}

      {item.reference?.number ? (
        <Text style={styles.rowSub} numberOfLines={1}>
          Ref: {item.reference.number}
        </Text>
      ) : null}

      {(item.status === 'rejected' || item.status === 'error') &&
      (item.lastError || item.cdr?.description) ? (
        <Text style={[styles.rowSub, { color: ui.danger }]} numberOfLines={2}>
          {item.lastError || item.cdr?.description}
        </Text>
      ) : null}

      <View style={styles.rowFooter}>
        <Text style={styles.rowActionHint}>Tocar para CDR, XML o emitir notas</Text>
        <ChevronRight size={15} color={ui.textMuted} />
      </View>
    </TouchableOpacity>
  );
});

export default function FacturacionScreen() {
  const router = useRouter();
  const { accountId, branchId } = useAuthSession();
  const { activeBranchName, invoicingEnabled, taxProfile } = useBusinessSettings();
  const {
    isOwner,
    isAdmin,
    isManager,
    hasAllBranchesAccess,
    hasPermission,
    canViewReports,
    canCreateCreditNotes,
  } = usePermissions();
  const { features, planName } = usePlanFeatures();

  const canAccessFacturacion =
    hasPermission('access_sales') &&
    (isOwner || isAdmin || isManager || canViewReports || canCreateCreditNotes);

  const [preset, setPreset] = useState<DateRangePreset>('month');
  const [scopeAllBranches, setScopeAllBranches] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [einvoices, setEinvoices] = useState<PublicEinvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEinvoice, setSelectedEinvoice] = useState<PublicEinvoice | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    if (!features.sunatInvoicing && selectedEinvoice) {
      setSelectedEinvoice(null);
    }
  }, [features.sunatInvoicing, selectedEinvoice]);

  const effectiveBranch = useMemo(() => {
    if (features.multiBranch && hasAllBranchesAccess && scopeAllBranches) return undefined;
    return branchId || undefined;
  }, [features.multiBranch, hasAllBranchesAccess, scopeAllBranches, branchId]);

  const bounds = useMemo(() => getDateRangeBounds(preset), [preset]);

  const loadEinvoices = useCallback(
    async (isRefresh = false) => {
      abortRef.current?.abort();
      if (!accountId || !canAccessFacturacion || !features.sunatInvoicing) {
        abortRef.current = null;
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const reqId = ++requestIdRef.current;

      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const docs = await fetchEinvoices(accountId, {
          branchId: effectiveBranch,
          from: bounds.fromIso,
          to: bounds.toIso,
          forceRefresh: isRefresh,
          signal: controller.signal,
        });
        if (!isMountedRef.current || controller.signal.aborted || reqId !== requestIdRef.current) {
          return;
        }
        setEinvoices(docs);
      } catch (err: any) {
        if (
          !isMountedRef.current ||
          controller.signal.aborted ||
          reqId !== requestIdRef.current ||
          err?.code === 'ABORTED' ||
          err?.name === 'AbortError'
        ) {
          return;
        }
        setError(err?.message || 'No se pudieron cargar los comprobantes electrónicos.');
      } finally {
        if (isMountedRef.current && reqId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [accountId, canAccessFacturacion, features.sunatInvoicing, effectiveBranch, bounds.fromIso, bounds.toIso]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    void loadEinvoices();
    return () => {
      abortRef.current?.abort();
    };
  }, [loadEinvoices]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return einvoices.filter((doc) => {
      if (typeFilter !== 'all' && doc.documentType !== typeFilter) return false;
      if (statusFilter !== 'all') {
        if (statusFilter === 'pending') {
          if (doc.status !== 'pending' && doc.status !== 'sending') return false;
        } else if (doc.status !== statusFilter) {
          return false;
        }
      }
      if (q) {
        const num = (doc.documentNumber || '').toLowerCase();
        const custName = (doc.receiptCustomer?.name || '').toLowerCase();
        const custDoc = (doc.receiptCustomer?.identityNumber || '').toLowerCase();
        const saleId = (doc.saleId || '').toLowerCase();
        if (
          !num.includes(q) &&
          !custName.includes(q) &&
          !custDoc.includes(q) &&
          !saleId.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [einvoices, typeFilter, statusFilter, searchQuery]);

  const handleToggleScopeAllBranches = useCallback(() => {
    setScopeAllBranches((v) => !v);
  }, []);

  const handleSelectEinvoice = useCallback((item: PublicEinvoice) => {
    setSelectedEinvoice(item);
  }, []);

  const einvoiceKeyExtractor = useCallback((item: PublicEinvoice) => item.id, []);

  const renderEinvoiceItem = useCallback(
    ({ item }: { item: PublicEinvoice }) => (
      <EinvoiceRow item={item} onSelect={handleSelectEinvoice} />
    ),
    [handleSelectEinvoice]
  );

  const handleCloseEinvoiceModal = useCallback(() => {
    setSelectedEinvoice(null);
  }, []);

  const handleUpdatedEinvoiceModal = useCallback(() => {
    void loadEinvoices(true);
  }, [loadEinvoices]);

  const summary = useMemo(() => summarizeEinvoices(filtered), [filtered]);

  const handleExport = useCallback(
    async (format: 'csv' | 'xlsx') => {
      if (!accountId) return;
      setExporting(format);
      try {
        const params = new URLSearchParams({
          accountId,
          from: bounds.fromIso,
          to: bounds.toIso,
          format,
        });
        if (effectiveBranch) params.set('branchId', effectiveBranch);
        if (typeFilter !== 'all') params.set('type', typeFilter);
        if (statusFilter !== 'all') params.set('status', statusFilter);

        const ext = format === 'xlsx' ? 'xlsx' : 'csv';
        const mime =
          format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'text/csv';
        await downloadAndShareExportFile(
          `/api/invoicing/export?${params.toString()}`,
          `comprobantes_${bounds.fromIso}_${bounds.toIso}.${ext}`,
          mime
        );
      } catch (err: any) {
        Alert.alert('Error al exportar', err?.message || 'No se pudo generar la exportación.');
      } finally {
        setExporting(null);
      }
    },
    [accountId, bounds.fromIso, bounds.toIso, effectiveBranch, typeFilter, statusFilter]
  );

  const handleExportAction = useCallback(
    (format: 'csv' | 'xlsx') => {
      void handleExport(format);
    },
    [handleExport]
  );

  const listHeaderElement = useMemo(
    () => (
      <View style={styles.headerBlock}>
        <FacturacionTopFilters
          invoicingEnabled={invoicingEnabled}
          preset={preset}
          hasAllBranchesAccess={features.multiBranch && hasAllBranchesAccess}
          scopeAllBranches={scopeAllBranches}
          onSelectPreset={setPreset}
          onToggleScopeAllBranches={handleToggleScopeAllBranches}
        />

        <FacturacionSearchBar onSearchChange={setSearchQuery} />

        <FacturacionTypeStatusFilters
          typeFilter={typeFilter}
          statusFilter={statusFilter}
          onSelectTypeFilter={setTypeFilter}
          onSelectStatusFilter={setStatusFilter}
        />

        <FacturacionSummaryBar
          summary={summary}
          canViewReports={canViewReports}
          exporting={exporting}
          onExport={handleExportAction}
        />

        {loading && (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.loadingText}>Consultando comprobantes SUNAT...</Text>
          </View>
        )}

        {!!error && !loading && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => void loadEinvoices()} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    ),
    [
      invoicingEnabled,
      preset,
      features.multiBranch,
      hasAllBranchesAccess,
      scopeAllBranches,
      handleToggleScopeAllBranches,
      typeFilter,
      statusFilter,
      summary,
      canViewReports,
      exporting,
      handleExportAction,
      loading,
      error,
      loadEinvoices,
    ]
  );

  const listEmptyElement = useMemo(
    () =>
      !loading && !error ? (
        <View style={styles.centerBox}>
          <ReceiptText size={32} color={ui.textMuted} />
          <Text style={styles.emptyTitle}>Sin comprobantes en este filtro</Text>
          <Text style={styles.loadingText}>
            Prueba ampliando el rango de fechas o quitando filtros de tipo y estado.
          </Text>
        </View>
      ) : null,
    [loading, error]
  );

  if (!features.sunatInvoicing) {
    return (
      <PlanLockedView
        feature="sunatInvoicing"
        asScreen
        screenTitle="Facturación SUNAT"
        onBack={() => router.back()}
        currentPlanName={planName}
      />
    );
  }

  if (!canAccessFacturacion) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <ArrowLeft size={20} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Facturación SUNAT</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.deniedBox}>
          <ShieldAlert size={36} color={ui.danger} />
          <Text style={styles.deniedTitle}>Acceso restringido</Text>
          <Text style={styles.deniedText}>
            Tu rol actual no tiene permisos para gestionar comprobantes electrónicos SUNAT.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const effectiveTaxRate =
    taxProfile.isAmazonExempt || taxProfile.taxExemptionCode === '20' ? 0 : taxProfile.taxRate || 18;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Volver"
        >
          <ArrowLeft size={20} color={ui.text} />
        </TouchableOpacity>
        <View style={styles.titleCopy}>
          <Text style={styles.topTitle}>Facturación SUNAT</Text>
          <Text style={styles.topSub} numberOfLines={1}>
            {effectiveBranch ? activeBranchName || 'Sucursal activa' : 'Todas las sucursales'} · {bounds.label}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => void loadEinvoices(true)}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Actualizar comprobantes"
        >
          <RefreshCw size={18} color={ui.primary} />
        </TouchableOpacity>
      </View>

      <FlashList
        data={filtered}
        keyExtractor={einvoiceKeyExtractor}
        getItemType={getEinvoiceItemType}
        estimatedItemSize={138}
        ItemSeparatorComponent={ListGap10}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadEinvoices(true)}
            colors={[ui.primary]}
          />
        }
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={listHeaderElement}
        ListEmptyComponent={listEmptyElement}
        renderItem={renderEinvoiceItem}
      />

      {selectedEinvoice && (
        <EinvoiceActionsModal
          visible={Boolean(selectedEinvoice)}
          einvoice={selectedEinvoice}
          allEinvoices={einvoices}
          accountId={accountId || ''}
          taxRate={effectiveTaxRate}
          invoicingEnabled={invoicingEnabled}
          onClose={handleCloseEinvoiceModal}
          onUpdated={handleUpdatedEinvoiceModal}
        />
      )}
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
  backBtn: {
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
  listContent: {
    padding: 14,
    paddingBottom: 32,
  },
  listGap10: {
    height: 10,
  },
  headerBlock: {
    gap: 10,
    marginBottom: 14,
  },
  warnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.warningSoft,
    padding: 12,
    borderRadius: 12,
  },
  warnBannerText: {
    flex: 1,
    fontSize: 12,
    color: ui.warning,
    fontWeight: '600',
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
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: ui.text,
    paddingVertical: 8,
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
  },
  exportBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
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
  rowCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 6,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  typeChip: {
    backgroundColor: ui.surfaceMuted,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  typeChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  docNumber: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  rowMiddle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowDate: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  rowSub: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  rowFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    marginTop: 2,
  },
  rowActionHint: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.primary,
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
