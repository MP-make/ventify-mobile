"use client";

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShoppingCart, LayoutGrid, Package, History, Settings } from 'lucide-react';
import { useMobileCart } from '../contexts/mobile-cart-context';

export function MobileNav() {
  const pathname = usePathname();
  const { itemCount } = useMobileCart();

  const tabs = [
    {
      label: 'Venta',
      href: '/mobile/pos',
      icon: ShoppingCart,
      badge: itemCount > 0 ? itemCount : null,
    },
    {
      label: 'Catálogo',
      href: '/mobile/catalog',
      icon: LayoutGrid,
    },
    {
      label: 'Inventario',
      href: '/mobile/inventory',
      icon: Package,
    },
    {
      label: 'Historial',
      href: '/mobile/history',
      icon: History,
    },
    {
      label: 'Ajustes',
      href: '/mobile/settings',
      icon: Settings,
    },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-neutral-200 px-2 py-1.5 shadow-lg select-none">
      <div className="max-w-md mx-auto grid grid-cols-5 items-center">
        {tabs.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          const Icon = tab.icon;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`relative flex flex-col items-center justify-center py-1 transition-colors ${
                isActive ? 'text-primary font-semibold' : 'text-neutral-400 hover:text-neutral-600'
              }`}
              style={isActive ? { color: 'var(--brand-primary, #047857)' } : undefined}
            >
              <div className="relative">
                <Icon className={`w-5 h-5 transition-transform ${isActive ? 'scale-110' : ''}`} />
                {tab.badge !== null && tab.badge !== undefined && (
                  <span
                    className="absolute -top-1.5 -right-2.5 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center"
                    style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                  >
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </span>
                )}
              </div>
              <span className="text-[10px] tracking-tight mt-0.5">{tab.label}</span>
              {isActive && (
                <span
                  className="absolute bottom-0 w-8 h-0.5 rounded-full"
                  style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
