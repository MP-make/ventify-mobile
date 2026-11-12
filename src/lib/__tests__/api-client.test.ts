import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ user: { uid: 'u1', getIdToken: vi.fn(async () => 'test-token') } as any }));
vi.mock('@/lib/firebase', () => ({ auth: { get currentUser() { return state.user; } }, APP_URL: 'https://example.test' }));
import { apiRequest } from '../api-client';

describe('authenticated backend client', () => {
  beforeEach(() => { state.user = { uid: 'u1', getIdToken: vi.fn(async () => 'test-token') }; vi.unstubAllGlobals(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('times out an unavailable backend so access verification can recover', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))));
    const result = expect(apiRequest('/api/test')).rejects.toMatchObject({status: 408});
    await vi.advanceTimersByTimeAsync(20000);
    await result;
  });
  it('sends a JSON command with Firebase identity to the configured backend', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await apiRequest('/api/test', { method: 'POST', body: { amount: 100 } })).toEqual({ id: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/test', expect.objectContaining({ method: 'POST', body: '{"amount":100}', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }));
  });
  it('does not send a command without an authenticated user', async () => {
    state.user = null; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/api/test')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves the server error and status instead of treating a denied write as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Sin permiso","code":"forbidden"}', { status: 403 })));
    await expect(apiRequest('/api/test')).rejects.toMatchObject({ message: 'Sin permiso', status: 403, code: 'forbidden' });
  });
  it('rejects a response after the account session changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { state.user = { uid: 'u2' }; return new Response('{"private":true}'); }));
    await expect(apiRequest('/api/test')).rejects.toMatchObject({ status: 409 });
  });
});
