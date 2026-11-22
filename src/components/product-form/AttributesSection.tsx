import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Plus, Trash2 } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import type { ProductAttributeDraft } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

export interface AttributesSectionProps {
  attributesList: ProductAttributeDraft[];
  formSessionKey: number;
  onAddAttribute: (key: string, value: string) => void;
  onRemoveAttribute: (idx: number) => void;
}

export const AttributesSection: React.FC<AttributesSectionProps> = React.memo(({
  attributesList,
  formSessionKey,
  onAddAttribute,
  onRemoveAttribute,
}) => {
  const [attrKeyInput, setAttrKeyInput] = useState('');
  const [attrValInput, setAttrValInput] = useState('');

  useEffect(() => {
    setAttrKeyInput('');
    setAttrValInput('');
  }, [formSessionKey]);

  const handleAdd = useCallback(() => {
    const k = attrKeyInput.trim();
    const v = attrValInput.trim();
    if (!k || !v) {
      Alert.alert('Atributo incompleto', 'Ingresa tanto el nombre como el valor del atributo.');
      return;
    }
    onAddAttribute(k, v);
    setAttrKeyInput('');
    setAttrValInput('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [attrKeyInput, attrValInput, onAddAttribute]);

  return (
    <View style={[styles.sectionCard, { marginTop: 16 }]}>
      <Text style={styles.sectionCardTitle}>Atributos Técnicos (Opcional)</Text>
      <View style={styles.inlineAddRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={attrKeyInput}
          onChangeText={setAttrKeyInput}
          placeholder="Ej. Material"
          placeholderTextColor={ui.textMuted}
        />
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={attrValInput}
          onChangeText={setAttrValInput}
          placeholder="Ej. Algodón"
          placeholderTextColor={ui.textMuted}
        />
        <TouchableOpacity style={styles.inlineAddBtn} onPress={handleAdd}>
          <Plus size={18} color={ui.onPrimary} />
        </TouchableOpacity>
      </View>

      {attributesList.length > 0 && (
        <View style={{ marginTop: 8, gap: 6 }}>
          {attributesList.map((attr, idx) => (
            <View key={`${attr.key}-${idx}`} style={styles.presItemCard}>
              <Text style={styles.presItemDetails}>
                <Text style={{ fontWeight: '700', color: ui.text }}>{attr.key}:</Text> {attr.value}
              </Text>
              <TouchableOpacity
                onPress={() => onRemoveAttribute(idx)}
                style={styles.presDeleteBtn}
              >
                <Trash2 size={15} color={ui.danger} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
    </View>
  );
});
