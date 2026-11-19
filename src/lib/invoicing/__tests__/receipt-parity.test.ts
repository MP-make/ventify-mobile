import { describe, expect, it } from 'vitest';
import { computeSaleTaxBreakdown, receiptAmountsForSale } from '../receipt-amounts';
import { buildSaleQrContent } from '../qr-content';
import { buildQrSvgMarkup, generateQrMatrix } from '../qr-matrix';
import { buildReceiptHtml, buildSaleReceiptEscPos } from '../../printing/escpos-builder';

const decodeEscPosText = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString('latin1');
};

describe('receipt parity across tax math, QR generation, HTML and ESC/POS', () => {
  const sampleBusiness = {
    businessName: 'BODEGA LA ESTRELLA SAC',
    ruc: '20512345678',
    address: 'Av. Los Olivos 456, Lima',
    commercialAddress: 'Jr. Comercio 120, Miraflores',
    phone: '999888777',
    receiptLogoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    consultUrl: 'https://ventify.com.pe/comprobantes',
  };

  it('computes gravada IGV breakdown vs Amazonía exonerada breakdown identically to Web', () => {
    const standard = computeSaleTaxBreakdown(118, 'boleta', { isAmazonExempt: false });
    expect(standard.subtotal).toBe(100);
    expect(standard.tax).toBe(18);
    expect(standard.taxExemptionCode).toBe('10');
    expect(standard.isAmazonExempt).toBe(false);

    const amazon = computeSaleTaxBreakdown(118, 'boleta', {
      taxExemptionCode: '20',
      isAmazonExempt: true,
    });
    expect(amazon.subtotal).toBe(118);
    expect(amazon.tax).toBe(0);
    expect(amazon.taxExemptionCode).toBe('20');
    expect(amazon.isAmazonExempt).toBe(true);

    const notaVenta = computeSaleTaxBreakdown(118, 'nota_venta', { isAmazonExempt: false });
    expect(notaVenta.tax).toBe(0);
    expect(notaVenta.subtotal).toBe(118);

    const preserved = receiptAmountsForSale(
      { total: 118 },
      { taxed: 95, exempt: 5, unaffected: 0, igv: 18, otherTaxes: 0, total: 118 }
    );
    expect(preserved.taxed).toBe(95);
    expect(preserved.exempt).toBe(5);
    expect(preserved.igv).toBe(18);
  });

  it('builds SUNAT QR payload, binary matrix, and valid SVG markup without network deps', () => {
    const qrContent = buildSaleQrContent(
      {
        documentType: 'factura',
        documentNumber: 'F001-000123',
        sunatStatus: 'accepted',
        customerRuc: '20100070970',
        subtotal: 100,
        tax: 18,
        total: 118,
        date: new Date('2026-11-12T15:30:00-05:00').getTime(),
      },
      { emitterRuc: '20512345678' }
    );

    expect(qrContent).toMatch(/^20512345678\|01\|F001\|123\|18\.00\|118\.00\|2026-11-12\|6\|20100070970$/);

    const exemptQr = buildSaleQrContent(
      {
        documentType: 'boleta',
        documentNumber: 'B001-000010',
        customerDni: '12345678',
        total: 50,
        isAmazonExempt: true,
        taxExemptionCode: '20',
        date: new Date('2026-11-12T15:30:00-05:00').getTime(),
      },
      { emitterRuc: '20512345678' }
    );
    expect(exemptQr).toMatch(/^20512345678\|03\|B001\|10\|0\.00\|50\.00\|2026-11-12\|1\|12345678$/);

    const qrResult = generateQrMatrix(qrContent!);
    expect(qrResult.size).toBeGreaterThanOrEqual(21);
    expect(qrResult.matrix.length).toBe(qrResult.size);
    expect(qrResult.matrix[0].length).toBe(qrResult.size);

    const svg = buildQrSvgMarkup(qrContent!);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox=');
  });

  it('keeps Boleta title while pending, degrades unaccepted Factura to NOTA DE VENTA, and promotes accepted Factura', () => {
    const baseSale = {
      id: 'sale_1',
      saleNumber: 42,
      documentNumber: 'B001-000042',
      documentType: 'boleta',
      date: 1731400000000,
      items: [
        {
          id: 'item_1',
          productId: 'prod_1',
          name: 'Café Molido 250g',
          sku: 'CAF-250',
          quantity: 2,
          price: 25,
          lineTotal: 50,
          unitOfMeasure: 'NIU',
        },
      ],
      subtotal: 42.37,
      tax: 7.63,
      total: 50,
      paymentMethod: 'cash',
      customerName: 'JUAN PEREZ',
      customerDni: '12345678',
      sunatStatus: 'pending',
    };

    const boletaPendingHtml = buildReceiptHtml(baseSale as any, sampleBusiness);
    expect(boletaPendingHtml).toContain('BOLETA DE VENTA ELECTRONICA');

    const boletaEscPos = decodeEscPosText(
      buildSaleReceiptEscPos(baseSale as any, sampleBusiness, { paperWidth: 80 })
    );
    expect(boletaEscPos).toContain('BOLETA DE VENTA ELECTRONICA');

    const pendingFactura = {
      ...baseSale,
      documentType: 'factura',
      documentNumber: 'F001-000009',
      customerRuc: '20100070970',
      sunatStatus: 'pending',
    };
    const pendingFacturaHtml = buildReceiptHtml(pendingFactura as any, sampleBusiness);
    expect(pendingFacturaHtml).toContain('NOTA DE VENTA');
    expect(pendingFacturaHtml).not.toContain('FACTURA ELECTRONICA');

    const pendingFacturaEscPos = decodeEscPosText(
      buildSaleReceiptEscPos(pendingFactura as any, sampleBusiness)
    );
    expect(pendingFacturaEscPos).toContain('NOTA DE VENTA');
    expect(pendingFacturaEscPos).not.toContain('FACTURA ELECTRONICA');

    const acceptedFactura = {
      ...pendingFactura,
      sunatStatus: 'accepted',
      isOfflinePending: false,
    };
    const acceptedFacturaHtml = buildReceiptHtml(acceptedFactura as any, sampleBusiness);
    expect(acceptedFacturaHtml).toContain('FACTURA ELECTRONICA');
    expect(acceptedFacturaHtml).toContain('<img');
    expect(acceptedFacturaHtml).toContain('<svg');
    expect(acceptedFacturaHtml).toContain('CAF-250');
    expect(acceptedFacturaHtml).toContain('SKU');
    expect(acceptedFacturaHtml).toContain('CANT');

    const acceptedFacturaEscPos = decodeEscPosText(
      buildSaleReceiptEscPos(acceptedFactura as any, sampleBusiness, { paperWidth: 58 })
    );
    expect(acceptedFacturaEscPos).toContain('FACTURA ELECTRONICA');
  });

  it('preserves Recargo and TOTAL COBRADO lines in both HTML and ESC/POS', () => {
    const saleWithSurcharge = {
      id: 'sale_surcharge',
      saleNumber: 77,
      documentNumber: 'NV01-000077',
      documentType: 'nota_venta',
      date: 1731400000000,
      items: [
        {
          id: 'item_2',
          productId: 'prod_2',
          name: 'Audífonos USB-C',
          sku: 'AUD-01',
          quantity: 1,
          price: 96,
          lineTotal: 96,
        },
      ],
      total: 96,
      surchargeAmount: 7,
      chargedAmount: 103,
      paymentMethod: 'card',
      customerName: 'Cliente General',
    };

    const html = buildReceiptHtml(saleWithSurcharge as any, sampleBusiness);
    expect(html).toContain('Recargo:');
    expect(html).toContain('7.00');
    expect(html).toContain('TOTAL COBRADO:');
    expect(html).toContain('103.00');

    const escpos = decodeEscPosText(
      buildSaleReceiptEscPos(saleWithSurcharge as any, sampleBusiness)
    );
    expect(escpos).toContain('Recargo:');
    expect(escpos).toContain('7.00');
    expect(escpos).toContain('TOTAL COBRADO:');
    expect(escpos).toContain('103.00');
  });

  it('blocks QR generation for nota_venta, cotizacion, and offline pending documents while preserving NV degradation for unaccepted Factura', () => {
    expect(
      buildSaleQrContent(
        {
          documentType: 'nota_venta',
          documentNumber: 'NV-000101',
          total: 50,
          date: 1731400000000,
        },
        { emitterRuc: '20512345678' }
      )
    ).toBeNull();

    expect(
      buildSaleQrContent(
        {
          documentType: 'cotizacion',
          documentNumber: 'COT-000012',
          total: 50,
          date: 1731400000000,
        },
        { emitterRuc: '20512345678' }
      )
    ).toBeNull();

    expect(
      buildSaleQrContent(
        {
          documentType: 'factura',
          documentNumber: 'F001-000009',
          sunatStatus: 'accepted',
          isOfflinePending: true,
          customerRuc: '20100070970',
          subtotal: 100,
          tax: 18,
          total: 118,
          date: 1731400000000,
        },
        { emitterRuc: '20512345678' }
      )
    ).toBeNull();

    const offlineFactura = {
      id: 'sale_offline_fac',
      saleNumber: 88,
      documentType: 'factura',
      documentNumber: 'F001-000088',
      sunatStatus: 'pending',
      isOfflinePending: true,
      total: 118,
      subtotal: 118,
      tax: 0,
      date: 1731400000000,
      paymentMethod: 'cash',
      customerRuc: '20100070970',
      customerName: 'ACME SAC',
      items: [
        {
          id: 'i1',
          productId: 'p1',
          name: 'Café Tostado',
          presentationName: 'Caja x10',
          variantName: 'Oscuro',
          quantity: 1,
          price: 118,
          lineTotal: 118,
        },
      ],
    };

    const offlineHtml = buildReceiptHtml(offlineFactura as any, sampleBusiness);
    expect(offlineHtml).toContain('NOTA DE VENTA');
    expect(offlineHtml).toContain('NV-000088');
    expect(offlineHtml).not.toContain('F001-000088');
    expect(offlineHtml).not.toContain('<svg');
    expect(offlineHtml).toContain('Caja x10');
    expect(offlineHtml).toContain('Oscuro');

    const offlineEscpos = decodeEscPosText(
      buildSaleReceiptEscPos(offlineFactura as any, sampleBusiness)
    );
    expect(offlineEscpos).toContain('NOTA DE VENTA');
    expect(offlineEscpos).toContain('NV-000088');
    expect(offlineEscpos).not.toContain('F001-000088');
  });

  it('suppresses Op. Gravada 0.00 and IGV 0.00 for Amazonía/Exonerated sales and renders shipping/deposit/hash/resolution metadata', () => {
    const exemptSale = {
      id: 'sale_exempt_1',
      saleNumber: 90,
      documentType: 'boleta',
      documentNumber: 'B001-000090',
      sunatStatus: 'accepted',
      date: 1731400000000,
      items: [
        {
          id: 'i1',
          productId: 'p1',
          name: 'Cacao Orgánico',
          quantity: 2,
          price: 25,
          lineTotal: 50,
        },
      ],
      subtotal: 50,
      tax: 0,
      shippingAmount: 10,
      total: 60,
      isAmazonExempt: true,
      taxExemptionCode: '20',
      paymentMethod: 'digital',
      paymentMethodName: 'Yape Principal',
      sunatHash: 'HASH123ABC=',
      printedFormatResolution: 'Autorizado mediante Res. SUNAT 018-2026',
      depositInfo: {
        originalTotal: 100,
        appliedAmount: 60,
        remainingAmount: 40,
      },
      customerName: 'MARIA LOPEZ',
      customerDni: '87654321',
    };

    const html = buildReceiptHtml(exemptSale as any, sampleBusiness);
    expect(html).not.toContain('Op. Gravada:</span><span>S/ 0.00');
    expect(html).not.toContain('IGV (18%):</span><span>S/ 0.00');
    expect(html).toContain('Envío:');
    expect(html.toUpperCase()).toContain('YAPE PRINCIPAL');
    expect(html).toContain('HASH123ABC=');
    expect(html).toContain('Autorizado mediante Res. SUNAT 018-2026');
    expect(html).toContain('Total original:');
    expect(html).toContain('Saldo Pendiente:');
  });
});
