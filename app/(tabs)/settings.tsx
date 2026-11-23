import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import {
  Bell,
  CreditCard,
  Gift,
  LogOut,
  Printer,
  Shield,
  Store,
} from 'lucide-react-native';

import {
  useAuthSession,
  usePinLock,
  usePlanAccess,
} from '@/context/AuthContext';
import {
  useBusinessSettings,
  useCashSession,
  useOfflineStatus,
} from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { ui } from '@/lib/theme';

import { settingsStyles as styles } from '@/components/settings/settingsStyles';
import { BusinessSettingsTab } from '@/components/settings/BusinessSettingsTab';
import { PaymentsSettingsTab } from '@/components/settings/PaymentsSettingsTab';
import { PrinterOfflineSettingsTab } from '@/components/settings/PrinterOfflineSettingsTab';
import { SecuritySettingsTab } from '@/components/settings/SecuritySettingsTab';
import { AlertsSettingsTab } from '@/components/settings/AlertsSettingsTab';
import { GiftsSettingsTab } from '@/components/settings/GiftsSettingsTab';

type SettingsTabKey =
  | 'negocio'
  | 'pagos'
  | 'impresora'
  | 'seguridad'
  | 'alertas'
  | 'regalos';

const SETTINGS_TABS: Array<{ key: SettingsTabKey; label: string }> = [
  { key: 'negocio', label: 'Negocio' },
  { key: 'pagos', label: 'Pagos' },
  { key: 'impresora', label: 'Impresora' },
  { key: 'seguridad', label: 'Seguridad' },
  { key: 'alertas', label: 'Alertas' },
  { key: 'regalos', label: 'Regalos' },
];

