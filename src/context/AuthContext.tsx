import { createProfileResolutionGate, loadIdentitySources } from '@/lib/auth-startup';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  User,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  collection,
  query,
  where,
  getDocs,
  limit,
} from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { apiRequest } from '@/lib/api-client';
import { accessBlockReason, profilePermissions, liveProfileAccount, type SubscriptionAccess } from '@/lib/access-policy';
import { auth, db } from '@/lib/firebase';
import { UserProfile } from '@/types';
import { hasAllBranchesAccess } from '@/lib/branch-access';

export type UserRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'seller';

export interface CustomUserPermissions {
  granted?: string[];
  revoked?: string[];
}

export interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  accountId: string | null;
  branchId: string;
  role: UserRole;
  allBranchesAccess: boolean;
  customPermissions: CustomUserPermissions | null;
  isActive: boolean;
  accessChecking: boolean;
  accessError: string | null;
  accessBlocked: string | null;
  refreshAccess: () => Promise<void>;
  initialized: boolean;
  loading: boolean;
  isPinLocked: boolean;
  pinCode: string;
  login: (email: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  setActiveBranchId: (newBranchId: string) => void;
  setBranchId: (newBranchId: string) => void;
  lockTerminal: () => void;
  unlockWithPin: (enteredPin: string) => boolean;
  updatePinCode: (newPin: string) => Promise<void>;
}

const STORAGE_ACCOUNT_ID_KEY = '@ventify_mobile_account_id';
const STORAGE_BRANCH_ID_KEY = '@ventify_mobile_branch_id';
const SECURE_PIN_KEY = '@ventify_terminal_pin';
const DEFAULT_PIN = '1234';

