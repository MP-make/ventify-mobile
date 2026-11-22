import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { Tag, Ruler } from 'lucide-react-native';
import { DEFAULT_CATALOG_BRANDS } from '@/lib/catalog-filters';
import { ui } from '@/lib/theme';
import { COMMON_CATEGORIES, PRESET_SIZES } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

const SkuField = React.memo<{
  sku: string;
  compactLayout: boolean;
  onChangeSku: (val: string) => void;
}>(({ sku, compactLayout, onChangeSku }) => (
  <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
    <Text style={styles.label}>SKU Interno</Text>
    <TextInput
      style={styles.input}
      value={sku}
      onChangeText={onChangeSku}
      accessibilityLabel="SKU interno"
      placeholder="Opcional"
      placeholderTextColor={ui.textMuted}
      autoCapitalize="characters"
    />
  </View>
));

const CategoryInputField = React.memo<{
  category: string;
  compactLayout: boolean;
  onChangeCategory: (val: string) => void;
}>(({ category, compactLayout, onChangeCategory }) => (
  <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
    <Text style={styles.label}>Categoría</Text>
    <TextInput
      style={styles.input}
      value={category}
      onChangeText={onChangeCategory}
      accessibilityLabel="Categoría del producto"
      placeholder="Categoría"
      placeholderTextColor={ui.textMuted}
    />
  </View>
));

const CategoryChipsRow = React.memo<{
  category: string;
  onSelectCategory: (cat: string) => void;
}>(({ category, onSelectCategory }) => {
  const normalizedCategory = category.toLowerCase();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.catChipsScroll}
      contentContainerStyle={styles.catChipsContent}
      keyboardShouldPersistTaps="handled"
    >
      {COMMON_CATEGORIES.map((cat) => {
        const active = normalizedCategory === cat.toLowerCase();
        return (
          <TouchableOpacity
            key={cat}
            style={[styles.catChip, active && styles.catChipActive]}
            onPress={() => onSelectCategory(cat)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Seleccionar categoría ${cat}`}
          >
            <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
              {cat}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
});

const CatalogBrandSizeSection = React.memo<{
  brand: string;
  sizeLabel: string;
  compactLayout: boolean;
  onChangeBrand: (val: string) => void;
  onChangeSizeLabel: (val: string) => void;
}>(({ brand, sizeLabel, compactLayout, onChangeBrand, onChangeSizeLabel }) => {
  const normBrand = brand.toLowerCase();
  const normSize = sizeLabel.toLowerCase();

  return (
    <View style={styles.catalogFiltersSection}>
      <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
        <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
          <View style={styles.labelRow}>
            <Tag size={13} color={ui.primary} />
            <Text style={styles.label}>Marca (Opcional)</Text>
          </View>
          <TextInput
            style={styles.input}
            value={brand}
            onChangeText={onChangeBrand}
            placeholder="Ej. Vargas, Gloria"
            placeholderTextColor={ui.textMuted}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.miniChipsScroll}
            contentContainerStyle={styles.miniChipsContent}
            keyboardShouldPersistTaps="handled"
          >
            {DEFAULT_CATALOG_BRANDS.slice(0, 6).map((b) => {
              const active = normBrand === b.toLowerCase();
              return (
                <TouchableOpacity
                  key={b}
                  style={[styles.miniChip, active && styles.miniChipActive]}
                  onPress={() => onChangeBrand(b)}
                >
                  <Text style={[styles.miniChipText, active && styles.miniChipTextActive]}>
                    {b}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
          <View style={styles.labelRow}>
            <Ruler size={13} color={ui.primary} />
            <Text style={styles.label}>Medidas / Tallas (Opcional)</Text>
          </View>
          <TextInput
            style={styles.input}
            value={sizeLabel}
            onChangeText={onChangeSizeLabel}
            placeholder="Separa con comas: S, M, L"
            placeholderTextColor={ui.textMuted}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.miniChipsScroll}
            contentContainerStyle={styles.miniChipsContent}
            keyboardShouldPersistTaps="handled"
          >
            {PRESET_SIZES.map((s) => {
              const active = normSize === s.toLowerCase();
              return (
                <TouchableOpacity
                  key={s}
                  style={[styles.miniChip, active && styles.miniChipActive]}
                  onPress={() => onChangeSizeLabel(s)}
                >
                  <Text style={[styles.miniChipText, active && styles.miniChipTextActive]}>
                    {s}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </View>
  );
});

export interface CategoryFiltersSectionProps {
  sku: string;
  category: string;
  brand: string;
  sizeLabel: string;
  enableCatalogFilters: boolean;
  compactLayout: boolean;
  onChangeSku: (val: string) => void;
  onChangeCategory: (val: string) => void;
  onChangeBrand: (val: string) => void;
  onChangeSizeLabel: (val: string) => void;
}

export const CategoryFiltersSection: React.FC<CategoryFiltersSectionProps> = React.memo(({
  sku,
  category,
  brand,
  sizeLabel,
  enableCatalogFilters,
  compactLayout,
  onChangeSku,
  onChangeCategory,
  onChangeBrand,
  onChangeSizeLabel,
}) => {
  return (
    <>
      <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
        <SkuField sku={sku} compactLayout={compactLayout} onChangeSku={onChangeSku} />
        <CategoryInputField
          category={category}
          compactLayout={compactLayout}
          onChangeCategory={onChangeCategory}
        />
      </View>

      <CategoryChipsRow category={category} onSelectCategory={onChangeCategory} />

      {enableCatalogFilters && (
        <CatalogBrandSizeSection
          brand={brand}
          sizeLabel={sizeLabel}
          compactLayout={compactLayout}
          onChangeBrand={onChangeBrand}
          onChangeSizeLabel={onChangeSizeLabel}
        />
      )}
    </>
  );
});
