import { isLegacyReservedOrder } from '@/lib/crm-legacy';
/**
 * Ventify Mobile - CRM, Orders & AI Operations Service
 * 
 * Gestión integral de:
 * 1. Clientes y Cuentas Corrientes (Fiados): pagos, abonos y deudas en `reservation_deposits` y `credit_history`.
 * 2. Pedidos y Reservas: apartado de stock (`reservedStock`) y depósitos en caja en `reservation_deposits`.
 * 3. Asistente Venty IA: integración con API de IA de Ventify con fallback autónomo
 *    basado en KPIs reales del negocio (ventas de hoy, stock crítico, arqueo y fiados).
 */

import { db, auth } from '@/lib/firebase';
import type { Customer } from '@/types';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  getDocs,
  limit,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

// ============================================================================
// CONSTANTES DE COLECCIONES OFICIALES
// ============================================================================

const CUSTOMERS_COLLECTION = 'customers';
const RESERVATION_DEPOSITS_COLLECTION = 'reservation_deposits';
const ORDER_DEPOSITS_COLLECTION = 'order_deposits';
const CREDIT_HISTORY_COLLECTION = 'credit_history';
const RESERVATIONS_COLLECTION = 'reservations';
const ORDERS_COLLECTION = 'orders';
const FIADO_RETURNS_COLLECTION = 'fiado_returns';
const PRODUCTS_COLLECTION = 'products';
const SALES_COLLECTION = 'sales';
const INVENTORY_MOVEMENTS_COLLECTION = 'inventory_movements';
const CASH_MOVEMENTS_COLLECTION = 'cash_register_movements';
const CASH_SESSIONS_COLLECTION = 'cash_register_sessions';

const applyLimit = (n: number) => {
  if (typeof limit === 'function') {
    try {
      const constraint = limit(n);
      return constraint !== undefined ? [constraint] : [];
    } catch {
      return [];
    }
  }
  return [];
};

function requireOpenSession(snapshot: any, accountId: string, branchId: string): Record<string, any> {
  if (!snapshot?.exists()) throw new Error('La sesión de caja ya no existe. Actualiza la caja e inténtalo de nuevo.');
  const session = snapshot.data() || {};
  if (session.status !== 'open') throw new Error('La sesión de caja está cerrada. Actualiza la caja e inténtalo de nuevo.');
  if (session.accountId !== accountId || session.branchId !== branchId) {
    throw new Error('La sesión de caja no pertenece a esta cuenta y sucursal.');
  }
  return session;
}

const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://ventify.com.pe';

import type { UserProfileInfo } from './sale-service';
import { aggregateStockRequirements, getDepositSessionUpdates, normalizeOrderItems, toEpochMillis } from './crm-compat';
import { apiRequest } from '@/lib/api-client';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { deriveBranchIds, deriveLowStockBranches } from '@/lib/product-branch-ids';

export interface CustomerData {
  id?: string;
  accountId?: string;
  name: string;
  dni?: string;
  ruc?: string;
  documentType?: 'DNI' | 'RUC' | 'CE' | 'PASAPORTE' | string;
  documentNumber?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  currentDebt?: number;
  creditLimit?: number;
  maxCreditLimit?: number;
  credits?: number;
  totalPurchases?: number;
  totalSpent?: number;
  lastPaymentDate?: any;
}

export interface RegisterFiadoPaymentParams {
  accountId: string;
  branchId: string;
  sessionId?: string;
  customer: {
    id: string;
    name: string;
    currentDebt?: number;
  };
  reservationId?: string;
  amount: number;
  paymentMethod: 'efectivo' | 'tarjeta' | 'yape' | 'plin' | 'transferencia' | string;
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface FiadoHistoryEntry {
  id: string;
  date: number;
  amount: number;
  paymentMethod: string;
  previousDebt?: number;
  newDebt?: number;
  notes?: string;
  createdByName?: string;
  purpose?: string;
}

export interface FiadoReturnRecord {
  date: number;
  reason: string;
  operatorId: string;
  operatorName?: string;
  items: Array<{
    productId: string;
    name: string;
    quantity: number;
    stockUnits?: number;
    variantId?: string;
    presentationId?: string;
    presentationQty?: number;
    unitPrice: number;
    costPrice?: number;
  }>;
  amount: number;
}

export interface OpenFiado {
  id: string;
  reservationNumber?: number;
  branchId?: string;
  total: number;
  paidAmount: number;
  returnedAmount?: number;
  remainingAmount: number;
  date: number;
  dueDate?: number;
  items?: ReservationOrderItem[];
  returnHistory?: FiadoReturnRecord[];
}

export interface FiadoReturnItemInput {
  productId: string;
  quantity: number;
}

export interface ReturnFiadoMerchandiseParams {
  accountId: string;
  reservationId: string;
  items: FiadoReturnItemInput[];
  reason: string;
  userProfile: UserProfileInfo;
}

export interface WriteOffFiadoParams {
  accountId: string;
  reservationId: string;
  reason: string;
  userProfile: UserProfileInfo;
}

export interface ReservationOrderItem {
  productId?: string;
  productName?: string;
  id?: string;
  name?: string;
  sku?: string;
  price: number;
  costPrice?: number;
  quantity: number;
  variantId?: string;
  variantName?: string;
  presentationId?: string;
  conversionFactor?: number;
  presentationQty?: number;
}

export interface CreateReservationOrderParams {
  accountId: string;
  branchId: string;
  sessionId?: string;
  type: 'reservation' | 'order';
  items: ReservationOrderItem[];
  total: number;
  depositAmount: number;
  paymentMethod: string;
  customer: {
    id?: string;
    name: string;
    phone?: string;
    documentNumber?: string;
  };
  pickupDate?: number | string;
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface RegisterReservationPaymentParams {
  accountId: string;
  branchId: string;
  sessionId?: string;
  reservationId: string;
  type?: 'reservation' | 'order';
  amount: number;
  paymentMethod: string;
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface ReservationOrder {
  id: string;
  number?: number;
  sellerId?: string;
  sellerName?: string;
  accountId: string;
  branchId: string;
  type: 'reservation' | 'order';
  items: ReservationOrderItem[];
  total: number;
  depositAmount: number;
  remainingAmount: number;
  status: 'pending' | 'approved' | 'production' | 'ready' | 'completed' | 'cancelled';
  customerName?: string;
  customerId?: string | null;
  customerPhone?: string;
  customerDocument?: string;
  customer: {
    id?: string;
    name: string;
    phone?: string;
    documentNumber?: string;
    dni?: string;
    ruc?: string;
    address?: string;
    email?: string;
  };
  pickupDate?: any;
  notes?: string;
  createdAt: any;
  createdBy: string;
  createdByName?: string;
  saleId?: string;
}

export interface BusinessKPIContext {
  todaySales?: number;
  salesCount?: number;
  lowStockCount?: number;
  lowStockItems?: string[];
  cashInDrawer?: number;
  totalDebt?: number;
  branchName?: string;
  activeOperator?: string;
}

export interface AskVentyAIParams {
  prompt?: string;
  question?: string;
  accountId?: string;
  branchId?: string;
  contextSummary?: BusinessKPIContext;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onChunk?: (accumulatedText: string, delta: string) => void;
}

// ============================================================================
// 1. GESTIÓN DE CLIENTES Y FIADOS
// ============================================================================

/**
 * Obtiene la lista de clientes de la cuenta, con soporte para búsqueda por texto
 */
export const getCustomers = async (
  accountId: string,
  searchTerm?: string,
  maxResults = 150
): Promise<Customer[]> => {
  if (!accountId) return [];

  try {
    const coll = collection(db, CUSTOMERS_COLLECTION);
    const q = query(coll, where('accountId', '==', accountId), ...applyLimit(maxResults));
    const snapshot = await getDocs(q);

    let customers: Customer[] = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        name: data.name || '',
        totalPurchases: data.totalPurchases || 0,
        totalSpent: data.totalSpent || 0,
        ...data,
      } as Customer;
    });

    if (searchTerm && searchTerm.trim().length > 0) {
      const term = searchTerm.toLowerCase().trim();
      customers = customers.filter((c) => {
        const name = (c.name || '').toLowerCase();
        const docNum = ((c as any).documentNumber || (c as any).dni || (c as any).ruc || '').toLowerCase();
        const phone = (c.phone || '').toLowerCase();
        return name.includes(term) || docNum.includes(term) || phone.includes(term);
      });
    }

    // Ordenar por nombre alfabéticamente
    customers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return customers;
  } catch (err) {
    console.error('[CRMService] Error obteniendo clientes:', err);
    return [];
  }
};

/**
 * Guarda o actualiza los datos de un cliente en `customers`
 */
export const saveCustomer = async (
  customer: Partial<CustomerData> & { accountId: string; name: string }
): Promise<string> => {
  if (!customer.name || customer.name.trim().length === 0) {
    throw new Error('El nombre o razón social del cliente es obligatorio.');
  }

  if (!customer.accountId) {
    throw new Error('El identificador de cuenta (accountId) es obligatorio.');
  }

  const coll = collection(db, CUSTOMERS_COLLECTION);
  let customerId = customer.id;

  const payload: any = {
    ...customer,
    name: customer.name.trim(),
    documentNumber: customer.documentNumber ? customer.documentNumber.trim() : null,
    documentType: customer.documentType || 'DNI',
    phone: customer.phone ? customer.phone.trim() : null,
    email: customer.email ? customer.email.trim().toLowerCase() : null,
    address: customer.address ? customer.address.trim() : null,
    currentDebt: typeof customer.currentDebt === 'number' ? Math.round(customer.currentDebt * 100) / 100 : 0,
    creditLimit: typeof customer.creditLimit === 'number' ? Math.round(customer.creditLimit * 100) / 100 : null,
    credits: typeof customer.credits === 'number' ? Math.round(customer.credits * 100) / 100 : 0,
    updatedAt: serverTimestamp(),
  };

  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  if (!customerId) {
    const newRef = doc(coll);
    customerId = newRef.id;
    payload.id = customerId;
    payload.createdAt = serverTimestamp();
    payload.totalPurchases = 0;
    payload.totalSpent = 0;
    await setDoc(newRef, payload);
  } else {
    const docRef = doc(db, CUSTOMERS_COLLECTION, customerId);
    await updateDoc(docRef, payload);
  }

  return customerId;
};

