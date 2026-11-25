import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import {
  Building2,
  Check,
  Crown,
  ExternalLink,
  Lock,
  RefreshCw,
  Save,
  Store,
  X,
} from 'lucide-react-native';

import { SectionHeading } from '@/components/ui';
import {
  usePlanFeatures,
  type PlanLimits,
  type PlanSubscription,
} from '@/context/AuthContext';
import { APP_URL } from '@/lib/firebase';
import { resolveSunatInvoicingAccess, type PlanFeatureKey } from '@/lib/plan-entitlements';
import type { AccountTaxProfile } from '@/lib/invoicing/receipt-amounts';
import { ui } from '@/lib/theme';
import type { Branch, BusinessSettings, PosSettings } from '@/types';

import { settingsStyles as styles } from './settingsStyles';

const SUBSCRIPTION_BADGE_MAP: Record<string, { label: string; bg: string; color: string }> = {
  active: { label: 'Activa', bg: ui.successSoft, color: ui.success },
  trialing: { label: 'Prueba Gratuita', bg: ui.primarySoft, color: ui.primary },
  paused: { label: 'Pausada', bg: ui.warningSoft, color: ui.warning },
  expired: { label: 'Vencida', bg: ui.dangerSoft, color: ui.danger },
  canceled: { label: 'Cancelada', bg: ui.dangerSoft, color: ui.danger },
  cancelled: { label: 'Cancelada', bg: ui.dangerSoft, color: ui.danger },
};

const PLAN_MODULE_CHIPS: Array<{ key: PlanFeatureKey; label: string }> = [
  { key: 'purchases', label: 'Compras' },
  { key: 'sunatInvoicing', label: 'Facturación SUNAT' },
  { key: 'advancedAnalytics', label: 'Reportes/KPIs' },
  { key: 'aiAssistant', label: 'Venty IA' },
  { key: 'multiBranch', label: 'Multi-sucursal' },
];

const planChipStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  text: {
    fontSize: 11,
    fontWeight: '700',
  },
});
const planChipsContainerStyle = planChipStyles.container;
const planChipStyle = planChipStyles.chip;
const planChipTextStyle = planChipStyles.text;

export interface BusinessSettingsTabProps {
  canManageSettings: boolean;
  hasAllBranchesAccess: boolean;
  branchId: string;
  branches: Branch[];
  activeBranchName: string;
  activeBranch: Branch | null;
  businessSettings: BusinessSettings;
  businessData: BusinessSettings;
  posSettings: PosSettings;
  taxProfile: AccountTaxProfile;
  invoicingEnabled: boolean;
  emitterInfo: {
    ruc?: string;
    razonSocial?: string;
    nombreComercial?: string;
    printedFormatResolution?: string | null;
  } | null;
  planLoading: boolean;
  planError: string | null;
  subscription: PlanSubscription | null;
  limits: PlanLimits | null;
  onRefreshPlan: () => void;
  onSelectBranch: (branchId: string) => void;
  updateBusinessData: (patch: Partial<BusinessSettings>) => Promise<void>;
  updatePosSettings: (patch: Partial<PosSettings>) => Promise<void>;
}

