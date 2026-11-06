/**
 * Generador de comandos ESC/POS para impresoras térmicas (80mm y 58mm).
 * Produce buffers binarios Uint8Array compatibles con Epson, Star, Xprinter, POS-80, Bixolon, etc.
 */

export interface EscPosOptions {
  paperWidth?: 80 | 58; // 80mm = ~48 caracteres por línea, 58mm = ~32 caracteres por línea
  autoCut?: boolean;
  openDrawer?: boolean;
  ticketTemplate?: 'standard' | 'compact';
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
  sku?: string;
  unit?: string;
}

export interface EscPosReceiptData {
  businessName?: string;
  description?: string;
  address?: string;
  storeAddress?: string;
  fiscalAddress?: string;
  ruc?: string;
  phone?: string;
  email?: string;
  sellerName?: string;
  documentTitle: string; // 'FACTURA', 'BOLETA DE VENTA', 'NOTA DE PEDIDO'
  documentNumber: string;
  date: string;
  time: string;
  paymentMethod: string;
  customerName?: string;
  customerDocType?: string; // 'DNI' | 'RUC'
  customerDocNumber?: string;
  customerAddress?: string;
  items: ReceiptItem[];
  subtotal: number;
  tax?: number;
  fiscalAmounts?: import("../invoicing/types").InvoiceReceiptAmounts;
  total: number;
  amountInWords?: string;
  cashReceived?: number;
  changeGiven?: number;
  depositInfo?: {
    type: 'reservation' | 'order';
    number: number;
    originalTotal: number;
    depositAmount: number;
    remainingAmount: number;
  };
  footerNote?: string;
  consultUrl?: string;
  qrContent?: string;
  isOfflinePending?: boolean;
  isElectronicInvoice?: boolean;
  ticketTemplate?: 'standard' | 'compact';
  reference?: {
    type?: string;
    number?: string;
    reasonCode?: string;
    reasonDescription?: string;
  };
}

export class EscPosBuilder {
  private buffer: number[] = [];
  private cols: number;

  constructor(private options: EscPosOptions = {}) {
    this.cols = options.paperWidth === 58 ? 32 : 48;
    this.init();
  }

  /** Inicializar la impresora */
  init(): this {
    this.buffer.push(0x1b, 0x40); // ESC @
    return this;
  }

  /** Abrir cajón monedero (si está conectado) */
  openCashDrawer(): this {
    this.buffer.push(0x1b, 0x70, 0x00, 0x19, 0xfa); // ESC p 0 25 250
    return this;
  }

  /** Alineación */
  align(alignment: 'left' | 'center' | 'right'): this {
    const code = alignment === 'center' ? 0x01 : alignment === 'right' ? 0x02 : 0x00;
    this.buffer.push(0x1b, 0x61, code); // ESC a n
    return this;
  }

  /** Negrita */
  bold(enable: boolean = true): this {
    this.buffer.push(0x1b, 0x45, enable ? 0x01 : 0x00); // ESC E n
    return this;
  }

  /** Tamaño de texto */
  size(mode: 'normal' | 'double-height' | 'double-width' | 'double'): this {
    let n = 0x00;
    if (mode === 'double-height') n = 0x01;
    else if (mode === 'double-width') n = 0x10;
    else if (mode === 'double') n = 0x11;
    this.buffer.push(0x1d, 0x21, n); // GS ! n
    return this;
  }

  /** Normaliza texto en español para CP437/ASCII */
  private sanitizeText(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Quitar tildes compuestas
      .replace(/ñ/g, 'n')
      .replace(/Ñ/g, 'N')
      .replace(/•/g, '-')
      .replace(/[^\x20-\x7E\n\r]/g, ''); // Solo caracteres ASCII imprimibles
  }

  /** Agregar texto plano */
  text(str: string): this {
    const sanitized = this.sanitizeText(str);
    for (let i = 0; i < sanitized.length; i++) {
      this.buffer.push(sanitized.charCodeAt(i));
    }
    return this;
  }

  /** Agregar línea de texto con salto */
  line(str: string = ''): this {
    this.text(str);
    this.buffer.push(0x0a); // LF
    return this;
  }

  /** Salto de N líneas */
  feed(lines: number = 1): this {
    this.buffer.push(0x1b, 0x64, Math.max(1, lines)); // ESC d n
    return this;
  }

