import React, { useMemo, useRef, useState } from 'react';
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
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  ArrowRight,
  User,
  Building2,
  Mail,
  Lock,
  Eye,
  EyeOff,
  AlertCircle,
  WifiOff,
  Check,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { BrandLogo } from '@/components/ui';
import { APP_URL } from '@/lib/env';
import { ui } from '@/lib/theme';

function evaluatePasswordStrength(password: string): {
  score: number;
  label: string;
  color: string;
} {
  let score = 0;
  if (password.length >= 6) score += 1;
  if (password.length >= 8) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score <= 2) return { score: Math.max(score, 1), label: 'Seguridad baja', color: ui.danger };
  if (score <= 3) return { score, label: 'Seguridad media', color: ui.warning };
  return { score, label: 'Seguridad alta', color: ui.success };
}

export default function SignupScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signup, isOnline } = useAuth();

  const [ownerName, setOwnerName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const businessInputRef = useRef<TextInput>(null);
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const confirmInputRef = useRef<TextInput>(null);

  const strength = useMemo(() => evaluatePasswordStrength(password), [password]);

  const clearError = () => {
    if (errorMessage) setErrorMessage(null);
  };

  const handleOpenLegal = (path: string) => {
    const url = `${APP_URL.replace(/\/$/, '')}${path}`;
    Linking.openURL(url).catch(() => {});
  };

  const handleSignup = async () => {
    const cleanOwner = ownerName.trim();
    const cleanBusiness = businessName.trim() || cleanOwner;
    const cleanEmail = email.trim();

    if (!isOnline) {
      setErrorMessage('Sin conexión a internet. Conéctate para crear tu cuenta.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

    if (!cleanOwner) {
      setErrorMessage('Ingresa tu nombre completo.');
      return;
    }
    if (cleanOwner.length > 100 || cleanBusiness.length > 100) {
      setErrorMessage('El nombre y el nombre del negocio no pueden exceder 100 caracteres.');
      return;
    }
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMessage('Ingresa un correo electrónico válido.');
      return;
    }
    if (password.length < 6) {
      setErrorMessage('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Las contraseñas no coinciden.');
      return;
    }
    if (!agreedToTerms) {
      setErrorMessage('Debes aceptar los términos y condiciones para continuar.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await signup(cleanEmail, password, cleanBusiness, cleanOwner);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      const code = err?.code || '';
      switch (code) {
        case 'auth/email-already-in-use':
          setErrorMessage('Este correo electrónico ya está registrado.');
          break;
        case 'auth/weak-password':
          setErrorMessage('La contraseña es muy débil. Usa al menos 6 caracteres.');
          break;
        case 'auth/invalid-email':
          setErrorMessage('El formato del correo electrónico no es válido.');
          break;
        case 'auth/too-many-requests':
          setErrorMessage('Demasiados intentos. Espera unos minutos e intenta nuevamente.');
          break;
        case 'auth/network-request-failed':
          setErrorMessage('Sin conexión al servidor. Verifica tu internet móvil o Wi-Fi.');
          break;
        default:
          setErrorMessage(
            err?.message || 'No se pudo crear la cuenta. Intenta nuevamente.'
          );
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

          <View style={styles.form}>
            <View style={styles.trialBadge}>
              <Check size={13} color={ui.primary} />
              <Text style={styles.trialBadgeText}>14 días gratis del Plan Profesional</Text>
            </View>

            <Text style={styles.formTitle}>Crear cuenta</Text>
            <Text style={styles.formDescription}>
              Empieza sin tarjeta de crédito. Después sigues gratis para siempre.
            </Text>

            {!isOnline && (
              <View style={styles.warning}>
                <WifiOff size={18} color={ui.warning} />
                <Text style={styles.warningText}>
                  Conéctate a internet para registrar tu negocio.
                </Text>
              </View>
            )}

            {errorMessage && (
              <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <AlertCircle size={18} color={ui.danger} />
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            )}

            <Text style={styles.label}>Nombre completo *</Text>
            <View style={styles.inputRow}>
              <User size={19} color={ui.textSecondary} />
              <TextInput
                value={ownerName}
                onChangeText={(text) => {
                  setOwnerName(text);
                  clearError();
                }}
                placeholder="Tu nombre completo"
                placeholderTextColor={ui.textMuted}
                autoCapitalize="words"
                style={styles.input}
                editable={!submitting}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => businessInputRef.current?.focus()}
                accessibilityLabel="Nombre completo"
              />
            </View>

            <Text style={styles.label}>Nombre del negocio</Text>
            <View style={styles.inputRow}>
              <Building2 size={19} color={ui.textSecondary} />
              <TextInput
                ref={businessInputRef}
                value={businessName}
                onChangeText={(text) => {
                  setBusinessName(text);
                  clearError();
                }}
                placeholder="Ej. Bodega San Martín (opcional)"
                placeholderTextColor={ui.textMuted}
                autoCapitalize="words"
                style={styles.input}
                editable={!submitting}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => emailInputRef.current?.focus()}
                accessibilityLabel="Nombre del negocio"
              />
            </View>

            <Text style={styles.label}>Correo electrónico *</Text>
            <View style={styles.inputRow}>
              <Mail size={19} color={ui.textSecondary} />
              <TextInput
                ref={emailInputRef}
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  clearError();
                }}
                placeholder="nombre@tunegocio.pe"
                placeholderTextColor={ui.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                style={styles.input}
                editable={!submitting}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => passwordInputRef.current?.focus()}
                accessibilityLabel="Correo electrónico"
              />
            </View>

            <Text style={styles.label}>Contraseña *</Text>
            <View style={styles.inputRow}>
              <Lock size={19} color={ui.textSecondary} />
              <TextInput
                ref={passwordInputRef}
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  clearError();
                }}
                placeholder="Mínimo 6 caracteres"
                placeholderTextColor={ui.textMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                editable={!submitting}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => confirmInputRef.current?.focus()}
                accessibilityLabel="Contraseña"
              />
              <TouchableOpacity
                onPress={() => setShowPassword((v) => !v)}
                style={styles.eye}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPassword ? (
                  <EyeOff size={20} color={ui.textSecondary} />
                ) : (
                  <Eye size={20} color={ui.textSecondary} />
                )}
              </TouchableOpacity>
            </View>

            {password.length > 0 && (
              <View style={styles.strengthBox}>
                <View style={styles.strengthBars}>
                  {[1, 2, 3, 4, 5].map((lvl) => (
                    <View
                      key={lvl}
                      style={[
                        styles.strengthBar,
                        {
                          backgroundColor:
                            lvl <= strength.score ? strength.color : ui.border,
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text style={[styles.strengthLabel, { color: strength.color }]}>
                  {strength.label}
                </Text>
              </View>
            )}

            <Text style={styles.label}>Confirmar contraseña *</Text>
            <View style={styles.inputRow}>
              <Lock size={19} color={ui.textSecondary} />
              <TextInput
                ref={confirmInputRef}
                value={confirmPassword}
                onChangeText={(text) => {
                  setConfirmPassword(text);
                  clearError();
                }}
                placeholder="Repite tu contraseña"
                placeholderTextColor={ui.textMuted}
                secureTextEntry={!showConfirmPassword}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                editable={!submitting}
                returnKeyType="go"
                onSubmitEditing={handleSignup}
                accessibilityLabel="Confirmar contraseña"
              />
              <TouchableOpacity
                onPress={() => setShowConfirmPassword((v) => !v)}
                style={styles.eye}
                accessibilityRole="button"
                accessibilityLabel={
                  showConfirmPassword ? 'Ocultar confirmación' : 'Mostrar confirmación'
                }
              >
                {showConfirmPassword ? (
                  <EyeOff size={20} color={ui.textSecondary} />
                ) : (
                  <Eye size={20} color={ui.textSecondary} />
                )}
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              onPress={() => {
                setAgreedToTerms((v) => !v);
                clearError();
              }}
              style={styles.termsRow}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreedToTerms }}
              activeOpacity={0.75}
            >
              <View style={[styles.checkbox, agreedToTerms && styles.checkboxChecked]}>
                {agreedToTerms ? <Check size={14} color={ui.onPrimary} /> : null}
              </View>
              <Text style={styles.termsText}>
                Acepto los{' '}
                <Text
                  style={styles.termsLink}
                  onPress={() => handleOpenLegal('/legal/terms-of-service')}
                >
                  términos y condiciones
                </Text>{' '}
                y la{' '}
                <Text
                  style={styles.termsLink}
                  onPress={() => handleOpenLegal('/legal/privacy-policy')}
                >
                  política de privacidad
                </Text>
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => void handleSignup()}
              disabled={submitting}
              style={[styles.submit, submitting && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="Crear cuenta en Ventify"
              accessibilityState={{ disabled: submitting, busy: submitting }}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Text style={styles.submitText}>Crear cuenta gratis</Text>
                  <ArrowRight size={20} color={ui.onPrimary} />
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.replace('/(auth)/login')}
              disabled={submitting}
              style={styles.loginLinkRow}
              accessibilityRole="button"
              accessibilityLabel="¿Ya tienes cuenta? Inicia sesión"
            >
              <Text style={styles.loginPrompt}>
                ¿Ya tienes una cuenta?{' '}
                <Text style={styles.loginHighlight}>Inicia sesión</Text>
              </Text>
            </TouchableOpacity>
          </View>
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
  form: { backgroundColor: ui.surface, borderRadius: 16, padding: 22 },
  trialBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 12,
  },
  trialBadgeText: { color: ui.primary, fontSize: 12, fontWeight: '700' },
  formTitle: { color: ui.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  formDescription: { color: ui.textSecondary, fontSize: 13.5, lineHeight: 19, marginTop: 4, marginBottom: 8 },
  label: { color: ui.text, fontSize: 13, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 50,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingLeft: 14,
    paddingRight: 4,
    backgroundColor: ui.surface,
  },
  input: { flex: 1, minWidth: 0, color: ui.text, fontSize: 15, minHeight: 48, paddingVertical: 10 },
  eye: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  strengthBox: { marginTop: 8, gap: 4 },
  strengthBars: { flexDirection: 'row', gap: 4 },
  strengthBar: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 11.5, fontWeight: '600' },
  termsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 16,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  termsText: { flex: 1, fontSize: 12.5, lineHeight: 18, color: ui.textSecondary },
  termsLink: { color: ui.primary, fontWeight: '600' },
  submit: {
    minHeight: 52,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: ui.primary,
    borderRadius: 12,
    marginTop: 20,
    padding: 14,
  },
  submitText: { color: ui.onPrimary, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  loginLinkRow: {
    marginTop: 14,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginPrompt: { fontSize: 13, color: ui.textSecondary },
  loginHighlight: { color: ui.primary, fontWeight: '700' },
  warning: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    backgroundColor: ui.warningSoft,
    borderRadius: 10,
    marginTop: 10,
  },
  warningText: { flex: 1, color: ui.warning, fontSize: 13, lineHeight: 19 },
  error: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    backgroundColor: ui.dangerSoft,
    borderRadius: 10,
    marginTop: 10,
  },
  errorText: { flex: 1, color: ui.danger, fontSize: 13, lineHeight: 19 },
});
