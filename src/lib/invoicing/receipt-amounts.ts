import type { Sale } from '@/types';
import type { InvoiceReceiptAmounts } from './types';

export interface TaxProfileConfig {
  isAmazonExempt?: boolean | null;
  taxExemptionCode?: string | null;
  taxRate?: number | null;
}

export interface TaxProfileInput {
  isAmazonExempt?: boolean | null;
  taxExemptionCode?: string | null;
}

export interface AccountTaxProfile {
  isAmazonExempt: boolean;
  taxExemptionCode: '10' | '20';
  taxRate: number;
}

export interface ReceiptAmountsResult {
  taxed: number;
  exempt: number;
  unaffected: number;
  igv: number;
  otherTaxes: number;
  subtotal: number;
  total: number;
  isAmazonExempt: boolean;
  taxExemptionCode: '10' | '20';
}

export const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Resuelve el perfil tributario IGV de una cuenta según su configuración de facturación.
 * - Exonerado Amazonía (Ley 27037): código '20', tasa 0%, `isAmazonExempt: true`.
 * - Régimen general gravado: código '10', tasa configurada (18% por defecto, o 10% Ley 31556).
 */
export function resolveAccountTaxProfile(
  config?: TaxProfileConfig | null
): AccountTaxProfile {
  if (config?.isAmazonExempt === true || config?.taxExemptionCode === '20') {
    return {
      isAmazonExempt: true,
      taxExemptionCode: '20',
      taxRate: typeof config?.taxRate === 'number' && config.taxRate >= 0 ? config.taxRate : 0,
    };
  }
  return {
    isAmazonExempt: false,
    taxExemptionCode: '10',
    taxRate: typeof config?.taxRate === 'number' && config.taxRate > 0 ? config.taxRate : 18,
  };
}

/**
 * Calcula los totales tributarios para mostrar en comprobantes (pantalla, PDF y ESC/POS),
 * replicando la lógica de `/home/arcay/ventify/src/lib/invoicing/receipt-amounts.ts`.
 */
export function receiptAmountsForSale(
  sale: Partial<Pick<Sale, 'total' | 'subtotal' | 'tax' | 'taxExemptionCode' | 'isAmazonExempt' | 'fiscalAmounts'>>,
  fiscal?: InvoiceReceiptAmounts | null,
  taxProfile?: TaxProfileInput | null
): ReceiptAmountsResult {
  const effectiveFiscal = fiscal ?? sale.fiscalAmounts;
  if (effectiveFiscal && typeof effectiveFiscal.total === 'number') {
    const taxed = round2(effectiveFiscal.taxed || 0);
    const exempt = round2(effectiveFiscal.exempt || 0);
    const unaffected = round2(effectiveFiscal.unaffected || 0);
    const igv = round2(effectiveFiscal.igv || 0);
    const otherTaxes = round2(effectiveFiscal.otherTaxes || 0);
    const total = round2(effectiveFiscal.total);
    const isExempt = exempt > 0 && taxed === 0 && igv === 0;
    return {
      taxed,
      exempt,
      unaffected,
      igv,
      otherTaxes,
      subtotal: round2(taxed + exempt + unaffected),
      total,
      isAmazonExempt: isExempt,
      taxExemptionCode: isExempt ? '20' : '10',
    };
  }

  const saleTotal = round2(sale.total ?? 0);
  const saleTax = round2(sale.tax ?? 0);

  if (saleTax > 0) {
    const taxed = round2(Math.max(0, saleTotal - saleTax));
    return {
      taxed,
      exempt: 0,
      unaffected: 0,
      igv: saleTax,
      otherTaxes: 0,
      subtotal: taxed,
      total: saleTotal,
      isAmazonExempt: false,
      taxExemptionCode: '10',
    };
  }

  let isExempt = false;
  if (sale.taxExemptionCode === '20' || sale.isAmazonExempt === true) {
    isExempt = true;
  } else if (sale.taxExemptionCode === '10' || sale.isAmazonExempt === false) {
    isExempt = false;
  } else if (taxProfile?.isAmazonExempt === true || taxProfile?.taxExemptionCode === '20') {
    isExempt = true;
  }

  if (isExempt) {
    return {
      taxed: 0,
      exempt: saleTotal,
      unaffected: 0,
      igv: 0,
      otherTaxes: 0,
      subtotal: saleTotal,
      total: saleTotal,
      isAmazonExempt: true,
      taxExemptionCode: '20',
    };
  }

  const fallbackSubtotal = round2(
    sale.subtotal !== undefined && sale.subtotal !== null ? sale.subtotal : saleTotal
  );
  return {
    taxed: 0,
    exempt: 0,
    unaffected: 0,
    igv: 0,
    otherTaxes: 0,
    subtotal: fallbackSubtotal,
    total: saleTotal,
    isAmazonExempt: false,
    taxExemptionCode: '10',
  };
}

/**
 * Calcula los montos iniciales (`subtotal`, `tax`, `taxExemptionCode`, `isAmazonExempt`)
 * al registrar una venta desde el POS móvil.
 */
export function computeSaleTaxBreakdown(
  total: number,
  documentType: string,
  taxProfile?: TaxProfileConfig | null
): {
  subtotal: number;
  tax: number;
  taxExemptionCode: '10' | '20';
  isAmazonExempt: boolean;
} {
  const safeTotal = round2(Math.max(0, total));
  const resolved = resolveAccountTaxProfile(taxProfile);
  const isFiscalDoc =
    documentType === 'boleta' ||
    documentType === 'factura' ||
    documentType === 'credit_note' ||
    documentType === 'debit_note';

  if (!isFiscalDoc) {
    return {
      subtotal: safeTotal,
      tax: 0,
      taxExemptionCode: resolved.taxExemptionCode,
      isAmazonExempt: resolved.isAmazonExempt,
    };
  }

  if (resolved.isAmazonExempt || resolved.taxRate <= 0) {
    return {
      subtotal: safeTotal,
      tax: 0,
      taxExemptionCode: '20',
      isAmazonExempt: true,
    };
  }

  const divisor = 1 + resolved.taxRate / 100;
  const net = round2(safeTotal / divisor);
  const igv = round2(safeTotal - net);
  return {
    subtotal: net,
    tax: igv,
    taxExemptionCode: '10',
    isAmazonExempt: false,
  };
}
