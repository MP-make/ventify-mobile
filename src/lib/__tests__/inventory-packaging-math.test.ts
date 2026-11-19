import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  documents: new Map<string, any>(),
  writes: [] as Array<{ kind: string; ref: any; data: any }>,
  generatedId: 0,
}));

vi.mock('@/lib/firebase', () => ({ db: { test: true }, app: { test: true } }));
vi.mock('firebase/storage', () => ({
  getStorage: vi.fn(() => ({})),
  ref: vi.fn(),
  uploadBytes: vi.fn(),
  getDownloadURL: vi.fn(),
}));
vi.mock('firebase/firestore', () => {
  const makeRef = (collectionName: string, id: string) => ({ collectionName, id });
  const keyFor = (ref: any) => `${ref.collectionName}/${ref.id}`;
  return {
    collection: (_db: any, collectionName: string) => ({ collectionName }),
    doc: (...args: any[]) => {
      if (args.length === 1) {
        const coll = args[0];
        return makeRef(coll.collectionName, `generated-${++fake.generatedId}`);
      }
      return makeRef(args[1], args[2]);
    },
    query: (_collection: any, ...constraints: any[]) => ({ constraints }),
    where: (...args: any[]) => ({ type: 'where', args }),
    orderBy: vi.fn(),
    limit: vi.fn(),
    getCountFromServer: vi.fn(),
    onSnapshot: vi.fn(),
    addDoc: vi.fn(),
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    getDoc: vi.fn(async (ref: any) => {
      const data = fake.documents.get(keyFor(ref));
      return { exists: () => !!data, data: () => data };
    }),
    getDocs: vi.fn(async () => ({ docs: [] })),
    serverTimestamp: () => 'server-timestamp',
    Timestamp: class Timestamp {},
    runTransaction: vi.fn(async (_db: any, callback: (tx: any) => any) => {
      let hasWritten = false;
      const tx = {
        get: async (ref: any) => {
          if (hasWritten) throw new Error('strict transaction: read after write');
          const data = fake.documents.get(keyFor(ref));
          return { exists: () => !!data, data: () => data };
        },
        update: (ref: any, data: any) => {
          hasWritten = true;
          fake.writes.push({ kind: 'tx.update', ref, data });
          const current = { ...(fake.documents.get(keyFor(ref)) || {}) };
          // Apply dot-notation updates (e.g. 'stock.main') cleanly
          for (const [k, v] of Object.entries(data)) {
            if (k.includes('.')) {
              const parts = k.split('.');
              let cursor: Record<string, any> = current;
              for (let i = 0; i < parts.length - 1; i++) {
                cursor[parts[i]] = { ...(cursor[parts[i]] || {}) };
                cursor = cursor[parts[i]];
              }
              cursor[parts[parts.length - 1]] = v;
            } else {
              current[k] = v;
            }
          }
          fake.documents.set(keyFor(ref), current);
        },
        set: (ref: any, data: any) => {
          hasWritten = true;
          fake.writes.push({ kind: 'tx.set', ref, data });
          fake.documents.set(keyFor(ref), { ...data });
        },
      };
      return callback(tx);
    }),
  };
});

import {
  resolvePackagingFactor,
  convertPackagingReceipt,
  calculateWeightedAverageCost,
  receivePurchaseOrder,
} from '@/services/suppliers-po-service';
import {
  resolvePresentationVariantPrice,
  resolvePresentationVariantStock,
  mergeSingleBranchStock,
} from '@/services/inventory-kardex-service';

const actor = { uid: 'admin-1', displayName: 'Admin', email: 'admin@test.pe', role: 'admin' };

