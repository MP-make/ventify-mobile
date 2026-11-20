import type { PendingOfflineSale } from '@/services/offline-sync-service';

export interface OfflineSaleScope {
  accountId?: string | null;
  branchId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
}

export interface OfflineCashBreakdownDelta {
  cash: number;
  yape: number;
  plin: number;
  card: number;
  transfer: number;
  credit: number;
  totalDigital: number;
  totalAll: number;
  count: number;
  counts: {
    cash: number;
    yape: number;
    plin: number;
    card: number;
    transfer: number;
    credit: number;
    total: number;
  };
}

type PaymentBucket = 'cash' | 'yape' | 'plin' | 'card' | 'transfer' | 'credit';

interface PaymentBreakdown {
  cash: number;
  yape: number;
  plin: number;
  card: number;
  transfer: number;
  credit: number;
}

const round2 = (value: number): number =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const classifyHintToBucket = (category: string, hint: string): PaymentBucket | null => {
  const cat = category.toLowerCase().trim();
  const text = hint.toLowerCase().trim();

  if (cat === 'cash') return 'cash';
  if (cat === 'credit') return 'credit';
  if (cat === 'card' || cat === 'terminal') return 'card';

  if (text.includes('yape')) return 'yape';
  if (text.includes('plin')) return 'plin';
  if (/(^|[^a-z0-9])(efectivo|cash)([^a-z0-9]|$)/.test(text)) return 'cash';
  if (
    /(^|[^a-z0-9])(card|tarjeta|terminal|pos|visa|mastercard|izipay|niubiz|culqi)([^a-z0-9]|$)/.test(
      text
    )
  ) {
    return 'card';
  }
  if (/(^|[^a-z0-9])(fiado|credit|crédito|credito|creditos|créditos)([^a-z0-9]|$)/.test(text)) {
    return 'credit';
  }
  if (
    cat === 'digital' ||
    /(^|[^a-z0-9])(transfer|transferencia|digital|banca|deposito|depósito|wallet|billetera)([^a-z0-9]|$)/.test(
      text
    )
  ) {
    return 'transfer';
  }

  return null;
};

