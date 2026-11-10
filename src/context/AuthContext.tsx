import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
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
import { auth, db } from '@/lib/firebase';
import { UserProfile } from '@/types';

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

        // Cargar accountId y branchId cacheados
        const [savedAccId, savedBId] = await Promise.all([
          AsyncStorage.getItem(STORAGE_ACCOUNT_ID_KEY),
          AsyncStorage.getItem(STORAGE_BRANCH_ID_KEY),
        ]);

        if (isMounted) {
          if (savedAccId) setAccountId(savedAccId);
          if (savedBId) setBranchIdState(savedBId);
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

  // 2. Resolver accountId, role, branchId y permisos del usuario autenticado
  const resolveUserProfile = useCallback(async (firebaseUser: User) => {
    try {
      let resolvedAccountId: string | null = null;
      let resolvedRole: UserRole = 'cashier';
      let resolvedBranchId: string | undefined = undefined;
      let resolvedAllBranches = false;
      let resolvedCustomPermissions: CustomUserPermissions | null = null;

      // 1. Verificar custom claims del JWT
      try {
        const tokenResult = await firebaseUser.getIdTokenResult(true);
        const claims = tokenResult.claims;

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
        const userRef = doc(db, 'users', firebaseUser.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const uData = userSnap.data();
          if (!resolvedAccountId && uData.accountId) {
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
          if (uData.customPermissions) {
            resolvedCustomPermissions = uData.customPermissions;
          }

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
        try {
          const branchSnap = await getDocs(
            query(collection(db, 'branches'), where('accountId', '==', resolvedAccountId), limit(10))
          );
          if (!branchSnap.empty) {
            const principalDoc =
              branchSnap.docs.find((d) =>
                String(d.data().name || '')
                  .toUpperCase()
                  .includes('PRINCIPAL')
              ) || branchSnap.docs[0];
            resolvedBranchId = principalDoc.id;
          }
        } catch (branchErr) {
          console.warn('[AuthContext] Error resolving default branch:', branchErr);
        }
      }

      // Propietarios y administradores tienen acceso global a todas las sucursales por defecto
      if (resolvedRole === 'owner' || resolvedRole === 'admin') {
        resolvedAllBranches = true;
      }

      // Actualizar estado reactivo
      if (resolvedAccountId) {
        setAccountId(resolvedAccountId);
        await AsyncStorage.setItem(STORAGE_ACCOUNT_ID_KEY, resolvedAccountId).catch(() => {});
      }

      setRole(resolvedRole);
      setAllBranchesAccess(resolvedAllBranches);
      if (resolvedCustomPermissions) {
        setCustomPermissions(resolvedCustomPermissions);
      }

      if (resolvedBranchId && resolvedBranchId !== 'main') {
        setBranchIdState(resolvedBranchId);
        await AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, resolvedBranchId).catch(() => {});
      }

      return resolvedAccountId;
    } catch (generalErr) {
      console.error('[AuthContext] General error resolving user profile:', generalErr);
      return null;
    }
  }, []);

  // 3. Escuchar cambios de autenticación en Firebase
  useEffect(() => {
    let unsubUserDoc: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);

      if (u) {
        setLoading(true);
        await resolveUserProfile(u);
        // Desbloquear UI inmediatamente tras resolver perfil y claims
        setLoading(false);
        setInitialized(true);

        // Suscribirse en tiempo real al documento del usuario para reflejar cambios de rol o sede
        try {
          const userDocRef = doc(db, 'users', u.uid);
          unsubUserDoc = onSnapshot(
            userDocRef,
            (snap) => {
              if (snap.exists()) {
                const data = snap.data();
                const uRole = (data.role as UserRole) || 'cashier';
                setRole(uRole);

                if (data.accountId) {
                  setAccountId(data.accountId);
                  AsyncStorage.setItem(STORAGE_ACCOUNT_ID_KEY, data.accountId).catch(() => {});
                }

                if (data.branchId) {
                  setBranchIdState(data.branchId);
                  AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, data.branchId).catch(() => {});
                }

                if (data.allBranchesAccess !== undefined) {
                  setAllBranchesAccess(Boolean(data.allBranchesAccess));
                } else if (uRole === 'owner' || uRole === 'admin') {
                  setAllBranchesAccess(true);
                }

                if (data.customPermissions) {
                  setCustomPermissions(data.customPermissions);
                }

                setUserProfile({
                  uid: u.uid,
                  email: u.email,
                  displayName: data.displayName || data.name || u.displayName,
                  photoURL: data.photoURL || u.photoURL,
                  emailVerified: u.emailVerified,
                  role: uRole,
                  accountId: data.accountId,
                  branchId: data.branchId,
                  createdAt: data.createdAt,
                });
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
        // Cierre de sesión o usuario no autenticado
        setUser(null);
        setUserProfile(null);
        setAccountId(null);
        setBranchIdState('main');
        setRole('cashier');
        setAllBranchesAccess(false);
        setCustomPermissions(null);
        setIsPinLocked(false);

        await AsyncStorage.multiRemove([
          STORAGE_ACCOUNT_ID_KEY,
          STORAGE_BRANCH_ID_KEY,
          '@ventify_pos_cart',
        ]).catch(() => {});

        if (unsubUserDoc) unsubUserDoc();
        setLoading(false);
        setInitialized(true);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, [resolveUserProfile]);

  // 4. Cambiar sucursal activa
  const setActiveBranchId = useCallback((newBranchId: string) => {
    if (!newBranchId) return;
    setBranchIdState(newBranchId);
    AsyncStorage.setItem(STORAGE_BRANCH_ID_KEY, newBranchId).catch(() => {});
  }, []);

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
