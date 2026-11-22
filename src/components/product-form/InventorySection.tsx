import React from 'react';
import { View, Text, TextInput } from 'react-native';
import { ui } from '@/lib/theme';
import type { Branch } from '@/types';
import { productFormStyles as styles } from './productFormStyles';

export interface InventorySectionProps {
  branches: Branch[] | undefined;
  branchId: string;
  unitOfMeasure: string;
  allowDecimals: boolean;
  hasVariants: boolean;
  stockStr: string;
  minStockStr: string;
  stockByBranch: Record<string, number>;
  compactLayout: boolean;
  onChangeStock: (val: string) => void;
  onChangeMinStock: (val: string) => void;
  onChangeBranchStock: (branchId: string, val: string) => void;
}

export const InventorySection: React.FC<InventorySectionProps> = React.memo(({
  branches,
  branchId,
  unitOfMeasure,
  allowDecimals,
  hasVariants,
  stockStr,
  minStockStr,
  stockByBranch,
  compactLayout,
  onChangeStock,
  onChangeMinStock,
  onChangeBranchStock,
}) => {
  const isMultiBranch = Boolean(branches && branches.length > 1);
  const keyboard = allowDecimals ? 'decimal-pad' : 'numeric';

  return (
    <>
      {hasVariants && (
        <View style={styles.infoBanner}>
          <Text style={styles.infoBannerText}>
            Este producto tiene variantes. El stock de la sucursal activa se calcula sumando tus variantes ({stockStr} u.).
          </Text>
        </View>
      )}

      {isMultiBranch && branches ? (
        <View style={styles.formGroup}>
          <Text style={styles.label}>Stock por Sucursal ({unitOfMeasure})</Text>
          <View style={styles.branchStockList}>
            {branches.map((b, idx) => {
              const bId = b.id || `branch_${idx}`;
              return (
                <View key={bId} style={styles.branchStockRow}>
                  <Text style={styles.branchStockName} numberOfLines={1}>
                    {b.name || 'Sucursal'}
                  </Text>
                  <TextInput
                    style={styles.branchStockInput}
                    value={stockByBranch[bId] !== undefined ? String(stockByBranch[bId]) : ''}
                    onChangeText={(val) => onChangeBranchStock(bId, val)}
                    editable={!(hasVariants && bId === branchId)}
                    keyboardType={keyboard}
                    placeholder="0"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              );
            })}
          </View>
          <View style={[styles.formGroup, { marginTop: 10 }]}>
            <Text style={styles.label}>Alerta Stock Mínimo</Text>
            <TextInput
              style={styles.input}
              value={minStockStr}
              onChangeText={onChangeMinStock}
              accessibilityLabel="Alerta de stock mínimo"
              placeholder="3"
              keyboardType={keyboard}
              placeholderTextColor={ui.textMuted}
            />
          </View>
        </View>
      ) : (
        <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
          <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
            <Text style={styles.label}>Stock Actual ({unitOfMeasure})</Text>
            <TextInput
              style={[styles.input, hasVariants && styles.inputReadonly]}
              value={stockStr}
              onChangeText={onChangeStock}
              editable={!hasVariants}
              accessibilityLabel={`Stock actual en ${unitOfMeasure}`}
              placeholder="0"
              keyboardType={keyboard}
              placeholderTextColor={ui.textMuted}
            />
          </View>
          <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
            <Text style={styles.label}>Alerta Stock Mínimo</Text>
            <TextInput
              style={styles.input}
              value={minStockStr}
              onChangeText={onChangeMinStock}
              accessibilityLabel="Alerta de stock mínimo"
              placeholder="3"
              keyboardType={keyboard}
              placeholderTextColor={ui.textMuted}
            />
          </View>
        </View>
      )}
    </>
  );
});