  /** Línea divisoria discontinua o sólida */
  divider(char: string = '-'): this {
    return this.line(char.repeat(this.cols));
  }

  /** Fila con dos columnas (etiqueta a la izquierda, valor a la derecha) */
  twoColumns(left: string, right: string): this {
    const cleanLeft = this.sanitizeText(left);
    const cleanRight = this.sanitizeText(right);
    const spaceCount = Math.max(1, this.cols - cleanLeft.length - cleanRight.length);
    return this.line(`${cleanLeft}${' '.repeat(spaceCount)}${cleanRight}`);
  }

  /** Fila de producto con SKU, cantidad, unidad, precio y total en 2 líneas */
  itemRow(name: string, qty: number, unitPrice: number, total: number, sku?: string, unit?: string): this {
    const skuStr = (sku || '').trim().toUpperCase();
    const unitStr = (unit || 'UND').trim().toUpperCase();
    const qtyUnitStr = `${qty} ${unitStr}`;
    const priceStr = unitPrice.toFixed(2);
    const totalStr = total.toFixed(2);

    // Línea 1: SKU   CANT   PRECIO   TOTAL
    if (skuStr) {
      const line1 = `${skuStr.padEnd(12)} ${qtyUnitStr.padStart(10)} ${priceStr.padStart(8)} ${totalStr.padStart(10)}`;
      this.line(line1);
    } else {
      const line1 = `${qtyUnitStr.padEnd(15)} ${priceStr.padStart(12)} ${totalStr.padStart(15)}`;
      this.line(line1);
    }

    // Línea 2: Descripción completa
    const cleanName = this.sanitizeText(name);
    this.line(`  ${cleanName}`);
    return this;
  }

