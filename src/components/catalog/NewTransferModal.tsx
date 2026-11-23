import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  X,
  Building2,
  Search,
  Barcode,
  Plus,
  Trash2,
  ArrowRightLeft,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings, useOfflineStatus } from '@/context/SettingsContext';
import { useProducts } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { assertOnlineForWrite } from '@/lib/online-guard';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { filterCatalogIndex } from '@/lib/catalog-filters';
import { getAvailableStock } from '@/lib/product-search';
import {
  createStockTransfer,
  getVariantBranchStock,
} from '@/services/inventory-kardex-service';
import { BarcodeScannerModal } from '@/components/BarcodeScannerModal';
import { ui } from '@/lib/theme';
import type { Product } from '@/types';
import { catalogModalStyles as styles } from './catalogModalStyles';

interface TransferDraftItem {
  productId: string;
  productName: string;
  sku?: string;
  variantId?: string;
  variantName?: string;
  quantity: number;
}

export interface NewTransferModalProps {
  visible: boolean;
  onClose: () => void;
  onTransferCreated?: () => void;
}

function getProductAvailableForTransfer(
  prod: Product,
  srcBranch: string,
  varId?: string | null
): number {
  if (varId && Array.isArray(prod.variants) && prod.variants.length > 0) {
    const v = prod.variants.find((item) => item.id === varId);
    const variantPhysical = getVariantBranchStock(v, srcBranch);
    const branchAvailable = getAvailableStock(prod, srcBranch);
    return Math.min(variantPhysical, branchAvailable);
  }
  return getAvailableStock(prod, srcBranch);
}

interface TransferPickerRowProps {
  product: Product;
  available: number;
  isSelected: boolean;
  onSelect: (product: Product) => void;
}

const TransferPickerRow = React.memo<TransferPickerRowProps>(
  ({ product, available, isSelected, onSelect }) => {
    const handlePress = useCallback(() => {
      onSelect(product);
    }, [onSelect, product]);

    return (
      <TouchableOpacity
        style={[styles.productPickRow, isSelected && styles.productPickRowActive]}
        onPress={handlePress}
      >
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text
            style={[styles.productPickName, isSelected && { color: ui.primary, fontWeight: '700' }]}
            numberOfLines={1}
          >
            {product.name}
          </Text>
          {product.sku ? (
            <Text style={{ fontSize: 11, color: ui.textMuted }}>SKU: {product.sku}</Text>
          ) : null}
        </View>
        <Text
          style={[
            styles.productPickStock,
            isSelected && { color: ui.primary, fontWeight: '700' },
          ]}
        >
          Disp: {available} uds
        </Text>
      </TouchableOpacity>
    );
  }
);

const transferPickerKeyExtractor = (item: Product) => item.id;

