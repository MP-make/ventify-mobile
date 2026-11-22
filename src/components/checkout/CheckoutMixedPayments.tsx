import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Plus, Trash2 } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import {
  DEFAULT_MIXED_SPLIT_OPTIONS,
  type MixedSplitOption,
  type MixedSplitRow,
} from './checkout-types';

export interface CheckoutMixedPaymentsProps {
  mixedSplits: MixedSplitRow[];
  splitOptions: MixedSplitOption[];
  onChangeSplit: (id: string, patch: Partial<MixedSplitRow>) => void;
  onAddSplit: () => void;
  onRemoveSplit: (id: string) => void;
  onFillRemaining: (id: string) => void;
  mixedAllocation: { assigned: number; pending: number; isExact: boolean };
  safeTotal: number;
}

export const CheckoutMixedPayments = React.memo<CheckoutMixedPaymentsProps>(({
  mixedSplits,
  splitOptions,
  onChangeSplit,
  onAddSplit,
  onRemoveSplit,
  onFillRemaining,
  mixedAllocation,
  safeTotal,
}) => {
  const effectiveOptions = splitOptions.length > 0 ? splitOptions : DEFAULT_MIXED_SPLIT_OPTIONS;
  return (
    <View style={styles.paymentDetailBox}>
      <View style={styles.mixedHeaderRow}>
        <Text style={styles.mixedBoxTitle}>Desglose de Pago Mixto ({mixedSplits.length})</Text>
        {mixedSplits.length < 5 ? (
          <TouchableOpacity
            style={styles.mixedAddBtn}
            onPress={onAddSplit}
            accessibilityRole="button"
            accessibilityLabel="Agregar método de pago"
          >
            <Plus size={13} color={ui.primary} />
            <Text style={styles.mixedAddBtnText}>Agregar medio</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {mixedSplits.map((row, idx) => {
        const activeKey =
          row.methodId ||
          (row.category === 'digital' ? row.digitalProvider || 'yape' : row.category);
        return (
          <View key={row.id} style={styles.mixedSplitCard}>
            <View style={styles.mixedSplitTopRow}>
              <Text style={styles.mixedSplitIndex}>Parte {idx + 1}</Text>
              <View style={styles.mixedSplitTopActions}>
                {mixedAllocation.pending > 0.01 ? (
                  <TouchableOpacity
                    style={styles.mixedFillBtn}
                    onPress={() => onFillRemaining(row.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Completar saldo restante en parte ${idx + 1}`}
                  >
                    <Text style={styles.mixedFillBtnText}>
                      + Saldo ({formatPEN(mixedAllocation.pending)})
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {mixedSplits.length > 1 ? (
                  <TouchableOpacity
                    onPress={() => onRemoveSplit(row.id)}
                    style={styles.mixedRemoveBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Quitar parte ${idx + 1}`}
                    hitSlop={6}
                  >
                    <Trash2 size={15} color={ui.danger} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <View style={styles.mixedProviderRow}>
              {effectiveOptions.map((opt) => {
                const selected =
                  activeKey === opt.key ||
                  (opt.methodId && row.methodId === opt.methodId) ||
                  (!row.methodId &&
                    (opt.digitalProvider
                      ? row.category === 'digital' && row.digitalProvider === opt.digitalProvider
                      : row.category === opt.category));
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.providerChip,
                      selected && styles.providerChipActive,
                    ]}
                    onPress={() =>
                      onChangeSplit(row.id, {
                        methodId: opt.methodId,
                        category: opt.category,
                        digitalProvider: opt.digitalProvider,
                      })
                    }
                    accessibilityRole="button"
                    accessibilityState={{ selected: Boolean(selected) }}
                  >
                    <Text
                      style={[
                        styles.providerChipText,
                        selected && styles.providerChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.mixedAmountInputRow}>
              <Text style={styles.mixedCurrencyPrefix}>S/</Text>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                accessibilityLabel={`Monto parte ${idx + 1}`}
                value={row.amountStr}
                onChangeText={(val) => onChangeSplit(row.id, { amountStr: val })}
                placeholder="0.00"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>
        );
      })}

      {/* Balance Mixto */}
      <View style={styles.mixedBalanceRow}>
        <Text style={styles.mixedBalanceText}>
          Asignado: {formatPEN(mixedAllocation.assigned)} / Total: {formatPEN(safeTotal)}
        </Text>
        {mixedAllocation.isExact ? (
          <Text style={styles.mixedExactText}>¡Cuadre exacto!</Text>
        ) : (
          <Text style={styles.mixedPendingText}>
            {mixedAllocation.pending >= 0
              ? `Falta: ${formatPEN(mixedAllocation.pending)}`
              : `Exceso: ${formatPEN(Math.abs(mixedAllocation.pending))}`}
          </Text>
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
  mixedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  mixedBoxTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 8,
  },
  mixedAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  mixedAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  mixedSplitCard: {
    padding: 10,
    borderRadius: 12,
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    marginBottom: 10,
    gap: 8,
  },
  mixedSplitTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mixedSplitIndex: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  mixedSplitTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mixedFillBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: ui.successSoft,
  },
  mixedFillBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.success,
  },
  mixedRemoveBtn: {
    padding: 4,
  },
  mixedProviderRow: {
    flexDirection: 'row',
    gap: 6,
  },
  providerChip: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 8,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    alignItems: 'center',
  },
  providerChipActive: {
    backgroundColor: ui.primary,
  },
  providerChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  providerChipTextActive: {
    color: ui.surface,
  },
  mixedAmountInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mixedCurrencyPrefix: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  input: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 11,
    fontSize: 16,
    color: ui.text,
  },
  mixedBalanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.surfaceMuted,
  },
  mixedBalanceText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  mixedExactText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  mixedPendingText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.danger,
  },
});
