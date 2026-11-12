import type { ReservationOrderItem } from './crm-operations-service';

export function toEpochMillis(value: unknown): number {
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    const timestamp = value as { toMillis?: () => number; seconds?: number; toDate?: () => Date };
    if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
    if (typeof timestamp.toDate === 'function') return timestamp.toDate().getTime();
    if (typeof timestamp.seconds === 'number') return timestamp.seconds * 1000;
  }
  return 0;
}

/** Normalize mobile lines to the canonical Web order line identifiers. */
export function normalizeOrderItems(items: ReservationOrderItem[]) {
  return items.map((item) => {
    const id = item.id || item.productId || '';
    const name = item.name || item.productName || 'Producto';
    return {
      ...item,
      id,
      name,
      productId: id,
      productName: name,
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 0,
      ...(item.variantId ? { variantId: item.variantId } : {}),
      ...(item.presentationId ? { presentationId: item.presentationId } : {}),
    };
  });
}

export function aggregateStockRequirements(items: ReservationOrderItem[]) {
  const grouped = new Map<string, { productId: string; units: number; items: ReservationOrderItem[] }>();
  for (const item of items) {
    if ((item as any).isCustomProduct) continue;
    const productId = item.id || item.productId;
    if (!productId) continue;
    const factor = Number(item.presentationQty || item.conversionFactor) || 1;
    const units = Math.round((Number(item.quantity) || 0) * factor * 10000) / 10000;
    const current = grouped.get(productId) || { productId, units: 0, items: [] };
    current.units = Math.round((current.units + units) * 10000) / 10000;
    current.items.push(item);
    grouped.set(productId, current);
  }
  return Array.from(grouped.values());
}

export type DepositBucketType = 'reservation' | 'order';

export function getHistoryDateBounds(
  range: 'today' | 'week' | 'month' | 'custom' | 'all',
  customStartDate = '',
  customEndDate = '',
  now = new Date()
): { start?: number; end?: number } {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === 'today') return { start: startOfDay, end: startOfDay + 86_400_000 - 1 };
  if (range === 'week') return { start: startOfDay - 6 * 86_400_000, end: startOfDay + 86_400_000 - 1 };
  if (range === 'month') return {
    start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    end: startOfDay + 86_400_000 - 1,
  };
  if (range === 'custom') {
    const result: { start?: number; end?: number } = {};
    if (customStartDate) {
      const [y, m, d] = customStartDate.split('-').map(Number);
      result.start = new Date(y, m - 1, d).getTime();
    }
    if (customEndDate) {
      const [y, m, d] = customEndDate.split('-').map(Number);
      result.end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    }
    return result;
  }
  return {};
}

/** Return the cash-session fields that belong to a reservation or an order deposit. */
export function getDepositSessionUpdates(
  session: Record<string, unknown>,
  type: DepositBucketType,
  method: string,
  amount: number
): Record<string, number> {
  const prefix = type === 'order' ? 'Order' : 'Reservation';
  const normalizedMethod = method.toLowerCase();
  const isCash = normalizedMethod === 'cash' || normalizedMethod.includes('efectivo');
  const isCard = normalizedMethod === 'card' || normalizedMethod.includes('tarjeta');
  const updates: Record<string, number> = {
    [`total${prefix}Deposits`]: (Number(session[`total${prefix}Deposits`]) || 0) + amount,
    [`${type}DepositsCount`]: (Number(session[`${type}DepositsCount`]) || 0) + 1,
  };
  if (isCash) {
    updates[`cash${prefix}Deposits`] = (Number(session[`cash${prefix}Deposits`]) || 0) + amount;
    updates.expectedAmount = (Number(session.expectedAmount) || 0) + amount;
    updates.totalIncome = (Number(session.totalIncome) || 0) + amount;
  } else if (isCard) {
    updates[`card${prefix}Deposits`] = (Number(session[`card${prefix}Deposits`]) || 0) + amount;
  } else {
    updates[`digital${prefix}Deposits`] = (Number(session[`digital${prefix}Deposits`]) || 0) + amount;
  }
  return Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, Math.round(value * 100) / 100]));
}
