/**
 * Ventify Mobile - Executive Financial Intelligence & P&L Modal
 * 
 * Componente modal ejecutivo de Estado de Resultados (Profit & Loss).
 * Muestra cascada financiera devengada, márgenes brutos y netos,
 * desglose visual de métodos de pago, ranking de rentabilidad de productos,
 * desempeño de vendedores y exportación nativa a PDF (WhatsApp / Correo).
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  X,
  Share2,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  DollarSign,
  CreditCard,
  Smartphone,
  Banknote,
  Users,
  Award,
  FileText,
  Calendar,
  ChevronDown,
  ChevronUp,
  Package,
  ArrowDownRight,
  ArrowUpRight,
} from 'lucide-react-native';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { ui, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading } from '@/components/ui';
import {
  generatePnlReport,
  exportPnlReportPDF,
  getPeriodRange,
  PnlPeriodType,
  PnlReportResult,
  TopProductMetric,
} from '@/services/pnl-report-service';

export interface FinancialPnlModalProps {
  visible: boolean;
  onClose: () => void;
  initialPeriod?: PnlPeriodType;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const FinancialPnlModal: React.FC<FinancialPnlModalProps> = ({
  visible,
  onClose,
  initialPeriod = 'today',
}) => {
  const insets = useSafeAreaInsets();
  const { accountId, branchId } = useAuth();
  const { businessData, activeBranchName, businessSettings } = useSettings();
  const { products } = useProducts();

  // Estados de control
  const [selectedPeriod, setSelectedPeriod] = useState<PnlPeriodType>(initialPeriod);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [report, setReport] = useState<PnlReportResult | null>(null);
  const [productRankingSort, setProductRankingSort] = useState<'profit' | 'revenue'>('profit');
  const [showExpenseDetails, setShowExpenseDetails] = useState(false);

  // Mapa de productos indexado por ID para lookup instantáneo de costos
  const productsMap = useMemo(() => {
    const map = new Map();
    if (Array.isArray(products)) {
      products.forEach((p) => {
        if (p && p.id) map.set(p.id, p);
      });
    }
    return map;
  }, [products]);

  // Nombre de empresa y sucursal resueltos
  const businessName =
    businessSettings?.businessName ||
    (businessData as any)?.businessName ||
    (businessData as any)?.name ||
    'Mi Negocio';
  const branchName = activeBranchName || 'Sucursal Principal';

  // Carga y cálculo del reporte P&L
  const loadReport = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const { startDate, endDate } = getPeriodRange(selectedPeriod);
      const result = await generatePnlReport({
        accountId,
        branchId: branchId && branchId !== 'all' ? branchId : undefined,
        startDate,
        endDate,
        productsMap,
      });
      setReport(result);
    } catch (err: any) {
      console.error('[FinancialPnlModal] Error generando reporte:', err);
      Alert.alert(
        'Error de Cálculo',
        'No se pudo generar el Estado de Resultados. Por favor verifique su conexión.'
      );
    } finally {
      setLoading(false);
    }
  }, [accountId, branchId, selectedPeriod, productsMap]);

  useEffect(() => {
    if (visible) {
      loadReport();
    }
  }, [visible, loadReport]);

  // Manejo de cambio de período
  const handleSelectPeriod = (period: PnlPeriodType) => {
    if (period === selectedPeriod) return;
    Haptics.selectionAsync();
    setSelectedPeriod(period);
  };

  // Exportar / Compartir PDF
  const handleExportPDF = async () => {
    if (!report) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setExporting(true);
    try {
      const { label } = getPeriodRange(selectedPeriod);
      await exportPnlReportPDF(report, businessName, branchName, label);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      console.error('[FinancialPnlModal] Error exportando PDF:', err);
      Alert.alert('Error de Exportación', err?.message || 'No se pudo generar el archivo PDF.');
    } finally {
      setExporting(false);
    }
  };

  const periodRangeInfo = useMemo(() => getPeriodRange(selectedPeriod), [selectedPeriod]);
  const isProfitable = (report?.netProfit ?? 0) >= 0;

  // Lista de métodos de pago ordenada para la barra de proporción
  const paymentMethodsBarList = useMemo(() => {
    if (!report || report.paymentBreakdown.total <= 0) return [];
    return [
      { key: 'cash', label: 'Efectivo', color: ui.success, ...report.paymentBreakdown.cash },
      { key: 'yape', label: 'Yape', color: ui.accent, ...report.paymentBreakdown.yape },
      { key: 'plin', label: 'Plin', color: ui.primary, ...report.paymentBreakdown.plin },
      { key: 'card', label: 'Tarjeta', color: ui.primary, ...report.paymentBreakdown.card },
      { key: 'transfer', label: 'Transfer.', color: ui.warning, ...report.paymentBreakdown.transfer },
      { key: 'fiado', label: 'Fiado', color: ui.accent, ...report.paymentBreakdown.fiado },
      { key: 'other', label: 'Otros', color: ui.textMuted, ...report.paymentBreakdown.other },
    ].filter((m) => m.amount > 0);
  }, [report]);

  // Lista de productos para el ranking según el criterio seleccionado
  const topProductsList: TopProductMetric[] = useMemo(() => {
    if (!report) return [];
    return productRankingSort === 'profit'
      ? report.topProductsByProfit
      : report.topProductsByRevenue;
  }, [report, productRankingSort]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={[styles.container, { paddingTop: Math.max(insets.top, 16) }]}>
        {/* ================================================================= */}
        {/* CABECERA SUPERIOR EJECUTIVA                                       */}
        {/* ================================================================= */}
        <ScreenHeading
          title="Estado de resultados"
          subtitle={`${branchName} · ${periodRangeInfo.label}`}
          action={<View style={styles.headerActionsRow}>
            {/* Botón Refrescar */}
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                loadReport();
              }}
              style={styles.headerBtn}
              activeOpacity={0.7}
              disabled={loading}
            >
              <RefreshCw
                size={18}
                color={loading ? ui.primary : ui.textSecondary}
              />
            </TouchableOpacity>

            {/* Botón Exportar PDF Superior */}
            <TouchableOpacity
              onPress={handleExportPDF}
              style={[styles.headerBtn, styles.headerExportBtn]}
              activeOpacity={0.7}
              disabled={exporting || loading || !report}
            >
              {exporting ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <Share2 size={18} color={ui.primary} />
              )}
            </TouchableOpacity>

            {/* Botón Cerrar */}
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Cerrar estado de resultados"
            >
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>}
        />

        {/* ================================================================= */}
        {/* SELECTOR DE PERÍODO (SEGMENTED CONTROL)                          */}
        {/* ================================================================= */}
        <View style={styles.periodSelectorWrapper}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.periodSelectorContent}
          >
            {(['today', 'last_7_days', 'this_month', 'last_30_days'] as PnlPeriodType[]).map(
              (period) => {
                const isSelected = selectedPeriod === period;
                const { label } = getPeriodRange(period);
                return (
                  <TouchableOpacity
                    key={period}
                    onPress={() => handleSelectPeriod(period)}
                    style={[
                      styles.periodChip,
                      isSelected && styles.periodChipActive,
                    ]}
                    activeOpacity={0.8}
                  >
                    <Calendar
                      size={13}
                      color={isSelected ? ui.onPrimary : ui.textMuted}
                      style={{ marginRight: 5 }}
                    />
                    <Text
                      style={[
                        styles.periodChipText,
                        isSelected && styles.periodChipTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              }
            )}
          </ScrollView>
        </View>

        {/* ================================================================= */}
        {/* CUERPO PRINCIPAL SCROLLABLE                                      */}
        {/* ================================================================= */}
        {loading && !report ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.loadingText}>Calculando Estado de Resultados...</Text>
            <Text style={styles.loadingSubtext}>
              Analizando ventas devengadas, costo de inventario y gastos de caja
            </Text>
          </View>
        ) : (
          <ScrollView
            style={styles.scrollBody}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: Math.max(insets.bottom, 24) + 80 },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {report && (
              <>
                {/* 1. HERO CARD: UTILIDAD NETA REAL (BENEFICIO FINAL) */}
                <View
                  style={[
                    styles.heroCard,
                    isProfitable ? styles.heroCardPositive : styles.heroCardNegative,
                  ]}
                >
                  <View style={styles.heroTopRow}>
                    <View>
                      <Text style={styles.heroLabel}>UTILIDAD NETA REAL (BENEFICIO)</Text>
                      <Text
                        style={[
                          styles.heroAmount,
                          { color: isProfitable ? ui.success : ui.danger },
                        ]}
                      >
                        {formatPEN(report.netProfit)}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.heroMarginBadge,
                        {
                          backgroundColor: isProfitable
                            ? ui.successSoft
                            : ui.dangerSoft,
                        },
                      ]}
                    >
                      {isProfitable ? (
                        <ArrowUpRight size={14} color={ui.primary} />
                      ) : (
                        <ArrowDownRight size={14} color={ui.danger} />
                      )}
                      <Text
                        style={[
                          styles.heroMarginText,
                          { color: isProfitable ? ui.success : ui.danger },
                        ]}
                      >
                        {report.netMarginPercent >= 0 ? '+' : ''}
                        {report.netMarginPercent.toFixed(1)}%
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.heroSubDescription}>
                    {isProfitable
                      ? 'Margen operativo saludable descontando costo de mercadería y egresos.'
                      : 'Atención: los costos de mercadería y gastos superan los ingresos netos.'}
                  </Text>

                  {/* Micro KPI Row */}
                  <View style={styles.heroMetricsGrid}>
                    <View style={styles.heroMetricCol}>
                      <Text style={styles.heroMetricColLabel}>Ingresos Netos</Text>
                      <Text style={styles.heroMetricColValue}>
                        {formatPEN(report.netRevenue)}
                      </Text>
                      <Text style={styles.heroMetricColSub}>
                        {report.transactionCount} transacciones
                      </Text>
                    </View>

                    <View style={styles.heroMetricDivider} />

                    <View style={styles.heroMetricCol}>
                      <Text style={styles.heroMetricColLabel}>Costo Ventas (CMV)</Text>
                      <Text style={[styles.heroMetricColValue, { color: ui.danger }]}>
                        {formatPEN(report.cogs)}
                      </Text>
                      <Text style={styles.heroMetricColSub}>
                        {report.netRevenue > 0
                          ? ((report.cogs / report.netRevenue) * 100).toFixed(1)
                          : '0.0'}
                        % de ventas
                      </Text>
                    </View>

                    <View style={styles.heroMetricDivider} />

                    <View style={styles.heroMetricCol}>
                      <Text style={styles.heroMetricColLabel}>Gastos Operativos</Text>
                      <Text style={[styles.heroMetricColValue, { color: ui.warning }]}>
                        {formatPEN(report.operatingExpenses)}
                      </Text>
                      <Text style={styles.heroMetricColSub}>Caja + Planilla</Text>
                    </View>
                  </View>
                </View>

                {/* 2. CASCADA DE ESTADO DE RESULTADOS (P&L WATERFALL) */}
                <View style={styles.sectionCard}>
                  <View style={styles.sectionHeader}>
                    <View style={styles.sectionHeaderTitleRow}>
                      <FileText size={18} color={ui.primary} />
                      <Text style={styles.sectionTitle}>Cascada P&L Contable</Text>
                    </View>
                    <Text style={styles.sectionHeaderHint}>Método Devengado</Text>
                  </View>

                  <View style={styles.waterfallContainer}>
                    {/* Línea 1: Ventas Brutas */}
                    <View style={styles.waterfallRow}>
                      <View style={styles.waterfallLabelCol}>
                        <Text style={styles.waterfallSign}>+</Text>
                        <Text style={styles.waterfallLabel}>Ventas Brutas Totales</Text>
                      </View>
                      <Text style={styles.waterfallValue}>{formatPEN(report.grossSales)}</Text>
                    </View>

                    {/* Línea 2: Devoluciones / Anuladas */}
                    <View style={styles.waterfallRow}>
                      <View style={styles.waterfallLabelCol}>
                        <Text style={[styles.waterfallSign, { color: ui.danger }]}>-</Text>
                        <Text style={[styles.waterfallLabel, { color: ui.textSecondary }]}>
                          Devoluciones y Ventas Anuladas
                        </Text>
                      </View>
                      <Text style={[styles.waterfallValue, { color: ui.danger }]}>
                        -{formatPEN(report.cancelledOrRefunded)}
                      </Text>
                    </View>

                    {/* Línea 3: Subtotal Ingresos Netos */}
                    <View style={[styles.waterfallRow, styles.waterfallRowSubtotal]}>
                      <View style={styles.waterfallLabelCol}>
                        <Text style={[styles.waterfallSign, { color: ui.success }]}>=</Text>
                        <Text style={styles.waterfallLabelBold}>INGRESOS NETOS EFECTIVOS</Text>
                      </View>
                      <Text style={styles.waterfallValueBold}>
                        {formatPEN(report.netRevenue)}
                      </Text>
                    </View>

                    {/* Línea 4: Costo de Ventas (COGS) */}
                    <View style={styles.waterfallRow}>
                      <View style={styles.waterfallLabelCol}>
                        <Text style={[styles.waterfallSign, { color: ui.danger }]}>-</Text>
                        <View>
                          <Text style={styles.waterfallLabel}>Costo de Mercadería (COGS / CMV)</Text>
                          <Text style={styles.waterfallSubLabel}>
                            Stock vendido valorizado al costo
                          </Text>
                        </View>
                      </View>
                      <Text style={[styles.waterfallValue, { color: ui.danger }]}>
                        -{formatPEN(report.cogs)}
                      </Text>
                    </View>

                    {/* Línea 5: Utilidad Bruta */}
                    <View style={[styles.waterfallRow, styles.waterfallRowGross]}>
                      <View style={styles.waterfallLabelCol}>
                        <Text style={[styles.waterfallSign, { color: ui.success }]}>=</Text>
                        <View>
                          <Text style={[styles.waterfallLabelBold, { color: ui.success }]}>
                            UTILIDAD BRUTA
                          </Text>
                          <Text style={styles.waterfallSubLabelGreen}>
                            Margen Bruto: {report.grossMarginPercent.toFixed(1)}%
                          </Text>
                        </View>
                      </View>
                      <Text style={[styles.waterfallValueBold, { color: ui.success }]}>
                        {formatPEN(report.grossProfit)}
                      </Text>
                    </View>

                    {/* Línea 6: Gastos Operativos */}
                    <TouchableOpacity
                      onPress={() => {
                        Haptics.selectionAsync();
                        setShowExpenseDetails(!showExpenseDetails);
                      }}
                      style={[styles.waterfallRow, { paddingVertical: 10 }]}
                      activeOpacity={0.7}
                    >
                      <View style={styles.waterfallLabelCol}>
                        <Text style={[styles.waterfallSign, { color: ui.danger }]}>-</Text>
                        <View>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={styles.waterfallLabel}>Gastos Operativos</Text>
                            {showExpenseDetails ? (
                              <ChevronUp size={14} color={ui.textMuted} style={{ marginLeft: 4 }} />
                            ) : (
                              <ChevronDown size={14} color={ui.textMuted} style={{ marginLeft: 4 }} />
                            )}
                          </View>
                          <Text style={styles.waterfallSubLabel}>
                            Caja chica: {formatPEN(report.pettyCashExpenses)} • Planilla:{' '}
                            {formatPEN(report.payrollExpenses)}
                          </Text>
                        </View>
                      </View>
                      <Text style={[styles.waterfallValue, { color: ui.danger }]}>
                        -{formatPEN(report.operatingExpenses)}
                      </Text>
                    </TouchableOpacity>

                    {/* Acordeón de desglose de gastos */}
                    {showExpenseDetails && (
                      <View style={styles.expenseBreakdownBox}>
                        <Text style={styles.expenseBreakdownBoxTitle}>
                          Desglose de Gastos Operativos ({report.expenseBreakdown.length}{' '}
                          categorías):
                        </Text>
                        {report.expenseBreakdown.length === 0 ? (
                          <Text style={styles.emptyExpenseText}>
                            No se registraron gastos operativos en este período.
                          </Text>
                        ) : (
                          report.expenseBreakdown.map((exp, idx) => (
                            <View key={idx} style={styles.expenseDetailRow}>
                              <View style={styles.expenseDetailLeft}>
                                <Text style={styles.expenseDetailName}>{exp.label}</Text>
                                <View style={styles.expenseBarTrack}>
                                  <View
                                    style={[
                                      styles.expenseBarFill,
                                      { width: `${Math.min(100, exp.percentage)}%` },
                                    ]}
                                  />
                                </View>
                              </View>
                              <View style={styles.expenseDetailRight}>
                                <Text style={styles.expenseDetailAmount}>
                                  {formatPEN(exp.amount)}
                                </Text>
                                <Text style={styles.expenseDetailPercent}>
                                  {exp.percentage.toFixed(1)}%
                                </Text>
                              </View>
                            </View>
                          ))
                        )}
                      </View>
                    )}

                    {/* Línea 7: Utilidad Neta Real */}
                    <View
                      style={[
                        styles.waterfallRow,
                        styles.waterfallRowNet,
                        {
                          borderColor: isProfitable ? ui.success : ui.danger,
                          backgroundColor: isProfitable
                            ? ui.successSoft
                            : ui.dangerSoft,
                        },
                      ]}
                    >
                      <View style={styles.waterfallLabelCol}>
                        <Text
                          style={[
                            styles.waterfallSign,
                            { color: isProfitable ? ui.success : ui.danger },
                          ]}
                        >
                          =
                        </Text>
                        <View>
                          <Text
                            style={[
                              styles.waterfallLabelBold,
                              { color: isProfitable ? ui.success : ui.danger },
                            ]}
                          >
                            UTILIDAD NETA REAL
                          </Text>
                          <Text
                            style={[
                              styles.waterfallSubLabel,
                              { color: isProfitable ? ui.success : ui.danger },
                            ]}
                          >
                            Margen Neto Final: {report.netMarginPercent >= 0 ? '+' : ''}
                            {report.netMarginPercent.toFixed(1)}%
                          </Text>
                        </View>
                      </View>
                      <Text
                        style={[
                          styles.waterfallValueBold,
                          {
                            fontSize: 17,
                            color: isProfitable ? ui.success : ui.danger,
                          },
                        ]}
                      >
                        {formatPEN(report.netProfit)}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* 3. DESGLOSE POR MÉTODO DE PAGO */}
                <View style={styles.sectionCard}>
                  <View style={styles.sectionHeader}>
                    <View style={styles.sectionHeaderTitleRow}>
                      <CreditCard size={18} color={ui.primary} />
                      <Text style={styles.sectionTitle}>Cobranza por Método de Pago</Text>
                    </View>
                    <Text style={styles.sectionHeaderHint}>
                      Total: {formatPEN(report.paymentBreakdown.total)}
                    </Text>
                  </View>

                  {/* Barra Visual Proporcional Multi-Color */}
                  {paymentMethodsBarList.length > 0 ? (
                    <View style={styles.stackedBarContainer}>
                      <View style={styles.stackedBar}>
                        {paymentMethodsBarList.map((m, idx) => (
                          <View
                            key={idx}
                            style={[
                              styles.stackedBarSegment,
                              {
                                backgroundColor: m.color,
                                width: `${Math.max(2, m.percentage)}%`,
                              },
                            ]}
                          />
                        ))}
                      </View>

                      {/* Leyenda y Montos de Métodos */}
                      <View style={styles.paymentMethodsGrid}>
                        {paymentMethodsBarList.map((m, idx) => (
                          <View key={idx} style={styles.paymentMethodCard}>
                            <View style={styles.paymentMethodCardTop}>
                              <View
                                style={[styles.methodDot, { backgroundColor: m.color }]}
                              />
                              <Text style={styles.paymentMethodName}>{m.label}</Text>
                              <Text style={styles.paymentMethodPercentage}>
                                {m.percentage.toFixed(1)}%
                              </Text>
                            </View>
                            <Text style={styles.paymentMethodAmount}>
                              {formatPEN(m.amount)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.emptyText}>
                      No hay transacciones de pago en el período seleccionado.
                    </Text>
                  )}
                </View>

                {/* 4. RANKING DE PRODUCTOS MÁS RENTABLES */}
                <View style={styles.sectionCard}>
                  <View style={styles.sectionHeader}>
                    <View style={styles.sectionHeaderTitleRow}>
                      <Award size={18} color={ui.warning} />
                      <Text style={styles.sectionTitle}>Top Productos</Text>
                    </View>

                    {/* Toggle Sort Criterio */}
                    <View style={styles.sortToggleContainer}>
                      <TouchableOpacity
                        onPress={() => {
                          Haptics.selectionAsync();
                          setProductRankingSort('profit');
                        }}
                        style={[
                          styles.sortToggleBtn,
                          productRankingSort === 'profit' && styles.sortToggleBtnActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.sortToggleBtnText,
                            productRankingSort === 'profit' && styles.sortToggleBtnTextActive,
                          ]}
                        >
                          Ganancia
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => {
                          Haptics.selectionAsync();
                          setProductRankingSort('revenue');
                        }}
                        style={[
                          styles.sortToggleBtn,
                          productRankingSort === 'revenue' && styles.sortToggleBtnActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.sortToggleBtnText,
                            productRankingSort === 'revenue' && styles.sortToggleBtnTextActive,
                          ]}
                        >
                          Ingresos
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {topProductsList.length === 0 ? (
                    <Text style={styles.emptyText}>
                      No hay registros de ventas para ordenar productos.
                    </Text>
                  ) : (
                    <View style={styles.productListContainer}>
                      {topProductsList.map((prod, idx) => {
                        const rankColor =
                          idx === 0 ? ui.warning : idx === 1 ? ui.textMuted : idx === 2 ? ui.warning : ui.textMuted;
                        const isProdProfitable = prod.profit >= 0;

                        return (
                          <View key={prod.productId || idx} style={styles.productRankItem}>
                            <View style={[styles.rankBadge, { borderColor: rankColor }]}>
                              <Text style={[styles.rankBadgeText, { color: rankColor }]}>
                                #{idx + 1}
                              </Text>
                            </View>

                            <View style={styles.productRankInfo}>
                              <Text style={styles.productRankName} numberOfLines={1}>
                                {prod.productName}
                              </Text>
                              <View style={styles.productRankSubRow}>
                                <Text style={styles.productRankQuantity}>
                                  {prod.quantitySold} unid. vendidas
                                </Text>
                                <Text style={styles.productRankBullet}>•</Text>
                                <Text style={styles.productRankRevenue}>
                                  Venta: {formatPEN(prod.revenue)}
                                </Text>
                              </View>
                            </View>

                            <View style={styles.productRankProfitCol}>
                              <Text
                                style={[
                                  styles.productRankProfitValue,
                                  { color: isProdProfitable ? ui.success : ui.danger },
                                ]}
                              >
                                {isProdProfitable ? '+' : ''}
                                {formatPEN(prod.profit)}
                              </Text>
                              <Text style={styles.productRankMarginText}>
                                Margen: {prod.marginPercent.toFixed(1)}%
                              </Text>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>

                {/* 5. RENDIMIENTO POR VENDEDOR / CAJERO */}
                <View style={styles.sectionCard}>
                  <View style={styles.sectionHeader}>
                    <View style={styles.sectionHeaderTitleRow}>
                      <Users size={18} color={ui.accent} />
                      <Text style={styles.sectionTitle}>Rendimiento de Vendedores</Text>
                    </View>
                    <Text style={styles.sectionHeaderHint}>
                      {report.sellerPerformance.length} registrados
                    </Text>
                  </View>

                  {report.sellerPerformance.length === 0 ? (
                    <Text style={styles.emptyText}>
                      No se encontraron registros de vendedores en este período.
                    </Text>
                  ) : (
                    <View style={styles.sellerListContainer}>
                      {report.sellerPerformance.map((seller, idx) => (
                        <View key={seller.sellerId || idx} style={styles.sellerItemCard}>
                          <View style={styles.sellerItemLeft}>
                            <View style={styles.sellerAvatarBadge}>
                              <Text style={styles.sellerAvatarText}>
                                {seller.sellerName.substring(0, 2).toUpperCase()}
                              </Text>
                            </View>
                            <View>
                              <Text style={styles.sellerName} numberOfLines={1}>
                                {seller.sellerName}
                              </Text>
                              <Text style={styles.sellerTransactions}>
                                {seller.transactionsCount}{' '}
                                {seller.transactionsCount === 1 ? 'venta' : 'ventas'}
                              </Text>
                            </View>
                          </View>

                          <View style={styles.sellerItemRight}>
                            <Text style={styles.sellerRevenue}>
                              {formatPEN(seller.revenue)}
                            </Text>
                            <Text style={styles.sellerProfit}>
                              Ganancia: {formatPEN(seller.profit)} ({seller.marginPercent.toFixed(1)}%)
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              </>
            )}
          </ScrollView>
        )}

        {/* ================================================================= */}
        {/* BOTÓN INFERIOR FIJO: EXPORTAR / COMPARTIR REPORTE P&L EN PDF      */}
        {/* ================================================================= */}
        <View style={[styles.bottomActionBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <TouchableOpacity
            onPress={handleExportPDF}
            style={[styles.exportMainBtn, exporting && styles.exportMainBtnDisabled]}
            activeOpacity={0.85}
            disabled={exporting || loading || !report}
          >
            {exporting ? (
              <>
                <ActivityIndicator size="small" color={ui.onPrimary} style={{ marginRight: 8 }} />
                <Text style={styles.exportMainBtnText}>Generando Reporte PDF...</Text>
              </>
            ) : (
              <>
                <Share2 size={20} color={ui.onPrimary} style={{ marginRight: 8 }} />
                <Text style={styles.exportMainBtnText}>
                  Exportar / Compartir Reporte P&L en PDF
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

// ============================================================================
// ESTILOS NATIVOS DARK THEME
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerIconBadge: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: ui.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  headerTextCol: {
    flex: 1,
  },
  headerBrandBadge: {
    alignSelf: 'flex-start',
    backgroundColor: ui.successSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginBottom: 2,
  },
  headerBrandBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: ui.success,
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 1,
  },
  headerActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerExportBtn: {
    backgroundColor: ui.primarySoft,
  },
  closeBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Selector de período
  periodSelectorWrapper: {
    backgroundColor: ui.surface,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  periodSelectorContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  periodChip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    backgroundColor: ui.surfaceMuted,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.border,
  },
  periodChipActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  periodChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  periodChipTextActive: {
    color: ui.onPrimary,
    fontWeight: '700',
  },

  // Estado de Carga
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  loadingText: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
    marginTop: 16,
  },
  loadingSubtext: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
    textAlign: 'center',
    marginTop: 6,
    maxWidth: 280,
  },

  // Contenido Scrollable
  scrollBody: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 18,
    gap: 20,
  },

  // Hero Card
  heroCard: {
    backgroundColor: ui.surface,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  heroCardPositive: {
    borderColor: ui.successSoft,
  },
  heroCardNegative: {
    borderColor: ui.dangerSoft,
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  heroLabel: {
    fontSize: ui.font.small,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  heroAmount: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 4,
  },
  heroMarginBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 3,
  },
  heroMarginText: {
    fontSize: 13,
    fontWeight: '800',
  },
  heroSubDescription: {
    fontSize: 14,
    color: ui.textSecondary,
    marginTop: 6,
    marginBottom: 14,
  },
  heroMetricsGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  heroMetricCol: {
    flex: 1,
    alignItems: 'center',
  },
  heroMetricColLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  heroMetricColValue: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
    marginTop: 2,
  },
  heroMetricColSub: {
    fontSize: 9,
    color: ui.textMuted,
    marginTop: 1,
  },
  heroMetricDivider: {
    width: 1,
    height: 28,
    backgroundColor: ui.border,
  },

  // Tarjetas de Sección
  sectionCard: {
    backgroundColor: ui.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: ui.surfaceMuted,
    padding: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionHeaderTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: ui.font.section,
    fontWeight: '700',
    color: ui.text,
  },
  sectionHeaderHint: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textMuted,
  },

  // Cascada Waterfall
  waterfallContainer: {
    gap: 6,
  },
  waterfallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  waterfallRowSubtotal: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: ui.surfaceMuted,
  },
  waterfallRowGross: {
    backgroundColor: ui.successSoft,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: ui.successSoft,
  },
  waterfallRowNet: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderWidth: 1.5,
    marginTop: 4,
  },
  waterfallLabelCol: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  waterfallSign: {
    fontSize: 14,
    fontWeight: '900',
    color: ui.textSecondary,
    width: 14,
  },
  waterfallLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: ui.textSecondary,
  },
  waterfallLabelBold: {
    fontSize: 12,
    fontWeight: '800',
    color: ui.text,
  },
  waterfallSubLabel: {
    fontSize: 10,
    color: ui.textMuted,
    marginTop: 1,
  },
  waterfallSubLabelGreen: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.success,
    marginTop: 1,
  },
  waterfallValue: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
  },
  waterfallValueBold: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },

  // Acordeón de Gastos
  expenseBreakdownBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 10,
    marginVertical: 4,
    gap: 8,
  },
  expenseBreakdownBoxTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 2,
  },
  expenseDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  expenseDetailLeft: {
    flex: 1,
    marginRight: 12,
  },
  expenseDetailName: {
    fontSize: 11,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  expenseBarTrack: {
    height: 4,
    backgroundColor: ui.border,
    borderRadius: 2,
    marginTop: 3,
    overflow: 'hidden',
  },
  expenseBarFill: {
    height: '100%',
    backgroundColor: ui.danger,
  },
  expenseDetailRight: {
    alignItems: 'flex-end',
  },
  expenseDetailAmount: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.danger,
  },
  expenseDetailPercent: {
    fontSize: 9,
    color: ui.textSecondary,
  },
  emptyExpenseText: {
    fontSize: 11,
    color: ui.textMuted,
    fontStyle: 'italic',
  },

  // Barra Stacked Métodos de Pago
  stackedBarContainer: {
    marginTop: 4,
  },
  stackedBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: ui.surfaceMuted,
    marginBottom: 12,
  },
  stackedBarSegment: {
    height: '100%',
  },
  paymentMethodsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  paymentMethodCard: {
    width: (SCREEN_WIDTH - 32 - 32 - 8) / 2,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 10,
  },
  paymentMethodCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  methodDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  paymentMethodName: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  paymentMethodPercentage: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  paymentMethodAmount: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },

  // Ranking de Productos
  sortToggleContainer: {
    flexDirection: 'row',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    padding: 2,
  },
  sortToggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  sortToggleBtnActive: {
    backgroundColor: ui.border,
  },
  sortToggleBtnText: {
    fontSize: 10,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  sortToggleBtnTextActive: {
    color: ui.text,
    fontWeight: '700',
  },
  productListContainer: {
    gap: 8,
  },
  productRankItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 10,
    gap: 10,
  },
  rankBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surface,
  },
  rankBadgeText: {
    fontSize: 11,
    fontWeight: '900',
  },
  productRankInfo: {
    flex: 1,
  },
  productRankName: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  productRankSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  productRankQuantity: {
    fontSize: 10,
    color: ui.textSecondary,
  },
  productRankBullet: {
    fontSize: 8,
    color: ui.textMuted,
  },
  productRankRevenue: {
    fontSize: 10,
    color: ui.textSecondary,
  },
  productRankProfitCol: {
    alignItems: 'flex-end',
  },
  productRankProfitValue: {
    fontSize: 13,
    fontWeight: '800',
  },
  productRankMarginText: {
    fontSize: 10,
    fontWeight: '600',
    color: ui.textMuted,
    marginTop: 1,
  },

  // Rendimiento de Vendedores
  sellerListContainer: {
    gap: 8,
  },
  sellerItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 10,
  },
  sellerItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  sellerAvatarBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ui.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sellerAvatarText: {
    fontSize: 11,
    fontWeight: '800',
    color: ui.accent,
  },
  sellerName: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  sellerTransactions: {
    fontSize: 10,
    color: ui.textSecondary,
    marginTop: 1,
  },
  sellerItemRight: {
    alignItems: 'flex-end',
  },
  sellerRevenue: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },
  sellerProfit: {
    fontSize: 10,
    fontWeight: '600',
    color: ui.success,
    marginTop: 1,
  },

  // Textos vacíos
  emptyText: {
    fontSize: 12,
    color: ui.textMuted,
    textAlign: 'center',
    paddingVertical: 12,
    fontStyle: 'italic',
  },

  // Barra de Acción Inferior Fija
  bottomActionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: ui.background,
    borderTopWidth: 1,
    borderTopColor: ui.surfaceMuted,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  exportMainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    borderRadius: 14,
    height: 50,
  },
  exportMainBtnDisabled: {
    opacity: 0.6,
  },
  exportMainBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: ui.onPrimary,
    letterSpacing: 0.2,
  },
});
