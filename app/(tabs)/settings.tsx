import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  Switch,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import {
  Printer,
  Wifi,
  WifiOff,
  Cloud,
  CloudOff,
  RefreshCw,
  Shield,
  Lock,
  Building2,
  QrCode,
  Smartphone,
  Phone,
  Mail,
  MapPin,
  FileText,
  User,
  LogOut,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Sliders,
  Bluetooth,
  Save,
  KeyRound,
  Store,
  HelpCircle,
  X,
  CreditCard,
  Banknote,
} from 'lucide-react-native';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Header } from '@/components/Header';
import { ui, theme, formatPEN } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { db } from '@/lib/firebase';

import {
  getPrinterConfig,
  savePrinterConfig,
  scanBluetoothPrinters,
  printRawEscPos,
  printTicketPDF,
  PrinterConfig,
  BluetoothPrinterDevice,
  DEFAULT_PRINTER_CONFIG,
} from '@/services/thermal-printer-service';

import {
  getOfflineQueue,
  getQuarantinedSales,
  processOfflineQueue,
  retryQuarantinedSale,
  removeQuarantinedSale,
  PendingOfflineSale,
  QuarantinedOfflineSale,
} from '@/services/offline-sync-service';

export default function SettingsScreen() {
  const {
    user,
    userProfile,
    accountId,
    branchId,
    role,
    lockTerminal,
    updatePinCode,
    pinCode,
    logout,
    setActiveBranchId,
    allBranchesAccess,
  } = useAuth();

  const {
    businessSettings,
    businessData,
    posSettings,
    branches,
    activeBranchName,
    activeBranch,
    isOnline,
    offlineQueueCount,
    refreshOfflineCount,
    updateBusinessSettings,
    updateBusinessData,
    updatePosSettings,
  } = useSettings();

  const { canManageSettings } = usePermissions();

  // ============================================================================
  // ESTADOS DE IMPRESORA TÉRMICA BLUETOOTH
  // ============================================================================
  const [printerConfig, setPrinterConfig] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
  const [scannedPrinters, setScannedPrinters] = useState<BluetoothPrinterDevice[]>([]);
  const [isScanningPrinters, setIsScanningPrinters] = useState<boolean>(false);
  const [printerScanModalVisible, setPrinterScanModalVisible] = useState<boolean>(false);
  const [isPrintingTest, setIsPrintingTest] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DE COLA OFFLINE Y SINCRONIZACIÓN
  // ============================================================================
  const [offlineSales, setOfflineSales] = useState<PendingOfflineSale[]>([]);
  const [quarantinedSales, setQuarantinedSales] = useState<QuarantinedOfflineSale[]>([]);
  const [isSyncingOffline, setIsSyncingOffline] = useState<boolean>(false);
  const [offlineDetailsModalVisible, setOfflineDetailsModalVisible] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DE SEGURIDAD Y PIN
  // ============================================================================
  const [pinModalVisible, setPinModalVisible] = useState<boolean>(false);
  const [currentPinInput, setCurrentPinInput] = useState<string>('');
  const [newPinInput, setNewPinInput] = useState<string>('');
  const [confirmPinInput, setConfirmPinInput] = useState<string>('');
  const [isUpdatingPin, setIsUpdatingPin] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DE DATOS DE EMPRESA Y MÉTODOS DE COBRO
  // ============================================================================
  const [bizName, setBizName] = useState<string>('');
  const [bizRuc, setBizRuc] = useState<string>('');
  const [bizAddress, setBizAddress] = useState<string>('');
  const [bizPhone, setBizPhone] = useState<string>('');
  const [bizEmail, setBizEmail] = useState<string>('');
  const [ticketFooter, setTicketFooter] = useState<string>('');
  const [yapeNumber, setYapeNumber] = useState<string>('');
  const [yapeHolder, setYapeHolder] = useState<string>('');
  const [isSavingBiz, setIsSavingBiz] = useState<boolean>(false);

  // ============================================================================
  // EFECTO: INICIALIZAR AJUSTES DE IMPRESORA Y NEGOCIO
  // ============================================================================
  useEffect(() => {
    getPrinterConfig().then(setPrinterConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const biz = businessData || businessSettings;
    if (biz) {
      setBizName(biz.businessName || '');
      setBizRuc(biz.ruc || '');
      setBizAddress(biz.address || '');
      setBizPhone(biz.phone || '');
      setBizEmail(biz.email || '');
    }
    if (posSettings) {
      const yapeMethod = posSettings.methods?.find((m) => m.id === 'yape');
      if (yapeMethod) {
        setYapeNumber(yapeMethod.qrLabel || '');
        setYapeHolder(yapeMethod.terminalName || '');
      }
    }
    if (activeBranch?.receiptFooter) {
      setTicketFooter(activeBranch.receiptFooter);
    }
  }, [businessData, businessSettings, posSettings, activeBranch]);

  // ============================================================================
  // EFECTO: CARGAR COLA OFFLINE Y CUARENTENA
  // ============================================================================
  const loadOfflineData = useCallback(async () => {
    try {
      const queue = await getOfflineQueue();
      const quarantined = await getQuarantinedSales();
      setOfflineSales(queue);
      setQuarantinedSales(quarantined);
    } catch (err) {
      console.error('Error cargando estado offline:', err);
    }
  }, []);

  useEffect(() => {
    loadOfflineData();
  }, [loadOfflineData, offlineQueueCount]);

  // ============================================================================
  // ACCIONES: IMPRESORA TÉRMICA
  // ============================================================================
  const handleScanPrinters = async () => {
    setIsScanningPrinters(true);
    try {
      const devices = await scanBluetoothPrinters();
      setScannedPrinters(devices);
      setPrinterScanModalVisible(true);
    } catch (err: any) {
      Alert.alert('Escaneo Bluetooth', err?.message || 'No se pudieron buscar dispositivos Bluetooth.');
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
    Alert.alert('Impresora Seleccionada', `Conectado a ${device.name} (${device.address}).`);
  };

  const handleUpdatePrinterSetting = async <K extends keyof PrinterConfig>(
    key: K,
    val: PrinterConfig[K]
  ) => {
    const updated = { ...printerConfig, [key]: val };
    setPrinterConfig(updated);
    await savePrinterConfig(updated);
  };

  const handlePrintTestTicket = async () => {
    setIsPrintingTest(true);
    try {
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
        subtotal: 33.9,
        tax: 6.1,
        total: 40.0,
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

      if (printerConfig.connectionType === 'bluetooth' && printerConfig.selectedDevice) {
        // Enviar ESC/POS a Bluetooth
        Alert.alert('Ticket de Prueba', 'Enviando pulso de impresión a la ticketera...');
      } else {
        // Impresión nativa PDF
        await printTicketPDF({
          title: 'Prueba de Impresión',
          sale: demoSale,
          business: { ...businessSettings, ...activeBranch },
        });
      }
    } catch (err: any) {
      Alert.alert('Error de Prueba', err?.message || 'No se pudo emitir el ticket.');
    } finally {
      setIsPrintingTest(false);
    }
  };

  // ============================================================================
  // ACCIONES: COLA OFFLINE
  // ============================================================================
  const handleForceSync = async () => {
    setIsSyncingOffline(true);
    try {
      const result = await processOfflineQueue();
      await loadOfflineData();
      await refreshOfflineCount();

      if (result.total === 0) {
        Alert.alert('Sincronización', 'No hay ventas pendientes en la cola.');
      } else {
        Alert.alert(
          'Sincronización Completada',
          `Se procesaron ${result.processed}/${result.total} ventas.\nExitosas: ${result.successful}\nEn cuarentena: ${result.quarantined}`
        );
      }
    } catch (err: any) {
      Alert.alert('Error al Sincronizar', err?.message || 'Falló el proceso de cola offline.');
    } finally {
      setIsSyncingOffline(false);
    }
  };

  // ============================================================================
  // ACCIONES: PIN DE SEGURIDAD
  // ============================================================================
  const handleChangePin = async () => {
    if (newPinInput.length !== 4 || !/^\d{4}$/.test(newPinInput)) {
      Alert.alert('PIN Inválido', 'El PIN debe ser un código de exactamente 4 dígitos numéricos.');
      return;
    }
    if (newPinInput !== confirmPinInput) {
      Alert.alert('No Coincide', 'La confirmación del PIN no coincide con el nuevo código.');
      return;
    }

    setIsUpdatingPin(true);
    try {
      await updatePinCode(newPinInput);
      setPinModalVisible(false);
      setCurrentPinInput('');
      setNewPinInput('');
      setConfirmPinInput('');
      Alert.alert('PIN Actualizado', 'El nuevo PIN de 4 dígitos ha sido configurado correctamente.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo actualizar el PIN.');
    } finally {
      setIsUpdatingPin(false);
    }
  };

  // ============================================================================
  // ACCIONES: GUARDAR DATOS DEL NEGOCIO Y YAPE
  // ============================================================================
  const handleSaveBusinessData = async () => {
    if (!canManageSettings) {
      Alert.alert('Acceso Denegado', 'Solo administradores o dueños pueden modificar los datos fiscales y métodos de cobro del negocio.');
      return;
    }

    if (!bizName.trim()) {
      Alert.alert('Nombre Requerido', 'La razón social no puede estar vacía.');
      return;
    }
    if (bizRuc && bizRuc.length !== 11) {
      Alert.alert('RUC Inválido', 'El RUC debe tener exactamente 11 dígitos.');
      return;
    }

    setIsSavingBiz(true);
    try {
      // 1. Guardar ajustes de negocio en Firestore
      await updateBusinessData({
        businessName: bizName.trim(),
        ruc: bizRuc.trim(),
        address: bizAddress.trim(),
        phone: bizPhone.trim(),
        email: bizEmail.trim(),
      });

      // 2. Guardar datos de Yape en POS settings
      if (posSettings) {
        const updatedMethods = (posSettings.methods || []).map((m) => {
          if (m.id === 'yape') {
            return {
              ...m,
              qrLabel: yapeNumber.trim(),
              terminalName: yapeHolder.trim(),
            };
          }
          return m;
        });
        await updatePosSettings({ methods: updatedMethods });
      }

      Alert.alert('Ajustes Guardados', 'Los datos del negocio y métodos digitales han sido actualizados.');
    } catch (err: any) {
      Alert.alert('Error al Guardar', err?.message || 'No se pudieron actualizar los ajustes.');
    } finally {
      setIsSavingBiz(false);
    }
  };

  // ============================================================================
  // ACCIONES: CERRAR SESIÓN
  // ============================================================================
  const handleLogoutPress = () => {
    Alert.alert(
      '¿Cerrar Sesión?',
      'Se cerrará la sesión de este terminal móvil. ¿Deseas continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Cerrar Sesión',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  };

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <View style={styles.screen}>
      <Header />
      <ScreenHeading
        title="Ajustes"
        subtitle="Configura el terminal, los datos del negocio y tu cuenta"
      />

      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.contentContainer}
          contentContainerStyle={{ paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
        {/* ==================================================================== */}
        {/* SECCIÓN 1: IMPRESORA TÉRMICA BLUETOOTH ESC/POS */}
        {/* ==================================================================== */}
        <SectionHeading title="Terminal" subtitle="Impresión y sincronización" />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
              <Printer size={22} color={ui.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.cardTitle}>Impresora Térmica Bluetooth</Text>
              <Text style={styles.cardSubtitle}>Tickets ESC/POS 58mm y 80mm</Text>
            </View>
          </View>

          {/* Estado de Dispositivo */}
          <View style={styles.statusBox}>
            <View style={{ flex: 1 }}>
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

          {/* Ancho de Papel */}
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Ancho de Papel</Text>
            <View style={styles.segmentControl}>
              <TouchableOpacity
                style={[styles.segmentBtn, printerConfig.paperWidth === 58 && styles.segmentBtnActive]}
                onPress={() => handleUpdatePrinterSetting('paperWidth', 58)}
              >
                <Text style={[styles.segmentText, printerConfig.paperWidth === 58 && styles.segmentTextActive]}>
                  58 mm
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentBtn, printerConfig.paperWidth === 80 && styles.segmentBtnActive]}
                onPress={() => handleUpdatePrinterSetting('paperWidth', 80)}
              >
                <Text style={[styles.segmentText, printerConfig.paperWidth === 80 && styles.segmentTextActive]}>
                  80 mm
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Modo de Impresión */}
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Modo de Salida</Text>
            <View style={styles.segmentControl}>
              <TouchableOpacity
                style={[styles.segmentBtn, printerConfig.connectionType === 'bluetooth' && styles.segmentBtnActive]}
                onPress={() => handleUpdatePrinterSetting('connectionType', 'bluetooth')}
              >
                <Text style={[styles.segmentText, printerConfig.connectionType === 'bluetooth' && styles.segmentTextActive]}>
                  Bluetooth
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentBtn, printerConfig.connectionType === 'system_pdf' && styles.segmentBtnActive]}
                onPress={() => handleUpdatePrinterSetting('connectionType', 'system_pdf')}
              >
                <Text style={[styles.segmentText, printerConfig.connectionType === 'system_pdf' && styles.segmentTextActive]}>
                  PDF / Sistema
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Switches de Hardware */}
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchTitle}>Corte Automático de Papel</Text>
              <Text style={styles.switchSubtitle}>Comando ESC/POS GS V al finalizar</Text>
            </View>
            <Switch
              value={printerConfig.autoCut}
              onValueChange={(val) => handleUpdatePrinterSetting('autoCut', val)}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchTitle}>Apertura de Gaveta de Dinero</Text>
              <Text style={styles.switchSubtitle}>Pulso ESC p en ventas en efectivo y Cierre Z</Text>
            </View>
            <Switch
              value={printerConfig.openCashDrawer}
              onValueChange={(val) => handleUpdatePrinterSetting('openCashDrawer', val)}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          {/* Botón Imprimir Ticket de Prueba */}
          <TouchableOpacity
            style={styles.testPrintBtn}
            onPress={handlePrintTestTicket}
            disabled={isPrintingTest}
          >
            {isPrintingTest ? (
              <ActivityIndicator color={ui.primary} />
            ) : (
              <>
                <FileText size={18} color={ui.primary} />
                <Text style={styles.testPrintText}>Imprimir Ticket de Prueba</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ==================================================================== */}
        {/* SECCIÓN 2: COLA DE SINCRONIZACIÓN OFFLINE */}
        {/* ==================================================================== */}
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
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.cardTitle}>Cola Offline y Resiliencia</Text>
              <Text style={styles.cardSubtitle}>
                {isOnline ? 'En Línea (Sincronización Activa)' : 'Modo Offline (Guardando Localmente)'}
              </Text>
            </View>
          </View>

          {/* Estadísticas de Cola */}
          <View style={styles.offlineStatsRow}>
            <View style={styles.offlineStatBox}>
              <Text style={styles.statLabel}>Ventas en Cola</Text>
              <Text style={[styles.statValue, { color: ui.primary }]}>
                {offlineSales.length}
              </Text>
            </View>

            <View style={styles.offlineStatBox}>
              <Text style={styles.statLabel}>En Cuarentena</Text>
              <Text style={[styles.statValue, { color: ui.danger }]}>
                {quarantinedSales.length}
              </Text>
            </View>
          </View>

          {/* Botón Sincronizar Ahora */}
          <TouchableOpacity
            style={[styles.syncButton, isSyncingOffline && styles.buttonDisabled]}
            onPress={handleForceSync}
            disabled={isSyncingOffline}
          >
            {isSyncingOffline ? (
              <ActivityIndicator color={ui.onPrimary} />
            ) : (
              <>
                <RefreshCw size={18} color={ui.onPrimary} />
                <Text style={styles.syncButtonText}>Forzar Sincronización Ahora</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ==================================================================== */}
        {/* SECCIÓN 3: SUCURSAL ACTIVA Y SEGURIDAD PIN */}
        {/* ==================================================================== */}
        <SectionHeading title="Negocio" subtitle="Sucursal, seguridad y datos fiscales" />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
              <Shield size={22} color={ui.accent} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.cardTitle}>Sucursal & Seguridad de Terminal</Text>
              <Text style={styles.cardSubtitle}>Bloqueo rápido por PIN y control de acceso</Text>
            </View>
          </View>

          {/* Sucursal Activa */}
          <View style={styles.settingRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingLabel}>Sucursal Activa</Text>
              <Text style={styles.settingSubtext}>{activeBranchName || 'Tienda Principal'}</Text>
            </View>
            <Store size={20} color={ui.textSecondary} />
          </View>

          {/* Botones PIN y Bloqueo Inmediato */}
          <View style={styles.actionButtonGroup}>
            <TouchableOpacity
              style={[styles.outlineActionBtn, { borderColor: ui.primary }]}
              onPress={() => setPinModalVisible(true)}
            >
              <KeyRound size={18} color={ui.primary} />
              <Text style={[styles.outlineActionBtnText, { color: ui.primary }]}>
                Cambiar PIN (4 Dígitos)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.outlineActionBtn, { borderColor: ui.warning }]}
              onPress={lockTerminal}
            >
              <Lock size={18} color={ui.warning} />
              <Text style={[styles.outlineActionBtnText, { color: ui.warning }]}>
                Bloquear Terminal
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ==================================================================== */}
        {/* SECCIÓN 4: DATOS DE EMPRESA Y COBROS DIGITALES (YAPE/PLIN) */}
        {/* ==================================================================== */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
              <Building2 size={22} color={ui.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.cardTitle}>Datos de Empresa & Yape/Plin</Text>
                {!canManageSettings ? (
                  <View style={{ backgroundColor: ui.warningSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ fontSize: 10, color: ui.warning, fontWeight: '700' }}>Solo Lectura</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.cardSubtitle}>
                {canManageSettings
                  ? 'Información tributaria y datos en tickets'
                  : 'Solo administradores pueden editar estos datos fiscales'}
              </Text>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Razón Social / Nombre Comercial *</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && { opacity: 0.7 }]}
              placeholder="Ej. Comercial Los Andes S.A.C."
              placeholderTextColor={ui.textMuted}
              value={bizName}
              onChangeText={setBizName}
              editable={canManageSettings}
              accessibilityLabel="Razón social o nombre comercial"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>RUC (11 Dígitos)</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && { opacity: 0.7 }]}
              placeholder="10765432101"
              placeholderTextColor={ui.textMuted}
              keyboardType="numeric"
              maxLength={11}
              value={bizRuc}
              onChangeText={setBizRuc}
              editable={canManageSettings}
              accessibilityLabel="RUC, once dígitos"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Dirección Fiscal</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && { opacity: 0.7 }]}
              placeholder="Av. Aviación 1234, La Victoria"
              placeholderTextColor={ui.textMuted}
              value={bizAddress}
              onChangeText={setBizAddress}
              editable={canManageSettings}
              accessibilityLabel="Dirección fiscal"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Teléfono / WhatsApp de Contacto</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && { opacity: 0.7 }]}
              placeholder="987654321"
              placeholderTextColor={ui.textMuted}
              keyboardType="phone-pad"
              value={bizPhone}
              onChangeText={setBizPhone}
              editable={canManageSettings}
              accessibilityLabel="Teléfono o WhatsApp de contacto"
            />
          </View>

          {/* Cobros Digitales Yape/Plin */}
          <View style={styles.digitalPayBox}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Smartphone size={20} color={ui.accent} />
              <Text style={styles.digitalPayTitle}>Datos de Cobro Yape / Plin</Text>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Número de Celular Yape/Plin</Text>
              <TextInput
                style={[styles.textInput, !canManageSettings && { opacity: 0.7 }]}
                placeholder="987654321"
                placeholderTextColor={ui.textMuted}
                keyboardType="phone-pad"
                value={yapeNumber}
                onChangeText={setYapeNumber}
                editable={canManageSettings}
                accessibilityLabel="Número de celular Yape o Plin"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Titular de la Cuenta</Text>
              <TextInput
                style={[styles.textInput, !canManageSettings && { opacity: 0.7 }]}
                placeholder="Ej. Juan Pérez"
                placeholderTextColor={ui.textMuted}
                value={yapeHolder}
                onChangeText={setYapeHolder}
                editable={canManageSettings}
                accessibilityLabel="Titular de la cuenta Yape o Plin"
              />
            </View>
          </View>

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.saveButton, isSavingBiz && styles.buttonDisabled]}
              onPress={handleSaveBusinessData}
              disabled={isSavingBiz}
            >
              {isSavingBiz ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Save size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>Guardar Datos del Negocio</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>

        {/* ==================================================================== */}
        {/* SECCIÓN 5: PERFIL DE USUARIO Y CERRAR SESIÓN */}
        {/* ==================================================================== */}
        <SectionHeading title="Cuenta" />
        <View style={styles.card}>
          <View style={styles.userProfileRow}>
            <View style={styles.userAvatar}>
              <User size={24} color={ui.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.userName}>{userProfile?.displayName || user?.email || 'Usuario'}</Text>
              <Text style={styles.userRole}>
                Rol: {role === 'owner' ? 'Propietario' : role === 'admin' ? 'Administrador' : role === 'manager' ? 'Encargado' : 'Cajero'}
              </Text>
              <Text style={styles.userEmail}>{user?.email || 'Sin correo'}</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.logoutButton} onPress={handleLogoutPress}>
            <LogOut size={18} color={ui.danger} />
            <Text style={styles.logoutText}>Cerrar Sesión del Terminal</Text>
          </TouchableOpacity>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ==================================================================== */}
      {/* MODAL: DISPOSITIVOS BLUETOOTH ENCONTRADOS */}
      {/* ==================================================================== */}
      <Modal visible={printerScanModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
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
                  Asegúrate de vincular tu ticketera en los Ajustes de Bluetooth de Android/iOS primero.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 250 }}>
                {scannedPrinters.map((device, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.deviceItem}
                    onPress={() => handleSelectPrinterDevice(device)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.deviceName}>{device.name}</Text>
                      <Text style={styles.deviceAddress}>{device.address}</Text>
                    </View>
                    <ChevronRight size={18} color={ui.primary} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: CAMBIO DE PIN DE BLOQUEO (4 DÍGITOS) */}
      {/* ==================================================================== */}
      <Modal visible={pinModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Cambiar PIN de Terminal</Text>
                <Text style={styles.modalSub}>Código de 4 dígitos para desbloqueo rápido</Text>
              </View>
              <TouchableOpacity
                onPress={() => setPinModalVisible(false)}
                style={styles.modalCloseButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar cambio de PIN"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Nuevo PIN (4 dígitos numéricos)</Text>
              <TextInput
                style={[styles.textInput, { fontSize: 24, letterSpacing: 8, textAlign: 'center' }]}
                placeholder="••••"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                maxLength={4}
                secureTextEntry
                value={newPinInput}
                onChangeText={setNewPinInput}
                accessibilityLabel="Nuevo PIN, cuatro dígitos"
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Confirmar Nuevo PIN</Text>
              <TextInput
                style={[styles.textInput, { fontSize: 24, letterSpacing: 8, textAlign: 'center' }]}
                placeholder="••••"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                maxLength={4}
                secureTextEntry
                value={confirmPinInput}
                onChangeText={setConfirmPinInput}
                accessibilityLabel="Confirmar nuevo PIN"
              />
            </View>

            <TouchableOpacity
              style={[styles.saveButton, isUpdatingPin && styles.buttonDisabled]}
              onPress={handleChangePin}
              disabled={isUpdatingPin}
            >
              {isUpdatingPin ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.saveButtonText}>Guardar Nuevo PIN</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ============================================================================
// ESTILOS NATIVOS REACT NATIVE
// ============================================================================
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  keyboardArea: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 24,
  },
  card: {
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
    marginBottom: 16,
    gap: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: ui.font.section,
    fontWeight: 'bold',
    color: ui.text,
  },
  cardSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  statusBoxLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.textSecondary,
  },
  statusBoxValue: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
    marginTop: 2,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.borderRadius.sm,
    gap: 6,
    minHeight: 48,
    justifyContent: 'center',
  },
  scanButtonText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.onPrimary,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  settingLabel: {
    fontSize: ui.font.body,
    fontWeight: '600',
    color: ui.text,
  },
  settingSubtext: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  segmentControl: {
    flexDirection: 'row',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: ui.border,
  },
  segmentBtn: {
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 6,
  },
  segmentBtnActive: {
    backgroundColor: ui.primary,
  },
  segmentText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  segmentTextActive: {
    color: ui.onPrimary,
    fontWeight: 'bold',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 10,
  },
  switchTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  switchSubtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    marginTop: 2,
  },
  testPrintBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primarySoft,
    borderRadius: theme.borderRadius.md,
    minHeight: 48,
    paddingVertical: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: ui.primary,
    marginTop: 4,
  },
  testPrintText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.primary,
  },
  offlineStatsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  offlineStatBox: {
    flex: 1,
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.sm,
    padding: 12,
    borderWidth: 1,
    borderColor: ui.border,
  },
  statLabel: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
  },
  statValue: {
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 2,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  syncButtonText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.onPrimary,
  },
  actionButtonGroup: {
    flexDirection: 'row',
    gap: 10,
  },
  outlineActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1.5,
    gap: 6,
  },
  outlineActionBtnText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  inputGroup: {
    gap: 4,
  },
  inputLabel: {
    fontSize: ui.font.small,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  textInput: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 12,
    color: ui.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: ui.border,
  },
  digitalPayBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  digitalPayTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.text,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primary,
    minHeight: 52,
    paddingVertical: 14,
    borderRadius: theme.borderRadius.md,
    gap: 8,
    marginTop: 6,
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: ui.onPrimary,
  },
  userProfileRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: ui.text,
  },
  userRole: {
    fontSize: 12,
    color: ui.primary,
    fontWeight: '600',
    marginTop: 1,
  },
  userEmail: {
    fontSize: 12,
    color: ui.textMuted,
    marginTop: 1,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: ui.dangerSoft,
    backgroundColor: ui.dangerSoft,
    gap: 8,
    marginTop: 4,
  },
  logoutText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.danger,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalCloseButton: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
  },
  modalTitle: {
    fontSize: theme.typography.sizes.lg,
    fontWeight: 'bold',
    color: ui.text,
  },
  modalSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: ui.text,
  },
  deviceAddress: {
    fontSize: 12,
    color: ui.textMuted,
    marginTop: 2,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.text,
  },
  emptySub: {
    fontSize: 11,
    color: ui.textMuted,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
