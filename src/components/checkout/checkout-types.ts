import type { Customer } from '@/types';

export type CheckoutDocType = 'nota_venta' | 'boleta' | 'factura' | 'cotizacion';

export type ActivePaymentCategory =
  | 'cash'
  | 'yape'
  | 'plin'
  | 'card'
  | 'transfer'
  | 'mixed'
  | 'fiado'
  | 'credits';

export interface MixedSplitOption {
  key: string;
  methodId?: string;
  label: string;
  category: 'cash' | 'card' | 'digital';
  digitalProvider?: 'yape' | 'plin' | 'transferencia';
}

export interface MixedSplitRow {
  id: string;
  methodId?: string;
  category: 'cash' | 'card' | 'digital';
  digitalProvider?: 'yape' | 'plin' | 'transferencia';
  amountStr: string;
}

export interface PaymentOptionItem {
  method: any;
  id: string;
  label: string;
  category: ActivePaymentCategory;
  logo: any;
}

export interface CheckoutCustomerFormValues {
  name: string;
  dni: string;
  ruc: string;
  phone: string;
  address: string;
  selectedCustomer: Customer | null;
}

export const DEFAULT_MIXED_SPLIT_OPTIONS: MixedSplitOption[] = [
  { key: 'cash', label: 'Efectivo', category: 'cash' },
  { key: 'yape', label: 'Yape', category: 'digital', digitalProvider: 'yape' },
  { key: 'plin', label: 'Plin', category: 'digital', digitalProvider: 'plin' },
  { key: 'card', label: 'Tarjeta', category: 'card' },
];
