import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import {
  Banknote,
  Check,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Landmark,
  Smartphone,
} from 'lucide-react-native';
import { ui } from '@/lib/theme';
import {
  getPaymentMethodLogo,
  getPaymentMethodSubtitle,
  getPaymentMethodVisualKind,
} from '@/lib/payment-method-logos';
import type { PosPaymentMethodConfig } from '@/types';

export interface PaymentMethodSelectorProps {
  methods: readonly PosPaymentMethodConfig[];
  selectedMethodId: string;
  onSelect: (method: PosPaymentMethodConfig) => void;
  disabled?: boolean;
  label?: string;
}

const renderMethodVisual = (method: PosPaymentMethodConfig | undefined) => {
  const logo = getPaymentMethodLogo(method);
  if (logo) {
    return (
      <View style={styles.logoBox}>
        <Image
          source={logo}
          style={styles.logoImg}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      </View>
    );
  }

  const kind = getPaymentMethodVisualKind(method);
  if (kind === 'cash') {
    return (
      <View style={[styles.iconBox, styles.iconBoxCash]}>
        <Banknote size={17} color="#059669" />
      </View>
    );
  }
  if (kind === 'transfer') {
    return (
      <View style={[styles.iconBox, styles.iconBoxTransfer]}>
        <Landmark size={17} color="#2563EB" />
      </View>
    );
  }
  if (kind === 'card') {
    return (
      <View style={[styles.iconBox, styles.iconBoxCard]}>
        <CreditCard size={17} color="#475569" />
      </View>
    );
  }
  return (
    <View style={[styles.iconBox, styles.iconBoxDigital]}>
      <Smartphone size={17} color="#7C3AED" />
    </View>
  );
};

export const PaymentMethodSelector = React.memo<PaymentMethodSelectorProps>(
  ({ methods, selectedMethodId, onSelect, disabled = false, label }) => {
    const [open, setOpen] = useState(false);

    const selectedMethod = useMemo(
      () =>
        methods.find((m) => m.id === selectedMethodId) ||
        methods.find((m) => m.kind === 'cash') ||
        methods[0],
      [methods, selectedMethodId]
    );

    const hasChoices = methods.length > 0;

    return (
      <View style={styles.wrapper}>
        {label ? <Text style={styles.label}>{label}</Text> : null}

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Seleccionar método de pago${selectedMethod ? `: ${selectedMethod.name}` : ''}`}
          accessibilityState={{ expanded: open, disabled: disabled || !hasChoices }}
          disabled={disabled || !hasChoices}
          activeOpacity={0.78}
          onPress={() => setOpen((prev) => !prev)}
          style={[
            styles.trigger,
            open && styles.triggerOpen,
            (disabled || !hasChoices) && styles.triggerDisabled,
          ]}
        >
          {renderMethodVisual(selectedMethod)}

          <View style={styles.triggerTextCol}>
            <Text style={styles.triggerTitle} numberOfLines={1}>
              {selectedMethod?.name || 'Seleccionar método'}
            </Text>
            <Text style={styles.triggerSubtitle} numberOfLines={1}>
              {selectedMethod ? getPaymentMethodSubtitle(selectedMethod) : 'Sin métodos activos'}
            </Text>
          </View>

          <View style={styles.chevronBadge}>
            {open ? (
              <ChevronUp size={18} color={ui.primary} />
            ) : (
              <ChevronDown size={18} color={ui.textSecondary} />
            )}
          </View>
        </TouchableOpacity>

        {open && hasChoices ? (
          <View style={styles.dropdownBox}>
            <ScrollView
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={methods.length > 4}
              style={styles.dropdownScroll}
            >
              {methods.map((method, idx) => {
                const isSelected = selectedMethod?.id === method.id;
                const isLast = idx === methods.length - 1;
                return (
                  <TouchableOpacity
                    key={method.id}
                    accessibilityRole="radio"
                    accessibilityLabel={method.name}
                    accessibilityState={{ checked: isSelected }}
                    disabled={disabled}
                    activeOpacity={0.75}
                    onPress={() => {
                      onSelect(method);
                      setOpen(false);
                    }}
                    style={[
                      styles.optionRow,
                      isSelected && styles.optionRowSelected,
                      !isLast && styles.optionRowBorder,
                    ]}
                  >
                    {renderMethodVisual(method)}

                    <View style={styles.optionTextCol}>
                      <Text
                        style={[styles.optionTitle, isSelected && styles.optionTitleSelected]}
                        numberOfLines={1}
                      >
                        {method.name}
                      </Text>
                      <Text style={styles.optionSubtitle} numberOfLines={1}>
                        {getPaymentMethodSubtitle(method)}
                      </Text>
                    </View>

                    {isSelected ? <Check size={17} color={ui.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>
    );
  }
);

PaymentMethodSelector.displayName = 'PaymentMethodSelector';

const styles = StyleSheet.create({
  wrapper: {
    marginTop: 4,
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 6,
  },
  trigger: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: ui.border,
    backgroundColor: ui.surface,
  },
  triggerOpen: {
    borderColor: ui.primary,
    backgroundColor: '#FAFCFF',
  },
  triggerDisabled: {
    opacity: 0.6,
  },
  logoBox: {
    width: 42,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImg: {
    width: '100%',
    height: '100%',
  },
  iconBox: {
    width: 42,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBoxCash: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  iconBoxTransfer: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  iconBoxCard: {
    backgroundColor: '#F1F5F9',
    borderColor: '#CBD5E1',
  },
  iconBoxDigital: {
    backgroundColor: '#F5F3FF',
    borderColor: '#DDD6FE',
  },
  triggerTextCol: {
    flex: 1,
    minWidth: 0,
  },
  triggerTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: ui.text,
  },
  triggerSubtitle: {
    fontSize: 11.5,
    color: ui.textSecondary,
    marginTop: 1,
  },
  chevronBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropdownBox: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    overflow: 'hidden',
  },
  dropdownScroll: {
    maxHeight: 230,
  },
  optionRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: ui.surface,
  },
  optionRowSelected: {
    backgroundColor: ui.primarySoft,
  },
  optionRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  optionTextCol: {
    flex: 1,
    minWidth: 0,
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
  },
  optionTitleSelected: {
    fontWeight: '700',
    color: ui.primary,
  },
  optionSubtitle: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 1,
  },
});
