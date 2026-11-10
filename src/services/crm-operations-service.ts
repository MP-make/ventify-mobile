/**
 * Ventify Mobile - CRM, Orders & AI Operations Service
 * 
 * Gestión integral de:
 * 1. Clientes y Cuentas Corrientes (Fiados): pagos, abonos y deudas.
 * 2. Pedidos y Reservas: apartado de stock (`reservedStock`) y depósitos en caja.
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
  getDoc,
  setDoc,
  updateDoc,
  Timestamp,
} from 'firebase/firestore';

// ============================================================================
// CONSTANTES DE COLECCIONES
// ============================================================================

const CUSTOMERS_COLLECTION = 'customers';
const FIADO_PAYMENTS_COLLECTION = 'fiado_payments';
const RESERVATIONS_COLLECTION = 'reservations';
const ORDERS_COLLECTION = 'orders';
const PRODUCTS_COLLECTION = 'products';
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
 * - Inserta el comprobante en `fiado_payments`
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
  const paymentRef = doc(collection(db, FIADO_PAYMENTS_COLLECTION));
  const paymentId = paymentRef.id;
  const customerRef = doc(db, CUSTOMERS_COLLECTION, customer.id);

  await runTransaction(db, async (tx) => {
    // 1. Leer saldo actual del cliente
    const custSnap = await tx.get(customerRef);
    if (!custSnap.exists()) {
      throw new Error(`El cliente con ID ${customer.id} no existe.`);
    }

    const cData = custSnap.data();
    const currentDebt = cData.currentDebt || 0;
    const newDebt = Math.max(0, Math.round((currentDebt - normalizedAmount) * 100) / 100);

    // 2. Actualizar cliente
    tx.update(customerRef, {
      currentDebt: newDebt,
      lastPaymentDate: serverTimestamp(),
      lastPaymentAmount: normalizedAmount,
      updatedAt: serverTimestamp(),
    });

    // 3. Registrar comprobante en fiado_payments
    tx.set(paymentRef, {
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
      notes: notes || '',
      createdBy: userProfile.uid,
      createdByName: userProfile.displayName || userProfile.email || 'Usuario',
      createdAt: serverTimestamp(),
    });

    // 4. Si el pago es en efectivo, ingresarlo a la caja chica oficial
    const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
    if (isCash && sessionId) {
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
      const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
      const sessionSnap = await tx.get(sessionRef);
      if (sessionSnap.exists() && sessionSnap.data()?.status === 'open') {
        const sData = sessionSnap.data();
        tx.update(sessionRef, {
          totalIncome: Math.round(((sData.totalIncome || 0) + normalizedAmount) * 100) / 100,
          expectedAmount: Math.round(((sData.expectedAmount || 0) + normalizedAmount) * 100) / 100,
          updatedAt: serverTimestamp(),
        });
      }
    }
  });

  return paymentId;
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
 * Crea una reserva o pedido incrementando de forma segura el stock comprometido
 * (`reservedStock.${branchId}`) en los productos para evitar sobreventas.
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

  const remainingAmount = Math.max(0, Math.round((total - depositAmount) * 100) / 100);

  await runTransaction(db, async (tx) => {
    // 1. Apartar stock reservado en cada producto
    for (const it of items) {
      const factor = it.presentationQty || it.conversionFactor || 1;
      const unitsToReserve = Math.round(it.quantity * factor * 10000) / 10000;

      const pRef = doc(db, PRODUCTS_COLLECTION, it.productId);
      const pSnap = await tx.get(pRef);

      if (pSnap.exists()) {
        const pData = pSnap.data();
        const currentReserved = pData.reservedStock?.[branchId] || 0;
        const newReserved = Math.round((currentReserved + unitsToReserve) * 10000) / 10000;

        tx.update(pRef, {
          [`reservedStock.${branchId}`]: newReserved,
          updatedAt: serverTimestamp(),
        });
      }
    }

    // 2. Guardar documento de reserva / pedido
    tx.set(docRef, {
      id: reservationId,
      accountId,
      branchId,
      type,
      items,
      total: Math.round(total * 100) / 100,
      depositAmount: Math.round(depositAmount * 100) / 100,
      remainingAmount,
      status: 'pending',
      customer,
      pickupDate: pickupDate || null,
      notes: notes || '',
      createdBy: userProfile.uid,
      createdByName: userProfile.displayName || userProfile.email || 'Usuario',
      createdAt: serverTimestamp(),
    });

    // 3. Si se pagó adelanto en efectivo, sumarlo a la caja chica
    const isCash = paymentMethod === 'efectivo' || paymentMethod === 'cash';
    if (depositAmount > 0 && isCash && sessionId) {
      const mvRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
      tx.set(mvRef, {
        accountId,
        branchId,
        sessionId,
        type: 'income',
        category: 'deposit',
        amount: Math.round(depositAmount * 100) / 100,
        description: `Adelanto ${type === 'order' ? 'Pedido' : 'Reserva'} #${reservationId.slice(-6)}: ${customer.name}`,
        referenceId: reservationId,
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
        createdAt: serverTimestamp(),
      });

      const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
      const sSnap = await tx.get(sessionRef);
      if (sSnap.exists() && sSnap.data()?.status === 'open') {
        const sData = sSnap.data();
        tx.update(sessionRef, {
          totalIncome: Math.round(((sData.totalIncome || 0) + depositAmount) * 100) / 100,
          expectedAmount: Math.round(((sData.expectedAmount || 0) + depositAmount) * 100) / 100,
          updatedAt: serverTimestamp(),
        });
      }
    }
  });

  return reservationId;
};

/**
 * Completa o cancela una reserva/pedido liberando el stock reservado (`reservedStock`)
 */
export const completeOrCancelReservation = async (
  item: ReservationOrder,
  action: 'complete' | 'cancel',
  userProfile: UserProfileInfo
): Promise<void> => {
  const targetColl = item.type === 'order' ? ORDERS_COLLECTION : RESERVATIONS_COLLECTION;
  const docRef = doc(db, targetColl, item.id);
  const branchId = item.branchId;

  await runTransaction(db, async (tx) => {
    // 1. Liberar stock reservado en cada producto
    for (const it of item.items) {
      const factor = it.presentationQty || it.conversionFactor || 1;
      const unitsToRelease = Math.round(it.quantity * factor * 10000) / 10000;

      const pRef = doc(db, PRODUCTS_COLLECTION, it.productId);
      const pSnap = await tx.get(pRef);

      if (pSnap.exists()) {
        const pData = pSnap.data();
        const currentReserved = pData.reservedStock?.[branchId] || 0;
        const newReserved = Math.max(0, Math.round((currentReserved - unitsToRelease) * 10000) / 10000);

        tx.update(pRef, {
          [`reservedStock.${branchId}`]: newReserved,
          updatedAt: serverTimestamp(),
        });
      }
    }

    // 2. Actualizar estado
    const newStatus = action === 'complete' ? 'completed' : 'cancelled';
    tx.update(docRef, {
      status: newStatus,
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
