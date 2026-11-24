import {
  areCachedProfilesEqual,
  createProfileResolutionGate,
  evaluateCachedPlanAccess,
  loadIdentitySources,
  parseCachedPlan,
  parseCachedUserProfile,
  resolveOptimisticBranchId,
  shouldRecheckAccessOnForeground,
  type CachedUserProfileRecord,
} from '@/lib/auth-startup';
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
  shouldDeactivateUserOnMissingDoc,
  type SubscriptionAccess,
} from '@/lib/access-policy';
import { auth, db } from '@/lib/firebase';
import { clearRequestCache } from '@/lib/request-cache';
import { UserProfile } from '@/types';
import { canAccessBranch, hasAllBranchesAccess } from '@/lib/branch-access';
import {
  effectivePermissions,
  normalizeRole,
  type CustomPermissions,
  type Permission,
  type Role,
} from '@/lib/role-permissions';
import { cartStorageKeys } from '@/lib/cart-scope';
import { cartKVStorage, catalogKVStorage, metaKVStorage } from '@/lib/native-kv-storage';
import {
  productCatalogCacheKey,
  productCatalogDeltaKey,
} from '@/lib/product-catalog-cache';
import { offlineSyncService } from '@/services/offline-sync-service';
import { offlineInventoryService } from '@/services/offline-inventory-service';
import { offlineCashService } from '@/services/offline-cash-service';
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

