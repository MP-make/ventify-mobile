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
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
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
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { apiRequest } from '@/lib/api-client';
import {
  accessBlockReason,
  profilePermissions,
  liveProfileAccount,
  type SubscriptionAccess,
} from '@/lib/access-policy';
import { auth, db } from '@/lib/firebase';
import { UserProfile } from '@/types';
import { hasAllBranchesAccess } from '@/lib/branch-access';
import { cartStorageKeys } from '@/lib/cart-scope';
import { cartKVStorage, catalogKVStorage } from '@/lib/native-kv-storage';
import { productCatalogCacheKey } from '@/lib/product-catalog-cache';
import {
  PIN_MIN_LENGTH,
  createStoredPinRecord,
  initialPinAttemptState,
  isPinLockedOut,
  parseStoredPin,
  registerFailedPinAttempt,
  resetPinAttemptState,
  serializeStoredPinRecord,
  verifyStoredPin,
  type PinAttemptState,
  type StoredPinRecord,
} from '@/lib/pin-mobile';

export type UserRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'seller';

export interface CustomUserPermissions {
  granted?: string[];
  revoked?: string[];
}

export interface PlanLimitEntry {
  current: number;
  max: number;
  type: 'hard' | 'soft';
}

export interface PlanLimits {
  users: PlanLimitEntry;
  branches: PlanLimitEntry;
  products: PlanLimitEntry;
  storage?: PlanLimitEntry;
  aiMessages?: PlanLimitEntry;
}

export interface PlanSubscription extends SubscriptionAccess {
  planId?: string;
  planName?: string;
  pauseReason?: string | null;
  cancelReason?: string | null;
  cancelledAt?: number | null;
  endDate?: number | null;
  trialEndDate?: number | null;
  cycle?: string;
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
  isSuperAdmin: boolean;
  limits: PlanLimits | null;
  subscription: PlanSubscription | null;
  isOnline: boolean;
  accessChecking: boolean;
  accessError: string | null;
  accessBlocked: string | null;
  refreshAccess: () => Promise<void>;
  initialized: boolean;
  loading: boolean;
  isPinLocked: boolean;
  pinCode: string;
  pinLength: number;
  hasConfiguredPin: boolean;
  isPinSetupOpen: boolean;
  closePinSetup: () => void;
  pinFailedAttempts: number;
  pinLockoutUntil: number | null;
  login: (email: string, pass: string) => Promise<void>;
  signup: (email: string, password: string, businessName: string, ownerName: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  setActiveBranchId: (newBranchId: string) => void;
  setBranchId: (newBranchId: string) => void;
  syncAssignedBranchId: (assignedBranchId: string) => void;
  lockTerminal: () => void;
  unlockWithPin: (enteredPin: string) => boolean;
  updatePinCode: (newPin: string) => Promise<void>;
}

const STORAGE_ACCOUNT_ID_KEY = '@ventify_mobile_account_id';
const STORAGE_BRANCH_ID_KEY = '@ventify_mobile_branch_id';
const STORAGE_PIN_ATTEMPTS_KEY = '@ventify_terminal_pin_attempts';
const SECURE_PIN_KEY = '@ventify_terminal_pin';
const PLAN_CACHE_PREFIX = '@ventify_plan:';
const PLAN_CACHE_ONLINE_TTL_MS = 6 * 3600000;
const PLAN_CACHE_OFFLINE_TTL_MS = 72 * 3600000;

interface CachedPlanPayload {
  limits?: PlanLimits | null;
  subscription: PlanSubscription | null;
  cachedAt: number;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userProfile: null,
  accountId: null,
  branchId: 'main',
  role: 'cashier',
  allBranchesAccess: false,
  customPermissions: null,
  isActive: true,
  isSuperAdmin: false,
  limits: null,
  subscription: null,
  isOnline: true,
  accessChecking: true,
  accessError: null,
  accessBlocked: null,
  refreshAccess: async () => {},
  initialized: false,
  loading: true,
  isPinLocked: false,
  pinCode: '',
  pinLength: PIN_MIN_LENGTH,
  hasConfiguredPin: false,
  isPinSetupOpen: false,
  closePinSetup: () => {},
  pinFailedAttempts: 0,
  pinLockoutUntil: null,
  login: async () => {},
  signup: async () => {},
  sendPasswordReset: async () => {},
  logout: async () => {},
  setActiveBranchId: () => {},
  setBranchId: () => {},
  syncAssignedBranchId: () => {},
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
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  const [subscription, setSubscription] = useState<PlanSubscription | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [accessChecking, setAccessChecking] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [accessClock, setAccessClock] = useState(Date.now());

