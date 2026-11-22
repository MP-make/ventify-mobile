import type { PosPaymentMethodConfig, SalePaymentSplit } from '@/types';

export type CheckoutPaymentCategory =
  | 'cash'
  | 'yape'
  | 'plin'
  | 'transfer'
  | 'card'
  | 'mixed'
  | 'credits'
  | 'fiado';

export interface CheckoutPaymentSplitInput {
  methodId?: string;
  category: 'cash' | 'card' | 'digital';
  amount: number;
  digitalProvider?: 'yape' | 'plin' | 'transferencia';
}

export interface ResolveCheckoutPaymentInput {
  methods: readonly PosPaymentMethodConfig[];
  selectedMethodId: string;
  category: CheckoutPaymentCategory;
  total: number;
  splits?: readonly CheckoutPaymentSplitInput[];
}

export interface CheckoutPaymentResolution {
  paymentMethodId: string;
  paymentMethodName: string;
  payments: SalePaymentSplit[];
  chargedAmount: number;
  commissionAmount: number;
  surchargeAmount: number;
  netAmount: number;
}

export type ResolveCheckoutPaymentResult =
  | { ok: true; value: CheckoutPaymentResolution }
  | { ok: false; error: string };

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

const calculateBreakdown = (amount: number, method: PosPaymentMethodConfig) => {
  const commissionAmount = method.commissionPercent
    ? roundMoney(amount * method.commissionPercent / 100)
    : 0;
  const surchargeAmount = method.commissionRule === 'customer' ? commissionAmount : 0;
  const chargedAmount = roundMoney(amount + surchargeAmount);
  return {
    commissionAmount,
    surchargeAmount,
    chargedAmount,
    netAmount: roundMoney(chargedAmount - commissionAmount),
  };
};

const normalizedMethodText = (method: PosPaymentMethodConfig): string =>
  `${method.id} ${method.name} ${method.provider || ''}`.toLowerCase();

const getNormalizedText = (
  method: PosPaymentMethodConfig,
  cache?: Map<PosPaymentMethodConfig, string>
): string => {
  if (!cache) return normalizedMethodText(method);
  let text = cache.get(method);
  if (text === undefined) {
    text = normalizedMethodText(method);
    cache.set(method, text);
  }
  return text;
};

const isTransferMethod = (
  method: PosPaymentMethodConfig,
  cache?: Map<PosPaymentMethodConfig, string>
): boolean =>
  method.kind === 'digital' && /transfer|bcp|banco/.test(getNormalizedText(method, cache));

const isProviderMethod = (
  method: PosPaymentMethodConfig,
  provider: 'yape' | 'plin',
  cache?: Map<PosPaymentMethodConfig, string>
): boolean => method.kind === 'digital' && getNormalizedText(method, cache).includes(provider);

const methodForCategory = (
  enabled: readonly PosPaymentMethodConfig[],
  category: CheckoutPaymentCategory,
  cache?: Map<PosPaymentMethodConfig, string>
): PosPaymentMethodConfig | undefined => {
  switch (category) {
    case 'cash':
      return enabled.find(method => method.kind === 'cash' || method.reportCategory === 'cash');
    case 'yape':
    case 'plin':
      return enabled.find(method => isProviderMethod(method, category, cache));
    case 'transfer':
      return enabled.find(method => isTransferMethod(method, cache));
    case 'card':
      return enabled.find(method => method.kind !== 'mixed' && method.kind !== 'credit' && (method.kind === 'terminal' || method.reportCategory === 'card'));
    case 'mixed':
      return enabled.find(method => method.kind === 'mixed');
    case 'credits':
    case 'fiado':
      return enabled.find(method => method.kind === 'credit');
  }
};

const methodForSplit = (
  enabled: readonly PosPaymentMethodConfig[],
  split: CheckoutPaymentSplitInput,
  cache?: Map<PosPaymentMethodConfig, string>
): PosPaymentMethodConfig | undefined => {
  if (split.methodId) {
    return enabled.find(
      method => method.id === split.methodId && method.kind !== 'mixed' && method.kind !== 'credit'
    );
  }
  if (split.category === 'cash') {
    return enabled.find(method => method.kind === 'cash' || method.reportCategory === 'cash');
  }
  if (split.category === 'card') {
    return enabled.find(method => method.kind !== 'mixed' && method.kind !== 'credit' && (method.kind === 'terminal' || method.reportCategory === 'card'));
  }
  const digitalProvider = split.digitalProvider;
  if (digitalProvider === 'transferencia') {
    return enabled.find(method => isTransferMethod(method, cache));
  }
  return enabled.find(method => method.kind === 'digital' && (
    digitalProvider ? isProviderMethod(method, digitalProvider, cache) : true
  ));
};

