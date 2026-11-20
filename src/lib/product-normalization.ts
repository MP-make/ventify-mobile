import type { PriceTier } from '@/types';

const roundToCents = (value: number): number => {
  const n = Number(value) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/** Detecta URIs locales del dispositivo que nunca deben persistirse crudas en Firestore. */
export const isLocalFileUri = (uri?: string | null): boolean => {
  if (!uri || typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return (
    /^(file|content|ph|assets-library):\/\//i.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('data:')
  );
};

/** Filtra galería conservando únicamente URLs remotas válidas. */
export const sanitizeRemoteImageUrls = (urls?: string[] | null): string[] => {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < urls.length; i += 1) {
    const raw = urls[i];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || isLocalFileUri(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

/** Sincroniza campos Web (`minQty`/`price`) y Mobile (`minQuantity`/`unitPrice`) en escalas. */
export const normalizePriceTiers = (tiers?: PriceTier[] | null): PriceTier[] => {
  if (!Array.isArray(tiers) || tiers.length === 0) return [];
  const result: PriceTier[] = [];
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    if (!t) continue;
    const minQuantity = Math.max(1, Math.round(Number(t.minQuantity ?? t.minQty ?? 0)));
    if (minQuantity < 1) continue;
    const unitPrice = roundToCents(Math.max(0, Number(t.unitPrice ?? t.price ?? 0)));
    result.push({
      minQuantity,
      unitPrice,
      minQty: minQuantity,
      price: unitPrice,
    });
  }
  if (result.length > 1) {
    result.sort((a, b) => a.minQuantity - b.minQuantity);
  }
  return result;
};
