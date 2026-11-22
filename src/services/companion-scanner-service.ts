/**
 * Ventify Mobile - Companion Remote Scanner Service
 *
 * Protocolo de vinculación y sincronización en tiempo real entre el dispositivo móvil
 * y Ventify Web mediante el endpoint oficial `/api/scanner/reader` con cookie HttpOnly
 * (`credentials: 'include'`).
 */

import { Platform, AppState } from 'react-native';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { APP_URL } from '@/lib/firebase';

// ============================================================================
// CONSTANTES Y TIPOS DEL PROTOCOLO
// ============================================================================

export const SCANNER_COLLECTION_WEB = 'mobile_scanner_sessions';
export const SCANNER_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 horas
export const SCANNER_DESKTOP_TIMEOUT_MS = 45_000;      // 45 segundos sin pulso
export const SCAN_DEBOUNCE_COOLDOWN_MS = 1200;         // 1.2s anti-rebote
export const SCANNER_APP_VERSION = '2.0.1';

const READER_REQUEST_TIMEOUT_MS = 8000;
const STATUS_ACTIVE_POLL_INTERVAL_MS = 2500;
const STATUS_IDLE_POLL_INTERVAL_MS = 5000;
const IDLE_POLLS_THRESHOLD = 2;
const STATUS_ERROR_BACKOFF_MS = 3000;
const STATUS_MAX_ERROR_BACKOFF_MS = 12000;
const MAX_SESSION_BASE_URLS = 20;

const SESSION_ID_REGEX = /^[A-Za-z0-9]{20}$/;
const PAIR_TOKEN_REGEX = /^[a-f0-9]{64}$/;
const SCANNER_CODE_REGEX = /^[A-Za-z0-9._-]{2,128}$/;

export type ScannerPurpose = 'sale' | 'product' | 'inventory';
export type ScanResult = 'pending' | 'added' | 'captured' | 'selection' | 'rejected';

export interface ScannerScan {
  id: string;
  code: string;
  createdAt: number;
  result: ScanResult;
  message: string;
}

export interface CompanionDeviceInfo {
  platform?: string;
  modelName?: string;
  deviceName?: string;
  osVersion?: string;
  appVersion?: string;
  batteryLevel?: number;
}

export interface CompanionSessionData {
  sessionId: string;
  token?: string;
  baseUrl?: string;
  purpose: ScannerPurpose;
  accountId?: string;
  branchId?: string;
  cashSessionId?: string;
  ownerUid?: string;
  expiresAt: number;
  pairExpiresAt?: number;
  desktopSeenAt?: number;
  paired: boolean;
  revoked: boolean;
  status: 'connected' | 'disconnected' | 'pending';
  lastHeartbeatAt?: number;
  connectedDevice?: CompanionDeviceInfo;
  scan?: ScannerScan | null;
}

export interface ParsedQrResult {
  sessionId: string;
  token?: string;
  baseUrl: string;
  purpose?: ScannerPurpose;
  raw: string;
}

export interface ProductPreview {
  id?: string;
  name: string;
  price?: number;
  sku?: string;
  barcode?: string;
  imageUrl?: string;
}

export interface ScannedCodeHistoryItem {
  id: string;
  code: string;
  timestamp: number;
  status: 'sent' | 'pending' | 'rejected' | 'added';
  productName?: string;
  productPrice?: number;
  message?: string;
}

export class ScannerApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ScannerApiError';
  }
}

const sessionBaseUrlMap = new Map<string, string>();

const setSessionBaseUrl = (sessionId: string, baseUrl: string): void => {
  if (sessionBaseUrlMap.has(sessionId)) {
    sessionBaseUrlMap.delete(sessionId);
  } else if (sessionBaseUrlMap.size >= MAX_SESSION_BASE_URLS) {
    const oldestKey = sessionBaseUrlMap.keys().next().value;
    if (oldestKey !== undefined) {
      sessionBaseUrlMap.delete(oldestKey);
    }
  }
  sessionBaseUrlMap.set(sessionId, baseUrl);
};

