import { beforeEach, describe, it, expect, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
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
  DOCUMENT_LOOKUP_CACHE_PREFIX,
  lookupDocument,
  lookupDNI,
  lookupRUC,
  LookupError,
} from '../dni-ruc-service';

describe('DNI / RUC Lookup Service', () => {
  beforeEach(() => {
    storageMock.store.clear();
    vi.clearAllMocks();
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
    expect(storageMock.setItem).toHaveBeenCalledTimes(1);

    const second = await lookupDNI('12345678');
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
  });
});
