/**
 * Ventify Mobile - Enterprise Operations Service
 * 
 * Gestión integral de Operaciones Empresariales:
 * 1. Cotizaciones (`quotes` collection)
 * 2. Solicitudes de Venta y Aprobación de Descuentos (`sale_requests` collection)
 * 3. Personal, Colaboradores y Planillas (`users`, `employees`, `payroll_movements` collections)
 * 
 * Soporta atomicidad con transacciones Firestore para egresos de caja chica
 * cuando se registran adelantos o pagos de planilla descontados del mostrador.
 */

import { db, auth } from '@/lib/firebase';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  DocumentData,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'firebase/firestore';
import type { CartItem, Product, Customer } from '@/types';

// ============================================================================
// CONSTANTES DE COLECCIONES
// ============================================================================

export const QUOTES_COLLECTION = 'quotes';
export const SALE_REQUESTS_COLLECTION = 'sale_requests';
export const USERS_COLLECTION = 'users';
export const EMPLOYEES_COLLECTION = 'employees';
export const PAYROLL_MOVEMENTS_COLLECTION = 'payroll_movements';
export const CASH_SESSIONS_COLLECTION = 'cash_register_sessions';
export const CASH_MOVEMENTS_COLLECTION = 'cash_register_movements';

// ============================================================================
// TIPOS E INTERFACES: COTIZACIONES
// ============================================================================

export type QuoteStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'converted';

export interface QuoteItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  sku: string;
  originalPrice?: number;
  modifiedPrice?: number;
  priceModifiedBy?: string;
  priceModificationReason?: string;
  minSalePrice?: number;
  suggestedPrice?: number;
  category?: string;
  costPrice?: number;
  margin?: number;
  marginPercent?: number;
  imageUrl?: string;
  hint?: string;
  isGift?: boolean;
  variantId?: string;
  variantName?: string;
  presentationId?: string;
  presentationName?: string;
  presentationQty?: number;
  stock?: Record<string, number>;
}

export interface Quote {
  id: string;
  quoteNumber: number;
  formattedNumber: string;
  date: number;
  expiryDate: number;
  validityDays: number;
  items: QuoteItem[];
  subtotal: number;
  tax: number;
  total: number;
  status: QuoteStatus;
  branchId: string;
  branchName?: string;
  accountId: string;
  createdBy: string;
  createdByName?: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  customerDni?: string;
  customerRuc?: string;
  customerAddress?: string;
  notes?: string;
  termsAndConditions?: string;
  currency: string;
  convertedToSaleId?: string;
  convertedAt?: number;
  source?: 'pos' | 'dashboard' | 'mobile';
  createdAt?: any;
  updatedAt?: any;
}

export interface QuoteFilterOptions {
  branchId?: string;
  status?: QuoteStatus | 'all';
  searchQuery?: string;
  startDate?: number;
  endDate?: number;
}

export interface CreateQuoteInput {
  accountId: string;
  branchId: string;
  branchName?: string;
  items: QuoteItem[];
  subtotal: number;
  tax?: number;
  total: number;
  customerName: string;
  customerId?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerDni?: string;
  customerRuc?: string;
  customerAddress?: string;
  validityDays?: number;
  notes?: string;
  termsAndConditions?: string;
  currency?: string;
  source?: 'pos' | 'dashboard' | 'mobile';
  createdBy?: string;
  createdByName?: string;
}

// ============================================================================
// TIPOS E INTERFACES: SOLICITUDES DE VENTA
// ============================================================================

export type SaleRequestStatus = 'pending' | 'approved' | 'rejected' | 'converted';

export interface SaleRequestItem {
  productId: string;
  productName: string;
  sku?: string;
  quantity: number;
  originalPrice: number;
  requestedPrice: number;
  subtotal: number;
  discountAmount?: number;
  discountPercent?: number;
  variantId?: string;
  variantName?: string;
  presentationId?: string;
  presentationName?: string;
  imageUrl?: string;
}

export interface SaleRequest {
  id: string;
  requestNumber: string;
  accountId: string;
  branchId: string;
  branchName?: string;
  sellerId: string;
  sellerName: string;
  sellerEmail?: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  items: SaleRequestItem[];
  subtotal: number;
  discountTotal: number;
  total: number;
  reason?: string;
  notes?: string;
  status: SaleRequestStatus;
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
  reviewerName?: string;
  reviewNotes?: string;
  convertedSaleId?: string;
  convertedAt?: number;
}

export interface CreateSaleRequestInput {
  accountId: string;
  branchId: string;
  branchName?: string;
  sellerId: string;
  sellerName: string;
  sellerEmail?: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  items: SaleRequestItem[];
  subtotal: number;
  discountTotal?: number;
  total: number;
  reason?: string;
  notes?: string;
}

