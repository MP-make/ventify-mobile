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
import type { AccountTaxProfile } from '@/lib/invoicing/receipt-amounts';
import { formatDatePE, formatPEN, ui } from '@/lib/theme';
import {
  getOfflineQueue,
  getQuarantinedSales,
  processOfflineQueue,
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
  | { kind: 'pending'; key: string; data: PendingOfflineSale }
  | { kind: 'quarantined'; key: string; data: QuarantinedOfflineSale };

export interface PrinterOfflineSettingsTabProps {
  accountId: string | null;
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
    const [printerConfig, setPrinterConfig] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
    const [scannedPrinters, setScannedPrinters] = useState<BluetoothPrinterDevice[]>([]);
    const [isScanningPrinters, setIsScanningPrinters] = useState(false);
    const [printerScanModalVisible, setPrinterScanModalVisible] = useState(false);
    const [isPrintingTest, setIsPrintingTest] = useState(false);
    const [btPermissionChecking, setBtPermissionChecking] = useState(false);

    const [offlineSales, setOfflineSales] = useState<PendingOfflineSale[]>([]);
    const [quarantinedSales, setQuarantinedSales] = useState<QuarantinedOfflineSale[]>([]);
    const [isSyncingOffline, setIsSyncingOffline] = useState(false);
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
      try {
        const [queue, quarantined] = await Promise.all([
          getOfflineQueue(),
          getQuarantinedSales(),
        ]);
        setOfflineSales(queue);
        setQuarantinedSales(quarantined);
      } catch (err) {
        console.error('Error cargando estado offline:', err);
      }
    }, []);

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
        const receiptFooter =
          posSettings?.ticketFooterMessage ||
          businessSettings?.receiptFooter ||
          activeBranch?.receiptFooter ||
          '¡Gracias por su compra!';

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
            business: { ...businessSettings, ...activeBranch },
            options: {
              paperWidth: printerConfig.paperWidth,
              branch: activeBranch,
              taxProfile,
              receiptFooter,
            },
          },
          {
            paperWidth: printerConfig.paperWidth,
            branch: activeBranch,
            taxProfile,
            receiptFooter,
          }
        );
      } catch (err: any) {
        Alert.alert('Error de Impresión PDF', err?.message || 'No se pudo generar el PDF.');
      } finally {
        setIsPrintingTest(false);
      }
    };

    const handleForceSync = async () => {
      setIsSyncingOffline(true);
      try {
        const result = await processOfflineQueue(accountId || undefined);
        await loadOfflineData();
        await refreshOfflineCount();

        if (result.total === 0) {
          Alert.alert('Sincronización', 'No hay ventas pendientes en la cola.');
        } else {
          Alert.alert(
            'Sincronización Completada',
            `Procesadas: ${result.processed}/${result.total}\nExitosas: ${result.successful}\nEn cuarentena: ${result.quarantined}`
          );
        }
      } catch (err: any) {
        Alert.alert('Error al Sincronizar', err?.message || 'Falló el proceso de cola offline.');
      } finally {
        setIsSyncingOffline(false);
      }
    };

    const handleRetryQuarantined = useCallback(
      async (saleId: string) => {
        try {
          await retryQuarantinedSale(saleId);
          await loadOfflineData();
          await refreshOfflineCount();
          Alert.alert('Reintento Encolado', 'La venta volvió a la cola de sincronización.');
        } catch (err: any) {
          Alert.alert('Error', err?.message || 'No se pudo reencolar la venta.');
        }
      },
      [loadOfflineData, refreshOfflineCount]
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

    const offlineModalRows = useMemo<OfflineModalRow[]>(
      () => [
        ...offlineSales.map((data, idx) => ({
          kind: 'pending' as const,
          key: `p_${data.offlineId || data.id || idx}`,
          data,
        })),
        ...quarantinedSales.map((data, idx) => ({
          kind: 'quarantined' as const,
          key: `q_${data.offlineId || data.id || idx}`,
          data,
        })),
      ],
      [offlineSales, quarantinedSales]
    );

    const offlineRowKeyExtractor = useCallback((item: OfflineModalRow) => item.key, []);
    const getOfflineRowItemType = useCallback((item: OfflineModalRow) => item.kind, []);

    const renderOfflineModalRow = useCallback(
      ({ item }: { item: OfflineModalRow }) => {
        if (item.kind === 'pending') {
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
            </View>
          );
        }
        return (
          <View style={styles.quarantineBox}>
            <Text style={styles.quarantineTitle}>
              En cuarentena · {formatPEN(item.data.salePayload?.total || 0)}
            </Text>
            <Text style={styles.quarantineError} numberOfLines={2}>
              {item.data.lastErrorReason || 'Error de sincronización'}
            </Text>
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
      [handleRetryQuarantined, handleRemoveQuarantined]
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
              <Text style={styles.statLabel}>Ventas en Cola</Text>
              <Text style={[styles.statValue, { color: ui.primary }]}>{offlineSales.length}</Text>
            </View>
            <View style={styles.offlineStatBox}>
              <Text style={styles.statLabel}>En Cuarentena</Text>
              <Text style={[styles.statValue, { color: ui.danger }]}>{quarantinedSales.length}</Text>
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
                Ver Detalle ({offlineSales.length + quarantinedSales.length})
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
                      Pendientes: {offlineSales.length} · Cuarentena: {quarantinedSales.length}
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
