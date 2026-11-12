import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { ui } from '@/lib/theme';

/** The original Ventify mark, shared with the web product. */
export function BrandLogo({ size = 40, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const logoStyle = useMemo(() => ({ width: size, height: size }), [size]);
  const isLarge = size > 50;

  return (
    <View style={styles.brand} accessibilityLabel="Ventify" accessible>
      <Image
        source={require('../../../assets/brand/ventify-logo.png')}
        style={logoStyle}
        contentFit="contain"
        cachePolicy="memory-disk"
        accessibilityIgnoresInvertColors
      />
      {wordmark && (
        <Text style={[styles.wordmark, isLarge ? styles.wordmarkLg : styles.wordmarkSm]}>
          ventify<Text style={styles.wordmarkDot}>.</Text>
        </Text>
      )}
    </View>
  );
}

type HeadingProps = { title: string; subtitle?: string; action?: React.ReactNode };
export function ScreenHeading({ title, subtitle, action }: HeadingProps) {
  return (
    <View style={styles.heading}>
      <View style={styles.headingCopy}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action ? <View style={styles.headingAction}>{action}</View> : null}
    </View>
  );
}
export function SectionHeading({ title, subtitle, action }: HeadingProps) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.headingCopy}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  wordmark: { fontWeight: '800', letterSpacing: -1, color: ui.text },
  wordmarkSm: { fontSize: 24 },
  wordmarkLg: { fontSize: 34 },
  wordmarkDot: { color: ui.primary },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20, flexWrap: 'wrap' },
  headingCopy: { flex: 1, minWidth: 150 },
  headingAction: { flexShrink: 0 },
  title: { fontSize: ui.font.title, fontWeight: '700', letterSpacing: -0.7, color: ui.text },
  subtitle: { fontSize: 14, lineHeight: 21, color: ui.textSecondary, marginTop: 5 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 16 },
  sectionTitle: { fontSize: ui.font.section, fontWeight: '700', color: ui.text, letterSpacing: -0.3 },
});
