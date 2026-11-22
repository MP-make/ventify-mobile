import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('firebase/firestore', () => ({ onSnapshot: mocks.listen }));
import { subscribeLiveDocument } from '../live-document';
import {
  FOREGROUND_ACCESS_RECHECK_MS,
  PLAN_CACHE_OFFLINE_TTL_MS,
  areCachedProfilesEqual,
  createProfileResolutionGate,
  evaluateCachedPlanAccess,
  loadIdentitySources,
  parseCachedPlan,
  parseCachedUserProfile,
  resolveOptimisticBranchId,
  shouldRecheckAccessOnForeground,
} from '../auth-startup';

describe('startup loading', () => {
  it('uses a single document stream for its initial value and subsequent changes', () => {
    const stop = vi.fn();
    mocks.listen.mockReturnValueOnce(stop);
    const apply = vi.fn();
    const dispose = subscribeLiveDocument({} as any, apply, vi.fn());
    const receive = mocks.listen.mock.calls.at(-1)![2];
    receive({ exists: () => true, data: () => ({ name: 'initial' }) });
    receive({ exists: () => true, data: () => ({ name: 'updated' }) });
    expect(apply.mock.calls.map(([snapshot]) => snapshot.data().name)).toEqual(['initial', 'updated']);
    dispose();
    receive({ exists: () => true, data: () => ({ name: 'stale' }) });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('starts the profile read while claims are pending and preserves an independent failure', async () => {
    let resolveClaims!: (value: string) => void;
    const claims = vi.fn(() => new Promise<string>(resolve => { resolveClaims = resolve; }));
    const profile = vi.fn(async () => { throw new Error('offline'); });
    const pending = loadIdentitySources(claims, profile);
    expect(profile).toHaveBeenCalledOnce();
    resolveClaims('valid-claims');
    expect(await pending).toMatchObject([{ status: 'fulfilled', value: 'valid-claims' }, { status: 'rejected' }]);
  });

  it('shares simultaneous profile resolution for the same user, but retries after completion', async () => {
    const resolveProfile = createProfileResolutionGate();
    let complete!: (value: string | null) => void;
    const load = vi.fn(() => new Promise<string | null>(resolve => { complete = resolve; }));
    const first = resolveProfile('user-a', load);
    const duplicate = resolveProfile('user-a', load);
    expect(first).toBe(duplicate);
    expect(load).toHaveBeenCalledOnce();
    complete('account-a');
    expect(await first).toBe('account-a');
    expect(await resolveProfile('user-a', async () => 'new-account')).toBe('new-account');
  });

  it('does not share profile work between users', async () => {
    const resolveProfile = createProfileResolutionGate();
    expect(await Promise.all([
      resolveProfile('user-a', async () => 'account-a'),
      resolveProfile('user-b', async () => 'account-b'),
    ])).toEqual(['account-a', 'account-b']);
  });

  it('parses cached user profiles safely and rejects malformed payloads', () => {
    expect(parseCachedUserProfile(null)).toBeNull();
    expect(parseCachedUserProfile('{bad-json')).toBeNull();
    expect(parseCachedUserProfile('[]')).toBeNull();

    const parsed = parseCachedUserProfile(JSON.stringify({
      accountId: 'acc-1',
      branchId: 'b-2',
      profileBranchId: null,
      hasExplicitAccountId: true,
      role: 'manager',
      allBranchesAccess: true,
      customPermissions: { granted: ['view_reports', 42], revoked: ['modify_price'] },
      isActive: true,
      isSuperAdmin: true,
      displayName: 'Ana',
      cachedAt: 12345,
    }));

    expect(parsed).toEqual({
      accountId: 'acc-1',
      branchId: 'b-2',
      profileBranchId: null,
      hasExplicitAccountId: true,
      role: 'manager',
      allBranchesAccess: true,
      customPermissions: { granted: ['view_reports'], revoked: ['modify_price'] },
      isActive: true,
      isSuperAdmin: true,
      displayName: 'Ana',
      photoURL: null,
      email: null,
      cachedAt: 12345,
    });
  });

  it('diffs cached profiles accurately so unchanged snapshots skip redundant writes', () => {
    const base = {
      accountId: 'acc-1',
      branchId: 'b-1',
      profileBranchId: null,
      hasExplicitAccountId: true,
      role: 'owner' as const,
      allBranchesAccess: true,
      customPermissions: { granted: ['view_margins'], revoked: [] },
      isActive: true,
      isSuperAdmin: false,
      displayName: 'Owner',
      photoURL: null,
      email: 'owner@test.com',
    };

    expect(areCachedProfilesEqual(base, {
      ...base,
      customPermissions: { granted: ['view_margins'], revoked: [] },
    })).toBe(true);

    expect(areCachedProfilesEqual(base, { ...base, isActive: false })).toBe(false);
    expect(areCachedProfilesEqual(base, { ...base, role: 'admin' })).toBe(false);
    expect(areCachedProfilesEqual(base, {
      ...base,
      customPermissions: { granted: ['view_margins', 'manage_users'], revoked: [] },
    })).toBe(false);
  });

  it('resolves optimistic branchId respecting multi-branch selection and account scope', () => {
    expect(resolveOptimisticBranchId({
      role: 'owner',
      allBranchesAccess: true,
      accountId: 'acc-1',
      profileBranchId: null,
      storedBranchId: 'b-2',
      storedAccountId: 'acc-1',
    })).toBe('b-2');

    // Cross-account stored branch must not leak into another account
    expect(resolveOptimisticBranchId({
      role: 'owner',
      allBranchesAccess: true,
      accountId: 'acc-2',
      profileBranchId: 'b-default',
      storedBranchId: 'b-other-account',
      storedAccountId: 'acc-1',
    })).toBe('b-default');

    // Single-branch cashier stays locked to profileBranchId
    expect(resolveOptimisticBranchId({
      role: 'cashier',
      allBranchesAccess: false,
      accountId: 'acc-1',
      profileBranchId: 'b-assigned',
      storedBranchId: 'b-other',
      storedAccountId: 'acc-1',
    })).toBe('b-assigned');
  });

  it('allows optimistic plan access within 72h (>6h) only when non-blocked', () => {
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    const twentyFourHoursAgo = now - 24 * 3600000;
    const seventyThreeHoursAgo = now - (PLAN_CACHE_OFFLINE_TTL_MS + 3600000);

    const validPlanRaw = JSON.stringify({
      limits: { users: { current: 1, max: 5, type: 'hard' } },
      subscription: { status: 'active' },
      cachedAt: twentyFourHoursAgo,
    });
    const parsedValid = parseCachedPlan(validPlanRaw);
    expect(evaluateCachedPlanAccess({
      cached: parsedValid,
      isActive: true,
      isSuperAdmin: false,
      now,
    })).toMatchObject({
      usableOptimistic: true,
      within72h: true,
      blockReason: null,
    });

    // Expired > 72h cache must block optimistic unlock
    expect(evaluateCachedPlanAccess({
      cached: { limits: null, subscription: { status: 'active' }, cachedAt: seventyThreeHoursAgo },
      isActive: true,
      isSuperAdmin: false,
      now,
    })).toMatchObject({
      usableOptimistic: false,
      within72h: false,
    });

    // Blocked cached subscription (cancelled / inactive user) must NEVER skip verification
    expect(evaluateCachedPlanAccess({
      cached: { limits: null, subscription: { status: 'cancelled' }, cachedAt: twentyFourHoursAgo },
      isActive: true,
      isSuperAdmin: false,
      now,
    })).toMatchObject({
      usableOptimistic: false,
      within72h: true,
      blockReason: 'cancelled_subscription',
    });

    expect(evaluateCachedPlanAccess({
      cached: parsedValid,
      isActive: false,
      isSuperAdmin: false,
      now,
    })).toMatchObject({
      usableOptimistic: false,
      within72h: true,
      blockReason: 'inactive_user',
    });
  });

  it('throttles foreground plan re-checks to 5 minutes unless currently blocked', () => {
    const t0 = 1_000_000;
    expect(shouldRecheckAccessOnForeground({ isBlocked: false, lastCheckAt: 0, now: t0 })).toBe(true);
    expect(shouldRecheckAccessOnForeground({
      isBlocked: false,
      lastCheckAt: t0,
      now: t0 + FOREGROUND_ACCESS_RECHECK_MS - 1,
    })).toBe(false);
    expect(shouldRecheckAccessOnForeground({
      isBlocked: false,
      lastCheckAt: t0,
      now: t0 + FOREGROUND_ACCESS_RECHECK_MS,
    })).toBe(true);
    expect(shouldRecheckAccessOnForeground({
      isBlocked: true,
      lastCheckAt: t0,
      now: t0 + 1000,
    })).toBe(true);
  });
});