// ============================================================================
// TIPOS E INTERFACES: PERSONAL Y PLANILLAS
// ============================================================================

export type TeamRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'seller';

export interface TeamMember {
  id: string;
  uid?: string;
  name: string;
  displayName?: string;
  email: string;
  phone?: string;
  role: TeamRole;
  roleLabel: string;
  branchId?: string;
  branchName?: string;
  accountId: string;
  isActive: boolean;
  baseSalary?: number;
  dni?: string;
  photoURL?: string;
  createdAt?: number;
  lastLogin?: number;
}

export type PayrollConceptType = 'advance' | 'salary' | 'bonus' | 'commission';

export interface PayrollMovement {
  id: string;
  accountId: string;
  branchId: string;
  branchName?: string;
  employeeId: string;
  employeeName: string;
  employeeRole?: string;
  amount: number;
  conceptType: PayrollConceptType;
  conceptLabel: string;
  paymentMethod: string;
  notes?: string;
  deductFromCashDrawer: boolean;
  sessionId?: string | null;
  cashMovementId?: string | null;
  createdBy: string;
  createdByName: string;
  date: number;
  createdAt?: any;
}

export interface RegisterPayrollPaymentParams {
  accountId: string;
  branchId: string;
  branchName?: string;
  sessionId?: string | null;
  employeeId: string;
  employeeName: string;
  employeeRole?: string;
  amount: number;
  conceptType: PayrollConceptType;
  paymentMethod: string;
  notes?: string;
  deductFromCashDrawer: boolean;
  userProfile?: {
    uid?: string;
    displayName?: string | null;
    email?: string | null;
  } | null;
}

export interface RegisterPayrollPaymentResult {
  payrollMovementId: string;
  cashMovementId?: string;
  deductedFromCash: boolean;
  amount: number;
}

// ============================================================================
// HELPERS INTERNOS DE CONVERSIÓN Y NORMALIZACIÓN
// ============================================================================

const toMillis = (val: any): number => {
  if (!val) return Date.now();
  if (typeof val === 'number') return val;
  if (val.toMillis && typeof val.toMillis === 'function') return val.toMillis();
  if (val.seconds) return val.seconds * 1000;
  if (val._seconds) return val._seconds * 1000;
  const parsed = new Date(val).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
};

const getRoleDisplay = (role: string): string => {
  switch (role) {
    case 'owner':
      return 'Propietario';
    case 'admin':
      return 'Administrador';
    case 'manager':
      return 'Gerente de Sede';
    case 'cashier':
      return 'Cajero POS';
    case 'seller':
      return 'Vendedor de Piso';
    default:
      return 'Colaborador';
  }
};

const getConceptDisplay = (type: PayrollConceptType): string => {
  switch (type) {
    case 'advance':
      return 'Adelanto de Sueldo';
    case 'salary':
      return 'Pago de Sueldo';
    case 'bonus':
      return 'Bono o Gratificación';
    case 'commission':
      return 'Comisión por Ventas';
    default:
      return 'Remuneración';
  }
};

