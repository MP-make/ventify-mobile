import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  AppState,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Share,
} from 'react-native';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  CheckCircle2,
  AlertCircle,
  Printer,
  Share2,
  RefreshCw,
  Search,
  User,
  CreditCard,
  Banknote,
  Smartphone,
  ArrowRight,
  ShieldAlert,
  FileText,
  Clock,
  Layers,
  Check,
  Plus,
  Trash2,
  Tag,
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { useSettings } from '@/context/SettingsContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { sharedRequestCache } from '@/lib/request-cache';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { ReceiptTicketPreview } from '@/components/ReceiptTicketPreview';
import { isValidRUC, isValidDNI, numberToSpanishWordsPEN } from '@/lib/invoicing/types';
import { computeSaleTaxBreakdown } from '@/lib/invoicing/receipt-amounts';
import { lookupDocument, DocumentLookupResult } from '@/lib/dni-ruc-service';
import { createSaleTransaction, CreateSaleTransactionParams, getAvailableSaleSellers, SaleSellerOption } from '@/services/sale-service';
import { enqueueOfflineSale } from '@/services/offline-sync-service';
import { getCustomers } from '@/services/crm-operations-service';
import { createQuote } from '@/services/enterprise-ops-service';
import { buildSaleReceiptEscPos } from '@/lib/printing/escpos-builder';
import {
  getPrinterConfig,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { presentationFactor } from '@/lib/presentation-parity';
import { resolveCheckoutPayment, type CheckoutPaymentSplitInput } from '@/lib/checkout-payment';
import type { Branch, Customer, CartItem, SaleDocumentType, SalePaymentSplit } from '@/types';

interface CheckoutModalProps {
  visible: boolean;
  onClose: () => void;
  onSaleSuccess?: (saleResult: any) => void;
  initialDocType?: 'nota_venta' | 'boleta' | 'factura' | 'quote' | 'cotizacion';
  branch?: Branch | null;
}

type CheckoutDocType = 'nota_venta' | 'boleta' | 'factura' | 'cotizacion';
type ActivePaymentCategory = 'cash' | 'yape' | 'plin' | 'card' | 'transfer' | 'mixed' | 'fiado' | 'credits';

const PAYMENT_LOGOS: Record<string, any> = {
  yape: require('../../assets/payment/yape.jpeg'),
  plin: require('../../assets/payment/plin.png'),
  culqi: require('../../assets/payment/culqi.jpeg'),
  mastercard: require('../../assets/payment/mastercard.webp'),
};

const getMethodLogo = (method: { id?: string; name?: string; kind?: string; provider?: string }) => {
  const str = `${method.id || ''} ${method.name || ''} ${method.provider || ''}`.toLowerCase();
  if (str.includes('yape')) return PAYMENT_LOGOS.yape;
  if (str.includes('plin')) return PAYMENT_LOGOS.plin;
  if (str.includes('culqi')) return PAYMENT_LOGOS.culqi;
  if (
    str.includes('tarjeta') ||
    str.includes('card') ||
    str.includes('pos') ||
    str.includes('visa') ||
    str.includes('mastercard') ||
    str.includes('transferencia') ||
    str.includes('transfer') ||
    method.kind === 'terminal'
  ) {
    return PAYMENT_LOGOS.mastercard;
  }
  return null;
};

interface CheckoutCustomerInputsProps {
  docType: CheckoutDocType;
  customerRuc: string;
  setCustomerRuc: (val: string) => void;
  customerDni: string;
  setCustomerDni: (val: string) => void;
  customerName: string;
  setCustomerName: (val: string) => void;
  customerAddress: string;
  setCustomerAddress: (val: string) => void;
  customerPhone: string;
  setCustomerPhone: (val: string) => void;
  onBlurSync: () => void;
  isSearchingDoc: boolean;
  safeTotal: number;
  docSearchSuccess: string | null;
  docError: string | null;
}

const CheckoutCustomerInputs = React.memo<CheckoutCustomerInputsProps>(({
  docType,
  customerRuc,
  setCustomerRuc,
  customerDni,
  setCustomerDni,
  customerName,
  setCustomerName,
  customerAddress,
  setCustomerAddress,
  customerPhone,
  setCustomerPhone,
  onBlurSync,
  isSearchingDoc,
  safeTotal,
  docSearchSuccess,
  docError,
}) => {
  return (
    <>
      {/* FACTURA: RUC es prioridad 1 */}
      {docType === 'factura' ? (
        <View style={styles.formGroupCompact}>
          <Text style={styles.inputLabelCompact}>
            RUC (11 dígitos) <Text style={styles.required}>*</Text>
          </Text>
          <View style={styles.inputSearchRow}>
            <TextInput
              style={[styles.inputCompact, styles.inputFlex]}
              accessibilityLabel="RUC, 11 dígitos"
              value={customerRuc}
              onChangeText={setCustomerRuc}
              onBlur={onBlurSync}
              placeholder="20XXXXXXXXX"
              keyboardType="numeric"
              maxLength={11}
              placeholderTextColor={ui.textMuted}
            />
            {isSearchingDoc ? (
              <View style={styles.searchLoader}>
                <ActivityIndicator size="small" color={ui.primary} />
              </View>
            ) : null}
          </View>
          <Text style={styles.inputLabelCompact}>Razón Social SUNAT</Text>
          <TextInput
            style={styles.inputCompact}
            accessibilityLabel="Razón social SUNAT"
            value={customerName}
            onChangeText={setCustomerName}
            onBlur={onBlurSync}
            placeholder="Nombre o Razón Social"
            placeholderTextColor={ui.textMuted}
          />
          <View style={styles.rowTwoCols}>
            <View style={[styles.formGroupCompact, styles.colFlex]}>
              <Text style={styles.inputLabelCompact}>Dirección Fiscal</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerAddress}
                onChangeText={setCustomerAddress}
                onBlur={onBlurSync}
                placeholder="Dirección fiscal"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroupCompact, styles.colFlex]}>
              <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerPhone}
                onChangeText={setCustomerPhone}
                onBlur={onBlurSync}
                placeholder="9XXXXXXXX"
                keyboardType="phone-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>
        </View>
      ) : docType === 'boleta' ? (
        /* BOLETA: DNI es prioridad 1 */
        <View style={styles.formGroupCompact}>
          <Text style={styles.inputLabelCompact}>
            DNI {safeTotal >= 700 ? '(Obligatorio > S/700)' : '(Prioridad)'}
          </Text>
          <View style={styles.inputSearchRow}>
            <TextInput
              style={[styles.inputCompact, styles.inputFlex]}
              value={customerDni}
              onChangeText={setCustomerDni}
              onBlur={onBlurSync}
              placeholder="8 dígitos"
              keyboardType="numeric"
              maxLength={8}
              placeholderTextColor={ui.textMuted}
            />
            {isSearchingDoc ? (
              <View style={styles.searchLoader}>
                <ActivityIndicator size="small" color={ui.primary} />
              </View>
            ) : null}
          </View>
          <View style={styles.rowTwoCols}>
            <View style={[styles.formGroupCompact, { flex: 1.4 }]}>
              <Text style={styles.inputLabelCompact}>Nombre del Cliente</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerName}
                onChangeText={setCustomerName}
                onBlur={onBlurSync}
                placeholder="Público General"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroupCompact, styles.colFlex]}>
              <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerPhone}
                onChangeText={setCustomerPhone}
                onBlur={onBlurSync}
                placeholder="9XXXXXXXX"
                keyboardType="phone-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>
        </View>
      ) : (
        /* NOTA DE VENTA Y COTIZACIÓN: Nombre es prioridad 1 */
        <View style={styles.formGroupCompact}>
          <Text style={styles.inputLabelCompact}>Nombre del Cliente (Prioridad)</Text>
          <TextInput
            style={styles.inputCompact}
            value={customerName}
            onChangeText={setCustomerName}
            onBlur={onBlurSync}
            placeholder="Público General"
            placeholderTextColor={ui.textMuted}
          />
          <View style={styles.rowTwoCols}>
            <View style={[styles.formGroupCompact, styles.colFlex]}>
              <Text style={styles.inputLabelCompact}>DNI (Opcional)</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerDni}
                onChangeText={setCustomerDni}
                onBlur={onBlurSync}
                placeholder="8 dígitos"
                keyboardType="numeric"
                maxLength={8}
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroupCompact, styles.colFlex]}>
              <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerPhone}
                onChangeText={setCustomerPhone}
                onBlur={onBlurSync}
                placeholder="9XXXXXXXX"
                keyboardType="phone-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>
        </View>
      )}

      {/* Mensajes de verificación o error */}
      {docSearchSuccess ? (
        <View style={styles.docSuccessBadge}>
          <Check size={14} color={ui.success} />
          <Text style={styles.docSuccessText}>{docSearchSuccess}</Text>
        </View>
      ) : null}
      {docError ? (
        <View style={styles.docErrorBadge}>
          <AlertCircle size={14} color={ui.danger} />
          <Text style={styles.docErrorText}>{docError}</Text>
        </View>
      ) : null}
    </>
  );
});

export interface MixedSplitOption {
  key: string;
  methodId?: string;
  label: string;
  category: 'cash' | 'card' | 'digital';
  digitalProvider?: 'yape' | 'plin' | 'transferencia';
}

export interface MixedSplitRow {
  id: string;
  methodId?: string;
  category: 'cash' | 'card' | 'digital';
  digitalProvider?: 'yape' | 'plin' | 'transferencia';
  amountStr: string;
}

interface CheckoutMixedPaymentsProps {
  mixedSplits: MixedSplitRow[];
  splitOptions: MixedSplitOption[];
  onChangeSplit: (id: string, patch: Partial<MixedSplitRow>) => void;
  onAddSplit: () => void;
  onRemoveSplit: (id: string) => void;
  onFillRemaining: (id: string) => void;
  mixedAllocation: { assigned: number; pending: number; isExact: boolean };
  safeTotal: number;
}

const DEFAULT_MIXED_SPLIT_OPTIONS: MixedSplitOption[] = [
  { key: 'cash', label: 'Efectivo', category: 'cash' },
  { key: 'yape', label: 'Yape', category: 'digital', digitalProvider: 'yape' },
  { key: 'plin', label: 'Plin', category: 'digital', digitalProvider: 'plin' },
  { key: 'card', label: 'Tarjeta', category: 'card' },
];

