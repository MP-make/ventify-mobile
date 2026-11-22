import React, { useState, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  Package,
  Plus,
  Search,
  Zap,
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
  Edit3,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';

import { useProducts } from '@/context/ProductsContext';
import { useAuthSession, usePlanAccess } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import {
  getProductKardex,
  getStockTransfers,
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
import { ProductFormModal, type ProductFormData } from '@/components/ProductFormModal';
import { collection, query, where, getDocs, limit as fsLimit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { SuppliersPurchaseModal } from '@/components/SuppliersPurchaseModal';
import { InlineFilterBar, type FilterGroup, type FilterOption } from '@/components/InlineFilterBar';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { QuickStockAdjustModal } from '@/components/catalog/QuickStockAdjustModal';
import { NewTransferModal } from '@/components/catalog/NewTransferModal';
import {
  DEFAULT_CATALOG_BRANDS,
  DEFAULT_CATALOG_SIZES,
  mergeCatalogOptions,
  filterCatalogIndex,
  getCatalogCategoryCounts,
} from '@/lib/catalog-filters';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { catalogSizeInput } from '@/lib/product-attributes';
import type { Product, ProductAttribute } from '@/types';

type ActiveTab = 'inventory' | 'kardex' | 'transfers';
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
  const imageSource = useMemo(() => {
    const uri = item.thumbUrl || item.imageUrl;
    return uri ? { uri } : null;
  }, [item.thumbUrl, item.imageUrl]);

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
            />
          ) : (
            <Package size={18} color={ui.primary} />
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
          {brandLabel || sizeLabel ? (
            <Text style={styles.productAttrText} numberOfLines={1}>
              {[brandLabel ? `Marca: ${brandLabel}` : '', sizeLabel ? `Medida: ${sizeLabel}` : '']
                .filter(Boolean)
                .join(' · ')}
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
              <Edit3 size={15} color={ui.primary} />
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
              <Zap size={15} color={ui.warning} />
              <Text style={styles.actionBtnStockText}>Ajustar stock</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
});

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
            <TouchableOpacity
              key={action}
              onPress={() => onRunAction(item, action)}
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
          ))}
          {canEmitGuide && (
            <TouchableOpacity
              onPress={handleEmitPress}
              disabled={isEmittingGuide}
              style={[
                styles.transferActionButton,
                { borderColor: ui.primary, backgroundColor: ui.primarySoft },
              ]}
              accessibilityRole="button"
            >
              {isEmittingGuide ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <Text style={[styles.transferActionText, { color: ui.primary }]}>
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

export default function CatalogInventoryScreen() {
  const isFocused = useIsFocused();
  const { accountId, branchId, user, userProfile } = useAuthSession();
  const { refreshAccess } = usePlanAccess();
  const {
    canManageProducts,
    canManageInventoryAdjustments,
    canViewMargins,
    canRequestTransfer,
    canApproveTransfer,
    canManageTransfers,
    canAccessBranch,
    hasPermission,
  } = usePermissions();
  const {
    products,
    catalogIndex,
    categories,
    stats,
    loading: productsLoading,
    refreshing,
    catalogComplete,
    error: productsError,
    productPlanLimit,
    refreshProducts,
    getProductStock,
    upsertProduct,
    upsertProductsBatch,
    validateProductCreation,
  } = useProducts();
  const { branches, invoicingEnabled, posSettings } = useBusinessSettings();
  const showAttributes = !!posSettings?.enableCatalogFilters;

  // Sub-pestaña activa
  const [activeTab, setActiveTab] = useState<ActiveTab>('inventory');
  const [suppliersModalOpen, setSuppliersModalOpen] = useState(false);
  const [valuationExpanded, setValuationExpanded] = useState(true);

  // Filtros de Inventario
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StockStatusFilter>('all');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [selectedBrand, setSelectedBrand] = useState('Todas');
  const [selectedSize, setSelectedSize] = useState('Todas');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 150);

  // Focus-gated catalog filter memos (cached while screen is blurred)
  const availableBrandsCacheRef = useRef<string[] | null>(null);
  const availableBrands = useMemo(() => {
    if (!isFocused && availableBrandsCacheRef.current !== null) {
      return availableBrandsCacheRef.current;
    }
    if (!isFocused) return EMPTY_OPTIONS;
    const next = ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_BRANDS, catalogIndex.brands)];
    availableBrandsCacheRef.current = next;
    return next;
  }, [isFocused, catalogIndex]);

  const availableSizesCacheRef = useRef<string[] | null>(null);
  const availableSizes = useMemo(() => {
    if (!isFocused && availableSizesCacheRef.current !== null) {
      return availableSizesCacheRef.current;
    }
    if (!isFocused) return EMPTY_OPTIONS;
    const next = ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_SIZES, catalogIndex.sizes)];
    availableSizesCacheRef.current = next;
    return next;
  }, [isFocused, catalogIndex]);

  const categoryCountsCacheRef = useRef<FilterOption[] | null>(null);
  const categoryListWithCounts = useMemo(() => {
    if (!isFocused && categoryCountsCacheRef.current !== null) {
      return categoryCountsCacheRef.current;
    }
    if (!isFocused) return EMPTY_CATEGORY_OPTIONS;
    const next = getCatalogCategoryCounts(categories, catalogIndex).map((option) => ({
      ...option,
      count: catalogComplete ? option.count : undefined,
    }));
    categoryCountsCacheRef.current = next;
    return next;
  }, [isFocused, categories, catalogIndex, catalogComplete]);

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
  }, [accountId, searchQuery, isCloudSearching, upsertProductsBatch]);

  // Modal de Ajuste Rápido de Stock (estado de formulario aislado en QuickStockAdjustModal)
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null);
  const [isValidatingPlanLimit, setIsValidatingPlanLimit] = useState(false);

  // Sub-pestaña Kardex + TTL cache
  const [kardexList, setKardexList] = useState<any[]>([]);
  const [kardexLoading, setKardexLoading] = useState(false);
  const [kardexSearch, setKardexSearch] = useState('');
  const [kardexSelectedProductId, setKardexSelectedProductId] = useState<string | null>(null);
  const kardexSelectedProductIdRef = useRef<string | null>(null);
  kardexSelectedProductIdRef.current = kardexSelectedProductId;
  const debouncedKardexSearch = useDebouncedValue(kardexSearch, 150);
  const lastKardexFetchRef = useRef<{ scopeKey: string; fetchedAt: number } | null>(null);
  const kardexScopeRef = useRef<string>('');
  const kardexRequestSeqRef = useRef<number>(0);

  // Sub-pestaña Transferencias + TTL cache
  const [transfersList, setTransfersList] = useState<StockTransfer[]>([]);
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [transferActionId, setTransferActionId] = useState<string | null>(null);
  const [isEmittingGuideId, setIsEmittingGuideId] = useState<string | null>(null);
  const [newTransferModalOpen, setNewTransferModalOpen] = useState(false);
  const lastTransfersFetchRef = useRef<{ scopeKey: string; fetchedAt: number } | null>(null);
  const transfersScopeRef = useRef<string>('');
  const transfersRequestSeqRef = useRef<number>(0);

  // Escáner de código de barras en inventario
  const [catalogScannerOpen, setCatalogScannerOpen] = useState(false);

  const filteredKardexProductsCacheRef = useRef<Product[] | null>(null);
  const filteredKardexProducts = useMemo(() => {
    if (!isFocused && filteredKardexProductsCacheRef.current !== null) {
      return filteredKardexProductsCacheRef.current;
    }
    if (!isFocused || !debouncedKardexSearch.trim()) {
      filteredKardexProductsCacheRef.current = EMPTY_PRODUCTS;
      return EMPTY_PRODUCTS;
    }
    const next = filterCatalogIndex(catalogIndex, { query: debouncedKardexSearch, limit: 8 });
    filteredKardexProductsCacheRef.current = next;
    return next;
  }, [isFocused, catalogIndex, debouncedKardexSearch]);

  // Cálculo de Métricas KPI Superiores desde el índice incremental de ProductsContext
  const kpis = useMemo(
    () => ({
      totalSkus: stats.totalProducts,
      valuation: stats.valuation,
      lowStockCount: stats.lowStockCount,
      outOfStockCount: stats.outOfStockCount,
    }),
    [stats]
  );

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
  const filteredProductsCacheRef = useRef<Product[] | null>(null);
  const filteredProducts = useMemo(() => {
    if (!isFocused && filteredProductsCacheRef.current !== null) {
      return filteredProductsCacheRef.current;
    }
    if (!isFocused) return EMPTY_PRODUCTS;
    const next = filterCatalogIndex(catalogIndex, {
      query: debouncedSearchQuery,
      category: selectedCategory,
      brand: selectedBrand,
      size: selectedSize,
      include: stockStatusPredicate,
    });
    filteredProductsCacheRef.current = next;
    return next;
  }, [
    isFocused,
    catalogIndex,
    debouncedSearchQuery,
    selectedCategory,
    selectedBrand,
    selectedSize,
    stockStatusPredicate,
  ]);

  // Carga de Kardex con TTL de 45s y stale-while-revalidate
  const loadKardex = useCallback(
    async (productIdOverride?: string | null, force = false) => {
      if (!accountId || !branchId) return;
      const effectiveProductId =
        productIdOverride !== undefined ? productIdOverride : kardexSelectedProductIdRef.current;
      const scopeKey = `${accountId}:${branchId}:${effectiveProductId || ''}`;
      const baseScopeKey = `${accountId}:${branchId}`;

      if (!force && lastKardexFetchRef.current) {
        const { scopeKey: lastScope, fetchedAt } = lastKardexFetchRef.current;
        if (lastScope === scopeKey && Date.now() - fetchedAt < SUBTAB_FETCH_TTL_MS) {
          return;
        }
      }

      if (kardexScopeRef.current && kardexScopeRef.current !== baseScopeKey) {
        setKardexList([]);
      }
      kardexScopeRef.current = baseScopeKey;

      const reqId = ++kardexRequestSeqRef.current;
      try {
        setKardexLoading(true);
        const data = await getProductKardex(
          accountId,
          branchId,
          effectiveProductId || undefined,
          60
        );
        if (kardexRequestSeqRef.current !== reqId) return;
        setKardexList(data || []);
        lastKardexFetchRef.current = { scopeKey, fetchedAt: Date.now() };
      } catch (err) {
        console.error('[Catalog] Error cargando Kardex:', err);
      } finally {
        if (kardexRequestSeqRef.current === reqId) {
          setKardexLoading(false);
        }
      }
    },
    [accountId, branchId]
  );

  const displayedKardexList = useMemo(() => {
    if (kardexSelectedProductId || !debouncedKardexSearch.trim()) return kardexList;
    const term = debouncedKardexSearch.trim().toLowerCase();
    return kardexList.filter(
      (item) =>
        String(item.productName || '').toLowerCase().includes(term) ||
        String(item.productSku || '').toLowerCase().includes(term) ||
        String(item.referenceNumber || '').toLowerCase().includes(term)
    );
  }, [kardexList, kardexSelectedProductId, debouncedKardexSearch]);

  // Carga de Transferencias con TTL de 45s y stale-while-revalidate
  const loadTransfers = useCallback(
    async (force = false) => {
      if (!accountId) return;
      const scopeKey = `${accountId}:${branchId}`;

      if (!force && lastTransfersFetchRef.current) {
        const { scopeKey: lastScope, fetchedAt } = lastTransfersFetchRef.current;
        if (lastScope === scopeKey && Date.now() - fetchedAt < SUBTAB_FETCH_TTL_MS) {
          return;
        }
      }

      if (transfersScopeRef.current && transfersScopeRef.current !== scopeKey) {
        setTransfersList([]);
      }
      transfersScopeRef.current = scopeKey;

      const reqId = ++transfersRequestSeqRef.current;
      try {
        setTransfersLoading(true);
        const data = await getStockTransfers(accountId, branchId);
        if (transfersRequestSeqRef.current !== reqId) return;
        setTransfersList(data || []);
        lastTransfersFetchRef.current = { scopeKey, fetchedAt: Date.now() };
      } catch (err) {
        console.error('[Catalog] Error cargando transferencias:', err);
      } finally {
        if (transfersRequestSeqRef.current === reqId) {
          setTransfersLoading(false);
        }
      }
    },
    [accountId, branchId]
  );

  const handleEmitDespatchGuide = useCallback(
    async (transfer: StockTransfer) => {
      if (!accountId || !transfer.id) return;
      setIsEmittingGuideId(transfer.id);
      try {
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
    [accountId, loadTransfers]
  );

  const runTransferAction = useCallback(
    async (
      transfer: StockTransfer,
      action: 'approve' | 'reject' | 'cancel' | 'send' | 'receive'
    ) => {
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
      loadTransfers,
      user,
      userProfile,
      invoicingEnabled,
      handleEmitDespatchGuide,
    ]
  );

  useFocusEffect(
    useCallback(() => {
      if (activeTab === 'kardex') {
        void loadKardex();
      } else if (activeTab === 'transfers') {
        void loadTransfers();
      }
    }, [activeTab, loadKardex, loadTransfers])
  );

  // Abrir Modal de Ajuste de Stock
  const openStockModal = useCallback((product: Product) => {
    setAdjustingProduct(product);
    setStockModalOpen(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleCloseStockModal = useCallback(() => {
    setStockModalOpen(false);
  }, []);

  const handleStockAdjusted = useCallback(() => {
    lastKardexFetchRef.current = null;
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

  const handleOpenSuppliersModal = useCallback(() => {
    setSuppliersModalOpen(true);
  }, []);

  const handleCloseSuppliersModal = useCallback(() => {
    setSuppliersModalOpen(false);
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
  }, [loadTransfers]);

  const handleRefreshKardexPress = useCallback(() => {
    void loadKardex(undefined, true);
  }, [loadKardex]);

  const handleRefreshTransfersPress = useCallback(() => {
    void loadTransfers(true);
  }, [loadTransfers]);

  const handleClearInventoryFilters = useCallback(() => {
    setSearchQuery('');
    setStatusFilter('all');
    setSelectedCategory('Todas');
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
      `${item.thumbUrl || item.imageUrl ? 'img' : 'noimg'}_${
        showAttributes && (item.brand || Boolean(item.sizes?.length || item.sizeLabel))
          ? 'attr'
          : 'plain'
      }`,
    [showAttributes]
  );

  const kardexKeyExtractor = useCallback(
    (item: any) =>
      item.id ||
      `${item.productId || 'kardex'}_${item.createdAt || ''}_${item.quantityChanged ?? item.quantity ?? ''}`,
    []
  );
  const getKardexItemType = useCallback(() => 'kardex', []);
  const renderKardexItem = useCallback(({ item }: { item: any }) => <KardexRow item={item} />, []);

  const transfersKeyExtractor = useCallback(
    (item: StockTransfer) => item.id || `trf_${item.transferNumber}`,
    []
  );
  const getTransferItemType = useCallback((item: StockTransfer) => {
    const isActive =
      item.status === 'pending' || item.status === 'approved' || item.status === 'in_transit';
    const lineBucket = Math.min((item.items || []).length, 4);
    return `${isActive ? 'active' : 'terminal'}_${lineBucket}`;
  }, []);
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

      const rawGallery = Array.isArray(formData.galleryImages)
        ? formData.galleryImages
        : formData.imageUrl
        ? [formData.imageUrl]
        : [];
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

      const savedId = await saveProduct(productPayload, !formData.id, {
        uid: user?.uid || 'user_pos',
        displayName:
          userProfile?.displayName || user?.displayName || user?.email || 'Administrador',
        email: user?.email || '',
      });

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
      if (!formData.id) {
        void refreshAccess?.().catch(() => {});
      }
      setSearchQuery(formData.name);
    },
    [
      accountId,
      branchId,
      branches,
      canManageProducts,
      editingProduct,
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
    <View style={styles.container}>
      {/* 1. SELECTOR DE SUB-PESTAÑAS ARRIBA, DEBAJO DEL HEADER */}
      <View style={styles.tabsNavWrapper}>
        <View style={styles.tabsNavRow}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'inventory' && styles.tabBtnActive]}
            onPress={() => setActiveTab('inventory')}
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
            onPress={() => setActiveTab('kardex')}
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

          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'transfers' && styles.tabBtnActive]}
            onPress={() => setActiveTab('transfers')}
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

          {(canManageInventoryAdjustments || hasPermission('access_suppliers')) && (
            <TouchableOpacity
              style={styles.tabBtn}
              onPress={handleOpenSuppliersModal}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Abrir compras a proveedores"
            >
              <Truck size={16} color={ui.primary} />
              <Text style={[styles.tabBtnText, { color: ui.primary }]} numberOfLines={1}>
                Compras
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {activeTab === 'inventory' &&
      productPlanLimit &&
      (productPlanLimit.isAtLimit || productPlanLimit.isNearLimit) ? (
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
            style={[styles.planLimitText, productPlanLimit.isAtLimit && { color: ui.danger }]}
          >
            {productPlanLimit.isAtLimit
              ? `Límite del plan alcanzado (${productPlanLimit.current}/${productPlanLimit.max} productos). Mejora tu plan para crear más.`
              : `Cerca del límite de tu plan: ${productPlanLimit.current}/${productPlanLimit.max} productos.`}
          </Text>
        </View>
      ) : null}

      {activeTab === 'inventory' && (refreshing || productsError) ? (
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

      {activeTab === 'inventory' && (
        <View style={styles.kpiContainer}>
          <View style={styles.inventorySummary}>
            <View style={styles.valuationHeaderRow}>
              <TouchableOpacity
                style={styles.valuationToggleBtn}
                onPress={() => setValuationExpanded((prev) => !prev)}
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
                  onPress={handleOpenNewProduct}
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
                      {catalogComplete ? formatPEN(kpis.valuation) : 'Sincronizando…'}
                    </Text>
                  </View>
                )}
                <View style={styles.inventoryCounts}>
                  <TouchableOpacity
                    style={[
                      styles.kpiFilterPill,
                      statusFilter === 'all' && styles.kpiFilterPillActive,
                    ]}
                    onPress={() => {
                      setStatusFilter('all');
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      catalogComplete
                        ? `Todos los productos (${kpis.totalSkus})`
                        : 'Sincronizando catálogo'
                    }
                    disabled={!catalogComplete}
                  >
                    <Text
                      style={[
                        styles.inventoryCount,
                        statusFilter === 'all' && styles.kpiCountTextActive,
                      ]}
                    >
                      <Text style={styles.inventoryCountValue}>
                        {catalogComplete ? kpis.totalSkus : '…'}
                      </Text>{' '}
                      productos
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.kpiFilterPill,
                      statusFilter === 'low' && styles.kpiFilterPillActiveWarning,
                    ]}
                    onPress={() => {
                      setStatusFilter((prev) => (prev === 'low' ? 'all' : 'low'));
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      catalogComplete
                        ? `Stock bajo (${kpis.lowStockCount})`
                        : 'Sincronizando catálogo'
                    }
                    disabled={!catalogComplete}
                  >
                    <Text
                      style={[
                        styles.inventoryCount,
                        styles.kpiWarning,
                        statusFilter === 'low' && styles.kpiCountTextActiveWarning,
                      ]}
                    >
                      <Text style={styles.inventoryCountValue}>
                        {catalogComplete ? kpis.lowStockCount : '…'}
                      </Text>{' '}
                      stock bajo
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.kpiFilterPill,
                      statusFilter === 'out' && styles.kpiFilterPillActiveDanger,
                    ]}
                    onPress={() => {
                      setStatusFilter((prev) => (prev === 'out' ? 'all' : 'out'));
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      catalogComplete
                        ? `Agotados (${kpis.outOfStockCount})`
                        : 'Sincronizando catálogo'
                    }
                    disabled={!catalogComplete}
                  >
                    <Text
                      style={[
                        styles.inventoryCount,
                        styles.kpiDanger,
                        statusFilter === 'out' && styles.kpiCountTextActiveDanger,
                      ]}
                    >
                      <Text style={styles.inventoryCountValue}>
                        {catalogComplete ? kpis.outOfStockCount : '…'}
                      </Text>{' '}
                      agotados
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      )}

      {/* PESTAÑA 1: INVENTARIO */}
      {activeTab === 'inventory' ? (
        <View style={{ flex: 1 }}>
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
                  onPress={() => setSearchQuery('')}
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
                {catalogComplete ? filteredProducts.length : '…'}
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

          <View style={{ flex: 1, marginTop: 4 }}>
            {productsLoading ? (
              <View style={styles.centerLoading}>
                <ActivityIndicator size="large" color={ui.primary} />
                <Text style={styles.centerLoadingText}>Cargando inventario...</Text>
              </View>
            ) : filteredProducts.length === 0 ? (
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
                  <View style={{ gap: 8, alignItems: 'center' }}>
                    {searchQuery.trim().length >= 2 ? (
                      <TouchableOpacity
                        style={[
                          styles.emptyActionBtn,
                          { backgroundColor: ui.primarySoft, borderColor: ui.primary },
                        ]}
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
                        <Text style={[styles.emptyActionText, { color: ui.primary }]}>
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
            ) : (
              <FlashList
                data={filteredProducts}
                estimatedItemSize={canManageProducts || canManageInventoryAdjustments ? 185 : 132}
                keyExtractor={catalogKeyExtractor}
                getItemType={getCatalogItemType}
                contentContainerStyle={styles.catalogListContent}
                renderItem={renderCatalogItem}
              />
            )}
          </View>
        </View>
      ) : null}

      {/* PESTAÑA 2: KARDEX (MOVIMIENTOS) */}
      {activeTab === 'kardex' ? (
        <View style={{ flex: 1, paddingHorizontal: 14 }}>
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
                onChangeText={(txt) => {
                  setKardexSearch(txt);
                  if (!txt.trim() && kardexSelectedProductId) {
                    setKardexSelectedProductId(null);
                    void loadKardex(null, true);
                  }
                }}
                placeholder="Filtrar Kardex por producto o SKU..."
                placeholderTextColor={ui.textMuted}
                autoCapitalize="none"
              />
              {kardexSearch || kardexSelectedProductId ? (
                <TouchableOpacity
                  onPress={() => {
                    setKardexSearch('');
                    setKardexSelectedProductId(null);
                    void loadKardex(null, true);
                  }}
                  hitSlop={6}
                >
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
              keyExtractor={kardexKeyExtractor}
              getItemType={getKardexItemType}
              contentContainerStyle={styles.listPaddingBottom}
              renderItem={renderKardexItem}
              refreshing={kardexLoading && kardexList.length > 0}
              onRefresh={handleRefreshKardexPress}
            />
          )}
        </View>
      ) : null}

      {/* PESTAÑA 3: TRANSFERENCIAS ENTRE SUCURSALES */}
      {activeTab === 'transfers' ? (
        <View style={{ flex: 1, paddingHorizontal: 14 }}>
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
      ) : null}

      {/* MODAL 1: AJUSTE RÁPIDO DE STOCK (AISLADO) */}
      {stockModalOpen && (
        <QuickStockAdjustModal
          visible={stockModalOpen}
          product={adjustingProduct}
          onClose={handleCloseStockModal}
          onStockAdjusted={handleStockAdjusted}
        />
      )}

      {/* MODAL 2: NUEVA TRANSFERENCIA MULTI-ÍTEM (AISLADO) */}
      {newTransferModalOpen && (
        <NewTransferModal
          visible={newTransferModalOpen}
          onClose={handleCloseNewTransferModal}
          onTransferCreated={handleTransferCreated}
        />
      )}

      {/* MODAL 3: CREAR / EDITAR PRODUCTO */}
      {productModalOpen && (
        <ProductFormModal
          visible={productModalOpen}
          product={editingProduct}
          onClose={handleCloseProductModal}
          onSave={handleSaveProduct}
          branchId={branchId}
        />
      )}

      {/* MODAL 4: PROVEEDORES Y ÓRDENES DE COMPRA */}
      {suppliersModalOpen && (
        <SuppliersPurchaseModal
          visible={suppliersModalOpen}
          onClose={handleCloseSuppliersModal}
        />
      )}

      {/* MODAL 5: ESCÁNER DE CÓDIGO DE BARRAS EN INVENTARIO */}
      {catalogScannerOpen && (
        <BarcodeScannerModal
          visible={catalogScannerOpen}
          onClose={handleCloseCatalogScanner}
          onScan={handleCatalogScan}
          title="Escanear en Inventario"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
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
    minHeight: 42,
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
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
    fontSize: 11.5,
    fontWeight: '600',
    color: ui.textSecondary,
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
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
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
  catalogListContent: {
    paddingHorizontal: 14,
    paddingBottom: 30,
  },
  listPaddingBottom: {
    paddingBottom: 30,
  },
  productThumbnail: {
    width: 48,
    height: 48,
    borderRadius: 14,
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