export const quoteFromDoc = (docSnap: QueryDocumentSnapshot<DocumentData>): Quote => {
  const data = docSnap.data();
  const date = toMillis(data.date || data.createdAt);
  const validityDays = Number(data.validityDays) || 15;
  const expiryDate = data.expiryDate ? toMillis(data.expiryDate) : date + validityDays * 24 * 60 * 60 * 1000;

  const quoteNum = data.quoteNumber || parseInt(docSnap.id.slice(-6), 16) || 1001;
  const formattedNumber = data.formattedNumber || `COT-${String(quoteNum).padStart(5, '0')}`;

  return {
    id: docSnap.id,
    quoteNumber: quoteNum,
    formattedNumber,
    date,
    expiryDate,
    validityDays,
    items: Array.isArray(data.items) ? data.items : [],
    subtotal: Number(data.subtotal) || Number(data.total) || 0,
    tax: Number(data.tax) || 0,
    total: Number(data.total) || 0,
    status: (data.status as QuoteStatus) || 'pending',
    branchId: data.branchId || '',
    branchName: data.branchName || '',
    accountId: data.accountId || '',
    createdBy: data.createdBy || '',
    createdByName: data.createdByName || 'Usuario',
    customerId: data.customerId || '',
    customerName: data.customerName || 'Cliente General',
    customerPhone: data.customerPhone || '',
    customerEmail: data.customerEmail || '',
    customerDni: data.customerDni || '',
    customerRuc: data.customerRuc || '',
    customerAddress: data.customerAddress || '',
    notes: data.notes || '',
    termsAndConditions: data.termsAndConditions || 'Precios válidos según vigencia estipulada.',
    currency: data.currency || 'PEN',
    convertedToSaleId: data.convertedToSaleId || undefined,
    convertedAt: data.convertedAt ? toMillis(data.convertedAt) : undefined,
    source: data.source || 'pos',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
};

export const saleRequestFromDoc = (docSnap: QueryDocumentSnapshot<DocumentData>): SaleRequest => {
  const data = docSnap.data();
  const createdAt = toMillis(data.createdAt || data.date);

  return {
    id: docSnap.id,
    requestNumber: data.requestNumber || `SOL-${docSnap.id.slice(-4).toUpperCase()}`,
    accountId: data.accountId || '',
    branchId: data.branchId || '',
    branchName: data.branchName || '',
    sellerId: data.sellerId || data.createdBy || '',
    sellerName: data.sellerName || data.createdByName || 'Vendedor',
    sellerEmail: data.sellerEmail || '',
    customerId: data.customerId || '',
    customerName: data.customerName || 'Cliente General',
    customerPhone: data.customerPhone || '',
    customerEmail: data.customerEmail || '',
    items: Array.isArray(data.items) ? data.items : [],
    subtotal: Number(data.subtotal) || Number(data.total) || 0,
    discountTotal: Number(data.discountTotal) || Number(data.discount) || 0,
    total: Number(data.total) || 0,
    reason: data.reason || data.notes || '',
    notes: data.notes || '',
    status: (data.status as SaleRequestStatus) || 'pending',
    createdAt,
    reviewedAt: data.reviewedAt ? toMillis(data.reviewedAt) : undefined,
    reviewedBy: data.reviewedBy || undefined,
    reviewerName: data.reviewerName || undefined,
    reviewNotes: data.reviewNotes || undefined,
    convertedSaleId: data.convertedSaleId || undefined,
    convertedAt: data.convertedAt ? toMillis(data.convertedAt) : undefined,
  };
};

// ============================================================================
// 1. SERVICIOS DE COTIZACIONES (QUOTES)
// ============================================================================

/**
 * Obtiene el listado de cotizaciones emitidas para la cuenta y/o sucursal
 */
export const getQuotes = async (
  accountId: string,
  branchId?: string,
  filters?: QuoteFilterOptions
): Promise<Quote[]> => {
  if (!accountId) return [];

  try {
    const coll = collection(db, QUOTES_COLLECTION);
    let q = query(coll, where('accountId', '==', accountId));

    const effectiveBranch = filters?.branchId || branchId;
    if (effectiveBranch && effectiveBranch !== 'all' && effectiveBranch !== 'main') {
      q = query(q, where('branchId', '==', effectiveBranch));
    }

    if (filters?.status && filters.status !== 'all') {
      q = query(q, where('status', '==', filters.status));
    }

    const snapshot = await getDocs(q);
    let quotes = snapshot.docs.map(quoteFromDoc);

    // Filtrado en memoria por texto (cliente, número, teléfono)
    if (filters?.searchQuery && filters.searchQuery.trim()) {
      const term = filters.searchQuery.toLowerCase().trim();
      quotes = quotes.filter((q) =>
        q.customerName.toLowerCase().includes(term) ||
        q.formattedNumber.toLowerCase().includes(term) ||
        (q.customerDni && q.customerDni.includes(term)) ||
        (q.customerRuc && q.customerRuc.includes(term)) ||
        (q.customerPhone && q.customerPhone.includes(term)) ||
        q.items.some((it) => it.name.toLowerCase().includes(term))
      );
    }

    // Filtrado por rango de fechas
    if (filters?.startDate) {
      quotes = quotes.filter((q) => q.date >= filters.startDate!);
    }
    if (filters?.endDate) {
      quotes = quotes.filter((q) => q.date <= filters.endDate!);
    }

    // Ordenar de más reciente a más antiguo
    quotes.sort((a, b) => b.date - a.date);
    return quotes;
  } catch (error) {
    console.error('[EnterpriseOps] Error al obtener cotizaciones:', error);
    return [];
  }
};

/**
 * Suscripción reactiva en tiempo real a las cotizaciones
 */
export const subscribeToQuotes = (
  accountId: string,
  callback: (quotes: Quote[]) => void,
  branchId?: string,
  onError?: (err: any) => void
): (() => void) => {
  if (!accountId) {
    callback([]);
    return () => {};
  }

  try {
    const coll = collection(db, QUOTES_COLLECTION);
    let q = query(coll, where('accountId', '==', accountId));

    if (branchId && branchId !== 'all' && branchId !== 'main') {
      q = query(q, where('branchId', '==', branchId));
    }

    // Techo prudente de lecturas
    q = query(q, orderBy('createdAt', 'desc'), limit(150));

    return onSnapshot(
      q,
      (snapshot: QuerySnapshot<DocumentData>) => {
        const quotes = snapshot.docs.map(quoteFromDoc);
        quotes.sort((a, b) => b.date - a.date);
        callback(quotes);
      },
      (error) => {
        console.warn('[EnterpriseOps] Error en suscripción a cotizaciones:', error);
        onError?.(error);
        callback([]);
      }
    );
  } catch (error) {
    console.error('[EnterpriseOps] Error configurando suscripción a cotizaciones:', error);
    return () => {};
  }
};

/**
 * Obtiene una cotización individual por su ID
 */
export const getQuoteById = async (quoteId: string): Promise<Quote | null> => {
  if (!quoteId) return null;
  try {
    const ref = doc(db, QUOTES_COLLECTION, quoteId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return quoteFromDoc(snap as QueryDocumentSnapshot<DocumentData>);
  } catch (error) {
    console.error(`[EnterpriseOps] Error al obtener cotización ${quoteId}:`, error);
    return null;
  }
};

/**
 * Crea una nueva cotización en Firestore
 */
export const createQuote = async (input: CreateQuoteInput): Promise<Quote> => {
  const { accountId, branchId, total } = input;
  if (!accountId || !branchId) {
    throw new Error('Cuenta y sucursal requeridas para crear cotización.');
  }

  const now = Date.now();
  const validityDays = input.validityDays && input.validityDays > 0 ? input.validityDays : 15;
  const expiryDate = now + validityDays * 24 * 60 * 60 * 1000;
  const quoteNumber = parseInt(now.toString().slice(-5), 10);
  const formattedNumber = `COT-${String(quoteNumber).padStart(5, '0')}`;

  const currentUser = auth.currentUser;
  const payload: any = {
    quoteNumber,
    formattedNumber,
    date: now,
    expiryDate,
    validityDays,
    items: input.items || [],
    subtotal: Math.round(input.subtotal * 100) / 100,
    tax: Math.round((input.tax || 0) * 100) / 100,
    total: Math.round(total * 100) / 100,
    status: 'pending' as QuoteStatus,
    branchId,
    branchName: input.branchName || '',
    accountId,
    createdBy: input.createdBy || currentUser?.uid || '',
    createdByName: input.createdByName || currentUser?.displayName || 'Usuario',
    customerId: input.customerId || null,
    customerName: (input.customerName || 'Cliente General').trim(),
    customerPhone: input.customerPhone || null,
    customerEmail: input.customerEmail || null,
    customerDni: input.customerDni || null,
    customerRuc: input.customerRuc || null,
    customerAddress: input.customerAddress || null,
    notes: input.notes || '',
    termsAndConditions: input.termsAndConditions || 'Precios válidos durante el período de vigencia de la cotización.',
    currency: input.currency || 'PEN',
    source: input.source || 'mobile',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  // Limpieza de campos undefined
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  const docRef = await addDoc(collection(db, QUOTES_COLLECTION), payload);
  return {
    id: docRef.id,
    ...payload,
  } as Quote;
};

/**
 * Actualiza el estado de una cotización ('pending' | 'accepted' | 'rejected' | 'converted')
 */
export const updateQuoteStatus = async (
  quoteId: string,
  status: 'pending' | 'accepted' | 'rejected' | 'converted',
  convertedSaleId?: string
): Promise<void> => {
  if (!quoteId) throw new Error('ID de cotización requerido');

  const ref = doc(db, QUOTES_COLLECTION, quoteId);
  const updatePayload: Record<string, any> = {
    status,
    updatedAt: serverTimestamp(),
  };

  if (status === 'converted' && convertedSaleId) {
    updatePayload.convertedToSaleId = convertedSaleId;
    updatePayload.convertedAt = Date.now();
  }

  await updateDoc(ref, updatePayload);
};

/**
 * Elimina una cotización
 */
export const deleteQuote = async (quoteId: string): Promise<void> => {
  if (!quoteId) throw new Error('ID de cotización requerido para eliminar');
  const ref = doc(db, QUOTES_COLLECTION, quoteId);
  await deleteDoc(ref);
};

/**
 * Marca la cotización como convertida a venta
 */
export const convertQuoteToSale = async (quoteId: string, saleId: string): Promise<void> => {
  return updateQuoteStatus(quoteId, 'converted', saleId);
};

// ============================================================================
// 2. SERVICIOS DE SOLICITUDES DE VENTA Y DESCUENTO (SALE REQUESTS)
// ============================================================================

/**
 * Obtiene las solicitudes de venta enviadas por los vendedores de piso
 */
export const getSaleRequests = async (
  accountId: string,
  branchId?: string,
  status?: SaleRequestStatus | 'all'
): Promise<SaleRequest[]> => {
  if (!accountId) return [];

  try {
    const coll = collection(db, SALE_REQUESTS_COLLECTION);
    let q = query(coll, where('accountId', '==', accountId));

    if (branchId && branchId !== 'all' && branchId !== 'main') {
      q = query(q, where('branchId', '==', branchId));
    }

    if (status && status !== 'all') {
      q = query(q, where('status', '==', status));
    }

    const snapshot = await getDocs(q);
    const requests = snapshot.docs.map(saleRequestFromDoc);
    requests.sort((a, b) => b.createdAt - a.createdAt);
    return requests;
  } catch (error) {
    console.error('[EnterpriseOps] Error al obtener solicitudes de venta:', error);
    return [];
  }
};

/**
 * Suscripción reactiva a solicitudes de venta
 */
export const subscribeToSaleRequests = (
  accountId: string,
  callback: (requests: SaleRequest[]) => void,
  branchId?: string
): (() => void) => {
  if (!accountId) {
    callback([]);
    return () => {};
  }

  try {
    const coll = collection(db, SALE_REQUESTS_COLLECTION);
    let q = query(coll, where('accountId', '==', accountId));

    if (branchId && branchId !== 'all' && branchId !== 'main') {
      q = query(q, where('branchId', '==', branchId));
    }

    q = query(q, orderBy('createdAt', 'desc'), limit(100));

    return onSnapshot(
      q,
      (snapshot: QuerySnapshot<DocumentData>) => {
        const requests = snapshot.docs.map(saleRequestFromDoc);
        callback(requests);
      },
      (error) => {
        console.warn('[EnterpriseOps] Error en suscripción a solicitudes de venta:', error);
        callback([]);
      }
    );
  } catch (error) {
    console.error('[EnterpriseOps] Error en subscribeToSaleRequests:', error);
    return () => {};
  }
};

/**
 * Resuelve una solicitud de venta: el Administrador o Cajero aprueba o rechaza el descuento
 */
export const resolveSaleRequest = async (
  requestId: string,
  status: 'approved' | 'rejected',
  reviewerProfile?: { uid?: string; displayName?: string | null; role?: string; email?: string | null } | null,
  notes?: string
): Promise<void> => {
  if (!requestId) throw new Error('ID de solicitud requerido');

  const ref = doc(db, SALE_REQUESTS_COLLECTION, requestId);
  const currentUser = auth.currentUser;

  const updateData: any = {
    status,
    reviewedAt: Date.now(),
    reviewedBy: reviewerProfile?.uid || currentUser?.uid || '',
    reviewerName: reviewerProfile?.displayName || currentUser?.displayName || currentUser?.email || 'Administrador',
    reviewNotes: notes || '',
    updatedAt: serverTimestamp(),
  };

  await updateDoc(ref, updateData);
};

/**
 * Registra una nueva solicitud de venta enviada por un vendedor
 */
export const createSaleRequest = async (input: CreateSaleRequestInput): Promise<SaleRequest> => {
  const { accountId, branchId, total } = input;
  if (!accountId || !branchId) {
    throw new Error('Cuenta y sucursal requeridas para crear solicitud de venta.');
  }

  const now = Date.now();
  const requestNumber = `SOL-${Math.floor(1000 + Math.random() * 9000)}`;

  const payload: any = {
    requestNumber,
    accountId,
    branchId,
    branchName: input.branchName || '',
    sellerId: input.sellerId,
    sellerName: input.sellerName,
    sellerEmail: input.sellerEmail || '',
    customerId: input.customerId || null,
    customerName: (input.customerName || 'Cliente General').trim(),
    customerPhone: input.customerPhone || null,
    customerEmail: input.customerEmail || null,
    items: input.items || [],
    subtotal: Math.round(input.subtotal * 100) / 100,
    discountTotal: Math.round((input.discountTotal || 0) * 100) / 100,
    total: Math.round(total * 100) / 100,
    reason: input.reason || '',
    notes: input.notes || '',
    status: 'pending' as SaleRequestStatus,
    createdAt: now,
    serverCreatedAt: serverTimestamp(),
  };

  // Limpiar undefined
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined) delete payload[k];
  });

  const ref = await addDoc(collection(db, SALE_REQUESTS_COLLECTION), payload);
  return {
    id: ref.id,
    ...payload,
  };
};

