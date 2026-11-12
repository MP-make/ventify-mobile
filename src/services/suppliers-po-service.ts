/**
 * Ventify Mobile - Suppliers & Purchase Orders Service
 * 
 * Gestión integral de Proveedores (`suppliers`), Órdenes de Compra (`purchase_orders`),
 * y Recepción Atómica en Almacén con Costo Promedio Ponderado (CPP) y registro en el Kardex oficial.
 */

import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Timestamp,
  getCountFromServer,
  DocumentData,
  QueryDocumentSnapshot,
} from 'firebase/firestore';
import { cleanFirestoreData } from '@/lib/firebase-utils';

// ============================================================================
// CONSTANTES & COLECCIONES
// ============================================================================

export const SUPPLIERS_COLLECTION = 'suppliers';
export const PURCHASE_ORDERS_COLLECTION = 'purchase_orders';
export const PRODUCTS_COLLECTION = 'products';
export const INVENTORY_MOVEMENTS_COLLECTION = 'inventory_movements';

export const DEFAULT_MIN_STOCK_THRESHOLD = 5;
export const LOW_STOCK_THRESHOLD = DEFAULT_MIN_STOCK_THRESHOLD;
export const LOW_STOCK_ANY = '__any__';

// ============================================================================
// TIPOS E INTERFACES
// ============================================================================

