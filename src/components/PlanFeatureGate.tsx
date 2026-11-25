import React, { useCallback } from 'react';
import {
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  CheckCircle2,
  Crown,
  ExternalLink,
  Lock,
  MessageCircle,
  X,
} from 'lucide-react-native';
import { APP_URL } from '@/lib/env';
import {
  PLAN_FEATURE_METADATA,
  type FeatureLockReason,
  type PlanFeatureKey,
} from '@/lib/plan-entitlements';
import { ui } from '@/lib/theme';

const WHATSAPP_BASE_URL = 'https://wa.me/51983495868';
const stopResponder = () => true;

export interface PlanLockedViewProps {
  feature: PlanFeatureKey;
  lockReason?: FeatureLockReason;
  currentPlanName?: string;
  asScreen?: boolean;
  screenTitle?: string;
  onBack?: () => void;
  compact?: boolean;
}

export const PlanLockedView = React.memo<PlanLockedViewProps>(
  ({
    feature,
    lockReason = 'plan',
    currentPlanName,
    asScreen = false,
    screenTitle,
    onBack,
    compact = false,
  }) => {
    const meta = PLAN_FEATURE_METADATA[feature];
    const isAccountDisabled = lockReason === 'account_disabled';
    const description =
      isAccountDisabled && feature === 'sunatInvoicing'
        ? 'La facturación electrónica SUNAT está desactivada en tu cuenta actual. Solicita su activación con el equipo de Ventify para emitir boletas, facturas y notas electrónicas.'
        : meta.description;

    const handleOpenPricing = useCallback(async () => {
      const target = `${APP_URL.replace(/\/$/, '')}/pricing`;
      try {
        await Linking.openURL(target);
      } catch {
        Alert.alert('Error', 'No se pudo abrir la página de planes.');
      }
    }, []);

    const handleOpenWhatsApp = useCallback(async () => {
      const topic = isAccountDisabled ? `activar ${meta.title} en mi cuenta` : meta.whatsappTopic;
      const text = encodeURIComponent(
        `Hola equipo Ventify, quiero ${topic}. Actualmente estoy en ${currentPlanName || 'mi plan actual'}.`
      );
      const target = `${WHATSAPP_BASE_URL}?text=${text}`;
      try {
        await Linking.openURL(target);
      } catch {
        Alert.alert('Error', 'No se pudo abrir WhatsApp.');
      }
    }, [isAccountDisabled, meta.title, meta.whatsappTopic, currentPlanName]);

    const body = (
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          compact && styles.scrollContentCompact,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.card, compact && styles.cardCompact]}>
          <View style={styles.badgeRow}>
            <View style={styles.requiredBadge}>
              {isAccountDisabled ? (
                <Lock size={13} color={ui.accent} />
              ) : (
                <Crown size={13} color={ui.accent} />
              )}
              <Text style={styles.requiredBadgeText}>
                {isAccountDisabled
                  ? 'Desactivada en tu cuenta'
                  : `Disponible en ${meta.requiredTierLabel}`}
              </Text>
            </View>
            {currentPlanName ? (
              <View style={styles.currentPlanBadge}>
                <Text style={styles.currentPlanText} numberOfLines={1}>
                  Tu plan: {currentPlanName}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.heroIconWrap}>
            <View style={styles.heroIconCircle}>
              <Lock size={24} color={ui.primary} />
            </View>
          </View>

          <Text style={styles.title}>{meta.title}</Text>
          <Text style={styles.description}>{description}</Text>

          <View style={styles.highlightsBox}>
            {meta.highlights.map((item) => (
              <View key={item} style={styles.highlightRow}>
                <CheckCircle2 size={15} color={ui.success} />
                <Text style={styles.highlightText}>{item}</Text>
              </View>
            ))}
          </View>

          <View style={styles.actionsCol}>
            {isAccountDisabled ? (
              <>
                <TouchableOpacity
                  onPress={() => void handleOpenWhatsApp()}
                  style={styles.primaryBtn}
                  activeOpacity={0.82}
                  accessibilityRole="button"
                  accessibilityLabel={`Solicitar activación de ${meta.title} por WhatsApp`}
                >
                  <MessageCircle size={16} color={ui.onPrimary} />
                  <Text style={styles.primaryBtnText}>Solicitar activación por WhatsApp</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => void handleOpenPricing()}
                  style={styles.secondaryBtn}
                  activeOpacity={0.82}
                  accessibilityRole="button"
                  accessibilityLabel={`Ver planes para ${meta.title}`}
                >
                  <ExternalLink size={16} color={ui.primary} />
                  <Text style={styles.secondaryBtnText}>Ver planes</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  onPress={() => void handleOpenPricing()}
                  style={styles.primaryBtn}
                  activeOpacity={0.82}
                  accessibilityRole="button"
                  accessibilityLabel={`Ver planes para desbloquear ${meta.title}`}
                >
                  <ExternalLink size={16} color={ui.onPrimary} />
                  <Text style={styles.primaryBtnText}>Ver planes</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => void handleOpenWhatsApp()}
                  style={styles.secondaryBtn}
                  activeOpacity={0.82}
                  accessibilityRole="button"
                  accessibilityLabel="Solicitar actualización de plan por WhatsApp"
                >
                  <MessageCircle size={16} color={ui.primary} />
                  <Text style={styles.secondaryBtnText}>Hablar por WhatsApp</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </ScrollView>
    );

    if (!asScreen) {
      return body;
    }

    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Volver"
          >
            <ArrowLeft size={20} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle} numberOfLines={1}>
            {screenTitle || meta.title}
          </Text>
          <View style={styles.backBtn} />
        </View>
        {body}
      </SafeAreaView>
    );
  }
);

