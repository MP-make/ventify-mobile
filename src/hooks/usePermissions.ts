import { useMemo, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  Permission,
  effectivePermissions,
  normalizeRole,
  Role,
  type CustomPermissions,
} from '@/lib/role-permissions';
import { hasAllBranchesAccess, canAccessBranch } from '@/lib/branch-access';

export interface TransferScopeTarget {
  sourceBranchId: string;
  destinationBranchId: string;
}

export interface TransferStatusTarget extends TransferScopeTarget {
  status: string;
}

export function usePermissions() {
  const { role, customPermissions, branchId, allBranchesAccess, isSuperAdmin } = useAuth();

  const canonicalRole: Role = useMemo(() => normalizeRole(role), [role]);
  const typedCustomPermissions = customPermissions as CustomPermissions | null | undefined;

  const userPermissions = useMemo<Permission[]>(
    () => effectivePermissions(canonicalRole, typedCustomPermissions),
    [canonicalRole, typedCustomPermissions]
  );

  const permissionSet = useMemo(() => new Set<Permission>(userPermissions), [userPermissions]);

  const getEffectivePermissions = useCallback((): Permission[] => userPermissions, [userPermissions]);

  const hasPermission = useCallback(
    (permission: Permission): boolean => permissionSet.has(permission),
    [permissionSet]
  );

  const hasAnyPermission = useCallback(
    (permissions: Permission[]): boolean => permissions.some((p) => permissionSet.has(p)),
    [permissionSet]
  );

  const hasAllPermissions = useCallback(
    (permissions: Permission[]): boolean => permissions.every((p) => permissionSet.has(p)),
    [permissionSet]
  );

  const derived = useMemo(() => {
    const canManageProducts = permissionSet.has('manage_products');
    const canManageUsers = permissionSet.has('manage_users');
    const canViewReports = permissionSet.has('view_reports');
    const canAccessDashboard = permissionSet.has('access_dashboard');
    const canViewMargins = permissionSet.has('view_margins');
    const canViewInventoryValue = permissionSet.has('view_inventory_value');
    const canModifyPrice = permissionSet.has('modify_price');
    const canApplyDiscount = canModifyPrice;
    const canManageDiscounts = permissionSet.has('manage_discounts');
    const canProcessReturn = permissionSet.has('process_return');
    const canCreateCreditNotes = permissionSet.has('create_credit_notes');
    const canManageInventoryAdjustments = permissionSet.has('manage_inventory_adjustments');
    const canRequestTransfer = permissionSet.has('request_transfer');
    const canApproveTransfer = permissionSet.has('approve_transfer');
    const canManageTransfers = permissionSet.has('manage_transfers');
    const canManageCashRegister = permissionSet.has('manage_cash_register');
    const canManageCustomers = permissionSet.has('manage_customers');
    const canManageSettings = permissionSet.has('manage_settings');

    const isOwner = canonicalRole === 'owner';
    const isAdmin = canonicalRole === 'admin';
    const isManager = canonicalRole === 'manager';
    const isCashier = canonicalRole === 'cashier';
    const isSeller = canonicalRole === 'seller';

    const hasMultiBranchAccess = hasAllBranchesAccess({
      role: canonicalRole,
      branchId,
      allBranchesAccess,
    });
    const canViewAllCashSessions = isOwner || isAdmin;
    const canViewBranchCashSessions = isOwner || isAdmin || isManager || canManageCashRegister;
    const canCreateDirectTransfer = isOwner || isAdmin;

    return {
      canManageProducts,
      canManageUsers,
      canViewReports,
      canAccessDashboard,
      canViewMargins,
      canViewInventoryValue,
      canModifyPrice,
      canApplyDiscount,
      canManageDiscounts,
      canProcessReturn,
      canCreateCreditNotes,
      canManageInventoryAdjustments,
      canRequestTransfer,
      canApproveTransfer,
      canManageTransfers,
      canManageCashRegister,
      canManageCustomers,
      canManageSettings,
      isOwner,
      isAdmin,
      isManager,
      isCashier,
      isSeller,
      hasMultiBranchAccess,
      canViewAllCashSessions,
      canViewBranchCashSessions,
      canCreateDirectTransfer,
    };
  }, [permissionSet, canonicalRole, branchId, allBranchesAccess]);

  const checkCanAccessBranch = useCallback(
    (targetBranchId?: string | null): boolean =>
      canAccessBranch({ role: canonicalRole, branchId, allBranchesAccess }, targetBranchId),
    [canonicalRole, branchId, allBranchesAccess]
  );

  const canRequestTransferFromBranch = useCallback(
    (targetBranchId: string): boolean => {
      if (!derived.canRequestTransfer) return false;
      if (derived.isOwner || derived.isAdmin) return true;
      if (derived.isManager || derived.isCashier) {
        return canAccessBranch({ role: canonicalRole, branchId, allBranchesAccess }, targetBranchId);
      }
      return false;
    },
    [derived.canRequestTransfer, derived.isOwner, derived.isAdmin, derived.isManager, derived.isCashier, canonicalRole, branchId, allBranchesAccess]
  );

  const canApproveTransferToBranch = useCallback(
    (targetBranchId: string): boolean => {
      if (!derived.canApproveTransfer) return false;
      if (derived.isOwner || derived.isAdmin) return true;
      if (derived.isManager) {
        return canAccessBranch({ role: canonicalRole, branchId, allBranchesAccess }, targetBranchId);
      }
      return false;
    },
    [derived.canApproveTransfer, derived.isOwner, derived.isAdmin, derived.isManager, canonicalRole, branchId, allBranchesAccess]
  );

  const canViewTransfer = useCallback(
    (transfer: TransferScopeTarget): boolean => {
      if (derived.isOwner || derived.isAdmin) return true;
      if (derived.isManager || derived.isCashier) {
        return (
          derived.hasMultiBranchAccess ||
          branchId === transfer.sourceBranchId ||
          branchId === transfer.destinationBranchId
        );
      }
      return false;
    },
    [derived.isOwner, derived.isAdmin, derived.isManager, derived.isCashier, derived.hasMultiBranchAccess, branchId]
  );

  const canUpdateTransferStatus = useCallback(
    (transfer: TransferStatusTarget, newStatus: string): boolean => {
      if (derived.isOwner || derived.isAdmin) return true;
      switch (newStatus) {
        case 'approved':
        case 'rejected':
          return (
            derived.isManager &&
            (derived.hasMultiBranchAccess || branchId === transfer.destinationBranchId) &&
            transfer.status === 'pending'
          );
        case 'in_transit':
          return (
            (derived.isManager || derived.isCashier) &&
            (derived.hasMultiBranchAccess || branchId === transfer.sourceBranchId) &&
            transfer.status === 'approved'
          );
        case 'completed':
          return (
            (derived.isManager || derived.isCashier) &&
            (derived.hasMultiBranchAccess || branchId === transfer.destinationBranchId) &&
            (transfer.status === 'in_transit' || transfer.status === 'approved')
          );
        default:
          return false;
      }
    },
    [derived.isOwner, derived.isAdmin, derived.isManager, derived.isCashier, derived.hasMultiBranchAccess, branchId]
  );

  const getUserRole = useCallback((): Role => canonicalRole, [canonicalRole]);

  return useMemo(
    () => ({
      role: canonicalRole,
      userRole: canonicalRole,
      userBranchId: branchId,
      permissions: userPermissions,
      getEffectivePermissions,
      getUserRole,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      ...derived,
      canViewOwnCashSession: true,
      canRequestTransferFromBranch,
      canApproveTransferToBranch,
      canViewTransfer,
      canUpdateTransferStatus,
      isSuperAdmin,
      hasAllBranchesAccess: derived.hasMultiBranchAccess,
      allBranchesAccess: derived.hasMultiBranchAccess,
      canAccessBranch: checkCanAccessBranch,
    }),
    [
      canonicalRole,
      branchId,
      userPermissions,
      getEffectivePermissions,
      getUserRole,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
      derived,
      canRequestTransferFromBranch,
      canApproveTransferToBranch,
      canViewTransfer,
      canUpdateTransferStatus,
      isSuperAdmin,
      checkCanAccessBranch,
    ]
  );
}
