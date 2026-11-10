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
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  FlatList,
} from 'react-native';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import {
  X,
  Search,
  Plus,
  Trash2,
  Edit2,
  Phone,
  MessageCircle,
  Mail,
  MapPin,
  Building2,
  Truck,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Package,
  Calendar,
  RefreshCw,
  Check,
  User,
  DollarSign,
  FileText,
  Boxes,
  ClipboardList,
  Contact,
  CreditCard,
  Ban,
  ArrowDownLeft,
} from 'lucide-react-native';

import { useAuth } from '@/context/AuthContext';
import { useProducts } from '@/context/ProductsContext';
import { formatPEN, formatDatePE } from '@/lib/theme';
import { ui } from '@/lib/theme';
import { BrandLogo, SectionHeading } from '@/components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lookupDocument, DocumentLookupResult } from '@/lib/dni-ruc-service';
import {
  SuppliersPOService,
  Supplier,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderStatus,
  calculatePurchaseOrderStats,
} from '@/services/suppliers-po-service';
import type { Product } from '@/types';

// ============================================================================
// PROPS DEL MODAL PRINCIPAL
// ============================================================================

export interface SuppliersPurchaseModalProps {
  visible: boolean;
  onClose: () => void;
  onStockUpdated?: () => void;
  initialTab?: 'orders' | 'suppliers';
}

const SUPPLIER_CATEGORIES = [
  'Mayorista',
  'Distribuidor',
  'Fabricante',
  'Importador',
  'Abarrotes',
  'Bebidas',
  'Insumos',
  'Servicios',
  'Otros',
];

const PAYMENT_TERMS_OPTIONS = [
  'Contado',
  'Crédito 7 días',
  'Crédito 15 días',
  'Crédito 30 días',
  'Crédito 60 días',
  'Contra entrega',
];

