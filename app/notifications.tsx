import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  ArrowLeft,
  Bell,
  CheckCheck,
  CreditCard,
  FileText,
  Package,
  ReceiptText,
  Sparkles,
  Wallet,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import {
  type AccountNotification,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  subscribeAccountNotifications,
} from '@/services/notification-service';
import { formatDatePE, ui } from '@/lib/theme';

function mapNotificationRoute(url?: string, type?: string): string | null {
  const raw = (url || '').toLowerCase();
  if (raw.includes('facturacion') || raw.includes('invoicing')) return '/facturacion';
  if (raw.includes('dashboard')) return '/dashboard';
  if (raw.includes('reports')) return '/reports';
  if (raw.includes('branches')) return '/branches';
  if (raw.includes('inventory') || raw.includes('products') || type === 'stock') {
    return '/(tabs)/catalog';
  }
  if (
    raw.includes('cash') ||
    raw.includes('fiado') ||
    raw.includes('reservation') ||
    type === 'cash_register' ||
    type === 'fiado' ||
    type === 'reservation'
  ) {
    return '/(tabs)/operations';
  }
  if (raw.includes('sales') || raw.includes('history')) return '/(tabs)/history';
  return null;
}

function NotificationTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'stock':
      return <Package size={18} color={ui.warning} />;
    case 'cash_register':
      return <Wallet size={18} color={ui.success} />;
    case 'fiado':
    case 'reservation':
      return <CreditCard size={18} color={ui.danger} />;
    case 'quote':
      return <FileText size={18} color={ui.primary} />;
    case 'ai_insight':
      return <Sparkles size={18} color={ui.accent} />;
    case 'sunat':
    case 'invoicing':
      return <ReceiptText size={18} color={ui.primary} />;
    default:
      return <Bell size={18} color={ui.textSecondary} />;
  }
}

