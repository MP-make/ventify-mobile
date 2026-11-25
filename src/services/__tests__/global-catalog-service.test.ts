import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDoc = vi.fn();
const mockGetDocs = vi.fn();
const mockSetDoc = vi.fn();
const mockDoc = vi.fn((_db: any, col: string, id: string) => ({ path: `${col}/${id}`, col, id }));
const mockCollection = vi.fn((_db: any, name: string) => ({ name }));
const mockQuery = vi.fn((...args: any[]) => ({ args }));
const mockWhere = vi.fn((field: string, op: string, value: any) => ({ field, op, value }));
const mockLimit = vi.fn((n: number) => ({ limit: n }));

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    currentUser: { uid: 'user_1' } as { uid: string } | null,
  },
}));

vi.mock('@/lib/firebase', () => ({
  db: {},
  auth: mockAuth,
}));

vi.mock('firebase/firestore', () => ({
  doc: (...args: any[]) => (mockDoc as any)(...args),
  getDoc: (...args: any[]) => (mockGetDoc as any)(...args),
  getDocs: (...args: any[]) => (mockGetDocs as any)(...args),
  setDoc: (...args: any[]) => (mockSetDoc as any)(...args),
  collection: (...args: any[]) => (mockCollection as any)(...args),
  query: (...args: any[]) => (mockQuery as any)(...args),
  where: (...args: any[]) => (mockWhere as any)(...args),
  limit: (...args: any[]) => (mockLimit as any)(...args),
  serverTimestamp: () => 'MOCK_TIMESTAMP',
}));

import {
  clearGlobalCatalogCache,
  contributeToGlobalCatalog,
  lookupGlobalProduct,
  lookupGlobalProductDetailed,
  mapGlobalUnitToMobileUnit,
  mapMobileUnitToGlobalUnit,
  sanitizeCatalogImageUrl,
  sanitizeGlobalCatalogBarcode,
} from '../global-catalog-service';

