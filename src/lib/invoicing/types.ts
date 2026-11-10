/**
 * SUNAT Electronic Invoicing (UBL 2.1) Types, Catalogs & Peruvian Fiscal Validators
 * Complete fiscal declarations, Modulo 11 RUC validation, and tax breakdown
 */

// ============================================================================
// 1. SUNAT UBL 2.1 CATALOGS
// ============================================================================

/** Catálogo 01: Tipo de Documento */
export const DOCUMENT_TYPES = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
  NOTA_DEBITO: '08',
  GUIA_REMISION: '09',
  NOTA_VENTA: '80',
} as const;

export type DocumentType =
  | (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES]
  | 'nota_venta'
  | 'boleta'
  | 'factura'
  | 'cotizacion';

/** Catálogo 06: Códigos de Tipo de Documento de Identidad */
export const IDENTITY_TYPES = {
  RUC: '6',
  DNI: '1',
  CARNET_EXTRANJERIA: '4',
  PASAPORTE: '7',
  OTROS: '0',
} as const;

export type IdentityType = (typeof IDENTITY_TYPES)[keyof typeof IDENTITY_TYPES];

/** Catálogo 03: Códigos de Unidades de Medida */
export const UNIT_CODES = {
  NIU: 'NIU', // Unidad
  KG: 'KGM',  // Kilogramo
  G: 'GRM',   // Gramo
  M: 'MTR',   // Metro
  M2: 'MTK',  // Metro cuadrado
  M3: 'MTQ',  // Metro cúbico
  L: 'LTR',   // Litro
  ML: 'MLT',  // Mililitro
  CAJA: 'BX', // Caja
  PAQUETE: 'PK', // Paquete
  DOCENA: 'DZN', // Docena
} as const;

export type UnitCode = (typeof UNIT_CODES)[keyof typeof UNIT_CODES];

/** Catálogo 07: Códigos de Tipo de Afectación del IGV */
export const TAX_EXEMPTION_CODES = {
  GRAVADO_OPERACION_ONEROSA: '10',
  GRAVADO_RETIRO_PREMIO: '11',
  GRAVADO_RETIRO_DONACION: '12',
  EXONERADO_OPERACION_ONEROSA: '20',
  INAFECTO_OPERACION_ONEROSA: '30',
  EXPORTACION: '40',
} as const;

export type TaxExemptionCode =
  (typeof TAX_EXEMPTION_CODES)[keyof typeof TAX_EXEMPTION_CODES];

// ============================================================================
// 2. FISCAL DATA STRUCTURES
// ============================================================================

/** Datos fiscales del emisor */
export interface InvoiceEmitterConfig {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  direccion: string;
  ubigeo: string;
  distrito: string;
  provincia: string;
  departamento: string;
  pais: string;
}

/** Datos del cliente / adquirente */
export interface InvoiceCustomer {
  identityType: IdentityType;
  identityNumber: string;
  name: string;
  address?: string;
  email?: string;
}

/** Línea de detalle de comprobante */
export interface InvoiceLine {
  lineId: number;
  description: string;
  productCode?: string;
  quantity: number;
  unitCode: UnitCode;
  unitPrice: number;
  unitPriceInclTax: number;
  lineBase: number;
  lineTax: number;
  lineTotal: number;
  taxExemptionCode?: TaxExemptionCode | string;
  taxRate?: number;
}

/** Totales calculados de comprobante */
export interface InvoiceTotals {
  baseTotal: number;
  taxTotal: number;
  total: number;
  globalDiscount?: number;
}

/** Datos para el XML / CDR */
export interface CdrResult {
  responseCode: number;
  description: string;
  notes: string[];
  cdrCode?: string;
  responseDate?: string;
  responseTime?: string;
}

/** Desglose tributario inmutable para impresión */
export interface InvoiceReceiptAmounts {
  taxed: number;
  exempt: number;
  unaffected: number;
  igv: number;
  otherTaxes?: number;
  total: number;
}

/** Estado del comprobante en el sistema */
export const INVOICE_STATUS = {
  PENDING: 'pending',
  SENDING: 'sending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  ERROR: 'error',
} as const;

export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

/** Documento de comprobante emitido */
export interface Einvoice {
  id: string;
  accountId: string;
  saleId: string;
  branchId?: string;
  documentType: DocumentType;
  documentNumber: string;
  fileName: string;
  status: InvoiceStatus;
  cdr?: CdrResult;
  xml?: string;
  cdrB64?: string;
  amount: number;
  currency: string;
  receiptAmounts?: InvoiceReceiptAmounts;
  createdAt: number;
  updatedAt: number;
  attempts: number;
}

// ============================================================================
// 3. PERUVIAN FISCAL VALIDATORS (DNI & SUNAT MODULO 11 RUC)
// ============================================================================

/**
 * Validador de DNI peruano: exactamente 8 dígitos numéricos
 */
export function isValidDNI(dni: string | undefined | null): boolean {
  if (!dni) return false;
  const clean = dni.trim();
  return /^\d{8}$/.test(clean);
}

