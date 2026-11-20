import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { ui, formatPEN } from '@/lib/theme';
import { resolveCheckoutPayment } from '@/lib/checkout-payment';
import { getAvailableSaleSellers, type SaleSellerOption } from '@/services/sale-service';
import { completeOrCancelReservation, type ReservationOrder } from '@/services/crm-operations-service';

type CompletionDocType = 'nota_venta' | 'boleta' | 'factura';

const DOC_TYPE_OPTIONS: Array<{ key: CompletionDocType; label: string }> = [
  { key: 'nota_venta', label: 'Nota de Venta' },
  { key: 'boleta', label: 'Boleta' },
  { key: 'factura', label: 'Factura' },
];

/** Delivery collects only the remaining balance while retaining the full commercial sale. */
export const ReservationCompletionModal: React.FC<{
  item: ReservationOrder | null;
  onClose: () => void;
  onCompleted: (item: ReservationOrder) => void;
}> = React.memo(({
  item,
  onClose,
  onCompleted,
}) => {
  const { user, userProfile, branchId, role } = useAuth();
  const {
    paymentMethods,
    posSettings,
    activeCashSession,
    isCashOpen,
    configurationReady,
    configurationError,
    refreshConfiguration,
  } = useSettings();
  const methods = useMemo(
    () => paymentMethods.filter((method) => method.enabled && method.kind !== 'credit' && method.kind !== 'mixed'),
    [paymentMethods]
  );
  const [methodId, setMethodId] = useState('');
  const [documentType, setDocumentType] = useState<CompletionDocType>('nota_venta');
  const [customerDocNumber, setCustomerDocNumber] = useState('');
  const [customerTaxName, setCustomerTaxName] = useState('');
  const [sellers, setSellers] = useState<SaleSellerOption[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!item) return;
    let alive = true;
    setMethodId('');
    setDocumentType('nota_venta');
    setCustomerDocNumber(
      String(item.customer?.ruc || item.customer?.dni || item.customer?.documentNumber || item.customerDocument || '').replace(/\D/g, '')
    );
    setCustomerTaxName(item.customer?.name || item.customerName || '');
    setSellerId('');
    setSellers([]);
    setError('');
    if (posSettings.enableSellerAttribution && !item.sellerId) {
      setLoading(true);
      getAvailableSaleSellers(item.branchId)
        .then((rows) => {
          if (alive) setSellers(rows);
        })
        .catch((err) => {
          if (alive) setError(err.message || 'No se pudieron consultar los vendedores.');
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    } else {
      setLoading(false);
    }
    return () => {
      alive = false;
    };
  }, [item?.id, item?.branchId, posSettings.enableSellerAttribution]);

  const method = methods.find((entry) => entry.id === methodId) || methods.find((entry) => entry.kind === 'cash') || methods[0];
  const remaining = Math.max(0, Number(item?.remainingAmount) || 0);
  const paymentPreview = method
    ? resolveCheckoutPayment({
        methods,
        selectedMethodId: method.id,
        total: remaining,
        category: method.kind === 'cash' ? 'cash' : method.kind === 'digital' ? 'transfer' : 'card',
      })
    : null;

  const submit = async () => {
    if (!item || !user || busy) return;
    if (!configurationReady) {
      Alert.alert('Configuración pendiente', configurationError || 'Espera a que se carguen los medios de pago.');
      return;
    }
    if (item.branchId !== branchId) {
      Alert.alert('Sucursal diferente', 'Selecciona la sucursal de esta reserva antes de entregarla.');
      return;
    }
    const sessionId = activeCashSession?.sessionId || activeCashSession?.id;
    if (!isCashOpen || !sessionId) {
      Alert.alert('Caja cerrada', 'Abre una caja para registrar la entrega y su cobro.');
      return;
    }
    if (!method) {
      Alert.alert('Medio de pago requerido', 'Activa un medio de pago para continuar.');
      return;
    }
    if (loading || error) return;
    if (posSettings.requireSellerSelection && posSettings.enableSellerAttribution && !item.sellerId && !sellerId) {
      Alert.alert('Selecciona un vendedor', 'Indica quién atendió esta venta.');
      return;
    }

    const cleanDoc = customerDocNumber.replace(/\D/g, '');
    if (documentType === 'factura' && cleanDoc.length !== 11) {
      Alert.alert('RUC requerido', 'Ingresa un RUC válido de 11 dígitos para emitir Factura electrónica.');
      return;
    }
    if (documentType === 'factura' && !customerTaxName.trim()) {
      Alert.alert('Razón social requerida', 'Ingresa el nombre o razón social del cliente para la Factura.');
      return;
    }

    setBusy(true);
    try {
      const seller = sellers.find((entry) => entry.id === sellerId);
      let sunatNote: string | null = null;
      await completeOrCancelReservation(
        item,
        'complete',
        { uid: user.uid, displayName: userProfile?.displayName || user.email || 'Operador', email: user.email, role },
        {
          amount: Number(item.remainingAmount) || 0,
          sessionId,
          paymentMethod: method.name,
          paymentMethodId: method.id,
          paymentCategory: method.reportCategory,
          documentType,
          surchargeAmount: paymentPreview?.surchargeAmount || 0,
          chargedAmount: paymentPreview?.chargedAmount ?? remaining,
          commissionAmount: paymentPreview?.commissionAmount || 0,
          commissionPercent: method.commissionPercent,
          commissionRule: method.commissionRule,
          customer: {
            ...(item.customer || {}),
            name: customerTaxName.trim() || item.customer?.name || item.customerName || 'CLIENTE',
            ...(cleanDoc.length === 11 ? { ruc: cleanDoc, documentNumber: cleanDoc } : {}),
            ...(cleanDoc.length === 8 ? { dni: cleanDoc, documentNumber: cleanDoc } : {}),
          },
          sellerId: seller?.id,
          sellerName: seller?.name,
          onSunatResult: (res) => {
            if (res && res.success === false && res.error) {
              sunatNote = res.error;
            }
          },
        }
      );
      if (sunatNote) {
        Alert.alert('Entrega registrada', `La venta se registró, pero SUNAT respondió: ${sunatNote}`);
      }
      onCompleted(item);
    } catch (err) {
      Alert.alert(
        'No se pudo registrar la entrega',
        err instanceof Error ? err.message : 'Actualiza los datos y vuelve a intentarlo.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={Boolean(item)}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.overlay}
        >
          <View style={styles.card}>
            <Text style={styles.title}>Cobrar y entregar</Text>
            <Text style={styles.note}>Saldo por cobrar</Text>
            <Text style={styles.amount}>{formatPEN(paymentPreview?.chargedAmount ?? remaining)}</Text>
            {!!paymentPreview?.surchargeAmount && (
              <Text style={styles.note}>
                Saldo: {formatPEN(remaining)} · Recargo: {formatPEN(paymentPreview.surchargeAmount)}
              </Text>
            )}
            {!configurationReady && (
              <Text accessibilityRole="alert" style={styles.note}>
                {configurationError || 'Cargando medios de pago…'}
              </Text>
            )}
            {!!configurationError && (
              <TouchableOpacity accessibilityRole="button" onPress={refreshConfiguration}>
                <Text style={styles.text}>Reintentar configuración</Text>
              </TouchableOpacity>
            )}
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.options}>
              <Text style={styles.label}>Comprobante</Text>
              <View style={styles.docRow}>
                {DOC_TYPE_OPTIONS.map((opt) => {
                  const active = documentType === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      disabled={busy}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: active }}
                      onPress={() => setDocumentType(opt.key)}
                      style={[styles.docChip, active && styles.selected]}
                    >
                      <Text style={[styles.docChipText, active && styles.docChipTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {(documentType === 'factura' || documentType === 'boleta') && (
                <View style={styles.taxBox}>
                  <Text style={styles.taxLabel}>
                    {documentType === 'factura' ? 'RUC (11 dígitos) *' : 'DNI / RUC (opcional)'}
                  </Text>
                  <TextInput
                    value={customerDocNumber}
                    onChangeText={(txt) => setCustomerDocNumber(txt.replace(/\D/g, '').slice(0, 11))}
                    keyboardType="number-pad"
                    maxLength={11}
                    placeholder={documentType === 'factura' ? '20XXXXXXXXX' : 'DNI 8 dígitos'}
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />
                  <Text style={styles.taxLabel}>
                    {documentType === 'factura' ? 'Razón Social *' : 'Nombre del cliente'}
                  </Text>
                  <TextInput
                    value={customerTaxName}
                    onChangeText={setCustomerTaxName}
                    placeholder="Nombre o razón social"
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />
                </View>
              )}

              <Text style={styles.label}>Medio de pago</Text>
              {methods.map((entry) => (
                <TouchableOpacity
                  accessibilityRole="radio"
                  accessibilityState={{ checked: method?.id === entry.id }}
                  disabled={busy}
                  key={entry.id}
                  style={[styles.option, method?.id === entry.id && styles.selected]}
                  onPress={() => setMethodId(entry.id)}
                >
                  <Text style={styles.text}>{entry.name}</Text>
                </TouchableOpacity>
              ))}
              {posSettings.enableSellerAttribution && (
                <>
                  <Text style={styles.label}>Vendedor</Text>
                  {item?.sellerId ? (
                    <Text style={styles.text}>{item.sellerName || 'Vendedor de la reserva'}</Text>
                  ) : (
                    <>
                      {!posSettings.requireSellerSelection && (
                        <TouchableOpacity
                          accessibilityRole="button"
                          style={[styles.option, !sellerId && styles.selected]}
                          onPress={() => setSellerId('')}
                        >
                          <Text style={styles.text}>Sin vendedor asignado</Text>
                        </TouchableOpacity>
                      )}
                      {sellers.map((seller) => (
                        <TouchableOpacity
                          accessibilityRole="radio"
                          accessibilityState={{ checked: sellerId === seller.id }}
                          disabled={busy}
                          key={seller.id}
                          style={[styles.option, sellerId === seller.id && styles.selected]}
                          onPress={() => setSellerId(seller.id)}
                        >
                          <Text style={styles.text}>{seller.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </>
                  )}
                </>
              )}
              {loading && <ActivityIndicator color={ui.primary} />}
              {!!error && (
                <Text accessibilityRole="alert" style={{ color: ui.danger }}>
                  {error} Cierra y vuelve a abrir para reintentar.
                </Text>
              )}
            </ScrollView>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy || loading || Boolean(error) || !configurationReady}
              style={[
                styles.primary,
                (busy || loading || Boolean(error) || !configurationReady) && { opacity: 0.5 },
              ]}
              onPress={() => void submit()}
            >
              {busy ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.primaryText}>Confirmar entrega</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy}
              style={styles.option}
              onPress={onClose}
            >
              <Text style={styles.text}>Volver</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  overlay: { flex: 1, backgroundColor: 'rgba(23,36,61,0.45)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: ui.surface, borderRadius: 20, padding: 20, gap: 10, maxHeight: '92%' },
  title: { color: ui.text, fontSize: 22, fontWeight: '700' },
  note: { color: ui.textSecondary },
  amount: { fontSize: 28, fontWeight: '700', color: ui.text },
  options: { gap: 8, paddingBottom: 12 },
  label: { color: ui.textSecondary, fontWeight: '700', marginTop: 8 },
  docRow: { flexDirection: 'row', gap: 8 },
  docChip: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  docChipText: { color: ui.textSecondary, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  docChipTextActive: { color: ui.primary },
  taxBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  taxLabel: { color: ui.textSecondary, fontSize: 12, fontWeight: '700' },
  input: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 42,
    color: ui.text,
    fontSize: 14,
  },
  option: {
    padding: 14,
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    justifyContent: 'center',
  },
  selected: { backgroundColor: ui.primarySoft, borderColor: ui.primary },
  text: { color: ui.text, fontSize: 15 },
  primary: {
    padding: 16,
    minHeight: 50,
    borderRadius: 10,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: ui.onPrimary, fontWeight: '700' },
});
