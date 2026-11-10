import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34 },
  NativeModules: {},
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

vi.mock('expo-device', () => ({
  deviceName: 'Ventify Android Test',
  modelName: 'Pixel 8',
  osName: 'Android',
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
    addEventListener: vi.fn(() => () => {}),
  },
}));

vi.mock('@/lib/firebase', () => ({
  db: {},
  auth: { currentUser: null },
  APP_URL: 'https://ventify.com.pe',
}));

import { calculateCashAudit, type CashSession, type CashMovement } from '../cash-register-service';
import { calculateLowStockBranches } from '../inventory-kardex-service';
import { sanitizeErrorMessage, classifySyncError } from '../offline-sync-service';
import { buildSaleReceiptEscPos, buildCashClosureEscPos, buildReceiptHtml } from '../../lib/printing/escpos-builder';
import { parseScannerQrCode } from '../companion-scanner-service';
import type { Sale } from '../../types';

describe('Ventify Mobile Transactional Services & Hardware Suite', () => {
  describe('Cash Register Audit & Z-Closure Math (calculateCashAudit)', () => {
    it('calculates exact expected cash in drawer combining cash sales, mixed payments, manual movements and excluding digital/fiado', () => {
      const session: CashSession = {
        id: 'session_branch_1',
        accountId: 'acc_1',
        branchId: 'branch_1',
        startedBy: 'user_1',
        startedByName: 'Carlos Cajero',
        initialAmount: 100.0,
        openingBalance: 100.0,
        status: 'open',
        openedAt: Date.now() - 3600_000,
      };

      const movements: CashMovement[] = [
        {
          id: 'm1',
          sessionId: 'session_branch_1',
          accountId: 'acc_1',
          branchId: 'branch_1',
          type: 'income',
          category: 'opening',
          amount: 100.0,
          description: 'Apertura de caja',
          createdBy: 'user_1',
          createdByName: 'Carlos',
          createdAt: Date.now(),
        },
        {
          id: 'm2',
          sessionId: 'session_branch_1',
          accountId: 'acc_1',
          branchId: 'branch_1',
          type: 'income',
          category: 'manual_income',
          amount: 25.5,
          description: 'Sencillo adicional',
          createdBy: 'user_1',
          createdByName: 'Carlos',
          createdAt: Date.now(),
        },
        {
          id: 'm3',
          sessionId: 'session_branch_1',
          accountId: 'acc_1',
          branchId: 'branch_1',
          type: 'expense',
          category: 'petty_cash',
          amount: 15.0,
          description: 'Compra de bolsas',
          createdBy: 'user_1',
          createdByName: 'Carlos',
          createdAt: Date.now(),
        },
      ];

      const sales = [
        // 1. Cash sale: S/ 50.00
        { id: 's1', sessionId: 'session_branch_1', status: 'completed', paymentMethod: 'efectivo', total: 50.0 },
        // 2. Yape sale: S/ 30.00
        { id: 's2', sessionId: 'session_branch_1', status: 'completed', paymentMethod: 'yape', total: 30.0 },
        // 3. Mixed sale: S/ 20 cash + S/ 15 plin
        {
          id: 's3',
          sessionId: 'session_branch_1',
          status: 'completed',
          paymentMethod: 'mixed',
          total: 35.0,
          payments: [
            { category: 'cash', amount: 20.0 },
            { category: 'digital', digitalProvider: 'plin', amount: 15.0 },
          ],
        },
        // 4. Credit (Fiado) sale: S/ 40.00
        { id: 's4', sessionId: 'session_branch_1', status: 'completed', paymentMethod: 'fiado', total: 40.0 },
        // 5. Cancelled sale (should be ignored)
        { id: 's5', sessionId: 'session_branch_1', status: 'cancelled', paymentMethod: 'efectivo', total: 999.0 },
      ];

      const audit = calculateCashAudit(session, movements, sales);

      expect(audit.openingBalance).toBe(100.0);
      expect(audit.cashSales).toBe(70.0); // 50 + 20
      expect(audit.digitalSales.yape).toBe(30.0);
      expect(audit.digitalSales.plin).toBe(15.0);
      expect(audit.digitalSales.totalDigital).toBe(45.0);
      expect(audit.creditSales).toBe(40.0);
      expect(audit.totalSales).toBe(155.0); // 70 + 45 + 40
      expect(audit.manualIncomes).toBe(25.5);
      expect(audit.manualExpenses).toBe(15.0);
      // Expected physical cash: 100 (opening) + 70 (cash sales) + 25.5 (manual in) - 15 (manual out) = 180.50
      expect(audit.expectedCashInDrawer).toBe(180.5);
    });
  });

  describe('Inventory Low-Stock Branch Indexing (calculateLowStockBranches)', () => {
    it('identifies branches where available stock (physical - reserved) is at or below threshold', () => {
      const stockMap = { branch_main: 10, branch_north: 4, branch_south: 8 };
      const reservedMap = { branch_main: 6, branch_north: 0, branch_south: 1 };

      // branch_main available = 10 - 6 = 4 (<= 5 -> low)
      // branch_north available = 4 - 0 = 4 (<= 5 -> low)
      // branch_south available = 8 - 1 = 7 (> 5 -> ok)
      const lowBranches = calculateLowStockBranches(stockMap, reservedMap, 5);
      expect(lowBranches).toContain('branch_main');
      expect(lowBranches).toContain('branch_north');
      expect(lowBranches).not.toContain('branch_south');
      expect(lowBranches).toContain('__any__');
    });
  });

  describe('Offline Sync Error Classification & Security Sanitization', () => {
    it('redacts Bearer tokens, JWTs, emails and API keys from error messages', () => {
      const rawError =
        'Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U for user admin@ventify.com.pe';
      const sanitized = sanitizeErrorMessage(rawError);
      expect(sanitized).not.toContain('admin@ventify.com.pe');
      expect(sanitized).not.toContain('eyJhbGci');
      expect(sanitized).toContain('[REDACTED_TOKEN]');
      expect(sanitized).toContain('[REDACTED_EMAIL]');
    });

    it('classifies stock insufficiency as non-retriable business conflict', () => {
      const classification = classifySyncError(new Error('Stock insuficiente para Coca Cola 500ml'));
      expect(classification.category).toBe('stock_rejected');
      expect(classification.retriable).toBe(false);
    });

    it('classifies network timeout as retriable transient error', () => {
      const classification = classifySyncError(new Error('Network request failed: timeout'));
      expect(classification.category).toBe('network_error');
      expect(classification.retriable).toBe(true);
    });
  });

  describe('ESC/POS Thermal Printer & Fiscal Protection', () => {
    it('enforces SUNAT fiscal protection by degrading unaccepted Factura to NOTA DE VENTA', () => {
      const pendingSale: Sale = {
        id: 'sale_101',
        saleNumber: 101,
        documentType: 'factura',
        documentNumber: 'F001-000101',
        sunatStatus: 'pending',
        date: Date.now(),
        branchId: 'branch_1',
        paymentMethod: 'efectivo',
        subtotal: 84.75,
        tax: 15.25,
        total: 100.0,
        items: [{ id: 'p1', name: 'Arroz Costeño 5kg', price: 25.0, quantity: 4, sku: 'ARR-01' }],
      };

      const bytes = buildSaleReceiptEscPos(pendingSale, {
        businessName: 'Bodega Don Pepe',
        ruc: '20601234567',
      });
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain('NOTA DE VENTA');
      expect(text).not.toContain('FACTURA ELECTRONICA');
    });

    it('prints FACTURA ELECTRONICA when sunatStatus is accepted', () => {
      const acceptedSale: Sale = {
        id: 'sale_102',
        saleNumber: 102,
        documentType: 'factura',
        documentNumber: 'F001-000102',
        sunatStatus: 'accepted',
        date: Date.now(),
        branchId: 'branch_1',
        paymentMethod: 'yape',
        subtotal: 84.75,
        tax: 15.25,
        total: 100.0,
        customerName: 'COMERCIAL LIMA SAC',
        customerRuc: '20100070970',
        items: [{ id: 'p1', name: 'Arroz Costeño 5kg', price: 25.0, quantity: 4, sku: 'ARR-01' }],
      };

      const bytes = buildSaleReceiptEscPos(acceptedSale, {
        businessName: 'Bodega Don Pepe',
        ruc: '20601234567',
      });
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain('FACTURA ELECTRONICA');
      expect(text).toContain('F001-000102');

      const html = buildReceiptHtml(acceptedSale, { businessName: 'Bodega Don Pepe', ruc: '20601234567' });
      expect(html).toContain('FACTURA ELECTRONICA');
      expect(html).toContain('COMERCIAL LIMA SAC');
    });
  });

  describe('Companion PC Scanner QR Payload Parser (parseScannerQrCode)', () => {
    it('parses full Ventify Web scanner pairing URL with token', () => {
      const parsed = parseScannerQrCode(
        'https://ventify.com.pe/scanner/sess_987654?token=tok_abc123'
      );
      expect(parsed.sessionId).toBe('sess_987654');
      expect(parsed.token).toBe('tok_abc123');
    });

    it('parses JSON QR payload and direct session ID', () => {
      const fromJson = parseScannerQrCode(
        JSON.stringify({ sessionId: 'sess_json_01', token: 'sec_999' })
      );
      expect(fromJson.sessionId).toBe('sess_json_01');
      expect(fromJson.token).toBe('sec_999');

      const fromDirect = parseScannerQrCode('sess_direct_42');
      expect(fromDirect.sessionId).toBe('sess_direct_42');
    });
  });
});
