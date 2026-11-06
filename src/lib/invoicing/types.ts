/**
 * Tipos del módulo de facturación electrónica (SUNAT / UBL 2.1)
 *
 * Este módulo implementa la emisión directa contra SUNAT (modelo de
 * proveedor tecnológico / emisor con sistema propio): el XML se genera,
 * firma y envía directamente al webservice de SUNAT sin intermediarios.
 */

/** Tipos de documento (Catálogo 01 SUNAT) */
export const DOCUMENT_TYPES = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
  NOTA_DEBITO: '08',
  GUIA_REMISION: '09',
} as const

export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES]

/** Códigos de documento de identidad (Catálogo 06 SUNAT) */
export const IDENTITY_TYPES = {
  RUC: '6',
  DNI: '1',
  CARNET_EXTRANJERIA: '4',
  PASAPORTE: '7',
  OTROS: '0',
} as const

export type IdentityType = (typeof IDENTITY_TYPES)[keyof typeof IDENTITY_TYPES]

/** Unidades de medida (Catálogo 03 SUNAT) */
export const UNIT_CODES = {
  NIU: 'NIU', // Unidad internacional de negocio (unidad)
  KG: 'KGM',
  G: 'GRM',
  M: 'MTR',
  M2: 'MTK',
  M3: 'MTQ',
  L: 'LTR',
  ML: 'MLT',
  CAJA: 'BX',
  PAQUETE: 'PK',
  DOCENA: 'DZN',
  CIENTO: 'HUR',
} as const

export type UnitCode = (typeof UNIT_CODES)[keyof typeof UNIT_CODES]

/** Datos fiscales del emisor (quien factura) */
export type InvoiceEmitterConfig = {
  /** Número de RUC del emisor */
  ruc: string
  /** Razón social / nombre legal */
  razonSocial: string
  /** Nombre comercial (opcional) */
  nombreComercial?: string
  /** Dirección fiscal completa */
  direccion: string
  /** Código de ubigeo (6 dígitos, ej. 120103) */
  ubigeo: string
  /** Distrito (obligatorio para SUNAT) */
  distrito: string
  /** Provincia */
  provincia: string
  /** Departamento */
  departamento: string
  /** Código de país (SIEMPRE "PE") */
  pais: string
}

/** Datos del cliente/adquirente (opcional para boleta) */
export type InvoiceCustomer = {
  /** Identidad: RUC (6), DNI (1), etc. */
  identityType: IdentityType
  /** Número de documento */
  identityNumber: string
  /** Nombre / razón social del adquirente */
  name: string
  /** Dirección (opcional para boleta) */
  address?: string
  /** Email (opcional) */
  email?: string
} | null

/** Línea de detalle de un comprobante */
export type InvoiceLine = {
  /** Identificador de línea (1..n) */
  lineId: number
  /** Descripción del producto/servicio */
  description: string
  /** Código de producto (opcional) */
  productCode?: string
  /** Cantidad vendida */
  quantity: number
  /** Unidad de medida (catálogo 03) */
  unitCode: UnitCode
  /** Precio unitario SIN impuestos (base imponible por unidad) */
  unitPrice: number
  /** Precio unitario con IGV incluido (precio de venta al público) */
  unitPriceInclTax: number
  /** Base imponible de la línea */
  lineBase: number
  /** Impuesto (IGV) de la línea */
  lineTax: number
  /** Total de la línea (base + impuesto) */
  lineTotal: number
  /** Código de afectación del IGV (catálogo 07). 10 = gravado. */
  taxExemptionCode?: string
  /** Tasa de IGV aplicada en la línea (%) */
  taxRate?: number
}

/** Totales calculados del comprobante */
export type InvoiceTotals = {
  /** Suma de bases imponibles */
  baseTotal: number
  /** Suma de impuestos (IGV) */
  taxTotal: number
  /** Monto total (base + impuesto) */
  total: number
  /** Suma de descuentos a nivel global (opcional) */
  globalDiscount?: number
}

