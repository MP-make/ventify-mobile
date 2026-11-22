/**
 * Ventify Mobile ESC/POS Thermal Receipt Builder & HTML Renderer
 * Generates binary byte arrays for 58mm / 80mm Bluetooth/USB thermal printers,
 * Base64 bridges, and print-ready HTML for expo-print (AirPrint / Android Print).
 */

import {
  Sale,
  CashRegisterSession,
  BusinessSettings,
  Branch,
  CartItem,
} from '../../types';
import {
  numberToSpanishWordsPEN,
} from '../invoicing/types';
import {
  receiptAmountsForSale,
  type TaxProfileInput,
} from '../invoicing/receipt-amounts';
import { buildSaleQrContent } from '../invoicing/qr-content';
import { buildQrSvgMarkup } from '../invoicing/qr-matrix';
import { formatPEN, formatDatePE } from '../theme';

// ============================================================================
// 1. CONFIGURATION & INTERFACES
// ============================================================================

export interface EscPosOptions {
  /** Paper width: 80mm = ~48 cols, 58mm = ~32 cols */
  paperWidth?: 80 | 58 | '80mm' | '58mm';
  /** Automatically trigger partial paper cut at the end */
  autoCut?: boolean;
  /** Send electronic cash drawer kick pulse */
  openDrawer?: boolean;
  /** Layout template style */
  ticketTemplate?: 'standard' | 'compact';
  /** Optional branch metadata to merge store address / commercial info */
  branch?: Partial<Branch> | null;
  /** Account IGV tax profile (General 18% / 10% or Amazon exempt Ley 27037) */
  taxProfile?: TaxProfileInput | null;
  /** Override public consultation URL */
  consultUrl?: string;
  /** Override ticket footer message */
  receiptFooter?: string;
}

export interface CashClosureData {
  totalIncomes?: number;
  totalExpenses?: number;
  expectedAmount?: number;
  countedAmount?: number;
  difference?: number;
  closedByName?: string;
  notes?: string;
}

const escapeHtml = (value: string): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const is58PaperWidth = (width?: EscPosOptions['paperWidth']): boolean =>
  width === 58 || width === '58mm';

// ============================================================================
// 2. ESC/POS BINARY BUILDER CLASS
// ============================================================================

const PRINTABLE_ASCII_RE = /^[\x20-\x7E\r\n]*$/;

export class EscPosBuilder {
  private buffer: Uint8Array = new Uint8Array(2048);
  private length: number = 0;
  public readonly cols: number;

  constructor(public readonly options: EscPosOptions = {}) {
    this.cols = is58PaperWidth(options.paperWidth) ? 32 : 48;
    this.init();
  }

