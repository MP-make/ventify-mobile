import { beforeEach, describe, it, expect, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storageMock,
}));

vi.mock('@/lib/firebase', () => ({
  auth: {
    currentUser: {
      getIdToken: vi.fn(async () => 'mock-jwt-token'),
    },
  },
  APP_URL: 'https://ventify.com.pe',
}));

import {
  clearDocumentLookupMemoryCache,
  DOCUMENT_LOOKUP_CACHE_PREFIX,
  DOCUMENT_LOOKUP_INDEX_KEY,
  MAX_L2_KEYS,
  lookupDocument,
  lookupDNI,
  lookupRUC,
  LookupError,
} from '../dni-ruc-service';

const flushAsyncQueue = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('DNI / RUC Lookup Service', () => {
  beforeEach(() => {
    clearDocumentLookupMemoryCache();
    storageMock.store.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws INVALID_DNI on bad DNI format', async () => {
    await expect(lookupDNI('12345')).rejects.toThrow('El DNI debe tener 8 dígitos');
  });

  it('throws INVALID_RUC on bad RUC format or invalid Modulo 11', async () => {
    await expect(lookupRUC('12345678901')).rejects.toThrow('no es válido');
  });

  it('throws on unsupported document type', async () => {
    // @ts-expect-error test invalid type
    await expect(lookupDocument('pasaporte', '12345678')).rejects.toThrow('Tipo de documento');
  });

  it('queries backend with x-ventify-client v3 header and serves subsequent lookups from 30-day AsyncStorage cache', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          nombre_completo: 'JUAN CARLOS PEREZ',
          direccion: 'AV. CENTRAL 100',
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await lookupDNI('12345678');
    expect(first.name).toBe('JUAN CARLOS PEREZ');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [_url, fetchOpts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((fetchOpts.headers as Record<string, string>)['x-ventify-client']).toBe('v3');
    expect((fetchOpts.headers as Record<string, string>).Authorization).toBe('Bearer mock-jwt-token');
    expect(storageMock.setItem).toHaveBeenCalledWith(
      `${DOCUMENT_LOOKUP_CACHE_PREFIX}dni_12345678`,
      expect.any(String)
    );
    await flushAsyncQueue();
    expect(storageMock.setItem).toHaveBeenCalledWith(
      DOCUMENT_LOOKUP_INDEX_KEY,
      JSON.stringify([`${DOCUMENT_LOOKUP_CACHE_PREFIX}dni_12345678`])
    );

    // Clear L1 memory cache so second lookup verifies L2 AsyncStorage cache hit
    clearDocumentLookupMemoryCache();
    const second = await lookupDNI('12345678');
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches when AsyncStorage cache entry is older than 30 days and aborts cleanly via AbortSignal', async () => {
    const expiredTs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    storageMock.store.set(
      `${DOCUMENT_LOOKUP_CACHE_PREFIX}ruc_20100070970`,
      JSON.stringify({
        cachedAt: expiredTs,
        result: {
          documentType: 'ruc',
          documentNumber: '20100070970',
          name: 'ANTIGUA SAC',
        },
      })
    );

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          razon_social: 'EMPRESA ACTUALIZADA SAC',
          estado: 'ACTIVO',
          condicion: 'HABIDO',
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await lookupRUC('20100070970');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshed.name).toBe('EMPRESA ACTUALIZADA SAC');

    const controller = new AbortController();
    controller.abort();
    await expect(
      lookupDocument('dni', '87654321', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'LookupError', code: 'ABORTED' } as Partial<LookupError>);
  });

  it('bounds AsyncStorage L2 cache to MAX_L2_KEYS (500) using LRU eviction', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const num = new URL(url).searchParams.get('number') || '00000000';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ nombre_completo: `PERSONA ${num}` }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < MAX_L2_KEYS + 1; i++) {
      const dni = String(10000000 + i);
      await lookupDNI(dni);
    }
    await flushAsyncQueue();

    const oldestKey = `${DOCUMENT_LOOKUP_CACHE_PREFIX}dni_10000000`;
    const secondOldestKey = `${DOCUMENT_LOOKUP_CACHE_PREFIX}dni_10000001`;
    const newestKey = `${DOCUMENT_LOOKUP_CACHE_PREFIX}dni_${10000000 + MAX_L2_KEYS}`;

    expect(storageMock.removeItem).toHaveBeenCalledWith(oldestKey);
    expect(storageMock.store.has(oldestKey)).toBe(false);
    expect(storageMock.store.has(secondOldestKey)).toBe(true);
    expect(storageMock.store.has(newestKey)).toBe(true);

    const rawIndex = storageMock.store.get(DOCUMENT_LOOKUP_INDEX_KEY);
    expect(rawIndex).toBeTruthy();
    const indexKeys = JSON.parse(rawIndex!) as string[];
    expect(indexKeys).toHaveLength(MAX_L2_KEYS);
    expect(indexKeys[0]).toBe(secondOldestKey);
    expect(indexKeys[indexKeys.length - 1]).toBe(newestKey);

    // Promote secondOldestKey via L2 hit, then insert one more -> third oldest should evict
    clearDocumentLookupMemoryCache();
    const hit = await lookupDNI('10000001');
    expect(hit.name).toBe('PERSONA 10000001');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_L2_KEYS + 1);

    await lookupDNI(String(10000000 + MAX_L2_KEYS + 1));
    await flushAsyncQueue();

    const thirdOldestKey = `${DOCUMENT_LOOKUP_CACHE_PREFIX}dni_10000002`;
    expect(storageMock.store.has(secondOldestKey)).toBe(true);
    expect(storageMock.store.has(thirdOldestKey)).toBe(false);
  });

  it('ref-counts concurrent in-flight waiters and aborts shared AbortController only when all callers abort', async () => {
    let resolveFetch!: (res: any) => void;
    let capturedSignals: AbortSignal[] = [];

    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal) {
        capturedSignals.push(init.signal);
      }
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Case 1: Two concurrent callers; one aborts, the other completes the shared fetch
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = lookupDNI('22222222', { signal: c1.signal });
    const p2 = lookupDNI('22222222', { signal: c2.signal });

    await flushAsyncQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignals[0]?.aborted).toBe(false);

    c1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'LookupError', code: 'ABORTED' } as Partial<LookupError>);
    expect(capturedSignals[0]?.aborted).toBe(false);

    resolveFetch({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ nombre_completo: 'MARIA LOPEZ' }),
    });
    const res2 = await p2;
    expect(res2.name).toBe('MARIA LOPEZ');

    // Case 2: Both concurrent callers abort -> shared AbortController aborts when waiter count drops to 0
    capturedSignals = [];
    const d1 = new AbortController();
    const d2 = new AbortController();
    const q1 = lookupDNI('33333333', { signal: d1.signal });
    const q2 = lookupDNI('33333333', { signal: d2.signal });

    await flushAsyncQueue();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(capturedSignals[0]?.aborted).toBe(false);

    d1.abort();
    expect(capturedSignals[0]?.aborted).toBe(false);
    d2.abort();
    expect(capturedSignals[0]?.aborted).toBe(true);

    await expect(q1).rejects.toMatchObject({ name: 'LookupError', code: 'ABORTED' } as Partial<LookupError>);
    await expect(q2).rejects.toMatchObject({ name: 'LookupError', code: 'ABORTED' } as Partial<LookupError>);

    // A fresh lookup afterwards starts a new fetch instead of reusing the aborted entry
    const q3 = lookupDNI('33333333');
    await flushAsyncQueue();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    resolveFetch({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ nombre_completo: 'CARLOS RUIZ' }),
    });
    expect((await q3).name).toBe('CARLOS RUIZ');
  });
});
