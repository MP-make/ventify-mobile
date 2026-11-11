/** Branch scope is explicit; missing legacy data never grants global access. */
export interface BranchAccess {
  role?: string;
  branchId?: string | null;
  allBranchesAccess?: boolean;
}

export function hasAllBranchesAccess(user: BranchAccess): boolean {
  return (
    user.role === 'owner' ||
    user.role === 'admin' ||
    ((user.role === 'manager' || user.role === 'cashier') && user.allBranchesAccess === true)
  );
}

export function canAccessBranch(user: BranchAccess, branchId: string | null | undefined): boolean {
  return (
    !!branchId &&
    branchId !== 'all' &&
    (hasAllBranchesAccess(user) ||
      (!!user.branchId && user.branchId !== 'all' && user.branchId === branchId))
  );
}
