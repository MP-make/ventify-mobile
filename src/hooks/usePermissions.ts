import { useMemo, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  Permission,
  effectivePermissions,
  roleHasPermission,
  normalizeRole,
  Role,
} from '@/lib/role-permissions';
import { hasAllBranchesAccess, canAccessBranch } from '@/lib/branch-access';

export function usePermissions() {
  const { role, customPermissions, branchId, allBranchesAccess } = useAuth();

  const canonicalRole: Role = useMemo(() => normalizeRole(role), [role]);

  // Permisos efectivos memoizados
  const userPermissions = useMemo<Permission[]>(() => {
    return effectivePermissions(canonicalRole, customPermissions as any);
  }, [canonicalRole, customPermissions]);

  const hasPermission = useCallback(
    (permission: Permission): boolean => {
      return roleHasPermission(canonicalRole, permission, customPermissions as any);
    },
    [canonicalRole, customPermissions]
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

  // Atajos semánticos de negocio
  const canManageProducts = useMemo(() => hasPermission('manage_products'), [hasPermission]);
  const canManageUsers = useMemo(() => hasPermission('manage_users'), [hasPermission]);
  const canViewReports = useMemo(() => hasPermission('view_reports'), [hasPermission]);
  const canViewMargins = useMemo(() => hasPermission('view_margins'), [hasPermission]);
  const canModifyPrice = useMemo(() => hasPermission('modify_price'), [hasPermission]);
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

  return {
    role: canonicalRole,
    permissions: userPermissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    canManageProducts,
    canManageUsers,
    canViewReports,
    canViewMargins,
    canModifyPrice,
    canProcessReturn,
    canCreateCreditNotes,
    canManageInventoryAdjustments,
    canRequestTransfer,
    canApproveTransfer,
    canManageTransfers,
    canManageCashRegister,
    canManageCustomers,
    canManageSettings,
    canViewAllCashSessions,
    isOwner,
    isAdmin,
    isManager,
    isCashier,
    isSeller,
    hasAllBranchesAccess: hasMultiBranchAccess,
    canAccessBranch: checkCanAccessBranch,
  };
}
