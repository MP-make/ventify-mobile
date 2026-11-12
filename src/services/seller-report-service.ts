import { apiRequest } from '@/lib/api-client';

export interface SellerMetadata {
  seller: { name: string };
  branches: Array<{ id: string; name: string }>;
  today: string;
  timeZone: string;
}
export interface SellerOwnReport {
  report: {
    totalGross: number; totalRefunds: number; totalNet: number;
    rows: Array<{ salesCount: number }>;
  };
  recentSales: Array<{ id: string; saleNumber?: number; date: number; total: number; paymentMethod: string; customerName?: string; isReturn?: boolean }>;
}
export const fetchSellerMetadata = () => apiRequest<SellerMetadata>('/api/sales/my-performance?metadata=1');
export function fetchSellerPerformance(fromDay: string, toDay: string, branchId: string) {
  const params = new URLSearchParams({ fromDay, toDay, includeRanking: 'false' });
  if (branchId) params.set('branchId', branchId);
  // Identity is never supplied by the caller: server derives the seller from JWT.
  return apiRequest<SellerOwnReport>(`/api/sales/my-performance?${params}`);
}
