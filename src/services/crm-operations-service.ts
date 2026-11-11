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
  getDocs,
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

const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://ventify.com.pe';

import type { UserProfileInfo } from './sale-service';

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

export interface ReservationOrderItem {
  productId: string;
  productName: string;
  sku?: string;
  price: number;
  quantity: number;
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
  accountId: string;
  branchId: string;
  type: 'reservation' | 'order';
  items: ReservationOrderItem[];
  total: number;
  depositAmount: number;
  remainingAmount: number;
  status: 'pending' | 'ready' | 'completed' | 'cancelled';
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
  searchTerm?: string
): Promise<Customer[]> => {
  if (!accountId) return [];

  try {
    const coll = collection(db, CUSTOMERS_COLLECTION);
    const q = query(coll, where('accountId', '==', accountId));
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

  const normalizedAmount = Math.round(amount * 100) / 100;
  // Guardar en la colección oficial `reservation_deposits` (NO usar la inexistente `fiado_payments` que arroja 403)
  const depositRef = doc(collection(db, RESERVATION_DEPOSITS_COLLECTION));
  const paymentId = depositRef.id;
  const customerRef = doc(db, CUSTOMERS_COLLECTION, customer.id);

  await runTransaction(db, async (tx) => {
    // 1. Leer saldo actual del cliente y sesión de caja antes de escribir
    const custSnap = await tx.get(customerRef);
    if (!custSnap.exists()) {
      throw new Error(`El cliente con ID ${customer.id} no existe.`);
    }

    const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
    const sessionRef = isCash && sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;
    const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;

    const cData = custSnap.data();
    const currentDebt = Number(cData.currentDebt) || 0;
    const currentCredits = Number(cData.credits) || 0;

    let newDebt = 0;
    let surplusCredit = 0;

    if (normalizedAmount >= currentDebt) {
      newDebt = 0;
      surplusCredit = Math.round((normalizedAmount - currentDebt) * 100) / 100;
    } else {
      newDebt = Math.round((currentDebt - normalizedAmount) * 100) / 100;
      surplusCredit = 0;
    }

    // 2. Actualizar cliente
    const customerUpdates: Record<string, any> = {
      currentDebt: newDebt,
      lastPaymentDate: serverTimestamp(),
      lastPaymentAmount: normalizedAmount,
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
      customerName: customer.name || cData.name,
      amount: normalizedAmount,
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

    // 5. Si el pago es en efectivo, ingresarlo a la caja chica oficial
    if (isCash && sessionId && sessionRef && sessionSnap) {
      const cashMovementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
      tx.set(cashMovementRef, {
        accountId,
        branchId,
        sessionId,
        type: 'income',
        category: 'fiado_payment',
        amount: normalizedAmount,
        description: `Abono de fiado: ${customer.name || cData.name}`,
        referenceId: paymentId,
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
        createdAt: serverTimestamp(),
      });

      // Actualizar sesión si está abierta
      if (sessionSnap.exists() && sessionSnap.data()?.status === 'open') {
        const sData = sessionSnap.data();
        tx.update(sessionRef, {
          totalIncome: Math.round(((sData.totalIncome || 0) + normalizedAmount) * 100) / 100,
          expectedAmount: Math.round(((sData.expectedAmount || 0) + normalizedAmount) * 100) / 100,
          totalReservationDeposits: Math.round(((sData.totalReservationDeposits || 0) + normalizedAmount) * 100) / 100,
          reservationDepositsCount: (sData.reservationDepositsCount || 0) + 1,
          cashReservationDeposits: Math.round(((sData.cashReservationDeposits || 0) + normalizedAmount) * 100) / 100,
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

    const history: FiadoHistoryEntry[] = snapshot.docs.map((d) => {
      const data = d.data();
      const dateVal = data.date || (data.createdAt?.seconds ? data.createdAt.seconds * 1000 : Date.now());
      return {
        id: d.id,
        date: typeof dateVal === 'number' ? dateVal : Date.now(),
        amount: Number(data.amount) || 0,
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

// ============================================================================
// 2. GESTIÓN DE PEDIDOS Y RESERVAS
// ============================================================================

/**
 * Consulta pedidos y reservas de la sucursal
 */
export const getReservationsAndOrders = async (
  accountId: string,
  branchId: string,
  type?: 'reservation' | 'order'
): Promise<ReservationOrder[]> => {
  try {
    const results: ReservationOrder[] = [];

    const fetchCol = async (colName: string, t: 'reservation' | 'order') => {
      const coll = collection(db, colName);
      const q = query(
        coll,
        where('accountId', '==', accountId),
        where('branchId', '==', branchId)
      );
      const snap = await getDocs(q);
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

  const targetColl = type === 'order' ? ORDERS_COLLECTION : RESERVATIONS_COLLECTION;
  const docRef = doc(collection(db, targetColl));
  const reservationId = docRef.id;

  const normTotal = Math.round(total * 100) / 100;
  const normDeposit = Math.round(depositAmount * 100) / 100;
  const remainingAmount = Math.max(0, Math.round((normTotal - normDeposit) * 100) / 100);
  const trimmedCustomerName = (customer?.name || 'Cliente').trim();

  await runTransaction(db, async (tx) => {
    // 0. Ejecutar TODAS las lecturas (tx.get) antes de cualquier escritura (requisito de Firestore)
    const productReads: Array<{ it: typeof items[0]; pRef: any; pSnap: any; unitsToReserve: number }> = [];
    for (const it of items) {
      const factor = it.presentationQty || it.conversionFactor || 1;
      const unitsToReserve = Math.round(it.quantity * factor * 10000) / 10000;
      const pRef = doc(db, PRODUCTS_COLLECTION, it.productId);
      const pSnap = await tx.get(pRef);
      productReads.push({ it, pRef, pSnap, unitsToReserve });
    }

    const sessionRef = normDeposit > 0 && sessionId ? doc(db, CASH_SESSIONS_COLLECTION, sessionId) : null;
    const sSnap = sessionRef ? await tx.get(sessionRef) : null;

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

    // 2. Guardar documento de reserva / pedido cumpliendo las reglas obligatorias de Firestore
    tx.set(docRef, {
      id: reservationId,
      accountId,
      branchId,
      type,
      items,
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
        if (sSnap.exists() && sSnap.data()?.status === 'open') {
          const sData = sSnap.data();
          const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
          const isCard = paymentMethod === 'tarjeta' || paymentMethod === 'card';
          const currentTotalDeposits = Number(sData.totalReservationDeposits) || 0;
          const currentDepositsCount = Number(sData.reservationDepositsCount) || 0;

          const sessionUpdates: Record<string, any> = {
            totalReservationDeposits: Math.round((currentTotalDeposits + normDeposit) * 100) / 100,
            reservationDepositsCount: currentDepositsCount + 1,
            updatedAt: serverTimestamp(),
          };

          if (isCash) {
            const currentCashDeposits = Number(sData.cashReservationDeposits) || 0;
            const currentExpected = Number(sData.expectedAmount) || 0;
            const currentIncome = Number(sData.totalIncome) || 0;

            sessionUpdates.cashReservationDeposits = Math.round((currentCashDeposits + normDeposit) * 100) / 100;
            sessionUpdates.expectedAmount = Math.round((currentExpected + normDeposit) * 100) / 100;
            sessionUpdates.totalIncome = Math.round((currentIncome + normDeposit) * 100) / 100;
          } else if (isCard) {
            const currentCardDeposits = Number(sData.cardReservationDeposits) || 0;
            sessionUpdates.cardReservationDeposits = Math.round((currentCardDeposits + normDeposit) * 100) / 100;
          } else {
            const currentDigitalDeposits = Number(sData.digitalReservationDeposits) || 0;
            sessionUpdates.digitalReservationDeposits = Math.round((currentDigitalDeposits + normDeposit) * 100) / 100;
          }

          tx.update(sessionRef, sessionUpdates);
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
      purpose: 'reservation',
      refundable: true,
      cashSessionId: sessionId || null,
      notes: notes || '',
      createdAt: serverTimestamp(),
    });

    // 3. Si hay sesión de caja activa, actualizar acumuladores oficiales
    if (sessionId && sessionRef && sSnap) {
      if (sSnap.exists() && sSnap.data()?.status === 'open') {
        const sData = sSnap.data();
        const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
        const isCard = paymentMethod === 'tarjeta' || paymentMethod === 'card';
        const currentTotalDeposits = Number(sData.totalReservationDeposits) || 0;
        const currentDepositsCount = Number(sData.reservationDepositsCount) || 0;

        const sessionUpdates: Record<string, any> = {
          totalReservationDeposits: Math.round((currentTotalDeposits + normalizedAmount) * 100) / 100,
          reservationDepositsCount: currentDepositsCount + 1,
          updatedAt: serverTimestamp(),
        };

        if (isCash) {
          const currentCashDeposits = Number(sData.cashReservationDeposits) || 0;
          const currentExpected = Number(sData.expectedAmount) || 0;
          const currentIncome = Number(sData.totalIncome) || 0;

          sessionUpdates.cashReservationDeposits = Math.round((currentCashDeposits + normalizedAmount) * 100) / 100;
          sessionUpdates.expectedAmount = Math.round((currentExpected + normalizedAmount) * 100) / 100;
          sessionUpdates.totalIncome = Math.round((currentIncome + normalizedAmount) * 100) / 100;
        } else if (isCard) {
          const currentCardDeposits = Number(sData.cardReservationDeposits) || 0;
          sessionUpdates.cardReservationDeposits = Math.round((currentCardDeposits + normalizedAmount) * 100) / 100;
        } else {
          const currentDigitalDeposits = Number(sData.digitalReservationDeposits) || 0;
          sessionUpdates.digitalReservationDeposits = Math.round((currentDigitalDeposits + normalizedAmount) * 100) / 100;
        }

        tx.update(sessionRef, sessionUpdates);
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

export interface CompletePaymentParams {
  paymentMethod: string;
  amount: number;
  sessionId?: string;
}

/**
 * Completa o cancela una reserva/pedido liberando el stock reservado (`reservedStock`)
 * y descontando el stock físico y registrando el saldo en caja si se completa.
 * 
 * Reglas estrictas:
 * - Al CANCELAR: libera únicamente `reservedStock.${branchId}` sin tocar stock físico y sin `updatedAt`.
 * - Al COMPLETAR:
 *   - Descuenta `reservedStock` y `stock` físico, recalcula `branchIds` y `lowStockBranches` sin `updatedAt`.
 *   - Crea el movimiento en `inventory_movements` con `movementType: 'reservation_complete'`,
 *     `quantityBefore`, `quantityAfter`, `quantityChanged: -units`.
 *   - Crea el registro de venta comercial en `sales`.
 */
export const completeOrCancelReservation = async (
  item: ReservationOrder,
  action: 'complete' | 'cancel',
  userProfile: UserProfileInfo,
  paymentInfo?: CompletePaymentParams
): Promise<void> => {
  const targetColl = item.type === 'order' ? ORDERS_COLLECTION : RESERVATIONS_COLLECTION;
  const docRef = doc(db, targetColl, item.id);
  const branchId = item.branchId;

  await runTransaction(db, async (tx) => {
    // 0. Ejecutar TODAS las lecturas (tx.get) antes de cualquier escritura
    const productReads: Array<{ it: typeof item.items[0]; pRef: any; pSnap: any; unitsToRelease: number }> = [];
    for (const it of item.items) {
      const factor = it.presentationQty || it.conversionFactor || 1;
      const unitsToRelease = Math.round(it.quantity * factor * 10000) / 10000;
      const pRef = doc(db, PRODUCTS_COLLECTION, it.productId);
      const pSnap = await tx.get(pRef);
      productReads.push({ it, pRef, pSnap, unitsToRelease });
    }

    const finalAmount = paymentInfo?.amount ?? 0;
    const sessionRef =
      action === 'complete' && finalAmount > 0 && paymentInfo?.sessionId
        ? doc(db, CASH_SESSIONS_COLLECTION, paymentInfo.sessionId)
        : null;
    const sSnap = sessionRef ? await tx.get(sessionRef) : null;

    // 1. Liberar stock reservado en cada producto y descontar stock físico si es entrega
    for (const { it, pRef, pSnap, unitsToRelease } of productReads) {
      if (pSnap.exists()) {
        const pData = pSnap.data();
        const currentReserved = pData.reservedStock?.[branchId] || 0;
        const newReserved = Math.max(0, Math.round((currentReserved - unitsToRelease) * 10000) / 10000);

        if (action === 'cancel') {
          // AL CANCELAR: Solo libera stock reservado, SIN tocar stock físico y SIN updatedAt
          tx.update(pRef, {
            [`reservedStock.${branchId}`]: newReserved,
          });
        } else {
          // AL COMPLETAR: Descuenta reservedStock y stock físico, recalcula branchIds y lowStockBranches SIN updatedAt
          const currentStock = pData.stock?.[branchId] || 0;
          const newStock = Math.max(0, Math.round((currentStock - unitsToRelease) * 10000) / 10000);

          const stockMap = { ...(pData.stock || {}), [branchId]: newStock };
          const reservedMap = { ...(pData.reservedStock || {}), [branchId]: newReserved };

          const lowBranches: string[] = [];
          const threshold = pData.minStock || 5;
          for (const [bId, rawPhys] of Object.entries(stockMap)) {
            const phys = Number(rawPhys) || 0;
            const res = Number((reservedMap as Record<string, any>)[bId]) || 0;
            const avail = phys - res;
            if (avail <= threshold && avail >= 0) {
              lowBranches.push(bId);
            }
          }
          const lowStockBranches = lowBranches.length > 0 ? ['__any__', ...lowBranches] : [];
          const branchIds = Object.keys(stockMap);

          tx.update(pRef, {
            [`reservedStock.${branchId}`]: newReserved,
            [`stock.${branchId}`]: newStock,
            lowStockBranches,
            branchIds,
          });

          // Registrar movimiento en el Kardex oficial (inventory_movements)
          const movementDocRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
          tx.set(movementDocRef, {
            accountId: item.accountId,
            branchId,
            productId: it.productId,
            productName: it.productName,
            productSku: it.sku || pData.sku || '',
            quantityChanged: -unitsToRelease,
            quantityBefore: currentStock,
            quantityAfter: newStock,
            quantity: unitsToRelease,
            movementType: 'reservation_complete',
            type: 'out',
            previousStock: currentStock,
            newStock,
            reason: `Entrega de ${item.type === 'order' ? 'pedido' : 'reserva'} #${item.id.slice(-6)}`,
            referenceId: item.id,
            referenceType: item.type === 'order' ? 'order' : 'reservation',
            reservationId: item.id,
            userId: userProfile.uid,
            userName: userProfile.displayName || userProfile.email || 'Usuario',
            timestamp: Date.now(),
            createdAt: serverTimestamp(),
          });
        }
      }
    }

    const newStatus = action === 'complete' ? 'completed' : 'cancelled';
    const finalMethod = paymentInfo?.paymentMethod || 'efectivo';
    let saleId: string | null = null;

    // 2. Si se completa, registrar la venta comercial oficial en `sales`
    if (action === 'complete') {
      const saleDocRef = doc(collection(db, SALES_COLLECTION));
      saleId = saleDocRef.id;

      const totalAmount = item.total || 0;
      let paymentCategory = 'cash';
      const lowerMethod = finalMethod.toLowerCase();
      if (lowerMethod.includes('tarjeta') || lowerMethod.includes('card')) paymentCategory = 'card';
      else if (['yape', 'plin', 'transferencia', 'digital'].some((d) => lowerMethod.includes(d))) paymentCategory = 'digital';
      else if (lowerMethod.includes('fiado') || lowerMethod.includes('credit')) paymentCategory = 'credit';

      tx.set(saleDocRef, {
        id: saleId,
        saleNumber: parseInt(Date.now().toString().slice(-6), 10),
        correlative: `RES-${item.id.slice(-6).toUpperCase()}`,
        documentType: 'nota_venta',
        accountId: item.accountId,
        branchId,
        userId: userProfile.uid,
        userName: userProfile.displayName || userProfile.email || 'Usuario',
        date: Date.now(),
        createdAt: serverTimestamp(),
        items: item.items.map((it) => ({
          id: it.productId,
          productId: it.productId,
          name: it.productName,
          price: it.price,
          quantity: it.quantity,
          sku: it.sku || '',
          lineTotal: Math.round(it.price * it.quantity * 100) / 100,
        })),
        subtotal: Math.round((totalAmount / 1.18) * 100) / 100,
        tax: Math.round((totalAmount - totalAmount / 1.18) * 100) / 100,
        total: Math.round(totalAmount * 100) / 100,
        paymentMethod: finalMethod,
        paymentCategory,
        status: 'completed',
        isReservationCompletion: true,
        reservationId: item.id,
        customerId: item.customer?.id || null,
        customerName: item.customer?.name || null,
        customerPhone: item.customer?.phone || null,
        sessionId: paymentInfo?.sessionId || null,
      });

      // 3. Actualizar acumuladores en sesión de caja si se completa con monto pendiente
      if (finalAmount > 0 && paymentInfo?.sessionId && sessionRef && sSnap) {
        const isCash = lowerMethod.includes('efectivo') || lowerMethod === 'cash';

        if (sSnap.exists() && sSnap.data()?.status === 'open') {
          const sData = sSnap.data();
          const sessUpdates: Record<string, any> = {
            totalSales: Math.round(((sData.totalSales || 0) + totalAmount) * 100) / 100,
            transactionCount: (sData.transactionCount || 0) + 1,
            updatedAt: serverTimestamp(),
          };

          if (isCash) {
            sessUpdates.totalIncome = Math.round(((sData.totalIncome || 0) + finalAmount) * 100) / 100;
            sessUpdates.expectedAmount = Math.round(((sData.expectedAmount || 0) + finalAmount) * 100) / 100;
            sessUpdates.cashSales = Math.round(((sData.cashSales || 0) + finalAmount) * 100) / 100;
          } else if (lowerMethod.includes('tarjeta') || lowerMethod === 'card') {
            sessUpdates.cardSales = Math.round(((sData.cardSales || 0) + finalAmount) * 100) / 100;
          } else {
            sessUpdates.digitalSales = Math.round(((sData.digitalSales || 0) + finalAmount) * 100) / 100;
          }

          tx.update(sessionRef, sessUpdates);
        }
      }
    }

    // 4. Actualizar documento de reserva / orden
    const reservationUpdates: Record<string, any> = {
      status: newStatus,
      completedOrCancelledBy: userProfile.uid,
      completedOrCancelledAt: serverTimestamp(),
      deliveredAt: action === 'complete' ? serverTimestamp() : null,
      remainingAmount: action === 'complete' ? 0 : item.remainingAmount,
      finalPaymentMethod: action === 'complete' ? finalMethod : null,
      finalPaymentAmount: action === 'complete' ? finalAmount : null,
      updatedAt: serverTimestamp(),
    };
    if (saleId) {
      reservationUpdates.saleId = saleId;
    }
    tx.update(docRef, reservationUpdates);
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
