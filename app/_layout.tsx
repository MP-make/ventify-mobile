import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enableFreeze } from 'react-native-screens';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { SettingsProvider } from '@/context/SettingsContext';
import { ProductsProvider } from '@/context/ProductsContext';
import { CartProvider } from '@/context/CartContext';
import { PinLockModal } from '@/components/PinLockModal';
import { BrandLogo } from '@/components/ui';
import { ui } from '@/lib/theme';

enableFreeze(true);
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Componente interno que orquesta la navegación y redirección reactiva
 * según el estado de la sesión de Firebase Auth
 */
function RootNavigationLayout() {
  const { user, initialized, loading, role } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!initialized || loading) return;

    const current = String(segments[0] || '');
    if (!user && current !== '(auth)') router.replace('/(auth)/login');
    else if (user && role === 'seller' && current !== 'seller') router.replace('/seller');
    else if (user && role !== 'seller' && (current === '(auth)' || current === 'seller')) router.replace('/(tabs)');
  }, [user, initialized, loading, role, segments, router]);

  // Pantalla de carga inicial mientras se resuelve la sesión y persistencia
  if (!initialized || (loading && user !== null) || (user && role === 'seller' && String(segments[0]) !== 'seller') || (!user && String(segments[0]) !== '(auth)')) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar style="dark" backgroundColor={ui.surface} />
        <View style={styles.brandBadge}>
          <BrandLogo size={72} />
          <Text style={styles.brandSubtitle}>Preparando tu espacio de trabajo</Text>
        </View>
        <ActivityIndicator size="large" color={ui.primary} style={styles.spinner} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="dark" backgroundColor={ui.surface} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: ui.background },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="seller" options={{ headerShown: false }} />
      </Stack>

      {/* Modal Global de Bloqueo por PIN de Terminal */}
      <PinLockModal />
    </View>
  );
}

const accessMessages: Record<string, string> = {
  inactive_user: 'Tu usuario fue desactivado. Contacta al administrador.',
  paused_subscription: 'La suscripción está en pausa y el acceso al negocio está suspendido.',
  expired_subscription: 'La suscripción del negocio ha vencido.',
  cancelled_subscription: 'La suscripción del negocio está cancelada.',
};

function SessionWorkspace() {
  const { user, accountId, role, initialized, loading, accessChecking, accessError, accessBlocked, refreshAccess, logout } = useAuth();

  useEffect(() => {
    if (initialized && !loading && (!user || !accessChecking)) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [initialized, loading, user, accessChecking]);

  const waiting = !initialized || loading || (Boolean(user) && accessChecking);
  const problem = accessBlocked ? accessMessages[accessBlocked] : accessError || (user && !accountId ? 'Tu usuario no tiene una cuenta de negocio disponible.' : null);
  if (user && (waiting || problem)) {
    return <View style={styles.loadingContainer}>
      <BrandLogo size={72} />
      {waiting ? <ActivityIndicator color={ui.primary} style={styles.spinner} /> : <>
        <Text style={[styles.brandSubtitle, { textAlign: 'center', marginVertical: 24 }]} accessibilityRole="alert">{problem}</Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => void refreshAccess()} style={{ padding: 16 }}><Text style={{ color: ui.primary }}>Volver a verificar</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={() => void logout()} style={{ padding: 16 }}><Text style={{ color: ui.text }}>Cerrar sesión</Text></TouchableOpacity>
      </>}
    </View>;
  }
  // No operational listeners are mounted for a blocked or seller session.
  if (!user || role === 'seller') return <RootNavigationLayout />;
  return <SettingsProvider key={`${user.uid}:${accountId}`}><ProductsProvider><CartProvider><RootNavigationLayout /></CartProvider></ProductsProvider></SettingsProvider>;
}

export default function RootLayout() {
  return <SafeAreaProvider><AuthProvider><SessionWorkspace /></AuthProvider></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: ui.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  brandBadge: {
    alignItems: 'center',
    marginBottom: 24,
  },
  brandSubtitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.textSecondary,
    letterSpacing: 0,
    marginTop: 4,
  },
  spinner: {
    marginTop: 12,
  },
});
