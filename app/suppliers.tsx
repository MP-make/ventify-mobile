import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';

import { SuppliersPurchaseModal } from '@/components/SuppliersPurchaseModal';

export default function SuppliersScreen() {
  const router = useRouter();

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  return <SuppliersPurchaseModal visible onClose={handleClose} asScreen />;
}
