import React from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Receipt, RotateCcw, ShieldAlert, X } from 'lucide-react-native';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import type {
  CustomerData,
  FiadoHistoryEntry,
  OpenFiado,
} from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';

export interface CustomerDetailModalProps {
  visible: boolean;
  customer: CustomerData | null;
  openFiados: OpenFiado[];
  fiadoHistory: FiadoHistoryEntry[];
  loading: boolean;
  isRecalculatingDebt: boolean;
  isSupervisor: boolean;
  canManageCustomers: boolean;
  canProcessReturn: boolean;
  isCashier: boolean;
  role?: string | null;
  onClose: () => void;
  onCollectDebt: (customer: CustomerData) => void;
  onRecalculateDebt: () => void;
  onPayFiado: (customer: CustomerData, fiado: OpenFiado) => void;
  onOpenReturnFiado: (fiado: OpenFiado) => void;
  onOpenWriteOff: (fiado: OpenFiado) => void;
}

export const CustomerDetailModal = React.memo<CustomerDetailModalProps>(({
  visible,
  customer,
  openFiados,
  fiadoHistory,
  loading,
  isRecalculatingDebt,
  isSupervisor,
  canManageCustomers,
  canProcessReturn,
  isCashier,
  role,
  onClose,
  onCollectDebt,
  onRecalculateDebt,
  onPayFiado,
  onOpenReturnFiado,
  onOpenWriteOff,
}) => {
  const insets = useSafeAreaInsets();
  if (!visible || !customer) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.fullSheetContainer,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
        collapsable={false}
      >
        <View style={styles.fullSheetHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {customer.name}
            </Text>
            <Text style={styles.modalSub}>
              {customer.documentType || 'DOC'}: {customer.documentNumber || 'Sin número'}
              {customer.phone ? ` · ${customer.phone}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Cerrar detalle del cliente"
          >
            <X size={20} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.fullSheetContent} showsVerticalScrollIndicator={false}>
          {(customer.email || customer.address) ? (
            <View style={styles.detailInfoCard}>
              {customer.email ? (
                <Text style={styles.detailInfoLine}>Correo: {customer.email}</Text>
              ) : null}
              {customer.address ? (
                <Text style={styles.detailInfoLine}>Dirección: {customer.address}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.detailKpiGrid}>
            <View style={styles.detailKpiTile}>
              <Text style={styles.detailKpiLabel}>DEUDA ACTUAL</Text>
              <Text
                style={[
                  styles.detailKpiValue,
                  { color: (customer.currentDebt || 0) > 0 ? ui.danger : ui.success },
                ]}
              >
                {formatPEN(Number(customer.currentDebt) || 0)}
              </Text>
            </View>
            <View style={styles.detailKpiTile}>
              <Text style={styles.detailKpiLabel}>CRÉDITOS</Text>
              <Text style={[styles.detailKpiValue, { color: ui.primary }]}>
                {formatPEN(Number(customer.credits) || 0)}
              </Text>
            </View>
            <View style={styles.detailKpiTile}>
              <Text style={styles.detailKpiLabel}>LÍMITE CRÉDITO</Text>
              <Text style={styles.detailKpiValue}>
                {formatPEN(Number(customer.maxCreditLimit ?? customer.creditLimit) || 0)}
              </Text>
            </View>
          </View>

          <View style={styles.detailActionsBar}>
            {(Number(customer.currentDebt) || 0) > 0 && (
              <TouchableOpacity
                style={[styles.primaryButton, { flex: 1 }]}
                onPress={() => onCollectDebt(customer)}
              >
                <Receipt size={16} color={ui.onPrimary} />
                <Text style={styles.primaryButtonText}>Abonar Deuda</Text>
              </TouchableOpacity>
            )}

            {isSupervisor && canManageCustomers && (
              <TouchableOpacity
                style={[
                  styles.recalcButton,
                  { flex: 1 },
                  isRecalculatingDebt && styles.buttonDisabled,
                ]}
                onPress={onRecalculateDebt}
                disabled={isRecalculatingDebt}
              >
                {isRecalculatingDebt ? (
                  <ActivityIndicator size="small" color={ui.primary} />
                ) : (
                  <>
                    <RotateCcw size={15} color={ui.primary} />
                    <Text style={styles.recalcButtonText}>Recalcular deuda</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.detailSectionTitle}>
            Fiados Pendientes ({openFiados.length})
          </Text>

          {loading ? (
            <ActivityIndicator color={ui.primary} style={{ marginVertical: 20 }} />
          ) : openFiados.length === 0 ? (
            <View style={styles.detailEmptyBox}>
              <Text style={styles.emptyText}>Este cliente no tiene fiados pendientes.</Text>
            </View>
          ) : (
            openFiados.map((fiado) => {
              const canReturnItems =
                (fiado.items?.length || 0) > 0 &&
                (canProcessReturn || isSupervisor || role === 'manager' || isCashier);
              return (
                <View key={fiado.id} style={styles.fiadoDetailCard}>
                  <View style={styles.fiadoDetailHeader}>
                    <View>
                      <Text style={styles.fiadoDetailTitle}>
                        Fiado #{fiado.reservationNumber ?? fiado.id.slice(-6).toUpperCase()}
                      </Text>
                      <Text style={styles.fiadoDetailDate}>{formatDatePE(fiado.date)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.fiadoBalanceLabel}>PENDIENTE</Text>
                      <Text style={styles.fiadoBalanceValue}>
                        {formatPEN(fiado.remainingAmount)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.fiadoMetricsRow}>
                    <Text style={styles.fiadoMetricText}>Total: {formatPEN(fiado.total)}</Text>
                    <Text style={styles.fiadoMetricText}>
                      Pagado: {formatPEN(fiado.paidAmount)}
                    </Text>
                    {(fiado.returnedAmount || 0) > 0 && (
                      <Text style={styles.fiadoMetricText}>
                        Devuelto: {formatPEN(fiado.returnedAmount || 0)}
                      </Text>
                    )}
                  </View>

                  {Array.isArray(fiado.items) && fiado.items.length > 0 && (
                    <View style={styles.fiadoItemsBox}>
                      {fiado.items.map((it, idx) => (
                        <View
                          key={`${it.productId || it.id || idx}`}
                          style={styles.fiadoItemLine}
                        >
                          <Text style={styles.fiadoItemName} numberOfLines={1}>
                            {it.quantity}x {it.productName || it.name || 'Producto'}
                          </Text>
                          <Text style={styles.fiadoItemPrice}>
                            {formatPEN((Number(it.price) || 0) * (Number(it.quantity) || 0))}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <View style={styles.fiadoButtonsRow}>
                    <TouchableOpacity
                      style={styles.fiadoActionPrimary}
                      onPress={() => onPayFiado(customer, fiado)}
                    >
                      <Receipt size={14} color={ui.onPrimary} />
                      <Text style={styles.fiadoActionPrimaryText}>Abonar</Text>
                    </TouchableOpacity>

                    {canReturnItems && (
                      <TouchableOpacity
                        style={styles.fiadoActionOutline}
                        onPress={() => onOpenReturnFiado(fiado)}
                      >
                        <RotateCcw size={14} color={ui.primary} />
                        <Text style={styles.fiadoActionOutlineText}>Devolver</Text>
                      </TouchableOpacity>
                    )}

                    {isSupervisor && (
                      <TouchableOpacity
                        style={styles.fiadoActionDanger}
                        onPress={() => onOpenWriteOff(fiado)}
                      >
                        <ShieldAlert size={14} color={ui.danger} />
                        <Text style={styles.fiadoActionDangerText}>Castigar</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })
          )}

          <Text style={[styles.detailSectionTitle, { marginTop: 8 }]}>
            Historial de Abonos y Créditos ({fiadoHistory.length})
          </Text>
          {fiadoHistory.length === 0 ? (
            <View style={styles.detailEmptyBox}>
              <Text style={styles.emptyText}>Sin movimientos registrados aún.</Text>
            </View>
          ) : (
            fiadoHistory.slice(0, 15).map((entry) => (
              <View key={entry.id} style={styles.historyRowItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyRowTitle}>
                    {entry.paymentMethod || 'Abono'} · {entry.createdByName || 'Operador'}
                  </Text>
                  <Text style={styles.historyRowSub}>
                    {formatDatePE(entry.date)}
                    {entry.notes ? ` · ${entry.notes}` : ''}
                  </Text>
                </View>
                <Text style={styles.historyRowAmt}>+{formatPEN(entry.amount)}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
});
