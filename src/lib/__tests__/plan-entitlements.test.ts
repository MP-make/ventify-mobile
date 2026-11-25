import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arePlanEntitlementsEqual,
  PLAN_FEATURE_METADATA,
  resolvePlanEntitlements,
  resolvePlanTier,
  resolveSunatInvoicingAccess,
} from '../plan-entitlements';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

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

  it('gates SUNAT invoicing on both plan entitlement and account invoicingEnabled flag', () => {
    expect(
      resolveSunatInvoicingAccess({
        planAllowsSunatInvoicing: false,
        invoicingEnabled: false,
      })
    ).toEqual({ allowed: false, lockReason: 'plan' });

    const emprendedorUnlimited = resolvePlanEntitlements({
      planId: '51cz55Fiphrj2rkFtEgJ',
      planName: 'Plan Emprendedor (Productos Ilimitados)',
      branchesMax: 1,
      usersMax: 2,
      productsMax: -1,
    });
    expect(
      resolveSunatInvoicingAccess({
        planAllowsSunatInvoicing: emprendedorUnlimited.features.sunatInvoicing,
        invoicingEnabled: false,
      })
    ).toEqual({ allowed: false, lockReason: 'account_disabled' });

    expect(
      resolveSunatInvoicingAccess({
        planAllowsSunatInvoicing: emprendedorUnlimited.features.sunatInvoicing,
        invoicingEnabled: true,
      })
    ).toEqual({ allowed: true, lockReason: null });

    expect(
      resolveSunatInvoicingAccess({
        planAllowsSunatInvoicing: false,
        invoicingEnabled: true,
      })
    ).toEqual({ allowed: false, lockReason: 'plan' });
  });

  describe('UI & Fabric regressions', () => {
    afterEach(() => {
      vi.resetModules();
      vi.doUnmock('@/lib/firebase');
      vi.doUnmock('firebase/firestore');
    });

    it('gates Facturación SUNAT in facturacion.tsx, ModuleLauncherModal, history.tsx, BusinessSettingsTab, and ProductFormModal via resolveSunatInvoicingAccess', () => {
      const files = [
        'app/facturacion.tsx',
        'src/components/ModuleLauncherModal.tsx',
        'app/(tabs)/history.tsx',
        'src/components/settings/BusinessSettingsTab.tsx',
        'src/components/ProductFormModal.tsx',
      ];
      for (const relPath of files) {
        const source = fs.readFileSync(path.join(WORKSPACE_ROOT, relPath), 'utf8');
        expect(source).toContain('resolveSunatInvoicingAccess');
        expect(source).toContain('invoicingEnabled');
      }

      const facturacionSource = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'app/facturacion.tsx'),
        'utf8'
      );
      expect(facturacionSource).toContain('lockReason="account_disabled"');
      expect(facturacionSource).toContain('!sunatAccess.allowed');
      expect(facturacionSource).toContain('waitingAccountConfig');
    });

    it('keeps PayrollUsersModal Fabric-safe with PayrollErrorBoundary, FlatList, collapsable={false}, and no SafeAreaView/pageSheet/FlashList', () => {
      const payrollSource = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'src/components/PayrollUsersModal.tsx'),
        'utf8'
      );
      const exportIdx = payrollSource.indexOf('export const PayrollUsersModal');
      expect(exportIdx).toBeGreaterThan(-1);
      const exportedBlock = payrollSource.slice(exportIdx);
      expect(exportedBlock).toContain('<PayrollErrorBoundary');
      expect(exportedBlock).toContain('<PayrollUsersContent');

      expect(payrollSource).toContain('transparent');
      expect(payrollSource).toContain('statusBarTranslucent');
      expect(payrollSource).toContain('collapsable={false}');
      expect(payrollSource).toContain('<FlatList');
      expect(payrollSource).toContain('styles.listFlex');
      expect(payrollSource).toContain('removeClippedSubviews={false}');
      expect(payrollSource).not.toContain('SafeAreaView');
      expect(payrollSource).not.toContain('presentationStyle="pageSheet"');
      expect(payrollSource).not.toContain('FlashList');
    });

    it('keeps ProductFormModal Fabric-safe without Android height keyboard shrinkage and gates IGV section by invoicingEnabled', () => {
      const modalSource = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'src/components/ProductFormModal.tsx'),
        'utf8'
      );
      const unitsTaxSource = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'src/components/product-form/UnitsTaxSection.tsx'),
        'utf8'
      );

      expect(unitsTaxSource).toContain('showTaxSection: boolean');
      expect(unitsTaxSource).toContain('{showTaxSection && (');
      expect(unitsTaxSource).toContain('Afectación IGV (SUNAT)');

      expect(modalSource).toContain('transparent');
      expect(modalSource).toContain('statusBarTranslucent');
      expect(modalSource).toContain('collapsable={false}');
      expect(modalSource).toContain("behavior={Platform.OS === 'ios' ? 'padding' : undefined}");
      expect(modalSource).not.toContain("behavior={Platform.OS === 'ios' ? 'padding' : 'height'}");
      expect(modalSource).toContain('showTaxSection={showTaxExemptionSection}');
    });

    it('keeps operations and history headers single-row with grey locked styles instead of Lock icons', () => {
      const opsStyles = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'src/components/operations/operationsStyles.ts'),
        'utf8'
      );
      const opsHeaderRowMatch = opsStyles.match(/compactHeaderRow:\s*\{[^}]*\}/);
      expect(opsHeaderRowMatch).not.toBeNull();
      expect(opsHeaderRowMatch![0]).toMatch(/flexDirection:\s*'row'/);
      expect(opsHeaderRowMatch![0]).toMatch(/justifyContent:\s*'space-between'/);
      expect(opsStyles).toContain('compactTeamButtonLocked');
      expect(opsStyles).toContain('compactTeamButtonTextLocked');

      const historyStyles = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'src/components/history/historyStyles.ts'),
        'utf8'
      );
      const historyHeaderRowMatch = historyStyles.match(/compactHeaderRow:\s*\{[^}]*\}/);
      expect(historyHeaderRowMatch).not.toBeNull();
      expect(historyHeaderRowMatch![0]).toMatch(/flexDirection:\s*'row'/);
      expect(historyHeaderRowMatch![0]).toMatch(/justifyContent:\s*'space-between'/);
      expect(historyStyles).toContain('compactButtonLocked');
      expect(historyStyles).toContain('compactButtonTextLocked');

      const opsSource = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'app/(tabs)/operations.tsx'),
        'utf8'
      );
      expect(opsSource).toContain('compactTeamButtonLocked');
      expect(opsSource).toContain('compactTeamButtonTextLocked');
      expect(opsSource).not.toContain('<Lock');

      const historySource = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'app/(tabs)/history.tsx'),
        'utf8'
      );
      const headerActionsSlice = historySource.slice(
        historySource.indexOf('styles.compactHeaderActions'),
        historySource.indexOf('tabSelectorRowCentered')
      );
      expect(headerActionsSlice).toContain('compactButtonLocked');
      expect(headerActionsSlice).toContain('compactButtonTextLocked');
      expect(headerActionsSlice).not.toContain('<Lock');
    });

    it('attaches subscribeToTeamMembers when AppState is inactive, active, or undefined, and skips background', async () => {
      vi.resetModules();

      const appStateObj: { currentState?: string; addEventListener: any } = {
        currentState: 'inactive',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      };

      const onSnapshotMock = vi.fn((_q: any, onNext: any) => {
        onNext({
          docs: [
            {
              id: 'user-1',
              data: () => ({
                accountId: 'acc-1',
                name: 'Ana Admin',
                email: 'ana@ventify.pe',
                role: 'admin',
                isActive: true,
              }),
            },
          ],
        });
        return vi.fn();
      });

      const NativeModule = require('module');
      const originalLoad = NativeModule._load;
      const loadSpy = vi
        .spyOn(NativeModule, '_load')
        .mockImplementation((request: unknown, ...args: unknown[]) => {
          if (request === 'react-native') {
            return { AppState: appStateObj };
          }
          return originalLoad.call(NativeModule, request, ...args);
        });

      try {
        vi.doMock('@/lib/firebase', () => ({
          db: { mocked: true },
          auth: {},
          APP_URL: 'https://example.com',
        }));
        vi.doMock('firebase/firestore', () => ({
          collection: vi.fn((_db: any, name: string) => ({ name })),
          doc: vi.fn(),
          addDoc: vi.fn(),
          setDoc: vi.fn(),
          getDoc: vi.fn(),
          getDocs: vi.fn(async () => ({ docs: [] })),
          updateDoc: vi.fn(),
          deleteDoc: vi.fn(),
          deleteField: vi.fn(),
          query: vi.fn((...parts: any[]) => ({ parts })),
          where: vi.fn((f: string, op: string, v: any) => ({ f, op, v })),
          orderBy: vi.fn((field: string, dir: string) => ({ field, dir })),
          limit: vi.fn((n: number) => ({ limit: n })),
          onSnapshot: onSnapshotMock,
          runTransaction: vi.fn(),
          serverTimestamp: () => 'ts',
        }));

        const { subscribeToTeamMembers } = await import('../../services/enterprise-ops-service');

        const cbInactive = vi.fn();
        const unsub1 = subscribeToTeamMembers('acc-1', cbInactive);
        expect(onSnapshotMock).toHaveBeenCalledTimes(1);
        expect(cbInactive).toHaveBeenCalledTimes(1);
        expect(cbInactive.mock.calls[0][0]).toHaveLength(1);
        unsub1();

        appStateObj.currentState = 'active';
        const cbActive = vi.fn();
        const unsub2 = subscribeToTeamMembers('acc-1', cbActive);
        expect(onSnapshotMock).toHaveBeenCalledTimes(2);
        unsub2();

        appStateObj.currentState = undefined;
        const cbUndef = vi.fn();
        const unsub3 = subscribeToTeamMembers('acc-1', cbUndef);
        expect(onSnapshotMock).toHaveBeenCalledTimes(3);
        unsub3();

        appStateObj.currentState = 'background';
        const cbBg = vi.fn();
        const unsub4 = subscribeToTeamMembers('acc-1', cbBg);
        expect(onSnapshotMock).toHaveBeenCalledTimes(3);
        unsub4();
      } finally {
        loadSpy.mockRestore();
      }
    });
  });
});
