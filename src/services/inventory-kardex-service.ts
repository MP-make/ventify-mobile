import { normalizePresentation } from '@/lib/presentation-parity';
/**
 * Ventify Mobile - Inventory & Kardex Service
 * 
 * Gestión integral de inventario, catálogo de productos, movimientos de Kardex oficial
 * (`inventory_movements`), ajustes atómicos de stock y circuito de transferencias entre sucursales.
 * 
 * Paridad 100% con Ventify Web y firestore.rules:
 * - lowStockBranches con sentinel __any__ al inicio y exclusión de stock negativo.
 * - deriveBranchIds para persistencia de sucursales en productos nuevos con stock 0.
 * - Kardex con campos canónicos Web (movementType, quantityBefore, quantityAfter, quantityChanged)
 *   y campos alias Mobile (type, previousStock, newStock, quantity).
 * - Ajuste y transferencias sin updatedAt en products para cumplimiento de firestore.rules para cajeros.
 * - Transferencias con reserva de stock en pending y transición pending -> approved -> completed.
 */

import { db } from '@/lib/firebase';
import type { Product, InventoryMovement } from '@/types';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  Timestamp,
} from 'firebase/firestore';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { findProductByBarcode, type ScannedProductMatch } from '@/lib/product-search';

// ============================================================================
// CONSTANTES
// ============================================================================

export const PRODUCTS_COLLECTION = 'products';
export const INVENTORY_MOVEMENTS_COLLECTION = 'inventory_movements';
export const TRANSFERS_COLLECTION = 'transfers';

export const LOW_STOCK_THRESHOLD = 5;
export const LOW_STOCK_ANY = '__any__';
export const DEFAULT_MIN_STOCK_THRESHOLD = LOW_STOCK_THRESHOLD;

import type { UserProfileInfo } from './sale-service';