/**
 * Marca una solicitud de venta como convertida a venta real en el POS
 */
export const markSaleRequestAsConverted = async (
  requestId: string,
  saleId: string
): Promise<void> => {
  const ref = doc(db, SALE_REQUESTS_COLLECTION, requestId);
  await updateDoc(ref, {
    status: 'converted',
    convertedSaleId: saleId,
    convertedAt: Date.now(),
    updatedAt: serverTimestamp(),
  });
};

// ============================================================================
// 3. PERSONAL, COLABORADORES Y PLANILLAS (USERS & PAYROLL)
// ============================================================================

/**
 * Obtiene la lista completa de colaboradores/usuarios del negocio
 */
export const getTeamMembers = async (accountId: string): Promise<TeamMember[]> => {
  if (!accountId) return [];

  try {
    const qUsers = query(collection(db, USERS_COLLECTION), where('accountId', '==', accountId));
    const snapshot = await getDocs(qUsers);

    const members: TeamMember[] = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      const rawRole = (data.role || 'seller') as TeamRole;

      return {
        id: docSnap.id,
        uid: data.uid || docSnap.id,
        name: data.name || data.displayName || data.email || 'Colaborador',
        displayName: data.displayName || data.name || '',
        email: data.email || '',
        phone: data.phone || '',
        role: rawRole,
        roleLabel: getRoleDisplay(rawRole),
        branchId: data.branchId || undefined,
        branchName: data.branchName || undefined,
        accountId: data.accountId || accountId,
        isActive: data.isActive !== false,
        baseSalary: typeof data.baseSalary === 'number' ? data.baseSalary : undefined,
        dni: data.dni || '',
        photoURL: data.photoURL || undefined,
        createdAt: toMillis(data.createdAt),
        lastLogin: data.lastLogin ? toMillis(data.lastLogin) : undefined,
      };
    });

    // Ordenar: primero roles de mayor jerarquía y activos
    const rolePriority: Record<string, number> = {
      owner: 1,
      admin: 2,
      manager: 3,
      cashier: 4,
      seller: 5,
    };

    members.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      const rankA = rolePriority[a.role] || 99;
      const rankB = rolePriority[b.role] || 99;
      return rankA - rankB;
    });

    return members;
  } catch (error) {
    console.error('[EnterpriseOps] Error al obtener colaboradores:', error);
    return [];
  }
};

