import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Store, ChevronDown, Lock, WifiOff, CloudOff, Check, X, MapPin } from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { ui } from '@/lib/theme';
import { BrandLogo } from '@/components/ui';

export interface HeaderProps { title?: string; showBranchSelector?: boolean }

export const Header: React.FC<HeaderProps> = ({ title, showBranchSelector = true }) => {
  const insets = useSafeAreaInsets();
  const { lockTerminal, branchId, setActiveBranchId, allBranchesAccess, role } = useAuth();
  const { businessName, activeBranchName, branches, isCashOpen, isOnline, offlineQueueCount } = useSettings();
  const [branchModalVisible, setBranchModalVisible] = useState(false);
  const canSwitchBranch = allBranchesAccess || role === 'owner' || role === 'admin' || branches.length > 1;
  const handleSelectBranch = (bId: string) => { setActiveBranchId(bId); setBranchModalVisible(false); };

  return (
    <>
      <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
        <View style={styles.brandRow}>
          <BrandLogo size={34} />
          <TouchableOpacity onPress={lockTerminal} style={styles.lockButton} accessibilityRole="button" accessibilityLabel="Bloquear terminal con PIN" accessibilityHint="Solicita el PIN para volver a usar el terminal">
            <Lock size={19} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>
        <View style={styles.contextRow}>
          {showBranchSelector ? (
            <TouchableOpacity onPress={() => canSwitchBranch && setBranchModalVisible(true)} disabled={!canSwitchBranch} style={styles.branchButton} accessibilityRole="button" accessibilityLabel={`Sucursal activa: ${activeBranchName}${canSwitchBranch ? '. Cambiar sucursal' : ''}`} accessibilityState={{ disabled: !canSwitchBranch }}>
              <Store size={15} color={ui.textSecondary} />
              <Text style={styles.branchName} numberOfLines={1}>{activeBranchName || businessName}</Text>
              {canSwitchBranch && branches.length > 1 && <ChevronDown size={14} color={ui.textSecondary} />}
            </TouchableOpacity>
          ) : <Text style={styles.branchName} numberOfLines={1}>{title || businessName}</Text>}
          <View style={[styles.cashStatus, { backgroundColor: isCashOpen ? ui.successSoft : ui.surfaceMuted }]}>
            <View style={[styles.dot, { backgroundColor: isCashOpen ? ui.success : ui.textMuted }]} />
            <Text style={[styles.cashText, { color: isCashOpen ? ui.success : ui.textSecondary }]}>{isCashOpen ? 'Caja abierta' : 'Caja cerrada'}</Text>
          </View>
        </View>
        {!isOnline ? (
          <View style={styles.notice}><WifiOff size={14} color={ui.warning} /><Text style={styles.noticeText}>Sin conexión{offlineQueueCount > 0 ? ` · ${offlineQueueCount} pendientes de sincronizar` : ''}</Text></View>
        ) : offlineQueueCount > 0 ? (
          <View style={styles.notice}><CloudOff size={14} color={ui.warning} /><Text style={styles.noticeText}>{offlineQueueCount} pendientes de sincronizar</Text></View>
        ) : null}
      </View>
      <Modal visible={branchModalVisible} transparent animationType="fade" onRequestClose={() => setBranchModalVisible(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setBranchModalVisible(false)}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHeader}>
              <View style={styles.copy}><Text style={styles.sheetTitle}>Tus sucursales</Text><Text style={styles.sheetSubtitle}>Elige dónde vas a trabajar.</Text></View>
              <TouchableOpacity style={styles.lockButton} onPress={() => setBranchModalVisible(false)} accessibilityRole="button" accessibilityLabel="Cerrar selección de sucursal"><X size={21} color={ui.textSecondary} /></TouchableOpacity>
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
    </>
  );
};
const styles = StyleSheet.create({
  container: { backgroundColor: ui.surface, paddingHorizontal: 20, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: ui.border },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lockButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: ui.surfaceMuted },
  contextRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  branchButton: { flex: 1, minWidth: 0, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 7 },
  branchName: { flexShrink: 1, color: ui.textSecondary, fontSize: 13, fontWeight: '500' },
  cashStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cashText: { fontSize: 11, fontWeight: '600' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ui.warningSoft, padding: 9, borderRadius: 8, marginBottom: 8 },
  noticeText: { flex: 1, color: ui.warning, fontSize: 12 },
  overlay: { flex: 1, backgroundColor: 'rgba(17,28,49,0.40)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: ui.surface, padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%', width: '100%', maxWidth: 640, alignSelf: 'center' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  copy: { flex: 1, minWidth: 0 },
  sheetTitle: { fontSize: 23, fontWeight: '700', color: ui.text, letterSpacing: -0.5 },
  sheetSubtitle: { fontSize: 14, color: ui.textSecondary, marginTop: 5 },
  branchCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, paddingHorizontal: 12, borderRadius: 12, marginBottom: 6 },
  selectedBranch: { backgroundColor: ui.primarySoft },
  storeIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: ui.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  branchTitle: { color: ui.text, fontSize: 16, fontWeight: '600' },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  address: { flex: 1, color: ui.textSecondary, fontSize: 12 },
});
