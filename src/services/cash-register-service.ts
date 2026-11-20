/**
 * Ventify Mobile - Cash Register & Shift Management Service
 * 
 * Gestión integral de sesiones de caja chica y arqueos de turno (Cierre Z).
 * Basado en cash-session-manager de Ventify, adaptado para React Native.
 * Usa la colección oficial `cash_register_movements` (corrigiendo el bug del proyecto anterior)
 * y el puntero determinista `cash_register_sessions/active_${branchId}`.
 */

import { db, auth } from '@/lib/firebase';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { apiRequest } from '@/lib/api-client';
import type { Sale } from '@/types';
import {
  collection,
  doc,
  addDoc,
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  getDocs,
  getDoc,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
  Timestamp,
  limit,
} from 'firebase/firestore';

// ============================================================================
// CONSTANTES DE COLECCIONES
// ============================================================================

const CASH_SESSIONS_COLLECTION = 'cash_register_sessions';
const CASH_MOVEMENTS_COLLECTION = 'cash_register_movements';
const CASH_REPORTS_COLLECTION = 'cash_register_reports';
const SALES_COLLECTION = 'sales';

export const MAX_OPENING_BALANCE = 50_000;

// ============================================================================
// CATEGORÍAS DE GASTO, LÍMITE DE CAJERO Y RENDIMIENTO DE VENDEDORES (PARIDAD WEB)
// ============================================================================

export type ExpenseCategoryId =
  | 'rent'
  | 'utilities'
  | 'logistics'
  | 'maintenance'
  | 'employee_advance'
  | 'other';

export type ExpenseReceiptType = 'ninguno' | 'boleta' | 'factura' | 'recibo';

export interface ExpenseCategory {
  id: ExpenseCategoryId;
  label: string;
  isOperatingExpense: boolean;
}

export const DEFAULT_EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { id: 'rent', label: 'Alquiler', isOperatingExpense: true },
  { id: 'utilities', label: 'Servicios Básicos', isOperatingExpense: true },
  { id: 'logistics', label: 'Movilidad / Flete', isOperatingExpense: true },
  { id: 'maintenance', label: 'Mantenimiento / Limpieza', isOperatingExpense: true },
  { id: 'employee_advance', label: 'Adelanto a Personal', isOperatingExpense: false },
  { id: 'other', label: 'Otro', isOperatingExpense: true },
];

export const EMPLOYEE_ADVANCE_CATEGORY_ID: ExpenseCategoryId = 'employee_advance';

export type ExpensePnlClass = 'operating_expense' | 'income' | 'refund' | 'employee_advance';

const EXPENSE_CATEGORY_BY_ID = new Map(DEFAULT_EXPENSE_CATEGORIES.map((c) => [c.id, c]));
const LEGACY_OPERATING_CATEGORIES = new Set(['expense', 'withdrawal', 'operational', 'other', 'manual_expense', 'petty_cash', 'services', 'supplies']);
const LEGACY_REFUND_CATEGORIES = new Set(['sale_refund', 'reservation_refund', 'order_refund', 'refund', 'return']);

export function expenseCategoryById(id?: string | null): ExpenseCategory | undefined {
  if (!id) return undefined;
  return EXPENSE_CATEGORY_BY_ID.get(id as ExpenseCategoryId);
}

export function expenseCategoryLabel(id?: string | null, fallbackCategory?: string | null): string {
  const fromCatalog = expenseCategoryById(id) || expenseCategoryById(fallbackCategory);
  if (fromCatalog) return fromCatalog.label;
  switch (String(fallbackCategory || '').toLowerCase()) {
    case 'income':
    case 'manual_income':
      return 'Ingreso Extra';
    case 'expense':
    case 'manual_expense':
      return 'Gasto';
    case 'withdrawal':
      return 'Egreso';
    case 'operational':
      return 'Operacional';
    case 'petty_cash':
      return 'Caja Chica';
    case 'services':
      return 'Servicios';
    case 'supplies':
      return 'Insumos';
    case 'payroll_advance':
      return 'Adelanto a Personal';
    case 'sale_refund':
    case 'reservation_refund':
    case 'order_refund':
    case 'refund':
    case 'return':
      return 'Devolución';
    case 'other':
      return 'Otro';
    default:
      return fallbackCategory || 'Otro';
  }
}

/** Classifies a cash movement for P&L reporting without rewriting historical documents. */
export function classifyMovementForPnl(input: {
  type?: string | null;
  amount?: number | null;
  category?: string | null;
  expenseCategoryId?: string | null;
  isEmployeeAdvance?: boolean | null;
}): ExpensePnlClass {
  if (input.isEmployeeAdvance === true) return 'employee_advance';

  const catalog = expenseCategoryById(input.expenseCategoryId || undefined);
  if (catalog) {
    return catalog.isOperatingExpense ? 'operating_expense' : 'employee_advance';
  }

  const category = String(input.category || '').toLowerCase();
  const asCatalog = expenseCategoryById(category);
  if (asCatalog) {
    return asCatalog.isOperatingExpense ? 'operating_expense' : 'employee_advance';
  }

  if (category === 'payroll_advance') return 'employee_advance';
  if (category === 'income' || category === 'manual_income' || category === 'opening' || category === 'sale' || category === 'deposit' || category === 'fiado_payment') {
    return 'income';
  }
  if (LEGACY_REFUND_CATEGORIES.has(category)) return 'refund';
  if (input.type === 'income' && !LEGACY_OPERATING_CATEGORIES.has(category)) return 'income';
  if (!category && Number(input.amount || 0) > 0) return 'income';
  return 'operating_expense';
}

export function isEmployeeAdvanceMovement(input: {
  type?: string | null;
  amount?: number | null;
  category?: string | null;
  expenseCategoryId?: string | null;
  isEmployeeAdvance?: boolean | null;
}): boolean {
  return classifyMovementForPnl(input) === 'employee_advance';
}

/** Mirrors Firestore `withinCashierExpenseLimit` using signed expense amount (negative for outflows). */
export function withinCashierExpenseLimit(
  amount: number,
  session: { cashierExpenseLimit?: number } | null | undefined
): boolean {
  if (amount >= 0) return true;
  if (!session || session.cashierExpenseLimit == null) return true;
  const limitVal = Number(session.cashierExpenseLimit);
  if (!Number.isFinite(limitVal) || limitVal <= 0) return true;
  return Math.abs(amount) <= limitVal;
}

export function cashierNeedsPinAuthorization(
  role: string | undefined,
  amount: number,
  session: { cashierExpenseLimit?: number } | null | undefined
): boolean {
  if (role !== 'cashier') return false;
  return !withinCashierExpenseLimit(amount, session);
}

