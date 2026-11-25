import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Store, ChevronDown, Bell, WifiOff, CloudOff, Check, X, MapPin, LayoutGrid, AlertTriangle, RefreshCw } from 'lucide-react-native';
import { useRouter, type Href } from 'expo-router';
import { useAuthSession, usePlanFeatures } from '@/context/AuthContext';
import {
  useBusinessSettings,
  useCashOpenStatus,
  useOfflineStatus,
} from '@/context/SettingsContext';
import { subscribeAccountNotifications } from '@/services/account-notifications-feed';
import { ModuleLauncherModal } from '@/components/ModuleLauncherModal';
import { ui } from '@/lib/theme';

export interface HeaderProps { title?: string; showBranchSelector?: boolean }

const stopResponder = () => true;

interface NotificationBellButtonProps {
  accountId: string | null;
  branchId: string;
  allBranchesAccess: boolean;
  role: string;
}

const NotificationBellButton = React.memo<NotificationBellButtonProps>(
  ({ accountId, branchId, allBranchesAccess, role }) => {
    const router = useRouter();
    const [unreadCount, setUnreadCount] = useState(0);

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
          const nextUnread = items.reduce((acc, item) => (item.read ? acc : acc + 1), 0);
          setUnreadCount((prev) => (prev === nextUnread ? prev : nextUnread));
        },
        () => {
          // Keep silent in global header bar on transient read errors
        }
      );
      return () => unsubscribe();
    }, [accountId, branchId, allBranchesAccess, role]);

    const handlePress = useCallback(() => {
      router.push('/notifications' as Href);
    }, [router]);

    if (role === 'seller') return null;

    return (
      <TouchableOpacity
        onPress={handlePress}
        style={styles.notifButton}
        accessibilityRole="button"
        accessibilityLabel={
          unreadCount > 0 ? `Notificaciones, ${unreadCount} sin leer` : 'Notificaciones'
        }
      >
        <Bell size={16} color={unreadCount > 0 ? ui.primary : ui.textSecondary} />
        {unreadCount > 0 && <View style={styles.unreadDot} />}
      </TouchableOpacity>
    );
  }
);

interface BranchOptionRowProps {
  id?: string;
  name: string;
  address?: string;
  selected: boolean;
  onSelect: (branchId: string) => void;
}

