import type { BranchPriceConfig, PriceTier, ProductAttribute, ProductVariant } from '@/types';

export interface ProductPresentation {
  id: string;
  name: string;
  conversionFactor: number;
  quantity?: number;
  factor?: number;
  price: number;
  barcode?: string;
  active?: boolean;
}

export interface ProductFormData {
  id?: string;
  name: string;
  category: string;
  barcode: string;
  barcodes?: string[];
  sku: string;
  brand?: string;
  sizeLabel?: string;
  sizes?: string[];
  unitOfMeasure: 'NIU' | 'KGM' | 'LTR' | 'BX' | string;
  allowDecimals?: boolean;
  taxExemptionCode?: '10' | '20' | '30' | string;
  price: number;
  minSalePrice: number;
  cost: number;
  stock: number;
  minStock: number;
  presentations: ProductPresentation[];
  variants?: ProductVariant[];
  priceTiers?: PriceTier[];
  branchPrices?: Record<string, BranchPriceConfig>;
  attributes?: ProductAttribute[];
  imageUrl?: string;
  thumbUrl?: string;
  galleryImages?: string[];
  stockByBranch?: Record<string, number>;
}

export interface BranchPriceDraft {
  suggestedPrice: string;
  costPrice: string;
  minSalePrice: string;
}

export interface ProductAttributeDraft {
  key: string;
  value: string;
}

export const MAX_GALLERY_IMAGES = 6;

export const VARIANT_COLORS = [
  '#111827',
  '#315BE8',
  '#BF3545',
  '#087F5B',
  '#A65E09',
  '#7545D9',
  '#FFFFFF',
] as const;

export const COMMON_CATEGORIES = [
  'Abarrotes',
  'Bebidas',
  'Snacks',
  'Lácteos',
  'Golosinas',
  'Limpieza',
  'Cuidado Personal',
  'Panadería',
  'Frutas y Verduras',
  'Otros',
] as const;

export const PRESET_SIZES = [
  '750 ml',
  '1 Litro',
  '500 gr',
  'Pack',
  '2 Plazas',
  'Estándar',
] as const;

export const UNITS: { code: string; label: string; desc: string }[] = [
  { code: 'NIU', label: 'Unidad (NIU)', desc: 'Pieza individual' },
  { code: 'KGM', label: 'Kilo (KGM)', desc: 'Venta por peso' },
  { code: 'LTR', label: 'Litro (LTR)', desc: 'Líquidos a granel' },
  { code: 'BX', label: 'Caja (BX)', desc: 'Embalaje por caja' },
  { code: 'g', label: 'Gramo (g)', desc: 'Fracción peso menor' },
  { code: 'm', label: 'Metro (m)', desc: 'Venta por longitud' },
];

export const TAX_CODES: { code: '10' | '20' | '30'; label: string; desc: string }[] = [
  { code: '10', label: 'Gravado IGV (18%)', desc: 'SUNAT 10' },
  { code: '20', label: 'Exonerado (0%)', desc: 'SUNAT 20' },
  { code: '30', label: 'Inafecto (0%)', desc: 'SUNAT 30' },
];

/**
 * Calcula el dígito verificador y genera un código EAN-13 válido oficial de Perú (prefijo 775)
 */
export function generatePeruvianEan13(): string {
  const prefix = '775';
  let random9 = '';
  for (let i = 0; i < 9; i++) {
    random9 += Math.floor(Math.random() * 10).toString();
  }
  const code12 = prefix + random9;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code12[i], 10);
    // Posición impar (1-based: 1, 3, 5... -> 0-based: 0, 2, 4...) peso 1
    // Posición par (1-based: 2, 4, 6... -> 0-based: 1, 3, 5...) peso 3
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return code12 + checkDigit.toString();
}