/**
 * Registra un abono a cuenta de deuda (fiado) de forma atómica:
 * - Reduce `currentDebt` en `customers/{customerId}`
 * - Si pagó un excedente (`surplusCredit > 0`), lo suma a `customers.credits` y registra en `credit_history`.
 * - Inserta el comprobante oficial en `reservation_deposits` (purpose: 'fiado_payment').
 * - Si el pago fue en efectivo, crea el movimiento en `cash_register_movements` y actualiza la caja activa.
 */
export const registerFiadoPayment = async (
  params: RegisterFiadoPaymentParams
): Promise<string> => {
  const {
    accountId,
    branchId,
    sessionId,
    customer,
    amount,
    paymentMethod,
    notes,
    userProfile,
  } = params;

  if (!customer.id || !accountId || !branchId) {
    throw new Error('Cliente, cuenta y sucursal son requeridos para registrar el abono.');
  }

  if (typeof amount !== 'number' || amount <= 0 || isNaN(amount)) {
    throw new Error('El monto del abono debe ser un número positivo.');
  }
  if (!sessionId) throw new Error('Abre una caja antes de registrar un abono de fiado.');

  const normalizedAmount = Math.round(amount * 100) / 100;
  // Guardar en la colección oficial `reservation_deposits` (NO usar la inexistente `fiado_payments` que arroja 403)
  const depositRef = doc(collection(db, RESERVATION_DEPOSITS_COLLECTION));
  const paymentId = depositRef.id;
  const customerRef = doc(db, CUSTOMERS_COLLECTION, customer.id);
  const reservationRef = params.reservationId ? doc(db, RESERVATIONS_COLLECTION, params.reservationId) : null;
  const sessionRef = sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;

  await runTransaction(db, async (tx) => {
    // 1. Leer saldo actual del cliente, fiado y sesión de caja en paralelo antes de escribir
    const [custSnap, reservationSnap, sessionSnap] = await Promise.all([
      tx.get(customerRef),
      reservationRef ? tx.get(reservationRef) : Promise.resolve(null),
      sessionRef ? tx.get(sessionRef) : Promise.resolve(null),
    ]);
    if (!custSnap.exists()) {
      throw new Error(`El cliente con ID ${customer.id} no existe.`);
    }

    const sessionData = sessionSnap ? requireOpenSession(sessionSnap, accountId, branchId) : null;

    const cData = custSnap.data();
    const currentDebt = Number(cData.currentDebt) || 0;
    const currentCredits = Number(cData.credits) || 0;
    const reservationData = reservationSnap?.exists() ? reservationSnap.data() : null;
    if (reservationRef && (!reservationData || reservationData.accountId !== accountId || reservationData.customerId !== customer.id || !(reservationData.isFiado === true || reservationData.isCreditSale === true || reservationData.type === 'fiado'))) {
      throw new Error('El fiado seleccionado no pertenece a este cliente o cuenta.');
    }
    const reservationBalance = reservationData
      ? Math.max(0, Math.round(((Number(reservationData.total) || 0) - (Number(reservationData.paidAmount) || 0) - (Number(reservationData.returnedAmount) || 0)) * 100) / 100)
      : currentDebt;
    if (reservationData && (reservationData.status === 'settled' || reservationBalance <= 0)) {
      throw new Error('El fiado ya está cubierto.');
    }
    const appliedAmount = reservationData
      ? Math.min(normalizedAmount, reservationBalance, currentDebt || reservationBalance)
      : Math.min(normalizedAmount, currentDebt);

    let newDebt = 0;
    let surplusCredit = 0;

    if (appliedAmount >= currentDebt) {
      newDebt = 0;
      surplusCredit = Math.round((normalizedAmount - appliedAmount) * 100) / 100;
    } else {
      newDebt = Math.round((currentDebt - appliedAmount) * 100) / 100;
      surplusCredit = Math.round((normalizedAmount - appliedAmount) * 100) / 100;
    }

    // 2. Actualizar cliente
    const customerUpdates: Record<string, any> = {
      currentDebt: newDebt,
      lastPaymentDate: serverTimestamp(),
      lastPaymentAmount: appliedAmount,
      updatedAt: serverTimestamp(),
    };

    if (surplusCredit > 0) {
      customerUpdates.credits = Math.round((currentCredits + surplusCredit) * 100) / 100;
    }

    tx.update(customerRef, customerUpdates);

    // 3. Si hubo excedente pagado por el cliente, registrar en credit_history
    if (surplusCredit > 0) {
      const historyRef = doc(collection(db, CREDIT_HISTORY_COLLECTION));
      tx.set(historyRef, {
        id: historyRef.id,
        accountId,
        customerId: customer.id,
        amount: surplusCredit,
        type: 'add',
        reason: `Excedente en abono de fiado (${customer.name || cData.name})`,
        createdAt: Date.now(),
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
      });
    }

    // 4. Guardar comprobante oficial en reservation_deposits
    tx.set(depositRef, {
      id: paymentId,
      accountId,
      branchId,
      sessionId: sessionId || null,
      cashSessionId: sessionId || null,
      customerId: customer.id,
      reservationId: params.reservationId || null,
      reservationNumber: reservationData?.reservationNumber || null,
      customerName: customer.name || cData.name,
      amount: normalizedAmount,
      appliedAmount,
      previousDebt: currentDebt,
      newDebt,
      paymentMethod,
      purpose: 'fiado_payment',
      status: 'active',
      refundable: false,
      notes: notes || '',
      createdBy: userProfile.uid,
      createdByName: userProfile.displayName || userProfile.email || 'Usuario',
      date: Date.now(),
      createdAt: serverTimestamp(),
    });

    if (reservationRef && reservationData) {
      const nextPaid = Math.round(((Number(reservationData.paidAmount) || 0) + appliedAmount) * 100) / 100;
      const remaining = Math.max(0, Math.round(((Number(reservationData.total) || 0) - nextPaid - (Number(reservationData.returnedAmount) || 0)) * 100) / 100);
      tx.update(reservationRef, {
        paidAmount: nextPaid,
        ...(remaining <= 0 ? { status: 'settled', settledDate: Date.now() } : {}),
        updatedAt: serverTimestamp(),
      });
    }

    // 5. Actualizar acumuladores de depósitos en la sesión de caja para TODOS los medios (efectivo, tarjeta, digital)
    if (sessionId && sessionRef && sessionSnap && sessionData && appliedAmount > 0) {
      tx.update(sessionRef, {
        ...getDepositSessionUpdates(sessionData, 'reservation', paymentMethod, appliedAmount),
        updatedAt: serverTimestamp(),
      });
    }
  });

  return paymentId;
};

/**
 * Consulta el historial de abonos de fiado de un cliente desde `reservation_deposits`
 */
export const getCustomerFiadoHistory = async (
  accountId: string,
  customerId: string
): Promise<FiadoHistoryEntry[]> => {
  if (!accountId || !customerId) return [];

  try {
    const coll = collection(db, RESERVATION_DEPOSITS_COLLECTION);
    const q = query(
      coll,
      where('accountId', '==', accountId),
      where('customerId', '==', customerId)
    );
    const [snapshot, reservationsSnapshot] = await Promise.all([
      getDocs(q),
      getDocs(query(
        collection(db, RESERVATIONS_COLLECTION),
        where('accountId', '==', accountId),
        where('customerId', '==', customerId)
      )),
    ]);
    const fiadoIds = reservationsSnapshot.docs
      .filter((d) => d.data().isFiado === true || d.data().isCreditSale === true || d.data().type === 'fiado')
      .map((d) => d.id);

    const BATCH_SIZE = 30;
    const fiadoIdBatches: string[][] = [];
    for (let i = 0; i < fiadoIds.length; i += BATCH_SIZE) {
      fiadoIdBatches.push(fiadoIds.slice(i, i + BATCH_SIZE));
    }

    const linkedSnapshots = await Promise.all(
      fiadoIdBatches.map(async (batch) => {
        try {
          const linkedQuery = query(
            coll,
            where('accountId', '==', accountId),
            where('reservationId', 'in', batch)
          );
          return await getDocs(linkedQuery);
        } catch {
          try {
            const individualSnaps = await Promise.all(
              batch.map((id) =>
                getDocs(query(coll, where('accountId', '==', accountId), where('reservationId', '==', id))).catch(() => null)
              )
            );
            const docs = individualSnaps.flatMap((s) => (s ? s.docs : []));
            return { docs };
          } catch {
            return null;
          }
        }
      })
    );
    const allDocs = new Map(snapshot.docs.map((d) => [d.id, d]));
    linkedSnapshots.forEach((linked) => linked?.docs.forEach((d) => allDocs.set(d.id, d)));

    const history: FiadoHistoryEntry[] = [...allDocs.values()].filter((d) => {
      const data = d.data();
      return data.purpose === 'fiado_payment' || Boolean(data.reservationId);
    }).map((d) => {
      const data = d.data();
      const dateVal = toEpochMillis(data.date || data.createdAt) || Date.now();
      return {
        id: d.id,
        date: dateVal,
        amount: Number(data.appliedAmount ?? data.amount) || 0,
        paymentMethod: data.paymentMethod || 'Efectivo',
        previousDebt: data.previousDebt,
        newDebt: data.newDebt,
        notes: data.notes || '',
        createdByName: data.createdByName || 'Usuario',
        purpose: data.purpose || 'fiado_payment',
      };
    });

    history.sort((a, b) => b.date - a.date);
    return history;
  } catch (err) {
    console.error('[CRMService] Error obteniendo historial de fiados:', err);
    return [];
  }
};

