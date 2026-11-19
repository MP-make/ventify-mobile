/**
 * Ventify Mobile - Wave 3 Dashboard, Reports & SUNAT E-Invoicing Service
 *
 * Consolida:
 * 1. Endpoints backend de Dashboard (`/api/dashboard/period-comparison`, `/api/dashboard/inventory-intelligence`)
 * 2. Consultas Firestore con índices compuestos desplegados para resumen operativo, Cierres Z, CxC y Egresos
 * 3. Reporte de rendimiento por vendedor (`/api/reports/sellers`)
 * 4. Facturación electrónica SUNAT (`/api/invoicing/status`, `/api/invoicing/emit`, `/api/invoicing/export`)
 * 5. Descarga y compartición segura de exportaciones CSV/XLSX/XML/CDR vía `expo-file-system` + `expo-sharing`
 */

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { ApiError, apiRequest, getApiRequestInit } from '@/lib/api-client';
import { classifyMovementForPnl, expenseCategoryLabel } from './cash-register-service';
import type { GeneratePnlReportParams, PnlReportResult } from './pnl-report-service';

// ============================================================================
// TIPOS & CATÁLOGOS COMPARTIDOS
// ============================================================================

export type DateRangePreset = 'today' | '7d' | '30d' | 'month';

export interface DateRangeBounds {
  preset: DateRangePreset;
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
  label: string;
}

export interface PeriodComparisonResult {
  previousTotal: number;
  previousTransactions: number;
  trend: number[];
  generatedAt: number;
}

export interface InventoryIntelligenceResult {
  gmroi: number;
  dsi: number;
  deadStockValue: number;
  deadStockCount: number;
  inventoryTurnover: number;
}

export type InventoryIntelligenceResponse =
  | (InventoryIntelligenceResult & { building?: false })
  | { building: true; retryAfter: number };

export interface PaymentDistributionItem {
  key: 'cash' | 'yape' | 'plin' | 'card' | 'transfer' | 'fiado' | 'other';
  label: string;
  amount: number;
  count: number;
  percentage: number;
}

export interface TopProductItem {
  productId: string;
  name: string;
  quantity: number;
  revenue: number;
}

export interface TopCustomerItem {
  customerKey: string;
  name: string;
  purchasesCount: number;
  revenue: number;
}

export interface DocumentTypeBreakdownItem {
  typeKey: '01' | '03' | 'NTV' | 'other';
  label: string;
  count: number;
  total: number;
}

export interface DashboardSalesBreakdown {
  totalRevenue: number;
  grossRevenue: number;
  returnsTotal: number;
  transactionCount: number;
  averageTicket: number;
  estimatedCost: number;
  estimatedMarginPercent: number;
  paymentDistribution: PaymentDistributionItem[];
  topProducts: TopProductItem[];
  topCustomers: TopCustomerItem[];
  documentTypeBreakdown: DocumentTypeBreakdownItem[];
}

export interface OpenCashSessionSummary {
  id: string;
  branchId: string;
  registerName?: string;
  startedByName?: string;
  openTime: number;
  initialAmount: number;
  totalSales: number;
}

export interface LowStockAlertProduct {
  id: string;
  name: string;
  stock: number;
  minStock: number;
}

export interface OperationalAlert {
  id: string;
  severity: 'danger' | 'warning' | 'info';
  title: string;
  description: string;
  route: string;
  actionLabel: string;
}

export interface DashboardOperationalSummary {
  salesSummary: DashboardSalesBreakdown;
  rawSalesCount: number;
  openCashSessions: {
    count: number;
    totalOpeningBalance: number;
    totalSalesInOpenShifts: number;
    sessions: OpenCashSessionSummary[];
  };
  pendingTransfersCount: number;
  inTransitTransfersCount: number;
  lowStockCount: number;
  lowStockProducts: LowStockAlertProduct[];
  overdueFiadosCount: number;
  overdueFiadosTotal: number;
  activeFiadosCount: number;
  activeFiadosTotal: number;
  alerts: OperationalAlert[];
}

export interface SellerPerformanceRow {
  sellerId: string | null;
  sellerName: string;
  gross: number;
  refunds: number;
  net: number;
  salesCount: number;
  participation: number | null;
}

export interface SellerPerformanceReport {
  version: number;
  rows: SellerPerformanceRow[];
  totalNet: number;
  totalGross: number;
  totalRefunds: number;
}

export interface SellerPerformanceApiResponse {
  report: SellerPerformanceReport;
  timeZone: string;
  from: number;
  to: number;
}

export type PublicEinvoiceDocType = '01' | '03' | '07' | '08' | '09';
export type PublicEinvoiceStatus = 'pending' | 'sending' | 'accepted' | 'rejected' | 'error';

export interface PublicEinvoice {
  id: string;
  accountId?: string;
  saleId: string;
  branchId?: string;
  documentType: PublicEinvoiceDocType;
  documentNumber: string;
  fileName?: string;
  status: PublicEinvoiceStatus | string;
  amount: number;
  currency: string;
  createdAt: number;
  updatedAt?: number;
  attempts?: number;
  lastError?: string;
  cdr?: {
    responseCode: number;
    description: string;
    notes?: string[];
    cdrCode?: string;
    responseDate?: string;
    responseTime?: string;
  };
  receiptCustomer?: {
    identityType: '6' | '1' | string;
    identityNumber: string;
    name: string;
    address?: string;
  };
  receiptAmounts?: {
    taxed: number;
    exempt: number;
    unaffected: number;
    igv: number;
    otherTaxes?: number;
    total: number;
  };
  receiptIssuedAt?: number;
  replacementId?: string;
  replacesInvoiceId?: string;
  replacementCreditNoteId?: string;
  reference?: {
    type: '01' | '03' | string;
    number: string;
    reasonCode: string;
    reasonDescription?: string;
  };
}

