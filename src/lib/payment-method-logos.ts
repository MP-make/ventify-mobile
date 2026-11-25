import type { PosPaymentMethodConfig } from '@/types';

export const PAYMENT_LOGOS = {
  yape: require('../../assets/payment/yape.jpeg'),
  plin: require('../../assets/payment/plin.png'),
  culqi: require('../../assets/payment/culqi.jpeg'),
  mastercard: require('../../assets/payment/mastercard.webp'),
} as const;

export type PaymentMethodVisualKind = 'cash' | 'transfer' | 'card' | 'digital';

type MethodLike = Partial<Pick<PosPaymentMethodConfig, 'id' | 'name' | 'kind' | 'provider' | 'reportCategory' | 'commissionRule' | 'commissionPercent'>>;

const normalizedMethodTokens = (method?: MethodLike | null): string =>
  `${method?.id || ''} ${method?.name || ''} ${method?.provider || ''}`.toLowerCase();

/**
 * Resuelve el logotipo real correspondiente al método de pago configurado.
 * Retorna `null` cuando corresponde renderizar un ícono vectorial dedicado
 * (efectivo, transferencia bancaria, mixto o crédito).
 */
export function getPaymentMethodLogo(method?: MethodLike | null): any | null {
  if (!method) return null;
  const tokens = normalizedMethodTokens(method);
  const kind = String(method.kind || '').toLowerCase();

  if (kind === 'cash' || kind === 'mixed' || kind === 'credit') {
    return null;
  }
  if (tokens.includes('yape')) return PAYMENT_LOGOS.yape;
  if (tokens.includes('plin')) return PAYMENT_LOGOS.plin;
  if (tokens.includes('culqi')) return PAYMENT_LOGOS.culqi;
  if (tokens.includes('transfer')) return null;

  if (
    tokens.includes('tarjeta') ||
    tokens.includes('card') ||
    tokens.includes('pos') ||
    tokens.includes('visa') ||
    tokens.includes('mastercard') ||
    tokens.includes('niubiz') ||
    tokens.includes('izipay') ||
    tokens.includes('vendemas') ||
    kind === 'terminal' ||
    method.reportCategory === 'card'
  ) {
    return PAYMENT_LOGOS.mastercard;
  }

  return null;
}

export function getPaymentMethodVisualKind(method?: MethodLike | null): PaymentMethodVisualKind {
  if (!method) return 'cash';
  const tokens = normalizedMethodTokens(method);
  const kind = String(method.kind || '').toLowerCase();

  if (kind === 'cash' || method.reportCategory === 'cash' || tokens.includes('efectivo')) {
    return 'cash';
  }
  if (tokens.includes('transfer') || tokens.includes('bcp') || tokens.includes('banco')) {
    return 'transfer';
  }
  if (
    kind === 'terminal' ||
    method.reportCategory === 'card' ||
    tokens.includes('tarjeta') ||
    tokens.includes('card') ||
    tokens.includes('culqi') ||
    tokens.includes('visa') ||
    tokens.includes('mastercard') ||
    tokens.includes('niubiz') ||
    tokens.includes('izipay') ||
    tokens.includes('vendemas')
  ) {
    return 'card';
  }
  return 'digital';
}

export function getPaymentMethodSubtitle(method?: MethodLike | null): string {
  const kind = getPaymentMethodVisualKind(method);
  const baseLabel =
    kind === 'cash'
      ? 'Pago en efectivo'
      : kind === 'transfer'
        ? 'Transferencia bancaria'
        : kind === 'card'
          ? 'Tarjeta / POS'
          : 'Billetera digital';

  const commission = Number(method?.commissionPercent || 0);
  if (method?.commissionRule === 'customer' && Number.isFinite(commission) && commission > 0) {
    return `${baseLabel} · +${commission}% recargo`;
  }
  return baseLabel;
}