/** Isolates transfer draft inputs, search, and barcode scanner modal state away from CatalogInventoryScreen. */
export const NewTransferModal: React.FC<NewTransferModalProps> = React.memo(
  ({ visible, onClose, onTransferCreated }) => {
    const { accountId, branchId, user, userProfile } = useAuthSession();
    const { branches, activeBranchName } = useBusinessSettings();
    const { isOnline } = useOfflineStatus();
    const { catalogIndex, getProductById, findByBarcode } = useProducts();
    const { canRequestTransfer } = usePermissions();

    const [sourceBranchId, setSourceBranchId] = useState('');
    const [destinationBranchId, setDestinationBranchId] = useState('');
    const [transferProductId, setTransferProductId] = useState('');
    const [transferVariantId, setTransferVariantId] = useState<string | null>(null);
    const [transferQtyStr, setTransferQtyStr] = useState('');
    const [transferItems, setTransferItems] = useState<TransferDraftItem[]>([]);
    const [transferNotes, setTransferNotes] = useState('');
    const [isCreatingTransfer, setIsCreatingTransfer] = useState(false);
    const [transferSearchText, setTransferSearchText] = useState('');
    const [transferScannerOpen, setTransferScannerOpen] = useState(false);

    useEffect(() => {
      if (!visible) return;
      setSourceBranchId(branchId || '');
      setDestinationBranchId('');
      setTransferItems([]);
      setTransferProductId('');
      setTransferVariantId(null);
      setTransferSearchText('');
      setTransferQtyStr('');
      setTransferNotes('');
      setTransferScannerOpen(false);
    }, [visible, branchId]);

    const debouncedTransferSearchText = useDebouncedValue(transferSearchText, 150);

    const effectiveDraftSourceId = sourceBranchId || branchId;

    const draftSourceName = useMemo(
      () =>
        branches.find((b) => b.id === effectiveDraftSourceId)?.name ||
        activeBranchName ||
        'Sucursal actual',
      [branches, effectiveDraftSourceId, activeBranchName]
    );

    const destinationOptions = useMemo(
      () => branches.filter((b) => b.id && b.id !== effectiveDraftSourceId),
      [branches, effectiveDraftSourceId]
    );

    const filteredTransferProducts = useMemo(() => {
      if (!visible) return [];
      return filterCatalogIndex(catalogIndex, { query: debouncedTransferSearchText, limit: 30 });
    }, [visible, catalogIndex, debouncedTransferSearchText]);

    const selectedTransferProduct = useMemo(
      () => (transferProductId ? getProductById(transferProductId) || null : null),
      [getProductById, transferProductId]
    );

    const selectedVariants = useMemo(
      () =>
        selectedTransferProduct && Array.isArray(selectedTransferProduct.variants)
          ? selectedTransferProduct.variants
          : [],
      [selectedTransferProduct]
    );

    const selectedVariant = useMemo(
      () => selectedVariants.find((v) => v.id === transferVariantId) || null,
      [selectedVariants, transferVariantId]
    );

    const selectedAvailable = useMemo(
      () =>
        selectedTransferProduct
          ? getProductAvailableForTransfer(
              selectedTransferProduct,
              effectiveDraftSourceId,
              selectedVariant?.id
            )
          : 0,
      [selectedTransferProduct, effectiveDraftSourceId, selectedVariant?.id]
    );

    const totalQueuedUnits = useMemo(
      () => transferItems.reduce((acc, it) => acc + it.quantity, 0),
      [transferItems]
    );

    const handleOpenScanner = useCallback(() => setTransferScannerOpen(true), []);
    const handleCloseScanner = useCallback(() => setTransferScannerOpen(false), []);

    const handleTransferBarcodeScanned = useCallback(
      (code: string) => {
        setTransferScannerOpen(false);
        const clean = code.trim();
        if (!clean) return;
        const found = findByBarcode(clean)?.product || null;
        if (found) {
          setTransferProductId(found.id);
          setTransferSearchText(found.name);
          const variantsArr = Array.isArray(found.variants) ? found.variants : [];
          setTransferVariantId(variantsArr.length > 0 ? variantsArr[0].id : null);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          setTransferSearchText(clean);
          Alert.alert('No encontrado', `No se encontró un producto con código "${clean}".`);
        }
      },
      [findByBarcode]
    );

    const handleSelectProduct = useCallback((p: Product) => {
      setTransferProductId(p.id);
      setTransferSearchText(p.name);
      const varsArr = Array.isArray(p.variants) ? p.variants : [];
      setTransferVariantId(varsArr.length > 0 ? varsArr[0].id : null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    const handleSearchTextChange = useCallback(
      (txt: string) => {
        setTransferSearchText(txt);
        if (
          transferProductId &&
          selectedTransferProduct &&
          txt !== selectedTransferProduct.name
        ) {
          setTransferProductId('');
          setTransferVariantId(null);
        }
      },
      [transferProductId, selectedTransferProduct]
    );

    const handleClearSearch = useCallback(() => {
      setTransferSearchText('');
      setTransferProductId('');
      setTransferVariantId(null);
    }, []);

    const handleAddTransferItem = useCallback(() => {
      if (!transferProductId) {
        Alert.alert(
          'Producto requerido',
          'Selecciona un producto para agregar a la transferencia.'
        );
        return;
      }
      const selectedProd = getProductById(transferProductId);
      if (!selectedProd) return;

      const hasVars = Array.isArray(selectedProd.variants) && selectedProd.variants.length > 0;
      const selectedVar = hasVars
        ? selectedProd.variants!.find((v) => v.id === transferVariantId)
        : undefined;
      if (hasVars && !selectedVar) {
        Alert.alert('Variante requerida', 'Selecciona la variante del producto a transferir.');
        return;
      }

      const qty = parseFloat(transferQtyStr);
      if (isNaN(qty) || qty <= 0) {
        Alert.alert('Cantidad inválida', 'Ingresa una cantidad mayor a cero.');
        return;
      }

      const available = getProductAvailableForTransfer(
        selectedProd,
        effectiveDraftSourceId,
        selectedVar?.id
      );
      const alreadyQueued = transferItems
        .filter(
          (it) =>
            it.productId === selectedProd.id &&
            (it.variantId || '') === (selectedVar?.id || '')
        )
        .reduce((acc, it) => acc + it.quantity, 0);

      if (qty + alreadyQueued > available) {
        Alert.alert(
          'Stock Insuficiente',
          `Disponible en origen: ${available} uds (ya agregadas: ${alreadyQueued}).`
        );
        return;
      }

      setTransferItems((prev) => {
        const existingIdx = prev.findIndex(
          (it) =>
            it.productId === selectedProd.id &&
            (it.variantId || '') === (selectedVar?.id || '')
        );
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = {
            ...next[existingIdx],
            quantity: Math.round((next[existingIdx].quantity + qty) * 10000) / 10000,
          };
          return next;
        }
        return [
          ...prev,
          {
            productId: selectedProd.id,
            productName: selectedProd.name,
            sku: selectedProd.sku,
            variantId: selectedVar?.id,
            variantName: selectedVar?.name,
            quantity: qty,
          },
        ];
      });

      setTransferProductId('');
      setTransferVariantId(null);
      setTransferSearchText('');
      setTransferQtyStr('');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [
      effectiveDraftSourceId,
      getProductById,
      transferItems,
      transferProductId,
      transferQtyStr,
      transferVariantId,
    ]);

    const handleRemoveTransferItem = useCallback((productId: string, variantId?: string) => {
      setTransferItems((prev) =>
        prev.filter(
          (it) => !(it.productId === productId && (it.variantId || '') === (variantId || ''))
        )
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, []);

    const handleCreateTransfer = useCallback(async () => {
      if (!canRequestTransfer) {
        Alert.alert(
          'Acceso Denegado',
          'No cuentas con permiso para solicitar o realizar transferencias.'
        );
        return;
      }

      if (!accountId || !effectiveDraftSourceId || !destinationBranchId) {
        Alert.alert('Campos Incompletos', 'Selecciona la sucursal de origen y destino.');
        return;
      }
      if (effectiveDraftSourceId === destinationBranchId) {
        Alert.alert(
          'Sucursales iguales',
          'La sucursal de destino debe ser distinta a la de origen.'
        );
        return;
      }

      let finalItems = [...transferItems];
      if (finalItems.length === 0 && transferProductId) {
        const qty = parseFloat(transferQtyStr);
        const selectedProd = getProductById(transferProductId);
        if (!selectedProd || isNaN(qty) || qty <= 0) {
          Alert.alert(
            'Cantidad Inválida',
            'Ingresa una cantidad mayor a cero o agrega productos a la lista.'
          );
          return;
        }
        const hasVars = Array.isArray(selectedProd.variants) && selectedProd.variants.length > 0;
        const selectedVar = hasVars
          ? selectedProd.variants!.find((v) => v.id === transferVariantId)
          : undefined;
        if (hasVars && !selectedVar) {
          Alert.alert('Variante requerida', 'Selecciona la variante del producto a transferir.');
          return;
        }
        const available = getProductAvailableForTransfer(
          selectedProd,
          effectiveDraftSourceId,
          selectedVar?.id
        );
        if (qty > available) {
          Alert.alert(
            'Stock Insuficiente',
            `No puedes transferir más de las unidades disponibles en origen (${available} uds).`
          );
          return;
        }
        finalItems = [
          {
            productId: selectedProd.id,
            productName: selectedProd.name,
            sku: selectedProd.sku,
            variantId: selectedVar?.id,
            variantName: selectedVar?.name,
            quantity: qty,
          },
        ];
      }

      if (finalItems.length === 0) {
        Alert.alert('Sin productos', 'Agrega al menos un producto para transferir.');
        return;
      }

      const srcBranch = branches.find((b) => b.id === effectiveDraftSourceId);
      const destBranch = branches.find((b) => b.id === destinationBranchId);
      const totalQty = finalItems.reduce((acc, it) => acc + it.quantity, 0);

      try {
        setIsCreatingTransfer(true);
        await assertOnlineForWrite('crear una transferencia de stock', isOnline);
        await createStockTransfer({
          accountId,
          fromBranchId: effectiveDraftSourceId,
          fromBranchName: srcBranch?.name || activeBranchName || 'Sucursal Origen',
          toBranchId: destinationBranchId,
          toBranchName: destBranch?.name || 'Sucursal Destino',
          items: finalItems,
          notes: transferNotes.trim(),
          userProfile: {
            uid: user?.uid || 'user_pos',
            displayName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero',
            email: user?.email || '',
          },
        });

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          'Transferencia Registrada',
          `Se registró la transferencia de ${finalItems.length} línea(s) (${totalQty} uds) hacia ${destBranch?.name || 'destino'}.`
        );
        onTransferCreated?.();
        onClose();
      } catch (err: any) {
        Alert.alert(
          'Error en Transferencia',
          err?.message || 'No se pudo registrar la transferencia.'
        );
      } finally {
        setIsCreatingTransfer(false);
      }
    }, [
      accountId,
      activeBranchName,
      branches,
      canRequestTransfer,
      destinationBranchId,
      effectiveDraftSourceId,
      getProductById,
      isOnline,
      onClose,
      onTransferCreated,
      transferItems,
      transferNotes,
      transferProductId,
      transferQtyStr,
      transferVariantId,
      user?.displayName,
      user?.email,
      user?.uid,
      userProfile?.displayName,
    ]);

    const renderPickerRow = useCallback(
      ({ item }: { item: Product }) => (
        <TransferPickerRow
          product={item}
          available={getProductAvailableForTransfer(item, effectiveDraftSourceId)}
          isSelected={transferProductId === item.id}
          onSelect={handleSelectProduct}
        />
      ),
      [effectiveDraftSourceId, transferProductId, handleSelectProduct]
    );

    const pickerListHeight =
      filteredTransferProducts.length === 0
        ? 52
        : Math.min(132, Math.max(52, filteredTransferProducts.length * 46));

    return (
      <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
        <KeyboardAvoidingView
          style={styles.subModalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.subModalCard, styles.transferModalCard]}>
            <View style={styles.subModalHeader}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={styles.subModalTitle}>Nueva Transferencia</Text>
                <Text style={styles.subModalSubtitle} numberOfLines={1}>
                  Origen: {draftSourceName}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Cerrar nueva transferencia"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.transferModalScroll}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <Text style={styles.inputLabel}>Sucursal de Destino</Text>
              {destinationOptions.length === 0 ? (
                <View style={styles.transferEmptyBranchesBox}>
                  <Text style={styles.transferEmptyBranchesText}>
                    Se requieren al menos 2 sucursales activas para transferir mercadería.
                  </Text>
                </View>
              ) : (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 12 }}
                >
                  {destinationOptions.map((b) => (
                    <TouchableOpacity
                      key={b.id}
                      style={[
                        styles.branchPickChip,
                        destinationBranchId === b.id && styles.branchPickChipActive,
                      ]}
                      onPress={() => setDestinationBranchId(b.id || '')}
                      accessibilityRole="button"
                      accessibilityState={{ selected: destinationBranchId === b.id }}
                    >
                      <Building2
                        size={14}
                        color={destinationBranchId === b.id ? ui.surface : ui.textSecondary}
                      />
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
              )}

              <Text style={styles.inputLabel}>Agregar Productos a Transferir</Text>

              <View style={styles.transferSearchRow}>
                <View style={styles.transferSearchBar}>
                  <Search size={15} color={ui.textSecondary} style={{ marginRight: 6 }} />
                  <TextInput
                    style={styles.transferSearchInput}
                    value={transferSearchText}
                    onChangeText={handleSearchTextChange}
                    placeholder="Buscar producto, SKU o código..."
                    placeholderTextColor={ui.textMuted}
                    autoCapitalize="none"
                  />
                  {transferSearchText ? (
                    <TouchableOpacity onPress={handleClearSearch} hitSlop={6}>
                      <X size={14} color={ui.textSecondary} />
                    </TouchableOpacity>
                  ) : null}
                </View>

                <TouchableOpacity
                  style={styles.transferScanBtn}
                  onPress={handleOpenScanner}
                  accessibilityRole="button"
                  accessibilityLabel="Escanear código de barras del producto a transferir"
                  activeOpacity={0.7}
                >
                  <Barcode size={18} color={ui.primary} />
                </TouchableOpacity>
              </View>

              <View style={[styles.transferProductPickerList, { height: pickerListHeight }]}>
                {filteredTransferProducts.length === 0 ? (
                  <View style={{ paddingVertical: 14, alignItems: 'center' }}>
                    <Text style={{ fontSize: 13, color: ui.textMuted }}>
                      No se encontraron productos coincidentes.
                    </Text>
                  </View>
                ) : (
                  <FlashList
                    data={filteredTransferProducts}
                    estimatedItemSize={44}
                    extraData={transferProductId}
                    keyExtractor={transferPickerKeyExtractor}
                    renderItem={renderPickerRow}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                  />
                )}
              </View>

              {selectedTransferProduct && selectedVariants.length > 0 && (
                <View style={{ marginBottom: 10 }}>
                  <Text style={styles.inputLabel}>Variante</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.variantChipsRow}
                  >
                    {selectedVariants.map((v) => {
                      const isSelected = transferVariantId === v.id;
                      const vAvail = getProductAvailableForTransfer(
                        selectedTransferProduct,
                        effectiveDraftSourceId,
                        v.id
                      );
                      return (
                        <TouchableOpacity
                          key={v.id}
                          style={[
                            styles.variantPickChip,
                            isSelected && styles.variantPickChipActive,
                          ]}
                          onPress={() => {
                            setTransferVariantId(v.id);
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isSelected }}
                        >
                          {v.colorHex ? (
                            <View
                              style={[
                                styles.variantColorDot,
                                { backgroundColor: v.colorHex },
                                isSelected && { borderColor: ui.surface },
                              ]}
                            />
                          ) : null}
                          <Text
                            style={[
                              styles.variantPickChipText,
                              isSelected && styles.variantPickChipTextActive,
                            ]}
                          >
                            {v.name}
                            {v.sizeLabel ? ` (${v.sizeLabel})` : ''} · {vAvail} disp.
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              <View style={styles.transferQtyHeaderRow}>
                <Text style={styles.inputLabel}>Cantidad a Enviar</Text>
                {selectedTransferProduct ? (
                  <Text style={styles.transferAvailableHint}>
                    Disponible: {selectedAvailable} uds
                  </Text>
                ) : null}
              </View>
              <View style={styles.transferQtyAddRow}>
                <TextInput
                  style={[styles.formInput, styles.transferQtyInput]}
                  value={transferQtyStr}
                  onChangeText={setTransferQtyStr}
                  placeholder="0"
                  placeholderTextColor={ui.textMuted}
                  keyboardType={
                    selectedTransferProduct?.allowDecimals ? 'decimal-pad' : 'numeric'
                  }
                />
                <TouchableOpacity
                  style={[
                    styles.transferAddBtn,
                    (!transferProductId || isCreatingTransfer) && { opacity: 0.5 },
                  ]}
                  onPress={handleAddTransferItem}
                  disabled={!transferProductId || isCreatingTransfer}
                  accessibilityRole="button"
                  accessibilityLabel="Agregar ítem a la transferencia"
                >
                  <Plus size={16} color={ui.onPrimary} />
                  <Text style={styles.transferAddBtnText}>Agregar</Text>
                </TouchableOpacity>
              </View>

              {transferItems.length > 0 && (
                <View style={styles.transferDraftSection}>
                  <Text style={styles.inputLabel}>
                    Ítems en transferencia ({transferItems.length} · {totalQueuedUnits} uds)
                  </Text>
                  {transferItems.map((it, idx) => (
                    <View
                      key={`${it.productId}-${it.variantId || 'base'}-${idx}`}
                      style={styles.transferDraftItemRow}
                    >
                      <View style={styles.transferDraftItemInfo}>
                        <Text style={styles.transferDraftItemName} numberOfLines={1}>
                          {it.productName}
                          {it.variantName ? ` (${it.variantName})` : ''}
                        </Text>
                        <Text style={styles.transferDraftItemMeta}>
                          {it.quantity} uds{it.sku ? ` · SKU: ${it.sku}` : ''}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={styles.transferDraftRemoveBtn}
                        onPress={() => handleRemoveTransferItem(it.productId, it.variantId)}
                        accessibilityRole="button"
                        accessibilityLabel={`Quitar ${it.productName}`}
                        hitSlop={6}
                      >
                        <Trash2 size={15} color={ui.danger} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              <Text style={styles.inputLabel}>Nota / Guía de Remisión</Text>
              <TextInput
                style={styles.formInput}
                value={transferNotes}
                onChangeText={setTransferNotes}
                placeholder="Ej. Traslado por reposición tienda 2"
                placeholderTextColor={ui.textMuted}
              />
            </ScrollView>

            <View style={styles.subModalActions}>
              <TouchableOpacity
                style={styles.subModalCancelBtn}
                onPress={onClose}
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
                    <Text style={styles.subModalConfirmText}>
                      {transferItems.length > 0
                        ? `Enviar (${transferItems.length})`
                        : 'Enviar Transferencia'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>

        {transferScannerOpen && (
          <BarcodeScannerModal
            visible={transferScannerOpen}
            onClose={handleCloseScanner}
            onScan={handleTransferBarcodeScanned}
            title="Escanear Producto a Transferir"
          />
        )}
      </Modal>
    );
  }
);
