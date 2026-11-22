import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { FlashList, type ContentStyle } from '@shopify/flash-list';
import {
  CheckCircle2,
  FileText,
  Package,
  PlusCircle,
  XCircle,
} from 'lucide-react-native';
import { SectionHeading } from '@/components/ui';
import { formatPEN, ui } from '@/lib/theme';
import type { ReservationOrder } from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';

const ListGap16 = () => <View style={styles.listSeparator16} />;

interface ReservationCardItemProps {
  item: ReservationOrder;
  onViewTicket: (item: ReservationOrder) => void;
  onCancel: (item: ReservationOrder) => void;
  onApprove: (item: ReservationOrder) => void;
  onDeliver: (item: ReservationOrder) => void;
}

const ReservationCardItem = React.memo<ReservationCardItemProps>(
  ({ item, onViewTicket, onCancel, onApprove, onDeliver }) => {
    const isPending = item.status === 'pending' || item.status === 'ready';
    const canDeliver =
      item.type === 'reservation'
        ? isPending
        : item.status === 'approved' || item.status === 'production';
    const canCancel =
      isPending || item.status === 'approved' || item.status === 'production';
    const isDelivered = item.status === 'completed';
    const isCancelled = item.status === 'cancelled';

    const items = item.items || [];
    const previewItems = items.slice(0, 4);
    const hiddenItemsCount = Math.max(0, items.length - previewItems.length);

    return (
      <View style={styles.reservationCard}>
        <View style={styles.reservationTop}>
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.typeBadge,
                item.type === 'order'
                  ? styles.typeBadgeOrder
                  : styles.typeBadgeReservation,
              ]}
            >
              <Text
                style={[
                  styles.typeBadgeText,
                  item.type === 'order'
                    ? styles.typeBadgeTextOrder
                    : styles.typeBadgeTextReservation,
                ]}
              >
                {item.type === 'order' ? 'PEDIDO' : 'RESERVA'} #
                {item.id.slice(-6).toUpperCase()}
              </Text>
            </View>

            <View
              style={[
                styles.statusBadge,
                isDelivered
                  ? styles.statusBadgeDelivered
                  : isCancelled
                  ? styles.statusBadgeCancelled
                  : styles.statusBadgePending,
              ]}
            >
              <Text
                style={[
                  styles.statusBadgeText,
                  isDelivered
                    ? styles.statusBadgeTextDelivered
                    : isCancelled
                    ? styles.statusBadgeTextCancelled
                    : styles.statusBadgeTextPending,
                ]}
              >
                {isDelivered
                  ? 'ENTREGADO'
                  : isCancelled
                  ? 'CANCELADO'
                  : ['approved', 'production'].includes(item.status)
                  ? 'APROBADO'
                  : 'PENDIENTE'}
              </Text>
            </View>
          </View>

          <Text style={styles.resClientName}>
            {item.customer?.name || 'Cliente sin nombre'}
          </Text>
          {item.customer?.phone && (
            <Text style={styles.resClientPhone}>Tel: {item.customer.phone}</Text>
          )}
        </View>

        <View style={styles.resItemsList}>
          {previewItems.map((it, idx) => (
            <View key={idx} style={styles.resItemRow}>
              <Text style={styles.resItemName} numberOfLines={1}>
                • {it.quantity}x {it.productName}
              </Text>
              <Text style={styles.resItemPrice} numberOfLines={1}>
                {formatPEN(it.price * it.quantity)}
              </Text>
            </View>
          ))}
          {hiddenItemsCount > 0 && (
            <Text style={styles.resMoreItemsText}>+{hiddenItemsCount} más</Text>
          )}
        </View>

        <View style={styles.resFinancialRow}>
          <View>
            <Text style={styles.resFinLabel}>Total</Text>
            <Text style={styles.resFinValue} numberOfLines={1}>
              {formatPEN(item.total)}
            </Text>
          </View>
          <View>
            <Text style={styles.resFinLabel}>Adelanto Pagado</Text>
            <Text style={[styles.resFinValue, styles.resFinValueSuccess]} numberOfLines={1}>
              {formatPEN(item.depositAmount || 0)}
            </Text>
          </View>
          <View>
            <Text style={styles.resFinLabel}>Saldo Pendiente</Text>
            <Text style={[styles.resFinValue, styles.resFinValueWarning]} numberOfLines={1}>
              {formatPEN(item.remainingAmount || 0)}
            </Text>
          </View>
        </View>

        <View style={styles.resActionRow}>
          <TouchableOpacity
            style={[styles.resActionButton, styles.resActionBtnTicket]}
            onPress={() => onViewTicket(item)}
            activeOpacity={0.7}
          >
            <FileText size={15} color={ui.primary} />
            <Text style={[styles.resActionText, styles.resActionTextTicket]}>Ver Ticket</Text>
          </TouchableOpacity>

          {canCancel && (
            <TouchableOpacity
              style={[styles.resActionButton, styles.resActionBtnCancel]}
              onPress={() => onCancel(item)}
              activeOpacity={0.7}
            >
              <XCircle size={15} color={ui.danger} />
              <Text style={[styles.resActionText, styles.resActionTextCancel]}>Cancelar</Text>
            </TouchableOpacity>
          )}

          {item.type === 'order' && item.status === 'pending' && (
            <TouchableOpacity
              style={[styles.resActionButton, styles.resActionBtnApprove]}
              onPress={() => onApprove(item)}
              activeOpacity={0.7}
            >
              <CheckCircle2 size={15} color={ui.onPrimary} />
              <Text style={[styles.resActionText, styles.resActionTextPrimary]}>
                Aprobar pedido
              </Text>
            </TouchableOpacity>
          )}

          {canDeliver && (
            <TouchableOpacity
              style={[styles.resActionButton, styles.resActionBtnDeliver]}
              onPress={() => onDeliver(item)}
              activeOpacity={0.7}
            >
              <CheckCircle2 size={15} color={ui.onPrimary} />
              <Text style={[styles.resActionText, styles.resActionTextPrimary]}>
                {item.remainingAmount && item.remainingAmount > 0
                  ? 'Cobrar y Entregar'
                  : 'Entregar'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }
);

export interface OrdersTabViewProps {
  reservations: ReservationOrder[];
  loadingReservations: boolean;
  listContentContainerStyle: ContentStyle;
  onOpenNewReservation: () => void;
  onViewTicket: (item: ReservationOrder) => void;
  onCancel: (item: ReservationOrder) => void;
  onApprove: (item: ReservationOrder) => void;
  onDeliver: (item: ReservationOrder) => void;
}

export const OrdersTabView = React.memo<OrdersTabViewProps>(({
  reservations,
  loadingReservations,
  listContentContainerStyle,
  onOpenNewReservation,
  onViewTicket,
  onCancel,
  onApprove,
  onDeliver,
}) => {
  const [reservationTypeFilter, setReservationTypeFilter] = useState<
    'all' | 'reservation' | 'order'
  >('all');

  const filteredReservations = useMemo(() => {
    if (reservationTypeFilter === 'all') return reservations;
    return reservations.filter((r) => r.type === reservationTypeFilter);
  }, [reservations, reservationTypeFilter]);

  const reservationKeyExtractor = useCallback(
    (item: ReservationOrder, index: number) => item.id || `res_${index}`,
    []
  );
  const getReservationItemType = useCallback(
    (item: ReservationOrder) =>
      item.status === 'pending' || item.status === 'approved' || item.status === 'production'
        ? 'pending'
        : 'settled',
    []
  );
  const renderReservationItem = useCallback(
    ({ item }: { item: ReservationOrder }) => (
      <ReservationCardItem
        item={item}
        onViewTicket={onViewTicket}
        onCancel={onCancel}
        onApprove={onApprove}
        onDeliver={onDeliver}
      />
    ),
    [onViewTicket, onCancel, onApprove, onDeliver]
  );

  const listHeaderElement = useMemo(
    () => (
      <View style={styles.ordersHeaderWrapper}>
        <SectionHeading
          title="Reservas y pedidos"
          subtitle="Los productos reservados se mantienen apartados hasta la entrega."
          action={
            <TouchableOpacity style={styles.primaryMiniButton} onPress={onOpenNewReservation}>
              <PlusCircle size={18} color={ui.onPrimary} />
              <Text style={styles.primaryMiniButtonText}>Nueva Reserva</Text>
            </TouchableOpacity>
          }
        />

        <View style={styles.chipRow}>
          <TouchableOpacity
            style={[
              styles.filterChip,
              reservationTypeFilter === 'all' && styles.filterChipActive,
            ]}
            onPress={() => setReservationTypeFilter('all')}
            accessibilityRole="button"
            accessibilityState={{ selected: reservationTypeFilter === 'all' }}
            accessibilityLabel="Ver pedidos y reservas"
          >
            <Text
              style={[
                styles.filterChipText,
                reservationTypeFilter === 'all' && styles.filterChipTextActive,
              ]}
            >
              Todos ({reservations.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.filterChip,
              reservationTypeFilter === 'reservation' && styles.filterChipActive,
            ]}
            onPress={() => setReservationTypeFilter('reservation')}
            accessibilityRole="button"
            accessibilityState={{ selected: reservationTypeFilter === 'reservation' }}
            accessibilityLabel="Ver reservas"
          >
            <Text
              style={[
                styles.filterChipText,
                reservationTypeFilter === 'reservation' && styles.filterChipTextActive,
              ]}
            >
              Reservas
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.filterChip,
              reservationTypeFilter === 'order' && styles.filterChipActive,
            ]}
            onPress={() => setReservationTypeFilter('order')}
            accessibilityRole="button"
            accessibilityState={{ selected: reservationTypeFilter === 'order' }}
            accessibilityLabel="Ver pedidos"
          >
            <Text
              style={[
                styles.filterChipText,
                reservationTypeFilter === 'order' && styles.filterChipTextActive,
              ]}
            >
              Pedidos
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [onOpenNewReservation, reservationTypeFilter, reservations.length]
  );

  const listEmptyElement = useMemo(() => {
    if (loadingReservations) {
      return <ActivityIndicator color={ui.primary} style={{ marginVertical: 30 }} />;
    }
    return (
      <View style={styles.emptyContainer}>
        <Package size={40} color={ui.textMuted} />
        <Text style={styles.emptyText}>No hay pedidos ni reservas activos.</Text>
      </View>
    );
  }, [loadingReservations]);

  return (
    <View style={{ flex: 1 }}>
      <FlashList
        data={filteredReservations}
        renderItem={renderReservationItem}
        keyExtractor={reservationKeyExtractor}
        getItemType={getReservationItemType}
        estimatedItemSize={220}
        contentContainerStyle={listContentContainerStyle}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={ListGap16}
        ListHeaderComponent={listHeaderElement}
        ListEmptyComponent={listEmptyElement}
      />
    </View>
  );
});
