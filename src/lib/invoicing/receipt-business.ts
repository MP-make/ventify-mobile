import { uint8ArrayToBase64 } from '@/lib/base64';
import type { Branch, BusinessSettings, PosSettings } from '@/types';

const NESTED_RECEIPT_KEYS = [
  'receiptSettings',
  'ticketSettings',
  'ticketConfig',
  'receiptConfig',
  'receipt',
  'branding',
  'appearance',
] as const;

const LOGO_KEYS = [
  'receiptLogoDataUrl',
  'receiptLogo',
  'receiptLogoUrl',
  'logoDataUrl',
  'logoUrl',
  'logo',
  'companyLogo',
  'businessLogo',
  'brandLogo',
  'ticketLogo',
  'imageUrl',
] as const;

const FOOTER_KEYS = [
  'ticketFooterMessage',
  'receiptFooter',
  'ticketFooter',
  'footerMessage',
  'footerText',
] as const;

const HEADER_KEYS = [
  'receiptHeader',
  'ticketHeader',
  'ticketHeaderMessage',
  'headerMessage',
  'headerText',
] as const;

const DEFAULT_CONSULT_URL = 'https://ventify.com.pe/comprobantes';
const MAX_LOGO_CACHE_ENTRIES = 12;
const LOGO_FETCH_TIMEOUT_MS = 4000;

const printableLogoCache = new Map<string, string>();

type UnknownRecord = Record<string, any>;

const isPlainObject = (val: unknown): val is UnknownRecord =>
  Boolean(val) && typeof val === 'object' && !Array.isArray(val);

const asTrimmedString = (val: unknown): string => {
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' && Number.isFinite(val)) return String(val).trim();
  return '';
};

const expandSourceLayers = (src?: unknown): UnknownRecord[] => {
  if (!isPlainObject(src)) return [];
  const layers: UnknownRecord[] = [src];
  for (let i = 0; i < NESTED_RECEIPT_KEYS.length; i += 1) {
    const nested = src[NESTED_RECEIPT_KEYS[i]];
    if (isPlainObject(nested)) {
      layers.push(nested);
    }
  }
  return layers;
};

const pickFromSource = (src: unknown, keys: readonly string[]): string => {
  const layers = expandSourceLayers(src);
  for (let l = 0; l < layers.length; l += 1) {
    const layer = layers[l];
    for (let k = 0; k < keys.length; k += 1) {
      const val = asTrimmedString(layer[keys[k]]);
      if (val) return val;
    }
  }
  return '';
};

const pickFromSources = (
  sources: ReadonlyArray<{ src: unknown; keys: readonly string[] }>
): string => {
  for (let i = 0; i < sources.length; i += 1) {
    const hit = pickFromSource(sources[i].src, sources[i].keys);
    if (hit) return hit;
  }
  return '';
};

const resolveBoolFlag = (
  sources: ReadonlyArray<unknown>,
  keys: readonly string[],
  defaultValue = true
): boolean => {
  for (let s = 0; s < sources.length; s += 1) {
    const layers = expandSourceLayers(sources[s]);
    for (let l = 0; l < layers.length; l += 1) {
      const layer = layers[l];
      for (let k = 0; k < keys.length; k += 1) {
        const val = layer[keys[k]];
        if (typeof val === 'boolean') return val;
      }
    }
  }
  return defaultValue;
};

/**
 * Acepta exclusivamente URLs http(s) o data URLs de imagen válidas para comprobantes.
 */
export function sanitizeReceiptImageUri(uri?: unknown): string {
  const trimmed = asTrimmedString(uri);
  if (!trimmed) return '';
  if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

const pickLogoFromSources = (sources: ReadonlyArray<unknown>): string => {
  for (let s = 0; s < sources.length; s += 1) {
    const layers = expandSourceLayers(sources[s]);
    for (let l = 0; l < layers.length; l += 1) {
      const layer = layers[l];
      for (let k = 0; k < LOGO_KEYS.length; k += 1) {
        const clean = sanitizeReceiptImageUri(layer[LOGO_KEYS[k]]);
        if (clean) return clean;
      }
    }
  }
  return '';
};

/**
 * Fusiona datos de negocio y sucursal sin permitir que strings vacíos o `undefined`
 * de `branch` borren información real configurada en `business`.
 * Preserva el nombre comercial del negocio separado del nombre de la sucursal.
 */
export function mergeReceiptBusinessAndBranch<
  TBiz extends Partial<BusinessSettings & Branch> | Record<string, any> | null | undefined,
  TBranch extends Partial<Branch> | Record<string, any> | null | undefined
>(business?: TBiz, branch?: TBranch): UnknownRecord {
  const out: UnknownRecord = {};
  if (isPlainObject(business)) {
    for (const [key, val] of Object.entries(business)) {
      if (val === undefined || val === null) continue;
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed) out[key] = trimmed;
      } else {
        out[key] = val;
      }
    }
  }

  if (isPlainObject(branch)) {
    for (const [key, val] of Object.entries(branch)) {
      if (val === undefined || val === null) continue;
      if (key === 'name') {
        const trimmedName = asTrimmedString(val);
        if (trimmedName) {
          out.branchName = trimmedName;
          if (!asTrimmedString(out.businessName) && !asTrimmedString(out.name)) {
            out.name = trimmedName;
          }
        }
        continue;
      }
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed) out[key] = trimmed;
      } else {
        out[key] = val;
      }
    }
  }

  return out;
}

