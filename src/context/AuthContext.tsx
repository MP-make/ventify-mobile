import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  User,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, collection, query, where, getDocs, limit } from 'firebase/firestore';
import { auth, db } from '../firebase';

export interface UserDocData {
  id?: string;
  role?: string;
  branchId?: string;
  accountId?: string;
  displayName?: string;
  email?: string;
  [key: string]: any;
}

interface AuthContextType {
  user: User | null;
  userDoc: UserDocData | null;
  accountId: string | null;
  branchId: string;
  initialized: boolean;
  loading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  setBranchId: (bId: string) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userDoc: null,
  accountId: null,
  branchId: 'main',
  initialized: false,
  loading: true,
  login: async () => {},
  loginWithGoogle: async () => {},
  logout: async () => {},
  setBranchId: () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userDoc, setUserDoc] = useState<UserDocData | null>(null);
  const [accountId, setAccountId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('ventify_mobile_account_id');
    } catch {
      return null;
    }
  });
  const [branchId, setBranchIdState] = useState<string>(() => {
    try {
      return localStorage.getItem('ventify_mobile_branch_id') || 'main';
    } catch {
      return 'main';
    }
  });
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(true);

  const setBranchId = (newBranchId: string) => {
    setBranchIdState(newBranchId);
    try {
      localStorage.setItem('ventify_mobile_branch_id', newBranchId);
    } catch {}
  };

  const resolveAccountId = useCallback(async (u: User) => {
    try {
      // 1. Check custom claims
      const token = await u.getIdTokenResult(true);
      const claimAccountId = token.claims.accountId as string | undefined;
      if (claimAccountId) {
        setAccountId(claimAccountId);
        try {
          localStorage.setItem('ventify_mobile_account_id', claimAccountId);
        } catch {}
        return claimAccountId;
      }

      // 2. Check user profile document in Firestore
      const userRef = doc(db, 'users', u.uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const data = userSnap.data();
        if (data.accountId) {
          setAccountId(data.accountId);
          try {
            localStorage.setItem('ventify_mobile_account_id', data.accountId);
          } catch {}
          return data.accountId;
        }
      }

      // 3. Fallback: Query accounts where ownerId == u.uid
      const accQuery = query(collection(db, 'accounts'), where('ownerId', '==', u.uid), limit(1));
      const accSnap = await getDocs(accQuery);
      if (!accSnap.empty) {
        const foundId = accSnap.docs[0].id;
        setAccountId(foundId);
        try {
          localStorage.setItem('ventify_mobile_account_id', foundId);
        } catch {}
        return foundId;
      }
    } catch (err) {
      console.warn('[AuthContext] Error resolving accountId:', err);
    }
    return null;
  }, []);

  useEffect(() => {
    let unsubUserDoc: (() => void) | null = null;

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        setLoading(true);
        await resolveAccountId(u);

        // Subscribe to user doc
        const userRef = doc(db, 'users', u.uid);
        unsubUserDoc = onSnapshot(userRef, (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            setUserDoc({ id: snap.id, ...data });
            if (data.accountId) {
              setAccountId(data.accountId);
              try {
                localStorage.setItem('ventify_mobile_account_id', data.accountId);
              } catch {}
            }
            if (data.branchId) {
              setBranchIdState(data.branchId);
              try {
                localStorage.setItem('ventify_mobile_branch_id', data.branchId);
              } catch {}
            }
          }
          setLoading(false);
          setInitialized(true);
        }, (err) => {
          console.warn('[AuthContext] userDoc error:', err);
          setLoading(false);
          setInitialized(true);
        });
      } else {
        setUserDoc(null);
        setAccountId(null);
        try {
          localStorage.removeItem('ventify_mobile_account_id');
        } catch {}
        if (unsubUserDoc) unsubUserDoc();
        setLoading(false);
        setInitialized(true);
      }
    });

    return () => {
      unsubscribe();
      if (unsubUserDoc) unsubUserDoc();
    };
  }, [resolveAccountId]);

  const login = async (email: string, pass: string) => {
    setLoading(true);
    const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);
    await resolveAccountId(cred.user);
  };

  const loginWithGoogle = async () => {
    setLoading(true);
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    await resolveAccountId(cred.user);
  };

  const logout = async () => {
    await signOut(auth);
    setUser(null);
    setUserDoc(null);
    setAccountId(null);
    try {
      localStorage.removeItem('ventify_mobile_account_id');
      localStorage.removeItem('ventify_mobile_cart');
    } catch {}
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        userDoc,
        accountId,
        branchId,
        initialized,
        loading,
        login,
        loginWithGoogle,
        logout,
        setBranchId,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
