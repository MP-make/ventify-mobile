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

import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { ui, theme, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import {
  TeamMember,
  PayrollMovement,
  PayrollConceptType,
  SaleRequest,
  SaleRequestStatus,
  subscribeToTeamMembers,
  subscribeToPayrollMovements,
  subscribeToSaleRequests,
  registerPayrollPayment,
  resolveSaleRequest,
  createSaleRequest,
} from '@/services/enterprise-ops-service';
import type { Product, Customer } from '@/types';

export interface PayrollUsersModalProps {
  visible?: boolean;
  isOpen?: boolean;
  onClose: () => void;
  onLoadSaleRequestToPos?: (request: SaleRequest) => void;
}

type SubTab = 'team' | 'payroll' | 'requests';

interface TeamMemberCardItemProps {
  member: TeamMember;
}

const TeamMemberCardItem = React.memo<TeamMemberCardItemProps>(({ member }) => (
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

      <Text style={styles.memberRoleBadge}>{member.roleLabel}</Text>

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

    {member.baseSalary ? (
      <View style={styles.salaryCol}>
        <Text style={styles.salaryLabel}>Sueldo Base</Text>
        <Text style={styles.salaryValue}>{formatPEN(member.baseSalary)}</Text>
      </View>
    ) : null}
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
}

const SaleRequestCardItem = React.memo<SaleRequestCardItemProps>(({
  req,
  isSubmitting,
  onApprove,
  onReject,
  onLoadPos,
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
              ? 'En POS'
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
          <TouchableOpacity
            style={styles.loadPosBtn}
            onPress={() => onLoadPos(req)}
            disabled={isSubmitting}
          >
            <ShoppingCart size={14} color={ui.onPrimary} />
            <Text style={styles.loadPosBtnText}>Cargar al POS</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

export const PayrollUsersModal: React.FC<PayrollUsersModalProps> = React.memo(({
  visible,
  isOpen,
  onClose,
  onLoadSaleRequestToPos,
}) => {
  const insets = useSafeAreaInsets();
  const isVisible = visible !== undefined ? visible : Boolean(isOpen);

  const { accountId, branchId, userProfile } = useAuth();
  const { isCashOpen, activeCashSession, activeBranchName } = useSettings();
  const { clearCart, addItem, setCustomer, setNotes, setSaleRequestId, setShippingAmount } = useCart();
  const { products } = useProducts();

  // Pestaña activa
  const [activeTab, setActiveTab] = useState<SubTab>('team');

  // Estados de datos
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
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

  // Formulario rápido para crear solicitud de prueba/vendedor
  const [showCreateRequestModal, setShowCreateRequestModal] = useState<boolean>(false);
  const [reqCustomerName, setReqCustomerName] = useState<string>('');
  const [reqProductName, setReqProductName] = useState<string>('');
  const [reqSelectedProduct, setReqSelectedProduct] = useState<Product | null>(null);
  const [reqOriginalPrice, setReqOriginalPrice] = useState<string>('');
  const [reqRequestedPrice, setReqRequestedPrice] = useState<string>('');
  const [reqQuantity, setReqQuantity] = useState<string>('1');
  const [reqReason, setReqReason] = useState<string>('');

  // 1. Suscripciones en tiempo real según pestaña activa
  useEffect(() => {
    if (!isVisible || !accountId) return;

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

    return () => {
      unsubTeam?.();
      unsubPayroll?.();
      unsubRequests?.();
    };
  }, [isVisible, accountId, branchId, activeTab]);

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

  // Rechazar solicitud
  const handleRejectRequest = useCallback((request: SaleRequest) => {
    Alert.prompt
      ? Alert.prompt(
          'Rechazar Solicitud',
          `Indica el motivo de rechazo para ${request.requestNumber}:`,
          async (notes) => {
            try {
              setIsSubmitting(true);
              await resolveSaleRequest(request.id, 'rejected', userProfile, notes || 'Descuento no autorizado', branchId);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'No se pudo rechazar la solicitud.');
            } finally {
              setIsSubmitting(false);
            }
          }
        )
      : Alert.alert(
          '¿Rechazar Solicitud?',
          `¿Confirmas el rechazo del descuento para la solicitud ${request.requestNumber}?`,
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Rechazar',
              style: 'destructive',
              onPress: async () => {
                try {
                  setIsSubmitting(true);
                  await resolveSaleRequest(request.id, 'rejected', userProfile, 'Descuento no autorizado', branchId);
                } catch (err: any) {
                  Alert.alert('Error', err?.message || 'No se pudo rechazar la solicitud.');
                } finally {
                  setIsSubmitting(false);
                }
              },
            },
          ]
        );
  }, [userProfile, branchId]);

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
      <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
        <ScreenHeading
          title="Equipo y planilla"
          subtitle={activeBranchName || 'Personal, remuneraciones y solicitudes'}
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

        {/* Barra de Sub-pestañas */}
        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'team' && styles.tabButtonActive]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setActiveTab('team');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'team' }}
          >
            <Users size={16} color={activeTab === 'team' ? ui.primary : ui.textSecondary} />
            <Text style={[styles.tabButtonText, activeTab === 'team' && styles.tabButtonTextActive]}>
              Equipo ({teamMembers.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'payroll' && styles.tabButtonActive]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setActiveTab('payroll');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'payroll' }}
          >
            <Wallet size={16} color={activeTab === 'payroll' ? ui.primary : ui.textSecondary} />
            <Text style={[styles.tabButtonText, activeTab === 'payroll' && styles.tabButtonTextActive]}>
              Planilla
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'requests' && styles.tabButtonActive]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              setActiveTab('requests');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'requests' }}
          >
            <ClipboardList
              size={16}
              color={activeTab === 'requests' ? ui.primary : ui.textSecondary}
            />
            <Text style={[styles.tabButtonText, activeTab === 'requests' && styles.tabButtonTextActive]}>
              Solicitudes ({saleRequests.filter((r) => r.status === 'pending').length})
            </Text>
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
                <SectionHeading title="Equipo" subtitle={`${filteredTeam.length} colaboradores`} />
                {/* Buscador */}
                <View style={styles.searchBar}>
                  <Search size={16} color={ui.textSecondary} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Buscar colaborador por nombre, rol o email..."
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

                <FlashList
                  data={filteredTeam}
                  renderItem={({ item }) => <TeamMemberCardItem member={item} />}
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
                <SectionHeading title="Planilla" subtitle="Control de remuneraciones y adelantos" />
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
                    <SectionHeading title="Historial de pagos" />
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
                <SectionHeading
                  title="Solicitudes de venta"
                  subtitle="Revisa descuentos y autoriza pedidos del equipo"
                  action={(
                    <TouchableOpacity
                      style={styles.newRequestBtn}
                      onPress={() => setShowCreateRequestModal(true)}
                      accessibilityRole="button"
                      accessibilityLabel="Crear solicitud de venta"
                    >
                      <Plus size={16} color={ui.onPrimary} />
                      <Text style={styles.newRequestBtnText}>Nueva</Text>
                    </TouchableOpacity>
                  )}
                />
                <View style={styles.requestsHeaderRow}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.filterChipsRow}
                  >
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
                        <Text style={[styles.filterChipText, requestFilter === f.key && styles.filterChipTextActive]}>
                          {f.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

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
          </View>
        )}

        {/* MODAL INTERNO: CREAR NUEVA SOLICITUD DE DESCUENTO */}
        <Modal
          visible={showCreateRequestModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowCreateRequestModal(false)}
        >
          <View style={styles.modalOverlay}>
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
          </View>
        </Modal>
      </View>
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
    marginHorizontal: 20,
    marginBottom: 8,
    padding: 4,
    gap: 4,
    borderRadius: 14,
    backgroundColor: ui.surfaceMuted,
  },
  tabButton: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderRadius: 11,
    gap: 5,
  },
  tabButtonActive: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
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
  requestsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  filterChipsRow: {
    gap: 6,
  },
  filterChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
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
  // Modal de Nueva Solicitud
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
  dialogSubmitText: {
    color: ui.onPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
});

export default PayrollUsersModal;