/** Datos para construir el XML de un comprobante */
export type InvoiceData = {
  documentType: DocumentType
  /** Serie-número completo (ej. "F001-00000123") */
  documentNumber: string
  /** Fecha de emisión (formato yyyy-MM-dd) */
  issueDate: string
  /** Hora de emisión (formato HH:mm:ss, opcional) */
  issueTime?: string
  /** Moneda (SUNAT: PEN) */
  currency: string
  /** Tipo de operación (Catálogo 51). Default: 0101 = venta interna */
  operationType?: string
  /** Forma de pago (Catálogo 59). Default: "Contado" (o "Credito") */
  paymentMeans?: string
  emitter: InvoiceEmitterConfig
  customer: InvoiceCustomer
  lines: InvoiceLine[]
  totals: InvoiceTotals
  /** Notas/observaciones opcionales (cbc:Note) */
  notes?: string[]
  /** Leyendas tributarias SUNAT (Catálogo 52, cbc:Note con languageLocaleID) */
  legends?: Array<{ code: string; text: string }>
  /** Para notas de crédito/débito: documento de referencia */
  reference?: {
    /** Tipo de documento referenciado (01/03) */
    type: DocumentType
    /** Serie-número del documento original */
    number: string
    /** Motivo de la nota (catálogo 09) */
    reasonCode: string
    /** Descripción del motivo */
    reasonDescription: string
  }
}

/** Resultado del CDR (constancia de recepción) */
export type CdrResult = {
  /** Código de respuesta SUNAT: 0 = aceptado */
  responseCode: number
  /** Descripción general (ej. "La Factura ... ha sido aceptada") */
  description: string
  /** Notas adicionales / errores por línea */
  notes: string[]
  /** Código de constancia (hash) */
  cdrCode?: string
  /** Fecha/hora del CDR */
  responseDate?: string
  responseTime?: string
}

export const isCdrAccepted = (cdr: CdrResult): boolean => cdr.responseCode === 0

/** Estado de un documento en Firestore */
export const INVOICE_STATUS = {
  PENDING: 'pending',
  SENDING: 'sending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  ERROR: 'error',
} as const

export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS]

/** Configuración por sucursal (cada sucursal = serie propia) */
export type EinvoiceBranchConfig = {
  /** Series por tipo de documento (ej. '01': 'F032', '03': 'B032') */
  series?: Partial<Record<DocumentType, string>>
  /** Correlativos consumidos por serie de la sucursal */
  correlatives?: Record<string, number>
  /** Dirección de la sucursal (opcional; se usa en el comprobante) */
  address?: string | null
  /** Cajas adicionales de la misma sucursal, cada una con su propia serie SUNAT
   * (la "caja 1" implícita usa series/correlatives de arriba). */
  registers?: Record<string, {
    name: string
    series: Partial<Record<DocumentType, string>>
    correlatives: Record<string, number>
  }>
}

/** Configuración de facturación de una cuenta (documento einvoice-config) */
export type EinvoiceConfig = {
  accountId: string
  /** true si la cuenta tiene facturación electrónica habilitada */
  enabled: boolean
  /** Ambiente de emisión: 'beta' (homologación) | 'produccion' */
  environment: 'beta' | 'produccion'
  /** Datos fiscales del emisor */
  emitter: InvoiceEmitterConfig
  /** Usuario SOL (ej. "20611526572FACTURA" o similar) */
  solUser: string
  /** Clave SOL */
  solPassword: string
  /** Certificado digital PEM (base64) */
  certPem: string
  /** Clave privada PEM (base64) */
  keyPem: string
  /** Tasa de IGV por defecto (%) */
  taxRate: number
  /** Código de afectación de IGV por defecto (Catálogo 07: '10' Gravado, '20' Exonerado) */
  taxExemptionCode?: string
  /** true si el emisor opera en la Amazonía y está exonerado de IGV (Ley 27037) */
  isAmazonExempt?: boolean
  /** Serie configurada por tipo de documento */
  series: Partial<Record<DocumentType, string>>
  /** Correlativos consumidos por serie */
  correlatives: Record<string, number>
  /** Configuración por sucursal (serie y correlativo propios) */
  branches?: Record<string, EinvoiceBranchConfig>
  /** N.° de resolución SUNAT que autoriza el formato impreso del comprobante
   * (ej. "0180050000781"), fijo para todo el RUC. Se imprime como
   * "Autorizado mediante resolución Nro. {n}/SUNAT". */
  printedFormatResolution?: string
  updatedAt?: number
}

