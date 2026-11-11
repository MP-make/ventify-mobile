/**
 * Ventify Mobile Core Types
 * Complete, unified TypeScript declarations for Ventify POS & Mobile
 */

// ============================================================================
// 1. PRODUCT & PRICING TYPES
// ============================================================================

/** Supported Units of Measure */
export type UnitOfMeasure =
  | 'unit'
  | 'kg'
  | 'g'
  | 'm'
  | 'cm'
  | 'lt'
  | 'ml'
  | 'pack'
  | 'box'
  | 'other'
  | 'NIU'
  | 'KGM'
  | 'GRM'
  | 'LTR'
  | 'MTR'
  | 'BX';

/** Product Attribute (e.g. material, dimensions) */
export interface ProductAttribute {
  name: string;
  value: string;
}

/** Product Presentation (e.g., box x20, pack x6) */
export interface ProductPresentation {
  /** Unique presentation ID */
  id: string;
  /** Visible label (e.g., "Caja x20", "Pack x6") */
  name: string;
  /** Barcode for scanner guns / camera */
  barcode?: string;
  /** Units of base stock consumed when selling 1 presentation */
  conversionFactor: number;
  /** Alias for conversionFactor for backward compatibility */
  quantity?: number;
  /** Retail price of the complete presentation */
  price: number;
  /** Minimum floor price for this presentation */
  minSalePrice?: number;
  /** Whether this presentation is active */
  active?: boolean;
}

/** Product Variant (e.g. colors, sizes, versions) */
export interface ProductVariant {
  /** Unique variant ID */
  id: string;
  /** Display name (e.g. "Rojo", "Azul neón") */
  name: string;
  /** Specific variant SKU */
  sku?: string;
  /** Variant specific barcode */
  barcode?: string;
  /** Direct sale price (or base price if not adjusted) */
  price?: number;
  /** Price adjustment compared to base product (+ or -) */
  priceAdjustment?: number;
  /** Physical stock per branch: { branchId: quantity } */
  stock: Record<string, number>;
  /** Hex color for swatch UI (e.g. "#EF4444") */
  colorHex?: string;
  /** Variant specific image URLs */
  images?: string[];
  /** Size label (e.g. "M", "42") */
  sizeLabel?: string;
}

/** Tiered Price (Volumen / Escala de precios) */
export interface PriceTier {
  /** Minimum quantity required for tier */
  minQuantity: number;
  /** Unit price applied from minQuantity */
  unitPrice: number;
  /** Alias for minQuantity for backward compatibility */
  minQty?: number;
  /** Alias for unitPrice for backward compatibility */
  price?: number;
}

/** Branch Price Configuration Override */
export interface BranchPriceConfig {
  suggestedPrice?: number;
  costPrice?: number;
  minSalePrice?: number;
  priceTiers?: PriceTier[];
  presentations?: ProductPresentation[];
}

/** Main Product Entity */
export interface Product {
  id: string;
  name: string;
  category: string;
  sku: string;
  /** Cost price of product */
  costPrice: number;
  /** Minimum sale price floor */
  minSalePrice: number;
  /** Suggested retail price */
  suggestedPrice: number;
  /** Legacy price alias */
  price?: number;
  /** Stock per branch: { branchId: quantity } */
  stock: Record<string, number>;
  /** Reserved stock in pending holds/orders: { branchId: quantity } */
  reservedStock?: Record<string, number>;
  /** Denormalized branch IDs where product is present */
  branchIds?: string[];
  /** Branches where stock is at or below threshold */
  lowStockBranches?: string[];
  /** Primary barcode */
  barcode?: string;
  /** Secondary barcodes / aliases */
  barcodes?: string[];
  /** Volume pricing tiers */
  priceTiers?: PriceTier[];
  /** Branch-specific price overrides */
  branchPrices?: Record<string, BranchPriceConfig>;
  /** Sellable presentations (boxes, packs, dozens) */
  presentations?: ProductPresentation[];
  /** Variants (colors, versions) */
  variants?: ProductVariant[];
  /** Main product image */
  imageUrl?: string;
  /** Fast thumbnail (~256px) for POS grids */
  thumbUrl?: string;
  hint?: string;
  supplier?: string;
  brand?: string;
  sizeLabel?: string;
  sizes?: string[];
  accountId: string;
  active?: boolean;
  attributes?: ProductAttribute[];
  galleryImages?: string[];
  isFeatured?: boolean;
  modelUrl?: string;
  ecommerceDescription?: string;
  slug?: string;
  tags?: string[];
  weight?: number;
  dimensions?: { width: number; height: number; length: number };
  seo?: { metaTitle?: string; metaDescription?: string };
  unitOfMeasure?: UnitOfMeasure;
  minStock?: number;
  allowDecimals?: boolean;
  stepDecimal?: number;
  /** Internal search string index */
  _searchStr?: string;
}

