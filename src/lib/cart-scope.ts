export function cartStorageKeys(accountId: string, branchId: string, uid: string) {
  const scope = [accountId, branchId, uid].map(encodeURIComponent).join(':');
  return { cart: `@ventify_cart:${scope}`, paused: `@ventify_paused:${scope}` };
}

export function canResumeCart(sale: { accountId?: string; branchId?: string }, accountId: string, branchId: string) {
  return sale.accountId === accountId && sale.branchId === branchId;
}