const AuthContext = createContext<AuthContextType>({
  user: null,
  userProfile: null,
  accountId: null,
  branchId: 'main',
  role: 'cashier',
  allBranchesAccess: false,
  customPermissions: null,
  isActive: true,
  accessChecking: true,
  accessError: null,
  accessBlocked: null,
  refreshAccess: async () => {},
  initialized: false,
  loading: true,
  isPinLocked: false,
  pinCode: DEFAULT_PIN,
  login: async () => {},
  logout: async () => {},
  setActiveBranchId: () => {},
  setBranchId: () => {},
  lockTerminal: () => {},
  unlockWithPin: () => false,
  updatePinCode: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [branchId, setBranchIdState] = useState<string>('main');
  const [role, setRole] = useState<UserRole>('cashier');
  const [allBranchesAccess, setAllBranchesAccess] = useState<boolean>(false);
  const [customPermissions, setCustomPermissions] = useState<CustomUserPermissions | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionAccess | null>(null);
  const [accessChecking, setAccessChecking] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessClock, setAccessClock] = useState(Date.now());
  const identityRef = useRef('');
  const accessRequestRef = useRef(0);
  identityRef.current = `${user?.uid || ''}:${accountId || ''}`;


  const [initialized, setInitialized] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [isPinLocked, setIsPinLocked] = useState<boolean>(false);
  const [pinCode, setPinCode] = useState<string>(DEFAULT_PIN);

  // 1. Inicializar almacenamiento persistente local (PIN, accountId, branchId previos)
  useEffect(() => {
    let isMounted = true;

    async function loadStoredAuthMeta() {
      try {
        // Cargar PIN seguro
        let savedPin: string | null = null;
        try {
          const isSecureAvailable = await SecureStore.isAvailableAsync();
          if (isSecureAvailable) {
            savedPin = await SecureStore.getItemAsync(SECURE_PIN_KEY);
          }
        } catch {
          // Fallback a AsyncStorage
        }

        if (!savedPin) {
          savedPin = await AsyncStorage.getItem(SECURE_PIN_KEY);
        }

        if (savedPin && isMounted) {
          setPinCode(savedPin);
        }

      } catch (err) {
        console.warn('[AuthContext] Error loading initial storage:', err);
      }
    }

    loadStoredAuthMeta();
    return () => {
      isMounted = false;
    };
  }, []);

  const resolveProfileOnce = useMemo(createProfileResolutionGate, []);

  // 2. Resolver accountId, role, branchId y permisos del usuario autenticado
  const resolveUserProfile = useCallback((firebaseUser: User) => resolveProfileOnce(firebaseUser.uid, async () => {
    try {
      let resolvedAccountId: string | null = null;
      let resolvedRole: UserRole = 'cashier';
      let resolvedBranchId: string | undefined = undefined;
      let resolvedAllBranches = false;
      let resolvedCustomPermissions: CustomUserPermissions | null = null;

      const [claimsResult, profileResult] = await loadIdentitySources(
        () => firebaseUser.getIdTokenResult(false),
        () => getDoc(doc(db, 'users', firebaseUser.uid)),
      );
      if (auth.currentUser?.uid !== firebaseUser.uid) return null;

      // 1. Verificar custom claims del JWT
      try {
        if (claimsResult.status === 'rejected') throw claimsResult.reason;
        const tokenResult = claimsResult.value;
        const claims = tokenResult.claims;
        if (auth.currentUser?.uid !== firebaseUser.uid) return null;
        setIsSuperAdmin(claims.isSuperAdmin === true || claims.superAdmin === true);

        if (claims.accountId) {
          resolvedAccountId = String(claims.accountId);
        }
        if (claims.role) {
          resolvedRole = claims.role as UserRole;
        }
        if (claims.branchId) {
          resolvedBranchId = String(claims.branchId);
        }
        if (claims.allBranchesAccess !== undefined) {
          resolvedAllBranches = Boolean(claims.allBranchesAccess);
        }
      } catch (claimErr) {
        console.warn('[AuthContext] Error decoding custom claims:', claimErr);
      }

      // 2. Consultar documento del usuario en Firestore `users/{uid}`
      try {
        if (profileResult.status === 'rejected') throw profileResult.reason;
        const userSnap = profileResult.value;

        if (userSnap.exists()) {
          const uData = userSnap.data();
          if (auth.currentUser?.uid !== firebaseUser.uid) return null;
          setIsActive(uData.isActive !== false);
          if (uData.accountId) {
            resolvedAccountId = uData.accountId;
          }
          if (uData.role) {
            resolvedRole = uData.role as UserRole;
          }
          if (uData.branchId) {
            resolvedBranchId = uData.branchId;
          }
          if (uData.allBranchesAccess !== undefined) {
            resolvedAllBranches = Boolean(uData.allBranchesAccess);
          }
          resolvedCustomPermissions = profilePermissions(uData);

          setUserProfile({
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            displayName: uData.displayName || uData.name || firebaseUser.displayName,
            photoURL: uData.photoURL || firebaseUser.photoURL,
            emailVerified: firebaseUser.emailVerified,
            role: resolvedRole,
            accountId: resolvedAccountId || uData.accountId,
            branchId: resolvedBranchId || uData.branchId,
            createdAt: uData.createdAt,
          });
        }
      } catch (docErr) {
        console.warn('[AuthContext] Error reading user doc:', docErr);
      }

      // 3. Fallback: Buscar en colección `accounts` donde `ownerId == uid`
      if (!resolvedAccountId) {
        try {
          const accQ = query(
            collection(db, 'accounts'),
            where('ownerId', '==', firebaseUser.uid),
            limit(1)
          );
          const accSnap = await getDocs(accQ);
          if (!accSnap.empty) {
            resolvedAccountId = accSnap.docs[0].id;
            resolvedRole = 'owner';
            resolvedAllBranches = true;
          }
        } catch (accErr) {
          console.warn('[AuthContext] Error querying accounts:', accErr);
        }
      }

      // 4. Si el usuario no tiene branchId fijo en su perfil (ej. owner en demo@ventify.pe),
      // resolver inmediatamente la sucursal principal de la cuenta para que el stock y caja carguen al instante
      if (resolvedAccountId && (!resolvedBranchId || resolvedBranchId === 'main')) {
        // En firestore.rules, el rol 'seller' no tiene permisos de lectura sobre colecciones directas como 'branches'
        if (resolvedRole !== 'seller') {
          try {
            const branchSnap = await getDocs(
              query(collection(db, 'branches'), where('accountId', '==', resolvedAccountId), limit(10))
            );
            if (!branchSnap.empty) {
              const activeDocs = branchSnap.docs.filter((d) => d.data().isActive !== false);
              if (activeDocs.length > 0) {
                const principalDoc =
                  activeDocs.find((d) =>
                    String(d.data().name || '')
                      .toUpperCase()
                      .includes('PRINCIPAL')
                  ) || activeDocs[0];
                resolvedBranchId = principalDoc.id;
              }
            }
          } catch (branchErr) {
            console.warn('[AuthContext] Error resolving default branch:', branchErr);
          }
        }
      }

      // Propietarios y administradores SIEMPRE tienen acceso global garantizado
      resolvedAllBranches = hasAllBranchesAccess({
        role: resolvedRole,
        branchId: resolvedBranchId,
        allBranchesAccess: resolvedAllBranches,
      });

      // Ignore an old user lookup if sign-out or another login happened meanwhile.
      if (auth.currentUser?.uid !== firebaseUser.uid) return null;
      setAccountId(resolvedAccountId);
      if (resolvedAccountId) {
        await AsyncStorage.setItem(STORAGE_ACCOUNT_ID_KEY, resolvedAccountId).catch(() => {});
      }

      setRole(resolvedRole);
      setAllBranchesAccess(resolvedAllBranches);
      setCustomPermissions(resolvedCustomPermissions);

      setBranchIdState(resolvedBranchId || 'main');
      if (resolvedBranchId && resolvedBranchId !== 'main') {
        setBranchIdState(resolvedBranchId);
        await AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, resolvedBranchId).catch(() => {});
      }

      return resolvedAccountId;
    } catch (generalErr) {
      console.error('[AuthContext] General error resolving user profile:', generalErr);
      return null;
    }
  }), [resolveProfileOnce]);

  // 3. Escuchar cambios de autenticación en Firebase
  useEffect(() => {
    let unsubUserDoc: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
      if (unsubUserDoc) { unsubUserDoc(); unsubUserDoc = null; }
      setUser(u);
      setUserProfile(null);
      setIsSuperAdmin(false);
      setAccountId(null);
      setBranchIdState('main');
      setRole('cashier');
      setAllBranchesAccess(false);
      setSubscription(null);
      setAccessError(null);
      setAccessChecking(Boolean(u));
      setCustomPermissions(null);
      setIsActive(true);

      if (u) {
        setLoading(true);
        const resolvedAccount = await resolveUserProfile(u);
        if (auth.currentUser?.uid !== u.uid) return;
        if (!resolvedAccount) { setAccessChecking(false); setAccessError("No se pudo determinar la cuenta. Vuelve a iniciar sesión."); }
        // Desbloquear UI inmediatamente tras resolver perfil y claims
        setLoading(false);
        setInitialized(true);

        // Suscribirse en tiempo real al documento del usuario para reflejar cambios de rol o sede
        try {
          const userDocRef = doc(db, 'users', u.uid);
          let hasSeenExplicitAccount = false;
          unsubUserDoc = onSnapshot(
            userDocRef,
            (snap) => {
              if (auth.currentUser?.uid !== u.uid) return;
              if (snap.exists()) {
                const data = snap.data();
                setIsActive(data.isActive !== false);
                const uRole = (data.role as UserRole) || 'cashier';
                setRole(uRole);

                const liveAccountId = liveProfileAccount(data.accountId, resolvedAccount, hasSeenExplicitAccount);
                if (data.accountId) hasSeenExplicitAccount = true;
                const accountChanged = identityRef.current !== `${u.uid}:${liveAccountId || ''}`;
                if (accountChanged) { setSubscription(null); setAccessChecking(Boolean(liveAccountId)); }
                setAccountId(liveAccountId);
                if (data.accountId) {
                  AsyncStorage.setItem(STORAGE_ACCOUNT_ID_KEY, data.accountId).catch(() => {});
                }

                if (data.branchId) {
                  setBranchIdState(data.branchId);
                  AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, data.branchId).catch(() => {});
                } else if (accountChanged) {
                  setBranchIdState('main');
                  void resolveUserProfile(u);
                }

                const effectiveAllBranches = hasAllBranchesAccess({
                  role: uRole,
                  branchId: data.branchId,
                  allBranchesAccess: data.allBranchesAccess === true,
                });
                setAllBranchesAccess(effectiveAllBranches);

                setCustomPermissions(profilePermissions(data));

                const nextProfile: UserProfile = {
                  uid: u.uid,
                  email: u.email,
                  displayName: data.displayName || data.name || u.displayName,
                  photoURL: data.photoURL || u.photoURL,
                  emailVerified: u.emailVerified,
                  role: uRole,
                  accountId: liveAccountId || undefined,
                  branchId: data.branchId,
                  createdAt: data.createdAt,
                };
                setUserProfile((prev) => {
                  if (
                    prev &&
                    prev.uid === nextProfile.uid &&
                    prev.email === nextProfile.email &&
                    prev.displayName === nextProfile.displayName &&
                    prev.photoURL === nextProfile.photoURL &&
                    prev.role === nextProfile.role &&
                    prev.accountId === nextProfile.accountId &&
                    prev.branchId === nextProfile.branchId
                  ) {
                    return prev;
                  }
                  return nextProfile;
                });
              } else { setIsActive(false); setCustomPermissions(null); }
            },
            (err) => {
              console.warn('[AuthContext] Realtime user doc subscription warning:', err);
            }
          );
        } catch {
          // ignore
        }
      } else {
        // Cierre de sesión o usuario no autenticado
        setUser(null);
        setUserProfile(null);
        setAccountId(null);
        setBranchIdState('main');
        setRole('cashier');
        setAllBranchesAccess(false);
        setCustomPermissions(null);
        setIsPinLocked(false);
        setIsSuperAdmin(false);
        setAccessChecking(false);

        await AsyncStorage.multiRemove([
          STORAGE_ACCOUNT_ID_KEY,
          STORAGE_BRANCH_ID_KEY,
          '@ventify_pos_cart',
        ]).catch(() => {});

        setLoading(false);
        setInitialized(true);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, [resolveUserProfile]);

  // The same plan endpoint and six-hour fallback cache used by the web client.
  const refreshAccess = useCallback(async () => {
    if (!user || !accountId || loading) return;
    if (role === 'seller' || isSuperAdmin) {
      // The seller report endpoint enforces its own business and profile state.
      setAccessChecking(false);
      setAccessError(null);
      return;
    }
    const scope = `${user.uid}:${accountId}`;
    const requestId = ++accessRequestRef.current;
    const isCurrent = () => identityRef.current === scope && accessRequestRef.current === requestId;
    const cacheKey = `@ventify_plan:${scope}`;
    let cached: { subscription: SubscriptionAccess | null; cachedAt: number } | null = null;
    try {
      const raw = await AsyncStorage.getItem(cacheKey);
      cached = raw ? JSON.parse(raw) : null;
      if (cached && Date.now() - cached.cachedAt < 6 * 3600000 && isCurrent()) {
        setSubscription(cached.subscription);
        setAccessChecking(false);
      }
    } catch { /* A malformed cache never grants access. */ }
    try {
      const data = await apiRequest<{ subscription: SubscriptionAccess | null }>(`/api/plan-limits/${encodeURIComponent(accountId)}`);
      if (!isCurrent()) return;
      setSubscription(data.subscription);
      setAccessError(null);
      await AsyncStorage.setItem(cacheKey, JSON.stringify({ subscription: data.subscription, cachedAt: Date.now() }));
    } catch (error) {
      if (!isCurrent()) return;
      const status = (error as { status?: number }).status;
      const mayUseCache = (!status || status === 408 || status >= 500) && cached && Date.now() - cached.cachedAt < 6 * 3600000;
      if (!mayUseCache) setAccessError(error instanceof Error ? error.message : 'No se pudo verificar el acceso del negocio.');
    } finally {
      if (isCurrent()) { setAccessClock(Date.now()); setAccessChecking(false); }
    }
  }, [user?.uid, accountId, role, isSuperAdmin, loading]);

  useEffect(() => {
    if (!user || !accountId || loading) return;
    setAccessChecking(true);
    setAccessError(null);
    void refreshAccess();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setAccessClock(Date.now());
        void refreshAccess();
      }
    });
    return () => {
      foreground.remove();
    };
  }, [user?.uid, accountId, loading, refreshAccess]);

  const accessBlocked = accessBlockReason({ isActive, isSuperAdmin }, subscription, accessClock);

  // 4. Cambiar sucursal activa
  const setActiveBranchId = useCallback((newBranchId: string) => {
    if (!newBranchId) return;
    const canChange = hasAllBranchesAccess({ role, branchId, allBranchesAccess });
    if (!canChange) {
      console.warn('[AuthContext] Usuario sin acceso multisede no puede cambiar de sucursal');
      return;
    }
    setBranchIdState(newBranchId);
    AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, newBranchId).catch(() => {});
  }, [role, branchId, allBranchesAccess]);

  // 5. Iniciar sesión con email y contraseña
  const login = useCallback(
    async (email: string, pass: string) => {
      setLoading(true);
      try {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);
        await resolveUserProfile(cred.user);
      } finally {
        setLoading(false);
      }
    },
    [resolveUserProfile]
  );

  // 6. Cerrar sesión segura
  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await signOut(auth);
      setUser(null);
      setUserProfile(null);
      setAccountId(null);
      setIsPinLocked(false);
      await AsyncStorage.multiRemove([
        STORAGE_ACCOUNT_ID_KEY,
        STORAGE_BRANCH_ID_KEY,
        '@ventify_pos_cart',
      ]).catch(() => {});
    } finally {
      setLoading(false);
    }
  }, []);

  // 7. Bloqueo rápido de terminal por PIN
  const lockTerminal = useCallback(() => {
    setIsPinLocked(true);
  }, []);

  // 8. Desbloqueo mediante PIN
  const unlockWithPin = useCallback(
    (enteredPin: string): boolean => {
      const cleanEntered = enteredPin.trim();
      const cleanExpected = pinCode.trim() || DEFAULT_PIN;

      if (cleanEntered === cleanExpected) {
        setIsPinLocked(false);
        return true;
      }
      return false;
    },
    [pinCode]
  );

  // 9. Actualizar código PIN con persistencia segura
  const updatePinCode = useCallback(async (newPin: string) => {
    const cleanPin = newPin.trim();
    if (cleanPin.length < 4) {
      throw new Error('El PIN debe tener al menos 4 dígitos numéricos.');
    }

    setPinCode(cleanPin);

    try {
      const isSecureAvailable = await SecureStore.isAvailableAsync();
      if (isSecureAvailable) {
        await SecureStore.setItemAsync(SECURE_PIN_KEY, cleanPin);
      } else {
        await AsyncStorage.setItem(SECURE_PIN_KEY, cleanPin);
      }
    } catch {
      await AsyncStorage.setItem(SECURE_PIN_KEY, cleanPin).catch(() => {});
    }
  }, []);

  const contextValue = useMemo(
    () => ({
      user,
      userProfile,
      accountId,
      branchId,
      role,
      allBranchesAccess,
      customPermissions,
      isActive,
      accessChecking,
      accessError,
      accessBlocked,
      refreshAccess,
      initialized,
      loading,
      isPinLocked,
      pinCode,
      login,
      logout,
      setActiveBranchId,
      setBranchId: setActiveBranchId,
      lockTerminal,
      unlockWithPin,
      updatePinCode,
    }),
    [
      user,
      userProfile,
      accountId,
      branchId,
      role,
      allBranchesAccess,
      customPermissions,
      isActive,
      accessChecking,
      accessError,
      accessBlocked,
      refreshAccess,
      initialized,
      loading,
      isPinLocked,
      pinCode,
      login,
      logout,
      setActiveBranchId,
      lockTerminal,
      unlockWithPin,
      updatePinCode,
    ]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
