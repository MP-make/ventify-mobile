import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import {
  AlertTriangle,
  Bluetooth,
  CheckCircle2,
  ChevronRight,
  FileText,
  Printer,
  RefreshCw,
  Shield,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react-native';

import { SectionHeading } from '@/components/ui';
import { useOfflineStatus } from '@/context/SettingsContext';
import type { AccountTaxProfile } from '@/lib/invoicing/receipt-amounts';
import { resolveReceiptBusiness } from '@/lib/invoicing/receipt-business';
import type { OfflineInventoryOperation } from '@/lib/offline-stock-helpers';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import {
  cancelPendingCashMovement,
  getOfflineCashQueueForIdentity,
  type PendingOfflineCashMovement,
} from '@/services/offline-cash-service';
import {
  cancelPendingInventoryOp,
  getOfflineInventoryQueueForIdentity,
  getQuarantinedInventoryOpsForIdentity,
  removeQuarantinedInventoryOp,
  retryQuarantinedInventoryOp,
  type QuarantinedInventoryOp,
} from '@/services/offline-inventory-service';
import {
  cancelPendingOfflineSale,
  getOfflineQueueForIdentity,
  getQuarantinedSalesForIdentity,
  removeQuarantinedSale,
  retryQuarantinedSale,
  type PendingOfflineSale,
  type QuarantinedOfflineSale,
} from '@/services/offline-sync-service';
import {
  DEFAULT_PRINTER_CONFIG,
  getPrinterConfig,
  printTicketPDF,
  requestBluetoothPermissions,
  savePrinterConfig,
  scanBluetoothPrinters,
  testPrinterConnection,
  type BluetoothPrinterDevice,
  type PrinterConfig,
} from '@/services/thermal-printer-service';
import type { Branch, BusinessSettings, PosSettings } from '@/types';

import { settingsStyles as styles } from './settingsStyles';

type OfflineModalRow =
  | { kind: 'pending_sale'; key: string; data: PendingOfflineSale }
  | { kind: 'pending_inventory'; key: string; data: OfflineInventoryOperation }
  | { kind: 'pending_cash'; key: string; data: PendingOfflineCashMovement }
  | { kind: 'quarantined_sale'; key: string; data: QuarantinedOfflineSale }
  | { kind: 'quarantined_inventory'; key: string; data: QuarantinedInventoryOp };

export interface PrinterOfflineSettingsTabProps {
  accountId: string | null;
  userId: string | null;
  activeCashSessionId?: string | null;
  isFocused: boolean;
  isActiveTab: boolean;
  isOnline: boolean;
  offlineQueueCount: number;
  refreshOfflineCount: () => Promise<number>;
  businessSettings: BusinessSettings;
  activeBranch: Branch | null;
  posSettings: PosSettings;
  taxProfile: AccountTaxProfile;
}

export const PrinterOfflineSettingsTab = React.memo<PrinterOfflineSettingsTabProps>(
  ({
    accountId,
    userId,
    activeCashSessionId,
    isFocused,
    isActiveTab,
    isOnline,
    offlineQueueCount,
    refreshOfflineCount,
    businessSettings,
    activeBranch,
    posSettings,
    taxProfile,
  }) => {
    const { isSyncingOffline: contextSyncing, triggerManualSync } = useOfflineStatus();
    const [printerConfig, setPrinterConfig] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
    const [scannedPrinters, setScannedPrinters] = useState<BluetoothPrinterDevice[]>([]);
    const [isScanningPrinters, setIsScanningPrinters] = useState(false);
    const [printerScanModalVisible, setPrinterScanModalVisible] = useState(false);
    const [isPrintingTest, setIsPrintingTest] = useState(false);
    const [btPermissionChecking, setBtPermissionChecking] = useState(false);

    const [offlineSales, setOfflineSales] = useState<PendingOfflineSale[]>([]);
    const [pendingInvOps, setPendingInvOps] = useState<OfflineInventoryOperation[]>([]);
    const [pendingCashOps, setPendingCashOps] = useState<PendingOfflineCashMovement[]>([]);
    const [quarantinedSales, setQuarantinedSales] = useState<QuarantinedOfflineSale[]>([]);
    const [quarantinedInvOps, setQuarantinedInvOps] = useState<QuarantinedInventoryOp[]>([]);
    const [localSyncing, setLocalSyncing] = useState(false);
    const isSyncingOffline = contextSyncing || localSyncing;
    const [offlineDetailsModalVisible, setOfflineDetailsModalVisible] = useState(false);

    useEffect(() => {
      let active = true;
      getPrinterConfig()
        .then((cfg) => {
          if (active) setPrinterConfig(cfg);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []);

    const loadOfflineData = useCallback(async () => {
      if (!userId || !accountId) {
        setOfflineSales([]);
        setPendingInvOps([]);
        setPendingCashOps([]);
        setQuarantinedSales([]);
        setQuarantinedInvOps([]);
        return;
      }
      try {
        const [salesQ, salesQuar, invQ, invQuar, cashQ] = await Promise.all([
          getOfflineQueueForIdentity(userId, accountId),
          getQuarantinedSalesForIdentity(userId, accountId),
          getOfflineInventoryQueueForIdentity(userId, accountId),
          getQuarantinedInventoryOpsForIdentity(userId, accountId),
          getOfflineCashQueueForIdentity(userId, accountId),
        ]);
        setOfflineSales(salesQ);
        setQuarantinedSales(salesQuar);
        setPendingInvOps(invQ);
        setQuarantinedInvOps(invQuar);
        setPendingCashOps(cashQ);
      } catch (err) {
        console.error('Error cargando estado offline:', err);
      }
    }, [userId, accountId]);

    useEffect(() => {
      if (!isFocused || (!isActiveTab && !offlineDetailsModalVisible)) return;
      void loadOfflineData();
    }, [isFocused, isActiveTab, offlineDetailsModalVisible, loadOfflineData, offlineQueueCount]);

    const handleRequestBtPermission = async () => {
      setBtPermissionChecking(true);
      try {
        const res = await requestBluetoothPermissions();
        Alert.alert(
          res.granted ? 'Permisos Concedidos' : 'Permiso Requerido',
          res.granted
            ? 'Los permisos de Bluetooth están activos para escanear e imprimir.'
            : res.message || 'Habilita "Dispositivos cercanos" en los Ajustes del sistema.'
        );
      } finally {
        setBtPermissionChecking(false);
      }
    };

    const handleScanPrinters = async () => {
      setIsScanningPrinters(true);
      try {
        const devices = await scanBluetoothPrinters();
        setScannedPrinters(devices);
        setPrinterScanModalVisible(true);
      } catch (err: any) {
        Alert.alert(
          'Escaneo Bluetooth',
          err?.message || 'No se pudieron buscar dispositivos Bluetooth.'
        );
      } finally {
        setIsScanningPrinters(false);
      }
    };

    const handleSelectPrinterDevice = async (device: BluetoothPrinterDevice) => {
      const updated: PrinterConfig = {
        ...printerConfig,
        selectedDevice: device,
        connectionType: 'bluetooth',
      };
      setPrinterConfig(updated);
      await savePrinterConfig(updated);
      setPrinterScanModalVisible(false);
      Alert.alert('Impresora Seleccionada', `Vinculado a ${device.name} (${device.address}).`);
    };

    const handleUpdatePrinterSetting = async <K extends keyof PrinterConfig>(
      key: K,
      val: PrinterConfig[K]
    ) => {
      const updated = { ...printerConfig, [key]: val };
      setPrinterConfig(updated);
      await savePrinterConfig(updated);
    };

    const handleTestBluetoothConnection = async () => {
      setIsPrintingTest(true);
      try {
        const res = await testPrinterConnection(printerConfig.selectedDevice?.address);
        Alert.alert(res.success ? 'Prueba Exitosa' : 'Error de Conexión', res.message);
      } finally {
        setIsPrintingTest(false);
      }
    };

    const handlePrintTestPdf = async () => {
      setIsPrintingTest(true);
      try {
        const demoRate = taxProfile.isAmazonExempt ? 0 : taxProfile.taxRate;
        const divisor = 1 + demoRate / 100;
        const total = 40.0;
        const subtotal = Math.round((total / divisor) * 100) / 100;
        const tax = Math.round((total - subtotal) * 100) / 100;
        const resolvedBiz = resolveReceiptBusiness({
          business: businessSettings,
          branch: activeBranch,
          posSettings,
        });
        const receiptFooter = resolvedBiz.hasCustomFooter ? resolvedBiz.receiptFooter : undefined;

        const demoSale: any = {
          id: 'test_ticket',
          saleNumber: 9999,
          documentType: 'boleta',
          documentNumber: 'B001-00000001',
          date: Date.now(),
          customerName: 'VENTIFY DEMO S.A.C.',
          customerDni: '20611526572',
          paymentMethod: 'efectivo',
          cashReceived: 50,
          changeGiven: 10,
          subtotal,
          tax,
          total,
          items: [
            {
              id: 'item_1',
              productId: 'p_1',
              name: 'Ticket de Prueba Ventify',
              quantity: 1,
              unitOfMeasure: 'UND',
              price: 40.0,
              lineTotal: 40.0,
            },
          ],
        };

        await printTicketPDF(
          {
            title: 'Prueba de Impresión',
            sale: demoSale,
            business: resolvedBiz,
            options: {
              paperWidth: printerConfig.paperWidth,
              branch: activeBranch,
              taxProfile,
              receiptFooter,
              ticketTemplate: resolvedBiz.ticketTemplate,
            },
          },
          {
            paperWidth: printerConfig.paperWidth,
            branch: activeBranch,
            taxProfile,
            receiptFooter,
            ticketTemplate: resolvedBiz.ticketTemplate,
          }
        );
      } catch (err: any) {
        Alert.alert('Error de Impresión PDF', err?.message || 'No se pudo generar el PDF.');
      } finally {
        setIsPrintingTest(false);
      }
    };

    const handleForceSync = async () => {
      setLocalSyncing(true);
      try {
        const result = await triggerManualSync(true);
        await loadOfflineData();
        await refreshOfflineCount();

        if (result.total === 0) {
          Alert.alert('Sincronización', 'No hay operaciones pendientes en las colas offline.');
        } else {
          Alert.alert(
            'Sincronización Completada',
            `Total procesado: ${result.total}\nExitosas: ${result.successful}\nReintentos pendientes: ${result.retried}\nEn cuarentena: ${result.quarantined}`
          );
        }
      } catch (err: any) {
        Alert.alert('Error al Sincronizar', err?.message || 'Falló el proceso de colas offline.');
      } finally {
        setLocalSyncing(false);
      }
    };

    const handleCancelPendingSale = useCallback(
      (saleId: string) => {
        Alert.alert(
          'Descartar Venta Pendiente',
          'Se eliminará la venta pendiente de la cola local y se restaurará el stock descontado localmente. ¿Continuar?',
          [
            { text: 'Volver', style: 'cancel' },
            {
              text: 'Descartar',
              style: 'destructive',
              onPress: async () => {
                await cancelPendingOfflineSale(saleId);
                await loadOfflineData();
                await refreshOfflineCount();
              },
            },
          ]
        );
      },
      [loadOfflineData, refreshOfflineCount]
    );

    const handleCancelPendingInvOp = useCallback(
      (opId: string) => {
        Alert.alert(
          'Descartar Operación de Inventario',
          'Se eliminará esta operación pendiente de inventario.',
          [
            { text: 'Volver', style: 'cancel' },
            {
              text: 'Descartar',
              style: 'destructive',
              onPress: async () => {
                await cancelPendingInventoryOp(opId);
                await loadOfflineData();
                await refreshOfflineCount();
              },
            },
          ]
        );
      },
      [loadOfflineData, refreshOfflineCount]
    );

    const handleCancelPendingCashOp = useCallback(
      (cashId: string) => {
        Alert.alert(
          'Descartar Movimiento de Caja',
          'Se eliminará este movimiento de caja pendiente.',
          [
            { text: 'Volver', style: 'cancel' },
            {
              text: 'Descartar',
              style: 'destructive',
              onPress: async () => {
                await cancelPendingCashMovement(cashId);
                await loadOfflineData();
                await refreshOfflineCount();
              },
            },
          ]
        );
      },
      [loadOfflineData, refreshOfflineCount]
    );

    const handleRetryQuarantined = useCallback(
      async (saleId: string, newSessionId?: string) => {
        try {
          await retryQuarantinedSale(
            saleId,
            newSessionId
              ? { newSessionId, accountId: accountId || undefined }
              : undefined
          );
          if (newSessionId && isOnline) {
            await triggerManualSync(true);
          }
          await loadOfflineData();
          await refreshOfflineCount();
          Alert.alert(
            newSessionId ? 'Reasignada y Reencolada' : 'Reintento Encolado',
            newSessionId
              ? 'La venta se vinculó a la caja abierta actual y volvió a la cola.'
              : 'La venta volvió a la cola de sincronización.'
          );
        } catch (err: any) {
          Alert.alert('Error', err?.message || 'No se pudo reencolar la venta.');
        }
      },
      [accountId, isOnline, loadOfflineData, refreshOfflineCount, triggerManualSync]
    );

    const handleRemoveQuarantined = useCallback(
      async (saleId: string) => {
        Alert.alert(
          'Descartar Venta en Cuarentena',
          'Esta acción eliminará la venta fallida de la cola local permanentemente.',
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Descartar',
              style: 'destructive',
              onPress: async () => {
                await removeQuarantinedSale(saleId);
                await loadOfflineData();
                await refreshOfflineCount();
              },
            },
          ]
        );
      },
      [loadOfflineData, refreshOfflineCount]
    );

    const handleRetryQuarantinedInv = useCallback(
      async (opId: string) => {
        try {
          await retryQuarantinedInventoryOp(opId);
          await loadOfflineData();
          await refreshOfflineCount();
          Alert.alert('Reintento Encolado', 'La operación de inventario volvió a la cola.');
        } catch (err: any) {
          Alert.alert('Error', err?.message || 'No se pudo reencolar la operación.');
        }
      },
      [loadOfflineData, refreshOfflineCount]
    );

    const handleRemoveQuarantinedInv = useCallback(
      async (opId: string) => {
        Alert.alert(
          'Descartar Operación en Cuarentena',
          'Se eliminará permanentemente esta operación de inventario.',
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Descartar',
              style: 'destructive',
              onPress: async () => {
                await removeQuarantinedInventoryOp(opId);
                await loadOfflineData();
                await refreshOfflineCount();
              },
            },
          ]
        );
      },
      [loadOfflineData, refreshOfflineCount]
    );

    const offlineModalRows = useMemo<OfflineModalRow[]>(
      () => [
        ...pendingInvOps.map((data, idx) => ({
          kind: 'pending_inventory' as const,
          key: `pi_${data.offlineOpId || idx}`,
          data,
        })),
        ...offlineSales.map((data, idx) => ({
          kind: 'pending_sale' as const,
          key: `ps_${data.offlineId || data.id || idx}`,
          data,
        })),
        ...pendingCashOps.map((data, idx) => ({
          kind: 'pending_cash' as const,
          key: `pc_${data.offlineId || data.id || idx}`,
          data,
        })),
        ...quarantinedSales.map((data, idx) => ({
          kind: 'quarantined_sale' as const,
          key: `qs_${data.offlineId || data.id || idx}`,
          data,
        })),
        ...quarantinedInvOps.map((data, idx) => ({
          kind: 'quarantined_inventory' as const,
          key: `qi_${data.offlineOpId || idx}`,
          data,
        })),
      ],
      [pendingInvOps, offlineSales, pendingCashOps, quarantinedSales, quarantinedInvOps]
    );

    const offlineRowKeyExtractor = useCallback((item: OfflineModalRow) => item.key, []);
    const getOfflineRowItemType = useCallback((item: OfflineModalRow) => item.kind, []);

    const renderOfflineModalRow = useCallback(
      ({ item }: { item: OfflineModalRow }) => {
        if (item.kind === 'pending_sale') {
          return (
            <View style={styles.offlineItemRow}>
              <View style={styles.flex1}>
                <Text style={styles.deviceName}>
                  Venta pendiente · {formatPEN(item.data.salePayload?.total || 0)}
                </Text>
                <Text style={styles.deviceAddress}>
                  Intentos: {item.data.retryCount} · {formatDatePE(item.data.timestamp)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleCancelPendingSale(item.data.offlineId)}
                style={[styles.secondaryOutlineBtn, { borderColor: ui.danger, paddingHorizontal: 10, paddingVertical: 6 }]}
              >
                <Trash2 size={13} color={ui.danger} />
              </TouchableOpacity>
            </View>
          );
        }

        if (item.kind === 'pending_inventory') {
          const op = item.data;
          const label =
            op.type === 'product_create'
              ? `Nuevo producto · ${op.previewProduct?.name || op.productId}`
              : op.type === 'product_update'
              ? `Edición de producto · ${op.previewPatch?.name || op.productId}`
              : `Ajuste de stock · ${op.productName}`;
          return (
            <View style={styles.offlineItemRow}>
              <View style={styles.flex1}>
                <Text style={styles.deviceName}>{label}</Text>
                <Text style={styles.deviceAddress}>
                  Intentos: {op.retryCount || 0} · {formatDatePE(op.timestamp)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleCancelPendingInvOp(op.offlineOpId)}
                style={[styles.secondaryOutlineBtn, { borderColor: ui.danger, paddingHorizontal: 10, paddingVertical: 6 }]}
              >
                <Trash2 size={13} color={ui.danger} />
              </TouchableOpacity>
            </View>
          );
        }

        if (item.kind === 'pending_cash') {
          const mv = item.data;
          return (
            <View style={styles.offlineItemRow}>
              <View style={styles.flex1}>
                <Text style={styles.deviceName}>
                  {mv.type === 'income' ? 'Ingreso caja' : 'Egreso caja'} · {formatPEN(mv.amount)}
                </Text>
                <Text style={styles.deviceAddress}>
                  {mv.reason || mv.description} · {formatDatePE(mv.timestamp)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleCancelPendingCashOp(mv.offlineId)}
                style={[styles.secondaryOutlineBtn, { borderColor: ui.danger, paddingHorizontal: 10, paddingVertical: 6 }]}
              >
                <Trash2 size={13} color={ui.danger} />
              </TouchableOpacity>
            </View>
          );
        }

        if (item.kind === 'quarantined_inventory') {
          return (
            <View style={styles.quarantineBox}>
              <Text style={styles.quarantineTitle}>
                Inventario en cuarentena ·{' '}
                {item.data.type === 'stock_adjust' ? item.data.productName : item.data.productId}
              </Text>
              <Text style={styles.quarantineError} numberOfLines={2}>
                {item.data.lastErrorReason || 'Error de sincronización'}
              </Text>
              <View style={styles.actionButtonGroup}>
                <TouchableOpacity
                  style={[styles.secondaryOutlineBtn, styles.flex1]}
                  onPress={() => void handleRetryQuarantinedInv(item.data.offlineOpId)}
                >
                  <RefreshCw size={14} color={ui.primary} />
                  <Text style={styles.secondaryOutlineBtnText}>Reintentar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryOutlineBtn, styles.flex1, { borderColor: ui.danger }]}
                  onPress={() => void handleRemoveQuarantinedInv(item.data.offlineOpId)}
                >
                  <Trash2 size={14} color={ui.danger} />
                  <Text style={[styles.secondaryOutlineBtnText, { color: ui.danger }]}>
                    Descartar
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }

        const canReassignSession =
          item.data.failureCategory === 'cash_session_invalid' && Boolean(activeCashSessionId);
        return (
          <View style={styles.quarantineBox}>
            <Text style={styles.quarantineTitle}>
              En cuarentena · {formatPEN(item.data.salePayload?.total || 0)}
            </Text>
            <Text style={styles.quarantineError} numberOfLines={2}>
              {item.data.lastErrorReason || 'Error de sincronización'}
            </Text>
            {canReassignSession ? (
              <TouchableOpacity
                style={[styles.syncButton, { marginBottom: 8 }]}
                onPress={() =>
                  void handleRetryQuarantined(item.data.offlineId, activeCashSessionId || undefined)
                }
              >
                <RefreshCw size={14} color={ui.onPrimary} />
                <Text style={styles.syncButtonText}>Reasignar a caja abierta y reintentar</Text>
              </TouchableOpacity>
            ) : null}
            <View style={styles.actionButtonGroup}>
              <TouchableOpacity
                style={[styles.secondaryOutlineBtn, styles.flex1]}
                onPress={() => void handleRetryQuarantined(item.data.offlineId)}
              >
                <RefreshCw size={14} color={ui.primary} />
                <Text style={styles.secondaryOutlineBtnText}>Reintentar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryOutlineBtn, styles.flex1, { borderColor: ui.danger }]}
                onPress={() => void handleRemoveQuarantined(item.data.offlineId)}
              >
                <Trash2 size={14} color={ui.danger} />
                <Text style={[styles.secondaryOutlineBtnText, { color: ui.danger }]}>
                  Descartar
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      },
      [
        activeCashSessionId,
        handleCancelPendingCashOp,
        handleCancelPendingInvOp,
        handleCancelPendingSale,
        handleRemoveQuarantined,
        handleRemoveQuarantinedInv,
        handleRetryQuarantined,
        handleRetryQuarantinedInv,
      ]
    );

    return (
      <>
        <SectionHeading title="Impresora Térmica" subtitle="Bluetooth ESC/POS y PDF del sistema" />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
              <Printer size={22} color={ui.primary} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Impresora Térmica Bluetooth</Text>
              <Text style={styles.cardSubtitle}>Tickets ESC/POS 58mm y 80mm</Text>
            </View>
          </View>

          <View style={styles.statusBox}>
            <View style={styles.flex1}>
              <Text style={styles.statusBoxLabel}>DISPOSITIVO VINCULADO</Text>
              <Text style={styles.statusBoxValue}>
                {printerConfig.selectedDevice
                  ? `${printerConfig.selectedDevice.name} (${printerConfig.selectedDevice.address})`
                  : 'Ninguna impresora vinculada'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.scanButton}
              onPress={handleScanPrinters}
              disabled={isScanningPrinters}
            >
              {isScanningPrinters ? (
                <ActivityIndicator color={ui.onPrimary} size="small" />
              ) : (
                <>
                  <Bluetooth size={16} color={ui.onPrimary} />
                  <Text style={styles.scanButtonText}>Escanear</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {Platform.OS === 'android' ? (
            <TouchableOpacity
              style={styles.secondaryOutlineBtn}
              onPress={handleRequestBtPermission}
              disabled={btPermissionChecking}
            >
              {btPermissionChecking ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <>
                  <Shield size={16} color={ui.primary} />
                  <Text style={styles.secondaryOutlineBtnText}>
                    Verificar Permisos Bluetooth (Android 12+)
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Ancho de Papel</Text>
            <View style={styles.segmentControl}>
              <TouchableOpacity
                style={[styles.segmentBtn, printerConfig.paperWidth === 58 && styles.segmentBtnActive]}
                onPress={() => void handleUpdatePrinterSetting('paperWidth', 58)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    printerConfig.paperWidth === 58 && styles.segmentTextActive,
                  ]}
                >
                  58 mm
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentBtn, printerConfig.paperWidth === 80 && styles.segmentBtnActive]}
                onPress={() => void handleUpdatePrinterSetting('paperWidth', 80)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    printerConfig.paperWidth === 80 && styles.segmentTextActive,
                  ]}
                >
                  80 mm
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Modo de Salida</Text>
            <View style={styles.segmentControl}>
              <TouchableOpacity
                style={[
                  styles.segmentBtn,
                  printerConfig.connectionType === 'bluetooth' && styles.segmentBtnActive,
                ]}
                onPress={() => void handleUpdatePrinterSetting('connectionType', 'bluetooth')}
              >
                <Text
                  style={[
                    styles.segmentText,
                    printerConfig.connectionType === 'bluetooth' && styles.segmentTextActive,
                  ]}
                >
                  Bluetooth
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.segmentBtn,
                  printerConfig.connectionType === 'system_pdf' && styles.segmentBtnActive,
                ]}
                onPress={() => void handleUpdatePrinterSetting('connectionType', 'system_pdf')}
              >
                <Text
                  style={[
                    styles.segmentText,
                    printerConfig.connectionType === 'system_pdf' && styles.segmentTextActive,
                  ]}
                >
                  PDF / Sistema
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Corte Automático de Papel</Text>
              <Text style={styles.switchSubtitle}>Comando ESC/POS GS V al finalizar</Text>
            </View>
            <Switch
              value={printerConfig.autoCut}
              onValueChange={(val) => void handleUpdatePrinterSetting('autoCut', val)}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Apertura de Gaveta de Dinero</Text>
              <Text style={styles.switchSubtitle}>
                Pulso ESC p en ventas en efectivo y Cierre Z
              </Text>
            </View>
            <Switch
              value={printerConfig.openCashDrawer}
              onValueChange={(val) => void handleUpdatePrinterSetting('openCashDrawer', val)}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          <View style={styles.actionButtonGroup}>
            <TouchableOpacity
              style={[styles.testPrintBtn, styles.flex1]}
              onPress={handleTestBluetoothConnection}
              disabled={isPrintingTest}
            >
              {isPrintingTest ? (
                <ActivityIndicator color={ui.primary} />
              ) : (
                <>
                  <Bluetooth size={16} color={ui.primary} />
                  <Text style={styles.testPrintText}>Probar BT</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.testPrintBtn, styles.flex1]}
              onPress={handlePrintTestPdf}
              disabled={isPrintingTest}
            >
              {isPrintingTest ? (
                <ActivityIndicator color={ui.primary} />
              ) : (
                <>
                  <FileText size={16} color={ui.primary} />
                  <Text style={styles.testPrintText}>Probar PDF</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <SectionHeading title="Sincronización Offline" subtitle="Resiliencia ante pérdida de red" />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View
              style={[
                styles.iconBadge,
                { backgroundColor: isOnline ? ui.primarySoft : ui.warningSoft },
              ]}
            >
              {isOnline ? (
                <Wifi size={22} color={ui.primary} />
              ) : (
                <WifiOff size={22} color={ui.warning} />
              )}
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Cola Offline y Cuarentena</Text>
              <Text style={styles.cardSubtitle}>
                {isOnline
                  ? 'En Línea (Sincronización Activa)'
                  : 'Modo Offline (Guardando Localmente)'}
              </Text>
            </View>
          </View>

          <View style={styles.offlineStatsRow}>
            <View style={styles.offlineStatBox}>
              <Text style={styles.statLabel}>En Cola ({offlineSales.length} vta · {pendingInvOps.length} inv · {pendingCashOps.length} caja)</Text>
              <Text style={[styles.statValue, { color: ui.primary }]}>
                {offlineSales.length + pendingInvOps.length + pendingCashOps.length}
              </Text>
            </View>
            <View style={styles.offlineStatBox}>
              <Text style={styles.statLabel}>En Cuarentena</Text>
              <Text style={[styles.statValue, { color: ui.danger }]}>
                {quarantinedSales.length + quarantinedInvOps.length}
              </Text>
            </View>
          </View>

          <View style={styles.actionButtonGroup}>
            <TouchableOpacity
              style={[styles.syncButton, styles.flex1, isSyncingOffline && styles.buttonDisabled]}
              onPress={handleForceSync}
              disabled={isSyncingOffline}
            >
              {isSyncingOffline ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <RefreshCw size={16} color={ui.onPrimary} />
                  <Text style={styles.syncButtonText}>Sincronizar</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.secondaryOutlineBtn, styles.flex1]}
              onPress={() => setOfflineDetailsModalVisible(true)}
            >
              <AlertTriangle size={16} color={ui.warning} />
              <Text style={[styles.secondaryOutlineBtnText, { color: ui.warning }]}>
                Ver Detalle ({offlineModalRows.length})
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {printerScanModalVisible && (
          <Modal
            visible={printerScanModalVisible}
            transparent
            animationType="slide"
            onRequestClose={() => setPrinterScanModalVisible(false)}
          >
            <View style={styles.modalOverlay}>
              <SafeAreaView style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Impresoras Bluetooth</Text>
                  <TouchableOpacity
                    onPress={() => setPrinterScanModalVisible(false)}
                    style={styles.modalCloseButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar impresoras Bluetooth"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                {scannedPrinters.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Bluetooth size={36} color={ui.textMuted} />
                    <Text style={styles.emptyText}>No se detectaron impresoras vinculadas.</Text>
                    <Text style={styles.emptySub}>
                      Asegúrate de emparejar tu ticketera en los Ajustes Bluetooth de Android
                      primero.
                    </Text>
                  </View>
                ) : (
                  <ScrollView style={{ maxHeight: 280 }}>
                    {scannedPrinters.map((device, idx) => (
                      <TouchableOpacity
                        key={device.address || idx}
                        style={styles.deviceItem}
                        onPress={() => void handleSelectPrinterDevice(device)}
                      >
                        <View style={styles.flex1}>
                          <Text style={styles.deviceName}>{device.name}</Text>
                          <Text style={styles.deviceAddress}>{device.address}</Text>
                        </View>
                        <ChevronRight size={18} color={ui.primary} />
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
              </SafeAreaView>
            </View>
          </Modal>
        )}

        {offlineDetailsModalVisible && (
          <Modal
            visible={offlineDetailsModalVisible}
            transparent
            animationType="slide"
            onRequestClose={() => setOfflineDetailsModalVisible(false)}
          >
            <View style={styles.modalOverlay}>
              <SafeAreaView style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <View style={styles.flex1}>
                    <Text style={styles.modalTitle}>Cola Offline y Cuarentena</Text>
                    <Text style={styles.modalSub}>
                      Pendientes: {offlineSales.length + pendingInvOps.length + pendingCashOps.length} · Cuarentena: {quarantinedSales.length + quarantinedInvOps.length}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setOfflineDetailsModalVisible(false)}
                    style={styles.modalCloseButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar detalle offline"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                {offlineModalRows.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <CheckCircle2 size={32} color={ui.success} />
                    <Text style={styles.emptyText}>Cola sincronizada al 100%</Text>
                  </View>
                ) : (
                  <View style={{ height: 340 }}>
                    <FlashList
                      data={offlineModalRows}
                      keyExtractor={offlineRowKeyExtractor}
                      getItemType={getOfflineRowItemType}
                      renderItem={renderOfflineModalRow}
                      estimatedItemSize={84}
                    />
                  </View>
                )}
              </SafeAreaView>
            </View>
          </Modal>
        )}
      </>
    );
  }
);
