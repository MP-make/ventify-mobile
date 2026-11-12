/**
 * Ventify Mobile - Thermal Printer & Universal Receipt Manager
 * 
 * Gestor multiplataforma de impresión térmica para Android e iOS:
 * 1. Conexión Bluetooth SPP nativa para impresoras térmicas de 58mm y 80mm.
 * 2. Generador de comandos binarios ESC/POS (Tickets de venta y Cierre Z).
 * 3. Impresión nativa universal para cualquier dispositivo Android/iOS vía `expo-print`.
 * 4. Envío de ticket digital en formato PDF por WhatsApp mediante `expo-sharing`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform, NativeModules, Linking } from 'react-native';
import {
  EscPosBuilder,
  buildSaleReceiptEscPos as coreBuildSaleReceiptEscPos,
  buildCashClosureEscPos as coreBuildCashClosureEscPos,
  buildReceiptHtml,
  type EscPosOptions,
  uint8ArrayToBase64,
} from '@/lib/printing/escpos-builder';

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
  unitOfMeasure?: string;
}

export interface EscPosReceiptData {
  businessName?: string;
  ruc?: string;
  address?: string;
  phone?: string;
  documentTitle: string;
  documentNumber: string;
  date: string;
  time?: string;
  sellerName?: string;
  customerName?: string;
  customerDocType?: string;
  customerDocNumber?: string;
  customerAddress?: string;
  paymentMethod: string;
  items: ReceiptItem[];
  subtotal: number;
  tax?: number;
  total: number;
  cashReceived?: number;
  changeGiven?: number;
  amountInWords?: string;
  consultUrl?: string;
  footerNote?: string;
}

// ============================================================================
// CONSTANTES Y CLAVES DE CONFIGURACIÓN
// ============================================================================

export const PRINTER_CONFIG_STORAGE_KEY = 'ventify_printer_config_v2';

// ============================================================================
// TIPOS E INTERFACES
// ============================================================================

export interface BluetoothPrinterDevice {
  name: string;
  address: string;
}

export type PrinterPaperWidth = 58 | 80;
export type PrinterConnectionType = 'bluetooth' | 'system_pdf';

export interface PrinterConfig {
  paperWidth: PrinterPaperWidth;
  selectedDevice: BluetoothPrinterDevice | null;
  autoCut: boolean;
  openCashDrawer: boolean;
  copies: number;
  connectionType: PrinterConnectionType;
}

export interface CashClosureReceiptData {
  businessName?: string;
  branchName?: string;
  ruc?: string;
  address?: string;
  phone?: string;
  closureNumber?: string;
  sessionId: string;
  openedAt: string;
  closedAt: string;
  cashierName: string;
  initialAmount: number;
  cashSales: number;
  digitalSales: {
    yape: number;
    plin: number;
    card: number;
    transfer: number;
    total: number;
  };
  creditSales: number;
  totalSales: number;
  manualIncomes: number;
  manualExpenses: number;
  expectedAmount: number;
  countedAmount: number;
  difference: number;
  salesCount: number;
  notes?: string;
}

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  paperWidth: 80,
  selectedDevice: null,
  autoCut: true,
  openCashDrawer: false,
  copies: 1,
  connectionType: 'system_pdf',
};

// ============================================================================
// GESTOR DE CONFIGURACIÓN DE IMPRESORA
// ============================================================================

/**
 * Obtiene la configuración de impresora persistida en AsyncStorage
 */
export const getPrinterConfig = async (): Promise<PrinterConfig> => {
  try {
    const raw = await AsyncStorage.getItem(PRINTER_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_PRINTER_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PRINTER_CONFIG,
      ...parsed,
    };
  } catch (err) {
    console.error('[ThermalPrinterService] Error leyendo configuración:', err);
    return DEFAULT_PRINTER_CONFIG;
  }
};

/**
 * Guarda o actualiza la configuración de impresora en AsyncStorage
 */
