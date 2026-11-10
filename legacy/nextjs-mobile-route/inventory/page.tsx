"use client";

import React, { useState, useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useProducts } from '@/hooks/products/use-products';
import { Product } from '@/types/product';
import { QuickStockModal } from '../components/quick-stock-modal';
import { ShootToScanModal } from '../components/shoot-to-scan-modal';
import { db } from '@/lib/firebase';
import { collection, addDoc } from 'firebase/firestore';
import {
  Package,
  Plus,
  Search,
  Camera,
  Zap,
  Check,
  X,
  Shuffle,
  Loader2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export default function MobileInventoryPage() {
  const authState = useAuth();
  const { userDoc, user } = authState;
  const { products, loading } = useProducts();
  const { toast } = useToast();

  const accountId = (authState.accountId || userDoc?.accountId || user?.accountId) as string | undefined;
  const branchId = userDoc?.branchId || 'main';

  // Filtros
  const [search, setSearch] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'low' | 'out'>('all');

  // Modales
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null);
  const [newProductModalOpen, setNewProductModalOpen] = useState(false);
  const [scannerForNewProduct, setScannerForNewProduct] = useState(false);

  // Formulario Nuevo Producto
  const [formData, setFormData] = useState({
    name: '',
    barcode: '',
    category: '',
    unit: 'unit',
    costPrice: '',
    price: '',
    currentStock: '1',
    minStock: '3',
  });
  const [savingProduct, setSavingProduct] = useState(false);

  // Métricas superiores
  const stats = useMemo(() => {
    let totalValuation = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    products.forEach((p) => {
      const stock = (p.stock && p.stock[branchId] !== undefined)
        ? p.stock[branchId]
        : (Object.values(p.stock || {})[0] || 0);

      const minStock = (p as any).minStock || 3;
      const cost = p.costPrice || 0;
      totalValuation += stock * cost;

      if (stock <= 0) {
        outOfStockCount++;
      } else if (stock <= minStock) {
        lowStockCount++;
      }
    });

    return {
      skuCount: products.length,
      valuation: totalValuation,
      lowStockCount,
      outOfStockCount,
    };
  }, [products, branchId]);

  // Filtrado de lista
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const stock = (p.stock && p.stock[branchId] !== undefined)
        ? p.stock[branchId]
        : (Object.values(p.stock || {})[0] || 0);

      const minStock = (p as any).minStock || 3;

      if (filterTab === 'low' && (stock <= 0 || stock > minStock)) return false;
      if (filterTab === 'out' && stock > 0) return false;

      if (!q) return true;
      return (
        p.name?.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q)
      );
    });
  }, [products, search, filterTab, branchId]);

  // Generar código aleatorio
  const generateRandomBarcode = () => {
    const randomCode = '775' + Math.floor(100000000 + Math.random() * 900000000).toString();
    setFormData((prev) => ({ ...prev, barcode: randomCode }));
  };

  // Guardar nuevo producto
  const handleSaveProduct = async () => {
    if (!formData.name.trim() || !formData.price || !accountId) {
      toast({
        title: "Campos requeridos",
        description: "El nombre y el precio de venta son obligatorios.",
        variant: "destructive",
      });
      return;
    }

    try {
      setSavingProduct(true);
      const stockNum = parseFloat(formData.currentStock) || 0;

      await addDoc(collection(db, 'products'), {
        name: formData.name.trim(),
        barcode: formData.barcode.trim(),
        category: formData.category.trim() || 'General',
        unit: formData.unit,
        costPrice: parseFloat(formData.costPrice) || 0,
        price: parseFloat(formData.price) || 0,
        minStock: parseFloat(formData.minStock) || 3,
        currentStock: stockNum,
        stock: { [branchId]: stockNum },
        branchIds: [branchId],
        accountId,
        createdAt: Date.now(),
      });

      toast({
        title: "Producto creado",
        description: `${formData.name} registrado en inventario.`,
      });

      setNewProductModalOpen(false);
      setFormData({
        name: '',
        barcode: '',
        category: '',
        unit: 'unit',
        costPrice: '',
        price: '',
        currentStock: '1',
        minStock: '3',
      });
    } catch (err: any) {
      console.error('[Inventory] Error guardando producto:', err);
      toast({
        title: "Error al guardar",
        description: err.message || "No se pudo registrar el producto.",
        variant: "destructive",
      });
    } finally {
      setSavingProduct(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full bg-white select-none">
      {/* 1. MÉTRICAS ENCABEZADO */}
      <div className="p-3 bg-neutral-900 text-white shadow-xs">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-neutral-800/80 p-2 rounded-xl">
            <span className="text-[10px] text-neutral-400 block font-medium">📦 SKUs</span>
            <span className="text-sm font-extrabold text-white">{stats.skuCount}</span>
          </div>
          <div className="bg-neutral-800/80 p-2 rounded-xl">
            <span className="text-[10px] text-neutral-400 block font-medium">💰 Valor Total</span>
            <span className="text-sm font-extrabold text-emerald-400">
              S/ {stats.valuation.toFixed(2)}
            </span>
          </div>
          <div className="bg-neutral-800/80 p-2 rounded-xl">
            <span className="text-[10px] text-neutral-400 block font-medium">⚠️ Reponer</span>
            <span className="text-sm font-extrabold text-amber-400">
              {stats.lowStockCount + stats.outOfStockCount}
            </span>
          </div>
        </div>

        {/* Botón Nuevo Producto */}
        <Button
          onClick={() => setNewProductModalOpen(true)}
          className="w-full h-10 mt-2.5 rounded-xl text-xs font-bold text-white shadow-md active:scale-98 transition-transform"
          style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
        >
          <Plus className="w-4 h-4 mr-1" />
          Nuevo Producto
        </Button>
      </div>

      {/* 2. BUSCADOR Y FILTROS RÁPIDOS */}
      <div className="p-3 bg-white sticky top-12 z-30 border-b border-neutral-100 space-y-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, código..."
            className="pl-9 pr-9 h-10 rounded-xl bg-neutral-50 border-neutral-200 text-xs focus:bg-white"
          />
          <button
            onClick={() => setScannerForNewProduct(true)}
            className="absolute right-2.5 top-2.5 text-neutral-500 hover:text-neutral-800"
            title="Escanear código para buscar"
          >
            <Camera className="w-5 h-5 text-neutral-600" />
          </button>
        </div>

        {/* Pills de Estado */}
        <div className="flex gap-2">
          {[
            { key: 'all', label: `Todos (${products.length})` },
            { key: 'low', label: `Stock Bajo (${stats.lowStockCount})` },
            { key: 'out', label: `Agotados (${stats.outOfStockCount})` },
          ].map((tab) => {
            const isSelected = filterTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setFilterTab(tab.key as any)}
                className={`flex-1 py-1 rounded-xl text-xs font-semibold transition-all ${
                  isSelected
                    ? 'bg-neutral-800 text-white shadow-xs'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. LISTA DE PRODUCTOS */}
      <div className="flex-1 p-3 divide-y divide-neutral-100">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-20 bg-neutral-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="py-16 text-center text-neutral-400">
            <Package className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="text-xs font-semibold text-neutral-600">No se encontraron productos</p>
          </div>
        ) : (
          filteredProducts.map((p) => {
            const stock = (p.stock && p.stock[branchId] !== undefined)
              ? p.stock[branchId]
              : (Object.values(p.stock || {})[0] || 0);

            const minStock = (p as any).minStock || 3;
            const isLow = stock > 0 && stock <= minStock;
            const isOut = stock <= 0;
            const unitLabel = p.unitOfMeasure || (p as any).unit || 'uds';

            return (
              <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                {/* Miniatura e Info */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div className="w-12 h-12 rounded-xl bg-neutral-100 border border-neutral-200 overflow-hidden flex items-center justify-center flex-shrink-0">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <Package className="w-6 h-6 text-neutral-300" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-bold text-neutral-900 truncate">{p.name}</h3>
                    <p className="text-[10px] text-neutral-400 truncate">
                      Barra: {p.barcode || 'Sin código'}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] font-semibold mt-0.5">
                      <span className="text-neutral-900">Venta: S/ {(p.price || p.suggestedPrice || 0).toFixed(2)}</span>
                      <span className="text-neutral-400">|</span>
                      <span className="text-neutral-500">Costo: S/ {(p.costPrice || 0).toFixed(2)}</span>
                    </div>
                  </div>
                </div>

                {/* Badge de Stock y Acciones */}
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      isOut
                        ? 'bg-rose-100 text-rose-700'
                        : isLow
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-emerald-100 text-emerald-800'
                    }`}
                  >
                    {stock} {unitLabel} {isOut ? '[Agotado]' : isLow ? '[Bajo]' : '[Normal]'}
                  </span>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAdjustingProduct(p)}
                      className="h-7 px-2 text-[11px] font-bold text-amber-700 border-amber-200 bg-amber-50/50 hover:bg-amber-100 rounded-lg flex items-center gap-1 active:scale-95"
                    >
                      <Zap className="w-3 h-3 fill-amber-500 text-amber-500" />
                      ⚡ Ajustar Stock
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal Ajuste Rápido de Stock en 3 Segundos */}
      <QuickStockModal
        product={adjustingProduct}
        branchId={branchId}
        isOpen={!!adjustingProduct}
        onClose={() => setAdjustingProduct(null)}
      />

      {/* Modal Nuevo Producto */}
      {newProductModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <h3 className="text-sm font-bold text-neutral-800">Nuevo Producto Mobile</h3>
              <button
                onClick={() => setNewProductModalOpen(false)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="text-[11px] font-bold text-neutral-600 block mb-1">Nombre</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Ej. Doritos 45g..."
                className="h-9 text-xs rounded-xl"
              />
            </div>

            {/* Código de barras con Escáner y Generador */}
            <div>
              <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                Código de Barras
              </label>
              <div className="flex gap-1.5">
                <Input
                  value={formData.barcode}
                  onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                  placeholder="775..."
                  className="h-9 text-xs rounded-xl flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={generateRandomBarcode}
                  className="h-9 px-2 text-[11px] rounded-xl"
                  title="Generar código automático"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">Categoría</label>
                <Input
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  placeholder="Snacks..."
                  className="h-9 text-xs rounded-xl"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">Unidad</label>
                <select
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  className="w-full h-9 rounded-xl border border-neutral-200 bg-white text-xs px-2"
                >
                  <option value="unit">Unidad (ud)</option>
                  <option value="kg">Kilos (kg)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                  Precio Costo
                </label>
                <Input
                  type="number"
                  step="0.10"
                  value={formData.costPrice}
                  onChange={(e) => setFormData({ ...formData, costPrice: e.target.value })}
                  placeholder="S/ 0.00"
                  className="h-9 text-xs rounded-xl"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                  Precio Venta
                </label>
                <Input
                  type="number"
                  step="0.10"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  placeholder="S/ 0.00"
                  className="h-9 text-xs rounded-xl font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                  Stock Inicial
                </label>
                <Input
                  type="number"
                  value={formData.currentStock}
                  onChange={(e) => setFormData({ ...formData, currentStock: e.target.value })}
                  className="h-9 text-xs rounded-xl"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-neutral-600 block mb-1">
                  Stock Mínimo
                </label>
                <Input
                  type="number"
                  value={formData.minStock}
                  onChange={(e) => setFormData({ ...formData, minStock: e.target.value })}
                  className="h-9 text-xs rounded-xl"
                />
              </div>
            </div>

            <Button
              onClick={handleSaveProduct}
              disabled={savingProduct}
              className="w-full h-11 text-xs font-bold rounded-xl text-white shadow-md mt-2"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              {savingProduct ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Check className="w-4 h-4 mr-1" />
              )}
              Guardar en Inventario
            </Button>
          </div>
        </div>
      )}

      {/* Escáner Shoot-to-Scan para búsqueda rápida */}
      <ShootToScanModal
        isOpen={scannerForNewProduct}
        onClose={() => setScannerForNewProduct(false)}
        autoCloseOnScan={true}
      />
    </div>
  );
}