export interface AdjustStockParams {
  product: {
    id: string;
    name: string;
    sku?: string;
    accountId: string;
    stock?: Record<string, number>;
    reservedStock?: Record<string, number>;
    minStock?: number;
  };
  branchId: string;
  branchName?: string;
  newStock: number;
  reason: 'adjustment' | 'damage' | 'loss' | 'count_audit' | 'restock' | 'return' | string;
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface TransferItem {
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
}

export interface CreateTransferParams {
  accountId: string;
  fromBranchId: string;
  fromBranchName?: string;
  toBranchId: string;
  toBranchName?: string;
  sourceBranchId?: string;
  sourceBranchName?: string;
  destinationBranchId?: string;
  destinationBranchName?: string;
  items: TransferItem[];
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface StockTransfer {
  id: string;
  transferNumber?: string;
  accountId: string;
  sourceBranchId?: string;
  sourceBranchName?: string;
  destinationBranchId?: string;
  destinationBranchName?: string;
  fromBranchId: string;
  fromBranchName?: string;
  toBranchId: string;
  toBranchName?: string;
  items: TransferItem[];
  products?: Array<{
    productId: string;
    productName?: string;
    name?: string;
    sku?: string;
    quantity: number;
  }>;
  status: 'pending' | 'approved' | 'in_transit' | 'completed' | 'cancelled' | 'rejected';
  notes?: string;
  requestedBy?: string;
  requestedByName?: string;
  requestedAt?: number | Timestamp | any;
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: number | Timestamp | any;
  sentBy?: string;
  sentByName?: string;
  sentAt?: number | Timestamp | any;
  shippedAt?: number | Timestamp | any;
  receivedBy?: string;
  receivedByName?: string;
  receivedAt?: number | Timestamp | any;
  completedAt?: number | Timestamp | any;
  createdAt?: number | Timestamp | any;
  updatedAt?: number | Timestamp | any;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Deriva el campo denormalizado branchIds de un producto a partir de su mapa de stock.
 * Si el producto no tiene ninguna entrada de stock, se usa fallbackBranchIds.
 */
export const deriveBranchIds = (
  stockMap: Record<string, number> | null | undefined,
  fallbackBranchIds: string[] = []
): string[] => {
  const ids = Object.keys(stockMap || {});
  return ids.length > 0 ? ids : fallbackBranchIds;
};

/**
 * Recalcula la lista de sucursales con stock bajo o agotado para consultas rápidas.
 * Excluye stock negativo (un disponible menor que cero es descuadre, no reposición).
 * Coloca LOW_STOCK_ANY ('__any__') al inicio del array.
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

const aggregateTransferItems = <T extends { productId: string; productName?: string; name?: string; sku?: string; quantity: number }>(
  items: T[]
): Array<T & { quantity: number }> => {
  const aggregated = new Map<string, T & { quantity: number }>();
  for (const item of items) {
    const existing = aggregated.get(item.productId);
    if (existing) existing.quantity += Number(item.quantity) || 0;
    else aggregated.set(item.productId, { ...item, quantity: Number(item.quantity) || 0 });
  }
  return [...aggregated.values()];
};

/**
 * Normaliza bidireccionalmente los documentos de `inventory_movements`
 * para paridad 100% entre Ventify Web y Mobile.
 */
export const normalizeInventoryMovement = (data: any, id: string): any => {
  const raw = { id, ...data };

  // Si viene de la Web (con movementType, quantityBefore, quantityAfter, quantityChanged)
  if (raw.quantityChanged !== undefined && raw.quantity === undefined) {
    const qChanged = Number(raw.quantityChanged) || 0;
    raw.quantity = Math.abs(qChanged);
    raw.type = qChanged >= 0 ? 'in' : 'out';
    raw.previousStock = raw.quantityBefore !== undefined ? Number(raw.quantityBefore) : 0;
    raw.newStock = raw.quantityAfter !== undefined ? Number(raw.quantityAfter) : 0;
  }
  // Si viene de Mobile (con type, previousStock, newStock, quantity)
  else if (raw.quantity !== undefined && raw.quantityChanged === undefined) {
    const qty = Number(raw.quantity) || 0;
    const isIn = raw.type === 'in';
    raw.quantityChanged = isIn ? qty : -qty;
    raw.quantityBefore = raw.previousStock !== undefined ? Number(raw.previousStock) : 0;
    raw.newStock = raw.newStock !== undefined ? Number(raw.newStock) : 0;
    raw.movementType = raw.movementType || (isIn ? 'add' : (raw.reason === 'sale' ? 'sale' : 'edit'));
  }

  // Asegurar campos bidireccionales
  if (raw.quantity === undefined) raw.quantity = Math.abs(Number(raw.quantityChanged) || 0);
  if (raw.type === undefined) raw.type = (Number(raw.quantityChanged) || 0) >= 0 ? 'in' : 'out';
  if (raw.previousStock === undefined) raw.previousStock = Number(raw.quantityBefore) || 0;
  if (raw.newStock === undefined) raw.newStock = Number(raw.quantityAfter) || 0;
  if (raw.quantityChanged === undefined) raw.quantityChanged = raw.type === 'in' ? raw.quantity : -raw.quantity;
  if (raw.quantityBefore === undefined) raw.quantityBefore = raw.previousStock;
  if (raw.quantityAfter === undefined) raw.quantityAfter = raw.newStock;
  if (raw.movementType === undefined) raw.movementType = raw.type === 'in' ? 'add' : 'edit';
  if (!raw.productSku && raw.sku) raw.productSku = raw.sku;

  return raw;
};

// ============================================================================
// SERVICIOS DE INVENTARIO
// ============================================================================

/**
 * Crea o actualiza un producto en el catálogo `products` y registra
 * los movimientos iniciales en el Kardex si es un producto nuevo con stock.
 */
export const saveProduct = async (
  productData: Partial<Product> & {
    id?: string;
    accountId: string;
    name: string;
    sku?: string;
    branchId?: string;
    branchIds?: string[];
    costPrice?: number;
    minSalePrice?: number;
    suggestedPrice?: number;
    minStock?: number;
    stock?: Record<string, number>;
    reservedStock?: Record<string, number>;
    presentations?: any[];
    variants?: any[];
    allowDecimals?: boolean;
    unitOfMeasure?: string;
    category?: string;
    imageUrl?: string;
    barcode?: string;
    barcodes?: string[];
  },
  isNew: boolean,
  userProfile: UserProfileInfo
): Promise<string> => {
  if (!productData.name || productData.name.trim().length === 0) {
    throw new Error('El nombre del producto es obligatorio.');
  }

  if (!productData.accountId) {
    throw new Error('El identificador de cuenta (accountId) es obligatorio.');
  }

  const creating = isNew || !productData.id;
  const existingRef = !creating && productData.id
    ? doc(db, PRODUCTS_COLLECTION, productData.id)
    : null;
  const existingSnapshot = existingRef ? await getDoc(existingRef) : null;
  const existingData = existingSnapshot?.exists() ? existingSnapshot.data() : {};
  if (existingRef && !existingSnapshot?.exists()) {
    throw new Error(`El producto "${productData.id}" no existe.`);
  }

  const stockMap: Record<string, number> = productData.stock ?? existingData.stock ?? {};
  const reservedMap: Record<string, number> = productData.reservedStock ?? existingData.reservedStock ?? {};
  const fallbackBranchIds = (productData.branchIds && productData.branchIds.length > 0)
    ? productData.branchIds
    : (productData.branchId ? [productData.branchId] : (existingData.branchIds || []));
  const branchIds = deriveBranchIds(stockMap, fallbackBranchIds);
  const minStock = productData.minStock ?? existingData.minStock ?? LOW_STOCK_THRESHOLD;

  const lowStockBranches = calculateLowStockBranches(stockMap, reservedMap, minStock);

  const payload: any = {
    ...productData,
    name: productData.name.trim(),
    sku: productData.sku ? productData.sku.trim() : `SKU-${Date.now().toString().slice(-6)}`,
    costPrice: typeof productData.costPrice === 'number' ? Math.round(productData.costPrice * 100) / 100 : 0,
    minSalePrice: typeof productData.minSalePrice === 'number' ? Math.round(productData.minSalePrice * 100) / 100 : 0,
    suggestedPrice: typeof productData.suggestedPrice === 'number' ? Math.round(productData.suggestedPrice * 100) / 100 : 0,
    stock: stockMap,
    branchIds,
    lowStockBranches,
    minStock,
    presentations: Array.isArray(productData.presentations) ? productData.presentations.map(normalizePresentation) : [],
    unitOfMeasure: productData.unitOfMeasure || 'unit',
    category: productData.category || 'General',
    imageUrl: productData.imageUrl || '',
    barcode: productData.barcode || '',
    barcodes: Array.isArray(productData.barcodes) ? productData.barcodes : [],
    updatedAt: serverTimestamp(),
  };

  // Edición es parcial: la ausencia de un campo significa “no fue editado”.
  // En particular, reservas solo cambian por operaciones de inventario y no
  // deben desaparecer al guardar el formulario general del producto.
  if (creating) {
    payload.reservedStock = reservedMap;
    payload.variants = Array.isArray(productData.variants) ? productData.variants : [];
    payload.allowDecimals = Boolean(productData.allowDecimals);
  } else {
    if (productData.reservedStock !== undefined) payload.reservedStock = productData.reservedStock;
    if (productData.variants !== undefined) payload.variants = productData.variants;
    if (productData.allowDecimals !== undefined) payload.allowDecimals = productData.allowDecimals;
  }

  // Limpiar campos undefined
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  const productsColl = collection(db, PRODUCTS_COLLECTION);
  let productId = productData.id;

  if (isNew || !productId) {
    const newDocRef = doc(productsColl);
    productId = newDocRef.id;
    payload.id = productId;
    payload.createdAt = serverTimestamp();

    await setDoc(newDocRef, cleanFirestoreData(payload));

    // Si tiene stock inicial en alguna sucursal, registrar movimientos en inventory_movements
    const initialMovements = Object.entries(stockMap).filter(([_, qty]) => typeof qty === 'number' && qty > 0);

    for (const [branchId, qty] of initialMovements) {
      try {
        const mvRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        await setDoc(mvRef, cleanFirestoreData({
          accountId: productData.accountId,
          branchId,
          productId,
          productName: payload.name,
          productSku: payload.sku,
          // Campos canónicos Web
          movementType: 'add',
          quantityBefore: 0,
          quantityAfter: qty,
          quantityChanged: qty,
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          userRole: (userProfile as any)?.role || 'user',
          // Campos alias Mobile
          type: 'in',
          previousStock: 0,
          newStock: qty,
          quantity: qty,
          reason: 'initial_stock',
          notes: 'Inventario inicial al crear producto',
          createdAt: serverTimestamp(),
          date: Date.now(),
        }));
      } catch (err) {
        console.warn(`[InventoryService] Error registrando Kardex inicial para ${productId}:`, err);
      }
    }
  } else {
    await updateDoc(existingRef!, cleanFirestoreData(payload));
  }

  return productId;
};

/**
 * Resuelve códigos contra el catálogo completo de una cuenta. El catálogo
 * visual puede estar paginado/cargado parcialmente, pero el POS necesita una
 * respuesta de barcode que no dependa del límite de productos en memoria.
 */
export const findByBarcodeRemote = async (
  accountId: string,
  code: string
): Promise<ScannedProductMatch | null> => {
  if (!accountId || !code?.trim()) return null;
  const cleanCode = code.trim();

  // 1. Consultar por barcode directo con limit(1)
  const barcodeSnap = await getDocs(
    query(
      collection(db, PRODUCTS_COLLECTION),
      where('accountId', '==', accountId),
      where('barcode', '==', cleanCode),
      firestoreLimit(1)
    )
  );
  if (barcodeSnap.docs?.length) {
    const products = barcodeSnap.docs.map((productDoc) => ({
      id: productDoc.id,
      ...productDoc.data(),
    })) as Product[];
    const match = findProductByBarcode(products, cleanCode);
    if (match) return match;
  }

  // 2. Consultar por SKU con limit(1)
  const skuSnap = await getDocs(
    query(
      collection(db, PRODUCTS_COLLECTION),
      where('accountId', '==', accountId),
      where('sku', '==', cleanCode),
      firestoreLimit(1)
    )
  );
  if (skuSnap.docs?.length) {
    const products = skuSnap.docs.map((productDoc) => ({
      id: productDoc.id,
      ...productDoc.data(),
    })) as Product[];
    const match = findProductByBarcode(products, cleanCode);
    if (match) return match;
  }

  // 3. Consultar por barcodes alternativos (array-contains) con limit(1)
  const barcodesSnap = await getDocs(
    query(
      collection(db, PRODUCTS_COLLECTION),
      where('accountId', '==', accountId),
      where('barcodes', 'array-contains', cleanCode),
      firestoreLimit(1)
    )
  );
  if (barcodesSnap.docs?.length) {
    const products = barcodesSnap.docs.map((productDoc) => ({
      id: productDoc.id,
      ...productDoc.data(),
    })) as Product[];
    const match = findProductByBarcode(products, cleanCode);
    if (match) return match;
  }

  return null;
};


/**
 * Realiza un ajuste de stock atómico en una sucursal dada,
 * recalculando lowStockBranches e insertando el registro auditado en `inventory_movements`.
 * En products actualiza únicamente stock, branchIds y lowStockBranches (SIN updatedAt)
 * para cumplir con la regla de cajeros en firestore.rules línea 514.
 */
export const adjustProductStock = async (
  params: AdjustStockParams
): Promise<void> => {
  const { product, branchId, branchName, newStock, reason, notes, userProfile } = params;

  if (!product.id || !branchId) {
    throw new Error('Parámetros de producto y sucursal requeridos para ajuste de stock.');
  }

  if (typeof newStock !== 'number' || newStock < 0 || isNaN(newStock)) {
    throw new Error('El nuevo stock debe ser un número mayor o igual a cero.');
  }

  const productRef = doc(db, PRODUCTS_COLLECTION, product.id);
  const normalizedNewStock = Math.round(newStock * 10000) / 10000;

  await runTransaction(db, async (tx) => {
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) {
      throw new Error(`El producto con ID ${product.id} no existe.`);
    }

    const pData = productSnap.data();
    const currentStockMap = { ...(pData.stock || {}) };
    const previousStock = currentStockMap[branchId] || 0;
    const diff = Math.round((normalizedNewStock - previousStock) * 10000) / 10000;

    if (diff === 0) {
      return; // Sin cambios reales en stock
    }

    currentStockMap[branchId] = normalizedNewStock;
    const lowStockBranches = calculateLowStockBranches(
      currentStockMap,
      pData.reservedStock || {},
      pData.minStock ?? product.minStock ?? LOW_STOCK_THRESHOLD
    );
    const branchIds = deriveBranchIds(currentStockMap, pData.branchIds || [branchId]);

    // 1. Actualizar producto únicamente en campos permitidos para cajeros SIN updatedAt
    tx.update(productRef, {
      stock: currentStockMap,
      branchIds,
      lowStockBranches,
    });

    // 2. Registrar movimiento en Kardex con campos Web canónicos y alias Mobile
    const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
    tx.set(movementRef, cleanFirestoreData({
      accountId: product.accountId || pData.accountId,
      branchId,
      branchName: branchName || '',
      productId: product.id,
      productName: product.name || pData.name,
      productSku: product.sku || pData.sku || '',
      // Campos canónicos Web
      movementType: diff > 0 ? 'add' : 'edit',
      quantityBefore: previousStock,
      quantityAfter: normalizedNewStock,
      quantityChanged: diff,
      userId: userProfile.uid,
      userName: userProfile.displayName || userProfile.email || 'Usuario',
      userRole: (userProfile as any)?.role || 'user',
      // Campos alias Mobile
      type: diff > 0 ? 'in' : 'out',
      previousStock,
      newStock: normalizedNewStock,
      quantity: Math.abs(diff),
      reason: reason || 'adjustment',
      notes: notes || '',
      createdAt: serverTimestamp(),
      date: Date.now(),
    }));
  });
};

/**
 * Consulta los movimientos del Kardex oficial en `inventory_movements`
 * normalizando automáticamente campos bidireccionales Web y Mobile.
 */
export const getProductKardex = async (
  accountId: string,
  branchId: string,
  productId?: string,
  limitCount: number = 50
): Promise<any[]> => {
  try {
    const coll = collection(db, INVENTORY_MOVEMENTS_COLLECTION);
    const constraints: any[] = [
      where('accountId', '==', accountId),
      where('branchId', '==', branchId),
    ];

    if (productId) {
      constraints.push(where('productId', '==', productId));
    }

    const q = query(
      coll,
      ...constraints,
      orderBy('createdAt', 'desc'),
      firestoreLimit(limitCount)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => normalizeInventoryMovement(d.data(), d.id));
  } catch (err: any) {
    console.warn('[InventoryService] Error consultando Kardex (posible índice requerido):', err?.message);
    // Fallback sin orderBy en caso de índice compuesto ausente
    try {
      const coll = collection(db, INVENTORY_MOVEMENTS_COLLECTION);
      const constraints: any[] = [
        where('accountId', '==', accountId),
        where('branchId', '==', branchId),
      ];
      if (productId) constraints.push(where('productId', '==', productId));

      const fallbackQuery = query(coll, ...constraints, firestoreLimit(limitCount));
      const snap = await getDocs(fallbackQuery);
      const items = snap.docs.map((d) => normalizeInventoryMovement(d.data(), d.id));

      items.sort((a: any, b: any) => {
        const tA = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Number(a.createdAt) || a.date || 0;
        const tB = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Number(b.createdAt) || b.date || 0;
        return tB - tA;
      });

      return items;
    } catch (fallbackErr) {
      console.error('[InventoryService] Fallback de Kardex falló:', fallbackErr);
      return [];
    }
  }
};

// ============================================================================
// CIRCUITO DE TRANSFERENCIAS DE MERCADERÍA ENTRE SUCURSALES
// ============================================================================

/**
 * Crea una orden de transferencia de mercadería entre sucursales (`transfers`),
 * reservando el stock en la sucursal de origen (`reservedStock.${fromBranchId}`)
 * con estado inicial 'pending' para estricta paridad con firestore.rules líneas 890-902.
 */
export const createStockTransfer = async (
  params: CreateTransferParams
): Promise<string> => {
  const {
    accountId,
    fromBranchId,
    fromBranchName,
    toBranchId,
    toBranchName,
    items,
    notes,
    userProfile,
  } = params;

  const srcBranchId = params.sourceBranchId || fromBranchId;
  const dstBranchId = params.destinationBranchId || toBranchId;
  const srcBranchName = params.sourceBranchName || fromBranchName || srcBranchId;
  const dstBranchName = params.destinationBranchName || toBranchName || dstBranchId;

  if (!accountId || !srcBranchId || !dstBranchId) {
    throw new Error('Sucursal de origen, sucursal de destino y cuenta son obligatorias.');
  }

  if (srcBranchId === dstBranchId) {
    throw new Error('La sucursal de origen y destino no pueden ser la misma.');
  }

  if (!items || items.length === 0) {
    throw new Error('La transferencia debe incluir al menos un ítem.');
  }

  const transferDocRef = doc(collection(db, TRANSFERS_COLLECTION));
  const transferId = transferDocRef.id;
  const reservationItems = aggregateTransferItems(items);

  await runTransaction(db, async (tx) => {
    // Firestore requiere completar todas las lecturas antes de la primera escritura.
    const productReads: Array<{ item: TransferItem; ref: ReturnType<typeof doc>; snap: Awaited<ReturnType<typeof tx.get>> }> = [];
    for (const item of reservationItems) {
      if (item.quantity <= 0) {
        throw new Error(`La cantidad a transferir de "${item.productName}" debe ser mayor a cero.`);
      }
      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);
      productReads.push({ item, ref: pRef, snap: pSnap });
    }

    // 1. Validar y reservar stock en sucursal origen
    for (const { item, ref: pRef, snap: pSnap } of productReads) {
      if (!pSnap.exists()) {
        throw new Error(`El producto "${item.productName}" no fue encontrado.`);
      }

      const pData = pSnap.data() as Record<string, any>;
      const currentStockMap = { ...(pData.stock || {}) };
      const currentReservedMap = { ...(pData.reservedStock || {}) };

      const currentOriginStock = Number(currentStockMap[srcBranchId]) || 0;
      const currentOriginReserved = Number(currentReservedMap[srcBranchId]) || 0;
      const availableOrigin = currentOriginStock - currentOriginReserved;

      if (availableOrigin < item.quantity) {
        throw new Error(
          `Stock insuficiente en sucursal origen para "${item.productName}". Disponible: ${availableOrigin}, Requerido: ${item.quantity}.`
        );
      }

      const newReservedOrigin = Math.round((currentOriginReserved + item.quantity) * 10000) / 10000;
      currentReservedMap[srcBranchId] = newReservedOrigin;

      const lowStockBranches = calculateLowStockBranches(
        currentStockMap,
        currentReservedMap,
        pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
      );

      // Actualizar reservedStock en producto sin updatedAt (cumple firestore.rules para cajeros)
      tx.update(pRef, {
        reservedStock: currentReservedMap,
        lowStockBranches,
      });
    }

    // 2. Guardar documento de transferencia con estado 'pending' (requerido por firestore.rules líneas 898-901)
    const transferPayload: any = {
      id: transferId,
      accountId,
      sourceBranchId: srcBranchId,
      sourceBranchName: srcBranchName,
      destinationBranchId: dstBranchId,
      destinationBranchName: dstBranchName,
      fromBranchId: srcBranchId,
      fromBranchName: srcBranchName,
      toBranchId: dstBranchId,
      toBranchName: dstBranchName,
      items: items.map((it) => ({
        productId: it.productId,
        productName: it.productName,
        sku: it.sku || '',
        quantity: it.quantity,
      })),
      products: items.map((it) => ({
        productId: it.productId,
        name: it.productName,
        productName: it.productName,
        sku: it.sku || '',
        quantity: it.quantity,
      })),
      status: 'pending',
      requestedBy: userProfile.uid,
      requestedByName: userProfile.displayName || userProfile.email || 'Usuario',
      requestedAt: serverTimestamp(),
      notes: notes || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    tx.set(transferDocRef, cleanFirestoreData(transferPayload));
  });

  return transferId;
};

/**
 * Aprueba una transferencia pendiente (`pending` -> `approved`)
 */
export const approveStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) throw new Error('ID de transferencia requerido.');

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(transferRef);
    if (!snap.exists()) throw new Error(`La transferencia "${transferId}" no existe.`);
    const data = snap.data();
    if (data.status !== 'pending') {
      throw new Error(`Solo se pueden aprobar transferencias pendientes (estado actual: ${data.status}).`);
    }
    tx.update(transferRef, {
      status: 'approved',
      approvedBy: userProfile.uid,
      approvedByName: userProfile.displayName || userProfile.email || 'Usuario',
      approvedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
};

/** Marca el despacho físico de una transferencia aprobada. */
export const sendStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) throw new Error('ID de transferencia requerido.');
  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(transferRef);
    if (!snap.exists()) throw new Error(`La transferencia "${transferId}" no existe.`);
    if (snap.data().status !== 'approved') throw new Error('Solo se pueden enviar transferencias aprobadas.');
    tx.update(transferRef, {
      status: 'in_transit', sentBy: userProfile.uid,
      sentByName: userProfile.displayName || userProfile.email || 'Usuario',
      sentAt: serverTimestamp(), shippedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  });
};

