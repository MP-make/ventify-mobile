import React, { useMemo, useCallback } from 'react';
import { Modal, View, Text, TouchableOpacity } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Scale, X } from 'lucide-react-native';
import { useProducts } from '@/context/ProductsContext';
import { formatPEN, ui } from '@/lib/theme';
import type { Product } from '@/types';
import { posStyles as styles } from './posStyles';

interface PosWeighablePickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectProduct: (product: Product) => void;
}

const weighableKeyExtractor = (item: Product) => item.id;

interface WeighableRowProps {
  product: Product;
  onSelect: (product: Product) => void;
}

const WeighableProductRow = React.memo<WeighableRowProps>(({ product, onSelect }) => {
  const handlePress = useCallback(() => {
    onSelect(product);
  }, [onSelect, product]);

  return (
    <TouchableOpacity style={styles.weightItemRow} onPress={handlePress}>
      <Text style={styles.weightItemName} numberOfLines={1}>
        {product.name}
      </Text>
      <Text style={styles.weightItemPrice}>
        {formatPEN(product.suggestedPrice ?? product.price ?? 0)} / kg
      </Text>
    </TouchableOpacity>
  );
});

export const PosWeighablePickerModal: React.FC<PosWeighablePickerModalProps> = React.memo(
  ({ visible, onClose, onSelectProduct }) => {
    const { products } = useProducts();

    const weighableProducts = useMemo(() => {
      if (!visible) return [];
      return products.filter(
        (p) =>
          p.allowDecimals ||
          p.unitOfMeasure === 'kg' ||
          p.unitOfMeasure === 'KGM' ||
          (p as any).unit === 'kg'
      );
    }, [visible, products]);

    const renderWeighableItem = useCallback(
      ({ item }: { item: Product }) => (
        <WeighableProductRow product={item} onSelect={onSelectProduct} />
      ),
      [onSelectProduct]
    );

    const listHeight = Math.min(320, Math.max(84, weighableProducts.length * 44));

    return (
      <Modal
        visible={visible}
        animationType="fade"
        transparent
        onRequestClose={onClose}
      >
        <View style={styles.subModalOverlay}>
          <View style={styles.subModalCard}>
            <View style={styles.subModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Scale size={18} color={ui.accent} />
                <Text style={styles.subModalTitle}>Productos Pesables</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {weighableProducts.length === 0 ? (
              <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                <Text style={{ color: ui.textSecondary, fontSize: 13 }}>
                  No hay productos pesables disponibles.
                </Text>
              </View>
            ) : (
              <View style={{ height: listHeight }}>
                <FlashList
                  data={weighableProducts}
                  estimatedItemSize={44}
                  keyExtractor={weighableKeyExtractor}
                  renderItem={renderWeighableItem}
                />
              </View>
            )}
          </View>
        </View>
      </Modal>
    );
  }
);