export interface SellerRefundInput {
  originalSaleId?: string;
  sellerId?: string;
  sellerName?: string;
  amount: number;
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
  version: 1;
  rows: SellerPerformanceRow[];
  totalNet: number;
  totalGross: number;
  totalRefunds: number;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** Aggregates commercial gross, refunds and net sales per attributed seller matching web seller-performance. */
export function computeSellerPerformance(
  sales: Array<Partial<Sale> & Record<string, any>>,
  refunds: SellerRefundInput[] = []
): SellerPerformanceReport {
  const rows = new Map<string, SellerPerformanceRow>();
  const getRow = (sellerId?: string, sellerName?: string): SellerPerformanceRow => {
    const key = sellerId || '__unassigned__';
    let row = rows.get(key);
    if (!row) {
      row = {
        sellerId: sellerId || null,
        sellerName: sellerId ? sellerName || 'Vendedor sin nombre' : 'Sin vendedor asignado',
        gross: 0,
        refunds: 0,
        net: 0,
        salesCount: 0,
        participation: null,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const sale of sales) {
    if (
      sale.isDepositPayment ||
      sale.isStaffConsumption ||
      sale.documentType === 'cot' ||
      sale.status === 'pending' ||
      sale.status === 'cancelled'
    ) {
      continue;
    }
    const row = getRow(sale.sellerId, sale.sellerName);
    if (sale.isReturn) {
      row.refunds += Math.abs(Number(sale.refundAmount ?? sale.total ?? 0) || 0);
      continue;
    }
    row.gross += Number(sale.originalTotal ?? (sale as any).depositInfo?.originalTotal ?? sale.total ?? 0) || 0;
    row.salesCount += 1;
  }

  for (const refund of refunds) {
    getRow(refund.sellerId, refund.sellerName).refunds += Math.abs(Number(refund.amount) || 0);
  }

  const result = [...rows.values()].map((r) => ({
    ...r,
    gross: round2(r.gross),
    refunds: round2(r.refunds),
    net: round2(r.gross - r.refunds),
  }));

  const totalNet = round2(result.reduce((n, r) => n + r.net, 0));
  for (const r of result) {
    r.participation = totalNet > 0 ? Math.round(((r.net / totalNet) * 100) * 100) / 100 : null;
  }

  return {
    version: 1,
    rows: result.sort((a, b) => b.net - a.net),
    totalNet,
    totalGross: round2(result.reduce((n, r) => n + r.gross, 0)),
    totalRefunds: round2(result.reduce((n, r) => n + r.refunds, 0)),
  };
}

// ============================================================================
// TIPOS E INTERFACES
// ============================================================================

export type CashMovementType = 'income' | 'expense';

export type CashMovementCategory =
  | 'opening'
  | 'sale'
  | 'refund'
  | 'manual_income'
  | 'manual_expense'
  | 'petty_cash'
  | 'services'
  | 'supplies'
  | 'payroll_advance'
  | 'fiado_payment'
  | 'deposit'
  | ExpenseCategoryId
  | string;

export interface CashSession {
  id: string;
  accountId: string;
  branchId: string;
  startedBy: string;
  startedByName: string;
  initialAmount: number;
  openingBalance: number;
  status: 'open' | 'closed';
  openedAt: number | Timestamp;
  closedAt?: number | Timestamp;
  closeTime?: number;
  notes?: string;
  cashSales?: number;
  cardSales?: number;
  digitalSales?: number;
  creditSales?: number;
  totalSales?: number;
  totalIncome?: number;
  totalExpenses?: number;
  totalReservationDeposits?: number;
  reservationDepositsCount?: number;
  cashReservationDeposits?: number;
  cardReservationDeposits?: number;
  digitalReservationDeposits?: number;
  chequeReservationDeposits?: number;
  totalOrderDeposits?: number;
  orderDepositsCount?: number;
  cashOrderDeposits?: number;
  cardOrderDeposits?: number;
  digitalOrderDeposits?: number;
  chequeOrderDeposits?: number;
  totalRefunds?: number;
  totalCommissionAmount?: number;
  totalSurchargeAmount?: number;
  auditRevision?: number;
  expectedAmount?: number;
  countedAmount?: number;
  difference?: number;
  transactionCount?: number;
  closedBy?: string;
  closedByName?: string;
  cashierExpenseLimit?: number;
}

export interface CashMovement {
  id: string;
  sessionId: string;
  accountId: string;
  branchId: string;
  type?: CashMovementType;
  category: CashMovementCategory;
  amount: number;
  description: string;
  reason?: string;
  expenseCategoryId?: ExpenseCategoryId | string | null;
  isEmployeeAdvance?: boolean;
  employeeId?: string;
  receiptType?: ExpenseReceiptType | string;
  receiptNumber?: string;
  saleId?: string;
  sellerId?: string;
  sellerName?: string;
  attributionVersion?: number;
  paymentMethod?: string;
  method?: string;
  refundAmount?: number;
  originalPaymentMethod?: string;
  createdBy: string;
  createdByName: string;
  createdAt: number | Timestamp;
}

export interface OpenCashSessionParams {
  accountId: string;
  branchId: string;
  userId: string;
  userName: string;
  openingBalance: number;
  notes?: string;
}

export interface RegisterCashMovementParams {
  accountId: string;
  branchId: string;
  sessionId: string;
  type: CashMovementType;
  amount: number;
  category?: CashMovementCategory;
  description: string;
  reason?: string;
  expenseCategoryId?: ExpenseCategoryId;
  employeeId?: string;
  receiptType?: ExpenseReceiptType;
  receiptNumber?: string;
  userId: string;
  userName: string;
  userRole?: string;
}

export interface AuthorizeExpenseParams {
  sessionId: string;
  amount: number;
  reason: string;
  expenseCategoryId?: ExpenseCategoryId;
  employeeId?: string;
  receiptType?: ExpenseReceiptType;
  receiptNumber?: string;
  pin: string;
}

export interface DigitalSalesBreakdown {
  yape: number;
  plin: number;
  card: number;
  transfer: number;
  totalDigital: number;
}

export interface CashAuditResult {
  openingBalance: number;
  cashSales: number;
  cardSales: number;
  digitalSales: DigitalSalesBreakdown;
  creditSales: number;
  totalSales: number;
  salesCount: number;
  manualIncomes: number;
  manualExpenses: number;
  cashRefunds: number;
  totalRefunds: number;
  refundCount: number;
  cashDeposits: number;
  cardDeposits: number;
  digitalDeposits: number;
  totalCommissionAmount: number;
  totalSurchargeAmount: number;
  expectedCashInDrawer: number;
}

const paymentAmountForAudit = (split: { amount?: number; chargedAmount?: number }): number => {
  const chargedAmount = Number(split.chargedAmount);
  if (Number.isFinite(chargedAmount) && chargedAmount >= 0) return chargedAmount;
  const amount = Number(split.amount);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
};

export const cashAuditSnapshotMatches = (calculated: CashSession, current: CashSession): boolean => {
  const fields: Array<keyof CashSession> = [
    'expectedAmount', 'cashSales', 'cardSales', 'digitalSales', 'creditSales',
    'totalSales', 'totalIncome', 'totalExpenses', 'transactionCount',
    'initialAmount', 'openingBalance',
    'auditRevision',
    'totalReservationDeposits', 'reservationDepositsCount', 'cashReservationDeposits',
    'cardReservationDeposits', 'digitalReservationDeposits', 'chequeReservationDeposits',
    'totalOrderDeposits', 'orderDepositsCount', 'cashOrderDeposits', 'cardOrderDeposits',
    'digitalOrderDeposits', 'chequeOrderDeposits', 'totalRefunds',
    'totalCommissionAmount', 'totalSurchargeAmount',
  ];
  return fields.every((field) => Number(calculated[field] || 0) === Number(current[field] || 0));
};

/** Clear an operator pointer only when it still points at the session being closed. */
export const clearActiveCashSessionPointer = async (pointerRef: any, closedSessionId: string): Promise<void> => {
  await runTransaction(db, async (tx) => {
    const pointerSnap = await tx.get(pointerRef);
    if (!pointerSnap.exists()) return;
    const pointer: any = pointerSnap.data();
    if ((pointer?.activeSessionId ?? pointer?.sessionId) === closedSessionId) {
      tx.delete(pointerRef);
    }
  });
};

export interface CloseCashSessionParams {
  accountId: string;
  branchId: string;
  sessionId: string;
  countedCash?: number;
  countedAmount?: number;
  notes?: string;
  closedBy?: string;
  closedByName?: string;
  userId?: string;
  userName?: string;
}

export interface CloseCashSessionResult {
  sessionId: string;
  reportId: string;
  countedCash: number;
  expectedCash: number;
  difference: number;
  audit: CashAuditResult;
  closedAt: Date;
}

// ============================================================================
// SERVICIOS DE CAJA REGISTRADORA
// ============================================================================

/**
 * Abre una nueva sesión de caja registradora, configura el puntero de sucursal
 * y crea el movimiento de balance inicial en cash_register_movements.
 */
export const openCashSession = async (
  params: OpenCashSessionParams
): Promise<CashSession> => {
  const { accountId, branchId, userId, userName, openingBalance, notes } = params;

  if (!accountId || !branchId || !userId) {
    throw new Error('Parámetros obligatorios faltantes para abrir caja.');
  }

  if (typeof openingBalance !== 'number' || openingBalance < 0 || isNaN(openingBalance)) {
    throw new Error('El saldo inicial de caja debe ser un número mayor o igual a cero.');
  }

  if (openingBalance > MAX_OPENING_BALANCE) {
    throw new Error(
      `El saldo inicial (S/ ${openingBalance.toFixed(2)}) supera el límite de seguridad (S/ ${MAX_OPENING_BALANCE.toFixed(2)}).`
    );
  }

  // Snapshot del tope de egresos para cajeros de settings/${accountId}_expenses
  let cashierExpenseLimit: number | undefined;
  try {
    const expensesRef = doc(db, 'settings', `${accountId}_expenses`);
    const expensesSnap = await getDoc(expensesRef);
    if (expensesSnap.exists()) {
      const limitVal = Number(expensesSnap.data()?.cashierExpenseLimit);
      if (Number.isFinite(limitVal) && limitVal > 0) {
        cashierExpenseLimit = limitVal;
      }
    }
  } catch (expErr) {
    console.warn('[CashRegisterService] Error reading cashierExpenseLimit:', expErr);
  }

  const userPointerId = `active_${accountId}_${branchId}_${userId}`;
  const userPointerRef = doc(db, CASH_SESSIONS_COLLECTION, userPointerId);
  const sessionId = `session_${accountId}_${branchId}_${Date.now()}`;
  const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);

  const createdSession = await runTransaction(db, async (tx) => {
    // 1. Verificar si este operador específico ya tiene una caja abierta
    const userPointerSnap = await tx.get(userPointerRef);
    if (userPointerSnap.exists() && userPointerSnap.data()?.status === 'open') {
      const activeId = userPointerSnap.data()?.activeSessionId;
      if (activeId) {
        const activeSnap = await tx.get(doc(db, CASH_SESSIONS_COLLECTION, activeId));
        if (activeSnap.exists() && activeSnap.data()?.status === 'open') {
          throw new Error('Ya tienes un turno de caja abierto en esta sucursal. Ciérralo antes de abrir uno nuevo.');
        }
      }
    }

    // 2. Crear documento de sesión
    const sessionData = {
      id: sessionId,
      accountId,
      branchId,
      startedBy: userId,
      startedByName: userName,
      initialAmount: Math.round(openingBalance * 100) / 100,
      openingBalance: Math.round(openingBalance * 100) / 100,
      status: 'open',
      openedAt: serverTimestamp(),
      openTime: serverTimestamp(),
      notes: notes || '',
      cashSales: 0,
      cardSales: 0,
      digitalSales: 0,
      totalSales: 0,
      totalIncome: 0,
      totalExpenses: 0,
      expectedAmount: Math.round(openingBalance * 100) / 100,
      transactionCount: 0,
      ...(cashierExpenseLimit !== undefined ? { cashierExpenseLimit } : {}),
    };

    tx.set(sessionRef, sessionData);

    // 3. Configurar puntero por operador (multicajas como en la web)
    tx.set(userPointerRef, {
      activeSessionId: sessionId,
      accountId,
      branchId,
      startedBy: userId,
      startedByName: userName,
      initialAmount: Math.round(openingBalance * 100) / 100,
      status: 'open',
      openedAt: serverTimestamp(),
      lastUpdated: serverTimestamp(),
    });

    return {
      ...sessionData,
      openedAt: Date.now(),
    } as CashSession;
  });

  // Movimiento de apertura registrado fuera de la transacción para cumplir con las reglas de Firestore
  if (openingBalance > 0) {
    try {
      await addDoc(collection(db, CASH_MOVEMENTS_COLLECTION), {
        sessionId,
        accountId,
        branchId,
        type: 'income',
        category: 'opening',
        amount: Math.round(openingBalance * 100) / 100,
        description: 'Monto de apertura de caja',
        createdBy: userId,
        createdByName: userName,
        createdAt: serverTimestamp(),
      });
    } catch (movErr) {
      console.warn('[CashRegisterService] Movimiento de apertura diferido:', movErr);
    }
  }

  return createdSession;
};

const toMillisValue = (val: unknown): number => {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, any>;
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return 0;
};

/**
 * Lista todas las sesiones abiertas en una sucursal de forma determinista:
 * excluye punteros `active_*` y prioriza primero la sesión iniciada por `preferredUserId`,
 * seguida de las más recientes por fecha de apertura.
 */
export const getBranchOpenSessions = async (
  accountId: string,
  branchId: string,
  preferredUserId?: string
): Promise<CashSession[]> => {
  if (!accountId || !branchId) return [];
  const openQ = query(
    collection(db, CASH_SESSIONS_COLLECTION),
    where('accountId', '==', accountId),
    where('branchId', '==', branchId),
    where('status', '==', 'open')
  );
  const snap = await getDocs(openQ);
  const sessions: CashSession[] = snap.docs
    .filter((d) => !d.id.startsWith('active_'))
    .map((d) => ({
      id: d.id,
      ...(d.data() as any),
    }));

  sessions.sort((a, b) => {
    if (preferredUserId) {
      const aOwn = a.startedBy === preferredUserId ? 1 : 0;
      const bOwn = b.startedBy === preferredUserId ? 1 : 0;
      if (aOwn !== bOwn) return bOwn - aOwn;
    }
    const diff = toMillisValue(b.openedAt) - toMillisValue(a.openedAt);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });

  return sessions;
};

/**
 * Consulta la sesión activa para una sucursal dada a través del puntero de operador o query
 */
export const getActiveCashSession = async (
  branchId: string,
  accountId?: string,
  userId?: string
): Promise<CashSession | null> => {
  try {
    let activeSessionId: string | null = null;
    let prefetchedSessionDoc: { id: string; data: Record<string, any> } | null = null;

    // 1. Probar puntero del usuario/operador si se proporcionan accountId y userId
    if (accountId && userId) {
      const userPointerRef = doc(db, CASH_SESSIONS_COLLECTION, `active_${accountId}_${branchId}_${userId}`);
      const userPointerSnap = await getDoc(userPointerRef);
      if (userPointerSnap.exists()) {
        const uData = userPointerSnap.data();
        if (uData.status === 'open' && uData.activeSessionId) {
          activeSessionId = uData.activeSessionId;
        }
      }

      // Si no hay puntero pero sí userId, buscar en la colección por startedBy
      if (!activeSessionId) {
        const userSessionQ = query(
          collection(db, CASH_SESSIONS_COLLECTION),
          where('accountId', '==', accountId),
          where('branchId', '==', branchId),
          where('status', '==', 'open'),
          where('startedBy', '==', userId),
          limit(1)
        );
        const userSessionSnap = await getDocs(userSessionQ);
        if (!userSessionSnap.empty) {
          const docSnap = userSessionSnap.docs[0];
          activeSessionId = docSnap.id;
          prefetchedSessionDoc = { id: docSnap.id, data: docSnap.data() };
        }
      }

      // Si el operador específico no tiene sesión abierta, retornar null (sin fallback a otro usuario)
      if (!activeSessionId) {
        return null;
      }
    } else if (accountId) {
      // 2. Si no se especificó un operador pero sí la cuenta, seleccionar sesión determinista
      const openSessions = await getBranchOpenSessions(accountId, branchId);
      return openSessions[0] ?? null;
    }

    if (!activeSessionId) return null;

    let sessionIdResolved = prefetchedSessionDoc?.id;
    let data = prefetchedSessionDoc?.data;

    if (!data) {
      const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, activeSessionId);
      const sessionSnap = await getDoc(sessionRef);
      if (!sessionSnap.exists()) {
        return null;
      }
      sessionIdResolved = sessionSnap.id;
      data = sessionSnap.data();
    }

    if (data?.status !== 'open') {
      return null;
    }

    // Si se solicitó un usuario específico, verificar que startedBy coincida
    if (userId && data.startedBy && data.startedBy !== userId) {
      return null;
    }

    return {
      id: sessionIdResolved!,
      ...data,
    } as CashSession;
  } catch (err) {
    console.warn('[CashRegisterService] Error al obtener sesión activa:', err);
    return null;
  }
};

/**
 * Autoriza un egreso que supera `cashierExpenseLimit` mediante el PIN de supervisor en `/api/expenses/authorize`.
 */
export const authorizeCashExpenseViaPin = async (
  params: AuthorizeExpenseParams
): Promise<{ success: boolean; movementId?: string }> => {
  const { sessionId, amount, reason, expenseCategoryId, employeeId, receiptType, receiptNumber, pin } = params;
  return apiRequest<{ success: boolean; movementId?: string }>('/api/expenses/authorize', {
    method: 'POST',
    body: {
      sessionId,
      amount: Math.abs(amount),
      reason: reason.trim(),
      ...(expenseCategoryId ? { expenseCategoryId } : {}),
      ...(expenseCategoryId === EMPLOYEE_ADVANCE_CATEGORY_ID && employeeId ? { employeeId } : {}),
      ...(receiptType ? { receiptType } : {}),
      ...(receiptNumber?.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
      pin,
    },
  });
};

/**
 * Registra un movimiento manual de caja chica (ingreso o egreso) en cash_register_movements
 * y actualiza de forma atómica el saldo esperado en la sesión de caja.
 */
export const registerCashMovement = async (
  params: RegisterCashMovementParams
): Promise<string> => {
  const {
    accountId,
    branchId,
    sessionId,
    type,
    amount,
    category,
    description,
    reason,
    expenseCategoryId,
    employeeId,
    receiptType,
    receiptNumber,
    userId,
    userName,
    userRole,
  } = params;

  if (!sessionId || !accountId || !branchId) {
    throw new Error('Identificadores de cuenta, sucursal y sesión requeridos.');
  }

  if (typeof amount !== 'number' || amount <= 0 || isNaN(amount)) {
    throw new Error('El monto del movimiento debe ser un valor numérico positivo.');
  }

  const effectiveReason = (reason ?? description ?? '').trim();
  if (effectiveReason.length === 0) {
    throw new Error('Debe especificar una descripción o motivo para el movimiento.');
  }

  const isAdvance = type === 'expense' && expenseCategoryId === EMPLOYEE_ADVANCE_CATEGORY_ID;
  if (isAdvance && !employeeId) {
    throw new Error('Selecciona el trabajador para un adelanto a personal.');
  }

  const resolvedCategory =
    category ||
    (type === 'income' ? 'manual_income' : expenseCategoryId || 'manual_expense');

  const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
  const movementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
  const movementId = movementRef.id;

  const normalizedAmount = Math.round(amount * 100) / 100;
  const signedAmount = type === 'expense' ? -normalizedAmount : normalizedAmount;

  await runTransaction(db, async (tx) => {
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists()) {
      throw new Error(`La sesión de caja "${sessionId}" no existe.`);
    }

    const sData = sessionSnap.data();
    if (sData.status !== 'open') {
      throw new Error('No se pueden registrar movimientos en una sesión de caja cerrada.');
    }

    // Validar límite de egresos para cajeros si la sesión lo especifica (withinCashierExpenseLimit de firestore.rules)
    if (
      type === 'expense' &&
      (!userRole || userRole === 'cashier') &&
      typeof sData.cashierExpenseLimit === 'number' &&
      sData.cashierExpenseLimit > 0
    ) {
      if (normalizedAmount > sData.cashierExpenseLimit) {
        throw new Error(
          `El egreso (S/ ${normalizedAmount.toFixed(2)}) supera el límite máximo permitido para cajeros (S/ ${sData.cashierExpenseLimit.toFixed(2)}).`
        );
      }
    }

    // 1. Insertar movimiento en cash_register_movements (compatibilidad móvil + web /gastos)
    const movementPayload: Record<string, any> = {
      id: movementId,
      sessionId,
      accountId,
      branchId,
      type,
      category: resolvedCategory,
      amount: signedAmount,
      description: effectiveReason,
      reason: effectiveReason,
      createdBy: userId,
      createdByName: userName,
      createdAt: serverTimestamp(),
    };
    if (type === 'expense' && expenseCategoryId) {
      movementPayload.expenseCategoryId = expenseCategoryId;
      movementPayload.isEmployeeAdvance = isAdvance;
    }
    if (isAdvance && employeeId) {
      movementPayload.employeeId = employeeId;
    }
    if (type === 'expense' && receiptType) {
      movementPayload.receiptType = receiptType;
    }
    if (type === 'expense' && receiptNumber?.trim()) {
      movementPayload.receiptNumber = receiptNumber.trim();
    }

    tx.set(movementRef, movementPayload);

    // 2. Actualizar sesión de caja
    const currentExpected = sData.expectedAmount || sData.initialAmount || 0;
    const currentIncome = sData.totalIncome || 0;
    const currentExpenses = sData.totalExpenses || 0;

    tx.update(sessionRef, {
      expectedAmount: Math.round((currentExpected + signedAmount) * 100) / 100,
      totalIncome: type === 'income' ? Math.round((currentIncome + normalizedAmount) * 100) / 100 : currentIncome,
      totalExpenses: type === 'expense' ? Math.round((currentExpenses + normalizedAmount) * 100) / 100 : currentExpenses,
      updatedAt: serverTimestamp(),
    });
  });

  return movementId;
};

/**
 * Obtiene todos los movimientos registrados para una sesión en cash_register_movements
 */
export const getSessionMovements = async (
  accountId: string,
  branchId: string,
  sessionId: string
): Promise<CashMovement[]> => {
  try {
    const coll = collection(db, CASH_MOVEMENTS_COLLECTION);
    const q = query(
      coll,
      where('sessionId', '==', sessionId),
      where('accountId', '==', accountId)
    );

    const snapshot = await getDocs(q);
    const movements: CashMovement[] = snapshot.docs.map((d) => {
      const data = d.data();
      const text = data.reason || data.description || '';
      return {
        id: d.id,
        sessionId: data.sessionId,
        accountId: data.accountId,
        branchId: data.branchId,
        type: data.type,
        category: data.category,
        amount: data.amount,
        description: text,
        reason: text,
        expenseCategoryId: data.expenseCategoryId,
        isEmployeeAdvance: data.isEmployeeAdvance,
        employeeId: data.employeeId,
        receiptType: data.receiptType,
        receiptNumber: data.receiptNumber,
        saleId: data.saleId,
        sellerId: data.sellerId,
        sellerName: data.sellerName,
        attributionVersion: data.attributionVersion,
        paymentMethod: data.paymentMethod,
        method: data.method,
        refundAmount: data.refundAmount,
        originalPaymentMethod: data.originalPaymentMethod,
        createdBy: data.createdBy,
        createdByName: data.createdByName,
        createdAt: data.createdAt,
      };
    });

    // Ordenar cronológicamente ascendente
    movements.sort((a, b) => toMillisValue(a.createdAt) - toMillisValue(b.createdAt));

    return movements;
  } catch (err) {
    console.error('[CashRegisterService] Error obteniendo movimientos de sesión:', err);
    throw err;
  }
};

/**
 * Calcula el arqueo completo de caja (Cierre Z) cruzando ventas, movimientos y saldo inicial
 */
export const calculateCashAudit = (
  session: CashSession,
  movements: CashMovement[],
  sales: any[]
): CashAuditResult => {
  const openingBalance = session.initialAmount || session.openingBalance || 0;

  // Las devoluciones de una venta anulada ya no tienen una venta física que
  // revertir en este arqueo. Ignorar también su movimiento compensatorio.
  const validSales: any[] = [];
  const cancelledSaleIds = new Set<string>();
  const salesById = new Map<string, Sale & Record<string, any>>();
  for (const s of sales) {
    const id = String(s?.id || '');
    if (id && !salesById.has(id)) {
      salesById.set(id, s);
    }
    if (s?.status === 'cancelled') {
      if (id) cancelledSaleIds.add(id);
    } else if (!s?.isReturn && (s?.sessionId === session.id || !s?.sessionId)) {
      validSales.push(s);
    }
  }
  const isDepositPayment = (sale: any): boolean => sale.isDepositPayment === true;
  const isCashMethod = (value: unknown): boolean => {
    const method = String(value || '').toLowerCase();
    return method === 'cash' || method.includes('efectivo') || method.includes('cash');
  };
  const chargedAmount = (sale: any): number => {
    if (sale.amountReceived != null) {
      const received = Number(sale.amountReceived);
      if (Number.isFinite(received) && received >= 0) return received;
    }
    if (sale.chargedAmount != null) {
      const charged = Number(sale.chargedAmount);
      if (Number.isFinite(charged) && charged >= 0) return charged;
    }
    if (sale.depositInfo?.remainingAmount != null) {
      const remaining = Number(sale.depositInfo.remainingAmount);
      if (Number.isFinite(remaining) && remaining >= 0) return remaining;
    }
    if (sale.total == null) return 0;
    const total = Number(sale.total);
    return Number.isFinite(total) && total >= 0 ? total : 0;
  };
  const depositCashFromSale = (sale: any): number => {
    if (Array.isArray(sale.payments) && sale.payments.length > 0) {
      return sale.payments.reduce(
        (sum: number, split: any) => sum + (split.category === 'cash' ? paymentAmountForAudit(split) : 0),
        0
      );
    }
    if (typeof sale.cashAmount === 'number' && sale.cashAmount >= 0) return sale.cashAmount;
    if (sale.paymentCategory === 'cash' || isCashMethod(sale.paymentMethod) || isCashMethod(sale.paymentMethodId)) {
      return chargedAmount(sale);
    }
    return 0;
  };

  const depositSales = validSales.filter(isDepositPayment);
  const commercialSales = validSales.filter((s) => !isDepositPayment(s));
  // Los contadores de sesión son autoridad para los adelantos porque ya
  // incorporan sus reembolsos. Si no existen en una sesión legacy, derivarlos
  // de las ventas de depósito disponibles.
  const depositCountersPresent =
    typeof session.cashReservationDeposits === 'number' || typeof session.cashOrderDeposits === 'number';
  const cashDeposits = depositCountersPresent
    ? (session.cashReservationDeposits || 0) + (session.cashOrderDeposits || 0)
    : depositSales.reduce((sum, sale) => sum + depositCashFromSale(sale), 0);
  const cardDeposits = (session.cardReservationDeposits || 0) + (session.cardOrderDeposits || 0);
  const digitalDeposits = (session.digitalReservationDeposits || 0) + (session.digitalOrderDeposits || 0);

  let cashSales = 0;
  let creditSales = 0;
  const digitalSales: DigitalSalesBreakdown = {
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    totalDigital: 0,
  };

  for (const sale of commercialSales) {
    const total = chargedAmount(sale);
    const pMethod = (sale.paymentMethod || '').toLowerCase();

    // 1. Desglose si tiene pagos mixtos v2
    if (Array.isArray(sale.payments) && sale.payments.length > 0) {
      for (const split of sale.payments) {
        const cat = split.category || '';
        const amt = paymentAmountForAudit(split);
        const provider = (split.digitalProvider || '').toLowerCase();

        if (cat === 'cash') {
          cashSales += amt;
        } else if (cat === 'card') {
          digitalSales.card += amt;
        } else if (cat === 'digital') {
          if (provider === 'yape') digitalSales.yape += amt;
          else if (provider === 'plin') digitalSales.plin += amt;
          else digitalSales.transfer += amt;
        } else if (cat === 'credit') {
          creditSales += amt;
        }
      }
    } else {
      // 2. Desglose tradicional
      if (sale.paymentCategory === 'cash' || isCashMethod(pMethod) || isCashMethod(sale.paymentMethodId)) {
        cashSales += total;
      } else if (sale.paymentCategory === 'card' || pMethod === 'tarjeta' || pMethod === 'card') {
        digitalSales.card += total;
      } else if (pMethod === 'yape' || sale.digitalProvider === 'yape') {
        digitalSales.yape += total;
      } else if (pMethod === 'plin' || sale.digitalProvider === 'plin') {
        digitalSales.plin += total;
      } else if (pMethod === 'transferencia' || sale.paymentCategory === 'digital') {
        digitalSales.transfer += total;
      } else if (pMethod === 'fiado' || pMethod === 'credit' || sale.paymentCategory === 'credit') {
        creditSales += total;
      } else {
        // En caso de tener cashAmount explícito
        if (typeof sale.cashAmount === 'number' && sale.cashAmount > 0) {
          cashSales += sale.cashAmount;
        }
        if (typeof sale.cardAmount === 'number' && sale.cardAmount > 0) {
          digitalSales.card += sale.cardAmount;
        }
      }
    }
  }

  digitalSales.totalDigital =
    digitalSales.yape + digitalSales.plin + digitalSales.card + digitalSales.transfer;

  const totalSales = cashSales + digitalSales.totalDigital + creditSales;

  // Movimientos de caja manuales y devoluciones (paridad web + móvil)
  let manualIncomes = 0;
  let manualExpenses = 0;
  let cashRefunds = 0;
  let totalRefunds = 0;
  let anonymousRefundCount = 0;
  const refundEventIds = new Set<string>();
  let cashDepositRefundAdjustments = 0;

  for (const m of movements) {
    const rawAmount = Number(m.amount) || 0;
    const amt = Math.abs(rawAmount);
    const category = String(m.category || '').toLowerCase();
    const method = (m as any).method ?? m.paymentMethod;
    const isDepositRefund = category === 'reservation_refund' || category === 'order_refund';
    const isRefund = isDepositRefund || category === 'sale_refund' || category === 'refund' || category === 'return';

    if (isRefund) {
      if (!isDepositRefund && m.saleId && cancelledSaleIds.has(String(m.saleId))) continue;

      const explicitRefund = Number(m.refundAmount);
      const hasExplicitRefund = Number.isFinite(explicitRefund) && explicitRefund > 0;
      const refundMetricAmount = hasExplicitRefund ? explicitRefund : amt;

      if (refundMetricAmount > 0) {
        totalRefunds += refundMetricAmount;
        const baseEventId = String(m.id || '').replace(/_(cash|card|digital|credit|audit)$/, '');
        if (baseEventId) {
          refundEventIds.add(baseEventId);
        } else {
          anonymousRefundCount += 1;
        }
      }

      // Adelantos ya ajustaron sus contadores de sesión. Para devoluciones de
      // venta, la categoría es el contrato canónico aunque `type` no exista.
      if (isDepositRefund) {
        // El contador de depósito ya revierte devoluciones del método original.
        // Solo sale efectivo extra cuando se devuelve en efectivo un adelanto
        // originalmente cobrado por un medio no físico.
        const originalMethod = (m as any).originalPaymentMethod;
        const refundAmount = Math.abs(Number(m.refundAmount) || Number(m.amount) || 0);
        if (refundAmount > 0 && originalMethod) {
          if (isCashMethod(originalMethod) && !isCashMethod(method)) {
            // El saldo cash del depósito ya bajó, aunque el efectivo se quedó.
            cashDepositRefundAdjustments += refundAmount;
          } else if (!isCashMethod(originalMethod) && isCashMethod(method)) {
            // El depósito original no estaba en esta caja física; ahora sí sale efectivo.
            cashRefunds += refundAmount;
          }
        }
        continue;
      }

      // Excluir movimientos de auditoría sin salida física de caja (ej. method: 'No aplicar', amount: 0, refundAmount > 0)
      if (rawAmount === 0 && hasExplicitRefund) {
        continue;
      }

      const linkedSale = m.saleId ? salesById.get(String(m.saleId)) : undefined;
      const linkedMethod = linkedSale?.paymentMethod || linkedSale?.paymentCategory || linkedSale?.paymentMethodId;
      const isCashRefundOutflow = rawAmount < 0 || (m.type === 'expense' && rawAmount > 0);
      if (isCashRefundOutflow && (isCashMethod(method || linkedMethod) || (!method && !linkedMethod))) {
        cashRefunds += amt;
      }
      continue;
    }

    if (category === 'opening' || category === 'sale') continue;
    // Si la sesión lleva contadores de adelantos, evitar doble conteo con movimientos espejo legacy
    if (depositCountersPresent && (category === 'deposit' || category === 'fiado_payment')) continue;

    // Resolver dirección del movimiento tanto para documentos móviles (`type`) como web (solo signo de `amount`)
    const effectiveType: CashMovementType | null =
      m.type === 'income' || m.type === 'expense'
        ? m.type
        : category === 'income' || category === 'manual_income' || rawAmount > 0
          ? 'income'
          : rawAmount < 0
            ? 'expense'
            : null;

    if (effectiveType === 'income' && (isCashMethod(method) || !method)) {
      manualIncomes += amt;
    } else if (effectiveType === 'expense' && (isCashMethod(method) || !method)) {
      manualExpenses += amt;
    }
  }

  const totalCommissionAmount =
    validSales.length > 0
      ? validSales.reduce((sum, s) => sum + (Number(s.commissionAmount) || 0), 0)
      : Number(session.totalCommissionAmount || 0);
  const totalSurchargeAmount =
    validSales.length > 0
      ? validSales.reduce((sum, s) => sum + (Number(s.surchargeAmount) || 0), 0)
      : Number(session.totalSurchargeAmount || 0);

  // Fórmula matemática del arqueo físico de efectivo:
  // Saldo Apertura + Ventas Efectivo + Depósitos Efectivo + Ajustes + Ingresos Manuales - Gastos Manuales - Devoluciones Efectivo
  const expectedCashInDrawer = round2(
    openingBalance +
      cashSales +
      cashDeposits +
      cashDepositRefundAdjustments +
      manualIncomes -
      manualExpenses -
      cashRefunds
  );

  return {
    openingBalance: round2(openingBalance),
    cashSales: round2(cashSales),
    cardSales: round2(digitalSales.card),
    digitalSales: {
      yape: round2(digitalSales.yape),
      plin: round2(digitalSales.plin),
      card: round2(digitalSales.card),
      transfer: round2(digitalSales.transfer),
      totalDigital: round2(digitalSales.totalDigital),
    },
    creditSales: round2(creditSales),
    totalSales: round2(totalSales),
    salesCount: commercialSales.length,
    manualIncomes: round2(manualIncomes),
    manualExpenses: round2(manualExpenses),
    cashRefunds: round2(cashRefunds),
    totalRefunds: round2(totalRefunds),
    refundCount: refundEventIds.size + anonymousRefundCount,
    cashDeposits: round2(cashDeposits),
    cardDeposits: round2(cardDeposits),
    digitalDeposits: round2(digitalDeposits),
    totalCommissionAmount: round2(totalCommissionAmount),
    totalSurchargeAmount: round2(totalSurchargeAmount),
    expectedCashInDrawer,
  };
};

/**
 * Cierra la sesión de caja (Cierre Z), calcula la diferencia física contra saldo esperado,
 * genera el reporte histórico auditado y libera los punteros activos de la sesión.
 */
export const closeCashSession = async (
  params: CloseCashSessionParams
): Promise<CloseCashSessionResult> => {
  const { accountId, branchId, sessionId, notes, closedBy, closedByName } = params;

  if (!sessionId || !accountId || !branchId) {
    throw new Error('Parámetros de sesión requeridos para ejecutar el cierre.');
  }

  const effectiveCounted = params.countedAmount ?? params.countedCash ?? 0;

  if (typeof effectiveCounted !== 'number' || effectiveCounted < 0 || isNaN(effectiveCounted)) {
    throw new Error('El efectivo contado físico debe ser un valor válido igual o mayor a cero.');
  }

  // 1. Obtener sesión, movimientos y ventas en paralelo para auditoría precisa
  const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
  const salesQuery = query(
    collection(db, SALES_COLLECTION),
    where('accountId', '==', accountId),
    where('sessionId', '==', sessionId)
  );

  const [sessionSnap, movements, salesSnap] = await Promise.all([
    getDoc(sessionRef),
    getSessionMovements(accountId, branchId, sessionId),
    getDocs(salesQuery),
  ]);

  if (!sessionSnap.exists()) {
    throw new Error(`La sesión de caja ${sessionId} no existe.`);
  }

  const sessionData = sessionSnap.data() as CashSession;
  if (sessionData.status === 'closed') {
    throw new Error('Esta sesión de caja ya fue cerrada previamente.');
  }

  const sales = salesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // 2. Calcular Arqueo Z y esquema web `computed` + `sellerSummary`
  const audit = calculateCashAudit(sessionData, movements, sales);
  const roundedCounted = round2(effectiveCounted);
  const difference = round2(roundedCounted - audit.expectedCashInDrawer);
  const closeTimeMs = Date.now();

  const effectiveClosedBy = closedBy || params.userId || auth.currentUser?.uid || sessionData.startedBy || '';
  const effectiveClosedByName =
    closedByName || params.userName || auth.currentUser?.displayName || sessionData.startedByName || 'Usuario';

  const reservationCash = round2(sessionData.cashReservationDeposits || 0);
  const reservationCard = round2(sessionData.cardReservationDeposits || 0);
  const reservationDigital = round2(sessionData.digitalReservationDeposits || 0);
  const orderCash = round2(sessionData.cashOrderDeposits || 0);
  const orderCard = round2(sessionData.cardOrderDeposits || 0);
  const orderDigital = round2(sessionData.digitalOrderDeposits || 0);
  const digitalOnlySales = round2(audit.digitalSales.yape + audit.digitalSales.plin + audit.digitalSales.transfer);

  const computed = {
    cashFromSales: round2(audit.cashSales + audit.cashDeposits),
    cardFromSales: round2(audit.cardSales + audit.cardDeposits),
    digitalFromSales: round2(digitalOnlySales + audit.digitalDeposits),
    creditFromSales: round2(audit.creditSales),
    cashSalesOnly: round2(audit.cashSales),
    cardSalesOnly: round2(audit.cardSales),
    digitalSalesOnly: digitalOnlySales,
    yapeSalesOnly: round2(audit.digitalSales.yape),
    plinSalesOnly: round2(audit.digitalSales.plin),
    creditSalesOnly: round2(audit.creditSales),
    reservationCash,
    reservationCard,
    reservationDigital,
    orderCash,
    orderCard,
    orderDigital,
    cashIncomes: round2(audit.manualIncomes),
    cashWithdrawals: round2(audit.manualExpenses + audit.cashRefunds),
    totalCommission: round2(audit.totalCommissionAmount),
    totalSurcharges: round2(audit.totalSurchargeAmount),
    totalSales: round2(audit.totalSales),
    salesCount: audit.salesCount,
    refundsCount: audit.refundCount,
  };

  const hasAttribution =
    sales.some((s: any) => s.attributionVersion === 1) ||
    movements.some((m: any) => m.attributionVersion === 1);
  const sellerSummary = hasAttribution
    ? computeSellerPerformance(
        sales,
        movements
          .filter(
            (m: any) =>
              m.attributionVersion === 1 &&
              ['refund', 'sale_refund'].includes(String(m.category || '').toLowerCase())
          )
          .map((m: any) => ({
            sellerId: m.sellerId,
            sellerName: m.sellerName,
            originalSaleId: m.saleId,
            amount: Math.abs(Number(m.refundAmount) || Number(m.amount) || 0),
          }))
      )
    : undefined;

  const reportRef = doc(collection(db, CASH_REPORTS_COLLECTION));
  const reportId = reportRef.id;

  // 3. Transacción atómica de Cierre Z
  await runTransaction(db, async (tx) => {
    const freshSessionSnap = await tx.get(sessionRef);
    if (!freshSessionSnap.exists() || freshSessionSnap.data()?.status === 'closed') {
      throw new Error('La sesión de caja ya se encuentra cerrada.');
    }
    const freshSession = freshSessionSnap.data() as CashSession;
    if (!cashAuditSnapshotMatches(sessionData, freshSession)) {
      throw new Error('La caja cambió durante el arqueo. Actualiza el arqueo antes de cerrar.');
    }

    // Actualizar documento de sesión
    tx.update(sessionRef, {
      status: 'closed',
      closedAt: serverTimestamp(),
      closeTime: closeTimeMs,
      countedAmount: roundedCounted,
      expectedAmount: audit.expectedCashInDrawer,
      difference,
      notes: notes || '',
      closedBy: effectiveClosedBy,
      closedByName: effectiveClosedByName,
      auditSummary: cleanFirestoreData(audit),
    });

    // Guardar reporte inmutable de cierre Z con esquema web completo + sessionSnapshot
    tx.set(reportRef, cleanFirestoreData({
      id: reportId,
      sessionId,
      sessionSnapshot: sessionData,
      ...(sellerSummary ? { sellerSummary } : {}),
      sales,
      movements,
      computed,
      accountId,
      branchId,
      countedAmount: roundedCounted,
      expectedAmount: audit.expectedCashInDrawer,
      difference,
      audit,
      notes: notes || '',
      closedBy: effectiveClosedBy,
      closedByName: effectiveClosedByName,
      startedBy: sessionData.startedBy || '',
      startedByName: sessionData.startedByName || '',
      openedAt: sessionData.openedAt || null,
      closeTime: closeTimeMs,
      closedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }));
  });

  // Limpieza del puntero de sesión activa del operador fuera de la transacción para nunca abortar el Cierre Z
  if (sessionData.startedBy) {
    try {
      const userPointerRef = doc(
        db,
        CASH_SESSIONS_COLLECTION,
        `active_${accountId}_${branchId}_${sessionData.startedBy}`
      );
      await clearActiveCashSessionPointer(userPointerRef, sessionId);
    } catch (cleanupErr) {
      console.warn('[CashRegisterService] No se pudo eliminar el puntero de sesión activa del operador tras cerrar:', cleanupErr);
    }
  }

  // Limpieza de punteros huérfanos de otros operadores (p. ej. admin/owner vendiendo en esta caja)
  try {
    const stalePointersSnap = await getDocs(
      query(
        collection(db, CASH_SESSIONS_COLLECTION),
        where('accountId', '==', accountId),
        where('activeSessionId', '==', sessionId),
        limit(20)
      )
    );
    for (const pDoc of stalePointersSnap.docs) {
      if (pDoc.id.startsWith('active_')) {
        await clearActiveCashSessionPointer(doc(db, CASH_SESSIONS_COLLECTION, pDoc.id), sessionId);
      }
    }
  } catch (staleErr) {
    console.warn('[CashRegisterService] No se pudieron limpiar punteros huérfanos tras cerrar:', staleErr);
  }

  return {
    sessionId,
    reportId,
    countedCash: roundedCounted,
    expectedCash: audit.expectedCashInDrawer,
    difference,
    audit,
    closedAt: new Date(closeTimeMs),
  };
};

/**
 * Suscripción en tiempo real a los movimientos de la sesión activa
 * Soporta: (sessionId, callback) o (sessionId, accountId, callback)
 */
export const subscribeToSessionMovements = (
  sessionId: string,
  accountIdOrCallback: string | ((movements: CashMovement[]) => void),
  optionalCallback?: (movements: CashMovement[]) => void
): (() => void) => {
  const accountId = typeof accountIdOrCallback === 'string' ? accountIdOrCallback : undefined;
  const callback = typeof accountIdOrCallback === 'function' ? accountIdOrCallback : optionalCallback || (() => {});

  if (!sessionId) {
    callback([]);
    return () => {};
  }

  const coll = collection(db, CASH_MOVEMENTS_COLLECTION);
  const constraints: any[] = [where('sessionId', '==', sessionId)];
  if (accountId) {
    constraints.push(where('accountId', '==', accountId));
  }
  constraints.push(limit(100));
  const q = query(coll, ...constraints);

  return onSnapshot(
    q,
    (snap: QuerySnapshot<DocumentData>) => {
      const items: CashMovement[] = snap.docs.map((d) => {
        const data = d.data() as any;
        const text = data.reason || data.description || '';
        return {
          id: d.id,
          ...data,
          description: text,
          reason: text,
        };
      });

      items.sort((a, b) => toMillisValue(a.createdAt) - toMillisValue(b.createdAt));

      callback(items);
    },
    (err) => {
      console.error('[CashRegisterService] Error en suscripción a movimientos:', err);
    }
  );
};

export const subscribeToCashMovements = subscribeToSessionMovements;

