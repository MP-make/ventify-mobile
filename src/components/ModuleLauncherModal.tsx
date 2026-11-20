import React, { useMemo } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  BarChart3,
  Bell,
  Building2,
  FileSpreadsheet,
  Lock,
  type LucideIcon,
  ReceiptText,
  Settings,
  TrendingUp,
  UserCheck,
  X,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { ui } from '@/lib/theme';

export interface ModuleLauncherModalProps {
  visible: boolean;
  onClose: () => void;
  unreadCount?: number;
}

interface LauncherModuleItem {
  id: string;
  title: string;
  subtitle: string;
  route: string;
  tintBg: string;
  tintColor: string;
  badgeCount?: number;
  icon: LucideIcon;
}

export const ModuleLauncherModal: React.FC<ModuleLauncherModalProps> = React.memo(
  ({ visible, onClose, unreadCount = 0 }) => {
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { accountId, lockTerminal, userProfile } = useAuth();
    const { businessName, activeBranchName } = useSettings();
    const {
      role,
      isOwner,
      isAdmin,
      isManager,
      isSeller,
      canAccessDashboard,
      canViewReports,
      canCreateCreditNotes,
      hasPermission,
    } = usePermissions();

    const modules = useMemo<LauncherModuleItem[]>(() => {
      if (!accountId) return [];
      const list: LauncherModuleItem[] = [];

      if (canAccessDashboard) {
        list.push({
          id: 'dashboard',
          title: 'Dashboard',
          subtitle: 'KPIs y alertas',
          route: '/dashboard',
          tintBg: ui.primarySoft,
          tintColor: ui.primary,
          icon: BarChart3,
        });
      }

      if (canViewReports || hasPermission('access_reports')) {
        list.push({
          id: 'reports',
          title: 'Reportes',
          subtitle: 'Ganancias y exportar',
          route: '/reports',
          tintBg: ui.accentSoft,
          tintColor: ui.accent,
          icon: FileSpreadsheet,
        });
      }

      if (
        hasPermission('access_sales') &&
        (isOwner || isAdmin || isManager || canViewReports || canCreateCreditNotes)
      ) {
        list.push({
          id: 'facturacion',
          title: 'Facturación SUNAT',
          subtitle: 'XML, CDR y notas',
          route: '/facturacion',
          tintBg: ui.successSoft,
          tintColor: ui.success,
          icon: ReceiptText,
        });
      }

      if (hasPermission('access_branches') || hasPermission('manage_branches')) {
        list.push({
          id: 'branches',
          title: 'Sucursales',
          subtitle: 'Sedes y estado',
          route: '/branches',
          tintBg: ui.warningSoft,
          tintColor: ui.warning,
          icon: Building2,
        });
      }

      if (isSeller && hasPermission('view_own_sales')) {
        list.push({
          id: 'seller',
          title: 'Mi Portal Vendedor',
          subtitle: 'Mis ventas y metas',
          route: '/seller',
          tintBg: ui.primarySoft,
          tintColor: ui.primary,
          icon: UserCheck,
        });
      }

      return list;
    }, [
      accountId,
      canAccessDashboard,
      canViewReports,
      canCreateCreditNotes,
      hasPermission,
      isOwner,
      isAdmin,
      isManager,
      isSeller,
    ]);

    const handleNavigate = (route: string) => {
      Haptics.selectionAsync().catch(() => {});
      onClose();
      router.push(route as Href);
    };

    const handleLock = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      onClose();
      lockTerminal();
    };

    const roleLabel =
      role === 'owner'
        ? 'Propietario'
        : role === 'admin'
          ? 'Administrador'
          : role === 'manager'
            ? 'Gerente'
            : role === 'seller'
              ? 'Vendedor'
              : 'Cajero';

    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
      >
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={onClose}
        >
          <View
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.headerCopy}>
                <Text style={styles.sheetTitle}>Módulos de Ventify</Text>
                <Text style={styles.sheetSubtitle} numberOfLines={1}>
                  {userProfile?.displayName || businessName} · {roleLabel}
                  {activeBranchName ? ` · ${activeBranchName}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={styles.closeBtn}
                accessibilityRole="button"
                accessibilityLabel="Cerrar menú de módulos"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {modules.length === 0 ? (
                <View style={styles.emptyBox}>
                  <TrendingUp size={24} color={ui.textMuted} />
                  <Text style={styles.emptyText}>
                    No hay módulos adicionales habilitados para tu rol actual.
                  </Text>
                </View>
              ) : (
                <View style={styles.grid}>
                  {modules.map((item) => {
                    const Icon = item.icon;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        onPress={() => handleNavigate(item.route)}
                        style={styles.tile}
                        activeOpacity={0.78}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.title}: ${item.subtitle}`}
                      >
                        <View style={styles.tileTopRow}>
                          <View style={[styles.tileIconBox, { backgroundColor: item.tintBg }]}>
                            <Icon size={20} color={item.tintColor} />
                          </View>
                          {item.badgeCount && item.badgeCount > 0 ? (
                            <View style={styles.badgePill}>
                              <Text style={styles.badgePillText}>
                                {item.badgeCount > 99 ? '99+' : item.badgeCount}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.tileTitle} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Text style={styles.tileSubtitle} numberOfLines={1}>
                          {item.subtitle}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {!isSeller && (
                <View style={styles.quickRow}>
                  <TouchableOpacity
                    onPress={() => handleNavigate('/(tabs)/settings')}
                    style={styles.quickBtn}
                    activeOpacity={0.78}
                    accessibilityRole="button"
                    accessibilityLabel="Ir a Ajustes de Terminal"
                  >
                    <Settings size={17} color={ui.text} />
                    <Text style={styles.quickBtnText}>Ajustes</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={handleLock}
                    style={[styles.quickBtn, styles.quickBtnLock]}
                    activeOpacity={0.78}
                    accessibilityRole="button"
                    accessibilityLabel="Bloquear terminal con PIN"
                  >
                    <Lock size={17} color={ui.primary} />
                    <Text style={[styles.quickBtnText, { color: ui.primary }]}>
                      Bloquear PIN
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  }
);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,28,49,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 10,
    maxHeight: '84%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: ui.border,
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  sheetTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: ui.text,
    letterSpacing: -0.4,
  },
  sheetSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  tile: {
    width: '48.2%',
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 14,
    padding: 13,
    gap: 6,
  },
  tileTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  tileIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgePill: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#EF4444',
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgePillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  tileTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  tileSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  quickRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  quickBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  quickBtnLock: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primarySoft,
  },
  quickBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
});
