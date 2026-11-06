import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';

let initialized = false;

export const initNotifications = async (): Promise<boolean> => {
  if (initialized) return true;

  try {
    if (Capacitor.isNativePlatform()) {
      // 1. Solicitar permisos de notificación en Android
      const permStatus = await LocalNotifications.checkPermissions();
      if (permStatus.display !== 'granted') {
        const req = await LocalNotifications.requestPermissions();
        if (req.display !== 'granted') {
          console.warn('[NotificationService] Permiso de notificaciones no otorgado');
          return false;
        }
      }

      // 2. Registrar Canales de Notificación para Android 8+
      await LocalNotifications.createChannel({
        id: 'critical_stock',
        name: 'Stock Crítico',
        description: 'Alertas de productos con inventario bajo o por agotar',
        importance: 4,
        visibility: 1,
        vibration: true,
      });

      await LocalNotifications.createChannel({
        id: 'sunat_alerts',
        name: 'Alertas SUNAT',
        description: 'Comprobantes observados o con incidencias tributarias',
        importance: 4,
        visibility: 1,
        vibration: true,
      });

      await LocalNotifications.createChannel({
        id: 'cash_shifts',
        name: 'Cierres de Turno y Caja',
        description: 'Notificaciones de arqueos y cierre de caja registradora',
        importance: 3,
        visibility: 1,
        vibration: true,
      });

      initialized = true;
      return true;
    } else if ('Notification' in window) {
      // Web fallback
      if (Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      initialized = true;
      return Notification.permission === 'granted';
    }
  } catch (err) {
    console.warn('[NotificationService] Init warning:', err);
  }
  return false;
};

/**
 * 1. Alerta de Stock Crítico
 */
export const notifyLowStock = async (
  productName: string,
  currentStock: number,
  minStock: number
) => {
  try {
    await initNotifications();
    const id = Math.floor(Date.now() % 100000);
    const title = `⚠️ Stock Crítico: ${productName}`;
    const body = `Quedan ${currentStock} unidades (mínimo: ${minStock}). Es momento de reponer existencias.`;

    if (Capacitor.isNativePlatform()) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title,
            body,
            channelId: 'critical_stock',
            smallIcon: 'ic_launcher',
            schedule: { at: new Date(Date.now() + 500) },
          },
        ],
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch (err) {
    console.warn('[NotificationService] notifyLowStock error:', err);
  }
};

/**
 * 2. Alerta de Comprobante SUNAT Observado o Rechazado
 */
export const notifySunatAlert = async (
  docType: string,
  docNumber: string,
  reason: string
) => {
  try {
    await initNotifications();
    const id = Math.floor(Date.now() % 100000);
    const title = `⚠️ Incidencia SUNAT: ${docType} #${docNumber}`;
    const body = reason || 'El comprobante fue observado o rechazado por SUNAT. Revisa el estado en la web.';

    if (Capacitor.isNativePlatform()) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title,
            body,
            channelId: 'sunat_alerts',
            smallIcon: 'ic_launcher',
            schedule: { at: new Date(Date.now() + 500) },
          },
        ],
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch (err) {
    console.warn('[NotificationService] notifySunatAlert error:', err);
  }
};

/**
 * 3. Alerta de Cierre de Turno / Arqueo para Roles Owner / Admin
 */
export const notifyShiftClosed = async (
  cashierName: string,
  branchName: string,
  finalAmount: number,
  difference?: number
) => {
  try {
    await initNotifications();
    const id = Math.floor(Date.now() % 100000);
    const title = `🔔 Cierre de Turno: ${branchName}`;
    const diffText =
      difference !== undefined && !isNaN(difference)
        ? ` (Diferencia: S/ ${difference >= 0 ? '+' : ''}${difference.toFixed(2)})`
        : '';
    const body = `${cashierName} cerró caja con S/ ${finalAmount.toFixed(2)}${diffText}.`;

    if (Capacitor.isNativePlatform()) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id,
            title,
            body,
            channelId: 'cash_shifts',
            smallIcon: 'ic_launcher',
            schedule: { at: new Date(Date.now() + 500) },
          },
        ],
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch (err) {
    console.warn('[NotificationService] notifyShiftClosed error:', err);
  }
};
