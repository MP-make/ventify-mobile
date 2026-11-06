"use client";

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Zap, ZapOff, Check, AlertCircle } from 'lucide-react';
import { mobileCacheService } from '../services/mobile-cache-service';
import { useMobileCart } from '../contexts/mobile-cart-context';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';

interface ShootToScanModalProps {
  isOpen: boolean;
  onClose: () => void;
  autoCloseOnScan?: boolean;
}

export function ShootToScanModal({ isOpen, onClose, autoCloseOnScan = true }: ShootToScanModalProps) {
  const [torch, setTorch] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const isScanningRef = useRef(false);

  const { addItem } = useMobileCart();

  const handleBarcodeDetected = useCallback(
    (code: string) => {
      if (!code || isScanningRef.current) return;
      isScanningRef.current = true;

      // Haptic feedback
      if (typeof window !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(60);
        } catch {
          // Ignore
        }
      }

      // Buscar en memoria / IndexedDB
      const product = mobileCacheService.findByBarcodeOrSku(code);

      if (product) {
        addItem(product, 1);
        setScanMessage(`¡${product.name} agregado!`);
        setScanError(null);

        if (autoCloseOnScan) {
          setTimeout(() => {
            onClose();
          }, 350);
        } else {
          setTimeout(() => {
            isScanningRef.current = false;
            setScanMessage(null);
          }, 1200);
        }
      } else {
        setScanError(`Código ${code} no encontrado en catálogo`);
        setScanMessage(null);
        setTimeout(() => {
          isScanningRef.current = false;
          setScanError(null);
        }, 1800);
      }
    },
    [addItem, autoCloseOnScan, onClose]
  );

  // Iniciar cámara con ZXing o Capacitor ML Kit si estuviera disponible
  useEffect(() => {
    if (!isOpen) {
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
      isScanningRef.current = false;
      return;
    }

    let isMounted = true;

    const startCamera = async () => {
      try {
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;

        if (!videoRef.current || !navigator?.mediaDevices?.getUserMedia) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
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
              const text = result.getText();
              handleBarcodeDetected(text);
            }
          }
        );

        if (isMounted) {
          controlsRef.current = controls;
        } else {
          controls.stop();
        }
      } catch (err: any) {
        console.error('[ShootToScan] Error accediendo a la cámara:', err);
        setScanError('No se pudo acceder a la cámara. Revisa los permisos.');
      }
    };

    startCamera();

    return () => {
      isMounted = false;
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
    };
  }, [isOpen, handleBarcodeDetected]);

  // Manejo de linterna
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
      // Linterna no soportada en este sensor
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col justify-between select-none">
      {/* Barra superior de controles */}
      <div className="flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent z-10">
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white active:scale-95"
          aria-label="Cerrar escáner"
        >
          <X className="w-5 h-5" />
        </button>

        <span className="text-white text-sm font-medium tracking-wide">
          Escanear Código de Barras
        </span>

        <button
          onClick={toggleTorch}
          className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white active:scale-95"
          aria-label="Alternar linterna"
        >
          {torch ? <Zap className="w-5 h-5 text-amber-400 fill-amber-400" /> : <ZapOff className="w-5 h-5" />}
        </button>
      </div>

      {/* Visor de cámara central con retícula */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
        />

        {/* Marco de enfoque táctil */}
        <div className="relative z-10 w-72 h-48 border-2 border-white/60 rounded-2xl shadow-2xl flex items-center justify-center">
          <div className="absolute inset-x-0 h-0.5 bg-emerald-400/80 animate-pulse shadow-sm" />
          <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-emerald-400" />
          <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-emerald-400" />
          <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-emerald-400" />
          <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-emerald-400" />
        </div>

        {/* Notificaciones flotantes sobre la cámara */}
        {scanMessage && (
          <div className="absolute bottom-16 z-20 bg-emerald-600/90 backdrop-blur-md text-white text-xs font-semibold px-4 py-2.5 rounded-full flex items-center gap-1.5 shadow-lg animate-fade-in">
            <Check className="w-4 h-4" />
            <span>{scanMessage}</span>
          </div>
        )}

        {scanError && (
          <div className="absolute bottom-16 z-20 bg-rose-600/90 backdrop-blur-md text-white text-xs font-semibold px-4 py-2.5 rounded-full flex items-center gap-1.5 shadow-lg animate-fade-in">
            <AlertCircle className="w-4 h-4" />
            <span>{scanError}</span>
          </div>
        )}
      </div>

      {/* Pie inferior con instrucción */}
      <div className="p-4 bg-gradient-to-t from-black/80 to-transparent text-center z-10">
        <p className="text-white/80 text-xs font-medium">
          Alinea el código de barras en el recuadro para agregarlo inmediatamente
        </p>
      </div>
    </div>
  );
}
