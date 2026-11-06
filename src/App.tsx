import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';
import { ProductsProvider } from './context/ProductsContext';
import { CartProvider } from './context/CartContext';
import { Header } from './components/Header';
import { BottomNav, TabKey } from './components/BottomNav';
import { PinLockModal } from './components/PinLockModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoginView } from './views/LoginView';
import { PosView } from './views/PosView';
import { CatalogView } from './views/CatalogView';
import { InventoryView } from './views/InventoryView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { Loader2 } from 'lucide-react';
import { initNotifications, notifyShiftClosed, notifySunatAlert } from './services/notification-service';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';

const MobileMain: React.FC = () => {
  const { user, userDoc, accountId, initialized } = useAuth();
  const [activeTab, setActiveTab] = useState<TabKey>('pos');
  const [isLocked, setIsLocked] = useState(false);

  // 1. Inicializar Notificaciones al loguearse
  useEffect(() => {
    if (user) {
      initNotifications().catch((err) => {
        console.warn('[App] Error initializing notifications:', err);
      });
    }
  }, [user]);

  // 2. Monitoreo de incidencias SUNAT en segundo plano
  useEffect(() => {
    if (!accountId) return;
    const mountTime = Date.now();
    try {
      const q = query(
        collection(db, 'sales'),
        where('accountId', '==', accountId)
      );

      const unsub = onSnapshot(q, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'added' || change.type === 'modified') {
            const data = change.doc.data();
            const rawDate = data.date || data.createdAt;
            const itemTime =
              typeof rawDate?.toMillis === 'function'
                ? rawDate.toMillis()
                : Number(rawDate || 0);

            // Solo evaluar comprobantes procesados tras iniciar la sesión
            if (itemTime > mountTime - 60000) {
              const sunatSt = String(data.sunatStatus || data.status || '').toUpperCase();
              if (
                sunatSt.includes('RECHAZ') ||
                sunatSt.includes('OBSERV') ||
                Boolean(data.sunatError)
              ) {
                const docNum = data.saleNumber
                  ? `#${data.saleNumber}`
                  : data.id?.slice(-6).toUpperCase() || '---';
                const reason =
                  data.sunatError ||
                  data.sunatMessage ||
                  'Comprobante observado o rechazado ante SUNAT.';
                notifySunatAlert(
                  data.documentType?.toUpperCase() || 'Comprobante',
                  docNum,
                  reason
                );
              }
            }
          }
        });
      }, (err) => console.warn('[App] SUNAT listener error:', err));

      return () => unsub();
    } catch {}
  }, [accountId]);

  // 3. Alertas de Arqueo / Cierre de Caja para Owner y Admin
  useEffect(() => {
    if (!accountId) return;
    const role = userDoc?.role?.toLowerCase();
    const isOwnerOrAdmin = role === 'owner' || role === 'admin' || !role;
    if (!isOwnerOrAdmin) return;

    const mountTime = Date.now();
    try {
      const q = query(
        collection(db, 'cash_movements'),
        where('accountId', '==', accountId)
      );

      const unsub = onSnapshot(q, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            if (data.type === 'closing' && (data.timestamp || 0) > mountTime) {
              notifyShiftClosed(
                data.closedBy || 'Cajero',
                data.branchName || 'Sucursal',
                data.amount || 0,
                data.difference
              );
            }
          }
        });
      }, (err) => console.warn('[App] Cash closing listener error:', err));

      return () => unsub();
    } catch {}
  }, [accountId, userDoc?.role]);

  if (!initialized) {
    return (
      <div className="min-h-screen bg-neutral-900 flex flex-col items-center justify-center p-6 text-neutral-400 select-none">
        <div className="w-16 h-16 rounded-3xl bg-neutral-800 border border-neutral-700/80 flex items-center justify-center p-3 mb-4 shadow-xl">
          <img src="./ventify-icono.webp" alt="Ventify" className="w-full h-full object-contain" />
        </div>
        <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mb-2" />
        <p className="text-xs font-bold text-neutral-300">Iniciando Ventify Mobile POS...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginView />;
  }

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col justify-between antialiased">
      <div className="max-w-md w-full mx-auto bg-white min-h-screen flex flex-col relative shadow-xl">
        {/* Header superior */}
        <Header onLock={() => setIsLocked(true)} />

        {/* Contenido según la pestaña activa */}
        <main
          className="flex-1 overflow-y-auto"
          style={{
            paddingBottom: 'calc(max(env(safe-area-inset-bottom, 0px), 24px) + 5.5rem)',
          }}
        >
          {activeTab === 'pos' && <PosView />}
          {activeTab === 'catalog' && <CatalogView />}
          {activeTab === 'inventory' && <InventoryView />}
          {activeTab === 'history' && <HistoryView />}
          {activeTab === 'settings' && <SettingsView />}
        </main>

        {/* Barra de navegación inferior persistente (5 pestañas) */}
        <BottomNav activeTab={activeTab} onSelectTab={setActiveTab} />

        {/* Modal de bloqueo por PIN */}
        <PinLockModal
          isOpen={isLocked}
          onUnlock={() => setIsLocked(false)}
          expectedPin="1234"
        />
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <SettingsProvider>
          <ProductsProvider>
            <CartProvider>
              <MobileMain />
            </CartProvider>
          </ProductsProvider>
        </SettingsProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
};

export default App;
