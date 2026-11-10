import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
  FlatList,
  StyleSheet,
  Alert,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Receipt,
  Bot,
  Search,
  Filter,
  Calendar,
  DollarSign,
  TrendingUp,
  CreditCard,
  Banknote,
  Printer,
  Share2,
  Trash2,
  RefreshCw,
  Send,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Clock,
  XCircle,
  FileText,
  ChevronRight,
  Info,
  X,
  MessageSquare,
  HelpCircle,
  ArrowUpRight,
} from 'lucide-react-native';

import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { Header } from '@/components/Header';
import { ui, theme, formatPEN, formatDatePE } from '@/lib/theme';
import { ScreenHeading, SectionHeading } from '@/components/ui';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  onSnapshot,
} from 'firebase/firestore';

import { Sale, CartItem } from '@/types';
import { cancelSaleWithReversal } from '@/services/sale-service';
import {
  askVentyAI,
  getCustomers,
  BusinessKPIContext,
} from '@/services/crm-operations-service';

import {
  buildSaleReceiptEscPos,
  printRawEscPos,
  printTicketPDF,
  shareTicketWhatsApp,
} from '@/services/thermal-printer-service';
import { FinancialPnlModal } from '@/components/FinancialPnlModal';

// Sub-módulos de Historial
type HistoryTab = 'sales' | 'ai';
type DateRange = 'today' | 'week' | 'month' | 'all';
type DocFilter = 'all' | 'factura' | 'boleta' | 'nota_venta';

interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: number;
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { user, userProfile, accountId, branchId, role } = useAuth();
  const {
    businessSettings,
    activeBranch,
    isCashOpen,
    activeCashSession,
    refreshCashStatus,
  } = useSettings();

  const [activeTab, setActiveTab] = useState<HistoryTab>('sales');
  const [pnlModalOpen, setPnlModalOpen] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 1: HISTORIAL DE VENTAS Y SUNAT
  // ============================================================================
  const [sales, setSales] = useState<Sale[]>([]);
  const [loadingSales, setLoadingSales] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [docFilter, setDocFilter] = useState<DocFilter>('all');

  // Modal de Detalle de Comprobante
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [saleDetailModalVisible, setSaleDetailModalVisible] = useState<boolean>(false);

  // Modal de Anulación
  const [cancelModalVisible, setCancelModalVisible] = useState<boolean>(false);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [isCancelling, setIsCancelling] = useState<boolean>(false);

  // Impresión y compartir
  const [isPrinting, setIsPrinting] = useState<boolean>(false);
  const [isSharing, setIsSharing] = useState<boolean>(false);

  // ============================================================================
  // ESTADOS DEL SUB-MÓDULO 2: ASISTENTE VENTY IA
  // ============================================================================
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'ai',
      text: '¡Hola! Soy Venty IA, tu asistente inteligente de negocio. Puedo ayudarte con métricas de ventas en tiempo real, control de gaveta de efectivo, productos críticos y cuentas de fiado. ¿Qué te gustaría consultar hoy?',
      timestamp: Date.now(),
    },
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);
  const chatScrollRef = useRef<ScrollView>(null);

  // Contexto en vivo para la IA
  const [kpiContext, setKpiContext] = useState<BusinessKPIContext>({});

  // ============================================================================
  // CARGA EN TIEMPO REAL DE VENTAS (CON CARGA DIRECTA HTTP RPC + STREAM)
  // ============================================================================
  useEffect(() => {
    if (!accountId) {
      setSales([]);
      setLoadingSales(false);
      return;
    }

    setLoadingSales(true);
    const coll = collection(db, 'sales');
    const q =
      branchId && branchId !== 'main'
        ? query(
            coll,
            where('accountId', '==', accountId),
            where('branchId', '==', branchId),
            limit(250)
          )
        : query(coll, where('accountId', '==', accountId), limit(250));

    const applySalesSnapshot = (snapshot: any) => {
      const list: Sale[] = snapshot.docs.map((d: any) => ({
        id: d.id,
        ...(d.data() as any),
      }));

      list.sort((a, b) => {
        const tA = a.date || (a as any).createdAt || 0;
        const tB = b.date || (b as any).createdAt || 0;
        return tB - tA;
      });

      setSales(list);
      setLoadingSales(false);
    };

    getDocs(q)
      .then(applySalesSnapshot)
      .catch((err) => {
        console.warn('Warning getDocs ventas inicial:', err);
        setLoadingSales(false);
      });

    const unsubscribe = onSnapshot(
      q,
      applySalesSnapshot,
      (err) => {
        console.error('Error escuchando ventas:', err);
        setLoadingSales(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [accountId, branchId]);

  // ============================================================================
  // FILTRADO DE VENTAS POR FECHA, TIPO Y BÚSQUEDA
  // ============================================================================
  const filteredSales = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const sevenDaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    return sales.filter((sale) => {
      const saleDate = sale.date || (sale as any).createdAt || 0;

      // 1. Filtro por Rango de Fechas
      if (dateRange === 'today' && saleDate < startOfToday) return false;
      if (dateRange === 'week' && saleDate < sevenDaysAgo) return false;
      if (dateRange === 'month' && saleDate < startOfMonth) return false;

      // 2. Filtro por Tipo de Comprobante
      if (docFilter !== 'all') {
        const docTypeStr = String(sale.documentType || '').toLowerCase();
        if (docFilter === 'factura' && !docTypeStr.includes('factura') && docTypeStr !== '01') return false;
        if (docFilter === 'boleta' && !docTypeStr.includes('boleta') && docTypeStr !== '03') return false;
        if (docFilter === 'nota_venta' && docTypeStr.includes('factura') && docTypeStr.includes('boleta')) return false;
      }

      // 3. Filtro por Búsqueda
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase().trim();
        const docNum = String(sale.documentNumber || sale.saleNumber || '').toLowerCase();
        const custName = String(sale.customerName || '').toLowerCase();
        const custDoc = String(sale.customerDni || sale.customerRuc || '').toLowerCase();
        if (!docNum.includes(q) && !custName.includes(q) && !custDoc.includes(q)) {
          return false;
        }
      }

      return true;
    });
  }, [sales, dateRange, docFilter, searchQuery]);

  // ============================================================================
  // KPIS FINANCIEROS DEL PERIODO SELECCIONADO
  // ============================================================================
  const periodKpis = useMemo(() => {
    let totalSales = 0;
    let totalCost = 0;
    let cashSales = 0;
    let digitalSales = 0;
    let completedCount = 0;

    filteredSales.forEach((s) => {
      if (s.status === 'cancelled') return; // Excluir ventas anuladas

      const total = Number(s.total) || 0;
      totalSales += total;
      completedCount += 1;

      // Costo o margen
      if (s.totalCost) {
        totalCost += s.totalCost;
      } else {
        totalCost += total * 0.7; // Estimación base del 30% margen si no está explícito
      }

      // Desglose Efectivo vs Digital
      const method = String(s.paymentMethod || '').toLowerCase();
      if (method.includes('efectivo') || method.includes('cash')) {
        cashSales += total;
      } else {
        digitalSales += total;
      }
    });

    const grossProfit = Math.max(0, totalSales - totalCost);
    const avgTicket = completedCount > 0 ? totalSales / completedCount : 0;
    const cashPercent = totalSales > 0 ? Math.round((cashSales / totalSales) * 100) : 0;
    const digitalPercent = totalSales > 0 ? Math.round((digitalSales / totalSales) * 100) : 0;

    return {
      totalSales: Math.round(totalSales * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      avgTicket: Math.round(avgTicket * 100) / 100,
      cashSales: Math.round(cashSales * 100) / 100,
      digitalSales: Math.round(digitalSales * 100) / 100,
      cashPercent,
      digitalPercent,
      salesCount: completedCount,
    };
  }, [filteredSales]);

  // ============================================================================
  // ACTUALIZAR CONTEXTO PARA VENTY IA
  // ============================================================================
  useEffect(() => {
    if (!accountId) return;

    // Obtener deudas de clientes
    getCustomers(accountId).then((custs) => {
      let totalDebt = 0;
      custs.forEach((c) => {
        totalDebt += Number(c.currentDebt) || 0;
      });

      setKpiContext({
        todaySales: periodKpis.totalSales,
        salesCount: periodKpis.salesCount,
        cashInDrawer: activeCashSession?.expectedAmount || 0,
        totalDebt: Math.round(totalDebt * 100) / 100,
        branchName: activeBranch?.name || 'Tienda Principal',
        activeOperator: userProfile?.displayName || user?.email || 'Operador',
      });
    }).catch(() => {});
  }, [accountId, periodKpis, activeCashSession?.expectedAmount, activeBranch?.name, userProfile?.displayName, user?.email]);

  // ============================================================================
  // ACCIONES DEL COMPROBANTE: REIMPRESIÓN, COMPARTIR Y ANULACIÓN
  // ============================================================================
  const handlePrintSale = async (sale: Sale) => {
    setIsPrinting(true);
    try {
      const bytes = buildSaleReceiptEscPos(
        sale,
        { ...businessSettings, ...activeBranch },
        { autoCut: true, openDrawer: false }
      );

      const success = await printRawEscPos(bytes);
      if (!success) {
        // Fallback a impresión nativa PDF
        await printTicketPDF({
          title: `Ticket_${sale.documentNumber || sale.id}`,
          sale,
          business: { ...businessSettings, ...activeBranch },
        });
      }
      Alert.alert('Ticket Enviado', 'El comprobante ha sido enviado a la impresora.');
    } catch (err: any) {
      Alert.alert('Error de Impresión', err?.message || 'No se pudo emitir el ticket.');
    } finally {
      setIsPrinting(false);
    }
  };

  const handleShareWhatsApp = async (sale: Sale) => {
    setIsSharing(true);
    try {
      const phone = sale.customerPhone || '';
      await shareTicketWhatsApp(sale, { ...businessSettings, ...activeBranch }, phone);
    } catch (err: any) {
      Alert.alert('Error al Compartir', err?.message || 'No se pudo generar el documento PDF.');
    } finally {
      setIsSharing(false);
    }
  };

  const handleConfirmCancelSale = async () => {
    if (!selectedSale) return;
    if (!cancelReason.trim()) {
      Alert.alert('Motivo Requerido', 'Indique la razón justificada de la anulación.');
      return;
    }
    if (!user) return;

    setIsCancelling(true);
    try {
      await cancelSaleWithReversal(selectedSale.id, cancelReason.trim(), {
        uid: user.uid,
        displayName: userProfile?.displayName || user.email || 'Operador',
        email: user.email,
        role,
      });

      setCancelModalVisible(false);
      setSaleDetailModalVisible(false);
      setCancelReason('');
      setSelectedSale(null);
      refreshCashStatus();

      Alert.alert(
        'Venta Anulada',
        'El comprobante ha sido marcado como ANULADO, el stock físico fue restaurado en inventario y registrado en Kardex.'
      );
    } catch (err: any) {
      Alert.alert('Error al Anular Venta', err?.message || 'No se pudo anular la venta.');
    } finally {
      setIsCancelling(false);
    }
  };

  // ============================================================================
  // ACCIONES DE VENTY IA
  // ============================================================================
  const handleSendAiMessage = async (customText?: string) => {
    const textToSend = customText || chatInput;
    if (!textToSend.trim()) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sender: 'user',
      text: textToSend.trim(),
      timestamp: Date.now(),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    if (!customText) setChatInput('');
    setIsAiLoading(true);

    setTimeout(() => {
      chatScrollRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await askVentyAI({
        prompt: textToSend.trim(),
        contextSummary: kpiContext,
      });

      const aiMsg: ChatMessage = {
        id: `ai_${Date.now()}`,
        sender: 'ai',
        text: typeof response === 'string' ? response : (response as any)?.reply || '',
        timestamp: Date.now(),
      };

      setChatMessages((prev) => [...prev, aiMsg]);
    } catch (err: any) {
      const errReply: ChatMessage = {
        id: `err_${Date.now()}`,
        sender: 'ai',
        text: 'Lo siento, ocurrió un error temporal al procesar la respuesta. Por favor intenta nuevamente.',
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, errReply]);
    } finally {
      setIsAiLoading(false);
      setTimeout(() => {
        chatScrollRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  // Chips de preguntas rápidas
  const quickChips = [
    '¿Cuánto vendí hoy y cuál es mi ganancia?',
    '¿Qué productos están por agotarse?',
    '¿Cuánto efectivo debe haber en caja?',
    '¿Qué clientes tienen deuda de fiado?',
  ];

  // Helper de badges para Comprobantes
  const renderDocBadge = (sale: Sale) => {
    const typeStr = String(sale.documentType || '').toLowerCase();
    const isCancelled = sale.status === 'cancelled';

    if (isCancelled) {
      return (
        <View style={[styles.badge, { backgroundColor: ui.dangerSoft }]}>
          <Text style={[styles.badgeText, { color: ui.danger, textDecorationLine: 'line-through' }]}>
            ANULADO
          </Text>
        </View>
      );
    }

    if (typeStr.includes('factura') || typeStr === '01') {
      return (
        <View style={[styles.badge, { backgroundColor: ui.accentSoft }]}>
          <Text style={[styles.badgeText, { color: ui.accent }]}>FACTURA</Text>
        </View>
      );
    }

    if (typeStr.includes('boleta') || typeStr === '03') {
      return (
        <View style={[styles.badge, { backgroundColor: ui.primarySoft }]}>
          <Text style={[styles.badgeText, { color: ui.primary }]}>BOLETA</Text>
        </View>
      );
    }

    return (
      <View style={[styles.badge, { backgroundColor: ui.surfaceMuted }]}>
        <Text style={[styles.badgeText, { color: ui.textSecondary }]}>NOTA VENTA</Text>
      </View>
    );
  };

  const renderSunatBadge = (sale: Sale) => {
    const status = sale.sunatStatus || 'not_applicable';
    if (status === 'accepted') {
      return (
        <View style={[styles.miniBadge, { backgroundColor: ui.primarySoft }]}>
          <CheckCircle2 size={12} color={ui.primary} />
          <Text style={[styles.miniBadgeText, { color: ui.primary }]}>SUNAT Aceptado</Text>
        </View>
      );
    }
    if (status === 'pending') {
      return (
        <View style={[styles.miniBadge, { backgroundColor: ui.warningSoft }]}>
          <Clock size={12} color={ui.warning} />
          <Text style={[styles.miniBadgeText, { color: ui.warning }]}>SUNAT Pendiente</Text>
        </View>
      );
    }
    if (status === 'rejected') {
      return (
        <View style={[styles.miniBadge, { backgroundColor: ui.dangerSoft }]}>
          <AlertTriangle size={12} color={ui.danger} />
          <Text style={[styles.miniBadgeText, { color: ui.danger }]}>SUNAT Observado</Text>
        </View>
      );
    }
    return null;
  };

  // ============================================================================
  // RENDER PRINCIPAL
  // ============================================================================
  return (
    <View style={styles.screen}>
      <Header />

      <ScreenHeading
        title={activeTab === 'sales' ? 'Ventas' : 'Venty IA'}
        subtitle={activeTab === 'sales'
          ? 'Comprobantes, rendimiento y actividad del negocio'
          : 'Consulta las ventas y el movimiento de tu negocio'}
        action={(
          <TouchableOpacity
            style={styles.pnlHeaderButton}
            onPress={() => setPnlModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir estado de resultados"
          >
            <TrendingUp size={18} color={ui.primary} />
            <Text style={styles.pnlHeaderButtonText}>Estado de resultados</Text>
          </TouchableOpacity>
        )}
      />

      {/* Navegación principal de ventas */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabSelectorScroll}
        contentContainerStyle={styles.tabSelector}
      >
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'sales' && styles.tabButtonActive]}
          onPress={() => setActiveTab('sales')}
          accessibilityRole="button"
          accessibilityLabel="Comprobantes y reportes"
          accessibilityState={{ selected: activeTab === 'sales' }}
        >
          <Receipt size={18} color={activeTab === 'sales' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.tabButtonText, activeTab === 'sales' && styles.tabButtonTextActive]}>
            Comprobantes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'ai' && styles.tabButtonActive]}
          onPress={() => setActiveTab('ai')}
          accessibilityRole="button"
          accessibilityLabel="Asistente Venty IA"
          accessibilityState={{ selected: activeTab === 'ai' }}
        >
          <Bot size={18} color={activeTab === 'ai' ? ui.primary : ui.textSecondary} />
          <Text style={[styles.tabButtonText, activeTab === 'ai' && styles.tabButtonTextActive]}>
            Asistente IA
          </Text>
        </TouchableOpacity>

      </ScrollView>

      {/* ==================================================================== */}
      {/* SUB-MÓDULO 1: HISTORIAL DE VENTAS Y SUNAT */}
      {/* ==================================================================== */}
      {activeTab === 'sales' && (
        <ScrollView
          style={styles.contentContainer}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Filtros de Rango Temporal */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterChipRow}
            style={styles.filterChipScroll}
          >
            {(
              [
                { id: 'today', label: 'Hoy' },
                { id: 'week', label: 'Últimos 7 días' },
                { id: 'month', label: 'Este Mes' },
                { id: 'all', label: 'Todos' },
              ] as const
            ).map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.rangeChip, dateRange === item.id && styles.rangeChipActive]}
                onPress={() => setDateRange(item.id)}
                accessibilityRole="button"
                accessibilityLabel={`Filtrar por fecha: ${item.label}`}
                accessibilityState={{ selected: dateRange === item.id }}
              >
                <Text style={[styles.rangeChipText, dateRange === item.id && styles.rangeChipTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <SectionHeading title="Resumen del período" subtitle={`${periodKpis.salesCount} comprobantes`} />
          {/* Resumen principal y métricas de apoyo */}
          <View style={styles.kpiContainer}>
            <View style={styles.kpiGrid}>
              <View style={[styles.kpiBox, styles.totalSalesHero]}>
                <Text style={styles.kpiBoxLabel}>Ventas totales</Text>
                <Text style={[styles.kpiBoxValue, styles.totalSalesValue]}>
                  {formatPEN(periodKpis.totalSales)}
                </Text>
                <Text style={styles.kpiBoxFoot}>En el período seleccionado</Text>
              </View>

              <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
                <Text style={styles.kpiBoxLabel}>Ganancia bruta</Text>
                <Text style={[styles.kpiBoxValue, { color: ui.primary }]}>
                  {formatPEN(periodKpis.grossProfit)}
                </Text>
                <Text style={styles.kpiBoxFoot}>Margen estimado</Text>
              </View>

              <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
                <Text style={styles.kpiBoxLabel}>Ticket promedio</Text>
                <Text style={[styles.kpiBoxValue, { color: ui.accent }]}>
                  {formatPEN(periodKpis.avgTicket)}
                </Text>
                <Text style={styles.kpiBoxFoot}>Por venta</Text>
              </View>

              <View style={[styles.kpiBox, styles.secondaryKpiBox]}>
                <Text style={styles.kpiBoxLabel}>Efectivo y digital</Text>
                <Text style={[styles.kpiBoxValue, { color: ui.warning, fontSize: 16 }]}>
                  {periodKpis.cashPercent}% / {periodKpis.digitalPercent}%
                </Text>
                <Text style={styles.kpiBoxFoot}>
                  {formatPEN(periodKpis.cashSales)} / {formatPEN(periodKpis.digitalSales)}
                </Text>
              </View>
            </View>
          </View>

          {/* Buscador de Ventas */}
          <View style={styles.searchRow}>
            <View style={styles.searchBox}>
              <Search size={18} color={ui.textMuted} />
              <TextInput
                style={styles.searchInput}
                accessibilityLabel="Buscar comprobantes por número, cliente o DNI/RUC"
                placeholder="Buscar por correlativo, cliente o DNI/RUC..."
                placeholderTextColor={ui.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearchQuery('')}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel="Limpiar búsqueda"
                >
                  <X size={16} color={ui.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Filtros de Tipo de Documento */}
          <View style={styles.docFilterRow}>
            {(
              [
                { id: 'all', label: 'Todos' },
                { id: 'factura', label: 'Facturas' },
                { id: 'boleta', label: 'Boletas' },
                { id: 'nota_venta', label: 'Notas' },
              ] as const
            ).map((d) => (
              <TouchableOpacity
                key={d.id}
                style={[styles.docChip, docFilter === d.id && styles.docChipActive]}
                onPress={() => setDocFilter(d.id)}
                accessibilityRole="button"
                accessibilityLabel={`Filtrar comprobantes: ${d.label}`}
                accessibilityState={{ selected: docFilter === d.id }}
              >
                <Text style={[styles.docChipText, docFilter === d.id && styles.docChipTextActive]}>
                  {d.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Lista de Comprobantes */}
          {loadingSales ? (
            <ActivityIndicator color={ui.primary} style={{ marginVertical: 40 }} />
          ) : filteredSales.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Receipt size={44} color={ui.textMuted} />
              <Text style={styles.emptyTitle}>
                {sales.length === 0 ? 'Aún no hay comprobantes' : 'Sin ventas con estos filtros'}
              </Text>
              <Text style={styles.emptySub}>
                {sales.length === 0
                  ? 'Las ventas registradas aparecerán aquí.'
                  : 'Prueba otro periodo, tipo de comprobante o búsqueda.'}
              </Text>
            </View>
          ) : (
            filteredSales.map((sale) => {
              const isCancelled = sale.status === 'cancelled';
              const docNumber =
                sale.documentNumber || `V-${String(sale.saleNumber || 1).padStart(6, '0')}`;

              return (
                <TouchableOpacity
                  key={sale.id}
                  style={[styles.saleCard, isCancelled && styles.saleCardCancelled]}
                  onPress={() => {
                    setSelectedSale(sale);
                    setSaleDetailModalVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Ver comprobante ${docNumber}, ${formatPEN(sale.total)}, ${sale.customerName || 'Cliente General'}${isCancelled ? ', anulada' : ''}`}
                >
                  <View style={styles.saleCardTop}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {renderDocBadge(sale)}
                        <Text style={styles.saleDocNumber}>{docNumber}</Text>
                      </View>
                      <Text style={styles.saleDateText}>{formatDatePE(sale.date)}</Text>
                    </View>

                    <View style={{ alignItems: 'flex-end' }}>
                      <Text
                        style={[
                          styles.saleTotalText,
                          isCancelled && { color: ui.textMuted, textDecorationLine: 'line-through' },
                        ]}
                      >
                        {formatPEN(sale.total)}
                      </Text>
                      <Text style={styles.salePaymentMethod}>
                        {(sale.paymentMethod || 'Efectivo').toUpperCase()}
                      </Text>
                    </View>
                  </View>

                  {/* Fila Cliente & SUNAT */}
                  <View style={styles.saleCardBottom}>
                    <Text style={styles.saleCustomerText} numberOfLines={1}>
                      {sale.customerName ? `Cliente: ${sale.customerName}` : 'Cliente General'}
                    </Text>
                    {renderSunatBadge(sale)}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}

      {/* ==================================================================== */}
      {/* SUB-MÓDULO 2: ASISTENTE VENTY IA */}
      {/* ==================================================================== */}
      {activeTab === 'ai' && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            ref={chatScrollRef}
            style={styles.chatScroll}
            contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          >
            {/* Mensajes del Chat */}
            {chatMessages.map((msg) => {
              const isAi = msg.sender === 'ai';
              return (
                <View
                  key={msg.id}
                  style={[
                    styles.chatBubbleWrapper,
                    isAi ? styles.chatBubbleAiWrapper : styles.chatBubbleUserWrapper,
                  ]}
                >
                  {isAi && (
                    <View style={styles.aiAvatar}>
                      <Bot size={16} color={ui.onPrimary} />
                    </View>
                  )}
                  <View
                    style={[
                      styles.chatBubble,
                      isAi ? styles.chatBubbleAi : styles.chatBubbleUser,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chatText,
                        isAi ? styles.chatTextAi : styles.chatTextUser,
                      ]}
                    >
                      {msg.text}
                    </Text>
                  </View>
                </View>
              );
            })}

            {isAiLoading && (
              <View style={styles.aiTypingBox}>
                <ActivityIndicator size="small" color={ui.primary} />
                <Text style={styles.aiTypingText}>Venty IA está analizando los datos...</Text>
              </View>
            )}

            {/* Chips de Preguntas Rápidas */}
            <View style={styles.quickQuestionsContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Sparkles size={16} color={ui.primary} />
                <Text style={styles.quickQuestionsTitle}>Consultas rápidas:</Text>
              </View>
              <View style={styles.quickChipsGrid}>
                {quickChips.map((chip, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.quickChip}
                    onPress={() => handleSendAiMessage(chip)}
                  >
                    <Text style={styles.quickChipText}>{chip}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </ScrollView>

          {/* Barra de Entrada de Chat */}
          <View style={[styles.chatInputBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <TextInput
              style={styles.chatTextInput}
              accessibilityLabel="Escribe una pregunta para Venty IA"
              placeholder="Pregúntale a Venty IA sobre tu negocio..."
              placeholderTextColor={ui.textMuted}
              value={chatInput}
              onChangeText={setChatInput}
              onSubmitEditing={() => handleSendAiMessage()}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={[styles.chatSendButton, !chatInput.trim() && { opacity: 0.5 }]}
              onPress={() => handleSendAiMessage()}
              disabled={!chatInput.trim() || isAiLoading}
              accessibilityRole="button"
              accessibilityLabel={isAiLoading ? 'Venty IA está respondiendo' : 'Enviar pregunta'}
              accessibilityState={{ disabled: !chatInput.trim() || isAiLoading, busy: isAiLoading }}
            >
              <Send size={18} color={ui.onPrimary} />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* ==================================================================== */}
      {/* MODAL: DETALLE DEL COMPROBANTE Y ACCIONES */}
      {/* ==================================================================== */}
      <Modal visible={saleDetailModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '90%' }]}>
            {selectedSale && (
              <>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>
                      {selectedSale.documentType === 'factura' ? 'Factura Electrónica' : selectedSale.documentType === 'boleta' ? 'Boleta de Venta' : 'Nota de Venta'}
                    </Text>
                    <Text style={styles.modalSub}>
                      {selectedSale.documentNumber || `V-${String(selectedSale.saleNumber || 1).padStart(6, '0')}`}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setSaleDetailModalVisible(false)}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cerrar comprobante"
                  >
                    <X size={20} color={ui.textSecondary} />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                >
                  {/* Datos del Cliente */}
                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>DATOS DEL COMPROBANTE</Text>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Fecha y Hora:</Text>
                      <Text style={styles.detailValue}>{formatDatePE(selectedSale.date)}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Cliente:</Text>
                      <Text style={styles.detailValue}>
                        {selectedSale.customerName || 'Cliente General'}
                      </Text>
                    </View>
                    {selectedSale.customerRuc && (
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>RUC:</Text>
                        <Text style={styles.detailValue}>{selectedSale.customerRuc}</Text>
                      </View>
                    )}
                    {selectedSale.customerDni && (
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>DNI:</Text>
                        <Text style={styles.detailValue}>{selectedSale.customerDni}</Text>
                      </View>
                    )}
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Forma de Pago:</Text>
                      <Text style={styles.detailValue}>
                        {(selectedSale.paymentMethod || 'Efectivo').toUpperCase()}
                      </Text>
                    </View>
                  </View>

                  {/* Ítems Vendidos */}
                  <View style={styles.detailSection}>
                    <Text style={styles.detailSectionTitle}>ÍTEMS VENDIDOS</Text>
                    {selectedSale.items?.map((it, idx) => (
                      <View key={idx} style={styles.itemRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemName}>{it.name}</Text>
                          <Text style={styles.itemSub}>
                            {it.quantity} x {formatPEN(it.price)}
                          </Text>
                        </View>
                        <Text style={styles.itemTotal}>
                          {formatPEN((it.lineTotal ?? it.quantity * it.price) || 0)}
                        </Text>
                      </View>
                    ))}
                  </View>

                  {/* Desglose Tributario */}
                  <View style={styles.detailSection}>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Op. Gravada:</Text>
                      <Text style={styles.detailValue}>
                        {formatPEN(selectedSale.fiscalAmounts?.taxed || selectedSale.subtotal || selectedSale.total / 1.18)}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>IGV (18%):</Text>
                      <Text style={styles.detailValue}>
                        {formatPEN(selectedSale.fiscalAmounts?.igv || selectedSale.tax || selectedSale.total - (selectedSale.total / 1.18))}
                      </Text>
                    </View>
                    <View style={[styles.detailRow, { borderTopWidth: 1, borderTopColor: ui.border, paddingTop: 6 }]}>
                      <Text style={[styles.detailLabel, { fontWeight: 'bold', fontSize: 16, color: ui.text }]}>
                        TOTAL:
                      </Text>
                      <Text style={[styles.detailValue, { fontWeight: 'bold', fontSize: 18, color: ui.primary }]}>
                        {formatPEN(selectedSale.total)}
                      </Text>
                    </View>
                  </View>

                  {/* Estado SUNAT / CDR */}
                  {selectedSale.sunatStatus && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>ESTADO TRIBUTARIO SUNAT</Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Respuesta CDR:</Text>
                        <Text style={[styles.detailValue, { color: ui.primary, fontWeight: 'bold' }]}>
                          {selectedSale.sunatStatus === 'accepted' ? 'Comprobante Aceptado' : selectedSale.sunatStatus}
                        </Text>
                      </View>
                    </View>
                  )}
                </ScrollView>

                {/* Botones de Acción */}
                <View style={styles.actionGrid}>
                  <TouchableOpacity
                    style={[styles.modalActionBtn, { borderColor: ui.primary }]}
                    onPress={() => handlePrintSale(selectedSale)}
                    disabled={isPrinting}
                    accessibilityRole="button"
                    accessibilityLabel={isPrinting ? 'Imprimiendo ticket' : 'Reimprimir ticket'}
                    accessibilityState={{ disabled: isPrinting, busy: isPrinting }}
                  >
                    {isPrinting ? (
                      <ActivityIndicator color={ui.primary} size="small" />
                    ) : (
                      <>
                        <Printer size={18} color={ui.primary} />
                        <Text style={[styles.modalActionText, { color: ui.primary }]}>
                          Reimprimir Ticket
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.modalActionBtn, { borderColor: ui.primary }]}
                    onPress={() => handleShareWhatsApp(selectedSale)}
                    disabled={isSharing}
                    accessibilityRole="button"
                    accessibilityLabel={isSharing ? 'Preparando envío por WhatsApp' : 'Enviar comprobante por WhatsApp'}
                    accessibilityState={{ disabled: isSharing, busy: isSharing }}
                  >
                    {isSharing ? (
                      <ActivityIndicator color={ui.primary} size="small" />
                    ) : (
                      <>
                        <Share2 size={18} color={ui.primary} />
                        <Text style={[styles.modalActionText, { color: ui.primary }]}>
                          Enviar WhatsApp
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {/* Botón de Anulación si no está anulada */}
                {selectedSale.status !== 'cancelled' && (
                  <TouchableOpacity
                    style={styles.cancelSaleBtn}
                    onPress={() => {
                      setCancelReason('');
                      setCancelModalVisible(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Anular venta y revertir stock"
                  >
                    <Trash2 size={18} color={ui.danger} />
                    <Text style={styles.cancelSaleText}>Anular Venta y Revertir Stock</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: CONFIRMACIÓN Y MOTIVO DE ANULACIÓN */}
      {/* ==================================================================== */}
      <Modal visible={cancelModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={[styles.modalTitle, { color: ui.danger }]}>Anular Venta</Text>
                <Text style={styles.modalSub}>
                  Reversión de stock en inventario y contra-movimiento de caja
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setCancelModalVisible(false)}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar anulación"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Motivo Justificado de Anulación *</Text>
              <TextInput
                style={[styles.input, { height: 70, textAlignVertical: 'top' }]}
                accessibilityLabel="Motivo justificado de anulación, obligatorio"
                placeholder="Ej. Devolución de producto por falla, error en cobro..."
                placeholderTextColor={ui.textMuted}
                multiline
                value={cancelReason}
                onChangeText={setCancelReason}
              />
            </View>

            <TouchableOpacity
              style={[styles.confirmCancelBtn, isCancelling && styles.buttonDisabled]}
              onPress={handleConfirmCancelSale}
              disabled={isCancelling}
              accessibilityRole="button"
              accessibilityLabel={isCancelling ? 'Procesando anulación' : 'Confirmar anulación y actualizar kardex'}
              accessibilityState={{ disabled: isCancelling, busy: isCancelling }}
            >
              {isCancelling ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Trash2 size={18} color={ui.onPrimary} />
                  <Text style={styles.confirmCancelBtnText}>Confirmar Anulación y Kardex</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <FinancialPnlModal
        visible={pnlModalOpen}
        onClose={() => setPnlModalOpen(false)}
      />
    </View>
  );
}

// ============================================================================
// ESTILOS NATIVOS REACT NATIVE
// ============================================================================
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ui.background,
  },
  pnlHeaderButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 13,
    backgroundColor: ui.primarySoft,
    borderRadius: 12,
  },
  pnlHeaderButtonText: {
    color: ui.primary,
    fontSize: ui.font.small,
    fontWeight: '700',
  },
  tabSelector: {
    minWidth: '100%',
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 4,
  },
  tabButton: {
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surface,
    gap: 8,
  },
  tabSelectorScroll: {
    flexGrow: 0,
  },
  tabButtonActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  tabButtonText: {
    fontSize: ui.font.small,
    color: ui.textSecondary,
    fontWeight: theme.typography.weights.medium,
  },
  tabButtonTextActive: {
    color: ui.primary,
    fontWeight: theme.typography.weights.bold,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  filterChipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 12,
  },
  filterChipScroll: {
    flexGrow: 0,
  },
  rangeChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
  },
  rangeChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  rangeChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  rangeChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  kpiContainer: {
    marginBottom: 16,
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  kpiBox: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: ui.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: ui.border,
  },
  totalSalesHero: {
    flexBasis: '100%',
    backgroundColor: ui.primarySoft,
    borderColor: ui.primarySoft,
    paddingVertical: 20,
  },
  secondaryKpiBox: {
    minHeight: 112,
    justifyContent: 'center',
  },
  kpiBoxLabel: {
    fontSize: ui.font.small,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  kpiBoxValue: {
    fontSize: 19,
    fontWeight: 'bold',
    marginVertical: 4,
  },
  totalSalesValue: {
    fontSize: 30,
    color: ui.primary,
    fontWeight: '800',
    marginVertical: 8,
  },
  kpiBoxFoot: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  searchRow: {
    marginBottom: 10,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: ui.border,
    minHeight: 48,
  },
  searchInput: {
    flex: 1,
    color: ui.text,
    fontSize: theme.typography.sizes.base,
    marginLeft: 8,
  },
  docFilterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  docChip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  docChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  docChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  docChipTextActive: {
    color: ui.primary,
    fontWeight: 'bold',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 50,
    gap: 8,
  },
  emptyTitle: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
  },
  emptySub: {
    fontSize: theme.typography.sizes.sm,
    color: ui.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  saleCard: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: ui.border,
    marginBottom: 10,
    gap: 10,
  },
  saleCardCancelled: {
    opacity: 0.65,
    borderColor: ui.dangerSoft,
  },
  saleCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  saleDocNumber: {
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
    color: ui.text,
  },
  saleDateText: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  saleTotalText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: ui.primary,
  },
  salePaymentMethod: {
    fontSize: 11,
    color: ui.textMuted,
    marginTop: 2,
  },
  saleCardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingTop: 8,
  },
  saleCustomerText: {
    flex: 1,
    fontSize: 12,
    color: ui.textSecondary,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  miniBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    gap: 4,
  },
  miniBadgeText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  chatScroll: {
    flex: 1,
  },
  chatBubbleWrapper: {
    flexDirection: 'row',
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  chatBubbleAiWrapper: {
    justifyContent: 'flex-start',
  },
  chatBubbleUserWrapper: {
    justifyContent: 'flex-end',
  },
  aiAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  chatBubble: {
    maxWidth: '82%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chatBubbleAi: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderBottomLeftRadius: 4,
  },
  chatBubbleUser: {
    backgroundColor: ui.primary,
    borderBottomRightRadius: 4,
  },
  chatText: {
    fontSize: 14,
    lineHeight: 20,
  },
  chatTextAi: {
    color: ui.text,
  },
  chatTextUser: {
    color: ui.onPrimary,
    fontWeight: '500',
  },
  aiTypingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  aiTypingText: {
    fontSize: 12,
    color: ui.textSecondary,
    fontStyle: 'italic',
  },
  quickQuestionsContainer: {
    marginTop: 16,
    backgroundColor: ui.surfaceMuted,
    padding: 14,
    borderRadius: theme.borderRadius.md,
  },
  quickQuestionsTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.text,
  },
  quickChipsGrid: {
    gap: 8,
  },
  quickChip: {
    minHeight: 48,
    justifyContent: 'center',
    backgroundColor: ui.surface,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
  },
  quickChipText: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  chatInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    paddingHorizontal: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    gap: 10,
  },
  chatTextInput: {
    flex: 1,
    minHeight: 48,
    backgroundColor: ui.surface,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: ui.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  chatSendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: ui.surface,
    borderRadius: theme.borderRadius.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  iconButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: theme.typography.sizes.lg,
    fontWeight: 'bold',
    color: ui.text,
  },
  modalSub: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  detailSection: {
    backgroundColor: ui.surfaceMuted,
    borderRadius: theme.borderRadius.md,
    padding: 12,
    marginBottom: 10,
    gap: 6,
  },
  detailSectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: ui.textMuted,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  detailValue: {
    fontSize: 12,
    color: ui.text,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  itemName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: ui.text,
  },
  itemSub: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  itemTotal: {
    fontSize: 13,
    fontWeight: 'bold',
    color: ui.text,
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  modalActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1.5,
    gap: 6,
  },
  modalActionText: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  cancelSaleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 10,
    gap: 6,
  },
  cancelSaleText: {
    color: ui.danger,
    fontSize: 12,
    fontWeight: 'bold',
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: theme.typography.sizes.sm,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  input: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    color: ui.text,
    fontSize: theme.typography.sizes.base,
  },
  confirmCancelBtn: {
    backgroundColor: ui.danger,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    paddingVertical: 12,
    borderRadius: theme.borderRadius.md,
    gap: 8,
  },
  confirmCancelBtnText: {
    color: ui.onPrimary,
    fontSize: theme.typography.sizes.base,
    fontWeight: 'bold',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
