import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Share,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Print from 'expo-print';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import { X, Printer, Share2, FileText } from 'lucide-react-native';
import { useBusinessSettings } from '@/context/SettingsContext';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { buildReservationReceiptHtml } from '@/lib/printing/escpos-builder';
import {
  resolvePrintableLogoDataUri,
  resolveReceiptBusiness,
} from '@/lib/invoicing/receipt-business';
import { getPrinterConfig } from '@/services/thermal-printer-service';
import type { Branch } from '@/types';

interface ReservationReceiptModalProps {
  visible: boolean;
  onClose: () => void;
  reservation: any;
  business?: any;
  branch?: Partial<Branch> | null;
}

const PAPER_WIDTHS = [80, 58] as const;

const ReservationReceiptModalContent: React.FC<ReservationReceiptModalProps> = React.memo(({
  visible,
  onClose,
  reservation,
  business: propBusiness,
  branch: propBranch,
}) => {
  const insets = useSafeAreaInsets();
  const {
    businessData,
    businessSettings,
    activeBranch,
    posSettings,
    emitterInfo,
  } = useBusinessSettings();
  const effectiveBusiness = propBusiness || businessSettings || businessData;
  const effectiveBranch = propBranch ?? activeBranch;
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80);
  const [isPrinting, setIsPrinting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  useEffect(() => {
    let alive = true;
    getPrinterConfig()
      .then((cfg) => {
        if (alive && (cfg?.paperWidth === 58 || cfg?.paperWidth === 80)) {
          setPaperWidth(cfg.paperWidth);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

  const createdDate = useMemo(
    () =>
      reservation.createdAt
        ? (typeof reservation.createdAt?.toDate === 'function' ? reservation.createdAt.toDate() : new Date(reservation.createdAt))
        : (reservation.date ? new Date(reservation.date) : new Date()),
    [reservation.createdAt, reservation.date]
  );

  const expiryDate = useMemo(
    () =>
      reservation.expiryDate
        ? (typeof reservation.expiryDate?.toDate === 'function' ? reservation.expiryDate.toDate() : new Date(reservation.expiryDate))
        : (reservation.pickupDate ? new Date(reservation.pickupDate) : null),
    [reservation.expiryDate, reservation.pickupDate]
  );

  const ticketTemplate =
    posSettings?.ticketTemplate === 'compact' ? 'compact' : 'standard';
  const isCompact = ticketTemplate === 'compact';

  const resolvedBiz = useMemo(
    () =>
      resolveReceiptBusiness({
        business: effectiveBusiness,
        branch: effectiveBranch,
        posSettings,
        emitter: emitterInfo,
        ticketTemplate,
        defaultFooter: '¡Gracias por su preferencia!',
      }),
    [effectiveBusiness, effectiveBranch, posSettings, emitterInfo, ticketTemplate]
  );

  const razonSocialSubtitle =
    resolvedBiz.razonSocial &&
    resolvedBiz.razonSocial.toLowerCase() !== resolvedBiz.businessName.toLowerCase()
      ? resolvedBiz.razonSocial
      : '';

  const handlePrint = async () => {
    try {
      setIsPrinting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const printableLogo =
        resolvedBiz.showLogo && resolvedBiz.logoUri
          ? await resolvePrintableLogoDataUri(resolvedBiz.logoUri)
          : undefined;
      const printableBusiness = {
        ...(effectiveBusiness || {}),
        ...(printableLogo ? { receiptLogoDataUrl: printableLogo } : {}),
      };
      const printableBranch = effectiveBranch
        ? {
            ...effectiveBranch,
            ...(printableLogo ? { receiptLogoDataUrl: printableLogo } : {}),
          }
        : effectiveBranch;
      const html = buildReservationReceiptHtml(reservation, printableBusiness, {
        paperWidth,
        branch: printableBranch,
        posSettings,
        receiptFooter: resolvedBiz.hasCustomFooter ? resolvedBiz.receiptFooter : undefined,
        ticketTemplate,
      });
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

      const shareMessage =
        `*COMPROBANTE DE RESERVA #${resNumber}*\n` +
        `*${resolvedBiz.businessName}*\n` +
        (resolvedBiz.showRuc && resolvedBiz.ruc ? `RUC: ${resolvedBiz.ruc}\n` : '') +
        (resolvedBiz.showAddress && resolvedBiz.fiscalAddress ? `${resolvedBiz.fiscalAddress}\n` : '') +
        (resolvedBiz.showPhone && resolvedBiz.phone ? `Tel: ${resolvedBiz.phone}\n` : '') +
        `Fecha: ${formatDatePE(createdDate)}\n` +
        (expiryDate ? `Válido hasta: ${formatDatePE(expiryDate)}\n` : '') +
        `Cliente: ${customerName}\n` +
        (customerDoc ? `DNI/DOC: ${customerDoc}\n` : '') +
        `\n*PRODUCTOS RESERVADOS:*\n${itemsText}\n\n` +
        `*Total Reserva:* ${formatPEN(total)}\n` +
        `*Adelanto Pagado:* ${formatPEN(deposit)}\n` +
        `*Saldo Pendiente:* ${formatPEN(remaining)}\n` +
        (isDelivered ? `*Estado:* ENTREGADO\n` : isCancelled ? `*Estado:* CANCELADO\n` : `*Estado:* PENDIENTE DE RECOJO\n`) +
        (isPending ? `\n_Conserve este comprobante para recoger sus productos._` : '') +
        `\n_${resolvedBiz.receiptFooter}_`;

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
        title: `Reserva #${resNumber} - ${resolvedBiz.businessName}`,
      });
    } catch (err: any) {
      console.warn('Error compartiendo ticket de reserva:', err);
    } finally {
      setIsSharing(false);
    }
  };

  const paperMaxWidth = paperWidth === 58 ? 290 : 350;

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View
        collapsable={false}
        style={[
          styles.overlay,
          {
            paddingTop: Math.max(insets.top, 16),
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
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

          <View style={styles.paperWidthBar}>
            <Text style={styles.paperWidthLabel}>Formato de ticket:</Text>
            <View style={styles.paperWidthChips}>
              {PAPER_WIDTHS.map((w) => {
                const active = paperWidth === w;
                return (
                  <TouchableOpacity
                    key={w}
                    onPress={() => setPaperWidth(w)}
                    style={[styles.paperChip, active && styles.paperChipActive]}
                    accessibilityRole="button"
                    accessibilityLabel={`Formato ${w} milímetros`}
                  >
                    <Text style={[styles.paperChipText, active && styles.paperChipTextActive]}>
                      {w}mm
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Ticket preview scroll */}
          <ScrollView style={styles.receiptScroll} contentContainerStyle={styles.receiptBody} showsVerticalScrollIndicator={false}>
            <View style={[styles.paperSheet, { maxWidth: paperMaxWidth }]}>
              {/* Cabecera del negocio */}
              <View style={styles.receiptHeader}>
                {resolvedBiz.showLogo && Boolean(resolvedBiz.logoUri) && (
                  <Image
                    source={{ uri: resolvedBiz.logoUri }}
                    style={styles.logo}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                )}
                <Text style={styles.receiptBusinessName}>{resolvedBiz.businessName}</Text>
                {Boolean(razonSocialSubtitle) && (
                  <Text style={styles.receiptBusinessMeta}>{razonSocialSubtitle}</Text>
                )}
                {Boolean(resolvedBiz.branchName) && (
                  <Text style={styles.receiptBusinessMeta}>Sucursal: {resolvedBiz.branchName}</Text>
                )}
                {!isCompact && resolvedBiz.showSlogan && Boolean(resolvedBiz.slogan) && (
                  <Text style={styles.receiptSlogan}>{resolvedBiz.slogan}</Text>
                )}
                {Boolean(resolvedBiz.receiptHeader) && (
                  <Text style={styles.receiptBusinessMeta}>{resolvedBiz.receiptHeader}</Text>
                )}
                {resolvedBiz.showAddress && Boolean(resolvedBiz.fiscalAddress) && (
                  <Text style={styles.receiptBusinessMeta}>{resolvedBiz.fiscalAddress}</Text>
                )}
                {resolvedBiz.showAddress && Boolean(resolvedBiz.commercialAddress) && (
                  <Text style={styles.receiptBusinessMeta}>Tienda: {resolvedBiz.commercialAddress}</Text>
                )}
                {resolvedBiz.showRuc && Boolean(resolvedBiz.ruc) && (
                  <Text style={[styles.receiptBusinessMeta, styles.receiptRucText]}>
                    RUC: {resolvedBiz.ruc}
                  </Text>
                )}
                {resolvedBiz.showPhone && Boolean(resolvedBiz.phone) && (
                  <Text style={styles.receiptBusinessMeta}>Tel: {resolvedBiz.phone}</Text>
                )}
                {!isCompact && resolvedBiz.showEmail && Boolean(resolvedBiz.email) && (
                  <Text style={styles.receiptBusinessMeta}>{resolvedBiz.email}</Text>
                )}
                {!isCompact && Boolean(resolvedBiz.website) && (
                  <Text style={styles.receiptBusinessMeta}>{resolvedBiz.website}</Text>
                )}

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
                {remaining > 0 && isPending ? (
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
              {isPending ? (
                <Text style={styles.footerNotice}>
                  Conserve este comprobante para recoger su mercadería.
                </Text>
              ) : null}
              <Text style={styles.footerThanks}>{resolvedBiz.receiptFooter}</Text>
            </View>
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

export const ReservationReceiptModal: React.FC<ReservationReceiptModalProps> = React.memo((props) => {
  if (!props.visible || !props.reservation) return null;
  return <ReservationReceiptModalContent {...props} />;
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
  paperWidthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    backgroundColor: ui.surfaceMuted,
  },
  paperWidthLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  paperWidthChips: {
    flexDirection: 'row',
    gap: 6,
  },
  paperChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
  },
  paperChipActive: {
    backgroundColor: ui.text,
    borderColor: ui.text,
  },
  paperChipText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  paperChipTextActive: {
    color: ui.surface,
  },
  receiptScroll: {
    backgroundColor: '#F3F4F6',
  },
  receiptBody: {
    padding: 14,
    alignItems: 'center',
  },
  paperSheet: {
    width: '100%',
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
  },
  logo: {
    width: 112,
    height: 48,
    marginBottom: 6,
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
  receiptSlogan: {
    fontSize: 10.5,
    fontStyle: 'italic',
    color: '#4B5563',
    textAlign: 'center',
    marginTop: 2,
  },
  receiptRucText: {
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 3,
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
