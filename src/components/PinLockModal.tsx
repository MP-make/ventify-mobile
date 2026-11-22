import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Delete,
  ShieldCheck,
  ShieldAlert,
  Clock,
  Check,
  X,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession, usePinLock } from '@/context/AuthContext';
import { ui } from '@/lib/theme';
import { BrandLogo } from '@/components/ui';
import {
  PIN_MAX_ATTEMPTS,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  normalizePinLength,
} from '@/lib/pin-mobile';

const NOOP = () => {};
const KEYPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;

interface KeypadDigitButtonProps {
  digit: string;
  disabled: boolean;
  onPressDigit: (digit: string) => void;
}

const KeypadDigitButton = React.memo<KeypadDigitButtonProps>(
  ({ digit, disabled, onPressDigit }) => {
    const handlePress = useCallback(() => {
      onPressDigit(digit);
    }, [onPressDigit, digit]);

    return (
      <TouchableOpacity
        onPress={handlePress}
        disabled={disabled}
        style={[styles.keyButton, disabled && styles.keyDisabled]}
        accessibilityRole="button"
        accessibilityLabel={`Dígito ${digit}`}
        activeOpacity={0.6}
      >
        <Text style={styles.keyText}>{digit}</Text>
      </TouchableOpacity>
    );
  }
);

