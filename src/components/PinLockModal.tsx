import React, { useState, useRef, useEffect } from 'react';
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
import { Lock, Delete, ShieldCheck, ShieldAlert } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { ui } from '@/lib/theme';
import { BrandLogo } from '@/components/ui';

export const PinLockModal: React.FC = () => {
  const insets = useSafeAreaInsets();
  const { isPinLocked, unlockWithPin, userProfile } = useAuth();

  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<boolean>(false);

  // Animación de sacudida (shake) para PIN incorrecto
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // Resetear estado al bloquear/desbloquear
  useEffect(() => {
    if (isPinLocked) {
      setPin('');
      setError(false);
      shakeAnim.setValue(0);
    }
  }, [isPinLocked, shakeAnim]);

  const triggerShake = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -12, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleDigit = (digit: string) => {
    if (pin.length >= 4) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

    const nextPin = pin + digit;
    setPin(nextPin);
    setError(false);

    if (nextPin.length === 4) {
      // Verificar código PIN
      const success = unlockWithPin(nextPin);

      if (success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        setPin('');
      } else {
        setError(true);
        triggerShake();
        setTimeout(() => {
          setPin('');
        }, 350);
      }
    }
  };

  const handleDelete = () => {
    if (pin.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setPin((prev) => prev.slice(0, -1));
    setError(false);
  };

  if (!isPinLocked) return null;

  return (
    <Modal
      visible={isPinLocked}
      animationType="fade"
      transparent={false}
      statusBarTranslucent
    >
      <View
        style={[
          styles.container,
          {
            paddingTop: Math.max(insets.top, Platform.OS === 'ios' ? 44 : 24) + 16,
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
      >
        {/* Cabecera de Seguridad */}
        <View style={styles.header}>
          <View style={styles.lockIconContainer}><BrandLogo size={58} wordmark={false} /></View>
          <Text style={styles.title}>Tu terminal está bloqueado</Text>
          <Text style={styles.subtitle}>
            {userProfile?.displayName
              ? `Operador: ${userProfile.displayName}`
              : 'Ingresa el PIN de 4 dígitos para continuar'}
          </Text>

          {/* Indicadores Visuales de 4 Puntos con Animación Shake */}
          <Animated.View
            style={[
              styles.dotsContainer,
              { transform: [{ translateX: shakeAnim }] },
            ]}
          >
            {[0, 1, 2, 3].map((index) => {
              const isFilled = pin.length > index;
              return (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    isFilled && styles.dotFilled,
                    error && styles.dotError,
                  ]}
                />
              );
            })}
          </Animated.View>

          {/* Mensaje de Error */}
          {error ? (
            <View style={styles.errorRow}>
              <ShieldAlert size={14} color={ui.danger} />
              <Text style={styles.errorText}>PIN incorrecto. Intenta de nuevo.</Text>
            </View>
          ) : (
            <View style={styles.hintRow}>
              <ShieldCheck size={14} color={ui.textMuted} />
              <Text style={styles.hintText}>PIN por defecto: 1234</Text>
            </View>
          )}
        </View>

        {/* Teclado Numérico Táctil Nativo */}
        <View style={styles.keypadContainer}>
          <View style={styles.row}>
            {['1', '2', '3'].map((digit) => (
              <TouchableOpacity
                key={digit}
                onPress={() => handleDigit(digit)}
                style={styles.keyButton}
                accessibilityRole="button"
                accessibilityLabel={`Dígito ${digit}`}
                activeOpacity={0.6}
              >
                <Text style={styles.keyText}>{digit}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.row}>
            {['4', '5', '6'].map((digit) => (
              <TouchableOpacity
                key={digit}
                onPress={() => handleDigit(digit)}
                style={styles.keyButton}
                accessibilityRole="button"
                accessibilityLabel={`Dígito ${digit}`}
                activeOpacity={0.6}
              >
                <Text style={styles.keyText}>{digit}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.row}>
            {['7', '8', '9'].map((digit) => (
              <TouchableOpacity
                key={digit}
                onPress={() => handleDigit(digit)}
                style={styles.keyButton}
                accessibilityRole="button"
                accessibilityLabel={`Dígito ${digit}`}
                activeOpacity={0.6}
              >
                <Text style={styles.keyText}>{digit}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.row}>
            {/* Espacio en blanco o icono decorativo */}
            <View style={styles.keyEmpty}>
              <ShieldCheck size={22} color={ui.textMuted} />
            </View>

            {/* Tecla Cero */}
            <TouchableOpacity
              onPress={() => handleDigit('0')}
              style={styles.keyButton}
              activeOpacity={0.6}
            >
              <Text style={styles.keyText}>0</Text>
            </TouchableOpacity>

            {/* Tecla Borrar */}
            <TouchableOpacity
              onPress={handleDelete}
              style={[styles.keyButton, styles.keyDelete]}
              activeOpacity={0.6}
              accessibilityLabel="Borrar dígito"
            >
              <Delete size={24} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

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
    marginTop: 20,
  },
  lockIconContainer: {
    width: 68,
    height: 68,
    borderRadius: 22,
    backgroundColor: ui.surface,
    borderWidth: 0,
    borderColor: ui.border,
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
    gap: 20,
    marginTop: 36,
    marginBottom: 20,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: ui.border,
    backgroundColor: 'transparent',
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
    gap: 6,
    height: 24,
  },
  errorText: {
    color: ui.danger,
    fontSize: 12,
    fontWeight: '600',
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 24,
  },
  hintText: {
    color: ui.textMuted,
    fontSize: 11,
    fontWeight: '500',
  },
  keypadContainer: {
    width: '100%',
    maxWidth: 320,
    gap: 14,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 14,
  },
  keyButton: {
    flex: 1,
    height: 68,
    borderRadius: 14,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',

  },
  keyText: {
    fontSize: 26,
    fontWeight: '700',
    color: ui.text,
  },
  keyEmpty: {
    flex: 1,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDelete: {
    backgroundColor: ui.surfaceMuted,
  },
});
