import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  Phone,
  Search,
  X,
} from 'lucide-react-native';

import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatPEN, ui } from '@/lib/theme';

import { historyStyles as styles } from './historyStyles';

type ReservationStatusFilter = 'all' | 'pending' | 'completed' | 'cancelled';

const RESERVATION_FILTER_OPTIONS: ReadonlyArray<{ id: ReservationStatusFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'pending', label: 'Pendientes' },
  { id: 'completed', label: 'Entregadas' },
  { id: 'cancelled', label: 'Canceladas' },
];

interface ReservationHistoryRowProps {
  res: any;
  onViewTicket: (res: any) => void;
  onOpenPay: (res: any) => void;
  onComplete: (res: any) => void;
  onCancel: (res: any) => void;
}

const ReservationHistoryRow = React.memo<ReservationHistoryRowProps>(
  ({ res, onViewTicket, onOpenPay, onComplete, onCancel }) => {
    const isPending = res.status === 'pending' || !res.status;
    const isCompleted = res.status === 'completed';
    const isCancelled = res.status === 'cancelled';
    const deposit = Number(res.depositAmount || 0);
    const total = Number(res.total || 0);
    const remaining = Math.max(0, total - deposit);

    const items: any[] = Array.isArray(res.items) ? res.items : [];
    const previewItems = items.slice(0, 4);
    const hiddenItemsCount = Math.max(0, items.length - previewItems.length);

    const handleViewTicket = useCallback(() => onViewTicket(res), [onViewTicket, res]);
    const handleOpenPay = useCallback(() => onOpenPay(res), [onOpenPay, res]);
    const handleComplete = useCallback(() => onComplete(res), [onComplete, res]);
    const handleCancel = useCallback(() => onCancel(res), [onCancel, res]);

    return (
      <View style={styles.reservationCard}>
        <View style={styles.resCardHeader}>
          <View style={styles.flex1}>
            <Text style={styles.resCustomerName}>{res.customer?.name || 'Cliente General'}</Text>
            {res.customer?.phone ? (
              <View style={styles.resPhoneRow}>
                <Phone size={12} color={ui.textSecondary} />
                <Text style={styles.resCustomerPhone}>{res.customer.phone}</Text>
              </View>
            ) : null}
          </View>
          <View
            style={[
              styles.badge,
              isPending && styles.resStatusPendingBg,
              isCompleted && styles.resStatusCompletedBg,
              isCancelled && styles.resStatusCancelledBg,
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                isPending && styles.resStatusPendingText,
                isCompleted && styles.resStatusCompletedText,
                isCancelled && styles.resStatusCancelledText,
              ]}
            >
              {isCompleted ? 'ENTREGADO' : isCancelled ? 'CANCELADO' : 'PENDIENTE'}
            </Text>
          </View>
        </View>

        {previewItems.length > 0 ? (
          <View style={styles.resItemsBox}>
            {previewItems.map((it: any, i: number) => (
              <Text key={it.id || `${i}`} style={styles.resItemLine} numberOfLines={1}>
                • {it.quantity}x {it.productName || it.name || 'Producto'} ({formatPEN(it.price || 0)})
              </Text>
            ))}
            {hiddenItemsCount > 0 ? (
              <Text style={styles.resItemsMoreText}>+{hiddenItemsCount} más</Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.resFinancialRow}>
          <View>
            <Text style={styles.resFinLabel}>Total</Text>
            <Text style={styles.resFinValue}>{formatPEN(total)}</Text>
          </View>
          <View>
            <Text style={styles.resFinLabel}>Adelanto</Text>
            <Text style={[styles.resFinValue, styles.resDepositText]}>{formatPEN(deposit)}</Text>
          </View>
          <View>
            <Text style={styles.resFinLabel}>Saldo Pendiente</Text>
            <Text
              style={[
                styles.resFinValue,
                remaining > 0 ? styles.resRemainingDueText : styles.resRemainingSettledText,
              ]}
            >
              {formatPEN(remaining)}
            </Text>
          </View>
        </View>

        {res.pickupDate ? (
          <View style={styles.resPickupRow}>
            <Clock size={12} color={ui.textSecondary} />
            <Text style={styles.resPickupText}>
              Límite de recojo: {String(res.pickupDate).slice(0, 10)}
            </Text>
          </View>
        ) : null}

        <View style={styles.resActionsRow}>
          <TouchableOpacity
            style={styles.resViewTicketBtn}
            onPress={handleViewTicket}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Ver comprobante o ticket de reserva"
          >
            <FileText size={14} color={ui.primary} />
            <Text style={styles.resViewTicketBtnText}>Ver Ticket</Text>
          </TouchableOpacity>

          {isPending && remaining > 0 && (
            <TouchableOpacity
              style={styles.resCompleteBtn}
              onPress={handleOpenPay}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Cobrar saldo y entregar productos"
            >
              <CreditCard size={14} color={ui.onPrimary} />
              <Text style={styles.resCompleteBtnText}>Cobrar y Entregar</Text>
            </TouchableOpacity>
          )}

          {isPending && remaining === 0 && (
            <TouchableOpacity
              style={styles.resCompleteBtn}
              onPress={handleComplete}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Entregar productos"
            >
              <CheckCircle2 size={14} color={ui.onPrimary} />
              <Text style={styles.resCompleteBtnText}>Entregar</Text>
            </TouchableOpacity>
          )}

          {isPending && (
            <TouchableOpacity
              style={styles.resCancelBtn}
              onPress={handleCancel}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Cancelar reserva"
            >
              <X size={14} color={ui.danger} />
              <Text style={styles.resCancelBtnText}>Cancelar</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }
);

export interface HistoryReservationsTabProps {
  reservations: any[];
  loadingReservations: boolean;
  bottomInset: number;
  onViewTicket: (res: any) => void;
  onOpenPay: (res: any) => void;
  onComplete: (res: any) => void;
  onCancel: (res: any) => void;
}

export const HistoryReservationsTab = React.memo<HistoryReservationsTabProps>(
  ({
    reservations,
    loadingReservations,
    bottomInset,
    onViewTicket,
    onOpenPay,
    onComplete,
    onCancel,
  }) => {
    const [reservationSearch, setReservationSearch] = useState('');
    const debouncedReservationSearch = useDebouncedValue(reservationSearch, 150);
    const [reservationStatusFilter, setReservationStatusFilter] =
      useState<ReservationStatusFilter>('all');

    const filteredReservations = useMemo(() => {
      const q = debouncedReservationSearch.trim().toLowerCase();
      return reservations.filter((res) => {
        if (reservationStatusFilter !== 'all') {
          const status = res.status || 'pending';
          if (status !== reservationStatusFilter) return false;
        }
        if (!q) return true;
        const custName = (res.customer?.name || '').toLowerCase();
        const custPhone = (res.customer?.phone || '').toLowerCase();
        const notes = (res.notes || '').toLowerCase();
        const correlative = (res.correlative || '').toLowerCase();
        const itemsMatch =
          Array.isArray(res.items) &&
          res.items.some((it: any) =>
            (it.productName || it.name || '').toLowerCase().includes(q)
          );
        return (
          custName.includes(q) ||
          custPhone.includes(q) ||
          notes.includes(q) ||
          correlative.includes(q) ||
          itemsMatch
        );
      });
    }, [reservations, debouncedReservationSearch, reservationStatusFilter]);

    const renderReservationItem = useCallback(
      ({ item }: { item: any }) => (
        <ReservationHistoryRow
          res={item}
          onViewTicket={onViewTicket}
          onOpenPay={onOpenPay}
          onComplete={onComplete}
          onCancel={onCancel}
        />
      ),
      [onViewTicket, onOpenPay, onComplete, onCancel]
    );

    const reservationKeyExtractor = useCallback((item: any) => item.id, []);
    const reservationItemType = useCallback(
      (item: any) => (item.status === 'pending' || !item.status ? 'pending' : 'settled'),
      []
    );
    const reservationsListContentStyle = useMemo(
      () => ({ paddingHorizontal: 20, paddingBottom: bottomInset + 80 }),
      [bottomInset]
    );

    // Stale-while-revalidate: keep existing FlashList mounted while refreshing in background unless empty
    const showInitialLoader = loadingReservations && reservations.length === 0;

    return (
      <View style={styles.flex1}>
        <View style={[styles.searchRow, styles.reservationsSearchRow]}>
          <View style={styles.searchBox}>
            <Search size={18} color={ui.textMuted} />
            <TextInput
              style={styles.searchInput}
              accessibilityLabel="Buscar reservas por cliente, teléfono o producto"
              placeholder="Buscar por cliente, teléfono o producto..."
              placeholderTextColor={ui.textMuted}
              value={reservationSearch}
              onChangeText={setReservationSearch}
            />
            {reservationSearch.length > 0 && (
              <TouchableOpacity
                onPress={() => setReservationSearch('')}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Limpiar búsqueda"
              >
                <X size={16} color={ui.textMuted} />
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.reservationsCountBadge}>
            {loadingReservations && reservations.length > 0 ? (
              <ActivityIndicator size="small" color={ui.primary} />
            ) : (
              <>
                <Text style={styles.reservationsCountNumber}>{filteredReservations.length}</Text>
                <Text style={styles.reservationsCountLabel}>res.</Text>
              </>
            )}
          </View>
        </View>

        <View style={[styles.docFilterRow, styles.reservationsFilterRow]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.reservationsFilterScrollContent}
          >
            {RESERVATION_FILTER_OPTIONS.map((f) => {
              const selected = reservationStatusFilter === f.id;
              return (
                <TouchableOpacity
                  key={f.id}
                  style={[styles.docChip, selected && styles.docChipActive]}
                  onPress={() => setReservationStatusFilter(f.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Filtrar reservas por ${f.label}`}
                >
                  <Text style={[styles.docChipText, selected && styles.docChipTextActive]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {showInitialLoader ? (
          <ActivityIndicator color={ui.primary} style={styles.listLoader} />
        ) : filteredReservations.length === 0 ? (
          <View style={[styles.emptyContainer, styles.emptyReservationsContainer]}>
            <Calendar size={44} color={ui.textMuted} />
            <Text style={styles.emptyTitle}>
              {reservations.length === 0
                ? 'No hay reservas registradas'
                : 'No se encontraron reservas'}
            </Text>
            <Text style={styles.emptySub}>
              {reservations.length === 0
                ? 'Las reservas creadas desde el POS aparecerán aquí con su estado, seña recibida y saldo pendiente.'
                : 'Prueba otro término de búsqueda o cambia el filtro de estado.'}
            </Text>
          </View>
        ) : (
          <FlashList
            data={filteredReservations}
            renderItem={renderReservationItem}
            keyExtractor={reservationKeyExtractor}
            getItemType={reservationItemType}
            estimatedItemSize={220}
            contentContainerStyle={reservationsListContentStyle}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    );
  }
);
