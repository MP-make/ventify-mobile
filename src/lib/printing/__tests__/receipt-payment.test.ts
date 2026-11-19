import { describe, expect, it } from 'vitest';
import { buildReceiptHtml, buildSaleReceiptEscPos } from '../escpos-builder';

const sale = { id: 's', items: [], total: 100, subtotal: 100, documentType: 'nota_venta', paymentMethod: 'Terminal', chargedAmount: 103, surchargeAmount: 3, cashReceived: 110 } as any;

describe('receipt payment amounts', () => {
  it('shows the customer surcharge and charged total on HTML and thermal receipts', () => {
    const html = buildReceiptHtml(sale, { businessName: 'Ventify' });
    expect(html).toContain('Recargo:');
    expect(html).toContain('TOTAL COBRADO:');
    expect(html).toContain('103.00');
    const thermal = new TextDecoder().decode(buildSaleReceiptEscPos(sale, { businessName: 'Ventify' } as any));
    expect(thermal).toContain('Recargo:');
    expect(thermal).toContain('TOTAL COBRADO:');
    expect(thermal).toContain('103.00');
    // Fallback change must subtract the amount actually charged (110 - 103).
    expect(thermal).toContain('7.00');
  });

  it('renders canonical sale.payments and paymentMethodName labels in HTML and ESC/POS', () => {
    const splitSale = {
      id: 'sale_split_1',
      saleNumber: 55,
      documentType: 'nota_venta',
      documentNumber: 'NV-000055',
      total: 100,
      subtotal: 100,
      paymentMethod: 'mixed',
      paymentMethodName: 'Pago Mixto Caja + Yape',
      payments: [
        { methodId: 'cash', methodName: 'Efectivo Soles', category: 'cash', amount: 40 },
        { methodId: 'yape', methodName: 'Yape Tienda', category: 'digital', amount: 60 },
      ],
      items: [
        { id: '1', productId: 'p1', name: 'Producto A', quantity: 1, price: 100, lineTotal: 100 },
      ],
    } as any;

    const html = buildReceiptHtml(splitSale, { businessName: 'Ventify' });
    expect(html.toUpperCase()).toContain('PAGO MIXTO CAJA + YAPE');
    expect(html).toContain('Efectivo Soles');
    expect(html).toContain('Yape Tienda');

    const escpos = Buffer.from(
      buildSaleReceiptEscPos(splitSale, { businessName: 'Ventify' } as any)
    ).toString('latin1');
    expect(escpos.toUpperCase()).toContain('PAGO MIXTO CAJA + YAPE');
    expect(escpos.toUpperCase()).toContain('EFECTIVO SOLES');
    expect(escpos.toUpperCase()).toContain('YAPE TIENDA');
  });
});
