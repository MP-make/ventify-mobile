/**
 * Ventify Mobile - Notification & Haptic Feedback Service
 * 
 * Gestión de alertas locales, tokens Expo Push seguros, suscripción en tiempo real
 * a `account_notifications` en Firestore y feedback háptico con `expo-haptics`.
 * Canales Android: `critical_stock`, `sunat_alerts`, `cash_shifts` y `general_alerts`.
 */

import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

// ============================================================================
// CONFIGURACIÓN GLOBAL DEL GESTOR DE NOTIFICACIONES
// ============================================================================

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelsInitialized = false;

export type VentifyNotificationChannelId =
  | 'critical_stock'
  | 'sunat_alerts'
  | 'cash_shifts'
  | 'general_alerts';

export type AccountNotificationType =
  | 'quote'
  | 'stock'
  | 'reservation'
  | 'fiado'
  | 'cash_register'
  | 'ai_insight'
  | 'system';

export interface AccountNotification {
  id: string;
  accountId: string;
  branchId?: string;
  title: string;
  body: string;
  type: AccountNotificationType | string;
  url?: string;
  read: boolean;
  readAt?: number;
  createdAt: number;
  createdBy?: string | null;
  createdByName?: string | null;
}

export interface LocalNotificationPayload {
  title: string;
  body: string;
  channelId?: VentifyNotificationChannelId | string;
  data?: Record<string, any>;
}

// ============================================================================
// INICIALIZACIÓN DE CANALES NATIVOS (ANDROID 8+) Y PERMISOS
// ============================================================================

/**
 * Consulta el estado actual del permiso de notificaciones sin lanzar errores.
 */
export const getNotificationPermissionStatus = async (): Promise<Notifications.PermissionStatus> => {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status;
  } catch {
    return Notifications.PermissionStatus.UNDETERMINED;
  }
};

/**
 * Solicita permisos de notificación y registra los canales oficiales de Ventify.
 */
export const initNotifications = async (): Promise<boolean> => {
  if (channelsInitialized) return true;

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('[NotificationService] Permiso de notificaciones denegado por el usuario.');
      return false;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('critical_stock', {
        name: 'Stock Crítico',
        description: 'Alertas de productos con inventario bajo o agotado',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#EF4444',
        sound: 'default',
        enableVibrate: true,
        showBadge: true,
      });

      await Notifications.setNotificationChannelAsync('sunat_alerts', {
        name: 'Alertas SUNAT',
        description: 'Comprobantes observados o con incidencias tributarias',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 300, 200, 300],
        lightColor: '#F59E0B',
        sound: 'default',
        enableVibrate: true,
        showBadge: true,
      });

      await Notifications.setNotificationChannelAsync('cash_shifts', {
        name: 'Cierres de Turno y Caja',
        description: 'Notificaciones de arqueos, aperturas y Cierres Z',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 150, 150, 150],
        lightColor: '#10B981',
        sound: 'default',
        enableVibrate: true,
        showBadge: false,
      });

      await Notifications.setNotificationChannelAsync('general_alerts', {
        name: 'Alertas Generales',
        description: 'Avisos operativos, reservas, fiados y cotizaciones',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200, 150, 200],
        lightColor: '#315BE8',
        sound: 'default',
        enableVibrate: true,
        showBadge: true,
      });
    }

    channelsInitialized = true;
    return true;
  } catch (err) {
    console.warn('[NotificationService] Error inicializando notificaciones:', err);
    return false;
  }
};

/**
 * Obtiene el Expo Push Token solo cuando `extra.eas.projectId` está configurado,
 * evitando excepciones en builds locales o sin EAS configurado.
 */
export const registerForPushNotificationsAsync = async (): Promise<string | null> => {
  try {
    const granted = await initNotifications();
    if (!granted) return null;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId || typeof projectId !== 'string') {
      return null;
    }

    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenResponse?.data || null;
  } catch (err) {
    console.warn('[NotificationService] No se pudo obtener Expo Push Token:', err);
    return null;
  }
};

// ============================================================================
// DISPARADORES DE ALERTAS LOCALES
// ============================================================================

/**
 * Programa una notificación local inmediata ubicando `channelId` en `content`
 * (para Android) y manteniendo `trigger: null`.
 */
export const scheduleLocalNotification = async ({
  title,
  body,
  channelId = 'general_alerts',
  data,
}: LocalNotificationPayload): Promise<string | null> => {
  try {
    const granted = await initNotifications();
    if (!granted) return null;

    const content: Notifications.NotificationContentInput & { channelId?: string } = {
      title,
      body,
      sound: 'default',
      data: data || {},
      ...(Platform.OS === 'android' && channelId ? { channelId } : {}),
    };

    return await Notifications.scheduleNotificationAsync({
      content: content as Notifications.NotificationContentInput,
      trigger: null,
    });
  } catch (err) {
    console.warn('[NotificationService] scheduleLocalNotification error:', err);
    return null;
  }
};

/**
 * 1. Alerta de Stock Crítico: notifica cuando un producto cae por debajo del umbral mínimo
 */
export const notifyLowStock = async (
  productName: string,
  currentStock: number,
  minStock: number
): Promise<void> => {
  try {
    await triggerErrorHaptic();
    const title = `⚠️ Stock Crítico: ${productName}`;
    const body = `Quedan ${currentStock} unidades (mínimo de seguridad: ${minStock}). Es momento de reponer mercadería.`;

    await scheduleLocalNotification({
      title,
      body,
      channelId: 'critical_stock',
      data: { type: 'critical_stock', productName, currentStock, minStock },
    });
  } catch (err) {
    console.warn('[NotificationService] notifyLowStock error:', err);
  }
};

