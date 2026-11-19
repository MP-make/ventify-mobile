import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Mail,
  Send,
  AlertCircle,
  WifiOff,
  CheckCircle2,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { BrandLogo } from '@/components/ui';
import { ui } from '@/lib/theme';

export default function ForgotPasswordScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { sendPasswordReset, isOnline } = useAuth();

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sentToEmail, setSentToEmail] = useState<string | null>(null);

  const handleSubmit = async () => {
    const cleanEmail = email.trim();

    if (!isOnline) {
      setErrorMessage('Sin conexión a internet. Conéctate para enviar el correo.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMessage('Ingresa un correo electrónico válido.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await sendPasswordReset(cleanEmail);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setSentToEmail(cleanEmail);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      const code = err?.code || '';
      switch (code) {
        case 'auth/user-not-found':
          setErrorMessage('No existe una cuenta registrada con este correo.');
          break;
        case 'auth/invalid-email':
          setErrorMessage('El formato del correo electrónico no es válido.');
          break;
        case 'auth/too-many-requests':
          setErrorMessage('Demasiados intentos. Espera unos minutos e intenta más tarde.');
          break;
        case 'auth/network-request-failed':
          setErrorMessage('Sin conexión al servidor. Verifica tu internet móvil o Wi-Fi.');
          break;
        default:
          setErrorMessage('No se pudo enviar el correo de recuperación. Intenta nuevamente.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 24) },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.body}>
          <View style={styles.topBar}>
            <TouchableOpacity
              onPress={() => router.replace('/(auth)/login')}
              style={styles.backButton}
              accessibilityRole="button"
              accessibilityLabel="Volver a inicio de sesión"
            >
              <ArrowLeft size={20} color={ui.text} />
            </TouchableOpacity>
            <BrandLogo size={30} />
          </View>

          {sentToEmail ? (
            <View style={styles.form}>
              <View style={styles.successBadge}>
                <CheckCircle2 size={30} color={ui.success} />
              </View>
              <Text style={styles.successTitle}>Correo enviado</Text>
              <Text style={styles.successSubtitle}>Revisa tu bandeja de entrada</Text>

              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  Hemos enviado un enlace a <Text style={styles.infoStrong}>{sentToEmail}</Text> con
                  instrucciones para restablecer tu contraseña.
                </Text>
                <Text style={styles.infoHint}>
                  Si no lo ves en unos minutos, revisa tu carpeta de spam o correo no deseado.
                </Text>
              </View>

              <TouchableOpacity
                onPress={() => router.replace('/(auth)/login')}
                style={styles.submit}
                accessibilityRole="button"
                accessibilityLabel="Volver al inicio de sesión"
              >
                <ArrowLeft size={18} color={ui.onPrimary} />
                <Text style={styles.submitText}>Volver al inicio de sesión</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  setSentToEmail(null);
                  setErrorMessage(null);
                }}
                style={styles.secondaryBtn}
                accessibilityRole="button"
                accessibilityLabel="Usar otro correo"
              >
                <Text style={styles.secondaryBtnText}>Intentar con otro correo</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.form}>
              <Text style={styles.formTitle}>Recuperar contraseña</Text>
              <Text style={styles.formDescription}>
                Ingresa tu correo electrónico y te enviaremos instrucciones para restablecer tu
                contraseña.
              </Text>

              {!isOnline && (
                <View style={styles.warning}>
                  <WifiOff size={18} color={ui.warning} />
                  <Text style={styles.warningText}>
                    Conéctate a internet para enviar el correo de recuperación.
                  </Text>
                </View>
              )}

              {errorMessage && (
                <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
                  <AlertCircle size={18} color={ui.danger} />
                  <Text style={styles.errorText}>{errorMessage}</Text>
                </View>
              )}

              <Text style={styles.label}>Correo electrónico</Text>
              <View style={styles.inputRow}>
                <Mail size={19} color={ui.textSecondary} />
                <TextInput
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="nombre@tunegocio.pe"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  style={styles.input}
                  editable={!submitting}
                  returnKeyType="send"
                  onSubmitEditing={() => void handleSubmit()}
                  accessibilityLabel="Correo electrónico"
                />
              </View>

              <TouchableOpacity
                onPress={() => void handleSubmit()}
                disabled={submitting}
                style={[styles.submit, submitting && styles.disabled]}
                accessibilityRole="button"
                accessibilityLabel="Enviar correo de recuperación"
                accessibilityState={{ disabled: submitting, busy: submitting }}
                activeOpacity={0.85}
              >
                {submitting ? (
                  <ActivityIndicator color={ui.onPrimary} />
                ) : (
                  <>
                    <Send size={18} color={ui.onPrimary} />
                    <Text style={styles.submitText}>Enviar correo de recuperación</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => router.replace('/(auth)/login')}
                disabled={submitting}
                style={styles.secondaryBtn}
                accessibilityRole="button"
                accessibilityLabel="Volver al inicio de sesión"
              >
                <ArrowLeft size={16} color={ui.textSecondary} />
                <Text style={styles.secondaryBtnText}>Volver al inicio de sesión</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.background },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20 },
  body: { width: '100%', maxWidth: 460, alignSelf: 'center' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  form: { backgroundColor: ui.surface, borderRadius: 16, padding: 24 },
  formTitle: { color: ui.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  formDescription: { color: ui.textSecondary, fontSize: 13.5, lineHeight: 20, marginTop: 6 },
  label: { color: ui.text, fontSize: 13, fontWeight: '600', marginTop: 18, marginBottom: 8 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 54,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingLeft: 14,
    paddingRight: 10,
    backgroundColor: ui.surface,
  },
  input: { flex: 1, minWidth: 0, color: ui.text, fontSize: 15, minHeight: 52, paddingVertical: 12 },
  submit: {
    minHeight: 52,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: ui.primary,
    borderRadius: 12,
    marginTop: 22,
    paddingHorizontal: 16,
  },
  submitText: { color: ui.onPrimary, fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  secondaryBtn: {
    minHeight: 46,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  secondaryBtnText: { color: ui.textSecondary, fontSize: 14, fontWeight: '600' },
  warning: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    backgroundColor: ui.warningSoft,
    borderRadius: 10,
    marginTop: 14,
  },
  warningText: { flex: 1, color: ui.warning, fontSize: 13, lineHeight: 19 },
  error: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    backgroundColor: ui.dangerSoft,
    borderRadius: 10,
    marginTop: 14,
  },
  errorText: { flex: 1, color: ui.danger, fontSize: 13, lineHeight: 19 },
  successBadge: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: ui.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 14,
  },
  successTitle: {
    color: ui.text,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  successSubtitle: {
    color: ui.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  infoBox: {
    backgroundColor: ui.primarySoft,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  infoText: { color: ui.text, fontSize: 13.5, lineHeight: 20 },
  infoStrong: { color: ui.primary, fontWeight: '700' },
  infoHint: { color: ui.textSecondary, fontSize: 12.5, lineHeight: 18 },
});
