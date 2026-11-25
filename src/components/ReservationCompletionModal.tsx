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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle2, X } from 'lucide-react-native';
import { useAuthSession, usePlanFeatures } from '@/context/AuthContext';
import {
  DEFAULT_PAYMENT_METHODS,
  useBusinessSettings,
  useCashSession,
} from '@/context/SettingsContext';
import { PaymentMethodSelector } from '@/components/PaymentMethodSelector';
import { ui, formatPEN } from '@/lib/theme';
import { assertOnlineForWrite } from '@/lib/online-guard';
import { tryResolveCheckoutPayment } from '@/lib/checkout-payment';
import { resolveSunatInvoicingAccess } from '@/lib/plan-entitlements';
import { parseNormalizedDecimal } from '@/lib/product-search';
import { getAvailableSaleSellers, type SaleSellerOption } from '@/services/sale-service';
import { completeOrCancelReservation, type ReservationOrder } from '@/services/crm-operations-service';
import type { Sale } from '@/types';

type CompletionDocType = 'nota_venta' | 'boleta' | 'factura';

const DOC_TYPE_OPTIONS: Array<{ key: CompletionDocType; label: string }> = [
  { key: 'nota_venta', label: 'Nota de Venta' },
  { key: 'boleta', label: 'Boleta' },
  { key: 'factura', label: 'Factura' },
];

interface ReservationCompletionModalProps {
  item: ReservationOrder | null;
  onClose: () => void;
  onCompleted: (item: ReservationOrder, sale?: Sale) => void;
}

