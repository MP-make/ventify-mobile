"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useMobilePrinter } from '../contexts/mobile-printer-context';
import { Sale } from '@/types/sale';
import { Customer } from '@/types/customer';
import { getActiveCashRegisterSession } from '@/services/cash-register/cash-query-service';
import { CashRegisterSession } from '@/services/cash-register/types';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  doc,
  updateDoc,
  increment,
  addDoc,
} from 'firebase/firestore';
import {
  History,
  BookOpen,
  Printer,
  Share2,
  DollarSign,
  Search,
  Check,
  X,
  Loader2,
  Receipt,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export default function MobileHistoryPage() {
  const { user, userDoc } = useAuth();
  const { printReceipt } = useMobilePrinter();
  const { toast } = useToast();

  const accountId = userDoc?.accountId;
  const branchId = userDoc?.branchId || 'main';

  // Sub-pestañas: 'cuadre' | 'fiados'
  const [activeTab, setActiveTab] = useState<'cuadre' | 'fiados'>('cuadre');

  // Sesión de caja activa
  const [activeSession, setActiveSession] = useState<CashRegisterSession | null>(null);

  // Ventas
  const [sales, setSales] = useState<Sale[]>([]);
  const [loadingSales, setLoadingSales] = useState(true);

  // Fiados / Deudores
  const [debtors, setDebtors] = useState<Customer[]>([]);
  const [debtorSearch, setDebtorSearch] = useState('');
  const [loadingDebtors, setLoadingDebtors] = useState(true);

  // Modal de Abono
  const [payingDebtor, setPayingDebtor] = useState<Customer | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [processingAbono, setProcessingAbono] = useState(false);

  // Cargar sesión activa
  useEffect(() => {
    if (!accountId) return;
    const unsub = getActiveCashRegisterSession(
      branchId,
      accountId,
      (sess) => setActiveSession(sess),
      user?.uid
    );
    return () => {
      if (unsub) unsub();
    };
  }, [accountId, branchId, user?.uid]);

  // Cargar ventas recientes
  useEffect(() => {
    if (!accountId) return;
    const fetchSales = async () => {
      try {
        setLoadingSales(true);
        const q = query(
          collection(db, 'sales'),
          where('accountId', '==', accountId),
          where('branchId', '==', branchId),
          orderBy('date', 'desc'),
          limit(40)
        );
        const snap = await getDocs(q);
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Sale));
        setSales(list);
      } catch (err) {
        console.warn('Error fetching sales:', err);
      } finally {
        setLoadingSales(false);
      }
    };
    fetchSales();
  }, [accountId, branchId]);

  // Cargar deudores
  useEffect(() => {
    if (!accountId) return;
    const fetchDebtors = async () => {
      try {
        setLoadingDebtors(true);
        const q = query(
          collection(db, 'customers'),
          where('accountId', '==', accountId),
          where('currentDebt', '>', 0)
        );
        const snap = await getDocs(q);
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer));
        setDebtors(list);
      } catch (err) {
        console.warn('Error fetching debtors:', err);
      } finally {
        setLoadingDebtors(false);
      }
    };
    fetchDebtors();
  }, [accountId]);

  // Métricas del Cuadre
  const sessionMetrics = useMemo(() => {
    const cash = activeSession?.cashSales || 0;
    const card = activeSession?.cardSales || 0;
    const digital = activeSession?.digitalSales || 0;
    const totalSales = activeSession?.totalSales || 0;
    const initialCash = activeSession?.initialAmount || 0;

    // Métricas calculadas si no hay sesión o complementarias
    const totalPhysicalCash = initialCash + cash; // Filosofía Ventify: Total en Caja

    const totalMethods = cash + card + digital || 1;
    const cashPct = Math.round((cash / totalMethods) * 100);
    const cardPct = Math.round((card / totalMethods) * 100);
    const digitalPct = Math.round((digital / totalMethods) * 100);

    return {
      isOpen: activeSession?.status === 'open',
      totalSales,
      totalPhysicalCash,
      txCount: activeSession?.transactionCount || sales.length,
      cash,
      card,
      digital,
      cashPct,
      cardPct,
      digitalPct,
    };
  }, [activeSession, sales.length]);

  // Métricas de Deudores
  const debtMetrics = useMemo(() => {
    const totalDebt = debtors.reduce((sum, d) => sum + (d.currentDebt || 0), 0);
    return {
      totalDebt,
      count: debtors.length,
    };
  }, [debtors]);

  // Reimprimir ticket térmico
  const handleReprint = async (sale: Sale) => {
    try {
      await printReceipt({
        businessName: (userDoc?.businessName as string) || 'VENTIFY',
        documentTitle: 'COPIA DE TICKET',
        documentNumber: String(sale.saleNumber || sale.id.slice(-6)),
        date: new Date(sale.date).toLocaleDateString('es-PE'),
        time: new Date(sale.date).toLocaleTimeString('es-PE'),
        paymentMethod: sale.paymentMethod || 'Efectivo',
        customerName: sale.customerName,
        items: (sale.items || []).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          total: i.price * i.quantity,
        })),
        subtotal: sale.total,
        total: sale.total,
        cashReceived: sale.cashReceived,
        changeGiven: sale.changeGiven,
        footerNote: 'Reimpresión de Comprobante',
      });
      toast({ title: 'Ticket enviado a la impresora' });
    } catch {
      toast({ title: 'Error al imprimir comprobante', variant: 'destructive' });
    }
  };

  // Compartir ticket por WhatsApp
  const handleShareWhatsApp = (sale: Sale) => {
    const phone = sale.customerPhone?.replace(/\D/g, '') || '';
    const text = encodeURIComponent(
      `¡Hola! Aquí tienes el detalle de tu compra en *${userDoc?.businessName || 'Ventify'}*:\n` +
      `Ticket: #${sale.saleNumber || sale.id.slice(-6)}\n` +
      `Total: S/ ${sale.total.toFixed(2)}\n` +
      `Método: ${sale.paymentMethod || 'Efectivo'}\n` +
      `¡Gracias por tu preferencia!`
    );
    window.open(`https://wa.me/${phone ? '51' + phone : ''}?text=${text}`, '_blank');
  };

  // Registrar Abono de Fiado
  const handleRegisterAbono = async () => {
    if (!payingDebtor || !paymentAmount || !accountId) return;
    const amount = parseFloat(paymentAmount) || 0;
    if (amount <= 0) return;

    try {
      setProcessingAbono(true);
      const customerRef = doc(db, 'customers', payingDebtor.id);

      // Descontar deuda actual
      await updateDoc(customerRef, {
        currentDebt: increment(-amount),
      });

      // Guardar historial en credit_history
      await addDoc(collection(db, 'credit_history'), {
        customerId: payingDebtor.id,
        customerName: payingDebtor.name,
        accountId,
        amount,
        type: 'payment',
        createdAt: Date.now(),
        createdBy: user?.uid,
        createdByName: userDoc?.name || user?.email,
      });

      // Actualizar estado local
      setDebtors((prev) =>
        prev
          .map((d) => (d.id === payingDebtor.id ? { ...d, currentDebt: Math.max(0, (d.currentDebt || 0) - amount) } : d))
          .filter((d) => (d.currentDebt || 0) > 0)
      );

      // Opción de comprobante por WhatsApp
      const remaining = Math.max(0, (payingDebtor.currentDebt || 0) - amount);
      const text = encodeURIComponent(
        `*COMPROBANTE DE ABONO - ${userDoc?.businessName || 'Ventify'}*\n` +
        `Estimado(a) ${payingDebtor.name}:\n` +
        `Hemos registrado su abono de *S/ ${amount.toFixed(2)}*.\n` +
        `Saldo restante por pagar: *S/ ${remaining.toFixed(2)}*.\n` +
        `¡Muchas gracias!`
      );

      toast({
        title: "Abono registrado con éxito",
        description: `Se descontaron S/ ${amount.toFixed(2)} de la deuda.`,
      });

      const phone = payingDebtor.phone?.replace(/\D/g, '');
      if (phone) {
        window.open(`https://wa.me/51${phone}?text=${text}`, '_blank');
      }

      setPayingDebtor(null);
      setPaymentAmount('');
    } catch (err: any) {
      toast({
        title: "Error al registrar abono",
        description: err.message || "No se pudo actualizar la deuda.",
        variant: "destructive",
      });
    } finally {
      setProcessingAbono(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full bg-white select-none">
      {/* Selector de Pestañas Superiores */}
      <div className="p-3 bg-white border-b border-neutral-100 flex gap-2 sticky top-12 z-30">
        <button
          onClick={() => setActiveTab('cuadre')}
          className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
            activeTab === 'cuadre'
              ? 'bg-neutral-900 text-white shadow-xs'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          Cuadre del Día
        </button>
        <button
          onClick={() => setActiveTab('fiados')}
          className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
            activeTab === 'fiados'
              ? 'bg-neutral-900 text-white shadow-xs'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          Cuaderno de Fiados ({debtMetrics.count})
        </button>
      </div>

      {activeTab === 'cuadre' ? (
        /* PESTAÑA A: CUADRE DEL DÍA */
        <div className="p-3 space-y-3 flex-1">
          {/* Encabezado Resumen con Filosofía Ventify */}
          <div className="bg-neutral-900 text-white rounded-2xl p-4 shadow-sm">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${
                    sessionMetrics.isOpen ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                  }`}
                />
                <span className="text-[11px] font-bold text-neutral-300">
                  {sessionMetrics.isOpen ? '🟢 CAJA ABIERTA' : '🔴 CAJA CERRADA'}
                </span>
              </div>
              <span className="text-[11px] text-neutral-400">
                {sessionMetrics.txCount} transacciones
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-3">
              <div>
                <span className="text-[10px] text-neutral-400 uppercase font-semibold block">
                  Ventas Totales
                </span>
                <span className="text-xl font-black text-emerald-400">
                  S/ {sessionMetrics.totalSales.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-neutral-400 uppercase font-semibold block">
                  Total en Caja (Efectivo)
                </span>
                <span className="text-xl font-black text-white">
                  S/ {sessionMetrics.totalPhysicalCash.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Barra visual de Desglose por Método de Pago */}
            <div className="mt-3 pt-3 border-t border-neutral-800">
              <div className="flex justify-between text-[10px] text-neutral-400 mb-1 font-semibold">
                <span>Efectivo ({sessionMetrics.cashPct}%)</span>
                <span>Tarjeta ({sessionMetrics.cardPct}%)</span>
                <span>Digital ({sessionMetrics.digitalPct}%)</span>
              </div>
              <div className="w-full h-2 rounded-full bg-neutral-800 flex overflow-hidden">
                <div style={{ width: `${sessionMetrics.cashPct}%` }} className="bg-emerald-500" />
                <div style={{ width: `${sessionMetrics.cardPct}%` }} className="bg-indigo-500" />
                <div style={{ width: `${sessionMetrics.digitalPct}%` }} className="bg-purple-500" />
              </div>
            </div>
          </div>

          {/* Lista de Ventas del Turno */}
          <div className="space-y-2">
            <h3 className="text-xs font-bold text-neutral-800 tracking-tight">
              Tickets Emitidos ({sales.length})
            </h3>

            {loadingSales ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 bg-neutral-100 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : sales.length === 0 ? (
              <div className="py-12 text-center text-neutral-400 text-xs">
                No hay ventas registradas en este turno
              </div>
            ) : (
              sales.map((sale) => (
                <div
                  key={sale.id}
                  className="bg-white border border-neutral-200/80 rounded-2xl p-3 flex items-center justify-between shadow-xs"
                >
                  <div>
                    <div className="flex items-center gap-1.5">
                      <Receipt className="w-3.5 h-3.5 text-neutral-400" />
                      <span className="text-xs font-bold text-neutral-900">
                        Ticket #{sale.saleNumber || sale.id.slice(-6)}
                      </span>
                    </div>
                    <p className="text-[10px] text-neutral-400 mt-0.5">
                      {new Date(sale.date).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })} •{' '}
                      <span className="font-semibold text-neutral-600">{sale.paymentMethod || 'Efectivo'}</span>
                    </p>
                    <span className="text-xs font-extrabold text-neutral-900 block mt-1">
                      S/ {sale.total.toFixed(2)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleReprint(sale)}
                      className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-neutral-700 active:scale-95"
                      title="Reimprimir comprobante"
                    >
                      <Printer className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleShareWhatsApp(sale)}
                      className="w-8 h-8 rounded-xl bg-emerald-50 hover:bg-emerald-100 flex items-center justify-center text-emerald-700 active:scale-95"
                      title="Compartir por WhatsApp"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* PESTAÑA B: CUADERNO DE FIADOS */
        <div className="p-3 space-y-3 flex-1">
          {/* Métricas de Deudores */}
          <div className="bg-amber-500 text-white rounded-2xl p-4 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold tracking-wider text-amber-100 block">
                Total por Cobrar
              </span>
              <span className="text-2xl font-black text-white">
                S/ {debtMetrics.totalDebt.toFixed(2)}
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs font-bold bg-white/20 px-2.5 py-1 rounded-full">
                {debtMetrics.count} clientes activos
              </span>
            </div>
          </div>

          {/* Buscador de Deudores */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
            <Input
              value={debtorSearch}
              onChange={(e) => setDebtorSearch(e.target.value)}
              placeholder="Buscar deudor por nombre o teléfono..."
              className="pl-9 h-10 rounded-xl bg-neutral-50 border-neutral-200 text-xs"
            />
          </div>

          {/* Lista de Clientes con Deuda */}
          <div className="space-y-2">
            {loadingDebtors ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="h-20 bg-neutral-100 rounded-xl animate-pulse" />
                ))}
              </div>
            ) : debtors.length === 0 ? (
              <div className="py-12 text-center text-neutral-400 text-xs">
                ¡Excelente! No hay clientes con deudas pendientes
              </div>
            ) : (
              debtors
                .filter(
                  (d) =>
                    d.name.toLowerCase().includes(debtorSearch.toLowerCase()) ||
                    (d.phone && d.phone.includes(debtorSearch))
                )
                .map((debtor) => (
                  <div
                    key={debtor.id}
                    className="bg-white border border-neutral-200/80 rounded-2xl p-3.5 flex items-center justify-between shadow-xs"
                  >
                    <div>
                      <h4 className="text-xs font-bold text-neutral-900">{debtor.name}</h4>
                      <p className="text-[10px] text-neutral-400 mt-0.5">
                        Tel: {debtor.phone || 'Sin número'}
                      </p>
                      <div className="text-xs font-extrabold text-rose-600 mt-1">
                        Saldo Pendiente: S/ {(debtor.currentDebt || 0).toFixed(2)}
                      </div>
                    </div>

                    <Button
                      size="sm"
                      onClick={() => {
                        setPayingDebtor(debtor);
                        setPaymentAmount(String(debtor.currentDebt || ''));
                      }}
                      className="h-9 px-3 rounded-xl text-xs font-bold text-white shadow-xs active:scale-95"
                      style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                    >
                      <DollarSign className="w-3.5 h-3.5 mr-1" />
                      Registrar Abono
                    </Button>
                  </div>
                ))
            )}
          </div>
        </div>
      )}

      {/* Modal Registrar Abono */}
      {payingDebtor && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xs bg-white rounded-3xl p-5 shadow-2xl space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <div>
                <h3 className="text-sm font-bold text-neutral-800">Registrar Abono</h3>
                <p className="text-[11px] text-neutral-500">{payingDebtor.name}</p>
              </div>
              <button
                onClick={() => setPayingDebtor(null)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <span className="text-[11px] font-semibold text-neutral-500 block">
                Deuda total: S/ {(payingDebtor.currentDebt || 0).toFixed(2)}
              </span>
              <label className="text-xs font-bold text-neutral-700 block mt-2 mb-1">
                Monto que abona hoy:
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-neutral-500">S/</span>
                <Input
                  type="number"
                  step="0.10"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  className="h-10 text-sm font-bold rounded-xl"
                  placeholder="0.00"
                  autoFocus
                />
              </div>
            </div>

            <Button
              onClick={handleRegisterAbono}
              disabled={processingAbono || !paymentAmount || parseFloat(paymentAmount) <= 0}
              className="w-full h-11 text-xs font-bold rounded-xl text-white shadow-md mt-2"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              {processingAbono ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Check className="w-4 h-4 mr-1" />
              )}
              Confirmar Abono y Enviar Comprobante
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
