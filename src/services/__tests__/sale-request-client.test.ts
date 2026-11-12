import { describe, expect, it, vi } from 'vitest';
const { apiRequest } = vi.hoisted(()=>({apiRequest:vi.fn(async()=>({success:true}))}));
vi.mock('@/lib/api-client',()=>({apiRequest}));
vi.mock('@/lib/firebase',()=>({db:{},auth:{}}));
import { resolveSaleRequest } from '../enterprise-ops-service';
it('assigns the active accessible branch when approving an unassigned storefront request',async()=>{
  await resolveSaleRequest('request-1','approved',null,'Autorizado','branch-a');
  expect(apiRequest).toHaveBeenCalledWith('/api/admin/sale-requests/request-1',{method:'PATCH',body:{status:'approved',reviewNotes:'Autorizado',branchId:'branch-a'}});
});
