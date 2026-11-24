import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Tag, Bookmark, Ruler, ChevronDown, ChevronUp, Search, X, Check } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ui } from '@/lib/theme';

export interface FilterOption {
  name: string;
  count?: number;
}

export interface FilterGroup {
  id: string;
  label: string;
  selectedValue: string;
  options: FilterOption[];
  onSelect: (val: string) => void;
  onClear: () => void;
  icon?: 'category' | 'brand' | 'size';
}

interface InlineFilterBarProps {
  groups: FilterGroup[];
  rightElement?: React.ReactNode;
}

interface NormalizedFilterOption {
  option: FilterOption;
  normalized: string;
  words: string[];
  initials: string;
}

const NON_ASCII_RE = /[^\x00-\x7F]/;

// Normalización estricta sin tildes
function normalizeText(text: string): string {
  const lower = (text || '').toLowerCase();
  const clean = NON_ASCII_RE.test(lower)
    ? lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    : lower;
  return clean.trim();
}

const DROPDOWN_ESTIMATED_LIST_SIZE = { width: 320, height: 180 };
const overrideDropdownItemLayout = (layout: { span?: number; size?: number }) => {
  layout.size = 36;
};

function matchesNormalizedQuery(normalizedQuery: string, item: NormalizedFilterOption): boolean {
  if (!normalizedQuery) return true;
  if (item.normalized.includes(normalizedQuery)) return true;
  if (item.initials.includes(normalizedQuery)) return true;
  for (let i = 0; i < item.words.length; i += 1) {
    if (item.words[i].startsWith(normalizedQuery)) return true;
  }
  return false;
}

const keyExtractorByName = (item: FilterOption) => item.name;

interface FilterOptionRowProps {
  option: FilterOption;
  isActive: boolean;
  onSelect: (optName: string) => void;
}

const FilterOptionRow = React.memo<FilterOptionRowProps>(({ option, isActive, onSelect }) => {
  const handlePress = useCallback(() => {
    onSelect(option.name);
  }, [onSelect, option.name]);

  return (
    <TouchableOpacity
      style={[styles.optionRow, isActive && styles.optionRowActive]}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <Text
        style={[styles.optionText, isActive && styles.optionTextActive]}
        numberOfLines={1}
      >
        {option.name}
      </Text>
      <View style={styles.optionRightCol}>
        {option.count !== undefined && (
          <Text style={styles.countBadgeText}>({option.count})</Text>
        )}
        {isActive ? <Check size={14} color={ui.primary} /> : null}
      </View>
    </TouchableOpacity>
  );
});

function renderGroupIcon(type?: string, isSelected?: boolean) {
  const color = isSelected ? ui.primary : ui.textSecondary;
  if (type === 'brand') return <Bookmark size={13} color={color} />;
  if (type === 'size') return <Ruler size={13} color={color} />;
  return <Tag size={13} color={color} />;
}

interface FilterGroupChipProps {
  group: FilterGroup;
  isOpen: boolean;
  onToggle: (groupId: string) => void;
}

