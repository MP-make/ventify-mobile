import {
  accessBlockReason,
  type AccessBlockReason,
  type SubscriptionAccess,
} from './access-policy';
import { hasAllBranchesAccess } from './branch-access';

export const PLAN_CACHE_ONLINE_TTL_MS = 6 * 3600000;
export const PLAN_CACHE_OFFLINE_TTL_MS = 72 * 3600000;
export const FOREGROUND_ACCESS_RECHECK_MS = 5 * 60 * 1000;

export type StartupUserRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'seller';

const VALID_STARTUP_ROLES: readonly StartupUserRole[] = [
  'owner',
  'admin',
  'manager',
  'cashier',
  'seller',
];

export interface StartupCustomPermissions {
  granted?: string[];
  revoked?: string[];
}

export interface CachedUserProfileRecord {
  accountId: string | null;
  branchId?: string | null;
  profileBranchId?: string | null;
  hasExplicitAccountId?: boolean;
  role: StartupUserRole;
  allBranchesAccess: boolean;
  customPermissions: StartupCustomPermissions | null;
  isActive: boolean;
  isSuperAdmin?: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  email?: string | null;
  cachedAt: number;
}

export interface CachedPlanRecord<
  TLimits = unknown,
  TSub extends SubscriptionAccess = SubscriptionAccess,
> {
  limits?: TLimits | null;
  subscription: TSub | null;
  cachedAt: number;
}

export interface PlanCacheEvaluation<
  TLimits = unknown,
  TSub extends SubscriptionAccess = SubscriptionAccess,
> {
  usableOptimistic: boolean;
  within72h: boolean;
  blockReason: AccessBlockReason | null;
  cached: CachedPlanRecord<TLimits, TSub> | null;
}

/** Independent sources start together; either may use its existing fallback. */
export function loadIdentitySources<Claims, Profile>(
  readClaims: () => Promise<Claims>,
  readProfile: () => Promise<Profile>,
): Promise<[PromiseSettledResult<Claims>, PromiseSettledResult<Profile>]> {
  return Promise.allSettled([readClaims(), readProfile()]);
}

/** Auth state and the login screen may request the same profile concurrently. */
export function createProfileResolutionGate() {
  const pending = new Map<string, Promise<string | null>>();
  return (uid: string, load: () => Promise<string | null>): Promise<string | null> => {
    const existing = pending.get(uid);
    if (existing) return existing;
    const request = load().finally(() => {
      if (pending.get(uid) === request) pending.delete(uid);
    });
    pending.set(uid, request);
    return request;
  };
}

export function parseCachedUserProfile(
  raw: string | null | undefined
): CachedUserProfileRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedUserProfileRecord> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const role =
      typeof parsed.role === 'string' && VALID_STARTUP_ROLES.includes(parsed.role as StartupUserRole)
        ? (parsed.role as StartupUserRole)
        : 'cashier';
    const rawPerms = parsed.customPermissions;
    const customPermissions =
      rawPerms && typeof rawPerms === 'object'
        ? {
            granted: Array.isArray(rawPerms.granted)
              ? rawPerms.granted.filter((item): item is string => typeof item === 'string')
              : [],
            revoked: Array.isArray(rawPerms.revoked)
              ? rawPerms.revoked.filter((item): item is string => typeof item === 'string')
              : [],
          }
        : null;
    const profileBranchId =
      typeof parsed.profileBranchId === 'string' && parsed.profileBranchId
        ? parsed.profileBranchId
        : parsed.profileBranchId === null
          ? null
          : undefined;
    return {
      accountId: typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : null,
      branchId: typeof parsed.branchId === 'string' && parsed.branchId ? parsed.branchId : undefined,
      profileBranchId,
      hasExplicitAccountId:
        typeof parsed.hasExplicitAccountId === 'boolean' ? parsed.hasExplicitAccountId : undefined,
      role,
      allBranchesAccess: Boolean(parsed.allBranchesAccess),
      customPermissions,
      isActive: parsed.isActive !== false,
      isSuperAdmin: typeof parsed.isSuperAdmin === 'boolean' ? parsed.isSuperAdmin : false,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : null,
      photoURL: typeof parsed.photoURL === 'string' ? parsed.photoURL : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0,
    };
  } catch {
    return null;
  }
}

