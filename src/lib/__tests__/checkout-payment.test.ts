import { describe, expect, it } from 'vitest';
import { resolveCheckoutPayment } from '../checkout-payment';
import type { PosPaymentMethodConfig } from '@/types';

const methods: PosPaymentMethodConfig[] = [
  { id: 'cash-main', name: 'Caja', kind: 'cash', enabled: true, order: 0, reportCategory: 'cash' },
  { id: 'qr-yape-local', name: 'Yape negocio', kind: 'digital', enabled: true, order: 1, provider: 'yape', commissionPercent: 2.5, commissionRule: 'customer', reportCategory: 'digital' },
  { id: 'bank-transfer', name: 'BCP', kind: 'digital', enabled: true, order: 2, provider: 'transferencia', reportCategory: 'digital' },
  { id: 'visa-terminal', name: 'Visa POS', kind: 'terminal', enabled: true, order: 3, commissionPercent: 3, commissionRule: 'business', reportCategory: 'card' },
  { id: 'mix-method', name: 'Pago mixto', kind: 'mixed', enabled: true, order: 4, reportCategory: 'mixed' as PosPaymentMethodConfig['reportCategory'] },
  { id: 'store-credit', name: 'Crédito tienda', kind: 'credit', enabled: true, order: 5, reportCategory: 'credit' },
  { id: 'disabled-cash', name: 'Caja apagada', kind: 'cash', enabled: false, order: 6, reportCategory: 'cash' },
];

describe('resolveCheckoutPayment', () => {
  it('preserves the configured method ID and calculates the same surcharge, commission, charged and net values as the web POS', () => {
    expect(resolveCheckoutPayment({ methods, selectedMethodId: 'qr-yape-local', category: 'yape', total: 100 })).toEqual({
      paymentMethodId: 'qr-yape-local', paymentMethodName: 'Yape negocio', payments: [],
      chargedAmount: 102.5, commissionAmount: 2.5, surchargeAmount: 2.5, netAmount: 100,
    });
  });

  it('rejects unknown selected IDs, except an obsolete efectivo ID can fall back by requested category', () => {
    expect(() => resolveCheckoutPayment({ methods, selectedMethodId: 'missing', category: 'card', total: 50 })).toThrow();
    expect(resolveCheckoutPayment({ methods, selectedMethodId: 'efectivo', category: 'card', total: 100 }).paymentMethodId).toBe('visa-terminal');
  });

  it('resolves Fiado to the real enabled credit method and preserves its configured ID', () => {
    expect(resolveCheckoutPayment({ methods, selectedMethodId: 'fiado', category: 'fiado', total: 35 })).toMatchObject({
      paymentMethodId: 'store-credit', paymentMethodName: 'Crédito tienda',
      chargedAmount: 35, commissionAmount: 0, surchargeAmount: 0, netAmount: 35,
    });
    expect(() => resolveCheckoutPayment({ methods: methods.filter(method => method.kind !== 'credit'), selectedMethodId: 'fiado', category: 'fiado', total: 35 })).toThrow();
  });

  it('builds split payments using configured IDs, applying commission rules per part', () => {
    const result = resolveCheckoutPayment({
      methods,
      selectedMethodId: 'mix-method',
      category: 'mixed',
      total: 100,
      splits: [
        { category: 'cash', amount: 60 },
        { category: 'card', amount: 40 },
      ],
    });
    expect(result).toMatchObject({
      paymentMethodId: 'mix-method', paymentMethodName: 'Pago mixto',
      chargedAmount: 100, commissionAmount: 1.2, surchargeAmount: 0, netAmount: 98.8,
    });
    expect(result.payments).toEqual([
      { methodId: 'cash-main', methodName: 'Caja', category: 'cash', amount: 60 },
      { methodId: 'visa-terminal', methodName: 'Visa POS', category: 'card', amount: 40, commissionPercent: 3, commissionRule: 'business', commissionAmount: 1.2 },
    ]);
  });

  it('never uses the mixed method itself for a card split when its report category is card', () => {
    const config = methods.filter(method => method.kind !== 'terminal').map(method =>
      method.kind === 'mixed' ? { ...method, reportCategory: 'card' as const } : method);
    expect(() => resolveCheckoutPayment({ methods: config, selectedMethodId: 'mix-method', category: 'mixed', total: 10,
      splits: [{ category: 'card', amount: 10 }] })).toThrow('método inválido');
  });

  it('uses the requested digital provider in splits and rejects a split with no enabled corresponding method', () => {
    const result = resolveCheckoutPayment({ methods, selectedMethodId: 'mix-method', category: 'mixed', total: 20, splits: [
      { category: 'digital', digitalProvider: 'yape', amount: 20 },
    ] });
    expect(result.payments[0]).toMatchObject({ methodId: 'qr-yape-local', digitalProvider: 'yape', chargedAmount: 20.5, surchargeAmount: 0.5, commissionAmount: 0.5 });
    expect(() => resolveCheckoutPayment({ methods, selectedMethodId: 'mix-method', category: 'mixed', total: 10, splits: [{ category: 'digital', digitalProvider: 'plin', amount: 10 }] })).toThrow();
  });
});
