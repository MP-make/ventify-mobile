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
  calculateTaxTotals,
  numberToSpanishWordsPEN,
} from '../invoicing/types';
import { formatPEN, formatDatePE } from '../theme';

// ============================================================================
// 1. CONFIGURATION & INTERFACES
// ============================================================================

export interface EscPosOptions {
  /** Paper width: 80mm = ~48 cols, 58mm = ~32 cols */
  paperWidth?: 80 | 58;
  /** Automatically trigger partial paper cut at the end */
  autoCut?: boolean;
  /** Send electronic cash drawer kick pulse */
  openDrawer?: boolean;
  /** Layout template style */
  ticketTemplate?: 'standard' | 'compact';
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

// ============================================================================
// 2. ESC/POS BINARY BUILDER CLASS
// ============================================================================

export class EscPosBuilder {
  private buffer: number[] = [];
  public readonly cols: number;

  constructor(public readonly options: EscPosOptions = {}) {
    this.cols = options.paperWidth === 58 ? 32 : 48;
    this.init();
  }

  /** ESC @ - Initialize printer to default state */
  init(): this {
    this.buffer.push(0x1b, 0x40);
    return this;
  }

  /** ESC p - Open cash drawer (pin 2 pulse 50ms) */
  openCashDrawer(): this {
    this.buffer.push(0x1b, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }

  /** ESC a - Alignment (0: Left, 1: Center, 2: Right) */
  align(alignment: 'left' | 'center' | 'right'): this {
    const code = alignment === 'center' ? 0x01 : alignment === 'right' ? 0x02 : 0x00;
    this.buffer.push(0x1b, 0x61, code);
    return this;
  }

  /** ESC E - Bold emphasis toggle */
  bold(enable: boolean = true): this {
    this.buffer.push(0x1b, 0x45, enable ? 0x01 : 0x00);
    return this;
  }

  /** GS ! - Text character sizing */
  size(mode: 'normal' | 'double-height' | 'double-width' | 'double'): this {
    let n = 0x00;
    if (mode === 'double-height') n = 0x01;
    else if (mode === 'double-width') n = 0x10;
    else if (mode === 'double') n = 0x11;
    this.buffer.push(0x1d, 0x21, n);
    return this;
  }

  /** Strips diacritics and converts to printer-safe ASCII / CP437 */
  private sanitizeText(text: string): string {
    if (!text) return '';
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove accent marks
      .replace(/[ñ]/g, 'n')
      .replace(/[Ñ]/g, 'N')
      .replace(/[¿¡]/g, '')
      .replace(/•/g, '-')
      .replace(/[^\x20-\x7E\n\r]/g, ''); // ASCII printable only
  }

  /** Append raw sanitized text */
  text(str: string): this {
    const sanitized = this.sanitizeText(str);
    for (let i = 0; i < sanitized.length; i++) {
      this.buffer.push(sanitized.charCodeAt(i));
    }
    return this;
  }

  /** Append line with Line Feed (LF 0x0A) */
  line(str: string = ''): this {
    this.text(str);
    this.buffer.push(0x0a);
    return this;
  }

  /** ESC d - Feed N lines */
  feed(lines: number = 1): this {
    this.buffer.push(0x1b, 0x64, Math.max(1, lines));
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
    return this.line(`${cleanLeft}${' '.repeat(spaceCount)}${cleanRight}`);
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
    this.line(`  ${cleanName}`);
    return this;
  }

  /** Native ESC/POS QR Code Model 2 */
  qr(data: string, size: number = 4): this {
    const cleanData = this.sanitizeText(data);
    const len = cleanData.length + 3;
    const pL = len % 256;
    const pH = Math.floor(len / 256);

    // 1. Model 2
    this.buffer.push(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
    // 2. Module size (3..8)
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(8, Math.max(3, size)));
    // 3. Error correction level (M: 49)
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);
    // 4. Store data
    this.buffer.push(0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30);
    for (let i = 0; i < cleanData.length; i++) {
      this.buffer.push(cleanData.charCodeAt(i));
    }
    // 5. Print stored QR
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
    return this;
  }

  /** GS V - Paper Cut (partial cut) */
  cut(partial: boolean = true, feedLines: number = 3): this {
    this.feed(Math.max(1, feedLines));
    this.buffer.push(0x1d, 0x56, partial ? 0x42 : 0x41, 0x00);
    return this;
  }

