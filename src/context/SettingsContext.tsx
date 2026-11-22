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
import { useAuthSession, useNetworkStatus } from './AuthContext';
import { hasAllBranchesAccess } from '@/lib/branch-access';
import { metaKVStorage } from '@/lib/native-kv-storage';
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
const SETTINGS_PERSIST_DEBOUNCE_MS = 400;

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

const isTimestampLike = (val: unknown): val is { seconds: number; nanoseconds: number } =>
  typeof val === 'object' &&
  val !== null &&
  typeof (val as any).seconds === 'number' &&
  typeof (val as any).nanoseconds === 'number';

const isStructurallyEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (isTimestampLike(a) && isTimestampLike(b)) {
    return a.seconds === b.seconds && a.nanoseconds === b.nanoseconds;
  }
  if (typeof (a as any).isEqual === 'function' && typeof (b as any).isEqual === 'function') {
    try {
      return Boolean((a as any).isEqual(b));
    } catch {
      return false;
    }
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!isStructurallyEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  for (let i = 0; i < aKeys.length; i += 1) {
    const key = aKeys[i];
    const aVal = aObj[key];
    if (aVal === undefined) continue;
    if (!isStructurallyEqual(aVal, bObj[key])) return false;
  }
  const bKeys = Object.keys(bObj);
  for (let i = 0; i < bKeys.length; i += 1) {
    const key = bKeys[i];
    if (bObj[key] !== undefined && aObj[key] === undefined) return false;
  }
  return true;
};

