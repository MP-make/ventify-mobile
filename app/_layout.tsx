import React, { useCallback, useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { enableFreeze } from 'react-native-screens';
import * as SplashScreen from 'expo-splash-screen';
import {
  AuthProvider,
  useAuthSession,
  useNetworkStatus,
  usePinLock,
  usePlanAccess,
} from '@/context/AuthContext';
import { SettingsProvider } from '@/context/SettingsContext';
import { ProductsProvider } from '@/context/ProductsContext';
import { CartProvider } from '@/context/CartContext';
import { PinLockModal } from '@/components/PinLockModal';
import { BrandLogo } from '@/components/ui';
import { ui } from '@/lib/theme';

enableFreeze(false);
SplashScreen.preventAutoHideAsync().catch(() => {});

const STACK_SCREEN_OPTIONS = {
  headerShown: false,
  contentStyle: { backgroundColor: ui.background },
  animation: 'fade' as const,
};

const GlobalPinLockGate = React.memo(function GlobalPinLockGate() {
  const { user } = useAuthSession();
  const { isPinLocked, isPinSetupOpen } = usePinLock();
  if (!user || (!isPinLocked && !isPinSetupOpen)) return null;
  return <PinLockModal />;
});

/**
 * Componente interno que orquesta la navegación y redirección reactiva
 * según el estado de la sesión de Firebase Auth
 */
const RootNavigationLayout = React.memo(function RootNavigationLayout() {
  const { user, initialized, loading, role } = useAuthSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!initialized || loading) return;

    const current = String(segments[0] || '');
    if (!user && current !== '(auth)') router.replace('/(auth)/login');
    else if (user && role === 'seller' && current !== 'seller') router.replace('/seller');
    else if (user && role !== 'seller' && (current === '(auth)' || current === 'seller')) router.replace('/(tabs)');
  }, [user, initialized, loading, role, segments, router]);

  // Pantalla de carga inicial mientras se resuelve la sesión y persistencia.
  // Mantenemos <Stack> montado debajo para que expo-router pueda resolver router.replace().
  const showLoadingOverlay =
    !initialized ||
    (loading && user !== null) ||
    (user && role === 'seller' && String(segments[0]) !== 'seller') ||
    (!user && String(segments[0]) !== '(auth)');

  return (
    <View style={styles.container}>
      <StatusBar style="dark" backgroundColor={ui.surface} />
      <Stack screenOptions={STACK_SCREEN_OPTIONS}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="seller" options={{ headerShown: false }} />
        <Stack.Screen name="dashboard" options={{ headerShown: false }} />
        <Stack.Screen name="reports" options={{ headerShown: false }} />
        <Stack.Screen name="facturacion" options={{ headerShown: false }} />
        <Stack.Screen name="branches" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ headerShown: false }} />
        <Stack.Screen name="suppliers" options={{ headerShown: false }} />
      </Stack>

      <GlobalPinLockGate />

      {showLoadingOverlay ? (
        <View style={[styles.loadingContainer, StyleSheet.absoluteFill]}>
          <View style={styles.brandBadge}>
            <BrandLogo size={72} />
            <Text style={styles.brandSubtitle}>Preparando tu espacio de trabajo</Text>
          </View>
          <ActivityIndicator size="large" color={ui.primary} style={styles.spinner} />
        </View>
      ) : null}
    </View>
  );
});

function SessionWorkspace() {
  const { user, userProfile, accountId, role, initialized, loading, logout } = useAuthSession();
  const { subscription, accessChecking, accessError, accessBlocked, refreshAccess } =
    usePlanAccess();
  const { isOnline } = useNetworkStatus();
  const [rechecking, setRechecking] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRechecking(true);
    try {
      await refreshAccess();
    } finally {
      setRechecking(false);
    }
  }, [refreshAccess]);

  const handleRefreshPress = useCallback(() => {
    void handleRefresh();
  }, [handleRefresh]);

  const handleLogoutPress = useCallback(() => {
    void logout();
  }, [logout]);

  useEffect(() => {
    const timer = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (initialized && !loading && (!user || !accessChecking)) {
      const raf = requestAnimationFrame(() => {
        SplashScreen.hideAsync().catch(() => {});
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [initialized, loading, user, accessChecking]);

  const waiting = !initialized || loading || (Boolean(user) && accessChecking);
  const problem = accessBlocked || accessError || (user && !accountId ? 'missing_account' : null);

  if (user && waiting) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar style="dark" backgroundColor={ui.surface} />
        <BrandLogo size={72} />
        <Text style={styles.brandSubtitle}>Verificando acceso del negocio...</Text>
        <ActivityIndicator color={ui.primary} style={styles.spinner} />
      </View>
    );
  }

  if (user && problem) {
    const { AccountProblemScreen } = require('@/components/AccountProblemScreen') as typeof import('@/components/AccountProblemScreen');
    const userLabel = userProfile?.displayName || user.email || 'cliente';

    return (
      <AccountProblemScreen
        accessBlocked={accessBlocked}
        accessError={accessError}
        accountId={accountId}
        subscription={subscription}
        isOnline={isOnline}
        userLabel={userLabel}
        rechecking={rechecking}
        onRefresh={handleRefreshPress}
        onLogout={handleLogoutPress}
      />
    );
  }

  // No operational listeners are mounted for a blocked or seller session.
  if (!user || role === 'seller') return <RootNavigationLayout />;
  return (
    <SettingsProvider key={`${user.uid}:${accountId}`}>
      <ProductsProvider>
        <CartProvider>
          <RootNavigationLayout />
        </CartProvider>
      </ProductsProvider>
    </SettingsProvider>
  );
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch() {
    SplashScreen.hideAsync().catch(() => {});
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.loadingContainer}>
          <Text style={styles.brandSubtitle}>No se pudo iniciar Ventify POS</Text>
          <Text style={[styles.brandSubtitle, { fontWeight: '400', textAlign: 'center', marginTop: 8 }]}>
            {this.state.error.message || 'Error inesperado de arranque'}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  return (
    <RootErrorBoundary>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <AuthProvider>
          <SessionWorkspace />
        </AuthProvider>
      </SafeAreaProvider>
    </RootErrorBoundary>
  );
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
    marginTop: 8,
  },
  spinner: {
    marginTop: 12,
  },
});