const buildParentPaymentHint = (payload: Record<string, any>): string =>
  [
    payload.digitalProvider,
    payload.paymentMethodId,
    payload.paymentMethodName,
    payload.paymentMethod,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ');

const extractPaymentBreakdown = (payload: Record<string, any>): PaymentBreakdown => {
  const breakdown: PaymentBreakdown = {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    credit: 0,
  };

  const parentHint = buildParentPaymentHint(payload);
  const splits = Array.isArray(payload.payments) ? payload.payments : [];

  if (splits.length > 0) {
    let splitSum = 0;
    for (const split of splits) {
      const amount = Number(split?.chargedAmount ?? split?.amount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const splitCategory = String(split?.category || '');
      const splitHint = [
        split?.digitalProvider,
        split?.paymentMethod,
        split?.methodId,
        split?.methodName,
      ]
        .filter(Boolean)
        .map(String)
        .join(' ');

      const bucket = classifyHintToBucket(splitCategory, splitHint || parentHint) ?? 'cash';
      breakdown[bucket] += amount;
      splitSum += amount;
    }

    if (splitSum > 0) {
      return breakdown;
    }
  }

  const cashAmt = Number(payload.cashAmount || 0);
  const cardAmt = Number(payload.cardAmount || 0);
  const digitalAmt = Number(payload.digitalAmount || 0);
  const creditAmt = Number(payload.creditAmount || 0);

  if (cashAmt > 0 || cardAmt > 0 || digitalAmt > 0 || creditAmt > 0) {
    if (cashAmt > 0) breakdown.cash += cashAmt;
    if (cardAmt > 0) breakdown.card += cardAmt;
    if (creditAmt > 0) breakdown.credit += creditAmt;
    if (digitalAmt > 0) {
      const digitalBucket = classifyHintToBucket('digital', parentHint);
      if (digitalBucket === 'yape' || digitalBucket === 'plin') {
        breakdown[digitalBucket] += digitalAmt;
      } else {
        breakdown.transfer += digitalAmt;
      }
    }
    return breakdown;
  }

  const fallbackAmount = Number(payload.chargedAmount ?? payload.total ?? 0);
  if (Number.isFinite(fallbackAmount) && fallbackAmount > 0) {
    const bucket =
      classifyHintToBucket(String(payload.paymentCategory || ''), parentHint) ?? 'cash';
    breakdown[bucket] += fallbackAmount;
  }

  return breakdown;
};

export function matchesOfflineSaleScope(
  item: PendingOfflineSale,
  scope: OfflineSaleScope
): boolean {
  const payload = item?.salePayload as Record<string, any> | undefined;
  if (!payload) return false;

  if (scope.accountId && payload.accountId !== scope.accountId) {
    return false;
  }

  if (scope.userId && payload.userId !== scope.userId) {
    return false;
  }

  if (scope.branchId && scope.branchId !== 'main' && payload.branchId !== scope.branchId) {
    return false;
  }

  if (scope.sessionId) {
    const matchesSession = payload.sessionId === scope.sessionId;
    const matchesUnassignedBranch =
      !payload.sessionId &&
      (!scope.branchId || scope.branchId === 'main' || payload.branchId === scope.branchId);
    if (!matchesSession && !matchesUnassignedBranch) {
      return false;
    }
  }

  return true;
}

export function pendingOfflineSaleToSaleRecord(
  item: PendingOfflineSale
): Record<string, any> {
  const p = (item.salePayload || {}) as Record<string, any>;
  const offlineId = item.offlineId || item.id || '';
  const code = `OFF-${offlineId.slice(-6).toUpperCase()}`;
  const ts = Number(p.saleDate || item.timestamp || Date.now());
  const breakdown = extractPaymentBreakdown(p);

  const cashAmount =
    p.cashAmount !== undefined ? Number(p.cashAmount) : round2(breakdown.cash);
  const cardAmount =
    p.cardAmount !== undefined ? Number(p.cardAmount) : round2(breakdown.card);
  const digitalAmount =
    p.digitalAmount !== undefined
      ? Number(p.digitalAmount)
      : round2(breakdown.yape + breakdown.plin + breakdown.transfer);
  const creditAmount =
    p.creditAmount !== undefined ? Number(p.creditAmount) : round2(breakdown.credit);

  return {
    id: offlineId,
    offlineId,
    saleNumber: 0,
    correlative: code,
    documentNumber: code,
    documentType: p.documentType || 'nota_venta',
    date: ts,
    _dateMs: ts,
    total: Number(p.total || 0),
    subtotal: Number(p.subtotal ?? p.total ?? 0),
    tax: Number(p.tax ?? 0),
    paymentMethod: p.paymentMethod,
    paymentMethodId: p.paymentMethodId,
    paymentMethodName: p.paymentMethodName,
    digitalProvider: p.digitalProvider,
    payments: Array.isArray(p.payments) ? p.payments : [],
    cashAmount,
    cardAmount,
    digitalAmount,
    creditAmount,
    customerId: p.customerId || p.customer?.id,
    customerName: p.customerName || p.customer?.name || 'Cliente Varios',
    customerDni: p.customerDni || p.customer?.dni,
    customerRuc: p.customerRuc || p.customer?.ruc,
    userId: p.userId,
    userName: p.userName || 'Cajero POS',
    accountId: p.accountId,
    branchId: p.branchId,
    sessionId: p.sessionId,
    items: p.items || [],
    status: 'pending_offline',
    sunatStatus: 'pending',
    isOfflinePending: true,
    offlineQueued: true,
    retryCount: item.retryCount || 0,
    lastErrorReason: item.lastErrorReason,
  };
}

export function mergeSalesWithOfflinePending<T extends Record<string, any>>(
  serverSales: T[],
  pendingOfflineSales: PendingOfflineSale[],
  scope: OfflineSaleScope
): T[] {
  const seenIds = new Set<string>();
  for (const sale of serverSales) {
    if (typeof sale?.offlineId === 'string' && sale.offlineId) {
      seenIds.add(sale.offlineId);
    }
    if (typeof sale?.id === 'string' && sale.id) {
      seenIds.add(sale.id);
    }
  }

  const pendingRecords: T[] = [];
  for (const item of pendingOfflineSales) {
    const offlineId = item?.offlineId;
    if (!offlineId) continue;
    if (seenIds.has(offlineId) || (item.id && seenIds.has(item.id))) continue;
    if (!matchesOfflineSaleScope(item, scope)) continue;

    seenIds.add(offlineId);
    if (item.id) seenIds.add(item.id);
    pendingRecords.push(pendingOfflineSaleToSaleRecord(item) as unknown as T);
  }

  const combined = [...pendingRecords, ...serverSales];
  combined.sort((a, b) => {
    const tsA = Number(a?.createdAt?.toMillis?.() || a?._dateMs || a?.date || 0);
    const tsB = Number(b?.createdAt?.toMillis?.() || b?._dateMs || b?.date || 0);
    return tsB - tsA;
  });

  return combined;
}

export function computeOfflineCashDelta(
  pendingOfflineSales: PendingOfflineSale[],
  syncedOfflineIds: ReadonlySet<string>,
  scope: OfflineSaleScope
): OfflineCashBreakdownDelta {
  let cash = 0;
  let yape = 0;
  let plin = 0;
  let card = 0;
  let transfer = 0;
  let credit = 0;
  let count = 0;

  const counts = {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    credit: 0,
    total: 0,
  };

  for (const item of pendingOfflineSales) {
    if (!item || syncedOfflineIds.has(item.offlineId)) continue;
    if (!matchesOfflineSaleScope(item, scope)) continue;

    const payload = (item.salePayload || {}) as Record<string, any>;
    const breakdown = extractPaymentBreakdown(payload);

    if (breakdown.cash > 0) {
      cash += breakdown.cash;
      counts.cash += 1;
    }
    if (breakdown.yape > 0) {
      yape += breakdown.yape;
      counts.yape += 1;
    }
    if (breakdown.plin > 0) {
      plin += breakdown.plin;
      counts.plin += 1;
    }
    if (breakdown.card > 0) {
      card += breakdown.card;
      counts.card += 1;
    }
    if (breakdown.transfer > 0) {
      transfer += breakdown.transfer;
      counts.transfer += 1;
    }
    if (breakdown.credit > 0) {
      credit += breakdown.credit;
      counts.credit += 1;
    }

    count += 1;
    counts.total += 1;
  }

  const roundedCash = round2(cash);
  const roundedYape = round2(yape);
  const roundedPlin = round2(plin);
  const roundedCard = round2(card);
  const roundedTransfer = round2(transfer);
  const roundedCredit = round2(credit);
  const totalDigital = round2(roundedYape + roundedPlin + roundedCard + roundedTransfer);
  const totalAll = round2(roundedCash + totalDigital + roundedCredit);

  return {
    cash: roundedCash,
    yape: roundedYape,
    plin: roundedPlin,
    card: roundedCard,
    transfer: roundedTransfer,
    credit: roundedCredit,
    totalDigital,
    totalAll,
    count,
    counts,
  };
}