/**
 * Suscripción en tiempo real a los colaboradores de la cuenta
 */
export const subscribeToTeamMembers = (
  accountId: string,
  callback: (members: TeamMember[]) => void
): (() => void) => {
  if (!accountId) {
    callback([]);
    return () => {};
  }

  try {
    const qUsers = query(collection(db, USERS_COLLECTION), where('accountId', '==', accountId));
    return onSnapshot(
      qUsers,
      (snapshot) => {
        const members: TeamMember[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          const rawRole = (data.role || 'seller') as TeamRole;
          return {
            id: docSnap.id,
            uid: data.uid || docSnap.id,
            name: data.name || data.displayName || data.email || 'Colaborador',
            displayName: data.displayName || data.name || '',
            email: data.email || '',
            phone: data.phone || '',
            role: rawRole,
            roleLabel: getRoleDisplay(rawRole),
            branchId: data.branchId || undefined,
            branchName: data.branchName || undefined,
            accountId: data.accountId || accountId,
            isActive: data.isActive !== false,
            baseSalary: typeof data.baseSalary === 'number' ? data.baseSalary : undefined,
            dni: data.dni || '',
            photoURL: data.photoURL || undefined,
            createdAt: toMillis(data.createdAt),
          };
        });

        const rolePriority: Record<string, number> = {
          owner: 1,
          admin: 2,
          manager: 3,
          cashier: 4,
          seller: 5,
        };
        members.sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          return (rolePriority[a.role] || 99) - (rolePriority[b.role] || 99);
        });

        callback(members);
      },
      (err) => {
        console.warn('[EnterpriseOps] Error en subscribeToTeamMembers:', err);
        callback([]);
      }
    );
  } catch (error) {
    console.error('[EnterpriseOps] Error configurando subscribeToTeamMembers:', error);
    return () => {};
  }
};

