/**
 * Ventify Mobile - Quotes Manager Modal
 * 
 * Modal nativo de gestión integral de Cotizaciones:
 * - Listado en tiempo real con buscador y filtro por estado (Pendiente, Aceptada, Rechazada, Convertida).
 * - Detalle completo de cotización (ítems, cliente, fechas, vigencia, notas, totales en Soles).
 * - Acciones comerciales:
 *   1. "Cargar al Carrito POS / Convertir a Venta": Limpia el carrito, inyecta ítems y cliente,
 *      marca la cotización y redirige al mostrador listo para cobrar.
 *   2. "Compartir Cotización PDF por WhatsApp": Renderiza un PDF formal y lo comparte por WhatsApp.
 *   3. Cambio de estado a "Aceptada" o "Rechazada".
 *   4. Eliminación de cotización con confirmación de seguridad.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Share,
  Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  Search,
  ShoppingCart,
  Share2,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  User,
  Calendar,
  AlertCircle,
  FileText,
  DollarSign,
  ChevronRight,
  ArrowLeft,
  Phone,
  Mail,
  MapPin,
  Check,
  RefreshCw,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useCart } from '@/context/CartContext';
import { theme, ui, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import {
  Quote,
  QuoteItem,
  QuoteStatus,
  subscribeToQuotes,
  getQuotes,
  updateQuoteStatus,
  deleteQuote,
  convertQuoteToSale,
} from '@/services/enterprise-ops-service';
import { shareTicketWhatsApp } from '@/services/thermal-printer-service';
import type { Product, Customer } from '@/types';

export interface QuotesManagerModalProps {
  visible?: boolean;
  isOpen?: boolean; // Convención alternativa de visibilidad
  onClose: () => void;
  onLoadQuoteToPos?: (quote: Quote) => void;
}

// Helper de badges de estado
const getStatusBadge = (status: QuoteStatus, expiryDate?: number) => {
  const isExpired = expiryDate ? Date.now() > expiryDate : false;

  if (status === 'converted') {
    return {
      label: 'Convertida en Venta',
      bg: ui.primarySoft,
      text: ui.primary,
      border: 'rgba(59, 130, 246, 0.3)',
    };
  }
  if (status === 'accepted') {
    return {
      label: 'Aceptada',
      bg: ui.primarySoft,
      text: ui.primary,
      border: 'rgba(16, 185, 129, 0.3)',
    };
  }
  if (status === 'rejected') {
    return {
      label: 'Rechazada',
      bg: ui.dangerSoft,
      text: ui.danger,
      border: 'rgba(239, 68, 68, 0.3)',
    };
  }
  if (isExpired) {
    return {
      label: 'Vencida',
      bg: ui.warningSoft,
      text: ui.warning,
      border: 'rgba(245, 158, 11, 0.4)',
    };
  }
  return {
    label: 'Pendiente',
    bg: ui.warningSoft,
    text: ui.warning,
    border: 'rgba(245, 158, 11, 0.3)',
  };
};

interface QuoteCardItemProps {
  quote: Quote;
  onSelect: (quote: Quote) => void;
}

const QuoteCardItem = React.memo<QuoteCardItemProps>(({ quote, onSelect }) => {
  const badge = getStatusBadge(quote.status, quote.expiryDate);
  return (
    <TouchableOpacity
      style={styles.quoteCard}
      onPress={() => onSelect(quote)}
      activeOpacity={0.75}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <Text style={styles.cardNumber}>{quote.formattedNumber}</Text>
          <Text style={styles.cardCustomerName} numberOfLines={1}>
            {quote.customerName}
          </Text>
        </View>

        <View
          style={[
            styles.statusBadge,
            { backgroundColor: badge.bg, borderColor: badge.border },
          ]}
        >
          <Text style={[styles.statusBadgeText, { color: badge.text }]}>
            {badge.label}
          </Text>
        </View>
      </View>

      <View style={styles.cardBody}>
        <View style={styles.cardInfoCol}>
          <Text style={styles.cardItemCountText}>
            {quote.items.length} {quote.items.length === 1 ? 'producto' : 'productos'}
          </Text>
          <Text style={styles.cardDateText}>
            Emisión: {formatDatePE(quote.date)}
          </Text>
        </View>

        <View style={styles.cardPriceCol}>
          <Text style={styles.cardTotalAmount}>{formatPEN(quote.total)}</Text>
          <View style={styles.cardDetailsArrow}>
            <Text style={styles.cardDetailsText}>Ver Detalle</Text>
            <ChevronRight size={14} color={ui.primary} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
});

export const QuotesManagerModal: React.FC<QuotesManagerModalProps> = React.memo(({
  visible,
  isOpen,
  onClose,
  onLoadQuoteToPos,
}) => {
  const insets = useSafeAreaInsets();
  const isVisible = visible !== undefined ? visible : Boolean(isOpen);

  const { accountId, branchId } = useAuth();
  const { businessSettings, activeBranchName } = useSettings();
  const { clearCart, addItem, setCustomer, setNotes, setSourceQuoteId, setSaleRequestId, setDiscount, setShippingAmount } = useCart();

  // Estados de lista y filtros
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | 'all'>('all');

  // Estado de cotización seleccionada para ver detalles
  const [selectedQuote, setSelectedQuote] = useState<Quote | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // 1. Suscripción en tiempo real a las cotizaciones
  useEffect(() => {
    if (!isVisible || !accountId) return;

    setLoading(true);
    const unsubscribe = subscribeToQuotes(
      accountId,
      (data) => {
        setQuotes(data);
        setLoading(false);

        // Si hay una seleccionada, refrescar sus datos sin depender de stale closure
        setSelectedQuote((curr) => {
          if (!curr) return null;
          const fresh = data.find((q) => q.id === curr.id);
          return fresh || curr;
        });
      },
      branchId,
      (err) => {
        console.warn('[QuotesManagerModal] Error suscribiendo a cotizaciones:', err);
        setLoading(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [isVisible, accountId, branchId]);

  // 2. Filtrar cotizaciones por texto y estado
  const filteredQuotes = useMemo(() => {
    let result = [...quotes];

    if (statusFilter !== 'all') {
      result = result.filter((q) => q.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const term = searchQuery.toLowerCase().trim();
      result = result.filter(
        (q) =>
          q.customerName.toLowerCase().includes(term) ||
          q.formattedNumber.toLowerCase().includes(term) ||
          (q.customerDni && q.customerDni.includes(term)) ||
          (q.customerRuc && q.customerRuc.includes(term)) ||
          (q.customerPhone && q.customerPhone.includes(term)) ||
          q.items.some((it) => it.name.toLowerCase().includes(term))
      );
    }

    return result;
  }, [quotes, statusFilter, searchQuery]);

  // Métricas rápidas
  const metrics = useMemo(() => {
    const totalCount = quotes.length;
    const pendingCount = quotes.filter((q) => q.status === 'pending').length;
    const pendingAmount = quotes
      .filter((q) => q.status === 'pending')
      .reduce((sum, q) => sum + (q.total || 0), 0);

    return { totalCount, pendingCount, pendingAmount };
  }, [quotes]);

  // 3. ACCIÓN: Cargar al Carrito POS / Convertir a Venta
  const handleLoadQuoteToPos = useCallback(
    async (quote: Quote) => {
      try {
        const lineTotal = quote.items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
        const shipping = Math.max(0, Number(quote.shippingAmount) || 0);
        const residualDiscount = lineTotal - (Number(quote.total || 0) - shipping);
        if (quote.items.some((item) => !item.id) || residualDiscount < -0.02) {
          Alert.alert('Cotización no disponible para POS', 'Los productos o el total de esta cotización no coinciden con el catálogo. Actualiza la cotización antes de cobrarla.');
          return;
        }
        setIsProcessing(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

        // 1. Limpiar carrito actual
        clearCart();

        // 2. Establecer cliente si existe
        if (quote.customerId && quote.customerName && quote.customerName !== 'Cliente General') {
          const clientObj: Customer = {
            id: quote.customerId,
            name: quote.customerName,
            dni: quote.customerDni || undefined,
            ruc: quote.customerRuc || undefined,
            phone: quote.customerPhone || undefined,
            email: quote.customerEmail || undefined,
            address: quote.customerAddress || undefined,
            totalPurchases: 0,
            totalSpent: 0,
            accountId: quote.accountId || accountId || '',
          };
          setCustomer(clientObj);
        } else setCustomer(null);

        // 3. Cargar ítems al carrito resolviendo presentaciones/variantes
        quote.items.forEach((item) => {
          const productStub: Product = {
            id: item.id,
            name: item.name,
            category: item.category || 'General',
            sku: item.sku || item.id,
            costPrice: item.costPrice || 0,
            minSalePrice: item.minSalePrice || 0,
            suggestedPrice: item.suggestedPrice || item.price,
            price: item.price,
            stock: item.stock || {},
            accountId: quote.accountId || accountId || '',
          };

          addItem(productStub, {
            quantity: item.quantity,
            customPrice: item.price,
            notes: item.hint,
            presentation: item.presentationId
              ? {
                  id: item.presentationId,
                  name: item.presentationName || '',
                  conversionFactor: item.presentationQty || 1,
                  price: item.price,
                }
              : undefined,
            variant: item.variantId
              ? {
                  id: item.variantId,
                  name: item.variantName || '',
                  stock: {},
                }
              : undefined,
          });
        });

        setSourceQuoteId(quote.id);
        setSaleRequestId(null);
        setDiscount(Math.max(0, Math.round(residualDiscount * 100) / 100));
        setShippingAmount(shipping);

        // 4. Copiar notas
        if (quote.notes) {
          setNotes(`Cotización ${quote.formattedNumber}: ${quote.notes}`);
        } else {
          setNotes(`Cotización ${quote.formattedNumber}`);
        }

        // La cotización solo cambia a convertida dentro de la transacción real de cobro.
        // 6. Callback opcional de navegación/control
        if (onLoadQuoteToPos) {
          onLoadQuoteToPos(quote);
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        onClose();

        Alert.alert(
          'Cotización en Mostrador',
          `Se cargaron ${quote.items.length} productos de ${quote.formattedNumber} al Carrito POS.\nTotal: ${formatPEN(
            quote.total
          )}`,
          [{ text: 'Ir a Cobrar', style: 'default' }]
        );
      } catch (err: any) {
        console.error('[QuotesManagerModal] Error al cargar cotización al POS:', err);
        Alert.alert('Error', err?.message || 'No se pudo cargar la cotización al carrito.');
      } finally {
        setIsProcessing(false);
      }
    },
    [clearCart, setCustomer, addItem, setNotes, setSourceQuoteId, setSaleRequestId, setDiscount, setShippingAmount, accountId, onLoadQuoteToPos, onClose]
  );

  // 4. ACCIÓN: Compartir Cotización PDF por WhatsApp
  const handleShareQuoteWhatsApp = useCallback(
    async (quote: Quote) => {
      try {
        setIsProcessing(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

        const bizName = businessSettings.businessName || 'Ventify Negocios';
        const bizRuc = businessSettings.ruc ? `RUC: ${businessSettings.ruc}` : '';
        const bizAddress = businessSettings.address || '';
        const bizPhone = businessSettings.phone || '';

        // Construir tabla de ítems en HTML para renderizado PDF
        const itemsHtml = quote.items
          .map(
            (it) => `
            <tr>
              <td style="padding: 6px 4px; border-bottom: 1px solid #E5E7EB; text-align: left; font-size: 11px;">
                <strong>${it.name}</strong>
                ${it.presentationName ? `<br><small style="color:#6B7280;">Pres: ${it.presentationName}</small>` : ''}
              </td>
              <td style="padding: 6px 4px; border-bottom: 1px solid #E5E7EB; text-align: center; font-size: 11px;">${it.quantity}</td>
              <td style="padding: 6px 4px; border-bottom: 1px solid #E5E7EB; text-align: right; font-size: 11px;">${formatPEN(it.price)}</td>
              <td style="padding: 6px 4px; border-bottom: 1px solid #E5E7EB; text-align: right; font-size: 11px; font-weight: 600;">${formatPEN(
                it.quantity * it.price
              )}</td>
            </tr>
          `
          )
          .join('');

        const quoteHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8" />
            <title>Cotización ${quote.formattedNumber}</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 24px; color: #111827; max-width: 650px; margin: 0 auto; }
              .header { text-align: center; border-bottom: 2px dashed #9CA3AF; padding-bottom: 16px; margin-bottom: 16px; }
              .biz-title { font-size: 22px; font-weight: 800; color: #059669; margin: 0 0 4px 0; }
              .biz-detail { font-size: 12px; color: #4B5563; margin: 2px 0; }
              .badge-box { display: inline-block; background: #111827; color: #FFFFFF; font-weight: 700; font-size: 14px; padding: 6px 14px; border-radius: 6px; margin-top: 10px; }
              .info-section { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 12px; }
              .info-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
              .info-label { font-weight: 600; color: #4B5563; }
              .info-val { color: #111827; }
              table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
              th { background: #F3F4F6; color: #374151; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 8px 4px; border-bottom: 2px solid #E5E7EB; }
              .totals-section { border-top: 2px dashed #9CA3AF; padding-top: 10px; margin-bottom: 20px; font-size: 13px; }
              .total-line { display: flex; justify-content: space-between; margin-bottom: 4px; }
              .grand-total { font-size: 18px; font-weight: 800; color: #059669; }
              .terms-box { background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 8px; padding: 12px; font-size: 11px; color: #065F46; line-height: 1.4; }
              .footer { text-align: center; margin-top: 24px; font-size: 11px; color: #9CA3AF; border-top: 1px solid #E5E7EB; padding-top: 12px; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1 class="biz-title">${bizName}</h1>
              ${bizRuc ? `<p class="biz-detail">${bizRuc}</p>` : ''}
              ${bizAddress ? `<p class="biz-detail">${bizAddress}</p>` : ''}
              ${bizPhone ? `<p class="biz-detail">Tel/Cel: ${bizPhone}</p>` : ''}
              <div>
                <span class="badge-box">COTIZACIÓN N° ${quote.formattedNumber}</span>
              </div>
            </div>

            <div class="info-section">
              <div class="info-row">
                <span class="info-label">Cliente:</span>
                <span class="info-val"><strong>${quote.customerName}</strong></span>
              </div>
              ${
                quote.customerDni || quote.customerRuc
                  ? `<div class="info-row">
                      <span class="info-label">Documento:</span>
                      <span class="info-val">${quote.customerDni ? `DNI: ${quote.customerDni}` : `RUC: ${quote.customerRuc}`}</span>
                    </div>`
                  : ''
              }
              ${
                quote.customerPhone
                  ? `<div class="info-row">
                      <span class="info-label">Teléfono:</span>
                      <span class="info-val">${quote.customerPhone}</span>
                    </div>`
                  : ''
              }
              <div class="info-row">
                <span class="info-label">Fecha de Emisión:</span>
                <span class="info-val">${formatDatePE(quote.date)}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Fecha de Vencimiento:</span>
                <span class="info-val"><strong>${formatDatePE(quote.expiryDate)}</strong> (Válido ${quote.validityDays} días)</span>
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th style="text-align: left;">Descripción</th>
                  <th style="text-align: center; width: 60px;">Cant.</th>
                  <th style="text-align: right; width: 90px;">P. Unit</th>
                  <th style="text-align: right; width: 90px;">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                ${itemsHtml}
              </tbody>
            </table>

            <div class="totals-section">
              <div class="total-line">
                <span>Subtotal:</span>
                <span>${formatPEN(quote.subtotal)}</span>
              </div>
              ${
                quote.tax > 0
                  ? `<div class="total-line">
                      <span>IGV (18%):</span>
                      <span>${formatPEN(quote.tax)}</span>
                    </div>`
                  : ''
              }
              <div class="total-line grand-total" style="margin-top: 8px;">
                <span>TOTAL:</span>
                <span>${formatPEN(quote.total)}</span>
              </div>
            </div>

            <div class="terms-box">
              <strong>Términos y Condiciones:</strong><br />
              ${quote.termsAndConditions || 'Precios expresados en Soles (PEN). Sujetos a disponibilidad de stock al momento de concretar la compra.'}
              ${quote.notes ? `<br /><br /><strong>Observaciones:</strong> ${quote.notes}` : ''}
            </div>

            <div class="footer">
              Generado por Ventify Mobile POS • Impulsando tu negocio
            </div>
          </body>
          </html>
        `;

        await shareTicketWhatsApp(quoteHtml, quote.customerPhone);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (err: any) {
        console.error('[QuotesManagerModal] Error al compartir cotización por WhatsApp:', err);
        Alert.alert('Error al compartir', err?.message || 'No se pudo generar el documento PDF.');
      } finally {
        setIsProcessing(false);
      }
    },
    [businessSettings]
  );

  // 5. ACCIÓN: Cambiar Estado
  const handleChangeStatus = useCallback(
    async (quoteId: string, newStatus: 'accepted' | 'rejected') => {
      try {
        setIsProcessing(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        await updateQuoteStatus(quoteId, newStatus);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudo actualizar el estado.');
      } finally {
        setIsProcessing(false);
      }
    },
    []
  );

  // 6. ACCIÓN: Eliminar Cotización
  const handleDeleteQuote = useCallback((quote: Quote) => {
    Alert.alert(
      '¿Eliminar Cotización?',
      `Esta acción eliminará permanentemente la cotización ${quote.formattedNumber} para ${quote.customerName}.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              setIsProcessing(true);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
              await deleteQuote(quote.id);
              setSelectedQuote(null);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'No se pudo eliminar la cotización.');
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ]
    );
  }, []);

  if (!isVisible) return null;

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? insets.top : 12 }]}>
        {/* Cabecera Principal */}
        <View style={styles.header}>
          {selectedQuote ? (
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setSelectedQuote(null)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <ArrowLeft size={22} color={ui.text} />
              <Text style={styles.backButtonText}>Cotizaciones</Text>
            </TouchableOpacity>
          ) : (
            <ScreenHeading
              title="Cotizaciones"
              subtitle="Revisa y continúa ventas propuestas"
              action={null}
            />
          )}

          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <X size={20} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* VISTA 1: DETALLE DE COTIZACIÓN SELECCIONADA */}
        {selectedQuote ? (
          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={[styles.detailContentContainer, { paddingBottom: insets.bottom + 30 }]}
          >
            {/* Tarjeta de Encabezado */}
            <View style={styles.detailHeaderCard}>
              <View style={styles.detailNumberRow}>
                <View>
                  <Text style={styles.detailQuoteNumber}>{selectedQuote.formattedNumber}</Text>
                  <Text style={styles.detailDateText}>
                    Emisión: {formatDatePE(selectedQuote.date)}
                  </Text>
                </View>

                {(() => {
                  const b = getStatusBadge(selectedQuote.status, selectedQuote.expiryDate);
                  return (
                    <View style={[styles.statusBadge, { backgroundColor: b.bg, borderColor: b.border }]}>
                      <Text style={[styles.statusBadgeText, { color: b.text }]}>{b.label}</Text>
                    </View>
                  );
                })()}
              </View>

              <View style={styles.divider} />

              {/* Datos del Cliente */}
              <View style={styles.detailSection}>
                <View style={styles.sectionHeaderRow}>
                  <User size={16} color={ui.primary} />
                  <Text style={styles.sectionTitle}>Datos del Cliente</Text>
                </View>
                <Text style={styles.clientNameBig}>{selectedQuote.customerName}</Text>
                {selectedQuote.customerDni && (
                  <Text style={styles.clientMetaText}>DNI: {selectedQuote.customerDni}</Text>
                )}
                {selectedQuote.customerRuc && (
                  <Text style={styles.clientMetaText}>RUC: {selectedQuote.customerRuc}</Text>
                )}
                {selectedQuote.customerPhone && (
                  <View style={styles.inlineMetaRow}>
                    <Phone size={13} color={ui.textMuted} />
                    <Text style={styles.clientMetaText}>{selectedQuote.customerPhone}</Text>
                  </View>
                )}
                {selectedQuote.customerEmail && (
                  <View style={styles.inlineMetaRow}>
                    <Mail size={13} color={ui.textMuted} />
                    <Text style={styles.clientMetaText}>{selectedQuote.customerEmail}</Text>
                  </View>
                )}
                {selectedQuote.customerAddress && (
                  <View style={styles.inlineMetaRow}>
                    <MapPin size={13} color={ui.textMuted} />
                    <Text style={styles.clientMetaText}>{selectedQuote.customerAddress}</Text>
                  </View>
                )}
              </View>

              <View style={styles.divider} />

              {/* Vigencia */}
              <View style={styles.inlineMetaRow}>
                <Clock size={14} color={ui.warning} />
                <Text style={styles.validityText}>
                  Vence: {formatDatePE(selectedQuote.expiryDate)} (Válido por {selectedQuote.validityDays} días)
                </Text>
              </View>
            </View>

            {/* Lista de Productos Cotizados */}
            <View style={styles.itemsCard}>
              <Text style={styles.itemsCardTitle}>Productos Cotizados ({selectedQuote.items.length})</Text>

              {selectedQuote.items.map((item, idx) => (
                <View key={item.id || idx} style={styles.itemRow}>
                  <View style={styles.itemInfoCol}>
                    <Text style={styles.itemNameText}>{item.name}</Text>
                    <Text style={styles.itemSubText}>
                      {item.quantity} x {formatPEN(item.price)}
                      {item.presentationName ? ` • Pres: ${item.presentationName}` : ''}
                      {item.variantName ? ` • Var: ${item.variantName}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.itemTotalText}>{formatPEN(item.quantity * item.price)}</Text>
                </View>
              ))}

              <View style={styles.divider} />

              {/* Totales */}
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Subtotal</Text>
                <Text style={styles.summaryValue}>{formatPEN(selectedQuote.subtotal)}</Text>
              </View>
              {selectedQuote.tax > 0 && (
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>IGV (18%)</Text>
                  <Text style={styles.summaryValue}>{formatPEN(selectedQuote.tax)}</Text>
                </View>
              )}
              <View style={[styles.summaryRow, styles.totalHighlightRow]}>
                <Text style={styles.totalHighlightLabel}>TOTAL COTIZADO</Text>
                <Text style={styles.totalHighlightValue}>{formatPEN(selectedQuote.total)}</Text>
              </View>
            </View>

            {/* Observaciones o Términos */}
            {Boolean(selectedQuote.notes || selectedQuote.termsAndConditions) && (
              <View style={styles.notesCard}>
                {selectedQuote.notes ? (
                  <View style={{ marginBottom: 8 }}>
                    <Text style={styles.notesHeader}>Observaciones:</Text>
                    <Text style={styles.notesBody}>{selectedQuote.notes}</Text>
                  </View>
                ) : null}
                {selectedQuote.termsAndConditions ? (
                  <View>
                    <Text style={styles.notesHeader}>Términos Comerciales:</Text>
                    <Text style={styles.notesBody}>{selectedQuote.termsAndConditions}</Text>
                  </View>
                ) : null}
              </View>
            )}

            {/* BARRA DE ACCIONES DE LA COTIZACIÓN */}
            <View style={styles.actionsContainer}>
              {/* Botón Principal: Cargar al Carrito POS */}
              <TouchableOpacity
                style={[styles.primaryActionButton, isProcessing && styles.buttonDisabled]}
                onPress={() => handleLoadQuoteToPos(selectedQuote)}
                disabled={isProcessing}
              >
                <ShoppingCart size={18} color="#FFFFFF" />
                <Text style={styles.primaryActionButtonText}>
                  Cargar al Carrito POS / Cobrar
                </Text>
              </TouchableOpacity>

              {/* Botón Secundario: Compartir por WhatsApp */}
              <TouchableOpacity
                style={[styles.whatsappButton, isProcessing && styles.buttonDisabled]}
                onPress={() => handleShareQuoteWhatsApp(selectedQuote)}
                disabled={isProcessing}
              >
                <Share2 size={18} color="#FFFFFF" />
                <Text style={styles.whatsappButtonText}>
                  Compartir PDF por WhatsApp
                </Text>
              </TouchableOpacity>

              {/* Cambiar Estado */}
              {selectedQuote.status === 'pending' && (
                <View style={styles.statusButtonsRow}>
                  <TouchableOpacity
                    style={[styles.statusSmallBtn, { backgroundColor: ui.primarySoft, borderColor: ui.primary }]}
                    onPress={() => handleChangeStatus(selectedQuote.id, 'accepted')}
                    disabled={isProcessing}
                  >
                    <CheckCircle2 size={15} color={ui.primary} />
                    <Text style={[styles.statusSmallBtnText, { color: ui.primary }]}>Marcar Aceptada</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.statusSmallBtn, { backgroundColor: ui.dangerSoft, borderColor: ui.danger }]}
                    onPress={() => handleChangeStatus(selectedQuote.id, 'rejected')}
                    disabled={isProcessing}
                  >
                    <XCircle size={15} color={ui.danger} />
                    <Text style={[styles.statusSmallBtnText, { color: ui.danger }]}>Marcar Rechazada</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Eliminar Cotización */}
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => handleDeleteQuote(selectedQuote)}
                disabled={isProcessing}
              >
                <Trash2 size={16} color={ui.danger} />
                <Text style={styles.deleteButtonText}>Eliminar Cotización</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        ) : (
          /* VISTA 2: LISTADO Y BUSCADOR DE COTIZACIONES */
          <View style={styles.listContainer}>
            {/* Métricas Superiores */}
            <SectionHeading title="Resumen" subtitle={`${metrics.totalCount} cotizaciones emitidas`} />
            <View style={styles.metricsBar}>
              <View style={styles.metricItem}>
                <Text style={styles.metricVal}>{metrics.totalCount}</Text>
                <Text style={styles.metricLabel}>Emitidas</Text>
              </View>
              <View style={styles.metricDivider} />
              <View style={styles.metricItem}>
                <Text style={[styles.metricVal, { color: ui.warning }]}>{metrics.pendingCount}</Text>
                <Text style={styles.metricLabel}>Pendientes</Text>
              </View>
              <View style={styles.metricDivider} />
              <View style={styles.metricItem}>
                <Text style={[styles.metricVal, { color: ui.primary }]}>
                  {formatPEN(metrics.pendingAmount)}
                </Text>
                <Text style={styles.metricLabel}>Por Concretar</Text>
              </View>
            </View>

            {/* Barra de Búsqueda */}
            <View style={styles.searchBar}>
              <Search size={18} color={ui.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Buscar por cliente, N° COT, teléfono..."
                placeholderTextColor={ui.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                clearButtonMode="while-editing"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <X size={16} color={ui.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Pestañas de Filtro de Estado */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterTabsContainer}
            >
              {(
                [
                  { key: 'all', label: 'Todas' },
                  { key: 'pending', label: 'Pendientes' },
                  { key: 'accepted', label: 'Aceptadas' },
                  { key: 'converted', label: 'Convertidas' },
                  { key: 'rejected', label: 'Rechazadas' },
                ] as const
              ).map((tab) => {
                const isActive = statusFilter === tab.key;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    style={[styles.filterChip, isActive && styles.filterChipActive]}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                      setStatusFilter(tab.key);
                    }}
                  >
                    <Text style={[styles.filterChipText, isActive && styles.filterChipTextActive]}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Lista Scrollable */}
            {loading ? (
              <View style={styles.centerBox}>
                <ActivityIndicator size="large" color={ui.primary} />
                <Text style={styles.loadingText}>Cargando cotizaciones...</Text>
              </View>
            ) : filteredQuotes.length === 0 ? (
              <View style={styles.centerBox}>
                <FileText size={48} color={ui.textMuted} />
                <Text style={styles.emptyTitle}>No hay cotizaciones</Text>
                <Text style={styles.emptySubtitle}>
                  {searchQuery || statusFilter !== 'all'
                    ? 'No se encontraron cotizaciones con los filtros actuales.'
                    : 'Las cotizaciones creadas en el POS o web aparecerán aquí.'}
                </Text>
              </View>
            ) : (
              <FlashList
                data={filteredQuotes}
                renderItem={({ item }) => (
                  <QuoteCardItem
                    quote={item}
                    onSelect={(quote) => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                      setSelectedQuote(quote);
                    }}
                  />
                )}
                keyExtractor={(item) => item.id}
                estimatedItemSize={115}
                contentContainerStyle={[styles.listScrollContent, { paddingBottom: insets.bottom + 20 }] as any}
                showsVerticalScrollIndicator={false}
              />
            )}
          </View>
        )}
      </View>
    </Modal>
  );
});

// ============================================================================
// ESTILOS NATIVOS VENTIFY
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: ui.text,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: ui.text,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: ui.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Métricas
  metricsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  metricItem: {
    flex: 1,
    alignItems: 'center',
  },
  metricVal: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  metricLabel: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  metricDivider: {
    width: 1,
    height: 24,
    backgroundColor: ui.border,
  },
  // Búsqueda
  searchBar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    gap: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: ui.text,
  },
  filterTabsContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  filterChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  filterChipText: {
    fontSize: 12,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  filterChipTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  // Lista
  listContainer: {
    flex: 1,
  },
  listScroll: {
    flex: 1,
  },
  listScrollContent: {
    paddingHorizontal: 16,
    gap: 10,
  },
  quoteCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  cardHeaderLeft: {
    flex: 1,
    marginRight: 8,
  },
  cardNumber: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.primary,
  },
  cardCustomerName: {
    fontSize: 15,
    fontWeight: '600',
    color: ui.text,
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  cardBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 8,
    marginTop: 4,
  },
  cardInfoCol: {
    gap: 2,
  },
  cardItemCountText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  cardDateText: {
    fontSize: 11,
    color: ui.textMuted,
  },
  cardPriceCol: {
    alignItems: 'flex-end',
  },
  cardTotalAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  cardDetailsArrow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 2,
  },
  cardDetailsText: {
    fontSize: 11,
    color: ui.primary,
    fontWeight: '600',
  },
  // Pantalla Detalle
  contentScroll: {
    flex: 1,
  },
  detailContentContainer: {
    padding: 16,
    gap: 14,
  },
  detailHeaderCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 16,
  },
  detailNumberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  detailQuoteNumber: {
    fontSize: 20,
    fontWeight: '800',
    color: ui.primary,
  },
  detailDateText: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  detailSection: {
    marginVertical: 4,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  clientNameBig: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  clientMetaText: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 2,
  },
  inlineMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  validityText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.warning,
  },
  divider: {
    height: 1,
    backgroundColor: ui.border,
    marginVertical: 12,
  },
  // Tarjeta de ítems
  itemsCard: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 16,
  },
  itemsCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 10,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(31, 41, 55, 0.6)',
  },
  itemInfoCol: {
    flex: 1,
    marginRight: 10,
  },
  itemNameText: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  itemSubText: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  itemTotalText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 3,
  },
  summaryLabel: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  summaryValue: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  totalHighlightRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  totalHighlightLabel: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  totalHighlightValue: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.primary,
  },
  notesCard: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
  },
  notesHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 2,
  },
  notesBody: {
    fontSize: 13,
    color: ui.text,
    lineHeight: 18,
  },
  // Acciones
  actionsContainer: {
    gap: 10,
    marginTop: 6,
  },
  primaryActionButton: {
    backgroundColor: ui.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    minHeight: 48,
    gap: 8,
    shadowColor: ui.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  primaryActionButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  whatsappButton: {
    backgroundColor: '#25D366', // WhatsApp Green
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    minHeight: 48,
    gap: 8,
  },
  whatsappButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  statusButtonsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  statusSmallBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    gap: 6,
  },
  statusSmallBtnText: {
    fontSize: 13,
    fontWeight: '700',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    minHeight: 48,
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    backgroundColor: ui.dangerSoft,
  },
  deleteButtonText: {
    color: ui.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    marginTop: 40,
  },
  loadingText: {
    color: ui.textSecondary,
    fontSize: 14,
    marginTop: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
    marginTop: 14,
  },
  emptySubtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
});

export default QuotesManagerModal;
