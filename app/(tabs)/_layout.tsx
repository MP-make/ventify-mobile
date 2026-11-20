import React, { useMemo } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import {
  ShoppingCart,
  Package,
  Wallet,
  History,
  Settings,
} from 'lucide-react-native';
import { Header } from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { ui } from '@/lib/theme';

const TabHeader = React.memo(() => <Header />);
const renderHeader = () => <TabHeader />;

type TabIconProps = { color: string; size: number; focused: boolean };

const renderPosIcon = ({ color, size, focused }: TabIconProps) => (
  <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}>
    <ShoppingCart size={size || 22} color={color} />
  </View>
);

const renderCatalogIcon = ({ color, size, focused }: TabIconProps) => (
  <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}>
    <Package size={size || 22} color={color} />
  </View>
);

const renderOperationsIcon = ({ color, size, focused }: TabIconProps) => (
  <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}>
    <Wallet size={size || 22} color={color} />
  </View>
);

const renderHistoryIcon = ({ color, size, focused }: TabIconProps) => (
  <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}>
    <History size={size || 22} color={color} />
  </View>
);

const renderSettingsIcon = ({ color, size, focused }: TabIconProps) => (
  <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}>
    <Settings size={size || 22} color={color} />
  </View>
);

const CATALOG_OPTIONS = {
  title: 'Inventario',
  tabBarIcon: renderCatalogIcon,
};

const OPERATIONS_OPTIONS = {
  title: 'Caja',
  headerShown: false,
  tabBarIcon: renderOperationsIcon,
};

const HISTORY_OPTIONS = {
  title: 'Ventas',
  headerShown: false,
  tabBarIcon: renderHistoryIcon,
};

const SETTINGS_OPTIONS = {
  title: 'Ajustes',
  headerShown: false,
  tabBarIcon: renderSettingsIcon,
};

function AuthenticatedTabLayout() {
  const { totalItemsCount } = useCart();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const expanded = width >= 900;

  const tabBarStyle = useMemo(
    () => [
      styles.tabBar,
      expanded
        ? { width: 176, minWidth: 176, maxWidth: 176, paddingTop: insets.top + 24 }
        : { height: 80 + insets.bottom, paddingBottom: Math.max(insets.bottom, 8) },
    ],
    [expanded, insets.top, insets.bottom]
  );

  const screenOptions = useMemo(
    () => ({
      header: renderHeader,
      lazy: true,
      tabBarPosition: (expanded ? 'left' : 'bottom') as 'left' | 'bottom',
      tabBarLabelPosition: (expanded ? 'beside-icon' : 'below-icon') as 'beside-icon' | 'below-icon',
      tabBarStyle,
      tabBarActiveTintColor: ui.primary,
      tabBarInactiveTintColor: ui.textSecondary,
      tabBarLabelStyle: styles.tabLabel,
      tabBarItemStyle: styles.tabItem,
      tabBarActiveBackgroundColor: 'transparent',
      tabBarHideOnKeyboard: true,
    }),
    [expanded, tabBarStyle]
  );

  const badgeCount = totalItemsCount > 0 ? Math.round(totalItemsCount) : undefined;
  const posOptions = useMemo(
    () => ({
      title: 'Vender',
      tabBarIcon: renderPosIcon,
      tabBarBadge: badgeCount,
      tabBarBadgeStyle: styles.cartBadge,
    }),
    [badgeCount]
  );

  return (
    <Tabs screenOptions={screenOptions}>
      {/* 1. POS (Punto de Venta) */}
      <Tabs.Screen name="index" options={posOptions} />

      {/* 2. Catálogo / Inventario / Kardex */}
      <Tabs.Screen name="catalog" options={CATALOG_OPTIONS} />

      {/* 3. Operaciones (Caja Z, CRM Fiados, Reservas) */}
      <Tabs.Screen name="operations" options={OPERATIONS_OPTIONS} />

      {/* 4. Historial, Facturación SUNAT y Venty IA */}
      <Tabs.Screen name="history" options={HISTORY_OPTIONS} />

      {/* 5. Ajustes de Terminal y Hardware */}
      <Tabs.Screen name="settings" options={SETTINGS_OPTIONS} />
    </Tabs>
  );
}

export default function TabLayout() {
  const { user, initialized, role } = useAuth();
  if (!initialized || !user || role === 'seller') {
    return <View style={styles.bootPlaceholder} />;
  }
  return <AuthenticatedTabLayout />;
}

const styles = StyleSheet.create({
  bootPlaceholder: {
    flex: 1,
    backgroundColor: ui.background,
  },
  tabBar: {
    backgroundColor: ui.surface,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 8,
    paddingHorizontal: 8,
    elevation: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0,
    shadowRadius: 6,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 3,
    lineHeight: 14,
  },
  tabItem: {
    minHeight: 60,
    borderRadius: 12,
    marginHorizontal: 2,
    paddingVertical: 0,
    justifyContent: 'center',
  },
  iconIndicator: {
    width: 46, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
  },
  iconIndicatorActive: { backgroundColor: ui.primarySoft },
  cartBadge: {
    backgroundColor: ui.primary,
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    lineHeight: Platform.OS === 'ios' ? 18 : 16,
    textAlign: 'center',
    alignSelf: 'center',
  },
});
