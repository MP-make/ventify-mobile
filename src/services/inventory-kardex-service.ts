/**
 * Ventify Mobile - Inventory & Kardex Service
 * 
 * Gestión integral de inventario, catálogo de productos, movimientos de Kardex oficial
 * (`inventory_movements`), ajustes atómicos de stock y circuito de transferencias entre sucursales.
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

// ============================================================================
// CONSTANTES
// ============================================================================

const PRODUCTS_COLLECTION = 'products';
const INVENTORY_MOVEMENTS_COLLECTION = 'inventory_movements';
const TRANSFERS_COLLECTION = 'transfers';

const DEFAULT_MIN_STOCK_THRESHOLD = 5;

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
  items: TransferItem[];
  notes?: string;
  userProfile: UserProfileInfo;
}

export interface StockTransfer {
  id: string;
  transferNumber?: string;
  accountId: string;
  fromBranchId: string;
  fromBranchName?: string;
  toBranchId: string;
  toBranchName?: string;
  items: TransferItem[];
  status: 'in_transit' | 'completed' | 'cancelled' | 'pending';
  notes?: string;
  sentBy: string;
  sentByName?: string;
  sentAt: number | Timestamp;
  requestedAt?: number | Timestamp;
  receivedBy?: string;
  receivedByName?: string;
  receivedAt?: number | Timestamp;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Recalcula la lista de sucursales con stock bajo o agotado para consultas rápidas
 */
