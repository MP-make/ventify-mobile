import { APP_URL, auth } from '@/lib/firebase';

export const VENTIFY_CLIENT_HEADER = 'v3';
export const DEFAULT_API_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface PreparedApiRequest {
  url: string;
  init: RequestInit;
  uid: string;
}

/** Builds authenticated URL and RequestInit with `x-ventify-client: v3` for JSON or SSE streaming calls. */
export async function getApiRequestInit(
  path: string,
  options: ApiOptions = {}
): Promise<PreparedApiRequest> {
  if (!path.startsWith('/api/') || path.startsWith('//')) {
    throw new ApiError('Ruta de API inválida.', 400);
  }
  const user = auth.currentUser;
  if (!user) {
    throw new ApiError('Inicia sesión para continuar.', 401);
  }
  const token = await user.getIdToken();
  if (auth.currentUser?.uid !== user.uid) {
    throw new ApiError('La sesión cambió. Repite la operación.', 409);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
    'x-ventify-client': VENTIFY_CLIENT_HEADER,
  };

  const init: RequestInit = {
    method: options.method || 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  return {
    url: `${APP_URL.replace(/\/$/, '')}${path}`,
    init,
    uid: user.uid,
  };
}

/** Executes an authenticated backend request and returns the raw Response without consuming the body (e.g. SSE). */
export async function apiRawRequest(
  path: string,
  options: ApiOptions = {}
): Promise<Response> {
  const prepared = await getApiRequestInit(path, options);
  const controller = new AbortController();
  const effectiveTimeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const timeout =
    options.signal || effectiveTimeoutMs <= 0 || !Number.isFinite(effectiveTimeoutMs)
      ? null
      : setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    const response = await fetch(prepared.url, {
      ...prepared.init,
      signal: options.signal || controller.signal,
    });
    if (auth.currentUser?.uid !== prepared.uid) {
      throw new ApiError('La sesión cambió. Repite la operación.', 409);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(
        body?.error || body?.message || 'No se pudo completar la operación.',
        response.status,
        body?.code
      );
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError('El servidor tardó demasiado. Vuelve a intentarlo.', 408);
    }
    throw error;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

/** Firebase identity and server validation are shared with the web APIs. */
export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await apiRawRequest(path, options);
  const body = await response.json().catch(() => null);
  if (body === null && response.status !== 204) {
    throw new ApiError('El servidor devolvió una respuesta inválida.', 502);
  }
  return body as T;
}
