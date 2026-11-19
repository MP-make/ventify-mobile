import React, { useEffect, useState } from 'react';
import {
  View,
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  ScrollView,
  Linking,
  Alert,
} from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { enableFreeze } from 'react-native-screens';
import * as SplashScreen from 'expo-splash-screen';
import {
  PauseCircle,
  CalendarX2,
  ShieldAlert,
  WifiOff,
  AlertCircle,
  MessageCircle,
  RefreshCw,
  LogOut,
  Check,
  ExternalLink,
} from 'lucide-react-native';
import { AuthProvider, useAuth, type PlanSubscription } from '@/context/AuthContext';
import { SettingsProvider } from '@/context/SettingsContext';
import { ProductsProvider } from '@/context/ProductsContext';
import { CartProvider } from '@/context/CartContext';
import { PinLockModal } from '@/components/PinLockModal';
import { BrandLogo } from '@/components/ui';
import { APP_URL } from '@/lib/firebase';
import { ui } from '@/lib/theme';

enableFreeze(true);
SplashScreen.preventAutoHideAsync().catch(() => {});

const SUPPORT_WHATSAPP = 'https://wa.me/51983495868';

const PAUSE_REASONS: Record<string, string> = {
  admin_request: 'El equipo de Ventify pausó tu plan para una revisión de tu cuenta.',
  payment_failed: 'Se pausó tu plan porque el último pago no pudo procesarse.',
  customer_request: 'Tu plan se pausó a solicitud del titular de la cuenta.',
  technical_issues: 'Tu plan se pausó por un inconveniente técnico que estamos resolviendo.',
  other: 'Tu plan fue pausado. Revisa el detalle con nuestro equipo.',
};

const CANCEL_REASONS: Record<string, string> = {
  payment_failed: 'El último pago no pudo procesarse y la suscripción se canceló.',
  customer_request: 'La suscripción se canceló a solicitud del titular de la cuenta.',
  plan_not_needed: 'La suscripción se canceló porque el plan ya no era necesario.',
  competitor: 'La suscripción se canceló por un cambio de proveedor.',
  technical_issues: 'La suscripción se canceló por inconvenientes técnicos.',
  admin_request: 'El equipo de Ventify canceló la suscripción tras una revisión de la cuenta.',
  admin_deletion: 'La suscripción fue dada de baja por el equipo de Ventify.',
  other: 'La suscripción fue cancelada.',
};

