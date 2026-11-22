import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { Bell, CheckCircle2, ChevronRight, Save, Send } from 'lucide-react-native';

import { SectionHeading } from '@/components/ui';
import { db } from '@/lib/firebase';
import { formatDatePE, ui } from '@/lib/theme';
import {
  markAllNotificationsAsRead,
  markNotificationAsRead,
  subscribeAccountNotifications,
  type AccountNotification,
} from '@/services/account-notifications-feed';
import {
  getNotificationPermissionStatus,
  initNotifications,
  registerForPushNotificationsAsync,
  scheduleLocalNotification,
} from '@/services/notification-service';

import { settingsStyles as styles } from './settingsStyles';

interface NotificationPrefsState {
  pushNotifications: boolean;
  emailNotifications: boolean;
  stockAlerts: boolean;
  quoteAlerts: boolean;
  reservationAlerts: boolean;
  cashRegisterAlerts: boolean;
  aiInsightsAlerts: boolean;
  alertThreshold: string;
}

const DEFAULT_NOTIF_PREFS: NotificationPrefsState = {
  pushNotifications: true,
  emailNotifications: true,
  stockAlerts: true,
  quoteAlerts: true,
  reservationAlerts: true,
  cashRegisterAlerts: true,
  aiInsightsAlerts: true,
  alertThreshold: '5',
};

const ALERT_PREFERENCE_ROWS: Array<
  [keyof Omit<NotificationPrefsState, 'alertThreshold'>, string, string]
> = [
  ['pushNotifications', 'Notificaciones Push / Locales', 'Alertas inmediatas en el dispositivo'],
  ['emailNotifications', 'Notificaciones por Correo', 'Resúmenes y alertas críticas por email'],
  ['stockAlerts', 'Stock Mínimo y Crítico', 'Avisar cuando un producto cae bajo el umbral'],
  ['cashRegisterAlerts', 'Apertura y Cierre de Caja', 'Notificar movimientos de turno y arqueos'],
  ['reservationAlerts', 'Reservas y Fiados', 'Recordatorios de vencimientos y mora'],
  ['quoteAlerts', 'Cotizaciones / Leads Web', 'Nuevas solicitudes desde la tienda online'],
  ['aiInsightsAlerts', 'Insights de Venty IA', 'Detección de anomalías y sugerencias'],
];

const PREVIEW_NOTIFICATIONS_CAP = 10;

export interface AlertsSettingsTabProps {
  accountId: string | null;
  branchId: string;
  role: string;
  allBranchesAccess: boolean;
  hasAllBranchesAccess: boolean;
  canManageSettings: boolean;
  isFocused: boolean;
  onUnreadCountChange?: (count: number) => void;
}

