import React, { useState, useEffect, useMemo } from 'react';
import {
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
  Image,
} from 'react-native';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import * as Print from 'expo-print';
import NetInfo from '@react-native-community/netinfo';
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
} from 'lucide-react-native';
import { useAuth } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import { useSettings } from '@/context/SettingsContext';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { isValidRUC, isValidDNI, calculateTaxTotals, numberToSpanishWordsPEN } from '@/lib/invoicing/types';
import { lookupDocument, DocumentLookupResult } from '@/lib/dni-ruc-service';
import { createSaleTransaction, CreateSaleTransactionParams } from '@/services/sale-service';
import { enqueueOfflineSale } from '@/services/offline-sync-service';
import { getCustomers } from '@/services/crm-operations-service';
import { createQuote } from '@/services/enterprise-ops-service';
import { buildReceiptHtml } from '@/lib/printing/escpos-builder';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import type { Customer, CartItem, SaleDocumentType, PaymentMethod, SalePaymentSplit } from '@/types';

interface CheckoutModalProps {
  visible: boolean;
  onClose: () => void;
  onSaleSuccess?: (saleResult: any) => void;
}

type CheckoutDocType = 'nota_venta' | 'boleta' | 'factura' | 'cotizacion';
type ActivePaymentCategory = 'cash' | 'yape' | 'plin' | 'card' | 'transfer' | 'mixed' | 'fiado';

