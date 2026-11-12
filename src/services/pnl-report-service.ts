/**
 * Ventify Mobile - Financial Intelligence & Profit & Loss (P&L) Service
 * 
 * Motor de cálculo financiero ejecutivo y generación de Estado de Resultados
 * conforme a estándares contables devengados para negocios peruanos.
 * Genera reportes en PDF ejecutivos vía expo-print y expo-sharing.
 */

import { apiRequest } from '@/lib/api-client';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatPEN, formatDatePE } from '@/lib/theme';
import type { Product } from '@/types';

// ============================================================================
// TIPOS E INTERFACES DEL ESTADO DE RESULTADOS (P&L)
// ============================================================================

export type PnlPeriodType = 'today' | 'last_7_days' | 'this_month' | 'last_30_days';

export interface GeneratePnlReportParams {
  accountId: string;
  branchId?: string; // Si se omite o es 'all', consolida todas las sucursales
  startDate: Date | number | string;
  endDate: Date | number | string;
  productsMap?: Map<string, Product> | Record<string, Product>;
}

export interface PaymentMethodShare {
  amount: number;
  percentage: number; // 0 - 100
}

export interface PaymentBreakdownSummary {
  cash: PaymentMethodShare;
  yape: PaymentMethodShare;
  plin: PaymentMethodShare;
  card: PaymentMethodShare;
  transfer: PaymentMethodShare;
  fiado: PaymentMethodShare;
  other: PaymentMethodShare;
  total: number;
}

export interface TopProductMetric {
  productId: string;
  productName: string;
  sku?: string;
  quantitySold: number;
  revenue: number;
  cogs: number; // Costo de mercadería vendida
  profit: number; // Ganancia bruta aportada (revenue - cogs)
  marginPercent: number; // (profit / revenue) * 100
}

export interface SellerPerformanceMetric {
  sellerId: string;
  sellerName: string;
  transactionsCount: number;
  revenue: number;
  cogs: number;
  profit: number;
  marginPercent: number;
}

export interface ExpenseCategoryBreakdown {
  category: string;
  label: string;
  amount: number;
  percentage: number; // Porcentaje sobre el total de gastos operativos
}

export interface PnlReportResult {
  // Metadatos
  accountId: string;
  branchId?: string;
  startDate: number; // epoch ms
  endDate: number;   // epoch ms
  generatedAt: number;

  // Cascada de Estado de Resultados (P&L Waterfall)
  grossSales: number;           // Ventas brutas totales facturadas
  salesClosed: number;
  cancelledOrRefunded: number;  // Ventas anuladas y devoluciones
  netRevenue: number;           // Ventas netas operativas (grossSales - cancelledOrRefunded)
  transactionCount?: number;

  cogs: number;                 // Costo de Mercadería Vendida (CMV)
  grossProfit: number;          // Utilidad Bruta (netRevenue - cogs)
  grossMarginPercent: number;   // Margen Bruto % ((grossProfit / netRevenue) * 100)

  operatingExpenses: number;    // Gastos Operativos Totales (Caja chica + Planilla)
  pettyCashExpenses?: number;
  payrollExpenses?: number;
  expensesByCategory?: Record<string, number>;
  expenseBreakdown?: ExpenseCategoryBreakdown[];

  netProfit: number;            // Utilidad Neta Real (grossProfit - operatingExpenses)
  netMarginPercent: number;     // Margen Neto % ((netProfit / netRevenue) * 100)

  // Desgloses y Rankings
  paymentBreakdown?: PaymentBreakdownSummary;
  topProductsByRevenue?: TopProductMetric[];
  topProductsByProfit?: TopProductMetric[];
  sellerPerformance?: SellerPerformanceMetric[];
  detailsAvailable: boolean;
  fiadosIssued: number;
  returns: number;
  badDebt: number;
  employeeAdvances: number;
  cashOperatingExpenses: number;
  terminalCommissions: number;
}

// ============================================================================
// HELPERS NUMÉRICOS Y DE FECHA
// ============================================================================

export function roundToCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function requireReportAmount(data: Record<string, any>, field: string): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`El reporte Web no devolvió la métrica financiera "${field}".`);
  }
  return roundToCents(value);
}

