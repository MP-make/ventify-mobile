import { db, auth } from '@/lib/firebase';
import { withTimeout } from '@/lib/online-guard';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

export const GLOBAL_CATALOG_COLLECTION = 'global_catalog';

const MAX_CACHE_ENTRIES = 200;
const HIT_TTL_MS = 30 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const MAX_REMOTE_LOOKUPS_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const FORCE_REFRESH_COOLDOWN_MS = 1500;
const FIRESTORE_TIMEOUT_MS = 4000;
const OFF_TIMEOUT_MS = 2200;

export interface GlobalProduct {
  barcode: string;
  name: string;
  imageUrl?: string;
  category?: string;
  unitOfMeasure?: string;
  source: 'ventify' | 'openfoodfacts';
  updatedAt?: any;
  contributedByAccount?: string;
}

export interface GlobalProductContribution {
  barcode: string;
  name: string;
  imageUrl?: string;
  category?: string;
  unitOfMeasure?: string;
  accountId: string;
}

export interface LookupGlobalProductOptions {
  forceRefresh?: boolean;
  allowNetwork?: boolean;
}

export type LookupGlobalProductStatus =
  | 'found'
  | 'not_found'
  | 'invalid'
  | 'offline'
  | 'rate_limited'
  | 'error';

export interface LookupGlobalProductOutcome {
  product: GlobalProduct | null;
  status: LookupGlobalProductStatus;
  fromCache?: boolean;
}

interface CacheEntry {
  product: GlobalProduct | null;
  expiresAt: number;
  fetchedAt: number;
}

const catalogCache = new Map<string, CacheEntry>();
const inFlightLookups = new Map<string, Promise<LookupGlobalProductOutcome>>();
let remoteLookupTimestamps: number[] = [];

/**
 * Valida y normaliza códigos de barras antes de consultar Firestore (`doc(db, 'global_catalog', id)`).
 * Previene lecturas con prefijos inválidos, espacios o caracteres `/` de path traversal.
 */
export function sanitizeGlobalCatalogBarcode(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim();
  if (clean.length < 3 || clean.length > 64) return null;
  if (clean === '.' || clean === '..') return null;
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) return null;
  return clean;
}

/**
 * Permite únicamente URLs remotas seguras (`https://`) para miniaturas del catálogo global.
 * Actualiza URLs HTTP heredadas de Open Food Facts a HTTPS para compatibilidad con Android release.
 */
export function sanitizeCatalogImageUrl(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;

  let normalized = trimmed;
  if (/^http:\/\/images\.openfoodfacts\.org\//i.test(normalized)) {
    normalized = `https://images.openfoodfacts.org/${normalized.slice('http://images.openfoodfacts.org/'.length)}`;
  }

  if (!/^https:\/\//i.test(normalized)) {
    return undefined;
  }

  return `https://${normalized.slice(8)}`;
}

/**
 * Traduce unidades del catálogo global/Web al código de unidad del formulario móvil.
 */
export function mapGlobalUnitToMobileUnit(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const norm = raw.trim().toLowerCase();
  if (!norm) return undefined;

  switch (norm) {
    case 'unit':
    case 'und':
    case 'niu':
    case 'unidad':
      return 'NIU';
    case 'kg':
    case 'kgm':
    case 'kilo':
    case 'kilogramo':
      return 'KGM';
    case 'lt':
    case 'ltr':
    case 'l':
    case 'litro':
    case 'litros':
      return 'LTR';
    case 'box':
    case 'bx':
    case 'caja':
      return 'BX';
    case 'g':
    case 'gr':
    case 'grm':
    case 'gramo':
    case 'gramos':
      return 'g';
    case 'm':
    case 'mtr':
    case 'metro':
    case 'metros':
      return 'm';
    default:
      return undefined;
  }
}

/**
 * Traduce el código de unidad móvil al formato canónico usado por Ventify Web en `global_catalog`.
 */