function formatDatePe(ts?: number | null): string | null {
  if (!ts || ts <= 0) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function buildRecoveryContent(
  accessBlocked: string | null,
  accessError: string | null,
  accountId: string | null,
  subscription: PlanSubscription | null,
  isOnline: boolean,
  userLabel: string
) {
  const planLabel = subscription?.planName || subscription?.planId || 'mi plan';

  if (accessBlocked === 'inactive_user') {
    return {
      tone: 'danger' as const,
      title: 'Usuario desactivado',
      subtitle: 'Tu acceso operativo está suspendido',
      reason:
        'Tu usuario fue desactivado por el administrador de tu negocio. Comunícate con tu encargado o administrador para reactivarlo.',
      bullets: [
        'Los datos del negocio permanecen intactos.',
        'En cuanto te reactiven, presiona "Volver a verificar".',
      ],
      whatsappText: null,
      whatsappLabel: null,
      paymentHref: null,
    };
  }

  if (accessBlocked === 'paused_subscription') {
    const base =
      (subscription?.pauseReason && PAUSE_REASONS[subscription.pauseReason]) ||
      'Tu plan está en pausa y el acceso al negocio está temporalmente suspendido.';
    const since = formatDatePe(subscription?.pausedAt);
    return {
      tone: 'warning' as const,
      title: 'Tu plan está en pausa',
      subtitle: 'Regulariza tu cuenta para seguir operando',
      reason: since ? `${base} En pausa desde el ${since}.` : base,
      bullets: [
        'Tu información, catálogo y ventas se conservan.',
        'Al reclamar o regularizar, tu plan se reactiva de inmediato.',
      ],
      whatsappText: `Hola Ventify, soy ${userLabel} y quiero consultar sobre mi plan "${planLabel}" que figura en pausa. ¿Me ayudan a regularizarlo?`,
      whatsappLabel: 'Reclamar por WhatsApp',
      paymentHref: null,
    };
  }

  if (accessBlocked === 'cancelled_subscription') {
    const reason =
      (subscription?.cancelReason && CANCEL_REASONS[subscription.cancelReason]) ||
      'Tu suscripción fue cancelada y la cuenta quedó sin plan activo.';
    const paymentHref = subscription?.planId
      ? `${APP_URL.replace(/\/$/, '')}/payment?planId=${encodeURIComponent(subscription.planId)}&billingCycle=${encodeURIComponent(subscription.cycle || 'monthly')}`
      : `${APP_URL.replace(/\/$/, '')}/payment`;
    return {
      tone: 'muted' as const,
      title: 'Tu suscripción fue cancelada',
      subtitle: 'Reactívala para recuperar tu plan y tus límites',
      reason,
      bullets: [
        'Tu información y configuración se conservan.',
        'Puedes reactivar el mismo plan o elegir uno nuevo.',
      ],
      whatsappText: `Hola Ventify, soy ${userLabel} y quiero reactivar mi suscripción "${planLabel}" que figura cancelada.`,
      whatsappLabel: 'Reactivar por WhatsApp',
      paymentHref,
    };
  }

  if (accessBlocked === 'expired_subscription') {
    let reason = 'Tu plan venció y necesitas renovarlo para seguir operando sin interrupciones.';
    const endWhen = formatDatePe(subscription?.endDate);
    const trialWhen =
      subscription?.trialEndDate && Date.now() >= subscription.trialEndDate
        ? formatDatePe(subscription.trialEndDate)
        : null;
    if (endWhen) {
      reason = `Tu plan venció el ${endWhen} y la cuenta quedó sin suscripción activa.`;
    } else if (trialWhen) {
      reason = `Tu período de prueba terminó el ${trialWhen}. Elige un plan para seguir operando.`;
    }
    const paymentHref = subscription?.planId
      ? `${APP_URL.replace(/\/$/, '')}/payment?planId=${encodeURIComponent(subscription.planId)}&billingCycle=${encodeURIComponent(subscription.cycle || 'monthly')}`
      : `${APP_URL.replace(/\/$/, '')}/payment`;
    return {
      tone: 'danger' as const,
      title: 'Tu plan venció',
      subtitle: 'Renuévalo para seguir vendiendo sin interrupciones',
      reason,
      bullets: [
        'Al renovar recuperas tus límites y acceso al instante.',
        'Tu historial, clientes e inventario siguen seguros.',
      ],
      whatsappText: `Hola Ventify, soy ${userLabel} y quiero renovar mi plan "${planLabel}" que figura vencido.`,
      whatsappLabel: 'Renovar por WhatsApp',
      paymentHref,
    };
  }

  return {
    tone: isOnline ? ('danger' as const) : ('warning' as const),
    title: !isOnline ? 'Sin conexión a internet' : 'No se pudo verificar el acceso',
    subtitle: !isOnline
      ? 'Necesitas conexión para validar la sesión por primera vez'
      : 'Ocurrió un problema al validar tu negocio',
    reason:
      accessError ||
      (!accountId
        ? 'Tu usuario no tiene una cuenta de negocio disponible.'
        : 'Comprueba tu conexión e intenta verificar nuevamente.'),
    bullets: [],
    whatsappText: null,
    whatsappLabel: null,
    paymentHref: null,
  };
}

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
  if (
    !initialized ||
    (loading && user !== null) ||
    (user && role === 'seller' && String(segments[0]) !== 'seller') ||
    (!user && String(segments[0]) !== '(auth)')
  ) {
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
        <Stack.Screen name="dashboard" options={{ headerShown: false }} />
        <Stack.Screen name="reports" options={{ headerShown: false }} />
        <Stack.Screen name="facturacion" options={{ headerShown: false }} />
        <Stack.Screen name="branches" options={{ headerShown: false }} />
        <Stack.Screen name="notifications" options={{ headerShown: false }} />
      </Stack>

      {/* Modal Global de Bloqueo por PIN de Terminal */}
      <PinLockModal />
    </View>
  );
}