  /** Imprimir Código QR nativo ESC/POS */
  qr(data: string, size: number = 5): this {
    const cleanData = this.sanitizeText(data);
    const len = cleanData.length + 3;
    const pL = len % 256;
    const pH = Math.floor(len / 256);

    // 1. Modelo 2
    this.buffer.push(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
    // 2. Tamaño del módulo (size: 1..16, típicamente 4..6)
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(10, Math.max(3, size)));
    // 3. Nivel de corrección de errores (M = 49)
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);
    // 4. Almacenar datos en el buffer de la impresora
    this.buffer.push(0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30);
    for (let i = 0; i < cleanData.length; i++) {
      this.buffer.push(cleanData.charCodeAt(i));
    }
    // 5. Imprimir el QR almacenado
    this.buffer.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
    return this;
  }

  /** Cortar papel */
  cut(partial: boolean = true, feedLines: number = 3): this {
    this.feed(Math.max(1, feedLines));
    // GS V 65 3 (alimenta N líneas y realiza corte parcial)
    this.buffer.push(0x1d, 0x56, partial ? 0x42 : 0x41, 0x00);
    return this;
  }

  /** Retorna los bytes binarios */
  build(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  /**
   * Construye el ticket completo de venta/comprobante a partir de los datos.
   */
  static buildReceipt(data: EscPosReceiptData, options: EscPosOptions = {}): Uint8Array {
    const builder = new EscPosBuilder(options);
    const isCompact = (options.ticketTemplate || data.ticketTemplate) === 'compact';

    if (options.openDrawer) {
      builder.openCashDrawer();
    }

    // Blindaje de Factura: Nunca imprimir 'FACTURA' ni 'FACTURA ELECTRONICA' sin aceptación y CDR
    let resolvedTitle = data.documentTitle;
    const isFacturaTitle = /FACTURA/i.test(resolvedTitle);
    if (isFacturaTitle && (data.isElectronicInvoice !== true || data.isOfflinePending)) {
      resolvedTitle = 'NOTA DE VENTA';
    }

    // ── Encabezado ──
    builder.align('center');
    if (data.isOfflinePending) {
      builder.bold(true).line('PENDIENTE DE SINCRONIZACION');
      builder.line('OPERACION OFFLINE - NO CONFIRMADA').bold(false);
      builder.divider('*');
    }
    if (data.description && !isCompact) {
      builder.bold(true).line(`"${data.description.replace(/^["'“”]|["'“”]$/g, '').trim()}"`).bold(false);
    }
    if (data.businessName) {
      builder.bold(true).size('double-height').line(data.businessName).size('normal').bold(false);
    }
    if (data.ruc) {
      builder.bold(true).line(`RUC: ${data.ruc}`).bold(false);
    }

    if (isCompact) {
      // Modo compacto: Imprime solo la dirección de la sucursal de venta (sin apilar la fiscal)
      const storeOnly = data.storeAddress || data.address;
      if (storeOnly) {
        builder.line(storeOnly);
      }
    } else {
      const mainAddress = data.fiscalAddress || data.address;
      if (mainAddress) {
        builder.line(mainAddress);
      }
      if (data.storeAddress && (!mainAddress || data.storeAddress.trim().toLowerCase() !== mainAddress.trim().toLowerCase())) {
        builder.line(mainAddress ? `Tienda: ${data.storeAddress}` : data.storeAddress);
      }
    }

    if (data.phone) {
      builder.line(`Telf. ${data.phone}`);
    }
    if (data.email && !isCompact) {
      builder.line(`E-mail: ${data.email}`);
    }

    // ── Título del comprobante ──
    builder.divider('.');
    builder.bold(true).size('double-height').line(resolvedTitle).size('normal');
    builder.bold(true).line(data.documentNumber).bold(false);
    builder.divider('.');

    // ── Datos de la venta ──
    builder.align('left');
    builder.twoColumns('Fecha:', `${data.date} ${data.time}`);
    if (data.sellerName) {
      builder.twoColumns('Vendedor:', data.sellerName);
    }
    if (data.customerName) {
      builder.line(`Cliente: ${data.customerName.toUpperCase()}`);
      if (data.customerDocNumber) {
        builder.line(`${data.customerDocType || 'Doc'}: ${data.customerDocNumber}`);
      }
      if (data.customerAddress) {
        builder.line(`Direccion: ${data.customerAddress.toUpperCase()}`);
      }
    }
    if (data.reference && data.reference.number) {
      const refDoc = data.reference.type === '01' ? 'Factura' : data.reference.type === '03' ? 'Boleta' : (data.reference.type || 'Doc');
      builder.line(`Doc. Modifica: ${refDoc} ${data.reference.number}`);
      const reason = data.reference.reasonDescription || data.reference.reasonCode;
      if (reason) {
        builder.line(`Motivo: ${reason}`);
      }
    }
    const isCreditNote = /NOTA DE CR/i.test(data.documentTitle);
    const isDebitNote = /NOTA DE DEB/i.test(data.documentTitle);
    const isNote = isCreditNote || isDebitNote;

    if (!isNote) {
      builder.twoColumns('Forma de pago:', 'CONTADO');
    }

    // ── Detalle de productos ──
    builder.divider('.');
    builder.bold(true).line('SKU          CANT      PRECIO     TOTAL').bold(false);
    builder.divider('.');

    for (const item of data.items) {
      builder.itemRow(item.name, item.quantity, item.price, item.total, item.sku, item.unit);
    }

    // ── Totales ──
    builder.divider('.');
    const isNotaNoFiscal = data.isElectronicInvoice === false || (!data.fiscalAmounts && !isNote && /NOTA/i.test(data.documentTitle));
    if (isNotaNoFiscal) {
      builder.twoColumns('Subtotal:', `S/ ${data.subtotal.toFixed(2)}`);
    } else if (data.fiscalAmounts) {
      const f = data.fiscalAmounts;
      const hasFiscal = f.taxed > 0 || f.exempt > 0 || f.unaffected > 0 || f.igv > 0 || (f.otherTaxes ?? 0) > 0;
      if (hasFiscal) {
        if (f.taxed > 0) builder.twoColumns('Op. Gravada:', `S/ ${f.taxed.toFixed(2)}`);
        if (f.exempt > 0) builder.twoColumns('Op. Exonerada:', `S/ ${f.exempt.toFixed(2)}`);
        if (f.unaffected > 0) builder.twoColumns('Op. Inafecta:', `S/ ${f.unaffected.toFixed(2)}`);
        if (f.igv > 0) builder.twoColumns('IGV:', `S/ ${f.igv.toFixed(2)}`);
        if (f.otherTaxes > 0) builder.twoColumns('Otros tributos:', `S/ ${f.otherTaxes.toFixed(2)}`);
      } else {
        builder.twoColumns('Subtotal:', `S/ ${data.subtotal.toFixed(2)}`);
      }
    } else if (data.tax !== undefined && data.tax > 0) {
      builder.twoColumns('Op. Gravada:', `S/ ${(data.subtotal).toFixed(2)}`);
      builder.twoColumns('IGV:', `S/ ${data.tax.toFixed(2)}`);
    } else {
      builder.twoColumns('Subtotal:', `S/ ${data.subtotal.toFixed(2)}`);
    }

    if (data.depositInfo) {
      builder.divider('.');
      const label = data.depositInfo.type === 'reservation' ? 'Reserva #' : 'Pedido #';
      builder.align('center').line(`Completando ${label}${data.depositInfo.number}`).align('left');
      builder.twoColumns('Total Original:', `S/ ${data.depositInfo.originalTotal.toFixed(2)}`);
      builder.twoColumns('Adelanto Pagado:', `S/ ${data.depositInfo.depositAmount.toFixed(2)}`);
      builder.twoColumns('Saldo Restante:', `S/ ${data.depositInfo.remainingAmount.toFixed(2)}`);
    }

    builder.bold(true).size('double-height');
    builder.twoColumns('Total:', `S/ ${data.total.toFixed(2)}`);
    builder.size('normal').bold(false);

    if (data.amountInWords) {
      builder.divider('.');
      builder.align('center').bold(true).line(`SON: ${data.amountInWords.toUpperCase()}`).bold(false).align('left');
    }

    if (!isNote) {
      builder.divider('.');
      builder.bold(true).twoColumns(`PAGO: ${data.paymentMethod.toUpperCase()}`, `S/ ${data.total.toFixed(2)}`).bold(false);
    }

    // ── Representación impresa y QR ──
    builder.divider('.');
    builder.align('center');
    if (data.isElectronicInvoice && !data.isOfflinePending && resolvedTitle !== 'NOTA DE VENTA') {
      builder.line(`Representacion impresa de la ${resolvedTitle}`);
    } else {
      builder.line('Documento no valido como comprobante fiscal');
      builder.line('Constancia de pedido interno');
    }

    if (data.qrContent) {
      if (!isCompact) builder.feed(1);
      builder.qr(data.qrContent, options.paperWidth === 58 ? 4 : 5);
      if (!isCompact) builder.feed(1);
    }

    builder.line('Consulta tu comprobante en');
    builder.bold(true).line(data.consultUrl || 'https://comprobantes.tandiashop.com/').bold(false);

    // Agradecimiento: si hay footerNote y ya incluye agradecimiento, o en modo compacto si footerNote existe, no duplicar
    const hasCustomFooter = Boolean(data.footerNote && data.footerNote.trim().length > 0);
    const customFooterHasThanks = hasCustomFooter && /gracias|agradece/i.test(data.footerNote!);

    if (hasCustomFooter) {
      if (!isCompact) builder.feed(1);
      builder.bold(true).line(data.footerNote!).bold(false);
    }

    if (!customFooterHasThanks && (!isCompact || !hasCustomFooter)) {
      if (!isCompact && !hasCustomFooter) builder.feed(1);
      builder.bold(true).line('¡¡GRACIAS POR SU COMPRA!!').bold(false);
    }

    builder.divider('.');
    builder.feed(isCompact ? 1 : 2);

    if (options.autoCut !== false) {
      builder.cut(true, isCompact ? 1 : 3);
    }

    return builder.build();
  }

  /**
   * Construye un ticket de prueba para diagnosticar la conexión.
   */
  static buildTestTicket(options: EscPosOptions = {}): Uint8Array {
    const builder = new EscPosBuilder(options);
    if (options.openDrawer) {
      builder.openCashDrawer();
    }
    builder.align('center');
    builder.bold(true).size('double-height').line('VENTIFY POS').size('normal').bold(false);
    builder.line('Prueba de Impresion Directa USB');
    builder.divider('=');
    builder.line(`Fecha: ${new Date().toLocaleDateString('es-ES')}`);
    builder.line(`Hora: ${new Date().toLocaleTimeString('es-ES')}`);
    builder.line(`Ancho: ${options.paperWidth === 58 ? '58mm (32 cols)' : '80mm (48 cols)'}`);
    builder.divider('-');
    builder.bold(true).line('CONEXION EXITOSA!').bold(false);
    builder.line('La ticketera responde correctamente');
    builder.divider('=');
    builder.feed(2);
    builder.cut(true);
    return builder.build();
  }
}