const buildPayment = (
  method: PosPaymentMethodConfig,
  amount: number,
  cache?: Map<PosPaymentMethodConfig, string>
): SalePaymentSplit => {
  const breakdown = calculateBreakdown(amount, method);
  const roundedAmount = roundMoney(amount);
  const payment: SalePaymentSplit = {
    methodId: method.id,
    methodName: method.name,
    category: method.reportCategory,
    amount: roundedAmount,
  };
  if (method.kind === 'digital') {
    if (isProviderMethod(method, 'yape', cache)) payment.digitalProvider = 'yape';
    else if (isProviderMethod(method, 'plin', cache)) payment.digitalProvider = 'plin';
  }
  if (breakdown.commissionAmount > 0) {
    payment.commissionAmount = breakdown.commissionAmount;
    payment.commissionPercent = method.commissionPercent;
    payment.commissionRule = method.commissionRule;
  }
  if (breakdown.surchargeAmount > 0) payment.surchargeAmount = breakdown.surchargeAmount;
  if (breakdown.chargedAmount !== roundedAmount) payment.chargedAmount = breakdown.chargedAmount;
  return payment;
};

/** Non-throwing variant of `resolveCheckoutPayment` returning a discriminated result. */
export function tryResolveCheckoutPayment({
  methods,
  selectedMethodId,
  category,
  total,
  splits,
}: ResolveCheckoutPaymentInput): ResolveCheckoutPaymentResult {
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, error: 'El total de la venta no es válido.' };
  }

  const enabledMethods = methods.filter(method => method.enabled);

  let method: PosPaymentMethodConfig | undefined;
  if (category === 'fiado' && selectedMethodId === 'fiado') {
    method = methodForCategory(enabledMethods, 'fiado');
  } else {
    method = enabledMethods.find(candidate => candidate.id === selectedMethodId);
    if (!method && selectedMethodId === 'efectivo') {
      method = methodForCategory(enabledMethods, category);
    }
  }
  if (!method) {
    return { ok: false, error: 'El método de pago está desactivado o ya no existe.' };
  }

  if (splits !== undefined) {
    if (method.kind !== 'mixed') {
      return { ok: false, error: 'Los pagos divididos requieren un método mixto.' };
    }
    if (!splits.length) {
      return { ok: false, error: 'Agrega al menos un método de pago' };
    }

    let totalPaid = 0;
    let hasPositive = false;
    for (let i = 0; i < splits.length; i++) {
      const amount = splits[i].amount;
      if (!Number.isFinite(amount) || amount < 0) {
        return { ok: false, error: 'Los montos no pueden ser negativos' };
      }
      totalPaid += amount;
      if (amount > 0) hasPositive = true;
    }

    if (Math.abs(total - totalPaid) > 0.01) {
      return {
        ok: false,
        error: `El total de los pagos (${roundMoney(totalPaid).toFixed(2)}) no coincide con el total de la venta (${total.toFixed(2)})`,
      };
    }
    if (!hasPositive) {
      return { ok: false, error: 'Ingresa un monto mayor a cero en al menos un método' };
    }

    // Precompute normalized search strings once for enabled digital methods across all splits.
    const normalizedTextCache = new Map<PosPaymentMethodConfig, string>();
    for (let i = 0; i < enabledMethods.length; i++) {
      const candidate = enabledMethods[i];
      if (candidate.kind === 'digital') {
        normalizedTextCache.set(candidate, normalizedMethodText(candidate));
      }
    }

    const payments: SalePaymentSplit[] = [];
    let rawCharged = 0;
    let rawCommission = 0;
    let rawSurcharge = 0;

    for (let i = 0; i < splits.length; i++) {
      const split = splits[i];
      if (split.amount <= 0) continue;
      const splitMethod = methodForSplit(enabledMethods, split, normalizedTextCache);
      if (!splitMethod) {
        return { ok: false, error: 'Una parte del pago utiliza un método inválido.' };
      }
      const payment = buildPayment(splitMethod, split.amount, normalizedTextCache);
      payments.push(payment);
      rawCharged += payment.chargedAmount ?? payment.amount;
      rawCommission += payment.commissionAmount || 0;
      rawSurcharge += payment.surchargeAmount || 0;
    }

    const chargedAmount = roundMoney(rawCharged);
    const commissionAmount = roundMoney(rawCommission);
    const surchargeAmount = roundMoney(rawSurcharge);
    return {
      ok: true,
      value: {
        paymentMethodId: method.id,
        paymentMethodName: method.name,
        payments,
        chargedAmount,
        commissionAmount,
        surchargeAmount,
        netAmount: roundMoney(chargedAmount - commissionAmount),
      },
    };
  }

  const breakdown = calculateBreakdown(total, method);
  return {
    ok: true,
    value: {
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      payments: [],
      ...breakdown,
    },
  };
}

/** Resolves the configured checkout method and applies the POS web payment math. */
export function resolveCheckoutPayment(
  input: ResolveCheckoutPaymentInput
): CheckoutPaymentResolution {
  const res = tryResolveCheckoutPayment(input);
  if (!res.ok) {
    throw new Error(res.error);
  }
  return res.value;
}