export const getCustomerOpenFiados = async (accountId: string, customerId: string): Promise<OpenFiado[]> => {
  if (!accountId || !customerId) return [];
  const coll = collection(db, RESERVATIONS_COLLECTION);
  let snapshot;
  try {
    const q = query(
      coll,
      where('accountId', '==', accountId),
      where('customerId', '==', customerId),
      where('status', 'in', ['pending', 'approved', 'ready', 'open']),
      ...applyLimit(30)
    );
    snapshot = await getDocs(q);
  } catch (err: any) {
    console.warn('[CRMService] Fallback getCustomerOpenFiados sin status in:', err?.message);
    const fallbackQ = query(
      coll,
      where('accountId', '==', accountId),
      where('customerId', '==', customerId),
      ...applyLimit(30)
    );
    snapshot = await getDocs(fallbackQ);
  }
  return snapshot.docs.flatMap((entry) => {
    const data = entry.data();
    if (
      !(data.isFiado === true || data.isCreditSale === true || data.type === 'fiado') ||
      data.status === 'settled' ||
      data.status === 'cancelled' ||
      data.status === 'written_off'
    ) {
      return [];
    }
    const total = Number(data.total) || 0;
    const paidAmount = Number(data.paidAmount) || 0;
    const returnedAmount = Number(data.returnedAmount) || 0;
    const remainingAmount = Math.max(0, Math.round((total - paidAmount - returnedAmount) * 100) / 100);
    if (remainingAmount <= 0) return [];
    return [{
      id: entry.id,
      reservationNumber: Number(data.reservationNumber) || undefined,
      branchId: data.branchId,
      total,
      paidAmount,
      returnedAmount,
      remainingAmount,
      date: toEpochMillis(data.date || data.createdAt),
      dueDate: toEpochMillis(data.dueDate) || undefined,
      items: Array.isArray(data.items) ? normalizeOrderItems(data.items) : [],
      returnHistory: Array.isArray(data.returnHistory) ? data.returnHistory : [],
    }];
  }).sort((a, b) => a.date - b.date);
};

const roundCents = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const roundUnits = (n: number): number => Math.round((Number(n) || 0) * 10000) / 10000;

const settleLinkedFiadoDeposits = async (accountId: string, reservationId: string): Promise<void> => {
  try {
    const snap = await getDocs(
      query(
        collection(db, RESERVATION_DEPOSITS_COLLECTION),
        where('accountId', '==', accountId),
        where('reservationId', '==', reservationId),
        where('status', '==', 'active')
      )
    );
    if (snap.empty) return;
    await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(snap.docs.map((d) => tx.get(d.ref)));
      snaps.forEach((docSnap) => {
        if (docSnap.exists() && docSnap.data()?.status === 'active') {
          tx.update(docSnap.ref, { status: 'settled' });
        }
      });
    });
  } catch (err) {
    console.warn('[CRMService] No se pudieron liquidar depósitos vinculados:', err);
  }
};

/**
 * Devuelve mercadería de un fiado activo: reingresa stock físico por unidad/variante,
 * reduce `currentDebt` (acumulando excedente en `credits`), marca `settled` si llega a 0
 * y registra el comprobante en `fiado_returns`.
 */
export const returnFiadoMerchandise = async (
  params: ReturnFiadoMerchandiseParams
): Promise<{ remaining: number; settled: boolean; creditApplied: number; returnAmount: number }> => {
  const { accountId, reservationId, items, reason, userProfile } = params;
  if (!accountId || !reservationId) throw new Error('Cuenta y fiado son requeridos.');
  if (!reason || reason.trim().length < 3) {
    throw new Error('Indica el motivo de la devolución (mínimo 3 caracteres).');
  }
  if (!userProfile?.uid) throw new Error('Operador no autenticado.');
  if (!Array.isArray(items) || items.every((i) => !(Number(i.quantity) > 0))) {
    throw new Error('Indica al menos un producto a devolver.');
  }

  const reservationRef = doc(db, RESERVATIONS_COLLECTION, reservationId);
  const returnRef = doc(collection(db, FIADO_RETURNS_COLLECTION));
  const now = Date.now();
  const actorName = userProfile.displayName || userProfile.email || 'Usuario';

  let remaining = 0;
  let settled = false;
  let creditApplied = 0;
  let returnValue = 0;

  await runTransaction(db, async (tx) => {
    const resSnap = await tx.get(reservationRef);
    if (!resSnap.exists()) throw new Error('Fiado no encontrado.');
    const resData = resSnap.data() as Record<string, any>;
    if (resData.accountId !== accountId) throw new Error('El fiado no pertenece a esta cuenta.');
    if (!(resData.type === 'fiado' || resData.isCreditSale === true || resData.isFiado === true)) {
      throw new Error('Esta operación solo aplica a fiados.');
    }
    if (resData.status !== 'pending') throw new Error('El fiado no está pendiente.');
    if (!resData.customerId) throw new Error('El fiado no tiene cliente.');

    const resItems: any[] = Array.isArray(resData.items) ? resData.items : [];
    const alreadyReturned = new Map<string, number>();
    for (const ret of resData.returnHistory || []) {
      for (const line of ret.items || []) {
        const pid = String(line.productId || '');
        alreadyReturned.set(pid, (alreadyReturned.get(pid) || 0) + (Number(line.quantity) || 0));
      }
    }

    const returnLines: FiadoReturnRecord['items'] = [];
    returnValue = 0;
    for (const reqLine of items) {
      const qty = Number(reqLine.quantity) || 0;
      if (!(qty > 0)) continue;
      const original = resItems.find((i) => String(i.id || i.productId) === String(reqLine.productId));
      if (!original) throw new Error('El producto no pertenece a este fiado.');
      const origPid = String(original.id || original.productId);
      const used = alreadyReturned.get(origPid) || 0;
      const maxQty = Number(original.quantity) || 0;
      if (used + qty > maxQty) {
        throw new Error(`No se puede devolver más de lo entregado de ${original.name || original.productName || origPid}.`);
      }
      const unitPrice = Number(original.price) || 0;
      const costPrice = Number(original.costPrice);
      const factor = Number(original.presentationQty) > 0
        ? Number(original.presentationQty)
        : Number(original.conversionFactor) > 0
          ? Number(original.conversionFactor)
          : 1;
      const stockUnits = roundUnits(qty * factor);
      returnLines.push({
        productId: origPid,
        name: original.name || original.productName || 'Producto',
        quantity: qty,
        stockUnits,
        ...(original.variantId ? { variantId: original.variantId } : {}),
        ...(original.presentationId ? { presentationId: original.presentationId } : {}),
        ...(factor > 1 ? { presentationQty: factor } : {}),
        unitPrice,
        costPrice: Number.isFinite(costPrice) ? costPrice : 0,
      });
      returnValue = roundCents(returnValue + unitPrice * qty);
      alreadyReturned.set(origPid, used + qty);
    }

    if (!returnLines.length || !(returnValue > 0)) {
      throw new Error('La devolución no tiene un monto válido.');
    }

    const customerRef = doc(db, CUSTOMERS_COLLECTION, resData.customerId);
    const productIds = [...new Set(returnLines.map((l) => l.productId))];
    const [custSnap, ...prodSnaps] = await Promise.all([
      tx.get(customerRef),
      ...productIds.map((pid) => tx.get(doc(db, PRODUCTS_COLLECTION, pid))),
    ]);

    if (!custSnap.exists()) throw new Error('Cliente no encontrado.');

    const branchId = String(resData.branchId || '');
    for (let idx = 0; idx < productIds.length; idx += 1) {
      const pid = productIds[idx];
      const pSnap = prodSnaps[idx];
      if (!pSnap.exists()) {
        const label = returnLines.find((l) => l.productId === pid)?.name || pid;
        throw new Error(`Producto no encontrado: ${label}`);
      }
      const product = pSnap.data() as Record<string, any>;
      const productLines = returnLines.filter((l) => l.productId === pid);
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const usesVariants = variants.length > 0 && productLines.some((l) => Boolean(l.variantId));

      if (usesVariants) {
        const nextVariants = variants.map((v: any) => ({ ...v, stock: { ...(v.stock || {}) } }));
        for (const line of productLines) {
          if (!line.variantId) throw new Error(`${product.name || pid}: variante requerida en devolución.`);
          const vIdx = nextVariants.findIndex((v: any) => v.id === line.variantId);
          if (vIdx === -1) throw new Error(`${product.name || pid}: variante ${line.variantId} ya no existe.`);
          const prev = Number(nextVariants[vIdx].stock?.[branchId]) || 0;
          nextVariants[vIdx].stock[branchId] = roundUnits(prev + (Number(line.stockUnits) || line.quantity));
        }
        const aggregated: Record<string, number> = {};
        for (const v of nextVariants) {
          for (const [b, q] of Object.entries(v.stock || {})) {
            aggregated[b] = roundUnits((aggregated[b] || 0) + (Number(q) || 0));
          }
        }
        tx.update(pSnap.ref, {
          variants: nextVariants,
          stock: aggregated,
          branchIds: deriveBranchIds(aggregated),
          lowStockBranches: deriveLowStockBranches(aggregated, product.reservedStock),
        });
      } else {
        const nextStock = { ...(product.stock || {}) };
        const addedUnits = productLines.reduce((sum, l) => sum + (Number(l.stockUnits) || l.quantity), 0);
        nextStock[branchId] = roundUnits((Number(nextStock[branchId]) || 0) + addedUnits);
        tx.update(pSnap.ref, {
          stock: nextStock,
          branchIds: deriveBranchIds(nextStock),
          lowStockBranches: deriveLowStockBranches(nextStock, product.reservedStock),
        });
      }
    }

    const nextReturned = roundCents((Number(resData.returnedAmount) || 0) + returnValue);
    const total = Number(resData.total) || 0;
    const paidAmount = Number(resData.paidAmount) || 0;
    const nextRemaining = roundCents(Math.max(0, total - paidAmount - nextReturned));
    const shouldSettle = nextRemaining <= 0;
    const surplus = roundCents(Math.max(0, paidAmount + nextReturned - total));

    const currentDebt = Number(custSnap.data()?.currentDebt) || 0;
    const nextDebt = roundCents(Math.max(0, currentDebt - returnValue));
    const currentCredits = Number(custSnap.data()?.credits) || 0;

    const historyEntry: FiadoReturnRecord = {
      date: now,
      reason: reason.trim(),
      operatorId: userProfile.uid,
      operatorName: actorName,
      items: returnLines,
      amount: returnValue,
    };

    tx.update(reservationRef, cleanFirestoreData({
      returnedAmount: nextReturned,
      returnHistory: [...(resData.returnHistory || []), historyEntry],
      ...(shouldSettle ? { status: 'settled', settledDate: now } : {}),
    }));

    tx.update(customerRef, {
      currentDebt: nextDebt,
      ...(surplus > 0 ? { credits: roundCents(currentCredits + surplus) } : {}),
    });

    tx.set(returnRef, cleanFirestoreData({
      accountId: resData.accountId,
      branchId: resData.branchId,
      reservationId,
      reservationNumber: resData.reservationNumber || 0,
      customerId: resData.customerId,
      date: now,
      reason: reason.trim(),
      operatorId: userProfile.uid,
      operatorName: actorName,
      items: returnLines.map((line) => ({
        productId: line.productId,
        name: line.name,
        quantity: line.quantity,
        stockUnits: line.stockUnits ?? line.quantity,
        ...(line.presentationQty ? { presentationQty: line.presentationQty } : {}),
        ...(line.variantId ? { variantId: line.variantId } : {}),
        costPrice: line.costPrice || 0,
        salePrice: line.unitPrice,
      })),
      amount: returnValue,
      createdAt: serverTimestamp(),
    }));

    remaining = nextRemaining;
    settled = shouldSettle;
    creditApplied = surplus;
  });

  if (settled) {
    await settleLinkedFiadoDeposits(accountId, reservationId);
  }

  return { remaining, settled, creditApplied, returnAmount: returnValue };
};

