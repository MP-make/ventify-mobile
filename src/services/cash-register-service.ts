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
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  getDocs,
  getDoc,
  deleteDoc,
  onSnapshot,
  QuerySnapshot,
  DocumentData,
  Timestamp,
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
  totalSales?: number;
  totalIncome?: number;
  totalExpenses?: number;
  expectedAmount?: number;
  countedAmount?: number;
  difference?: number;
  transactionCount?: number;
  closedBy?: string;
  closedByName?: string;
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

  const pointerId = `active_${branchId}`;
  const pointerRef = doc(db, CASH_SESSIONS_COLLECTION, pointerId);
  const sessionId = `session_${accountId}_${branchId}_${Date.now()}`;
  const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
  const movementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));

  const createdSession = await runTransaction(db, async (tx) => {
    // 1. Verificar si ya existe una sesión abierta activa en esta sucursal
    const pointerSnap = await tx.get(pointerRef);
    if (pointerSnap.exists()) {
      const pData = pointerSnap.data();
      if (pData.status === 'open') {
        throw new Error(
          `Ya existe una sesión de caja abierta en esta sucursal (Operador: ${pData.startedByName || 'Cajero'}). Ciérrala antes de abrir una nueva.`
        );
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
      notes: notes || '',
      cashSales: 0,
      cardSales: 0,
      digitalSales: 0,
      totalSales: 0,
      totalIncome: 0,
      totalExpenses: 0,
      expectedAmount: Math.round(openingBalance * 100) / 100,
      transactionCount: 0,
    };

    tx.set(sessionRef, sessionData);

    // 3. Configurar puntero determinista de sesión activa
    tx.set(pointerRef, {
      activeSessionId: sessionId,
      accountId,
      branchId,
      startedBy: userId,
      startedByName: userName,
      initialAmount: Math.round(openingBalance * 100) / 100,
      status: 'open',
      openedAt: serverTimestamp(),
      cashSalesTotal: 0,
      totalSales: 0,
      transactionCount: 0,
    });

    // 4. Registrar movimiento inicial en la colección oficial cash_register_movements
    tx.set(movementRef, {
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

    return {
      ...sessionData,
      openedAt: Date.now(),
    } as CashSession;
  });

  return createdSession;
};

/**
 * Consulta la sesión activa para una sucursal dada a través del puntero active_${branchId}
 */
export const getActiveCashSession = async (
  branchId: string,
  accountId?: string
): Promise<CashSession | null> => {
  try {
    const pointerRef = doc(db, CASH_SESSIONS_COLLECTION, `active_${branchId}`);
    const pointerSnap = await getDoc(pointerRef);

    if (!pointerSnap.exists()) return null;
    const pointerData = pointerSnap.data();

    if (pointerData.status !== 'open' || !pointerData.activeSessionId) {
      return null;
    }

    const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, pointerData.activeSessionId);
    const sessionSnap = await getDoc(sessionRef);

    if (!sessionSnap.exists() || sessionSnap.data()?.status !== 'open') {
      return null;
    }

    const data = sessionSnap.data();
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
  const pointerRef = doc(db, CASH_SESSIONS_COLLECTION, `active_${branchId}`);
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
    return [];
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

  // Filtrar solo ventas completadas de esta sesión
  const validSales = sales.filter(
    (s) => s.status !== 'cancelled' && (s.sessionId === session.id || !s.sessionId)
  );

  let cashSales = 0;
  let creditSales = 0;
  const digitalSales: DigitalSalesBreakdown = {
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    totalDigital: 0,
  };

  for (const sale of validSales) {
    const total = sale.total || 0;
    const pMethod = (sale.paymentMethod || '').toLowerCase();

    // 1. Desglose si tiene pagos mixtos v2
    if (Array.isArray(sale.payments) && sale.payments.length > 0) {
      for (const split of sale.payments) {
        const cat = split.category || '';
        const amt = split.amount || 0;
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
      if (pMethod === 'efectivo') {
        cashSales += total;
      } else if (pMethod === 'tarjeta') {
        digitalSales.card += total;
      } else if (pMethod === 'yape') {
        digitalSales.yape += total;
      } else if (pMethod === 'plin') {
        digitalSales.plin += total;
      } else if (pMethod === 'transferencia') {
        digitalSales.transfer += total;
      } else if (pMethod === 'fiado') {
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

  for (const m of movements) {
    const amt = Math.abs(m.amount || 0);
    if (m.type === 'income' && m.category !== 'opening' && m.category !== 'sale') {
      manualIncomes += amt;
    } else if (m.type === 'expense') {
      if (m.category === 'refund') {
        cashRefunds += amt;
      } else {
        manualExpenses += amt;
      }
    }
  }

  // Fórmula matemática del arqueo físico de efectivo:
  // Saldo Apertura + Ventas Efectivo + Ingresos Manuales - Gastos Manuales - Devoluciones Efectivo
  const expectedCashInDrawer =
    Math.round(
      (openingBalance + cashSales + manualIncomes - manualExpenses - cashRefunds) * 100
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
    salesCount: validSales.length,
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
  const pointerRef = doc(db, CASH_SESSIONS_COLLECTION, `active_${branchId}`);

  // 3. Transacción atómica de Cierre Z
  await runTransaction(db, async (tx) => {
    const freshSessionSnap = await tx.get(sessionRef);
    if (!freshSessionSnap.exists() || freshSessionSnap.data()?.status === 'closed') {
      throw new Error('La sesión de caja ya se encuentra cerrada.');
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

    // Guardar reporte inmutable de cierre Z
    tx.set(reportRef, {
      id: reportId,
      sessionId,
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

    // Liberar puntero de sucursal
    tx.delete(pointerRef);
  });

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
  const constraints = [where('sessionId', '==', sessionId)];
  if (accountId) {
    constraints.push(where('accountId', '==', accountId));
  }
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
