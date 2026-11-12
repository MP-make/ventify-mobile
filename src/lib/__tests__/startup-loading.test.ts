import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('firebase/firestore', () => ({ onSnapshot: mocks.listen }));
import { subscribeLiveDocument } from '../live-document';
import { createProfileResolutionGate, loadIdentitySources } from '../auth-startup';

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
});