/**
 * 2. Alerta SUNAT: notifica sobre comprobantes observados o con incidencias
 */
export const notifySunatAlert = async (
  documentType: string,
  documentNumber: string,
  message: string
): Promise<void> => {
  try {
    await triggerErrorHaptic();
    const title = `🚨 Alerta SUNAT: ${documentType.toUpperCase()} ${documentNumber}`;
    const body = message || 'El comprobante electrónico requiere atención o reintento de firma.';

    await scheduleLocalNotification({
      title,
      body,
      channelId: 'sunat_alerts',
      data: { type: 'sunat_alert', documentType, documentNumber },
    });
  } catch (err) {
    console.warn('[NotificationService] notifySunatAlert error:', err);
  }
};

/**
 * 3. Notificación de Cierre de Caja: notifica el arqueo Z del turno completado
 */
export const notifyShiftClosed = async (
  branchName: string,
  countedAmount: number,
  difference: number
): Promise<void> => {
  try {
    await triggerSuccessHaptic();
    const diffText =
      difference === 0
        ? 'Cuadre Exacto'
        : difference > 0
        ? `Sobrante: +S/ ${difference.toFixed(2)}`
        : `Faltante: -S/ ${Math.abs(difference).toFixed(2)}`;

    const title = `🔒 Cierre de Turno Realizado (${branchName})`;
    const body = `Efectivo contado: S/ ${countedAmount.toFixed(2)} (${diffText}). Reporte Z generado con éxito.`;

    await scheduleLocalNotification({
      title,
      body,
      channelId: 'cash_shifts',
      data: { type: 'cash_shift', branchName, countedAmount, difference },
    });
  } catch (err) {
    console.warn('[NotificationService] notifyShiftClosed error:', err);
  }
};

// ============================================================================
// SUSCRIPCIÓN FIRESTORE IN-APP (`account_notifications`)
// ============================================================================

const toEpochMillis = (value: any): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.seconds === 'number') return value.seconds * 1000;
  return Date.now();
};

/**
 * Suscribe en tiempo real a las notificaciones in-app de la cuenta (`account_notifications`),
 * compatible con el índice `(accountId ASC, createdAt DESC)` de Firestore.
 */
export const subscribeAccountNotifications = (
  accountId: string,
  branchId: string | null | undefined,
  cb: (notifications: AccountNotification[]) => void,
  onError?: (error: Error) => void
): Unsubscribe => {
  if (!accountId) {
    cb([]);
    return () => {};
  }

  const notifQuery = query(
    collection(db, 'account_notifications'),
    where('accountId', '==', accountId),
    orderBy('createdAt', 'desc'),
    limit(40)
  );

  return onSnapshot(
    notifQuery,
    (snapshot) => {
      const items: AccountNotification[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data() || {};
        if (branchId && data.branchId && data.branchId !== branchId) {
          return;
        }
        items.push({
          id: docSnap.id,
          accountId: String(data.accountId || accountId),
          branchId: data.branchId ? String(data.branchId) : undefined,
          title: String(data.title || 'Notificación de Ventify'),
          body: String(data.body || ''),
          type: String(data.type || 'system'),
          url: data.url ? String(data.url) : undefined,
          read: Boolean(data.read),
          readAt: typeof data.readAt === 'number' ? data.readAt : undefined,
          createdAt: toEpochMillis(data.createdAt ?? data.serverTimestamp),
          createdBy: data.createdBy ?? null,
          createdByName: data.createdByName ?? null,
        });
      });
      cb(items);
    },
    (err) => {
      console.warn('[NotificationService] subscribeAccountNotifications error:', err);
      if (onError) {
        onError(err instanceof Error ? err : new Error('No se pudieron cargar las notificaciones.'));
      }
    }
  );
};

/**
 * Marca una notificación de `account_notifications` como leída.
 */
export const markNotificationAsRead = async (notificationId: string): Promise<void> => {
  if (!notificationId) return;
  await updateDoc(doc(db, 'account_notifications', notificationId), {
    read: true,
    readAt: Date.now(),
  });
};

/**
 * Marca múltiples notificaciones no leídas como leídas en un batch.
 */
export const markAllNotificationsAsRead = async (notificationIds: string[]): Promise<void> => {
  const uniqueIds = Array.from(new Set(notificationIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;

  const batch = writeBatch(db);
  const readAt = Date.now();
  for (const id of uniqueIds.slice(0, 400)) {
    batch.update(doc(db, 'account_notifications', id), { read: true, readAt });
  }
  await batch.commit();
};

// ============================================================================
// FEEDBACK HÁPTICO TÁCTIL
// ============================================================================

/**
 * Vibración suave e inmediata al escanear un código de barras o código QR
 */
export const triggerScanHaptic = async (): Promise<void> => {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch (_) {}
};

/**
 * Vibración de éxito para confirmación de venta, cobro o guardado
 */
export const triggerSuccessHaptic = async (): Promise<void> => {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch (_) {}
};

/**
 * Vibración de advertencia o error en validaciones o rechazos
 */
export const triggerErrorHaptic = async (): Promise<void> => {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch (_) {}
};
