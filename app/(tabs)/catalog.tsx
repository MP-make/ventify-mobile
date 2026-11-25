import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  InteractionManager,
  useWindowDimensions,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  Package,
  Plus,
  Search,
  X,
  ArrowRightLeft,
  History,
  AlertTriangle,
  RefreshCw,
  Building2,
  Truck,
  Barcode,
  ChevronDown,
  ChevronUp,
  Lock,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';

import {
  useProductsCatalog,
  useProductsStats,
  useProductPlanLimit,
} from '@/context/ProductsContext';
import {
  useAuthSession,
  usePlanAccessActions,
  useNetworkStatus,
  usePlanFeatures,
} from '@/context/AuthContext';
import { PlanLockedView } from '@/components/PlanFeatureGate';
import { useBusinessSettings, useOfflineStatus } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { checkIsOnlineLive, assertOnlineForWrite } from '@/lib/online-guard';
import {
  generateOfflineProductId,
  enqueueOfflineProductCreate,
  enqueueOfflineProductUpdate,
  enqueueOfflineStockAdjust,
} from '@/services/offline-inventory-service';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import {
  adjustProductStock,
  getProductKardex,
  getCachedProductKardexSync,
  getStockTransfers,
  getCachedStockTransfersSync,
  approveStockTransfer,
  rejectStockTransfer,
  cancelStockTransfer,
  sendStockTransfer,
  completeStockTransfer,
  saveProduct,
  emitTransferDespatchGuide,
  isLocalFileUri,
  mergeSingleBranchStock,
  sanitizeRemoteImageUrls,
  uploadProductImageToStorage,
  type StockTransfer,
} from '@/services/inventory-kardex-service';
import type { ProductFormModal as ProductFormModalType, ProductFormData } from '@/components/ProductFormModal';
import { collection, query, where, getDocs, limit as fsLimit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { SuppliersPurchaseModal } from '@/components/SuppliersPurchaseModal';
import { InlineFilterBar, type FilterGroup, type FilterOption } from '@/components/InlineFilterBar';
import type { BarcodeScannerModal as BarcodeScannerModalType } from '@/components/BarcodeScannerModal';
import type { QuickStockAdjustModal as QuickStockAdjustModalType } from '@/components/catalog/QuickStockAdjustModal';
import type { NewTransferModal as NewTransferModalType } from '@/components/catalog/NewTransferModal';
import {
  filterCatalogIndex,
  getCatalogCategoryCounts,
} from '@/lib/catalog-filters';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useFocusMemo } from '@/hooks/use-focus-memo';
import { catalogSizeInput } from '@/lib/product-attributes';
import type { Product, ProductAttribute } from '@/types';

let cachedProductFormModal: typeof ProductFormModalType | null = null;
const getProductFormModal = () =>
  (cachedProductFormModal ??= (require('@/components/ProductFormModal') as typeof import('@/components/ProductFormModal')).ProductFormModal);

let cachedNewTransferModal: typeof NewTransferModalType | null = null;
const getNewTransferModal = () =>
  (cachedNewTransferModal ??= (require('@/components/catalog/NewTransferModal') as typeof import('@/components/catalog/NewTransferModal')).NewTransferModal);

let cachedQuickStockAdjustModal: typeof QuickStockAdjustModalType | null = null;
const getQuickStockAdjustModal = () =>
  (cachedQuickStockAdjustModal ??= (require('@/components/catalog/QuickStockAdjustModal') as typeof import('@/components/catalog/QuickStockAdjustModal')).QuickStockAdjustModal);

let cachedBarcodeScannerModal: typeof BarcodeScannerModalType | null = null;
const getBarcodeScannerModal = () =>
  (cachedBarcodeScannerModal ??= (require('@/components/BarcodeScannerModal') as typeof import('@/components/BarcodeScannerModal')).BarcodeScannerModal);

type ActiveTab = 'inventory' | 'kardex' | 'transfers' | 'purchases';
type StockStatusFilter = 'all' | 'low' | 'out';

const SUBTAB_FETCH_TTL_MS = 45_000;
const EMPTY_PRODUCTS: Product[] = [];
const EMPTY_OPTIONS: string[] = ['Todas'];
const EMPTY_CATEGORY_OPTIONS: FilterOption[] = [{ name: 'Todas' }];

interface InventoryProductCardProps {
  item: Product;
  stock: number;
  showAttributes?: boolean;
  canViewMargins: boolean;
  canManageProducts: boolean;
  canManageInventoryAdjustments: boolean;
  onEditProduct: (product: Product) => void;
  onOpenStockModal: (product: Product) => void;
}

