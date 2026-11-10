import React, { useState, useMemo, useEffect, Component, ErrorInfo } from 'react';
import { collection, addDoc, doc, updateDoc, increment, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useSettings, AccountPaymentMethod } from '../context/SettingsContext';
import { EscPosBuilder } from '@/lib/printing/escpos-builder';
import { printThermalRaw, isNativePrinterAvailable } from '../services/thermal-printer';
import { AlertModal } from '../components/AlertModal';
import {
  X,
  CheckCircle2,
  Banknote,
  QrCode,
  CreditCard,
  Loader2,
  Receipt,
  AlertCircle,
  Building,
  Printer,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Search,
} from 'lucide-react';
import { notifyLowStock } from '../services/notification-service';

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export type DocumentType = 'nota_venta' | 'boleta' | 'factura' | 'cotizacion';

export const isValidRuc = (docNum: string | undefined | null): boolean => {
  if (!docNum || typeof docNum !== 'string') return false;
  const cleaned = docNum.trim();
  if (!/^\d{11}$/.test(cleaned)) return false;
  const prefix = cleaned.substring(0, 2);
  return ['10', '15', '16', '17', '20'].includes(prefix);
};

// Error Boundary local para garantizar que NUNCA quede la pantalla en blanco
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class CheckoutErrorBoundary extends Component<{ children: React.ReactNode; onClose: () => void }, ErrorBoundaryState> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CheckoutErrorBoundary] error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full text-center space-y-4 shadow-2xl">
            <div className="w-14 h-14 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-7 h-7" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-black text-neutral-900">Detalle en Checkout</h3>
              <p className="text-xs text-neutral-500">
                Ocurrió un error inesperado al procesar la orden.
              </p>
            </div>
            <p className="text-[11px] font-mono bg-neutral-100 p-2.5 rounded-xl border border-neutral-200 text-left overflow-x-auto text-neutral-700">
              {this.state.error?.message || 'Error desconocido'}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                this.props.onClose();
              }}
              className="w-full h-11 rounded-2xl bg-neutral-900 text-white font-bold text-xs flex items-center justify-center gap-2 active:scale-95 transition-all shadow-md"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Volver a la Venta</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export const CheckoutModalContent: React.FC<CheckoutModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { accountId, branchId, user } = useAuth();
  const { items, totalAmount, clearCart } = useCart();
  const { isCashOpen, activeBranchName, businessName, businessData, paymentMethods, posSettings } = useSettings();

  const safeItems = Array.isArray(items) ? items : [];
  const safeTotal = typeof totalAmount === 'number' && !isNaN(totalAmount) ? totalAmount : 0;

  // 1. ALL HOOKS UNCONDITIONALLY AT THE TOP
  const [docType, setDocType] = useState<DocumentType>(() => posSettings?.defaultDocumentType || 'nota_venta');

  useEffect(() => {
    if (posSettings?.defaultDocumentType) {
      setDocType(posSettings.defaultDocumentType);
    }
  }, [posSettings?.defaultDocumentType]);

  const [customerRuc, setCustomerRuc] = useState('');
  const [customerBusinessName, setCustomerBusinessName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerDni, setCustomerDni] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [isSearchingDocument, setIsSearchingDocument] = useState(false);
  const [docLookupError, setDocLookupError] = useState<string | null>(null);

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

  // Consulta automática de DNI (RENIEC) y RUC (SUNAT) mediante backend
  const lookupDocument = async (type: 'dni' | 'ruc', number: string) => {
    const cleanNum = number.trim();
    if (!cleanNum) return;
    if (type === 'dni' && cleanNum.length !== 8) return;
    if (type === 'ruc' && cleanNum.length !== 11) return;

    try {
      setIsSearchingDocument(true);
      setDocLookupError(null);
      const token = user ? await user.getIdToken() : '';
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ventify.com.pe').replace(/\/$/, '');
      const res = await fetch(`${baseUrl}/api/dni-ruc/lookup?type=${type}&number=${cleanNum}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Error ${res.status}`);
      }

      const json = await res.json();
      if (json.success && json.data) {
        if (type === 'dni') {
          if (json.data.name) setCustomerName(json.data.name);
        } else if (type === 'ruc') {
          if (json.data.name) setCustomerBusinessName(json.data.name);
          if (json.data.address) setCustomerAddress(json.data.address);
        }
      }
    } catch (err: any) {
      console.warn('[Checkout] Lookup error:', err);
      setDocLookupError(err.message || 'No se pudo consultar el documento');
    } finally {
      setIsSearchingDocument(false);
    }
  };

  // Auto-consulta DNI cuando alcanza 8 dígitos
  useEffect(() => {
    if (docType === 'boleta' && customerDni.length === 8 && /^\d{8}$/.test(customerDni)) {
      lookupDocument('dni', customerDni);
    }
  }, [docType, customerDni]);

  // Auto-consulta RUC cuando alcanza 11 dígitos y es válido
  useEffect(() => {
    if (docType === 'factura' && customerRuc.length === 11 && isValidRuc(customerRuc)) {
      lookupDocument('ruc', customerRuc);
    }
  }, [docType, customerRuc]);

  // Selected payment method ID
  const [selectedMethodId, setSelectedMethodId] = useState<string>('efectivo');
  const [cashReceived, setCashReceived] = useState<number>(safeTotal);
  const [notes, setNotes] = useState('');
  const [showItemBreakdown, setShowItemBreakdown] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saleComplete, setSaleComplete] = useState(false);
  const [lastSaleDoc, setLastSaleDoc] = useState<any | null>(null);
  const [ticketPrinted, setTicketPrinted] = useState(false);

  // Digital payment info (Yape/Plin QR)
  const [digitalInfo, setDigitalInfo] = useState<{
    phone?: string;
    holderName?: string;
    qrUrl?: string;
  } | null>(() => {
    try {
      const saved = localStorage.getItem('ventify_pos_digital_payment');
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  });

  // Paper width from settings/localStorage
  const [paperWidth] = useState<58 | 80>(() => {
    const saved = localStorage.getItem('ventify_printer_paper_width');
    return saved === '80' ? 80 : 58;
  });

  // Subscribe to digital payment settings from pos document (safe merge)
  useEffect(() => {
    if (!accountId) return;
    try {
      const unsub = onSnapshot(
        doc(db, 'settings', `${accountId}_pos`),
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            if (data?.digitalPayment) {
              setDigitalInfo(data.digitalPayment);
              try {
                localStorage.setItem(
                  'ventify_pos_digital_payment',
                  JSON.stringify(data.digitalPayment)
                );
              } catch {}
            }
          }
        },
        () => {}
      );
      return () => unsub();
    } catch {}
  }, [accountId]);

  // Safe payment methods list
  const safeMethods = useMemo<AccountPaymentMethod[]>(() => {
    if (Array.isArray(paymentMethods) && paymentMethods.length > 0) {
      return paymentMethods;
    }
    return [
      { id: 'efectivo', name: 'Efectivo', kind: 'cash', enabled: true, order: 0 },
      { id: 'yape', name: 'Yape', kind: 'digital', enabled: true, order: 1 },
      { id: 'plin', name: 'Plin', kind: 'digital', enabled: true, order: 2 },
      { id: 'tarjeta', name: 'Tarjeta', kind: 'card', enabled: true, order: 3 },
    ];
  }, [paymentMethods]);

  // Sync state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCashReceived(safeTotal);
      setSaleComplete(false);
      setLastSaleDoc(null);
      setTicketPrinted(false);
      setShowItemBreakdown(false);
      if (safeMethods.length > 0 && !safeMethods.some((m) => m.id === selectedMethodId)) {
        setSelectedMethodId(safeMethods[0].id);
      }
    }
  }, [isOpen, safeTotal, safeMethods]);

  // Resolved current payment method object
  const activeMethod = useMemo<AccountPaymentMethod>(() => {
    const found = safeMethods.find((m) => m && m.id === selectedMethodId);
    if (found) return found;
    return safeMethods[0] || { id: 'efectivo', name: 'Efectivo', kind: 'cash', enabled: true, order: 0 };
  }, [safeMethods, selectedMethodId]);

  const change = Math.max(0, (cashReceived || 0) - safeTotal);
  const rucValid = isValidRuc(customerRuc);

  const canSubmit = useMemo(() => {
    if (safeItems.length === 0 || isSubmitting) return false;
    if (docType === 'factura') {
      if (!rucValid || !customerBusinessName.trim()) return false;
    }
    if (activeMethod.kind === 'cash' && (cashReceived || 0) < safeTotal) {
      return false;
    }
    return true;
  }, [
    safeItems.length,
    isSubmitting,
    docType,
    rucValid,
    customerBusinessName,
    activeMethod.kind,
    cashReceived,
    safeTotal,
  ]);

  // Dynamic quick bills
  const quickCashOptions = useMemo(() => {
    const baseBills = [10, 20, 50, 100, 200];
    const higher = baseBills.filter((b) => b >= safeTotal);
    if (higher.length === 0) {
      const next10 = Math.ceil(safeTotal / 10) * 10;
      const next50 = Math.ceil(safeTotal / 50) * 50;
      const next100 = Math.ceil(safeTotal / 100) * 100;
      return Array.from(new Set([next10, next50, next100])).filter((b) => b > safeTotal);
    }
    return higher.slice(0, 4);
  }, [safeTotal]);

  // CONDITIONAL EARLY RETURN ONLY AFTER ALL HOOKS
  if (!isOpen) return null;

  // Imprimir Ticket Térmico mediante EscPosBuilder
  const handlePrintTicket = async () => {
    try {
      const builder = new EscPosBuilder({ paperWidth });
      const saleNum = lastSaleDoc?.saleNumber || Math.floor(100000 + Math.random() * 900000);
      const title =
        docType === 'factura'
          ? 'FACTURA ELECTRONICA'
          : docType === 'boleta'
          ? 'BOLETA DE VENTA ELECTRONICA'
          : docType === 'cotizacion'
          ? 'COTIZACION'
          : 'NOTA DE VENTA';

      builder
        .init()
        .align('center')
        .bold(true)
        .line(businessData?.businessName || businessName || 'VENTIFY POS')
        .bold(false);

      if (posSettings?.showTaxId !== false && businessData?.ruc) {
        builder.line(`RUC: ${businessData.ruc}`);
      }
      if (posSettings?.showAddress !== false && businessData?.address) {
        builder.line(businessData.address);
      }
      if (posSettings?.showBusinessPhone !== false && businessData?.phone) {
        builder.line(`Tel: ${businessData.phone}`);
      }
      builder.line(`Sucursal: ${activeBranchName || 'Principal'}`);
      builder.line('--------------------------------');

      builder
        .bold(true)
        .line(title)
        .line(`Nro: #${saleNum}`)
        .bold(false);

      builder.align('left');
      builder.line(`Fecha: ${new Date().toLocaleDateString('es-PE')}`);
      builder.line(`Hora:  ${new Date().toLocaleTimeString('es-PE')}`);
      builder.line(`Cajero: ${user?.displayName || user?.email || 'Mostrador'}`);

      if (docType === 'factura') {
        builder.line(`Cliente: ${customerBusinessName}`);
        builder.line(`RUC: ${customerRuc}`);
      } else if (docType === 'boleta' && customerDni) {
        builder.line(`DNI: ${customerDni}`);
      }

      builder.line(`Pago: ${activeMethod.name}`);
      builder.line('--------------------------------');

      // Ítems de la orden
      safeItems.forEach((item) => {
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

      if (docType === 'factura' || docType === 'boleta') {
        const subtotal = safeTotal / 1.18;
        const igv = safeTotal - subtotal;
        builder.line(`Op. Gravada: S/ ${subtotal.toFixed(2)}`);
        builder.line(`IGV (18%): S/ ${igv.toFixed(2)}`);
      }

      builder
        .bold(true)
        .line(`TOTAL: S/ ${safeTotal.toFixed(2)}`)
        .bold(false);

      if (activeMethod.kind === 'cash') {
        builder.line(`Efectivo: S/ ${(cashReceived || safeTotal).toFixed(2)}`);
        builder.line(`Vuelto: S/ ${change.toFixed(2)}`);
      }

      builder.align('center').feed(1);
      builder.line(posSettings?.ticketFooterMessage || '¡Gracias por su compra!');
      if (businessData?.website) {
        builder.line(businessData.website);
      }
      builder.feed(3).cut();

      const bytes = builder.build();
      const printerAddress = localStorage.getItem('ventify_bt_printer_address');

      if (printerAddress && isNativePrinterAvailable()) {
        try {
          await printThermalRaw(printerAddress, bytes);
          setTicketPrinted(true);
          showAlert({
            type: 'success',
            title: 'Ticket Impreso',
            message: 'Comprobante impreso con éxito en tu ticketera Bluetooth.',
          });
        } catch (printErr: any) {
          showAlert({
            type: 'error',
            title: 'Error de Ticketera',
            message: 'No se pudo enviar el ticket: ' + (printErr.message || 'Error de conexión'),
          });
        }
      } else {
        setTicketPrinted(true);
        showAlert({
          type: 'info',
          title: 'Ticket Generado',
          message: `Ticket generado correctamente (${bytes.length} bytes ESC/POS, formato ${paperWidth}mm).${
            !printerAddress ? '\n\nConfigura tu ticketera en Ajustes para imprimir físicamente.' : ''
          }`,
        });
      }
    } catch (err: any) {
      showAlert({
        type: 'error',
        title: 'Error de Impresión',
        message: 'Error generando ticket de impresión: ' + err.message,
      });
    }
  };

  const handleFinishSale = async () => {
    if (!accountId || !canSubmit) return;

    try {
      setIsSubmitting(true);
      const now = Date.now();
      const saleNumber = Math.floor(100000 + Math.random() * 900000);

      // 1. Record data
      const saleData: any = {
        accountId,
        branchId: branchId || 'main',
        branchName: activeBranchName || 'Principal',
        items: safeItems.map((i) => ({
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
        paymentMethod: activeMethod.id,
        paymentCategory: activeMethod.kind,
        paymentDetails: {
          method: activeMethod.id,
          methodName: activeMethod.name,
          kind: activeMethod.kind,
          cashReceived: activeMethod.kind === 'cash' ? (cashReceived || safeTotal) : safeTotal,
          change: activeMethod.kind === 'cash' ? change : 0,
        },
        documentType: docType,
        status: docType === 'cotizacion' ? 'quote' : 'completed',
        isQuote: docType === 'cotizacion',
        sellerId: user?.uid || 'pos-mobile',
        sellerEmail: user?.email || '',
        notes: notes.trim(),
      };

      if (docType === 'factura') {
        saleData.customerDocType = 'RUC';
        saleData.customerDocNumber = customerRuc.trim();
        saleData.customerDocument = customerRuc.trim();
        saleData.customerName = customerBusinessName.trim();
        if (customerAddress.trim()) {
          saleData.customerAddress = customerAddress.trim();
        }
      } else if (docType === 'boleta' && customerDni.trim()) {
        saleData.customerDocType = 'DNI';
        saleData.customerDocNumber = customerDni.trim();
        saleData.customerDocument = customerDni.trim();
        saleData.customerName = customerName.trim() || 'Cliente Boleta';
      }

      // Cotizaciones se guardan en 'quotes' o 'sales'
      let recordRef: any;
      if (docType === 'cotizacion') {
        recordRef = await addDoc(collection(db, 'quotes'), saleData);
      } else {
        recordRef = await addDoc(collection(db, 'sales'), saleData);

        // Descontar stock sólo si no es cotización
        for (const item of safeItems) {
          try {
            if (item.id && !item.id.startsWith('quick_')) {
              const bKey = branchId || 'main';
              const productRef = doc(db, 'products', item.id);
              await updateDoc(productRef, {
                [`stock.${bKey}`]: increment(-item.quantity),
              });

              // Alerta de Stock Crítico
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
            console.warn('[Checkout] Stock decrement warning:', stockErr);
          }
        }

        // Movimiento de caja si es efectivo
        if (isCashOpen && activeMethod.kind === 'cash') {
          try {
            await addDoc(collection(db, 'cash_movements'), {
              accountId,
              branchId: branchId || 'main',
              type: 'sale',
              amount: safeTotal,
              saleId: recordRef.id,
              description: `Venta POS Mobile #${saleNumber}`,
              timestamp: now,
            });
          } catch (movErr) {
            console.warn('[Checkout] Cash movement warning:', movErr);
          }
        }
      }

      saleData.id = recordRef.id;
      setLastSaleDoc(saleData);

      // Limpiar inmediatamente el carrito para que la orden de fondo quede resuelta
      clearCart();

      try {
        if (navigator.vibrate) navigator.vibrate([60, 50, 60]);
      } catch {}

      setSaleComplete(true);
    } catch (err: any) {
      console.error('[Checkout] Sale error:', err);
      showAlert({
        type: 'error',
        title: 'Error de Cobro',
        message: 'Error registrando la venta: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center select-none animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-white rounded-t-3xl sm:rounded-3xl max-h-[94vh] flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-200"
        style={{
          paddingBottom: 'calc(max(env(safe-area-inset-bottom, 0px), 18px) + 0.5rem)',
        }}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-neutral-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Receipt className="w-5 h-5 text-emerald-600" />
            <h3 className="text-base font-black text-neutral-900">
              {saleComplete
                ? docType === 'cotizacion'
                  ? 'Cotización Creada'
                  : '¡Venta Realizada!'
                : 'Cobrar Venta'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500 hover:bg-neutral-200 active:scale-95 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {saleComplete ? (
            <div className="py-6 flex flex-col items-center justify-center text-center space-y-4 animate-in fade-in">
              <div className="w-16 h-16 rounded-3xl bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-inner">
                <CheckCircle2 className="w-10 h-10" />
              </div>
              <div className="space-y-1">
                <h4 className="text-2xl font-black text-neutral-900">
                  S/ {safeTotal.toFixed(2)}
                </h4>
                <p className="text-xs text-neutral-500 font-bold uppercase tracking-wider">
                  {docType === 'factura'
                    ? `Factura a ${customerBusinessName}`
                    : docType === 'boleta'
                    ? 'Boleta de Venta'
                    : docType === 'cotizacion'
                    ? 'Cotización de Venta'
                    : 'Nota de Venta'}
                </p>
                <p className="text-[11px] text-neutral-400 font-mono">
                  Ticket #{lastSaleDoc?.saleNumber || '000000'}
                </p>
              </div>

              {activeMethod.kind === 'cash' && change > 0 && docType !== 'cotizacion' && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl w-full max-w-xs">
                  <span className="text-[10px] font-bold text-emerald-800 uppercase block">
                    Vuelto a Entregar
                  </span>
                  <span className="text-xl font-black text-emerald-700">
                    S/ {change.toFixed(2)}
                  </span>
                </div>
              )}

              {/* Botón Imprimir Ticket Térmico */}
              <div className="w-full space-y-2 pt-2">
                <button
                  type="button"
                  onClick={handlePrintTicket}
                  className="w-full h-11 rounded-2xl bg-neutral-900 text-white font-bold text-xs flex items-center justify-center gap-2 active:scale-98 transition-all shadow-md"
                >
                  <Printer className="w-4 h-4 text-emerald-400" />
                  <span>
                    {ticketPrinted
                      ? 'Ticket Impreso (Volver a imprimir)'
                      : `Imprimir Ticket Térmico (${paperWidth}mm)`}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onSuccess();
                    onClose();
                  }}
                  className="w-full h-11 rounded-2xl text-white font-black text-xs shadow-md active:scale-98 transition-all"
                  style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                >
                  Nueva Venta
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Total Banner y Desglose de Productos */}
              <div className="bg-neutral-900 text-white rounded-2xl p-4 shadow-md space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider block">
                      Total a Pagar
                    </span>
                    <span className="text-2xl font-black text-emerald-400 tracking-tight">
                      S/ {safeTotal.toFixed(2)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowItemBreakdown(!showItemBreakdown)}
                    className="text-right flex items-center gap-1 text-xs text-neutral-300 hover:text-white"
                  >
                    <span>{safeItems.length} {safeItems.length === 1 ? 'ítem' : 'ítems'}</span>
                    {showItemBreakdown ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                </div>

                {/* Desglose colapsable de productos */}
                {showItemBreakdown && (
                  <div className="pt-2 border-t border-neutral-800 space-y-1.5 max-h-40 overflow-y-auto text-xs text-neutral-300 divide-y divide-neutral-800">
                    {safeItems.map((it) => (
                      <div key={it.id} className="pt-1.5 flex justify-between items-center">
                        <div className="truncate pr-2">
                          <span className="font-bold">{it?.quantity || 1}x</span>{' '}
                          <span>{it?.product?.name || 'Producto'}</span>
                        </div>
                        <span className="font-mono font-bold shrink-0 text-white">
                          S/ {((it?.price || 0) * (it?.quantity || 1)).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 1. Selector de Tipo de Comprobante */}
              <div className="space-y-2">
                <label className="text-xs font-black text-neutral-700 block">
                  Tipo de Comprobante
                </label>
                <div className="grid grid-cols-4 gap-1 p-1 bg-neutral-100 rounded-2xl text-center">
                  <button
                    type="button"
                    onClick={() => setDocType('nota_venta')}
                    className={`h-9 rounded-xl text-[11px] font-bold transition-all ${
                      docType === 'nota_venta'
                        ? 'bg-white text-neutral-900 shadow-xs'
                        : 'text-neutral-500 hover:text-neutral-800'
                    }`}
                  >
                    Nota
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocType('boleta')}
                    className={`h-9 rounded-xl text-[11px] font-bold transition-all ${
                      docType === 'boleta'
                        ? 'bg-white text-neutral-900 shadow-xs'
                        : 'text-neutral-500 hover:text-neutral-800'
                    }`}
                  >
                    Boleta
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocType('factura')}
                    className={`h-9 rounded-xl text-[11px] font-bold transition-all ${
                      docType === 'factura'
                        ? 'bg-white text-neutral-900 shadow-xs'
                        : 'text-neutral-500 hover:text-neutral-800'
                    }`}
                  >
                    Factura
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocType('cotizacion')}
                    className={`h-9 rounded-xl text-[11px] font-bold transition-all ${
                      docType === 'cotizacion'
                        ? 'bg-white text-neutral-900 shadow-xs'
                        : 'text-neutral-500 hover:text-neutral-800'
                    }`}
                  >
                    Cotización
                  </button>
                </div>

                {/* Campos para Factura */}
                {docType === 'factura' && (
                  <div className="p-3 bg-neutral-50 border border-neutral-200 rounded-2xl space-y-2.5 animate-in fade-in">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] font-bold text-neutral-700 flex items-center gap-1">
                          <Building className="w-3.5 h-3.5 text-neutral-400" />
                          <span>RUC del Cliente (Obligatorio)</span>
                        </label>
                        {customerRuc && (
                          <span
                            className={`text-[10px] font-bold ${
                              rucValid ? 'text-emerald-600' : 'text-rose-600'
                            }`}
                          >
                            {rucValid ? 'RUC Válido' : 'RUC Inválido'}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          maxLength={11}
                          value={customerRuc}
                          onChange={(e) => setCustomerRuc(e.target.value.replace(/\D/g, ''))}
                          placeholder="20601234567"
                          className={`flex-1 h-9 px-3 rounded-xl border text-xs font-mono font-bold focus:outline-none ${
                            customerRuc
                              ? rucValid
                                ? 'border-emerald-500 bg-white'
                                : 'border-rose-400 bg-rose-50/50'
                              : 'border-neutral-200 bg-white'
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => lookupDocument('ruc', customerRuc)}
                          disabled={isSearchingDocument || !rucValid}
                          className="px-3 h-9 rounded-xl bg-neutral-900 disabled:bg-neutral-300 text-white font-bold text-[11px] shrink-0 flex items-center gap-1 active:scale-95 transition-all shadow-xs"
                          title="Consultar datos en SUNAT"
                        >
                          {isSearchingDocument ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Search className="w-3.5 h-3.5" />
                          )}
                          <span>SUNAT</span>
                        </button>
                      </div>
                      {customerRuc && !rucValid && (
                        <p className="text-[10px] text-rose-600 mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          <span>11 dígitos (iniciando en 10, 15, 16, 17 o 20)</span>
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                        Razón Social / Empresa
                      </label>
                      <input
                        type="text"
                        value={customerBusinessName}
                        onChange={(e) => setCustomerBusinessName(e.target.value)}
                        placeholder="Ej. Comercializadora SAC"
                        className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-white text-xs font-bold text-neutral-800 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                        Dirección Fiscal (Opcional)
                      </label>
                      <input
                        type="text"
                        value={customerAddress}
                        onChange={(e) => setCustomerAddress(e.target.value)}
                        placeholder="Ej. Av. Principal 123, Lima"
                        className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-white text-xs text-neutral-800 focus:outline-none"
                      />
                    </div>

                    {docLookupError && (
                      <p className="text-[10px] text-amber-600 flex items-center gap-1 bg-amber-50 p-1.5 rounded-lg border border-amber-200">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        <span>{docLookupError}</span>
                      </p>
                    )}
                  </div>
                )}

                {/* Campos para Boleta */}
                {docType === 'boleta' && (
                  <div className="p-3 bg-neutral-50 border border-neutral-200 rounded-2xl space-y-2 animate-in fade-in">
                    <div>
                      <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                        DNI del Cliente (Opcional)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          maxLength={8}
                          value={customerDni}
                          onChange={(e) => setCustomerDni(e.target.value.replace(/\D/g, ''))}
                          placeholder="8 dígitos"
                          className="flex-1 h-9 px-3 rounded-xl border border-neutral-200 bg-white text-xs font-mono font-bold focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => lookupDocument('dni', customerDni)}
                          disabled={isSearchingDocument || customerDni.length !== 8}
                          className="px-3 h-9 rounded-xl bg-neutral-900 disabled:bg-neutral-300 text-white font-bold text-[11px] shrink-0 flex items-center gap-1 active:scale-95 transition-all shadow-xs"
                          title="Consultar datos en RENIEC"
                        >
                          {isSearchingDocument ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Search className="w-3.5 h-3.5" />
                          )}
                          <span>RENIEC</span>
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                        Nombre del Cliente
                      </label>
                      <input
                        type="text"
                        value={customerName}
                        onChange={(e) => setCustomerName(e.target.value)}
                        placeholder="Ej. Juan Pérez"
                        className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-white text-xs font-bold text-neutral-800 focus:outline-none"
                      />
                    </div>

                    {docLookupError && (
                      <p className="text-[10px] text-amber-600 flex items-center gap-1 bg-amber-50 p-1.5 rounded-lg border border-amber-200">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        <span>{docLookupError}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 2. Métodos de Pago Dinámicos */}
              <div className="space-y-2">
                <label className="text-xs font-black text-neutral-700 block">
                  Método de Pago
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {safeMethods.map((m) => {
                    const isSelected = selectedMethodId === m.id;
                    const Icon =
                      m.kind === 'cash'
                        ? Banknote
                        : m.kind === 'card'
                        ? CreditCard
                        : QrCode;

                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedMethodId(m.id)}
                        className={`p-2.5 rounded-2xl border text-center flex flex-col items-center gap-1 transition-all ${
                          isSelected
                            ? 'border-emerald-600 bg-emerald-50 text-emerald-950 font-black shadow-2xs'
                            : 'border-neutral-200 hover:bg-neutral-50 text-neutral-600 font-bold'
                        }`}
                      >
                        <Icon className={`w-5 h-5 ${isSelected ? 'text-emerald-600' : 'text-neutral-400'}`} />
                        <span className="text-[11px] truncate w-full">{m.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Detalle si es Efectivo */}
              {activeMethod.kind === 'cash' && (
                <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-3.5 space-y-3 animate-in fade-in">
                  <div>
                    <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                      Monto Recibido en Efectivo (S/)
                    </label>
                    <input
                      type="number"
                      step="0.10"
                      value={cashReceived}
                      onChange={(e) => setCashReceived(parseFloat(e.target.value) || 0)}
                      className="w-full h-11 px-3 rounded-xl border border-neutral-300 bg-white text-base font-black text-neutral-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>

                  {/* Billetes rápidos */}
                  <div className="flex gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setCashReceived(safeTotal)}
                      className="px-2.5 py-1 rounded-lg bg-white border border-neutral-200 text-[10px] font-bold text-neutral-700 active:scale-95"
                    >
                      Exacto
                    </button>
                    {quickCashOptions.map((amt) => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setCashReceived(amt)}
                        className="px-2.5 py-1 rounded-lg bg-white border border-neutral-200 text-[10px] font-bold text-neutral-700 active:scale-95"
                      >
                        S/ {amt}
                      </button>
                    ))}
                  </div>

                  {/* Vuelto */}
                  <div className="flex items-center justify-between pt-2 border-t border-neutral-200 text-xs">
                    <span className="font-bold text-neutral-600">Vuelto:</span>
                    <span
                      className={`font-black ${
                        change >= 0 && (cashReceived || 0) >= safeTotal
                          ? 'text-emerald-700 text-sm'
                          : 'text-rose-600'
                      }`}
                    >
                      {change >= 0 && (cashReceived || 0) >= safeTotal
                        ? `S/ ${change.toFixed(2)}`
                        : 'Monto insuficiente'}
                    </span>
                  </div>
                </div>
              )}

              {/* Detalle si es Pago Digital (QR Yape / Plin) */}
              {activeMethod.kind === 'digital' && (
                <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-4 text-center space-y-2.5 animate-in fade-in">
                  <div className="flex items-center justify-center gap-1.5 font-bold text-xs text-neutral-800">
                    <QrCode className="w-4 h-4 text-purple-600" />
                    <span>Cobro con {activeMethod.name}</span>
                  </div>

                  {digitalInfo?.qrUrl ? (
                    <div className="inline-block p-2 bg-white rounded-2xl border border-neutral-200 shadow-xs">
                      <img
                        src={digitalInfo.qrUrl}
                        alt="QR Pago"
                        className="w-36 h-36 object-contain rounded-xl"
                      />
                    </div>
                  ) : (
                    <div className="w-36 h-36 mx-auto bg-neutral-200/60 rounded-2xl flex flex-col items-center justify-center text-neutral-400 p-2">
                      <QrCode className="w-10 h-10 mb-1" />
                      <span className="text-[10px] text-center">Configura tu QR en Ajustes</span>
                    </div>
                  )}

                  <div className="text-xs space-y-0.5">
                    <p className="font-bold text-neutral-800">
                      Número: {digitalInfo?.phone || 'Sin número configurado'}
                    </p>
                    <p className="text-[11px] text-neutral-500">
                      Titular: {digitalInfo?.holderName || businessName}
                    </p>
                  </div>
                </div>
              )}

              {/* Botón Finalizar Cobro */}
              <div className="pt-2">
                <button
                  type="button"
                  disabled={!canSubmit}
                  onClick={handleFinishSale}
                  className={`w-full h-12 rounded-2xl text-white font-black text-sm flex items-center justify-center gap-2 shadow-lg active:scale-98 transition-all ${
                    canSubmit
                      ? 'shadow-emerald-900/20'
                      : 'bg-neutral-300 text-neutral-500 cursor-not-allowed shadow-none'
                  }`}
                  style={{
                    backgroundColor: canSubmit ? 'var(--brand-primary, #047857)' : undefined,
                  }}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Procesando...</span>
                    </>
                  ) : (
                    <span>
                      {docType === 'cotizacion'
                        ? `Guardar Cotización · S/ ${safeTotal.toFixed(2)}`
                        : `Finalizar Cobro · S/ ${safeTotal.toFixed(2)}`}
                    </span>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* MODAL DE ALERTAS ESTILIZADO */}
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

export const CheckoutModal: React.FC<CheckoutModalProps> = (props) => {
  if (!props.isOpen) return null;
  return (
    <CheckoutErrorBoundary onClose={props.onClose}>
      <CheckoutModalContent {...props} />
    </CheckoutErrorBoundary>
  );
};
