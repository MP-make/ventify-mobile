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
import * as Haptics from 'expo-haptics';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileMinus,
  FilePlus2,
  FileText,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react-native';
import { usePermissions } from '@/hooks/usePermissions';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import { isValidDNI, isValidRUC } from '@/lib/invoicing/types';
import {
  downloadAndShareExportFile,
  EINVOICE_STATUS_LABELS,
  EINVOICE_TYPE_LABELS,
  emitEinvoiceDocument,
  retryEinvoiceDocument,
  SUNAT_CREDIT_NOTE_REASONS,
  SUNAT_DEBIT_NOTE_REASONS,
  type PublicEinvoice,
} from '@/services/dashboard-reports-service';

export interface EinvoiceActionsModalProps {
  visible: boolean;
  einvoice: PublicEinvoice | null;
  allEinvoices: PublicEinvoice[];
  accountId: string;
  taxRate: number;
  invoicingEnabled: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

type ActionTab = 'details' | 'credit_note' | 'debit_note' | 'replacement';

const EinvoiceActionsModalContent: React.FC<
  Omit<EinvoiceActionsModalProps, 'einvoice'> & { einvoice: PublicEinvoice }
> = React.memo(
  ({
    visible,
    einvoice,
    allEinvoices,
    accountId,
    taxRate,
    invoicingEnabled,
    onClose,
    onUpdated,
  }) => {
    const insets = useSafeAreaInsets();
    const { canViewReports, canCreateCreditNotes, hasPermission } = usePermissions();

    const [activeTab, setActiveTab] = useState<ActionTab>('details');
    const [retrying, setRetrying] = useState(false);
    const [downloading, setDownloading] = useState<'xml' | 'cdr' | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Nota de Crédito (07) / Débito (08)
    const [ncReasonCode, setNcReasonCode] = useState('01');
    const [ncReasonDesc, setNcReasonDesc] = useState('Anulación de la operación');
    const [ndReasonCode, setNdReasonCode] = useState('01');
    const [ndReasonDesc, setNdReasonDesc] = useState('Intereses por mora');

    // Sustituto
    const [repNoteId, setRepNoteId] = useState('');
    const [repDocNumber, setRepDocNumber] = useState('');
    const [repName, setRepName] = useState('');
    const [repAddress, setRepAddress] = useState('');

    const eligibleCreditNotes = useMemo(() => {
      if (
        !visible ||
        activeTab !== 'replacement' ||
        (einvoice.documentType !== '01' && einvoice.documentType !== '03')
      ) {
        return [];
      }
      return allEinvoices.filter(
        (note) =>
          note.documentType === '07' &&
          note.status === 'accepted' &&
          note.saleId === einvoice.saleId &&
          note.reference?.number === einvoice.documentNumber &&
          note.reference?.type === einvoice.documentType &&
          ['01', '02', '06'].includes(note.reference?.reasonCode || '') &&
          Math.round(Number(note.amount || 0) * 100) ===
            Math.round(Number(einvoice.amount || 0) * 100)
      );
    }, [visible, activeTab, allEinvoices, einvoice]);

    const resolvedRepNoteId = useMemo(
      () =>
        eligibleCreditNotes.some((note) => note.id === repNoteId)
          ? repNoteId
          : eligibleCreditNotes[0]?.id || '',
      [eligibleCreditNotes, repNoteId]
    );

    useEffect(() => {
      if (!visible) return;
      setActiveTab('details');
      setNcReasonCode('01');
      setNcReasonDesc('Anulación de la operación');
      setNdReasonCode('01');
      setNdReasonDesc('Intereses por mora');
      setRepNoteId('');
      setRepDocNumber(einvoice.receiptCustomer?.identityNumber || '');
      setRepName(einvoice.receiptCustomer?.name || '');
      setRepAddress(einvoice.receiptCustomer?.address || '');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, einvoice.id]);

    const isOriginalDoc = einvoice.documentType === '01' || einvoice.documentType === '03';
    const isNoteDoc = einvoice.documentType === '07' || einvoice.documentType === '08';
    const isAccepted = einvoice.status === 'accepted';
    const canRetryStatus =
      einvoice.status === 'pending' ||
      einvoice.status === 'sending' ||
      einvoice.status === 'rejected' ||
      einvoice.status === 'error';
    const canRetryPermission = isNoteDoc
      ? canCreateCreditNotes
      : hasPermission('register_sale') || canCreateCreditNotes;

    const statusBadge = (() => {
      if (isAccepted) return { bg: ui.successSoft, color: ui.success };
      if (einvoice.status === 'rejected' || einvoice.status === 'error') {
        return { bg: ui.dangerSoft, color: ui.danger };
      }
      return { bg: ui.warningSoft, color: ui.warning };
    })();

    const handleRetry = async () => {
      if (!accountId) return;
      setRetrying(true);
      try {
        const updated = await retryEinvoiceDocument(accountId, einvoice.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert(
          'Estado actualizado',
          `${updated.documentNumber}: ${EINVOICE_STATUS_LABELS[updated.status] || updated.status}${
            updated.cdr?.description ? `\n${updated.cdr.description}` : ''
          }`
        );
        onUpdated();
        onClose();
      } catch (err: any) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('No se pudo reintentar', err?.message || 'Error consultando SUNAT.');
      } finally {
        setRetrying(false);
      }
    };

    const handleDownload = async (kind: 'xml' | 'cdr') => {
      if (!accountId) return;
      setDownloading(kind);
      try {
        const baseName = (einvoice.fileName || einvoice.documentNumber).replace(/\.zip$/i, '');
        const filename = kind === 'xml' ? `${baseName}.xml` : `R-${baseName}.zip`;
        const mimeType = kind === 'xml' ? 'application/xml' : 'application/zip';
        const path = `/api/invoicing/status?accountId=${encodeURIComponent(accountId)}&id=${encodeURIComponent(einvoice.id)}&download=${kind}`;
        await downloadAndShareExportFile(path, filename, mimeType);
      } catch (err: any) {
        Alert.alert('Descarga no disponible', err?.message || `No se pudo descargar el ${kind.toUpperCase()}.`);
      } finally {
        setDownloading(null);
      }
    };

    const handleEmitNote = async (docType: '07' | '08') => {
      if (!accountId || !isOriginalDoc) return;
      const reasonCode = docType === '07' ? ncReasonCode : ndReasonCode;
      const reasonDescription = (docType === '07' ? ncReasonDesc : ndReasonDesc).trim();
      if (!reasonDescription) {
        Alert.alert('Sustento requerido', 'Ingresa la descripción del motivo ante SUNAT.');
        return;
      }

      setSubmitting(true);
      try {
        const emitted = await emitEinvoiceDocument({
          accountId,
          saleId: einvoice.saleId,
          documentType: docType,
          reference: {
            type: einvoice.documentType as '01' | '03',
            number: einvoice.documentNumber,
            reasonCode,
            reasonDescription,
          },
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert(
          docType === '07' ? 'Nota de Crédito emitida' : 'Nota de Débito emitida',
          `${emitted.documentNumber} · Estado: ${EINVOICE_STATUS_LABELS[emitted.status] || emitted.status}`
        );
        onUpdated();
        onClose();
      } catch (err: any) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Error al emitir nota', err?.message || 'SUNAT no pudo procesar la nota.');
      } finally {
        setSubmitting(false);
      }
    };

    const handleEmitReplacement = async () => {
      if (!accountId || !isOriginalDoc) return;
      const docNum = repDocNumber.trim();
      const customerName = repName.trim();
      const expectedType = einvoice.documentType as '01' | '03';

      if (!resolvedRepNoteId) {
        Alert.alert('Nota requerida', 'Selecciona una Nota de Crédito total aceptada.');
        return;
      }
      if (!customerName) {
        Alert.alert('Nombre requerido', 'Ingresa el nombre o razón social del cliente.');
        return;
      }
      if (expectedType === '01') {
        if (!isValidRUC(docNum)) {
          Alert.alert('RUC inválido', 'Para sustituir una Factura debes ingresar un RUC válido de 11 dígitos.');
          return;
        }
      } else if (!/^\d{8}$/.test(docNum) && !/^\d{11}$/.test(docNum)) {
        Alert.alert('Documento inválido', 'Ingresa un DNI de 8 dígitos o RUC de 11 dígitos.');
        return;
      } else if (docNum.length === 8 && !isValidDNI(docNum)) {
        Alert.alert('DNI inválido', 'El DNI debe tener 8 dígitos.');
        return;
      } else if (docNum.length === 11 && !isValidRUC(docNum)) {
        Alert.alert('RUC inválido', 'El RUC ingresado no supera la validación SUNAT.');
        return;
      }

      setSubmitting(true);
      try {
        const emitted = await emitEinvoiceDocument({
          accountId,
          saleId: einvoice.saleId,
          documentType: expectedType,
          replacesInvoiceId: einvoice.id,
          creditNoteId: resolvedRepNoteId,
          customer: {
            identityType: docNum.length === 11 ? '6' : '1',
            identityNumber: docNum,
            name: customerName,
            ...(repAddress.trim() ? { address: repAddress.trim() } : {}),
          },
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert(
          'Comprobante sustituto emitido',
          `${emitted.documentNumber} · Estado: ${EINVOICE_STATUS_LABELS[emitted.status] || emitted.status}`
        );
        onUpdated();
        onClose();
      } catch (err: any) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('Error al emitir sustituto', err?.message || 'No se pudo emitir el sustituto.');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={onClose}
      >
        <KeyboardAvoidingView
          style={styles.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <View style={styles.titleRow}>
                  <Text style={styles.docNumber}>{einvoice.documentNumber}</Text>
                  <View style={[styles.badge, { backgroundColor: statusBadge.bg }]}>
                    <Text style={[styles.badgeText, { color: statusBadge.color }]}>
                      {EINVOICE_STATUS_LABELS[einvoice.status] || einvoice.status}
                    </Text>
                  </View>
                </View>
                <Text style={styles.docSub}>
                  {EINVOICE_TYPE_LABELS[einvoice.documentType] || einvoice.documentType} ·{' '}
                  {einvoice.documentType === '09' ? 'Guía' : formatPEN(einvoice.amount)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                style={styles.closeBtn}
                accessibilityRole="button"
                accessibilityLabel="Cerrar acciones de comprobante"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Sub-tabs inside modal when original accepted document */}
            {isOriginalDoc && isAccepted && canCreateCreditNotes && invoicingEnabled && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tabsRow}
                style={styles.tabsBar}
              >
                {([
                  ['details', 'Detalle y CDR'],
                  ['credit_note', 'Nota Crédito (07)'],
                  ['debit_note', 'Nota Débito (08)'],
                  ['replacement', 'Sustituto'],
                ] as const).map(([key, label]) => {
                  const active = activeTab === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      onPress={() => setActiveTab(key)}
                      style={[styles.tabPill, active && styles.tabPillActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[styles.tabText, active && styles.tabTextActive]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollBody}
            >
              {activeTab === 'details' && (
                <>
                  <View style={styles.metaCard}>
                    <View style={styles.metaRow}>
                      <Text style={styles.metaLabel}>Fecha emisión</Text>
                      <Text style={styles.metaValue}>
                        {formatDatePE(einvoice.receiptIssuedAt || einvoice.createdAt)}
                      </Text>
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={styles.metaLabel}>Moneda / Monto</Text>
                      <Text style={styles.metaValue}>
                        {einvoice.currency || 'PEN'} · {formatPEN(einvoice.amount)}
                      </Text>
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={styles.metaLabel}>Intentos envío</Text>
                      <Text style={styles.metaValue}>{einvoice.attempts ?? 1}</Text>
                    </View>
                    {einvoice.receiptCustomer?.name ? (
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>Cliente</Text>
                        <Text style={styles.metaValue} numberOfLines={2}>
                          {einvoice.receiptCustomer.name} ({einvoice.receiptCustomer.identityNumber})
                        </Text>
                      </View>
                    ) : null}
                    {einvoice.reference?.number ? (
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>Documento ref.</Text>
                        <Text style={styles.metaValue}>
                          {einvoice.reference.number} ({einvoice.reference.reasonCode})
                        </Text>
                      </View>
                    ) : null}
                    {einvoice.replacementId ? (
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>Sustituido</Text>
                        <Text style={[styles.metaValue, { color: ui.primary }]}>
                          Sustituto emitido ({einvoice.replacementId.slice(-6)})
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  {einvoice.receiptAmounts && (
                    <View style={styles.metaCard}>
                      <Text style={styles.cardHeading}>Desglose Tributario XML</Text>
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>Op. Gravada</Text>
                        <Text style={styles.metaValue}>{formatPEN(einvoice.receiptAmounts.taxed)}</Text>
                      </View>
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>Op. Exonerada</Text>
                        <Text style={styles.metaValue}>{formatPEN(einvoice.receiptAmounts.exempt)}</Text>
                      </View>
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>IGV</Text>
                        <Text style={styles.metaValue}>{formatPEN(einvoice.receiptAmounts.igv)}</Text>
                      </View>
                      <View style={styles.metaRow}>
                        <Text style={styles.metaLabel}>Total Fiscal</Text>
                        <Text style={[styles.metaValue, { fontWeight: '800' }]}>
                          {formatPEN(einvoice.receiptAmounts.total)}
                        </Text>
                      </View>
                    </View>
                  )}

                  <View style={styles.metaCard}>
                    <View style={styles.cdrTitleRow}>
                      <ShieldCheck size={16} color={isAccepted ? ui.success : ui.textSecondary} />
                      <Text style={styles.cardHeading}>Respuesta SUNAT (CDR / Hash)</Text>
                    </View>
                    {einvoice.cdr ? (
                      <>
                        <Text style={styles.cdrDesc}>
                          Código {einvoice.cdr.responseCode}: {einvoice.cdr.description}
                        </Text>
                        {einvoice.cdr.cdrCode ? (
                          <Text style={styles.hashText}>Hash CDR: {einvoice.cdr.cdrCode}</Text>
                        ) : null}
                        {einvoice.cdr.notes && einvoice.cdr.notes.length > 0 ? (
                          <Text style={styles.cdrNotes}>{einvoice.cdr.notes.join('\n')}</Text>
                        ) : null}
                      </>
                    ) : (
                      <Text style={styles.cdrNotes}>
                        {einvoice.lastError || 'Aún sin constancia CDR registrada.'}
                      </Text>
                    )}
                    {einvoice.lastError && einvoice.cdr ? (
                      <Text style={[styles.cdrNotes, { color: ui.danger }]}>
                        Último error: {einvoice.lastError}
                      </Text>
                    ) : null}
                  </View>

                  {/* Acciones principales */}
                  <View style={styles.actionsColumn}>
                    {canRetryStatus && canRetryPermission && (
                      <TouchableOpacity
                        onPress={handleRetry}
                        disabled={retrying}
                        style={[styles.primaryBtn, retrying && styles.btnDisabled]}
                        accessibilityRole="button"
                        accessibilityLabel="Reintentar envío a SUNAT"
                      >
                        {retrying ? (
                          <ActivityIndicator size="small" color={ui.onPrimary} />
                        ) : (
                          <RotateCcw size={17} color={ui.onPrimary} />
                        )}
                        <Text style={styles.primaryBtnText}>
                          {retrying ? 'Consultando SUNAT...' : 'Reintentar envío SUNAT'}
                        </Text>
                      </TouchableOpacity>
                    )}

                    {canViewReports && (
                      <View style={styles.downloadRow}>
                        <TouchableOpacity
                          onPress={() => handleDownload('xml')}
                          disabled={downloading !== null}
                          style={[styles.secondaryBtn, downloading !== null && styles.btnDisabled]}
                          accessibilityRole="button"
                          accessibilityLabel="Descargar XML firmado"
                        >
                          {downloading === 'xml' ? (
                            <ActivityIndicator size="small" color={ui.primary} />
                          ) : (
                            <Download size={16} color={ui.primary} />
                          )}
                          <Text style={styles.secondaryBtnText}>Descargar XML</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => handleDownload('cdr')}
                          disabled={downloading !== null}
                          style={[styles.secondaryBtn, downloading !== null && styles.btnDisabled]}
                          accessibilityRole="button"
                          accessibilityLabel="Descargar CDR SUNAT"
                        >
                          {downloading === 'cdr' ? (
                            <ActivityIndicator size="small" color={ui.primary} />
                          ) : (
                            <FileText size={16} color={ui.primary} />
                          )}
                          <Text style={styles.secondaryBtnText}>Descargar CDR</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                </>
              )}

              {activeTab === 'credit_note' && (
                <View style={styles.formCard}>
                  <View style={styles.infoBanner}>
                    <FileMinus size={16} color={ui.primary} />
                    <Text style={styles.infoBannerText}>
                      Nota de Crédito total (Tipo 07) sobre {einvoice.documentNumber} por{' '}
                      {formatPEN(einvoice.amount)}. Conserva la afectación IGV del comprobante original.
                    </Text>
                  </View>

                  <Text style={styles.fieldLabel}>Motivo SUNAT (Catálogo 09)</Text>
                  <View style={styles.reasonList}>
                    {SUNAT_CREDIT_NOTE_REASONS.map((opt) => {
                      const selected = ncReasonCode === opt.code;
                      return (
                        <TouchableOpacity
                          key={opt.code}
                          onPress={() => {
                            setNcReasonCode(opt.code);
                            setNcReasonDesc(opt.label);
                          }}
                          style={[styles.reasonOption, selected && styles.reasonOptionSelected]}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                        >
                          <Text style={[styles.reasonCode, selected && { color: ui.primary }]}>
                            {opt.code}
                          </Text>
                          <Text style={[styles.reasonLabel, selected && { color: ui.text }]}>
                            {opt.label}
                          </Text>
                          {selected && <CheckCircle2 size={16} color={ui.primary} />}
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Sustento / Descripción</Text>
                  <TextInput
                    value={ncReasonDesc}
                    onChangeText={setNcReasonDesc}
                    maxLength={200}
                    placeholder="Descripción del motivo"
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />

                  <TouchableOpacity
                    onPress={() => handleEmitNote('07')}
                    disabled={submitting}
                    style={[styles.primaryBtn, submitting && styles.btnDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel="Confirmar y emitir Nota de Crédito"
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color={ui.onPrimary} />
                    ) : (
                      <FileMinus size={17} color={ui.onPrimary} />
                    )}
                    <Text style={styles.primaryBtnText}>
                      {submitting ? 'Emitiendo a SUNAT...' : 'Emitir Nota de Crédito (07)'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {activeTab === 'debit_note' && (
                <View style={styles.formCard}>
                  <View style={styles.infoBanner}>
                    <FilePlus2 size={16} color={ui.warning} />
                    <Text style={styles.infoBannerText}>
                      Nota de Débito (Tipo 08) vinculada a {einvoice.documentNumber}.
                    </Text>
                  </View>

                  <Text style={styles.fieldLabel}>Motivo SUNAT (Catálogo 10)</Text>
                  <View style={styles.reasonList}>
                    {SUNAT_DEBIT_NOTE_REASONS.map((opt) => {
                      const selected = ndReasonCode === opt.code;
                      return (
                        <TouchableOpacity
                          key={opt.code}
                          onPress={() => {
                            setNdReasonCode(opt.code);
                            setNdReasonDesc(opt.label);
                          }}
                          style={[styles.reasonOption, selected && styles.reasonOptionSelected]}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                        >
                          <Text style={[styles.reasonCode, selected && { color: ui.primary }]}>
                            {opt.code}
                          </Text>
                          <Text style={[styles.reasonLabel, selected && { color: ui.text }]}>
                            {opt.label}
                          </Text>
                          {selected && <CheckCircle2 size={16} color={ui.primary} />}
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={styles.fieldLabel}>Sustento / Descripción</Text>
                  <TextInput
                    value={ndReasonDesc}
                    onChangeText={setNdReasonDesc}
                    maxLength={200}
                    placeholder="Descripción del cargo o motivo"
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />

                  <TouchableOpacity
                    onPress={() => handleEmitNote('08')}
                    disabled={submitting}
                    style={[styles.primaryBtn, submitting && styles.btnDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel="Confirmar y emitir Nota de Débito"
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color={ui.onPrimary} />
                    ) : (
                      <FilePlus2 size={17} color={ui.onPrimary} />
                    )}
                    <Text style={styles.primaryBtnText}>
                      {submitting ? 'Emitiendo a SUNAT...' : 'Emitir Nota de Débito (08)'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {activeTab === 'replacement' && (
                <View style={styles.formCard}>
                  <View style={styles.infoBanner}>
                    <RefreshCw size={16} color={ui.primary} />
                    <Text style={styles.infoBannerText}>
                      Original: {einvoice.documentNumber} · Total {formatPEN(einvoice.amount)} · IGV actual: {taxRate}%
                    </Text>
                  </View>

                  {eligibleCreditNotes.length === 0 ? (
                    <View style={styles.warningBox}>
                      <AlertCircle size={18} color={ui.warning} />
                      <Text style={styles.warningBoxText}>
                        Primero emite una Nota de Crédito total aceptada (motivos 01, 02 o 06) sobre este comprobante para habilitar el sustituto. Si ya existe, amplía el filtro de fechas.
                      </Text>
                    </View>
                  ) : (
                    <>
                      <Text style={styles.fieldLabel}>Nota de Crédito Aceptada</Text>
                      <View style={styles.reasonList}>
                        {eligibleCreditNotes.map((note) => {
                          const selected = resolvedRepNoteId === note.id;
                          return (
                            <TouchableOpacity
                              key={note.id}
                              onPress={() => setRepNoteId(note.id)}
                              style={[styles.reasonOption, selected && styles.reasonOptionSelected]}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                            >
                              <Text style={styles.reasonLabel}>
                                {note.documentNumber} · {formatPEN(note.amount)}
                              </Text>
                              {selected && <CheckCircle2 size={16} color={ui.primary} />}
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      <Text style={styles.fieldLabel}>
                        {einvoice.documentType === '01'
                          ? 'RUC del cliente (11 dígitos)'
                          : 'DNI (8) o RUC (11) del cliente'}
                      </Text>
                      <TextInput
                        value={repDocNumber}
                        onChangeText={setRepDocNumber}
                        keyboardType="numeric"
                        maxLength={11}
                        placeholder={einvoice.documentType === '01' ? '20XXXXXXXXX' : 'DNI o RUC'}
                        placeholderTextColor={ui.textMuted}
                        style={styles.input}
                      />

                      <Text style={styles.fieldLabel}>Nombre o Razón Social</Text>
                      <TextInput
                        value={repName}
                        onChangeText={setRepName}
                        maxLength={200}
                        placeholder="Nombre completo o razón social"
                        placeholderTextColor={ui.textMuted}
                        style={styles.input}
                      />

                      <Text style={styles.fieldLabel}>Dirección fiscal (opcional)</Text>
                      <TextInput
                        value={repAddress}
                        onChangeText={setRepAddress}
                        maxLength={300}
                        placeholder="Dirección del cliente"
                        placeholderTextColor={ui.textMuted}
                        style={styles.input}
                      />

                      <TouchableOpacity
                        onPress={handleEmitReplacement}
                        disabled={submitting}
                        style={[styles.primaryBtn, submitting && styles.btnDisabled]}
                        accessibilityRole="button"
                        accessibilityLabel="Confirmar y emitir comprobante sustituto"
                      >
                        {submitting ? (
                          <ActivityIndicator size="small" color={ui.onPrimary} />
                        ) : (
                          <RefreshCw size={17} color={ui.onPrimary} />
                        )}
                        <Text style={styles.primaryBtnText}>
                          {submitting ? 'Emitiendo sustituto...' : 'Confirmar y Emitir Sustituto'}
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }
);

export const EinvoiceActionsModal: React.FC<EinvoiceActionsModalProps> = React.memo((props) => {
  if (!props.visible || !props.einvoice) return null;
  return <EinvoiceActionsModalContent {...props} einvoice={props.einvoice} />;
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,28,49,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    paddingTop: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  docNumber: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  docSub: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsBar: {
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    maxHeight: 52,
  },
  tabsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  tabPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: ui.surfaceMuted,
  },
  tabPillActive: {
    backgroundColor: ui.primarySoft,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  tabTextActive: {
    color: ui.primary,
  },
  scrollBody: {
    padding: 18,
    gap: 14,
  },
  metaCard: {
    backgroundColor: ui.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 8,
  },
  cardHeading: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  metaLabel: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  metaValue: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    flexShrink: 1,
    textAlign: 'right',
  },
  cdrTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  cdrDesc: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
    lineHeight: 19,
  },
  hashText: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: ui.textSecondary,
  },
  cdrNotes: {
    fontSize: 12,
    color: ui.textSecondary,
    lineHeight: 18,
  },
  actionsColumn: {
    gap: 10,
  },
  downloadRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryBtn: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  primaryBtnText: {
    color: ui.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  secondaryBtnText: {
    color: ui.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  formCard: {
    gap: 12,
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: ui.primarySoft,
    padding: 12,
    borderRadius: 12,
  },
  infoBannerText: {
    flex: 1,
    fontSize: 12,
    color: ui.text,
    lineHeight: 18,
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: ui.warningSoft,
    padding: 12,
    borderRadius: 12,
  },
  warningBoxText: {
    flex: 1,
    fontSize: 12,
    color: ui.warning,
    lineHeight: 18,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
    marginTop: 2,
  },
  reasonList: {
    gap: 6,
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
  },
  reasonOptionSelected: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  reasonCode: {
    fontSize: 12,
    fontWeight: '800',
    color: ui.textMuted,
    width: 24,
  },
  reasonLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  input: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
    paddingHorizontal: 14,
    fontSize: 14,
    color: ui.text,
  },
});
