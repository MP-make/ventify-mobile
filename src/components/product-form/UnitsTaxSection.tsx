import React from 'react';
import { View, Text, TouchableOpacity, Switch } from 'react-native';
import { ui } from '@/lib/theme';
import { UNITS, TAX_CODES } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

export interface UnitsTaxSectionProps {
  unitOfMeasure: string;
  allowDecimals: boolean;
  taxExemptionCode: '10' | '20' | '30';
  onSelectUnit: (code: string) => void;
  onToggleDecimals: (val: boolean) => void;
  onSelectTaxCode: (code: '10' | '20' | '30') => void;
}

export const UnitsTaxSection: React.FC<UnitsTaxSectionProps> = React.memo(({
  unitOfMeasure,
  allowDecimals,
  taxExemptionCode,
  onSelectUnit,
  onToggleDecimals,
  onSelectTaxCode,
}) => {
  return (
    <>
      <View style={styles.formGroup}>
        <Text style={styles.label}>Unidad de Medida (Estándar SUNAT)</Text>
        <View style={styles.unitsGrid}>
          {UNITS.map((u) => {
            const isSelected = unitOfMeasure === u.code;
            return (
              <TouchableOpacity
                key={u.code}
                style={[styles.unitCard, isSelected && styles.unitCardSelected]}
                onPress={() => onSelectUnit(u.code)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${u.label}. ${u.desc}`}
              >
                <Text style={[styles.unitCodeText, isSelected && styles.unitCodeTextSelected]}>
                  {u.label}
                </Text>
                <Text style={styles.unitDescText}>{u.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.toggleRowCard}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={styles.toggleRowTitle}>Permitir cantidades decimales / peso</Text>
          <Text style={styles.toggleRowSubtitle}>
            Activa para vender fracciones (ej. 0.250 kg o 1.5 lt) en el POS.
          </Text>
        </View>
        <Switch
          value={allowDecimals}
          onValueChange={onToggleDecimals}
          trackColor={{ false: ui.border, true: ui.primarySoft }}
          thumbColor={allowDecimals ? ui.primary : ui.surface}
        />
      </View>

      <View style={styles.formGroup}>
        <Text style={styles.label}>Afectación IGV (SUNAT)</Text>
        <View style={styles.taxGrid}>
          {TAX_CODES.map((tc) => {
            const isSelected = taxExemptionCode === tc.code;
            return (
              <TouchableOpacity
                key={tc.code}
                style={[styles.taxChip, isSelected && styles.taxChipSelected]}
                onPress={() => onSelectTaxCode(tc.code)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
              >
                <Text style={[styles.taxChipLabel, isSelected && styles.taxChipLabelSelected]}>
                  {tc.label}
                </Text>
                <Text style={styles.taxChipDesc}>{tc.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </>
  );
});
