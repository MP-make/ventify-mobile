import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  Package,
  Plus,
  Search,
  Zap,
  Check,
  X,
  Shuffle,
  Edit3,
  ArrowRightLeft,
  History,
  TrendingUp,
  AlertTriangle,
  Minus,
  RefreshCw,
  SlidersHorizontal,
  Layers,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  ShoppingCart,
  Percent,
  Truck,
  Barcode,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { useProducts } from '@/context/ProductsContext';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useCart } from '@/context/CartContext';
import { usePermissions } from '@/hooks/usePermissions';
import { formatPEN, formatDatePE } from '@/lib/theme';
import { ui } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import {
  adjustProductStock,
  getProductKardex,
  getStockTransfers,
  createStockTransfer,
  saveProduct,
  StockTransfer,
} from '@/services/inventory-kardex-service';
import { ProductFormModal, ProductFormData } from '@/components/ProductFormModal';
import { collection, query, where, getDocs, limit as fsLimit } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { SuppliersPurchaseModal } from '@/components/SuppliersPurchaseModal';
import { InlineFilterBar } from '@/components/InlineFilterBar';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import {
  catalogBrand,
  catalogSizes,
  DEFAULT_CATALOG_BRANDS,
  DEFAULT_CATALOG_SIZES,
  mergeCatalogOptions,
  normalizeCatalogLabel,
} from '@/lib/catalog-filters';
import type { Product } from '@/types';

type ActiveTab = 'inventory' | 'kardex' | 'transfers';
type StockStatusFilter = 'all' | 'low' | 'out';

const KARDEX_REASONS = [
  'Ingreso de mercadería',
  'Ajuste de inventario',
  'Merma / Deterioro',
  'Consumo interno',
];