export interface Supplier {
  id: string;
  accountId: string;
  name: string;           // Razón social o Nombre comercial
  taxId: string;          // RUC (11 dígitos) o DNI (8 dígitos)
  contactName?: string;   // Persona o representante de contacto
  phone?: string;         // Teléfono / Celular
  email?: string;         // Correo de ventas / cobranza
  address?: string;       // Dirección fiscal o almacén
  category?: string;      // Distribuidor, Fabricante, Mayorista, Importador, etc.
  notes?: string;         // Términos, cuenta bancaria, observaciones
  paymentTerms?: string;  // Contado, Crédito 15 días, Crédito 30 días
  active: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export interface PurchaseOrderItem {
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
  unitCost: number;
  subtotal: number;
  packagingLabel?: string;
  packagingFactor?: number;
  receivedQuantity?: number;
}

export type PurchaseOrderStatus = 'draft' | 'pending' | 'ordered' | 'received' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  accountId: string;
  branchId?: string;
  branchName?: string;
  orderNumber: string;    // Ej: PO-0001
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  items: PurchaseOrderItem[];
  subtotal: number;
  tax?: number;
  totalCost: number;
  expectedDate?: any;     // Fecha estimada de entrega
  receivedDate?: any;
  receivedAt?: any;
  receivedBy?: string;
  receivedByName?: string;
  notes?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface CreatePurchaseOrderParams {
  accountId: string;
  supplierId: string;
  supplierName: string;
  items: PurchaseOrderItem[];
  branchId?: string;
  branchName?: string;
  status?: 'pending' | 'ordered' | 'draft';
  expectedDate?: Date | string | null;
  notes?: string;
  tax?: number;
  userProfile?: {
    uid?: string;
    displayName?: string | null;
    email?: string | null;
  } | null;
}

export interface ReceivedProductCostChange {
  productId: string;
  productName: string;
  previousCost: number;
  newCost: number;
  suggestedPrice?: number;
  minSalePrice?: number;
}

export interface ReceivePurchaseOrderResult {
  success: boolean;
  orderId: string;
  itemsProcessed: number;
  costChanges: ReceivedProductCostChange[];
}

export interface UserProfileInfo {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  role?: string;
}

// ============================================================================
// HELPERS MATEMÁTICOS & DE INVENTARIO
// ============================================================================

/**
 * Calcula el redondeo preciso a 2 decimales (céntimos de Sol)
 */
export const roundToCents = (value: number): number => {
  const n = Number(value) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/**
 * Recalcula el Costo Promedio Ponderado (CPP) según estándares contables.
 * Si no había stock previo o costo previo, el nuevo lote entrante fija el costo base.
 */
export const calculateWeightedAverageCost = (
  currentStock: number,
  currentCost: number,
  incomingQty: number,
  incomingUnitCost: number
): number => {
  const stock = Number(currentStock) || 0;
  const cost = Number(currentCost) || 0;
  const qty = Number(incomingQty) || 0;
  const unit = Number(incomingUnitCost) || 0;

  if (qty <= 0) return roundToCents(cost);

  if (stock > 0 && cost > 0) {
    const totalOld = stock * cost;
    const totalNew = qty * unit;
    return roundToCents((totalOld + totalNew) / (stock + qty));
  }

  return roundToCents(unit);
};

/**
 * Recalcula la lista de sucursales con stock en umbral de alerta
 * Excluye stock negativo y coloca LOW_STOCK_ANY ('__any__') al inicio.
 */
export const calculateLowStockBranches = (
  stockMap: Record<string, number> = {},
  reservedMap: Record<string, number> = {},
  threshold: number = LOW_STOCK_THRESHOLD
): string[] => {
  const branches = Object.keys(stockMap || {}).filter((branchId) => {
    const reserved = reservedMap?.[branchId] || 0;
    const available = (stockMap?.[branchId] || 0) - reserved;
    return available <= threshold && available >= 0;
  });

  return branches.length > 0 ? [LOW_STOCK_ANY, ...branches] : [];
};

export const deriveLowStockBranches = calculateLowStockBranches;

/**
 * Deriva el array denormalizado branchIds para búsquedas rápidas con array-contains
 */
export const deriveBranchIds = (
  stockMap: Record<string, number> = {},
  fallback: string[] = ['main']
): string[] => {
  const ids = Object.keys(stockMap || {});
  return ids.length > 0 ? ids : fallback;
};

// ============================================================================
// MAPEOS DE DOCUMENTOS FIRESTORE
// ============================================================================

export const supplierFromDoc = (docSnap: QueryDocumentSnapshot<DocumentData>): Supplier => {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    accountId: data.accountId || '',
    name: data.name || '',
    taxId: data.taxId || '',
    contactName: data.contactName || '',
    phone: data.phone || '',
    email: data.email || '',
    address: data.address || '',
    category: data.category || 'General',
    notes: data.notes || '',
    paymentTerms: data.paymentTerms || 'Contado',
    active: data.active !== false,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : data.createdAt,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : data.updatedAt,
  };
};

export const purchaseOrderFromDoc = (docSnap: QueryDocumentSnapshot<DocumentData>): PurchaseOrder => {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    accountId: data.accountId || '',
    branchId: data.branchId || 'main',
    branchName: data.branchName || 'Principal',
    orderNumber: data.orderNumber || docSnap.id.substring(0, 8).toUpperCase(),
    supplierId: data.supplierId || '',
    supplierName: data.supplierName || 'Proveedor',
    status: (data.status as PurchaseOrderStatus) || 'pending',
    items: Array.isArray(data.items) ? data.items : [],
    subtotal: Number(data.subtotal) || 0,
    tax: Number(data.tax) || 0,
    totalCost: Number(data.totalCost) || Number(data.subtotal) || 0,
    expectedDate: data.expectedDate instanceof Timestamp ? data.expectedDate.toDate() : data.expectedDate,
    receivedDate: data.receivedDate instanceof Timestamp ? data.receivedDate.toDate() : data.receivedDate,
    receivedAt: data.receivedAt instanceof Timestamp ? data.receivedAt.toDate() : data.receivedAt,
    receivedBy: data.receivedBy,
    receivedByName: data.receivedByName,
    notes: data.notes || '',
    createdBy: data.createdBy,
    createdByName: data.createdByName,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : data.createdAt,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : data.updatedAt,
  };
};

// ============================================================================
// 1. GESTIÓN DE PROVEEDORES (suppliers collection)
// ============================================================================

/**
 * Consulta asíncrona de proveedores de la cuenta
 */
