import { describe, expect, it } from 'vitest';
import {
  arePlanEntitlementsEqual,
  PLAN_FEATURE_METADATA,
  resolvePlanEntitlements,
  resolvePlanTier,
} from '../plan-entitlements';

describe('plan-entitlements', () => {
  it('resolves all 9 live Firestore plans accurately', () => {
    const free = resolvePlanEntitlements({
      planId: 'free-plan',
      planName: 'Plan Gratuito',
      branchesMax: 1,
      usersMax: 1,
      productsMax: 30,
      aiMessagesMax: 0,
    });
    expect(free.tier).toBe('free');
    expect(free.isResolved).toBe(true);
    expect(free.features).toEqual({
      multiBranch: false,
      transfers: false,
      teamManagement: false,
      purchases: false,
      sunatInvoicing: false,
      aiAssistant: false,
      advancedAnalytics: false,
    });

    const emprendedor = resolvePlanEntitlements({
      planId: 'emprendedor-monthly-pen',
      planName: 'Emprendedor',
      branchesMax: 1,
      usersMax: 2,
      productsMax: 500,
    });
    expect(emprendedor.tier).toBe('emprendedor');
    expect(emprendedor.features).toEqual({
      multiBranch: false,
      transfers: false,
      teamManagement: true,
      purchases: true,
      sunatInvoicing: true,
      aiAssistant: false,
      advancedAnalytics: false,
    });

    const emprendedorPlus = resolvePlanEntitlements({
      planId: 'ZeOmGgnBuI9HbY7poN68',
      planName: 'Emprendedor Plus',
      branchesMax: 1,
      usersMax: 2,
      productsMax: -1,
    });
    expect(emprendedorPlus.tier).toBe('emprendedor');
    expect(emprendedorPlus.features.multiBranch).toBe(false);
    expect(emprendedorPlus.features.purchases).toBe(true);
    expect(emprendedorPlus.features.advancedAnalytics).toBe(false);

    const emprendedorUnlimited = resolvePlanEntitlements({
      planId: '51cz55Fiphrj2rkFtEgJ',
      planName: 'Plan Emprendedor (Productos Ilimitados)',
      branchesMax: 1,
      usersMax: 2,
      productsMax: -1,
    });
    expect(emprendedorUnlimited.tier).toBe('emprendedor');
    expect(emprendedorUnlimited.features.sunatInvoicing).toBe(true);
    expect(emprendedorUnlimited.features.transfers).toBe(false);

    const profesional = resolvePlanEntitlements({
      planId: 'neBNeMIyXU6X42jsfFhK',
      planName: 'Profesional',
      branchesMax: 3,
      usersMax: 5,
      productsMax: -1,
      aiMessagesMax: -1,
    });
    expect(profesional.tier).toBe('profesional');
    expect(profesional.features).toEqual({
      multiBranch: true,
      transfers: true,
      teamManagement: true,
      purchases: true,
      sunatInvoicing: true,
      aiAssistant: true,
      advancedAnalytics: true,
    });

    const trialPro = resolvePlanEntitlements({
      planId: 'trial-pro-14',
      planName: 'Plan Pro (Prueba 14 días)',
      branchesMax: 3,
      usersMax: 5,
      productsMax: -1,
      aiMessagesMax: 100,
    });
    expect(trialPro.tier).toBe('profesional');
    expect(trialPro.features.aiAssistant).toBe(true);
    expect(trialPro.features.advancedAnalytics).toBe(true);

    const maxPeru = resolvePlanEntitlements({
      planId: 'Ct3RfgztKwMeBDEFf3Wa',
      planName: 'Plan MaxPeru',
      branchesMax: 2,
      usersMax: 4,
      productsMax: 500,
      aiMessagesMax: 500,
    });
    expect(maxPeru.tier).toBe('profesional');
    expect(maxPeru.features.multiBranch).toBe(true);
    expect(maxPeru.features.aiAssistant).toBe(true);

    const linatex = resolvePlanEntitlements({
      planId: 'JukRJFeptnuhRZmxqxrm',
      planName: 'Plan Linatex ',
      branchesMax: 3,
      usersMax: 7,
      productsMax: -1,
    });
    expect(linatex.tier).toBe('profesional');
    expect(linatex.planName).toBe('Plan Linatex');
    expect(linatex.features.multiBranch).toBe(true);
    expect(linatex.features.advancedAnalytics).toBe(true);

    const plus = resolvePlanEntitlements({
      planId: 'plus-monthly-pen',
      planName: 'Plus',
      branchesMax: -1,
      usersMax: 10,
      productsMax: -1,
      aiMessagesMax: -1,
    });
    expect(plus.tier).toBe('plus');
    expect(plus.features).toEqual({
      multiBranch: true,
      transfers: true,
      teamManagement: true,
      purchases: true,
      sunatInvoicing: true,
      aiAssistant: true,
      advancedAnalytics: true,
    });
  });

  it('honors backend numeric limit overrides over plan tier defaults', () => {
    const emprendedorWithAi = resolvePlanEntitlements({
      planId: 'emprendedor-monthly-pen',
      planName: 'Emprendedor',
      branchesMax: 2,
      usersMax: 2,
      aiMessagesMax: 50,
    });
    expect(emprendedorWithAi.tier).toBe('emprendedor');
    expect(emprendedorWithAi.features.aiAssistant).toBe(true);
    expect(emprendedorWithAi.features.multiBranch).toBe(true);
    expect(emprendedorWithAi.features.transfers).toBe(true);

    const proWithoutAi = resolvePlanEntitlements({
      planId: 'neBNeMIyXU6X42jsfFhK',
      planName: 'Profesional',
      branchesMax: 3,
      usersMax: 5,
      aiMessagesMax: 0,
    });
    expect(proWithoutAi.tier).toBe('profesional');
    expect(proWithoutAi.features.aiAssistant).toBe(false);
    expect(proWithoutAi.features.advancedAnalytics).toBe(true);
  });

  it('fails open for super admins and cold boot before plan resolution', () => {
    const unknownBoot = resolvePlanEntitlements({});
    expect(unknownBoot.tier).toBe('unknown');
    expect(unknownBoot.isResolved).toBe(false);
    expect(Object.values(unknownBoot.features).every(Boolean)).toBe(true);

    const superAdminFree = resolvePlanEntitlements({
      isSuperAdmin: true,
      planId: 'free-plan',
      planName: 'Plan Gratuito',
      branchesMax: 1,
      usersMax: 1,
      productsMax: 30,
      aiMessagesMax: 0,
    });
    expect(superAdminFree.tier).toBe('free');
    expect(superAdminFree.isResolved).toBe(true);
    expect(Object.values(superAdminFree.features).every(Boolean)).toBe(true);
  });

  it('falls back to numeric limits for unknown custom plan names and stabilizes equality', () => {
    expect(
      resolvePlanTier({
        planId: 'custom-vip-1',
        planName: 'Plan Especial Corporativo',
        branchesMax: 8,
        usersMax: 12,
      })
    ).toBe('plus');

    expect(
      resolvePlanTier({
        planId: 'custom-single-mini',
        planName: 'Plan Básico Mini',
        branchesMax: 1,
        usersMax: 1,
        productsMax: 25,
      })
    ).toBe('emprendedor'); // matches "básico" -> emprendedor

    expect(
      resolvePlanTier({
        planId: 'custom-trial-free-limits',
        planName: 'Plan X',
        branchesMax: 1,
        usersMax: 1,
        productsMax: 30,
      })
    ).toBe('free');

    expect(
      resolvePlanTier({
        planId: 'custom-zero-products',
        planName: 'Plan X',
        branchesMax: 1,
        usersMax: 1,
        productsMax: 0,
      })
    ).toBe('free');

    expect(resolvePlanTier({ planName: 'Plan Gratis' })).toBe('free');
    expect(resolvePlanTier({ planName: 'Professional Monthly' })).toBe('profesional');

    const a = resolvePlanEntitlements({
      planId: 'emprendedor-monthly-pen',
      planName: 'Emprendedor',
      branchesMax: 1,
      usersMax: 2,
      productsMax: 500,
    });
    const b = resolvePlanEntitlements({
      planId: 'emprendedor-monthly-pen',
      planName: 'Emprendedor',
      branchesMax: 1,
      usersMax: 2,
      productsMax: 500,
    });
    expect(arePlanEntitlementsEqual(a, b)).toBe(true);
    expect(Object.keys(PLAN_FEATURE_METADATA)).toHaveLength(7);
  });
});
