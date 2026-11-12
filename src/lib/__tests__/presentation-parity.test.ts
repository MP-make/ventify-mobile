import { describe, expect, it } from 'vitest';
import { normalizePresentation, presentationFactor, reservationCartLines } from '../presentation-parity';
import { findProductByBarcode } from '../product-search';
describe('presentation stock parity',()=>{
  it('normalizes legacy factor and selects twelve units from its barcode',()=>{
    const legacy={id:'box',name:'Caja x12',factor:12,price:30,barcode:'BOX12'};
    const product={id:'p_1',name:'Product',price:3,presentations:[legacy]} as any;
    expect(normalizePresentation(legacy).conversionFactor).toBe(12);
    const match=findProductByBarcode([product],'BOX12');
    expect(presentationFactor(match!.matchedPresentation)).toBe(12);
    expect(match!.matchedPresentation!.conversionFactor).toBe(12);
  });
  it('keeps canonical product/variant/presentation IDs in reservations',()=>{
    const [line]=reservationCartLines([{id:'p_1_box_red',productId:'p_1',name:'Product',quantity:1,price:30,variant:{id:'red',name:'Roja'},presentation:{id:'box',name:'Caja',factor:12,price:30}}] as any);
    expect(line).toMatchObject({productId:'p_1',id:'p_1',variantId:'red',presentationId:'box',presentationQty:12,conversionFactor:12,quantity:1});
  });
});
