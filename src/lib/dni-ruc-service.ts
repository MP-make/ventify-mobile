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
const MAX_MEMORY_CACHE_ENTRIES = 300;
const LOOKUP_TIMEOUT_MS = 12000;

interface CachedDocumentEntry {
  result: DocumentLookupResult;
  cachedAt: number;
}

const memoryCache = new Map<string, CachedDocumentEntry>();
const inFlightLookups = new Map<string, Promise<DocumentLookupResult>>();

/** Clears the in-memory L1 LRU cache for document lookups. */
export function clearDocumentLookupMemoryCache(): void {
  memoryCache.clear();
}

function getFromMemoryCache(storageKey: string): DocumentLookupResult | null {
  const entry = memoryCache.get(storageKey);
  if (!entry) return null;
  if (!Number.isFinite(entry.cachedAt) || Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
    memoryCache.delete(storageKey);
    return null;
  }
  memoryCache.delete(storageKey);
  memoryCache.set(storageKey, entry);
  return entry.result;
}

function setInMemoryCache(
  storageKey: string,
  result: DocumentLookupResult,
  cachedAt: number
): void {
  if (memoryCache.has(storageKey)) {
    memoryCache.delete(storageKey);
  } else if (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey);
    }
  }
  memoryCache.set(storageKey, { result, cachedAt });
}

function deleteFromStorageNonBlocking(storageKey: string): void {
  try {
    Promise.resolve(AsyncStorage?.removeItem?.(storageKey)).catch(() => {});
  } catch {
    // Non-blocking
  }
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw new LookupError('Consulta cancelada', 'ABORTED');
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new LookupError('Consulta cancelada', 'ABORTED'));
    };
    signal.addEventListener?.('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener?.('abort', onAbort);
    }
  }
}

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

async function executeDocumentFetch(
  cleanType: 'dni' | 'ruc',
  cleanNumber: string,
  storageKey: string
): Promise<DocumentLookupResult> {
  // Query Ventify Backend API with its own timeout controller (shared across concurrent callers)
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
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LOOKUP_TIMEOUT_MS);

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
    if (timedOut || err?.name === 'AbortError') {
      throw new LookupError('La consulta superó el tiempo límite (timeout)', 'TIMEOUT');
    }
    throw new LookupError(
      `No se pudo conectar con el servicio de consulta: ${err?.message || 'Error de red'}`,
      'NETWORK_ERROR'
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // Normalize API Payload
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

  // Populate L1 LRU and save to AsyncStorage Cache non-blockingly
  const cachedAt = Date.now();
  setInMemoryCache(storageKey, result, cachedAt);
  try {
    Promise.resolve(
      AsyncStorage?.setItem?.(storageKey, JSON.stringify({ result, cachedAt }))
    ).catch((e) => console.warn('[dni-ruc-service] AsyncStorage cache write skipped:', e));
  } catch {
    // Non-blocking
  }

  return result;
}

// ============================================================================
// 2. MAIN LOOKUP FUNCTION
// ============================================================================

/**
 * Consults DNI (RENIEC) or RUC (SUNAT).
 * 1. Validates document format & Modulo 11 for RUC.
 * 2. Checks bounded L1 memory LRU cache and AsyncStorage cache (`@ventify_doc_lookup_${type}_${number}`, 30-day TTL).
 * 3. Deduplicates concurrent in-flight network queries for the same document and queries
 *    `${APP_URL}/api/dni-ruc/lookup?type=${type}&number=${number}` with Firebase Auth Bearer token.
 * 4. Caches successful result in memory and AsyncStorage and returns normalized entity.
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

  // 1. Check L1 LRU memory cache
  const memoryHit = getFromMemoryCache(storageKey);
  if (memoryHit) {
    return memoryHit;
  }

  // 2. Check AsyncStorage Cache
  try {
    const rawCache = await AsyncStorage?.getItem?.(storageKey);
    if (rawCache) {
      const parsed = JSON.parse(rawCache) as {
        result?: DocumentLookupResult;
        cachedAt?: number;
      };
      const cachedAt = Number(parsed?.cachedAt);
      if (
        parsed?.result &&
        parsed?.cachedAt &&
        Number.isFinite(cachedAt) &&
        Date.now() - cachedAt < CACHE_TTL_MS
      ) {
        setInMemoryCache(storageKey, parsed.result, cachedAt);
        return parsed.result;
      }
      memoryCache.delete(storageKey);
      deleteFromStorageNonBlocking(storageKey);
    }
  } catch {
    // Non-fatal: proceed to backend query if cache read fails
  }

  if (options?.signal?.aborted) {
    throw new LookupError('Consulta cancelada', 'ABORTED');
  }

  // 3. Check/join in-flight lookup or start a shared fetch
  let lookupPromise = inFlightLookups.get(storageKey);
  if (!lookupPromise) {
    const createdPromise = executeDocumentFetch(cleanType, cleanNumber, storageKey).finally(() => {
      if (inFlightLookups.get(storageKey) === createdPromise) {
        inFlightLookups.delete(storageKey);
      }
    });
    createdPromise.catch(() => {});
    inFlightLookups.set(storageKey, createdPromise);
    lookupPromise = createdPromise;
  }

  return awaitWithSignal(lookupPromise, options?.signal);
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
