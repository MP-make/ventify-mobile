import React, { useRef, useEffect, useState } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { Camera, Flashlight, FlashlightOff, X } from 'lucide-react';

interface CompactInlineScannerProps {
  onScan: (code: string) => void;
  onClose?: () => void;
  height?: number;
}

export const CompactInlineScanner: React.FC<CompactInlineScannerProps> = ({
  onScan,
  onClose,
  height = 160,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hasScannedRef = useRef(false);

  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    hasScannedRef.current = false;
    const reader = new BrowserMultiFormatReader();

    const startCamera = async () => {
      try {
        if (!navigator?.mediaDevices?.getUserMedia || !videoRef.current) {
          if (isMounted) setCameraError('Cámara no disponible en este dispositivo');
          return;
        }

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

        // Check torch
        const track = stream.getVideoTracks()[0];
        const caps: any = track?.getCapabilities?.() || {};
        if (caps.torch) {
          setHasTorch(true);
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current,
          (result) => {
            if (!isMounted) return;
            if (result && !hasScannedRef.current) {
              const text = result.getText()?.trim();
              if (text) {
                hasScannedRef.current = true;
                try {
                  if (navigator.vibrate) navigator.vibrate(80);
                } catch {}

                // Cleanly stop immediately before calling callback
                if (controlsRef.current) {
                  try { controlsRef.current.stop(); } catch {}
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

                onScan(text);
              }
            }
          }
        );

        controlsRef.current = controls;
      } catch (err: any) {
        if (isMounted) {
          console.warn('[CompactInlineScanner] Start error:', err);
          setCameraError('Permiso o acceso a cámara denegado');
        }
      }
    };

    startCamera();

    return () => {
      isMounted = false;
      if (controlsRef.current) {
        try { controlsRef.current.stop(); } catch {}
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
    };
  }, [onScan]);

  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const next = !torchOn;
      await (track as any).applyConstraints({
        advanced: [{ torch: next }],
      });
      setTorchOn(next);
    } catch (e) {
      console.warn('[CompactInlineScanner] Torch error:', e);
    }
  };

  return (
    <div
      className="relative w-full rounded-2xl overflow-hidden bg-black shadow-md border border-neutral-700/60 select-none shrink-0"
      style={{ height }}
    >
      {cameraError ? (
        <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center text-neutral-400 bg-neutral-900">
          <Camera className="w-6 h-6 mb-1 text-neutral-500" />
          <p className="text-xs font-semibold">{cameraError}</p>
          {onClose && (
            <button
              onClick={onClose}
              className="mt-2 px-3 py-1 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs"
            >
              Cerrar
            </button>
          )}
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />

          {/* Retícula de escaneo */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-48 h-20 border-2 border-emerald-400/90 rounded-xl relative shadow-[0_0_12px_rgba(52,211,153,0.3)]">
              <div className="w-full h-0.5 bg-emerald-400 absolute top-1/2 -translate-y-1/2 shadow-[0_0_8px_#34d399] animate-pulse" />
            </div>
          </div>

          {/* Badge superior */}
          <div className="absolute top-2 left-2 pointer-events-none">
            <span className="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-white text-[10px] font-bold">
              Escaneando código...
            </span>
          </div>

          {/* Botón cerrar */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Cerrar escáner"
              className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-md text-white flex items-center justify-center active:scale-95 transition-all z-10"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {/* Botón linterna */}
          {hasTorch && (
            <button
              type="button"
              onClick={toggleTorch}
              title="Linterna"
              className={`absolute bottom-2 left-2 w-7 h-7 rounded-xl flex items-center justify-center backdrop-blur-md transition-all active:scale-95 z-10 ${
                torchOn ? 'bg-amber-400 text-black shadow-md' : 'bg-black/60 text-white'
              }`}
            >
              {torchOn ? <Flashlight className="w-3.5 h-3.5" /> : <FlashlightOff className="w-3.5 h-3.5" />}
            </button>
          )}
        </>
      )}
    </div>
  );
};
