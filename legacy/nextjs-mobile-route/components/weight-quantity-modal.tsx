"use client";

import React, { useState } from 'react';
import { Product } from '@/types/product';
import { Scale, X, Check, Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface WeightQuantityModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (product: Product, quantity: number) => void;
}

export function WeightQuantityModal({
  product,
  isOpen,
  onClose,
  onConfirm,
}: WeightQuantityModalProps) {
  const [qtyString, setQtyString] = useState('1.000');

  if (!isOpen || !product) return null;

  const unitPrice = product.price || 0;
  const currentQty = parseFloat(qtyString) || 0;
  const subtotal = Math.round(currentQty * unitPrice * 100) / 100;

  const handleDigit = (digit: string) => {
    if (digit === '.' && qtyString.includes('.')) return;
    if (qtyString === '0' && digit !== '.') {
      setQtyString(digit);
      return;
    }
    setQtyString((prev) => (prev.length < 7 ? prev + digit : prev));
  };

  const handleDelete = () => {
    setQtyString((prev) => (prev.length > 1 ? prev.slice(0, -1) : '0'));
  };

  const handlePreset = (amount: number) => {
    setQtyString(amount.toFixed(3));
  };

  const handleConfirm = () => {
    if (currentQty > 0) {
      onConfirm(product, currentQty);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center select-none">
      <div className="w-full max-w-sm bg-white rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl animate-in slide-in-from-bottom duration-200">
        {/* Cabecera */}
        <div className="flex items-center justify-between pb-3 border-b border-neutral-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Scale className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-neutral-800 truncate max-w-[200px]">
                {product.name}
              </h3>
              <p className="text-[11px] text-neutral-500">
                S/ {unitPrice.toFixed(2)} por {product.unitOfMeasure || (product as any).unit || 'kg'}
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

        {/* Display del Peso / Cantidad */}
        <div className="bg-neutral-50 rounded-2xl p-4 my-3 text-center border border-neutral-100">
          <span className="text-3xl font-extrabold text-neutral-900 tracking-tight">
            {qtyString}
          </span>
          <span className="text-xs font-semibold text-neutral-500 ml-1.5 uppercase">
            {product.unitOfMeasure || (product as any).unit || 'KG'}
          </span>
          <div className="text-sm font-semibold text-emerald-600 mt-1">
            Total: S/ {subtotal.toFixed(2)}
          </div>
        </div>

        {/* Atajos rápidos de peso */}
        <div className="grid grid-cols-4 gap-1.5 mb-3">
          {[0.25, 0.5, 1.0, 2.0].map((preset) => (
            <button
              key={preset}
              onClick={() => handlePreset(preset)}
              className="py-1.5 text-xs font-medium bg-neutral-100 hover:bg-neutral-200 rounded-lg text-neutral-700 active:scale-95 transition-all"
            >
              {preset >= 1 ? `${preset} kg` : `${preset * 1000} g`}
            </button>
          ))}
        </div>

        {/* Teclado numérico */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'].map((d) => (
            <button
              key={d}
              onClick={() => handleDigit(d)}
              className="h-11 rounded-xl bg-neutral-100/80 active:bg-neutral-200 text-lg font-semibold text-neutral-800 flex items-center justify-center"
            >
              {d}
            </button>
          ))}
          <button
            onClick={handleDelete}
            className="h-11 rounded-xl bg-neutral-100/80 active:bg-neutral-200 text-neutral-600 flex items-center justify-center"
            aria-label="Borrar"
          >
            <Delete className="w-5 h-5" />
          </button>
        </div>

        {/* Botón confirmar */}
        <Button
          onClick={handleConfirm}
          disabled={currentQty <= 0}
          className="w-full h-12 text-sm font-semibold rounded-xl text-white shadow-md active:scale-98 transition-transform"
          style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
        >
          <Check className="w-4 h-4 mr-1.5" />
          Agregar S/ {subtotal.toFixed(2)} al Carrito
        </Button>
      </div>
    </div>
  );
}