export interface ResolveReceiptBusinessParams {
  business?: Partial<BusinessSettings & Branch> | Record<string, any> | null;
  branch?: Partial<Branch> | Record<string, any> | null;
  posSettings?: Partial<PosSettings> | Record<string, any> | null;
  appearance?: Record<string, any> | null;
  account?: Record<string, any> | null;
  emitter?: Record<string, any> | null;
  receiptFooter?: string | null;
  consultUrl?: string | null;
  ticketTemplate?: 'standard' | 'compact' | string | null;
  saleFooterNote?: string | null;
  defaultFooter?: string;
}

export interface ResolvedReceiptBusiness {
  logoUri: string;
  receiptLogoDataUrl?: string;
  receiptLogo?: string;
  receiptLogoUrl?: string;
  logoUrl?: string;
  businessName: string;
  name: string;
  branchName: string;
  razonSocial: string;
  ruc: string;
  address: string;
  fiscalAddress: string;
  commercialAddress: string;
  phone: string;
  commercialPhone: string;
  email: string;
  website: string;
  slogan: string;
  description: string;
  receiptHeader: string;
  receiptFooter: string;
  hasCustomFooter: boolean;
  consultUrl: string;
  printedFormatResolution: string;
  ticketTemplate: 'standard' | 'compact';
  showLogo: boolean;
  showRuc: boolean;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  showSlogan: boolean;
}

/**
 * Resuelve en orden determinista toda la identidad comercial, fiscal, logo,
 * encabezado y pie de ticket configurados en Ventify Web y móvil.
 */