const BranchOptionRow = React.memo<BranchOptionRowProps>(
  ({ id, name, address, selected, onSelect }) => {
    const handlePress = useCallback(() => {
      if (id) onSelect(id);
    }, [id, onSelect]);

    return (
      <TouchableOpacity
        onPress={handlePress}
        style={[styles.branchCard, selected && styles.selectedBranch]}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${name}${selected ? ', sucursal activa' : ''}`}
      >
        <View style={[styles.storeIcon, selected && styles.storeIconSelected]}>
          <Store size={21} color={selected ? ui.primary : ui.textSecondary} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.branchTitle, selected && styles.branchTitleSelected]}>{name}</Text>
          {address ? (
            <View style={styles.addressRow}>
              <MapPin size={12} color={ui.textMuted} />
              <Text style={styles.address} numberOfLines={2}>
                {address}
              </Text>
            </View>
          ) : null}
        </View>
        {selected && <Check size={20} color={ui.primary} />}
      </TouchableOpacity>
    );
  }
);

export const Header: React.FC<HeaderProps> = React.memo(({ title, showBranchSelector = true }) => {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { accountId, branchId, setActiveBranchId, allBranchesAccess, role } = useAuthSession();
  const { features } = usePlanFeatures();
  const { businessName, activeBranchName, branches } = useBusinessSettings();
  const { isCashOpen } = useCashOpenStatus();
  const { isOnline, offlineQueueCount, quarantinedCount, isSyncingOffline, triggerManualSync } = useOfflineStatus();
  const [branchModalVisible, setBranchModalVisible] = useState(false);
  const [launcherVisible, setLauncherVisible] = useState(false);

  const canSwitchBranch =
    features.multiBranch &&
    Boolean(allBranchesAccess || role === 'owner' || role === 'admin') &&
    branches.length > 1;

  useEffect(() => {
    if (!features.multiBranch && branchModalVisible) {
      setBranchModalVisible(false);
    }
  }, [features.multiBranch, branchModalVisible]);

  const handleOpenBranchModal = useCallback(() => {
    if (canSwitchBranch) setBranchModalVisible(true);
  }, [canSwitchBranch]);

  const handleCloseBranchModal = useCallback(() => {
    setBranchModalVisible(false);
  }, []);

  const handleSelectBranch = useCallback(
    (bId: string) => {
      setActiveBranchId(bId);
      setBranchModalVisible(false);
    },
    [setActiveBranchId]
  );

  const handleOpenLauncher = useCallback(() => {
    setLauncherVisible(true);
  }, []);

  const handleCloseLauncher = useCallback(() => {
    setLauncherVisible(false);
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push('/(tabs)/settings' as Href);
  }, [router]);

  const handleManualSync = useCallback(() => {
    void triggerManualSync(true);
  }, [triggerManualSync]);

  const containerStyle = useMemo(
    () => [styles.container, { paddingTop: insets.top + 6 }],
    [insets.top]
  );

  const sheetStyle = useMemo(
    () => [styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }],
    [insets.bottom]
  );

  return (
    <>
      <View style={containerStyle}>
        <View style={styles.singleBarRow}>
          {showBranchSelector ? (
            <TouchableOpacity
              onPress={handleOpenBranchModal}
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
            <View style={[styles.cashStatus, isCashOpen ? styles.cashStatusOpen : styles.cashStatusClosed]}>
              <View style={[styles.dot, isCashOpen ? styles.dotOpen : styles.dotClosed]} />
              <Text style={[styles.cashText, isCashOpen ? styles.cashTextOpen : styles.cashTextClosed]} numberOfLines={1}>
                {isCashOpen ? 'Caja abierta' : 'Caja cerrada'}
              </Text>
            </View>
            <NotificationBellButton
              accountId={accountId}
              branchId={branchId}
              allBranchesAccess={allBranchesAccess}
              role={role}
            />
            <TouchableOpacity
              onPress={handleOpenLauncher}
              style={styles.moreButton}
              accessibilityRole="button"
              accessibilityLabel="Más módulos"
            >
              <LayoutGrid size={16} color={ui.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {quarantinedCount > 0 ? (
          <TouchableOpacity
            onPress={handleOpenSettings}
            activeOpacity={0.8}
            style={[styles.notice, styles.noticeQuarantined]}
            accessibilityRole="button"
            accessibilityLabel="Revisar ventas en cuarentena en Ajustes"
          >
            <AlertTriangle size={13} color={ui.danger} />
            <Text style={[styles.noticeText, styles.noticeTextQuarantined]}>
              {quarantinedCount} {quarantinedCount === 1 ? 'venta en cuarentena' : 'ventas en cuarentena'} — Toca para revisar
            </Text>
          </TouchableOpacity>
        ) : null}

        {!isOnline ? (
          <View style={styles.notice}>
            <WifiOff size={13} color={ui.warning} />
            <Text style={styles.noticeText}>
              Sin conexión{offlineQueueCount > 0 ? ` · ${offlineQueueCount} pendientes de sincronizar` : ''}
            </Text>
          </View>
        ) : offlineQueueCount > 0 ? (
          <View style={styles.notice}>
            <CloudOff size={13} color={ui.warning} />
            <Text style={styles.noticeText}>
              {offlineQueueCount} {offlineQueueCount === 1 ? 'pendiente de sincronizar' : 'pendientes de sincronizar'}
            </Text>
            <TouchableOpacity
              onPress={handleManualSync}
              disabled={isSyncingOffline}
              style={styles.syncChipBtn}
              accessibilityRole="button"
              accessibilityLabel="Sincronizar operaciones pendientes ahora"
            >
              {isSyncingOffline ? (
                <ActivityIndicator size={11} color={ui.onPrimary} />
              ) : (
                <RefreshCw size={11} color={ui.onPrimary} />
              )}
              <Text style={styles.syncChipText}>
                {isSyncingOffline ? 'Sincronizando...' : 'Sincronizar'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {features.multiBranch && branchModalVisible && (
        <Modal visible={branchModalVisible} transparent animationType="fade" onRequestClose={handleCloseBranchModal}>
          <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={handleCloseBranchModal}>
            <View style={sheetStyle} onStartShouldSetResponder={stopResponder}>
              <View style={styles.sheetHeader}>
                <View style={styles.copy}><Text style={styles.sheetTitle}>Tus sucursales</Text><Text style={styles.sheetSubtitle}>Elige dónde vas a trabajar.</Text></View>
                <TouchableOpacity style={styles.sheetCloseButton} onPress={handleCloseBranchModal} accessibilityRole="button" accessibilityLabel="Cerrar selección de sucursal"><X size={20} color={ui.textSecondary} /></TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false}>
                {branches.map((b) => (
                  <BranchOptionRow
                    key={b.id || b.name}
                    id={b.id}
                    name={b.name}
                    address={b.address}
                    selected={b.id === branchId}
                    onSelect={handleSelectBranch}
                  />
                ))}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {launcherVisible && (
        <ModuleLauncherModal
          visible={launcherVisible}
          onClose={handleCloseLauncher}
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
  cashStatusOpen: { backgroundColor: ui.successSoft },
  cashStatusClosed: { backgroundColor: ui.surfaceMuted },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOpen: { backgroundColor: ui.success },
  dotClosed: { backgroundColor: ui.textMuted },
  cashText: { fontSize: 11, fontWeight: '600' },
  cashTextOpen: { color: ui.success },
  cashTextClosed: { color: ui.textSecondary },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ui.warningSoft, padding: 6, borderRadius: 7, marginTop: 4 },
  noticeQuarantined: { backgroundColor: ui.dangerSoft },
  noticeText: { flex: 1, color: ui.warning, fontSize: 11 },
  noticeTextQuarantined: { color: ui.danger, fontWeight: '700' },
  syncChipBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: ui.warning, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  syncChipText: { color: ui.onPrimary, fontSize: 10.5, fontWeight: '700' },
  overlay: { flex: 1, backgroundColor: 'rgba(17,28,49,0.40)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: ui.surface, padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%', width: '100%', maxWidth: 640, alignSelf: 'center' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  copy: { flex: 1, minWidth: 0 },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: ui.text, letterSpacing: -0.4 },
  sheetSubtitle: { fontSize: 13, color: ui.textSecondary, marginTop: 3 },
  branchCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, marginBottom: 6 },
  selectedBranch: { backgroundColor: ui.primarySoft },
  storeIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: ui.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  storeIconSelected: { backgroundColor: ui.primarySoft },
  branchTitle: { color: ui.text, fontSize: 15, fontWeight: '600' },
  branchTitleSelected: { color: ui.primary },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  address: { flex: 1, color: ui.textSecondary, fontSize: 12 },
});
