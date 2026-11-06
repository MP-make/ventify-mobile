"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { useMobileCart } from '../contexts/mobile-cart-context';
import { useMobilePrinter } from '../contexts/mobile-printer-context';
import { saveSale } from '@/services/sales/sale-creation-service';
import { Customer } from '@/types/customer';
import { PaymentSplit, Sale } from '@/types/sale';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs, addDoc } from 'firebase/firestore';
import {
  ArrowLeft,
  Banknote,
  QrCode,
  CreditCard,
  UserCheck,
  CheckCircle2,
  Loader2,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

export default function MobileCheckoutPage() {
  const router = useRouter();
  const { userDoc } = useAuth();
  const { items, totalAmount, clearCart } = useMobileCart();
  const { printReceipt } = useMobilePrinter();
  const { toast } = useToast();

  const accountId = userDoc?.accountId;
  const branchId = userDoc?.branchId || 'main';

  // Si el carrito está vacío, redirigir a venta
  useEffect(() => {
    if (items.length === 0) {
      router.replace('/mobile/pos');
    }
  }, [items.length, router]);

  // Estados de cobro
  const [notes, setNotes] = useState('');
  const [isMixedPayment, setIsMixedPayment] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<'cash' | 'yape' | 'plin' | 'card' | 'credit'>('cash');
  
  // Efectivo
  const [cashReceived, setCashReceived] = useState<number>(totalAmount);
  
  // Clientes para crédito/fiado
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [showNewCustomerModal, setShowNewCustomerModal] = useState(false);

  // Pagos Mixtos: asignaciones por método
  const [mixedPayments, setMixedPayments] = useState<{
    cash: number;
    yape: number;
    plin: number;
    card: number;
    credit: number;
  }>({
    cash: 0,
    yape: 0,
    plin: 0,
    card: 0,
    credit: 0,
  });

  const [loading, setLoading] = useState(false);

  // Cargar clientes para fiado
  useEffect(() => {
    if (!accountId) return;
    const fetchCustomers = async () => {
      try {
        const q = query(collection(db, 'customers'), where('accountId', '==', accountId));
        const snap = await getDocs(q);
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer));
        setCustomers(list);
      } catch (err) {
        console.warn('Error fetching customers:', err);
      }
    };
    fetchCustomers();
  }, [accountId]);

  // Cálculo del total asignado en pagos mixtos
  const totalAssignedMixed = useMemo(() => {
    const sum =
      (Number(mixedPayments.cash) || 0) +
      (Number(mixedPayments.yape) || 0) +
      (Number(mixedPayments.plin) || 0) +
      (Number(mixedPayments.card) || 0) +
      (Number(mixedPayments.credit) || 0);
    return Math.round(sum * 100) / 100;
  }, [mixedPayments]);

  const mixedDifference = useMemo(() => {
    return Math.round((totalAmount - totalAssignedMixed) * 100) / 100;
  }, [totalAmount, totalAssignedMixed]);

  // Vuelto en efectivo
  const changeGiven = useMemo(() => {
    if (isMixedPayment) {
      const cashPart = Number(mixedPayments.cash) || 0;
      return cashReceived > cashPart ? Math.round((cashReceived - cashPart) * 100) / 100 : 0;
    }
    return cashReceived > totalAmount ? Math.round((cashReceived - totalAmount) * 100) / 100 : 0;
  }, [cashReceived, totalAmount, isMixedPayment, mixedPayments.cash]);

  // Validación de pago
  const canConfirm = useMemo(() => {
    if (isMixedPayment) {
      if (Math.abs(mixedDifference) > 0.01) return false;
      if (mixedPayments.credit > 0 && !selectedCustomer) return false;
      return true;
    }
    if (selectedMethod === 'credit' && !selectedCustomer) return false;
    return true;
  }, [isMixedPayment, mixedDifference, mixedPayments.credit, selectedCustomer, selectedMethod]);

  // Atajos de billetes frecuentes
  const setCashPreset = (amount: number) => {
    setCashReceived(amount);
  };

  // Crear cliente rápido
  const handleCreateFastCustomer = async () => {
    if (!newCustomerName.trim() || !accountId) return;
    try {
      const docRef = await addDoc(collection(db, 'customers'), {
        name: newCustomerName.trim(),
        phone: newCustomerPhone.trim() || '',
        accountId,
        currentDebt: 0,
        createdAt: Date.now(),
      });
      const newCust: Customer = {
        id: docRef.id,
        name: newCustomerName.trim(),
        phone: newCustomerPhone.trim(),
        accountId: accountId as string,
        currentDebt: 0,
        totalPurchases: 0,
        totalSpent: 0,
      };
      setCustomers((prev) => [newCust, ...prev]);
      setSelectedCustomer(newCust);
      setShowNewCustomerModal(false);
      setNewCustomerName('');
      setNewCustomerPhone('');
      toast({ title: 'Cliente registrado para crédito' });
    } catch (err: any) {
      toast({ title: 'Error al registrar cliente', variant: 'destructive' });
    }
  };

  // Confirmar Venta
  const handleConfirmSale = async () => {
    if (!canConfirm || !accountId) return;

    try {
      setLoading(true);

      const cartItemsPayload = items.map((i) => ({
        id: i.product.id,
        name: i.product.name,
        price: i.unitPrice,
        quantity: i.quantity,
        sku: i.product.sku || '',
        category: i.product.category || '',
        costPrice: i.product.costPrice || 0,
        unitOfMeasure: i.product.unitOfMeasure || (i.product as any).unit || 'unit',
      }));

      // Construcción de PaymentSplit[]
      const payments: PaymentSplit[] = [];
      let primaryMethodName = 'Efectivo';

      if (isMixedPayment) {
        if (mixedPayments.cash > 0) {
          payments.push({
            methodId: 'cash',
            methodName: 'Efectivo',
            category: 'cash',
            amount: mixedPayments.cash,
          });
        }
        if (mixedPayments.yape > 0) {
          payments.push({
            methodId: 'yape',
            methodName: 'Yape',
            category: 'digital',
            digitalProvider: 'yape',
            amount: mixedPayments.yape,
          });
        }
        if (mixedPayments.plin > 0) {
          payments.push({
            methodId: 'plin',
            methodName: 'Plin',
            category: 'digital',
            digitalProvider: 'plin',
            amount: mixedPayments.plin,
          });
        }
        if (mixedPayments.card > 0) {
          payments.push({
            methodId: 'card',
            methodName: 'Tarjeta POS',
            category: 'card',
            amount: mixedPayments.card,
          });
        }
        if (mixedPayments.credit > 0) {
          payments.push({
            methodId: 'credit',
            methodName: 'Crédito / Fiado',
            category: 'credit',
            amount: mixedPayments.credit,
          });
        }
        primaryMethodName = 'Pago Mixto';
      } else {
        if (selectedMethod === 'cash') {
          payments.push({ methodId: 'cash', methodName: 'Efectivo', category: 'cash', amount: totalAmount });
          primaryMethodName = 'Efectivo';
        } else if (selectedMethod === 'yape') {
          payments.push({ methodId: 'yape', methodName: 'Yape', category: 'digital', digitalProvider: 'yape', amount: totalAmount });
          primaryMethodName = 'Yape';
        } else if (selectedMethod === 'plin') {
          payments.push({ methodId: 'plin', methodName: 'Plin', category: 'digital', digitalProvider: 'plin', amount: totalAmount });
          primaryMethodName = 'Plin';
        } else if (selectedMethod === 'card') {
          payments.push({ methodId: 'card', methodName: 'Tarjeta POS', category: 'card', amount: totalAmount });
          primaryMethodName = 'Tarjeta';
        } else if (selectedMethod === 'credit') {
          payments.push({ methodId: 'credit', methodName: 'Crédito / Fiado', category: 'credit', amount: totalAmount });
          primaryMethodName = 'Crédito / Fiado';
        }
      }

      const salePayload: Partial<Sale> = {
        date: Date.now(),
        items: cartItemsPayload,
        subtotal: totalAmount,
        tax: 0,
        total: totalAmount,
        paymentMethod: primaryMethodName,
        payments,
        cashReceived: selectedMethod === 'cash' || (isMixedPayment && mixedPayments.cash > 0) ? cashReceived : totalAmount,
        changeGiven,
        branchId,
        status: 'completed',
        statusNotes: notes.trim() || undefined,
        customerId: selectedCustomer?.id,
        customerName: selectedCustomer?.name,
        customerPhone: selectedCustomer?.phone,
      };

      // Guardado atómico con saveSale de Ventify
      const result = await saveSale(salePayload);

      // Enviar a imprimir por Bluetooth térmico
      try {
        await printReceipt({
          businessName: (userDoc?.businessName as string) || 'VENTIFY',
          address: (userDoc?.branchAddress as string) || '',
          documentTitle: 'NOTA DE VENTA',
          documentNumber: String(result.saleNumber || Date.now().toString().slice(-6)),
          date: new Date().toLocaleDateString('es-PE'),
          time: new Date().toLocaleTimeString('es-PE'),
          paymentMethod: primaryMethodName,
          customerName: selectedCustomer?.name,
          customerDocNumber: selectedCustomer?.dni,
          items: items.map((i) => ({
            name: i.product.name,
            quantity: i.quantity,
            price: i.unitPrice,
            total: i.subtotal,
          })),
          subtotal: totalAmount,
          total: totalAmount,
          cashReceived: cashReceived,
          changeGiven: changeGiven,
          footerNote: '¡Gracias por su compra!',
        });
      } catch (printErr) {
        console.warn('Impresora no conectada al finalizar venta');
      }

      toast({
        title: '¡Venta registrada con éxito!',
        description: `Ticket N° ${result.saleNumber || ''} - Total S/ ${totalAmount.toFixed(2)}`,
      });

      // Limpiar carrito y regresar al visor de venta
      clearCart();
      router.replace('/mobile/pos');
    } catch (err: any) {
      console.error('[Checkout] Error registrando venta:', err);
      toast({
        title: 'Error al registrar la venta',
        description: err.message || 'Ocurrió un error inesperado.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full bg-white select-none">
      {/* Barra superior con volver */}
      <div className="p-3 bg-white border-b border-neutral-100 flex items-center justify-between sticky top-12 z-30">
        <Link href="/mobile/pos">
          <button className="flex items-center gap-1.5 text-xs font-semibold text-neutral-600 hover:text-neutral-900">
            <ArrowLeft className="w-4 h-4" />
            <span>Volver a Venta</span>
          </button>
        </Link>
        <span className="text-xs font-bold text-neutral-900">Revisar Orden</span>
        <div className="w-12" />
      </div>

      <div className="p-4 space-y-4">
        {/* 1. RESUMEN DE ARTÍCULOS */}
        <div className="bg-neutral-50 rounded-2xl p-3.5 border border-neutral-100">
          <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
            <span className="text-xs font-bold text-neutral-800">
              Resumen ({items.length} {items.length === 1 ? 'artículo' : 'artículos'})
            </span>
            <span className="text-xs font-semibold text-neutral-500">Subtotal</span>
          </div>
          <div className="py-2 divide-y divide-neutral-100 max-h-36 overflow-y-auto">
            {items.map((item) => (
              <div key={item.product.id} className="py-1.5 flex items-center justify-between text-xs">
                <span className="text-neutral-800 truncate max-w-[180px]">
                  {item.product.name} <strong className="text-neutral-500">x{item.quantity}</strong>
                </span>
                <span className="font-semibold text-neutral-900">
                  S/ {item.subtotal.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="pt-2 border-t border-neutral-200 flex items-center justify-between">
            <span className="text-xs font-bold text-neutral-800 uppercase tracking-wider">
              Total a Cobrar
            </span>
            <span className="text-base font-extrabold text-emerald-600">
              S/ {totalAmount.toFixed(2)}
            </span>
          </div>
        </div>

        {/* 2. NOTAS / OBSERVACIONES */}
        <div>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notas u observaciones (opcional)..."
            className="h-10 rounded-xl bg-neutral-50 border-neutral-200 text-xs"
          />
        </div>

        {/* 3. SELECTOR DE PAGO SIMPLE VS PAGO MIXTO */}
        <div className="flex items-center justify-between pt-1">
          <label className="text-xs font-bold text-neutral-800">Método de Pago</label>
          <button
            onClick={() => {
              setIsMixedPayment(!isMixedPayment);
              if (!isMixedPayment) {
                setMixedPayments({ cash: totalAmount, yape: 0, plin: 0, card: 0, credit: 0 });
              }
            }}
            className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-all ${
              isMixedPayment
                ? 'bg-purple-50 border-purple-300 text-purple-700'
                : 'bg-neutral-50 border-neutral-200 text-neutral-600'
            }`}
          >
            {isMixedPayment ? '✓ Pago Mixto Activo' : '+ Dividir Pago'}
          </button>
        </div>

        {/* MODO A: PAGO SIMPLE (1 MÉTODO) */}
        {!isMixedPayment ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setSelectedMethod('cash')}
                className={`p-3 rounded-2xl border text-left flex flex-col justify-between transition-all ${
                  selectedMethod === 'cash'
                    ? 'border-emerald-600 bg-emerald-50/50 shadow-xs'
                    : 'border-neutral-200 bg-white hover:bg-neutral-50'
                }`}
              >
                <Banknote className="w-5 h-5 text-emerald-600 mb-1" />
                <span className="text-xs font-bold text-neutral-800">Efectivo</span>
                <span className="text-[10px] text-neutral-400">Caja física</span>
              </button>

              <button
                onClick={() => setSelectedMethod('yape')}
                className={`p-3 rounded-2xl border text-left flex flex-col justify-between transition-all ${
                  selectedMethod === 'yape'
                    ? 'border-purple-600 bg-purple-50/50 shadow-xs'
                    : 'border-neutral-200 bg-white hover:bg-neutral-50'
                }`}
              >
                <QrCode className="w-5 h-5 text-purple-600 mb-1" />
                <span className="text-xs font-bold text-neutral-800">Yape</span>
                <span className="text-[10px] text-neutral-400">QR / Teléfono</span>
              </button>

              <button
                onClick={() => setSelectedMethod('plin')}
                className={`p-3 rounded-2xl border text-left flex flex-col justify-between transition-all ${
                  selectedMethod === 'plin'
                    ? 'border-sky-600 bg-sky-50/50 shadow-xs'
                    : 'border-neutral-200 bg-white hover:bg-neutral-50'
                }`}
              >
                <QrCode className="w-5 h-5 text-sky-600 mb-1" />
                <span className="text-xs font-bold text-neutral-800">Plin</span>
                <span className="text-[10px] text-neutral-400">Interbank / BBVA</span>
              </button>

              <button
                onClick={() => setSelectedMethod('card')}
                className={`p-3 rounded-2xl border text-left flex flex-col justify-between transition-all ${
                  selectedMethod === 'card'
                    ? 'border-indigo-600 bg-indigo-50/50 shadow-xs'
                    : 'border-neutral-200 bg-white hover:bg-neutral-50'
                }`}
              >
                <CreditCard className="w-5 h-5 text-indigo-600 mb-1" />
                <span className="text-xs font-bold text-neutral-800">Tarjeta</span>
                <span className="text-[10px] text-neutral-400">POS Niubiz/Izipay</span>
              </button>
            </div>

            <button
              onClick={() => setSelectedMethod('credit')}
              className={`w-full p-3 rounded-2xl border text-left flex items-center justify-between transition-all ${
                selectedMethod === 'credit'
                  ? 'border-amber-600 bg-amber-50/50 shadow-xs'
                  : 'border-neutral-200 bg-white hover:bg-neutral-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-amber-600" />
                <div>
                  <span className="text-xs font-bold text-neutral-800 block">
                    Crédito / Fiado
                  </span>
                  <span className="text-[10px] text-neutral-400">
                    {selectedCustomer
                      ? `Cliente: ${selectedCustomer.name}`
                      : 'Asociar a libreta de cuentas por cobrar'}
                  </span>
                </div>
              </div>
              <span className="text-xs font-semibold text-amber-600">
                {selectedCustomer ? 'Cambiar' : 'Seleccionar'}
              </span>
            </button>

            {/* SECCIÓN DINÁMICA: EFECTIVO (Billetes rápidos y vuelto) */}
            {selectedMethod === 'cash' && (
              <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-neutral-700">Monto Recibido:</span>
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-bold text-neutral-500">S/</span>
                    <Input
                      type="number"
                      value={cashReceived}
                      onChange={(e) => setCashReceived(parseFloat(e.target.value) || 0)}
                      className="w-24 h-9 rounded-lg bg-white text-right font-bold text-xs"
                    />
                  </div>
                </div>

                {/* Billetes rápidos */}
                <div className="grid grid-cols-5 gap-1.5">
                  {[totalAmount, 10, 20, 50, 100].map((b, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCashPreset(b)}
                      className="py-1.5 text-xs font-bold bg-white border border-neutral-200 hover:border-emerald-500 rounded-lg text-neutral-800 active:scale-95"
                    >
                      {idx === 0 ? 'Exacto' : `S/ ${b}`}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                  <span className="text-xs font-semibold text-neutral-600">Vuelto a entregar:</span>
                  <span
                    className={`text-sm font-extrabold ${
                      changeGiven > 0 ? 'text-emerald-600' : 'text-neutral-700'
                    }`}
                  >
                    S/ {changeGiven.toFixed(2)}
                  </span>
                </div>
              </div>
            )}

            {/* SECCIÓN DINÁMICA: YAPE / PLIN (Visor QR) */}
            {(selectedMethod === 'yape' || selectedMethod === 'plin') && (
              <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 text-center space-y-2">
                <span className="text-xs font-bold text-neutral-800 uppercase tracking-wide">
                  Código QR {selectedMethod.toUpperCase()}
                </span>
                <div className="w-36 h-36 mx-auto bg-white border border-neutral-200 rounded-xl flex items-center justify-center p-2 shadow-xs">
                  <QrCode className="w-24 h-24 text-neutral-800" />
                </div>
                <p className="text-xs font-bold text-neutral-900">
                  Total: S/ {totalAmount.toFixed(2)}
                </p>
                <p className="text-[11px] text-neutral-500">
                  Pide al cliente escanear este QR desde su app móvil
                </p>
              </div>
            )}

            {/* SECCIÓN DINÁMICA: CRÉDITO / FIADO */}
            {selectedMethod === 'credit' && (
              <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-neutral-800">Asociar Cliente</span>
                  <button
                    onClick={() => setShowNewCustomerModal(true)}
                    className="text-xs font-semibold text-emerald-600 flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Nuevo
                  </button>
                </div>

                <Input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Buscar por nombre o teléfono..."
                  className="h-9 rounded-xl bg-white border-neutral-200 text-xs"
                />

                <div className="max-h-28 overflow-y-auto divide-y divide-neutral-200/60">
                  {customers
                    .filter((c) =>
                      c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
                      (c.phone && c.phone.includes(customerSearch))
                    )
                    .slice(0, 5)
                    .map((c) => (
                      <div
                        key={c.id}
                        onClick={() => setSelectedCustomer(c)}
                        className={`py-2 px-2.5 rounded-lg flex items-center justify-between text-xs cursor-pointer ${
                          selectedCustomer?.id === c.id ? 'bg-amber-100 font-bold' : 'hover:bg-white'
                        }`}
                      >
                        <span>{c.name}</span>
                        <span className="text-neutral-500 text-[11px]">{c.phone || 'Sin tel.'}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* MODO B: PAGOS MIXTOS (Dividir Total) */
          <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
              <span className="text-xs font-bold text-neutral-800">Dividir Montos por Método</span>
              <span
                className={`text-xs font-bold ${
                  Math.abs(mixedDifference) < 0.01 ? 'text-emerald-600' : 'text-rose-600'
                }`}
              >
                {Math.abs(mixedDifference) < 0.01
                  ? '✓ Cuadrado Exacto'
                  : mixedDifference > 0
                  ? `Falta: S/ ${mixedDifference.toFixed(2)}`
                  : `Excede: S/ ${Math.abs(mixedDifference).toFixed(2)}`}
              </span>
            </div>

            <div className="space-y-2">
              {[
                { key: 'cash', label: 'Efectivo', icon: Banknote },
                { key: 'yape', label: 'Yape', icon: QrCode },
                { key: 'plin', label: 'Plin', icon: QrCode },
                { key: 'card', label: 'Tarjeta POS', icon: CreditCard },
                { key: 'credit', label: 'Crédito / Fiado', icon: UserCheck },
              ].map(({ key, label, icon: Icon }) => (
                <div key={key} className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-1.5 w-32">
                    <Icon className="w-4 h-4 text-neutral-500" />
                    <span className="font-semibold text-neutral-800">{label}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-neutral-500 font-bold">S/</span>
                    <Input
                      type="number"
                      step="0.10"
                      min="0"
                      value={(mixedPayments as any)[key] || ''}
                      onChange={(e) =>
                        setMixedPayments({
                          ...mixedPayments,
                          [key]: parseFloat(e.target.value) || 0,
                        })
                      }
                      className="w-24 h-8 rounded-lg bg-white text-right font-bold text-xs"
                      placeholder="0.00"
                    />
                  </div>
                </div>
              ))}
            </div>

            {mixedPayments.credit > 0 && !selectedCustomer && (
              <div className="p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800 flex items-center justify-between">
                <span>Asocia un cliente para el saldo a crédito</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowNewCustomerModal(true)}
                  className="h-7 text-[11px] rounded-lg"
                >
                  Elegir Cliente
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 4. BOTÓN CONFIRMAR VENTA */}
        <div className="pt-2">
          <Button
            onClick={handleConfirmSale}
            disabled={!canConfirm || loading}
            className="w-full h-14 text-sm font-bold rounded-2xl text-white shadow-lg active:scale-98 transition-all flex items-center justify-center gap-2"
            style={{ backgroundColor: canConfirm ? 'var(--brand-primary, #047857)' : '#9ca3af' }}
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-5 h-5" />
            )}
            Confirmar Venta y Emitir Ticket (S/ {totalAmount.toFixed(2)})
          </Button>
        </div>
      </div>

      {/* Modal Nuevo Cliente Rápido */}
      {showNewCustomerModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xs bg-white rounded-2xl p-5 shadow-2xl space-y-3">
            <h3 className="text-sm font-bold text-neutral-800">Crear Cliente Rápido</h3>
            <Input
              value={newCustomerName}
              onChange={(e) => setNewCustomerName(e.target.value)}
              placeholder="Nombre del cliente..."
              className="h-9 text-xs"
            />
            <Input
              value={newCustomerPhone}
              onChange={(e) => setNewCustomerPhone(e.target.value)}
              placeholder="Teléfono WhatsApp..."
              className="h-9 text-xs"
            />
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowNewCustomerModal(false)}
                className="text-xs"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleCreateFastCustomer}
                className="text-xs font-semibold text-white"
                style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
              >
                Guardar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