export const savePrinterConfig = async (
  partial: Partial<PrinterConfig>
): Promise<PrinterConfig> => {
  try {
    const current = await getPrinterConfig();
    const updated: PrinterConfig = {
      ...current,
      ...partial,
    };
    await AsyncStorage.setItem(PRINTER_CONFIG_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch (err) {
    console.error('[ThermalPrinterService] Error guardando configuración:', err);
    throw err;
  }
};

// ============================================================================
// CONEXIÓN Y ESCANEO BLUETOOTH
// ============================================================================

/**
 * Convierte un Uint8Array a cadena Base64 centralizada en escpos-builder.ts
 */
export { uint8ArrayToBase64 };

/**
 * Escanea o lista las impresoras térmicas Bluetooth vinculadas en el sistema
 */
export const scanBluetoothPrinters = async (): Promise<BluetoothPrinterDevice[]> => {
  if (Platform.OS === 'android') {
    const nativePlugin = NativeModules.ThermalPrinter;
    if (nativePlugin && typeof nativePlugin.getPairedPrinters === 'function') {
      try {
        const res = await nativePlugin.getPairedPrinters();
        if (Array.isArray(res?.devices)) {
          return res.devices;
        }
      } catch (e) {
        console.warn('[ThermalPrinterService] Error consultando ThermalPrinter nativo:', e);
      }
    }
  }

  // Lista de diagnóstico o fallback simulado para desarrollo / Expo Go
  return [
    { name: 'Impresora Bluetooth Térmica (Detectada)', address: '00:11:22:33:44:55' },
    { name: 'POS-80 Series', address: '66:77:88:99:AA:BB' },
  ];
};

/**
 * Envía un buffer binario ESC/POS a la impresora térmica Bluetooth
 */
export const printRawEscPos = async (
  bytes: Uint8Array,
  deviceAddress?: string
): Promise<boolean> => {
  const config = await getPrinterConfig();
  const address = deviceAddress || config.selectedDevice?.address;

  if (Platform.OS === 'android') {
    const nativePlugin = NativeModules.ThermalPrinter;
    if (nativePlugin && typeof nativePlugin.printRaw === 'function' && address) {
      try {
        const base64Data = uint8ArrayToBase64(bytes);
        let timeoutHandle: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error('Timeout de impresión térmica Bluetooth (6 segundos excedidos)'));
          }, 6000);
        });

        const printPromise = nativePlugin.printRaw({ address, base64Data });

        try {
          const res = await Promise.race([printPromise, timeoutPromise]);
          return res?.success ?? true;
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (err) {
        console.error('[ThermalPrinterService] Error en printRaw nativo:', err);
        throw err;
      }
    }
  }

  console.log(`[ThermalPrinterService] Simulación ESC/POS (${bytes.length} bytes enviados a ${address || 'default'})`);
  return true;
};

// ============================================================================
// CONSTRUCCIÓN DE TICKETS ESC/POS
// ============================================================================

/**
 * Construye el buffer binario ESC/POS para un ticket de venta
 */
export const buildSaleReceiptEscPos = (
  saleOrData: any,
  businessOrOptions?: any,
  maybeOptions?: EscPosOptions
): Uint8Array => {
  if (maybeOptions || (businessOrOptions && ('businessName' in businessOrOptions || 'ruc' in businessOrOptions || 'name' in businessOrOptions))) {
    return coreBuildSaleReceiptEscPos(saleOrData, businessOrOptions || {}, maybeOptions || {});
  }
  return coreBuildSaleReceiptEscPos(saleOrData, {}, businessOrOptions || {});
};

/**
 * Construye el buffer binario ESC/POS para el Cierre de Caja (Arqueo Z)
 */
