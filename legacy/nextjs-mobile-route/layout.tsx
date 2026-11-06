"use client";

import React, { useState } from 'react';
import { MobileCartProvider } from './contexts/mobile-cart-context';
import { MobilePrinterProvider } from './contexts/mobile-printer-context';
import { MobileHeader } from './components/mobile-header';
import { MobileNav } from './components/mobile-nav';
import { PinLockModal } from './components/pin-lock-modal';
import { MobileLogin } from './components/mobile-login';
import { useAuth } from '@/hooks/use-auth';
import { useBusinessSettings } from '@/hooks/use-business-settings';
import { Loader2 } from 'lucide-react';

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  const { user, initialized } = useAuth();
  const { settings } = useBusinessSettings();
  const [isLocked, setIsLocked] = useState(false);

  React.useEffect(() => {
    const primary = (settings as any)?.appearance?.primaryColor || (settings as any)?.primaryColor;
    if (primary) {
      document.documentElement.style.setProperty('--brand-primary', primary);
    }
  }, [settings]);

  if (!initialized) {
    return (
      <div className="min-h-screen bg-neutral-900 flex flex-col items-center justify-center p-6 text-neutral-400">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500 mb-2" />
        <p className="text-xs font-medium">Iniciando Ventify Mobile POS...</p>
      </div>
    );
  }

  if (!user) {
    return <MobileLogin />;
  }

  return (
    <MobileCartProvider>
      <MobilePrinterProvider>
        <div className="min-h-screen bg-neutral-100/60 flex flex-col justify-between antialiased selection:bg-emerald-500 selection:text-white">
          <div className="max-w-md w-full mx-auto bg-white min-h-screen flex flex-col relative shadow-xl">
            {/* Cabecera superior fija */}
            <MobileHeader onLockScreen={() => setIsLocked(true)} />

            {/* Contenido principal de la pantalla */}
            <main className="flex-1 pb-20 overflow-y-auto">
              {children}
            </main>

            {/* Barra de navegación inferior persistente (5 pestañas) */}
            <MobileNav />

            {/* Modal de bloqueo por PIN */}
            <PinLockModal
              isOpen={isLocked}
              onUnlock={() => setIsLocked(false)}
              expectedPin="1234"
            />
          </div>
        </div>
      </MobilePrinterProvider>
    </MobileCartProvider>
  );
}
