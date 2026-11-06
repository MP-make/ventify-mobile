import React, { useState } from 'react';
import { Lock, Delete, ShieldCheck } from 'lucide-react';

interface PinLockModalProps {
  isOpen: boolean;
  onUnlock: () => void;
  expectedPin?: string;
}

export const PinLockModal: React.FC<PinLockModalProps> = ({
  isOpen,
  onUnlock,
  expectedPin = '1234',
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  if (!isOpen) return null;

  const handleDigit = (digit: string) => {
    if (pin.length >= 4) return;
    const nextPin = pin + digit;
    setPin(nextPin);
    setError(false);

    if (nextPin.length === 4) {
      if (nextPin === expectedPin) {
        setTimeout(() => {
          setPin('');
          onUnlock();
        }, 150);
      } else {
        setTimeout(() => {
          setError(true);
          setPin('');
        }, 200);
      }
    }
  };

  const handleDelete = () => {
    setPin((prev) => prev.slice(0, -1));
    setError(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950/95 backdrop-blur-md flex flex-col items-center justify-between p-8 text-white select-none">
      <div className="w-full flex flex-col items-center mt-12 space-y-3">
        <div className="w-16 h-16 rounded-3xl bg-neutral-900 border border-neutral-800 flex items-center justify-center shadow-2xl">
          <Lock className="w-8 h-8 text-emerald-400" />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-black">Terminal Bloqueado</h2>
          <p className="text-xs text-neutral-400 mt-1">Ingresa el PIN de 4 dígitos para continuar</p>
        </div>

        {/* PIN Dots */}
        <div className="flex gap-4 pt-6">
          {[0, 1, 2, 3].map((index) => {
            const isFilled = pin.length > index;
            return (
              <div
                key={index}
                className={`w-4 h-4 rounded-full transition-all duration-200 ${
                  error
                    ? 'bg-rose-500 animate-shake scale-110'
                    : isFilled
                    ? 'bg-emerald-400 scale-125 shadow-lg shadow-emerald-400/50'
                    : 'bg-neutral-800 border border-neutral-700'
                }`}
              />
            );
          })}
        </div>

        {error && (
          <p className="text-xs font-semibold text-rose-400 animate-shake pt-1">
            PIN incorrecto. Intenta de nuevo.
          </p>
        )}
      </div>

      {/* Numeric Keypad */}
      <div className="w-full max-w-xs space-y-4 mb-8">
        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              onClick={() => handleDigit(digit)}
              className="h-16 rounded-2xl bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-700 border border-neutral-800/80 text-xl font-bold transition-transform active:scale-95 shadow-md"
            >
              {digit}
            </button>
          ))}
          <div className="flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-neutral-600" />
          </div>
          <button
            onClick={() => handleDigit('0')}
            className="h-16 rounded-2xl bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-700 border border-neutral-800/80 text-xl font-bold transition-transform active:scale-95 shadow-md"
          >
            0
          </button>
          <button
            onClick={handleDelete}
            className="h-16 rounded-2xl bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-700 border border-neutral-800/80 flex items-center justify-center text-neutral-400 active:scale-95 shadow-md"
          >
            <Delete className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
};
