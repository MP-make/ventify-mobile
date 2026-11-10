/**
 * Ventify Mobile - Financial Intelligence & Profit & Loss (P&L) Service
 * 
 * Motor de cálculo financiero ejecutivo y generación de Estado de Resultados
 * conforme a estándares contables devengados para negocios peruanos.
 * Genera reportes en PDF ejecutivos vía expo-print y expo-sharing.
 */

import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  Timestamp,
} from 'firebase/firestore';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatPEN, formatDatePE } from '@/lib/theme';
import type { Product, Sale, CartItem } from '@/types';

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
  cancelledOrRefunded: number;  // Ventas anuladas y devoluciones
  netRevenue: number;           // Ventas netas operativas (grossSales - cancelledOrRefunded)
  transactionCount: number;     // Transacciones de venta efectivas

  cogs: number;                 // Costo de Mercadería Vendida (CMV)
  grossProfit: number;          // Utilidad Bruta (netRevenue - cogs)
  grossMarginPercent: number;   // Margen Bruto % ((grossProfit / netRevenue) * 100)

  operatingExpenses: number;    // Gastos Operativos Totales (Caja chica + Planilla)
  pettyCashExpenses: number;    // Gastos de caja chica
  payrollExpenses: number;      // Gastos de planilla / salarios
  expensesByCategory: Record<string, number>;
  expenseBreakdown: ExpenseCategoryBreakdown[];

  netProfit: number;            // Utilidad Neta Real (grossProfit - operatingExpenses)
  netMarginPercent: number;     // Margen Neto % ((netProfit / netRevenue) * 100)

  // Desgloses y Rankings
  paymentBreakdown: PaymentBreakdownSummary;
  topProductsByRevenue: TopProductMetric[];
  topProductsByProfit: TopProductMetric[];
  sellerPerformance: SellerPerformanceMetric[];
}

// ============================================================================
// HELPERS NUMÉRICOS Y DE FECHA
// ============================================================================