export interface PlanUpgradeModalProps {
  visible: boolean;
  feature: PlanFeatureKey | null;
  lockReason?: FeatureLockReason;
  currentPlanName?: string;
  onClose: () => void;
}

export const PlanUpgradeModal = React.memo<PlanUpgradeModalProps>(
  ({ visible, feature, lockReason = 'plan', currentPlanName, onClose }) => {
    const insets = useSafeAreaInsets();
    if (!visible || !feature) return null;

    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={onClose}
        >
          <View
            style={[
              styles.modalSheet,
              { paddingBottom: Math.max(insets.bottom, 16) },
            ]}
            onStartShouldSetResponder={stopResponder}
          >
            <View style={styles.modalHeader}>
              <View style={styles.modalHandle} />
              <TouchableOpacity
                onPress={onClose}
                style={styles.modalCloseBtn}
                accessibilityRole="button"
                accessibilityLabel="Cerrar aviso de plan"
              >
                <X size={18} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>
            <PlanLockedView
              feature={feature}
              lockReason={lockReason}
              currentPlanName={currentPlanName}
              compact
            />
          </View>
        </TouchableOpacity>
      </Modal>
    );
  }
);

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 18,
  },
  scrollContentCompact: {
    padding: 0,
    paddingTop: 4,
  },
  card: {
    backgroundColor: ui.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 20,
    gap: 14,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 460,
  },
  cardCompact: {
    borderWidth: 0,
    padding: 4,
    borderRadius: 0,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  requiredBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: ui.accentSoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  requiredBadgeText: {
    fontSize: 11.5,
    fontWeight: '800',
    color: ui.accent,
  },
  currentPlanBadge: {
    backgroundColor: ui.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    maxWidth: '55%',
  },
  currentPlanText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  heroIconWrap: {
    alignItems: 'center',
    marginTop: 4,
  },
  heroIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    color: ui.text,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  description: {
    fontSize: 13.5,
    lineHeight: 20,
    color: ui.textSecondary,
    textAlign: 'center',
  },
  highlightsBox: {
    backgroundColor: ui.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 13,
    gap: 10,
  },
  highlightRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  highlightText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: ui.text,
    fontWeight: '500',
  },
  actionsCol: {
    gap: 10,
    marginTop: 4,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: ui.primary,
    paddingHorizontal: 16,
  },
  primaryBtnText: {
    fontSize: 14.5,
    fontWeight: '800',
    color: ui.onPrimary,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(17,28,49,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 10,
    maxHeight: '86%',
    width: '100%',
    maxWidth: 540,
    alignSelf: 'center',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    minHeight: 32,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: ui.border,
  },
  modalCloseBtn: {
    position: 'absolute',
    right: 0,
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
