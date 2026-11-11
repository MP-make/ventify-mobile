import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
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
import NetInfo from '@react-native-community/netinfo';
import { db } from '@/lib/firebase';
import { useAuth } from './AuthContext';
import { hasAllBranchesAccess } from '@/lib/branch-access';
import {
  Branch,
  BusinessSettings,
  PosSettings,
  PosPaymentMethodConfig,
  CashRegisterSession,
} from '@/types';
import {
  processOfflineQueue,
  getOfflineQueue,
} from '@/services/offline-sync-service';

declare module '@/types' {
  interface BusinessSettings {
    commercialAddress?: string;
    commercialPhone?: string;
  }
  interface PosSettings {
    ticketFooterMessage?: string;
    digitalPhone?: string;
    digitalName?: string;
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

export interface SettingsContextType {
  primaryColor: string;
  businessName: string;
  businessSettings: BusinessSettings;
  businessData: BusinessSettings; // Alias para compatibilidad con vistas legacy
  posSettings: PosSettings;
  branches: Branch[];
  activeBranchName: string;
  activeBranch: Branch | null;
  isCashOpen: boolean;
  activeCashSession: ActiveCashSessionData | null;
  invoicingEnabled: boolean;
  paymentMethods: PosPaymentMethodConfig[];
  allPaymentMethods: PosPaymentMethodConfig[];
  isOnline: boolean;
  offlineQueueCount: number;
  refreshOfflineCount: () => Promise<number>;
  updateBusinessSettings: (patch: Partial<BusinessSettings>) => Promise<void>;
  updateBusinessData: (patch: Partial<BusinessSettings>) => Promise<void>;
  updatePosSettings: (patch: Partial<PosSettings>) => Promise<void>;
  togglePaymentMethod: (methodId: string, enabled: boolean) => Promise<void>;
  refreshCashStatus: () => void;
}

const SettingsContext = createContext<SettingsContextType>({
  primaryColor: '#10B981',
  businessName: 'Ventify POS',
  businessSettings: DEFAULT_BUSINESS_SETTINGS,
  businessData: DEFAULT_BUSINESS_SETTINGS,
  posSettings: DEFAULT_POS_SETTINGS,
  branches: [],
  activeBranchName: 'Tienda Principal',
  activeBranch: null,
  isCashOpen: false,
  activeCashSession: null,
  invoicingEnabled: false,
  paymentMethods: DEFAULT_PAYMENT_METHODS,
  allPaymentMethods: DEFAULT_PAYMENT_METHODS,
  isOnline: true,
  offlineQueueCount: 0,
  refreshOfflineCount: async () => 0,
  updateBusinessSettings: async () => {},
  updateBusinessData: async () => {},
  updatePosSettings: async () => {},
  togglePaymentMethod: async () => {},
  refreshCashStatus: () => {},
});

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { accountId, branchId, setBranchId, user, userProfile, role, allBranchesAccess } = useAuth();

  const [primaryColor, setPrimaryColor] = useState<string>('#10B981');
  const [businessSettings, setBusinessSettings] = useState<BusinessSettings>(DEFAULT_BUSINESS_SETTINGS);
  const [posSettings, setPosSettings] = useState<PosSettings>(DEFAULT_POS_SETTINGS);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isCashOpen, setIsCashOpen] = useState<boolean>(false);
  const [activeCashSession, setActiveCashSession] = useState<ActiveCashSessionData | null>(null);
  const [invoicingEnabled, setInvoicingEnabled] = useState<boolean>(false);
  const [allPaymentMethods, setAllPaymentMethods] = useState<PosPaymentMethodConfig[]>(DEFAULT_PAYMENT_METHODS);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(0);

  // 1. Refrescar el contador de ventas offline en cola local
  const refreshOfflineCount = useCallback(async (): Promise<number> => {
    try {
      const queue = await getOfflineQueue();
      const count = queue.length;
      setOfflineQueueCount(count);
      return count;
    } catch {
      return 0;
    }
  }, []);

  // 2. Monitoreo reactivo de conectividad de red con NetInfo
  useEffect(() => {
    let wasOffline = false;

    // Estado inicial
    NetInfo.fetch().then((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setIsOnline(online);
      refreshOfflineCount();
    });

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setIsOnline(online);

      // Si se recupera la conexión, disparar la cola offline de inmediato
      if (online && wasOffline) {
        console.log('[SettingsContext] Red restablecida. Sincronizando cola offline...');
        processOfflineQueue()
          .then(() => {
            refreshOfflineCount();
          })
          .catch((err) => {
            console.warn('[SettingsContext] Error procesando cola offline al volver conexión:', err);
          });
      }

      wasOffline = !online;
      refreshOfflineCount();
    });

