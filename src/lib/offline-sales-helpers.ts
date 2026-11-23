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

const joinTruthy4 = (a: unknown, b: unknown, c: unknown, d: unknown): string => {
  let out = '';
  if (a) out = String(a);
  if (b) out = out ? `${out} ${String(b)}` : String(b);
  if (c) out = out ? `${out} ${String(c)}` : String(c);
  if (d) out = out ? `${out} ${String(d)}` : String(d);
  return out;
};

const buildParentPaymentHint = (payload: Record<string, any>): string =>
  joinTruthy4(
    payload.digitalProvider,
    payload.paymentMethodId,
    payload.paymentMethodName,
    payload.paymentMethod
  );

const extractPaymentBreakdown = (payload: Record<string, any>): PaymentBreakdown => {
  const breakdown: PaymentBreakdown = {
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    transfer: 0,
    credit: 0,
  };

  let cachedParentHint: string | undefined;
  const getParentHint = (): string => {
    if (cachedParentHint === undefined) {
      cachedParentHint = buildParentPaymentHint(payload);
    }
    return cachedParentHint;
  };

  const splits = Array.isArray(payload.payments) ? payload.payments : null;

  if (splits && splits.length > 0) {
    let splitSum = 0;
    for (let i = 0; i < splits.length; i++) {
      const split = splits[i];
      const amount = Number(split?.chargedAmount ?? split?.amount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const splitCategory = String(split?.category || '');
      const splitCatLower = splitCategory.toLowerCase().trim();
      let bucket: PaymentBucket | null;
      if (splitCatLower === 'cash') {
        bucket = 'cash';
      } else if (splitCatLower === 'credit') {
        bucket = 'credit';
      } else if (splitCatLower === 'card' || splitCatLower === 'terminal') {
        bucket = 'card';
      } else {
        const splitHint = joinTruthy4(
          split?.digitalProvider,
          split?.paymentMethod,
          split?.methodId,
          split?.methodName
        );
        bucket = classifyHintToBucket(splitCategory, splitHint || getParentHint());
      }

      breakdown[bucket ?? 'cash'] += amount;
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
      const digitalBucket = classifyHintToBucket('digital', getParentHint());
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
      classifyHintToBucket(String(payload.paymentCategory || ''), getParentHint()) ?? 'cash';
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

  if (scope.branchId === 'main') {
    if (
      payload.branchId &&
      payload.branchId !== 'main' &&
      !String(payload.branchId).toLowerCase().includes('principal')
    ) {
      return false;
    }
  } else if (scope.branchId && payload.branchId !== scope.branchId) {
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

  const items = Array.isArray(p.items) ? p.items : [];
  const computedTotalCost =
    p.totalCost !== undefined
      ? Number(p.totalCost)
      : round2(
          items.reduce((acc: number, it: any) => {
            const qty = Number(it?.quantity || 0);
            const factor = Number(it?.presentationQty || it?.conversionFactor || 1) || 1;
            const cost = Number(it?.costPrice || 0);
            return acc + cost * qty * factor;
          }, 0)
        );

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
    totalCost: computedTotalCost,
    discountAmount: Number(p.discountAmount ?? 0),
    shippingAmount: Number(p.shippingAmount ?? 0),
    surchargeAmount: Number(p.surchargeAmount ?? 0),
    chargedAmount: p.chargedAmount !== undefined ? Number(p.chargedAmount) : undefined,
    cashReceived: p.cashReceived !== undefined ? Number(p.cashReceived) : undefined,
    changeGiven: p.changeGiven !== undefined ? Number(p.changeGiven) : undefined,
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
    customerPhone: p.customerPhone || p.customer?.phone,
    customerAddress: p.customerAddress || p.customer?.address,
    taxExemptionCode: p.taxExemptionCode,
    isAmazonExempt: p.isAmazonExempt,
    sellerName: p.sellerName,
    userId: p.userId,
    userName: p.userName || 'Cajero POS',
    accountId: p.accountId,
    branchId: p.branchId,
    sessionId: p.sessionId,
    items,
    status: 'pending_offline',
    sunatStatus: 'pending',
    isOfflinePending: true,
    offlineQueued: true,
    retryCount: item.retryCount || 0,
    lastErrorReason: item.lastErrorReason,
  };
}

const extractSaleTimestampMs = (sale: Record<string, any>): number =>
  Number(sale?.createdAt?.toMillis?.() || sale?._dateMs || sale?.date || 0);

export function mergeSalesWithOfflinePending<T extends Record<string, any>>(
  serverSales: T[],
  pendingOfflineSales: PendingOfflineSale[],
  scope: OfflineSaleScope
): T[] {
  if (pendingOfflineSales.length === 0) {
    return serverSales;
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < serverSales.length; i++) {
    const sale = serverSales[i];
    if (typeof sale?.offlineId === 'string' && sale.offlineId) {
      seenIds.add(sale.offlineId);
    }
    if (typeof sale?.id === 'string' && sale.id) {
      seenIds.add(sale.id);
    }
  }

  const pendingRecords: T[] = [];
  for (let i = 0; i < pendingOfflineSales.length; i++) {
    const item = pendingOfflineSales[i];
    const offlineId = item?.offlineId;
    if (!offlineId) continue;
    if (seenIds.has(offlineId) || (item.id && seenIds.has(item.id))) continue;
    if (!matchesOfflineSaleScope(item, scope)) continue;

    seenIds.add(offlineId);
    if (item.id) seenIds.add(item.id);
    pendingRecords.push(pendingOfflineSaleToSaleRecord(item) as unknown as T);
  }

  if (pendingRecords.length === 0) {
    return serverSales;
  }

  const totalLen = pendingRecords.length + serverSales.length;
  const entries = new Array<{ sale: T; ts: number }>(totalLen);
  let idx = 0;
  for (let i = 0; i < pendingRecords.length; i++) {
    const sale = pendingRecords[i];
    entries[idx++] = { sale, ts: extractSaleTimestampMs(sale) };
  }
  for (let i = 0; i < serverSales.length; i++) {
    const sale = serverSales[i];
    entries[idx++] = { sale, ts: extractSaleTimestampMs(sale) };
  }

  entries.sort((a, b) => b.ts - a.ts);

  const combined = new Array<T>(totalLen);
  for (let i = 0; i < totalLen; i++) {
    combined[i] = entries[i].sale;
  }
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