export const getSuppliersAsync = async (
  accountId: string,
  onlyActive: boolean = true
): Promise<Supplier[]> => {
  if (!accountId) return [];

  try {
    const suppliersColl = collection(db, SUPPLIERS_COLLECTION);
    const constraints: any[] = [where('accountId', '==', accountId)];

    if (onlyActive) {
      constraints.push(where('active', '==', true));
    }

    const q = query(suppliersColl, ...constraints);
    const snap = await getDocs(q);

    const list = snap.docs.map(supplierFromDoc);
    list.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    return list;
  } catch (err: any) {
    console.error('[suppliers-po-service] Error en getSuppliersAsync:', err?.message || err);
    return [];
  }
};

/**
 * Suscripción en tiempo real a los proveedores de la cuenta
 */
export const subscribeSuppliers = (
  accountId: string,
  callback: (suppliers: Supplier[]) => void,
  onlyActive: boolean = true
): (() => void) => {
  if (!accountId) {
    callback([]);
    return () => {};
  }

  const suppliersColl = collection(db, SUPPLIERS_COLLECTION);
  const constraints: any[] = [where('accountId', '==', accountId)];

  if (onlyActive) {
    constraints.push(where('active', '==', true));
  }

  const q = query(suppliersColl, ...constraints);

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs.map(supplierFromDoc);
      list.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
      callback(list);
    },
    (err) => {
      console.warn('[suppliers-po-service] Error en suscripción a proveedores:', err);
      callback([]);
    }
  );

  return unsubscribe;
};

/**
 * Obtiene los proveedores de la cuenta.
 * Soporta sobrecarga:
 * - `getSuppliers(accountId)`: retorna Promise<Supplier[]>
 * - `getSuppliers(accountId, callback)`: suscribe y retorna función de desuscripción
 */
export function getSuppliers(
  accountId: string,
  callbackOrOnlyActive?: ((suppliers: Supplier[]) => void) | boolean,
  onlyActive: boolean = true
): any {
  if (typeof callbackOrOnlyActive === 'function') {
    return subscribeSuppliers(accountId, callbackOrOnlyActive, onlyActive);
  }
  const activeFlag = typeof callbackOrOnlyActive === 'boolean' ? callbackOrOnlyActive : onlyActive;
  return getSuppliersAsync(accountId, activeFlag);
}

/**
 * Guarda o actualiza un proveedor en Firestore
 */
export const saveSupplier = async (
  supplierData: Partial<Supplier> & { accountId: string; name: string }
): Promise<string> => {
  if (!supplierData.accountId) {
    throw new Error('El identificador de cuenta (accountId) es obligatorio.');
  }

  if (!supplierData.name || !supplierData.name.trim()) {
    throw new Error('La razón social o nombre del proveedor es obligatorio.');
  }

  const cleanName = supplierData.name.trim();
  const cleanTaxId = (supplierData.taxId || '').trim();
  const cleanPhone = (supplierData.phone || '').trim();
  const cleanEmail = (supplierData.email || '').trim().toLowerCase();
  const cleanAddress = (supplierData.address || '').trim();
  const cleanCategory = (supplierData.category || 'General').trim();
  const cleanNotes = (supplierData.notes || '').trim();
  const cleanPaymentTerms = (supplierData.paymentTerms || 'Contado').trim();
  const cleanContactName = (supplierData.contactName || '').trim();

  const payload: any = {
    accountId: supplierData.accountId,
    name: cleanName,
    taxId: cleanTaxId,
    contactName: cleanContactName,
    phone: cleanPhone,
    email: cleanEmail,
    address: cleanAddress,
    category: cleanCategory,
    notes: cleanNotes,
    paymentTerms: cleanPaymentTerms,
    active: supplierData.active !== false,
    updatedAt: serverTimestamp(),
  };

  if (supplierData.id) {
    // Actualización
    const docRef = doc(db, SUPPLIERS_COLLECTION, supplierData.id);
    await updateDoc(docRef, payload);
    return supplierData.id;
  } else {
    // Creación
    const coll = collection(db, SUPPLIERS_COLLECTION);
    payload.createdAt = serverTimestamp();
    const docRef = await addDoc(coll, payload);
    return docRef.id;
  }
};

