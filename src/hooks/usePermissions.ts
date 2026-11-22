import { useContext } from 'react';
import {
  PermissionsContext,
  PermissionsProvider,
  useAuthSession,
  useComputedPermissions,
  type TransferScopeTarget,
  type TransferStatusTarget,
  type UsePermissionsResult,
} from '@/context/AuthContext';

export {
  PermissionsContext,
  PermissionsProvider,
  type TransferScopeTarget,
  type TransferStatusTarget,
  type UsePermissionsResult,
};

function useFallbackPermissions(): UsePermissionsResult {
  const { role, customPermissions, branchId, allBranchesAccess, isSuperAdmin } = useAuthSession();
  return useComputedPermissions({
    role,
    customPermissions,
    branchId,
    allBranchesAccess,
    isSuperAdmin,
  });
}

export function usePermissions(): UsePermissionsResult {
  const provided = PermissionsContext ? useContext(PermissionsContext) : null;
  if (provided) return provided;
  return useFallbackPermissions();
}