const normalizeBaseUrl = (url?: string | null): string => {
  const candidate = (url || APP_URL || 'https://ventify.com.pe').trim().replace(/\/+$/, '');
  return candidate || 'https://ventify.com.pe';
};

const resolveSessionBaseUrl = (sessionId: string, overrideBaseUrl?: string): string => {
  if (overrideBaseUrl) {
    const normalized = normalizeBaseUrl(overrideBaseUrl);
    setSessionBaseUrl(sessionId, normalized);
    return normalized;
  }
  return sessionBaseUrlMap.get(sessionId) || normalizeBaseUrl(APP_URL);
};

interface ReaderApiResponse {
  purpose?: ScannerPurpose;
  expiresAt?: number;
  scan?: ScannerScan | null;
  error?: string;
}

async function postReaderAction(
  baseUrl: string,
  payload:
    | { sessionId: string; action: 'pair'; token: string }
    | { sessionId: string; action: 'status' }
    | { sessionId: string; action: 'scan'; id: string; code: string },
  externalSignal?: AbortSignal
): Promise<ReaderApiResponse> {
  if (externalSignal?.aborted) {
    throw new ScannerApiError('Solicitud de escáner cancelada.', 499);
  }
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, READER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/scanner/reader`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as ReaderApiResponse | null;

    if (!response.ok) {
      throw new ScannerApiError(
        body?.error || `Error de comunicación con Ventify Web (${response.status}).`,
        response.status
      );
    }

    if (!body || typeof body !== 'object') {
      throw new ScannerApiError('Respuesta inválida del servidor del escáner.', 502);
    }

    return body;
  } catch (err: any) {
    if (err instanceof ScannerApiError) {
      throw err;
    }
    if (externallyAborted && !timedOut) {
      throw new ScannerApiError('Solicitud de escáner cancelada.', 499);
    }
    if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
      throw new ScannerApiError('La conexión con la computadora tardó demasiado.', 408);
    }
    throw new ScannerApiError(
      err?.message || 'No se pudo conectar con la computadora. Revisa tu conexión.',
      0
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

// ============================================================================
// PARSEO INTELIGENTE DE CÓDIGOS QR
// ============================================================================

/**
 * Parsea cualquier código QR de vinculación generado por Ventify Web POS.
 * Soporta:
 * 1. URLs con fragmento hash: https://ventify.com.pe/scanner/{sessionId}#{token}
 * 2. URLs con query param: https://ventify.com.pe/scanner/{sessionId}?token={token}
 * 3. Enlaces relativos o personalizados: ventify://scanner/{sessionId}#{token}
 * 4. Payloads JSON: {"sessionId": "...", "token": "..."}
 * 5. Códigos compuestos: {sessionId}#{token} o {sessionId}:{token}
 * 6. ID de sesión directo alfanumérico.
 */
export function parseScannerQrCode(rawInput: string): ParsedQrResult {
  const trimmed = (rawInput || '').trim();
  const defaultBaseUrl = normalizeBaseUrl(APP_URL);

  if (!trimmed) {
    throw new Error('El código QR o enlace de vinculación está vacío.');
  }

  // 1. Detección de formato JSON estructurado
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsedJson = JSON.parse(trimmed);
      const sessionId = parsedJson.sessionId || parsedJson.id || parsedJson.sid;
      if (sessionId && typeof sessionId === 'string') {
        return {
          sessionId: sessionId.trim(),
          token: typeof parsedJson.token === 'string' ? parsedJson.token.trim() : undefined,
          baseUrl:
            typeof parsedJson.baseUrl === 'string'
              ? normalizeBaseUrl(parsedJson.baseUrl)
              : defaultBaseUrl,
          purpose: parsedJson.purpose as ScannerPurpose | undefined,
          raw: trimmed,
        };
      }
    } catch {
      // Continuar con los siguientes formatos
    }
  }

  // 2. Detección de formato URL
  const isHttpUrl = /^https?:\/\//i.test(trimmed);
  const isUrlLike =
    isHttpUrl ||
    trimmed.includes('/scanner/') ||
    trimmed.includes('token=') ||
    trimmed.startsWith('ventify://');

  if (isUrlLike) {
    try {
      const normalizedUrl = isHttpUrl
        ? trimmed
        : `${defaultBaseUrl}/${trimmed.replace(/^[a-z0-9_-]+:\/\//i, '').replace(/^\/+/, '')}`;

      const url = new URL(normalizedUrl);
      const segments = url.pathname.split('/').filter(Boolean);
      const scannerIdx = segments.findIndex((s) => s === 'scanner');
      let sessionId = '';
      if (scannerIdx !== -1 && segments.length > scannerIdx + 1) {
        sessionId = segments[scannerIdx + 1];
      }

      let token: string | undefined;
      if (url.hash && url.hash.length > 1) {
        token = url.hash.slice(1);
      }
      if (!token && url.searchParams.get('token')) {
        token = url.searchParams.get('token') || undefined;
      }
      if (!sessionId && url.searchParams.get('sessionId')) {
        sessionId = url.searchParams.get('sessionId') || '';
      }

      const purposeParam = url.searchParams.get('purpose') as ScannerPurpose | null;
      const baseUrl =
        isHttpUrl && url.origin && url.origin !== 'null'
          ? normalizeBaseUrl(url.origin)
          : defaultBaseUrl;

      if (sessionId) {
        return {
          sessionId: sessionId.trim(),
          token: token ? token.trim() : undefined,
          baseUrl,
          purpose: purposeParam || undefined,
          raw: trimmed,
        };
      }
    } catch {
      // Continuar al fallback de expresiones regulares
    }

    const match = trimmed.match(/\/scanner\/([A-Za-z0-9_-]{8,64})(?:#([a-f0-9]{32,64}))?/i);
    if (match) {
      return {
        sessionId: match[1],
        token: match[2] || undefined,
        baseUrl: defaultBaseUrl,
        raw: trimmed,
      };
    }
  }

  // 3. Formato compuesto delimitado: sessionId#token o sessionId:token
  if (trimmed.includes('#') || trimmed.includes(':')) {
    const parts = trimmed.split(/[#:]/);
    if (parts.length >= 2 && parts[0].trim().length >= 8) {
      return {
        sessionId: parts[0].trim(),
        token: parts[1].trim(),
        baseUrl: defaultBaseUrl,
        raw: trimmed,
      };
    }
  }

  // 4. ID de sesión directo
  const cleanId = trimmed.replace(/[^A-Za-z0-9_-]/g, '');
  if (cleanId.length >= 8) {
    return {
      sessionId: cleanId,
      baseUrl: defaultBaseUrl,
      raw: trimmed,
    };
  }

  throw new Error('Código QR no reconocido. Escanea el código QR que se muestra en Ventify Web en tu PC.');
}

// ============================================================================
// CONEXIÓN Y VINCULACIÓN CON LA SESIÓN DE ESCRITORIO
// ============================================================================

/**
 * Empareja el dispositivo móvil con Ventify Web mediante POST `${baseUrl}/api/scanner/reader`
 * con payload estricto `{ sessionId, action: 'pair', token }` y cookie HttpOnly (`credentials: 'include'`).
 */
export async function connectScannerSession(
  rawQrOrSessionId: string,
  deviceInfo?: CompanionDeviceInfo
): Promise<CompanionSessionData> {
  const parsed = parseScannerQrCode(rawQrOrSessionId);
  const { sessionId, token, baseUrl, purpose: parsedPurpose } = parsed;
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new ScannerApiError(
      'El identificador de sesión del QR no es válido. Genera un nuevo QR en Ventify Web.',
      400
    );
  }

  if (!token || !PAIR_TOKEN_REGEX.test(token)) {
    throw new ScannerApiError(
      'El código QR no incluye un token de seguridad válido. Escanea el código QR completo desde Ventify Web.',
      400
    );
  }

  const response = await postReaderAction(resolvedBaseUrl, {
    sessionId,
    action: 'pair',
    token,
  });

  setSessionBaseUrl(sessionId, resolvedBaseUrl);

  const now = Date.now();
  const resolvedDeviceInfo: CompanionDeviceInfo = {
    platform: Platform.OS,
    modelName: Device.modelName || Platform.OS,
    deviceName: Device.deviceName || `Móvil ${Platform.OS}`,
    osVersion: Device.osVersion || '',
    appVersion: SCANNER_APP_VERSION,
    ...deviceInfo,
  };

  return {
    sessionId,
    token,
    baseUrl: resolvedBaseUrl,
    purpose: response.purpose || parsedPurpose || 'sale',
    expiresAt: response.expiresAt || now + SCANNER_LIFETIME_MS,
    paired: true,
    revoked: false,
    status: 'connected',
    lastHeartbeatAt: now,
    connectedDevice: resolvedDeviceInfo,
    scan: response.scan ?? null,
  };
}

// ============================================================================
// TRANSMISIÓN INSTANTÁNEA DE CÓDIGO DE BARRAS A LA PC
// ============================================================================

/**
 * Genera un UUID v4 RFC-4122 válido para la lectura del escáner.
 */
export function generateScanId(): string {
  try {
    if (typeof Crypto.randomUUID === 'function') {
      return Crypto.randomUUID();
    }
  } catch {}

  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {}

  const bytes = new Uint8Array(16);
  try {
    if (typeof Crypto.getRandomBytes === 'function') {
      bytes.set(Crypto.getRandomBytes(16));
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Transmite el código de barras escaneado al mostrador mediante
 * POST `${baseUrl}/api/scanner/reader` con payload estricto `{ sessionId, action: 'scan', id, code }`.
 */
export async function sendScannedCodeToDesktop(
  sessionId: string,
  barcode: string,
  _token?: string,
  productPreview?: ProductPreview,
  baseUrl?: string,
  scanIdOverride?: string
): Promise<ScannerScan> {
  const code = (barcode || '').trim();
  if (!SCANNER_CODE_REGEX.test(code)) {
    throw new ScannerApiError(
      'Código de barras inválido (debe tener entre 2 y 128 caracteres válidos).',
      400
    );
  }

  const scanId = scanIdOverride || generateScanId();
  const resolvedBaseUrl = resolveSessionBaseUrl(sessionId, baseUrl);

  const response = await postReaderAction(resolvedBaseUrl, {
    sessionId,
    action: 'scan',
    id: scanId,
    code,
  });

  if (response.scan) {
    return response.scan;
  }

  return {
    id: scanId,
    code,
    createdAt: Date.now(),
    result: 'pending',
    message: productPreview
      ? `${productPreview.name}${productPreview.price !== undefined ? ` (S/ ${productPreview.price.toFixed(2)})` : ''}`
      : `Código: ${code}`,
  };
}

// ============================================================================
// CONSULTA Y SUSCRIPCIÓN DE ESTADO VIA /api/scanner/reader
// ============================================================================

/**
 * Consulta el estado actual de la sesión emparejada usando `{ sessionId, action: 'status' }`.
 */
export async function getScannerSessionStatus(
  sessionId: string,
  baseUrl?: string,
  signal?: AbortSignal
): Promise<{
  purpose: ScannerPurpose;
  expiresAt: number;
  scan: ScannerScan | null;
}> {
  const resolvedBaseUrl = resolveSessionBaseUrl(sessionId, baseUrl);
  const response = await postReaderAction(
    resolvedBaseUrl,
    {
      sessionId,
      action: 'status',
    },
    signal
  );

  return {
    purpose: response.purpose || 'sale',
    expiresAt: response.expiresAt || Date.now() + SCANNER_LIFETIME_MS,
    scan: response.scan ?? null,
  };
}

interface SessionStateSnapshot {
  purpose: ScannerPurpose;
  expiresAt: number;
  scanId: string | null;
  scanResult: ScanResult | null;
  scanCode: string | null;
  scanMessage: string | null;
  revoked: boolean;
}

const createSessionSnapshot = (
  purpose: ScannerPurpose,
  expiresAt: number,
  scan: ScannerScan | null | undefined,
  revoked: boolean
): SessionStateSnapshot => ({
  purpose,
  expiresAt,
  scanId: scan?.id ?? null,
  scanResult: scan?.result ?? null,
  scanCode: scan?.code ?? null,
  scanMessage: scan?.message ?? null,
  revoked,
});

const hasSessionSnapshotChanged = (
  prev: SessionStateSnapshot | null,
  next: SessionStateSnapshot
): boolean => {
  if (!prev) return true;
  return (
    prev.purpose !== next.purpose ||
    prev.expiresAt !== next.expiresAt ||
    prev.scanId !== next.scanId ||
    prev.scanResult !== next.scanResult ||
    prev.scanCode !== next.scanCode ||
    prev.scanMessage !== next.scanMessage ||
    prev.revoked !== next.revoked
  );
};

/**
 * Sondea el estado de la sesión vinculada contra `/api/scanner/reader` (`action: 'status'`)
 * con control de backpressure, sondeo adaptativo (2500ms activo -> 5000ms inactivo),
 * AbortSignal en segundo plano/desuscripción y comparación escalar sin JSON.stringify.
 */
export function subscribeToScannerSession(
  sessionId: string,
  onUpdate: (session: CompanionSessionData) => void,
  onError?: (error: Error) => void,
  baseUrl?: string
): () => void {
  const resolvedBaseUrl = resolveSessionBaseUrl(sessionId, baseUrl);
  let isActive = true;
  let isPollingInFlight = false;
  let hasEmittedFirst = false;
  let lastSnapshot: SessionStateSnapshot | null = null;
  let unchangedIdlePolls = 0;
  let consecutiveErrors = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activePollController: AbortController | null = null;

  const hasAppStateListener = typeof AppState?.addEventListener === 'function';
  let listenerTriggered = false;
  let isPausedByAppState = Boolean(AppState?.currentState && AppState.currentState !== 'active');
  let appStateSubscription: { remove?: () => void } | null = null;

  const clearPollTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const abortActivePoll = () => {
    if (activePollController) {
      activePollController.abort();
      activePollController = null;
    }
  };

  const cleanupAppStateListener = () => {
    if (appStateSubscription && typeof appStateSubscription.remove === 'function') {
      appStateSubscription.remove();
    }
    appStateSubscription = null;
  };

  const isAppBackgrounded = () => {
    if (listenerTriggered) return isPausedByAppState;
    return isPausedByAppState || Boolean(AppState?.currentState && AppState.currentState !== 'active');
  };

  const scheduleNext = (delayMs: number) => {
    if (!isActive || (hasAppStateListener && isAppBackgrounded())) return;
    clearPollTimer();
    timer = setTimeout(() => {
      void pollOnce();
    }, delayMs);
  };

  const pollOnce = async () => {
    if (!isActive || isPollingInFlight) return;

    if (isAppBackgrounded()) {
      isPausedByAppState = true;
      if (!hasAppStateListener) {
        scheduleNext(STATUS_IDLE_POLL_INTERVAL_MS);
      }
      return;
    }

    isPollingInFlight = true;
    const pollController = new AbortController();
    activePollController = pollController;
    try {
      const state = await getScannerSessionStatus(sessionId, resolvedBaseUrl, pollController.signal);
      if (!isActive || pollController.signal.aborted) return;

      consecutiveErrors = 0;
      const nextSnapshot = createSessionSnapshot(state.purpose, state.expiresAt, state.scan, false);
      const changed = !hasEmittedFirst || hasSessionSnapshotChanged(lastSnapshot, nextSnapshot);
      if (changed) {
        hasEmittedFirst = true;
        lastSnapshot = nextSnapshot;
        unchangedIdlePolls = 0;
        onUpdate({
          sessionId,
          baseUrl: resolvedBaseUrl,
          purpose: state.purpose,
          expiresAt: state.expiresAt,
          paired: true,
          revoked: false,
          status: 'connected',
          lastHeartbeatAt: Date.now(),
          scan: state.scan,
        });
      } else if (state.scan?.result === 'pending') {
        unchangedIdlePolls = 0;
      } else {
        unchangedIdlePolls += 1;
      }

      const nextIntervalMs =
        unchangedIdlePolls >= IDLE_POLLS_THRESHOLD
          ? STATUS_IDLE_POLL_INTERVAL_MS
          : STATUS_ACTIVE_POLL_INTERVAL_MS;
      scheduleNext(nextIntervalMs);
    } catch (err: any) {
      if (!isActive || pollController.signal.aborted) return;
      const status = err instanceof ScannerApiError ? err.status : 0;

      if (status === 401 || status === 403 || status === 410) {
        isActive = false;
        clearPollTimer();
        cleanupAppStateListener();
        sessionBaseUrlMap.delete(sessionId);
        const revokedExpiresAt = Date.now();
        hasEmittedFirst = true;
        lastSnapshot = createSessionSnapshot('sale', revokedExpiresAt, null, true);
        onUpdate({
          sessionId,
          baseUrl: resolvedBaseUrl,
          purpose: 'sale',
          expiresAt: revokedExpiresAt,
          paired: false,
          revoked: true,
          status: 'disconnected',
          scan: null,
        });
        return;
      }

      if (onError) {
        onError(err instanceof Error ? err : new Error('Error consultando estado del escáner'));
      }
      const backoffMs = Math.min(
        STATUS_MAX_ERROR_BACKOFF_MS,
        STATUS_ERROR_BACKOFF_MS * Math.pow(2, consecutiveErrors)
      );
      consecutiveErrors += 1;
      scheduleNext(backoffMs);
    } finally {
      if (activePollController === pollController) {
        activePollController = null;
      }
      isPollingInFlight = false;
    }
  };

  if (hasAppStateListener) {
    appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (!isActive) return;
      listenerTriggered = true;
      if (nextState === 'active') {
        if (isPausedByAppState) {
          isPausedByAppState = false;
          unchangedIdlePolls = 0;
          clearPollTimer();
          void pollOnce();
        }
      } else {
        isPausedByAppState = true;
        clearPollTimer();
        abortActivePoll();
      }
    });
  }

  void pollOnce();

  return () => {
    isActive = false;
    cleanupAppStateListener();
    clearPollTimer();
    abortActivePoll();
  };
}

// ============================================================================
// DESCONEXIÓN LIMPIA DE LA SESIÓN
// ============================================================================

/**
 * Libera el estado local de vinculación del escáner en el dispositivo móvil.
 */
export async function disconnectScannerSession(sessionId: string): Promise<void> {
  sessionBaseUrlMap.delete(sessionId);
}

// ============================================================================
// HELPERS DE HÁPTICA Y FORMATO
// ============================================================================

/**
 * Ejecuta vibración háptica según el resultado del escaneo.
 */
export async function triggerScanHaptic(
  type: 'success' | 'warning' | 'error' | 'light' = 'success'
): Promise<void> {
  try {
    if (type === 'success') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (type === 'error') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else if (type === 'warning') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  } catch {
    // Silencioso en caso de dispositivos sin motor de vibración o simuladores
  }
}

/**
 * Devuelve el nombre legible en español del propósito de la sesión.
 */
export function formatSessionPurpose(purpose?: ScannerPurpose): string {
  switch (purpose) {
    case 'product':
      return 'Catálogo y Productos';
    case 'inventory':
      return 'Ajustes de Inventario';
    case 'sale':
    default:
      return 'Ventas en Mostrador (POS)';
  }
}
