import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path, Rect } from 'react-native-svg';
import type { Branch, BusinessSettings, Sale } from '@/types';
import { formatDatePE, ui } from '@/lib/theme';
import { amountToWordsSoles } from '@/lib/invoicing/types';
import { receiptAmountsForSale, type TaxProfileInput } from '@/lib/invoicing/receipt-amounts';
import { buildSaleQrContent } from '@/lib/invoicing/qr-content';
import { generateQrSvgData } from '@/lib/invoicing/qr-matrix';
import { resolveReceiptBusiness } from '@/lib/invoicing/receipt-business';

export interface ReceiptTicketPreviewProps {
  sale: Partial<Sale> & {
    items: Sale['items'];
    total: number;
    date?: any;
    paymentMethod?: string;
    isOffline?: boolean;
    offlineQueued?: boolean;
    isQuote?: boolean;
    cdrDescription?: string;
    userName?: string;
    qrContent?: string;
    consultUrl?: string;
    footerNote?: string;
    sunatHash?: string;
  };
  business?: Partial<BusinessSettings & Branch> | null;
  branch?: Partial<Branch> | null;
  taxProfile?: TaxProfileInput | null;
  receiptFooter?: string;
  paperWidth?: 58 | 80;
  compact?: boolean;
}

const formatMethodName = (method?: string, provider?: string): string => {
  const m = String(method || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  if (p === 'yape' || m === 'yape') return 'Yape';
  if (p === 'plin' || m === 'plin') return 'Plin';
  if (m === 'cash' || m === 'efectivo') return 'Efectivo';
  if (m === 'card' || m === 'tarjeta') return 'Tarjeta';
  if (m === 'transfer' || m === 'transferencia') return 'Transferencia';
  if (m === 'fiado' || m === 'credit') return 'Crédito / Fiado';
  if (m === 'mixed' || m === 'mixto') return 'Pago Mixto';
  return method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Efectivo';
};

/**
 * Replica fiel del ticket térmico de Ventify Web (`ReceiptContent` / `ElectronicReceiptContent`)
 * para vista previa en pantalla tras vender y en el historial de comprobantes.
 */
export const ReceiptTicketPreview: React.FC<ReceiptTicketPreviewProps> = React.memo(
  ({ sale, business, branch, taxProfile, receiptFooter, paperWidth = 80, compact = false }) => {
    const resolved = useMemo(
      () =>
        resolveReceiptBusiness({
          business,
          branch,
          receiptFooter,
          consultUrl: sale.consultUrl,
          saleFooterNote: sale.footerNote,
          ticketTemplate: compact ? 'compact' : undefined,
        }),
      [business, branch, receiptFooter, sale.consultUrl, sale.footerNote, compact]
    );

    const rawDocType = String(sale.documentType || 'nota_venta').toLowerCase();
    const isQuote =
      Boolean(sale.isQuote) ||
      rawDocType === 'quote' ||
      rawDocType === 'cot' ||
      rawDocType === 'cotizacion';
    const isFacturaDoc = rawDocType === 'factura' || rawDocType === '01';
    const isBoletaDoc = rawDocType === 'boleta' || rawDocType === '03';
    const isCreditNote = rawDocType === 'credit_note' || rawDocType === '07';
    const isDebitNote = rawDocType === 'debit_note' || rawDocType === '08';
    const isOfflinePending = Boolean(
      sale.isOffline || sale.offlineQueued || (sale as any).isOfflinePending
    );
    const isFacturaAccepted =
      isFacturaDoc && sale.sunatStatus === 'accepted' && !isOfflinePending;
    const isFiscalTitle = isBoletaDoc || isFacturaAccepted || isCreditNote || isDebitNote;

    // Regla Web: Factura no aceptada aún se degrada visualmente a Nota de Venta para protección tributaria
    let documentTitle = 'NOTA DE VENTA';
    if (isQuote) {
      documentTitle = 'COTIZACIÓN';
    } else if (isFacturaAccepted) {
      documentTitle = 'FACTURA ELECTRÓNICA';
    } else if (isBoletaDoc) {
      documentTitle = 'BOLETA DE VENTA ELECTRÓNICA';
    } else if (isCreditNote) {
      documentTitle = 'NOTA DE CRÉDITO ELECTRÓNICA';
    } else if (isDebitNote) {
      documentTitle = 'NOTA DE DÉBITO ELECTRÓNICA';
    }

    const displayNumber = (() => {
      const fallbackNv = sale.saleNumber ? `NV-${String(sale.saleNumber).padStart(6, '0')}` : 'S/N';
      if (isFacturaDoc && !isFacturaAccepted) {
        const corr = sale.correlative ? String(sale.correlative) : '';
        return corr && !corr.toUpperCase().startsWith('F') ? corr : fallbackNv;
      }
      return (
        sale.documentNumber ||
        sale.correlative ||
        (sale.saleNumber ? `#${String(sale.saleNumber).padStart(6, '0')}` : 'S/N')
      );
    })();

    const amounts = useMemo(
      () => receiptAmountsForSale(sale, sale.fiscalAmounts, taxProfile),
      [sale, taxProfile]
    );
    const amountInWords = useMemo(
      () => amountToWordsSoles(amounts.total),
      [amounts.total]
    );

    const logoUri = resolved.showLogo ? resolved.logoUri : '';
    const ruc = resolved.ruc;
    const fiscalAddress = resolved.fiscalAddress;
    const storeAddress = resolved.commercialAddress;
    const businessName = resolved.businessName;
    const branchSubtitle = resolved.branchName;
    const razonSocialSubtitle =
      resolved.razonSocial &&
      resolved.razonSocial.toLowerCase() !== resolved.businessName.toLowerCase()
        ? resolved.razonSocial
        : '';
    const slogan = resolved.showSlogan && !compact ? resolved.slogan : '';
    const receiptHeader = resolved.receiptHeader;
    const phone = resolved.phone;
    const email = !compact ? resolved.email : '';
    const website = !compact ? resolved.website : '';

    const customerName =
      sale.receiptCustomer?.name ||
      sale.customerName ||
      'CLIENTE GENERAL';
    const customerDocNumber =
      sale.receiptCustomer?.identityNumber ||
      sale.customerRuc ||
      sale.customerDni ||
      (sale as any).customerDocNumber ||
      '';
    const customerAddress =
      sale.receiptCustomer?.address || sale.customerAddress || '';

    const sunatBadge = useMemo(() => {
      if (isQuote) {
        return {
          label: 'Cotización comercial · No válida como comprobante de pago',
          bg: ui.primarySoft,
          color: ui.primary,
        };
      }
      if (isOfflinePending) {
        return {
          label: 'En cola offline · pendiente de sincronización',
          bg: ui.warningSoft,
          color: '#92400E',
        };
      }
      if (isBoletaDoc || isFacturaDoc || isCreditNote || isDebitNote) {
        if (sale.sunatStatus === 'accepted') {
          return {
            label: sale.cdrDescription || 'Comprobante aceptado por SUNAT',
            bg: ui.successSoft,
            color: '#065F46',
          };
        }
        if (sale.sunatStatus === 'rejected' || sale.sunatStatus === 'error') {
          return {
            label: `SUNAT: ${sale.cdrDescription || 'Observado / Error de envío'}`,
            bg: ui.dangerSoft,
            color: ui.danger,
          };
        }
        return {
          label: 'Pendiente de respuesta SUNAT',
          bg: ui.warningSoft,
          color: '#92400E',
        };
      }
      return {
        label: 'Documento interno · sin valor tributario SUNAT',
        bg: ui.surfaceMuted,
        color: ui.textSecondary,
      };
    }, [isQuote, isOfflinePending, isBoletaDoc, isFacturaDoc, isCreditNote, isDebitNote, sale.sunatStatus, sale.cdrDescription]);

    const qrContent = useMemo(
      () =>
        buildSaleQrContent(sale, {
          emitterRuc: ruc,
          consultUrl: resolved.consultUrl,
          taxProfile,
          precomputedAmounts: amounts,
        }),
      [sale, ruc, resolved.consultUrl, taxProfile, amounts]
    );

    const qrSvgData = useMemo(() => {
      if (!qrContent) return null;
      try {
        return generateQrSvgData(qrContent);
      } catch {
        return null;
      }
    }, [qrContent]);

    const discountAmount = Math.round(Number(sale.discountAmount ?? 0) * 100) / 100;
    const shippingAmount = Math.round(Number(sale.shippingAmount ?? 0) * 100) / 100;
    const surchargeAmount = Math.round(Number(sale.surchargeAmount ?? 0) * 100) / 100;
    const effectiveCharged = Math.round(Number(sale.chargedAmount ?? amounts.total) * 100) / 100;
    const cashReceived = Number(sale.cashReceived ?? 0);
    const changeGiven =
      sale.changeGiven !== undefined
        ? Number(sale.changeGiven)
        : cashReceived > effectiveCharged
          ? Math.round((cashReceived - effectiveCharged) * 100) / 100
          : 0;

    const sunatHash = (sale as any).sunatHash || (sale as any).hash || '';
    const resolutionText =
      sale.printedFormatResolution || resolved.printedFormatResolution || '';
    const footerText = resolved.receiptFooter;

    const ticketMaxWidth = paperWidth === 58 ? 276 : 332;

    return (
      <View style={[styles.ticketPaper, { maxWidth: ticketMaxWidth }, compact && styles.ticketPaperCompact]}>
        {/* Encabezado emisor */}
        <View style={styles.centerBlock}>
          {Boolean(logoUri) && (
            <Image
              source={{ uri: logoUri }}
              style={styles.logo}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          )}
          <Text style={styles.businessTitle}>{businessName}</Text>
          {Boolean(razonSocialSubtitle) && (
            <Text style={styles.metaCenter}>{razonSocialSubtitle}</Text>
          )}
          {Boolean(branchSubtitle) && (
            <Text style={styles.metaCenter}>Sucursal: {branchSubtitle}</Text>
          )}
          {Boolean(slogan) && <Text style={styles.slogan}>{slogan}</Text>}
          {Boolean(receiptHeader) && (
            <Text style={styles.metaCenter}>{receiptHeader}</Text>
          )}
          {resolved.showRuc && Boolean(ruc) && <Text style={styles.rucLine}>RUC: {ruc}</Text>}
          {resolved.showAddress && Boolean(fiscalAddress) && (
            <Text style={styles.metaCenter}>{fiscalAddress}</Text>
          )}
          {resolved.showAddress && Boolean(storeAddress) && (
            <Text style={styles.metaCenter}>Tienda: {storeAddress}</Text>
          )}
          {resolved.showPhone && Boolean(phone) && <Text style={styles.metaCenter}>Tel: {phone}</Text>}
          {resolved.showEmail && Boolean(email) && <Text style={styles.metaCenter}>Email: {email}</Text>}
          {Boolean(website) && <Text style={styles.metaCenter}>{website}</Text>}
        </View>

        {/* Banner título comprobante */}
        <View style={styles.dashedBox}>
          <Text style={styles.docTitle}>{documentTitle}</Text>
          <Text style={styles.docNumber}>{displayNumber}</Text>
        </View>

        {/* Estado SUNAT / Offline / Interno */}
        <View style={[styles.statusBanner, { backgroundColor: sunatBadge.bg }]}>
          <Text style={[styles.statusText, { color: sunatBadge.color }]} numberOfLines={2}>
            {sunatBadge.label}
          </Text>
        </View>

        {/* Datos operación */}
        <View style={styles.metaSection}>
          <Text style={styles.metaLine}>
            <Text style={styles.boldLabel}>Fecha: </Text>
            {formatDatePE(sale.date || Date.now())}
          </Text>
          {Boolean(sale.userName || sale.completedByName) && (
            <Text style={styles.metaLine}>
              <Text style={styles.boldLabel}>Cajero: </Text>
              {sale.completedByName || sale.userName}
            </Text>
          )}
          {Boolean(sale.sellerName) && (
            <Text style={styles.metaLine}>
              <Text style={styles.boldLabel}>Vendedor: </Text>
              {sale.sellerName}
            </Text>
          )}
          <Text style={styles.metaLine}>
            <Text style={styles.boldLabel}>Cliente: </Text>
            {customerName}
          </Text>
          {Boolean(customerDocNumber) && (
            <Text style={styles.metaLine}>
              <Text style={styles.boldLabel}>
                {customerDocNumber.replace(/\D/g, '').length === 11 ? 'RUC: ' : 'DNI: '}
              </Text>
              {customerDocNumber}
            </Text>
          )}
          {Boolean(customerAddress) && (
            <Text style={styles.metaLine}>
              <Text style={styles.boldLabel}>Dir.: </Text>
              {customerAddress}
            </Text>
          )}
        </View>

        <View style={styles.dashedDivider} />

        {/* Cabecera 2 líneas (Web parity) */}
        <View style={styles.tableHeader}>
          <Text style={[styles.thCell, { flex: 1.5 }]}>SKU</Text>
          <Text style={[styles.thCell, { flex: 1, textAlign: 'center' }]}>CANT</Text>
          <Text style={[styles.thCell, { flex: 1, textAlign: 'right' }]}>PRECIO</Text>
          <Text style={[styles.thCell, { flex: 1.1, textAlign: 'right' }]}>TOTAL</Text>
        </View>

        {/* Lista de ítems */}
        <View style={styles.itemsList}>
          {(sale.items || []).map((item, idx) => {
            const qty = Number(item.quantity || 1);
            const unitPrice = Number(item.price || 0);
            const lineTotal = Number(item.lineTotal ?? qty * unitPrice);
            const origPrice = Number(item.originalPrice ?? unitPrice);
            const hasLineDiscount = origPrice > unitPrice + 0.005;
            const unitLabel = item.unitOfMeasure || 'und';
            const skuText = (item as any).sku || (item as any).productCode || '---';

            return (
              <View key={`${item.id || idx}-${idx}`} style={styles.itemBlock}>
                <Text style={styles.itemName}>
                  {item.name}
                  {(item.presentation?.name || (item as any).presentationName)
                    ? ` (${item.presentation?.name || (item as any).presentationName})`
                    : ''}
                  {(item.variant?.name || (item as any).variantName)
                    ? ` [${item.variant?.name || (item as any).variantName}]`
                    : ''}
                  {!hasLineDiscount && item.modifiedPrice !== undefined && item.modifiedPrice !== null
                    ? ' (mod.)'
                    : ''}
                </Text>
                <View style={styles.itemDetailRow}>
                  <Text style={[styles.tdCell, { flex: 1.5 }]} numberOfLines={1}>
                    {skuText}
                  </Text>
                  <Text style={[styles.tdCell, { flex: 1, textAlign: 'center' }]}>
                    {qty} {unitLabel}
                  </Text>
                  <Text style={[styles.tdCell, { flex: 1, textAlign: 'right' }]}>
                    {unitPrice.toFixed(2)}
                  </Text>
                  <View style={{ flex: 1.1, alignItems: 'flex-end' }}>
                    <Text style={[styles.tdCell, styles.tdBold]}>
                      {lineTotal.toFixed(2)}
                    </Text>
                    {hasLineDiscount && (
                      <Text style={styles.strikeLineTotal}>
                        {(origPrice * qty).toFixed(2)}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.dashedDivider} />

        {/* Totales e impuestos */}
        <View style={styles.totalsBlock}>
          {discountAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Descuento:</Text>
              <Text style={styles.totalVal}>-S/ {discountAmount.toFixed(2)}</Text>
            </View>
          )}
          {shippingAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Envío:</Text>
              <Text style={styles.totalVal}>S/ {shippingAmount.toFixed(2)}</Text>
            </View>
          )}
          {amounts.taxed > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>OP. GRAVADA:</Text>
              <Text style={styles.totalVal}>S/ {amounts.taxed.toFixed(2)}</Text>
            </View>
          )}
          {amounts.exempt > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>OP. EXONERADA:</Text>
              <Text style={styles.totalVal}>S/ {amounts.exempt.toFixed(2)}</Text>
            </View>
          )}
          {amounts.unaffected > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>OP. INAFECTA:</Text>
              <Text style={styles.totalVal}>S/ {amounts.unaffected.toFixed(2)}</Text>
            </View>
          )}
          {amounts.igv > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>IGV:</Text>
              <Text style={styles.totalVal}>S/ {amounts.igv.toFixed(2)}</Text>
            </View>
          )}
          {amounts.otherTaxes > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Otros cargos:</Text>
              <Text style={styles.totalVal}>S/ {amounts.otherTaxes.toFixed(2)}</Text>
            </View>
          )}
          {amounts.taxed === 0 && amounts.exempt === 0 && amounts.unaffected === 0 && amounts.igv === 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>SUBTOTAL:</Text>
              <Text style={styles.totalVal}>S/ {amounts.subtotal.toFixed(2)}</Text>
            </View>
          )}

          <View style={[styles.totalRow, styles.grandTotalRow]}>
            <Text style={styles.grandTotalLabel}>TOTAL:</Text>
            <Text style={styles.grandTotalVal}>S/ {amounts.total.toFixed(2)}</Text>
          </View>

          {surchargeAmount > 0 && (
            <>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Recargo:</Text>
                <Text style={styles.totalVal}>S/ {surchargeAmount.toFixed(2)}</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { fontWeight: '700' }]}>TOTAL COBRADO:</Text>
                <Text style={[styles.totalVal, { fontWeight: '800' }]}>
                  S/ {effectiveCharged.toFixed(2)}
                </Text>
              </View>
            </>
          )}

          {sale.depositInfo &&
            Number((sale.depositInfo as any).appliedAmount ?? sale.depositInfo.depositAmount) > 0 && (
            <View style={styles.depositBox}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total original:</Text>
                <Text style={styles.totalVal}>
                  S/ {Number(sale.depositInfo.originalTotal || amounts.total).toFixed(2)}
                </Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Adelanto (-):</Text>
                <Text style={styles.totalVal}>
                  S/ {Number((sale.depositInfo as any).appliedAmount ?? sale.depositInfo.depositAmount).toFixed(2)}
                </Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { fontWeight: '700' }]}>Saldo restante:</Text>
                <Text style={[styles.totalVal, { fontWeight: '700' }]}>
                  S/ {Number(sale.depositInfo.remainingAmount ?? (sale.depositInfo as any).remainingBalance ?? 0).toFixed(2)}
                </Text>
              </View>
            </View>
          )}

          <Text style={styles.sonText}>
            {String(amountInWords).toUpperCase().startsWith('SON:')
              ? amountInWords
              : `SON: ${amountInWords}`}
          </Text>
        </View>

        <View style={styles.dashedDivider} />

        {/* Desglose de Pagos */}
        <View style={styles.paymentBlock}>
          {(() => {
            const rawSplits = Array.isArray(sale.payments) && sale.payments.length > 0
              ? sale.payments
              : Array.isArray((sale as any).paymentSplits) && (sale as any).paymentSplits.length > 0
                ? (sale as any).paymentSplits
                : Array.isArray((sale as any).mixedPayments)
                  ? (sale as any).mixedPayments
                  : [];
            const validSplits = rawSplits.filter((p: any) => Number(p?.amount || 0) > 0);

            if (validSplits.length > 1) {
              return (
                <>
                  <Text style={[styles.metaLine, styles.boldLabel]}>Pagos:</Text>
                  {validSplits.map((p: any, i: number) => (
                    <View key={`pay-${i}`} style={styles.totalRow}>
                      <Text style={styles.totalLabel}>
                        {p.methodName ||
                          p.methodLabel ||
                          formatMethodName(p.category || p.method, p.digitalProvider || p.provider)}
                      </Text>
                      <Text style={styles.totalVal}>S/ {Number(p.amount || 0).toFixed(2)}</Text>
                    </View>
                  ))}
                </>
              );
            }

            const singleSplitLabel =
              validSplits[0]?.methodName ||
              validSplits[0]?.methodLabel ||
              (validSplits[0]
                ? formatMethodName(
                    validSplits[0].category || validSplits[0].method,
                    validSplits[0].digitalProvider || validSplits[0].provider
                  )
                : '');
            const singleMethodLabel =
              sale.paymentMethodName ||
              singleSplitLabel ||
              formatMethodName(sale.paymentMethod, sale.digitalProvider);

            return (
              <Text style={styles.metaLine}>
                <Text style={styles.boldLabel}>Forma de pago: </Text>
                {singleMethodLabel}
              </Text>
            );
          })()}
          {cashReceived > 0 && (
            <>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Recibido:</Text>
                <Text style={styles.totalVal}>S/ {cashReceived.toFixed(2)}</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Vuelto:</Text>
                <Text style={styles.totalVal}>S/ {Math.max(0, changeGiven).toFixed(2)}</Text>
              </View>
            </>
          )}
        </View>

        {/* Leyenda Amazonía */}
        {isFiscalTitle && amounts.isAmazonExempt && (
          <Text style={styles.amazonLegend}>
            BIENES TRANSFERIDOS EN LA AMAZONÍA PARA SER CONSUMIDOS EN LA MISMA
          </Text>
        )}

        {/* QR Code + Hash + Footer */}
        {qrSvgData && !isOfflinePending && (
          <View style={styles.qrWrapper}>
            <View style={styles.qrFrame}>
              <Svg
                width={108}
                height={108}
                viewBox={`-2 -2 ${qrSvgData.size + 4} ${qrSvgData.size + 4}`}
              >
                <Rect
                  x={-2}
                  y={-2}
                  width={qrSvgData.size + 4}
                  height={qrSvgData.size + 4}
                  fill="#FFFFFF"
                />
                <Path d={qrSvgData.pathData} fill="#000000" />
              </Svg>
            </View>
            {isFiscalTitle && !isOfflinePending && (
              <Text style={styles.qrCaption}>
                Representación impresa de la{' '}
                {isFacturaAccepted ? 'Factura Electrónica' : 'Boleta Electrónica'}
              </Text>
            )}
          </View>
        )}

        {Boolean(sunatHash) && (
          <Text style={styles.hashText} numberOfLines={1}>
            Hash: {sunatHash}
          </Text>
        )}
        {Boolean(resolutionText) && (
          <Text style={styles.metaCenter}>{resolutionText}</Text>
        )}

        <View style={styles.dashedDivider} />
        <Text style={styles.footerText}>{footerText}</Text>
      </View>
    );
  }
);

