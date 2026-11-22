import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Minus, Plus, Edit3, Trash2, Gift } from 'lucide-react-native';
import { formatPEN, ui } from '@/lib/theme';
import type { CartItem } from '@/types';
import { posStyles as styles } from './posStyles';

export interface PosCartItemRowProps {
  item: CartItem;
  isEditingPrice: boolean;
  canModifyPrice: boolean;
  onUpdateQuantity: (id: string, qty: number) => void;
  onRemoveItem: (id: string) => void;
  onStartEditPrice: (item: CartItem) => void;
  onSavePrice: (item: CartItem, rawPriceStr: string) => void;
}

/** Isolates inline price-draft text state so keystrokes only re-render the edited row. */
export const PosCartItemRow = React.memo<PosCartItemRowProps>(({
  item,
  isEditingPrice,
  canModifyPrice,
  onUpdateQuantity,
  onRemoveItem,
  onStartEditPrice,
  onSavePrice,
}) => {
  const [draftPriceStr, setDraftPriceStr] = useState(() => String(item.price));

  useEffect(() => {
    if (isEditingPrice) {
      setDraftPriceStr(String(item.price));
    }
  }, [isEditingPrice, item.price]);

  const handleDecrement = useCallback(() => {
    onUpdateQuantity(item.id, item.quantity - 1);
  }, [onUpdateQuantity, item.id, item.quantity]);

  const handleIncrement = useCallback(() => {
    onUpdateQuantity(item.id, item.quantity + 1);
  }, [onUpdateQuantity, item.id, item.quantity]);

  const handleRemove = useCallback(() => {
    onRemoveItem(item.id);
  }, [onRemoveItem, item.id]);

  const handleStartEdit = useCallback(() => {
    onStartEditPrice(item);
  }, [onStartEditPrice, item]);

  const handleCommitPrice = useCallback(() => {
    onSavePrice(item, draftPriceStr);
  }, [onSavePrice, item, draftPriceStr]);

  const itemPrice = item.price;
  const itemSubtotal = item.lineTotal !== undefined ? item.lineTotal : itemPrice * item.quantity;

  return (
    <View style={styles.drawerCartItem}>
      <View style={styles.drawerCartItemTop}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={styles.drawerCartItemName}>{item.name}</Text>
            {item.isGift ? (
              <View style={styles.giftBadgePill}>
                <Gift size={10} color={ui.primary} />
                <Text style={styles.giftBadgePillText}>REGALO</Text>
              </View>
            ) : null}
          </View>
          {item.presentation ? (
            <Text style={styles.drawerCartItemSub}>
              Pres: {item.presentation.name} (x{item.presentation.conversionFactor})
            </Text>
          ) : item.variant ? (
            <Text style={styles.drawerCartItemSub}>Var: {item.variant.name}</Text>
          ) : null}
        </View>
        <Text style={styles.drawerCartItemSubtotal}>
          {item.isGift ? 'GRATIS' : formatPEN(itemSubtotal)}
        </Text>
      </View>

      <View style={styles.drawerCartItemControls}>
        <View style={styles.qtyControlRow}>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={handleDecrement}
            accessibilityRole="button"
            accessibilityLabel={`Reducir cantidad de ${item.name}`}
          >
            <Minus size={15} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.qtyNumberText}>{item.quantity}</Text>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={handleIncrement}
            accessibilityRole="button"
            accessibilityLabel={`Aumentar cantidad de ${item.name}`}
          >
            <Plus size={15} color={ui.text} />
          </TouchableOpacity>
        </View>

        {item.isGift ? (
          <View style={styles.unitPriceBadge}>
            <Text style={[styles.unitPriceBadgeText, { color: ui.primary }]}>
              S/ 0.00 (Regalo)
            </Text>
          </View>
        ) : isEditingPrice ? (
          <View style={styles.editPriceInputRow}>
            <TextInput
              style={styles.editPriceInput}
              value={draftPriceStr}
              onChangeText={setDraftPriceStr}
              keyboardType="decimal-pad"
              placeholder="0.00"
              autoFocus
            />
            <TouchableOpacity style={styles.savePriceBtn} onPress={handleCommitPrice}>
              <Text style={styles.savePriceBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        ) : canModifyPrice ? (
          <TouchableOpacity
            style={styles.unitPriceBadge}
            accessibilityRole="button"
            accessibilityLabel={`Editar precio de ${item.name}, ${formatPEN(itemPrice)} por ${item.unitOfMeasure || 'unidad'}`}
            onPress={handleStartEdit}
          >
            <Text style={styles.unitPriceBadgeText}>
              {formatPEN(itemPrice)} / {item.unitOfMeasure || 'und'}
            </Text>
            <Edit3 size={12} color={ui.textSecondary} style={{ marginLeft: 4 }} />
          </TouchableOpacity>
        ) : (
          <View style={styles.unitPriceBadge}>
            <Text style={styles.unitPriceBadgeText}>
              {formatPEN(itemPrice)} / {item.unitOfMeasure || 'und'}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.deleteItemBtn}
          onPress={handleRemove}
          accessibilityRole="button"
          accessibilityLabel={`Quitar ${item.name} del carrito`}
        >
          <Trash2 size={16} color={ui.danger} />
        </TouchableOpacity>
      </View>
    </View>
  );
});
