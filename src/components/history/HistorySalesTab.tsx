import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import {
  AlertTriangle,
  Barcode,
  CheckCircle2,
  Clock,
  Receipt,
  Search,
  X,
  Zap,
  ZapOff,
} from 'lucide-react-native';

import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useFocusMemo } from '@/hooks/use-focus-memo';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import { resolveReceiptDocumentMeta } from '@/lib/printing/escpos-builder';
import { getHistoryDateBounds, toEpochMillis } from '@/services/crm-compat';
import type { Sale } from '@/types';

import { historyStyles as styles } from './historyStyles';
import {
  EMPTY_PERIOD_KPIS,
  isOfflinePendingSale,
  type DateRange,
  type DocFilter,
  type HistorySale,
  type PeriodKpis,
} from './historyTypes';

const HISTORY_BARCODE_SETTINGS: any = {
  barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e'],
};

const DATE_FILTER_OPTIONS = [
  { id: 'today', label: 'Hoy' },
  { id: 'week', label: '7 días' },
  { id: 'month', label: 'Mes' },
] as const;

const DOC_FILTER_OPTIONS: ReadonlyArray<{ id: DocFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'factura', label: 'Facturas' },
  { id: 'boleta', label: 'Boletas' },
  { id: 'nota_venta', label: 'Notas' },
];

type DocMetaResult = ReturnType<typeof resolveReceiptDocumentMeta>;
const EMPTY_HISTORY_SALES: HistorySale[] = [];

interface DocBadgeProps {
  sale: Sale;
  docMeta?: DocMetaResult;
}

const DocBadge = React.memo<DocBadgeProps>(({ sale, docMeta }) => {
  if (sale.status === 'cancelled') {
    return (
      <View style={[styles.badge, styles.badgeCancelledBg]}>
        <Text style={[styles.badgeText, styles.badgeCancelledText]}>ANULADO</Text>
      </View>
    );
  }

  const meta = docMeta || resolveReceiptDocumentMeta(sale);
  if (meta.isFacturaAccepted) {
    return (
      <View style={[styles.badge, styles.badgeFacturaBg]}>
        <Text style={[styles.badgeText, styles.badgeFacturaText]}>FACTURA</Text>
      </View>
    );
  }

  if (meta.isBoletaDoc) {
    return (
      <View style={[styles.badge, styles.badgeBoletaBg]}>
        <Text style={[styles.badgeText, styles.badgeBoletaText]}>BOLETA</Text>
      </View>
    );
  }

  if (meta.isCreditNote) {
    return (
      <View style={[styles.badge, styles.badgeNoteBg]}>
        <Text style={[styles.badgeText, styles.badgeNoteText]}>NOTA CRÉDITO</Text>
      </View>
    );
  }

  if (meta.isDebitNote) {
    return (
      <View style={[styles.badge, styles.badgeNoteBg]}>
        <Text style={[styles.badgeText, styles.badgeNoteText]}>NOTA DÉBITO</Text>
      </View>
    );
  }

  if (meta.isQuote) {
    return (
      <View style={[styles.badge, styles.badgeMutedBg]}>
        <Text style={[styles.badgeText, styles.badgeMutedText]}>COTIZACIÓN</Text>
      </View>
    );
  }

  return (
    <View style={[styles.badge, styles.badgeMutedBg]}>
      <Text style={[styles.badgeText, styles.badgeMutedText]}>NOTA VENTA</Text>
    </View>
  );
});