export function toMillis(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number') {
    return val < 1e11 ? val * 1000 : val;
  }
  if (typeof val === 'object') {
    if (typeof val.toMillis === 'function') return val.toMillis();
    if (typeof val.toDate === 'function') return val.toDate().getTime();
    if (typeof val.seconds === 'number') {
      return val.seconds * 1000 + (val.nanoseconds ? Math.round(val.nanoseconds / 1e6) : 0);
    }
  }
  if (typeof val === 'string') {
    const parsed = new Date(val).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Retorna las fechas de inicio y fin para los rangos predefinidos
 */
export function getPeriodRange(period: PnlPeriodType): {
  startDate: Date;
  endDate: Date;
  label: string;
} {
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  switch (period) {
    case 'today': {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      return { startDate: startOfDay, endDate: endOfDay, label: 'Hoy' };
    }
    case 'last_7_days': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
      return { startDate: start, endDate: endOfDay, label: 'Últimos 7 días' };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { startDate: start, endDate: endOfDay, label: 'Este Mes' };
    }
    case 'last_30_days': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0);
      return { startDate: start, endDate: endOfDay, label: 'Últimos 30 días' };
    }
  }
}

/**
 * Mapeo descriptivo para categorías de gastos
 */
export function getExpenseCategoryLabel(catId?: string | null): string {
  if (!catId) return 'Otros Gastos';
  const normalized = catId.toLowerCase().trim();
  switch (normalized) {
    case 'rent':
    case 'alquiler':
      return 'Alquiler';
    case 'utilities':
    case 'servicios':
    case 'servicios basicos':
      return 'Servicios Básicos (Luz/Agua/Internet)';
    case 'logistics':
    case 'movilidad':
    case 'flete':
    case 'transporte':
      return 'Movilidad y Flete';
    case 'maintenance':
    case 'mantenimiento':
    case 'limpieza':
      return 'Mantenimiento y Limpieza';
    case 'supplies':
    case 'suministros':
    case 'insumos':
      return 'Suministros y Empaques';
    case 'payroll':
    case 'payroll_advance':
    case 'planilla':
    case 'sueldos':
    case 'personal':
      return 'Planilla y Personal';
    case 'petty_cash':
    case 'caja_chica':
      return 'Gastos Menores de Caja Chica';
    case 'other':
    case 'otro':
    case 'manual_expense':
      return 'Otros Gastos Operativos';
    default:
      return catId.charAt(0).toUpperCase() + catId.slice(1);
  }
}

// ============================================================================
// MOTOR DE CONSULTA Y CÁLCULO P&L
// ============================================================================

export async function generatePnlReport(params: GeneratePnlReportParams): Promise<PnlReportResult> {
  if (!params.accountId) throw new Error('La cuenta es requerida para consultar el P&L.');
  const startMs = toMillis(params.startDate);
  const endMs = toMillis(params.endDate);
  const search = new URLSearchParams({
    accountId: params.accountId,
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
  });
  if (params.branchId && params.branchId !== 'all') search.set('branchId', params.branchId);

  let data: Record<string, any>;
  try {
    data = await apiRequest<Record<string, any>>(`/api/reports/pnl?${search.toString()}`);
  } catch (error: any) {
    throw new Error(error?.status === 403
      ? 'No tienes permiso para ver márgenes y reportes financieros.'
      : error?.message || 'No se pudo generar el Estado de Resultados.');
  }

  const salesClosed = requireReportAmount(data, 'salesClosed');
  const fiadosIssued = requireReportAmount(data, 'fiadosIssued');
  const netRevenue = requireReportAmount(data, 'accruedSales');
  const grossProfit = requireReportAmount(data, 'grossProfit');
  const operatingExpenses = requireReportAmount(data, 'operatingExpenses');
  const netProfit = requireReportAmount(data, 'netProfit');
  const grossSales = roundToCents(salesClosed + fiadosIssued);
  const canceled = requireReportAmount(data, 'returns');

  return {
    accountId: params.accountId,
    branchId: data.branchId || params.branchId,
    startDate: Number(data.fromMs) || startMs,
    endDate: Number(data.toMs) || endMs,
    generatedAt: Number(data.generatedAt) || Date.now(),
    grossSales,
    salesClosed,
    cancelledOrRefunded: canceled,
    netRevenue,
    transactionCount: typeof data.transactionCount === 'number' ? data.transactionCount : undefined,
    cogs: requireReportAmount(data, 'cmv'),
    grossProfit,
    grossMarginPercent: netRevenue > 0 ? roundToCents((grossProfit / netRevenue) * 100) : 0,
    operatingExpenses,
    netProfit,
    netMarginPercent: netRevenue > 0 ? roundToCents((netProfit / netRevenue) * 100) : 0,
    detailsAvailable: false,
    fiadosIssued,
    returns: canceled,
    badDebt: requireReportAmount(data, 'badDebt'),
    employeeAdvances: requireReportAmount(data, 'employeeAdvances'),
    cashOperatingExpenses: requireReportAmount(data, 'cashOperatingExpenses'),
    terminalCommissions: requireReportAmount(data, 'terminalCommissions'),
  };
}

