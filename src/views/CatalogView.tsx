import React, { useState, useMemo } from 'react';
import { useProducts } from '../context/ProductsContext';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import { CompactInlineScanner } from '../components/CompactInlineScanner';
import { Search, Package, Plus, Check, Barcode, X } from 'lucide-react';

export const CatalogView: React.FC = () => {
  const { products, categories, loading } = useProducts();
  const { addItem, items } = useCart();
  const { branchId } = useAuth();

  const [selectedCategory, setSelectedCategory] = useState('Todos');
  const [search, setSearch] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);

  const filteredProducts = useMemo(() => {
    let list = products;
    if (selectedCategory !== 'Todos') {
      list = list.filter((p) => p.category === selectedCategory);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name?.toLowerCase().includes(q) ||
          p.barcode?.toLowerCase().includes(q) ||
          p.sku?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [products, selectedCategory, search]);

  const handleAdd = (p: any) => {
    addItem(p, 1);
    setJustAddedId(p.id);
    setTimeout(() => setJustAddedId(null), 800);
  };

  return (
    <div className="flex flex-col min-h-full pb-20 select-none">
      {/* Search and Category Pills - Flush sticky top-0 */}
      <div className="p-3 bg-white border-b border-neutral-100 sticky top-0 z-30 space-y-2 shadow-2xs">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filtrar catálogo..."
              className="w-full h-10 pl-9 pr-8 rounded-xl bg-neutral-100 border-none text-xs text-neutral-900 placeholder:text-neutral-400 focus:bg-white focus:ring-2 focus:ring-emerald-500/20 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-3 text-neutral-400 hover:text-neutral-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Botón de escaneo rápido de código de barras */}
          <button
            type="button"
            onClick={() => setShowScanner(!showScanner)}
            title={showScanner ? 'Cerrar escáner' : 'Escanear código de barras'}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all shrink-0 active:scale-95 ${
              showScanner
                ? 'bg-emerald-600 text-white shadow-md'
                : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
            }`}
          >
            <Barcode className="w-5 h-5" />
          </button>
        </div>

        {/* Visor de escáner embebido (Toggle) */}
        {showScanner && (
          <div className="pt-1 animate-in fade-in slide-in-from-top-2 duration-150">
            <CompactInlineScanner
              height={150}
              onScan={(code) => {
                setSearch(code);
                setShowScanner(false);
              }}
              onClose={() => setShowScanner(false)}
            />
          </div>
        )}

        {/* Category Pills */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          {categories.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                  isSelected
                    ? 'text-white shadow-xs'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
                style={{
                  backgroundColor: isSelected ? 'var(--brand-primary, #047857)' : undefined,
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {/* Product List */}
      <div className="p-3 divide-y divide-neutral-100">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-neutral-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="py-20 text-center text-neutral-400">
            <Package className="w-10 h-10 mx-auto mb-2 opacity-40 text-neutral-500" />
            <p className="text-xs font-bold text-neutral-600">No hay productos en esta categoría</p>
          </div>
        ) : (
          filteredProducts.map((p) => {
            const stock =
              p.stock && p.stock[branchId] !== undefined
                ? p.stock[branchId]
                : Object.values(p.stock || {})[0] || 0;
            const isOut = stock <= 0;
            const inCart = items.find((i) => i.id === p.id);

            return (
              <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-12 h-12 rounded-xl bg-neutral-100 border border-neutral-200/60 overflow-hidden flex items-center justify-center shrink-0">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <Package className="w-6 h-6 text-neutral-300" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-xs font-bold text-neutral-900 truncate">{p.name}</h4>
                    <p className="text-[10px] text-neutral-400 truncate">
                      {p.category} • {p.barcode || 'Sin código'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs font-black text-neutral-900">
                        S/ {p.price.toFixed(2)}
                      </span>
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.2 rounded-full ${
                          isOut ? 'bg-rose-100 text-rose-700' : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {stock} {p.unitOfMeasure || 'uds'}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => handleAdd(p)}
                  className={`h-9 px-3 rounded-xl font-bold text-xs flex items-center gap-1 active:scale-95 transition-all shadow-2xs ${
                    justAddedId === p.id
                      ? 'bg-emerald-600 text-white'
                      : inCart
                      ? 'bg-neutral-900 text-white'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  }`}
                >
                  {justAddedId === p.id ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" />
                      <span>{inCart ? inCart.quantity : 'Agregar'}</span>
                    </>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
