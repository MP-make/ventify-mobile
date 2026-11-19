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
  packagingId?: string;
  packagingLabel?: string;
  packagingFactor?: number;
  packagingTotalCost?: number;
  receivedQuantity?: number;
}

export type PurchaseOrderStatus = 'draft' | 'pending' | 'ordered' | 'partial' | 'received' | 'cancelled';

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
  partialReceivedAt?: any;
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

export interface ReceivedProductCostChangePresentation {
  id: string;
  name: string;
  quantity?: number;
  conversionFactor?: number;
  price: number;
  minSalePrice?: number;
  barcode?: string;
  active?: boolean;
}

export interface ReceivedProductCostChange {
  productId: string;
  productName: string;
  previousCost: number;
  newCost: number;
  suggestedPrice?: number;
  minSalePrice?: number;
  presentations?: ReceivedProductCostChangePresentation[];
}

export interface ReceivePurchaseOrderOptions {
  partialItems?: Array<{ productId: string; receivedQty: number }>;
}

export interface ReceivePurchaseOrderResult {
  success: boolean;
  orderId: string;
  status?: PurchaseOrderStatus;
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
 * Normaliza el factor de empaque mayorista: valores < 1 o no finitos caen a 1.
 */
export const resolvePackagingFactor = (packagingFactor?: number | null): number => {
  const raw = Number(packagingFactor);
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
};

/**
 * Convierte una recepción (posiblemente en bultos/cajas) a unidades base y costo unitario real.
 * - Formato móvil/directo: `quantity` representa bultos y `unitCost` el costo por bulto.
 * - Formato Web pre-convertido (`packagingTotalCost` definido): `quantity` ya está en unidades base
 *   y `packagingTotalCost` preserva el costo del bulto sin pérdida de céntimos.
 */
export const convertPackagingReceipt = (params: {
  quantity: number;
  receivedQty?: number;
  unitCost: number;
  packagingFactor?: number | null;
  packagingTotalCost?: number | null;
  subtotal?: number | null;
}): {
  factor: number;
  unitsAdded: number;
  effectiveUnitCost: number;
  exactUnitCost: number;
} => {
  const factor = resolvePackagingFactor(params.packagingFactor);
  const rawQty =
    params.receivedQty !== undefined
      ? Number(params.receivedQty) || 0
      : Number(params.quantity) || 0;
  const safeQty = Math.max(0, rawQty);

  const hasPreConvertedPackCost =
    params.packagingTotalCost != null &&
    Number.isFinite(Number(params.packagingTotalCost)) &&
    factor > 1;

  if (hasPreConvertedPackCost) {
    const unitsAdded = Math.round(safeQty * 10000) / 10000;
    const exactUnitCost = Number(params.packagingTotalCost) / factor;
    return {
      factor,
      unitsAdded,
      effectiveUnitCost: roundToCents(exactUnitCost),
      exactUnitCost,
    };
  }

  const unitsAdded = Math.round(safeQty * factor * 10000) / 10000;
  const rawUnitCost = Math.max(0, Number(params.unitCost) || 0);
  const exactUnitCost = factor > 1 ? rawUnitCost / factor : rawUnitCost;
  return {
    factor,
    unitsAdded,
    effectiveUnitCost: roundToCents(exactUnitCost),
    exactUnitCost,
  };
};

export const DEFAULT_SUGGESTED_MARGIN_PERCENT = 25;

export const suggestedPriceFromCost = (
  cost: number,
  marginPercent: number = DEFAULT_SUGGESTED_MARGIN_PERCENT
): number => {
  const safeCost = Number(cost) || 0;
  const margin = Number(marginPercent);
  const safeMargin = Number.isFinite(margin) ? margin : DEFAULT_SUGGESTED_MARGIN_PERCENT;
  return roundToCents(safeCost * (1 + safeMargin / 100));
};

export const habitualMarginPercent = (cost: number, salePrice: number): number | null => {
  const c = Number(cost) || 0;
  const p = Number(salePrice) || 0;
  if (c <= 0 || p <= 0) return null;
  const margin = ((p - c) / c) * 100;
  if (!Number.isFinite(margin) || margin < 0) return null;
  return margin;
};

export const clampToFloor = (suggested: number, minSalePrice?: number | null): number => {
  const min = Number(minSalePrice) || 0;
  const value = Number(suggested) || 0;
  return min > 0 && value < min ? min : value;
};

export const suggestedSalePriceAfterCostChange = (change: {
  previousCost: number;
  newCost: number;
  currentSalePrice: number;
  fallbackMarginPercent?: number;
  minSalePrice?: number | null;
}): { unit: number; marginPercent: number; floored: boolean } => {
  const fallback = Number(change.fallbackMarginPercent);
  const fallbackMargin =
    Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_SUGGESTED_MARGIN_PERCENT;
  const habitual = habitualMarginPercent(change.previousCost, change.currentSalePrice);
  const marginPercent = habitual ?? fallbackMargin;

  const raw = suggestedPriceFromCost(change.newCost, marginPercent);
  let unit = clampToFloor(raw, change.minSalePrice);
  const current = Number(change.currentSalePrice) || 0;
  const costRose = Number(change.newCost) > Number(change.previousCost);

  if (costRose && current > 0 && unit < current) {
    unit = current;
  }

  return { unit, marginPercent, floored: unit > raw };
};

export const suggestedPresentationPrices = <
  T extends {
    id: string;
    name: string;
    quantity?: number;
    conversionFactor?: number;
    price: number;
    minSalePrice?: number;
    barcode?: string;
    active?: boolean;
  }
>(
  presentations: T[],
  unitSuggested: number,
  options?: { previousUnitPrice?: number; costRose?: boolean }
): T[] => {
  const unit = Number(unitSuggested) || 0;
  const previousUnit = Number(options?.previousUnitPrice) || 0;
  const ratio = previousUnit > 0 ? unit / previousUnit : 0;
  const costRose = options?.costRose === true;

  return presentations.map((p) => {
    const factor = Number(p.conversionFactor ?? p.quantity) || 1;
    const current = Number(p.price) || 0;
    const raw =
      current > 0 && ratio > 0
        ? roundToCents(current * ratio)
        : roundToCents(unit * factor);
    const min = p.minSalePrice != null ? Number(p.minSalePrice) : 0;
    let price = min > 0 && raw < min ? min : raw;
    if (costRose && current > 0 && price < current) price = current;
    return { ...p, price };
  });
};

export const costChanged = (previous: number, next: number): boolean =>
  Math.round(Math.abs((Number(previous) || 0) - (Number(next) || 0)) * 100) >= 1;

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

