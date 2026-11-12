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

export interface OpenFiado {
  id: string;
  reservationNumber?: number;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  date: number;
  dueDate?: number;
}

export interface ReservationOrderItem {
  productId?: string;
  productName?: string;
  id?: string;
  name?: string;
  sku?: string;
  price: number;
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
  prompt: string;
  contextSummary?: BusinessKPIContext;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
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

  await runTransaction(db, async (tx) => {
    // 1. Leer saldo actual del cliente y sesión de caja antes de escribir
    const custSnap = await tx.get(customerRef);
    if (!custSnap.exists()) {
      throw new Error(`El cliente con ID ${customer.id} no existe.`);
    }

    const reservationSnap = reservationRef ? await tx.get(reservationRef) : null;
    const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
    const sessionRef = sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;
    const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;
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

    // 5. Si el pago es en efectivo, ingresarlo a la caja chica oficial
    if (isCash && sessionId && sessionRef && sessionSnap) {
      const cashMovementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
      tx.set(cashMovementRef, {
        accountId,
        branchId,
        sessionId,
        type: 'income',
        category: 'fiado_payment',
        amount: appliedAmount,
        description: `Abono de fiado: ${customer.name || cData.name}`,
        referenceId: paymentId,
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
        createdAt: serverTimestamp(),
      });

      // Actualizar sesión si está abierta
      if (sessionSnap && sessionData) {
        const sData = sessionData;
        tx.update(sessionRef, {
          ...getDepositSessionUpdates(sData, 'reservation', paymentMethod, appliedAmount),
          updatedAt: serverTimestamp(),
        });
      }
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
    const snapshot = await getDocs(q);
    const reservationsSnapshot = await getDocs(query(
      collection(db, RESERVATIONS_COLLECTION),
      where('accountId', '==', accountId),
      where('customerId', '==', customerId)
    ));
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
    if (!(data.isFiado === true || data.isCreditSale === true || data.type === 'fiado') || data.status === 'settled' || data.status === 'cancelled') return [];
    const total = Number(data.total) || 0;
    const paidAmount = Number(data.paidAmount) || 0;
    const remainingAmount = Math.max(0, Math.round((total - paidAmount - (Number(data.returnedAmount) || 0)) * 100) / 100);
    if (remainingAmount <= 0) return [];
    return [{
      id: entry.id,
      reservationNumber: Number(data.reservationNumber) || undefined,
      total,
      paidAmount,
      remainingAmount,
      date: toEpochMillis(data.date || data.createdAt),
      dueDate: toEpochMillis(data.dueDate) || undefined,
    }];
  }).sort((a, b) => a.date - b.date);
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
    const results: ReservationOrder[] = [];

    const fetchCol = async (colName: string, t: 'reservation' | 'order') => {
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
      snap.docs.forEach((d) => {
        results.push({
          id: d.id,
          type: t,
          ...(d.data() as any),
        });
      });
    };

    if (!type || type === 'reservation') {
      await fetchCol(RESERVATIONS_COLLECTION, 'reservation');
    }
    if (!type || type === 'order') {
      await fetchCol(ORDERS_COLLECTION, 'order');
    }

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
    // 0. Ejecutar TODAS las lecturas (tx.get) antes de cualquier escritura (requisito de Firestore)
    const productReads: Array<{ pRef: any; pSnap: any; unitsToReserve: number }> = [];
    if (type === 'reservation') {
      for (const requirement of aggregateStockRequirements(items)) {
        const unitsToReserve = requirement.units;
        const pRef = doc(db, PRODUCTS_COLLECTION, requirement.productId);
        const pSnap = await tx.get(pRef);
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
    }


    const sessionRef = normDeposit > 0 && sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;
    const sSnap = sessionRef ? await tx.get(sessionRef) : null;
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

  await runTransaction(db, async (tx) => {
    const resSnap = await tx.get(resDocRef);
    if (!resSnap.exists()) {
      throw new Error(`La ${type === 'order' ? 'orden' : 'reserva'} no existe.`);
    }

    const sessionRef = sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;
    const sSnap = sessionRef ? await tx.get(sessionRef) : null;
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
    const products: Array<{ ref: any; snap: any; units: number; productId: string; label: string }> = [];
    for (const requirement of aggregateStockRequirements(orderItems)) {
      const productRef = doc(db, PRODUCTS_COLLECTION, requirement.productId);
      const productSnap = await tx.get(productRef);
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
    await apiRequest('/api/sales/finalize', {
      method: 'POST',
      body: {
        operationId: `crm-completion-${item.id}`,
        completion: { type: item.type, id: item.id },
        sale: {
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
          documentType: 'nota_venta',
          customerId: item.customer?.id || item.customerId || undefined,
          customerName: item.customer?.name || item.customerName || undefined,
          customerPhone: item.customer?.phone || item.customerPhone || undefined,
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
        },
      },
    });
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
    const depositRef = queriedDepositRef;
    const depositSnap = depositRef ? await tx.get(depositRef) : null;
    let depositData: Record<string, any> | null = null;
    let sessionRef: ReturnType<typeof doc> | null = null;
    let sessionData: Record<string, any> | null = null;
    let refundAmount = 0;
    let nextRefundedAmount = 0;
    let depositUpdate: Record<string, any> | null = null;
    let sessionUpdate: Record<string, number> | null = null;
    let refundMovementRef: ReturnType<typeof doc> | null = null;
    let manualLegacyOrderRefund = false;

    if (refundMethod && Number(current.depositAmount) > 0) {
      if (!paymentInfo?.sessionId) throw new Error('Abre una caja antes de registrar el reembolso.');
      const percentage = Number(paymentInfo.refundPercent ?? 100);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
        throw new Error('El porcentaje de reembolso debe estar entre 1 y 100.');
      }
      if (depositRef) {
        if (!depositSnap?.exists()) throw new Error('El depósito activo ya no existe. Actualiza los datos antes de cancelar.');
        depositData = depositSnap.data();
        if (depositData.accountId !== current.accountId || depositData.branchId !== current.branchId || depositData[depositLinkField] !== item.id) {
          throw new Error('El depósito no pertenece a esta reserva o pedido.');
        }
        if (depositData.status !== 'active') throw new Error('El depósito ya fue resuelto. Actualiza los datos antes de cancelar.');
        if (depositData.refundable === false) throw new Error('El depósito no es reembolsable.');
      } else if (item.type === 'order') {
        // Historical orders without order_deposits still record the refund in the active cash session.
        manualLegacyOrderRefund = true;
      } else {
        throw new Error('No se encontró el depósito activo asociado a esta reserva.');
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

      sessionRef = doc(db, CASH_SESSIONS_COLLECTION, paymentInfo.sessionId);
      const sessionSnap = await tx.get(sessionRef);
      sessionData = requireOpenSession(sessionSnap, item.accountId, item.branchId);
      const refundIsCash = refundMethod.toLowerCase() === 'cash' || refundMethod.toLowerCase().includes('efectivo');
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
      if (!Array.isArray(current.items)) throw new Error('La reserva no tiene líneas válidas.');
      const legacyMobileLines = current.items.every((line: any) => line.productId && !line.id);
      const stockLines = current.items.filter((line: any) => !line.isCustomProduct).map((line: any) =>
        current.attributionVersion === 1 || legacyMobileLines ? line : {...line,presentationQty:1,conversionFactor:1});
      for (const requirement of aggregateStockRequirements(stockLines)) {
        const ref = doc(db, PRODUCTS_COLLECTION, requirement.productId);
        const snapshot = await tx.get(ref);
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
// 3. ASISTENTE VENTY IA
// ============================================================================

/**
 * Generador de respuesta inteligente autónoma basado en KPIs reales del negocio
 */
const generateLocalAIResponse = (
  prompt: string,
  ctx?: BusinessKPIContext
): string => {
  const lower = prompt.toLowerCase();
  const todaySales = ctx?.todaySales ?? 0;
  const salesCount = ctx?.salesCount ?? 0;
  const lowStockCount = ctx?.lowStockCount ?? 0;
  const lowStockItems = ctx?.lowStockItems || [];
  const cashInDrawer = ctx?.cashInDrawer ?? 0;
  const totalDebt = ctx?.totalDebt ?? 0;
  const branch = ctx?.branchName || 'tu sucursal';

  if (lower.includes('ventas') || lower.includes('vendido') || lower.includes('hoy') || lower.includes('cuanto va')) {
    return `📊 **Resumen de Ventas de Hoy (${branch})**:\n- Total Facturado: **S/ ${todaySales.toFixed(2)}**\n- Transacciones: **${salesCount} ventas**\n- Ticket Promedio: **S/ ${(salesCount > 0 ? todaySales / salesCount : 0).toFixed(2)}**\n\n💡 *Tip: Revisa los productos con más movimiento para asegurar existencias en mostrador.*`;
  }

  if (lower.includes('stock') || lower.includes('agotan') || lower.includes('inventario') || lower.includes('falta')) {
    if (lowStockCount === 0) {
      return `✅ **Estado de Inventario Excelente**:\nNo tienes productos con stock crítico en ${branch}. Todas las existencias están por encima del límite de seguridad.`;
    }
    const list = lowStockItems.slice(0, 5).map((it) => `- ⚠️ ${it}`).join('\n');
    return `🚨 **Alerta de Stock Crítico en ${branch}**:\nTienes **${lowStockCount} productos** en nivel mínimo o por agotarse:\n${list}\n\n📦 *Acción recomendada: Genera una orden de reposición o transferencia entre sucursales.*`;
  }

  if (lower.includes('caja') || lower.includes('arqueo') || lower.includes('efectivo') || lower.includes('dinero')) {
    return `💵 **Estado de Caja Chica (${branch})**:\n- Saldo estimado en gaveta: **S/ ${cashInDrawer.toFixed(2)}**\n\n🔒 *Recuerda realizar arqueos intermedios y registrar todos los retiros para mantener un Cierre Z sin diferencias.*`;
  }

  if (lower.includes('fiado') || lower.includes('deuda') || lower.includes('cobrar') || lower.includes('credito')) {
    return `📑 **Cuentas por Cobrar (Fiados)**:\n- Saldo global pendiente de cobro: **S/ ${totalDebt.toFixed(2)}**\n\n📲 *Consejo: Puedes enviar recordatorios de pago amistosos a tus clientes frecuentes desde la sección CRM.*`;
  }

  // Respuesta general de consultor comercial
  return `🤖 **Diagnóstico Comercial Ventify (${branch})**:\n- **Ventas del día**: S/ ${todaySales.toFixed(2)} (${salesCount} transacciones)\n- **Efectivo en caja**: S/ ${cashInDrawer.toFixed(2)}\n- **Alertas de stock**: ${lowStockCount} artículos críticos\n- **Fiados pendientes**: S/ ${totalDebt.toFixed(2)}\n\n¿Deseas que analice algún producto específico o elabore una estrategia de promociones?`;
};

/**
 * Consulta el endpoint de IA de Ventify con token de usuario, o genera un análisis
 * inteligente en vivo si el dispositivo está offline o el endpoint no responde.
 */
export const askVentyAI = async (
  params: AskVentyAIParams
): Promise<string> => {
  const { prompt, contextSummary, history = [] } = params;

  try {
    const currentUser = auth.currentUser;
    const token = await currentUser?.getIdToken();

    const response = await fetch(`${APP_URL}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        messages: [
          ...history,
          {
            role: 'system',
            content: `Eres Venty, el copiloto inteligente de punto de venta Ventify. Contexto actual: ${JSON.stringify(
              contextSummary || {}
            )}`,
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await response.json();
        return json.reply || json.content || json.message || 'Respuesta generada por Venty IA.';
      }
      const text = await response.text();
      return text || generateLocalAIResponse(prompt, contextSummary);
    }
  } catch (netErr) {
    console.warn('[CRMService] Fallo conectando a API Venty IA, usando motor local:', netErr);
  }

  // Fallback inteligente en vivo
  return generateLocalAIResponse(prompt, contextSummary);
};

export default {
  getCustomers,
  saveCustomer,
  registerFiadoPayment,
  getCustomerFiadoHistory,
  getReservationsAndOrders,
  createReservationOrOrder,
  registerReservationPayment,
  completeOrCancelReservation,
  askVentyAI,
};
