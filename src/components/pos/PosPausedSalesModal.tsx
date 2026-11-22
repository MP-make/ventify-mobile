import React, { useCallback } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { Clock, X, User, Play, Trash2, Pause } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useCart } from '@/context/CartContext';
import { formatPEN, ui } from '@/lib/theme';
import { posStyles as styles } from './posStyles';

interface PosPausedSalesModalProps {
  visible: boolean;
  onClose: () => void;
}

export const PosPausedSalesModal: React.FC<PosPausedSalesModalProps> = React.memo(
  ({ visible, onClose }) => {
    const { items, customer, pausedSales, pauseCurrentSale, resumePausedSale, deletePausedSale } =
      useCart();

    const handleResumePausedSale = useCallback(
      async (id: string) => {
        await resumePausedSale(id);
        onClose();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      [resumePausedSale, onClose]
    );

    const handlePauseCurrentSale = useCallback(async () => {
      onClose();
      if (items.length === 0) {
        Alert.alert('Carrito Vacío', 'Agrega productos antes de pausar la venta.');
        return;
      }
      const customerName = customer?.name?.trim();
      const itemsCountStr = `${items.length} ${items.length === 1 ? 'ítem' : 'ítems'}`;
      const label = customerName
        ? `${customerName} (${itemsCountStr})`
        : `Cuenta ${pausedSales.length + 1} (${itemsCountStr})`;

      await pauseCurrentSale(label);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Venta en Espera', `La cuenta "${label}" ha sido retenida.`);
    }, [onClose, items.length, customer?.name, pausedSales.length, pauseCurrentSale]);

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
                <Clock size={18} color={ui.primary} />
                <Text style={styles.subModalTitle}>Ventas en Pausa ({pausedSales.length})</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            {pausedSales.length === 0 ? (
              <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                <Text style={{ color: ui.textSecondary, fontSize: 13 }}>
                  No hay ventas en espera actualmente.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 300 }}>
                {pausedSales.map((ps) => (
                  <View key={ps.id} style={styles.pausedItemCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pausedItemTitle}>{ps.label}</Text>
                      {Boolean(ps.customer?.name) && (
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 4,
                            marginTop: 2,
                            marginBottom: 2,
                          }}
                        >
                          <User size={12} color={ui.primary} />
                          <Text
                            style={{ fontSize: 12, color: ui.text, fontWeight: '600' }}
                            numberOfLines={1}
                          >
                            {ps.customer?.name}
                          </Text>
                        </View>
                      )}
                      <Text style={styles.pausedItemDetails}>
                        {ps.items?.length || 0} ítems | Total: {formatPEN(ps.total || 0)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity
                        style={styles.pausedResumeBtn}
                        onPress={() => handleResumePausedSale(ps.id)}
                      >
                        <Play size={14} color={ui.onPrimary} />
                        <Text style={styles.pausedResumeBtnText}>Recuperar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.pausedDeleteBtn}
                        onPress={() => deletePausedSale(ps.id)}
                      >
                        <Trash2 size={14} color={ui.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}

            <TouchableOpacity
              style={styles.pauseCurrentActionBtn}
              onPress={handlePauseCurrentSale}
            >
              <Pause size={16} color={ui.text} />
              <Text style={styles.pauseCurrentActionText}>Pausar Carrito Actual</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }
);
