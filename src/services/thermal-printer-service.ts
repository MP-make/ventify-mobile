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
import { Platform, NativeModules, Linking, PermissionsAndroid } from 'react-native';
import {
  EscPosBuilder,
  buildSaleReceiptEscPos as coreBuildSaleReceiptEscPos,
  buildCashClosureEscPos as coreBuildCashClosureEscPos,
  buildReceiptHtml,
  type EscPosOptions,
  uint8ArrayToBase64,
} from '@/lib/printing/escpos-builder';
import { buildQrSvgMarkup } from '@/lib/invoicing/qr-matrix';
import {
  resolveAccountTaxProfile,
  type TaxProfileConfig,
  type TaxProfileInput,
} from '@/lib/invoicing/receipt-amounts';
import type { Branch } from '@/types';

export interface ReceiptItem {
  name: string;
  sku?: string;
  variantName?: string;
  quantity: number;
  price: number;
  total: number;
  unitOfMeasure?: string;
  discount?: number;
}

export interface EscPosReceiptData {
  businessName?: string;
  razonSocial?: string;
  description?: string;
  logoUrl?: string;
  ruc?: string;
  address?: string;
  fiscalAddress?: string;
  commercialAddress?: string;
  phone?: string;
  email?: string;
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
  discountAmount?: number;
  tax?: number;
  taxRate?: number;
  exemptAmount?: number;
  isAmazonExempt?: boolean;
  total: number;
  surchargeAmount?: number;
  chargedAmount?: number;
  cashReceived?: number;
  changeGiven?: number;
  amountInWords?: string;
  qrContent?: string;
  sunatHash?: string;
  sunatResolution?: string;
  consultUrl?: string;
  footerNote?: string;
}

// ============================================================================
// CONSTANTES Y CLAVES DE CONFIGURACIÓN
// ============================================================================

export const PRINTER_CONFIG_STORAGE_KEY = 'ventify_printer_config_v2';
const BLUETOOTH_PRINT_TIMEOUT_MS = 10_000;
let lastSharedPdfUri: string | null = null;

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
// PERMISOS, CONEXIÓN Y ESCANEO BLUETOOTH
// ============================================================================