/**
 * Obtiene el historial de movimientos de planilla (adelantos, sueldos, bonos, comisiones)
 */
export const getPayrollMovements = async (
  accountId: string,
  branchId?: string
): Promise<PayrollMovement[]> => {
  if (!accountId) return [];

  try {
    const coll = collection(db, PAYROLL_MOVEMENTS_COLLECTION);
    let q = query(coll, where('accountId', '==', accountId));

    if (branchId && branchId !== 'all' && branchId !== 'main') {
      q = query(q, where('branchId', '==', branchId));
    }

    const snapshot = await getDocs(q);
    const movements: PayrollMovement[] = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      const rawConcept = (data.conceptType || 'advance') as PayrollConceptType;
      return {
        id: docSnap.id,
        accountId: data.accountId || accountId,
        branchId: data.branchId || '',
        branchName: data.branchName || '',
        employeeId: data.employeeId || '',
        employeeName: data.employeeName || 'Colaborador',
        employeeRole: data.employeeRole || '',
        amount: Math.abs(Number(data.amount) || 0),
        conceptType: rawConcept,
        conceptLabel: getConceptDisplay(rawConcept),
        paymentMethod: data.paymentMethod || 'Efectivo',
        notes: data.notes || '',
        deductFromCashDrawer: Boolean(data.deductFromCashDrawer),
        sessionId: data.sessionId || null,
        cashMovementId: data.cashMovementId || null,
        createdBy: data.createdBy || '',
        createdByName: data.createdByName || 'Usuario',
        date: toMillis(data.date || data.createdAt),
        createdAt: data.createdAt,
      };
    });

    movements.sort((a, b) => b.date - a.date);
    return movements;
  } catch (error) {
    console.error('[EnterpriseOps] Error al obtener movimientos de planilla:', error);
    return [];
  }
};