const safeStorageGetSync = (key: string): string | null => {
  if (!metaKVStorage?.isSyncCapable) return null;
  try {
    const value = metaKVStorage.getItemSync(key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const parseCachedAccountSettings = (raw: string | null): CachedAccountSettings | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedAccountSettings | null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseCachedCashSession = (raw: string | null): ActiveCashSessionData | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActiveCashSessionData | null;
    return parsed && typeof parsed === 'object' && parsed.id && parsed.status === 'open'
      ? parsed
      : null;
  } catch {
    return null;
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

export interface BusinessSettingsContextType {
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
  updateBusinessSettings: (patch: Partial<BusinessSettings>) => Promise<void>;
  updateBusinessData: (patch: Partial<BusinessSettings>) => Promise<void>;
  updatePosSettings: (patch: Partial<PosSettings>) => Promise<void>;
  togglePaymentMethod: (methodId: string, enabled: boolean) => Promise<void>;
}

export interface CashSessionContextType {
  isCashOpen: boolean;
  activeCashSession: ActiveCashSessionData | null;
  refreshCashStatus: () => void;
}

export interface OfflineStatusContextType {
  isOnline: boolean;
  offlineQueueCount: number;
  pendingOfflineSales: PendingOfflineSale[];
  refreshOfflineCount: () => Promise<number>;
}

export interface SettingsContextType
  extends BusinessSettingsContextType,
    CashSessionContextType,
    OfflineStatusContextType {}

const DEFAULT_TAX_PROFILE: AccountTaxProfile = {
  isAmazonExempt: false,
  taxExemptionCode: '10',
  taxRate: 18,
};

const DEFAULT_BUSINESS_SETTINGS_CONTEXT: BusinessSettingsContextType = {
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
  invoicingEnabled: false,
  taxProfile: DEFAULT_TAX_PROFILE,
  emitterInfo: null,
  paymentMethods: DEFAULT_PAYMENT_METHODS,
  allPaymentMethods: DEFAULT_PAYMENT_METHODS,
  updateBusinessSettings: async () => {},
  updateBusinessData: async () => {},
  updatePosSettings: async () => {},
  togglePaymentMethod: async () => {},
};

const DEFAULT_CASH_SESSION_CONTEXT: CashSessionContextType = {
  isCashOpen: false,
  activeCashSession: null,
  refreshCashStatus: () => {},
};

const DEFAULT_OFFLINE_STATUS_CONTEXT: OfflineStatusContextType = {
  isOnline: true,
  offlineQueueCount: 0,
  pendingOfflineSales: [],
  refreshOfflineCount: async () => 0,
};

const BusinessSettingsContext = createContext<BusinessSettingsContextType>(
  DEFAULT_BUSINESS_SETTINGS_CONTEXT
);
const CashSessionContext = createContext<CashSessionContextType>(DEFAULT_CASH_SESSION_CONTEXT);
const OfflineStatusContext = createContext<OfflineStatusContextType>(
  DEFAULT_OFFLINE_STATUS_CONTEXT
);

const SettingsContext = createContext<SettingsContextType>({
  ...DEFAULT_BUSINESS_SETTINGS_CONTEXT,
  ...DEFAULT_CASH_SESSION_CONTEXT,
  ...DEFAULT_OFFLINE_STATUS_CONTEXT,
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
  } = useAuthSession();
  const { isOnline } = useNetworkStatus();
  const configurationScope = `${user?.uid || ''}:${accountId || ''}`;
  const effectiveBranch = branchId || 'main';

  const legacyFallbackCheckedRef = useRef<Set<string>>(new Set());
  const legacyPendingMigrationRef = useRef<Set<string>>(new Set());

  const safeStorageGet = useCallback(
    async (key: string): Promise<{ value: string | null; fromLegacy: boolean }> => {
      try {
        const value = await Promise.resolve(metaKVStorage?.getItem?.(key));
        if (typeof value === 'string') {
          return { value, fromLegacy: false };
        }
      } catch {
        // Fallback below
      }

      if (metaKVStorage?.isSyncCapable && !legacyFallbackCheckedRef.current.has(key)) {
        legacyFallbackCheckedRef.current.add(key);
        try {
          const legacyVal = await Promise.resolve(AsyncStorage?.getItem?.(key));
          if (typeof legacyVal === 'string') {
            legacyPendingMigrationRef.current.add(key);
            return { value: legacyVal, fromLegacy: true };
          }
        } catch {
          // Ignore legacy read error
        }
      }

      return { value: null, fromLegacy: false };
    },
    []
  );

  const safeStorageSet = useCallback(async (key: string, value: string): Promise<void> => {
    try {
      await Promise.resolve(metaKVStorage?.setItem?.(key, value));
      if (legacyPendingMigrationRef.current.has(key)) {
        legacyPendingMigrationRef.current.delete(key);
        await Promise.resolve(AsyncStorage?.removeItem?.(key)).catch(() => {});
      }
    } catch {
      // Ignore storage persistence errors
    }
  }, []);

  const safeStorageRemove = useCallback(async (key: string): Promise<void> => {
    try {
      await Promise.resolve(metaKVStorage?.removeItem?.(key));
    } catch {
      // Ignore storage removal errors
    }
    if (metaKVStorage?.isSyncCapable) {
      legacyPendingMigrationRef.current.delete(key);
      try {
        await Promise.resolve(AsyncStorage?.removeItem?.(key));
      } catch {
        // Ignore legacy removal errors
      }
    }
  }, []);

  const initialSyncSettingsRef = useRef<
    { accountId: string; data: CachedAccountSettings } | null | undefined
  >(undefined);
  if (initialSyncSettingsRef.current === undefined) {
    initialSyncSettingsRef.current =
      accountId && metaKVStorage?.isSyncCapable
        ? (() => {
            const parsed = parseCachedAccountSettings(
              safeStorageGetSync(`${SETTINGS_CACHE_PREFIX}${accountId}`)
            );
            return parsed ? { accountId, data: parsed } : null;
          })()
        : null;
  }

  const initialSyncCashRef = useRef<
    { key: string; session: ActiveCashSessionData } | null | undefined
  >(undefined);
  if (initialSyncCashRef.current === undefined) {
    initialSyncCashRef.current =
      accountId && user?.uid && metaKVStorage?.isSyncCapable
        ? (() => {
            const key = getCashSessionCacheKey(accountId, effectiveBranch, user.uid);
            const parsed = parseCachedCashSession(safeStorageGetSync(key));
            return parsed ? { key, session: parsed } : null;
          })()
        : null;
  }

  const initialCached = initialSyncSettingsRef.current?.data;
  const initialCash = initialSyncCashRef.current?.session ?? null;

  const [configuration, setConfiguration] = useState(() => ({
    scope: configurationScope,
    pos: Boolean(initialCached?.posSettings),
    account: Boolean(initialCached?.posSettings),
    posError: null as string | null,
    accountError: null as string | null,
  }));
  const configurationReady =
    configuration.scope === configurationScope &&
    configuration.pos &&
    configuration.account &&
    !configuration.posError &&
    !configuration.accountError;
  const configurationError =
    configuration.scope === configurationScope
      ? configuration.posError || configuration.accountError
      : null;
  const [configurationTick, setConfigurationTick] = useState(0);
  const loadedInvoicingScopeRef = useRef<string | null>(null);
  const loadedInvoicingUidRef = useRef<string | null>(null);

  const refreshConfiguration = useCallback(() => {
    loadedInvoicingScopeRef.current = null;
    setConfiguration({
      scope: configurationScope,
      pos: false,
      account: false,
      posError: null,
      accountError: null,
    });
    setConfigurationTick((value) => value + 1);
  }, [configurationScope]);

  const [primaryColor, setPrimaryColor] = useState<string>(
    () => initialCached?.primaryColor || '#10B981'
  );
  const [businessSettings, setBusinessSettings] = useState<BusinessSettings>(
    () => initialCached?.businessSettings || DEFAULT_BUSINESS_SETTINGS
  );
  const [posSettings, setPosSettings] = useState<PosSettings>(
    () => initialCached?.posSettings || DEFAULT_POS_SETTINGS
  );
  const [discountSettings, setDiscountSettings] = useState<DiscountSettings>(
    () => initialCached?.discountSettings || DEFAULT_DISCOUNT_SETTINGS
  );
  const [branches, setBranches] = useState<Branch[]>(() =>
    Array.isArray(initialCached?.branches) ? initialCached.branches : []
  );
  const [isCashOpen, setIsCashOpen] = useState<boolean>(() => Boolean(initialCash));
  const [activeCashSession, setActiveCashSession] = useState<ActiveCashSessionData | null>(
    () => initialCash
  );
  const [invoicingEnabled, setInvoicingEnabled] = useState<boolean>(() =>
    typeof initialCached?.invoicingEnabled === 'boolean' ? initialCached.invoicingEnabled : false
  );
  const [invoicingConfigRaw, setInvoicingConfigRaw] = useState<{
    isAmazonExempt?: boolean;
    taxExemptionCode?: string;
    taxRate?: number;
    printedFormatResolution?: string | null;
    emitterRuc?: string;
    emitterRazonSocial?: string;
    emitterNombreComercial?: string;
  } | null>(() =>
    initialCached?.invoicingConfigRaw !== undefined ? initialCached.invoicingConfigRaw : null
  );
  const [allPaymentMethods, setAllPaymentMethods] = useState<PosPaymentMethodConfig[]>(() =>
    Array.isArray(initialCached?.allPaymentMethods) && initialCached.allPaymentMethods.length > 0
      ? initialCached.allPaymentMethods
      : DEFAULT_PAYMENT_METHODS
  );
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(0);
  const [pendingOfflineSales, setPendingOfflineSales] = useState<PendingOfflineSale[]>([]);
  const branchIdRef = useRef(branchId);
  branchIdRef.current = branchId;
  const accountIdRef = useRef<string | null>(accountId);
  accountIdRef.current = accountId;
  const userIdRef = useRef<string | undefined>(user?.uid);
  userIdRef.current = user?.uid;
  const displayNameRef = useRef<string>(user?.displayName || '');
  displayNameRef.current = user?.displayName || '';
  const isOnlineRef = useRef<boolean>(isOnline);
  isOnlineRef.current = isOnline;
  const activeCashSessionRef = useRef<ActiveCashSessionData | null>(activeCashSession);
  activeCashSessionRef.current = activeCashSession;
  const allPaymentMethodsRef = useRef<PosPaymentMethodConfig[]>(allPaymentMethods);
  allPaymentMethodsRef.current = allPaymentMethods;
  const wasOfflineRef = useRef<boolean>(!isOnline);
  const startupSyncAttemptedScopeRef = useRef<string>('');
  const lastOfflineScopeRef = useRef<string | null>(null);
  const inFlightCashCheckRef = useRef<{
    scope: string;
    promise: Promise<ActiveCashSessionData | null>;
  } | null>(null);
  const settingsCacheSnapshotRef = useRef<{
    accountId: string;
    data: CachedAccountSettings;
  } | null>(null);
  const hydratedSettingsAccountRef = useRef<string | null>(null);
  const prevHydratedAccountRef = useRef<string | null>(null);
  const hasHydratedSettingsRef = useRef<boolean>(Boolean(initialCached));
  const authoritativeSettingsRef = useRef<Record<string, boolean>>({});
  const cashScopeRef = useRef<string | null>(
    initialSyncCashRef.current ? initialSyncCashRef.current.key : null
  );
  const hydratedCashSessionRef = useRef<{
    key: string;
    session: ActiveCashSessionData;
  } | null>(initialSyncCashRef.current ? initialSyncCashRef.current : null);
  const serverConfirmedCashScopeRef = useRef<string | null>(null);
  const cashHydrationPromiseRef = useRef<{
    key: string;
    promise: Promise<ActiveCashSessionData | null>;
  } | null>(null);
  const refreshCashStatusRef = useRef<() => void>(() => {});
  const pendingPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistAccountRef = useRef<string | null>(null);

  const clearPendingSettingsPersist = useCallback(() => {
    if (pendingPersistTimerRef.current) {
      clearTimeout(pendingPersistTimerRef.current);
      pendingPersistTimerRef.current = null;
    }
    pendingPersistAccountRef.current = null;
  }, []);

  const scheduleSettingsPersist = useCallback(
    (targetAccountId: string) => {
      if (!targetAccountId) return;
      if (pendingPersistTimerRef.current) {
        clearTimeout(pendingPersistTimerRef.current);
      }
      pendingPersistAccountRef.current = targetAccountId;
      pendingPersistTimerRef.current = setTimeout(() => {
        pendingPersistTimerRef.current = null;
        pendingPersistAccountRef.current = null;
        if (
          hydratedSettingsAccountRef.current === targetAccountId &&
          settingsCacheSnapshotRef.current?.accountId === targetAccountId
        ) {
          void safeStorageSet(
            `${SETTINGS_CACHE_PREFIX}${targetAccountId}`,
            JSON.stringify(settingsCacheSnapshotRef.current.data)
          );
        }
      }, SETTINGS_PERSIST_DEBOUNCE_MS);
    },
    [safeStorageSet]
  );

  useEffect(() => {
    return () => {
      clearPendingSettingsPersist();
    };
  }, [clearPendingSettingsPersist]);

  const persistSettingsSnapshot = useCallback(
    (targetAccountId: string, patch: Partial<CachedAccountSettings>) => {
      if (!targetAccountId) return;
      const current =
        settingsCacheSnapshotRef.current?.accountId === targetAccountId
          ? settingsCacheSnapshotRef.current.data
          : {};

      const patchKeys = Object.keys(patch) as (keyof CachedAccountSettings)[];
      let hasDiff = false;
      for (let i = 0; i < patchKeys.length; i += 1) {
        const key = patchKeys[i];
        if (!isStructurallyEqual(current[key], patch[key])) {
          hasDiff = true;
          break;
        }
      }
      if (!hasDiff) return;

      const nextData: CachedAccountSettings = {
        ...current,
        ...patch,
      };
      settingsCacheSnapshotRef.current = { accountId: targetAccountId, data: nextData };

      if (hydratedSettingsAccountRef.current === targetAccountId) {
        scheduleSettingsPersist(targetAccountId);
      }
    },
    [scheduleSettingsPersist]
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

  const applyOfflineQueueItems = useCallback(
    (
      queue: PendingOfflineSale[],
      targetUid: string | undefined,
      targetAccountId: string | null
    ): number => {
      const scoped =
        targetUid && targetAccountId
          ? queue.filter((item) =>
              offlineSaleBelongsToIdentity(item.salePayload, targetUid, targetAccountId)
            )
          : queue;

      setPendingOfflineSales((prev) => {
        if (prev.length === 0 && scoped.length === 0) return prev;
        if (
          prev.length === scoped.length &&
          prev.every((p, idx) => {
            const s = scoped[idx];
            return (
              p.id === s.id &&
              p.status === s.status &&
              p.retryCount === s.retryCount &&
              p.timestamp === s.timestamp
            );
          })
        ) {
          return prev;
        }
        return scoped;
      });
      setOfflineQueueCount((prev) => (prev === scoped.length ? prev : scoped.length));
      return scoped.length;
    },
    []
  );

  // 1. Refrescar el contador y detalle de ventas offline en cola local
  const refreshOfflineCount = useCallback(async (): Promise<number> => {
    try {
      const queue = await getOfflineQueue();
      return applyOfflineQueueItems(queue, user?.uid, accountId);
    } catch {
      return 0;
    }
  }, [accountId, user?.uid, applyOfflineQueueItems]);
  const refreshOfflineCountRef = useRef(refreshOfflineCount);
  refreshOfflineCountRef.current = refreshOfflineCount;

  // 1.5. Hidratar ajustes cacheados para arranque en frío offline
  useEffect(() => {
    if (!accountId) {
      clearPendingSettingsPersist();
      initialSyncSettingsRef.current = null;
      prevHydratedAccountRef.current = null;
      hydratedSettingsAccountRef.current = null;
      hasHydratedSettingsRef.current = false;
      settingsCacheSnapshotRef.current = null;
      authoritativeSettingsRef.current = {};
      return;
    }

    let cancelled = false;
    const isInitialMountSyncHit =
      prevHydratedAccountRef.current === null &&
      initialSyncSettingsRef.current?.accountId === accountId;

    if (prevHydratedAccountRef.current !== accountId) {
      if (prevHydratedAccountRef.current !== null) {
        clearPendingSettingsPersist();
      }
      prevHydratedAccountRef.current = accountId;
      hydratedSettingsAccountRef.current = null;
      hasHydratedSettingsRef.current = false;
      settingsCacheSnapshotRef.current = { accountId, data: {} };
      authoritativeSettingsRef.current = {};
    }

    const applyParsedSettings = (
      parsed: CachedAccountSettings,
      alreadyApplied: CachedAccountSettings,
      fromLegacy: boolean
    ) => {
      hasHydratedSettingsRef.current = true;
      const merged: CachedAccountSettings = { ...parsed, ...alreadyApplied };
      settingsCacheSnapshotRef.current = { accountId, data: merged };

      if (parsed.primaryColor && !authoritativeSettingsRef.current.appearance) {
        setPrimaryColor((prev) => (prev === parsed.primaryColor ? prev : parsed.primaryColor!));
      }
      if (parsed.businessSettings && !authoritativeSettingsRef.current.business) {
        setBusinessSettings((prev) =>
          isStructurallyEqual(prev, parsed.businessSettings) ? prev : parsed.businessSettings!
        );
      }
      if (parsed.posSettings) {
        if (!authoritativeSettingsRef.current.pos) {
          setPosSettings((prev) =>
            isStructurallyEqual(prev, parsed.posSettings) ? prev : parsed.posSettings!
          );
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
        setAllPaymentMethods((prev) =>
          isStructurallyEqual(prev, parsed.allPaymentMethods) ? prev : parsed.allPaymentMethods!
        );
      }
      if (parsed.discountSettings && !authoritativeSettingsRef.current.discounts) {
        setDiscountSettings((prev) =>
          isStructurallyEqual(prev, parsed.discountSettings) ? prev : parsed.discountSettings!
        );
      }
      if (
        Array.isArray(parsed.branches) &&
        parsed.branches.length > 0 &&
        !authoritativeSettingsRef.current.branches
      ) {
        setBranches((prev) =>
          isStructurallyEqual(prev, parsed.branches) ? prev : parsed.branches!
        );
        reconcileActiveBranchesRef.current(parsed.branches);
      }
      if (
        typeof parsed.invoicingEnabled === 'boolean' &&
        !authoritativeSettingsRef.current.account
      ) {
        setInvoicingEnabled((prev) =>
          prev === parsed.invoicingEnabled ? prev : parsed.invoicingEnabled!
        );
      }
      if (
        parsed.invoicingConfigRaw !== undefined &&
        !authoritativeSettingsRef.current.invoicingConfig
      ) {
        setInvoicingConfigRaw((prev) =>
          isStructurallyEqual(prev, parsed.invoicingConfigRaw)
            ? prev
            : parsed.invoicingConfigRaw!
        );
      }

      if (
        Object.keys(alreadyApplied).length > 0 &&
        (!isStructurallyEqual(parsed, merged) || fromLegacy)
      ) {
        scheduleSettingsPersist(accountId);
      }
    };

    if (isInitialMountSyncHit && initialSyncSettingsRef.current) {
      const mountParsed = initialSyncSettingsRef.current.data;
      initialSyncSettingsRef.current = null;
      hydratedSettingsAccountRef.current = accountId;
      hasHydratedSettingsRef.current = true;
      const alreadyApplied =
        settingsCacheSnapshotRef.current?.accountId === accountId
          ? settingsCacheSnapshotRef.current.data
          : {};
      const merged: CachedAccountSettings = { ...mountParsed, ...alreadyApplied };
      settingsCacheSnapshotRef.current = { accountId, data: merged };
      if (
        Array.isArray(mountParsed.branches) &&
        mountParsed.branches.length > 0 &&
        !authoritativeSettingsRef.current.branches
      ) {
        reconcileActiveBranchesRef.current(mountParsed.branches);
      }
      if (
        Object.keys(alreadyApplied).length > 0 &&
        !isStructurallyEqual(mountParsed, merged)
      ) {
        scheduleSettingsPersist(accountId);
      }
      return;
    }
    initialSyncSettingsRef.current = null;

    const settingsKey = `${SETTINGS_CACHE_PREFIX}${accountId}`;
    const syncRaw = safeStorageGetSync(settingsKey);
    if (syncRaw !== null) {
      hydratedSettingsAccountRef.current = accountId;
      const parsed = parseCachedAccountSettings(syncRaw);
      const alreadyApplied =
        settingsCacheSnapshotRef.current?.accountId === accountId
          ? settingsCacheSnapshotRef.current.data
          : {};
      if (parsed) {
        applyParsedSettings(parsed, alreadyApplied, false);
      } else if (Object.keys(alreadyApplied).length > 0) {
        scheduleSettingsPersist(accountId);
      }
      return;
    }

    const hydrateSettings = async () => {
      const { value: raw, fromLegacy } = await safeStorageGet(settingsKey);
      if (cancelled) return;

      hydratedSettingsAccountRef.current = accountId;
      const alreadyApplied =
        settingsCacheSnapshotRef.current?.accountId === accountId
          ? settingsCacheSnapshotRef.current.data
          : {};

      if (!raw) {
        if (Object.keys(alreadyApplied).length > 0) {
          scheduleSettingsPersist(accountId);
        }
        return;
      }

      const parsed = parseCachedAccountSettings(raw);
      if (!parsed) return;
      applyParsedSettings(parsed, alreadyApplied, fromLegacy);
    };

    void hydrateSettings();

    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    configurationScope,
    clearPendingSettingsPersist,
    safeStorageGet,
    scheduleSettingsPersist,
  ]);

  // 2. Suscripción reactiva a cambios en cola offline y retorno a primer plano
  useEffect(() => {
    let isMounted = true;

    const unsubscribeQueue = subscribeOfflineQueueChanges((event) => {
      if (!isMounted) return;
      if (Array.isArray(event.items)) {
        applyOfflineQueueItems(event.items, userIdRef.current, accountIdRef.current);
      } else {
        void refreshOfflineCountRef.current();
      }
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
            void refreshOfflineCountRef.current().then((count) => {
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
  }, [applyOfflineQueueItems]);

  // 2.1. Verificación inicial consolidada + sincronización al arrancar online o reconectar
  useEffect(() => {
    let isMounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerSync = (targetAccountId: string) => {
      processOfflineQueue(targetAccountId)
        .then((result) => {
          if (isMounted && (result?.processed || 0) === 0) {
            void refreshOfflineCount();
          }
        })
        .catch((err) => {
          console.warn('[SettingsContext] Error procesando cola offline:', err);
        });
    };

    const currentScope = `${user?.uid || ''}:${accountId || ''}`;
    const scopeChanged = lastOfflineScopeRef.current !== currentScope;
    if (scopeChanged) {
      lastOfflineScopeRef.current = currentScope;
    }

    if (isOnline && accountId) {
      if (wasOfflineRef.current) {
        startupSyncAttemptedScopeRef.current = currentScope;
        if (scopeChanged) {
          void refreshOfflineCount();
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (isMounted && isOnlineRef.current) {
            triggerSync(accountId);
          }
        }, 1_500);
      } else if (startupSyncAttemptedScopeRef.current !== currentScope || scopeChanged) {
        startupSyncAttemptedScopeRef.current = currentScope;
        void refreshOfflineCount().then((count) => {
          if (isMounted && isOnlineRef.current && count > 0) {
            triggerSync(accountId);
          }
        });
      }
    } else {
      if (!accountId) {
        startupSyncAttemptedScopeRef.current = '';
      }
      if (scopeChanged) {
        void refreshOfflineCount();
      }
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
          setPrimaryColor((prev) => (prev === data.primaryColor ? prev : data.primaryColor));
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
        setBusinessSettings((prev) => (isStructurallyEqual(prev, defaultBiz) ? prev : defaultBiz));
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
      setBusinessSettings((prev) => (isStructurallyEqual(prev, loadedBiz) ? prev : loadedBiz));
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
        setConfiguration((previous) => {
          if (
            previous.scope === configurationScope &&
            previous.pos === true &&
            previous.posError === null
          ) {
            return previous;
          }
          return {
            ...(previous.scope === configurationScope
              ? previous
              : {
                  scope: configurationScope,
                  pos: false,
                  account: false,
                  posError: null,
                  accountError: null,
                }),
            pos: true,
            posError: null,
          };
        });
      }
      if (!snap.exists()) {
        if (
          snap.metadata?.fromCache === true &&
          (!isOnlineRef.current || hasHydratedSettingsRef.current)
        ) {
          return;
        }
        const defaultPos = { ...DEFAULT_POS_SETTINGS, id: `${accountId}_pos`, accountId };
        setPosSettings((prev) => (isStructurallyEqual(prev, defaultPos) ? prev : defaultPos));
        setAllPaymentMethods((prev) =>
          isStructurallyEqual(prev, DEFAULT_PAYMENT_METHODS) ? prev : DEFAULT_PAYMENT_METHODS
        );
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
        methods:
          Array.isArray(data.methods) && data.methods.length > 0
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

      setPosSettings((prev) =>
        isStructurallyEqual(prev, loadedPosSettings) ? prev : loadedPosSettings
      );

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
      setAllPaymentMethods((prev) =>
        isStructurallyEqual(prev, formattedMethods) ? prev : formattedMethods
      );
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
        const posErrorMsg =
          'No se pudo cargar la configuración de pagos. Comprueba la conexión y pulsa Reintentar.';
        setConfiguration((previous) => {
          if (
            previous.scope === configurationScope &&
            previous.pos === false &&
            previous.posError === posErrorMsg
          ) {
            return previous;
          }
          return {
            ...(previous.scope === configurationScope
              ? previous
              : {
                  scope: configurationScope,
                  pos: false,
                  account: false,
                  posError: null,
                  accountError: null,
                }),
            pos: false,
            posError: posErrorMsg,
          };
        });
      }
    );

    // 3.4. Estado de la cuenta y permisos de facturación electrónica (Super Admin)
    const accountRef = doc(db, 'accounts', accountId);
    const applyAccount = (snap: any) => {
      if (snap.exists() || snap.metadata?.fromCache === false) {
        setConfiguration((previous) => {
          if (
            previous.scope === configurationScope &&
            previous.account === true &&
            previous.accountError === null
          ) {
            return previous;
          }
          return {
            ...(previous.scope === configurationScope
              ? previous
              : {
                  scope: configurationScope,
                  pos: false,
                  account: false,
                  posError: null,
                  accountError: null,
                }),
            account: true,
            accountError: null,
          };
        });
      }
      if (!snap.exists()) {
        if (
          snap.metadata?.fromCache === true &&
          (!isOnlineRef.current || hasHydratedSettingsRef.current)
        ) {
          return;
        }
        setInvoicingEnabled((prev) => (prev === false ? prev : false));
        if (snap.metadata?.fromCache === false) {
          authoritativeSettingsRef.current.account = true;
          persistSettingsSnapshot(accountId, { invoicingEnabled: false });
        }
        return;
      }

      authoritativeSettingsRef.current.account = true;
      const data = snap.data();
      const enabled = Boolean(data.invoicingEnabled);
      setInvoicingEnabled((prev) => (prev === enabled ? prev : enabled));
      persistSettingsSnapshot(accountId, { invoicingEnabled: enabled });
    };
    const unsubAccount = subscribeLiveDocument(
      accountRef,
      applyAccount,
      (err) => {
        console.warn('[SettingsContext] account snapshot error:', err);
        if (!isOnlineRef.current && hasHydratedSettingsRef.current) return;
        const accountErrorMsg =
          'No se pudo verificar la configuración de comprobantes. Comprueba la conexión y pulsa Reintentar.';
        setConfiguration((previous) => {
          if (
            previous.scope === configurationScope &&
            previous.account === false &&
            previous.accountError === accountErrorMsg
          ) {
            return previous;
          }
          return {
            ...(previous.scope === configurationScope
              ? previous
              : {
                  scope: configurationScope,
                  pos: false,
                  account: false,
                  posError: null,
                  accountError: null,
                }),
            account: false,
            accountError: accountErrorMsg,
          };
        });
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
        setDiscountSettings((prev) =>
          isStructurallyEqual(prev, defaultDiscounts) ? prev : defaultDiscounts
        );
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
      setDiscountSettings((prev) =>
        isStructurallyEqual(prev, nextDiscounts) ? prev : nextDiscounts
      );
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
      loadedInvoicingScopeRef.current = null;
      loadedInvoicingUidRef.current = null;
      setInvoicingConfigRaw((prev) => (prev === null ? prev : null));
      return;
    }
    if (loadedInvoicingUidRef.current !== user.uid) {
      loadedInvoicingScopeRef.current = null;
      loadedInvoicingUidRef.current = user.uid;
    }
    const invoicingScope = `${accountId}:${branchId}`;
    if (!isOnline || !APP_URL) {
      // Preservar configuración cacheada cuando el dispositivo pierde conectividad temporalmente
      return;
    }
    if (loadedInvoicingScopeRef.current === invoicingScope) {
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
        if (cancelled) return;
        if (data?.success) {
          loadedInvoicingScopeRef.current = invoicingScope;
          if (data.config) {
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
            setInvoicingConfigRaw((prev) =>
              isStructurallyEqual(prev, nextInvoicingConfig) ? prev : nextInvoicingConfig
            );
            persistSettingsSnapshot(accountId, { invoicingConfigRaw: nextInvoicingConfig });
          }
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
  }, [accountId, branchId, user?.uid, isOnline, configurationTick, persistSettingsSnapshot]);

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
      setBranches((prev) => (isStructurallyEqual(prev, activeList) ? prev : activeList));
      reconcileActiveBranchesRef.current(activeList);

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
  }, [accountId, persistSettingsSnapshot]);

  // 5. Verificación y resolución determinista de la sesión activa de caja
  const checkActiveSession = useCallback(
    async (
      knownSessionId?: string | null,
      options?: { skipPointerGet?: boolean }
    ): Promise<ActiveCashSessionData | null> => {
      if (!accountId || !user?.uid) {
        activeCashSessionRef.current = null;
        setIsCashOpen((prev) => (prev ? false : prev));
        setActiveCashSession((prev) => (prev === null ? prev : null));
        return null;
      }
      const effectiveBranchForCash = branchId || 'main';
      const cashKey = getCashSessionCacheKey(accountId, effectiveBranchForCash, user.uid);
      const skipPointerGet = options?.skipPointerGet === true;
      const checkScope = `${accountId}:${effectiveBranchForCash}:${user.uid}:${knownSessionId || ''}:${skipPointerGet ? '1' : '0'}`;
      if (inFlightCashCheckRef.current?.scope === checkScope) {
        return inFlightCashCheckRef.current.promise;
      }

      const applyOpenSession = (
        sessionObj: ActiveCashSessionData,
        persistIfChanged: boolean
      ): ActiveCashSessionData => {
        const existing = activeCashSessionRef.current;
        const nextSession =
          existing && isStructurallyEqual(existing, sessionObj) ? existing : sessionObj;
        const cacheMatches =
          hydratedCashSessionRef.current?.key === cashKey &&
          isStructurallyEqual(hydratedCashSessionRef.current.session, nextSession) &&
          !legacyPendingMigrationRef.current.has(cashKey);

        hydratedCashSessionRef.current = { key: cashKey, session: nextSession };
        activeCashSessionRef.current = nextSession;
        setIsCashOpen((prev) => (prev ? prev : true));
        setActiveCashSession((prev) =>
          prev === nextSession || isStructurallyEqual(prev, nextSession) ? prev : nextSession
        );
        if (persistIfChanged && !cacheMatches) {
          void safeStorageSet(cashKey, JSON.stringify(nextSession));
        }
        return nextSession;
      };

      const applyClosedSession = (): null => {
        activeCashSessionRef.current = null;
        setIsCashOpen((prev) => (prev ? false : prev));
        setActiveCashSession((prev) => (prev === null ? prev : null));
        return null;
      };

      const getHydratedOrCachedSession = async (): Promise<ActiveCashSessionData | null> => {
        if (hydratedCashSessionRef.current?.key === cashKey) {
          return hydratedCashSessionRef.current.session;
        }
        if (cashHydrationPromiseRef.current?.key === cashKey) {
          const hydrated = await cashHydrationPromiseRef.current.promise;
          if (hydrated) return hydrated;
        }
        const syncSession = parseCachedCashSession(safeStorageGetSync(cashKey));
        if (syncSession) {
          hydratedCashSessionRef.current = { key: cashKey, session: syncSession };
          return syncSession;
        }
        const { value: raw } = await safeStorageGet(cashKey);
        const parsed = parseCachedCashSession(raw);
        if (parsed) {
          hydratedCashSessionRef.current = { key: cashKey, session: parsed };
          return parsed;
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
        branchId: data.branchId || effectiveBranchForCash,
        accountId,
        status: 'open',
        initialAmount: Number(data.initialAmount ?? fallbackInitialAmount ?? 0),
        openTime: Number(data.openTime ?? data.openedAt ?? Date.now()),
        startedBy: data.startedBy || user.uid,
        startedByName: data.startedByName || displayNameRef.current || '',
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
          const userPtrId = `active_${accountId}_${effectiveBranchForCash}_${user.uid}`;
          try {
            let activeSessionId = knownSessionId || null;
            let ptrInitialAmount: number | undefined;

            if (!activeSessionId && !skipPointerGet) {
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
                  const sessionObj = buildSessionObj(
                    activeSessionId,
                    userPtrId,
                    sData,
                    ptrInitialAmount
                  );
                  if ((sessSnap as any).metadata?.fromCache === false || isOnlineRef.current) {
                    serverConfirmedCashScopeRef.current = cashKey;
                  }
                  return applyOpenSession(sessionObj, true);
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
              where('branchId', '==', effectiveBranchForCash),
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
                    branchId: effectiveBranchForCash,
                    accountId,
                    startedBy: user.uid,
                    status: 'open',
                    lastUpdated: serverTimestamp(),
                  },
                  { merge: true }
                );
              } catch {}

              if ((snap as any).metadata?.fromCache === false || isOnlineRef.current) {
                serverConfirmedCashScopeRef.current = cashKey;
              }
              return applyOpenSession(sessionObj, true);
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
              return applyOpenSession(cachedSession, false);
            }
          }

          // Servidor confirmó con cero errores que la caja está cerrada: limpiar caché
          if (serverConfirmedClosed) {
            serverConfirmedCashScopeRef.current = cashKey;
            hydratedCashSessionRef.current = null;
            void safeStorageRemove(cashKey);
          }

          return applyClosedSession();
        } catch (err) {
          console.warn('[SettingsContext] checkActiveSession error:', err);
          const cachedSession = await getHydratedOrCachedSession();
          if (cachedSession) {
            return applyOpenSession(cachedSession, false);
          }
          return applyClosedSession();
        }
      };

      const promise = runCheck().finally(() => {
        if (inFlightCashCheckRef.current?.promise === promise) {
          inFlightCashCheckRef.current = null;
        }
      });
      inFlightCashCheckRef.current = { scope: checkScope, promise };
      return promise;
    },
    [accountId, branchId, user?.uid, safeStorageGet, safeStorageSet, safeStorageRemove]
  );

  const refreshCashStatus = useCallback(() => {
    void checkActiveSession();
  }, [checkActiveSession]);
  refreshCashStatusRef.current = refreshCashStatus;

  // Suscripción en tiempo real al estado de la Caja e hidratación offline
  useEffect(() => {
    if (!accountId || !user?.uid) {
      initialSyncCashRef.current = null;
      cashScopeRef.current = null;
      hydratedCashSessionRef.current = null;
      serverConfirmedCashScopeRef.current = null;
      cashHydrationPromiseRef.current = null;
      activeCashSessionRef.current = null;
      setIsCashOpen((prev) => (prev ? false : prev));
      setActiveCashSession((prev) => (prev === null ? prev : null));
      return;
    }

    let isSubscribed = true;
    let initialResolved = false;

    const effectiveBranchForCash = branchId || 'main';
    const cashKey = getCashSessionCacheKey(accountId, effectiveBranchForCash, user.uid);
    const pointerId = `active_${accountId}_${effectiveBranchForCash}_${user.uid}`;

    const isMountSyncCashHit =
      initialSyncCashRef.current !== null &&
      initialSyncCashRef.current !== undefined &&
      initialSyncCashRef.current.key === cashKey;
    initialSyncCashRef.current = null;

    if (cashScopeRef.current !== cashKey) {
      cashScopeRef.current = cashKey;
      hydratedCashSessionRef.current = null;
      serverConfirmedCashScopeRef.current = null;
      activeCashSessionRef.current = null;
      setIsCashOpen((prev) => (prev ? false : prev));
      setActiveCashSession((prev) => (prev === null ? prev : null));
    }

    if (isMountSyncCashHit && hydratedCashSessionRef.current?.key === cashKey) {
      cashHydrationPromiseRef.current = {
        key: cashKey,
        promise: Promise.resolve(hydratedCashSessionRef.current.session),
      };
    } else {
      const syncParsed = parseCachedCashSession(safeStorageGetSync(cashKey));
      if (syncParsed) {
        hydratedCashSessionRef.current = { key: cashKey, session: syncParsed };
        if (serverConfirmedCashScopeRef.current !== cashKey && !activeCashSessionRef.current) {
          activeCashSessionRef.current = syncParsed;
          setIsCashOpen((prev) => (prev ? prev : true));
          setActiveCashSession((prev) =>
            isStructurallyEqual(prev, syncParsed) ? prev : syncParsed
          );
        }
        cashHydrationPromiseRef.current = {
          key: cashKey,
          promise: Promise.resolve(syncParsed),
        };
      } else {
        const hydrateCashSession = async (): Promise<ActiveCashSessionData | null> => {
          const { value: raw } = await safeStorageGet(cashKey);
          if (!isSubscribed || !raw) return null;
          const parsed = parseCachedCashSession(raw);
          if (!parsed) return null;
          hydratedCashSessionRef.current = { key: cashKey, session: parsed };
          if (serverConfirmedCashScopeRef.current !== cashKey && !activeCashSessionRef.current) {
            activeCashSessionRef.current = parsed;
            setIsCashOpen((prev) => (prev ? prev : true));
            setActiveCashSession((prev) =>
              isStructurallyEqual(prev, parsed) ? prev : parsed
            );
          }
          return parsed;
        };

        cashHydrationPromiseRef.current = { key: cashKey, promise: hydrateCashSession() };
      }
    }

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
            void checkActiveSession(null, { skipPointerGet: true });
          } else if (activeCashSessionRef.current) {
            const serverConfirmed =
              snap.metadata?.fromCache === false ||
              (isOnlineRef.current && snap.metadata?.fromCache !== true);
            if (serverConfirmed) {
              serverConfirmedCashScopeRef.current = cashKey;
              hydratedCashSessionRef.current = null;
              activeCashSessionRef.current = null;
              setIsCashOpen((prev) => (prev ? false : prev));
              setActiveCashSession((prev) => (prev === null ? prev : null));
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
  }, [accountId, branchId, user?.uid, checkActiveSession, safeStorageGet, safeStorageRemove]);

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
      const updated = allPaymentMethodsRef.current.map((m) =>
        m.id === methodId ? { ...m, enabled } : m
      );
      allPaymentMethodsRef.current = updated;
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
    [accountId]
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

  const businessSettingsValue = useMemo<BusinessSettingsContextType>(
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
      invoicingEnabled,
      taxProfile,
      emitterInfo,
      paymentMethods,
      allPaymentMethods,
      updateBusinessSettings,
      updateBusinessData: updateBusinessSettings,
      updatePosSettings,
      togglePaymentMethod,
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
      invoicingEnabled,
      taxProfile,
      emitterInfo,
      paymentMethods,
      allPaymentMethods,
      updateBusinessSettings,
      updatePosSettings,
      togglePaymentMethod,
    ]
  );

  const cashSessionValue = useMemo<CashSessionContextType>(
    () => ({
      isCashOpen,
      activeCashSession,
      refreshCashStatus,
    }),
    [isCashOpen, activeCashSession, refreshCashStatus]
  );

  const offlineStatusValue = useMemo<OfflineStatusContextType>(
    () => ({
      isOnline,
      offlineQueueCount,
      pendingOfflineSales,
      refreshOfflineCount,
    }),
    [isOnline, offlineQueueCount, pendingOfflineSales, refreshOfflineCount]
  );

  const contextValue = useMemo<SettingsContextType>(
    () => ({
      ...businessSettingsValue,
      ...cashSessionValue,
      ...offlineStatusValue,
    }),
    [businessSettingsValue, cashSessionValue, offlineStatusValue]
  );

  return (
    <BusinessSettingsContext.Provider value={businessSettingsValue}>
      <CashSessionContext.Provider value={cashSessionValue}>
        <OfflineStatusContext.Provider value={offlineStatusValue}>
          <SettingsContext.Provider value={contextValue}>{children}</SettingsContext.Provider>
        </OfflineStatusContext.Provider>
      </CashSessionContext.Provider>
    </BusinessSettingsContext.Provider>
  );
};

export const useSettings = () => useContext(SettingsContext);
export const useBusinessSettings = () => useContext(BusinessSettingsContext);
export const useCashSession = () => useContext(CashSessionContext);
export const useOfflineStatus = () => useContext(OfflineStatusContext);
