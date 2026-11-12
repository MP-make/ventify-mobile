/** Before the parity repair, mobile pending orders used productId/productName
 * lines, had no web number/date and reserved stock immediately at creation. */
export function isLegacyReservedOrder(order: {status?: string;orderNumber?: unknown;date?: unknown;items?: Array<{id?: string;productId?: string}>}): boolean {
  return order.status === 'pending' && !order.orderNumber && !order.date &&
    Boolean(order.items?.length) && order.items!.every(line => Boolean(line.productId) && !line.id);
}
