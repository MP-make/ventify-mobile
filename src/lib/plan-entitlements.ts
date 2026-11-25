export type PlanTier = 'free' | 'emprendedor' | 'profesional' | 'plus' | 'unknown';

export type PlanFeatureKey =
  | 'multiBranch'
  | 'transfers'
  | 'teamManagement'
  | 'purchases'
  | 'sunatInvoicing'
  | 'aiAssistant'
  | 'advancedAnalytics';

export type PlanFeatureFlags = Record<PlanFeatureKey, boolean>;

export interface PlanEntitlements {
  tier: PlanTier;
  tierLabel: string;
  planName: string;
  isResolved: boolean;
  features: PlanFeatureFlags;
  limitsMax: {
    branches: number | null;
    users: number | null;
    products: number | null;
    aiMessages: number | null;
  };
}

export interface PlanFeatureMetadata {
  key: PlanFeatureKey;
  title: string;
  requiredTierLabel: string;
  shortBadge: string;
  description: string;
  highlights: string[];
  whatsappTopic: string;
}

export interface ResolvePlanTierInput {
  planId?: string | null;
  planName?: string | null;
  branchesMax?: number | null;
  usersMax?: number | null;
  productsMax?: number | null;
}

export interface ResolvePlanEntitlementsInput extends ResolvePlanTierInput {
  isSuperAdmin?: boolean;
  aiMessagesMax?: number | null;
}

const TIER_LABELS: Record<PlanTier, string> = {
  free: 'Plan Gratuito',
  emprendedor: 'Plan Emprendedor',
  profesional: 'Plan Profesional',
  plus: 'Plan Plus',
  unknown: 'Ventify POS',
};

const ALL_FEATURES_ENABLED: PlanFeatureFlags = {
  multiBranch: true,
  transfers: true,
  teamManagement: true,
  purchases: true,
  sunatInvoicing: true,
  aiAssistant: true,
  advancedAnalytics: true,
};

export const PLAN_FEATURE_METADATA: Record<PlanFeatureKey, PlanFeatureMetadata> = {
  multiBranch: {
    key: 'multiBranch',
    title: 'Multi-sucursal y Sedes',
    requiredTierLabel: 'Plan Profesional',
    shortBadge: 'Pro',
    description:
      'Administra múltiples locales o almacenes desde una sola cuenta y cambia de sede en segundos.',
    highlights: [
      'Crea y gestiona varias sucursales y almacenes',
      'Consulta métricas consolidadas de todas tus sedes',
      'Controla stock y personal asignado por tienda',
    ],
    whatsappTopic: 'activar Multi-sucursal y Sedes (Plan Profesional)',
  },
  transfers: {
    key: 'transfers',
    title: 'Transferencias entre Sucursales',
    requiredTierLabel: 'Plan Profesional',
    shortBadge: 'Pro',
    description:
      'Envía y recibe mercadería entre tus locales con trazabilidad completa en Kardex.',
    highlights: [
      'Solicita, aprueba y recibe envíos entre sedes',
      'Descuento y abono automático de inventario por sucursal',
      'Historial de traslados auditado por usuario',
    ],
    whatsappTopic: 'activar Transferencias entre sucursales (Plan Profesional)',
  },
  teamManagement: {
    key: 'teamManagement',
    title: 'Equipo y Planilla',
    requiredTierLabel: 'Plan Emprendedor',
    shortBadge: 'Emprendedor',
    description:
      'Agrega colaboradores con roles personalizados, permisos por sucursal y control de planilla.',
    highlights: [
      'Crea cuentas para cajeros, vendedores y administradores',
      'Registra adelantos y pagos de planilla desde caja',
      'Gestiona solicitudes de venta y permisos granulares',
    ],
    whatsappTopic: 'activar Equipo y más usuarios (Plan Emprendedor)',
  },
  purchases: {
    key: 'purchases',
    title: 'Compras y Proveedores',
    requiredTierLabel: 'Plan Emprendedor',
    shortBadge: 'Emprendedor',
    description:
      'Organiza tu cartera de proveedores, emite órdenes de compra y actualiza costos y stock al recibir.',
    highlights: [
      'Directorio de proveedores con RUC y contacto directo',
      'Órdenes de compra y recepción parcial o total al inventario',
      'Actualización automática de costos promedio y Kardex',
    ],
    whatsappTopic: 'activar Compras y Proveedores (Plan Emprendedor)',
  },
  sunatInvoicing: {
    key: 'sunatInvoicing',
    title: 'Facturación Electrónica SUNAT',
    requiredTierLabel: 'Plan Emprendedor',
    shortBadge: 'Emprendedor',
    description:
      'Emite boletas, facturas y notas de crédito electrónicas válidas ante SUNAT desde tu celular.',
    highlights: [
      'Envío automático de XML y descarga de constancia CDR',
      'Gestión de notas de crédito y reintentos ante SUNAT',
      'Exportación contable mensual lista para declaración',
    ],
    whatsappTopic: 'activar Facturación Electrónica SUNAT (Plan Emprendedor)',
  },
  aiAssistant: {
    key: 'aiAssistant',
    title: 'Asistente Venty IA',
    requiredTierLabel: 'Plan Profesional',
    shortBadge: 'Pro',
    description:
      'Pregunta en lenguaje natural sobre ventas, productos estrella, stock crítico y tendencias de tu negocio.',
    highlights: [
      'Respuestas instantáneas con datos reales de tus ventas',
      'Detección de productos sin rotación o por agotarse',
      'Recomendaciones prácticas para mejorar tu margen',
    ],
    whatsappTopic: 'activar Venty IA (Plan Profesional)',
  },
  advancedAnalytics: {
    key: 'advancedAnalytics',
    title: 'Dashboard KPIs y Reportes Avanzados',
    requiredTierLabel: 'Plan Profesional',
    shortBadge: 'Pro',
    description:
      'Visualiza márgenes reales, estado de resultados P&L, rendimiento por vendedor y exportaciones Excel/CSV.',
    highlights: [
      'Dashboard ejecutivo con tendencias e inteligencia de stock',
      'Estado de resultados (P&L) con márgenes netos y egresos',
      'Exportación profesional en CSV, Excel y PDF',
    ],
    whatsappTopic: 'activar Dashboard KPIs y Reportes Avanzados (Plan Profesional)',
  },
};

