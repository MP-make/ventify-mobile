import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Share,
  Platform,
} from 'react-native';
import * as Print from 'expo-print';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import { X, Printer, Share2, CheckCircle2, Clock, Calendar, Phone, AlertCircle, FileText } from 'lucide-react-native';
import { useSettings } from '@/context/SettingsContext';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { buildReservationReceiptHtml } from '@/lib/printing/escpos-builder';

interface ReservationReceiptModalProps {
  visible: boolean;
  onClose: () => void;
  reservation: any;
  business?: any;
}

export const ReservationReceiptModal: React.FC<ReservationReceiptModalProps> = React.memo(({
  visible,
  onClose,
  reservation,
  business: propBusiness,
}) => {
  const { businessData, businessSettings, activeBranchName } = useSettings();
  const effectiveBusiness = propBusiness || businessSettings || businessData;
  const [isPrinting, setIsPrinting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  if (!visible || !reservation) return null;

  const isDelivered = reservation.status === 'completed' || reservation.status === 'delivered';
  const isCancelled = reservation.status === 'cancelled';
  const isPending = !isDelivered && !isCancelled;

  const total = Number(reservation.total || 0);
  const deposit = Number(reservation.depositAmount || 0);
  const remaining = Math.max(0, total - deposit);

  const resNumber = reservation.reservationNumber
    ? String(reservation.reservationNumber).padStart(6, '0')
    : String(reservation.id || 'N/A').slice(-6).toUpperCase();

  const customerName = reservation.customer?.name || reservation.customerName || 'Cliente General';
  const customerPhone = reservation.customer?.phone || reservation.customerPhone || '';
  const customerDoc = reservation.customer?.documentNumber || reservation.customer?.dni || reservation.customerDni || '';

  const createdDate = reservation.createdAt
    ? (typeof reservation.createdAt?.toDate === 'function' ? reservation.createdAt.toDate() : new Date(reservation.createdAt))
    : (reservation.date ? new Date(reservation.date) : new Date());

  const expiryDate = reservation.expiryDate
    ? (typeof reservation.expiryDate?.toDate === 'function' ? reservation.expiryDate.toDate() : new Date(reservation.expiryDate))
    : (reservation.pickupDate ? new Date(reservation.pickupDate) : null);

  const businessInfo = {
    businessName: effectiveBusiness?.businessName || effectiveBusiness?.name || businessData?.businessName || 'Ventify POS',
    ruc: effectiveBusiness?.ruc || businessData?.ruc || '20123456789',
    address: effectiveBusiness?.address || effectiveBusiness?.commercialAddress || businessData?.address || activeBranchName || '',
    phone: effectiveBusiness?.phone || businessData?.phone || '',
  };

  const handlePrint = async () => {
    try {
      setIsPrinting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const html = buildReservationReceiptHtml(reservation, businessInfo);
      await Print.printAsync({ html });
    } catch (err: any) {
      console.warn('Error imprimiendo ticket de reserva:', err);
    } finally {
      setIsPrinting(false);
    }
  };

  const handleShare = async () => {
    try {
      setIsSharing(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      const itemsText = (reservation.items || [])
        .map((it: any) => `• ${it.quantity}x ${it.productName || it.name || 'Producto'} (S/ ${Number(it.price || 0).toFixed(2)})`)
        .join('\n');

      const shareMessage = `*COMPROBANTE DE RESERVA #${resNumber}*\n` +
        `*${businessInfo.businessName}*\n` +
        `Fecha: ${formatDatePE(createdDate)}\n` +
        (expiryDate ? `Válido hasta: ${formatDatePE(expiryDate)}\n` : '') +
        `Cliente: ${customerName}\n` +
        (customerDoc ? `DNI: ${customerDoc}\n` : '') +
        `\n*PRODUCTOS RESERVADOS:*\n${itemsText}\n\n` +
        `*Total Reserva:* ${formatPEN(total)}\n` +
        `*Adelanto Pagado:* ${formatPEN(deposit)}\n` +
        `*Saldo Pendiente:* ${formatPEN(remaining)}\n` +
        (isDelivered ? `*Estado:* ENTREGADO\n` : isCancelled ? `*Estado:* CANCELADO\n` : `*Estado:* PENDIENTE DE RECOJO\n`) +
        `\n_Conserve este comprobante para recoger sus productos._`;

      if (customerPhone) {
        const cleanPhone = customerPhone.replace(/\D/g, '');
        const waUrl = `whatsapp://send?phone=${cleanPhone.length === 9 ? '51' + cleanPhone : cleanPhone}&text=${encodeURIComponent(shareMessage)}`;
        const canOpen = await Linking.canOpenURL(waUrl);
        if (canOpen) {
          await Linking.openURL(waUrl);
          return;
        }
      }

      await Share.share({
        message: shareMessage,
        title: `Reserva #${resNumber} - ${businessInfo.businessName}`,
      });
    } catch (err: any) {
      console.warn('Error compartiendo ticket de reserva:', err);
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={styles.iconBadge}>
                <FileText size={18} color={ui.primary} />
              </View>
              <View>
                <Text style={styles.headerTitle}>Comprobante de Reserva</Text>
                <Text style={styles.headerSubtitle}>#{resNumber}</Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Cerrar ticket">
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Ticket preview scroll */}
          <ScrollView style={styles.receiptScroll} contentContainerStyle={styles.receiptBody} showsVerticalScrollIndicator={false}>
            {/* Cabecera del negocio */}
            <View style={styles.receiptHeader}>
              <Text style={styles.receiptBusinessName}>{businessInfo.businessName}</Text>
              {businessInfo.address ? <Text style={styles.receiptBusinessMeta}>{businessInfo.address}</Text> : null}
              <Text style={styles.receiptBusinessMeta}>RUC: {businessInfo.ruc}</Text>
              {businessInfo.phone ? <Text style={styles.receiptBusinessMeta}>Tel: {businessInfo.phone}</Text> : null}

              <View style={styles.receiptDivider} />

              <Text style={styles.receiptDocTitle}>COMPROBANTE DE RESERVA</Text>
              <Text style={styles.receiptDocNumber}>#{resNumber}</Text>

              <View
                style={[
                  styles.statusBadge,
                  isDelivered && { backgroundColor: '#dcfce7' },
                  isCancelled && { backgroundColor: '#fee2e2' },
                  isPending && { backgroundColor: '#fef3c7' },
                ]}
              >
                <Text
                  style={[
                    styles.statusBadgeText,
                    isDelivered && { color: '#15803d' },
                    isCancelled && { color: '#b91c1c' },
                    isPending && { color: '#b45309' },
                  ]}
                >
                  {isDelivered ? 'ENTREGADO / COMPLETADO' : isCancelled ? 'CANCELADO' : 'PENDIENTE'}
                </Text>
              </View>
            </View>

            <View style={styles.receiptDivider} />

            {/* Fechas */}
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Fecha emisión:</Text>
              <Text style={styles.receiptValue}>{formatDatePE(createdDate)}</Text>
            </View>
            {expiryDate ? (
              <View style={styles.receiptRow}>
                <Text style={styles.receiptLabel}>Válido hasta:</Text>
                <Text style={[styles.receiptValue, { color: ui.danger, fontWeight: '700' }]}>
                  {formatDatePE(expiryDate)}
                </Text>
              </View>
            ) : null}

            <View style={styles.receiptDivider} />

            {/* Cliente */}
            <View style={{ marginBottom: 4 }}>
              <Text style={[styles.receiptLabel, { fontWeight: '700', marginBottom: 2 }]}>CLIENTE:</Text>
              <Text style={styles.receiptCustomerName}>{customerName.toUpperCase()}</Text>
              {customerDoc ? <Text style={styles.receiptCustomerDoc}>DNI/DOC: {customerDoc}</Text> : null}
              {customerPhone ? <Text style={styles.receiptCustomerDoc}>Tel: {customerPhone}</Text> : null}
            </View>

            <View style={styles.receiptDivider} />

            {/* Productos */}
            <Text style={[styles.receiptLabel, { fontWeight: '700', marginBottom: 6 }]}>PRODUCTOS APARTADOS:</Text>
            {(reservation.items || []).map((it: any, idx: number) => {
              const qty = Number(it.quantity || 1);
              const price = Number(it.price || it.unitPrice || 0);
              const lineTotal = Number(it.total || (qty * price));
              return (
                <View key={idx} style={styles.itemRow}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={styles.itemName}>{it.productName || it.name || 'Producto'}</Text>
                    <Text style={styles.itemSub}>{qty} x {formatPEN(price)}</Text>
                  </View>
                  <Text style={styles.itemTotal}>{formatPEN(lineTotal)}</Text>
                </View>
              );
            })}

            <View style={styles.receiptDividerDouble} />

            {/* Totales */}
            <View style={[styles.receiptRow, { marginVertical: 4 }]}>
              <Text style={styles.totalLabel}>TOTAL RESERVA:</Text>
              <Text style={styles.totalValue}>{formatPEN(total)}</Text>
            </View>

            {/* Resumen de Seña y Saldo */}
            <View style={styles.financialBox}>
              <View style={styles.receiptRow}>
                <Text style={styles.depositLabel}>✓ Adelanto / Seña pagada:</Text>
                <Text style={styles.depositValue}>{formatPEN(deposit)}</Text>
              </View>
              {reservation.depositPaymentMethod || reservation.paymentMethod ? (
                <Text style={styles.paymentMethodNotice}>
                  Método de adelanto: {(reservation.depositPaymentMethod || reservation.paymentMethod || 'Efectivo').toUpperCase()}
                </Text>
              ) : null}

              <View style={[styles.receiptRow, { marginTop: 6, borderTopWidth: 1, borderTopColor: '#e2e8f0', paddingTop: 6 }]}>
                <Text style={[styles.remainingLabel, { color: remaining > 0 ? ui.danger : ui.success }]}>
                  {remaining > 0 ? '⏳ Saldo Pendiente:' : '✓ Saldo Cancelado:'}
                </Text>
                <Text style={[styles.remainingValue, { color: remaining > 0 ? ui.danger : ui.success }]}>
                  {formatPEN(remaining)}
                </Text>
              </View>
              {remaining > 0 && !isDelivered ? (
                <Text style={styles.remainingHint}>A pagar al momento de recoger los productos</Text>
              ) : null}
            </View>

            {reservation.notes ? (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.receiptLabel}>Observaciones:</Text>
                <Text style={styles.notesText}>{reservation.notes}</Text>
              </View>
            ) : null}

            <View style={styles.receiptDivider} />
            <Text style={styles.footerNotice}>Conserve este comprobante para recoger su mercadería.</Text>
            <Text style={styles.footerThanks}>¡Gracias por su preferencia!</Text>
          </ScrollView>

          {/* Footer Actions */}
          <View style={styles.footerActions}>
            <TouchableOpacity
              style={styles.printBtn}
              onPress={handlePrint}
              disabled={isPrinting}
              activeOpacity={0.8}
            >
              {isPrinting ? (
                <ActivityIndicator size="small" color={ui.onPrimary} />
              ) : (
                <>
                  <Printer size={18} color={ui.onPrimary} />
                  <Text style={styles.printBtnText}>Imprimir</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.shareBtn}
              onPress={handleShare}
              disabled={isSharing}
              activeOpacity={0.8}
            >
              {isSharing ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <>
                  <Share2 size={18} color={ui.primary} />
                  <Text style={styles.shareBtnText}>Compartir</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.cancelActionBtn} onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.cancelActionBtnText}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '92%',
    backgroundColor: ui.surface,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    backgroundColor: ui.surface,
  },
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  headerSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 20,
  },
  receiptScroll: {
    backgroundColor: '#FAFAFA',
  },
  receiptBody: {
    padding: 18,
  },
  receiptHeader: {
    alignItems: 'center',
  },
  receiptBusinessName: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  receiptBusinessMeta: {
    fontSize: 11.5,
    color: '#64748B',
    textAlign: 'center',
    marginTop: 2,
  },
  receiptDivider: {
    height: 1,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderStyle: 'dashed',
    marginVertical: 12,
    width: '100%',
  },
  receiptDividerDouble: {
    height: 2,
    backgroundColor: '#0F172A',
    marginVertical: 10,
    width: '100%',
  },
  receiptDocTitle: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#1E40AF',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  receiptDocNumber: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
    marginTop: 2,
    textAlign: 'center',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    marginTop: 6,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  receiptRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 2,
  },
  receiptLabel: {
    fontSize: 12,
    color: '#64748B',
  },
  receiptValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0F172A',
  },
  receiptCustomerName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  receiptCustomerDoc: {
    fontSize: 11.5,
    color: '#64748B',
    marginTop: 1,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginVertical: 4,
  },
  itemName: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#0F172A',
  },
  itemSub: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 1,
  },
  itemTotal: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0F172A',
  },
  totalLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  totalValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  financialBox: {
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  depositLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#15803D',
  },
  depositValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#15803D',
  },
  paymentMethodNotice: {
    fontSize: 11,
    color: '#475569',
    marginTop: 2,
  },
  remainingLabel: {
    fontSize: 13,
    fontWeight: '800',
  },
  remainingValue: {
    fontSize: 14,
    fontWeight: '800',
  },
  remainingHint: {
    fontSize: 10.5,
    color: '#B45309',
    textAlign: 'center',
    marginTop: 4,
    fontStyle: 'italic',
  },
  notesText: {
    fontSize: 11.5,
    color: '#475569',
    marginTop: 2,
  },
  footerNotice: {
    fontSize: 11,
    color: '#64748B',
    textAlign: 'center',
    marginTop: 4,
  },
  footerThanks: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginTop: 4,
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    backgroundColor: ui.surface,
  },
  printBtn: {
    flex: 1.2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primary,
    paddingVertical: 12,
    borderRadius: 10,
  },
  printBtnText: {
    color: ui.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  shareBtn: {
    flex: 1.2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primarySoft,
    paddingVertical: 12,
    borderRadius: 10,
  },
  shareBtnText: {
    color: ui.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  cancelActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
  },
  cancelActionBtnText: {
    color: ui.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
});
