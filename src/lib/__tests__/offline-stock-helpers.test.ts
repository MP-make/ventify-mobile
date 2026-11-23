import { describe, expect, it } from 'vitest';
import type { Product } from '@/types';
import type { PendingOfflineSale } from '@/services/offline-sync-service';
import {
  computeOfflineProductProjections,
  validateCartStockForCheckout,
  type OfflineInventoryOperation,
} from '../offline-stock-helpers';
import { ICBPER_CART_ITEM_ID } from '../product-search';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1',
    name: 'Gaseosa Cola 500ml',
    category: 'Bebidas',
    sku: 'SKU-TEST',
    price: 3.5,
    suggestedPrice: 3.5,
    minSalePrice: 2.0,
    costPrice: 2.0,
    stock: { 'b-1': 20 },
    accountId: 'acc-1',
    active: true,
    ...overrides,
  };
}

function makeOfflineSale(
  offlineId: string,
  items: any[],
  overrides: Record<string, any> = {}
): PendingOfflineSale {
  return {
    id: offlineId,
    offlineId,
    timestamp: 1_700_000_000_000,
    retryCount: 0,
    status: 'pending_offline',
    salePayload: {
      accountId: 'acc-1',
      branchId: 'b-1',
      userId: 'user-1',
      userName: 'Cajero',
      items,
      paymentMethod: 'cash',
      documentType: 'nota_venta',
      total: 10,
      offlineId,
      isQuote: false,
      ...overrides,
    },
  };
}

