import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Info, X } from 'lucide-react';

export interface AlertModalProps {
  isOpen: boolean;
  type?: 'info' | 'warning' | 'error' | 'success' | 'confirm';
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export const AlertModal: React.FC<AlertModalProps> = ({
  isOpen,
  type = 'info',
  title,
  message,
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
  isDestructive = false,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  const isConfirmType = type === 'confirm' || !!onCancel;

  const renderIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle2 className="w-8 h-8 text-emerald-400" />;
      case 'warning':
        return <AlertTriangle className="w-8 h-8 text-amber-400" />;
      case 'error':
        return <AlertCircle className="w-8 h-8 text-rose-400" />;
      case 'confirm':
        return <HelpCircle className="w-8 h-8 text-indigo-400" />;
      case 'info':
      default:
        return <Info className="w-8 h-8 text-sky-400" />;
    }
  };

  const getIconBg = () => {
    switch (type) {
      case 'success':
        return 'bg-emerald-500/10 border-emerald-500/20';
      case 'warning':
        return 'bg-amber-500/10 border-amber-500/20';
      case 'error':
        return 'bg-rose-500/10 border-rose-500/20';
      case 'confirm':
        return 'bg-indigo-500/10 border-indigo-500/20';
      case 'info':
      default:
        return 'bg-sky-500/10 border-sky-500/20';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="relative w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl shadow-black/80 flex flex-col items-center text-center animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Icon Header */}
        <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center mb-4 shadow-inner ${getIconBg()}`}>
          {renderIcon()}
        </div>

        {/* Title */}
        <h3 className="text-lg font-bold text-white mb-2 leading-tight">
          {title}
        </h3>

        {/* Message */}
        <p className="text-sm text-slate-300 mb-6 leading-relaxed whitespace-pre-line">
          {message}
        </p>

        {/* Actions */}
        <div className="flex w-full gap-3">
          {isConfirmType && (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-3 px-4 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-750 text-slate-300 font-semibold text-sm transition-colors active:scale-[0.98]"
            >
              {cancelText}
            </button>
          )}

          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 py-3 px-4 rounded-xl font-bold text-sm shadow-lg transition-transform active:scale-[0.98] ${
              isDestructive
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/30'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
