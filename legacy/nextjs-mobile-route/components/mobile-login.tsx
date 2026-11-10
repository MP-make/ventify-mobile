"use client";

import React, { useState } from 'react';
import { login, loginWithGoogle } from '@/services/auth-service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, Lock, Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
import Image from 'next/image';

export function MobileLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMessage('Por favor ingresa tu correo y contraseña.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      await login({ email: email.trim(), password });
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      console.error('Mobile login error:', error);

      if (
        error.code === 'auth/invalid-credential' ||
        error.code === 'auth/wrong-password' ||
        error.code === 'auth/user-not-found'
      ) {
        setErrorMessage('Correo o contraseña incorrectos.');
      } else if (error.code === 'auth/too-many-requests') {
        setErrorMessage('Demasiados intentos. Espera unos momentos antes de reintentar.');
      } else if (error.code === 'auth/network-request-failed') {
        setErrorMessage('Error de red. Verifica tu conexión a internet.');
      } else {
        setErrorMessage(error.message || 'No se pudo iniciar sesión. Verifica tus datos.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsGoogleLoading(true);
    setErrorMessage(null);
    try {
      await loginWithGoogle();
    } catch (err: unknown) {
      console.error('Google login error:', err);
      setErrorMessage('No se pudo iniciar sesión con Google.');
    } finally {
      setIsGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col justify-center px-5 py-8 antialiased">
      <div className="max-w-sm w-full mx-auto space-y-6">
        {/* Logo oficial y Encabezado de Ventify */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-white shadow-md border border-neutral-200/80 mb-1">
            <Image
              src="/ventify-icono.webp"
              alt="Ventify"
              width={56}
              height={56}
              className="object-contain"
              priority
            />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-neutral-900 flex items-center justify-center gap-1.5">
              <span>Ventify</span>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-neutral-900 text-white">POS</span>
            </h1>
            <p className="text-xs text-neutral-500 mt-1">
              Terminal de mostrador y ventas rápidas
            </p>
          </div>
        </div>

        {/* Tarjeta del Formulario */}
        <div className="bg-white border border-neutral-200/80 rounded-2xl p-6 shadow-xl shadow-neutral-200/50">
          <form onSubmit={handleSubmit} className="space-y-4">
            {errorMessage && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-red-700 text-xs animate-in fade-in">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                <span>{errorMessage}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-neutral-700">Correo Electrónico</Label>
              <div className="relative">
                <Mail className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ejemplo@tunegocio.com"
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={isLoading || isGoogleLoading}
                  className="pl-10 h-11 bg-white border-neutral-300 text-neutral-900 placeholder:text-neutral-400 rounded-xl focus:border-neutral-900 focus:ring-neutral-900/10 text-sm"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-neutral-700">Contraseña</Label>
              <div className="relative">
                <Lock className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={isLoading || isGoogleLoading}
                  className="pl-10 pr-10 h-11 bg-white border-neutral-300 text-neutral-900 placeholder:text-neutral-400 rounded-xl focus:border-neutral-900 focus:ring-neutral-900/10 text-sm"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700 p-1"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={isLoading || isGoogleLoading}
              className="w-full h-11 rounded-xl text-white font-semibold text-sm shadow-md transition-all duration-200 mt-2 flex items-center justify-center gap-2"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Iniciando sesión...</span>
                </>
              ) : (
                <span>Ingresar al POS</span>
              )}
            </Button>
          </form>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-neutral-200" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-neutral-400 text-[11px]">O continuar con</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={handleGoogleLogin}
            disabled={isLoading || isGoogleLoading}
            className="w-full h-11 rounded-xl border-neutral-200 hover:bg-neutral-50 text-neutral-700 font-medium text-xs flex items-center justify-center gap-2"
          >
            {isGoogleLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            )}
            <span>Continuar con Google</span>
          </Button>
        </div>

        {/* Footer */}
        <p className="text-center text-[11px] text-neutral-400">
          Tus datos y ventas se sincronizan en tiempo real con tu cuenta Ventify
        </p>
      </div>
    </div>
  );
}