export function resolveReceiptBusiness(
  params: ResolveReceiptBusinessParams = {}
): ResolvedReceiptBusiness {
  const {
    business,
    branch,
    posSettings,
    appearance,
    account,
    emitter,
    receiptFooter: explicitFooter,
    consultUrl: explicitConsultUrl,
    ticketTemplate: explicitTemplate,
    saleFooterNote,
    defaultFooter = '¡Gracias por su compra!',
  } = params;

  const mergedFallback = mergeReceiptBusinessAndBranch(business, branch);
  const visibilitySources = [branch, business, posSettings, appearance, account];

  const showLogo = resolveBoolFlag(
    visibilitySources,
    ['showLogo', 'showReceiptLogo', 'printLogo'],
    true
  );
  const showRuc = resolveBoolFlag(visibilitySources, ['showRuc', 'showTaxId', 'printRuc'], true);
  const showAddress = resolveBoolFlag(
    visibilitySources,
    ['showAddress', 'showBusinessAddress', 'printAddress'],
    true
  );
  const showPhone = resolveBoolFlag(
    visibilitySources,
    ['showPhone', 'showBusinessPhone', 'printPhone'],
    true
  );
  const showEmail = resolveBoolFlag(visibilitySources, ['showEmail', 'printEmail'], true);
  const showSlogan = resolveBoolFlag(
    visibilitySources,
    ['showSlogan', 'showDescription', 'printSlogan'],
    true
  );

  const rawLogoUri = pickLogoFromSources([
    branch,
    business,
    posSettings,
    appearance,
    emitter,
    account,
  ]);
  const logoUri = showLogo ? rawLogoUri : '';

  const businessName =
    pickFromSources([
      { src: branch, keys: ['commercialName', 'nombreComercial', 'businessName', 'razonSocial'] },
      { src: emitter, keys: ['nombreComercial', 'commercialName', 'razonSocial', 'businessName'] },
      { src: business, keys: ['commercialName', 'nombreComercial', 'businessName', 'razonSocial', 'name'] },
      { src: appearance, keys: ['commercialName', 'businessName', 'name'] },
      { src: account, keys: ['commercialName', 'nombreComercial', 'businessName', 'razonSocial', 'name'] },
      { src: branch, keys: ['name'] },
    ]) || 'Ventify POS';

  const rawBranchName =
    asTrimmedString(branch?.name) || asTrimmedString(mergedFallback.branchName);
  const branchName =
    rawBranchName && rawBranchName.toLowerCase() !== businessName.toLowerCase()
      ? rawBranchName
      : '';

  const razonSocial = pickFromSources([
    { src: branch, keys: ['razonSocial', 'legalName', 'businessName'] },
    { src: emitter, keys: ['razonSocial', 'legalName', 'businessName'] },
    { src: business, keys: ['razonSocial', 'legalName', 'businessName'] },
    { src: account, keys: ['razonSocial', 'legalName', 'businessName'] },
  ]);

  const ruc = pickFromSources([
    { src: branch, keys: ['ruc', 'taxId'] },
    { src: emitter, keys: ['ruc', 'taxId'] },
    { src: business, keys: ['ruc', 'taxId'] },
    { src: account, keys: ['ruc', 'taxId'] },
  ]);

  const fiscalAddress = pickFromSources([
    { src: branch, keys: ['fiscalAddress', 'direccionFiscal', 'address', 'direccion'] },
    { src: business, keys: ['fiscalAddress', 'direccionFiscal', 'address', 'direccion'] },
    { src: emitter, keys: ['fiscalAddress', 'direccionFiscal', 'address', 'direccion'] },
    { src: account, keys: ['fiscalAddress', 'direccionFiscal', 'address', 'direccion'] },
  ]);

  const rawCommercialAddress = pickFromSources([
    { src: branch, keys: ['commercialAddress', 'direccionComercial', 'storeAddress'] },
    { src: business, keys: ['commercialAddress', 'direccionComercial', 'storeAddress'] },
    { src: emitter, keys: ['commercialAddress', 'direccionComercial', 'storeAddress'] },
  ]);
  const commercialAddress =
    rawCommercialAddress &&
    rawCommercialAddress.toLowerCase() !== fiscalAddress.toLowerCase()
      ? rawCommercialAddress
      : '';

  const phone = pickFromSources([
    { src: branch, keys: ['commercialPhone', 'phone', 'telefono', 'whatsapp', 'whatsappNumber'] },
    { src: business, keys: ['commercialPhone', 'phone', 'telefono', 'whatsapp', 'whatsappNumber'] },
    { src: emitter, keys: ['commercialPhone', 'phone', 'telefono'] },
    { src: account, keys: ['commercialPhone', 'phone', 'telefono', 'whatsapp', 'whatsappNumber'] },
  ]);

  const email = pickFromSources([
    { src: branch, keys: ['email', 'correo'] },
    { src: business, keys: ['email', 'correo'] },
    { src: emitter, keys: ['email', 'correo'] },
    { src: account, keys: ['email', 'correo'] },
  ]);

  const website = pickFromSources([
    { src: branch, keys: ['website', 'web', 'siteUrl'] },
    { src: business, keys: ['website', 'web', 'siteUrl'] },
    { src: appearance, keys: ['website', 'web', 'siteUrl'] },
    { src: account, keys: ['website', 'web', 'siteUrl'] },
  ]);

  const slogan = showSlogan
    ? pickFromSources([
        { src: branch, keys: ['slogan', 'description', 'tagline'] },
        { src: business, keys: ['slogan', 'description', 'tagline'] },
        { src: appearance, keys: ['slogan', 'description', 'tagline'] },
      ])
    : '';

  const receiptHeader = pickFromSources([
    { src: branch, keys: HEADER_KEYS },
    { src: posSettings, keys: HEADER_KEYS },
    { src: business, keys: HEADER_KEYS },
    { src: appearance, keys: HEADER_KEYS },
  ]);

  const branchFooter = pickFromSource(branch, ['receiptFooter', 'ticketFooterMessage', 'ticketFooter', 'footerMessage', 'footerText']);
  const posFooter = pickFromSource(posSettings, FOOTER_KEYS);
  const businessFooter = pickFromSource(business, ['ticketFooterMessage', 'receiptFooter', 'ticketFooter', 'footerMessage', 'footerText']);
  const appearanceFooter = pickFromSource(appearance, FOOTER_KEYS);
  const accountFooter = pickFromSource(account, FOOTER_KEYS);
  const cleanExplicitFooter = asTrimmedString(explicitFooter);
  const cleanSaleFooter = asTrimmedString(saleFooterNote);

  const customFooter =
    cleanExplicitFooter ||
    branchFooter ||
    posFooter ||
    businessFooter ||
    appearanceFooter ||
    accountFooter ||
    cleanSaleFooter;

  const hasCustomFooter = Boolean(customFooter);
  const receiptFooter = customFooter || defaultFooter;

  const consultUrl =
    asTrimmedString(explicitConsultUrl) ||
    pickFromSources([
      { src: branch, keys: ['consultUrl', 'comprobantesUrl'] },
      { src: business, keys: ['consultUrl', 'comprobantesUrl'] },
      { src: posSettings, keys: ['consultUrl', 'comprobantesUrl'] },
      { src: emitter, keys: ['consultUrl', 'comprobantesUrl'] },
      { src: account, keys: ['consultUrl', 'comprobantesUrl'] },
    ]) ||
    DEFAULT_CONSULT_URL;

  const printedFormatResolution = pickFromSources([
    { src: emitter, keys: ['printedFormatResolution', 'sunatResolution', 'authorizationText'] },
    { src: branch, keys: ['printedFormatResolution', 'sunatResolution', 'authorizationText'] },
    { src: business, keys: ['printedFormatResolution', 'sunatResolution', 'authorizationText'] },
  ]);

  const rawTemplate =
    asTrimmedString(explicitTemplate).toLowerCase() ||
    pickFromSources([
      { src: posSettings, keys: ['ticketTemplate'] },
      { src: branch, keys: ['ticketTemplate'] },
      { src: business, keys: ['ticketTemplate'] },
      { src: appearance, keys: ['ticketTemplate'] },
    ]).toLowerCase();
  const ticketTemplate: 'standard' | 'compact' =
    rawTemplate === 'compact' ? 'compact' : 'standard';

  const isDataLogo = logoUri.toLowerCase().startsWith('data:image/');

  return {
    logoUri,
    ...(isDataLogo ? { receiptLogoDataUrl: logoUri } : {}),
    ...(logoUri ? { receiptLogo: logoUri, receiptLogoUrl: logoUri, logoUrl: logoUri } : {}),
    businessName,
    name: businessName,
    branchName,
    razonSocial,
    ruc,
    address: fiscalAddress,
    fiscalAddress,
    commercialAddress,
    phone,
    commercialPhone: phone,
    email,
    website,
    slogan,
    description: slogan,
    receiptHeader,
    receiptFooter,
    hasCustomFooter,
    consultUrl,
    printedFormatResolution,
    ticketTemplate,
    showLogo,
    showRuc,
    showAddress,
    showPhone,
    showEmail,
    showSlogan,
  };
}