/**
 * Cancela una transferencia pendiente o aprobada y libera el stock reservado en la sucursal de origen.
 */
export const cancelStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo,
  reason: string = 'Transferencia cancelada',
  finalStatus: 'cancelled' | 'rejected' = 'cancelled'
): Promise<void> => {
  if (!transferId) throw new Error('ID de transferencia requerido.');

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);

  await runTransaction(db, async (tx) => {
    const tSnap = await tx.get(transferRef);
    if (!tSnap.exists()) {
      throw new Error(`La transferencia "${transferId}" no existe.`);
    }

    const tData = tSnap.data();
    if (tData.status === 'completed' || tData.status === 'in_transit') {
      throw new Error('No se puede cancelar una transferencia completada o en tránsito.');
    }
    if (tData.status === 'cancelled' || tData.status === 'rejected') {
      return;
    }
    if (finalStatus === 'rejected' && tData.status !== 'pending') {
      throw new Error('Solo se pueden rechazar transferencias pendientes.');
    }
    if (finalStatus === 'cancelled' && !['pending', 'approved'].includes(tData.status)) {
      throw new Error(`No se puede cancelar una transferencia en estado ${tData.status}.`);
    }

    const srcBranchId = tData.sourceBranchId || tData.fromBranchId;
    if (!srcBranchId) throw new Error('La transferencia no tiene una sucursal de origen válida.');
    const rawItems = aggregateTransferItems(tData.products || tData.items || []);

    // Leer productos antes de liberar reservas para respetar el protocolo de Firestore.
    const productReads: Array<{ item: any; ref: ReturnType<typeof doc>; snap: Awaited<ReturnType<typeof tx.get>> }> = [];
    for (const item of rawItems) {
      if (!item.productId) continue;
      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);
      productReads.push({ item, ref: pRef, snap: pSnap });
    }

    // Liberar reserva de stock en origen
    for (const { item, ref: pRef, snap: pSnap } of productReads) {
      if (pSnap.exists()) {
        const pData = pSnap.data() as Record<string, any>;
        const currentReservedMap = { ...(pData.reservedStock || {}) };
        const currentSrcReserved = Number(currentReservedMap[srcBranchId]) || 0;
        const qty = Number(item.quantity) || 0;
        const newReserved = Math.max(0, currentSrcReserved - qty);
        if (newReserved > 0) {
          currentReservedMap[srcBranchId] = newReserved;
        } else {
          delete currentReservedMap[srcBranchId];
        }

        const lowStockBranches = calculateLowStockBranches(
          pData.stock || {},
          currentReservedMap,
          pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
        );

        tx.update(pRef, {
          reservedStock: currentReservedMap,
          lowStockBranches,
        });
      }
    }

    tx.update(transferRef, {
      status: finalStatus,
      rejectionReason: reason,
      cancelledBy: userProfile.uid,
      cancelledByName: userProfile.displayName || userProfile.email || 'Usuario',
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
};

export const rejectStockTransfer = (
  transferId: string,
  userProfile: UserProfileInfo,
  reason = 'Transferencia rechazada'
): Promise<void> => cancelStockTransfer(transferId, userProfile, reason, 'rejected');

/**
 * Completa la recepción de una transferencia en la sucursal de destino.
 * Cumple con el flujo de firestore.rules (pending -> approved -> completed):
 * Si la transferencia está en 'pending', primero se aprueba y luego se completa atómicamente.
 * Acredita el stock físico en destino, descuenta y libera el reservado en origen,
 * y genera ambos registros de Kardex oficial (`movementType: 'transfer'`).
 */
export const completeStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) {
    throw new Error('Identificador de transferencia requerido.');
  }

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);
  const initialSnap = await getDoc(transferRef);
  if (!initialSnap.exists()) {
    throw new Error(`La transferencia "${transferId}" no existe.`);
  }

  const initialData = initialSnap.data();
  if (initialData.status === 'completed') {
    throw new Error('La transferencia ya ha sido completada previamente.');
  }

  // Si está en 'pending', firestore.rules exige que pase a 'approved' primero
  if (initialData.status === 'pending') {
    throw new Error('La transferencia debe aprobarse antes de recibirla.');
  }

  await runTransaction(db, async (tx) => {
    const tSnap = await tx.get(transferRef);
    if (!tSnap.exists()) {
      throw new Error(`La transferencia "${transferId}" no existe.`);
    }

    const tData = tSnap.data();
    if (tData.status === 'completed') {
      throw new Error('La transferencia ya ha sido completada.');
    }

    if (tData.status !== 'approved' && tData.status !== 'in_transit') {
      throw new Error(`La transferencia se encuentra en estado "${tData.status}" y no puede ser completada.`);
    }

    const accountId = tData.accountId;
    const srcBranchId = tData.sourceBranchId || tData.fromBranchId;
    const dstBranchId = tData.destinationBranchId || tData.toBranchId;
    if (!srcBranchId || !dstBranchId || srcBranchId === dstBranchId) {
      throw new Error('La transferencia no tiene sucursales de origen y destino válidas.');
    }
    const srcBranchName = tData.sourceBranchName || tData.fromBranchName || srcBranchId;
    const dstBranchName = tData.destinationBranchName || tData.toBranchName || dstBranchId;

    const rawItems = aggregateTransferItems(tData.products || tData.items || []);
    if (rawItems.length === 0) {
      throw new Error('La transferencia no contiene productos para ingresar a stock.');
    }

    const transferItems = rawItems.map((item: any) => ({
      productId: item.productId,
      productName: item.productName || item.name || 'Producto',
      sku: item.sku || '',
      quantity: Number(item.quantity) || 0,
    }));

    // FASE 1: LECTURAS (todos los gets antes de updates)
    const productReads: Array<{
      ref: ReturnType<typeof doc>;
      snap: Awaited<ReturnType<typeof tx.get>>;
      item: (typeof transferItems)[0];
    }> = [];

    for (const item of transferItems) {
      if (!item.productId) continue;
      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);
      productReads.push({ ref: pRef, snap: pSnap, item });
    }

    // FASE 2: ESCRITURAS
    for (const { ref: pRef, snap: pSnap, item } of productReads) {
      if (!pSnap.exists()) {
        throw new Error(`El producto "${item.productName}" no fue encontrado.`);
      }

      const pData = pSnap.data() as Record<string, any>;
      const currentStockMap = { ...(pData.stock || {}) };
      const currentReservedMap = { ...(pData.reservedStock || {}) };

      const currentSrcStock = Number(currentStockMap[srcBranchId]) || 0;
      const currentDstStock = Number(currentStockMap[dstBranchId]) || 0;
      const currentSrcReserved = Number(currentReservedMap[srcBranchId]) || 0;

      if (currentSrcStock < item.quantity || currentSrcReserved < item.quantity) {
        throw new Error('La reserva del producto ya no está disponible para recibir la transferencia.');
      }

      // 1. Restar stock físico en origen
      const newSrcStock = Math.max(0, Math.round((currentSrcStock - item.quantity) * 10000) / 10000);
      currentStockMap[srcBranchId] = newSrcStock;

      // 2. Liberar stock reservado en origen
      const newSrcReserved = Math.max(0, Math.round((currentSrcReserved - item.quantity) * 10000) / 10000);
      if (newSrcReserved > 0) {
        currentReservedMap[srcBranchId] = newSrcReserved;
      } else {
        delete currentReservedMap[srcBranchId];
      }

      // 3. Sumar stock físico en destino
      const newDstStock = Math.round((currentDstStock + item.quantity) * 10000) / 10000;
      currentStockMap[dstBranchId] = newDstStock;

      const lowStockBranches = calculateLowStockBranches(
        currentStockMap,
        currentReservedMap,
        pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
      );

      const branchIds = deriveBranchIds(currentStockMap, pData.branchIds || [srcBranchId, dstBranchId]);

      // 4. Actualizar producto SIN updatedAt (cumple firestore.rules para rol cajero)
      tx.update(pRef, {
        stock: currentStockMap,
        reservedStock: currentReservedMap,
        branchIds,
        lowStockBranches,
      });

      const effectiveTransferNumber = tData.transferNumber || `TRF-${transferId.slice(-4).toUpperCase()}`;

      // 5. Kardex salida en origen
      const mvOutRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
      tx.set(mvOutRef, cleanFirestoreData({
        accountId,
        branchId: srcBranchId,
        branchName: srcBranchName,
        productId: item.productId,
        productName: item.productName,
        productSku: item.sku || pData.sku || '',
        movementType: 'transfer',
        quantityBefore: currentSrcStock,
        quantityAfter: newSrcStock,
        quantityChanged: -item.quantity,
        referenceNumber: effectiveTransferNumber,
        userId: userProfile.uid,
        userName: userProfile.displayName || userProfile.email || 'Usuario',
        userRole: (userProfile as any)?.role || 'user',
        type: 'out',
        previousStock: currentSrcStock,
        newStock: newSrcStock,
        quantity: item.quantity,
        reason: 'transfer_out',
        notes: `Transferencia #${transferId} hacia ${dstBranchName}`,
        createdAt: serverTimestamp(),
        date: Date.now(),
      }));

      // 6. Kardex entrada en destino
      const mvInRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
      tx.set(mvInRef, cleanFirestoreData({
        accountId,
        branchId: dstBranchId,
        branchName: dstBranchName,
        productId: item.productId,
        productName: item.productName,
        productSku: item.sku || pData.sku || '',
        movementType: 'transfer',
        quantityBefore: currentDstStock,
        quantityAfter: newDstStock,
        quantityChanged: item.quantity,
        referenceNumber: effectiveTransferNumber,
        userId: userProfile.uid,
        userName: userProfile.displayName || userProfile.email || 'Usuario',
        userRole: (userProfile as any)?.role || 'user',
        type: 'in',
        previousStock: currentDstStock,
        newStock: newDstStock,
        quantity: item.quantity,
        reason: 'transfer_in',
        notes: `Recepción de transferencia #${transferId} desde ${srcBranchName}`,
        createdAt: serverTimestamp(),
        date: Date.now(),
      }));
    }

    // 7. Marcar transferencia como 'completed'
    tx.update(transferRef, {
      status: 'completed',
      receivedBy: userProfile.uid,
      receivedByName: userProfile.displayName || userProfile.email || 'Usuario',
      receivedAt: serverTimestamp(),
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
};

/**
 * Obtiene la lista de transferencias de inventario de la cuenta
 */
export const getStockTransfers = async (
  accountId: string,
  branchId?: string,
  status?: string
): Promise<StockTransfer[]> => {
  try {
    const coll = collection(db, TRANSFERS_COLLECTION);
    const constraints: any[] = [where('accountId', '==', accountId)];

    if (status) {
      constraints.push(where('status', '==', status));
    }

    const q = query(coll, ...constraints);
    const snapshot = await getDocs(q);

    let transfers: StockTransfer[] = snapshot.docs.map((d) => {
      const data = d.data();
      const srcId = data.sourceBranchId || data.fromBranchId || '';
      const destId = data.destinationBranchId || data.toBranchId || '';
      const srcName = data.sourceBranchName || data.fromBranchName || '';
      const destName = data.destinationBranchName || data.toBranchName || '';

      const rawItems: any[] = data.items || data.products || [];
      const normalizedItems: TransferItem[] = rawItems.map((it: any) => ({
        productId: it.productId,
        productName: it.productName || it.name || 'Producto',
        sku: it.sku || '',
        quantity: Number(it.quantity) || 0,
      }));

      const normalizedProducts = rawItems.map((it: any) => ({
        productId: it.productId,
        name: it.productName || it.name || 'Producto',
        productName: it.productName || it.name || 'Producto',
        sku: it.sku || '',
        quantity: Number(it.quantity) || 0,
      }));

      return {
        id: d.id,
        transferNumber: data.transferNumber || `TRF-${d.id.slice(-4).toUpperCase()}`,
        ...data,
        sourceBranchId: srcId,
        destinationBranchId: destId,
        fromBranchId: srcId,
        toBranchId: destId,
        sourceBranchName: srcName,
        destinationBranchName: destName,
        fromBranchName: srcName,
        toBranchName: destName,
        items: normalizedItems,
        products: normalizedProducts,
      } as StockTransfer;
    });

    if (branchId && branchId !== 'all') {
      transfers = transfers.filter(
        (t) =>
          t.sourceBranchId === branchId ||
          t.destinationBranchId === branchId ||
          t.fromBranchId === branchId ||
          t.toBranchId === branchId
      );
    }

    // Ordenar descendente por fecha
    transfers.sort((a, b) => {
      const getTimestamp = (obj: any) => {
        const t = obj?.requestedAt || obj?.sentAt || obj?.createdAt;
        if (!t) return 0;
        if (typeof t === 'object' && 'seconds' in t) return t.seconds * 1000;
        if (t instanceof Date) return t.getTime();
        return Number(t) || 0;
      };
      return getTimestamp(b) - getTimestamp(a);
    });

    return transfers;
  } catch (err) {
    console.error('[InventoryService] Error obteniendo transferencias:', err);
    return [];
  }
};

// ============================================================================
// EXPORT DEFAULT COMO SERVICIO UNIFICADO
// ============================================================================

export const InventoryKardexService = {
  saveProduct,
  findByBarcodeRemote,
  adjustProductStock,
  getProductKardex,
  createStockTransfer,
  approveStockTransfer,
  rejectStockTransfer,
  cancelStockTransfer,
  sendStockTransfer,
  completeStockTransfer,
  getStockTransfers,
  calculateLowStockBranches,
  deriveLowStockBranches,
  deriveBranchIds,
  normalizeInventoryMovement,
};

export default InventoryKardexService;
