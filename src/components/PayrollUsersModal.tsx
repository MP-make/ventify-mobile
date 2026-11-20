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
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import {
  X,
  Users,
  Wallet,
  ClipboardList,
  Search,
  Plus,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  DollarSign,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  ShoppingCart,
  Send,
  Building2,
  Phone,
  Mail,
  Check,
  RotateCcw,
  Receipt,
  UserCheck,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useCart } from '@/context/CartContext';
import { useProducts } from '@/context/ProductsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { ui, theme, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import {
  ROLE_PERMISSIONS,
  type CustomPermissions,
  type Permission,
} from '@/lib/role-permissions';
import {
  TeamMember,
  TeamRole,
  BranchItem,
  PayrollMovement,
  PayrollConceptType,
  SaleRequest,
  SaleRequestStatus,
  PERMISSION_GROUPS,
  subscribeToTeamMembers,
  subscribeToPayrollMovements,
  subscribeToSaleRequests,
  registerPayrollPayment,
  resolveSaleRequest,
  convertSaleRequest,
  createSaleRequest,
  createTeamUser,
  updateTeamUser,
  toggleCustomPermission,
  getBranchesList,
  saveBranchRecord,
  toggleBranchActive,
} from '@/services/enterprise-ops-service';
import type { Product, Customer } from '@/types';

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

