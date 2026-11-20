import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Store, ChevronDown, Bell, WifiOff, CloudOff, Check, X, MapPin, LayoutGrid } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { subscribeAccountNotifications } from '@/services/notification-service';
import { ModuleLauncherModal } from '@/components/ModuleLauncherModal';
import { ui } from '@/lib/theme';

export interface HeaderProps { title?: string; showBranchSelector?: boolean }

export const Header: React.FC<HeaderProps> = React.memo(({ title, showBranchSelector = true }) => {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { accountId, branchId, setActiveBranchId, allBranchesAccess, role } = useAuth();
  const { businessName, activeBranchName, branches, isCashOpen, isOnline, offlineQueueCount } = useSettings();
  const [branchModalVisible, setBranchModalVisible] = useState(false);
  const [launcherVisible, setLauncherVisible] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const canSwitchBranch = Boolean(allBranchesAccess || role === 'owner' || role === 'admin') && branches.length > 1;
  const handleSelectBranch = (bId: string) => { setActiveBranchId(bId); setBranchModalVisible(false); };

  useEffect(() => {
    if (!accountId || role === 'seller') {
      setUnreadCount(0);
      return;
    }
    const notifBranchScope =
      allBranchesAccess || role === 'owner' || role === 'admin' ? undefined : branchId;

    const unsubscribe = subscribeAccountNotifications(
      accountId,
      notifBranchScope,
      (items) => {
        setUnreadCount(items.reduce((acc, item) => (item.read ? acc : acc + 1), 0));
      },
      () => {
        // Keep silent in global header bar on transient read errors
      }
    );
    return () => unsubscribe();
  }, [accountId, branchId, allBranchesAccess, role]);

  return (
    <>
      <View style={[styles.container, { paddingTop: insets.top + 6 }]}>
        <View style={styles.singleBarRow}>
          {showBranchSelector ? (
            <TouchableOpacity
              onPress={() => canSwitchBranch && setBranchModalVisible(true)}
              disabled={!canSwitchBranch}
              style={styles.branchButton}
              accessibilityRole="button"
              accessibilityLabel={`Sucursal activa: ${activeBranchName}${canSwitchBranch ? '. Cambiar sucursal' : ''}`}
              accessibilityState={{ disabled: !canSwitchBranch }}
            >
              <View style={styles.storeIconMini}>
                <Store size={14} color={ui.primary} />
              </View>
              <Text style={styles.branchName} numberOfLines={1}>{activeBranchName || businessName}</Text>
              {canSwitchBranch && <ChevronDown size={14} color={ui.textSecondary} />}
            </TouchableOpacity>
          ) : (
            <View style={styles.titleWrapper}>
              <Text style={styles.branchName} numberOfLines={1}>{title || businessName}</Text>
            </View>
          )}

          <View style={styles.rightActions}>
            <View style={[styles.cashStatus, { backgroundColor: isCashOpen ? ui.successSoft : ui.surfaceMuted }]}>
              <View style={[styles.dot, { backgroundColor: isCashOpen ? ui.success : ui.textMuted }]} />
              <Text style={[styles.cashText, { color: isCashOpen ? ui.success : ui.textSecondary }]} numberOfLines={1}>
                {isCashOpen ? 'Caja abierta' : 'Caja cerrada'}
              </Text>
            </View>
            {role !== 'seller' && (
              <TouchableOpacity
                onPress={() => router.push('/notifications')}
                style={styles.notifButton}
                accessibilityRole="button"
                accessibilityLabel={unreadCount > 0 ? `Notificaciones, ${unreadCount} sin leer` : 'Notificaciones'}
              >
                <Bell size={16} color={unreadCount > 0 ? ui.primary : ui.textSecondary} />
                {unreadCount > 0 && <View style={styles.unreadDot} />}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => setLauncherVisible(true)}
              style={styles.moreButton}
              accessibilityRole="button"
              accessibilityLabel="Más módulos"
            >
              <LayoutGrid size={16} color={ui.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {!isOnline ? (
          <View style={styles.notice}><WifiOff size={13} color={ui.warning} /><Text style={styles.noticeText}>Sin conexión{offlineQueueCount > 0 ? ` · ${offlineQueueCount} pendientes de sincronizar` : ''}</Text></View>
        ) : offlineQueueCount > 0 ? (
          <View style={styles.notice}><CloudOff size={13} color={ui.warning} /><Text style={styles.noticeText}>{offlineQueueCount} pendientes de sincronizar</Text></View>
        ) : null}
      </View>

      {branchModalVisible && (
        <Modal visible={branchModalVisible} transparent animationType="fade" onRequestClose={() => setBranchModalVisible(false)}>
          <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setBranchModalVisible(false)}>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]} onStartShouldSetResponder={() => true}>
              <View style={styles.sheetHeader}>
                <View style={styles.copy}><Text style={styles.sheetTitle}>Tus sucursales</Text><Text style={styles.sheetSubtitle}>Elige dónde vas a trabajar.</Text></View>
                <TouchableOpacity style={styles.sheetCloseButton} onPress={() => setBranchModalVisible(false)} accessibilityRole="button" accessibilityLabel="Cerrar selección de sucursal"><X size={20} color={ui.textSecondary} /></TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false}>
                {branches.map(b => {
                  const selected = b.id === branchId;
                  return (
                    <TouchableOpacity key={b.id || b.name} onPress={() => b.id && handleSelectBranch(b.id)} style={[styles.branchCard, selected && styles.selectedBranch]} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${b.name}${selected ? ', sucursal activa' : ''}`}>
                      <View style={[styles.storeIcon, selected && { backgroundColor: ui.primarySoft }]}><Store size={21} color={selected ? ui.primary : ui.textSecondary} /></View>
                      <View style={styles.copy}><Text style={[styles.branchTitle, selected && { color: ui.primary }]}>{b.name}</Text>{b.address ? <View style={styles.addressRow}><MapPin size={12} color={ui.textMuted} /><Text style={styles.address} numberOfLines={2}>{b.address}</Text></View> : null}</View>
                      {selected && <Check size={20} color={ui.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {launcherVisible && (
        <ModuleLauncherModal
          visible={launcherVisible}
          onClose={() => setLauncherVisible(false)}
          unreadCount={unreadCount}
        />
      )}
    </>
  );
});
const styles = StyleSheet.create({
  container: { backgroundColor: ui.surface, paddingHorizontal: 14, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: ui.border },
  singleBarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, minHeight: 38 },
  branchButton: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  titleWrapper: { flex: 1, minWidth: 0 },
  storeIconMini: { width: 26, height: 26, borderRadius: 7, backgroundColor: ui.primarySoft, alignItems: 'center', justifyContent: 'center' },
  branchName: { flexShrink: 1, color: ui.text, fontSize: 13, fontWeight: '700' },
  rightActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  notifButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: ui.surfaceMuted, position: 'relative' },
  moreButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: ui.primarySoft },
  unreadDot: { position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, backgroundColor: '#EF4444', borderWidth: 1.5, borderColor: ui.surface },
  sheetCloseButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: ui.surfaceMuted },
  cashStatus: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 5, borderRadius: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cashText: { fontSize: 11, fontWeight: '600' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ui.warningSoft, padding: 6, borderRadius: 7, marginTop: 4 },
  noticeText: { flex: 1, color: ui.warning, fontSize: 11 },
  overlay: { flex: 1, backgroundColor: 'rgba(17,28,49,0.40)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: ui.surface, padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%', width: '100%', maxWidth: 640, alignSelf: 'center' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  copy: { flex: 1, minWidth: 0 },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: ui.text, letterSpacing: -0.4 },
  sheetSubtitle: { fontSize: 13, color: ui.textSecondary, marginTop: 3 },
  branchCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, marginBottom: 6 },
  selectedBranch: { backgroundColor: ui.primarySoft },
  storeIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: ui.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  branchTitle: { color: ui.text, fontSize: 15, fontWeight: '600' },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  address: { flex: 1, color: ui.textSecondary, fontSize: 12 },
});
