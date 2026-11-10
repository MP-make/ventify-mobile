import React, { useState, useMemo } from 'react';
import { useProducts } from '../context/ProductsContext';
import { useAuth } from '../context/AuthContext';
import { doc, updateDoc, addDoc, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { CompactInlineScanner } from '../components/CompactInlineScanner';
import { EditProductModal } from './EditProductModal';
import { AlertModal } from '../components/AlertModal';
import {
  Package,
  Plus,
  Search,
  SlidersHorizontal,
  Pencil,
  Check,
  X,
  Shuffle,
  Camera,
  Loader2,
  DollarSign,
  AlertCircle,
  Image as ImageIcon,
  Trash2,
  Barcode,
} from 'lucide-react';

export const InventoryView: React.FC = () => {
  const { products, stats, loading } = useProducts();
  const { accountId, branchId } = useAuth();

  const [search, setSearch] = useState('');
  const [searchScannerOpen, setSearchScannerOpen] = useState(false);
  const [filterTab, setFilterTab] = useState<'all' | 'low' | 'out'>('all');

  // Modal de alertas estilizado
  const [alertState, setAlertState] = useState<{
    isOpen: boolean;
    type?: 'info' | 'warning' | 'error' | 'success';
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const showAlert = (options: {
    title: string;
    message: string;
    type?: 'info' | 'warning' | 'error' | 'success';
    onConfirm?: () => void;
  }) => {
    setAlertState({
      isOpen: true,
      type: options.type || 'info',
      title: options.title,
      message: options.message,
      onConfirm: () => {
        setAlertState((prev) => ({ ...prev, isOpen: false }));
        if (options.onConfirm) options.onConfirm();
      },
    });
  };

  // Quick stock adjuster modal
  const [adjustingProduct, setAdjustingProduct] = useState<any | null>(null);
  const [newStockVal, setNewStockVal] = useState<number>(0);
  const [isSavingStock, setIsSavingStock] = useState(false);

  // Edit product modal
  const [editingProduct, setEditingProduct] = useState<any | null>(null);

  // New product modal
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [newProductScannerOpen, setNewProductScannerOpen] = useState(false);
  const [isCreatingProduct, setIsCreatingProduct] = useState(false);
  const [productImage, setProductImage] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    barcode: '',
    category: '',
    price: '',
    costPrice: '',
    stock: '1',
    minStock: '3',
    unit: 'unit',
  });

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const stock =
        p.stock && p.stock[branchId] !== undefined
          ? p.stock[branchId]
          : Object.values(p.stock || {})[0] || 0;
      const minStock = p.minStock || 3;

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

  const openStockModal = (product: any) => {
    const current =
      product.stock && product.stock[branchId] !== undefined
        ? product.stock[branchId]
        : Object.values(product.stock || {})[0] || 0;
    setNewStockVal(current);
    setAdjustingProduct(product);
  };

  const handleSaveStock = async () => {
    if (!adjustingProduct || isSavingStock) return;
    try {
      setIsSavingStock(true);
      const productRef = doc(db, 'products', adjustingProduct.id);
      await updateDoc(productRef, {
        [`stock.${branchId}`]: newStockVal,
      });
      setAdjustingProduct(null);
    } catch (err: any) {
      console.error('[Inventory] Error adjusting stock:', err);
      showAlert({
        type: 'error',
        title: 'Error de Stock',
        message: 'Error guardando stock: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsSavingStock(false);
    }
  };

  const generateBarcode = () => {
    const code = '775' + Math.floor(100000000 + Math.random() * 900000000).toString();
    setFormData((prev) => ({ ...prev, barcode: code }));
  };

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setProductImage(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.price || !accountId) {
      showAlert({
        type: 'warning',
        title: 'Campos Requeridos',
        message: 'El nombre y el precio de venta son requeridos.',
      });
      return;
    }

    try {
      setIsCreatingProduct(true);
      const newProd = {
        accountId,
        name: formData.name.trim(),
        barcode: formData.barcode.trim(),
        category: formData.category.trim() || 'General',
        price: parseFloat(formData.price) || 0,
        costPrice: parseFloat(formData.costPrice) || 0,
        minStock: parseInt(formData.minStock, 10) || 3,
        unitOfMeasure: formData.unit,
        imageUrl: productImage || null,
        stock: {
          [branchId]: parseInt(formData.stock, 10) || 0,
        },
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await addDoc(collection(db, 'products'), newProd);

      // Reset form
      setFormData({
        name: '',
        barcode: '',
        category: '',
        price: '',
        costPrice: '',
        stock: '1',
        minStock: '3',
        unit: 'unit',
      });
      setProductImage('');
      setNewProductOpen(false);
    } catch (err: any) {
      console.error('[Inventory] Error creating product:', err);
      showAlert({
        type: 'error',
        title: 'Error al Crear Producto',
        message: 'Error creando producto: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsCreatingProduct(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full bg-neutral-100 select-none pb-24">
      {/* 1. Header con Métricas (CERO EMOJIS) */}
      <div className="bg-neutral-900 text-white p-4 shadow-md space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-emerald-400" />
            <h2 className="text-sm font-black uppercase tracking-wider">Inventario & Stock</h2>
          </div>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300">
            {stats.skuCount} ítems
          </span>
        </div>

        {/* Métricas con iconos lineales de Lucide */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-neutral-800/90 p-2 rounded-2xl flex flex-col items-center justify-center">
            <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1">
              <Package className="w-3 h-3 text-neutral-400" />
              <span>SKUs</span>
            </span>
            <span className="text-sm font-black text-white mt-0.5">{stats.skuCount}</span>
          </div>

          <div className="bg-neutral-800/90 p-2 rounded-2xl flex flex-col items-center justify-center">
            <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1">
              <DollarSign className="w-3 h-3 text-emerald-400" />
              <span>Valor Total</span>
            </span>
            <span className="text-sm font-black text-emerald-400 mt-0.5">
              S/ {stats.valuation.toFixed(2)}
            </span>
          </div>

          <div className="bg-neutral-800/90 p-2 rounded-2xl flex flex-col items-center justify-center">
            <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1">
              <AlertCircle className="w-3 h-3 text-amber-400" />
              <span>Reponer</span>
            </span>
            <span className="text-sm font-black text-amber-400 mt-0.5">
              {stats.lowStockCount + stats.outOfStockCount}
            </span>
          </div>
        </div>

        <button
          onClick={() => setNewProductOpen(true)}
          className="w-full h-10 mt-1 rounded-xl text-xs font-bold text-white shadow-md active:scale-98 transition-transform flex items-center justify-center gap-1.5"
          style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
        >
          <Plus className="w-4 h-4" />
          <span>Nuevo Producto</span>
        </button>
      </div>

      {/* 2. Buscador y Filtros */}
      <div className="p-3 bg-white border-b border-neutral-100 sticky top-0 z-30 space-y-2 shadow-2xs">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, código o SKU..."
              className="w-full h-10 pl-9 pr-9 rounded-xl bg-neutral-100 border border-neutral-200 text-xs text-neutral-800 placeholder:text-neutral-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-2.5 text-neutral-400 hover:text-neutral-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSearchScannerOpen(!searchScannerOpen)}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all shrink-0 ${
              searchScannerOpen
                ? 'bg-rose-500 text-white shadow-md'
                : 'bg-neutral-900 text-white shadow-xs active:scale-95'
            }`}
            title="Escanear código para filtrar inventario"
          >
            {searchScannerOpen ? <X className="w-5 h-5" /> : <Barcode className="w-5 h-5" />}
          </button>
        </div>

        {/* Visor de escáner inline compacto */}
        {searchScannerOpen && (
          <div className="mb-1">
            <CompactInlineScanner
              height={140}
              onScan={(scannedCode) => {
                setSearch(scannedCode);
                setSearchScannerOpen(false);
              }}
              onClose={() => setSearchScannerOpen(false)}
            />
          </div>
        )}

        {/* Tabs de Filtro */}
        <div className="flex gap-1.5">
          <button
            onClick={() => setFilterTab('all')}
            className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-all ${
              filterTab === 'all'
                ? 'bg-neutral-900 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            Todos ({products.length})
          </button>
          <button
            onClick={() => setFilterTab('low')}
            className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-all ${
              filterTab === 'low'
                ? 'bg-amber-500 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            Por Agotar ({stats.lowStockCount})
          </button>
          <button
            onClick={() => setFilterTab('out')}
            className={`flex-1 py-1.5 rounded-xl text-xs font-bold transition-all ${
              filterTab === 'out'
                ? 'bg-rose-500 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            Agotados ({stats.outOfStockCount})
          </button>
        </div>
      </div>

      {/* 3. Listado de Productos */}
      <div className="p-3 space-y-2 flex-1">
        {loading ? (
          <div className="py-16 text-center text-xs text-neutral-400 font-bold flex flex-col items-center gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
            <span>Cargando inventario...</span>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="py-16 text-center text-xs text-neutral-400 font-medium">
            No se encontraron productos coincidentes.
          </div>
        ) : (
          filteredProducts.map((p) => {
            const stock =
              p.stock && p.stock[branchId] !== undefined
                ? p.stock[branchId]
                : Object.values(p.stock || {})[0] || 0;
            const minStock = p.minStock || 3;
            const isLow = stock > 0 && stock <= minStock;
            const isOut = stock <= 0;

            return (
              <div
                key={p.id}
                className="bg-white border border-neutral-200/90 rounded-2xl p-3 shadow-2xs space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-black text-neutral-900 truncate">{p.name}</h3>
                    <p className="text-[10px] text-neutral-400 font-mono mt-0.5">
                      {p.barcode ? `Barra: ${p.barcode}` : p.sku ? `SKU: ${p.sku}` : 'Sin código'}
                    </p>
                  </div>

                  {/* Badge de Stock */}
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-black shrink-0 ${
                      isOut
                        ? 'bg-rose-100 text-rose-800'
                        : isLow
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-emerald-100 text-emerald-800'
                    }`}
                  >
                    {stock} {p.unitOfMeasure || 'unit'}
                  </span>
                </div>

                <div className="pt-2 border-t border-neutral-100 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-neutral-700">
                      Venta: S/ {Number(p.price || 0).toFixed(2)}
                    </span>
                    {p.costPrice ? (
                      <span className="text-[10px] text-neutral-400">
                        Costo: S/ {Number(p.costPrice).toFixed(2)}
                      </span>
                    ) : null}
                  </div>

                  {/* Acciones: Editar + Ajustar */}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setEditingProduct(p)}
                      className="px-2.5 py-1 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-[11px] font-bold active:scale-95 transition-all flex items-center gap-1"
                    >
                      <Pencil className="w-3 h-3 text-neutral-600" />
                      <span>Editar</span>
                    </button>

                    <button
                      onClick={() => openStockModal(p)}
                      className="px-2.5 py-1 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-[11px] font-bold active:scale-95 transition-all flex items-center gap-1"
                    >
                      <SlidersHorizontal className="w-3 h-3 text-amber-600" />
                      <span>Ajustar</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 4. MODAL RÁPIDO PARA AJUSTAR STOCK */}
      {adjustingProduct && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-xs w-full p-5 space-y-4 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="w-4 h-4 text-amber-600" />
                <h3 className="text-sm font-black text-neutral-900">Ajustar Stock</h3>
              </div>
              <button
                onClick={() => setAdjustingProduct(null)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-bold text-neutral-800 truncate">
                {adjustingProduct.name}
              </p>
              <p className="text-[10px] text-neutral-400">
                Sucursal: {branchId ? 'Activa' : 'Principal'}
              </p>
            </div>

            <div className="flex items-center justify-center gap-3 py-2">
              <button
                onClick={() => setNewStockVal(Math.max(0, newStockVal - 1))}
                className="w-10 h-10 rounded-2xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-lg font-black active:scale-95"
              >
                -1
              </button>
              <input
                type="number"
                min="0"
                value={newStockVal}
                onChange={(e) => setNewStockVal(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-20 h-12 text-center text-xl font-black rounded-2xl border border-neutral-300 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
              />
              <button
                onClick={() => setNewStockVal(newStockVal + 1)}
                className="w-10 h-10 rounded-2xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-lg font-black active:scale-95"
              >
                +1
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setNewStockVal(newStockVal + 5)}
                className="flex-1 py-1.5 rounded-xl bg-neutral-50 border border-neutral-200 text-xs font-bold text-neutral-600 active:scale-95"
              >
                +5
              </button>
              <button
                onClick={() => setNewStockVal(newStockVal + 10)}
                className="flex-1 py-1.5 rounded-xl bg-neutral-50 border border-neutral-200 text-xs font-bold text-neutral-600 active:scale-95"
              >
                +10
              </button>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setAdjustingProduct(null)}
                disabled={isSavingStock}
                className="flex-1 h-10 rounded-xl border border-neutral-200 text-xs font-bold text-neutral-600 hover:bg-neutral-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSaveStock}
                disabled={isSavingStock}
                className="flex-1 h-10 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold shadow-md flex items-center justify-center gap-1.5"
              >
                {isSavingStock ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                <span>Guardar</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. MODAL NUEVO PRODUCTO (CON FOTO Y ESCÁNER DE CÓDIGO) */}
      {newProductOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-sm w-full p-5 max-h-[90vh] flex flex-col shadow-2xl animate-in fade-in">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-100 shrink-0">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-emerald-600" />
                <h3 className="text-sm font-black text-neutral-900">Nuevo Producto</h3>
              </div>
              <button
                onClick={() => setNewProductOpen(false)}
                className="w-7 h-7 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProduct} className="flex-1 overflow-y-auto py-3 space-y-3">
              {/* Visor de Escáner Embebido compacto (arriba de Foto del Producto) */}
              {newProductScannerOpen && (
                <div className="animate-in fade-in slide-in-from-top-2 duration-150">
                  <CompactInlineScanner
                    height={140}
                    onScan={(code) => {
                      setFormData((prev) => ({ ...prev, barcode: code }));
                      setNewProductScannerOpen(false);
                    }}
                    onClose={() => setNewProductScannerOpen(false)}
                  />
                </div>
              )}

              {/* Recuadro para tomar foto */}
              <div>
                <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                  Foto del Producto
                </label>
                <div className="flex items-center gap-3">
                  <div className="relative w-16 h-16 rounded-2xl bg-neutral-100 border border-neutral-200 overflow-hidden flex items-center justify-center shrink-0">
                    {productImage ? (
                      <>
                        <img src={productImage} alt="Foto" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setProductImage('')}
                          className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </>
                    ) : (
                      <ImageIcon className="w-6 h-6 text-neutral-400" />
                    )}
                  </div>
                  <div>
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-bold cursor-pointer active:scale-95 transition-all">
                      <Camera className="w-4 h-4 text-emerald-600" />
                      <span>{productImage ? 'Cambiar Foto' : 'Tomar / Subir'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handleImagePick}
                        className="hidden"
                      />
                    </label>
                    <p className="text-[10px] text-neutral-400 mt-1">Cámara o Galería</p>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700 block mb-1">Nombre</label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Gaseosa Inca Kola 500ml"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                  Código de Barras
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    placeholder="775..."
                    value={formData.barcode}
                    onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                    className="flex-1 h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-mono font-bold text-neutral-900 focus:bg-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setNewProductScannerOpen(!newProductScannerOpen)}
                    title={newProductScannerOpen ? 'Cerrar escáner' : 'Escanear código físico con la cámara'}
                    className={`w-9 h-9 rounded-xl flex items-center justify-center active:scale-95 transition-all shrink-0 ${
                      newProductScannerOpen
                        ? 'bg-emerald-600 text-white shadow-md'
                        : 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700'
                    }`}
                  >
                    <Camera className="w-4 h-4 text-emerald-600" />
                  </button>
                  <button
                    type="button"
                    onClick={generateBarcode}
                    title="Generar código aleatorio"
                    className="w-9 h-9 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all shrink-0"
                  >
                    <Shuffle className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                    Categoría
                  </label>
                  <input
                    type="text"
                    placeholder="Bebidas..."
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">Unidad</label>
                  <select
                    value={formData.unit}
                    onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                    className="w-full h-9 px-2 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
                  >
                    <option value="unit">Unidad (ud)</option>
                    <option value="kg">Kilogramo (kg)</option>
                    <option value="pack">Paquete (pack)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                    Precio Venta (S/)
                  </label>
                  <input
                    type="number"
                    step="0.10"
                    required
                    placeholder="0.00"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-bold text-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                    Precio Costo (S/)
                  </label>
                  <input
                    type="number"
                    step="0.10"
                    placeholder="0.00"
                    value={formData.costPrice}
                    onChange={(e) => setFormData({ ...formData, costPrice: e.target.value })}
                    className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                    Stock Inicial
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.stock}
                    onChange={(e) => setFormData({ ...formData, stock: e.target.value })}
                    className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                    Stock Mínimo
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.minStock}
                    onChange={(e) => setFormData({ ...formData, minStock: e.target.value })}
                    className="w-full h-9 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isCreatingProduct}
                  className="w-full h-11 rounded-xl text-white text-xs font-bold shadow-md flex items-center justify-center gap-1.5"
                  style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                >
                  {isCreatingProduct ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  <span>Registrar Producto</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Editar Producto */}
      <EditProductModal
        isOpen={Boolean(editingProduct)}
        onClose={() => setEditingProduct(null)}
        product={editingProduct}
        branchId={branchId}
      />

      {/* MODAL DE ALERTAS ESTILIZADO */}
      <AlertModal
        isOpen={alertState.isOpen}
        type={alertState.type}
        title={alertState.title}
        message={alertState.message}
        onConfirm={alertState.onConfirm}
      />
    </div>
  );
};