describe('global-catalog-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGlobalCatalogCache();
    mockAuth.currentUser = { uid: 'user_1' };
    mockGetDoc.mockResolvedValue({ exists: () => false });
    mockGetDocs.mockResolvedValue({ empty: true, docs: [] });
    mockSetDoc.mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 0 }),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearGlobalCatalogCache();
  });

  describe('validadores y mapeadores', () => {
    it('sanitizeGlobalCatalogBarcode rechaza códigos inválidos, cortos, largos o con / y ..', () => {
      expect(sanitizeGlobalCatalogBarcode('')).toBeNull();
      expect(sanitizeGlobalCatalogBarcode('  12 ')).toBeNull();
      expect(sanitizeGlobalCatalogBarcode('..')).toBeNull();
      expect(sanitizeGlobalCatalogBarcode('775/123')).toBeNull();
      expect(sanitizeGlobalCatalogBarcode('775 1234')).toBeNull();
      expect(sanitizeGlobalCatalogBarcode('a'.repeat(65))).toBeNull();

      expect(sanitizeGlobalCatalogBarcode('  7750182006521  ')).toBe('7750182006521');
      expect(sanitizeGlobalCatalogBarcode('SKU-001_A.2')).toBe('SKU-001_A.2');
    });

    it('sanitizeCatalogImageUrl solo permite https y actualiza Open Food Facts http->https', () => {
      expect(sanitizeCatalogImageUrl('https://cdn.ventify.pe/img.jpg')).toBe(
        'https://cdn.ventify.pe/img.jpg'
      );
      expect(
        sanitizeCatalogImageUrl('http://images.openfoodfacts.org/images/products/123/front.jpg')
      ).toBe('https://images.openfoodfacts.org/images/products/123/front.jpg');

      expect(sanitizeCatalogImageUrl('http://insecure.example.com/a.jpg')).toBeUndefined();
      expect(sanitizeCatalogImageUrl('file:///data/user/0/photo.jpg')).toBeUndefined();
      expect(sanitizeCatalogImageUrl('data:image/png;base64,AAAA')).toBeUndefined();
      expect(sanitizeCatalogImageUrl('javascript:alert(1)')).toBeUndefined();
    });

    it('mapea unidades entre formato global Web y móvil SUNAT', () => {
      expect(mapGlobalUnitToMobileUnit('unit')).toBe('NIU');
      expect(mapGlobalUnitToMobileUnit('kg')).toBe('KGM');
      expect(mapGlobalUnitToMobileUnit('lt')).toBe('LTR');
      expect(mapGlobalUnitToMobileUnit('box')).toBe('BX');
      expect(mapGlobalUnitToMobileUnit('g')).toBe('g');
      expect(mapGlobalUnitToMobileUnit('m')).toBe('m');
      expect(mapGlobalUnitToMobileUnit('ml')).toBeUndefined();

      expect(mapMobileUnitToGlobalUnit('NIU')).toBe('unit');
      expect(mapMobileUnitToGlobalUnit('KGM')).toBe('kg');
      expect(mapMobileUnitToGlobalUnit('LTR')).toBe('lt');
      expect(mapMobileUnitToGlobalUnit('BX')).toBe('box');
      expect(mapMobileUnitToGlobalUnit('g')).toBe('g');
      expect(mapMobileUnitToGlobalUnit('m')).toBe('m');
    });
  });

  describe('lookupGlobalProduct y protecciones anti-lecturas', () => {
    it('retorna de global_catalog en 1 lectura getDoc y reutiliza caché sin lecturas extra', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          barcode: '7750182006521',
          name: 'Frugos del Valle Fresh 1.5LT',
          imageUrl: 'https://cdn.ventify.pe/frugos.jpg',
          category: 'Bebidas',
          unitOfMeasure: 'unit',
        }),
      });

      const first = await lookupGlobalProductDetailed('7750182006521');
      const second = await lookupGlobalProductDetailed('7750182006521');

      expect(first.status).toBe('found');
      expect(first.product?.name).toBe('Frugos del Valle Fresh 1.5LT');
      expect(first.product?.source).toBe('ventify');
      expect(second.status).toBe('found');
      expect(second.fromCache).toBe(true);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
      expect(mockGetDocs).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('usa fallback acotado limit(3) en products (barcode y aliases), sin datos comerciales y auto-indexa peer_store', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });
      mockGetDocs
        .mockResolvedValueOnce({ empty: true, docs: [] }) // barcode primario
        .mockResolvedValueOnce({
          empty: false,
          docs: [
            {
              data: () => ({
                name: 'Leche Gloria Azul 400g',
                category: 'Lácteos',
                unitOfMeasure: 'NIU',
                price: 4.5,
                costPrice: 3.1,
                stock: { main: 99 },
                accountId: 'secret_store_123',
              }),
            },
            {
              data: () => ({
                name: 'Leche Gloria Azul 400g',
                imageUrl: 'https://cdn.ventify.pe/gloria.jpg',
                category: 'Lácteos',
                unitOfMeasure: 'NIU',
                price: 5.0,
                stock: { main: 12 },
                accountId: 'secret_store_456',
              }),
            },
          ],
        });

      const product = await lookupGlobalProduct('7750243000017');

      expect(product).not.toBeNull();
      expect(product?.name).toBe('Leche Gloria Azul 400g');
      expect(product?.imageUrl).toBe('https://cdn.ventify.pe/gloria.jpg');
      expect(product?.unitOfMeasure).toBe('unit');
      expect((product as any)?.price).toBeUndefined();
      expect((product as any)?.costPrice).toBeUndefined();
      expect((product as any)?.stock).toBeUndefined();

      expect(mockLimit).toHaveBeenCalledWith(3);
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
      const [, payload] = mockSetDoc.mock.calls[0];
      expect(payload.contributedByAccount).toBe('peer_store');
      expect(payload.price).toBeUndefined();
      expect(payload.stock).toBeUndefined();
    });

    it('consulta Open Food Facts si no está en Ventify y guarda caché negativa en miss', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 1,
          product: {
            product_name_es: 'Galletas Oreo',
            image_url: 'http://images.openfoodfacts.org/images/products/oreo.jpg',
            product_quantity_unit: 'kg',
            quantity: '1 kg',
          },
        }),
      } as any);

      const hit = await lookupGlobalProductDetailed('7622300744649');
      expect(hit.status).toBe('found');
      expect(hit.product?.name).toBe('Galletas Oreo');
      expect(hit.product?.imageUrl).toBe(
        'https://images.openfoodfacts.org/images/products/oreo.jpg'
      );
      expect(hit.product?.unitOfMeasure).toBe('kg');
      expect(hit.product?.source).toBe('openfoodfacts');

      // Miss + caché negativa (la segunda consulta no repite lecturas)
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 0 }),
      } as any);

      const miss1 = await lookupGlobalProductDetailed('9999999999991');
      const getDocCountAfterMiss1 = mockGetDoc.mock.calls.length;
      const miss2 = await lookupGlobalProductDetailed('9999999999991');

      expect(miss1.status).toBe('not_found');
      expect(miss2.status).toBe('not_found');
      expect(miss2.fromCache).toBe(true);
      expect(mockGetDoc.mock.calls.length).toBe(getDocCountAfterMiss1);
    });

    it('deduplica consultas paralelas del mismo código (1 sola lectura)', async () => {
      let resolveDoc!: (value: any) => void;
      mockGetDoc.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDoc = resolve;
          })
      );

      const p1 = lookupGlobalProductDetailed('7750000000123');
      const p2 = lookupGlobalProductDetailed('7750000000123');

      expect(mockGetDoc).toHaveBeenCalledTimes(1);

      resolveDoc({
        exists: () => true,
        data: () => ({ name: 'Agua Cielo 625ml', unitOfMeasure: 'unit' }),
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.product?.name).toBe('Agua Cielo 625ml');
      expect(r2.product?.name).toBe('Agua Cielo 625ml');
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('respeta allowNetwork: false sin lecturas a Firestore', async () => {
      const outcome = await lookupGlobalProductDetailed('7750182006521', {
        allowNetwork: false,
      });

      expect(outcome.status).toBe('offline');
      expect(outcome.product).toBeNull();
      expect(mockGetDoc).not.toHaveBeenCalled();
      expect(mockGetDocs).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('aplica cooldown de forceRefresh (1.5s) y límite de ventana deslizante (30/min)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-24T22:30:00Z'));

      mockGetDoc.mockResolvedValue({
        exists: () => true,
        data: () => ({ name: 'Producto Cooldown', unitOfMeasure: 'unit' }),
      });

      await lookupGlobalProductDetailed('7750000000001');
      // Dentro de 1500ms: forceRefresh usa caché
      vi.advanceTimersByTime(500);
      const cooled = await lookupGlobalProductDetailed('7750000000001', {
        forceRefresh: true,
      });
      expect(cooled.fromCache).toBe(true);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);

      // Pasados 1500ms: permite refrescar
      vi.advanceTimersByTime(1200);
      const refreshed = await lookupGlobalProductDetailed('7750000000001', {
        forceRefresh: true,
      });
      expect(refreshed.fromCache).toBeUndefined();
      expect(mockGetDoc).toHaveBeenCalledTimes(2);

      // Llenar hasta 30 consultas en la misma ventana de 60s
      for (let i = 2; i <= 29; i += 1) {
        await lookupGlobalProductDetailed(`77510000000${String(i).padStart(2, '0')}`);
      }
      expect(mockGetDoc).toHaveBeenCalledTimes(30);

      // La consulta #31 en el mismo minuto queda bloqueada por rate limit
      const blocked = await lookupGlobalProductDetailed('7751000000099');
      expect(blocked.status).toBe('rate_limited');
      expect(blocked.product).toBeNull();
      expect(mockGetDoc).toHaveBeenCalledTimes(30);
    });
  });

  describe('contributeToGlobalCatalog', () => {
    it('normaliza unidad NIU->unit, omite escrituras redundantes en caché y nunca incluye precios/stock', async () => {
      const wroteFirst = await contributeToGlobalCatalog({
        barcode: '7750182006521',
        name: 'Frugos del Valle Fresh 1.5LT',
        imageUrl: 'https://cdn.ventify.pe/frugos.jpg',
        category: 'Bebidas',
        unitOfMeasure: 'NIU',
        accountId: 'acc_1',
      });

      expect(wroteFirst).toBe(true);
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
      const [docRef, payload, options] = mockSetDoc.mock.calls[0];
      expect(docRef.id).toBe('7750182006521');
      expect(payload.unitOfMeasure).toBe('unit');
      expect(payload.contributedByAccount).toBe('acc_1');
      expect(options).toEqual({ merge: true });
      expect(payload.price).toBeUndefined();
      expect(payload.costPrice).toBeUndefined();
      expect(payload.stock).toBeUndefined();

      // Misma ficha ya cacheada -> 0 escrituras extra
      const wroteDuplicate = await contributeToGlobalCatalog({
        barcode: '7750182006521',
        name: 'Frugos del Valle Fresh 1.5LT',
        imageUrl: 'https://cdn.ventify.pe/frugos.jpg',
        category: 'Bebidas',
        unitOfMeasure: 'NIU',
        accountId: 'acc_1',
      });
      expect(wroteDuplicate).toBe(false);
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
    });
  });
});
