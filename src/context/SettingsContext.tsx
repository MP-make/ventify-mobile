import { subscribeLiveDocument } from '@/lib/live-document';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  doc,
  onSnapshot,
  collection,
  query,
  where,
  getDoc,
  getDocs,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db, auth, APP_URL } from '@/lib/firebase';
import { useAuth } from './AuthContext';
import { hasAllBranchesAccess } from '@/lib/branch-access';
import {
  Branch,
  BusinessSettings,
  DiscountSettings,
  PosSettings,
  PosPaymentMethodConfig,
  CashRegisterSession,
} from '@/types';
import {
  processOfflineQueue,
  getOfflineQueue,
  subscribeOfflineQueueChanges,
  offlineSaleBelongsToIdentity,
  type PendingOfflineSale,
} from '@/services/offline-sync-service';

export const SETTINGS_CACHE_PREFIX = '@ventify_settings_cache_v1:';
export const CASH_SESSION_CACHE_PREFIX = '@ventify_cash_session_cache_v1:';

interface CachedAccountSettings {
  primaryColor?: string;
  businessSettings?: BusinessSettings;
  posSettings?: PosSettings;
  allPaymentMethods?: PosPaymentMethodConfig[];
  discountSettings?: DiscountSettings;
  branches?: Branch[];
  invoicingEnabled?: boolean;
  invoicingConfigRaw?: {
    isAmazonExempt?: boolean;
    taxExemptionCode?: string;
    taxRate?: number;
    printedFormatResolution?: string | null;
    emitterRuc?: string;
    emitterRazonSocial?: string;
    emitterNombreComercial?: string;
  } | null;
}

