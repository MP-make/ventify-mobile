import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import {
  History,
  Receipt,
  Search,
  X,
  Store,
  User,
  Printer,
  ChevronRight,
  FileText,
} from 'lucide-react';
import { EscPosBuilder } from '@/lib/printing/escpos-builder';
import { printThermalRaw, isNativePrinterAvailable } from '../services/thermal-printer';
import { AlertModal } from '../components/AlertModal';

export const parseDateFromSale = (sale: any): Date | null => {
  const raw = sale.date ?? sale.createdAt ?? sale.timestamp ?? sale.time;
  if (!raw) return null;
  if (typeof raw?.toDate === 'function') return raw.toDate();
  if (typeof raw?.seconds === 'number') return new Date(raw.seconds * 1000);
  if (typeof raw === 'number') {
    return new Date(raw < 10000000000 ? raw * 1000 : raw);
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
};

export const parseTotalFromSale = (sale: any): number => {
  const raw = sale.total ?? sale.totalAmount ?? sale.actualTotal ?? sale.amount ?? sale.subtotal;
  const num = Number(raw);
  return isNaN(num) ? 0 : num;
};

export const formatPaymentLabel = (sale: any): { label: string; isCash: boolean } => {
  const m = String(sale.paymentMethod || sale.paymentCategory || sale.paymentMethodId || 'cash').toLowerCase();
  if (m.includes('efectivo') || m.includes('cash')) {
    return { label: 'Efectivo', isCash: true };
  }
  if (m.includes('tarjeta') || m.includes('card') || m.includes('pos')) {
    return { label: 'Tarjeta', isCash: false };
  }
  if (m.includes('yape')) {
    return { label: 'Yape', isCash: false };
  }
  if (m.includes('plin')) {
    return { label: 'Plin', isCash: false };
  }
  if (m.includes('mixto') || m.includes('mixed')) {
    return { label: 'Mixto', isCash: false };
  }
  return { label: sale.paymentMethod || 'Digital', isCash: false };
};

export const getDocumentBadge = (sale: any): { label: string; className: string } => {
  const type = String(sale.documentType || (sale.isQuote ? 'cotizacion' : 'nota_venta')).toLowerCase();
  if (type.includes('factura')) {
    return { label: 'FACTURA', className: 'bg-purple-100 text-purple-800 border-purple-200' };
  }
  if (type.includes('boleta')) {
    return { label: 'BOLETA', className: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
  }
  if (type.includes('cotiza') || sale.isQuote) {
    return { label: 'COTIZACIÓN', className: 'bg-amber-100 text-amber-800 border-amber-200' };
  }
  return { label: 'NOTA DE VENTA', className: 'bg-neutral-100 text-neutral-700 border-neutral-200' };
};

export const HistoryView: React.FC = () => {
  const { accountId } = useAuth();
  const { branches, businessName } = useSettings();
  const [sales, setSales] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSale, setSelectedSale] = useState<any | null>(null);

  // Filtros
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState<string>('all');

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

  useEffect(() => {
    if (!accountId) return;

    setLoading(true);
    const q = query(
      collection(db, 'sales'),
      where('accountId', '==', accountId)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: any[] = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));

        // Ordenar descendente por fecha
        list.sort((a, b) => {
          const dateA = parseDateFromSale(a)?.getTime() || 0;
          const dateB = parseDateFromSale(b)?.getTime() || 0;
          return dateB - dateA;
        });

        setSales(list);
        setLoading(false);
      },
      (err) => {
        console.error('[History] Error loading sales:', err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [accountId]);

  // Métricas del día
  const todayStats = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    let total = 0;
    let cashTotal = 0;
    let digitalTotal = 0;
    let count = 0;

    sales.forEach((s) => {
      const d = parseDateFromSale(s);
      const time = d ? d.getTime() : 0;
      if (time >= startMs) {
        count++;
        const amt = parseTotalFromSale(s);
        total += amt;
        const { isCash } = formatPaymentLabel(s);
        if (isCash) {
          cashTotal += amt;
        } else {
          digitalTotal += amt;
        }
      }
    });

    return { total, cashTotal, digitalTotal, count };
  }, [sales]);

  // Ventas filtradas por sucursal y buscador
  const filteredSales = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sales.filter((s) => {
      // 1. Filtro de Sede / Sucursal
      if (selectedBranchId !== 'all') {
        if (s.branchId && s.branchId !== selectedBranchId) {
          return false;
        }
      }

      // 2. Filtro de Búsqueda
      if (!q) return true;

      const ticketMatch = (s.saleNumber ? String(s.saleNumber) : s.id).toLowerCase().includes(q);
      const clientName = (s.customerName || s.customerBusinessName || '').toLowerCase();
      const clientMatch = clientName.includes(q);
      const docMatch = (s.customerDocNumber || s.customerDocument || '').toLowerCase().includes(q);
      const productMatch = Array.isArray(s.items) && s.items.some((it: any) =>
        (it?.name || it?.product?.name || '').toLowerCase().includes(q)
      );

      return ticketMatch || clientMatch || docMatch || productMatch;
    });
  }, [sales, searchQuery, selectedBranchId]);

  // Helper para resolver el nombre de sucursal real
  const getBranchName = (sale: any): string => {
    if (sale.branchId && branches.length > 0) {
      const found = branches.find((b) => b.id === sale.branchId);
      if (found?.name) return found.name;
    }
    return sale.branchName || 'Tienda Principal';
  };

  // Reimpresión de ticket
  const handleReprint = async (sale: any) => {
    try {
      const paperWidth = (localStorage.getItem('ventify_printer_paper_width') === '80' ? 80 : 58) as 58 | 80;
      const builder = new EscPosBuilder({ paperWidth });
      const d = parseDateFromSale(sale);
      const total = parseTotalFromSale(sale);
      const { label, isCash } = formatPaymentLabel(sale);
      const branchName = getBranchName(sale);
      const clientName = sale.customerName || sale.customerBusinessName || 'Cliente Varios';
      const saleNumber = sale.saleNumber ? `#${sale.saleNumber}` : `#${sale.id.slice(-6).toUpperCase()}`;

      builder
        .init()
        .align('center')
        .bold(true)
        .line(businessName || 'VENTIFY POS')
        .bold(false)
        .line(branchName)
        .feed(1)
        .line(`COPIA - ${saleNumber}`)
        .line(d ? d.toLocaleString('es-PE') : '')
        .feed(1);

      builder.align('left');
      builder.line(`Cliente: ${clientName}`);
      if (sale.customerDocNumber) {
        builder.line(`Doc: ${sale.customerDocNumber}`);
      }
      builder.line('--------------------------------');

      (sale.items || []).forEach((item: any) => {
        const qty = item.quantity || 1;
        const price = Number(item.price || item.unitPrice || 0);
        const sub = qty * price;
        builder.line(`${qty}x ${item.name || 'Prod'}`);
        builder.align('right').line(`S/ ${sub.toFixed(2)}`).align('left');
      });

      builder.line('--------------------------------');
      builder.align('right').bold(true).line(`TOTAL: S/ ${total.toFixed(2)}`).bold(false);
      builder.line(`Pago: ${label}`);
      builder.feed(2).cut();

      const bytes = builder.build();
      const printerAddress = localStorage.getItem('ventify_bt_printer_address');

      if (printerAddress && isNativePrinterAvailable()) {
        try {
          await printThermalRaw(printerAddress, bytes);
          showAlert({
            type: 'success',
            title: 'Copia Impresa',
            message: 'Copia de comprobante enviada con éxito a la ticketera.',
          });
        } catch (printErr: any) {
          showAlert({
            type: 'error',
            title: 'Error de Impresora',
            message: 'No se pudo imprimir la copia: ' + (printErr.message || 'Error de conexión'),
          });
        }
      } else {
        showAlert({
          type: 'info',
          title: 'Ticket Generado',
          message: `Copia de ticket generada correctamente (${bytes.length} bytes ESC/POS, formato ${paperWidth}mm).${
            !printerAddress ? '\n\nConfigura tu ticketera en Ajustes para imprimir físicamente.' : ''
          }`,
        });
      }
    } catch (err: any) {
      showAlert({
        type: 'error',
        title: 'Error al Generar Ticket',
        message: err.message || 'Error desconocido',
      });
    }
  };

  return (
    <div className="flex flex-col min-h-full pb-20 select-none">
      {/* 1. Resumen de Ventas Hoy */}
      <div className="p-3 bg-neutral-900 text-white shadow-xs">
        <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
          <div className="flex items-center gap-1.5 text-xs font-bold text-neutral-300">
            <History className="w-4 h-4 text-emerald-400" />
            <span>Ventas del Turno (Hoy)</span>
          </div>
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300">
            {todayStats.count} ventas
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-2.5 text-center">
          <div className="bg-neutral-800/90 p-2 rounded-2xl">
            <span className="text-[10px] text-neutral-400 block font-medium">Total Ventas</span>
            <span className="text-sm font-black text-emerald-400">
              S/ {todayStats.total.toFixed(2)}
            </span>
          </div>
          <div className="bg-neutral-800/90 p-2 rounded-2xl">
            <span className="text-[10px] text-neutral-400 block font-medium">Efectivo</span>
            <span className="text-sm font-black text-white">
              S/ {todayStats.cashTotal.toFixed(2)}
            </span>
          </div>
          <div className="bg-neutral-800/90 p-2 rounded-2xl">
            <span className="text-[10px] text-neutral-400 block font-medium">Digital / Tarjeta</span>
            <span className="text-sm font-black text-white">
              S/ {todayStats.digitalTotal.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Buscador y Filtro de Sedes Sticky */}
      <div className="p-3 bg-white border-b border-neutral-100 sticky top-0 z-30 space-y-2 shadow-2xs">
        {/* Barra de búsqueda */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por ticket, cliente, DNI o producto..."
            className="w-full h-10 pl-9 pr-9 rounded-xl bg-neutral-100 border border-neutral-200 text-xs text-neutral-800 placeholder:text-neutral-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-2.5 text-neutral-400 hover:text-neutral-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Selector de Sedes (Pills desplazables horizontalmente) */}
        {branches.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            <button
              type="button"
              onClick={() => setSelectedBranchId('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                selectedBranchId === 'all'
                  ? 'bg-neutral-900 text-white shadow-xs'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              Todas las sedes
            </button>
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedBranchId(b.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap flex items-center gap-1 transition-all ${
                  selectedBranchId === b.id
                    ? 'bg-neutral-900 text-white shadow-xs'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
              >
                <Store className="w-3 h-3 opacity-70" />
                <span>{b.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 3. Lista de Ventas con Datos Completos */}
      <div className="p-3 divide-y divide-neutral-100 flex-1">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-neutral-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : filteredSales.length === 0 ? (
          <div className="py-20 text-center text-neutral-400">
            <Receipt className="w-10 h-10 mx-auto mb-2 opacity-40 text-neutral-500" />
            <p className="text-xs font-bold text-neutral-600">
              {searchQuery || selectedBranchId !== 'all'
                ? 'No se encontraron ventas con los filtros aplicados'
                : 'No hay ventas registradas aún'}
            </p>
          </div>
        ) : (
          filteredSales.map((sale) => {
            const d = parseDateFromSale(sale);
            const timeStr = d
              ? d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
              : '--:--';
            const dateStr = d
              ? d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit' })
              : '';

            const total = parseTotalFromSale(sale);
            const { label, isCash } = formatPaymentLabel(sale);
            const saleNumber = sale.saleNumber ? `#${sale.saleNumber}` : `#${sale.id.slice(-6).toUpperCase()}`;
            const branchName = getBranchName(sale);
            const clientName = sale.customerName || sale.customerBusinessName || 'Cliente Varios';
            const docBadge = getDocumentBadge(sale);

            return (
              <div
                key={sale.id}
                onClick={() => setSelectedSale(sale)}
                className="py-3 flex items-center justify-between gap-3 active:bg-neutral-50 cursor-pointer transition-colors"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-black text-neutral-900">
                      {saleNumber}
                    </span>
                    <span
                      className={`text-[9px] font-black px-1.5 py-0.5 rounded-md border ${docBadge.className}`}
                    >
                      {docBadge.label}
                    </span>
                    <span className="text-[10px] text-neutral-400">
                      • {dateStr} {timeStr}
                    </span>
                  </div>

                  {/* Cliente y Sucursal real */}
                  <div className="flex items-center gap-1.5 text-[11px] text-neutral-600 truncate">
                    <span className="font-semibold text-neutral-800 truncate">
                      {clientName}
                    </span>
                    <span className="text-neutral-300">•</span>
                    <span className="text-neutral-500 truncate flex items-center gap-0.5">
                      <Store className="w-2.5 h-2.5 inline" />
                      <span>{branchName}</span>
                    </span>
                  </div>

                  <p className="text-[10px] text-neutral-400">
                    {sale.items?.length || 0} {sale.items?.length === 1 ? 'producto' : 'productos'}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-sm font-black text-neutral-900">
                    S/ {total.toFixed(2)}
                  </span>
                  <span
                    className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                      isCash
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {label}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal Detalle de Venta */}
      {selectedSale && (() => {
        const d = parseDateFromSale(selectedSale);
        const total = parseTotalFromSale(selectedSale);
        const { label } = formatPaymentLabel(selectedSale);
        const saleNumber = selectedSale.saleNumber
          ? `#${selectedSale.saleNumber}`
          : `#${selectedSale.id.slice(-6).toUpperCase()}`;
        const branchName = getBranchName(selectedSale);
        const clientName = selectedSale.customerName || selectedSale.customerBusinessName || 'Cliente Varios';
        const docBadge = getDocumentBadge(selectedSale);

        return (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-2xs flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-neutral-400 font-bold block">COMPROBANTE</span>
                    <span className={`text-[9px] font-black px-1.5 py-0.2 rounded border ${docBadge.className}`}>
                      {docBadge.label}
                    </span>
                  </div>
                  <h4 className="text-sm font-black text-neutral-900">{saleNumber}</h4>
                </div>
                <button
                  onClick={() => setSelectedSale(null)}
                  className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="text-xs space-y-1.5 text-neutral-600 bg-neutral-50 p-3 rounded-2xl border border-neutral-100">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Cliente:</span>
                  <span className="font-bold text-neutral-800">{clientName}</span>
                </div>
                {selectedSale.customerDocNumber && (
                  <div className="flex justify-between">
                    <span className="text-neutral-500">Documento:</span>
                    <span className="font-mono font-bold text-neutral-800">
                      {selectedSale.customerDocType || 'DOC'}: {selectedSale.customerDocNumber}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-neutral-500">Sucursal:</span>
                  <span className="font-bold text-neutral-800">{branchName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Fecha y Hora:</span>
                  <span className="font-medium text-neutral-700">
                    {d ? d.toLocaleString('es-PE') : 'No especificada'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Método de pago:</span>
                  <span className="font-bold text-neutral-800 uppercase">{label}</span>
                </div>
              </div>

              {/* Desglose de ítems */}
              <div className="divide-y divide-neutral-100 max-h-48 overflow-y-auto">
                {(selectedSale.items || []).map((item: any, i: number) => {
                  const itemPrice = Number(item.price || item.unitPrice || 0);
                  const itemQty = Number(item.quantity || 1);
                  const itemTotal = Number(item.total || itemPrice * itemQty);

                  return (
                    <div key={i} className="py-2 flex justify-between text-xs">
                      <div className="min-w-0 flex-1 pr-2">
                        <span className="font-bold text-neutral-900 block truncate">
                          {item.name}
                        </span>
                        <span className="text-[10px] text-neutral-400">
                          {itemQty} x S/ {itemPrice.toFixed(2)}
                        </span>
                      </div>
                      <span className="font-black text-neutral-900 shrink-0">
                        S/ {itemTotal.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="pt-2 border-t border-neutral-100 flex justify-between items-center">
                <span className="text-xs font-bold text-neutral-500">Total Pagado:</span>
                <span className="text-lg font-black text-emerald-600">
                  S/ {total.toFixed(2)}
                </span>
              </div>

              {/* Botón reimprimir ticket */}
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleReprint(selectedSale)}
                  className="w-full h-10 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Printer className="w-4 h-4 text-neutral-600" />
                  <span>Reimprimir Ticket</span>
                </button>

                <button
                  onClick={() => setSelectedSale(null)}
                  className="w-full h-11 rounded-xl bg-neutral-900 text-white font-bold text-xs active:scale-98 transition-all"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

export default HistoryView;