const SunatBadge = React.memo<{ sale: Sale }>(({ sale }) => {
  if (isOfflinePendingSale(sale)) {
    return (
      <View style={[styles.miniBadge, styles.miniBadgeWarningBg]}>
        <Clock size={12} color={ui.warning} />
        <Text style={[styles.miniBadgeText, styles.miniBadgeWarningText]}>Pendiente offline</Text>
      </View>
    );
  }
  const status = sale.sunatStatus || 'not_applicable';
  if (status === 'accepted') {
    return (
      <View style={[styles.miniBadge, styles.miniBadgePrimaryBg]}>
        <CheckCircle2 size={12} color={ui.primary} />
        <Text style={[styles.miniBadgeText, styles.miniBadgePrimaryText]}>SUNAT Aceptado</Text>
      </View>
    );
  }
  if (status === 'pending') {
    return (
      <View style={[styles.miniBadge, styles.miniBadgeWarningBg]}>
        <Clock size={12} color={ui.warning} />
        <Text style={[styles.miniBadgeText, styles.miniBadgeWarningText]}>SUNAT Pendiente</Text>
      </View>
    );
  }
  if (status === 'rejected') {
    return (
      <View style={[styles.miniBadge, styles.miniBadgeDangerBg]}>
        <AlertTriangle size={12} color={ui.danger} />
        <Text style={[styles.miniBadgeText, styles.miniBadgeDangerText]}>SUNAT Observado</Text>
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
  const docMeta = resolveReceiptDocumentMeta(sale);
  const docNumber = docMeta.docNumber;
  const handlePress = useCallback(() => onPress(sale), [onPress, sale]);

  return (
    <TouchableOpacity
      style={[styles.saleCard, isCancelled && styles.saleCardCancelled]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Ver comprobante ${docNumber}, ${formatPEN(sale.total)}, ${sale.customerName || 'Cliente General'}${isCancelled ? ', anulada' : ''}`}
    >
      <View style={styles.saleCardTop}>
        <View style={styles.flex1}>
          <View style={styles.saleCardTitleRow}>
            <DocBadge sale={sale} docMeta={docMeta} />
            <Text style={styles.saleDocNumber}>{docNumber}</Text>
          </View>
          <Text style={styles.saleDateText}>{formatDatePE(sale.date || (sale as any).createdAt)}</Text>
        </View>

        <View style={styles.saleCardPriceCol}>
          <Text style={[styles.saleTotalText, isCancelled && styles.saleTotalCancelled]}>
            {formatPEN(sale.total)}
          </Text>
          <Text style={styles.salePaymentMethod}>
            {((sale as any).paymentMethodName || sale.paymentMethod || 'Efectivo').toUpperCase()}
          </Text>
        </View>
      </View>

      <View style={styles.saleCardBottom}>
        <Text style={styles.saleCustomerText} numberOfLines={1}>
          {sale.customerName ? `Cliente: ${sale.customerName}` : 'Cliente General'}
        </Text>
        <SunatBadge sale={sale} />
      </View>
    </TouchableOpacity>
  );
});

interface SalesKpiHeaderProps {
  periodKpis: PeriodKpis;
  dateRange: DateRange;
  customStartDate: string;
  customEndDate: string;
  onSelectDateRange: (range: DateRange) => void;
  onOpenCustomDateModal: () => void;
}

const SalesKpiAndDateHeader = React.memo<SalesKpiHeaderProps>(
  ({
    periodKpis,
    dateRange,
    customStartDate,
    customEndDate,
    onSelectDateRange,
    onOpenCustomDateModal,
  }) => {
    const { width } = useWindowDimensions();
    const compactHero = width < 380;
    const customLabel =
      dateRange === 'custom' && customStartDate && customEndDate
        ? customStartDate.slice(5)
        : 'Pers.';

    return (
      <>
        <View style={styles.summaryWithFiltersRow}>
          <View style={styles.summaryTitleCol}>
            <Text style={styles.summaryTitleText}>Resumen</Text>
            <Text style={styles.summarySubText}>{periodKpis.salesCount} comp.</Text>
          </View>

          <View style={styles.filterChipRowCompact}>
            {DATE_FILTER_OPTIONS.map((item) => {
              const selected = dateRange === item.id;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.rangeChipCompact, selected && styles.rangeChipCompactActive]}
                  onPress={() => onSelectDateRange(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Filtrar por fecha: ${item.label}`}
                  accessibilityState={{ selected }}
                >
                  <Text
                    style={[
                      styles.rangeChipTextCompact,
                      selected && styles.rangeChipTextCompactActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[
                styles.rangeChipCompact,
                dateRange === 'custom' && styles.rangeChipCompactActive,
              ]}
              onPress={onOpenCustomDateModal}
              accessibilityRole="button"
              accessibilityLabel={`Filtrar por fecha: ${customLabel}`}
              accessibilityState={{ selected: dateRange === 'custom' }}
            >
              <Text
                style={[
                  styles.rangeChipTextCompact,
                  dateRange === 'custom' && styles.rangeChipTextCompactActive,
                ]}
              >
                {customLabel}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.kpiContainer}>
          <View style={styles.kpiGrid}>
            <View style={[styles.kpiBox, styles.totalSalesHero]}>
              <View style={styles.totalSalesRow}>
                <View style={styles.totalSalesLeft}>
                  <Text style={styles.kpiBoxLabel}>Ventas totales</Text>
                  <Text
                    style={[
                      styles.kpiBoxValue,
                      styles.totalSalesValue,
                      compactHero && styles.totalSalesValueCompact,
                    ]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {formatPEN(periodKpis.totalSales)}
                  </Text>
                  <Text style={styles.kpiBoxFoot}>En el período seleccionado</Text>
                </View>
                <View style={styles.totalSalesDivider} />
                <View style={styles.totalSalesRight}>
                  <Text style={styles.kpiBoxLabel}>Efectivo / Digital</Text>
                  <Text style={[styles.kpiBoxValue, styles.kpiSplitValue]} numberOfLines={1}>
                    {periodKpis.cashPercent}% / {periodKpis.digitalPercent}%
                  </Text>
                  <Text style={styles.kpiBoxFoot} numberOfLines={1}>
                    {formatPEN(periodKpis.cashSales)} / {formatPEN(periodKpis.digitalSales)}
                  </Text>
                </View>
              </View>
            </View>

            <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
              <Text style={styles.kpiBoxLabel}>Ganancia bruta</Text>
              <Text style={[styles.kpiBoxValue, styles.kpiProfitValue]}>
                {formatPEN(periodKpis.grossProfit)}
              </Text>
              <Text style={styles.kpiBoxFoot}>Margen estimado</Text>
            </View>

            <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
              <Text style={styles.kpiBoxLabel}>Ticket promedio</Text>
              <Text style={[styles.kpiBoxValue, styles.kpiAvgValue]}>
                {formatPEN(periodKpis.avgTicket)}
              </Text>
              <Text style={styles.kpiBoxFoot}>Por venta</Text>
            </View>
          </View>
        </View>
      </>
    );
  }
);

interface ScannedSearchTrigger {
  value: string;
  seq: number;
}

interface SalesSearchBarProps {
  defaultQuery: string;
  inlineScannerActive: boolean;
  scannedTrigger: ScannedSearchTrigger | null;
  onDebouncedQueryChange: (query: string) => void;
  onSearchTextChange?: (query: string) => void;
  onToggleScanner: () => void;
}

const SalesSearchBar = React.memo<SalesSearchBarProps>(
  ({
    defaultQuery,
    inlineScannerActive,
    scannedTrigger,
    onDebouncedQueryChange,
    onSearchTextChange,
    onToggleScanner,
  }) => {
    const [localQuery, setLocalQuery] = useState(defaultQuery);
    const debouncedLocalQuery = useDebouncedValue(localQuery, 150);
    const lastEmittedRef = useRef(defaultQuery);
    const lastScanSeqRef = useRef(0);

    const handleChangeText = useCallback(
      (text: string) => {
        setLocalQuery(text);
        onSearchTextChange?.(text);
      },
      [onSearchTextChange]
    );

    const handleClear = useCallback(() => {
      setLocalQuery('');
      onSearchTextChange?.('');
    }, [onSearchTextChange]);

    useEffect(() => {
      if (debouncedLocalQuery === lastEmittedRef.current) return;
      lastEmittedRef.current = debouncedLocalQuery;
      onDebouncedQueryChange(debouncedLocalQuery);
    }, [debouncedLocalQuery, onDebouncedQueryChange]);

    useEffect(() => {
      if (!scannedTrigger || scannedTrigger.seq === lastScanSeqRef.current) return;
      lastScanSeqRef.current = scannedTrigger.seq;
      const clean = scannedTrigger.value;
      setLocalQuery(clean);
      onSearchTextChange?.(clean);
      lastEmittedRef.current = clean;
      onDebouncedQueryChange(clean);
    }, [scannedTrigger, onDebouncedQueryChange, onSearchTextChange]);

    return (
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Search size={18} color={ui.textMuted} />
          <TextInput
            style={styles.searchInput}
            accessibilityLabel="Buscar comprobantes por número, cliente o DNI/RUC"
            placeholder="Buscar por N°, cliente o DNI/RUC..."
            placeholderTextColor={ui.textMuted}
            value={localQuery}
            onChangeText={handleChangeText}
          />
          {localQuery.length > 0 && (
            <TouchableOpacity
              onPress={handleClear}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Limpiar búsqueda"
            >
              <X size={16} color={ui.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          style={[styles.barcodeScanBtn, inlineScannerActive && styles.barcodeScanBtnActive]}
          onPress={onToggleScanner}
          accessibilityRole="button"
          accessibilityLabel="Escanear ticket o comprobante"
          activeOpacity={0.7}
        >
          <Barcode size={20} color={inlineScannerActive ? ui.onPrimary : ui.primary} />
        </TouchableOpacity>
      </View>
    );
  }
);

interface SalesListHeaderProps {
  periodKpis: PeriodKpis;
  dateRange: DateRange;
  customStartDate: string;
  customEndDate: string;
  defaultQuery: string;
  scannedTrigger: ScannedSearchTrigger | null;
  inlineScannerActive: boolean;
  inlineTorchOn: boolean;
  isFocused: boolean;
  invoicingEnabled: boolean;
  docFilter: DocFilter;
  onSelectDateRange: (range: DateRange) => void;
  onOpenCustomDateModal: () => void;
  onDebouncedQueryChange: (query: string) => void;
  onSearchTextChange?: (query: string) => void;
  onToggleScanner: () => void;
  onToggleTorch: () => void;
  onCloseScanner: () => void;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
  onSelectDocFilter: (filter: DocFilter) => void;
}

const SalesListHeader = React.memo<SalesListHeaderProps>(
  ({
    periodKpis,
    dateRange,
    customStartDate,
    customEndDate,
    defaultQuery,
    scannedTrigger,
    inlineScannerActive,
    inlineTorchOn,
    isFocused,
    invoicingEnabled,
    docFilter,
    onSelectDateRange,
    onOpenCustomDateModal,
    onDebouncedQueryChange,
    onSearchTextChange,
    onToggleScanner,
    onToggleTorch,
    onCloseScanner,
    onBarcodeScanned,
    onSelectDocFilter,
  }) => (
    <>
      <SalesKpiAndDateHeader
        periodKpis={periodKpis}
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onSelectDateRange={onSelectDateRange}
        onOpenCustomDateModal={onOpenCustomDateModal}
      />

      <SalesSearchBar
        defaultQuery={defaultQuery}
        inlineScannerActive={inlineScannerActive}
        scannedTrigger={scannedTrigger}
        onDebouncedQueryChange={onDebouncedQueryChange}
        onSearchTextChange={onSearchTextChange}
        onToggleScanner={onToggleScanner}
      />

      {inlineScannerActive && isFocused && (
        <View style={styles.inlineScannerCard}>
          <View style={styles.inlineScannerTopBar}>
            <View style={styles.inlineScannerTitleWrap}>
              <Barcode size={16} color={ui.primary} />
              <Text style={styles.inlineScannerTitle}>Lector de Tickets</Text>
            </View>
            <View style={styles.inlineScannerActions}>
              <TouchableOpacity
                style={[
                  styles.inlineScannerActionBtn,
                  inlineTorchOn && styles.inlineScannerActionBtnActive,
                ]}
                onPress={onToggleTorch}
                accessibilityRole="button"
                accessibilityLabel="Alternar linterna"
              >
                {inlineTorchOn ? (
                  <ZapOff size={14} color={ui.onPrimary} />
                ) : (
                  <Zap size={14} color={ui.textSecondary} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.inlineScannerActionBtn}
                onPress={onCloseScanner}
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
              barcodeScannerSettings={HISTORY_BARCODE_SETTINGS}
              onBarcodeScanned={onBarcodeScanned}
            />
            <View style={styles.inlineReticle} />
            <View style={styles.inlineScanBanner}>
              <Text style={styles.inlineScanBannerText}>
                Apunta la cámara al código del comprobante
              </Text>
            </View>
          </View>
        </View>
      )}

      {invoicingEnabled ? (
        <View style={styles.docFilterRow}>
          {DOC_FILTER_OPTIONS.map((d) => {
            const selected = docFilter === d.id;
            return (
              <TouchableOpacity
                key={d.id}
                style={[styles.docChip, selected && styles.docChipActive]}
                onPress={() => onSelectDocFilter(d.id)}
                accessibilityRole="button"
                accessibilityLabel={`Filtrar comprobantes: ${d.label}`}
                accessibilityState={{ selected }}
              >
                <Text style={[styles.docChipText, selected && styles.docChipTextActive]}>
                  {d.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </>
  )
);

export interface HistorySalesTabProps {
  isFocused: boolean;
  isOnline: boolean;
  mergedSales: HistorySale[];
  loadingSales: boolean;
  loadingMoreSales: boolean;
  salesHasMore: boolean;
  dateRange: DateRange;
  customStartDate: string;
  customEndDate: string;
  invoicingEnabled: boolean;
  bottomInset: number;
  defaultSearchQuery?: string;
  defaultDocFilter?: DocFilter;
  onSearchTextChange?: (query: string) => void;
  onDocFilterChange?: (filter: DocFilter) => void;
  onSelectDateRange: (range: DateRange) => void;
  onOpenCustomDateModal: () => void;
  onSelectSale: (sale: Sale) => void;
  onLoadMoreSales: () => void;
}

export const HistorySalesTab = React.memo<HistorySalesTabProps>(
  ({
    isFocused,
    isOnline,
    mergedSales,
    loadingSales,
    loadingMoreSales,
    salesHasMore,
    dateRange,
    customStartDate,
    customEndDate,
    invoicingEnabled,
    bottomInset,
    defaultSearchQuery = '',
    defaultDocFilter = 'all',
    onSearchTextChange,
    onDocFilterChange,
    onSelectDateRange,
    onOpenCustomDateModal,
    onSelectSale,
    onLoadMoreSales,
  }) => {
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(defaultSearchQuery);
    const [docFilter, setDocFilter] = useState<DocFilter>(defaultDocFilter);
    const [scannedTrigger, setScannedTrigger] = useState<ScannedSearchTrigger | null>(null);

    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [inlineScannerActive, setInlineScannerActive] = useState(false);
    const [inlineTorchOn, setInlineTorchOn] = useState(false);
    const scanCooldownRef = useRef(false);
    const scanCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scanSeqRef = useRef(0);

    useEffect(() => {
      if (!isFocused) {
        setInlineScannerActive(false);
        setInlineTorchOn(false);
      }
    }, [isFocused]);

    useEffect(() => {
      return () => {
        if (scanCooldownTimerRef.current) {
          clearTimeout(scanCooldownTimerRef.current);
        }
      };
    }, []);

    const toggleInlineScanner = useCallback(async () => {
      if (!inlineScannerActive) {
        if (!cameraPermission?.granted) {
          const res = await requestCameraPermission();
          if (!res.granted) {
            Alert.alert(
              'Cámara Requerida',
              'Se requiere permiso de cámara para escanear tickets o comprobantes.'
            );
            return;
          }
        }
        setInlineScannerActive(true);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        setInlineScannerActive(false);
        setInlineTorchOn(false);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }, [inlineScannerActive, cameraPermission?.granted, requestCameraPermission]);

    const handleCloseScanner = useCallback(() => {
      setInlineScannerActive(false);
      setInlineTorchOn(false);
    }, []);

    const handleToggleTorch = useCallback(() => {
      setInlineTorchOn((prev) => !prev);
    }, []);

    const handlePressToggleScanner = useCallback(() => {
      void toggleInlineScanner();
    }, [toggleInlineScanner]);

    const handleInlineBarcodeScanned = useCallback((result: BarcodeScanningResult) => {
      const clean = result?.data?.trim();
      if (!clean || scanCooldownRef.current) return;
      scanCooldownRef.current = true;
      if (scanCooldownTimerRef.current) {
        clearTimeout(scanCooldownTimerRef.current);
      }
      scanCooldownTimerRef.current = setTimeout(() => {
        scanCooldownRef.current = false;
        scanCooldownTimerRef.current = null;
      }, 1200);

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      scanSeqRef.current += 1;
      setScannedTrigger({ value: clean, seq: scanSeqRef.current });
    }, []);

    const handleSelectDocFilter = useCallback(
      (next: DocFilter) => {
        setDocFilter(next);
        onDocFilterChange?.(next);
      },
      [onDocFilterChange]
    );

    const effectiveCustomStart = dateRange === 'custom' ? customStartDate : '';
    const effectiveCustomEnd = dateRange === 'custom' ? customEndDate : '';

    const filteredSales = useFocusMemo<HistorySale[]>(
      () => {
        const bounds = getHistoryDateBounds(dateRange, effectiveCustomStart, effectiveCustomEnd);
        const trimmedSearch = debouncedSearchQuery.toLowerCase().trim();

        return mergedSales.filter((sale) => {
          const saleDate = sale._dateMs ?? toEpochMillis(sale.date || (sale as any).createdAt);

          if (bounds.start !== undefined && saleDate < bounds.start) return false;
          if (bounds.end !== undefined && saleDate > bounds.end) return false;

          if (docFilter !== 'all') {
            const docTypeStr = String(sale.documentType || '').toLowerCase();
            if (docFilter === 'factura' && !docTypeStr.includes('factura') && docTypeStr !== '01') {
              return false;
            }
            if (docFilter === 'boleta' && !docTypeStr.includes('boleta') && docTypeStr !== '03') {
              return false;
            }
            if (
              docFilter === 'nota_venta' &&
              (docTypeStr.includes('factura') ||
                docTypeStr === '01' ||
                docTypeStr.includes('boleta') ||
                docTypeStr === '03')
            ) {
              return false;
            }
          }

          if (trimmedSearch.length > 0) {
            const docNum = String(sale.documentNumber || sale.saleNumber || '').toLowerCase();
            const custName = String(sale.customerName || '').toLowerCase();
            const custDoc = String(sale.customerDni || sale.customerRuc || '').toLowerCase();
            if (
              !docNum.includes(trimmedSearch) &&
              !custName.includes(trimmedSearch) &&
              !custDoc.includes(trimmedSearch)
            ) {
              return false;
            }
          }

          return true;
        });
      },
      [
        mergedSales,
        dateRange,
        effectiveCustomStart,
        effectiveCustomEnd,
        docFilter,
        debouncedSearchQuery,
      ],
      isFocused,
      EMPTY_HISTORY_SALES
    );

    const lastPeriodKpisRef = useRef<PeriodKpis>(EMPTY_PERIOD_KPIS);
    const periodKpis = useMemo<PeriodKpis>(() => {
      if (!isFocused) return lastPeriodKpisRef.current;

      let totalSales = 0;
      let totalCost = 0;
      let cashSales = 0;
      let digitalSales = 0;
      let completedCount = 0;

      for (let i = 0; i < filteredSales.length; i += 1) {
        const s = filteredSales[i];
        if (s.status === 'cancelled') continue;

        const total = Number(s.total) || 0;
        totalSales += total;
        completedCount += 1;

        if (s.totalCost) {
          totalCost += s.totalCost;
        } else {
          totalCost += total * 0.7;
        }

        const method = String(s.paymentMethod || '').toLowerCase();
        if (method.includes('efectivo') || method.includes('cash')) {
          cashSales += total;
        } else {
          digitalSales += total;
        }
      }

      const grossProfit = Math.max(0, totalSales - totalCost);
      const avgTicket = completedCount > 0 ? totalSales / completedCount : 0;
      const cashPercent = totalSales > 0 ? Math.round((cashSales / totalSales) * 100) : 0;
      const digitalPercent = totalSales > 0 ? Math.round((digitalSales / totalSales) * 100) : 0;

      const next: PeriodKpis = {
        totalSales: Math.round(totalSales * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        avgTicket: Math.round(avgTicket * 100) / 100,
        cashSales: Math.round(cashSales * 100) / 100,
        digitalSales: Math.round(digitalSales * 100) / 100,
        cashPercent,
        digitalPercent,
        salesCount: completedCount,
      };
      lastPeriodKpisRef.current = next;
      return next;
    }, [isFocused, filteredSales]);

    const renderHistorySaleItem = useCallback(
      ({ item }: { item: Sale }) => <SaleCardItem sale={item} onPress={onSelectSale} />,
      [onSelectSale]
    );

    const saleKeyExtractor = useCallback(
      (item: Sale) => item.id || (item as any).offlineId || '',
      []
    );
    const saleItemType = useCallback(() => 'sale', []);

    const handleSalesEndReached = useCallback(() => {
      if (salesHasMore && !loadingSales && !loadingMoreSales) {
        onLoadMoreSales();
      }
    }, [salesHasMore, loadingSales, loadingMoreSales, onLoadMoreSales]);

    const salesListContentStyle = useMemo(
      () => ({ paddingHorizontal: 20, paddingTop: 12, paddingBottom: bottomInset + 80 }),
      [bottomInset]
    );

    const listHeaderElement = useMemo(
      () => (
        <SalesListHeader
          periodKpis={periodKpis}
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
          defaultQuery={defaultSearchQuery}
          scannedTrigger={scannedTrigger}
          inlineScannerActive={inlineScannerActive}
          inlineTorchOn={inlineTorchOn}
          isFocused={isFocused}
          invoicingEnabled={invoicingEnabled}
          docFilter={docFilter}
          onSelectDateRange={onSelectDateRange}
          onOpenCustomDateModal={onOpenCustomDateModal}
          onDebouncedQueryChange={setDebouncedSearchQuery}
          onSearchTextChange={onSearchTextChange}
          onToggleScanner={handlePressToggleScanner}
          onToggleTorch={handleToggleTorch}
          onCloseScanner={handleCloseScanner}
          onBarcodeScanned={handleInlineBarcodeScanned}
          onSelectDocFilter={handleSelectDocFilter}
        />
      ),
      [
        periodKpis,
        dateRange,
        customStartDate,
        customEndDate,
        defaultSearchQuery,
        scannedTrigger,
        inlineScannerActive,
        inlineTorchOn,
        isFocused,
        invoicingEnabled,
        docFilter,
        onSelectDateRange,
        onOpenCustomDateModal,
        onSearchTextChange,
        handlePressToggleScanner,
        handleToggleTorch,
        handleCloseScanner,
        handleInlineBarcodeScanned,
        handleSelectDocFilter,
      ]
    );

    const listEmptyElement = useMemo(
      () =>
        loadingSales && isOnline ? (
          <ActivityIndicator color={ui.primary} style={styles.listLoader} />
        ) : (
          <View style={styles.emptyContainer}>
            <Receipt size={44} color={ui.textMuted} />
            <Text style={styles.emptyTitle}>
              {mergedSales.length === 0
                ? 'Aún no hay comprobantes'
                : 'Sin ventas con estos filtros'}
            </Text>
            <Text style={styles.emptySub}>
              {mergedSales.length === 0
                ? 'Las ventas registradas aparecerán aquí.'
                : 'Prueba otro periodo, tipo de comprobante o búsqueda.'}
            </Text>
          </View>
        ),
      [loadingSales, isOnline, mergedSales.length]
    );

    const listFooterElement = useMemo(
      () =>
        salesHasMore && !loadingSales ? (
          <TouchableOpacity
            style={[styles.confirmCancelBtn, styles.loadMoreSalesBtn]}
            onPress={onLoadMoreSales}
            disabled={loadingMoreSales}
          >
            {loadingMoreSales ? (
              <ActivityIndicator color={ui.onPrimary} />
            ) : (
              <Text style={styles.confirmCancelBtnText}>Cargar más ventas</Text>
            )}
          </TouchableOpacity>
        ) : null,
      [salesHasMore, loadingSales, loadingMoreSales, onLoadMoreSales]
    );

    return (
      <View style={styles.flex1}>
        <FlashList
          data={loadingSales && isOnline ? [] : filteredSales}
          renderItem={renderHistorySaleItem}
          keyExtractor={saleKeyExtractor}
          getItemType={saleItemType}
          estimatedItemSize={94}
          contentContainerStyle={salesListContentStyle}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onEndReachedThreshold={0.4}
          onEndReached={handleSalesEndReached}
          ListHeaderComponent={listHeaderElement}
          ListEmptyComponent={listEmptyElement}
          ListFooterComponent={listFooterElement}
        />
      </View>
    );
  }
);