function SessionWorkspace() {
  const {
    user,
    userProfile,
    accountId,
    role,
    initialized,
    loading,
    isOnline,
    subscription,
    accessChecking,
    accessError,
    accessBlocked,
    refreshAccess,
    logout,
  } = useAuth();
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    if (initialized && !loading && (!user || !accessChecking)) {
      SplashScreen.hideAsync().catch(() => {});
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
    const userLabel = userProfile?.displayName || user.email || 'cliente';
    const card = buildRecoveryContent(
      accessBlocked,
      accessError,
      accountId,
      subscription,
      isOnline,
      userLabel
    );

    const badgeBg =
      card.tone === 'warning'
        ? ui.warningSoft
        : card.tone === 'muted'
          ? ui.surfaceMuted
          : ui.dangerSoft;
    const badgeColor =
      card.tone === 'warning'
        ? ui.warning
        : card.tone === 'muted'
          ? ui.textSecondary
          : ui.danger;

    const handleOpenUrl = async (url: string) => {
      try {
        await Linking.openURL(url);
      } catch {
        Alert.alert('No se pudo abrir el enlace', 'Intenta abrirlo manualmente desde tu navegador.');
      }
    };

    const handleRefresh = async () => {
      setRechecking(true);
      try {
        await refreshAccess();
      } finally {
        setRechecking(false);
      }
    };

    return (
      <SafeAreaView style={styles.recoverySafe} edges={['top', 'bottom']}>
        <StatusBar style="dark" backgroundColor={ui.background} />
        <ScrollView
          contentContainerStyle={styles.recoveryScroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.recoveryCard}>
            <View style={styles.recoveryBrandRow}>
              <BrandLogo size={36} />
              {!isOnline ? (
                <View style={styles.offlineChip}>
                  <WifiOff size={12} color={ui.warning} />
                  <Text style={styles.offlineChipText}>Sin conexión</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.recoveryHeaderRow}>
              <View style={[styles.recoveryIconBadge, { backgroundColor: badgeBg }]}>
                {accessBlocked === 'paused_subscription' ? (
                  <PauseCircle size={24} color={badgeColor} />
                ) : accessBlocked === 'expired_subscription' ||
                  accessBlocked === 'cancelled_subscription' ? (
                  <CalendarX2 size={24} color={badgeColor} />
                ) : accessBlocked === 'inactive_user' ? (
                  <ShieldAlert size={24} color={badgeColor} />
                ) : !isOnline ? (
                  <WifiOff size={24} color={badgeColor} />
                ) : (
                  <AlertCircle size={24} color={badgeColor} />
                )}
              </View>
              <View style={styles.recoveryTitleGroup}>
                <Text style={styles.recoveryTitle} accessibilityRole="header">
                  {card.title}
                </Text>
                <Text style={styles.recoverySubtitle}>{card.subtitle}</Text>
              </View>
            </View>

            <View style={styles.reasonBox}>
              <Text style={styles.reasonLabel}>MOTIVO</Text>
              <Text style={styles.reasonText} accessibilityRole="alert">
                {card.reason}
              </Text>
              {subscription?.planName && accessBlocked !== 'inactive_user' ? (
                <Text style={styles.planMetaText}>
                  Plan: {subscription.planName}
                </Text>
              ) : null}
            </View>

            {card.bullets.length > 0 ? (
              <View style={styles.bulletsBox}>
                {card.bullets.map((line) => (
                  <View key={line} style={styles.bulletRow}>
                    <Check size={15} color={ui.success} />
                    <Text style={styles.bulletText}>{line}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.actionsColumn}>
              {card.whatsappText && card.whatsappLabel ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={card.whatsappLabel}
                  onPress={() =>
                    void handleOpenUrl(
                      `${SUPPORT_WHATSAPP}?text=${encodeURIComponent(card.whatsappText)}`
                    )
                  }
                  style={[
                    styles.primaryActionBtn,
                    accessBlocked === 'paused_subscription' && { backgroundColor: ui.warning },
                  ]}
                  activeOpacity={0.85}
                >
                  <MessageCircle size={18} color={ui.onPrimary} />
                  <Text style={styles.primaryActionText}>{card.whatsappLabel}</Text>
                </TouchableOpacity>
              ) : null}

              {card.paymentHref ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Ver planes en la web"
                  onPress={() => void handleOpenUrl(card.paymentHref!)}
                  style={styles.secondaryActionBtn}
                  activeOpacity={0.8}
                >
                  <ExternalLink size={17} color={ui.primary} />
                  <Text style={styles.secondaryActionText}>Ver planes en la web</Text>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Volver a verificar"
                onPress={() => void handleRefresh()}
                disabled={rechecking}
                style={[styles.secondaryActionBtn, rechecking && { opacity: 0.6 }]}
                activeOpacity={0.8}
              >
                {rechecking ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <RefreshCw size={17} color={ui.primary} />
                )}
                <Text style={styles.secondaryActionText}>
                  {rechecking ? 'Verificando...' : 'Volver a verificar'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Cerrar sesión"
                onPress={() => void logout()}
                style={styles.logoutActionBtn}
                activeOpacity={0.8}
              >
                <LogOut size={17} color={ui.danger} />
                <Text style={styles.logoutActionText}>Cerrar sesión</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
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

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <SessionWorkspace />
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
    marginTop: 8,
  },
  spinner: {
    marginTop: 12,
  },
  recoverySafe: {
    flex: 1,
    backgroundColor: ui.background,
  },
  recoveryScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  recoveryCard: {
    width: '100%',
    maxWidth: 460,
    alignSelf: 'center',
    backgroundColor: ui.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 22,
    gap: 16,
  },
  recoveryBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  offlineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: ui.warningSoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  offlineChipText: {
    color: ui.warning,
    fontSize: 11,
    fontWeight: '700',
  },
  recoveryHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  recoveryIconBadge: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  recoveryTitleGroup: {
    flex: 1,
  },
  recoveryTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: ui.text,
    letterSpacing: -0.4,
  },
  recoverySubtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 2,
  },
  reasonBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 6,
  },
  reasonLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textMuted,
    letterSpacing: 0.6,
  },
  reasonText: {
    fontSize: 14,
    lineHeight: 20,
    color: ui.text,
  },
  planMetaText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
    marginTop: 2,
  },
  bulletsBox: {
    gap: 8,
    paddingHorizontal: 2,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  bulletText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    color: ui.textSecondary,
  },
  actionsColumn: {
    gap: 10,
    marginTop: 4,
  },
  primaryActionBtn: {
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  primaryActionText: {
    color: ui.onPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryActionBtn: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  secondaryActionText: {
    color: ui.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  logoutActionBtn: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: ui.dangerSoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  logoutActionText: {
    color: ui.danger,
    fontSize: 14,
    fontWeight: '700',
  },
});
