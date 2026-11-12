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
  category: 'cash' | 'card' | 'digital';
  amount: number;
  digitalProvider?: 'yape' | 'plin';
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

const isTransferMethod = (method: PosPaymentMethodConfig): boolean =>
  method.kind === 'digital' && /transfer|bcp|banco/.test(normalizedMethodText(method));

const isProviderMethod = (
  method: PosPaymentMethodConfig,
  provider: 'yape' | 'plin',
): boolean => method.kind === 'digital' && normalizedMethodText(method).includes(provider);

const methodForCategory = (
  methods: readonly PosPaymentMethodConfig[],
  category: CheckoutPaymentCategory,
): PosPaymentMethodConfig | undefined => {
  const enabled = methods.filter(method => method.enabled);
  switch (category) {
    case 'cash':
      return enabled.find(method => method.kind === 'cash' || method.reportCategory === 'cash');
    case 'yape':
    case 'plin':
      return enabled.find(method => isProviderMethod(method, category));
    case 'transfer':
      return enabled.find(isTransferMethod);
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
  methods: readonly PosPaymentMethodConfig[],
  split: CheckoutPaymentSplitInput,
): PosPaymentMethodConfig | undefined => {
  const enabled = methods.filter(method => method.enabled);
  if (split.category === 'cash') {
    return enabled.find(method => method.kind === 'cash' || method.reportCategory === 'cash');
  }
  if (split.category === 'card') {
    return enabled.find(method => method.kind !== 'mixed' && method.kind !== 'credit' && (method.kind === 'terminal' || method.reportCategory === 'card'));
  }
  return enabled.find(method => method.kind === 'digital' && (
    split.digitalProvider ? isProviderMethod(method, split.digitalProvider) : true
  ));
};

const buildPayment = (
  method: PosPaymentMethodConfig,
  amount: number,
): SalePaymentSplit => {
  const breakdown = calculateBreakdown(amount, method);
  const payment: SalePaymentSplit = {
    methodId: method.id,
    methodName: method.name,
    category: method.reportCategory,
    amount: roundMoney(amount),
  };
  if (method.kind === 'digital') {
    if (isProviderMethod(method, 'yape')) payment.digitalProvider = 'yape';
    else if (isProviderMethod(method, 'plin')) payment.digitalProvider = 'plin';
  }
  if (breakdown.commissionAmount > 0) {
    payment.commissionAmount = breakdown.commissionAmount;
    payment.commissionPercent = method.commissionPercent;
    payment.commissionRule = method.commissionRule;
  }
  if (breakdown.surchargeAmount > 0) payment.surchargeAmount = breakdown.surchargeAmount;
  if (breakdown.chargedAmount !== roundMoney(amount)) payment.chargedAmount = breakdown.chargedAmount;
  return payment;
};

/** Resolves the configured checkout method and applies the POS web payment math. */
export function resolveCheckoutPayment({
  methods,
  selectedMethodId,
  category,
  total,
  splits,
}: ResolveCheckoutPaymentInput): CheckoutPaymentResolution {
  if (!Number.isFinite(total) || total < 0) throw new Error('El total de la venta no es válido.');

  let method: PosPaymentMethodConfig | undefined;
  if (category === 'fiado' && selectedMethodId === 'fiado') {
    method = methodForCategory(methods, 'fiado');
  } else {
    method = methods.find(candidate => candidate.enabled && candidate.id === selectedMethodId);
    if (!method && selectedMethodId === 'efectivo') {
      method = methodForCategory(methods, category);
    }
  }
  if (!method) throw new Error('El método de pago está desactivado o ya no existe.');

  if (splits !== undefined) {
    if (method.kind !== 'mixed') throw new Error('Los pagos divididos requieren un método mixto.');
    if (!splits.length) throw new Error('Agrega al menos un método de pago');
    if (splits.some(split => !Number.isFinite(split.amount) || split.amount < 0)) {
      throw new Error('Los montos no pueden ser negativos');
    }
    const totalPaid = splits.reduce((sum, split) => sum + split.amount, 0);
    if (Math.abs(total - totalPaid) > 0.01) {
      throw new Error(`El total de los pagos (${roundMoney(totalPaid).toFixed(2)}) no coincide con el total de la venta (${total.toFixed(2)})`);
    }
    if (splits.every(split => split.amount <= 0)) {
      throw new Error('Ingresa un monto mayor a cero en al menos un método');
    }
    const payments = splits.filter(split => split.amount > 0).map(split => {
      const splitMethod = methodForSplit(methods, split);
      if (!splitMethod) throw new Error('Una parte del pago utiliza un método inválido.');
      return buildPayment(splitMethod, split.amount);
    });
    const chargedAmount = roundMoney(payments.reduce((sum, payment) => sum + (payment.chargedAmount ?? payment.amount), 0));
    const commissionAmount = roundMoney(payments.reduce((sum, payment) => sum + (payment.commissionAmount || 0), 0));
    const surchargeAmount = roundMoney(payments.reduce((sum, payment) => sum + (payment.surchargeAmount || 0), 0));
    return {
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      payments,
      chargedAmount,
      commissionAmount,
      surchargeAmount,
      netAmount: roundMoney(chargedAmount - commissionAmount),
    };
  }

  const breakdown = calculateBreakdown(total, method);
  return {
    paymentMethodId: method.id,
    paymentMethodName: method.name,
    payments: [],
    ...breakdown,
  };
}