  // Normalizar ítems y calcular subtotales exactos (preservando empaque Web/Mobile)
  const normalizedItems: PurchaseOrderItem[] = items.map((item) => {
    const qty = Number(item.quantity) || 1;
    const factor = resolvePackagingFactor(item.packagingFactor);
    const unit = roundToCents(Number(item.unitCost) || 0);
    const packCost =
      item.packagingTotalCost != null && Number.isFinite(Number(item.packagingTotalCost))
        ? roundToCents(Number(item.packagingTotalCost))
        : undefined;
    const sub =
      packCost !== undefined && factor > 1 && qty % factor === 0
        ? roundToCents((qty / factor) * packCost)
        : roundToCents(qty * unit);

    return cleanFirestoreData({
      productId: item.productId,
      productName: item.productName || 'Producto',
      sku: item.sku || '',
      quantity: qty,
      unitCost: unit,
      subtotal: sub,
      packagingId: item.packagingId,
      packagingLabel: item.packagingLabel,
      packagingFactor: item.packagingFactor,
      packagingTotalCost: packCost,
      receivedQuantity: Number(item.receivedQuantity) || 0,
    }) as PurchaseOrderItem;
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
  branchNameOverride?: string,
  options?: ReceivePurchaseOrderOptions
): Promise<ReceivePurchaseOrderResult> => {
  const orderId = typeof orderOrId === 'string' ? orderOrId : orderOrId.id;

  if (!orderId) {
    throw new Error('Identificador de la orden de compra requerido.');
  }

  const costChanges: ReceivedProductCostChange[] = [];
  let resolvedStatus: PurchaseOrderStatus = 'received';

  await runTransaction(db, async (tx) => {
    // Limpiar acumulador ante posibles reintentos de Firestore
    costChanges.length = 0;
    resolvedStatus = 'received';

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

    // Leer una sola vez por productId único para cumplir lectura previa a escritura
    const productDocs = new Map<string, {
      ref: ReturnType<typeof doc>;
      snap: Awaited<ReturnType<typeof tx.get>>;
    }>();

    for (const item of items) {
      if (!item.productId || productDocs.has(item.productId)) continue;
      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);
      productDocs.set(item.productId, { ref: pRef, snap: pSnap });
    }

    // ----------------------------------------------------------------------
    // FASE 2: TODAS LAS ESCRITURAS (Updates de productos, Kardex y orden)
    // ----------------------------------------------------------------------
    const partialLookup = new Map<string, number>();
    if (Array.isArray(options?.partialItems)) {
      for (const entry of options.partialItems) {
        if (!entry?.productId) continue;
        partialLookup.set(
          entry.productId,
          Math.max(0, Number(entry.receivedQty) || 0)
        );
      }
    }

    // Estado mutable por productId para acumular múltiples líneas del mismo producto en un solo tx.update
    const workingProducts = new Map<string, {
      ref: ReturnType<typeof doc>;
      initialCost: number;
      currentCost: number;
      stockMap: Record<string, number>;
      reservedStock: Record<string, number>;
      minStock: number;
      minSalePrice: number;
      suggestedPrice: number;
      presentations: any[];
      branchPrices: Record<string, any>;
      name: string;
      sku: string;
      updatedFields: Record<string, any>;
    }>();

    const updatedItems: PurchaseOrderItem[] = [];
    let totalReceivedInRun = 0;

    for (const item of items) {
      const orderedQty = Math.max(0, Number(item.quantity) || 0);
      const alreadyReceived = Math.max(0, Number(item.receivedQuantity) || 0);
      const remainingQty = Math.max(0, Math.round((orderedQty - alreadyReceived) * 10000) / 10000);

      let qtyToReceive = remainingQty;
      if (options?.partialItems) {
        const requested = partialLookup.get(item.productId) ?? 0;
        qtyToReceive = Math.min(remainingQty, Math.max(0, requested));
        // Descontar del lookup por si hubiera otra línea del mismo productId
        partialLookup.set(item.productId, Math.max(0, requested - qtyToReceive));
      }

      const nextReceivedQty = Math.round((alreadyReceived + qtyToReceive) * 10000) / 10000;
      updatedItems.push({
        ...item,
        receivedQuantity: nextReceivedQty,
      });

      if (qtyToReceive <= 0) continue;
      totalReceivedInRun += qtyToReceive;

      const prodEntry = item.productId ? productDocs.get(item.productId) : undefined;
      if (!prodEntry || !prodEntry.snap.exists()) {
        console.warn(`[receivePurchaseOrder] Producto ID ${item.productId} no existe, omitiendo.`);
        continue;
      }

      let state = workingProducts.get(item.productId);
      if (!state) {
        const pData = prodEntry.snap.data() as Record<string, any>;
        state = {
          ref: prodEntry.ref,
          initialCost: Number(pData.costPrice) || 0,
          currentCost: Number(pData.costPrice) || 0,
          stockMap: { ...(pData.stock || {}) },
          reservedStock: { ...(pData.reservedStock || {}) },
          minStock: Number(pData.minStock) || DEFAULT_MIN_STOCK_THRESHOLD,
          minSalePrice: Number(pData.minSalePrice ?? 0),
          suggestedPrice: Number(pData.suggestedPrice ?? pData.price ?? 0),
          presentations: Array.isArray(pData.presentations) ? [...pData.presentations] : [],
          branchPrices: pData.branchPrices ? { ...pData.branchPrices } : {},
          name: pData.name || item.productName || 'Producto',
          sku: pData.sku || item.sku || item.productId || '',
          updatedFields: {},
        };
        workingProducts.set(item.productId, state);
      }

      const previousBranchStock = Number(state.stockMap[effectiveBranchId]) || 0;
      const totalCurrentStock = Object.values(state.stockMap).reduce(
        (sum: number, q: any) => sum + (Number(q) || 0),
        0
      );

      // Convertir empaque (bultos × packagingFactor) a unidades base y costo unitario real
      const { factor, unitsAdded, effectiveUnitCost, exactUnitCost } = convertPackagingReceipt({
        quantity: item.quantity,
        receivedQty: qtyToReceive,
        unitCost: item.unitCost,
        packagingFactor: item.packagingFactor,
        packagingTotalCost: item.packagingTotalCost,
        subtotal: item.subtotal,
      });

      if (unitsAdded <= 0) continue;

      // 1. Recalcular Costo Promedio Ponderado usando unidades convertidas y costo unitario
      const newCostPrice = calculateWeightedAverageCost(
        totalCurrentStock,
        state.currentCost,
        unitsAdded,
        exactUnitCost
      );

      // 2. Nuevo stock en la sucursal de destino
      const newBranchStock = Math.round((previousBranchStock + unitsAdded) * 10000) / 10000;
      state.stockMap[effectiveBranchId] = newBranchStock;
      state.currentCost = newCostPrice;

      const lowStockBranches = calculateLowStockBranches(
        state.stockMap,
        state.reservedStock,
        state.minStock
      );
      const branchIds = Object.keys(state.stockMap);

      state.updatedFields[`stock.${effectiveBranchId}`] = newBranchStock;
      state.updatedFields.costPrice = newCostPrice;
      state.updatedFields.branchIds = branchIds;
      state.updatedFields.lowStockBranches = lowStockBranches;
      state.updatedFields.updatedAt = serverTimestamp();

      // Si el precio mínimo de venta quedó por debajo del nuevo costo, ajustarlo al costo
      if (state.minSalePrice < newCostPrice) {
        state.minSalePrice = newCostPrice;
        state.updatedFields.minSalePrice = newCostPrice;
      }

      // Si la sucursal tiene un override explícito de costPrice en branchPrices, actualizarlo
      if (state.branchPrices?.[effectiveBranchId]?.costPrice !== undefined) {
        state.updatedFields[`branchPrices.${effectiveBranchId}.costPrice`] = newCostPrice;
        const branchMin = state.branchPrices[effectiveBranchId]?.minSalePrice;
        if (branchMin !== undefined && Number(branchMin) < newCostPrice) {
          state.updatedFields[`branchPrices.${effectiveBranchId}.minSalePrice`] = newCostPrice;
        }
      }

      // Si packagingFactor > 1, auto-crear presentación sincronizando quantity & conversionFactor
      if (factor > 1) {
        const exists = state.presentations.some(
          (p: any) => p.active !== false && Number(p.conversionFactor ?? p.quantity) === factor
        );
        if (!exists) {
          const nextPresentation = {
            id: `pres-x${factor}`,
            name: item.packagingLabel || `Caja x${factor}`,
            quantity: factor,
            conversionFactor: factor,
            price: state.suggestedPrice > 0 ? roundToCents(state.suggestedPrice * factor) : 0,
            active: true,
          };
          state.presentations = [...state.presentations, nextPresentation];
          state.updatedFields.presentations = state.presentations;
        }
      }

      // 3. Registrar movimiento en el Kardex oficial (inventory_movements) con createdAt + date
      const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
      const effectiveOrderNumber = orderData.orderNumber || orderId;

      tx.set(movementRef, cleanFirestoreData({
        accountId: orderData.accountId,
        branchId: effectiveBranchId,
        branchName: effectiveBranchName,
        productId: item.productId,
        productName: item.productName || state.name || 'Producto',
        productSku: item.sku || state.sku || item.productId || '',
        // Campos canónicos Web
        movementType: 'add',
        quantityBefore: previousBranchStock,
        quantityAfter: newBranchStock,
        quantityChanged: unitsAdded,
        referenceNumber: effectiveOrderNumber,
        userId: userProfile?.uid || 'system',
        userName: userProfile?.displayName || userProfile?.email || 'Usuario',
        userRole: userProfile?.role || 'user',
        // Campos alias Mobile
        type: 'in',
        previousStock: previousBranchStock,
        newStock: newBranchStock,
        quantity: unitsAdded,
        reason: 'purchase_order',
        unitCost: effectiveUnitCost,
        referenceId: orderId,
        notes: factor > 1
          ? `Recepción de Orden de Compra ${effectiveOrderNumber} (${qtyToReceive} × ${factor} u.)`
          : `Recepción de Orden de Compra ${effectiveOrderNumber}`,
        createdAt: serverTimestamp(),
        date: Date.now(),
      }));
    }

    if (options?.partialItems && totalReceivedInRun <= 0) {
      throw new Error('Ingresa al menos una cantidad mayor a cero para recibir.');
    }

    // Aplicar tx.update una sola vez por producto modificado y registrar cambios de costo
    for (const [productId, state] of workingProducts.entries()) {
      tx.update(state.ref, state.updatedFields);

      if (costChanged(state.initialCost, state.currentCost)) {
        costChanges.push({
          productId,
          productName: state.name,
          previousCost: state.initialCost,
          newCost: state.currentCost,
          suggestedPrice: state.suggestedPrice,
          minSalePrice: state.minSalePrice,
          presentations: state.presentations,
        });
      }
    }

    const allReceived = updatedItems.every(
      (it) => (Number(it.receivedQuantity) || 0) >= (Number(it.quantity) || 0) - 0.00001
    );
    resolvedStatus = allReceived ? 'received' : 'partial';

    // 4. Actualizar estado e ítems de la Orden de Compra (partial o received)
    const orderUpdate: Record<string, any> = {
      status: resolvedStatus,
      items: updatedItems,
      receivedBy: userProfile?.uid || 'system',
      receivedByName: userProfile?.displayName || userProfile?.email || 'Usuario',
      branchId: effectiveBranchId,
      branchName: effectiveBranchName,
      updatedAt: serverTimestamp(),
    };
    if (resolvedStatus === 'received') {
      orderUpdate.receivedAt = serverTimestamp();
      orderUpdate.receivedDate = serverTimestamp();
    } else {
      orderUpdate.partialReceivedAt = serverTimestamp();
    }

    tx.update(orderRef, orderUpdate);
  });

  return {
    success: true,
    orderId,
    status: resolvedStatus,
    itemsProcessed: costChanges.length,
    costChanges,
  };
};

/**
 * Aplica los nuevos precios de venta unitario y de presentaciones sugeridos tras una recepción de OC.
 */
export const applyProductSuggestedPrices = async (
  productId: string,
  suggestedPrice: number,
  presentations?: ReceivedProductCostChangePresentation[]
): Promise<void> => {
  if (!productId) {
    throw new Error('Identificador de producto requerido para actualizar precios.');
  }

  const productRef = doc(db, PRODUCTS_COLLECTION, productId);
  const snap = await getDoc(productRef);
  if (!snap.exists()) {
    throw new Error('Producto no encontrado al aplicar precios sugeridos.');
  }

  const data = snap.data() as Record<string, any>;
  const floor = Number(data.minSalePrice ?? 0);
  const safeSuggested = roundToCents(Math.max(floor, Number(suggestedPrice) || 0));

  const updatePayload: Record<string, any> = {
    suggestedPrice: safeSuggested,
    price: safeSuggested,
    updatedAt: serverTimestamp(),
  };

  if (Array.isArray(presentations)) {
    updatePayload.presentations = presentations.map((p) => {
      const factor = Number(p.conversionFactor ?? p.quantity) || 1;
      const presMin = p.minSalePrice != null ? Number(p.minSalePrice) : 0;
      const safePresPrice = roundToCents(Math.max(presMin, Number(p.price) || 0));
      return cleanFirestoreData({
        ...p,
        quantity: factor,
        conversionFactor: factor,
        price: safePresPrice,
      });
    });
  }

  await updateDoc(productRef, updatePayload);
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
    } else if (o.status === 'pending' || o.status === 'ordered' || o.status === 'partial') {
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
  applyProductSuggestedPrices,
  calculateWeightedAverageCost,
  calculatePurchaseOrderStats,
  generateNextOrderNumber,
};

export default SuppliersPOService;