/**
 * Suscripción reactiva a movimientos de planilla
 */
export const subscribeToPayrollMovements = (
  accountId: string,
  callback: (movements: PayrollMovement[]) => void,
  branchId?: string
): (() => void) => {
  if (!accountId) {
    callback([]);
    return () => {};
  }

  try {
    const coll = collection(db, PAYROLL_MOVEMENTS_COLLECTION);
    let q = query(coll, where('accountId', '==', accountId));

    if (branchId && branchId !== 'all' && branchId !== 'main') {
      q = query(q, where('branchId', '==', branchId));
    }

    q = query(q, orderBy('date', 'desc'), limit(150));

    return onSnapshot(
      q,
      (snapshot) => {
        const movements: PayrollMovement[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          const rawConcept = (data.conceptType || 'advance') as PayrollConceptType;
          return {
            id: docSnap.id,
            accountId: data.accountId || accountId,
            branchId: data.branchId || '',
            branchName: data.branchName || '',
            employeeId: data.employeeId || '',
            employeeName: data.employeeName || 'Colaborador',
            employeeRole: data.employeeRole || '',
            amount: Math.abs(Number(data.amount) || 0),
            conceptType: rawConcept,
            conceptLabel: getConceptDisplay(rawConcept),
            paymentMethod: data.paymentMethod || 'Efectivo',
            notes: data.notes || '',
            deductFromCashDrawer: Boolean(data.deductFromCashDrawer),
            sessionId: data.sessionId || null,
            cashMovementId: data.cashMovementId || null,
            createdBy: data.createdBy || '',
            createdByName: data.createdByName || 'Usuario',
            date: toMillis(data.date || data.createdAt),
          };
        });
        callback(movements);
      },
      (error) => {
        console.warn('[EnterpriseOps] Error en subscribeToPayrollMovements:', error);
        callback([]);
      }
    );
  } catch (error) {
    console.error('[EnterpriseOps] Error al configurar subscribeToPayrollMovements:', error);
    return () => {};
  }
};

/**
 * Registra un pago de planilla o adelanto de sueldo.
 * 
 * Si `deductFromCashDrawer` es `true` y `sessionId` existe:
 * - Realiza una transacción Firestore atómica que:
 *   1. Crea el egreso en `cash_register_movements` con `type: 'expense'`,
 *      `category: 'payroll_advance'`, `isEmployeeAdvance: true`, `employeeId`.
 *   2. Descuenta del `expectedAmount` e incrementa `totalExpenses` en la sesión de caja activa.
 *   3. Inserta el registro en `payroll_movements` vinculando el `cashMovementId`.
 */