  const [initialized, setInitialized] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [isPinLocked, setIsPinLocked] = useState<boolean>(false);
  const [isPinSetupOpen, setIsPinSetupOpen] = useState<boolean>(false);
  const [pinLength, setPinLength] = useState<number>(PIN_MIN_LENGTH);
  const [hasConfiguredPin, setHasConfiguredPin] = useState<boolean>(false);
  const [pinAttemptState, setPinAttemptState] = useState<PinAttemptState>(initialPinAttemptState);

  const identityRef = useRef('');
  const lastSessionRef = useRef<{ uid: string | null; accountId: string | null }>({
    uid: null,
    accountId: null,
  });
  const visitedBranchesRef = useRef<Set<string>>(new Set(['main']));
  const accessRequestRef = useRef(0);
  const storedPinRawRef = useRef<string | null>(null);
  const pinAttemptStateRef = useRef<PinAttemptState>(initialPinAttemptState());
  const signupInProgressRef = useRef<Promise<void> | null>(null);
  const isOnlineRef = useRef<boolean>(true);
  const wasOfflineRef = useRef<boolean>(false);

  identityRef.current = `${user?.uid || ''}:${accountId || ''}`;
  isOnlineRef.current = isOnline;
  if (user?.uid || accountId) {
    lastSessionRef.current = {
      uid: user?.uid ?? lastSessionRef.current.uid,
      accountId: accountId ?? lastSessionRef.current.accountId,
    };
  }
  if (branchId) {
    visitedBranchesRef.current.add(branchId);
  }

  const persistPinRecord = useCallback(async (record: StoredPinRecord) => {
    const serialized = serializeStoredPinRecord(record);
    storedPinRawRef.current = serialized;
    setPinLength(record.pinLength);
    setHasConfiguredPin(true);

    try {
      const isSecureAvailable = await SecureStore.isAvailableAsync();
      if (isSecureAvailable) {
        await SecureStore.setItemAsync(SECURE_PIN_KEY, serialized);
        await AsyncStorage.removeItem(SECURE_PIN_KEY).catch(() => {});
        return;
      }
    } catch {
      // Fallback to AsyncStorage below
    }
    await AsyncStorage.setItem(SECURE_PIN_KEY, serialized).catch(() => {});
  }, []);

  const clearSessionCaches = useCallback(
    async (uidToClear?: string | null, accountToClear?: string | null) => {
      const branchesToClear = new Set<string>(visitedBranchesRef.current);
      branchesToClear.add('main');

      const cartKeysToRemove: string[] = [];
      const catalogKeysToRemove: string[] = [];

      for (const bId of branchesToClear) {
        const scopedCart = cartStorageKeys(accountToClear || '', bId, uidToClear || '');
        cartKeysToRemove.push(scopedCart.cart, scopedCart.paused);
        const emptyCart = cartStorageKeys('', bId, '');
        cartKeysToRemove.push(emptyCart.cart, emptyCart.paused);

        if (uidToClear && accountToClear) {
          const catalogBaseKey = productCatalogCacheKey(uidToClear, accountToClear, bId);
          const manifestKey = `${catalogBaseKey}:manifest`;
          catalogKeysToRemove.push(manifestKey);
          try {
            const rawManifest = await catalogKVStorage.getItem(manifestKey);
            if (rawManifest) {
              const parsed = JSON.parse(rawManifest) as { generation?: string; chunks?: number };
              if (typeof parsed.generation === 'string' && Number.isInteger(parsed.chunks)) {
                for (let idx = 0; idx < (parsed.chunks || 0); idx += 1) {
                  catalogKeysToRemove.push(`${catalogBaseKey}:data:${parsed.generation}:${idx}`);
                }
              }
            }
          } catch {
            // Ignore malformed cache manifest during logout purge
          }
        }
      }

      const asyncKeysToRemove = new Set<string>([
        STORAGE_ACCOUNT_ID_KEY,
        STORAGE_BRANCH_ID_KEY,
        '@ventify_pos_cart',
      ]);
      if (uidToClear && accountToClear) {
        asyncKeysToRemove.add(`${PLAN_CACHE_PREFIX}${uidToClear}:${accountToClear}`);
      }

      try {
        if (typeof AsyncStorage.getAllKeys === 'function') {
          const allKeys = await AsyncStorage.getAllKeys();
          for (const key of allKeys) {
            if (
              key.startsWith(PLAN_CACHE_PREFIX) ||
              key.startsWith('@ventify_cart:') ||
              key.startsWith('@ventify_paused:') ||
              key.startsWith('@ventify_product_catalog:')
            ) {
              asyncKeysToRemove.add(key);
            }
          }
        }
      } catch {
        // Ignore key enumeration failure
      }

      await Promise.all([
        AsyncStorage.multiRemove(Array.from(asyncKeysToRemove)).catch(() => {}),
        cartKeysToRemove.length > 0
          ? cartKVStorage.multiRemove(Array.from(new Set(cartKeysToRemove))).catch(() => {})
          : Promise.resolve(),
        catalogKeysToRemove.length > 0
          ? catalogKVStorage.multiRemove(Array.from(new Set(catalogKeysToRemove))).catch(() => {})
          : Promise.resolve(),
      ]);

      visitedBranchesRef.current = new Set(['main']);
    },
    []
  );

