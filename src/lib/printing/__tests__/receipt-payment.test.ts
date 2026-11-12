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
});
