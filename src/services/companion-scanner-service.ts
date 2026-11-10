/**
 * Ventify Mobile - Companion Remote Scanner Service
 * 
 * Protocolo de vinculación y sincronización inalámbrica en tiempo real
 * entre el teléfono móvil y Ventify Web en PC de mostrador.
 * 
 * Permite convertir el celular en una pistola lectora láser de alta velocidad
 * para Ventas (POS), Productos e Inventario sin dependencias externas.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  collection,
  addDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, APP_URL } from '@/lib/firebase';

// ============================================================================
// CONSTANTES Y TIPOS DEL PROTOCOLO
// ============================================================================

export const SCANNER_COLLECTION_WEB = 'mobile_scanner_sessions';
export const SCANNER_COLLECTION_ALIAS = 'scanner_sessions';
export const SCANNER_EVENTS_COLLECTION = 'scanner_events';

export const SCANNER_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 horas
export const SCANNER_DESKTOP_TIMEOUT_MS = 45_000;      // 45 segundos sin pulso
export const SCAN_DEBOUNCE_COOLDOWN_MS = 1200;         // 1.2s anti-rebote

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
 * 6. ID de sesión directo de 20 caracteres alfanuméricos.
 */
export function parseScannerQrCode(rawInput: string): ParsedQrResult {
  const trimmed = (rawInput || '').trim();
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
          baseUrl: typeof parsedJson.baseUrl === 'string' ? parsedJson.baseUrl.trim() : APP_URL,
          purpose: parsedJson.purpose as ScannerPurpose | undefined,
          raw: trimmed,
        };
      }
    } catch {
      // Si falla el parse JSON continúa con los siguientes formatos
    }
  }

  // 2. Detección de formato URL
  const isUrlLike =
    /^https?:\/\//i.test(trimmed) ||
    trimmed.includes('/scanner/') ||
    trimmed.includes('token=') ||
    trimmed.startsWith('ventify://');

  if (isUrlLike) {
    try {
      const normalizedUrl = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://ventify.com.pe/${trimmed.replace(/^[a-z0-9_-]+:\/\//i, '').replace(/^\/+/, '')}`;

      const url = new URL(normalizedUrl);

      // Extracción de sessionId desde la ruta: /scanner/{sessionId} o /api/scanner/{sessionId}
      const segments = url.pathname.split('/').filter(Boolean);
      const scannerIdx = segments.findIndex((s) => s === 'scanner');
      let sessionId = '';
      if (scannerIdx !== -1 && segments.length > scannerIdx + 1) {
        sessionId = segments[scannerIdx + 1];
      }

      // Extracción del token desde el hash fragment (#64hexToken)
      let token: string | undefined = undefined;
      if (url.hash && url.hash.length > 1) {
        token = url.hash.slice(1);
      }

      // Extracción alternativa desde query parameters (?token=... & sessionId=...)
      if (!token && url.searchParams.get('token')) {
        token = url.searchParams.get('token') || undefined;
      }
      if (!sessionId && url.searchParams.get('sessionId')) {
        sessionId = url.searchParams.get('sessionId') || '';
      }

      const purposeParam = url.searchParams.get('purpose') as ScannerPurpose | null;
      const baseUrl = url.origin && url.origin !== 'null' ? url.origin : APP_URL;

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

    // Fallback con Regex para URLs o URIs no estándar
    const match = trimmed.match(/\/scanner\/([A-Za-z0-9_-]{10,64})(?:#([a-f0-9]{32,64}))?/i);
    if (match) {
      return {
        sessionId: match[1],
        token: match[2] || undefined,
        baseUrl: APP_URL,
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
        baseUrl: APP_URL,
        raw: trimmed,
      };
    }
  }

  // 4. ID de sesión directo (alfanumérico limpio)
  const cleanId = trimmed.replace(/[^A-Za-z0-9_-]/g, '');
  if (cleanId.length >= 8) {
    return {
      sessionId: cleanId,
      baseUrl: APP_URL,
      raw: trimmed,
    };
  }

  throw new Error('Código QR no reconocido. Escanea el código QR que se muestra en Ventify Web en tu PC.');
}

// ============================================================================
// CONEXIÓN Y VINCULACIÓN CON LA SESIÓN DE ESCRITORIO
// ============================================================================

/**
 * Conecta y valida la sesión de escáner remoto con Ventify Web.
 * Actualiza Firestore marcando el dispositivo móvil como conectado y notifica
 * a los endpoints HTTP del servidor para emparejamiento inmediato.
 */
export async function connectScannerSession(
  rawQrOrSessionId: string,
  deviceInfo?: CompanionDeviceInfo
): Promise<CompanionSessionData> {
  const parsed = parseScannerQrCode(rawQrOrSessionId);
  const { sessionId, token, baseUrl, purpose: parsedPurpose } = parsed;
  const now = Date.now();
  const resolvedBaseUrl = baseUrl || APP_URL;

  // Recopilar información nativa del dispositivo
  const resolvedDeviceInfo: CompanionDeviceInfo = {
    platform: Platform.OS,
    modelName: Device.modelName || Platform.OS,
    deviceName: Device.deviceName || `Móvil ${Platform.OS}`,
    osVersion: Device.osVersion || '',
    appVersion: '2.0.0',
    ...deviceInfo,
  };

  const mobileRef = doc(db, SCANNER_COLLECTION_WEB, sessionId);
  const aliasRef = doc(db, SCANNER_COLLECTION_ALIAS, sessionId);

  let existingData: any = null;

  // 1. Verificación en Firestore (consultando colecciones web y alias)
  try {
    const snap = await getDoc(mobileRef);
    if (snap.exists()) {
      existingData = snap.data();
    } else {
      const snapAlias = await getDoc(aliasRef);
      if (snapAlias.exists()) {
        existingData = snapAlias.data();
      }
    }
  } catch (error) {
    console.warn('[CompanionScanner] Firestore snapshot read warning:', error);
  }

  // 2. Validaciones de estado de sesión
  if (existingData) {
    if (existingData.revoked) {
      throw new Error('El vínculo fue revocado desde la computadora. Genera un nuevo QR en Ventify Web.');
    }
    if (existingData.expiresAt && existingData.expiresAt <= now) {
      throw new Error('El código QR ha expirado. Por favor genera un nuevo QR en la computadora.');
    }
  }

  // 3. Actualizar Firestore marcando el teléfono como conectado
  const connectionPayload = {
    paired: true,
    status: 'connected',
    lastHeartbeatAt: now,
    connectedAt: now,
    token: token || existingData?.token || '',
    connectedDevice: resolvedDeviceInfo,
  };

  try {
    await Promise.all([
      setDoc(mobileRef, connectionPayload, { merge: true }),
      setDoc(aliasRef, connectionPayload, { merge: true }),
    ]);
  } catch (error) {
    console.warn('[CompanionScanner] Non-fatal Firestore sync warning:', error);
  }

  // 4. Notificar endpoints HTTP en paralelo (con timeout defensivo)
  void (async () => {
    // A. Endpoint oficial de Ventify Web reader (/api/scanner/reader)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      await fetch(`${resolvedBaseUrl}/api/scanner/reader`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          action: 'pair',
          token: token || '',
        }),
        signal: controller.signal,
      }).catch(() => {});
      clearTimeout(timeout);
    } catch {}

    // B. Endpoint alternativo REST (/api/scanner/{sessionId}/pair)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      await fetch(`${resolvedBaseUrl}/api/scanner/${sessionId}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token || '',
          deviceInfo: resolvedDeviceInfo,
        }),
        signal: controller.signal,
      }).catch(() => {});
      clearTimeout(timeout);
    } catch {}
  })();

  const determinedPurpose: ScannerPurpose =
    existingData?.purpose || parsedPurpose || 'sale';

  return {
    sessionId,
    token,
    purpose: determinedPurpose,
    accountId: existingData?.accountId,
    branchId: existingData?.branchId,
    cashSessionId: existingData?.cashSessionId,
    ownerUid: existingData?.ownerUid,
    expiresAt: existingData?.expiresAt || now + SCANNER_LIFETIME_MS,
    pairExpiresAt: existingData?.pairExpiresAt,
    desktopSeenAt: existingData?.desktopSeenAt?.toMillis
      ? existingData.desktopSeenAt.toMillis()
      : existingData?.desktopSeenAt,
    paired: true,
    revoked: false,
    status: 'connected',
    lastHeartbeatAt: now,
    connectedDevice: resolvedDeviceInfo,
    scan: existingData?.scan || null,
  };
}

