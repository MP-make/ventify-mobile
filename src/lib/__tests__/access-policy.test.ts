import { describe, expect, it } from 'vitest';
import { accessBlockReason, profilePermissions, liveProfileAccount } from '../access-policy';

describe('business access parity with web', () => {
  const now = Date.UTC(2026, 10, 11, 12);
  it('revokes business access immediately for an inactive live profile', () => {
    expect(accessBlockReason({ isActive: false }, { status: 'active' }, now)).toBe('inactive_user');
  });
  it('keeps the same active/trialing renewal-date policy as web', () => {
    expect(accessBlockReason({}, { status: 'active', daysRemaining: 0 }, now)).toBeNull();
    expect(accessBlockReason({}, { status: 'trialing', daysRemaining: 0 }, now)).toBeNull();
  });
  it('honors both cancellation spellings and explicit expiry', () => {
    for (const status of ['canceled', 'cancelled']) expect(accessBlockReason({}, { status }, now)).toBe('cancelled_subscription');
    expect(accessBlockReason({}, { status: 'expired' }, now)).toBe('expired_subscription');
  });
  it('enforces the 48h pause grace at the boundary and immediate suspension', () => {
    expect(accessBlockReason({}, { status: 'paused', pausedAt: now - 47 * 3600000 }, now)).toBeNull();
    expect(accessBlockReason({}, { status: 'paused', pausedAt: now - 48 * 3600000 }, now)).toBe('paused_subscription');
    expect(accessBlockReason({}, { status: 'paused', pausedAt: now, graceMode: 'immediate' }, now)).toBe('paused_subscription');
    expect(accessBlockReason({}, { status: 'paused' }, now)).toBe('paused_subscription');
  });
  it('preserves a legacy owner account fallback but revokes a removed explicit assignment', () => {
    expect(liveProfileAccount(undefined, 'owner-account', false)).toBe('owner-account');
    expect(liveProfileAccount(undefined, 'owner-account', true)).toBeNull();
    expect(liveProfileAccount('new-account', 'owner-account', true)).toBe('new-account');
  });
  it('clears removed custom permissions instead of retaining a prior grant', () => {
    expect(profilePermissions({ customPermissions: { granted: ['manage_products'] } })).toEqual({ granted: ['manage_products'], revoked: [] });
    expect(profilePermissions({})).toBeNull();
    expect(profilePermissions({ customPermissions: null })).toBeNull();
  });
});
