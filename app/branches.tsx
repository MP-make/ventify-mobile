import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  ArrowLeft,
  Building2,
  Check,
  Edit3,
  Mail,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  User,
  X,
} from 'lucide-react-native';
import { useAuthSession, usePlanAccess, usePlanFeatures } from '@/context/AuthContext';
import { PlanLockedView } from '@/components/PlanFeatureGate';
import { useBusinessSettings } from '@/context/SettingsContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermissions } from '@/hooks/usePermissions';
import {
  type BranchItem,
  getBranchesList,
  saveBranchRecord,
  toggleBranchActive,
} from '@/services/enterprise-ops-service';
import { ui } from '@/lib/theme';

type StatusFilter = 'all' | 'active' | 'inactive';

const ListGap10 = () => <View style={styles.listGap10} />;

const getBranchItemType = (item: BranchItem) => (item.isActive ? 'active' : 'inactive');

interface BranchSearchBarProps {
  onSearchChange: (debouncedQuery: string) => void;
}

const BranchSearchBar = React.memo<BranchSearchBarProps>(({ onSearchChange }) => {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 150);

  useEffect(() => {
    onSearchChange(debouncedQuery);
  }, [debouncedQuery, onSearchChange]);

  return (
    <View style={styles.searchBox}>
      <Search size={16} color={ui.textMuted} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Buscar por nombre, dirección o encargado..."
        placeholderTextColor={ui.textMuted}
        style={styles.searchInput}
      />
      {query.length > 0 && (
        <TouchableOpacity onPress={() => setQuery('')}>
          <X size={16} color={ui.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
});

interface BranchCardProps {
  item: BranchItem;
  isCurrent: boolean;
  canManage: boolean;
  onToggleActive: (branch: BranchItem) => void;
  onSwitchBranch: (branch: BranchItem) => void;
  onEdit: (branch: BranchItem) => void;
}

const BranchCard = React.memo<BranchCardProps>(
  ({ item, isCurrent, canManage, onToggleActive, onSwitchBranch, onEdit }) => (
    <View style={[styles.card, isCurrent && styles.cardCurrent]}>
      <View style={styles.cardTop}>
        <View style={styles.cardTitleGroup}>
          <View style={styles.titleLine}>
            <Text style={styles.branchName} numberOfLines={1}>
              {item.name}
            </Text>
            {isCurrent && (
              <View style={styles.currentChip}>
                <Check size={12} color={ui.primary} />
                <Text style={styles.currentChipText}>En uso</Text>
              </View>
            )}
          </View>
          <View
            style={[
              styles.statusChip,
              { backgroundColor: item.isActive ? ui.successSoft : ui.surfaceMuted },
            ]}
          >
            <Text
              style={[
                styles.statusChipText,
                { color: item.isActive ? ui.success : ui.textMuted },
              ]}
            >
              {item.isActive ? 'Activa' : 'Inactiva'}
            </Text>
          </View>
        </View>

        {canManage && (
          <Switch
            value={item.isActive}
            onValueChange={() => onToggleActive(item)}
            trackColor={{ false: ui.border, true: ui.primarySoft }}
            thumbColor={item.isActive ? ui.primary : ui.textMuted}
          />
        )}
      </View>

      <View style={styles.detailsList}>
        {item.address ? (
          <View style={styles.detailRow}>
            <MapPin size={13} color={ui.textMuted} />
            <Text style={styles.detailText}>{item.address}</Text>
          </View>
        ) : null}
        {item.phone ? (
          <View style={styles.detailRow}>
            <Phone size={13} color={ui.textMuted} />
            <Text style={styles.detailText}>{item.phone}</Text>
          </View>
        ) : null}
        {item.email ? (
          <View style={styles.detailRow}>
            <Mail size={13} color={ui.textMuted} />
            <Text style={styles.detailText}>{item.email}</Text>
          </View>
        ) : null}
        {item.manager ? (
          <View style={styles.detailRow}>
            <User size={13} color={ui.textMuted} />
            <Text style={styles.detailText}>Encargado: {item.manager}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.actionsRow}>
        {!isCurrent && item.isActive && (
          <TouchableOpacity
            onPress={() => onSwitchBranch(item)}
            style={styles.useBtn}
            accessibilityRole="button"
            accessibilityLabel={`Usar sucursal ${item.name}`}
          >
            <Check size={15} color={ui.primary} />
            <Text style={styles.useBtnText}>Usar esta sucursal</Text>
          </TouchableOpacity>
        )}
        {canManage && (
          <TouchableOpacity
            onPress={() => onEdit(item)}
            style={styles.editBtn}
            accessibilityRole="button"
            accessibilityLabel={`Editar sucursal ${item.name}`}
          >
            <Edit3 size={15} color={ui.textSecondary} />
            <Text style={styles.editBtnText}>Editar</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  )
);

interface BranchFormModalProps {
  visible: boolean;
  accountId: string;
  editingBranch: BranchItem | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

const BranchFormModal = React.memo<BranchFormModalProps>(
  ({ visible, accountId, editingBranch, onClose, onSaved }) => {
    const insets = useSafeAreaInsets();
    const isMountedRef = useRef(true);

    const [name, setName] = useState(editingBranch?.name || '');
    const [address, setAddress] = useState(editingBranch?.address || '');
    const [phone, setPhone] = useState(editingBranch?.phone || '');
    const [email, setEmail] = useState(editingBranch?.email || '');
    const [manager, setManager] = useState(editingBranch?.manager || '');
    const [businessName, setBusinessName] = useState(editingBranch?.businessName || '');
    const [ruc, setRuc] = useState(editingBranch?.ruc || '');
    const [receiptFooter, setReceiptFooter] = useState(editingBranch?.receiptFooter || '');
    const [isActive, setIsActive] = useState(editingBranch ? editingBranch.isActive !== false : true);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      isMountedRef.current = true;
      return () => {
        isMountedRef.current = false;
      };
    }, []);

    useEffect(() => {
      setName(editingBranch?.name || '');
      setAddress(editingBranch?.address || '');
      setPhone(editingBranch?.phone || '');
      setEmail(editingBranch?.email || '');
      setManager(editingBranch?.manager || '');
      setBusinessName(editingBranch?.businessName || '');
      setRuc(editingBranch?.ruc || '');
      setReceiptFooter(editingBranch?.receiptFooter || '');
      setIsActive(editingBranch ? editingBranch.isActive !== false : true);
    }, [editingBranch]);

    const handleSave = async () => {
      if (!accountId) return;
      if (!name.trim()) {
        Alert.alert('Nombre requerido', 'Ingresa el nombre de la sucursal.');
        return;
      }
      if (ruc.trim() && !/^\d{11}$/.test(ruc.trim())) {
        Alert.alert('RUC inválido', 'Si ingresas RUC, debe tener exactamente 11 dígitos.');
        return;
      }

      setSubmitting(true);
      try {
        await saveBranchRecord({
          id: editingBranch?.id,
          accountId,
          name: name.trim(),
          address: address.trim(),
          phone: phone.trim(),
          email: email.trim(),
          manager: manager.trim(),
          businessName: businessName.trim(),
          ruc: ruc.trim(),
          receiptFooter: receiptFooter.trim(),
          isActive,
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        onClose();
        await onSaved();
      } catch (err: any) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert('No se pudo guardar', err?.message || 'Error al guardar sucursal.');
      } finally {
        if (isMountedRef.current) {
          setSubmitting(false);
        }
      }
    };

    return (
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={() => !submitting && onClose()}
      >
        <KeyboardAvoidingView
          style={styles.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingBranch ? 'Editar Sucursal' : 'Nueva Sucursal'}
              </Text>
              <TouchableOpacity
                onPress={() => !submitting && onClose()}
                style={styles.iconBtn}
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.formContent}
            >
              <Text style={styles.fieldLabel}>Nombre de sucursal *</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Ej. Sede Miraflores"
                placeholderTextColor={ui.textMuted}
                style={styles.input}
              />

              <Text style={styles.fieldLabel}>Dirección</Text>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder="Av. Larco 123"
                placeholderTextColor={ui.textMuted}
                style={styles.input}
              />

              <View style={styles.twoCol}>
                <View style={styles.col}>
                  <Text style={styles.fieldLabel}>Teléfono</Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="999 888 777"
                    keyboardType="phone-pad"
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.fieldLabel}>Encargado</Text>
                  <TextInput
                    value={manager}
                    onChangeText={setManager}
                    placeholder="Nombre"
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Correo electrónico</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="sucursal@negocio.com"
                keyboardType="email-address"
                autoCapitalize="none"
                placeholderTextColor={ui.textMuted}
                style={styles.input}
              />

              <View style={styles.twoCol}>
                <View style={styles.col}>
                  <Text style={styles.fieldLabel}>Razón Social (ticket)</Text>
                  <TextInput
                    value={businessName}
                    onChangeText={setBusinessName}
                    placeholder="Opcional"
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />
                </View>
                <View style={styles.col}>
                  <Text style={styles.fieldLabel}>RUC (ticket)</Text>
                  <TextInput
                    value={ruc}
                    onChangeText={setRuc}
                    placeholder="11 dígitos"
                    keyboardType="numeric"
                    maxLength={11}
                    placeholderTextColor={ui.textMuted}
                    style={styles.input}
                  />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Pie de ticket personalizado</Text>
              <TextInput
                value={receiptFooter}
                onChangeText={setReceiptFooter}
                placeholder="Mensaje al final de la boleta o ticket"
                placeholderTextColor={ui.textMuted}
                style={styles.input}
              />

              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Sucursal Activa</Text>
                <Switch
                  value={isActive}
                  onValueChange={setIsActive}
                  trackColor={{ false: ui.border, true: ui.primarySoft }}
                  thumbColor={isActive ? ui.primary : ui.textMuted}
                />
              </View>

              <TouchableOpacity
                onPress={() => void handleSave()}
                disabled={submitting}
                style={[styles.saveBtn, submitting && { opacity: 0.6 }]}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={ui.onPrimary} />
                ) : null}
                <Text style={styles.saveBtnText}>
                  {submitting
                    ? 'Guardando...'
                    : editingBranch
                      ? 'Guardar Cambios'
                      : 'Crear Sucursal'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }
);

export default function BranchesScreen() {
  const router = useRouter();
  const { accountId, branchId, setActiveBranchId } = useAuthSession();
  const { limits } = usePlanAccess();
  const { features, planName } = usePlanFeatures();
  const { refreshConfiguration } = useBusinessSettings();
  const { hasPermission, isOwner, isAdmin } = usePermissions();

  const canAccess =
    hasPermission('access_branches') || hasPermission('manage_branches') || isOwner || isAdmin;
  const canManage = hasPermission('manage_branches') || isOwner || isAdmin;

  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [modalVisible, setModalVisible] = useState(false);
  const [editingBranch, setEditingBranch] = useState<BranchItem | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    if (!features.multiBranch && modalVisible) {
      setModalVisible(false);
    }
  }, [features.multiBranch, modalVisible]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadBranches = useCallback(
    async (isRefresh = false) => {
      if (!accountId || !canAccess || !features.multiBranch) {
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const list = await getBranchesList(accountId);
        if (!isMountedRef.current) return;
        setBranches(list);
      } catch (err: any) {
        if (!isMountedRef.current) return;
        Alert.alert('Error', err?.message || 'No se pudieron cargar las sucursales.');
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [accountId, canAccess, features.multiBranch]
  );

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const filteredBranches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return branches.filter((b) => {
      if (statusFilter === 'active' && !b.isActive) return false;
      if (statusFilter === 'inactive' && b.isActive) return false;
      if (q) {
        const hay = `${b.name} ${b.address || ''} ${b.manager || ''} ${b.ruc || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [branches, searchQuery, statusFilter]);

  const activeCount = useMemo(() => branches.filter((b) => b.isActive).length, [branches]);
  const maxLimit = limits?.branches?.max ?? null;
  const limitLabel =
    maxLimit === null
      ? `${branches.length} registradas`
      : maxLimit < 0 || maxLimit >= 999
        ? `${branches.length} · Ilimitadas`
        : `${branches.length} / ${maxLimit} sucursales`;

  const openCreateModal = useCallback(() => {
    setEditingBranch(null);
    setModalVisible(true);
  }, []);

  const openEditModal = useCallback((branch: BranchItem) => {
    setEditingBranch(branch);
    setModalVisible(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setModalVisible(false);
  }, []);

  const handleBranchSaved = useCallback(async () => {
    await loadBranches(true);
    refreshConfiguration();
  }, [loadBranches, refreshConfiguration]);

  const handleToggleActive = useCallback(
    async (branch: BranchItem) => {
      if (!canManage) return;
      const nextState = !branch.isActive;
      if (!nextState && branch.id === branchId) {
        Alert.alert(
          'Sucursal activa en terminal',
          'Cambia primero a otra sucursal antes de desactivar la sucursal actualmente en uso.'
        );
        return;
      }
      try {
        await toggleBranchActive(branch.id, nextState);
        Haptics.selectionAsync().catch(() => {});
        await loadBranches(true);
        refreshConfiguration();
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'No se pudo cambiar el estado de la sucursal.');
      }
    },
    [canManage, branchId, loadBranches, refreshConfiguration]
  );

  const handleToggleActiveRow = useCallback(
    (branch: BranchItem) => {
      void handleToggleActive(branch);
    },
    [handleToggleActive]
  );

  const handleSwitchBranch = useCallback(
    (branch: BranchItem) => {
      if (!branch.isActive) {
        Alert.alert('Sucursal inactiva', 'Activa la sucursal antes de seleccionarla para operar.');
        return;
      }
      setActiveBranchId(branch.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert('Sucursal seleccionada', `Ahora estás operando en "${branch.name}".`);
    },
    [setActiveBranchId]
  );

  const branchKeyExtractor = useCallback((item: BranchItem) => item.id, []);

  const renderBranchItem = useCallback(
    ({ item }: { item: BranchItem }) => (
      <BranchCard
        item={item}
        isCurrent={item.id === branchId}
        canManage={canManage}
        onToggleActive={handleToggleActiveRow}
        onSwitchBranch={handleSwitchBranch}
        onEdit={openEditModal}
      />
    ),
    [branchId, canManage, handleToggleActiveRow, handleSwitchBranch, openEditModal]
  );

  const listHeaderElement = useMemo(
    () => (
      <View style={styles.headerBlock}>
        <View style={styles.limitCard}>
          <View style={styles.limitIcon}>
            <Building2 size={20} color={ui.primary} />
          </View>
          <View style={styles.limitCopy}>
            <Text style={styles.limitTitle}>Capacidad del Plan</Text>
            <Text style={styles.limitSub}>{limitLabel}</Text>
          </View>
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>{activeCount} activas</Text>
          </View>
        </View>

        <BranchSearchBar onSearchChange={setSearchQuery} />

        <View style={styles.pillsRow}>
          {([
            ['all', 'Todas'],
            ['active', 'Activas'],
            ['inactive', 'Inactivas'],
          ] as const).map(([key, label]) => {
            const selected = statusFilter === key;
            return (
              <TouchableOpacity
                key={key}
                onPress={() => setStatusFilter(key)}
                style={[styles.pill, selected && styles.pillActive]}
              >
                <Text style={[styles.pillText, selected && styles.pillTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading && (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={ui.primary} />
          </View>
        )}
      </View>
    ),
    [limitLabel, activeCount, statusFilter, loading]
  );

  const listEmptyElement = useMemo(
    () =>
      !loading ? (
        <View style={styles.centerBox}>
          <Building2 size={32} color={ui.textMuted} />
          <Text style={styles.mutedText}>No se encontraron sucursales.</Text>
        </View>
      ) : null,
    [loading]
  );

  if (!features.multiBranch) {
    return (
      <PlanLockedView
        feature="multiBranch"
        asScreen
        screenTitle="Sucursales"
        onBack={() => router.back()}
        currentPlanName={planName}
      />
    );
  }

  if (!canAccess) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
            <ArrowLeft size={20} color={ui.text} />
          </TouchableOpacity>
          <Text style={styles.topTitle}>Sucursales</Text>
          <View style={styles.iconBtn} />
        </View>
        <View style={styles.deniedBox}>
          <ShieldAlert size={36} color={ui.danger} />
          <Text style={styles.deniedTitle}>Acceso restringido</Text>
          <Text style={styles.deniedText}>
            Solo propietarios y administradores pueden gestionar las sucursales de la cuenta.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Volver"
        >
          <ArrowLeft size={20} color={ui.text} />
        </TouchableOpacity>
        <View style={styles.titleCopy}>
          <Text style={styles.topTitle}>Sucursales</Text>
          <Text style={styles.topSub}>
            {activeCount} activas · {limitLabel}
          </Text>
        </View>
        {canManage ? (
          <TouchableOpacity
            onPress={openCreateModal}
            style={styles.addBtn}
            accessibilityRole="button"
            accessibilityLabel="Nueva sucursal"
          >
            <Plus size={16} color={ui.onPrimary} />
            <Text style={styles.addBtnText}>Nueva</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => void loadBranches(true)} style={styles.iconBtn}>
            <RefreshCw size={18} color={ui.primary} />
          </TouchableOpacity>
        )}
      </View>

      <FlashList
        data={filteredBranches}
        keyExtractor={branchKeyExtractor}
        getItemType={getBranchItemType}
        extraData={branchId}
        estimatedItemSize={180}
        ItemSeparatorComponent={ListGap10}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadBranches(true)}
            colors={[ui.primary]}
          />
        }
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={listHeaderElement}
        ListEmptyComponent={listEmptyElement}
        renderItem={renderBranchItem}
      />

      {modalVisible && accountId ? (
        <BranchFormModal
          visible={modalVisible}
          accountId={accountId}
          editingBranch={editingBranch}
          onClose={handleCloseModal}
          onSaved={handleBranchSaved}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleCopy: {
    flex: 1,
    minWidth: 0,
  },
  topTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: ui.text,
  },
  topSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 1,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 10,
  },
  addBtnText: {
    color: ui.onPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  listContent: {
    padding: 14,
    paddingBottom: 32,
  },
  listGap10: {
    height: 10,
  },
  headerBlock: {
    gap: 10,
    marginBottom: 14,
  },
  limitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 14,
    padding: 14,
  },
  limitIcon: {
    width: 40,
    height: 40,
    borderRadius: 11,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  limitCopy: {
    flex: 1,
  },
  limitTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  limitSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 1,
  },
  activeBadge: {
    backgroundColor: ui.successSoft,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  activeBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.success,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: ui.text,
    paddingVertical: 8,
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  pillActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  pillTextActive: {
    color: ui.primary,
  },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  mutedText: {
    fontSize: 13,
    color: ui.textSecondary,
  },
  card: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 10,
  },
  cardCurrent: {
    borderColor: ui.primary,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  cardTitleGroup: {
    flex: 1,
    gap: 4,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  branchName: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  currentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  currentChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  statusChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  statusChipText: {
    fontSize: 11,
    fontWeight: '700',
  },
  detailsList: {
    gap: 5,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailText: {
    flex: 1,
    fontSize: 12,
    color: ui.textSecondary,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  useBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  useBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  editBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  editBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.textSecondary,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,28,49,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    paddingTop: 18,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  formContent: {
    padding: 18,
    gap: 10,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
    marginTop: 2,
  },
  input: {
    minHeight: 44,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.background,
    paddingHorizontal: 12,
    fontSize: 14,
    color: ui.text,
  },
  twoCol: {
    flexDirection: 'row',
    gap: 10,
  },
  col: {
    flex: 1,
    gap: 4,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  switchLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  saveBtn: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: ui.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 6,
  },
  saveBtnText: {
    color: ui.onPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  deniedBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 10,
  },
  deniedTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.text,
  },
  deniedText: {
    fontSize: 14,
    color: ui.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
