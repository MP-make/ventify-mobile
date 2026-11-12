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
  getDoc,
  limit,
  Timestamp,
} from 'firebase/firestore';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { apiRequest } from '@/lib/api-client';
import {
  deriveBranchIds,
  deriveLowStockBranches,
  LOW_STOCK_THRESHOLD,
  LOW_STOCK_ANY,
} from '@/lib/product-branch-ids';

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
const NOTA_COUNTERS_COLLECTION = 'nota-counters';
const RECEIVABLES_COLLECTION = 'accounts_receivable';

const DEFAULT_LOW_STOCK_THRESHOLD = LOW_STOCK_THRESHOLD;

const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://ventify.com.pe';

export interface SaleSellerOption {
  id: string;
  name: string;
  branchIds: string[];
  isActive: boolean;
  userId?: string;
}

export const getAvailableSaleSellers = async (branchId: string): Promise<SaleSellerOption[]> => {
  const response = await apiRequest<{ sellers: SaleSellerOption[] }>(
    `/api/sales/sellers?branchId=${encodeURIComponent(branchId)}`,
  );
  return Array.isArray(response.sellers) ? response.sellers : [];
};

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
  /** Canonical stock map key consumed by this line (branch or legacy Principal alias). */
  stockBranchId?: string;
  allowDecimals?: boolean;
  unitOfMeasure?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  imageUrl?: string;
  variantId?: string;
  variantName?: string;
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
  userRole?: string;
  items: SaleItemInput[];
  paymentMethod: PaymentMethod;
  paymentMethodId?: string;
  paymentMethodName?: string;
  chargedAmount?: number;
  commissionAmount?: number;
  surchargeAmount?: number;
  netAmount?: number;
  documentType: SaleDocumentType;
  subtotal?: number;
  tax?: number;
  shippingAmount?: number;
  discountAmount?: number;
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
  saleDate?: number;
  sellerId?: string;
  sellerName?: string;
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
  sourceSaleRequestId?: string;
  sourceQuoteId?: string;
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

export interface RefundSaleResult {
  refundId: string;
  saleId: string;
  refundedAmount: number;
  refundedLineIndices: number[];
  status: 'completed' | 'refunded';
  cashRefunded: number;
  reversalMovementsCount: number;
  refundedAt: number;
  replay: boolean;
}

