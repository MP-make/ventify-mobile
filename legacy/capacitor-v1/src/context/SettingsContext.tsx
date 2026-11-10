import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { doc, onSnapshot, collection, query, where, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthContext';

export interface Branch {
  id: string;
  name: string;
  address?: string;
  phone?: string;
}

export interface ActiveCashSessionData {
  sessionId: string;
  pointerId: string;
  initialAmount: number;
  openedAt?: any;
  branchId: string;
  accountId: string;
  cashSalesTotal?: number;
  [key: string]: any;
}

export interface AccountPaymentMethod {
  id: string;
  name: string;
  kind: 'cash' | 'digital' | 'card' | 'mixed' | 'credit';
  enabled: boolean;
  order: number;
}

export interface BusinessData {
  businessName: string;
  ruc?: string;
  address?: string;
  phone?: string;
  email?: string;
  description?: string;
  website?: string;
}

export interface MobilePosSettings {
  enableQuickSale: boolean;
  defaultDocumentType: 'nota_venta' | 'boleta' | 'factura';
  ticketFooterMessage: string;
  showBusinessPhone: boolean;
  showAddress: boolean;
  showTaxId: boolean;
  requireSellerSelection?: boolean;
  allowMixedPayment?: boolean;
}

export const DEFAULT_POS_SETTINGS: MobilePosSettings = {
  enableQuickSale: true,
  defaultDocumentType: 'nota_venta',
  ticketFooterMessage: '¡Gracias por su compra!',
  showBusinessPhone: true,
  showAddress: true,
  showTaxId: true,
  requireSellerSelection: false,
  allowMixedPayment: true,
};

const DEFAULT_METHODS: AccountPaymentMethod[] = [
  { id: 'efectivo', name: 'Efectivo', kind: 'cash', enabled: true, order: 0 },
  { id: 'yape', name: 'Yape', kind: 'digital', enabled: true, order: 1 },
  { id: 'plin', name: 'Plin', kind: 'digital', enabled: true, order: 2 },
  { id: 'tarjeta', name: 'Tarjeta', kind: 'card', enabled: true, order: 3 },
  { id: 'transferencia', name: 'Transferencia', kind: 'digital', enabled: true, order: 4 },
];

interface SettingsContextType {
  primaryColor: string;
  businessName: string;
  businessData: BusinessData;
  branches: Branch[];
  activeBranchName: string;
  isCashOpen: boolean;
  activeCashSession: ActiveCashSessionData | null;
  paymentMethods: AccountPaymentMethod[];
  allPaymentMethods: AccountPaymentMethod[];
  posSettings: MobilePosSettings;
  updateBusinessData: (patch: Partial<BusinessData>) => Promise<void>;
  updatePosSettings: (patch: Partial<MobilePosSettings>) => Promise<void>;
  togglePaymentMethod: (methodId: string, enabled: boolean) => Promise<void>;
  refreshCashStatus: () => void;
}

const SettingsContext = createContext<SettingsContextType>({
  primaryColor: '#047857',
  businessName: 'Ventify POS',
  businessData: { businessName: 'Ventify POS' },
  branches: [],
  activeBranchName: 'Tienda Principal',
  isCashOpen: false,
  activeCashSession: null,
  paymentMethods: DEFAULT_METHODS,
  allPaymentMethods: DEFAULT_METHODS,
  posSettings: DEFAULT_POS_SETTINGS,
  updateBusinessData: async () => {},
  updatePosSettings: async () => {},
  togglePaymentMethod: async () => {},
  refreshCashStatus: () => {},
});

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { accountId, branchId, setBranchId, user } = useAuth();
  const [primaryColor, setPrimaryColor] = useState('#047857');
  const [businessName, setBusinessName] = useState('Ventify POS');
  const [businessData, setBusinessData] = useState<BusinessData>({ businessName: 'Ventify POS' });
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isCashOpen, setIsCashOpen] = useState(false);
  const [activeCashSession, setActiveCashSession] = useState<ActiveCashSessionData | null>(null);
  const [allPaymentMethods, setAllPaymentMethods] = useState<AccountPaymentMethod[]>(DEFAULT_METHODS);
  const [paymentMethods, setPaymentMethods] = useState<AccountPaymentMethod[]>(DEFAULT_METHODS);
  const [posSettings, setPosSettings] = useState<MobilePosSettings>(DEFAULT_POS_SETTINGS);

  // 1. Appearance & Business Name
  useEffect(() => {
    if (!accountId) return;

    // Appearance doc
    const appearanceRef = doc(db, 'settings', `${accountId}_appearance`);
    const unsubAppearance = onSnapshot(appearanceRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const color = data.primaryColor || '#047857';
        setPrimaryColor(color);
        document.documentElement.style.setProperty('--brand-primary', color);
      }
    }, (err) => console.warn('[SettingsContext] appearance error:', err));

    // Business info doc
    const businessRef = doc(db, 'settings', `${accountId}_business`);
    const unsubBusiness = onSnapshot(businessRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.businessName) setBusinessName(data.businessName);
        setBusinessData({
          businessName: data.businessName || 'Ventify POS',
          ruc: data.ruc || data.taxId || '',
          address: data.address || data.fiscalAddress || '',
          phone: data.phone || '',
          email: data.email || '',
          description: data.description || '',
          website: data.website || '',
        });
      }
    }, (err) => console.warn('[SettingsContext] business error:', err));

    // POS Settings doc (Métodos de pago del negocio + Parámetros)
    const posSettingsRef = doc(db, 'settings', `${accountId}_pos`);
    const unsubPos = onSnapshot(posSettingsRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();

        // Parámetros del POS
        setPosSettings({
          enableQuickSale: data.enableQuickSale !== false,
          defaultDocumentType: data.defaultDocumentType || 'nota_venta',
          ticketFooterMessage: data.ticketFooterMessage || '¡Gracias por su compra!',
          showBusinessPhone: data.showBusinessPhone !== false,
          showAddress: data.showAddress !== false,
          showTaxId: data.showTaxId !== false,
          requireSellerSelection: data.requireSellerSelection === true,
          allowMixedPayment: data.allowMixedPayment !== false,
        });

        // Métodos de pago configurados
        if (Array.isArray(data.methods) && data.methods.length > 0) {
          const allList = data.methods
            .filter((m: any) => m.kind !== 'mixed')
            .sort((a: any, b: any) => (a.order || 0) - (b.order || 0))
            .map((m: any) => ({
              id: m.id,
              name: m.name,
              kind: m.kind || 'digital',
              enabled: m.enabled !== false,
              order: m.order || 0,
            }));
          setAllPaymentMethods(allList);

          const enabledOnly = allList.filter((m) => m.enabled);
          if (enabledOnly.length > 0) {
            setPaymentMethods(enabledOnly);
          } else {
            setPaymentMethods(DEFAULT_METHODS);
          }
        } else {
          setAllPaymentMethods(DEFAULT_METHODS);
          setPaymentMethods(DEFAULT_METHODS);
        }
      }
    }, (err) => console.warn('[SettingsContext] pos settings error:', err));

    return () => {
      unsubAppearance();
      unsubBusiness();
      unsubPos();
    };
  }, [accountId]);

  // 2. Branches & Auto-selection
  useEffect(() => {
    if (!accountId) return;
    const branchesQuery = query(collection(db, 'branches'), where('accountId', '==', accountId));
    const unsub = onSnapshot(branchesQuery, (snap) => {
      const list: Branch[] = snap.docs.map((d) => ({
        id: d.id,
        name: d.data().name || 'Sucursal',
        address: d.data().address,
        phone: d.data().phone,
      }));
      setBranches(list);

      // Si branchId sigue en 'main' o no coincide con ninguna sede existente,
      // adoptar la primera sucursal real de la lista
      if (list.length > 0) {
        if (branchId === 'main' || !list.some((b) => b.id === branchId)) {
          setBranchId(list[0].id);
        }
      }
    }, (err) => console.warn('[SettingsContext] branches error:', err));

    return () => unsub();
  }, [accountId, branchId, setBranchId]);

  // 3. Cash Session Status (Sincronización multi-sucursal y puntero de caja)
  useEffect(() => {
    if (!accountId) return;

    // Escuchar sesiones abiertas en cash_register_sessions (status == 'open')
    const sessionsQuery = query(
      collection(db, 'cash_register_sessions'),
      where('accountId', '==', accountId),
      where('status', '==', 'open')
    );

    const unsubSessions = onSnapshot(sessionsQuery, async (snap) => {
      if (!snap.empty) {
        // 1. Buscar coincidencia por sucursal y usuario operador
        let targetDoc = snap.docs.find((d) => {
          const data = d.data();
          const matchesBranch = !branchId || branchId === 'main' || data.branchId === branchId;
          return matchesBranch && user?.uid && data.startedBy === user.uid;
        });

        // 2. Buscar coincidencia por sucursal actual
        if (!targetDoc) {
          targetDoc = snap.docs.find((d) => {
            const data = d.data();
            return data.branchId === branchId;
          });
        }

        // 3. Fallback: primera sesión abierta del negocio (ej. Owner con acceso global)
        if (!targetDoc) {
          targetDoc = snap.docs[0];
        }

        const data = targetDoc.data();
        if (data.branchId && data.branchId !== 'main' && branchId === 'main') {
          setBranchId(data.branchId);
        }

        const sId = targetDoc.id;
        setIsCashOpen(true);
        setActiveCashSession({
          sessionId: sId,
          pointerId: `active_${accountId}_${data.branchId || branchId}_${data.startedBy || user?.uid || 'user'}`,
          initialAmount: data.initialAmount ?? 0,
          openedAt: data.openTime || data.openedAt || null,
          branchId: data.branchId || branchId,
          accountId,
          startedByName: data.startedByName || '',
          startedBy: data.startedBy || '',
          cashSales: data.cashSales ?? 0,
          expectedAmount: data.expectedAmount ?? data.initialAmount ?? 0,
          ...data,
        });
        return;
      }

      // Si no hubo documentos directos con status 'open', revisar puntero multicaja activo
      if (branchId) {
        try {
          const operatorPointer = user?.uid ? `active_${accountId}_${branchId}_${user.uid}` : null;
          const branchPointer = `active_${accountId}_${branchId}`;
          const pointerIdToUse = operatorPointer || branchPointer;

          const pointerSnap = await getDoc(doc(db, 'cash_register_sessions', pointerIdToUse));
          if (pointerSnap.exists()) {
            const pData = pointerSnap.data();
            const sId = pData.activeSessionId || pData.sessionId;
            if (sId) {
              const sessionSnap = await getDoc(doc(db, 'cash_register_sessions', sId));
              if (sessionSnap.exists() && sessionSnap.data()?.status === 'open') {
                const sData = sessionSnap.data();
                setIsCashOpen(true);
                setActiveCashSession({
                  sessionId: sId,
                  pointerId: pointerSnap.id,
                  initialAmount: sData.initialAmount ?? pData.initialAmount ?? 0,
                  openedAt: sData.openTime || sData.openedAt || null,
                  branchId,
                  accountId,
                  startedByName: sData.startedByName || '',
                  startedBy: sData.startedBy || '',
                  cashSales: sData.cashSales ?? 0,
                  expectedAmount: sData.expectedAmount ?? sData.initialAmount ?? 0,
                  ...sData,
                });
                return;
              }
            }
          }
        } catch (ptrErr) {
          console.warn('[SettingsContext] pointer resolution error:', ptrErr);
        }
      }

      setIsCashOpen(false);
      setActiveCashSession(null);
    }, (err) => {
      console.warn('[SettingsContext] cash sessions query error:', err);
      setIsCashOpen(false);
      setActiveCashSession(null);
    });

    return () => unsubSessions();
  }, [accountId, branchId, user?.uid, setBranchId]);

  // Guardar datos del negocio
  const updateBusinessData = useCallback(async (patch: Partial<BusinessData>) => {
    if (!accountId) return;
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([_, v]) => v !== undefined)
    );
    await setDoc(doc(db, 'settings', `${accountId}_business`), {
      ...cleanPatch,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }, [accountId]);

  // Guardar parámetros del POS
  const updatePosSettings = useCallback(async (patch: Partial<MobilePosSettings>) => {
    if (!accountId) return;
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([_, v]) => v !== undefined)
    );
    await setDoc(doc(db, 'settings', `${accountId}_pos`), {
      ...cleanPatch,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }, [accountId]);

  // Activar o desactivar método de pago
  const togglePaymentMethod = useCallback(async (methodId: string, enabled: boolean) => {
    if (!accountId) return;
    const updated = allPaymentMethods.map((m) =>
      m.id === methodId ? { ...m, enabled } : m
    );
    setAllPaymentMethods(updated);
    await setDoc(doc(db, 'settings', `${accountId}_pos`), {
      methods: updated.map((m, idx) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        enabled: m.enabled,
        order: idx,
      })),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  }, [accountId, allPaymentMethods]);

  const activeBranchName =
    branches.find((b) => b.id === branchId)?.name || 'Tienda Principal';

  return (
    <SettingsContext.Provider
      value={{
        primaryColor,
        businessName,
        businessData,
        branches,
        activeBranchName,
        isCashOpen,
        activeCashSession,
        paymentMethods,
        allPaymentMethods,
        posSettings,
        updateBusinessData,
        updatePosSettings,
        togglePaymentMethod,
        refreshCashStatus: () => {},
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => useContext(SettingsContext);
