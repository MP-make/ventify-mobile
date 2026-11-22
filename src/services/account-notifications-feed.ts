/**
 * Ventify Mobile - Account Notifications Feed Service
 *
 * Suscripción en tiempo real multiplexada a `account_notifications` en Firestore.
 * Separado de `expo-notifications` para evitar cargar módulos nativos de push
 * cuando solo se consume la bandeja in-app (por ejemplo, en el Header).
 */

import { AppState } from 'react-native';
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

const toEpochMillis = (value: any): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.seconds === 'number') return value.seconds * 1000;
  return Date.now();
};

const filterNotificationsForBranch = (
  items: AccountNotification[],
  branchId?: string | null
): AccountNotification[] => {
  if (!branchId) return items;
  return items.filter((item) => !item.branchId || item.branchId === branchId);
};

interface NotificationSubscriber {
  branchId?: string | null;
  cb: (notifications: AccountNotification[]) => void;
  onError?: (error: Error) => void;
}

interface SharedNotificationChannel {
  key: string;
  accountId: string;
  subscribers: Set<NotificationSubscriber>;
  lastItems: AccountNotification[] | null;
  unsubscribeFirestore: Unsubscribe | null;
  appStateSub: { remove: () => void } | null;
  backgroundPauseTimer: ReturnType<typeof setTimeout> | null;
}

const sharedNotificationChannels = new Map<string, SharedNotificationChannel>();
const NOTIFICATION_BACKGROUND_PAUSE_MS = 15_000;

function attachNotificationFirestoreListener(channel: SharedNotificationChannel): void {
  if (channel.unsubscribeFirestore || channel.subscribers.size === 0) return;

  const notifQuery = query(
    collection(db, 'account_notifications'),
    where('accountId', '==', channel.accountId),
    orderBy('createdAt', 'desc'),
    limit(40)
  );

  channel.unsubscribeFirestore = onSnapshot(
    notifQuery,
    (snapshot) => {
      const items: AccountNotification[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data() || {};
        items.push({
          id: docSnap.id,
          accountId: String(data.accountId || channel.accountId),
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
      channel.lastItems = items;
      for (const sub of Array.from(channel.subscribers)) {
        sub.cb(filterNotificationsForBranch(items, sub.branchId));
      }
    },
    (err) => {
      console.warn('[NotificationService] subscribeAccountNotifications error:', err);
      const normalizedError =
        err instanceof Error ? err : new Error('No se pudieron cargar las notificaciones.');
      for (const sub of Array.from(channel.subscribers)) {
        sub.onError?.(normalizedError);
      }
    }
  );
}

/**
 * Suscribe en tiempo real a las notificaciones in-app de la cuenta (`account_notifications`),
 * multiplexando un único listener por `accountId` entre Header, Settings y Notifications
 * y aplicando el filtro `branchId` por suscriptor en cada emisión.
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

  const key = accountId;
  let channel = sharedNotificationChannels.get(key);
  if (!channel) {
    channel = {
      key,
      accountId,
      subscribers: new Set(),
      lastItems: null,
      unsubscribeFirestore: null,
      appStateSub: null,
      backgroundPauseTimer: null,
    };
    sharedNotificationChannels.set(key, channel);

    if (typeof AppState?.addEventListener === 'function') {
      const targetChannel = channel;
      targetChannel.appStateSub = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          if (targetChannel.backgroundPauseTimer) {
            clearTimeout(targetChannel.backgroundPauseTimer);
            targetChannel.backgroundPauseTimer = null;
          }
          attachNotificationFirestoreListener(targetChannel);
        } else if (nextState === 'background' || nextState === 'inactive') {
          if (!targetChannel.backgroundPauseTimer && targetChannel.unsubscribeFirestore) {
            targetChannel.backgroundPauseTimer = setTimeout(() => {
              targetChannel.backgroundPauseTimer = null;
              if (AppState.currentState !== 'active' && targetChannel.unsubscribeFirestore) {
                targetChannel.unsubscribeFirestore();
                targetChannel.unsubscribeFirestore = null;
              }
            }, NOTIFICATION_BACKGROUND_PAUSE_MS);
          }
        }
      });
    }
  }

  const subscriber: NotificationSubscriber = { branchId, cb, onError };
  channel.subscribers.add(subscriber);
  if (channel.lastItems) {
    cb(filterNotificationsForBranch(channel.lastItems, branchId));
  }

  const isForeground =
    typeof AppState?.currentState !== 'string' || AppState.currentState === 'active';
  if (isForeground) {
    attachNotificationFirestoreListener(channel);
  }

  return () => {
    const activeChannel = sharedNotificationChannels.get(key);
    if (!activeChannel) return;
    activeChannel.subscribers.delete(subscriber);
    if (activeChannel.subscribers.size === 0) {
      if (activeChannel.backgroundPauseTimer) {
        clearTimeout(activeChannel.backgroundPauseTimer);
        activeChannel.backgroundPauseTimer = null;
      }
      activeChannel.appStateSub?.remove?.();
      activeChannel.appStateSub = null;
      activeChannel.unsubscribeFirestore?.();
      activeChannel.unsubscribeFirestore = null;
      sharedNotificationChannels.delete(key);
    }
  };
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