const PLAN_STATUS_TTL_MS = 60_000;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const {
    user,
    userProfile,
    accountId,
    branchId,
    role,
    logout,
    setActiveBranchId,
    allBranchesAccess,
  } = useAuthSession();
  const {
    limits,
    subscription,
    accessChecking,
    accessError,
    refreshAccess,
  } = usePlanAccess();
  const { lockTerminal, updatePinCode } = usePinLock();

  const {
    businessSettings,
    businessData,
    posSettings,
    discountSettings,
    branches,
    activeBranchName,
    activeBranch,
    taxProfile,
    invoicingEnabled,
    emitterInfo,
    allPaymentMethods,
    updateBusinessData,
    updatePosSettings,
  } = useBusinessSettings();
  const { activeCashSession } = useCashSession();
  const { isOnline, offlineQueueCount, quarantinedCount, refreshOfflineCount } = useOfflineStatus();

  const { canManageSettings, hasAllBranchesAccess } = usePermissions();

  const [activeTab, setActiveTab] = useState<SettingsTabKey>('negocio');
  const [refreshingPlan, setRefreshingPlan] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);

  const lastPlanFetchRef = useRef<{ accountId: string | null; at: number }>({
    accountId: null,
    at: 0,
  });

  const loadPlanStatus = useCallback(
    async (force = false) => {
      if (!accountId || !isOnline || role === 'seller') return;
      const now = Date.now();
      if (
        !force &&
        lastPlanFetchRef.current.accountId === accountId &&
        now - lastPlanFetchRef.current.at < PLAN_STATUS_TTL_MS
      ) {
        return;
      }
      lastPlanFetchRef.current = { accountId, at: now };
      setRefreshingPlan(true);
      try {
        await refreshAccess();
      } finally {
        setRefreshingPlan(false);
      }
    },
    [accountId, isOnline, role, refreshAccess]
  );

  useEffect(() => {
    if (!isFocused) return;
    void loadPlanStatus(false);
  }, [isFocused, loadPlanStatus]);

  const handleManualRefreshPlan = useCallback(() => {
    void loadPlanStatus(true);
  }, [loadPlanStatus]);

  const handleUnreadCountChange = useCallback((count: number) => {
    setUnreadNotifCount((prev) => (prev === count ? prev : count));
  }, []);

  const handleLogoutPress = useCallback(() => {
    const hasPendingOffline = offlineQueueCount > 0 || quarantinedCount > 0;
    const message = hasPendingOffline
      ? `Tienes ${offlineQueueCount} operación(es) offline pendiente(s)${
          quarantinedCount > 0 ? ` y ${quarantinedCount} en cuarentena` : ''
        }. Quedarán guardadas localmente para este usuario hasta que vuelvas a iniciar sesión con internet. ¿Deseas cerrar sesión de todas formas?`
      : 'Se cerrará la sesión de este terminal móvil. ¿Deseas continuar?';

    Alert.alert('¿Cerrar Sesión?', message, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cerrar Sesión',
        style: 'destructive',
        onPress: async () => {
          await logout();
        },
      },
    ]);
  }, [logout, offlineQueueCount, quarantinedCount]);

  const scrollContentStyle = useMemo(
    () => ({ paddingBottom: Math.max(insets.bottom, 24) + 12 }),
    [insets.bottom]
  );

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <View style={styles.compactSettingsHeader}>
        <Text style={styles.compactSettingsTitle}>Ajustes</Text>
        <TouchableOpacity
          style={styles.headerLogoutBtn}
          onPress={handleLogoutPress}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Cerrar sesión"
        >
          <LogOut size={14} color={ui.danger} />
          <Text style={styles.headerLogoutText}>Cerrar sesión</Text>
        </TouchableOpacity>
      </View>

      {/* Selector de secciones sin scroll: activo con título, inactivos solo ícono */}
      <View style={styles.tabBarWrapper}>
        <View style={styles.tabBarRow}>
          {SETTINGS_TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const iconColor = isActive ? ui.onPrimary : ui.textSecondary;
            const renderTabIcon = () => {
              switch (tab.key) {
                case 'negocio':
                  return <Store size={16} color={iconColor} />;
                case 'pagos':
                  return <CreditCard size={16} color={iconColor} />;
                case 'impresora':
                  return <Printer size={16} color={iconColor} />;
                case 'seguridad':
                  return <Shield size={16} color={iconColor} />;
                case 'alertas':
                  return <Bell size={16} color={iconColor} />;
                case 'regalos':
                  return <Gift size={16} color={iconColor} />;
              }
            };
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tabPill, isActive ? styles.tabPillActive : styles.tabPillIconOnly]}
                onPress={() => setActiveTab(tab.key)}
                accessibilityRole="tab"
                accessibilityLabel={tab.label}
                accessibilityState={{ selected: isActive }}
              >
                {renderTabIcon()}
                {isActive ? (
                  <Text style={[styles.tabPillText, styles.tabPillTextActive]} numberOfLines={1}>
                    {tab.label}
                  </Text>
                ) : null}
                {tab.key === 'alertas' && unreadNotifCount > 0 ? (
                  <View style={[styles.tabBadgeDot, isActive && styles.tabBadgeDotActive]} />
                ) : null}
                {tab.key === 'impresora' && (quarantinedCount > 0 || offlineQueueCount > 0) ? (
                  <View
                    style={[
                      styles.tabBadgeDot,
                      isActive && styles.tabBadgeDotActive,
                      { backgroundColor: quarantinedCount > 0 ? ui.danger : ui.warning },
                    ]}
                  />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.contentContainer}
          contentContainerStyle={scrollContentStyle}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          {activeTab === 'negocio' && (
            <BusinessSettingsTab
              canManageSettings={canManageSettings}
              hasAllBranchesAccess={hasAllBranchesAccess}
              branchId={branchId}
              branches={branches}
              activeBranchName={activeBranchName}
              activeBranch={activeBranch}
              businessSettings={businessSettings}
              businessData={businessData}
              posSettings={posSettings}
              taxProfile={taxProfile}
              invoicingEnabled={invoicingEnabled}
              emitterInfo={emitterInfo}
              planLoading={accessChecking || refreshingPlan}
              planError={accessError}
              subscription={subscription}
              limits={limits}
              onRefreshPlan={handleManualRefreshPlan}
              onSelectBranch={setActiveBranchId}
              updateBusinessData={updateBusinessData}
              updatePosSettings={updatePosSettings}
            />
          )}

          {activeTab === 'pagos' && (
            <PaymentsSettingsTab
              accountId={accountId}
              canManageSettings={canManageSettings}
              posSettings={posSettings}
              allPaymentMethods={allPaymentMethods}
              updatePosSettings={updatePosSettings}
            />
          )}

          {activeTab === 'impresora' && (
            <PrinterOfflineSettingsTab
              accountId={accountId}
              userId={user?.uid || null}
              activeCashSessionId={activeCashSession?.sessionId || activeCashSession?.id || null}
              isFocused={isFocused}
              isActiveTab={activeTab === 'impresora'}
              isOnline={isOnline}
              offlineQueueCount={offlineQueueCount}
              refreshOfflineCount={refreshOfflineCount}
              businessSettings={businessSettings}
              activeBranch={activeBranch}
              posSettings={posSettings}
              taxProfile={taxProfile}
            />
          )}

          {activeTab === 'seguridad' && (
            <SecuritySettingsTab
              accountId={accountId}
              canManageSettings={canManageSettings}
              role={role}
              userEmail={user?.email}
              displayName={userProfile?.displayName}
              lockTerminal={lockTerminal}
              updatePinCode={updatePinCode}
              onLogoutPress={handleLogoutPress}
            />
          )}

          {activeTab === 'alertas' && (
            <AlertsSettingsTab
              accountId={accountId}
              branchId={branchId}
              role={role}
              allBranchesAccess={allBranchesAccess}
              hasAllBranchesAccess={hasAllBranchesAccess}
              canManageSettings={canManageSettings}
              isFocused={isFocused}
              onUnreadCountChange={handleUnreadCountChange}
            />
          )}

          {activeTab === 'regalos' && (
            <GiftsSettingsTab
              accountId={accountId}
              canManageSettings={canManageSettings}
              discountSettings={discountSettings}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
