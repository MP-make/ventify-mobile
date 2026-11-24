import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type Firestore,
} from 'firebase/firestore';
import { withTimeout } from '@/lib/online-guard';

export const PRODUCTS_REST_PAGE_SIZE = 250;

const DEFAULT_REST_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MESSAGE = 'Tiempo de espera agotado al sincronizar productos.';

export interface RestProductDocSnap {
  id: string;
  name: string;
  data: () => Record<string, any>;
}

export class FirestoreRestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'FirestoreRestError';
  }
}

export interface FetchProductsPageViaRestParams {
  projectId: string;
  accountId: string;
  idToken: string;
  pageSize?: number;
  startAfterDocName?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchProductsPageViaSdkParams {
  db: Firestore;
  accountId: string;
  pageSize?: number;
  startAfterDocId?: string | null;
}

function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === 'string' && reason ? reason : 'The operation was aborted.';
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** Decodes a single Cloud Firestore v1 REST `Value` object into a plain JS value. */
export function decodeFirestoreValue(raw: unknown): unknown {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;

  if ('nullValue' in obj) {
    return null;
  }
  if (typeof obj.stringValue === 'string') {
    return obj.stringValue;
  }
  if (typeof obj.booleanValue === 'boolean') {
    return obj.booleanValue;
  }
  if ('integerValue' in obj && obj.integerValue !== undefined) {
    return Number(obj.integerValue);
  }
  if ('doubleValue' in obj && obj.doubleValue !== undefined) {
    return Number(obj.doubleValue);
  }
  if (typeof obj.timestampValue === 'string') {
    const ms = Date.parse(obj.timestampValue);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof obj.referenceValue === 'string') {
    return obj.referenceValue;
  }
  if (typeof obj.bytesValue === 'string') {
    return obj.bytesValue;
  }
  if (obj.geoPointValue && typeof obj.geoPointValue === 'object') {
    const gp = obj.geoPointValue as { latitude?: unknown; longitude?: unknown };
    return {
      latitude: typeof gp.latitude === 'number' ? gp.latitude : Number(gp.latitude ?? 0),
      longitude: typeof gp.longitude === 'number' ? gp.longitude : Number(gp.longitude ?? 0),
    };
  }
  if (obj.arrayValue && typeof obj.arrayValue === 'object') {
    const arr = obj.arrayValue as { values?: unknown[] };
    return Array.isArray(arr.values) ? arr.values.map(decodeFirestoreValue) : [];
  }
  if (obj.mapValue && typeof obj.mapValue === 'object') {
    const map = obj.mapValue as { fields?: Record<string, unknown> };
    const out: Record<string, unknown> = {};
    if (map.fields && typeof map.fields === 'object') {
      for (const [key, val] of Object.entries(map.fields)) {
        const decoded = decodeFirestoreValue(val);
        if (decoded !== undefined) {
          out[key] = decoded;
        }
      }
    }
    return out;
  }

  return undefined;
}

/** Decodes a Firestore REST `Document` into a `RestProductDocSnap`, or `null` if invalid. */
export function decodeFirestoreDocument(
  doc: { name?: string; fields?: Record<string, unknown> } | null | undefined
): RestProductDocSnap | null {
  const name = doc?.name;
  const id = name ? name.split('/').pop() : undefined;
  if (!name || !id) {
    return null;
  }

  const decoded =
    (decodeFirestoreValue({ mapValue: { fields: doc.fields ?? {} } }) as Record<string, any>) ?? {};

  return {
    id,
    name,
    data: () => decoded,
  };
}

/** Fetches one paginated slice of `products` for an account via the Firestore v1 REST `runQuery` endpoint. */
export async function fetchProductsPageViaRest(params: FetchProductsPageViaRestParams) {
  const effectivePageSize = Math.max(1, params.pageSize ?? PRODUCTS_REST_PAGE_SIZE);
  const timeoutMs = params.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
  const fetchFn = params.fetchImpl ?? fetch;

  if (params.signal?.aborted) {
    throw toAbortError(params.signal.reason);
  }

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: 'products' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'accountId' },
        op: 'EQUAL',
        value: { stringValue: params.accountId },
      },
    },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: effectivePageSize,
  };

  if (params.startAfterDocName) {
    structuredQuery.startAt = {
      values: [{ referenceValue: params.startAfterDocName }],
      before: false,
    };
  }

  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    params.projectId
  )}/databases/(default)/documents:runQuery`;

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort(params.signal?.reason);
  };

  if (params.signal) {
    params.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let rows: Array<{ document?: { name?: string; fields?: Record<string, unknown> } }> = [];
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new FirestoreRestError(`Firestore REST runQuery HTTP ${response.status}`, response.status);
    }

    const parsed = await response.json();
    if (Array.isArray(parsed)) {
      rows = parsed;
    }
  } catch (error) {
    if (externallyAborted || params.signal?.aborted) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw toAbortError(params.signal?.reason);
    }
    if (timedOut) {
      throw new Error(SYNC_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onExternalAbort);
  }

  const docs: RestProductDocSnap[] = [];
  for (const row of rows) {
    const snap = decodeFirestoreDocument(row?.document);
    if (snap) {
      docs.push(snap);
    }
  }

  return {
    docs,
    lastDocName: docs.length > 0 ? docs[docs.length - 1].name : null,
    hasMore: docs.length >= effectivePageSize,
  };
}

/** Fetches one paginated slice of `products` for an account via the Firestore Web SDK as a fallback. */
export async function fetchProductsPageViaSdkFallback(params: FetchProductsPageViaSdkParams) {
  const effectivePageSize = Math.max(1, params.pageSize ?? PRODUCTS_REST_PAGE_SIZE);
  const q = query(
    collection(params.db, 'products'),
    where('accountId', '==', params.accountId),
    orderBy(documentId()),
    ...(params.startAfterDocId ? [startAfter(params.startAfterDocId)] : []),
    limit(effectivePageSize)
  );

  const snap = await withTimeout(getDocs(q), DEFAULT_REST_TIMEOUT_MS, SYNC_TIMEOUT_MESSAGE);
  return {
    docs: snap.docs,
    lastDocId: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1].id : null,
    hasMore: snap.docs.length >= effectivePageSize,
  };
}
