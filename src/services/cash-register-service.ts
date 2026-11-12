/**
 * Ventify Mobile - Cash Register & Shift Management Service
 * 
 * Gestión integral de sesiones de caja chica y arqueos de turno (Cierre Z).
 * Basado en cash-session-manager de Ventify, adaptado para React Native.
 * Usa la colección oficial `cash_register_movements` (corrigiendo el bug del proyecto anterior)
 * y el puntero determinista `cash_register_sessions/active_${branchId}`.
 */

import { db, auth } from '@/lib/firebase';
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
  type: CashMovementType;
  category: CashMovementCategory;
  amount: number;
  description: string;
  saleId?: string;
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
  userId: string;
  userName: string;
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
  digitalSales: DigitalSalesBreakdown;
  creditSales: number;
  totalSales: number;
  salesCount: number;
  manualIncomes: number;
  manualExpenses: number;
  cashRefunds: number;
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
          activeSessionId = userSessionSnap.docs[0].id;
        }
      }

      // Si el operador específico no tiene sesión abierta, retornar null (sin fallback a otro usuario)
      if (!activeSessionId) {
        return null;
      }
    } else if (accountId) {
      // 2. Si no se especificó un operador pero sí la cuenta, buscar sesión abierta para la sucursal
      const openQ = query(
        collection(db, CASH_SESSIONS_COLLECTION),
        where('accountId', '==', accountId),
        where('branchId', '==', branchId),
        where('status', '==', 'open'),
        limit(1)
      );
      const snap = await getDocs(openQ);
      if (!snap.empty) {
        activeSessionId = snap.docs[0].id;
      }
    }

    if (!activeSessionId) return null;

    const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, activeSessionId);
    const sessionSnap = await getDoc(sessionRef);

    if (!sessionSnap.exists() || sessionSnap.data()?.status !== 'open') {
      return null;
    }

    const data = sessionSnap.data();
    // Si se solicitó un usuario específico, verificar que startedBy coincida
    if (userId && data.startedBy && data.startedBy !== userId) {
      return null;
    }

    return {
      id: sessionSnap.id,
      ...data,
    } as CashSession;
  } catch (err) {
    console.warn('[CashRegisterService] Error al obtener sesión activa:', err);
    return null;
  }
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
    category = type === 'income' ? 'manual_income' : 'manual_expense',
    description,
    userId,
    userName,
  } = params;

  if (!sessionId || !accountId || !branchId) {
    throw new Error('Identificadores de cuenta, sucursal y sesión requeridos.');
  }

  if (typeof amount !== 'number' || amount <= 0 || isNaN(amount)) {
    throw new Error('El monto del movimiento debe ser un valor numérico positivo.');
  }

  if (!description || description.trim().length === 0) {
    throw new Error('Debe especificar una descripción o motivo para el movimiento.');
  }

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
      typeof sData.cashierExpenseLimit === 'number' &&
      sData.cashierExpenseLimit > 0
    ) {
      if (normalizedAmount > sData.cashierExpenseLimit) {
        throw new Error(
          `El egreso (S/ ${normalizedAmount.toFixed(2)}) supera el límite máximo permitido para cajeros (S/ ${sData.cashierExpenseLimit.toFixed(2)}).`
        );
      }
    }

    // 1. Insertar movimiento en cash_register_movements
    tx.set(movementRef, {
      id: movementId,
      sessionId,
      accountId,
      branchId,
      type,
      category,
      amount: signedAmount,
      description: description.trim(),
      createdBy: userId,
      createdByName: userName,
      createdAt: serverTimestamp(),
    });

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
      return {
        id: d.id,
        sessionId: data.sessionId,
        accountId: data.accountId,
        branchId: data.branchId,
        type: data.type,
        category: data.category,
        amount: data.amount,
        description: data.description || '',
        saleId: data.saleId,
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
    movements.sort((a, b) => {
      const timeA = typeof a.createdAt === 'object' && 'seconds' in a.createdAt ? a.createdAt.seconds : Number(a.createdAt) || 0;
      const timeB = typeof b.createdAt === 'object' && 'seconds' in b.createdAt ? b.createdAt.seconds : Number(b.createdAt) || 0;
      return timeA - timeB;
    });

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
  const validSales = sales.filter(
    (s) => s.status !== 'cancelled' && (s.sessionId === session.id || !s.sessionId)
  );
  const cancelledSaleIds = new Set(
    sales.filter(s => s.status === 'cancelled').map(s => String(s.id || '')).filter(Boolean)
  );
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
      return sale.payments.reduce((sum: number, split: any) =>
        sum + (split.category === 'cash' ? paymentAmountForAudit(split) : 0), 0);
    }
    if (typeof sale.cashAmount === 'number' && sale.cashAmount >= 0) return sale.cashAmount;
    if (sale.paymentCategory === 'cash' || isCashMethod(sale.paymentMethod) || isCashMethod(sale.paymentMethodId)) {
      return chargedAmount(sale);
    }
    return 0;
  };

  const depositSales = validSales.filter(isDepositPayment);
  const commercialSales = validSales.filter(s => !isDepositPayment(s));
  // Los contadores de sesión son autoridad para los adelantos porque ya
  // incorporan sus reembolsos. Si no existen en una sesión legacy, derivarlos
  // de las ventas de depósito disponibles.
  const depositCountersPresent =
    typeof session.cashReservationDeposits === 'number' || typeof session.cashOrderDeposits === 'number';
  const cashDeposits = depositCountersPresent
    ? (session.cashReservationDeposits || 0) + (session.cashOrderDeposits || 0)
    : depositSales.reduce((sum, sale) => sum + depositCashFromSale(sale), 0);

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

  // Movimientos de caja manuales
  let manualIncomes = 0;
  let manualExpenses = 0;
  let cashRefunds = 0;
  let cashDepositRefundAdjustments = 0;

  for (const m of movements) {
    const amt = Math.abs(m.amount || 0);
    const category = String(m.category || '').toLowerCase();
    const method = (m as any).method ?? m.paymentMethod;
    const isDepositRefund = category === 'reservation_refund' || category === 'order_refund';
    const isRefund = isDepositRefund || category === 'sale_refund' || category === 'refund' || category === 'return';
    if (isRefund) {
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
      if (m.saleId && cancelledSaleIds.has(String(m.saleId))) continue;
      const linkedSale = m.saleId ? sales.find(s => String(s.id || '') === String(m.saleId)) : undefined;
      const linkedMethod = linkedSale?.paymentMethod || linkedSale?.paymentCategory || linkedSale?.paymentMethodId;
      if (Number(m.amount) < 0 && (isCashMethod(method || linkedMethod) || (!method && !linkedMethod))) cashRefunds += amt;
      continue;
    }
    if (m.type === 'income' && m.category !== 'opening' && m.category !== 'sale') {
      if (isCashMethod(method) || !method) manualIncomes += amt;
    } else if (m.type === 'expense' && (isCashMethod(method) || !method)) {
      manualExpenses += amt;
    }
  }

  // Fórmula matemática del arqueo físico de efectivo:
  // Saldo Apertura + Ventas Efectivo + Ingresos Manuales - Gastos Manuales - Devoluciones Efectivo
  const expectedCashInDrawer =
    Math.round(
      (openingBalance + cashSales + cashDeposits + cashDepositRefundAdjustments + manualIncomes - manualExpenses - cashRefunds) * 100
    ) / 100;

  return {
    openingBalance: Math.round(openingBalance * 100) / 100,
    cashSales: Math.round(cashSales * 100) / 100,
    digitalSales: {
      yape: Math.round(digitalSales.yape * 100) / 100,
      plin: Math.round(digitalSales.plin * 100) / 100,
      card: Math.round(digitalSales.card * 100) / 100,
      transfer: Math.round(digitalSales.transfer * 100) / 100,
      totalDigital: Math.round(digitalSales.totalDigital * 100) / 100,
    },
    creditSales: Math.round(creditSales * 100) / 100,
    totalSales: Math.round(totalSales * 100) / 100,
    salesCount: commercialSales.length,
    manualIncomes: Math.round(manualIncomes * 100) / 100,
    manualExpenses: Math.round(manualExpenses * 100) / 100,
    cashRefunds: Math.round(cashRefunds * 100) / 100,
    expectedCashInDrawer,
  };
};

