import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { CheckCircle2, Coins } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import { openCashSession } from '@/services/cash-register-service';
import { operationsStyles as styles } from './operationsStyles';
import type { OperationsUserProfileRef, OperationsUserRef } from './types';

export interface OpenCashCardProps {
  accountId?: string | null;
  branchId?: string | null;
  branchName: string;
  user: OperationsUserRef | null;
  userProfile?: OperationsUserProfileRef | null;
  onOpened: () => void;
}

export const OpenCashCard = React.memo<OpenCashCardProps>(({
  accountId,
  branchId,
  branchName,
  user,
  userProfile,
  onOpened,
}) => {
  const [openingBalanceInput, setOpeningBalanceInput] = useState<string>('');
  const [openingNotesInput, setOpeningNotesInput] = useState<string>('');
  const [isOpeningSession, setIsOpeningSession] = useState<boolean>(false);

  const handleOpenCash = useCallback(async () => {
    const cleanInput = openingBalanceInput.trim().replace(',', '.');
    const initialAmt = cleanInput === '' ? 0 : parseFloat(cleanInput);
    if (isNaN(initialAmt) || initialAmt < 0) {
      Alert.alert('Monto Inválido', 'Ingrese un fondo inicial en efectivo válido (mínimo S/ 0.00).');
      return;
    }

    if (!accountId || !branchId || !user) {
      Alert.alert('Error', 'Datos de sesión incompletos para abrir caja.');
      return;
    }

    setIsOpeningSession(true);
    try {
      await openCashSession({
        accountId,
        branchId,
        userId: user.uid,
        userName: userProfile?.displayName || user.email || 'Operador',
        openingBalance: initialAmt,
        notes: openingNotesInput.trim() || undefined,
      });

      setOpeningBalanceInput('');
      setOpeningNotesInput('');
      onOpened();
      Alert.alert(
        '¡Caja Abierta!',
        `Se abrió el turno exitosamente con un fondo inicial de ${formatPEN(initialAmt)}.`
      );
    } catch (err: any) {
      Alert.alert('Error al Abrir Caja', err?.message || 'No se pudo abrir la sesión de caja.');
    } finally {
      setIsOpeningSession(false);
    }
  }, [openingBalanceInput, openingNotesInput, accountId, branchId, user, userProfile?.displayName, onOpened]);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.iconBadge, styles.iconBadgeWarning]}>
          <Coins size={24} color={ui.warning} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.cardTitle}>Caja Cerrada</Text>
          <Text style={styles.cardSubtitle}>
            {branchName} — Turno sin iniciar
          </Text>
        </View>
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.label}>Fondo Inicial en Efectivo (S/)</Text>
        <TextInput
          style={styles.input}
          placeholder="0.00"
          placeholderTextColor={ui.textMuted}
          keyboardType="decimal-pad"
          value={openingBalanceInput}
          onChangeText={setOpeningBalanceInput}
        />
        <Text style={styles.helperText}>
          Ingrese el dinero en efectivo que hay en la gaveta para dar vuelto.
        </Text>
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.label}>Notas de Apertura (Opcional)</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline60]}
          placeholder="Ej. Billetes de S/10 y monedas"
          placeholderTextColor={ui.textMuted}
          multiline
          value={openingNotesInput}
          onChangeText={setOpeningNotesInput}
        />
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, isOpeningSession && styles.buttonDisabled]}
        onPress={handleOpenCash}
        disabled={isOpeningSession}
      >
        {isOpeningSession ? (
          <ActivityIndicator color={ui.onPrimary} />
        ) : (
          <>
            <CheckCircle2 size={20} color={ui.onPrimary} />
            <Text style={styles.primaryButtonText}>Abrir Turno de Caja</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
});