/**
 * Desactiva (soft-delete) o elimina un proveedor
 */
export const deleteSupplier = async (
  supplierId: string,
  hardDelete: boolean = false
): Promise<void> => {
  if (!supplierId) {
    throw new Error('ID de proveedor requerido.');
  }

  const supplierRef = doc(db, SUPPLIERS_COLLECTION, supplierId);

  if (hardDelete) {
    const { deleteDoc } = await import('firebase/firestore');
    await deleteDoc(supplierRef);
  } else {
    await updateDoc(supplierRef, {
      active: false,
      updatedAt: serverTimestamp(),
    });
  }
};

// ============================================================================
// 2. GESTIÓN DE ÓRDENES DE COMPRA (purchase_orders collection)
// ============================================================================

/**
 * Genera el siguiente código correlativo de orden de compra (PO-0001, PO-0002...)
 */
export const generateNextOrderNumber = async (accountId: string): Promise<string> => {
  try {
    const coll = collection(db, PURCHASE_ORDERS_COLLECTION);
    const q = query(coll, where('accountId', '==', accountId));
    const snapshot = await getCountFromServer(q);
    const nextNum = (snapshot.data().count || 0) + 1;
    return `PO-${String(nextNum).padStart(4, '0')}`;
  } catch (err) {
    // Fallback con timestamp seguro
    const suffix = Date.now().toString().slice(-4);
    return `PO-${suffix}`;
  }
};

/**
 * Consulta asíncrona de órdenes de compra
 */
export const getPurchaseOrdersAsync = async (
  accountId: string,
  branchId?: string,
  statusFilter?: string
): Promise<PurchaseOrder[]> => {
  if (!accountId) return [];

  try {
    const coll = collection(db, PURCHASE_ORDERS_COLLECTION);
    const constraints: any[] = [where('accountId', '==', accountId)];

    if (statusFilter && statusFilter !== 'all') {
      constraints.push(where('status', '==', statusFilter));
    }

    constraints.push(orderBy('createdAt', 'desc'));
    constraints.push(firestoreLimit(200));

    const q = query(coll, ...constraints);
    const snap = await getDocs(q);

    let orders = snap.docs.map(purchaseOrderFromDoc);

    if (branchId && branchId !== 'all') {
      orders = orders.filter((o) => !o.branchId || o.branchId === branchId);
    }

    return orders;
  } catch (err: any) {
    console.warn('[suppliers-po-service] Error con orderBy en purchase_orders, usando fallback:', err?.message);
    try {
      const coll = collection(db, PURCHASE_ORDERS_COLLECTION);
      const q = query(coll, where('accountId', '==', accountId), firestoreLimit(200));
      const snap = await getDocs(q);
      let orders = snap.docs.map(purchaseOrderFromDoc);

      if (statusFilter && statusFilter !== 'all') {
        orders = orders.filter((o) => o.status === statusFilter);
      }
      if (branchId && branchId !== 'all') {
        orders = orders.filter((o) => !o.branchId || o.branchId === branchId);
      }

      orders.sort((a, b) => {
        const tA = a.createdAt instanceof Date ? a.createdAt.getTime() : Number(a.createdAt) || 0;
        const tB = b.createdAt instanceof Date ? b.createdAt.getTime() : Number(b.createdAt) || 0;
        return tB - tA;
      });

      return orders;
    } catch (fallbackErr) {
      console.error('[suppliers-po-service] Fallback getPurchaseOrders falló:', fallbackErr);
      return [];
    }
  }
};

/**
 * Suscripción en tiempo real a órdenes de compra
 */