export async function exportPnlReportPDF(
  report: PnlReportResult,
  businessName: string = 'Mi Negocio',
  branchName: string = 'Sucursal Principal',
  periodLabel: string = 'Período'
): Promise<string> {
  const isProfitable = report.netProfit >= 0;
  const netProfitColor = isProfitable ? '#10B981' : '#EF4444';
  const netMarginSign = report.netMarginPercent >= 0 ? '+' : '';
  const topProducts = report.topProductsByProfit || [];
  const sellers = report.sellerPerformance || [];
  const expenses = report.expenseBreakdown || [];
  const paymentBreakdown = report.paymentBreakdown;

  // Filas del Top 10 Productos
  const topProductsRows = topProducts.map((prod, idx) => {
    const profitColor = prod.profit >= 0 ? '#10B981' : '#EF4444';
    return `
      <tr>
        <td style="text-align: center; font-weight: bold; color: #6B7280;">#${idx + 1}</td>
        <td>
          <div style="font-weight: 600; color: #111827;">${prod.productName}</div>
          ${prod.sku ? `<div style="font-size: 10px; color: #9CA3AF;">SKU: ${prod.sku}</div>` : ''}
        </td>
        <td style="text-align: right; font-weight: 600;">${prod.quantitySold}</td>
        <td style="text-align: right;">${formatPEN(prod.revenue)}</td>
        <td style="text-align: right; color: #6B7280;">${formatPEN(prod.cogs)}</td>
        <td style="text-align: right; font-weight: 700; color: ${profitColor};">${formatPEN(prod.profit)}</td>
        <td style="text-align: right; font-weight: 600;">${prod.marginPercent.toFixed(1)}%</td>
      </tr>
    `;
  }).join('');

  // Filas del Rendimiento por Vendedor
  const sellerRows = sellers.map((seller) => {
    return `
      <tr>
        <td style="font-weight: 600; color: #111827;">${seller.sellerName}</td>
        <td style="text-align: center; font-weight: 600;">${seller.transactionsCount}</td>
        <td style="text-align: right; font-weight: 600;">${formatPEN(seller.revenue)}</td>
        <td style="text-align: right; color: #6B7280;">${formatPEN(seller.cogs)}</td>
        <td style="text-align: right; font-weight: 700; color: #10B981;">${formatPEN(seller.profit)}</td>
        <td style="text-align: right; font-weight: 600;">${seller.marginPercent.toFixed(1)}%</td>
      </tr>
    `;
  }).join('');

  // Filas de Gastos Operativos por Categoría
  const expenseRows = expenses.map((exp) => {
    return `
      <tr>
        <td style="font-weight: 500; color: #1F2937;">${exp.label}</td>
        <td style="text-align: right; font-weight: 600; color: #EF4444;">${formatPEN(exp.amount)}</td>
        <td style="text-align: right; color: #4B5563;">${exp.percentage.toFixed(1)}%</td>
      </tr>
    `;
  }).join('');

  // Filas de Métodos de Pago
  const paymentMethodsList = paymentBreakdown ? [
    { label: 'Efectivo', data: paymentBreakdown.cash, color: '#10B981' },
    { label: 'Yape', data: paymentBreakdown.yape, color: '#8B5CF6' },
    { label: 'Plin', data: paymentBreakdown.plin, color: '#06B6D4' },
    { label: 'Tarjeta Débito/Crédito', data: paymentBreakdown.card, color: '#3B82F6' },
    { label: 'Transferencia Bancaria', data: paymentBreakdown.transfer, color: '#F59E0B' },
    { label: 'Fiado / Crédito', data: paymentBreakdown.fiado, color: '#F97316' },
    { label: 'Otros Métodos', data: paymentBreakdown.other, color: '#6B7280' },
  ].filter((m) => m.data.amount > 0) : [];

  const paymentRows = paymentMethodsList.map((m) => `
    <tr>
      <td style="font-weight: 600; color: #1F2937;">
        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${m.color}; margin-right: 6px;"></span>
        ${m.label}
      </td>
      <td style="text-align: right; font-weight: 700;">${formatPEN(m.data.amount)}</td>
      <td style="text-align: right; font-weight: 600; color: #4B5563;">${m.data.percentage.toFixed(1)}%</td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8" />
      <title>Estado de Resultados P&L - ${businessName}</title>
      <style>
        @page {
          margin: 18mm 14mm 18mm 14mm;
          size: A4 portrait;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          color: #111827;
          background-color: #FFFFFF;
          margin: 0;
          padding: 0;
          font-size: 12px;
          line-height: 1.45;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 2px solid #10B981;
          padding-bottom: 12px;
          margin-bottom: 16px;
        }
        .brand-title {
          font-size: 20px;
          font-weight: 800;
          color: #0F172A;
          letter-spacing: -0.5px;
          margin: 0;
        }
        .brand-subtitle {
          font-size: 11px;
          font-weight: 700;
          color: #10B981;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-top: 2px;
        }
        .report-meta {
          text-align: right;
          font-size: 11px;
          color: #4B5563;
        }
        .kpi-grid {
          display: flex;
          gap: 10px;
          margin-bottom: 20px;
        }
        .kpi-card {
          flex: 1;
          background: #F8FAFC;
          border: 1px solid #E2E8F0;
          border-radius: 8px;
          padding: 10px 12px;
        }
        .kpi-label {
          font-size: 10px;
          font-weight: 700;
          color: #64748B;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .kpi-value {
          font-size: 16px;
          font-weight: 800;
          color: #0F172A;
          margin-top: 4px;
        }
        .kpi-sub {
          font-size: 10px;
          font-weight: 600;
          margin-top: 2px;
        }

        .section-title {
          font-size: 13px;
          font-weight: 700;
          color: #0F172A;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-left: 3px solid #10B981;
          padding-left: 8px;
          margin-top: 20px;
          margin-bottom: 10px;
        }

        table.pnl-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
        }
        table.pnl-table th {
          background-color: #0F172A;
          color: #F8FAFC;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 8px 10px;
          text-align: left;
        }
        table.pnl-table td {
          padding: 7px 10px;
          border-bottom: 1px solid #E2E8F0;
          font-size: 11px;
        }
        table.pnl-table tr:nth-child(even) td {
          background-color: #F8FAFC;
        }

        .row-waterfall-main {
          background-color: #F1F5F9 !important;
          font-weight: 700;
        }
        .row-waterfall-gross {
          background-color: #ECFDF5 !important;
          font-weight: 700;
          color: #065F46;
          border-top: 1px solid #10B981 !important;
          border-bottom: 1px solid #10B981 !important;
        }
        .row-waterfall-net {
          background-color: ${isProfitable ? '#ECFDF5' : '#FEF2F2'} !important;
          font-weight: 800;
          font-size: 13px !important;
          color: ${netProfitColor};
          border-top: 2px solid ${netProfitColor} !important;
          border-bottom: 2px solid ${netProfitColor} !important;
        }

        .footer {
          margin-top: 30px;
          border-top: 1px solid #E2E8F0;
          padding-top: 10px;
          font-size: 10px;
          color: #94A3B8;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
      </style>
    </head>
    <body>
      <!-- ENCABEZADO EJECUTIVO -->
      <div class="header">
        <div>
          <h1 class="brand-title">${businessName}</h1>
          <div class="brand-subtitle">Ventify Mobile • Estado de Resultados (P&L)</div>
        </div>
        <div class="report-meta">
          <div><strong>Sucursal:</strong> ${branchName}</div>
          <div><strong>Período:</strong> ${periodLabel}</div>
          <div><strong>Generado:</strong> ${formatDatePE(report.generatedAt, true)}</div>
        </div>
      </div>

      <!-- KPI SUMMARY CARDS -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Ingresos Netos</div>
          <div class="kpi-value">${formatPEN(report.netRevenue)}</div>
          <div class="kpi-sub" style="color: #64748B;">${report.transactionCount !== undefined ? `${report.transactionCount} ventas efectivas` : 'Totales del reporte Web'}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Utilidad Bruta</div>
          <div class="kpi-value" style="color: #10B981;">${formatPEN(report.grossProfit)}</div>
          <div class="kpi-sub" style="color: #059669;">Margen Bruto: ${report.grossMarginPercent.toFixed(1)}%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Gastos Operativos</div>
          <div class="kpi-value" style="color: #EF4444;">${formatPEN(report.operatingExpenses)}</div>
          <div class="kpi-sub" style="color: #DC2626;">Incluye conceptos consolidados y castigos de fiados</div>
        </div>
        <div class="kpi-card" style="border-color: ${netProfitColor}; background: ${isProfitable ? '#F0FDF4' : '#FEF2F2'};">
          <div class="kpi-label" style="color: ${netProfitColor};">Utilidad Neta Real</div>
          <div class="kpi-value" style="color: ${netProfitColor};">${formatPEN(report.netProfit)}</div>
          <div class="kpi-sub" style="color: ${netProfitColor}; font-weight: 700;">Margen: ${netMarginSign}${report.netMarginPercent.toFixed(1)}%</div>
        </div>
      </div>

      <!-- 1. CASCADA DE ESTADO DE RESULTADOS (P&L WATERFALL) -->
      <div class="section-title">1. Cascada de Estado de Resultados</div>
      <table class="pnl-table">
        <thead>
          <tr>
            <th style="width: 60%;">Concepto Contable</th>
            <th style="width: 25%; text-align: right;">Monto (PEN)</th>
            <th style="width: 15%; text-align: right;">% s/ Ventas</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>(+) Ventas cerradas y fiados emitidos</td>
            <td style="text-align: right; font-weight: 600;">${formatPEN(report.grossSales)}</td>
            <td style="text-align: right; color: #64748B;">100.0%</td>
          </tr>
          <tr>
            <td>(-) Devoluciones y Ventas Anuladas</td>
            <td style="text-align: right; color: #EF4444;">-${formatPEN(report.cancelledOrRefunded)}</td>
            <td style="text-align: right; color: #64748B;">${report.grossSales > 0 ? ((report.cancelledOrRefunded / report.grossSales) * 100).toFixed(1) : '0.0'}%</td>
          </tr>
          <tr class="row-waterfall-main">
            <td>(=) VENTAS NETAS OPERATIVAS</td>
            <td style="text-align: right;">${formatPEN(report.netRevenue)}</td>
            <td style="text-align: right;">100.0%</td>
          </tr>
          <tr>
            <td>(-) Costo de Mercadería Vendida (COGS / CMV)</td>
            <td style="text-align: right; color: #EF4444;">-${formatPEN(report.cogs)}</td>
            <td style="text-align: right; color: #64748B;">${report.netRevenue > 0 ? ((report.cogs / report.netRevenue) * 100).toFixed(1) : '0.0'}%</td>
          </tr>
          <tr class="row-waterfall-gross">
            <td>(=) UTILIDAD BRUTA</td>
            <td style="text-align: right;">${formatPEN(report.grossProfit)}</td>
            <td style="text-align: right;">${report.grossMarginPercent.toFixed(1)}%</td>
          </tr>
          <tr>
            <td>(-) Gastos operativos, comisiones y castigos de fiado</td>
            <td style="text-align: right; color: #EF4444;">-${formatPEN(report.operatingExpenses)}</td>
            <td style="text-align: right; color: #64748B;">${report.netRevenue > 0 ? ((report.operatingExpenses / report.netRevenue) * 100).toFixed(1) : '0.0'}%</td>
          </tr>
          <tr class="row-waterfall-main">
            <td>(=) TOTAL GASTOS OPERATIVOS</td>
            <td style="text-align: right; color: #EF4444;">-${formatPEN(report.operatingExpenses)}</td>
            <td style="text-align: right; color: #64748B;">${report.netRevenue > 0 ? ((report.operatingExpenses / report.netRevenue) * 100).toFixed(1) : '0.0'}%</td>
          </tr>
          <tr class="row-waterfall-net">
            <td>(=) UTILIDAD NETA REAL</td>
            <td style="text-align: right;">${formatPEN(report.netProfit)}</td>
            <td style="text-align: right;">${netMarginSign}${report.netMarginPercent.toFixed(1)}%</td>
          </tr>
        </tbody>
      </table>

      <div class="section-title">2. Componentes del período</div>
      <table class="pnl-table">
        <thead><tr><th>Concepto</th><th style="text-align: right;">Monto (PEN)</th></tr></thead>
        <tbody>
          <tr><td>Ventas cerradas</td><td style="text-align: right;">${formatPEN(report.salesClosed)}</td></tr>
          <tr><td>Fiados emitidos</td><td style="text-align: right;">${formatPEN(report.fiadosIssued)}</td></tr>
          <tr><td>Devoluciones</td><td style="text-align: right;">-${formatPEN(report.returns)}</td></tr>
          <tr><td>Castigos de fiado</td><td style="text-align: right;">${formatPEN(report.badDebt)}</td></tr>
          <tr><td>Gastos operativos de caja</td><td style="text-align: right;">${formatPEN(report.cashOperatingExpenses)}</td></tr>
          <tr><td>Comisiones de terminal</td><td style="text-align: right;">${formatPEN(report.terminalCommissions)}</td></tr>
          <tr><td>Adelantos a empleados (flujo de caja)</td><td style="text-align: right;">${formatPEN(report.employeeAdvances)}</td></tr>
        </tbody>
      </table>

      <!-- 3. DESGLOSE DE COBRANZA Y GASTOS (2 COLUMNAS) -->
      <table style="width: 100%; border: none; margin-bottom: 16px;">
        <tr>
          <td style="width: 50%; vertical-align: top; padding: 0 8px 0 0; border: none;">
            <div class="section-title" style="margin-top: 0;">3. Cobranza por Método de Pago</div>
            <table class="pnl-table">
              <thead>
                <tr>
                  <th>Método</th>
                  <th style="text-align: right;">Cobrado</th>
                  <th style="text-align: right;">%</th>
                </tr>
              </thead>
              <tbody>
                ${paymentRows || `<tr><td colspan="3" style="text-align: center; color: #9CA3AF;">${report.detailsAvailable ? 'Sin cobros en el período' : 'Este reporte no incluye un desglose por método de pago'}</td></tr>`}
              </tbody>
            </table>
          </td>
          <td style="width: 50%; vertical-align: top; padding: 0 0 0 8px; border: none;">
            <div class="section-title" style="margin-top: 0;">4. Gastos por Categoría</div>
            <table class="pnl-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th style="text-align: right;">Monto</th>
                  <th style="text-align: right;">% Gastos</th>
                </tr>
              </thead>
              <tbody>
                ${expenseRows || `<tr><td colspan="3" style="text-align: center; color: #9CA3AF;">${report.detailsAvailable ? 'Sin gastos en el período' : 'Este reporte no incluye un desglose por categoría de gasto'}</td></tr>`}
              </tbody>
            </table>
          </td>
        </tr>
      </table>

      <!-- 3. TOP 10 PRODUCTOS POR UTILIDAD APORTADA -->
      <div class="section-title">5. Top 10 Productos Más Rentables</div>
      <table class="pnl-table">
        <thead>
          <tr>
            <th style="width: 6%;">#</th>
            <th style="width: 36%;">Producto</th>
            <th style="width: 12%; text-align: right;">Cant.</th>
            <th style="width: 16%; text-align: right;">Ingreso</th>
            <th style="width: 14%; text-align: right;">CMV</th>
            <th style="width: 16%; text-align: right;">Utilidad</th>
            <th style="width: 10%; text-align: right;">Margen</th>
          </tr>
        </thead>
        <tbody>
          ${topProductsRows || `<tr><td colspan="7" style="text-align: center; color: #9CA3AF;">${report.detailsAvailable ? 'Sin ventas en el período' : 'Este reporte no incluye un desglose por producto'}</td></tr>`}
        </tbody>
      </table>

      <!-- 4. RENDIMIENTO POR VENDEDOR / CAJERO -->
      ${sellers.length > 0 ? `
        <div class="section-title">5. Rendimiento de Vendedores y Cajeros</div>
        <table class="pnl-table">
          <thead>
            <tr>
              <th style="width: 35%;">Vendedor / Cajero</th>
              <th style="width: 15%; text-align: center;">Ventas (#)</th>
              <th style="width: 20%; text-align: right;">Facturación</th>
              <th style="width: 15%; text-align: right;">CMV</th>
              <th style="width: 15%; text-align: right;">Ganancia</th>
              <th style="width: 10%; text-align: right;">Margen</th>
            </tr>
          </thead>
          <tbody>
            ${sellerRows}
          </tbody>
        </table>
      ` : ''}

      <!-- PIE DE PÁGINA AUDITABLE -->
      <div class="footer">
        <div>Ventify POS • Documento Confidencial para Toma de Decisiones Financieras</div>
        <div>Página 1 de 1</div>
      </div>
    </body>
    </html>
  `;

  // 1. Generar archivo PDF con expo-print
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  // 2. Abrir diálogo nativo para compartir vía expo-sharing
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, {
      UTI: '.pdf',
      mimeType: 'application/pdf',
      dialogTitle: `Reporte P&L - ${businessName} (${periodLabel})`,
    });
  }

  return uri;
}
