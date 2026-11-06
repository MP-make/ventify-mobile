import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { db } from '../firebase';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { EscPosBuilder } from '@/lib/printing/escpos-builder';
import { notifyShiftClosed } from '../services/notification-service';
import {
  getPairedThermalPrinters,
  printThermalRaw,
  isNativePrinterAvailable,
  BluetoothPrinterDevice,
} from '../services/thermal-printer';
import { AlertModal } from '../components/AlertModal';
import {
  Store,
  Shield,
  User,
  LogOut,
  Sparkles,
  DollarSign,
  Printer,
  QrCode,
  Check,
  X,
  Loader2,
  AlertCircle,
  FileText,
  Lock,
  Unlock,
  Bluetooth,
  Image as ImageIcon,
  Smartphone,
  Save,
  Building2,
  CreditCard,
  Banknote,
  Zap,
} from 'lucide-react';

export const SettingsView: React.FC = () => {
  const { user, userDoc, accountId, branchId, setBranchId, logout } = useAuth();
  const {
    branches,
    activeBranchName,
    isCashOpen,
    activeCashSession,
    businessName,
    businessData,
    posSettings,
    allPaymentMethods,
    updateBusinessData,
    updatePosSettings,
    togglePaymentMethod,
    primaryColor,
  } = useSettings();

  // Datos del Negocio
  const [bizName, setBizName] = useState(businessData?.businessName || '');
  const [bizRuc, setBizRuc] = useState(businessData?.ruc || '');
  const [bizAddress, setBizAddress] = useState(businessData?.address || '');
  const [bizPhone, setBizPhone] = useState(businessData?.phone || '');
  const [bizEmail, setBizEmail] = useState(businessData?.email || '');
  const [bizDescription, setBizDescription] = useState(businessData?.description || '');
  const [isSavingBiz, setIsSavingBiz] = useState(false);

  useEffect(() => {
    if (businessData) {
      setBizName(businessData.businessName || '');
      setBizRuc(businessData.ruc || '');
      setBizAddress(businessData.address || '');
      setBizPhone(businessData.phone || '');
      setBizEmail(businessData.email || '');
      setBizDescription(businessData.description || '');
    }
  }, [businessData]);

  // Parámetros del POS
  const [enableQuickSale, setEnableQuickSale] = useState(posSettings.enableQuickSale !== false);
  const [defaultDocType, setDefaultDocType] = useState(posSettings.defaultDocumentType || 'nota_venta');
  const [ticketFooter, setTicketFooter] = useState(posSettings.ticketFooterMessage || '¡Gracias por su compra!');
  const [showTaxId, setShowTaxId] = useState(posSettings.showTaxId !== false);
  const [showPhone, setShowPhone] = useState(posSettings.showBusinessPhone !== false);
  const [showAddr, setShowAddr] = useState(posSettings.showAddress !== false);
  const [isSavingPos, setIsSavingPos] = useState(false);

  useEffect(() => {
    if (posSettings) {
      setEnableQuickSale(posSettings.enableQuickSale !== false);
      setDefaultDocType(posSettings.defaultDocumentType || 'nota_venta');
      setTicketFooter(posSettings.ticketFooterMessage || '¡Gracias por su compra!');
      setShowTaxId(posSettings.showTaxId !== false);
      setShowPhone(posSettings.showBusinessPhone !== false);
      setShowAddr(posSettings.showAddress !== false);
    }
  }, [posSettings]);

  // Modal Apertura de Caja
  const [openModalOpen, setOpenModalOpen] = useState(false);
  const [initialCashInput, setInitialCashInput] = useState('100.00');
  const [isOpeningCash, setIsOpeningCash] = useState(false);

  // Modal Cierre de Caja / Arqueo
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [actualCashInput, setActualCashInput] = useState('');
  const [cashSalesSum, setCashSalesSum] = useState<number>(0);
  const [isClosingCash, setIsClosingCash] = useState(false);
  const [isLoadingSessionStats, setIsLoadingSessionStats] = useState(false);

  // Ticketera Bluetooth
  const [paperWidth, setPaperWidth] = useState<58 | 80>(() => {
    const saved = localStorage.getItem('ventify_printer_paper_width');
    return saved === '80' ? 80 : 58;
  });
  const [printerName, setPrinterName] = useState<string>(() => {
    return localStorage.getItem('ventify_bt_printer_name') || 'No vinculada';
  });
  const [printerAddress, setPrinterAddress] = useState<string>(() => {
    return localStorage.getItem('ventify_bt_printer_address') || '';
  });
  const [pairedPrintersList, setPairedPrintersList] = useState<BluetoothPrinterDevice[]>([]);
  const [showPrinterPickerModal, setShowPrinterPickerModal] = useState(false);
  const [isSearchingPrinter, setIsSearchingPrinter] = useState(false);
  const [testPrintSuccess, setTestPrintSuccess] = useState(false);

  // Modal Alert / Confirm estilizado
  const [alertState, setAlertState] = useState<{
    isOpen: boolean;
    type?: 'info' | 'warning' | 'error' | 'success' | 'confirm';
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const showAlert = (options: {
    title: string;
    message: string;
    type?: 'info' | 'warning' | 'error' | 'success';
    confirmText?: string;
    onConfirm?: () => void;
  }) => {
    setAlertState({
      isOpen: true,
      type: options.type || 'info',
      title: options.title,
      message: options.message,
      confirmText: options.confirmText || 'Aceptar',
      onConfirm: () => {
        setAlertState((prev) => ({ ...prev, isOpen: false }));
        if (options.onConfirm) options.onConfirm();
      },
    });
  };

  const showConfirm = (options: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
    onConfirm: () => void;
    onCancel?: () => void;
  }) => {
    setAlertState({
      isOpen: true,
      type: 'confirm',
      title: options.title,
      message: options.message,
      confirmText: options.confirmText || 'Continuar',
      cancelText: options.cancelText || 'Cancelar',
      isDestructive: options.isDestructive ?? false,
      onConfirm: () => {
        setAlertState((prev) => ({ ...prev, isOpen: false }));
        options.onConfirm();
      },
      onCancel: () => {
        setAlertState((prev) => ({ ...prev, isOpen: false }));
        if (options.onCancel) options.onCancel();
      },
    });
  };

  // Cobro Digital (QR Yape / Plin)
  const [digitalPhone, setDigitalPhone] = useState('');
  const [digitalHolder, setDigitalHolder] = useState('');
  const [digitalQr, setDigitalQr] = useState('');
  const [isSavingDigital, setIsSavingDigital] = useState(false);
  const [digitalSaveSuccess, setDigitalSaveSuccess] = useState(false);

  // Cargar configuración de cobro digital existente (localStorage + settings/{accountId}_pos)
  useEffect(() => {
    // 1. Lectura inmediata de localStorage
    try {
      const saved = localStorage.getItem('ventify_pos_digital_payment');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.phone) setDigitalPhone(parsed.phone);
        if (parsed.holderName) setDigitalHolder(parsed.holderName);
        if (parsed.qrUrl) setDigitalQr(parsed.qrUrl);
      }
    } catch {}

    if (!accountId) return;

    // 2. Lectura del documento existente settings/{accountId}_pos (atributo opcional digitalPayment)
    const loadDigital = async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', `${accountId}_pos`));
        if (snap.exists()) {
          const data = snap.data();
          const dig = data.digitalPayment;
          if (dig) {
            if (dig.phone) setDigitalPhone(dig.phone);
            if (dig.holderName) setDigitalHolder(dig.holderName);
            if (dig.qrUrl) setDigitalQr(dig.qrUrl);
            try {
              localStorage.setItem('ventify_pos_digital_payment', JSON.stringify(dig));
            } catch {}
          }
        }
      } catch {}
    };
    loadDigital();
  }, [accountId]);

  // Guardar configuración de papel
  const handlePaperWidthChange = (width: 58 | 80) => {
    setPaperWidth(width);
    localStorage.setItem('ventify_printer_paper_width', width.toString());
  };

  // Seleccionar impresora emparejada
  const handleSelectPairedPrinter = (dev: BluetoothPrinterDevice) => {
    setPrinterName(dev.name);
    setPrinterAddress(dev.address);
    localStorage.setItem('ventify_bt_printer_name', dev.name);
    localStorage.setItem('ventify_bt_printer_address', dev.address);
    setShowPrinterPickerModal(false);
    showAlert({
      type: 'success',
      title: '¡Ticketera Vinculada!',
      message: `${dev.name}\nMAC: ${dev.address}`,
    });
  };

  // Buscar impresora Bluetooth
  const handleSearchPrinter = async () => {
    try {
      setIsSearchingPrinter(true);

      if (isNativePrinterAvailable()) {
        const res = await getPairedThermalPrinters();
        if (!res.enabled) {
          showAlert({
            type: 'warning',
            title: 'Bluetooth Apagado',
            message: 'Por favor activa el Bluetooth en tu teléfono para detectar impresoras.',
          });
          return;
        }
        if (!res.devices || res.devices.length === 0) {
          showAlert({
            type: 'info',
            title: 'Sin Impresoras Vinculadas',
            message: 'No se encontraron ticketeras vinculadas en tu dispositivo.\n\nVe a Ajustes de Android -> Bluetooth, empareja tu ticketera térmica y luego selecciónala aquí.',
          });
          return;
        }
        setPairedPrintersList(res.devices);
        setShowPrinterPickerModal(true);
        return;
      }

      // Web Bluetooth (solo navegador web)
      if (!('bluetooth' in navigator)) {
        showAlert({
          type: 'info',
          title: 'Modo Web',
          message: `Web Bluetooth no está soportado en este navegador. Las impresiones generarán comandos ESC/POS estándar (${paperWidth}mm).`,
        });
        return;
      }
      const device = await (navigator as any).bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', 0x18f0, 0xff00],
      });
      const name = device.name || 'Impresora Bluetooth';
      setPrinterName(name);
      localStorage.setItem('ventify_bt_printer_name', name);
      showAlert({
        type: 'success',
        title: 'Impresora Vinculada',
        message: `Dispositivo: ${name}`,
      });
    } catch (err: any) {
      if (err.name !== 'NotFoundError') {
        showAlert({
          type: 'error',
          title: 'Error de Búsqueda',
          message: 'Búsqueda cancelada o no se encontró impresora: ' + err.message,
        });
      }
    } finally {
      setIsSearchingPrinter(false);
    }
  };

  // Imprimir Ticket de Prueba con EscPosBuilder
  const handleTestPrint = async () => {
    try {
      const builder = new EscPosBuilder({ paperWidth });
      builder
        .init()
        .align('center')
        .bold(true)
        .line(businessName || 'VENTIFY POS')
        .bold(false)
        .line('Prueba de Impresión Térmica')
        .line('--------------------------------')
        .align('left')
        .line(`Fecha: ${new Date().toLocaleDateString('es-PE')}`)
        .line(`Hora:  ${new Date().toLocaleTimeString('es-PE')}`)
        .line(`Ancho: ${paperWidth} mm`)
        .line(`Terminal: POS Móvil Android`)
        .line('--------------------------------')
        .itemRow('Producto Prueba 1', 1, 10.0, 10.0)
        .itemRow('Producto Prueba 2', 2, 5.0, 10.0)
        .line('--------------------------------')
        .align('right')
        .bold(true)
        .line('TOTAL: S/ 20.00')
        .bold(false)
        .align('center')
        .feed(2)
        .line('¡Ticketera configurada con éxito!')
        .feed(3)
        .cut();

      const bytes = builder.build();

      if (printerAddress && isNativePrinterAvailable()) {
        await printThermalRaw(printerAddress, bytes);
        setTestPrintSuccess(true);
        setTimeout(() => setTestPrintSuccess(false), 3000);
        showAlert({
          type: 'success',
          title: 'Ticket Impreso',
          message: `Ticket de prueba impreso con éxito en:\n${printerName}`,
        });
      } else {
        setTestPrintSuccess(true);
        setTimeout(() => setTestPrintSuccess(false), 3000);
        showAlert({
          type: 'info',
          title: 'Ticket Generado',
          message: `Ticket de prueba generado correctamente (${bytes.length} bytes ESC/POS en formato ${paperWidth}mm).${
            !printerAddress ? '\n\nVincula una ticketera Bluetooth para imprimir físicamente.' : ''
          }`,
        });
      }
    } catch (err: any) {
      showAlert({
        type: 'error',
        title: 'Error de Impresión',
        message: 'Error generando ticket de prueba: ' + err.message,
      });
    }
  };

  // Guardar datos del negocio
  const handleSaveBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) return;
    try {
      setIsSavingBiz(true);
      await updateBusinessData({
        businessName: bizName.trim(),
        ruc: bizRuc.trim(),
        address: bizAddress.trim(),
        phone: bizPhone.trim(),
        email: bizEmail.trim(),
        description: bizDescription.trim(),
      });
      showAlert({
        type: 'success',
        title: '¡Datos Guardados!',
        message: 'La información del negocio ha sido actualizada con éxito.',
      });
    } catch (err: any) {
      showAlert({
        type: 'error',
        title: 'Error al Guardar',
        message: 'No se pudo guardar la información del negocio: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsSavingBiz(false);
    }
  };

  // Guardar parámetros del POS
  const handleSavePosSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) return;
    try {
      setIsSavingPos(true);
      await updatePosSettings({
        enableQuickSale,
        defaultDocumentType: defaultDocType,
        ticketFooterMessage: ticketFooter.trim(),
        showTaxId,
        showBusinessPhone: showPhone,
        showAddress: showAddr,
      });
      showAlert({
        type: 'success',
        title: '¡Configuración Guardada!',
        message: 'Los parámetros del Punto de Venta se han actualizado.',
      });
    } catch (err: any) {
      showAlert({
        type: 'error',
        title: 'Error al Guardar',
        message: 'No se pudo actualizar los parámetros del POS: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsSavingPos(false);
    }
  };

  // Guardar QR y datos de cobro digital (en localStorage y en settings/{accountId}_pos)
  const handleSaveDigital = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) return;
    try {
      setIsSavingDigital(true);
      const payload = {
        phone: digitalPhone.trim(),
        holderName: digitalHolder.trim(),
        qrUrl: digitalQr,
        updatedAt: Date.now(),
      };

      // 1. Persistencia inmediata en localStorage
      try {
        localStorage.setItem('ventify_pos_digital_payment', JSON.stringify(payload));
      } catch {}

      // 2. Persistencia en Firestore en settings/{accountId}_pos con merge: true
      const updatedMethods = (allPaymentMethods || []).map((m) => {
        if (m.id === 'yape' || m.id === 'plin') {
          return {
            ...m,
            qrUrl: digitalQr || (m as any).qrUrl || '',
            qrLabel: digitalHolder ? `${digitalHolder} - ${digitalPhone}` : (m as any).qrLabel || '',
          };
        }
        return m;
      });

      await setDoc(
        doc(db, 'settings', `${accountId}_pos`),
        {
          accountId,
          digitalPayment: payload,
          methods: updatedMethods,
        },
        { merge: true }
      );

      setDigitalSaveSuccess(true);
      setTimeout(() => setDigitalSaveSuccess(false), 3000);
      showAlert({
        type: 'success',
        title: '¡Cobro Digital Actualizado!',
        message: 'Código QR y datos de Yape/Plin guardados correctamente.',
      });
    } catch (err: any) {
      console.warn('[SettingsView] Error writing digital payment to firestore:', err);
      setDigitalSaveSuccess(true);
      setTimeout(() => setDigitalSaveSuccess(false), 3000);
    } finally {
      setIsSavingDigital(false);
    }
  };

  const handleQrImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDigitalQr(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  // Abrir Turno de Caja
  const handleOpenShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId || !branchId || isOpeningCash) return;

    const initialAmount = parseFloat(initialCashInput);
    if (isNaN(initialAmount) || initialAmount < 0) {
      showAlert({
        type: 'warning',
        title: 'Monto Inválido',
        message: 'Ingresa un monto inicial válido (mayor o igual a 0).',
      });
      return;
    }

    try {
      setIsOpeningCash(true);
      const now = Date.now();
      const uniqueSessionId = `session_${accountId}_${branchId}_${now}`;
      const operatorPointer = user?.uid ? `active_${accountId}_${branchId}_${user.uid}` : `active_${accountId}_${branchId}`;

      // 1. Crear documento de sesión
      await setDoc(doc(db, 'cash_register_sessions', uniqueSessionId), {
        id: uniqueSessionId,
        sessionId: uniqueSessionId,
        accountId,
        branchId,
        operatorId: user?.uid || null,
        operatorEmail: user?.email || '',
        operatorName: userDoc?.displayName || user?.email || 'Cajero',
        initialAmount,
        status: 'open',
        openedAt: now,
        createdAt: now,
        cashSalesTotal: 0,
      });

      // 2. Crear puntero activo determinista
      await setDoc(doc(db, 'cash_register_sessions', operatorPointer), {
        sessionId: uniqueSessionId,
        accountId,
        branchId,
        operatorId: user?.uid || null,
        initialAmount,
        openedAt: now,
        status: 'open',
      });

      // 3. Registrar movimiento de apertura
      await addDoc(collection(db, 'cash_movements'), {
        accountId,
        branchId,
        type: 'opening',
        amount: initialAmount,
        sessionId: uniqueSessionId,
        description: 'Apertura de turno de caja (POS Mobile)',
        timestamp: now,
      });

      setOpenModalOpen(false);
      showAlert({
        type: 'success',
        title: '¡Turno Abierto!',
        message: '¡Turno de caja abierto exitosamente!',
      });
    } catch (err: any) {
      console.error('[Settings] Error opening shift:', err);
      showAlert({
        type: 'error',
        title: 'Error de Apertura',
        message: 'Error abriendo turno de caja: ' + err.message,
      });
    } finally {
      setIsOpeningCash(false);
    }
  };

  // Cargar estadísticas antes de cerrar caja
  const handleOpenCloseModal = async () => {
    if (!accountId || !branchId || !activeCashSession) return;
    try {
      setIsLoadingSessionStats(true);
      setCloseModalOpen(true);
      const sessionStart = activeCashSession.openedAt || (Date.now() - 24 * 60 * 60 * 1000);

      // Consultar movimientos de venta en efectivo de la sesión
      const q = query(
        collection(db, 'cash_movements'),
        where('accountId', '==', accountId),
        where('branchId', '==', branchId),
        where('type', '==', 'sale')
      );
      const snap = await getDocs(q);
      let salesTotal = 0;
      snap.docs.forEach((d) => {
        const m = d.data();
        if (m.timestamp >= sessionStart) {
          salesTotal += Number(m.amount || 0);
        }
      });
      setCashSalesSum(salesTotal);
      const expected = (activeCashSession.initialAmount || 0) + salesTotal;
      setActualCashInput(expected.toFixed(2));
    } catch (err) {
      console.warn('[Settings] Error loading cash sales:', err);
    } finally {
      setIsLoadingSessionStats(false);
    }
  };

  // Confirmar Cierre de Caja / Arqueo
  const handleCloseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId || !branchId || !activeCashSession || isClosingCash) return;

    const actualCash = parseFloat(actualCashInput);
    if (isNaN(actualCash) || actualCash < 0) {
      showAlert({
        type: 'warning',
        title: 'Monto Inválido',
        message: 'Ingresa el monto de efectivo real contado.',
      });
      return;
    }

    try {
      setIsClosingCash(true);
      const now = Date.now();
      const initial = activeCashSession.initialAmount || 0;
      const expected = initial + cashSalesSum;
      const difference = actualCash - expected;

      // 1. Actualizar documento de sesión a cerrado
      await updateDoc(doc(db, 'cash_register_sessions', activeCashSession.sessionId), {
        status: 'closed',
        closedAt: now,
        initialAmount: initial,
        cashSalesTotal: cashSalesSum,
        expectedCash: expected,
        actualCash,
        difference,
        closedBy: user?.email || '',
      });

      // 2. Eliminar puntero activo
      if (activeCashSession.pointerId) {
        await deleteDoc(doc(db, 'cash_register_sessions', activeCashSession.pointerId));
      }
      const operatorPointer = user?.uid ? `active_${accountId}_${branchId}_${user.uid}` : null;
      if (operatorPointer) {
        await deleteDoc(doc(db, 'cash_register_sessions', operatorPointer)).catch(() => {});
      }
      await deleteDoc(doc(db, 'cash_register_sessions', `active_${accountId}_${branchId}`)).catch(() => {});

      // 3. Registrar movimiento de cierre
      await addDoc(collection(db, 'cash_movements'), {
        accountId,
        branchId,
        branchName: activeBranchName || 'Sucursal',
        closedBy: user?.displayName || user?.email || 'Cajero',
        type: 'closing',
        amount: actualCash,
        difference,
        sessionId: activeCashSession.sessionId,
        description: `Cierre de caja y arqueo. Diferencia: S/ ${difference.toFixed(2)}`,
        timestamp: now,
      });

      // Notificación local inmediata
      await notifyShiftClosed(
        user?.displayName || user?.email || 'Cajero',
        activeBranchName || 'Sucursal',
        actualCash,
        difference
      ).catch(() => {});

      setCloseModalOpen(false);
      showAlert({
        type: 'success',
        title: '¡Caja Cerrada!',
        message: `¡Caja cerrada correctamente! Arqueo registrado.\nDiferencia: S/ ${difference.toFixed(2)}`,
      });
    } catch (err: any) {
      console.error('[Settings] Error closing shift:', err);
      showAlert({
        type: 'error',
        title: 'Error de Cierre',
        message: 'Error cerrando caja: ' + err.message,
      });
    } finally {
      setIsClosingCash(false);
    }
  };

  const handleLogout = () => {
    showConfirm({
      title: 'Cerrar Sesión',
      message: '¿Deseas cerrar sesión en esta terminal?',
      confirmText: 'Cerrar Sesión',
      cancelText: 'Cancelar',
      isDestructive: true,
      onConfirm: async () => {
        await logout();
      },
    });
  };

  const initialAmount = activeCashSession?.initialAmount ?? 0;
  const expectedTotal = initialAmount + cashSalesSum;
  const difference = (parseFloat(actualCashInput) || 0) - expectedTotal;

  return (
    <div className="flex flex-col min-h-full pb-24 p-4 space-y-4 select-none">
      {/* 1. Negocio y Perfil */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-neutral-100 border border-neutral-200 flex items-center justify-center p-2">
            <img src="./ventify-icono.webp" alt="Ventify" className="w-full h-full object-contain" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-black text-neutral-900 truncate">{businessName}</h3>
            <p className="text-[11px] text-neutral-400 truncate">{user?.email}</p>
          </div>
        </div>

        <div className="pt-2 border-t border-neutral-100 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-neutral-600">
            <Shield className="w-4 h-4 text-neutral-400" />
            <span className="font-semibold">Rol:</span>
          </div>
          <span className="font-black text-neutral-900 capitalize">
            {userDoc?.role || 'Administrador'}
          </span>
        </div>
      </div>

      {/* 2. DATOS DE LA EMPRESA / COMPROBANTE */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-black text-neutral-900">Datos del Negocio / Comprobante</h4>
          </div>
          <span className="text-[10px] font-bold text-neutral-400">Emisión de Tickets</span>
        </div>

        <form onSubmit={handleSaveBusiness} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Nombre Comercial
              </label>
              <input
                type="text"
                value={bizName}
                onChange={(e) => setBizName(e.target.value)}
                placeholder="Mi Negocio"
                className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-bold text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                RUC / NIF
              </label>
              <input
                type="text"
                value={bizRuc}
                onChange={(e) => setBizRuc(e.target.value)}
                placeholder="20123456789"
                className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-mono font-bold text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">
              Dirección Fiscal
            </label>
            <input
              type="text"
              value={bizAddress}
              onChange={(e) => setBizAddress(e.target.value)}
              placeholder="Av. Principal 123, Lima"
              className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Teléfono de Contacto
              </label>
              <input
                type="text"
                value={bizPhone}
                onChange={(e) => setBizPhone(e.target.value)}
                placeholder="987654321"
                className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-mono text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Correo Electrónico
              </label>
              <input
                type="email"
                value={bizEmail}
                onChange={(e) => setBizEmail(e.target.value)}
                placeholder="contacto@negocio.com"
                className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">
              Lema / Actividad (Encabezado)
            </label>
            <input
              type="text"
              value={bizDescription}
              onChange={(e) => setBizDescription(e.target.value)}
              placeholder="Venta de abarrotes y artículos para el hogar"
              className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={isSavingBiz}
            className="w-full h-10 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white font-bold text-xs active:scale-98 transition-all flex items-center justify-center gap-1.5 shadow-sm"
          >
            {isSavingBiz ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>Guardar Datos del Negocio</span>
          </button>
        </form>
      </div>

      {/* 3. PARÁMETROS DEL POS Y TICKET */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Store className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-black text-neutral-900">Parámetros del POS y Ticket</h4>
          </div>
          <span className="text-[10px] font-bold text-neutral-400">Reglas de Cobro</span>
        </div>

        <form onSubmit={handleSavePosSettings} className="space-y-3">
          {/* Switch: Venta Rápida 1 Clic */}
          <div className="p-3 bg-neutral-50 rounded-2xl border border-neutral-200/80 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-bold text-neutral-900">
                <Zap className="w-4 h-4 text-amber-500 fill-amber-500" />
                <span>Venta Rápida en Efectivo (1 Clic)</span>
              </div>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                Muestra el botón de cobro rápido con monto exacto en efectivo en el carrito.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEnableQuickSale(!enableQuickSale)}
              className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${
                enableQuickSale ? 'bg-emerald-600' : 'bg-neutral-300'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full bg-white shadow-md block transition-transform absolute top-1 ${
                  enableQuickSale ? 'left-6' : 'left-1'
                }`}
              />
            </button>
          </div>

          {/* Selector: Comprobante por Defecto */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1.5">
              Comprobante Predeterminado al Cobrar
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: 'nota_venta', label: 'Nota Venta' },
                { id: 'boleta', label: 'Boleta' },
                { id: 'factura', label: 'Factura' },
              ].map((docItem) => (
                <button
                  key={docItem.id}
                  type="button"
                  onClick={() => setDefaultDocType(docItem.id as any)}
                  className={`h-9 rounded-xl text-xs font-bold transition-all border ${
                    defaultDocType === docItem.id
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-950 shadow-2xs'
                      : 'border-neutral-200 bg-neutral-50 text-neutral-600'
                  }`}
                >
                  {docItem.label}
                </button>
              ))}
            </div>
          </div>

          {/* Mensaje de pie de ticket */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">
              Mensaje al Pie del Ticket
            </label>
            <input
              type="text"
              value={ticketFooter}
              onChange={(e) => setTicketFooter(e.target.value)}
              placeholder="¡Gracias por su compra! Vuelva pronto."
              className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Opciones de visualización en el ticket */}
          <div className="space-y-2 pt-1 border-t border-neutral-100">
            <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider block">
              Datos visibles en ticket impreso
            </span>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showTaxId}
                  onChange={(e) => setShowTaxId(e.target.checked)}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="text-[11px] font-semibold text-neutral-700">RUC</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPhone}
                  onChange={(e) => setShowPhone(e.target.checked)}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="text-[11px] font-semibold text-neutral-700">Teléfono</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showAddr}
                  onChange={(e) => setShowAddr(e.target.checked)}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="text-[11px] font-semibold text-neutral-700">Dirección</span>
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSavingPos}
            className="w-full h-10 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white font-bold text-xs active:scale-98 transition-all flex items-center justify-center gap-1.5 shadow-sm"
          >
            {isSavingPos ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>Guardar Parámetros de POS</span>
          </button>
        </form>
      </div>

      {/* 4. MÉTODOS DE PAGO DISPONIBLES EN CAJA */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-black text-neutral-900">Métodos de Pago en Caja</h4>
          </div>
          <span className="text-[10px] font-bold text-neutral-400">
            {allPaymentMethods.filter((m) => m.enabled).length} de {allPaymentMethods.length} activos
          </span>
        </div>
        <p className="text-[11px] text-neutral-500 leading-tight">
          Activa o desactiva qué formas de pago estarán disponibles para los cajeros en la pantalla de cobro.
        </p>

        <div className="space-y-1.5">
          {allPaymentMethods.map((m) => {
            return (
              <div
                key={m.id}
                className="p-2.5 rounded-2xl border border-neutral-200/80 bg-neutral-50 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                    m.kind === 'cash' ? 'bg-emerald-100 text-emerald-700' :
                    m.kind === 'digital' ? 'bg-purple-100 text-purple-700' :
                    'bg-blue-100 text-blue-700'
                  }`}>
                    {m.kind === 'cash' ? <Banknote className="w-4 h-4" /> :
                     m.kind === 'digital' ? <Smartphone className="w-4 h-4" /> :
                     <CreditCard className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0">
                    <span className="text-xs font-bold text-neutral-900 block truncate">{m.name}</span>
                    <span className="text-[10px] text-neutral-400 font-medium uppercase">{m.kind}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => togglePaymentMethod(m.id, !m.enabled)}
                  className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${
                    m.enabled ? 'bg-emerald-600' : 'bg-neutral-300'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full bg-white shadow-md block transition-transform absolute top-1 ${
                      m.enabled ? 'left-6' : 'left-1'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 5. OPERACIONES DE CAJA Y TURNO (MÓVIL AUTÓNOMO) */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-black text-neutral-900">Control de Caja / Turno</h4>
          </div>
          <span
            className={`text-[10px] font-black px-2.5 py-0.5 rounded-full ${
              isCashOpen
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-rose-100 text-rose-800'
            }`}
          >
            {isCashOpen ? 'TURNO ABIERTO' : 'CAJA CERRADA'}
          </span>
        </div>

        {isCashOpen ? (
          <div className="space-y-3 pt-1">
            <div className="p-3 bg-neutral-50 rounded-2xl border border-neutral-200/80 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-neutral-500 font-medium">Monto de Apertura:</span>
                <span className="font-black text-neutral-800">
                  S/ {initialAmount.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-[11px] text-neutral-400">
                <span>Sesión Activa:</span>
                <span className="font-mono">#{activeCashSession?.sessionId?.slice(-8) || 'ACTIVA'}</span>
              </div>
            </div>

            <button
              onClick={handleOpenCloseModal}
              className="w-full h-11 rounded-xl bg-neutral-900 text-white font-bold text-xs active:scale-98 transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              <Lock className="w-4 h-4 text-amber-400" />
              <span>Cerrar Caja / Realizar Arqueo</span>
            </button>
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-neutral-500">
              Abre el turno ingresando el efectivo inicial en caja para registrar las ventas y el arqueo diario.
            </p>
            <button
              onClick={() => setOpenModalOpen(true)}
              className="w-full h-11 rounded-xl text-white font-bold text-xs active:scale-98 transition-all flex items-center justify-center gap-2 shadow-sm"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              <Unlock className="w-4 h-4" />
              <span>Abrir Turno de Caja</span>
            </button>
          </div>
        )}
      </div>

      {/* 6. TICKETERA BLUETOOTH (ESC/POS 58MM / 80MM) */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Printer className="w-4 h-4 text-neutral-700" />
            <h4 className="text-xs font-black text-neutral-900">Ticketera Térmica (ESC/POS)</h4>
          </div>
          <span className="text-[10px] font-bold text-neutral-400">Bluetooth / BLE</span>
        </div>

        {/* Ancho de papel */}
        <div>
          <label className="text-[11px] font-bold text-neutral-600 block mb-1.5">
            Ancho de Papel
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handlePaperWidthChange(58)}
              className={`h-9 rounded-xl text-xs font-bold transition-all border ${
                paperWidth === 58
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-950 shadow-2xs'
                  : 'border-neutral-200 bg-neutral-50 text-neutral-600'
              }`}
            >
              58 mm (Estándar Móvil)
            </button>
            <button
              type="button"
              onClick={() => handlePaperWidthChange(80)}
              className={`h-9 rounded-xl text-xs font-bold transition-all border ${
                paperWidth === 80
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-950 shadow-2xs'
                  : 'border-neutral-200 bg-neutral-50 text-neutral-600'
              }`}
            >
              80 mm (Mostrador Grande)
            </button>
          </div>
        </div>

        {/* Dispositivo vinculado */}
        <div className="p-3 bg-neutral-50 rounded-2xl border border-neutral-200/80 flex items-center justify-between">
          <div className="min-w-0 pr-2">
            <span className="text-[10px] text-neutral-400 font-bold uppercase block">
              Dispositivo
            </span>
            <span className="text-xs font-bold text-neutral-800 truncate block">
              {printerName}
            </span>
          </div>
          <button
            onClick={handleSearchPrinter}
            disabled={isSearchingPrinter}
            className="px-3 py-1.5 rounded-xl bg-white border border-neutral-200 text-neutral-700 text-xs font-bold shadow-2xs active:scale-95 flex items-center gap-1.5 shrink-0"
          >
            {isSearchingPrinter ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Bluetooth className="w-3.5 h-3.5 text-blue-600" />
            )}
            <span>Buscar</span>
          </button>
        </div>

        {/* Botón Ticket de Prueba */}
        <button
          onClick={handleTestPrint}
          className="w-full h-10 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 font-bold text-xs active:scale-98 transition-all flex items-center justify-center gap-2 border border-neutral-200"
        >
          <FileText className="w-4 h-4 text-neutral-600" />
          <span>Imprimir Ticket de Prueba ({paperWidth}mm)</span>
        </button>
      </div>

      {/* 7. COBRO DIGITAL (QR YAPE / PLIN) */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-purple-600" />
            <h4 className="text-xs font-black text-neutral-900">Cobro Digital (Yape / Plin)</h4>
          </div>
          {digitalSaveSuccess && (
            <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1">
              <Check className="w-3 h-3" />
              <span>Guardado</span>
            </span>
          )}
        </div>

        <form onSubmit={handleSaveDigital} className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative w-16 h-16 rounded-2xl bg-neutral-100 border border-neutral-200 overflow-hidden flex items-center justify-center shrink-0">
              {digitalQr ? (
                <img src={digitalQr} alt="QR" className="w-full h-full object-contain p-1" />
              ) : (
                <QrCode className="w-6 h-6 text-neutral-400" />
              )}
            </div>
            <div>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-bold cursor-pointer active:scale-95 transition-all">
                <ImageIcon className="w-4 h-4 text-purple-600" />
                <span>{digitalQr ? 'Cambiar QR' : 'Subir QR'}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleQrImagePick}
                  className="hidden"
                />
              </label>
              <p className="text-[10px] text-neutral-400 mt-1">Imagen de tu QR Yape/Plin</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Número de Celular
              </label>
              <input
                type="text"
                placeholder="987654321"
                value={digitalPhone}
                onChange={(e) => setDigitalPhone(e.target.value)}
                className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-mono font-bold text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Nombre del Titular
              </label>
              <input
                type="text"
                placeholder="Ej. Juan Pérez"
                value={digitalHolder}
                onChange={(e) => setDigitalHolder(e.target.value)}
                className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSavingDigital}
            className="w-full h-10 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs active:scale-98 transition-all flex items-center justify-center gap-1.5 shadow-sm"
          >
            {isSavingDigital ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            <span>Guardar Configuración Digital</span>
          </button>
        </form>
      </div>

      {/* 8. SUCURSAL EN TERMINAL */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Store className="w-4 h-4 text-emerald-600" />
            <h4 className="text-xs font-black text-neutral-900">Sucursal en Terminal</h4>
          </div>
          <span className="text-[10px] font-bold text-neutral-400">
            {branches.length} disponibles
          </span>
        </div>

        <div className="space-y-1.5">
          {branches.length === 0 ? (
            <p className="text-xs text-neutral-400 italic">Sucursal Principal (Automática)</p>
          ) : (
            branches.map((b) => {
              const isSelected = branchId === b.id;
              return (
                <button
                  key={b.id}
                  onClick={() => setBranchId(b.id)}
                  className={`w-full p-2.5 rounded-xl border text-left text-xs font-bold transition-all flex items-center justify-between ${
                    isSelected
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-900 shadow-2xs'
                      : 'border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100'
                  }`}
                >
                  <span>{b.name}</span>
                  {isSelected && (
                    <span className="text-[10px] font-black uppercase text-emerald-700">
                      Activa
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 9. COLOR CORPORATIVO */}
      <div className="bg-white border border-neutral-200/90 rounded-3xl p-4 shadow-2xs space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-500" />
          <h4 className="text-xs font-black text-neutral-900">Color Corporativo</h4>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <div
            className="w-6 h-6 rounded-full shadow-inner border border-black/10"
            style={{ backgroundColor: primaryColor }}
          />
          <span className="text-xs font-bold text-neutral-700">{primaryColor}</span>
          <span className="text-[10px] text-neutral-400 ml-auto">
            Sincronizado desde tu negocio
          </span>
        </div>
      </div>

      {/* 10. BOTÓN CERRAR SESIÓN */}
      <button
        onClick={handleLogout}
        className="w-full h-12 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 font-extrabold text-xs active:scale-98 transition-all flex items-center justify-center gap-2 shadow-2xs hover:bg-rose-100"
      >
        <LogOut className="w-4 h-4" />
        <span>Cerrar Sesión</span>
      </button>

      {/* Versión info */}
      <div className="text-center pt-2">
        <p className="text-[10px] text-neutral-400">
          Ventify POS v1.0.0 (Native Offline Client) • ID: {accountId ? accountId.slice(-8) : 'N/A'}
        </p>
      </div>

      {/* MODAL APERTURA DE CAJA */}
      {openModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-xs w-full p-5 space-y-4 shadow-2xl animate-in fade-in">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <div className="flex items-center gap-2">
                <Unlock className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-black text-neutral-900">Apertura de Turno</h3>
              </div>
              <button
                onClick={() => setOpenModalOpen(false)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleOpenShift} className="space-y-3">
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                  Monto Inicial en Efectivo (S/)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-xs font-bold text-neutral-400">
                    S/
                  </span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    autoFocus
                    required
                    value={initialCashInput}
                    onChange={(e) => setInitialCashInput(e.target.value)}
                    className="w-full h-11 pl-8 pr-3 rounded-xl border border-neutral-300 bg-neutral-50 text-base font-black text-neutral-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
              </div>

              <div className="flex gap-1.5">
                {[0, 50, 100, 200].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setInitialCashInput(amt.toFixed(2))}
                    className="flex-1 py-1 rounded-lg bg-neutral-100 text-[10px] font-bold text-neutral-700 hover:bg-neutral-200"
                  >
                    S/ {amt}
                  </button>
                ))}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpenModalOpen(false)}
                  disabled={isOpeningCash}
                  className="flex-1 h-10 rounded-xl border border-neutral-200 text-xs font-bold text-neutral-600"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isOpeningCash}
                  className="flex-1 h-10 rounded-xl text-white text-xs font-bold shadow-md flex items-center justify-center gap-1.5"
                  style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                >
                  {isOpeningCash ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  <span>Abrir Caja</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL CIERRE DE CAJA / ARQUEO */}
      {closeModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-sm w-full p-5 space-y-4 shadow-2xl animate-in fade-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-neutral-900" />
                <h3 className="text-sm font-black text-neutral-900">Cierre y Arqueo de Turno</h3>
              </div>
              <button
                onClick={() => setCloseModalOpen(false)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isLoadingSessionStats ? (
              <div className="py-8 flex flex-col items-center justify-center text-neutral-400 gap-2">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
                <span className="text-xs font-bold">Calculando arqueo de caja...</span>
              </div>
            ) : (
              <form onSubmit={handleCloseShift} className="space-y-3.5">
                {/* Resumen de Efectivo Esperado */}
                <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-3.5 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-neutral-500 font-medium">(+) Monto de Apertura:</span>
                    <span className="font-bold text-neutral-800">S/ {initialAmount.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500 font-medium">(+) Ventas en Efectivo:</span>
                    <span className="font-bold text-emerald-700">S/ {cashSalesSum.toFixed(2)}</span>
                  </div>
                  <div className="pt-2 border-t border-neutral-200 flex justify-between font-black text-sm">
                    <span className="text-neutral-900">Total Esperado en Caja:</span>
                    <span className="text-neutral-900">S/ {expectedTotal.toFixed(2)}</span>
                  </div>
                </div>

                {/* Input de Efectivo Real Contado */}
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                    Efectivo Real Contado en Caja (S/)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-xs font-bold text-neutral-400">
                      S/
                    </span>
                    <input
                      type="number"
                      step="0.10"
                      min="0"
                      autoFocus
                      required
                      value={actualCashInput}
                      onChange={(e) => setActualCashInput(e.target.value)}
                      className="w-full h-11 pl-8 pr-3 rounded-xl border border-neutral-300 bg-white text-base font-black text-neutral-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>
                </div>

                {/* Diferencia / Cuadre */}
                <div className="p-3 rounded-2xl bg-neutral-100 flex items-center justify-between text-xs">
                  <span className="font-bold text-neutral-700">Diferencia de Caja:</span>
                  <span
                    className={`font-black ${
                      Math.abs(difference) < 0.05
                        ? 'text-emerald-700'
                        : difference > 0
                        ? 'text-blue-700'
                        : 'text-rose-600'
                    }`}
                  >
                    {Math.abs(difference) < 0.05
                      ? 'Cuadre Perfecto (S/ 0.00)'
                      : difference > 0
                      ? `Sobrante: +S/ ${difference.toFixed(2)}`
                      : `Faltante: -S/ ${Math.abs(difference).toFixed(2)}`}
                  </span>
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setCloseModalOpen(false)}
                    disabled={isClosingCash}
                    className="flex-1 h-11 rounded-xl border border-neutral-200 text-xs font-bold text-neutral-600"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isClosingCash}
                    className="flex-1 h-11 rounded-xl bg-neutral-900 text-white text-xs font-bold shadow-md flex items-center justify-center gap-1.5"
                  >
                    {isClosingCash ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4 text-emerald-400" />
                    )}
                    <span>Confirmar Cierre</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* MODAL SELECCIONAR IMPRESORA BLUETOOTH VINCULADA */}
      {showPrinterPickerModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-sm w-full p-5 space-y-4 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <div className="flex items-center gap-2">
                <Bluetooth className="w-5 h-5 text-blue-600" />
                <h3 className="text-sm font-black text-neutral-900">
                  Vincular Ticketera Térmica
                </h3>
              </div>
              <button
                onClick={() => setShowPrinterPickerModal(false)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-neutral-500">
              Dispositivos Bluetooth vinculados en este teléfono. Toca tu ticketera para enlazarla:
            </p>

            <div className="space-y-2 max-h-60 overflow-y-auto">
              {pairedPrintersList.map((dev) => (
                <button
                  key={dev.address}
                  onClick={() => handleSelectPairedPrinter(dev)}
                  className={`w-full p-3 rounded-2xl border text-left flex items-center justify-between transition-all ${
                    printerAddress === dev.address
                      ? 'border-emerald-600 bg-emerald-50'
                      : 'border-neutral-200 bg-neutral-50 hover:bg-neutral-100 active:scale-98'
                  }`}
                >
                  <div className="min-w-0 pr-2">
                    <p className="text-xs font-bold text-neutral-900 truncate">
                      {dev.name}
                    </p>
                    <p className="text-[10px] font-mono text-neutral-400">
                      {dev.address}
                    </p>
                  </div>
                  {printerAddress === dev.address && (
                    <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                  )}
                </button>
              ))}
            </div>

            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowPrinterPickerModal(false)}
                className="w-full h-10 rounded-xl border border-neutral-200 text-xs font-bold text-neutral-600 hover:bg-neutral-50"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE ALERTAS Y CONFIRMACIÓN ESTILIZADO */}
      <AlertModal
        isOpen={alertState.isOpen}
        type={alertState.type}
        title={alertState.title}
        message={alertState.message}
        confirmText={alertState.confirmText}
        cancelText={alertState.cancelText}
        isDestructive={alertState.isDestructive}
        onConfirm={alertState.onConfirm}
        onCancel={alertState.onCancel}
      />
    </div>
  );
};