export const SuppliersPurchaseModal: React.FC<SuppliersPurchaseModalProps> = ({
  visible,
  onClose,
  onStockUpdated,
  initialTab = 'orders',
}) => {
  const { accountId, branchId, userProfile } = useAuth();
  const { products, getProductStock } = useProducts();
  const insets = useSafeAreaInsets();

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

  // --------------------------------------------------------------------------
  // SUB-MODAL: NUEVA ORDEN DE COMPRA
  // --------------------------------------------------------------------------
  const [createOrderModalVisible, setCreateOrderModalVisible] = useState<boolean>(false);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [supplierPickerVisible, setSupplierPickerVisible] = useState<boolean>(false);
  const [orderItems, setOrderItems] = useState<PurchaseOrderItem[]>([]);
  const [orderNotes, setOrderNotes] = useState<string>('');
  const [expectedDateStr, setExpectedDateStr] = useState<string>('');
  const [isCreatingOrder, setIsCreatingOrder] = useState<boolean>(false);

  // Búsqueda y agregado de productos a la orden
  const [productSearchQuery, setProductSearchQuery] = useState<string>('');
  const [selectedProductToAdd, setSelectedProductToAdd] = useState<Product | null>(null);
  const [itemQuantityInput, setItemQuantityInput] = useState<string>('1');
  const [itemUnitCostInput, setItemUnitCostInput] = useState<string>('');

  // --------------------------------------------------------------------------
  // SUB-MODAL: NUEVO / EDITAR PROVEEDOR
  // --------------------------------------------------------------------------
  const [supplierFormModalVisible, setSupplierFormModalVisible] = useState<boolean>(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [formRuc, setFormRuc] = useState<string>('');
  const [formName, setFormName] = useState<string>('');
  const [formContactName, setFormContactName] = useState<string>('');
  const [formPhone, setFormPhone] = useState<string>('');
  const [formEmail, setFormEmail] = useState<string>('');
  const [formAddress, setFormAddress] = useState<string>('');
  const [formCategory, setFormCategory] = useState<string>('Mayorista');
  const [formPaymentTerms, setFormPaymentTerms] = useState<string>('Contado');
  const [formNotes, setFormNotes] = useState<string>('');
  const [isLookingUpRuc, setIsLookingUpRuc] = useState<boolean>(false);
  const [sunatStatusMessage, setSunatStatusMessage] = useState<string | null>(null);
  const [isSavingSupplier, setIsSavingSupplier] = useState<boolean>(false);

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
    if (!visible || !accountId) return;

    setOrdersLoading(true);
    const unsubscribeOrders = SuppliersPOService.subscribePurchaseOrders(
      accountId,
      (orders) => {
        setPurchaseOrders(orders);
        setOrdersLoading(false);
      }
    );

    setSuppliersLoading(true);
    const unsubscribeSuppliers = SuppliersPOService.subscribeSuppliers(
      accountId,
      (suppliersList) => {
        setSuppliers(suppliersList);
        setSuppliersLoading(false);
      }
    );

    return () => {
      unsubscribeOrders();
      unsubscribeSuppliers();
    };
  }, [visible, accountId]);

  // KPIs de órdenes de compra
  const orderStats = useMemo(() => {
    return calculatePurchaseOrderStats(purchaseOrders);
  }, [purchaseOrders]);

  // Filtrado de órdenes de compra
  const filteredOrders = useMemo(() => {
    return purchaseOrders.filter((order) => {
      const matchesStatus =
        orderStatusFilter === 'all'
          ? true
          : orderStatusFilter === 'pending'
          ? order.status === 'pending' || order.status === 'ordered'
          : order.status === orderStatusFilter;

      if (!matchesStatus) return false;

      if (!orderSearchQuery.trim()) return true;
      const query = orderSearchQuery.toLowerCase().trim();
      const numMatch = (order.orderNumber || '').toLowerCase().includes(query);
      const supMatch = (order.supplierName || '').toLowerCase().includes(query);
      const notesMatch = (order.notes || '').toLowerCase().includes(query);

      return numMatch || supMatch || notesMatch;
    });
  }, [purchaseOrders, orderStatusFilter, orderSearchQuery]);

  // Filtrado de proveedores
  const filteredSuppliers = useMemo(() => {
    if (!supplierSearchQuery.trim()) return suppliers;
    const query = supplierSearchQuery.toLowerCase().trim();
    return suppliers.filter((s) => {
      const nameMatch = (s.name || '').toLowerCase().includes(query);
      const rucMatch = (s.taxId || '').toLowerCase().includes(query);
      const contactMatch = (s.contactName || '').toLowerCase().includes(query);
      const catMatch = (s.category || '').toLowerCase().includes(query);
      const phoneMatch = (s.phone || '').toLowerCase().includes(query);
      return nameMatch || rucMatch || contactMatch || catMatch || phoneMatch;
    });
  }, [suppliers, supplierSearchQuery]);

  // Búsqueda de productos disponibles para agregar a una nueva orden
  const filteredProductsForOrder = useMemo(() => {
    if (!productSearchQuery.trim()) return [];
    const query = productSearchQuery.toLowerCase().trim();
    return products
      .filter((p) => {
        const nameMatch = (p.name || '').toLowerCase().includes(query);
        const skuMatch = (p.sku || '').toLowerCase().includes(query);
        const barcodeMatch = (p.barcode || '').toLowerCase().includes(query);
        return nameMatch || skuMatch || barcodeMatch;
      })
      .slice(0, 10);
  }, [products, productSearchQuery]);

  // --------------------------------------------------------------------------
  // ACCIÓN: RECIBIR MERCADERÍA EN ALMACÉN (KARDEX & CPP)
  // --------------------------------------------------------------------------
  const handleReceiveOrder = useCallback(
    async (order: PurchaseOrder) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      Alert.alert(
        'Recibir Mercadería en Almacén',
        `¿Deseas confirmar la recepción de la orden ${order.orderNumber} con ${order.items.length} productos?\n\n` +
          `• Se sumará el stock a los productos en esta sucursal.\n` +
          `• Se recalculará automáticamente el Costo Promedio Ponderado (CPP).\n` +
          `• Se registrará el movimiento de entrada en el Kardex oficial.`,
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Confirmar Recepción',
            style: 'default',
            onPress: async () => {
              setIsReceivingId(order.id);
              try {
                const result = await SuppliersPOService.receivePurchaseOrder(
                  order,
                  userProfile,
                  branchId
                );

                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

                let summaryMsg = `La orden ${order.orderNumber} ha sido ingresada al almacén y registrada en el Kardex.`;
                if (result.costChanges.length > 0) {
                  summaryMsg += `\n\nSe actualizaron los costos promedio ponderados de ${result.costChanges.length} producto(s).`;
                }

                Alert.alert('¡Recepción Exitosa!', summaryMsg, [
                  {
                    text: 'Aceptar',
                    onPress: () => {
                      onStockUpdated?.();
                    },
                  },
                ]);
              } catch (err: any) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                console.error('[SuppliersPurchaseModal] Error al recibir orden:', err);
                Alert.alert(
                  'Error en Recepción',
                  err?.message || 'No se pudo completar la recepción de la orden de compra.'
                );
              } finally {
                setIsReceivingId(null);
              }
            },
          },
        ]
      );
    },
    [userProfile, branchId, onStockUpdated]
  );

  // --------------------------------------------------------------------------
  // ACCIÓN: CANCELAR ORDEN DE COMPRA
  // --------------------------------------------------------------------------
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
  // MANEJO DE NUEVA ORDEN DE COMPRA
  // --------------------------------------------------------------------------
  const handleOpenCreateOrderModal = () => {
    setSelectedSupplier(suppliers.length > 0 ? suppliers[0] : null);
    setOrderItems([]);
    setOrderNotes('');
    setExpectedDateStr('');
    setProductSearchQuery('');
    setSelectedProductToAdd(null);
    setItemQuantityInput('1');
    setItemUnitCostInput('');
    setCreateOrderModalVisible(true);
  };

  const handleSelectProductForOrder = (product: Product) => {
    setSelectedProductToAdd(product);
    setProductSearchQuery(product.name);
    setItemQuantityInput('1');
    setItemUnitCostInput(product.costPrice ? String(product.costPrice) : '0');
  };

  const handleAddItemToOrder = () => {
    if (!selectedProductToAdd) {
      Alert.alert('Atención', 'Selecciona un producto del catálogo.');
      return;
    }

    const qty = parseFloat(itemQuantityInput);
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Cantidad inválida', 'Ingresa una cantidad mayor a 0.');
      return;
    }

    const unitCost = parseFloat(itemUnitCostInput);
    if (isNaN(unitCost) || unitCost < 0) {
      Alert.alert('Costo inválido', 'Ingresa un costo unitario válido.');
      return;
    }

    const subtotal = Math.round(qty * unitCost * 100) / 100;

    // Si ya existe el producto en la lista, actualizar cantidad o agregar
    const existingIndex = orderItems.findIndex((it) => it.productId === selectedProductToAdd.id);
    if (existingIndex >= 0) {
      const updated = [...orderItems];
      const newQty = updated[existingIndex].quantity + qty;
      const newSub = Math.round(newQty * unitCost * 100) / 100;
      updated[existingIndex] = {
        ...updated[existingIndex],
        quantity: newQty,
        unitCost,
        subtotal: newSub,
      };
      setOrderItems(updated);
    } else {
      const newItem: PurchaseOrderItem = {
        productId: selectedProductToAdd.id,
        productName: selectedProductToAdd.name,
        sku: selectedProductToAdd.sku || '',
        quantity: qty,
        unitCost,
        subtotal,
      };
      setOrderItems([...orderItems, newItem]);
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Limpiar selección de producto para el siguiente
    setSelectedProductToAdd(null);
    setProductSearchQuery('');
    setItemQuantityInput('1');
    setItemUnitCostInput('');
  };

  const handleRemoveItemFromOrder = (index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const updated = [...orderItems];
    updated.splice(index, 1);
    setOrderItems(updated);
  };

  const handleSavePurchaseOrder = async () => {
    if (!accountId) {
      Alert.alert('Error', 'No se ha detectado cuenta activa.');
      return;
    }

    if (!selectedSupplier) {
      Alert.alert('Proveedor requerido', 'Selecciona un proveedor para la orden de compra.');
      return;
    }

    if (orderItems.length === 0) {
      Alert.alert('Sin productos', 'Debes agregar al menos un producto a la orden de compra.');
      return;
    }

    setIsCreatingOrder(true);
    try {
      await SuppliersPOService.createPurchaseOrder({
        accountId,
        branchId,
        branchName: 'Principal',
        supplierId: selectedSupplier.id,
        supplierName: selectedSupplier.name,
        items: orderItems,
        status: 'pending',
        notes: orderNotes.trim() || undefined,
        expectedDate: expectedDateStr.trim() ? expectedDateStr.trim() : null,
        userProfile,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('¡Orden Creada!', 'La orden de compra ha sido registrada con estado PENDIENTE.');
      setCreateOrderModalVisible(false);
    } catch (err: any) {
      console.error('[SuppliersPurchaseModal] Error al crear orden:', err);
      Alert.alert('Error', err?.message || 'No se pudo guardar la orden de compra.');
    } finally {
      setIsCreatingOrder(false);
    }
  };

  // --------------------------------------------------------------------------
  // MANEJO DE NUEVO / EDITAR PROVEEDOR & CONSULTA SUNAT
  // --------------------------------------------------------------------------
  const handleOpenSupplierForm = (supplierToEdit?: Supplier) => {
    if (supplierToEdit) {
      setEditingSupplier(supplierToEdit);
      setFormRuc(supplierToEdit.taxId || '');
      setFormName(supplierToEdit.name || '');
      setFormContactName(supplierToEdit.contactName || '');
      setFormPhone(supplierToEdit.phone || '');
      setFormEmail(supplierToEdit.email || '');
      setFormAddress(supplierToEdit.address || '');
      setFormCategory(supplierToEdit.category || 'Mayorista');
      setFormPaymentTerms(supplierToEdit.paymentTerms || 'Contado');
      setFormNotes(supplierToEdit.notes || '');
      setSunatStatusMessage(null);
    } else {
      setEditingSupplier(null);
      setFormRuc('');
      setFormName('');
      setFormContactName('');
      setFormPhone('');
      setFormEmail('');
      setFormAddress('');
      setFormCategory('Mayorista');
      setFormPaymentTerms('Contado');
      setFormNotes('');
      setSunatStatusMessage(null);
    }
    setSupplierFormModalVisible(true);
  };

  /**
   * Consulta oficial de RUC SUNAT con autocompletado inteligente
   */
  const handleLookupSunat = async () => {
    const cleanRuc = formRuc.trim().replace(/\D/g, '');
    if (!cleanRuc || cleanRuc.length !== 11) {
      Alert.alert('RUC Inválido', 'El RUC debe constar de 11 dígitos numéricos.');
      return;
    }

    setIsLookingUpRuc(true);
    setSunatStatusMessage(null);

    try {
      const result: DocumentLookupResult = await lookupDocument('ruc', cleanRuc);

      if (result && result.name) {
        setFormName(result.name);
        if (result.address) {
          setFormAddress(result.address);
        }

        const conditionInfo = [result.estado, result.condicion].filter(Boolean).join(' - ');
        setSunatStatusMessage(conditionInfo || 'RUC Verificado');

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Alert.alert('SUNAT', 'No se encontraron datos para el RUC ingresado.');
      }
    } catch (err: any) {
      console.warn('[handleLookupSunat] Error en consulta RUC:', err);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Consulta SUNAT',
        err?.message || 'No se pudo obtener información del RUC en SUNAT. Puedes completarlo manualmente.'
      );
    } finally {
      setIsLookingUpRuc(false);
    }
  };

  const handleSaveSupplier = async () => {
    if (!accountId) {
      Alert.alert('Error', 'No hay cuenta de usuario activa.');
      return;
    }

    if (!formName.trim()) {
      Alert.alert('Campo Obligatorio', 'Ingresa la razón social o nombre del proveedor.');
      return;
    }

    setIsSavingSupplier(true);
    try {
      await SuppliersPOService.saveSupplier({
        id: editingSupplier?.id,
        accountId,
        name: formName.trim(),
        taxId: formRuc.trim(),
        contactName: formContactName.trim() || undefined,
        phone: formPhone.trim() || undefined,
        email: formEmail.trim() || undefined,
        address: formAddress.trim() || undefined,
        category: formCategory.trim() || 'General',
        paymentTerms: formPaymentTerms.trim() || 'Contado',
        notes: formNotes.trim() || undefined,
        active: true,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        '¡Proveedor Guardado!',
        editingSupplier ? 'Los datos han sido actualizados.' : 'El proveedor fue registrado exitosamente.'
      );
      setSupplierFormModalVisible(false);
    } catch (err: any) {
      console.error('[handleSaveSupplier] Error al guardar proveedor:', err);
      Alert.alert('Error', err?.message || 'No se pudo guardar el proveedor.');
    } finally {
      setIsSavingSupplier(false);
    }
  };

  const handleDeleteSupplier = (supplier: Supplier) => {
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
  };

  // --------------------------------------------------------------------------
  // ATAJOS DE CONTACTO (LLAMADA, WHATSAPP, EMAIL)
  // --------------------------------------------------------------------------
  const handleCallSupplier = (phone?: string) => {
    if (!phone) return;
    const clean = phone.replace(/[^\d+]/g, '');
    Linking.openURL(`tel:${clean}`).catch(() => {
      Alert.alert('Aviso', 'No se pudo abrir la aplicación de llamadas telefónicas.');
    });
  };

  const handleWhatsAppSupplier = (phone?: string, supplierName?: string) => {
    if (!phone) return;
    const clean = phone.replace(/\D/g, '');
    const numWithCountry = clean.length === 9 ? `51${clean}` : clean;
    const msg = encodeURIComponent(
      `Hola ${supplierName || ''}, me comunico desde Ventify respecto a una orden de compra.`
    );
    Linking.openURL(`https://wa.me/${numWithCountry}?text=${msg}`).catch(() => {
      Alert.alert('Aviso', 'No se pudo abrir WhatsApp.');
    });
  };

  const handleEmailSupplier = (email?: string, supplierName?: string) => {
    if (!email) return;
    const subject = encodeURIComponent(`Consulta de Compra - ${supplierName || ''}`);
    Linking.openURL(`mailto:${email}?subject=${subject}`).catch(() => {
      Alert.alert('Aviso', 'No se pudo abrir la aplicación de correo electrónico.');
    });
  };

  // Total acumulado en la creación de orden
  const createOrderTotal = useMemo(() => {
    return orderItems.reduce((acc, it) => acc + it.subtotal, 0);
  }, [orderItems]);

  // ==========================================================================
  // RENDER: PESTAÑA 1 - ÓRDENES DE COMPRA
  // ==========================================================================
  const renderOrdersTab = () => {
    return (
      <View style={styles.tabContentContainer}>
        <View style={styles.sectionIntro}>
          <SectionHeading title="Órdenes de compra" subtitle="Abastecimiento y seguimiento de recepción." />
        </View>

        {/* RESUMEN DE ABASTECIMIENTO */}
        <View style={styles.kpiContainer}>
          <View style={[styles.kpiCard, { borderColor: ui.warningSoft, backgroundColor: ui.warningSoft }]}>
            <View style={styles.kpiHeaderRow}>
              <Clock size={16} color={ui.warning} />
              <Text style={[styles.kpiLabel, { color: ui.warning }]}>Pendientes</Text>
            </View>
            <Text style={[styles.kpiValue, { color: ui.warning }]}>{orderStats.pendingCount}</Text>
            <Text style={[styles.kpiSub, { color: ui.warning }]}>
              {formatPEN(orderStats.totalPendingAmount)}
            </Text>
          </View>

          <View style={[styles.kpiCard, { borderColor: ui.success, backgroundColor: ui.successSoft }]}>
            <View style={styles.kpiHeaderRow}>
              <CheckCircle2 size={16} color={ui.primary} />
              <Text style={[styles.kpiLabel, { color: ui.success }]}>Recibidas</Text>
            </View>
            <Text style={[styles.kpiValue, { color: ui.success }]}>{orderStats.receivedCount}</Text>
            <Text style={[styles.kpiSub, { color: ui.success }]}>
              {formatPEN(orderStats.totalInvested)}
            </Text>
          </View>

          <View style={[styles.kpiCard, { borderColor: ui.border, backgroundColor: ui.background }]}>
            <View style={styles.kpiHeaderRow}>
              <Boxes size={16} color={ui.textSecondary} />
              <Text style={[styles.kpiLabel, { color: ui.textSecondary }]}>Total Órdenes</Text>
            </View>
            <Text style={[styles.kpiValue, { color: ui.text }]}>{orderStats.totalOrders}</Text>
            <Text style={[styles.kpiSub, { color: ui.textSecondary }]}>Histórico</Text>
          </View>
        </View>

        {/* ACCIÓN PRINCIPAL & FILTROS */}
        <View style={styles.actionsBar}>
          <TouchableOpacity
            style={styles.newOrderButton}
            onPress={handleOpenCreateOrderModal}
            activeOpacity={0.8}
          >
            <Plus size={18} color={ui.surface} />
            <Text style={styles.newOrderButtonText}>Nueva Orden de Compra</Text>
          </TouchableOpacity>
        </View>

        {/* BUSCADOR */}
        <View style={styles.searchBarContainer}>
          <Search size={18} color={ui.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Buscar por N° orden (PO-0001) o proveedor..."
            placeholderTextColor={ui.textMuted}
            value={orderSearchQuery}
            onChangeText={setOrderSearchQuery}
            clearButtonMode="while-editing"
          />
        </View>

        {/* CHIPS DE FILTRO DE ESTADO */}
        <View style={styles.filterChipsRow}>
          {[
            { id: 'all', label: 'Todas' },
            { id: 'pending', label: 'Pendientes' },
            { id: 'received', label: 'Recibidas' },
            { id: 'cancelled', label: 'Canceladas' },
          ].map((chip) => {
            const isSelected = orderStatusFilter === chip.id;
            return (
              <TouchableOpacity
                key={chip.id}
                style={[styles.filterChip, isSelected && styles.filterChipActive]}
                onPress={() => setOrderStatusFilter(chip.id)}
              >
                <Text style={[styles.filterChipText, isSelected && styles.filterChipTextActive]}>
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {!ordersLoading && filteredOrders.length > 0 ? (
          <View style={styles.listSectionIntro}>
            <SectionHeading title="Órdenes" subtitle={`${filteredOrders.length} ${filteredOrders.length === 1 ? 'resultado' : 'resultados'}`} />
          </View>
        ) : null}

        {/* LISTADO DE ÓRDENES */}
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
          <FlatList
            data={filteredOrders}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item: order }) => {
              const isExpanded = expandedOrderId === order.id;
              const isPending = order.status === 'pending' || order.status === 'ordered';
              const isReceived = order.status === 'received';
              const isCancelled = order.status === 'cancelled';
              const isReceiving = isReceivingId === order.id;

              return (
                <View style={styles.orderCard}>
                  {/* CABECERA DE LA ORDEN */}
                  <View style={styles.orderCardHeader}>
                    <View style={styles.orderNumberRow}>
                      <Text style={styles.orderNumberText}>{order.orderNumber}</Text>
                      <View
                        style={[
                          styles.statusBadge,
                          isPending && styles.statusBadgePending,
                          isReceived && styles.statusBadgeReceived,
                          isCancelled && styles.statusBadgeCancelled,
                        ]}
                      >
                        <Text
                          style={[
                            styles.statusBadgeText,
                            isPending && styles.statusBadgeTextPending,
                            isReceived && styles.statusBadgeTextReceived,
                            isCancelled && styles.statusBadgeTextCancelled,
                          ]}
                        >
                          {isPending
                            ? 'PENDIENTE'
                            : isReceived
                            ? 'RECIBIDA EN ALMACÉN'
                            : 'CANCELADA'}
                        </Text>
                      </View>
                    </View>

                    <Text style={styles.orderDateText}>{formatDatePE(order.createdAt)}</Text>
                  </View>

                  {/* DATOS DEL PROVEEDOR Y SUCURSAL */}
                  <View style={styles.orderSupplierRow}>
                    <Truck size={16} color={ui.primary} />
                    <Text style={styles.orderSupplierName}>{order.supplierName}</Text>
                  </View>

                  <View style={styles.orderInfoRow}>
                    <Text style={styles.orderItemsCount}>
                      {order.items.length} {order.items.length === 1 ? 'producto' : 'productos'}
                    </Text>
                    <Text style={styles.orderTotalText}>{formatPEN(order.totalCost)}</Text>
                  </View>

                  {/* NOTAS DE LA ORDEN */}
                  {Boolean(order.notes) && (
                    <Text style={styles.orderNotesText} numberOfLines={2}>
                      Nota: {order.notes}
                    </Text>
                  )}

                  {/* DETALLE EXPANDIBLE DE PRODUCTOS */}
                  <TouchableOpacity
                    style={styles.expandToggleRow}
                    onPress={() => setExpandedOrderId(isExpanded ? null : order.id)}
                  >
                    <Text style={styles.expandToggleText}>
                      {isExpanded ? 'Ocultar productos' : 'Ver productos en la orden'}
                    </Text>
                    {isExpanded ? (
                      <ChevronUp size={16} color={ui.textSecondary} />
                    ) : (
                      <ChevronDown size={16} color={ui.textSecondary} />
                    )}
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={styles.expandedItemsContainer}>
                      {order.items.map((it, idx) => (
                        <View key={`${it.productId}-${idx}`} style={styles.expandedItemRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.expandedItemName}>{it.productName}</Text>
                            <Text style={styles.expandedItemSku}>
                              {it.quantity} un. x {formatPEN(it.unitCost)}
                            </Text>
                          </View>
                          <Text style={styles.expandedItemSubtotal}>{formatPEN(it.subtotal)}</Text>
                        </View>
                      ))}

                      {isReceived && order.receivedByName && (
                        <View style={styles.auditReceivedRow}>
                          <CheckCircle2 size={14} color={ui.primary} />
                          <Text style={styles.auditReceivedText}>
                            Recibido por {order.receivedByName} el{' '}
                            {formatDatePE(order.receivedAt || order.receivedDate)}
                          </Text>
                        </View>
                      )}
                    </View>
                  )}

                  {/* ACCIONES DE LA TARJETA */}
                  {isPending && (
                    <View style={styles.orderActionsRow}>
                      <TouchableOpacity
                        style={[styles.receiveButton, isReceiving && styles.btnDisabled]}
                        onPress={() => handleReceiveOrder(order)}
                        disabled={isReceiving}
                      >
                        {isReceiving ? (
                          <ActivityIndicator size="small" color={ui.surface} />
                        ) : (
                          <>
                            <ArrowDownLeft size={16} color={ui.surface} />
                            <Text style={styles.receiveButtonText}>Recibir Mercadería</Text>
                          </>
                        )}
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.cancelOrderButton}
                        onPress={() => handleCancelOrder(order)}
                        disabled={isReceiving}
                      >
                        <Ban size={15} color={ui.danger} />
                        <Text style={styles.cancelOrderButtonText}>Cancelar</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            }}
          />
        )}
      </View>
    );
  };

  // ==========================================================================
  // RENDER: PESTAÑA 2 - DIRECTORIO DE PROVEEDORES
  // ==========================================================================
  const renderSuppliersTab = () => {
    return (
      <View style={styles.tabContentContainer}>
        <View style={styles.sectionIntro}>
          <SectionHeading title="Directorio de proveedores" subtitle="Contactos y condiciones comerciales." />
        </View>
        {/* BARRA DE ACCIÓN: NUEVO PROVEEDOR */}
        <View style={styles.actionsBar}>
          <TouchableOpacity
            style={styles.newSupplierButton}
            onPress={() => handleOpenSupplierForm()}
            activeOpacity={0.8}
          >
            <Plus size={18} color={ui.surface} />
            <Text style={styles.newSupplierButtonText}>Nuevo Proveedor</Text>
          </TouchableOpacity>
        </View>

        {/* BUSCADOR DE PROVEEDORES */}
        <View style={styles.searchBarContainer}>
          <Search size={18} color={ui.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Buscar por RUC, nombre, contacto o categoría..."
            placeholderTextColor={ui.textMuted}
            value={supplierSearchQuery}
            onChangeText={setSupplierSearchQuery}
            clearButtonMode="while-editing"
          />
        </View>

        {!suppliersLoading && filteredSuppliers.length > 0 ? (
          <View style={styles.listSectionIntro}>
            <SectionHeading title="Proveedores" subtitle={`${filteredSuppliers.length} registrados`} />
          </View>
        ) : null}

        {/* LISTADO DE PROVEEDORES */}
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
          <FlatList
            data={filteredSuppliers}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item: supplier }) => {
              const hasPhone = Boolean(supplier.phone?.trim());
              const hasEmail = Boolean(supplier.email?.trim());

              return (
                <View style={styles.supplierCard}>
                  {/* CABECERA DEL PROVEEDOR */}
                  <View style={styles.supplierCardHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.supplierNameText}>{supplier.name}</Text>
                      <View style={styles.supplierBadgesRow}>
                        {Boolean(supplier.taxId) && (
                          <View style={styles.taxIdBadge}>
                            <Text style={styles.taxIdBadgeText}>RUC: {supplier.taxId}</Text>
                          </View>
                        )}
                        <View style={styles.categoryBadge}>
                          <Text style={styles.categoryBadgeText}>
                            {supplier.category || 'General'}
                          </Text>
                        </View>
                      </View>
                    </View>

                    <View style={styles.supplierHeaderActions}>
                      <TouchableOpacity
                        style={styles.supplierActionIconBtn}
                        onPress={() => handleOpenSupplierForm(supplier)}
                      >
                        <Edit2 size={16} color={ui.primary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.supplierActionIconBtn, { backgroundColor: ui.dangerSoft }]}
                        onPress={() => handleDeleteSupplier(supplier)}
                      >
                        <Trash2 size={16} color={ui.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* INFORMACIÓN DE CONTACTO */}
                  {Boolean(supplier.contactName) && (
                    <View style={styles.supplierDetailRow}>
                      <User size={15} color={ui.textSecondary} />
                      <Text style={styles.supplierDetailText}>
                        Contacto: <Text style={{ fontWeight: '600' }}>{supplier.contactName}</Text>
                      </Text>
                    </View>
                  )}

                  {Boolean(supplier.address) && (
                    <View style={styles.supplierDetailRow}>
                      <MapPin size={15} color={ui.textSecondary} />
                      <Text style={styles.supplierDetailText} numberOfLines={2}>
                        {supplier.address}
                      </Text>
                    </View>
                  )}

                  {Boolean(supplier.paymentTerms) && (
                    <View style={styles.supplierDetailRow}>
                      <CreditCard size={15} color={ui.textSecondary} />
                      <Text style={styles.supplierDetailText}>
                        Condiciones: {supplier.paymentTerms}
                      </Text>
                    </View>
                  )}

                  {Boolean(supplier.notes) && (
                    <Text style={styles.supplierNotesText} numberOfLines={2}>
                      Nota: {supplier.notes}
                    </Text>
                  )}

                  {/* BOTONES DE ACCIÓN RÁPIDA (LLAMADA, WHATSAPP, EMAIL) */}
                  <View style={styles.quickContactRow}>
                    {hasPhone ? (
                      <>
                        <TouchableOpacity
                          style={styles.contactCallBtn}
                          onPress={() => handleCallSupplier(supplier.phone)}
                        >
                          <Phone size={15} color={ui.primary} />
                          <Text style={styles.contactCallBtnText}>Llamar</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.contactWhatsAppBtn}
                          onPress={() => handleWhatsAppSupplier(supplier.phone, supplier.name)}
                        >
                          <MessageCircle size={15} color={ui.surface} />
                          <Text style={styles.contactWhatsAppBtnText}>WhatsApp</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <Text style={styles.noPhoneText}>Sin teléfono registrado</Text>
                    )}

                    {hasEmail && (
                      <TouchableOpacity
                        style={styles.contactEmailBtn}
                        onPress={() => handleEmailSupplier(supplier.email, supplier.name)}
                      >
                        <Mail size={15} color={ui.primary} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>
    );
  };

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
          <TouchableOpacity style={styles.closeButton} onPress={onClose} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Cerrar compras y proveedores">
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
          {activeTab === 'orders' ? renderOrdersTab() : renderSuppliersTab()}
        </View>

        {/* ================================================================== */}
        {/* SUB-MODAL 1: CREAR NUEVA ORDEN DE COMPRA                           */}
        {/* ================================================================== */}
        <Modal
          visible={createOrderModalVisible}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setCreateOrderModalVisible(false)}
        >
          <KeyboardAvoidingView
            style={styles.modalOverlay}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={[styles.modalSheetContainer, { paddingBottom: Math.max(12, insets.bottom) }]}>
              {/* Header Submodal */}
              <View style={styles.subModalHeader}>
                <View>
                  <Text style={styles.subModalTitle}>Nueva Orden de Compra</Text>
                  <Text style={styles.subModalSubtitle}>
                    Abastecimiento de mercadería para Almacén
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.closeSubModalBtn}
                  onPress={() => setCreateOrderModalVisible(false)}
                >
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.subModalBody} keyboardShouldPersistTaps="handled">
                {/* 1. SELECCIÓN DE PROVEEDOR */}
                <Text style={styles.formSectionLabel}>Proveedor de la orden *</Text>
                {suppliers.length === 0 ? (
                  <View style={styles.noSuppliersWarningCard}>
                    <AlertCircle size={18} color={ui.warning} />
                    <Text style={styles.noSuppliersWarningText}>
                      No tienes proveedores registrados. Crea un proveedor primero.
                    </Text>
                    <TouchableOpacity
                      style={styles.createSupplierShortcut}
                      onPress={() => {
                        setCreateOrderModalVisible(false);
                        handleOpenSupplierForm();
                      }}
                    >
                      <Text style={styles.createSupplierShortcutText}>+ Registrar Proveedor</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.supplierSelectorBox}
                    onPress={() => setSupplierPickerVisible(!supplierPickerVisible)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.supplierSelectorLabel}>Proveedor:</Text>
                      <Text style={styles.supplierSelectorValue}>
                        {selectedSupplier ? selectedSupplier.name : 'Selecciona un proveedor...'}
                      </Text>
                      {Boolean(selectedSupplier?.taxId) && (
                        <Text style={styles.supplierSelectorRuc}>RUC: {selectedSupplier?.taxId}</Text>
                      )}
                    </View>
                    <ChevronDown size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                )}

                {/* Desplegable de selección de proveedores */}
                {supplierPickerVisible && (
                  <View style={styles.supplierDropdownList}>
                    {suppliers.map((sup) => (
                      <TouchableOpacity
                        key={sup.id}
                        style={[
                          styles.supplierDropdownItem,
                          selectedSupplier?.id === sup.id && styles.supplierDropdownItemActive,
                        ]}
                        onPress={() => {
                          setSelectedSupplier(sup);
                          setSupplierPickerVisible(false);
                        }}
                      >
                        <Text style={styles.supplierDropdownItemName}>{sup.name}</Text>
                        <Text style={styles.supplierDropdownItemRuc}>
                          {sup.taxId ? `RUC: ${sup.taxId}` : 'Sin RUC'} • {sup.category || 'General'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* AGREGAR PRODUCTOS DEL CATÁLOGO */}
                <Text style={[styles.formSectionLabel, { marginTop: 18 }]}>
                  Productos del catálogo *
                </Text>

                <View style={styles.productSearchBox}>
                  <Search size={16} color={ui.textMuted} />
                  <TextInput
                    style={styles.productSearchInput}
                    placeholder="Escribe el nombre o código del producto..."
                    placeholderTextColor={ui.textMuted}
                    value={productSearchQuery}
                    onChangeText={setProductSearchQuery}
                  />
                </View>

                {/* Sugerencias de búsqueda */}
                {filteredProductsForOrder.length > 0 && !selectedProductToAdd && (
                  <View style={styles.productSuggestionsList}>
                    {filteredProductsForOrder.map((prod) => {
                      const stockInBranch = getProductStock(prod, branchId);
                      return (
                        <TouchableOpacity
                          key={prod.id}
                          style={styles.productSuggestionItem}
                          onPress={() => handleSelectProductForOrder(prod)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.productSuggestionName}>{prod.name}</Text>
                            <Text style={styles.productSuggestionMeta}>
                              SKU: {prod.sku || 'N/A'} • Stock actual: {stockInBranch} • Costo:{' '}
                              {formatPEN(prod.costPrice || 0)}
                            </Text>
                          </View>
                          <Plus size={16} color={ui.primary} />
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* Si se seleccionó un producto, configurar cantidad y costo unitario */}
                {selectedProductToAdd && (
                  <View style={styles.selectedProductConfigCard}>
                    <Text style={styles.selectedProductConfigTitle}>
                      {selectedProductToAdd.name}
                    </Text>
                    <Text style={styles.selectedProductConfigSku}>
                      SKU: {selectedProductToAdd.sku || 'N/A'}
                    </Text>

                    <View style={styles.qtyCostRow}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.inputMiniLabel}>Cantidad a pedir</Text>
                        <TextInput
                          style={styles.inputMini}
                          keyboardType="numeric"
                          value={itemQuantityInput}
                          onChangeText={setItemQuantityInput}
                        />
                      </View>

                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={styles.inputMiniLabel}>Costo Unitario (S/)</Text>
                        <TextInput
                          style={styles.inputMini}
                          keyboardType="numeric"
                          value={itemUnitCostInput}
                          onChangeText={setItemUnitCostInput}
                        />
                      </View>
                    </View>

                    <View style={styles.subtotalAddRow}>
                      <Text style={styles.subtotalAddText}>
                        Subtotal:{' '}
                        <Text style={{ fontWeight: '700', color: ui.text }}>
                          {formatPEN(
                            (parseFloat(itemQuantityInput) || 0) *
                              (parseFloat(itemUnitCostInput) || 0)
                          )}
                        </Text>
                      </Text>

                      <TouchableOpacity
                        style={styles.addProductBtn}
                        onPress={handleAddItemToOrder}
                      >
                        <Plus size={16} color={ui.surface} />
                        <Text style={styles.addProductBtnText}>Agregar a la Orden</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {/* LISTA DE ÍTEMS EN LA ORDEN */}
                <Text style={[styles.formSectionLabel, { marginTop: 18 }]}>
                  Productos en la Orden ({orderItems.length})
                </Text>

                {orderItems.length === 0 ? (
                  <View style={styles.emptyItemsBox}>
                    <Package size={28} color={ui.border} />
                    <Text style={styles.emptyItemsText}>Aún no has agregado ningún producto.</Text>
                  </View>
                ) : (
                  <View style={styles.orderItemsList}>
                    {orderItems.map((it, idx) => (
                      <View key={`${it.productId}-${idx}`} style={styles.orderItemRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.orderItemName}>{it.productName}</Text>
                          <Text style={styles.orderItemDetails}>
                            {it.quantity} un. x {formatPEN(it.unitCost)}
                          </Text>
                        </View>
                        <Text style={styles.orderItemTotal}>{formatPEN(it.subtotal)}</Text>
                        <TouchableOpacity
                          style={styles.deleteItemBtn}
                          onPress={() => handleRemoveItemFromOrder(idx)}
                        >
                          <Trash2 size={16} color={ui.danger} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}

                {/* CAMPOS ADICIONALES (NOTAS, FECHA ESPERADA) */}
                <Text style={[styles.formSectionLabel, { marginTop: 18 }]}>
                  Información adicional (opcional)
                </Text>

                <Text style={styles.inputLabel}>Fecha Estimada de Entrega</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Ej: 15/12/2026 o Mañana en la tarde"
                  placeholderTextColor={ui.textMuted}
                  value={expectedDateStr}
                  onChangeText={setExpectedDateStr}
                />

                <Text style={styles.inputLabel}>Notas u Observaciones</Text>
                <TextInput
                  style={[styles.textInput, { height: 70, textAlignVertical: 'top' }]}
                  placeholder="Instrucciones de despacho, número de cotización..."
                  placeholderTextColor={ui.textMuted}
                  multiline
                  numberOfLines={3}
                  value={orderNotes}
                  onChangeText={setOrderNotes}
                />

                <View style={{ height: 30 }} />
              </ScrollView>

              {/* FOOTER DEL SUBMODAL CON TOTAL Y BOTÓN DE GUARDAR */}
              <View style={styles.subModalFooter}>
                <View style={styles.footerTotalBox}>
                  <Text style={styles.footerTotalLabel}>Total a Pagar:</Text>
                  <Text style={styles.footerTotalAmount}>{formatPEN(createOrderTotal)}</Text>
                </View>

                <TouchableOpacity
                  style={[
                    styles.saveOrderButton,
                    (isCreatingOrder || orderItems.length === 0 || !selectedSupplier) &&
                      styles.btnDisabled,
                  ]}
                  onPress={handleSavePurchaseOrder}
                  disabled={isCreatingOrder || orderItems.length === 0 || !selectedSupplier}
                >
                  {isCreatingOrder ? (
                    <ActivityIndicator size="small" color={ui.surface} />
                  ) : (
                    <>
                      <Check size={18} color={ui.surface} />
                      <Text style={styles.saveOrderButtonText}>Guardar Orden</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* ================================================================== */}
        {/* SUB-MODAL 2: NUEVO / EDITAR PROVEEDOR CON SUNAT AUTOCOMPLETE        */}
        {/* ================================================================== */}
        <Modal
          visible={supplierFormModalVisible}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setSupplierFormModalVisible(false)}
        >
          <KeyboardAvoidingView
            style={styles.modalOverlay}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={[styles.modalSheetContainer, { paddingBottom: Math.max(12, insets.bottom) }]}>
              <View style={styles.subModalHeader}>
                <View>
                  <Text style={styles.subModalTitle}>
                    {editingSupplier ? 'Editar Proveedor' : 'Nuevo Proveedor'}
                  </Text>
                  <Text style={styles.subModalSubtitle}>
                    Directorio comercial y datos de facturación
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.closeSubModalBtn}
                  onPress={() => setSupplierFormModalVisible(false)}
                >
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.subModalBody} keyboardShouldPersistTaps="handled">
                <Text style={[styles.formSectionLabel, { marginTop: 2 }]}>Identificación fiscal</Text>
                {/* CAMPO RUC CON CONSULTA SUNAT */}
                <Text style={styles.inputLabel}>RUC (11 dígitos) *</Text>
                <View style={styles.rucInputRow}>
                  <TextInput
                    style={[styles.textInput, { flex: 1, marginBottom: 0 }]}
                    placeholder="20XXXXXXXXX"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    maxLength={11}
                    value={formRuc}
                    onChangeText={setFormRuc}
                  />
                  <TouchableOpacity
                    style={[styles.sunatLookupBtn, isLookingUpRuc && styles.btnDisabled]}
                    onPress={handleLookupSunat}
                    disabled={isLookingUpRuc}
                  >
                    {isLookingUpRuc ? (
                      <ActivityIndicator size="small" color={ui.surface} />
                    ) : (
                      <>
                        <Search size={15} color={ui.surface} />
                        <Text style={styles.sunatLookupBtnText}>SUNAT</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {sunatStatusMessage && (
                  <View style={styles.sunatStatusBadge}>
                    <CheckCircle2 size={14} color={ui.primary} />
                    <Text style={styles.sunatStatusBadgeText}>{sunatStatusMessage}</Text>
                  </View>
                )}

                {/* RAZÓN SOCIAL / NOMBRE */}
                <Text style={styles.inputLabel}>Razón Social / Nombre Comercial *</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Nombre de la empresa o distribuidora"
                  placeholderTextColor={ui.textMuted}
                  value={formName}
                  onChangeText={setFormName}
                />

                <Text style={[styles.formSectionLabel, { marginTop: 10 }]}>Contacto</Text>
                {/* CONTACTO */}
                <Text style={styles.inputLabel}>Persona de Contacto</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Nombre del asesor de ventas / contacto"
                  placeholderTextColor={ui.textMuted}
                  value={formContactName}
                  onChangeText={setFormContactName}
                />

                {/* TELÉFONO / CELULAR */}
                <Text style={styles.inputLabel}>Teléfono / WhatsApp</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="9XXXXXXXX o teléfono fijo"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="phone-pad"
                  value={formPhone}
                  onChangeText={setFormPhone}
                />

                {/* EMAIL */}
                <Text style={styles.inputLabel}>Correo Electrónico</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="ventas@proveedor.pe"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  value={formEmail}
                  onChangeText={setFormEmail}
                />

                {/* DIRECCIÓN */}
                <Text style={styles.inputLabel}>Dirección Fiscal / Almacén</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="Av. Principal 123, Lima..."
                  placeholderTextColor={ui.textMuted}
                  value={formAddress}
                  onChangeText={setFormAddress}
                />

                <Text style={[styles.formSectionLabel, { marginTop: 10 }]}>Condiciones comerciales</Text>
                {/* CATEGORÍA */}
                <Text style={styles.inputLabel}>Categoría</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoriesRow}>
                  {SUPPLIER_CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[
                        styles.catOptionChip,
                        formCategory === cat && styles.catOptionChipActive,
                      ]}
                      onPress={() => setFormCategory(cat)}
                    >
                      <Text
                        style={[
                          styles.catOptionChipText,
                          formCategory === cat && styles.catOptionChipTextActive,
                        ]}
                      >
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* CONDICIONES DE PAGO */}
                <Text style={styles.inputLabel}>Condiciones de Pago</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoriesRow}>
                  {PAYMENT_TERMS_OPTIONS.map((term) => (
                    <TouchableOpacity
                      key={term}
                      style={[
                        styles.catOptionChip,
                        formPaymentTerms === term && styles.catOptionChipActive,
                      ]}
                      onPress={() => setFormPaymentTerms(term)}
                    >
                      <Text
                        style={[
                          styles.catOptionChipText,
                          formPaymentTerms === term && styles.catOptionChipTextActive,
                        ]}
                      >
                        {term}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* NOTAS */}
                <Text style={styles.inputLabel}>Notas / Datos Bancarios</Text>
                <TextInput
                  style={[styles.textInput, { height: 65, textAlignVertical: 'top' }]}
                  placeholder="Banco, número de cuenta CCI, días de visita..."
                  placeholderTextColor={ui.textMuted}
                  multiline
                  numberOfLines={3}
                  value={formNotes}
                  onChangeText={setFormNotes}
                />

                <View style={{ height: 25 }} />
              </ScrollView>

              <View style={styles.subModalFooter}>
                <TouchableOpacity
                  style={styles.subModalCancelBtn}
                  onPress={() => setSupplierFormModalVisible(false)}
                >
                  <Text style={styles.subModalCancelBtnText}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.saveSupplierSubmitBtn, isSavingSupplier && styles.btnDisabled]}
                  onPress={handleSaveSupplier}
                  disabled={isSavingSupplier}
                >
                  {isSavingSupplier ? (
                    <ActivityIndicator size="small" color={ui.surface} />
                  ) : (
                    <>
                      <Check size={18} color={ui.surface} />
                      <Text style={styles.saveSupplierSubmitBtnText}>
                        {editingSupplier ? 'Actualizar' : 'Guardar Proveedor'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
};

// ============================================================================
// ESTILOS NATIVOS
// ============================================================================

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: ui.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
    minWidth: 0,
  },
  headerIconWrapper: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: ui.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 1,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsBar: {
    flexDirection: 'row',
    backgroundColor: ui.surface,
    paddingHorizontal: 20,
    paddingTop: 4,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 52,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabButtonActive: {
    borderBottomColor: ui.primary,
  },
  tabButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  tabButtonTextActive: {
    color: ui.text,
    fontWeight: '700',
  },
  tabContentContainer: {
    flex: 1,
    backgroundColor: ui.background,
  },
  sectionIntro: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 2,
  },
  listSectionIntro: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 2,
  },
  // KPIs
  kpiContainer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  kpiCard: {
    flex: 1,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  kpiHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  kpiValue: {
    fontSize: 18,
    fontWeight: '800',
    marginTop: 4,
  },
  kpiSub: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  actionsBar: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  newOrderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: ui.primary,
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: 12,
  },
  newOrderButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.surface,
  },
  newSupplierButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: ui.primary,
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: 12,
  },
  newSupplierButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.surface,
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 9,
    fontSize: 13,
    color: ui.text,
  },
  filterChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 20,
    gap: 8,
    marginBottom: 8,
  },
  filterChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  filterChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  filterChipTextActive: {
    color: ui.primary,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 12,
  },
  // Tarjetas de Órdenes
  orderCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  orderCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  orderNumberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  orderNumberText: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  orderDateText: {
    fontSize: 12,
    color: ui.textMuted,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusBadgePending: {
    backgroundColor: ui.warningSoft,
  },
  statusBadgeReceived: {
    backgroundColor: ui.successSoft,
  },
  statusBadgeCancelled: {
    backgroundColor: ui.dangerSoft,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusBadgeTextPending: {
    color: ui.warning,
  },
  statusBadgeTextReceived: {
    color: ui.success,
  },
  statusBadgeTextCancelled: {
    color: ui.danger,
  },
  orderSupplierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  orderSupplierName: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  orderInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: ui.surfaceMuted,
  },
  orderItemsCount: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  orderTotalText: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  orderNotesText: {
    fontSize: 12,
    color: ui.textSecondary,
    fontStyle: 'italic',
    marginTop: 6,
  },
  expandToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    marginTop: 4,
  },
  expandToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  expandedItemsContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderColor: ui.surfaceMuted,
    gap: 6,
  },
  expandedItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  expandedItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  expandedItemSku: {
    fontSize: 11,
    color: ui.textMuted,
  },
  expandedItemSubtotal: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  auditReceivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderColor: ui.border,
  },
  auditReceivedText: {
    fontSize: 11,
    color: ui.primary,
    fontWeight: '500',
  },
  orderActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: ui.surfaceMuted,
  },
  receiveButton: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primary,
    paddingVertical: 10,
    borderRadius: 8,
  },
  receiveButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.surface,
  },
  cancelOrderButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: ui.dangerSoft,
    paddingVertical: 10,
    borderRadius: 8,
  },
  cancelOrderButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.danger,
  },
  // Tarjetas de Proveedor
  supplierCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  supplierCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  supplierNameText: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  supplierBadgesRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  taxIdBadge: {
    backgroundColor: ui.surfaceMuted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  taxIdBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  categoryBadge: {
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  categoryBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.primary,
  },
  supplierHeaderActions: {
    flexDirection: 'row',
    gap: 6,
  },
  supplierActionIconBtn: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  supplierDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  supplierDetailText: {
    fontSize: 12,
    color: ui.textSecondary,
    flex: 1,
  },
  supplierNotesText: {
    fontSize: 11,
    color: ui.textSecondary,
    fontStyle: 'italic',
    marginTop: 6,
  },
  quickContactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: ui.surfaceMuted,
  },
  contactCallBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.successSoft,
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 8,
  },
  contactCallBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  contactWhatsAppBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primary,
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 8,
  },
  contactWhatsAppBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.surface,
  },
  contactEmailBtn: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noPhoneText: {
    fontSize: 12,
    color: ui.textMuted,
    fontStyle: 'italic',
    flex: 1,
  },
  // Estados vacíos y carga
  centerContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 10,
  },
  emptyContainer: {
    padding: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
    marginTop: 12,
  },
  emptySubtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 18,
  },
  emptyActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: ui.successSoft,
    borderWidth: 1,
    borderColor: ui.success,
  },
  emptyActionButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.primary,
  },
  // Submodales
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheetContainer: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
  },
  subModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  subModalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  subModalSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 1,
  },
  closeSubModalBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subModalBody: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  formSectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 8,
  },
  supplierSelectorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
  },
  supplierSelectorLabel: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  supplierSelectorValue: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
    marginTop: 2,
  },
  supplierSelectorRuc: {
    fontSize: 12,
    color: ui.primary,
    fontWeight: '500',
    marginTop: 1,
  },
  supplierDropdownList: {
    marginTop: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    maxHeight: 180,
  },
  supplierDropdownItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  supplierDropdownItemActive: {
    backgroundColor: ui.successSoft,
  },
  supplierDropdownItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  supplierDropdownItemRuc: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  noSuppliersWarningCard: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: ui.warningSoft,
    borderWidth: 1,
    borderColor: ui.warningSoft,
    alignItems: 'center',
    gap: 6,
  },
  noSuppliersWarningText: {
    fontSize: 12,
    color: ui.warning,
    textAlign: 'center',
  },
  createSupplierShortcut: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: ui.warning,
  },
  createSupplierShortcutText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.surface,
  },
  productSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    gap: 8,
  },
  productSearchInput: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 13,
    color: ui.text,
  },
  productSuggestionsList: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    marginTop: 4,
    maxHeight: 160,
  },
  productSuggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.background,
  },
  productSuggestionName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  productSuggestionMeta: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 1,
  },
  selectedProductConfigCard: {
    backgroundColor: ui.background,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  selectedProductConfigTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  selectedProductConfigSku: {
    fontSize: 12,
    color: ui.textSecondary,
    marginBottom: 8,
  },
  qtyCostRow: {
    flexDirection: 'row',
  },
  inputMiniLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 4,
  },
  inputMini: {
    backgroundColor: ui.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: ui.text,
  },
  subtotalAddRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderColor: ui.border,
  },
  subtotalAddText: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  addProductBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primary,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  addProductBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.surface,
  },
  emptyItemsBox: {
    padding: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    borderStyle: 'dashed',
    gap: 6,
  },
  emptyItemsText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  orderItemsList: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    overflow: 'hidden',
  },
  orderItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  orderItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  orderItemDetails: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  orderItemTotal: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
    marginRight: 10,
  },
  deleteItemBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: ui.dangerSoft,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    marginBottom: 4,
    marginTop: 8,
  },
  textInput: {
    minHeight: 48,
    backgroundColor: ui.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: ui.text,
    marginBottom: 6,
  },
  rucInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  sunatLookupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.text,
    paddingHorizontal: 14,
    borderRadius: 8,
    justifyContent: 'center',
  },
  sunatLookupBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.surface,
  },
  sunatStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: ui.successSoft,
    marginBottom: 8,
  },
  sunatStatusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.success,
  },
  categoriesRow: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  catOptionChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    marginRight: 6,
    borderWidth: 1,
    borderColor: ui.border,
  },
  catOptionChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  catOptionChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  catOptionChipTextActive: {
    color: ui.primary,
  },
  subModalFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: ui.surface,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  footerTotalBox: {
    flex: 1,
  },
  footerTotalLabel: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  footerTotalAmount: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  saveOrderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.primary,
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  saveOrderButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.surface,
  },
  subModalCancelBtn: {
    flex: 1,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    marginRight: 10,
  },
  subModalCancelBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  saveSupplierSubmitBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.primary,
    paddingVertical: 11,
    borderRadius: 10,
  },
  saveSupplierSubmitBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.surface,
  },
  btnDisabled: {
    opacity: 0.5,
  },
});

export default SuppliersPurchaseModal;
