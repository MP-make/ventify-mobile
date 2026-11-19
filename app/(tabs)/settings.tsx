import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  Switch,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import {
  Printer,
  Wifi,
  WifiOff,
  RefreshCw,
  Shield,
  Lock,
  Building2,
  QrCode,
  Smartphone,
  FileText,
  User,
  LogOut,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Bluetooth,
  Save,
  KeyRound,
  Store,
  X,
  CreditCard,
  Bell,
  Gift,
  Crown,
  ExternalLink,
  ImagePlus,
  Trash2,
  Search,
  Check,
  Wallet,
  Send,
} from 'lucide-react-native';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Header } from '@/components/Header';
import { ui, theme, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { app, db, APP_URL } from '@/lib/firebase';
import { apiRequest } from '@/lib/api-client';
import type { PosPaymentMethodConfig } from '@/types';

import {
  getPrinterConfig,
  savePrinterConfig,
  scanBluetoothPrinters,
  requestBluetoothPermissions,
  testPrinterConnection,
  printTicketPDF,
  PrinterConfig,
  BluetoothPrinterDevice,
  DEFAULT_PRINTER_CONFIG,
} from '@/services/thermal-printer-service';

import {
  getOfflineQueue,
  getQuarantinedSales,
  processOfflineQueue,
  retryQuarantinedSale,
  removeQuarantinedSale,
  PendingOfflineSale,
  QuarantinedOfflineSale,
} from '@/services/offline-sync-service';

import {
  initNotifications,
  getNotificationPermissionStatus,
  registerForPushNotificationsAsync,
  scheduleLocalNotification,
  subscribeAccountNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  type AccountNotification,
} from '@/services/notification-service';

type SettingsTabKey =
  | 'negocio'
  | 'pagos'
  | 'impresora'
  | 'seguridad'
  | 'alertas'
  | 'regalos';

const SETTINGS_TABS: Array<{ key: SettingsTabKey; label: string }> = [
  { key: 'negocio', label: 'Negocio' },
  { key: 'pagos', label: 'Pagos y QR' },
  { key: 'impresora', label: 'Impresora' },
  { key: 'seguridad', label: 'Seguridad' },
  { key: 'alertas', label: 'Alertas' },
  { key: 'regalos', label: 'Regalos' },
];

interface PlanSummaryState {
  loading: boolean;
  error: string | null;
  subscription: {
    planName?: string;
    status?: string;
    daysRemaining?: number;
    nextBillingDate?: number;
    currentPrice?: number;
    currency?: string;
    cycle?: string;
  } | null;
  limits: {
    users?: { current: number; max: number };
    branches?: { current: number; max: number };
    products?: { current: number; max: number };
  } | null;
}

interface NotificationPrefsState {
  pushNotifications: boolean;
  emailNotifications: boolean;
  stockAlerts: boolean;
  quoteAlerts: boolean;
  reservationAlerts: boolean;
  cashRegisterAlerts: boolean;
  aiInsightsAlerts: boolean;
  alertThreshold: string;
}

const DEFAULT_NOTIF_PREFS: NotificationPrefsState = {
  pushNotifications: true,
  emailNotifications: true,
  stockAlerts: true,
  quoteAlerts: true,
  reservationAlerts: true,
  cashRegisterAlerts: true,
  aiInsightsAlerts: true,
  alertThreshold: '5',
};

const SUBSCRIPTION_BADGE_MAP: Record<string, { label: string; bg: string; color: string }> = {
  active: { label: 'Activa', bg: ui.successSoft, color: ui.success },
  trialing: { label: 'Prueba Gratuita', bg: ui.primarySoft, color: ui.primary },
  paused: { label: 'Pausada', bg: ui.warningSoft, color: ui.warning },
  expired: { label: 'Vencida', bg: ui.dangerSoft, color: ui.danger },
  canceled: { label: 'Cancelada', bg: ui.dangerSoft, color: ui.danger },
  cancelled: { label: 'Cancelada', bg: ui.dangerSoft, color: ui.danger },
};

const getRoleLabel = (role?: string): string => {
  switch (role) {
    case 'owner':
      return 'Propietario';
    case 'admin':
      return 'Administrador';
    case 'manager':
      return 'Encargado';
    case 'seller':
      return 'Vendedor';
    default:
      return 'Cajero';
  }
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const {
    user,
    userProfile,
    accountId,
    branchId,
    role,
    lockTerminal,
    updatePinCode,
    logout,
    setActiveBranchId,
    allBranchesAccess,
  } = useAuth();

  const {
    businessSettings,
    businessData,
    posSettings,
    branches,
    activeBranchName,
    activeBranch,
    taxProfile,
    invoicingEnabled,
    emitterInfo,
    allPaymentMethods,
    isOnline,
    offlineQueueCount,
    refreshOfflineCount,
    updateBusinessSettings,
    updateBusinessData,
    updatePosSettings,
  } = useSettings();

  const { products } = useProducts();
  const { canManageSettings, hasAllBranchesAccess } = usePermissions();

  const [activeTab, setActiveTab] = useState<SettingsTabKey>('negocio');

  // ============================================================================
  // ESTADOS: SUSCRIPCIÓN Y LÍMITES DEL PLAN
  // ============================================================================
  const [planState, setPlanState] = useState<PlanSummaryState>({
    loading: false,
    error: null,
    subscription: null,
    limits: null,
  });

  // ============================================================================
  // ESTADOS: IMPRESORA TÉRMICA BLUETOOTH & OFFLINE
  // ============================================================================
  const [printerConfig, setPrinterConfig] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
  const [scannedPrinters, setScannedPrinters] = useState<BluetoothPrinterDevice[]>([]);
  const [isScanningPrinters, setIsScanningPrinters] = useState(false);
  const [printerScanModalVisible, setPrinterScanModalVisible] = useState(false);
  const [isPrintingTest, setIsPrintingTest] = useState(false);
  const [btPermissionChecking, setBtPermissionChecking] = useState(false);

  const [offlineSales, setOfflineSales] = useState<PendingOfflineSale[]>([]);
  const [quarantinedSales, setQuarantinedSales] = useState<QuarantinedOfflineSale[]>([]);
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);
  const [offlineDetailsModalVisible, setOfflineDetailsModalVisible] = useState(false);

  // ============================================================================
  // ESTADOS: SEGURIDAD, BLOQUEO Y PIN DE AUTORIZACIÓN DE EGRESOS
  // ============================================================================
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [isUpdatingPin, setIsUpdatingPin] = useState(false);

  const [cashierExpenseLimitStr, setCashierExpenseLimitStr] = useState('0');
  const [suggestedMarginStr, setSuggestedMarginStr] = useState('25');
  const [hasExpensePin, setHasExpensePin] = useState(false);
  const [expensePinInput, setExpensePinInput] = useState('');
  const [expensePinConfirm, setExpensePinConfirm] = useState('');
  const [isSavingExpenseConfig, setIsSavingExpenseConfig] = useState(false);
  const [isUpdatingExpensePin, setIsUpdatingExpensePin] = useState(false);

  // ============================================================================
  // ESTADOS: DATOS DE EMPRESA, IMPUESTOS, POS Y SUCURSALES
  // ============================================================================
  const [bizName, setBizName] = useState('');
  const [bizRuc, setBizRuc] = useState('');
  const [bizAddress, setBizAddress] = useState('');
  const [bizPhone, setBizPhone] = useState('');
  const [bizEmail, setBizEmail] = useState('');
  const [bizDescription, setBizDescription] = useState('');
  const [ticketFooter, setTicketFooter] = useState('');
  const [isAmazonExempt, setIsAmazonExempt] = useState(false);
  const [taxRateChoice, setTaxRateChoice] = useState<18 | 10>(18);
  const [enableMinSalePrice, setEnableMinSalePrice] = useState(true);
  const [enableQuickSale, setEnableQuickSale] = useState(true);
  const [allowMixedPayment, setAllowMixedPayment] = useState(true);
  const [enableSellerAttribution, setEnableSellerAttribution] = useState(false);
  const [requireSellerSelection, setRequireSellerSelection] = useState(false);
  const [ticketTemplate, setTicketTemplate] = useState<'standard' | 'compact'>('standard');
  const [isSavingBiz, setIsSavingBiz] = useState(false);
  const [branchModalVisible, setBranchModalVisible] = useState(false);

  // ============================================================================
  // ESTADOS: PAGOS DIGITALES (YAPE / PLIN / QR) Y MÉTODOS DE PAGO
  // ============================================================================
  const [yapeNumber, setYapeNumber] = useState('');
  const [yapeHolder, setYapeHolder] = useState('');
  const [paymentMethodsDraft, setPaymentMethodsDraft] = useState<PosPaymentMethodConfig[]>([]);
  const [defaultMethodId, setDefaultMethodId] = useState('efectivo');
  const [uploadingMethodId, setUploadingMethodId] = useState<string | null>(null);
  const [isSavingPayments, setIsSavingPayments] = useState(false);

  // ============================================================================
  // ESTADOS: NOTIFICACIONES IN-APP Y PREFERENCIAS
  // ============================================================================
  const [notifPermStatus, setNotifPermStatus] = useState<string>('undetermined');
  const [expoPushStatus, setExpoPushStatus] = useState<string | null>(null);
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefsState>(DEFAULT_NOTIF_PREFS);
  const [isSavingNotifPrefs, setIsSavingNotifPrefs] = useState(false);
  const [accountNotifications, setAccountNotifications] = useState<AccountNotification[]>([]);
  const [notifInboxError, setNotifInboxError] = useState<string | null>(null);

  // ============================================================================
  // ESTADOS: PROMOCIONES Y REGALOS (`settings/${accountId}_discounts`)
  // ============================================================================
  const [enableGifts, setEnableGifts] = useState(true);
  const [giftProductIds, setGiftProductIds] = useState<string[]>([]);
  const [promotionsList, setPromotionsList] = useState<any[]>([]);
  const [giftSearch, setGiftSearch] = useState('');
  const [isSavingDiscounts, setIsSavingDiscounts] = useState(false);

  // ============================================================================
  // EFECTOS DE CARGA E INICIALIZACIÓN
  // ============================================================================
  useEffect(() => {
    getPrinterConfig().then(setPrinterConfig).catch(() => {});
    getNotificationPermissionStatus().then((st) => setNotifPermStatus(String(st))).catch(() => {});
  }, []);

  useEffect(() => {
    const biz = businessData || businessSettings;
    if (biz) {
      setBizName(biz.businessName || '');
      setBizRuc(biz.ruc || '');
      setBizAddress(biz.address || '');
      setBizPhone(biz.phone || '');
      setBizEmail(biz.email || '');
      setBizDescription(biz.description || '');
      setEnableMinSalePrice(biz.enableMinSalePrice !== false);
      setIsAmazonExempt(Boolean(biz.isAmazonExempt ?? taxProfile.isAmazonExempt));
      setTaxRateChoice(Number(biz.taxRate ?? taxProfile.taxRate) === 10 ? 10 : 18);
    }

    if (posSettings) {
      const yapeMethod = posSettings.methods?.find((m) => m.id === 'yape' || m.provider === 'yape');
      setYapeNumber(posSettings.digitalPhone || yapeMethod?.qrLabel || '');
      setYapeHolder(posSettings.digitalName || '');
      setTicketFooter(
        posSettings.ticketFooterMessage ||
          biz?.receiptFooter ||
          activeBranch?.receiptFooter ||
          ''
      );
      setEnableQuickSale(posSettings.enableQuickSale !== false);
      setAllowMixedPayment(posSettings.allowMixedPayment !== false);
      setEnableSellerAttribution(posSettings.enableSellerAttribution === true);
      setRequireSellerSelection(posSettings.requireSellerSelection === true);
      setTicketTemplate(posSettings.ticketTemplate === 'compact' ? 'compact' : 'standard');
      setDefaultMethodId(posSettings.defaultMethodId || 'efectivo');
    } else if (activeBranch?.receiptFooter) {
      setTicketFooter(activeBranch.receiptFooter);
    }
  }, [businessData, businessSettings, posSettings, activeBranch, taxProfile]);

  useEffect(() => {
    if (Array.isArray(posSettings?.methods) && posSettings.methods.length > 0) {
      setPaymentMethodsDraft(posSettings.methods);
    } else if (allPaymentMethods.length > 0) {
      setPaymentMethodsDraft(allPaymentMethods);
    }
  }, [posSettings?.methods, allPaymentMethods]);

  const loadPlanStatus = useCallback(async () => {
    if (!accountId || !isOnline || role === 'seller') return;
    setPlanState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await apiRequest<{ subscription: any; limits: any }>(
        `/api/plan-limits/${encodeURIComponent(accountId)}`
      );
      setPlanState({
        loading: false,
        error: null,
        subscription: data.subscription || null,
        limits: data.limits || null,
      });
    } catch (err: any) {
      setPlanState((prev) => ({
        ...prev,
        loading: false,
        error: err?.message || 'No se pudo consultar el estado del plan.',
      }));
    }
  }, [accountId, isOnline, role]);

  useEffect(() => {
    void loadPlanStatus();
  }, [loadPlanStatus]);

  // Cargar ajustes de gastos (`settings/${accountId}_expenses`), notificaciones y regalos
  useEffect(() => {
    if (!accountId) return;
    let active = true;

    const loadExtraSettingsDocs = async () => {
      try {
        const [expSnap, notifSnap, discSnap] = await Promise.all([
          getDoc(doc(db, 'settings', `${accountId}_expenses`)).catch(() => null),
          getDoc(doc(db, 'settings', `${accountId}_notifications`)).catch(() => null),
          getDoc(doc(db, 'settings', `${accountId}_discounts`)).catch(() => null),
        ]);

        if (!active) return;

        if (expSnap?.exists()) {
          const eData = expSnap.data() || {};
          setCashierExpenseLimitStr(String(Number(eData.cashierExpenseLimit ?? 0)));
          setSuggestedMarginStr(String(Number(eData.suggestedMarginPercent ?? 25)));
          setHasExpensePin(Boolean(eData.authorizationPinHash));
        }

        if (notifSnap?.exists()) {
          const nData = notifSnap.data() || {};
          setNotifPrefs({
            pushNotifications: nData.pushNotifications !== false,
            emailNotifications: nData.emailNotifications !== false,
            stockAlerts: nData.stockAlerts !== false,
            quoteAlerts: nData.quoteAlerts !== false,
            reservationAlerts: nData.reservationAlerts !== false,
            cashRegisterAlerts: nData.cashRegisterAlerts !== false,
            aiInsightsAlerts: nData.aiInsightsAlerts !== false,
            alertThreshold: String(Number(nData.alertThreshold ?? nData.stockThreshold ?? 5)),
          });
        }

        if (discSnap?.exists()) {
          const dData = discSnap.data() || {};
          setEnableGifts(dData.enableGifts !== false);
          setGiftProductIds(Array.isArray(dData.giftProductIds) ? dData.giftProductIds : []);
          setPromotionsList(Array.isArray(dData.promotions) ? dData.promotions : []);
        } else {
          const legacySnap = await getDoc(doc(db, 'discount_settings', accountId)).catch(() => null);
          if (active && legacySnap?.exists()) {
            const lData = legacySnap.data() || {};
            setEnableGifts(lData.enableGifts !== false);
            setGiftProductIds(Array.isArray(lData.giftProductIds) ? lData.giftProductIds : []);
            setPromotionsList(Array.isArray(lData.promotions) ? lData.promotions : []);
          }
        }
      } catch (err) {
        console.warn('[Settings] Error loading account settings docs:', err);
      }
    };

    void loadExtraSettingsDocs();
    return () => {
      active = false;
    };
  }, [accountId]);

  // Suscripción en vivo a `account_notifications`
  useEffect(() => {
    if (!accountId) return;
    setNotifInboxError(null);
    const unsub = subscribeAccountNotifications(
      accountId,
      branchId,
      (items) => {
        setAccountNotifications(items);
      },
      (err) => {
        setNotifInboxError(err.message);
      }
    );
    return () => unsub();
  }, [accountId, branchId]);

  // Cargar cola offline y cuarentena
  const loadOfflineData = useCallback(async () => {
    try {
      const [queue, quarantined] = await Promise.all([
        getOfflineQueue(),
        getQuarantinedSales(),
      ]);
      setOfflineSales(queue);
      setQuarantinedSales(quarantined);
    } catch (err) {
      console.error('Error cargando estado offline:', err);
    }
  }, []);

  useEffect(() => {
    void loadOfflineData();
  }, [loadOfflineData, offlineQueueCount]);

  // ============================================================================
  // ACCIONES: IMPRESORA TÉRMICA Y COLA OFFLINE
  // ============================================================================
  const handleRequestBtPermission = async () => {
    setBtPermissionChecking(true);
    try {
      const res = await requestBluetoothPermissions();
      Alert.alert(
        res.granted ? 'Permisos Concedidos' : 'Permiso Requerido',
        res.granted
          ? 'Los permisos de Bluetooth están activos para escanear e imprimir.'
          : res.message || 'Habilita "Dispositivos cercanos" en los Ajustes del sistema.'
      );
    } finally {
      setBtPermissionChecking(false);
    }
  };

  const handleScanPrinters = async () => {
    setIsScanningPrinters(true);
    try {
      const devices = await scanBluetoothPrinters();
      setScannedPrinters(devices);
      setPrinterScanModalVisible(true);
    } catch (err: any) {
      Alert.alert(
        'Escaneo Bluetooth',
        err?.message || 'No se pudieron buscar dispositivos Bluetooth.'
      );
    } finally {
      setIsScanningPrinters(false);
    }
  };

  const handleSelectPrinterDevice = async (device: BluetoothPrinterDevice) => {
    const updated: PrinterConfig = {
      ...printerConfig,
      selectedDevice: device,
      connectionType: 'bluetooth',
    };
    setPrinterConfig(updated);
    await savePrinterConfig(updated);
    setPrinterScanModalVisible(false);
    Alert.alert('Impresora Seleccionada', `Vinculado a ${device.name} (${device.address}).`);
  };

  const handleUpdatePrinterSetting = async <K extends keyof PrinterConfig>(
    key: K,
    val: PrinterConfig[K]
  ) => {
    const updated = { ...printerConfig, [key]: val };
    setPrinterConfig(updated);
    await savePrinterConfig(updated);
  };

  const handleTestBluetoothConnection = async () => {
    setIsPrintingTest(true);
    try {
      const res = await testPrinterConnection(printerConfig.selectedDevice?.address);
      Alert.alert(res.success ? 'Prueba Exitosa' : 'Error de Conexión', res.message);
    } finally {
      setIsPrintingTest(false);
    }
  };

  const handlePrintTestPdf = async () => {
    setIsPrintingTest(true);
    try {
      const demoRate = taxProfile.isAmazonExempt ? 0 : taxProfile.taxRate;
      const divisor = 1 + demoRate / 100;
      const total = 40.0;
      const subtotal = Math.round((total / divisor) * 100) / 100;
      const tax = Math.round((total - subtotal) * 100) / 100;

      const demoSale: any = {
        id: 'test_ticket',
        saleNumber: 9999,
        documentType: 'boleta',
        documentNumber: 'B001-00000001',
        date: Date.now(),
        customerName: 'VENTIFY DEMO S.A.C.',
        customerDni: '20611526572',
        paymentMethod: 'efectivo',
        cashReceived: 50,
        changeGiven: 10,
        subtotal,
        tax,
        total,
        items: [
          {
            id: 'item_1',
            productId: 'p_1',
            name: 'Ticket de Prueba Ventify',
            quantity: 1,
            unitOfMeasure: 'UND',
            price: 40.0,
            lineTotal: 40.0,
          },
        ],
      };

      await printTicketPDF(
        {
          title: 'Prueba de Impresión',
          sale: demoSale,
          business: { ...businessSettings, ...activeBranch },
          options: {
            paperWidth: printerConfig.paperWidth,
            branch: activeBranch,
            taxProfile,
            receiptFooter: ticketFooter || posSettings?.ticketFooterMessage || '¡Gracias por su compra!',
          },
        },
        {
          paperWidth: printerConfig.paperWidth,
          branch: activeBranch,
          taxProfile,
          receiptFooter: ticketFooter || posSettings?.ticketFooterMessage || '¡Gracias por su compra!',
        }
      );
    } catch (err: any) {
      Alert.alert('Error de Impresión PDF', err?.message || 'No se pudo generar el PDF.');
    } finally {
      setIsPrintingTest(false);
    }
  };

  const handleForceSync = async () => {
    setIsSyncingOffline(true);
    try {
      const result = await processOfflineQueue(accountId || undefined);
      await loadOfflineData();
      await refreshOfflineCount();

      if (result.total === 0) {
        Alert.alert('Sincronización', 'No hay ventas pendientes en la cola.');
      } else {
        Alert.alert(
          'Sincronización Completada',
          `Procesadas: ${result.processed}/${result.total}\nExitosas: ${result.successful}\nEn cuarentena: ${result.quarantined}`
        );
      }
    } catch (err: any) {
      Alert.alert('Error al Sincronizar', err?.message || 'Falló el proceso de cola offline.');
    } finally {
      setIsSyncingOffline(false);
    }
  };

  const handleRetryQuarantined = async (saleId: string) => {
    try {
      await retryQuarantinedSale(saleId);
      await loadOfflineData();
      await refreshOfflineCount();
      Alert.alert('Reintento Encolado', 'La venta volvió a la cola de sincronización.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo reencolar la venta.');
    }
  };

  const handleRemoveQuarantined = async (saleId: string) => {
    Alert.alert(
      'Descartar Venta en Cuarentena',
      'Esta acción eliminará la venta fallida de la cola local permanentemente.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar',
          style: 'destructive',
          onPress: async () => {
            await removeQuarantinedSale(saleId);
            await loadOfflineData();
            await refreshOfflineCount();
          },
        },
      ]
    );
  };

  // ============================================================================
  // ACCIONES: NEGOCIO, PIE DE TICKET, IMPUESTOS Y POS
  // ============================================================================
  const handleSaveBusinessData = async () => {
    if (!canManageSettings) {
      Alert.alert(
        'Acceso Denegado',
        'Solo administradores o propietarios pueden modificar los datos fiscales y del POS.'
      );
      return;
    }

    if (!bizName.trim()) {
      Alert.alert('Nombre Requerido', 'La razón social no puede estar vacía.');
      return;
    }
    if (bizRuc.trim() && !/^\d{11}$/.test(bizRuc.trim())) {
      Alert.alert('RUC Inválido', 'El RUC debe tener exactamente 11 dígitos numéricos.');
      return;
    }

    setIsSavingBiz(true);
    try {
      await Promise.all([
        updateBusinessData({
          businessName: bizName.trim(),
          ruc: bizRuc.trim(),
          address: bizAddress.trim(),
          phone: bizPhone.trim(),
          email: bizEmail.trim(),
          description: bizDescription.trim(),
          receiptFooter: ticketFooter.trim(),
          enableMinSalePrice,
          isAmazonExempt,
          taxExemptionCode: isAmazonExempt ? '20' : '10',
          taxRate: isAmazonExempt ? 0 : taxRateChoice,
        }),
        updatePosSettings({
          ticketFooterMessage: ticketFooter.trim(),
          enableQuickSale,
          allowMixedPayment,
          enableSellerAttribution,
          requireSellerSelection: enableSellerAttribution ? requireSellerSelection : false,
          ticketTemplate,
        }),
      ]);

      Alert.alert(
        'Ajustes Guardados',
        'La información del negocio, pie de ticket y preferencias del POS han sido actualizados.'
      );
    } catch (err: any) {
      Alert.alert('Error al Guardar', err?.message || 'No se pudieron actualizar los ajustes.');
    } finally {
      setIsSavingBiz(false);
    }
  };

  // ============================================================================
  // ACCIONES: YAPE / PLIN QR UPLOAD & MÉTODOS DE PAGO
  // ============================================================================
  const updateDraftMethod = (methodId: string, patch: Partial<PosPaymentMethodConfig>) => {
    setPaymentMethodsDraft((prev) =>
      prev.map((m) => (m.id === methodId ? { ...m, ...patch } : m))
    );
  };

  const handleUploadMethodQr = async (methodId: string) => {
    if (!canManageSettings || !accountId) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      setUploadingMethodId(methodId);

      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const rawName = asset.fileName || asset.uri.split('/').pop() || 'qr.jpg';
      const ext = (rawName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const mime = asset.mimeType || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');

      // `storage.rules` permite lectura pública y escritura autenticado bajo `products/{accountId}/{file}`
      const objectPath = `products/${accountId}/qr_${methodId}_${Date.now()}.${ext}`;
      const storage = getStorage(app);
      const fileRef = storageRef(storage, objectPath);
      await uploadBytes(fileRef, blob, { contentType: mime });
      const downloadUrl = await getDownloadURL(fileRef);

      const nextMethods = paymentMethodsDraft.map((m) =>
        m.id === methodId ? { ...m, qrUrl: downloadUrl } : m
      );
      setPaymentMethodsDraft(nextMethods);
      await updatePosSettings({ methods: nextMethods });

      Alert.alert('QR Actualizado', 'El código QR se subió correctamente y ya está activo en caja.');
    } catch (err: any) {
      Alert.alert(
        'Error al Subir QR',
        err?.message || 'No se pudo subir la imagen del QR. También puedes pegar una URL directa.'
      );
    } finally {
      setUploadingMethodId(null);
    }
  };

  const handleSavePayments = async () => {
    if (!canManageSettings) {
      Alert.alert('Acceso Denegado', 'Solo administradores pueden editar métodos de pago.');
      return;
    }

    setIsSavingPayments(true);
    try {
      const cleanNumber = yapeNumber.trim();
      const cleanHolder = yapeHolder.trim();

      const updatedMethods = paymentMethodsDraft.map((m) => {
        if (m.id === 'yape' || m.id === 'plin' || m.provider === 'yape' || m.provider === 'plin') {
          return {
            ...m,
            qrLabel: cleanNumber || m.qrLabel || '',
          };
        }
        return m;
      });

      await updatePosSettings({
        digitalPhone: cleanNumber,
        digitalName: cleanHolder,
        allowMixedPayment,
        defaultMethodId,
        methods: updatedMethods,
      });

      Alert.alert(
        'Cobros Actualizados',
        'Los datos de Yape/Plin (número, titular, QR) y métodos de pago se guardaron correctamente.'
      );
    } catch (err: any) {
      Alert.alert('Error al Guardar', err?.message || 'No se pudieron guardar los métodos de pago.');
    } finally {
      setIsSavingPayments(false);
    }
  };

  // ============================================================================
  // ACCIONES: SEGURIDAD (PIN TERMINAL + PIN AUTORIZACIÓN DE EGRESOS)
  // ============================================================================
  const handleChangeTerminalPin = async () => {
    if (!/^\d{4,8}$/.test(newPinInput)) {
      Alert.alert('PIN Inválido', 'El PIN del terminal debe tener entre 4 y 8 dígitos numéricos.');
      return;
    }
    if (newPinInput !== confirmPinInput) {
      Alert.alert('No Coincide', 'La confirmación del PIN no coincide.');
      return;
    }

    setIsUpdatingPin(true);
    try {
      await updatePinCode(newPinInput);
      setPinModalVisible(false);
      setNewPinInput('');
      setConfirmPinInput('');
      Alert.alert('PIN Actualizado', `El PIN de bloqueo rápido (${newPinInput.length} dígitos) fue configurado.`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo actualizar el PIN.');
    } finally {
      setIsUpdatingPin(false);
    }
  };

  const handleSaveExpenseLimits = async () => {
    if (!canManageSettings || !accountId) return;
    const limit = Number(cashierExpenseLimitStr);
    const margin = Number(suggestedMarginStr);
    if (!Number.isFinite(limit) || limit < 0) {
      Alert.alert('Tope Inválido', 'Ingresa 0 (sin límite) o un monto positivo.');
      return;
    }
    if (!Number.isFinite(margin) || margin <= 0 || margin > 500) {
      Alert.alert('Margen Inválido', 'Ingresa un porcentaje de margen entre 1 y 500.');
      return;
    }

    setIsSavingExpenseConfig(true);
    try {
      await setDoc(
        doc(db, 'settings', `${accountId}_expenses`),
        {
          accountId,
          cashierExpenseLimit: limit,
          suggestedMarginPercent: margin,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      Alert.alert(
        'Límites Guardados',
        'El tope de egresos se aplicará a las próximas aperturas de caja.'
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar la configuración de egresos.');
    } finally {
      setIsSavingExpenseConfig(false);
    }
  };

  const handleSaveExpenseAuthPin = async () => {
    if (!canManageSettings || !accountId) return;
    if (!/^\d{4,8}$/.test(expensePinInput)) {
      Alert.alert('PIN Inválido', 'El PIN de egresos debe tener entre 4 y 8 dígitos numéricos.');
      return;
    }
    if (expensePinInput !== expensePinConfirm) {
      Alert.alert('PIN no Coincide', 'Ambos campos del PIN de autorización deben ser iguales.');
      return;
    }

    setIsUpdatingExpensePin(true);
    try {
      await apiRequest<{ success: boolean }>('/api/expenses/pin', {
        method: 'POST',
        body: { accountId, pin: expensePinInput },
      });
      setHasExpensePin(true);
      setExpensePinInput('');
      setExpensePinConfirm('');
      Alert.alert(
        'PIN de Egresos Actualizado',
        'Los cajeros podrán usar este PIN para autorizar egresos sobre su límite.'
      );
    } catch (err: any) {
      Alert.alert(
        'Error al Guardar PIN',
        err?.message || 'No se pudo configurar el PIN de autorización de egresos.'
      );
    } finally {
      setIsUpdatingExpensePin(false);
    }
  };

  // ============================================================================
  // ACCIONES: NOTIFICACIONES Y BUZÓN IN-APP
  // ============================================================================
  const handleEnableNotifications = async () => {
    const granted = await initNotifications();
    const status = await getNotificationPermissionStatus();
    setNotifPermStatus(String(status));
    if (granted) {
      const token = await registerForPushNotificationsAsync();
      setExpoPushStatus(
        token
          ? 'Token Expo Push activo'
          : 'Notificaciones locales activas (sin EAS projectId para push remoto)'
      );
      Alert.alert('Notificaciones Activas', 'El terminal está listo para mostrar alertas.');
    } else {
      Alert.alert(
        'Permiso Denegado',
        'Habilita las notificaciones para Ventify POS en los Ajustes de tu dispositivo.'
      );
    }
  };

  const handleSendTestNotification = async () => {
    const id = await scheduleLocalNotification({
      title: '🔔 Ventify POS — Prueba de Alerta',
      body: 'Las notificaciones locales y canales de alerta están funcionando correctamente.',
      channelId: 'general_alerts',
      data: { type: 'system' },
    });
    if (id) {
      Alert.alert('Prueba Enviada', 'Revisa la barra de notificaciones de tu dispositivo.');
    } else {
      Alert.alert(
        'Sin Permiso',
        'Activa los permisos de notificación primero para recibir la alerta de prueba.'
      );
    }
  };

  const handleSaveNotifPrefs = async () => {
    if (!canManageSettings || !accountId) return;
    const threshold = Math.max(1, parseInt(notifPrefs.alertThreshold, 10) || 5);
    setIsSavingNotifPrefs(true);
    try {
      await setDoc(
        doc(db, 'settings', `${accountId}_notifications`),
        {
          accountId,
          pushNotifications: notifPrefs.pushNotifications,
          emailNotifications: notifPrefs.emailNotifications,
          stockAlerts: notifPrefs.stockAlerts,
          quoteAlerts: notifPrefs.quoteAlerts,
          reservationAlerts: notifPrefs.reservationAlerts,
          cashRegisterAlerts: notifPrefs.cashRegisterAlerts,
          aiInsightsAlerts: notifPrefs.aiInsightsAlerts,
          alertThreshold: threshold,
          stockThreshold: threshold,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      Alert.alert('Preferencias Guardadas', 'Las preferencias de alertas han sido actualizadas.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudieron guardar las preferencias de alertas.');
    } finally {
      setIsSavingNotifPrefs(false);
    }
  };

  const handleMarkNotificationRead = async (item: AccountNotification) => {
    if (item.read || !canManageSettings) return;
    try {
      await markNotificationAsRead(item.id);
    } catch (err: any) {
      console.warn('[Settings] Error marking notification read:', err);
    }
  };

  const handleMarkAllRead = async () => {
    if (!canManageSettings) return;
    const unreadIds = accountNotifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    try {
      await markAllNotificationsAsRead(unreadIds);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudieron marcar las notificaciones.');
    }
  };

  // ============================================================================
  // ACCIONES: PROMOCIONES Y REGALOS (`settings/${accountId}_discounts`)
  // ============================================================================
  const filteredGiftCatalog = useMemo(() => {
    const q = giftSearch.trim().toLowerCase();
    const activeProducts = products.filter((p) => p.active !== false);
    if (!q) return activeProducts.slice(0, 30);
    return activeProducts
      .filter(
        (p) =>
          (p.name || '').toLowerCase().includes(q) ||
          (p.sku || '').toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [products, giftSearch]);

  const toggleGiftProductId = (productId: string) => {
    if (!canManageSettings) return;
    setGiftProductIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const handleSaveDiscounts = async () => {
    if (!canManageSettings || !accountId) {
      Alert.alert('Acceso Denegado', 'Solo administradores pueden editar regalos y promociones.');
      return;
    }
    setIsSavingDiscounts(true);
    try {
      await setDoc(
        doc(db, 'settings', `${accountId}_discounts`),
        {
          accountId,
          enableGifts,
          giftProductIds,
          promotions: promotionsList,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      Alert.alert(
        'Regalos Actualizados',
        'La lista de productos elegibles como regalo se actualizó en el Punto de Venta.'
      );
    } catch (err: any) {
      Alert.alert('Error al Guardar', err?.message || 'No se pudo guardar la configuración de regalos.');
    } finally {
      setIsSavingDiscounts(false);
    }
  };

  // ============================================================================
  // ACCIÓN: CERRAR SESIÓN
  // ============================================================================
  const handleLogoutPress = () => {
    Alert.alert(
      '¿Cerrar Sesión?',
      'Se cerrará la sesión de este terminal móvil. ¿Deseas continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Cerrar Sesión',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  };

  const unreadNotifCount = useMemo(
    () => accountNotifications.filter((n) => !n.read).length,
    [accountNotifications]
  );

  const subStatusKey = String(planState.subscription?.status || '').toLowerCase();
  const subBadge = SUBSCRIPTION_BADGE_MAP[subStatusKey] || {
    label: planState.subscription?.status || 'Activo',
    bg: ui.primarySoft,
    color: ui.primary,
  };

  const openWebUrl = async (path: string) => {
    const target = path.startsWith('http') ? path : `${APP_URL.replace(/\/$/, '')}${path}`;
    try {
      await Linking.openURL(target);
    } catch {
      Alert.alert('Error', 'No se pudo abrir el enlace externo.');
    }
  };

  // ============================================================================
  // RENDERIZADO POR PESTAÑA
  // ============================================================================
  const renderNegocioTab = () => (
    <>
      {/* Suscripción y Enlaces Rápidos */}
      <SectionHeading title="Plan y Suscripción" subtitle="Estado de tu cuenta Ventify" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
            <Crown size={22} color={ui.accent} />
          </View>
          <View style={styles.cardHeaderText}>
            <View style={styles.inlineRow}>
              <Text style={styles.cardTitle}>
                {planState.subscription?.planName || 'Plan Ventify POS'}
              </Text>
              <View style={[styles.pillBadge, { backgroundColor: subBadge.bg }]}>
                <Text style={[styles.pillBadgeText, { color: subBadge.color }]}>
                  {subBadge.label}
                </Text>
              </View>
            </View>
            <Text style={styles.cardSubtitle}>
              {planState.loading
                ? 'Consultando estado de suscripción...'
                : planState.subscription?.daysRemaining === -1
                ? 'Suscripción sin límite de vigencia'
                : typeof planState.subscription?.daysRemaining === 'number'
                ? `${planState.subscription.daysRemaining} días restantes en el ciclo`
                : planState.error || 'Sincronizado con Ventify Cloud'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={loadPlanStatus}
            style={styles.iconActionBtn}
            accessibilityRole="button"
            accessibilityLabel="Actualizar estado del plan"
          >
            <RefreshCw size={18} color={ui.primary} />
          </TouchableOpacity>
        </View>

        {planState.limits ? (
          <View style={styles.limitsGrid}>
            {planState.limits.branches ? (
              <View style={styles.limitChip}>
                <Text style={styles.limitLabel}>Sucursales</Text>
                <Text style={styles.limitValue}>
                  {planState.limits.branches.current} /{' '}
                  {planState.limits.branches.max < 0 ? '∞' : planState.limits.branches.max}
                </Text>
              </View>
            ) : null}
            {planState.limits.users ? (
              <View style={styles.limitChip}>
                <Text style={styles.limitLabel}>Usuarios</Text>
                <Text style={styles.limitValue}>
                  {planState.limits.users.current} /{' '}
                  {planState.limits.users.max < 0 ? '∞' : planState.limits.users.max}
                </Text>
              </View>
            ) : null}
            {planState.limits.products ? (
              <View style={styles.limitChip}>
                <Text style={styles.limitLabel}>Productos</Text>
                <Text style={styles.limitValue}>
                  {planState.limits.products.current} /{' '}
                  {planState.limits.products.max < 0 ? '∞' : planState.limits.products.max}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.quickLinksRow}>
          <TouchableOpacity
            style={styles.quickLinkBtn}
            onPress={() => void openWebUrl('/settings')}
            accessibilityRole="button"
          >
            <ExternalLink size={15} color={ui.primary} />
            <Text style={styles.quickLinkText}>Panel Web</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickLinkBtn}
            onPress={() => void openWebUrl('/pricing')}
            accessibilityRole="button"
          >
            <Crown size={15} color={ui.primary} />
            <Text style={styles.quickLinkText}>Planes</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickLinkBtn}
            onPress={() => void openWebUrl('https://wa.me/51983495868')}
            accessibilityRole="button"
          >
            <Smartphone size={15} color={ui.success} />
            <Text style={[styles.quickLinkText, { color: ui.success }]}>Soporte</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Sucursal Activa */}
      <SectionHeading title="Sucursal" subtitle="Sede operativa del terminal" />
      <View style={styles.card}>
        <View style={styles.settingRow}>
          <View style={styles.flex1}>
            <Text style={styles.settingLabel}>Sucursal Activa</Text>
            <Text style={styles.settingSubtext}>{activeBranchName || 'Tienda Principal'}</Text>
          </View>
          {hasAllBranchesAccess && branches.length > 1 ? (
            <TouchableOpacity
              style={styles.secondaryOutlineBtn}
              onPress={() => setBranchModalVisible(true)}
              accessibilityRole="button"
            >
              <Store size={16} color={ui.primary} />
              <Text style={styles.secondaryOutlineBtnText}>Cambiar</Text>
            </TouchableOpacity>
          ) : (
            <Store size={20} color={ui.textSecondary} />
          )}
        </View>
      </View>

      {/* Datos Fiscales, Tributarios y Pie de Ticket */}
      <SectionHeading
        title="Empresa e Impuestos"
        subtitle={
          canManageSettings
            ? 'Información tributaria, IGV y comprobantes'
            : 'Solo administradores pueden editar estos datos'
        }
      />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
            <Building2 size={22} color={ui.primary} />
          </View>
          <View style={styles.cardHeaderText}>
            <View style={styles.inlineRow}>
              <Text style={styles.cardTitle}>Datos Fiscales & Tickets</Text>
              {!canManageSettings ? (
                <View style={[styles.pillBadge, { backgroundColor: ui.warningSoft }]}>
                  <Text style={[styles.pillBadgeText, { color: ui.warning }]}>Solo Lectura</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.cardSubtitle}>
              {invoicingEnabled
                ? `SUNAT Electrónica Activa${emitterInfo?.ruc ? ` · RUC Emisor ${emitterInfo.ruc}` : ''}`
                : 'Modo Notas de Venta y Cotizaciones'}
            </Text>
          </View>
        </View>

        <View style={styles.taxSummaryBox}>
          <Text style={styles.statusBoxLabel}>RÉGIMEN IGV ACTIVO</Text>
          <Text style={styles.statusBoxValue}>
            {taxProfile.isAmazonExempt
              ? 'Amazonía Exonerada (Ley 27037 · IGV 0%)'
              : `Régimen General Gravado · IGV ${taxProfile.taxRate}%`}
          </Text>
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Razón Social / Nombre Comercial *</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            placeholder="Ej. Comercial Los Andes S.A.C."
            placeholderTextColor={ui.textMuted}
            value={bizName}
            onChangeText={setBizName}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>RUC (11 Dígitos)</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            placeholder="20601234567"
            placeholderTextColor={ui.textMuted}
            keyboardType="numeric"
            maxLength={11}
            value={bizRuc}
            onChangeText={setBizRuc}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Dirección Fiscal</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            placeholder="Av. Aviación 1234, La Victoria"
            placeholderTextColor={ui.textMuted}
            value={bizAddress}
            onChangeText={setBizAddress}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Teléfono / WhatsApp de Contacto</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            placeholder="987654321"
            placeholderTextColor={ui.textMuted}
            keyboardType="phone-pad"
            value={bizPhone}
            onChangeText={setBizPhone}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Correo Electrónico</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            placeholder="contacto@minegocio.com"
            placeholderTextColor={ui.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            value={bizEmail}
            onChangeText={setBizEmail}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Descripción / Lema en Ticket (Opcional)</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            placeholder="Productos frescos todos los días"
            placeholderTextColor={ui.textMuted}
            value={bizDescription}
            onChangeText={setBizDescription}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Mensaje de Pie de Ticket</Text>
          <TextInput
            style={[styles.textInput, styles.textInputMultiline, !canManageSettings && styles.inputReadOnly]}
            placeholder="¡Gracias por su compra! Cambios dentro de 7 días con comprobante."
            placeholderTextColor={ui.textMuted}
            value={ticketFooter}
            onChangeText={setTicketFooter}
            multiline
            numberOfLines={2}
            editable={canManageSettings}
            accessibilityLabel="Mensaje de pie de ticket"
          />
        </View>

        {/* Configuración tributaria y POS */}
        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Exonerado Amazonía (Ley 27037)</Text>
            <Text style={styles.switchSubtitle}>Emite comprobantes con código tributario 20 (0% IGV)</Text>
          </View>
          <Switch
            value={isAmazonExempt}
            onValueChange={setIsAmazonExempt}
            disabled={!canManageSettings}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        {!isAmazonExempt ? (
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Tasa de IGV</Text>
            <View style={styles.segmentControl}>
              <TouchableOpacity
                style={[styles.segmentBtn, taxRateChoice === 18 && styles.segmentBtnActive]}
                onPress={() => canManageSettings && setTaxRateChoice(18)}
                disabled={!canManageSettings}
              >
                <Text style={[styles.segmentText, taxRateChoice === 18 && styles.segmentTextActive]}>
                  18% General
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentBtn, taxRateChoice === 10 && styles.segmentBtnActive]}
                onPress={() => canManageSettings && setTaxRateChoice(10)}
                disabled={!canManageSettings}
              >
                <Text style={[styles.segmentText, taxRateChoice === 10 && styles.segmentTextActive]}>
                  10% MYPE
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Precio Mínimo Personalizado</Text>
            <Text style={styles.switchSubtitle}>Protege márgenes evitando ventas debajo del mínimo</Text>
          </View>
          <Switch
            value={enableMinSalePrice}
            onValueChange={setEnableMinSalePrice}
            disabled={!canManageSettings}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Venta Rápida en Efectivo</Text>
            <Text style={styles.switchSubtitle}>Permite cobrar monto exacto en un toque</Text>
          </View>
          <Switch
            value={enableQuickSale}
            onValueChange={setEnableQuickSale}
            disabled={!canManageSettings}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Asignar Vendedor al Cobrar</Text>
            <Text style={styles.switchSubtitle}>Muestra selector de asesor en el Checkout</Text>
          </View>
          <Switch
            value={enableSellerAttribution}
            onValueChange={(v) => {
              setEnableSellerAttribution(v);
              if (!v) setRequireSellerSelection(false);
            }}
            disabled={!canManageSettings}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        {enableSellerAttribution ? (
          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Vendedor Obligatorio</Text>
              <Text style={styles.switchSubtitle}>Exige elegir un vendedor antes de completar la venta</Text>
            </View>
            <Switch
              value={requireSellerSelection}
              onValueChange={setRequireSellerSelection}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>
        ) : null}

        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Plantilla de Ticket</Text>
          <View style={styles.segmentControl}>
            <TouchableOpacity
              style={[styles.segmentBtn, ticketTemplate === 'standard' && styles.segmentBtnActive]}
              onPress={() => canManageSettings && setTicketTemplate('standard')}
              disabled={!canManageSettings}
            >
              <Text style={[styles.segmentText, ticketTemplate === 'standard' && styles.segmentTextActive]}>
                Estándar
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentBtn, ticketTemplate === 'compact' && styles.segmentBtnActive]}
              onPress={() => canManageSettings && setTicketTemplate('compact')}
              disabled={!canManageSettings}
            >
              <Text style={[styles.segmentText, ticketTemplate === 'compact' && styles.segmentTextActive]}>
                Compacto
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {canManageSettings ? (
          <TouchableOpacity
            style={[styles.saveButton, isSavingBiz && styles.buttonDisabled]}
            onPress={handleSaveBusinessData}
            disabled={isSavingBiz}
          >
            {isSavingBiz ? (
              <ActivityIndicator color={ui.onPrimary} />
            ) : (
              <>
                <Save size={18} color={ui.onPrimary} />
                <Text style={styles.saveButtonText}>Guardar Negocio y Tickets</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );

  const renderPagosTab = () => {
    const digitalMethods = paymentMethodsDraft.filter((m) => m.kind === 'digital');
    return (
      <>
        <SectionHeading
          title="Cobros Digitales (Yape / Plin)"
          subtitle="Número, titular y código QR visibles al cobrar"
        />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
              <QrCode size={22} color={ui.accent} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Yape / Plin en Caja</Text>
              <Text style={styles.cardSubtitle}>
                Los datos del titular se guardan en digitalName sin alterar terminales
              </Text>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Número de Celular Yape / Plin</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="987654321"
              placeholderTextColor={ui.textMuted}
              keyboardType="phone-pad"
              value={yapeNumber}
              onChangeText={setYapeNumber}
              editable={canManageSettings}
              accessibilityLabel="Número de celular Yape o Plin"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Titular de la Cuenta Digital</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="Ej. Comercial Los Andes S.A.C."
              placeholderTextColor={ui.textMuted}
              value={yapeHolder}
              onChangeText={setYapeHolder}
              editable={canManageSettings}
              accessibilityLabel="Titular de la cuenta digital"
            />
          </View>

          {digitalMethods.map((m) => {
            const isUploading = uploadingMethodId === m.id;
            return (
              <View key={m.id} style={styles.qrMethodBox}>
                <View style={styles.inlineBetween}>
                  <Text style={styles.digitalPayTitle}>QR {m.name}</Text>
                  {m.qrUrl && canManageSettings ? (
                    <TouchableOpacity
                      onPress={() => updateDraftMethod(m.id, { qrUrl: '' })}
                      style={styles.iconActionBtn}
                      accessibilityLabel={`Quitar QR de ${m.name}`}
                    >
                      <Trash2 size={16} color={ui.danger} />
                    </TouchableOpacity>
                  ) : null}
                </View>

                <View style={styles.qrPreviewRow}>
                  {m.qrUrl ? (
                    <Image
                      source={{ uri: m.qrUrl }}
                      style={styles.qrPreviewImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={styles.qrPlaceholder}>
                      <QrCode size={26} color={ui.textMuted} />
                    </View>
                  )}

                  <View style={styles.flex1}>
                    {canManageSettings ? (
                      <TouchableOpacity
                        style={styles.secondaryOutlineBtn}
                        onPress={() => void handleUploadMethodQr(m.id)}
                        disabled={isUploading}
                      >
                        {isUploading ? (
                          <ActivityIndicator size="small" color={ui.primary} />
                        ) : (
                          <>
                            <ImagePlus size={16} color={ui.primary} />
                            <Text style={styles.secondaryOutlineBtnText}>
                              {m.qrUrl ? 'Reemplazar desde Galería' : 'Subir QR desde Galería'}
                            </Text>
                          </>
                        )}
                      </TouchableOpacity>
                    ) : null}
                    <TextInput
                      style={[styles.textInput, styles.qrUrlInput, !canManageSettings && styles.inputReadOnly]}
                      placeholder="O pega URL directa del QR (https://...)"
                      placeholderTextColor={ui.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={m.qrUrl || ''}
                      onChangeText={(txt) => updateDraftMethod(m.id, { qrUrl: txt })}
                      editable={canManageSettings}
                    />
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        <SectionHeading title="Métodos de Pago" subtitle="Activa los medios aceptados en caja" />
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Permitir Pagos Mixtos</Text>
              <Text style={styles.switchSubtitle}>Dividir cobro entre efectivo, Yape, Plin o tarjeta</Text>
            </View>
            <Switch
              value={allowMixedPayment}
              onValueChange={setAllowMixedPayment}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          {paymentMethodsDraft
            .filter((m) => m.kind !== 'mixed')
            .map((m) => {
              const isDefault = defaultMethodId === m.id;
              return (
                <View key={m.id} style={styles.switchRow}>
                  <TouchableOpacity
                    style={styles.flex1}
                    onPress={() => canManageSettings && m.enabled && setDefaultMethodId(m.id)}
                    disabled={!canManageSettings || !m.enabled}
                  >
                    <View style={styles.inlineRow}>
                      <CreditCard size={16} color={m.enabled ? ui.primary : ui.textMuted} />
                      <Text style={styles.switchTitle}>{m.name}</Text>
                      {isDefault ? (
                        <View style={[styles.pillBadge, { backgroundColor: ui.primarySoft }]}>
                          <Text style={[styles.pillBadgeText, { color: ui.primary }]}>Por defecto</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.switchSubtitle}>
                      Categoría: {m.reportCategory.toUpperCase()}
                      {m.terminalName ? ` · ${m.terminalName}` : ''}
                    </Text>
                  </TouchableOpacity>
                  <Switch
                    value={m.enabled !== false}
                    onValueChange={(enabled) => updateDraftMethod(m.id, { enabled })}
                    disabled={!canManageSettings}
                    trackColor={{ false: ui.border, true: ui.primary }}
                  />
                </View>
              );
            })}

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.saveButton, isSavingPayments && styles.buttonDisabled]}
              onPress={handleSavePayments}
              disabled={isSavingPayments}
            >
              {isSavingPayments ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Save size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>Guardar Métodos y QR</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </>
    );
  };

  const renderImpresoraTab = () => (
    <>
      <SectionHeading title="Impresora Térmica" subtitle="Bluetooth ESC/POS y PDF del sistema" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
            <Printer size={22} color={ui.primary} />
          </View>
          <View style={styles.cardHeaderText}>
            <Text style={styles.cardTitle}>Impresora Térmica Bluetooth</Text>
            <Text style={styles.cardSubtitle}>Tickets ESC/POS 58mm y 80mm</Text>
          </View>
        </View>

        <View style={styles.statusBox}>
          <View style={styles.flex1}>
            <Text style={styles.statusBoxLabel}>DISPOSITIVO VINCULADO</Text>
            <Text style={styles.statusBoxValue}>
              {printerConfig.selectedDevice
                ? `${printerConfig.selectedDevice.name} (${printerConfig.selectedDevice.address})`
                : 'Ninguna impresora vinculada'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.scanButton}
            onPress={handleScanPrinters}
            disabled={isScanningPrinters}
          >
            {isScanningPrinters ? (
              <ActivityIndicator color={ui.onPrimary} size="small" />
            ) : (
              <>
                <Bluetooth size={16} color={ui.onPrimary} />
                <Text style={styles.scanButtonText}>Escanear</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {Platform.OS === 'android' ? (
          <TouchableOpacity
            style={styles.secondaryOutlineBtn}
            onPress={handleRequestBtPermission}
            disabled={btPermissionChecking}
          >
            {btPermissionChecking ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <>
                <Shield size={16} color={ui.primary} />
                <Text style={styles.secondaryOutlineBtnText}>
                  Verificar Permisos Bluetooth (Android 12+)
                </Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}

        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Ancho de Papel</Text>
          <View style={styles.segmentControl}>
            <TouchableOpacity
              style={[styles.segmentBtn, printerConfig.paperWidth === 58 && styles.segmentBtnActive]}
              onPress={() => void handleUpdatePrinterSetting('paperWidth', 58)}
            >
              <Text style={[styles.segmentText, printerConfig.paperWidth === 58 && styles.segmentTextActive]}>
                58 mm
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentBtn, printerConfig.paperWidth === 80 && styles.segmentBtnActive]}
              onPress={() => void handleUpdatePrinterSetting('paperWidth', 80)}
            >
              <Text style={[styles.segmentText, printerConfig.paperWidth === 80 && styles.segmentTextActive]}>
                80 mm
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Modo de Salida</Text>
          <View style={styles.segmentControl}>
            <TouchableOpacity
              style={[styles.segmentBtn, printerConfig.connectionType === 'bluetooth' && styles.segmentBtnActive]}
              onPress={() => void handleUpdatePrinterSetting('connectionType', 'bluetooth')}
            >
              <Text style={[styles.segmentText, printerConfig.connectionType === 'bluetooth' && styles.segmentTextActive]}>
                Bluetooth
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentBtn, printerConfig.connectionType === 'system_pdf' && styles.segmentBtnActive]}
              onPress={() => void handleUpdatePrinterSetting('connectionType', 'system_pdf')}
            >
              <Text style={[styles.segmentText, printerConfig.connectionType === 'system_pdf' && styles.segmentTextActive]}>
                PDF / Sistema
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Corte Automático de Papel</Text>
            <Text style={styles.switchSubtitle}>Comando ESC/POS GS V al finalizar</Text>
          </View>
          <Switch
            value={printerConfig.autoCut}
            onValueChange={(val) => void handleUpdatePrinterSetting('autoCut', val)}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Apertura de Gaveta de Dinero</Text>
            <Text style={styles.switchSubtitle}>Pulso ESC p en ventas en efectivo y Cierre Z</Text>
          </View>
          <Switch
            value={printerConfig.openCashDrawer}
            onValueChange={(val) => void handleUpdatePrinterSetting('openCashDrawer', val)}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        <View style={styles.actionButtonGroup}>
          <TouchableOpacity
            style={[styles.testPrintBtn, styles.flex1]}
            onPress={handleTestBluetoothConnection}
            disabled={isPrintingTest}
          >
            {isPrintingTest ? (
              <ActivityIndicator color={ui.primary} />
            ) : (
              <>
                <Bluetooth size={16} color={ui.primary} />
                <Text style={styles.testPrintText}>Probar BT</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.testPrintBtn, styles.flex1]}
            onPress={handlePrintTestPdf}
            disabled={isPrintingTest}
          >
            {isPrintingTest ? (
              <ActivityIndicator color={ui.primary} />
            ) : (
              <>
                <FileText size={16} color={ui.primary} />
                <Text style={styles.testPrintText}>Probar PDF</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Cola Offline */}
      <SectionHeading title="Sincronización Offline" subtitle="Resiliencia ante pérdida de red" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View
            style={[
              styles.iconBadge,
              { backgroundColor: isOnline ? ui.primarySoft : ui.warningSoft },
            ]}
          >
            {isOnline ? (
              <Wifi size={22} color={ui.primary} />
            ) : (
              <WifiOff size={22} color={ui.warning} />
            )}
          </View>
          <View style={styles.cardHeaderText}>
            <Text style={styles.cardTitle}>Cola Offline y Cuarentena</Text>
            <Text style={styles.cardSubtitle}>
              {isOnline ? 'En Línea (Sincronización Activa)' : 'Modo Offline (Guardando Localmente)'}
            </Text>
          </View>
        </View>

        <View style={styles.offlineStatsRow}>
          <View style={styles.offlineStatBox}>
            <Text style={styles.statLabel}>Ventas en Cola</Text>
            <Text style={[styles.statValue, { color: ui.primary }]}>{offlineSales.length}</Text>
          </View>
          <View style={styles.offlineStatBox}>
            <Text style={styles.statLabel}>En Cuarentena</Text>
            <Text style={[styles.statValue, { color: ui.danger }]}>{quarantinedSales.length}</Text>
          </View>
        </View>

        <View style={styles.actionButtonGroup}>
          <TouchableOpacity
            style={[styles.syncButton, styles.flex1, isSyncingOffline && styles.buttonDisabled]}
            onPress={handleForceSync}
            disabled={isSyncingOffline}
          >
            {isSyncingOffline ? (
              <ActivityIndicator color={ui.onPrimary} />
            ) : (
              <>
                <RefreshCw size={16} color={ui.onPrimary} />
                <Text style={styles.syncButtonText}>Sincronizar</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryOutlineBtn, styles.flex1]}
            onPress={() => setOfflineDetailsModalVisible(true)}
          >
            <AlertTriangle size={16} color={ui.warning} />
            <Text style={[styles.secondaryOutlineBtnText, { color: ui.warning }]}>
              Ver Detalle ({offlineSales.length + quarantinedSales.length})
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );

  const renderSeguridadTab = () => (
    <>
      <SectionHeading title="Bloqueo de Terminal" subtitle="PIN rápido local del dispositivo" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
            <Shield size={22} color={ui.accent} />
          </View>
          <View style={styles.cardHeaderText}>
            <Text style={styles.cardTitle}>Seguridad de Terminal</Text>
            <Text style={styles.cardSubtitle}>Bloqueo inmediato y PIN de 4 a 8 dígitos</Text>
          </View>
        </View>

        <View style={styles.actionButtonGroup}>
          <TouchableOpacity
            style={[styles.outlineActionBtn, { borderColor: ui.primary }]}
            onPress={() => setPinModalVisible(true)}
          >
            <KeyRound size={18} color={ui.primary} />
            <Text style={[styles.outlineActionBtnText, { color: ui.primary }]}>
              Cambiar PIN (4-8 Dígitos)
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.outlineActionBtn, { borderColor: ui.warning }]}
            onPress={lockTerminal}
          >
            <Lock size={18} color={ui.warning} />
            <Text style={[styles.outlineActionBtnText, { color: ui.warning }]}>
              Bloquear Terminal
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* PIN de Autorización de Egresos y Límites */}
      <SectionHeading
        title="Egresos y PIN de Autorización"
        subtitle="Control de caja chica y rotación del PIN de supervisor"
      />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
            <Wallet size={22} color={ui.primary} />
          </View>
          <View style={styles.cardHeaderText}>
            <View style={styles.inlineRow}>
              <Text style={styles.cardTitle}>Límite de Egreso & PIN</Text>
              <View
                style={[
                  styles.pillBadge,
                  { backgroundColor: hasExpensePin ? ui.successSoft : ui.surfaceMuted },
                ]}
              >
                <Text
                  style={[
                    styles.pillBadgeText,
                    { color: hasExpensePin ? ui.success : ui.textSecondary },
                  ]}
                >
                  {hasExpensePin ? 'PIN Configurado' : 'Sin PIN'}
                </Text>
              </View>
            </View>
            <Text style={styles.cardSubtitle}>
              El hash nunca se expone; los cajeros usan este PIN para superar su tope
            </Text>
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Tope de Egreso del Cajero (S/, 0 = sin límite)</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            keyboardType="decimal-pad"
            value={cashierExpenseLimitStr}
            onChangeText={setCashierExpenseLimitStr}
            editable={canManageSettings}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Margen Sugerido en Recepción (%)</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            keyboardType="decimal-pad"
            value={suggestedMarginStr}
            onChangeText={setSuggestedMarginStr}
            editable={canManageSettings}
          />
        </View>

        {canManageSettings ? (
          <TouchableOpacity
            style={[styles.secondaryOutlineBtn, isSavingExpenseConfig && styles.buttonDisabled]}
            onPress={handleSaveExpenseLimits}
            disabled={isSavingExpenseConfig}
          >
            {isSavingExpenseConfig ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <>
                <Save size={16} color={ui.primary} />
                <Text style={styles.secondaryOutlineBtnText}>Guardar Tope y Margen</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}

        {canManageSettings ? (
          <View style={styles.digitalPayBox}>
            <Text style={styles.digitalPayTitle}>
              {hasExpensePin ? 'Rotar PIN de Autorización de Egresos' : 'Crear PIN de Autorización de Egresos'}
            </Text>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Nuevo PIN (4 a 8 dígitos)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="••••••"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                secureTextEntry
                maxLength={8}
                value={expensePinInput}
                onChangeText={(t) => setExpensePinInput(t.replace(/\D/g, '').slice(0, 8))}
                accessibilityLabel="Nuevo PIN de autorización de egresos"
              />
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Confirmar PIN</Text>
              <TextInput
                style={styles.textInput}
                placeholder="••••••"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                secureTextEntry
                maxLength={8}
                value={expensePinConfirm}
                onChangeText={(t) => setExpensePinConfirm(t.replace(/\D/g, '').slice(0, 8))}
                accessibilityLabel="Confirmar PIN de autorización de egresos"
              />
            </View>
            <TouchableOpacity
              style={[styles.saveButton, (isUpdatingExpensePin || !expensePinInput) && styles.buttonDisabled]}
              onPress={handleSaveExpenseAuthPin}
              disabled={isUpdatingExpensePin || !expensePinInput}
            >
              {isUpdatingExpensePin ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <KeyRound size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>
                    {hasExpensePin ? 'Rotar PIN de Egresos' : 'Guardar PIN de Egresos'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {/* Perfil de Usuario y Cierre de Sesión */}
      <SectionHeading title="Cuenta" />
      <View style={styles.card}>
        <View style={styles.userProfileRow}>
          <View style={styles.userAvatar}>
            <User size={24} color={ui.primary} />
          </View>
          <View style={styles.cardHeaderText}>
            <Text style={styles.userName}>
              {userProfile?.displayName || user?.email || 'Usuario'}
            </Text>
            <Text style={styles.userRole}>Rol: {getRoleLabel(role)}</Text>
            <Text style={styles.userEmail}>{user?.email || 'Sin correo'}</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.logoutButton} onPress={handleLogoutPress}>
          <LogOut size={18} color={ui.danger} />
          <Text style={styles.logoutText}>Cerrar Sesión del Terminal</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderAlertasTab = () => (
    <>
      <SectionHeading title="Estado del Dispositivo" subtitle="Permisos y prueba de notificaciones" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
            <Bell size={22} color={ui.primary} />
          </View>
          <View style={styles.cardHeaderText}>
            <View style={styles.inlineRow}>
              <Text style={styles.cardTitle}>Alertas Locales y Push</Text>
              <View
                style={[
                  styles.pillBadge,
                  {
                    backgroundColor:
                      notifPermStatus === 'granted' ? ui.successSoft : ui.warningSoft,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.pillBadgeText,
                    { color: notifPermStatus === 'granted' ? ui.success : ui.warning },
                  ]}
                >
                  {notifPermStatus === 'granted' ? 'Permitidas' : 'Pendiente / Bloqueado'}
                </Text>
              </View>
            </View>
            <Text style={styles.cardSubtitle}>
              {expoPushStatus || 'Canales Android: Stock crítico, SUNAT, Caja y General'}
            </Text>
          </View>
        </View>

        <View style={styles.actionButtonGroup}>
          <TouchableOpacity style={[styles.secondaryOutlineBtn, styles.flex1]} onPress={handleEnableNotifications}>
            <CheckCircle2 size={16} color={ui.primary} />
            <Text style={styles.secondaryOutlineBtnText}>Activar Permisos</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.secondaryOutlineBtn, styles.flex1]} onPress={handleSendTestNotification}>
            <Send size={16} color={ui.primary} />
            <Text style={styles.secondaryOutlineBtnText}>Probar Alerta</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Preferencias granulares */}
      <SectionHeading title="Preferencias de Alertas" subtitle="Canales de la cuenta en Firestore" />
      <View style={styles.card}>
        {(
          [
            ['pushNotifications', 'Notificaciones Push / Locales', 'Alertas inmediatas en el dispositivo'],
            ['emailNotifications', 'Notificaciones por Correo', 'Resúmenes y alertas críticas por email'],
            ['stockAlerts', 'Stock Mínimo y Crítico', 'Avisar cuando un producto cae bajo el umbral'],
            ['cashRegisterAlerts', 'Apertura y Cierre de Caja', 'Notificar movimientos de turno y arqueos'],
            ['reservationAlerts', 'Reservas y Fiados', 'Recordatorios de vencimientos y mora'],
            ['quoteAlerts', 'Cotizaciones / Leads Web', 'Nuevas solicitudes desde la tienda online'],
            ['aiInsightsAlerts', 'Insights de Venty IA', 'Detección de anomalías y sugerencias'],
          ] as Array<[keyof Omit<NotificationPrefsState, 'alertThreshold'>, string, string]>
        ).map(([key, title, sub]) => (
          <View key={key} style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>{title}</Text>
              <Text style={styles.switchSubtitle}>{sub}</Text>
            </View>
            <Switch
              value={notifPrefs[key]}
              onValueChange={(val) =>
                setNotifPrefs((prev) => ({ ...prev, [key]: val }))
              }
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>
        ))}

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Umbral de Alerta de Stock (Unidades)</Text>
          <TextInput
            style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
            keyboardType="numeric"
            value={notifPrefs.alertThreshold}
            onChangeText={(val) =>
              setNotifPrefs((prev) => ({ ...prev, alertThreshold: val.replace(/\D/g, '') }))
            }
            editable={canManageSettings}
          />
        </View>

        {canManageSettings ? (
          <TouchableOpacity
            style={[styles.saveButton, isSavingNotifPrefs && styles.buttonDisabled]}
            onPress={handleSaveNotifPrefs}
            disabled={isSavingNotifPrefs}
          >
            {isSavingNotifPrefs ? (
              <ActivityIndicator color={ui.onPrimary} />
            ) : (
              <>
                <Save size={18} color={ui.onPrimary} />
                <Text style={styles.saveButtonText}>Guardar Preferencias</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Bandeja en tiempo real de account_notifications */}
      <SectionHeading
        title={`Bandeja de Alertas (${unreadNotifCount} sin leer)`}
        subtitle="Historial en tiempo real sincronizado con la web"
        action={
          canManageSettings && unreadNotifCount > 0 ? (
            <TouchableOpacity onPress={handleMarkAllRead} style={styles.markAllBtn}>
              <Text style={styles.markAllBtnText}>Marcar todas</Text>
            </TouchableOpacity>
          ) : undefined
        }
      />
      <View style={styles.card}>
        {notifInboxError ? (
          <Text style={styles.emptySub}>{notifInboxError}</Text>
        ) : accountNotifications.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Bell size={32} color={ui.textMuted} />
            <Text style={styles.emptyText}>Sin notificaciones recientes</Text>
            <Text style={styles.emptySub}>
              Aquí aparecerán alertas de stock crítico, caja, reservas y fiados.
            </Text>
          </View>
        ) : (
          accountNotifications.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={[styles.notifItem, !item.read && styles.notifItemUnread]}
              onPress={() => void handleMarkNotificationRead(item)}
              activeOpacity={0.75}
            >
              <View style={styles.inlineBetween}>
                <Text style={styles.notifTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {!item.read ? <View style={styles.unreadDot} /> : null}
              </View>
              {item.body ? (
                <Text style={styles.notifBody} numberOfLines={3}>
                  {item.body}
                </Text>
              ) : null}
              <Text style={styles.notifMeta}>
                {formatDatePE(item.createdAt)} · {item.type.toUpperCase()}
                {item.read ? ' · Leída' : canManageSettings ? ' · Toca para marcar leída' : ''}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </View>
    </>
  );

  const renderRegalosTab = () => (
    <>
      <SectionHeading
        title="Promociones y Regalos"
        subtitle="Productos elegibles como cortesía en el Punto de Venta"
      />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
            <Gift size={22} color={ui.accent} />
          </View>
          <View style={styles.cardHeaderText}>
            <Text style={styles.cardTitle}>Regalos en Checkout</Text>
            <Text style={styles.cardSubtitle}>
              Sincronizado con settings/{accountId}_discounts
            </Text>
          </View>
        </View>

        <View style={styles.switchRow}>
          <View style={styles.flex1}>
            <Text style={styles.switchTitle}>Habilitar Regalos en Punto de Venta</Text>
            <Text style={styles.switchSubtitle}>
              Muestra la opción de cortesías y regalos al cobrar en caja
            </Text>
          </View>
          <Switch
            value={enableGifts}
            onValueChange={setEnableGifts}
            disabled={!canManageSettings}
            trackColor={{ false: ui.border, true: ui.primary }}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>
            Productos Elegibles Seleccionados ({giftProductIds.length})
          </Text>
          {giftProductIds.length === 0 ? (
            <Text style={styles.settingSubtext}>
              Sin restricción o sin productos seleccionados aún.
            </Text>
          ) : (
            <View style={styles.giftChipWrap}>
              {giftProductIds.map((pid) => {
                const prod = products.find((p) => p.id === pid);
                return (
                  <View key={pid} style={styles.giftChip}>
                    <Text style={styles.giftChipText} numberOfLines={1}>
                      {prod?.name || pid}
                    </Text>
                    {canManageSettings ? (
                      <TouchableOpacity
                        onPress={() => toggleGiftProductId(pid)}
                        accessibilityLabel={`Quitar ${prod?.name || pid}`}
                      >
                        <X size={14} color={ui.textSecondary} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Buscar Productos del Catálogo</Text>
          <View style={styles.searchRow}>
            <Search size={18} color={ui.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Nombre, SKU o código de barras..."
              placeholderTextColor={ui.textMuted}
              value={giftSearch}
              onChangeText={setGiftSearch}
            />
            {giftSearch ? (
              <TouchableOpacity onPress={() => setGiftSearch('')}>
                <X size={16} color={ui.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        <View style={styles.giftCatalogList}>
          {filteredGiftCatalog.length === 0 ? (
            <Text style={styles.emptySub}>No se encontraron productos con ese criterio.</Text>
          ) : (
            filteredGiftCatalog.map((prod) => {
              const selected = giftProductIds.includes(prod.id);
              const price = Number(prod.suggestedPrice ?? prod.price ?? 0);
              return (
                <TouchableOpacity
                  key={prod.id}
                  style={[styles.giftCatalogRow, selected && styles.giftCatalogRowSelected]}
                  onPress={() => toggleGiftProductId(prod.id)}
                  disabled={!canManageSettings}
                >
                  <View style={styles.flex1}>
                    <Text style={styles.giftProdName} numberOfLines={1}>
                      {prod.name}
                    </Text>
                    <Text style={styles.giftProdMeta}>
                      {prod.sku ? `SKU: ${prod.sku} · ` : ''}
                      {formatPEN(price)}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.giftTogglePill,
                      selected && { backgroundColor: ui.primary },
                    ]}
                  >
                    {selected ? (
                      <Check size={14} color={ui.onPrimary} />
                    ) : (
                      <Text style={styles.giftToggleText}>Agregar</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>

        {canManageSettings ? (
          <TouchableOpacity
            style={[styles.saveButton, isSavingDiscounts && styles.buttonDisabled]}
            onPress={handleSaveDiscounts}
            disabled={isSavingDiscounts}
          >
            {isSavingDiscounts ? (
              <ActivityIndicator color={ui.onPrimary} />
            ) : (
              <>
                <Save size={18} color={ui.onPrimary} />
                <Text style={styles.saveButtonText}>Guardar Regalos y Promociones</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Header />
      <ScreenHeading
        title="Ajustes"
        subtitle="Configura el terminal, los cobros, la seguridad y tu negocio"
      />

      {/* Selector horizontal de secciones */}
      <View style={styles.tabBarWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBarContent}
        >
          {SETTINGS_TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tabPill, isActive && styles.tabPillActive]}
                onPress={() => setActiveTab(tab.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.tabPillText, isActive && styles.tabPillTextActive]}>
                  {tab.label}
                  {tab.key === 'alertas' && unreadNotifCount > 0 ? ` (${unreadNotifCount})` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.contentContainer}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) + 12 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          {activeTab === 'negocio' && renderNegocioTab()}
          {activeTab === 'pagos' && renderPagosTab()}
          {activeTab === 'impresora' && renderImpresoraTab()}
          {activeTab === 'seguridad' && renderSeguridadTab()}
          {activeTab === 'alertas' && renderAlertasTab()}
          {activeTab === 'regalos' && renderRegalosTab()}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ==================================================================== */}
      {/* MODAL 1: DISPOSITIVOS BLUETOOTH ENCONTRADOS */}
      {/* ==================================================================== */}
      <Modal
        visible={printerScanModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPrinterScanModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Impresoras Bluetooth</Text>
              <TouchableOpacity
                onPress={() => setPrinterScanModalVisible(false)}
                style={styles.modalCloseButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar impresoras Bluetooth"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {scannedPrinters.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Bluetooth size={36} color={ui.textMuted} />
                <Text style={styles.emptyText}>No se detectaron impresoras vinculadas.</Text>
                <Text style={styles.emptySub}>
                  Asegúrate de emparejar tu ticketera en los Ajustes Bluetooth de Android primero.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 280 }}>
                {scannedPrinters.map((device, idx) => (
                  <TouchableOpacity
                    key={device.address || idx}
                    style={styles.deviceItem}
                    onPress={() => void handleSelectPrinterDevice(device)}
                  >
                    <View style={styles.flex1}>
                      <Text style={styles.deviceName}>{device.name}</Text>
                      <Text style={styles.deviceAddress}>{device.address}</Text>
                    </View>
                    <ChevronRight size={18} color={ui.primary} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </SafeAreaView>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 2: CAMBIO DE PIN DE BLOQUEO DEL TERMINAL (4 DÍGITOS) */}
      {/* ==================================================================== */}
      <Modal
        visible={pinModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPinModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <SafeAreaView style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={styles.flex1}>
                <Text style={styles.modalTitle}>Cambiar PIN de Terminal</Text>
                <Text style={styles.modalSub}>Código de 4 a 8 dígitos para desbloqueo rápido</Text>
              </View>
              <TouchableOpacity
                onPress={() => setPinModalVisible(false)}
                style={styles.modalCloseButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar cambio de PIN"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Nuevo PIN (4 a 8 dígitos numéricos)</Text>
              <TextInput
                style={[styles.textInput, styles.pinInput]}
                placeholder="••••"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                maxLength={8}
                secureTextEntry
                value={newPinInput}
                onChangeText={setNewPinInput}
                accessibilityLabel="Nuevo PIN, cuatro a ocho dígitos"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Confirmar Nuevo PIN</Text>
              <TextInput
                style={[styles.textInput, styles.pinInput]}
                placeholder="••••"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                maxLength={8}
                secureTextEntry
                value={confirmPinInput}
                onChangeText={setConfirmPinInput}
                accessibilityLabel="Confirmar nuevo PIN"
              />
            </View>

            <TouchableOpacity
              style={[styles.saveButton, isUpdatingPin && styles.buttonDisabled]}
              onPress={handleChangeTerminalPin}
              disabled={isUpdatingPin}
            >
              {isUpdatingPin ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.saveButtonText}>Guardar Nuevo PIN</Text>
              )}
            </TouchableOpacity>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 3: DETALLE DE COLA OFFLINE Y CUARENTENA */}
      {/* ==================================================================== */}
      <Modal
        visible={offlineDetailsModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setOfflineDetailsModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={styles.flex1}>
                <Text style={styles.modalTitle}>Cola Offline y Cuarentena</Text>
                <Text style={styles.modalSub}>
                  Pendientes: {offlineSales.length} · Cuarentena: {quarantinedSales.length}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setOfflineDetailsModalVisible(false)}
                style={styles.modalCloseButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar detalle offline"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 340 }}>
              {offlineSales.length === 0 && quarantinedSales.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <CheckCircle2 size={32} color={ui.success} />
                  <Text style={styles.emptyText}>Cola sincronizada al 100%</Text>
                </View>
              ) : (
                <>
                  {offlineSales.map((item) => (
                    <View key={item.offlineId || item.id} style={styles.offlineItemRow}>
                      <View style={styles.flex1}>
                        <Text style={styles.deviceName}>
                          Venta pendiente · {formatPEN(item.salePayload?.total || 0)}
                        </Text>
                        <Text style={styles.deviceAddress}>
                          Intentos: {item.retryCount} · {formatDatePE(item.timestamp)}
                        </Text>
                      </View>
                    </View>
                  ))}

                  {quarantinedSales.map((qItem) => (
                    <View key={qItem.offlineId || qItem.id} style={styles.quarantineBox}>
                      <Text style={styles.quarantineTitle}>
                        En cuarentena · {formatPEN(qItem.salePayload?.total || 0)}
                      </Text>
                      <Text style={styles.quarantineError} numberOfLines={2}>
                        {qItem.lastErrorReason || 'Error de sincronización'}
                      </Text>
                      <View style={styles.actionButtonGroup}>
                        <TouchableOpacity
                          style={[styles.secondaryOutlineBtn, styles.flex1]}
                          onPress={() => void handleRetryQuarantined(qItem.offlineId)}
                        >
                          <RefreshCw size={14} color={ui.primary} />
                          <Text style={styles.secondaryOutlineBtnText}>Reintentar</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.secondaryOutlineBtn, styles.flex1, { borderColor: ui.danger }]}
                          onPress={() => void handleRemoveQuarantined(qItem.offlineId)}
                        >
                          <Trash2 size={14} color={ui.danger} />
                          <Text style={[styles.secondaryOutlineBtnText, { color: ui.danger }]}>
                            Descartar
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </>
              )}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL 4: SELECTOR DE SUCURSAL */}
      {/* ==================================================================== */}
      <Modal
        visible={branchModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setBranchModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <SafeAreaView style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Cambiar Sucursal</Text>
              <TouchableOpacity
                onPress={() => setBranchModalVisible(false)}
                style={styles.modalCloseButton}
                accessibilityRole="button"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 300 }}>
              {branches.map((b) => {
                const selected = b.id === branchId;
                return (
                  <TouchableOpacity
                    key={b.id || b.name}
                    style={[styles.deviceItem, selected && { backgroundColor: ui.primarySoft, paddingHorizontal: 10, borderRadius: 10 }]}
                    onPress={() => {
                      if (b.id) {
                        setActiveBranchId(b.id);
                      }
                      setBranchModalVisible(false);
                    }}
                  >
                    <View style={styles.flex1}>
                      <Text style={[styles.deviceName, selected && { color: ui.primary }]}>
                        {b.name}
                      </Text>
                      {b.address ? <Text style={styles.deviceAddress}>{b.address}</Text> : null}
                    </View>
                    {selected ? <Check size={18} color={ui.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ============================================================================
// ESTILOS NATIVOS REACT NATIVE (SYSTEM TOKENS ui.*)
// ============================================================================
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  flex1: {
    flex: 1,
  },
  tabBarWrapper: {
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    backgroundColor: ui.surface,
  },
  tabBarContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  tabPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    minHeight: 38,
    justifyContent: 'center',
  },
  tabPillActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  tabPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  tabPillTextActive: {
    color: ui.onPrimary,
    fontWeight: '700',
  },
  keyboardArea: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  card: {
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    marginBottom: 16,
    gap: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardHeaderText: {
    flex: 1,
    marginLeft: 12,
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  inlineBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconActionBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
  },
  cardTitle: {
    fontSize: ui.font.section,
    fontWeight: '700',
    color: ui.text,
  },
  cardSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  pillBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  pillBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  limitsGrid: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  limitChip: {
    flex: 1,
    minWidth: 96,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    padding: 10,
  },
  limitLabel: {
    fontSize: 11,
    color: ui.textMuted,
    fontWeight: '600',
  },
  limitValue: {
    fontSize: 15,
    color: ui.text,
    fontWeight: '700',
    marginTop: 2,
  },
  quickLinksRow: {
    flexDirection: 'row',
    gap: 8,
  },
  quickLinkBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  quickLinkText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  taxSummaryBox: {
    backgroundColor: ui.primarySoft,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.border,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 10,
  },
  statusBoxLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  statusBoxValue: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
    marginTop: 2,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.borderRadius.sm,
    gap: 6,
    minHeight: 44,
    justifyContent: 'center',
  },
  scanButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  secondaryOutlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: ui.primary,
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryOutlineBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    gap: 12,
  },
  settingLabel: {
    fontSize: ui.font.body,
    fontWeight: '600',
    color: ui.text,
  },
  settingSubtext: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  segmentControl: {
    flexDirection: 'row',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: ui.border,
  },
  segmentBtn: {
    paddingHorizontal: 12,
    minHeight: 42,
    paddingVertical: 8,
    justifyContent: 'center',
    borderRadius: 6,
  },
  segmentBtnActive: {
    backgroundColor: ui.primary,
  },
  segmentText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  segmentTextActive: {
    color: ui.onPrimary,
    fontWeight: '700',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 10,
    gap: 12,
  },
  switchTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  switchSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  testPrintBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primarySoft,
    borderRadius: theme.borderRadius.md,
    minHeight: 48,
    paddingVertical: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  testPrintText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  offlineStatsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  offlineStatBox: {
    flex: 1,
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.sm,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.border,
  },
  statLabel: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
  },
  statValue: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 2,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    minHeight: 44,
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  syncButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  actionButtonGroup: {
    flexDirection: 'row',
    gap: 10,
  },
  outlineActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1.5,
    gap: 6,
  },
  outlineActionBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  inputGroup: {
    gap: 4,
  },
  inputLabel: {
    fontSize: ui.font.small,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  textInput: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    color: ui.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: ui.border,
  },
  textInputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  inputReadOnly: {
    opacity: 0.7,
    backgroundColor: ui.surfaceMuted,
  },
  pinInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
  },
  digitalPayBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  digitalPayTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  qrMethodBox: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  qrPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  qrPreviewImage: {
    width: 78,
    height: 78,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: '#FFFFFF',
  },
  qrPlaceholder: {
    width: 78,
    height: 78,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrUrlInput: {
    marginTop: 8,
    minHeight: 40,
    fontSize: 13,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    minHeight: 50,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    gap: 8,
    marginTop: 4,
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  userProfileRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userName: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  userRole: {
    fontSize: 12,
    color: ui.primary,
    fontWeight: '600',
    marginTop: 1,
  },
  userEmail: {
    fontSize: 12,
    color: ui.textMuted,
    marginTop: 1,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: ui.dangerSoft,
    backgroundColor: ui.dangerSoft,
    gap: 8,
  },
  logoutText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.danger,
  },
  markAllBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
  },
  markAllBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  notifItem: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  notifItemUnread: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  notifTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
    flex: 1,
  },
  notifBody: {
    fontSize: 12,
    color: ui.textSecondary,
    lineHeight: 17,
  },
  notifMeta: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: ui.primary,
  },
  giftChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  giftChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 200,
  },
  giftChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 46,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: ui.text,
  },
  giftCatalogList: {
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    backgroundColor: ui.surface,
    overflow: 'hidden',
  },
  giftCatalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  giftCatalogRowSelected: {
    backgroundColor: ui.primarySoft,
  },
  giftProdName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  giftProdMeta: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  giftTogglePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
  },
  giftToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 14,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    borderRadius: theme.borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
  },
  modalTitle: {
    fontSize: theme.typography.sizes.lg,
    fontWeight: '700',
    color: ui.text,
  },
  modalSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  deviceAddress: {
    fontSize: 12,
    color: ui.textMuted,
    marginTop: 2,
  },
  offlineItemRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  quarantineBox: {
    backgroundColor: ui.dangerSoft,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    gap: 6,
  },
  quarantineTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.danger,
  },
  quarantineError: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 6,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  emptySub: {
    fontSize: 12,
    color: ui.textMuted,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