export interface AuthSessionContextType {
  user: User | null;
  userProfile: UserProfile | null;
  accountId: string | null;
  branchId: string;
  role: UserRole;
  allBranchesAccess: boolean;
  customPermissions: CustomUserPermissions | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  initialized: boolean;
  loading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  signup: (email: string, password: string, businessName: string, ownerName: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  setActiveBranchId: (newBranchId: string) => void;
  setBranchId: (newBranchId: string) => void;
  syncAssignedBranchId: (assignedBranchId: string) => void;
}

export interface NetworkStatusContextType {
  isOnline: boolean;
}

export interface PlanAccessContextType {
  limits: PlanLimits | null;
  subscription: PlanSubscription | null;
  accessChecking: boolean;
  accessError: string | null;
  accessBlocked: string | null;
  refreshAccess: () => Promise<void>;
}

export interface PlanAccessActionsContextType {
  refreshAccess: () => Promise<void>;
  getPlanLimitsSnapshot: () => PlanLimits | null;
}

export interface PinLockContextType {
  isPinLocked: boolean;
  pinCode: string;
  pinLength: number;
  hasConfiguredPin: boolean;
  isPinSetupOpen: boolean;
  closePinSetup: () => void;
  pinFailedAttempts: number;
  pinLockoutUntil: number | null;
  lockTerminal: () => void;
  unlockWithPin: (enteredPin: string) => boolean;
  updatePinCode: (newPin: string) => Promise<void>;
}

export interface AuthContextType
  extends AuthSessionContextType,
    NetworkStatusContextType,
    PlanAccessContextType,
    PinLockContextType {}

export interface TransferScopeTarget {
  sourceBranchId: string;
  destinationBranchId: string;
}

export interface TransferStatusTarget extends TransferScopeTarget {
  status: string;
}

export interface UsePermissionsResult {
  role: Role;
  userRole: Role;
  userBranchId: string;
  permissions: Permission[];
  getEffectivePermissions: () => Permission[];
  getUserRole: () => Role;
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (permissions: Permission[]) => boolean;
  hasAllPermissions: (permissions: Permission[]) => boolean;
  canManageProducts: boolean;
  canManageUsers: boolean;
  canViewReports: boolean;
  canAccessDashboard: boolean;
  canViewMargins: boolean;
  canViewInventoryValue: boolean;
  canModifyPrice: boolean;
  canApplyDiscount: boolean;
  canManageDiscounts: boolean;
  canProcessReturn: boolean;
  canCreateCreditNotes: boolean;
  canManageInventoryAdjustments: boolean;
  canRequestTransfer: boolean;
  canApproveTransfer: boolean;
  canManageTransfers: boolean;
  canManageCashRegister: boolean;
  canManageCustomers: boolean;
  canManageSettings: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isCashier: boolean;
  isSeller: boolean;
  hasMultiBranchAccess: boolean;
  canViewAllCashSessions: boolean;
  canViewBranchCashSessions: boolean;
  canCreateDirectTransfer: boolean;
  canViewOwnCashSession: boolean;
  canRequestTransferFromBranch: (targetBranchId: string) => boolean;
  canApproveTransferToBranch: (targetBranchId: string) => boolean;
  canViewTransfer: (transfer: TransferScopeTarget) => boolean;
  canUpdateTransferStatus: (transfer: TransferStatusTarget, newStatus: string) => boolean;
  isSuperAdmin: boolean;
  hasAllBranchesAccess: boolean;
  allBranchesAccess: boolean;
  canAccessBranch: (targetBranchId?: string | null) => boolean;
}

const STORAGE_ACCOUNT_ID_KEY = '@ventify_mobile_account_id';
const STORAGE_BRANCH_ID_KEY = '@ventify_mobile_branch_id';
const STORAGE_PIN_ATTEMPTS_KEY = '@ventify_terminal_pin_attempts';
const SECURE_PIN_KEY = '@ventify_terminal_pin';
const PLAN_CACHE_PREFIX = '@ventify_plan:';
const USER_PROFILE_CACHE_PREFIX = '@ventify_user_profile_v1:';
const SETTINGS_CACHE_PREFIX = '@ventify_settings_cache_v1:';
const CASH_SESSION_CACHE_PREFIX = '@ventify_cash_session_cache_v1:';
const PIN_ATTEMPTS_MIGRATED_KEY = '@ventify_kv_pin_attempts_migrated_v1';
const PIN_FALLBACK_MIGRATED_KEY = '@ventify_kv_pin_fallback_migrated_v1';

interface CachedPlanPayload {
  limits?: PlanLimits | null;
  subscription: PlanSubscription | null;
  cachedAt: number;
}

type CachedUserProfile = CachedUserProfileRecord;

function readMetaItemSync(key: string): string | null {
  if (!metaKVStorage.isSyncCapable) return null;
  try {
    return metaKVStorage.getItemSync(key);
  } catch {
    return null;
  }
}

async function readMetaItem(
  key: string,
  options?: { migrationSentinel?: string }
): Promise<string | null> {
  if (metaKVStorage.isSyncCapable) {
    try {
      const syncValue = metaKVStorage.getItemSync(key);
      if (syncValue !== null) return syncValue;
      if (options?.migrationSentinel && metaKVStorage.getItemSync(options.migrationSentinel) === '1') {
        return null;
      }
    } catch {
      // Continue to fallback below
    }

    try {
      const legacyValue = await AsyncStorage.getItem(key);
      if (legacyValue !== null) {
        metaKVStorage.setItemSync(key, legacyValue);
        void AsyncStorage.removeItem(key).catch(() => {});
      }
      if (options?.migrationSentinel) {
        metaKVStorage.setItemSync(options.migrationSentinel, '1');
      }
      return legacyValue ?? null;
    } catch {
      return null;
    }
  }

  try {
    return (await metaKVStorage.getItem(key)) ?? null;
  } catch {
    return null;
  }
}

async function writeMetaItem(key: string, value: string): Promise<void> {
  try {
    if (metaKVStorage.isSyncCapable) {
      metaKVStorage.setItemSync(key, value);
      return;
    }
    await metaKVStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors so auth flow never fails
  }
}

function writeMetaItemSyncOrAsync(key: string, value: string): void {
  try {
    if (metaKVStorage.isSyncCapable) {
      metaKVStorage.setItemSync(key, value);
      return;
    }
    void metaKVStorage.setItem(key, value).catch(() => {});
  } catch {
    // Ignore storage write errors
  }
}

async function removeMetaItem(key: string): Promise<void> {
  try {
    if (metaKVStorage.isSyncCapable) {
      metaKVStorage.removeItemSync(key);
      return;
    }
    await metaKVStorage.removeItem(key);
  } catch {
    // Ignore storage delete errors
  }
}

function removeMetaItemSyncOrAsync(key: string): void {
  try {
    if (metaKVStorage.isSyncCapable) {
      metaKVStorage.removeItemSync(key);
      return;
    }
    void metaKVStorage.removeItem(key).catch(() => {});
  } catch {
    // Ignore storage delete errors
  }
}

function readCachedUserProfileSync(uid: string): CachedUserProfile | null {
  if (!uid) return null;
  return parseCachedUserProfile(readMetaItemSync(`${USER_PROFILE_CACHE_PREFIX}${uid}`));
}

async function readCachedUserProfile(uid: string): Promise<CachedUserProfile | null> {
  if (!uid) return null;
  const raw = await readMetaItem(`${USER_PROFILE_CACHE_PREFIX}${uid}`);
  return parseCachedUserProfile(raw);
}

async function writeCachedUserProfile(
  uid: string,
  payload: Omit<CachedUserProfile, 'cachedAt'> & { cachedAt?: number }
): Promise<void> {
  if (!uid) return;
  try {
    const record: CachedUserProfile = {
      accountId: payload.accountId ?? null,
      branchId: payload.branchId ?? undefined,
      profileBranchId: payload.profileBranchId,
      hasExplicitAccountId: payload.hasExplicitAccountId,
      role: payload.role,
      allBranchesAccess: Boolean(payload.allBranchesAccess),
      customPermissions: payload.customPermissions ?? null,
      isActive: payload.isActive !== false,
      isSuperAdmin: Boolean(payload.isSuperAdmin),
      displayName: payload.displayName ?? null,
      photoURL: payload.photoURL ?? null,
      email: payload.email ?? null,
      cachedAt: typeof payload.cachedAt === 'number' ? payload.cachedAt : Date.now(),
    };
    await writeMetaItem(`${USER_PROFILE_CACHE_PREFIX}${uid}`, JSON.stringify(record));
  } catch {
    // Ignore storage write errors so auth flow never fails
  }
}

function sameJsonValue<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

const DEFAULT_AUTH_SESSION: AuthSessionContextType = {
  user: null,
  userProfile: null,
  accountId: null,
  branchId: 'main',
  role: 'cashier',
  allBranchesAccess: false,
  customPermissions: null,
  isActive: true,
  isSuperAdmin: false,
  initialized: false,
  loading: true,
  login: async () => {},
  signup: async () => {},
  sendPasswordReset: async () => {},
  logout: async () => {},
  setActiveBranchId: () => {},
  setBranchId: () => {},
  syncAssignedBranchId: () => {},
};

const DEFAULT_NETWORK_STATUS: NetworkStatusContextType = {
  isOnline: true,
};

const DEFAULT_PLAN_ACCESS: PlanAccessContextType = {
  limits: null,
  subscription: null,
  accessChecking: true,
  accessError: null,
  accessBlocked: null,
  refreshAccess: async () => {},
};

const DEFAULT_PLAN_ACCESS_ACTIONS: PlanAccessActionsContextType = {
  refreshAccess: async () => {},
  getPlanLimitsSnapshot: () => null,
};

const DEFAULT_PIN_LOCK: PinLockContextType = {
  isPinLocked: false,
  pinCode: '',
  pinLength: PIN_MIN_LENGTH,
  hasConfiguredPin: false,
  isPinSetupOpen: false,
  closePinSetup: () => {},
  pinFailedAttempts: 0,
  pinLockoutUntil: null,
  lockTerminal: () => {},
  unlockWithPin: () => false,
  updatePinCode: async () => {},
};

const AuthSessionContext = createContext<AuthSessionContextType>(DEFAULT_AUTH_SESSION);
const NetworkStatusContext = createContext<NetworkStatusContextType>(DEFAULT_NETWORK_STATUS);
const PlanAccessContext = createContext<PlanAccessContextType>(DEFAULT_PLAN_ACCESS);
const PlanAccessActionsContext = createContext<PlanAccessActionsContextType>(
  DEFAULT_PLAN_ACCESS_ACTIONS
);
const PinLockContext = createContext<PinLockContextType>(DEFAULT_PIN_LOCK);
const AuthContext = createContext<AuthContextType>({
  ...DEFAULT_AUTH_SESSION,
  ...DEFAULT_NETWORK_STATUS,
  ...DEFAULT_PLAN_ACCESS,
  ...DEFAULT_PIN_LOCK,
});

export const PermissionsContext = createContext<UsePermissionsResult | null>(null);

export function useComputedPermissions(params: {
  role: UserRole | string;
  customPermissions: CustomUserPermissions | null | undefined;
  branchId: string;
  allBranchesAccess: boolean;
  isSuperAdmin: boolean;
}): UsePermissionsResult {
  const { role, customPermissions, branchId, allBranchesAccess, isSuperAdmin } = params;

  const canonicalRole: Role = useMemo(() => normalizeRole(role), [role]);
  const typedCustomPermissions = customPermissions as CustomPermissions | null | undefined;

  const userPermissions = useMemo<Permission[]>(
    () => effectivePermissions(canonicalRole, typedCustomPermissions),
    [canonicalRole, typedCustomPermissions]
  );

  const permissionSet = useMemo(() => new Set<Permission>(userPermissions), [userPermissions]);

  const getEffectivePermissions = useCallback((): Permission[] => userPermissions, [userPermissions]);

  const hasPermission = useCallback(
    (permission: Permission): boolean => permissionSet.has(permission),
    [permissionSet]
  );

  const hasAnyPermission = useCallback(
    (permissions: Permission[]): boolean => permissions.some((p) => permissionSet.has(p)),
    [permissionSet]
  );

  const hasAllPermissions = useCallback(
    (permissions: Permission[]): boolean => permissions.every((p) => permissionSet.has(p)),
    [permissionSet]
  );

  const derived = useMemo(() => {
    const canManageProducts = permissionSet.has('manage_products');
    const canManageUsers = permissionSet.has('manage_users');
    const canViewReports = permissionSet.has('view_reports');
    const canAccessDashboard = permissionSet.has('access_dashboard');
    const canViewMargins = permissionSet.has('view_margins');
    const canViewInventoryValue = permissionSet.has('view_inventory_value');
    const canModifyPrice = permissionSet.has('modify_price');
    const canApplyDiscount = canModifyPrice;
    const canManageDiscounts = permissionSet.has('manage_discounts');
    const canProcessReturn = permissionSet.has('process_return');
    const canCreateCreditNotes = permissionSet.has('create_credit_notes');
    const canManageInventoryAdjustments = permissionSet.has('manage_inventory_adjustments');
    const canRequestTransfer = permissionSet.has('request_transfer');
    const canApproveTransfer = permissionSet.has('approve_transfer');
    const canManageTransfers = permissionSet.has('manage_transfers');
    const canManageCashRegister = permissionSet.has('manage_cash_register');
    const canManageCustomers = permissionSet.has('manage_customers');
    const canManageSettings = permissionSet.has('manage_settings');

    const isOwner = canonicalRole === 'owner';
    const isAdmin = canonicalRole === 'admin';
    const isManager = canonicalRole === 'manager';
    const isCashier = canonicalRole === 'cashier';
    const isSeller = canonicalRole === 'seller';

    const hasMultiBranchAccess = hasAllBranchesAccess({
      role: canonicalRole,
      allBranchesAccess,
    });
    const canViewAllCashSessions = isOwner || isAdmin;
    const canViewBranchCashSessions = isOwner || isAdmin || isManager || canManageCashRegister;
    const canCreateDirectTransfer = isOwner || isAdmin;

    return {
      canManageProducts,
      canManageUsers,
      canViewReports,
      canAccessDashboard,
      canViewMargins,
      canViewInventoryValue,
      canModifyPrice,
      canApplyDiscount,
      canManageDiscounts,
      canProcessReturn,
      canCreateCreditNotes,
      canManageInventoryAdjustments,
      canRequestTransfer,
      canApproveTransfer,
      canManageTransfers,
      canManageCashRegister,
      canManageCustomers,
      canManageSettings,
      isOwner,
      isAdmin,
      isManager,
      isCashier,
      isSeller,
      hasMultiBranchAccess,
      canViewAllCashSessions,
      canViewBranchCashSessions,
      canCreateDirectTransfer,
    };
  }, [permissionSet, canonicalRole, allBranchesAccess]);

  const checkCanAccessBranch = useCallback(
    (targetBranchId?: string | null): boolean =>
      canAccessBranch({ role: canonicalRole, branchId, allBranchesAccess }, targetBranchId),
    [canonicalRole, branchId, allBranchesAccess]
  );

  const canRequestTransferFromBranch = useCallback(
    (targetBranchId: string): boolean => {
      if (!derived.canRequestTransfer) return false;
      if (derived.isOwner || derived.isAdmin) return true;
      if (derived.isManager || derived.isCashier) {
        return canAccessBranch({ role: canonicalRole, branchId, allBranchesAccess }, targetBranchId);
      }
      return false;
    },
    [
      derived.canRequestTransfer,
      derived.isOwner,
      derived.isAdmin,
      derived.isManager,
      derived.isCashier,
      canonicalRole,
      branchId,
      allBranchesAccess,
    ]
  );

  const canApproveTransferToBranch = useCallback(
    (targetBranchId: string): boolean => {
      if (!derived.canApproveTransfer) return false;
      if (derived.isOwner || derived.isAdmin) return true;
      if (derived.isManager) {
        return canAccessBranch({ role: canonicalRole, branchId, allBranchesAccess }, targetBranchId);
      }
      return false;
    },
    [
      derived.canApproveTransfer,
      derived.isOwner,
      derived.isAdmin,
      derived.isManager,
      canonicalRole,
      branchId,
      allBranchesAccess,
    ]
  );

  const canViewTransfer = useCallback(
    (transfer: TransferScopeTarget): boolean => {
      if (derived.isOwner || derived.isAdmin) return true;
      if (derived.isManager || derived.isCashier) {
        return (
          derived.hasMultiBranchAccess ||
          branchId === transfer.sourceBranchId ||
          branchId === transfer.destinationBranchId
        );
      }
      return false;
    },
    [
      derived.isOwner,
      derived.isAdmin,
      derived.isManager,
      derived.isCashier,
      derived.hasMultiBranchAccess,
      branchId,
    ]
  );

  const canUpdateTransferStatus = useCallback(
    (transfer: TransferStatusTarget, newStatus: string): boolean => {
      if (derived.isOwner || derived.isAdmin) return true;
      switch (newStatus) {
        case 'approved':
        case 'rejected':
          return (
            derived.isManager &&
            (derived.hasMultiBranchAccess || branchId === transfer.destinationBranchId) &&
            transfer.status === 'pending'
          );
        case 'in_transit':
          return (
            (derived.isManager || derived.isCashier) &&
            (derived.hasMultiBranchAccess || branchId === transfer.sourceBranchId) &&
            transfer.status === 'approved'
          );
        case 'completed':
          return (
            (derived.isManager || derived.isCashier) &&
            (derived.hasMultiBranchAccess || branchId === transfer.destinationBranchId) &&
            (transfer.status === 'in_transit' || transfer.status === 'approved')
          );
        default:
          return false;
      }
    },
    [
      derived.isOwner,
      derived.isAdmin,
      derived.isManager,
      derived.isCashier,
      derived.hasMultiBranchAccess,
      branchId,
    ]
  );

  const getUserRole = useCallback((): Role => canonicalRole, [canonicalRole]);

  return useMemo<UsePermissionsResult>(
    () => ({
      role: canonicalRole,
      userRole: canonicalRole,
      userBranchId: branchId,
      permissions: userPermissions,
      getEffectivePermissions,
      getUserRole,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      ...derived,
      canViewOwnCashSession: true,
      canRequestTransferFromBranch,
      canApproveTransferToBranch,
      canViewTransfer,
      canUpdateTransferStatus,
      isSuperAdmin,
      hasAllBranchesAccess: derived.hasMultiBranchAccess,
      allBranchesAccess: derived.hasMultiBranchAccess,
      canAccessBranch: checkCanAccessBranch,
    }),
    [
      canonicalRole,
      branchId,
      userPermissions,
      getEffectivePermissions,
      getUserRole,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      derived,
      canRequestTransferFromBranch,
      canApproveTransferToBranch,
      canViewTransfer,
      canUpdateTransferStatus,
      isSuperAdmin,
      checkCanAccessBranch,
    ]
  );
}

export const PermissionsProvider: React.FC<{ children: React.ReactNode }> = React.memo(
  ({ children }) => {
    const { role, customPermissions, branchId, allBranchesAccess, isSuperAdmin } =
      useContext(AuthSessionContext);
    const value = useComputedPermissions({
      role,
      customPermissions,
      branchId,
      allBranchesAccess,
      isSuperAdmin,
    });
    return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
  }
);

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
  const isActiveRef = useRef<boolean>(true);
  const isSuperAdminRef = useRef<boolean>(false);
  const limitsRef = useRef<PlanLimits | null>(null);
  const subscriptionRef = useRef<PlanSubscription | null>(null);
  const lastWrittenPlanRef = useRef<{
    key: string;
    limits: PlanLimits | null;
    subscription: PlanSubscription | null;
    cachedAt: number;
  } | null>(null);
  const checkedAccessScopeRef = useRef<string | null>(null);
  const lastAccessCheckAtRef = useRef<number>(0);
  const lastWrittenProfileRef = useRef<{
    uid: string;
    payload: Omit<CachedUserProfile, 'cachedAt'>;
  } | null>(null);
  const lastWrittenAccountIdRef = useRef<string | null>(null);
  const lastWrittenBranchIdRef = useRef<string | null>(null);
  const userProfileBranchIdRef = useRef<string | undefined>(undefined);
  const pinMetaLoadedRef = useRef<boolean>(false);
  const branchIdRef = useRef<string>('main');

