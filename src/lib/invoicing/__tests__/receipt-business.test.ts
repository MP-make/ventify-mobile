import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPrintableLogoCache,
  mergeReceiptBusinessAndBranch,
  resolvePrintableLogoDataUri,
  resolveReceiptBusiness,
} from '../receipt-business';
import {
  buildReceiptHtml,
  buildReservationReceiptHtml,
  buildSaleReceiptEscPos,
} from '../../printing/escpos-builder';

const decodeEscPosText = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('latin1');

describe('receipt-business resolution & web ticket parity', () => {
  beforeEach(() => {
    clearPrintableLogoCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not allow empty or undefined branch fields to erase configured business identity, logo, or footer', () => {
    const emptyBranch = {
      id: 'b_main',
      name: 'Sucursal Principal',
      address: '',
      phone: '',
      email: '',
      ruc: undefined,
      commercialAddress: undefined,
      fiscalAddress: undefined,
      receiptLogo: undefined,
      receiptFooter: undefined,
    };

    const business = {
      businessName: 'EntreHilos Boutique',
      ruc: '20601234567',
      address: 'Calle Comercio 450, Pisco',
      phone: '927005798',
      email: 'hola@entrehilos.pe',
      slogan: 'Moda y detalles',
      logoUrl: 'https://cdn.ventify.com.pe/logos/entrehilos.png',
    };

    const posSettings = {
      ticketFooterMessage: 'Cambios dentro de 7 días con comprobante.',
    };

    const merged = mergeReceiptBusinessAndBranch(business, emptyBranch);
    expect(merged.businessName).toBe('EntreHilos Boutique');
    expect(merged.branchName).toBe('Sucursal Principal');
    expect(merged.address).toBe('Calle Comercio 450, Pisco');
    expect(merged.phone).toBe('927005798');
    expect(merged.ruc).toBe('20601234567');

    const resolved = resolveReceiptBusiness({
      business,
      branch: emptyBranch,
      posSettings,
    });
    expect(resolved.businessName).toBe('EntreHilos Boutique');
    expect(resolved.branchName).toBe('Sucursal Principal');
    expect(resolved.ruc).toBe('20601234567');
    expect(resolved.fiscalAddress).toBe('Calle Comercio 450, Pisco');
    expect(resolved.phone).toBe('927005798');
    expect(resolved.email).toBe('hola@entrehilos.pe');
    expect(resolved.slogan).toBe('Moda y detalles');
    expect(resolved.logoUri).toBe('https://cdn.ventify.com.pe/logos/entrehilos.png');
    expect(resolved.receiptFooter).toBe('Cambios dentro de 7 días con comprobante.');
    expect(resolved.hasCustomFooter).toBe(true);
  });

  it('prefers non-empty branch overrides over account-level business settings', () => {
    const resolved = resolveReceiptBusiness({
      business: {
        businessName: 'Grupo EntreHilos SAC',
        ruc: '20601234567',
        address: 'Sede Central Lima',
        phone: '900111222',
        receiptLogo: 'https://cdn.ventify.com.pe/central.png',
        receiptFooter: 'Pie general',
      },
      branch: {
        name: 'Tienda Ica',
        address: 'Av. San Martín 310, Ica',
        phone: '956777888',
        ruc: '20999888777',
        receiptLogo: 'https://cdn.ventify.com.pe/ica.png',
        receiptFooter: 'Gracias por visitar Tienda Ica',
      },
      posSettings: {
        ticketFooterMessage: 'Pie POS general',
      },
    });

    expect(resolved.ruc).toBe('20999888777');
    expect(resolved.fiscalAddress).toBe('Av. San Martín 310, Ica');
    expect(resolved.phone).toBe('956777888');
    expect(resolved.logoUri).toBe('https://cdn.ventify.com.pe/ica.png');
    expect(resolved.receiptFooter).toBe('Gracias por visitar Tienda Ica');
  });

  it('resolves logos across all web keys, nested objects, and rejects unsafe URIs', () => {
    expect(
      resolveReceiptBusiness({
        business: { receiptLogoDataUrl: 'data:image/png;base64,AAA=' },
      }).logoUri
    ).toBe('data:image/png;base64,AAA=');

    expect(
      resolveReceiptBusiness({
        business: { receiptLogo: 'https://cdn.ventify.com.pe/a.png' },
      }).logoUri
    ).toBe('https://cdn.ventify.com.pe/a.png');

    expect(
      resolveReceiptBusiness({
        business: { receiptLogoUrl: 'https://cdn.ventify.com.pe/b.png' },
      }).logoUri
    ).toBe('https://cdn.ventify.com.pe/b.png');

    expect(
      resolveReceiptBusiness({
        appearance: {
          receiptSettings: {
            logoUrl: 'https://cdn.ventify.com.pe/c.webp',
          },
        },
      }).logoUri
    ).toBe('https://cdn.ventify.com.pe/c.webp');

    expect(
      resolveReceiptBusiness({
        account: { logo: 'https://cdn.ventify.com.pe/d.jpg' },
      }).logoUri
    ).toBe('https://cdn.ventify.com.pe/d.jpg');

    expect(
      resolveReceiptBusiness({
        business: { logoUrl: 'javascript:alert(1)' },
      }).logoUri
    ).toBe('');
  });

  it('respects visibility flags (showLogo, showRuc, showAddress, showPhone) across HTML & ESC/POS', () => {
    const sale = {
      id: 'sale_vis',
      saleNumber: 12,
      documentType: 'nota_venta',
      documentNumber: 'NV01-000012',
      date: 1731400000000,
      paymentMethod: 'efectivo',
      total: 40,
      items: [{ id: 'p1', productId: 'p1', name: 'Item X', quantity: 1, price: 40, lineTotal: 40 }],
    };

    const biz = {
      businessName: 'Tienda Invisible',
      ruc: '20555666777',
      address: 'Av. Oculta 123',
      phone: '911222333',
      logoUrl: 'https://cdn.ventify.com.pe/logo.png',
      showLogo: false,
      showRuc: false,
      showAddress: false,
      showPhone: false,
      receiptFooter: 'Pie visible siempre',
    };

    const html = buildReceiptHtml(sale as any, biz as any);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('RUC: 20555666777');
    expect(html).not.toContain('Av. Oculta 123');
    expect(html).not.toContain('Telf: 911222333');
    expect(html).toContain('Pie visible siempre');

    const escpos = decodeEscPosText(buildSaleReceiptEscPos(sale as any, biz as any));
    expect(escpos).not.toContain('RUC: 20555666777');
    expect(escpos).not.toContain('Av. Oculta 123');
    expect(escpos).not.toContain('Telf: 911222333');
    expect(escpos).toContain('Pie visible siempre');

    const resHtml = buildReservationReceiptHtml(
      {
        id: 'res_vis',
        reservationNumber: 5,
        status: 'pending',
        total: 40,
        depositAmount: 10,
        items: [{ productName: 'Item X', quantity: 1, price: 40 }],
      },
      biz as any
    );
    expect(resHtml).not.toContain('<img');
    expect(resHtml).not.toContain('RUC:');
    expect(resHtml).not.toContain('Av. Oculta 123');
    expect(resHtml).not.toContain('Tel: 911222333');
    expect(resHtml).toContain('Pie visible siempre');
  });

  it('never emits fake RUC 20123456789 in reservation receipts and renders real logo + custom footer', () => {
    const htmlWithoutRuc = buildReservationReceiptHtml(
      {
        id: 'res_no_ruc',
        reservationNumber: 1,
        status: 'pending',
        total: 40,
        depositAmount: 40,
        items: [{ productName: 'Globos corazón', quantity: 5, price: 8 }],
      },
      {
        businessName: 'EntreHilos',
        address: 'Perú, Ica, Pisco',
        phone: '927005798',
        logoUrl: 'https://cdn.ventify.com.pe/entrehilos.png',
      },
      {
        paperWidth: 58,
        posSettings: {
          ticketFooterMessage: 'Vuelva pronto a EntreHilos',
        } as any,
      }
    );

    expect(htmlWithoutRuc).not.toContain('20123456789');
    expect(htmlWithoutRuc).not.toContain('RUC:');
    expect(htmlWithoutRuc).toContain('<img src="https://cdn.ventify.com.pe/entrehilos.png"');
    expect(htmlWithoutRuc).toContain('EntreHilos');
    expect(htmlWithoutRuc).toContain('Perú, Ica, Pisco');
    expect(htmlWithoutRuc).toContain('Tel: 927005798');
    expect(htmlWithoutRuc).toContain('Vuelva pronto a EntreHilos');
    expect(htmlWithoutRuc).toContain('size: 58mm auto');
  });

  it('converts HTTP image URLs to inline data URIs and falls back safely on fetch failures', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/png; charset=binary' },
      arrayBuffer: async () => pngBytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const dataUri = await resolvePrintableLogoDataUri('https://cdn.ventify.com.pe/logo.png');
    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`);

    // Second call uses in-memory cache without another fetch
    const cached = await resolvePrintableLogoDataUri('https://cdn.ventify.com.pe/logo.png');
    expect(cached).toBe(dataUri);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Network failure falls back safely to original sanitized URL
    fetchMock.mockRejectedValueOnce(new Error('Network down'));
    const fallback = await resolvePrintableLogoDataUri('https://cdn.ventify.com.pe/offline.jpg');
    expect(fallback).toBe('https://cdn.ventify.com.pe/offline.jpg');
  });
});
