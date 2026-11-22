import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Plus, Package, Edit2, Trash2 } from 'lucide-react-native';
import { SectionHeading } from '@/components/ui';
import { ui } from '@/lib/theme';
import type { ProductVariant } from '@/types';
import { productFormStyles as styles } from './productFormStyles';

export interface VariantsSectionProps {
  variants: ProductVariant[];
  branchId: string;
  onOpenNew: () => void;
  onOpenEdit: (variant: ProductVariant) => void;
  onRemove: (variantId: string) => void;
}

export const VariantsSection: React.FC<VariantsSectionProps> = React.memo(({
  variants,
  branchId,
  onOpenNew,
  onOpenEdit,
  onRemove,
}) => {
  return (
    <>
      <SectionHeading
        title="Variantes"
        subtitle="Opciones de talla, color o sabor con stock independiente."
        action={(
          <TouchableOpacity
            style={styles.addPresBtn}
            onPress={onOpenNew}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Agregar variante"
          >
            <Plus size={16} color={ui.onPrimary} />
            <Text style={styles.addPresBtnText}>Variante</Text>
          </TouchableOpacity>
        )}
      />

      {variants.length === 0 ? (
        <View style={styles.emptyPresCard}>
          <Package size={20} color={ui.textMuted} />
          <Text style={styles.emptyPresText}>
            Sin variantes configuradas. Se manejará stock único del producto.
          </Text>
        </View>
      ) : (
        <View style={styles.presList}>
          {variants.map((v) => {
            const vBranchStock = Number(v.stock?.[branchId] ?? 0);
            return (
              <View key={v.id} style={styles.presItemCard}>
                {v.colorHex ? (
                  <View style={[styles.variantDot, { backgroundColor: v.colorHex }]} />
                ) : null}
                <View style={styles.presItemInfo}>
                  <Text style={styles.presItemName}>
                    {v.name}
                    {v.sizeLabel ? ` (${v.sizeLabel})` : ''}
                  </Text>
                  <Text style={styles.presItemDetails}>
                    Stock ({branchId}): {vBranchStock}
                    {v.priceAdjustment
                      ? ` • Ajuste: ${v.priceAdjustment >= 0 ? '+' : ''}S/ ${v.priceAdjustment.toFixed(2)}`
                      : ''}
                    {v.sku ? ` • SKU: ${v.sku}` : ''}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity
                    onPress={() => onOpenEdit(v)}
                    style={styles.presEditBtn}
                  >
                    <Edit2 size={15} color={ui.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onRemove(v.id)}
                    style={styles.presDeleteBtn}
                  >
                    <Trash2 size={15} color={ui.danger} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </>
  );
});