export function mapMobileUnitToGlobalUnit(raw?: string | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  switch (trimmed.toUpperCase()) {
    case 'NIU':
    case 'UNIT':
    case 'UND':
      return 'unit';
    case 'KGM':
    case 'KG':
      return 'kg';
    case 'LTR':
    case 'LT':
      return 'lt';
    case 'BX':
    case 'BOX':
      return 'box';
    case 'G':
      return 'g';
    case 'M':
      return 'm';
    default:
      return trimmed.toLowerCase();
  }
}

function setCacheEntry(barcode: string, product: GlobalProduct | null, now = Date.now()): void {
  if (catalogCache.has(barcode)) {
    catalogCache.delete(barcode);
  } else if (catalogCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = catalogCache.keys().next().value;
    if (oldestKey !== undefined) {
      catalogCache.delete(oldestKey);
    }
  }

  catalogCache.set(barcode, {
    product,
    fetchedAt: now,
    expiresAt: now + (product ? HIT_TTL_MS : MISS_TTL_MS),
  });
}

function parseOpenFoodFactsUnit(product: Record<string, any>): string | undefined {
  const unitRaw = `${product.product_quantity_unit || ''} ${product.quantity || ''}`.toLowerCase();
  if (unitRaw.includes('kg') || unitRaw.includes('kilo')) return 'kg';
  if (unitRaw.includes('ml')) return 'ml';
  if (/\b(l|lt|litro|litros)\b/.test(unitRaw) || unitRaw.includes('lt')) return 'lt';
  if (/\b(g|gr|gramo|gramos)\b/.test(unitRaw) && !unitRaw.includes('kg')) return 'g';
  if (unitRaw.includes('pack') || unitRaw.includes('paquete')) return 'pack';
  if (unitRaw.includes('box') || unitRaw.includes('caja')) return 'box';
  return undefined;
}