function sameStringArray(a?: string[], b?: string[]): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameCustomPermissions(
  a: StartupCustomPermissions | null | undefined,
  b: StartupCustomPermissions | null | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return sameStringArray(a.granted, b.granted) && sameStringArray(a.revoked, b.revoked);
}

export function areCachedProfilesEqual(
  a: Omit<CachedUserProfileRecord, 'cachedAt'>,
  b: Omit<CachedUserProfileRecord, 'cachedAt'>
): boolean {
  return (
    a.accountId === b.accountId &&
    (a.branchId ?? null) === (b.branchId ?? null) &&
    (a.profileBranchId ?? null) === (b.profileBranchId ?? null) &&
    a.hasExplicitAccountId === b.hasExplicitAccountId &&
    a.role === b.role &&
    Boolean(a.allBranchesAccess) === Boolean(b.allBranchesAccess) &&
    Boolean(a.isActive) === Boolean(b.isActive) &&
    Boolean(a.isSuperAdmin) === Boolean(b.isSuperAdmin) &&
    (a.displayName ?? null) === (b.displayName ?? null) &&
    (a.photoURL ?? null) === (b.photoURL ?? null) &&
    (a.email ?? null) === (b.email ?? null) &&
    sameCustomPermissions(a.customPermissions, b.customPermissions)
  );
}

export function resolveOptimisticBranchId(params: {
  role: StartupUserRole;
  allBranchesAccess: boolean;
  accountId: string;
  profileBranchId?: string | null;
  storedBranchId?: string | null;
  storedAccountId?: string | null;
}): string {
  const multiBranch = hasAllBranchesAccess({
    role: params.role,
    allBranchesAccess: params.allBranchesAccess,
  });
  const storedMatchesAccount =
    !params.storedAccountId || params.storedAccountId === params.accountId;
  const validStoredBranch =
    storedMatchesAccount &&
    typeof params.storedBranchId === 'string' &&
    params.storedBranchId.length > 0 &&
    params.storedBranchId !== 'main'
      ? params.storedBranchId
      : null;
  const validProfileBranch =
    typeof params.profileBranchId === 'string' &&
    params.profileBranchId.length > 0 &&
    params.profileBranchId !== 'main'
      ? params.profileBranchId
      : null;

  if (multiBranch) {
    return validStoredBranch || validProfileBranch || 'main';
  }
  return validProfileBranch || validStoredBranch || 'main';
}

export function parseCachedPlan<
  TLimits = unknown,
  TSub extends SubscriptionAccess = SubscriptionAccess,
>(raw: string | null | undefined): CachedPlanRecord<TLimits, TSub> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedPlanRecord<TLimits, TSub>> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.cachedAt !== 'number') {
      return null;
    }
    return {
      limits: parsed.limits ?? null,
      subscription: parsed.subscription ?? null,
      cachedAt: parsed.cachedAt,
    };
  } catch {
    return null;
  }
}

export function evaluateCachedPlanAccess<
  TLimits = unknown,
  TSub extends SubscriptionAccess = SubscriptionAccess,
>(params: {
  cached: CachedPlanRecord<TLimits, TSub> | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  now?: number;
}): PlanCacheEvaluation<TLimits, TSub> {
  const now = params.now ?? Date.now();
  const { cached } = params;
  if (!cached) {
    const blockReason = accessBlockReason(
      { isActive: params.isActive, isSuperAdmin: params.isSuperAdmin },
      null,
      now
    );
    return { usableOptimistic: false, within72h: false, blockReason, cached: null };
  }

  const age = now - cached.cachedAt;
  const within72h = age >= -5 * 60_000 && age < PLAN_CACHE_OFFLINE_TTL_MS;
  const blockReason = accessBlockReason(
    { isActive: params.isActive, isSuperAdmin: params.isSuperAdmin },
    cached.subscription,
    now
  );
  return {
    usableOptimistic: within72h && blockReason === null,
    within72h,
    blockReason,
    cached,
  };
}

export function shouldRecheckAccessOnForeground(params: {
  isBlocked: boolean;
  lastCheckAt: number;
  now?: number;
  throttleMs?: number;
}): boolean {
  if (params.isBlocked) return true;
  const now = params.now ?? Date.now();
  const throttleMs = params.throttleMs ?? FOREGROUND_ACCESS_RECHECK_MS;
  if (params.lastCheckAt <= 0) return true;
  return now - params.lastCheckAt >= throttleMs;
}