export const AlertsSettingsTab = React.memo<AlertsSettingsTabProps>(
  ({
    accountId,
    branchId,
    role,
    allBranchesAccess,
    hasAllBranchesAccess,
    canManageSettings,
    isFocused,
    onUnreadCountChange,
  }) => {
    const router = useRouter();
    const [notifPermStatus, setNotifPermStatus] = useState<string>('undetermined');
    const [expoPushStatus, setExpoPushStatus] = useState<string | null>(null);
    const [notifPrefs, setNotifPrefs] = useState<NotificationPrefsState>(DEFAULT_NOTIF_PREFS);
    const [isSavingNotifPrefs, setIsSavingNotifPrefs] = useState(false);
    const [accountNotifications, setAccountNotifications] = useState<AccountNotification[]>([]);
    const [notifInboxError, setNotifInboxError] = useState<string | null>(null);

    useEffect(() => {
      let active = true;
      getNotificationPermissionStatus()
        .then((st) => {
          if (active) setNotifPermStatus(String(st));
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []);

    useEffect(() => {
      if (!accountId) return;
      let active = true;
      getDoc(doc(db, 'settings', `${accountId}_notifications`))
        .then((notifSnap) => {
          if (!active || !notifSnap?.exists()) return;
          const nData = notifSnap.data() || {};
          setNotifPrefs({
            pushNotifications: nData.pushNotifications !== false,
            emailNotifications: nData.emailNotifications !== false,
            stockAlerts: nData.stockAlerts !== false,
            quoteAlerts: nData.quoteAlerts !== false,
            reservationAlerts: nData.reservationAlerts !== false,
            cashRegisterAlerts: nData.cashRegisterAlerts !== false,
            aiInsightsAlerts: nData.aiInsightsAlerts !== false,
            alertThreshold: String(Number(nData.alertThreshold ?? nData.stockThreshold ?? 5)),
          });
        })
        .catch((err) => {
          console.warn('[Settings] Error loading notifications settings doc:', err);
        });
      return () => {
        active = false;
      };
    }, [accountId]);

    useEffect(() => {
      if (!accountId || !isFocused) return;
      setNotifInboxError(null);
      const notifBranchScope =
        hasAllBranchesAccess || allBranchesAccess || role === 'owner' || role === 'admin'
          ? undefined
          : branchId;
      const unsub = subscribeAccountNotifications(
        accountId,
        notifBranchScope,
        (items) => {
          setAccountNotifications(items);
        },
        (err) => {
          setNotifInboxError(err.message);
        }
      );
      return () => unsub();
    }, [accountId, branchId, role, allBranchesAccess, hasAllBranchesAccess, isFocused]);

    const unreadNotifCount = useMemo(
      () => accountNotifications.reduce((acc, n) => (n.read ? acc : acc + 1), 0),
      [accountNotifications]
    );

    useEffect(() => {
      onUnreadCountChange?.(unreadNotifCount);
    }, [unreadNotifCount, onUnreadCountChange]);

    const previewNotifications = useMemo(
      () => accountNotifications.slice(0, PREVIEW_NOTIFICATIONS_CAP),
      [accountNotifications]
    );

    const handleEnableNotifications = async () => {
      const granted = await initNotifications();
      const status = await getNotificationPermissionStatus();
      setNotifPermStatus(String(status));
      if (granted) {
        const token = await registerForPushNotificationsAsync();
        setExpoPushStatus(
          token
            ? 'Token Expo Push activo'
            : 'Notificaciones locales activas (sin EAS projectId para push remoto)'
        );
        Alert.alert('Notificaciones Activas', 'El terminal está listo para mostrar alertas.');
      } else {
        Alert.alert(
          'Permiso Denegado',
          'Habilita las notificaciones para Ventify POS en los Ajustes de tu dispositivo.'
        );
      }
    };

    const handleSendTestNotification = async () => {
      const id = await scheduleLocalNotification({
        title: '🔔 Ventify POS — Prueba de Alerta',
        body: 'Las notificaciones locales y canales de alerta están funcionando correctamente.',
        channelId: 'general_alerts',
        data: { type: 'system' },
      });
      if (id) {
        Alert.alert('Prueba Enviada', 'Revisa la barra de notificaciones de tu dispositivo.');
      } else {
        Alert.alert(
          'Sin Permiso',
          'Activa los permisos de notificación primero para recibir la alerta de prueba.'
        );
      }
    };

    const handleSaveNotifPrefs = async () => {
      if (!canManageSettings || !accountId) return;
      const threshold = Math.max(1, parseInt(notifPrefs.alertThreshold, 10) || 5);
      setIsSavingNotifPrefs(true);
      try {
        await setDoc(
          doc(db, 'settings', `${accountId}_notifications`),
          {
            accountId,
            pushNotifications: notifPrefs.pushNotifications,
            emailNotifications: notifPrefs.emailNotifications,
            stockAlerts: notifPrefs.stockAlerts,
            quoteAlerts: notifPrefs.quoteAlerts,
            reservationAlerts: notifPrefs.reservationAlerts,
            cashRegisterAlerts: notifPrefs.cashRegisterAlerts,
            aiInsightsAlerts: notifPrefs.aiInsightsAlerts,
            alertThreshold: threshold,
            stockThreshold: threshold,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        Alert.alert(
          'Preferencias Guardadas',
          'Las preferencias de alertas han sido actualizadas.'
        );
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudieron guardar las preferencias de alertas.');
      } finally {
        setIsSavingNotifPrefs(false);
      }
    };

    const handleMarkNotificationRead = async (item: AccountNotification) => {
      if (item.read || !canManageSettings) return;
      try {
        await markNotificationAsRead(item.id);
      } catch (err: any) {
        console.warn('[Settings] Error marking notification read:', err);
      }
    };

    const handleMarkAllRead = async () => {
      if (!canManageSettings) return;
      const unreadIds = accountNotifications.filter((n) => !n.read).map((n) => n.id);
      if (unreadIds.length === 0) return;
      try {
        await markAllNotificationsAsRead(unreadIds);
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudieron marcar las notificaciones.');
      }
    };

    const handleOpenAllNotifications = useCallback(() => {
      router.push('/notifications' as any);
    }, [router]);

    return (
      <>
        <SectionHeading
          title="Estado del Dispositivo"
          subtitle="Permisos y prueba de notificaciones"
        />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
              <Bell size={22} color={ui.primary} />
            </View>
            <View style={styles.cardHeaderText}>
              <View style={styles.inlineRow}>
                <Text style={styles.cardTitle}>Alertas Locales y Push</Text>
                <View
                  style={[
                    styles.pillBadge,
                    {
                      backgroundColor:
                        notifPermStatus === 'granted' ? ui.successSoft : ui.warningSoft,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.pillBadgeText,
                      { color: notifPermStatus === 'granted' ? ui.success : ui.warning },
                    ]}
                  >
                    {notifPermStatus === 'granted' ? 'Permitidas' : 'Pendiente / Bloqueado'}
                  </Text>
                </View>
              </View>
              <Text style={styles.cardSubtitle}>
                {expoPushStatus || 'Canales Android: Stock crítico, SUNAT, Caja y General'}
              </Text>
            </View>
          </View>

          <View style={styles.actionButtonGroup}>
            <TouchableOpacity
              style={[styles.secondaryOutlineBtn, styles.flex1]}
              onPress={handleEnableNotifications}
            >
              <CheckCircle2 size={16} color={ui.primary} />
              <Text style={styles.secondaryOutlineBtnText}>Activar Permisos</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryOutlineBtn, styles.flex1]}
              onPress={handleSendTestNotification}
            >
              <Send size={16} color={ui.primary} />
              <Text style={styles.secondaryOutlineBtnText}>Probar Alerta</Text>
            </TouchableOpacity>
          </View>
        </View>

        <SectionHeading
          title="Preferencias de Alertas"
          subtitle="Canales de la cuenta en Firestore"
        />
        <View style={styles.card}>
          {ALERT_PREFERENCE_ROWS.map(([key, title, sub]) => (
            <View key={key} style={styles.switchRow}>
              <View style={styles.flex1}>
                <Text style={styles.switchTitle}>{title}</Text>
                <Text style={styles.switchSubtitle}>{sub}</Text>
              </View>
              <Switch
                value={notifPrefs[key]}
                onValueChange={(val) => setNotifPrefs((prev) => ({ ...prev, [key]: val }))}
                disabled={!canManageSettings}
                trackColor={{ false: ui.border, true: ui.primary }}
              />
            </View>
          ))}

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Umbral de Alerta de Stock (Unidades)</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              keyboardType="numeric"
              value={notifPrefs.alertThreshold}
              onChangeText={(val) =>
                setNotifPrefs((prev) => ({ ...prev, alertThreshold: val.replace(/\D/g, '') }))
              }
              editable={canManageSettings}
            />
          </View>

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.saveButton, isSavingNotifPrefs && styles.buttonDisabled]}
              onPress={handleSaveNotifPrefs}
              disabled={isSavingNotifPrefs}
            >
              {isSavingNotifPrefs ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Save size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>Guardar Preferencias</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>

        <SectionHeading
          title={`Bandeja de Alertas (${unreadNotifCount} sin leer)`}
          subtitle="Historial en tiempo real sincronizado con la web"
          action={
            canManageSettings && unreadNotifCount > 0 ? (
              <TouchableOpacity onPress={handleMarkAllRead} style={styles.markAllBtn}>
                <Text style={styles.markAllBtnText}>Marcar todas</Text>
              </TouchableOpacity>
            ) : undefined
          }
        />
        <View style={styles.card}>
          {notifInboxError ? (
            <Text style={styles.emptySub}>{notifInboxError}</Text>
          ) : accountNotifications.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Bell size={32} color={ui.textMuted} />
              <Text style={styles.emptyText}>Sin notificaciones recientes</Text>
              <Text style={styles.emptySub}>
                Aquí aparecerán alertas de stock crítico, caja, reservas y fiados.
              </Text>
            </View>
          ) : (
            <>
              {previewNotifications.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.notifItem, !item.read && styles.notifItemUnread]}
                  onPress={() => void handleMarkNotificationRead(item)}
                  activeOpacity={0.75}
                >
                  <View style={styles.inlineBetween}>
                    <Text style={styles.notifTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    {!item.read ? <View style={styles.unreadDot} /> : null}
                  </View>
                  {item.body ? (
                    <Text style={styles.notifBody} numberOfLines={3}>
                      {item.body}
                    </Text>
                  ) : null}
                  <Text style={styles.notifMeta}>
                    {formatDatePE(item.createdAt)} · {item.type.toUpperCase()}
                    {item.read ? ' · Leída' : canManageSettings ? ' · Toca para marcar leída' : ''}
                  </Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity
                style={styles.secondaryOutlineBtn}
                onPress={handleOpenAllNotifications}
                accessibilityRole="button"
                accessibilityLabel="Ver todas las notificaciones"
              >
                <Text style={styles.secondaryOutlineBtnText}>
                  {accountNotifications.length > PREVIEW_NOTIFICATIONS_CAP
                    ? `Ver todas (${accountNotifications.length})`
                    : 'Ver todas'}
                </Text>
                <ChevronRight size={16} color={ui.primary} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </>
    );
  }
);
