/**
 * Ventify Mobile - Financial Intelligence & Profit & Loss (P&L) Service
 * 
 * Motor de cálculo financiero ejecutivo y generación de Estado de Resultados
 * conforme a estándares contables devengados para negocios peruanos.
 * Genera reportes en PDF ejecutivos vía expo-print y expo-sharing.
 */

import { apiRequest } from '@/lib/api-client';
import { db } from '@/lib/firebase';
import {
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatPEN, formatDatePE } from '@/lib/theme';
import { classifyMovementForPnl } from './cash-register-service';
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
  includeDetails?: boolean;
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
    case 'employee_advance':
    case 'payroll':
    case 'payroll_advance':
    case 'planilla':
    case 'sueldos':
    case 'personal':
      return 'Adelantos y Personal';
    case 'terminal_commissions':
      return 'Comisiones POS / Pasarela';
    case 'bad_debt':
      return 'Cuentas Incobrables (Castigos)';
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

export interface PnlDetailsInput {
  sales: Array<Record<string, any>>;
  fiados: Array<Record<string, any>>;
  movements: Array<Record<string, any>>;
  productsMap?: Map<string, Product> | Record<string, Product>;
  terminalCommissions?: number;
  badDebt?: number;
}

export interface PnlDetailsResult {
  paymentBreakdown: PaymentBreakdownSummary;
  topProductsByRevenue: TopProductMetric[];
  topProductsByProfit: TopProductMetric[];
  sellerPerformance: SellerPerformanceMetric[];
  expensesByCategory: Record<string, number>;
  expenseBreakdown: ExpenseCategoryBreakdown[];
  transactionCount: number;
}

const lookupProduct = (
  productsMap: Map<string, Product> | Record<string, Product> | undefined,
  productId: string
): Product | undefined => {
  if (!productsMap || !productId) return undefined;
  if (productsMap instanceof Map) return productsMap.get(productId);
  return productsMap[productId];
};

const resolveItemUnitCost = (
  item: Record<string, any>,
  productsMap: Map<string, Product> | Record<string, Product> | undefined,
  branchId?: string
): number => {
  const direct = Number(item.costPrice);
  if (typeof item.costPrice === 'number' && Number.isFinite(direct)) return direct;
  const pid = String(item.productId || item.id || '');
  const product = lookupProduct(productsMap, pid) as any;
  if (!product) return 0;
  if (branchId && product.branchPricing?.[branchId]?.costPrice !== undefined) {
    const bp = Number(product.branchPricing[branchId].costPrice);
    if (Number.isFinite(bp)) return bp;
  }
  const fallback = Number(product.costPrice);
  return Number.isFinite(fallback) ? fallback : 0;
};

type PaymentBucketKey = 'cash' | 'yape' | 'plin' | 'card' | 'transfer' | 'fiado' | 'other';

const classifySplitPaymentBucket = (split: Record<string, any>): PaymentBucketKey => {
  const cat = String(split.category || '').toLowerCase();
  const provider = String(split.digitalProvider || split.method || '').toLowerCase();
  if (cat === 'cash' || provider.includes('efectivo') || provider === 'cash') return 'cash';
  if (cat === 'card' || provider.includes('tarjeta') || provider === 'card') return 'card';
  if (cat === 'credit' || provider.includes('fiado') || provider === 'credit') return 'fiado';
  if (provider.includes('yape')) return 'yape';
  if (provider.includes('plin')) return 'plin';
  if (cat === 'digital' || provider.includes('transfer')) return 'transfer';
  return 'other';
};