// ============================================================================
// TRANSMISIÓN INSTANTÁNEA DE CÓDIGO DE BARRAS A LA PC
// ============================================================================

/**
 * Genera un identificador único y resistente a colisiones para la lectura.
 */
export function generateScanId(): string {
  try {
    if (typeof Crypto.randomUUID === 'function') {
      return Crypto.randomUUID();
    }
  } catch {}
  return `scan_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Transmite el código de barras escaneado al mostrador en milisegundos.
 * Envía el evento simultáneamente por:
 * 1. Firestore directo a mobile_scanner_sessions y scanner_sessions (latencia <50ms)
 * 2. Colección scanner_events para registro y despacho
 * 3. Endpoints HTTP de Ventify Web (/api/scanner/reader y /api/scanner/{sessionId}/scan)
 */
export async function sendScannedCodeToDesktop(
  sessionId: string,
  barcode: string,
  token?: string,
  productPreview?: ProductPreview
): Promise<ScannerScan> {
  const code = (barcode || '').trim();
  if (code.length < 2) {
    throw new Error('El código de barras debe contener al menos 2 caracteres.');
  }

  const scanId = generateScanId();
  const now = Date.now();

  const scanPayload: ScannerScan = {
    id: scanId,
    code,
    createdAt: now,
    result: 'pending',
    message: productPreview
      ? `${productPreview.name}${productPreview.price !== undefined ? ` (S/ ${productPreview.price.toFixed(2)})` : ''}`
      : `Código: ${code}`,
  };

  const mobileRef = doc(db, SCANNER_COLLECTION_WEB, sessionId);
  const aliasRef = doc(db, SCANNER_COLLECTION_ALIAS, sessionId);

  // 1. Escritura directa en Firestore para que el listener onSnapshot de la PC
  // reaccione inmediatamente y agregue el producto al carrito sin demoras de red
  const sessionUpdate = {
    scan: scanPayload,
    lastHeartbeatAt: now,
    lastScannedCode: code,
    lastScannedAt: now,
  };

  const tasks: Promise<any>[] = [
    setDoc(mobileRef, sessionUpdate, { merge: true }),
    setDoc(aliasRef, sessionUpdate, { merge: true }),
  ];

  // Registro en la subcolección/colección de eventos para auditoría de lecturas
  try {
    const eventsCol = collection(db, SCANNER_EVENTS_COLLECTION);
    tasks.push(
      addDoc(eventsCol, {
        sessionId,
        scanId,
        code,
        barcode: code,
        productPreview: productPreview || null,
        createdAt: now,
        timestamp: serverTimestamp(),
        status: 'pending',
      })
    );
  } catch {}

  // Ejecución concurrente protegida
  await Promise.allSettled(tasks);

  // 2. Transmisión HTTP en segundo plano a los endpoints de Ventify Web
  void (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      await fetch(`${APP_URL}/api/scanner/reader`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          action: 'scan',
          id: scanId,
          code,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {}

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      await fetch(`${APP_URL}/api/scanner/${sessionId}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: scanId,
          barcode: code,
          code,
          token,
          productPreview,
          timestamp: now,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {}
  })();

  return scanPayload;
}

