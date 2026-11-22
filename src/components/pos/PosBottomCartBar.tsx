import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShoppingBag, ChevronUp, Zap, ArrowRight } from 'lucide-react-native';
import { useCart } from '@/context/CartContext';
import { useBusinessSettings } from '@/context/SettingsContext';
import { formatPEN, ui } from '@/lib/theme';
import { posStyles as styles } from './posStyles';
import { useQuickSaleAction, type QuickSaleBannerPayload } from './useQuickSaleAction';

interface PosBottomCartBarProps {
  onOpenCartDrawer: () => void;
  onOpenCheckout: () => void;
  onShowQuickSaleBanner: (banner: QuickSaleBannerPayload) => void;
}

/** Floating POS checkout footer subscribing to CartContext without re-rendering the catalog grid. */
export const PosBottomCartBar: React.FC<PosBottomCartBarProps> = React.memo(
  ({ onOpenCartDrawer, onOpenCheckout, onShowQuickSaleBanner }) => {
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const isCompact = width < 360;
    const { posSettings } = useBusinessSettings();
    const {
      total,
      totalAmount,
      itemCount,
      totalItemsCount,
      saleRequestId,
      sourceQuoteId,
    } = useCart();

    const safeTotal = totalAmount ?? total ?? 0;
    const formattedTotal = formatPEN(safeTotal);
    const safeCount = itemCount ?? totalItemsCount ?? 0;

    const { isProcessingQuickSale, handleInstantQuickSale } = useQuickSaleAction({
      onOpenCheckout,
      onShowQuickSaleBanner,
    });

    return (
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TouchableOpacity
          style={styles.cartSummaryToggle}
          onPress={onOpenCartDrawer}
          accessibilityRole="button"
          accessibilityLabel={`Ver carrito, ${safeCount} ${safeCount === 1 ? 'ítem' : 'ítems'}, total ${formattedTotal}`}
          activeOpacity={0.8}
        >
          <View style={styles.cartIconWrapper}>
            <ShoppingBag size={20} color={ui.text} />
            {safeCount > 0 ? (
              <View style={styles.cartItemCountBadge}>
                <Text style={styles.cartItemCountText}>{safeCount}</Text>
              </View>
            ) : null}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.cartDrawerHint} numberOfLines={1}>
              {safeCount} {safeCount === 1 ? 'prod.' : 'prods.'}
            </Text>
            <Text style={styles.cartTotalSummaryText} numberOfLines={1}>
              Ver carrito
            </Text>
          </View>
          <ChevronUp size={16} color={ui.textSecondary} />
        </TouchableOpacity>

        {safeCount > 0 &&
        safeTotal > 0 &&
        posSettings?.enableQuickSale !== false &&
        !sourceQuoteId &&
        !saleRequestId ? (
          <TouchableOpacity
            style={styles.quickSaleBtn}
            onPress={handleInstantQuickSale}
            disabled={isProcessingQuickSale}
            accessibilityRole="button"
            accessibilityLabel={`Venta rápida en efectivo por ${formattedTotal}`}
            activeOpacity={0.8}
          >
            {isProcessingQuickSale ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <>
                <Zap size={17} color={ui.primary} />
                <Text style={styles.quickSaleBtnText}>Rápida</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={[
            styles.checkoutBtn,
            (safeCount === 0 || safeTotal <= 0) && styles.checkoutBtnDisabled,
          ]}
          onPress={onOpenCheckout}
          disabled={safeCount === 0 || safeTotal <= 0}
          accessibilityRole="button"
          accessibilityLabel={`Cobrar ${formattedTotal}`}
          activeOpacity={0.8}
        >
          <Text
            style={[styles.checkoutBtnText, isCompact && styles.checkoutBtnTextCompact]}
            numberOfLines={1}
          >
            Cobrar · {formattedTotal}
          </Text>
          <ArrowRight size={20} color={ui.onPrimary} />
        </TouchableOpacity>
      </View>
    );
  }
);
