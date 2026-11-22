import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { doc, getDoc } from 'firebase/firestore';
import { Printer, Share2, X } from 'lucide-react-native';
import { BrandLogo, SectionHeading } from '@/components/ui';
import { ReceiptTicketPreview } from '@/components/ReceiptTicketPreview';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { db } from '@/lib/firebase';
import { ui, formatPEN, formatDatePE } from '@/lib/theme';
import { sellerPresetDates, type SellerPreset } from '@/lib/seller-dates';
import {
  fetchSellerMetadata,
  fetchSellerPerformance,
  type SellerMetadata,
  type SellerOwnReport,
} from '@/services/seller-report-service';
import {
  buildSaleReceiptEscPos,
  getPrinterConfig,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import { resolveReceiptDocumentMeta } from '@/lib/printing/escpos-builder';
import type { Sale } from '@/types';

type RecentSaleItem = SellerOwnReport['recentSales'][number] & {
  branchId?: string;
  itemsCount?: number;
  status?: string;
};

type ExtendedPreset = SellerPreset | '7d' | 'custom';

const computeLast7DaysRange = (today: string): { from: string; to: string } => {
  const [year, month, day] = today.split('-').map(Number);
  if (!year || !month || !day) return { from: today, to: today };
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 6);
  return { from: date.toISOString().slice(0, 10), to: today };
};

interface SellerSaleRowProps {
  sale: RecentSaleItem;
  branchName?: string;
  onPress: (sale: RecentSaleItem) => void;
}

const SellerSaleRow = React.memo(({ sale, branchName, onPress }: SellerSaleRowProps) => (
  <TouchableOpacity
    style={styles.sale}
    onPress={() => onPress(sale)}
    accessibilityRole="button"
    accessibilityLabel={`Ver comprobante ${sale.saleNumber || sale.id}, ${formatPEN(sale.total)}`}
  >
    <View style={styles.saleTopRow}>
      <Text style={styles.saleTitle}>
        {sale.isReturn ? 'Devolución' : `Venta #${sale.saleNumber || sale.id.slice(-6).toUpperCase()}`}
      </Text>
      <Text style={styles.saleTitle}>{formatPEN(sale.total)}</Text>
    </View>
    <Text style={styles.subtitle}>
      {sale.customerName || 'Cliente general'} · {sale.paymentMethod}
      {typeof sale.itemsCount === 'number' && sale.itemsCount > 0 ? ` · ${sale.itemsCount} u.` : ''}
    </Text>
    <View style={styles.saleMetaRow}>
      <Text style={styles.note}>{formatDatePE(sale.date)}</Text>
      {branchName ? <Text style={styles.branchTag}>{branchName}</Text> : null}
    </View>
  </TouchableOpacity>
));

const EMPTY_SALES: RecentSaleItem[] = [];

const ListGap16 = () => <View style={styles.listGap16} />;

