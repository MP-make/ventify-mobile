import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Plus, Layers, Edit2, Trash2 } from 'lucide-react-native';
import { presentationFactor } from '@/lib/presentation-parity';
import { SectionHeading } from '@/components/ui';
import { ui } from '@/lib/theme';
import type { ProductPresentation } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

export interface PresentationsSectionProps {
  presentations: ProductPresentation[];
  unitOfMeasure: string;
  onOpenNew: () => void;
  onOpenEdit: (pres: ProductPresentation) => void;
  onRemove: (id: string) => void;
}

export const PresentationsSection: React.FC<PresentationsSectionProps> = React.memo(({
  presentations,
  unitOfMeasure,
  onOpenNew,
  onOpenEdit,
  onRemove,
}) => {
  return (
    <>
      <SectionHeading
        title="Presentaciones"
        subtitle="Packs y cajas con cantidades y precios propios."
        action={(
          <TouchableOpacity
            style={styles.addPresBtn}
            onPress={onOpenNew}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Agregar presentación adicional"
          >
            <Plus size={16} color={ui.onPrimary} />
            <Text style={styles.addPresBtnText}>Agregar</Text>
          </TouchableOpacity>
        )}
      />

      {presentations.length === 0 ? (
        <View style={styles.emptyPresCard}>
          <Layers size={22} color={ui.textMuted} />
          <Text style={styles.emptyPresText}>
            No hay presentaciones adicionales. Se venderá en su unidad base ({unitOfMeasure}).
          </Text>
        </View>
      ) : (
        <View style={styles.presList}>
          {presentations.map((p) => (
            <View key={p.id} style={styles.presItemCard}>
              <View style={styles.presItemInfo}>
                <Text style={styles.presItemName}>{p.name}</Text>
                <Text style={styles.presItemDetails}>
                  Factor: {presentationFactor(p)} unidades | Precio: S/ {p.price.toFixed(2)}
                  {p.barcode ? ` | Código: ${p.barcode}` : ''}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity
                  onPress={() => onOpenEdit(p)}
                  style={styles.presEditBtn}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Editar presentación ${p.name}`}
                >
                  <Edit2 size={15} color={ui.primary} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onRemove(p.id)}
                  style={styles.presDeleteBtn}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Eliminar presentación ${p.name}`}
                >
                  <Trash2 size={16} color={ui.danger} />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}
    </>
  );
});