export interface RefundSaleOptions {
  accountId: string;
  branchId: string;
  sessionId: string;
  method: string;
  cashAmount?: number;
  cardAmount?: number;
  digitalAmount?: number;
  operationId?: string;
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

const resolveStockBranchKey = (stock: unknown, branchId: string): string => {
  if (!stock || typeof stock !== 'object') return branchId;
  const stockMap = stock as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(stockMap, branchId)) return branchId;
  return Object.keys(stockMap).find((key) =>
    key.toLowerCase().includes('principal') || key.toLowerCase().includes('main'),
  ) || branchId;
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

const stableRefundOperationId = (value: string): string => {
  const hash = (seed: number) => {
    let result = seed >>> 0;
    for (let index = 0; index < value.length; index++) {
      result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
    }
    return result.toString(16).padStart(8, '0');
  };
  return `refund_${hash(2166136261)}${hash(2246822519)}`;
};

export const refundSaleLines = async (
  saleId: string,
  lineIndices: number[],
  options: RefundSaleOptions,
): Promise<RefundSaleResult> => {
  if (!saleId || !options.sessionId || !lineIndices.length || lineIndices.some((index) => !Number.isInteger(index) || index < 0)) {
    throw new Error('Selecciona al menos un producto y una caja abierta para devolver.');
  }
  const normalizedIndices = [...new Set(lineIndices)].sort((a, b) => a - b);
  const operationId = options.operationId || stableRefundOperationId(`${saleId}:${options.sessionId}:${normalizedIndices.join(',')}:${options.method}:${options.cashAmount || 0}:${options.cardAmount || 0}:${options.digitalAmount || 0}`);
  return apiRequest<RefundSaleResult>('/api/sales/refund', {
    method: 'POST',
    body: {
      saleId,
      sessionId: options.sessionId,
      operationId,
      lineIndices: normalizedIndices,
      method: options.method,
      cashAmount: options.cashAmount,
      cardAmount: options.cardAmount,
      digitalAmount: options.digitalAmount,
    },
  });
};

/**
 * Recalcula la lista de sucursales con stock bajo para indexación eficiente
 */
export const computeLowStockBranches = (
  stockMap: Record<string, number>,
  reservedStockMap: Record<string, number> = {},
  threshold: number = DEFAULT_LOW_STOCK_THRESHOLD
): string[] => {
  return deriveLowStockBranches(stockMap, reservedStockMap, threshold);
};

/**
 * Determina la categoría de pago canónica exigida por firestore.rules
 */
export const derivePaymentCategory = (
  paymentMethod?: string,
  payments?: PaymentSplit[]
): 'cash' | 'card' | 'digital' | 'credit' | 'mixed' => {
  if (Array.isArray(payments) && payments.length > 1) {
    return 'mixed';
  }
  const norm = (paymentMethod || '').toLowerCase();
  if (norm === 'mixto' || norm === 'mixed') return 'mixed';
  if (norm === 'efectivo' || norm === 'cash') return 'cash';
  if (norm === 'tarjeta' || norm === 'card') return 'card';
  if (['yape', 'plin', 'transferencia', 'digital'].includes(norm)) return 'digital';
  if (norm === 'fiado' || norm === 'credit') return 'credit';
  if (Array.isArray(payments) && payments.length === 1 && payments[0].category) {
    const cat = payments[0].category.toLowerCase();
    if (['cash', 'card', 'digital', 'credit', 'mixed'].includes(cat)) {
      return cat as 'cash' | 'card' | 'digital' | 'credit' | 'mixed';
    }
  }
  return 'cash';
};

const isPrepaidCreditMethod = (method: string): boolean =>
  ['credits', 'creditos', 'créditos'].includes(method.toLowerCase());

const legacyPaymentMethodId = (method: string, payments?: PaymentSplit[]): string => {
  const aliases: Record<string, string> = { cash: 'efectivo', card: 'tarjeta', mixed: 'mixto', credit: 'creditos', fiado: 'creditos', credits: 'creditos', 'créditos': 'creditos' };
  const normalized = method.toLowerCase();
  if (normalized === 'digital') return payments?.find(part => part.category === 'digital')?.digitalProvider || 'transferencia';
  return aliases[normalized] || method;
};

export const buildAttributedSalePayload = (
  params: CreateSaleTransactionParams,
  resolvedSessionId?: string,
) => ({
  accountId: params.accountId,
  branchId: params.branchId,
  sessionId: resolvedSessionId || params.sessionId || '',
  total: Math.round(params.total * 100) / 100,
  subtotal: Math.round((params.subtotal ?? params.total) * 100) / 100,
  tax: Math.round((params.tax ?? 0) * 100) / 100,
  shippingAmount: Math.round((params.shippingAmount ?? 0) * 100) / 100,
  discountAmount: Math.round((params.discountAmount ?? 0) * 100) / 100,
  paymentMethod: params.paymentMethodName || params.paymentMethod,
  paymentMethodId: params.paymentMethodId || legacyPaymentMethodId(params.paymentMethod, params.payments),
  paymentCategory: derivePaymentCategory(params.paymentMethod, params.payments),
  payments: (params.payments || []).map(part => ({ ...part,
    methodId: part.methodId || legacyPaymentMethodId(part.category, [part]),
  })),
  cashAmount: params.cashAmount,
  cardAmount: params.cardAmount,
  digitalAmount: params.digitalAmount,
  cashReceived: params.cashReceived,
  changeGiven: params.changeGiven,
  documentType: params.documentType,
  items: params.items.map((item) => ({
    id: item.productId,
    productId: item.productId,
    name: item.name,
    sku: item.sku,
    price: item.price,
    quantity: item.quantity,
    costPrice: item.costPrice,
    minSalePrice: item.minSalePrice,
    presentationId: item.presentationId,
    presentationName: item.presentationName,
    presentationQty: item.presentationQty,
    conversionFactor: item.conversionFactor,
    subtotal: item.subtotal,
    total: item.total,
    variantId: item.variantId,
    variantName: item.variantName,
  })),
  customerId: params.customerId || params.customer?.id,
  customerName: params.customerName || params.customer?.name,
  customerDni: params.customer?.documentType === 'DNI' ? params.customer.documentNumber : undefined,
  customerRuc: params.customer?.documentType === 'RUC' ? params.customer.documentNumber : undefined,
  customerPhone: params.customer?.phone,
  customerEmail: params.customer?.email,
  customerAddress: params.customer?.address,
  notes: params.notes,
  sellerId: params.sellerId,
  sellerName: params.sellerName,
  creditMode: params.paymentMethod === 'fiado' || params.paymentMethod === 'credit'
    ? 'receivable'
    : isPrepaidCreditMethod(params.paymentMethod) ? 'prepaid' : undefined,
  date: params.saleDate,
});

/**
 * Envía la venta para su confirmación atómica en el servidor vía POST /api/sales/finalize
 * Requerido cuando la cuenta tiene habilitada la regla de atribución de vendedores
 * (enableSellerAttribution === true en settings/${accountId}_pos).
 */
export const finalizeAttributedSaleViaServer = async (
  params: CreateSaleTransactionParams,
  resolvedSessionId?: string
): Promise<CreateSaleTransactionResult> => {
  const currentUser = auth.currentUser;
  const token = await currentUser?.getIdToken();
  if (!token) {
    throw new Error('Inicia sesión para registrar la venta.');
  }

  const operationId = params.offlineId || `op_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const salePayload = buildAttributedSalePayload(params, resolvedSessionId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  let response: Response;
  let data: any;

  try {
    response = await fetch(`${APP_URL}/api/sales/finalize`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sale: cleanFirestoreData(salePayload),
        operationId,
        completion: params.depositInfo
          ? { type: params.depositInfo.type, id: params.depositInfo.depositSaleId || '' }
          : undefined,
        sourceSaleRequestId: params.sourceSaleRequestId,
        sourceQuoteId: params.sourceQuoteId,
      }),
    });

    data = await response.json();
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(data?.error || 'No se pudo confirmar el cobro en el servidor.');
  }

  const savedSale = data.sale || {};
  const isElectronic =
    params.documentType === 'boleta' ||
    params.documentType === 'factura' ||
    savedSale.documentType === 'boleta' ||
    savedSale.documentType === 'factura' ||
    savedSale.documentType === '01' ||
    savedSale.documentType === '03';

  const series = resolveDocumentSeries(params.documentType);
  const correlative = savedSale.correlative || formatCorrelative(series, data.saleNumber);

  // Despacho asíncrono a SUNAT si corresponde
  if (isElectronic) {
    emitToSunatAsync(data.saleId, params.accountId, params.branchId).catch((sunatErr) => {
      console.warn('[SaleService] Async SUNAT dispatch deferred or error:', sunatErr);
    });
  }

  return {
    saleId: data.saleId,
    saleNumber: data.saleNumber,
    correlative,
    documentType: params.documentType,
    total: savedSale.total ?? params.total,
    status: savedSale.status || 'completed',
    sunatStatus: isElectronic ? 'pending' : 'not_applicable',
    sessionId: savedSale.sessionId || resolvedSessionId,
    offlineId: params.offlineId,
  };
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
    subtotal = total,
    tax = 0,
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
    saleDate,
    isQuote = documentType === 'cotizacion',
    depositInfo,
  } = params;

  // Determinar montos efectivos por método de pago de forma robusta
  let effectiveCash = cashAmount;
  let effectiveCard = cardAmount;
  let effectiveDigital = digitalAmount;
  let effectiveCredit = (paymentMethod === 'fiado' || paymentMethod === 'credit') ? total : 0;
  let effectivePrepaidCredits = isPrepaidCreditMethod(paymentMethod) ? total : 0;

  if (Array.isArray(payments) && payments.length > 0) {
    effectiveCash = 0;
    effectiveCard = 0;
    effectiveDigital = 0;
    effectiveCredit = 0;
    effectivePrepaidCredits = 0;
    for (const p of payments) {
      const amt = p.category === 'credit' ? (p.amount || 0) : (p.chargedAmount ?? p.amount ?? 0);
      if (p.category === 'cash') effectiveCash += amt;
      else if (p.category === 'card') effectiveCard += amt;
      else if (p.category === 'digital') effectiveDigital += amt;
      else if (p.category === 'credit') {
        if (isPrepaidCreditMethod(paymentMethod)) effectivePrepaidCredits += amt;
        else effectiveCredit += amt;
      }
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

  // 1.5. CHECK SERVER CHECKOUT / SELLER ATTRIBUTION POLICY
  if (!isQuote) {
    let enableSellerAttribution = false;
    try {
      const posSettingsSnap = await getDoc(doc(db, 'settings', `${accountId}_pos`));
      if (posSettingsSnap.exists()) {
        enableSellerAttribution = posSettingsSnap.data()?.enableSellerAttribution === true;
      }
    } catch (e) {
      console.warn('[SaleService] Error checking settings for seller attribution:', e);
    }

    if (enableSellerAttribution || params.sourceSaleRequestId || params.sourceQuoteId) {
      let resolvedSession = params.sessionId;
      if (!resolvedSession) {
        try {
          if (userId) {
            const uSnap = await getDoc(doc(db, CASH_SESSIONS_COLLECTION, `active_${accountId}_${branchId}_${userId}`));
            if (uSnap.exists() && uSnap.data()?.status === 'open') {
              resolvedSession = uSnap.data()?.activeSessionId;
            }
          }
          if (!resolvedSession) {
            const aSnap = await getDoc(doc(db, CASH_SESSIONS_COLLECTION, `active_${branchId}`));
            if (aSnap.exists() && aSnap.data()?.status === 'open') {
              resolvedSession = aSnap.data()?.activeSessionId;
            }
          }
        } catch (err) {
          console.warn('[SaleService] Error resolving active cash session for server checkout:', err);
        }
      }
      return await finalizeAttributedSaleViaServer(params, resolvedSession);
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

    // Validar que todos los ítems tengan productId
    for (const item of items) {
      if (!item.productId) {
        throw new Error(`Ítem inválido en la venta: falta productId (${item.name || 'desconocido'})`);
      }
    }

    // Deduplicar productIds y leer en paralelo
    const uniqueProductIds = Array.from(new Set(items.map((it) => it.productId)));
    const initialProductSnaps = await Promise.all(
      uniqueProductIds.map((pId) => tx.get(doc(db, PRODUCTS_COLLECTION, pId)))
    );

    const productDocMap = new Map<string, { ref: any; snap: any }>();
    uniqueProductIds.forEach((pId, idx) => {
      productDocMap.set(pId, { ref: doc(db, PRODUCTS_COLLECTION, pId), snap: initialProductSnaps[idx] });
    });

    const missingCandidateBases = Array.from(
      new Set(
        uniqueProductIds
          .filter((pId) => {
            const entry = productDocMap.get(pId);
            return (!entry?.snap?.exists() || !entry.snap.data()) && pId.includes('_');
          })
          .map((pId) => pId.split('_')[0])
      )
    ).filter((base) => !productDocMap.has(base));

    if (missingCandidateBases.length > 0) {
      const fallbackSnaps = await Promise.all(
        missingCandidateBases.map((base) => tx.get(doc(db, PRODUCTS_COLLECTION, base)))
      );
      missingCandidateBases.forEach((base, idx) => {
        productDocMap.set(base, { ref: doc(db, PRODUCTS_COLLECTION, base), snap: fallbackSnaps[idx] });
      });
    }

    for (const item of items) {
      let pId = item.productId;
      let docEntry = productDocMap.get(pId);

      // Si no existe directamente y contiene guiones bajos (ej: ID_base_base), intentar con la clave base
      if ((!docEntry?.snap?.exists() || !docEntry.snap.data()) && pId.includes('_')) {
        const parts = pId.split('_');
        if (parts.length >= 2) {
          const candidateBase = parts[0];
          const fallbackEntry = productDocMap.get(candidateBase);
          if (fallbackEntry?.snap?.exists()) {
            pId = candidateBase;
            docEntry = fallbackEntry;
          }
        }
      }

      if (!docEntry?.snap?.exists()) {
        throw new Error(`El producto "${item.name || pId}" no existe en el catálogo.`);
      }

      const productRef = docEntry.ref;
      const productSnap = docEntry.snap;
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
          if (stockKeys.length > 0) {
            const matchedKey = stockKeys.find(
              (k) => k.toLowerCase().includes('principal') || k.toLowerCase().includes('main'),
            );
            if (!matchedKey) {
              throw new Error(`El producto "${item.name}" no tiene stock asociado a la sucursal activa.`);
            }
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

    // A cart can contain several lines for the same product (variants,
    // presentations, or repeated scans). Firestore snapshots all represent the
    // same original product state, so calculate a single combined mutation.
    const productStockPlans = new Map<string, {
      productRef: any;
      update: Record<string, any>;
      entries: ValidatedItemData[];
    }>();
    const groupedItems = new Map<string, ValidatedItemData[]>();
    for (const item of validatedItems) {
      const path = item.productRef.path || item.item.productId;
      const group = groupedItems.get(path) || [];
      group.push(item);
      groupedItems.set(path, group);
    }
    for (const [path, group] of groupedItems) {
      const first = group[0];
      const branchKey = first.effectiveStockBranchKey;
      const totalBaseUnits = group.reduce((sum, item) => sum + item.baseUnitsToDeduct, 0);
      const currentPhysicalStock = first.previousStock;
      const reservedStock = Number(
        first.productData.reservedStock?.[branchKey] ||
        first.productData.reservedStock?.[branchId] ||
        0,
      );
      if (!isQuote && currentPhysicalStock - reservedStock < totalBaseUnits - 0.00001) {
        throw new Error(
          `Stock insuficiente para "${first.item.name}". Disponible: ${Math.max(0, currentPhysicalStock - reservedStock).toFixed(2)}, Requerido: ${totalBaseUnits.toFixed(2)}.`,
        );
      }
      let runningStock = currentPhysicalStock;
      for (const item of group) {
        item.previousStock = runningStock;
        runningStock = Math.round((runningStock - item.baseUnitsToDeduct) * 10000) / 10000;
        item.newStock = runningStock;
      }
      const stockMap: Record<string, number> = {
        ...(typeof first.productData.stock === 'object' && first.productData.stock !== null
          ? first.productData.stock
          : {}),
        [branchKey]: runningStock,
      };
      const update: Record<string, any> = {
        stock: stockMap,
        branchIds: deriveBranchIds(stockMap),
        lowStockBranches: deriveLowStockBranches(stockMap, first.productData.reservedStock),
      };
      if (Array.isArray(first.productData.variants)) {
        const variantUnits = new Map<string, number>();
        for (const item of group) {
          const variantId = item.item.variantId || (item.item as any).variant?.id;
          if (variantId) variantUnits.set(variantId, (variantUnits.get(variantId) || 0) + item.baseUnitsToDeduct);
        }
        update.variants = first.productData.variants.map((variant: any) => {
          const units = variantUnits.get(variant.id) || 0;
          if (!units) return variant;
          const current = typeof variant.stock === 'number'
            ? variant.stock
            : Number(variant.stock?.[branchKey] || 0);
          if (!isQuote && current < units - 0.00001) {
            throw new Error(`Stock insuficiente para la variante "${variant.name || variant.id}".`);
          }
          if (typeof variant.stock === 'object' && variant.stock !== null) {
            return { ...variant, stock: {
              ...variant.stock,
              [branchKey]: Math.max(0, Math.round((current - units) * 10000) / 10000),
            } };
          }
          return { ...variant, stock: Math.max(0, Math.round((current - units) * 10000) / 10000) };
        });
      }
      productStockPlans.set(path, { productRef: first.productRef, update, entries: group });
    }

    // C. Obtener correlativo secuencial atómico oficial desde nota-counters/{branchId}
    const normalizedDocType: SaleDocumentType = isQuote
      ? 'cotizacion'
      : (documentType as SaleDocumentType) || 'nota_venta';

    const series = resolveDocumentSeries(normalizedDocType);
    const counterRef = doc(db, NOTA_COUNTERS_COLLECTION, branchId);
    const counterSnap = await tx.get(counterRef);

    let nextNumber = 1;
    if (counterSnap.exists()) {
      const counterData = counterSnap.data();
      nextNumber = (counterData?.counter || 0) + 1;
    }

    const correlative = formatCorrelative(series, nextNumber);

    // D. Gestionar cuenta por cobrar y deuda si es 'fiado' / crédito
    let customerRef: any = null;
    let customerSnap: any = null;
    let newCustomerDebt: number | null = null;
    const isPrepaidCredits = isPrepaidCreditMethod(paymentMethod) || effectivePrepaidCredits > 0;
    const isFiado = !isPrepaidCredits && (paymentMethod === 'fiado' || paymentMethod === 'credit' || effectiveCredit > 0);

    if (!isQuote && (isFiado || isPrepaidCredits)) {
      if (!customerId) {
        throw new Error(isFiado
          ? 'Para ventas al fiado es obligatorio seleccionar o registrar un cliente.'
          : 'Para usar créditos prepagados debes seleccionar un cliente.');
      }
      customerRef = doc(db, CUSTOMERS_COLLECTION, customerId);
      customerSnap = await tx.get(customerRef);
      if (!customerSnap.exists()) {
        throw new Error('El cliente seleccionado no existe.');
      }
      if (customerSnap.exists()) {
        const custData = (customerSnap.data() as any) || {};
        if (isPrepaidCredits) {
          const availableCredits = Number(custData.credits || 0);
          if (!Number.isFinite(availableCredits) || availableCredits < effectivePrepaidCredits) {
            throw new Error('El cliente no dispone de créditos prepagados suficientes.');
          }
        } else {
          const currentDebt = Number(custData.currentDebt || 0);
          const debtToAdd = effectiveCredit > 0 ? effectiveCredit : total;
          newCustomerDebt = Math.round((currentDebt + debtToAdd) * 100) / 100;
        }
      }
    }

    // Firestore requires every transactional read to finish before the first write.
    const sessionRef = resolvedSessionId
      ? doc(db, CASH_SESSIONS_COLLECTION, resolvedSessionId)
      : null;
    const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;
    if (sessionRef && (!sessionSnap?.exists() || sessionSnap.data()?.status !== 'open')) {
      throw new Error('La sesión de caja asociada a esta venta ya está cerrada. Abre una nueva caja para continuar.');
    }
    const activePointerSnap = resolvedSessionId ? await tx.get(activePointerRef) : null;
    const userPointerSnap = resolvedSessionId && userPointerRef ? await tx.get(userPointerRef) : null;

    if (!counterSnap.exists()) {
      tx.set(counterRef, {
        accountId,
        branchId,
        counter: 1,
        updatedAt: serverTimestamp(),
      });
    } else {
      tx.update(counterRef, {
        counter: nextNumber,
        updatedAt: serverTimestamp(),
      });
    }

    if (customerRef && customerSnap?.exists() && newCustomerDebt !== null) {
      tx.update(customerRef, {
        currentDebt: newCustomerDebt,
        lastPurchaseDate: serverTimestamp(),
      });
    }
    if (customerRef && customerSnap?.exists() && isPrepaidCredits) {
      const currentCredits = Number(customerSnap.data()?.credits || 0);
      tx.update(customerRef, {
        credits: Math.round((currentCredits - effectivePrepaidCredits) * 100) / 100,
      });
    }

    // E. Crear el documento de venta en Firestore
    const targetCollection = isQuote ? QUOTES_COLLECTION : SALES_COLLECTION;
    const saleDocRef = doc(collection(db, targetCollection));
    const saleId = saleDocRef.id;

    let totalMargin = 0;
    let totalCost = 0;

    const enrichedItems = validatedItems.map(({ item, effectiveStockBranchKey, baseUnitsToDeduct, costPrice, margin }) => {
      totalMargin += margin;
      totalCost += costPrice * baseUnitsToDeduct;
      const { product, ...cleanItem } = item as any;
      return {
        ...cleanItem,
        stockBranchId: effectiveStockBranchKey,
        costPrice,
        margin,
        baseUnits: baseUnitsToDeduct,
      };
    });

    const isElectronic = normalizedDocType === 'boleta' || normalizedDocType === 'factura';
    const paymentCategory = derivePaymentCategory(paymentMethod, payments);

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
      date: saleDate || Date.now(),
      createdAt: serverTimestamp(),
      items: enrichedItems,
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round(total * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalMargin: Math.round(totalMargin * 100) / 100,
      marginPercent: total > 0 ? Math.round((totalMargin / total) * 10000) / 100 : 0,
      paymentMethod,
      paymentMethodId: params.paymentMethodId,
      creditMode: effectivePrepaidCredits > 0 ? 'prepaid' : effectiveCredit > 0 ? 'receivable' : undefined,
      creditAmount: effectiveCredit,
      prepaidCreditAmount: effectivePrepaidCredits,
      chargedAmount: params.chargedAmount ?? total,
      commissionAmount: params.commissionAmount ?? 0,
      surchargeAmount: params.surchargeAmount ?? 0,
      netAmount: params.netAmount ?? total,
      paymentCategory,
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

    // Asegurar que el payload de venta en cliente NUNCA incluya las claves prohibidas por firestore.rules
    delete salePayload.attributionVersion;
    delete salePayload.commitFingerprint;
    delete salePayload.operationId;

    // Limpieza profunda y recursiva de campos undefined para Firestore
    const cleanSalePayload = cleanFirestoreData(salePayload);
    delete cleanSalePayload.attributionVersion;
    delete cleanSalePayload.commitFingerprint;
    delete cleanSalePayload.operationId;

    tx.set(saleDocRef, cleanSalePayload);

    // F. Si no es cotización, descontar stock físico y generar Kardex
    if (!isQuote) {
      const updatedProducts = new Set<string>();
      for (const vi of validatedItems) {
        const { item, productRef, productData, baseUnitsToDeduct, previousStock, newStock, effectiveStockBranchKey } = vi;
        const productPath = productRef.path || vi.item.productId;
        if (!updatedProducts.has(productPath)) {
          const plan = productStockPlans.get(productPath)!;
          // NUNCA incluir updatedAt para respetar las reglas de cajero (firestore.rules línea 514)
          tx.update(plan.productRef, plan.update);
          updatedProducts.add(productPath);
        }

        // Registrar movimiento en el Kardex oficial (inventory_movements)
        // Con campos canónicos Web y alias móviles
        const movementDocRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        const movementData = cleanFirestoreData({
          // Campos canónicos Web
          accountId,
          branchId: effectiveStockBranchKey,
          userId,
          userName,
          userRole: params.userRole || 'cashier',
          productId: vi.item.productId,
          productName: item.name,
          productSku: item.sku || productData.sku || '',
          movementType: 'sale',
          quantityBefore: previousStock,
          quantityAfter: newStock,
          quantityChanged: -baseUnitsToDeduct,
          saleId,
          saleAmount: Math.round(total * 100) / 100,
          createdAt: serverTimestamp(),
          // Alias móviles para compatibilidad total
          type: 'out',
          previousStock,
          newStock,
          quantity: baseUnitsToDeduct,
          reason: `Venta ${correlative}`,
          referenceId: saleId,
          referenceType: 'sale',
          correlative,
          timestamp: Date.now(),
        });
        tx.set(movementDocRef, movementData);
      }

      // G. Actualizar acumuladores en la sesión de caja (SIN crear doc en cash_register_movements para no duplicar arqueo)
      if (resolvedSessionId) {
        // Actualizar acumuladores en la sesión específica
        if (sessionSnap?.exists()) {
          const sData = sessionSnap.data();
          tx.update(sessionRef!, {
            cashSales: (sData.cashSales || 0) + effectiveCash,
            cardSales: (sData.cardSales || 0) + effectiveCard,
            digitalSales: (sData.digitalSales || 0) + effectiveDigital,
            creditSales: (sData.creditSales || 0) + effectiveCredit + effectivePrepaidCredits,
            totalSales: (sData.totalSales || 0) + (params.chargedAmount ?? total),
            totalCommissionAmount: (sData.totalCommissionAmount || 0) + (params.commissionAmount || 0),
            totalSurchargeAmount: (sData.totalSurchargeAmount || 0) + (params.surchargeAmount || 0),
            transactionCount: (sData.transactionCount || 0) + 1,
            expectedAmount: (sData.expectedAmount || 0) + effectiveCash,
            auditRevision: (sData.auditRevision || 0) + 1,
            updatedAt: serverTimestamp(),
          });
        }

        // Actualizar acumuladores en el puntero de sesión activa
        if (activePointerSnap?.exists() && activePointerSnap.data()?.activeSessionId === resolvedSessionId) {
          const pData = activePointerSnap.data();
          tx.update(activePointerRef, {
            cashSalesTotal: (pData.cashSalesTotal || 0) + effectiveCash,
            totalSales: (pData.totalSales || 0) + (params.chargedAmount ?? total),
            transactionCount: (pData.transactionCount || 0) + 1,
            lastSaleAt: serverTimestamp(),
          });
        }

        if (userPointerSnap?.exists() && userPointerSnap.data()?.activeSessionId === resolvedSessionId) {
            const uData = userPointerSnap.data();
          tx.update(userPointerRef!, {
              cashSalesTotal: (uData.cashSalesTotal || 0) + effectiveCash,
              totalSales: (uData.totalSales || 0) + (params.chargedAmount ?? total),
              transactionCount: (uData.transactionCount || 0) + 1,
              lastSaleAt: serverTimestamp(),
            });
        }
      }

      // H. Registrar cuenta por cobrar si es 'fiado' / crédito
      if (isFiado && customerId) {
        const receivableRef = doc(collection(db, RECEIVABLES_COLLECTION));
        const debtAmount = effectiveCredit > 0 ? effectiveCredit : total;
        tx.set(receivableRef, {
          accountId,
          branchId,
          customerId,
          customerName,
          saleId,
          correlative,
          originalAmount: debtAmount,
          currentDebt: debtAmount,
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const currentUser = auth.currentUser;
    const token = await currentUser?.getIdToken();

    const response = await fetch(`${APP_URL}/api/invoicing/emit`, {
      method: 'POST',
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeoutId);
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

  const legacySaleSnapshot = await getDoc(doc(db, SALES_COLLECTION, saleId));
  const legacyAccountId = legacySaleSnapshot.exists()
    ? String(legacySaleSnapshot.data()?.accountId || '')
    : '';
  const legacyMovements = legacyAccountId ? await getDocs(query(
    collection(db, INVENTORY_MOVEMENTS_COLLECTION),
    where('saleId', '==', saleId),
    where('accountId', '==', legacyAccountId),
  )) : { docs: [] };
  const legacyStockBranchByProduct = new Map<string, string>();
  for (const movement of legacyMovements.docs) {
    const data = movement.data();
    if (typeof data.productId === 'string' && typeof data.branchId === 'string') {
      legacyStockBranchByProduct.set(data.productId, data.branchId);
    }
  }

  const linkedReceivables = legacyAccountId ? await getDocs(query(
    collection(db, RECEIVABLES_COLLECTION), where('accountId', '==', legacyAccountId), where('saleId', '==', saleId),
  )) : { docs: [] };

  const result = await runTransaction(db, async (tx) => {
    const saleRef = doc(db, SALES_COLLECTION, saleId);
    const saleSnap = await tx.get(saleRef);

    if (!saleSnap.exists()) {
      throw new Error(`La venta con ID ${saleId} no fue encontrada.`);
    }

    const saleData = saleSnap.data();
    if (legacyAccountId && saleData.accountId !== legacyAccountId) {
      throw new Error('La venta cambió de cuenta durante la anulación.');
    }

    if (saleData.status === 'cancelled') {
      throw new Error(`La venta ${saleData.correlative || saleId} ya se encuentra anulada.`);
    }

    if (saleData.status === 'refunded' || (saleData.refundedLineIndices?.length || 0) > 0 || Number(saleData.refundedAmount || 0) > 0) {
      throw new Error('Esta venta ya tiene una devolución. Devuelve únicamente las líneas restantes desde el historial.');
    }

    const branchId = saleData.branchId;
    const accountId = saleData.accountId;
    const items: any[] = saleData.items || [];

    const uniqueProductIds = Array.from(
      new Set(
        items
          .map((item: any) => item.productId || item.id)
          .filter((id: any): id is string => Boolean(id))
      )
    );

    const initialProductSnaps = await Promise.all(
      uniqueProductIds.map((pId) => tx.get(doc(db, PRODUCTS_COLLECTION, pId)))
    );

    const productDocMap = new Map<string, { ref: any; snap: any }>();
    uniqueProductIds.forEach((pId, idx) => {
      productDocMap.set(pId, { ref: doc(db, PRODUCTS_COLLECTION, pId), snap: initialProductSnaps[idx] });
    });

    const missingCandidateBases = Array.from(
      new Set(
        uniqueProductIds
          .filter((pId) => {
            const entry = productDocMap.get(pId);
            return (!entry?.snap?.exists() || !entry.snap.data()) && pId.includes('_');
          })
          .map((pId) => pId.split('_')[0])
      )
    ).filter((base) => !productDocMap.has(base));

    if (missingCandidateBases.length > 0) {
      const fallbackSnaps = await Promise.all(
        missingCandidateBases.map((base) => tx.get(doc(db, PRODUCTS_COLLECTION, base)))
      );
      missingCandidateBases.forEach((base, idx) => {
        productDocMap.set(base, { ref: doc(db, PRODUCTS_COLLECTION, base), snap: fallbackSnaps[idx] });
      });
    }

    const preparedItems: Array<{ item: any; productId: string; productRef: any; productSnap: any; stockBranchKey: string }> = [];
    for (const item of items) {
      let productId = item.productId || item.id;
      if (!productId) continue;

      let docEntry = productDocMap.get(productId);
      if ((!docEntry?.snap?.exists() || !docEntry.snap.data()) && productId.includes('_')) {
        const candidateBase = productId.split('_')[0];
        const fallbackEntry = productDocMap.get(candidateBase);
        if (fallbackEntry?.snap?.exists()) {
          productId = candidateBase;
          docEntry = fallbackEntry;
        }
      }

      const productRef = docEntry?.ref || doc(db, PRODUCTS_COLLECTION, productId);
      const productSnap = docEntry?.snap || { exists: () => false, data: () => undefined };
      const productData = productSnap.exists() ? productSnap.data() : undefined;
      const stockBranchKey = item.stockBranchId || legacyStockBranchByProduct.get(productId) ||
        resolveStockBranchKey(productData?.stock, branchId);
      preparedItems.push({ item, productId, productRef, productSnap, stockBranchKey });
    }

    const cashRefundAmount =
      saleData.cashAmount || (saleData.paymentMethod === 'efectivo' ? saleData.total : 0) || 0;
    const sessionRef = saleData.sessionId
      ? doc(db, CASH_SESSIONS_COLLECTION, saleData.sessionId)
      : null;
    const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;
    if (cashRefundAmount > 0 && (!sessionSnap?.exists() || sessionSnap.data()?.status !== 'open')) {
      throw new Error('No se puede devolver efectivo en una caja cerrada. Abre una caja activa y registra la devolución desde el historial.');
    }
    const creditParts = (saleData.payments || []).filter((part: PaymentSplit) => part.category === 'credit');
    const creditAmount = creditParts.length
      ? creditParts.reduce((sum: number, part: PaymentSplit) => sum + (Number(part.amount) || 0), 0)
      : Number(saleData.creditAmount ?? saleData.prepaidCreditAmount ?? saleData.total);
    const isPrepaidCreditSale = saleData.creditMode === 'prepaid' || (saleData.creditMode !== 'receivable' && (
      isPrepaidCreditMethod(String(saleData.paymentMethod || '')) || isPrepaidCreditMethod(String(saleData.paymentMethodId || ''))
    ));
    const isFiadoSale = !isPrepaidCreditSale && (
      saleData.creditMode === 'receivable' || creditParts.length > 0 || saleData.paymentMethod === 'fiado' ||
      saleData.paymentMethod === 'credit' || saleData.paymentCategory === 'credit' || Number(saleData.creditAmount || 0) > 0
    );
    const customerRef = (isFiadoSale || isPrepaidCreditSale) && saleData.customerId
      ? doc(db, CUSTOMERS_COLLECTION, saleData.customerId)
      : null;
    const customerSnap = customerRef ? await tx.get(customerRef) : null;
    const receivableSnapshots = isFiadoSale
      ? await Promise.all(linkedReceivables.docs.map(entry => tx.get(entry.ref))) : [];
    const receivables = receivableSnapshots.filter(entry => entry.exists()).map(entry => ({ ref: entry.ref, data: entry.data()! }));
    if (receivables.some(entry => entry.data.accountId !== accountId || entry.data.saleId !== saleId || entry.data.customerId !== saleData.customerId)) {
      throw new Error('La cuenta por cobrar cambió. Actualiza el historial antes de anular.');
    }


    const cancellationGroups = new Map<string, typeof preparedItems>();
    for (const prepared of preparedItems) {
      const path = prepared.productRef.path || prepared.productId;
      const group = cancellationGroups.get(path) || [];
      group.push(prepared);
      cancellationGroups.set(path, group);
    }
    const cancellationPlans = new Map<string, {
      update: Record<string, any>;
      before: number;
      after: number;
      entries: typeof preparedItems;
    }>();
    for (const [path, group] of cancellationGroups) {
      const first = group[0];
      if (!first.productSnap.exists()) continue;
      const productData = first.productSnap.data();
      const stockMap: Record<string, number> = {
        ...(typeof productData.stock === 'object' && productData.stock !== null ? productData.stock : {}),
      };
      const unitsByBranch = new Map<string, number>();
      for (const entry of group) {
        unitsByBranch.set(entry.stockBranchKey, (unitsByBranch.get(entry.stockBranchKey) || 0) + calculateBaseUnits(entry.item));
      }
      for (const [stockBranchKey, units] of unitsByBranch) {
        stockMap[stockBranchKey] = Math.round((Number(stockMap[stockBranchKey] || 0) + units) * 10000) / 10000;
      }
      const update: Record<string, any> = {
        stock: stockMap,
        branchIds: deriveBranchIds(stockMap),
        lowStockBranches: deriveLowStockBranches(stockMap, productData.reservedStock),
      };
      if (Array.isArray(productData.variants)) {
        const variantUnits = new Map<string, number>();
        for (const entry of group) {
          const variantId = entry.item.variantId || entry.item.variant?.id;
          if (variantId) variantUnits.set(variantId, (variantUnits.get(variantId) || 0) + calculateBaseUnits(entry.item));
        }
        update.variants = productData.variants.map((variant: any) => {
          const units = variantUnits.get(variant.id) || 0;
          if (!units) return variant;
          const variantStock = typeof variant.stock === 'object' && variant.stock !== null
            ? { ...variant.stock }
            : null;
          for (const entry of group) {
            const entryVariantId = entry.item.variantId || entry.item.variant?.id;
            if (entryVariantId !== variant.id) continue;
            const key = entry.stockBranchKey;
            if (variantStock) {
              variantStock[key] = Math.round((Number(variantStock[key] || 0) + calculateBaseUnits(entry.item)) * 10000) / 10000;
            }
          }
          return variantStock
            ? { ...variant, stock: variantStock }
            : { ...variant, stock: Math.round((Number(variant.stock || 0) + units) * 10000) / 10000 };
        });
      }
      cancellationPlans.set(path, { update, before: 0, after: 0, entries: group });
    }

    // 1. Devolver el stock a cada producto y registrar el contra-movimiento en Kardex
    let reversalCount = 0;
    const updatedProducts = new Set<string>();
    const runningStockByProduct = new Map<string, number>();

    for (const { item, productId: pId, productRef, productSnap, stockBranchKey } of preparedItems) {
      if (productSnap.exists()) {
        const pData = productSnap.data();
        const baseUnits = calculateBaseUnits(item);
        const productPath = productRef.path || pId;
        const plan = cancellationPlans.get(productPath)!;
        const cursorKey = `${productPath}:${stockBranchKey}`;
        const currentStock = runningStockByProduct.has(cursorKey)
          ? runningStockByProduct.get(cursorKey)!
          : Number(pData.stock?.[stockBranchKey] || 0);
        const restoredStock = Math.round((currentStock + baseUnits) * 10000) / 10000;
        runningStockByProduct.set(cursorKey, restoredStock);
        if (!updatedProducts.has(productPath)) {
          // NUNCA incluir updatedAt para respetar las reglas de cajero (firestore.rules línea 514)
          tx.update(productRef, plan.update);
          updatedProducts.add(productPath);
        }

        // Registrar entrada por anulación en el Kardex oficial (inventory_movements)
        // Con campos canónicos de Web y alias móviles
        const movementRef = doc(collection(db, INVENTORY_MOVEMENTS_COLLECTION));
        tx.set(movementRef, {
          // Campos canónicos Web
          accountId,
          branchId: stockBranchKey,
          userId: userProfile.uid,
          userName: userProfile.displayName || userProfile.email || 'Usuario',
          userRole: userProfile.role || 'cashier',
          productId: pId,
          productName: item.name,
          productSku: item.sku || pData.sku || '',
          movementType: 'return',
          quantityBefore: currentStock,
          quantityAfter: restoredStock,
          quantityChanged: baseUnits,
          saleId,
          createdAt: serverTimestamp(),
          // Alias móviles para compatibilidad total
          previousStock: currentStock,
          newStock: restoredStock,
          quantity: baseUnits,
          type: 'in',
          reason: 'sale_cancellation',
          referenceId: saleId,
          referenceType: 'sale',
          correlative: saleData.correlative || null,
          notes: reason,
          timestamp: Date.now(),
        });

        reversalCount++;
      }
    }

    // 2. Compensar movimiento en caja si hubo dinero en efectivo
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
    }

    if (sessionRef && sessionSnap?.exists() && sessionSnap.data()?.status === 'open') {
      const sData = sessionSnap.data();
      const sessionPatch: Record<string, any> = {
        auditRevision: (sData.auditRevision || 0) + 1,
      };
      if (cashRefundAmount > 0) {
        sessionPatch.totalExpenses = (sData.totalExpenses || 0) + cashRefundAmount;
        sessionPatch.expectedAmount = (sData.expectedAmount || 0) - cashRefundAmount;
      }
      tx.update(sessionRef, sessionPatch);
    }

    // 3. Revertir deuda por cobrar o devolver créditos prepagados según el método original
    if (customerRef && customerSnap?.exists()) {
      const custData = customerSnap.data();
      const creditReverted = isFiadoSale && receivables.length
        ? receivables.reduce((sum, entry) => sum + Math.max(0, Number(entry.data.currentDebt) || 0), 0)
        : creditAmount;
      if (isPrepaidCreditSale) {
        const currentCredits = Number(custData.credits || 0);
        tx.update(customerRef, {
          credits: Math.round((currentCredits + creditReverted) * 100) / 100,
        });
      } else {
        const currentDebt = Number(custData.currentDebt || 0);
        const revertedDebt = Math.max(0, Math.round((currentDebt - creditReverted) * 100) / 100);
        tx.update(customerRef, {
          currentDebt: revertedDebt,
          lastModified: serverTimestamp(),
        });
      }
    }

    for (const entry of receivables) {
      tx.update(entry.ref, { currentDebt: 0, status: 'cancelled', lastModified: serverTimestamp() });
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
