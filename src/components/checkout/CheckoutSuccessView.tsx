import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Printer,
  RefreshCw,
  Share2,
} from 'lucide-react-native';
import { ReceiptTicketPreview } from '@/components/ReceiptTicketPreview';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import { buildSaleReceiptEscPos } from '@/lib/printing/escpos-builder';
import type { TaxProfileInput } from '@/lib/invoicing/receipt-amounts';
import {
  getPrinterConfig,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import type { Branch } from '@/types';
import type { CheckoutDocType } from './checkout-types';

export interface CheckoutSuccessViewProps {
  saleResult: any;
  docType: CheckoutDocType;
  receiptBusiness: any;
  resolvedBranch: Branch | null;
  taxProfile: TaxProfileInput | null;
  receiptFooter?: string;
  ticketTemplate?: 'standard' | 'compact';
  onNewSale: () => void;
}

const PAPER_WIDTHS = [80, 58] as const;

/**
 * Post-sale receipt preview + thermal printing / WhatsApp sharing view.
 */
export const CheckoutSuccessView = React.memo<CheckoutSuccessViewProps>(({
  saleResult,
  docType,
  receiptBusiness,
  resolvedBranch,
  taxProfile,
  receiptFooter,
  ticketTemplate = 'standard',
  onNewSale,
}) => {
  const [receiptPaperWidth, setReceiptPaperWidth] = useState<58 | 80>(80);
  const [ticketPrinting, setTicketPrinting] = useState(false);

  useEffect(() => {
    let alive = true;
    getPrinterConfig()
      .then((cfg) => {
        if (alive && (cfg?.paperWidth === 58 || cfg?.paperWidth === 80)) {
          setReceiptPaperWidth(cfg.paperWidth);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const saleObj = saleResult?.saleSnapshot || saleResult;
  const liveSunatStatus = saleObj?.sunatStatus || saleResult?.sunatStatus;
  const liveCdr = saleObj?.cdrDescription || saleResult?.cdrDescription;
  const isQuoteResult = docType === 'cotizacion' || saleObj?.documentType === 'cotizacion';
  const isOfflineSale = Boolean(saleResult?.isOffline || saleObj?.isOfflinePending);
  const isElectronic =
    !isQuoteResult && (saleObj?.documentType === 'boleta' || saleObj?.documentType === 'factura');

  const handlePrintTicket = async () => {
    if (!saleObj) return;
    try {
      setTicketPrinting(true);
      const cfg = await getPrinterConfig();
      const printOptions = {
        paperWidth: receiptPaperWidth,
        autoCut: cfg.autoCut !== false,
        openDrawer: Boolean(cfg.openCashDrawer),
        branch: resolvedBranch,
        taxProfile,
        consultUrl: receiptBusiness.consultUrl,
        receiptFooter,
        ticketTemplate,
      };

      if (cfg.connectionType === 'bluetooth' && cfg.selectedDevice?.address) {
        const escposBytes = buildSaleReceiptEscPos(saleObj, receiptBusiness, printOptions);
        await printRawEscPos(escposBytes, cfg.selectedDevice.address);
      } else {
        await printTicketPDF(
          { sale: saleObj, business: receiptBusiness, options: printOptions },
          printOptions
        );
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Error de Impresión', err?.message || 'No se pudo enviar la orden de impresión.');
    } finally {
      setTicketPrinting(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!saleObj) return;
    try {
      await shareTicketWhatsApp(
        {
          sale: saleObj,
          business: receiptBusiness,
          options: {
            paperWidth: receiptPaperWidth,
            branch: resolvedBranch,
            taxProfile,
            consultUrl: receiptBusiness.consultUrl,
            receiptFooter,
            ticketTemplate,
          },
        },
        receiptBusiness,
        {
          phone: saleObj.customerPhone || '',
          paperWidth: receiptPaperWidth,
          branch: resolvedBranch,
          taxProfile,
          consultUrl: receiptBusiness.consultUrl,
          receiptFooter,
          ticketTemplate,
        }
      );
    } catch {
      try {
        const docLabel =
          saleObj.documentType === 'factura'
            ? 'FACTURA ELECTRÓNICA'
            : saleObj.documentType === 'boleta'
            ? 'BOLETA ELECTRÓNICA'
            : saleObj.documentType === 'cotizacion'
            ? 'COTIZACIÓN'
            : 'NOTA DE VENTA';

        const correlative =
          saleObj.documentNumber || saleObj.correlative || `#${saleObj.saleNumber || ''}`;
        const itemsList: any[] = Array.isArray(saleObj.items) ? saleObj.items : [];
        const itemsText = itemsList
          .map(
            (i) =>
              `• ${i.quantity}x ${i.name} - ${formatPEN(
                i.lineTotal !== undefined ? i.lineTotal : i.price * i.quantity
              )}`
          )
          .join('\n');

        const message =
          `*${receiptBusiness.businessName || 'VENTIFY'}*\n` +
          (receiptBusiness.ruc ? `RUC: ${receiptBusiness.ruc}\n` : '') +
          `🧾 *${docLabel}*: ${correlative}\n` +
          `📅 *Fecha*: ${formatDatePE(saleObj.date || Date.now())}\n` +
          (saleObj.customerName ? `👤 *Cliente*: ${saleObj.customerName}\n` : '') +
          (saleObj.customerRuc ? `🏢 *RUC*: ${saleObj.customerRuc}\n` : '') +
          (saleObj.customerDni ? `🆔 *DNI*: ${saleObj.customerDni}\n` : '') +
          `\n*DETALLE DE COMPRA:*\n${itemsText}\n\n` +
          `💰 *TOTAL: ${formatPEN(saleObj.total || 0)}*\n` +
          `💳 *Método de Pago*: ${String(
            saleObj.paymentMethodName || saleObj.paymentMethod || ''
          ).toUpperCase()}\n` +
          (saleObj.changeGiven > 0 ? `💵 *Vuelto*: ${formatPEN(saleObj.changeGiven)}\n` : '') +
          `\n_${receiptFooter || receiptBusiness?.receiptFooter || '¡Muchas gracias por su preferencia!'}_`;

        const cleanPhone = String(saleObj.customerPhone || '').replace(/\D/g, '');
        const whatsappUrl = cleanPhone
          ? `whatsapp://send?phone=${
              cleanPhone.startsWith('51') ? cleanPhone : '51' + cleanPhone
            }&text=${encodeURIComponent(message)}`
          : `whatsapp://send?text=${encodeURIComponent(message)}`;

        const canOpen = await Linking.canOpenURL(whatsappUrl);
        if (canOpen) {
          await Linking.openURL(whatsappUrl);
        } else {
          await Share.share({ message });
        }
      } catch {
        Alert.alert('WhatsApp', 'No se pudo abrir WhatsApp para compartir el comprobante.');
      }
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.successContainer}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
    >
      <View style={styles.successCard}>
        {/* Banner de estado SUNAT / Offline / Cotización */}
        <View style={styles.sunatLiveBanner}>
          {isQuoteResult ? (
            <>
              <FileText size={16} color={ui.primary} />
              <Text style={[styles.sunatLiveBannerText, { color: ui.primary }]}>
                Cotización generada (sin cobro ni descuento de stock)
              </Text>
            </>
          ) : isOfflineSale ? (
            <>
              <Clock size={16} color={ui.warning} />
              <Text style={[styles.sunatLiveBannerText, { color: ui.warning }]}>
                Guardada offline · Se sincronizará al recuperar conexión
              </Text>
            </>
          ) : isElectronic ? (
            liveSunatStatus === 'accepted' ? (
              <>
                <CheckCircle2 size={16} color={ui.primary} />
                <Text style={[styles.sunatLiveBannerText, { color: ui.primary }]}>
                  {liveCdr ? `SUNAT: ${liveCdr}` : 'SUNAT: Comprobante Aceptado'}
                </Text>
              </>
            ) : liveSunatStatus === 'rejected' || liveSunatStatus === 'error' ? (
              <>
                <AlertCircle size={16} color={ui.danger} />
                <Text style={[styles.sunatLiveBannerText, { color: ui.danger }]}>
                  {liveCdr
                    ? `SUNAT: ${liveCdr}`
                    : 'Pendiente de reenvío ante SUNAT · Puedes reintentar desde Historial'}
                </Text>
              </>
            ) : (
              <>
                <ActivityIndicator size="small" color={ui.primary} />
                <Text style={styles.sunatLiveBannerText}>
                  Emitiendo comprobante electrónico ante SUNAT...
                </Text>
              </>
            )
          ) : (
            <>
              <CheckCircle2 size={16} color={ui.primary} />
              <Text style={[styles.sunatLiveBannerText, { color: ui.primary }]}>
                Venta registrada correctamente
              </Text>
            </>
          )}
        </View>

        {/* Selector de Ancho de Papel (80mm / 58mm) */}
        <View style={styles.paperWidthRow}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: ui.textSecondary }}>
            Formato de ticket:
          </Text>
          <View style={styles.paperWidthChipRow}>
            {PAPER_WIDTHS.map((width) => {
              const active = receiptPaperWidth === width;
              return (
                <TouchableOpacity
                  key={width}
                  style={[styles.paperWidthChip, active && styles.paperWidthChipActive]}
                  onPress={() => setReceiptPaperWidth(width)}
                >
                  <Text
                    style={[
                      styles.paperWidthChipText,
                      active && styles.paperWidthChipTextActive,
                    ]}
                  >
                    {width}mm
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Vista Previa Ticket Idéntica a la Web */}
        {saleObj ? (
          <View style={{ width: '100%', alignItems: 'center', marginBottom: 14 }}>
            <ReceiptTicketPreview
              sale={saleObj}
              business={receiptBusiness}
              branch={resolvedBranch}
              taxProfile={taxProfile}
              receiptFooter={receiptFooter}
              paperWidth={receiptPaperWidth}
              compact={ticketTemplate === 'compact'}
            />
          </View>
        ) : null}

        {/* 3 Acciones Inmediatas */}
        <View style={styles.postActionsWrapper}>
          <TouchableOpacity
            style={[styles.postActionBtn, styles.postActionPrint]}
            onPress={handlePrintTicket}
            disabled={ticketPrinting}
            activeOpacity={0.8}
          >
            {ticketPrinting ? (
              <ActivityIndicator color={ui.onPrimary} size="small" />
            ) : (
              <>
                <Printer size={20} color={ui.onPrimary} />
                <Text style={styles.postActionBtnText}>Imprimir Ticket Térmico</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.postActionBtn, styles.postActionWhatsapp]}
            onPress={handleShareWhatsApp}
            activeOpacity={0.8}
          >
            <Share2 size={20} color={ui.onPrimary} />
            <Text style={styles.postActionBtnText}>Enviar por WhatsApp</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.postActionBtn, styles.postActionNew]}
            onPress={onNewSale}
            activeOpacity={0.8}
          >
            <RefreshCw size={20} color={ui.text} />
            <Text style={styles.postActionNewText}>Iniciar Nueva Venta</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  successContainer: {
    padding: 20,
    alignItems: 'center',
  },
  successCard: {
    width: '100%',
    backgroundColor: ui.surface,
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  sunatLiveBanner: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    marginBottom: 10,
  },
  sunatLiveBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  paperWidthRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 8,
  },
  paperWidthChipRow: {
    flexDirection: 'row',
    gap: 6,
  },
  paperWidthChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
  },
  paperWidthChipActive: {
    backgroundColor: ui.text,
    borderColor: ui.text,
  },
  paperWidthChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  paperWidthChipTextActive: {
    color: ui.surface,
  },
  postActionsWrapper: {
    width: '100%',
    gap: 10,
    marginTop: 18,
  },
  postActionBtn: {
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  postActionPrint: {
    backgroundColor: ui.text,
  },
  postActionWhatsapp: {
    backgroundColor: '#25D366',
  },
  postActionNew: {
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  postActionBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.surface,
  },
  postActionNewText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
});
