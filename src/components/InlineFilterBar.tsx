import React, { useState, useMemo, useEffect, useCallback } from 'react';
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

// Normalización estricta sin tildes
function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Coincidencia inteligente por substring, prefijo o iniciales
function matchesQuery(query: string, itemName: string): boolean {
  if (!query) return true;
  const q = normalizeText(query);
  const target = normalizeText(itemName);

  if (target.includes(q)) return true;

  // Búsqueda por iniciales (ej. "cc" para "Coca Cola")
  const words = target.split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('');
  if (initials.includes(q)) return true;

  // Alguna palabra inicia con el término
  if (words.some((w) => w.startsWith(q))) return true;

  return false;
}

export const InlineFilterBar: React.FC<InlineFilterBarProps> = React.memo(({ groups, rightElement }) => {
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) || null,
    [groups, activeGroupId]
  );

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

  const effectiveQuery = (activeGroup && activeGroup.options.length > 20) ? debouncedSearchQuery : searchQuery;

  const filteredOptions = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.options.filter((opt) => matchesQuery(effectiveQuery, opt.name));
  }, [activeGroup, effectiveQuery]);

  const toggleGroup = (groupId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (activeGroupId === groupId) {
      setActiveGroupId(null);
      setSearchQuery('');
      setDebouncedSearchQuery('');
    } else {
      setActiveGroupId(groupId);
      setSearchQuery('');
      setDebouncedSearchQuery('');
    }
  };

  const getGroupIcon = (type?: string, isSelected?: boolean) => {
    const color = isSelected ? ui.primary : ui.textSecondary;
    if (type === 'brand') return <Bookmark size={13} color={color} />;
    if (type === 'size') return <Ruler size={13} color={color} />;
    return <Tag size={13} color={color} />;
  };

  const handleSelectAll = useCallback(() => {
    if (!activeGroup) return;
    activeGroup.onClear();
    setActiveGroupId(null);
    setSearchQuery('');
    setDebouncedSearchQuery('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [activeGroup]);

  const handleSelectOption = useCallback((optName: string) => {
    if (!activeGroup) return;
    activeGroup.onSelect(optName);
    setActiveGroupId(null);
    setSearchQuery('');
    setDebouncedSearchQuery('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [activeGroup]);

  const renderOptionItem = useCallback(({ item: opt }: { item: FilterOption }) => {
    if (opt.name === 'Todas') return null;
    const isItemActive = activeGroup?.selectedValue === opt.name;

    return (
      <TouchableOpacity
        key={opt.name}
        style={[
          styles.optionRow,
          isItemActive && { backgroundColor: ui.primarySoft },
        ]}
        onPress={() => handleSelectOption(opt.name)}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.optionText,
            {
              color: isItemActive ? ui.primary : ui.text,
              fontWeight: isItemActive ? '700' : '400',
            },
          ]}
          numberOfLines={1}
        >
          {opt.name}
        </Text>
        <View style={styles.optionRightCol}>
          {opt.count !== undefined && (
            <Text style={[styles.countBadgeText, { color: ui.textSecondary }]}>
              ({opt.count})
            </Text>
          )}
          {isItemActive ? <Check size={14} color={ui.primary} /> : null}
        </View>
      </TouchableOpacity>
    );
  }, [activeGroup?.selectedValue, handleSelectOption]);

  const renderAllOption = () => {
    if (!activeGroup) return null;
    const isSelected = activeGroup.selectedValue === 'Todas';
    return (
      <TouchableOpacity
        style={[
          styles.optionRow,
          isSelected && { backgroundColor: ui.primarySoft },
        ]}
        onPress={handleSelectAll}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.optionText,
            {
              color: isSelected ? ui.primary : ui.text,
              fontWeight: isSelected ? '700' : '500',
            },
          ]}
        >
          Todas las {activeGroup.label.toLowerCase()}
        </Text>
        {isSelected ? (
          <Check size={14} color={ui.primary} />
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Fila Horizontal de Selectores Compactos */}
      <View style={styles.buttonsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.buttonsScroll}
        >
          {groups.map((group) => {
            const isSelected = group.selectedValue !== 'Todas' && group.selectedValue !== '';
            const isOpen = activeGroupId === group.id;

            return (
              <View key={group.id} style={styles.btnWrapper}>
                <TouchableOpacity
                  style={[
                    styles.pickerBtn,
                    {
                      backgroundColor: isSelected ? ui.primarySoft : ui.surface,
                      borderColor: isSelected ? ui.primary : isOpen ? ui.primary : ui.border,
                    },
                  ]}
                  onPress={() => toggleGroup(group.id)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Filtrar ${group.label}: ${group.selectedValue}`}
                >
                  {getGroupIcon(group.icon, isSelected)}
                  <Text
                    style={[
                      styles.pickerBtnText,
                      {
                        color: isSelected ? ui.primary : ui.text,
                        fontWeight: isSelected ? '700' : '500',
                      },
                    ]}
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
                    style={[styles.clearBtn, { backgroundColor: ui.primarySoft }]}
                    onPress={() => {
                      group.onClear();
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Limpiar filtro ${group.label}`}
                  >
                    <X size={11} color={ui.primary} />
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        {rightElement ? <View style={styles.rightWrapper}>{rightElement}</View> : null}
      </View>

      {/* Menú Desplegable Inline con Buscador (sin modal invasivo) */}
      {activeGroup && (
        <View style={[styles.dropdownContainer, { backgroundColor: ui.surface, borderColor: ui.border }]}>
          {/* Barra de búsqueda dentro del selector */}
          <View style={[styles.searchRow, { backgroundColor: ui.background, borderColor: ui.border }]}>
            <Search size={14} color={ui.textSecondary} style={{ marginRight: 6 }} />
            <TextInput
              style={[styles.searchInput, { color: ui.text }]}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={`Buscar ${activeGroup.label.toLowerCase()} o iniciales...`}
              placeholderTextColor={ui.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setSearchQuery('');
                  setDebouncedSearchQuery('');
                }}
                hitSlop={6}
              >
                <X size={14} color={ui.textSecondary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Lista Vertical Desplegable (Virtualizada con FlashList si > 40 opciones) */}
          {filteredOptions.length > 40 ? (
            <View style={styles.flashListContainer}>
              <FlashList
                data={filteredOptions}
                renderItem={renderOptionItem}
                estimatedItemSize={36}
                keyExtractor={(item) => item.name}
                ListHeaderComponent={renderAllOption}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                  <View style={styles.emptyOptions}>
                    <Text style={[styles.emptyOptionsText, { color: ui.textMuted }]}>
                      Sin coincidencias para "{searchQuery}"
                    </Text>
                  </View>
                }
              />
            </View>
          ) : (
            <ScrollView
              style={styles.optionsList}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {renderAllOption()}

              {filteredOptions.map((opt) => renderOptionItem({ item: opt }))}

              {filteredOptions.length === 0 && (
                <View style={styles.emptyOptions}>
                  <Text style={[styles.emptyOptionsText, { color: ui.textMuted }]}>
                    Sin coincidencias para "{searchQuery}"
                  </Text>
                </View>
              )}
            </ScrollView>
          )}
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  btnWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 32,
  },
  pickerBtnText: {
    fontSize: 12,
    maxWidth: 130,
  },
  clearBtn: {
    marginLeft: 3,
    padding: 4,
    borderRadius: 10,
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
    marginBottom: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    paddingVertical: 0,
  },
  optionsList: {
    maxHeight: 180,
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
  optionRightCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  optionText: {
    fontSize: 13,
    flex: 1,
  },
  countBadgeText: {
    fontSize: 11,
  },
  emptyOptions: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  emptyOptionsText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