const inferMimeFromUrl = (url: string): string => {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
};

export function clearPrintableLogoCache(): void {
  printableLogoCache.clear();
}

/**
 * Convierte logos HTTP(S) en data URI base64 en caché en memoria para que el WebView
 * nativo de `expo-print` (PDF/impresión Android) renderice siempre el logo configurado.
 * Si falla la red o el contenido no es imagen, devuelve la URL sanitizada original.
 */
export async function resolvePrintableLogoDataUri(
  logoUri?: string | null
): Promise<string | undefined> {
  const sanitized = sanitizeReceiptImageUri(logoUri);
  if (!sanitized) return undefined;
  if (/^data:image\//i.test(sanitized)) return sanitized;

  const cached = printableLogoCache.get(sanitized);
  if (cached) return cached;

  if (typeof fetch !== 'function') {
    return sanitized;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore abort errors
        }
      }, LOGO_FETCH_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(
      sanitized,
      controller ? { signal: controller.signal } : undefined
    );
    if (!response || !response.ok) {
      return sanitized;
    }

    const rawCt = (response.headers?.get?.('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (rawCt && !rawCt.startsWith('image/') && rawCt !== 'application/octet-stream') {
      return sanitized;
    }

    if (typeof response.arrayBuffer !== 'function') {
      return sanitized;
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0) {
      return sanitized;
    }

    const b64 = uint8ArrayToBase64(bytes);
    if (!b64) {
      return sanitized;
    }

    const mime = rawCt.startsWith('image/') ? rawCt : inferMimeFromUrl(sanitized);
    const dataUri = `data:${mime};base64,${b64}`;

    if (printableLogoCache.size >= MAX_LOGO_CACHE_ENTRIES) {
      const oldestKey = printableLogoCache.keys().next().value;
      if (oldestKey !== undefined) {
        printableLogoCache.delete(oldestKey);
      }
    }
    printableLogoCache.set(sanitized, dataUri);
    return dataUri;
  } catch {
    return sanitized;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