export const BusinessSettingsTab = React.memo<BusinessSettingsTabProps>(
  ({
    canManageSettings,
    hasAllBranchesAccess,
    branchId,
    branches,
    activeBranchName,
    activeBranch,
    businessSettings,
    businessData,
    posSettings,
    taxProfile,
    invoicingEnabled,
    emitterInfo,
    planLoading,
    planError,
    subscription,
    limits,
    onRefreshPlan,
    onSelectBranch,
    updateBusinessData,
    updatePosSettings,
  }) => {
    const { features } = usePlanFeatures();
    const [bizName, setBizName] = useState('');
    const [bizRuc, setBizRuc] = useState('');
    const [bizAddress, setBizAddress] = useState('');
    const [bizPhone, setBizPhone] = useState('');
    const [bizEmail, setBizEmail] = useState('');
    const [bizDescription, setBizDescription] = useState('');
    const [ticketFooter, setTicketFooter] = useState('');
    const [isAmazonExempt, setIsAmazonExempt] = useState(false);
    const [taxRateChoice, setTaxRateChoice] = useState<18 | 10>(18);
    const [enableMinSalePrice, setEnableMinSalePrice] = useState(true);
    const [enableQuickSale, setEnableQuickSale] = useState(true);
    const [enableSellerAttribution, setEnableSellerAttribution] = useState(false);
    const [requireSellerSelection, setRequireSellerSelection] = useState(false);
    const [ticketTemplate, setTicketTemplate] = useState<'standard' | 'compact'>('standard');
    const [isSavingBiz, setIsSavingBiz] = useState(false);
    const [branchModalVisible, setBranchModalVisible] = useState(false);

    useEffect(() => {
      if (!features.multiBranch && branchModalVisible) {
        setBranchModalVisible(false);
      }
    }, [features.multiBranch, branchModalVisible]);

    useEffect(() => {
      const biz = businessData || businessSettings;
      if (biz) {
        setBizName(biz.businessName || '');
        setBizRuc(biz.ruc || '');
        setBizAddress(biz.address || '');
        setBizPhone(biz.phone || '');
        setBizEmail(biz.email || '');
        setBizDescription(biz.description || '');
        setEnableMinSalePrice(biz.enableMinSalePrice !== false);
        setIsAmazonExempt(Boolean(biz.isAmazonExempt ?? taxProfile.isAmazonExempt));
        setTaxRateChoice(Number(biz.taxRate ?? taxProfile.taxRate) === 10 ? 10 : 18);
      }

      if (posSettings) {
        setTicketFooter(
          posSettings.ticketFooterMessage ||
            biz?.receiptFooter ||
            activeBranch?.receiptFooter ||
            ''
        );
        setEnableQuickSale(posSettings.enableQuickSale !== false);
        setEnableSellerAttribution(posSettings.enableSellerAttribution === true);
        setRequireSellerSelection(posSettings.requireSellerSelection === true);
        setTicketTemplate(posSettings.ticketTemplate === 'compact' ? 'compact' : 'standard');
      } else if (activeBranch?.receiptFooter) {
        setTicketFooter(activeBranch.receiptFooter);
      }
    }, [businessData, businessSettings, posSettings, activeBranch, taxProfile]);

    const openWebUrl = useCallback(async (path: string) => {
      const target = path.startsWith('http')
        ? path
        : `${APP_URL.replace(/\/$/, '')}${path}`;
      try {
        await Linking.openURL(target);
      } catch {
        Alert.alert('Error', 'No se pudo abrir el enlace externo.');
      }
    }, []);

    const handleSaveBusinessData = async () => {
      if (!canManageSettings) {
        Alert.alert(
          'Acceso Denegado',
          'Solo administradores o propietarios pueden modificar los datos fiscales y del POS.'
        );
        return;
      }

      if (!bizName.trim()) {
        Alert.alert('Nombre Requerido', 'La razón social no puede estar vacía.');
        return;
      }
      if (bizRuc.trim() && !/^\d{11}$/.test(bizRuc.trim())) {
        Alert.alert('RUC Inválido', 'El RUC debe tener exactamente 11 dígitos numéricos.');
        return;
      }

      setIsSavingBiz(true);
      try {
        await Promise.all([
          updateBusinessData({
            businessName: bizName.trim(),
            ruc: bizRuc.trim(),
            address: bizAddress.trim(),
            phone: bizPhone.trim(),
            email: bizEmail.trim(),
            description: bizDescription.trim(),
            receiptFooter: ticketFooter.trim(),
            enableMinSalePrice,
            isAmazonExempt,
            taxExemptionCode: isAmazonExempt ? '20' : '10',
            taxRate: isAmazonExempt ? 0 : taxRateChoice,
          }),
          updatePosSettings({
            ticketFooterMessage: ticketFooter.trim(),
            enableQuickSale,
            allowMixedPayment: posSettings?.allowMixedPayment !== false,
            enableSellerAttribution,
            requireSellerSelection: enableSellerAttribution ? requireSellerSelection : false,
            ticketTemplate,
          }),
        ]);

        Alert.alert(
          'Ajustes Guardados',
          'La información del negocio, pie de ticket y preferencias del POS han sido actualizados.'
        );
      } catch (err: any) {
        Alert.alert(
          'Error al Guardar',
          err?.message || 'No se pudieron actualizar los ajustes.'
        );
      } finally {
        setIsSavingBiz(false);
      }
    };

    const subStatusKey = String(subscription?.status || '').toLowerCase();
    const subBadge = SUBSCRIPTION_BADGE_MAP[subStatusKey] || {
      label: subscription?.status || 'Activo',
      bg: ui.primarySoft,
      color: ui.primary,
    };

    return (
      <>
        <SectionHeading title="Plan y Suscripción" subtitle="Estado de tu cuenta Ventify" />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
              <Crown size={22} color={ui.accent} />
            </View>
            <View style={styles.cardHeaderText}>
              <View style={styles.inlineRow}>
                <Text style={styles.cardTitle}>
                  {subscription?.planName || 'Plan Ventify POS'}
                </Text>
                <View style={[styles.pillBadge, { backgroundColor: subBadge.bg }]}>
                  <Text style={[styles.pillBadgeText, { color: subBadge.color }]}>
                    {subBadge.label}
                  </Text>
                </View>
              </View>
              <Text style={styles.cardSubtitle}>
                {planLoading
                  ? 'Consultando estado de suscripción...'
                  : subscription?.daysRemaining === -1
                    ? 'Suscripción sin límite de vigencia'
                    : typeof subscription?.daysRemaining === 'number'
                      ? `${subscription.daysRemaining} días restantes en el ciclo`
                      : planError || 'Sincronizado con Ventify Cloud'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onRefreshPlan}
              style={styles.iconActionBtn}
              accessibilityRole="button"
              accessibilityLabel="Actualizar estado del plan"
            >
              <RefreshCw size={18} color={ui.primary} />
            </TouchableOpacity>
          </View>

          {limits ? (
            <View style={styles.limitsGrid}>
              {limits.branches ? (
                <View style={styles.limitChip}>
                  <Text style={styles.limitLabel}>Sucursales</Text>
                  <Text style={styles.limitValue}>
                    {limits.branches.current} /{' '}
                    {limits.branches.max < 0 ? '∞' : limits.branches.max}
                  </Text>
                </View>
              ) : null}
              {limits.users ? (
                <View style={styles.limitChip}>
                  <Text style={styles.limitLabel}>Usuarios</Text>
                  <Text style={styles.limitValue}>
                    {limits.users.current} / {limits.users.max < 0 ? '∞' : limits.users.max}
                  </Text>
                </View>
              ) : null}
              {limits.products ? (
                <View style={styles.limitChip}>
                  <Text style={styles.limitLabel}>Productos</Text>
                  <Text style={styles.limitValue}>
                    {limits.products.current} /{' '}
                    {limits.products.max < 0 ? '∞' : limits.products.max}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={planChipsContainerStyle}>
            {PLAN_MODULE_CHIPS.map((mod) => {
              const enabled =
                mod.key === 'sunatInvoicing'
                  ? resolveSunatInvoicingAccess({
                      planAllowsSunatInvoicing: features.sunatInvoicing,
                      invoicingEnabled,
                    }).allowed
                  : features[mod.key];
              return (
                <View
                  key={mod.key}
                  style={[
                    planChipStyle,
                    {
                      backgroundColor: enabled ? ui.successSoft : ui.surfaceMuted,
                      borderColor: enabled ? ui.success : ui.border,
                    },
                  ]}
                >
                  {enabled ? (
                    <Check size={12} color={ui.success} />
                  ) : (
                    <Lock size={11} color={ui.textMuted} />
                  )}
                  <Text
                    style={[
                      planChipTextStyle,
                      { color: enabled ? ui.success : ui.textMuted },
                    ]}
                  >
                    {mod.label}
                  </Text>
                </View>
              );
            })}
          </View>

          <View style={styles.quickLinksRow}>
            <TouchableOpacity
              style={styles.quickLinkBtn}
              onPress={() => void openWebUrl('/settings')}
              accessibilityRole="button"
            >
              <ExternalLink size={15} color={ui.primary} />
              <Text style={styles.quickLinkText}>Panel Web</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickLinkBtn}
              onPress={() => void openWebUrl('/pricing')}
              accessibilityRole="button"
            >
              <Crown size={15} color={ui.primary} />
              <Text style={styles.quickLinkText}>Planes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickLinkBtn}
              onPress={() => void openWebUrl('https://wa.me/51983495868')}
              accessibilityRole="button"
            >
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M12 2C6.477 2 2 6.477 2 12c0 1.82.487 3.53 1.338 5.002L2 22l5.134-1.346A9.953 9.953 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"
                  fill="#25D366"
                />
                <Path
                  d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"
                  fill="#FFFFFF"
                />
              </Svg>
              <Text style={[styles.quickLinkText, { color: ui.success }]}>Soporte</Text>
            </TouchableOpacity>
          </View>
        </View>

        <SectionHeading title="Sucursal" subtitle="Sede operativa del terminal" />
        <View style={styles.card}>
          <View style={styles.settingRow}>
            <View style={styles.flex1}>
              <Text style={styles.settingLabel}>Sucursal Activa</Text>
              <Text style={styles.settingSubtext}>{activeBranchName || 'Tienda Principal'}</Text>
            </View>
            {features.multiBranch && hasAllBranchesAccess && branches.length > 1 ? (
              <TouchableOpacity
                style={styles.secondaryOutlineBtn}
                onPress={() => setBranchModalVisible(true)}
                accessibilityRole="button"
              >
                <Store size={16} color={ui.primary} />
                <Text style={styles.secondaryOutlineBtnText}>Cambiar</Text>
              </TouchableOpacity>
            ) : (
              <Store size={20} color={ui.textSecondary} />
            )}
          </View>
        </View>

        <SectionHeading
          title="Empresa e Impuestos"
          subtitle={
            canManageSettings
              ? 'Información tributaria, IGV y comprobantes'
              : 'Solo administradores pueden editar estos datos'
          }
        />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.primarySoft }]}>
              <Building2 size={22} color={ui.primary} />
            </View>
            <View style={styles.cardHeaderText}>
              <View style={styles.inlineRow}>
                <Text style={styles.cardTitle}>Datos Fiscales & Tickets</Text>
                {!canManageSettings ? (
                  <View style={[styles.pillBadge, { backgroundColor: ui.warningSoft }]}>
                    <Text style={[styles.pillBadgeText, { color: ui.warning }]}>Solo Lectura</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.cardSubtitle}>
                {invoicingEnabled
                  ? `SUNAT Electrónica Activa${emitterInfo?.ruc ? ` · RUC Emisor ${emitterInfo.ruc}` : ''}`
                  : 'Modo Notas de Venta y Cotizaciones'}
              </Text>
            </View>
          </View>

          {invoicingEnabled ? (
            <View style={styles.taxSummaryBox}>
              <Text style={styles.statusBoxLabel}>RÉGIMEN IGV ACTIVO</Text>
              <Text style={styles.statusBoxValue}>
                {taxProfile.isAmazonExempt
                  ? 'Amazonía Exonerada (Ley 27037 · IGV 0%)'
                  : `Régimen General Gravado · IGV ${taxProfile.taxRate}%`}
              </Text>
            </View>
          ) : null}

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Razón Social / Nombre Comercial *</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="Ej. Comercial Los Andes S.A.C."
              placeholderTextColor={ui.textMuted}
              value={bizName}
              onChangeText={setBizName}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>RUC (11 Dígitos)</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="20601234567"
              placeholderTextColor={ui.textMuted}
              keyboardType="numeric"
              maxLength={11}
              value={bizRuc}
              onChangeText={setBizRuc}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Dirección Fiscal</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="Av. Aviación 1234, La Victoria"
              placeholderTextColor={ui.textMuted}
              value={bizAddress}
              onChangeText={setBizAddress}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Teléfono / WhatsApp de Contacto</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="987654321"
              placeholderTextColor={ui.textMuted}
              keyboardType="phone-pad"
              value={bizPhone}
              onChangeText={setBizPhone}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Correo Electrónico</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="contacto@minegocio.com"
              placeholderTextColor={ui.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              value={bizEmail}
              onChangeText={setBizEmail}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Descripción / Lema en Ticket (Opcional)</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="Productos frescos todos los días"
              placeholderTextColor={ui.textMuted}
              value={bizDescription}
              onChangeText={setBizDescription}
              editable={canManageSettings}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Mensaje de Pie de Ticket</Text>
            <TextInput
              style={[
                styles.textInput,
                styles.textInputMultiline,
                !canManageSettings && styles.inputReadOnly,
              ]}
              placeholder="¡Gracias por su compra! Cambios dentro de 7 días con comprobante."
              placeholderTextColor={ui.textMuted}
              value={ticketFooter}
              onChangeText={setTicketFooter}
              multiline
              numberOfLines={2}
              editable={canManageSettings}
              accessibilityLabel="Mensaje de pie de ticket"
            />
          </View>

          {invoicingEnabled ? (
            <>
              <View style={styles.switchRow}>
                <View style={styles.flex1}>
                  <Text style={styles.switchTitle}>Exonerado Amazonía (Ley 27037)</Text>
                  <Text style={styles.switchSubtitle}>
                    Emite comprobantes con código tributario 20 (0% IGV)
                  </Text>
                </View>
                <Switch
                  value={isAmazonExempt}
                  onValueChange={setIsAmazonExempt}
                  disabled={!canManageSettings}
                  trackColor={{ false: ui.border, true: ui.primary }}
                />
              </View>

              {!isAmazonExempt ? (
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>Tasa de IGV</Text>
                  <View style={styles.segmentControl}>
                    <TouchableOpacity
                      style={[styles.segmentBtn, taxRateChoice === 18 && styles.segmentBtnActive]}
                      onPress={() => canManageSettings && setTaxRateChoice(18)}
                      disabled={!canManageSettings}
                    >
                      <Text
                        style={[styles.segmentText, taxRateChoice === 18 && styles.segmentTextActive]}
                      >
                        18% General
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.segmentBtn, taxRateChoice === 10 && styles.segmentBtnActive]}
                      onPress={() => canManageSettings && setTaxRateChoice(10)}
                      disabled={!canManageSettings}
                    >
                      <Text
                        style={[styles.segmentText, taxRateChoice === 10 && styles.segmentTextActive]}
                      >
                        10% MYPE
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
            </>
          ) : null}

          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Precio Mínimo Personalizado</Text>
              <Text style={styles.switchSubtitle}>
                Protege márgenes evitando ventas debajo del mínimo
              </Text>
            </View>
            <Switch
              value={enableMinSalePrice}
              onValueChange={setEnableMinSalePrice}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Venta Rápida en Efectivo</Text>
              <Text style={styles.switchSubtitle}>Permite cobrar monto exacto en un toque</Text>
            </View>
            <Switch
              value={enableQuickSale}
              onValueChange={setEnableQuickSale}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Asignar Vendedor al Cobrar</Text>
              <Text style={styles.switchSubtitle}>Muestra selector de asesor en el Checkout</Text>
            </View>
            <Switch
              value={enableSellerAttribution}
              onValueChange={(v) => {
                setEnableSellerAttribution(v);
                if (!v) setRequireSellerSelection(false);
              }}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          {enableSellerAttribution ? (
            <View style={styles.switchRow}>
              <View style={styles.flex1}>
                <Text style={styles.switchTitle}>Vendedor Obligatorio</Text>
                <Text style={styles.switchSubtitle}>
                  Exige elegir un vendedor antes de completar la venta
                </Text>
              </View>
              <Switch
                value={requireSellerSelection}
                onValueChange={setRequireSellerSelection}
                disabled={!canManageSettings}
                trackColor={{ false: ui.border, true: ui.primary }}
              />
            </View>
          ) : null}

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Plantilla de Ticket</Text>
            <View style={styles.segmentControl}>
              <TouchableOpacity
                style={[styles.segmentBtn, ticketTemplate === 'standard' && styles.segmentBtnActive]}
                onPress={() => canManageSettings && setTicketTemplate('standard')}
                disabled={!canManageSettings}
              >
                <Text
                  style={[
                    styles.segmentText,
                    ticketTemplate === 'standard' && styles.segmentTextActive,
                  ]}
                >
                  Estándar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentBtn, ticketTemplate === 'compact' && styles.segmentBtnActive]}
                onPress={() => canManageSettings && setTicketTemplate('compact')}
                disabled={!canManageSettings}
              >
                <Text
                  style={[
                    styles.segmentText,
                    ticketTemplate === 'compact' && styles.segmentTextActive,
                  ]}
                >
                  Compacto
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.saveButton, isSavingBiz && styles.buttonDisabled]}
              onPress={handleSaveBusinessData}
              disabled={isSavingBiz}
            >
              {isSavingBiz ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Save size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>Guardar Negocio y Tickets</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>

        {features.multiBranch && branchModalVisible && (
          <Modal
            visible={branchModalVisible}
            transparent
            animationType="fade"
            onRequestClose={() => setBranchModalVisible(false)}
          >
            <View style={styles.modalOverlay}>
              <SafeAreaView style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Cambiar Sucursal</Text>
                  <TouchableOpacity
                    onPress={() => setBranchModalVisible(false)}
                    style={styles.modalCloseButton}
                    accessibilityRole="button"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>
                <ScrollView style={{ maxHeight: 300 }}>
                  {branches.map((b) => {
                    const selected = b.id === branchId;
                    return (
                      <TouchableOpacity
                        key={b.id || b.name}
                        style={[styles.deviceItem, selected && styles.deviceItemSelected]}
                        onPress={() => {
                          if (b.id) {
                            onSelectBranch(b.id);
                          }
                          setBranchModalVisible(false);
                        }}
                      >
                        <View style={styles.flex1}>
                          <Text style={[styles.deviceName, selected && { color: ui.primary }]}>
                            {b.name}
                          </Text>
                          {b.address ? <Text style={styles.deviceAddress}>{b.address}</Text> : null}
                        </View>
                        {selected ? <Check size={18} color={ui.primary} /> : null}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </SafeAreaView>
            </View>
          </Modal>
        )}
      </>
    );
  }
);