// ============================================================================
// 2. POS CART & CHECKOUT TYPES
// ============================================================================

/** Item in POS Cart */
export interface CartItem {
  id: string;
  productId?: string;
  product?: Product;
  name: string;
  price: number;
  quantity: number;
  sku: string;
  /** Selected presentation */
  presentation?: ProductPresentation;
  /** Selected variant */
  variant?: ProductVariant;
  /** Weight/scale product flag */
  isWeightBased?: boolean;
  /** Manually edited custom price */
  customPrice?: number;
  /** Discount applied */
  discount?: number;
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
  stock?: Record<string, number>;
  imageUrl?: string;
  hint?: string;
  isGift?: boolean;
  variantId?: string;
  variantName?: string;
  presentationId?: string;
  presentationName?: string;
  presentationQty?: number;
  unitOfMeasure?: string;
  allowDecimals?: boolean;
  stepDecimal?: number;
  lineTotal?: number;
}

/** Alias for CartItem in Sales */
export type SaleItem = CartItem;

/** Sale Held/Paused in Memory or Storage */
export interface PausedSale {
  id: string;
  label: string;
  savedAt: number;
  items: CartItem[];
  customer?: Customer | null;
  seller?: { sellerId: string; sellerName: string } | null;
  source?: {
    reservation?: Reservation | null;
    order?: Order | null;
  };
  note?: string;
  branchId?: string;
  accountId?: string;
  total?: number;
}

// ============================================================================
// 3. SALES & PAYMENT TYPES
// ============================================================================

/** Payment Method Enumeration */
export type SalePaymentMethod =
  | 'cash'
  | 'yape'
  | 'plin'
  | 'card'
  | 'transfer'
  | 'fiado'
  | 'mixed'
  | 'digital'
  | 'credit';

/** Split Payment Part */
export interface SalePaymentSplit {
  methodId?: string;
  methodName?: string;
  category: 'cash' | 'card' | 'digital' | 'credit' | 'mixed';
  amount: number;
  digitalProvider?: 'yape' | 'plin';
  paymentMethod?: SalePaymentMethod;
  commissionPercent?: number;
  commissionRule?: 'business' | 'customer';
  surchargeAmount?: number;
  commissionAmount?: number;
  chargedAmount?: number;
  reference?: string;
}

/** Backward compatibility alias */
export type PaymentSplit = SalePaymentSplit;
export type PaymentMethod = SalePaymentMethod;

/** Document Fiscal Type */
export type DocumentType =
  | 'nota_venta'
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

export type SaleDocumentType = DocumentType;

/** SUNAT Electronic Invoicing Status */
export type SunatStatus =
  | 'accepted'
  | 'pending'
  | 'rejected'
  | 'not_applicable'
  | 'submitted'
  | 'error';

/** Sale Entity */
export interface Sale {
  id: string;
  saleNumber?: number;
  date: number;
  items: CartItem[];
  subtotal: number;
  tax: number;
  total: number;
  paymentMethod: SalePaymentMethod | string;
  payments?: SalePaymentSplit[];
  branchId: string;
  accountId?: string;
  status?: 'completed' | 'cancelled' | 'refunded' | 'pending';
  statusNotes?: string;
  documentType?: DocumentType;
  documentNumber?: string;
  sunatStatus?: SunatStatus;
  sunatError?: string;
  sunatCdr?: any;
  isOptimistic?: boolean;
  isOfflinePending?: boolean;
  isElectronicInvoice?: boolean;
  cashReceived?: number;
  changeGiven?: number;
  customerId?: string;
  customerName?: string;
  customerDni?: string;
  customerRuc?: string;
  customerAddress?: string;
  customerPhone?: string;
  customerEmail?: string;
  sellerId?: string;
  sellerName?: string;
  cashierId?: string;
  cashierUsername?: string;
  sessionId?: string;
  totalCost?: number;
  totalMargin?: number;
  marginPercent?: number;
  depositInfo?: {
    type: 'reservation' | 'order';
    reservationNumber?: number;
    orderNumber?: number;
    originalTotal: number;
    depositAmount: number;
    remainingAmount: number;
    depositSaleId?: string;
    depositSessionId?: string;
    depositDate?: number;
  };
  originalTotal?: number;
  isDepositPayment?: boolean;
  remainingAmount?: number;
  linkedSaleId?: string;
  isReturn?: boolean;
  refundAmount?: number;
  amountReceived?: number;
  originalSaleId?: string;
  digitalAmount?: number;
  digitalProvider?: 'yape' | 'plin';
  paymentMethodId?: string;
  paymentCategory?: 'cash' | 'card' | 'digital' | 'credit' | 'mixed';
  commissionPercent?: number;
  commissionRule?: 'business' | 'customer';
  surchargeAmount?: number;
  commissionAmount?: number;
  chargedAmount?: number;
  isStaffConsumption?: boolean;
  employeeId?: string;
  employeeName?: string;
  notes?: string;
  amountInWords?: string;
  qrContent?: string;
  consultUrl?: string;
  footerNote?: string;
  reference?: {
    type?: string;
    number?: string;
    reasonCode?: string;
    reasonDescription?: string;
  };
  fiscalAmounts?: {
    taxed: number;
    exempt: number;
    unaffected: number;
    igv: number;
    otherTaxes?: number;
    total: number;
  };
  lastModified?: any;
}

