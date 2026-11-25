import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Printer, Receipt, Share2, X } from 'lucide-react-native';

import { ReceiptTicketPreview } from '@/components/ReceiptTicketPreview';
import { useBusinessSettings } from '@/context/SettingsContext';
import { resolveReceiptBusiness } from '@/lib/invoicing/receipt-business';
import {
  buildSaleReceiptEscPos,
  resolveReceiptDocumentMeta,
} from '@/lib/printing/escpos-builder';
import { ui } from '@/lib/theme';
import {
  getPrinterConfig,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import type { Branch, Sale } from '@/types';

export interface SaleReceiptModalProps {
  visible: boolean;
  sale: Sale | null;
  onClose: () => void;
  branch?: Partial<Branch> | null;
}

const PAPER_WIDTHS = [80, 58] as const;

const SaleReceiptModalContent: React.FC<{
  visible: boolean;
  sale: Sale;
  onClose: () => void;
  branch?: Partial<Branch> | null;
}> = React.memo(({ visible, sale, onClose, branch: propBranch }) => {
  const insets = useSafeAreaInsets();
  const {
    businessSettings,
    businessData,
    activeBranch,
    branches,
    posSettings,
    taxProfile,
    emitterInfo,
  } = useBusinessSettings();

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

  const resolvedBranch = useMemo(() => {
    if (propBranch) return propBranch;
    if (sale.branchId) {
      return branches.find((b) => b.id === sale.branchId) || activeBranch || null;
    }
    return activeBranch || null;
  }, [propBranch, sale.branchId, branches, activeBranch]);

  const resolvedBiz = useMemo(
    () =>
      resolveReceiptBusiness({
        business: businessSettings || businessData,
        branch: resolvedBranch,
        posSettings,
        emitter: emitterInfo,
        ticketTemplate: posSettings?.ticketTemplate,
      }),
    [businessSettings, businessData, resolvedBranch, posSettings, emitterInfo]
  );

  const docMeta = useMemo(() => resolveReceiptDocumentMeta(sale), [sale]);

  const handlePrint = async () => {
    try {
      setIsPrinting(true);
      const cfg = await getPrinterConfig();
      const printOptions = {
        paperWidth,
        autoCut: cfg.autoCut !== false,
        openDrawer: Boolean(cfg.openCashDrawer),
        branch: resolvedBranch,
        taxProfile,
        consultUrl: resolvedBiz.consultUrl,
        receiptFooter: resolvedBiz.hasCustomFooter ? resolvedBiz.receiptFooter : undefined,
        ticketTemplate: resolvedBiz.ticketTemplate,
      };
      let printedBt = false;
      if (cfg.connectionType === 'bluetooth' && cfg.selectedDevice?.address) {
        const bytes = buildSaleReceiptEscPos(sale, resolvedBiz, printOptions);
        printedBt = await printRawEscPos(bytes, cfg.selectedDevice.address);
      }
      if (!printedBt) {
        await printTicketPDF(
          {
            title: `Ticket_${docMeta.docNumber || sale.id}`,
            sale,
            business: resolvedBiz,
            options: printOptions,
          },
          printOptions
        );
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (err: any) {
      Alert.alert(
        'Error de Impresión',
        err?.message || 'No se pudo emitir el comprobante.'
      );
    } finally {
      setIsPrinting(false);
    }
  };

  const handleShareWhatsApp = async () => {
    try {
      setIsSharing(true);
      const shareOptions = {
        phone: sale.customerPhone || '',
        paperWidth,
        branch: resolvedBranch,
        taxProfile,
        consultUrl: resolvedBiz.consultUrl,
        receiptFooter: resolvedBiz.hasCustomFooter ? resolvedBiz.receiptFooter : undefined,
        ticketTemplate: resolvedBiz.ticketTemplate,
      };
      await shareTicketWhatsApp(
        {
          sale,
          business: resolvedBiz,
          options: shareOptions,
        },
        resolvedBiz,
        shareOptions
      );
    } catch (err: any) {
      Alert.alert(
        'WhatsApp',
        err?.message || 'No se pudo compartir el comprobante por WhatsApp.'
      );
    } finally {
      setIsSharing(false);
    }
  };

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
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.iconBadge}>
                <Receipt size={18} color={ui.primary} />
              </View>
              <View style={styles.headerTextWrap}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {docMeta.displayTitle}
                </Text>
                <Text style={styles.headerSubtitle} numberOfLines={1}>
                  {docMeta.docNumber}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Cerrar comprobante"
            >
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

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollBody}
            showsVerticalScrollIndicator={false}
          >
            <ReceiptTicketPreview
              sale={sale}
              business={resolvedBiz}
              branch={resolvedBranch}
              taxProfile={taxProfile}
              receiptFooter={resolvedBiz.hasCustomFooter ? resolvedBiz.receiptFooter : undefined}
              paperWidth={paperWidth}
              compact={resolvedBiz.ticketTemplate === 'compact'}
            />
          </ScrollView>

          <View style={styles.footerActions}>
            <TouchableOpacity
              style={[styles.primaryActionBtn, isPrinting && styles.btnDisabled]}
              onPress={() => void handlePrint()}
              disabled={isPrinting}
              accessibilityRole="button"
            >
              {isPrinting ? (
                <ActivityIndicator size="small" color={ui.onPrimary} />
              ) : (
                <>
                  <Printer size={18} color={ui.onPrimary} />
                  <Text style={styles.primaryActionText}>Imprimir Ticket Térmico</Text>
                </>
              )}
            </TouchableOpacity>

            <View style={styles.secondaryRow}>
              <TouchableOpacity
                style={[styles.whatsappBtn, isSharing && styles.btnDisabled]}
                onPress={() => void handleShareWhatsApp()}
                disabled={isSharing}
                accessibilityRole="button"
              >
                {isSharing ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Share2 size={17} color="#FFFFFF" />
                    <Text style={styles.whatsappBtnText}>Enviar por WhatsApp</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.closeFooterBtn}
                onPress={onClose}
                accessibilityRole="button"
              >
                <Text style={styles.closeFooterText}>Cerrar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
});

SaleReceiptModalContent.displayName = 'SaleReceiptModalContent';

export const SaleReceiptModal: React.FC<SaleReceiptModalProps> = React.memo((props) => {
  if (!props.visible || !props.sale) return null;
  return (
    <SaleReceiptModalContent
      visible={props.visible}
      sale={props.sale}
      onClose={props.onClose}
      branch={props.branch}
    />
  );
});

SaleReceiptModal.displayName = 'SaleReceiptModal';

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.58)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '92%',
    backgroundColor: ui.surface,
    borderRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  headerTextWrap: {
    flex: 1,
    minWidth: 0,
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
  scroll: {
    backgroundColor: '#F3F4F6',
  },
  scrollBody: {
    padding: 14,
    alignItems: 'center',
  },
  footerActions: {
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    backgroundColor: ui.surface,
  },
  primaryActionBtn: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: ui.text,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  primaryActionText: {
    color: ui.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  whatsappBtn: {
    flex: 1.6,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: '#25D366',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  whatsappBtnText: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '700',
  },
  closeFooterBtn: {
    flex: 0.7,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 12,
  },
  closeFooterText: {
    color: ui.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.6,
  },
});
