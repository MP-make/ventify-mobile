import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import type { Branch } from '@/types';
import type { BranchPriceDraft } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

const EMPTY_BRANCH_DRAFT: BranchPriceDraft = {
  suggestedPrice: '',
  costPrice: '',
  minSalePrice: '',
};

interface BranchPriceRowProps {
  branchId: string;
  branchName: string;
  draft: BranchPriceDraft;
  onChangeField: (
    branchId: string,
    field: keyof BranchPriceDraft,
    value: string
  ) => void;
}

const BranchPriceRow = React.memo<BranchPriceRowProps>(({
  branchId,
  branchName,
  draft,
  onChangeField,
}) => {
  return (
    <View style={styles.branchPriceCard}>
      <Text style={styles.branchStockName}>{branchName}</Text>
      <View style={styles.branchPriceInputsRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="Venta (base)"
          keyboardType="decimal-pad"
          placeholderTextColor={ui.textMuted}
          value={draft.suggestedPrice}
          onChangeText={(txt) => onChangeField(branchId, 'suggestedPrice', txt)}
        />
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="Mín (base)"
          keyboardType="decimal-pad"
          placeholderTextColor={ui.textMuted}
          value={draft.minSalePrice}
          onChangeText={(txt) => onChangeField(branchId, 'minSalePrice', txt)}
        />
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="Costo (base)"
          keyboardType="decimal-pad"
          placeholderTextColor={ui.textMuted}
          value={draft.costPrice}
          onChangeText={(txt) => onChangeField(branchId, 'costPrice', txt)}
        />
      </View>
    </View>
  );
});

export interface BranchPricingSectionProps {
  branches: Branch[] | undefined;
  branchPricesDraft: Record<string, BranchPriceDraft>;
  initialExpanded: boolean;
  formSessionKey: number;
  onChangeField: (
    branchId: string,
    field: keyof BranchPriceDraft,
    value: string
  ) => void;
}

export const BranchPricingSection: React.FC<BranchPricingSectionProps> = React.memo(({
  branches,
  branchPricesDraft,
  initialExpanded,
  formSessionKey,
  onChangeField,
}) => {
  const [expanded, setExpanded] = useState(initialExpanded);

  useEffect(() => {
    setExpanded(initialExpanded);
  }, [formSessionKey, initialExpanded]);

  const handleToggle = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  if (!branches || branches.length <= 1) return null;

  return (
    <View style={styles.sectionCard}>
      <TouchableOpacity style={styles.collapsibleHeader} onPress={handleToggle}>
        <Text style={styles.sectionCardTitle}>Precios por Sucursal (Opcional)</Text>
        {expanded ? (
          <ChevronUp size={18} color={ui.textSecondary} />
        ) : (
          <ChevronDown size={18} color={ui.textSecondary} />
        )}
      </TouchableOpacity>
      {expanded && (
        <View style={{ marginTop: 10, gap: 10 }}>
          {branches.map((b, idx) => {
            const bId = b.id || `branch_${idx}`;
            return (
              <BranchPriceRow
                key={bId}
                branchId={bId}
                branchName={b.name || bId}
                draft={branchPricesDraft[bId] || EMPTY_BRANCH_DRAFT}
                onChangeField={onChangeField}
              />
            );
          })}
        </View>
      )}
    </View>
  );
});
