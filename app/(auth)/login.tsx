import React, { useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  Store,
  AlertCircle,
  WifiOff,
  Sparkles,
  ArrowRight,
  ChevronDown,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { ui } from '@/lib/theme';
import { BrandLogo } from '@/components/ui';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const { isOnline } = useSettings();

  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDemoAccess, setShowDemoAccess] = useState(false);
  const passwordInputRef = useRef<TextInput>(null);

  const handleLogin = async () => {
    const cleanEmail = email.trim();
    const cleanPass = password.trim();

    if (!cleanEmail || !cleanPass) {
      setErrorMessage('Ingresa tu correo y contraseña para continuar.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    try {
      await login(cleanEmail, cleanPass);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      const code = err?.code || '';

      switch (code) {
        case 'auth/user-not-found':
          setErrorMessage('No existe ninguna cuenta registrada con este correo.');
          break;
        case 'auth/wrong-password':
          setErrorMessage('La contraseña ingresada es incorrecta.');
          break;
        case 'auth/invalid-credential':
          setErrorMessage('Credenciales inválidas. Revisa tu correo y contraseña.');
          break;
        case 'auth/invalid-email':
          setErrorMessage('El formato de correo electrónico no es válido.');
          break;
        case 'auth/user-disabled':
          setErrorMessage('Esta cuenta de usuario ha sido suspendida.');
          break;
        case 'auth/too-many-requests':
          setErrorMessage('Demasiados intentos fallidos. Espera unos momentos.');
          break;
        case 'auth/network-request-failed':
          setErrorMessage('Sin conexión al servidor. Verifica tu internet móvil o Wi-Fi.');
          break;
        default:
          setErrorMessage(
            err?.message ? `Error al iniciar sesión: ${err.message}` : 'Error al autenticar credenciales.'
          );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleFillDemo = (demoEmail: string, demoPass: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setEmail(demoEmail);
    setPassword(demoPass);
    setErrorMessage(null);
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 36, paddingBottom: Math.max(insets.bottom, 24) }]} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} showsVerticalScrollIndicator={false}>
        <View style={styles.body}>
          <View style={styles.brand}><BrandLogo size={64} /></View>
          <View style={styles.welcome}>
            <Text accessibilityRole="header" style={styles.title}>Tu negocio,{'\n'}siempre contigo.</Text>
            <Text style={styles.description}>Vende, controla tu inventario y lleva tu negocio desde un solo lugar.</Text>
          </View>
          <View style={styles.form}>
            <Text style={styles.formTitle}>Bienvenido de nuevo</Text>
            <Text style={styles.formDescription}>Ingresa a tu cuenta Ventify.</Text>
            {!isOnline && <View style={styles.warning}><WifiOff size={18} color={ui.warning} /><Text style={styles.warningText}>Conéctate a internet para iniciar sesión.</Text></View>}
            {errorMessage && <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite"><AlertCircle size={18} color={ui.danger} /><Text style={styles.errorText}>{errorMessage}</Text></View>}
            <Text style={styles.label}>Correo electrónico</Text>
            <View style={styles.inputRow}>
              <Mail size={19} color={ui.textSecondary} />
              <TextInput value={email} onChangeText={text => { setEmail(text); if (errorMessage) setErrorMessage(null); }} placeholder="nombre@tunegocio.pe" placeholderTextColor={ui.textMuted} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="username" style={styles.input} editable={!submitting} returnKeyType="next" blurOnSubmit={false} onSubmitEditing={() => passwordInputRef.current?.focus()} accessibilityLabel="Correo electrónico" />
            </View>
            <Text style={styles.label}>Contraseña</Text>
            <View style={styles.inputRow}>
              <Lock size={19} color={ui.textSecondary} />
              <TextInput ref={passwordInputRef} value={password} onChangeText={text => { setPassword(text); if (errorMessage) setErrorMessage(null); }} placeholder="Ingresa tu contraseña" placeholderTextColor={ui.textMuted} secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false} autoComplete="password" textContentType="password" style={styles.input} editable={!submitting} returnKeyType="go" onSubmitEditing={handleLogin} accessibilityLabel="Contraseña" />
              <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={styles.eye} accessibilityRole="button" accessibilityLabel={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{showPassword ? <EyeOff size={20} color={ui.textSecondary} /> : <Eye size={20} color={ui.textSecondary} />}</TouchableOpacity>
            </View>
            <TouchableOpacity onPress={handleLogin} disabled={submitting} style={[styles.submit, submitting && styles.disabled]} accessibilityRole="button" accessibilityLabel="Ingresar a Ventify" accessibilityState={{ disabled: submitting, busy: submitting }} activeOpacity={0.85}>
              {submitting ? <ActivityIndicator color={ui.onPrimary} /> : <><Text style={styles.submitText}>Ingresar a Ventify</Text><ArrowRight size={20} color={ui.onPrimary} /></>}
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.demoToggle} onPress={() => setShowDemoAccess(v => !v)} accessibilityRole="button" accessibilityState={{ expanded: showDemoAccess }} accessibilityLabel="Mostrar accesos de prueba"><Text style={styles.demoToggleText}>¿Quieres explorar primero?</Text><ChevronDown size={17} color={ui.textSecondary} style={{ transform: [{ rotate: showDemoAccess ? '180deg' : '0deg' }] }} /></TouchableOpacity>
          {showDemoAccess && <View style={styles.demoList}>
            <TouchableOpacity style={styles.demoOption} onPress={() => handleFillDemo('demo@ventify.pe', 'demo123')} accessibilityRole="button" accessibilityLabel="Completar credenciales de tienda demo"><Store size={20} color={ui.primary} /><View style={styles.demoCopy}><Text style={styles.demoTitle}>Tienda demo</Text><Text style={styles.demoSubtitle}>Explora como propietario</Text></View><ArrowRight size={18} color={ui.primary} /></TouchableOpacity>
            <TouchableOpacity style={styles.demoOption} onPress={() => handleFillDemo('cajera1.s1@ventify.pe', 'demo123')} accessibilityRole="button" accessibilityLabel="Completar credenciales de cajera"><Store size={20} color={ui.primary} /><View style={styles.demoCopy}><Text style={styles.demoTitle}>Terminal de caja</Text><Text style={styles.demoSubtitle}>Explora como cajero</Text></View><ArrowRight size={18} color={ui.primary} /></TouchableOpacity>
          </View>}
          <Text style={styles.footer}>Ventify Mobile · El control de tu negocio, a mano.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.background },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 },
  body: { width: '100%', maxWidth: 460, alignSelf: 'center' },
  brand: { marginBottom: 32 },
  welcome: { marginBottom: 28 },
  title: { color: ui.text, fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -1.1 },
  description: { color: ui.textSecondary, fontSize: 16, lineHeight: 24, marginTop: 12, maxWidth: 370 },
  form: { backgroundColor: ui.surface, borderRadius: 16, padding: 24 },
  formTitle: { color: ui.text, fontSize: 21, fontWeight: '700', letterSpacing: -0.4 },
  formDescription: { color: ui.textSecondary, fontSize: 14, marginTop: 6, marginBottom: 12 },
  label: { color: ui.text, fontSize: 13, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, borderWidth: 1, borderColor: ui.border, borderRadius: 12, paddingLeft: 14, paddingRight: 4, backgroundColor: ui.surface },
  input: { flex: 1, minWidth: 0, color: ui.text, fontSize: 15, minHeight: 52, paddingVertical: 12 },
  eye: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  submit: { minHeight: 54, flexDirection: 'row', gap: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: ui.primary, borderRadius: 12, marginTop: 24, padding: 14 },
  submitText: { color: ui.onPrimary, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  warning: { flexDirection: 'row', gap: 8, padding: 12, backgroundColor: ui.warningSoft, borderRadius: 10, marginTop: 12 },
  warningText: { flex: 1, color: ui.warning, fontSize: 13, lineHeight: 19 },
  error: { flexDirection: 'row', gap: 8, padding: 12, backgroundColor: ui.dangerSoft, borderRadius: 10, marginTop: 12 },
  errorText: { flex: 1, color: ui.danger, fontSize: 13, lineHeight: 19 },
  demoToggle: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 },
  demoToggleText: { color: ui.textSecondary, fontSize: 14, fontWeight: '500' },
  demoList: { gap: 8, marginBottom: 8 },
  demoOption: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 16, borderRadius: 12, backgroundColor: ui.primarySoft },
  demoCopy: { flex: 1 },
  demoTitle: { fontSize: 14, fontWeight: '600', color: ui.text },
  demoSubtitle: { fontSize: 12, color: ui.textSecondary, marginTop: 4 },
  footer: { color: ui.textSecondary, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 16, marginBottom: 16 },
});