export const registerPayrollPayment = async (
  params: RegisterPayrollPaymentParams
): Promise<RegisterPayrollPaymentResult> => {
  const {
    accountId,
    branchId,
    branchName,
    sessionId,
    employeeId,
    employeeName,
    employeeRole,
    amount,
    conceptType,
    paymentMethod,
    notes,
    deductFromCashDrawer,
    userProfile,
  } = params;

  if (!accountId || !branchId || !employeeId) {
    throw new Error('Parámetros de cuenta, sucursal y colaborador requeridos.');
  }

  if (typeof amount !== 'number' || amount <= 0 || isNaN(amount)) {
    throw new Error('El monto de remuneración debe ser mayor a cero.');
  }

  const currentUser = auth.currentUser;
  const currentUserId = userProfile?.uid || currentUser?.uid || '';
  const currentUserName = userProfile?.displayName || currentUser?.displayName || currentUser?.email || 'Usuario';
  const normalizedAmount = Math.round(amount * 100) / 100;
  const now = Date.now();
  const conceptName = getConceptDisplay(conceptType);

  const payrollDocRef = doc(collection(db, PAYROLL_MOVEMENTS_COLLECTION));
  const payrollMovementId = payrollDocRef.id;

  // CASO 1: Descuento atómico de la Caja Chica Activa
  if (deductFromCashDrawer && sessionId) {
    const sessionRef = doc(db, CASH_SESSIONS_COLLECTION, sessionId);
    const cashMovementRef = doc(collection(db, CASH_MOVEMENTS_COLLECTION));
    const cashMovementId = cashMovementRef.id;

    await runTransaction(db, async (tx) => {
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists()) {
        throw new Error(`La sesión de caja "${sessionId}" no existe o fue cerrada.`);
      }

      const sData = sessionSnap.data();
      if (sData.status !== 'open') {
        throw new Error('La sesión de caja se encuentra cerrada. No se pueden deducir adelantos en efectivo.');
      }

      const currentExpected = sData.expectedAmount || sData.initialAmount || 0;
      const currentExpenses = sData.totalExpenses || 0;
      const newExpected = Math.round((currentExpected - normalizedAmount) * 100) / 100;
      const newExpenses = Math.round((currentExpenses + normalizedAmount) * 100) / 100;

      // 1. Insertar movimiento en cash_register_movements
      const cashMovementPayload = {
        id: cashMovementId,
        sessionId,
        accountId,
        branchId,
        type: 'expense' as const,
        category: 'payroll_advance',
        isEmployeeAdvance: true,
        employeeId,
        employeeName,
        amount: -normalizedAmount, // Egreso negativo en flujo de caja
        description: `${conceptName}: ${employeeName}${notes ? ` - ${notes}` : ''}`,
        paymentMethod: paymentMethod || 'Efectivo',
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: serverTimestamp(),
      };
      tx.set(cashMovementRef, cashMovementPayload);

      // 2. Actualizar sesión de caja
      tx.update(sessionRef, {
        expectedAmount: newExpected,
        totalExpenses: newExpenses,
        updatedAt: serverTimestamp(),
      });

      // 3. Insertar registro en payroll_movements
      const payrollPayload = {
        id: payrollMovementId,
        accountId,
        branchId,
        branchName: branchName || '',
        employeeId,
        employeeName,
        employeeRole: employeeRole || '',
        amount: normalizedAmount,
        conceptType,
        paymentMethod: paymentMethod || 'Efectivo',
        notes: notes || '',
        deductFromCashDrawer: true,
        sessionId,
        cashMovementId,
        createdBy: currentUserId,
        createdByName: currentUserName,
        date: now,
        createdAt: serverTimestamp(),
      };
      tx.set(payrollDocRef, payrollPayload);
    });

    return {
      payrollMovementId,
      cashMovementId,
      deductedFromCash: true,
      amount: normalizedAmount,
    };
  }

  // CASO 2: Pago sin deducción de caja (ej. transferencia bancaria externa, depósito)
  const payrollPayload = {
    id: payrollMovementId,
    accountId,
    branchId,
    branchName: branchName || '',
    employeeId,
    employeeName,
    employeeRole: employeeRole || '',
    amount: normalizedAmount,
    conceptType,
    paymentMethod: paymentMethod || 'Transferencia',
    notes: notes || '',
    deductFromCashDrawer: false,
    sessionId: null,
    cashMovementId: null,
    createdBy: currentUserId,
    createdByName: currentUserName,
    date: now,
    createdAt: serverTimestamp(),
  };

  await setDoc(payrollDocRef, payrollPayload);

  return {
    payrollMovementId,
    deductedFromCash: false,
    amount: normalizedAmount,
  };
};

export default {
  // Cotizaciones
  getQuotes,
  subscribeToQuotes,
  getQuoteById,
  createQuote,
  updateQuoteStatus,
  deleteQuote,
  convertQuoteToSale,
  // Solicitudes de venta
  getSaleRequests,
  subscribeToSaleRequests,
  resolveSaleRequest,
  createSaleRequest,
  markSaleRequestAsConverted,
  // Personal y planillas
  getTeamMembers,
  subscribeToTeamMembers,
  getPayrollMovements,
  subscribeToPayrollMovements,
  registerPayrollPayment,
};