const getAndroidApiLevel = (): number => {
  if (Platform.OS !== 'android') return 0;
  if (typeof Platform.Version === 'number') return Platform.Version;
  const parsed = parseInt(String(Platform.Version || '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Solicita permisos runtime de Bluetooth en Android 12+ (API >= 31).
 */
export const ensureBluetoothPermissions = async (requireScan: boolean = false): Promise<void> => {
  if (Platform.OS !== 'android') return;
  if (getAndroidApiLevel() < 31) return;
  if (!PermissionsAndroid) return;

  const connectPerm =
    PermissionsAndroid.PERMISSIONS?.BLUETOOTH_CONNECT || 'android.permission.BLUETOOTH_CONNECT';
  const scanPerm =
    PermissionsAndroid.PERMISSIONS?.BLUETOOTH_SCAN || 'android.permission.BLUETOOTH_SCAN';
  const requiredPerms = requireScan ? [connectPerm, scanPerm] : [connectPerm];

  let permsToRequest = requiredPerms;
  if (typeof PermissionsAndroid.check === 'function') {
    const checks = await Promise.all(
      requiredPerms.map(async (perm) => {
        try {
          return await PermissionsAndroid.check(perm as any);
        } catch {
          return false;
        }
      })
    );
    permsToRequest = requiredPerms.filter((_, index) => !checks[index]);
    if (permsToRequest.length === 0) {
      return;
    }
  }

  if (typeof PermissionsAndroid.requestMultiple === 'function') {
    const statuses = await PermissionsAndroid.requestMultiple(permsToRequest as any);
    const grantedStatus = PermissionsAndroid.RESULTS?.GRANTED || 'granted';
    const allGranted = permsToRequest.every((perm) => statuses?.[perm] === grantedStatus);
    if (!allGranted) {
      throw new Error(
        'Permiso de Bluetooth denegado. Habilita "Dispositivos cercanos" para Ventify POS en Ajustes de Android.'
      );
    }
    return;
  }

  if (typeof PermissionsAndroid.request === 'function') {
    const grantedStatus = PermissionsAndroid.RESULTS?.GRANTED || 'granted';
    for (const perm of permsToRequest) {
      const status = await PermissionsAndroid.request(perm as any);
      if (status !== grantedStatus) {
        throw new Error(
          'Permiso de Bluetooth denegado. Habilita "Dispositivos cercanos" para Ventify POS en Ajustes de Android.'
        );
      }
    }
  }
};

/**
 * Comprueba o solicita permisos de Bluetooth para mostrar estado en UI.
 */
export const requestBluetoothPermissions = async (): Promise<{
  granted: boolean;
  message?: string;
}> => {
  if (Platform.OS !== 'android') {
    return {
      granted: false,
      message: 'La impresión Bluetooth ESC/POS directa está disponible únicamente en Android.',
    };
  }

  try {
    await ensureBluetoothPermissions(true);
    return { granted: true };
  } catch (err: any) {
    return {
      granted: false,
      message:
        err?.message ||
        'No se otorgaron permisos de Bluetooth para acceder a ticketeras cercanas.',
    };
  }
};

/**
 * Convierte un Uint8Array a cadena Base64 centralizada en escpos-builder.ts
 */
export { uint8ArrayToBase64 };

/**
 * Escanea o lista las impresoras térmicas Bluetooth vinculadas en el sistema.
 * No devuelve dispositivos simulados ante errores de permisos o hardware.
 */
export const scanBluetoothPrinters = async (): Promise<BluetoothPrinterDevice[]> => {
  if (Platform.OS !== 'android') {
    throw new Error(
      'El escaneo de ticketeras Bluetooth ESC/POS solo está disponible en Android. En este dispositivo usa "PDF / Sistema".'
    );
  }

  await ensureBluetoothPermissions(true);

  const nativePlugin = NativeModules?.ThermalPrinter;
  if (!nativePlugin || typeof nativePlugin.getPairedPrinters !== 'function') {
    throw new Error(
      'El módulo nativo de impresión Bluetooth (ThermalPrinter) no está disponible en esta compilación. Usa el modo "PDF / Sistema".'
    );
  }

  const res = await nativePlugin.getPairedPrinters();
  if (Array.isArray(res?.devices)) {
    return res.devices;
  }

  return [];
};

/**
 * Envía un buffer binario ESC/POS a la impresora térmica Bluetooth.
 * Devuelve `false` si no es Android, falta dirección MAC, falta módulo nativo o falla la conexión,
 * permitiendo que los llamadores hagan fallback limpio a `printTicketPDF`.
 */
export const printRawEscPos = async (
  bytes: Uint8Array,
  deviceAddress?: string
): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }

  const explicitAddress = deviceAddress?.trim();
  const address =
    explicitAddress || (await getPrinterConfig()).selectedDevice?.address?.trim() || '';
  if (!address) {
    return false;
  }

  const nativePlugin = NativeModules?.ThermalPrinter;
  if (!nativePlugin || typeof nativePlugin.printRaw !== 'function') {
    return false;
  }

  try {
    await ensureBluetoothPermissions(false);

    const base64Data = uint8ArrayToBase64(bytes);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Timeout de impresión térmica Bluetooth (10 segundos excedidos)'));
      }, BLUETOOTH_PRINT_TIMEOUT_MS);
    });

    const printPromise = nativePlugin.printRaw({ address, base64Data });

    try {
      const res = await Promise.race([printPromise, timeoutPromise]);
      return res?.success === true || res?.success === undefined;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  } catch (err) {
    console.warn('[ThermalPrinterService] Error en printRaw nativo (usando fallback PDF):', err);
    return false;
  }
};

/**
 * Prueba la conexión física enviando un mini ticket ESC/POS a la ticketera Bluetooth.
 */