/**
 * Cierra la sesión de caja (Cierre Z), calcula la diferencia física contra saldo esperado,
 * genera el reporte histórico auditado y libera el puntero active_${branchId}.
 */
export const closeCashSession = async (
  params: CloseCashSessionParams
): Promise<CloseCashSessionResult> => {
  const { accountId, branchId, sessionId, countedCash, notes, closedBy, closedByName } = params;

  if (!sessionId || !accountId || !branchId) {
    throw new Error('Parámetros de sesión requeridos para ejecutar el cierre.');
  }

  const effectiveCounted = params.countedAmount ?? params.countedCash ?? 0;

  if (typeof effectiveCounted !== 'number' || effectiveCounted < 0 || isNaN(effectiveCounted)) {
    throw new Error('El efectivo contado físico debe ser un valor válido igual o mayor a cero.');
  }

  // 1. Obtener sesión, movimientos y ventas para auditoría precisa
  const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
  const sessionSnap = await getDoc(sessionRef);

  if (!sessionSnap.exists()) {
    throw new Error(`La sesión de caja ${sessionId} no existe.`);
  }

  const sessionData = sessionSnap.data() as CashSession;
  if (sessionData.status === 'closed') {
    throw new Error('Esta sesión de caja ya fue cerrada previamente.');
  }

  const movements = await getSessionMovements(accountId, branchId, sessionId);

  // Consultar ventas vinculadas a la sesión
  const salesQuery = query(
    collection(db, SALES_COLLECTION),
    where('accountId', '==', accountId),
    where('sessionId', '==', sessionId)
  );
  const salesSnap = await getDocs(salesQuery);
  const sales = salesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // 2. Calcular Arqueo Z
  const audit = calculateCashAudit(sessionData, movements, sales);
  const difference = Math.round((effectiveCounted - audit.expectedCashInDrawer) * 100) / 100;

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
      countedAmount: Math.round(effectiveCounted * 100) / 100,
      expectedAmount: audit.expectedCashInDrawer,
      difference,
      notes: notes || '',
      closedBy,
      closedByName,
      auditSummary: audit,
    });

    // Guardar reporte inmutable de cierre Z con sessionSnapshot (requisito obligatorio de firestore.rules para cajeros y encargados)
    tx.set(reportRef, {
      id: reportId,
      sessionId,
      sessionSnapshot: sessionData,
      accountId,
      branchId,
      countedAmount: Math.round(effectiveCounted * 100) / 100,
      expectedAmount: audit.expectedCashInDrawer,
      difference,
      audit,
      notes: notes || '',
      closedBy,
      closedByName,
      startedBy: sessionData.startedBy,
      startedByName: sessionData.startedByName,
      openedAt: sessionData.openedAt,
      closedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });
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

  return {
    sessionId,
    reportId,
    countedCash: Math.round(effectiveCounted * 100) / 100,
    expectedCash: audit.expectedCashInDrawer,
    difference,
    audit,
    closedAt: new Date(),
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
      const items: CashMovement[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      }));

      items.sort((a, b) => {
        const timeA = typeof a.createdAt === 'object' && 'seconds' in a.createdAt ? a.createdAt.seconds : Number(a.createdAt) || 0;
        const timeB = typeof b.createdAt === 'object' && 'seconds' in b.createdAt ? b.createdAt.seconds : Number(b.createdAt) || 0;
        return timeA - timeB;
      });

      callback(items);
    },
    (err) => {
      console.error('[CashRegisterService] Error en suscripción a movimientos:', err);
    }
  );
};

export const subscribeToCashMovements = subscribeToSessionMovements;

