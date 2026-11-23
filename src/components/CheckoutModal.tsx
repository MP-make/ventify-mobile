import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  AppState,
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  CreditCard,
  Banknote,
  ArrowRight,
  FileText,
  Clock,
  Layers,
} from 'lucide-react-native';
import { useAuthSession } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import {
  useBusinessSettings,
  useCashSession,
  useOfflineStatus,
} from '@/context/SettingsContext';
import { sharedRequestCache } from '@/lib/request-cache';
import { formatPEN, ui } from '@/lib/theme';
import { numberToSpanishWordsPEN } from '@/lib/invoicing/types';
import { computeSaleTaxBreakdown } from '@/lib/invoicing/receipt-amounts';
import {
  createSaleTransaction,
  CreateSaleTransactionParams,
  getAvailableSaleSellers,
  SaleSellerOption,
} from '@/services/sale-service';
import { enqueueOfflineSale } from '@/services/offline-sync-service';
import { getCustomers, syncCustomerContactInfo } from '@/services/crm-operations-service';
import { createQuote } from '@/services/enterprise-ops-service';
import { presentationFactor } from '@/lib/presentation-parity';
import { useProductsActions } from '@/context/ProductsContext';
import { checkIsOnlineLive, withTimeout } from '@/lib/online-guard';
import {
  createProductLookup,
  isLikelyNetworkError,
  validateCartStockForCheckout,
} from '@/lib/offline-stock-helpers';
import {
  tryResolveCheckoutPayment,
  type CheckoutPaymentSplitInput,
} from '@/lib/checkout-payment';
import type { Branch, Customer, SaleDocumentType, SalePaymentSplit } from '@/types';
import {
  DEFAULT_MIXED_SPLIT_OPTIONS,
  type ActivePaymentCategory,
  type CheckoutCustomerFormValues,
  type CheckoutDocType,
  type MixedSplitOption,
  type MixedSplitRow,
  type PaymentOptionItem,
} from './checkout/checkout-types';
import { CheckoutCustomerSection } from './checkout/CheckoutCustomerSection';
import { CheckoutMixedPayments } from './checkout/CheckoutMixedPayments';
import { CheckoutCashSection } from './checkout/CheckoutCashSection';
import { CheckoutPaymentDetails } from './checkout/CheckoutPaymentDetails';
import { CheckoutNotesSection } from './checkout/CheckoutNotesSection';
import { CheckoutDiscountSection } from './checkout/CheckoutDiscountSection';
import { CheckoutSuccessView } from './checkout/CheckoutSuccessView';

export type { MixedSplitOption, MixedSplitRow } from './checkout/checkout-types';

interface CheckoutModalProps {
  visible: boolean;
  onClose: () => void;
  onSaleSuccess?: (saleResult: any) => void;
  initialDocType?: 'nota_venta' | 'boleta' | 'factura' | 'quote' | 'cotizacion';
  branch?: Branch | null;
}

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

interface PaymentMethodGridProps {
  options: PaymentOptionItem[];
  selectedMethodId: string;
  paymentCategory: ActivePaymentCategory;
  hasSelectedMethodInOptions: boolean;
  onSelectMethod: (id: string, category: ActivePaymentCategory) => void;
}

