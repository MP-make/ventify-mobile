import React, { useState, useMemo, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { ui } from '@/lib/theme';
import {
  ROLE_PERMISSIONS,
  type CustomPermissions,
  type Permission,
} from '@/lib/role-permissions';
import {
  PERMISSION_GROUPS,
  createTeamUser,
  updateTeamUser,
  toggleCustomPermission,
  type TeamMember,
  type TeamRole,
  type BranchItem,
  type PermissionGroupDefinition,
} from '@/services/enterprise-ops-service';
import { payrollModalStyles as styles } from './payroll-modal-styles';

interface PermissionGroupCardProps {
  groupKey: string;
  group: PermissionGroupDefinition;
  isExpanded: boolean;
  basePerms: Permission[];
  granted: string[];
  revoked: string[];
  onToggleGroup: (groupKey: string) => void;
  onTogglePermission: (permission: Permission, nextChecked: boolean) => void;
}

const PermissionGroupCard = React.memo<PermissionGroupCardProps>(({
  groupKey,
  group,
  isExpanded,
  basePerms,
  granted,
  revoked,
  onToggleGroup,
  onTogglePermission,
}) => {
  const activeCount = useMemo(
    () =>
      group.permissions.filter(({ key }) =>
        revoked.includes(key) ? false : granted.includes(key) ? true : basePerms.includes(key)
      ).length,
    [group.permissions, basePerms, granted, revoked]
  );

  return (
    <View style={styles.permGroupCard}>
      <TouchableOpacity
        style={styles.permGroupHeader}
        onPress={() => onToggleGroup(groupKey)}
      >
        <Text style={styles.permGroupTitle}>
          {group.label} ({activeCount}/{group.permissions.length})
        </Text>
        {isExpanded ? (
          <ChevronDown size={16} color={ui.textSecondary} />
        ) : (
          <ChevronRight size={16} color={ui.textSecondary} />
        )}
      </TouchableOpacity>

      {isExpanded && (
        <View style={styles.permGroupList}>
          {group.permissions.map(({ key, label }) => {
            const isBase = basePerms.includes(key);
            const isGranted = granted.includes(key);
            const isRevoked = revoked.includes(key);
            const checked = isRevoked ? false : isGranted ? true : isBase;
            return (
              <TouchableOpacity
                key={key}
                style={styles.permItemRow}
                onPress={() => onTogglePermission(key, !checked)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
              >
                <View style={[styles.permCheckbox, checked && styles.permCheckboxChecked]}>
                  {checked && <Check size={12} color={ui.onPrimary} />}
                </View>
                <Text style={styles.permItemLabel}>{label}</Text>
                {isGranted && <Text style={styles.permTagGranted}>Extra</Text>}
                {isRevoked && <Text style={styles.permTagRevoked}>Revocado</Text>}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
});

export interface UserFormModalProps {
  visible: boolean;
  editingMember: TeamMember | null;
  accountId: string | null;
  defaultBranchId: string;
  branchesList: BranchItem[];
  isOwner: boolean;
  isAdminOrOwner: boolean;
  onClose: () => void;
}

/** Sub-modal for creating/editing team members and custom permissions in isolation. */
export const UserFormModal = React.memo<UserFormModalProps>(({
  visible,
  editingMember,
  accountId,
  defaultBranchId,
  branchesList,
  isOwner,
  isAdminOrOwner,
  onClose,
}) => {
  const [name, setName] = useState<string>(() => editingMember?.name || '');
  const [email, setEmail] = useState<string>(() => editingMember?.email || '');
  const [role, setRole] = useState<TeamRole>(() => editingMember?.role || 'cashier');
  const [branchId, setBranchId] = useState<string>(() =>
    editingMember
      ? editingMember.branchId || defaultBranchId || ''
      : defaultBranchId || branchesList.find((b) => b.isActive)?.id || ''
  );
  const [allBranches, setAllBranches] = useState<boolean>(() =>
    Boolean(editingMember?.allBranchesAccess)
  );
  const [phone, setPhone] = useState<string>(() => editingMember?.phone || '');
  const [dni, setDni] = useState<string>(() => editingMember?.dni || '');
  const [salary, setSalary] = useState<string>(() =>
    editingMember?.baseSalary ? String(editingMember.baseSalary) : ''
  );
  const [isActive, setIsActive] = useState<boolean>(() =>
    editingMember ? editingMember.isActive !== false : true
  );
  const [customPerms, setCustomPerms] = useState<CustomPermissions | null>(
    () => editingMember?.customPermissions || null
  );
  const [openPermGroups, setOpenPermGroups] = useState<Record<string, boolean>>({
    ventas: true,
    caja: true,
  });
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const roleOptions = useMemo(
    () =>
      [
        ...(isOwner && editingMember?.role === 'owner'
          ? ([{ key: 'owner', label: 'Dueño' }] as const)
          : []),
        { key: 'admin', label: 'Administrador' },
        { key: 'manager', label: 'Gerente' },
        { key: 'cashier', label: 'Cajero' },
      ] as Array<{ key: TeamRole; label: string }>,
    [isOwner, editingMember?.role]
  );

  const selectableBranches = useMemo(
    () => branchesList.filter((b) => b.isActive || b.id === branchId),
    [branchesList, branchId]
  );

  const basePerms = useMemo(() => ROLE_PERMISSIONS[role] || [], [role]);
  const grantedPerms = customPerms?.granted || [];
  const revokedPerms = customPerms?.revoked || [];

  const handleRequestClose = useCallback(() => {
    if (!isSubmitting) {
      onClose();
    }
  }, [isSubmitting, onClose]);

  const handleTogglePermGroup = useCallback((groupKey: string) => {
    setOpenPermGroups((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  }, []);

  const handleTogglePermission = useCallback(
    (permission: Permission, nextChecked: boolean) => {
      setCustomPerms((prev) => toggleCustomPermission(role, prev, permission, nextChecked));
    },
    [role]
  );

  const handleSaveUser = useCallback(async () => {
    if (!accountId) return;
    if (!name.trim()) {
      Alert.alert('Dato requerido', 'Ingresa el nombre del colaborador.');
      return;
    }
    if (!editingMember && !email.trim()) {
      Alert.alert('Correo requerido', 'Ingresa un correo electrónico válido.');
      return;
    }
    const numericSalary = salary.trim() ? parseFloat(salary.replace(',', '.')) : undefined;
    if (numericSalary !== undefined && (isNaN(numericSalary) || numericSalary < 0)) {
      Alert.alert('Sueldo inválido', 'Ingresa un sueldo base válido mayor o igual a 0.');
      return;
    }

    try {
      setIsSubmitting(true);
      if (editingMember) {
        await updateTeamUser(editingMember.id, {
          accountId,
          name: name.trim(),
          role,
          branchId: allBranches ? null : branchId || null,
          allBranchesAccess: isAdminOrOwner ? allBranches : Boolean(editingMember.allBranchesAccess),
          phone: phone.trim(),
          dni: dni.trim(),
          baseSalary: numericSalary !== undefined ? numericSalary : null,
          isActive,
          customPermissions: customPerms,
        });
        Alert.alert('Usuario Actualizado', `Se guardaron los cambios para ${name.trim()}.`);
      } else {
        const res = await createTeamUser({
          accountId,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          role,
          branchId: allBranches ? undefined : branchId || undefined,
          allBranchesAccess: isAdminOrOwner ? allBranches : false,
          phone: phone.trim() || undefined,
          dni: dni.trim() || undefined,
          baseSalary: numericSalary,
          customPermissions: customPerms,
        });
        Alert.alert(
          'Usuario Creado',
          res?.message ||
            `Se creó la cuenta para ${name.trim()}. Se envió enlace de contraseña al correo.`
        );
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onClose();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar el colaborador.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    accountId,
    editingMember,
    name,
    email,
    role,
    branchId,
    allBranches,
    phone,
    dni,
    salary,
    isActive,
    customPerms,
    isAdminOrOwner,
    onClose,
  ]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleRequestClose}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalDialog, styles.modalDialogTall]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingMember ? 'Editar Colaborador' : 'Nuevo Colaborador'}
              </Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={handleRequestClose}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de colaborador"
              >
                <X size={18} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.dialogInputLabel}>Nombre completo:</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Ej: María López"
                placeholderTextColor={ui.textMuted}
                value={name}
                onChangeText={setName}
              />

              <Text style={styles.dialogInputLabel}>Correo electrónico:</Text>
              <TextInput
                style={[styles.dialogInput, editingMember && styles.dialogInputDisabled]}
                placeholder="correo@negocio.com"
                placeholderTextColor={ui.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                editable={!editingMember}
                value={email}
                onChangeText={setEmail}
              />
              {!editingMember && (
                <Text style={styles.fieldHintText}>
                  Se enviará un enlace de creación de contraseña a este correo.
                </Text>
              )}

              <Text style={styles.dialogInputLabel}>Rol en el negocio:</Text>
              <View style={styles.chipsWrapRow}>
                {roleOptions.map((r) => {
                  const active = role === r.key;
                  return (
                    <TouchableOpacity
                      key={r.key}
                      style={[styles.selectPill, active && styles.selectPillActive]}
                      onPress={() => {
                        setRole(r.key);
                        setCustomPerms(null);
                      }}
                    >
                      <Text style={[styles.selectPillText, active && styles.selectPillTextActive]}>
                        {r.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {isAdminOrOwner && (
                <View style={styles.switchFieldRow}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={styles.switchTitle}>Acceso multisede</Text>
                    <Text style={styles.switchDesc}>
                      Permite operar en todas las sucursales de la cuenta.
                    </Text>
                  </View>
                  <Switch
                    value={allBranches}
                    onValueChange={setAllBranches}
                    trackColor={{ false: ui.border, true: ui.primarySoft }}
                    thumbColor={allBranches ? ui.primary : ui.textMuted}
                  />
                </View>
              )}

              {!allBranches && branchesList.length > 0 && (
                <>
                  <Text style={styles.dialogInputLabel}>Sucursal asignada:</Text>
                  <View style={styles.chipsWrapRow}>
                    {selectableBranches.map((b) => {
                      const active = branchId === b.id;
                      return (
                        <TouchableOpacity
                          key={b.id}
                          style={[styles.selectPill, active && styles.selectPillActive]}
                          onPress={() => setBranchId(b.id)}
                        >
                          <Text
                            style={[styles.selectPillText, active && styles.selectPillTextActive]}
                          >
                            {b.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}

              <View style={styles.twoColRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogInputLabel}>Teléfono:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="987654321"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="phone-pad"
                    value={phone}
                    onChangeText={setPhone}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.dialogInputLabel}>DNI:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="8 dígitos"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    maxLength={12}
                    value={dni}
                    onChangeText={setDni}
                  />
                </View>
              </View>

              <Text style={styles.dialogInputLabel}>Sueldo Base (S/):</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Opcional (ej: 1500.00)"
                placeholderTextColor={ui.textMuted}
                keyboardType="decimal-pad"
                value={salary}
                onChangeText={setSalary}
              />

              {editingMember && (
                <View style={styles.switchFieldRow}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={styles.switchTitle}>Colaborador activo</Text>
                    <Text style={styles.switchDesc}>
                      Si se desactiva, no podrá iniciar sesión ni operar en caja.
                    </Text>
                  </View>
                  <Switch
                    value={isActive}
                    onValueChange={setIsActive}
                    trackColor={{ false: ui.border, true: ui.primarySoft }}
                    thumbColor={isActive ? ui.primary : ui.textMuted}
                  />
                </View>
              )}

              {role !== 'seller' && (
                <View style={styles.permSection}>
                  <View style={styles.permSectionHeader}>
                    <View>
                      <Text style={styles.permSectionTitle}>Permisos personalizados</Text>
                      <Text style={styles.permSectionSub}>
                        Ajusta permisos específicos sobre el rol base
                      </Text>
                    </View>
                    {(grantedPerms.length > 0 || revokedPerms.length > 0) && (
                      <TouchableOpacity
                        style={styles.permResetBtn}
                        onPress={() => setCustomPerms(null)}
                      >
                        <RotateCcw size={13} color={ui.primary} />
                        <Text style={styles.permResetText}>Restaurar</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {Object.entries(PERMISSION_GROUPS).map(([groupKey, group]) => (
                    <PermissionGroupCard
                      key={groupKey}
                      groupKey={groupKey}
                      group={group}
                      isExpanded={Boolean(openPermGroups[groupKey])}
                      basePerms={basePerms}
                      granted={grantedPerms}
                      revoked={revokedPerms}
                      onToggleGroup={handleTogglePermGroup}
                      onTogglePermission={handleTogglePermission}
                    />
                  ))}
                </View>
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                onPress={handleRequestClose}
                disabled={isSubmitting}
              >
                <Text style={styles.dialogCancelText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.dialogSubmitBtn, isSubmitting && styles.buttonDisabled]}
                onPress={handleSaveUser}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator color={ui.onPrimary} size="small" />
                ) : (
                  <>
                    <Check size={15} color={ui.onPrimary} />
                    <Text style={styles.dialogSubmitText}>
                      {editingMember ? 'Guardar cambios' : 'Crear colaborador'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
