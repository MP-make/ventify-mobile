/**
 * Ventify Mobile - Suppliers & Purchase Orders Modal
 *
 * Componente modal nativo completo con 2 pestañas:
 * - Pestaña 1: Órdenes de Compra (Abastecimiento, KPIs, creación y recepción atómica en almacén con Kardex)
 * - Pestaña 2: Directorio de Proveedores (Búsqueda, tarjetas, llamadas, WhatsApp y formulario con autocompletado RUC SUNAT)
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import {
  X,
  Search,
  Plus,
  Building2,
  Truck,
  CheckCircle2,
  Clock,
  Boxes,
  ClipboardList,
  Contact,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthSession } from '@/context/AuthContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatPEN, ui } from '@/lib/theme';
import { BrandLogo } from '@/components/ui';
import {
  SuppliersPOService,
  Supplier,
  PurchaseOrder,
  ReceivedProductCostChange,
  ReceivePurchaseOrderResult,
  calculatePurchaseOrderStats,
} from '@/services/suppliers-po-service';
import {
  suppliersStyles as styles,
  LIST_CONTENT_STYLE,
} from './suppliers/suppliersStyles';
import { OrderCardRow } from './suppliers/OrderCardRow';
import { SupplierCardRow } from './suppliers/SupplierCardRow';
import { CreateOrderModal } from './suppliers/CreateOrderModal';
import { SupplierFormModal } from './suppliers/SupplierFormModal';
import { ReceiveOrderModal } from './suppliers/ReceiveOrderModal';
import { PriceSuggestionModal } from './suppliers/PriceSuggestionModal';

// ============================================================================
// PROPS DEL MODAL PRINCIPAL
// ============================================================================

export interface SuppliersPurchaseModalProps {
  visible: boolean;
  onClose: () => void;
  onStockUpdated?: () => void;
  initialTab?: 'orders' | 'suppliers';
}

const ORDER_STATUS_FILTERS = [
  { id: 'all', label: 'Todas' },
  { id: 'pending', label: 'Pendientes' },
  { id: 'partial', label: 'Parciales' },
  { id: 'received', label: 'Recibidas' },
  { id: 'cancelled', label: 'Canceladas' },
] as const;

const keyExtractorById = <T extends { id: string }>(item: T): string => item.id;

interface OrdersExtraData {
  expandedOrderId: string | null;
  isReceivingId: string | null;
}

export const SuppliersPurchaseModal: React.FC<SuppliersPurchaseModalProps> = React.memo(({
  visible,
  onClose,
  onStockUpdated,
  initialTab = 'orders',
}) => {
  const { accountId, userProfile } = useAuthSession();

  // --------------------------------------------------------------------------
  // ESTADOS PRINCIPALES: PESTAÑAS Y LISTADOS
  // --------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<'orders' | 'suppliers'>(initialTab);

  // Órdenes de compra
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState<boolean>(false);
  const [orderSearchQuery, setOrderSearchQuery] = useState<string>('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [isReceivingId, setIsReceivingId] = useState<string | null>(null);

  // Proveedores
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suppliersLoading, setSuppliersLoading] = useState<boolean>(false);
  const [supplierSearchQuery, setSupplierSearchQuery] = useState<string>('');

  const debouncedOrderSearch = useDebouncedValue(orderSearchQuery, 150);
  const debouncedSupplierSearch = useDebouncedValue(supplierSearchQuery, 150);

  // --------------------------------------------------------------------------
  // VISIBILIDAD / PAYLOAD DE SUB-MODALES (CONDICIONALMENTE MONTADOS)
  // --------------------------------------------------------------------------
  const [createOrderModalVisible, setCreateOrderModalVisible] = useState<boolean>(false);
  const [receiveModalOrder, setReceiveModalOrder] = useState<PurchaseOrder | null>(null);
  const [priceSuggestionCostChanges, setPriceSuggestionCostChanges] = useState<
    ReceivedProductCostChange[] | null
  >(null);
  const [supplierFormState, setSupplierFormState] = useState<{
    visible: boolean;
    editingSupplier: Supplier | null;
  }>({ visible: false, editingSupplier: null });

  // Sincronizar pestaña inicial si cambia desde props
  useEffect(() => {
    if (visible) {
      setActiveTab(initialTab);
    }
  }, [visible, initialTab]);

  // --------------------------------------------------------------------------
  // CARGA Y SUSCRIPCIÓN EN TIEMPO REAL
  // --------------------------------------------------------------------------
  useEffect(() => {
    let isCurrentAccount = true;
    if (!visible || !accountId) {
      setPurchaseOrders([]);
      setSuppliers([]);
      setOrdersLoading(false);
      setSuppliersLoading(false);
      return () => {
        isCurrentAccount = false;
      };
    }

    setPurchaseOrders([]);
    setSuppliers([]);
    setOrdersLoading(true);
    const unsubscribeOrders = SuppliersPOService.subscribePurchaseOrders(
      accountId,
      (orders) => {
        if (!isCurrentAccount) return;
        setPurchaseOrders(orders);
        setOrdersLoading(false);
      }
    );

    setSuppliersLoading(true);
    const unsubscribeSuppliers = SuppliersPOService.subscribeSuppliers(
      accountId,
      (suppliersList) => {
        if (!isCurrentAccount) return;
        setSuppliers(suppliersList);
        setSuppliersLoading(false);
      }
    );

    return () => {
      isCurrentAccount = false;
      unsubscribeOrders();
      unsubscribeSuppliers();
    };
  }, [visible, accountId]);

  // KPIs de órdenes de compra
  const orderStats = useMemo(() => {
    return calculatePurchaseOrderStats(purchaseOrders);
  }, [purchaseOrders]);

  // Filtrado de órdenes de compra (búsqueda debounced)
  const filteredOrders = useMemo(() => {
    const query = debouncedOrderSearch.toLowerCase().trim();
    return purchaseOrders.filter((order) => {
      const matchesStatus =
        orderStatusFilter === 'all'
          ? true
          : orderStatusFilter === 'pending'
          ? order.status === 'pending' || order.status === 'ordered' || order.status === 'partial'
          : order.status === orderStatusFilter;

      if (!matchesStatus) return false;
      if (!query) return true;

      const numMatch = (order.orderNumber || '').toLowerCase().includes(query);
      const supMatch = (order.supplierName || '').toLowerCase().includes(query);
      const notesMatch = (order.notes || '').toLowerCase().includes(query);

      return numMatch || supMatch || notesMatch;
    });
  }, [purchaseOrders, orderStatusFilter, debouncedOrderSearch]);

  // Filtrado de proveedores (búsqueda debounced)
  const filteredSuppliers = useMemo(() => {
    const query = debouncedSupplierSearch.toLowerCase().trim();
    if (!query) return suppliers;
    return suppliers.filter((s) => {
      const nameMatch = (s.name || '').toLowerCase().includes(query);
      const rucMatch = (s.taxId || '').toLowerCase().includes(query);
      const contactMatch = (s.contactName || '').toLowerCase().includes(query);
      const catMatch = (s.category || '').toLowerCase().includes(query);
      const phoneMatch = (s.phone || '').toLowerCase().includes(query);
      return nameMatch || rucMatch || contactMatch || catMatch || phoneMatch;
    });
  }, [suppliers, debouncedSupplierSearch]);

  // --------------------------------------------------------------------------
  // ACCIONES SOBRE ÓRDENES
  // --------------------------------------------------------------------------
  const handleToggleExpandOrder = useCallback((orderId: string) => {
    setExpandedOrderId((prev) => (prev === orderId ? null : orderId));
  }, []);

  const handleReceiveOrder = useCallback((order: PurchaseOrder) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setReceiveModalOrder(order);
  }, []);

  const handleReceiptSuccess = useCallback(
    (order: PurchaseOrder, result: ReceivePurchaseOrderResult) => {
      setReceiveModalOrder(null);
      onStockUpdated?.();

      if (result.costChanges.length > 0) {
        setPriceSuggestionCostChanges(result.costChanges);
      } else {
        const isPartialResult = result.status === 'partial';
        Alert.alert(
          isPartialResult ? 'Recepción Parcial Guardada' : '¡Recepción Exitosa!',
          isPartialResult
            ? `Se ingresaron las cantidades seleccionadas de la orden ${order.orderNumber} al almacén y al Kardex. Podrás completar el resto luego.`
            : `La orden ${order.orderNumber} ha sido ingresada completamente al almacén y registrada en el Kardex.`
        );
      }
    },
    [onStockUpdated]
  );

  const handleCancelOrder = useCallback(
    async (order: PurchaseOrder) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      Alert.alert(
        'Cancelar Orden de Compra',
        `¿Estás seguro de cancelar la orden ${order.orderNumber}? Esta acción no se puede deshacer.`,
        [
          { text: 'No, mantener', style: 'cancel' },
          {
            text: 'Sí, cancelar orden',
            style: 'destructive',
            onPress: async () => {
              try {
                await SuppliersPOService.cancelPurchaseOrder(order.id, userProfile);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                Alert.alert('Orden Cancelada', `La orden ${order.orderNumber} ha sido cancelada.`);
              } catch (err: any) {
                Alert.alert('Error', err?.message || 'No se pudo cancelar la orden.');
              }
            },
          },
        ]
      );
    },
    [userProfile]
  );

  // --------------------------------------------------------------------------
  // ACCIONES SOBRE SUB-MODALES
  // --------------------------------------------------------------------------
  const handleOpenCreateOrderModal = useCallback(() => {
    setCreateOrderModalVisible(true);
  }, []);

  const handleCloseCreateOrderModal = useCallback(() => {
    setCreateOrderModalVisible(false);
  }, []);

  const handleOpenSupplierForm = useCallback((supplierToEdit?: Supplier) => {
    setSupplierFormState({
      visible: true,
      editingSupplier: supplierToEdit ?? null,
    });
  }, []);

  const handleCloseSupplierForm = useCallback(() => {
    setSupplierFormState({ visible: false, editingSupplier: null });
  }, []);

  const handleRequestNewSupplierFromOrder = useCallback(() => {
    setCreateOrderModalVisible(false);
    setSupplierFormState({ visible: true, editingSupplier: null });
  }, []);

  const handleCloseReceiveModal = useCallback(() => {
    setReceiveModalOrder(null);
  }, []);

  const handleClosePriceSuggestions = useCallback(() => {
    setPriceSuggestionCostChanges(null);
  }, []);

  const handleAppliedPriceSuggestions = useCallback(() => {
    setPriceSuggestionCostChanges(null);
    onStockUpdated?.();
  }, [onStockUpdated]);

  // --------------------------------------------------------------------------
  // ACCIONES SOBRE PROVEEDORES
  // --------------------------------------------------------------------------
  const handleDeleteSupplier = useCallback((supplier: Supplier) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Desactivar Proveedor',
      `¿Deseas dar de baja a "${supplier.name}" del directorio?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sí, desactivar',
          style: 'destructive',
          onPress: async () => {
            try {
              await SuppliersPOService.deleteSupplier(supplier.id);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Proveedor Desactivado', 'El proveedor ha sido dado de baja.');
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'No se pudo desactivar el proveedor.');
            }
          },
        },
      ]
    );
  }, []);

  const handleCallSupplier = useCallback((phone?: string) => {
    if (!phone) return;
    const clean = phone.replace(/[^\d+]/g, '');
    Linking.openURL(`tel:${clean}`).catch(() => {
      Alert.alert('Aviso', 'No se pudo abrir la aplicación de llamadas telefónicas.');
    });
  }, []);

  const handleWhatsAppSupplier = useCallback((phone?: string, supplierName?: string) => {
    if (!phone) return;
    const clean = phone.replace(/\D/g, '');
    const numWithCountry = clean.length === 9 ? `51${clean}` : clean;
    const msg = encodeURIComponent(
      `Hola ${supplierName || ''}, me comunico desde Ventify respecto a una orden de compra.`
    );
    Linking.openURL(`https://wa.me/${numWithCountry}?text=${msg}`).catch(() => {
      Alert.alert('Aviso', 'No se pudo abrir WhatsApp.');
    });
  }, []);

  const handleEmailSupplier = useCallback((email?: string, supplierName?: string) => {
    if (!email) return;
    const subject = encodeURIComponent(`Consulta de Compra - ${supplierName || ''}`);
    Linking.openURL(`mailto:${email}?subject=${subject}`).catch(() => {
      Alert.alert('Aviso', 'No se pudo abrir la aplicación de correo electrónico.');
    });
  }, []);

  // --------------------------------------------------------------------------
  // FLASHLIST RENDERERS & EXTRADATA
  // --------------------------------------------------------------------------
  const ordersExtraData = useMemo<OrdersExtraData>(
    () => ({ expandedOrderId, isReceivingId }),
    [expandedOrderId, isReceivingId]
  );

  const renderOrderItem = useCallback<ListRenderItem<PurchaseOrder>>(
    ({ item: order, extraData }) => {
      const ctx = extraData as OrdersExtraData | undefined;
      return (
        <OrderCardRow
          order={order}
          isExpanded={ctx?.expandedOrderId === order.id}
          isReceiving={ctx?.isReceivingId === order.id}
          onToggleExpand={handleToggleExpandOrder}
          onReceiveOrder={handleReceiveOrder}
          onCancelOrder={handleCancelOrder}
        />
      );
    },
    [handleToggleExpandOrder, handleReceiveOrder, handleCancelOrder]
  );

  const renderSupplierItem = useCallback<ListRenderItem<Supplier>>(
    ({ item: supplier }) => (
      <SupplierCardRow
        supplier={supplier}
        onEdit={handleOpenSupplierForm}
        onDelete={handleDeleteSupplier}
        onCall={handleCallSupplier}
        onWhatsApp={handleWhatsAppSupplier}
        onEmail={handleEmailSupplier}
      />
    ),
    [
      handleOpenSupplierForm,
      handleDeleteSupplier,
      handleCallSupplier,
      handleWhatsAppSupplier,
      handleEmailSupplier,
    ]
  );

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        {/* ENCABEZADO PRINCIPAL */}
        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <BrandLogo size={34} wordmark={false} />
            <View>
              <Text style={styles.headerTitle}>Compras y proveedores</Text>
              <Text style={styles.headerSubtitle}>Gestión de abastecimiento</Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cerrar compras y proveedores"
          >
            <X size={20} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* SELECTOR DE PESTAÑAS */}
        <View style={styles.tabsBar}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'orders' && styles.tabButtonActive]}
            onPress={() => setActiveTab('orders')}
          >
            <ClipboardList
              size={17}
              color={activeTab === 'orders' ? ui.primary : ui.textSecondary}
            />
            <Text
              style={[styles.tabButtonText, activeTab === 'orders' && styles.tabButtonTextActive]}
            >
              Órdenes de Compra
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'suppliers' && styles.tabButtonActive]}
            onPress={() => setActiveTab('suppliers')}
          >
            <Contact
              size={17}
              color={activeTab === 'suppliers' ? ui.primary : ui.textSecondary}
            />
            <Text
              style={[
                styles.tabButtonText,
                activeTab === 'suppliers' && styles.tabButtonTextActive,
              ]}
            >
              Proveedores
            </Text>
          </TouchableOpacity>
        </View>

        {/* CONTENIDO SEGÚN LA PESTAÑA SELECCIONADA */}
        <View style={{ flex: 1 }}>
          {activeTab === 'orders' ? (
            <View style={styles.tabContentContainer}>
              <Text style={styles.sectionSubOnly}>Abastecimiento y seguimiento de recepción.</Text>

              {/* RESUMEN COMPACTO DE ABASTECIMIENTO */}
              <View style={styles.kpiContainer}>
                <View style={[styles.kpiCard, { borderColor: ui.warningSoft, backgroundColor: ui.warningSoft }]}>
                  <View style={styles.kpiHeaderRow}>
                    <Clock size={13} color={ui.warning} />
                    <Text style={[styles.kpiLabel, { color: ui.warning }]} numberOfLines={1}>Pendientes</Text>
                  </View>
                  <Text style={[styles.kpiValue, { color: ui.warning }]}>{orderStats.pendingCount}</Text>
                  <Text style={[styles.kpiSub, { color: ui.warning }]} numberOfLines={1}>
                    {formatPEN(orderStats.totalPendingAmount)}
                  </Text>
                </View>

                <View style={[styles.kpiCard, { borderColor: ui.success, backgroundColor: ui.successSoft }]}>
                  <View style={styles.kpiHeaderRow}>
                    <CheckCircle2 size={13} color={ui.primary} />
                    <Text style={[styles.kpiLabel, { color: ui.success }]} numberOfLines={1}>Recibidas</Text>
                  </View>
                  <Text style={[styles.kpiValue, { color: ui.success }]}>{orderStats.receivedCount}</Text>
                  <Text style={[styles.kpiSub, { color: ui.success }]} numberOfLines={1}>
                    {formatPEN(orderStats.totalInvested)}
                  </Text>
                </View>

                <View style={[styles.kpiCard, { borderColor: ui.border, backgroundColor: ui.background }]}>
                  <View style={styles.kpiHeaderRow}>
                    <Boxes size={13} color={ui.textSecondary} />
                    <Text style={[styles.kpiLabel, { color: ui.textSecondary }]} numberOfLines={1}>Total</Text>
                  </View>
                  <Text style={[styles.kpiValue, { color: ui.text }]}>{orderStats.totalOrders}</Text>
                  <Text style={[styles.kpiSub, { color: ui.textSecondary }]} numberOfLines={1}>Histórico</Text>
                </View>
              </View>

              {/* BUSCADOR + NUEVA ORDEN EN UNA MISMA FILA */}
              <View style={styles.searchActionRow}>
                <View style={styles.searchBarInline}>
                  <Search size={16} color={ui.textMuted} style={styles.searchIcon} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="N° orden o proveedor..."
                    placeholderTextColor={ui.textMuted}
                    value={orderSearchQuery}
                    onChangeText={setOrderSearchQuery}
                    clearButtonMode="while-editing"
                  />
                </View>
                <TouchableOpacity
                  style={styles.inlineActionBtn}
                  onPress={handleOpenCreateOrderModal}
                  activeOpacity={0.8}
                >
                  <Plus size={16} color={ui.surface} />
                  <Text style={styles.inlineActionBtnText}>Nueva</Text>
                </TouchableOpacity>
              </View>

              {/* CHIPS DE FILTRO DE ESTADO EN UNA SOLA FILA SIN SCROLL */}
              <View style={styles.filterChipsRow}>
                {ORDER_STATUS_FILTERS.map((chip) => {
                  const isSelected = orderStatusFilter === chip.id;
                  return (
                    <TouchableOpacity
                      key={chip.id}
                      style={[styles.filterChip, isSelected && styles.filterChipActive]}
                      onPress={() => setOrderStatusFilter(chip.id)}
                    >
                      <Text
                        style={[styles.filterChipText, isSelected && styles.filterChipTextActive]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.78}
                      >
                        {chip.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* LISTADO VIRTUALIZADO DE ÓRDENES */}
              {ordersLoading && purchaseOrders.length === 0 ? (
                <View style={styles.centerContainer}>
                  <ActivityIndicator size="large" color={ui.primary} />
                  <Text style={styles.loadingText}>Cargando órdenes de compra...</Text>
                </View>
              ) : filteredOrders.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Truck size={48} color={ui.border} />
                  <Text style={styles.emptyTitle}>No hay órdenes de compra</Text>
                  <Text style={styles.emptySubtitle}>
                    {orderSearchQuery
                      ? 'No se encontraron coincidencias para la búsqueda.'
                      : 'Empieza registrando una orden a tus proveedores para abastecer tu inventario.'}
                  </Text>
                  {!orderSearchQuery && (
                    <TouchableOpacity
                      style={styles.emptyActionButton}
                      onPress={handleOpenCreateOrderModal}
                    >
                      <Plus size={16} color={ui.primary} />
                      <Text style={styles.emptyActionButtonText}>Crear Primera Orden</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : (
                <FlashList
                  data={filteredOrders}
                  keyExtractor={keyExtractorById}
                  renderItem={renderOrderItem}
                  extraData={ordersExtraData}
                  estimatedItemSize={210}
                  contentContainerStyle={LIST_CONTENT_STYLE}
                  showsVerticalScrollIndicator={false}
                />
              )}
            </View>
          ) : (
            <View style={styles.tabContentContainer}>
              <Text style={styles.sectionSubOnly}>Directorio, contactos y condiciones comerciales.</Text>

              {/* BUSCADOR + NUEVO PROVEEDOR EN UNA MISMA FILA */}
              <View style={styles.searchActionRow}>
                <View style={styles.searchBarInline}>
                  <Search size={16} color={ui.textMuted} style={styles.searchIcon} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Buscar RUC, nombre o categoría..."
                    placeholderTextColor={ui.textMuted}
                    value={supplierSearchQuery}
                    onChangeText={setSupplierSearchQuery}
                    clearButtonMode="while-editing"
                  />
                </View>
                <TouchableOpacity
                  style={styles.inlineActionBtn}
                  onPress={() => handleOpenSupplierForm()}
                  activeOpacity={0.8}
                >
                  <Plus size={16} color={ui.surface} />
                  <Text style={styles.inlineActionBtnText}>Nuevo</Text>
                </TouchableOpacity>
              </View>

              {/* LISTADO VIRTUALIZADO DE PROVEEDORES */}
              {suppliersLoading && suppliers.length === 0 ? (
                <View style={styles.centerContainer}>
                  <ActivityIndicator size="large" color={ui.primary} />
                  <Text style={styles.loadingText}>Cargando proveedores...</Text>
                </View>
              ) : filteredSuppliers.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Building2 size={48} color={ui.border} />
                  <Text style={styles.emptyTitle}>No hay proveedores</Text>
                  <Text style={styles.emptySubtitle}>
                    {supplierSearchQuery
                      ? 'No se encontraron proveedores que coincidan con la búsqueda.'
                      : 'Registra tus proveedores con su RUC para gestionar compras y llamadas rápidas.'}
                  </Text>
                  {!supplierSearchQuery && (
                    <TouchableOpacity
                      style={styles.emptyActionButton}
                      onPress={() => handleOpenSupplierForm()}
                    >
                      <Plus size={16} color={ui.primary} />
                      <Text style={styles.emptyActionButtonText}>Registrar Primer Proveedor</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : (
                <FlashList
                  data={filteredSuppliers}
                  keyExtractor={keyExtractorById}
                  renderItem={renderSupplierItem}
                  estimatedItemSize={220}
                  contentContainerStyle={LIST_CONTENT_STYLE}
                  showsVerticalScrollIndicator={false}
                />
              )}
            </View>
          )}
        </View>

        {/* SUB-MODAL 1: CREAR NUEVA ORDEN DE COMPRA (CONDICIONALMENTE MONTADO) */}
        {createOrderModalVisible && (
          <CreateOrderModal
            visible={createOrderModalVisible}
            suppliers={suppliers}
            onClose={handleCloseCreateOrderModal}
            onRequestNewSupplier={handleRequestNewSupplierFromOrder}
          />
        )}

        {/* SUB-MODAL 2: NUEVO / EDITAR PROVEEDOR CON SUNAT AUTOCOMPLETE */}
        {supplierFormState.visible && (
          <SupplierFormModal
            visible={supplierFormState.visible}
            editingSupplier={supplierFormState.editingSupplier}
            onClose={handleCloseSupplierForm}
          />
        )}

        {/* SUB-MODAL 3: RECEPCIÓN PARCIAL / COMPLETA EN ALMACÉN */}
        {receiveModalOrder !== null && (
          <ReceiveOrderModal
            order={receiveModalOrder}
            onClose={handleCloseReceiveModal}
            onReceivingStateChange={setIsReceivingId}
            onReceiptSuccess={handleReceiptSuccess}
          />
        )}

        {/* SUB-MODAL 4: SUGERENCIA DE PRECIOS POR CAMBIO DE COSTO CPP */}
        {priceSuggestionCostChanges !== null && (
          <PriceSuggestionModal
            visible={true}
            costChanges={priceSuggestionCostChanges}
            onClose={handleClosePriceSuggestions}
            onApplied={handleAppliedPriceSuggestions}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
});

export default SuppliersPurchaseModal;
