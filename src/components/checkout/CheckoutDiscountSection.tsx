import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Tag } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';

export interface CheckoutDiscountSectionProps {
  itemsCount: number;
  cartSubtotal: number;
  discountAmount: number;
  shippingAmount: number;
  displayTotal: number;
  canEditDiscount: boolean;
  onApplyDiscount: (clampedAmount: number, nextTotal: number) => void;
}

/**
 * Total summary card & expandable manual global discount editor.
 * Typing the discount input stays local until Aplicar/Quitar is pressed.
 */
export const CheckoutDiscountSection = React.memo<CheckoutDiscountSectionProps>(({
  itemsCount,
  cartSubtotal,
  discountAmount,
  shippingAmount,
  displayTotal,
  canEditDiscount,
  onApplyDiscount,
}) => {
  const [discountInputStr, setDiscountInputStr] = useState<string>(
    discountAmount > 0 ? String(discountAmount) : ''
  );
  const [showDiscountEditor, setShowDiscountEditor] = useState<boolean>(false);

  useEffect(() => {
    setDiscountInputStr(discountAmount > 0 ? String(discountAmount) : '');
    setShowDiscountEditor(false);
  }, [discountAmount]);

  return (
    <>
      <View style={styles.checkoutTotalCardCompact}>
        <View style={{ flex: 1 }}>
          <Text style={styles.checkoutTotalLabelCompact}>Total a cobrar</Text>
          <Text style={styles.checkoutTotalItemsCompact}>
            {itemsCount} {itemsCount === 1 ? 'producto' : 'productos'}
            {discountAmount > 0 ? ` · Desc: -${formatPEN(discountAmount)}` : ''}
          </Text>
          {shippingAmount > 0 && (
            <Text style={styles.checkoutTotalItemsCompact}>
              Envío: {formatPEN(shippingAmount)}
            </Text>
          )}
          {canEditDiscount ? (
            <TouchableOpacity
              style={styles.discountTogglePill}
              onPress={() => {
                setDiscountInputStr(discountAmount > 0 ? String(discountAmount) : '');
                setShowDiscountEditor((prev) => !prev);
              }}
              accessibilityRole="button"
              accessibilityLabel={
                discountAmount > 0 ? 'Editar descuento global' : 'Agregar descuento global'
              }
            >
              <Tag size={12} color={ui.primary} />
              <Text style={styles.discountToggleText}>
                {discountAmount > 0 ? 'Editar descuento' : '+ Descuento'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <Text style={styles.checkoutTotalValueCompact}>{formatPEN(displayTotal)}</Text>
      </View>

      {showDiscountEditor ? (
        <View style={styles.discountEditorCard}>
          <Text style={styles.inputLabelCompact}>
            Descuento Global (S/) — Máx. {formatPEN(cartSubtotal)}
          </Text>
          <View style={styles.discountEditorRow}>
            <TextInput
              style={[styles.inputCompact, { flex: 1 }]}
              value={discountInputStr}
              onChangeText={setDiscountInputStr}
              placeholder="0.00"
              keyboardType="decimal-pad"
              placeholderTextColor={ui.textMuted}
              accessibilityLabel="Monto de descuento global en soles"
            />
            <TouchableOpacity
              style={styles.discountApplyBtn}
              onPress={() => {
                const parsed = parseFloat(discountInputStr.replace(',', '.')) || 0;
                const clamped = Math.min(
                  cartSubtotal,
                  Math.max(0, Math.round(parsed * 100) / 100)
                );
                const nextTotal = Math.max(
                  0,
                  Math.round((cartSubtotal - clamped + shippingAmount) * 100) / 100
                );
                onApplyDiscount(clamped, nextTotal);
                setShowDiscountEditor(false);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              accessibilityRole="button"
              accessibilityLabel="Aplicar descuento global"
            >
              <Text style={styles.discountApplyBtnText}>Aplicar</Text>
            </TouchableOpacity>
            {discountAmount > 0 ? (
              <TouchableOpacity
                style={[
                  styles.quickBillChip,
                  styles.quickBillChipClear,
                  { minHeight: 42, justifyContent: 'center' },
                ]}
                onPress={() => {
                  setDiscountInputStr('');
                  const nextTotal = Math.max(
                    0,
                    Math.round((cartSubtotal + shippingAmount) * 100) / 100
                  );
                  onApplyDiscount(0, nextTotal);
                  setShowDiscountEditor(false);
                }}
                accessibilityRole="button"
                accessibilityLabel="Quitar descuento global"
              >
                <Text style={[styles.quickBillText, styles.quickBillTextClear]}>Quitar</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  checkoutTotalCardCompact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    marginBottom: 10,
  },
  checkoutTotalLabelCompact: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  checkoutTotalItemsCompact: {
    fontSize: 10,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  checkoutTotalValueCompact: {
    fontSize: 22,
    fontWeight: '900',
    color: ui.primary,
  },
  discountTogglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  discountToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  discountEditorCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    marginBottom: 10,
  },
  discountEditorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
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
  discountApplyBtn: {
    paddingHorizontal: 14,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discountApplyBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.onPrimary,
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
  quickBillChipClear: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.dangerSoft,
  },
  quickBillText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  quickBillTextClear: {
    color: ui.danger,
  },
});
