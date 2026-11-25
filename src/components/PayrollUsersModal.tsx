/**
 * Ventify Mobile - Payroll & Enterprise Users Modal
 * 
 * Modal nativo de Operaciones Empresariales con 3 sub-pestañas:
 * 1. Equipo y Roles: Directorio de colaboradores, roles, sucursal y estado.
 * 2. Planillas y Adelantos: Registro de pagos/adelantos con opción de descontar
 *    directamente de la Caja Chica Abierta (atómico) e historial de movimientos.
 * 3. Solicitudes de Venta: Bandeja de autorización de descuentos para que
 *    el Administrador o Cajero apruebe, rechace o cargue directo al POS.
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Switch,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList, type ContentStyle } from '@shopify/flash-list';
import {
  X,
  Users,
  Wallet,
  ClipboardList,
  Search,
  Plus,
  CheckCircle2,
  Shield,
  ShoppingCart,
  Building2,
  Phone,
  Mail,
  Check,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { useAuthSession, usePlanFeatures } from '@/context/AuthContext';
import { useBusinessSettings, useCashSession } from '@/context/SettingsContext';
import { useCartActions } from '@/context/CartContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ui, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading } from '@/components/ui';
import {
  TeamMember,
  BranchItem,
  PayrollMovement,
  PayrollConceptType,
  SaleRequest,
  SaleRequestStatus,
  subscribeToTeamMembers,
  subscribeToPayrollMovements,
  subscribeToSaleRequests,
  registerPayrollPayment,
  resolveSaleRequest,
  convertSaleRequest,
  getBranchesList,
  toggleBranchActive,
} from '@/services/enterprise-ops-service';
import type { Product, Customer } from '@/types';
import { CreateSaleRequestModal } from './payroll/CreateSaleRequestModal';
import { RejectSaleRequestModal } from './payroll/RejectSaleRequestModal';
import { UserFormModal } from './payroll/UserFormModal';
import { BranchFormModal } from './payroll/BranchFormModal';

export interface PayrollUsersModalProps {
  visible?: boolean;
  isOpen?: boolean;
  initialTab?: SubTab;
  onClose: () => void;
  onLoadSaleRequestToPos?: (request: SaleRequest) => void;
}

export type SubTab = 'team' | 'payroll' | 'requests' | 'branches';

interface TeamMemberCardItemProps {
  member: TeamMember;
  canEdit: boolean;
  onEdit: (member: TeamMember) => void;
}

const TeamMemberCardItem = React.memo<TeamMemberCardItemProps>(({ member, canEdit, onEdit }) => (
  <View style={styles.memberCard}>
    <View style={styles.memberAvatar}>
      <Text style={styles.memberAvatarText}>
        {member.name.charAt(0).toUpperCase()}
      </Text>
    </View>

    <View style={styles.memberInfoCol}>
      <View style={styles.memberNameRow}>
        <Text style={styles.memberNameText} numberOfLines={1}>
          {member.name}
        </Text>
        {member.isActive ? (
          <View style={styles.activeDot} />
        ) : (
          <Text style={styles.inactiveTag}>Inactivo</Text>
        )}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
        <Text style={[styles.memberRoleBadge, { marginBottom: 0 }]}>{member.roleLabel}</Text>
        {member.allBranchesAccess ? (
          <Text style={styles.multiBranchBadge}>Multisede</Text>
        ) : null}
        {((member.customPermissions?.granted?.length || 0) > 0 ||
          (member.customPermissions?.revoked?.length || 0) > 0) && (
          <Text style={styles.customPermBadge}>Permisos custom</Text>
        )}
      </View>

      {member.email ? (
        <View style={styles.memberMetaRow}>
          <Mail size={12} color={ui.textMuted} />
          <Text style={styles.memberMetaText} numberOfLines={1}>
            {member.email}
          </Text>
        </View>
      ) : null}

      {member.phone ? (
        <View style={styles.memberMetaRow}>
          <Phone size={12} color={ui.textMuted} />
          <Text style={styles.memberMetaText}>{member.phone}</Text>
        </View>
      ) : null}

      {member.branchName ? (
        <View style={styles.memberMetaRow}>
          <Building2 size={12} color={ui.textMuted} />
          <Text style={styles.memberMetaText}>Sede: {member.branchName}</Text>
        </View>
      ) : null}
    </View>

    <View style={{ alignItems: 'flex-end', gap: 6 }}>
      {member.baseSalary ? (
        <View style={styles.salaryCol}>
          <Text style={styles.salaryLabel}>Sueldo Base</Text>
          <Text style={styles.salaryValue}>{formatPEN(member.baseSalary)}</Text>
        </View>
      ) : null}
      {canEdit && (
        <TouchableOpacity
          style={styles.memberEditBtn}
          onPress={() => onEdit(member)}
          accessibilityRole="button"
          accessibilityLabel={`Editar usuario ${member.name}`}
        >
          <Shield size={12} color={ui.primary} />
          <Text style={styles.memberEditBtnText}>Editar</Text>
        </TouchableOpacity>
      )}
    </View>
  </View>
));

const BranchCardItem = React.memo<{
  branch: BranchItem;
  canManage: boolean;
  onEdit: (branch: BranchItem) => void;
  onToggleActive: (branch: BranchItem, next: boolean) => void;
}>(({ branch, canManage, onEdit, onToggleActive }) => (
  <View style={styles.memberCard}>
    <View style={[styles.memberAvatar, { backgroundColor: branch.isActive ? ui.primarySoft : ui.surfaceMuted }]}>
      <Building2 size={18} color={branch.isActive ? ui.primary : ui.textMuted} />
    </View>
    <View style={styles.memberInfoCol}>
      <View style={styles.memberNameRow}>
        <Text style={styles.memberNameText} numberOfLines={1}>
          {branch.name}
        </Text>
        <Text style={branch.isActive ? styles.activeTag : styles.inactiveTag}>
          {branch.isActive ? 'Activa' : 'Inactiva'}
        </Text>
      </View>
      {branch.address ? (
        <Text style={styles.memberMetaText} numberOfLines={1}>
          {branch.address}
        </Text>
      ) : null}
      {branch.phone ? (
        <Text style={styles.memberMetaText}>Tel: {branch.phone}</Text>
      ) : null}
      {branch.ruc ? (
        <Text style={styles.memberMetaText}>RUC: {branch.ruc}</Text>
      ) : null}
    </View>
    {canManage && (
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Switch
          value={branch.isActive}
          onValueChange={(next) => onToggleActive(branch, next)}
          trackColor={{ false: ui.border, true: ui.primarySoft }}
          thumbColor={branch.isActive ? ui.primary : ui.textMuted}
        />
        <TouchableOpacity
          style={styles.memberEditBtn}
          onPress={() => onEdit(branch)}
          accessibilityRole="button"
          accessibilityLabel={`Editar sucursal ${branch.name}`}
        >
          <Text style={styles.memberEditBtnText}>Editar</Text>
        </TouchableOpacity>
      </View>
    )}
  </View>
));

interface PayrollMovementCardItemProps {
  mov: PayrollMovement;
}

const PayrollMovementCardItem = React.memo<PayrollMovementCardItemProps>(({ mov }) => (
  <View style={styles.movementCard}>
    <View style={styles.movementHeader}>
      <View>
        <Text style={styles.movementEmployeeName}>{mov.employeeName}</Text>
        <Text style={styles.movementDateText}>{formatDatePE(mov.date)}</Text>
      </View>

      <View
        style={[
          styles.conceptBadge,
          mov.conceptType === 'advance' && { backgroundColor: ui.warningSoft, borderColor: ui.warning },
          mov.conceptType === 'salary' && { backgroundColor: ui.primarySoft, borderColor: ui.primary },
          mov.conceptType === 'commission' && { backgroundColor: ui.primarySoft, borderColor: ui.primary },
        ]}
      >
        <Text
          style={[
            styles.conceptBadgeText,
            mov.conceptType === 'advance' && { color: ui.warning },
            mov.conceptType === 'salary' && { color: ui.primary },
            mov.conceptType === 'commission' && { color: ui.primary },
          ]}
        >
          {mov.conceptLabel}
        </Text>
      </View>
    </View>

    <View style={styles.movementBody}>
      <View style={styles.movementMetaCol}>
        <Text style={styles.movementMethodText}>Método: {mov.paymentMethod}</Text>
        {mov.deductFromCashDrawer ? (
          <Text style={styles.cashDeductedTag}>• Descontado de Caja Chica</Text>
        ) : null}
        {mov.notes ? (
          <Text style={styles.movementNotesText} numberOfLines={2}>
            "{mov.notes}"
          </Text>
        ) : null}
      </View>

      <Text style={styles.movementAmountText}>{formatPEN(mov.amount)}</Text>
    </View>
  </View>
));

interface SaleRequestCardItemProps {
  req: SaleRequest;
  isSubmitting: boolean;
  onApprove: (req: SaleRequest) => void;
  onReject: (req: SaleRequest) => void;
  onLoadPos: (req: SaleRequest) => void;
  onConvert: (req: SaleRequest) => void;
}

const SaleRequestCardItem = React.memo<SaleRequestCardItemProps>(({
  req,
  isSubmitting,
  onApprove,
  onReject,
  onLoadPos,
  onConvert,
}) => {
  const isPending = req.status === 'pending';
  const isApproved = req.status === 'approved';
  return (
    <View style={styles.requestCard}>
      {/* Cabecera de la solicitud */}
      <View style={styles.requestCardHeader}>
        <View>
          <Text style={styles.requestNumText}>{req.requestNumber}</Text>
          <Text style={styles.requestSellerText}>Vendedor: {req.sellerName}</Text>
          <Text style={styles.requestDateText}>{formatDatePE(req.createdAt)}</Text>
        </View>

        <View
          style={[
            styles.statusBadge,
            req.status === 'pending' && { backgroundColor: ui.warningSoft, borderColor: ui.warning },
            req.status === 'approved' && { backgroundColor: ui.primarySoft, borderColor: ui.primary },
            req.status === 'converted' && { backgroundColor: ui.primarySoft, borderColor: ui.primary },
            req.status === 'rejected' && { backgroundColor: ui.dangerSoft, borderColor: ui.danger },
          ]}
        >
          <Text
            style={[
              styles.statusBadgeText,
              req.status === 'pending' && { color: ui.warning },
              req.status === 'approved' && { color: ui.primary },
              req.status === 'converted' && { color: ui.primary },
              req.status === 'rejected' && { color: ui.danger },
            ]}
          >
            {req.status === 'pending'
              ? 'Pendiente'
              : req.status === 'approved'
              ? 'Aprobada'
              : req.status === 'converted'
              ? 'Convertida'
              : 'Rechazada'}
          </Text>
        </View>
      </View>

      <View style={styles.divider} />

      {/* Cliente y Motivo */}
      <Text style={styles.requestClientText}>Cliente: {req.customerName}</Text>
      {req.reason ? (
        <Text style={styles.requestReasonText}>Motivo: "{req.reason}"</Text>
      ) : null}

      {/* Productos */}
      <View style={styles.requestItemsBox}>
        {req.items.map((it, idx) => (
          <View key={idx} style={styles.requestItemRow}>
            <Text style={styles.requestItemName}>
              {it.quantity}x {it.productName}
            </Text>
            <View style={styles.requestItemPriceCol}>
              <Text style={styles.requestOriginalPrice}>{formatPEN(it.originalPrice)}</Text>
              <Text style={styles.requestDiscountedPrice}>{formatPEN(it.requestedPrice)}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* Totales */}
      <View style={styles.requestTotalsRow}>
        <Text style={styles.requestDiscountText}>
          Ahorro: -{formatPEN(req.discountTotal)}
        </Text>
        <Text style={styles.requestTotalText}>Total: {formatPEN(req.total)}</Text>
      </View>

      {/* Acciones */}
      <View style={styles.requestActionsRow}>
        {isPending && (
          <>
            <TouchableOpacity
              style={styles.approveBtn}
              onPress={() => onApprove(req)}
              disabled={isSubmitting}
            >
              <Check size={14} color={ui.onPrimary} />
              <Text style={styles.approveBtnText}>Aprobar</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.rejectBtn}
              onPress={() => onReject(req)}
              disabled={isSubmitting}
            >
              <X size={14} color={ui.danger} />
              <Text style={styles.rejectBtnText}>Rechazar</Text>
            </TouchableOpacity>
          </>
        )}

        {(isApproved || isPending) && (
          <>
            <TouchableOpacity
              style={styles.loadPosBtn}
              onPress={() => onLoadPos(req)}
              disabled={isSubmitting}
            >
              <ShoppingCart size={14} color={ui.onPrimary} />
              <Text style={styles.loadPosBtnText}>Al POS</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.convertBtn}
              onPress={() => onConvert(req)}
              disabled={isSubmitting}
            >
              <CheckCircle2 size={14} color={ui.primary} />
              <Text style={styles.convertBtnText}>Convertir</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
});