const CheckoutMixedPayments = React.memo<CheckoutMixedPaymentsProps>(({
  mixedSplits,
  splitOptions,
  onChangeSplit,
  onAddSplit,
  onRemoveSplit,
  onFillRemaining,
  mixedAllocation,
  safeTotal,
}) => {
  const effectiveOptions = splitOptions.length > 0 ? splitOptions : DEFAULT_MIXED_SPLIT_OPTIONS;
  return (
    <View style={styles.paymentDetailBox}>
      <View style={styles.mixedHeaderRow}>
        <Text style={styles.mixedBoxTitle}>Desglose de Pago Mixto ({mixedSplits.length})</Text>
        {mixedSplits.length < 5 ? (
          <TouchableOpacity
            style={styles.mixedAddBtn}
            onPress={onAddSplit}
            accessibilityRole="button"
            accessibilityLabel="Agregar método de pago"
          >
            <Plus size={13} color={ui.primary} />
            <Text style={styles.mixedAddBtnText}>Agregar medio</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {mixedSplits.map((row, idx) => {
        const activeKey =
          row.methodId ||
          (row.category === 'digital' ? row.digitalProvider || 'yape' : row.category);
        return (
          <View key={row.id} style={styles.mixedSplitCard}>
            <View style={styles.mixedSplitTopRow}>
              <Text style={styles.mixedSplitIndex}>Parte {idx + 1}</Text>
              <View style={styles.mixedSplitTopActions}>
                {mixedAllocation.pending > 0.01 ? (
                  <TouchableOpacity
                    style={styles.mixedFillBtn}
                    onPress={() => onFillRemaining(row.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Completar saldo restante en parte ${idx + 1}`}
                  >
                    <Text style={styles.mixedFillBtnText}>
                      + Saldo ({formatPEN(mixedAllocation.pending)})
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {mixedSplits.length > 1 ? (
                  <TouchableOpacity
                    onPress={() => onRemoveSplit(row.id)}
                    style={styles.mixedRemoveBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Quitar parte ${idx + 1}`}
                    hitSlop={6}
                  >
                    <Trash2 size={15} color={ui.danger} />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <View style={styles.mixedProviderRow}>
              {effectiveOptions.map((opt) => {
                const selected =
                  activeKey === opt.key ||
                  (opt.methodId && row.methodId === opt.methodId) ||
                  (!row.methodId &&
                    (opt.digitalProvider
                      ? row.category === 'digital' && row.digitalProvider === opt.digitalProvider
                      : row.category === opt.category));
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.providerChip,
                      selected && styles.providerChipActive,
                    ]}
                    onPress={() =>
                      onChangeSplit(row.id, {
                        methodId: opt.methodId,
                        category: opt.category,
                        digitalProvider: opt.digitalProvider,
                      })
                    }
                    accessibilityRole="button"
                    accessibilityState={{ selected: Boolean(selected) }}
                  >
                    <Text
                      style={[
                        styles.providerChipText,
                        selected && styles.providerChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.mixedAmountInputRow}>
              <Text style={styles.mixedCurrencyPrefix}>S/</Text>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                accessibilityLabel={`Monto parte ${idx + 1}`}
                value={row.amountStr}
                onChangeText={(val) => onChangeSplit(row.id, { amountStr: val })}
                placeholder="0.00"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>
        );
      })}

      {/* Balance Mixto */}
      <View style={styles.mixedBalanceRow}>
        <Text style={styles.mixedBalanceText}>
          Asignado: {formatPEN(mixedAllocation.assigned)} / Total: {formatPEN(safeTotal)}
        </Text>
        {mixedAllocation.isExact ? (
          <Text style={styles.mixedExactText}>¡Cuadre exacto!</Text>
        ) : (
          <Text style={styles.mixedPendingText}>
            {mixedAllocation.pending >= 0
              ? `Falta: ${formatPEN(mixedAllocation.pending)}`
              : `Exceso: ${formatPEN(Math.abs(mixedAllocation.pending))}`}
          </Text>
        )}
      </View>
    </View>
  );
});

const normalizeInitialDocType = (raw?: string | null): CheckoutDocType | null => {
  if (!raw) return null;
  const val = String(raw).toLowerCase();
  if (val === 'quote' || val === 'cotizacion' || val === 'cot') return 'cotizacion';
  if (val === 'boleta' || val === '03') return 'boleta';
  if (val === 'factura' || val === '01') return 'factura';
  if (val === 'nota_venta' || val === 'nv' || val === '80') return 'nota_venta';
  return null;
};

const resolveCategoryFromMethod = (method: any): ActivePaymentCategory => {
  const id = String(method?.id || '').toLowerCase();
  const kind = String(method?.kind || '').toLowerCase();
  const prov = String(method?.provider || '').toLowerCase();
  if (kind === 'cash' || id === 'efectivo') return 'cash';
  if (id === 'fiado') return 'fiado';
  if (kind === 'credit' || id === 'creditos' || id === 'credits') return 'credits';
  if (kind === 'mixed' || id === 'mixto') return 'mixed';
  if (`${id} ${String(method?.name || '').toLowerCase()} ${prov}`.includes('yape')) return 'yape';
  if (`${id} ${String(method?.name || '').toLowerCase()} ${prov}`.includes('plin')) return 'plin';
  if (kind === 'digital' || id === 'transferencia' || id.includes('transfer')) return 'transfer';
  return 'card';
};

export const CheckoutModal: React.FC<CheckoutModalProps> = React.memo(({
  visible,
  onClose,
  onSaleSuccess,
  initialDocType,
  branch,
}) => {
  const insets = useSafeAreaInsets();
  const { accountId, branchId, user, userProfile } = useAuth();
  const {
    items,
    subtotal: cartSubtotal,
    total,
    totalAmount,
    customer: cartCustomer,
    saleRequestId,
    sourceQuoteId,
    discountAmount,
    setDiscount,
    invoiceIntent,
    setInvoiceIntent,
    taxAmount,
    shippingAmount,
    clearCart,
    setCustomer: setCartCustomer,
  } = useCart();
  const {
    posSettings,
    businessSettings,
    businessData,
    activeBranch,
    activeBranchName,
    activeCashSession,
    paymentMethods,
    invoicingEnabled,
    taxProfile,
    emitterInfo,
    isOnline: settingsIsOnline,
    configurationReady,
    configurationError,
    refreshConfiguration,
    refreshOfflineCount,
  } = useSettings();

  const resolvedBranch = branch || activeBranch || null;
  const safeTotal = totalAmount ?? total ?? 0;
  const [receiptPaperWidth, setReceiptPaperWidth] = useState<58 | 80>(80);
  const [discountInputStr, setDiscountInputStr] = useState<string>('');
  const [showDiscountEditor, setShowDiscountEditor] = useState<boolean>(false);

  // Métodos de pago configurados por el dueño en Firestore
  const configuredMethods = useMemo(() => {
    const list = Array.isArray(posSettings?.methods) && posSettings.methods.length > 0
      ? posSettings.methods
      : Array.isArray(paymentMethods) && paymentMethods.length > 0
        ? paymentMethods
        : [
            { id: 'efectivo', name: 'Efectivo', kind: 'cash', enabled: true, order: 0 },
            { id: 'yape', name: 'Yape', kind: 'digital', enabled: true, order: 1, provider: 'yape' },
            { id: 'plin', name: 'Plin', kind: 'digital', enabled: true, order: 2, provider: 'plin' },
            { id: 'transferencia', name: 'Transferencia', kind: 'digital', enabled: true, order: 4 },
            { id: 'mixto', name: 'Mixto', kind: 'mixed', enabled: true, order: 5 },
            { id: 'creditos', name: 'Créditos', kind: 'credit', enabled: true, order: 6 },
          ];

    return list
      .filter((m: any) => m.enabled !== false && (m.kind !== 'mixed' || posSettings?.allowMixedPayment !== false))
      .map((m: any) => ({ ...m, reportCategory: m.reportCategory || (m.kind === 'terminal' || m.kind === 'mixed' ? 'card' : m.kind === 'credit' ? 'credit' : m.kind === 'digital' ? 'digital' : 'cash') }))
      .sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
  }, [posSettings?.methods, posSettings?.allowMixedPayment, paymentMethods]);

  const mixedSplitOptions = useMemo<MixedSplitOption[]>(() => {
    const eligible = configuredMethods.filter(
      (m: any) => m.enabled !== false && m.kind !== 'mixed' && m.kind !== 'credit'
    );
    if (!eligible.length) return DEFAULT_MIXED_SPLIT_OPTIONS;
    return eligible.map((m: any) => {
      const text = `${m.id} ${m.name} ${m.provider || ''}`.toLowerCase();
      const cat: 'cash' | 'card' | 'digital' =
        m.kind === 'cash' || m.reportCategory === 'cash'
          ? 'cash'
          : m.kind === 'terminal' || m.reportCategory === 'card'
            ? 'card'
            : 'digital';
      let digitalProvider: 'yape' | 'plin' | 'transferencia' | undefined;
      if (cat === 'digital') {
        if (text.includes('yape')) digitalProvider = 'yape';
        else if (text.includes('plin')) digitalProvider = 'plin';
        else if (/transfer|bcp|banco/.test(text)) digitalProvider = 'transferencia';
      }
      return {
        key: String(m.id),
        methodId: String(m.id),
        label: String(m.name || m.id),
        category: cat,
        ...(digitalProvider ? { digitalProvider } : {}),
      };
    });
  }, [configuredMethods]);

  const paymentOptions = configuredMethods;

  const [selectedMethodId, setSelectedMethodId] = useState<string>('efectivo');

  // 1. Selector de Comprobante y candado de selección manual
  const [docType, setDocType] = useState<CheckoutDocType>('nota_venta');
  const documentSelectionLockedRef = useRef<boolean>(false);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const lookupSeqRef = useRef<number>(0);

  // Opciones de comprobante permitidas: si no está habilitada facturación en Super Admin, solo Nota de Venta y Cotización
  const docTypeOptions = useMemo(() => {
    if (!invoicingEnabled) {
      return [
        { id: 'nota_venta', label: 'Nota Venta' },
        { id: 'cotizacion', label: 'Cotización' },
      ];
    }
    return [
      { id: 'nota_venta', label: 'Nota Venta' },
      { id: 'boleta', label: 'Boleta 03' },
      { id: 'factura', label: 'Factura 01' },
      { id: 'cotizacion', label: 'Cotización' },
    ];
  }, [invoicingEnabled]);

  // Si la cuenta no tiene habilitada facturación, forzar a nota_venta
  useEffect(() => {
    if (!invoicingEnabled && (docType === 'boleta' || docType === 'factura')) {
      setDocType('nota_venta');
    }
  }, [invoicingEnabled, docType]);

  // 2. Identificación de Cliente (RENIEC / SUNAT)
  const [customerDni, setCustomerDni] = useState('');
  const [customerRuc, setCustomerRuc] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customersList, setCustomersList] = useState<Customer[]>([]);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const debouncedCustomerSearch = useDebouncedValue(customerSearchQuery, 150);
  const skipNextLookupDocRef = useRef<string | null>(null);

  const customerFormRef = useRef({
    name: customerName,
    dni: customerDni,
    ruc: customerRuc,
    phone: customerPhone,
    address: customerAddress,
    selectedCustomer,
  });
  customerFormRef.current = {
    name: customerName,
    dni: customerDni,
    ruc: customerRuc,
    phone: customerPhone,
    address: customerAddress,
    selectedCustomer,
  };

  const filteredPickerCustomers = useMemo(() => {
    const q = debouncedCustomerSearch.trim().toLowerCase();
    if (!q) return customersList.slice(0, 6);
    return customersList
      .filter((c) => {
        const name = (c.name || '').toLowerCase();
        const dni = (c.dni || '').toLowerCase();
        const ruc = (c.ruc || '').toLowerCase();
        const phone = (c.phone || '').toLowerCase();
        return name.includes(q) || dni.includes(q) || ruc.includes(q) || phone.includes(q);
      })
      .slice(0, 12);
  }, [customersList, debouncedCustomerSearch]);
  const [isSearchingDoc, setIsSearchingDoc] = useState(false);
  const [docSearchSuccess, setDocSearchSuccess] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  // Sincronizar datos de cliente con CartContext en onBlur/cierre/pausa/confirmación
  const syncCustomerToCart = useCallback((patch?: {
    name?: string;
    dni?: string;
    ruc?: string;
    phone?: string;
    address?: string;
  }) => {
    const curr = customerFormRef.current;
    const updatedName = (patch?.name !== undefined ? patch.name : curr.name).trim();
    const updatedDni = (patch?.dni !== undefined ? patch.dni : curr.dni).trim();
    const updatedRuc = (patch?.ruc !== undefined ? patch.ruc : curr.ruc).trim();
    const updatedPhone = (patch?.phone !== undefined ? patch.phone : curr.phone).trim();
    const updatedAddress = (patch?.address !== undefined ? patch.address : curr.address).trim();

    if (updatedName || updatedDni || updatedRuc) {
      setCartCustomer({
        id: curr.selectedCustomer?.id || `cust_${Date.now()}`,
        name: updatedName || 'Cliente General',
        dni: updatedDni || undefined,
        ruc: updatedRuc || undefined,
        phone: updatedPhone || undefined,
        address: updatedAddress || undefined,
        accountId: accountId || '',
        totalPurchases: curr.selectedCustomer?.totalPurchases || 0,
        totalSpent: curr.selectedCustomer?.totalSpent || 0,
      });
    } else {
      setCartCustomer(null);
    }
  }, [accountId, setCartCustomer]);

  const handleBlurCustomerSync = useCallback(() => {
    syncCustomerToCart();
  }, [syncCustomerToCart]);

  // 3. Método de Pago y Parámetros
  const [paymentCategory, setPaymentCategory] = useState<ActivePaymentCategory>('cash');
  const [cashReceived, setCashReceived] = useState<number>(safeTotal);
  const [operationReference, setOperationReference] = useState('');
  const [creditDays, setCreditDays] = useState('30');
  const [notes, setNotes] = useState('');
  const [qrZoomVisible, setQrZoomVisible] = useState(false);

  const selectedMethodConfig = useMemo(
    () =>
      paymentOptions.find((m: any) => m.id === selectedMethodId) ||
      paymentOptions.find((m: any) => resolveCategoryFromMethod(m) === paymentCategory) ||
      null,
    [paymentOptions, selectedMethodId, paymentCategory]
  );
  const selectedMethodQrUrl = String(selectedMethodConfig?.qrUrl || '').trim();
  const selectedMethodPhone = String(selectedMethodConfig?.qrLabel || posSettings?.digitalPhone || '').trim();
  const digitalHolder = String(posSettings?.digitalName || businessSettings?.businessName || '').trim();

  useEffect(() => {
    setQrZoomVisible(false);
  }, [visible, selectedMethodId]);

  // 4. Pago Mixto dinámico (N filas configurables)
  const [mixedSplits, setMixedSplits] = useState<MixedSplitRow[]>([
    { id: 'split_1', category: 'cash', amountStr: '' },
    { id: 'split_2', category: 'digital', digitalProvider: 'yape', amountStr: '' },
  ]);

  const handleChangeMixedSplit = useCallback((id: string, patch: Partial<MixedSplitRow>) => {
    setMixedSplits((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  }, []);

  const handleAddMixedSplit = useCallback(() => {
    setMixedSplits((prev) => {
      if (prev.length >= 5) return prev;
      return [
        ...prev,
        { id: `split_${Date.now()}_${prev.length + 1}`, category: 'card', amountStr: '' },
      ];
    });
  }, []);

  const handleRemoveMixedSplit = useCallback((id: string) => {
    setMixedSplits((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
  }, []);

  const handleFillMixedRemaining = useCallback((id: string) => {
    setMixedSplits((prev) => {
      const currentRow = prev.find((r) => r.id === id);
      if (!currentRow) return prev;
      const otherTotal = prev.reduce(
        (sum, r) => (r.id === id ? sum : sum + (parseFloat(r.amountStr) || 0)),
        0
      );
      const remaining = Math.max(0, Math.round((safeTotal - otherTotal) * 100) / 100);
      return prev.map((r) => (r.id === id ? { ...r, amountStr: remaining > 0 ? remaining.toFixed(2) : '' } : r));
    });
  }, [safeTotal]);

  // 5. Estados de Envío y Pantalla de Éxito
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saleResult, setSaleResult] = useState<any | null>(null);
  const [saleSellers, setSaleSellers] = useState<SaleSellerOption[]>([]);
  const [selectedSellerId, setSelectedSellerId] = useState('');
  const [showSellerOptions, setShowSellerOptions] = useState(false);
  const [sellerLoadError, setSellerLoadError] = useState<string | null>(null);
  const checkoutOperationId = useRef<string | null>(null);
  const activeSaleTokenRef = useRef<string | null>(null);
  const wasVisibleRef = useRef(false);
  const [isSuccessView, setIsSuccessView] = useState(false);
  const [ticketPrinting, setTicketPrinting] = useState(false);

  const sellerAttributionEnabled = posSettings?.enableSellerAttribution === true;
  const sellerSelectionRequired = sellerAttributionEnabled && posSettings?.requireSellerSelection === true;
  const selectedSeller = saleSellers.find((seller) => seller.id === selectedSellerId);

  useEffect(() => {
    if (!visible || isSuccessView || typeof AppState?.addEventListener !== 'function') return;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        syncCustomerToCart();
      }
    });
    return () => sub.remove();
  }, [visible, isSuccessView, syncCustomerToCart]);

  useEffect(() => {
    let active = true;
    if (!visible || !sellerAttributionEnabled || !branchId) {
      setSaleSellers([]);
      setSelectedSellerId('');
      setSellerLoadError(null);
      return () => { active = false; };
    }
    getAvailableSaleSellers(branchId)
      .then((sellers) => {
        if (!active) return;
        setSaleSellers(sellers);
        const signedInSeller = sellers.find((seller) => seller.userId === user?.uid);
        setSelectedSellerId((current) => current || signedInSeller?.id || '');
        setSellerLoadError(null);
      })
      .catch((error) => {
        if (active) setSellerLoadError(error?.message || 'No se pudo cargar la lista de vendedores.');
      });
    return () => { active = false; };
  }, [visible, sellerAttributionEnabled, branchId, user?.uid]);

  // Cargar clientes existentes solo al abrir buscador o elegir fiado/créditos (con caché TTL)
  const shouldLoadCustomers =
    visible && Boolean(accountId) && (showCustomerPicker || paymentCategory === 'fiado' || paymentCategory === 'credits');
  useEffect(() => {
    if (!shouldLoadCustomers || !accountId) return;
    let active = true;
    sharedRequestCache
      .getOrLoad(`customers:${accountId}`, 180_000, () => getCustomers(accountId))
      .then((list) => {
        if (active) setCustomersList(list || []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shouldLoadCustomers, accountId]);

  // Inicializar únicamente en la transición closed -> open para que limpiar el carrito no borre la vista del comprobante
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      wasVisibleRef.current = true;
      documentSelectionLockedRef.current = false;
      setIsSuccessView(false);
      setSaleResult(null);
      activeSaleTokenRef.current = null;
      setCashReceived(safeTotal);
      setDiscountInputStr(discountAmount > 0 ? String(discountAmount) : '');
      setShowDiscountEditor(false);
      setDocError(null);
      setDocSearchSuccess(null);

      const firstSplitOpt = mixedSplitOptions[0] || DEFAULT_MIXED_SPLIT_OPTIONS[0];
      const secondSplitOpt = mixedSplitOptions[1] || firstSplitOpt;
      setMixedSplits([
        {
          id: 'split_1',
          methodId: firstSplitOpt.methodId,
          category: firstSplitOpt.category,
          digitalProvider: firstSplitOpt.digitalProvider,
          amountStr: '',
        },
        {
          id: 'split_2',
          methodId: secondSplitOpt.methodId,
          category: secondSplitOpt.category,
          digitalProvider: secondSplitOpt.digitalProvider,
          amountStr: '',
        },
      ]);

      getPrinterConfig()
        .then((cfg) => {
          if (cfg?.paperWidth === 58 || cfg?.paperWidth === 80) {
            setReceiptPaperWidth(cfg.paperWidth);
          }
        })
        .catch(() => {});

      const preferred = normalizeInitialDocType(initialDocType ?? invoiceIntent);
      let nextDoc: CheckoutDocType = 'nota_venta';

      if (cartCustomer) {
        setSelectedCustomer(cartCustomer);
        setCustomerName(cartCustomer.name || '');
        if (cartCustomer.ruc) {
          const cleanR = cartCustomer.ruc.trim().replace(/\D/g, '');
          if (cleanR.length === 11) skipNextLookupDocRef.current = cleanR;
          setCustomerRuc(cartCustomer.ruc);
          if (invoicingEnabled) nextDoc = 'factura';
        } else if (cartCustomer.dni) {
          const cleanD = cartCustomer.dni.trim().replace(/\D/g, '');
          if (cleanD.length === 8) skipNextLookupDocRef.current = cleanD;
          setCustomerDni(cartCustomer.dni);
          if (invoicingEnabled) nextDoc = 'boleta';
        }
        setCustomerAddress(cartCustomer.address || '');
        setCustomerPhone(cartCustomer.phone || '');
      } else {
        skipNextLookupDocRef.current = null;
        setSelectedCustomer(null);
        setCustomerDni('');
        setCustomerRuc('');
        setCustomerName('');
        setCustomerAddress('');
        setCustomerPhone('');
      }

      if (preferred) {
        nextDoc =
          !invoicingEnabled && (preferred === 'boleta' || preferred === 'factura')
            ? 'nota_venta'
            : preferred;
      }
      setDocType(nextDoc);
    } else if (!visible) {
      wasVisibleRef.current = false;
      setQrZoomVisible(false);
      lookupAbortRef.current?.abort();
      lookupAbortRef.current = null;
    }
  }, [visible, safeTotal, cartCustomer, invoicingEnabled, initialDocType, invoiceIntent, discountAmount, mixedSplitOptions]);

  const handleLookup = useCallback(async (type: 'dni' | 'ruc', number: string) => {
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;
    const reqId = ++lookupSeqRef.current;

    try {
      setIsSearchingDoc(true);
      setDocError(null);
      setDocSearchSuccess(null);

      const res: DocumentLookupResult = await lookupDocument(type, number, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || lookupSeqRef.current !== reqId) return;

      if (res && res.name) {
        setCustomerName(res.name);
        if (res.address) {
          setCustomerAddress(res.address);
        }
        setDocSearchSuccess(`${type.toUpperCase()} verificado: ${res.name}`);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        syncCustomerToCart({
          name: res.name,
          address: res.address || customerFormRef.current.address,
          dni: type === 'dni' ? number : customerFormRef.current.dni,
          ruc: type === 'ruc' ? number : customerFormRef.current.ruc,
        });
        if (
          invoicingEnabled &&
          !documentSelectionLockedRef.current &&
          docType !== 'cotizacion'
        ) {
          if (type === 'ruc') setDocType('factura');
          else if (type === 'dni') setDocType('boleta');
        }
      }
    } catch (err: any) {
      if (err?.code === 'ABORTED' || controller.signal.aborted || lookupSeqRef.current !== reqId) {
        return;
      }
      setDocError(err?.message || `No se encontró información para este ${type.toUpperCase()}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      if (lookupSeqRef.current === reqId) {
        setIsSearchingDoc(false);
      }
    }
  }, [invoicingEnabled, docType, syncCustomerToCart]);

  // Consulta automática de DNI con debounce (>= 450ms) y cancelación de obsoletas
  useEffect(() => {
    if (!visible) return;
    const cleanDni = customerDni.trim().replace(/\D/g, '');
    if (cleanDni.length !== 8 || !isValidDNI(cleanDni)) return;
    if (skipNextLookupDocRef.current === cleanDni) {
      skipNextLookupDocRef.current = null;
      return;
    }
    const timer = setTimeout(() => {
      void handleLookup('dni', cleanDni);
    }, 500);
    return () => {
      clearTimeout(timer);
      lookupAbortRef.current?.abort();
    };
  }, [visible, customerDni, handleLookup]);

  // Consulta automática de RUC con debounce (>= 450ms) y cancelación de obsoletas
  useEffect(() => {
    if (!visible) return;
    const cleanRuc = customerRuc.trim().replace(/\D/g, '');
    if (cleanRuc.length !== 11 || !isValidRUC(cleanRuc)) return;
    if (skipNextLookupDocRef.current === cleanRuc) {
      skipNextLookupDocRef.current = null;
      return;
    }
    const timer = setTimeout(() => {
      void handleLookup('ruc', cleanRuc);
    }, 500);
    return () => {
      clearTimeout(timer);
      lookupAbortRef.current?.abort();
    };
  }, [visible, customerRuc, handleLookup]);

  const handleSelectExistingCustomer = (c: Customer) => {
    setSelectedCustomer(c);
    setCustomerName(c.name || '');
    if (c.ruc) {
      const cleanR = c.ruc.trim().replace(/\D/g, '');
      if (cleanR.length === 11) skipNextLookupDocRef.current = cleanR;
      setCustomerRuc(c.ruc);
      if (invoicingEnabled && !documentSelectionLockedRef.current && docType !== 'cotizacion') {
        setDocType('factura');
      }
    } else if (c.dni) {
      const cleanD = c.dni.trim().replace(/\D/g, '');
      if (cleanD.length === 8) skipNextLookupDocRef.current = cleanD;
      setCustomerDni(c.dni);
      if (invoicingEnabled && !documentSelectionLockedRef.current && docType !== 'cotizacion') {
        setDocType('boleta');
      }
    }
    setCustomerAddress(c.address || '');
    setCustomerPhone(c.phone || '');
    setShowCustomerPicker(false);
    setDocSearchSuccess(`Cliente: ${c.name}`);
    setCartCustomer(c);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Balance en Pago Mixto (N medios dinámicos)
  const mixedSplitsParsed = useMemo<CheckoutPaymentSplitInput[]>(
    () =>
      mixedSplits.map((row) => ({
        ...(row.methodId ? { methodId: row.methodId } : {}),
        category: row.category,
        amount: parseFloat(String(row.amountStr || '').replace(',', '.')) || 0,
        ...(row.category === 'digital' && row.digitalProvider
          ? { digitalProvider: row.digitalProvider }
          : {}),
      })),
    [mixedSplits]
  );

  const mixedAllocation = useMemo(() => {
    const assigned = mixedSplitsParsed.reduce((sum, s) => sum + s.amount, 0);
    const pending = safeTotal - assigned;
    return {
      assigned,
      pending,
      isExact: Math.abs(pending) < 0.01 && assigned > 0,
    };
  }, [mixedSplitsParsed, safeTotal]);

  const paymentPreview = useMemo(() => {
    try {
      const nonZeroSplits = mixedSplitsParsed.filter((s) => s.amount > 0);
      const resolution = resolveCheckoutPayment({
        methods: configuredMethods,
        selectedMethodId,
        category: paymentCategory,
        total: safeTotal,
        ...(paymentCategory === 'mixed'
          ? {
              splits: nonZeroSplits.length
                ? nonZeroSplits
                : [{ category: 'cash' as const, amount: 0 }],
            }
          : {}),
      });
      return { resolution, error: '' };
    } catch (error) {
      return {
        resolution: null,
        error: error instanceof Error ? error.message : 'Selecciona un medio de pago válido.',
      };
    }
  }, [configuredMethods, selectedMethodId, paymentCategory, safeTotal, mixedSplitsParsed]);
  const amountToCollect = paymentPreview.resolution?.chargedAmount ?? safeTotal;

  // Cálculo de Vuelto en Efectivo
  const cashChange = useMemo(() => {
    if (paymentCategory !== 'cash') return 0;
    return Math.max(0, cashReceived - amountToCollect);
  }, [cashReceived, amountToCollect, paymentCategory]);

  const cashShortage = useMemo(() => {
    if (paymentCategory !== 'cash') return 0;
    return Math.max(0, amountToCollect - cashReceived);
  }, [cashReceived, amountToCollect, paymentCategory]);

  // Validación de Crédito / Fiado
  const fiadoValidation = useMemo(() => {
    if (paymentCategory !== 'fiado') return { isValid: true, reason: '' };
    if (!selectedCustomer) {
      return { isValid: false, reason: 'Debes seleccionar un cliente del directorio para venta al crédito.' };
    }
    const currentDebt = selectedCustomer.currentDebt || 0;
    const limit = selectedCustomer.maxCreditLimit || 0;
    if (limit > 0 && currentDebt + safeTotal > limit) {
      const available = Math.max(0, limit - currentDebt);
      return {
        isValid: false,
        reason: `Excede el límite de crédito permitido. Disponible: ${formatPEN(available)} (Deuda actual: ${formatPEN(currentDebt)}, Límite: ${formatPEN(limit)})`,
      };
    }
    return { isValid: true, reason: '' };
  }, [paymentCategory, selectedCustomer, safeTotal]);

  const prepaidCreditsValidation = useMemo(() => {
    if (paymentCategory !== 'credits') return { isValid: true, reason: '' };
    if (!selectedCustomer) {
      return { isValid: false, reason: 'Selecciona un cliente con saldo prepagado.' };
    }
    const available = Number(selectedCustomer.credits || 0);
    if (available < safeTotal) {
      return { isValid: false, reason: `Saldo insuficiente. Disponible: ${formatPEN(available)}.` };
    }
    return { isValid: true, reason: '' };
  }, [paymentCategory, selectedCustomer, safeTotal]);

  // Validación General para Confirmar Venta
  const canConfirmSale = useMemo(() => {
    if (safeTotal <= 0) return false;
    if (items.length === 0) return false;

    // Cotización solo requiere total > 0 e items > 0 (sin pago obligatorio ni SUNAT estricto)
    if (docType === 'cotizacion') {
      return true;
    }

    if (!configurationReady || paymentPreview.error) return false;

    // Validación Factura SUNAT
    if (docType === 'factura') {
      const cleanRuc = customerRuc.trim().replace(/\D/g, '');
      if (cleanRuc.length !== 11 || !isValidRUC(cleanRuc)) return false;
      if (!customerName.trim()) return false;
    }

    if (sellerSelectionRequired && !selectedSeller) return false;

    // Validación Efectivo
    if (paymentCategory === 'cash') {
      if (cashReceived < amountToCollect) return false;
    }

    // Validación Pago Mixto
    if (paymentCategory === 'mixed') {
      if (!mixedAllocation.isExact) return false;
    }

    // Validación Fiado
    if (paymentCategory === 'fiado') {
      if (!fiadoValidation.isValid) return false;
    }
    if (paymentCategory === 'credits' && !prepaidCreditsValidation.isValid) return false;

    return true;
  }, [safeTotal, configurationReady, amountToCollect, paymentPreview.error, items, docType, customerRuc, customerName, paymentCategory, cashReceived, mixedAllocation, fiadoValidation, prepaidCreditsValidation, sellerSelectionRequired, selectedSeller]);

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
        resolvedBranch?.address ||
        activeBranchName ||
        '',
      phone:
        resolvedBranch?.phone ||
        (businessSettings as any)?.commercialPhone ||
        businessSettings?.phone ||
        '',
      consultUrl:
        (businessSettings as any)?.consultUrl ||
        (businessData as any)?.consultUrl ||
        'https://ventify.com.pe/comprobantes',
    }),
    [businessData, businessSettings, emitterInfo, resolvedBranch, activeBranchName]
  );

  // Envío Transaccional de Venta
  const handleConfirmSale = async () => {
    if (!canConfirmSale || !accountId) return;

    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      checkoutOperationId.current ||= `mobile_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const saleToken = checkoutOperationId.current;
      activeSaleTokenRef.current = saleToken;

      const isOnline = settingsIsOnline;
      const cartItemsSnapshot = items.map((i) => ({ ...i }));
      const saleTimestamp = Date.now();
      const cleanRuc = customerRuc.trim().replace(/\D/g, '');
      const cleanDni = customerDni.trim().replace(/\D/g, '');
      const resolvedCustomerName = customerName.trim() || 'Cliente Varios';
      const resolvedReceiptFooter =
        posSettings?.ticketFooterMessage || businessSettings?.receiptFooter || '¡Gracias por su compra!';

      // Si el comprobante elegido es Cotización, generar cotización sin cobrar ni restar inventario
      if (docType === 'cotizacion') {
        if (!isOnline) {
          throw new Error('Conéctate a internet para emitir y guardar una cotización.');
        }
        const quoteItems = cleanFirestoreData(
          items.map((i) => {
            const resolvedId = (i as any).productId || (i as any).product?.id || (i.id.includes('_') ? i.id.split('_')[0] : i.id);
            const { product, ...cleanI } = i as any;
            return {
              id: resolvedId,
              productId: resolvedId,
              name: cleanI.name,
              quantity: cleanI.quantity,
              price: cleanI.price,
              total: cleanI.lineTotal !== undefined ? cleanI.lineTotal : cleanI.price * cleanI.quantity,
              sku: cleanI.sku || '',
              unitOfMeasure: cleanI.unitOfMeasure || 'NIU',
              variantId: cleanI.variantId || cleanI.variant?.id,
              variantName: cleanI.variantName || cleanI.variant?.name,
              presentationId: cleanI.presentationId || cleanI.presentation?.id,
              presentationName: cleanI.presentationName || cleanI.presentation?.name,
              presentationQty: cleanI.presentationQty || cleanI.conversionFactor || presentationFactor(cleanI.presentation),
              conversionFactor: cleanI.conversionFactor || cleanI.presentationQty || presentationFactor(cleanI.presentation),
              originalPrice: cleanI.originalPrice,
              isGift: Boolean(cleanI.isGift),
            };
          })
        );
        const quoteSubtotal = Math.round(
          items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100
        ) / 100;

        const newQuote = await createQuote({
          accountId,
          branchId: branchId || 'main',
          branchName: activeBranchName || '',
          items: quoteItems,
          subtotal: quoteSubtotal,
          discountAmount,
          tax: 0,
          total: safeTotal,
          shippingAmount,
          customerId: selectedCustomer?.id,
          customerName: customerName.trim() || 'Cliente General',
          customerPhone: customerPhone.trim() || undefined,
          customerDni: cleanDni || undefined,
          customerRuc: cleanRuc || undefined,
          customerAddress: customerAddress.trim() || undefined,
          notes: notes.trim() || undefined,
          validityDays: 15,
          source: 'mobile',
          createdBy: user?.uid,
          createdByName: userProfile?.displayName || user?.displayName || 'Cajero POS',
        });

        const quoteNumber = newQuote.quoteNumber || parseInt(newQuote.id.slice(-5), 10) || 1001;
        const formattedNumber = newQuote.formattedNumber || `COT-${String(quoteNumber).padStart(5, '0')}`;

        const quoteSnapshot: any = {
          id: newQuote.id,
          saleNumber: quoteNumber,
          documentNumber: formattedNumber,
          correlative: formattedNumber,
          documentType: 'cotizacion',
          isQuote: true,
          date: saleTimestamp,
          items: cartItemsSnapshot,
          subtotal: quoteSubtotal,
          discountAmount,
          shippingAmount,
          tax: 0,
          total: safeTotal,
          paymentMethod: 'COTIZACIÓN',
          customerName: customerName.trim() || 'Cliente General',
          customerDni: cleanDni || undefined,
          customerRuc: cleanRuc || undefined,
          customerAddress: customerAddress.trim() || undefined,
          customerPhone: customerPhone.trim() || undefined,
          userName: userProfile?.displayName || user?.displayName || 'Cajero POS',
          amountInWords: numberToSpanishWordsPEN(safeTotal),
          sunatStatus: 'not_applicable',
          consultUrl: receiptBusiness.consultUrl,
          footerNote: resolvedReceiptFooter,
        };

        const quoteResult = {
          saleId: newQuote.id,
          saleNumber: quoteNumber,
          correlative: formattedNumber,
          documentType: 'cotizacion',
          total: safeTotal,
          status: 'pending',
          sunatStatus: 'not_applicable',
          saleSnapshot: quoteSnapshot,
        };

        setSaleResult(quoteResult);
        checkoutOperationId.current = null;
        setIsSuccessView(true);
        clearCart();
        setCartCustomer(null);
        setInvoiceIntent(null);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        if (onSaleSuccess) {
          onSaleSuccess(quoteResult);
        }
        return;
      }

      // Mapear items
      const saleItems = cleanFirestoreData(
        items.map((i) => {
          const resolvedId = (i as any).productId || (i as any).product?.id || (i.id.includes('_') ? i.id.split('_')[0] : i.id);
          const { product, ...cleanI } = i as any;
          return {
            productId: resolvedId,
            name: cleanI.name,
            quantity: cleanI.quantity,
            price: cleanI.price,
            costPrice: cleanI.costPrice || 0,
            total: cleanI.lineTotal !== undefined ? cleanI.lineTotal : cleanI.price * cleanI.quantity,
            sku: cleanI.sku || '',
            unitOfMeasure: cleanI.unitOfMeasure || 'NIU',
            presentation: cleanI.presentation || null,
            variant: cleanI.variant || null,
            variantId: cleanI.variantId || cleanI.variant?.id,
            variantName: cleanI.variantName || cleanI.variant?.name,
            presentationId: cleanI.presentationId,
            presentationName: cleanI.presentationName,
            presentationQty: cleanI.presentationQty || cleanI.conversionFactor || presentationFactor(cleanI.presentation),
            conversionFactor: cleanI.conversionFactor || cleanI.presentationQty || presentationFactor(cleanI.presentation),
            stockBranchId: cleanI.stockBranchId || branchId || 'main',
            isGift: Boolean(cleanI.isGift),
            originalPrice: cleanI.originalPrice,
            priceModificationReason: cleanI.priceModificationReason,
            isWeightBased: cleanI.isWeightBased || false,
          };
        })
      );

      const payment = paymentPreview.resolution;
      if (!payment) throw new Error(paymentPreview.error || 'Selecciona un medio de pago.');
      const method = configuredMethods.find((entry: any) => entry.id === payment.paymentMethodId);
      if (!method) throw new Error('El método de pago ya no está habilitado.');
      const mappedMethod = paymentCategory === 'fiado' ? 'credit'
        : paymentCategory === 'credits' ? 'creditos'
        : paymentCategory === 'mixed' ? 'mixed' : method.reportCategory;
      const paymentsList: SalePaymentSplit[] = payment.payments.length ? payment.payments : [{
        methodId: payment.paymentMethodId, methodName: payment.paymentMethodName,
        category: method.reportCategory, amount: safeTotal, chargedAmount: payment.chargedAmount,
        commissionAmount: payment.commissionAmount, surchargeAmount: payment.surchargeAmount,
        ...(paymentCategory === 'yape' || paymentCategory === 'plin' ? { digitalProvider: paymentCategory } : {}),
        reference: operationReference.trim() || undefined,
      }];

      const isServerAttributed = sellerAttributionEnabled || Boolean(saleRequestId || sourceQuoteId);
      const itemsGrossSubtotal = Math.round(
        items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0), 0) * 100
      ) / 100;
      const itemsNetSubtotal = Math.max(0, safeTotal - shippingAmount);
      const breakdown = computeSaleTaxBreakdown(itemsNetSubtotal, docType, taxProfile);
      const payloadSubtotal = isServerAttributed ? itemsGrossSubtotal : breakdown.subtotal;
      const payloadTax = isServerAttributed ? 0 : breakdown.tax;
      let latestSunatRes: any = null;

      const boletaUsesRuc = docType === 'boleta' && cleanRuc.length === 11 && !cleanDni;
      const salePayload: CreateSaleTransactionParams = {
        accountId,
        branchId: branchId || 'main',
        userId: user?.uid || 'user_mobile',
        userName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero POS',
        userRole: userProfile?.role || undefined,
        items: saleItems,
        paymentMethod: mappedMethod,
        paymentMethodId: payment.paymentMethodId,
        paymentMethodName: payment.paymentMethodName,
        ...(paymentCategory === 'yape' || paymentCategory === 'plin'
          ? { digitalProvider: paymentCategory }
          : {}),
        commissionPercent: payment.payments.length <= 1 ? method.commissionPercent : undefined,
        commissionRule: payment.payments.length <= 1 ? method.commissionRule : undefined,
        chargedAmount: payment.chargedAmount,
        commissionAmount: payment.commissionAmount,
        surchargeAmount: payment.surchargeAmount,
        netAmount: payment.netAmount,
        creditDays: paymentCategory === 'fiado' ? Math.max(1, parseInt(creditDays, 10) || 30) : undefined,
        documentType: docType as SaleDocumentType,
        subtotal: payloadSubtotal,
        tax: payloadTax,
        taxExemptionCode: breakdown.taxExemptionCode,
        isAmazonExempt: breakdown.isAmazonExempt,
        total: safeTotal,
        shippingAmount,
        discountAmount,
        payments: cleanFirestoreData(paymentsList),
        cashReceived: paymentCategory === 'cash' ? cashReceived : undefined,
        changeGiven: paymentCategory === 'cash' ? cashChange : undefined,
        customer: {
          id: selectedCustomer?.id,
          name: resolvedCustomerName,
          documentNumber:
            docType === 'factura' || boletaUsesRuc
              ? cleanRuc
              : cleanDni || undefined,
          documentType:
            docType === 'factura' || boletaUsesRuc
              ? 'RUC'
              : cleanDni
                ? 'DNI'
                : undefined,
          dni: cleanDni || undefined,
          ruc: cleanRuc || undefined,
          email: selectedCustomer?.email || undefined,
          address: customerAddress.trim() || undefined,
          phone: customerPhone.trim() || undefined,
        },
        customerId: selectedCustomer?.id,
        customerName: resolvedCustomerName,
        sessionId: activeCashSession?.sessionId || activeCashSession?.id,
        saleDate: saleTimestamp,
        offlineId: saleToken,
        skipOfflineDedup: isOnline,
        enableSellerAttribution: sellerAttributionEnabled,
        sourceSaleRequestId: saleRequestId || undefined,
        sourceQuoteId: sourceQuoteId || undefined,
        ...(sellerAttributionEnabled && selectedSeller
          ? { sellerId: selectedSeller.id, sellerName: selectedSeller.name }
          : {}),
        notes: notes.trim() || (paymentCategory === 'fiado' ? `Vencimiento: ${creditDays} días` : undefined),
        isQuote: false,
        onSunatResult: (sunatRes) => {
          const settledRes = sunatRes ?? {
            success: false,
            status: 'error',
            error: 'No se recibió respuesta del servicio SUNAT.',
          };
          latestSunatRes = settledRes;
          if (activeSaleTokenRef.current !== saleToken) return;
          setSaleResult((prev: any) => {
            if (!prev) return prev;
            const nextStatus = settledRes.status || (settledRes.success ? 'accepted' : 'error');
            const nextDocNumber = settledRes.documentNumber || prev.documentNumber || prev.correlative;
            const nextHash = settledRes.sunatHash ?? settledRes.einvoice?.hash ?? prev.sunatHash;
            const nextCdr = settledRes.cdrDescription ?? settledRes.error ?? prev.cdrDescription;
            const nextQr = settledRes.einvoice?.qrContent ?? prev.qrContent;
            const nextFiscal = settledRes.fiscalAmounts ?? prev.fiscalAmounts;
            const nextCustomer = settledRes.receiptCustomer ?? prev.receiptCustomer;

            return {
              ...prev,
              documentNumber: nextDocNumber,
              correlative: nextDocNumber,
              sunatStatus: nextStatus,
              cdrDescription: nextCdr,
              sunatHash: nextHash,
              qrContent: nextQr,
              fiscalAmounts: nextFiscal,
              receiptCustomer: nextCustomer,
              saleSnapshot: prev.saleSnapshot
                ? {
                    ...prev.saleSnapshot,
                    documentNumber: nextDocNumber,
                    correlative: nextDocNumber,
                    sunatStatus: nextStatus,
                    cdrDescription: nextCdr,
                    sunatHash: nextHash,
                    qrContent: nextQr,
                    fiscalAmounts: nextFiscal ?? prev.saleSnapshot.fiscalAmounts,
                    receiptCustomer: nextCustomer ?? prev.saleSnapshot.receiptCustomer,
                  }
                : prev.saleSnapshot,
            };
          });
        },
      };

      let result: any;
      if (isOnline) {
        result = await createSaleTransaction(salePayload);
      } else {
        if (saleRequestId || sourceQuoteId) {
          throw new Error('Conéctate a internet para confirmar la conversión de forma segura.');
        }
        const queuedItem = await enqueueOfflineSale(salePayload);
        void refreshOfflineCount();
        const offId = typeof queuedItem === 'string' ? queuedItem : queuedItem.offlineId;
        result = {
          saleId: offId,
          saleNumber: Math.floor(100000 + Math.random() * 900000),
          correlative: `OFF-${offId.slice(-6).toUpperCase()}`,
          documentType: docType,
          total: safeTotal,
          status: 'pending_offline',
          sunatStatus: 'pending',
          isOffline: true,
        };
      }

      const finalDocNumber =
        latestSunatRes?.documentNumber ||
        result.documentNumber ||
        result.correlative ||
        `#${result.saleNumber || '0001'}`;
      const resolvedSunatStatus = !isOnline
        ? 'pending'
        : latestSunatRes?.status ||
          result.sunatStatus ||
          (docType === 'boleta' || docType === 'factura' ? 'pending' : 'not_applicable');

      const saleSnapshot: any = {
        id: result.saleId || saleToken,
        saleNumber: result.saleNumber || 1001,
        documentNumber: finalDocNumber,
        correlative: finalDocNumber,
        documentType: docType,
        date: saleTimestamp,
        items: cartItemsSnapshot,
        subtotal: payloadSubtotal,
        tax: payloadTax,
        taxExemptionCode: breakdown.taxExemptionCode,
        isAmazonExempt: breakdown.isAmazonExempt,
        discountAmount,
        shippingAmount,
        total: safeTotal,
        chargedAmount: payment.chargedAmount,
        surchargeAmount: payment.surchargeAmount,
        paymentMethod: mappedMethod,
        paymentMethodName: payment.paymentMethodName || method.name || paymentCategory.toUpperCase(),
        payments: cleanFirestoreData(paymentsList),
        cashReceived: paymentCategory === 'cash' ? cashReceived : undefined,
        changeGiven: paymentCategory === 'cash' ? cashChange : undefined,
        customerName: customerName.trim() || 'CLIENTE VARIOS',
        customerRuc: cleanRuc || undefined,
        customerDni: cleanDni || undefined,
        customerAddress: customerAddress.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        userName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero POS',
        sellerName: sellerAttributionEnabled && selectedSeller ? selectedSeller.name : undefined,
        amountInWords: numberToSpanishWordsPEN(safeTotal),
        isOfflinePending: Boolean(result.isOffline),
        sunatStatus: resolvedSunatStatus,
        cdrDescription: latestSunatRes?.cdrDescription ?? result.cdrDescription ?? null,
        sunatHash: latestSunatRes?.sunatHash ?? latestSunatRes?.einvoice?.hash ?? result.sunatHash ?? null,
        qrContent: latestSunatRes?.einvoice?.qrContent ?? undefined,
        fiscalAmounts: latestSunatRes?.fiscalAmounts ?? result.fiscalAmounts,
        receiptCustomer: latestSunatRes?.receiptCustomer ?? result.receiptCustomer,
        consultUrl: receiptBusiness.consultUrl,
        footerNote: resolvedReceiptFooter,
      };

      const fullResult = {
        ...result,
        documentNumber: finalDocNumber,
        correlative: finalDocNumber,
        sunatStatus: resolvedSunatStatus,
        saleSnapshot,
      };

      setSaleResult(fullResult);
      checkoutOperationId.current = null;
      setIsSuccessView(true);
      clearCart();
      setCartCustomer(null);
      setInvoiceIntent(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (onSaleSuccess) {
        onSaleSuccess(fullResult);
      }
    } catch (err: any) {
      console.error('[CheckoutModal] Error procesando venta:', err);
      Alert.alert('Error al Cobrar', err?.message || 'Ocurrió un error inesperado al procesar la venta.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 1. Imprimir Ticket Térmico con Bluetooth / AirPrint / Android Print
  const handlePrintTicket = async () => {
    const saleObj = saleResult?.saleSnapshot || saleResult;
    if (!saleObj) return;
    try {
      setTicketPrinting(true);
      const cfg = await getPrinterConfig();
      const resolvedFooter =
        posSettings?.ticketFooterMessage || businessSettings?.receiptFooter || '¡Gracias por su compra!';
      const printOptions = {
        paperWidth: receiptPaperWidth,
        autoCut: cfg.autoCut !== false,
        openDrawer: Boolean(cfg.openCashDrawer),
        branch: resolvedBranch,
        taxProfile,
        consultUrl: receiptBusiness.consultUrl,
        receiptFooter: resolvedFooter,
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

  // 2. Compartir Ticket PDF / WhatsApp
  const handleShareWhatsApp = async () => {
    const saleObj = saleResult?.saleSnapshot || saleResult;
    if (!saleObj) return;
    const resolvedFooter =
      posSettings?.ticketFooterMessage || businessSettings?.receiptFooter || '¡Gracias por su compra!';
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
            receiptFooter: resolvedFooter,
          },
        },
        receiptBusiness,
        {
          phone: saleObj.customerPhone || '',
          paperWidth: receiptPaperWidth,
          branch: resolvedBranch,
          taxProfile,
          consultUrl: receiptBusiness.consultUrl,
          receiptFooter: resolvedFooter,
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

        const correlative = saleObj.documentNumber || saleObj.correlative || `#${saleObj.saleNumber || ''}`;
        const itemsList: any[] = Array.isArray(saleObj.items) ? saleObj.items : [];
        const itemsText = itemsList
          .map((i) => `• ${i.quantity}x ${i.name} - ${formatPEN(i.lineTotal !== undefined ? i.lineTotal : i.price * i.quantity)}`)
          .join('\n');

        const message =
          `*${receiptBusiness.businessName || 'VENTIFY'}*\n` +
          `🧾 *${docLabel}*: ${correlative}\n` +
          `📅 *Fecha*: ${formatDatePE(saleObj.date || Date.now())}\n` +
          (saleObj.customerName ? `👤 *Cliente*: ${saleObj.customerName}\n` : '') +
          (saleObj.customerRuc ? `🏢 *RUC*: ${saleObj.customerRuc}\n` : '') +
          (saleObj.customerDni ? `🆔 *DNI*: ${saleObj.customerDni}\n` : '') +
          `\n*DETALLE DE COMPRA:*\n${itemsText}\n\n` +
          `💰 *TOTAL: ${formatPEN(saleObj.total || 0)}*\n` +
          `💳 *Método de Pago*: ${String(saleObj.paymentMethodName || saleObj.paymentMethod || '').toUpperCase()}\n` +
          (saleObj.changeGiven > 0 ? `💵 *Vuelto*: ${formatPEN(saleObj.changeGiven)}\n` : '') +
          `\n_¡Muchas gracias por su preferencia!_`;

        const cleanPhone = String(saleObj.customerPhone || '').replace(/\D/g, '');
        const whatsappUrl = cleanPhone
          ? `whatsapp://send?phone=${cleanPhone.startsWith('51') ? cleanPhone : '51' + cleanPhone}&text=${encodeURIComponent(message)}`
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

  // 3. Iniciar Nueva Venta
  const handleNewSale = () => {
    activeSaleTokenRef.current = null;
    clearCart();
    setCartCustomer(null);
    setInvoiceIntent(null);
    setIsSuccessView(false);
    setSaleResult(null);
    onClose();
  };

  const handleClose = useCallback(() => {
    if (!isSuccessView) {
      syncCustomerToCart();
    }
    onClose();
  }, [isSuccessView, syncCustomerToCart, onClose]);

  if (!visible) return null;

  const renderPaymentQrCard = (includeHeader: boolean) => {
    if (!selectedMethodQrUrl) return null;
    return (
      <View style={styles.paymentQrCard}>
        {includeHeader ? (
          <View style={styles.paymentQrHeader}>
            <Text style={styles.digitalInfoTitle}>
              {`QR ${selectedMethodConfig?.name || ''}`.trim()}
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
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.compactCheckoutHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={styles.compactCheckoutTitle}>
              {isSuccessView ? 'Comprobante emitido' : 'Finalizar cobro'}
            </Text>
            <View style={styles.itemsCountBadge}>
              <Text style={styles.itemsCountBadgeText}>
                {items.length} {items.length === 1 ? 'ítem' : 'ítems'}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.compactCloseBtn}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cerrar cobro"
          >
            <X size={18} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {isSuccessView ? (
          /* ========================================================================= */
          /* PANTALLA DE VENTA EXITOSA POST-PROCESAMIENTO                               */
          /* ========================================================================= */
          <ScrollView
            contentContainerStyle={styles.successContainer}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
            {(() => {
              const saleObj = saleResult?.saleSnapshot || saleResult;
              const liveSunatStatus = saleObj?.sunatStatus || saleResult?.sunatStatus;
              const liveCdr = saleObj?.cdrDescription || saleResult?.cdrDescription;
              const isQuoteResult = docType === 'cotizacion' || saleObj?.documentType === 'cotizacion';
              const isOfflineSale = Boolean(saleResult?.isOffline || saleObj?.isOfflinePending);
              const isElectronic =
                !isQuoteResult && (saleObj?.documentType === 'boleta' || saleObj?.documentType === 'factura');

              return (
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
                      {([80, 58] as const).map((width) => {
                        const active = receiptPaperWidth === width;
                        return (
                          <TouchableOpacity
                            key={width}
                            style={[styles.paperWidthChip, active && styles.paperWidthChipActive]}
                            onPress={() => setReceiptPaperWidth(width)}
                          >
                            <Text style={[styles.paperWidthChipText, active && styles.paperWidthChipTextActive]}>
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
                        receiptFooter={
                          posSettings?.ticketFooterMessage ||
                          businessSettings?.receiptFooter ||
                          '¡Gracias por su compra!'
                        }
                        paperWidth={receiptPaperWidth}
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
                      onPress={handleNewSale}
                      activeOpacity={0.8}
                    >
                      <RefreshCw size={20} color={ui.text} />
                      <Text style={styles.postActionNewText}>Iniciar Nueva Venta</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })()}
          </ScrollView>
        ) : (
          /* ========================================================================= */
          /* FORMULARIO DE CHECKOUT Y PAGO                                              */
          /* ========================================================================= */
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollInner}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
            {/* Total a cobrar compacto + Descuento global manual */}
            <View style={styles.checkoutTotalCardCompact}>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkoutTotalLabelCompact}>Total a cobrar</Text>
                <Text style={styles.checkoutTotalItemsCompact}>
                  {items.length} {items.length === 1 ? 'producto' : 'productos'}
                  {discountAmount > 0 ? ` · Desc: -${formatPEN(discountAmount)}` : ''}
                </Text>
                {shippingAmount > 0 && <Text style={styles.checkoutTotalItemsCompact}>Envío: {formatPEN(shippingAmount)}</Text>}
                {!sourceQuoteId && !saleRequestId ? (
                  <TouchableOpacity
                    style={styles.discountTogglePill}
                    onPress={() => {
                      setDiscountInputStr(discountAmount > 0 ? String(discountAmount) : '');
                      setShowDiscountEditor((prev) => !prev);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={discountAmount > 0 ? 'Editar descuento global' : 'Agregar descuento global'}
                  >
                    <Tag size={12} color={ui.primary} />
                    <Text style={styles.discountToggleText}>
                      {discountAmount > 0 ? 'Editar descuento' : '+ Descuento'}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={styles.checkoutTotalValueCompact}>{formatPEN(docType === 'cotizacion' ? safeTotal : amountToCollect)}</Text>
            </View>

            {showDiscountEditor ? (
              <View style={styles.discountEditorCard}>
                <Text style={styles.inputLabelCompact}>
                  Descuento Global (S/) — Máx. {formatPEN(cartSubtotal)}
                </Text>
                <View style={styles.discountEditorRow}>
                  <TextInput
                    style={[styles.inputCompact, { flex: 1 }]}
                    value={discountInputStr}
                    onChangeText={setDiscountInputStr}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                    placeholderTextColor={ui.textMuted}
                    accessibilityLabel="Monto de descuento global en soles"
                  />
                  <TouchableOpacity
                    style={styles.discountApplyBtn}
                    onPress={() => {
                      const parsed = parseFloat(discountInputStr.replace(',', '.')) || 0;
                      const clamped = Math.min(cartSubtotal, Math.max(0, Math.round(parsed * 100) / 100));
                      setDiscount(clamped);
                      const nextTotal = Math.max(0, Math.round((cartSubtotal - clamped + shippingAmount) * 100) / 100);
                      setCashReceived(nextTotal);
                      setShowDiscountEditor(false);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Aplicar descuento global"
                  >
                    <Text style={styles.discountApplyBtnText}>Aplicar</Text>
                  </TouchableOpacity>
                  {discountAmount > 0 ? (
                    <TouchableOpacity
                      style={[styles.quickBillChip, styles.quickBillChipClear, { minHeight: 42, justifyContent: 'center' }]}
                      onPress={() => {
                        setDiscount(0);
                        setDiscountInputStr('');
                        const nextTotal = Math.max(0, Math.round((cartSubtotal + shippingAmount) * 100) / 100);
                        setCashReceived(nextTotal);
                        setShowDiscountEditor(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Quitar descuento global"
                    >
                      <Text style={[styles.quickBillText, styles.quickBillTextClear]}>Quitar</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ) : null}

            {sellerAttributionEnabled ? (
              <View style={{ marginTop: 12, marginBottom: 4, padding: 12, borderRadius: 12, backgroundColor: ui.surface, borderWidth: 1, borderColor: sellerSelectionRequired && !selectedSeller ? ui.danger : ui.border }}>
                <Text style={styles.paymentSectionTitle}>Vendedor que atendió{sellerSelectionRequired ? ' *' : ''}</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Seleccionar vendedor que atendió"
                  onPress={() => setShowSellerOptions((open) => !open)}
                  style={{ minHeight: 42, justifyContent: 'center', marginTop: 6 }}
                >
                  <Text style={{ color: selectedSeller ? ui.text : ui.textSecondary }}>
                    {selectedSeller?.name || (sellerSelectionRequired ? 'Selecciona un vendedor' : 'Sin vendedor asignado')}
                  </Text>
                </TouchableOpacity>
                {showSellerOptions ? saleSellers.map((seller) => (
                  <TouchableOpacity
                    key={seller.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Vendedor ${seller.name}`}
                    onPress={() => { setSelectedSellerId(seller.id); setShowSellerOptions(false); }}
                    style={{ minHeight: 40, justifyContent: 'center', borderTopWidth: 1, borderTopColor: ui.border }}
                  >
                    <Text style={{ color: ui.text }}>{seller.name}</Text>
                  </TouchableOpacity>
                )) : null}
                {sellerLoadError ? <Text style={styles.fiadoErrorText}>{sellerLoadError}</Text> : null}
                {sellerSelectionRequired && !selectedSeller ? <Text style={styles.fiadoErrorText}>La configuración requiere un vendedor antes de cobrar.</Text> : null}
              </View>
            ) : null}

            {!configurationReady && <Text accessibilityRole="alert" style={{ color: configurationError ? ui.danger : ui.textSecondary, paddingVertical: 12 }}>{configurationError || 'Cargando medios de pago y comprobantes… Puedes consultar productos mientras termina.'}</Text>}
            {!!configurationError && <TouchableOpacity accessibilityRole="button" onPress={refreshConfiguration} style={{ paddingVertical: 12 }}><Text style={{ color: ui.primary }}>Reintentar configuración</Text></TouchableOpacity>}

            {/* 1. SELECTOR DE COMPROBANTE FISCAL COMPACTO */}
            <View style={styles.docTypeRowCompact}>
              {docTypeOptions.map((item) => {
                const isSelected = docType === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.docTypeChipCompact, isSelected && styles.docTypeChipCompactSelected]}
                    accessibilityRole="button"
                    accessibilityLabel={`Comprobante: ${item.label}`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => {
                      documentSelectionLockedRef.current = true;
                      setDocType(item.id as CheckoutDocType);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.docTypeChipTextCompact,
                        isSelected && styles.docTypeChipTextCompactSelected,
                      ]}
                    >
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 2. IDENTIFICACIÓN DEL CLIENTE (PRIORIZADA) */}
            <View style={styles.customerBoxCompact}>
              <View style={styles.customerBoxHeader}>
                <View style={styles.customerHeaderLeft}>
                  <User size={14} color={ui.text} />
                  <Text style={styles.customerBoxTitleCompact}>Datos del Cliente</Text>
                </View>
                <TouchableOpacity
                  style={styles.customerDirectoryBtn}
                  onPress={() => {
                    setShowCustomerPicker((prev) => {
                      if (prev) setCustomerSearchQuery('');
                      return !prev;
                    });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={showCustomerPicker ? 'Cerrar búsqueda de clientes' : 'Buscar cliente'}
                  accessibilityState={{ expanded: showCustomerPicker }}
                >
                  {showCustomerPicker ? (
                    <X size={12} color={ui.primary} />
                  ) : (
                    <Search size={12} color={ui.primary} />
                  )}
                  <Text style={styles.customerDirectoryBtnText}>
                    {showCustomerPicker ? 'Cerrar' : 'Buscar'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Selector de Cliente Existente (oculta el formulario manual mientras está abierto) */}
              {showCustomerPicker ? (
                <View style={styles.customerPickerDropdown}>
                  <View style={styles.customerSearchInputRow}>
                    <Search size={14} color={ui.textMuted} />
                    <TextInput
                      style={styles.customerSearchInput}
                      value={customerSearchQuery}
                      onChangeText={setCustomerSearchQuery}
                      placeholder="Buscar por nombre, DNI, RUC o teléfono..."
                      placeholderTextColor={ui.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    {customerSearchQuery.length > 0 ? (
                      <TouchableOpacity onPress={() => setCustomerSearchQuery('')} hitSlop={6}>
                        <X size={14} color={ui.textMuted} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <Text style={styles.pickerHeading}>
                    {customerSearchQuery.trim() ? 'Resultados:' : 'Clientes Frecuentes:'}
                  </Text>
                  {filteredPickerCustomers.length === 0 ? (
                    <Text style={styles.pickerEmptyText}>
                      {customersList.length === 0
                        ? 'No hay clientes guardados todavía.'
                        : 'No se encontraron clientes con esa búsqueda.'}
                    </Text>
                  ) : filteredPickerCustomers.map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.pickerItem}
                      onPress={() => {
                        setCustomerSearchQuery('');
                        handleSelectExistingCustomer(c);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Seleccionar cliente ${c.name}${c.ruc ? `, RUC ${c.ruc}` : c.dni ? `, DNI ${c.dni}` : ''}`}
                    >
                      <Text style={styles.pickerItemName}>{c.name}</Text>
                      <Text style={styles.pickerItemDoc}>
                        {c.ruc ? `RUC: ${c.ruc}` : c.dni ? `DNI: ${c.dni}` : 'Sin doc'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                /* Formulario Dinámico de Cliente según Tipo de Comprobante */
                <CheckoutCustomerInputs
                  docType={docType}
                  customerRuc={customerRuc}
                  setCustomerRuc={setCustomerRuc}
                  customerDni={customerDni}
                  setCustomerDni={setCustomerDni}
                  customerName={customerName}
                  setCustomerName={setCustomerName}
                  customerAddress={customerAddress}
                  setCustomerAddress={setCustomerAddress}
                  customerPhone={customerPhone}
                  setCustomerPhone={setCustomerPhone}
                  onBlurSync={handleBlurCustomerSync}
                  isSearchingDoc={isSearchingDoc}
                  safeTotal={safeTotal}
                  docSearchSuccess={docSearchSuccess}
                  docError={docError}
                />
              )}
            </View>

            {/* 3. MÉTODOS DE PAGO DEL DUEÑO O AVISO DE COTIZACIÓN */}
            {docType === 'cotizacion' ? (
              <View style={styles.quoteNoticeCard}>
                <View style={styles.quoteNoticeIconWrap}>
                  <FileText size={24} color={ui.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.quoteNoticeTitle}>Modo Cotización Activo</Text>
                  <Text style={styles.quoteNoticeSubtitle}>
                    Esta cotización formal quedará registrada por 15 días. No cobra ningún monto en caja ni descuenta inventario físico de la tienda.
                  </Text>
                </View>
              </View>
            ) : (
              <>
                <View style={styles.paymentSectionHeaderRow}>
                  <Text style={styles.paymentSectionTitle}>Método de Pago</Text>
                  <Text style={styles.paymentSectionSub}>Configurados por el negocio</Text>
                </View>
                {!!paymentPreview.error && <Text accessibilityRole="alert" style={{ color: ui.danger }}>{paymentPreview.error}</Text>}
                {(paymentPreview.resolution?.surchargeAmount || 0) > 0 && <Text style={{ color: ui.textSecondary }}>Recargo: {formatPEN(paymentPreview.resolution!.surchargeAmount)} · Total a cobrar: {formatPEN(amountToCollect)}</Text>}
                {paymentCategory === 'mixed' && paymentPreview.resolution?.payments.map((part, index) => (
                  <Text key={`${part.methodId}-${index}`} style={{ color: ui.textSecondary }}>
                    {part.methodName}: cobrar {formatPEN(part.chargedAmount ?? part.amount)}{(part.surchargeAmount || 0) > 0 ? ` (incluye ${formatPEN(part.surchargeAmount!)} de recargo)` : ''}
                  </Text>
                ))}
                <View style={styles.methodGridCompact}>
              {paymentOptions.map((m: any) => {
                const cat = resolveCategoryFromMethod(m);
                const isSelected = selectedMethodId === m.id || (paymentCategory === cat && !paymentOptions.some((x: any) => x.id === selectedMethodId));
                const logo = getMethodLogo(m);

                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.methodCardCompact, isSelected && styles.methodCardCompactSelected]}
                    accessibilityRole="button"
                    accessibilityLabel={`Método de pago: ${m.name}`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => {
                      setSelectedMethodId(m.id);
                      setPaymentCategory(cat);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    activeOpacity={0.7}
                  >
                    {logo ? (
                      <View style={styles.methodLogoWrapper}>
                        <Image
                          source={logo}
                          style={styles.methodLogoImg}
                          contentFit="contain"
                          cachePolicy="memory-disk"
                        />
                      </View>
                    ) : cat === 'cash' ? (
                      <Banknote size={18} color={isSelected ? ui.primary : ui.textSecondary} />
                    ) : cat === 'mixed' ? (
                      <Layers size={18} color={isSelected ? ui.primary : ui.textSecondary} />
                    ) : cat === 'fiado' ? (
                      <Clock size={18} color={isSelected ? ui.primary : ui.textSecondary} />
                    ) : (
                      <CreditCard size={18} color={isSelected ? ui.primary : ui.textSecondary} />
                    )}
                    <Text
                      style={[
                        styles.methodCardTextCompact,
                        isSelected && styles.methodCardTextCompactSelected,
                      ]}
                      numberOfLines={1}
                    >
                      {m.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* DETALLE SEGÚN MÉTODO DE PAGO */}
            {paymentCategory === 'cash' ? (
              <View style={styles.paymentDetailBox}>
                <Text style={styles.inputLabelCompact}>Monto Recibido</Text>
                <TextInput
                  style={[styles.inputCompact, styles.cashReceivedInput]}
                  accessibilityLabel="Monto recibido en soles"
                  value={String(cashReceived || '')}
                  onChangeText={(val) => setCashReceived(parseFloat(val.replace(',', '.')) || 0)}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  placeholderTextColor={ui.textMuted}
                />

                {/* Chips de billetes rápidos */}
                <View style={styles.quickBillsRow}>
                  <TouchableOpacity
                    style={[styles.quickBillChip, Math.abs(cashReceived - amountToCollect) < 0.01 && styles.quickBillChipActive]}
                    onPress={() => setCashReceived(amountToCollect)}
                    accessibilityRole="button"
                    accessibilityLabel={`Recibir monto exacto, ${formatPEN(amountToCollect)}`}
                  >
                    <Text style={[styles.quickBillText, Math.abs(cashReceived - amountToCollect) < 0.01 && styles.quickBillTextActive]}>
                      Exacto
                    </Text>
                  </TouchableOpacity>
                  {[20, 50, 100].map((bill) => (
                    <TouchableOpacity
                      key={bill}
                      style={[styles.quickBillChip, cashReceived === bill && styles.quickBillChipActive]}
                      onPress={() => setCashReceived(bill)}
                      accessibilityRole="button"
                      accessibilityLabel={`Recibir ${formatPEN(bill)}`}
                    >
                      <Text style={[styles.quickBillText, cashReceived === bill && styles.quickBillTextActive]}>
                        S/ {bill}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[styles.quickBillChip, styles.quickBillChipClear]}
                    onPress={() => setCashReceived(0)}
                    accessibilityRole="button"
                    accessibilityLabel="Limpiar monto recibido"
                  >
                    <Text style={[styles.quickBillText, styles.quickBillTextClear]}>Limpiar</Text>
                  </TouchableOpacity>
                </View>

                {/* Vuelto en tiempo real */}
                <View style={styles.changeDisplayRow}>
                  {cashShortage > 0 ? (
                    <View style={styles.shortageBadge}>
                      <AlertCircle size={18} color={ui.danger} />
                      <Text style={styles.shortageText}>
                        Faltan: {formatPEN(cashShortage)}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.changeBadge}>
                      <CheckCircle2 size={20} color={ui.primary} />
                      <View>
                        <Text style={styles.changeLabel}>Vuelto al Cliente:</Text>
                        <Text style={styles.changeAmountText}>{formatPEN(cashChange)}</Text>
                      </View>
                    </View>
                  )}
                </View>
              </View>
            ) : null}

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
                  onChangeText={setOperationReference}
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
                  accessibilityLabel={paymentCategory === 'card' ? 'Lote o referencia POS' : 'Número de operación bancaria'}
                  value={operationReference}
                  onChangeText={setOperationReference}
                  placeholder="Código o referencia"
                  placeholderTextColor={ui.textMuted}
                />
              </View>
            ) : null}

            {paymentCategory === 'mixed' ? (
              <CheckoutMixedPayments
                mixedSplits={mixedSplits}
                splitOptions={mixedSplitOptions}
                onChangeSplit={handleChangeMixedSplit}
                onAddSplit={handleAddMixedSplit}
                onRemoveSplit={handleRemoveMixedSplit}
                onFillRemaining={handleFillMixedRemaining}
                mixedAllocation={mixedAllocation}
                safeTotal={safeTotal}
              />
            ) : null}

            {paymentCategory === 'credits' ? (
              <View style={styles.paymentDetailBox}>
                <View style={styles.fiadoAlert}>
                  <CreditCard size={20} color={ui.warning} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fiadoTitle}>Créditos prepagados</Text>
                    <Text style={styles.fiadoSubtitle}>Se descontará del saldo que el cliente ya tiene cargado.</Text>
                  </View>
                </View>
                {selectedCustomer ? (
                  <Text style={styles.fiadoDataText}>Saldo disponible: <Text style={styles.boldText}>{formatPEN(selectedCustomer.credits || 0)}</Text></Text>
                ) : <Text style={styles.fiadoErrorText}>Selecciona un cliente con saldo prepagado.</Text>}
                {!prepaidCreditsValidation.isValid ? <Text style={styles.fiadoErrorText}>{prepaidCreditsValidation.reason}</Text> : null}
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
                  {['7', '15', '30', '45', '60'].map((d) => (
                    <TouchableOpacity
                      key={d}
                      style={[
                        styles.quickBillChip,
                        creditDays === d && styles.quickBillChipActive,
                      ]}
                      onPress={() => setCreditDays(d)}
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
              </>
            )}

            {/* NOTAS O COMENTARIOS */}
            <View style={styles.formGroup}>
              <Text style={styles.inputLabel}>Observaciones / Notas (Opcional)</Text>
              <TextInput
                style={styles.input}
                accessibilityLabel="Observaciones de la venta, opcional"
                value={notes}
                onChangeText={setNotes}
                placeholder="Ej. Entregar con bolsa, pedido especial..."
                placeholderTextColor={ui.textMuted}
              />
            </View>

            <View style={{ height: 40 }} />
          </ScrollView>
        )}

        {/* FOOTER DE CONFIRMACIÓN */}
        {!isSuccessView ? (
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <TouchableOpacity
              style={[
                styles.confirmBtn,
                !canConfirmSale && styles.confirmBtnDisabled,
                isSubmitting && styles.btnDisabled,
              ]}
              onPress={handleConfirmSale}
              disabled={!canConfirmSale || isSubmitting}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={isSubmitting ? 'Registrando venta' : `Confirmar venta por ${formatPEN(amountToCollect)}`}
              accessibilityState={{ disabled: !canConfirmSale || isSubmitting, busy: isSubmitting }}
            >
              {isSubmitting ? (
                <ActivityIndicator color={ui.onPrimary} size="small" />
              ) : (
                <>
                  <Text style={styles.confirmBtnText}>
                    {docType === 'cotizacion'
                      ? `GENERAR COTIZACIÓN ${formatPEN(safeTotal)}`
                      : `CONFIRMAR VENTA ${formatPEN(amountToCollect)}`}
                  </Text>
                  {docType === 'cotizacion' ? (
                    <FileText size={20} color={ui.onPrimary} />
                  ) : (
                    <ArrowRight size={20} color={ui.onPrimary} />
                  )}
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
      </KeyboardAvoidingView>
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
                  {selectedMethodConfig?.name || paymentCategory.toUpperCase()}
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
    </Modal>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  checkoutHeading: {
    paddingTop: Platform.OS === 'ios' ? 28 : 8,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  checkoutTotalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 18,
    marginBottom: 26,
    borderRadius: 16,
    backgroundColor: ui.primarySoft,
  },
  checkoutTotalLabel: {
    color: ui.text,
    fontSize: 15,
    fontWeight: '700',
  },
  checkoutTotalItems: {
    color: ui.textSecondary,
    fontSize: 13,
    marginTop: 3,
  },
  checkoutTotalValue: {
    color: ui.primary,
    fontSize: 24,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 48 : 20,
    paddingBottom: 14,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: ui.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: ui.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  headerTotalHighlight: {
    fontWeight: '800',
    color: ui.success,
  },
  closeBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
  },
  scrollContent: {
    flex: 1,
    minHeight: 0,
  },
  scrollInner: {
    padding: 20,
  },
  sectionHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 10,
  },
  docTypeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  docTypeChip: {
    flexBasis: '48%',
    flexGrow: 1,
    minHeight: 48,
    paddingVertical: 8,
    backgroundColor: ui.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
  },
  docTypeChipSelected: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  docTypeChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  docTypeChipTextSelected: {
    color: ui.surface,
  },
  customerBox: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    marginBottom: 18,
  },
  customerBoxHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  customerHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  customerBoxTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  customerDirectoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  customerDirectoryBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  customerPickerDropdown: {
    marginTop: 8,
    marginBottom: 4,
    padding: 10,
    borderRadius: 10,
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 6,
  },
  customerSearchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 38,
    marginBottom: 4,
  },
  customerSearchInput: {
    flex: 1,
    fontSize: 13,
    color: ui.text,
    paddingVertical: 0,
  },
  pickerHeading: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 6,
  },
  pickerItem: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  pickerItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  pickerItemDoc: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  pickerEmptyText: {
    color: ui.textSecondary,
    fontSize: 13,
    paddingVertical: 8,
  },
  formGroup: {
    marginBottom: 10,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 4,
  },
  required: {
    color: ui.danger,
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
  inputSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputFlex: {
    flex: 1,
  },
  searchLoader: {
    position: 'absolute',
    right: 12,
  },
  rowTwoCols: {
    flexDirection: 'row',
    gap: 10,
  },
  colFlex: {
    flex: 1,
  },
  docSuccessBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.successSoft,
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  docSuccessText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.success,
  },
  docErrorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.dangerSoft,
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  docErrorText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.danger,
  },
  methodGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
    marginBottom: 20,
  },
  methodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.surface,
    width: '48.5%',
    paddingHorizontal: 12,
    minHeight: 56,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  methodCardSelected: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  methodCardText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  methodCardTextSelected: {
    color: ui.primary,
    fontWeight: '700',
  },
  paymentDetailBox: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    marginBottom: 16,
  },
  cashReceivedInput: {
    fontSize: 20,
    fontWeight: '700',
    color: ui.text,
    textAlign: 'center',
    backgroundColor: ui.background,
    borderColor: ui.primary,
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
  changeDisplayRow: {
    marginTop: 14,
  },
  changeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: ui.successSoft,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.successSoft,
  },
  changeLabel: {
    fontSize: 12,
    color: ui.success,
    fontWeight: '500',
  },
  changeAmountText: {
    fontSize: 22,
    fontWeight: '800',
    color: ui.success,
  },
  shortageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.dangerSoft,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.dangerSoft,
  },
  shortageText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.danger,
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
  mixedBoxTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 8,
  },
  mixedProviderRow: {
    flexDirection: 'row',
    gap: 6,
  },
  providerChip: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 8,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    alignItems: 'center',
  },
  providerChipActive: {
    backgroundColor: ui.primary,
  },
  providerChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  providerChipTextActive: {
    color: ui.surface,
  },
  mixedBalanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.surfaceMuted,
  },
  mixedBalanceText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  mixedExactText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  mixedPendingText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.danger,
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
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: ui.surface,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  confirmBtn: {
    flexDirection: 'row',
    gap: 8,
    minHeight: 52,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  confirmBtnDisabled: { backgroundColor: ui.textMuted },
  btnDisabled: {
    opacity: 0.5,
  },
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
  successIconBubble: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: ui.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  successTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: ui.text,
  },
  successCorrelative: {
    fontSize: 15,
    fontWeight: '600',
    color: ui.textSecondary,
    marginTop: 2,
  },
  successBadgeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  badgeDocument: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: ui.text,
  },
  badgeDocumentText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.surface,
  },
  badgeSunat: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: ui.successSoft,
    borderWidth: 1,
    borderColor: ui.successSoft,
  },
  badgeSunatOffline: {
    backgroundColor: ui.warningSoft,
    borderColor: ui.warningSoft,
  },
  badgeSunatText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.success,
  },
  successDivider: {
    width: '100%',
    height: 1,
    backgroundColor: ui.surfaceMuted,
    marginVertical: 16,
  },
  summaryRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryLabel: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  summaryValue: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  summaryValueBig: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
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
  compactCheckoutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 8,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  compactCheckoutTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
  },
  itemsCountBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
  },
  itemsCountBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  compactCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
  },
  checkoutTotalCardCompact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    marginBottom: 10,
  },
  checkoutTotalLabelCompact: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  checkoutTotalItemsCompact: {
    fontSize: 10,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  checkoutTotalValueCompact: {
    fontSize: 22,
    fontWeight: '900',
    color: ui.primary,
  },
  docTypeRowCompact: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  docTypeChipCompact: {
    flex: 1,
    paddingVertical: 7,
    backgroundColor: ui.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docTypeChipCompactSelected: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  docTypeChipTextCompact: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  docTypeChipTextCompactSelected: {
    color: ui.onPrimary,
    fontWeight: '700',
  },
  customerBoxCompact: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    marginBottom: 10,
  },
  customerBoxTitleCompact: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  formGroupCompact: {
    marginBottom: 6,
  },
  inputLabelCompact: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 3,
  },
  inputCompact: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: ui.text,
  },
  paymentSectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 8,
  },
  paymentSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
  },
  paymentSectionSub: {
    fontSize: 11,
    color: ui.textMuted,
  },
  methodGridCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  methodCardCompact: {
    width: '31%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surface,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  methodCardCompactSelected: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  methodLogoWrapper: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: '#fff',
    borderWidth: 0.5,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodLogoImg: {
    width: '100%',
    height: '100%',
  },
  methodCardTextCompact: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  methodCardTextCompactSelected: {
    color: ui.primary,
    fontWeight: '700',
  },
  quoteNoticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    gap: 12,
  },
  quoteNoticeIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quoteNoticeTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 4,
  },
  quoteNoticeSubtitle: {
    fontSize: 12,
    lineHeight: 17,
    color: ui.textSecondary,
  },
  mixedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  mixedAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  mixedAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  mixedSplitCard: {
    padding: 10,
    borderRadius: 12,
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    marginBottom: 10,
    gap: 8,
  },
  mixedSplitTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mixedSplitIndex: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  mixedSplitTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mixedFillBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: ui.successSoft,
  },
  mixedFillBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.success,
  },
  mixedRemoveBtn: {
    padding: 4,
  },
  mixedAmountInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mixedCurrencyPrefix: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  quickBillsRowSecondary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  quickBillChipClear: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.dangerSoft,
  },
  quickBillTextClear: {
    color: ui.danger,
  },
  discountTogglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  discountToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  discountEditorCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    marginBottom: 10,
  },
  discountEditorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  discountApplyBtn: {
    paddingHorizontal: 14,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discountApplyBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.onPrimary,
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

export default CheckoutModal;
