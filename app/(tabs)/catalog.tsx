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
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { useProducts } from '@/context/ProductsContext';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useCart } from '@/context/CartContext';
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
import { SuppliersPurchaseModal } from '@/components/SuppliersPurchaseModal';
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
  const { products, categories, loading: productsLoading, refreshProducts, getProductStock } = useProducts();
  const { branches, activeBranchName } = useSettings();
  const { addItem } = useCart();

  // Sub-pestaña activa
  const [activeTab, setActiveTab] = useState<ActiveTab>('inventory');
  const [suppliersModalOpen, setSuppliersModalOpen] = useState(false);

  // Filtros de Inventario
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StockStatusFilter>('all');
  const [selectedCategory, setSelectedCategory] = useState('Todas');

  // Modal de Producto (Crear / Editar)
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

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

      if (!q) return true;
      const nameMatch = p.name?.toLowerCase().includes(q);
      const skuMatch = p.sku?.toLowerCase().includes(q);
      const barcodeMatch = p.barcode?.toLowerCase().includes(q);
      return nameMatch || skuMatch || barcodeMatch;
    });
  }, [products, searchQuery, statusFilter, selectedCategory, getProductStock]);

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
    if (!accountId) return;

    const stockMap: Record<string, number> = { ...(editingProduct?.stock || {}) };
    stockMap[branchId] = formData.stock;

    const productPayload = {
      id: formData.id,
      name: formData.name,
      category: formData.category,
      barcode: formData.barcode,
      sku: formData.sku,
      unitOfMeasure: formData.unitOfMeasure as any,
      price: formData.price,
      suggestedPrice: formData.price,
      minSalePrice: formData.minSalePrice,
      costPrice: formData.cost,
      stock: stockMap,
      minStock: formData.minStock,
      presentations: formData.presentations as any,
      accountId,
    };

    await saveProduct(
      productPayload,
      !formData.id,
      {
        uid: user?.uid || 'user_pos',
        displayName: userProfile?.displayName || user?.displayName || user?.email || 'Administrador',
        email: user?.email || '',
      }
    );

    refreshProducts();
  };

  // Confirmar Nueva Transferencia entre Sucursales
  const handleCreateTransfer = async () => {
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
      <ScreenHeading
        title={activeTab === 'inventory' ? 'Inventario' : activeTab === 'kardex' ? 'Movimientos' : 'Transferencias'}
        subtitle={activeTab === 'inventory' ? 'Controla productos, existencias y costos.' : activeTab === 'kardex' ? 'Historial de movimientos de inventario.' : 'Traslada productos entre sucursales.'}
        action={activeTab === 'inventory' ? (
          <TouchableOpacity
            style={styles.headingAction}
            onPress={() => { setEditingProduct(null); setProductModalOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel="Crear producto"
          >
            <Plus size={18} color={ui.onPrimary} />
            <Text style={styles.headingActionText}>Nuevo producto</Text>
          </TouchableOpacity>
        ) : null}
      />

      {activeTab === 'inventory' && (
        <View style={styles.kpiContainer}>
          <View style={styles.inventorySummary}>
            <View style={styles.valuationRow}>
              <Text style={styles.valuationLabel}>Valor del inventario</Text>
              <Text style={styles.valuationAmount}>{formatPEN(kpis.valuation)}</Text>
            </View>
            <View style={styles.inventoryCounts}>
              <Text style={styles.inventoryCount}><Text style={styles.inventoryCountValue}>{kpis.totalSkus}</Text> productos</Text>
              <Text style={[styles.inventoryCount, styles.kpiWarning]}><Text style={styles.inventoryCountValue}>{kpis.lowStockCount}</Text> stock bajo</Text>
              <Text style={[styles.inventoryCount, styles.kpiDanger]}><Text style={styles.inventoryCountValue}>{kpis.outOfStockCount}</Text> agotados</Text>
            </View>
          </View>
        </View>
      )}

      {/* 2. SELECTOR DE 3 SUB-PESTAÑAS */}
        <View style={styles.tabsNavWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsNavScroll}
          contentContainerStyle={styles.tabsNav}
        >
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'inventory' && styles.tabBtnActive]}
            onPress={() => setActiveTab('inventory')}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'inventory' }}
            accessibilityLabel="Inventario"
          >
            <Package size={15} color={activeTab === 'inventory' ? ui.primary : ui.textSecondary} />
            <Text
              style={[
                styles.tabBtnText,
                activeTab === 'inventory' && styles.tabBtnTextActive,
              ]}
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
            accessibilityLabel="Kardex, movimientos de inventario"
          >
            <History size={15} color={activeTab === 'kardex' ? ui.primary : ui.textSecondary} />
            <Text
              style={[styles.tabBtnText, activeTab === 'kardex' && styles.tabBtnTextActive]}
            >
              Kardex
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
            <ArrowRightLeft size={15} color={activeTab === 'transfers' ? ui.primary : ui.textSecondary} />
            <Text
              style={[
                styles.tabBtnText,
                activeTab === 'transfers' && styles.tabBtnTextActive,
              ]}
            >
              Transferencias
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.tabBtn}
            onPress={() => setSuppliersModalOpen(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Abrir compras a proveedores"
          >
            <Truck size={15} color={ui.primary} />
            <Text style={[styles.tabBtnText, { color: ui.primary }]}>
              Compras
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* ========================================================================= */}
      {/* CONTENIDO SEGÚN SUB-PESTAÑA                                               */}
      {/* ========================================================================= */}

      {/* PESTAÑA 1: INVENTARIO */}
      {activeTab === 'inventory' ? (
        <View style={{ flex: 1 }}>
          {/* Buscador y Botón Nuevo */}
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

          </View>

          {/* Filtros de Estado y Categorías */}
          <View style={styles.filtersRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6, paddingHorizontal: 14 }}
            >
              {[
                { id: 'all', label: 'Todos' },
                { id: 'low', label: 'Stock Bajo' },
                { id: 'out', label: 'Agotados' },
              ].map((f) => (
                <TouchableOpacity
                  key={f.id}
                  style={[
                    styles.filterStatusChip,
                    statusFilter === f.id && styles.filterStatusChipActive,
                  ]}
                  onPress={() => setStatusFilter(f.id as StockStatusFilter)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: statusFilter === f.id }}
                  accessibilityLabel={`Filtrar por ${f.label}`}
                >
                  <Text
                    style={[
                      styles.filterStatusChipText,
                      statusFilter === f.id && styles.filterStatusChipTextActive,
                    ]}
                  >
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}

              <View style={styles.chipDivider} />

              {['Todas', ...categories.filter((c) => c !== 'Todas' && c !== 'Todos')].map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.catChip,
                    selectedCategory === cat && styles.catChipActive,
                  ]}
                  onPress={() => setSelectedCategory(cat)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedCategory === cat }}
                  accessibilityLabel={`Filtrar por categoría ${cat}`}
                >
                  <Text
                    style={[
                      styles.catChipText,
                      selectedCategory === cat && styles.catChipTextActive,
                    ]}
                  >
                    {cat}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

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
                ) : (
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
                      </View>

                      <View style={styles.inventoryActionsRow}>
                        <TouchableOpacity
                          style={styles.actionBtnCart}
                          onPress={() => { addItem(item, { quantity: 1 }); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel={`Agregar ${item.name} al carrito`}
                        >
                          <ShoppingCart size={16} color={ui.onPrimary} />
                          <Text style={styles.actionBtnCartText}>Agregar al carrito</Text>
                        </TouchableOpacity>
                        <View style={styles.secondaryActionsRow}>
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
                            <Edit3 size={16} color={ui.primary} />
                            <Text style={styles.actionBtnEditText}>Editar producto</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.actionBtnStock}
                            onPress={() => openStockModal(item)}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={`Ajustar stock de ${item.name}`}
                          >
                            <Zap size={16} color={ui.warning} />
                            <Text style={styles.actionBtnStockText}>Ajustar stock</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
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
              <Text style={styles.centerLoadingText}>Consultando Kardex oficial...</Text>
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
                const isIncoming = item.type === 'in';
                const isOutgoing = item.type === 'out';
                const isTransfer = item.type === 'transfer' || item.type === 'in_transit';

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
                          {isIncoming ? `+${item.quantity}` : isOutgoing ? `-${item.quantity}` : `Δ ${item.quantity}`}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.kardexCardBottom}>
                      <Text style={styles.kardexReason}>Motivo: {item.reason || 'Ajuste de inventario'}</Text>
                      <Text style={styles.kardexStockChange}>
                        {item.previousStock} ➔ {item.newStock} uds
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
            <SectionHeading title="Transferencias entre sucursales" subtitle="Envía y recibe mercadería entre locales" />
            <TouchableOpacity
              style={styles.newTransferBtn}
              onPress={() => {
                setNewTransferModalOpen(true);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              activeOpacity={0.8}
            >
              <Plus size={16} color={ui.surface} />
              <Text style={styles.newTransferBtnText}>Nueva</Text>
            </TouchableOpacity>
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
                Usa el botón "+ Nueva" para enviar productos a otra sucursal.
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
            <ScrollView style={{ maxHeight: 130, marginBottom: 10 }}>
              {products.map((p) => {
                const stock = getProductStock(p);
                const isSelected = transferProductId === p.id;
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[styles.productPickRow, isSelected && styles.productPickRowActive]}
                    onPress={() => setTransferProductId(p.id)}
                  >
                    <Text style={styles.productPickName}>{p.name}</Text>
                    <Text style={styles.productPickStock}>Disp: {stock} uds</Text>
                  </TouchableOpacity>
                );
              })}
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
  inventoryCounts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  inventoryCount: { color: ui.textSecondary, fontSize: 12, lineHeight: 18 },
  inventoryCountValue: { fontWeight: '700' },
  kpiWarning: { color: ui.warning },
  kpiDanger: { color: ui.danger },
  kpiSuccess: { color: ui.success },
  headingAction: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 15,
    backgroundColor: ui.primary,
    borderRadius: 12,
  },
  headingActionText: {
    color: ui.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  tabsNavWrapper: {
    backgroundColor: ui.surface,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  tabsNav: {
    minWidth: '100%',
    flexDirection: 'row',
    gap: 6,
  },
  tabsNavScroll: {
    flexGrow: 0,
  },
  tabBtn: {
    flexGrow: 0,
    minWidth: 92,
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
  },
  tabBtnActive: {
    backgroundColor: ui.primarySoft,
  },
  tabBtnText: {
    fontSize: 12,
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
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
