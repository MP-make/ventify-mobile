import type { CartItem, ProductPresentation } from '@/types';
type PresentationInput = Partial<ProductPresentation> & { factor?: number };
export function presentationFactor(presentation?: PresentationInput | null): number {
  const factor = Number(presentation?.conversionFactor ?? presentation?.factor ?? presentation?.quantity ?? 1);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}
export function normalizePresentation<T extends PresentationInput>(presentation: T): T & { conversionFactor: number } {
  const existing = presentation?.conversionFactor;
  if (typeof existing === 'number' && Number.isFinite(existing) && existing > 0) {
    return presentation as T & { conversionFactor: number };
  }
  return { ...presentation, conversionFactor: presentationFactor(presentation) };
}
export function reservationCartLines(items: CartItem[]) {
  return items.map((item) => {
    if (!item.productId) throw new Error('El producto del carrito no tiene un identificador válido.');
    const factor = item.presentationQty || item.conversionFactor || presentationFactor(item.presentation);
    const variantId = item.variantId || item.variant?.id;
    const variantName = item.variantName || item.variant?.name;
    const presentationId = item.presentationId || item.presentation?.id;
    return {
      productId: item.productId,
      id: item.productId,
      productName: item.name,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      sku: item.sku || '',
      ...(variantId ? { variantId } : {}),
      ...(variantName ? { variantName } : {}),
      ...(presentationId ? { presentationId } : {}),
      presentationQty: factor,
      conversionFactor: factor,
    };
  });
}