const safeStorageGet = async (key: string): Promise<string | null> => {
  try {
    const value = await Promise.resolve(AsyncStorage?.getItem?.(key));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const safeStorageSet = async (key: string, value: string): Promise<void> => {
  try {
    await Promise.resolve(AsyncStorage?.setItem?.(key, value));
  } catch {
    // Ignore storage persistence errors
  }
};

const safeStorageRemove = async (key: string): Promise<void> => {
  try {
    await Promise.resolve(AsyncStorage?.removeItem?.(key));
  } catch {
    // Ignore storage removal errors
  }
};

const getCashSessionCacheKey = (
  targetAccountId: string,
  targetBranchId: string,
  targetUserId: string
): string => `${CASH_SESSION_CACHE_PREFIX}${targetAccountId}:${targetBranchId}:${targetUserId}`;

import {
  resolveAccountTaxProfile,
  type AccountTaxProfile,
} from '@/lib/invoicing/receipt-amounts';

declare module '@/types' {
  interface Branch {
    description?: string;
    email?: string;
    receiptFooter?: string;
    printedFormatResolution?: string;
  }
  interface BusinessSettings {
    commercialAddress?: string;
    commercialPhone?: string;
    description?: string;
    fiscalAddress?: string;
    receiptLogo?: string;
    receiptLogoDataUrl?: string;
    receiptFooter?: string;
    consultUrl?: string;
    printedFormatResolution?: string;
    isAmazonExempt?: boolean;
    taxExemptionCode?: string;
    taxRate?: number;
  }
  interface PosSettings {
    ticketFooterMessage?: string;
    digitalPhone?: string;
    digitalName?: string;
  }
  interface Sale {
    correlative?: string;
    einvoiceId?: string;
    sunatHash?: string;
    hash?: string;
    isAmazonExempt?: boolean;
    taxExemptionCode?: string;
    discountAmount?: number;
    shippingAmount?: number;
    completedByName?: string;
    printedFormatResolution?: string;
    receiptCustomer?: {
      identityType?: string;
      identityNumber?: string;
      name?: string;
      address?: string;
      email?: string;
    };
  }
}

export interface ActiveCashSessionData extends Partial<CashRegisterSession> {
  sessionId?: string;
  pointerId?: string;
  isOpen?: boolean;
  openedAt?: any;
  openingBalance?: number;
  totalIncome?: number;
  totalExpenses?: number;
  cashSalesTotal?: number;
}

export const DEFAULT_PAYMENT_METHODS: PosPaymentMethodConfig[] = [
  {
    id: 'efectivo',
    name: 'Efectivo',
    kind: 'cash',
    enabled: true,
    order: 0,
    reportCategory: 'cash',
  },
  {
    id: 'yape',
    name: 'Yape',
    kind: 'digital',
    enabled: true,
    order: 1,
    provider: 'yape',
    reportCategory: 'digital',
  },
  {
    id: 'plin',
    name: 'Plin',
    kind: 'digital',
    enabled: true,
    order: 2,
    provider: 'plin',
    reportCategory: 'digital',
  },
  {
    id: 'tarjeta',
    name: 'Tarjeta',
    kind: 'terminal',
    enabled: true,
    order: 3,
    reportCategory: 'card',
  },
  {
    id: 'transferencia',
    name: 'Transferencia',
    kind: 'digital',
    enabled: true,
    order: 4,
    reportCategory: 'digital',
  },
];

export const DEFAULT_POS_SETTINGS: PosSettings = {
  id: 'pos_default',
  accountId: '',
  methods: DEFAULT_PAYMENT_METHODS,
  enableQuickSale: true,
  allowMixedPayment: true,
  requireSellerSelection: false,
  ticketTemplate: 'standard',
};

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  id: 'biz_default',
  businessName: 'Ventify POS',
  ruc: '',
  address: '',
  phone: '',
  email: '',
  accountId: '',
};

export const DEFAULT_DISCOUNT_SETTINGS: DiscountSettings = {
  promotions: [],
  enableGifts: true,
};

export interface SettingsContextType {
  configurationReady: boolean;
  configurationError: string | null;
  refreshConfiguration: () => void;
  primaryColor: string;
  businessName: string;
  businessSettings: BusinessSettings;
  businessData: BusinessSettings; // Alias para compatibilidad con vistas legacy
  posSettings: PosSettings;
  discountSettings: DiscountSettings;
  branches: Branch[];
  activeBranchName: string;
  activeBranch: Branch | null;
  isCashOpen: boolean;
  activeCashSession: ActiveCashSessionData | null;
  invoicingEnabled: boolean;
  taxProfile: AccountTaxProfile;
  emitterInfo: {
    ruc?: string;
    razonSocial?: string;
    nombreComercial?: string;
    printedFormatResolution?: string | null;
  } | null;
  paymentMethods: PosPaymentMethodConfig[];
  allPaymentMethods: PosPaymentMethodConfig[];
  isOnline: boolean;
  offlineQueueCount: number;
  pendingOfflineSales: PendingOfflineSale[];
  refreshOfflineCount: () => Promise<number>;
  updateBusinessSettings: (patch: Partial<BusinessSettings>) => Promise<void>;
  updateBusinessData: (patch: Partial<BusinessSettings>) => Promise<void>;
  updatePosSettings: (patch: Partial<PosSettings>) => Promise<void>;
  togglePaymentMethod: (methodId: string, enabled: boolean) => Promise<void>;
  refreshCashStatus: () => void;
}

const DEFAULT_TAX_PROFILE: AccountTaxProfile = {
  isAmazonExempt: false,
  taxExemptionCode: '10',
  taxRate: 18,
};

const SettingsContext = createContext<SettingsContextType>({
  configurationReady: false,
  configurationError: null,
  refreshConfiguration: () => {},
  primaryColor: '#10B981',
  businessName: 'Ventify POS',
  businessSettings: DEFAULT_BUSINESS_SETTINGS,
  businessData: DEFAULT_BUSINESS_SETTINGS,
  posSettings: DEFAULT_POS_SETTINGS,
  discountSettings: DEFAULT_DISCOUNT_SETTINGS,
  branches: [],
  activeBranchName: 'Tienda Principal',
  activeBranch: null,
  isCashOpen: false,
  activeCashSession: null,
  invoicingEnabled: false,
  taxProfile: DEFAULT_TAX_PROFILE,
  emitterInfo: null,
  paymentMethods: DEFAULT_PAYMENT_METHODS,
  allPaymentMethods: DEFAULT_PAYMENT_METHODS,
  isOnline: true,
  offlineQueueCount: 0,
  pendingOfflineSales: [],
  refreshOfflineCount: async () => 0,
  updateBusinessSettings: async () => {},
  updateBusinessData: async () => {},
  updatePosSettings: async () => {},
  togglePaymentMethod: async () => {},
  refreshCashStatus: () => {},
});

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    accountId,
    branchId,
    setBranchId,
    syncAssignedBranchId,
    user,
    userProfile,
    role,
    allBranchesAccess,
    isOnline,
  } = useAuth();
  const configurationScope = `${user?.uid || ''}:${accountId || ''}`;
  const [configuration, setConfiguration] = useState({ scope: configurationScope, pos: false, account: false, posError: null as string | null, accountError: null as string | null });
  const configurationReady = configuration.scope === configurationScope && configuration.pos && configuration.account && !configuration.posError && !configuration.accountError;
  const configurationError = configuration.scope === configurationScope ? configuration.posError || configuration.accountError : null;
  const [configurationTick, setConfigurationTick] = useState(0);
  const refreshConfiguration = useCallback(() => {
    setConfiguration({ scope: configurationScope, pos: false, account: false, posError: null, accountError: null });
    setConfigurationTick(value => value + 1);
  }, [configurationScope]);



  const [primaryColor, setPrimaryColor] = useState<string>('#10B981');
  const [businessSettings, setBusinessSettings] = useState<BusinessSettings>(DEFAULT_BUSINESS_SETTINGS);
  const [posSettings, setPosSettings] = useState<PosSettings>(DEFAULT_POS_SETTINGS);
  const [discountSettings, setDiscountSettings] = useState<DiscountSettings>(DEFAULT_DISCOUNT_SETTINGS);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isCashOpen, setIsCashOpen] = useState<boolean>(false);
  const [activeCashSession, setActiveCashSession] = useState<ActiveCashSessionData | null>(null);
  const [invoicingEnabled, setInvoicingEnabled] = useState<boolean>(false);
  const [invoicingConfigRaw, setInvoicingConfigRaw] = useState<{
    isAmazonExempt?: boolean;
    taxExemptionCode?: string;
    taxRate?: number;
    printedFormatResolution?: string | null;
    emitterRuc?: string;
    emitterRazonSocial?: string;
    emitterNombreComercial?: string;
  } | null>(null);
  const [allPaymentMethods, setAllPaymentMethods] = useState<PosPaymentMethodConfig[]>(DEFAULT_PAYMENT_METHODS);
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(0);
  const [pendingOfflineSales, setPendingOfflineSales] = useState<PendingOfflineSale[]>([]);
  const branchIdRef = useRef(branchId);
  branchIdRef.current = branchId;
  const accountIdRef = useRef<string | null>(accountId);
  accountIdRef.current = accountId;
  const isOnlineRef = useRef<boolean>(isOnline);
  isOnlineRef.current = isOnline;
  const activeCashSessionRef = useRef<ActiveCashSessionData | null>(activeCashSession);
  activeCashSessionRef.current = activeCashSession;
  const wasOfflineRef = useRef<boolean>(!isOnline);
  const startupSyncAttemptedScopeRef = useRef<string>('');
  const inFlightCashCheckRef = useRef<{ scope: string; promise: Promise<ActiveCashSessionData | null> } | null>(null);
  const settingsCacheSnapshotRef = useRef<{ accountId: string; data: CachedAccountSettings } | null>(null);
  const hydratedSettingsAccountRef = useRef<string | null>(null);
  const prevHydratedAccountRef = useRef<string | null>(null);
  const hasHydratedSettingsRef = useRef<boolean>(false);
  const authoritativeSettingsRef = useRef<Record<string, boolean>>({});
  const cashScopeRef = useRef<string | null>(null);
  const hydratedCashSessionRef = useRef<{ key: string; session: ActiveCashSessionData } | null>(null);
  const serverConfirmedCashScopeRef = useRef<string | null>(null);
  const cashHydrationPromiseRef = useRef<{ key: string; promise: Promise<ActiveCashSessionData | null> } | null>(null);
  const refreshCashStatusRef = useRef<() => void>(() => {});

  const persistSettingsSnapshot = useCallback(
    (targetAccountId: string, patch: Partial<CachedAccountSettings>) => {
      if (!targetAccountId) return;
      const current =
        settingsCacheSnapshotRef.current?.accountId === targetAccountId
          ? settingsCacheSnapshotRef.current.data
          : {};
      const nextData: CachedAccountSettings = {
        ...current,
        ...patch,
      };
      settingsCacheSnapshotRef.current = { accountId: targetAccountId, data: nextData };

      if (hydratedSettingsAccountRef.current === targetAccountId) {
        void safeStorageSet(`${SETTINGS_CACHE_PREFIX}${targetAccountId}`, JSON.stringify(nextData));
      }
    },
    []
  );

  const reconcileActiveBranches = useCallback(
    (activeList: Branch[]) => {
      const currentBranchId = branchIdRef.current;
      if (activeList.length > 0) {
        if (
          !hasAllBranchesAccess({ role, allBranchesAccess, branchId: currentBranchId }) &&
          userProfile?.branchId
        ) {
          const assignedExists = activeList.some((b) => b.id === userProfile.branchId);
          if (currentBranchId === 'main' && assignedExists) {
            syncAssignedBranchId(userProfile.branchId);
          } else if (currentBranchId !== userProfile.branchId) {
            setBranchId(userProfile.branchId);
          }
        } else if (currentBranchId === 'main' || !activeList.some((b) => b.id === currentBranchId)) {
          setBranchId(activeList[0].id!);
        }
      }
    },
    [role, allBranchesAccess, userProfile?.branchId, syncAssignedBranchId, setBranchId]
  );
  const reconcileActiveBranchesRef = useRef(reconcileActiveBranches);
  reconcileActiveBranchesRef.current = reconcileActiveBranches;

  // 1. Refrescar el contador y detalle de ventas offline en cola local
  const refreshOfflineCount = useCallback(async (): Promise<number> => {
    try {
      const queue = await getOfflineQueue();
      const scoped =
        user?.uid && accountId
          ? queue.filter((item) =>
              offlineSaleBelongsToIdentity(item.salePayload, user.uid, accountId)
            )
          : queue;
      setPendingOfflineSales(scoped);
      setOfflineQueueCount(scoped.length);
      return scoped.length;
    } catch {
      return 0;
    }
  }, [accountId, user?.uid]);

  // 1.5. Hidratar ajustes cacheados para arranque en frío offline
  useEffect(() => {
    if (!accountId) {
      prevHydratedAccountRef.current = null;
      hydratedSettingsAccountRef.current = null;
      hasHydratedSettingsRef.current = false;
      settingsCacheSnapshotRef.current = null;
      authoritativeSettingsRef.current = {};
      return;
    }

    let cancelled = false;
    if (prevHydratedAccountRef.current !== accountId) {
      prevHydratedAccountRef.current = accountId;
      hydratedSettingsAccountRef.current = null;
      hasHydratedSettingsRef.current = false;
      settingsCacheSnapshotRef.current = { accountId, data: {} };
      authoritativeSettingsRef.current = {};
    }

    const hydrateSettings = async () => {
      const raw = await safeStorageGet(`${SETTINGS_CACHE_PREFIX}${accountId}`);
      if (cancelled) return;

      hydratedSettingsAccountRef.current = accountId;
      const alreadyApplied =
        settingsCacheSnapshotRef.current?.accountId === accountId
          ? settingsCacheSnapshotRef.current.data
          : {};

      if (!raw) {
        if (Object.keys(alreadyApplied).length > 0) {
          void safeStorageSet(
            `${SETTINGS_CACHE_PREFIX}${accountId}`,
            JSON.stringify(alreadyApplied)
          );
        }
        return;
      }

      try {
        const parsed = JSON.parse(raw) as CachedAccountSettings | null;
        if (!parsed || typeof parsed !== 'object') return;

        hasHydratedSettingsRef.current = true;
        const merged: CachedAccountSettings = { ...parsed, ...alreadyApplied };
        settingsCacheSnapshotRef.current = { accountId, data: merged };

        if (parsed.primaryColor && !authoritativeSettingsRef.current.appearance) {
          setPrimaryColor(parsed.primaryColor);
        }
        if (parsed.businessSettings && !authoritativeSettingsRef.current.business) {
          setBusinessSettings(parsed.businessSettings);
        }
        if (parsed.posSettings) {
          if (!authoritativeSettingsRef.current.pos) {
            setPosSettings(parsed.posSettings);
          }
          setConfiguration((prev) => {
            if (
              prev.scope === configurationScope &&
              prev.pos &&
              prev.account &&
              !prev.posError &&
              !prev.accountError
            ) {
              return prev;
            }
            return {
              scope: configurationScope,
              pos: true,
              account: true,
              posError: null,
              accountError: null,
            };
          });
        }
        if (
          Array.isArray(parsed.allPaymentMethods) &&
          parsed.allPaymentMethods.length > 0 &&
          !authoritativeSettingsRef.current.pos
        ) {
          setAllPaymentMethods(parsed.allPaymentMethods);
        }
        if (parsed.discountSettings && !authoritativeSettingsRef.current.discounts) {
          setDiscountSettings(parsed.discountSettings);
        }
        if (
          Array.isArray(parsed.branches) &&
          parsed.branches.length > 0 &&
          !authoritativeSettingsRef.current.branches
        ) {
          setBranches(parsed.branches);
          reconcileActiveBranchesRef.current(parsed.branches);
        }
        if (
          typeof parsed.invoicingEnabled === 'boolean' &&
          !authoritativeSettingsRef.current.account
        ) {
          setInvoicingEnabled(parsed.invoicingEnabled);
        }
        if (
          parsed.invoicingConfigRaw !== undefined &&
          !authoritativeSettingsRef.current.invoicingConfig
        ) {
          setInvoicingConfigRaw(parsed.invoicingConfigRaw);
        }

        if (Object.keys(alreadyApplied).length > 0) {
          void safeStorageSet(`${SETTINGS_CACHE_PREFIX}${accountId}`, JSON.stringify(merged));
        }
      } catch {
        // Ignore malformed cached settings JSON
      }
    };

    void hydrateSettings();

    return () => {
      cancelled = true;
    };
  }, [accountId, configurationScope]);

  // 2. Suscripción reactiva a cambios en cola offline y retorno a primer plano
  useEffect(() => {
    let isMounted = true;
    void refreshOfflineCount();

    const unsubscribeQueue = subscribeOfflineQueueChanges((event) => {
      if (!isMounted) return;
      void refreshOfflineCount();
      if (event.type === 'synced' && (event.successful || 0) > 0) {
        refreshCashStatusRef.current();
      }
    });

    const appStateSubscription =
      typeof AppState?.addEventListener === 'function'
        ? AppState.addEventListener('change', (nextState) => {
            if (!isMounted || nextState !== 'active') return;
            const activeAccountId = accountIdRef.current;
            if (!isOnlineRef.current || !activeAccountId) return;
            void refreshOfflineCount().then((count) => {
              if (isMounted && isOnlineRef.current && count > 0) {
                processOfflineQueue(activeAccountId).catch((err) => {
                  console.warn(
                    '[SettingsContext] Error sincronizando cola offline al volver a primer plano:',
                    err
                  );
                });
              }
            });
          })
        : null;

    return () => {
      isMounted = false;
      unsubscribeQueue();
      appStateSubscription?.remove?.();
    };
  }, [refreshOfflineCount]);

  // 2.1. Sincronizar cola offline al arrancar online o tras transición offline -> online
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerSync = (targetAccountId: string) => {
      processOfflineQueue(targetAccountId)
        .then(() => {
          if (isMounted) void refreshOfflineCount();
        })
        .catch((err) => {
          console.warn('[SettingsContext] Error procesando cola offline:', err);
        });
    };

    if (isOnline && accountId) {
      const currentScope = `${user?.uid || ''}:${accountId}`;
      if (wasOfflineRef.current) {
        startupSyncAttemptedScopeRef.current = currentScope;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (isMounted && isOnlineRef.current) {
            triggerSync(accountId);
          }
        }, 1_500);
      } else if (startupSyncAttemptedScopeRef.current !== currentScope) {
        startupSyncAttemptedScopeRef.current = currentScope;
        void refreshOfflineCount().then((count) => {
          if (isMounted && isOnlineRef.current && count > 0) {
            triggerSync(accountId);
          }
        });
      }
    } else if (!accountId) {
      startupSyncAttemptedScopeRef.current = '';
    }

    wasOfflineRef.current = !isOnline;

    return () => {
      isMounted = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
  }, [accountId, user?.uid, isOnline, refreshOfflineCount]);

  // 3. Cada listener entrega el valor inicial y las actualizaciones sin duplicar lecturas.
  useEffect(() => {
    if (!accountId) return;

    // 3.1. Ajustes de apariencia
    const appearanceRef = doc(db, 'settings', `${accountId}_appearance`);
    const applyAppearance = (snap: any) => {
      if (snap.exists()) {
        authoritativeSettingsRef.current.appearance = true;
        const data = snap.data();
        if (data.primaryColor) {
          setPrimaryColor(data.primaryColor);
          persistSettingsSnapshot(accountId, { primaryColor: data.primaryColor });
        }
      }
    };
    const unsubAppearance = subscribeLiveDocument(
      appearanceRef,
      applyAppearance,
      (err) => console.warn('[SettingsContext] appearance snapshot error:', err)
    );

    // 3.2. Información de negocio (RUC, razón social, dirección, teléfono, logo, series)
    const businessRef = doc(db, 'settings', `${accountId}_business`);
    const applyBusiness = (snap: any) => {
      if (!snap.exists()) {
        if (
          snap.metadata?.fromCache === true &&
          (!isOnlineRef.current || hasHydratedSettingsRef.current)
        ) {
          return;
        }
        const defaultBiz = { ...DEFAULT_BUSINESS_SETTINGS, accountId };
        setBusinessSettings(defaultBiz);
        if (snap.metadata?.fromCache === false) {
          authoritativeSettingsRef.current.business = true;
          persistSettingsSnapshot(accountId, { businessSettings: defaultBiz });
        }
        return;
      }

      authoritativeSettingsRef.current.business = true;
      const data = snap.data();
      const loadedBiz: BusinessSettings = {
        id: snap.id,
        accountId,
        businessName: data.businessName || data.name || 'Ventify POS',
        description: data.description || '',
        ruc: data.ruc || data.taxId || '',
        address: data.address || data.fiscalAddress || '',
        phone: data.phone || data.commercialPhone || '',
        email: data.email || '',
        website: data.website || '',
        enableFractionalUnits: data.enableFractionalUnits !== false,
        enableMinSalePrice: data.enableMinSalePrice !== false,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        ...data,
      };
      setBusinessSettings(loadedBiz);
      persistSettingsSnapshot(accountId, { businessSettings: loadedBiz });
    };
    const unsubBusiness = subscribeLiveDocument(
      businessRef,
      applyBusiness,
      (err) => console.warn('[SettingsContext] business snapshot error:', err)
    );

    // 3.3. Configuración del POS (métodos de pago habilitados, Yape/Plin, pie de ticket, comprobante por defecto)
    const posRef = doc(db, 'settings', `${accountId}_pos`);
    const applyPos = (snap: any) => {
      if (snap.exists() || snap.metadata?.fromCache === false) {
        setConfiguration((previous) => ({
          ...(previous.scope === configurationScope
            ? previous
            : { scope: configurationScope, pos: false, account: false, posError: null, accountError: null }),
          pos: true,
          posError: null,
        }));
      }
      if (!snap.exists()) {
        if (
          snap.metadata?.fromCache === true &&
          (!isOnlineRef.current || hasHydratedSettingsRef.current)
        ) {
          return;
        }
        const defaultPos = { ...DEFAULT_POS_SETTINGS, id: `${accountId}_pos`, accountId };
        setPosSettings(defaultPos);
        setAllPaymentMethods(DEFAULT_PAYMENT_METHODS);
        if (snap.metadata?.fromCache === false) {
          authoritativeSettingsRef.current.pos = true;
          persistSettingsSnapshot(accountId, {
            posSettings: defaultPos,
            allPaymentMethods: DEFAULT_PAYMENT_METHODS,
          });
        }
        return;
      }

      authoritativeSettingsRef.current.pos = true;
      const data = snap.data();

      const loadedPosSettings: PosSettings = {
        id: snap.id,
        accountId,
        methods: Array.isArray(data.methods) && data.methods.length > 0
          ? data.methods
          : DEFAULT_PAYMENT_METHODS,
        allowMixedPayment: data.allowMixedPayment !== false,
        enableQuickSale: data.enableQuickSale !== false,
        enableLinkedScanner: data.enableLinkedScanner === true,
        enableDeviceCameraScanner: data.enableDeviceCameraScanner !== false,
        enableCatalogFilters: data.enableCatalogFilters !== false,
        enableMobileBarcodeScanner: data.enableMobileBarcodeScanner !== false,
        enableSellerAttribution: data.enableSellerAttribution === true,
        requireSellerSelection: data.requireSellerSelection === true,
        defaultMethodId: data.defaultMethodId || 'efectivo',
        ticketTemplate: data.ticketTemplate || 'standard',
        ...data,
      };

      setPosSettings(loadedPosSettings);

      let formattedMethods: PosPaymentMethodConfig[];
      if (Array.isArray(data.methods) && data.methods.length > 0) {
        formattedMethods = data.methods
          .filter((m: any) => m.kind !== 'mixed')
          .sort((a: any, b: any) => (a.order || 0) - (b.order || 0))
          .map((m: any, idx: number) => ({
            ...m,
            id: m.id,
            name: m.name,
            kind: m.kind || 'digital',
            enabled: m.enabled !== false,
            order: m.order ?? idx,
            reportCategory: m.reportCategory || (m.kind === 'cash' ? 'cash' : 'digital'),
            qrUrl: m.qrUrl,
            qrLabel: m.qrLabel,
            provider: m.provider,
          }));
      } else {
        formattedMethods = DEFAULT_PAYMENT_METHODS;
      }
      setAllPaymentMethods(formattedMethods);
      persistSettingsSnapshot(accountId, {
        posSettings: loadedPosSettings,
        allPaymentMethods: formattedMethods,
      });
    };
    const unsubPos = subscribeLiveDocument(
      posRef,
      applyPos,
      (err) => {
        console.warn('[SettingsContext] pos snapshot error:', err);
        if (!isOnlineRef.current && hasHydratedSettingsRef.current) return;
        setConfiguration((previous) => ({
          ...(previous.scope === configurationScope
            ? previous
            : { scope: configurationScope, pos: false, account: false, posError: null, accountError: null }),
          pos: false,
          posError: 'No se pudo cargar la configuración de pagos. Comprueba la conexión y pulsa Reintentar.',
        }));
      }
    );

    // 3.4. Estado de la cuenta y permisos de facturación electrónica (Super Admin)
    const accountRef = doc(db, 'accounts', accountId);
    const applyAccount = (snap: any) => {
      if (snap.exists() || snap.metadata?.fromCache === false) {
        setConfiguration((previous) => ({
          ...(previous.scope === configurationScope
            ? previous
            : { scope: configurationScope, pos: false, account: false, posError: null, accountError: null }),
          account: true,
          accountError: null,
        }));
      }
      if (!snap.exists()) {
        if (
          snap.metadata?.fromCache === true &&
          (!isOnlineRef.current || hasHydratedSettingsRef.current)
        ) {
          return;
        }
        setInvoicingEnabled(false);
        if (snap.metadata?.fromCache === false) {
          authoritativeSettingsRef.current.account = true;
          persistSettingsSnapshot(accountId, { invoicingEnabled: false });
        }
        return;
      }

      authoritativeSettingsRef.current.account = true;
      const data = snap.data();
      const enabled = Boolean(data.invoicingEnabled);
      setInvoicingEnabled(enabled);
      persistSettingsSnapshot(accountId, { invoicingEnabled: enabled });
    };
    const unsubAccount = subscribeLiveDocument(
      accountRef,
      applyAccount,
      (err) => {
        console.warn('[SettingsContext] account snapshot error:', err);
        if (!isOnlineRef.current && hasHydratedSettingsRef.current) return;
        setConfiguration((previous) => ({
          ...(previous.scope === configurationScope
            ? previous
            : { scope: configurationScope, pos: false, account: false, posError: null, accountError: null }),
          account: false,
          accountError: 'No se pudo verificar la configuración de comprobantes. Comprueba la conexión y pulsa Reintentar.',
        }));
      }
    );

    // 3.5. Reglas de promociones y regalos (`settings/${accountId}_discounts`)
    const discountsRef = doc(db, 'settings', `${accountId}_discounts`);
    const applyDiscounts = (snap: any) => {
      if (!snap.exists()) {
        if (
          snap.metadata?.fromCache === true &&
          (!isOnlineRef.current || hasHydratedSettingsRef.current)
        ) {
          return;
        }
        const defaultDiscounts = { ...DEFAULT_DISCOUNT_SETTINGS };
        setDiscountSettings(defaultDiscounts);
        if (snap.metadata?.fromCache === false) {
          authoritativeSettingsRef.current.discounts = true;
          persistSettingsSnapshot(accountId, { discountSettings: defaultDiscounts });
        }
        return;
      }

      authoritativeSettingsRef.current.discounts = true;
      const d = snap.data() || {};
      const nextDiscounts: DiscountSettings = {
        enableGifts: d.enableGifts !== false,
        giftProductIds: Array.isArray(d.giftProductIds) ? d.giftProductIds : undefined,
        promotions: Array.isArray(d.promotions) ? d.promotions : [],
        updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : undefined,
      };
      setDiscountSettings(nextDiscounts);
      persistSettingsSnapshot(accountId, { discountSettings: nextDiscounts });
    };
    const unsubDiscounts = subscribeLiveDocument(
      discountsRef,
      applyDiscounts,
      (err) => console.warn('[SettingsContext] discounts snapshot error:', err)
    );

    return () => {
      unsubAppearance();
      unsubBusiness();
      unsubPos();
      unsubAccount();
      unsubDiscounts();
    };
  }, [accountId, configurationScope, configurationTick, persistSettingsSnapshot]);

  // 3.5. Perfil tributario IGV/Amazonía y resolución SUNAT desde /api/invoicing/config
  useEffect(() => {
    if (!accountId || !user?.uid) {
      setInvoicingConfigRaw(null);
      return;
    }
    if (!isOnline || !APP_URL) {
      // Preservar configuración cacheada cuando el dispositivo pierde conectividad temporalmente
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const loadInvoicingPublicConfig = async () => {
      try {
        const token = await auth?.currentUser?.getIdToken?.();
        if (!token || cancelled) return;
        const url = `${APP_URL}/api/invoicing/config?accountId=${encodeURIComponent(accountId)}`;
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-ventify-client': 'v3',
          },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.success && data?.config) {
          const nextInvoicingConfig = {
            isAmazonExempt: data.config.isAmazonExempt,
            taxExemptionCode: data.config.taxExemptionCode,
            taxRate: data.config.taxRate,
            printedFormatResolution: data.config.printedFormatResolution ?? null,
            emitterRuc: data.config.emitter?.ruc,
            emitterRazonSocial: data.config.emitter?.razonSocial,
            emitterNombreComercial: data.config.emitter?.nombreComercial,
          };
          authoritativeSettingsRef.current.invoicingConfig = true;
          setInvoicingConfigRaw(nextInvoicingConfig);
          persistSettingsSnapshot(accountId, { invoicingConfigRaw: nextInvoicingConfig });
        }
      } catch {
        // Silencioso: opera con fallback de businessSettings si no hay red o endpoint no configurado
      } finally {
        clearTimeout(timeoutId);
      }
    };

    loadInvoicingPublicConfig();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [accountId, user?.uid, isOnline, configurationTick, persistSettingsSnapshot]);

  // 4. Suscripción a sucursales de la cuenta
  useEffect(() => {
    if (!accountId) return;

    const branchesQ = query(
      collection(db, 'branches'),
      where('accountId', '==', accountId)
    );

    const applyBranchesSnap = (snap: any) => {
      if (
        snap.empty &&
        snap.metadata?.fromCache === true &&
        (!isOnlineRef.current || hasHydratedSettingsRef.current)
      ) {
        return;
      }

      authoritativeSettingsRef.current.branches = true;
      const list: Branch[] = snap.docs.map((d: any) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name || 'Sucursal',
          address: data.address || data.commercialAddress || '',
          phone: data.phone || '',
          email: data.email || '',
          accountId,
          isActive: data.isActive !== false,
          ruc: data.ruc,
          commercialAddress: data.commercialAddress,
          fiscalAddress: data.fiscalAddress,
          receiptLogo: data.receiptLogo,
          receiptFooter: data.receiptFooter,
          ...data,
        };
      });

      const activeList = list.filter((b) => b.isActive !== false);
      setBranches(activeList);
      reconcileActiveBranches(activeList);

      if (!snap.empty || snap.metadata?.fromCache === false) {
        persistSettingsSnapshot(accountId, { branches: activeList });
      }
    };

    const unsubBranches = onSnapshot(
      branchesQ,
      applyBranchesSnap,
      (err) => console.warn('[SettingsContext] branches snapshot error:', err)
    );

    return () => unsubBranches();
  }, [accountId, persistSettingsSnapshot, reconcileActiveBranches]);

  // 5. Verificación y resolución determinista de la sesión activa de caja
  const checkActiveSession = useCallback(async (knownSessionId?: string | null): Promise<ActiveCashSessionData | null> => {
    if (!accountId || !user?.uid) {
      activeCashSessionRef.current = null;
      setIsCashOpen(false);
      setActiveCashSession(null);
      return null;
    }
    const effectiveBranch = branchId || 'main';
    const cashKey = getCashSessionCacheKey(accountId, effectiveBranch, user.uid);
    const checkScope = `${accountId}:${effectiveBranch}:${user.uid}:${knownSessionId || ''}`;
    if (inFlightCashCheckRef.current?.scope === checkScope) {
      return inFlightCashCheckRef.current.promise;
    }

    const getHydratedOrCachedSession = async (): Promise<ActiveCashSessionData | null> => {
      if (hydratedCashSessionRef.current?.key === cashKey) {
        return hydratedCashSessionRef.current.session;
      }
      if (cashHydrationPromiseRef.current?.key === cashKey) {
        const hydrated = await cashHydrationPromiseRef.current.promise;
        if (hydrated) return hydrated;
      }
      const raw = await safeStorageGet(cashKey);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as ActiveCashSessionData | null;
        if (parsed && parsed.id && parsed.status === 'open') {
          hydratedCashSessionRef.current = { key: cashKey, session: parsed };
          return parsed;
        }
      } catch {
        // Ignore malformed cached session JSON
      }
      return null;
    };

    const buildSessionObj = (
      sessionId: string,
      pointerId: string,
      data: Record<string, any>,
      fallbackInitialAmount?: number
    ): ActiveCashSessionData => ({
      id: sessionId,
      sessionId,
      pointerId,
      branchId: data.branchId || effectiveBranch,
      accountId,
      status: 'open',
      initialAmount: Number(data.initialAmount ?? fallbackInitialAmount ?? 0),
      openTime: Number(data.openTime ?? data.openedAt ?? Date.now()),
      startedBy: data.startedBy || user.uid,
      startedByName: data.startedByName || user?.displayName || '',
      cashSales: Number(data.cashSales ?? 0),
      totalSales: Number(data.totalSales ?? 0),
      expectedAmount: Number(data.expectedAmount ?? data.initialAmount ?? 0),
      isOpen: true,
      ...data,
    });

    const runCheck = async (): Promise<ActiveCashSessionData | null> => {
      let ptrReadFailed = false;
      let queryReadFailed = false;
      let serverConfirmedClosed = false;

      try {
        // 1. Verificar puntero determinista exclusivo del operador
        const userPtrId = `active_${accountId}_${effectiveBranch}_${user.uid}`;
        try {
          let activeSessionId = knownSessionId || null;
          let ptrInitialAmount: number | undefined;

          if (!activeSessionId) {
            const ptrSnap = await getDoc(doc(db, 'cash_register_sessions', userPtrId));
            if (ptrSnap.exists()) {
              const ptrData = ptrSnap.data();
              activeSessionId = ptrData.activeSessionId || ptrData.sessionId || null;
              ptrInitialAmount = ptrData.initialAmount;
            }
          }

          if (activeSessionId) {
            const sessSnap = await getDoc(doc(db, 'cash_register_sessions', activeSessionId));
            if (sessSnap.exists() && sessSnap.data()?.status === 'open') {
              const sData = sessSnap.data();
              // Validar que realmente sea de este operador
              if (!sData.startedBy || sData.startedBy === user.uid) {
                const sessionObj = buildSessionObj(activeSessionId, userPtrId, sData, ptrInitialAmount);
                hydratedCashSessionRef.current = { key: cashKey, session: sessionObj };
                activeCashSessionRef.current = sessionObj;
                if ((sessSnap as any).metadata?.fromCache === false || isOnlineRef.current) {
                  serverConfirmedCashScopeRef.current = cashKey;
                }
                setIsCashOpen(true);
                setActiveCashSession(sessionObj);
                void safeStorageSet(cashKey, JSON.stringify(sessionObj));
                return sessionObj;
              }
            }
          }
        } catch (ptrErr) {
          ptrReadFailed = true;
          console.warn('[SettingsContext] Error reading user pointer:', ptrErr);
        }

        // 2. Fallback de operador: consultar en Firestore sesión abierta donde startedBy == user.uid
        try {
          const q = query(
            collection(db, 'cash_register_sessions'),
            where('accountId', '==', accountId),
            where('branchId', '==', effectiveBranch),
            where('status', '==', 'open'),
            where('startedBy', '==', user.uid)
          );
          const snap = await getDocs(q);
          if (!snap.empty) {
            const target = snap.docs[0];
            const data = target.data();
            const sId = target.id;
            const sessionObj = buildSessionObj(sId, userPtrId, data);

            // Reparar puntero del operador para lecturas directas ultra-rápidas
            try {
              await setDoc(
                doc(db, 'cash_register_sessions', userPtrId),
                {
                  activeSessionId: sId,
                  branchId: effectiveBranch,
                  accountId,
                  startedBy: user.uid,
                  status: 'open',
                  lastUpdated: serverTimestamp(),
                },
                { merge: true }
              );
            } catch {}

            hydratedCashSessionRef.current = { key: cashKey, session: sessionObj };
            activeCashSessionRef.current = sessionObj;
            if ((snap as any).metadata?.fromCache === false || isOnlineRef.current) {
              serverConfirmedCashScopeRef.current = cashKey;
            }
            setIsCashOpen(true);
            setActiveCashSession(sessionObj);
            void safeStorageSet(cashKey, JSON.stringify(sessionObj));
            return sessionObj;
          } else {
            const fromCache = (snap as any).metadata?.fromCache;
            const confirmedEmptyServerQuery =
              fromCache === false || (isOnlineRef.current && fromCache !== true);
            if (confirmedEmptyServerQuery && !ptrReadFailed) {
              serverConfirmedClosed = true;
            }
          }
        } catch (queryErr) {
          queryReadFailed = true;
          console.warn('[SettingsContext] Fallback query by operator failed:', queryErr);
        }

        // Sin confirmación autoritativa del servidor o ante error/offline: preservar sesión cacheada
        if (!serverConfirmedClosed || ptrReadFailed || queryReadFailed || !isOnlineRef.current) {
          const cachedSession = await getHydratedOrCachedSession();
          if (cachedSession) {
            activeCashSessionRef.current = cachedSession;
            setIsCashOpen(true);
            setActiveCashSession(cachedSession);
            return cachedSession;
          }
        }

        // Servidor confirmó con cero errores que la caja está cerrada: limpiar caché
        if (serverConfirmedClosed) {
          serverConfirmedCashScopeRef.current = cashKey;
          hydratedCashSessionRef.current = null;
          void safeStorageRemove(cashKey);
        }

        activeCashSessionRef.current = null;
        setIsCashOpen(false);
        setActiveCashSession(null);
        return null;
      } catch (err) {
        console.warn('[SettingsContext] checkActiveSession error:', err);
        const cachedSession = await getHydratedOrCachedSession();
        if (cachedSession) {
          activeCashSessionRef.current = cachedSession;
          setIsCashOpen(true);
          setActiveCashSession(cachedSession);
          return cachedSession;
        }
        activeCashSessionRef.current = null;
        setIsCashOpen(false);
        setActiveCashSession(null);
        return null;
      }
    };

    const promise = runCheck().finally(() => {
      if (inFlightCashCheckRef.current?.promise === promise) {
        inFlightCashCheckRef.current = null;
      }
    });
    inFlightCashCheckRef.current = { scope: checkScope, promise };
    return promise;
  }, [accountId, branchId, user?.uid, user?.displayName]);

  const refreshCashStatus = useCallback(() => {
    void checkActiveSession();
  }, [checkActiveSession]);
  refreshCashStatusRef.current = refreshCashStatus;

  // Suscripción en tiempo real al estado de la Caja e hidratación offline
  useEffect(() => {
    if (!accountId || !user?.uid) {
      cashScopeRef.current = null;
      hydratedCashSessionRef.current = null;
      serverConfirmedCashScopeRef.current = null;
      cashHydrationPromiseRef.current = null;
      activeCashSessionRef.current = null;
      setIsCashOpen(false);
      setActiveCashSession(null);
      return;
    }

    let isSubscribed = true;
    let initialResolved = false;

    const effectiveBranch = branchId || 'main';
    const cashKey = getCashSessionCacheKey(accountId, effectiveBranch, user.uid);
    const pointerId = `active_${accountId}_${effectiveBranch}_${user.uid}`;

    if (cashScopeRef.current !== cashKey) {
      cashScopeRef.current = cashKey;
      hydratedCashSessionRef.current = null;
      serverConfirmedCashScopeRef.current = null;
      activeCashSessionRef.current = null;
      setIsCashOpen(false);
      setActiveCashSession(null);
    }

    const hydrateCashSession = async (): Promise<ActiveCashSessionData | null> => {
      const raw = await safeStorageGet(cashKey);
      if (!isSubscribed || !raw) return null;
      try {
        const parsed = JSON.parse(raw) as ActiveCashSessionData | null;
        if (!parsed || !parsed.id || parsed.status !== 'open') return null;
        hydratedCashSessionRef.current = { key: cashKey, session: parsed };
        if (
          serverConfirmedCashScopeRef.current !== cashKey &&
          !activeCashSessionRef.current
        ) {
          activeCashSessionRef.current = parsed;
          setIsCashOpen(true);
          setActiveCashSession(parsed);
        }
        return parsed;
      } catch {
        return null;
      }
    };

    cashHydrationPromiseRef.current = { key: cashKey, promise: hydrateCashSession() };

    const unsubPointer = onSnapshot(
      doc(db, 'cash_register_sessions', pointerId),
      (snap) => {
        if (!isSubscribed) return;
        if (!snap.exists() && snap.metadata?.fromCache === true && !isOnlineRef.current) {
          return;
        }
        const data = snap.exists() ? snap.data() : null;
        const nextSessionId = data?.activeSessionId || data?.sessionId || null;
        const currentSessionId = activeCashSessionRef.current?.id || null;

        if (!nextSessionId || data?.status === 'closed') {
          if (!initialResolved) {
            initialResolved = true;
            void checkActiveSession();
          } else if (activeCashSessionRef.current) {
            const serverConfirmed =
              snap.metadata?.fromCache === false ||
              (isOnlineRef.current && snap.metadata?.fromCache !== true);
            if (serverConfirmed) {
              serverConfirmedCashScopeRef.current = cashKey;
              hydratedCashSessionRef.current = null;
              activeCashSessionRef.current = null;
              setIsCashOpen(false);
              setActiveCashSession(null);
              void safeStorageRemove(cashKey);
            }
          }
        } else if (!initialResolved || nextSessionId !== currentSessionId) {
          initialResolved = true;
          void checkActiveSession(nextSessionId);
        } else {
          initialResolved = true;
        }
      },
      (err) => {
        console.warn('[SettingsContext] pointer listener note:', err);
        if (isSubscribed && !initialResolved) {
          initialResolved = true;
          void checkActiveSession();
        }
      }
    );

    return () => {
      isSubscribed = false;
      unsubPointer();
    };
  }, [accountId, branchId, user?.uid, checkActiveSession]);

  // 6. Actualizar datos de configuración de empresa
  const updateBusinessSettings = useCallback(
    async (patch: Partial<BusinessSettings>) => {
      if (!accountId) return;
      const cleanPatch = Object.fromEntries(
        Object.entries(patch).filter(([_, v]) => v !== undefined)
      );
      await setDoc(
        doc(db, 'settings', `${accountId}_business`),
        {
          ...cleanPatch,
          accountId,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [accountId]
  );

  // 7. Actualizar parámetros y métodos del POS
  const updatePosSettings = useCallback(
    async (patch: Partial<PosSettings>) => {
      if (!accountId) return;
      const cleanPatch = Object.fromEntries(
        Object.entries(patch).filter(([_, v]) => v !== undefined)
      );
      await setDoc(
        doc(db, 'settings', `${accountId}_pos`),
        {
          ...cleanPatch,
          accountId,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [accountId]
  );

  // 8. Activar o desactivar un método de pago
  const togglePaymentMethod = useCallback(
    async (methodId: string, enabled: boolean) => {
      if (!accountId) return;
      const updated = allPaymentMethods.map((m) =>
        m.id === methodId ? { ...m, enabled } : m
      );
      setAllPaymentMethods(updated);

      await setDoc(
        doc(db, 'settings', `${accountId}_pos`),
        {
          accountId,
          methods: updated.map((m, idx) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            enabled: m.enabled,
            order: idx,
            reportCategory: m.reportCategory,
            provider: m.provider,
            qrUrl: m.qrUrl,
            qrLabel: m.qrLabel,
          })),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    },
    [accountId, allPaymentMethods]
  );

  // Métodos de pago activos filtrados para la pantalla de cobro
  const paymentMethods = useMemo(() => {
    const enabledOnly = allPaymentMethods.filter((m) => m.enabled !== false);
    return enabledOnly.length > 0 ? enabledOnly : DEFAULT_PAYMENT_METHODS;
  }, [allPaymentMethods]);

  const activeBranch = useMemo(
    () => branches.find((b) => b.id === branchId) || null,
    [branches, branchId]
  );

  const activeBranchName = useMemo(
    () => activeBranch?.name || businessSettings.businessName || 'Tienda Principal',
    [activeBranch, businessSettings.businessName]
  );

  const scopedBusinessSettings = useMemo(() => {
    const base =
      businessSettings.accountId === accountId
        ? businessSettings
        : { ...DEFAULT_BUSINESS_SETTINGS, accountId: accountId || '' };
    if (!invoicingConfigRaw) return base;
    return {
      ...base,
      isAmazonExempt: invoicingConfigRaw.isAmazonExempt ?? base.isAmazonExempt,
      taxExemptionCode: invoicingConfigRaw.taxExemptionCode ?? base.taxExemptionCode,
      taxRate: invoicingConfigRaw.taxRate ?? base.taxRate,
      printedFormatResolution:
        invoicingConfigRaw.printedFormatResolution || base.printedFormatResolution,
      ruc: base.ruc || invoicingConfigRaw.emitterRuc || '',
    };
  }, [accountId, businessSettings, invoicingConfigRaw]);

  const taxProfile = useMemo(
    () =>
      resolveAccountTaxProfile({
        isAmazonExempt: scopedBusinessSettings.isAmazonExempt,
        taxExemptionCode: scopedBusinessSettings.taxExemptionCode,
        taxRate: scopedBusinessSettings.taxRate,
      }),
    [scopedBusinessSettings]
  );

  const emitterInfo = useMemo(() => {
    if (!invoicingConfigRaw) return null;
    return {
      ruc: invoicingConfigRaw.emitterRuc,
      razonSocial: invoicingConfigRaw.emitterRazonSocial,
      nombreComercial: invoicingConfigRaw.emitterNombreComercial,
      printedFormatResolution: invoicingConfigRaw.printedFormatResolution ?? null,
    };
  }, [invoicingConfigRaw]);

  const contextValue = useMemo(
    () => ({
      configurationReady,
      configurationError,
      refreshConfiguration,
      primaryColor,
      businessName: scopedBusinessSettings.businessName || 'Ventify POS',
      businessSettings: scopedBusinessSettings,
      businessData: scopedBusinessSettings,
      posSettings,
      discountSettings,
      branches,
      activeBranchName,
      activeBranch,
      isCashOpen,
      activeCashSession,
      invoicingEnabled,
      taxProfile,
      emitterInfo,
      paymentMethods,
      allPaymentMethods,
      isOnline,
      offlineQueueCount,
      pendingOfflineSales,
      refreshOfflineCount,
      updateBusinessSettings,
      updateBusinessData: updateBusinessSettings,
      updatePosSettings,
      togglePaymentMethod,
      refreshCashStatus,
    }),
    [
      configurationReady,
      configurationError,
      refreshConfiguration,
      primaryColor,
      scopedBusinessSettings,
      posSettings,
      discountSettings,
      branches,
      activeBranchName,
      activeBranch,
      isCashOpen,
      activeCashSession,
      invoicingEnabled,
      taxProfile,
      emitterInfo,
      paymentMethods,
      allPaymentMethods,
      isOnline,
      offlineQueueCount,
      pendingOfflineSales,
      refreshOfflineCount,
      updateBusinessSettings,
      updatePosSettings,
      togglePaymentMethod,
      refreshCashStatus,
    ]
  );

  return <SettingsContext.Provider value={contextValue}>{children}</SettingsContext.Provider>;
};

export const useSettings = () => useContext(SettingsContext);