const PAYMENT_LOGOS: Record<string, any> = {
  yape: require('../assets/payment/yape.jpeg'),
  plin: require('../assets/payment/plin.png'),
  culqi: require('../assets/payment/culqi.jpeg'),
  mastercard: require('../assets/payment/mastercard.webp'),
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

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
  visible,
  onClose,
  onSaleSuccess,
}) => {
  const insets = useSafeAreaInsets();
  const { accountId, branchId, user, userProfile } = useAuth();
  const { items, total, totalAmount, customer: cartCustomer, clearCart, setCustomer: setCartCustomer } = useCart();
  const { posSettings, businessSettings, businessData, activeBranchName, paymentMethods, invoicingEnabled } = useSettings();

  const safeTotal = totalAmount ?? total ?? 0;

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
            { id: 'tarjeta', name: 'Tarjeta', kind: 'terminal', enabled: true, order: 3 },
            { id: 'transferencia', name: 'Transferencia', kind: 'digital', enabled: true, order: 4 },
            { id: 'mixto', name: 'Mixto', kind: 'mixed', enabled: true, order: 5 },
            { id: 'creditos', name: 'Créditos', kind: 'credit', enabled: true, order: 6 },
          ];

    return list
      .filter((m: any) => m.enabled !== false)
      .sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
  }, [posSettings?.methods, paymentMethods]);

  const resolveCategoryFromMethod = (method: any): ActivePaymentCategory => {
    const id = String(method?.id || '').toLowerCase();
    const kind = String(method?.kind || '').toLowerCase();
    const prov = String(method?.provider || '').toLowerCase();
    if (kind === 'cash' || id === 'efectivo') return 'cash';
    if (kind === 'credit' || id === 'creditos' || id === 'fiado') return 'fiado';
    if (kind === 'mixed' || id === 'mixto') return 'mixed';
    if (id === 'yape' || prov === 'yape') return 'yape';
    if (id === 'plin' || prov === 'plin') return 'plin';
    if (id === 'transferencia' || id.includes('transfer')) return 'transfer';
    return 'card';
  };

  const [selectedMethodId, setSelectedMethodId] = useState<string>('efectivo');

  // 1. Selector de Comprobante
  const [docType, setDocType] = useState<CheckoutDocType>('nota_venta');

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
  const [isSearchingDoc, setIsSearchingDoc] = useState(false);
  const [docSearchSuccess, setDocSearchSuccess] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  // Sincronizar datos de cliente con CartContext en tiempo real (para ventas pausadas y reanudadas)
  const syncCustomerToCart = (patch: {
    name?: string;
    dni?: string;
    ruc?: string;
    phone?: string;
    address?: string;
  }) => {
    const updatedName = (patch.name !== undefined ? patch.name : customerName).trim();
    const updatedDni = (patch.dni !== undefined ? patch.dni : customerDni).trim();
    const updatedRuc = (patch.ruc !== undefined ? patch.ruc : customerRuc).trim();
    const updatedPhone = (patch.phone !== undefined ? patch.phone : customerPhone).trim();
    const updatedAddress = (patch.address !== undefined ? patch.address : customerAddress).trim();

    if (updatedName || updatedDni || updatedRuc) {
      setCartCustomer({
        id: selectedCustomer?.id || `cust_${Date.now()}`,
        name: updatedName || 'Cliente General',
        dni: updatedDni || undefined,
        ruc: updatedRuc || undefined,
        phone: updatedPhone || undefined,
        address: updatedAddress || undefined,
        accountId: accountId || '',
        totalPurchases: selectedCustomer?.totalPurchases || 0,
        totalSpent: selectedCustomer?.totalSpent || 0,
      });
    } else {
      setCartCustomer(null);
    }
  };

  // 3. Método de Pago y Parámetros
  const [paymentCategory, setPaymentCategory] = useState<ActivePaymentCategory>('cash');
  const [cashReceived, setCashReceived] = useState<number>(safeTotal);
  const [operationReference, setOperationReference] = useState('');
  const [creditDays, setCreditDays] = useState('30');
  const [notes, setNotes] = useState('');

  // 4. Pago Mixto
  const [mixedCash, setMixedCash] = useState('');
  const [mixedDigital, setMixedDigital] = useState('');
  const [mixedDigitalProvider, setMixedDigitalProvider] = useState<'yape' | 'plin'>('yape');
  const [mixedCard, setMixedCard] = useState('');

  // 5. Estados de Envío y Pantalla de Éxito
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saleResult, setSaleResult] = useState<any | null>(null);
  const [isSuccessView, setIsSuccessView] = useState(false);
  const [ticketPrinting, setTicketPrinting] = useState(false);

  // Cargar clientes existentes al abrir
  useEffect(() => {
    if (visible && accountId) {
      getCustomers(accountId)
        .then((list) => setCustomersList(list || []))
        .catch(() => {});
    }
  }, [visible, accountId]);

  // Sincronizar cliente del carrito al abrir
  useEffect(() => {
    if (visible) {
      setIsSuccessView(false);
      setSaleResult(null);
      setCashReceived(safeTotal);
      setDocError(null);
      setDocSearchSuccess(null);

      if (cartCustomer) {
        setSelectedCustomer(cartCustomer);
        setCustomerName(cartCustomer.name || '');
        if (cartCustomer.ruc) {
          setCustomerRuc(cartCustomer.ruc);
          if (invoicingEnabled) setDocType('factura');
        } else if (cartCustomer.dni) {
          setCustomerDni(cartCustomer.dni);
          if (invoicingEnabled) setDocType('boleta');
        } else {
          setDocType('nota_venta');
        }
        setCustomerAddress(cartCustomer.address || '');
        setCustomerPhone(cartCustomer.phone || '');
      } else {
        setSelectedCustomer(null);
        setCustomerDni('');
        setCustomerRuc('');
        setCustomerName('');
        setCustomerAddress('');
        setCustomerPhone('');
        setDocType('nota_venta');
      }
    }
  }, [visible, safeTotal, cartCustomer, invoicingEnabled]);

  // Consulta automática de DNI cuando alcanza 8 dígitos
  useEffect(() => {
    const cleanDni = customerDni.trim().replace(/\D/g, '');
    if (cleanDni.length === 8 && isValidDNI(cleanDni)) {
      handleLookup('dni', cleanDni);
    }
  }, [customerDni]);

  // Consulta automática de RUC cuando alcanza 11 dígitos y es válido
  useEffect(() => {
    const cleanRuc = customerRuc.trim().replace(/\D/g, '');
    if (cleanRuc.length === 11 && isValidRUC(cleanRuc)) {
      handleLookup('ruc', cleanRuc);
    }
  }, [customerRuc]);

  const handleLookup = async (type: 'dni' | 'ruc', number: string) => {
    try {
      setIsSearchingDoc(true);
      setDocError(null);
      setDocSearchSuccess(null);

      const res: DocumentLookupResult = await lookupDocument(type, number);
      if (res && res.name) {
        setCustomerName(res.name);
        if (res.address) {
          setCustomerAddress(res.address);
        }
        setDocSearchSuccess(`${type.toUpperCase()} verificado: ${res.name}`);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        syncCustomerToCart({
          name: res.name,
          address: res.address || customerAddress,
          dni: type === 'dni' ? number : customerDni,
          ruc: type === 'ruc' ? number : customerRuc,
        });
        if (invoicingEnabled) {
          if (type === 'ruc') setDocType('factura');
          else if (type === 'dni') setDocType('boleta');
        }
      }
    } catch (err: any) {
      setDocError(err?.message || `No se encontró información para este ${type.toUpperCase()}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setIsSearchingDoc(false);
    }
  };

  const handleSelectExistingCustomer = (c: Customer) => {
    setSelectedCustomer(c);
    setCustomerName(c.name || '');
    if (c.ruc) {
      setCustomerRuc(c.ruc);
      if (invoicingEnabled) setDocType('factura');
    } else if (c.dni) {
      setCustomerDni(c.dni);
      if (invoicingEnabled) setDocType('boleta');
    }
    setCustomerAddress(c.address || '');
    setCustomerPhone(c.phone || '');
    setShowCustomerPicker(false);
    setDocSearchSuccess(`Cliente: ${c.name}`);
    setCartCustomer(c);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Cálculo de Vuelto en Efectivo
  const cashChange = useMemo(() => {
    if (paymentCategory !== 'cash') return 0;
    return Math.max(0, cashReceived - safeTotal);
  }, [cashReceived, safeTotal, paymentCategory]);

  const cashShortage = useMemo(() => {
    if (paymentCategory !== 'cash') return 0;
    return Math.max(0, safeTotal - cashReceived);
  }, [cashReceived, safeTotal, paymentCategory]);

  // Balance en Pago Mixto
  const mixedAllocation = useMemo(() => {
    const cash = parseFloat(mixedCash) || 0;
    const digital = parseFloat(mixedDigital) || 0;
    const card = parseFloat(mixedCard) || 0;
    const assigned = cash + digital + card;
    const pending = safeTotal - assigned;
    return { cash, digital, card, assigned, pending, isExact: Math.abs(pending) < 0.01 };
  }, [mixedCash, mixedDigital, mixedCard, safeTotal]);

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

  // Validación General para Confirmar Venta
  const canConfirmSale = useMemo(() => {
    if (safeTotal <= 0) return false;
    if (items.length === 0) return false;

    // Cotización solo requiere total > 0 e items > 0 (sin pago obligatorio ni SUNAT estricto)
    if (docType === 'cotizacion') {
      return true;
    }

    // Validación Factura SUNAT
    if (docType === 'factura') {
      const cleanRuc = customerRuc.trim().replace(/\D/g, '');
      if (cleanRuc.length !== 11 || !isValidRUC(cleanRuc)) return false;
      if (!customerName.trim()) return false;
    }

    // Validación Efectivo
    if (paymentCategory === 'cash') {
      if (cashReceived < safeTotal) return false;
    }

    // Validación Pago Mixto
    if (paymentCategory === 'mixed') {
      if (!mixedAllocation.isExact) return false;
    }

    // Validación Fiado
    if (paymentCategory === 'fiado') {
      if (!fiadoValidation.isValid) return false;
    }

    return true;
  }, [safeTotal, items, docType, customerRuc, customerName, paymentCategory, cashReceived, mixedAllocation, fiadoValidation]);

  // Envío Transaccional de Venta
  const handleConfirmSale = async () => {
    if (!canConfirmSale || !accountId) return;

    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const netInfo = await NetInfo.fetch();
      const isOnline = Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

      // Si el comprobante elegido es Cotización, generar cotización sin cobrar ni restar inventario
      if (docType === 'cotizacion') {
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
              presentation: cleanI.presentation || null,
              variant: cleanI.variant || null,
            };
          })
        );

        const newQuote = await createQuote({
          accountId,
          branchId: branchId || 'main',
          branchName: activeBranchName || '',
          items: quoteItems,
          subtotal: safeTotal,
          tax: 0,
          total: safeTotal,
          customerId: selectedCustomer?.id,
          customerName: customerName.trim() || 'Cliente General',
          customerPhone: customerPhone.trim() || undefined,
          customerDni: customerDni.trim() || undefined,
          customerRuc: customerRuc.trim() || undefined,
          customerAddress: customerAddress.trim() || undefined,
          notes: notes.trim() || undefined,
          validityDays: 15,
          source: 'mobile',
          createdBy: user?.uid,
          createdByName: userProfile?.displayName || user?.displayName || 'Cajero POS',
        });

        const quoteNumber = newQuote.quoteNumber || parseInt(newQuote.id.slice(-5), 10) || 1001;
        const formattedNumber = newQuote.formattedNumber || `COT-${String(quoteNumber).padStart(5, '0')}`;

        const quoteResult = {
          saleId: newQuote.id,
          saleNumber: quoteNumber,
          correlative: formattedNumber,
          documentType: 'cotizacion',
          total: safeTotal,
          status: 'pending',
          sunatStatus: 'not_applicable',
        };

        setSaleResult(quoteResult);
        setIsSuccessView(true);
        clearCart();
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
            isWeightBased: cleanI.isWeightBased || false,
          };
        })
      );

      // Mapear pagos
      let paymentsList: SalePaymentSplit[] = [];
      let mappedMethod: PaymentMethod = 'cash';

      if (paymentCategory === 'cash') {
        mappedMethod = 'cash';
        paymentsList = [
          {
            category: 'cash',
            amount: safeTotal,
            chargedAmount: cashReceived,
            surchargeAmount: 0,
          },
        ];
      } else if (paymentCategory === 'yape') {
        mappedMethod = 'digital';
        paymentsList = [
          {
            category: 'digital',
            amount: safeTotal,
            digitalProvider: 'yape',
            reference: operationReference.trim() || undefined,
          },
        ];
      } else if (paymentCategory === 'plin') {
        mappedMethod = 'digital';
        paymentsList = [
          {
            category: 'digital',
            amount: safeTotal,
            digitalProvider: 'plin',
            reference: operationReference.trim() || undefined,
          },
        ];
      } else if (paymentCategory === 'card') {
        mappedMethod = 'card';
        paymentsList = [
          {
            category: 'card',
            amount: safeTotal,
            reference: operationReference.trim() || undefined,
          },
        ];
      } else if (paymentCategory === 'transfer') {
        mappedMethod = 'digital';
        paymentsList = [
          {
            category: 'digital',
            amount: safeTotal,
            reference: operationReference.trim() || undefined,
          },
        ];
      } else if (paymentCategory === 'mixed') {
        mappedMethod = 'mixed';
        if (mixedAllocation.cash > 0) {
          paymentsList.push({ category: 'cash', amount: mixedAllocation.cash });
        }
        if (mixedAllocation.digital > 0) {
          paymentsList.push({
            category: 'digital',
            amount: mixedAllocation.digital,
            digitalProvider: mixedDigitalProvider,
          });
        }
        if (mixedAllocation.card > 0) {
          paymentsList.push({ category: 'card', amount: mixedAllocation.card });
        }
      } else if (paymentCategory === 'fiado') {
        mappedMethod = 'credit';
        paymentsList = [
          {
            category: 'credit',
            amount: safeTotal,
          },
        ];
      }

      const salePayload: CreateSaleTransactionParams = {
        accountId,
        branchId: branchId || 'main',
        userId: user?.uid || 'user_mobile',
        userName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero POS',
        items: saleItems,
        paymentMethod: mappedMethod,
        documentType: docType as SaleDocumentType,
        total: safeTotal,
        payments: cleanFirestoreData(paymentsList),
        cashReceived: paymentCategory === 'cash' ? cashReceived : undefined,
        changeGiven: paymentCategory === 'cash' ? cashChange : undefined,
        customer: {
          id: selectedCustomer?.id,
          name: customerName.trim() || 'Cliente Varios',
          documentNumber: docType === 'factura' ? customerRuc.trim() : customerDni.trim() || undefined,
          documentType: docType === 'factura' ? 'RUC' : customerDni.trim() ? 'DNI' : undefined,
          address: customerAddress.trim() || undefined,
          phone: customerPhone.trim() || undefined,
        },
        customerId: selectedCustomer?.id,
        customerName: customerName.trim() || 'Cliente Varios',
        notes: notes.trim() || (paymentCategory === 'fiado' ? `Vencimiento: ${creditDays} días` : undefined),
        isQuote: false,
      };

      let result: any;
      if (isOnline) {
        result = await createSaleTransaction(salePayload);
      } else {
        const queuedItem = await enqueueOfflineSale(salePayload);
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

      setSaleResult(result);
      setIsSuccessView(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (onSaleSuccess) {
        onSaleSuccess(result);
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
    if (!saleResult) return;
    try {
      setTicketPrinting(true);
      const taxData = calculateTaxTotals(safeTotal);
      const saleObj: any = {
        id: saleResult.saleId || 'sale_1',
        saleNumber: saleResult.saleNumber || 1001,
        documentNumber: saleResult.correlative || `#${saleResult.saleNumber || '001'}`,
        documentType: docType,
        date: Date.now(),
        items,
        total: safeTotal,
        subtotal: taxData.opGravada,
        tax: taxData.igv,
        paymentMethod: paymentCategory.toUpperCase(),
        cashReceived: paymentCategory === 'cash' ? cashReceived : undefined,
        changeGiven: paymentCategory === 'cash' ? cashChange : undefined,
        customerName: customerName.trim() || 'CLIENTE VARIOS',
        customerRuc: customerRuc.trim() || undefined,
        customerDni: customerDni.trim() || undefined,
        customerAddress: customerAddress.trim() || undefined,
        amountInWords: numberToSpanishWordsPEN(safeTotal),
        isOfflinePending: Boolean(saleResult.isOffline),
      };

      const html = buildReceiptHtml(saleObj, {
        businessName: businessSettings?.businessName || businessData?.businessName || 'VENTIFY',
        ruc: businessSettings?.ruc || businessData?.ruc || '20000000001',
        address: businessSettings?.commercialAddress || activeBranchName || 'Lima, Perú',
        phone: businessSettings?.commercialPhone || '',
        consultUrl: 'https://ventify.com.pe/comprobantes',
        receiptFooter: posSettings?.ticketFooterMessage || '¡Gracias por su compra!',
      });

      await Print.printAsync({ html });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Error de Impresión', err?.message || 'No se pudo enviar la orden de impresión.');
    } finally {
      setTicketPrinting(false);
    }
  };

  // 2. Compartir Ticket por WhatsApp
  const handleShareWhatsApp = async () => {
    if (!saleResult) return;
    try {
      const docLabel =
        docType === 'factura'
          ? 'FACTURA ELECTRÓNICA'
          : docType === 'boleta'
          ? 'BOLETA ELECTRÓNICA'
          : docType === 'cotizacion'
          ? 'COTIZACIÓN'
          : 'NOTA DE VENTA';

      const correlative = saleResult.correlative || `#${saleResult.saleNumber}`;
      const itemsText = items
        .map((i) => `• ${i.quantity}x ${i.name} - ${formatPEN((i.lineTotal !== undefined ? i.lineTotal : i.price * i.quantity))}`)
        .join('\n');

      const message =
        `*${businessSettings?.businessName || 'VENTIFY'}*\n` +
        `🧾 *${docLabel}*: ${correlative}\n` +
        `📅 *Fecha*: ${formatDatePE(Date.now())}\n` +
        (customerName ? `👤 *Cliente*: ${customerName}\n` : '') +
        (customerRuc ? `🏢 *RUC*: ${customerRuc}\n` : '') +
        (customerDni ? `🆔 *DNI*: ${customerDni}\n` : '') +
        `\n*DETALLE DE COMPRA:*\n${itemsText}\n\n` +
        `💰 *TOTAL: ${formatPEN(safeTotal)}*\n` +
        `💳 *Método de Pago*: ${paymentCategory.toUpperCase()}\n` +
        (cashChange > 0 ? `💵 *Vuelto*: ${formatPEN(cashChange)}\n` : '') +
        `\n_¡Muchas gracias por su preferencia!_`;

      const cleanPhone = customerPhone.replace(/\D/g, '');
      const whatsappUrl = cleanPhone
        ? `whatsapp://send?phone=${cleanPhone.startsWith('51') ? cleanPhone : '51' + cleanPhone}&text=${encodeURIComponent(message)}`
        : `whatsapp://send?text=${encodeURIComponent(message)}`;

      const canOpen = await Linking.canOpenURL(whatsappUrl);
      if (canOpen) {
        await Linking.openURL(whatsappUrl);
      } else {
        await Share.share({ message });
      }
    } catch (err: any) {
      Alert.alert('WhatsApp', 'No se pudo abrir WhatsApp para compartir el comprobante.');
    }
  };

  // 3. Iniciar Nueva Venta
  const handleNewSale = () => {
    clearCart();
    setCartCustomer(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
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
            onPress={onClose}
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
            <View style={styles.successCard}>
              <View style={styles.successIconBubble}>
                <CheckCircle2 size={56} color={ui.primary} />
              </View>

              <Text style={styles.successTitle}>
                {docType === 'cotizacion' ? '¡Cotización Generada con Éxito!' : '¡Venta Registrada con Éxito!'}
              </Text>
              <Text style={styles.successCorrelative}>
                {saleResult?.correlative || `#${saleResult?.saleNumber || '0001'}`}
              </Text>

              <View style={styles.successBadgeRow}>
                <View style={styles.badgeDocument}>
                  <Text style={styles.badgeDocumentText}>{docType.toUpperCase()}</Text>
                </View>
                <View
                  style={[
                    styles.badgeSunat,
                    docType === 'cotizacion' && { backgroundColor: ui.primarySoft, borderColor: ui.primary },
                    saleResult?.isOffline && styles.badgeSunatOffline,
                  ]}
                >
                  <Text
                    style={[
                      styles.badgeSunatText,
                      docType === 'cotizacion' && { color: ui.primary },
                    ]}
                  >
                    {docType === 'cotizacion'
                      ? 'COTIZACIÓN SIN COBRO'
                      : saleResult?.isOffline
                      ? 'EN COLA OFFLINE'
                      : 'SUNAT: ACEPTADO'}
                  </Text>
                </View>
              </View>

              <View style={styles.successDivider} />

              {/* Resumen de la Venta / Cotización */}
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  {docType === 'cotizacion' ? 'Monto Cotizado:' : 'Total Pagado:'}
                </Text>
                <Text style={styles.summaryValueBig}>{formatPEN(safeTotal)}</Text>
              </View>
              {docType !== 'cotizacion' ? (
                <>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Método de Pago:</Text>
                    <Text style={styles.summaryValue}>{paymentCategory.toUpperCase()}</Text>
                  </View>
                  {paymentCategory === 'cash' && cashChange > 0 ? (
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Vuelto Entregado:</Text>
                      <Text style={[styles.summaryValue, { color: ui.primary, fontWeight: '700' }]}>
                        {formatPEN(cashChange)}
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : null}
              {customerName ? (
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Cliente:</Text>
                  <Text style={styles.summaryValue}>{customerName}</Text>
                </View>
              ) : null}

              {/* 3 Acciones Inmediatas */}
              <View style={styles.postActionsWrapper}>
                {/* 1. Imprimir Ticket Térmico */}
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

                {/* 2. Compartir Ticket por WhatsApp */}
                <TouchableOpacity
                  style={[styles.postActionBtn, styles.postActionWhatsapp]}
                  onPress={handleShareWhatsApp}
                  activeOpacity={0.8}
                >
                  <Share2 size={20} color={ui.onPrimary} />
                  <Text style={styles.postActionBtnText}>Enviar por WhatsApp</Text>
                </TouchableOpacity>

                {/* 3. Nueva Venta */}
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
            {/* Total a cobrar compacto */}
            <View style={styles.checkoutTotalCardCompact}>
              <View>
                <Text style={styles.checkoutTotalLabelCompact}>Total a cobrar</Text>
                <Text style={styles.checkoutTotalItemsCompact}>{items.length} {items.length === 1 ? 'producto' : 'productos'}</Text>
              </View>
              <Text style={styles.checkoutTotalValueCompact}>{formatPEN(safeTotal)}</Text>
            </View>

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
                  onPress={() => setShowCustomerPicker((prev) => !prev)}
                  accessibilityRole="button"
                  accessibilityLabel={showCustomerPicker ? 'Cerrar directorio de clientes' : 'Abrir directorio de clientes'}
                  accessibilityState={{ expanded: showCustomerPicker }}
                >
                  <Search size={12} color={ui.primary} />
                  <Text style={styles.customerDirectoryBtnText}>Directorio</Text>
                </TouchableOpacity>
              </View>

              {/* Selector de Cliente Existente */}
              {showCustomerPicker ? (
                <View style={styles.customerPickerDropdown}>
                  <Text style={styles.pickerHeading}>Clientes Frecuentes:</Text>
                  {customersList.length === 0 ? (
                    <Text style={styles.pickerEmptyText}>No hay clientes guardados todavía.</Text>
                  ) : customersList.slice(0, 5).map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.pickerItem}
                      onPress={() => handleSelectExistingCustomer(c)}
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
              ) : null}

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
                      onChangeText={(t) => {
                        setCustomerRuc(t);
                        syncCustomerToCart({ ruc: t });
                      }}
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
                    onChangeText={(t) => {
                      setCustomerName(t);
                      syncCustomerToCart({ name: t });
                    }}
                    placeholder="Nombre o Razón Social"
                    placeholderTextColor={ui.textMuted}
                  />
                  <View style={styles.rowTwoCols}>
                    <View style={[styles.formGroupCompact, styles.colFlex]}>
                      <Text style={styles.inputLabelCompact}>Dirección Fiscal</Text>
                      <TextInput
                        style={styles.inputCompact}
                        value={customerAddress}
                        onChangeText={(t) => {
                          setCustomerAddress(t);
                          syncCustomerToCart({ address: t });
                        }}
                        placeholder="Dirección fiscal"
                        placeholderTextColor={ui.textMuted}
                      />
                    </View>
                    <View style={[styles.formGroupCompact, styles.colFlex]}>
                      <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
                      <TextInput
                        style={styles.inputCompact}
                        value={customerPhone}
                        onChangeText={(t) => {
                          setCustomerPhone(t);
                          syncCustomerToCart({ phone: t });
                        }}
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
                      onChangeText={(t) => {
                        setCustomerDni(t);
                        syncCustomerToCart({ dni: t });
                      }}
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
                        onChangeText={(t) => {
                          setCustomerName(t);
                          syncCustomerToCart({ name: t });
                        }}
                        placeholder="Público General"
                        placeholderTextColor={ui.textMuted}
                      />
                    </View>
                    <View style={[styles.formGroupCompact, styles.colFlex]}>
                      <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
                      <TextInput
                        style={styles.inputCompact}
                        value={customerPhone}
                        onChangeText={(t) => {
                          setCustomerPhone(t);
                          syncCustomerToCart({ phone: t });
                        }}
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
                    onChangeText={(t) => {
                      setCustomerName(t);
                      syncCustomerToCart({ name: t });
                    }}
                    placeholder="Público General"
                    placeholderTextColor={ui.textMuted}
                  />
                  <View style={styles.rowTwoCols}>
                    <View style={[styles.formGroupCompact, styles.colFlex]}>
                      <Text style={styles.inputLabelCompact}>DNI (Opcional)</Text>
                      <TextInput
                        style={styles.inputCompact}
                        value={customerDni}
                        onChangeText={(t) => {
                          setCustomerDni(t);
                          syncCustomerToCart({ dni: t });
                        }}
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
                        onChangeText={(t) => {
                          setCustomerPhone(t);
                          syncCustomerToCart({ phone: t });
                        }}
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
                <View style={styles.methodGridCompact}>
              {configuredMethods.map((m: any) => {
                const cat = resolveCategoryFromMethod(m);
                const isSelected = selectedMethodId === m.id || (paymentCategory === cat && !configuredMethods.some((x: any) => x.id === selectedMethodId));
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
                        <Image source={logo} style={styles.methodLogoImg} resizeMode="contain" />
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
                  onChangeText={(val) => setCashReceived(parseFloat(val) || 0)}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  placeholderTextColor={ui.textMuted}
                />

                {/* Chips de billetes rápidos (Sin billete de 200) */}
                <View style={styles.quickBillsRow}>
                  <TouchableOpacity
                    style={styles.quickBillChip}
                    onPress={() => setCashReceived(safeTotal)}
                    accessibilityRole="button"
                    accessibilityLabel={`Recibir monto exacto, ${formatPEN(safeTotal)}`}
                  >
                    <Text style={styles.quickBillText}>Exacto</Text>
                  </TouchableOpacity>
                  {[10, 20, 50, 100].map((bill) => (
                    <TouchableOpacity
                      key={bill}
                      style={styles.quickBillChip}
                      onPress={() => setCashReceived(bill)}
                      accessibilityRole="button"
                      accessibilityLabel={`Recibir ${formatPEN(bill)}`}
                    >
                      <Text style={styles.quickBillText}>S/ {bill}</Text>
                    </TouchableOpacity>
                  ))}
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
                      {posSettings?.digitalPhone || '987 654 321'}
                    </Text>
                  </Text>
                  <Text style={styles.digitalInfoHolder}>
                    Titular:{' '}
                    <Text style={styles.boldText}>
                      {posSettings?.digitalName || businessSettings?.businessName || 'Ventify POS'}
                    </Text>
                  </Text>
                </View>
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
              <View style={styles.paymentDetailBox}>
                <Text style={styles.mixedBoxTitle}>Desglose de Pago Mixto</Text>
                <View style={styles.rowTwoCols}>
                  <View style={[styles.formGroup, styles.colFlex]}>
                    <Text style={styles.inputLabel}>Efectivo (S/)</Text>
                    <TextInput
                      style={styles.input}
                      accessibilityLabel="Monto en efectivo del pago mixto"
                      value={mixedCash}
                      onChangeText={setMixedCash}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                  <View style={[styles.formGroup, styles.colFlex]}>
                    <Text style={styles.inputLabel}>Tarjeta (S/)</Text>
                    <TextInput
                      style={styles.input}
                      accessibilityLabel="Monto con tarjeta del pago mixto"
                      value={mixedCard}
                      onChangeText={setMixedCard}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                </View>

                <View style={styles.rowTwoCols}>
                  <View style={[styles.formGroup, styles.colFlex]}>
                    <Text style={styles.inputLabel}>Digital Yape/Plin (S/)</Text>
                    <TextInput
                      style={styles.input}
                      accessibilityLabel="Monto digital del pago mixto"
                      value={mixedDigital}
                      onChangeText={setMixedDigital}
                      placeholder="0.00"
                      keyboardType="decimal-pad"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                  <View style={[styles.formGroup, styles.colFlex]}>
                    <Text style={styles.inputLabel}>Proveedor</Text>
                    <View style={styles.mixedProviderRow}>
                      <TouchableOpacity
                        style={[
                          styles.providerChip,
                          mixedDigitalProvider === 'yape' && styles.providerChipActive,
                        ]}
                        onPress={() => setMixedDigitalProvider('yape')}
                        accessibilityRole="button"
                        accessibilityLabel="Proveedor digital Yape"
                        accessibilityState={{ selected: mixedDigitalProvider === 'yape' }}
                      >
                        <Text
                          style={[
                            styles.providerChipText,
                            mixedDigitalProvider === 'yape' && styles.providerChipTextActive,
                          ]}
                        >
                          Yape
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.providerChip,
                          mixedDigitalProvider === 'plin' && styles.providerChipActive,
                        ]}
                        onPress={() => setMixedDigitalProvider('plin')}
                        accessibilityRole="button"
                        accessibilityLabel="Proveedor digital Plin"
                        accessibilityState={{ selected: mixedDigitalProvider === 'plin' }}
                      >
                        <Text
                          style={[
                            styles.providerChipText,
                            mixedDigitalProvider === 'plin' && styles.providerChipTextActive,
                          ]}
                        >
                          Plin
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                {/* Balance Mixto */}
                <View style={styles.mixedBalanceRow}>
                  <Text style={styles.mixedBalanceText}>
                    Asignado: {formatPEN(mixedAllocation.assigned)} / Total: {formatPEN(safeTotal)}
                  </Text>
                  {mixedAllocation.isExact ? (
                    <Text style={styles.mixedExactText}>¡Cuadre exacto!</Text>
                  ) : (
                    <Text style={styles.mixedPendingText}>
                      Pendiente: {formatPEN(mixedAllocation.pending)}
                    </Text>
                  )}
                </View>
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
              accessibilityLabel={isSubmitting ? 'Registrando venta' : `Confirmar venta por ${formatPEN(safeTotal)}`}
              accessibilityState={{ disabled: !canConfirmSale || isSubmitting, busy: isSubmitting }}
            >
              {isSubmitting ? (
                <ActivityIndicator color={ui.onPrimary} size="small" />
              ) : (
                <>
                  <Text style={styles.confirmBtnText}>
                    {docType === 'cotizacion'
                      ? `GENERAR COTIZACIÓN ${formatPEN(safeTotal)}`
                      : `CONFIRMAR VENTA ${formatPEN(safeTotal)}`}
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
};

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
    backgroundColor: ui.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    marginBottom: 12,
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
});

export default CheckoutModal;
