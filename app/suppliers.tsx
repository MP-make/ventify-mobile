import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';

import { PlanLockedView } from '@/components/PlanFeatureGate';
import { SuppliersPurchaseModal } from '@/components/SuppliersPurchaseModal';
import { usePlanFeatures } from '@/context/AuthContext';

export default function SuppliersScreen() {
  const router = useRouter();
  const { features, planName } = usePlanFeatures();

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  if (!features.purchases) {
    return (
      <PlanLockedView
        feature="purchases"
        asScreen
        screenTitle="Compras y Proveedores"
        onBack={handleClose}
        currentPlanName={planName}
      />
    );
  }

  return <SuppliersPurchaseModal visible onClose={handleClose} asScreen />;
}