export const testPrinterConnection = async (
  deviceAddress?: string
): Promise<{ success: boolean; message: string }> => {
  if (Platform.OS !== 'android') {
    return {
      success: false,
      message: 'La impresión térmica Bluetooth directa solo está soportada en Android.',
    };
  }

  try {
    await ensureBluetoothPermissions(false);
  } catch (permErr: any) {
    return {
      success: false,
      message: permErr?.message || 'Permiso Bluetooth denegado.',
    };
  }

  const config = await getPrinterConfig();
  const address = (deviceAddress || config.selectedDevice?.address || '').trim();
  if (!address) {
    return {
      success: false,
      message: 'No hay ninguna impresora Bluetooth seleccionada.',
    };
  }

  const nativePlugin = NativeModules?.ThermalPrinter;
  if (!nativePlugin || typeof nativePlugin.printRaw !== 'function') {
    return {
      success: false,
      message:
        'El módulo nativo ThermalPrinter no está disponible en esta compilación. Usa "PDF / Sistema".',
    };
  }

  const builder = new EscPosBuilder({
    paperWidth: config.paperWidth,
    autoCut: config.autoCut,
  });
  builder
    .align('center')
    .bold(true)
    .size('double-height')
    .line('VENTIFY POS')
    .size('normal')
    .bold(false)
    .divider('-')
    .line('PRUEBA DE CONEXION BLUETOOTH')
    .line(`Ancho: ${config.paperWidth}mm`)
    .line(`MAC: ${address}`)
    .line(`Fecha: ${new Date().toLocaleString('es-PE')}`)
    .divider('-')
    .line('Impresora lista para operar.')
    .feed(2);

  if (config.autoCut !== false) {
    builder.cut(true, 3);
  }

  const bytes = builder.build();
  const base64Data = uint8ArrayToBase64(bytes);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('La impresora no respondió dentro de 10 segundos.'));
      }, BLUETOOTH_PRINT_TIMEOUT_MS);
    });

    const res = await Promise.race([
      nativePlugin.printRaw({ address, base64Data }),
      timeoutPromise,
    ]);

    if (res?.success === false) {
      return {
        success: false,
        message: 'La impresora rechazó el comando de prueba.',
      };
    }

    return {
      success: true,
      message: `Ticket de prueba enviado correctamente a ${address}.`,
    };
  } catch (err: any) {
    return {
      success: false,
      message:
        err?.message ||
        'No se pudo conectar con la impresora Bluetooth. Verifica que esté encendida y vinculada.',
    };
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
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
  if (
    maybeOptions ||
    (businessOrOptions &&
      ('businessName' in businessOrOptions ||
        'ruc' in businessOrOptions ||
        'name' in businessOrOptions ||
        'fiscalAddress' in businessOrOptions ||
        'commercialAddress' in businessOrOptions))
  ) {
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

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeImageSrc = (url?: string): string => {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return '';
};

/**
 * Genera la plantilla HTML estilizada como ticket térmico (58mm u 80mm)
 */
export const generateReceiptHTML = (
  data: EscPosReceiptData,
  paperWidth: PrinterPaperWidth = 80,
  taxProfile?: TaxProfileConfig | null
): string => {
  const is58 = paperWidth === 58;
  const maxWidth = is58 ? '48mm' : '72mm';
  const fontSize = is58 ? '10px' : '12px';

  const resolvedProfile = taxProfile ? resolveAccountTaxProfile(taxProfile) : null;
  const isAmazonExempt = Boolean(data.isAmazonExempt || resolvedProfile?.isAmazonExempt);
  const igvRate = isAmazonExempt
    ? 0
    : typeof data.taxRate === 'number' && data.taxRate > 0
    ? Math.round(data.taxRate)
    : resolvedProfile && resolvedProfile.taxRate > 0
    ? Math.round(resolvedProfile.taxRate)
    : data.subtotal > 0 && (data.tax || 0) > 0
    ? Math.round(((data.tax || 0) / data.subtotal) * 100)
    : 18;

  const rows = (data.items || [])
    .map((it: ReceiptItem) => {
      const safeName = escapeHtml(it.name);
      const safeVariant = it.variantName ? ` (${escapeHtml(it.variantName)})` : '';
      const safeSku = escapeHtml(it.sku || '-');
      const safeUnit = escapeHtml((it.unitOfMeasure || 'UND').toUpperCase());
      const qty = Number(it.quantity) || 0;
      const price = Number(it.price) || 0;
      const total = Number(it.total) || 0;

      return `
      <tr>
        <td colspan="4" style="text-align: left; padding: 3px 0 1px; font-weight: bold;">${safeName}${safeVariant}</td>
      </tr>
      <tr style="font-size: 0.85em; color: #444; border-bottom: 1px dotted #ddd;">
        <td style="padding-bottom: 3px;">${safeSku}</td>
        <td style="padding-bottom: 3px;">${qty} ${safeUnit}</td>
        <td class="text-right" style="padding-bottom: 3px;">${price.toFixed(2)}</td>
        <td class="text-right bold" style="padding-bottom: 3px; color: #000;">S/ ${total.toFixed(2)}</td>
      </tr>
    `;
    })
    .join('');

  const qrSvg = data.qrContent ? buildQrSvgMarkup(data.qrContent, is58 ? 96 : 112, 2) : '';
  const wordsLine = data.amountInWords
    ? String(data.amountInWords).toUpperCase().startsWith('SON:')
      ? data.amountInWords
      : `SON: ${data.amountInWords}`
    : '';
  const safeLogoSrc = sanitizeImageSrc(data.logoUrl);
  const effectiveFiscalAddress = data.fiscalAddress || data.address;

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
            line-height: 1.28;
          }
          .text-center { text-align: center; }
          .text-right { text-align: right; }
          .bold { font-weight: bold; }
          .title { font-size: 1.25em; margin: 4px 0; }
          .divider { border-bottom: 1px dashed #000; margin: 6px 0; }
          table { width: 100%; border-collapse: collapse; }
          .total-row { font-size: 1.18em; font-weight: bold; }
          .footer { font-size: 0.85em; text-align: center; margin-top: 8px; }
        </style>
      </head>
      <body>
        <div class="text-center">
          ${safeLogoSrc ? `<img src="${safeLogoSrc}" alt="Logo" style="max-width: ${is58 ? '100px' : '132px'}; max-height: 52px; object-fit: contain; margin: 0 auto 4px; display: block;" />` : ''}
          ${data.businessName ? `<div class="bold title">${escapeHtml(data.businessName)}</div>` : ''}
          ${data.razonSocial && data.razonSocial !== data.businessName ? `<div>${escapeHtml(data.razonSocial)}</div>` : ''}
          ${data.description ? `<div><em>"${escapeHtml(data.description)}"</em></div>` : ''}
          ${data.ruc ? `<div class="bold">RUC: ${escapeHtml(data.ruc)}</div>` : ''}
          ${effectiveFiscalAddress ? `<div>${escapeHtml(effectiveFiscalAddress)}</div>` : ''}
          ${data.commercialAddress && data.commercialAddress !== effectiveFiscalAddress ? `<div>Tienda: ${escapeHtml(data.commercialAddress)}</div>` : ''}
          ${data.phone ? `<div>Telf: ${escapeHtml(data.phone)}</div>` : ''}
          ${data.email ? `<div>${escapeHtml(data.email)}</div>` : ''}
          <div class="divider"></div>
          <div class="bold title">${escapeHtml(data.documentTitle)}</div>
          <div class="bold">${escapeHtml(data.documentNumber)}</div>
        </div>

        <div class="divider"></div>

        <div><strong>Fecha:</strong> ${escapeHtml(data.date)} ${escapeHtml(data.time || '')}</div>
        ${data.sellerName ? `<div><strong>Vendedor:</strong> ${escapeHtml(data.sellerName)}</div>` : ''}
        ${data.customerName ? `<div><strong>Cliente:</strong> ${escapeHtml(data.customerName)}</div>` : ''}
        ${data.customerDocNumber ? `<div><strong>${escapeHtml(data.customerDocType || 'Doc')}:</strong> ${escapeHtml(data.customerDocNumber)}</div>` : ''}
        ${data.customerAddress ? `<div><strong>Dirección:</strong> ${escapeHtml(data.customerAddress)}</div>` : ''}
        <div><strong>Forma de Pago:</strong> ${escapeHtml((data.paymentMethod || 'EFECTIVO').toUpperCase())}</div>

        <div class="divider"></div>

        <table>
          <thead>
            <tr style="border-bottom: 1px dashed #000; font-size: 0.85em;">
              <th style="text-align: left;">SKU</th>
              <th style="text-align: left;">CANT</th>
              <th style="text-align: right;">PRECIO</th>
              <th style="text-align: right;">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <div class="divider"></div>

        <table>
          ${data.discountAmount && data.discountAmount > 0 ? `<tr><td>Descuento:</td><td class="text-right">-S/ ${Number(data.discountAmount).toFixed(2)}</td></tr>` : ''}
          ${isAmazonExempt ? `<tr><td>Op. Exonerada:</td><td class="text-right">S/ ${Number(data.exemptAmount ?? data.subtotal ?? data.total).toFixed(2)}</td></tr>` : `<tr><td>${data.tax && data.tax > 0 ? 'Op. Gravada:' : 'Subtotal:'}</td><td class="text-right">S/ ${Number(data.subtotal || 0).toFixed(2)}</td></tr>`}
          ${!isAmazonExempt && data.tax && data.tax > 0 ? `<tr><td>IGV (${igvRate}%):</td><td class="text-right">S/ ${Number(data.tax).toFixed(2)}</td></tr>` : ''}
          <tr class="total-row">
            <td style="padding-top: 4px;">TOTAL:</td>
            <td class="text-right" style="padding-top: 4px;">S/ ${Number(data.total || 0).toFixed(2)}</td>
          </tr>
          ${data.surchargeAmount && data.surchargeAmount > 0 ? `<tr><td>Recargo:</td><td class="text-right">S/ ${Number(data.surchargeAmount).toFixed(2)}</td></tr><tr class="bold"><td>TOTAL COBRADO:</td><td class="text-right">S/ ${Number(data.chargedAmount ?? data.total + data.surchargeAmount).toFixed(2)}</td></tr>` : ''}
          ${data.cashReceived ? `<tr><td>Efectivo Recibido:</td><td class="text-right">S/ ${Number(data.cashReceived).toFixed(2)}</td></tr>` : ''}
          ${data.changeGiven ? `<tr><td>Vuelto:</td><td class="text-right">S/ ${Number(data.changeGiven).toFixed(2)}</td></tr>` : ''}
        </table>

        ${wordsLine ? `<div class="divider"></div><div style="font-size: 0.85em; font-weight: bold;">${escapeHtml(wordsLine.toUpperCase())}</div>` : ''}
        ${isAmazonExempt ? `<div class="text-center" style="font-size: 0.78em; margin-top: 4px;">BIENES TRANSFERIDOS EN LA AMAZONÍA REGIÓN SELVA PARA SER CONSUMIDOS EN LA MISMA</div>` : ''}
        ${qrSvg ? `<div class="divider"></div><div class="text-center" style="margin: 6px 0;">${qrSvg}</div>` : ''}
        ${data.sunatHash ? `<div class="text-center" style="font-size: 0.75em; word-break: break-all;">Hash: ${escapeHtml(data.sunatHash)}</div>` : ''}

        <div class="divider"></div>
        <div class="footer">
          ${data.consultUrl ? `<div>Consulte en: <strong>${escapeHtml(data.consultUrl)}</strong></div>` : ''}
          ${data.sunatResolution ? `<div style="font-size: 0.85em; margin-top: 2px;">${escapeHtml(data.sunatResolution)}</div>` : ''}
          <div>${escapeHtml(data.footerNote || '¡Gracias por su compra!')}</div>
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
  config?: Partial<PrinterConfig> & {
    branch?: Partial<Branch> | null;
    taxProfile?: (TaxProfileInput & { taxRate?: number | null }) | null;
    receiptFooter?: string;
    consultUrl?: string;
  }
): Promise<void> => {
  try {
    const width = config?.paperWidth || (await getPrinterConfig()).paperWidth;
    const htmlOptions: EscPosOptions = {
      paperWidth: width,
      branch: config?.branch,
      taxProfile: config?.taxProfile,
      receiptFooter: config?.receiptFooter,
      consultUrl: config?.consultUrl,
      ...(receipt?.options || {}),
    };

    let htmlContent = '';
    if (typeof receipt === 'string') {
      htmlContent = receipt;
    } else if (receipt?.htmlContent) {
      htmlContent = receipt.htmlContent;
    } else if (receipt?.sale) {
      htmlContent = buildReceiptHtml(receipt.sale, receipt.business || {}, htmlOptions);
    } else if (receipt?.documentTitle) {
      htmlContent = generateReceiptHTML(
        receipt,
        width,
        (htmlOptions.taxProfile as TaxProfileConfig | null | undefined) ?? config?.taxProfile
      );
    } else {
      htmlContent = buildReceiptHtml(receipt, {}, htmlOptions);
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

export interface ShareTicketWhatsAppConfig {
  phone?: string;
  paperWidth?: PrinterPaperWidth | '58mm' | '80mm';
  branch?: Partial<Branch> | null;
  taxProfile?: (TaxProfileInput & { taxRate?: number | null }) | null;
  receiptFooter?: string;
  consultUrl?: string;
}

/**
 * Genera el ticket en formato PDF y lo comparte vía WhatsApp mediante `expo-sharing`
 */
export const shareTicketWhatsApp = async (
  receiptOrSale: any,
  businessOrPhone?: any,
  phoneOrConfig?: string | ShareTicketWhatsAppConfig
): Promise<void> => {
  try {
    const extraCfg: ShareTicketWhatsAppConfig =
      typeof phoneOrConfig === 'object' && phoneOrConfig !== null ? phoneOrConfig : {};
    const rawWidth =
      extraCfg.paperWidth ||
      receiptOrSale?.options?.paperWidth ||
      (await getPrinterConfig()).paperWidth;
    const width: PrinterPaperWidth = rawWidth === 58 || rawWidth === '58mm' ? 58 : 80;

    let htmlContent = '';
    let customerPhone = '';
    let docNumber = '';
    let saleTotal: number | undefined;

    if (typeof receiptOrSale === 'string') {
      htmlContent = receiptOrSale;
      customerPhone = typeof businessOrPhone === 'string' ? businessOrPhone : extraCfg.phone || '';
    } else if (receiptOrSale?.documentTitle) {
      htmlContent = generateReceiptHTML(
        receiptOrSale,
        width,
        (extraCfg.taxProfile as TaxProfileConfig | null | undefined) ?? undefined
      );
      customerPhone = typeof businessOrPhone === 'string' ? businessOrPhone : extraCfg.phone || '';
      docNumber = receiptOrSale.documentNumber || '';
      saleTotal = receiptOrSale.total;
    } else if (receiptOrSale?.sale) {
      htmlContent = buildReceiptHtml(receiptOrSale.sale, receiptOrSale.business || {}, {
        paperWidth: width,
        branch: extraCfg.branch,
        taxProfile: extraCfg.taxProfile,
        receiptFooter: extraCfg.receiptFooter,
        consultUrl: extraCfg.consultUrl,
        ...(receiptOrSale.options || {}),
      });
      customerPhone =
        typeof businessOrPhone === 'string'
          ? businessOrPhone
          : extraCfg.phone || receiptOrSale.sale?.customerPhone || '';
      docNumber = receiptOrSale.sale?.documentNumber || '';
      saleTotal = receiptOrSale.sale?.total;
    } else {
      const businessObj = typeof businessOrPhone === 'object' ? businessOrPhone : {};
      htmlContent = buildReceiptHtml(receiptOrSale, businessObj, {
        paperWidth: width,
        branch: extraCfg.branch,
        taxProfile: extraCfg.taxProfile,
        receiptFooter: extraCfg.receiptFooter,
        consultUrl: extraCfg.consultUrl,
      });
      customerPhone =
        typeof phoneOrConfig === 'string'
          ? phoneOrConfig
          : extraCfg.phone
          ? extraCfg.phone
          : typeof businessOrPhone === 'string'
          ? businessOrPhone
          : receiptOrSale?.customerPhone || '';
      docNumber = receiptOrSale?.documentNumber || '';
      saleTotal = receiptOrSale?.total;
    }

    // 1. Generar archivo PDF temporal y limpiar temporal previo (best-effort)
    const prevUri = lastSharedPdfUri;
    const { uri } = await Print.printToFileAsync({
      html: htmlContent,
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
    });
    lastSharedPdfUri = uri || null;
    if (prevUri && prevUri !== uri) {
      try {
        const FileSystem = await import('expo-file-system');
        if (typeof FileSystem?.deleteAsync === 'function') {
          await FileSystem.deleteAsync(prevUri, { idempotent: true });
        }
      } catch {
        // Best-effort cleanup of previous temporary PDF
      }
    }

    // 2. Si hay número de teléfono de WhatsApp, abrir chat directo opcional
    if (customerPhone) {
      const cleanPhone = customerPhone.replace(/\D/g, '');
      const fullPhone = cleanPhone.startsWith('51') ? cleanPhone : `51${cleanPhone}`;
      const docLabel = docNumber ? ` ${docNumber}` : '';
      const totalLabel = typeof saleTotal === 'number' ? ` por S/ ${saleTotal.toFixed(2)}` : '';
      const msg = encodeURIComponent(`Hola! Te enviamos tu comprobante${docLabel}${totalLabel}.`);
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
