import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { ui } from '@/lib/theme';

export interface CheckoutNotesSectionProps {
  notesRef: React.MutableRefObject<string>;
  resetSeq: number;
}

/**
 * Isolated notes input section so typing remarks never re-renders CheckoutModal.
 */
export const CheckoutNotesSection = React.memo<CheckoutNotesSectionProps>(({
  notesRef,
  resetSeq,
}) => {
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setNotes('');
    notesRef.current = '';
  }, [resetSeq, notesRef]);

  const handleChangeText = (val: string) => {
    setNotes(val);
    notesRef.current = val;
  };

  return (
    <View style={styles.formGroup}>
      <Text style={styles.inputLabel}>Observaciones / Notas (Opcional)</Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Observaciones de la venta, opcional"
        value={notes}
        onChangeText={handleChangeText}
        placeholder="Ej. Entregar con bolsa, pedido especial..."
        placeholderTextColor={ui.textMuted}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  formGroup: {
    marginBottom: 10,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 4,
  },
  input: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 11,
    fontSize: 16,
    color: ui.text,
  },
});
