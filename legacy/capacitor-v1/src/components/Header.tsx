import React from 'react';
import { useSettings } from '../context/SettingsContext';
import { Store, Lock } from 'lucide-react';

export const Header: React.FC<{ onLock: () => void }> = ({ onLock }) => {
  const { isCashOpen, activeBranchName } = useSettings();

  return (
    <header
      className="sticky top-0 z-40 bg-white border-b border-neutral-200/80 px-4 pb-2.5 flex items-center justify-between shadow-xs select-none"
      style={{
        paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 32px) + 0.5rem)',
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                isCashOpen ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="text-[11px] font-black uppercase tracking-wider text-neutral-800">
              {isCashOpen ? 'CAJA ABIERTA' : 'CAJA CERRADA'}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-neutral-500 font-medium truncate mt-0.5">
            <Store className="w-3 h-3 text-neutral-400 shrink-0" />
            <span className="truncate">{activeBranchName}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onLock}
          title="Bloquear terminal"
          className="w-8 h-8 rounded-xl bg-neutral-100 hover:bg-neutral-200 active:scale-95 flex items-center justify-center text-neutral-600 transition-all"
        >
          <Lock className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