const teamMemberKeyExtractor = (item: TeamMember) => item.id;
const payrollMovementKeyExtractor = (item: PayrollMovement) => item.id;
const saleRequestKeyExtractor = (item: SaleRequest) => item.id;
const branchKeyExtractor = (item: BranchItem) => item.id;
const PayrollListGap10 = () => <View style={{ height: 10 }} />;

export const PayrollUsersModal: React.FC<PayrollUsersModalProps> = React.memo(({
  visible,
  isOpen,
  initialTab = 'team',
  onClose,
  onLoadSaleRequestToPos,
}) => {
  const insets = useSafeAreaInsets();
  const isVisible = visible !== undefined ? visible : Boolean(isOpen);

  const { accountId, branchId, userProfile } = useAuthSession();
  const { features } = usePlanFeatures();
  const { hasPermission, isOwner, isAdmin } = usePermissions();
  const { activeBranchName, refreshConfiguration } = useBusinessSettings();
  const { isCashOpen, activeCashSession } = useCashSession();
  const { clearCart, addItem, setCustomer, setNotes, setSaleRequestId, setShippingAmount } = useCartActions();

  const canManageUsers = isOwner || isAdmin || hasPermission('manage_users');
  const canManageBranches =
    features.multiBranch && (isOwner || isAdmin || hasPermission('manage_branches'));
  const isAdminOrOwner = isOwner || isAdmin;

  // Pestaña activa
  const [activeTab, setActiveTab] = useState<SubTab>(
    initialTab === 'branches' && !features.multiBranch ? 'team' : initialTab
  );
  useEffect(() => {
    if (isVisible && initialTab) {
      setActiveTab(initialTab === 'branches' && !features.multiBranch ? 'team' : initialTab);
    }
  }, [isVisible, initialTab, features.multiBranch]);

  useEffect(() => {
    if (!features.multiBranch && activeTab === 'branches') {
      setActiveTab('team');
    }
  }, [features.multiBranch, activeTab]);

  // Estados de datos
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [branchesList, setBranchesList] = useState<BranchItem[]>([]);
  const [payrollMovements, setPayrollMovements] = useState<PayrollMovement[]>([]);
  const [payrollLoadError, setPayrollLoadError] = useState<string | null>(null);
  const [saleRequests, setSaleRequests] = useState<SaleRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Filtros
  const [searchQuery, setSearchQuery] = useState<string>('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 150);
  const [requestFilter, setRequestFilter] = useState<SaleRequestStatus | 'all'>('all');

  // Sub-vista en Planilla ('history' o 'new_payment')
  const [payrollSubView, setPayrollSubView] = useState<'history' | 'new_payment'>('history');

  // Formulario de Pago de Planilla / Adelanto
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [conceptType, setConceptType] = useState<PayrollConceptType>('advance');
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('Efectivo');
  const [paymentNotes, setPaymentNotes] = useState<string>('');
  const [deductFromCash, setDeductFromCash] = useState<boolean>(true);

  // Disparadores para sub-modales montados condicionalmente
  const [rejectTarget, setRejectTarget] = useState<SaleRequest | null>(null);
  const [userFormVisible, setUserFormVisible] = useState<boolean>(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [branchFormVisible, setBranchFormVisible] = useState<boolean>(false);

  useEffect(() => {
    if (!features.multiBranch && branchFormVisible) {
      setBranchFormVisible(false);
    }
  }, [features.multiBranch, branchFormVisible]);
  const [editingBranch, setEditingBranch] = useState<BranchItem | null>(null);
  const [showCreateRequestModal, setShowCreateRequestModal] = useState<boolean>(false);

  const branchesLoadStateRef = useRef<{
    loadedAccountId: string | null;
    inFlight: { accountId: string; seq: number; promise: Promise<void> } | null;
    requestSeq: number;
  }>({ loadedAccountId: null, inFlight: null, requestSeq: 0 });

  const loadBranches = useCallback(async (force: boolean = false) => {
    if (!accountId || !features.multiBranch) return;
    const state = branchesLoadStateRef.current;
    if (!force && state.loadedAccountId === accountId) {
      return;
    }
    if (!force && state.inFlight?.accountId === accountId) {
      return state.inFlight.promise;
    }

    const seq = ++state.requestSeq;
    const request = (async () => {
      try {
        const list = await getBranchesList(accountId);
        if (branchesLoadStateRef.current.requestSeq === seq) {
          setBranchesList(list);
          branchesLoadStateRef.current.loadedAccountId = accountId;
        }
      } catch (err) {
        console.warn('[PayrollUsersModal] Error cargando sucursales:', err);
      } finally {
        if (branchesLoadStateRef.current.inFlight?.seq === seq) {
          branchesLoadStateRef.current.inFlight = null;
        }
      }
    })();

    state.inFlight = { accountId, seq, promise: request };
    return request;
  }, [accountId, features.multiBranch]);

  useEffect(() => {
    if (!isVisible || !features.multiBranch) {
      branchesLoadStateRef.current.loadedAccountId = null;
      branchesLoadStateRef.current.inFlight = null;
      branchesLoadStateRef.current.requestSeq += 1;
      return;
    }
    if (accountId) {
      void loadBranches();
    }
  }, [isVisible, accountId, features.multiBranch, loadBranches]);

  // 1. Suscripciones en tiempo real según pestaña activa
  useEffect(() => {
    if (!isVisible || !accountId || !features.teamManagement) return;

    let isActive = true;
    let unsubTeam: (() => void) | undefined;
    let unsubPayroll: (() => void) | undefined;
    let unsubRequests: (() => void) | undefined;

    setLoading(true);

    if (activeTab === 'team' || activeTab === 'payroll') {
      unsubTeam = subscribeToTeamMembers(accountId, (data) => {
        setTeamMembers(data);
        if (data.length > 0) {
          setSelectedEmployeeId((prev) => prev || data[0].id);
        }
        if (activeTab === 'team') setLoading(false);
      });
    }

    if (activeTab === 'payroll') {
      unsubPayroll = subscribeToPayrollMovements(accountId, (data) => {
        setPayrollMovements(data);
        setPayrollLoadError(null);
        setLoading(false);
      }, branchId, (error) => {
        setPayrollLoadError(error instanceof Error ? error.message : 'No se pudo cargar el historial de planilla.');
        setLoading(false);
      });
    }

    if (activeTab === 'requests') {
      unsubRequests = subscribeToSaleRequests(accountId, (data) => {
        setSaleRequests(data);
        setLoading(false);
      }, branchId);
    }

    if (activeTab === 'branches') {
      if (!features.multiBranch) {
        setLoading(false);
        return;
      }
      void loadBranches().finally(() => {
        if (isActive) setLoading(false);
      });
    }

    return () => {
      isActive = false;
      unsubTeam?.();
      unsubPayroll?.();
      unsubRequests?.();
    };
  }, [isVisible, accountId, branchId, activeTab, features.teamManagement, features.multiBranch, loadBranches]);

  // Colaborador seleccionado en el formulario
  const currentSelectedEmployee = useMemo(() => {
    return teamMembers.find((m) => m.id === selectedEmployeeId) || teamMembers[0] || null;
  }, [teamMembers, selectedEmployeeId]);

  // Lista filtrada de miembros del equipo
  const filteredTeam = useMemo(() => {
    const q = debouncedSearchQuery.toLowerCase().trim();
    if (!q) return teamMembers;
    return teamMembers.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.roleLabel.toLowerCase().includes(q) ||
        (m.phone && m.phone.includes(q))
    );
  }, [teamMembers, debouncedSearchQuery]);

  // Lista filtrada de solicitudes de venta (sin clonar el array innecesariamente)
  const filteredRequests = useMemo(() => {
    const q = debouncedSearchQuery.toLowerCase().trim();
    if (requestFilter === 'all' && !q) {
      return saleRequests;
    }
    return saleRequests.filter((r) => {
      if (requestFilter !== 'all' && r.status !== requestFilter) return false;
      if (!q) return true;
      return (
        r.requestNumber.toLowerCase().includes(q) ||
        r.customerName.toLowerCase().includes(q) ||
        r.sellerName.toLowerCase().includes(q) ||
        r.items.some((it) => it.productName.toLowerCase().includes(q))
      );
    });
  }, [saleRequests, requestFilter, debouncedSearchQuery]);

  const pendingRequestsCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < saleRequests.length; i += 1) {
      if (saleRequests[i].status === 'pending') count += 1;
    }
    return count;
  }, [saleRequests]);

  // Totales de nómina en una sola pasada
  const payrollStats = useMemo(() => {
    let totalAdvances = 0;
    let totalSalaries = 0;
    let totalCommissions = 0;
    let totalPaid = 0;
    for (let i = 0; i < payrollMovements.length; i += 1) {
      const p = payrollMovements[i];
      totalPaid += p.amount;
      if (p.conceptType === 'advance') totalAdvances += p.amount;
      else if (p.conceptType === 'salary') totalSalaries += p.amount;
      else if (p.conceptType === 'commission') totalCommissions += p.amount;
    }

    return { totalAdvances, totalSalaries, totalCommissions, totalPaid };
  }, [payrollMovements]);

  // ==========================================================================
  // HANDLERS: PLANILLAS Y ADELANTOS
  // ==========================================================================

  const handleRegisterPayrollPayment = async () => {
    if (!currentSelectedEmployee) {
      Alert.alert('Atención', 'Selecciona a un colaborador para registrar el pago.');
      return;
    }

    const numAmount = parseFloat(paymentAmount.replace(',', '.'));
    if (isNaN(numAmount) || numAmount <= 0) {
      Alert.alert('Monto Inválido', 'Ingresa un monto numérico positivo.');
      return;
    }

    // Validar si se desea descontar de caja pero está cerrada
    const targetSessionId = activeCashSession?.sessionId || activeCashSession?.id || null;
    if (deductFromCash && !isCashOpen) {
      Alert.alert(
        'Caja Cerrada',
        'No hay una sesión de caja chica abierta en esta sucursal para realizar el egreso en efectivo.\n\nDesactiva el descuento de caja o abre caja primero.',
        [{ text: 'Entendido' }]
      );
      return;
    }

    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      const result = await registerPayrollPayment({
        accountId: accountId || '',
        branchId: branchId || 'main',
        branchName: activeBranchName || 'Tienda Principal',
        sessionId: deductFromCash ? targetSessionId : null,
        employeeId: currentSelectedEmployee.id,
        employeeName: currentSelectedEmployee.name,
        employeeRole: currentSelectedEmployee.roleLabel,
        amount: numAmount,
        conceptType,
        paymentMethod,
        notes: paymentNotes.trim(),
        deductFromCashDrawer: deductFromCash && Boolean(targetSessionId),
        userProfile,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      Alert.alert(
        'Pago Registrado Exitosamente',
        `Se registró ${formatPEN(result.amount)} a favor de ${currentSelectedEmployee.name}.${
          result.deductedFromCash
            ? '\n\n✅ Se descontó automáticamente del efectivo de la Caja Chica activa.'
            : ''
        }`
      );

      // Limpiar formulario y volver al historial
      setPaymentAmount('');
      setPaymentNotes('');
      setPayrollSubView('history');
    } catch (err: any) {
      console.error('[PayrollUsersModal] Error registrando remuneración:', err);
      Alert.alert('Error', err?.message || 'No se pudo registrar el pago al colaborador.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ==========================================================================
  // HANDLERS: SOLICITUDES DE VENTA
  // ==========================================================================

  // Aprobar solicitud
  const handleApproveRequest = useCallback(async (request: SaleRequest) => {
    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      await resolveSaleRequest(request.id, 'approved', userProfile, 'Aprobado por el Administrador/Caja', branchId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Alert.alert('Solicitud Aprobada', `La solicitud ${request.requestNumber} fue aprobada.`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo aprobar la solicitud.');
    } finally {
      setIsSubmitting(false);
    }
  }, [userProfile, branchId]);

  // Rechazar solicitud (modal cross-platform montado condicionalmente)
  const handleRejectRequest = useCallback((request: SaleRequest) => {
    setRejectTarget(request);
  }, []);

  const handleCloseRejectModal = useCallback(() => {
    setRejectTarget(null);
  }, []);

  const handleConvertRequest = useCallback((request: SaleRequest) => {
    const sessionId = activeCashSession?.sessionId || activeCashSession?.id;
    Alert.alert(
      'Convertir a Venta',
      `¿Convertir directamente la solicitud ${request.requestNumber} (${formatPEN(request.total)}) en una venta real?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Convertir',
          onPress: async () => {
            try {
              setIsSubmitting(true);
              const res = await convertSaleRequest(request.id, {
                branchId: branchId || request.branchId || undefined,
                ...(sessionId ? { sessionId } : {}),
                paymentMethod: 'Efectivo',
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              Alert.alert(
                'Venta Creada',
                res?.saleNumber
                  ? `Solicitud convertida exitosamente en la venta #${res.saleNumber}.`
                  : 'Solicitud convertida en venta exitosamente.'
              );
            } catch (err: any) {
              Alert.alert('No se pudo convertir', err?.message || 'Inténtalo desde el carrito POS o revisa el stock.');
            } finally {
              setIsSubmitting(false);
            }
          },
        },
      ]
    );
  }, [branchId, activeCashSession]);

  // Handlers de Usuarios y Permisos
  const handleOpenCreateUser = useCallback(() => {
    setEditingMember(null);
    setUserFormVisible(true);
  }, []);

  const handleOpenEditUser = useCallback((member: TeamMember) => {
    setEditingMember(member);
    setUserFormVisible(true);
  }, []);

  const handleCloseUserForm = useCallback(() => {
    setUserFormVisible(false);
  }, []);

  // Handlers de Sucursales (Branches CRUD)
  const handleOpenCreateBranch = useCallback(() => {
    setEditingBranch(null);
    setBranchFormVisible(true);
  }, []);

  const handleOpenEditBranch = useCallback((b: BranchItem) => {
    setEditingBranch(b);
    setBranchFormVisible(true);
  }, []);

  const handleCloseBranchForm = useCallback(() => {
    setBranchFormVisible(false);
  }, []);

  const handleBranchSaved = useCallback(async () => {
    await loadBranches(true);
    void refreshConfiguration();
  }, [loadBranches, refreshConfiguration]);

  const handleToggleBranchActive = useCallback(async (branch: BranchItem, next: boolean) => {
    const activeCount = branchesList.filter((b) => b.isActive).length;
    if (!next && branch.isActive && activeCount <= 1) {
      Alert.alert('Sucursal única', 'No puedes desactivar la única sucursal activa de la cuenta.');
      return;
    }
    try {
      setIsSubmitting(true);
      await toggleBranchActive(branch.id, next);
      await loadBranches(true);
      void refreshConfiguration();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo actualizar el estado de la sucursal.');
    } finally {
      setIsSubmitting(false);
    }
  }, [branchesList, loadBranches, refreshConfiguration]);

  // Cargar solicitud al Carrito POS
  const handleLoadRequestToPos = useCallback(async (request: SaleRequest) => {
    try {
      setIsSubmitting(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      // 1. Limpiar carrito actual
      clearCart();

      // 2. Cargar cliente si existe
      if (request.customerId && request.customerName && request.customerName !== 'Cliente General') {
        const clientObj: Customer = {
          id: request.customerId,
          name: request.customerName,
          phone: request.customerPhone || undefined,
          email: request.customerEmail || undefined,
          totalPurchases: 0,
          totalSpent: 0,
          accountId: accountId || '',
        };
        setCustomer(clientObj);
      } else setCustomer(null);

      // 3. Cargar cada ítem al carrito con el precio solicitado
      request.items.forEach((item) => {
        const requestedPrice = Number(item.requestedPrice ?? item.price) || 0;
        const originalPrice = Number(item.originalPrice ?? item.price) || requestedPrice;
        const stubProduct: Product = {
          id: item.productId,
          name: item.productName,
          category: 'General',
          sku: item.sku || item.productId,
          costPrice: 0,
          minSalePrice: 0,
          suggestedPrice: originalPrice,
          price: requestedPrice,
          stock: {},
          accountId: accountId || '',
        };

        addItem(stubProduct, {
          quantity: item.quantity,
          customPrice: requestedPrice,
          presentation: item.presentationId
            ? {
                id: item.presentationId,
                name: item.presentationName || '',
                conversionFactor: Number(item.presentationQty || item.conversionFactor) || 1,
                price: requestedPrice,
              }
            : undefined,
          variant: item.variantId
            ? {
                id: item.variantId,
                name: item.variantName || '',
                stock: {},
              }
            : undefined,
        });
      });
      // Keep the approved request associated with the cart. Checkout will pass
      // this ID to the server so conversion is atomic with the actual sale.
      setSaleRequestId(request.id);
      setShippingAmount(Number(request.shipping) || 0);

      // 4. Copiar nota
      setNotes(`Solicitud ${request.requestNumber} - Vendedor: ${request.sellerName}${request.reason ? ` (${request.reason})` : ''}`);

      if (onLoadSaleRequestToPos) {
        onLoadSaleRequestToPos(request);
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onClose();

      Alert.alert(
        'Solicitud Cargada al Carrito POS',
        `Productos y precios autorizados cargados exitosamente.${request.shipping ? `\nEnvío: ${formatPEN(request.shipping)}` : ''}\nTotal a Cobrar: ${formatPEN(request.total)}`,
        [{ text: 'Proceder al Cobro' }]
      );
    } catch (err: any) {
      console.error('[PayrollUsersModal] Error al cargar solicitud al POS:', err);
      Alert.alert('Error', err?.message || 'No se pudo cargar la solicitud al carrito.');
    } finally {
      setIsSubmitting(false);
    }
  }, [accountId, clearCart, setCustomer, addItem, setSaleRequestId, setShippingAmount, setNotes, onLoadSaleRequestToPos, onClose]);

  const handleOpenCreateRequestModal = useCallback(() => {
    setShowCreateRequestModal(true);
  }, []);

  const handleCloseCreateRequestModal = useCallback(() => {
    setShowCreateRequestModal(false);
  }, []);

  const listContentContainerStyle = useMemo<ContentStyle>(
    () => ({ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 20 }),
    [insets.bottom]
  );

  const renderTeamMemberItem = useCallback(
    ({ item }: { item: TeamMember }) => (
      <TeamMemberCardItem
        member={item}
        canEdit={canManageUsers}
        onEdit={handleOpenEditUser}
      />
    ),
    [canManageUsers, handleOpenEditUser]
  );

  const renderPayrollMovementItem = useCallback(
    ({ item }: { item: PayrollMovement }) => <PayrollMovementCardItem mov={item} />,
    []
  );

  const renderSaleRequestItem = useCallback(
    ({ item }: { item: SaleRequest }) => (
      <SaleRequestCardItem
        req={item}
        isSubmitting={isSubmitting}
        onApprove={handleApproveRequest}
        onReject={handleRejectRequest}
        onLoadPos={handleLoadRequestToPos}
        onConvert={handleConvertRequest}
      />
    ),
    [
      isSubmitting,
      handleApproveRequest,
      handleRejectRequest,
      handleLoadRequestToPos,
      handleConvertRequest,
    ]
  );

  const renderBranchItem = useCallback(
    ({ item }: { item: BranchItem }) => (
      <BranchCardItem
        branch={item}
        canManage={canManageBranches}
        onEdit={handleOpenEditBranch}
        onToggleActive={handleToggleBranchActive}
      />
    ),
    [canManageBranches, handleOpenEditBranch, handleToggleBranchActive]
  );

  if (!isVisible) return null;

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.container}>
        <ScreenHeading
          title="Equipo y administración"
          subtitle={activeBranchName || 'Personal, planillas, sucursales y solicitudes'}
          action={(
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cerrar equipo y planilla"
          >
            <X size={20} color={ui.textSecondary} />
          </TouchableOpacity>
          )}
        />

        {/* Barra de Sub-pestañas sin scroll: activo con título, inactivos solo ícono */}
        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'team' ? styles.tabButtonActive : styles.tabButtonIconOnly]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setActiveTab('team');
            }}
            accessibilityRole="tab"
            accessibilityLabel={`Equipo (${teamMembers.length})`}
            accessibilityState={{ selected: activeTab === 'team' }}
          >
            <Users size={16} color={activeTab === 'team' ? ui.primary : ui.textSecondary} />
            {activeTab === 'team' ? (
              <Text style={[styles.tabButtonText, styles.tabButtonTextActive]} numberOfLines={1}>
                Equipo ({teamMembers.length})
              </Text>
            ) : null}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'payroll' ? styles.tabButtonActive : styles.tabButtonIconOnly]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setActiveTab('payroll');
            }}
            accessibilityRole="tab"
            accessibilityLabel="Planilla"
            accessibilityState={{ selected: activeTab === 'payroll' }}
          >
            <Wallet size={16} color={activeTab === 'payroll' ? ui.primary : ui.textSecondary} />
            {activeTab === 'payroll' ? (
              <Text style={[styles.tabButtonText, styles.tabButtonTextActive]} numberOfLines={1}>
                Planilla
              </Text>
            ) : null}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'requests' ? styles.tabButtonActive : styles.tabButtonIconOnly]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setActiveTab('requests');
            }}
            accessibilityRole="tab"
            accessibilityLabel={`Solicitudes (${pendingRequestsCount})`}
            accessibilityState={{ selected: activeTab === 'requests' }}
          >
            <ClipboardList
              size={16}
              color={activeTab === 'requests' ? ui.primary : ui.textSecondary}
            />
            {activeTab === 'requests' ? (
              <Text style={[styles.tabButtonText, styles.tabButtonTextActive]} numberOfLines={1}>
                Solicitudes ({pendingRequestsCount})
              </Text>
            ) : pendingRequestsCount > 0 ? (
              <View style={styles.tabPendingDot} />
            ) : null}
          </TouchableOpacity>

          {features.multiBranch ? (
            <TouchableOpacity
              style={[styles.tabButton, activeTab === 'branches' ? styles.tabButtonActive : styles.tabButtonIconOnly]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                setActiveTab('branches');
              }}
              accessibilityRole="tab"
              accessibilityLabel={`Sucursales (${branchesList.length})`}
              accessibilityState={{ selected: activeTab === 'branches' }}
            >
              <Building2
                size={16}
                color={activeTab === 'branches' ? ui.primary : ui.textSecondary}
              />
              {activeTab === 'branches' ? (
                <Text style={[styles.tabButtonText, styles.tabButtonTextActive]} numberOfLines={1}>
                  Sucursales ({branchesList.length})
                </Text>
              ) : null}
            </TouchableOpacity>
          ) : null}
        </View>

        {/* CONTENIDO SEGÚN SUB-PESTAÑA */}
        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.loadingText}>Cargando datos de operaciones...</Text>
          </View>
        ) : (
          <View style={styles.tabContentContainer}>
            {/* PESTAÑA 1: EQUIPO Y ROLES */}
            {activeTab === 'team' && (
              <View style={{ flex: 1 }}>
                {/* Buscador + Botón Nuevo en una misma fila */}
                <View style={styles.searchActionRow}>
                  <View style={styles.searchBarInline}>
                    <Search size={16} color={ui.textSecondary} />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Buscar por nombre, rol o email..."
                      placeholderTextColor={ui.textMuted}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                    />
                    {searchQuery.length > 0 && (
                      <TouchableOpacity onPress={() => setSearchQuery('')}>
                        <X size={14} color={ui.textMuted} />
                      </TouchableOpacity>
                    )}
                  </View>
                  {canManageUsers ? (
                    <TouchableOpacity
                      style={styles.newRequestBtn}
                      onPress={handleOpenCreateUser}
                      accessibilityRole="button"
                      accessibilityLabel="Crear colaborador"
                    >
                      <Plus size={16} color={ui.onPrimary} />
                      <Text style={styles.newRequestBtnText}>Nuevo</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>

                <FlashList
                  data={filteredTeam}
                  renderItem={renderTeamMemberItem}
                  estimatedItemSize={100}
                  keyExtractor={teamMemberKeyExtractor}
                  extraData={canManageUsers}
                  contentContainerStyle={listContentContainerStyle}
                  ItemSeparatorComponent={PayrollListGap10}
                  showsVerticalScrollIndicator={false}
                />
              </View>
            )}

            {/* PESTAÑA 2: PLANILLAS Y ADELANTOS */}
            {activeTab === 'payroll' && (
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionSubOnly}>Control de remuneraciones y adelantos</Text>
                {/* Sub-navegación: Historial vs Registrar Pago */}
                <View style={styles.payrollSubTabsRow}>
                  <TouchableOpacity
                    style={[styles.payrollSubTab, payrollSubView === 'history' && styles.payrollSubTabActive]}
                    onPress={() => setPayrollSubView('history')}
                  >
                    <Text
                      style={[
                        styles.payrollSubTabText,
                        payrollSubView === 'history' && styles.payrollSubTabTextActive,
                      ]}
                    >
                      Historial ({payrollMovements.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.payrollSubTab,
                      payrollSubView === 'new_payment' && styles.payrollSubTabActive,
                    ]}
                    onPress={() => setPayrollSubView('new_payment')}
                  >
                    <Plus size={14} color={payrollSubView === 'new_payment' ? ui.primary : ui.textSecondary} />
                    <Text
                      style={[
                        styles.payrollSubTabText,
                        payrollSubView === 'new_payment' && styles.payrollSubTabTextActive,
                      ]}
                    >
                      Registrar pago
                    </Text>
                  </TouchableOpacity>
                </View>

                {payrollSubView === 'new_payment' ? (
                  /* FORMULARIO DE REGISTRO DE PAGO / ADELANTO */
                  <ScrollView
                    style={styles.scrollList}
                    contentContainerStyle={[styles.formContent, { paddingBottom: insets.bottom + 30 }]}
                  >
                    {/* 1. Seleccionar Colaborador */}
                    <Text style={styles.inputLabel}>Colaborador a Remunerar:</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.employeeChipsContainer}
                    >
                      {teamMembers.map((emp) => {
                        const isSelected = emp.id === currentSelectedEmployee?.id;
                        return (
                          <TouchableOpacity
                            key={emp.id}
                            style={[styles.employeeChip, isSelected && styles.employeeChipSelected]}
                            onPress={() => {
                              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                              setSelectedEmployeeId(emp.id);
                            }}
                          >
                            <Text
                              style={[
                                styles.employeeChipText,
                                isSelected && styles.employeeChipTextSelected,
                              ]}
                            >
                              {emp.name}
                            </Text>
                            <Text style={styles.employeeChipRole}>{emp.roleLabel}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    {/* 2. Concepto */}
                    <Text style={[styles.inputLabel, { marginTop: 14 }]}>Tipo de Concepto:</Text>
                    <View style={styles.conceptsRow}>
                      {(
                        [
                          { key: 'advance', label: 'Adelanto' },
                          { key: 'salary', label: 'Sueldo' },
                          { key: 'commission', label: 'Comisión' },
                          { key: 'bonus', label: 'Bono' },
                        ] as const
                      ).map((c) => {
                        const isSelected = conceptType === c.key;
                        return (
                          <TouchableOpacity
                            key={c.key}
                            style={[styles.conceptChip, isSelected && styles.conceptChipSelected]}
                            onPress={() => {
                              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                              setConceptType(c.key);
                            }}
                          >
                            <Text
                              style={[
                                styles.conceptChipText,
                                isSelected && styles.conceptChipTextSelected,
                              ]}
                            >
                              {c.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {/* 3. Monto en Soles */}
                    <Text style={[styles.inputLabel, { marginTop: 14 }]}>Monto en Soles (PEN):</Text>
                    <View style={styles.amountInputRow}>
                      <Text style={styles.amountCurrencyPrefix}>S/</Text>
                      <TextInput
                        style={styles.amountInput}
                        placeholder="0.00"
                        placeholderTextColor={ui.textMuted}
                        keyboardType="decimal-pad"
                        value={paymentAmount}
                        onChangeText={setPaymentAmount}
                      />
                    </View>

                    {/* 4. Método de Pago */}
                    <Text style={[styles.inputLabel, { marginTop: 14 }]}>Método de Pago:</Text>
                    <View style={styles.conceptsRow}>
                      {['Efectivo', 'Transferencia', 'Yape/Plin'].map((m) => {
                        const isSelected = paymentMethod === m;
                        return (
                          <TouchableOpacity
                            key={m}
                            style={[styles.conceptChip, isSelected && styles.conceptChipSelected]}
                            onPress={() => setPaymentMethod(m)}
                          >
                            <Text
                              style={[
                                styles.conceptChipText,
                                isSelected && styles.conceptChipTextSelected,
                              ]}
                            >
                              {m}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {/* 5. Switch: Descontar de Caja Chica Abierta */}
                    <View style={styles.cashDrawerSwitchCard}>
                      <View style={{ flex: 1, marginRight: 12 }}>
                        <Text style={styles.switchTitle}>Descontar de la Caja Abierta actual</Text>
                        <Text style={styles.switchDesc}>
                          {isCashOpen
                            ? `Caja chica activa: ${formatPEN(activeCashSession?.expectedAmount || activeCashSession?.openingBalance || 0)} en mostrador`
                            : '⚠️ Caja chica cerrada. Abre caja para egreso en mostrador.'}
                        </Text>
                      </View>
                      <Switch
                        value={deductFromCash && isCashOpen}
                        onValueChange={(val) => {
                          if (!isCashOpen) {
                            Alert.alert('Caja Cerrada', 'Debes abrir una sesión de caja antes.');
                            return;
                          }
                          setDeductFromCash(val);
                        }}
                        trackColor={{ false: ui.border, true: ui.primary }}
                        thumbColor={ui.primary}
                      />
                    </View>

                    {/* 6. Notas */}
                    <Text style={[styles.inputLabel, { marginTop: 14 }]}>Motivo u Observaciones:</Text>
                    <TextInput
                      style={styles.notesInput}
                      placeholder="Ej: Adelanto quincenal de sueldo acordado..."
                      placeholderTextColor={ui.textMuted}
                      value={paymentNotes}
                      onChangeText={setPaymentNotes}
                      multiline
                    />

                    {/* Botón de Confirmación */}
                    <TouchableOpacity
                      style={[styles.submitButton, isSubmitting && styles.buttonDisabled]}
                      onPress={handleRegisterPayrollPayment}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <ActivityIndicator color={ui.onPrimary} />
                      ) : (
                        <>
                          <CheckCircle2 size={18} color={ui.onPrimary} />
                          <Text style={styles.submitButtonText}>Registrar Remuneración</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </ScrollView>
                ) : (
                  /* HISTORIAL DE MOVIMIENTOS DE PLANILLA */
                  <View style={{ flex: 1 }}>
                    {payrollLoadError ? (
                      <Text style={{ color: ui.danger, marginBottom: 12 }}>
                        No se pudo cargar el historial completo. {payrollLoadError}
                      </Text>
                    ) : null}
                    {/* Tarjetas de Métricas de Planilla */}
                    <View style={styles.payrollStatsCard}>
                      <View style={styles.statBox}>
                        <Text style={styles.statVal}>{formatPEN(payrollStats.totalPaid)}</Text>
                        <Text style={styles.statLabel}>Total Desembolsado</Text>
                      </View>
                      <View style={styles.statDivider} />
                      <View style={styles.statBox}>
                        <Text style={[styles.statVal, { color: ui.warning }]}>
                          {formatPEN(payrollStats.totalAdvances)}
                        </Text>
                        <Text style={styles.statLabel}>Adelantos</Text>
                      </View>
                      <View style={styles.statDivider} />
                      <View style={styles.statBox}>
                        <Text style={[styles.statVal, { color: ui.primary }]}>
                          {formatPEN(payrollStats.totalCommissions)}
                        </Text>
                        <Text style={styles.statLabel}>Comisiones</Text>
                      </View>
                    </View>

                    {payrollMovements.length === 0 && !payrollLoadError ? (
                      <View style={styles.centerBox}>
                        <Wallet size={44} color={ui.textMuted} />
                        <Text style={styles.emptyTitle}>Sin movimientos de planilla</Text>
                        <Text style={styles.emptySubtitle}>
                          Registra un adelanto de sueldo o pago para ver el historial aquí.
                        </Text>
                      </View>
                    ) : (
                      <FlashList
                        data={payrollMovements}
                        renderItem={renderPayrollMovementItem}
                        estimatedItemSize={110}
                        keyExtractor={payrollMovementKeyExtractor}
                        contentContainerStyle={listContentContainerStyle}
                        ItemSeparatorComponent={PayrollListGap10}
                        showsVerticalScrollIndicator={false}
                      />
                    )}
                  </View>
                )}
              </View>
            )}

            {/* PESTAÑA 3: BANDEJA DE SOLICITUDES DE VENTA */}
            {activeTab === 'requests' && (
              <View style={{ flex: 1 }}>
                <View style={styles.sectionCompactRow}>
                  <Text style={styles.sectionCompactSub} numberOfLines={1}>
                    Revisa descuentos y autoriza pedidos
                  </Text>
                  <TouchableOpacity
                    style={styles.newRequestBtn}
                    onPress={handleOpenCreateRequestModal}
                    accessibilityRole="button"
                    accessibilityLabel="Crear solicitud de venta"
                  >
                    <Plus size={15} color={ui.onPrimary} />
                    <Text style={styles.newRequestBtnText}>Nueva</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.requestsHeaderRow}>
                  <View style={styles.filterChipsRow}>
                    {(
                      [
                        { key: 'all', label: 'Todas' },
                        { key: 'pending', label: 'Pendientes' },
                        { key: 'approved', label: 'Aprobadas' },
                        { key: 'converted', label: 'En POS' },
                        { key: 'rejected', label: 'Rechazadas' },
                      ] as const
                    ).map((f) => (
                      <TouchableOpacity
                        key={f.key}
                        style={[styles.filterChip, requestFilter === f.key && styles.filterChipActive]}
                        onPress={() => setRequestFilter(f.key)}
                      >
                        <Text
                          style={[styles.filterChipText, requestFilter === f.key && styles.filterChipTextActive]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          minimumFontScale={0.75}
                        >
                          {f.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {filteredRequests.length === 0 ? (
                  <View style={styles.centerBox}>
                    <ClipboardList size={44} color={ui.textMuted} />
                    <Text style={styles.emptyTitle}>Bandeja de Solicitudes Vacía</Text>
                    <Text style={styles.emptySubtitle}>
                      Los vendedores pueden enviar solicitudes de descuento para autorización de caja.
                    </Text>
                  </View>
                ) : (
                  <FlashList
                    data={filteredRequests}
                    renderItem={renderSaleRequestItem}
                    estimatedItemSize={190}
                    keyExtractor={saleRequestKeyExtractor}
                    extraData={isSubmitting}
                    contentContainerStyle={listContentContainerStyle}
                    ItemSeparatorComponent={PayrollListGap10}
                    showsVerticalScrollIndicator={false}
                  />
                )}
              </View>
            )}

            {/* PESTAÑA 4: SUCURSALES (BRANCHES CRUD) */}
            {features.multiBranch && activeTab === 'branches' && (
              <View style={{ flex: 1 }}>
                <View style={styles.sectionCompactRow}>
                  <Text style={styles.sectionCompactSub} numberOfLines={1}>
                    {branchesList.length} sedes registradas
                  </Text>
                  {canManageBranches ? (
                    <TouchableOpacity
                      style={styles.newRequestBtn}
                      onPress={handleOpenCreateBranch}
                      accessibilityRole="button"
                      accessibilityLabel="Crear sucursal"
                    >
                      <Plus size={15} color={ui.onPrimary} />
                      <Text style={styles.newRequestBtnText}>Nueva</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {branchesList.length === 0 ? (
                  <View style={styles.centerBox}>
                    <Building2 size={44} color={ui.textMuted} />
                    <Text style={styles.emptyTitle}>Sin sucursales cargadas</Text>
                    <Text style={styles.emptySubtitle}>
                      Crea una sucursal para operar múltiples sedes.
                    </Text>
                  </View>
                ) : (
                  <FlashList
                    data={branchesList}
                    renderItem={renderBranchItem}
                    estimatedItemSize={100}
                    keyExtractor={branchKeyExtractor}
                    extraData={canManageBranches}
                    contentContainerStyle={listContentContainerStyle}
                    ItemSeparatorComponent={PayrollListGap10}
                    showsVerticalScrollIndicator={false}
                  />
                )}
              </View>
            )}
          </View>
        )}

        {showCreateRequestModal && (
          <CreateSaleRequestModal
            visible={showCreateRequestModal}
            accountId={accountId}
            branchId={branchId}
            activeBranchName={activeBranchName}
            userProfile={userProfile}
            onClose={handleCloseCreateRequestModal}
          />
        )}

        {rejectTarget && (
          <RejectSaleRequestModal
            visible={Boolean(rejectTarget)}
            target={rejectTarget}
            userProfile={userProfile}
            branchId={branchId}
            onClose={handleCloseRejectModal}
          />
        )}

        {userFormVisible && (
          <UserFormModal
            key={editingMember?.id || 'new'}
            visible={userFormVisible}
            editingMember={editingMember}
            accountId={accountId}
            defaultBranchId={branchId}
            branchesList={branchesList}
            isOwner={isOwner}
            isAdminOrOwner={isAdminOrOwner}
            onClose={handleCloseUserForm}
          />
        )}

        {features.multiBranch && branchFormVisible && (
          <BranchFormModal
            key={editingBranch?.id || 'new'}
            visible={branchFormVisible}
            editingBranch={editingBranch}
            accountId={accountId}
            onSaved={handleBranchSaved}
            onClose={handleCloseBranchForm}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
});

// ============================================================================
// ESTILOS NATIVOS
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ui.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: ui.text,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Pestañas
  tabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 4,
    borderRadius: 14,
    backgroundColor: ui.surfaceMuted,
  },
  tabButton: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 11,
    gap: 5,
    position: 'relative',
  },
  tabButtonIconOnly: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 6,
  },
  tabButtonActive: {
    flexShrink: 0,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  tabPendingDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: ui.danger,
  },
  tabButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  tabButtonTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  tabContentContainer: {
    flex: 1,
  },
  searchActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  searchBarInline: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 42,
    gap: 6,
    borderWidth: 1,
    borderColor: ui.border,
  },
  // Buscador
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    marginHorizontal: 20,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    gap: 8,
    borderWidth: 1,
    borderColor: ui.border,
    minHeight: 48,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: ui.text,
  },
  scrollList: {
    flex: 1,
  },
  // Tarjetas de miembros
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
    gap: 12,
  },
  memberAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  memberAvatarText: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.primary,
  },
  memberInfoCol: {
    flex: 1,
    gap: 2,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberNameText: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: ui.success,
  },
  activeTag: {
    fontSize: 10,
    color: ui.success,
    fontWeight: '700',
  },
  inactiveTag: {
    fontSize: 10,
    color: ui.danger,
    fontWeight: '700',
  },
  memberRoleBadge: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
    marginTop: 1,
  },
  multiBranchBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.primary,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  customPermBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.accent,
    backgroundColor: ui.accentSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  memberEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  memberEditBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  memberMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  memberMetaText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  salaryCol: {
    alignItems: 'flex-end',
  },
  salaryLabel: {
    fontSize: 10,
    color: ui.textMuted,
  },
  salaryValue: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  // Sub-tabs Planillas
  payrollSubTabsRow: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginVertical: 10,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    padding: 3,
  },
  payrollSubTab: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    gap: 4,
  },
  payrollSubTabActive: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  payrollSubTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  payrollSubTabTextActive: {
    color: ui.text,
    fontWeight: '700',
  },
  // Formulario Planilla
  formContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    gap: 4,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 4,
  },
  employeeChipsContainer: {
    gap: 8,
    paddingBottom: 4,
  },
  employeeChip: {
    backgroundColor: ui.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 12,
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
  },
  employeeChipSelected: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  employeeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  employeeChipTextSelected: {
    color: ui.primary,
    fontWeight: '800',
  },
  employeeChipRole: {
    fontSize: 10,
    color: ui.textMuted,
    marginTop: 2,
  },
  conceptsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  conceptChip: {
    flex: 1,
    backgroundColor: ui.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    alignItems: 'center',
  },
  conceptChipSelected: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  conceptChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  conceptChipTextSelected: {
    color: ui.primary,
    fontWeight: '700',
  },
  amountInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 12,
    minHeight: 52,
  },
  amountCurrencyPrefix: {
    fontSize: 18,
    fontWeight: '800',
    color: ui.primary,
    marginRight: 6,
  },
  amountInput: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: ui.text,
    paddingVertical: 10,
  },
  cashDrawerSwitchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 12,
    marginTop: 14,
  },
  switchTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  switchDesc: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  notesInput: {
    backgroundColor: ui.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    fontSize: 15,
    color: ui.text,
    minHeight: 50,
  },
  submitButton: {
    backgroundColor: ui.primary,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    paddingVertical: 14,
    gap: 8,
    marginTop: 18,
  },
  submitButtonText: {
    color: ui.onPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  // Historial Nómina
  payrollStatsCard: {
    flexDirection: 'row',
    backgroundColor: ui.surface,
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statVal: {
    fontSize: 15,
    fontWeight: '800',
    color: ui.text,
  },
  statLabel: {
    fontSize: 10,
    color: ui.textSecondary,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: ui.border,
  },
  movementCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 12,
  },
  movementHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  movementEmployeeName: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  movementDateText: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 1,
  },
  conceptBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  conceptBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  movementBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  movementMetaCol: {
    flex: 1,
    gap: 2,
  },
  movementMethodText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  cashDeductedTag: {
    fontSize: 11,
    color: ui.primary,
    fontWeight: '600',
  },
  movementNotesText: {
    fontSize: 11,
    color: ui.textMuted,
    fontStyle: 'italic',
  },
  movementAmountText: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  // Solicitudes
  sectionSubOnly: {
    fontSize: 12,
    color: ui.textSecondary,
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 6,
  },
  sectionCompactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  sectionCompactSub: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  requestsHeaderRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  filterChipsRow: {
    flexDirection: 'row',
    gap: 5,
  },
  filterChip: {
    flex: 1,
    minWidth: 0,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderRadius: 17,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  filterChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  filterChipText: {
    fontSize: 11,
    color: ui.textSecondary,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  newRequestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.primary,
    borderRadius: 16,
    paddingHorizontal: 10,
    minHeight: 48,
    paddingVertical: 8,
    gap: 4,
  },
  newRequestBtnText: {
    color: ui.onPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  requestCard: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 14,
  },
  requestCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  requestNumText: {
    fontSize: 14,
    fontWeight: '800',
    color: ui.primary,
  },
  requestSellerText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    marginTop: 2,
  },
  requestDateText: {
    fontSize: 11,
    color: ui.textMuted,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  requestClientText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  requestReasonText: {
    fontSize: 12,
    color: ui.warning,
    fontStyle: 'italic',
    marginTop: 2,
  },
  requestItemsBox: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    gap: 6,
  },
  requestItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  requestItemName: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    flex: 1,
  },
  requestItemPriceCol: {
    alignItems: 'flex-end',
  },
  requestOriginalPrice: {
    fontSize: 10,
    color: ui.textMuted,
    textDecorationLine: 'line-through',
  },
  requestDiscountedPrice: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.primary,
  },
  requestTotalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  requestDiscountText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.warning,
  },
  requestTotalText: {
    fontSize: 16,
    fontWeight: '800',
    color: ui.text,
  },
  requestActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  approveBtn: {
    flex: 1,
    backgroundColor: ui.primary,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 4,
  },
  approveBtnText: {
    color: ui.onPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  rejectBtn: {
    flex: 1,
    backgroundColor: ui.dangerSoft,
    borderWidth: 1,
    borderColor: ui.dangerSoft,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 8,
    gap: 4,
  },
  rejectBtnText: {
    color: ui.danger,
    fontSize: 12,
    fontWeight: '700',
  },
  loadPosBtn: {
    flex: 1.2,
    backgroundColor: ui.primary,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 8,
    gap: 4,
  },
  loadPosBtnText: {
    color: ui.onPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  convertBtn: {
    flex: 1,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 8,
    gap: 4,
  },
  convertBtnText: {
    color: ui.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: ui.border,
    marginVertical: 8,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    marginTop: 40,
  },
  loadingText: {
    color: ui.textSecondary,
    fontSize: 14,
    marginTop: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
    marginTop: 14,
  },
  emptySubtitle: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});

export default PayrollUsersModal;