/** Datos de una guía de remisión electrónica (09) */
export type DespatchLine = {
  lineId: number
  description: string
  productCode?: string
  quantity: number
  unitCode: UnitCode
}

export type DespatchData = {
  /** Serie-número completo (ej. "T001-00000001") */
  documentNumber: string
  /** Fecha de emisión (yyyy-MM-dd) */
  issueDate: string
  /** Hora de emisión (HH:mm:ss) */
  issueTime?: string
  /** Motivo de traslado (Catálogo 20). 04 = entre establecimientos de la misma empresa */
  reasonCode: string
  /** Descripción del motivo (opcional) */
  reasonDescription?: string
  /** Modalidad de traslado (Catálogo 18). 01 = público, 02 = privado */
  transportMode: string
  /** Peso bruto total (KGM) */
  grossWeight: number
  emitter: InvoiceEmitterConfig
  /** Sucursal/establecimiento de origen */
  origin: {
    name: string
    address: string
    ubigeo: string
    distrito: string
    provincia: string
    departamento: string
  }
  /** Sucursal/establecimiento de destino */
  destination: {
    name: string
    address: string
    ubigeo: string
    distrito: string
    provincia: string
    departamento: string
  }
  lines: DespatchLine[]
  notes?: string[]
}

/** Immutable monetary values extracted from the original fiscal XML for printing. */
export type InvoiceReceiptAmounts = {
  taxed: number
  exempt: number
  unaffected: number
  igv: number
  otherTaxes: number
  total: number
}

/** Documento de comprobante emitido (colección einvoices) */
export type InvoiceCustomerSnapshot = NonNullable<InvoiceCustomer> & { identityType: '6' | '1' }

export type InvoiceReceiptCustomer = Pick<NonNullable<InvoiceCustomer>, 'identityType' | 'identityNumber' | 'name' | 'address'>

export type Einvoice = {
  customerSnapshot?: InvoiceCustomerSnapshot | null
  receiptCustomer?: InvoiceReceiptCustomer
  receiptIssuedAt?: number
  replacesInvoiceId?: string
  replacementCreditNoteId?: string
  replacementId?: string
  replacementClaimedAt?: number
  einvoiceNoteId?: string
  xmlRepair?: { version: 1; originalSha256: string; repairedAt: number }

  receiptAmounts?: InvoiceReceiptAmounts
  id: string
  accountId: string
  saleId: string
  /** Sucursal donde se emitió (para filtros por tienda) */
  branchId?: string
  documentType: DocumentType
  /** Serie-número completo (ej. "F001-00000123") */
  documentNumber: string
  fileName: string
  status: InvoiceStatus
  cdr?: CdrResult
  /** XML firmado (para auditoría / reenvío) */
  xml?: string
  /** CDR base64 (constancia original de SUNAT) */
  cdrB64?: string
  /** Para notas de crédito/débito: documento original referenciado */
  reference?: {
    type: DocumentType
    number: string
    reasonCode: string
    reasonDescription: string
  }
  amount: number
  currency: string
  createdAt: number
  updatedAt: number
  /** Número de reintentos de envío */
  attempts: number
  /** Consultas/reintentos automáticos, independientes de los envíos. */
  automaticRecoveryAttempts?: number
  automaticRecoveryLastAttemptAt?: number
  taxExemptionCode?: string
  taxRate?: number
  /** Error del último intento */
  lastError?: string
}
