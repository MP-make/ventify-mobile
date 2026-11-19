import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRandomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
const mockGetRandomBytes = vi.fn((n: number) => new Uint8Array(n).fill(0xab));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34 },
  AppState: { currentState: 'active' },
}));

vi.mock('expo-device', () => ({
  modelName: 'Pixel 8',
  deviceName: 'Caja Movil 1',
  osVersion: '14',
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => mockGetRandomBytes(n),
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

vi.mock('@/lib/firebase', () => ({
  APP_URL: 'https://ventify.com.pe',
}));

import {
  parseScannerQrCode,
  connectScannerSession,
  sendScannedCodeToDesktop,
  getScannerSessionStatus,
  subscribeToScannerSession,
  disconnectScannerSession,
  generateScanId,
  ScannerApiError,
  SCANNER_APP_VERSION,
} from '../companion-scanner-service';

const VALID_SESSION_ID = 'AbCdEf1234567890XyZw';
const VALID_TOKEN = 'a'.repeat(64);

describe('companion-scanner-service (/api/scanner/reader strict protocol)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockRandomUUID.mockImplementation(() => '11111111-2222-4333-8444-555555555555');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('parseScannerQrCode', () => {
    it('parses HTTPS scanner URL with hash fragment token and preserves origin', () => {
      const parsed = parseScannerQrCode(
        `https://staging.ventify.com.pe/scanner/${VALID_SESSION_ID}#${VALID_TOKEN}`
      );
      expect(parsed.sessionId).toBe(VALID_SESSION_ID);
      expect(parsed.token).toBe(VALID_TOKEN);
      expect(parsed.baseUrl).toBe('https://staging.ventify.com.pe');
    });

    it('parses query param URL and ventify:// deep link', () => {
      const withQuery = parseScannerQrCode(
        `https://ventify.com.pe/scanner/${VALID_SESSION_ID}?token=${VALID_TOKEN}&purpose=inventory`
      );
      expect(withQuery.purpose).toBe('inventory');
      expect(withQuery.token).toBe(VALID_TOKEN);

      const deepLink = parseScannerQrCode(
        `ventify://scanner/${VALID_SESSION_ID}#${VALID_TOKEN}`
      );
      expect(deepLink.sessionId).toBe(VALID_SESSION_ID);
      expect(deepLink.token).toBe(VALID_TOKEN);
      expect(deepLink.baseUrl).toBe('https://ventify.com.pe');
    });

    it('throws when input is empty or unrecognizable', () => {
      expect(() => parseScannerQrCode('')).toThrow();
      expect(() => parseScannerQrCode('abc')).toThrow();
    });
  });

  describe('generateScanId', () => {
    it('always returns a valid RFC-4122 UUID even when Crypto.randomUUID fails', () => {
      expect(generateScanId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      mockRandomUUID.mockImplementationOnce(() => {
        throw new Error('Crypto.randomUUID unavailable');
      });
      const origCrypto = globalThis.crypto;
      vi.stubGlobal('crypto', undefined);
      const fallbackId = generateScanId();
      vi.stubGlobal('crypto', origCrypto);

      expect(fallbackId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('connectScannerSession', () => {
    it('posts strict pair payload to /api/scanner/reader with credentials include and appVersion 2.0.1', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          purpose: 'sale',
          expiresAt: 1999999999000,
          scan: null,
        }),
      });

      const session = await connectScannerSession(
        `https://pos.ventify.com.pe/scanner/${VALID_SESSION_ID}#${VALID_TOKEN}`
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://pos.ventify.com.pe/api/scanner/reader');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(JSON.parse(init.body)).toEqual({
        sessionId: VALID_SESSION_ID,
        action: 'pair',
        token: VALID_TOKEN,
      });

      expect(session.paired).toBe(true);
      expect(session.status).toBe('connected');
      expect(session.purpose).toBe('sale');
      expect(session.connectedDevice?.appVersion).toBe('2.0.1');
      expect(SCANNER_APP_VERSION).toBe('2.0.1');
    });

    it('rejects invalid sessionId or missing token before network call', async () => {
      await expect(connectScannerSession('short_id')).rejects.toThrow(ScannerApiError);
      await expect(
        connectScannerSession(`https://ventify.com.pe/scanner/${VALID_SESSION_ID}`)
      ).rejects.toThrow(ScannerApiError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propagates server rejection instead of returning fake connected state', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: 'Ya hay otro teléfono vinculado. Genera un nuevo QR desde la computadora.',
        }),
      });

      await expect(
        connectScannerSession(`https://ventify.com.pe/scanner/${VALID_SESSION_ID}#${VALID_TOKEN}`)
      ).rejects.toMatchObject({
        status: 409,
        message: 'Ya hay otro teléfono vinculado. Genera un nuevo QR desde la computadora.',
      });
    });
  });

  describe('sendScannedCodeToDesktop', () => {
    it('posts strict scan payload { sessionId, action: "scan", id: uuid, code } to paired baseUrl', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ purpose: 'product', expiresAt: 1999999999000, scan: null }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            purpose: 'product',
            expiresAt: 1999999999000,
            scan: {
              id: '11111111-2222-4333-8444-555555555555',
              code: '7751234567891',
              createdAt: 1700000000000,
              result: 'pending',
              message: '',
            },
          }),
        });

      await connectScannerSession(
        `https://custom.ventify.com.pe/scanner/${VALID_SESSION_ID}#${VALID_TOKEN}`
      );
      const scan = await sendScannedCodeToDesktop(VALID_SESSION_ID, ' 7751234567891 ');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [scanUrl, scanInit] = fetchMock.mock.calls[1];
      expect(scanUrl).toBe('https://custom.ventify.com.pe/api/scanner/reader');
      expect(scanInit.credentials).toBe('include');
      expect(JSON.parse(scanInit.body)).toEqual({
        sessionId: VALID_SESSION_ID,
        action: 'scan',
        id: '11111111-2222-4333-8444-555555555555',
        code: '7751234567891',
      });
      expect(scan.code).toBe('7751234567891');
      expect(scan.result).toBe('pending');
    });

    it('rejects invalid barcode format locally and propagates 409/410 server errors', async () => {
      await expect(sendScannedCodeToDesktop(VALID_SESSION_ID, 'x')).rejects.toThrow(ScannerApiError);
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: 'Espera la respuesta de la computadora antes de escanear otro producto.',
        }),
      });

      await expect(
        sendScannedCodeToDesktop(VALID_SESSION_ID, '7751234567891', undefined, undefined, 'https://ventify.com.pe')
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('getScannerSessionStatus & subscribeToScannerSession', () => {
    it('sends strict status action and marks session revoked on 410 without Firestore calls', async () => {
      vi.useFakeTimers();

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            purpose: 'sale',
            expiresAt: 1999999999000,
            scan: {
              id: '11111111-2222-4333-8444-555555555555',
              code: '7750001112223',
              createdAt: 1700000000000,
              result: 'added',
              message: 'Agregado',
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 410,
          json: async () => ({
            error: 'La caja se cerró. Vincula el teléfono a una caja abierta.',
          }),
        });

      const onUpdate = vi.fn();
      const unsub = subscribeToScannerSession(
        VALID_SESSION_ID,
        onUpdate,
        undefined,
        'https://ventify.com.pe'
      );

      await vi.waitFor(() => {
        expect(onUpdate).toHaveBeenCalledTimes(1);
      });

      const [statusUrl, statusInit] = fetchMock.mock.calls[0];
      expect(statusUrl).toBe('https://ventify.com.pe/api/scanner/reader');
      expect(statusInit.credentials).toBe('include');
      expect(JSON.parse(statusInit.body)).toEqual({
        sessionId: VALID_SESSION_ID,
        action: 'status',
      });
      expect(onUpdate.mock.calls[0][0].scan?.result).toBe('added');

      await vi.advanceTimersByTimeAsync(1600);
      await vi.waitFor(() => {
        expect(onUpdate).toHaveBeenCalledTimes(2);
      });
      expect(onUpdate.mock.calls[1][0].revoked).toBe(true);
      expect(onUpdate.mock.calls[1][0].status).toBe('disconnected');

      unsub();

      // disconnectScannerSession clears local cache without hitting phantom HTTP endpoints
      await disconnectScannerSession(VALID_SESSION_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Verify getScannerSessionStatus directly as well
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ purpose: 'inventory', expiresAt: 1999999999000, scan: null }),
      });
      const directStatus = await getScannerSessionStatus(VALID_SESSION_ID, 'https://ventify.com.pe');
      expect(directStatus.purpose).toBe('inventory');
    });
  });
});