const classifyLegacySaleBucket = (sale: Record<string, any>): PaymentBucketKey => {
  const cat = String(sale.paymentCategory || '').toLowerCase();
  const method = String(sale.paymentMethod || '').toLowerCase();
  const provider = String(sale.digitalProvider || '').toLowerCase();
  if (cat === 'cash' || method.includes('efectivo') || method === 'cash') return 'cash';
  if (cat === 'credit' || method === 'fiado' || method === 'credit') return 'fiado';
  if (provider === 'yape' || method === 'yape') return 'yape';
  if (provider === 'plin' || method === 'plin') return 'plin';
  if (cat === 'card' || method.includes('tarjeta') || method === 'card') return 'card';
  if (cat === 'digital' || method.includes('transfer')) return 'transfer';
  return 'other';
};

/** Pure calculation of P&L breakdowns (payment methods, products, sellers, expenses) matching web P&L scope. */
export function buildPnlDetails(input: PnlDetailsInput): PnlDetailsResult {
  const paymentSums: Record<PaymentBucketKey, number> = {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    fiado: 0,
    other: 0,
  };

  const productAgg = new Map<string, {
    productId: string;
    productName: string;
    sku?: string;
    quantitySold: number;
    revenue: number;
    cogs: number;
  }>();

  const sellerAgg = new Map<string, {
    sellerId: string;
    sellerName: string;
    transactionsCount: number;
    revenue: number;
    cogs: number;
  }>();

  let transactionCount = 0;

  const accumulateDocument = (docItem: Record<string, any>, isFiadoDoc: boolean) => {
    const status = String(docItem.status || '').toLowerCase();
    if (status === 'cancelled' || docItem.isDepositPayment === true) return;

    const isReturn = docItem.isReturn === true;
    const branchId = typeof docItem.branchId === 'string' ? docItem.branchId : undefined;
    const items: any[] = Array.isArray(docItem.items) ? docItem.items : [];
    let docCogs = 0;

    for (const rawItem of items) {
      if (!rawItem) continue;
      const pid = String(rawItem.productId || rawItem.id || rawItem.name || 'unknown');
      const qty = Number(rawItem.quantity) || 0;
      const factor = Number(rawItem.presentationQty) > 0
        ? Number(rawItem.presentationQty)
        : Number(rawItem.conversionFactor) > 0
          ? Number(rawItem.conversionFactor)
          : 1;
      const units = qty * factor;
      const unitCost = resolveItemUnitCost(rawItem, input.productsMap, branchId);
      const lineCogs = roundToCents(unitCost * units);
      const lineRev = roundToCents((Number(rawItem.price) || 0) * qty);
      docCogs = roundToCents(docCogs + lineCogs);

      const entry = productAgg.get(pid) || {
        productId: pid,
        productName: String(rawItem.name || rawItem.productName || 'Producto'),
        sku: rawItem.sku || undefined,
        quantitySold: 0,
        revenue: 0,
        cogs: 0,
      };
      if (isReturn) {
        entry.quantitySold -= qty;
        entry.revenue = roundToCents(entry.revenue - lineRev);
        entry.cogs = roundToCents(entry.cogs - lineCogs);
      } else {
        entry.quantitySold += qty;
        entry.revenue = roundToCents(entry.revenue + lineRev);
        entry.cogs = roundToCents(entry.cogs + lineCogs);
      }
      productAgg.set(pid, entry);
    }

    const docTotal = Number(docItem.total) || 0;
    if (!isReturn) {
      transactionCount += 1;
      if (isFiadoDoc) {
        paymentSums.fiado = roundToCents(paymentSums.fiado + docTotal);
      } else if (Array.isArray(docItem.payments) && docItem.payments.length > 0) {
        for (const split of docItem.payments) {
          const splitAmt = Number(split.amount ?? split.chargedAmount) || 0;
          if (splitAmt <= 0) continue;
          const bucket = classifySplitPaymentBucket(split);
          paymentSums[bucket] = roundToCents(paymentSums[bucket] + splitAmt);
        }
      } else {
        const bucket = classifyLegacySaleBucket(docItem);
        paymentSums[bucket] = roundToCents(paymentSums[bucket] + docTotal);
      }
    }

    if (docItem.isStaffConsumption !== true) {
      const sellerKey = String(docItem.sellerId || docItem.cashierId || '__unassigned__');
      const sellerName = String(
        docItem.sellerName ||
          docItem.cashierName ||
          (docItem.sellerId || docItem.cashierId ? 'Vendedor sin nombre' : 'Sin vendedor asignado')
      );
      const sellerEntry = sellerAgg.get(sellerKey) || {
        sellerId: sellerKey,
        sellerName,
        transactionsCount: 0,
        revenue: 0,
        cogs: 0,
      };
      if (isReturn) {
        const returnedAmt = Math.abs(Number(docItem.refundAmount ?? docItem.total) || 0);
        sellerEntry.revenue = roundToCents(sellerEntry.revenue - returnedAmt);
        sellerEntry.cogs = roundToCents(sellerEntry.cogs - docCogs);
      } else {
        sellerEntry.transactionsCount += 1;
        sellerEntry.revenue = roundToCents(sellerEntry.revenue + docTotal);
        sellerEntry.cogs = roundToCents(sellerEntry.cogs + docCogs);
      }
      sellerAgg.set(sellerKey, sellerEntry);
    }
  };

  for (const sale of input.sales) {
    accumulateDocument(sale, false);
  }
  for (const fiado of input.fiados) {
    accumulateDocument(fiado, true);
  }

  const paymentTotal = roundToCents(
    paymentSums.cash +
      paymentSums.yape +
      paymentSums.plin +
      paymentSums.card +
      paymentSums.transfer +
      paymentSums.fiado +
      paymentSums.other
  );
  const toShare = (amt: number): PaymentMethodShare => ({
    amount: roundToCents(amt),
    percentage: paymentTotal > 0 ? roundToCents((amt / paymentTotal) * 100) : 0,
  });

  const paymentBreakdown: PaymentBreakdownSummary = {
    cash: toShare(paymentSums.cash),
    yape: toShare(paymentSums.yape),
    plin: toShare(paymentSums.plin),
    card: toShare(paymentSums.card),
    transfer: toShare(paymentSums.transfer),
    fiado: toShare(paymentSums.fiado),
    other: toShare(paymentSums.other),
    total: paymentTotal,
  };

  const productMetrics: TopProductMetric[] = [...productAgg.values()].map((p) => {
    const profit = roundToCents(p.revenue - p.cogs);
    return {
      productId: p.productId,
      productName: p.productName,
      ...(p.sku ? { sku: p.sku } : {}),
      quantitySold: roundToCents(p.quantitySold),
      revenue: roundToCents(p.revenue),
      cogs: roundToCents(p.cogs),
      profit,
      marginPercent: p.revenue > 0 ? roundToCents((profit / p.revenue) * 100) : 0,
    };
  });

  const topProductsByProfit = [...productMetrics]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10);
  const topProductsByRevenue = [...productMetrics]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const sellerPerformance: SellerPerformanceMetric[] = [...sellerAgg.values()]
    .filter((s) => s.transactionsCount > 0 || s.revenue !== 0)
    .map((s) => {
      const profit = roundToCents(s.revenue - s.cogs);
      return {
        sellerId: s.sellerId,
        sellerName: s.sellerName,
        transactionsCount: s.transactionsCount,
        revenue: roundToCents(s.revenue),
        cogs: roundToCents(s.cogs),
        profit,
        marginPercent: s.revenue > 0 ? roundToCents((profit / s.revenue) * 100) : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const expensesByCategory: Record<string, number> = {};
  for (const m of input.movements) {
    const rawAmt = Number(m.amount) || 0;
    if (rawAmt === 0) continue;
    const pnlClass = classifyMovementForPnl({
      type: m.type,
      amount: rawAmt,
      category: m.category,
      expenseCategoryId: m.expenseCategoryId,
      isEmployeeAdvance: m.isEmployeeAdvance,
    });
    if (pnlClass !== 'operating_expense') continue;
    const catKey = String(m.expenseCategoryId || m.category || 'other').toLowerCase().trim() || 'other';
    expensesByCategory[catKey] = roundToCents((expensesByCategory[catKey] || 0) + Math.abs(rawAmt));
  }
  if ((input.terminalCommissions || 0) > 0) {
    expensesByCategory.terminal_commissions = roundToCents(
      (expensesByCategory.terminal_commissions || 0) + Number(input.terminalCommissions)
    );
  }
  if ((input.badDebt || 0) > 0) {
    expensesByCategory.bad_debt = roundToCents(
      (expensesByCategory.bad_debt || 0) + Number(input.badDebt)
    );
  }

  const totalExpenseBreakdown = roundToCents(
    Object.values(expensesByCategory).reduce((sum, v) => sum + v, 0)
  );
  const expenseBreakdown: ExpenseCategoryBreakdown[] = Object.entries(expensesByCategory)
    .filter(([, amt]) => amt > 0)
    .map(([category, amount]) => ({
      category,
      label: getExpenseCategoryLabel(category),
      amount: roundToCents(amount),
      percentage: totalExpenseBreakdown > 0 ? roundToCents((amount / totalExpenseBreakdown) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    paymentBreakdown,
    topProductsByRevenue,
    topProductsByProfit,
    sellerPerformance,
    expensesByCategory,
    expenseBreakdown,
    transactionCount,
  };
}

// ============================================================================
// MOTOR DE CONSULTA Y CÁLCULO P&L
// ============================================================================

export async function generatePnlReport(params: GeneratePnlReportParams): Promise<PnlReportResult> {
  if (!params.accountId) throw new Error('La cuenta es requerida para consultar el P&L.');
  const startMs = toMillis(params.startDate);
  const endMs = toMillis(params.endDate);
  const effectiveBranchId = params.branchId && params.branchId !== 'all' ? params.branchId : undefined;
  const search = new URLSearchParams({
    accountId: params.accountId,
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
  });
  if (effectiveBranchId) search.set('branchId', effectiveBranchId);

  let data: Record<string, any> | null = null;
  let apiError: any = null;
  try {
    data = await apiRequest<Record<string, any>>(`/api/reports/pnl?${search.toString()}`);
  } catch (error: any) {
    if (error?.status === 403) {
      throw new Error('No tienes permiso para ver márgenes y reportes financieros.');
    }
    apiError = error;
    console.warn('[PnlReportService] Fallback local desde Firestore por error en API:', error?.message || error);
  }

  const resolvedFromMs = Number(data?.fromMs) || startMs;
  const resolvedToMs = Number(data?.toMs) || endMs;
  const branchScope = data?.branchId && data.branchId !== 'all' ? data.branchId : effectiveBranchId;

  const fetchDetailsFromFirestore = async () => {
    const salesQuery = query(
      collection(db, 'sales'),
      where('accountId', '==', params.accountId),
      ...(branchScope ? [where('branchId', '==', branchScope)] : []),
      where('date', '>=', resolvedFromMs),
      where('date', '<=', resolvedToMs),
      orderBy('date', 'asc')
    );
    const reservationsQuery = query(
      collection(db, 'reservations'),
      where('accountId', '==', params.accountId),
      ...(branchScope ? [where('branchId', '==', branchScope)] : []),
      where('date', '>=', resolvedFromMs),
      where('date', '<=', resolvedToMs),
      orderBy('date', 'desc')
    );
    const movementsQuery = query(
      collection(db, 'cash_register_movements'),
      where('accountId', '==', params.accountId),
      ...(branchScope ? [where('branchId', '==', branchScope)] : []),
      where('createdAt', '>=', Timestamp.fromMillis(resolvedFromMs)),
      where('createdAt', '<=', Timestamp.fromMillis(resolvedToMs)),
      orderBy('createdAt', 'asc')
    );

    const [salesSnap, reservationsSnap, movementsSnap] = await Promise.all([
      getDocs(salesQuery),
      getDocs(reservationsQuery),
      getDocs(movementsQuery),
    ]);

    const salesDocs: Array<Record<string, any>> = salesSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Record<string, any>),
    }));
    const reservationDocs: Array<Record<string, any>> = reservationsSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Record<string, any>),
    }));
    const fiadoDocs = reservationDocs.filter(
      (r) => r.type === 'fiado' || r.isCreditSale === true
    );
    const movementDocs: Array<Record<string, any>> = movementsSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Record<string, any>),
    }));

    return { salesDocs, fiadoDocs, movementDocs };
  };

  if (!data) {
    try {
      const { salesDocs, fiadoDocs, movementDocs } = await fetchDetailsFromFirestore();
      let salesClosed = 0;
      let returns = 0;
      let fiadosIssued = 0;
      let badDebt = 0;
      let cashOperatingExpenses = 0;
      let employeeAdvances = 0;
      let terminalCommissions = 0;
      let cogs = 0;

      for (const s of salesDocs) {
        if (s.status === 'cancelled' || s.status === 'voided' || s.isDepositPayment) continue;
        const amt = Number(s.total || 0);
        if (s.isReturn) {
          returns += Number(s.refundAmount || amt);
          continue;
        }
        salesClosed += amt;
        terminalCommissions += Number(s.terminalFee || s.commissionAmount || 0);
        if (Array.isArray(s.items)) {
          for (const it of s.items) {
            const qty = Number(it.quantity || 0) * Number(it.presentationQty || it.conversionFactor || 1);
            const p = params.productsMap instanceof Map ? params.productsMap.get(it.productId) : params.productsMap?.[it.productId];
            const unitCost = Number(it.costPrice ?? p?.costPrice ?? 0);
            cogs += unitCost * qty;
          }
        }
      }
      for (const f of fiadoDocs) {
        if (f.status === 'cancelled') continue;
        fiadosIssued += Number(f.total || 0);
        if (f.isBadDebt) badDebt += Number(f.remainingAmount ?? f.total ?? 0);
      }
      for (const m of movementDocs) {
        const cls = classifyMovementForPnl(m);
        if (cls === 'operating_expense') cashOperatingExpenses += Number(m.amount || 0);
        else if (cls === 'employee_advance') employeeAdvances += Number(m.amount || 0);
      }

      const netRevenue = roundToCents(salesClosed + fiadosIssued - returns);
      const grossSales = roundToCents(salesClosed + fiadosIssued);
      const cogsRounded = roundToCents(cogs);
      const grossProfit = roundToCents(netRevenue - cogsRounded);
      const operatingExpenses = roundToCents(cashOperatingExpenses + terminalCommissions + badDebt);
      const netProfit = roundToCents(grossProfit - operatingExpenses);
      const details = buildPnlDetails({
        sales: salesDocs,
        fiados: fiadoDocs,
        movements: movementDocs,
        productsMap: params.productsMap,
        terminalCommissions,
        badDebt,
      });

      return {
        accountId: params.accountId,
        branchId: params.branchId,
        startDate: resolvedFromMs,
        endDate: resolvedToMs,
        generatedAt: Date.now(),
        grossSales,
        salesClosed: roundToCents(salesClosed),
        cancelledOrRefunded: roundToCents(returns),
        netRevenue,
        transactionCount: details.transactionCount,
        cogs: cogsRounded,
        grossProfit,
        grossMarginPercent: netRevenue > 0 ? roundToCents((grossProfit / netRevenue) * 100) : 0,
        operatingExpenses,
        pettyCashExpenses: roundToCents(cashOperatingExpenses),
        payrollExpenses: 0,
        expensesByCategory: details.expensesByCategory,
        expenseBreakdown: details.expenseBreakdown,
        paymentBreakdown: details.paymentBreakdown,
        topProductsByRevenue: details.topProductsByRevenue,
        topProductsByProfit: details.topProductsByProfit,
        sellerPerformance: details.sellerPerformance,
        netProfit,
        netMarginPercent: netRevenue > 0 ? roundToCents((netProfit / netRevenue) * 100) : 0,
        detailsAvailable: true,
        fiadosIssued: roundToCents(fiadosIssued),
        returns: roundToCents(returns),
        badDebt: roundToCents(badDebt),
        employeeAdvances: roundToCents(employeeAdvances),
        cashOperatingExpenses: roundToCents(cashOperatingExpenses),
        terminalCommissions: roundToCents(terminalCommissions),
      };
    } catch (fallbackErr: any) {
      throw new Error(apiError?.message || fallbackErr?.message || 'No se pudo generar el Estado de Resultados.');
    }
  }

  const salesClosed = requireReportAmount(data, 'salesClosed');
  const fiadosIssued = requireReportAmount(data, 'fiadosIssued');
  const netRevenue = requireReportAmount(data, 'accruedSales');
  const grossProfit = requireReportAmount(data, 'grossProfit');
  const operatingExpenses = requireReportAmount(data, 'operatingExpenses');
  const netProfit = requireReportAmount(data, 'netProfit');
  const grossSales = roundToCents(salesClosed + fiadosIssued);
  const canceled = requireReportAmount(data, 'returns');
  const badDebt = requireReportAmount(data, 'badDebt');
  const employeeAdvances = requireReportAmount(data, 'employeeAdvances');
  const cashOperatingExpenses = requireReportAmount(data, 'cashOperatingExpenses');
  const terminalCommissions = requireReportAmount(data, 'terminalCommissions');

  const includeDetails = params.includeDetails !== false;
  let details: PnlDetailsResult | null = null;
  if (includeDetails) {
    try {
      const { salesDocs, fiadoDocs, movementDocs } = await fetchDetailsFromFirestore();

      details = buildPnlDetails({
        sales: salesDocs,
        fiados: fiadoDocs,
        movements: movementDocs,
        productsMap: params.productsMap,
        terminalCommissions,
        badDebt,
      });
    } catch (detailErr) {
      console.warn('[PnlReportService] No se pudieron cargar desgloses de Firestore:', detailErr);
      details = null;
    }
  }

  return {
    accountId: params.accountId,
    branchId: data.branchId || params.branchId,
    startDate: resolvedFromMs,
    endDate: resolvedToMs,
    generatedAt: Number(data.generatedAt) || Date.now(),
    grossSales,
    salesClosed,
    cancelledOrRefunded: canceled,
    netRevenue,
    transactionCount:
      typeof data.transactionCount === 'number'
        ? data.transactionCount
        : details?.transactionCount,
    cogs: requireReportAmount(data, 'cmv'),
    grossProfit,
    grossMarginPercent: netRevenue > 0 ? roundToCents((grossProfit / netRevenue) * 100) : 0,
    operatingExpenses,
    ...(details
      ? {
          pettyCashExpenses: cashOperatingExpenses,
          payrollExpenses: 0,
          expensesByCategory: details.expensesByCategory,
          expenseBreakdown: details.expenseBreakdown,
          paymentBreakdown: details.paymentBreakdown,
          topProductsByRevenue: details.topProductsByRevenue,
          topProductsByProfit: details.topProductsByProfit,
          sellerPerformance: details.sellerPerformance,
        }
      : {}),
    netProfit,
    netMarginPercent: netRevenue > 0 ? roundToCents((netProfit / netRevenue) * 100) : 0,
    detailsAvailable: details !== null,
    fiadosIssued,
    returns: canceled,
    badDebt,
    employeeAdvances,
    cashOperatingExpenses,
    terminalCommissions,
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