// ============================================================================
// SUSCRIPCIÓN EN TIEMPO REAL Y PULSO DE VIDA
// ============================================================================

/**
 * Escucha en vivo el estado de la sesión de escaneo vinculada mediante onSnapshot.
 * Mantiene un pulso de vida (heartbeat) cada 15 segundos hacia Firestore para
 * certificar la conexión activa con la PC.
 */
export function subscribeToScannerSession(
  sessionId: string,
  onUpdate: (session: CompanionSessionData) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const mobileRef = doc(db, SCANNER_COLLECTION_WEB, sessionId);
  let isActive = true;

  // Pulso de vida continuo cada 15s para mantener el canal vivo
  const heartbeatInterval = setInterval(() => {
    if (!isActive) return;
    const now = Date.now();
    void setDoc(
      mobileRef,
      {
        lastHeartbeatAt: now,
        status: 'connected',
      },
      { merge: true }
    ).catch(() => {});
  }, 15000);

  const unsubscribe = onSnapshot(
    mobileRef,
    (snapshot) => {
      if (!isActive || !snapshot.exists()) return;

      const data = snapshot.data();
      const parsedDesktopSeen = data.desktopSeenAt?.toMillis
        ? data.desktopSeenAt.toMillis()
        : data.desktopSeenAt;

      const session: CompanionSessionData = {
        sessionId,
        token: data.token,
        purpose: data.purpose || 'sale',
        accountId: data.accountId,
        branchId: data.branchId,
        cashSessionId: data.cashSessionId,
        ownerUid: data.ownerUid,
        expiresAt: data.expiresAt || Date.now() + SCANNER_LIFETIME_MS,
        pairExpiresAt: data.pairExpiresAt,
        desktopSeenAt: parsedDesktopSeen,
        paired: Boolean(data.paired),
        revoked: Boolean(data.revoked),
        status: data.revoked ? 'disconnected' : data.paired ? 'connected' : 'pending',
        lastHeartbeatAt: data.lastHeartbeatAt,
        connectedDevice: data.connectedDevice,
        scan: data.scan || null,
      };

      onUpdate(session);
    },
    (err) => {
      console.warn('[CompanionScanner] Error en suscripción a sesión:', err);
      if (onError) onError(err);
    }
  );

  return () => {
    isActive = false;
    clearInterval(heartbeatInterval);
    unsubscribe();
  };
}

// ============================================================================
// DESCONEXIÓN LIMPIA DE LA SESIÓN
// ============================================================================

/**
 * Cierra limpiamente la vinculación entre el móvil y la computadora.
 */
export async function disconnectScannerSession(sessionId: string): Promise<void> {
  const mobileRef = doc(db, SCANNER_COLLECTION_WEB, sessionId);
  const aliasRef = doc(db, SCANNER_COLLECTION_ALIAS, sessionId);

  const disconnectData = {
    paired: false,
    status: 'disconnected',
    disconnectedAt: Date.now(),
  };

  try {
    await Promise.allSettled([
      setDoc(mobileRef, disconnectData, { merge: true }),
      setDoc(aliasRef, disconnectData, { merge: true }),
    ]);
  } catch (error) {
    console.warn('[CompanionScanner] Error al desconectar sesión en Firestore:', error);
  }

  // Notificación HTTP informativa de cierre
  void (async () => {
    try {
      await fetch(`${APP_URL}/api/scanner/${sessionId}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'disconnect' }),
      }).catch(() => {});
    } catch {}
  })();
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