const ReservationCompletionModalContent: React.FC<{
  item: ReservationOrder;
  onClose: () => void;
  onCompleted: (item: ReservationOrder, sale?: Sale) => void;
}> = React.memo(({
  item,
  onClose,
  onCompleted,
}) => {
  const insets = useSafeAreaInsets();
  const { user, userProfile, branchId, role } = useAuthSession();
  const { features } = usePlanFeatures();
  const {
    paymentMethods,
    posSettings,
    invoicingEnabled,
    configurationReady,
    configurationError,
    refreshConfiguration,
  } = useBusinessSettings();
  const { activeCashSession, isCashOpen } = useCashSession();
  const sunatAccess = useMemo(
    () =>
      resolveSunatInvoicingAccess({
        planAllowsSunatInvoicing: features.sunatInvoicing,
        invoicingEnabled,
      }),
    [features.sunatInvoicing, invoicingEnabled]
  );

  const visibleDocOptions = useMemo(
    () =>
      sunatAccess.allowed
        ? DOC_TYPE_OPTIONS
        : DOC_TYPE_OPTIONS.filter((opt) => opt.key === 'nota_venta'),
    [sunatAccess.allowed]
  );

  const methods = useMemo(() => {
    const eligible = paymentMethods.filter(
      (method) => method.enabled !== false && method.kind !== 'credit' && method.kind !== 'mixed'
    );
    return eligible.length > 0
      ? eligible
      : DEFAULT_PAYMENT_METHODS.filter((m) => m.kind !== 'credit' && m.kind !== 'mixed');
  }, [paymentMethods]);
  const [methodId, setMethodId] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [documentType, setDocumentType] = useState<CompletionDocType>('nota_venta');
  const [customerDocNumber, setCustomerDocNumber] = useState('');
  const [customerTaxName, setCustomerTaxName] = useState('');
  const [sellers, setSellers] = useState<SaleSellerOption[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const defaultId =
      (posSettings?.defaultMethodId &&
        methods.find((m) => m.id === posSettings.defaultMethodId)?.id) ||
      methods.find((m) => m.kind === 'cash')?.id ||
      methods[0]?.id ||
      '';
    setMethodId(defaultId);
    setCashReceived(Math.max(0, Number(item.remainingAmount) || 0).toFixed(2));
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
  }, [item.id, item.branchId, item.sellerId, item.remainingAmount, posSettings.enableSellerAttribution]);

  useEffect(() => {
    if (!sunatAccess.allowed && documentType !== 'nota_venta') {
      setDocumentType('nota_venta');
    }
  }, [sunatAccess.allowed, documentType]);

  const method = useMemo(
    () =>
      methods.find((entry) => entry.id === methodId) ||
      methods.find((entry) => entry.kind === 'cash') ||
      methods[0],
    [methods, methodId]
  );
  const remaining = Math.max(0, Number(item.remainingAmount) || 0);
  const paymentPreview = useMemo(() => {
    if (!method) return null;
    const category =
      method.kind === 'cash' ? 'cash' : method.kind === 'digital' ? 'transfer' : 'card';
    const result = tryResolveCheckoutPayment({
      methods,
      selectedMethodId: method.id,
      total: remaining,
      category,
    });
    return result.ok ? result.value : null;
  }, [methods, method, remaining]);

  const chargedTotal = paymentPreview?.chargedAmount ?? remaining;
  const isCashMethod = method?.kind === 'cash' || method?.reportCategory === 'cash';

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

    const effectiveDocType: CompletionDocType = sunatAccess.allowed ? documentType : 'nota_venta';
    const cleanDoc = customerDocNumber.replace(/\D/g, '');
    if (effectiveDocType === 'factura' && cleanDoc.length !== 11) {
      Alert.alert('RUC requerido', 'Ingresa un RUC válido de 11 dígitos para emitir Factura electrónica.');
      return;
    }
    if (effectiveDocType === 'factura' && !customerTaxName.trim()) {
      Alert.alert('Razón social requerida', 'Ingresa el nombre o razón social del cliente para la Factura.');
      return;
    }

    const parsedCash = cashReceived.trim() ? parseNormalizedDecimal(cashReceived) : chargedTotal;
    if (isCashMethod && chargedTotal > 0 && parsedCash !== null && parsedCash < chargedTotal - 0.009) {
      Alert.alert('Monto insuficiente', 'El efectivo recibido no puede ser menor al saldo por cobrar.');
      return;
    }
    const effectiveCash =
      isCashMethod && parsedCash !== null && parsedCash > 0 ? parsedCash : undefined;
    const changeGiven =
      isCashMethod && effectiveCash !== undefined
        ? Math.max(0, Math.round((effectiveCash - chargedTotal) * 100) / 100)
        : undefined;

    setBusy(true);
    try {
      await assertOnlineForWrite('completar la entrega de una reserva');
      const seller = sellers.find((entry) => entry.id === sellerId);
      let sunatNote: string | null = null;
      const completionRes = await completeOrCancelReservation(
        item,
        'complete',
        { uid: user.uid, displayName: userProfile?.displayName || user.email || 'Operador', email: user.email, role },
        {
          amount: Number(item.remainingAmount) || 0,
          sessionId,
          paymentMethod: method.name,
          paymentMethodId: method.id,
          paymentCategory: method.reportCategory,
          documentType: effectiveDocType,
          surchargeAmount: paymentPreview?.surchargeAmount || 0,
          chargedAmount: chargedTotal,
          commissionAmount: paymentPreview?.commissionAmount || 0,
          commissionPercent: method.commissionPercent,
          commissionRule: method.commissionRule,
          cashReceived: effectiveCash,
          changeGiven,
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
      onCompleted(item, completionRes && completionRes.sale ? completionRes.sale : undefined);
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
      statusBarTranslucent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[
          styles.overlay,
          {
            paddingTop: Math.max(insets.top, 16),
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
        <View collapsable={false} style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.title}>Cobrar Saldo y Entregar</Text>
              <Text style={styles.note} numberOfLines={1}>
                {item.customer?.name || item.customerName || 'Cliente General'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => !busy && onClose()}
              disabled={busy}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Cerrar cobro de entrega"
            >
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.amountBox}>
            <Text style={styles.note}>Saldo por cobrar</Text>
            <Text style={styles.amount}>{formatPEN(chargedTotal)}</Text>
            {!!paymentPreview?.surchargeAmount && (
              <Text style={styles.note}>
                Saldo: {formatPEN(remaining)} · Recargo: {formatPEN(paymentPreview.surchargeAmount)}
              </Text>
            )}
          </View>

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
          <ScrollView
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.options}
          >
            <Text style={styles.label}>Comprobante</Text>
            <View style={styles.docRow}>
              {visibleDocOptions.map((opt) => {
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

            {(documentType === 'factura' || documentType === 'boleta') && sunatAccess.allowed && (
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

            <PaymentMethodSelector
              label="Medio de pago"
              methods={methods}
              selectedMethodId={method?.id || ''}
              onSelect={(entry) => setMethodId(entry.id)}
              disabled={busy}
            />

            {isCashMethod && chargedTotal > 0 && (
              <View style={styles.cashBox}>
                <Text style={styles.taxLabel}>Monto recibido en efectivo (S/)</Text>
                <TextInput
                  value={cashReceived}
                  onChangeText={setCashReceived}
                  keyboardType="decimal-pad"
                  placeholder={chargedTotal.toFixed(2)}
                  placeholderTextColor={ui.textMuted}
                  style={styles.input}
                />
                {(parseNormalizedDecimal(cashReceived) ?? 0) > chargedTotal ? (
                  <Text style={styles.changeText}>
                    Vuelto: {formatPEN((parseNormalizedDecimal(cashReceived) ?? 0) - chargedTotal)}
                  </Text>
                ) : null}
              </View>
            )}

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
              <>
                <CheckCircle2 size={18} color={ui.onPrimary} />
                <Text style={styles.primaryText}>
                  {chargedTotal > 0 ? `Confirmar cobro · ${formatPEN(chargedTotal)}` : 'Confirmar entrega'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy}
            style={styles.cancelBtn}
            onPress={onClose}
          >
            <Text style={styles.cancelBtnText}>Volver</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

/** Delivery collects only the remaining balance while retaining the full commercial sale. */
export const ReservationCompletionModal: React.FC<ReservationCompletionModalProps> = React.memo(({
  item,
  onClose,
  onCompleted,
}) => {
  if (!item) return null;
  return (
    <ReservationCompletionModalContent
      item={item}
      onClose={onClose}
      onCompleted={onCompleted}
    />
  );
});

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(23,36,61,0.45)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: ui.surface, borderRadius: 20, padding: 20, gap: 10, maxHeight: '92%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeBtn: { padding: 4, borderRadius: 16 },
  title: { color: ui.text, fontSize: 19, fontWeight: '700' },
  note: { color: ui.textSecondary, fontSize: 13 },
  amountBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 12,
    gap: 2,
  },
  amount: { fontSize: 26, fontWeight: '800', color: ui.danger },
  options: { gap: 8, paddingBottom: 12 },
  label: { color: ui.textSecondary, fontWeight: '700', marginTop: 4, fontSize: 13 },
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
  cashBox: {
    gap: 6,
  },
  changeText: {
    color: ui.success,
    fontSize: 12.5,
    fontWeight: '700',
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
    width: '100%',
    minHeight: 50,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: ui.onPrimary, fontWeight: '700', fontSize: 15 },
  cancelBtn: {
    width: '100%',
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: { color: ui.textSecondary, fontWeight: '600', fontSize: 14 },
});
