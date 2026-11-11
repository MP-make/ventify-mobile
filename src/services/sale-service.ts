/**
 * Ventify Mobile - Sale Transaction Orchestrator Service
 * 
 * Orquestador transaccional completo de ventas nativo para React Native + Expo SDK 52.
 * Maneja validación de stock físico vs reservado, precios mínimos de venta, presentaciones
 * con factores de conversión, correlativos secuenciales atómicos por sucursal y tipo de documento,
 * Kardex oficial (inventory_movements), movimientos de caja chica (cash_register_movements),
 * cuentas corrientes de clientes (fiado) y despacho asíncrono hacia SUNAT UBL 2.1.
 */

import { db, auth } from '@/lib/firebase';
import type { Sale, CartItem, PaymentSplit } from '@/types';
import type { DocumentType } from '@/lib/invoicing/types';
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  updateDoc,
  query,
  where,
  getDocs,
  limit,
  Timestamp,
} from 'firebase/firestore';
import { cleanFirestoreData } from '@/lib/firebase-utils';

// ============================================================================
// CONSTANTES Y CONFIGURACIÓN
// ============================================================================

const SALES_COLLECTION = 'sales';
const QUOTES_COLLECTION = 'quotes';
const PRODUCTS_COLLECTION = 'products';
const INVENTORY_MOVEMENTS_COLLECTION = 'inventory_movements';
const CASH_SESSIONS_COLLECTION = 'cash_register_sessions';
const CASH_MOVEMENTS_COLLECTION = 'cash_register_movements';
const CUSTOMERS_COLLECTION = 'customers';
const COUNTERS_COLLECTION = 'sale_counters';
const RECEIVABLES_COLLECTION = 'accounts_receivable';

const DEFAULT_LOW_STOCK_THRESHOLD = 5;

const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://ventify.com.pe';

// ============================================================================
// TIPOS E INTERFACES
// ============================================================================

export type SaleDocumentType =
  | 'nota_venta'
  | 'nota'
  | 'boleta'
  | 'factura'
  | 'cotizacion'
  | '01'
  | '03'
  | '07'
  | '08'
  | '80'
  | 'cot'
  | 'NTV';

export type PaymentMethod =
  | 'efectivo'
  | 'tarjeta'
  | 'yape'
  | 'plin'
  | 'transferencia'
  | 'fiado'
  | 'mixto'
  | string;

export interface SaleItemInput {
  productId: string;
  name: string;
  sku?: string;
  price: number;
  quantity: number;
  costPrice?: number;
  minSalePrice?: number;
  presentationId?: string;
  presentationName?: string;
  presentationQty?: number;
  conversionFactor?: number;
  allowDecimals?: boolean;
  unitOfMeasure?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  imageUrl?: string;
}

