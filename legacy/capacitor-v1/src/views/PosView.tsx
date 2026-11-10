import React, { useState, useRef, useEffect, useCallback } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { collection, addDoc, doc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../firebase';
import { useProducts } from '../context/ProductsContext';
import { useCart, MobileProduct, CartItem } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { EscPosBuilder } from '@/lib/printing/escpos-builder';
import { printThermalRaw, isNativePrinterAvailable } from '../services/thermal-printer';
import { notifyLowStock } from '../services/notification-service';
import { BarcodeScannerModal } from '../components/BarcodeScannerModal';
import { CheckoutModal } from './CheckoutModal';
import { AlertModal } from '../components/AlertModal';
import {
  Camera,
  CameraOff,
  Flashlight,
  FlashlightOff,
  Maximize2,
  Plus,
  Minus,
  Trash2,
  ShoppingCart,
  Search,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  MoreVertical,
  Pause,
  Play,
  Zap,
  Tag,
  DollarSign,
  X,
  Loader2,
} from 'lucide-react';

export const PosView: React.FC = () => {
  const { products } = useProducts();
  const { accountId, branchId, user } = useAuth();
  const { posSettings, isCashOpen, activeBranchName, businessName, businessData } = useSettings();
  const {
    items,
    addItem,
    updateQuantity,
    removeItem,
    clearCart,
    setCartItems,
    totalAmount,
    itemCount,
  } = useCart();

  // Camera & Scanner State
  const [cameraActive, setCameraActive] = useState(true);
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [fullscreenScan, setFullscreenScan] = useState(false);
  const [manualQuery, setManualQuery] = useState('');
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [quickSaleModalOpen, setQuickSaleModalOpen] = useState(false);

  // Quick Sale (Free Amount) State
  const [quickConcept, setQuickConcept] = useState('Varios');
  const [quickAmount, setQuickAmount] = useState('');

  // Paused Sale state
  const pausedStorageKey = `ventify_pos_paused_${accountId || 'default'}`;
  const [hasPausedSale, setHasPausedSale] = useState(false);
  const [pausedSaleData, setPausedSaleData] = useState<{ items: CartItem[]; total: number } | null>(null);

  // Modal de alertas estilizado
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

  const [scanFeedback, setScanFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isScanningRef = useRef(false);

  // Check for paused sale on load
  const checkPausedSale = useCallback(() => {
    try {
      const saved = localStorage.getItem(pausedStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const tot = parsed.reduce((sum: number, it: any) => sum + (it.price * it.quantity), 0);
          setPausedSaleData({ items: parsed, total: tot });
          setHasPausedSale(true);
          return;
        }
      }
    } catch {}
    setPausedSaleData(null);
    setHasPausedSale(false);
  }, [pausedStorageKey]);

  useEffect(() => {
    checkPausedSale();
  }, [checkPausedSale]);

  const showFeedback = (type: 'success' | 'error' | 'info', text: string) => {
    setScanFeedback({ type, text });
    setTimeout(() => {
      setScanFeedback((curr) => (curr?.text === text ? null : curr));
    }, 2400);
  };

  const processBarcode = useCallback(
    (code: string) => {
      if (!code || isScanningRef.current) return;
      isScanningRef.current = true;

      const trimmed = code.trim().toLowerCase();
      const found = products.find(
        (p) =>
          p.barcode?.toLowerCase() === trimmed ||
          p.sku?.toLowerCase() === trimmed ||
          (p as any).barcodes?.some((b: string) => b.toLowerCase() === trimmed)
      );

      if (found) {
        addItem(found, 1);
        try {
          if (navigator.vibrate) navigator.vibrate(80);
        } catch {}
        showFeedback('success', `+1 ${found.name} (S/ ${found.price.toFixed(2)})`);
      } else {
        try {
          if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
        } catch {}
        showFeedback('error', `Código "${code}" no registrado`);
      }

      setTimeout(() => {
        isScanningRef.current = false;
      }, 1200);
    },
    [products, addItem]
  );

  // Initialize rear camera stream with robust fallbacks (stops when checkout is open)
  useEffect(() => {
    if (!cameraActive || checkoutOpen) {
      if (controlsRef.current) {
        try {
          controlsRef.current.stop();
        } catch {}
        controlsRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      return;
    }

    let isMounted = true;
    const reader = new BrowserMultiFormatReader();

    const startCamera = async () => {
      try {
        if (!navigator?.mediaDevices?.getUserMedia || !videoRef.current) return;

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch {
          // Fallback if environment constraint fails on device
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        // Check torch capability
        const track = stream.getVideoTracks()[0];
        const capabilities: any = track?.getCapabilities?.() || {};
        if (capabilities.torch) {
          setHasTorch(true);
        }

        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});

        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current,
          (result) => {
            if (!isMounted) return;
            if (result) {
              const text = result.getText();
              if (text) processBarcode(text);
            }
          }
        );

        controlsRef.current = controls;
      } catch (err) {
        console.warn('[PosView] Camera start warning:', err);
      }
    };

    startCamera();

    return () => {
      isMounted = false;
      if (controlsRef.current) {
        try {
          controlsRef.current.stop();
        } catch {}
        controlsRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [cameraActive, checkoutOpen, processBarcode]);

  // Flashlight toggle
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const nextState = !torchOn;
      await (track as any).applyConstraints({
        advanced: [{ torch: nextState }],
      });
      setTorchOn(nextState);
    } catch (e) {
      console.warn('Error toggling flashlight:', e);
    }
  };

  // Abrir y Cerrar Checkout con apagado síncrono limpio de cámara y escáner
  const handleOpenCheckout = () => {
    if (torchOn && streamRef.current) {
      try {
        const track = streamRef.current.getVideoTracks()[0];
        (track as any)?.applyConstraints?.({ advanced: [{ torch: false }] });
      } catch {}
      setTorchOn(false);
    }
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch (e) {
        console.warn('Error stopping ZXing controls:', e);
      }
      controlsRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {
        console.warn('Error stopping camera tracks:', e);
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setCheckoutOpen(true);
  };

  const handleCloseCheckout = () => {
    setCheckoutOpen(false);
    setCameraActive(true);
  };

  // Pause Current Sale
  const handlePauseSale = () => {
    if (items.length === 0) return;
    try {
      localStorage.setItem(pausedStorageKey, JSON.stringify(items));
      clearCart();
      checkPausedSale();
      setActionsMenuOpen(false);
      showFeedback('info', 'Venta pausada. Pantalla libre para el siguiente cliente.');
    } catch {
      showAlert({
        type: 'error',
        title: 'Error al Pausar',
        message: 'No se pudo pausar la venta.',
      });
    }
  };

  // Recover Paused Sale
  const handleRecoverSale = () => {
    if (!pausedSaleData) return;
    if (items.length > 0) {
      showConfirm({
        title: 'Reemplazar Carrito',
        message: 'Ya tienes productos en el carrito.\n\n¿Deseas reemplazar el carrito con la orden en espera?',
        confirmText: 'Reemplazar',
        cancelText: 'Conservar Carrito',
        onConfirm: () => {
          setCartItems(pausedSaleData.items);
          localStorage.removeItem(pausedStorageKey);
          checkPausedSale();
          setActionsMenuOpen(false);
          showFeedback('success', `Venta recuperada (${pausedSaleData.items.length} productos).`);
        },
      });
      return;
    }
    setCartItems(pausedSaleData.items);
    localStorage.removeItem(pausedStorageKey);
    checkPausedSale();
    setActionsMenuOpen(false);
    showFeedback('success', `Venta recuperada (${pausedSaleData.items.length} productos).`);
  };

  // Add Free Amount (Venta Rápida al Carrito)
  const handleAddQuickSale = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const amountNum = parseFloat(quickAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      showAlert({
        type: 'warning',
        title: 'Monto Inválido',
        message: 'Ingresa un monto válido mayor a 0.',
      });
      return;
    }

    const quickProduct: MobileProduct = {
      id: `quick_${Date.now()}`,
      name: quickConcept.trim() || 'Varios / Importe Libre',
      price: amountNum,
      costPrice: 0,
      category: 'Venta Libre',
      unitOfMeasure: 'unit',
    };

    addItem(quickProduct, 1);
    setQuickAmount('');
    setQuickConcept('Varios');
    setQuickSaleModalOpen(false);
    showFeedback('success', `+1 ${quickProduct.name} (S/ ${amountNum.toFixed(2)})`);
  };

  // Cobro Directo Express (Venta Rápida e ir directo a Cobrar)
  const handleDirectCharge = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const amountNum = parseFloat(quickAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      showAlert({
        type: 'warning',
        title: 'Monto Inválido',
        message: 'Ingresa un monto válido mayor a 0 para cobrar.',
      });
      return;
    }

    const quickProduct: MobileProduct = {
      id: `quick_${Date.now()}`,
      name: quickConcept.trim() || 'Varios / Importe Libre',
      price: amountNum,
      costPrice: 0,
      category: 'Venta Libre',
      unitOfMeasure: 'unit',
    };

    addItem(quickProduct, 1);
    setQuickAmount('');
    setQuickConcept('Varios');
    setQuickSaleModalOpen(false);

    // Apagar cámara y abrir Checkout directamente
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {}
      controlsRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setCheckoutOpen(true);
  };

  const [isProcessingQuickSale, setIsProcessingQuickSale] = useState(false);

  // ⚡ Venta Rápida (1 Clic en Efectivo - Idéntica a la lógica Web)
  const handleQuickCashCheckout = async () => {
    if (items.length === 0 || isProcessingQuickSale) return;
    if (!accountId) {
      showAlert({
        type: 'warning',
        title: 'Sesión no identificada',
        message: 'No se encontró la cuenta de usuario.',
      });
      return;
    }

    try {
      setIsProcessingQuickSale(true);
      const now = Date.now();
      const saleNumber = Math.floor(100000 + Math.random() * 900000);
      const safeTotal = totalAmount;
      const bKey = branchId || 'main';

      const saleData: any = {
        accountId,
        branchId: bKey,
        branchName: activeBranchName || 'Principal',
        items: items.map((i) => ({
          productId: i.id || '',
          name: i?.product?.name || 'Producto',
          quantity: i?.quantity || 1,
          price: i?.price || 0,
          unitCost: i?.product?.costPrice || 0,
          total: (i?.price || 0) * (i?.quantity || 1),
          unitOfMeasure: i?.product?.unitOfMeasure || 'unit',
        })),
        total: safeTotal,
        totalAmount: safeTotal,
        date: now,
        createdAt: now,
        saleNumber,
        paymentMethod: 'efectivo',
        paymentCategory: 'cash',
        paymentDetails: {
          method: 'efectivo',
          methodName: 'Efectivo',
          kind: 'cash',
          cashReceived: safeTotal,
          change: 0,
        },
        documentType: posSettings.defaultDocumentType || 'nota_venta',
        status: 'completed',
        isQuickSale: true,
        sellerId: user?.uid || 'pos-mobile',
        sellerEmail: user?.email || '',
      };

      const recordRef = await addDoc(collection(db, 'sales'), saleData);

      // Descontar inventario
      for (const item of items) {
        try {
          if (item.id && !item.id.startsWith('quick_')) {
            const productRef = doc(db, 'products', item.id);
            await updateDoc(productRef, {
              [`stock.${bKey}`]: increment(-item.quantity),
            });

            const prod = item.product;
            const currentStock =
              prod?.stock && prod.stock[bKey] !== undefined
                ? prod.stock[bKey]
                : Object.values(prod?.stock || {})[0] || 0;
            const remainingStock = (Number(currentStock) || 0) - item.quantity;
            const minStock = prod?.minStock || 3;
            if (remainingStock <= minStock) {
              notifyLowStock(
                prod?.name || 'Producto',
                Math.max(0, remainingStock),
                minStock
              ).catch(() => {});
            }
          }
        } catch (stockErr) {
          console.warn('[QuickSale] Stock decrement warning:', stockErr);
        }
      }

      // Registrar movimiento de caja si está abierta
      if (isCashOpen) {
        try {
          await addDoc(collection(db, 'cash_movements'), {
            accountId,
            branchId: bKey,
            branchName: activeBranchName || 'Sucursal',
            type: 'sale',
            amount: safeTotal,
            saleId: recordRef.id,
            description: `Venta rápida POS #${saleNumber}`,
            timestamp: now,
          });
        } catch (movErr) {
          console.warn('[QuickSale] Cash movement warning:', movErr);
        }
      }

      // Impresión de ticket en ticketera Bluetooth si está vinculada
      const printerAddress = localStorage.getItem('ventify_bt_printer_address');
      const paperWidth = (localStorage.getItem('ventify_printer_paper_width') === '80' ? 80 : 58) as 58 | 80;

      if (printerAddress && isNativePrinterAvailable()) {
        try {
          const builder = new EscPosBuilder({ paperWidth });
          builder
            .init()
            .align('center')
            .bold(true)
            .line(businessName || 'VENTIFY POS')
            .bold(false);

          if (posSettings.showTaxId !== false && businessData.ruc) {
            builder.line(`RUC: ${businessData.ruc}`);
          }
          if (posSettings.showAddress !== false && businessData.address) {
            builder.line(businessData.address);
          }
          if (posSettings.showBusinessPhone !== false && businessData.phone) {
            builder.line(`Tel: ${businessData.phone}`);
          }

          builder
            .line('--------------------------------')
            .align('left')
            .line(`Ticket: #${saleNumber}`)
            .line(`Fecha: ${new Date(now).toLocaleDateString('es-PE')} ${new Date(now).toLocaleTimeString('es-PE')}`)
            .line(`Sucursal: ${activeBranchName || 'Principal'}`)
            .line(`Cajero: ${user?.displayName || user?.email?.split('@')[0] || 'POS'}`)
            .line(`Doc: ${(posSettings.defaultDocumentType || 'nota_venta').toUpperCase()}`)
            .line(`Pago: Efectivo (Monto exacto)`)
            .line('--------------------------------');

          items.forEach((item) => {
            builder.itemRow(
              item?.product?.name || 'Producto',
              item?.quantity || 1,
              item?.price || 0,
              (item?.price || 0) * (item?.quantity || 1),
              item?.product?.sku || item?.product?.barcode || '',
              item?.product?.unitOfMeasure || 'UND'
            );
          });

          builder.line('--------------------------------');
          builder.align('right');
          builder.bold(true).line(`TOTAL: S/ ${safeTotal.toFixed(2)}`).bold(false);
          builder.line(`Efectivo: S/ ${safeTotal.toFixed(2)}`);
          builder.line('Vuelto: S/ 0.00');

          builder.align('center').feed(1);
          builder.line(posSettings.ticketFooterMessage || '¡Gracias por su compra!');
          if (businessData.website) {
            builder.line(businessData.website);
          }
          builder.feed(3).cut();

          await printThermalRaw(printerAddress, builder.build());
        } catch (printErr) {
          console.warn('[QuickSale] Print warning:', printErr);
        }
      }

      // Háptico / Vibración
      try {
        if (navigator.vibrate) navigator.vibrate([60, 50, 60]);
      } catch {}

      // Limpiar carrito
      clearCart();

      // Feedback de éxito
      showAlert({
        type: 'success',
        title: '⚡ ¡Venta Rápida Exitosa!',
        message: `Venta #${saleNumber} por S/ ${safeTotal.toFixed(2)} registrada en Efectivo.${
          printerAddress ? '\nTicket emitido a ticketera Bluetooth.' : ''
        }`,
      });
    } catch (err: any) {
      showAlert({
        type: 'error',
        title: 'Error en Venta Rápida',
        message: 'No se pudo registrar la venta: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsProcessingQuickSale(false);
    }
  };

  // Quick Search suggestions
  const searchResults = manualQuery.trim()
    ? products
        .filter((p) => {
          const q = manualQuery.toLowerCase().trim();
          return (
            p.name.toLowerCase().includes(q) ||
            p.barcode?.toLowerCase().includes(q) ||
            p.sku?.toLowerCase().includes(q)
          );
        })
        .slice(0, 5)
    : [];

  return (
    <div className="flex flex-col min-h-full bg-neutral-100 select-none pb-28">
      {/* 1. VISOR DE CÁMARA / ESCÁNER SUPERIOR */}
      <div className="relative bg-black w-full h-44 shrink-0 overflow-hidden shadow-md">
        {cameraActive ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {/* Retícula de escaneo */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-56 h-28 border-2 border-emerald-400/90 rounded-2xl relative shadow-[0_0_15px_rgba(52,211,153,0.3)]">
                <div className="w-full h-0.5 bg-emerald-400 absolute top-1/2 -translate-y-1/2 shadow-[0_0_8px_#34d399] animate-pulse" />
              </div>
            </div>
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-neutral-500 gap-1.5 bg-neutral-900">
            <CameraOff className="w-8 h-8 text-neutral-600" />
            <span className="text-xs font-semibold">Cámara en pausa (Ahorro de batería)</span>
          </div>
        )}

        {/* Feedback flotante al escanear */}
        {scanFeedback && (
          <div
            className={`absolute top-2.5 left-3 right-3 py-1.5 px-3 rounded-xl text-xs font-bold text-white shadow-lg flex items-center justify-center gap-1.5 animate-in fade-in slide-in-from-top-2 duration-150 z-20 ${
              scanFeedback.type === 'success'
                ? 'bg-emerald-600/95'
                : scanFeedback.type === 'info'
                ? 'bg-blue-600/95'
                : 'bg-rose-600/95'
            }`}
          >
            {scanFeedback.type === 'success' ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : scanFeedback.type === 'info' ? (
              <Zap className="w-3.5 h-3.5" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5" />
            )}
            <span className="truncate">{scanFeedback.text}</span>
          </div>
        )}

        {/* Barra de Controles de Cámara */}
        <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between pointer-events-auto z-10">
          <div className="flex items-center gap-1.5">
            {/* Linterna */}
            {hasTorch && cameraActive && (
              <button
                onClick={toggleTorch}
                title="Encender linterna"
                className={`w-8 h-8 rounded-xl flex items-center justify-center backdrop-blur-md transition-all active:scale-95 ${
                  torchOn ? 'bg-amber-400 text-black shadow-md' : 'bg-black/50 text-white hover:bg-black/70'
                }`}
              >
                {torchOn ? <Flashlight className="w-4 h-4" /> : <FlashlightOff className="w-4 h-4" />}
              </button>
            )}

            {/* Pausar/Reanudar Cámara */}
            <button
              onClick={() => setCameraActive(!cameraActive)}
              title={cameraActive ? 'Pausar cámara' : 'Activar cámara'}
              className="w-8 h-8 rounded-xl bg-black/50 hover:bg-black/70 backdrop-blur-md text-white flex items-center justify-center active:scale-95 transition-all"
            >
              {cameraActive ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Pantalla completa escáner */}
            <button
              onClick={() => setFullscreenScan(true)}
              title="Escáner a pantalla completa"
              className="h-8 px-2.5 rounded-xl bg-black/50 hover:bg-black/70 backdrop-blur-md text-white text-[11px] font-bold flex items-center gap-1.5 active:scale-95 transition-all"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Ampliar</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. BUSCADOR RÁPIDO DE PRODUCTOS */}
      <div className="px-3 py-2 bg-white border-b border-neutral-200 sticky top-0 z-20 shadow-xs">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-neutral-400" />
          <input
            type="text"
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualQuery.trim()) {
                processBarcode(manualQuery.trim());
                setManualQuery('');
              }
            }}
            placeholder="Buscar por nombre o código de barras..."
            className="w-full h-9 pl-9 pr-8 rounded-xl bg-neutral-100 border border-neutral-200 text-xs text-neutral-800 placeholder:text-neutral-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition-colors"
          />
          {manualQuery && (
            <button
              onClick={() => setManualQuery('')}
              className="absolute right-2.5 top-2.5 text-neutral-400 hover:text-neutral-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Sugerencias de búsqueda rápida */}
        {searchResults.length > 0 && (
          <div className="mt-1.5 bg-white border border-neutral-200 rounded-xl shadow-lg divide-y divide-neutral-100 overflow-hidden">
            {searchResults.map((product) => (
              <div
                key={product.id}
                onClick={() => {
                  addItem(product, 1);
                  setManualQuery('');
                  showFeedback('success', `+1 ${product.name}`);
                }}
                className="p-2 hover:bg-neutral-50 active:bg-neutral-100 flex items-center justify-between cursor-pointer"
              >
                <div className="min-w-0 pr-2">
                  <p className="text-xs font-bold text-neutral-800 truncate">{product.name}</p>
                  <p className="text-[10px] text-neutral-400 truncate">
                    {product.barcode || product.sku || 'Sin código'}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-xs font-black text-emerald-700">
                    S/ {product.price.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. BARRA DE CABECERA DEL CARRITO + MENÚ ⋮ */}
      <div className="px-4 py-2.5 bg-white border-b border-neutral-200/80 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-4 h-4 text-neutral-700" />
          <h2 className="text-xs font-black uppercase tracking-wider text-neutral-800">
            Orden Actual ({itemCount})
          </h2>
        </div>

        <div className="flex items-center gap-1.5 relative">
          {/* Badge de venta en espera */}
          {hasPausedSale && (
            <button
              onClick={handleRecoverSale}
              className="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-black flex items-center gap-1 active:scale-95 transition-all"
            >
              <Play className="w-3 h-3 text-amber-600" />
              <span>Recuperar ({hasPausedSale ? 1 : 0})</span>
            </button>
          )}

          {/* Menú de Acciones Rápidas (⋮) */}
          <button
            onClick={() => setActionsMenuOpen(!actionsMenuOpen)}
            className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all"
            title="Acciones del Carrito"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {/* Menú desplegable */}
          {actionsMenuOpen && (
            <div className="absolute right-0 top-10 w-52 bg-white border border-neutral-200 rounded-2xl shadow-xl p-1.5 z-30 space-y-1">
              {/* Venta Rápida */}
              <button
                onClick={() => {
                  setActionsMenuOpen(false);
                  setQuickSaleModalOpen(true);
                }}
                className="w-full px-3 py-2 rounded-xl text-left text-xs font-bold text-neutral-700 hover:bg-neutral-50 flex items-center gap-2"
              >
                <Zap className="w-4 h-4 text-emerald-600" />
                <span>Cobro Rápido (Importe)</span>
              </button>

              {/* Pausar Venta */}
              {items.length > 0 && (
                <button
                  onClick={handlePauseSale}
                  className="w-full px-3 py-2 rounded-xl text-left text-xs font-bold text-neutral-700 hover:bg-neutral-50 flex items-center gap-2"
                >
                  <Pause className="w-4 h-4 text-amber-600" />
                  <span>Pausar Venta Actual</span>
                </button>
              )}

              {/* Recuperar Venta en Espera */}
              {hasPausedSale && (
                <button
                  onClick={handleRecoverSale}
                  className="w-full px-3 py-2 rounded-xl text-left text-xs font-bold text-amber-800 bg-amber-50/70 hover:bg-amber-100 flex items-center gap-2"
                >
                  <Play className="w-4 h-4 text-amber-600" />
                  <span>Recuperar Venta (S/ {pausedSaleData?.total.toFixed(2)})</span>
                </button>
              )}

              {/* Vaciar Carrito */}
              {items.length > 0 && (
                <button
                  onClick={() => {
                    setActionsMenuOpen(false);
                    showConfirm({
                      title: 'Vaciar Carrito',
                      message: '¿Estás seguro de vaciar todos los productos del carrito actual?',
                      confirmText: 'Vaciar Carrito',
                      cancelText: 'Cancelar',
                      isDestructive: true,
                      onConfirm: () => {
                        clearCart();
                        showFeedback('info', 'Carrito vaciado');
                      },
                    });
                  }}
                  className="w-full px-3 py-2 rounded-xl text-left text-xs font-bold text-rose-600 hover:bg-rose-50 flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4 text-rose-500" />
                  <span>Vaciar Carrito</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 4. LISTA DE PRODUCTOS EN EL CARRITO */}
      <div className="flex-1 p-3 space-y-2 overflow-y-auto">
        {items.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center px-4 space-y-3">
            <div className="w-16 h-16 rounded-3xl bg-neutral-200/60 flex items-center justify-center text-neutral-400">
              <ShoppingCart className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-neutral-700">El carrito está vacío</h3>
              <p className="text-xs text-neutral-400 max-w-xs">
                Apunta la cámara a un código de barras o usa el buscador superior para agregar productos.
              </p>
            </div>
            <button
              onClick={() => setQuickSaleModalOpen(true)}
              className="mt-2 px-4 py-2 rounded-xl bg-white border border-neutral-300 text-xs font-bold text-neutral-700 hover:bg-neutral-50 shadow-xs flex items-center gap-1.5"
            >
              <Tag className="w-3.5 h-3.5 text-emerald-600" />
              <span>Importe Libre / Varios</span>
            </button>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="bg-white border border-neutral-200/90 rounded-2xl p-3 shadow-2xs flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <h4 className="text-xs font-black text-neutral-900 truncate">{item.product.name}</h4>
                <div className="flex items-center gap-2 text-[11px] text-neutral-500 mt-0.5">
                  <span>Unit: S/ {item.price.toFixed(2)}</span>
                  <span>•</span>
                  <span className="font-bold text-neutral-800">
                    Subtotal: S/ {(item.price * item.quantity).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Controles de cantidad */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => updateQuantity(item.id, item.quantity - 1)}
                  className="w-7 h-7 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="w-6 text-center text-xs font-black text-neutral-900">
                  {item.quantity}
                </span>
                <button
                  onClick={() => updateQuantity(item.id, item.quantity + 1)}
                  className="w-7 h-7 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => removeItem(item.id)}
                  className="w-7 h-7 rounded-lg text-neutral-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center ml-1 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 5. BOTÓN FIJO INFERIOR "VENTA RÁPIDA (1 CLIC)" Y "REVISAR ORDEN / COBRAR" */}
      <div
        className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-neutral-200 px-3 py-2 shadow-xl max-w-md mx-auto"
        style={{
          bottom: 'calc(max(env(safe-area-inset-bottom, 0px), 24px) + 3.75rem)',
        }}
      >
        <div className="flex items-center gap-2">
          {items.length > 0 && posSettings.enableQuickSale !== false && (
            <button
              type="button"
              onClick={handleQuickCashCheckout}
              disabled={isProcessingQuickSale}
              className="h-12 px-3.5 rounded-2xl bg-amber-400 hover:bg-amber-500 text-neutral-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-md shadow-amber-900/10 active:scale-95 transition-all shrink-0"
              title="Venta rápida en efectivo (1 clic)"
            >
              {isProcessingQuickSale ? (
                <Loader2 className="w-4 h-4 animate-spin text-neutral-950" />
              ) : (
                <Zap className="w-4 h-4 fill-neutral-950 text-neutral-950" />
              )}
              <span>Venta Rápida</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleOpenCheckout}
            disabled={items.length === 0 || isProcessingQuickSale}
            className={`flex-1 h-12 rounded-2xl font-black text-sm flex items-center justify-between px-4 shadow-lg active:scale-98 transition-all ${
              items.length > 0
                ? 'text-white shadow-emerald-900/20'
                : 'bg-neutral-200 text-neutral-400 cursor-not-allowed shadow-none'
            }`}
            style={{
              backgroundColor: items.length > 0 ? 'var(--brand-primary, #047857)' : undefined,
            }}
          >
            <div className="flex items-center gap-1.5 truncate">
              <span>Cobrar</span>
              {itemCount > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-white/20">
                  {itemCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-base font-black shrink-0">
              <span>S/ {totalAmount.toFixed(2)}</span>
              <ArrowRight className="w-4 h-4 ml-0.5" />
            </div>
          </button>
        </div>
      </div>

      {/* MODAL: IMPORTE LIBRE / PRODUCTO VARIOS */}
      {quickSaleModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-sm w-full p-5 space-y-4 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-emerald-600" />
                <h3 className="text-sm font-black text-neutral-900">Importe Libre / Varios</h3>
              </div>
              <button
                onClick={() => setQuickSaleModalOpen(false)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              {/* Concepto con atajos rápidos */}
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1.5">
                  Concepto de Venta / Servicio
                </label>
                <input
                  type="text"
                  value={quickConcept}
                  onChange={(e) => setQuickConcept(e.target.value)}
                  placeholder="Ej. Varios, Servicio, etc."
                  className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-semibold text-neutral-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600"
                />
                {/* Pills de concepto rápido */}
                <div className="flex gap-1.5 mt-2 overflow-x-auto pb-0.5">
                  {['Varios', 'Servicio', 'Consumo', 'Anticipo'].map((pill) => (
                    <button
                      key={pill}
                      type="button"
                      onClick={() => setQuickConcept(pill)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all shrink-0 ${
                        quickConcept === pill
                          ? 'bg-neutral-900 text-white shadow-2xs'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                      }`}
                    >
                      {pill}
                    </button>
                  ))}
                </div>
              </div>

              {/* Monto a cobrar con atajos de efectivo */}
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1.5">
                  Monto (S/)
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-base font-black text-neutral-400">
                    S/
                  </span>
                  <input
                    type="number"
                    step="0.10"
                    min="0.10"
                    autoFocus
                    value={quickAmount}
                    onChange={(e) => setQuickAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full h-12 pl-10 pr-3 rounded-2xl border border-neutral-300 bg-neutral-50 text-xl font-black text-neutral-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600"
                  />
                </div>

                {/* Chips de montos rápidos */}
                <div className="grid grid-cols-5 gap-1.5 mt-2">
                  {[5, 10, 15, 20, 50].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setQuickAmount(amt.toFixed(2))}
                      className="h-8 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-900 text-[11px] font-black active:scale-95 transition-all flex items-center justify-center"
                    >
                      +S/ {amt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Acciones: Cobrar Directo o Agregar al Carrito */}
              <div className="flex flex-col gap-2 pt-2">
                {/* 1. Botón Principal: Cobrar Directo */}
                <button
                  type="button"
                  onClick={() => handleDirectCharge()}
                  className="w-full h-12 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs shadow-lg shadow-emerald-900/20 active:scale-98 transition-all flex items-center justify-center gap-2"
                >
                  <DollarSign className="w-4 h-4 text-white" />
                  <span>
                    Cobrar Directo {quickAmount && parseFloat(quickAmount) > 0 ? `(S/ ${parseFloat(quickAmount).toFixed(2)})` : ''}
                  </span>
                </button>

                {/* 2. Botón Secundario: Agregar al Carrito y Cancelar */}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setQuickSaleModalOpen(false)}
                    className="flex-1 h-10 rounded-xl border border-neutral-200 text-xs font-bold text-neutral-600 hover:bg-neutral-50 active:scale-98"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAddQuickSale()}
                    className="flex-1 h-10 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-xs font-bold active:scale-98 border border-neutral-200"
                  >
                    + Carrito
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE CHECKOUT / COBRO */}
      <CheckoutModal
        isOpen={checkoutOpen}
        onClose={handleCloseCheckout}
        onSuccess={() => {
          handleCloseCheckout();
          clearCart();
        }}
      />

      {/* ESCÁNER EN PANTALLA COMPLETA */}
      <BarcodeScannerModal
        isOpen={fullscreenScan}
        onClose={() => setFullscreenScan(false)}
        onScan={(code) => {
          processBarcode(code);
          setFullscreenScan(false);
        }}
      />

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
