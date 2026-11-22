import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAsyncStorage,
  mockPlatform,
  mockNativeModules,
  mockRequestMultiple,
  mockRequestSingle,
  mockPrintAsync,
  mockPrintToFileAsync,
} = vi.hoisted(() => ({
  mockAsyncStorage: new Map<string, string>(),
  mockPlatform: { OS: 'android' as 'android' | 'ios', Version: 34 },
  mockNativeModules: {} as { ThermalPrinter?: any },
  mockRequestMultiple: vi.fn(),
  mockRequestSingle: vi.fn(),
  mockPrintAsync: vi.fn(async (..._args: any[]) => undefined),
  mockPrintToFileAsync: vi.fn(async (..._args: any[]) => ({ uri: 'file:///tmp/ticket.pdf' })),
}));

vi.mock('react-native', () => ({
  Platform: mockPlatform,
  NativeModules: mockNativeModules,
  Linking: {
    canOpenURL: vi.fn(async () => false),
    openURL: vi.fn(async () => undefined),
  },
  PermissionsAndroid: {
    PERMISSIONS: {
      BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
      BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN',
    },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
    requestMultiple: (...args: any[]) => mockRequestMultiple(...args),
    request: (...args: any[]) => mockRequestSingle(...args),
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => mockAsyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, val: string) => {
      mockAsyncStorage.set(key, val);
    }),
    removeItem: vi.fn(async (key: string) => {
      mockAsyncStorage.delete(key);
    }),
  },
}));