export interface CustomerInput {
  id?: string;
  name: string;
  documentType?: 'DNI' | 'RUC' | 'CE' | 'PASAPORTE' | string;
  documentNumber?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface UserProfileInfo {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  role?: string;
}

export interface CreateSaleTransactionParams {
  accountId: string;
  branchId: string;
  userId: string;
  userName: string;
  items: SaleItemInput[];
  paymentMethod: PaymentMethod;
  documentType: SaleDocumentType;
  subtotal?: number;
  tax?: number;
  total: number;
  payments?: PaymentSplit[];
  cashAmount?: number;
  cardAmount?: number;
  digitalAmount?: number;
  cashReceived?: number;
  changeGiven?: number;
  customer?: CustomerInput;
  customerId?: string;
  customerName?: string;
  sessionId?: string;
  notes?: string;
  offlineId?: string;
  isQuote?: boolean;
  depositInfo?: {
    type: 'reservation' | 'order';
    reservationNumber?: number;
    orderNumber?: number;
    originalTotal: number;
    depositAmount: number;
    remainingAmount: number;
    depositSaleId?: string;
  };
}

export interface CreateSaleTransactionResult {
  saleId: string;
  saleNumber: number;
  correlative: string;
  documentType: SaleDocumentType;
  total: number;
  status: string;
  sunatStatus: 'pending' | 'submitted' | 'accepted' | 'rejected' | 'error' | 'not_applicable';
  sessionId?: string;
  offlineId?: string;
}

export interface CancelSaleResult {
  saleId: string;
  correlative: string;
  status: 'cancelled';
  reversalMovementsCount: number;
  cashRefunded: number;
  cancelledAt: Date;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Calcula las unidades base reales de inventario considerando presentación o venta decimal por peso
 */
export const calculateBaseUnits = (item: SaleItemInput): number => {
  const factor =
    typeof item.presentationQty === 'number' && item.presentationQty > 0
      ? item.presentationQty
      : typeof item.conversionFactor === 'number' && item.conversionFactor > 0
      ? item.conversionFactor
      : 1;

  const qty = typeof item.quantity === 'number' ? item.quantity : 1;
  const baseUnits = qty * factor;

  // Redondeo seguro para evitar aberraciones de punto flotante en pesos/medidas
  return Math.round(baseUnits * 10000) / 10000;
};

/**
 * Determina el prefijo de serie según el tipo de comprobante
 */
export const resolveDocumentSeries = (
  documentType: SaleDocumentType,
  customSeries?: string
): string => {
  if (customSeries && customSeries.trim().length > 0) {
    return customSeries.trim().toUpperCase();
  }

  const normalized = (documentType || '').toLowerCase();
  switch (normalized) {
    case 'boleta':
      return 'B001';
    case 'factura':
      return 'F001';
    case 'cotizacion':
      return 'COT1';
    case 'nota_venta':
    case 'nota':
    default:
      return 'NV01';
  }
};

/**
 * Formatea un correlativo secuencial: ej. NV01-000045
 */
export const formatCorrelative = (series: string, number: number): string => {
  return `${series}-${String(number).padStart(6, '0')}`;
};

/**
 * Recalcula la lista de sucursales con stock bajo para indexación eficiente
 */
export const computeLowStockBranches = (
  stockMap: Record<string, number>,
  reservedStockMap: Record<string, number> = {},
  threshold: number = DEFAULT_LOW_STOCK_THRESHOLD
): string[] => {
  const lowBranches: string[] = [];

  for (const [branchId, physical] of Object.entries(stockMap)) {
    const reserved = reservedStockMap[branchId] || 0;
    const available = (physical || 0) - reserved;
    if (available <= threshold) {
      lowBranches.push(branchId);
    }
  }

  if (lowBranches.length > 0) {
    lowBranches.push('__any__');
  }

  return lowBranches;
};

// ============================================================================
// SERVICIO PRINCIPAL: CREACIÓN DE VENTAS
// ============================================================================

/**
 * Orquestador transaccional atómico de venta.
 * Ejecuta validaciones estrictas, consumo de stock físico, correlativo atómico,
 * Kardex, movimientos de caja chica y disparo asíncrono a SUNAT.
 */
export const createSaleTransaction = async (
  params: CreateSaleTransactionParams
): Promise<CreateSaleTransactionResult> => {
  const {
    accountId,
    branchId,
    userId,
    userName,
    items,
    paymentMethod,
    documentType,
    total,
    subtotal = total / 1.18,
    tax = total - total / 1.18,
    payments,
    cashAmount = (paymentMethod === 'efectivo' || paymentMethod === 'cash') ? total : 0,
    cardAmount = (paymentMethod === 'tarjeta' || paymentMethod === 'card') ? total : 0,
    digitalAmount = ['yape', 'plin', 'transferencia', 'digital'].includes(paymentMethod) ? total : 0,
    cashReceived,
    changeGiven,
    customer,
    customerId = customer?.id,
    customerName = customer?.name,
    notes,
    offlineId,
    isQuote = documentType === 'cotizacion',
    depositInfo,
  } = params;

  // Determinar montos efectivos por método de pago de forma robusta
  let effectiveCash = cashAmount;
  let effectiveCard = cardAmount;
  let effectiveDigital = digitalAmount;
  let effectiveCredit = (paymentMethod === 'fiado' || paymentMethod === 'credit') ? total : 0;

  if (Array.isArray(payments) && payments.length > 0) {
    effectiveCash = 0;
    effectiveCard = 0;
    effectiveDigital = 0;
    effectiveCredit = 0;
    for (const p of payments) {
      const amt = p.amount || 0;
      if (p.category === 'cash') effectiveCash += amt;
      else if (p.category === 'card') effectiveCard += amt;
      else if (p.category === 'digital') effectiveDigital += amt;
      else if (p.category === 'credit') effectiveCredit += amt;
    }
  }

  if (!accountId || !branchId) {
    throw new Error('Datos requeridos faltantes: accountId y branchId son obligatorios.');
  }

  if (!items || items.length === 0) {
    throw new Error('La venta debe contener al menos un producto.');
  }

  // 1. DEDUPLICACIÓN POR OFFLINE ID (Idempotencia previa a transacción)
  if (offlineId) {
    try {
      const existingQ = query(
        collection(db, SALES_COLLECTION),
        where('accountId', '==', accountId),
        where('offlineId', '==', offlineId),
        limit(1)
      );
      const existingSnap = await getDocs(existingQ);
      if (!existingSnap.empty) {
        const existingDoc = existingSnap.docs[0];
        const existingData = existingDoc.data();
        return {
          saleId: existingDoc.id,
          saleNumber: existingData.saleNumber,
          correlative: existingData.correlative || formatCorrelative('NV01', existingData.saleNumber),
          documentType: existingData.documentType || documentType,
          total: existingData.total,
          status: existingData.status || 'completed',
          sunatStatus: existingData.sunatStatus || 'not_applicable',
          sessionId: existingData.sessionId,
          offlineId,
        };
      }
    } catch (checkErr) {
      console.warn('[SaleService] Error checking offline duplicate:', checkErr);
    }
  }

  // 2. EJECUCIÓN TRANSACCIONAL ATÓMICA
  const transactionResult = await runTransaction(db, async (tx) => {
    // A. Validar Sesión de Caja si no es cotización
    let resolvedSessionId = params.sessionId;
    const activePointerRef = doc(db, CASH_SESSIONS_COLLECTION, `active_${branchId}`);
    const userPointerRef = userId ? doc(db, CASH_SESSIONS_COLLECTION, `active_${accountId}_${branchId}_${userId}`) : null;

    if (!isQuote && !resolvedSessionId) {
      if (userPointerRef) {
        const userPointerSnap = await tx.get(userPointerRef);
        if (userPointerSnap.exists()) {
          const uData = userPointerSnap.data();
          if (uData.status === 'open' && uData.activeSessionId) {
            resolvedSessionId = uData.activeSessionId;
          }
        }
      }
      if (!resolvedSessionId) {
        const activePointerSnap = await tx.get(activePointerRef);
        if (activePointerSnap.exists()) {
          const pointerData = activePointerSnap.data();
          if (pointerData.status === 'open' && pointerData.activeSessionId) {
            resolvedSessionId = pointerData.activeSessionId;
          }
        }
      }
    }

    if (!isQuote && !resolvedSessionId && effectiveCash > 0) {
      throw new Error(
        'No se encontró una sesión de caja abierta en esta sucursal. Abre tu caja antes de registrar ventas en efectivo.'
      );
    }

    // B. Leer y validar todos los productos involucrados
    interface ValidatedItemData {
      item: SaleItemInput;
      productRef: any;
      productData: any;
      effectiveStockBranchKey: string;
      baseUnitsToDeduct: number;
      previousStock: number;
      newStock: number;
      costPrice: number;
      margin: number;
    }

    const validatedItems: ValidatedItemData[] = [];

    for (const item of items) {
      let pId = item.productId;
      if (!pId) {
        throw new Error(`Ítem inválido en la venta: falta productId (${item.name || 'desconocido'})`);
      }

      let productRef = doc(db, PRODUCTS_COLLECTION, pId);
      let productSnap = await tx.get(productRef);

      // Si no existe directamente y contiene guiones bajos (ej: ID_base_base), intentar con la clave base
      if (!productSnap.exists() && pId.includes('_')) {
        const parts = pId.split('_');
        if (parts.length >= 2) {
          const candidateBase = parts[0];
          const fallbackRef = doc(db, PRODUCTS_COLLECTION, candidateBase);
          const fallbackSnap = await tx.get(fallbackRef);
          if (fallbackSnap.exists()) {
            pId = candidateBase;
            productRef = fallbackRef;
            productSnap = fallbackSnap;
          }
        }
      }

      if (!productSnap.exists()) {
        throw new Error(`El producto "${item.name || pId}" no existe en el catálogo.`);
      }

      const productData = productSnap.data();

      // Validación de precio mínimo de venta
      const minSalePrice =
        typeof item.minSalePrice === 'number'
          ? item.minSalePrice
          : typeof productData.minSalePrice === 'number'
          ? productData.minSalePrice
          : 0;

      if (minSalePrice > 0 && item.price < minSalePrice) {
        throw new Error(
          `Precio no permitido para "${item.name}": S/ ${item.price.toFixed(2)} es inferior al precio mínimo autorizado (S/ ${minSalePrice.toFixed(2)}).`
        );
      }

      // Cálculo de unidades base reales a descontar
      const baseUnits = calculateBaseUnits(item);
      let currentPhysicalStock = 0;
      let effectiveStockBranchKey = branchId;

      if (typeof productData.stock === 'number') {
        currentPhysicalStock = productData.stock;
      } else if (productData.stock && typeof productData.stock === 'object') {
        if (typeof productData.stock[branchId] === 'number') {
          currentPhysicalStock = productData.stock[branchId];
          effectiveStockBranchKey = branchId;
        } else {
          // Resolver fallback coherente con catálogo móvil y web
          const stockKeys = Object.keys(productData.stock);
          if (stockKeys.length === 1) {
            effectiveStockBranchKey = stockKeys[0];
            currentPhysicalStock = Number(productData.stock[effectiveStockBranchKey] || 0);
          } else if (stockKeys.length > 0) {
            const matchedKey =
              stockKeys.find(
                (k) =>
                  k === branchId ||
                  k.toLowerCase().includes('principal') ||
                  k.toLowerCase().includes('main')
              ) || stockKeys[0];
            effectiveStockBranchKey = matchedKey;
            currentPhysicalStock = Number(productData.stock[effectiveStockBranchKey] || 0);
          }
        }
      }

      const currentReservedStock =
        productData.reservedStock?.[effectiveStockBranchKey] ||
        productData.reservedStock?.[branchId] ||
        0;
      const availableStock = currentPhysicalStock - currentReservedStock;

      // Validación de stock (solo si no es cotización ni depósito)
      if (!isQuote) {
        if (availableStock < baseUnits) {
          throw new Error(
            `Stock insuficiente para "${item.name}". Disponible: ${availableStock.toFixed(2)}, Requerido: ${baseUnits.toFixed(2)}.`
          );
        }
      }

      const newStock = Math.round((currentPhysicalStock - baseUnits) * 10000) / 10000;
      const costPrice =
        typeof item.costPrice === 'number'
          ? item.costPrice
          : typeof productData.costPrice === 'number'
          ? productData.costPrice
          : 0;

      const unitMargin = item.price - costPrice * (baseUnits / item.quantity);
      const margin = unitMargin * item.quantity;

      validatedItems.push({
        item,
        productRef,
        productData,
        effectiveStockBranchKey,
        baseUnitsToDeduct: baseUnits,
        previousStock: currentPhysicalStock,
        newStock,
        costPrice,
        margin,
      });
    }

    // C. Obtener correlativo secuencial atómico
    const normalizedDocType: SaleDocumentType = isQuote
      ? 'cotizacion'
      : (documentType as SaleDocumentType) || 'nota_venta';

    const series = resolveDocumentSeries(normalizedDocType);
    const counterDocId = `${accountId}_${branchId}_${normalizedDocType}`;
    const counterRef = doc(db, COUNTERS_COLLECTION, counterDocId);
    const counterSnap = await tx.get(counterRef);

    let nextNumber = 1;
    if (counterSnap.exists()) {
      nextNumber = (counterSnap.data()?.current || 0) + 1;
    }

    const correlative = formatCorrelative(series, nextNumber);

    // Actualizar el contador secuencial
    tx.set(
      counterRef,
      {
        current: nextNumber,
        series,
        lastUpdated: serverTimestamp(),
        documentType: normalizedDocType,
        branchId,
        accountId,
      },
      { merge: true }
    );

    // D. Gestionar cuenta por cobrar si es 'fiado'
    let customerRef: any = null;
    let newCustomerDebt: number | null = null;

    if (!isQuote && paymentMethod === 'fiado') {
      if (!customerId) {
        throw new Error('Para ventas al fiado es obligatorio seleccionar o registrar un cliente.');
      }
      customerRef = doc(db, CUSTOMERS_COLLECTION, customerId);
      const custSnap = await tx.get(customerRef);
      if (custSnap.exists()) {
        const custData = (custSnap.data() as any) || {};
        const currentDebt = custData.currentDebt || 0;
        newCustomerDebt = currentDebt + total;
        tx.update(customerRef, {
          currentDebt: newCustomerDebt,
          lastPurchaseDate: serverTimestamp(),
        });
      }
    }

    // E. Crear el documento de venta en Firestore
    const targetCollection = isQuote ? QUOTES_COLLECTION : SALES_COLLECTION;
    const saleDocRef = doc(collection(db, targetCollection));
    const saleId = saleDocRef.id;

    let totalMargin = 0;
    let totalCost = 0;

    const enrichedItems = validatedItems.map(({ item, baseUnitsToDeduct, costPrice, margin }) => {
      totalMargin += margin;
      totalCost += costPrice * baseUnitsToDeduct;
      const { product, ...cleanItem } = item as any;
      return {
        ...cleanItem,
        costPrice,
        margin,
        baseUnits: baseUnitsToDeduct,
      };
    });

    const isElectronic = normalizedDocType === 'boleta' || normalizedDocType === 'factura';

    const salePayload: any = {
      id: saleId,
      saleNumber: nextNumber,
      correlative,
      documentType: normalizedDocType,
      series,
      accountId,
      branchId,
      userId,
      userName,
      date: Date.now(),
      createdAt: serverTimestamp(),
      items: enrichedItems,
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round(total * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalMargin: Math.round(totalMargin * 100) / 100,
      marginPercent: total > 0 ? Math.round((totalMargin / total) * 10000) / 100 : 0,
      paymentMethod,
      payments: payments || [],
      cashAmount: Math.round(effectiveCash * 100) / 100,
      cardAmount: Math.round(effectiveCard * 100) / 100,
      digitalAmount: Math.round(effectiveDigital * 100) / 100,
      cashReceived: cashReceived !== undefined ? Math.round(cashReceived * 100) / 100 : undefined,
      changeGiven: changeGiven !== undefined ? Math.round(changeGiven * 100) / 100 : undefined,
      customerId: customerId || null,
      customerName: customerName || null,
      customerDocType: customer?.documentType || null,
      customerDocNumber: customer?.documentNumber || null,
      customerPhone: customer?.phone || null,
      customerAddress: customer?.address || null,
      notes: notes || null,
      sessionId: resolvedSessionId || null,
      offlineId: offlineId || null,
      status: isQuote ? 'pending' : 'completed',
      sunatStatus: isElectronic ? 'pending' : 'not_applicable',
      depositInfo: depositInfo || null,
    };

    // Limpieza profunda y recursiva de campos undefined para Firestore
    const cleanSalePayload = cleanFirestoreData(salePayload);
    tx.set(saleDocRef, cleanSalePayload);

    // F. Si no es cotización, descontar stock físico y generar Kardex
    if (!isQuote) {
      for (const vi of validatedItems) {
        const { item, productRef, productData, baseUnitsToDeduct, previousStock, newStock, effectiveStockBranchKey } = vi;

        // Recalcular lowStockBranches
        const currentStockMap = { ...(productData.stock || {}), [effectiveStockBranchKey]: newStock };
        const lowStockBranches = computeLowStockBranches(
          currentStockMap,
          productData.reservedStock || {},
          productData.minStock || DEFAULT_LOW_STOCK_THRESHOLD
        );

        // Actualizar stock atómicamente en el producto (respetando affectedKeys de firestore.rules para cajeros)
        tx.update(productRef, {
          [`stock.${effectiveStockBranchKey}`]: newStock,
          lowStockBranches,
        });

        // Registrar movimiento en el Kardex oficial (inventory_movements)
        const movementDocRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        const movementData = cleanFirestoreData({
          accountId,
          branchId: effectiveStockBranchKey,
          productId: vi.item.productId,
          productName: item.name,
          productSku: item.sku || productData.sku || '',
          quantityChanged: -baseUnitsToDeduct,
          quantityBefore: previousStock,
          quantityAfter: newStock,
          quantity: baseUnitsToDeduct,
          movementType: 'sale',
          type: 'out',
          reason: `Venta ${correlative}`,
          referenceId: saleId,
          referenceType: 'sale',
          saleId,
          correlative,
          userId,
          userName,
          timestamp: Date.now(),
          createdAt: serverTimestamp(),
        });
        tx.set(movementDocRef, movementData);
      }

      // G. Registrar movimiento de efectivo en caja chica (solo efectivo) y actualizar sesión de caja
      if (resolvedSessionId) {
        if (effectiveCash > 0) {
          const cashMovementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
          const cashMovementData = cleanFirestoreData({
            accountId,
            branchId,
            sessionId: resolvedSessionId,
            type: 'income',
            category: 'sale',
            amount: Math.round(effectiveCash * 100) / 100,
            description: `Venta ${correlative}`,
            paymentMethod: 'efectivo',
            saleId,
            createdBy: userId,
            createdByName: userName,
            createdAt: serverTimestamp(),
          });
          tx.set(cashMovementRef, cashMovementData);
        }

        // Actualizar acumuladores en la sesión específica
        const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, resolvedSessionId);
        const sessionSnap = await tx.get(sessionRef);
        if (sessionSnap.exists()) {
          const sData = sessionSnap.data();
          tx.update(sessionRef, {
            cashSales: (sData.cashSales || 0) + effectiveCash,
            cardSales: (sData.cardSales || 0) + effectiveCard,
            digitalSales: (sData.digitalSales || 0) + effectiveDigital,
            creditSales: (sData.creditSales || 0) + effectiveCredit,
            totalSales: (sData.totalSales || 0) + total,
            transactionCount: (sData.transactionCount || 0) + 1,
            expectedAmount: (sData.expectedAmount || 0) + effectiveCash,
            updatedAt: serverTimestamp(),
          });
        }

        // Actualizar acumuladores en el puntero de sesión activa
        const pointerSnap = await tx.get(activePointerRef);
        if (pointerSnap.exists() && pointerSnap.data()?.activeSessionId === resolvedSessionId) {
          const pData = pointerSnap.data();
          tx.update(activePointerRef, {
            cashSalesTotal: (pData.cashSalesTotal || 0) + effectiveCash,
            totalSales: (pData.totalSales || 0) + total,
            transactionCount: (pData.transactionCount || 0) + 1,
            lastSaleAt: serverTimestamp(),
          });
        }

        if (userPointerRef) {
          const uSnap = await tx.get(userPointerRef);
          if (uSnap.exists() && uSnap.data()?.activeSessionId === resolvedSessionId) {
            const uData = uSnap.data();
            tx.update(userPointerRef, {
              cashSalesTotal: (uData.cashSalesTotal || 0) + effectiveCash,
              totalSales: (uData.totalSales || 0) + total,
              transactionCount: (uData.transactionCount || 0) + 1,
              lastSaleAt: serverTimestamp(),
            });
          }
        }
      }

      // H. Registrar cuenta por cobrar si es 'fiado'
      if (paymentMethod === 'fiado') {
        const receivableRef = doc(collection(db, RECEIVABLES_COLLECTION));
        tx.set(receivableRef, {
          accountId,
          branchId,
          customerId,
          customerName,
          saleId,
          correlative,
          originalAmount: total,
          currentDebt: total,
          status: 'pending',
          createdAt: serverTimestamp(),
        });
      }
    }

    return {
      saleId,
      saleNumber: nextNumber,
      correlative,
      documentType: normalizedDocType,
      total,
      status: isQuote ? 'pending' : 'completed',
      sunatStatus: (isElectronic ? 'pending' : 'not_applicable') as CreateSaleTransactionResult['sunatStatus'],
      sessionId: resolvedSessionId,
      offlineId,
    };
  });

  // 3. DESPACHO ASÍNCRONO A SUNAT PARA BOLETA / FACTURA
  if (
    !isQuote &&
    (transactionResult.documentType === 'boleta' || transactionResult.documentType === 'factura')
  ) {
    emitToSunatAsync(transactionResult.saleId, accountId, branchId).catch((sunatErr) => {
      console.warn('[SaleService] Async SUNAT dispatch deferred or error:', sunatErr);
    });
  }

  return transactionResult;
};

// ============================================================================
// SUNAT ASYNCHRONOUS EMITTER
// ============================================================================

/**
 * Invoca el backend de facturación electrónica SUNAT con el token JWT de Firebase Auth
 */
export const emitToSunatAsync = async (
  saleId: string,
  accountId: string,
  branchId: string
): Promise<void> => {
  try {
    const currentUser = auth.currentUser;
    const token = await currentUser?.getIdToken();

    const response = await fetch(`${APP_URL}/api/invoicing/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        saleId,
        accountId,
        branchId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SaleService] Error en emisión SUNAT (${response.status}):`, errorText);
      await updateDoc(doc(db, SALES_COLLECTION, saleId), {
        sunatStatus: 'error',
        sunatError: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
        sunatUpdatedAt: serverTimestamp(),
      });
      return;
    }

    const data = await response.json();
    await updateDoc(doc(db, SALES_COLLECTION, saleId), {
      sunatStatus: data.success ? 'accepted' : 'rejected',
      cdrDescription: data.cdrDescription || data.message || null,
      hash: data.hash || null,
      xmlUrl: data.xmlUrl || null,
      pdfUrl: data.pdfUrl || null,
      sunatResponseDate: serverTimestamp(),
    });
  } catch (err: any) {
    console.error('[SaleService] Fallo al invocar endpoint SUNAT:', err);
    try {
      await updateDoc(doc(db, SALES_COLLECTION, saleId), {
        sunatStatus: 'error',
        sunatError: err?.message || 'Error de conexión al emitir comprobante',
        sunatUpdatedAt: serverTimestamp(),
      });
    } catch (_) {}
  }
};

// ============================================================================
// ANULACIÓN Y REVERSAL TRANSACCIONAL
// ============================================================================

/**
 * Anula una venta existente devolviendo el stock, registrando la compensación en Kardex
 * y emitiendo el contra-movimiento en la caja registradora de forma atómica.
 */
export const cancelSaleWithReversal = async (
  saleId: string,
  reason: string,
  userProfile: UserProfileInfo
): Promise<CancelSaleResult> => {
  if (!saleId) {
    throw new Error('Se requiere saleId para anular la venta.');
  }
  if (!reason || reason.trim().length === 0) {
    throw new Error('Debe proporcionar un motivo de anulación justificado.');
  }

  const result = await runTransaction(db, async (tx) => {
    const saleRef = doc(db, SALES_COLLECTION, saleId);
    const saleSnap = await tx.get(saleRef);

    if (!saleSnap.exists()) {
      throw new Error(`La venta con ID ${saleId} no fue encontrada.`);
    }

    const saleData = saleSnap.data();

    if (saleData.status === 'cancelled') {
      throw new Error(`La venta ${saleData.correlative || saleId} ya se encuentra anulada.`);
    }

    const branchId = saleData.branchId;
    const accountId = saleData.accountId;
    const items: any[] = saleData.items || [];

    // 1. Devolver el stock a cada producto y registrar el contra-movimiento en Kardex
    let reversalCount = 0;

    for (const item of items) {
      let pId = item.productId || item.id;
      if (!pId) continue;

      let productRef = doc(db, PRODUCTS_COLLECTION, pId);
      let productSnap = await tx.get(productRef);

      if (!productSnap.exists() && pId.includes('_')) {
        const parts = pId.split('_');
        if (parts.length >= 2) {
          const candidateBase = parts[0];
          const fallbackRef = doc(db, PRODUCTS_COLLECTION, candidateBase);
          const fallbackSnap = await tx.get(fallbackRef);
          if (fallbackSnap.exists()) {
            pId = candidateBase;
            productRef = fallbackRef;
            productSnap = fallbackSnap;
          }
        }
      }

      if (productSnap.exists()) {
        const pData = productSnap.data();
        const baseUnits = calculateBaseUnits(item);
        const currentStock = pData.stock?.[branchId] || 0;
        const restoredStock = Math.round((currentStock + baseUnits) * 10000) / 10000;

        const currentStockMap = { ...(pData.stock || {}), [branchId]: restoredStock };
        const lowStockBranches = computeLowStockBranches(
          currentStockMap,
          pData.reservedStock || {},
          pData.minStock || DEFAULT_LOW_STOCK_THRESHOLD
        );

        tx.update(productRef, {
          [`stock.${branchId}`]: restoredStock,
          lowStockBranches,
          updatedAt: serverTimestamp(),
        });

        // Registrar entrada por anulación en el Kardex oficial
        const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        tx.set(movementRef, {
          accountId,
          branchId,
          productId: pId,
          productName: item.name,
          productSku: item.sku || pData.sku || '',
          previousStock: currentStock,
          newStock: restoredStock,
          quantity: baseUnits,
          type: 'in',
          reason: 'sale_cancellation',
          saleId,
          correlative: saleData.correlative || null,
          notes: reason,
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          createdAt: serverTimestamp(),
        });

        reversalCount++;
      }
    }

    // 2. Compensar movimiento en caja si hubo dinero en efectivo
    const cashRefundAmount =
      saleData.cashAmount || (saleData.paymentMethod === 'efectivo' ? saleData.total : 0) || 0;

    if (cashRefundAmount > 0 && saleData.sessionId) {
      const compensatoryMovementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
      tx.set(compensatoryMovementRef, {
        accountId,
        branchId,
        sessionId: saleData.sessionId,
        type: 'expense',
        category: 'refund',
        amount: -Math.abs(cashRefundAmount),
        description: `Anulación venta ${saleData.correlative || saleId}: ${reason}`,
        saleId,
        createdBy: userProfile.uid,
        createdByName: userProfile.displayName || userProfile.email || 'Usuario',
        createdAt: serverTimestamp(),
      });

      // Actualizar sesión si está abierta
      const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, saleData.sessionId);
      const sessionSnap = await tx.get(sessionRef);
      if (sessionSnap.exists() && sessionSnap.data()?.status === 'open') {
        const sData = sessionSnap.data();
        tx.update(sessionRef, {
          totalExpenses: (sData.totalExpenses || 0) + cashRefundAmount,
          expectedAmount: (sData.expectedAmount || 0) - cashRefundAmount,
          updatedAt: serverTimestamp(),
        });
      }
    }

    // 3. Si era al fiado, revertir deuda del cliente
    if (saleData.paymentMethod === 'fiado' && saleData.customerId) {
      const customerRef = doc(db, CUSTOMERS_COLLECTION, saleData.customerId);
      const custSnap = await tx.get(customerRef);
      if (custSnap.exists()) {
        const custData = custSnap.data();
        const currentDebt = custData.currentDebt || 0;
        const revertedDebt = Math.max(0, currentDebt - saleData.total);
        tx.update(customerRef, {
          currentDebt: revertedDebt,
          lastModified: serverTimestamp(),
        });
      }
    }

    // 4. Marcar venta como anulada
    tx.update(saleRef, {
      status: 'cancelled',
      cancellationReason: reason,
      cancelledBy: userProfile.uid,
      cancelledByName: userProfile.displayName || userProfile.email || 'Usuario',
      cancelledAt: serverTimestamp(),
    });

    return {
      saleId,
      correlative: saleData.correlative || saleId,
      status: 'cancelled' as const,
      reversalMovementsCount: reversalCount,
      cashRefunded: cashRefundAmount,
      cancelledAt: new Date(),
    };
  });

  return result;
};
