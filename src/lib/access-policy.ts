export interface SubscriptionAccess {
  status: string;
  daysRemaining?: number;
  pausedAt?: number | null;
  graceMode?: string;
}

export type AccessBlockReason = 'inactive_user' | 'paused_subscription' | 'expired_subscription' | 'cancelled_subscription';

/** Same status and pause-grace policy as the web UserStatusGuard. */
export function accessBlockReason(
  profile: { isActive?: boolean; isSuperAdmin?: boolean },
  subscription: SubscriptionAccess | null,
  now = Date.now(),
): AccessBlockReason | null {
  if (profile.isSuperAdmin) return null;
  if (profile.isActive === false) return 'inactive_user';
  if (!subscription) return null;
  if (subscription.status === 'paused') {
    const pausedAt = Number(subscription.pausedAt) || 0;
    return subscription.graceMode === 'immediate' || !pausedAt || now - pausedAt >= 48 * 3600000
      ? 'paused_subscription' : null;
  }
  if (['canceled', 'cancelled'].includes(subscription.status)) return 'cancelled_subscription';
  if (subscription.status === 'expired' || (
    !['active', 'trialing'].includes(subscription.status) &&
    typeof subscription.daysRemaining === 'number' && subscription.daysRemaining !== -1 && subscription.daysRemaining <= 0
  )) return 'expired_subscription';
  return null;
}

export function profilePermissions(data: { customPermissions?: { granted?: string[]; revoked?: string[] } | null }) {
  if (!data.customPermissions) return null;
  return { granted: data.customPermissions.granted || [], revoked: data.customPermissions.revoked || [] };
}

/** Owners with legacy profiles may resolve their account through claims/ownership.
 * An explicit assignment that is later removed must still revoke that account. */
export function liveProfileAccount(profileAccount: string | undefined, resolvedAccount: string | null, hasSeenExplicitAccount: boolean): string | null {
  return profileAccount || (hasSeenExplicitAccount ? null : resolvedAccount);
}