/**
 * Castiga un fiado incobrable (`status: 'written_off'`). Solo owner/admin según firestore.rules.
 * No toca stock ni caja; reduce `currentDebt` por el saldo pendiente del fiado.
 */
export const writeOffFiado = async (
  params: WriteOffFiadoParams
): Promise<{ writeOffAmount: number; nextDebt: number }> => {
  const { accountId, reservationId, reason, userProfile } = params;
  if (!accountId || !reservationId) throw new Error('Cuenta y fiado son requeridos.');
  if (!reason || reason.trim().length < 3) {
    throw new Error('Indica el motivo del castigo (mínimo 3 caracteres).');
  }
  if (!userProfile?.uid) throw new Error('El operador es obligatorio.');

  const reservationRef = doc(db, RESERVATIONS_COLLECTION, reservationId);
  let writeOffAmount = 0;
  let nextDebt = 0;

  await runTransaction(db, async (tx) => {
    const resSnap = await tx.get(reservationRef);
    if (!resSnap.exists()) throw new Error('Fiado no encontrado.');
    const resData = resSnap.data() as Record<string, any>;
    if (resData.accountId !== accountId) throw new Error('El fiado no pertenece a esta cuenta.');
    if (!(resData.type === 'fiado' || resData.isCreditSale === true || resData.isFiado === true)) {
      throw new Error('Esta operación solo aplica a fiados.');
    }
    if (resData.status !== 'pending') throw new Error('Este fiado no se puede castigar porque ya fue resuelto.');
    const remaining = roundCents(
      Math.max(0, (Number(resData.total) || 0) - (Number(resData.paidAmount) || 0) - (Number(resData.returnedAmount) || 0))
    );
    if (!(remaining > 0)) throw new Error('Este fiado no tiene saldo pendiente por castigar.');
    if (!resData.customerId) throw new Error('El fiado no tiene cliente.');

    const customerRef = doc(db, CUSTOMERS_COLLECTION, resData.customerId);
    const custSnap = await tx.get(customerRef);
    if (!custSnap.exists()) throw new Error('Cliente no encontrado.');

    writeOffAmount = remaining;
    nextDebt = roundCents(Math.max(0, (Number(custSnap.data()?.currentDebt) || 0) - remaining));
    const now = Date.now();

    tx.update(reservationRef, {
      status: 'written_off',
      writtenOffAt: now,
      writtenOffBy: userProfile.uid,
      writtenOffByName: userProfile.displayName || userProfile.email || 'Administrador',
      writeOffReason: reason.trim(),
      writeOffAmount,
    });
    tx.update(customerRef, { currentDebt: nextDebt });
  });

  await settleLinkedFiadoDeposits(accountId, reservationId);
  return { writeOffAmount, nextDebt };
};

/**
 * Recalcula la deuda real del cliente en el servidor (`POST /api/customers/recalculate-debt`).
 * Requiere rol owner/admin y permiso `manage_customers`.
 */
export const recalculateCustomerDebt = async (
  accountId: string,
  customerId: string
): Promise<{ previousDebt: number; recalculatedDebt: number; diff?: number }> => {
  return apiRequest<{ previousDebt: number; recalculatedDebt: number; diff?: number }>(
    '/api/customers/recalculate-debt',
    {
      method: 'POST',
      body: { accountId, customerId },
    }
  );
};

// ============================================================================
// 2. GESTIÓN DE PEDIDOS Y RESERVAS
// ============================================================================

/**
 * Consulta pedidos y reservas de la sucursal
 */
export const getReservationsAndOrders = async (
  accountId: string,
  branchId: string,
  typeOrMaxResults?: 'reservation' | 'order' | number,
  optionalMaxResults = 60
): Promise<ReservationOrder[]> => {
  const type = typeof typeOrMaxResults === 'string' ? typeOrMaxResults : undefined;
  const maxResults = typeof typeOrMaxResults === 'number' ? typeOrMaxResults : (optionalMaxResults || 60);

  try {
    const fetchCol = async (colName: string, t: 'reservation' | 'order'): Promise<ReservationOrder[]> => {
      const coll = collection(db, colName);
      let snap;
      try {
        const q = query(
          coll,
          where('accountId', '==', accountId),
          where('branchId', '==', branchId),
          orderBy('createdAt', 'desc'),
          ...applyLimit(maxResults)
        );
        snap = await getDocs(q);
      } catch (err: any) {
        console.warn(`[CRMService] Fallback sin orderBy para ${colName}:`, err?.message);
        const fallbackQ = query(
          coll,
          where('accountId', '==', accountId),
          where('branchId', '==', branchId),
          ...applyLimit(maxResults)
        );
        snap = await getDocs(fallbackQ);
      }
      return snap.docs.map((d) => ({
        id: d.id,
        type: t,
        ...(d.data() as any),
      }));
    };

    const fetchTasks: Array<Promise<ReservationOrder[]>> = [];
    if (!type || type === 'reservation') {
      fetchTasks.push(fetchCol(RESERVATIONS_COLLECTION, 'reservation'));
    }
    if (!type || type === 'order') {
      fetchTasks.push(fetchCol(ORDERS_COLLECTION, 'order'));
    }
    const results = (await Promise.all(fetchTasks)).flat();

    // Ordenar descendente por fecha de creación
    results.sort((a, b) => {
      const tA = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Number(a.createdAt) || 0;
      const tB = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Number(b.createdAt) || 0;
      return tB - tA;
    });

    return results;
  } catch (err) {
    console.error('[CRMService] Error obteniendo reservas y pedidos:', err);
    return [];
  }
};

/**
 * Crea una reserva o pedido incrementando el stock comprometido
 * (`reservedStock.${branchId}`) en los productos para evitar sobreventas.
 * 
 * Reglas estrictas:
 * - Cumple `firestore.rules` línea 973: exige en la raíz `createdBy: userProfile.uid`
 *   y `customerName: customer.name.trim()`.
 * - Al actualizar `reservedStock.${branchId}` en `products`, NO incluye `updatedAt`
 *   para no violar el diff de cajeros (`affectedKeys().hasOnly(...)`).
 * - Si `depositAmount > 0`, crea documento oficial en `reservation_deposits`
 *   (u `order_deposits`), actualiza contadores de caja y genera movimiento de caja chica.
 */
