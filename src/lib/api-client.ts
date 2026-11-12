import { APP_URL, auth } from '@/lib/firebase';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** Firebase identity and server validation are shared with the web APIs. */
export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new ApiError('Ruta de API inválida.', 400);
  const user = auth.currentUser;
  if (!user) throw new ApiError('Inicia sesión para continuar.', 401);
  const token = await user.getIdToken();
  if (auth.currentUser?.uid !== user.uid) throw new ApiError('La sesión cambió. Repite la operación.', 409);
  const controller = new AbortController();
  const timeout = options.signal ? null : setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${APP_URL.replace(/\/$/, '')}${path}`, {
      method: options.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal || controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (auth.currentUser?.uid !== user.uid) throw new ApiError('La sesión cambió. Repite la operación.', 409);
    if (!response.ok) throw new ApiError(body?.error || body?.message || 'No se pudo completar la operación.', response.status, body?.code);
    if (body === null && response.status !== 204) throw new ApiError('El servidor devolvió una respuesta inválida.', 502);
    return body as T;
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError('El servidor tardó demasiado. Vuelve a intentarlo.', 408);
    throw error;
  } finally { if (timeout !== null) clearTimeout(timeout); }
}
