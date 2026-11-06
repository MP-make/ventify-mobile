import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { X, Camera, Flashlight, AlertCircle } from 'lucide-react';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScan: (code: string) => void;
  title?: string;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onScan,
  title = 'Escanear Código de Barras',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isScanningRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    isScanningRef.current = false;
    setError(null);

    const startCamera = async () => {
      try {
        if (!navigator?.mediaDevices?.getUserMedia) {
          throw new Error('La cámara no está disponible en este dispositivo.');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!isMounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current!,
          (result, err) => {
            if (!isMounted) return;
            if (result && !isScanningRef.current) {
              const text = result.getText();
              if (text) {
                isScanningRef.current = true;
                try {
                  if (navigator.vibrate) navigator.vibrate(80);
                } catch {}
                onScan(text);
              }
            }
          }
        );

        controlsRef.current = controls;
      } catch (err: any) {
        console.error('[Scanner] Camera start error:', err);
        if (isMounted) {
          setError(err.message || 'No se pudo acceder a la cámara.');
        }
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
        streamRef.current.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        streamRef.current = null;
      }
    };
  }, [isOpen, onScan]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col justify-between text-white select-none">
      {/* Top Bar */}
      <div className="relative z-10 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-emerald-400" />
          <span className="text-sm font-bold truncate">{title}</span>
        </div>
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 active:scale-95 flex items-center justify-center transition-all"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Viewfinder Area */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        {error ? (
          <div className="p-6 text-center max-w-xs space-y-3">
            <AlertCircle className="w-12 h-12 text-rose-500 mx-auto" />
            <p className="text-xs text-neutral-300 font-medium">{error}</p>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-neutral-800 rounded-xl text-xs font-bold"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 w-full h-full object-cover"
            />
            {/* Target Reticle */}
            <div className="relative z-10 w-72 h-52 border-2 border-emerald-400 rounded-3xl shadow-2xl flex flex-col items-center justify-between p-3">
              <div className="w-full flex justify-between">
                <div className="w-4 h-4 border-t-2 border-l-2 border-white rounded-tl-lg" />
                <div className="w-4 h-4 border-t-2 border-r-2 border-white rounded-tr-lg" />
              </div>
              <div className="w-full h-0.5 bg-emerald-400/80 shadow-[0_0_12px_rgba(52,211,153,0.8)] animate-pulse" />
              <div className="w-full flex justify-between">
                <div className="w-4 h-4 border-b-2 border-l-2 border-white rounded-bl-lg" />
                <div className="w-4 h-4 border-b-2 border-r-2 border-white rounded-br-lg" />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer Info */}
      <div className="relative z-10 p-5 bg-gradient-to-t from-black/90 to-transparent text-center space-y-1">
        <p className="text-xs font-semibold text-neutral-200">
          Enfoca el código de barras o QR dentro del marco
        </p>
        <p className="text-[10px] text-neutral-400">
          La detección es automática y agregará el producto al instante
        </p>
      </div>
    </div>
  );
};