export const createReservationOrOrder = async (
  data: CreateReservationOrderParams
): Promise<string> => {
  const {
    accountId,
    branchId,
    sessionId,
    type,
    items,
    total,
    depositAmount,
    paymentMethod,
    customer,
    pickupDate,
    notes,
    userProfile,
  } = data;

  if (!accountId || !branchId) {
    throw new Error('Parámetros de cuenta y sucursal requeridos.');
  }

  if (!items || items.length === 0) {
    throw new Error('El pedido o reserva debe incluir al menos un producto.');
  }
  if (items.some((line) => !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0 || !Number.isFinite(Number(line.price)) || Number(line.price) < 0)) {
    throw new Error('Revisa las cantidades y precios de los productos antes de continuar.');
  }

  const targetColl = type === 'order' ? ORDERS_COLLECTION : RESERVATIONS_COLLECTION;
  const docRef = doc(collection(db, targetColl));
  const reservationId = docRef.id;

  const normTotal = Math.round(total * 100) / 100;
  const normDeposit = Math.round(depositAmount * 100) / 100;
  if (!Number.isFinite(normTotal) || normTotal < 0 || !Number.isFinite(normDeposit) || normDeposit < 0 || normDeposit > normTotal) throw new Error('El total y adelanto deben ser válidos y el adelanto no puede superar el total.');
  if (normDeposit > 0 && !sessionId) throw new Error('Abre una caja antes de registrar el adelanto.');
  const remainingAmount = Math.max(0, Math.round((normTotal - normDeposit) * 100) / 100);
  const trimmedCustomerName = (customer?.name || 'Cliente').trim();

  // Match Web's daily display sequence. Client transactions cannot read queries;
  // like the web, number allocation is best effort, separate from stock atomicity.
  let canonicalReservationNumber: number | undefined;
  if (type === 'reservation') {
    const nowForNumber = new Date();
    const dayStart = new Date(nowForNumber.getFullYear(), nowForNumber.getMonth(), nowForNumber.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;
    const coll = collection(db, RESERVATIONS_COLLECTION);
    try {
      const topReservationQ = query(
        coll,
        where('accountId', '==', accountId),
        where('branchId', '==', branchId),
        where('date', '>=', dayStart),
        where('date', '<=', dayEnd),
        orderBy('reservationNumber', 'desc'),
        ...applyLimit(1)
      );
      const topSnap = await getDocs(topReservationQ);
      if (!topSnap.empty) {
        const topVal = Number(topSnap.docs[0].data()?.reservationNumber);
        canonicalReservationNumber = (Number.isFinite(topVal) ? topVal : 0) + 1;
      } else {
        canonicalReservationNumber = 1;
      }
    } catch (err: any) {
      console.warn('[CRMService] Fallback calculando canonicalReservationNumber:', err?.message);
      try {
        const fallbackQ = query(
          coll,
          where('accountId', '==', accountId),
          where('branchId', '==', branchId),
          where('date', '>=', dayStart),
          where('date', '<=', dayEnd)
        );
        const dayReservations = await getDocs(fallbackQ);
        canonicalReservationNumber = dayReservations.docs.reduce((max: number, reservation: any) => {
          const value = Number(reservation.data()?.reservationNumber);
          return Number.isFinite(value) ? Math.max(max, value) : max;
        }, 0) + 1;
      } catch {
        canonicalReservationNumber = 1;
      }
    }
  }


  await runTransaction(db, async (tx) => {
    // 0. Ejecutar TODAS las lecturas (tx.get) en paralelo antes de cualquier escritura (requisito de Firestore)
    const requirements = type === 'reservation' ? aggregateStockRequirements(items) : [];
    const productRefs = requirements.map((requirement) => doc(db, PRODUCTS_COLLECTION, requirement.productId));
    const sessionRef = normDeposit > 0 && sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;

    const [productSnaps, sSnap] = await Promise.all([
      Promise.all(productRefs.map((pRef) => tx.get(pRef))),
      sessionRef ? tx.get(sessionRef) : Promise.resolve(null),
    ]);

    const productReads: Array<{ pRef: any; pSnap: any; unitsToReserve: number }> = [];
    for (let i = 0; i < requirements.length; i += 1) {
      const requirement = requirements[i];
      const unitsToReserve = requirement.units;
      const pRef = productRefs[i];
      const pSnap = productSnaps[i];
      if (!pSnap.exists()) throw new Error(`No se encontró el producto ${requirement.items[0]?.name || requirement.items[0]?.productName || ''}.`);
      const product = pSnap.data();
      if (product.accountId !== accountId) throw new Error('Uno de los productos no pertenece a esta cuenta.');
      const physical = Number(product.stock?.[branchId]) || 0;
      const reserved = Number(product.reservedStock?.[branchId]) || 0;
      if (physical - reserved < unitsToReserve) {
        throw new Error(`Stock insuficiente para ${requirement.items[0]?.name || requirement.items[0]?.productName || 'un producto'}.`);
      }
      productReads.push({ pRef, pSnap, unitsToReserve });
    }

    const sessionData = sSnap ? requireOpenSession(sSnap, accountId, branchId) : null;

    // 1. Apartar stock reservado en cada producto SIN enviar updatedAt (permitido para cajeros)
    for (const { pRef, pSnap, unitsToReserve } of productReads) {
      if (pSnap.exists()) {
        const pData = pSnap.data();
        const currentReserved = pData.reservedStock?.[branchId] || 0;
        const newReserved = Math.round((currentReserved + unitsToReserve) * 10000) / 10000;

        tx.update(pRef, {
          [`reservedStock.${branchId}`]: newReserved,
        });
      }
    }

    // 2. Guardar documento en el esquema compartido de Web
    const now = Date.now();
    tx.set(docRef, {
      id: reservationId,
      accountId,
      branchId,
      type,
      attributionVersion: 1,
      items: normalizeOrderItems(items),
      total: normTotal,
      depositAmount: normDeposit,
      remainingAmount,
      status: 'pending',
      // Campos obligatorios en la raíz por firestore.rules línea 973:
      createdBy: userProfile.uid,
      customerName: trimmedCustomerName,
      customerId: customer?.id || null,
      customerPhone: customer?.phone || '',
      customerDocument: customer?.documentNumber || '',
      // Objeto customer completo para compatibilidad:
      customer: {
        id: customer?.id || null,
        name: trimmedCustomerName,
        phone: customer?.phone || '',
        documentNumber: customer?.documentNumber || '',
      },
      ...(type === 'reservation' ? {
        reservationNumber: canonicalReservationNumber,
        date: now,
        expiryDate: now + 7 * 24 * 60 * 60 * 1000,
      } : {
        orderNumber: Number(now.toString().slice(-6)),
        date: now,
      }),
      pickupDate: pickupDate || null,
      notes: notes || '',
      createdByName: userProfile.displayName || userProfile.email || 'Usuario',
      createdAt: serverTimestamp(),
    });

    // 3. Si se pagó adelanto, registrar en reservation_deposits / order_deposits
    if (normDeposit > 0) {
      const depositCollName = type === 'order' ? ORDER_DEPOSITS_COLLECTION : RESERVATION_DEPOSITS_COLLECTION;
      const depositDocRef = doc(collection(db, depositCollName));
      const depositId = depositDocRef.id;

      tx.set(depositDocRef, {
        id: depositId,
        reservationId,
        orderId: type === 'order' ? reservationId : null,
        amount: normDeposit,
        paymentMethod,
        customerName: trimmedCustomerName,
        customerId: customer?.id || null,
        branchId,
        accountId,
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
        date: Date.now(),
        status: 'active',
        purpose: type === 'order' ? 'order' : 'reservation',
        refundable: true,
        cashSessionId: sessionId || null,
        createdAt: serverTimestamp(),
      });

      // Actualizar sesión de caja activa si se suministró sessionId
      if (sessionId && sessionRef && sSnap) {
        if (sSnap && sessionData) {
          const sData = sessionData;
          tx.update(sessionRef, {
            ...getDepositSessionUpdates(sData, type, paymentMethod, normDeposit),
            updatedAt: serverTimestamp(),
          });
        }

        // Si fue en efectivo, crear movimiento en la caja chica
        const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
        if (isCash) {
          const mvRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
          tx.set(mvRef, {
            accountId,
            branchId,
            sessionId,
            type: 'income',
            category: 'deposit',
            amount: normDeposit,
            description: `Adelanto ${type === 'order' ? 'Pedido' : 'Reserva'} #${reservationId.slice(-6)}: ${trimmedCustomerName}`,
            referenceId: depositId,
            reservationId,
            createdBy: userProfile.uid,
            createdByName: userProfile.displayName || userProfile.email || 'Usuario',
            createdAt: serverTimestamp(),
          });
        }
      }
    }
  });

  return reservationId;
};

/**
 * Registra un abono posterior en una reserva o pedido existente:
 * - Guarda el comprobante en `reservation_deposits` (u `order_deposits`) con `status: 'active'`.
 * - Actualiza `depositAmount` y `remainingAmount` en la reserva/pedido.
 * - Actualiza los acumuladores en `cash_register_sessions`.
 */
export const registerReservationPayment = async (
  params: RegisterReservationPaymentParams
): Promise<string> => {
  const {
    accountId,
    branchId,
    sessionId,
    reservationId,
    type = 'reservation',
    amount,
    paymentMethod,
    notes,
    userProfile,
  } = params;

  if (!accountId || !branchId || !reservationId) {
    throw new Error('Cuenta, sucursal e ID de reserva son obligatorios.');
  }

  if (typeof amount !== 'number' || amount <= 0 || isNaN(amount)) {
    throw new Error('El monto del abono debe ser mayor a cero.');
  }
  if (!sessionId) throw new Error('Abre una caja antes de registrar un abono.');

  const normalizedAmount = Math.round(amount * 100) / 100;
  const targetColl = type === 'order' ? ORDERS_COLLECTION : RESERVATIONS_COLLECTION;
  const resDocRef = doc(db, targetColl, reservationId);
  const depositColl = type === 'order' ? ORDER_DEPOSITS_COLLECTION : RESERVATION_DEPOSITS_COLLECTION;
  const depositDocRef = doc(collection(db, depositColl));
  const depositId = depositDocRef.id;

  const sessionRef = sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;

  await runTransaction(db, async (tx) => {
    const [resSnap, sSnap] = await Promise.all([
      tx.get(resDocRef),
      sessionRef ? tx.get(sessionRef) : Promise.resolve(null),
    ]);
    if (!resSnap.exists()) {
      throw new Error(`La ${type === 'order' ? 'orden' : 'reserva'} no existe.`);
    }

    const sessionData = sSnap ? requireOpenSession(sSnap, accountId, branchId) : null;

    const rData = resSnap.data();
    if (rData.status === 'cancelled' || rData.status === 'completed') {
      throw new Error(`No se pueden registrar pagos en una ${type === 'order' ? 'orden' : 'reserva'} con estado "${rData.status}".`);
    }

    const total = Number(rData.total) || 0;
    const currentDeposit = Number(rData.depositAmount) || 0;
    const newDeposit = Math.round((currentDeposit + normalizedAmount) * 100) / 100;
    const newRemaining = Math.max(0, Math.round((total - newDeposit) * 100) / 100);
    const customerName = (rData.customerName || rData.customer?.name || 'Cliente').trim();

    // 1. Actualizar reserva/orden
    tx.update(resDocRef, {
      depositAmount: newDeposit,
      remainingAmount: newRemaining,
      updatedAt: serverTimestamp(),
    });

    // 2. Registrar comprobante oficial de depósito
    tx.set(depositDocRef, {
      id: depositId,
      reservationId,
      orderId: type === 'order' ? reservationId : null,
      amount: normalizedAmount,
      paymentMethod,
      customerName,
      customerId: rData.customerId || rData.customer?.id || null,
      branchId,
      accountId,
      createdBy: userProfile.uid,
      createdByName: userProfile.displayName || userProfile.email || 'Usuario',
      date: Date.now(),
      status: 'active',
      purpose: type === 'order' ? 'order' : 'reservation',
      refundable: true,
      cashSessionId: sessionId || null,
      notes: notes || '',
      createdAt: serverTimestamp(),
    });

    // 3. Si hay sesión de caja activa, actualizar acumuladores oficiales
    if (sessionId && sessionRef && sSnap) {
      if (sSnap && sessionData) {
        const sData = sessionData;
        tx.update(sessionRef, {
          ...getDepositSessionUpdates(sData, type, paymentMethod, normalizedAmount),
          updatedAt: serverTimestamp(),
        });
      }

      // Si fue en efectivo, crear movimiento en caja chica
      const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
      if (isCash) {
        const mvRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
        tx.set(mvRef, {
          accountId,
          branchId,
          sessionId,
          type: 'income',
          category: 'deposit',
          amount: normalizedAmount,
          description: `Abono ${type === 'order' ? 'Pedido' : 'Reserva'} #${reservationId.slice(-6)}: ${customerName}`,
          referenceId: depositId,
          reservationId,
          createdBy: userProfile.uid,
          createdByName: userProfile.displayName || userProfile.email || 'Usuario',
          createdAt: serverTimestamp(),
        });
      }
    }
  });

  return depositId;
};

/** Approve an order and reserve its catalog stock once. */
export const approveOrder = async (orderId: string): Promise<void> => {
  const orderRef = doc(db, ORDERS_COLLECTION, orderId);
  await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('El pedido no existe.');
    const order = orderSnap.data();
    if (order.status !== 'pending') throw new Error('El pedido ya fue revisado.');

    const orderItems = (order.items || []).filter((item: any) => !item.isCustomProduct);
    const requirements = aggregateStockRequirements(orderItems);
    const productRefs = requirements.map((requirement) => doc(db, PRODUCTS_COLLECTION, requirement.productId));
    const productSnaps = await Promise.all(productRefs.map((productRef) => tx.get(productRef)));

    const products: Array<{ ref: any; snap: any; units: number; productId: string; label: string }> = [];
    for (let i = 0; i < requirements.length; i += 1) {
      const requirement = requirements[i];
      const productRef = productRefs[i];
      const productSnap = productSnaps[i];
      const label = requirement.items[0]?.name || requirement.items[0]?.productName || '';
      if (!productSnap.exists()) throw new Error(`No se encontró el producto ${label}.`);
      if (productSnap.data().accountId !== order.accountId) throw new Error(`El producto ${label} no pertenece a esta cuenta.`);
      if (!Number.isFinite(requirement.units) || requirement.units <= 0) throw new Error(`Cantidad inválida para ${label || 'un producto'}.`);
      products.push({ ref: productRef, snap: productSnap, units: requirement.units, productId: requirement.productId, label });
    }
    const legacyAlreadyReserved = isLegacyReservedOrder(order);
    for (const { snap, units, label } of products) {
      const product = snap.data();
      const physical = Number(product.stock?.[order.branchId]) || 0;
      const reserved = Number(product.reservedStock?.[order.branchId]) || 0;
      if (legacyAlreadyReserved) {
        if (reserved < units) throw new Error(`La reserva histórica de ${label || 'un producto'} no coincide. Actualiza los datos.`);
      } else if (physical - reserved < units) {
        throw new Error(`Stock insuficiente para ${label || 'un producto'}.`);
      }
    }
    if (!legacyAlreadyReserved) {
      for (const { ref, snap, units } of products) {
        const product = snap.data();
        const reserved = Number(product.reservedStock?.[order.branchId]) || 0;
        tx.update(ref, { [`reservedStock.${order.branchId}`]: Math.round((reserved + units) * 10000) / 10000 });
      }
    }
    tx.update(orderRef, {
      status: 'approved',
      attributionVersion: 1,
      items: normalizeOrderItems(order.items || []),
      productionStartDate: Date.now(),
      approvedAt: Date.now(),
      updatedAt: serverTimestamp(),
    });
  });
};