    return () => {
      unsubscribeNet();
    };
  }, [refreshOfflineCount]);

  // 3. Suscripción a ajustes del negocio y POS en Firestore (con carga inmediata RPC)
  useEffect(() => {
    if (!accountId) return;

    // 3.1. Ajustes de apariencia
    const appearanceRef = doc(db, 'settings', `${accountId}_appearance`);
    const applyAppearance = (snap: any) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.primaryColor) {
          setPrimaryColor(data.primaryColor);
        }
      }
    };
    getDoc(appearanceRef).then(applyAppearance).catch(() => {});
    const unsubAppearance = onSnapshot(
      appearanceRef,
      applyAppearance,
      (err) => console.warn('[SettingsContext] appearance snapshot error:', err)
    );

    // 3.2. Información de negocio (RUC, razón social, dirección, teléfono, logo, series)
    const businessRef = doc(db, 'settings', `${accountId}_business`);
    const applyBusiness = (snap: any) => {
      if (snap.exists()) {
        const data = snap.data();
        setBusinessSettings({
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
        });
      }
    };
    getDoc(businessRef).then(applyBusiness).catch(() => {});
    const unsubBusiness = onSnapshot(
      businessRef,
      applyBusiness,
      (err) => console.warn('[SettingsContext] business snapshot error:', err)
    );

    // 3.3. Configuración del POS (métodos de pago habilitados, Yape/Plin, pie de ticket, comprobante por defecto)
    const posRef = doc(db, 'settings', `${accountId}_pos`);
    const applyPos = (snap: any) => {
      if (snap.exists()) {
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

        if (Array.isArray(data.methods) && data.methods.length > 0) {
          const formatted = data.methods
            .filter((m: any) => m.kind !== 'mixed')
            .sort((a: any, b: any) => (a.order || 0) - (b.order || 0))
            .map((m: any, idx: number) => ({
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
          setAllPaymentMethods(formatted);
        } else {
          setAllPaymentMethods(DEFAULT_PAYMENT_METHODS);
        }
      }
    };
    getDoc(posRef).then(applyPos).catch(() => {});
    const unsubPos = onSnapshot(
      posRef,
      applyPos,
      (err) => console.warn('[SettingsContext] pos snapshot error:', err)
    );

    // 3.4. Estado de la cuenta y permisos de facturación electrónica (Super Admin)
    const accountRef = doc(db, 'accounts', accountId);
    const applyAccount = (snap: any) => {
      if (snap.exists()) {
        const data = snap.data();
        setInvoicingEnabled(Boolean(data.invoicingEnabled));
      } else {
        setInvoicingEnabled(false);
      }
    };
    getDoc(accountRef).then(applyAccount).catch(() => {});
    const unsubAccount = onSnapshot(
      accountRef,
      applyAccount,
      (err) => console.warn('[SettingsContext] account snapshot error:', err)
    );

    return () => {
      unsubAppearance();
      unsubBusiness();
      unsubPos();
      unsubAccount();
    };
  }, [accountId]);

  // 4. Suscripción a sucursales de la cuenta (con carga inmediata RPC)
  useEffect(() => {
    if (!accountId) return;

    const branchesQ = query(
      collection(db, 'branches'),
      where('accountId', '==', accountId)
    );

    const applyBranchesSnap = (snap: any) => {
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

      if (activeList.length > 0) {
        if (!hasAllBranchesAccess({ role, allBranchesAccess, branchId }) && userProfile?.branchId) {
          if (branchId !== userProfile.branchId) {
            setBranchId(userProfile.branchId);
          }
        } else if (branchId === 'main' || !activeList.some((b) => b.id === branchId)) {
          setBranchId(activeList[0].id!);
        }
      }
    };

    getDocs(branchesQ)
      .then(applyBranchesSnap)
      .catch((err) => console.warn('[SettingsContext] initial branches getDocs warning:', err));

    const unsubBranches = onSnapshot(
      branchesQ,
      applyBranchesSnap,
      (err) => console.warn('[SettingsContext] branches snapshot error:', err)
    );

    return () => unsubBranches();
  }, [accountId, branchId, setBranchId, role, allBranchesAccess, userProfile?.branchId]);

  // 5. Verificación y resolución determinista de la sesión activa de caja
  const checkActiveSession = useCallback(async (): Promise<ActiveCashSessionData | null> => {
    if (!accountId || !user?.uid) {
      setIsCashOpen(false);
      setActiveCashSession(null);
      return null;
    }
    const effectiveBranch = branchId || 'main';

    try {
      // 1. Verificar puntero determinista exclusivo del operador
      const userPtrId = `active_${accountId}_${effectiveBranch}_${user.uid}`;
      try {
        const ptrSnap = await getDoc(doc(db, 'cash_register_sessions', userPtrId));
        if (ptrSnap.exists()) {
          const ptrData = ptrSnap.data();
          const activeSessionId = ptrData.activeSessionId || ptrData.sessionId;

          if (activeSessionId) {
            const sessSnap = await getDoc(doc(db, 'cash_register_sessions', activeSessionId));
            if (sessSnap.exists() && sessSnap.data()?.status === 'open') {
              const sData = sessSnap.data();
              // Validar que realmente sea de este operador
              if (!sData.startedBy || sData.startedBy === user.uid) {
                const sessionObj: ActiveCashSessionData = {
                  id: activeSessionId,
                  sessionId: activeSessionId,
                  pointerId: userPtrId,
                  branchId: sData.branchId || effectiveBranch,
                  accountId,
                  status: 'open',
                  initialAmount: Number(sData.initialAmount ?? ptrData.initialAmount ?? 0),
                  openTime: Number(sData.openTime ?? Date.now()),
                  startedBy: sData.startedBy || user.uid,
                  startedByName: sData.startedByName || user?.displayName || '',
                  cashSales: Number(sData.cashSales ?? 0),
                  totalSales: Number(sData.totalSales ?? 0),
                  expectedAmount: Number(sData.expectedAmount ?? 0),
                  isOpen: true,
                  ...sData,
                };
                setIsCashOpen(true);
                setActiveCashSession(sessionObj);
                return sessionObj;
              }
            }
          }
        }
      } catch (ptrErr) {
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
          const sessionObj: ActiveCashSessionData = {
            id: sId,
            sessionId: sId,
            pointerId: userPtrId,
            branchId: data.branchId || effectiveBranch,
            accountId,
            status: 'open',
            initialAmount: Number(data.initialAmount ?? 0),
            openTime: Number(data.openTime ?? data.openedAt ?? Date.now()),
            startedBy: data.startedBy,
            startedByName: data.startedByName || user?.displayName || '',
            cashSales: Number(data.cashSales ?? 0),
            totalSales: Number(data.totalSales ?? 0),
            expectedAmount: Number(data.expectedAmount ?? data.initialAmount ?? 0),
            isOpen: true,
            ...data,
          };

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

          setIsCashOpen(true);
          setActiveCashSession(sessionObj);
          return sessionObj;
        }
      } catch (queryErr) {
        console.warn('[SettingsContext] Fallback query by operator failed:', queryErr);
      }

      // Si el operador no ha abierto caja en esta sucursal: CAJA CERRADA
      setIsCashOpen(false);
      setActiveCashSession(null);
      return null;
    } catch (err) {
      console.warn('[SettingsContext] checkActiveSession error:', err);
      setIsCashOpen(false);
      setActiveCashSession(null);
      return null;
    }
  }, [accountId, branchId, user?.uid, user?.displayName]);

  const refreshCashStatus = useCallback(() => {
    checkActiveSession();
  }, [checkActiveSession]);

  // Suscripción en tiempo real al estado de la Caja
  useEffect(() => {
    if (!accountId || !user?.uid) {
      setIsCashOpen(false);
      setActiveCashSession(null);
      return;
    }

    let isSubscribed = true;
    checkActiveSession();

    const effectiveBranch = branchId || 'main';
    const pointerId = `active_${accountId}_${effectiveBranch}_${user.uid}`;

    const unsubPointer = onSnapshot(
      doc(db, 'cash_register_sessions', pointerId),
      () => {
        if (isSubscribed) {
          checkActiveSession();
        }
      },
      (err) => {
        console.warn('[SettingsContext] pointer listener note:', err);
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

  const contextValue = useMemo(
    () => ({
      primaryColor,
      businessName: businessSettings.businessName || 'Ventify POS',
      businessSettings,
      businessData: businessSettings,
      posSettings,
      branches,
      activeBranchName,
      activeBranch,
      isCashOpen,
      activeCashSession,
      invoicingEnabled,
      paymentMethods,
      allPaymentMethods,
      isOnline,
      offlineQueueCount,
      refreshOfflineCount,
      updateBusinessSettings,
      updateBusinessData: updateBusinessSettings,
      updatePosSettings,
      togglePaymentMethod,
      refreshCashStatus,
    }),
    [
      primaryColor,
      businessSettings,
      posSettings,
      branches,
      activeBranchName,
      activeBranch,
      isCashOpen,
      activeCashSession,
      invoicingEnabled,
      paymentMethods,
      allPaymentMethods,
      isOnline,
      offlineQueueCount,
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