describe('inventory & packaging math parity', () => {
  beforeEach(() => {
    fake.documents.clear();
    fake.writes.length = 0;
    fake.generatedId = 0;
  });

  describe('Purchase Order packagingFactor conversion & weighted average cost', () => {
    it('resolves invalid or sub-1 packaging factors safely to 1', () => {
      expect(resolvePackagingFactor(undefined)).toBe(1);
      expect(resolvePackagingFactor(null)).toBe(1);
      expect(resolvePackagingFactor(0)).toBe(1);
      expect(resolvePackagingFactor(-5)).toBe(1);
      expect(resolvePackagingFactor(Number.NaN)).toBe(1);
      expect(resolvePackagingFactor(12)).toBe(12);
    });

    it('converts boxed receipts using unitsAdded = qty * factor and effectiveUnitCost = unitCost / factor', () => {
      const exact = convertPackagingReceipt({
        quantity: 3,
        unitCost: 60,
        packagingFactor: 12,
      });
      expect(exact.factor).toBe(12);
      expect(exact.unitsAdded).toBe(36);
      expect(exact.effectiveUnitCost).toBe(5);
      expect(exact.exactUnitCost).toBe(5);

      const rounded = convertPackagingReceipt({
        quantity: 2,
        unitCost: 25,
        packagingFactor: 6,
      });
      expect(rounded.unitsAdded).toBe(12);
      expect(rounded.effectiveUnitCost).toBe(4.17);
      expect(rounded.exactUnitCost).toBeCloseTo(25 / 6, 6);
    });

    it('supports pre-converted web PO lines where packagingTotalCost preserves pack cost', () => {
      const res = convertPackagingReceipt({
        quantity: 24,
        receivedQty: 12,
        unitCost: 2.5,
        packagingFactor: 12,
        packagingTotalCost: 30,
      });
      expect(res.factor).toBe(12);
      expect(res.unitsAdded).toBe(12);
      expect(res.effectiveUnitCost).toBe(2.5);
      expect(res.exactUnitCost).toBe(2.5);
    });

    it('computes weighted average cost accurately across prior stock and packaging receipts', () => {
      // 10 uds @ S/ 4.00 + 30 uds @ S/ 6.00 => (40 + 180) / 40 = S/ 5.50
      expect(calculateWeightedAverageCost(10, 4, 30, 6)).toBe(5.5);

      // Zero prior stock adopts incoming cost directly
      expect(calculateWeightedAverageCost(0, 4, 24, 3.25)).toBe(3.25);

      // Zero incoming quantity preserves existing cost
      expect(calculateWeightedAverageCost(10, 4.75, 0, 9)).toBe(4.75);

      // Combined: 12 uds @ S/ 4.00 + 2 boxes x 12 @ S/ 60.00/box (= 24 uds @ S/ 5.00) => (48 + 120) / 36 = 4.67
      const receipt = convertPackagingReceipt({
        quantity: 2,
        unitCost: 60,
        packagingFactor: 12,
      });
      expect(
        calculateWeightedAverageCost(12, 4, receipt.unitsAdded, receipt.exactUnitCost)
      ).toBe(4.67);
    });

    it('accumulates partial PO receipts with packagingFactor conversion and transitions partial -> received', async () => {
      fake.documents.set('products/p1', {
        accountId: 'acc-1',
        name: 'Gaseosa 500ml',
        sku: 'GAS-500',
        stock: { main: 10 },
        reservedStock: {},
        costPrice: 1.5,
        minSalePrice: 1.8,
        suggestedPrice: 2.5,
        presentations: [],
        minStock: 5,
      });

      fake.documents.set('purchase_orders/po-1', {
        accountId: 'acc-1',
        orderNumber: 'OC-0001',
        branchId: 'main',
        branchName: 'Principal',
        status: 'ordered',
        items: [
          {
            productId: 'p1',
            productName: 'Gaseosa 500ml',
            sku: 'GAS-500',
            quantity: 5,
            receivedQuantity: 0,
            unitCost: 24,
            packagingFactor: 12,
            packagingLabel: 'Caja x12',
            subtotal: 120,
          },
        ],
      });

      // 1st partial reception: 2 boxes (24 units @ S/ 2.00/u)
      const firstRun = await receivePurchaseOrder('po-1', actor, undefined, undefined, {
        partialItems: [{ productId: 'p1', receivedQty: 2 }],
      });

      expect(firstRun.status).toBe('partial');
      expect(fake.documents.get('purchase_orders/po-1').status).toBe('partial');
      expect(fake.documents.get('purchase_orders/po-1').items[0].receivedQuantity).toBe(2);
      expect(fake.documents.get('products/p1').stock.main).toBe(34); // 10 + 24
      // WAC = (10 * 1.50 + 24 * 2.00) / 34 = 63 / 34 = 1.85
      expect(fake.documents.get('products/p1').costPrice).toBe(1.85);

      // 2nd partial reception: remaining 3 boxes (36 units @ S/ 2.00/u)
      const secondRun = await receivePurchaseOrder('po-1', actor, undefined, undefined, {
        partialItems: [{ productId: 'p1', receivedQty: 5 }], // capped at remaining 3
      });

      expect(secondRun.status).toBe('received');
      expect(fake.documents.get('purchase_orders/po-1').status).toBe('received');
      expect(fake.documents.get('purchase_orders/po-1').items[0].receivedQuantity).toBe(5);
      expect(fake.documents.get('products/p1').stock.main).toBe(70); // 34 + 36
      // WAC = (34 * 1.85 + 36 * 2.00) / 70 = 134.90 / 70 = 1.93
      expect(fake.documents.get('products/p1').costPrice).toBe(1.93);
    });
  });

  describe('Variant + presentation combined pricing & stock check math', () => {
    it('combines presentation price and variant priceAdjustment scaled by conversionFactor', () => {
      const res = resolvePresentationVariantPrice({
        basePrice: 20,
        presentation: { id: 'box6', name: 'Pack x6', conversionFactor: 6, price: 110 },
        variant: { id: 'v-xl', name: 'Talla XL', priceAdjustment: 2.5 },
        minSalePrice: 18,
        enableMinSalePrice: true,
      });

      expect(res.factor).toBe(6);
      expect(res.unitPrice).toBe(125); // 110 + (2.5 * 6)
      expect(res.effectivePresentation?.conversionFactor).toBe(6);
      expect(res.effectivePresentation?.quantity).toBe(6);
      expect(res.effectivePresentation?.price).toBe(125);
    });

    it('derives variant delta from explicit variant.price and respects minSalePrice floors', () => {
      const withExplicitVariantPrice = resolvePresentationVariantPrice({
        basePrice: 20,
        presentation: { id: 'box6', name: 'Pack x6', factor: 6, price: 110 },
        variant: { id: 'v-prem', name: 'Edición Premium', price: 25 },
      });
      expect(withExplicitVariantPrice.unitPrice).toBe(140); // 110 + (25 - 20) * 6

      const clampedUnit = resolvePresentationVariantPrice({
        basePrice: 20,
        presentation: null,
        variant: { id: 'v-disc', name: 'Saldo', priceAdjustment: -8 },
        minSalePrice: 15,
        enableMinSalePrice: true,
      });
      expect(clampedUnit.unitPrice).toBe(15);

      const unclampedWhenDisabled = resolvePresentationVariantPrice({
        basePrice: 20,
        presentation: null,
        variant: { id: 'v-disc', name: 'Saldo', priceAdjustment: -8 },
        minSalePrice: 15,
        enableMinSalePrice: false,
      });
      expect(unclampedWhenDisabled.unitPrice).toBe(12);
    });

    it('computes real available stock capping by both reserved product stock and variant stock', () => {
      // Branch stock 30 - reserved 8 = 22 product available; variant stock = 15 => min = 15; pack x6 => 2 packs
      const variantLimited = resolvePresentationVariantStock({
        product: { stock: { main: 30 }, reservedStock: { main: 8 } },
        branchId: 'main',
        presentation: { id: 'box6', name: 'Pack x6', conversionFactor: 6, price: 110 },
        variant: { stock: { main: 15 } },
      });
      expect(variantLimited).toEqual({
        productAvailable: 22,
        variantStock: 15,
        effectiveAvailable: 15,
        factor: 6,
        maxUnits: 2,
      });

      // Branch stock 20 - reserved 11 = 9 product available; variant stock = 18 => min = 9; pack x6 => 1 pack
      const reservationLimited = resolvePresentationVariantStock({
        product: { stock: { main: 20 }, reservedStock: { main: 11 } },
        branchId: 'main',
        presentation: { id: 'box6', name: 'Pack x6', factor: 6, price: 110 },
        variant: { stock: { main: 18 } },
      });
      expect(reservationLimited).toEqual({
        productAvailable: 9,
        variantStock: 18,
        effectiveAvailable: 9,
        factor: 6,
        maxUnits: 1,
      });

      // No variant selected falls back directly to product available stock
      const baseOnly = resolvePresentationVariantStock({
        product: { stock: { main: 20 }, reservedStock: { main: 5 } },
        branchId: 'main',
        presentation: null,
        variant: null,
      });
      expect(baseOnly).toEqual({
        productAvailable: 15,
        variantStock: null,
        effectiveAvailable: 15,
        factor: 1,
        maxUnits: 15,
      });
    });
  });

  describe('Single-branch stock merge helper', () => {
    it('preserves edited formData.stock when editing an existing product on a single-branch account', () => {
      // Editing existing product from 12 -> 18 on active branch 'main'
      expect(
        mergeSingleBranchStock({
          existingStock: { main: 12 },
          stockByBranch: { main: 12 },
          singleBranchStock: 18,
          branchId: 'main',
          isMultiBranch: false,
        })
      ).toEqual({ main: 18 });

      // Editing stock explicitly down to 0 must preserve 0 (never revert to old stock)
      expect(
        mergeSingleBranchStock({
          existingStock: { main: 12 },
          stockByBranch: { main: 12 },
          singleBranchStock: 0,
          branchId: 'main',
          isMultiBranch: false,
        })
      ).toEqual({ main: 0 });

      // Single-branch product stored under a legacy/only branch key updates that key cleanly
      expect(
        mergeSingleBranchStock({
          existingStock: { legacy_store: 5 },
          stockByBranch: {},
          singleBranchStock: 14,
          branchId: 'main',
          isMultiBranch: false,
        })
      ).toEqual({ legacy_store: 14 });
    });

    it('merges multi-branch stock maps and aggregates variant stocks across branches', () => {
      expect(
        mergeSingleBranchStock({
          existingStock: { main: 5, north: 3 },
          stockByBranch: { main: 10, north: 7 },
          singleBranchStock: 99,
          branchId: 'main',
          isMultiBranch: true,
        })
      ).toEqual({ main: 10, north: 7 });

      expect(
        mergeSingleBranchStock({
          existingStock: { main: 10 },
          singleBranchStock: 99,
          branchId: 'main',
          isMultiBranch: false,
          variants: [
            { stock: { main: 4, north: 2 } },
            { stock: { main: 6, north: 3 } },
          ],
        })
      ).toEqual({ main: 10, north: 5 });
    });
  });
});
