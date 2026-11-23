import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import NetInfo from '@react-native-community/netinfo';
import { useAuthSession } from '@/context/AuthContext';
import { useCart } from '@/context/CartContext';
import {
  useBusinessSettings,
  useCashSession,
  useOfflineStatus,
} from '@/context/SettingsContext';
import { createSaleTransaction, type CreateSaleTransactionParams } from '@/services/sale-service';
import { enqueueOfflineSale } from '@/services/offline-sync-service';
import { computeSaleTaxBreakdown } from '@/lib/invoicing/receipt-amounts';
import { resolveCheckoutPayment } from '@/lib/checkout-payment';
import { cleanFirestoreData } from '@/lib/firebase-utils';
import { presentationFactor } from '@/lib/presentation-parity';
import { formatPEN } from '@/lib/theme';
import { useProductsActions } from '@/context/ProductsContext';
import { createProductLookup, validateCartStockForCheckout } from '@/lib/offline-stock-helpers';

export interface QuickSaleBannerPayload {
  text: string;
  isOffline: boolean;
}

interface UseQuickSaleActionParams {
  onOpenCheckout: () => void;
  onShowQuickSaleBanner: (banner: QuickSaleBannerPayload) => void;
  onAfterSuccess?: () => void;
}

/** Shared 1-tap Quick Sale workflow used by both PosBottomCartBar and PosCartDrawerModal. */
export function useQuickSaleAction({
  onOpenCheckout,
  onShowQuickSaleBanner,
  onAfterSuccess,
}: UseQuickSaleActionParams) {
  const { accountId, branchId, user, userProfile } = useAuthSession();
  const { posSettings, paymentMethods, taxProfile } = useBusinessSettings();
  const { activeCashSession, refreshCashStatus } = useCashSession();
  const { isOnline: settingsIsOnline } = useOfflineStatus();
  const { getProductById, applyAuthoritativeStockUpdates } = useProductsActions();
  const {
    items,
    customer,
    discountAmount,
    shippingAmount,
    invoiceIntent,
    total,
    totalAmount,
    clearCart,
    setCustomer,
    setInvoiceIntent,
  } = useCart();

  const [isProcessingQuickSale, setIsProcessingQuickSale] = useState(false);
  const quickSaleInFlightRef = useRef(false);
  const safeTotal = totalAmount ?? total ?? 0;

  const handleInstantQuickSale = useCallback(async () => {
    if (quickSaleInFlightRef.current || items.length === 0 || safeTotal <= 0 || !accountId) return;
    if (posSettings?.enableQuickSale === false) return;

    if (invoiceIntent && invoiceIntent !== 'nota_venta') {
      Alert.alert(
        'Comprobante Seleccionado',
        'La Venta Rápida solo emite Nota de Venta en efectivo. Para emitir Boleta, Factura o Cotización pulsa "Cobrar".',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Ir a Cobrar',
            onPress: onOpenCheckout,
          },
        ]
      );
      return;
    }

    if ((posSettings as any)?.requireCashRegister !== false && !activeCashSession) {
      Alert.alert('Caja Cerrada', 'Abre un turno de caja para usar Venta Rápida o usa Cobrar.');
      return;
    }

    if (posSettings?.enableSellerAttribution === true && posSettings?.requireSellerSelection === true) {
      Alert.alert(
        'Vendedor Requerido',
        'Esta cuenta requiere elegir vendedor antes de cobrar.',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Ir a Cobrar',
            onPress: onOpenCheckout,
          },
        ]
      );
      return;
    }

    quickSaleInFlightRef.current = true;
    setIsProcessingQuickSale(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const configuredMethodsRaw =
        Array.isArray(posSettings?.methods) && posSettings.methods.length > 0
          ? posSettings.methods
          : Array.isArray(paymentMethods) && paymentMethods.length > 0
          ? paymentMethods
          : [{ id: 'efectivo', name: 'Efectivo', kind: 'cash', enabled: true, order: 0 }];

      const configuredMethods = configuredMethodsRaw.map((m: any) => ({
        ...m,
        reportCategory:
          m.reportCategory ||
          (m.kind === 'terminal' || m.kind === 'mixed'
            ? 'card'
            : m.kind === 'credit'
            ? 'credit'
            : m.kind === 'digital'
            ? 'digital'
            : 'cash'),
      }));

      const cashMethod = configuredMethods.find(
        (m: any) => m.enabled !== false && (m.kind === 'cash' || String(m.id).toLowerCase() === 'efectivo')
      );
      const selectedMethodId = cashMethod?.id || 'efectivo';
      const payment = resolveCheckoutPayment({
        methods: configuredMethods,
        selectedMethodId,
        category: 'cash',
        total: safeTotal,
      });

      const saleItems = cleanFirestoreData(
        items.map((i) => {
          const resolvedId =
            (i as any).productId ||
            (i as any).product?.id ||
            (i.id.includes('_') ? i.id.split('_')[0] : i.id);
          const { product: _omitProduct, ...cleanI } = i as any;
          const factor =
            cleanI.presentationQty || cleanI.conversionFactor || presentationFactor(cleanI.presentation);
          return {
            productId: resolvedId,
            name: cleanI.name,
            quantity: cleanI.quantity,
            price: cleanI.price,
            costPrice: cleanI.costPrice || 0,
            total: cleanI.lineTotal !== undefined ? cleanI.lineTotal : cleanI.price * cleanI.quantity,
            sku: cleanI.sku || '',
            unitOfMeasure: cleanI.unitOfMeasure || 'NIU',
            presentation: cleanI.presentation || null,
            variant: cleanI.variant || null,
            variantId: cleanI.variantId || cleanI.variant?.id,
            variantName: cleanI.variantName || cleanI.variant?.name,
            presentationId: cleanI.presentationId,
            presentationName: cleanI.presentationName,
            presentationQty: factor,
            conversionFactor: factor,
            stockBranchId: cleanI.stockBranchId || branchId || 'main',
            isGift: Boolean(cleanI.isGift),
            originalPrice: cleanI.originalPrice,
            priceModificationReason: cleanI.priceModificationReason,
            isWeightBased: cleanI.isWeightBased || false,
          };
        })
      );

      const saleTimestamp = Date.now();
      const opId = `quick_${saleTimestamp}_${Math.random().toString(36).slice(2, 9)}`;
      const isServerAttributed = posSettings?.enableSellerAttribution === true;
      const itemsGrossSubtotal =
        Math.round(
          items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0), 0) *
            100
        ) / 100;
      const netSubtotal = Math.max(0, safeTotal - shippingAmount);
      const breakdown = computeSaleTaxBreakdown(netSubtotal, 'nota_venta', taxProfile);
      const netInfo = await NetInfo.fetch();
      const isOnline =
        settingsIsOnline && Boolean(netInfo.isConnected && netInfo.isInternetReachable !== false);

      const salePayload: CreateSaleTransactionParams = {
        accountId,
        branchId: branchId || 'main',
        userId: user?.uid || 'user_mobile',
        userName: userProfile?.displayName || user?.displayName || user?.email || 'Cajero POS',
        userRole: userProfile?.role || undefined,
        items: saleItems,
        paymentMethod: 'cash',
        paymentMethodId: payment.paymentMethodId,
        paymentMethodName: payment.paymentMethodName,
        commissionPercent: cashMethod?.commissionPercent,
        commissionRule: cashMethod?.commissionRule,
        chargedAmount: payment.chargedAmount,
        commissionAmount: payment.commissionAmount,
        surchargeAmount: payment.surchargeAmount,
        netAmount: payment.netAmount,
        documentType: 'nota_venta',
        subtotal: isServerAttributed ? itemsGrossSubtotal : breakdown.subtotal,
        tax: 0,
        taxExemptionCode: breakdown.taxExemptionCode,
        isAmazonExempt: breakdown.isAmazonExempt,
        total: safeTotal,
        shippingAmount,
        discountAmount,
        payments: cleanFirestoreData(payment.payments),
        cashReceived: payment.chargedAmount,
        changeGiven: 0,
        customer: customer
          ? {
              id: customer.id,
              name: customer.name || 'Cliente Varios',
              dni: customer.dni || undefined,
              ruc: customer.ruc || undefined,
              phone: customer.phone || undefined,
              address: customer.address || undefined,
              documentType: customer.ruc ? 'RUC' : customer.dni ? 'DNI' : undefined,
              documentNumber: customer.ruc || customer.dni || undefined,
            }
          : { name: 'Cliente Varios' },
        customerId: customer?.id,
        customerName: customer?.name || 'Cliente Varios',
        sessionId: activeCashSession?.sessionId || activeCashSession?.id,
        saleDate: saleTimestamp,
        offlineId: opId,
        skipOfflineDedup: isOnline,
        enableSellerAttribution: isServerAttributed,
        isQuote: false,
      };

      let labelText = '';
      if (isOnline) {
        const result = await createSaleTransaction(salePayload);
        if (Array.isArray(result?.updatedProductStocks) && result.updatedProductStocks.length > 0) {
          applyAuthoritativeStockUpdates(result.updatedProductStocks);
        }
        refreshCashStatus();
        const corr = result?.correlative || `#${result?.saleNumber || ''}`;
        labelText = `Venta rápida ${corr} · ${formatPEN(safeTotal)}`;
      } else {
        const stockCheck = validateCartStockForCheckout(
          saleItems as any[],
          createProductLookup(getProductById),
          branchId || 'main'
        );
        if (!stockCheck.ok) {
          throw new Error(stockCheck.error || 'Stock insuficiente para completar la venta.');
        }
        // enqueueOfflineSale emits queue change events handled by SettingsContext/ProductsContext
        await enqueueOfflineSale(salePayload);
        labelText = `Venta rápida offline · ${formatPEN(safeTotal)}`;
      }

      clearCart();
      setCustomer(null);
      setInvoiceIntent(null);
      onAfterSuccess?.();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onShowQuickSaleBanner({ text: labelText, isOffline: !isOnline });
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error en Venta Rápida', err?.message || 'No se pudo procesar la venta rápida.');
    } finally {
      quickSaleInFlightRef.current = false;
      setIsProcessingQuickSale(false);
    }
  }, [
    accountId,
    activeCashSession,
    applyAuthoritativeStockUpdates,
    branchId,
    clearCart,
    customer,
    discountAmount,
    getProductById,
    invoiceIntent,
    items,
    onAfterSuccess,
    onOpenCheckout,
    onShowQuickSaleBanner,
    paymentMethods,
    posSettings,
    refreshCashStatus,
    safeTotal,
    setCustomer,
    setInvoiceIntent,
    settingsIsOnline,
    shippingAmount,
    taxProfile,
    user?.displayName,
    user?.email,
    user?.uid,
    userProfile?.displayName,
    userProfile?.role,
  ]);

  return {
    isProcessingQuickSale,
    handleInstantQuickSale,
  };
}