// ============================================================================
// 4. CASH REGISTER & SESSIONS
// ============================================================================

export interface CashRegisterSession {
  id: string;
  branchId: string;
  accountId: string;
  startedBy?: string | null;
  startedByName?: string | null;
  registerId?: string;
  registerName?: string;
  initialAmount: number;
  openTime: number;
  closeTime?: number;
  status: 'open' | 'closed';
  totalSales: number;
  cashSales: number;
  cardSales: number;
  digitalSales: number;
  creditSales?: number;
  transactionCount?: number;
  totalReservationDeposits?: number;
  cashReservationDeposits?: number;
  cardReservationDeposits?: number;
  digitalReservationDeposits?: number;
  reservationDepositsCount?: number;
  totalOrderDeposits?: number;
  cashOrderDeposits?: number;
  cardOrderDeposits?: number;
  digitalOrderDeposits?: number;
  chequeOrderDeposits?: number;
  orderDepositsCount?: number;
  expectedAmount?: number;
  countedAmount?: number;
  difference?: number;
  cashierExpenseLimit?: number;
  totalCommissionAmount?: number;
  totalSurchargeAmount?: number;
}

export type CashRegisterMovementType =
  | 'income'
  | 'expense'
  | 'sale'
  | 'opening'
  | 'closing'
  | 'fiado_payment';

export interface CashRegisterMovement {
  id?: string;
  sessionId: string;
  branchId?: string;
  accountId?: string;
  type: CashRegisterMovementType;
  amount: number;
  reason?: string;
  category?: string;
  paymentMethod?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt: number | any;
  saleId?: string;
  reservationId?: string;
  expenseCategoryId?: string;
  isEmployeeAdvance?: boolean;
  employeeId?: string;
  receiptType?: 'boleta' | 'factura' | 'recibo' | 'ninguno' | string;
  receiptNumber?: string;
}

// ============================================================================
// 5. INVENTORY & KARDEX MOVEMENTS
// ============================================================================

export type KardexMovementType = 'in' | 'out' | 'adjustment' | 'transfer';

export interface InventoryMovement {
  id?: string;
  productId: string;
  productName: string;
  branchId: string;
  accountId: string;
  type: KardexMovementType;
  reason?: string;
  quantity: number;
  previousStock: number;
  newStock: number;
  referenceId?: string;
  createdBy?: string;
  createdAt: number | any;
  // Backward compatibility fields
  productSku?: string;
  branchName?: string;
  userId?: string;
  userName?: string;
  userRole?: string;
  movementType?: string;
  quantityBefore?: number;
  quantityAfter?: number;
  quantityChanged?: number;
  notes?: string;
  saleId?: string;
  reservationId?: string;
}

// ============================================================================
// 6. CUSTOMER, FIADO, ORDERS & RESERVATIONS
// ============================================================================

export interface Customer {
  id: string;
  name: string;
  dni?: string;
  ruc?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  totalPurchases?: number;
  totalSpent?: number;
  accountId?: string;
  credits?: number;
  currentDebt?: number;
  maxCreditLimit?: number;
}

export interface FiadoPayment {
  id?: string;
  reservationId: string;
  customerId?: string;
  customerName?: string;
  amount: number;
  paymentMethod: string;
  date: number;
  createdBy: string;
  createdByName?: string;
  notes?: string;
  sessionId?: string;
  branchId?: string;
  accountId?: string;
  settled?: boolean;
  remaining?: number;
  creditApplied?: number;
}