export const buildCashClosureEscPos = (
  closureOrSession: any,
  closureDetailsOrOptions: any = {},
  business: any = {},
  maybeOptions: EscPosOptions = {}
): Uint8Array => {
  if (business && Object.keys(business).length > 0) {
    return coreBuildCashClosureEscPos(closureOrSession, closureDetailsOrOptions, business, maybeOptions);
  }
  const options: EscPosOptions = closureDetailsOrOptions || {};
  const closure: CashClosureReceiptData = closureOrSession;
  const builder = new EscPosBuilder(options);

  if (options.openDrawer) {
    builder.openCashDrawer();
  }

  // 1. Cabecera del negocio
  builder.align('center');
  if (closure.businessName) {
    builder.bold(true).size('double-height').line(closure.businessName.toUpperCase()).size('normal').bold(false);
  }
  if (closure.branchName) {
    builder.bold(true).line(`SUCURSAL: ${closure.branchName.toUpperCase()}`).bold(false);
  }
  if (closure.ruc) {
    builder.line(`RUC: ${closure.ruc}`);
  }
  if (closure.address) {
    builder.line(closure.address);
  }
  if (closure.phone) {
    builder.line(`Teléfono: ${closure.phone}`);
  }

  // 2. Título del Reporte Z
  builder.divider('=');
  builder.bold(true).size('double-height').line('CIERRE DE CAJA (Z)').size('normal');
  if (closure.closureNumber) {
    builder.line(`Reporte N°: ${closure.closureNumber}`);
  }
  builder.divider('=');

  // 3. Metadata del Turno
  builder.align('left');
  builder.twoColumns('Cajero:', closure.cashierName || 'No especificado');
  builder.twoColumns('Apertura:', closure.openedAt || '');
  builder.twoColumns('Cierre:', closure.closedAt || '');
  builder.twoColumns('Sesión ID:', (closure.sessionId || '').slice(-8));

  // 4. Detalle de Ventas
  builder.divider('-');
  builder.bold(true).line('VENTAS POR FORMA DE PAGO').bold(false);
  builder.divider('-');
  builder.twoColumns('Ventas Efectivo:', `S/ ${(closure.cashSales || 0).toFixed(2)}`);
  builder.twoColumns('Ventas Tarjeta:', `S/ ${(closure.digitalSales?.card || 0).toFixed(2)}`);
  builder.twoColumns('Ventas Yape:', `S/ ${(closure.digitalSales?.yape || 0).toFixed(2)}`);
  builder.twoColumns('Ventas Plin:', `S/ ${(closure.digitalSales?.plin || 0).toFixed(2)}`);
  if ((closure.digitalSales?.transfer || 0) > 0) {
    builder.twoColumns('Ventas Transferencia:', `S/ ${closure.digitalSales.transfer.toFixed(2)}`);
  }
  if ((closure.creditSales || 0) > 0) {
    builder.twoColumns('Ventas al Fiado:', `S/ ${closure.creditSales.toFixed(2)}`);
  }
  builder.bold(true);
  builder.twoColumns('TOTAL VENDIDO:', `S/ ${(closure.totalSales || 0).toFixed(2)}`);
  builder.bold(false);
  builder.twoColumns('Total Transacciones:', String(closure.salesCount || 0));

  // 5. Movimientos de Caja Chica
  builder.divider('-');
  builder.bold(true).line('FLUJO DE EFECTIVO EN GAVETA').bold(false);
  builder.divider('-');
  builder.twoColumns('(+) Saldo Inicial:', `S/ ${(closure.initialAmount || 0).toFixed(2)}`);
  builder.twoColumns('(+) Ventas Efectivo:', `S/ ${(closure.cashSales || 0).toFixed(2)}`);
  builder.twoColumns('(+) Ingresos Manuales:', `S/ ${(closure.manualIncomes || 0).toFixed(2)}`);
  builder.twoColumns('(-) Gastos/Retiros:', `S/ ${(closure.manualExpenses || 0).toFixed(2)}`);
  builder.divider('.');

  // 6. Arqueo y Diferencia
  builder.bold(true);
  builder.twoColumns('EFECTIVO ESPERADO:', `S/ ${(closure.expectedAmount || 0).toFixed(2)}`);
  builder.twoColumns('EFECTIVO CONTADO:', `S/ ${(closure.countedAmount || 0).toFixed(2)}`);
  builder.size('double-height');

  const diff = closure.difference || 0;
  let diffLabel = 'CUADRE EXACTO:';
  if (diff > 0) diffLabel = 'SOBRANTE (+):';
  if (diff < 0) diffLabel = 'FALTANTE (-):';

  builder.twoColumns(diffLabel, `S/ ${Math.abs(diff).toFixed(2)}`);
  builder.size('normal').bold(false);

  if (closure.notes) {
    builder.divider('-');
    builder.line(`Observaciones: ${closure.notes}`);
  }

  // 7. Pie de firma
  builder.divider('=');
  builder.feed(2);
  builder.align('center');
  builder.line('--------------------------------');
  builder.line('Firma de Cajero / Responsable');
  builder.feed(2);

  if (options.autoCut !== false) {
    builder.cut(true);
  }

  return builder.build();
};