ReceiptTicketPreview.displayName = 'ReceiptTicketPreview';

const styles = StyleSheet.create({
  ticketPaper: {
    width: '100%',
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  ticketPaperCompact: {
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  centerBlock: {
    alignItems: 'center',
    marginBottom: 8,
  },
  logo: {
    width: 112,
    height: 48,
    marginBottom: 6,
  },
  businessTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
  },
  slogan: {
    fontSize: 10,
    fontStyle: 'italic',
    color: '#4B5563',
    textAlign: 'center',
    marginTop: 1,
  },
  rucLine: {
    fontSize: 11,
    fontWeight: '700',
    color: '#111827',
    marginTop: 3,
  },
  metaCenter: {
    fontSize: 10,
    color: '#374151',
    textAlign: 'center',
    lineHeight: 14,
  },
  dashedBox: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#9CA3AF',
    paddingVertical: 6,
    marginVertical: 6,
    alignItems: 'center',
  },
  docTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  docNumber: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
    marginTop: 2,
  },
  statusBanner: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginBottom: 8,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  metaSection: {
    gap: 2,
    marginBottom: 6,
  },
  metaLine: {
    fontSize: 11,
    color: '#1F2937',
    lineHeight: 15,
  },
  boldLabel: {
    fontWeight: '700',
    color: '#111827',
  },
  dashedDivider: {
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#9CA3AF',
    marginVertical: 7,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#D1D5DB',
    paddingBottom: 4,
    marginBottom: 4,
  },
  thCell: {
    fontSize: 10,
    fontWeight: '800',
    color: '#111827',
  },
  itemsList: {
    gap: 6,
  },
  itemBlock: {
    gap: 1,
  },
  itemName: {
    fontSize: 11,
    fontWeight: '600',
    color: '#111827',
  },
  itemDetailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  tdCell: {
    fontSize: 10,
    color: '#374151',
    fontVariant: ['tabular-nums'],
  },
  tdBold: {
    fontWeight: '700',
    color: '#111827',
  },
  strikeLineTotal: {
    fontSize: 9,
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
  },
  totalsBlock: {
    gap: 2,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    fontSize: 11,
    color: '#374151',
  },
  totalVal: {
    fontSize: 11,
    color: '#111827',
    fontVariant: ['tabular-nums'],
  },
  grandTotalRow: {
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  grandTotalLabel: {
    fontSize: 13,
    fontWeight: '900',
    color: '#111827',
  },
  grandTotalVal: {
    fontSize: 14,
    fontWeight: '900',
    color: '#111827',
    fontVariant: ['tabular-nums'],
  },
  depositBox: {
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#D1D5DB',
  },
  sonText: {
    fontSize: 9.5,
    fontWeight: '600',
    color: '#374151',
    marginTop: 4,
  },
  paymentBlock: {
    gap: 2,
  },
  amazonLegend: {
    fontSize: 9,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginTop: 8,
  },
  qrWrapper: {
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  qrFrame: {
    padding: 4,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
  },
  qrCaption: {
    fontSize: 9.5,
    color: '#4B5563',
    textAlign: 'center',
    marginTop: 4,
  },
  hashText: {
    fontSize: 8.5,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 2,
  },
  footerText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#111827',
    textAlign: 'center',
    marginTop: 2,
  },
});

export default ReceiptTicketPreview;
