import React, { useState, useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { CompactInlineScanner } from '../components/CompactInlineScanner';
import { AlertModal } from '../components/AlertModal';
import {
  X,
  Camera,
  Shuffle,
  Loader2,
  Trash2,
  Image as ImageIcon,
  Check,
  Package,
} from 'lucide-react';

interface EditProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: any | null;
  branchId: string;
}

export const EditProductModal: React.FC<EditProductModalProps> = ({
  isOpen,
  onClose,
  product,
  branchId,
}) => {
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [category, setCategory] = useState('');
  const [price, setPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [minStock, setMinStock] = useState('3');
  const [imageUrl, setImageUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

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

  useEffect(() => {
    if (product && isOpen) {
      setName(product.name || '');
      setBarcode(product.barcode || product.sku || '');
      setCategory(product.category || '');
      setPrice(product.price ? product.price.toString() : '');
      setCostPrice(product.costPrice ? product.costPrice.toString() : '');
      setMinStock(product.minStock ? product.minStock.toString() : '3');
      setImageUrl(product.imageUrl || '');
    }
  }, [product, isOpen]);

  if (!isOpen || !product) return null;

  const handleImagePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImageUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const generateBarcode = () => {
    const code = '775' + Math.floor(100000000 + Math.random() * 900000000).toString();
    setBarcode(code);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !price) {
      showAlert({
        type: 'warning',
        title: 'Campos Requeridos',
        message: 'El nombre y precio son requeridos.',
      });
      return;
    }

    try {
      setIsSaving(true);
      const productRef = doc(db, 'products', product.id);
      await updateDoc(productRef, {
        name: name.trim(),
        barcode: barcode.trim(),
        category: category.trim() || 'General',
        price: parseFloat(price) || 0,
        costPrice: parseFloat(costPrice) || 0,
        minStock: parseInt(minStock, 10) || 3,
        imageUrl: imageUrl || null,
        updatedAt: Date.now(),
      });
      onClose();
    } catch (err: any) {
      console.error('[EditProduct] Error:', err);
      showAlert({
        type: 'error',
        title: 'Error al Guardar',
        message: 'Error guardando cambios: ' + (err.message || 'Error desconocido'),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in">
      <div className="bg-white rounded-3xl max-w-sm w-full p-5 max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-neutral-100 shrink-0">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-emerald-600" />
            <h3 className="text-sm font-black text-neutral-900">Editar Producto</h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500 hover:bg-neutral-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto py-3 space-y-3.5">
          {/* Visor de Escáner Embebido compacto (arriba de Foto del Producto) */}
          {scannerOpen && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-150">
              <CompactInlineScanner
                height={140}
                onScan={(code) => {
                  setBarcode(code);
                  setScannerOpen(false);
                }}
                onClose={() => setScannerOpen(false)}
              />
            </div>
          )}

          {/* Foto de Producto */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">
              Foto del Producto
            </label>
            <div className="flex items-center gap-3">
              <div className="relative w-20 h-20 rounded-2xl bg-neutral-100 border border-neutral-200 overflow-hidden flex items-center justify-center shrink-0">
                {imageUrl ? (
                  <>
                    <img src={imageUrl} alt="Foto" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setImageUrl('')}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <ImageIcon className="w-7 h-7 text-neutral-400" />
                )}
              </div>

              <div className="flex-1">
                <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-xs font-bold cursor-pointer active:scale-95 transition-all">
                  <Camera className="w-4 h-4 text-emerald-600" />
                  <span>{imageUrl ? 'Cambiar Foto' : 'Tomar / Subir'}</span>
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

          {/* Nombre */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">Nombre</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-bold text-neutral-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          {/* Código de Barras con botón Generar y botón Cámara */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">
              Código de Barras
            </label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="775..."
                className="flex-1 h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-mono font-bold text-neutral-900 focus:bg-white focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setScannerOpen(!scannerOpen)}
                title={scannerOpen ? 'Cerrar escáner' : 'Escanear código físico con la cámara'}
                className={`w-10 h-10 rounded-xl flex items-center justify-center active:scale-95 transition-all shrink-0 ${
                  scannerOpen
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
                className="w-10 h-10 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-700 flex items-center justify-center active:scale-95 transition-all shrink-0"
              >
                <Shuffle className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Categoría */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">Categoría</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Bebidas, Abarrotes, etc."
              className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Precios: Venta y Costo */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Precio Venta (S/)
              </label>
              <input
                type="number"
                step="0.10"
                required
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-bold text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-neutral-700 block mb-1">
                Precio Costo (S/)
              </label>
              <input
                type="number"
                step="0.10"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs text-neutral-900 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {/* Stock Mínimo */}
          <div>
            <label className="text-[11px] font-bold text-neutral-700 block mb-1">
              Stock Mínimo de Alerta
            </label>
            <input
              type="number"
              min="0"
              value={minStock}
              onChange={(e) => setMinStock(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-neutral-200 bg-neutral-50 text-xs font-bold text-neutral-900 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Botones de acción */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="flex-1 h-11 rounded-xl border border-neutral-200 text-xs font-bold text-neutral-600 hover:bg-neutral-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 h-11 rounded-xl text-white text-xs font-bold shadow-md flex items-center justify-center gap-1.5"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span>Guardar Cambios</span>
            </button>
          </div>
        </form>
      </div>

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

