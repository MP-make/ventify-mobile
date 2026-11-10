import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { SettingsProvider } from '@/context/SettingsContext';
import { ProductsProvider } from '@/context/ProductsContext';
import { CartProvider } from '@/context/CartContext';
import { PinLockModal } from '@/components/PinLockModal';
import { BrandLogo } from '@/components/ui';
import { ui } from '@/lib/theme';

/**
 * Componente interno que orquesta la navegación y redirección reactiva
 * según el estado de la sesión de Firebase Auth
 */
function RootNavigationLayout() {
  const { user, initialized, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!initialized || loading) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!user && !inAuthGroup) {
      // Si no hay usuario y no está en el flujo de auth, enviar al login
      router.replace('/(auth)/login');
    } else if (user && inAuthGroup) {
      // Si el usuario ya está autenticado y sigue en login, enviar al POS
      router.replace('/(tabs)');
    }
  }, [user, initialized, loading, segments, router]);

  // Pantalla de carga inicial mientras se resuelve la sesión y persistencia
  if (!initialized || (loading && user !== null)) {
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
      </Stack>

      {/* Modal Global de Bloqueo por PIN de Terminal */}
      <PinLockModal />
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <SettingsProvider>
          <ProductsProvider>
            <CartProvider>
              <RootNavigationLayout />
            </CartProvider>
          </ProductsProvider>
        </SettingsProvider>
      </AuthProvider>
    </SafeAreaProvider>
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
    marginTop: 4,
  },
  spinner: {
    marginTop: 12,
  },
});