export default function NotificationsScreen() {
  const router = useRouter();
  const { accountId, branchId } = useAuth();
  const { isOwner, isAdmin, isSuperAdmin, hasAllBranchesAccess } = usePermissions();

  // firestore.rules allows account_notifications updates only for account admins (owner/admin/superAdmin).
  const canMarkRead = isOwner || isAdmin || isSuperAdmin;

  const [notifications, setNotifications] = useState<AccountNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'unread'>('all');
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const scopeBranch = hasAllBranchesAccess ? undefined : branchId;
    const unsubscribe = subscribeAccountNotifications(
      accountId,
      scopeBranch,
      (items) => {
        setNotifications(items);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, [accountId, branchId, hasAllBranchesAccess]);

  const unreadIds = useMemo(
    () => notifications.filter((n) => !n.read).map((n) => n.id),
    [notifications]
  );

  const visibleItems = useMemo(() => {
    if (filterMode === 'unread') {
      return notifications.filter((n) => !n.read);
    }
    return notifications;
  }, [notifications, filterMode]);

  const handleTapNotification = async (item: AccountNotification) => {
    if (canMarkRead && !item.read) {
      try {
        await markNotificationAsRead(item.id);
        Haptics.selectionAsync().catch(() => {});
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudo marcar como leída.');
      }
    }
    const targetRoute = mapNotificationRoute(item.url, item.type);
    if (targetRoute) {
      router.push(targetRoute as Href);
    }
  };

  const handleMarkAllRead = async () => {
    if (!canMarkRead || unreadIds.length === 0) return;
    setMarkingAll(true);
    try {
      await markAllNotificationsAsRead(unreadIds);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudieron marcar todas como leídas.');
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Volver"
        >
          <ArrowLeft size={20} color={ui.text} />
        </TouchableOpacity>
        <View style={styles.titleCopy}>
          <Text style={styles.topTitle}>Notificaciones</Text>
          <Text style={styles.topSub}>
            {unreadIds.length > 0
              ? `${unreadIds.length} sin leer`
              : 'Al día'}
          </Text>
        </View>
        {canMarkRead && unreadIds.length > 0 ? (
          <TouchableOpacity
            onPress={() => void handleMarkAllRead()}
            disabled={markingAll}
            style={[styles.markAllBtn, markingAll && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Marcar todas como leídas"
          >
            {markingAll ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <CheckCheck size={15} color={ui.primary} />
            )}
            <Text style={styles.markAllText}>Marcar todas</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.iconSpacer} />
        )}
      </View>

      <FlatList
        data={visibleItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.headerBlock}>
            <View style={styles.pillsRow}>
              <TouchableOpacity
                onPress={() => setFilterMode('all')}
                style={[styles.pill, filterMode === 'all' && styles.pillActive]}
              >
                <Text style={[styles.pillText, filterMode === 'all' && styles.pillTextActive]}>
                  Todas ({notifications.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setFilterMode('unread')}
                style={[styles.pill, filterMode === 'unread' && styles.pillActive]}
              >
                <Text style={[styles.pillText, filterMode === 'unread' && styles.pillTextActive]}>
                  No leídas ({unreadIds.length})
                </Text>
              </TouchableOpacity>
            </View>

            {!canMarkRead && notifications.length > 0 && (
              <Text style={styles.readOnlyNote}>
                Solo propietarios o administradores pueden marcar notificaciones como leídas.
              </Text>
            )}

            {loading && (
              <View style={styles.centerBox}>
                <ActivityIndicator size="large" color={ui.primary} />
                <Text style={styles.mutedText}>Cargando alertas en tiempo real...</Text>
              </View>
            )}

            {!!error && (
              <View style={styles.errorCard}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          !loading && !error ? (
            <View style={styles.centerBox}>
              <Bell size={32} color={ui.textMuted} />
              <Text style={styles.emptyTitle}>
                {filterMode === 'unread' ? 'Sin notificaciones pendientes' : 'Buzón vacío'}
              </Text>
              <Text style={styles.mutedText}>
                Aquí verás alertas de stock crítico, caja, fiados y SUNAT.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const unread = !item.read;
          return (
            <TouchableOpacity
              onPress={() => void handleTapNotification(item)}
              style={[styles.card, unread && styles.cardUnread]}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel={`${unread ? 'No leída: ' : ''}${item.title}`}
            >
              <View style={styles.cardIcon}>
                <NotificationTypeIcon type={item.type} />
              </View>
              <View style={styles.cardBody}>
                <View style={styles.cardTitleRow}>
                  <Text
                    style={[styles.cardTitle, unread && styles.cardTitleUnread]}
                    numberOfLines={2}
                  >
                    {item.title}
                  </Text>
                  {unread && <View style={styles.unreadDot} />}
                </View>
                {item.body ? (
                  <Text style={styles.cardMessage}>{item.body}</Text>
                ) : null}
                <Text style={styles.cardMeta}>
                  {formatDatePE(item.createdAt)}
                  {item.createdByName ? ` · ${item.createdByName}` : ''}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconSpacer: {
    width: 38,
  },
  titleCopy: {
    flex: 1,
    minWidth: 0,
  },
  topTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
  },
  topSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 1,
  },
  markAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 10,
    height: 34,
    borderRadius: 9,
  },
  markAllText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  listContent: {
    padding: 14,
    gap: 8,
    paddingBottom: 32,
  },
  headerBlock: {
    gap: 10,
    marginBottom: 4,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  pillActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  pillTextActive: {
    color: ui.primary,
  },
  readOnlyNote: {
    fontSize: 11,
    color: ui.textMuted,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 36,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  mutedText: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
  },
  errorCard: {
    backgroundColor: ui.dangerSoft,
    padding: 12,
    borderRadius: 12,
  },
  errorText: {
    fontSize: 13,
    color: ui.danger,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 14,
    padding: 13,
  },
  cardUnread: {
    backgroundColor: '#F7FAFF',
    borderColor: ui.primarySoft,
  },
  cardIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  cardTitleUnread: {
    fontWeight: '800',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: ui.primary,
  },
  cardMessage: {
    fontSize: 13,
    color: ui.textSecondary,
    lineHeight: 18,
  },
  cardMeta: {
    fontSize: 11,
    color: ui.textMuted,
  },
});
