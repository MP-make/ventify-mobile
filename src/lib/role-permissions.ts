/**
 * Matriz de permisos por rol, compartida y sincronizada con la versión Web de Ventify.
 * Soporta roles estándar y permisos personalizados (customPermissions.granted y customPermissions.revoked).
 */

export type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'seller';

// Todos los permisos disponibles en el sistema
export type Permission =
  // Ventas
  | 'register_sale'
  | 'associate_customer'
  | 'modify_price'
  | 'process_return'
  | 'create_credit_notes'

  // Inventario
  | 'manage_products'
  | 'manage_inventory_adjustments'
  | 'request_transfer'
  | 'approve_transfer'
  | 'manage_transfers'

  // Clientes
  | 'manage_customers'

  // Pedidos
  | 'view_orders'
  | 'create_orders'
  | 'accept_orders'

  // Reportes y Dashboard
  | 'access_dashboard'
  | 'view_reports'
  | 'view_own_sales'

  // Finanzas
  | 'view_margins'
  | 'view_inventory_value'

  // Caja
  | 'manage_cash_register'

  // Administración
  | 'manage_users'
  | 'manage_branches'
  | 'manage_settings'
  | 'manage_discounts'

  // Acceso a Pestañas
  | 'access_sales'
  | 'access_sale_requests'
  | 'access_products'
  | 'access_inventory'
  | 'access_suppliers'
  | 'access_customers'
  | 'access_transfers'
  | 'access_cash_management'
  | 'access_branches'
  | 'access_reports'
  | 'access_users'
  | 'access_settings';

export interface CustomPermissions {
  granted?: Permission[];
  revoked?: Permission[];
}

export interface RolePermissions {
  owner: Permission[];
  admin: Permission[];
  manager: Permission[];
  cashier: Permission[];
  seller: Permission[];
}

export const ROLE_PERMISSIONS: RolePermissions = {
  seller: ['view_own_sales'],
  owner: [
    'register_sale',
    'associate_customer',
    'modify_price',
    'process_return',
    'manage_products',
    'manage_users',
    'manage_branches',
    'view_reports',
    'manage_cash_register',
    'request_transfer',
    'approve_transfer',
    'manage_transfers',
    'access_dashboard',
    'manage_inventory_adjustments',
    'manage_customers',
    'manage_settings',
    'manage_discounts',
    'create_credit_notes',
    'view_orders',
    'create_orders',
    'accept_orders',
    'view_margins',
    'view_inventory_value',
    'access_sales',
    'access_sale_requests',
    'access_products',
    'access_inventory',
    'access_suppliers',
    'access_customers',
    'access_transfers',
    'access_cash_management',
    'access_branches',
    'access_reports',
    'access_users',
    'access_settings',
  ],
  admin: [
    'register_sale',
    'associate_customer',
    'modify_price',
    'process_return',
    'manage_products',
    'manage_users',
    'manage_branches',
    'view_reports',
    'manage_cash_register',
    'request_transfer',
    'approve_transfer',
    'manage_transfers',
    'access_dashboard',
    'manage_inventory_adjustments',
    'manage_customers',
    'manage_settings',
    'manage_discounts',
    'create_credit_notes',
    'view_orders',
    'create_orders',
    'accept_orders',
    'view_margins',
    'view_inventory_value',
    'access_sales',
    'access_sale_requests',
    'access_products',
    'access_inventory',
    'access_suppliers',
    'access_customers',
    'access_transfers',
    'access_cash_management',
    'access_branches',
    'access_reports',
    'access_users',
    'access_settings',
  ],
  manager: [
    'register_sale',
    'associate_customer',
    'modify_price',
    'process_return',
    'manage_products',
    'view_reports',
    'manage_cash_register',
    'request_transfer',
    'approve_transfer',
    'manage_transfers',
    'access_dashboard',
    'manage_customers',
    'create_credit_notes',
    'view_orders',
    'create_orders',
    'accept_orders',
    'access_sales',
    'access_sale_requests',
    'access_products',
    'access_inventory',
    'access_suppliers',
    'access_customers',
    'access_transfers',
    'access_cash_management',
    'access_reports',
  ],
  cashier: [
    'register_sale',
    'associate_customer',
    'modify_price',
    'process_return',
    'request_transfer',
    'manage_customers',
    'access_sales',
    'access_customers',
    'access_transfers',
  ],
};

/**
 * Normaliza cualquier variante de nombre de rol (español o inglés) al formato canonical.
 */
export function normalizeRole(rawRole?: string): Role {
  if (!rawRole) return 'cashier';
  const lower = rawRole.toLowerCase().trim();
  if (lower === 'owner' || lower === 'propietario' || lower === 'dueño' || lower === 'dueno') return 'owner';
  if (lower === 'admin' || lower === 'administrador') return 'admin';
  if (lower === 'manager' || lower === 'gerente' || lower === 'encargado') return 'manager';
  if (lower === 'cashier' || lower === 'cajero') return 'cashier';
  if (lower === 'seller' || lower === 'vendedor') return 'seller';
  return 'cashier';
}

/**
 * Permisos efectivos de un rol, aplicando los permisos personalizados del
 * usuario (primero se agregan los `granted`, después se quitan los `revoked`).
 */
export function effectivePermissions(
  role: string | undefined,
  customPermissions?: CustomPermissions | null
): Permission[] {
  const canonRole = normalizeRole(role);
  const base = ROLE_PERMISSIONS[canonRole] || [];

  if (canonRole === 'seller') {
    return base.filter((p) => !customPermissions?.revoked?.includes(p));
  }

  if (!customPermissions) return base;

  const granted = (customPermissions.granted || []) as Permission[];
  const revoked = (customPermissions.revoked || []) as Permission[];
  const set = new Set<Permission>([...base, ...granted]);
  revoked.forEach((p) => set.delete(p));
  return [...set];
}

/**
 * Chequeo puntual de un permiso respetando la matriz del rol y personalizaciones.
 */
export function roleHasPermission(
  role: string | undefined,
  permission: Permission,
  customPermissions?: CustomPermissions | null
): boolean {
  return effectivePermissions(role, customPermissions).includes(permission);
}