  /** Returns raw binary buffer */
  build(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

// ============================================================================
// 3. BASE64 CONVERTER
// ============================================================================

/**
 * Encodes Uint8Array binary buffer to Base64 string
 * Safe for React Native native modules and Bluetooth bridges
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 32768; // 32KB chunks
  let binary = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, len));
    binary += String.fromCharCode.apply(null, chunk as any);
  }

  // In modern React Native / JS environments, btoa is available globally
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(binary, 'binary').toString('base64');
  }

  // Fallback to manual base64 encoder if btoa is unavailable
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  while (i < len) {
    const b1 = bytes[i++];
    const b2 = i < len ? bytes[i++] : 0;
    const b3 = i < len ? bytes[i++] : 0;

    const cp1 = b1 >> 2;
    const cp2 = ((b1 & 3) << 4) | (b2 >> 4);
    let cp3 = ((b2 & 15) << 2) | (b3 >> 6);
    let cp4 = b3 & 63;

    if (i - 1 > len) {
      cp3 = 64;
      cp4 = 64;
    } else if (i > len) {
      cp4 = 64;
    }

    result += chars[cp1] + chars[cp2] + (cp3 === 64 ? '=' : chars[cp3]) + (cp4 === 64 ? '=' : chars[cp4]);
  }
  return result;
}

/** Alias export */
export const toBase64 = uint8ArrayToBase64;

// ============================================================================
// 4. SALE RECEIPT ESC/POS BUILDER
// ============================================================================

/**
 * Builds binary ESC/POS ticket for sales and electronic invoices.
 * Includes Peruvian tax compliance protection: if a Factura or Boleta lacks
 * accepted CDR, it is safely degraded to "NOTA DE VENTA".
 */
export function buildSaleReceiptEscPos(
  sale: Sale,
  business: Partial<BusinessSettings & Branch> = {},
  options: EscPosOptions = {}
): Uint8Array {
  const builder = new EscPosBuilder(options);
  const isCompact = options.ticketTemplate === 'compact';

  // 1. Kick cash drawer if requested
  if (options.openDrawer) {
    builder.openCashDrawer();
  }

  // 2. Resolve fiscal title with anti-evasion / tax protection
  let rawDocType = String(sale.documentType || 'nota_venta').toLowerCase();
  let isFiscal = rawDocType === 'factura' || rawDocType === 'boleta' || rawDocType === '01' || rawDocType === '03';

  // Strict tax protection: if marked as Factura/Boleta without accepted CDR or offline pending, degrade to NOTA DE VENTA
  let displayTitle = 'NOTA DE VENTA';
  if (isFiscal) {
    if (sale.sunatStatus === 'accepted' && !sale.isOfflinePending) {
      displayTitle = rawDocType.includes('factura') || rawDocType === '01' ? 'FACTURA ELECTRONICA' : 'BOLETA DE VENTA ELECTRONICA';
    } else {
      displayTitle = 'NOTA DE VENTA';
      isFiscal = false;
    }
  } else if (rawDocType === 'cotizacion' || rawDocType === 'cot') {
    displayTitle = 'COTIZACION';
  }

  // 3. Business Header
  builder.align('center');
  if (sale.isOfflinePending) {
    builder.bold(true).line('*** OPERACION OFFLINE ***');
    builder.line('PENDIENTE DE SINCRONIZACION').bold(false);
    builder.divider('*');
  }

  const businessName = business.businessName || business.name || 'VENTIFY POS';
  builder.bold(true).size('double-height').line(businessName).size('normal').bold(false);

  if (business.description && !isCompact) {
    builder.line(`"${business.description}"`);
  }

  if (business.ruc) {
    builder.bold(true).line(`RUC: ${business.ruc}`).bold(false);
  }

  const storeAddress = business.commercialAddress || business.address;
  if (storeAddress) {
    builder.line(storeAddress);
  }
  if (business.commercialPhone || business.phone) {
    builder.line(`Telf: ${business.commercialPhone || business.phone}`);
  }

  // 4. Document Series & Number
  builder.divider('.');
  builder.bold(true).size('double-height').line(displayTitle).size('normal');
  const docNumber = sale.documentNumber || `V-${String(sale.saleNumber || 1).padStart(6, '0')}`;
  builder.bold(true).line(docNumber).bold(false);
  builder.divider('.');

  // 5. Sale Meta & Customer
  builder.align('left');
  builder.twoColumns('Fecha:', formatDatePE(sale.date));
  const operator = sale.cashierUsername || sale.sellerName;
  if (operator) {
    builder.twoColumns('Cajero/Vend:', operator);
  }

  if (sale.customerName) {
    builder.line(`Cliente: ${sale.customerName.toUpperCase()}`);
    if (sale.customerRuc) {
      builder.line(`RUC: ${sale.customerRuc}`);
    } else if (sale.customerDni) {
      builder.line(`DNI: ${sale.customerDni}`);
    }
    if (sale.customerAddress) {
      builder.line(`Direccion: ${sale.customerAddress.toUpperCase()}`);
    }
  }

  builder.twoColumns('Forma de pago:', (sale.paymentMethod || 'EFECTIVO').toUpperCase());

  // 6. Products Table
  builder.divider('.');
  builder.bold(true).line('CANT / PRECIO UNIT                TOTAL').bold(false);
  builder.divider('.');

  for (const item of sale.items || []) {
    const qty = Number(item.quantity) || 1;
    const price = Number(item.price) || 0;
    const total = Number(item.lineTotal ?? qty * price);
    builder.itemRow(item.name, qty, price, total, item.unitOfMeasure);
  }

  // 7. Totals & Tax Breakdown
  builder.divider('.');
  const taxInfo = calculateTaxTotals(sale.total);

  if (isFiscal) {
    builder.twoColumns('Op. Gravada (18%):', formatPEN(taxInfo.opGravada));
    builder.twoColumns('IGV (18%):', formatPEN(taxInfo.igv));
  } else {
    builder.twoColumns('Subtotal:', formatPEN(sale.subtotal || taxInfo.opGravada));
  }

  builder.divider('.');
  builder.bold(true).size('double-height');
  builder.twoColumns('TOTAL:', formatPEN(sale.total));
  builder.size('normal').bold(false);

  if ((sale.surchargeAmount || 0) > 0) {
    builder.twoColumns('Recargo:', formatPEN(sale.surchargeAmount!));
    builder.bold(true).twoColumns('TOTAL COBRADO:', formatPEN(sale.chargedAmount ?? sale.total + sale.surchargeAmount!)).bold(false);
  }

  // 8. Cash Received & Change
  if (sale.cashReceived && sale.cashReceived > 0) {
    builder.divider('.');
    builder.twoColumns('Efectivo Recibido:', formatPEN(sale.cashReceived));
    builder.twoColumns('Vuelto:', formatPEN(sale.changeGiven ?? Math.max(0, sale.cashReceived - (sale.chargedAmount ?? sale.total))));
  }

  // 9. Amount in Words
  const words = sale.amountInWords || numberToSpanishWordsPEN(sale.total);
  builder.divider('.');
  builder.align('center').bold(true).line(words).bold(false);

  // 10. QR Code
  builder.divider('.');
  let qrData = sale.qrContent;
  if (!qrData && isFiscal && business.ruc) {
    // Standard SUNAT QR string format
    const docTypeNum = displayTitle.includes('FACTURA') ? '01' : '03';
    const clientDocType = sale.customerRuc ? '6' : sale.customerDni ? '1' : '-';
    const clientDocNum = sale.customerRuc || sale.customerDni || '-';
    const dateFormatted = new Date(sale.date).toISOString().split('T')[0];
    qrData = `${business.ruc}|${docTypeNum}|${docNumber}|${taxInfo.igv.toFixed(2)}|${sale.total.toFixed(2)}|${dateFormatted}|${clientDocType}|${clientDocNum}|`;
  }

  if (qrData) {
    builder.feed(1);
    builder.qr(qrData, options.paperWidth === 58 ? 4 : 5);
    builder.feed(1);
  }

  // 11. Footer & Consultation URL
  const consultUrl = business.consultUrl || sale.consultUrl || 'https://ventify.com.pe/comprobantes';
  builder.line('Consulta tu comprobante en:');
  builder.bold(true).line(consultUrl).bold(false);

  const footer = business.receiptFooter || sale.footerNote || '¡GRACIAS POR SU PREFERENCIA!';
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
  business: Partial<BusinessSettings & Branch> = {}
): string {
  const isFiscal = sale.documentType === 'factura' || sale.documentType === 'boleta' || sale.documentType === '01' || sale.documentType === '03';
  const taxInfo = calculateTaxTotals(sale.total);
  const words = sale.amountInWords || numberToSpanishWordsPEN(sale.total);
  const docNumber = sale.documentNumber || `V-${String(sale.saleNumber || 1).padStart(6, '0')}`;
  const businessName = business.businessName || business.name || 'VENTIFY POS';
  const consultUrl = business.consultUrl || sale.consultUrl || 'https://ventify.com.pe/comprobantes';
  const footer = business.receiptFooter || sale.footerNote || '¡Gracias por su compra!';

  const itemsRows = (sale.items || [])
    .map((item: CartItem) => {
      const qty = Number(item.quantity) || 1;
      const price = Number(item.price) || 0;
      const total = Number(item.lineTotal ?? qty * price);
      return `
        <tr>
          <td style="text-align: left; padding: 4px 0;">
            <div style="font-weight: bold;">${item.name}</div>
            <div style="font-size: 11px; color: #555;">${qty} ${item.unitOfMeasure || 'UND'} x S/ ${price.toFixed(2)}</div>
          </td>
          <td style="text-align: right; vertical-align: top; padding: 4px 0; font-weight: bold;">
            S/ ${total.toFixed(2)}
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
  <title>Comprobante ${docNumber}</title>
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
    .total-title { font-size: 17px; font-weight: 800; }
  </style>
</head>
<body>
  <div class="center">
    ${sale.isOfflinePending ? '<div class="bold" style="background: #000; color: #fff; padding: 2px;">*** OFFLINE PENDIENTE ***</div>' : ''}
    <div class="title">${businessName}</div>
    ${business.description ? `<div style="font-size: 12px; margin-top: 2px;">"${business.description}"</div>` : ''}
    ${business.ruc ? `<div class="bold" style="margin-top: 2px;">RUC: ${business.ruc}</div>` : ''}
    ${business.commercialAddress || business.address ? `<div>${business.commercialAddress || business.address}</div>` : ''}
    ${business.commercialPhone || business.phone ? `<div>Telf: ${business.commercialPhone || business.phone}</div>` : ''}
  </div>

  <div class="divider"></div>
  <div class="center bold title" style="font-size: 14px;">
    ${isFiscal ? (String(sale.documentType).includes('factura') || sale.documentType === '01' ? 'FACTURA ELECTRONICA' : 'BOLETA DE VENTA ELECTRONICA') : 'NOTA DE VENTA'}
  </div>
  <div class="center bold" style="font-size: 14px;">${docNumber}</div>
  <div class="divider"></div>

  <div class="row"><span>Fecha:</span><span>${formatDatePE(sale.date)}</span></div>
  ${sale.cashierUsername || sale.sellerName ? `<div class="row"><span>Cajero/Vend:</span><span>${sale.cashierUsername || sale.sellerName}</span></div>` : ''}
  ${sale.customerName ? `
    <div style="margin-top: 4px;">
      <div class="bold">Cliente: ${sale.customerName.toUpperCase()}</div>
      ${sale.customerRuc ? `<div>RUC: ${sale.customerRuc}</div>` : ''}
      ${sale.customerDni ? `<div>DNI: ${sale.customerDni}</div>` : ''}
      ${sale.customerAddress ? `<div>Dirección: ${sale.customerAddress}</div>` : ''}
    </div>
  ` : ''}
  <div class="row" style="margin-top: 4px;"><span>Forma de Pago:</span><span class="bold">${(sale.paymentMethod || 'EFECTIVO').toUpperCase()}</span></div>

  <div class="divider"></div>
  <table class="table-items">
    <thead>
      <tr style="border-bottom: 1px dashed #000;">
        <th style="text-align: left; padding-bottom: 4px;">DETALLE</th>
        <th style="text-align: right; padding-bottom: 4px;">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows}
    </tbody>
  </table>

  <div class="divider"></div>
  ${isFiscal ? `
    <div class="row"><span>Op. Gravada (18%):</span><span>${formatPEN(taxInfo.opGravada)}</span></div>
    <div class="row"><span>IGV (18%):</span><span>${formatPEN(taxInfo.igv)}</span></div>
  ` : `
    <div class="row"><span>Subtotal:</span><span>${formatPEN(sale.subtotal || taxInfo.opGravada)}</span></div>
  `}
  <div class="divider"></div>
  <div class="row total-title" style="margin: 6px 0;">
    <span>TOTAL:</span>
    <span>${formatPEN(sale.total)}</span>
  </div>

  ${(sale.surchargeAmount || 0) > 0 ? `
    <div class="row"><span>Recargo:</span><span>${formatPEN(sale.surchargeAmount!)}</span></div>
    <div class="row bold"><span>TOTAL COBRADO:</span><span>${formatPEN(sale.chargedAmount ?? sale.total + sale.surchargeAmount!)}</span></div>
  ` : ''}

  ${sale.cashReceived && sale.cashReceived > 0 ? `
    <div class="divider"></div>
    <div class="row"><span>Efectivo Recibido:</span><span>${formatPEN(sale.cashReceived)}</span></div>
    <div class="row"><span>Vuelto:</span><span>${formatPEN(sale.changeGiven ?? Math.max(0, sale.cashReceived - (sale.chargedAmount ?? sale.total)))}</span></div>
  ` : ''}

  <div class="divider"></div>
  <div class="center bold" style="font-size: 11px; margin: 6px 0;">${words}</div>

  <div class="divider"></div>
  <div class="center" style="font-size: 11px; margin-top: 8px;">
    <div>Consulta tu comprobante en:</div>
    <div class="bold">${consultUrl}</div>
    <div class="bold" style="font-size: 13px; margin-top: 8px;">${footer}</div>
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
  const formattedTime = createdDate.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
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