export interface CompletePaymentParams {
  paymentMethod?: string;
  amount?: number;
  paymentMethodId?: string;
  paymentCategory?: string;
  sellerId?: string;
  sellerName?: string;
  sessionId?: string;
  documentType?: 'nota_venta' | 'boleta' | 'factura' | '03' | '01' | string;
  surchargeAmount?: number;
  chargedAmount?: number;
  commissionAmount?: number;
  commissionPercent?: number;
  commissionRule?: string;
  customer?: {
    id?: string;
    name?: string;
    phone?: string;
    dni?: string;
    ruc?: string;
    documentNumber?: string;
    address?: string;
    email?: string;
  };
  onSunatResult?: (result: any) => void;
  /** Optional deposit refund when cancelling a reservation or order. Omitted keeps the deposit. */
  refundMethod?: string;
  refundPercent?: number;
}

/** Completion uses the shared server transaction; cancellation releases held stock and can refund its deposit atomically. */
export const completeOrCancelReservation = async (
  item: ReservationOrder,
  action: 'complete' | 'cancel',
  userProfile: UserProfileInfo,
  paymentInfo?: CompletePaymentParams
): Promise<void> => {
  if (action === 'complete') {
    if (!paymentInfo?.sessionId) throw new Error('Abre una caja antes de completar la entrega.');
    const paymentMethod = paymentInfo.paymentMethod || 'efectivo';
    const rawDoc = String(paymentInfo.documentType || 'nota_venta').toLowerCase();
    const documentType =
      rawDoc === 'factura' || rawDoc === '01'
        ? 'factura'
        : rawDoc === 'boleta' || rawDoc === '03'
          ? 'boleta'
          : 'nota_venta';

    const mergedCustomer = {
      ...(item.customer || {}),
      ...(paymentInfo.customer || {}),
    };
    const cleanDoc = String(
      mergedCustomer.ruc || mergedCustomer.dni || mergedCustomer.documentNumber || item.customerDocument || ''
    ).replace(/\D/g, '');

    if (documentType === 'factura' && cleanDoc.length !== 11) {
      throw new Error('La Factura requiere un RUC válido de 11 dígitos en el cliente.');
    }

    const salePayload = cleanFirestoreData({
      accountId: item.accountId,
      branchId: item.branchId,
      sessionId: paymentInfo.sessionId,
      total: Number(item.total) || 0,
      subtotal: Number(item.total) || 0,
      tax: 0,
      paymentMethod,
      sellerId: paymentInfo.sellerId,
      sellerName: paymentInfo.sellerName,
      paymentMethodId: paymentInfo.paymentMethodId || paymentMethod,
      paymentCategory: paymentInfo.paymentCategory || (paymentMethod === 'efectivo' ? 'cash' : paymentMethod),
      documentType,
      ...(Number.isFinite(Number(paymentInfo.surchargeAmount)) && Number(paymentInfo.surchargeAmount) > 0
        ? { surchargeAmount: roundCents(Number(paymentInfo.surchargeAmount)) }
        : {}),
      ...(Number.isFinite(Number(paymentInfo.chargedAmount)) && Number(paymentInfo.chargedAmount) >= 0
        ? { chargedAmount: roundCents(Number(paymentInfo.chargedAmount)) }
        : {}),
      ...(Number.isFinite(Number(paymentInfo.commissionAmount)) && Number(paymentInfo.commissionAmount) > 0
        ? { commissionAmount: roundCents(Number(paymentInfo.commissionAmount)) }
        : {}),
      ...(Number.isFinite(Number(paymentInfo.commissionPercent)) && Number(paymentInfo.commissionPercent) > 0
        ? { commissionPercent: Number(paymentInfo.commissionPercent) }
        : {}),
      ...(paymentInfo.commissionRule ? { commissionRule: paymentInfo.commissionRule } : {}),
      customerId: mergedCustomer.id || item.customerId || undefined,
      customerName: mergedCustomer.name || item.customerName || undefined,
      customerPhone: mergedCustomer.phone || item.customerPhone || undefined,
      customerDni: cleanDoc.length === 8 ? cleanDoc : undefined,
      customerRuc: cleanDoc.length === 11 ? cleanDoc : undefined,
      customerAddress: mergedCustomer.address || undefined,
      customerEmail: mergedCustomer.email || undefined,
      items: normalizeOrderItems(item.items).map((it) => ({
        id: it.id,
        name: it.name,
        price: Number(it.price) || 0,
        quantity: Number(it.quantity) || 0,
        sku: it.sku || '',
        variantId: it.variantId,
        presentationId: it.presentationId,
        presentationQty: it.presentationQty || it.conversionFactor || 1,
        isCustomProduct: Boolean((it as any).isCustomProduct),
      })),
    });

    const finalizeRes: any = await apiRequest('/api/sales/finalize', {
      method: 'POST',
      body: {
        operationId: `crm-completion-${item.id}`,
        completion: { type: item.type, id: item.id },
        sale: salePayload,
      },
    });

    if ((documentType === 'boleta' || documentType === 'factura') && finalizeRes?.saleId) {
      void (async () => {
        try {
          const { buildSunatEmitOptions, emitToSunatAsync } = await import('./sale-service');
          const emitOptions = buildSunatEmitOptions(
            documentType,
            {
              name: mergedCustomer.name || item.customerName || 'CLIENTE',
              dni: cleanDoc.length === 8 ? cleanDoc : undefined,
              ruc: cleanDoc.length === 11 ? cleanDoc : undefined,
              documentNumber: cleanDoc || undefined,
              address: mergedCustomer.address,
              email: mergedCustomer.email,
            },
            item.notes
          );
          const sunatResult = await emitToSunatAsync(
            finalizeRes.saleId,
            item.accountId,
            item.branchId,
            emitOptions
          );
          paymentInfo.onSunatResult?.(sunatResult);
        } catch (sunatErr) {
          console.warn('[CRMService] Emisión SUNAT diferida o fallida al completar:', sunatErr);
          paymentInfo.onSunatResult?.({
            success: false,
            sunatStatus: 'error',
            error: (sunatErr as Error)?.message || 'Error al despachar comprobante a SUNAT',
          });
        }
      })();
    }
    return;
  }

  const targetColl = item.type === 'order' ? ORDERS_COLLECTION : RESERVATIONS_COLLECTION;
  const docRef = doc(db, targetColl, item.id);
  const refundMethod = paymentInfo?.refundMethod?.trim();
  const depositCollection = item.type === 'order' ? ORDER_DEPOSITS_COLLECTION : RESERVATION_DEPOSITS_COLLECTION;
  const depositLinkField = item.type === 'order' ? 'orderId' : 'reservationId';
  let queriedDepositRef: ReturnType<typeof doc> | null = null;
  if (refundMethod) {
    const activeDepositQuery = query(
      collection(db, depositCollection),
      where(depositLinkField, '==', item.id),
      where('accountId', '==', item.accountId),
      where('branchId', '==', item.branchId),
      where('status', '==', 'active'),
      limit(1),
    );
    const activeDeposits = await getDocs(activeDepositQuery);
    queriedDepositRef = activeDeposits.docs[0]?.ref || null;
  }

  await runTransaction(db, async (tx) => {
    const currentSnap = await tx.get(docRef);
    if (!currentSnap.exists()) throw new Error('La reserva o pedido ya no existe.');
    const current = currentSnap.data();
    if (current.accountId !== item.accountId || current.branchId !== item.branchId) {
      throw new Error('La reserva o pedido no pertenece a esta cuenta y sucursal.');
    }
    if (current.type === 'fiado' || current.isCreditSale === true || current.isFiado === true) {
      throw new Error('Un fiado se cierra devolviendo mercadería, no cancelando la reserva.');
    }
    const allowed = item.type === 'order' ? ['pending', 'approved', 'production', 'ready'] : ['pending'];
    if (!allowed.includes(current.status)) throw new Error('La reserva o pedido ya fue resuelto.');
    const branchId = current.branchId;
    const releases: Array<{ ref: ReturnType<typeof doc>; reserved: number }> = [];
    // Web orders reserve on approval; pending orders have no held inventory.
    const hasReservedInventory = item.type === 'reservation' || current.status !== 'pending' || isLegacyReservedOrder(current);
    const shouldRefundDeposit = Boolean(refundMethod && Number(current.depositAmount) > 0);
    const depositRef = shouldRefundDeposit ? queriedDepositRef : null;
    let sessionRef: ReturnType<typeof doc> | null = null;
    let percentage = 100;

    if (shouldRefundDeposit) {
      if (!paymentInfo?.sessionId) throw new Error('Abre una caja antes de registrar el reembolso.');
      percentage = Number(paymentInfo.refundPercent ?? 100);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        throw new Error('El porcentaje de reembolso debe estar entre 1 y 100.');
      }
      if (!depositRef && item.type !== 'order') {
        throw new Error('No se encontró el depósito activo asociado a esta reserva.');
      }
      sessionRef = doc(db, CASH_SESSIONS_COLLECTION, paymentInfo.sessionId);
    }

    let stockRequirements: ReturnType<typeof aggregateStockRequirements> = [];
    if (hasReservedInventory) {
      if (!Array.isArray(current.items)) throw new Error('La reserva no tiene líneas válidas.');
      const legacyMobileLines = current.items.every((line: any) => line.productId && !line.id);
      const stockLines = current.items.filter((line: any) => !line.isCustomProduct).map((line: any) =>
        current.attributionVersion === 1 || legacyMobileLines ? line : {...line,presentationQty:1,conversionFactor:1});
      stockRequirements = aggregateStockRequirements(stockLines);
    }
    const productRefs = stockRequirements.map((requirement) => doc(db, PRODUCTS_COLLECTION, requirement.productId));

    const [depositSnap, sessionSnap, ...productSnaps] = await Promise.all([
      depositRef ? tx.get(depositRef) : Promise.resolve(null),
      sessionRef ? tx.get(sessionRef) : Promise.resolve(null),
      ...productRefs.map((ref) => tx.get(ref)),
    ]);

    let depositData: Record<string, any> | null = null;
    let sessionData: Record<string, any> | null = null;
    let refundAmount = 0;
    let nextRefundedAmount = 0;
    let depositUpdate: Record<string, any> | null = null;
    let sessionUpdate: Record<string, number> | null = null;
    let refundMovementRef: ReturnType<typeof doc> | null = null;
    let manualLegacyOrderRefund = false;

    if (shouldRefundDeposit) {
      if (depositRef) {
        if (!depositSnap?.exists()) throw new Error('El depósito activo ya no existe. Actualiza los datos antes de cancelar.');
        depositData = depositSnap.data();
        if (depositData.accountId !== current.accountId || depositData.branchId !== current.branchId || depositData[depositLinkField] !== item.id) {
          throw new Error('El depósito no pertenece a esta reserva o pedido.');
        }
        if (depositData.status !== 'active') throw new Error('El depósito ya fue resuelto. Actualiza los datos antes de cancelar.');
        if (depositData.refundable === false) throw new Error('El depósito no es reembolsable.');
      } else {
        // Historical orders without order_deposits still record the refund in the active cash session.
        manualLegacyOrderRefund = true;
      }

      const depositAmount = Number(depositData?.amount ?? current.depositAmount) || 0;
      refundAmount = Math.round((depositAmount * percentage / 100) * 100) / 100;
      if (refundAmount <= 0) throw new Error('El porcentaje de reembolso debe ser mayor a cero.');
      const refundReason = `Cancelación de ${item.type === 'order' ? 'pedido' : 'reserva'} ${item.type === 'order' ? (current.orderNumber ? `#${current.orderNumber}` : `#${item.id.slice(0, 8)}`) : (current.reservationNumber ? `#${current.reservationNumber}` : `#${item.id.slice(0, 8)}`)}`;
      if (depositData) {
        const priorRefund = Number(depositData.refundedAmount) || 0;
        nextRefundedAmount = Math.round((priorRefund + refundAmount) * 100) / 100;
        if (nextRefundedAmount > Number(depositData.amount || 0) + 0.001) throw new Error('El reembolso supera el saldo pendiente del adelanto.');
        depositUpdate = {
          refundedBy: userProfile.uid,
          refundedDate: Date.now(),
          refundReason,
          refundMethod,
          refundedAmount: nextRefundedAmount,
          ...(nextRefundedAmount >= Number(depositData.amount || 0) ? { status: 'refunded' } : {}),
        };
      } else {
        depositUpdate = { refundReason };
      }

      sessionData = requireOpenSession(sessionSnap, item.accountId, item.branchId);
      const refundIsCash = refundMethod!.toLowerCase() === 'cash' || refundMethod!.toLowerCase().includes('efectivo');
      if (manualLegacyOrderRefund) {
        sessionUpdate = {};
        if (refundIsCash) {
          const expected = Number(sessionData.expectedAmount ?? ((Number(sessionData.initialAmount) || 0) + (Number(sessionData.cashSales) || 0)));
          if (expected - refundAmount < 0) throw new Error('No hay suficiente efectivo esperado en la caja para realizar el reembolso.');
          sessionUpdate.expectedAmount = Math.round((expected - refundAmount) * 100) / 100;
        }
      } else {
        const prefix = item.type === 'order' ? 'Order' : 'Reservation';
        const bucket = item.type === 'order' ? 'order' : 'reservation';
        const originalMethod = String(depositData?.paymentMethod || '').toLowerCase();
        const originalBucket = originalMethod === 'cash' || originalMethod.includes('efectivo')
          ? `cash${prefix}Deposits`
          : originalMethod === 'card' || originalMethod.includes('tarjeta')
            ? `card${prefix}Deposits`
            : `digital${prefix}Deposits`;
        sessionUpdate = {
          [`total${prefix}Deposits`]: Math.round(((Number(sessionData[`total${prefix}Deposits`]) || 0) - refundAmount) * 100) / 100,
          [originalBucket]: Math.round(((Number(sessionData[originalBucket]) || 0) - refundAmount) * 100) / 100,
        };
        if (nextRefundedAmount >= Number(depositData?.amount || 0)) {
          sessionUpdate[`${bucket}DepositsCount`] = Math.max(0, (Number(sessionData[`${bucket}DepositsCount`]) || 0) - 1);
        }
        if (refundIsCash) {
          const expected = Number(sessionData.expectedAmount ?? ((Number(sessionData.initialAmount) || 0) + (Number(sessionData.cashSales) || 0)));
          if (expected - refundAmount < 0) throw new Error('No hay suficiente efectivo esperado en la caja para realizar el reembolso.');
          sessionUpdate.expectedAmount = Math.round((expected - refundAmount) * 100) / 100;
        }
      }
      sessionUpdate.auditRevision = (Number(sessionData.auditRevision) || 0) + 1;
      refundMovementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
    }

    if (hasReservedInventory) {
      for (let i = 0; i < stockRequirements.length; i += 1) {
        const requirement = stockRequirements[i];
        const ref = productRefs[i];
        const snapshot = productSnaps[i];
        if (!snapshot.exists() || snapshot.data().accountId !== item.accountId) throw new Error('No se encontró el producto de esta reserva.');
        const reserved = Number(snapshot.data().reservedStock?.[branchId]) || 0;
        if (requirement.units <= 0 || reserved < requirement.units) throw new Error('La reserva de stock no coincide. Actualiza los datos antes de cancelar.');
        releases.push({ ref, reserved: Math.round((reserved - requirement.units) * 10000) / 10000 });
      }
    }
    // Every read completes before mutations; reading the document makes retries safe.
    for (const release of releases) tx.update(release.ref, { [`reservedStock.${branchId}`]: release.reserved });
    if (depositUpdate && sessionRef && sessionUpdate && refundMovementRef) {
      if (depositRef && depositData) tx.update(depositRef, depositUpdate);
      tx.update(sessionRef, sessionUpdate);
      const refundIsCash = refundMethod!.toLowerCase() === 'cash' || refundMethod!.toLowerCase().includes('efectivo');
      tx.set(refundMovementRef, {
        accountId: item.accountId,
        branchId,
        sessionId: paymentInfo!.sessionId,
        amount: refundIsCash ? -refundAmount : 0,
        refundAmount,
        originalPaymentMethod: depositData?.paymentMethod || null,
        ...(manualLegacyOrderRefund ? { type: 'expense' } : {}),
        description: depositUpdate.refundReason,
        reason: depositUpdate.refundReason,
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
        method: manualLegacyOrderRefund ? refundMethod : (refundIsCash ? 'Efectivo' : refundMethod),
        reservationId: item.type === 'reservation' ? item.id : null,
        orderId: item.type === 'order' ? item.id : null,
        depositId: depositRef?.path.split('/').at(-1),
        category: manualLegacyOrderRefund ? refundMethod : item.type === 'order' ? 'order_refund' : 'reservation_refund',
        paymentMethod: manualLegacyOrderRefund ? null : refundMethod,
        createdAt: serverTimestamp(),
      });
    }
    tx.update(docRef, {
      status: 'cancelled',
      cancelledDate: Date.now(),
      completedOrCancelledBy: userProfile.uid,
      completedOrCancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
};

// ============================================================================
// 3. ASISTENTE VENTY IA (SSE STREAM REAL)
// ============================================================================

export interface VentySseState {
  buffer: string;
  reply: string;
}

/** Parses one SSE chunk incrementally (handles split lines across chunks, JSON text deltas, and [DONE]). */
export const consumeVentySseChunk = (
  chunk: string,
  state: VentySseState,
  onChunk?: (accumulatedText: string, delta: string) => void
): boolean => {
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || !line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') return true;

    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed?.error === 'string' && parsed.error) {
        throw new Error(parsed.error);
      }
      const delta =
        typeof parsed?.text === 'string'
          ? parsed.text
          : typeof parsed?.delta === 'string'
            ? parsed.delta
            : typeof parsed?.reply === 'string'
              ? parsed.reply
              : '';
      if (delta) {
        state.reply += delta;
        onChunk?.(state.reply, delta);
      }
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }
  return false;
};

/** Parses a complete buffered SSE response body (Hermes fetch fallback when ReadableStream is unavailable). */
export const parseVentySseText = (
  rawSse: string,
  onChunk?: (accumulatedText: string, delta: string) => void
): string => {
  const state: VentySseState = { buffer: '', reply: '' };
  consumeVentySseChunk(`${rawSse}\n`, state);
  if (onChunk && state.reply) {
    onChunk(state.reply, state.reply);
  }
  return state.reply;
};

/**
 * Consulta `/api/chat/stream` mediante Server-Sent Events (SSE) autenticado.
 * Elimina respuestas locales falsas: ante fallo de red o sin conexión retorna un mensaje claro.
 */
export const askVentyAI = async (
  params: AskVentyAIParams
): Promise<string> => {
  const question = String(params.question ?? params.prompt ?? '').trim();
  if (!question) {
    return 'Escribe una consulta para Venty IA.';
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    return 'Inicia sesión para conversar con Venty IA.';
  }

  let accountId = params.accountId?.trim() || '';
  let branchId = params.branchId?.trim() || '';

  let token: string | undefined;
  try {
    token = await currentUser.getIdToken();
    if (!accountId && typeof (currentUser as any).getIdTokenResult === 'function') {
      const tokenRes = await (currentUser as any).getIdTokenResult();
      accountId = String(tokenRes?.claims?.accountId || '').trim();
      if (!branchId && tokenRes?.claims?.branchId) {
        branchId = String(tokenRes.claims.branchId).trim();
      }
    }
  } catch {
    return 'No se pudo validar tu sesión para consultar a Venty IA.';
  }

  if (!token || !accountId) {
    return 'No se pudo identificar la cuenta activa para consultar a Venty IA.';
  }

  const rawHistory = params.conversationHistory ?? params.history ?? [];
  const conversationHistory = rawHistory
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-10)
    .map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content.trim(),
    }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);

  try {
    const apiBase = (APP_URL || 'https://ventify.com.pe').replace(/\/$/, '');
    const response = await fetch(`${apiBase}/api/chat/stream`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'x-ventify-client': 'v3',
      },
      body: JSON.stringify({
        question,
        accountId,
        ...(branchId ? { branchId } : {}),
        conversationHistory,
      }),
    });

    const contentType = response.headers?.get?.('content-type') || '';

    if (!response.ok) {
      if (contentType.includes('application/json')) {
        const errJson = await response.json().catch(() => null);
        return errJson?.error || 'Venty IA no pudo responder en este momento. Inténtalo nuevamente.';
      }
      return 'Venty IA no pudo procesar tu consulta en este momento. Inténtalo nuevamente.';
    }

    if (contentType.includes('application/json')) {
      const json = await response.json().catch(() => null);
      return json?.reply || json?.content || json?.message || json?.error || 'Venty IA no devolvió contenido.';
    }

    const bodyReader = (response as any).body?.getReader?.();
    if (bodyReader && typeof bodyReader.read === 'function') {
      const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
      const state: VentySseState = { buffer: '', reply: '' };
      while (true) {
        const { done, value } = await bodyReader.read();
        if (done) break;
        const chunkText =
          typeof value === 'string'
            ? value
            : decoder
              ? decoder.decode(value, { stream: true })
              : String(value || '');
        const reachedDone = consumeVentySseChunk(chunkText, state, params.onChunk);
        if (reachedDone) break;
      }
      if (state.buffer.trim()) {
        consumeVentySseChunk('\n', state, params.onChunk);
      }
      return state.reply.trim() || 'Venty IA no devolvió contenido. Intenta reformular tu consulta.';
    }

    const text = await response.text();
    const parsed = parseVentySseText(text, params.onChunk).trim();
    return parsed || 'Venty IA no devolvió contenido. Intenta reformular tu consulta.';
  } catch (netErr: any) {
    if (netErr?.name === 'AbortError') {
      return 'Venty IA tardó demasiado en responder. Verifica tu conexión e inténtalo de nuevo.';
    }
    return 'Sin conexión con Venty IA en este momento. Verifica tu acceso a internet e inténtalo nuevamente.';
  } finally {
    clearTimeout(timeoutId);
  }
};

export default {
  getCustomers,
  saveCustomer,
  registerFiadoPayment,
  getCustomerFiadoHistory,
  returnFiadoMerchandise,
  writeOffFiado,
  recalculateCustomerDebt,
  getReservationsAndOrders,
  createReservationOrOrder,
  registerReservationPayment,
  completeOrCancelReservation,
  askVentyAI,
};