export interface EmitEinvoicePayload {
  accountId: string;
  saleId: string;
  documentType: '01' | '03' | '07' | '08';
  customer?: {
    identityType: '6' | '1';
    identityNumber: string;
    name: string;
    address?: string;
    email?: string;
  };
  notes?: string[];
  reference?: {
    type: '01' | '03';
    number: string;
    reasonCode: string;
    reasonDescription: string;
  };
  replacesInvoiceId?: string;
  creditNoteId?: string;
}

export interface CashClosureReportItem {
  id: string;
  sessionId: string;
  branchId: string;
  branchName?: string;
  startedByName?: string;
  closedByName?: string;
  createdAt: number;
  closeTime: number;
  expectedAmount: number;
  countedAmount: number;
  difference: number;
  notes?: string;
  computed?: {
    totalSales?: number;
    salesCount?: number;
    refundsCount?: number;
    cashSalesOnly?: number;
    cardSalesOnly?: number;
    yapeSalesOnly?: number;
    plinSalesOnly?: number;
    creditSalesOnly?: number;
    cashIncomes?: number;
    cashWithdrawals?: number;
  };
}

export interface ReceivablesFiadoItem {
  id: string;
  customerId?: string;
  customerName: string;
  branchId?: string;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  date: number;
  dueDate?: number;
  isOverdue: boolean;
}

export interface ReceivablesCustomerSummary {
  id: string;
  name: string;
  phone?: string;
  currentDebt: number;
  credits: number;
  totalSpent: number;
  totalPurchases: number;
}

export interface ReceivablesSummary {
  totalDebt: number;
  overdueDebt: number;
  activeFiadosCount: number;
  overdueFiadosCount: number;
  totalCreditsInFavor: number;
  fiados: ReceivablesFiadoItem[];
  topCustomers: ReceivablesCustomerSummary[];
}

export interface ExpenseCategorySummaryItem {
  category: string;
  label: string;
  amount: number;
  count: number;
  percentage: number;
}

export interface ExpensesReportSummary {
  totalOperatingExpenses: number;
  totalEmployeeAdvances: number;
  totalRefunds: number;
  movementsCount: number;
  categories: ExpenseCategorySummaryItem[];
  recentExpenses: Array<{
    id: string;
    label: string;
    reason: string;
    amount: number;
    createdAt: number;
    createdByName?: string;
  }>;
}

export const SUNAT_CREDIT_NOTE_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '01', label: 'Anulación de la operación' },
  { code: '02', label: 'Anulación por error en el RUC' },
  { code: '06', label: 'Devolución total' },
];

export const SUNAT_DEBIT_NOTE_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '01', label: 'Intereses por mora' },
  { code: '02', label: 'Aumento en el valor' },
  { code: '03', label: 'Penalidades / otros conceptos' },
];

export const EINVOICE_TYPE_LABELS: Record<string, string> = {
  '01': 'Factura',
  '03': 'Boleta',
  '07': 'Nota de Crédito',
  '08': 'Nota de Débito',
  '09': 'Guía de Remisión',
  NTV: 'Nota de Venta',
};

export const EINVOICE_STATUS_LABELS: Record<string, string> = {
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  error: 'Error',
  sending: 'Enviando...',
  pending: 'Pendiente',
};

// ============================================================================
// HELPERS PUROS
// ============================================================================

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

export const toEpochMs = (val: unknown): number => {
  if (!val) return 0;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 0;
    return val < 1e11 ? val * 1000 : val;
  }
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, any>;
    if (typeof obj.toMillis === 'function') return Number(obj.toMillis()) || 0;
    if (typeof obj.toDate === 'function') return obj.toDate().getTime();
    if (typeof obj.seconds === 'number') {
      return obj.seconds * 1000 + (obj.nanoseconds ? Math.round(obj.nanoseconds / 1e6) : 0);
    }
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

export const formatLocalIsoDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export function getDateRangeBounds(preset: DateRangePreset, now: Date = new Date()): DateRangeBounds {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  let start: Date;
  let label: string;

  switch (preset) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      label = 'Hoy';
      break;
    case '7d':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
      label = '7 días';
      break;
    case '30d':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0);
      label = '30 días';
      break;
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      label = 'Este mes';
      break;
  }

  return {
    preset,
    fromMs: start.getTime(),
    toMs: end.getTime(),
    fromIso: formatLocalIsoDate(start),
    toIso: formatLocalIsoDate(end),
    label,
  };
}

export function calculateVariationPercent(current: number, previous: number): number | null {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev <= 0) {
    return cur === 0 ? 0 : null;
  }
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

type PaymentBucketKey = PaymentDistributionItem['key'];

const PAYMENT_BUCKET_META: Record<PaymentBucketKey, string> = {
  cash: 'Efectivo',
  yape: 'Yape',
  plin: 'Plin',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  fiado: 'Fiado / Crédito',
  other: 'Otros',
};

const classifyPaymentSplit = (split: Record<string, any>): PaymentBucketKey => {
  const cat = String(split.category || '').toLowerCase();
  const provider = String(split.digitalProvider || split.method || split.methodName || '').toLowerCase();
  if (cat === 'cash' || provider.includes('efectivo') || provider === 'cash') return 'cash';
  if (cat === 'card' || provider.includes('tarjeta') || provider === 'card') return 'card';
  if (cat === 'credit' || provider.includes('fiado') || provider === 'credit') return 'fiado';
  if (provider.includes('yape')) return 'yape';
  if (provider.includes('plin')) return 'plin';
  if (cat === 'digital' || provider.includes('transfer')) return 'transfer';
  return 'other';
};

