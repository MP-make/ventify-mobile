import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  Search,
  Plus,
  Trash2,
  AlertCircle,
  ChevronDown,
  Package,
  Check,
} from 'lucide-react-native';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { filterCatalogIndex } from '@/lib/catalog-filters';
import { getAllPresentations } from '@/lib/product-search';
import { formatPEN, ui } from '@/lib/theme';
import { assertOnlineForWrite } from '@/lib/online-guard';
import {
  SuppliersPOService,
  Supplier,
  PurchaseOrderItem,
  roundToCents,
  resolvePackagingFactor,
} from '@/services/suppliers-po-service';
import type { Product } from '@/types';
import { suppliersStyles as styles } from './suppliersStyles';

interface ProductSuggestionItemProps {
  prod: Product;
  stockInBranch: number;
  onSelect: (prod: Product) => void;
}

const ProductSuggestionItem = React.memo<ProductSuggestionItemProps>(
  ({ prod, stockInBranch, onSelect }) => (
    <TouchableOpacity
      style={styles.productSuggestionItem}
      onPress={() => onSelect(prod)}
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
  )
);

export interface CreateOrderModalProps {
  visible: boolean;
  suppliers: Supplier[];
  onClose: () => void;
  onRequestNewSupplier: () => void;
}

export const CreateOrderModal: React.FC<CreateOrderModalProps> = React.memo(({
  visible,
  suppliers,
  onClose,
  onRequestNewSupplier,
}) => {
  const { accountId, branchId, userProfile } = useAuthSession();
  const { activeBranchName } = useBusinessSettings();
  const { catalogIndex, getProductStock } = useProducts();
  const insets = useSafeAreaInsets();

  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(() =>
    suppliers.length > 0 ? suppliers[0] : null
  );
  const [supplierPickerVisible, setSupplierPickerVisible] = useState<boolean>(false);
  const [orderItems, setOrderItems] = useState<PurchaseOrderItem[]>([]);
  const [orderNotes, setOrderNotes] = useState<string>('');
  const [expectedDateStr, setExpectedDateStr] = useState<string>('');
  const [isCreatingOrder, setIsCreatingOrder] = useState<boolean>(false);

  const [productSearchQuery, setProductSearchQuery] = useState<string>('');
  const [selectedProductToAdd, setSelectedProductToAdd] = useState<Product | null>(null);
  const [itemQuantityInput, setItemQuantityInput] = useState<string>('1');
  const [itemUnitCostInput, setItemUnitCostInput] = useState<string>('');
  const [itemPackagingId, setItemPackagingId] = useState<string>('unit');
  const [itemPackagingCustomFactor, setItemPackagingCustomFactor] = useState<string>('12');

  const debouncedProductSearch = useDebouncedValue(productSearchQuery, 150);

  useEffect(() => {
    if (!selectedSupplier && suppliers.length > 0) {
      setSelectedSupplier(suppliers[0]);
    }
  }, [selectedSupplier, suppliers]);

  const filteredProductsForOrder = useMemo(() => {
    if (selectedProductToAdd || !debouncedProductSearch.trim()) return [];
    return filterCatalogIndex(catalogIndex, {
      query: debouncedProductSearch,
      limit: 30,
    });
  }, [catalogIndex, debouncedProductSearch, selectedProductToAdd]);

  const packagingOptionsForSelected = useMemo(() => {
    if (!selectedProductToAdd) return [];
    const customNum = Math.max(1, parseInt(itemPackagingCustomFactor, 10) || 1);
    const presentationOpts = getAllPresentations(selectedProductToAdd)
      .filter((p) => p.active !== false && Number(p.conversionFactor ?? p.quantity) > 1)
      .map((p) => ({
        id: p.id,
        label: p.name,
        factor: Number(p.conversionFactor ?? p.quantity) || 1,
      }));
    return [
      { id: 'unit', label: 'Unidad', factor: 1 },
      ...presentationOpts,
      {
        id: 'custom',
        label: customNum > 1 ? `Caja x${customNum}` : 'Caja personalizada',
        factor: customNum,
      },
    ];
  }, [selectedProductToAdd, itemPackagingCustomFactor]);

  const activePackagingOption = useMemo(() => {
    return (
      packagingOptionsForSelected.find((opt) => opt.id === itemPackagingId) ||
      packagingOptionsForSelected[0] || { id: 'unit', label: 'Unidad', factor: 1 }
    );
  }, [packagingOptionsForSelected, itemPackagingId]);

  const handleSelectProductForOrder = useCallback((product: Product) => {
    setSelectedProductToAdd(product);
    setProductSearchQuery(product.name);
    setItemQuantityInput('1');
    setItemPackagingId('unit');
    setItemPackagingCustomFactor('12');
    setItemUnitCostInput(product.costPrice ? String(product.costPrice) : '0');
  }, []);

  const handleSelectPackagingForOrder = useCallback(
    (opt: { id: string; label: string; factor: number }) => {
      setItemPackagingId(opt.id);
      if (selectedProductToAdd) {
        const baseCost = Number(selectedProductToAdd.costPrice) || 0;
        if (baseCost > 0) {
          setItemUnitCostInput(String(roundToCents(baseCost * Math.max(1, opt.factor))));
        }
      }
    },
    [selectedProductToAdd]
  );

  const handleAddItemToOrder = useCallback(() => {
    if (!selectedProductToAdd) {
      Alert.alert('Atención', 'Selecciona un producto del catálogo.');
      return;
    }

    const packs = parseFloat(itemQuantityInput);
    if (isNaN(packs) || packs <= 0) {
      Alert.alert('Cantidad inválida', 'Ingresa una cantidad mayor a 0.');
      return;
    }

    const packCost = parseFloat(itemUnitCostInput);
    if (isNaN(packCost) || packCost < 0) {
      Alert.alert('Costo inválido', 'Ingresa un costo válido.');
      return;
    }

    if (itemPackagingId === 'custom') {
      const parsedCustom = parseInt(itemPackagingCustomFactor, 10);
      if (!Number.isFinite(parsedCustom) || parsedCustom < 2) {
        Alert.alert('Factor inválido', 'Ingresa cuántas unidades trae el bulto/caja (mínimo 2).');
        return;
      }
    }

    const factor = resolvePackagingFactor(activePackagingOption.factor);
    const totalUnits = Math.round(packs * factor * 10000) / 10000;
    const unitCost = roundToCents(factor > 1 ? packCost / factor : packCost);
    const subtotal = roundToCents(packs * packCost);

    setOrderItems((prevItems) => {
      const existingIndex = prevItems.findIndex(
        (it) =>
          it.productId === selectedProductToAdd.id &&
          resolvePackagingFactor(it.packagingFactor) === factor
      );
      if (existingIndex >= 0) {
        const updated = [...prevItems];
        const prev = updated[existingIndex];
        const newTotalUnits = Math.round((prev.quantity + totalUnits) * 10000) / 10000;
        const newPacks = factor > 1 ? newTotalUnits / factor : newTotalUnits;
        updated[existingIndex] = {
          ...prev,
          quantity: newTotalUnits,
          unitCost,
          subtotal: roundToCents(newPacks * packCost),
          packagingId: activePackagingOption.id,
          packagingLabel: factor > 1 ? activePackagingOption.label : undefined,
          packagingFactor: factor > 1 ? factor : undefined,
          packagingTotalCost: factor > 1 ? roundToCents(packCost) : undefined,
        };
        return updated;
      }

      const newItem: PurchaseOrderItem = {
        productId: selectedProductToAdd.id,
        productName: selectedProductToAdd.name,
        sku: selectedProductToAdd.sku || '',
        quantity: totalUnits,
        unitCost,
        subtotal,
        packagingId: activePackagingOption.id,
        packagingLabel: factor > 1 ? activePackagingOption.label : undefined,
        packagingFactor: factor > 1 ? factor : undefined,
        packagingTotalCost: factor > 1 ? roundToCents(packCost) : undefined,
        receivedQuantity: 0,
      };
      return [...prevItems, newItem];
    });

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedProductToAdd(null);
    setProductSearchQuery('');
    setItemQuantityInput('1');
    setItemUnitCostInput('');
    setItemPackagingId('unit');
  }, [
    selectedProductToAdd,
    itemQuantityInput,
    itemUnitCostInput,
    itemPackagingId,
    itemPackagingCustomFactor,
    activePackagingOption,
  ]);

  const handleRemoveItemFromOrder = useCallback((index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOrderItems((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  }, []);

  const handleSavePurchaseOrder = useCallback(async () => {
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
      await assertOnlineForWrite('registrar una orden de compra');
      await SuppliersPOService.createPurchaseOrder({
        accountId,
        branchId,
        branchName: activeBranchName || branchId,
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
      onClose();
    } catch (err: any) {
      console.error('[SuppliersPurchaseModal] Error al crear orden:', err);
      Alert.alert('Error', err?.message || 'No se pudo guardar la orden de compra.');
    } finally {
      setIsCreatingOrder(false);
    }
  }, [
    accountId,
    branchId,
    activeBranchName,
    selectedSupplier,
    orderItems,
    orderNotes,
    expectedDateStr,
    userProfile,
    onClose,
  ]);

  const createOrderTotal = useMemo(() => {
    return orderItems.reduce((acc, it) => acc + it.subtotal, 0);
  }, [orderItems]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={[styles.modalSheetContainer, { paddingBottom: Math.max(12, insets.bottom) }]}
          collapsable={false}
        >
          {/* Header Submodal */}
          <View style={styles.subModalHeader}>
            <View>
              <Text style={styles.subModalTitle}>Nueva Orden de Compra</Text>
              <Text style={styles.subModalSubtitle}>
                Abastecimiento de mercadería para Almacén
              </Text>
            </View>
            <TouchableOpacity style={styles.closeSubModalBtn} onPress={onClose}>
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
                  onPress={onRequestNewSupplier}
                >
                  <Text style={styles.createSupplierShortcutText}>+ Registrar Proveedor</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.supplierSelectorBox}
                onPress={() => setSupplierPickerVisible((v) => !v)}
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
              <ScrollView
                style={styles.productSuggestionsList}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
              >
                {filteredProductsForOrder.map((prod) => (
                  <ProductSuggestionItem
                    key={prod.id}
                    prod={prod}
                    stockInBranch={getProductStock(prod, branchId)}
                    onSelect={handleSelectProductForOrder}
                  />
                ))}
              </ScrollView>
            )}

            {/* Si se seleccionó un producto, configurar empaque, cantidad y costo */}
            {selectedProductToAdd && (
              <View style={styles.selectedProductConfigCard}>
                <Text style={styles.selectedProductConfigTitle}>
                  {selectedProductToAdd.name}
                </Text>
                <Text style={styles.selectedProductConfigSku}>
                  SKU: {selectedProductToAdd.sku || 'N/A'}
                </Text>

                {/* Selector de Empaque / Presentación de compra */}
                <Text style={styles.inputMiniLabel}>Empaque de compra</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginTop: 4, marginBottom: 10 }}
                >
                  <View style={styles.packagingChipsRow}>
                    {packagingOptionsForSelected.map((opt) => {
                      const selected = itemPackagingId === opt.id;
                      return (
                        <TouchableOpacity
                          key={opt.id}
                          style={[styles.packagingChip, selected && styles.packagingChipActive]}
                          onPress={() => handleSelectPackagingForOrder(opt)}
                        >
                          <Text
                            style={[
                              styles.packagingChipText,
                              selected && styles.packagingChipTextActive,
                            ]}
                          >
                            {opt.label}
                            {opt.factor > 1 && opt.id !== 'custom' ? ` (×${opt.factor})` : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>

                {itemPackagingId === 'custom' && (
                  <View style={{ marginBottom: 10 }}>
                    <Text style={styles.inputMiniLabel}>Unidades por caja/bulto</Text>
                    <TextInput
                      style={styles.inputMini}
                      keyboardType="number-pad"
                      value={itemPackagingCustomFactor}
                      onChangeText={setItemPackagingCustomFactor}
                      placeholder="Ej: 12 o 24"
                      placeholderTextColor={ui.textMuted}
                    />
                  </View>
                )}

                <View style={styles.qtyCostRow}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.inputMiniLabel}>
                      {activePackagingOption.factor > 1
                        ? `Bultos (${activePackagingOption.label})`
                        : 'Cantidad (un.)'}
                    </Text>
                    <TextInput
                      style={styles.inputMini}
                      keyboardType="numeric"
                      value={itemQuantityInput}
                      onChangeText={setItemQuantityInput}
                    />
                  </View>

                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={styles.inputMiniLabel}>
                      {activePackagingOption.factor > 1
                        ? 'Costo por bulto (S/)'
                        : 'Costo Unitario (S/)'}
                    </Text>
                    <TextInput
                      style={styles.inputMini}
                      keyboardType="numeric"
                      value={itemUnitCostInput}
                      onChangeText={setItemUnitCostInput}
                    />
                  </View>
                </View>

                {activePackagingOption.factor > 1 && (
                  <Text style={styles.packagingHintText}>
                    Ingresará {(parseFloat(itemQuantityInput) || 0) * activePackagingOption.factor} un. base •{' '}
                    {formatPEN(
                      (parseFloat(itemUnitCostInput) || 0) / activePackagingOption.factor
                    )}{' '}
                    c/u
                  </Text>
                )}

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
                {orderItems.map((it, idx) => {
                  const factor = resolvePackagingFactor(it.packagingFactor);
                  return (
                    <View key={`${it.productId}-${idx}`} style={styles.orderItemRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.orderItemName}>{it.productName}</Text>
                        <Text style={styles.orderItemDetails}>
                          {it.quantity} un. x {formatPEN(it.unitCost)}
                          {factor > 1 ? ` • ${it.packagingLabel || `Caja x${factor}`}` : ''}
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
                  );
                })}
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
  );
});