vi.mock('expo-print', () => ({
  printAsync: (...args: any[]) => mockPrintAsync(...args),
  printToFileAsync: (...args: any[]) => mockPrintToFileAsync(...args),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));

import {
  PRINTER_CONFIG_STORAGE_KEY,
  getPrinterConfig,
  savePrinterConfig,
  resetPrinterConfigCache,
  scanBluetoothPrinters,
  printRawEscPos,
  testPrinterConnection,
  generateReceiptHTML,
} from '../thermal-printer-service';

describe('thermal-printer-service (permissions, fallback safety, HTML escaping, dynamic IGV)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAsyncStorage.clear();
    resetPrinterConfigCache();
    mockPlatform.OS = 'android';
    mockPlatform.Version = 34;
    delete mockNativeModules.ThermalPrinter;

    mockRequestMultiple.mockResolvedValue({
      'android.permission.BLUETOOTH_CONNECT': 'granted',
      'android.permission.BLUETOOTH_SCAN': 'granted',
    });
  });

  describe('scanBluetoothPrinters', () => {
    it('requests BLUETOOTH_CONNECT & BLUETOOTH_SCAN on Android 12+ and returns real devices', async () => {
      const getPairedPrinters = vi.fn(async () => ({
        devices: [{ name: 'Epson TM-P20', address: 'AA:BB:CC:DD:EE:FF' }],
      }));
      mockNativeModules.ThermalPrinter = { getPairedPrinters };

      const devices = await scanBluetoothPrinters();

      expect(mockRequestMultiple).toHaveBeenCalledWith([
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.BLUETOOTH_SCAN',
      ]);
      expect(getPairedPrinters).toHaveBeenCalledTimes(1);
      expect(devices).toEqual([{ name: 'Epson TM-P20', address: 'AA:BB:CC:DD:EE:FF' }]);
    });

    it('throws actionable error when Bluetooth permissions are denied (never returns fake printers)', async () => {
      mockRequestMultiple.mockResolvedValueOnce({
        'android.permission.BLUETOOTH_CONNECT': 'denied',
        'android.permission.BLUETOOTH_SCAN': 'granted',
      });
      mockNativeModules.ThermalPrinter = { getPairedPrinters: vi.fn() };

      await expect(scanBluetoothPrinters()).rejects.toThrow(/Permiso de Bluetooth denegado/i);
      expect(mockNativeModules.ThermalPrinter.getPairedPrinters).not.toHaveBeenCalled();
    });

    it('throws actionable error when native module is absent or BT disabled (never returns 00:11:22:33:44:55)', async () => {
      await expect(scanBluetoothPrinters()).rejects.toThrow(/ThermalPrinter/i);

      mockNativeModules.ThermalPrinter = {
        getPairedPrinters: vi.fn(async () => {
          throw new Error('Bluetooth está desactivado');
        }),
      };
      await expect(scanBluetoothPrinters()).rejects.toThrow('Bluetooth está desactivado');

      mockPlatform.OS = 'ios';
      await expect(scanBluetoothPrinters()).rejects.toThrow(/Android/i);
    });
  });

  describe('printRawEscPos (strict false fallback, never simulated true)', () => {
    it('returns false on iOS, missing address, missing native module, or native/permission failure', async () => {
      const payload = new Uint8Array([0x1b, 0x40]);

      // 1. Non-Android
      mockPlatform.OS = 'ios';
      expect(await printRawEscPos(payload, 'AA:BB:CC:DD:EE:FF')).toBe(false);

      // 2. Android without address
      mockPlatform.OS = 'android';
      mockNativeModules.ThermalPrinter = { printRaw: vi.fn(async () => ({ success: true })) };
      expect(await printRawEscPos(payload)).toBe(false);

      // 3. Android without native module
      delete mockNativeModules.ThermalPrinter;
      expect(await printRawEscPos(payload, 'AA:BB:CC:DD:EE:FF')).toBe(false);

      // 4. Native printRaw failure
      mockNativeModules.ThermalPrinter = {
        printRaw: vi.fn(async () => {
          throw new Error('Socket closed');
        }),
      };
      expect(await printRawEscPos(payload, 'AA:BB:CC:DD:EE:FF')).toBe(false);

      // 5. Permission denied
      mockRequestMultiple.mockResolvedValueOnce({
        'android.permission.BLUETOOTH_CONNECT': 'denied',
      });
      mockNativeModules.ThermalPrinter = { printRaw: vi.fn(async () => ({ success: true })) };
      expect(await printRawEscPos(payload, 'AA:BB:CC:DD:EE:FF')).toBe(false);
      expect(mockNativeModules.ThermalPrinter.printRaw).not.toHaveBeenCalled();
    });

    it('prints Base64 ESC/POS bytes and returns true when native module succeeds', async () => {
      const printRaw = vi.fn(async () => ({ success: true }));
      mockNativeModules.ThermalPrinter = { printRaw };

      await savePrinterConfig({
        selectedDevice: { name: 'POS-80', address: '11:22:33:44:55:66' },
        connectionType: 'bluetooth',
      });

      const ok = await printRawEscPos(new Uint8Array([0x1b, 0x40, 0x41]));
      expect(ok).toBe(true);
      expect(printRaw).toHaveBeenCalledWith({
        address: '11:22:33:44:55:66',
        base64Data: expect.any(String),
      });
    });
  });

  describe('testPrinterConnection', () => {
    it('sends real ESC/POS test ticket and returns structured status', async () => {
      expect(await testPrinterConnection()).toMatchObject({ success: false });

      const printRaw = vi.fn(async () => ({ success: true }));
      mockNativeModules.ThermalPrinter = { printRaw };

      const res = await testPrinterConnection('AA:BB:CC:DD:EE:FF');
      expect(res.success).toBe(true);
      expect(printRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateReceiptHTML (HTML escaping & dynamic IGV taxProfile)', () => {
    it('escapes HTML/XSS payloads across merchant, customer, items and footer fields', () => {
      const html = generateReceiptHTML(
        {
          businessName: 'Tienda <script>alert(1)</script>',
          logoUrl: 'javascript:alert(2)',
          documentTitle: 'BOLETA <img src=x onerror=alert(3)>',
          documentNumber: 'B001-00001',
          date: '16/11/2026',
          customerName: 'Juan "Hacker" & Co <b/>',
          paymentMethod: 'efectivo',
          items: [
            {
              name: '<script>evil()</script>Café',
              sku: 'SKU<1>',
              variantName: 'Grande & Caliente',
              quantity: 1,
              price: 11,
              total: 11,
            },
          ],
          subtotal: 10,
          tax: 1,
          total: 11,
          footerNote: '<svg onload=alert(4)>Gracias',
        },
        80,
        { taxRate: 10, isAmazonExempt: false }
      );

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('javascript:alert');
      expect(html).not.toContain('<svg onload');
      expect(html).toContain('Tienda &lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('Juan &quot;Hacker&quot; &amp; Co &lt;b/&gt;');
      expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;Café');
      expect(html).toContain('IGV (10%):');
      expect(html).not.toContain('IGV (18%):');
    });

    it('renders Amazon exempt receipts without IGV row when taxProfile is Ley 27037', () => {
      const html = generateReceiptHTML(
        {
          businessName: 'Selva Store',
          documentTitle: 'BOLETA DE VENTA ELECTRONICA',
          documentNumber: 'B001-00002',
          date: '16/11/2026',
          paymentMethod: 'yape',
          items: [{ name: 'Jugo', quantity: 1, price: 20, total: 20 }],
          subtotal: 20,
          tax: 0,
          total: 20,
        },
        58,
        { isAmazonExempt: true, taxExemptionCode: '20', taxRate: 0 }
      );

      expect(html).toContain('Op. Exonerada:');
      expect(html).toContain('AMAZONÍA REGIÓN SELVA');
      expect(html).not.toContain('IGV (');
    });
  });

  describe('printer config persistence', () => {
    it('saves and retrieves merged PrinterConfig using in-memory cache', async () => {
      const saved = await savePrinterConfig({ paperWidth: 58, openCashDrawer: true });
      expect(saved.paperWidth).toBe(58);
      expect(saved.openCashDrawer).toBe(true);
      expect(mockAsyncStorage.has(PRINTER_CONFIG_STORAGE_KEY)).toBe(true);

      const AsyncStorageMock = (await import('@react-native-async-storage/async-storage')).default;
      const callsBefore = (AsyncStorageMock.getItem as ReturnType<typeof vi.fn>).mock.calls.length;
      const loaded1 = await getPrinterConfig();
      const loaded2 = await getPrinterConfig();
      expect(loaded1).toEqual(saved);
      expect(loaded2).toEqual(saved);
      expect((AsyncStorageMock.getItem as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

      resetPrinterConfigCache();
      const loadedFromStorage = await getPrinterConfig();
      expect(loadedFromStorage).toEqual(saved);
      expect((AsyncStorageMock.getItem as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
    });
  });
});
