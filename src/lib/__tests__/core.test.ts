import { describe, it, expect } from 'vitest';
import {
  formatPEN,
  formatDatePE,
  generateId,
  generateEAN13Peru,
} from '../theme';
import {
  isValidDNI,
  isValidRUC,
  calculateTaxTotals,
  numberToSpanishWordsPEN,
} from '../invoicing/types';
import {
  findProductByBarcode,
  filterProducts,
  getBranchStock,
  getAvailableStock,
  resolveEffectiveUnitPrice,
} from '../product-search';
import {
  EscPosBuilder,
  buildSaleReceiptEscPos,
  buildCashClosureEscPos,
  buildReceiptHtml,
  toBase64,
} from '../printing/escpos-builder';
import type { Product, Sale, CashRegisterSession } from '../../types';

describe('Ventify Mobile Core Libs', () => {
  describe('Theme & Localization', () => {
    it('formats PEN currency properly', () => {
      expect(formatPEN(1250.5)).toBe('S/ 1,250.50');
      expect(formatPEN(0)).toBe('S/ 0.00');
      expect(formatPEN(-15)).toBe('-S/ 15.00');
    });

    it('formats Peruvian dates', () => {
      const d = new Date('2026-11-10T15:30:00Z');
      expect(formatDatePE(d, false)).toMatch(/\d{2}\/\d{2}\/2026/);
    });

    it('generates prefixed IDs', () => {
      const id = generateId('sale');
      expect(id.startsWith('sale_')).toBe(true);
    });

    it('generates valid EAN-13 barcodes starting with 775', () => {
      const ean = generateEAN13Peru();
      expect(ean).toHaveLength(13);
      expect(ean.startsWith('775')).toBe(true);
    });
  });

  describe('SUNAT Invoicing & Fiscal Validators', () => {
    it('validates DNI correctly', () => {
      expect(isValidDNI('12345678')).toBe(true);
      expect(isValidDNI('1234567')).toBe(false);
      expect(isValidDNI('123456789')).toBe(false);
      expect(isValidDNI('abcdefgh')).toBe(false);
    });

    it('validates RUC with official Modulo 11', () => {
      // 20601234565 has verified check digit 5
      expect(isValidRUC('20601234565')).toBe(true);
      // Altered check digit must fail
      expect(isValidRUC('20601234564')).toBe(false);
      // Non 11-digit or invalid prefix
      expect(isValidRUC('30601234565')).toBe(false);
    });

    it('calculates tax totals accurately with 18% IGV', () => {
      const tax = calculateTaxTotals(118);
      expect(tax.opGravada).toBe(100.00);
      expect(tax.igv).toBe(18.00);
      expect(tax.total).toBe(118.00);
    });

    it('converts numbers to Spanish words for fiscal receipts', () => {
      expect(numberToSpanishWordsPEN(120.50)).toBe(
        'SON: CIENTO VEINTE CON 50/100 SOLES'
      );
      expect(numberToSpanishWordsPEN(1000)).toBe(
        'SON: MIL CON 00/100 SOLES'
      );
    });
  });

  describe('Product Search & Pricing Engine', () => {
    const sampleProduct: Product = {
      id: 'prod_test',
      name: 'Gaseosa Inka Cola 500ml',
      category: 'Bebidas',
      sku: 'INKA500',
      barcode: '7751111111111',
      barcodes: ['7752222222222'],
      costPrice: 2.0,
      minSalePrice: 2.5,
      suggestedPrice: 3.5,
      stock: { branch_1: 100 },
      reservedStock: { branch_1: 10 },
      priceTiers: [
        { minQuantity: 12, unitPrice: 3.0 },
        { minQuantity: 24, unitPrice: 2.8 },
      ],
      presentations: [
        {
          id: 'pres_caja',
          name: 'Caja x24',
          barcode: '7753333333333',
          conversionFactor: 24,
          price: 65.0,
        },
      ],
      variants: [
        {
          id: 'var_diet',
          name: 'Zero Azucar',
          sku: 'INKA500-Z',
          barcode: '7754444444444',
          stock: { branch_1: 30 },
        },
      ],
      accountId: 'acc_123',
    };

    it('finds product by main barcode, secondary barcode, SKU, presentation and variant', () => {
      expect(findProductByBarcode([sampleProduct], '7751111111111')?.product.id).toBe('prod_test');
      expect(findProductByBarcode([sampleProduct], '7752222222222')?.product.id).toBe('prod_test');
      expect(findProductByBarcode([sampleProduct], 'INKA500')?.product.id).toBe('prod_test');
      expect(findProductByBarcode([sampleProduct], '7753333333333')?.matchedPresentation?.name).toBe('Caja x24');
      expect(findProductByBarcode([sampleProduct], 'INKA500-Z')?.matchedVariant?.name).toBe('Zero Azucar');
    });

    it('calculates branch stock and available stock subtracting reservations', () => {
      expect(getBranchStock(sampleProduct, 'branch_1')).toBe(100);
      expect(getAvailableStock(sampleProduct, 'branch_1')).toBe(90);
    });

    it('filters products by query and category', () => {
      const list = filterProducts([sampleProduct], 'inka', 'Bebidas', 'branch_1');
      expect(list).toHaveLength(1);

      const empty = filterProducts([sampleProduct], 'fanta', 'Bebidas', 'branch_1');
      expect(empty).toHaveLength(0);
    });

    it('resolves effective unit price with tiered wholesale prices and presentations', () => {
      // 1 unit = suggested price
      expect(resolveEffectiveUnitPrice(sampleProduct, 'branch_1', 1)).toBe(3.5);
      // 15 units = tier for 12+ (3.0)
      expect(resolveEffectiveUnitPrice(sampleProduct, 'branch_1', 15)).toBe(3.0);
      // 30 units = tier for 24+ (2.8)
      expect(resolveEffectiveUnitPrice(sampleProduct, 'branch_1', 30)).toBe(2.8);
      // Presentation price
      expect(
        resolveEffectiveUnitPrice(
          sampleProduct,
          'branch_1',
          1,
          sampleProduct.presentations?.[0]
        )
      ).toBe(65.0);
    });
  });

  describe('ESC/POS Printing & HTML Renderer', () => {
    const mockSale: Sale = {
      id: 'sale_123',
      saleNumber: 42,
      date: Date.now(),
      branchId: 'branch_1',
      items: [
        {
          id: 'item_1',
          name: 'Inka Cola 500ml',
          quantity: 2,
          price: 3.5,
          sku: 'INKA500',
        },
      ],
      subtotal: 5.93,
      tax: 1.07,
      total: 7.0,
      paymentMethod: 'cash',
      documentType: 'boleta',
      documentNumber: 'B001-00000042',
      sunatStatus: 'accepted',
      cashReceived: 10.0,
      changeGiven: 3.0,
    };

    it('builds binary ESC/POS receipt', () => {
      const bytes = buildSaleReceiptEscPos(mockSale, {
        businessName: 'Bodega El Éxito',
        ruc: '20601234565',
      });
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(50);

      const b64 = toBase64(bytes);
      expect(typeof b64).toBe('string');
      expect(b64.length).toBeGreaterThan(0);
    });

    it('applies fiscal protection if Factura does not have accepted CDR', () => {
      const pendingFactura: Sale = {
        ...mockSale,
        documentType: 'factura',
        documentNumber: 'F001-00000001',
        sunatStatus: 'pending',
      };
      const bytes = buildSaleReceiptEscPos(pendingFactura, {
        businessName: 'Bodega El Éxito',
        ruc: '20601234565',
      });
      // Convert bytes to string to check NOTA DE VENTA was printed instead of FACTURA
      const str = String.fromCharCode(...bytes);
      expect(str).toContain('NOTA DE VENTA');
      expect(str).not.toContain('FACTURA ELECTRONICA');
    });

    it('builds Cash Closure Z ticket', () => {
      const session: CashRegisterSession = {
        id: 'sess_123',
        branchId: 'branch_1',
        accountId: 'acc_1',
        initialAmount: 100,
        openTime: Date.now() - 36000000,
        status: 'closed',
        totalSales: 500,
        cashSales: 300,
        cardSales: 150,
        digitalSales: 50,
        transactionCount: 20,
      };

      const bytes = buildCashClosureEscPos(session, {
        expectedAmount: 400,
        countedAmount: 400,
        difference: 0,
      });
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(50);
    });

    it('builds clean 80mm HTML ticket for expo-print', () => {
      const html = buildReceiptHtml(mockSale, {
        businessName: 'Bodega El Éxito',
        ruc: '20601234565',
      });
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Bodega El Éxito');
      expect(html).toContain('Inka Cola 500ml');
      expect(html).toContain('S/ 7.00');
    });
  });
});