export const PayrollUsersModal: React.FC<PayrollUsersModalProps> = React.memo(({
  visible,
  isOpen,
  initialTab = 'team',
  onClose,
  onLoadSaleRequestToPos,
}) => {
  const insets = useSafeAreaInsets();
  const isVisible = visible !== undefined ? visible : Boolean(isOpen);

  const { accountId, branchId, userProfile, role } = useAuth();
  const { hasPermission, isOwner, isAdmin } = usePermissions();
  const { isCashOpen, activeCashSession, activeBranchName, refreshConfiguration } = useSettings();
  const { clearCart, addItem, setCustomer, setNotes, setSaleRequestId, setShippingAmount } = useCart();
  const { products } = useProducts();

  const canManageUsers = isOwner || isAdmin || hasPermission('manage_users');
  const canManageBranches = isOwner || isAdmin || hasPermission('manage_branches');
  const isAdminOrOwner = isOwner || isAdmin;

  // Pestaña activa
  const [activeTab, setActiveTab] = useState<SubTab>(initialTab);
  useEffect(() => {
    if (isVisible && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isVisible, initialTab]);

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

  // Modal de rechazo cross-platform (sin Alert.prompt)
  const [rejectTarget, setRejectTarget] = useState<SaleRequest | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');

  // Modal Crear / Editar Usuario + PermissionEditor
  const [userFormVisible, setUserFormVisible] = useState<boolean>(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [userFormName, setUserFormName] = useState<string>('');
  const [userFormEmail, setUserFormEmail] = useState<string>('');
  const [userFormRole, setUserFormRole] = useState<TeamRole>('cashier');
  const [userFormBranchId, setUserFormBranchId] = useState<string>('');
  const [userFormAllBranches, setUserFormAllBranches] = useState<boolean>(false);
  const [userFormPhone, setUserFormPhone] = useState<string>('');
  const [userFormDni, setUserFormDni] = useState<string>('');
  const [userFormSalary, setUserFormSalary] = useState<string>('');
  const [userFormIsActive, setUserFormIsActive] = useState<boolean>(true);
  const [userFormCustomPerms, setUserFormCustomPerms] = useState<CustomPermissions | null>(null);
  const [openPermGroups, setOpenPermGroups] = useState<Record<string, boolean>>({
    ventas: true,
    caja: true,
  });

  // Modal Crear / Editar Sucursal
  const [branchFormVisible, setBranchFormVisible] = useState<boolean>(false);
  const [editingBranch, setEditingBranch] = useState<BranchItem | null>(null);
  const [branchFormName, setBranchFormName] = useState<string>('');
  const [branchFormAddress, setBranchFormAddress] = useState<string>('');
  const [branchFormPhone, setBranchFormPhone] = useState<string>('');
  const [branchFormEmail, setBranchFormEmail] = useState<string>('');
  const [branchFormManager, setBranchFormManager] = useState<string>('');
  const [branchFormBusinessName, setBranchFormBusinessName] = useState<string>('');
  const [branchFormRuc, setBranchFormRuc] = useState<string>('');
  const [branchFormFooter, setBranchFormFooter] = useState<string>('');
  const [branchFormIsActive, setBranchFormIsActive] = useState<boolean>(true);

  // Formulario rápido para crear solicitud de prueba/vendedor
  const [showCreateRequestModal, setShowCreateRequestModal] = useState<boolean>(false);
  const [reqCustomerName, setReqCustomerName] = useState<string>('');
  const [reqProductName, setReqProductName] = useState<string>('');
  const [reqSelectedProduct, setReqSelectedProduct] = useState<Product | null>(null);
  const [reqOriginalPrice, setReqOriginalPrice] = useState<string>('');
  const [reqRequestedPrice, setReqRequestedPrice] = useState<string>('');
  const [reqQuantity, setReqQuantity] = useState<string>('1');
  const [reqReason, setReqReason] = useState<string>('');

  const branchesLoadStateRef = useRef<{
    loadedAccountId: string | null;
    inFlight: { accountId: string; seq: number; promise: Promise<void> } | null;
    requestSeq: number;
  }>({ loadedAccountId: null, inFlight: null, requestSeq: 0 });

  const loadBranches = useCallback(async (force: boolean = false) => {
    if (!accountId) return;
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
  }, [accountId]);

  useEffect(() => {
    if (!isVisible) {
      branchesLoadStateRef.current.loadedAccountId = null;
      branchesLoadStateRef.current.inFlight = null;
      branchesLoadStateRef.current.requestSeq += 1;
      return;
    }
    if (accountId) {
      void loadBranches();
    }
  }, [isVisible, accountId, loadBranches]);

  // 1. Suscripciones en tiempo real según pestaña activa
  useEffect(() => {
    if (!isVisible || !accountId) return;

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
  }, [isVisible, accountId, branchId, activeTab, loadBranches]);

  // Colaborador seleccionado en el formulario
  const currentSelectedEmployee = useMemo(() => {
    return teamMembers.find((m) => m.id === selectedEmployeeId) || teamMembers[0] || null;
  }, [teamMembers, selectedEmployeeId]);

  // Lista filtrada de miembros del equipo
  const filteredTeam = useMemo(() => {
    if (!searchQuery.trim()) return teamMembers;
    const q = searchQuery.toLowerCase().trim();
    return teamMembers.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.roleLabel.toLowerCase().includes(q) ||
        (m.phone && m.phone.includes(q))
    );
  }, [teamMembers, searchQuery]);

  // Lista filtrada de solicitudes de venta
  const filteredRequests = useMemo(() => {
    let result = [...saleRequests];
    if (requestFilter !== 'all') {
      result = result.filter((r) => r.status === requestFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (r) =>
          r.requestNumber.toLowerCase().includes(q) ||
          r.customerName.toLowerCase().includes(q) ||
          r.sellerName.toLowerCase().includes(q) ||
          r.items.some((it) => it.productName.toLowerCase().includes(q))
      );
    }
    return result;
  }, [saleRequests, requestFilter, searchQuery]);

  const requestProductMatches = useMemo(() => {
    const query = reqProductName.trim().toLowerCase();
    if (!query) return [];
    return products
      .filter((product) => product.name.toLowerCase().includes(query)
        || (product.sku || '').toLowerCase().includes(query))
      .slice(0, 8);
  }, [products, reqProductName]);

  // Totales de nómina
  const payrollStats = useMemo(() => {
    const totalAdvances = payrollMovements
      .filter((p) => p.conceptType === 'advance')
      .reduce((sum, p) => sum + p.amount, 0);
    const totalSalaries = payrollMovements
      .filter((p) => p.conceptType === 'salary')
      .reduce((sum, p) => sum + p.amount, 0);
    const totalCommissions = payrollMovements
      .filter((p) => p.conceptType === 'commission')
      .reduce((sum, p) => sum + p.amount, 0);
    const totalPaid = payrollMovements.reduce((sum, p) => sum + p.amount, 0);

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

  // Rechazar solicitud (modal cross-platform con TextInput en lugar de Alert.prompt)
  const handleRejectRequest = useCallback((request: SaleRequest) => {
    setRejectReason('');
    setRejectTarget(request);
  }, []);

  const handleConfirmRejectRequest = useCallback(async () => {
    if (!rejectTarget) return;
    try {
      setIsSubmitting(true);
      await resolveSaleRequest(
        rejectTarget.id,
        'rejected',
        userProfile,
        rejectReason.trim() || 'Descuento no autorizado',
        branchId
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setRejectTarget(null);
      setRejectReason('');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo rechazar la solicitud.');
    } finally {
      setIsSubmitting(false);
    }
  }, [rejectTarget, rejectReason, userProfile, branchId]);

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
    setUserFormName('');
    setUserFormEmail('');
    setUserFormRole('cashier');
    setUserFormBranchId(branchId || branchesList.find((b) => b.isActive)?.id || '');
    setUserFormAllBranches(false);
    setUserFormPhone('');
    setUserFormDni('');
    setUserFormSalary('');
    setUserFormIsActive(true);
    setUserFormCustomPerms(null);
    setUserFormVisible(true);
  }, [branchId, branchesList]);

  const handleOpenEditUser = useCallback((member: TeamMember) => {
    setEditingMember(member);
    setUserFormName(member.name || '');
    setUserFormEmail(member.email || '');
    setUserFormRole(member.role || 'cashier');
    setUserFormBranchId(member.branchId || branchId || '');
    setUserFormAllBranches(Boolean(member.allBranchesAccess));
    setUserFormPhone(member.phone || '');
    setUserFormDni(member.dni || '');
    setUserFormSalary(member.baseSalary ? String(member.baseSalary) : '');
    setUserFormIsActive(member.isActive !== false);
    setUserFormCustomPerms(member.customPermissions || null);
    setUserFormVisible(true);
  }, [branchId]);

  const handleSaveUser = useCallback(async () => {
    if (!accountId) return;
    if (!userFormName.trim()) {
      Alert.alert('Dato requerido', 'Ingresa el nombre del colaborador.');
      return;
    }
    if (!editingMember && !userFormEmail.trim()) {
      Alert.alert('Correo requerido', 'Ingresa un correo electrónico válido.');
      return;
    }
    const numericSalary = userFormSalary.trim() ? parseFloat(userFormSalary.replace(',', '.')) : undefined;
    if (numericSalary !== undefined && (isNaN(numericSalary) || numericSalary < 0)) {
      Alert.alert('Sueldo inválido', 'Ingresa un sueldo base válido mayor o igual a 0.');
      return;
    }

    try {
      setIsSubmitting(true);
      if (editingMember) {
        await updateTeamUser(editingMember.id, {
          accountId,
          name: userFormName.trim(),
          role: userFormRole,
          branchId: userFormAllBranches ? null : userFormBranchId || null,
          allBranchesAccess: isAdminOrOwner ? userFormAllBranches : Boolean(editingMember.allBranchesAccess),
          phone: userFormPhone.trim(),
          dni: userFormDni.trim(),
          baseSalary: numericSalary !== undefined ? numericSalary : null,
          isActive: userFormIsActive,
          customPermissions: userFormCustomPerms,
        });
        Alert.alert('Usuario Actualizado', `Se guardaron los cambios para ${userFormName.trim()}.`);
      } else {
        const res = await createTeamUser({
          accountId,
          name: userFormName.trim(),
          email: userFormEmail.trim().toLowerCase(),
          role: userFormRole,
          branchId: userFormAllBranches ? undefined : userFormBranchId || undefined,
          allBranchesAccess: isAdminOrOwner ? userFormAllBranches : false,
          phone: userFormPhone.trim() || undefined,
          dni: userFormDni.trim() || undefined,
          baseSalary: numericSalary,
          customPermissions: userFormCustomPerms,
        });
        Alert.alert(
          'Usuario Creado',
          res?.message || `Se creó la cuenta para ${userFormName.trim()}. Se envió enlace de contraseña al correo.`
        );
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setUserFormVisible(false);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar el colaborador.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    accountId,
    editingMember,
    userFormName,
    userFormEmail,
    userFormRole,
    userFormBranchId,
    userFormAllBranches,
    userFormPhone,
    userFormDni,
    userFormSalary,
    userFormIsActive,
    userFormCustomPerms,
    isAdminOrOwner,
  ]);

  // Handlers de Sucursales (Branches CRUD)
  const handleOpenCreateBranch = useCallback(() => {
    setEditingBranch(null);
    setBranchFormName('');
    setBranchFormAddress('');
    setBranchFormPhone('');
    setBranchFormEmail('');
    setBranchFormManager('');
    setBranchFormBusinessName('');
    setBranchFormRuc('');
    setBranchFormFooter('');
    setBranchFormIsActive(true);
    setBranchFormVisible(true);
  }, []);

  const handleOpenEditBranch = useCallback((b: BranchItem) => {
    setEditingBranch(b);
    setBranchFormName(b.name || '');
    setBranchFormAddress(b.address || '');
    setBranchFormPhone(b.phone || '');
    setBranchFormEmail(b.email || '');
    setBranchFormManager(b.manager || '');
    setBranchFormBusinessName(b.businessName || '');
    setBranchFormRuc(b.ruc || '');
    setBranchFormFooter(b.receiptFooter || '');
    setBranchFormIsActive(b.isActive !== false);
    setBranchFormVisible(true);
  }, []);

  const handleSaveBranch = useCallback(async () => {
    if (!accountId) return;
    if (!branchFormName.trim()) {
      Alert.alert('Nombre requerido', 'Ingresa el nombre de la sucursal.');
      return;
    }
    try {
      setIsSubmitting(true);
      await saveBranchRecord({
        id: editingBranch?.id,
        accountId,
        name: branchFormName.trim(),
        address: branchFormAddress.trim(),
        phone: branchFormPhone.trim(),
        email: branchFormEmail.trim(),
        manager: branchFormManager.trim(),
        businessName: branchFormBusinessName.trim(),
        ruc: branchFormRuc.trim(),
        receiptFooter: branchFormFooter.trim(),
        isActive: branchFormIsActive,
      });
      await loadBranches(true);
      void refreshConfiguration();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setBranchFormVisible(false);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar la sucursal.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    accountId,
    editingBranch,
    branchFormName,
    branchFormAddress,
    branchFormPhone,
    branchFormEmail,
    branchFormManager,
    branchFormBusinessName,
    branchFormRuc,
    branchFormFooter,
    branchFormIsActive,
    loadBranches,
    refreshConfiguration,
  ]);

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

  // Crear nueva solicitud de venta (para vendedores de piso)
  const handleCreateSaleRequest = async () => {
    const origPrice = parseFloat(reqOriginalPrice.replace(',', '.'));
    const reqPrice = parseFloat(reqRequestedPrice.replace(',', '.'));
    const qty = parseFloat(reqQuantity) || 1;

    if (!reqSelectedProduct?.id || isNaN(origPrice) || isNaN(reqPrice) || !Number.isFinite(qty) || qty <= 0 || reqPrice <= 0 || origPrice <= 0) {
      Alert.alert('Datos Incompletos', 'Selecciona un producto del catálogo e ingresa cantidad y precios válidos.');
      return;
    }

    try {
      setIsSubmitting(true);
      const discount = Math.max(0, (origPrice - reqPrice) * qty);
      const subtotal = origPrice * qty;
      const total = reqPrice * qty;

      await createSaleRequest({
        accountId: accountId || '',
        branchId: branchId || 'main',
        branchName: activeBranchName || 'Tienda Principal',
        sellerId: userProfile?.uid || 'seller_pos',
        sellerName: userProfile?.displayName || userProfile?.email || 'Vendedor de Piso',
        sellerEmail: userProfile?.email || '',
        customerName: reqCustomerName.trim() || 'Cliente General',
        items: [
          {
            productId: reqSelectedProduct.id,
            productName: reqSelectedProduct.name,
            sku: reqSelectedProduct.sku || '',
            quantity: qty,
            originalPrice: origPrice,
            requestedPrice: reqPrice,
            price: reqPrice,
            subtotal: total,
            discountAmount: discount,
          },
        ],
        subtotal,
        discountTotal: discount,
        total,
        reason: reqReason.trim() || 'Descuento especial por volumen',
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCreateRequestModal(false);
      setReqCustomerName('');
      setReqProductName('');
      setReqSelectedProduct(null);
      setReqProductName('');
      setReqOriginalPrice('');
      setReqRequestedPrice('');
      setReqReason('');
      Alert.alert('Solicitud Enviada', 'La solicitud de venta fue enviada a la bandeja de autorización.');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo enviar la solicitud.');
    } finally {
      setIsSubmitting(false);
    }
  };

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
            accessibilityLabel={`Solicitudes (${saleRequests.filter((r) => r.status === 'pending').length})`}
            accessibilityState={{ selected: activeTab === 'requests' }}
          >
            <ClipboardList
              size={16}
              color={activeTab === 'requests' ? ui.primary : ui.textSecondary}
            />
            {activeTab === 'requests' ? (
              <Text style={[styles.tabButtonText, styles.tabButtonTextActive]} numberOfLines={1}>
                Solicitudes ({saleRequests.filter((r) => r.status === 'pending').length})
              </Text>
            ) : saleRequests.some((r) => r.status === 'pending') ? (
              <View style={styles.tabPendingDot} />
            ) : null}
          </TouchableOpacity>

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
                  renderItem={({ item }) => (
                    <TeamMemberCardItem
                      member={item}
                      canEdit={canManageUsers}
                      onEdit={handleOpenEditUser}
                    />
                  )}
                  estimatedItemSize={100}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 20 }] as any}
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
                        renderItem={({ item }) => <PayrollMovementCardItem mov={item} />}
                        estimatedItemSize={110}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 20 }] as any}
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
                    onPress={() => setShowCreateRequestModal(true)}
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
                      renderItem={({ item }) => (
                        <SaleRequestCardItem
                          req={item}
                          isSubmitting={isSubmitting}
                          onApprove={handleApproveRequest}
                          onReject={handleRejectRequest}
                          onLoadPos={handleLoadRequestToPos}
                          onConvert={handleConvertRequest}
                        />
                      )}
                      estimatedItemSize={190}
                      keyExtractor={(item) => item.id}
                      contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 20 }] as any}
                      showsVerticalScrollIndicator={false}
                    />
                )}
              </View>
            )}

            {/* PESTAÑA 4: SUCURSALES (BRANCHES CRUD) */}
            {activeTab === 'branches' && (
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
                    renderItem={({ item }) => (
                      <BranchCardItem
                        branch={item}
                        canManage={canManageBranches}
                        onEdit={handleOpenEditBranch}
                        onToggleActive={handleToggleBranchActive}
                      />
                    )}
                    estimatedItemSize={100}
                    keyExtractor={(item) => item.id}
                    contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 20 }] as any}
                    showsVerticalScrollIndicator={false}
                  />
                )}
              </View>
            )}
          </View>
        )}

        {/* MODAL INTERNO: CREAR NUEVA SOLICITUD DE DESCUENTO */}
        <Modal
          visible={showCreateRequestModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowCreateRequestModal(false)}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
              <View style={styles.modalDialog}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Nueva Solicitud de Venta</Text>
                  <TouchableOpacity
                    style={styles.closeButton}
                    onPress={() => setShowCreateRequestModal(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar nueva solicitud"
                  >
                    <X size={18} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

              <ScrollView style={{ maxHeight: 420 }}>
                <Text style={styles.dialogInputLabel}>Cliente:</Text>
                <TextInput
                  style={styles.dialogInput}
                  placeholder="Nombre de cliente o razón social"
                  placeholderTextColor={ui.textMuted}
                  value={reqCustomerName}
                  onChangeText={setReqCustomerName}
                />

                <Text style={styles.dialogInputLabel}>Producto del catálogo:</Text>
                <TextInput
                  style={styles.dialogInput}
                  placeholder="Buscar por nombre o SKU"
                  placeholderTextColor={ui.textMuted}
                  value={reqProductName}
                  onChangeText={(value) => { setReqProductName(value); setReqSelectedProduct(null); }}
                />
                {reqSelectedProduct ? (
                  <TouchableOpacity
                    style={[styles.dialogInput, { borderColor: ui.primary, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}
                    onPress={() => { setReqSelectedProduct(null); setReqProductName(''); }}
                  >
                    <Text style={{ color: ui.text, flex: 1 }}>{reqSelectedProduct.name} · {reqSelectedProduct.sku || 'Sin SKU'}</Text>
                    <Text style={{ color: ui.primary }}>Cambiar</Text>
                  </TouchableOpacity>
                ) : requestProductMatches.length > 0 ? (
                  <View style={{ borderWidth: 1, borderColor: ui.border, borderRadius: 10, marginBottom: 10, overflow: 'hidden' }}>
                    {requestProductMatches.map((product) => (
                      <TouchableOpacity
                        key={product.id}
                        style={{ padding: 11, borderBottomWidth: 1, borderBottomColor: ui.border }}
                        onPress={() => {
                          setReqSelectedProduct(product);
                          setReqProductName(product.name);
                          const listPrice = Number(product.suggestedPrice || product.price || 0);
                          setReqOriginalPrice(String(listPrice));
                          setReqRequestedPrice(String(listPrice));
                        }}
                      >
                        <Text style={{ color: ui.text, fontWeight: '600' }}>{product.name}</Text>
                        <Text style={{ color: ui.textMuted, fontSize: 12 }}>{product.sku || 'Sin SKU'} · {formatPEN(Number(product.suggestedPrice || product.price || 0))}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : reqProductName.trim() ? <Text style={{ color: ui.textMuted, fontSize: 12, marginBottom: 10 }}>No hay productos coincidentes en el catálogo.</Text> : null}

                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dialogInputLabel}>Cantidad:</Text>
                    <TextInput
                      style={styles.dialogInput}
                      placeholder="1"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="numeric"
                      value={reqQuantity}
                      onChangeText={setReqQuantity}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dialogInputLabel}>Precio Lista (S/):</Text>
                    <TextInput
                      style={styles.dialogInput}
                      placeholder="100.00"
                      placeholderTextColor={ui.textMuted}
                      keyboardType="decimal-pad"
                      value={reqOriginalPrice}
                      onChangeText={setReqOriginalPrice}
                    />
                  </View>
                </View>

                <Text style={styles.dialogInputLabel}>Precio con Descuento Solicitado (S/):</Text>
                <TextInput
                  style={[styles.dialogInput, { borderColor: ui.primary }]}
                  placeholder="85.00"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="decimal-pad"
                  value={reqRequestedPrice}
                  onChangeText={setReqRequestedPrice}
                />

                <Text style={styles.dialogInputLabel}>Justificación / Motivo:</Text>
                <TextInput
                  style={styles.dialogInput}
                  placeholder="Ej: Cliente mayorista, paga al contado..."
                  placeholderTextColor={ui.textMuted}
                  value={reqReason}
                  onChangeText={setReqReason}
                />
              </ScrollView>

              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={styles.dialogCancelBtn}
                  onPress={() => setShowCreateRequestModal(false)}
                >
                  <Text style={styles.dialogCancelText}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.dialogSubmitBtn, isSubmitting && styles.buttonDisabled]}
                  onPress={handleCreateSaleRequest}
                  disabled={isSubmitting}
                >
                  <Send size={15} color={ui.onPrimary} />
                  <Text style={styles.dialogSubmitText}>Enviar a Caja</Text>
                </TouchableOpacity>
              </View>
            </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>

        {/* MODAL INTERNO: RECHAZAR SOLICITUD DE VENTA (SIN Alert.prompt) */}
        <Modal
          visible={Boolean(rejectTarget)}
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!isSubmitting) setRejectTarget(null);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
              <View style={styles.modalDialog}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Rechazar Solicitud</Text>
                  <TouchableOpacity
                    style={styles.closeButton}
                    onPress={() => {
                      if (!isSubmitting) setRejectTarget(null);
                    }}
                    disabled={isSubmitting}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar rechazo de solicitud"
                  >
                    <X size={18} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.modalSubtext}>
                  {rejectTarget ? `${rejectTarget.requestNumber} · ${rejectTarget.customerName}` : ''}
                </Text>

                <Text style={styles.dialogInputLabel}>Motivo del rechazo:</Text>
                <TextInput
                  style={[styles.dialogInput, styles.dialogTextArea]}
                  placeholder="Ej: Descuento excede el margen permitido"
                  placeholderTextColor={ui.textMuted}
                  value={rejectReason}
                  onChangeText={setRejectReason}
                  multiline
                  textAlignVertical="top"
                />

                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={styles.dialogCancelBtn}
                    onPress={() => setRejectTarget(null)}
                    disabled={isSubmitting}
                  >
                    <Text style={styles.dialogCancelText}>Cancelar</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.dialogDangerBtn, isSubmitting && styles.buttonDisabled]}
                    onPress={handleConfirmRejectRequest}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <ActivityIndicator color={ui.onPrimary} size="small" />
                    ) : (
                      <>
                        <XCircle size={15} color={ui.onPrimary} />
                        <Text style={styles.dialogSubmitText}>Rechazar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>

        {/* MODAL INTERNO: CREAR / EDITAR COLABORADOR Y PERMISOS CUSTOM */}
        <Modal
          visible={userFormVisible}
          transparent
          animationType="slide"
          onRequestClose={() => {
            if (!isSubmitting) setUserFormVisible(false);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
              <View style={[styles.modalDialog, styles.modalDialogTall]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {editingMember ? 'Editar Colaborador' : 'Nuevo Colaborador'}
                  </Text>
                  <TouchableOpacity
                    style={styles.closeButton}
                    onPress={() => {
                      if (!isSubmitting) setUserFormVisible(false);
                    }}
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
                    value={userFormName}
                    onChangeText={setUserFormName}
                  />

                  <Text style={styles.dialogInputLabel}>Correo electrónico:</Text>
                  <TextInput
                    style={[styles.dialogInput, editingMember && styles.dialogInputDisabled]}
                    placeholder="correo@negocio.com"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    editable={!editingMember}
                    value={userFormEmail}
                    onChangeText={setUserFormEmail}
                  />
                  {!editingMember && (
                    <Text style={styles.fieldHintText}>
                      Se enviará un enlace de creación de contraseña a este correo.
                    </Text>
                  )}

                  <Text style={styles.dialogInputLabel}>Rol en el negocio:</Text>
                  <View style={styles.chipsWrapRow}>
                    {(
                      [
                        ...(isOwner && editingMember?.role === 'owner'
                          ? ([{ key: 'owner', label: 'Dueño' }] as const)
                          : []),
                        { key: 'admin', label: 'Administrador' },
                        { key: 'manager', label: 'Gerente' },
                        { key: 'cashier', label: 'Cajero' },
                      ] as Array<{ key: TeamRole; label: string }>
                    ).map((r) => {
                      const active = userFormRole === r.key;
                      return (
                        <TouchableOpacity
                          key={r.key}
                          style={[styles.selectPill, active && styles.selectPillActive]}
                          onPress={() => {
                            setUserFormRole(r.key);
                            setUserFormCustomPerms(null);
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
                        value={userFormAllBranches}
                        onValueChange={setUserFormAllBranches}
                        trackColor={{ false: ui.border, true: ui.primarySoft }}
                        thumbColor={userFormAllBranches ? ui.primary : ui.textMuted}
                      />
                    </View>
                  )}

                  {!userFormAllBranches && branchesList.length > 0 && (
                    <>
                      <Text style={styles.dialogInputLabel}>Sucursal asignada:</Text>
                      <View style={styles.chipsWrapRow}>
                        {branchesList
                          .filter((b) => b.isActive || b.id === userFormBranchId)
                          .map((b) => {
                            const active = userFormBranchId === b.id;
                            return (
                              <TouchableOpacity
                                key={b.id}
                                style={[styles.selectPill, active && styles.selectPillActive]}
                                onPress={() => setUserFormBranchId(b.id)}
                              >
                                <Text style={[styles.selectPillText, active && styles.selectPillTextActive]}>
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
                        value={userFormPhone}
                        onChangeText={setUserFormPhone}
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
                        value={userFormDni}
                        onChangeText={setUserFormDni}
                      />
                    </View>
                  </View>

                  <Text style={styles.dialogInputLabel}>Sueldo Base (S/):</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="Opcional (ej: 1500.00)"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="decimal-pad"
                    value={userFormSalary}
                    onChangeText={setUserFormSalary}
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
                        value={userFormIsActive}
                        onValueChange={setUserFormIsActive}
                        trackColor={{ false: ui.border, true: ui.primarySoft }}
                        thumbColor={userFormIsActive ? ui.primary : ui.textMuted}
                      />
                    </View>
                  )}

                  {userFormRole !== 'seller' && (
                    <View style={styles.permSection}>
                      <View style={styles.permSectionHeader}>
                        <View>
                          <Text style={styles.permSectionTitle}>Permisos personalizados</Text>
                          <Text style={styles.permSectionSub}>
                            Ajusta permisos específicos sobre el rol base
                          </Text>
                        </View>
                        {((userFormCustomPerms?.granted?.length || 0) > 0 ||
                          (userFormCustomPerms?.revoked?.length || 0) > 0) && (
                          <TouchableOpacity
                            style={styles.permResetBtn}
                            onPress={() => setUserFormCustomPerms(null)}
                          >
                            <RotateCcw size={13} color={ui.primary} />
                            <Text style={styles.permResetText}>Restaurar</Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      {Object.entries(PERMISSION_GROUPS).map(([groupKey, group]) => {
                        const isExpanded = Boolean(openPermGroups[groupKey]);
                        const basePerms = ROLE_PERMISSIONS[userFormRole] || [];
                        const granted = userFormCustomPerms?.granted || [];
                        const revoked = userFormCustomPerms?.revoked || [];
                        const activeCount = group.permissions.filter(({ key }) =>
                          revoked.includes(key) ? false : granted.includes(key) ? true : basePerms.includes(key)
                        ).length;

                        return (
                          <View key={groupKey} style={styles.permGroupCard}>
                            <TouchableOpacity
                              style={styles.permGroupHeader}
                              onPress={() =>
                                setOpenPermGroups((prev) => ({
                                  ...prev,
                                  [groupKey]: !prev[groupKey],
                                }))
                              }
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
                                      onPress={() =>
                                        setUserFormCustomPerms((prev) =>
                                          toggleCustomPermission(userFormRole, prev, key, !checked)
                                        )
                                      }
                                      accessibilityRole="checkbox"
                                      accessibilityState={{ checked }}
                                    >
                                      <View style={[styles.permCheckbox, checked && styles.permCheckboxChecked]}>
                                        {checked && <Check size={12} color={ui.onPrimary} />}
                                      </View>
                                      <Text style={styles.permItemLabel}>{label}</Text>
                                      {isGranted && (
                                        <Text style={styles.permTagGranted}>Extra</Text>
                                      )}
                                      {isRevoked && (
                                        <Text style={styles.permTagRevoked}>Revocado</Text>
                                      )}
                                    </TouchableOpacity>
                                  );
                                })}
                              </View>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  )}
                </ScrollView>

                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={styles.dialogCancelBtn}
                    onPress={() => setUserFormVisible(false)}
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

        {/* MODAL INTERNO: CREAR / EDITAR SUCURSAL */}
        <Modal
          visible={branchFormVisible}
          transparent
          animationType="slide"
          onRequestClose={() => {
            if (!isSubmitting) setBranchFormVisible(false);
          }}
        >
          <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
              <View style={[styles.modalDialog, styles.modalDialogTall]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {editingBranch ? 'Editar Sucursal' : 'Nueva Sucursal'}
                  </Text>
                  <TouchableOpacity
                    style={styles.closeButton}
                    onPress={() => {
                      if (!isSubmitting) setBranchFormVisible(false);
                    }}
                    disabled={isSubmitting}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar formulario de sucursal"
                  >
                    <X size={18} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                  <Text style={styles.dialogInputLabel}>Nombre de sucursal *:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="Ej: Sede Centro"
                    placeholderTextColor={ui.textMuted}
                    value={branchFormName}
                    onChangeText={setBranchFormName}
                  />

                  <Text style={styles.dialogInputLabel}>Dirección:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="Av. Principal 123"
                    placeholderTextColor={ui.textMuted}
                    value={branchFormAddress}
                    onChangeText={setBranchFormAddress}
                  />

                  <View style={styles.twoColRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.dialogInputLabel}>Teléfono:</Text>
                      <TextInput
                        style={styles.dialogInput}
                        placeholder="987654321"
                        placeholderTextColor={ui.textMuted}
                        keyboardType="phone-pad"
                        value={branchFormPhone}
                        onChangeText={setBranchFormPhone}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.dialogInputLabel}>RUC (opcional):</Text>
                      <TextInput
                        style={styles.dialogInput}
                        placeholder="20XXXXXXXXX"
                        placeholderTextColor={ui.textMuted}
                        keyboardType="numeric"
                        maxLength={11}
                        value={branchFormRuc}
                        onChangeText={setBranchFormRuc}
                      />
                    </View>
                  </View>

                  <Text style={styles.dialogInputLabel}>Correo de sucursal:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="sucursal@negocio.com"
                    placeholderTextColor={ui.textMuted}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    value={branchFormEmail}
                    onChangeText={setBranchFormEmail}
                  />

                  <Text style={styles.dialogInputLabel}>Encargado / Administrador:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="Nombre del encargado"
                    placeholderTextColor={ui.textMuted}
                    value={branchFormManager}
                    onChangeText={setBranchFormManager}
                  />

                  <Text style={styles.dialogInputLabel}>Razón Social / Nombre Comercial:</Text>
                  <TextInput
                    style={styles.dialogInput}
                    placeholder="Opcional para comprobantes"
                    placeholderTextColor={ui.textMuted}
                    value={branchFormBusinessName}
                    onChangeText={setBranchFormBusinessName}
                  />

                  <Text style={styles.dialogInputLabel}>Pie de Ticket:</Text>
                  <TextInput
                    style={[styles.dialogInput, styles.dialogTextArea]}
                    placeholder="Mensaje al pie del comprobante"
                    placeholderTextColor={ui.textMuted}
                    value={branchFormFooter}
                    onChangeText={setBranchFormFooter}
                    multiline
                    textAlignVertical="top"
                  />

                  {editingBranch && (
                    <View style={styles.switchFieldRow}>
                      <View style={{ flex: 1, marginRight: 10 }}>
                        <Text style={styles.switchTitle}>Sucursal activa</Text>
                        <Text style={styles.switchDesc}>
                          Las sucursales inactivas no aparecen al abrir caja o vender.
                        </Text>
                      </View>
                      <Switch
                        value={branchFormIsActive}
                        onValueChange={setBranchFormIsActive}
                        trackColor={{ false: ui.border, true: ui.primarySoft }}
                        thumbColor={branchFormIsActive ? ui.primary : ui.textMuted}
                      />
                    </View>
                  )}
                </ScrollView>

                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={styles.dialogCancelBtn}
                    onPress={() => setBranchFormVisible(false)}
                    disabled={isSubmitting}
                  >
                    <Text style={styles.dialogCancelText}>Cancelar</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.dialogSubmitBtn, isSubmitting && styles.buttonDisabled]}
                    onPress={handleSaveBranch}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <ActivityIndicator color={ui.onPrimary} size="small" />
                    ) : (
                      <>
                        <Check size={15} color={ui.onPrimary} />
                        <Text style={styles.dialogSubmitText}>
                          {editingBranch ? 'Guardar sucursal' : 'Crear sucursal'}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
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
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 10,
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
  // Modales internos
  modalSafe: {
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    padding: 20,
  },
  modalDialog: {
    backgroundColor: ui.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 16,
  },
  modalDialogTall: {
    maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  modalSubtext: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 8,
  },
  dialogInputLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.textSecondary,
    marginTop: 8,
    marginBottom: 3,
  },
  dialogInput: {
    backgroundColor: ui.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    paddingHorizontal: 10,
    minHeight: 48,
    paddingVertical: 10,
    fontSize: 15,
    color: ui.text,
  },
  dialogInputDisabled: {
    backgroundColor: ui.surfaceMuted,
    color: ui.textMuted,
  },
  dialogTextArea: {
    minHeight: 80,
  },
  fieldHintText: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 4,
  },
  twoColRow: {
    flexDirection: 'row',
    gap: 10,
  },
  chipsWrapRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  selectPill: {
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
    justifyContent: 'center',
  },
  selectPillActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  selectPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  selectPillTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  switchFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 12,
    marginTop: 12,
  },
  permSection: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    gap: 8,
  },
  permSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  permSectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  permSectionSub: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  permResetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
  },
  permResetText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  permGroupCard: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    overflow: 'hidden',
  },
  permGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  permGroupTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  permGroupList: {
    borderTopWidth: 1,
    borderTopColor: ui.border,
    backgroundColor: ui.surface,
    paddingVertical: 4,
  },
  permItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    gap: 10,
  },
  permCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permCheckboxChecked: {
    backgroundColor: ui.primary,
    borderColor: ui.primary,
  },
  permItemLabel: {
    flex: 1,
    fontSize: 13,
    color: ui.text,
  },
  permTagGranted: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.success,
    backgroundColor: ui.successSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  permTagRevoked: {
    fontSize: 10,
    fontWeight: '700',
    color: ui.danger,
    backgroundColor: ui.dangerSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  dialogCancelBtn: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dialogCancelText: {
    color: ui.textSecondary,
    fontSize: 13,
  },
  dialogSubmitBtn: {
    backgroundColor: ui.primary,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    minHeight: 48,
    paddingVertical: 10,
    gap: 6,
  },
  dialogDangerBtn: {
    backgroundColor: ui.danger,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    minHeight: 48,
    paddingVertical: 10,
    gap: 6,
  },
  dialogSubmitText: {
    color: ui.onPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
});

export default PayrollUsersModal;