export interface Reservation {
  id: string;
  reservationNumber?: number;
  date: number;
  expiryDate?: number;
  items: CartItem[];
  subtotal: number;
  tax: number;
  total: number;
  status:
    | 'pending'
    | 'completed'
    | 'cancelled'
    | 'expired'
    | 'settled'
    | 'written_off';
  branchId: string;
  accountId?: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  depositAmount?: number;
  depositPaymentMethod?: string;
  reservationDays?: number;
  notes?: string;
  createdBy: string;
  sellerId?: string;
  sellerName?: string;
  cashSessionId?: string;
  completedDate?: number;
  saleId?: string;
  paymentMethod?: string;
  type?: 'fiado';
  isCreditSale?: boolean;
  dueDate?: number;
  settledDate?: number;
  paidAmount?: number;
  returnedAmount?: number;
  returnHistory?: any[];
  writtenOffAt?: number;
  writtenOffBy?: string;
  writtenOffByName?: string;
  writeOffReason?: string;
  writeOffAmount?: number;
}

export interface Order {
  id: string;
  orderNumber?: number;
  date: number;
  deliveryDate?: number;
  items: CartItem[];
  subtotal: number;
  tax: number;
  total: number;
  status: 'pending' | 'in_progress' | 'ready' | 'delivered' | 'cancelled';
  branchId: string;
  accountId?: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  depositAmount?: number;
  depositPaymentMethod?: string;
  notes?: string;
  createdBy: string;
  createdByName?: string;
  completedDate?: number;
  saleId?: string;
}

export interface StockTransferItem {
  productId: string;
  productName: string;
  sku?: string;
  category?: string;
  quantity: number;
  unitPrice?: number;
}

export interface StockTransfer {
  id?: string;
  accountId: string;
  sourceBranchId: string;
  destinationBranchId: string;
  products: StockTransferItem[];
  items?: StockTransferItem[];
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'in_transit'
    | 'completed'
    | 'cancelled';
  notes?: string;
  transferNumber?: string;
  fromBranchName?: string;
  toBranchName?: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: number | any;
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: number | any;
  rejectionReason?: string;
  shippedAt?: number | any;
  completedAt?: number | any;
  receivedBy?: string;
  totalItems?: number;
}

// ============================================================================
// 7. BRANCH, SETTINGS, USERS & OFFLINE QUEUE
// ============================================================================

export interface Branch {
  id?: string;
  name: string;
  address?: string;
  accountId?: string;
  phone?: string;
  email?: string;
  manager?: string;
  isActive?: boolean;
  businessName?: string;
  description?: string;
  receiptLogo?: string;
  receiptLogoDataUrl?: string;
  ruc?: string;
  commercialAddress?: string;
  fiscalAddress?: string;
  commercialPhone?: string;
  receiptFooter?: string;
  consultUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  totalSales?: number;
  activeEmployees?: number;
  cashSessionStatus?: 'open' | 'closed';
}

export interface BusinessSettings {
  id: string;
  businessName: string;
  description?: string;
  ruc: string;
  address: string;
  phone: string;
  email: string;
  website?: string;
  enableFractionalUnits?: boolean;
  enableMinSalePrice?: boolean;
  accountId: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface PosPaymentMethodConfig {
  id: string;
  name: string;
  kind: 'cash' | 'digital' | 'terminal' | 'credit' | 'mixed';
  enabled: boolean;
  order: number;
  commissionPercent?: number;
  commissionRule?: 'business' | 'customer';
  qrUrl?: string;
  qrLabel?: string;
  provider?: string;
  terminalName?: string;
  reportCategory: 'cash' | 'card' | 'digital' | 'credit';
}

export interface PosSettings {
  id: string;
  accountId: string;
  methods: PosPaymentMethodConfig[];
  allowMixedPayment?: boolean;
  enableQuickSale?: boolean;
  enableLinkedScanner?: boolean;
  enableDeviceCameraScanner?: boolean;
  enableCatalogFilters?: boolean;
  enableMobileBarcodeScanner?: boolean;
  enableSellerAttribution?: boolean;
  requireSellerSelection?: boolean;
  defaultMethodId?: string;
  ticketTemplate?: 'standard' | 'compact';
  createdAt?: any;
  updatedAt?: any;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  role?: 'owner' | 'admin' | 'manager' | 'cashier' | 'seller';
  accountId?: string;
  branchId?: string;
  createdAt?: number;
}

export interface OfflineSaleQueueItem {
  id: string;
  sale: Sale;
  queuedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  error?: string;
  branchId: string;
  accountId: string;
  status: 'pending' | 'syncing' | 'failed' | 'quarantined';
}