async function fetchFromOpenFoodFacts(
  cleanBarcode: string
): Promise<{ product: GlobalProduct | null; cleanResponse: boolean }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), OFF_TIMEOUT_MS) : null;

  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(cleanBarcode)}.json?fields=product_name,product_name_es,image_url,quantity,product_quantity_unit`,
      controller ? { signal: controller.signal } : undefined
    );

    if (res.status === 404) {
      return { product: null, cleanResponse: true };
    }
    if (!res.ok) {
      return { product: null, cleanResponse: false };
    }

    const json: any = await res.json();
    if (json?.status === 1 && json?.product) {
      const p = json.product;
      const rawName = p.product_name_es || p.product_name;
      if (typeof rawName === 'string' && rawName.trim()) {
        return {
          product: {
            barcode: cleanBarcode,
            name: rawName.trim(),
            imageUrl: sanitizeCatalogImageUrl(p.image_url),
            unitOfMeasure: parseOpenFoodFactsUnit(p),
            source: 'openfoodfacts',
          },
          cleanResponse: true,
        };
      }
    }

    return { product: null, cleanResponse: true };
  } catch {
    return { product: null, cleanResponse: false };
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

async function executeRemoteLookup(cleanBarcode: string): Promise<LookupGlobalProductOutcome> {
  const isAuthReady = Boolean(auth?.currentUser);
  let hadCleanMiss = false;

  // Paso A: Consultar documento exacto en global_catalog (máx. 1 lectura)
  if (isAuthReady) {
    try {
      const docRef = doc(db, GLOBAL_CATALOG_COLLECTION, cleanBarcode);
      const snapshot = await withTimeout(
        getDoc(docRef),
        FIRESTORE_TIMEOUT_MS,
        'global_catalog_timeout'
      );

      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data && typeof data.name === 'string' && data.name.trim()) {
          const found: GlobalProduct = {
            barcode: cleanBarcode,
            name: data.name.trim(),
            imageUrl: sanitizeCatalogImageUrl(data.imageUrl),
            category:
              typeof data.category === 'string' && data.category.trim()
                ? data.category.trim()
                : undefined,
            unitOfMeasure:
              typeof data.unitOfMeasure === 'string' && data.unitOfMeasure.trim()
                ? data.unitOfMeasure.trim()
                : undefined,
            source: 'ventify',
            updatedAt: data.updatedAt,
            contributedByAccount:
              typeof data.contributedByAccount === 'string' ? data.contributedByAccount : undefined,
          };
          setCacheEntry(cleanBarcode, found);
          return { product: found, status: 'found' };
        }
      }
      hadCleanMiss = true;
    } catch (error) {
      console.warn('[GlobalCatalog] Error consultando global_catalog:', error);
    }
  }

  // Paso B: Fallback acotado en products (límite estricto 3, solo campos públicos)
  if (isAuthReady) {
    try {
      const qBarcode = query(
        collection(db, 'products'),
        where('barcode', '==', cleanBarcode),
        limit(3)
      );
      let productsSnap = await withTimeout(
        getDocs(qBarcode),
        FIRESTORE_TIMEOUT_MS,
        'global_catalog_products_timeout'
      );

      if (productsSnap.empty) {
        const qAlias = query(
          collection(db, 'products'),
          where('barcodes', 'array-contains', cleanBarcode),
          limit(3)
        );
        productsSnap = await withTimeout(
          getDocs(qAlias),
          FIRESTORE_TIMEOUT_MS,
          'global_catalog_alias_timeout'
        );
      }

      if (!productsSnap.empty) {
        let candidate: Record<string, any> | null = null;
        for (const docItem of productsSnap.docs) {
          const pData = typeof docItem.data === 'function' ? docItem.data() : (docItem as any).data;
          if (pData && typeof pData.name === 'string' && pData.name.trim()) {
            if (sanitizeCatalogImageUrl(pData.imageUrl)) {
              candidate = pData;
              break;
            }
            if (!candidate) {
              candidate = pData;
            }
          }
        }

        if (candidate && typeof candidate.name === 'string' && candidate.name.trim()) {
          const found: GlobalProduct = {
            barcode: cleanBarcode,
            name: candidate.name.trim(),
            imageUrl: sanitizeCatalogImageUrl(candidate.imageUrl),
            category:
              typeof candidate.category === 'string' && candidate.category.trim()
                ? candidate.category.trim()
                : undefined,
            unitOfMeasure: mapMobileUnitToGlobalUnit(candidate.unitOfMeasure),
            source: 'ventify',
          };

          // Auto-indexar en global_catalog en segundo plano (sin precios, costos ni stock)
          const indexPayload: Record<string, any> = {
            barcode: cleanBarcode,
            name: found.name,
            imageUrl: found.imageUrl || null,
            category: found.category || null,
            unitOfMeasure: found.unitOfMeasure || null,
            updatedAt: serverTimestamp(),
            contributedByAccount: 'peer_store',
          };
          setDoc(doc(db, GLOBAL_CATALOG_COLLECTION, cleanBarcode), indexPayload, {
            merge: true,
          }).catch(() => {});

          setCacheEntry(cleanBarcode, found);
          return { product: found, status: 'found' };
        }
      }
      hadCleanMiss = true;
    } catch (error) {
      console.warn('[GlobalCatalog] Error consultando fallback en products:', error);
    }
  }

  // Paso C: Fallback secundario en Open Food Facts (0 lecturas Firestore)
  const offResult = await fetchFromOpenFoodFacts(cleanBarcode);
  if (offResult.product) {
    setCacheEntry(cleanBarcode, offResult.product);
    return { product: offResult.product, status: 'found' };
  }
  if (offResult.cleanResponse) {
    hadCleanMiss = true;
  }

  if (hadCleanMiss) {
    setCacheEntry(cleanBarcode, null);
    return { product: null, status: 'not_found' };
  }

  return { product: null, status: 'error' };
}

/**
 * Consulta un código de barras en el catálogo colaborativo global de Ventify con estado detallado.
 * Incluye caché en memoria acotada, deduplicación en vuelo, timeouts y límite de tasa.
 *
 * PRIVACIDAD: Nunca lee ni expone precios, costos, stock ni proveedores.
 */
export async function lookupGlobalProductDetailed(
  barcode: string,
  options: LookupGlobalProductOptions = {}
): Promise<LookupGlobalProductOutcome> {
  const cleanBarcode = sanitizeGlobalCatalogBarcode(barcode);
  if (!cleanBarcode) {
    return { product: null, status: 'invalid' };
  }

  const now = Date.now();
  const cached = catalogCache.get(cleanBarcode);
  if (cached) {
    if (cached.expiresAt > now) {
      const withinCooldown = now - cached.fetchedAt < FORCE_REFRESH_COOLDOWN_MS;
      if (!options.forceRefresh || withinCooldown) {
        return {
          product: cached.product,
          status: cached.product ? 'found' : 'not_found',
          fromCache: true,
        };
      }
    } else {
      catalogCache.delete(cleanBarcode);
    }
  }

  if (options.allowNetwork === false) {
    return { product: null, status: 'offline' };
  }

  const existingInFlight = inFlightLookups.get(cleanBarcode);
  if (existingInFlight) {
    return existingInFlight;
  }

  remoteLookupTimestamps = remoteLookupTimestamps.filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  if (remoteLookupTimestamps.length >= MAX_REMOTE_LOOKUPS_PER_MINUTE) {
    return { product: null, status: 'rate_limited' };
  }
  remoteLookupTimestamps.push(now);

  const lookupPromise = executeRemoteLookup(cleanBarcode).finally(() => {
    inFlightLookups.delete(cleanBarcode);
  });
  inFlightLookups.set(cleanBarcode, lookupPromise);

  return lookupPromise;
}

/**
 * Wrapper compatible con Ventify Web: devuelve el producto encontrado o `null`.
 */
export async function lookupGlobalProduct(
  barcode: string,
  options?: LookupGlobalProductOptions
): Promise<GlobalProduct | null> {
  const outcome = await lookupGlobalProductDetailed(barcode, options);
  return outcome.product;
}

/**
 * Aporta de manera segura la ficha pública de un producto al catálogo global colaborativo.
 * NUNCA incluye precios, costos, stock ni proveedores.
 */
export async function contributeToGlobalCatalog(
  data: GlobalProductContribution
): Promise<boolean> {
  const cleanBarcode = sanitizeGlobalCatalogBarcode(data.barcode);
  const cleanName = typeof data.name === 'string' ? data.name.trim() : '';
  if (!cleanBarcode || cleanName.length < 2) return false;
  if (!auth?.currentUser) return false;

  const imageUrl = sanitizeCatalogImageUrl(data.imageUrl);
  const category =
    typeof data.category === 'string' && data.category.trim() ? data.category.trim() : undefined;
  const unitOfMeasure = mapMobileUnitToGlobalUnit(data.unitOfMeasure);

  const cached = catalogCache.get(cleanBarcode);
  if (cached && cached.expiresAt > Date.now() && cached.product?.source === 'ventify') {
    const existing = cached.product;
    const existingUnit = mapMobileUnitToGlobalUnit(existing.unitOfMeasure);
    if (
      existing.name === cleanName &&
      existing.imageUrl === imageUrl &&
      existing.category === category &&
      existingUnit === unitOfMeasure
    ) {
      return false;
    }
  }

  try {
    const docRef = doc(db, GLOBAL_CATALOG_COLLECTION, cleanBarcode);
    const payload: Record<string, any> = {
      barcode: cleanBarcode,
      name: cleanName,
      updatedAt: serverTimestamp(),
      contributedByAccount: data.accountId || 'unknown',
    };

    if (imageUrl) {
      payload.imageUrl = imageUrl;
    }
    if (category) {
      payload.category = category;
    }
    if (unitOfMeasure) {
      payload.unitOfMeasure = unitOfMeasure;
    }

    await withTimeout(setDoc(docRef, payload, { merge: true }), FIRESTORE_TIMEOUT_MS, 'global_catalog_write_timeout');

    setCacheEntry(cleanBarcode, {
      barcode: cleanBarcode,
      name: cleanName,
      imageUrl,
      category,
      unitOfMeasure,
      source: 'ventify',
      contributedByAccount: data.accountId || 'unknown',
    });

    return true;
  } catch (error) {
    console.warn('[GlobalCatalog] Error aportando al catálogo global:', error);
    return false;
  }
}

/**
 * Limpia la caché en memoria y contadores de tasa (útil al cerrar sesión o en pruebas).
 */
export function clearGlobalCatalogCache(): void {
  catalogCache.clear();
  inFlightLookups.clear();
  remoteLookupTimestamps = [];
}
