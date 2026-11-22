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
  if (options.signal?.aborted) {
    throw new ApiError('Solicitud cancelada.', 499, 'ABORTED');
  }
  if (auth.currentUser?.uid !== user.uid) {
    throw new ApiError('La sesión cambió. Repite la operación.', 409);
  }

  const formDataBody =
    typeof FormData !== 'undefined' && options.body instanceof FormData
      ? options.body
      : null;
  const hasContentType = Object.keys(options.headers || {}).some(
    (key) => key.toLowerCase() === 'content-type'
  );

  const headers: Record<string, string> = {
    ...(options.body !== undefined && !formDataBody && !hasContentType
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
    'x-ventify-client': VENTIFY_CLIENT_HEADER,
  };

  const init: RequestInit = {
    method: options.method || 'GET',
    headers,
    ...(options.body !== undefined
      ? { body: formDataBody ?? JSON.stringify(options.body) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  return {
    url: `${APP_URL.replace(/\/$/, '')}${path}`,
    init,
    uid: user.uid,
  };
}

interface RawRequestContext {
  response: Response;
  controller: AbortController;
  wasTimedOut: () => boolean;
  wasExternallyAborted: () => boolean;
  cleanup: () => void;
}

async function apiRawRequestWithCleanup(
  path: string,
  options: ApiOptions = {}
): Promise<RawRequestContext> {
  const prepared = await getApiRequestInit(path, options);
  const controller = new AbortController();
  const effectiveTimeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  let timedOut = false;
  let externallyAborted = false;

  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      externallyAborted = true;
      controller.abort();
    } else {
      options.signal.addEventListener?.('abort', onExternalAbort, { once: true });
    }
  }

  const timeout =
    effectiveTimeoutMs > 0 && Number.isFinite(effectiveTimeoutMs)
      ? setTimeout(() => {
          if (!controller.signal.aborted) {
            timedOut = true;
            controller.abort();
          }
        }, effectiveTimeoutMs)
      : null;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timeout !== null) clearTimeout(timeout);
    options.signal?.removeEventListener?.('abort', onExternalAbort);
  };

  try {
    const response = await fetch(prepared.url, {
      ...prepared.init,
      signal: controller.signal,
    });
    if (auth.currentUser?.uid !== prepared.uid) {
      throw new ApiError('La sesión cambió. Repite la operación.', 409);
    }
    if (!response.ok) {
      const body = await parseJsonWithinSignal(response, controller.signal);
      if (externallyAborted && !timedOut) {
        throw new ApiError('Solicitud cancelada.', 499, 'ABORTED');
      }
      if (timedOut || controller.signal.aborted) {
        throw new ApiError('El servidor tardó demasiado. Vuelve a intentarlo.', 408);
      }
      const parsedBody = body as { error?: string; message?: string; code?: string } | null;
      throw new ApiError(
        parsedBody?.error || parsedBody?.message || 'No se pudo completar la operación.',
        response.status,
        parsedBody?.code
      );
    }
    return {
      response,
      controller,
      wasTimedOut: () => timedOut,
      wasExternallyAborted: () => externallyAborted,
      cleanup,
    };
  } catch (error) {
    cleanup();
    if (externallyAborted && !timedOut) {
      throw new ApiError('Solicitud cancelada.', 499, 'ABORTED');
    }
    if (timedOut || controller.signal.aborted) {
      throw new ApiError('El servidor tardó demasiado. Vuelve a intentarlo.', 408);
    }
    throw error;
  }
}

function parseJsonWithinSignal(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error('aborted'));
    };
    signal.addEventListener?.('abort', onAbort, { once: true });
    response
      .json()
      .then(
        (parsed) => {
          signal.removeEventListener?.('abort', onAbort);
          resolve(parsed);
        },
        (err) => {
          signal.removeEventListener?.('abort', onAbort);
          if (signal.aborted) {
            reject(err);
          } else {
            resolve(null);
          }
        }
      );
  });
}

/** Executes an authenticated backend request and returns the raw Response without consuming the body (e.g. SSE). */
export async function apiRawRequest(
  path: string,
  options: ApiOptions = {}
): Promise<Response> {
  const { response, cleanup } = await apiRawRequestWithCleanup(path, options);
  cleanup();
  return response;
}

/** Firebase identity and server validation are shared with the web APIs. */
export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { response, controller, wasTimedOut, wasExternallyAborted, cleanup } =
    await apiRawRequestWithCleanup(path, options);
  try {
    const body = await parseJsonWithinSignal(response, controller.signal);
    if (wasExternallyAborted() && !wasTimedOut()) {
      throw new ApiError('Solicitud cancelada.', 499, 'ABORTED');
    }
    if (wasTimedOut() || controller.signal.aborted) {
      throw new ApiError('El servidor tardó demasiado. Vuelve a intentarlo.', 408);
    }
    if (body === null && response.status !== 204) {
      throw new ApiError('El servidor devolvió una respuesta inválida.', 502);
    }
    return body as T;
  } catch (error) {
    if (wasExternallyAborted() && !wasTimedOut()) {
      throw new ApiError('Solicitud cancelada.', 499, 'ABORTED');
    }
    if (wasTimedOut() || controller.signal.aborted) {
      throw new ApiError('El servidor tardó demasiado. Vuelve a intentarlo.', 408);
    }
    throw error;
  } finally {
    cleanup();
  }
}
