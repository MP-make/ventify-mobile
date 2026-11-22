import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Plus, Trash2 } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import type { PriceTier } from '@/types';
import { productFormStyles as styles } from './productFormStyles';

export interface PriceTiersSectionProps {
  priceTiers: PriceTier[];
  formSessionKey: number;
  onAddTier: (minQty: number, unitPrice: number) => void;
  onRemoveTier: (index: number) => void;
}

export const PriceTiersSection: React.FC<PriceTiersSectionProps> = React.memo(({
  priceTiers,
  formSessionKey,
  onAddTier,
  onRemoveTier,
}) => {
  const [tierMinQtyStr, setTierMinQtyStr] = useState('');
  const [tierPriceStr, setTierPriceStr] = useState('');

  useEffect(() => {
    setTierMinQtyStr('');
    setTierPriceStr('');
  }, [formSessionKey]);

  const handleAdd = useCallback(() => {
    const minQty = parseFloat(tierMinQtyStr);
    const tierPrice = parseFloat(tierPriceStr);
    if (!Number.isFinite(minQty) || minQty < 2 || !Number.isFinite(tierPrice) || tierPrice <= 0) {
      Alert.alert('Escala inválida', 'Ingresa cantidad mínima (>= 2) y precio unitario mayor a S/ 0.00.');
      return;
    }
    onAddTier(minQty, tierPrice);
    setTierMinQtyStr('');
    setTierPriceStr('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [tierMinQtyStr, tierPriceStr, onAddTier]);

  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionCardTitle}>Precios por Volumen (Opcional)</Text>
      <View style={styles.inlineAddRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={tierMinQtyStr}
          onChangeText={setTierMinQtyStr}
          placeholder="Mín. cant. (ej. 6)"
          keyboardType="numeric"
          placeholderTextColor={ui.textMuted}
        />
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={tierPriceStr}
          onChangeText={setTierPriceStr}
          placeholder="Precio c/u (S/)"
          keyboardType="decimal-pad"
          placeholderTextColor={ui.textMuted}
        />
        <TouchableOpacity
          style={styles.inlineAddBtn}
          onPress={handleAdd}
          accessibilityRole="button"
          accessibilityLabel="Agregar escala de precio"
        >
          <Plus size={18} color={ui.onPrimary} />
        </TouchableOpacity>
      </View>

      {priceTiers.length > 0 && (
        <View style={{ marginTop: 8, gap: 6 }}>
          {priceTiers.map((tier, idx) => (
            <View key={`${tier.minQuantity}-${idx}`} style={styles.presItemCard}>
              <Text style={styles.presItemDetails}>
                Desde <Text style={{ fontWeight: '700', color: ui.text }}>{tier.minQuantity}</Text> u.:{' '}
                <Text style={{ fontWeight: '700', color: ui.primary }}>
                  S/ {Number(tier.unitPrice ?? tier.price).toFixed(2)}
                </Text>{' '}
                c/u
              </Text>
              <TouchableOpacity onPress={() => onRemoveTier(idx)} style={styles.presDeleteBtn}>
                <Trash2 size={15} color={ui.danger} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </View>
  );
});
