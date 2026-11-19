import type { Sale } from '@/types';
import { receiptAmountsForSale, type TaxProfileInput } from './receipt-amounts';

const LIMA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;

export interface BuildQrContentParams {
  rucEmisor: string;
  documentType: string;
  serie: string;
  correlative: number | string;
  igv: number;
  total: number;
  issuedAt: number;
  customerIdentityType?: string;
  customerIdentityNumber?: string;
}

/**
 * Formatea fecha YYYY-MM-DD en zona horaria America/Lima (UTC-5 fijo en Perú).
 */
export function formatQrEmissionDate(issuedAtMs: number): string {
  const ts = typeof issuedAtMs === 'number' && Number.isFinite(issuedAtMs) ? issuedAtMs : Date.now();
  return new Date(ts - LIMA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Normaliza tipo de documento comercial al código de tabla SUNAT ('01', '03', '07', '08').
 */
export function toSunatDocCode(docType?: string): '01' | '03' | '07' | '08' | null {
  if (docType === 'factura' || docType === '01') return '01';
  if (docType === 'boleta' || docType === '03') return '03';
  if (docType === 'credit_note' || docType === '07') return '07';
  if (docType === 'debit_note' || docType === '08') return '08';
  return null;
}

/**
 * Separa serie y correlativo numéricamente desde `B001-000123` o valores de respaldo.
 */
export function splitDocumentNumber(
  documentNumber?: string | null,
  fallbackSerie?: string,
  fallbackNumber?: number | string
): { serie: string; correlative: string } {
  const cleanDoc = String(documentNumber || '').trim();
  if (cleanDoc.includes('-')) {
    const [rawSerie, ...rest] = cleanDoc.split('-');
    const rawNum = rest.join('-').trim();
    const numeric = rawNum.replace(/^0+/, '') || rawNum || '1';
    return {
      serie: rawSerie.trim().toUpperCase(),
      correlative: numeric,
    };
  }
  const numStr = String(fallbackNumber ?? '1').trim();
  return {
    serie: String(fallbackSerie || 'NV01').trim().toUpperCase(),
    correlative: numStr.replace(/^0+/, '') || '1',
  };
}

/**
 * Construye la cadena estándar SUNAT para código QR de comprobantes electrónicos:
 * `RUC|TIPO_DOC|SERIE|CORRELATIVO|IGV|TOTAL|FECHA|TIPO_DOC_ADQ|NUM_DOC_ADQ`
 */
export function buildQrContent(params: BuildQrContentParams): string {
  const corrRaw = String(params.correlative ?? '').trim();
  const normalizedCorr = /^\d+$/.test(corrRaw) ? String(Number(corrRaw)) : corrRaw;
  const customerIdType = String(params.customerIdentityType || '0').trim() || '0';
  const customerIdNumber = String(params.customerIdentityNumber || '-').trim() || '-';

  return [
    String(params.rucEmisor || '').trim(),
    String(params.documentType || '').trim(),
    String(params.serie || '').trim().toUpperCase(),
    normalizedCorr,
    (Number(params.igv) || 0).toFixed(2),
    (Number(params.total) || 0).toFixed(2),
    formatQrEmissionDate(params.issuedAt),
    customerIdType,
    customerIdNumber,
  ].join('|');
}

/**
 * Construye el contenido QR adecuado para una venta:
 * - Solo emite QR para comprobantes fiscales (Boleta, NC, ND o Factura aceptada)
 *   cuando NO están pendientes de sincronización offline (`!isOfflinePending`).
 * - Si el servidor ya devolvió `sale.qrContent`, lo reutiliza tal cual (incluye hash SUNAT).
 * - Si hay RUC emisor de 11 dígitos, construye la cadena SUNAT oficial.
 * - Para Nota de Venta, Cotización o venta offline pendiente retorna `null`.
 */
export function buildSaleQrContent(
  sale: Partial<Sale>,
  options?: {
    emitterRuc?: string | null;
    consultUrl?: string | null;
    taxProfile?: TaxProfileInput | null;
  }
): string | null {
  const rawDocType = String(sale.documentType || '').toLowerCase();
  const isQuote =
    Boolean((sale as { isQuote?: boolean }).isQuote) ||
    rawDocType === 'quote' ||
    rawDocType === 'cot' ||
    rawDocType === 'cotizacion';
  const isOfflinePending = Boolean(
    (sale as { isOffline?: boolean }).isOffline ||
      (sale as { offlineQueued?: boolean }).offlineQueued ||
      (sale as { isOfflinePending?: boolean }).isOfflinePending
  );

  if (isQuote || isOfflinePending) {
    return null;
  }

  const sunatDoc = toSunatDocCode(sale.documentType);
  const rucEmisor = String(options?.emitterRuc || '').replace(/\D/g, '');
  const isAcceptedFactura = sunatDoc === '01' && sale.sunatStatus === 'accepted';
  const isFiscalOrSummaryDoc =
    sunatDoc === '03' || sunatDoc === '07' || sunatDoc === '08' || isAcceptedFactura;

  if (!isFiscalOrSummaryDoc) {
    return null;
  }

  const existingQr = String((sale as { qrContent?: string }).qrContent || '').trim();
  if (existingQr) {
    return existingQr;
  }

  if (rucEmisor.length === 11) {
    const defaultSerie = sunatDoc === '01' ? 'F001' : sunatDoc === '03' ? 'B001' : 'NV01';
    const { serie, correlative } = splitDocumentNumber(
      sale.documentNumber || (sale as { correlative?: string }).correlative,
      defaultSerie,
      sale.saleNumber
    );
    const amounts = receiptAmountsForSale(sale, sale.fiscalAmounts, options?.taxProfile);

    const rawDoc = String(
      (sale as { receiptCustomer?: { identityNumber?: string } }).receiptCustomer?.identityNumber ||
        sale.customerRuc ||
        sale.customerDni ||
        ''
    ).replace(/\D/g, '');

    const receiptIdType = (sale as { receiptCustomer?: { identityType?: string } }).receiptCustomer?.identityType;
    let idType = receiptIdType || '0';
    let idNumber = rawDoc || '-';
    if (!receiptIdType) {
      if (rawDoc.length === 11) idType = '6';
      else if (rawDoc.length === 8) idType = '1';
      else {
        idType = '0';
        idNumber = '-';
      }
    }

    const rawDate = sale.date as unknown;
    const issuedAtMs =
      typeof rawDate === 'number'
        ? rawDate
        : rawDate instanceof Date
          ? rawDate.getTime()
          : typeof (rawDate as { toMillis?: () => number })?.toMillis === 'function'
            ? (rawDate as { toMillis: () => number }).toMillis()
            : Date.now();

    return buildQrContent({
      rucEmisor,
      documentType: sunatDoc!,
      serie,
      correlative,
      igv: amounts.igv,
      total: amounts.total,
      issuedAt: issuedAtMs,
      customerIdentityType: idType,
      customerIdentityNumber: idNumber,
    });
  }

  return null;
}
