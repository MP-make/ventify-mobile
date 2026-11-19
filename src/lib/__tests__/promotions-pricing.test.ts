import { describe, expect, it } from 'vitest';
import {
  ICBPER_BAG_FEE,
  ICBPER_CART_ITEM_ID,
  cartHasPlasticBagProducts,
  evaluateCartPromotions,
  getEffectiveProductPrice,
  getEligibleGiftProducts,
  parseNormalizedDecimal,
  resolveProductBranchStock,
} from '../product-search';
import type { CartItem, DiscountSettings, Product, PromotionRule } from '@/types';

const makeProduct = (overrides: Partial<Product> = {}): Product => ({
  id: 'prod_1',
  name: 'Café Molido 250g',
  category: 'Bebidas',
  sku: 'CAF-250',
  costPrice: 10,
  minSalePrice: 18,
  suggestedPrice: 25,
  price: 25,
  stock: { main: 12, sucursal2: 4 },
  accountId: 'acc_1',
  active: true,
  ...overrides,
});

describe('Promotions, Gift Eligibility, ICBPER & Branch/Tier Pricing Parity', () => {
  it('resolves branch overrides, wholesale priceTiers, and enableMinSalePrice rules on presentations', () => {
    const product = makeProduct({
      priceTiers: [
        { minQuantity: 3, unitPrice: 22 },
        { minQuantity: 6, unitPrice: 20 },
      ],
      presentations: [
        { id: 'box_6', name: 'Caja x6', conversionFactor: 6, price: 110, minSalePrice: 120 },
      ],
      branchPrices: {
        sucursal2: {
          suggestedPrice: 30,
          minSalePrice: 27,
          priceTiers: [{ minQuantity: 5, unitPrice: 28 }],
        },
      },
    });

    expect(getEffectiveProductPrice(product, 'main', 1)).toBe(25);
    expect(getEffectiveProductPrice(product, 'main', 4)).toBe(22);
    expect(getEffectiveProductPrice(product, 'main', 6)).toBe(20);
    expect(getEffectiveProductPrice(product, 'sucursal2', 2)).toBe(30);
    expect(getEffectiveProductPrice(product, 'sucursal2', 5)).toBe(28);

    const box = product.presentations![0];
    expect(getEffectiveProductPrice(product, 'main', 1, box, undefined, true)).toBe(120);
    expect(getEffectiveProductPrice(product, 'main', 1, box, undefined, false)).toBe(110);
  });

  it('normalizes decimal commas cleanly and reads string/numeric branch stock', () => {
    expect(parseNormalizedDecimal('12,50')).toBe(12.5);
    expect(parseNormalizedDecimal(' 0,75 ')).toBe(0.75);
    expect(parseNormalizedDecimal('invalid')).toBe(0);

    const p = makeProduct({ stock: { main: '15' as any, b2: 0 } });
    expect(resolveProductBranchStock(p, 'main')).toBe(15);
    expect(resolveProductBranchStock(p, 'b2')).toBe(0);
  });

  it('enforces Web gift eligibility semantics (enableGifts, giftProductIds undefined vs [])', () => {
    const p1 = makeProduct({ id: 'g1', name: 'Llavero', stock: { main: 5 } });
    const p2 = makeProduct({ id: 'g2', name: 'Sticker', stock: { main: 0 } });
    const p3 = makeProduct({ id: 'g3', name: 'Taza', stock: { main: 3 }, active: false });
    const catalog = [p1, p2, p3];

    const disabled: DiscountSettings = { enableGifts: false };
    expect(getEligibleGiftProducts(catalog, disabled, 'main')).toEqual([]);

    const emptyWhitelist: DiscountSettings = { enableGifts: true, giftProductIds: [] };
    expect(getEligibleGiftProducts(catalog, emptyWhitelist, 'main')).toEqual([]);

    const scopedWhitelist: DiscountSettings = { enableGifts: true, giftProductIds: ['g1', 'g2'] };
    expect(getEligibleGiftProducts(catalog, scopedWhitelist, 'main').map((p) => p.id)).toEqual(['g1']);

    expect(getEligibleGiftProducts(catalog, { enableGifts: true, giftProductIds: undefined }, 'main').map((p) => p.id)).toEqual(['g1']);
  });

  it('evaluates percentage, fixed, and buy_x_get_y/free_product promotions accurately', () => {
    const drink = makeProduct({ id: 'p_drink', name: 'Gaseosa', price: 10 });
    const cookie = makeProduct({ id: 'p_cookie', name: 'Galleta', price: 5, stock: { main: 10 } });
    const catalog = [drink, cookie];

    const rules: PromotionRule[] = [
      {
        id: 'promo_pct',
        name: '10% Bebidas',
        type: 'percentage',
        productId: 'p_drink',
        minQuantity: 2,
        discountPercent: 10,
        active: true,
      },
      {
        id: 'promo_gift',
        name: 'Lleva 2 y llévate 1 Galleta',
        type: 'buy_x_get_y',
        productId: 'p_drink',
        minQuantity: 2,
        freeProductId: 'p_cookie',
        freeQuantity: 1,
        active: true,
      },
      {
        id: 'promo_inactive',
        name: 'Descuento Inactivo',
        type: 'fixed',
        benefits: { discountAmount: 5 },
        active: false,
      },
    ];

    const cartWithoutGift: CartItem[] = [
      {
        id: 'p_drink',
        productId: 'p_drink',
        name: 'Gaseosa',
        sku: 'GAS-1',
        category: 'Bebidas',
        price: 10,
        originalPrice: 10,
        quantity: 4,
        product: drink,
      },
    ];

    const suggestions = evaluateCartPromotions(cartWithoutGift, rules, catalog);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({
      promotionId: 'promo_pct',
      suggestedDiscountAmount: 4,
    });
    expect(suggestions[1]).toMatchObject({
      promotionId: 'promo_gift',
      freeQuantity: 2,
    });

    const cartWithPartialGift: CartItem[] = [
      ...cartWithoutGift,
      {
        id: 'p_cookie_gift',
        productId: 'p_cookie',
        name: 'Galleta',
        sku: 'GAL-1',
        category: 'Snacks',
        price: 0,
        originalPrice: 5,
        quantity: 2,
        isGift: true,
        product: cookie,
      },
    ];
    const afterGifted = evaluateCartPromotions(cartWithPartialGift, rules, catalog);
    expect(afterGifted.map((s) => s.promotionId)).toEqual(['promo_pct']);
  });

  it('detects plastic bag items while ignoring the ICBPER surcharge cart line itself', () => {
    expect(ICBPER_BAG_FEE).toBe(0.5);
    expect(
      cartHasPlasticBagProducts([
        { id: ICBPER_CART_ITEM_ID, productId: ICBPER_CART_ITEM_ID, name: 'Impuesto ICBPER', sku: 'ICBPER', category: 'Impuesto', price: 0.5, originalPrice: 0.5, quantity: 1 },
      ])
    ).toBe(false);

    expect(
      cartHasPlasticBagProducts([
        { id: 'bag_1', productId: 'bag_1', name: 'Bolsa plástica mediana', sku: 'BOL-1', category: 'Empaques', price: 0.2, originalPrice: 0.2, quantity: 1 },
      ])
    ).toBe(true);
  });
});
