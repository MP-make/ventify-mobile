"use client";

import React, { useState } from 'react';
import { Product } from '@/types/product';
import { Zap, X, Plus, Minus, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { db } from '@/lib/firebase';
import { doc, updateDoc, increment } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';

interface QuickStockModalProps {
  product: Product | null;
  branchId?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function QuickStockModal({
  product,
  branchId = 'main',
  isOpen,
  onClose,
  onSuccess,
}: QuickStockModalProps) {
  const [delta, setDelta] = useState<number>(0);
  const [mode, setMode] = useState<'add' | 'subtract'>('add');
  const [loading, setLoading] = useState(false);

  const { toast } = useToast();

  if (!isOpen || !product) return null;

  const currentStock = (product.stock && product.stock[branchId] !== undefined)
    ? product.stock[branchId]
    : (Object.values(product.stock || {})[0] || 0);

  const newStock = mode === 'add' ? currentStock + delta : Math.max(0, currentStock - delta);

  const handleApplyPreset = (value: number) => {
    setDelta((prev) => prev + value);
  };

  const handleSave = async () => {
    if (delta === 0) {
      onClose();
      return;
    }

    const adjustment = mode === 'add' ? delta : -delta;

    try {
      setLoading(true);
      const productRef = doc(db, 'products', product.id);

      // Actualizar campo stock de la sucursal de forma atómica
      await updateDoc(productRef, {
        [`stock.${branchId}`]: increment(adjustment),
      });

      toast({
        title: "Stock ajustado con éxito",
        description: `${product.name}: ${currentStock} ➔ ${newStock} unidades`,
      });

      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[QuickStockModal] Error ajustando stock:', err);
      toast({
        title: "Error al ajustar stock",
        description: err.message || "No se pudo actualizar el inventario.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center select-none">
      <div className="w-full max-w-sm bg-white rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl animate-in slide-in-from-bottom duration-200">
        {/* Cabecera */}
        <div className="flex items-center justify-between pb-3 border-b border-neutral-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center">
              <Zap className="w-4 h-4 fill-amber-500 text-amber-500" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-neutral-800 truncate max-w-[200px]">
                {product.name}
              </h3>
              <p className="text-[11px] text-neutral-500">
                Stock actual: <strong className="text-neutral-800">{currentStock}</strong> uds
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500 hover:text-neutral-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Selector de Modo (+ Sumar / - Restar) */}
        <div className="grid grid-cols-2 gap-2 my-3">
          <button
            onClick={() => setMode('add')}
            className={`py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              mode === 'add'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            Sumar Ingreso
          </button>
          <button
            onClick={() => setMode('subtract')}
            className={`py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              mode === 'subtract'
                ? 'bg-rose-600 text-white shadow-xs'
                : 'bg-neutral-100 text-neutral-600'
            }`}
          >
            <Minus className="w-3.5 h-3.5" />
            Restar / Merma
          </button>
        </div>

        {/* Display del Ajuste */}
        <div className="bg-neutral-50 rounded-2xl p-4 my-2 text-center border border-neutral-100">
          <span
            className={`text-3xl font-extrabold tracking-tight ${
              mode === 'add' ? 'text-emerald-600' : 'text-rose-600'
            }`}
          >
            {mode === 'add' ? `+${delta}` : `-${delta}`}
          </span>
          <div className="text-xs font-semibold text-neutral-600 mt-1">
            Nuevo stock resultante: <span className="font-bold text-neutral-900">{newStock} uds</span>
          </div>
        </div>

        {/* Pills rápidas (+1, +5, +10, +20) */}
        <div className="grid grid-cols-4 gap-1.5 my-3">
          {[1, 5, 10, 20].map((val) => (
            <button
              key={val}
              onClick={() => handleApplyPreset(val)}
              className="py-2 text-xs font-bold bg-neutral-100 hover:bg-neutral-200 rounded-lg text-neutral-800 active:scale-95 transition-all"
            >
              +{val}
            </button>
          ))}
        </div>

        {/* Botón Guardar */}
        <div className="flex gap-2 mt-4">
          <Button
            variant="outline"
            onClick={() => setDelta(0)}
            className="w-1/3 h-12 text-xs font-semibold rounded-xl"
          >
            Reiniciar
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading || delta === 0}
            className="flex-1 h-12 text-sm font-semibold rounded-xl text-white shadow-md active:scale-98 transition-transform"
            style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
            ) : (
              <Check className="w-4 h-4 mr-1.5" />
            )}
            Confirmar ({newStock} uds)
          </Button>
        </div>
      </div>
    </div>
  );
}