describe('offline-stock-helpers: computeOfflineProductProjections & validateCartStockForCheckout', () => {
  it('decrements parent branch stock for single and multiple offline sales without double-counting', () => {
    const p1 = makeProduct({ id: 'p1', stock: { 'b-1': 10 } });
    const base = new Map<string, Product>([['p1', p1]]);

    const sales = [
      makeOfflineSale('off-1', [{ productId: 'p1', name: 'P1', quantity: 2, price: 3.5 }]),
      makeOfflineSale('off-2', [{ productId: 'p1', name: 'P1', quantity: 3, price: 3.5 }]),
    ];

    const res1 = computeOfflineProductProjections(base, sales, [], 'b-1', 'acc-1');
    expect(res1.overlayProducts.get('p1')?.stock).toEqual({ 'b-1': 5 });
    expect(res1.affectedIds.has('p1')).toBe(true);

    // Re-running with identical inputs must remain idempotent (never double-decrement base)
    const res2 = computeOfflineProductProjections(base, sales, [], 'b-1', 'acc-1');
    expect(res2.overlayProducts.get('p1')?.stock).toEqual({ 'b-1': 5 });
    expect(base.get('p1')?.stock).toEqual({ 'b-1': 10 });
  });

  it('handles presentation conversionFactor and weighable decimals accurately', () => {
    const beerPack = makeProduct({ id: 'pack-1', stock: { 'b-1': 50 } });
    const bulkRice = makeProduct({ id: 'rice-1', stock: { 'b-1': 2.5 }, allowDecimals: true });
    const base = new Map<string, Product>([
      ['pack-1', beerPack],
      ['rice-1', bulkRice],
    ]);

    const sales = [
      makeOfflineSale('off-pres', [
        { productId: 'pack-1', name: 'Cerveza', quantity: 2, conversionFactor: 12, price: 48 },
        { productId: 'rice-1', name: 'Arroz kg', quantity: 0.375, price: 4.2 },
      ]),
      makeOfflineSale('off-weight-2', [
        { productId: 'rice-1', name: 'Arroz kg', quantity: 0.125, price: 4.2 },
      ]),
    ];

    const { overlayProducts } = computeOfflineProductProjections(base, sales, [], 'b-1', 'acc-1');
    expect(overlayProducts.get('pack-1')?.stock).toEqual({ 'b-1': 26 }); // 50 - 2*12
    expect(overlayProducts.get('rice-1')?.stock).toEqual({ 'b-1': 2 }); // 2.5 - (0.375 + 0.125)
  });

  it('decrements both Record and legacy scalar variant stocks alongside parent branch stock', () => {
    const mapVariantProd = makeProduct({
      id: 'v-map',
      stock: { 'b-1': 15 },
      variants: [
        { id: 'v1', name: 'Rojo M', stock: { 'b-1': 8 } },
        { id: 'v2', name: 'Azul L', stock: { 'b-1': 7 } },
      ],
    });
    const scalarVariantProd = makeProduct({
      id: 'v-scalar',
      stock: { 'b-1': 9 },
      variants: [
        { id: 'sv1', name: 'Única', stock: 9 as any },
      ],
    });
    const base = new Map<string, Product>([
      ['v-map', mapVariantProd],
      ['v-scalar', scalarVariantProd],
    ]);

    const sales = [
      makeOfflineSale('off-var', [
        { productId: 'v-map', variantId: 'v1', name: 'Polo Rojo M', quantity: 3, price: 25 },
        { productId: 'v-scalar', variantId: 'sv1', name: 'Gorra', quantity: 4, price: 20 },
      ]),
    ];

    const { overlayProducts } = computeOfflineProductProjections(base, sales, [], 'b-1', 'acc-1');
    const projMap = overlayProducts.get('v-map')!;
    expect(projMap.stock).toEqual({ 'b-1': 12 });
    expect(projMap.variants?.find((v) => v.id === 'v1')?.stock).toEqual({ 'b-1': 5 });
    expect(projMap.variants?.find((v) => v.id === 'v2')?.stock).toEqual({ 'b-1': 7 });

    const projScalar = overlayProducts.get('v-scalar')!;
    expect(projScalar.stock).toEqual({ 'b-1': 5 });
    expect(projScalar.variants?.find((v) => v.id === 'sv1')?.stock).toBe(5);
  });

  it('decrements stock for gifts, ignores quotes and synthetic fee items', () => {
    const prod = makeProduct({ id: 'gift-1', stock: { 'b-1': 6 } });
    const base = new Map<string, Product>([['gift-1', prod]]);

    const sales = [
      makeOfflineSale('off-gift', [
        { productId: 'gift-1', name: 'Regalo', quantity: 1, price: 0, isGift: true },
        { productId: ICBPER_CART_ITEM_ID, name: 'Bolsa ICBPER', quantity: 2, price: 0.5 },
      ]),
      makeOfflineSale(
        'off-quote',
        [{ productId: 'gift-1', name: 'Cotización', quantity: 5, price: 10 }],
        { isQuote: true, documentType: 'cotizacion' }
      ),
    ];

    const { overlayProducts } = computeOfflineProductProjections(base, sales, [], 'b-1', 'acc-1');
    expect(overlayProducts.get('gift-1')?.stock).toEqual({ 'b-1': 5 });
  });

  it('replays offline product_create, product_update, and stock_adjust ops before sales', () => {
    const existing = makeProduct({ id: 'p-exist', name: 'Viejo Nombre', price: 5, stock: { 'b-1': 10 } });
    const base = new Map<string, Product>([['p-exist', existing]]);

    const createdProd = makeProduct({ id: 'p-new', name: 'Nuevo Offline', stock: { 'b-1': 12 } });
    const ops: OfflineInventoryOperation[] = [
      {
        id: 'op-1',
        offlineOpId: 'op-1',
        type: 'product_create',
        accountId: 'acc-1',
        userId: 'user-1',
        branchId: 'b-1',
        productId: 'p-new',
        productData: createdProd as any,
        previewProduct: createdProd,
        timestamp: 100,
        retryCount: 0,
      },
      {
        id: 'op-2',
        offlineOpId: 'op-2',
        type: 'product_update',
        accountId: 'acc-1',
        userId: 'user-1',
        branchId: 'b-1',
        productId: 'p-exist',
        productData: { id: 'p-exist', name: 'Nombre Editado' },
        previewPatch: { name: 'Nombre Editado', price: 6.5 },
        timestamp: 200,
        retryCount: 0,
      },
      {
        id: 'op-3',
        offlineOpId: 'op-3',
        type: 'stock_adjust',
        accountId: 'acc-1',
        userId: 'user-1',
        branchId: 'b-1',
        branchName: 'Principal',
        productId: 'p-exist',
        productName: 'Nombre Editado',
        mode: 'add',
        amount: 5,
        expectedBeforeStock: 10,
        reason: 'Ingreso',
        timestamp: 300,
        retryCount: 0,
      },
    ];

    const sales = [
      makeOfflineSale('off-new-1', [{ productId: 'p-new', name: 'Nuevo Offline', quantity: 4, price: 3.5 }]),
      makeOfflineSale('off-ex-1', [{ productId: 'p-exist', name: 'Nombre Editado', quantity: 2, price: 6.5 }]),
    ];

    const { overlayProducts, createdIds } = computeOfflineProductProjections(
      base,
      sales,
      ops,
      'b-1',
      'acc-1'
    );

    expect(createdIds.has('p-new')).toBe(true);
    expect(overlayProducts.get('p-new')?.stock).toEqual({ 'b-1': 8 }); // 12 - 4
    expect(overlayProducts.get('p-exist')?.name).toBe('Nombre Editado');
    expect(overlayProducts.get('p-exist')?.stock).toEqual({ 'b-1': 13 }); // 10 + 5 - 2
  });

  it('validateCartStockForCheckout enforces combined presentation + gift limits, reserved stock, and variant caps', () => {
    const catalog = new Map<string, Product>([
      [
        'p-box',
        makeProduct({
          id: 'p-box',
          name: 'Cerveza',
          stock: { 'b-1': 15 },
          reservedStock: { 'b-1': 2 }, // effective available = 13
        }),
      ],
      [
        'p-var',
        makeProduct({
          id: 'p-var',
          name: 'Zapatilla',
          stock: { 'b-1': 20 },
          variants: [
            { id: 't40', name: 'Talla 40', stock: { 'b-1': 2 } },
            { id: 't41', name: 'Talla 41', stock: { 'b-1': 18 } },
          ],
        }),
      ],
    ]);

    // 1 box of 12 + 2 single units (gift) = 14 > 13 available
    const overParent = validateCartStockForCheckout(
      [
        { productId: 'p-box', name: 'Cerveza', quantity: 1, conversionFactor: 12 },
        { productId: 'p-box', name: 'Cerveza', quantity: 2, isGift: true },
        { productId: ICBPER_CART_ITEM_ID, name: 'ICBPER', quantity: 10 },
      ],
      catalog,
      'b-1'
    );
    expect(overParent.ok).toBe(false);
    expect(overParent.error).toContain('Cerveza');

    // Variant t40 only has 2 units even though parent has 20
    const overVariant = validateCartStockForCheckout(
      [{ productId: 'p-var', name: 'Zapatilla', variantId: 't40', variantName: 'Talla 40', quantity: 3 }],
      catalog,
      'b-1'
    );
    expect(overVariant.ok).toBe(false);
    expect(overVariant.error).toContain('Talla 40');

    // Within limits + synthetic item ignored
    const valid = validateCartStockForCheckout(
      [
        { productId: 'p-box', name: 'Cerveza', quantity: 1, conversionFactor: 12 },
        { productId: 'p-box', name: 'Cerveza', quantity: 1, isGift: true },
        { productId: 'p-var', name: 'Zapatilla', variantId: 't40', variantName: 'Talla 40', quantity: 2 },
        { productId: ICBPER_CART_ITEM_ID, name: 'ICBPER', quantity: 99 },
      ],
      catalog,
      'b-1'
    );
    expect(valid).toEqual({ ok: true });
  });
});
