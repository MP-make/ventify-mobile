import React, { useEffect, useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { CreditCard, ShieldAlert, X } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import type { Customer } from '@/types';
import type { ActivePaymentCategory } from './checkout-types';

export interface CheckoutPaymentDetailsProps {
  paymentCategory: ActivePaymentCategory;
  selectedMethodId: string;
  selectedMethodName: string;
  selectedMethodQrUrl: string;
  selectedMethodPhone: string;
  digitalHolder: string;
  amountToCollect: number;
  selectedCustomer: Customer | null;
  creditDays: string;
  onChangeCreditDays: (days: string) => void;
  fiadoValidation: { isValid: boolean; reason: string };
  prepaidCreditsValidation: { isValid: boolean; reason: string };
  operationReferenceRef: React.MutableRefObject<string>;
  resetSeq: number;
}

const CREDIT_DAY_OPTIONS = ['7', '15', '30', '45', '60'] as const;

/**
 * Payment method detail panel (Yape/Plin, Card/Transfer, Credits, Fiado) + QR Zoom.
 * Holds local operationReference and qrZoomVisible state so keystrokes and QR zoom
 * toggles never re-render CheckoutModal.
 */
export const CheckoutPaymentDetails = React.memo<CheckoutPaymentDetailsProps>(({
  paymentCategory,
  selectedMethodId,
  selectedMethodName,
  selectedMethodQrUrl,
  selectedMethodPhone,
  digitalHolder,
  amountToCollect,
  selectedCustomer,
  creditDays,
  onChangeCreditDays,
  fiadoValidation,
  prepaidCreditsValidation,
  operationReferenceRef,
  resetSeq,
}) => {
  const [operationReference, setOperationReference] = useState('');
  const [qrZoomVisible, setQrZoomVisible] = useState(false);

  useEffect(() => {
    setOperationReference('');
    operationReferenceRef.current = '';
  }, [resetSeq, operationReferenceRef]);

  useEffect(() => {
    setQrZoomVisible(false);
  }, [selectedMethodId]);

  const handleReferenceChange = (val: string) => {
    setOperationReference(val);
    operationReferenceRef.current = val;
  };

  const renderPaymentQrCard = (includeHeader: boolean) => {
    if (!selectedMethodQrUrl) return null;
    return (
      <View style={styles.paymentQrCard}>
        {includeHeader ? (
          <View style={styles.paymentQrHeader}>
            <Text style={styles.digitalInfoTitle}>
              {`QR ${selectedMethodName || ''}`.trim()}
            </Text>
            {selectedMethodPhone ? (
              <Text style={styles.digitalInfoPhone}>{selectedMethodPhone}</Text>
            ) : null}
            {digitalHolder ? (
              <Text style={styles.digitalInfoHolder}>
                Titular: <Text style={styles.boldText}>{digitalHolder}</Text>
              </Text>
            ) : null}
          </View>
        ) : null}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setQrZoomVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Ampliar código QR"
        >
          <Image
            source={{ uri: selectedMethodQrUrl }}
            style={styles.paymentQrImage}
            contentFit="contain"
            cachePolicy="memory-disk"
          />
        </TouchableOpacity>
        <Text style={styles.paymentQrHint}>Toca el QR para ampliar</Text>
      </View>
    );
  };

  return (
    <>
      {paymentCategory === 'yape' || paymentCategory === 'plin' ? (
        <View style={styles.paymentDetailBox}>
          <View style={styles.digitalInfoBanner}>
            <Text style={styles.digitalInfoTitle}>
              Cobro con {paymentCategory.toUpperCase()}
            </Text>
            <Text style={styles.digitalInfoPhone}>
              Número:{' '}
              <Text style={styles.boldText}>
                {selectedMethodPhone || '987 654 321'}
              </Text>
            </Text>
            <Text style={styles.digitalInfoHolder}>
              Titular:{' '}
              <Text style={styles.boldText}>
                {digitalHolder || 'Ventify POS'}
              </Text>
            </Text>
          </View>
          {renderPaymentQrCard(false)}
          <Text style={styles.inputLabel}>Número de Operación / Referencia (Opcional)</Text>
          <TextInput
            style={styles.input}
            accessibilityLabel="Número de operación o referencia, opcional"
            value={operationReference}
            onChangeText={handleReferenceChange}
            placeholder="Ej. 482910"
            keyboardType="numeric"
            placeholderTextColor={ui.textMuted}
          />
        </View>
      ) : null}

      {paymentCategory === 'card' || paymentCategory === 'transfer' ? (
        <View style={styles.paymentDetailBox}>
          {renderPaymentQrCard(true)}
          <Text style={styles.inputLabel}>
            {paymentCategory === 'card' ? 'Lote / Referencia POS' : 'Número de Operación Bancaria'}
          </Text>
          <TextInput
            style={styles.input}
            accessibilityLabel={
              paymentCategory === 'card'
                ? 'Lote o referencia POS'
                : 'Número de operación bancaria'
            }
            value={operationReference}
            onChangeText={handleReferenceChange}
            placeholder="Código o referencia"
            placeholderTextColor={ui.textMuted}
          />
        </View>
      ) : null}

      {paymentCategory === 'credits' ? (
        <View style={styles.paymentDetailBox}>
          <View style={styles.fiadoAlert}>
            <CreditCard size={20} color={ui.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.fiadoTitle}>Créditos prepagados</Text>
              <Text style={styles.fiadoSubtitle}>
                Se descontará del saldo que el cliente ya tiene cargado.
              </Text>
            </View>
          </View>
          {selectedCustomer ? (
            <Text style={styles.fiadoDataText}>
              Saldo disponible:{' '}
              <Text style={styles.boldText}>{formatPEN(selectedCustomer.credits || 0)}</Text>
            </Text>
          ) : (
            <Text style={styles.fiadoErrorText}>
              Selecciona un cliente con saldo prepagado.
            </Text>
          )}
          {!prepaidCreditsValidation.isValid ? (
            <Text style={styles.fiadoErrorText}>{prepaidCreditsValidation.reason}</Text>
          ) : null}
        </View>
      ) : null}

      {paymentCategory === 'fiado' ? (
        <View style={styles.paymentDetailBox}>
          <View style={styles.fiadoAlert}>
            <ShieldAlert size={20} color={ui.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.fiadoTitle}>Venta al Crédito (Fiado)</Text>
              <Text style={styles.fiadoSubtitle}>
                Se registrará una cuenta por cobrar en el módulo de CRM del cliente.
              </Text>
            </View>
          </View>

          {selectedCustomer ? (
            <View style={styles.fiadoCustomerData}>
              <Text style={styles.fiadoDataText}>
                Límite de Crédito:{' '}
                <Text style={styles.boldText}>
                  {selectedCustomer.maxCreditLimit
                    ? formatPEN(selectedCustomer.maxCreditLimit)
                    : 'Ilimitado'}
                </Text>
              </Text>
              <Text style={styles.fiadoDataText}>
                Deuda Actual:{' '}
                <Text style={[styles.boldText, { color: ui.danger }]}>
                  {formatPEN(selectedCustomer.currentDebt || 0)}
                </Text>
              </Text>
            </View>
          ) : (
            <Text style={styles.fiadoErrorText}>
              * Debes seleccionar un cliente del directorio para continuar.
            </Text>
          )}

          {!fiadoValidation.isValid ? (
            <Text style={styles.fiadoErrorText}>{fiadoValidation.reason}</Text>
          ) : null}

          <Text style={styles.inputLabel}>Plazo de Crédito (Días)</Text>
          <View style={styles.quickBillsRow}>
            {CREDIT_DAY_OPTIONS.map((d) => (
              <TouchableOpacity
                key={d}
                style={[
                  styles.quickBillChip,
                  creditDays === d && styles.quickBillChipActive,
                ]}
                onPress={() => onChangeCreditDays(d)}
                accessibilityRole="button"
                accessibilityLabel={`Plazo de crédito: ${d} días`}
                accessibilityState={{ selected: creditDays === d }}
              >
                <Text
                  style={[
                    styles.quickBillText,
                    creditDays === d && styles.quickBillTextActive,
                  ]}
                >
                  {d} días
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      {qrZoomVisible && Boolean(selectedMethodQrUrl) && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setQrZoomVisible(false)}
        >
          <View style={styles.qrZoomBackdrop}>
            <View style={styles.qrZoomCard}>
              <View style={styles.qrZoomHeader}>
                <Text style={styles.qrZoomTitle} numberOfLines={1}>
                  {selectedMethodName || paymentCategory.toUpperCase()}
                </Text>
                <TouchableOpacity
                  onPress={() => setQrZoomVisible(false)}
                  style={styles.compactCloseBtn}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar QR ampliado"
                >
                  <X size={18} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={styles.qrZoomAmount}>
                Total: {formatPEN(amountToCollect)}
              </Text>
              <Image
                source={{ uri: selectedMethodQrUrl }}
                style={styles.qrZoomImage}
                contentFit="contain"
                cachePolicy="memory-disk"
              />
              {selectedMethodPhone ? (
                <Text style={styles.qrZoomMeta}>{selectedMethodPhone}</Text>
              ) : null}
              {digitalHolder ? (
                <Text style={styles.qrZoomMeta}>{digitalHolder}</Text>
              ) : null}
              <TouchableOpacity
                style={styles.qrZoomCloseBtn}
                onPress={() => setQrZoomVisible(false)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Cerrar"
              >
                <Text style={styles.qrZoomCloseText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </>
  );
});

const styles = StyleSheet.create({
  paymentDetailBox: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    marginBottom: 16,
  },
  digitalInfoBanner: {
    backgroundColor: ui.background,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  digitalInfoTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 4,
  },
  digitalInfoPhone: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  digitalInfoHolder: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  boldText: {
    fontWeight: '700',
    color: ui.text,
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
  fiadoAlert: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: ui.warningSoft,
    padding: 10,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: ui.warningSoft,
  },
  fiadoTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400E',
  },
  fiadoSubtitle: {
    fontSize: 11,
    color: '#B45309',
    marginTop: 2,
  },
  fiadoCustomerData: {
    backgroundColor: ui.background,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  fiadoDataText: {
    fontSize: 12,
    color: ui.textSecondary,
    marginBottom: 2,
  },
  fiadoErrorText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.danger,
    marginBottom: 8,
  },
  quickBillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  quickBillChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  quickBillChipActive: {
    backgroundColor: ui.text,
    borderColor: ui.text,
  },
  quickBillText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  quickBillTextActive: {
    color: ui.surface,
  },
  paymentQrCard: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  paymentQrHeader: {
    alignItems: 'center',
    marginBottom: 8,
  },
  paymentQrImage: {
    width: 196,
    height: 196,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },
  paymentQrHint: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: '600',
    color: ui.textMuted,
  },
  qrZoomBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  qrZoomCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
  },
  qrZoomHeader: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  qrZoomTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
    marginRight: 8,
  },
  compactCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
  },
  qrZoomAmount: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.primary,
    marginBottom: 14,
    fontVariant: ['tabular-nums'],
  },
  qrZoomImage: {
    width: 280,
    height: 280,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    marginBottom: 12,
  },
  qrZoomMeta: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
    marginBottom: 4,
  },
  qrZoomCloseBtn: {
    marginTop: 12,
    width: '100%',
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrZoomCloseText: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.onPrimary,
  },
});