// ============================================================================
// IMPRESIÓN UNIVERSAL EXPO-PRINT & COMPARTIR WHATSAPP
// ============================================================================

/**
 * Genera la plantilla HTML estilizada como ticket térmico (58mm u 80mm)
 */
export const generateReceiptHTML = (
  data: EscPosReceiptData,
  paperWidth: PrinterPaperWidth = 80
): string => {
  const is58 = paperWidth === 58;
  const maxWidth = is58 ? '48mm' : '72mm';
  const fontSize = is58 ? '10px' : '12px';

  const rows = (data.items || [])
    .map(
      (it: ReceiptItem) => `
      <tr>
        <td style="text-align: left; padding: 2px 0;">${it.name}<br/><small style="color: #666;">${it.quantity} x S/ ${it.price.toFixed(2)}</small></td>
        <td style="text-align: right; vertical-align: top; padding: 2px 0;">S/ ${it.total.toFixed(2)}</td>
      </tr>
    `
    )
    .join('');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          @page { margin: 0; size: ${paperWidth}mm auto; }
          body {
            font-family: 'Courier New', Courier, monospace;
            width: ${maxWidth};
            margin: 0 auto;
            padding: 8px;
            font-size: ${fontSize};
            color: #000;
            background: #fff;
            line-height: 1.25;
          }
          .text-center { text-align: center; }
          .text-right { text-align: right; }
          .bold { font-weight: bold; }
          .title { font-size: 1.3em; margin: 4px 0; }
          .divider { border-bottom: 1px dashed #000; margin: 6px 0; }
          .double-divider { border-bottom: 2px solid #000; margin: 6px 0; }
          table { width: 100%; border-collapse: collapse; }
          .total-row { font-size: 1.2em; font-weight: bold; }
          .footer { font-size: 0.85em; text-align: center; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="text-center">
          ${data.businessName ? `<div class="bold title">${data.businessName}</div>` : ''}
          ${data.ruc ? `<div>RUC: ${data.ruc}</div>` : ''}
          ${data.address ? `<div>${data.address}</div>` : ''}
          ${data.phone ? `<div>Telf: ${data.phone}</div>` : ''}
          <div class="divider"></div>
          <div class="bold title">${data.documentTitle}</div>
          <div class="bold">${data.documentNumber}</div>
        </div>

        <div class="divider"></div>

        <div><strong>Fecha:</strong> ${data.date} ${data.time || ''}</div>
        ${data.sellerName ? `<div><strong>Vendedor:</strong> ${data.sellerName}</div>` : ''}
        ${data.customerName ? `<div><strong>Cliente:</strong> ${data.customerName}</div>` : ''}
        ${data.customerDocNumber ? `<div><strong>${data.customerDocType || 'Doc'}:</strong> ${data.customerDocNumber}</div>` : ''}
        ${data.customerAddress ? `<div><strong>Dirección:</strong> ${data.customerAddress}</div>` : ''}
        <div><strong>Forma de Pago:</strong> ${(data.paymentMethod || 'EFECTIVO').toUpperCase()}</div>

        <div class="divider"></div>

        <table>
          <thead>
            <tr>
              <th style="text-align: left; border-bottom: 1px solid #000;">DESCRIPCIÓN</th>
              <th style="text-align: right; border-bottom: 1px solid #000;">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <div class="divider"></div>

        <table>
          <tr>
            <td>Subtotal:</td>
            <td class="text-right">S/ ${(data.subtotal || 0).toFixed(2)}</td>
          </tr>
          ${data.tax ? `<tr><td>IGV (18%):</td><td class="text-right">S/ ${data.tax.toFixed(2)}</td></tr>` : ''}
          <tr class="total-row">
            <td style="padding-top: 4px;">TOTAL:</td>
            <td class="text-right" style="padding-top: 4px;">S/ ${(data.total || 0).toFixed(2)}</td>
          </tr>
          ${data.cashReceived ? `<tr><td>Efectivo Recibido:</td><td class="text-right">S/ ${data.cashReceived.toFixed(2)}</td></tr>` : ''}
          ${data.changeGiven ? `<tr><td>Vuelto:</td><td class="text-right">S/ ${data.changeGiven.toFixed(2)}</td></tr>` : ''}
        </table>

        ${data.amountInWords ? `<div class="divider"></div><div style="font-size: 0.85em;">SON: ${data.amountInWords.toUpperCase()}</div>` : ''}

        <div class="divider"></div>
        <div class="footer">
          <div>¡Gracias por su compra!</div>
          ${data.consultUrl ? `<div>Consulte en: ${data.consultUrl}</div>` : ''}
          ${data.footerNote ? `<div>${data.footerNote}</div>` : ''}
        </div>
      </body>
    </html>
  `;
};

/**
 * Imprime el ticket usando el servicio nativo de impresión del sistema operativo (`expo-print`)
 */
export const printTicketPDF = async (
  receipt: any,
  config?: Partial<PrinterConfig>
): Promise<void> => {
  try {
    const currentConfig = await getPrinterConfig();
    const width = config?.paperWidth || currentConfig.paperWidth;

    let htmlContent = '';
    if (typeof receipt === 'string') {
      htmlContent = receipt;
    } else if (receipt?.htmlContent) {
      htmlContent = receipt.htmlContent;
    } else if (receipt?.sale) {
      htmlContent = buildReceiptHtml(receipt.sale, receipt.business || {});
    } else if (receipt?.documentTitle) {
      htmlContent = generateReceiptHTML(receipt, width);
    } else {
      htmlContent = buildReceiptHtml(receipt, {});
    }

    await Print.printAsync({
      html: htmlContent,
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
    });
  } catch (err) {
    console.error('[ThermalPrinterService] Error en printTicketPDF:', err);
    throw err;
  }
};

/**
 * Genera el ticket en formato PDF y lo comparte vía WhatsApp mediante `expo-sharing`
 */
export const shareTicketWhatsApp = async (
  receiptOrSale: any,
  businessOrPhone?: any,
  phoneOrConfig?: any
): Promise<void> => {
  try {
    const currentConfig = await getPrinterConfig();
    const width = currentConfig.paperWidth;

    let htmlContent = '';
    let customerPhone = '';

    if (typeof receiptOrSale === 'string') {
      htmlContent = receiptOrSale;
      customerPhone = typeof businessOrPhone === 'string' ? businessOrPhone : '';
    } else if (receiptOrSale?.documentTitle) {
      htmlContent = generateReceiptHTML(receiptOrSale, width);
      customerPhone = typeof businessOrPhone === 'string' ? businessOrPhone : '';
    } else {
      const businessObj = typeof businessOrPhone === 'object' ? businessOrPhone : {};
      htmlContent = buildReceiptHtml(receiptOrSale, businessObj);
      customerPhone =
        typeof phoneOrConfig === 'string'
          ? phoneOrConfig
          : typeof businessOrPhone === 'string'
          ? businessOrPhone
          : receiptOrSale?.customerPhone || '';
    }

    // 1. Generar archivo PDF temporal
    const { uri } = await Print.printToFileAsync({
      html: htmlContent,
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
    });

    // 2. Si hay número de teléfono de WhatsApp, abrir chat directo opcional
    if (customerPhone) {
      const cleanPhone = customerPhone.replace(/\D/g, '');
      const fullPhone = cleanPhone.startsWith('51') ? cleanPhone : `51${cleanPhone}`;
      const msg = encodeURIComponent('Hola! Te enviamos tu comprobante de compra.');
      const whatsappUrl = `whatsapp://send?phone=${fullPhone}&text=${msg}`;

      const canOpen = await Linking.canOpenURL(whatsappUrl);
      if (canOpen) {
        await Linking.openURL(whatsappUrl);
      }
    }

    // 3. Abrir menú nativo para compartir el documento PDF
    const isAvailable = await Sharing.isAvailableAsync();
    if (isAvailable) {
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Compartir Comprobante de Pago',
        UTI: 'com.adobe.pdf',
      });
    } else {
      console.warn('[ThermalPrinterService] Sharing no está disponible en este entorno.');
    }
  } catch (err) {
    console.error('[ThermalPrinterService] Error compartiendo ticket por WhatsApp:', err);
    throw err;
  }
};
