/**
 * Ventify Mobile DNI & RUC Lookup Service
 * Multi-layer lookup with AsyncStorage local cache, Firebase Auth JWT validation,
 * and backend lookup with AbortSignal cancellation support.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, APP_URL } from './firebase';
import { isValidDNI, isValidRUC } from './invoicing/types';

// ============================================================================
// 1. TYPES & CONSTANTS
// ============================================================================

export interface DocumentLookupResult {
  documentType: 'dni' | 'ruc';
  documentNumber: string;
  name: string;
  address?: string;
  estado?: string;
  condicion?: string;
  ubigeo?: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
}

export class LookupError extends Error {
  constructor(
    message: string,
    public code: string = 'LOOKUP_ERROR'
  ) {
    super(message);
    this.name = 'LookupError';
  }
}

export const DOCUMENT_LOOKUP_CACHE_PREFIX = '@ventify_doc_lookup_';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cache

// Helper to pick the first non-empty string among candidate keys
function pickValue(obj: Record<string, any>, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

// ============================================================================
// 2. MAIN LOOKUP FUNCTION
// ============================================================================

/**
 * Consults DNI (RENIEC) or RUC (SUNAT).
 * 1. Validates document format & Modulo 11 for RUC.
 * 2. Checks AsyncStorage cache (`@ventify_doc_lookup_${type}_${number}`, 30-day TTL).
 * 3. On cache miss, queries `${APP_URL}/api/dni-ruc/lookup?type=${type}&number=${number}`
 *    attaching the Firebase Auth Bearer token and `x-ventify-client: v3` header.
 * 4. Caches successful result in AsyncStorage and returns normalized entity.
 */
