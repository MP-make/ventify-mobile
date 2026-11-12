import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { X } from 'lucide-react-native';
import { ui, theme, formatPEN } from '@/lib/theme';

type CancellationItem = { id: string; type: 'reservation' | 'order'; customerName?: string; customer?: { name?: string }; depositAmount?: number };
type RefundChoice = { refundMethod?: string; refundPercent?: number };

const METHODS = [
  { label: 'No reembolsar', value: '' },
  { label: 'Efectivo', value: 'efectivo' },
  { label: 'Tarjeta', value: 'tarjeta' },
  { label: 'Digital', value: 'digital' },
];

export function ReservationCancellationModal({
  visible,
  item,
  sessionId,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  item: CancellationItem | null;
  sessionId?: string;
  onClose: () => void;
  onConfirm: (choice: RefundChoice) => Promise<void>;
}) {
  const [method, setMethod] = useState('');
  const [percent, setPercent] = useState('100');
  const [busy, setBusy] = useState(false);
  const deposit = Math.max(0, Number(item?.depositAmount) || 0);
  const parsedPercent = Number(percent);
  const validPercent = Number.isFinite(parsedPercent) && parsedPercent > 0 && parsedPercent <= 100;

  useEffect(() => {
    if (visible) { setMethod(''); setPercent('100'); setBusy(false); }
  }, [visible, item?.id]);

  const confirm = async () => {
    if (!item || busy) return;
    if (method && (!validPercent || !sessionId)) return;
    setBusy(true);
    try {
      await onConfirm(method ? { refundMethod: method, refundPercent: parsedPercent } : {});
    } finally {
      setBusy(false);
    }
  };

  const title = item?.type === 'order' ? 'Cancelar pedido' : 'Cancelar reserva';
  const customer = item?.customer?.name || item?.customerName || 'el cliente';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>Se liberará el stock retenido para {customer}.</Text>
            </View>
            <TouchableOpacity onPress={onClose} disabled={busy} style={styles.close} accessibilityLabel="Cerrar">
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <Text style={styles.sectionLabel}>Adelanto registrado</Text>
            <Text style={styles.deposit}>{formatPEN(deposit)}</Text>
            {deposit > 0 ? (
              <>
                <Text style={styles.sectionLabel}>¿Qué hacemos con el adelanto?</Text>
                <View style={styles.methods}>
                  {METHODS.map((option) => {
                    const selected = method === option.value;
                    return (
                      <TouchableOpacity
                        key={option.value || 'keep'}
                        onPress={() => setMethod(option.value)}
                        style={[styles.method, selected && styles.methodSelected]}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                      >
                        <Text style={[styles.methodText, selected && styles.methodTextSelected]}>{option.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {method ? (
                  <>
                    <Text style={styles.sectionLabel}>Porcentaje a reembolsar</Text>
                    <View style={styles.percentRow}>
                      <TextInput
                        value={percent}
                        onChangeText={(value) => setPercent(value.replace(/[^\d.]/g, '').slice(0, 6))}
                        keyboardType="decimal-pad"
                        maxLength={6}
                        style={styles.percentInput}
                        accessibilityLabel="Porcentaje de reembolso"
                      />
                      <Text style={styles.percentSign}>%</Text>
                      <Text style={styles.refundAmount}>{formatPEN(validPercent ? deposit * parsedPercent / 100 : 0)}</Text>
                    </View>
                    {!validPercent ? <Text style={styles.error}>Ingresa un porcentaje entre 1 y 100.</Text> : null}
                    {!sessionId ? <Text style={styles.error}>Abre una caja para registrar el reembolso.</Text> : null}
                  </>
                ) : (
                  <Text style={styles.note}>El adelanto quedará registrado y no se devolverá.</Text>
                )}
              </>
            ) : (
              <Text style={styles.note}>Esta operación no tiene adelanto registrado.</Text>
            )}
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} disabled={busy} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Volver</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={confirm}
              disabled={busy || Boolean(method && (!validPercent || !sessionId))}
              style={[styles.confirmButton, (busy || Boolean(method && (!validPercent || !sessionId))) && styles.disabled]}
            >
              {busy ? <ActivityIndicator color={ui.onPrimary} /> : <Text style={styles.confirmText}>Confirmar cancelación</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.62)', justifyContent: 'center', padding: 20 },
  card: { maxHeight: '90%', width: '100%', maxWidth: 520, alignSelf: 'center', borderRadius: theme.borderRadius.xl, backgroundColor: ui.surface, overflow: 'hidden', borderWidth: 1, borderColor: ui.border },
  header: { padding: 18, flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1, borderColor: ui.border },
  headerText: { flex: 1, gap: 4 },
  title: { color: ui.text, fontSize: 18, fontWeight: '800' },
  subtitle: { color: ui.textSecondary, fontSize: 13, lineHeight: 19 },
  close: { padding: 4, marginLeft: 8 },
  content: { padding: 18, gap: 10 },
  sectionLabel: { color: ui.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 5 },
  deposit: { color: ui.text, fontSize: 24, fontWeight: '800', marginBottom: 5 },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  method: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: ui.border, justifyContent: 'center', backgroundColor: ui.surfaceMuted },
  methodSelected: { borderColor: ui.primary, backgroundColor: ui.primarySoft },
  methodText: { color: ui.textSecondary, fontSize: 12, fontWeight: '700' },
  methodTextSelected: { color: ui.primary },
  percentRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  percentInput: { width: 82, minHeight: 44, borderWidth: 1, borderColor: ui.border, borderRadius: 10, paddingHorizontal: 12, color: ui.text, fontSize: 16, fontWeight: '700' },
  percentSign: { color: ui.textSecondary, fontSize: 15 },
  refundAmount: { marginLeft: 'auto', color: ui.text, fontSize: 17, fontWeight: '800' },
  note: { color: ui.textSecondary, fontSize: 13, lineHeight: 19 },
  error: { color: ui.danger, fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: 1, borderColor: ui.border },
  cancelButton: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: ui.border },
  cancelText: { color: ui.text, fontWeight: '700' },
  confirmButton: { flex: 1.4, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: ui.primary, paddingHorizontal: 8 },
  confirmText: { color: ui.onPrimary, fontWeight: '800', textAlign: 'center' },
  disabled: { opacity: 0.5 },
});
