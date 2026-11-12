import { describe, expect, it } from 'vitest';
import { catalogAttributeUpdate, catalogSizeInput } from '../product-attributes';

describe('catalog attribute editing parity', () => {
  const product = { brand: 'Ventify', sizeLabel: 'S', sizes: ['S', 'M', 'L'] };
  it('round-trips all existing sizes when another field is edited', () => {
    expect(catalogAttributeUpdate(product, true, 'Ventify', catalogSizeInput(product))).toEqual(product);
  });
  it('preserves hidden attributes when catalog filters are disabled', () => {
    expect(catalogAttributeUpdate(product, false, '', '')).toEqual(product);
  });
  it('supports adding, removing and deduplicating multiple sizes explicitly', () => {
    expect(catalogAttributeUpdate(product, true, 'New', ' M, XL, M ')).toEqual({brand:'New',sizeLabel:'M',sizes:['M','XL']});
    expect(catalogAttributeUpdate(product, true, '', '')).toEqual({brand:'',sizeLabel:'',sizes:[]});
  });
});
