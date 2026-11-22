import { apiRequest } from '@/lib/api-client';
import { auth } from '@/lib/firebase';
import { sharedRequestCache } from '@/lib/request-cache';

const SELLER_REPORT_CACHE_TTL_MS = 45_000;

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
export const fetchSellerMetadata = (options?: { signal?: AbortSignal; forceRefresh?: boolean }) => {
  const uid = auth.currentUser?.uid || 'anon';
  return sharedRequestCache.getOrLoad(
    `seller_meta:${uid}`,
    SELLER_REPORT_CACHE_TTL_MS,
    () =>
      apiRequest<SellerMetadata>('/api/sales/my-performance?metadata=1', {
        signal: options?.signal,
      }),
    { forceRefresh: options?.forceRefresh }
  );
};
export function fetchSellerPerformance(
  fromDay: string,
  toDay: string,
  branchId: string,
  options?: { signal?: AbortSignal; forceRefresh?: boolean }
) {
  const uid = auth.currentUser?.uid || 'anon';
  const params = new URLSearchParams({ fromDay, toDay, includeRanking: 'false' });
  if (branchId) params.set('branchId', branchId);
  // Identity is never supplied by the caller: server derives the seller from JWT.
  return sharedRequestCache.getOrLoad(
    `seller_perf:${uid}:${fromDay}:${toDay}:${branchId || 'all'}`,
    SELLER_REPORT_CACHE_TTL_MS,
    () =>
      apiRequest<SellerOwnReport>(`/api/sales/my-performance?${params}`, {
        signal: options?.signal,
      }),
    { forceRefresh: options?.forceRefresh }
  );
}