/**
 * Validador oficial de RUC de SUNAT utilizando el algoritmo Módulo 11.
 * 
 * Reglas:
 * 1. 11 dígitos numéricos.
 * 2. Prefijos válidos: 10, 15, 16, 17 (persona natural), 20 (persona jurídica).
 * 3. Factores de ponderación: [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] para los primeros 10 dígitos.
 * 4. Suma = suma(dígito[i] * factor[i]).
 * 5. Dígito verificador = 11 - (Suma % 11).
 *    Si el resultado es 10 -> 0.
 *    Si el resultado es 11 -> 1.
 * 6. Debe coincidir exactamente con el 11.° dígito.
 */
export function isValidRUC(ruc: string | undefined | null): boolean {
  if (!ruc) return false;
  const clean = ruc.trim();
  if (!/^\d{11}$/.test(clean)) return false;

  // Validar prefijos válidos de SUNAT
  const prefix = clean.substring(0, 2);
  const validPrefixes = ['10', '15', '16', '17', '20'];
  if (!validPrefixes.includes(prefix)) {
    return false;
  }

  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += parseInt(clean[i], 10) * weights[i];
  }

  const remainder = sum % 11;
  let checkDigit = 11 - remainder;

  if (checkDigit === 10) checkDigit = 0;
  else if (checkDigit === 11) checkDigit = 1;

  return checkDigit === parseInt(clean[10], 10);
}

// ============================================================================
// 4. TAX BREAKDOWN (OP. GRAVADA + IGV 18%)
// ============================================================================

export interface TaxTotalsResult {
  opGravada: number;
  igv: number;
  total: number;
  igvRate: number;
}

/**
 * Desglosa un total con IGV incluido (18%) en base imponible (opGravada),
 * IGV y total redondeados a 2 decimales según los lineamientos de SUNAT.
 */
export function calculateTaxTotals(
  totalWithIgv: number,
  igvRate: number = 0.18
): TaxTotalsResult {
  const safeTotal = Math.max(0, Number(totalWithIgv) || 0);
  const roundedTotal = Math.round(safeTotal * 100) / 100;

  // Base imponible = Total / (1 + igvRate)
  const opGravada = Math.round((roundedTotal / (1 + igvRate)) * 100) / 100;

  // IGV = Total - Base imponible (asegura cuadre exacto de céntimos en ticket)
  const igv = Math.round((roundedTotal - opGravada) * 100) / 100;

  return {
    opGravada,
    igv,
    total: roundedTotal,
    igvRate,
  };
}

// ============================================================================
// 5. NUMBER TO SPANISH WORDS FOR PERUVIAN CURRENCY
// ============================================================================

const UNIDADES = [
  '',
  'UN',
  'DOS',
  'TRES',
  'CUATRO',
  'CINCO',
  'SEIS',
  'SIETE',
  'OCHO',
  'NUEVE',
];

const DIEZ_A_DIECINUEVE = [
  'DIEZ',
  'ONCE',
  'DOCE',
  'TRECE',
  'CATORCE',
  'QUINCE',
  'DIECISEIS',
  'DIECISIETE',
  'DIECIOCHO',
  'DIECINUEVE',
];

const DECENAS = [
  '',
  '',
  'VEINTE',
  'TREINTA',
  'CUARENTA',
  'CINCUENTA',
  'SESENTA',
  'SETENTA',
  'OCHENTA',
  'NOVENTA',
];

const CENTENAS = [
  '',
  'CIENTO',
  'DOSCIENTOS',
  'TRESCIENTOS',
  'CUATROCIENTOS',
  'QUINIENTOS',
  'SEISCIENTOS',
  'SETECIENTOS',
  'OCHOCIENTOS',
  'NOVECIENTOS',
];

function decenasATexto(n: number): string {
  if (n < 10) return UNIDADES[n];
  if (n < 20) return DIEZ_A_DIECINUEVE[n - 10];
  if (n < 30) return n === 20 ? 'VEINTE' : `VEINTI${UNIDADES[n - 20]}`;
  const d = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? DECENAS[d] : `${DECENAS[d]} Y ${UNIDADES[u]}`;
}

function centenasATexto(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c > 0) partes.push(CENTENAS[c]);
  if (resto > 0) partes.push(decenasATexto(resto));
  return partes.join(' ');
}

function enterosATexto(n: number): string {
  if (n === 0) return 'CERO';
  if (n === 1) return 'UN';

  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;

  const partes: string[] = [];
  if (millones > 0) {
    partes.push(
      millones === 1 ? 'UN MILLON' : `${centenasATexto(millones)} MILLONES`
    );
  }
  if (miles > 0) {
    partes.push(miles === 1 ? 'MIL' : `${centenasATexto(miles)} MIL`);
  }
  if (resto > 0) {
    partes.push(centenasATexto(resto));
  }
  return partes.join(' ');
}

/**
 * Convierte un importe monetario a su representación en letras según la normativa
 * tributaria de SUNAT para comprobantes de pago peruanos.
 * e.g. 120.50 -> "SON: CIENTO VEINTE CON 50/100 SOLES"
 */
export function numberToSpanishWordsPEN(amount: number): string {
  const safeAmount = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
  const entero = Math.floor(safeAmount);
  const centavos = Math.round((safeAmount - entero) * 100);
  const centavosStr = String(centavos).padStart(2, '0');

  const textoEntero = enterosATexto(entero);
  return `SON: ${textoEntero} CON ${centavosStr}/100 SOLES`;
}

/** Alias para compatibilidad con módulos existentes */
export const amountToWordsSoles = numberToSpanishWordsPEN;