const PinLockModalContent: React.FC = React.memo(() => {
  const insets = useSafeAreaInsets();
  const { userProfile } = useAuthSession();
  const {
    isPinLocked,
    isPinSetupOpen,
    closePinSetup,
    pinLength,
    pinFailedAttempts,
    pinLockoutUntil,
    unlockWithPin,
    updatePinCode,
    lockTerminal,
  } = usePinLock();

  const effectiveLength = normalizePinLength(pinLength);
  const isSetupMode = !isPinLocked && isPinSetupOpen;
  const visible = isPinLocked || isSetupMode;

  const [pin, setPin] = useState<string>('');
  const [setupStep, setSetupStep] = useState<'create' | 'confirm'>('create');
  const [draftPin, setDraftPin] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savingSetup, setSavingSetup] = useState<boolean>(false);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(0);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingReset = useCallback(() => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  // Resetear estado al abrir/cerrar bloqueo o setup
  useEffect(() => {
    clearPendingReset();
    if (visible) {
      setPin('');
      setDraftPin('');
      setSetupStep('create');
      setErrorMsg(null);
      setSavingSetup(false);
      shakeAnim.setValue(0);
    }
  }, [visible, isPinLocked, isSetupMode, shakeAnim, clearPendingReset]);

  useEffect(() => clearPendingReset, [clearPendingReset]);

  // Cuenta regresiva en vivo para el cooldown tras intentos fallidos
  useEffect(() => {
    if (!isPinLocked || !pinLockoutUntil) {
      setCooldownSeconds(0);
      return;
    }

    const updateRemaining = () => {
      const remainingMs = pinLockoutUntil - Date.now();
      if (remainingMs <= 0) {
        setCooldownSeconds(0);
        setErrorMsg(null);
        return false;
      }
      setCooldownSeconds(Math.ceil(remainingMs / 1000));
      return true;
    };

    if (!updateRemaining()) return;
    const interval = setInterval(() => {
      if (!updateRemaining()) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isPinLocked, pinLockoutUntil]);

  const isCoolingDown = isPinLocked && cooldownSeconds > 0;

  const triggerShake = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const submitUnlock = useCallback(
    (candidatePin: string) => {
      if (isCoolingDown || candidatePin.length < PIN_MIN_LENGTH) return;
      const success = unlockWithPin(candidatePin);
      if (success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        setPin('');
        setErrorMsg(null);
        return;
      }

      const nextFailures = pinFailedAttempts + 1;
      const remainingAttempts = Math.max(0, PIN_MAX_ATTEMPTS - nextFailures);
      setErrorMsg(
        remainingAttempts > 0
          ? `PIN incorrecto. ${remainingAttempts} ${
              remainingAttempts === 1 ? 'intento restante' : 'intentos restantes'
            }.`
          : 'Demasiados intentos fallidos. Espera unos segundos.'
      );
      triggerShake();
      clearPendingReset();
      resetTimerRef.current = setTimeout(() => {
        setPin('');
      }, 320);
    },
    [isCoolingDown, unlockWithPin, pinFailedAttempts, triggerShake, clearPendingReset]
  );

  const submitSetupStep = useCallback(async () => {
    if (savingSetup || pin.length < PIN_MIN_LENGTH) return;
    if (setupStep === 'create') {
      setDraftPin(pin);
      setPin('');
      setErrorMsg(null);
      setSetupStep('confirm');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      return;
    }

    if (pin !== draftPin) {
      setErrorMsg('Los PIN no coinciden. Vuelve a intentarlo.');
      triggerShake();
      clearPendingReset();
      resetTimerRef.current = setTimeout(() => {
        setPin('');
      }, 320);
      return;
    }

    setSavingSetup(true);
    try {
      await updatePinCode(pin);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setPin('');
      setDraftPin('');
      lockTerminal();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo guardar el PIN.');
      triggerShake();
    } finally {
      setSavingSetup(false);
    }
  }, [
    savingSetup,
    pin,
    setupStep,
    draftPin,
    triggerShake,
    clearPendingReset,
    updatePinCode,
    lockTerminal,
  ]);

  const maxAllowedDigits = isSetupMode ? PIN_MAX_LENGTH : effectiveLength;

  const handleDigit = useCallback(
    (digit: string) => {
      if (isCoolingDown || savingSetup) return;
      if (pin.length >= maxAllowedDigits) return;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const nextPin = pin + digit;
      setPin(nextPin);
      setErrorMsg(null);

      if (!isSetupMode && nextPin.length === effectiveLength) {
        submitUnlock(nextPin);
      }
    },
    [isCoolingDown, savingSetup, pin, maxAllowedDigits, isSetupMode, effectiveLength, submitUnlock]
  );

  const handleDelete = useCallback(() => {
    if (isCoolingDown || savingSetup || pin.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setPin((prev) => prev.slice(0, -1));
    setErrorMsg(null);
  }, [isCoolingDown, savingSetup, pin.length]);

  const handleConfirmPress = useCallback(() => {
    if (isSetupMode) {
      void submitSetupStep();
    } else {
      submitUnlock(pin);
    }
  }, [isSetupMode, submitSetupStep, submitUnlock, pin]);

  const containerStyle = useMemo(
    () => [
      styles.container,
      {
        paddingTop: Math.max(insets.top, Platform.OS === 'ios' ? 44 : 24) + 12,
        paddingBottom: Math.max(insets.bottom, 24),
      },
    ],
    [insets.top, insets.bottom]
  );

  const shakeTransformStyle = useMemo(
    () => ({ transform: [{ translateX: shakeAnim }] }),
    [shakeAnim]
  );

  if (!visible) return null;

  const showExplicitConfirm = isSetupMode || effectiveLength > PIN_MIN_LENGTH;
  const canSubmitExplicit =
    !isCoolingDown && !savingSetup && pin.length >= PIN_MIN_LENGTH;
  const dotCount = isSetupMode ? Math.max(PIN_MIN_LENGTH, pin.length) : effectiveLength;
  const dotCompact = dotCount >= 7;
  const dotMedium = dotCount > 4 && dotCount < 7;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      statusBarTranslucent
      onRequestClose={isSetupMode ? closePinSetup : NOOP}
    >
      <View style={containerStyle}>
        {/* Cabecera de Seguridad */}
        <View style={styles.header}>
          {isSetupMode ? (
            <TouchableOpacity
              onPress={closePinSetup}
              style={styles.cancelSetupButton}
              accessibilityRole="button"
              accessibilityLabel="Cancelar configuración de PIN"
            >
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          ) : null}

          <View style={styles.lockIconContainer}>
            <BrandLogo size={58} wordmark={false} />
          </View>

          <Text style={styles.title}>
            {isSetupMode
              ? setupStep === 'create'
                ? 'Configura tu PIN'
                : 'Confirma tu PIN'
              : 'Tu terminal está bloqueado'}
          </Text>

          <Text style={styles.subtitle}>
            {isSetupMode
              ? setupStep === 'create'
                ? 'Elige un PIN de 4 a 8 dígitos para proteger este terminal'
                : 'Ingresa nuevamente el mismo PIN para confirmar'
              : userProfile?.displayName
                ? `Operador: ${userProfile.displayName}`
                : `Ingresa tu PIN de ${effectiveLength} dígitos para continuar`}
          </Text>

          {/* Indicadores Visuales Dinámicos (4..8 Puntos) */}
          <Animated.View
            style={[
              styles.dotsContainer,
              dotCompact && styles.dotsContainerCompact,
              dotMedium && styles.dotsContainerMedium,
              shakeTransformStyle,
            ]}
          >
            {Array.from({ length: dotCount }, (_, index) => {
              const isFilled = pin.length > index;
              return (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    dotCompact && styles.dotCompact,
                    isFilled && styles.dotFilled,
                    Boolean(errorMsg || isCoolingDown) && styles.dotError,
                  ]}
                />
              );
            })}
          </Animated.View>

          {/* Estado: Cooldown, Error o Hint neutro */}
          {isCoolingDown ? (
            <View style={styles.cooldownBadge} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <Clock size={14} color={ui.danger} />
              <Text style={styles.errorText}>
                Terminal bloqueado temporalmente · Espera {cooldownSeconds}s
              </Text>
            </View>
          ) : errorMsg ? (
            <View style={styles.errorRow} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <ShieldAlert size={14} color={ui.danger} />
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          ) : (
            <View style={styles.hintRow}>
              <ShieldCheck size={14} color={ui.textMuted} />
              <Text style={styles.hintText}>
                {isSetupMode
                  ? `${pin.length}/${PIN_MAX_LENGTH} dígitos ingresados (mínimo ${PIN_MIN_LENGTH})`
                  : `Terminal protegido · PIN de ${effectiveLength} dígitos`}
              </Text>
            </View>
          )}
        </View>

        {/* Teclado Numérico Táctil Nativo */}
        <View style={styles.keypadContainer}>
          {showExplicitConfirm ? (
            <TouchableOpacity
              onPress={handleConfirmPress}
              disabled={!canSubmitExplicit}
              style={[
                styles.confirmButton,
                !canSubmitExplicit && styles.confirmButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                isSetupMode
                  ? setupStep === 'create'
                    ? 'Continuar con este PIN'
                    : 'Guardar PIN y bloquear terminal'
                  : 'Confirmar PIN'
              }
              accessibilityState={{ disabled: !canSubmitExplicit }}
              activeOpacity={0.8}
            >
              <Check size={18} color={ui.onPrimary} />
              <Text style={styles.confirmButtonText}>
                {isSetupMode
                  ? setupStep === 'create'
                    ? 'Continuar'
                    : 'Guardar y bloquear'
                  : 'Confirmar PIN'}
              </Text>
            </TouchableOpacity>
          ) : null}

          {KEYPAD_ROWS.map((rowDigits, rowIdx) => (
            <View key={rowIdx} style={styles.row}>
              {rowDigits.map((digit) => (
                <KeypadDigitButton
                  key={digit}
                  digit={digit}
                  disabled={isCoolingDown}
                  onPressDigit={handleDigit}
                />
              ))}
            </View>
          ))}

          <View style={styles.row}>
            <View style={styles.keyEmpty}>
              <ShieldCheck size={22} color={ui.textMuted} />
            </View>

            <KeypadDigitButton
              digit="0"
              disabled={isCoolingDown}
              onPressDigit={handleDigit}
            />

            <TouchableOpacity
              onPress={handleDelete}
              disabled={isCoolingDown || pin.length === 0}
              style={[
                styles.keyButton,
                styles.keyDelete,
                isCoolingDown && styles.keyDisabled,
              ]}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Borrar dígito"
            >
              <Delete size={24} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});

export const PinLockModal: React.FC = React.memo(() => {
  const { isPinLocked, isPinSetupOpen } = usePinLock();
  if (!isPinLocked && !isPinSetupOpen) return null;
  return <PinLockModalContent />;
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  header: {
    alignItems: 'center',
    width: '100%',
    marginTop: 16,
  },
  cancelSetupButton: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockIconContainer: {
    width: 68,
    height: 68,
    borderRadius: 22,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: ui.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 6,
    textAlign: 'center',
  },
  dotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    marginTop: 32,
    marginBottom: 18,
  },
  dotsContainerMedium: {
    gap: 14,
  },
  dotsContainerCompact: {
    gap: 10,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: ui.border,
    backgroundColor: 'transparent',
  },
  dotCompact: {
    width: 13,
    height: 13,
    borderRadius: 7,
  },
  dotFilled: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
    transform: [{ scale: 1.15 }],
  },
  dotError: {
    backgroundColor: ui.danger,
    borderColor: ui.danger,
    transform: [{ scale: 1.15 }],
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 24,
    paddingHorizontal: 12,
  },
  cooldownBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.dangerSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  errorText: {
    color: ui.danger,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 24,
  },
  hintText: {
    color: ui.textMuted,
    fontSize: 12,
    fontWeight: '500',
  },
  keypadContainer: {
    width: '100%',
    maxWidth: 320,
    gap: 14,
    marginBottom: 12,
  },
  confirmButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 4,
  },
  confirmButtonDisabled: {
    opacity: 0.45,
  },
  confirmButtonText: {
    color: ui.onPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 14,
  },
  keyButton: {
    flex: 1,
    height: 66,
    borderRadius: 14,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDisabled: {
    opacity: 0.45,
  },
  keyText: {
    fontSize: 26,
    fontWeight: '700',
    color: ui.text,
  },
  keyEmpty: {
    flex: 1,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDelete: {
    backgroundColor: ui.surfaceMuted,
  },
});
