import type { CustomerData, OpenFiado } from '@/services/crm-operations-service';

export type OperationsTab = 'cash' | 'crm' | 'orders';

export interface VentyChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  isError?: boolean;
  timestamp: number;
}

export interface SalesBreakdown {
  cash: number;
  yape: number;
  plin: number;
  card: number;
  transfer: number;
  credit: number;
  totalDigital: number;
  totalAll: number;
  usingSessionFallback: boolean;
  counts: {
    cash: number;
    yape: number;
    plin: number;
    card: number;
    transfer: number;
    credit: number;
    total: number;
  };
}

export interface OperationsUserRef {
  uid: string;
  email?: string | null;
}

export interface OperationsUserProfileRef {
  displayName?: string | null;
}

export interface PaymentModalState {
  visible: boolean;
  customer: CustomerData | null;
  initialOpenFiados?: OpenFiado[];
  initialSelectedFiado?: OpenFiado | null;
}
