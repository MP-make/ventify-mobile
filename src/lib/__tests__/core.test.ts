import { describe, it, expect } from 'vitest';
import {
  formatPEN,
  formatDatePE,
  generateId,
  generateEAN13Peru,
} from '../theme';
import { cleanFirestoreData } from '../firebase-utils';
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
import {
  normalizeRole,
  roleHasPermission,
  effectivePermissions,
} from '../role-permissions';
import {
  hasAllBranchesAccess,
  canAccessBranch,
} from '../branch-access';
import {
  deriveBranchIds,
  deriveLowStockBranches,
  LOW_STOCK_ANY,
} from '../product-branch-ids';
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

  describe('Role Permissions & Granular Limits', () => {
    it('normalizes roles in Spanish and English', () => {
      expect(normalizeRole('Dueño')).toBe('owner');
      expect(normalizeRole('Propietario')).toBe('owner');
      expect(normalizeRole('Administrador')).toBe('admin');
      expect(normalizeRole('Gerente')).toBe('manager');
      expect(normalizeRole('Cajero')).toBe('cashier');
      expect(normalizeRole('Vendedor')).toBe('seller');
      expect(normalizeRole('owner')).toBe('owner');
      expect(normalizeRole('admin')).toBe('admin');
      expect(normalizeRole('manager')).toBe('manager');
      expect(normalizeRole('cashier')).toBe('cashier');
      expect(normalizeRole('seller')).toBe('seller');
      expect(normalizeRole('')).toBe('cashier');
    });

    it('enforces cashier limitations matching the web app', () => {
      // Cashiers CAN register sales, modify price in POS, and request transfers
      expect(roleHasPermission('cashier', 'register_sale')).toBe(true);
      expect(roleHasPermission('cashier', 'modify_price')).toBe(true);
      expect(roleHasPermission('cashier', 'request_transfer')).toBe(true);
      expect(roleHasPermission('cashier', 'manage_customers')).toBe(true);

      // Cashiers CANNOT manage products, adjust inventory, view reports, or view margins
      expect(roleHasPermission('cashier', 'manage_products')).toBe(false);
      expect(roleHasPermission('cashier', 'manage_inventory_adjustments')).toBe(false);
      expect(roleHasPermission('cashier', 'view_reports')).toBe(false);
      expect(roleHasPermission('cashier', 'view_margins')).toBe(false);
      expect(roleHasPermission('cashier', 'manage_users')).toBe(false);
      expect(roleHasPermission('cashier', 'access_suppliers')).toBe(false);
    });

    it('allows owners and admins full access', () => {
      expect(roleHasPermission('owner', 'manage_products')).toBe(true);
      expect(roleHasPermission('owner', 'view_margins')).toBe(true);
      expect(roleHasPermission('owner', 'manage_users')).toBe(true);
      expect(roleHasPermission('admin', 'manage_products')).toBe(true);
      expect(roleHasPermission('admin', 'view_margins')).toBe(true);
    });

    it('respects customPermissions granted and revoked', () => {
      // Cashier with granted manage_products
      const customGrant = { granted: ['manage_products'] as any[] };
      expect(roleHasPermission('cashier', 'manage_products', customGrant)).toBe(true);

      // Cashier with revoked modify_price
      const customRevoke = { revoked: ['modify_price'] as any[] };
      expect(roleHasPermission('cashier', 'modify_price', customRevoke)).toBe(false);
    });

    it('evaluates branch access parity with Web', () => {
      expect(hasAllBranchesAccess({ role: 'owner', allBranchesAccess: false })).toBe(true);
      expect(hasAllBranchesAccess({ role: 'admin', allBranchesAccess: undefined })).toBe(true);
      expect(hasAllBranchesAccess({ role: 'manager', allBranchesAccess: false })).toBe(false);
      expect(hasAllBranchesAccess({ role: 'manager', allBranchesAccess: true })).toBe(true);
      expect(hasAllBranchesAccess({ role: 'cashier', allBranchesAccess: false })).toBe(false);
      expect(hasAllBranchesAccess({ role: 'seller', allBranchesAccess: true })).toBe(false);

      expect(canAccessBranch({ role: 'cashier', branchId: 'b1', allBranchesAccess: false }, 'b1')).toBe(true);
      expect(canAccessBranch({ role: 'cashier', branchId: 'b1', allBranchesAccess: false }, 'b2')).toBe(false);
      expect(canAccessBranch({ role: 'owner', branchId: 'b1', allBranchesAccess: false }, 'b2')).toBe(true);
    });

    it('derives branchIds and lowStockBranches with LOW_STOCK_ANY matching Web', () => {
      expect(deriveBranchIds({ b1: 10, b2: 0 })).toEqual(['b1', 'b2']);
      expect(deriveBranchIds({}, ['b_fallback'])).toEqual(['b_fallback']);

      // b1 has 3 (low stock), b2 has 10 (normal), b3 has -1 (negative excluded)
      const low = deriveLowStockBranches({ b1: 5, b2: 10, b3: -1 }, { b1: 2 });
      expect(low).toEqual([LOW_STOCK_ANY, 'b1']);
    });
  });

  describe('Firestore Sanitization Utility', () => {
    it('removes undefined fields recursively from objects and arrays', () => {
      const dirty = {
        name: 'Venta',
        total: 100,
        notes: undefined,
        customer: {
          name: 'Juan',
          phone: undefined,
          meta: {
            tags: undefined,
            active: true,
          },
        },
        items: [
          {
            id: 'item1',
            presentation: undefined,
            variant: undefined,
            quantity: 2,
          },
        ],
      };

      const cleaned = cleanFirestoreData(dirty);
      expect(cleaned).toEqual({
        name: 'Venta',
        total: 100,
        customer: {
          name: 'Juan',
          meta: {
            active: true,
          },
        },
        items: [
          {
            id: 'item1',
            quantity: 2,
          },
        ],
      });
      expect('notes' in cleaned).toBe(false);
      expect('presentation' in cleaned.items[0]).toBe(false);
      expect('variant' in cleaned.items[0]).toBe(false);
    });

    it('preserves Firestore FieldValues, Dates and numbers', () => {
      const date = new Date();
      const mockTimestamp = { seconds: 123456, nanoseconds: 789 };
      const data = {
        date,
        createdAt: mockTimestamp,
        amount: 0,
        emptyStr: '',
        nullVal: null,
      };

      const cleaned = cleanFirestoreData(data);
      expect(cleaned.date).toBe(date);
      expect(cleaned.createdAt).toEqual(mockTimestamp);
      expect(cleaned.amount).toBe(0);
      expect(cleaned.emptyStr).toBe('');
      expect(cleaned.nullVal).toBeNull();
    });
  });
});

