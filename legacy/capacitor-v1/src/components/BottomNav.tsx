import React from 'react';
import { ShoppingBag, LayoutGrid, Package, History, Settings } from 'lucide-react';
import { useCart } from '../context/CartContext';

export type TabKey = 'pos' | 'catalog' | 'inventory' | 'history' | 'settings';

interface BottomNavProps {
  activeTab: TabKey;
  onSelectTab: (tab: TabKey) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ activeTab, onSelectTab }) => {
  const { itemCount } = useCart();

  const tabs: { key: TabKey; label: string; icon: React.FC<{ className?: string }> }[] = [
    { key: 'pos', label: 'Venta', icon: ShoppingBag },
    { key: 'catalog', label: 'Catálogo', icon: LayoutGrid },
    { key: 'inventory', label: 'Inventario', icon: Package },
    { key: 'history', label: 'Historial', icon: History },
    { key: 'settings', label: 'Ajustes', icon: Settings },
  ];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-neutral-200/90 px-2 flex justify-around items-start shadow-lg select-none"
      style={{
        paddingTop: '0.625rem',
        paddingBottom: 'calc(max(env(safe-area-inset-bottom, 0px), 24px) + 0.75rem)',
      }}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.key;

        return (
          <button
            key={tab.key}
            onClick={() => onSelectTab(tab.key)}
            className={`flex flex-col items-center justify-center flex-1 py-1 rounded-xl transition-all relative ${
              isActive ? 'font-bold' : 'text-neutral-400 font-medium hover:text-neutral-600'
            }`}
            style={{
              color: isActive ? 'var(--brand-primary, #047857)' : undefined,
            }}
          >
            <div className="relative">
              <Icon className={`w-5 h-5 ${isActive ? 'scale-110' : ''} transition-transform`} />
              {tab.key === 'pos' && itemCount > 0 && (
                <span
                  className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full text-[9px] font-black text-white flex items-center justify-center shadow-xs"
                  style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                >
                  {itemCount > 99 ? '99+' : itemCount}
                </span>
              )}
            </div>
            <span className="text-[10px] mt-0.5 tracking-tight">{tab.label}</span>
            {isActive && (
              <span
                className="w-1.5 h-1.5 rounded-full mt-0.5"
                style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
};
