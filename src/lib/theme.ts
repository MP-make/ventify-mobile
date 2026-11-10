/**
 * Ventify Mobile Theme & Design System
 * Strict native palette, typography, spacing, and Peruvian localization helpers
 */

// ============================================================================
// COLOR PALETTES
// ============================================================================

/** Semantic roles for the Ventify operational workspace. */
export const ui = {
  background: '#F5F7FB',
  surface: '#FFFFFF',
  surfaceMuted: '#F0F3F9',
  text: '#17243D',
  textSecondary: '#596981',
  textMuted: '#65748B',
  border: '#DFE6F0',
  primary: '#315BE8',
  primarySoft: '#EAF0FF',
  onPrimary: '#FFFFFF',
  accent: '#7545D9',
  accentSoft: '#F1ECFC',
  success: '#087F5B',
  successSoft: '#E8F6EF',
  warning: '#A65E09',
  warningSoft: '#FFF4DE',
  danger: '#BF3545',
  dangerSoft: '#FFF0F1',
  font: { title: 28, section: 18, body: 16, small: 13 },
  radius: 14,
} as const;

export const colors = {
  // Brand Accents
  primary: '#315BE8',       // Ventify blue from the original brand mark
  primaryDark: '#2547BD',   // Action pressed
  primaryLight: '#6E8FFF',  // Brand highlight
  primaryMuted: '#EAF0FF',

  // Secondary & Accents
  blue: '#3B82F6',          // Blue 500 (Info, Sync)
  blueDark: '#2563EB',
  blueMuted: 'rgba(59, 130, 246, 0.15)',

  amber: '#F59E0B',         // Amber 500 (Warnings, Pending)
  amberDark: '#D97706',
  amberMuted: 'rgba(245, 158, 11, 0.15)',

  red: '#EF4444',           // Red 500 (Errors, Deletions, Expenses)
  redDark: '#DC2626',
  redMuted: 'rgba(239, 68, 68, 0.15)',

  purple: '#8B5CF6',
  purpleMuted: 'rgba(139, 92, 246, 0.15)',

  // Dark roles reserved for camera and specialised dark surfaces
  dark: {
    background: '#0B0F17',
    surface: '#111827',
    card: '#111827',
    cardElevated: '#1F2937',
    border: '#1F2937',
    borderSubtle: '#374151',
    text: '#F9FAFB',
    textSecondary: '#9CA3AF',
    textMuted: '#6B7280',
    header: '#0B0F17',
    inputBackground: '#1F2937',
    inputBorder: '#374151',
    divider: '#1F2937',
  },

  // Operational workspace (the app's active visual scheme).
  light: {
    background: ui.background,
    surface: ui.surface,
    card: ui.surface,
    cardElevated: ui.surfaceMuted,
    border: ui.border,
    borderSubtle: ui.border,
    text: ui.text,
    textSecondary: ui.textSecondary,
    textMuted: ui.textMuted,
    header: ui.surface,
    inputBackground: ui.surfaceMuted,
    inputBorder: ui.border,
    divider: ui.border,
  },
} as const;

// Default theme shortcut
export const theme = {
  colors: colors.light,
  brand: colors,
  spacing: {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
  },
  borderRadius: {
    xs: 4,
    sm: 6,
    md: 10,
    lg: 14,
    xl: 20,
    full: 9999,
  },
  typography: {
    fontFamilyMono: 'monospace',
    sizes: {
      xs: 11,
      sm: 13,
      base: 15,
      lg: 17,
      xl: 20,
      xxl: 24,
      xxxl: 30,
    },
    weights: {
      regular: '400' as const,
      medium: '500' as const,
      semibold: '600' as const,
      bold: '700' as const,
      heavy: '800' as const,
    },
  },
  shadows: {
    sm: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.18,
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      elevation: 4,
    },
    lg: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.35,
      shadowRadius: 8,
      elevation: 8,
    },
  },
} as const;

// ============================================================================
// PERUVIAN LOCALIZATION & FORMATTING HELPERS
// ============================================================================

/**
 * Formats a monetary amount into Peruvian Soles (PEN)
 * e.g. 1250.5 -> "S/ 1,250.50"
 */
export function formatPEN(amount: number): string {
  if (amount === undefined || amount === null || Number.isNaN(amount)) {
    return 'S/ 0.00';
  }

  const isNegative = amount < 0;
  const absAmount = Math.abs(amount);

  const parts = absAmount.toFixed(2).split('.');
  const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimalPart = parts[1];

  return `${isNegative ? '-' : ''}S/ ${integerPart}.${decimalPart}`;
}

/**
 * Formats any date input (Firestore Timestamp, Date, number, ISO string)
 * into standard Peruvian datetime: "DD/MM/YYYY HH:mm" (or "DD/MM/YYYY")
 */
export function formatDatePE(date: any, includeTime: boolean = true): string {
  if (!date) return '';

  let d: Date;

  if (typeof date === 'object' && date !== null && typeof date.toDate === 'function') {
    // Firestore Timestamp instance
    d = date.toDate();
  } else if (typeof date === 'object' && date !== null && typeof date.seconds === 'number') {
    // Firestore Timestamp serialized
    d = new Date(date.seconds * 1000);
  } else if (date instanceof Date) {
    d = date;
  } else if (typeof date === 'number') {
    // epoch ms or epoch seconds
    d = date < 1e11 ? new Date(date * 1000) : new Date(date);
  } else if (typeof date === 'string') {
    d = new Date(date);
  } else {
    return '';
  }

  if (Number.isNaN(d.getTime())) return '';

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  if (!includeTime) {
    return `${day}/${month}/${year}`;
  }

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

/**
 * Generates a unique, collision-resistant identifier
 * with an optional domain prefix.
 * e.g. generateId('sale') -> "sale_m2b9x1a_9f8342"
 */
export function generateId(prefix?: string): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 9);
  return prefix ? `${prefix}_${timestamp}_${randomPart}` : `${timestamp}_${randomPart}`;
}

/**
 * Generates an authentic EAN-13 barcode using Peru's GS1 prefix (775)
 * with official Modulo 10 check digit calculation.
 * e.g. "7751234567891"
 */
export function generateEAN13Peru(): string {
  const prefix = '775';
  let body = '';
  // Generate 9 random digits to form a 12-digit base
  for (let i = 0; i < 9; i++) {
    body += Math.floor(Math.random() * 10).toString();
  }

  const code12 = prefix + body;

  // Modulo 10 checksum algorithm:
  // Odd positions (0-indexed: 0, 2, 4, 6, 8, 10) multiplied by 1
  // Even positions (0-indexed: 1, 3, 5, 7, 9, 11) multiplied by 3
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code12[i], 10);
    sum += i % 2 === 0 ? digit * 1 : digit * 3;
  }

  const remainder = sum % 10;
  const checkDigit = remainder === 0 ? 0 : 10 - remainder;

  return `${code12}${checkDigit}`;
}