const InventoryProductCard = React.memo<InventoryProductCardProps>(({
  item,
  stock,
  showAttributes = false,
  canViewMargins,
  canManageProducts,
  canManageInventoryAdjustments,
  onEditProduct,
  onOpenStockModal,
}) => {
  const handleEditPress = useCallback(() => {
    onEditProduct(item);
  }, [onEditProduct, item]);

  const handleOpenStockPress = useCallback(() => {
    onOpenStockModal(item);
  }, [onOpenStockModal, item]);

  const minStock = (item as any).minStock || 3;
  const isOut = stock <= 0;
  const isLow = stock > 0 && stock <= minStock;

  const price = Number(item.suggestedPrice ?? item.price ?? 0);
  const cost = Number(item.costPrice ?? 0);
  const marginPct = cost > 0 ? ((price - cost) / cost) * 100 : 100;
  const brandLabel = showAttributes ? (item.brand || '').trim() : '';
  const sizeLabel = showAttributes ? catalogSizeInput(item).trim() : '';
  const attrText =
    brandLabel && sizeLabel
      ? `Marca: ${brandLabel} · Medida: ${sizeLabel}`
      : brandLabel
      ? `Marca: ${brandLabel}`
      : sizeLabel
      ? `Medida: ${sizeLabel}`
      : '';
  const imageSource = useMemo(() => {
    const uri = item.thumbUrl || item.imageUrl;
    return uri ? { uri } : null;
  }, [item.thumbUrl, item.imageUrl]);
  const productInitial = item.name ? item.name.trim().charAt(0).toUpperCase() : 'P';

  return (
    <View style={styles.inventoryCard}>
      <View style={styles.inventoryCardHeader}>
        <View style={styles.productMark}>
          {imageSource ? (
            <Image
              source={imageSource}
              style={styles.productThumbnail}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={item.id}
              transition={0}
              allowDownscaling
            />
          ) : (
            <Text style={styles.productMarkGlyph}>{productInitial}</Text>
          )}
        </View>
        <View style={styles.productIdentity}>
          <Text style={styles.inventoryCardName} numberOfLines={2}>
            {item.name}
          </Text>
          <View style={styles.productMetaRow}>
            <Text style={styles.productCategory} numberOfLines={1}>
              {item.category || 'General'}
            </Text>
            <Text style={styles.metaSeparator}>·</Text>
            <Text style={styles.inventoryCardSku} numberOfLines={1}>
              {item.sku || item.barcode || 'Sin SKU'}
            </Text>
          </View>
          {attrText ? (
            <Text style={styles.productAttrText} numberOfLines={1}>
              {attrText}
            </Text>
          ) : null}
        </View>
        <View
          style={[
            styles.stockStatusBadge,
            isOut && styles.stockStatusBadgeRed,
            isLow && styles.stockStatusBadgeAmber,
            !isOut && !isLow && styles.stockStatusBadgeGreen,
          ]}
        >
          <Text
            style={[
              styles.stockStatusText,
              isOut && styles.stockStatusTextRed,
              isLow && styles.stockStatusTextAmber,
              !isOut && !isLow && styles.stockStatusTextGreen,
            ]}
          >
            {isOut ? 'Agotado' : `Stock: ${stock} ${item.unitOfMeasure || 'und'}`}
          </Text>
        </View>
      </View>

      <View style={styles.productFinancialRow}>
        <View style={styles.salePriceBlock}>
          <Text style={styles.metricLabel}>Precio de venta</Text>
          <Text style={styles.salePriceValue}>{formatPEN(price)}</Text>
        </View>
        {canViewMargins && (
          <View style={styles.secondaryFinancials}>
            <View style={styles.secondaryMetric}>
              <Text style={styles.metricLabel}>Costo</Text>
              <Text style={styles.metricValue}>{formatPEN(cost)}</Text>
            </View>
            <View style={styles.secondaryMetric}>
              <Text style={styles.metricLabel}>Margen</Text>
              <Text style={[styles.metricValue, marginPct < 15 ? styles.kpiWarning : styles.kpiSuccess]}>
                {marginPct.toFixed(0)}%
              </Text>
            </View>
          </View>
        )}
      </View>

      {(canManageProducts || canManageInventoryAdjustments) && (
        <View style={styles.inventoryActionsRow}>
          {canManageProducts && (
            <TouchableOpacity
              style={styles.actionBtnEdit}
              onPress={handleEditPress}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Editar ${item.name}`}
            >
              <Text style={styles.actionBtnEditText}>Editar producto</Text>
            </TouchableOpacity>
          )}
          {canManageInventoryAdjustments && (
            <TouchableOpacity
              style={styles.actionBtnStock}
              onPress={handleOpenStockPress}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Ajustar stock de ${item.name}`}
            >
              <Text style={styles.actionBtnStockText}>Ajustar stock</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
});

const CatalogPlanLimitBanner = React.memo(() => {
  const productPlanLimit = useProductPlanLimit();
  if (!productPlanLimit || (!productPlanLimit.isAtLimit && !productPlanLimit.isNearLimit)) {
    return null;
  }
  return (
    <View
      style={[
        styles.planLimitBanner,
        productPlanLimit.isAtLimit && styles.planLimitBannerFull,
      ]}
    >
      <AlertTriangle
        size={15}
        color={productPlanLimit.isAtLimit ? ui.danger : ui.warning}
      />
      <Text
        style={[
          styles.planLimitText,
          productPlanLimit.isAtLimit && styles.planLimitTextDanger,
        ]}
      >
        {productPlanLimit.isAtLimit
          ? `Límite del plan alcanzado (${productPlanLimit.current}/${productPlanLimit.max} productos). Mejora tu plan para crear más.`
          : `Cerca del límite de tu plan: ${productPlanLimit.current}/${productPlanLimit.max} productos.`}
      </Text>
    </View>
  );
});

interface CatalogInventorySummaryProps {
  catalogComplete: boolean;
  hasProducts: boolean;
  canViewMargins: boolean;
  canManageProducts: boolean;
  valuationExpanded: boolean;
  onToggleValuation: () => void;
  onOpenNewProduct: () => void;
  isValidatingPlanLimit: boolean;
  statusFilter: StockStatusFilter;
  onChangeStatusFilter: (filter: StockStatusFilter) => void;
}

const CatalogInventorySummary = React.memo<CatalogInventorySummaryProps>(
  ({
    catalogComplete,
    hasProducts,
    canViewMargins,
    canManageProducts,
    valuationExpanded,
    onToggleValuation,
    onOpenNewProduct,
    isValidatingPlanLimit,
    statusFilter,
    onChangeStatusFilter,
  }) => {
    const { stats } = useProductsStats();
    const statsReady = catalogComplete || hasProducts;

    const handleFilterAll = useCallback(() => {
      onChangeStatusFilter('all');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [onChangeStatusFilter]);

    const handleFilterLow = useCallback(() => {
      onChangeStatusFilter(statusFilter === 'low' ? 'all' : 'low');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [onChangeStatusFilter, statusFilter]);

    const handleFilterOut = useCallback(() => {
      onChangeStatusFilter(statusFilter === 'out' ? 'all' : 'out');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [onChangeStatusFilter, statusFilter]);

    return (
      <View style={styles.kpiContainer}>
        <View style={styles.inventorySummary}>
          <View style={styles.valuationHeaderRow}>
            <TouchableOpacity
              style={styles.valuationToggleBtn}
              onPress={onToggleValuation}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={
                valuationExpanded
                  ? 'Contraer resumen de inventario'
                  : 'Expandir resumen de inventario'
              }
            >
              <Text style={styles.valuationLabel}>
                {canViewMargins ? 'Valor del inventario' : 'Resumen de inventario'}
              </Text>
              {valuationExpanded ? (
                <ChevronUp size={16} color={ui.textSecondary} />
              ) : (
                <ChevronDown size={16} color={ui.textSecondary} />
              )}
            </TouchableOpacity>

            {canManageProducts ? (
              <TouchableOpacity
                style={[styles.compactHeaderAction, isValidatingPlanLimit && { opacity: 0.7 }]}
                onPress={onOpenNewProduct}
                disabled={isValidatingPlanLimit}
                accessibilityRole="button"
                accessibilityLabel="Crear producto"
              >
                {isValidatingPlanLimit ? (
                  <ActivityIndicator size="small" color={ui.onPrimary} />
                ) : (
                  <Plus size={14} color={ui.onPrimary} />
                )}
                <Text style={styles.compactHeaderActionText}>Nuevo producto</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {valuationExpanded && (
            <>
              {canViewMargins && (
                <View style={styles.valuationRow}>
                  <Text style={styles.valuationAmount}>
                    {statsReady ? formatPEN(stats.valuation) : 'Sincronizando…'}
                  </Text>
                </View>
              )}
              <View style={styles.inventoryCounts}>
                <TouchableOpacity
                  style={[
                    styles.kpiFilterPill,
                    statusFilter === 'all' && styles.kpiFilterPillActive,
                  ]}
                  onPress={handleFilterAll}
                  accessibilityRole="button"
                  accessibilityLabel={
                    statsReady
                      ? `Todos los productos (${stats.totalProducts})`
                      : 'Sincronizando catálogo'
                  }
                  disabled={!statsReady}
                >
                  <Text
                    style={[
                      styles.inventoryCount,
                      statusFilter === 'all' && styles.kpiCountTextActive,
                    ]}
                  >
                    <Text style={styles.inventoryCountValue}>
                      {statsReady ? stats.totalProducts : '…'}
                    </Text>{' '}
                    productos
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.kpiFilterPill,
                    statusFilter === 'low' && styles.kpiFilterPillActiveWarning,
                  ]}
                  onPress={handleFilterLow}
                  accessibilityRole="button"
                  accessibilityLabel={
                    statsReady
                      ? `Stock bajo (${stats.lowStockCount})`
                      : 'Sincronizando catálogo'
                  }
                  disabled={!statsReady}
                >
                  <Text
                    style={[
                      styles.inventoryCount,
                      styles.kpiWarning,
                      statusFilter === 'low' && styles.kpiCountTextActiveWarning,
                    ]}
                  >
                    <Text style={styles.inventoryCountValue}>
                      {statsReady ? stats.lowStockCount : '…'}
                    </Text>{' '}
                    stock bajo
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.kpiFilterPill,
                    statusFilter === 'out' && styles.kpiFilterPillActiveDanger,
                  ]}
                  onPress={handleFilterOut}
                  accessibilityRole="button"
                  accessibilityLabel={
                    statsReady
                      ? `Agotados (${stats.outOfStockCount})`
                      : 'Sincronizando catálogo'
                  }
                  disabled={!statsReady}
                >
                  <Text
                    style={[
                      styles.inventoryCount,
                      styles.kpiDanger,
                      statusFilter === 'out' && styles.kpiCountTextActiveDanger,
                    ]}
                  >
                    <Text style={styles.inventoryCountValue}>
                      {statsReady ? stats.outOfStockCount : '…'}
                    </Text>{' '}
                    agotados
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>
    );
  }
);

const KardexRow = React.memo<{ item: any }>(({ item }) => {
  const rawQty =
    item.quantityChanged !== undefined
      ? Number(item.quantityChanged)
      : item.quantity !== undefined
      ? Number(item.quantity)
      : 0;
  const qty = isNaN(rawQty) ? 0 : rawQty;

  const mType = String(item.movementType || item.type || '').toLowerCase();
  const isSale = mType === 'sale';
  const isIncoming = qty > 0 || mType === 'add' || mType === 'return' || mType === 'in';
  const isOutgoing = qty < 0 || isSale || mType === 'refund' || mType === 'out';
  const isTransfer = mType === 'transfer' || mType === 'in_transit';

  const qtyBadgeText =
    qty > 0
      ? `+${qty}`
      : qty < 0
      ? `${qty}`
      : isOutgoing
      ? `-${Math.abs(item.quantity || 1)}`
      : isIncoming
      ? `+${Math.abs(item.quantity || 1)}`
      : '0';

  const prevStock = item.quantityBefore ?? item.previousStock;
  const postStock = item.quantityAfter ?? item.newStock;

  let reasonLabel = item.reason || '';
  if (!reasonLabel) {
    if (isSale) {
      reasonLabel = item.saleId ? `Venta #${item.saleId.slice(-8)}` : 'Venta en POS';
    } else if (mType === 'add') {
      reasonLabel = 'Ingreso de mercadería';
    } else if (mType === 'edit') {
      reasonLabel = 'Ajuste manual de stock';
    } else if (mType === 'transfer') {
      reasonLabel = 'Transferencia entre sucursales';
    } else if (mType === 'return') {
      reasonLabel = 'Devolución de cliente';
    } else if (mType === 'refund') {
      reasonLabel = 'Reembolso / Anulación';
    } else {
      reasonLabel = 'Movimiento de inventario';
    }
  }

  return (
    <View style={styles.kardexCard}>
      <View style={styles.kardexCardTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kardexProductName} numberOfLines={1}>
            {item.productName || 'Producto'}
          </Text>
          <Text style={styles.kardexDateText}>
            {formatDatePE(item.createdAt)} | {item.userName || 'Usuario'}
          </Text>
        </View>
        <View
          style={[
            styles.kardexTypeBadge,
            isIncoming && styles.kardexTypeBadgeGreen,
            isOutgoing && styles.kardexTypeBadgeRed,
            isTransfer && styles.kardexTypeBadgePurple,
          ]}
        >
          <Text
            style={[
              styles.kardexTypeText,
              isIncoming && styles.kardexTypeTextGreen,
              isOutgoing && styles.kardexTypeTextRed,
              isTransfer && styles.kardexTypeTextPurple,
            ]}
          >
            {qtyBadgeText}
          </Text>
        </View>
      </View>

      <View style={styles.kardexCardBottom}>
        <Text style={styles.kardexReason} numberOfLines={1}>
          Motivo: {reasonLabel}
        </Text>
        <Text style={styles.kardexStockChange}>
          {prevStock !== undefined && postStock !== undefined
            ? `${prevStock} ➔ ${postStock} uds`
            : prevStock !== undefined
            ? `${prevStock} uds`
            : postStock !== undefined
            ? `${postStock} uds`
            : `${Math.abs(qty)} uds`}
        </Text>
      </View>
    </View>
  );
});

interface TransferActionButtonProps {
  item: StockTransfer;
  action: 'approve' | 'reject' | 'cancel' | 'send' | 'receive';
  label: string;
  isActionLoading: boolean;
  onRunAction: (
    transfer: StockTransfer,
    action: 'approve' | 'reject' | 'cancel' | 'send' | 'receive'
  ) => void;
}

const TransferActionButton = React.memo<TransferActionButtonProps>(
  ({ item, action, label, isActionLoading, onRunAction }) => {
    const handlePress = useCallback(() => {
      onRunAction(item, action);
    }, [onRunAction, item, action]);

    return (
      <TouchableOpacity
        onPress={handlePress}
        disabled={isActionLoading}
        style={styles.transferActionButton}
        accessibilityRole="button"
      >
        {isActionLoading ? (
          <ActivityIndicator size="small" color={ui.primary} />
        ) : (
          <Text style={styles.transferActionText}>{label}</Text>
        )}
      </TouchableOpacity>
    );
  }
);

interface TransferCardProps {
  item: StockTransfer;
  currentUserId?: string;
  canApproveTransfer: boolean;
  canManageTransfers: boolean;
  canRequestTransfer: boolean;
  invoicingEnabled: boolean;
  canAccessBranch: (branchId?: string) => boolean;
  isActionLoading: boolean;
  isEmittingGuide: boolean;
  onRunAction: (
    transfer: StockTransfer,
    action: 'approve' | 'reject' | 'cancel' | 'send' | 'receive'
  ) => void;
  onEmitGuide: (transfer: StockTransfer) => void;
}

const TransferCard = React.memo<TransferCardProps>(({
  item,
  currentUserId,
  canApproveTransfer,
  canManageTransfers,
  canRequestTransfer,
  invoicingEnabled,
  canAccessBranch,
  isActionLoading,
  isEmittingGuide,
  onRunAction,
  onEmitGuide,
}) => {
  const handleEmitPress = useCallback(() => {
    void onEmitGuide(item);
  }, [onEmitGuide, item]);

  const totalUnits = (item.items || []).reduce((acc, it) => acc + (it.quantity || 0), 0);
  const guideDoc = (item as any).despatchDocumentNumber || (item as any).einvoiceId;

  const sourceId = item.sourceBranchId || (item as any).fromBranchId;
  const destinationId = item.destinationBranchId || (item as any).toBranchId;
  const actions: Array<{
    label: string;
    action: 'approve' | 'reject' | 'cancel' | 'send' | 'receive';
  }> = [];
  if (item.status === 'pending' && canApproveTransfer && canAccessBranch(destinationId)) {
    actions.push({ label: 'Aprobar', action: 'approve' }, { label: 'Rechazar', action: 'reject' });
  }
  const canCancel =
    (canManageTransfers && (item.status === 'pending' || item.status === 'approved')) ||
    (canRequestTransfer && item.requestedBy === currentUserId && item.status === 'pending');
  if (canCancel && canAccessBranch(sourceId)) {
    actions.push({ label: 'Cancelar', action: 'cancel' });
  }
  if (item.status === 'approved' && canManageTransfers && canAccessBranch(sourceId)) {
    actions.push({ label: 'Marcar enviada', action: 'send' });
  }
  if (
    (item.status === 'approved' || item.status === 'in_transit') &&
    canManageTransfers &&
    canAccessBranch(destinationId)
  ) {
    actions.push({ label: 'Recibir', action: 'receive' });
  }
  const canEmitGuide =
    item.status === 'in_transit' &&
    invoicingEnabled &&
    !guideDoc &&
    canManageTransfers &&
    canAccessBranch(sourceId);

  return (
    <View style={styles.transferCard}>
      <View style={styles.transferCardHeader}>
        <Text style={styles.transferNumber}>
          {item.transferNumber || `TRF-${(item.id || '').slice(-4).toUpperCase()}`}
        </Text>
        <View style={styles.transferStatusBadge}>
          <Text style={styles.transferStatusText}>
            {item.status === 'completed'
              ? 'COMPLETADA'
              : item.status === 'in_transit'
              ? 'EN TRÁNSITO'
              : item.status === 'rejected'
              ? 'RECHAZADA'
              : item.status === 'cancelled'
              ? 'CANCELADA'
              : item.status === 'approved'
              ? 'APROBADA'
              : 'PENDIENTE'}
          </Text>
        </View>
      </View>

      <View style={styles.transferRouteRow}>
        <Building2 size={15} color={ui.primary} />
        <Text style={styles.transferRouteText}>
          {item.fromBranchName || 'Origen'} ➔ {item.toBranchName || 'Destino'}
        </Text>
      </View>

      {(item.items || []).length > 0 && (
        <View style={styles.transferCardItemsList}>
          {(item.items || []).slice(0, 4).map((it, idx) => (
            <Text key={`${it.productId}-${idx}`} style={styles.transferCardItemLine} numberOfLines={1}>
              • {it.productName}
              {(it as any).variantName ? ` (${(it as any).variantName})` : ''}:{' '}
              <Text style={{ fontWeight: '700', color: ui.text }}>{it.quantity} u.</Text>
            </Text>
          ))}
          {(item.items || []).length > 4 && (
            <Text style={styles.transferCardItemMore}>
              +{(item.items || []).length - 4} producto(s) más...
            </Text>
          )}
        </View>
      )}

      <View style={styles.transferDetailsRow}>
        <Text style={styles.transferDetailsText}>
          {totalUnits} unidades transferidas
          {guideDoc ? ` • Guía ${guideDoc}` : ''}
        </Text>
        <Text style={styles.transferDateText}>
          {formatDatePE(item.sentAt || item.shippedAt || item.requestedAt)}
        </Text>
      </View>

      {(actions.length > 0 || canEmitGuide) && (
        <View style={styles.transferActionsRow}>
          {actions.map(({ label, action }) => (
            <TransferActionButton
              key={action}
              item={item}
              action={action}
              label={label}
              isActionLoading={isActionLoading}
              onRunAction={onRunAction}
            />
          ))}
          {canEmitGuide && (
            <TouchableOpacity
              onPress={handleEmitPress}
              disabled={isEmittingGuide}
              style={[styles.transferActionButton, styles.transferEmitGuideButton]}
              accessibilityRole="button"
            >
              {isEmittingGuide ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <Text style={[styles.transferActionText, styles.transferEmitGuideText]}>
                  Emitir Guía 09
                </Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
});

const kardexKeyExtractor = (item: any) =>
  item.id ||
  `${item.productId || 'kardex'}_${item.createdAt || ''}_${item.quantityChanged ?? item.quantity ?? ''}`;
const getKardexItemType = () => 'kardex';
const renderKardexItem = ({ item }: { item: any }) => <KardexRow item={item} />;
const overrideKardexItemLayout = (layout: { span?: number; size?: number }) => {
  layout.size = 88;
};

interface KardexSubTabProps {
  isActive: boolean;
  lastKardexFetchRef: React.MutableRefObject<{ scopeKey: string; fetchedAt: number } | null>;
  kardexListCacheRef: React.MutableRefObject<{ scopeKey: string; data: any[] } | null>;
  lastKardexSyncAtRef: React.MutableRefObject<number | null>;
}

const KardexSubTab = React.memo<KardexSubTabProps>(
  ({
    isActive,
    lastKardexFetchRef,
    kardexListCacheRef,
    lastKardexSyncAtRef,
  }) => {
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const { accountId, branchId } = useAuthSession();
    const { catalogIndex } = useProductsCatalog();
    const { isOnline, pendingInventoryOps, lastSyncSuccessAt } = useOfflineStatus();
    const [kardexList, setKardexList] = useState<any[]>(() => {
      const cached = kardexListCacheRef.current;
      if (cached && cached.scopeKey === `${accountId}:${branchId}`) {
        return cached.data;
      }
      return accountId ? getCachedProductKardexSync(accountId, branchId) : [];
    });
    const [kardexLoading, setKardexLoading] = useState(false);
    const [kardexSearch, setKardexSearch] = useState('');
    const [kardexSelectedProductId, setKardexSelectedProductId] = useState<string | null>(null);
    const kardexSelectedProductIdRef = useRef<string | null>(null);
    kardexSelectedProductIdRef.current = kardexSelectedProductId;
    const debouncedKardexSearch = useDebouncedValue(kardexSearch, 150);
    const kardexScopeRef = useRef<string>('');
    const kardexRequestSeqRef = useRef<number>(0);

    const estimatedKardexListSize = useMemo(
      () => ({
        width: Math.max(windowWidth - 28, 300),
        height: Math.max(windowHeight - 240, 300),
      }),
      [windowWidth, windowHeight]
    );

    const filteredKardexProducts = useFocusMemo(
      () =>
        debouncedKardexSearch.trim()
          ? filterCatalogIndex(catalogIndex, { query: debouncedKardexSearch, limit: 8 })
          : EMPTY_PRODUCTS,
      [catalogIndex, debouncedKardexSearch],
      isActive,
      EMPTY_PRODUCTS
    );

    const loadKardex = useCallback(
      async (productIdOverride?: string | null, force = false) => {
        if (!accountId || !branchId) return;
        const effectiveProductId =
          productIdOverride !== undefined ? productIdOverride : kardexSelectedProductIdRef.current;
        const scopeKey = `${accountId}:${branchId}:${effectiveProductId || ''}`;
        const baseScopeKey = `${accountId}:${branchId}`;

        const scopeChanged = Boolean(kardexScopeRef.current && kardexScopeRef.current !== baseScopeKey);
        if (scopeChanged || (!isOnline && productIdOverride === null)) {
          const syncCached = !effectiveProductId
            ? getCachedProductKardexSync(accountId, branchId)
            : [];
          setKardexList(syncCached);
          if (!effectiveProductId) {
            kardexListCacheRef.current =
              syncCached.length > 0 ? { scopeKey: baseScopeKey, data: syncCached } : null;
          }
        }
        kardexScopeRef.current = baseScopeKey;

        if (!isOnline) {
          kardexRequestSeqRef.current += 1;
          setKardexLoading(false);
          return;
        }

        if (!force && lastKardexFetchRef.current) {
          const { scopeKey: lastScope, fetchedAt } = lastKardexFetchRef.current;
          if (lastScope === scopeKey && Date.now() - fetchedAt < SUBTAB_FETCH_TTL_MS) {
            return;
          }
        }

        const reqId = ++kardexRequestSeqRef.current;
        try {
          setKardexLoading(true);
          const data = await getProductKardex(
            accountId,
            branchId,
            effectiveProductId || undefined,
            60,
            { forceRefresh: force, rethrowError: true }
          );
          if (kardexRequestSeqRef.current !== reqId) return;
          const nextData = data || [];
          setKardexList(nextData);
          if (!effectiveProductId) {
            kardexListCacheRef.current = { scopeKey: baseScopeKey, data: nextData };
          }
          lastKardexFetchRef.current = { scopeKey, fetchedAt: Date.now() };
        } catch (err) {
          console.warn('[Catalog] Error cargando Kardex (conservando caché local):', err);
        } finally {
          if (kardexRequestSeqRef.current === reqId) {
            setKardexLoading(false);
          }
        }
      },
      [accountId, branchId, isOnline, lastKardexFetchRef, kardexListCacheRef]
    );

    useEffect(() => {
      if (!isActive) return;

      const shouldForceSync = Boolean(
        isOnline && lastSyncSuccessAt && lastKardexSyncAtRef.current !== lastSyncSuccessAt
      );

      let cancelled = false;
      const interactionTask = InteractionManager.runAfterInteractions(() => {
        if (cancelled) return;
        if (shouldForceSync) {
          lastKardexSyncAtRef.current = lastSyncSuccessAt;
          lastKardexFetchRef.current = null;
        }
        void loadKardex(undefined, shouldForceSync);
      });

      return () => {
        cancelled = true;
        interactionTask.cancel();
      };
    }, [isActive, isOnline, lastSyncSuccessAt, loadKardex, lastKardexFetchRef, lastKardexSyncAtRef]);

    const displayedKardexList = useMemo(() => {
      const activeBranchKey = branchId || 'main';
      const pendingRows = (pendingInventoryOps || [])
        .filter(
          (op): op is Extract<typeof op, { type: 'stock_adjust' }> =>
            op.type === 'stock_adjust' &&
            (!op.branchId || op.branchId === activeBranchKey) &&
            (!kardexSelectedProductId || op.productId === kardexSelectedProductId)
        )
        .map((op) => {
          const afterStock =
            op.mode === 'add'
              ? op.expectedBeforeStock + op.amount
              : op.mode === 'subtract'
              ? Math.max(0, op.expectedBeforeStock - op.amount)
              : op.amount;
          const delta = Math.round((afterStock - op.expectedBeforeStock) * 10000) / 10000;
          return {
            id: op.offlineOpId,
            productId: op.productId,
            productName: op.variantName ? `${op.productName} (${op.variantName})` : op.productName,
            productSku: op.productSku || '',
            type: delta < 0 ? 'out' : delta > 0 ? 'add' : 'edit',
            quantityChanged: delta,
            quantityBefore: op.expectedBeforeStock,
            quantityAfter: afterStock,
            reason: `${op.reason || 'Ajuste'} (Pendiente offline)`,
            userName: op.userProfile?.displayName || 'Offline',
            createdAt: op.timestamp,
          };
        });

      const merged = [...pendingRows, ...kardexList];
      if (kardexSelectedProductId || !debouncedKardexSearch.trim()) return merged;
      const term = debouncedKardexSearch.trim().toLowerCase();
      return merged.filter(
        (item) =>
          String(item.productName || '').toLowerCase().includes(term) ||
          String(item.productSku || '').toLowerCase().includes(term) ||
          String(item.referenceNumber || '').toLowerCase().includes(term)
      );
    }, [kardexList, pendingInventoryOps, branchId, kardexSelectedProductId, debouncedKardexSearch]);

    const handleRefreshKardexPress = useCallback(() => {
      void loadKardex(undefined, true);
    }, [loadKardex]);

    const handleSearchChange = useCallback(
      (txt: string) => {
        setKardexSearch(txt);
        if (!txt.trim() && kardexSelectedProductIdRef.current) {
          setKardexSelectedProductId(null);
          void loadKardex(null, true);
        }
      },
      [loadKardex]
    );

    const handleClearSearch = useCallback(() => {
      setKardexSearch('');
      setKardexSelectedProductId(null);
      void loadKardex(null, true);
    }, [loadKardex]);

    return (
      <View style={styles.subTabContainer} collapsable={false}>
        <View style={styles.kardexHeaderBar}>
          <Text style={styles.kardexSubtitle} numberOfLines={1}>
            Historial de entradas, ventas y ajustes
          </Text>
          <TouchableOpacity style={styles.refreshBtn} onPress={handleRefreshKardexPress}>
            {kardexLoading && kardexList.length > 0 ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <RefreshCw size={14} color={ui.primary} />
            )}
            <Text style={styles.refreshBtnText}>Actualizar</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.kardexFilterBox}>
          <View style={styles.kardexSearchBar}>
            <Search size={15} color={ui.textSecondary} style={{ marginRight: 6 }} />
            <TextInput
              style={styles.transferSearchInput}
              value={kardexSearch}
              onChangeText={handleSearchChange}
              placeholder="Filtrar Kardex por producto o SKU..."
              placeholderTextColor={ui.textMuted}
              autoCapitalize="none"
            />
            {kardexSearch || kardexSelectedProductId ? (
              <TouchableOpacity onPress={handleClearSearch} hitSlop={6}>
                <X size={14} color={ui.textSecondary} />
              </TouchableOpacity>
            ) : null}
          </View>

          {filteredKardexProducts.length > 0 && !kardexSelectedProductId && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6, marginTop: 8 }}
            >
              {filteredKardexProducts.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.kardexProductChip}
                  onPress={() => {
                    setKardexSelectedProductId(p.id);
                    setKardexSearch(p.name);
                    void loadKardex(p.id, true);
                  }}
                >
                  <Text style={styles.kardexProductChipText} numberOfLines={1}>
                    {p.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {kardexLoading && kardexList.length === 0 ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.centerLoadingText}>Consultando movimientos de stock...</Text>
          </View>
        ) : displayedKardexList.length === 0 ? (
          <View style={styles.emptyView}>
            <History size={40} color={ui.border} />
            <Text style={styles.emptyViewTitle}>Sin movimientos registrados</Text>
            <Text style={styles.emptyViewSubtitle}>
              {kardexSelectedProductId
                ? 'Este producto aún no tiene movimientos en la sucursal.'
                : 'Los ingresos, ventas y transferencias aparecerán aquí en vivo.'}
            </Text>
          </View>
        ) : (
          <FlashList
            data={displayedKardexList}
            estimatedItemSize={88}
            estimatedListSize={estimatedKardexListSize}
            overrideItemLayout={overrideKardexItemLayout}
            keyExtractor={kardexKeyExtractor}
            getItemType={getKardexItemType}
            contentContainerStyle={styles.listPaddingBottom}
            renderItem={renderKardexItem}
            refreshing={kardexLoading && kardexList.length > 0}
            onRefresh={handleRefreshKardexPress}
          />
        )}
      </View>
    );
  }
);

interface TransfersSubTabProps {
  isActive: boolean;
  lastKardexFetchRef: React.MutableRefObject<{ scopeKey: string; fetchedAt: number } | null>;
}

const TransfersSubTab = React.memo<TransfersSubTabProps>(
  ({ isActive, lastKardexFetchRef }) => {
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const { accountId, branchId, user, userProfile } = useAuthSession();
    const { isOnline } = useNetworkStatus();
    const {
      canRequestTransfer,
      canApproveTransfer,
      canManageTransfers,
      canAccessBranch,
    } = usePermissions();
    const { invoicingEnabled } = useBusinessSettings();

    const [transfersList, setTransfersList] = useState<StockTransfer[]>(() =>
      accountId ? getCachedStockTransfersSync(accountId, branchId) : []
    );
    const [transfersLoading, setTransfersLoading] = useState(false);
    const [transferActionId, setTransferActionId] = useState<string | null>(null);
    const [isEmittingGuideId, setIsEmittingGuideId] = useState<string | null>(null);
    const [newTransferModalOpen, setNewTransferModalOpen] = useState(false);
    const lastTransfersFetchRef = useRef<{ scopeKey: string; fetchedAt: number } | null>(null);
    const transfersScopeRef = useRef<string>('');
    const transfersRequestSeqRef = useRef<number>(0);

    const loadTransfers = useCallback(
      async (force = false) => {
        if (!accountId) return;
        const scopeKey = `${accountId}:${branchId}`;

        if (transfersScopeRef.current && transfersScopeRef.current !== scopeKey) {
          setTransfersList(getCachedStockTransfersSync(accountId, branchId));
        }
        transfersScopeRef.current = scopeKey;

        if (!isOnline) {
          transfersRequestSeqRef.current += 1;
          setTransfersLoading(false);
          return;
        }

        if (!force && lastTransfersFetchRef.current) {
          const { scopeKey: lastScope, fetchedAt } = lastTransfersFetchRef.current;
          if (lastScope === scopeKey && Date.now() - fetchedAt < SUBTAB_FETCH_TTL_MS) {
            return;
          }
        }

        const reqId = ++transfersRequestSeqRef.current;
        try {
          setTransfersLoading(true);
          const data = await getStockTransfers(accountId, branchId, undefined, {
            forceRefresh: force,
            rethrowError: true,
          });
          if (transfersRequestSeqRef.current !== reqId) return;
          setTransfersList(data || []);
          lastTransfersFetchRef.current = { scopeKey, fetchedAt: Date.now() };
        } catch (err) {
          console.warn('[Catalog] Error cargando transferencias (conservando caché local):', err);
        } finally {
          if (transfersRequestSeqRef.current === reqId) {
            setTransfersLoading(false);
          }
        }
      },
      [accountId, branchId, isOnline]
    );

    useEffect(() => {
      if (!isActive) return;
      let cancelled = false;
      const interactionTask = InteractionManager.runAfterInteractions(() => {
        if (!cancelled) {
          void loadTransfers();
        }
      });
      return () => {
        cancelled = true;
        interactionTask.cancel();
      };
    }, [isActive, loadTransfers]);

    const handleEmitDespatchGuide = useCallback(
      async (transfer: StockTransfer) => {
        if (!accountId || !transfer.id) return;
        setIsEmittingGuideId(transfer.id);
        try {
          await assertOnlineForWrite('emitir Guía de Remisión', isOnline);
          const res = await emitTransferDespatchGuide(accountId, transfer.id);
          await loadTransfers(true);
          const docLabel = res?.einvoice?.documentNumber || res?.einvoice?.id || 'Guía 09';
          Alert.alert('Guía de Remisión Emitida', `Se generó correctamente: ${docLabel}.`);
        } catch (err: any) {
          Alert.alert(
            'Error al emitir Guía 09',
            err?.message || 'No se pudo emitir la Guía de Remisión Electrónica.'
          );
        } finally {
          setIsEmittingGuideId(null);
        }
      },
      [accountId, isOnline, loadTransfers]
    );

    const runTransferAction = useCallback(
      async (
        transfer: StockTransfer,
        action: 'approve' | 'reject' | 'cancel' | 'send' | 'receive'
      ) => {
        const online = await checkIsOnlineLive(isOnline);
        if (!online) {
          Alert.alert(
            'Sin Conexión',
            'Las transferencias entre sucursales requieren conexión a internet.'
          );
          return;
        }
        const sourceId = transfer.sourceBranchId || (transfer as any).fromBranchId;
        const destinationId = transfer.destinationBranchId || (transfer as any).toBranchId;
        const allowed =
          action === 'approve' || action === 'reject'
            ? canApproveTransfer && canAccessBranch(destinationId)
            : action === 'cancel'
            ? (canManageTransfers ||
                (canRequestTransfer &&
                  transfer.requestedBy === user?.uid &&
                  transfer.status === 'pending')) &&
              canAccessBranch(sourceId)
            : action === 'send'
            ? canManageTransfers && canAccessBranch(sourceId)
            : canManageTransfers && canAccessBranch(destinationId);
        if (!allowed) {
          Alert.alert(
            'Acceso denegado',
            'No tienes permiso para realizar esta acción en la sucursal correspondiente.'
          );
          return;
        }
        const profile = {
          uid: user?.uid || 'user_pos',
          displayName: userProfile?.displayName || user?.displayName || user?.email || 'Usuario',
          email: user?.email || undefined,
          role: userProfile?.role,
        };
        const actionLabels = {
          approve: 'aprobar',
          reject: 'rechazar',
          cancel: 'cancelar',
          send: 'marcar como enviada',
          receive: 'confirmar recepción de',
        };
        Alert.alert(
          'Confirmar acción',
          `¿Deseas ${actionLabels[action]} la transferencia ${transfer.transferNumber || transfer.id}?`,
          [
            { text: 'Volver', style: 'cancel' },
            {
              text: 'Confirmar',
              style: action === 'reject' || action === 'cancel' ? 'destructive' : 'default',
              onPress: async () => {
                setTransferActionId(transfer.id || null);
                try {
                  await assertOnlineForWrite('gestionar transferencias', isOnline);
                  if (action === 'approve') await approveStockTransfer(transfer.id!, profile);
                  if (action === 'reject') await rejectStockTransfer(transfer.id!, profile);
                  if (action === 'cancel') await cancelStockTransfer(transfer.id!, profile);
                  if (action === 'send') await sendStockTransfer(transfer.id!, profile);
                  if (action === 'receive') await completeStockTransfer(transfer.id!, profile);
                  lastKardexFetchRef.current = null;
                  await loadTransfers(true);

                  const hasExistingGuide = Boolean(
                    (transfer as any).despatchDocumentNumber || (transfer as any).einvoiceId
                  );
                  if (action === 'send' && invoicingEnabled && transfer.id && !hasExistingGuide) {
                    Alert.alert(
                      'Transferencia en tránsito',
                      '¿Deseas emitir la Guía de Remisión Electrónica (09) ante SUNAT ahora?',
                      [
                        { text: 'Luego', style: 'cancel' },
                        {
                          text: 'Emitir Guía 09',
                          onPress: () => void handleEmitDespatchGuide(transfer),
                        },
                      ]
                    );
                  } else {
                    Alert.alert('Transferencia actualizada', 'El cambio quedó registrado.');
                  }
                } catch (err: any) {
                  Alert.alert('No se pudo actualizar', err?.message || 'Intenta nuevamente.');
                } finally {
                  setTransferActionId(null);
                }
              },
            },
          ]
        );
      },
      [
        canApproveTransfer,
        canManageTransfers,
        canRequestTransfer,
        canAccessBranch,
        isOnline,
        loadTransfers,
        lastKardexFetchRef,
        user,
        userProfile,
        invoicingEnabled,
        handleEmitDespatchGuide,
      ]
    );

    const handleOpenNewTransferModal = useCallback(() => {
      setNewTransferModalOpen(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    const handleCloseNewTransferModal = useCallback(() => {
      setNewTransferModalOpen(false);
    }, []);

    const handleTransferCreated = useCallback(() => {
      lastKardexFetchRef.current = null;
      void loadTransfers(true);
    }, [lastKardexFetchRef, loadTransfers]);

    const handleRefreshTransfersPress = useCallback(() => {
      void loadTransfers(true);
    }, [loadTransfers]);

    const transfersKeyExtractor = useCallback(
      (item: StockTransfer) => item.id || `trf_${item.transferNumber}`,
      []
    );
    const getTransferItemType = useCallback((item: StockTransfer) => {
      const isActiveTransfer =
        item.status === 'pending' || item.status === 'approved' || item.status === 'in_transit';
      const lineBucket = Math.min((item.items || []).length, 4);
      return `${isActiveTransfer ? 'active' : 'terminal'}_${lineBucket}`;
    }, []);
    const overrideTransferItemLayout = useCallback(
      (layout: { span?: number; size?: number }, item: StockTransfer) => {
        const lineCount = Math.min((item.items || []).length, 4);
        const isActiveTransfer =
          item.status === 'pending' || item.status === 'approved' || item.status === 'in_transit';
        layout.size = 132 + lineCount * 20 + (isActiveTransfer ? 42 : 0);
      },
      []
    );
    const estimatedTransfersListSize = useMemo(
      () => ({
        width: Math.max(windowWidth - 28, 300),
        height: Math.max(windowHeight - 220, 300),
      }),
      [windowWidth, windowHeight]
    );
    const renderTransferItem = useCallback(
      ({ item }: { item: StockTransfer }) => (
        <TransferCard
          item={item}
          currentUserId={user?.uid}
          canApproveTransfer={canApproveTransfer}
          canManageTransfers={canManageTransfers}
          canRequestTransfer={canRequestTransfer}
          invoicingEnabled={invoicingEnabled}
          canAccessBranch={canAccessBranch}
          isActionLoading={transferActionId === item.id}
          isEmittingGuide={isEmittingGuideId === item.id}
          onRunAction={runTransferAction}
          onEmitGuide={handleEmitDespatchGuide}
        />
      ),
      [
        user?.uid,
        canApproveTransfer,
        canManageTransfers,
        canRequestTransfer,
        invoicingEnabled,
        canAccessBranch,
        transferActionId,
        isEmittingGuideId,
        runTransferAction,
        handleEmitDespatchGuide,
      ]
    );
    const transferExtraData = useMemo(
      () =>
        transferActionId || isEmittingGuideId
          ? `${transferActionId || ''}:${isEmittingGuideId || ''}`
          : null,
      [transferActionId, isEmittingGuideId]
    );

    return (
      <>
        <View style={styles.subTabContainer} collapsable={false}>
          <View style={styles.transfersHeaderBar}>
            <SectionHeading
              title="Transferencias"
              subtitle="Envía y recibe mercadería entre locales"
              action={
                canRequestTransfer ? (
                  <TouchableOpacity
                    style={styles.newTransferBtn}
                    onPress={handleOpenNewTransferModal}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Nueva transferencia entre sucursales"
                  >
                    <Plus size={16} color={ui.surface} />
                    <Text style={styles.newTransferBtnText}>Nueva</Text>
                  </TouchableOpacity>
                ) : null
              }
            />
          </View>

          {transfersLoading && transfersList.length > 0 ? (
            <View style={styles.subtabSyncNotice}>
              <ActivityIndicator size="small" color={ui.primary} />
              <Text style={styles.catalogSyncText}>Actualizando transferencias…</Text>
            </View>
          ) : null}

          {transfersLoading && transfersList.length === 0 ? (
            <View style={styles.centerLoading}>
              <ActivityIndicator size="large" color={ui.primary} />
              <Text style={styles.centerLoadingText}>Cargando transferencias...</Text>
            </View>
          ) : transfersList.length === 0 ? (
            <View style={styles.emptyView}>
              <ArrowRightLeft size={40} color={ui.border} />
              <Text style={styles.emptyViewTitle}>No hay transferencias registradas</Text>
              <Text style={styles.emptyViewSubtitle}>
                {canRequestTransfer
                  ? 'Usa el botón "+ Nueva" para enviar productos a otra sucursal.'
                  : 'No se encontraron movimientos de transferencias para esta sucursal.'}
              </Text>
            </View>
          ) : (
            <FlashList
              data={transfersList}
              estimatedItemSize={190}
              estimatedListSize={estimatedTransfersListSize}
              overrideItemLayout={overrideTransferItemLayout}
              extraData={transferExtraData}
              keyExtractor={transfersKeyExtractor}
              getItemType={getTransferItemType}
              contentContainerStyle={styles.listPaddingBottom}
              renderItem={renderTransferItem}
              refreshing={transfersLoading && transfersList.length > 0}
              onRefresh={handleRefreshTransfersPress}
            />
          )}
        </View>

        {newTransferModalOpen &&
          (() => {
            const NewTransferModal = getNewTransferModal();
            return (
              <NewTransferModal
                visible={newTransferModalOpen}
                onClose={handleCloseNewTransferModal}
                onTransferCreated={handleTransferCreated}
              />
            );
          })()}
      </>
    );
  }
);

interface InventorySubTabProps {
  isFocused: boolean;
  onStockAdjusted: () => void;
  lastKardexFetchRef: React.MutableRefObject<{ scopeKey: string; fetchedAt: number } | null>;
}

const InventorySubTab = React.memo<InventorySubTabProps>(
  ({ isFocused, onStockAdjusted, lastKardexFetchRef }) => {
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const { accountId, branchId, user, userProfile } = useAuthSession();
    const { refreshAccess } = usePlanAccessActions();
    const { isOnline } = useNetworkStatus();
    const {
      canManageProducts,
      canManageInventoryAdjustments,
      canViewMargins,
    } = usePermissions();
    const {
      products,
      catalogIndex,
      categories,
      loading: productsLoading,
      refreshing,
      catalogComplete,
      error: productsError,
      refreshProducts,
      getProductStock,
      upsertProduct,
      upsertProductsBatch,
      applyAuthoritativeStockUpdates,
      validateProductCreation,
    } = useProductsCatalog();
    const { branches, activeBranchName, posSettings } = useBusinessSettings();
    const showAttributes = !!posSettings?.enableCatalogFilters;

    const [valuationExpanded, setValuationExpanded] = useState(true);

    // Filtros de Inventario
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<StockStatusFilter>('all');
    const [selectedCategory, setSelectedCategory] = useState('Todas');
    const [selectedBrand, setSelectedBrand] = useState('Todas');
    const [selectedSize, setSelectedSize] = useState('Todas');
    const debouncedSearchQuery = useDebouncedValue(searchQuery, 150);

    // Focus-gated catalog filter memos (cached while screen is blurred or sub-tab inactive)
    const availableBrands = useFocusMemo(
      () => ['Todas', ...catalogIndex.brands],
      [catalogIndex.brands],
      isFocused,
      EMPTY_OPTIONS
    );

    const availableSizes = useFocusMemo(
      () => ['Todas', ...catalogIndex.sizes],
      [catalogIndex.sizes],
      isFocused,
      EMPTY_OPTIONS
    );

    const categoryListWithCounts = useFocusMemo(
      () =>
        getCatalogCategoryCounts(categories, catalogIndex).map((option) => ({
          ...option,
          count: catalogComplete ? option.count : undefined,
        })),
      [categories, catalogIndex.categoryCountsVersion, catalogComplete],
      isFocused,
      EMPTY_CATEGORY_OPTIONS
    );

    const brandOptions = useMemo(() => availableBrands.map((b) => ({ name: b })), [availableBrands]);
    const sizeOptions = useMemo(() => availableSizes.map((s) => ({ name: s })), [availableSizes]);

    const handleSelectCategory = useCallback((cat: string) => setSelectedCategory(cat), []);
    const handleClearCategory = useCallback(() => setSelectedCategory('Todas'), []);
    const handleSelectBrand = useCallback((b: string) => setSelectedBrand(b), []);
    const handleClearBrand = useCallback(() => setSelectedBrand('Todas'), []);
    const handleSelectSize = useCallback((s: string) => setSelectedSize(s), []);
    const handleClearSize = useCallback(() => setSelectedSize('Todas'), []);

    const catalogFilterGroups: FilterGroup[] = useMemo(() => {
      const groups: FilterGroup[] = [
        {
          id: 'category',
          label: 'Categorías',
          selectedValue: selectedCategory,
          options: categoryListWithCounts,
          onSelect: handleSelectCategory,
          onClear: handleClearCategory,
          icon: 'category',
        },
      ];
      if (showAttributes) {
        groups.push(
          {
            id: 'brand',
            label: 'Marcas',
            selectedValue: selectedBrand,
            options: brandOptions,
            onSelect: handleSelectBrand,
            onClear: handleClearBrand,
            icon: 'brand' as const,
          },
          {
            id: 'size',
            label: 'Medidas',
            selectedValue: selectedSize,
            options: sizeOptions,
            onSelect: handleSelectSize,
            onClear: handleClearSize,
            icon: 'size' as const,
          }
        );
      }
      return groups;
    }, [
      showAttributes,
      selectedCategory,
      categoryListWithCounts,
      handleSelectCategory,
      handleClearCategory,
      selectedBrand,
      brandOptions,
      handleSelectBrand,
      handleClearBrand,
      selectedSize,
      sizeOptions,
      handleSelectSize,
      handleClearSize,
    ]);

    // Modal de Producto (Crear / Editar)
    const [productModalOpen, setProductModalOpen] = useState(false);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [isCloudSearching, setIsCloudSearching] = useState(false);

    const handleCloudSearch = useCallback(async () => {
      if (!accountId || !searchQuery.trim() || isCloudSearching) return;
      const online = await checkIsOnlineLive(isOnline);
      if (!online) {
        Alert.alert(
          'Sin Conexión',
          'La búsqueda en la nube requiere conexión a internet.'
        );
        return;
      }
      setIsCloudSearching(true);
      try {
        const qText = searchQuery.trim();
        const coll = collection(db, 'products');

        const [snapBarcode, snapName] = await Promise.all([
          getDocs(
            query(coll, where('accountId', '==', accountId), where('barcode', '==', qText), fsLimit(10))
          ).catch(() => ({ docs: [] })),
          getDocs(
            query(
              coll,
              where('accountId', '==', accountId),
              where('name', '>=', qText),
              where('name', '<=', qText + '\uf8ff'),
              fsLimit(20)
            )
          ).catch(() => ({ docs: [] })),
        ]);

        const docMap = new Map<string, any>();
        snapBarcode.docs.forEach((d) => docMap.set(d.id, d));
        snapName.docs.forEach((d) => docMap.set(d.id, d));

        if (docMap.size > 0) {
          const foundProducts: Product[] = [];
          docMap.forEach((d) => {
            const data = d.data();
            foundProducts.push({
              ...data,
              id: d.id,
              name: data.name || 'Sin nombre',
              category: data.category || 'General',
              barcode: data.barcode || '',
              barcodes: Array.isArray(data.barcodes) ? data.barcodes : [],
              sku: data.sku || '',
              brand: data.brand || '',
              sizeLabel: data.sizeLabel || '',
              price: Number(data.suggestedPrice ?? data.price ?? 0),
              suggestedPrice: Number(data.suggestedPrice ?? data.price ?? 0),
              minSalePrice: Number(data.minSalePrice ?? 0),
              costPrice: Number(data.costPrice ?? 0),
              stock: data.stock || {},
              minStock: data.minStock || 3,
              presentations: Array.isArray(data.presentations) ? data.presentations : [],
              imageUrl: data.imageUrl || '',
              accountId,
              active: data.active !== false,
              branchIds: Array.isArray(data.branchIds) ? data.branchIds : [],
            } as Product);
          });
          upsertProductsBatch(foundProducts);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Alert.alert(
            'Búsqueda en la Nube',
            `No se encontraron productos coincidentes con "${qText}".`
          );
        }
      } catch (err: any) {
        console.warn('[Catalog] Cloud search warning:', err?.message);
        Alert.alert('Aviso de Búsqueda', 'No se pudieron recuperar más resultados de la nube.');
      } finally {
        setIsCloudSearching(false);
      }
    }, [accountId, isOnline, searchQuery, isCloudSearching, upsertProductsBatch]);

    // Modal de Ajuste Rápido de Stock (estado de formulario aislado en QuickStockAdjustModal)
    const [stockModalOpen, setStockModalOpen] = useState(false);
    const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null);
    const [isValidatingPlanLimit, setIsValidatingPlanLimit] = useState(false);

    // Escáner de código de barras en inventario
    const [catalogScannerOpen, setCatalogScannerOpen] = useState(false);

    // Evita 20k llamadas getProductStock(p) cuando statusFilter === 'all'
    const stockStatusPredicate = useMemo(() => {
      if (statusFilter === 'all') return undefined;
      return (p: Product) => {
        const stock = getProductStock(p);
        const minStock = (p as any).minStock || 3;
        if (statusFilter === 'low') return stock > 0 && stock <= minStock;
        return stock <= 0;
      };
    }, [statusFilter, getProductStock]);

    // Filtrado de Inventario (focus-gated)
    const filteredProducts = useFocusMemo(
      () =>
        filterCatalogIndex(catalogIndex, {
          query: debouncedSearchQuery,
          category: selectedCategory,
          brand: selectedBrand,
          size: selectedSize,
          include: stockStatusPredicate,
        }),
      [
        catalogIndex,
        debouncedSearchQuery,
        selectedCategory,
        selectedBrand,
        selectedSize,
        stockStatusPredicate,
      ],
      isFocused,
      EMPTY_PRODUCTS
    );

    const openStockModal = useCallback((product: Product) => {
      setAdjustingProduct(product);
      setStockModalOpen(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    const handleCloseStockModal = useCallback(() => {
      setStockModalOpen(false);
    }, []);

    const handleOpenNewProduct = useCallback(async () => {
      if (!canManageProducts || isValidatingPlanLimit) return;
      setIsValidatingPlanLimit(true);
      try {
        const validation = await validateProductCreation();
        if (!validation.allowed) {
          Alert.alert(
            'Límite del Plan Alcanzado',
            validation.reason || 'Alcanzaste el límite de productos permitido en tu plan actual.'
          );
          return;
        }
        setEditingProduct(null);
        setProductModalOpen(true);
      } finally {
        setIsValidatingPlanLimit(false);
      }
    }, [canManageProducts, isValidatingPlanLimit, validateProductCreation]);

    const handleEditProduct = useCallback((product: Product) => {
      setEditingProduct(product);
      setProductModalOpen(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    const handleCloseProductModal = useCallback(() => {
      setProductModalOpen(false);
    }, []);

    const handleOpenCatalogScanner = useCallback(() => {
      setCatalogScannerOpen(true);
    }, []);

    const handleCloseCatalogScanner = useCallback(() => {
      setCatalogScannerOpen(false);
    }, []);

    const handleCatalogScan = useCallback((code: string) => {
      setCatalogScannerOpen(false);
      setSearchQuery(code);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, []);

    const handleToggleValuation = useCallback(() => {
      setValuationExpanded((prev) => !prev);
    }, []);

    const handleChangeStatusFilter = useCallback((next: StockStatusFilter) => {
      setStatusFilter(next);
    }, []);

    const handleClearInventoryFilters = useCallback(() => {
      setSearchQuery('');
      setStatusFilter('all');
      setSelectedCategory('Todas');
    }, []);

    const handleClearSearchText = useCallback(() => {
      setSearchQuery('');
    }, []);

    const renderCatalogItem = useCallback(
      ({ item }: { item: Product }) => (
        <InventoryProductCard
          item={item}
          stock={getProductStock(item)}
          showAttributes={showAttributes}
          canViewMargins={canViewMargins}
          canManageProducts={canManageProducts}
          canManageInventoryAdjustments={canManageInventoryAdjustments}
          onEditProduct={handleEditProduct}
          onOpenStockModal={openStockModal}
        />
      ),
      [
        getProductStock,
        showAttributes,
        canViewMargins,
        canManageProducts,
        canManageInventoryAdjustments,
        handleEditProduct,
        openStockModal,
      ]
    );

    const catalogKeyExtractor = useCallback((item: Product) => item.id, []);
    const getCatalogItemType = useCallback(
      (item: Product) =>
        showAttributes && Boolean((item.brand || '').trim() || catalogSizeInput(item).trim())
          ? 'attr'
          : 'plain',
      [showAttributes]
    );
    const hasInventoryActions = canManageProducts || canManageInventoryAdjustments;
    const overrideCatalogItemLayout = useCallback(
      (layout: { span?: number; size?: number }, item: Product) => {
        const hasAttr =
          showAttributes && Boolean((item.brand || '').trim() || catalogSizeInput(item).trim());
        const base = 144;
        const attr = hasAttr ? 18 : 0;
        const actions = hasInventoryActions ? 52 : 0;
        layout.size = base + attr + actions;
      },
      [showAttributes, hasInventoryActions]
    );
    const estimatedCatalogListSize = useMemo(
      () => ({
        width: Math.max(windowWidth, 320),
        height: Math.max(windowHeight - 300, 300),
      }),
      [windowWidth, windowHeight]
    );
    const catalogEmptyComponent = useMemo(
      () => (
        <View style={styles.emptyView}>
          <View style={styles.emptyIconWrap}>
            <Package size={26} color={ui.primary} />
          </View>
          <Text style={styles.emptyViewTitle}>
            {products.length === 0 ? 'Aún no tienes productos' : 'No encontramos resultados'}
          </Text>
          <Text style={styles.emptyViewSubtitle}>
            {products.length === 0
              ? 'Agrega tu primer producto para empezar a controlar el inventario.'
              : searchQuery.trim()
              ? `Sin coincidencias para “${searchQuery.trim()}”. Prueba otro término o limpia los filtros.`
              : 'Prueba otra categoría o estado de stock, o limpia los filtros.'}
          </Text>
          {products.length === 0 ? (
            canManageProducts ? (
              <TouchableOpacity
                style={styles.emptyActionBtn}
                onPress={handleOpenNewProduct}
                disabled={isValidatingPlanLimit}
                accessibilityRole="button"
                accessibilityLabel="Agregar el primer producto"
              >
                <Plus size={17} color={ui.primary} />
                <Text style={styles.emptyActionText}>Agregar producto</Text>
              </TouchableOpacity>
            ) : null
          ) : (
            <View style={styles.emptyActionsStack}>
              {searchQuery.trim().length >= 2 ? (
                <TouchableOpacity
                  style={[styles.emptyActionBtn, styles.emptyCloudSearchBtn]}
                  onPress={handleCloudSearch}
                  disabled={isCloudSearching}
                  accessibilityRole="button"
                  accessibilityLabel="Buscar en base de datos en la nube"
                >
                  {isCloudSearching ? (
                    <ActivityIndicator size="small" color={ui.primary} />
                  ) : (
                    <Search size={16} color={ui.primary} />
                  )}
                  <Text style={styles.emptyActionText}>
                    {isCloudSearching
                      ? 'Consultando nube...'
                      : 'Buscar en toda la base de datos'}
                  </Text>
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity
                style={styles.emptyActionBtn}
                onPress={handleClearInventoryFilters}
                accessibilityRole="button"
                accessibilityLabel="Limpiar búsqueda y filtros"
              >
                <X size={16} color={ui.primary} />
                <Text style={styles.emptyActionText}>Limpiar filtros</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ),
      [
        products.length,
        searchQuery,
        canManageProducts,
        handleOpenNewProduct,
        isValidatingPlanLimit,
        handleCloudSearch,
        isCloudSearching,
        handleClearInventoryFilters,
      ]
    );

    // Guardar Producto (Nuevo o Editado) con todos los campos y merge seguro de sucursal única
    const handleSaveProduct = useCallback(
      async (formData: ProductFormData) => {
        if (!canManageProducts) {
          Alert.alert(
            'Acceso Denegado',
            'No cuentas con permisos para crear o modificar productos.'
          );
          return;
        }
        if (!accountId) return;

        if (!formData.id) {
          const limitCheck = await validateProductCreation();
          if (!limitCheck.allowed) {
            throw new Error(
              limitCheck.reason ||
                'Alcanzaste el límite de productos permitido por tu plan actual.'
            );
          }
        }

        const online = await checkIsOnlineLive(isOnline);

        const rawGallery = Array.isArray(formData.galleryImages)
          ? formData.galleryImages
          : formData.imageUrl
          ? [formData.imageUrl]
          : [];
        if (rawGallery.some((uri) => isLocalFileUri(uri)) && !online) {
          throw new Error(
            'Sin conexión a internet. Quita las imágenes nuevas o conéctate para subir fotos.'
          );
        }
        const uploadedGallery: string[] = [];
        for (const uri of rawGallery) {
          if (isLocalFileUri(uri)) {
            const remote = await uploadProductImageToStorage(uri, accountId, formData.id);
            uploadedGallery.push(remote);
          } else if (uri) {
            uploadedGallery.push(uri);
          }
        }
        const safeGallery = sanitizeRemoteImageUrls(uploadedGallery);
        const resolvedImageUrl =
          safeGallery[0] || (!isLocalFileUri(formData.imageUrl) && formData.imageUrl) || '';

        const stockMap = mergeSingleBranchStock({
          existingStock: editingProduct?.stock,
          stockByBranch: formData.stockByBranch,
          singleBranchStock: formData.stock,
          branchId,
          isMultiBranch: Boolean(branches && branches.length > 1),
          variants: formData.variants,
        });

        const normalizedAttributes: ProductAttribute[] = Array.isArray(formData.attributes)
          ? formData.attributes
              .map((a) => ({
                name: String(a?.name || '').trim(),
                value: String(a?.value ?? '').trim(),
              }))
              .filter((a) => a.name.length > 0 && a.value.length > 0)
          : formData.attributes && typeof formData.attributes === 'object'
          ? Object.entries(formData.attributes as Record<string, unknown>)
              .map(([k, v]) => ({ name: k.trim(), value: String(v ?? '').trim() }))
              .filter((a) => a.name.length > 0 && a.value.length > 0)
          : [];

        const productPayload = {
          id: formData.id,
          name: formData.name,
          category: formData.category,
          barcode: formData.barcode,
          barcodes: formData.barcodes || [],
          sku: formData.sku,
          brand: formData.brand,
          sizeLabel: formData.sizeLabel,
          sizes: formData.sizes || [],
          unitOfMeasure: formData.unitOfMeasure as any,
          allowDecimals: formData.allowDecimals,
          taxExemptionCode: formData.taxExemptionCode || '10',
          price: formData.price,
          suggestedPrice: formData.price,
          minSalePrice: formData.minSalePrice,
          costPrice: formData.cost,
          stock: stockMap,
          minStock: formData.minStock,
          presentations: formData.presentations as any,
          variants: formData.variants || [],
          priceTiers: formData.priceTiers || [],
          branchPrices: formData.branchPrices || {},
          attributes: normalizedAttributes,
          imageUrl: resolvedImageUrl,
          thumbUrl: resolvedImageUrl,
          galleryImages: safeGallery,
          accountId,
        };

        const activeBranchKey = branchId || 'main';
        const hasVariants = Array.isArray(formData.variants) && formData.variants.length > 0;
        const prevBranchStock = editingProduct
          ? typeof editingProduct.stock === 'object' && editingProduct.stock !== null
            ? Number((editingProduct.stock as Record<string, number>)[activeBranchKey] ?? 0)
            : Number(editingProduct.stock ?? 0)
          : 0;
        const nextBranchStock = Number(stockMap[activeBranchKey] ?? formData.stock ?? 0);
        const branchStockChanged = Boolean(
          formData.id &&
            editingProduct &&
            !hasVariants &&
            Math.abs(nextBranchStock - prevBranchStock) > 0.0001
        );
        const operatorProfile = {
          uid: user?.uid || 'user_pos',
          displayName:
            userProfile?.displayName || user?.displayName || user?.email || 'Administrador',
          email: user?.email || '',
        };

        if (!online) {
          const resolvedId = formData.id || generateOfflineProductId();
          const offlineProduct: Product = {
            ...(editingProduct || {}),
            id: resolvedId,
            name: formData.name,
            category: formData.category,
            barcode: formData.barcode,
            barcodes: formData.barcodes || [],
            sku: formData.sku,
            brand: formData.brand,
            sizeLabel: formData.sizeLabel,
            sizes: formData.sizes || [],
            unitOfMeasure: formData.unitOfMeasure as any,
            allowDecimals: Boolean(formData.allowDecimals),
            taxExemptionCode: formData.taxExemptionCode || '10',
            price: formData.price,
            suggestedPrice: formData.price,
            minSalePrice: formData.minSalePrice,
            costPrice: formData.cost,
            stock: stockMap,
            minStock: formData.minStock,
            presentations: formData.presentations as any,
            variants: formData.variants || [],
            priceTiers: formData.priceTiers || [],
            branchPrices: formData.branchPrices || {},
            attributes: normalizedAttributes,
            imageUrl: resolvedImageUrl,
            thumbUrl: resolvedImageUrl,
            galleryImages: safeGallery,
            accountId,
            active: true,
            branchIds: Object.keys(stockMap),
          };

          if (!formData.id) {
            await enqueueOfflineProductCreate({
              accountId,
              userId: operatorProfile.uid,
              branchId: activeBranchKey,
              productId: resolvedId,
              productData: { ...productPayload, id: resolvedId },
              previewProduct: offlineProduct,
              userProfile: operatorProfile,
            });
            lastKardexFetchRef.current = null;
            setSearchQuery(formData.name);
            Alert.alert(
              'Producto Guardado Offline',
              'El producto quedó guardado localmente y se sincronizará al volver la conexión.'
            );
            return;
          }

          await enqueueOfflineProductUpdate({
            accountId,
            userId: operatorProfile.uid,
            branchId: activeBranchKey,
            productId: formData.id,
            productData: productPayload,
            previewPatch: offlineProduct,
            userProfile: operatorProfile,
          });

          if (branchStockChanged) {
            await enqueueOfflineStockAdjust({
              accountId,
              userId: operatorProfile.uid,
              branchId: activeBranchKey,
              branchName: activeBranchName || 'Sucursal Principal',
              productId: formData.id,
              productName: formData.name,
              productSku: formData.sku,
              mode: 'set',
              amount: nextBranchStock,
              expectedBeforeStock: prevBranchStock,
              reason: 'Edición de producto (offline)',
              userProfile: operatorProfile,
            });
          }

          lastKardexFetchRef.current = null;
          setSearchQuery(formData.name);
          Alert.alert(
            'Cambios Guardados Offline',
            'La actualización del producto quedó guardada y se sincronizará al volver la conexión.'
          );
          return;
        }

        let savedId = formData.id;
        let adjResultStock: any = null;
        if (branchStockChanged && editingProduct) {
          savedId = await saveProduct(productPayload, false, operatorProfile, {
            skipStockField: true,
          });
          const adjRes = await adjustProductStock({
            product: editingProduct,
            branchId: activeBranchKey,
            branchName: activeBranchName || 'Sucursal Principal',
            newStock: nextBranchStock,
            reason: 'Edición de producto',
            userProfile: operatorProfile,
          });
          adjResultStock = adjRes?.updatedProductStock || null;
        } else {
          savedId = await saveProduct(productPayload, !formData.id, operatorProfile);
        }

        const fullProduct: Product = {
          ...(editingProduct || {}),
          id: savedId || formData.id || `prod_${Date.now()}`,
          name: formData.name,
          category: formData.category,
          barcode: formData.barcode,
          barcodes: formData.barcodes || [],
          sku: formData.sku,
          brand: formData.brand,
          sizeLabel: formData.sizeLabel,
          sizes: formData.sizes || [],
          unitOfMeasure: formData.unitOfMeasure as any,
          allowDecimals: Boolean(formData.allowDecimals),
          taxExemptionCode: formData.taxExemptionCode || '10',
          price: formData.price,
          suggestedPrice: formData.price,
          minSalePrice: formData.minSalePrice,
          costPrice: formData.cost,
          stock: stockMap,
          minStock: formData.minStock,
          presentations: formData.presentations as any,
          variants: formData.variants || [],
          priceTiers: formData.priceTiers || [],
          branchPrices: formData.branchPrices || {},
          attributes: normalizedAttributes,
          imageUrl: resolvedImageUrl,
          thumbUrl: resolvedImageUrl,
          galleryImages: safeGallery,
          accountId,
          active: true,
          branchIds: Object.keys(stockMap),
        };

        lastKardexFetchRef.current = null;
        upsertProduct(fullProduct);
        if (adjResultStock) {
          applyAuthoritativeStockUpdates([adjResultStock]);
        }
        if (!formData.id) {
          void refreshAccess?.().catch(() => {});
        }
        setSearchQuery(formData.name);
      },
      [
        accountId,
        activeBranchName,
        applyAuthoritativeStockUpdates,
        branchId,
        branches,
        canManageProducts,
        editingProduct,
        isOnline,
        lastKardexFetchRef,
        refreshAccess,
        upsertProduct,
        user?.displayName,
        user?.email,
        user?.uid,
        userProfile?.displayName,
        validateProductCreation,
      ]
    );

    return (
      <>
        <CatalogPlanLimitBanner />

        {refreshing || productsError ? (
          <View style={styles.catalogSyncNotice}>
            <View style={styles.catalogSyncCopy}>
              {refreshing ? <ActivityIndicator size="small" color={ui.primary} /> : null}
              <Text style={styles.catalogSyncText}>
                {productsError || 'Sincronizando catálogo…'}
              </Text>
            </View>
            {productsError ? (
              <TouchableOpacity
                onPress={refreshProducts}
                accessibilityRole="button"
                accessibilityLabel="Reintentar sincronización del catálogo"
              >
                <Text style={styles.catalogRetryText}>Reintentar</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <CatalogInventorySummary
          catalogComplete={catalogComplete}
          hasProducts={products.length > 0}
          canViewMargins={canViewMargins}
          canManageProducts={canManageProducts}
          valuationExpanded={valuationExpanded}
          onToggleValuation={handleToggleValuation}
          onOpenNewProduct={handleOpenNewProduct}
          isValidatingPlanLimit={isValidatingPlanLimit}
          statusFilter={statusFilter}
          onChangeStatusFilter={handleChangeStatusFilter}
        />

        <View style={styles.inventorySearchRow}>
          <View style={styles.searchBarWrapper}>
            <Search size={16} color={ui.textSecondary} style={{ marginRight: 6 }} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Producto, SKU o código"
              placeholderTextColor={ui.textMuted}
              returnKeyType="search"
              accessibilityLabel="Buscar productos por nombre, SKU o código de barras"
            />
            {searchQuery ? (
              <TouchableOpacity
                onPress={handleClearSearchText}
                style={styles.clearSearchBtn}
                accessibilityRole="button"
                accessibilityLabel="Borrar búsqueda"
                hitSlop={4}
              >
                <X size={16} color={ui.textSecondary} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.inventoryCountBadge}>
            <Text style={styles.inventoryCountNumber}>
              {catalogComplete || filteredProducts.length > 0 ? filteredProducts.length : '…'}
            </Text>
            <Text style={styles.inventoryCountLabel}>prod.</Text>
          </View>

          <TouchableOpacity
            style={styles.inventoryScanBtn}
            onPress={handleOpenCatalogScanner}
            accessibilityRole="button"
            accessibilityLabel="Escanear código de barras en inventario"
            activeOpacity={0.7}
          >
            <Barcode size={20} color={ui.primary} />
          </TouchableOpacity>
        </View>

        <InlineFilterBar groups={catalogFilterGroups} />

        <View style={styles.inventoryListWrapper}>
          {productsLoading ? (
            <View style={styles.centerLoading}>
              <ActivityIndicator size="large" color={ui.primary} />
              <Text style={styles.centerLoadingText}>Cargando inventario...</Text>
            </View>
          ) : (
            <FlashList
              data={filteredProducts}
              estimatedItemSize={
                hasInventoryActions ? (showAttributes ? 214 : 196) : showAttributes ? 162 : 144
              }
              overrideItemLayout={overrideCatalogItemLayout}
              estimatedListSize={estimatedCatalogListSize}
              drawDistance={250}
              extraData={branchId}
              keyExtractor={catalogKeyExtractor}
              getItemType={getCatalogItemType}
              contentContainerStyle={styles.catalogListContent}
              renderItem={renderCatalogItem}
              ListEmptyComponent={filteredProducts.length === 0 ? catalogEmptyComponent : undefined}
            />
          )}
        </View>

        {/* MODAL 1: AJUSTE RÁPIDO DE STOCK (AISLADO) */}
        {stockModalOpen &&
          (() => {
            const QuickStockAdjustModal = getQuickStockAdjustModal();
            return (
              <QuickStockAdjustModal
                visible={stockModalOpen}
                product={adjustingProduct}
                onClose={handleCloseStockModal}
                onStockAdjusted={onStockAdjusted}
              />
            );
          })()}

        {/* MODAL 3: CREAR / EDITAR PRODUCTO */}
        {productModalOpen &&
          (() => {
            const ProductFormModal = getProductFormModal();
            return (
              <ProductFormModal
                visible={productModalOpen}
                product={editingProduct}
                onClose={handleCloseProductModal}
                onSave={handleSaveProduct}
                branchId={branchId}
              />
            );
          })()}

        {/* MODAL 5: ESCÁNER DE CÓDIGO DE BARRAS EN INVENTARIO */}
        {catalogScannerOpen &&
          (() => {
            const BarcodeScannerModal = getBarcodeScannerModal();
            return (
              <BarcodeScannerModal
                visible={catalogScannerOpen}
                onClose={handleCloseCatalogScanner}
                onScan={handleCatalogScan}
                title="Escanear en Inventario"
              />
            );
          })()}
      </>
    );
  }
);

export default function CatalogInventoryScreen() {
  const isFocused = useIsFocused();
  const { features, planName } = usePlanFeatures();
  const { canManageInventoryAdjustments, hasPermission } = usePermissions();
  const showPurchasesTab = canManageInventoryAdjustments || hasPermission('access_suppliers');

  const [activeTab, setActiveTab] = useState<ActiveTab>('inventory');
  const [visitedTabs, setVisitedTabs] = useState<Record<ActiveTab, boolean>>({
    inventory: true,
    kardex: false,
    transfers: false,
    purchases: false,
  });

  useEffect(() => {
    if (!features.transfers && activeTab === 'transfers') {
      setActiveTab('inventory');
    }
  }, [features.transfers, activeTab]);

  // Kardex cache refs (state isolated in KardexSubTab)
  const lastKardexFetchRef = useRef<{ scopeKey: string; fetchedAt: number } | null>(null);
  const kardexListCacheRef = useRef<{ scopeKey: string; data: any[] } | null>(null);
  const lastKardexSyncAtRef = useRef<number | null>(null);

  const selectTab = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  }, []);

  const handleSelectInventoryTab = useCallback(() => selectTab('inventory'), [selectTab]);
  const handleSelectKardexTab = useCallback(() => selectTab('kardex'), [selectTab]);
  const handleSelectTransfersTab = useCallback(() => selectTab('transfers'), [selectTab]);
  const handleSelectPurchasesTab = useCallback(() => selectTab('purchases'), [selectTab]);
  const handleBackToInventoryTab = useCallback(() => selectTab('inventory'), [selectTab]);

  const handleStockAdjusted = useCallback(() => {
    lastKardexFetchRef.current = null;
  }, []);

  return (
    <View style={styles.container}>
      {/* 1. SELECTOR DE SUB-PESTAÑAS ARRIBA, DEBAJO DEL HEADER */}
      <View style={styles.tabsNavWrapper}>
        <View style={styles.tabsNavRow}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'inventory' && styles.tabBtnActive]}
            onPress={handleSelectInventoryTab}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'inventory' }}
            accessibilityLabel="Inventario"
          >
            <Package
              size={16}
              color={activeTab === 'inventory' ? ui.primary : ui.textSecondary}
            />
            <Text
              style={[styles.tabBtnText, activeTab === 'inventory' && styles.tabBtnTextActive]}
              numberOfLines={1}
            >
              Inventario
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'kardex' && styles.tabBtnActive]}
            onPress={handleSelectKardexTab}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'kardex' }}
            accessibilityLabel="Movimientos de inventario"
          >
            <History size={16} color={activeTab === 'kardex' ? ui.primary : ui.textSecondary} />
            <Text
              style={[styles.tabBtnText, activeTab === 'kardex' && styles.tabBtnTextActive]}
              numberOfLines={1}
            >
              Movimientos
            </Text>
          </TouchableOpacity>

          {features.transfers && (
            <TouchableOpacity
              style={[styles.tabBtn, activeTab === 'transfers' && styles.tabBtnActive]}
              onPress={handleSelectTransfersTab}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'transfers' }}
              accessibilityLabel="Transferencias"
            >
              <ArrowRightLeft
                size={16}
                color={activeTab === 'transfers' ? ui.primary : ui.textSecondary}
              />
              <Text
                style={[styles.tabBtnText, activeTab === 'transfers' && styles.tabBtnTextActive]}
                numberOfLines={1}
              >
                Transferencias
              </Text>
            </TouchableOpacity>
          )}

          {showPurchasesTab && (
            <TouchableOpacity
              style={[styles.tabBtn, activeTab === 'purchases' && styles.tabBtnActive]}
              onPress={handleSelectPurchasesTab}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'purchases' }}
              accessibilityLabel={
                features.purchases ? 'Compras a proveedores' : 'Compras a proveedores (requiere mejora de plan)'
              }
            >
              <Truck size={15} color={activeTab === 'purchases' ? ui.primary : ui.textSecondary} />
              <Text
                style={[styles.tabBtnText, activeTab === 'purchases' && styles.tabBtnTextActive]}
                numberOfLines={1}
              >
                Compras
              </Text>
              {!features.purchases && (
                <Lock size={12} color={activeTab === 'purchases' ? ui.primary : ui.textMuted} />
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* 2. CONTENEDOR CONSTANT-GEOMETRY FABRIC-SAFE */}
      <View style={styles.panelsStage} collapsable={false}>
        <View
          key="panel-inventory"
          collapsable={false}
          style={[
            styles.panelSlot,
            activeTab === 'inventory' ? styles.panelSlotActive : styles.panelSlotInactive,
          ]}
          pointerEvents={activeTab === 'inventory' ? 'auto' : 'none'}
          importantForAccessibility={activeTab === 'inventory' ? 'yes' : 'no-hide-descendants'}
        >
          <InventorySubTab
            isFocused={isFocused && activeTab === 'inventory'}
            onStockAdjusted={handleStockAdjusted}
            lastKardexFetchRef={lastKardexFetchRef}
          />
        </View>

        {visitedTabs.kardex ? (
          <View
            key="panel-kardex"
            collapsable={false}
            style={[
              styles.panelSlot,
              activeTab === 'kardex' ? styles.panelSlotActive : styles.panelSlotInactive,
            ]}
            pointerEvents={activeTab === 'kardex' ? 'auto' : 'none'}
            importantForAccessibility={activeTab === 'kardex' ? 'yes' : 'no-hide-descendants'}
          >
            <KardexSubTab
              isActive={activeTab === 'kardex' && isFocused}
              lastKardexFetchRef={lastKardexFetchRef}
              kardexListCacheRef={kardexListCacheRef}
              lastKardexSyncAtRef={lastKardexSyncAtRef}
            />
          </View>
        ) : null}

        {features.transfers && visitedTabs.transfers ? (
          <View
            key="panel-transfers"
            collapsable={false}
            style={[
              styles.panelSlot,
              activeTab === 'transfers' ? styles.panelSlotActive : styles.panelSlotInactive,
            ]}
            pointerEvents={activeTab === 'transfers' ? 'auto' : 'none'}
            importantForAccessibility={activeTab === 'transfers' ? 'yes' : 'no-hide-descendants'}
          >
            <TransfersSubTab
              isActive={activeTab === 'transfers' && isFocused}
              lastKardexFetchRef={lastKardexFetchRef}
            />
          </View>
        ) : null}

        {visitedTabs.purchases ? (
          <View
            key="panel-purchases"
            collapsable={false}
            style={[
              styles.panelSlot,
              activeTab === 'purchases' ? styles.panelSlotActive : styles.panelSlotInactive,
            ]}
            pointerEvents={activeTab === 'purchases' ? 'auto' : 'none'}
            importantForAccessibility={activeTab === 'purchases' ? 'yes' : 'no-hide-descendants'}
          >
            {features.purchases ? (
              <SuppliersPurchaseModal
                visible
                isActive={activeTab === 'purchases' && isFocused}
                embedded
                onClose={handleBackToInventoryTab}
                onStockUpdated={handleStockAdjusted}
              />
            ) : (
              <PlanLockedView feature="purchases" currentPlanName={planName} />
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  panelsStage: {
    flex: 1,
    position: 'relative',
  },
  panelSlot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: ui.background,
  },
  panelSlotActive: {
    opacity: 1,
    zIndex: 2,
  },
  panelSlotInactive: {
    opacity: 0,
    zIndex: 0,
  },
  subTabContainer: {
    flex: 1,
    paddingHorizontal: 14,
  },
  inventoryListWrapper: {
    flex: 1,
    marginTop: 4,
  },
  emptyActionsStack: {
    gap: 8,
    alignItems: 'center',
  },
  emptyCloudSearchBtn: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  kpiContainer: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 4,
  },
  inventorySummary: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  valuationHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  valuationToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    minWidth: 0,
    paddingVertical: 4,
  },
  valuationRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  valuationLabel: { color: ui.textSecondary, fontSize: 13 },
  valuationAmount: {
    color: ui.text,
    fontSize: 19,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  inventoryCounts: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  kpiFilterPill: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: ui.background,
  },
  kpiFilterPillActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  kpiFilterPillActiveWarning: {
    backgroundColor: ui.warningSoft,
    borderColor: ui.warning,
  },
  kpiFilterPillActiveDanger: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.danger,
  },
  inventoryCount: { color: ui.textSecondary, fontSize: 12, lineHeight: 18 },
  inventoryCountValue: { fontWeight: '700' },
  kpiCountTextActive: { color: ui.primary, fontWeight: '700' },
  kpiCountTextActiveWarning: { color: ui.warning, fontWeight: '700' },
  kpiCountTextActiveDanger: { color: ui.danger, fontWeight: '700' },
  kpiWarning: { color: ui.warning },
  kpiDanger: { color: ui.danger },
  kpiSuccess: { color: ui.success },
  compactHeaderAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    minHeight: 34,
    borderRadius: 9,
    justifyContent: 'center',
  },
  compactHeaderActionText: {
    color: ui.onPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  tabsNavWrapper: {
    backgroundColor: ui.surface,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  tabsNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.surfaceMuted,
    padding: 3,
    borderRadius: 12,
  },
  tabBtn: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    paddingHorizontal: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: 9,
  },
  tabBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  tabBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
    flexShrink: 1,
  },
  tabBtnTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  inventorySearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 8,
  },
  searchBarWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 50,
    borderWidth: 1,
    borderColor: ui.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: ui.text,
    paddingVertical: 0,
  },
  clearSearchBtn: {
    minWidth: 44,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inventoryScanBtn: {
    width: 50,
    height: 50,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary + '30',
    alignItems: 'center',
    justifyContent: 'center',
  },
  transferSearchInput: {
    flex: 1,
    fontSize: 13,
    color: ui.text,
    paddingVertical: 0,
  },
  centerLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  catalogSyncNotice: {
    minHeight: 38,
    marginHorizontal: 14,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  subtabSyncNotice: {
    minHeight: 34,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 9,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  catalogSyncCopy: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  catalogSyncText: { flex: 1, color: ui.textSecondary, fontSize: 11, fontWeight: '600' },
  catalogRetryText: { color: ui.primary, fontSize: 11, fontWeight: '800' },
  centerLoadingText: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 10,
  },
  emptyView: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primarySoft,
  },
  emptyViewTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: ui.text,
    marginTop: 10,
  },
  emptyViewSubtitle: {
    maxWidth: 320,
    fontSize: 13,
    lineHeight: 19,
    color: ui.textSecondary,
    marginTop: 4,
    textAlign: 'center',
  },
  emptyActionBtn: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 18,
    paddingHorizontal: 16,
    backgroundColor: ui.primarySoft,
    borderRadius: 12,
  },
  emptyActionText: {
    color: ui.primary,
    fontSize: 13,
    fontWeight: '700',
  },
  inventoryCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  inventoryCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  productMark: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  productMarkGlyph: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.primary,
  },
  productIdentity: {
    flex: 1,
    minWidth: 0,
  },
  inventoryCardName: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
    color: ui.text,
  },
  inventoryCardSku: {
    flexShrink: 1,
    fontSize: 11,
    color: ui.textSecondary,
  },
  productMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  productCategory: {
    maxWidth: 110,
    fontSize: 11,
    color: ui.textSecondary,
  },
  metaSeparator: { color: ui.textMuted },
  productFinancialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  salePriceBlock: {
    flex: 1,
  },
  metricLabel: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  salePriceValue: {
    marginTop: 1,
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
    fontVariant: ['tabular-nums'],
  },
  secondaryFinancials: {
    flexDirection: 'row',
    gap: 14,
  },
  secondaryMetric: {
    alignItems: 'flex-end',
  },
  metricValue: {
    marginTop: 3,
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
    fontVariant: ['tabular-nums'],
  },
  stockStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  stockStatusBadgeGreen: {
    backgroundColor: ui.successSoft,
  },
  stockStatusBadgeAmber: {
    backgroundColor: ui.warningSoft,
  },
  stockStatusBadgeRed: {
    backgroundColor: ui.dangerSoft,
  },
  stockStatusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  stockStatusTextGreen: {
    color: ui.success,
  },
  stockStatusTextAmber: {
    color: ui.warning,
  },
  stockStatusTextRed: {
    color: ui.danger,
  },
  inventoryActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  productAttrText: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 3,
  },
  inventoryCountBadge: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 10,
    minHeight: 46,
  },
  inventoryCountNumber: {
    fontSize: 13,
    fontWeight: '800',
    color: ui.text,
    lineHeight: 16,
  },
  inventoryCountLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  actionBtnStock: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 10,
    minHeight: 40,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
  },
  actionBtnStockText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.warning,
  },
  actionBtnEdit: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 10,
    minHeight: 40,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
  },
  actionBtnEditText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  kardexHeaderBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  kardexSubtitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  kardexSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
    borderWidth: 1,
    borderColor: ui.border,
  },
  refreshBtn: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
  },
  refreshBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  kardexCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  kardexCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  kardexProductName: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  kardexDateText: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  kardexTypeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  kardexTypeBadgeGreen: {
    backgroundColor: ui.successSoft,
  },
  kardexTypeBadgeRed: {
    backgroundColor: ui.dangerSoft,
  },
  kardexTypeBadgePurple: {
    backgroundColor: ui.accentSoft,
  },
  kardexTypeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  kardexTypeTextGreen: {
    color: ui.success,
  },
  kardexTypeTextRed: {
    color: ui.danger,
  },
  kardexTypeTextPurple: {
    color: ui.accent,
  },
  kardexCardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.background,
  },
  kardexReason: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  kardexStockChange: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.text,
  },
  transfersHeaderBar: {
    paddingVertical: 4,
  },
  newTransferBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  newTransferBtnText: {
    color: ui.surface,
    fontSize: 12,
    fontWeight: '700',
  },
  transferCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  transferCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  transferNumber: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  transferStatusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: ui.primarySoft,
  },
  transferStatusText: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.primary,
  },
  transferRouteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  transferRouteText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
  },
  transferDetailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.background,
  },
  transferDetailsText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  transferDateText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  transferActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  transferActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 7,
    backgroundColor: ui.background,
  },
  transferActionText: { fontSize: 11, fontWeight: '700', color: ui.primary },
  transferEmitGuideButton: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  transferEmitGuideText: {
    color: ui.primary,
  },
  catalogListContent: {
    paddingHorizontal: 14,
    paddingBottom: 30,
  },
  listPaddingBottom: {
    paddingBottom: 30,
  },
  productThumbnail: {
    width: 44,
    height: 44,
    borderRadius: 10,
  },
  planLimitBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 14,
    marginTop: 6,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: ui.warningSoft,
    borderWidth: 1,
    borderColor: ui.warning + '40',
  },
  planLimitBannerFull: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.danger + '40',
  },
  planLimitText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: ui.warning,
  },
  planLimitTextDanger: {
    color: ui.danger,
  },
  kardexFilterBox: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    marginBottom: 10,
  },
  kardexProductChip: {
    maxWidth: 180,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary + '30',
  },
  kardexProductChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  transferCardItemsList: {
    marginTop: 8,
    paddingTop: 8,
    paddingHorizontal: 10,
    paddingBottom: 6,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    gap: 3,
  },
  transferCardItemLine: {
    fontSize: 12,
    color: ui.textSecondary,
    lineHeight: 17,
  },
  transferCardItemMore: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.primary,
    marginTop: 2,
  },
});
