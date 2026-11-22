import React, { useState, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X, Send } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { useProducts } from '@/context/ProductsContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { filterCatalogIndex } from '@/lib/catalog-filters';
import { ui, formatPEN } from '@/lib/theme';
import { createSaleRequest } from '@/services/enterprise-ops-service';
import type { Product, UserProfile } from '@/types';
import { payrollModalStyles as styles } from './payroll-modal-styles';

export interface CreateSaleRequestModalProps {
  visible: boolean;
  accountId: string | null;
  branchId: string;
  activeBranchName: string;
  userProfile: UserProfile | null;
  onClose: () => void;
}

/** Sub-modal for creating a discounted sale request, isolating product catalog lookup. */
export const CreateSaleRequestModal = React.memo<CreateSaleRequestModalProps>(({
  visible,
  accountId,
  branchId,
  activeBranchName,
  userProfile,
  onClose,
}) => {
  const { catalogIndex } = useProducts();

  const [customerName, setCustomerName] = useState<string>('');
  const [requestProductSearch, setRequestProductSearch] = useState<string>('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [originalPrice, setOriginalPrice] = useState<string>('');
  const [requestedPrice, setRequestedPrice] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('1');
  const [reason, setReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const debouncedProductSearch = useDebouncedValue(requestProductSearch, 150);

  const requestProductMatches = useMemo(() => {
    if (selectedProduct) return [];
    const query = debouncedProductSearch.trim();
    if (!query) return [];
    return filterCatalogIndex(catalogIndex, { query, limit: 20 });
  }, [catalogIndex, debouncedProductSearch, selectedProduct]);

  const handleRequestClose = useCallback(() => {
    if (!isSubmitting) {
      onClose();
    }
  }, [isSubmitting, onClose]);

  const handleProductSearchChange = useCallback((value: string) => {
    setRequestProductSearch(value);
    setSelectedProduct(null);
  }, []);

  const handleClearProduct = useCallback(() => {
    setSelectedProduct(null);
    setRequestProductSearch('');
  }, []);

  const handleSelectProduct = useCallback((product: Product) => {
    setSelectedProduct(product);
    setRequestProductSearch(product.name);
    const listPrice = Number(product.suggestedPrice || product.price || 0);
    setOriginalPrice(String(listPrice));
    setRequestedPrice(String(listPrice));
  }, []);

  const handleCreateSaleRequest = useCallback(async () => {
    const origPrice = parseFloat(originalPrice.replace(',', '.'));
    const reqPrice = parseFloat(requestedPrice.replace(',', '.'));
    const qty = parseFloat(quantity) || 1;

    if (
      !selectedProduct?.id ||
      isNaN(origPrice) ||
      isNaN(reqPrice) ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      reqPrice <= 0 ||
      origPrice <= 0
    ) {
      Alert.alert(
        'Datos Incompletos',
        'Selecciona un producto del catálogo e ingresa cantidad y precios válidos.'
      );
      return;
    }

    try {
      setIsSubmitting(true);
      const discount = Math.max(0, (origPrice - reqPrice) * qty);
      const subtotal = origPrice * qty;
      const total = reqPrice * qty;

      await createSaleRequest({
        accountId: accountId || '',
        branchId: branchId || 'main',
        branchName: activeBranchName || 'Tienda Principal',
        sellerId: userProfile?.uid || 'seller_pos',
        sellerName: userProfile?.displayName || userProfile?.email || 'Vendedor de Piso',
        sellerEmail: userProfile?.email || '',
        customerName: customerName.trim() || 'Cliente General',
        items: [
          {
            productId: selectedProduct.id,
            productName: selectedProduct.name,
            sku: selectedProduct.sku || '',
            quantity: qty,
            originalPrice: origPrice,
            requestedPrice: reqPrice,
            price: reqPrice,
            subtotal: total,
            discountAmount: discount,
          },
        ],
        subtotal,
        discountTotal: discount,
        total,
        reason: reason.trim() || 'Descuento especial por volumen',
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onClose();
      Alert.alert(
        'Solicitud Enviada',
        'La solicitud de venta fue enviada a la bandeja de autorización.'
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo enviar la solicitud.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    originalPrice,
    requestedPrice,
    quantity,
    selectedProduct,
    accountId,
    branchId,
    activeBranchName,
    userProfile,
    customerName,
    reason,
    onClose,
  ]);

  const showEmptyCatalogMessage =
    !selectedProduct &&
    requestProductMatches.length === 0 &&
    debouncedProductSearch.trim().length > 0 &&
    requestProductSearch.trim() === debouncedProductSearch.trim();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleRequestClose}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalDialog}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nueva Solicitud de Venta</Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={handleRequestClose}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Cerrar nueva solicitud"
              >
                <X size={18} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
              <Text style={styles.dialogInputLabel}>Cliente:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Nombre de cliente o razón social"
                placeholderTextColor={ui.textMuted}
                value={customerName}
                onChangeText={setCustomerName}
              />

              <Text style={styles.dialogInputLabel}>Producto del catálogo:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Buscar por nombre o SKU"
                placeholderTextColor={ui.textMuted}
                value={requestProductSearch}
                onChangeText={handleProductSearchChange}
              />
              {selectedProduct ? (
                <TouchableOpacity
                  style={[styles.dialogInput, styles.selectedProductRow]}
                  onPress={handleClearProduct}
                >
                  <Text style={styles.selectedProductText}>
                    {selectedProduct.name} · {selectedProduct.sku || 'Sin SKU'}
                  </Text>
                  <Text style={styles.selectedProductChangeText}>Cambiar</Text>
                </TouchableOpacity>
              ) : requestProductMatches.length > 0 ? (
                <View style={styles.matchListContainer}>
                  {requestProductMatches.map((product) => (
                    <TouchableOpacity
                      key={product.id}
                      style={styles.matchListItem}
                      onPress={() => handleSelectProduct(product)}
                    >
                      <Text style={styles.matchListItemName}>{product.name}</Text>
                      <Text style={styles.matchListItemMeta}>
                        {product.sku || 'Sin SKU'} ·{' '}
                        {formatPEN(Number(product.suggestedPrice || product.price || 0))}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : showEmptyCatalogMessage ? (
                <Text style={styles.emptyMatchText}>
                  No hay productos coincidentes en el catálogo.
                </Text>
              ) : null}

              <View style={styles.twoColRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogInputLabel}>Cantidad:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="1"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    value={quantity}
                    onChangeText={setQuantity}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogInputLabel}>Precio Lista (S/):</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="100.00"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="decimal-pad"
                    value={originalPrice}
                    onChangeText={setOriginalPrice}
                  />
                </View>
              </View>

              <Text style={styles.dialogInputLabel}>
                Precio con Descuento Solicitado (S/):
              </Text>
              <TextInput
                style={[styles.dialogInput, { borderColor: ui.primary }]}
                placeholder="85.00"
                placeholderTextColor={ui.textMuted}
                keyboardType="decimal-pad"
                value={requestedPrice}
                onChangeText={setRequestedPrice}
              />

              <Text style={styles.dialogInputLabel}>Justificación / Motivo:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Ej: Cliente mayorista, paga al contado..."
                placeholderTextColor={ui.textMuted}
                value={reason}
                onChangeText={setReason}
              />
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                onPress={handleRequestClose}
                disabled={isSubmitting}
              >
                <Text style={styles.dialogCancelText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.dialogSubmitBtn, isSubmitting && styles.buttonDisabled]}
                onPress={handleCreateSaleRequest}
                disabled={isSubmitting}
              >
                <Send size={15} color={ui.onPrimary} />
                <Text style={styles.dialogSubmitText}>Enviar a Caja</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
