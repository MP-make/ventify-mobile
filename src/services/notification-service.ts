/**
 * Ventify Mobile - Notification & Haptic Feedback Service
 * 
 * Gestión de alertas locales y canales nativos para Android e iOS mediante
 * `expo-notifications` y feedback háptico táctil con `expo-haptics`.
 * Canales: `critical_stock`, `sunat_alerts` y `cash_shifts`.
 */

import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

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

// ============================================================================
// INICIALIZACIÓN DE CANALES NATIVOS (ANDROID 8+)
// ============================================================================

/**
 * Solicita permisos de notificación y registra los canales oficiales de Ventify
 */
export const initNotifications = async (): Promise<boolean> => {
  if (channelsInitialized) return true;

  try {
    // 1. Solicitar permisos de notificación
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

    // 2. Crear canales nativos en Android
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
    }

    channelsInitialized = true;
    return true;
  } catch (err) {
    console.warn('[NotificationService] Error inicializando notificaciones:', err);
    return false;
  }
};

// ============================================================================
// DISPARADORES DE ALERTAS LOCALES
// ============================================================================

/**
 * 1. Alerta de Stock Crítico: notifica cuando un producto cae por debajo del umbral mínimo
 */
export const notifyLowStock = async (
  productName: string,
  currentStock: number,
  minStock: number
): Promise<void> => {
  try {
    await initNotifications();
    await triggerErrorHaptic();

    const title = `⚠️ Stock Crítico: ${productName}`;
    const body = `Quedan ${currentStock} unidades (mínimo de seguridad: ${minStock}). Es momento de reponer mercadería.`;

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: 'critical_stock', productName, currentStock, minStock },
      },
      trigger: { channelId: 'critical_stock' },
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
    await initNotifications();
    await triggerErrorHaptic();

    const title = `🚨 Alerta SUNAT: ${documentType.toUpperCase()} ${documentNumber}`;
    const body = message || 'El comprobante electrónico requiere atención o reintento de firma.';

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: 'sunat_alert', documentType, documentNumber },
      },
      trigger: { channelId: 'sunat_alerts' },
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
    await initNotifications();
    await triggerSuccessHaptic();

    const diffText =
      difference === 0
        ? 'Cuadre Exacto'
        : difference > 0
        ? `Sobrante: +S/ ${difference.toFixed(2)}`
        : `Faltante: -S/ ${Math.abs(difference).toFixed(2)}`;

    const title = `🔒 Cierre de Turno Realizado (${branchName})`;
    const body = `Efectivo contado: S/ ${countedAmount.toFixed(2)} (${diffText}). Reporte Z generado con éxito.`;

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: 'cash_shift', branchName, countedAmount, difference },
      },
      trigger: { channelId: 'cash_shifts' },
    });
  } catch (err) {
    console.warn('[NotificationService] notifyShiftClosed error:', err);
  }
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
