/**
 * Deriva el campo denormalizado `branchIds` de un producto a partir de su
 * mapa de stock (`{ branchId: cantidad }`). Firestore no puede filtrar por
 * la existencia de una key dentro de un mapa, así que `branchIds` es lo que
 * permite `where('branchIds', 'array-contains', branchId)` en vez de traer
 * el catálogo completo de la cuenta y filtrar en el cliente.
 *
 * Si el producto no tiene ninguna entrada de stock (recién creado sin
 * sucursal asignada, o dato legado), se usa `fallbackBranchIds` (todas las
 * sucursales activas de la cuenta) para no ocultarlo por accidente de
 * ninguna vista filtrada por sucursal.
 */
export const deriveBranchIds = (
  stock: Record<string, number> | null | undefined,
  fallbackBranchIds: string[] = []
): string[] => {
  const ids = Object.keys(stock || {});
  return ids.length > 0 ? ids : fallbackBranchIds;
};

/** Umbral (unidades disponibles) a partir del cual un producto se considera
 *  con stock bajo. Es el mismo valor que el dashboard pide por parámetro; al
 *  denormalizarse en el documento tiene que ser una constante compartida. */
export const LOW_STOCK_THRESHOLD = 5;

/** Sentinel que se añade a `lowStockBranches` cuando el producto tiene stock
 *  bajo en ALGUNA sucursal. Firestore no sabe consultar "array no vacío", así
 *  que la vista "todas las sucursales" filtra por este valor con
 *  `array-contains` en vez de traer el catálogo completo. */
export const LOW_STOCK_ANY = '__any__';

/**
 * Deriva el campo denormalizado `lowStockBranches` de un producto: las
 * sucursales donde el stock disponible (stock físico menos el reservado) está
 * en o por debajo de `threshold`, más el sentinel `LOW_STOCK_ANY`.
 *
 * Se excluye el stock negativo, igual que hacía el cálculo en cliente: un
 * disponible menor que cero es un descuadre de inventario, no un aviso de
 * reposición.
 */
export const deriveLowStockBranches = (
  stock: Record<string, number> | null | undefined,
  reservedStock?: Record<string, number> | null,
  threshold: number = LOW_STOCK_THRESHOLD
): string[] => {
  const branches = Object.keys(stock || {}).filter((branchId) => {
    const available = (stock?.[branchId] || 0) - (reservedStock?.[branchId] || 0);
    return available <= threshold && available >= 0;
  });
  return branches.length > 0 ? [LOW_STOCK_ANY, ...branches] : [];
};