const classifyLegacySale = (sale: Record<string, any>): PaymentBucketKey => {
  const cat = String(sale.paymentCategory || '').toLowerCase();
  const method = String(sale.paymentMethod || sale.paymentMethodName || '').toLowerCase();
  const provider = String(sale.digitalProvider || '').toLowerCase();
  if (cat === 'cash' || method.includes('efectivo') || method === 'cash') return 'cash';
  if (cat === 'credit' || method === 'fiado' || method === 'credit') return 'fiado';
  if (provider === 'yape' || method.includes('yape')) return 'yape';
  if (provider === 'plin' || method.includes('plin')) return 'plin';
  if (cat === 'card' || method.includes('tarjeta') || method === 'card') return 'card';
  if (cat === 'digital' || method.includes('transfer')) return 'transfer';
  return 'other';
};

const resolveSaleDocTypeKey = (rawType?: string): DocumentTypeBreakdownItem['typeKey'] => {
  const t = String(rawType || '').toLowerCase();
  if (t === '01' || t === 'factura') return '01';
  if (t === '03' || t === 'boleta') return '03';
  if (t === 'ntv' || t === 'nota_venta' || t === '80' || !t) return 'NTV';
  return 'other';
};

const DOC_TYPE_LABELS: Record<DocumentTypeBreakdownItem['typeKey'], string> = {
  '01': 'Factura (01)',
  '03': 'Boleta (03)',
  NTV: 'Nota de Venta',
  other: 'Otros',
};