  // 0. Monitoreo temprano de red (activo incluso antes del login)
  useEffect(() => {
    let isMounted = true;

    NetInfo.fetch()
      .then((state) => {
        if (!isMounted) return;
        const online = Boolean(state.isConnected && state.isInternetReachable !== false);
        wasOfflineRef.current = !online;
        setIsOnline(online);
      })
      .catch(() => {});

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (!isMounted) return;
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setIsOnline(online);
    });

    return () => {
      isMounted = false;
      unsubscribeNet();
    };
  }, []);

  // 1. Inicializar almacenamiento persistente local (PIN cifrado/hasheado e intentos)
  useEffect(() => {
    let isMounted = true;

    async function loadStoredAuthMeta() {
      try {
        let savedPinRaw: string | null = null;
        try {
          const isSecureAvailable = await SecureStore.isAvailableAsync();
          if (isSecureAvailable) {
            savedPinRaw = await SecureStore.getItemAsync(SECURE_PIN_KEY);
          }
        } catch {
          // Fallback a AsyncStorage
        }

        if (!savedPinRaw) {
          savedPinRaw = await AsyncStorage.getItem(SECURE_PIN_KEY);
        }

        const parsedPin = parseStoredPin(savedPinRaw);
        if (parsedPin && savedPinRaw && isMounted) {
          storedPinRawRef.current = savedPinRaw;
          setPinLength(parsedPin.pinLength);
          setHasConfiguredPin(true);
        }

        const rawAttempts = await AsyncStorage.getItem(STORAGE_PIN_ATTEMPTS_KEY).catch(() => null);
        if (rawAttempts && isMounted) {
          try {
            const parsedAttempts = JSON.parse(rawAttempts) as Partial<PinAttemptState>;
            const lockoutUntil =
              typeof parsedAttempts.lockoutUntil === 'number' && parsedAttempts.lockoutUntil > Date.now()
                ? parsedAttempts.lockoutUntil
                : null;
            const failedAttempts = lockoutUntil
              ? Number(parsedAttempts.failedAttempts) || 0
              : 0;
            const restored: PinAttemptState = { failedAttempts, lockoutUntil };
            pinAttemptStateRef.current = restored;
            setPinAttemptState(restored);
          } catch {
            // Ignore malformed attempt state
          }
        }
      } catch (err) {
        console.warn('[AuthContext] Error loading initial storage:', err);
      }
    }

    void loadStoredAuthMeta();
    return () => {
      isMounted = false;
    };
  }, []);

  const resolveProfileOnce = useMemo(createProfileResolutionGate, []);

  // 2. Resolver accountId, role, branchId y permisos del usuario autenticado
  const resolveUserProfile = useCallback(
    (firebaseUser: User) =>
      resolveProfileOnce(firebaseUser.uid, async () => {
        try {
          let resolvedAccountId: string | null = null;
          let resolvedRole: UserRole = 'cashier';
          let resolvedBranchId: string | undefined = undefined;
          let resolvedAllBranches = false;
          let resolvedCustomPermissions: CustomUserPermissions | null = null;

          const [claimsResult, profileResult] = await loadIdentitySources(
            () => firebaseUser.getIdTokenResult(false),
            () => getDoc(doc(db, 'users', firebaseUser.uid))
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

          // 4. Si el usuario no tiene branchId fijo en su perfil, resolver la sucursal principal
          if (resolvedAccountId && (!resolvedBranchId || resolvedBranchId === 'main')) {
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

          resolvedAllBranches = hasAllBranchesAccess({
            role: resolvedRole,
            branchId: resolvedBranchId,
            allBranchesAccess: resolvedAllBranches,
          });

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
            visitedBranchesRef.current.add(resolvedBranchId);
            await AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, resolvedBranchId).catch(() => {});
          }

          return resolvedAccountId;
        } catch (generalErr) {
          console.error('[AuthContext] General error resolving user profile:', generalErr);
          return null;
        }
      }),
    [resolveProfileOnce]
  );

  // 3. Escuchar cambios de autenticación esperando authStateReady() para evitar race pre-hidratación
  useEffect(() => {
    let isMounted = true;
    let unsubUserDoc: (() => void) | null = null;
    let unsubscribeAuth: (() => void) | null = null;

    async function initAuthListener() {
      try {
        await (auth as { authStateReady?: () => Promise<void> }).authStateReady?.();
      } catch {
        // Ignore if auth mock or runtime doesn't implement authStateReady
      }
      if (!isMounted) return;

      unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
        if (!isMounted) return;
        if (unsubUserDoc) {
          unsubUserDoc();
          unsubUserDoc = null;
        }

        if (u && signupInProgressRef.current) {
          await signupInProgressRef.current.catch(() => {});
          if (!isMounted || auth.currentUser?.uid !== u.uid) return;
        }

        setUser(u);
        setUserProfile(null);
        setIsSuperAdmin(false);
        setAccountId(null);
        setBranchIdState('main');
        setRole('cashier');
        setAllBranchesAccess(false);
        setSubscription(null);
        setLimits(null);
        setAccessError(null);
        setAccessChecking(Boolean(u));
        setCustomPermissions(null);
        setIsActive(true);

        if (u) {
          setLoading(true);
          const resolvedAccount = await resolveUserProfile(u);
          if (!isMounted || auth.currentUser?.uid !== u.uid) return;
          if (!resolvedAccount) {
            setAccessChecking(false);
            setAccessError('No se pudo determinar la cuenta. Vuelve a iniciar sesión.');
          }
          setLoading(false);
          setInitialized(true);

          try {
            const userDocRef = doc(db, 'users', u.uid);
            let hasSeenExplicitAccount = false;
            unsubUserDoc = onSnapshot(
              userDocRef,
              (snap) => {
                if (!isMounted || auth.currentUser?.uid !== u.uid) return;
                if (snap.exists()) {
                  const data = snap.data();
                  const activeFlag = data.isActive !== false;
                  setIsActive(activeFlag);
                  const uRole = (data.role as UserRole) || 'cashier';
                  setRole(uRole);

                  const liveAccountId = liveProfileAccount(
                    data.accountId,
                    resolvedAccount,
                    hasSeenExplicitAccount
                  );
                  if (data.accountId) hasSeenExplicitAccount = true;
                  const accountChanged = identityRef.current !== `${u.uid}:${liveAccountId || ''}`;
                  if (accountChanged) {
                    setSubscription(null);
                    setLimits(null);
                    setAccessChecking(Boolean(liveAccountId) && activeFlag);
                  }
                  setAccountId(liveAccountId);
                  if (data.accountId) {
                    AsyncStorage.setItem(STORAGE_ACCOUNT_ID_KEY, data.accountId).catch(() => {});
                  }

                  if (data.branchId) {
                    visitedBranchesRef.current.add(data.branchId);
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
                } else {
                  setIsActive(false);
                  setCustomPermissions(null);
                }
              },
              (err) => {
                console.warn('[AuthContext] Realtime user doc subscription warning:', err);
              }
            );
          } catch {
            // ignore
          }
        } else {
          const prevSession = lastSessionRef.current;
          lastSessionRef.current = { uid: null, accountId: null };
          setUser(null);
          setUserProfile(null);
          setAccountId(null);
          setBranchIdState('main');
          setRole('cashier');
          setAllBranchesAccess(false);
          setCustomPermissions(null);
          setIsPinLocked(false);
          setIsPinSetupOpen(false);
          setIsSuperAdmin(false);
          setLimits(null);
          setSubscription(null);
          setAccessChecking(false);

          await clearSessionCaches(prevSession.uid, prevSession.accountId);

          if (isMounted) {
            setLoading(false);
            setInitialized(true);
          }
        }
      });
    }

    void initAuthListener();

    return () => {
      isMounted = false;
      if (unsubscribeAuth) unsubscribeAuth();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, [resolveUserProfile, clearSessionCaches]);

  // 4. Límites del plan y estado de suscripción con tolerancia offline de 72h
  const refreshAccess = useCallback(async () => {
    if (!user || !accountId || loading) return;
    if (!isActive) {
      setAccessChecking(false);
      setAccessError(null);
      return;
    }
    if (role === 'seller' || isSuperAdmin) {
      setLimits(null);
      setAccessChecking(false);
      setAccessError(null);
      return;
    }

    const scope = `${user.uid}:${accountId}`;
    const requestId = ++accessRequestRef.current;
    const isCurrent = () => identityRef.current === scope && accessRequestRef.current === requestId;
    const cacheKey = `${PLAN_CACHE_PREFIX}${scope}`;

    let cached: CachedPlanPayload | null = null;
    try {
      const raw = await AsyncStorage.getItem(cacheKey);
      const parsed = raw ? (JSON.parse(raw) as Partial<CachedPlanPayload>) : null;
      if (parsed && typeof parsed.cachedAt === 'number') {
        cached = {
          limits: parsed.limits ?? null,
          subscription: parsed.subscription ?? null,
          cachedAt: parsed.cachedAt,
        };
      }
    } catch {
      /* A malformed cache never grants access. */
    }

    const cacheAge = cached ? Date.now() - cached.cachedAt : Number.POSITIVE_INFINITY;
    if (cached && cacheAge >= 0 && cacheAge < PLAN_CACHE_ONLINE_TTL_MS && isCurrent()) {
      setSubscription(cached.subscription);
      setLimits(cached.limits ?? null);
      setAccessChecking(false);
    }

    const netState = await NetInfo.fetch().catch(() => null);
    const netOnline = netState
      ? Boolean(netState.isConnected && netState.isInternetReachable !== false)
      : isOnlineRef.current;
    if (isCurrent()) {
      setIsOnline(netOnline);
    }

    // Offline tolerance: allow previously authenticated accounts up to 72h offline
    if (!netOnline) {
      if (!isCurrent()) return;
      if (cached && cacheAge >= 0 && cacheAge < PLAN_CACHE_OFFLINE_TTL_MS) {
        setSubscription(cached.subscription);
        setLimits(cached.limits ?? null);
        setAccessError(null);
      } else {
        setAccessError('Sin conexión a internet. Conéctate para verificar el acceso de tu negocio.');
      }
      setAccessClock(Date.now());
      setAccessChecking(false);
      return;
    }

    try {
      const data = await apiRequest<{
        limits?: PlanLimits | null;
        subscription: PlanSubscription | null;
      }>(`/api/plan-limits/${encodeURIComponent(accountId)}`);
      if (!isCurrent()) return;
      const nextSub = data.subscription ?? null;
      const nextLimits = data.limits ?? null;
      setSubscription(nextSub);
      setLimits(nextLimits);
      setAccessError(null);
      await AsyncStorage.setItem(
        cacheKey,
        JSON.stringify({
          limits: nextLimits,
          subscription: nextSub,
          cachedAt: Date.now(),
        } satisfies CachedPlanPayload)
      ).catch(() => {});
    } catch (error) {
      if (!isCurrent()) return;
      const status = (error as { status?: number }).status;
      const latestNet = await NetInfo.fetch().catch(() => null);
      const stillOnline = latestNet
        ? Boolean(latestNet.isConnected && latestNet.isInternetReachable !== false)
        : isOnlineRef.current;
      const isTransient = !status || status === 408 || status >= 500;
      const maxCacheTtl = !stillOnline || !status ? PLAN_CACHE_OFFLINE_TTL_MS : PLAN_CACHE_ONLINE_TTL_MS;
      const mayUseCache = isTransient && cached && cacheAge >= 0 && cacheAge < maxCacheTtl;

      if (mayUseCache && cached) {
        setSubscription(cached.subscription);
        setLimits(cached.limits ?? null);
        setAccessError(null);
      } else {
        setAccessError(
          error instanceof Error ? error.message : 'No se pudo verificar el acceso del negocio.'
        );
      }
    } finally {
      if (isCurrent()) {
        setAccessClock(Date.now());
        setAccessChecking(false);
      }
    }
  }, [user?.uid, accountId, role, isSuperAdmin, isActive, loading]);

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

  // Al recuperar conectividad después de estar offline, re-validar el plan en segundo plano
  useEffect(() => {
    if (isOnline && wasOfflineRef.current && user && accountId && !loading) {
      void refreshAccess();
    }
    wasOfflineRef.current = !isOnline;
  }, [isOnline, user?.uid, accountId, loading, refreshAccess]);

  const accessBlocked = accessBlockReason({ isActive, isSuperAdmin }, subscription, accessClock);

  // 5. Cambiar sucursal activa (restringido a usuarios multisede)
  const setActiveBranchId = useCallback(
    (newBranchId: string) => {
      if (!newBranchId) return;
      const canChange = hasAllBranchesAccess({ role, branchId, allBranchesAccess });
      if (!canChange) {
        console.warn('[AuthContext] Usuario sin acceso multisede no puede cambiar de sucursal');
        return;
      }
      visitedBranchesRef.current.add(newBranchId);
      setBranchIdState(newBranchId);
      AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, newBranchId).catch(() => {});
    },
    [role, branchId, allBranchesAccess]
  );

  // Inicialización segura de sucursal asignada cuando el estado inicial sigue en 'main'
  const syncAssignedBranchId = useCallback(
    (assignedBranchId: string) => {
      if (!assignedBranchId || assignedBranchId === 'main') return;
      setBranchIdState((prev) => {
        if (prev !== 'main') return prev;
        const multiBranch = hasAllBranchesAccess({ role, branchId: prev, allBranchesAccess });
        if (!multiBranch && userProfile?.branchId !== assignedBranchId) {
          return prev;
        }
        visitedBranchesRef.current.add(assignedBranchId);
        AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, assignedBranchId).catch(() => {});
        return assignedBranchId;
      });
    },
    [role, allBranchesAccess, userProfile?.branchId]
  );

  // 6. Iniciar sesión con email y contraseña
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

  // 7. Registro completo de nueva cuenta (trial 14 días) en Firebase Auth + /api/auth/signup
  const signup = useCallback(
    async (email: string, password: string, businessName: string, ownerName: string) => {
      const cleanEmail = email.trim();
      const cleanOwner = ownerName.trim();
      const cleanBusiness = businessName.trim() || cleanOwner || 'Mi Negocio';

      let releaseSignupGate!: () => void;
      const gatePromise = new Promise<void>((resolve) => {
        releaseSignupGate = resolve;
      });
      signupInProgressRef.current = gatePromise;

      setLoading(true);
      let createdUser: User | null = null;
      try {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        createdUser = cred.user;
        const idToken = await cred.user.getIdToken();

        await apiRequest<{ success: boolean; userId: string; accountId: string; branchId: string }>(
          '/api/auth/signup',
          {
            method: 'POST',
            body: {
              idToken,
              businessName: cleanBusiness,
              ownerName: cleanOwner,
            },
          }
        );

        await cred.user.getIdToken(true).catch(() => {});
        releaseSignupGate();
        signupInProgressRef.current = null;
        await resolveUserProfile(cred.user);
      } catch (err) {
        releaseSignupGate();
        signupInProgressRef.current = null;
        if (createdUser) {
          const status = (err as { status?: number }).status;
          if (status === 400) {
            await createdUser.delete().catch(() => signOut(auth).catch(() => {}));
          } else {
            await signOut(auth).catch(() => {});
          }
        }
        throw err;
      } finally {
        if (signupInProgressRef.current === gatePromise) {
          releaseSignupGate();
          signupInProgressRef.current = null;
        }
        setLoading(false);
      }
    },
    [resolveUserProfile]
  );

  // 8. Recuperación de contraseña
  const sendPasswordReset = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  // 9. Cerrar sesión segura (limpia @ventify_plan:*, catalogKVStorage y cartKVStorage)
  const logout = useCallback(async () => {
    const uidToClear = user?.uid ?? lastSessionRef.current.uid;
    const accountToClear = accountId ?? lastSessionRef.current.accountId;
    setLoading(true);
    try {
      await signOut(auth);
      lastSessionRef.current = { uid: null, accountId: null };
      setUser(null);
      setUserProfile(null);
      setAccountId(null);
      setBranchIdState('main');
      setRole('cashier');
      setAllBranchesAccess(false);
      setCustomPermissions(null);
      setIsSuperAdmin(false);
      setLimits(null);
      setSubscription(null);
      setAccessError(null);
      setIsPinLocked(false);
      setIsPinSetupOpen(false);
      const resetAttempts = resetPinAttemptState();
      pinAttemptStateRef.current = resetAttempts;
      setPinAttemptState(resetAttempts);
      await AsyncStorage.removeItem(STORAGE_PIN_ATTEMPTS_KEY).catch(() => {});
      await clearSessionCaches(uidToClear, accountToClear);
    } finally {
      setLoading(false);
    }
  }, [user?.uid, accountId, clearSessionCaches]);

  // 10. Bloqueo rápido de terminal por PIN
  const lockTerminal = useCallback(() => {
    if (!storedPinRawRef.current) {
      setIsPinSetupOpen(true);
      return;
    }
    setIsPinSetupOpen(false);
    setIsPinLocked(true);
  }, []);

  const closePinSetup = useCallback(() => {
    setIsPinSetupOpen(false);
  }, []);

  // 11. Desbloqueo mediante PIN con hash con sal, actualización automática de legacy y cooldown
  const unlockWithPin = useCallback(
    (enteredPin: string): boolean => {
      const now = Date.now();
      if (isPinLockedOut(pinAttemptStateRef.current, now)) {
        return false;
      }

      const result = verifyStoredPin(enteredPin, storedPinRawRef.current, now);
      if (result.valid) {
        const cleared = resetPinAttemptState();
        pinAttemptStateRef.current = cleared;
        setPinAttemptState(cleared);
        void AsyncStorage.removeItem(STORAGE_PIN_ATTEMPTS_KEY).catch(() => {});

        if (result.upgradedRecord) {
          void persistPinRecord(result.upgradedRecord);
        }
        setIsPinLocked(false);
        return true;
      }

      const nextAttempts = registerFailedPinAttempt(pinAttemptStateRef.current, now);
      pinAttemptStateRef.current = nextAttempts;
      setPinAttemptState(nextAttempts);
      void AsyncStorage.setItem(STORAGE_PIN_ATTEMPTS_KEY, JSON.stringify(nextAttempts)).catch(
        () => {}
      );
      return false;
    },
    [persistPinRecord]
  );

  // 12. Actualizar código PIN (4 a 8 dígitos) con hash salado y persistencia segura
  const updatePinCode = useCallback(
    async (newPin: string) => {
      const record = createStoredPinRecord(newPin);
      await persistPinRecord(record);
      const cleared = resetPinAttemptState();
      pinAttemptStateRef.current = cleared;
      setPinAttemptState(cleared);
      await AsyncStorage.removeItem(STORAGE_PIN_ATTEMPTS_KEY).catch(() => {});
    },
    [persistPinRecord]
  );

  const contextValue = useMemo<AuthContextType>(
    () => ({
      user,
      userProfile,
      accountId,
      branchId,
      role,
      allBranchesAccess,
      customPermissions,
      isActive,
      isSuperAdmin,
      limits,
      subscription,
      isOnline,
      accessChecking,
      accessError,
      accessBlocked,
      refreshAccess,
      initialized,
      loading,
      isPinLocked,
      pinCode: '',
      pinLength,
      hasConfiguredPin,
      isPinSetupOpen,
      closePinSetup,
      pinFailedAttempts: pinAttemptState.failedAttempts,
      pinLockoutUntil: pinAttemptState.lockoutUntil,
      login,
      signup,
      sendPasswordReset,
      logout,
      setActiveBranchId,
      setBranchId: setActiveBranchId,
      syncAssignedBranchId,
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
      isSuperAdmin,
      limits,
      subscription,
      isOnline,
      accessChecking,
      accessError,
      accessBlocked,
      refreshAccess,
      initialized,
      loading,
      isPinLocked,
      pinLength,
      hasConfiguredPin,
      isPinSetupOpen,
      closePinSetup,
      pinAttemptState.failedAttempts,
      pinAttemptState.lockoutUntil,
      login,
      signup,
      sendPasswordReset,
      logout,
      setActiveBranchId,
      syncAssignedBranchId,
      lockTerminal,
      unlockWithPin,
      updatePinCode,
    ]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