export const calculateLowStockBranches = (
  stockMap: Record<string, number> = {},
  reservedMap: Record<string, number> = {},
  threshold: number = DEFAULT_MIN_STOCK_THRESHOLD
): string[] => {
  const result: string[] = [];

  for (const [branchId, qty] of Object.entries(stockMap)) {
    const reserved = reservedMap[branchId] || 0;
    const available = (qty || 0) - reserved;
    if (available <= threshold) {
      result.push(branchId);
    }
  }

  if (result.length > 0) {
    result.push('__any__');
  }

  return result;
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

  const stockMap: Record<string, number> = productData.stock || {};
  const reservedMap: Record<string, number> = productData.reservedStock || {};
  const branchIds = Object.keys(stockMap);
  const minStock = productData.minStock ?? DEFAULT_MIN_STOCK_THRESHOLD;

  const lowStockBranches = calculateLowStockBranches(stockMap, reservedMap, minStock);

  const payload: any = {
    ...productData,
    name: productData.name.trim(),
    sku: productData.sku ? productData.sku.trim() : `SKU-${Date.now().toString().slice(-6)}`,
    costPrice: typeof productData.costPrice === 'number' ? Math.round(productData.costPrice * 100) / 100 : 0,
    minSalePrice: typeof productData.minSalePrice === 'number' ? Math.round(productData.minSalePrice * 100) / 100 : 0,
    suggestedPrice: typeof productData.suggestedPrice === 'number' ? Math.round(productData.suggestedPrice * 100) / 100 : 0,
    stock: stockMap,
    reservedStock: reservedMap,
    branchIds,
    lowStockBranches,
    minStock,
    presentations: Array.isArray(productData.presentations) ? productData.presentations : [],
    variants: Array.isArray(productData.variants) ? productData.variants : [],
    allowDecimals: Boolean(productData.allowDecimals),
    unitOfMeasure: productData.unitOfMeasure || 'unit',
    category: productData.category || 'General',
    imageUrl: productData.imageUrl || '',
    barcode: productData.barcode || '',
    barcodes: Array.isArray(productData.barcodes) ? productData.barcodes : [],
    updatedAt: serverTimestamp(),
  };

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

    await setDoc(newDocRef, payload);

    // Si tiene stock inicial en alguna sucursal, registrar movimientos en inventory_movements
    const initialMovements = Object.entries(stockMap).filter(([_, qty]) => typeof qty === 'number' && qty > 0);

    for (const [branchId, qty] of initialMovements) {
      try {
        const mvRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        await setDoc(mvRef, {
          accountId: productData.accountId,
          branchId,
          productId,
          productName: payload.name,
          productSku: payload.sku,
          previousStock: 0,
          newStock: qty,
          quantity: qty,
          type: 'in',
          reason: 'initial_stock',
          notes: 'Inventario inicial al crear producto',
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        console.warn(`[InventoryService] Error registrando Kardex inicial para ${productId}:`, err);
      }
    }
  } else {
    const existingDocRef = doc(db, PRODUCTS_COLLECTION, productId);
    await updateDoc(existingDocRef, payload);
  }

  return productId;
};

/**
 * Realiza un ajuste de stock atómico en una sucursal dada,
 * recalculando lowStockBranches e insertando el registro auditado en `inventory_movements`.
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
      pData.minStock ?? product.minStock ?? DEFAULT_MIN_STOCK_THRESHOLD
    );

    // 1. Actualizar producto
    tx.update(productRef, {
      [`stock.${branchId}`]: normalizedNewStock,
      lowStockBranches,
      updatedAt: serverTimestamp(),
    });

    // 2. Registrar movimiento en Kardex
    const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
    tx.set(movementRef, {
      accountId: product.accountId || pData.accountId,
      branchId,
      branchName: branchName || '',
      productId: product.id,
      productName: product.name || pData.name,
      productSku: product.sku || pData.sku || '',
      previousStock,
      newStock: normalizedNewStock,
      quantity: Math.abs(diff),
      type: diff > 0 ? 'in' : 'out',
      reason: reason || 'adjustment',
      notes: notes || '',
      userId: userProfile.uid,
      userName: userProfile.displayName || userProfile.email || 'Usuario',
      createdAt: serverTimestamp(),
    });
  });
};

/**
 * Consulta los movimientos del Kardex oficial en `inventory_movements`
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
    return snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
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
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      items.sort((a: any, b: any) => {
        const tA = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Number(a.createdAt) || 0;
        const tB = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Number(b.createdAt) || 0;
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
 * validando y descontando el stock físico en la sucursal de origen (`type: 'out'`, `reason: 'transfer_out'`).
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

  if (!accountId || !fromBranchId || !toBranchId) {
    throw new Error('Sucursal de origen, sucursal de destino y cuenta son obligatorias.');
  }

  if (fromBranchId === toBranchId) {
    throw new Error('La sucursal de origen y destino no pueden ser la misma.');
  }

  if (!items || items.length === 0) {
    throw new Error('La transferencia debe incluir al menos un ítem.');
  }

  const transferDocRef = doc(collection(db, TRANSFERS_COLLECTION));
  const transferId = transferDocRef.id;

  await runTransaction(db, async (tx) => {
    // 1. Validar y descontar stock en origen
    for (const item of items) {
      if (item.quantity <= 0) {
        throw new Error(`La cantidad a transferir de "${item.productName}" debe ser mayor a cero.`);
      }

      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);

      if (!pSnap.exists()) {
        throw new Error(`El producto "${item.productName}" no fue encontrado.`);
      }

      const pData = pSnap.data();
      const currentStockMap = { ...(pData.stock || {}) };
      const currentReservedMap = { ...(pData.reservedStock || {}) };

      const availableOrigin = (currentStockMap[fromBranchId] || 0) - (currentReservedMap[fromBranchId] || 0);

      if (availableOrigin < item.quantity) {
        throw new Error(
          `Stock insuficiente en sucursal origen para "${item.productName}". Disponible: ${availableOrigin}, Requerido: ${item.quantity}.`
        );
      }

      const newOriginStock = Math.round((currentStockMap[fromBranchId] - item.quantity) * 10000) / 10000;
      currentStockMap[fromBranchId] = newOriginStock;

      const lowStockBranches = calculateLowStockBranches(
        currentStockMap,
        currentReservedMap,
        pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
      );

      // Actualizar producto en origen
      tx.update(pRef, {
        [`stock.${fromBranchId}`]: newOriginStock,
        lowStockBranches,
        updatedAt: serverTimestamp(),
      });

      // Kardex salida por transferencia
      const mvRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
      tx.set(mvRef, {
        accountId,
        branchId: fromBranchId,
        branchName: fromBranchName || '',
        productId: item.productId,
        productName: item.productName,
        productSku: item.sku || pData.sku || '',
        previousStock: availableOrigin,
        newStock: newOriginStock,
        quantity: item.quantity,
        type: 'out',
        reason: 'transfer_out',
        notes: `Transferencia #${transferId} hacia ${toBranchName || toBranchId}`,
        userId: userProfile.uid,
        userName: userProfile.displayName || userProfile.email || 'Usuario',
        createdAt: serverTimestamp(),
      });
    }

    // 2. Guardar documento de transferencia con estado 'in_transit'
    tx.set(transferDocRef, {
      id: transferId,
      accountId,
      fromBranchId,
      fromBranchName: fromBranchName || '',
      toBranchId,
      toBranchName: toBranchName || '',
      items,
      status: 'in_transit',
      notes: notes || '',
      sentBy: userProfile.uid,
      sentByName: userProfile.displayName || userProfile.email || 'Usuario',
      sentAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });
  });

  return transferId;
};

/**
 * Completa la recepción de una transferencia en la sucursal de destino,
 * acreditando el stock físico y registrando el movimiento en el Kardex (`type: 'in'`, `reason: 'transfer_in'`).
 */
export const completeStockTransfer = async (
  transferId: string,
  userProfile: UserProfileInfo
): Promise<void> => {
  if (!transferId) {
    throw new Error('Identificador de transferencia requerido.');
  }

  const transferRef = doc(db, TRANSFERS_COLLECTION, transferId);

  await runTransaction(db, async (tx) => {
    const tSnap = await tx.get(transferRef);
    if (!tSnap.exists()) {
      throw new Error(`La transferencia "${transferId}" no existe.`);
    }

    const tData = tSnap.data() as StockTransfer;
    if (tData.status !== 'in_transit') {
      throw new Error(`La transferencia se encuentra en estado "${tData.status}" y no puede ser completada.`);
    }

    const { accountId, toBranchId, toBranchName, items } = tData;

    // 1. Ingresar stock en la sucursal destino
    for (const item of items) {
      const pRef = doc(db, PRODUCTS_COLLECTION, item.productId);
      const pSnap = await tx.get(pRef);

      if (pSnap.exists()) {
        const pData = pSnap.data();
        const currentStockMap = { ...(pData.stock || {}) };
        const previousStock = currentStockMap[toBranchId] || 0;
        const newDestStock = Math.round((previousStock + item.quantity) * 10000) / 10000;
        currentStockMap[toBranchId] = newDestStock;

        const lowStockBranches = calculateLowStockBranches(
          currentStockMap,
          pData.reservedStock || {},
          pData.minStock || DEFAULT_MIN_STOCK_THRESHOLD
        );

        // Actualizar producto en destino
        tx.update(pRef, {
          [`stock.${toBranchId}`]: newDestStock,
          lowStockBranches,
          updatedAt: serverTimestamp(),
        });

        // Kardex entrada por transferencia
        const mvRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        tx.set(mvRef, {
          accountId,
          branchId: toBranchId,
          branchName: toBranchName || '',
          productId: item.productId,
          productName: item.productName,
          productSku: item.sku || pData.sku || '',
          previousStock,
          newStock: newDestStock,
          quantity: item.quantity,
          type: 'in',
          reason: 'transfer_in',
          notes: `Recepción de transferencia #${transferId} desde ${tData.fromBranchName || tData.fromBranchId}`,
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          createdAt: serverTimestamp(),
        });
      }
    }

    // 2. Marcar transferencia como 'completed'
    tx.update(transferRef, {
      status: 'completed',
      receivedBy: userProfile.uid,
      receivedByName: userProfile.displayName || userProfile.email || 'Usuario',
      receivedAt: serverTimestamp(),
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

    let transfers: StockTransfer[] = snapshot.docs.map((d) => ({
      id: d.id,
      ...(d.data() as any),
    }));

    if (branchId && branchId !== 'all') {
      transfers = transfers.filter(
        (t) => t.fromBranchId === branchId || t.toBranchId === branchId
      );
    }

    // Ordenar descendente por fecha de envío
    transfers.sort((a, b) => {
      const timeA = typeof a.sentAt === 'object' && 'seconds' in a.sentAt ? a.sentAt.seconds : Number(a.sentAt) || 0;
      const timeB = typeof b.sentAt === 'object' && 'seconds' in b.sentAt ? b.sentAt.seconds : Number(b.sentAt) || 0;
      return timeB - timeA;
    });

    return transfers;
  } catch (err) {
    console.error('[InventoryService] Error obteniendo transferencias:', err);
    return [];
  }
};
