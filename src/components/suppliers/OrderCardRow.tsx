import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import {
  Truck,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ArrowDownLeft,
  Ban,
} from 'lucide-react-native';
import { formatPEN, formatDatePE, ui } from '@/lib/theme';
import { PurchaseOrder, resolvePackagingFactor } from '@/services/suppliers-po-service';
import { suppliersStyles as styles } from './suppliersStyles';

export interface OrderCardRowProps {
  order: PurchaseOrder;
  isExpanded: boolean;
  isReceiving: boolean;
  onToggleExpand: (orderId: string) => void;
  onReceiveOrder: (order: PurchaseOrder) => void;
  onCancelOrder: (order: PurchaseOrder) => void;
}

export const OrderCardRow: React.FC<OrderCardRowProps> = React.memo(({
  order,
  isExpanded,
  isReceiving,
  onToggleExpand,
  onReceiveOrder,
  onCancelOrder,
}) => {
  const isPending = order.status === 'pending' || order.status === 'ordered';
  const isPartial = order.status === 'partial';
  const isReceived = order.status === 'received';
  const isCancelled = order.status === 'cancelled';
  const canReceive = isPending || isPartial;
  const items = Array.isArray(order.items) ? order.items.filter(Boolean) : [];

  return (
    <View style={styles.orderCard}>
      {/* CABECERA DE LA ORDEN */}
      <View style={styles.orderCardHeader}>
        <View style={styles.orderNumberRow}>
          <Text style={styles.orderNumberText}>{order.orderNumber}</Text>
          <View
            style={[
              styles.statusBadge,
              isPending && styles.statusBadgePending,
              isPartial && styles.statusBadgePartial,
              isReceived && styles.statusBadgeReceived,
              isCancelled && styles.statusBadgeCancelled,
            ]}
          >
            <Text
              style={[
                styles.statusBadgeText,
                isPending && styles.statusBadgeTextPending,
                isPartial && styles.statusBadgeTextPartial,
                isReceived && styles.statusBadgeTextReceived,
                isCancelled && styles.statusBadgeTextCancelled,
              ]}
            >
              {isPending
                ? 'PENDIENTE'
                : isPartial
                ? 'PARCIAL'
                : isReceived
                ? 'RECIBIDA EN ALMACÉN'
                : 'CANCELADA'}
            </Text>
          </View>
        </View>

        <Text style={styles.orderDateText}>{formatDatePE(order.createdAt)}</Text>
      </View>

      {/* DATOS DEL PROVEEDOR Y SUCURSAL */}
      <View style={styles.orderSupplierRow}>
        <Truck size={16} color={ui.primary} />
        <Text style={styles.orderSupplierName}>{order.supplierName}</Text>
      </View>

      <View style={styles.orderInfoRow}>
        <Text style={styles.orderItemsCount}>
          {items.length} {items.length === 1 ? 'producto' : 'productos'}
        </Text>
        <Text style={styles.orderTotalText}>{formatPEN(order.totalCost)}</Text>
      </View>

      {/* NOTAS DE LA ORDEN */}
      {Boolean(order.notes) && (
        <Text style={styles.orderNotesText} numberOfLines={2}>
          Nota: {order.notes}
        </Text>
      )}

      {/* DETALLE EXPANDIBLE DE PRODUCTOS */}
      <TouchableOpacity
        style={styles.expandToggleRow}
        onPress={() => onToggleExpand(order.id)}
      >
        <Text style={styles.expandToggleText}>
          {isExpanded ? 'Ocultar productos' : 'Ver productos en la orden'}
        </Text>
        {isExpanded ? (
          <ChevronUp size={16} color={ui.textSecondary} />
        ) : (
          <ChevronDown size={16} color={ui.textSecondary} />
        )}
      </TouchableOpacity>

      {isExpanded && (
        <View style={styles.expandedItemsContainer}>
          {items.map((it, idx) => {
            const factor = resolvePackagingFactor(it.packagingFactor);
            const recQty = Number(it.receivedQuantity) || 0;
            return (
              <View key={`${it.productId}-${idx}`} style={styles.expandedItemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.expandedItemName}>{it.productName}</Text>
                  <Text style={styles.expandedItemSku}>
                    {it.quantity} un. x {formatPEN(it.unitCost)}
                    {factor > 1 ? ` • ${it.packagingLabel || `Caja x${factor}`}` : ''}
                    {recQty > 0 ? ` • Recibido: ${recQty}/${it.quantity}` : ''}
                  </Text>
                </View>
                <Text style={styles.expandedItemSubtotal}>{formatPEN(it.subtotal)}</Text>
              </View>
            );
          })}

          {(isReceived || isPartial) && Boolean(order.receivedByName) && (
            <View style={styles.auditReceivedRow}>
              <CheckCircle2 size={14} color={ui.primary} />
              <Text style={styles.auditReceivedText}>
                {isPartial ? 'Última recepción por ' : 'Recibido por '}
                {order.receivedByName} el{' '}
                {formatDatePE(order.receivedAt || order.receivedDate || order.partialReceivedAt)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ACCIONES DE LA TARJETA */}
      {canReceive && (
        <View style={styles.orderActionsRow}>
          <TouchableOpacity
            style={[styles.receiveButton, isReceiving && styles.btnDisabled]}
            onPress={() => onReceiveOrder(order)}
            disabled={isReceiving}
          >
            {isReceiving ? (
              <ActivityIndicator size="small" color={ui.surface} />
            ) : (
              <>
                <ArrowDownLeft size={16} color={ui.surface} />
                <Text style={styles.receiveButtonText}>
                  {isPartial ? 'Completar Recepción' : 'Recibir Mercadería'}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {!isPartial && (
            <TouchableOpacity
              style={styles.cancelOrderButton}
              onPress={() => onCancelOrder(order)}
              disabled={isReceiving}
            >
              <Ban size={15} color={ui.danger} />
              <Text style={styles.cancelOrderButtonText}>Cancelar</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
});
