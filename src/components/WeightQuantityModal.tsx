import React, { useState, useEffect, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Scale, X, Check, Delete, DollarSign } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { Product } from '@/types';
import { formatPEN, ui } from '@/lib/theme';
import { ScreenHeading } from '@/components/ui';

export interface WeightQuantityModalProps {
  product: Product | null;
  visible?: boolean;
  isOpen?: boolean; // Soporte para ambas convenciones de props
  onClose: () => void;
  onConfirm: (product: Product, quantity: number, customPrice?: number) => void;
}

export const WeightQuantityModal: React.FC<WeightQuantityModalProps> = ({
  product,
  visible,
  isOpen,
  onClose,
  onConfirm,
}) => {
  const insets = useSafeAreaInsets();
  const isModalVisible = visible !== undefined ? visible : Boolean(isOpen);

  // Modo: 'weight' (escribir kg/fracción) o 'amount' (escribir importe en Soles)
  const [entryMode, setEntryMode] = useState<'weight' | 'amount'>('weight');
  const [valueString, setValueString] = useState<string>('1.000');

  useEffect(() => {
    if (isModalVisible) {
      setEntryMode('weight');
      setValueString('1.000');
    }
  }, [isModalVisible]);

  if (!isModalVisible || !product) return null;

  const unitPrice = Number(product.suggestedPrice ?? product.price ?? 0);
  const unitLabel = product.unitOfMeasure || 'kg';

  // Cálculos reactivos según el modo de entrada
  const { calculatedWeight, calculatedSubtotal } = useMemo(() => {
    const rawVal = parseFloat(valueString) || 0;

    if (entryMode === 'weight') {
      const weight = Math.max(0, rawVal);
      const subtotal = Math.round(weight * unitPrice * 100) / 100;
      return { calculatedWeight: weight, calculatedSubtotal: subtotal };
    } else {
      // Modo por dinero ("Quiero S/ 5.00 de queso")
      const money = Math.max(0, rawVal);
      const weight = unitPrice > 0 ? Math.round((money / unitPrice) * 1000) / 1000 : 0;
      return { calculatedWeight: weight, calculatedSubtotal: money };
    }
  }, [valueString, entryMode, unitPrice]);

  const handleDigit = (digit: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

    if (digit === '.' && valueString.includes('.')) return;

    if (valueString === '0' && digit !== '.') {
      setValueString(digit);
      return;
    }

    if (valueString.length < 8) {
      setValueString((prev) => prev + digit);
    }
  };

  const handleDelete = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setValueString((prev) => (prev.length > 1 ? prev.slice(0, -1) : '0'));
  };

  const handlePreset = (presetWeight: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setEntryMode('weight');
    setValueString(presetWeight.toFixed(3));
  };

  const handleConfirm = () => {
    if (calculatedWeight > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onConfirm(product, calculatedWeight);
      onClose();
    }
  };

  return (
    <Modal
      visible={isModalVisible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View
          style={[
            styles.sheetContainer,
            { paddingBottom: Math.max(insets.bottom, 20) },
          ]}
        >
          <View style={styles.headingWrap}>
            <ScreenHeading
              title={product.name}
              subtitle={`${formatPEN(unitPrice)} por ${unitLabel.toUpperCase()}`}
              action={(
                <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Cerrar cantidad y peso">
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              )}
            />
          </View>

          <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
          {/* Selector de Modo: Por Peso vs Por Importe S/ */}
          <View style={styles.modeTabs}>
            <TouchableOpacity
              onPress={() => {
                setEntryMode('weight');
                setValueString('1.000');
              }}
              style={[
                styles.modeTab,
                entryMode === 'weight' && styles.modeTabActive,
              ]}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`Ingresar por cantidad, ${unitLabel}`}
              accessibilityState={{ selected: entryMode === 'weight' }}
            >
              <Scale
                size={14}
                color={entryMode === 'weight' ? ui.primary : ui.textMuted}
              />
              <Text
                style={[
                  styles.modeTabText,
                  entryMode === 'weight' && styles.modeTabTextActive,
                ]}
              >
                Por Cantidad / {unitLabel.toUpperCase()}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                setEntryMode('amount');
                setValueString('5.00');
              }}
              style={[
                styles.modeTab,
                entryMode === 'amount' && styles.modeTabActive,
              ]}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Ingresar por importe en soles"
              accessibilityState={{ selected: entryMode === 'amount' }}
            >
              <DollarSign
                size={14}
                color={entryMode === 'amount' ? ui.primary : ui.textMuted}
              />
              <Text
                style={[
                  styles.modeTabText,
                  entryMode === 'amount' && styles.modeTabTextActive,
                ]}
              >
                Por Importe en Soles
              </Text>
            </TouchableOpacity>
          </View>

          {/* Display de Cálculo Interactivo */}
          <View style={styles.displayCard}>
            <Text style={styles.displayLabel}>
              {entryMode === 'weight'
                ? `CANTIDAD (${unitLabel.toUpperCase()})`
                : 'IMPORTE EN SOLES (S/)'}
            </Text>

            <View style={styles.displayValueRow}>
              {entryMode === 'amount' && (
                <Text style={styles.displayCurrencySymbol}>S/</Text>
              )}
              <Text style={styles.displayValue}>{valueString}</Text>
              {entryMode === 'weight' && (
                <Text style={styles.displayUnitLabel}>
                  {unitLabel.toUpperCase()}
                </Text>
              )}
            </View>

            {/* Resultado complementario inverso */}
            <View style={styles.displaySummaryRow}>
              <Text style={styles.summarySubtotal}>
                Total: {formatPEN(calculatedSubtotal)}
              </Text>
              <Text style={styles.summaryEquivalent}>
                ≈ {calculatedWeight.toFixed(3)} {unitLabel}
              </Text>
            </View>
          </View>

          {/* Chips Rápidos de Peso */}
          <View style={styles.presetChips}>
            {[
              { label: '100g (0.10)', val: 0.1 },
              { label: '250g (0.25)', val: 0.25 },
              { label: '500g (0.50)', val: 0.5 },
              { label: '1 Kg (1.0)', val: 1.0 },
              { label: '1.5 Kg', val: 1.5 },
              { label: '2 Kg', val: 2.0 },
            ].map((chip) => (
              <TouchableOpacity
                key={chip.label}
                onPress={() => handlePreset(chip.val)}
                style={styles.chipButton}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Usar ${chip.label}`}
              >
                <Text style={styles.chipText}>{chip.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Teclado Numérico Táctil */}
          <View style={styles.keypad}>
            <View style={styles.keyRow}>
              {['1', '2', '3'].map((d) => (
                <TouchableOpacity
                  key={d}
                  onPress={() => handleDigit(d)}
                  style={styles.numKey}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Número ${d}`}
                >
                  <Text style={styles.numKeyText}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.keyRow}>
              {['4', '5', '6'].map((d) => (
                <TouchableOpacity
                  key={d}
                  onPress={() => handleDigit(d)}
                  style={styles.numKey}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Número ${d}`}
                >
                  <Text style={styles.numKeyText}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.keyRow}>
              {['7', '8', '9'].map((d) => (
                <TouchableOpacity
                  key={d}
                  onPress={() => handleDigit(d)}
                  style={styles.numKey}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Número ${d}`}
                >
                  <Text style={styles.numKeyText}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.keyRow}>
              <TouchableOpacity
                onPress={() => handleDigit('.')}
                style={styles.numKey}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Separador decimal"
              >
                <Text style={styles.numKeyText}>.</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleDigit('0')}
                style={styles.numKey}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Número cero"
              >
                <Text style={styles.numKeyText}>0</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleDelete}
                style={[styles.numKey, styles.deleteKey]}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Borrar último dígito"
              >
                <Delete size={22} color="#9CA3AF" />
              </TouchableOpacity>
            </View>
          </View>
          </ScrollView>

          {/* Botón de Confirmación */}
          <TouchableOpacity
            onPress={handleConfirm}
            disabled={calculatedWeight <= 0}
            style={[
              styles.confirmButton,
              calculatedWeight <= 0 && styles.confirmButtonDisabled,
            ]}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Agregar ${calculatedWeight.toFixed(3)} ${unitLabel} por ${formatPEN(calculatedSubtotal)}`}
            accessibilityState={{ disabled: calculatedWeight <= 0 }}
          >
            <Check size={18} color={ui.onPrimary} style={{ marginRight: 6 }} />
            <Text style={styles.confirmButtonText}>
              Agregar {formatPEN(calculatedSubtotal)} ({calculatedWeight.toFixed(3)} {unitLabel})
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.35)', justifyContent: 'flex-end' },
  sheetContainer: {
    backgroundColor: ui.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderColor: ui.border, padding: 20, width: '100%', maxHeight: '95%',
  },
  headingWrap: {
    marginHorizontal: -20, marginTop: -20, borderBottomWidth: 1,
    borderBottomColor: ui.border, marginBottom: 12,
  },
  bodyScroll: { flexShrink: 1 },
  bodyContent: { paddingBottom: 12 },
  closeButton: {
    width: 48, height: 48, borderRadius: 12, backgroundColor: ui.surfaceMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  modeTabs: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 12 },
  modeTab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, minHeight: 52, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 12, backgroundColor: ui.surfaceMuted, borderWidth: 1, borderColor: ui.border,
  },
  modeTabActive: { backgroundColor: ui.primarySoft, borderColor: ui.primary },
  modeTabText: { fontSize: 13, fontWeight: '600', color: ui.textSecondary, flexShrink: 1 },
  modeTabTextActive: { color: ui.primary, fontWeight: '700' },
  displayCard: {
    backgroundColor: ui.primarySoft, borderRadius: 16, borderWidth: 1,
    borderColor: ui.primarySoft, padding: 18, alignItems: 'center', marginBottom: 12,
  },
  displayLabel: { fontSize: 12, fontWeight: '700', color: ui.textSecondary },
  displayValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginVertical: 4 },
  displayCurrencySymbol: { fontSize: 22, fontWeight: '800', color: ui.primary },
  displayValue: { fontSize: 32, fontWeight: '800', color: ui.text, letterSpacing: -0.5 },
  displayUnitLabel: { fontSize: 14, fontWeight: '700', color: ui.textSecondary },
  displaySummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  summarySubtotal: { fontSize: 16, fontWeight: '700', color: ui.text },
  summaryEquivalent: { fontSize: 13, fontWeight: '500', color: ui.textSecondary },
  presetChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chipButton: {
    minHeight: 48, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 10, backgroundColor: ui.surface, borderWidth: 1, borderColor: ui.border,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: ui.textSecondary },
  keypad: { gap: 8, marginBottom: 16 },
  keyRow: { flexDirection: 'row', gap: 8 },
  numKey: {
    flex: 1, height: 56, borderRadius: 12, backgroundColor: ui.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: ui.border,
  },
  deleteKey: { backgroundColor: ui.surfaceMuted },
  numKeyText: { fontSize: 20, fontWeight: '700', color: ui.text },
  confirmButton: {
    flexDirection: 'row', minHeight: 52, borderRadius: 14, backgroundColor: ui.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  confirmButtonDisabled: { backgroundColor: ui.textMuted },
  confirmButtonText: { fontSize: 15, fontWeight: '700', color: ui.onPrimary },
});
