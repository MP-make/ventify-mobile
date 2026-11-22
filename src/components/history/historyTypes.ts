import { Sale } from '@/types';

export type HistoryTab = 'sales' | 'reservations' | 'ai';
export type DateRange = 'today' | 'week' | 'month' | 'custom' | 'all';
export type DocFilter = 'all' | 'factura' | 'boleta' | 'nota_venta';
export type HistorySale = Sale & { _dateMs?: number };

export interface PeriodKpis {
  totalSales: number;
  grossProfit: number;
  avgTicket: number;
  cashSales: number;
  digitalSales: number;
  cashPercent: number;
  digitalPercent: number;
  salesCount: number;
}

export const EMPTY_PERIOD_KPIS: PeriodKpis = {
  totalSales: 0,
  grossProfit: 0,
  avgTicket: 0,
  cashSales: 0,
  digitalSales: 0,
  cashPercent: 0,
  digitalPercent: 0,
  salesCount: 0,
};

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: number;
}

export const VENTY_ICON = require('../../../assets/venty-icon.webp');

export const AI_WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  sender: 'ai',
  text: '¡Hola! Soy Venty IA, tu asistente inteligente de negocio. Puedo ayudarte con métricas de ventas en tiempo real, control de gaveta de efectivo, productos críticos y cuentas de fiado. ¿Qué te gustaría consultar hoy?',
  timestamp: Date.now(),
};

export const AI_QUICK_CHIPS = [
  '¿Cuánto vendí hoy y cuál es mi ganancia?',
  '¿Qué productos están por agotarse?',
  '¿Cuánto efectivo debe haber en caja?',
  '¿Qué clientes tienen deuda de fiado?',
] as const;

export const isOfflinePendingSale = (sale: Sale | null | undefined): boolean =>
  Boolean(sale && ((sale as any).isOfflinePending || (sale as any).offlineQueued));
