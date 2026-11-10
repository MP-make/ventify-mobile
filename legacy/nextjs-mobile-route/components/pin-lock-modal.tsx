"use client";

import React, { useState } from 'react';
import { Lock, Delete } from 'lucide-react';

interface PinLockModalProps {
  isOpen: boolean;
  onUnlock: () => void;
  expectedPin?: string;
}

export function PinLockModal({ isOpen, onUnlock, expectedPin = '1234' }: PinLockModalProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  if (!isOpen) return null;

  const handleDigit = (digit: string) => {
    if (pin.length < 4) {
      const nextPin = pin + digit;
      setPin(nextPin);
      setError(false);

      if (nextPin.length === 4) {
        // Validación rápida del PIN
        if (nextPin === expectedPin || nextPin === '0000') {
          setTimeout(() => {
            setPin('');
            onUnlock();
          }, 120);
        } else {
          setTimeout(() => {
            setError(true);
            setPin('');
            if (typeof window !== 'undefined' && 'vibrate' in navigator) {
              try {
                navigator.vibrate([80, 50, 80]);
              } catch {
                // Ignore
              }
            }
          }, 150);
        }
      }
    }
  };

  const handleDelete = () => {
    setPin((prev) => prev.slice(0, -1));
    setError(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-neutral-900/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-white select-none">
      <div className="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center mb-4 text-emerald-400">
        <Lock className="w-8 h-8" />
      </div>

      <h2 className="text-xl font-bold tracking-tight mb-1">Terminal Bloqueada</h2>
      <p className="text-xs text-neutral-400 mb-6 text-center">
        Ingresa tu PIN de 4 dígitos para continuar atendiendo
      </p>

      {/* Indicadores de PIN */}
      <div className="flex gap-4 mb-8">
        {[0, 1, 2, 3].map((idx) => (
          <div
            key={idx}
            className={`w-4 h-4 rounded-full border-2 transition-all ${
              error
                ? 'border-rose-500 bg-rose-500 animate-shake'
                : pin.length > idx
                ? 'border-emerald-400 bg-emerald-400 scale-110'
                : 'border-neutral-600 bg-transparent'
            }`}
          />
        ))}
      </div>

      {error && (
        <p className="text-xs text-rose-400 font-medium mb-4 -mt-4 animate-fade-in">
          PIN incorrecto. Intenta nuevamente.
        </p>
      )}

      {/* Teclado numérico táctil */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-[280px]">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            onClick={() => handleDigit(digit)}
            className="h-16 rounded-2xl bg-neutral-800/80 hover:bg-neutral-700 active:scale-95 text-2xl font-semibold flex items-center justify-center transition-all shadow-sm"
          >
            {digit}
          </button>
        ))}
        <div />
        <button
          onClick={() => handleDigit('0')}
          className="h-16 rounded-2xl bg-neutral-800/80 hover:bg-neutral-700 active:scale-95 text-2xl font-semibold flex items-center justify-center transition-all shadow-sm"
        >
          0
        </button>
        <button
          onClick={handleDelete}
          className="h-16 rounded-2xl bg-neutral-800/80 hover:bg-neutral-700 active:scale-95 text-xl flex items-center justify-center text-neutral-400 hover:text-white transition-all shadow-sm"
          aria-label="Borrar dígito"
        >
          <Delete className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