function normalizeMaxLimit(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function resolvePlanTier(input: ResolvePlanTierInput): PlanTier {
  const planId = typeof input.planId === 'string' ? input.planId.trim() : '';
  const planName = typeof input.planName === 'string' ? input.planName.trim() : '';
  const branchesMax = normalizeMaxLimit(input.branchesMax);
  const usersMax = normalizeMaxLimit(input.usersMax);
  const productsMax = normalizeMaxLimit(input.productsMax);

  if (
    !planId &&
    !planName &&
    branchesMax === null &&
    usersMax === null &&
    productsMax === null
  ) {
    return 'unknown';
  }

  const combined = `${planId} ${planName}`.trim();
  if (combined) {
    if (planId.toLowerCase() === 'free-plan' || /\bfree\b|gratuit|gratis/i.test(combined)) {
      return 'free';
    }
    // Check emprendedor before plus so custom names like "Emprendedor Plus" map to emprendedor.
    if (/emprendedor|starter|b[aá]sic/i.test(combined)) {
      return 'emprendedor';
    }
    if (/profe[s]?s?ional|\bpro\b|trial|maxperu|linatex|test-mp/i.test(combined)) {
      return 'profesional';
    }
    if (/\bplus\b|enterprise|empresarial/i.test(combined)) {
      return 'plus';
    }
  }

  if (
    (branchesMax !== null && (branchesMax < 0 || branchesMax >= 6)) ||
    (usersMax !== null && (usersMax < 0 || usersMax >= 10))
  ) {
    return 'plus';
  }
  if (branchesMax !== null && branchesMax > 1) {
    return 'profesional';
  }
  if (
    branchesMax === 1 &&
    usersMax === 1 &&
    productsMax !== null &&
    productsMax >= 0 &&
    productsMax <= 50
  ) {
    return 'free';
  }
  if (branchesMax === 1) {
    return 'emprendedor';
  }

  return 'unknown';
}

export function resolvePlanEntitlements(
  input: ResolvePlanEntitlementsInput
): PlanEntitlements {
  const isSuperAdmin = Boolean(input.isSuperAdmin);
  const branchesMax = normalizeMaxLimit(input.branchesMax);
  const usersMax = normalizeMaxLimit(input.usersMax);
  const productsMax = normalizeMaxLimit(input.productsMax);
  const aiMessagesMax = normalizeMaxLimit(input.aiMessagesMax);

  const tier = resolvePlanTier({
    planId: input.planId,
    planName: input.planName,
    branchesMax,
    usersMax,
    productsMax,
  });

  const cleanPlanName =
    typeof input.planName === 'string' && input.planName.trim().length > 0
      ? input.planName.trim()
      : TIER_LABELS[tier];

  const limitsMax = {
    branches: branchesMax,
    users: usersMax,
    products: productsMax,
    aiMessages: aiMessagesMax,
  };

  if (isSuperAdmin || tier === 'unknown') {
    return {
      tier,
      tierLabel: TIER_LABELS[tier],
      planName: cleanPlanName,
      isResolved: isSuperAdmin || tier !== 'unknown',
      features: { ...ALL_FEATURES_ENABLED },
      limitsMax,
    };
  }

  const isProOrPlus = tier === 'profesional' || tier === 'plus';
  const multiBranch =
    branchesMax !== null ? branchesMax < 0 || branchesMax > 1 : isProOrPlus;
  const teamManagement =
    usersMax !== null ? usersMax < 0 || usersMax > 1 : tier !== 'free';
  const aiAssistant =
    aiMessagesMax !== null ? aiMessagesMax < 0 || aiMessagesMax > 0 : isProOrPlus;

  return {
    tier,
    tierLabel: TIER_LABELS[tier],
    planName: cleanPlanName,
    isResolved: true,
    features: {
      multiBranch,
      transfers: multiBranch,
      teamManagement,
      purchases: tier !== 'free',
      sunatInvoicing: tier !== 'free',
      aiAssistant,
      advancedAnalytics: isProOrPlus,
    },
    limitsMax,
  };
}

export function arePlanEntitlementsEqual(
  a: PlanEntitlements,
  b: PlanEntitlements
): boolean {
  if (a === b) return true;
  return (
    a.tier === b.tier &&
    a.tierLabel === b.tierLabel &&
    a.planName === b.planName &&
    a.isResolved === b.isResolved &&
    a.limitsMax.branches === b.limitsMax.branches &&
    a.limitsMax.users === b.limitsMax.users &&
    a.limitsMax.products === b.limitsMax.products &&
    a.limitsMax.aiMessages === b.limitsMax.aiMessages &&
    a.features.multiBranch === b.features.multiBranch &&
    a.features.transfers === b.features.transfers &&
    a.features.teamManagement === b.features.teamManagement &&
    a.features.purchases === b.features.purchases &&
    a.features.sunatInvoicing === b.features.sunatInvoicing &&
    a.features.aiAssistant === b.features.aiAssistant &&
    a.features.advancedAnalytics === b.features.advancedAnalytics
  );
}

export const DEFAULT_PLAN_ENTITLEMENTS: PlanEntitlements = resolvePlanEntitlements({});