export function aggregatePeriodSalesSummary(
  sales: Array<Record<string, any>>,
  productsMap?: Map<string, Record<string, any>>
): DashboardSalesBreakdown {
  let grossRevenue = 0;
  let returnsTotal = 0;
  let transactionCount = 0;
  let estimatedCost = 0;

  const paymentSums: Record<PaymentBucketKey, { amount: number; count: number }> = {
    cash: { amount: 0, count: 0 },
    yape: { amount: 0, count: 0 },
    plin: { amount: 0, count: 0 },
    card: { amount: 0, count: 0 },
    transfer: { amount: 0, count: 0 },
    fiado: { amount: 0, count: 0 },
    other: { amount: 0, count: 0 },
  };

  const productsAgg = new Map<string, TopProductItem>();
  const customersAgg = new Map<string, TopCustomerItem>();
  const docTypesAgg = new Map<DocumentTypeBreakdownItem['typeKey'], { count: number; total: number }>();

  for (const sale of sales) {
    if (!sale) continue;
    const status = String(sale.status || '').toLowerCase();
    if (
      status === 'cancelled' ||
      status === 'pending' ||
      sale.isDepositPayment === true ||
      sale.isQuote === true ||
      sale.documentType === 'cot' ||
      sale.isStaffConsumption === true
    ) {
      continue;
    }

    const total = Number(sale.total) || 0;
    const isReturn = sale.isReturn === true;

    if (isReturn) {
      returnsTotal = round2(returnsTotal + Math.abs(Number(sale.refundAmount ?? total) || 0));
    } else {
      grossRevenue = round2(grossRevenue + total);
      transactionCount += 1;

      const docKey = resolveSaleDocTypeKey(sale.documentType);
      const existingDoc = docTypesAgg.get(docKey) || { count: 0, total: 0 };
      existingDoc.count += 1;
      existingDoc.total = round2(existingDoc.total + total);
      docTypesAgg.set(docKey, existingDoc);

      const splits: any[] =
        Array.isArray(sale.payments) && sale.payments.length > 0
          ? sale.payments
          : Array.isArray(sale.paymentSplits) && sale.paymentSplits.length > 0
            ? sale.paymentSplits
            : Array.isArray(sale.mixedPayments) && sale.mixedPayments.length > 0
              ? sale.mixedPayments
              : [];

      if (splits.length > 0) {
        const seenBuckets = new Set<PaymentBucketKey>();
        for (const split of splits) {
          const amt = Number(split.amount ?? split.chargedAmount) || 0;
          if (amt <= 0) continue;
          const bucket = classifyPaymentSplit(split);
          paymentSums[bucket].amount = round2(paymentSums[bucket].amount + amt);
          if (!seenBuckets.has(bucket)) {
            paymentSums[bucket].count += 1;
            seenBuckets.add(bucket);
          }
        }
      } else {
        const bucket = classifyLegacySale(sale);
        paymentSums[bucket].amount = round2(paymentSums[bucket].amount + total);
        paymentSums[bucket].count += 1;
      }

      const customerName = typeof sale.customerName === 'string' ? sale.customerName.trim() : '';
      const lowerCust = customerName.toLowerCase();
      if (
        customerName &&
        lowerCust !== 'cliente general' &&
        lowerCust !== 'cliente varios' &&
        lowerCust !== 'cliente sin registrar'
      ) {
        const custKey = String(sale.customerId || lowerCust);
        const existingCust = customersAgg.get(custKey) || {
          customerKey: custKey,
          name: customerName,
          purchasesCount: 0,
          revenue: 0,
        };
        existingCust.purchasesCount += 1;
        existingCust.revenue = round2(existingCust.revenue + total);
        customersAgg.set(custKey, existingCust);
      }
    }

    const items: any[] = Array.isArray(sale.items) ? sale.items : [];
    for (const item of items) {
      if (!item) continue;
      const pid = String(item.productId || item.id || item.name || 'item');
      const qty = Number(item.quantity) || 0;
      const factor = Number(item.presentationQty) > 0
        ? Number(item.presentationQty)
        : Number(item.conversionFactor) > 0
          ? Number(item.conversionFactor)
          : 1;
      const price = Number(item.price) || 0;
      const lineRev = round2(price * qty);

      let unitCost = Number(item.costPrice);
      if (item.costPrice === undefined || item.costPrice === null || !Number.isFinite(unitCost)) {
        const prod = productsMap?.get(pid);
        const prodCost = Number(prod?.costPrice);
        unitCost =
          prod && prod.costPrice !== undefined && prod.costPrice !== null && Number.isFinite(prodCost)
            ? prodCost
            : price * 0.7;
      }
      const lineCost = round2(unitCost * qty * factor);

      if (isReturn) {
        estimatedCost = round2(estimatedCost - lineCost);
      } else {
        estimatedCost = round2(estimatedCost + lineCost);
        const existingProd = productsAgg.get(pid) || {
          productId: pid,
          name: String(item.name || item.productName || 'Producto'),
          quantity: 0,
          revenue: 0,
        };
        existingProd.quantity = round2(existingProd.quantity + qty);
        existingProd.revenue = round2(existingProd.revenue + lineRev);
        productsAgg.set(pid, existingProd);
      }
    }
  }

  const totalRevenue = round2(grossRevenue - returnsTotal);
  const averageTicket = transactionCount > 0 ? round2(totalRevenue / transactionCount) : 0;
  const estimatedMarginPercent =
    totalRevenue > 0 ? Math.round(((totalRevenue - estimatedCost) / totalRevenue) * 1000) / 10 : 0;

  const paymentTotal = round2(
    Object.values(paymentSums).reduce((sum, entry) => sum + entry.amount, 0)
  );
  const paymentDistribution: PaymentDistributionItem[] = (Object.keys(paymentSums) as PaymentBucketKey[])
    .filter((key) => paymentSums[key].amount > 0)
    .map((key) => ({
      key,
      label: PAYMENT_BUCKET_META[key],
      amount: round2(paymentSums[key].amount),
      count: paymentSums[key].count,
      percentage: paymentTotal > 0 ? Math.round((paymentSums[key].amount / paymentTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const topProducts = [...productsAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const topCustomers = [...customersAgg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const documentTypeBreakdown: DocumentTypeBreakdownItem[] = (['01', '03', 'NTV', 'other'] as const)
    .map((typeKey) => {
      const entry = docTypesAgg.get(typeKey) || { count: 0, total: 0 };
      return {
        typeKey,
        label: DOC_TYPE_LABELS[typeKey],
        count: entry.count,
        total: entry.total,
      };
    })
    .filter((item) => item.count > 0);

  return {
    totalRevenue,
    grossRevenue,
    returnsTotal,
    transactionCount,
    averageTicket,
    estimatedCost,
    estimatedMarginPercent,
    paymentDistribution,
    topProducts,
    topCustomers,
    documentTypeBreakdown,
  };
}

export function summarizeEinvoices(
  items: Array<{ documentType: string; status: string; amount?: number }>
) {
  let facturaAmount = 0;
  let boletaAmount = 0;
  let creditNoteAmount = 0;
  let facturaCount = 0;
  let boletaCount = 0;
  let creditNoteCount = 0;
  let acceptedCount = 0;
  let pendingCount = 0;
  let rejectedOrErrorCount = 0;

  for (const item of items) {
    const status = String(item.status || '');
    if (status === 'accepted') acceptedCount += 1;
    else if (status === 'pending' || status === 'sending') pendingCount += 1;
    else if (status === 'rejected' || status === 'error') rejectedOrErrorCount += 1;

    const type = String(item.documentType || '');
    if (type !== '01' && type !== '03' && type !== '07') continue;

    const amount = status === 'accepted' ? Number(item.amount) || 0 : 0;
    if (type === '01') {
      facturaAmount += amount;
      facturaCount += 1;
    } else if (type === '03') {
      boletaAmount += amount;
      boletaCount += 1;
    } else {
      creditNoteAmount += amount;
      creditNoteCount += 1;
    }
  }

  return {
    totalFacturado: round2(facturaAmount + boletaAmount - creditNoteAmount),
    facturaAmount: round2(facturaAmount),
    boletaAmount: round2(boletaAmount),
    creditNoteAmount: round2(creditNoteAmount),
    facturaCount,
    boletaCount,
    creditNoteCount,
    acceptedCount,
    pendingCount,
    rejectedOrErrorCount,
  };
}

// ============================================================================
// DASHBOARD EXECUTIVO & REPORTES API / FIRESTORE
// ============================================================================

const normalizeBranchScope = (branchId?: string | null): string | undefined => {
  if (!branchId || branchId === 'all') return undefined;
  return branchId;
};

export async function fetchPeriodComparison(
  accountId: string,
  fromMs: number,
  toMs: number,
  branchId?: string
): Promise<PeriodComparisonResult> {
  if (!accountId || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    throw new ApiError('Parámetros de período inválidos.', 400);
  }
  const params = new URLSearchParams({
    accountId,
    from: String(Math.trunc(fromMs)),
    to: String(Math.trunc(toMs)),
  });
  const scopedBranch = normalizeBranchScope(branchId);
  if (scopedBranch) params.set('branchId', scopedBranch);

  return apiRequest<PeriodComparisonResult>(`/api/dashboard/period-comparison?${params.toString()}`, {
    timeoutMs: 30000,
  });
}

export async function fetchInventoryIntelligence(
  accountId: string,
  branchId?: string
): Promise<InventoryIntelligenceResponse> {
  if (!accountId) {
    throw new ApiError('accountId es requerido.', 400);
  }
  const params = new URLSearchParams({ accountId });
  const scopedBranch = normalizeBranchScope(branchId);
  if (scopedBranch) params.set('branchId', scopedBranch);

  const path = `/api/dashboard/inventory-intelligence?${params.toString()}`;
  const prepared = await getApiRequestInit(path, { method: 'GET' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(prepared.url, {
      ...prepared.init,
      signal: controller.signal,
    });
    if (auth.currentUser?.uid !== prepared.uid) {
      throw new ApiError('La sesión cambió. Repite la operación.', 409);
    }
    if (response.status === 503) {
      const retryRaw = Number(response.headers?.get?.('Retry-After'));
      const retryAfter = Number.isFinite(retryRaw) && retryRaw > 0 ? retryRaw : 5;
      return { building: true, retryAfter };
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(
        body?.error || body?.message || 'No se pudo consultar inteligencia de inventario.',
        response.status,
        body?.code
      );
    }
    const data = await response.json().catch(() => null);
    if (!data) {
      throw new ApiError('Respuesta inválida del servidor.', 502);
    }
    return data as InventoryIntelligenceResult;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError('El análisis tardó demasiado. Intenta nuevamente.', 408);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchDashboardOperationalSummary(
  accountId: string,
  branchId: string | undefined,
  fromMs: number,
  toMs: number,
  productsMap?: Map<string, Record<string, any>>
): Promise<DashboardOperationalSummary> {
  if (!accountId) {
    throw new Error('accountId requerido para resumen operativo.');
  }
  const effectiveBranch = normalizeBranchScope(branchId);

  const salesQuery = query(
    collection(db, 'sales'),
    where('accountId', '==', accountId),
    ...(effectiveBranch ? [where('branchId', '==', effectiveBranch)] : []),
    where('date', '>=', fromMs),
    where('date', '<=', toMs),
    orderBy('date', 'desc')
  );

  const sessionsQuery = query(
    collection(db, 'cash_register_sessions'),
    where('accountId', '==', accountId),
    ...(effectiveBranch ? [where('branchId', '==', effectiveBranch)] : []),
    where('status', '==', 'open'),
    orderBy('openTime', 'desc'),
    limit(20)
  );

  const transfersQuery = query(
    collection(db, 'transfers'),
    where('accountId', '==', accountId),
    orderBy('createdAt', 'desc'),
    limit(100)
  );

  const lowStockQuery = query(
    collection(db, 'products'),
    where('accountId', '==', accountId),
    where('lowStockBranches', 'array-contains', effectiveBranch || '__any__'),
    limit(100)
  );

  const reservationsQuery = query(
    collection(db, 'reservations'),
    where('accountId', '==', accountId),
    ...(effectiveBranch ? [where('branchId', '==', effectiveBranch)] : []),
    where('status', '==', 'pending'),
    orderBy('date', 'desc'),
    limit(200)
  );

  const [salesRes, sessionsRes, transfersRes, lowStockRes, reservationsRes] = await Promise.allSettled([
    getDocs(salesQuery),
    getDocs(sessionsQuery),
    getDocs(transfersQuery),
    getDocs(lowStockQuery),
    getDocs(reservationsQuery),
  ]);

  if (salesRes.status === 'rejected') {
    throw salesRes.reason;
  }

  const salesDocs = salesRes.value.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }));
  const salesSummary = aggregatePeriodSalesSummary(salesDocs, productsMap);

  const openSessions: OpenCashSessionSummary[] =
    sessionsRes.status === 'fulfilled'
      ? sessionsRes.value.docs
          .filter((d) => !d.id.startsWith('active_'))
          .map((d) => {
            const data = d.data() || {};
            return {
              id: d.id,
              branchId: String(data.branchId || ''),
              registerName: data.registerName ? String(data.registerName) : undefined,
              startedByName: data.startedByName ? String(data.startedByName) : undefined,
              openTime: toEpochMs(data.openTime || data.openedAt),
              initialAmount: Number(data.initialAmount ?? data.openingBalance) || 0,
              totalSales: Number(data.totalSales) || 0,
            };
          })
      : [];

  const totalOpeningBalance = round2(openSessions.reduce((s, c) => s + c.initialAmount, 0));
  const totalSalesInOpenShifts = round2(openSessions.reduce((s, c) => s + c.totalSales, 0));

  let pendingTransfersCount = 0;
  let inTransitTransfersCount = 0;
  if (transfersRes.status === 'fulfilled') {
    for (const d of transfersRes.value.docs) {
      const data = d.data() || {};
      const src = String(data.sourceBranchId || data.fromBranchId || '');
      const dest = String(data.destinationBranchId || data.toBranchId || '');
      if (effectiveBranch && src !== effectiveBranch && dest !== effectiveBranch) continue;
      if (data.status === 'pending' || data.status === 'approved') pendingTransfersCount += 1;
      else if (data.status === 'in_transit') inTransitTransfersCount += 1;
    }
  }

  const lowStockProducts: LowStockAlertProduct[] = [];
  if (lowStockRes.status === 'fulfilled') {
    for (const d of lowStockRes.value.docs) {
      const data = d.data() || {};
      if (data.active === false) continue;
      const stockMap: Record<string, number> = data.stock || {};
      const reservedMap: Record<string, number> = data.reservedStock || {};
      const available = effectiveBranch
        ? (Number(stockMap[effectiveBranch]) || 0) - (Number(reservedMap[effectiveBranch]) || 0)
        : Object.keys(stockMap).reduce(
            (acc, bId) => acc + ((Number(stockMap[bId]) || 0) - (Number(reservedMap[bId]) || 0)),
            0
          );
      lowStockProducts.push({
        id: d.id,
        name: String(data.name || 'Producto'),
        stock: available,
        minStock: Number(data.minStock) || 5,
      });
    }
  }

  const nowMs = Date.now();
  let overdueFiadosCount = 0;
  let overdueFiadosTotal = 0;
  let activeFiadosCount = 0;
  let activeFiadosTotal = 0;

  if (reservationsRes.status === 'fulfilled') {
    for (const d of reservationsRes.value.docs) {
      const data = d.data() || {};
      const isFiado = data.type === 'fiado' || data.isCreditSale === true;
      if (!isFiado) continue;
      const remaining = Math.max(
        0,
        (Number(data.total) || 0) - (Number(data.paidAmount) || 0) - (Number(data.returnedAmount) || 0)
      );
      if (remaining <= 0) continue;
      activeFiadosCount += 1;
      activeFiadosTotal = round2(activeFiadosTotal + remaining);
      const dueMs = toEpochMs(data.dueDate);
      if (dueMs > 0 && dueMs < nowMs) {
        overdueFiadosCount += 1;
        overdueFiadosTotal = round2(overdueFiadosTotal + remaining);
      }
    }
  }

  const alerts: OperationalAlert[] = [];
  if (openSessions.length === 0) {
    alerts.push({
      id: 'no-open-cash',
      severity: 'warning',
      title: 'Sin caja abierta en este alcance',
      description: 'Abre un turno de caja para registrar cobros y arqueos.',
      route: '/(tabs)/operations',
      actionLabel: 'Ir a Caja',
    });
  }
  if (overdueFiadosCount > 0) {
    alerts.push({
      id: 'overdue-fiados',
      severity: 'danger',
      title: `${overdueFiadosCount} fiado${overdueFiadosCount === 1 ? '' : 's'} vencido${overdueFiadosCount === 1 ? '' : 's'}`,
      description: `Saldo vencido por cobrar: S/ ${overdueFiadosTotal.toFixed(2)}.`,
      route: '/(tabs)/operations',
      actionLabel: 'Cobrar',
    });
  }
  if (lowStockProducts.length > 0) {
    alerts.push({
      id: 'low-stock',
      severity: 'warning',
      title: `${lowStockProducts.length} producto${lowStockProducts.length === 1 ? '' : 's'} con stock bajo`,
      description: `Revisa reposición para evitar quiebres de inventario.`,
      route: '/(tabs)/catalog',
      actionLabel: 'Ver Catálogo',
    });
  }
  if (pendingTransfersCount + inTransitTransfersCount > 0) {
    alerts.push({
      id: 'pending-transfers',
      severity: 'info',
      title: `${pendingTransfersCount + inTransitTransfersCount} traslado${pendingTransfersCount + inTransitTransfersCount === 1 ? '' : 's'} en curso`,
      description: `${pendingTransfersCount} por aprobar/enviar · ${inTransitTransfersCount} en tránsito.`,
      route: '/(tabs)/catalog',
      actionLabel: 'Traslados',
    });
  }

  return {
    salesSummary,
    rawSalesCount: salesDocs.length,
    openCashSessions: {
      count: openSessions.length,
      totalOpeningBalance,
      totalSalesInOpenShifts,
      sessions: openSessions,
    },
    pendingTransfersCount,
    inTransitTransfersCount,
    lowStockCount: lowStockProducts.length,
    lowStockProducts: lowStockProducts.slice(0, 10),
    overdueFiadosCount,
    overdueFiadosTotal,
    activeFiadosCount,
    activeFiadosTotal,
    alerts,
  };
}

export async function fetchCanonicalPnlReport(params: GeneratePnlReportParams): Promise<PnlReportResult> {
  const { generatePnlReport } = await import('./pnl-report-service');
  return generatePnlReport(params);
}

export async function fetchSellerPerformanceReport(
  accountId: string,
  fromDay: string,
  toDay: string,
  branchId?: string
): Promise<SellerPerformanceApiResponse> {
  if (!accountId) throw new ApiError('accountId es requerido.', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || toDay < fromDay) {
    throw new ApiError('Rango de fechas inválido (AAAA-MM-DD).', 400);
  }
  const params = new URLSearchParams({ fromDay, toDay });
  const scopedBranch = normalizeBranchScope(branchId);
  if (scopedBranch) params.set('branchId', scopedBranch);

  return apiRequest<SellerPerformanceApiResponse>(`/api/reports/sellers?${params.toString()}`, {
    timeoutMs: 30000,
  });
}

export async function fetchCashClosureReports(
  accountId: string,
  branchId?: string,
  fromMs?: number,
  toMs?: number,
  maxItems: number = 60
): Promise<CashClosureReportItem[]> {
  if (!accountId) return [];
  const effectiveBranch = normalizeBranchScope(branchId);
  const q = query(
    collection(db, 'cash_register_reports'),
    where('accountId', '==', accountId),
    ...(effectiveBranch ? [where('branchId', '==', effectiveBranch)] : []),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  const snap = await getDocs(q);
  const rows: CashClosureReportItem[] = [];
  for (const d of snap.docs) {
    const data = d.data() || {};
    const createdMs = toEpochMs(data.createdAt || data.closedAt || data.closeTime);
    const closeMs = toEpochMs(data.closeTime || data.closedAt || data.createdAt);
    const refMs = closeMs || createdMs;
    if (fromMs && refMs && refMs < fromMs) continue;
    if (toMs && refMs && refMs > toMs) continue;

    rows.push({
      id: d.id,
      sessionId: String(data.sessionId || ''),
      branchId: String(data.branchId || data.sessionSnapshot?.branchId || ''),
      branchName: data.branchName || data.sessionSnapshot?.branchName || undefined,
      startedByName: data.startedByName || data.sessionSnapshot?.startedByName || undefined,
      closedByName: data.closedByName || undefined,
      createdAt: createdMs,
      closeTime: closeMs,
      expectedAmount: Number(data.expectedAmount) || 0,
      countedAmount: Number(data.countedAmount) || 0,
      difference: Number(data.difference) || 0,
      notes: data.notes ? String(data.notes) : undefined,
      computed: data.computed || undefined,
    });
  }
  return rows;
}

export async function fetchReceivablesReport(
  accountId: string,
  branchId?: string
): Promise<ReceivablesSummary> {
  if (!accountId) {
    return {
      totalDebt: 0,
      overdueDebt: 0,
      activeFiadosCount: 0,
      overdueFiadosCount: 0,
      totalCreditsInFavor: 0,
      fiados: [],
      topCustomers: [],
    };
  }
  const effectiveBranch = normalizeBranchScope(branchId);

  const fiadosQuery = query(
    collection(db, 'reservations'),
    where('accountId', '==', accountId),
    ...(effectiveBranch ? [where('branchId', '==', effectiveBranch)] : []),
    where('status', '==', 'pending'),
    orderBy('date', 'desc'),
    limit(200)
  );

  const customersQuery = query(
    collection(db, 'customers'),
    where('accountId', '==', accountId),
    limit(300)
  );

  const [fiadosSnap, customersSnap] = await Promise.all([
    getDocs(fiadosQuery),
    getDocs(customersQuery),
  ]);

  const nowMs = Date.now();
  const fiados: ReceivablesFiadoItem[] = [];
  let totalDebt = 0;
  let overdueDebt = 0;
  let overdueFiadosCount = 0;

  for (const d of fiadosSnap.docs) {
    const data = d.data() || {};
    if (data.type !== 'fiado' && data.isCreditSale !== true) continue;
    const total = Number(data.total) || 0;
    const paidAmount = Number(data.paidAmount) || 0;
    const returnedAmount = Number(data.returnedAmount) || 0;
    const remainingAmount = round2(Math.max(0, total - paidAmount - returnedAmount));
    if (remainingAmount <= 0) continue;

    const dueMs = toEpochMs(data.dueDate);
    const isOverdue = dueMs > 0 && dueMs < nowMs;
    totalDebt = round2(totalDebt + remainingAmount);
    if (isOverdue) {
      overdueFiadosCount += 1;
      overdueDebt = round2(overdueDebt + remainingAmount);
    }
    fiados.push({
      id: d.id,
      customerId: data.customerId ? String(data.customerId) : undefined,
      customerName: String(data.customerName || 'Cliente sin nombre'),
      branchId: data.branchId ? String(data.branchId) : undefined,
      total,
      paidAmount,
      remainingAmount,
      date: toEpochMs(data.date),
      dueDate: dueMs || undefined,
      isOverdue,
    });
  }

  let totalCreditsInFavor = 0;
  const customers: ReceivablesCustomerSummary[] = [];
  for (const d of customersSnap.docs) {
    const data = d.data() || {};
    const credits = Number(data.credits) || 0;
    const currentDebt = Number(data.currentDebt) || 0;
    totalCreditsInFavor = round2(totalCreditsInFavor + Math.max(0, credits));
    customers.push({
      id: d.id,
      name: String(data.name || 'Cliente'),
      phone: data.phone ? String(data.phone) : undefined,
      currentDebt,
      credits,
      totalSpent: Number(data.totalSpent) || 0,
      totalPurchases: Number(data.totalPurchases) || 0,
    });
  }

  customers.sort((a, b) => (b.currentDebt - a.currentDebt) || (b.totalSpent - a.totalSpent));

  return {
    totalDebt,
    overdueDebt,
    activeFiadosCount: fiados.length,
    overdueFiadosCount,
    totalCreditsInFavor,
    fiados,
    topCustomers: customers.slice(0, 20),
  };
}

export async function fetchExpensesReport(
  accountId: string,
  branchId: string | undefined,
  fromMs: number,
  toMs: number
): Promise<ExpensesReportSummary> {
  if (!accountId) {
    return {
      totalOperatingExpenses: 0,
      totalEmployeeAdvances: 0,
      totalRefunds: 0,
      movementsCount: 0,
      categories: [],
      recentExpenses: [],
    };
  }
  const effectiveBranch = normalizeBranchScope(branchId);
  const q = query(
    collection(db, 'cash_register_movements'),
    where('accountId', '==', accountId),
    ...(effectiveBranch ? [where('branchId', '==', effectiveBranch)] : []),
    where('createdAt', '>=', Timestamp.fromMillis(fromMs)),
    where('createdAt', '<=', Timestamp.fromMillis(toMs)),
    orderBy('createdAt', 'asc')
  );

  const snap = await getDocs(q);
  let totalOperatingExpenses = 0;
  let totalEmployeeAdvances = 0;
  let totalRefunds = 0;

  const byCategory = new Map<string, { label: string; amount: number; count: number }>();
  const recentExpenses: ExpensesReportSummary['recentExpenses'] = [];

  for (const d of snap.docs) {
    const data = d.data() || {};
    const rawAmount = Number(data.amount) || 0;
    if (rawAmount === 0) continue;

    const pnlClass = classifyMovementForPnl({
      type: data.type,
      amount: rawAmount,
      category: data.category,
      expenseCategoryId: data.expenseCategoryId,
      isEmployeeAdvance: data.isEmployeeAdvance,
    });

    const absAmt = round2(Math.abs(rawAmount));
    if (pnlClass === 'operating_expense') {
      totalOperatingExpenses = round2(totalOperatingExpenses + absAmt);
      const catKey = String(data.expenseCategoryId || data.category || 'other').toLowerCase();
      const label = expenseCategoryLabel(data.expenseCategoryId, data.category);
      const entry = byCategory.get(catKey) || { label, amount: 0, count: 0 };
      entry.amount = round2(entry.amount + absAmt);
      entry.count += 1;
      byCategory.set(catKey, entry);

      recentExpenses.push({
        id: d.id,
        label,
        reason: String(data.reason || 'Gasto operativo'),
        amount: absAmt,
        createdAt: toEpochMs(data.createdAt),
        createdByName: data.createdByName ? String(data.createdByName) : undefined,
      });
    } else if (pnlClass === 'employee_advance') {
      totalEmployeeAdvances = round2(totalEmployeeAdvances + absAmt);
    } else if (pnlClass === 'refund') {
      totalRefunds = round2(totalRefunds + absAmt);
    }
  }

  const categories: ExpenseCategorySummaryItem[] = [...byCategory.entries()]
    .map(([category, info]) => ({
      category,
      label: info.label,
      amount: info.amount,
      count: info.count,
      percentage:
        totalOperatingExpenses > 0
          ? Math.round((info.amount / totalOperatingExpenses) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  recentExpenses.sort((a, b) => b.createdAt - a.createdAt);

  return {
    totalOperatingExpenses,
    totalEmployeeAdvances,
    totalRefunds,
    movementsCount: snap.size,
    categories,
    recentExpenses: recentExpenses.slice(0, 30),
  };
}

// ============================================================================
// FACTURACIÓN ELECTRÓNICA SUNAT
// ============================================================================

export async function fetchEinvoices(
  accountId: string,
  options?: { branchId?: string; from?: string; to?: string }
): Promise<PublicEinvoice[]> {
  if (!accountId) {
    throw new ApiError('accountId es requerido.', 400);
  }
  const params = new URLSearchParams({ accountId });
  if (options?.from && options?.to) {
    params.set('from', options.from);
    params.set('to', options.to);
  }

  const data = await apiRequest<{ success: boolean; einvoices: PublicEinvoice[] }>(
    `/api/invoicing/status?${params.toString()}`,
    { timeoutMs: 60000 }
  );

  const list = Array.isArray(data?.einvoices) ? data.einvoices : [];
  const scopedBranch = normalizeBranchScope(options?.branchId);
  if (!scopedBranch) return list;
  return list.filter((doc) => !doc.branchId || doc.branchId === scopedBranch);
}

export async function retryEinvoiceDocument(
  accountId: string,
  einvoiceId: string
): Promise<PublicEinvoice> {
  if (!accountId || !einvoiceId) {
    throw new ApiError('accountId e id del comprobante son obligatorios.', 400);
  }
  const data = await apiRequest<{ success: boolean; einvoice: PublicEinvoice }>(
    '/api/invoicing/status',
    {
      method: 'POST',
      body: { accountId, id: einvoiceId },
      timeoutMs: 100000,
    }
  );
  if (!data?.einvoice) {
    throw new ApiError('El servidor no devolvió el comprobante actualizado.', 502);
  }
  return data.einvoice;
}

export async function emitEinvoiceDocument(payload: EmitEinvoicePayload): Promise<PublicEinvoice> {
  if (!payload.accountId || !payload.saleId) {
    throw new ApiError('accountId y saleId son obligatorios.', 400);
  }
  const data = await apiRequest<{ success: boolean; einvoice: PublicEinvoice }>(
    '/api/invoicing/emit',
    {
      method: 'POST',
      body: payload,
      timeoutMs: 100000,
    }
  );
  if (!data?.einvoice) {
    throw new ApiError('El servidor no devolvió el comprobante emitido.', 502);
  }
  return data.einvoice;
}

// ============================================================================
// DESCARGA Y COMPARTICIÓN DE EXPORTACIONES (CSV / XLSX / XML / CDR)
// ============================================================================

const sanitizeFilename = (name: string): string =>
  name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'exportacion_ventify';

export async function downloadAndShareExportFile(
  path: string,
  filename: string,
  mimeType: string
): Promise<string> {
  const safeName = sanitizeFilename(filename);
  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error('No hay almacenamiento temporal disponible en el dispositivo.');
  }

  const normalizedDir = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
  const targetUri = `${normalizedDir}${safeName}`;
  const prepared = await getApiRequestInit(path, { method: 'GET' });

  const rawHeaders = prepared.init.headers as Record<string, string> | undefined;
  const headers: Record<string, string> = {};
  if (rawHeaders) {
    for (const [key, val] of Object.entries(rawHeaders)) {
      if (typeof val === 'string' && key.toLowerCase() !== 'content-type') {
        headers[key] = val;
      }
    }
  }

  const downloadResult = await FileSystem.downloadAsync(prepared.url, targetUri, { headers });
  if (downloadResult.status < 200 || downloadResult.status >= 300) {
    let errorMessage = 'No se pudo descargar el archivo.';
    try {
      const content = await FileSystem.readAsStringAsync(downloadResult.uri);
      const parsed = JSON.parse(content);
      if (parsed?.error || parsed?.message) {
        errorMessage = String(parsed.error || parsed.message);
      }
    } catch {
      // ignore parse fallback
    }
    await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true }).catch(() => {});
    throw new ApiError(errorMessage, downloadResult.status);
  }

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error('La función de compartir archivos no está disponible en este dispositivo.');
  }

  await Sharing.shareAsync(downloadResult.uri, {
    mimeType,
    dialogTitle: safeName,
  });

  return downloadResult.uri;
}