export default function CatalogInventoryScreen() {
  const { accountId, branchId, user, userProfile } = useAuth();
  const {
    canManageProducts,
    canManageInventoryAdjustments,
    canViewMargins,
    canRequestTransfer,
    hasPermission,
  } = usePermissions();
  const {
    products,
    categories,
    loading: productsLoading,
    refreshProducts,
    getProductStock,
    upsertProduct,
  } = useProducts();
  const { branches, activeBranchName, posSettings } = useSettings();
  const { addItem } = useCart();

  const enableCatalogFilters = !!posSettings?.enableCatalogFilters;

  // Sub-pestaña activa
  const [activeTab, setActiveTab] = useState<ActiveTab>('inventory');
  const [suppliersModalOpen, setSuppliersModalOpen] = useState(false);

  // Filtros de Inventario
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StockStatusFilter>('all');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [selectedBrand, setSelectedBrand] = useState('Todas');
  const [selectedSize, setSelectedSize] = useState('Todas');

  // Marcas únicas del catálogo (incluye atributos y marcas predeterminadas como en la web)
  const availableBrands = useMemo(() => {
    const extracted = products.map(catalogBrand).filter(Boolean);
    return ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_BRANDS, extracted)];
  }, [products]);

  // Tallas / Medidas únicas del catálogo
  const availableSizes = useMemo(() => {
    const extracted = products.flatMap(catalogSizes).filter(Boolean);
    return ['Todas', ...mergeCatalogOptions(DEFAULT_CATALOG_SIZES, extracted)];
  }, [products]);

  // Conteo de categorías
  const categoryListWithCounts = useMemo(() => {
    const rawCategories = ['Todas', ...categories.filter((c) => c !== 'Todas' && c !== 'Todos')];
    return rawCategories.map((cat) => {
      const count =
        cat === 'Todas'
          ? products.length
          : cat === 'Sin Categoría'
          ? products.filter((p) => !p.category).length
          : products.filter((p) => p.category === cat).length;
      return { name: cat, count };
    });
  }, [categories, products]);

  // Modal de Producto (Crear / Editar)
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isCloudSearching, setIsCloudSearching] = useState(false);

  const handleCloudSearch = async () => {
    if (!accountId || !searchQuery.trim() || isCloudSearching) return;
    setIsCloudSearching(true);
    try {
      const qText = searchQuery.trim();
      const coll = collection(db, 'products');

      const snapBarcode = await getDocs(
        query(coll, where('accountId', '==', accountId), where('barcode', '==', qText), fsLimit(10))
      );

      const snapName = await getDocs(
        query(
          coll,
          where('accountId', '==', accountId),
          where('name', '>=', qText),
          where('name', '<=', qText + '\uf8ff'),
          fsLimit(20)
        )
      );

      const docMap = new Map<string, any>();
      snapBarcode.docs.forEach((d) => docMap.set(d.id, d));
      snapName.docs.forEach((d) => docMap.set(d.id, d));

      if (docMap.size > 0) {
        docMap.forEach((d) => {
          const data = d.data();
          upsertProduct({
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Alert.alert('Búsqueda en la Nube', `No se encontraron productos coincidentes con "${qText}".`);
      }
    } catch (err: any) {
      console.warn('[Catalog] Cloud search warning:', err?.message);
      Alert.alert('Aviso de Búsqueda', 'No se pudieron recuperar más resultados de la nube.');
    } finally {
      setIsCloudSearching(false);
    }
  };

  // Modal de Ajuste Rápido de Stock
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null);
  const [adjustMode, setAdjustMode] = useState<'add' | 'subtract' | 'set'>('add');
  const [adjustAmountStr, setAdjustAmountStr] = useState('');
  const [adjustReason, setAdjustReason] = useState(KARDEX_REASONS[0]);
  const [adjustNotes, setAdjustNotes] = useState('');
  const [isAdjustingStock, setIsAdjustingStock] = useState(false);

  // Sub-pestaña Kardex
  const [kardexList, setKardexList] = useState<any[]>([]);
  const [kardexLoading, setKardexLoading] = useState(false);
  const [kardexSearch, setKardexSearch] = useState('');

  // Sub-pestaña Transferencias
  const [transfersList, setTransfersList] = useState<StockTransfer[]>([]);
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [newTransferModalOpen, setNewTransferModalOpen] = useState(false);
  const [destinationBranchId, setDestinationBranchId] = useState('');
  const [transferProductId, setTransferProductId] = useState('');
  const [transferQtyStr, setTransferQtyStr] = useState('');
  const [transferNotes, setTransferNotes] = useState('');
  const [isCreatingTransfer, setIsCreatingTransfer] = useState(false);

  // Escáner de código de barras en inventario
  const [catalogScannerOpen, setCatalogScannerOpen] = useState(false);

  // Búsqueda y escáner en modal de transferencias
  const [transferSearchText, setTransferSearchText] = useState('');
  const [transferScannerOpen, setTransferScannerOpen] = useState(false);

  const filteredTransferProducts = useMemo(() => {
    const q = transferSearchText.trim().toLowerCase();
    if (!q) return products.slice(0, 30);
    return products
      .filter((p) => {
        const name = (p.name || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        const barcode = (p.barcode || '').toLowerCase();
        return (
          name.includes(q) ||
          sku.includes(q) ||
          barcode === q ||
          barcode.includes(q)
        );
      })
      .slice(0, 30);
  }, [products, transferSearchText]);

  const handleTransferBarcodeScanned = (code: string) => {
    setTransferScannerOpen(false);
    const clean = code.trim();
    if (!clean) return;
    const found = products.find(
      (p) =>
        p.barcode === clean ||
        p.sku?.toLowerCase() === clean.toLowerCase() ||
        (Array.isArray((p as any).barcodes) && (p as any).barcodes.includes(clean))
    );
    if (found) {
      setTransferProductId(found.id);
      setTransferSearchText(found.name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setTransferSearchText(clean);
      Alert.alert('No encontrado', `No se encontró un producto con código "${clean}".`);
    }
  };

  // Cálculo de Métricas KPI Superiores
  const kpis = useMemo(() => {
    let totalValuation = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    for (const p of products) {
      const stock = getProductStock(p);
      const minStock = (p as any).minStock || 3;
      const cost = p.costPrice || 0;

      totalValuation += Math.max(0, stock) * cost;

      if (stock <= 0) {
        outOfStockCount++;
      } else if (stock <= minStock) {
        lowStockCount++;
      }
    }

    return {
      totalSkus: products.length,
      valuation: totalValuation,
      lowStockCount,
      outOfStockCount,
    };
  }, [products, getProductStock]);

  // Filtrado de Inventario
  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      const stock = getProductStock(p);
      const minStock = (p as any).minStock || 3;

      if (statusFilter === 'low' && (stock <= 0 || stock > minStock)) return false;
      if (statusFilter === 'out' && stock > 0) return false;

      const matchCat =
        selectedCategory === 'Todas' ||
        (selectedCategory === 'Sin Categoría' ? !p.category : p.category === selectedCategory);
      if (!matchCat) return false;

      if (selectedBrand !== 'Todas') {
        const pBrand = normalizeCatalogLabel(catalogBrand(p));
        if (pBrand !== normalizeCatalogLabel(selectedBrand)) {
          return false;
        }
      }

      if (selectedSize !== 'Todas') {
        const pSizes = catalogSizes(p).map(normalizeCatalogLabel);
        if (!pSizes.includes(normalizeCatalogLabel(selectedSize))) {
          return false;
        }
      }

      if (!q) return true;
      const nameMatch = p.name?.toLowerCase().includes(q);
      const skuMatch = p.sku?.toLowerCase().includes(q);
      const barcodeMatch = p.barcode?.toLowerCase().includes(q);
      const extraBarcodeMatch =
        Array.isArray((p as any).barcodes) &&
        (p as any).barcodes.some((b: string) => String(b).toLowerCase().includes(q));
      const brandMatch = p.brand?.toLowerCase().includes(q);
      const sizeMatch = p.sizeLabel?.toLowerCase().includes(q);
      return nameMatch || skuMatch || barcodeMatch || extraBarcodeMatch || brandMatch || sizeMatch;
    });
  }, [
    products,
    searchQuery,
    statusFilter,
    selectedCategory,
    selectedBrand,
    selectedSize,
    enableCatalogFilters,
    getProductStock,
  ]);

  // Carga de Kardex
  const loadKardex = useCallback(async () => {
    if (!accountId || !branchId) return;
    try {
      setKardexLoading(true);
      const data = await getProductKardex(accountId, branchId, undefined, 60);
      setKardexList(data || []);
    } catch (err) {
      console.error('[Catalog] Error cargando Kardex:', err);
    } finally {
      setKardexLoading(false);
    }
  }, [accountId, branchId]);

  // Carga de Transferencias
  const loadTransfers = useCallback(async () => {
    if (!accountId) return;
    try {
      setTransfersLoading(true);
      const data = await getStockTransfers(accountId, branchId);
      setTransfersList(data || []);
    } catch (err) {
      console.error('[Catalog] Error cargando transferencias:', err);
    } finally {
      setTransfersLoading(false);
    }
  }, [accountId, branchId]);

  useEffect(() => {
    if (activeTab === 'kardex') {
      loadKardex();
    } else if (activeTab === 'transfers') {
      loadTransfers();
    }
  }, [activeTab, loadKardex, loadTransfers]);

  // Abrir Modal de Ajuste de Stock
  const openStockModal = (product: Product) => {
    setAdjustingProduct(product);
    setAdjustMode('add');
    setAdjustAmountStr('');
    setAdjustReason(KARDEX_REASONS[0]);
    setAdjustNotes('');
    setStockModalOpen(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Confirmar Ajuste de Stock
  const handleConfirmStockAdjustment = async () => {
    if (!canManageInventoryAdjustments) {
      Alert.alert('Acceso Denegado', 'No cuentas con permisos para realizar ajustes manuales de stock.');
      return;
    }
    if (!adjustingProduct || !accountId || !branchId) return;

    const amount = parseFloat(adjustAmountStr);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Cantidad Inválida', 'Por favor ingresa una cantidad mayor a cero.');
      return;
    }

    const currentStock = getProductStock(adjustingProduct);
    let targetStock = currentStock;

    if (adjustMode === 'add') {
      targetStock = currentStock + amount;
    } else if (adjustMode === 'subtract') {
      targetStock = Math.max(0, currentStock - amount);
    } else {
      targetStock = amount;
    }

    try {
      setIsAdjustingStock(true);
      await adjustProductStock({
        product: adjustingProduct,
        branchId,
        branchName: activeBranchName || 'Sucursal Principal',
        newStock: targetStock,
        reason: adjustReason,
        notes: adjustNotes.trim(),
        userProfile: {
          uid: user?.uid || 'user_pos',
          displayName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero',
          email: user?.email || '',
        },
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Stock Actualizado', `${adjustingProduct.name}: ${currentStock} ➔ ${targetStock} unidades.`);
      setStockModalOpen(false);
      refreshProducts();
    } catch (err: any) {
      Alert.alert('Error al Ajustar', err?.message || 'No se pudo registrar el ajuste de stock.');
    } finally {
      setIsAdjustingStock(false);
    }
  };

  // Guardar Producto (Nuevo o Editado)
  const handleSaveProduct = async (formData: ProductFormData) => {
    if (!canManageProducts) {
      Alert.alert('Acceso Denegado', 'No cuentas con permisos para crear o modificar productos.');
      return;
    }
    if (!accountId) return;

    const stockMap: Record<string, number> = { ...(editingProduct?.stock || {}) };
    if (formData.stockByBranch && Object.keys(formData.stockByBranch).length > 0) {
      Object.assign(stockMap, formData.stockByBranch);
    } else {
      stockMap[branchId] = formData.stock;
    }

    const productPayload = {
      id: formData.id,
      name: formData.name,
      category: formData.category,
      barcode: formData.barcode,
      barcodes: formData.barcodes || [],
      sku: formData.sku,
      brand: formData.brand,
      sizeLabel: formData.sizeLabel,
      sizes: formData.sizeLabel ? [formData.sizeLabel] : [],
      unitOfMeasure: formData.unitOfMeasure as any,
      price: formData.price,
      suggestedPrice: formData.price,
      minSalePrice: formData.minSalePrice,
      costPrice: formData.cost,
      stock: stockMap,
      minStock: formData.minStock,
      presentations: formData.presentations as any,
      imageUrl: formData.imageUrl || (editingProduct as any)?.imageUrl,
      accountId,
    };

    const savedId = await saveProduct(
      productPayload,
      !formData.id,
      {
        uid: user?.uid || 'user_pos',
        displayName: userProfile?.displayName || user?.displayName || user?.email || 'Administrador',
        email: user?.email || '',
      }
    );

    const fullProduct: Product = {
      id: savedId || formData.id || `prod_${Date.now()}`,
      name: formData.name,
      category: formData.category,
      barcode: formData.barcode,
      barcodes: formData.barcodes || [],
      sku: formData.sku,
      brand: formData.brand,
      sizeLabel: formData.sizeLabel,
      sizes: formData.sizeLabel ? [formData.sizeLabel] : [],
      unitOfMeasure: formData.unitOfMeasure as any,
      price: formData.price,
      suggestedPrice: formData.price,
      minSalePrice: formData.minSalePrice,
      costPrice: formData.cost,
      stock: stockMap,
      minStock: formData.minStock,
      presentations: formData.presentations as any,
      imageUrl: formData.imageUrl || (editingProduct as any)?.imageUrl,
      accountId,
      active: true,
      branchIds: Object.keys(stockMap),
    };

    upsertProduct(fullProduct);
    refreshProducts();
    setSearchQuery(formData.name);
  };

  // Confirmar Nueva Transferencia entre Sucursales
  const handleCreateTransfer = async () => {
    if (!canRequestTransfer) {
      Alert.alert('Acceso Denegado', 'No cuentas con permiso para solicitar o realizar transferencias.');
      return;
    }

    if (!accountId || !branchId || !destinationBranchId || !transferProductId) {
      Alert.alert('Campos Incompletos', 'Selecciona la sucursal de destino y el producto a transferir.');
      return;
    }

    const qty = parseFloat(transferQtyStr);
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Cantidad Inválida', 'Ingresa una cantidad mayor a cero.');
      return;
    }

    const selectedProd = products.find((p) => p.id === transferProductId);
    if (!selectedProd) return;

    const currentOriginStock = getProductStock(selectedProd);
    if (qty > currentOriginStock) {
      Alert.alert(
        'Stock Insuficiente',
        `No puedes transferir más de las unidades disponibles en esta sucursal (${currentOriginStock} uds).`
      );
      return;
    }

    const destBranch = branches.find((b) => b.id === destinationBranchId);

    try {
      setIsCreatingTransfer(true);
      await createStockTransfer({
        accountId,
        fromBranchId: branchId,
        fromBranchName: activeBranchName || 'Sucursal Origen',
        toBranchId: destinationBranchId,
        toBranchName: destBranch?.name || 'Sucursal Destino',
        items: [
          {
            productId: selectedProd.id,
            productName: selectedProd.name,
            sku: selectedProd.sku,
            quantity: qty,
          },
        ],
        notes: transferNotes.trim(),
        userProfile: {
          uid: user?.uid || 'user_pos',
          displayName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero',
          email: user?.email || '',
        },
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Transferencia Exitosa', `Se transfirieron ${qty} unidades hacia ${destBranch?.name || 'destino'}.`);
      setNewTransferModalOpen(false);
      setTransferProductId('');
      setTransferQtyStr('');
      setTransferNotes('');
      refreshProducts();
      loadTransfers();
    } catch (err: any) {
      Alert.alert('Error en Transferencia', err?.message || 'No se pudo registrar la transferencia.');
    } finally {
      setIsCreatingTransfer(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.compactHeaderRow}>
        <Text style={styles.compactHeaderTitle}>
          {activeTab === 'inventory' ? 'Inventario' : activeTab === 'kardex' ? 'Movimientos' : 'Transferencias'}
        </Text>
        {activeTab === 'inventory' && canManageProducts ? (
          <TouchableOpacity
            style={styles.compactHeaderAction}
            onPress={() => { setEditingProduct(null); setProductModalOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel="Crear producto"
          >
            <Plus size={15} color={ui.onPrimary} />
            <Text style={styles.compactHeaderActionText}>Nuevo producto</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {activeTab === 'inventory' && (
        <View style={styles.kpiContainer}>
          <View style={styles.inventorySummary}>
            {canViewMargins && (
              <View style={styles.valuationRow}>
                <Text style={styles.valuationLabel}>Valor del inventario</Text>
                <Text style={styles.valuationAmount}>{formatPEN(kpis.valuation)}</Text>
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
                accessibilityLabel={`Todos los productos (${kpis.totalSkus})`}
              >
                <Text style={[styles.inventoryCount, statusFilter === 'all' && styles.kpiCountTextActive]}>
                  <Text style={styles.inventoryCountValue}>{kpis.totalSkus}</Text> productos
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
                accessibilityLabel={`Stock bajo (${kpis.lowStockCount})`}
              >
                <Text style={[styles.inventoryCount, styles.kpiWarning, statusFilter === 'low' && styles.kpiCountTextActiveWarning]}>
                  <Text style={styles.inventoryCountValue}>{kpis.lowStockCount}</Text> stock bajo
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
                accessibilityLabel={`Agotados (${kpis.outOfStockCount})`}
              >
                <Text style={[styles.inventoryCount, styles.kpiDanger, statusFilter === 'out' && styles.kpiCountTextActiveDanger]}>
                  <Text style={styles.inventoryCountValue}>{kpis.outOfStockCount}</Text> agotados
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* 2. SELECTOR DE 4 SUB-PESTAÑAS EN UNA SOLA FILA */}
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
            <Package size={14} color={activeTab === 'inventory' ? ui.primary : ui.textSecondary} />
            <Text
              style={[
                styles.tabBtnText,
                activeTab === 'inventory' && styles.tabBtnTextActive,
              ]}
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
            <History size={14} color={activeTab === 'kardex' ? ui.primary : ui.textSecondary} />
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
            <ArrowRightLeft size={14} color={activeTab === 'transfers' ? ui.primary : ui.textSecondary} />
            <Text
              style={[
                styles.tabBtnText,
                activeTab === 'transfers' && styles.tabBtnTextActive,
              ]}
              numberOfLines={1}
            >
              Transferencias
            </Text>
          </TouchableOpacity>

          {(canManageInventoryAdjustments || hasPermission('access_suppliers')) && (
            <TouchableOpacity
              style={styles.tabBtn}
              onPress={() => setSuppliersModalOpen(true)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Abrir compras a proveedores"
            >
              <Truck size={14} color={ui.primary} />
              <Text style={[styles.tabBtnText, { color: ui.primary }]} numberOfLines={1}>
                Compras
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ========================================================================= */}
      {/* CONTENIDO SEGÚN SUB-PESTAÑA                                               */}
      {/* ========================================================================= */}

      {/* PESTAÑA 1: INVENTARIO */}
      {activeTab === 'inventory' ? (
        <View style={{ flex: 1 }}>
          {/* Buscador y Botón Escáner de Código de Barras */}
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

            <TouchableOpacity
              style={styles.inventoryScanBtn}
              onPress={() => setCatalogScannerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Escanear código de barras en inventario"
              activeOpacity={0.7}
            >
              <Barcode size={20} color={ui.primary} />
            </TouchableOpacity>
          </View>

          {/* Selectores de Categoría, Marca y Medida (Inline con buscador sin scroll horizontal) */}
          <InlineFilterBar
            groups={[
              {
                id: 'category',
                label: 'Categorías',
                selectedValue: selectedCategory,
                options: categoryListWithCounts,
                onSelect: (cat) => setSelectedCategory(cat),
                onClear: () => setSelectedCategory('Todas'),
                icon: 'category',
              },
              {
                id: 'brand',
                label: 'Marcas',
                selectedValue: selectedBrand,
                options: availableBrands.map((b) => ({ name: b })),
                onSelect: (b: string) => setSelectedBrand(b),
                onClear: () => setSelectedBrand('Todas'),
                icon: 'brand' as const,
              },
              {
                id: 'size',
                label: 'Medidas',
                selectedValue: selectedSize,
                options: availableSizes.map((s) => ({ name: s })),
                onSelect: (s: string) => setSelectedSize(s),
                onClear: () => setSelectedSize('Todas'),
                icon: 'size' as const,
              },
            ]}
          />

          {/* Lista de Productos con FlashList */}
          <View style={{ flex: 1, marginTop: 8 }}>
            {!productsLoading && filteredProducts.length > 0 && (
              <View style={styles.listSectionHeading}>
                <SectionHeading title="Productos" subtitle={`${filteredProducts.length} en este catálogo`} />
              </View>
            )}
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
                      onPress={() => {
                        setEditingProduct(null);
                        setProductModalOpen(true);
                      }}
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
                        style={[styles.emptyActionBtn, { backgroundColor: ui.primarySoft, borderColor: ui.primary }]}
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
                          {isCloudSearching ? 'Consultando nube...' : 'Buscar en toda la base de datos'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}

                    <TouchableOpacity
                      style={styles.emptyActionBtn}
                      onPress={() => {
                        setSearchQuery('');
                        setStatusFilter('all');
                        setSelectedCategory('Todas');
                      }}
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
                estimatedItemSize={92}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 30 }}
                renderItem={({ item }) => {
                  const stock = getProductStock(item);
                  const minStock = (item as any).minStock || 3;
                  const isOut = stock <= 0;
                  const isLow = stock > 0 && stock <= minStock;

                  const price = Number(item.suggestedPrice ?? item.price ?? 0);
                  const cost = Number(item.costPrice ?? 0);
                  const marginPct = cost > 0 ? ((price - cost) / cost) * 100 : 100;

                  return (
                    <View style={styles.inventoryCard}>
                      <View style={styles.inventoryCardHeader}>
                        <View style={styles.productMark}>
                          <Package size={19} color={ui.primary} />
                        </View>
                        <View style={styles.productIdentity}>
                          <Text style={styles.inventoryCardName} numberOfLines={2}>{item.name}</Text>
                          <View style={styles.productMetaRow}>
                            <Text style={styles.productCategory} numberOfLines={1}>{item.category || 'General'}</Text>
                            <Text style={styles.metaSeparator}>·</Text>
                            <Text style={styles.inventoryCardSku} numberOfLines={1}>{item.sku || item.barcode || 'Sin SKU'}</Text>
                          </View>
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
                              <Text style={[styles.metricValue, marginPct < 15 ? styles.kpiWarning : styles.kpiSuccess]}>{marginPct.toFixed(0)}%</Text>
                            </View>
                          </View>
                        )}
                      </View>

                      {(canManageProducts || canManageInventoryAdjustments) && (
                        <View style={styles.inventoryActionsRow}>
                          {canManageProducts && (
                            <TouchableOpacity
                              style={styles.actionBtnEdit}
                              onPress={() => {
                                setEditingProduct(item);
                                setProductModalOpen(true);
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                              }}
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
                              onPress={() => openStockModal(item)}
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
                }}
              />
            )}
          </View>
        </View>
      ) : null}

      {/* PESTAÑA 2: KARDEX (MOVIMIENTOS) */}
      {activeTab === 'kardex' ? (
        <View style={{ flex: 1, paddingHorizontal: 14 }}>
          <View style={styles.kardexHeaderBar}>
            <SectionHeading title="Movimientos de la sucursal" subtitle="Historial de entradas, ventas y ajustes" />
            <TouchableOpacity style={styles.refreshBtn} onPress={loadKardex}>
              <RefreshCw size={15} color={ui.primary} />
              <Text style={styles.refreshBtnText}>Actualizar</Text>
            </TouchableOpacity>
          </View>

          {kardexLoading ? (
            <View style={styles.centerLoading}>
              <ActivityIndicator size="large" color={ui.primary} />
              <Text style={styles.centerLoadingText}>Consultando movimientos de stock...</Text>
            </View>
          ) : kardexList.length === 0 ? (
            <View style={styles.emptyView}>
              <History size={40} color={ui.border} />
              <Text style={styles.emptyViewTitle}>Sin movimientos registrados</Text>
              <Text style={styles.emptyViewSubtitle}>
                Los ingresos, ventas y transferencias aparecerán aquí en vivo.
              </Text>
            </View>
          ) : (
            <FlashList
              data={kardexList}
              estimatedItemSize={88}
              keyExtractor={(item, index) => item.id || `kardex_${index}`}
              contentContainerStyle={{ paddingBottom: 30 }}
              renderItem={({ item }) => {
                const rawQty = item.quantityChanged !== undefined
                  ? Number(item.quantityChanged)
                  : (item.quantity !== undefined ? Number(item.quantity) : 0);
                const qty = isNaN(rawQty) ? 0 : rawQty;

                const mType = String(item.movementType || item.type || '').toLowerCase();
                const isSale = mType === 'sale';
                const isIncoming = qty > 0 || mType === 'add' || mType === 'return' || mType === 'in';
                const isOutgoing = qty < 0 || isSale || mType === 'refund' || mType === 'out';
                const isTransfer = mType === 'transfer' || mType === 'in_transit';

                const qtyBadgeText = qty > 0 ? `+${qty}` : qty < 0 ? `${qty}` : (isOutgoing ? `-${Math.abs(item.quantity || 1)}` : (isIncoming ? `+${Math.abs(item.quantity || 1)}` : `0`));

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
                          : (prevStock !== undefined ? `${prevStock} uds` : (postStock !== undefined ? `${postStock} uds` : `${Math.abs(qty)} uds`))}
                      </Text>
                    </View>
                  </View>
                );
              }}
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
                    onPress={() => {
                      setNewTransferModalOpen(true);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
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

          {transfersLoading ? (
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
              estimatedItemSize={96}
              keyExtractor={(item) => item.id || `trf_${item.transferNumber}`}
              contentContainerStyle={{ paddingBottom: 30 }}
              renderItem={({ item }) => {
                const totalUnits = (item.items || []).reduce(
                  (acc, it) => acc + (it.quantity || 0),
                  0
                );

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

                    <View style={styles.transferDetailsRow}>
                      <Text style={styles.transferDetailsText}>
                        {totalUnits} unidades transferidas
                      </Text>
                      <Text style={styles.transferDateText}>
                        {formatDatePE(item.sentAt || item.requestedAt)}
                      </Text>
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      ) : null}

      {/* MODAL 1: AJUSTE RÁPIDO DE STOCK */}
      <Modal
        visible={stockModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setStockModalOpen(false)}
      >
        <View style={styles.subModalOverlay}>
          <View style={styles.subModalCard}>
            <View style={styles.subModalHeader}>
              <View>
                <Text style={styles.subModalTitle}>Ajuste Rápido de Stock</Text>
                <Text style={styles.subModalSubtitle} numberOfLines={1}>
                  {adjustingProduct?.name}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setStockModalOpen(false)}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Selector de Modo: Sumar / Restar / Fijar */}
            <View style={styles.adjustModeRow}>
              {[
                { id: 'add', label: 'Sumar (+)' },
                { id: 'subtract', label: 'Restar (-)' },
                { id: 'set', label: 'Fijar (=)' },
              ].map((m) => (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.adjustModeBtn, adjustMode === m.id && styles.adjustModeBtnActive]}
                  onPress={() => setAdjustMode(m.id as any)}
                >
                  <Text
                    style={[
                      styles.adjustModeBtnText,
                      adjustMode === m.id && styles.adjustModeBtnTextActive,
                    ]}
                  >
                    {m.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>Cantidad de Unidades</Text>
            <TextInput
              style={[styles.formInput, styles.quickAmountHighlight]}
              value={adjustAmountStr}
              onChangeText={setAdjustAmountStr}
              placeholder="0"
              keyboardType="numeric"
              autoFocus
            />

            <Text style={styles.inputLabel}>Motivo Obligatorio Kardex</Text>
            <View style={styles.reasonsGrid}>
              {KARDEX_REASONS.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.reasonChip, adjustReason === r && styles.reasonChipActive]}
                  onPress={() => setAdjustReason(r)}
                >
                  <Text
                    style={[
                      styles.reasonChipText,
                      adjustReason === r && styles.reasonChipTextActive,
                    ]}
                  >
                    {r}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>Observación (Opcional)</Text>
            <TextInput
              style={styles.formInput}
              value={adjustNotes}
              onChangeText={setAdjustNotes}
              placeholder="Ej. Factura de proveedor F001-209"
              placeholderTextColor={ui.textMuted}
            />

            <View style={styles.subModalActions}>
              <TouchableOpacity
                style={styles.subModalCancelBtn}
                onPress={() => setStockModalOpen(false)}
                disabled={isAdjustingStock}
              >
                <Text style={styles.subModalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.subModalConfirmBtn, isAdjustingStock && { opacity: 0.6 }]}
                onPress={handleConfirmStockAdjustment}
                disabled={isAdjustingStock}
              >
                {isAdjustingStock ? (
                  <ActivityIndicator size="small" color={ui.surface} />
                ) : (
                  <>
                    <Check size={16} color={ui.surface} />
                    <Text style={styles.subModalConfirmText}>Aplicar Ajuste</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* MODAL 2: NUEVA TRANSFERENCIA */}
      <Modal
        visible={newTransferModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setNewTransferModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.subModalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.subModalCard}>
            <View style={styles.subModalHeader}>
              <Text style={styles.subModalTitle}>Nueva Transferencia</Text>
              <TouchableOpacity onPress={() => setNewTransferModalOpen(false)}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Sucursal de Destino</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {branches
                .filter((b) => b.id !== branchId)
                .map((b) => (
                  <TouchableOpacity
                    key={b.id}
                    style={[
                      styles.branchPickChip,
                      destinationBranchId === b.id && styles.branchPickChipActive,
                    ]}
                    onPress={() => setDestinationBranchId(b.id || '')}
                  >
                    <Building2 size={14} color={destinationBranchId === b.id ? ui.surface : ui.textSecondary} />
                    <Text
                      style={[
                        styles.branchPickChipText,
                        destinationBranchId === b.id && styles.branchPickChipTextActive,
                      ]}
                    >
                      {b.name}
                    </Text>
                  </TouchableOpacity>
                ))}
            </ScrollView>

            <Text style={styles.inputLabel}>Producto a Transferir</Text>

            {/* Buscador + Escáner de código de barras para transferencias */}
            <View style={styles.transferSearchRow}>
              <View style={styles.transferSearchBar}>
                <Search size={15} color={ui.textSecondary} style={{ marginRight: 6 }} />
                <TextInput
                  style={styles.transferSearchInput}
                  value={transferSearchText}
                  onChangeText={setTransferSearchText}
                  placeholder="Buscar producto, SKU o código..."
                  placeholderTextColor={ui.textMuted}
                  autoCapitalize="none"
                />
                {transferSearchText ? (
                  <TouchableOpacity onPress={() => setTransferSearchText('')} hitSlop={6}>
                    <X size={14} color={ui.textSecondary} />
                  </TouchableOpacity>
                ) : null}
              </View>

              <TouchableOpacity
                style={styles.transferScanBtn}
                onPress={() => setTransferScannerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Escanear código de barras del producto a transferir"
                activeOpacity={0.7}
              >
                <Barcode size={18} color={ui.primary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 140, marginBottom: 10 }} nestedScrollEnabled>
              {filteredTransferProducts.length === 0 ? (
                <View style={{ paddingVertical: 14, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: ui.textMuted }}>
                    No se encontraron productos coincidentes.
                  </Text>
                </View>
              ) : (
                filteredTransferProducts.map((p) => {
                  const stock = getProductStock(p);
                  const isSelected = transferProductId === p.id;
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={[styles.productPickRow, isSelected && styles.productPickRowActive]}
                      onPress={() => {
                        setTransferProductId(p.id);
                        setTransferSearchText(p.name);
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                    >
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text
                          style={[
                            styles.productPickName,
                            isSelected && { color: ui.primary, fontWeight: '700' },
                          ]}
                          numberOfLines={1}
                        >
                          {p.name}
                        </Text>
                        {p.sku ? (
                          <Text style={{ fontSize: 11, color: ui.textMuted }}>SKU: {p.sku}</Text>
                        ) : null}
                      </View>
                      <Text
                        style={[
                          styles.productPickStock,
                          isSelected && { color: ui.primary, fontWeight: '700' },
                        ]}
                      >
                        Disp: {stock} uds
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>

            <Text style={styles.inputLabel}>Cantidad a Enviar</Text>
            <TextInput
              style={[styles.formInput, { textAlign: 'center', fontSize: 18, fontWeight: '700' }]}
              value={transferQtyStr}
              onChangeText={setTransferQtyStr}
              placeholder="0"
              keyboardType="numeric"
            />

            <Text style={styles.inputLabel}>Nota / Guía de Remisión</Text>
            <TextInput
              style={styles.formInput}
              value={transferNotes}
              onChangeText={setTransferNotes}
              placeholder="Ej. Traslado por reposición tienda 2"
              placeholderTextColor={ui.textMuted}
            />

            <View style={styles.subModalActions}>
              <TouchableOpacity
                style={styles.subModalCancelBtn}
                onPress={() => setNewTransferModalOpen(false)}
                disabled={isCreatingTransfer}
              >
                <Text style={styles.subModalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.subModalConfirmBtn, isCreatingTransfer && { opacity: 0.6 }]}
                onPress={handleCreateTransfer}
                disabled={isCreatingTransfer}
              >
                {isCreatingTransfer ? (
                  <ActivityIndicator size="small" color={ui.surface} />
                ) : (
                  <>
                    <ArrowRightLeft size={16} color={ui.surface} />
                    <Text style={styles.subModalConfirmText}>Enviar Transferencia</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* MODAL 3: CREAR / EDITAR PRODUCTO */}
      <ProductFormModal
        visible={productModalOpen}
        product={editingProduct}
        onClose={() => setProductModalOpen(false)}
        onSave={handleSaveProduct}
        branchId={branchId}
      />

      {/* MODAL 4: PROVEEDORES Y ÓRDENES DE COMPRA */}
      <SuppliersPurchaseModal
        visible={suppliersModalOpen}
        onClose={() => setSuppliersModalOpen(false)}
        onStockUpdated={refreshProducts}
      />

      {/* MODAL 5: ESCÁNER DE CÓDIGO DE BARRAS EN INVENTARIO */}
      <BarcodeScannerModal
        visible={catalogScannerOpen}
        onClose={() => setCatalogScannerOpen(false)}
        onScan={(code) => {
          setCatalogScannerOpen(false);
          setSearchQuery(code);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
        title="Escanear en Inventario"
      />

      {/* MODAL 6: ESCÁNER DE CÓDIGO DE BARRAS PARA TRANSFERENCIAS */}
      <BarcodeScannerModal
        visible={transferScannerOpen}
        onClose={() => setTransferScannerOpen(false)}
        onScan={handleTransferBarcodeScanned}
        title="Escanear Producto a Transferir"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  kpiContainer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  inventorySummary: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  valuationRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  valuationLabel: { color: ui.textSecondary, fontSize: 13 },
  valuationAmount: { color: ui.text, fontSize: 19, fontWeight: '700', fontVariant: ['tabular-nums'] },
  inventoryCounts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  kpiFilterPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
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
  compactHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  compactHeaderTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: ui.text,
    letterSpacing: -0.4,
  },
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
    minHeight: 36,
    paddingHorizontal: 2,
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
    fontSize: 10.5,
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
  transferSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  transferSearchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    borderWidth: 1,
    borderColor: ui.border,
  },
  transferSearchInput: {
    flex: 1,
    fontSize: 13,
    color: ui.text,
    paddingVertical: 0,
  },
  transferScanBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary + '30',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newProductBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    minHeight: 46,
    borderRadius: 10,
  },
  newProductBtnText: {
    color: ui.onPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  filtersRow: {
    marginTop: 8,
  },
  filterStatusChip: {
    paddingHorizontal: 10,
    minHeight: 48,
    paddingVertical: 8,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
  },
  filterStatusChipActive: {
    backgroundColor: ui.primary,
  },
  filterStatusChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  filterStatusChipTextActive: {
    color: ui.surface,
  },
  chipDivider: {
    width: 1,
    height: 18,
    backgroundColor: ui.border,
    alignSelf: 'center',
    marginHorizontal: 4,
  },
  catChip: {
    paddingHorizontal: 10,
    minHeight: 48,
    paddingVertical: 8,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  catChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  catChipText: {
    fontSize: 11,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  catChipTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  centerLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
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
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: ui.border,
  },
  inventoryCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  productMark: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  productIdentity: {
    flex: 1,
    minWidth: 0,
  },
  inventoryCardName: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '700',
    color: ui.text,
  },
  inventoryCardSku: {
    flexShrink: 1,
    fontSize: 12,
    color: ui.textSecondary,
  },
  productMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  productCategory: {
    maxWidth: 110,
    fontSize: 12,
    color: ui.textSecondary,
  },
  metaSeparator: { color: ui.textMuted },
  productFinancialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  salePriceBlock: {
    flex: 1,
  },
  metricLabel: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  salePriceValue: {
    marginTop: 2,
    fontSize: 22,
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
    flexDirection: 'column',
    gap: 8,
    marginTop: 14,
  },
  secondaryActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtnStock: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
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
    paddingHorizontal: 12,
    minHeight: 48,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
  },
  actionBtnEditText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  actionBtnCart: {
    flex: 1,
    minWidth: 125,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: ui.primary,
    borderRadius: 12,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  actionBtnCartText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  listSectionHeading: { paddingHorizontal: 20, paddingBottom: 2 },
  kardexHeaderBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  kardexTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
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
  transfersSubtitle: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 1,
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
  subModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  subModalCard: {
    width: '100%',
    backgroundColor: ui.surface,
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 6,
  },
  subModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  subModalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  subModalSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
    maxWidth: 240,
  },
  adjustModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  adjustModeBtn: {
    flex: 1,
    paddingVertical: 8,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    alignItems: 'center',
  },
  adjustModeBtnActive: {
    backgroundColor: ui.text,
  },
  adjustModeBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  adjustModeBtnTextActive: {
    color: ui.surface,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 4,
  },
  formInput: {
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: ui.text,
    marginBottom: 12,
  },
  quickAmountHighlight: {
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    color: ui.text,
  },
  reasonsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 12,
  },
  reasonChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  reasonChipActive: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  reasonChipText: {
    fontSize: 11,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  reasonChipTextActive: {
    color: ui.surface,
    fontWeight: '700',
  },
  subModalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  subModalCancelBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
  },
  subModalCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  subModalConfirmBtn: {
    flex: 1.5,
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: ui.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subModalConfirmText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.surface,
  },
  branchPickChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    marginRight: 8,
  },
  branchPickChipActive: {
    backgroundColor: ui.primary,
  },
  branchPickChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  branchPickChipTextActive: {
    color: ui.surface,
  },
  productPickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
    borderRadius: 6,
  },
  productPickRowActive: {
    backgroundColor: ui.primarySoft,
  },
  productPickName: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    flex: 1,
  },
  productPickStock: {
    fontSize: 11,
    color: ui.primary,
    fontWeight: '700',
  },
});
