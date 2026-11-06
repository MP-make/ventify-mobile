"use client";

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/use-auth';
import { getActiveCashRegisterSession } from '@/services/cash-register/cash-query-service';
import { CashRegisterSession } from '@/services/cash-register/types';
import { Settings, Lock, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';

import { useBusinessSettings } from '@/hooks/use-business-settings';

interface MobileHeaderProps {
  onLockScreen?: () => void;
}

export function MobileHeader({ onLockScreen }: MobileHeaderProps) {
  const authState = useAuth();
  const { userDoc, user } = authState;
  const { settings } = useBusinessSettings();
  const [activeSession, setActiveSession] = useState<CashRegisterSession | null>(null);

  const accountId = (authState.accountId || userDoc?.accountId || user?.accountId) as string | undefined;
  const branchId = userDoc?.branchId;
  const branchName = (userDoc?.branchName as string) || (settings as any)?.businessName || 'Tienda Principal';

  useEffect(() => {
    if (!accountId) return;

    const unsubscribe = getActiveCashRegisterSession(
      branchId,
      accountId,
      (session) => {
        setActiveSession(session);
      },
      user?.uid
    );

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [accountId, branchId, user?.uid]);

  const isOpen = !!activeSession && activeSession.status === 'open';

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-neutral-200 px-4 py-2.5 flex items-center justify-between shadow-xs">
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              isOpen ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
            }`}
          />
          <span className="text-xs font-semibold tracking-tight text-neutral-800">
            {isOpen ? 'CAJA ABIERTA' : 'CAJA CERRADA'}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-neutral-500 mt-0.5 font-medium">
          <Store className="w-3 h-3 text-neutral-400" />
          <span className="truncate max-w-[170px]">
            {branchName}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {onLockScreen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onLockScreen}
            className="w-8 h-8 rounded-full text-neutral-600 hover:bg-neutral-100"
            title="Bloquear terminal con PIN"
          >
            <Lock className="w-4 h-4" />
          </Button>
        )}
        <Link href="/mobile/settings">
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 rounded-full text-neutral-600 hover:bg-neutral-100"
            title="Ajustes y Hardware"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </Link>
      </div>
    </header>
  );
}