export default function SellerScreen() {
  const insets = useSafeAreaInsets();
  const { user, accountId, logout } = useAuthSession();
  const {
    businessSettings,
    businessData,
    branches,
    activeBranch,
    taxProfile,
    emitterInfo,
    posSettings,
  } = useBusinessSettings();

  const [metadata, setMetadata] = useState<SellerMetadata | null>(null);
  const [report, setReport] = useState<SellerOwnReport | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [activePreset, setActivePreset] = useState<ExtendedPreset>('today');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);
  const perfAbortRef = useRef<AbortController | null>(null);
  const detailReqIdRef = useRef(0);
  const isMountedRef = useRef(true);

  // Detalle de venta y vista previa de recibo
  const [selectedSaleItem, setSelectedSaleItem] = useState<RecentSaleItem | null>(null);
  const [selectedFullSale, setSelectedFullSale] = useState<Sale | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80);
  const [isPrinting, setIsPrinting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  useEffect(() => {
    getPrinterConfig()
      .then((cfg) => {
        if (cfg?.paperWidth === 58 || cfg?.paperWidth === 80) {
          setPaperWidth(cfg.paperWidth);
        }
      })
      .catch(() => {});
  }, []);

  const receiptBusiness = useMemo(
    () => ({
      ...(businessData || {}),
      ...(businessSettings || {}),
      ...(emitterInfo || {}),
      printedFormatResolution: emitterInfo?.printedFormatResolution || undefined,
      businessName:
        emitterInfo?.nombreComercial ||
        emitterInfo?.razonSocial ||
        businessSettings?.businessName ||
        businessData?.businessName ||
        'VENTIFY',
      ruc: emitterInfo?.ruc || businessSettings?.ruc || businessData?.ruc || '',
      address:
        (businessSettings as any)?.commercialAddress ||
        businessSettings?.address ||
        activeBranch?.address ||
        '',
      phone:
        activeBranch?.phone ||
        (businessSettings as any)?.commercialPhone ||
        businessSettings?.phone ||
        '',
      consultUrl:
        (businessSettings as any)?.consultUrl ||
        (businessData as any)?.consultUrl ||
        'https://ventify.com.pe/comprobantes',
    }),
    [businessData, businessSettings, emitterInfo, activeBranch]
  );

  const branchNameMap = useMemo(() => {
    const map = new Map<string, string>();
    (metadata?.branches || []).forEach((b) => map.set(b.id, b.name));
    (branches || []).forEach((b) => {
      if (b.id && b.name && !map.has(b.id)) map.set(b.id, b.name);
    });
    return map;
  }, [metadata?.branches, branches]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      detailReqIdRef.current += 1;
      perfAbortRef.current?.abort();
      perfAbortRef.current = null;
      requestVersion.current += 1;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    perfAbortRef.current?.abort();
    perfAbortRef.current = null;
    let alive = true;
    setMetadata(null);
    setReport(null);
    setBranch('');
    setActivePreset('today');
    setBusy(true);
    setError('');
    fetchSellerMetadata({ signal: controller.signal })
      .then((data) => {
        if (!alive || !isMountedRef.current || controller.signal.aborted) return;
        setMetadata(data);
        setFrom(data.today);
        setTo(data.today);
      })
      .catch((err) => {
        if (
          !alive ||
          !isMountedRef.current ||
          controller.signal.aborted ||
          err?.code === 'ABORTED' ||
          err?.name === 'AbortError'
        ) {
          return;
        }
        setError(err.message);
        setBusy(false);
      });
    return () => {
      alive = false;
      controller.abort();
      perfAbortRef.current?.abort();
      perfAbortRef.current = null;
      requestVersion.current++;
    };
  }, [user?.uid, accountId, revision]);

  const load = useCallback(async (start: string, end: string, branchId: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
      setError('Ingresa fechas válidas como AAAA-MM-DD.');
      return;
    }
    perfAbortRef.current?.abort();
    const controller = new AbortController();
    perfAbortRef.current = controller;
    const version = ++requestVersion.current;
    setReport(null);
    setBusy(true);
    setError('');
    try {
      const data = await fetchSellerPerformance(start, end, branchId, {
        signal: controller.signal,
      });
      if (isMountedRef.current && version === requestVersion.current && !controller.signal.aborted) {
        setReport(data);
      }
    } catch (err: any) {
      if (
        isMountedRef.current &&
        version === requestVersion.current &&
        !controller.signal.aborted &&
        err?.code !== 'ABORTED' &&
        err?.name !== 'AbortError'
      ) {
        setError(err instanceof Error ? err.message : 'No se pudieron consultar tus ventas.');
      }
    } finally {
      if (isMountedRef.current && version === requestVersion.current && !controller.signal.aborted) {
        setBusy(false);
      }
      if (perfAbortRef.current === controller) {
        perfAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (metadata) void load(metadata.today, metadata.today, '');
    return () => {
      perfAbortRef.current?.abort();
    };
  }, [metadata, load]);

  const applyPreset = useCallback((value: Exclude<ExtendedPreset, 'custom'>) => {
    if (!metadata) return;
    setActivePreset(value);
    const range =
      value === '7d'
        ? computeLast7DaysRange(metadata.today)
        : sellerPresetDates(metadata.today, value);
    setFrom(range.from);
    setTo(range.to);
    void load(range.from, range.to, branch);
  }, [metadata, branch, load]);

  const handleOpenSaleDetail = useCallback(async (saleItem: RecentSaleItem) => {
    const reqId = ++detailReqIdRef.current;
    setSelectedSaleItem(saleItem);
    setSelectedFullSale(null);
    setDetailError('');
    setLoadingDetail(true);
    try {
      const snap = await getDoc(doc(db, 'sales', saleItem.id));
      if (!isMountedRef.current || reqId !== detailReqIdRef.current) return;
      if (snap.exists()) {
        setSelectedFullSale({ id: snap.id, ...(snap.data() as Omit<Sale, 'id'>) });
      } else {
        setDetailError('No se encontró el detalle completo; mostrando resumen.');
      }
    } catch {
      if (!isMountedRef.current || reqId !== detailReqIdRef.current) return;
      setDetailError('Sin conexión o sin detalle extendido; mostrando resumen.');
    } finally {
      if (isMountedRef.current && reqId === detailReqIdRef.current) {
        setLoadingDetail(false);
      }
    }
  }, []);

  const selectedSaleBranch = useMemo(() => {
    const bId = selectedFullSale?.branchId || selectedSaleItem?.branchId;
    if (!bId) return activeBranch || null;
    return branches?.find((b) => b.id === bId) || activeBranch || null;
  }, [selectedFullSale?.branchId, selectedSaleItem?.branchId, branches, activeBranch]);

  const fallbackPreviewSale = useMemo<Sale | null>(() => {
    if (selectedFullSale) return selectedFullSale;
    if (!selectedSaleItem) return null;
    return {
      id: selectedSaleItem.id,
      saleNumber: selectedSaleItem.saleNumber || 0,
      documentNumber: selectedSaleItem.saleNumber
        ? `V-${String(selectedSaleItem.saleNumber).padStart(6, '0')}`
        : selectedSaleItem.id.slice(-6).toUpperCase(),
      documentType: 'nota_venta',
      date: selectedSaleItem.date,
      items: [],
      subtotal: selectedSaleItem.total,
      tax: 0,
      discountAmount: 0,
      total: selectedSaleItem.total,
      paymentMethod: selectedSaleItem.paymentMethod || 'Efectivo',
      customerName: selectedSaleItem.customerName || 'Cliente General',
      branchId: selectedSaleItem.branchId || branch || 'main',
      accountId: accountId || '',
      createdBy: user?.uid || '',
      status: (selectedSaleItem.status as Sale['status']) || 'completed',
      isReturn: selectedSaleItem.isReturn,
    };
  }, [selectedFullSale, selectedSaleItem, branch, accountId, user?.uid]);

  const handlePrintDetailSale = async () => {
    if (!fallbackPreviewSale) return;
    setIsPrinting(true);
    try {
      const cfg = await getPrinterConfig();
      const docMeta = resolveReceiptDocumentMeta(fallbackPreviewSale);
      const printOptions = {
        paperWidth,
        autoCut: cfg.autoCut !== false,
        openDrawer: false,
        branch: selectedSaleBranch,
        taxProfile,
        consultUrl: receiptBusiness.consultUrl,
        receiptFooter:
          posSettings?.ticketFooterMessage ||
          businessSettings?.receiptFooter ||
          '¡Gracias por su compra!',
      };
      let printedBt = false;
      if (cfg.connectionType === 'bluetooth' && cfg.selectedDevice?.address) {
        const bytes = buildSaleReceiptEscPos(fallbackPreviewSale, receiptBusiness, printOptions);
        printedBt = await printRawEscPos(bytes, cfg.selectedDevice.address);
      }
      if (!printedBt) {
        await printTicketPDF(
          {
            title: `Ticket_${docMeta.docNumber || fallbackPreviewSale.id}`,
            sale: fallbackPreviewSale,
            business: receiptBusiness,
            options: printOptions,
          },
          printOptions
        );
      }
    } catch (err: any) {
      Alert.alert('Error de Impresión', err?.message || 'No se pudo emitir el comprobante.');
    } finally {
      setIsPrinting(false);
    }
  };

  const handleShareDetailWhatsApp = async () => {
    if (!fallbackPreviewSale) return;
    setIsSharing(true);
    try {
      const shareConfig = {
        phone: fallbackPreviewSale.customerPhone || '',
        paperWidth,
        branch: selectedSaleBranch,
        taxProfile,
        consultUrl: receiptBusiness.consultUrl,
        receiptFooter:
          posSettings?.ticketFooterMessage ||
          businessSettings?.receiptFooter ||
          '¡Gracias por su compra!',
      };
      await shareTicketWhatsApp(
        {
          sale: fallbackPreviewSale,
          business: receiptBusiness,
          options: shareConfig,
        },
        receiptBusiness,
        shareConfig
      );
    } catch (err: any) {
      Alert.alert('Error al Compartir', err?.message || 'No se pudo generar el comprobante PDF.');
    } finally {
      setIsSharing(false);
    }
  };

  const summaryStats = useMemo(() => {
    const rows = report?.report.rows || [];
    const salesCount = rows.reduce((sum, r) => sum + (r.salesCount || 0), 0);
    const totalNet = report?.report.totalNet ?? 0;
    const totalGross = report?.report.totalGross ?? 0;
    const totalRefunds = report?.report.totalRefunds ?? 0;
    const avgTicket = salesCount > 0 ? totalNet / salesCount : 0;
    const primaryRow = rows[0] as { participation?: number | null } | undefined;
    const participation =
      typeof primaryRow?.participation === 'number' ? primaryRow.participation : null;
    return { salesCount, totalNet, totalGross, totalRefunds, avgTicket, participation };
  }, [report]);

  const headerElement = useMemo(() => (
    <View style={[styles.headerBox, Boolean(report?.recentSales?.length) && styles.headerWithListMargin]}>
      <Text style={styles.title}>Mis ventas</Text>
      <Text style={styles.subtitle}>
        {metadata?.seller.name || 'Portal de vendedor'} · Consulta tus resultados y comprobantes.
      </Text>
      {metadata && (
        <>
          <View style={styles.row}>
            {(
              [
                ['today', 'Hoy'],
                ['yesterday', 'Ayer'],
                ['7d', '7 días'],
                ['week', 'Semana'],
                ['month', 'Mes'],
              ] as const
            ).map(([value, label]) => {
              const isActive = activePreset === value;
              return (
                <TouchableOpacity
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  style={[styles.chip, isActive && styles.chipActive]}
                  onPress={() => applyPreset(value)}
                >
                  <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.label}>Sucursal</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.row}>
              {[{ id: '', name: 'Mis sucursales' }, ...metadata.branches].map((b) => {
                const isSelected = branch === b.id;
                return (
                  <TouchableOpacity
                    key={b.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    style={[styles.chip, isSelected && styles.chipActive]}
                    onPress={() => {
                      setBranch(b.id);
                      void load(from, to, b.id);
                    }}
                  >
                    <Text style={[styles.chipText, isSelected && styles.chipTextActive]}>{b.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <View style={styles.row}>
            <View style={styles.field}>
              <Text style={styles.label}>Desde</Text>
              <TextInput
                accessibilityLabel="Desde (AAAA-MM-DD)"
                placeholder="AAAA-MM-DD"
                placeholderTextColor={ui.textMuted}
                value={from}
                onChangeText={(txt) => {
                  setActivePreset('custom');
                  setFrom(txt);
                }}
                style={styles.input}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Hasta</Text>
              <TextInput
                accessibilityLabel="Hasta (AAAA-MM-DD)"
                placeholder="AAAA-MM-DD"
                placeholderTextColor={ui.textMuted}
                value={to}
                onChangeText={(txt) => {
                  setActivePreset('custom');
                  setTo(txt);
                }}
                style={styles.input}
              />
            </View>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy}
            style={[styles.primary, busy && { opacity: 0.6 }]}
            onPress={() => void load(from, to, branch)}
          >
            <Text style={styles.primaryText}>Consultar período</Text>
          </TouchableOpacity>
          <Text style={styles.note}>Fechas del negocio · {metadata.timeZone}</Text>
        </>
      )}
      {busy && <ActivityIndicator color={ui.primary} accessibilityLabel="Consultando tus ventas" />}
      {!!error && (
        <View style={styles.error}>
          <Text accessibilityRole="alert" style={{ color: ui.danger }}>
            {error}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.link}
            onPress={() => (metadata ? void load(from, to, branch) : setRevision((v) => v + 1))}
          >
            <Text style={styles.linkText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}
      {report && (
        <>
          <View style={styles.summary}>
            <Text style={styles.label}>Ventas netas del período</Text>
            <Text style={styles.value}>{formatPEN(summaryStats.totalNet)}</Text>
            <View style={styles.kpiGrid}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Bruto</Text>
                <Text style={styles.kpiValue}>{formatPEN(summaryStats.totalGross)}</Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Devoluciones</Text>
                <Text style={[styles.kpiValue, summaryStats.totalRefunds > 0 && { color: ui.danger }]}>
                  {formatPEN(summaryStats.totalRefunds)}
                </Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Ventas</Text>
                <Text style={styles.kpiValue}>{summaryStats.salesCount}</Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiLabel}>Ticket prom.</Text>
                <Text style={styles.kpiValue}>{formatPEN(summaryStats.avgTicket)}</Text>
              </View>
            </View>
            {summaryStats.participation !== null && (
              <Text style={styles.note}>
                Participación en tienda: {summaryStats.participation.toFixed(1)}%
              </Text>
            )}
          </View>
          <SectionHeading title="Ventas recientes" />
          {!report.recentSales.length && (
            <Text style={styles.subtitle}>No tienes ventas registradas en este período.</Text>
          )}
        </>
      )}
    </View>
  ), [metadata, activePreset, applyPreset, branch, from, to, busy, error, load, report, summaryStats]);

  const saleKeyExtractor = useCallback((sale: RecentSaleItem) => sale.id, []);

  const renderSaleItem = useCallback(
    ({ item }: { item: RecentSaleItem }) => (
      <SellerSaleRow
        sale={item}
        branchName={item.branchId ? branchNameMap.get(item.branchId) : undefined}
        onPress={handleOpenSaleDetail}
      />
    ),
    [branchNameMap, handleOpenSaleDetail]
  );

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <BrandLogo />
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void logout()}
          style={styles.link}
        >
          <Text style={styles.linkText}>Cerrar sesión</Text>
        </TouchableOpacity>
      </View>
      <FlashList
        data={report?.recentSales || EMPTY_SALES}
        keyExtractor={saleKeyExtractor}
        estimatedItemSize={96}
        renderItem={renderSaleItem}
        ItemSeparatorComponent={ListGap16}
        ListHeaderComponent={headerElement}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      />

      {selectedSaleItem ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => {
            detailReqIdRef.current += 1;
            setSelectedSaleItem(null);
          }}
        >
          <View style={[styles.modalContainer, { paddingTop: Platform.OS === 'ios' ? insets.top : 14 }]}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  {selectedSaleItem.isReturn
                    ? 'Detalle de Devolución'
                    : `Venta #${selectedSaleItem.saleNumber || selectedSaleItem.id.slice(-6).toUpperCase()}`}
                </Text>
                <Text style={styles.note}>
                  {formatDatePE(selectedSaleItem.date)}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => {
                  detailReqIdRef.current += 1;
                  setSelectedSaleItem(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Cerrar detalle de venta"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={[styles.modalScrollContent, { paddingBottom: insets.bottom + 24 }]}
            >
              {loadingDetail ? (
                <View style={styles.modalLoadingBox}>
                  <ActivityIndicator color={ui.primary} />
                  <Text style={styles.note}>Cargando comprobante...</Text>
                </View>
              ) : null}

              {!!detailError && (
                <View style={styles.modalNotice}>
                  <Text style={styles.note}>{detailError}</Text>
                </View>
              )}

              {fallbackPreviewSale && selectedFullSale ? (
                <>
                  <View style={styles.paperRow}>
                    <Text style={styles.label}>Ancho de ticket:</Text>
                    <View style={styles.paperBtnGroup}>
                      {([80, 58] as const).map((w) => (
                        <TouchableOpacity
                          key={w}
                          style={[styles.paperBtn, paperWidth === w && styles.paperBtnActive]}
                          onPress={() => setPaperWidth(w)}
                        >
                          <Text style={[styles.paperBtnText, paperWidth === w && styles.paperBtnTextActive]}>
                            {w}mm
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  <View style={{ alignItems: 'center', marginBottom: 14 }}>
                    <ReceiptTicketPreview
                      sale={selectedFullSale}
                      business={receiptBusiness}
                      branch={selectedSaleBranch}
                      taxProfile={taxProfile}
                      receiptFooter={
                        posSettings?.ticketFooterMessage ||
                        businessSettings?.receiptFooter ||
                        '¡Gracias por su compra!'
                      }
                      paperWidth={paperWidth}
                    />
                  </View>
                </>
              ) : (
                <View style={styles.summary}>
                  <Text style={styles.label}>Resumen de comprobante</Text>
                  <Text style={styles.value}>{formatPEN(selectedSaleItem.total)}</Text>
                  <Text style={styles.subtitle}>
                    Cliente: {selectedSaleItem.customerName || 'Cliente general'}
                  </Text>
                  <Text style={styles.subtitle}>Pago: {selectedSaleItem.paymentMethod}</Text>
                  {typeof selectedSaleItem.itemsCount === 'number' && (
                    <Text style={styles.subtitle}>Artículos: {selectedSaleItem.itemsCount}</Text>
                  )}
                </View>
              )}

              {fallbackPreviewSale && (
                <View style={styles.modalActionsRow}>
                  <TouchableOpacity
                    style={[styles.modalActionBtn, isPrinting && { opacity: 0.6 }]}
                    onPress={() => void handlePrintDetailSale()}
                    disabled={isPrinting}
                    accessibilityRole="button"
                  >
                    {isPrinting ? (
                      <ActivityIndicator size="small" color={ui.primary} />
                    ) : (
                      <>
                        <Printer size={18} color={ui.primary} />
                        <Text style={styles.modalActionBtnText}>Imprimir / PDF</Text>
                      </>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.modalActionBtn, isSharing && { opacity: 0.6 }]}
                    onPress={() => void handleShareDetailWhatsApp()}
                    disabled={isSharing}
                    accessibilityRole="button"
                  >
                    {isSharing ? (
                      <ActivityIndicator size="small" color={ui.primary} />
                    ) : (
                      <>
                        <Share2 size={18} color={ui.primary} />
                        <Text style={styles.modalActionBtnText}>WhatsApp</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.background },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: ui.surface,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  content: { padding: 20, paddingBottom: 40 },
  listGap16: { height: 16 },
  headerBox: { gap: 16 },
  headerWithListMargin: { marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', color: ui.text },
  subtitle: { fontSize: 14, lineHeight: 21, color: ui.textSecondary },
  link: { paddingVertical: 12, paddingHorizontal: 8, minHeight: 48, justifyContent: 'center' },
  linkText: { color: ui.primary, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: ui.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  chipActive: { backgroundColor: ui.primarySoft, borderColor: ui.primary },
  chipText: { color: ui.textSecondary, fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: ui.primary, fontWeight: '700' },
  field: { flex: 1, minWidth: 130 },
  label: { fontSize: 13, fontWeight: '600', color: ui.textSecondary, marginBottom: 6 },
  input: {
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    backgroundColor: ui.surface,
    color: ui.text,
    minHeight: 48,
  },
  primary: {
    padding: 16,
    backgroundColor: ui.primary,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryText: { color: ui.onPrimary, fontWeight: '700' },
  note: { fontSize: 12, color: ui.textMuted, lineHeight: 18 },
  error: { padding: 16, backgroundColor: ui.dangerSoft, borderRadius: 12 },
  summary: {
    padding: 18,
    gap: 10,
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  value: { fontSize: 28, fontWeight: '700', color: ui.text },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  kpiBox: {
    flexGrow: 1,
    minWidth: '45%',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 10,
    gap: 2,
  },
  kpiLabel: { fontSize: 11, fontWeight: '600', color: ui.textSecondary },
  kpiValue: { fontSize: 15, fontWeight: '700', color: ui.text },
  sale: {
    padding: 16,
    gap: 6,
    borderBottomWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
  },
  saleTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  saleMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  saleTitle: { fontWeight: '700', fontSize: 16, color: ui.text },
  branchTag: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  modalContainer: { flex: 1, backgroundColor: ui.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    backgroundColor: ui.surface,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: ui.text },
  modalCloseBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalScrollContent: { padding: 16, gap: 12 },
  modalLoadingBox: { alignItems: 'center', paddingVertical: 16, gap: 8 },
  modalNotice: {
    backgroundColor: ui.warningSoft,
    borderRadius: 10,
    padding: 10,
  },
  paperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  paperBtnGroup: { flexDirection: 'row', gap: 6 },
  paperBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
  },
  paperBtnActive: { backgroundColor: ui.text, borderColor: ui.text },
  paperBtnText: { fontSize: 12, fontWeight: '700', color: ui.textSecondary },
  paperBtnTextActive: { color: ui.surface },
  modalActionsRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.primary,
    backgroundColor: ui.surface,
  },
  modalActionBtnText: { fontSize: 14, fontWeight: '700', color: ui.primary },
});