export async function lookupDocument(
  type: 'dni' | 'ruc',
  number: string,
  options?: { signal?: AbortSignal }
): Promise<DocumentLookupResult> {
  const cleanType = type.toLowerCase() as 'dni' | 'ruc';
  const cleanNumber = (number || '').trim().replace(/\D/g, '');

  if (cleanType !== 'dni' && cleanType !== 'ruc') {
    throw new LookupError('Tipo de documento debe ser "dni" o "ruc"', 'INVALID_TYPE');
  }

  // Format validation
  if (cleanType === 'dni') {
    if (!isValidDNI(cleanNumber)) {
      throw new LookupError('El DNI debe tener 8 dígitos numéricos', 'INVALID_DNI');
    }
  } else {
    if (!/^\d{11}$/.test(cleanNumber)) {
      throw new LookupError('El RUC debe tener 11 dígitos numéricos', 'INVALID_RUC');
    }
    if (!isValidRUC(cleanNumber)) {
      throw new LookupError(
        'El RUC no es válido según el dígito verificador de SUNAT',
        'INVALID_RUC'
      );
    }
  }

  if (options?.signal?.aborted) {
    throw new LookupError('Consulta cancelada', 'ABORTED');
  }

  const storageKey = `${DOCUMENT_LOOKUP_CACHE_PREFIX}${cleanType}_${cleanNumber}`;

  // 1. Check AsyncStorage Cache
  try {
    const rawCache = await AsyncStorage?.getItem?.(storageKey);
    if (rawCache) {
      const parsed = JSON.parse(rawCache) as {
        result?: DocumentLookupResult;
        cachedAt?: number;
      };
      if (
        parsed?.result &&
        parsed?.cachedAt &&
        Date.now() - Number(parsed.cachedAt) < CACHE_TTL_MS
      ) {
        return parsed.result;
      }
    }
  } catch {
    // Non-fatal: proceed to backend query if cache read fails
  }

  if (options?.signal?.aborted) {
    throw new LookupError('Consulta cancelada', 'ABORTED');
  }

  // 2. Query Ventify Backend API
  const token = await auth.currentUser?.getIdToken().catch(() => null);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-ventify-client': 'v3',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `${APP_URL}/api/dni-ruc/lookup?type=${cleanType}&number=${cleanNumber}`;

  let responseData: any;
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  options?.signal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 12000); // 12 seconds timeout

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      let errorMsg = `Error del servidor (${res.status})`;
      try {
        const text = await res.text();
        if (text) {
          const errJson = JSON.parse(text);
          if (errJson.error) errorMsg = errJson.error;
        }
      } catch {
        // fallback
      }
      throw new LookupError(errorMsg, res.status === 404 ? 'NOT_FOUND' : 'PROVIDER_ERROR');
    }

    const rawBody = await res.text();
    responseData = rawBody ? JSON.parse(rawBody) : null;
  } catch (err: any) {
    if (err instanceof LookupError) throw err;
    if (externallyAborted || options?.signal?.aborted) {
      throw new LookupError('Consulta cancelada', 'ABORTED');
    }
    if (timedOut || err?.name === 'AbortError') {
      throw new LookupError('La consulta superó el tiempo límite (timeout)', 'TIMEOUT');
    }
    throw new LookupError(
      `No se pudo conectar con el servicio de consulta: ${err?.message || 'Error de red'}`,
      'NETWORK_ERROR'
    );
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener?.('abort', onExternalAbort);
  }

  // 3. Normalize API Payload
  const raw = responseData?.data ?? responseData;
  if (!raw) {
    throw new LookupError('Respuesta vacía del servicio de consulta', 'EMPTY_RESPONSE');
  }

  let normalizedName = '';
  if (cleanType === 'dni') {
    normalizedName =
      pickValue(raw, [
        'name',
        'nombre_completo',
        'nombreCompleto',
        'nombres_completos',
      ]) ||
      [
        pickValue(raw, ['nombres', 'nombre']),
        pickValue(raw, ['apellido_paterno', 'apellidoPaterno']),
        pickValue(raw, ['apellido_materno', 'apellidoMaterno']),
      ]
        .filter(Boolean)
        .join(' ');
  } else {
    normalizedName =
      pickValue(raw, [
        'name',
        'razonSocial',
        'razon_social',
        'nombre',
        'nombre_razon_social',
        'RazonSocial',
      ]) || '';
  }

  if (!normalizedName) {
    throw new LookupError('No se encontró información para el documento consultado', 'NOT_FOUND');
  }

  const result: DocumentLookupResult = {
    documentType: cleanType,
    documentNumber: cleanNumber,
    name: normalizedName,
    address: pickValue(raw, [
      'address',
      'direccion',
      'direccion_completa',
      'domicilioFiscal',
      'domicilio_fiscal',
      'direccion_fiscal',
    ]),
    estado: pickValue(raw, ['estado', 'status']),
    condicion: pickValue(raw, ['condicion', 'condition']),
    ubigeo: pickValue(raw, ['ubigeo', 'ubigeo_sunat', 'codigo_ubigeo']),
    distrito: pickValue(raw, ['distrito', 'district']),
    provincia: pickValue(raw, ['provincia', 'province']),
    departamento: pickValue(raw, ['departamento', 'department', 'region']),
  };

  // 4. Save to AsyncStorage Cache non-blockingly
  try {
    const cleanToStore = JSON.parse(JSON.stringify({ result, cachedAt: Date.now() }));
    Promise.resolve(AsyncStorage?.setItem?.(storageKey, JSON.stringify(cleanToStore))).catch(
      (e) => console.warn('[dni-ruc-service] AsyncStorage cache write skipped:', e)
    );
  } catch {
    // Non-blocking
  }

  return result;
}

/** Convenience shortcut for DNI */
export async function lookupDNI(
  dni: string,
  options?: { signal?: AbortSignal }
): Promise<DocumentLookupResult> {
  return lookupDocument('dni', dni, options);
}

/** Convenience shortcut for RUC */
export async function lookupRUC(
  ruc: string,
  options?: { signal?: AbortSignal }
): Promise<DocumentLookupResult> {
  return lookupDocument('ruc', ruc, options);
}