  private ensureCapacity(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let nextCapacity = this.buffer.length * 2;
    while (nextCapacity < needed) {
      nextCapacity *= 2;
    }
    const next = new Uint8Array(nextCapacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  /** ESC @ - Initialize printer to default state */
  init(): this {
    this.ensureCapacity(2);
    this.buffer[this.length++] = 0x1b;
    this.buffer[this.length++] = 0x40;
    return this;
  }

  /** ESC p - Open cash drawer (pin 2 pulse 50ms) */
  openCashDrawer(): this {
    this.ensureCapacity(5);
    const buf = this.buffer;
    let offset = this.length;
    buf[offset++] = 0x1b;
    buf[offset++] = 0x70;
    buf[offset++] = 0x00;
    buf[offset++] = 0x19;
    buf[offset++] = 0xfa;
    this.length = offset;
    return this;
  }

  /** ESC a - Alignment (0: Left, 1: Center, 2: Right) */
  align(alignment: 'left' | 'center' | 'right'): this {
    const code = alignment === 'center' ? 0x01 : alignment === 'right' ? 0x02 : 0x00;
    this.ensureCapacity(3);
    const buf = this.buffer;
    let offset = this.length;
    buf[offset++] = 0x1b;
    buf[offset++] = 0x61;
    buf[offset++] = code;
    this.length = offset;
    return this;
  }

  /** ESC E - Bold emphasis toggle */
  bold(enable: boolean = true): this {
    this.ensureCapacity(3);
    const buf = this.buffer;
    let offset = this.length;
    buf[offset++] = 0x1b;
    buf[offset++] = 0x45;
    buf[offset++] = enable ? 0x01 : 0x00;
    this.length = offset;
    return this;
  }

  /** GS ! - Text character sizing */
  size(mode: 'normal' | 'double-height' | 'double-width' | 'double'): this {
    let n = 0x00;
    if (mode === 'double-height') n = 0x01;
    else if (mode === 'double-width') n = 0x10;
    else if (mode === 'double') n = 0x11;
    this.ensureCapacity(3);
    const buf = this.buffer;
    let offset = this.length;
    buf[offset++] = 0x1d;
    buf[offset++] = 0x21;
    buf[offset++] = n;
    this.length = offset;
    return this;
  }

  /** Strips diacritics and converts to printer-safe ASCII / CP437 */
  private sanitizeText(text: string): string {
    if (!text) return '';
    if (PRINTABLE_ASCII_RE.test(text)) return text;
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove accent marks
      .replace(/[ñ]/g, 'n')
      .replace(/[Ñ]/g, 'N')
      .replace(/[¿¡]/g, '')
      .replace(/•/g, '-')
      .replace(/[^\x20-\x7E\n\r]/g, ''); // ASCII printable only
  }

  /** Push already-sanitized ASCII characters directly into buffer */
  private pushRawAscii(ascii: string): void {
    const len = ascii.length;
    if (len === 0) return;
    this.ensureCapacity(len);
    const buf = this.buffer;
    let offset = this.length;
    for (let i = 0; i < len; i++) {
      buf[offset++] = ascii.charCodeAt(i);
    }
    this.length = offset;
  }

  /** Push already-sanitized ASCII line + LF without re-running sanitizeText */
  private rawSanitizedLine(sanitized: string): this {
    const len = sanitized.length;
    this.ensureCapacity(len + 1);
    const buf = this.buffer;
    let offset = this.length;
    for (let i = 0; i < len; i++) {
      buf[offset++] = sanitized.charCodeAt(i);
    }
    buf[offset++] = 0x0a;
    this.length = offset;
    return this;
  }

  /** Append raw sanitized text */
  text(str: string): this {
    this.pushRawAscii(this.sanitizeText(str));
    return this;
  }

  /** Append line with Line Feed (LF 0x0A) */
  line(str: string = ''): this {
    return this.rawSanitizedLine(this.sanitizeText(str));
  }

  /** ESC d - Feed N lines */
  feed(lines: number = 1): this {
    this.ensureCapacity(3);
    const buf = this.buffer;
    let offset = this.length;
    buf[offset++] = 0x1b;
    buf[offset++] = 0x64;
    buf[offset++] = Math.max(1, lines);
    this.length = offset;
    return this;
  }

  /** Print horizontal divider line */
  divider(char: string = '-'): this {
    return this.line(char.repeat(this.cols));
  }

  /** Two columns justified: left label, right value */
  twoColumns(left: string, right: string): this {
    const cleanLeft = this.sanitizeText(left);
    const cleanRight = this.sanitizeText(right);
    const spaceCount = Math.max(1, this.cols - cleanLeft.length - cleanRight.length);
    const totalLen = cleanLeft.length + spaceCount + cleanRight.length + 1;
    this.ensureCapacity(totalLen);
    const buf = this.buffer;
    let offset = this.length;
    for (let i = 0; i < cleanLeft.length; i++) {
      buf[offset++] = cleanLeft.charCodeAt(i);
    }
    buf.fill(0x20, offset, offset + spaceCount);
    offset += spaceCount;
    for (let i = 0; i < cleanRight.length; i++) {
      buf[offset++] = cleanRight.charCodeAt(i);
    }
    buf[offset++] = 0x0a;
    this.length = offset;
    return this;
  }

  /** Three columns: quantity/sku, name, total */
  itemRow(name: string, qty: number, unitPrice: number, total: number, unit?: string): this {
    const unitStr = (unit || 'UND').trim().toUpperCase();
    const qtyStr = `${qty} ${unitStr}`;
    const priceStr = unitPrice.toFixed(2);
    const totalStr = `S/ ${total.toFixed(2)}`;

    // Line 1: QTY x PRICE -> TOTAL
    const leftPart = `${qtyStr} x ${priceStr}`;
    const spaceCount = Math.max(1, this.cols - leftPart.length - totalStr.length);
    this.line(`${leftPart}${' '.repeat(spaceCount)}${totalStr}`);

    // Line 2: Product Name indented
    const cleanName = this.sanitizeText(name);
    return this.rawSanitizedLine(`  ${cleanName}`);
  }

  /** Native ESC/POS QR Code Model 2 */
  qr(data: string, size: number = 4): this {
    const cleanData = this.sanitizeText(data);
    const len = cleanData.length + 3;
    const pL = len % 256;
    const pH = Math.floor(len / 256);

    this.ensureCapacity(41 + cleanData.length);
    const buf = this.buffer;
    let offset = this.length;

    // 1. Model 2
    buf[offset++] = 0x1d; buf[offset++] = 0x28; buf[offset++] = 0x6b;
    buf[offset++] = 0x04; buf[offset++] = 0x00; buf[offset++] = 0x31;
    buf[offset++] = 0x41; buf[offset++] = 0x32; buf[offset++] = 0x00;
    // 2. Module size (3..8)
    buf[offset++] = 0x1d; buf[offset++] = 0x28; buf[offset++] = 0x6b;
    buf[offset++] = 0x03; buf[offset++] = 0x00; buf[offset++] = 0x31;
    buf[offset++] = 0x43; buf[offset++] = Math.min(8, Math.max(3, size));
    // 3. Error correction level (M: 49)
    buf[offset++] = 0x1d; buf[offset++] = 0x28; buf[offset++] = 0x6b;
    buf[offset++] = 0x03; buf[offset++] = 0x00; buf[offset++] = 0x31;
    buf[offset++] = 0x45; buf[offset++] = 0x31;
    // 4. Store data
    buf[offset++] = 0x1d; buf[offset++] = 0x28; buf[offset++] = 0x6b;
    buf[offset++] = pL;   buf[offset++] = pH;   buf[offset++] = 0x31;
    buf[offset++] = 0x50; buf[offset++] = 0x30;
    for (let i = 0; i < cleanData.length; i++) {
      buf[offset++] = cleanData.charCodeAt(i);
    }
    // 5. Print stored QR
    buf[offset++] = 0x1d; buf[offset++] = 0x28; buf[offset++] = 0x6b;
    buf[offset++] = 0x03; buf[offset++] = 0x00; buf[offset++] = 0x31;
    buf[offset++] = 0x51; buf[offset++] = 0x30;
    this.length = offset;
    return this;
  }

  /** GS V - Paper Cut (partial cut) */
  cut(partial: boolean = true, feedLines: number = 3): this {
    this.feed(Math.max(1, feedLines));
    this.ensureCapacity(4);
    const buf = this.buffer;
    let offset = this.length;
    buf[offset++] = 0x1d;
    buf[offset++] = 0x56;
    buf[offset++] = partial ? 0x42 : 0x41;
    buf[offset++] = 0x00;
    this.length = offset;
    return this;
  }

  /** Returns raw binary buffer */
  build(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

// ============================================================================
// 3. BASE64 CONVERTER
// ============================================================================

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encodes Uint8Array binary buffer to Base64 string
 * Safe for React Native native modules and Bluetooth bridges
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  if (len === 0) return '';

  const chunkCount = Math.ceil(len / 3);
  const out = new Array<string>(chunkCount);
  const fullTripletsEnd = len - (len % 3);
  let outIdx = 0;

  for (let i = 0; i < fullTripletsEnd; i += 3) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[outIdx++] =
      BASE64_CHARS[(triplet >> 18) & 0x3f] +
      BASE64_CHARS[(triplet >> 12) & 0x3f] +
      BASE64_CHARS[(triplet >> 6) & 0x3f] +
      BASE64_CHARS[triplet & 0x3f];
  }

  const rem = len - fullTripletsEnd;
  if (rem === 1) {
    const b1 = bytes[fullTripletsEnd];
    out[outIdx++] =
      BASE64_CHARS[b1 >> 2] +
      BASE64_CHARS[(b1 & 0x03) << 4] +
      '==';
  } else if (rem === 2) {
    const b1 = bytes[fullTripletsEnd];
    const b2 = bytes[fullTripletsEnd + 1];
    out[outIdx++] =
      BASE64_CHARS[b1 >> 2] +
      BASE64_CHARS[((b1 & 0x03) << 4) | (b2 >> 4)] +
      BASE64_CHARS[(b2 & 0x0f) << 2] +
      '=';
  }

  return out.join('');
}

/** Alias export */
export const toBase64 = uint8ArrayToBase64;

// ============================================================================
// 4. SALE RECEIPT ESC/POS BUILDER & SHARED NORMALIZERS
// ============================================================================

const formatReceiptPaymentMethod = (method?: string, provider?: string): string => {
  const m = String(method || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  if (p === 'yape' || m === 'yape') return 'Yape';
  if (p === 'plin' || m === 'plin') return 'Plin';
  if (m === 'cash' || m === 'efectivo') return 'Efectivo';
  if (m === 'card' || m === 'tarjeta') return 'Tarjeta';
  if (m === 'transfer' || m === 'transferencia') return 'Transferencia';
  if (m === 'fiado' || m === 'credit') return 'Crédito / Fiado';
  if (m === 'mixed' || m === 'mixto') return 'Pago Mixto';
  return method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Efectivo';
};

export function resolveReceiptDocumentMeta(sale: Sale) {
  const rawDocType = String(sale.documentType || 'nota_venta').toLowerCase();
  const isQuote =
    Boolean((sale as any).isQuote) ||
    rawDocType === 'quote' ||
    rawDocType === 'cotizacion' ||
    rawDocType === 'cot';
  const isFacturaDoc = rawDocType === 'factura' || rawDocType === '01';
  const isBoletaDoc = rawDocType === 'boleta' || rawDocType === '03';
  const isCreditNote = rawDocType === 'credit_note' || rawDocType === '07';
  const isDebitNote = rawDocType === 'debit_note' || rawDocType === '08';
  const isOfflinePending = Boolean(
    (sale as any).isOffline || (sale as any).offlineQueued || sale.isOfflinePending
  );
  const isFacturaAccepted =
    isFacturaDoc && sale.sunatStatus === 'accepted' && !isOfflinePending;
  const isFiscal = isBoletaDoc || isFacturaAccepted || isCreditNote || isDebitNote;

  let displayTitle = 'NOTA DE VENTA';
  if (isQuote) {
    displayTitle = 'COTIZACION';
  } else if (isFacturaAccepted) {
    displayTitle = 'FACTURA ELECTRONICA';
  } else if (isBoletaDoc) {
    displayTitle = 'BOLETA DE VENTA ELECTRONICA';
  } else if (isCreditNote) {
    displayTitle = 'NOTA DE CREDITO ELECTRONICA';
  } else if (isDebitNote) {
    displayTitle = 'NOTA DE DEBITO ELECTRONICA';
  }

  const fallbackNv = sale.saleNumber ? `NV-${String(sale.saleNumber).padStart(6, '0')}` : 'S/N';
  const docNumber =
    isFacturaDoc && !isFacturaAccepted
      ? sale.correlative && !String(sale.correlative).toUpperCase().startsWith('F')
        ? String(sale.correlative)
        : fallbackNv
      : sale.documentNumber ||
        sale.correlative ||
        `V-${String(sale.saleNumber || 1).padStart(6, '0')}`;

  return {
    isQuote,
    isFacturaDoc,
    isBoletaDoc,
    isCreditNote,
    isDebitNote,
    isOfflinePending,
    isFacturaAccepted,
    isFiscal,
    displayTitle,
    docNumber,
  };
}

function resolveReceiptCustomerMeta(sale: Sale) {
  const receiptCustomer = sale.receiptCustomer;
  const name = receiptCustomer?.name || sale.customerName || '';
  const identityNumber = String(
    receiptCustomer?.identityNumber ||
      sale.customerRuc ||
      sale.customerDni ||
      (sale as any).customerDocNumber ||
      (sale as any).customerDocument ||
      ''
  ).trim();
  const digits = identityNumber.replace(/\D/g, '');
  const idType = receiptCustomer?.identityType;
  const docLabel =
    idType === '6' || digits.length === 11
      ? 'RUC'
      : idType === '1' || digits.length === 8
        ? 'DNI'
        : 'Doc';
  const address = receiptCustomer?.address || sale.customerAddress || '';
  return { name, identityNumber, docLabel, address };
}

function resolveReceiptPayments(sale: Sale) {
  const rawSplits =
    Array.isArray(sale.payments) && sale.payments.length > 0
      ? sale.payments
      : Array.isArray((sale as any).paymentSplits) && (sale as any).paymentSplits.length > 0
        ? (sale as any).paymentSplits
        : Array.isArray((sale as any).mixedPayments)
          ? (sale as any).mixedPayments
          : [];

  const splits = rawSplits
    .filter((s: any) => (Number(s?.amount) || 0) > 0)
    .map((s: any) => ({
      label: String(
        s.methodName ||
          s.methodLabel ||
          formatReceiptPaymentMethod(s.category || s.method, s.digitalProvider || s.provider)
      ),
      amount: Number(s.amount) || 0,
    }));

  const paymentLabel = String(
    sale.paymentMethodName ||
      (splits.length > 1
        ? 'MIXTO'
        : splits[0]?.label ||
          formatReceiptPaymentMethod(sale.paymentMethod, sale.digitalProvider))
  ).toUpperCase();

  return { splits, paymentLabel };
}

/**
 * Builds binary ESC/POS ticket for sales and electronic invoices.
 * Includes Peruvian tax compliance protection: if a Factura lacks
 * accepted CDR (or is offline), it is safely degraded to "NOTA DE VENTA".
 */
export function buildSaleReceiptEscPos(
  sale: Sale,
  business: Partial<BusinessSettings & Branch> = {},
  options: EscPosOptions = {}
): Uint8Array {
  const is58 = is58PaperWidth(options.paperWidth);
  const builder = new EscPosBuilder({
    ...options,
    paperWidth: is58 ? 58 : 80,
  });
  const isCompact = options.ticketTemplate === 'compact';
  const merged = { ...(business || {}), ...(options.branch || {}) } as Partial<BusinessSettings & Branch> & {
    razonSocial?: string;
    commercialName?: string;
    email?: string;
    sunatResolution?: string;
    authorizationText?: string;
    printedFormatResolution?: string;
  };

  // 1. Kick cash drawer if requested
  if (options.openDrawer) {
    builder.openCashDrawer();
  }

  // 2. Resolve fiscal title with Web anti-evasion rule:
  // Only Factura ('01'/'factura') degrades to NOTA DE VENTA while pending/unaccepted;
  // Boleta ('03'/'boleta') remains optimistically BOLETA DE VENTA ELECTRONICA.
  const {
    isOfflinePending,
    isFiscal,
    displayTitle,
    docNumber,
  } = resolveReceiptDocumentMeta(sale);

  // 3. Business Header
  builder.align('center');
  if (isOfflinePending) {
    builder.bold(true).line('*** OPERACION OFFLINE ***');
    builder.line('PENDIENTE DE SINCRONIZACION').bold(false);
    builder.divider('*');
  }

  const businessName = merged.commercialName || merged.businessName || merged.name || 'VENTIFY POS';
  builder.bold(true).size('double-height').line(businessName).size('normal').bold(false);

  if (merged.razonSocial && merged.razonSocial !== businessName) {
    builder.line(merged.razonSocial);
  }
  if (merged.description && !isCompact) {
    builder.line(`"${merged.description}"`);
  }
  if (merged.ruc) {
    builder.bold(true).line(`RUC: ${merged.ruc}`).bold(false);
  }

  const fiscalAddress = merged.fiscalAddress || merged.address;
  const storeAddress = merged.commercialAddress;
  if (fiscalAddress) {
    builder.line(fiscalAddress);
  }
  if (storeAddress && storeAddress !== fiscalAddress) {
    builder.line(`Tienda: ${storeAddress}`);
  }
  if (merged.commercialPhone || merged.phone) {
    builder.line(`Telf: ${merged.commercialPhone || merged.phone}`);
  }
  if (!isCompact && merged.email) {
    builder.line(merged.email);
  }

  // 4. Document Series & Number
  builder.divider('.');
  builder.bold(true).size('double-height').line(displayTitle).size('normal');
  builder.bold(true).line(docNumber).bold(false);
  builder.divider('.');

  // 5. Sale Meta & Customer
  builder.align('left');
  builder.twoColumns('Fecha:', formatDatePE(sale.date));
  const operator =
    sale.cashierUsername ||
    sale.sellerName ||
    (sale as any).completedByName ||
    (sale as any).userName;
  if (operator) {
    builder.twoColumns('Cajero/Vend:', operator);
  }

  const customerMeta = resolveReceiptCustomerMeta(sale);
  if (customerMeta.name) {
    builder.line(`Cliente: ${customerMeta.name.toUpperCase()}`);
    if (customerMeta.identityNumber) {
      builder.line(`${customerMeta.docLabel}: ${customerMeta.identityNumber}`);
    }
    if (customerMeta.address) {
      builder.line(`Direccion: ${customerMeta.address.toUpperCase()}`);
    }
  }

  const { splits, paymentLabel } = resolveReceiptPayments(sale);
  builder.twoColumns('Forma de pago:', paymentLabel);

  if (splits.length > 1 && !isCompact) {
    for (const split of splits) {
      builder.twoColumns(`  - ${split.label.toUpperCase()}:`, formatPEN(split.amount));
    }
  }

  // 6. Products Table (2-line SKU format)
  builder.divider('.');
  builder.bold(true).twoColumns('SKU   CANT   PRECIO', 'TOTAL').bold(false);
  builder.divider('.');

  for (const item of sale.items || []) {
    const qty = Number(item.quantity) || 1;
    const price = Number(item.price) || 0;
    const total = Number(item.lineTotal ?? qty * price);
    const presentationName = item.presentation?.name || (item as any).presentationName;
    const variantName = item.variant?.name || (item as any).variantName;
    const presentationSuffix = presentationName ? ` (${presentationName})` : '';
    const variantSuffix = variantName ? ` [${variantName}]` : '';
    builder.line(`${item.name}${presentationSuffix}${variantSuffix}`);
    const skuPrefix = item.sku ? `${item.sku} ` : '';
    const unitStr = (item.unitOfMeasure || 'UND').trim().toUpperCase();
    builder.twoColumns(`${skuPrefix}${qty} ${unitStr} x ${price.toFixed(2)}`, formatPEN(total));
    if (Number((item as any).discount) > 0) {
      builder.twoColumns('  Desc. item:', `-${formatPEN(Number((item as any).discount))}`);
    }
  }

  // 7. Totals & Tax Breakdown
  builder.divider('.');
  const amounts = receiptAmountsForSale(sale, sale.fiscalAmounts, options.taxProfile);
  const igvPct =
    amounts.taxed > 0 && amounts.igv > 0 ? Math.round((amounts.igv / amounts.taxed) * 100) : 18;
  const shippingAmount = Math.round((Number(sale.shippingAmount) || 0) * 100) / 100;

  if ((sale.discountAmount || 0) > 0) {
    builder.twoColumns('Descuento:', `-${formatPEN(sale.discountAmount!)}`);
  }
  if (shippingAmount > 0) {
    builder.twoColumns('Envio:', formatPEN(shippingAmount));
  }

  if (isFiscal) {
    if (amounts.taxed > 0) {
      builder.twoColumns('Op. Gravada:', formatPEN(amounts.taxed));
      if (amounts.igv > 0) {
        builder.twoColumns(`IGV (${igvPct}%):`, formatPEN(amounts.igv));
      }
    }
    if (amounts.exempt > 0) {
      builder.twoColumns('Op. Exonerada:', formatPEN(amounts.exempt));
    }
    if (amounts.unaffected > 0) {
      builder.twoColumns('Op. Inafecta:', formatPEN(amounts.unaffected));
    }
    if (amounts.otherTaxes > 0) {
      builder.twoColumns('Otros cargos:', formatPEN(amounts.otherTaxes));
    }
    if (
      amounts.taxed === 0 &&
      amounts.exempt === 0 &&
      amounts.unaffected === 0 &&
      amounts.igv === 0
    ) {
      builder.twoColumns('Subtotal:', formatPEN(amounts.subtotal));
    }
  } else {
    builder.twoColumns('Subtotal:', formatPEN(sale.subtotal || amounts.subtotal || amounts.total));
  }

  builder.divider('.');
  builder.bold(true).size('double-height');
  builder.twoColumns('TOTAL:', formatPEN(amounts.total || sale.total));
  builder.size('normal').bold(false);

  if ((sale.surchargeAmount || 0) > 0) {
    builder.twoColumns('Recargo:', formatPEN(sale.surchargeAmount!));
    builder.bold(true).twoColumns('TOTAL COBRADO:', formatPEN(sale.chargedAmount ?? sale.total + sale.surchargeAmount!)).bold(false);
  }

  const depositInfo = (sale as any).depositInfo;
  if (depositInfo && (Number(depositInfo.appliedAmount) > 0 || Number(depositInfo.depositAmount) > 0)) {
    const applied = Number(depositInfo.appliedAmount ?? depositInfo.depositAmount ?? 0);
    const remaining = Number(
      depositInfo.remainingAmount ?? depositInfo.remainingBalance ?? Math.max(0, (amounts.total || sale.total) - applied)
    );
    builder.divider('.');
    if (Number(depositInfo.originalTotal) > 0) {
      builder.twoColumns('Total original:', formatPEN(Number(depositInfo.originalTotal)));
    }
    builder.twoColumns('Adelanto Aplicado:', formatPEN(applied));
    builder.twoColumns('Saldo Pendiente:', formatPEN(remaining));
  }

  // 8. Cash Received & Change
  if (sale.cashReceived && sale.cashReceived > 0) {
    builder.divider('.');
    builder.twoColumns('Efectivo Recibido:', formatPEN(sale.cashReceived));
    builder.twoColumns('Vuelto:', formatPEN(sale.changeGiven ?? Math.max(0, sale.cashReceived - (sale.chargedAmount ?? sale.total))));
  }

  // 9. Amount in Words & Tax Legends
  const rawWords = (sale as any).amountInWords || numberToSpanishWordsPEN(amounts.total || sale.total);
  const wordsLine = String(rawWords).toUpperCase().startsWith('SON:')
    ? String(rawWords)
    : `SON: ${rawWords}`;
  builder.divider('.');
  builder.align('center').bold(true).line(wordsLine).bold(false);

  if (isFiscal && amounts.isAmazonExempt) {
    builder.line('BIENES TRANSFERIDOS EN LA AMAZONIA REGION SELVA PARA SER CONSUMIDOS EN LA MISMA');
  }

  // 10. QR Code & Hash
  const consultUrl = options.consultUrl || merged.consultUrl || sale.consultUrl || 'https://ventify.com.pe/comprobantes';
  const qrData = buildSaleQrContent(
    isOfflinePending ? { ...sale, isOfflinePending: true } : sale,
    {
      emitterRuc: merged.ruc,
      consultUrl,
      taxProfile: options.taxProfile,
      precomputedAmounts: amounts,
    }
  );

  if (qrData) {
    builder.divider('.');
    builder.feed(1);
    builder.qr(qrData, is58 ? 4 : 5);
    builder.feed(1);
  }

  const sunatHash = (sale as any).sunatHash || (sale as any).hash || (sale as any).digestValue;
  if (sunatHash && !isCompact) {
    builder.line(`Hash: ${sunatHash}`);
  }

  // 11. Footer & Consultation URL
  builder.divider('.');
  builder.line('Consulta tu comprobante en:');
  builder.bold(true).line(consultUrl).bold(false);

  if (isFiscal && !isCompact) {
    const authText =
      sale.printedFormatResolution ||
      merged.printedFormatResolution ||
      merged.sunatResolution ||
      merged.authorizationText ||
      'Representacion impresa del comprobante electronico';
    builder.line(authText);
  }

  const footer = options.receiptFooter || merged.receiptFooter || sale.footerNote || 'GRACIAS POR SU PREFERENCIA!';
  builder.feed(1);
  builder.bold(true).line(footer).bold(false);
  builder.divider('.');

  // 12. Paper Cut
  if (options.autoCut !== false) {
    builder.cut(true, isCompact ? 2 : 4);
  }

  return builder.build();
}

// ============================================================================
// 5. CASH REGISTER CLOSURE (CORTE Z) ESC/POS BUILDER
// ============================================================================

/**
 * Builds binary ESC/POS thermal ticket for Cash Register Shift Closure (Corte Z).
 */
export function buildCashClosureEscPos(
  session: CashRegisterSession,
  closureData: CashClosureData = {},
  business: Partial<BusinessSettings & Branch> = {},
  options: EscPosOptions = {}
): Uint8Array {
  const builder = new EscPosBuilder(options);

  if (options.openDrawer) {
    builder.openCashDrawer();
  }

  builder.align('center');
  const businessName = business.businessName || business.name || 'VENTIFY POS';
  builder.bold(true).size('double-height').line(businessName).size('normal').bold(false);

  if (business.ruc) {
    builder.line(`RUC: ${business.ruc}`);
  }

  builder.divider('=');
  builder.bold(true).size('double').line('CIERRE DE CAJA').line('(CORTE Z)').size('normal').bold(false);
  builder.divider('=');

  builder.align('left');
  builder.twoColumns('Caja:', session.registerName || session.registerId || 'Caja 01');
  builder.twoColumns('Sesion ID:', session.id ? session.id.slice(0, 12) : 'N/A');
  builder.twoColumns('Cajero:', session.startedByName || session.startedBy || 'N/A');
  builder.twoColumns('Apertura:', formatDatePE(session.openTime));
  builder.twoColumns('Cierre:', formatDatePE(session.closeTime || Date.now()));

  builder.divider('-');
  builder.bold(true).line('RESUMEN DE FONDOS').bold(false);
  builder.twoColumns('Fondo Inicial (Apertura):', formatPEN(session.initialAmount));

  builder.divider('-');
  builder.bold(true).line('VENTAS POR METODO DE PAGO').bold(false);
  builder.twoColumns('Ventas Efectivo:', formatPEN(session.cashSales));
  builder.twoColumns('Ventas Tarjeta:', formatPEN(session.cardSales));
  builder.twoColumns('Ventas Digitales (Yape/Plin):', formatPEN(session.digitalSales));
  if (session.creditSales !== undefined && session.creditSales > 0) {
    builder.twoColumns('Ventas Fiado / Credito:', formatPEN(session.creditSales));
  }
  builder.twoColumns('Total Ventas:', formatPEN(session.totalSales));
  builder.twoColumns('Total Transacciones:', String(session.transactionCount || 0));

  builder.divider('-');
  builder.bold(true).line('MOVIMIENTOS DE CAJA').bold(false);
  const incomes = closureData.totalIncomes ?? 0;
  const expenses = closureData.totalExpenses ?? 0;
  builder.twoColumns('Ingresos Extra:', formatPEN(incomes));
  builder.twoColumns('Egresos / Gastos:', formatPEN(expenses));

  builder.divider('-');
  builder.bold(true).size('double-height').line('ARQUEO DE EFECTIVO').size('normal').bold(false);
  const expected = session.expectedAmount ?? closureData.expectedAmount ?? (session.initialAmount + session.cashSales + incomes - expenses);
  const counted = session.countedAmount ?? closureData.countedAmount ?? expected;
  const diff = session.difference ?? closureData.difference ?? (counted - expected);

  builder.twoColumns('Efectivo Esperado:', formatPEN(expected));
  builder.bold(true).twoColumns('Efectivo Recontado:', formatPEN(counted)).bold(false);

  builder.bold(true);
  if (diff === 0) {
    builder.twoColumns('Diferencia:', 'S/ 0.00 (CUADRADO)');
  } else if (diff > 0) {
    builder.twoColumns('Diferencia (Sobrante):', `+${formatPEN(diff)}`);
  } else {
    builder.twoColumns('Diferencia (Faltante):', formatPEN(diff));
  }
  builder.bold(false);

  builder.divider('.');
  builder.feed(2);
  builder.align('center');
  builder.line('_____________________________');
  builder.line(session.startedByName || 'Firma Cajero');
  builder.feed(2);
  builder.line('_____________________________');
  builder.line('Firma Supervisor / Administrador');
  builder.feed(1);
  builder.divider('=');

  if (options.autoCut !== false) {
    builder.cut(true, 3);
  }

  return builder.build();
}

// ============================================================================
// 6. CLEAN 80MM HTML TICKET RENDERER (EXPO-PRINT)
// ============================================================================

/**
 * Builds standalone, pixel-perfect 80mm HTML receipt string for expo-print.
 * Renders native PDF or prints wirelessly using iOS AirPrint & Android Print Service.
 */
export function buildReceiptHtml(
  sale: Sale,
  business: Partial<BusinessSettings & Branch> = {},
  options: EscPosOptions = {}
): string {
  const is58 = is58PaperWidth(options.paperWidth);
  const paperMm = is58 ? 58 : 80;
  const maxWidth = is58 ? '220px' : '300px';
  const isCompact = options.ticketTemplate === 'compact';
  const merged = { ...(business || {}), ...(options.branch || {}) } as Partial<BusinessSettings & Branch> & {
    razonSocial?: string;
    commercialName?: string;
    email?: string;
    receiptLogoUrl?: string;
    sunatResolution?: string;
    authorizationText?: string;
    printedFormatResolution?: string;
  };

  const {
    isOfflinePending,
    isFiscal,
    displayTitle,
    docNumber,
  } = resolveReceiptDocumentMeta(sale);

  const amounts = receiptAmountsForSale(sale, sale.fiscalAmounts, options.taxProfile);
  const igvPct =
    amounts.taxed > 0 && amounts.igv > 0 ? Math.round((amounts.igv / amounts.taxed) * 100) : 18;
  const rawWords = (sale as any).amountInWords || numberToSpanishWordsPEN(amounts.total || sale.total);
  const words = String(rawWords).toUpperCase().startsWith('SON:')
    ? String(rawWords)
    : `SON: ${rawWords}`;

  const businessName = merged.commercialName || merged.businessName || merged.name || 'VENTIFY POS';
  const consultUrl = options.consultUrl || merged.consultUrl || sale.consultUrl || 'https://ventify.com.pe/comprobantes';
  const footer = options.receiptFooter || merged.receiptFooter || sale.footerNote || '¡Gracias por su compra!';
  const logoUrl =
    (merged as any).receiptLogoDataUrl ||
    (merged as any).receiptLogo ||
    merged.receiptLogoUrl ||
    (merged as any).logoUrl;
  const fiscalAddress = merged.fiscalAddress || merged.address;
  const storeAddress = merged.commercialAddress;
  const operator =
    sale.cashierUsername ||
    sale.sellerName ||
    (sale as any).completedByName ||
    (sale as any).userName;

  const qrData = buildSaleQrContent(
    isOfflinePending ? { ...sale, isOfflinePending: true } : sale,
    {
      emitterRuc: merged.ruc,
      consultUrl,
      taxProfile: options.taxProfile,
      precomputedAmounts: amounts,
    }
  );
  const qrSvg = qrData ? buildQrSvgMarkup(qrData, is58 ? 96 : 112, 2) : '';
  const sunatHash = (sale as any).sunatHash || (sale as any).hash || (sale as any).digestValue;
  const { splits, paymentLabel } = resolveReceiptPayments(sale);
  const customerMeta = resolveReceiptCustomerMeta(sale);
  const depositInfo = (sale as any).depositInfo;
  const shippingAmount = Math.round((Number(sale.shippingAmount) || 0) * 100) / 100;

  const itemsRows = (sale.items || [])
    .map((item: CartItem) => {
      const qty = Number(item.quantity) || 1;
      const price = Number(item.price) || 0;
      const total = Number(item.lineTotal ?? qty * price);
      const presentationName = item.presentation?.name || (item as any).presentationName;
      const variantName = item.variant?.name || (item as any).variantName;
      const presentationSuffix = presentationName ? ` (${escapeHtml(String(presentationName))})` : '';
      const variantSuffix = variantName ? ` [${escapeHtml(String(variantName))}]` : '';
      const sku = escapeHtml(String(item.sku || '-'));
      const unitStr = escapeHtml(String((item.unitOfMeasure || 'UND').trim().toUpperCase()));
      const itemDisc = Number((item as any).discount) || 0;
      return `
        <tr>
          <td colspan="4" style="text-align: left; padding: 4px 0 1px; font-weight: 700;">
            ${escapeHtml(item.name)}${presentationSuffix}${variantSuffix}
          </td>
        </tr>
        <tr style="font-size: ${is58 ? '10px' : '11px'}; color: #333; border-bottom: 1px dotted #ddd;">
          <td style="padding: 0 4px 4px 0;">${sku}</td>
          <td style="padding: 0 4px 4px 0;">${qty} ${unitStr}</td>
          <td style="text-align: right; padding: 0 4px 4px 0;">${price.toFixed(2)}</td>
          <td style="text-align: right; padding: 0 0 4px 0; font-weight: 700; color: #000;">S/ ${total.toFixed(2)}</td>
        </tr>
        ${
          itemDisc > 0
            ? `<tr><td colspan="4" style="text-align: right; font-size: 10px; color: #555; padding-bottom: 3px;">Desc. item: -S/ ${itemDisc.toFixed(2)}</td></tr>`
            : ''
        }
      `;
    })
    .join('');

  const splitsHtml =
    splits.length > 1
      ? splits
          .map(
            (s: { label: string; amount: number }) =>
              `<div class="row" style="font-size: 11px; color: #333;"><span>• ${escapeHtml(
                s.label
              )}</span><span>${formatPEN(s.amount)}</span></div>`
          )
          .join('')
      : '';

  const resolutionText =
    sale.printedFormatResolution ||
    merged.printedFormatResolution ||
    merged.sunatResolution ||
    merged.authorizationText ||
    'Representación impresa del comprobante electrónico';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Comprobante ${escapeHtml(docNumber)}</title>
  <style>
    @page {
      size: ${paperMm}mm auto;
      margin: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Courier New", monospace;
      font-size: ${is58 ? '11px' : '12.5px'};
      line-height: 1.35;
      color: #000;
      background: #fff;
      margin: 0 auto;
      padding: ${is58 ? '10px 8px' : '14px 12px'};
      max-width: ${maxWidth};
    }
    .center { text-align: center; }
    .bold { font-weight: 700; }
    .divider { border-top: 1px dashed #000; margin: 7px 0; }
    .row { display: flex; justify-content: space-between; margin: 2.5px 0; gap: 8px; }
    .table-items { width: 100%; border-collapse: collapse; margin: 6px 0; }
    .title { font-size: ${is58 ? '14px' : '15.5px'}; font-weight: 800; letter-spacing: 0.4px; }
    .total-title { font-size: ${is58 ? '14.5px' : '16.5px'}; font-weight: 800; }
  </style>
</head>
<body>
  <div class="center">
    ${isOfflinePending ? '<div class="bold" style="background: #000; color: #fff; padding: 2px 4px; margin-bottom: 4px;">*** OFFLINE PENDIENTE ***</div>' : ''}
    ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="Logo" style="max-width: ${is58 ? '105px' : '136px'}; max-height: 54px; object-fit: contain; margin: 0 auto 6px; display: block;" />` : ''}
    <div class="title">${escapeHtml(businessName)}</div>
    ${merged.razonSocial && merged.razonSocial !== businessName ? `<div style="font-size: 11px;">${escapeHtml(merged.razonSocial)}</div>` : ''}
    ${merged.description && !isCompact ? `<div style="font-size: 11px; margin-top: 2px; font-style: italic;">"${escapeHtml(merged.description)}"</div>` : ''}
    ${merged.ruc ? `<div class="bold" style="margin-top: 2px;">RUC: ${escapeHtml(merged.ruc)}</div>` : ''}
    ${fiscalAddress ? `<div style="font-size: 11px;">${escapeHtml(fiscalAddress)}</div>` : ''}
    ${storeAddress && storeAddress !== fiscalAddress ? `<div style="font-size: 11px;">Tienda: ${escapeHtml(storeAddress)}</div>` : ''}
    ${merged.commercialPhone || merged.phone ? `<div style="font-size: 11px;">Telf: ${escapeHtml(String(merged.commercialPhone || merged.phone))}</div>` : ''}
    ${!isCompact && merged.email ? `<div style="font-size: 11px;">${escapeHtml(merged.email)}</div>` : ''}
  </div>

  <div class="divider"></div>
  <div class="center bold title" style="font-size: ${is58 ? '12.5px' : '13.5px'};">${displayTitle}</div>
  <div class="center bold" style="font-size: ${is58 ? '12.5px' : '13.5px'};">${escapeHtml(docNumber)}</div>
  <div class="divider"></div>

  <div class="row"><span>Fecha:</span><span>${escapeHtml(formatDatePE(sale.date))}</span></div>
  ${operator ? `<div class="row"><span>Cajero/Vend:</span><span>${escapeHtml(String(operator))}</span></div>` : ''}
  ${customerMeta.name ? `
    <div style="margin-top: 4px;">
      <div class="bold">Cliente: ${escapeHtml(customerMeta.name.toUpperCase())}</div>
      ${customerMeta.identityNumber ? `<div>${customerMeta.docLabel}: ${escapeHtml(customerMeta.identityNumber)}</div>` : ''}
      ${customerMeta.address ? `<div>Dirección: ${escapeHtml(customerMeta.address)}</div>` : ''}
    </div>
  ` : ''}
  <div class="row" style="margin-top: 4px;">
    <span>Forma de Pago:</span>
    <span class="bold">${escapeHtml(paymentLabel)}</span>
  </div>
  ${splitsHtml}

  <div class="divider"></div>
  <table class="table-items">
    <thead>
      <tr style="border-bottom: 1px dashed #000; font-size: ${is58 ? '10px' : '11px'};">
        <th style="text-align: left; padding-bottom: 3px;">SKU</th>
        <th style="text-align: left; padding-bottom: 3px;">CANT</th>
        <th style="text-align: right; padding-bottom: 3px;">PRECIO</th>
        <th style="text-align: right; padding-bottom: 3px;">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows}
    </tbody>
  </table>

  <div class="divider"></div>
  ${(sale.discountAmount || 0) > 0 ? `<div class="row"><span>Descuento:</span><span>-${formatPEN(sale.discountAmount!)}</span></div>` : ''}
  ${shippingAmount > 0 ? `<div class="row"><span>Envío:</span><span>${formatPEN(shippingAmount)}</span></div>` : ''}
  ${isFiscal ? `
    ${amounts.taxed > 0 ? `
      <div class="row"><span>Op. Gravada:</span><span>${formatPEN(amounts.taxed)}</span></div>
      ${amounts.igv > 0 ? `<div class="row"><span>IGV (${igvPct}%):</span><span>${formatPEN(amounts.igv)}</span></div>` : ''}
    ` : ''}
    ${amounts.exempt > 0 ? `<div class="row"><span>Op. Exonerada:</span><span>${formatPEN(amounts.exempt)}</span></div>` : ''}
    ${amounts.unaffected > 0 ? `<div class="row"><span>Op. Inafecta:</span><span>${formatPEN(amounts.unaffected)}</span></div>` : ''}
    ${amounts.otherTaxes > 0 ? `<div class="row"><span>Otros cargos:</span><span>${formatPEN(amounts.otherTaxes)}</span></div>` : ''}
    ${amounts.taxed === 0 && amounts.exempt === 0 && amounts.unaffected === 0 && amounts.igv === 0 ? `
      <div class="row"><span>Subtotal:</span><span>${formatPEN(amounts.subtotal)}</span></div>
    ` : ''}
  ` : `
    <div class="row"><span>Subtotal:</span><span>${formatPEN(sale.subtotal || amounts.subtotal || amounts.total)}</span></div>
  `}
  <div class="divider"></div>
  <div class="row total-title" style="margin: 5px 0;">
    <span>TOTAL:</span>
    <span>${formatPEN(amounts.total || sale.total)}</span>
  </div>

  ${(sale.surchargeAmount || 0) > 0 ? `
    <div class="row"><span>Recargo:</span><span>${formatPEN(sale.surchargeAmount!)}</span></div>
    <div class="row bold"><span>TOTAL COBRADO:</span><span>${formatPEN(sale.chargedAmount ?? sale.total + sale.surchargeAmount!)}</span></div>
  ` : ''}

  ${depositInfo && (Number(depositInfo.appliedAmount) > 0 || Number(depositInfo.depositAmount) > 0) ? `
    <div class="divider"></div>
    ${Number(depositInfo.originalTotal) > 0 ? `<div class="row"><span>Total original:</span><span>${formatPEN(Number(depositInfo.originalTotal))}</span></div>` : ''}
    <div class="row"><span>Adelanto Aplicado:</span><span>${formatPEN(Number(depositInfo.appliedAmount ?? depositInfo.depositAmount ?? 0))}</span></div>
    <div class="row bold"><span>Saldo Pendiente:</span><span>${formatPEN(Number(depositInfo.remainingAmount ?? depositInfo.remainingBalance ?? Math.max(0, (amounts.total || sale.total) - Number(depositInfo.appliedAmount ?? depositInfo.depositAmount ?? 0))))}</span></div>
  ` : ''}

  ${sale.cashReceived && sale.cashReceived > 0 ? `
    <div class="divider"></div>
    <div class="row"><span>Efectivo Recibido:</span><span>${formatPEN(sale.cashReceived)}</span></div>
    <div class="row"><span>Vuelto:</span><span>${formatPEN(sale.changeGiven ?? Math.max(0, sale.cashReceived - (sale.chargedAmount ?? sale.total)))}</span></div>
  ` : ''}

  <div class="divider"></div>
  <div class="center bold" style="font-size: 11px; margin: 5px 0;">${escapeHtml(words)}</div>
  ${isFiscal && amounts.isAmazonExempt ? '<div class="center" style="font-size: 9.5px; margin-top: 4px;">BIENES TRANSFERIDOS EN LA AMAZONÍA REGIÓN SELVA PARA SER CONSUMIDOS EN LA MISMA</div>' : ''}

  ${qrSvg ? `<div class="divider"></div><div class="center" style="margin: 8px 0;">${qrSvg}</div>` : ''}
  ${sunatHash && !isCompact ? `<div class="center" style="font-size: 9.5px; color: #444; word-break: break-all;">Hash: ${escapeHtml(String(sunatHash))}</div>` : ''}

  <div class="divider"></div>
  <div class="center" style="font-size: 10.5px; margin-top: 6px;">
    <div>Consulta tu comprobante en:</div>
    <div class="bold" style="word-break: break-all;">${escapeHtml(consultUrl)}</div>
    ${isFiscal && !isCompact ? `<div style="font-size: 9.5px; color: #555; margin-top: 4px;">${escapeHtml(String(resolutionText))}</div>` : ''}
    <div class="bold" style="font-size: 12px; margin-top: 7px;">${escapeHtml(footer)}</div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Genera el HTML de impresión para un Comprobante de Reserva térmica (80mm/58mm).
 * Coincide exactamente con el comprobante de reserva de la versión web de Ventify.
 */
export function buildReservationReceiptHtml(
  reservation: any,
  business: Partial<BusinessSettings & Branch> = {}
): string {
  const isDelivered = reservation.status === 'completed' || reservation.status === 'delivered';
  const isCancelled = reservation.status === 'cancelled';
  const total = Number(reservation.total || 0);
  const deposit = Number(reservation.depositAmount || 0);
  const remaining = Math.max(0, total - deposit);
  const resNumber = reservation.reservationNumber
    ? String(reservation.reservationNumber).padStart(6, '0')
    : String(reservation.id || 'N/A').slice(-6).toUpperCase();
  const businessName = business.businessName || business.name || 'VENTIFY POS';
  const businessRuc = business.ruc || '20123456789';
  const businessAddress = business.address || business.commercialAddress || '';
  const businessPhone = business.phone || '';
  const customerName = reservation.customer?.name || reservation.customerName || 'Cliente General';
  const customerDoc = reservation.customer?.documentNumber || reservation.customer?.dni || reservation.customerDni || '';
  const customerPhone = reservation.customer?.phone || reservation.customerPhone || '';

  const createdDate = reservation.createdAt
    ? (typeof reservation.createdAt?.toDate === 'function' ? reservation.createdAt.toDate() : new Date(reservation.createdAt))
    : (reservation.date ? new Date(reservation.date) : new Date());

  const formattedDate = formatDatePE(createdDate);
  const formattedTime = Number.isNaN(createdDate.getTime())
    ? ''
    : `${String(createdDate.getHours()).padStart(2, '0')}:${String(createdDate.getMinutes()).padStart(2, '0')}`;
  const expiryDate = reservation.expiryDate
    ? (typeof reservation.expiryDate?.toDate === 'function' ? reservation.expiryDate.toDate() : new Date(reservation.expiryDate))
    : (reservation.pickupDate ? new Date(reservation.pickupDate) : null);

  const itemsRows = (reservation.items || [])
    .map((item: any) => {
      const qty = Number(item.quantity) || 1;
      const price = Number(item.price || item.unitPrice || 0);
      const lineTotal = Number(item.total || (qty * price));
      const name = item.productName || item.name || 'Producto';
      return `
        <tr>
          <td style="text-align: left; padding: 4px 0;">
            <div style="font-weight: bold;">${name}</div>
            <div style="font-size: 11px; color: #555;">${qty} x S/ ${price.toFixed(2)}</div>
          </td>
          <td style="text-align: right; vertical-align: top; padding: 4px 0; font-weight: bold;">
            S/ ${lineTotal.toFixed(2)}
          </td>
        </tr>
      `;
    })
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reserva #${resNumber}</title>
  <style>
    @page {
      size: 80mm auto;
      margin: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: 13px;
      line-height: 1.35;
      color: #000;
      background: #fff;
      margin: 0;
      padding: 16px 12px;
      max-width: 300px;
      margin: 0 auto;
    }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .divider { border-top: 1px dashed #000; margin: 8px 0; }
    .divider-double { border-top: 2px solid #000; margin: 8px 0; }
    .row { display: flex; justify-content: space-between; margin: 3px 0; }
    .table-items { width: 100%; border-collapse: collapse; margin: 8px 0; }
    .title { font-size: 16px; font-weight: 800; letter-spacing: 0.5px; }
    .badge-status {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 12px;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="center">
    <div class="title">${businessName}</div>
    ${businessAddress ? `<div style="font-size: 11px; color: #444;">${businessAddress}</div>` : ''}
    <div style="font-size: 11px; color: #444;">RUC: ${businessRuc}</div>
    ${businessPhone ? `<div style="font-size: 11px; color: #444;">Tel: ${businessPhone}</div>` : ''}
    <div class="divider"></div>
    <div class="bold" style="font-size: 14px; color: #1e40af;">COMPROBANTE DE RESERVA</div>
    <div class="bold" style="font-size: 15px; margin-top: 2px;">#${resNumber}</div>
    <div>
      <span class="badge-status" style="background: ${isDelivered ? '#dcfce7; color: #15803d;' : isCancelled ? '#fee2e2; color: #b91c1c;' : '#fef3c7; color: #b45309;'}">
        ${isDelivered ? 'ENTREGADO / COMPLETADO' : isCancelled ? 'CANCELADO' : 'PENDIENTE'}
      </span>
    </div>
  </div>

  <div class="divider"></div>
  <div class="row"><span>Fecha:</span><span>${formattedDate} ${formattedTime}</span></div>
  ${expiryDate ? `<div class="row"><span>Válida hasta:</span><span class="bold" style="color: #b91c1c;">${formatDatePE(expiryDate)}</span></div>` : ''}
  ${reservation.reservationDays ? `<div class="row"><span>Vigencia:</span><span>${reservation.reservationDays} días</span></div>` : ''}

  <div class="divider"></div>
  <div style="margin: 4px 0;">
    <div class="bold">CLIENTE:</div>
    <div>${customerName.toUpperCase()}</div>
    ${customerDoc ? `<div>DOC / DNI: ${customerDoc}</div>` : ''}
    ${customerPhone ? `<div>Teléfono: ${customerPhone}</div>` : ''}
  </div>

  <div class="divider"></div>
  <table class="table-items">
    <thead>
      <tr style="border-bottom: 1px dashed #000;">
        <th style="text-align: left; padding-bottom: 4px;">PRODUCTO</th>
        <th style="text-align: right; padding-bottom: 4px;">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows}
    </tbody>
  </table>

  <div class="divider"></div>
  <div class="row" style="font-size: 15px; font-weight: 800; margin: 4px 0;">
    <span>TOTAL RESERVA:</span>
    <span>${formatPEN(total)}</span>
  </div>

  <div class="divider"></div>
  <div class="center bold" style="margin-bottom: 4px;">ESTADO FINANCIERO</div>
  <div class="row" style="color: #15803d; font-weight: 600;">
    <span>✓ Adelanto / Seña:</span>
    <span>${formatPEN(deposit)}</span>
  </div>
  ${reservation.depositPaymentMethod || reservation.paymentMethod ? `
    <div class="row" style="font-size: 11px; color: #555;">
      <span>Método de adelanto:</span>
      <span>${(reservation.depositPaymentMethod || reservation.paymentMethod || 'Efectivo').toUpperCase()}</span>
    </div>
  ` : ''}

  <div class="row" style="font-size: 14px; font-weight: 800; margin-top: 4px; color: ${remaining > 0 ? '#b91c1c' : '#15803d'};">
    <span>${remaining > 0 ? '⏳ Saldo Pendiente:' : '✓ Saldo Cancelado:'}</span>
    <span>${formatPEN(remaining)}</span>
  </div>
  ${remaining > 0 && !isDelivered ? `
    <div class="center" style="font-size: 11px; color: #b45309; margin-top: 4px;">
      (A pagar al momento de recoger los productos)
    </div>
  ` : ''}

  ${reservation.notes ? `
    <div class="divider"></div>
    <div style="font-size: 11px; color: #444;">
      <span class="bold">Observaciones:</span> ${reservation.notes}
    </div>
  ` : ''}

  <div class="divider-double"></div>
  <div class="center" style="font-size: 11px;">
    <div>Conserve este comprobante para recoger sus productos.</div>
    <div class="bold" style="margin-top: 6px;">¡Gracias por su preferencia!</div>
  </div>
</body>
</html>
  `.trim();
}