const PaymentMethodGrid = React.memo<PaymentMethodGridProps>(({
  options,
  selectedMethodId,
  paymentCategory,
  hasSelectedMethodInOptions,
  onSelectMethod,
}) => (
  <View style={styles.methodGridCompact}>
    {options.map((opt) => {
      const isSelected =
        selectedMethodId === opt.id ||
        (paymentCategory === opt.category && !hasSelectedMethodInOptions);
      return (
        <TouchableOpacity
          key={opt.id}
          style={[styles.methodCardCompact, isSelected && styles.methodCardCompactSelected]}
          accessibilityRole="button"
          accessibilityLabel={`Método de pago: ${opt.label}`}
          accessibilityState={{ selected: isSelected }}
          onPress={() => onSelectMethod(opt.id, opt.category)}
          activeOpacity={0.7}
        >
          {opt.logo ? (
            <View style={styles.methodLogoWrapper}>
              <Image
                source={opt.logo}
                style={styles.methodLogoImg}
                contentFit="contain"
                cachePolicy="memory-disk"
              />
            </View>
          ) : opt.category === 'cash' ? (
            <Banknote size={18} color={isSelected ? ui.primary : ui.textSecondary} />
          ) : opt.category === 'mixed' ? (
            <Layers size={18} color={isSelected ? ui.primary : ui.textSecondary} />
          ) : opt.category === 'fiado' ? (
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
            {opt.label}
          </Text>
        </TouchableOpacity>
      );
    })}
  </View>
));

const CheckoutModalContent: React.FC<CheckoutModalProps> = React.memo(({
  visible,
  onClose,
  onSaleSuccess,
  initialDocType,
  branch,
}) => {
  const insets = useSafeAreaInsets();
  const { accountId, branchId, user, userProfile } = useAuthSession();
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
    paymentMethods,
    invoicingEnabled,
    taxProfile,
    emitterInfo,
    configurationReady,
    configurationError,
    refreshConfiguration,
  } = useBusinessSettings();
  const { activeCashSession, refreshCashStatus } = useCashSession();
  const { isOnline: settingsIsOnline, refreshOfflineCount } = useOfflineStatus();
  const { getProductById, applyAuthoritativeStockUpdates } = useProductsActions();

  const resolvedBranch = branch || activeBranch || null;
  const safeTotal = totalAmount ?? total ?? 0;

  // Métodos de pago configurados por el dueño en Firestore
  const configuredMethods = useMemo(() => {
    const list =
      Array.isArray(posSettings?.methods) && posSettings.methods.length > 0
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
      .filter(
        (m: any) =>
          m.enabled !== false && (m.kind !== 'mixed' || posSettings?.allowMixedPayment !== false)
      )
      .map((m: any) => ({
        ...m,
        reportCategory:
          m.reportCategory ||
          (m.kind === 'terminal' || m.kind === 'mixed'
            ? 'card'
            : m.kind === 'credit'
            ? 'credit'
            : m.kind === 'digital'
            ? 'digital'
            : 'cash'),
      }))
      .sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
  }, [posSettings?.methods, posSettings?.allowMixedPayment, paymentMethods]);

  const paymentOptions = useMemo<PaymentOptionItem[]>(
    () =>
      configuredMethods.map((m: any) => ({
        method: m,
        id: String(m.id),
        label: String(m.name || m.id),
        category: resolveCategoryFromMethod(m),
        logo: getMethodLogo(m),
      })),
    [configuredMethods]
  );

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

  const [selectedMethodId, setSelectedMethodId] = useState<string>('efectivo');
  const [paymentCategory, setPaymentCategory] = useState<ActivePaymentCategory>('cash');

  const hasSelectedMethodInOptions = useMemo(
    () => paymentOptions.some((opt) => opt.id === selectedMethodId),
    [paymentOptions, selectedMethodId]
  );

  // 1. Selector de Comprobante y candado de selección manual
  const [docType, setDocType] = useState<CheckoutDocType>('nota_venta');
  const docTypeRef = useRef<CheckoutDocType>(docType);
  docTypeRef.current = docType;
  const documentSelectionLockedRef = useRef<boolean>(false);

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

  useEffect(() => {
    if (!invoicingEnabled && (docType === 'boleta' || docType === 'factura')) {
      setDocType('nota_venta');
    }
  }, [invoicingEnabled, docType]);

  // 2. Identificación de Cliente (aislada en CheckoutCustomerSection)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isFacturaCustomerValid, setIsFacturaCustomerValid] = useState<boolean>(false);
  const [customersList, setCustomersList] = useState<Customer[]>([]);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);

  const customerFormRef = useRef<CheckoutCustomerFormValues>({
    name: '',
    dni: '',
    ruc: '',
    phone: '',
    address: '',
    selectedCustomer: null,
  });

  const syncCustomerToCart = useCallback(
    (patch?: Partial<Omit<CheckoutCustomerFormValues, 'selectedCustomer'>>) => {
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
    },
    [accountId, setCartCustomer]
  );

  // 3. Parámetros de Pago (con alta frecuencia aislada en refs y subcomponentes)
  const cashReceivedRef = useRef<number>(safeTotal);
  const [isCashSufficient, setIsCashSufficient] = useState<boolean>(true);
  const [cashSyncSignal, setCashSyncSignal] = useState<{ value: number; seq: number }>({
    value: safeTotal,
    seq: 0,
  });

  const operationReferenceRef = useRef<string>('');
  const notesRef = useRef<string>('');
  const [formResetSeq, setFormResetSeq] = useState<number>(0);
  const [creditDays, setCreditDays] = useState('30');

  const selectedMethodConfig = useMemo(
    () =>
      paymentOptions.find((opt) => opt.id === selectedMethodId)?.method ||
      paymentOptions.find((opt) => opt.category === paymentCategory)?.method ||
      null,
    [paymentOptions, selectedMethodId, paymentCategory]
  );
  const selectedMethodQrUrl = String(selectedMethodConfig?.qrUrl || '').trim();
  const selectedMethodPhone = String(
    selectedMethodConfig?.qrLabel || posSettings?.digitalPhone || ''
  ).trim();
  const digitalHolder = String(
    posSettings?.digitalName || businessSettings?.businessName || ''
  ).trim();

  // 4. Pago Mixto dinámico
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

  const handleFillMixedRemaining = useCallback(
    (id: string) => {
      setMixedSplits((prev) => {
        const currentRow = prev.find((r) => r.id === id);
        if (!currentRow) return prev;
        const otherTotal = prev.reduce(
          (sum, r) => (r.id === id ? sum : sum + (parseFloat(r.amountStr) || 0)),
          0
        );
        const remaining = Math.max(0, Math.round((safeTotal - otherTotal) * 100) / 100);
        return prev.map((r) =>
          r.id === id ? { ...r, amountStr: remaining > 0 ? remaining.toFixed(2) : '' } : r
        );
      });
    },
    [safeTotal]
  );

  // 5. Estados de Envío y Pantalla de Éxito
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saleResult, setSaleResult] = useState<any | null>(null);
  const [saleSellers, setSaleSellers] = useState<SaleSellerOption[]>([]);
  const [selectedSellerId, setSelectedSellerId] = useState('');
  const [showSellerOptions, setShowSellerOptions] = useState(false);
  const [sellerLoadError, setSellerLoadError] = useState<string | null>(null);
  const checkoutOperationId = useRef<string | null>(null);
  const attemptCountRef = useRef<number>(0);
  const activeSaleTokenRef = useRef<string | null>(null);
  const wasVisibleRef = useRef(false);
  const [isSuccessView, setIsSuccessView] = useState(false);

  const sellerAttributionEnabled = posSettings?.enableSellerAttribution === true;
  const sellerSelectionRequired =
    sellerAttributionEnabled && posSettings?.requireSellerSelection === true;
  const selectedSeller = useMemo(
    () => saleSellers.find((seller) => seller.id === selectedSellerId),
    [saleSellers, selectedSellerId]
  );

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
      setSaleSellers((prev) => (prev.length === 0 ? prev : []));
      setSelectedSellerId((prev) => (prev === '' ? prev : ''));
      setSellerLoadError((prev) => (prev === null ? prev : null));
      return () => {
        active = false;
      };
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
    return () => {
      active = false;
    };
  }, [visible, sellerAttributionEnabled, branchId, user?.uid]);

  // Cargar clientes existentes solo al abrir buscador o elegir fiado/créditos (con caché TTL)
  const shouldLoadCustomers =
    visible &&
    Boolean(accountId) &&
    (showCustomerPicker || paymentCategory === 'fiado' || paymentCategory === 'credits');
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

  // Inicializar únicamente en la transición closed -> open
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      wasVisibleRef.current = true;
      documentSelectionLockedRef.current = false;
      setIsSuccessView(false);
      setSaleResult(null);
      checkoutOperationId.current = null;
      attemptCountRef.current = 0;
      activeSaleTokenRef.current = null;
      cashReceivedRef.current = safeTotal;
      setCashSyncSignal((prev) => ({ value: safeTotal, seq: prev.seq + 1 }));
      operationReferenceRef.current = '';
      notesRef.current = '';
      setFormResetSeq((s) => s + 1);

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

      const preferred = normalizeInitialDocType(initialDocType ?? invoiceIntent);
      let nextDoc: CheckoutDocType = 'nota_venta';

      if (cartCustomer) {
        if (cartCustomer.ruc && invoicingEnabled) {
          nextDoc = 'factura';
        } else if (cartCustomer.dni && invoicingEnabled) {
          nextDoc = 'boleta';
        }
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
      checkoutOperationId.current = null;
      attemptCountRef.current = 0;
    }
  }, [
    visible,
    safeTotal,
    cartCustomer,
    invoicingEnabled,
    initialDocType,
    invoiceIntent,
    mixedSplitOptions,
  ]);

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
    let splitsArg: CheckoutPaymentSplitInput[] | undefined;
    if (paymentCategory === 'mixed') {
      const nonZeroSplits = mixedSplitsParsed.filter((s) => s.amount > 0);
      splitsArg = nonZeroSplits.length
        ? nonZeroSplits
        : [{ category: 'cash' as const, amount: 0 }];
    }
    const result = tryResolveCheckoutPayment({
      methods: configuredMethods,
      selectedMethodId,
      category: paymentCategory,
      total: safeTotal,
      ...(splitsArg !== undefined ? { splits: splitsArg } : {}),
    });
    return result.ok
      ? { resolution: result.value, error: '' }
      : { resolution: null, error: result.error };
  }, [configuredMethods, selectedMethodId, paymentCategory, safeTotal, mixedSplitsParsed]);

  const amountToCollect = paymentPreview.resolution?.chargedAmount ?? safeTotal;

  // Validación de Crédito / Fiado
  const fiadoValidation = useMemo(() => {
    if (paymentCategory !== 'fiado') return { isValid: true, reason: '' };
    if (!selectedCustomer) {
      return {
        isValid: false,
        reason: 'Debes seleccionar un cliente del directorio para venta al crédito.',
      };
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
      return {
        isValid: false,
        reason: `Saldo insuficiente. Disponible: ${formatPEN(available)}.`,
      };
    }
    return { isValid: true, reason: '' };
  }, [paymentCategory, selectedCustomer, safeTotal]);

  // Validación General para Confirmar Venta
  const canConfirmSale = useMemo(() => {
    if (safeTotal <= 0) return false;
    if (items.length === 0) return false;

    if (docType === 'cotizacion') {
      return true;
    }

    if (!configurationReady || paymentPreview.error) return false;

    if (docType === 'factura' && !isFacturaCustomerValid) {
      return false;
    }

    if (sellerSelectionRequired && !selectedSeller) return false;

    if (paymentCategory === 'cash' && !isCashSufficient) return false;
    if (paymentCategory === 'mixed' && !mixedAllocation.isExact) return false;
    if (paymentCategory === 'fiado' && !fiadoValidation.isValid) return false;
    if (paymentCategory === 'credits' && !prepaidCreditsValidation.isValid) return false;

    return true;
  }, [
    safeTotal,
    configurationReady,
    paymentPreview.error,
    items.length,
    docType,
    isFacturaCustomerValid,
    paymentCategory,
    isCashSufficient,
    mixedAllocation.isExact,
    fiadoValidation.isValid,
    prepaidCreditsValidation.isValid,
    sellerSelectionRequired,
    selectedSeller,
  ]);

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

  const resolvedReceiptFooter =
    posSettings?.ticketFooterMessage ||
    businessSettings?.receiptFooter ||
    '¡Gracias por su compra!';

  const handleApplyDiscount = useCallback(
    (clampedAmount: number, nextTotal: number) => {
      setDiscount(clampedAmount);
      cashReceivedRef.current = nextTotal;
      setCashSyncSignal((prev) => ({ value: nextTotal, seq: prev.seq + 1 }));
    },
    [setDiscount]
  );

  const handleSelectPaymentMethod = useCallback(
    (id: string, category: ActivePaymentCategory) => {
      setSelectedMethodId(id);
      setPaymentCategory(category);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    []
  );

  const handleToggleCustomerPicker = useCallback(() => {
    setShowCustomerPicker((prev) => !prev);
  }, []);

  const handleCloseCustomerPicker = useCallback(() => {
    setShowCustomerPicker(false);
  }, []);

  // Envío Transaccional de Venta
  const handleConfirmSale = async () => {
    if (!canConfirmSale || !accountId) return;

    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (!checkoutOperationId.current) {
        checkoutOperationId.current = `mobile_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        attemptCountRef.current = 0;
      }
      attemptCountRef.current += 1;
      const saleToken = checkoutOperationId.current;
      activeSaleTokenRef.current = saleToken;

      const isOnline = await checkIsOnlineLive(settingsIsOnline);
      const cartItemsSnapshot = items.map((i) => ({ ...i }));
      const saleTimestamp = Date.now();
      const currCustomer = customerFormRef.current;
      const cleanRuc = currCustomer.ruc.trim().replace(/\D/g, '');
      const cleanDni = currCustomer.dni.trim().replace(/\D/g, '');
      const resolvedCustomerName = currCustomer.name.trim() || 'Cliente Varios';
      const resolvedCustomerAddress = currCustomer.address.trim() || undefined;
      const resolvedCustomerPhone = currCustomer.phone.trim() || undefined;
      const resolvedNotes = notesRef.current.trim();
      const resolvedOperationRef = operationReferenceRef.current.trim();
      const currentCashReceived = cashReceivedRef.current;
      const currentCashChange =
        paymentCategory === 'cash' ? Math.max(0, currentCashReceived - amountToCollect) : 0;

      // Si el comprobante elegido es Cotización, generar cotización sin cobrar ni restar inventario
      if (docType === 'cotizacion') {
        if (!isOnline) {
          throw new Error('Conéctate a internet para emitir y guardar una cotización.');
        }
        const quoteItems = items.map((i) => {
          const resolvedId =
            (i as any).productId ||
            (i as any).product?.id ||
            (i.id.includes('_') ? i.id.split('_')[0] : i.id);
          const { product: _omitProduct, ...cleanI } = i as any;
          return {
            id: resolvedId,
            productId: resolvedId,
            name: cleanI.name,
            quantity: cleanI.quantity,
            price: cleanI.price,
            total:
              cleanI.lineTotal !== undefined ? cleanI.lineTotal : cleanI.price * cleanI.quantity,
            sku: cleanI.sku || '',
            unitOfMeasure: cleanI.unitOfMeasure || 'NIU',
            variantId: cleanI.variantId || cleanI.variant?.id,
            variantName: cleanI.variantName || cleanI.variant?.name,
            presentationId: cleanI.presentationId || cleanI.presentation?.id,
            presentationName: cleanI.presentationName || cleanI.presentation?.name,
            presentationQty:
              cleanI.presentationQty ||
              cleanI.conversionFactor ||
              presentationFactor(cleanI.presentation),
            conversionFactor:
              cleanI.conversionFactor ||
              cleanI.presentationQty ||
              presentationFactor(cleanI.presentation),
            originalPrice: cleanI.originalPrice,
            isGift: Boolean(cleanI.isGift),
          };
        });
        const quoteSubtotal =
          Math.round(items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100;

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
          customerName: currCustomer.name.trim() || 'Cliente General',
          customerPhone: resolvedCustomerPhone,
          customerDni: cleanDni || undefined,
          customerRuc: cleanRuc || undefined,
          customerAddress: resolvedCustomerAddress,
          notes: resolvedNotes || undefined,
          validityDays: 15,
          source: 'mobile',
          createdBy: user?.uid,
          createdByName: userProfile?.displayName || user?.displayName || 'Cajero POS',
        });

        const quoteNumber = newQuote.quoteNumber || parseInt(newQuote.id.slice(-5), 10) || 1001;
        const formattedNumber =
          newQuote.formattedNumber || `COT-${String(quoteNumber).padStart(5, '0')}`;

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
          customerName: currCustomer.name.trim() || 'Cliente General',
          customerDni: cleanDni || undefined,
          customerRuc: cleanRuc || undefined,
          customerAddress: resolvedCustomerAddress,
          customerPhone: resolvedCustomerPhone,
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        requestAnimationFrame(() => {
          clearCart();
          setCartCustomer(null);
          setInvoiceIntent(null);
        });

        if (onSaleSuccess) {
          onSaleSuccess(quoteResult);
        }
        return;
      }

      // Mapear items sin pre-limpieza recursiva (sale-service.ts limpia una vez en el borde de persistencia)
      const saleItems = items.map((i) => {
        const resolvedId =
          (i as any).productId ||
          (i as any).product?.id ||
          (i.id.includes('_') ? i.id.split('_')[0] : i.id);
        const { product: _omitProduct, ...cleanI } = i as any;
        return {
          productId: resolvedId,
          name: cleanI.name,
          quantity: cleanI.quantity,
          price: cleanI.price,
          costPrice: cleanI.costPrice || 0,
          total:
            cleanI.lineTotal !== undefined ? cleanI.lineTotal : cleanI.price * cleanI.quantity,
          sku: cleanI.sku || '',
          unitOfMeasure: cleanI.unitOfMeasure || 'NIU',
          presentation: cleanI.presentation || null,
          variant: cleanI.variant || null,
          variantId: cleanI.variantId || cleanI.variant?.id,
          variantName: cleanI.variantName || cleanI.variant?.name,
          presentationId: cleanI.presentationId,
          presentationName: cleanI.presentationName,
          presentationQty:
            cleanI.presentationQty ||
            cleanI.conversionFactor ||
            presentationFactor(cleanI.presentation),
          conversionFactor:
            cleanI.conversionFactor ||
            cleanI.presentationQty ||
            presentationFactor(cleanI.presentation),
          stockBranchId: cleanI.stockBranchId || branchId || 'main',
          isGift: Boolean(cleanI.isGift),
          originalPrice: cleanI.originalPrice,
          priceModificationReason: cleanI.priceModificationReason,
          isWeightBased: cleanI.isWeightBased || false,
        };
      });

      const payment = paymentPreview.resolution;
      if (!payment) throw new Error(paymentPreview.error || 'Selecciona un medio de pago.');
      const method = configuredMethods.find((entry: any) => entry.id === payment.paymentMethodId);
      if (!method) throw new Error('El método de pago ya no está habilitado.');
      const mappedMethod =
        paymentCategory === 'fiado'
          ? 'credit'
          : paymentCategory === 'credits'
          ? 'creditos'
          : paymentCategory === 'mixed'
          ? 'mixed'
          : method.reportCategory;
      const paymentsList: SalePaymentSplit[] = payment.payments.length
        ? payment.payments
        : [
            {
              methodId: payment.paymentMethodId,
              methodName: payment.paymentMethodName,
              category: method.reportCategory,
              amount: safeTotal,
              chargedAmount: payment.chargedAmount,
              commissionAmount: payment.commissionAmount,
              surchargeAmount: payment.surchargeAmount,
              ...(paymentCategory === 'yape' || paymentCategory === 'plin'
                ? { digitalProvider: paymentCategory }
                : {}),
              ...(resolvedOperationRef ? { reference: resolvedOperationRef } : {}),
            },
          ];

      const isServerAttributed =
        sellerAttributionEnabled || Boolean(saleRequestId || sourceQuoteId);
      const itemsGrossSubtotal =
        Math.round(
          items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0), 0) *
            100
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
        creditDays:
          paymentCategory === 'fiado' ? Math.max(1, parseInt(creditDays, 10) || 30) : undefined,
        documentType: docType as SaleDocumentType,
        subtotal: payloadSubtotal,
        tax: payloadTax,
        taxExemptionCode: breakdown.taxExemptionCode,
        isAmazonExempt: breakdown.isAmazonExempt,
        total: safeTotal,
        shippingAmount,
        discountAmount,
        payments: paymentsList,
        cashReceived: paymentCategory === 'cash' ? currentCashReceived : undefined,
        changeGiven: paymentCategory === 'cash' ? currentCashChange : undefined,
        customer: {
          id: selectedCustomer?.id,
          name: resolvedCustomerName,
          documentNumber:
            docType === 'factura' || boletaUsesRuc ? cleanRuc : cleanDni || undefined,
          documentType:
            docType === 'factura' || boletaUsesRuc ? 'RUC' : cleanDni ? 'DNI' : undefined,
          dni: cleanDni || undefined,
          ruc: cleanRuc || undefined,
          email: selectedCustomer?.email || undefined,
          address: resolvedCustomerAddress,
          phone: resolvedCustomerPhone,
        },
        customerId: selectedCustomer?.id,
        customerName: resolvedCustomerName,
        sessionId: activeCashSession?.sessionId || activeCashSession?.id,
        saleDate: saleTimestamp,
        offlineId: saleToken,
        skipOfflineDedup: isOnline && attemptCountRef.current === 1,
        enableSellerAttribution: sellerAttributionEnabled,
        sourceSaleRequestId: saleRequestId || undefined,
        sourceQuoteId: sourceQuoteId || undefined,
        ...(sellerAttributionEnabled && selectedSeller
          ? { sellerId: selectedSeller.id, sellerName: selectedSeller.name }
          : {}),
        notes:
          resolvedNotes ||
          (paymentCategory === 'fiado' ? `Vencimiento: ${creditDays} días` : undefined),
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
            const nextDocNumber =
              settledRes.documentNumber || prev.documentNumber || prev.correlative;
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

      const queueSaleOffline = async () => {
        if (saleRequestId || sourceQuoteId) {
          throw new Error('Conéctate a internet para confirmar la conversión de forma segura.');
        }
        if (paymentCategory === 'fiado' || paymentCategory === 'credits') {
          throw new Error(
            'Las ventas al fiado o con créditos requieren internet. Usa otro método de pago o conéctate.'
          );
        }
        const stockCheck = validateCartStockForCheckout(
          salePayload.items as any[],
          createProductLookup(getProductById),
          branchId || 'main'
        );
        if (!stockCheck.ok) {
          throw new Error(stockCheck.error || 'Stock insuficiente para completar la venta.');
        }
        salePayload.skipOfflineDedup = false;
        const queuedItem = await enqueueOfflineSale(salePayload);
        void refreshOfflineCount();
        const offId = typeof queuedItem === 'string' ? queuedItem : queuedItem.offlineId;
        return {
          saleId: offId,
          saleNumber: Math.floor(100000 + Math.random() * 900000),
          correlative: `OFF-${offId.slice(-6).toUpperCase()}`,
          documentType: docType,
          total: safeTotal,
          status: 'pending_offline',
          sunatStatus: 'pending',
          isOffline: true,
        };
      };

      let result: any;
      if (isOnline) {
        try {
          result = await withTimeout(
            createSaleTransaction(salePayload),
            30_000,
            'Tiempo de espera agotado al conectar con el servidor.'
          );
          if (Array.isArray(result?.updatedProductStocks) && result.updatedProductStocks.length > 0) {
            applyAuthoritativeStockUpdates(result.updatedProductStocks);
          }
          refreshCashStatus();
        } catch (txErr) {
          const canFallbackOffline =
            isLikelyNetworkError(txErr) &&
            !saleRequestId &&
            !sourceQuoteId &&
            paymentCategory !== 'fiado' &&
            paymentCategory !== 'credits' &&
            !posSettings?.enableSellerAttribution;
          if (!canFallbackOffline) {
            throw txErr;
          }
          const stillOnline = await checkIsOnlineLive(false);
          if (stillOnline) {
            throw txErr;
          }
          result = await queueSaleOffline();
        }
      } else {
        result = await queueSaleOffline();
      }

      const finalDocNumber =
        latestSunatRes?.documentNumber ||
        result.documentNumber ||
        result.correlative ||
        `#${result.saleNumber || '0001'}`;
      const resolvedSunatStatus =
        !isOnline || Boolean(result.isOffline)
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
        paymentMethodName:
          payment.paymentMethodName || method.name || paymentCategory.toUpperCase(),
        payments: paymentsList,
        cashReceived: paymentCategory === 'cash' ? currentCashReceived : undefined,
        changeGiven: paymentCategory === 'cash' ? currentCashChange : undefined,
        customerName: currCustomer.name.trim() || 'CLIENTE VARIOS',
        customerRuc: cleanRuc || undefined,
        customerDni: cleanDni || undefined,
        customerAddress: resolvedCustomerAddress,
        customerPhone: resolvedCustomerPhone,
        userName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero POS',
        sellerName: sellerAttributionEnabled && selectedSeller ? selectedSeller.name : undefined,
        amountInWords: numberToSpanishWordsPEN(safeTotal),
        isOfflinePending: Boolean(result.isOffline),
        sunatStatus: resolvedSunatStatus,
        cdrDescription: latestSunatRes?.cdrDescription ?? result.cdrDescription ?? null,
        sunatHash:
          latestSunatRes?.sunatHash ?? latestSunatRes?.einvoice?.hash ?? result.sunatHash ?? null,
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
      attemptCountRef.current = 0;
      setIsSuccessView(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (isOnline && !result.isOffline && accountId && resolvedCustomerPhone) {
        void syncCustomerContactInfo({
          accountId,
          customerId: selectedCustomer?.id,
          name: resolvedCustomerName,
          documentNumber:
            (docType === 'factura' || boletaUsesRuc ? cleanRuc : cleanDni) || undefined,
          dni: cleanDni || undefined,
          ruc: cleanRuc || undefined,
          phone: resolvedCustomerPhone,
          address: resolvedCustomerAddress,
        }).then((savedCustomerId) => {
          if (!savedCustomerId) return;
          setCustomersList((prev) => {
            const idx = prev.findIndex((c) => c.id === savedCustomerId);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = { ...next[idx], phone: resolvedCustomerPhone };
              return next;
            }
            return prev;
          });
        });
      }

      // Diferir limpieza de carrito al siguiente frame para no colisionar con el render del ticket y QR
      requestAnimationFrame(() => {
        clearCart();
        setCartCustomer(null);
        setInvoiceIntent(null);
      });

      if (onSaleSuccess) {
        onSaleSuccess(fullResult);
      }
    } catch (err: any) {
      console.error('[CheckoutModal] Error procesando venta:', err);
      Alert.alert(
        'Error al Cobrar',
        err?.message || 'Ocurrió un error inesperado al procesar la venta.'
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Iniciar Nueva Venta
  const handleNewSale = useCallback(() => {
    activeSaleTokenRef.current = null;
    notesRef.current = '';
    operationReferenceRef.current = '';
    setFormResetSeq((s) => s + 1);
    clearCart();
    setCartCustomer(null);
    setInvoiceIntent(null);
    setIsSuccessView(false);
    setSaleResult(null);
    onClose();
  }, [clearCart, setCartCustomer, setInvoiceIntent, onClose]);

  const handleClose = useCallback(() => {
    if (!isSuccessView) {
      syncCustomerToCart();
    }
    onClose();
  }, [isSuccessView, syncCustomerToCart, onClose]);

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
          <CheckoutSuccessView
            saleResult={saleResult}
            docType={docType}
            receiptBusiness={receiptBusiness}
            resolvedBranch={resolvedBranch}
            taxProfile={taxProfile}
            receiptFooter={resolvedReceiptFooter}
            onNewSale={handleNewSale}
          />
        ) : (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollInner}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
            {/* Total a cobrar compacto + Descuento global manual */}
            <CheckoutDiscountSection
              itemsCount={items.length}
              cartSubtotal={cartSubtotal}
              discountAmount={discountAmount}
              shippingAmount={shippingAmount}
              displayTotal={docType === 'cotizacion' ? safeTotal : amountToCollect}
              canEditDiscount={!sourceQuoteId && !saleRequestId}
              onApplyDiscount={handleApplyDiscount}
            />

            {sellerAttributionEnabled ? (
              <View
                style={{
                  marginTop: 12,
                  marginBottom: 4,
                  padding: 12,
                  borderRadius: 12,
                  backgroundColor: ui.surface,
                  borderWidth: 1,
                  borderColor:
                    sellerSelectionRequired && !selectedSeller ? ui.danger : ui.border,
                }}
              >
                <Text style={styles.paymentSectionTitle}>
                  Vendedor que atendió{sellerSelectionRequired ? ' *' : ''}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Seleccionar vendedor que atendió"
                  onPress={() => setShowSellerOptions((open) => !open)}
                  style={{ minHeight: 42, justifyContent: 'center', marginTop: 6 }}
                >
                  <Text style={{ color: selectedSeller ? ui.text : ui.textSecondary }}>
                    {selectedSeller?.name ||
                      (sellerSelectionRequired ? 'Selecciona un vendedor' : 'Sin vendedor asignado')}
                  </Text>
                </TouchableOpacity>
                {showSellerOptions
                  ? saleSellers.map((seller) => (
                      <TouchableOpacity
                        key={seller.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Vendedor ${seller.name}`}
                        onPress={() => {
                          setSelectedSellerId(seller.id);
                          setShowSellerOptions(false);
                        }}
                        style={{
                          minHeight: 40,
                          justifyContent: 'center',
                          borderTopWidth: 1,
                          borderTopColor: ui.border,
                        }}
                      >
                        <Text style={{ color: ui.text }}>{seller.name}</Text>
                      </TouchableOpacity>
                    ))
                  : null}
                {sellerLoadError ? (
                  <Text style={styles.fiadoErrorText}>{sellerLoadError}</Text>
                ) : null}
                {sellerSelectionRequired && !selectedSeller ? (
                  <Text style={styles.fiadoErrorText}>
                    La configuración requiere un vendedor antes de cobrar.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {!configurationReady && (
              <Text
                accessibilityRole="alert"
                style={{
                  color: configurationError ? ui.danger : ui.textSecondary,
                  paddingVertical: 12,
                }}
              >
                {configurationError ||
                  'Cargando medios de pago y comprobantes… Puedes consultar productos mientras termina.'}
              </Text>
            )}
            {!!configurationError && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={refreshConfiguration}
                style={{ paddingVertical: 12 }}
              >
                <Text style={{ color: ui.primary }}>Reintentar configuración</Text>
              </TouchableOpacity>
            )}

            {/* 1. SELECTOR DE COMPROBANTE FISCAL COMPACTO */}
            <View style={styles.docTypeRowCompact}>
              {docTypeOptions.map((item) => {
                const isSelected = docType === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[
                      styles.docTypeChipCompact,
                      isSelected && styles.docTypeChipCompactSelected,
                    ]}
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

            {/* 2. IDENTIFICACIÓN DEL CLIENTE (PRIORIZADA + BUSCADOR AISLADO) */}
            <CheckoutCustomerSection
              visible={visible}
              docType={docType}
              docTypeRef={docTypeRef}
              documentSelectionLockedRef={documentSelectionLockedRef}
              invoicingEnabled={invoicingEnabled}
              safeTotal={safeTotal}
              cartCustomer={cartCustomer}
              customersList={customersList}
              showCustomerPicker={showCustomerPicker}
              onToggleCustomerPicker={handleToggleCustomerPicker}
              onCloseCustomerPicker={handleCloseCustomerPicker}
              customerFormRef={customerFormRef}
              onSetDocType={setDocType}
              onSelectedCustomerChange={setSelectedCustomer}
              onFacturaValidChange={setIsFacturaCustomerValid}
              onSyncCustomerToCart={syncCustomerToCart}
              onSetCartCustomerDirect={setCartCustomer}
            />

            {/* 3. MÉTODOS DE PAGO DEL DUEÑO O AVISO DE COTIZACIÓN */}
            {docType === 'cotizacion' ? (
              <View style={styles.quoteNoticeCard}>
                <View style={styles.quoteNoticeIconWrap}>
                  <FileText size={24} color={ui.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.quoteNoticeTitle}>Modo Cotización Activo</Text>
                  <Text style={styles.quoteNoticeSubtitle}>
                    Esta cotización formal quedará registrada por 15 días. No cobra ningún monto en
                    caja ni descuenta inventario físico de la tienda.
                  </Text>
                </View>
              </View>
            ) : (
              <>
                <View style={styles.paymentSectionHeaderRow}>
                  <Text style={styles.paymentSectionTitle}>Método de Pago</Text>
                  <Text style={styles.paymentSectionSub}>Configurados por el negocio</Text>
                </View>
                {!!paymentPreview.error && (
                  <Text accessibilityRole="alert" style={{ color: ui.danger }}>
                    {paymentPreview.error}
                  </Text>
                )}
                {(paymentPreview.resolution?.surchargeAmount || 0) > 0 && (
                  <Text style={{ color: ui.textSecondary }}>
                    Recargo: {formatPEN(paymentPreview.resolution!.surchargeAmount)} · Total a
                    cobrar: {formatPEN(amountToCollect)}
                  </Text>
                )}
                {paymentCategory === 'mixed' &&
                  paymentPreview.resolution?.payments.map((part, index) => (
                    <Text key={`${part.methodId}-${index}`} style={{ color: ui.textSecondary }}>
                      {part.methodName}: cobrar {formatPEN(part.chargedAmount ?? part.amount)}
                      {(part.surchargeAmount || 0) > 0
                        ? ` (incluye ${formatPEN(part.surchargeAmount!)} de recargo)`
                        : ''}
                    </Text>
                  ))}

                <PaymentMethodGrid
                  options={paymentOptions}
                  selectedMethodId={selectedMethodId}
                  paymentCategory={paymentCategory}
                  hasSelectedMethodInOptions={hasSelectedMethodInOptions}
                  onSelectMethod={handleSelectPaymentMethod}
                />

                {paymentCategory === 'cash' ? (
                  <CheckoutCashSection
                    amountToCollect={amountToCollect}
                    cashSyncSignal={cashSyncSignal}
                    cashReceivedRef={cashReceivedRef}
                    onCashSufficientChange={setIsCashSufficient}
                  />
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

                {paymentCategory !== 'cash' && paymentCategory !== 'mixed' ? (
                  <CheckoutPaymentDetails
                    paymentCategory={paymentCategory}
                    selectedMethodId={selectedMethodId}
                    selectedMethodName={selectedMethodConfig?.name || ''}
                    selectedMethodQrUrl={selectedMethodQrUrl}
                    selectedMethodPhone={selectedMethodPhone}
                    digitalHolder={digitalHolder}
                    amountToCollect={amountToCollect}
                    selectedCustomer={selectedCustomer}
                    creditDays={creditDays}
                    onChangeCreditDays={setCreditDays}
                    fiadoValidation={fiadoValidation}
                    prepaidCreditsValidation={prepaidCreditsValidation}
                    operationReferenceRef={operationReferenceRef}
                    resetSeq={formResetSeq}
                  />
                ) : null}
              </>
            )}

            {/* NOTAS O COMENTARIOS */}
            <CheckoutNotesSection notesRef={notesRef} resetSeq={formResetSeq} />

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
              accessibilityLabel={
                isSubmitting
                  ? 'Registrando venta'
                  : `Confirmar venta por ${formatPEN(amountToCollect)}`
              }
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
    </Modal>
  );
});

export const CheckoutModal: React.FC<CheckoutModalProps> = React.memo((props) => {
  if (!props.visible) return null;
  return <CheckoutModalContent {...props} />;
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
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
  scrollContent: {
    flex: 1,
    minHeight: 0,
  },
  scrollInner: {
    padding: 20,
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
  confirmBtnDisabled: {
    backgroundColor: ui.textMuted,
  },
  btnDisabled: {
    opacity: 0.5,
  },
});

export default CheckoutModal;