export const subscribePurchaseOrders = (
  accountId: string,
  callback: (orders: PurchaseOrder[]) => void,
  branchId?: string,
  statusFilter?: string
): (() => void) => {
  if (!accountId) {
    callback([]);
    return () => {};
  }

  const coll = collection(db, PURCHASE_ORDERS_COLLECTION);
  const constraints: any[] = [where('accountId', '==', accountId)];

  if (statusFilter && statusFilter !== 'all') {
    constraints.push(where('status', '==', statusFilter));
  }

  const q = query(coll, ...constraints, firestoreLimit(200));

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      let orders = snapshot.docs.map(purchaseOrderFromDoc);

      if (branchId && branchId !== 'all') {
        orders = orders.filter((o) => !o.branchId || o.branchId === branchId);
      }

      orders.sort((a, b) => {
        const tA = a.createdAt instanceof Date ? a.createdAt.getTime() : Number(a.createdAt) || 0;
        const tB = b.createdAt instanceof Date ? b.createdAt.getTime() : Number(b.createdAt) || 0;
        return tB - tA;
      });

      callback(orders);
    },
    (err) => {
      console.warn('[suppliers-po-service] Error en suscripción a purchase_orders:', err);
      callback([]);
    }
  );

  return unsubscribe;
};

/**
 * Obtiene la lista de órdenes de compra.
 * Admite tanto llamada `await getPurchaseOrders(accountId, branchId)` como suscripción.
 */
export function getPurchaseOrders(
  accountId: string,
  branchIdOrCallback?: string | ((orders: PurchaseOrder[]) => void),
  branchId?: string
): any {
  if (typeof branchIdOrCallback === 'function') {
    return subscribePurchaseOrders(accountId, branchIdOrCallback, branchId);
  }
  return getPurchaseOrdersAsync(accountId, branchIdOrCallback);
}

/**
 * Crea una nueva orden de compra
 */
