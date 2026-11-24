import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { Pause } from 'lucide-react-native';
import { usePausedSalesCount } from '@/context/CartContext';
import { ui } from '@/lib/theme';
import { posStyles as styles } from './posStyles';

interface PosPausedSalesBadgeProps {
  onPress: () => void;
}

/** Subscribes to cart paused sales so InlineFilterBar and the catalog list never re-render. */
export const PosPausedSalesBadge: React.FC<PosPausedSalesBadgeProps> = React.memo(({ onPress }) => {
  const pausedCount = usePausedSalesCount();

  if (pausedCount === 0) return null;

  return (
    <TouchableOpacity
      style={styles.pausedBadgeChip}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Ventas en pausa: ${pausedCount}`}
    >
      <Pause size={12} color={ui.primary} />
      <Text style={styles.pausedBadgeChipText}>Pausa ({pausedCount})</Text>
    </TouchableOpacity>
  );
});