const FilterGroupChip = React.memo<FilterGroupChipProps>(({ group, isOpen, onToggle }) => {
  const isSelected = group.selectedValue !== 'Todas' && group.selectedValue !== '';

  const handleToggle = useCallback(() => {
    onToggle(group.id);
  }, [onToggle, group.id]);

  const handleClear = useCallback(() => {
    group.onClear();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [group.onClear]);

  return (
    <View style={styles.btnWrapper}>
      <TouchableOpacity
        style={[
          styles.pickerBtn,
          isSelected ? styles.pickerBtnSelected : isOpen ? styles.pickerBtnOpen : null,
        ]}
        onPress={handleToggle}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Filtrar ${group.label}: ${group.selectedValue}`}
      >
        {renderGroupIcon(group.icon, isSelected)}
        <Text
          style={[styles.pickerBtnText, isSelected && styles.pickerBtnTextSelected]}
          numberOfLines={1}
        >
          {isSelected ? group.selectedValue : group.label}
        </Text>
        {isOpen ? (
          <ChevronUp size={12} color={isSelected ? ui.primary : ui.textSecondary} />
        ) : (
          <ChevronDown size={12} color={isSelected ? ui.primary : ui.textSecondary} />
        )}
      </TouchableOpacity>

      {isSelected ? (
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={handleClear}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Limpiar filtro ${group.label}`}
        >
          <X size={11} color={ui.primary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
});

export const InlineFilterBar: React.FC<InlineFilterBarProps> = React.memo(({ groups, rightElement }) => {
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) || null,
    [groups, activeGroupId]
  );
  const activeGroupRef = useRef(activeGroup);
  activeGroupRef.current = activeGroup;
  const activeOptions = activeGroup?.options;

  useEffect(() => {
    if (!searchQuery) {
      setDebouncedSearchQuery('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 120);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const effectiveQuery =
    activeOptions && activeOptions.length > 20 ? debouncedSearchQuery : searchQuery;

  const normalizedGroupOptions = useMemo<{
    options: NormalizedFilterOption[];
    allOptions: FilterOption[];
  }>(() => {
    if (!activeOptions) return { options: [], allOptions: [] };
    const list: NormalizedFilterOption[] = [];
    const allOptions: FilterOption[] = [];
    for (let i = 0; i < activeOptions.length; i += 1) {
      const opt = activeOptions[i];
      if (opt.name === 'Todas') continue;
      allOptions.push(opt);
      const normalized = normalizeText(opt.name);
      const words = normalized.split(/\s+/).filter(Boolean);
      let initials = '';
      for (let w = 0; w < words.length; w += 1) {
        initials += words[w][0] || '';
      }
      list.push({ option: opt, normalized, words, initials });
    }
    return { options: list, allOptions };
  }, [activeOptions]);

  const filteredOptions = useMemo<FilterOption[]>(() => {
    if (!activeOptions) return [];
    const normalizedQuery = normalizeText(effectiveQuery);
    if (!normalizedQuery) {
      return normalizedGroupOptions.allOptions;
    }
    const result: FilterOption[] = [];
    const entries = normalizedGroupOptions.options;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (matchesNormalizedQuery(normalizedQuery, entry)) {
        result.push(entry.option);
      }
    }
    return result;
  }, [activeOptions, normalizedGroupOptions, effectiveQuery]);

  const toggleGroup = useCallback((groupId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveGroupId((prev) => (prev === groupId ? null : groupId));
    setSearchQuery('');
    setDebouncedSearchQuery('');
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setDebouncedSearchQuery('');
  }, []);

  const handleSelectAll = useCallback(() => {
    const group = activeGroupRef.current;
    if (!group) return;
    group.onClear();
    setActiveGroupId(null);
    setSearchQuery('');
    setDebouncedSearchQuery('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleSelectOption = useCallback((optName: string) => {
    const group = activeGroupRef.current;
    if (!group) return;
    group.onSelect(optName);
    setActiveGroupId(null);
    setSearchQuery('');
    setDebouncedSearchQuery('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const selectedValue = activeGroup?.selectedValue;
  const renderOptionItem = useCallback(
    ({ item: opt }: { item: FilterOption }) => (
      <FilterOptionRow
        option={opt}
        isActive={selectedValue === opt.name}
        onSelect={handleSelectOption}
      />
    ),
    [selectedValue, handleSelectOption]
  );

  const allHeaderElement = useMemo(() => {
    if (!activeGroup) return null;
    const isSelected = activeGroup.selectedValue === 'Todas';
    return (
      <TouchableOpacity
        style={[styles.optionRow, isSelected && styles.optionRowActive]}
        onPress={handleSelectAll}
        activeOpacity={0.7}
      >
        <Text style={[styles.optionText, styles.allOptionText, isSelected && styles.optionTextActive]}>
          Todas las {activeGroup.label.toLowerCase()}
        </Text>
        {isSelected ? <Check size={14} color={ui.primary} /> : null}
      </TouchableOpacity>
    );
  }, [activeGroup, handleSelectAll]);

  const emptyComponent = useMemo(
    () => (
      <View style={styles.emptyOptions}>
        <Text style={styles.emptyOptionsText}>
          Sin coincidencias para "{searchQuery}"
        </Text>
      </View>
    ),
    [searchQuery]
  );

  const listContainerStyle = useMemo(() => {
    const estimatedTotalHeight = (normalizedGroupOptions.allOptions.length + 1) * 38;
    const clampedHeight = Math.min(180, Math.max(84, estimatedTotalHeight));
    return clampedHeight === 180
      ? styles.flashListContainer
      : [styles.flashListContainer, { height: clampedHeight }];
  }, [normalizedGroupOptions.allOptions.length]);

  return (
    <View style={styles.container}>
      {/* Fila Horizontal de Selectores Compactos */}
      <View style={styles.buttonsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.buttonsScroll}
        >
          {groups.map((group) => (
            <FilterGroupChip
              key={group.id}
              group={group}
              isOpen={activeGroupId === group.id}
              onToggle={toggleGroup}
            />
          ))}
        </ScrollView>

        {rightElement ? <View style={styles.rightWrapper}>{rightElement}</View> : null}
      </View>

      {/* Menú Desplegable Inline con Buscador (sin modal invasivo) */}
      {activeGroup && (
        <View style={styles.dropdownContainer}>
          {/* Barra de búsqueda dentro del selector */}
          <View style={styles.searchRow}>
            <Search size={14} color={ui.textSecondary} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={`Buscar ${activeGroup.label.toLowerCase()} o iniciales...`}
              placeholderTextColor={ui.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={handleClearSearch} hitSlop={6}>
                <X size={14} color={ui.textSecondary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Lista Vertical Desplegable (siempre virtualizada con FlashList para evitar remounts al filtrar) */}
          <View style={listContainerStyle}>
            <FlashList
              data={filteredOptions}
              renderItem={renderOptionItem}
              estimatedItemSize={36}
              overrideItemLayout={overrideDropdownItemLayout}
              estimatedListSize={DROPDOWN_ESTIMATED_LIST_SIZE}
              extraData={selectedValue}
              keyExtractor={keyExtractorByName}
              ListHeaderComponent={allHeaderElement}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              ListEmptyComponent={filteredOptions.length === 0 ? emptyComponent : undefined}
            />
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
  },
  buttonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  buttonsScroll: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
  btnWrapper: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pickerBtn: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    minHeight: 32,
  },
  pickerBtnOpen: {
    borderColor: ui.primary,
  },
  pickerBtnSelected: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  pickerBtnText: {
    flex: 1,
    fontSize: 12,
    color: ui.text,
    fontWeight: '500',
  },
  pickerBtnTextSelected: {
    color: ui.primary,
    fontWeight: '700',
  },
  clearBtn: {
    marginLeft: 3,
    padding: 4,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightWrapper: {
    marginLeft: 8,
  },
  dropdownContainer: {
    marginTop: 6,
    marginHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    padding: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 5,
    zIndex: 99,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    height: 34,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
    marginBottom: 6,
  },
  searchIcon: {
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    color: ui.text,
    paddingVertical: 0,
  },
  flashListContainer: {
    height: 180,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
  },
  optionRowActive: {
    backgroundColor: ui.primarySoft,
  },
  optionRightCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  optionText: {
    fontSize: 13,
    flex: 1,
    color: ui.text,
    fontWeight: '400',
  },
  allOptionText: {
    fontWeight: '500',
  },
  optionTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  countBadgeText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  emptyOptions: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  emptyOptionsText: {
    fontSize: 12,
    fontStyle: 'italic',
    color: ui.textMuted,
  },
});
