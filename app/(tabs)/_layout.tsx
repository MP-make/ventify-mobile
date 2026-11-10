import React from 'react';
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
import { useCart } from '@/context/CartContext';
import { ui } from '@/lib/theme';

export default function TabLayout() {
  const { totalItemsCount } = useCart();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const expanded = width >= 900;

  return (
    <Tabs
      screenOptions={{
        header: () => <Header />,
        tabBarPosition: expanded ? 'left' : 'bottom',
        tabBarLabelPosition: expanded ? 'beside-icon' : 'below-icon',
        tabBarStyle: [styles.tabBar, expanded ? { width: 176, minWidth: 176, maxWidth: 176, paddingTop: insets.top + 24 } : { height: 80 + insets.bottom, paddingBottom: Math.max(insets.bottom, 8) }],
        tabBarActiveTintColor: ui.primary,
        tabBarInactiveTintColor: ui.textSecondary,
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: styles.tabItem,
        tabBarActiveBackgroundColor: 'transparent',
        tabBarHideOnKeyboard: true,
      }}
    >
      {/* 1. POS (Punto de Venta) */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Vender',
          tabBarIcon: ({ color, size, focused }) => (
            <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}><ShoppingCart size={size || 22} color={color} /></View>
          ),
          tabBarBadge: totalItemsCount > 0 ? Math.round(totalItemsCount) : undefined,
          tabBarBadgeStyle: styles.cartBadge,
        }}
      />

      {/* 2. Catálogo / Inventario / Kardex */}
      <Tabs.Screen
        name="catalog"
        options={{
          title: 'Inventario',
          tabBarIcon: ({ color, size, focused }) => (
            <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}><Package size={size || 22} color={color} /></View>
          ),
        }}
      />

      {/* 3. Operaciones (Caja Z, CRM Fiados, Reservas) */}
      <Tabs.Screen
        name="operations"
        options={{
          title: 'Caja',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => (
            <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}><Wallet size={size || 22} color={color} /></View>
          ),
        }}
      />

      {/* 4. Historial, Facturación SUNAT y Venty IA */}
      <Tabs.Screen
        name="history"
        options={{
          title: 'Ventas',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => (
            <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}><History size={size || 22} color={color} /></View>
          ),
        }}
      />

      {/* 5. Ajustes de Terminal y Hardware */}
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Ajustes',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => (
            <View style={[styles.iconIndicator, focused && styles.iconIndicatorActive]}><Settings size={size || 22} color={color} /></View>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
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