export const createPurchaseOrder = async (
  params: CreatePurchaseOrderParams
): Promise<string> => {
  const {
    accountId,
    supplierId,
    supplierName,
    items,
    branchId,
    branchName,
    status = 'pending',
    expectedDate,
    notes,
    tax = 0,
    userProfile,
  } = params;

  if (!accountId) {
    throw new Error('El accountId es requerido para crear la orden de compra.');
  }

  if (!supplierId || !supplierName) {
    throw new Error('Debe seleccionar un proveedor para la orden.');
  }

  if (!items || items.length === 0) {
    throw new Error('La orden de compra debe contener al menos un producto.');
  }

  // Normalizar ítems y calcular subtotales exactos
  const normalizedItems: PurchaseOrderItem[] = items.map((item) => {
    const qty = Number(item.quantity) || 1;
    const unit = roundToCents(Number(item.unitCost) || 0);
    const sub = roundToCents(qty * unit);

    return {
      productId: item.productId,
      productName: item.productName || 'Producto',
      sku: item.sku || '',
      quantity: qty,
      unitCost: unit,
      subtotal: sub,
      packagingLabel: item.packagingLabel,
      packagingFactor: item.packagingFactor,
    };
  });

  const subtotal = roundToCents(
    normalizedItems.reduce((acc, it) => acc + it.subtotal, 0)
  );
  const taxAmount = roundToCents(Number(tax) || 0);
  const totalCost = roundToCents(subtotal + taxAmount);

  const orderNumber = await generateNextOrderNumber(accountId);

  const docData: any = {
    accountId,
    ...(branchId ? { branchId } : {}),
    ...(branchName ? { branchName } : {}),
    supplierId,
    supplierName,
    orderNumber,
    status,
    items: normalizedItems,
    subtotal,
    tax: taxAmount,
    totalCost,
    notes: notes || '',
    expectedDate: expectedDate ? (expectedDate instanceof Date ? Timestamp.fromDate(expectedDate) : expectedDate) : null,
    createdBy: userProfile?.uid || 'system',
    createdByName: userProfile?.displayName || userProfile?.email || 'Usuario',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const coll = collection(db, PURCHASE_ORDERS_COLLECTION);
  const docRef = await addDoc(coll, docData);
  return docRef.id;
};

/**
 * Cancela una orden de compra pendiente
 */
export const cancelPurchaseOrder = async (
  orderId: string,
  userProfile?: UserProfileInfo | null,
  reason?: string
): Promise<void> => {
  if (!orderId) throw new Error('ID de orden requerido.');

  const orderRef = doc(db, PURCHASE_ORDERS_COLLECTION, orderId);
  const snap = await getDoc(orderRef);

  if (!snap.exists()) {
    throw new Error('Orden de compra no encontrada.');
  }

  const data = snap.data();
  if (data.status === 'received') {
    throw new Error('No se puede cancelar una orden que ya fue recibida en almacén.');
  }

  await updateDoc(orderRef, {
    status: 'cancelled',
    cancellationReason: reason || 'Cancelada por el usuario',
    cancelledBy: userProfile?.uid || 'system',
    cancelledByName: userProfile?.displayName || userProfile?.email || 'Usuario',
    cancelledAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
};

/**
 * Actualiza el estado simple de una orden
 */
export const updatePurchaseOrderStatus = async (
  orderId: string,
  status: PurchaseOrderStatus
): Promise<void> => {
  const orderRef = doc(db, PURCHASE_ORDERS_COLLECTION, orderId);
  await updateDoc(orderRef, {
    status,
    updatedAt: serverTimestamp(),
  });
};

// ============================================================================
// 3. RECEPCIÓN ATÓMICA DE MERCADERÍA EN ALMACÉN (runTransaction)
// ============================================================================

/**
 * Recibe una orden de compra en el almacén de forma 100% atómica:
 * 1. Verifica que la orden exista y no haya sido recibida antes.
 * 2. Lee todos los productos involucrados en `products/{productId}`.
 * 3. Por cada producto:
 *    - Suma la cantidad física al stock de la sucursal (`stock.${branchId}`).
 *    - Recalcula el Costo Promedio Ponderado (`costPrice`) de todo el inventario.
 *    - Actualiza `lowStockBranches` y `branchIds`.
 *    - Si el costo supera el precio mínimo de venta, eleva `minSalePrice` para salvaguardar márgenes.
 *    - Registra el movimiento de entrada en el Kardex oficial (`inventory_movements`)
 *      con `type: 'in'`, `reason: 'purchase_order'`, `referenceId: order.id`.
 * 4. Actualiza la orden a `status: 'received'`, `receivedAt`, `receivedBy`.
 */
export const receivePurchaseOrder = async (
  orderOrId: PurchaseOrder | string,
  userProfile?: UserProfileInfo | null,
  branchIdOverride?: string,
  branchNameOverride?: string
): Promise<ReceivePurchaseOrderResult> => {
  const orderId = typeof orderOrId === 'string' ? orderOrId : orderOrId.id;

  if (!orderId) {
    throw new Error('Identificador de la orden de compra requerido.');
  }

  const costChanges: ReceivedProductCostChange[] = [];

  await runTransaction(db, async (tx) => {
    // Limpiar acumulador ante posibles reintentos de Firestore
    costChanges.length = 0;

    // ----------------------------------------------------------------------
    // FASE 1: TODAS LAS LECTURAS (Lecturas obligatoriamente previas a escrituras)
    // ----------------------------------------------------------------------
    const orderRef = doc(db, PURCHASE_ORDERS_COLLECTION, orderId);
    const orderSnap = await tx.get(orderRef);

    if (!orderSnap.exists()) {
      throw new Error(`La orden de compra "${orderId}" no fue encontrada.`);
    }

    const orderData = orderSnap.data();

    if (orderData.status === 'received') {
      throw new Error('Esta orden de compra ya fue recibida previamente en almacén.');
    }

    if (orderData.status === 'cancelled') {
      throw new Error('No es posible recibir una orden que ha sido cancelada.');
    }

    const effectiveBranchId = branchIdOverride || orderData.branchId;
    if (!effectiveBranchId || effectiveBranchId === 'all') {
      throw new Error('Selecciona una sucursal antes de recibir la orden.');
    }
    const effectiveBranchName = branchNameOverride ||
      (effectiveBranchId === orderData.branchId ? orderData.branchName : undefined) ||
      effectiveBranchId;
    const items: PurchaseOrderItem[] = Array.isArray(orderData.items) ? orderData.items : [];

    if (items.length === 0) {
      throw new Error('La orden de compra no contiene productos para ingresar a stock.');
    }

    // Leer en bloque todos los documentos de productos
    const productReads: Array<{
      ref: ReturnType<typeof doc>;
      snap: Awaited<ReturnType<typeof tx.get>>;
      item: PurchaseOrderItem;
    }> = [];

    for (const item of items) {
      if (!item.productId) continue;
      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);
      productReads.push({ ref: pRef, snap: pSnap, item });
    }

    // ----------------------------------------------------------------------
    // FASE 2: TODAS LAS ESCRITURAS (Updates de productos, Kardex y orden)
    // ----------------------------------------------------------------------
    for (const { ref: pRef, snap: pSnap, item } of productReads) {
      if (!pSnap.exists()) {
        console.warn(`[receivePurchaseOrder] Producto ID ${item.productId} no existe, omitiendo.`);
        continue;
      }

      const pData = pSnap.data() as Record<string, any>;
      const currentStockMap = { ...(pData.stock || {}) };
      const currentBranchStock = Number(currentStockMap[effectiveBranchId]) || 0;
      const currentCostPrice = Number(pData.costPrice) || 0;

      // Calcular stock total actual de todas las sucursales para el CPP
      const totalCurrentStock = Object.values(currentStockMap).reduce(
        (sum: number, q: any) => sum + (Number(q) || 0),
        0
      );

      const incomingQty = Number(item.quantity) || 0;
      const incomingUnitCost = roundToCents(Number(item.unitCost) || 0);

      // 1. Recalcular Costo Promedio Ponderado
      const newCostPrice = calculateWeightedAverageCost(
        totalCurrentStock,
        currentCostPrice,
        incomingQty,
        incomingUnitCost
      );

      // 2. Nuevo stock en la sucursal de destino
      const newBranchStock = roundToCents(currentBranchStock + incomingQty);
      currentStockMap[effectiveBranchId] = newBranchStock;

      const lowStockBranches = calculateLowStockBranches(
        currentStockMap,
        pData.reservedStock || {},
        pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
      );

      const branchIds = Object.keys(currentStockMap);

      const productUpdate: Record<string, any> = {
        [`stock.${effectiveBranchId}`]: newBranchStock,
        costPrice: newCostPrice,
        branchIds,
        lowStockBranches,
        updatedAt: serverTimestamp(),
      };

      // Si el precio mínimo de venta quedó por debajo del nuevo costo, lo ajustamos al costo
      const currentMinSale = Number(pData.minSalePrice ?? 0);
      if (currentMinSale < newCostPrice) {
        productUpdate.minSalePrice = newCostPrice;
      }

      // Si la sucursal tiene un override explícito de costPrice en branchPrices, actualizarlo
      if (pData.branchPrices?.[effectiveBranchId]?.costPrice !== undefined) {
        productUpdate[`branchPrices.${effectiveBranchId}.costPrice`] = newCostPrice;
      }

      // Si packagingFactor > 1, auto-crear la presentación en productUpdate.presentations si no existía activa con quantity === factor
      const factor = Number(item.packagingFactor) || 1;
      if (factor > 1) {
        const presentations: any[] = Array.isArray(pData.presentations)
          ? pData.presentations
          : [];
        const exists = presentations.some((p: any) => p.active !== false && Number(p.quantity) === factor);
        if (!exists) {
          const unitPrice = Number(pData.suggestedPrice ?? pData.price ?? 0);
          productUpdate.presentations = [
            ...presentations,
            {
              id: `pres-x${factor}`,
              name: item.packagingLabel || `Caja x${factor}`,
              quantity: factor,
              price: unitPrice > 0 ? roundToCents(unitPrice * factor) : 0,
              active: true,
            },
          ];
        }
      }

      tx.update(pRef, productUpdate);

      // 3. Registrar movimiento en el Kardex oficial (inventory_movements)
      if (incomingQty > 0) {
        const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        const effectiveOrderNumber = orderData.orderNumber || orderId;

        tx.set(movementRef, cleanFirestoreData({
          accountId: orderData.accountId,
          branchId: effectiveBranchId,
          branchName: effectiveBranchName,
          productId: item.productId,
          productName: item.productName || pData.name || 'Producto',
          productSku: item.sku || pData.sku || item.productId || '',
          // Campos canónicos Web
          movementType: 'add',
          quantityBefore: currentBranchStock,
          quantityAfter: newBranchStock,
          quantityChanged: incomingQty,
          referenceNumber: effectiveOrderNumber,
          userId: userProfile?.uid || 'system',
          userName: userProfile?.displayName || userProfile?.email || 'Usuario',
          userRole: userProfile?.role || 'user',
          // Campos alias Mobile
          type: 'in',
          previousStock: currentBranchStock,
          newStock: newBranchStock,
          quantity: incomingQty,
          reason: 'purchase_order',
          unitCost: incomingUnitCost,
          referenceId: orderId,
          notes: `Recepción de Orden de Compra ${effectiveOrderNumber}`,
          createdAt: serverTimestamp(),
          date: Date.now(),
        }));
      }

      // Guardar cambio de costo para reportar a la UI
      if (currentCostPrice !== newCostPrice) {
        costChanges.push({
          productId: item.productId,
          productName: item.productName || pData.name || '',
          previousCost: currentCostPrice,
          newCost: newCostPrice,
          suggestedPrice: Number(pData.suggestedPrice ?? pData.price ?? 0),
          minSalePrice: Number(productUpdate.minSalePrice ?? pData.minSalePrice ?? 0),
        });
      }
    }

    // 4. Marcar la Orden de Compra como RECIBIDA
    tx.update(orderRef, {
      status: 'received',
      receivedAt: serverTimestamp(),
      receivedDate: serverTimestamp(),
      receivedBy: userProfile?.uid || 'system',
      receivedByName: userProfile?.displayName || userProfile?.email || 'Usuario',
      branchId: effectiveBranchId,
      branchName: effectiveBranchName,
      updatedAt: serverTimestamp(),
    });
  });

  return {
    success: true,
    orderId,
    itemsProcessed: costChanges.length,
    costChanges,
  };
};

// ============================================================================
// 4. ESTADÍSTICAS & RESÚMENES
// ============================================================================

export interface PurchaseOrderStats {
  pendingCount: number;
  receivedCount: number;
  cancelledCount: number;
  totalOrders: number;
  totalInvested: number;  // Suma de órdenes recibidas
  totalPendingAmount: number; // Suma comprometida en órdenes pendientes
}

export const calculatePurchaseOrderStats = (orders: PurchaseOrder[]): PurchaseOrderStats => {
  let pendingCount = 0;
  let receivedCount = 0;
  let cancelledCount = 0;
  let totalInvested = 0;
  let totalPendingAmount = 0;

  for (const o of orders) {
    if (o.status === 'received') {
      receivedCount++;
      totalInvested += Number(o.totalCost) || 0;
    } else if (o.status === 'pending' || o.status === 'ordered') {
      pendingCount++;
      totalPendingAmount += Number(o.totalCost) || 0;
    } else if (o.status === 'cancelled') {
      cancelledCount++;
    }
  }

  return {
    pendingCount,
    receivedCount,
    cancelledCount,
    totalOrders: orders.length,
    totalInvested: roundToCents(totalInvested),
    totalPendingAmount: roundToCents(totalPendingAmount),
  };
};

// ============================================================================
// EXPORT DEFAULT COMO SERVICIO UNIFICADO
// ============================================================================

export const SuppliersPOService = {
  getSuppliers,
  getSuppliersAsync,
  subscribeSuppliers,
  saveSupplier,
  deleteSupplier,
  getPurchaseOrders,
  getPurchaseOrdersAsync,
  subscribePurchaseOrders,
  createPurchaseOrder,
  cancelPurchaseOrder,
  updatePurchaseOrderStatus,
  receivePurchaseOrder,
  calculateWeightedAverageCost,
  calculatePurchaseOrderStats,
  generateNextOrderNumber,
};

export default SuppliersPOService;