  identityRef.current = `${user?.uid || ''}:${accountId || ''}`;
  branchIdRef.current = branchId;
  isOnlineRef.current = isOnline;
  isActiveRef.current = isActive;
  isSuperAdminRef.current = isSuperAdmin;
  limitsRef.current = limits;
  subscriptionRef.current = subscription;
  userProfileBranchIdRef.current = userProfile?.branchId;
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
        await removeMetaItem(SECURE_PIN_KEY);
        await AsyncStorage.removeItem(SECURE_PIN_KEY).catch(() => {});
        return;
      }
    } catch {
      // Fallback to metaKVStorage below
    }
    await writeMetaItem(SECURE_PIN_KEY, serialized);
    if (metaKVStorage.isSyncCapable) {
      await AsyncStorage.removeItem(SECURE_PIN_KEY).catch(() => {});
    }
  }, []);

  const clearSessionCaches = useCallback(
    async (uidToClear?: string | null, accountToClear?: string | null) => {
      const branchesToClear = new Set<string>(visitedBranchesRef.current);
      branchesToClear.add('main');
      branchesToClear.add('account');

      lastWrittenPlanRef.current = null;
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

      const metaKeysToRemove = new Set<string>([
        STORAGE_ACCOUNT_ID_KEY,
        STORAGE_BRANCH_ID_KEY,
      ]);
      const asyncKeysToRemove = new Set<string>([
        STORAGE_ACCOUNT_ID_KEY,
        STORAGE_BRANCH_ID_KEY,
        '@ventify_pos_cart',
      ]);
      if (uidToClear) {
        const userKey = `${USER_PROFILE_CACHE_PREFIX}${uidToClear}`;
        metaKeysToRemove.add(userKey);
        asyncKeysToRemove.add(userKey);
      }
      if (accountToClear) {
        const settingsKey = `${SETTINGS_CACHE_PREFIX}${accountToClear}`;
        metaKeysToRemove.add(settingsKey);
        asyncKeysToRemove.add(settingsKey);
        catalogKeysToRemove.push(productCatalogDeltaKey(accountToClear));
      }
      if (uidToClear && accountToClear) {
        const planKey = `${PLAN_CACHE_PREFIX}${uidToClear}:${accountToClear}`;
        metaKeysToRemove.add(planKey);
        asyncKeysToRemove.add(planKey);
      }

      try {
        if (typeof metaKVStorage.getAllKeys === 'function') {
          const metaKeys = await metaKVStorage.getAllKeys();
          for (const key of metaKeys) {
            if (
              key.startsWith(PLAN_CACHE_PREFIX) ||
              key.startsWith(USER_PROFILE_CACHE_PREFIX) ||
              key.startsWith(SETTINGS_CACHE_PREFIX) ||
              key.startsWith(CASH_SESSION_CACHE_PREFIX)
            ) {
              metaKeysToRemove.add(key);
            }
          }
        }
      } catch {
        // Ignore MMKV key enumeration failure
      }

      try {
        if (typeof catalogKVStorage.getAllKeys === 'function') {
          const catKeys = await catalogKVStorage.getAllKeys();
          for (const key of catKeys) {
            if (
              key.startsWith('@ventify_catalog_delta_v1:') ||
              key.startsWith('@ventify_product_catalog:')
            ) {
              catalogKeysToRemove.push(key);
            }
          }
        }
      } catch {
        // Ignore MMKV catalog key enumeration failure
      }

      try {
        if (typeof AsyncStorage.getAllKeys === 'function') {
          const allKeys = await AsyncStorage.getAllKeys();
          for (const key of allKeys) {
            if (
              key.startsWith(PLAN_CACHE_PREFIX) ||
              key.startsWith(USER_PROFILE_CACHE_PREFIX) ||
              key.startsWith(SETTINGS_CACHE_PREFIX) ||
              key.startsWith(CASH_SESSION_CACHE_PREFIX) ||
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

      const metaKeysArray = Array.from(metaKeysToRemove);
      await Promise.all([
        metaKeysArray.length > 0
          ? metaKVStorage.multiRemove(metaKeysArray).catch(() => {})
          : Promise.resolve(),
        AsyncStorage.multiRemove(Array.from(asyncKeysToRemove)).catch(() => {}),
        cartKeysToRemove.length > 0
          ? cartKVStorage.multiRemove(Array.from(new Set(cartKeysToRemove))).catch(() => {})
          : Promise.resolve(),
        catalogKeysToRemove.length > 0
          ? catalogKVStorage.multiRemove(Array.from(new Set(catalogKeysToRemove))).catch(() => {})
          : Promise.resolve(),
      ]);

      clearRequestCache();
      visitedBranchesRef.current = new Set(['main']);
    },
    []
  );

  // 0. Monitoreo temprano de red (activo incluso antes del login, con debounce en caídas breves)
  useEffect(() => {
    let isMounted = true;
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;

    const applyNetState = (online: boolean) => {
      if (!isMounted) return;
      if (online) {
        if (offlineTimer) {
          clearTimeout(offlineTimer);
          offlineTimer = null;
        }
        isOnlineRef.current = true;
        setIsOnline((prev) => (prev ? prev : true));
        return;
      }
      if (offlineTimer) return;
      offlineTimer = setTimeout(() => {
        offlineTimer = null;
        if (!isMounted) return;
        isOnlineRef.current = false;
        setIsOnline((prev) => (!prev ? prev : false));
      }, 1500);
    };

    NetInfo.fetch()
      .then((state) => {
        if (!isMounted) return;
        const online = Boolean(state.isConnected && state.isInternetReachable !== false);
        wasOfflineRef.current = !online;
        isOnlineRef.current = online;
        setIsOnline(online);
      })
      .catch(() => {});

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      applyNetState(online);
    });

    return () => {
      isMounted = false;
      if (offlineTimer) {
        clearTimeout(offlineTimer);
        offlineTimer = null;
      }
      unsubscribeNet();
    };
  }, []);

  // 1. Inicializar almacenamiento persistente local (PIN cifrado/hasheado e intentos) solo cuando hay sesión activa
  useEffect(() => {
    if (!user?.uid || pinMetaLoadedRef.current) return;
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
          // Fallback to metaKVStorage below
        }

        if (!savedPinRaw) {
          savedPinRaw = await readMetaItem(SECURE_PIN_KEY, {
            migrationSentinel: PIN_FALLBACK_MIGRATED_KEY,
          });
        }

        const parsedPin = parseStoredPin(savedPinRaw);
        if (parsedPin && savedPinRaw && isMounted) {
          storedPinRawRef.current = savedPinRaw;
          setPinLength(parsedPin.pinLength);
          setHasConfiguredPin(true);
        }

        const rawAttempts =
          readMetaItemSync(STORAGE_PIN_ATTEMPTS_KEY) ??
          (await readMetaItem(STORAGE_PIN_ATTEMPTS_KEY, {
            migrationSentinel: PIN_ATTEMPTS_MIGRATED_KEY,
          }));
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
        pinMetaLoadedRef.current = true;
      } catch (err) {
        console.warn('[AuthContext] Error loading initial storage:', err);
      }
    }

    void loadStoredAuthMeta();
    return () => {
      isMounted = false;
    };
  }, [user?.uid]);

  const resolveProfileOnce = useMemo(createProfileResolutionGate, []);

  // 2. Resolver accountId, role, branchId y permisos del usuario autenticado
  const resolveUserProfile = useCallback(
    (firebaseUser: User) =>
      resolveProfileOnce(firebaseUser.uid, async () => {
        try {
          const syncCachedProfile = readCachedUserProfileSync(firebaseUser.uid);
          const cachedProfilePromise = syncCachedProfile
            ? Promise.resolve(syncCachedProfile)
            : readCachedUserProfile(firebaseUser.uid);

          let resolvedAccountId: string | null = null;
          let resolvedRole: UserRole = 'cashier';
          let resolvedBranchId: string | undefined = undefined;
          let resolvedAllBranches = false;
          let resolvedCustomPermissions: CustomUserPermissions | null = null;
          let hasClaimsRole = false;
          let hasClaimsAllBranches = false;
          let hasFreshUserDoc = false;
          let freshIsActive = true;
          let freshIsSuperAdmin = false;
          let freshHasExplicitAccountId = false;
          let freshProfileBranchId: string | null = null;
          let freshDisplayName: string | null | undefined = firebaseUser.displayName;
          let freshPhotoURL: string | null | undefined = firebaseUser.photoURL;

          const [claimsResult, profileResult] = await loadIdentitySources(
            () => firebaseUser.getIdTokenResult(false),
            () => getDoc(doc(db, 'users', firebaseUser.uid))
          );
          const cachedProfile = await cachedProfilePromise;
          if (auth.currentUser?.uid !== firebaseUser.uid) return null;

          // 1. Verificar custom claims del JWT
          try {
            if (claimsResult.status === 'rejected') throw claimsResult.reason;
            const tokenResult = claimsResult.value;
            const claims = tokenResult.claims;
            if (auth.currentUser?.uid !== firebaseUser.uid) return null;
            freshIsSuperAdmin = claims.isSuperAdmin === true || claims.superAdmin === true;
            isSuperAdminRef.current = freshIsSuperAdmin;
            setIsSuperAdmin(freshIsSuperAdmin);

            if (claims.accountId) {
              resolvedAccountId = String(claims.accountId);
            }
            if (claims.role) {
              resolvedRole = claims.role as UserRole;
              hasClaimsRole = true;
            }
            if (claims.branchId) {
              resolvedBranchId = String(claims.branchId);
            }
            if (claims.allBranchesAccess !== undefined) {
              resolvedAllBranches = Boolean(claims.allBranchesAccess);
              hasClaimsAllBranches = true;
            }
          } catch (claimErr) {
            console.warn('[AuthContext] Error decoding custom claims:', claimErr);
          }

          // 2. Consultar documento del usuario en Firestore `users/{uid}`
          let shouldHydrateFromCache = false;
          let isOfflineOrFromCache = !isOnlineRef.current;
          try {
            if (profileResult.status === 'rejected') throw profileResult.reason;
            const userSnap = profileResult.value;
            if (userSnap.metadata?.fromCache === true) {
              isOfflineOrFromCache = true;
            }

            if (userSnap.exists()) {
              const uData = userSnap.data();
              if (auth.currentUser?.uid !== firebaseUser.uid) return null;
              hasFreshUserDoc = true;
              freshIsActive = uData.isActive !== false;
              isActiveRef.current = freshIsActive;
              setIsActive(freshIsActive);
              if (uData.accountId) {
                resolvedAccountId = uData.accountId;
                freshHasExplicitAccountId = true;
              }
              if (uData.role) {
                resolvedRole = uData.role as UserRole;
              }
              if (uData.branchId) {
                resolvedBranchId = uData.branchId;
                freshProfileBranchId = uData.branchId;
              }
              if (uData.allBranchesAccess !== undefined) {
                resolvedAllBranches = Boolean(uData.allBranchesAccess);
              }
              resolvedCustomPermissions = profilePermissions(uData);
              freshDisplayName = uData.displayName || uData.name || firebaseUser.displayName;
              freshPhotoURL = uData.photoURL || firebaseUser.photoURL;

              setUserProfile({
                uid: firebaseUser.uid,
                email: firebaseUser.email,
                displayName: freshDisplayName ?? null,
                photoURL: freshPhotoURL ?? null,
                emailVerified: firebaseUser.emailVerified,
                role: resolvedRole,
                accountId: resolvedAccountId || uData.accountId,
                branchId: resolvedBranchId || uData.branchId,
                createdAt: uData.createdAt,
              });
            } else if (userSnap.metadata?.fromCache === true || !isOnlineRef.current) {
              shouldHydrateFromCache = true;
            }
          } catch (docErr) {
            console.warn('[AuthContext] Error reading user doc:', docErr);
            shouldHydrateFromCache = true;
            isOfflineOrFromCache = true;
          }

          if (shouldHydrateFromCache) {
            if (auth.currentUser?.uid !== firebaseUser.uid) return null;
            freshIsActive = cachedProfile?.isActive !== false;
            isActiveRef.current = freshIsActive;
            setIsActive(freshIsActive);
            if (!resolvedAccountId && cachedProfile?.accountId) {
              resolvedAccountId = cachedProfile.accountId;
            }
            if (!hasClaimsRole && cachedProfile?.role) {
              resolvedRole = cachedProfile.role;
            }
            if (!resolvedBranchId && cachedProfile?.branchId) {
              resolvedBranchId = cachedProfile.branchId;
            }
            if (!hasClaimsAllBranches && cachedProfile) {
              resolvedAllBranches = cachedProfile.allBranchesAccess;
            }
            if (cachedProfile?.customPermissions) {
              resolvedCustomPermissions = cachedProfile.customPermissions;
            }

            if (!resolvedAccountId || !resolvedBranchId || resolvedBranchId === 'main') {
              const [storedAccountId, storedBranchId] = await Promise.all([
                !resolvedAccountId
                  ? (readMetaItemSync(STORAGE_ACCOUNT_ID_KEY) ?? readMetaItem(STORAGE_ACCOUNT_ID_KEY))
                  : Promise.resolve(null),
                !resolvedBranchId || resolvedBranchId === 'main'
                  ? (readMetaItemSync(STORAGE_BRANCH_ID_KEY) ?? readMetaItem(STORAGE_BRANCH_ID_KEY))
                  : Promise.resolve(null),
              ]);
              if (auth.currentUser?.uid !== firebaseUser.uid) return null;
              if (!resolvedAccountId && storedAccountId) {
                resolvedAccountId = storedAccountId;
              }
              if ((!resolvedBranchId || resolvedBranchId === 'main') && storedBranchId) {
                resolvedBranchId = storedBranchId;
              }
            }

            if (cachedProfile || resolvedAccountId) {
              setUserProfile({
                uid: firebaseUser.uid,
                email: firebaseUser.email ?? cachedProfile?.email ?? null,
                displayName: cachedProfile?.displayName || firebaseUser.displayName,
                photoURL: cachedProfile?.photoURL || firebaseUser.photoURL,
                emailVerified: firebaseUser.emailVerified,
                role: resolvedRole,
                accountId: resolvedAccountId || undefined,
                branchId: resolvedBranchId,
              });
            }
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

          // 4. Si el usuario multisede no tiene branchId válido cacheado ni fijo en su perfil, resolver la sucursal principal
          if (resolvedAccountId && (!resolvedBranchId || resolvedBranchId === 'main')) {
            if (resolvedRole !== 'seller') {
              const multiBranch = hasAllBranchesAccess({
                role: resolvedRole,
                allBranchesAccess: resolvedAllBranches,
              });
              if (multiBranch) {
                const cachedAccount =
                  readMetaItemSync(STORAGE_ACCOUNT_ID_KEY) ??
                  (await readMetaItem(STORAGE_ACCOUNT_ID_KEY));
                const cachedBranch =
                  readMetaItemSync(STORAGE_BRANCH_ID_KEY) ??
                  (await readMetaItem(STORAGE_BRANCH_ID_KEY));
                if (
                  cachedBranch &&
                  cachedBranch !== 'main' &&
                  (!cachedAccount || cachedAccount === resolvedAccountId)
                ) {
                  resolvedBranchId = cachedBranch;
                }
              }

              if (!resolvedBranchId || resolvedBranchId === 'main') {
                try {
                  const branchSnap = await getDocs(
                    query(
                      collection(db, 'branches'),
                      where('accountId', '==', resolvedAccountId),
                      limit(10)
                    )
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
          }

          if (isOfflineOrFromCache && (!resolvedBranchId || resolvedBranchId === 'main')) {
            if (cachedProfile?.branchId && cachedProfile.branchId !== 'main') {
              resolvedBranchId = cachedProfile.branchId;
            } else if (!shouldHydrateFromCache) {
              const storedBranchId =
                readMetaItemSync(STORAGE_BRANCH_ID_KEY) ??
                (await readMetaItem(STORAGE_BRANCH_ID_KEY));
              if (storedBranchId) {
                resolvedBranchId = storedBranchId;
              }
            }
          }

          resolvedAllBranches = hasAllBranchesAccess({
            role: resolvedRole,
            allBranchesAccess: resolvedAllBranches,
          });

          if (auth.currentUser?.uid !== firebaseUser.uid) return null;
          identityRef.current = `${firebaseUser.uid}:${resolvedAccountId || ''}`;
          branchIdRef.current = resolvedBranchId || 'main';
          setAccountId(resolvedAccountId);
          setRole(resolvedRole);
          setAllBranchesAccess(resolvedAllBranches);
          setCustomPermissions((prev) =>
            sameJsonValue(prev, resolvedCustomPermissions) ? prev : resolvedCustomPermissions
          );
          setBranchIdState(resolvedBranchId || 'main');

          if (hasFreshUserDoc) {
            const profilePayload: Omit<CachedUserProfile, 'cachedAt'> = {
              accountId: resolvedAccountId,
              branchId: resolvedBranchId,
              profileBranchId: freshProfileBranchId,
              hasExplicitAccountId: freshHasExplicitAccountId,
              role: resolvedRole,
              allBranchesAccess: resolvedAllBranches,
              customPermissions: resolvedCustomPermissions,
              isActive: freshIsActive,
              isSuperAdmin: freshIsSuperAdmin,
              displayName: freshDisplayName ?? null,
              photoURL: freshPhotoURL ?? null,
              email: firebaseUser.email ?? null,
            };
            const prevWritten = lastWrittenProfileRef.current;
            if (
              !prevWritten ||
              prevWritten.uid !== firebaseUser.uid ||
              !areCachedProfilesEqual(prevWritten.payload, profilePayload)
            ) {
              lastWrittenProfileRef.current = { uid: firebaseUser.uid, payload: profilePayload };
              void writeCachedUserProfile(firebaseUser.uid, profilePayload);
            }
          }

          if (resolvedAccountId && resolvedAccountId !== lastWrittenAccountIdRef.current) {
            lastWrittenAccountIdRef.current = resolvedAccountId;
            writeMetaItemSyncOrAsync(STORAGE_ACCOUNT_ID_KEY, resolvedAccountId);
          }
          if (resolvedBranchId && resolvedBranchId !== 'main') {
            visitedBranchesRef.current.add(resolvedBranchId);
            if (resolvedBranchId !== lastWrittenBranchIdRef.current) {
              lastWrittenBranchIdRef.current = resolvedBranchId;
              writeMetaItemSyncOrAsync(STORAGE_BRANCH_ID_KEY, resolvedBranchId);
            }
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

        if (!u) {
          const prevSession = lastSessionRef.current;
          lastSessionRef.current = { uid: null, accountId: null };
          identityRef.current = ':';
          branchIdRef.current = 'main';
          isActiveRef.current = true;
          isSuperAdminRef.current = false;
          subscriptionRef.current = null;
          checkedAccessScopeRef.current = null;
          lastAccessCheckAtRef.current = 0;
          lastWrittenProfileRef.current = null;
          lastWrittenAccountIdRef.current = null;
          lastWrittenBranchIdRef.current = null;
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
          setAccessError(null);
          setAccessChecking(false);

          if (isMounted) {
            setLoading(false);
            setInitialized(true);
          }

          if (prevSession.uid || prevSession.accountId) {
            void clearSessionCaches(prevSession.uid, prevSession.accountId).catch(() => {});
          }
          return;
        }

        let cachedProfile = readCachedUserProfileSync(u.uid);
        let storedAccountId = readMetaItemSync(STORAGE_ACCOUNT_ID_KEY);
        let storedBranchId = readMetaItemSync(STORAGE_BRANCH_ID_KEY);

        if (!cachedProfile) {
          const [asyncProfile, asyncAccountId, asyncBranchId] = await Promise.all([
            readCachedUserProfile(u.uid),
            storedAccountId !== null ? Promise.resolve(storedAccountId) : readMetaItem(STORAGE_ACCOUNT_ID_KEY),
            storedBranchId !== null ? Promise.resolve(storedBranchId) : readMetaItem(STORAGE_BRANCH_ID_KEY),
          ]);
          if (!isMounted || auth.currentUser?.uid !== u.uid) return;
          cachedProfile = asyncProfile;
          storedAccountId = asyncAccountId;
          storedBranchId = asyncBranchId;
        }

        let resolvedAccount: string | null = null;
        let initialHasExplicitAccount = false;

        if (cachedProfile && cachedProfile.accountId) {
          resolvedAccount = cachedProfile.accountId;
          initialHasExplicitAccount = Boolean(cachedProfile.hasExplicitAccountId);

          const optimisticRole = cachedProfile.role as UserRole;
          const optimisticAllBranches = hasAllBranchesAccess({
            role: optimisticRole,
            allBranchesAccess: cachedProfile.allBranchesAccess,
          });
          const optimisticBranchId = resolveOptimisticBranchId({
            role: optimisticRole,
            allBranchesAccess: optimisticAllBranches,
            accountId: cachedProfile.accountId,
            profileBranchId: cachedProfile.profileBranchId ?? cachedProfile.branchId,
            storedBranchId,
            storedAccountId,
          });
          const optimisticSuperAdmin = Boolean(cachedProfile.isSuperAdmin);
          const optimisticIsActive = cachedProfile.isActive !== false;
          const optimisticCustomPermissions =
            cachedProfile.customPermissions as CustomUserPermissions | null;
          const optimisticProfileBranch =
            cachedProfile.profileBranchId !== undefined
              ? (cachedProfile.profileBranchId ?? undefined)
              : (cachedProfile.branchId ?? undefined);

          const optimisticScope = `${u.uid}:${cachedProfile.accountId}`;
          identityRef.current = optimisticScope;
          branchIdRef.current = optimisticBranchId;
          isActiveRef.current = optimisticIsActive;
          isSuperAdminRef.current = optimisticSuperAdmin;
          lastSessionRef.current = { uid: u.uid, accountId: cachedProfile.accountId };
          if (optimisticBranchId && optimisticBranchId !== 'main') {
            visitedBranchesRef.current.add(optimisticBranchId);
          }

          lastWrittenProfileRef.current = {
            uid: u.uid,
            payload: {
              accountId: cachedProfile.accountId,
              branchId: cachedProfile.branchId ?? undefined,
              profileBranchId: cachedProfile.profileBranchId,
              hasExplicitAccountId: cachedProfile.hasExplicitAccountId,
              role: optimisticRole,
              allBranchesAccess: optimisticAllBranches,
              customPermissions: optimisticCustomPermissions,
              isActive: optimisticIsActive,
              isSuperAdmin: optimisticSuperAdmin,
              displayName: cachedProfile.displayName ?? null,
              photoURL: cachedProfile.photoURL ?? null,
              email: cachedProfile.email ?? null,
            },
          };
          lastWrittenAccountIdRef.current = storedAccountId;
          lastWrittenBranchIdRef.current = storedBranchId;

          let nextSubscription: PlanSubscription | null = null;
          let nextLimits: PlanLimits | null = null;
          let nextAccessChecking = true;

          if (!optimisticIsActive || optimisticRole === 'seller' || optimisticSuperAdmin) {
            nextAccessChecking = false;
          } else {
            const rawPlanSync = readMetaItemSync(`${PLAN_CACHE_PREFIX}${optimisticScope}`);
            const parsedPlan = parseCachedPlan<PlanLimits, PlanSubscription>(rawPlanSync);
            const evaluation = evaluateCachedPlanAccess({
              cached: parsedPlan,
              isActive: optimisticIsActive,
              isSuperAdmin: optimisticSuperAdmin,
            });
            if (evaluation.usableOptimistic && evaluation.cached) {
              nextSubscription = evaluation.cached.subscription;
              nextLimits = evaluation.cached.limits ?? null;
              nextAccessChecking = false;
              checkedAccessScopeRef.current = optimisticScope;
            }
          }

          subscriptionRef.current = nextSubscription;
          setUser(u);
          setUserProfile({
            uid: u.uid,
            email: u.email ?? cachedProfile.email ?? null,
            displayName: cachedProfile.displayName ?? u.displayName ?? null,
            photoURL: cachedProfile.photoURL ?? u.photoURL ?? null,
            emailVerified: u.emailVerified,
            role: optimisticRole,
            accountId: cachedProfile.accountId,
            branchId: optimisticProfileBranch,
            allBranchesAccess: optimisticAllBranches,
            customPermissions: optimisticCustomPermissions,
            isActive: optimisticIsActive,
          });
          setIsSuperAdmin(optimisticSuperAdmin);
          setAccountId(cachedProfile.accountId);
          setBranchIdState(optimisticBranchId);
          setRole(optimisticRole);
          setAllBranchesAccess(optimisticAllBranches);
          setCustomPermissions((prev) =>
            sameJsonValue(prev, optimisticCustomPermissions) ? prev : optimisticCustomPermissions
          );
          setIsActive(optimisticIsActive);
          setSubscription((prev) => (sameJsonValue(prev, nextSubscription) ? prev : nextSubscription));
          setLimits((prev) => (sameJsonValue(prev, nextLimits) ? prev : nextLimits));
          setAccessError(null);
          setAccessChecking(nextAccessChecking);
          setLoading(false);
          setInitialized(true);

          if (typeof u.getIdTokenResult === 'function') {
            void u
              .getIdTokenResult(false)
              .then((tokenResult) => {
                if (!isMounted || auth.currentUser?.uid !== u.uid) return;
                const claims = tokenResult.claims;
                const nextSuperAdmin = claims.isSuperAdmin === true || claims.superAdmin === true;
                if (nextSuperAdmin !== isSuperAdminRef.current) {
                  isSuperAdminRef.current = nextSuperAdmin;
                  setIsSuperAdmin(nextSuperAdmin);
                  if (lastWrittenProfileRef.current?.uid === u.uid) {
                    const updatedPayload = {
                      ...lastWrittenProfileRef.current.payload,
                      isSuperAdmin: nextSuperAdmin,
                    };
                    lastWrittenProfileRef.current = { uid: u.uid, payload: updatedPayload };
                    void writeCachedUserProfile(u.uid, updatedPayload);
                  }
                }
              })
              .catch(() => {});
          }
        } else {
          identityRef.current = `${u.uid}:`;
          branchIdRef.current = 'main';
          isActiveRef.current = true;
          isSuperAdminRef.current = false;
          subscriptionRef.current = null;
          checkedAccessScopeRef.current = null;
          lastAccessCheckAtRef.current = 0;
          lastWrittenProfileRef.current = null;
          lastWrittenAccountIdRef.current = storedAccountId;
          lastWrittenBranchIdRef.current = storedBranchId;

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
          setAccessChecking(true);
          setCustomPermissions(null);
          setIsActive(true);
          setLoading(true);

          resolvedAccount = await resolveUserProfile(u);
          if (!isMounted || auth.currentUser?.uid !== u.uid) return;
          if (!resolvedAccount) {
            setAccessChecking(false);
            setAccessError('No se pudo determinar la cuenta. Vuelve a iniciar sesión.');
          }
          setLoading(false);
          setInitialized(true);
        }

        try {
          const userDocRef = doc(db, 'users', u.uid);
          let hasSeenExplicitAccount = initialHasExplicitAccount;
          unsubUserDoc = onSnapshot(
            userDocRef,
            (snap) => {
              if (!isMounted || auth.currentUser?.uid !== u.uid) return;
              if (snap.exists()) {
                const data = snap.data();
                const activeFlag = data.isActive !== false;
                isActiveRef.current = activeFlag;
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
                  identityRef.current = `${u.uid}:${liveAccountId || ''}`;
                  checkedAccessScopeRef.current = null;
                  lastAccessCheckAtRef.current = 0;
                  setSubscription(null);
                  setLimits(null);
                  setAccessChecking(Boolean(liveAccountId) && activeFlag);
                }
                setAccountId(liveAccountId);
                if (data.accountId && data.accountId !== lastWrittenAccountIdRef.current) {
                  lastWrittenAccountIdRef.current = data.accountId;
                  writeMetaItemSyncOrAsync(STORAGE_ACCOUNT_ID_KEY, data.accountId);
                }

                if (data.branchId) {
                  visitedBranchesRef.current.add(data.branchId);
                  branchIdRef.current = data.branchId;
                  setBranchIdState(data.branchId);
                  if (data.branchId !== lastWrittenBranchIdRef.current) {
                    lastWrittenBranchIdRef.current = data.branchId;
                    writeMetaItemSyncOrAsync(STORAGE_BRANCH_ID_KEY, data.branchId);
                  }
                } else if (accountChanged) {
                  branchIdRef.current = 'main';
                  setBranchIdState('main');
                  void resolveUserProfile(u);
                }

                const effectiveAllBranches = hasAllBranchesAccess({
                  role: uRole,
                  allBranchesAccess: data.allBranchesAccess === true,
                });
                setAllBranchesAccess(effectiveAllBranches);
                const nextPermissions = profilePermissions(data);
                setCustomPermissions((prev) =>
                  sameJsonValue(prev, nextPermissions) ? prev : nextPermissions
                );

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

                const effectiveCachedBranchId =
                  data.branchId ||
                  (!accountChanged && branchIdRef.current !== 'main'
                    ? branchIdRef.current
                    : undefined);

                const nextCachedPayload: Omit<CachedUserProfile, 'cachedAt'> = {
                  accountId: liveAccountId,
                  branchId: effectiveCachedBranchId,
                  profileBranchId: data.branchId ?? null,
                  hasExplicitAccountId: hasSeenExplicitAccount,
                  role: uRole,
                  allBranchesAccess: effectiveAllBranches,
                  customPermissions: nextPermissions,
                  isActive: activeFlag,
                  isSuperAdmin: isSuperAdminRef.current,
                  displayName: nextProfile.displayName ?? null,
                  photoURL: nextProfile.photoURL ?? null,
                  email: nextProfile.email ?? null,
                };
                const prevWritten = lastWrittenProfileRef.current;
                if (
                  !prevWritten ||
                  prevWritten.uid !== u.uid ||
                  !areCachedProfilesEqual(prevWritten.payload, nextCachedPayload)
                ) {
                  lastWrittenProfileRef.current = { uid: u.uid, payload: nextCachedPayload };
                  void writeCachedUserProfile(u.uid, nextCachedPayload);
                }
              } else if (
                shouldDeactivateUserOnMissingDoc({
                  exists: false,
                  fromCache: snap.metadata?.fromCache,
                  isOnline: isOnlineRef.current,
                })
              ) {
                isActiveRef.current = false;
                setIsActive(false);
                setCustomPermissions(null);
                void readCachedUserProfile(u.uid).then((prevCached) => {
                  if (!isMounted || auth.currentUser?.uid !== u.uid) return;
                  const deactivatedPayload: Omit<CachedUserProfile, 'cachedAt'> = {
                    accountId: prevCached?.accountId ?? resolvedAccount ?? null,
                    branchId: prevCached?.branchId,
                    profileBranchId: prevCached?.profileBranchId ?? null,
                    hasExplicitAccountId: prevCached?.hasExplicitAccountId ?? hasSeenExplicitAccount,
                    role: prevCached?.role ?? 'cashier',
                    allBranchesAccess: prevCached?.allBranchesAccess ?? false,
                    customPermissions: null,
                    isActive: false,
                    isSuperAdmin: prevCached?.isSuperAdmin ?? isSuperAdminRef.current,
                    displayName: prevCached?.displayName ?? u.displayName ?? null,
                    photoURL: prevCached?.photoURL ?? u.photoURL ?? null,
                    email: prevCached?.email ?? u.email ?? null,
                  };
                  lastWrittenProfileRef.current = { uid: u.uid, payload: deactivatedPayload };
                  return writeCachedUserProfile(u.uid, deactivatedPayload);
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

    const rawSync = readMetaItemSync(cacheKey);
    let cached = parseCachedPlan<PlanLimits, PlanSubscription>(rawSync);
    if (!cached && rawSync === null) {
      const rawAsync = await readMetaItem(cacheKey);
      if (!isCurrent()) return;
      cached = parseCachedPlan<PlanLimits, PlanSubscription>(rawAsync);
    }

    const updateClockIfBlockChanged = (targetSub: PlanSubscription | null) => {
      const now = Date.now();
      setAccessClock((prevClock) => {
        const prevReason = accessBlockReason(
          { isActive: isActiveRef.current, isSuperAdmin: isSuperAdminRef.current },
          targetSub,
          prevClock
        );
        const nextReason = accessBlockReason(
          { isActive: isActiveRef.current, isSuperAdmin: isSuperAdminRef.current },
          targetSub,
          now
        );
        return prevReason === nextReason ? prevClock : now;
      });
    };

    const evaluation = evaluateCachedPlanAccess({
      cached,
      isActive: isActiveRef.current,
      isSuperAdmin: isSuperAdminRef.current,
    });

    if (evaluation.usableOptimistic && evaluation.cached && isCurrent()) {
      checkedAccessScopeRef.current = scope;
      const cachedSub = evaluation.cached.subscription;
      const cachedLimits = evaluation.cached.limits ?? null;
      subscriptionRef.current = cachedSub;
      setSubscription((prev) => (sameJsonValue(prev, cachedSub) ? prev : cachedSub));
      setLimits((prev) => (sameJsonValue(prev, cachedLimits) ? prev : cachedLimits));
      setAccessError(null);
      updateClockIfBlockChanged(cachedSub);
      setAccessChecking(false);
    }

    const netOnline = isOnlineRef.current;

    // Offline tolerance: allow previously authenticated accounts up to 72h offline
    if (!netOnline) {
      if (!isCurrent()) return;
      let effectiveSub: PlanSubscription | null = subscriptionRef.current;
      if (evaluation.within72h && evaluation.cached) {
        const cachedSub = evaluation.cached.subscription;
        const cachedLimits = evaluation.cached.limits ?? null;
        effectiveSub = cachedSub;
        subscriptionRef.current = cachedSub;
        setSubscription((prev) => (sameJsonValue(prev, cachedSub) ? prev : cachedSub));
        setLimits((prev) => (sameJsonValue(prev, cachedLimits) ? prev : cachedLimits));
        setAccessError(null);
      } else {
        setAccessError('Sin conexión a internet. Conéctate para verificar el acceso de tu negocio.');
      }
      checkedAccessScopeRef.current = scope;
      updateClockIfBlockChanged(effectiveSub);
      setAccessChecking(false);
      return;
    }

    lastAccessCheckAtRef.current = Date.now();
    let resolvedSubForClock: PlanSubscription | null = subscriptionRef.current;
    try {
      const data = await apiRequest<{
        limits?: PlanLimits | null;
        subscription: PlanSubscription | null;
      }>(`/api/plan-limits/${encodeURIComponent(accountId)}`);
      if (!isCurrent()) return;
      const nextSub = data.subscription ?? null;
      const nextLimits = data.limits ?? null;
      resolvedSubForClock = nextSub;
      limitsRef.current = nextLimits;
      subscriptionRef.current = nextSub;
      setSubscription((prev) => (sameJsonValue(prev, nextSub) ? prev : nextSub));
      setLimits((prev) => (sameJsonValue(prev, nextLimits) ? prev : nextLimits));
      setAccessError(null);
      const nowWritten = Date.now();
      const prevWrittenPlan = lastWrittenPlanRef.current;
      const planChangedForDisk =
        !prevWrittenPlan ||
        prevWrittenPlan.key !== cacheKey ||
        nowWritten - prevWrittenPlan.cachedAt > 12 * 60 * 60 * 1000 ||
        !sameJsonValue(prevWrittenPlan.limits, nextLimits) ||
        !sameJsonValue(prevWrittenPlan.subscription, nextSub);
      if (planChangedForDisk) {
        lastWrittenPlanRef.current = {
          key: cacheKey,
          limits: nextLimits,
          subscription: nextSub,
          cachedAt: nowWritten,
        };
        writeMetaItemSyncOrAsync(
          cacheKey,
          JSON.stringify({
            limits: nextLimits,
            subscription: nextSub,
            cachedAt: nowWritten,
          } satisfies CachedPlanPayload)
        );
      }
    } catch (error) {
      if (!isCurrent()) return;
      const status = (error as { status?: number }).status;
      const latestNet = await NetInfo.fetch().catch(() => null);
      const stillOnline = latestNet
        ? Boolean(latestNet.isConnected && latestNet.isInternetReachable !== false)
        : isOnlineRef.current;
      const isTransient = !status || status === 408 || status >= 500;
      const mayUseCache =
        isTransient &&
        evaluation.within72h &&
        evaluation.cached &&
        (!stillOnline || !status || evaluation.blockReason === null);

      if (mayUseCache && evaluation.cached) {
        const cachedSub = evaluation.cached.subscription;
        const cachedLimits = evaluation.cached.limits ?? null;
        resolvedSubForClock = cachedSub;
        subscriptionRef.current = cachedSub;
        setSubscription((prev) => (sameJsonValue(prev, cachedSub) ? prev : cachedSub));
        setLimits((prev) => (sameJsonValue(prev, cachedLimits) ? prev : cachedLimits));
        setAccessError(null);
      } else {
        setAccessError(
          error instanceof Error ? error.message : 'No se pudo verificar el acceso del negocio.'
        );
      }
    } finally {
      if (isCurrent()) {
        checkedAccessScopeRef.current = scope;
        updateClockIfBlockChanged(resolvedSubForClock);
        setAccessChecking(false);
      }
    }
  }, [user?.uid, accountId, role, isSuperAdmin, isActive, loading]);

  useEffect(() => {
    if (!user || !accountId || loading) return;
    const scope = `${user.uid}:${accountId}`;
    if (checkedAccessScopeRef.current !== scope) {
      if (!isActive || role === 'seller' || isSuperAdmin) {
        setAccessChecking(false);
        setAccessError(null);
      } else {
        const syncPlan = parseCachedPlan<PlanLimits, PlanSubscription>(
          readMetaItemSync(`${PLAN_CACHE_PREFIX}${scope}`)
        );
        const evalSync = evaluateCachedPlanAccess({
          cached: syncPlan,
          isActive,
          isSuperAdmin,
        });
        if (evalSync.usableOptimistic && evalSync.cached) {
          checkedAccessScopeRef.current = scope;
          subscriptionRef.current = evalSync.cached.subscription;
          setSubscription((prev) =>
            sameJsonValue(prev, evalSync.cached!.subscription)
              ? prev
              : evalSync.cached!.subscription
          );
          setLimits((prev) =>
            sameJsonValue(prev, evalSync.cached!.limits ?? null)
              ? prev
              : (evalSync.cached!.limits ?? null)
          );
          setAccessError(null);
          setAccessChecking(false);
        } else {
          setAccessChecking(true);
          setAccessError(null);
        }
      }
    }
    void refreshAccess();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void NetInfo.fetch()
          .then((netState) => {
            const online = Boolean(
              netState.isConnected && netState.isInternetReachable !== false
            );
            isOnlineRef.current = online;
            setIsOnline(online);
          })
          .catch(() => {});
        const now = Date.now();
        setAccessClock((prevClock) => {
          const prevReason = accessBlockReason(
            { isActive: isActiveRef.current, isSuperAdmin: isSuperAdminRef.current },
            subscriptionRef.current,
            prevClock
          );
          const nextReason = accessBlockReason(
            { isActive: isActiveRef.current, isSuperAdmin: isSuperAdminRef.current },
            subscriptionRef.current,
            now
          );
          return prevReason === nextReason ? prevClock : now;
        });
        const currentlyBlocked = Boolean(
          accessBlockReason(
            { isActive: isActiveRef.current, isSuperAdmin: isSuperAdminRef.current },
            subscriptionRef.current,
            now
          )
        );
        if (
          shouldRecheckAccessOnForeground({
            isBlocked: currentlyBlocked,
            lastCheckAt: lastAccessCheckAtRef.current,
            now,
          })
        ) {
          void refreshAccess();
        }
      }
    });
    return () => {
      foreground.remove();
    };
  }, [user?.uid, accountId, loading, isActive, role, isSuperAdmin, refreshAccess]);

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
      const canChange = hasAllBranchesAccess({
        role,
        branchId: branchIdRef.current,
        allBranchesAccess,
      });
      if (!canChange) {
        console.warn('[AuthContext] Usuario sin acceso multisede no puede cambiar de sucursal');
        return;
      }
      visitedBranchesRef.current.add(newBranchId);
      branchIdRef.current = newBranchId;
      setBranchIdState(newBranchId);
      lastWrittenBranchIdRef.current = newBranchId;
      writeMetaItemSyncOrAsync(STORAGE_BRANCH_ID_KEY, newBranchId);
    },
    [role, allBranchesAccess]
  );

  // Inicialización segura de sucursal asignada cuando el estado inicial sigue en 'main'
  const syncAssignedBranchId = useCallback(
    (assignedBranchId: string) => {
      if (!assignedBranchId || assignedBranchId === 'main') return;
      setBranchIdState((prev) => {
        if (prev !== 'main') return prev;
        const multiBranch = hasAllBranchesAccess({ role, branchId: prev, allBranchesAccess });
        if (!multiBranch && userProfileBranchIdRef.current !== assignedBranchId) {
          return prev;
        }
        visitedBranchesRef.current.add(assignedBranchId);
        branchIdRef.current = assignedBranchId;
        lastWrittenBranchIdRef.current = assignedBranchId;
        writeMetaItemSyncOrAsync(STORAGE_BRANCH_ID_KEY, assignedBranchId);
        return assignedBranchId;
      });
    },
    [role, allBranchesAccess]
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

  // 9. Cerrar sesión segura (limpia @ventify_plan:*, metaKVStorage, catalogKVStorage y cartKVStorage)
  const logout = useCallback(async () => {
    const uidToClear = user?.uid ?? lastSessionRef.current.uid;
    const accountToClear = accountId ?? lastSessionRef.current.accountId;
    setLoading(true);
    try {
      offlineSyncService.cancelPendingWork();
      offlineInventoryService.cancelPendingWork();
      offlineCashService.cancelPendingWork();
      await signOut(auth);
      lastSessionRef.current = { uid: null, accountId: null };
      identityRef.current = ':';
      branchIdRef.current = 'main';
      isActiveRef.current = true;
      isSuperAdminRef.current = false;
      subscriptionRef.current = null;
      checkedAccessScopeRef.current = null;
      lastAccessCheckAtRef.current = 0;
      lastWrittenProfileRef.current = null;
      lastWrittenAccountIdRef.current = null;
      lastWrittenBranchIdRef.current = null;
      storedPinRawRef.current = null;
      pinMetaLoadedRef.current = false;
      setHasConfiguredPin(false);
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
      await Promise.all([
        removeMetaItem(STORAGE_PIN_ATTEMPTS_KEY),
        removeMetaItem(SECURE_PIN_KEY),
        AsyncStorage.removeItem(STORAGE_PIN_ATTEMPTS_KEY).catch(() => {}),
        AsyncStorage.removeItem(SECURE_PIN_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(SECURE_PIN_KEY).catch(() => {}),
      ]);
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
        removeMetaItemSyncOrAsync(STORAGE_PIN_ATTEMPTS_KEY);

        if (result.upgradedRecord) {
          void persistPinRecord(result.upgradedRecord);
        }
        setIsPinLocked(false);
        return true;
      }

      const nextAttempts = registerFailedPinAttempt(pinAttemptStateRef.current, now);
      pinAttemptStateRef.current = nextAttempts;
      setPinAttemptState(nextAttempts);
      writeMetaItemSyncOrAsync(STORAGE_PIN_ATTEMPTS_KEY, JSON.stringify(nextAttempts));
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
      await removeMetaItem(STORAGE_PIN_ATTEMPTS_KEY);
    },
    [persistPinRecord]
  );

  const authSessionValue = useMemo<AuthSessionContextType>(
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
      initialized,
      loading,
      login,
      signup,
      sendPasswordReset,
      logout,
      setActiveBranchId,
      setBranchId: setActiveBranchId,
      syncAssignedBranchId,
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
      initialized,
      loading,
      login,
      signup,
      sendPasswordReset,
      logout,
      setActiveBranchId,
      syncAssignedBranchId,
    ]
  );

  const networkStatusValue = useMemo<NetworkStatusContextType>(
    () => ({ isOnline }),
    [isOnline]
  );

  const getPlanLimitsSnapshot = useCallback(() => limitsRef.current, []);

  const planAccessActionsValue = useMemo<PlanAccessActionsContextType>(
    () => ({
      refreshAccess,
      getPlanLimitsSnapshot,
    }),
    [refreshAccess, getPlanLimitsSnapshot]
  );

  const planAccessValue = useMemo<PlanAccessContextType>(
    () => ({
      limits,
      subscription,
      accessChecking,
      accessError,
      accessBlocked,
      refreshAccess,
    }),
    [limits, subscription, accessChecking, accessError, accessBlocked, refreshAccess]
  );

  const pinLockValue = useMemo<PinLockContextType>(
    () => ({
      isPinLocked,
      pinCode: '',
      pinLength,
      hasConfiguredPin,
      isPinSetupOpen,
      closePinSetup,
      pinFailedAttempts: pinAttemptState.failedAttempts,
      pinLockoutUntil: pinAttemptState.lockoutUntil,
      lockTerminal,
      unlockWithPin,
      updatePinCode,
    }),
    [
      isPinLocked,
      pinLength,
      hasConfiguredPin,
      isPinSetupOpen,
      closePinSetup,
      pinAttemptState.failedAttempts,
      pinAttemptState.lockoutUntil,
      lockTerminal,
      unlockWithPin,
      updatePinCode,
    ]
  );

  const contextValue = useMemo<AuthContextType>(
    () => ({
      ...authSessionValue,
      ...networkStatusValue,
      ...planAccessValue,
      ...pinLockValue,
    }),
    [authSessionValue, networkStatusValue, planAccessValue, pinLockValue]
  );

  return (
    <AuthSessionContext.Provider value={authSessionValue}>
      <NetworkStatusContext.Provider value={networkStatusValue}>
        <PlanAccessActionsContext.Provider value={planAccessActionsValue}>
          <PlanAccessContext.Provider value={planAccessValue}>
            <PinLockContext.Provider value={pinLockValue}>
              <AuthContext.Provider value={contextValue}>
                <PermissionsProvider>{children}</PermissionsProvider>
              </AuthContext.Provider>
            </PinLockContext.Provider>
          </PlanAccessContext.Provider>
        </PlanAccessActionsContext.Provider>
      </NetworkStatusContext.Provider>
    </AuthSessionContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
export const useAuthSession = () => useContext(AuthSessionContext);
export const useNetworkStatus = () => useContext(NetworkStatusContext);
export const usePlanAccess = () => useContext(PlanAccessContext);
export const usePlanAccessActions = () => useContext(PlanAccessActionsContext);
export const usePinLock = () => useContext(PinLockContext);
