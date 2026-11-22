import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { AlertCircle, CheckCircle2 } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';

export interface CheckoutCashSectionProps {
  amountToCollect: number;
  cashSyncSignal: { value: number; seq: number };
  cashReceivedRef: React.MutableRefObject<number>;
  onCashSufficientChange: (sufficient: boolean) => void;
}

const QUICK_BILLS = [20, 50, 100] as const;

/**
 * Self-contained cash received & change section so typing cash digits
 * never re-renders the parent CheckoutModal unless sufficiency flips.
 */
export const CheckoutCashSection = React.memo<CheckoutCashSectionProps>(({
  amountToCollect,
  cashSyncSignal,
  cashReceivedRef,
  onCashSufficientChange,
}) => {
  const [cashStr, setCashStr] = useState<string>(
    cashSyncSignal.value > 0 ? String(cashSyncSignal.value) : ''
  );

  useEffect(() => {
    const val = cashSyncSignal.value;
    setCashStr(val > 0 ? String(val) : '');
    cashReceivedRef.current = val;
  }, [cashSyncSignal.seq, cashSyncSignal.value, cashReceivedRef]);

  const numericCash = parseFloat(cashStr.replace(',', '.')) || 0;
  cashReceivedRef.current = numericCash;

  const isSufficient = numericCash >= amountToCollect;
  useEffect(() => {
    onCashSufficientChange(isSufficient);
  }, [isSufficient, onCashSufficientChange]);

  const cashChange = Math.max(0, numericCash - amountToCollect);
  const cashShortage = Math.max(0, amountToCollect - numericCash);

  const handleSetNumeric = (val: number) => {
    setCashStr(val > 0 ? String(val) : '');
    cashReceivedRef.current = val;
  };

  return (
    <View style={styles.paymentDetailBox}>
      <Text style={styles.inputLabelCompact}>Monto Recibido</Text>
      <TextInput
        style={[styles.inputCompact, styles.cashReceivedInput]}
        accessibilityLabel="Monto recibido en soles"
        value={cashStr}
        onChangeText={setCashStr}
        placeholder="0.00"
        keyboardType="decimal-pad"
        placeholderTextColor={ui.textMuted}
      />

      {/* Chips de billetes rápidos */}
      <View style={styles.quickBillsRow}>
        <TouchableOpacity
          style={[
            styles.quickBillChip,
            Math.abs(numericCash - amountToCollect) < 0.01 && styles.quickBillChipActive,
          ]}
          onPress={() => handleSetNumeric(amountToCollect)}
          accessibilityRole="button"
          accessibilityLabel={`Recibir monto exacto, ${formatPEN(amountToCollect)}`}
        >
          <Text
            style={[
              styles.quickBillText,
              Math.abs(numericCash - amountToCollect) < 0.01 && styles.quickBillTextActive,
            ]}
          >
            Exacto
          </Text>
        </TouchableOpacity>
        {QUICK_BILLS.map((bill) => (
          <TouchableOpacity
            key={bill}
            style={[styles.quickBillChip, numericCash === bill && styles.quickBillChipActive]}
            onPress={() => handleSetNumeric(bill)}
            accessibilityRole="button"
            accessibilityLabel={`Recibir ${formatPEN(bill)}`}
          >
            <Text style={[styles.quickBillText, numericCash === bill && styles.quickBillTextActive]}>
              S/ {bill}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.quickBillChip, styles.quickBillChipClear]}
          onPress={() => handleSetNumeric(0)}
          accessibilityRole="button"
          accessibilityLabel="Limpiar monto recibido"
        >
          <Text style={[styles.quickBillText, styles.quickBillTextClear]}>Limpiar</Text>
        </TouchableOpacity>
      </View>

      {/* Vuelto en tiempo real */}
      <View style={styles.changeDisplayRow}>
        {cashShortage > 0 ? (
          <View style={styles.shortageBadge}>
            <AlertCircle size={18} color={ui.danger} />
            <Text style={styles.shortageText}>
              Faltan: {formatPEN(cashShortage)}
            </Text>
          </View>
        ) : (
          <View style={styles.changeBadge}>
            <CheckCircle2 size={20} color={ui.primary} />
            <View>
              <Text style={styles.changeLabel}>Vuelto al Cliente:</Text>
              <Text style={styles.changeAmountText}>{formatPEN(cashChange)}</Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  paymentDetailBox: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    marginBottom: 16,
  },
  inputLabelCompact: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 3,
  },
  inputCompact: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: ui.text,
  },
  cashReceivedInput: {
    fontSize: 20,
    fontWeight: '700',
    color: ui.text,
    textAlign: 'center',
    backgroundColor: ui.background,
    borderColor: ui.primary,
  },
  quickBillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  quickBillChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  quickBillChipActive: {
    backgroundColor: ui.text,
    borderColor: ui.text,
  },
  quickBillChipClear: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.dangerSoft,
  },
  quickBillText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  quickBillTextActive: {
    color: ui.surface,
  },
  quickBillTextClear: {
    color: ui.danger,
  },
  changeDisplayRow: {
    marginTop: 14,
  },
  changeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: ui.successSoft,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.successSoft,
  },
  changeLabel: {
    fontSize: 12,
    color: ui.success,
    fontWeight: '500',
  },
  changeAmountText: {
    fontSize: 22,
    fontWeight: '800',
    color: ui.success,
  },
  shortageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.dangerSoft,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.dangerSoft,
  },
  shortageText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.danger,
  },
});
