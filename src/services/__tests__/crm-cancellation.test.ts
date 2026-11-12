import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ docs: new Map<string, any>(), writes: [] as string[] }));
vi.mock('@/lib/firebase', () => ({db:{},auth:{currentUser:{uid:'u1'}}}));
vi.mock('@/lib/api-client', () => ({apiRequest:vi.fn()}));
vi.mock('firebase/firestore', () => ({
  doc: (_db:any, collection:string, id:string) => ({path:`${collection}/${id}`}),
  collection: vi.fn(), query:vi.fn(),where:vi.fn(),getDocs:vi.fn(),setDoc:vi.fn(),updateDoc:vi.fn(),
  serverTimestamp: () => 'server-now',
  runTransaction: async (_db:any, callback:any) => {
    let written=false;
    const pending: Array<()=>void> = [];
    await callback({
      get:async (ref:any)=>{ if(written)throw Error('read after write');const data=fake.docs.get(ref.path);return{exists:()=>Boolean(data),data:()=>structuredClone(data)};},
      update:(ref:any,data:any)=>{written=true;pending.push(()=>{
        const current=structuredClone(fake.docs.get(ref.path));
        for(const[key,value]of Object.entries(data)){const parts=key.split('.');let node=current;for(const part of parts.slice(0,-1))node=node[part]||=( {} );node[parts.at(-1)!]=value;}
        fake.docs.set(ref.path,current);fake.writes.push(ref.path);
      });},
    });
    pending.forEach(apply=>apply());
  },
}));
import { apiRequest } from '@/lib/api-client';
import { completeOrCancelReservation } from '../crm-operations-service';
const actor={uid:'u1',displayName:'Owner'};
const stale={id:'r1',type:'reservation',accountId:'a1',branchId:'b1',items:[{productId:'p1',quantity:99,price:1}],remainingAmount:100} as any;
describe('atomic CRM cancellation',()=>{
  beforeEach(()=>{
    fake.docs.clear();fake.writes=[];
    fake.docs.set('products/p1',{accountId:'a1',stock:{b1:100},reservedStock:{b1:10}});
    fake.docs.set('reservations/r1',{accountId:'a1',branchId:'b1',status:'pending',attributionVersion:1,items:[{id:'p1',quantity:1,price:1},{id:'p1',quantity:1,presentationQty:2,price:2}]});
  });
  it('sends the selected payment method and seller to the shared completion transaction',async()=>{
    await completeOrCancelReservation({...stale,total:100},'complete',actor,{sessionId:'session-1',amount:100,paymentMethod:'Visa',paymentMethodId:'visa-terminal',paymentCategory:'card',sellerId:'seller-1',sellerName:'Ana'});
    expect(apiRequest).toHaveBeenCalledWith('/api/sales/finalize',expect.objectContaining({body:expect.objectContaining({sale:expect.objectContaining({paymentMethod:'Visa',paymentMethodId:'visa-terminal',paymentCategory:'card',sellerId:'seller-1',sellerName:'Ana'})})}));
  });
  it('releases the current grouped reservation once, preserving physical stock and other reservations',async()=>{
    await completeOrCancelReservation(stale,'cancel',actor);
    expect(fake.docs.get('products/p1')).toMatchObject({stock:{b1:100},reservedStock:{b1:7}});
    expect(fake.writes.filter(path=>path==='products/p1')).toHaveLength(1);
    expect(fake.docs.get('reservations/r1').status).toBe('cancelled');
    await expect(completeOrCancelReservation(stale,'cancel',actor)).rejects.toThrow();
    expect(fake.docs.get('products/p1').reservedStock.b1).toBe(7);
  });
  it('cancels pending unapproved orders without releasing another document’s stock',async()=>{
    fake.docs.set('orders/r1',fake.docs.get('reservations/r1'));
    await completeOrCancelReservation({...stale,type:'order'},'cancel',actor);
    expect(fake.docs.get('products/p1').reservedStock.b1).toBe(10);
  });
  it('releases stock held at creation by historical mobile pending orders',async()=>{
    fake.docs.set('orders/r1',{accountId:'a1',branchId:'b1',status:'pending',items:[{productId:'p1',productName:'Legacy',quantity:2,price:1}]});
    await completeOrCancelReservation({...stale,type:'order'},'cancel',actor);
    expect(fake.docs.get('products/p1').reservedStock.b1).toBe(8);
  });
  it('rejects stale final states, tenant changes and fiado cancellation before writes',async()=>{
    for(const override of [{status:'delivered'},{accountId:'other'},{type:'fiado'},{isCreditSale:true}]){
      fake.docs.set('reservations/r1',{...fake.docs.get('reservations/r1'),status:'pending',accountId:'a1',type:'reservation',isCreditSale:false,...override});
      await expect(completeOrCancelReservation(stale,'cancel',actor)).rejects.toThrow();
      expect(fake.writes).toHaveLength(0);
    }
  });
});
