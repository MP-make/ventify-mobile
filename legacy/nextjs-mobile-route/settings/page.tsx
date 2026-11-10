"use client";

import React, { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useMobilePrinter } from '../contexts/mobile-printer-context';
import {
  Printer,
  Bluetooth,
  QrCode,
  Store,
  Loader2,
  LogOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { auth } from '@/lib/firebase';
import { signOut } from 'firebase/auth';

export default function MobileSettingsPage() {
  const { user, userDoc } = useAuth();
  const {
    isConnected,
    isConnecting,
    deviceName,
    paperWidth,
    setPaperWidth,
    connectBluetooth,
    disconnect,
    printTestTicket,
  } = useMobilePrinter();

  const [testingPrint, setTestingPrint] = useState(false);

  // Datos de QR
  const [yapePhone, setYapePhone] = useState('987654321');
  const [yapeName, setYapeName] = useState<string>((userDoc?.businessName as string) || 'Mi Negocio');

  const handleTestPrint = async () => {
    try {
      setTestingPrint(true);
      await printTestTicket();
    } finally {
      setTestingPrint(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full bg-white select-none p-4 space-y-4">
      <div className="pb-2 border-b border-neutral-100">
        <h2 className="text-sm font-bold text-neutral-900">Ajustes y Hardware</h2>
        <p className="text-[11px] text-neutral-400">
          Configuración de periféricos de mostrador y datos de la tienda
        </p>
      </div>

      {/* 1. TICKETERA TÉRMICA BLUETOOTH */}
      <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Printer className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-neutral-800">Ticketera Bluetooth</h3>
              <p className="text-[10px] text-neutral-400">Protocolo directo ESC/POS</p>
            </div>
          </div>

          <span
            className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
              isConnected
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-neutral-200 text-neutral-600'
            }`}
          >
            <Bluetooth className="w-3 h-3" />
            {isConnected ? deviceName || 'Conectada' : 'Desconectada'}
          </span>
        </div>

        {/* Selector de Ancho de Papel */}
        <div>
          <label className="text-[11px] font-semibold text-neutral-600 block mb-1">
            Ancho de Papel Térmico
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setPaperWidth(80)}
              className={`py-2 text-xs font-bold rounded-xl border transition-all ${
                paperWidth === 80
                  ? 'bg-neutral-900 border-neutral-900 text-white shadow-xs'
                  : 'bg-white border-neutral-200 text-neutral-600'
              }`}
            >
              80 mm (Recomendado)
            </button>
            <button
              onClick={() => setPaperWidth(58)}
              className={`py-2 text-xs font-bold rounded-xl border transition-all ${
                paperWidth === 58
                  ? 'bg-neutral-900 border-neutral-900 text-white shadow-xs'
                  : 'bg-white border-neutral-200 text-neutral-600'
              }`}
            >
              58 mm (Portátil)
            </button>
          </div>
        </div>

        {/* Botones de Conexión y Prueba */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          {isConnected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={disconnect}
              className="h-10 rounded-xl text-xs font-semibold text-rose-600 border-rose-200 hover:bg-rose-50"
            >
              Desconectar
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={connectBluetooth}
              disabled={isConnecting}
              className="h-10 rounded-xl text-xs font-semibold text-white shadow-xs"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              {isConnecting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <Bluetooth className="w-3.5 h-3.5 mr-1" />
              )}
              Buscar Impresora
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={handleTestPrint}
            disabled={testingPrint}
            className="h-10 rounded-xl text-xs font-semibold"
          >
            {testingPrint ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
            ) : (
              <Printer className="w-3.5 h-3.5 mr-1" />
            )}
            Ticket de Prueba
          </Button>
        </div>
      </div>

      {/* 2. MÉTODOS DE COBRO QR (YAPE / PLIN) */}
      <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center">
            <QrCode className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-neutral-800">Configuración QR de Cobro</h3>
            <p className="text-[10px] text-neutral-400">Datos visibles para Yape y Plin</p>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-[11px] font-semibold text-neutral-600 block mb-1">
              Teléfono Asociado
            </label>
            <Input
              value={yapePhone}
              onChange={(e) => setYapePhone(e.target.value)}
              placeholder="987654321"
              className="h-9 text-xs rounded-xl bg-white"
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold text-neutral-600 block mb-1">
              Nombre del Titular
            </label>
            <Input
              value={yapeName}
              onChange={(e) => setYapeName(e.target.value)}
              placeholder="Nombre en cuenta bancaria..."
              className="h-9 text-xs rounded-xl bg-white"
            />
          </div>
        </div>
      </div>

      {/* 3. DATOS DE LA SUCURSAL Y USUARIO */}
      <div className="bg-neutral-50 rounded-2xl p-4 border border-neutral-100 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <Store className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-neutral-800">Datos de la Sucursal</h3>
            <p className="text-[10px] text-neutral-400">Identificación en comprobantes</p>
          </div>
        </div>

        <div className="text-xs space-y-1 pt-1 text-neutral-600">
          <div className="flex justify-between">
            <span className="text-neutral-400">Negocio:</span>
            <span className="font-semibold text-neutral-800">{((userDoc?.businessName as string) || 'Ventify')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Sucursal:</span>
            <span className="font-semibold text-neutral-800">{((userDoc?.branchName as string) || 'Tienda Principal')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Cajero en Caja:</span>
            <span className="font-semibold text-neutral-800">{((userDoc?.name as string) || user?.email || 'Cajero')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Moneda:</span>
            <span className="font-semibold text-neutral-800">PEN (S/)</span>
          </div>
        </div>
      </div>

      {/* 4. CIERRE DE SESIÓN O VOLVER */}
      <div className="pt-2">
        <Button
          variant="outline"
          onClick={async () => {
            await signOut(auth);
            if (typeof window !== 'undefined') window.location.href = '/auth/login';
          }}
          className="w-full h-11 rounded-xl text-xs font-semibold text-rose-600 border-rose-200 hover:bg-rose-50 flex items-center justify-center gap-1.5"
        >
          <LogOut className="w-4 h-4" />
          Cerrar Sesión de la Aplicación
        </Button>
      </div>
    </div>
  );
}