export function roundToCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
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
  const { accountId, branchId, productsMap } = params;
  const filterBranch = branchId && branchId !== 'all' ? branchId : undefined;

  const startMs = toMillis(params.startDate);
  let endMs = toMillis(params.endDate);

  // Si la fecha final es a las 00:00:00, extenderla al final del día
  const endDateObj = new Date(endMs);
  if (endDateObj.getHours() === 0 && endDateObj.getMinutes() === 0 && endDateObj.getSeconds() === 0) {
    endMs = new Date(endDateObj.getFullYear(), endDateObj.getMonth(), endDateObj.getDate(), 23, 59, 59, 999).getTime();
  }

  // 1. CONSULTA RESILIENTE DE VENTAS (sales)
  let salesDocs: Array<Record<string, any>> = [];
  try {
    let q = query(
      collection(db, 'sales'),
      where('accountId', '==', accountId),
      where('date', '>=', startMs),
      where('date', '<=', endMs)
    );
    if (filterBranch) {
      q = query(
        collection(db, 'sales'),
        where('accountId', '==', accountId),
        where('branchId', '==', filterBranch),
        where('date', '>=', startMs),
        where('date', '<=', endMs)
      );
    }
    const snap = await getDocs(q);
    salesDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err: any) {
    // Fallback sin rango en Firestore si falta el índice compuesto
    try {
      let fallbackQ = query(
        collection(db, 'sales'),
        where('accountId', '==', accountId)
      );
      if (filterBranch) {
        fallbackQ = query(
          collection(db, 'sales'),
          where('accountId', '==', accountId),
          where('branchId', '==', filterBranch)
        );
      }
      const snap = await getDocs(fallbackQ);
      salesDocs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((sale: any) => {
          const sTime = toMillis(sale.date || sale.createdAt);
          return sTime >= startMs && sTime <= endMs;
        });
    } catch (fbErr) {
      console.error('[PnlService] Error consultando ventas:', fbErr);
      salesDocs = [];
    }
  }

  // 2. CONSULTA RESILIENTE DE MOVIMIENTOS DE CAJA (cash_register_movements)
  let movementsDocs: Array<Record<string, any>> = [];
  try {
    let q = query(
      collection(db, 'cash_register_movements'),
      where('accountId', '==', accountId),
      where('createdAt', '>=', Timestamp.fromMillis(startMs)),
      where('createdAt', '<=', Timestamp.fromMillis(endMs))
    );
    if (filterBranch) {
      q = query(
        collection(db, 'cash_register_movements'),
        where('accountId', '==', accountId),
        where('branchId', '==', filterBranch),
        where('createdAt', '>=', Timestamp.fromMillis(startMs)),
        where('createdAt', '<=', Timestamp.fromMillis(endMs))
      );
    }
    const snap = await getDocs(q);
    movementsDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err: any) {
    // Fallback sin filtro de fecha en Firestore
    try {
      let fallbackQ = query(
        collection(db, 'cash_register_movements'),
        where('accountId', '==', accountId)
      );
      if (filterBranch) {
        fallbackQ = query(
          collection(db, 'cash_register_movements'),
          where('accountId', '==', accountId),
          where('branchId', '==', filterBranch)
        );
      }
      const snap = await getDocs(fallbackQ);
      movementsDocs = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((m: any) => {
          const mTime = toMillis(m.createdAt || m.date);
          return mTime >= startMs && mTime <= endMs;
        });
    } catch (fbErr) {
      console.error('[PnlService] Error consultando movimientos de caja:', fbErr);
      movementsDocs = [];
    }
  }

  // 3. CONSULTA RESILIENTE DE PLANILLA (payroll_movements y payroll_settlements)
  let payrollItems: Array<{ amount: number; description: string; date: number }> = [];
  try {
    const pMovementsQ = query(
      collection(db, 'payroll_movements'),
      where('accountId', '==', accountId)
    );
    const snap = await getDocs(pMovementsQ);
    snap.docs.forEach((d) => {
      const data = d.data() as any;
      if (filterBranch && data.branchId && data.branchId !== filterBranch) return;
      const t = toMillis(data.date || data.createdAt);
      if (t >= startMs && t <= endMs) {
        payrollItems.push({
          amount: Math.abs(Number(data.amount) || 0),
          description: data.notes || data.employeeName || 'Pago de Planilla',
          date: t,
        });
      }
    });
  } catch {
    // Colección puede no existir en algunas instancias, se ignora
  }

  try {
    const pSettlementsQ = query(
      collection(db, 'payroll_settlements'),
      where('accountId', '==', accountId)
    );
    const snap = await getDocs(pSettlementsQ);
    snap.docs.forEach((d) => {
      const data = d.data() as any;
      if (filterBranch && data.branchId && data.branchId !== filterBranch) return;
      if (data.status === 'draft') return; // Solo liquidadas o pagadas
      const t = toMillis(data.date || data.createdAt || data.periodEnd);
      if (t >= startMs && t <= endMs) {
        const netSal = Number(data.netSalary ?? data.total) || 0;
        if (netSal > 0) {
          payrollItems.push({
            amount: netSal,
            description: `Liquidación Planilla: ${data.employeeName || ''}`,
            date: t,
          });
        }
      }
    });
  } catch {
    // Colección de liquidaciones opcional
  }

  // 4. MAPA DE COSTOS DE PRODUCTOS DE APOYO (si no vienen en snapshot)
  const getProductCost = (productId?: string): number => {
    if (!productId) return 0;
    if (productsMap) {
      if (typeof (productsMap as any).get === 'function') {
        const p = (productsMap as Map<string, Product>).get(productId);
        if (p) {
          if (filterBranch && p.branchPrices?.[filterBranch]?.costPrice !== undefined) {
            return Number(p.branchPrices[filterBranch]?.costPrice) || 0;
          }
          return Number(p.costPrice) || 0;
        }
      } else if (typeof productsMap === 'object') {
        const p = (productsMap as Record<string, Product>)[productId];
        if (p) {
          if (filterBranch && p.branchPrices?.[filterBranch]?.costPrice !== undefined) {
            return Number(p.branchPrices[filterBranch]?.costPrice) || 0;
          }
          return Number(p.costPrice) || 0;
        }
      }
    }
    return 0;
  };

  // 5. CÁLCULO DE VENTAS, COGS, MÉTODOS DE PAGO Y RENDIMIENTOS
  let grossSales = 0;
  let cancelledOrRefunded = 0;
  let totalCogs = 0;
  let validTransactionCount = 0;

  const paymentAmounts = {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    fiado: 0,
    other: 0,
  };

  const productMetricsMap = new Map<string, {
    productId: string;
    productName: string;
    sku: string;
    quantity: number;
    revenue: number;
    cogs: number;
  }>();

  const sellerMetricsMap = new Map<string, {
    sellerId: string;
    sellerName: string;
    count: number;
    revenue: number;
    cogs: number;
  }>();

  for (const sale of salesDocs) {
    const isCancelled = sale.status === 'cancelled';
    const isRefund = sale.status === 'refunded' || sale.isReturn === true;
    const isDeposit = sale.isDepositPayment === true;
    const saleTotal = Number(sale.total) || 0;

    // A. Ventas anuladas: se descartan del ingreso neto
    if (isCancelled) {
      cancelledOrRefunded = roundToCents(cancelledOrRefunded + saleTotal);
      continue;
    }

    // B. Devoluciones o reembolsos: restan ingreso y revierten CMV
    if (isRefund) {
      const refundAmt = Math.abs(Number(sale.refundAmount ?? saleTotal) || 0);
      cancelledOrRefunded = roundToCents(cancelledOrRefunded + refundAmt);

      // Revertir costo de mercadería devuelta si viene en los items
      if (Array.isArray(sale.items)) {
        for (const item of sale.items) {
          const qty = Number(item.quantity) || 0;
          const factor = Number(item.presentationQty ?? item.conversionFactor) > 0
            ? Number(item.presentationQty ?? item.conversionFactor)
            : 1;
          const units = Number(item.baseUnits) > 0 ? Number(item.baseUnits) : qty * factor;
          const unitCost = typeof item.costPrice === 'number' && item.costPrice > 0
            ? item.costPrice
            : getProductCost(item.productId || item.id);
          totalCogs = roundToCents(totalCogs - (unitCost * units));
        }
      }
      continue;
    }

    // C. Pagos de saldo / depósito (evitar duplicar ventas cerradas)
    if (isDeposit) {
      continue;
    }

    // D. Venta efectiva regular
    grossSales = roundToCents(grossSales + saleTotal);
    validTransactionCount += 1;

    // Calcular CMV de los ítems de la venta
    let saleCogs = 0;
    if (Array.isArray(sale.items)) {
      for (const item of sale.items) {
        const qty = Number(item.quantity) || 0;
        const factor = Number(item.presentationQty ?? item.conversionFactor) > 0
          ? Number(item.presentationQty ?? item.conversionFactor)
          : 1;
        const units = Number(item.baseUnits) > 0 ? Number(item.baseUnits) : qty * factor;
        const unitCost = typeof item.costPrice === 'number' && item.costPrice > 0
          ? item.costPrice
          : getProductCost(item.productId || item.id);

        const lineCost = unitCost * units;
        const linePrice = Number(item.price ?? item.salePrice ?? item.unitPrice) || 0;
        const lineRevenue = Number(item.lineTotal) || (linePrice * qty);

        saleCogs += lineCost;

        // Métricas por producto
        const prodId = String(item.productId || item.id || item.name || 'unnamed');
        const prodName = String(item.name || 'Producto General');
        const prodSku = String(item.sku || '');

        const existingProd = productMetricsMap.get(prodId) || {
          productId: prodId,
          productName: prodName,
          sku: prodSku,
          quantity: 0,
          revenue: 0,
          cogs: 0,
        };

        existingProd.quantity += qty;
        existingProd.revenue += lineRevenue;
        existingProd.cogs += lineCost;
        productMetricsMap.set(prodId, existingProd);
      }
    } else if (typeof sale.totalCost === 'number' && sale.totalCost > 0) {
      // Si la venta tiene totalCost precalculado
      saleCogs = sale.totalCost;
    }

    totalCogs = roundToCents(totalCogs + saleCogs);

    // Desglose de Métodos de Pago
    if (Array.isArray(sale.payments) && sale.payments.length > 0) {
      for (const p of sale.payments) {
        const cat = String(p.category || p.paymentMethod || '').toLowerCase();
        const prov = String(p.digitalProvider || '').toLowerCase();
        const amt = Number(p.amount) || 0;

        if (cat.includes('cash') || cat.includes('efectivo')) {
          paymentAmounts.cash += amt;
        } else if (prov === 'yape' || cat.includes('yape')) {
          paymentAmounts.yape += amt;
        } else if (prov === 'plin' || cat.includes('plin')) {
          paymentAmounts.plin += amt;
        } else if (cat.includes('card') || cat.includes('tarjeta')) {
          paymentAmounts.card += amt;
        } else if (cat.includes('transfer')) {
          paymentAmounts.transfer += amt;
        } else if (cat.includes('fiado') || cat.includes('credit')) {
          paymentAmounts.fiado += amt;
        } else {
          paymentAmounts.other += amt;
        }
      }
    } else {
      const pm = String(sale.paymentMethod || '').toLowerCase();
      const digProv = String(sale.digitalProvider || '').toLowerCase();

      if (pm === 'mixto' || pm === 'mixed') {
        paymentAmounts.cash += Number(sale.cashAmount) || 0;
        paymentAmounts.card += Number(sale.cardAmount) || 0;
        const dig = Number(sale.digitalAmount) || 0;
        if (digProv === 'plin') paymentAmounts.plin += dig;
        else paymentAmounts.yape += dig;
      } else if (pm.includes('efectivo') || pm === 'cash') {
        paymentAmounts.cash += saleTotal;
      } else if (pm === 'yape' || (pm.includes('digital') && digProv === 'yape')) {
        paymentAmounts.yape += saleTotal;
      } else if (pm === 'plin' || (pm.includes('digital') && digProv === 'plin')) {
        paymentAmounts.plin += saleTotal;
      } else if (pm.includes('tarjeta') || pm === 'card') {
        paymentAmounts.card += saleTotal;
      } else if (pm.includes('transfer')) {
        paymentAmounts.transfer += saleTotal;
      } else if (pm.includes('fiado') || pm.includes('credit')) {
        paymentAmounts.fiado += saleTotal;
      } else {
        paymentAmounts.other += saleTotal;
      }
    }

    // Rendimiento por Vendedor / Cajero
    const sellerId = String(sale.sellerId || sale.userId || sale.cashierId || 'unassigned');
    const sellerName = String(sale.sellerName || sale.userName || sale.cashierUsername || 'Ventas General');

    const existingSeller = sellerMetricsMap.get(sellerId) || {
      sellerId,
      sellerName,
      count: 0,
      revenue: 0,
      cogs: 0,
    };
    existingSeller.count += 1;
    existingSeller.revenue += saleTotal;
    existingSeller.cogs += saleCogs;
    sellerMetricsMap.set(sellerId, existingSeller);
  }

  // 6. GASTOS OPERATIVOS DE CAJA CHICA Y CATEGORIZACIÓN
  const expensesByCategory: Record<string, number> = {};
  let pettyCashExpenses = 0;

  for (const m of movementsDocs) {
    if (m.type !== 'expense') continue;

    // Excluir devoluciones de venta en caja chica que ya restan ventas
    const cat = String(m.category || '').toLowerCase();
    if (cat === 'refund' || cat === 'sale_refund' || cat === 'reservation_refund') {
      continue;
    }

    const amt = Math.abs(Number(m.amount) || 0);
    if (amt <= 0) continue;

    pettyCashExpenses = roundToCents(pettyCashExpenses + amt);

    const catKey = m.expenseCategoryId || m.category || 'other';
    const label = getExpenseCategoryLabel(catKey);
    expensesByCategory[label] = roundToCents((expensesByCategory[label] || 0) + amt);
  }

  // 7. GASTOS DE PLANILLA
  let payrollExpenses = 0;
  for (const p of payrollItems) {
    payrollExpenses = roundToCents(payrollExpenses + p.amount);
  }
  if (payrollExpenses > 0) {
    const pLabel = getExpenseCategoryLabel('payroll');
    expensesByCategory[pLabel] = roundToCents((expensesByCategory[pLabel] || 0) + payrollExpenses);
  }

  const operatingExpenses = roundToCents(pettyCashExpenses + payrollExpenses);

  // Desglose ordenado de gastos con porcentajes
  const expenseBreakdown: ExpenseCategoryBreakdown[] = Object.entries(expensesByCategory).map(([label, amt]) => ({
    category: label,
    label,
    amount: amt,
    percentage: operatingExpenses > 0 ? roundToCents((amt / operatingExpenses) * 100) : 0,
  })).sort((a, b) => b.amount - a.amount);

  // 8. CÁLCULO FINAL DE MÁRGENES Y TOTALES
  const netRevenue = roundToCents(grossSales - cancelledOrRefunded);
  const grossProfit = roundToCents(netRevenue - totalCogs);
  const grossMarginPercent = netRevenue > 0 ? roundToCents((grossProfit / netRevenue) * 100) : 0;

  const netProfit = roundToCents(grossProfit - operatingExpenses);
  const netMarginPercent = netRevenue > 0 ? roundToCents((netProfit / netRevenue) * 100) : 0;

  // Resumen de métodos de pago con porcentajes
  const totalPayments = Object.values(paymentAmounts).reduce((acc, v) => acc + v, 0);
  const calcShare = (val: number): PaymentMethodShare => ({
    amount: roundToCents(val),
    percentage: totalPayments > 0 ? roundToCents((val / totalPayments) * 100) : 0,
  });

  const paymentBreakdown: PaymentBreakdownSummary = {
    cash: calcShare(paymentAmounts.cash),
    yape: calcShare(paymentAmounts.yape),
    plin: calcShare(paymentAmounts.plin),
    card: calcShare(paymentAmounts.card),
    transfer: calcShare(paymentAmounts.transfer),
    fiado: calcShare(paymentAmounts.fiado),
    other: calcShare(paymentAmounts.other),
    total: roundToCents(totalPayments),
  };

  // Top 10 Productos por Ingresos y por Ganancia
  const allProductMetrics: TopProductMetric[] = Array.from(productMetricsMap.values()).map((p) => {
    const profit = roundToCents(p.revenue - p.cogs);
    return {
      productId: p.productId,
      productName: p.productName,
      sku: p.sku,
      quantitySold: roundToCents(p.quantity),
      revenue: roundToCents(p.revenue),
      cogs: roundToCents(p.cogs),
      profit,
      marginPercent: p.revenue > 0 ? roundToCents((profit / p.revenue) * 100) : 0,
    };
  });

  const topProductsByRevenue = [...allProductMetrics]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const topProductsByProfit = [...allProductMetrics]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10);

  // Rendimiento de Vendedores
  const sellerPerformance: SellerPerformanceMetric[] = Array.from(sellerMetricsMap.values()).map((s) => {
    const profit = roundToCents(s.revenue - s.cogs);
    return {
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      transactionsCount: s.count,
      revenue: roundToCents(s.revenue),
      cogs: roundToCents(s.cogs),
      profit,
      marginPercent: s.revenue > 0 ? roundToCents((profit / s.revenue) * 100) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return {
    accountId,
    branchId: filterBranch,
    startDate: startMs,
    endDate: endMs,
    generatedAt: Date.now(),

    grossSales,
    cancelledOrRefunded,
    netRevenue,
    transactionCount: validTransactionCount,

    cogs: totalCogs,
    grossProfit,
    grossMarginPercent,

    operatingExpenses,
    pettyCashExpenses,
    payrollExpenses,
    expensesByCategory,
    expenseBreakdown,

    netProfit,
    netMarginPercent,

    paymentBreakdown,
    topProductsByRevenue,
    topProductsByProfit,
    sellerPerformance,
  };
}

// ============================================================================
// EXPORTACIÓN EJECUTIVA EN PDF (expo-print & expo-sharing)
// ============================================================================

export async function exportPnlReportPDF(
  report: PnlReportResult,
  businessName: string = 'Mi Negocio',
  branchName: string = 'Sucursal Principal',
  periodLabel: string = 'Período'
): Promise<string> {
  const isProfitable = report.netProfit >= 0;
  const netProfitColor = isProfitable ? '#10B981' : '#EF4444';
  const netMarginSign = report.netMarginPercent >= 0 ? '+' : '';

  // Filas del Top 10 Productos
  const topProductsRows = report.topProductsByProfit.map((prod, idx) => {
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
  const sellerRows = report.sellerPerformance.map((seller) => {
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
  const expenseRows = report.expenseBreakdown.map((exp) => {
    return `
      <tr>
        <td style="font-weight: 500; color: #1F2937;">${exp.label}</td>
        <td style="text-align: right; font-weight: 600; color: #EF4444;">${formatPEN(exp.amount)}</td>
        <td style="text-align: right; color: #4B5563;">${exp.percentage.toFixed(1)}%</td>
      </tr>
    `;
  }).join('');

  // Filas de Métodos de Pago
  const paymentMethodsList = [
    { label: 'Efectivo', data: report.paymentBreakdown.cash, color: '#10B981' },
    { label: 'Yape', data: report.paymentBreakdown.yape, color: '#8B5CF6' },
    { label: 'Plin', data: report.paymentBreakdown.plin, color: '#06B6D4' },
    { label: 'Tarjeta Débito/Crédito', data: report.paymentBreakdown.card, color: '#3B82F6' },
    { label: 'Transferencia Bancaria', data: report.paymentBreakdown.transfer, color: '#F59E0B' },
    { label: 'Fiado / Crédito', data: report.paymentBreakdown.fiado, color: '#F97316' },
    { label: 'Otros Métodos', data: report.paymentBreakdown.other, color: '#6B7280' },
  ].filter((m) => m.data.amount > 0);

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
          <div class="kpi-sub" style="color: #64748B;">${report.transactionCount} ventas efectivas</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Utilidad Bruta</div>
          <div class="kpi-value" style="color: #10B981;">${formatPEN(report.grossProfit)}</div>
          <div class="kpi-sub" style="color: #059669;">Margen Bruto: ${report.grossMarginPercent.toFixed(1)}%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Gastos Operativos</div>
          <div class="kpi-value" style="color: #EF4444;">${formatPEN(report.operatingExpenses)}</div>
          <div class="kpi-sub" style="color: #DC2626;">Caja chica y planilla</div>
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
            <td>(+) Ventas Brutas Totales</td>
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
            <td>(-) Gastos Operativos de Caja Chica</td>
            <td style="text-align: right; color: #EF4444;">-${formatPEN(report.pettyCashExpenses)}</td>
            <td style="text-align: right; color: #64748B;">${report.netRevenue > 0 ? ((report.pettyCashExpenses / report.netRevenue) * 100).toFixed(1) : '0.0'}%</td>
          </tr>
          <tr>
            <td>(-) Gastos de Planilla y Sueldos</td>
            <td style="text-align: right; color: #EF4444;">-${formatPEN(report.payrollExpenses)}</td>
            <td style="text-align: right; color: #64748B;">${report.netRevenue > 0 ? ((report.payrollExpenses / report.netRevenue) * 100).toFixed(1) : '0.0'}%</td>
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

      <!-- 2. DESGLOSE DE COBRANZA Y GASTOS (2 COLUMNAS) -->
      <table style="width: 100%; border: none; margin-bottom: 16px;">
        <tr>
          <td style="width: 50%; vertical-align: top; padding: 0 8px 0 0; border: none;">
            <div class="section-title" style="margin-top: 0;">2. Cobranza por Método de Pago</div>
            <table class="pnl-table">
              <thead>
                <tr>
                  <th>Método</th>
                  <th style="text-align: right;">Cobrado</th>
                  <th style="text-align: right;">%</th>
                </tr>
              </thead>
              <tbody>
                ${paymentRows || '<tr><td colspan="3" style="text-align: center; color: #9CA3AF;">Sin cobros en el período</td></tr>'}
              </tbody>
            </table>
          </td>
          <td style="width: 50%; vertical-align: top; padding: 0 0 0 8px; border: none;">
            <div class="section-title" style="margin-top: 0;">3. Gastos por Categoría</div>
            <table class="pnl-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th style="text-align: right;">Monto</th>
                  <th style="text-align: right;">% Gastos</th>
                </tr>
              </thead>
              <tbody>
                ${expenseRows || '<tr><td colspan="3" style="text-align: center; color: #9CA3AF;">Sin gastos en el período</td></tr>'}
              </tbody>
            </table>
          </td>
        </tr>
      </table>

      <!-- 3. TOP 10 PRODUCTOS POR UTILIDAD APORTADA -->
      <div class="section-title">4. Top 10 Productos Más Rentables</div>
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
          ${topProductsRows || '<tr><td colspan="7" style="text-align: center; color: #9CA3AF;">Sin ventas en el período</td></tr>'}
        </tbody>
      </table>

      <!-- 4. RENDIMIENTO POR VENDEDOR / CAJERO -->
      ${report.sellerPerformance.length > 0 ? `
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
