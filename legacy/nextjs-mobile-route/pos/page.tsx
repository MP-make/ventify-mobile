"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/use-auth';
import { useProducts } from '@/hooks/products/use-products';
import { useMobileCart } from '../contexts/mobile-cart-context';
import { mobileCacheService } from '../services/mobile-cache-service';
import { ShootToScanModal } from '../components/shoot-to-scan-modal';
import {
  Camera,
  CameraOff,
  Zap,
  ZapOff,
  Trash2,
  Plus,
  Minus,
  Maximize2,
  ShoppingCart,
  ArrowRight,
  PackageSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';

export default function MobilePosPage() {
  const { userDoc } = useAuth();
  const { products } = useProducts();
  const { items, updateQuantity, removeItem, clearCart, totalAmount, itemCount, addItem } =
    useMobileCart();

  // Control de cámara en el visor superior
  const [cameraActive, setCameraActive] = useState(true);
  const [torch, setTorch] = useState(false);
  const [shootToScanOpen, setShootToScanOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const isScanningRef = useRef(false);

  // Sincronizar catálogo con IndexedDB y memoria
  useEffect(() => {
    if (products.length > 0) {
      mobileCacheService.cacheProducts(products);
    }
  }, [products]);

  const handleBarcodeScanned = useCallback(
    (code: string) => {
      if (!code || isScanningRef.current) return;
      isScanningRef.current = true;

      const product = mobileCacheService.findByBarcodeOrSku(code);
      if (product) {
        addItem(product, 1);
      }

      // Pequeño retardo antes de permitir el siguiente escaneo (no duplicar el mismo frame)
      setTimeout(() => {
        isScanningRef.current = false;
      }, 1000);
    },
    [addItem]
  );

  // Iniciar/Detener visor superior continuo
  useEffect(() => {
    if (!cameraActive) {
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
      return;
    }

    let isMounted = true;
    const reader = new BrowserMultiFormatReader();

    const startStream = async () => {
      try {
        if (!videoRef.current || !navigator?.mediaDevices?.getUserMedia) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});

        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current,
          (result) => {
            if (!isMounted) return;
            if (result && !isScanningRef.current) {
              handleBarcodeScanned(result.getText());
            }
          }
        );

        if (isMounted) {
          controlsRef.current = controls;
        } else {
          controls.stop();
        }
      } catch (err) {
        console.warn('[MobilePOS] Visor de cámara pausado o no disponible en este dispositivo:', err);
        if (isMounted) setCameraActive(false);
      }
    };

    startStream();

    return () => {
      isMounted = false;
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
    };
  }, [cameraActive, handleBarcodeScanned]);

  // Alternar linterna
  const toggleTorch = async () => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | undefined;
      const track = stream?.getVideoTracks()[0];
      if (track && (track.getCapabilities as any)?.()?.torch) {
        await (track as any).applyConstraints({
          advanced: [{ torch: !torch }],
        });
        setTorch(!torch);
      }
    } catch {
      // Ignorar si no soporta linterna
    }
  };

  return (
    <div className="flex flex-col h-full bg-white select-none">
      {/* 1. VISOR DE CÁMARA SUPERIOR (30-35% de la pantalla) */}
      <div className="relative w-full h-44 sm:h-52 bg-neutral-900 overflow-hidden flex items-center justify-center border-b border-neutral-200">
        {cameraActive ? (
          <>
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted
            />

            {/* Retícula visual de guía */}
            <div className="relative z-10 w-52 h-28 border border-white/40 rounded-xl flex items-center justify-center pointer-events-none">
              <div className="w-full h-0.5 bg-emerald-400/70 shadow-xs animate-pulse" />
            </div>

            <div className="absolute bottom-2 inset-x-0 text-center z-10 pointer-events-none">
              <span className="text-[10px] text-white/80 bg-black/40 backdrop-blur-xs px-2.5 py-0.5 rounded-full">
                Alinea el código de barras en el marco
              </span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center text-neutral-400 text-xs p-4 text-center">
            <CameraOff className="w-8 h-8 mb-1.5 opacity-60" />
            <span>Cámara pausada para ahorrar batería</span>
            <button
              onClick={() => setCameraActive(true)}
              className="mt-2 text-xs font-semibold text-emerald-400 underline underline-offset-2"
            >
              Activar Visor
            </button>
          </div>
        )}

        {/* Controles sobre el visor */}
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 z-20">
          {cameraActive && (
            <button
              onClick={toggleTorch}
              className="w-8 h-8 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center text-white active:scale-95"
              title="Linterna"
            >
              {torch ? <Zap className="w-4 h-4 text-amber-400 fill-amber-400" /> : <ZapOff className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={() => setCameraActive(!cameraActive)}
            className="w-8 h-8 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center text-white active:scale-95"
            title={cameraActive ? "Pausar cámara" : "Activar cámara"}
          >
            {cameraActive ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4 text-emerald-400" />}
          </button>

          <button
            onClick={() => setShootToScanOpen(true)}
            className="w-8 h-8 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center text-white active:scale-95"
            title="Escanear en pantalla completa"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. CARRITO ACTUAL INFERIOR */}
      <div className="flex-1 flex flex-col p-4 overflow-hidden">
        <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
          <div className="flex items-center gap-1.5">
            <ShoppingCart className="w-4 h-4 text-neutral-500" />
            <h2 className="text-xs font-bold text-neutral-800 tracking-tight">
              Carrito Actual ({items.length} {items.length === 1 ? 'producto' : 'productos'})
            </h2>
          </div>

          {items.length > 0 && (
            <button
              onClick={() => setConfirmClearOpen(true)}
              className="text-[11px] font-semibold text-rose-500 hover:text-rose-700 flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              Vaciar
            </button>
          )}
        </div>

        {/* Lista de Items */}
        <div className="flex-1 overflow-y-auto py-2 divide-y divide-neutral-100">
          {items.length === 0 ? (
            <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center p-6 text-neutral-400">
              <div className="w-14 h-14 rounded-2xl bg-neutral-100 flex items-center justify-center mb-3 text-neutral-400">
                <PackageSearch className="w-7 h-7" />
              </div>
              <p className="text-sm font-semibold text-neutral-600 mb-1">Carrito Vacío</p>
              <p className="text-xs text-neutral-400 max-w-[240px]">
                Escanea códigos con la cámara superior o elige productos desde la pestaña{' '}
                <Link href="/mobile/catalog" className="text-primary font-medium underline">
                  Catálogo
                </Link>
                .
              </p>
            </div>
          ) : (
            items.map((item) => (
              <div key={item.product.id} className="py-2.5 flex items-center justify-between gap-3">
                {/* Miniatura y descripción */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-11 h-11 rounded-xl bg-neutral-100 border border-neutral-200 overflow-hidden flex items-center justify-center flex-shrink-0">
                    {item.product.imageUrl ? (
                      <img
                        src={item.product.imageUrl}
                        alt={item.product.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[10px] font-bold text-neutral-400">IMG</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-neutral-900 truncate">
                      {item.product.name}
                    </p>
                    <p className="text-[11px] text-neutral-500">
                      S/ {item.unitPrice.toFixed(2)} c/u
                    </p>
                  </div>
                </div>

                {/* Controles de cantidad y subtotal */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center border border-neutral-200 rounded-lg bg-neutral-50">
                    <button
                      onClick={() => updateQuantity(item.product.id, item.quantity - 1)}
                      className="w-7 h-7 flex items-center justify-center text-neutral-600 active:scale-90"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <span className="w-7 text-center text-xs font-bold text-neutral-800">
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => updateQuantity(item.product.id, item.quantity + 1)}
                      className="w-7 h-7 flex items-center justify-center text-neutral-600 active:scale-90"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                  <span className="text-xs font-bold text-neutral-900 w-14 text-right">
                    S/ {item.subtotal.toFixed(2)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 3. BARRA FLOTANTE DE ACCIÓN INFERIOR */}
      {items.length > 0 && (
        <div className="sticky bottom-16 inset-x-0 p-3 bg-white/95 backdrop-blur-md border-t border-neutral-200 shadow-md">
          <Link href="/mobile/checkout" className="block">
            <Button
              className="w-full h-12 text-sm font-semibold rounded-xl text-white shadow-md flex items-center justify-between px-4 active:scale-98 transition-transform"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              <span>Revisar Orden ({itemCount})</span>
              <div className="flex items-center gap-1.5 font-bold">
                <span>S/ {totalAmount.toFixed(2)}</span>
                <ArrowRight className="w-4 h-4" />
              </div>
            </Button>
          </Link>
        </div>
      )}

      {/* Modal flotante Shoot-to-Scan a pantalla completa */}
      <ShootToScanModal
        isOpen={shootToScanOpen}
        onClose={() => setShootToScanOpen(false)}
        autoCloseOnScan={false}
      />

      {/* Confirmación modal para vaciar carrito */}
      {confirmClearOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xs bg-white rounded-2xl p-5 shadow-2xl text-center">
            <Trash2 className="w-10 h-10 text-rose-500 mx-auto mb-2" />
            <h3 className="text-sm font-bold text-neutral-800 mb-1">¿Vaciar Carrito?</h3>
            <p className="text-xs text-neutral-500 mb-4">
              Se eliminarán todos los productos agregados en esta orden.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmClearOpen(false)}
                className="rounded-xl text-xs"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  clearCart();
                  setConfirmClearOpen(false);
                }}
                className="rounded-xl text-xs font-semibold"
              >
                Sí, Vaciar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
