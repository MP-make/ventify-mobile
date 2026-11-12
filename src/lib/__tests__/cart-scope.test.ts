import { describe, expect, it } from 'vitest';
import { cartStorageKeys, canResumeCart } from '../cart-scope';

describe('cart isolation on shared terminals', () => {
  it('separates carts by account, operator and branch', () => {
    const keys = [cartStorageKeys('a','b','u'),cartStorageKeys('other','b','u'),cartStorageKeys('a','other','u'),cartStorageKeys('a','b','other')];
    expect(new Set(keys.map(k => k.cart)).size).toBe(4);
    expect(new Set(keys.map(k => k.paused)).size).toBe(4);
  });
  it('does not resume a sale from another account or branch', () => {
    expect(canResumeCart({accountId:'a',branchId:'b'},'a','b')).toBe(true);
    expect(canResumeCart({accountId:'a',branchId:'b'},'other','b')).toBe(false);
    expect(canResumeCart({accountId:'a',branchId:'b'},'a','other')).toBe(false);
    expect(canResumeCart({},'a','b')).toBe(false);
  });
});
