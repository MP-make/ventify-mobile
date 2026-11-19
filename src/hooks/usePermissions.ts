import { useMemo, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  Permission,
  effectivePermissions,
  roleHasPermission,
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

  // Permisos efectivos memoizados
  const userPermissions = useMemo<Permission[]>(() => {
    return effectivePermissions(canonicalRole, typedCustomPermissions);
  }, [canonicalRole, typedCustomPermissions]);

  const getEffectivePermissions = useCallback((): Permission[] => {
    return userPermissions;
  }, [userPermissions]);

  const hasPermission = useCallback(
    (permission: Permission): boolean => {
      return roleHasPermission(canonicalRole, permission, typedCustomPermissions);
    },
    [canonicalRole, typedCustomPermissions]
  );

  const hasAnyPermission = useCallback(
    (permissions: Permission[]): boolean => {
      return permissions.some((p) => hasPermission(p));
    },
    [hasPermission]
  );

  const hasAllPermissions = useCallback(
    (permissions: Permission[]): boolean => {
      return permissions.every((p) => hasPermission(p));
    },
    [hasPermission]
  );

  // Atajos semánticos de negocio (booleans para compatibilidad total en pantallas móviles)
  const canManageProducts = useMemo(() => hasPermission('manage_products'), [hasPermission]);
  const canManageUsers = useMemo(() => hasPermission('manage_users'), [hasPermission]);
  const canViewReports = useMemo(() => hasPermission('view_reports'), [hasPermission]);
  const canAccessDashboard = useMemo(() => hasPermission('access_dashboard'), [hasPermission]);
  const canViewMargins = useMemo(() => hasPermission('view_margins'), [hasPermission]);
  const canViewInventoryValue = useMemo(
    () => hasPermission('view_inventory_value'),
    [hasPermission]
  );
  const canModifyPrice = useMemo(() => hasPermission('modify_price'), [hasPermission]);
  const canApplyDiscount = canModifyPrice;
  const canManageDiscounts = useMemo(() => hasPermission('manage_discounts'), [hasPermission]);
  const canProcessReturn = useMemo(() => hasPermission('process_return'), [hasPermission]);
  const canCreateCreditNotes = useMemo(() => hasPermission('create_credit_notes'), [hasPermission]);
  const canManageInventoryAdjustments = useMemo(
    () => hasPermission('manage_inventory_adjustments'),
    [hasPermission]
  );
  const canRequestTransfer = useMemo(() => hasPermission('request_transfer'), [hasPermission]);
  const canApproveTransfer = useMemo(() => hasPermission('approve_transfer'), [hasPermission]);
  const canManageTransfers = useMemo(() => hasPermission('manage_transfers'), [hasPermission]);
  const canManageCashRegister = useMemo(() => hasPermission('manage_cash_register'), [hasPermission]);
  const canManageCustomers = useMemo(() => hasPermission('manage_customers'), [hasPermission]);
  const canManageSettings = useMemo(() => hasPermission('manage_settings'), [hasPermission]);

  // Roles específicos
  const isOwner = useMemo(() => canonicalRole === 'owner', [canonicalRole]);
  const isAdmin = useMemo(() => canonicalRole === 'admin', [canonicalRole]);
  const isManager = useMemo(() => canonicalRole === 'manager', [canonicalRole]);
  const isCashier = useMemo(() => canonicalRole === 'cashier', [canonicalRole]);
  const isSeller = useMemo(() => canonicalRole === 'seller', [canonicalRole]);

  // Acceso a sucursales
  const hasMultiBranchAccess = useMemo(
    () => hasAllBranchesAccess({ role: canonicalRole, branchId, allBranchesAccess }),
    [canonicalRole, branchId, allBranchesAccess]
  );

  const checkCanAccessBranch = useCallback(
    (targetBranchId?: string | null): boolean => {
      return canAccessBranch(
        { role: canonicalRole, branchId, allBranchesAccess },
        targetBranchId
      );
    },
    [canonicalRole, branchId, allBranchesAccess]
  );

  // Solo owner y admin pueden supervisar todas las cajas abiertas y entrar a cajas de otras sucursales
  const canViewAllCashSessions = useMemo(
    () => canonicalRole === 'owner' || canonicalRole === 'admin',
    [canonicalRole]
  );

  const canViewBranchCashSessions = useMemo(
    () =>
      canonicalRole === 'owner' ||
      canonicalRole === 'admin' ||
      canonicalRole === 'manager' ||
      canManageCashRegister,
    [canonicalRole, canManageCashRegister]
  );

  const canViewOwnCashSession = true;

  // Helpers específicos de transferencias sincronizados con la versión web
  const canRequestTransferFromBranch = useCallback(
    (targetBranchId: string): boolean => {
      if (!canRequestTransfer) return false;
      if (canonicalRole === 'owner' || canonicalRole === 'admin') {
        return true;
      }
      if (canonicalRole === 'manager' || canonicalRole === 'cashier') {
        return canAccessBranch(
          { role: canonicalRole, branchId, allBranchesAccess },
          targetBranchId
        );
      }
      return false;
    },
    [canRequestTransfer, canonicalRole, branchId, allBranchesAccess]
  );

  const canApproveTransferToBranch = useCallback(
    (targetBranchId: string): boolean => {
      if (!canApproveTransfer) return false;
      if (canonicalRole === 'owner' || canonicalRole === 'admin') {
        return true;
      }
      if (canonicalRole === 'manager') {
        return canAccessBranch(
          { role: canonicalRole, branchId, allBranchesAccess },
          targetBranchId
        );
      }
      return false;
    },
    [canApproveTransfer, canonicalRole, branchId, allBranchesAccess]
  );

  const canCreateDirectTransfer = useMemo(
    () => canonicalRole === 'owner' || canonicalRole === 'admin',
    [canonicalRole]
  );

  const canViewTransfer = useCallback(
    (transfer: TransferScopeTarget): boolean => {
      if (canonicalRole === 'owner' || canonicalRole === 'admin') {
        return true;
      }
      if (canonicalRole === 'manager' || canonicalRole === 'cashier') {
        return (
          hasMultiBranchAccess ||
          branchId === transfer.sourceBranchId ||
          branchId === transfer.destinationBranchId
        );
      }
      return false;
    },
    [canonicalRole, hasMultiBranchAccess, branchId]
  );

  const canUpdateTransferStatus = useCallback(
    (transfer: TransferStatusTarget, newStatus: string): boolean => {
      if (canonicalRole === 'owner' || canonicalRole === 'admin') {
        return true;
      }
      switch (newStatus) {
        case 'approved':
        case 'rejected':
          return (
            canonicalRole === 'manager' &&
            (hasMultiBranchAccess || branchId === transfer.destinationBranchId) &&
            transfer.status === 'pending'
          );
        case 'in_transit':
          return (
            (canonicalRole === 'manager' || canonicalRole === 'cashier') &&
            (hasMultiBranchAccess || branchId === transfer.sourceBranchId) &&
            transfer.status === 'approved'
          );
        case 'completed':
          return (
            (canonicalRole === 'manager' || canonicalRole === 'cashier') &&
            (hasMultiBranchAccess || branchId === transfer.destinationBranchId) &&
            (transfer.status === 'in_transit' || transfer.status === 'approved')
          );
        default:
          return false;
      }
    },
    [canonicalRole, hasMultiBranchAccess, branchId]
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
      canRequestTransferFromBranch,
      canApproveTransferToBranch,
      canCreateDirectTransfer,
      canViewTransfer,
      canUpdateTransferStatus,
      canManageCashRegister,
      canManageCustomers,
      canManageSettings,
      canViewAllCashSessions,
      canViewBranchCashSessions,
      canViewOwnCashSession,
      isOwner,
      isAdmin,
      isManager,
      isCashier,
      isSeller,
      isSuperAdmin,
      hasAllBranchesAccess: hasMultiBranchAccess,
      allBranchesAccess: hasMultiBranchAccess,
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
      canRequestTransferFromBranch,
      canApproveTransferToBranch,
      canCreateDirectTransfer,
      canViewTransfer,
      canUpdateTransferStatus,
      canManageCashRegister,
      canManageCustomers,
      canManageSettings,
      canViewAllCashSessions,
      canViewBranchCashSessions,
      canViewOwnCashSession,
      isOwner,
      isAdmin,
      isManager,
      isCashier,
      isSeller,
      isSuperAdmin,
      hasMultiBranchAccess,
      checkCanAccessBranch,
    ]
  );
}
