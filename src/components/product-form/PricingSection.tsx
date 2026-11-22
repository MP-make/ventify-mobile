import React, { useMemo } from 'react';
import { View, Text, TextInput } from 'react-native';
import { Percent } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import { productFormStyles as styles } from './productFormStyles';

export interface PricingSectionProps {
  priceStr: string;
  minPriceStr: string;
  costStr: string;
  canViewMargins: boolean;
  compactLayout: boolean;
  onChangePrice: (val: string) => void;
  onChangeMinPrice: (val: string) => void;
  onChangeCost: (val: string) => void;
}

export const PricingSection: React.FC<PricingSectionProps> = React.memo(({
  priceStr,
  minPriceStr,
  costStr,
  canViewMargins,
  compactLayout,
  onChangePrice,
  onChangeMinPrice,
  onChangeCost,
}) => {
  const marginCalculation = useMemo(() => {
    const priceVal = parseFloat(priceStr) || 0;
    const costVal = parseFloat(costStr) || 0;
    if (priceVal <= 0) return { profit: 0, pct: 0, status: 'empty' as const };
    const profit = priceVal - costVal;
    const pct = costVal > 0 ? (profit / costVal) * 100 : 100;
    let status: 'healthy' | 'moderate' | 'loss' = 'healthy';
    if (profit < 0) status = 'loss';
    else if (pct < 15) status = 'moderate';
    return { profit, pct, status };
  }, [priceStr, costStr]);

  return (
    <>
      <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
        <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
          <Text style={styles.label}>
            Precio Venta (S/) <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={[styles.input, styles.priceInputHighlight]}
            value={priceStr}
            onChangeText={onChangePrice}
            accessibilityLabel="Precio de venta en soles, obligatorio"
            placeholder="0.00"
            keyboardType="decimal-pad"
            placeholderTextColor={ui.textMuted}
          />
        </View>
        <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
          <Text style={styles.label}>Precio Mínimo (S/)</Text>
          <TextInput
            style={styles.input}
            value={minPriceStr}
            onChangeText={onChangeMinPrice}
            accessibilityLabel="Precio mínimo de venta en soles"
            placeholder="Piso de venta"
            keyboardType="decimal-pad"
            placeholderTextColor={ui.textMuted}
          />
        </View>
      </View>

      <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
        <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
          <Text style={styles.label}>Costo Compra (S/)</Text>
          <TextInput
            style={styles.input}
            value={costStr}
            onChangeText={onChangeCost}
            accessibilityLabel="Costo de compra en soles"
            placeholder="0.00"
            keyboardType="decimal-pad"
            placeholderTextColor={ui.textMuted}
          />
        </View>
        {canViewMargins ? (
          <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
            <Text style={styles.label}>Margen Estimado</Text>
            <View
              style={[
                styles.marginBadge,
                marginCalculation.status === 'healthy' && styles.marginBadgeGreen,
                marginCalculation.status === 'moderate' && styles.marginBadgeAmber,
                marginCalculation.status === 'loss' && styles.marginBadgeRed,
              ]}
            >
              <Percent size={14} color={ui.text} />
              <Text style={styles.marginBadgeText}>
                {marginCalculation.pct.toFixed(1)}% (S/ {marginCalculation.profit.toFixed(2)})
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </>
  );
});
