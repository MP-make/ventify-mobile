import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { FlashList, type ContentStyle } from '@shopify/flash-list';
import {
  Coins,
  FileText,
  PlusCircle,
  Receipt,
  Search,
  Users,
  X,
} from 'lucide-react-native';
import { SectionHeading } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatPEN, ui } from '@/lib/theme';
import type { CustomerData } from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';

const ListGap16 = () => <View style={styles.listSeparator16} />;

interface CustomerCardItemProps {
  cust: CustomerData;
  onCollectDebt: (cust: CustomerData) => void;
  onOpenDetail: (cust: CustomerData) => void;
}

const CustomerCardItem = React.memo<CustomerCardItemProps>(
  ({ cust, onCollectDebt, onOpenDetail }) => {
    const debt = Number(cust.currentDebt) || 0;
    const credits = Number(cust.credits) || 0;
    const creditLim = Number(cust.maxCreditLimit ?? cust.creditLimit) || 0;
    const debtRatio = creditLim > 0 ? Math.min(1, debt / creditLim) : 0;

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        style={styles.customerCard}
        onPress={() => onOpenDetail(cust)}
        accessibilityRole="button"
        accessibilityLabel={`Ver detalle de ${cust.name}`}
      >
        <View style={styles.customerTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.customerName}>{cust.name}</Text>
            <Text style={styles.customerDoc}>
              {cust.documentType || 'DOC'}: {cust.documentNumber || 'Sin número'}
              {cust.phone ? ` • Tel: ${cust.phone}` : ''}
            </Text>
          </View>

          {debt > 0 ? (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.debtLabel}>DEUDA ACTIVA</Text>
              <Text style={styles.debtValue}>{formatPEN(debt)}</Text>
            </View>
          ) : (
            <View style={styles.cleanDebtBadge}>
              <Text style={styles.cleanDebtText}>AL DÍA</Text>
            </View>
          )}
        </View>

        {credits > 0 && (
          <View style={styles.creditWalletRow}>
            <Coins size={13} color={ui.primary} />
            <Text style={styles.creditWalletText}>
              Créditos a favor: {formatPEN(credits)}
            </Text>
          </View>
        )}

        <View style={styles.creditLineBox}>
          <View style={styles.creditLineLabels}>
            <Text style={styles.creditLineText}>
              Línea: {creditLim > 0 ? formatPEN(creditLim) : 'Sin límite'}
            </Text>
            {creditLim > 0 && (
              <Text style={styles.creditLineText}>
                Uso: {Math.round(debtRatio * 100)}%
              </Text>
            )}
          </View>
          {creditLim > 0 && (
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    width: `${debtRatio * 100}%`,
                    backgroundColor:
                      debtRatio > 0.8
                        ? ui.danger
                        : debtRatio > 0.5
                        ? ui.warning
                        : ui.primary,
                  },
                ]}
              />
            </View>
          )}
        </View>

        <View style={styles.customerActionsRow}>
          <TouchableOpacity
            style={styles.detailButton}
            onPress={() => onOpenDetail(cust)}
          >
            <FileText size={15} color={ui.primary} />
            <Text style={styles.detailButtonText}>Detalle y Fiados</Text>
          </TouchableOpacity>
          {debt > 0 && (
            <TouchableOpacity
              style={styles.abonoButton}
              onPress={() => onCollectDebt(cust)}
            >
              <Receipt size={15} color={ui.onPrimary} />
              <Text style={styles.abonoButtonText}>Cobrar Abono</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  }
);

interface CrmListHeaderProps {
  totalDebt: number;
  debtorsCount: number;
  totalCustomers: number;
  customerSearch: string;
  onChangeSearch: (text: string) => void;
  onClearSearch: () => void;
  customerFilter: 'all' | 'with_debt' | 'no_debt';
  onChangeFilter: (next: 'all' | 'with_debt' | 'no_debt') => void;
  onOpenNewCustomer: () => void;
}

const CrmListHeader = React.memo<CrmListHeaderProps>(({
  totalDebt,
  debtorsCount,
  totalCustomers,
  customerSearch,
  onChangeSearch,
  onClearSearch,
  customerFilter,
  onChangeFilter,
  onOpenNewCustomer,
}) => (
  <View style={styles.crmHeaderWrapper}>
    <SectionHeading title="Cartera de clientes" subtitle="Saldos pendientes y directorio" />
    <View style={styles.kpiRow}>
      <View style={[styles.kpiCard, { borderColor: ui.warning }]}>
        <Text style={styles.kpiLabel}>TOTAL POR COBRAR</Text>
        <Text style={[styles.kpiValue, { color: ui.warning }]}>
          {formatPEN(totalDebt)}
        </Text>
        <Text style={styles.kpiSub}>{debtorsCount} clientes con deuda</Text>
      </View>

      <View style={[styles.kpiCard, { borderColor: ui.primary }]}>
        <Text style={styles.kpiLabel}>DIRECTORIO</Text>
        <Text style={[styles.kpiValue, { color: ui.primary }]}>
          {totalCustomers}
        </Text>
        <Text style={styles.kpiSub}>Clientes registrados</Text>
      </View>
    </View>

    <View style={styles.searchRow}>
      <View style={styles.searchBox}>
        <Search size={18} color={ui.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Nombre, DNI o RUC"
          placeholderTextColor={ui.textMuted}
          value={customerSearch}
          accessibilityLabel="Buscar cliente por nombre, DNI o RUC"
          onChangeText={onChangeSearch}
        />
        {customerSearch.length > 0 && (
          <TouchableOpacity
            onPress={onClearSearch}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Borrar búsqueda de clientes"
          >
            <X size={16} color={ui.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity
        style={styles.iconAddButton}
        onPress={onOpenNewCustomer}
        accessibilityRole="button"
        accessibilityLabel="Agregar cliente"
      >
        <PlusCircle size={22} color={ui.onPrimary} />
      </TouchableOpacity>
    </View>

    <View style={styles.chipRow}>
      <TouchableOpacity
        style={[styles.filterChip, customerFilter === 'all' && styles.filterChipActive]}
        onPress={() => onChangeFilter('all')}
        accessibilityRole="button"
        accessibilityState={{ selected: customerFilter === 'all' }}
        accessibilityLabel="Ver todos los clientes"
      >
        <Text style={[styles.filterChipText, customerFilter === 'all' && styles.filterChipTextActive]}>
          Todos ({totalCustomers})
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.filterChip, customerFilter === 'with_debt' && styles.filterChipActive]}
        onPress={() => onChangeFilter('with_debt')}
        accessibilityRole="button"
        accessibilityState={{ selected: customerFilter === 'with_debt' }}
        accessibilityLabel="Ver clientes con deuda"
      >
        <Text
          style={[
            styles.filterChipText,
            customerFilter === 'with_debt' && styles.filterChipTextActive,
          ]}
        >
          Con Deuda ({debtorsCount})
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.filterChip, customerFilter === 'no_debt' && styles.filterChipActive]}
        onPress={() => onChangeFilter('no_debt')}
        accessibilityRole="button"
        accessibilityState={{ selected: customerFilter === 'no_debt' }}
        accessibilityLabel="Ver clientes sin deuda"
      >
        <Text
          style={[
            styles.filterChipText,
            customerFilter === 'no_debt' && styles.filterChipTextActive,
          ]}
        >
          Sin Deuda
        </Text>
      </TouchableOpacity>
    </View>
  </View>
));

export interface CrmTabViewProps {
  customers: CustomerData[];
  loadingCustomers: boolean;
  listContentContainerStyle: ContentStyle;
  onOpenNewCustomer: () => void;
  onCollectDebt: (cust: CustomerData) => void;
  onOpenDetail: (cust: CustomerData) => void;
}

export const CrmTabView = React.memo<CrmTabViewProps>(({
  customers,
  loadingCustomers,
  listContentContainerStyle,
  onOpenNewCustomer,
  onCollectDebt,
  onOpenDetail,
}) => {
  const [customerSearch, setCustomerSearch] = useState<string>('');
  const debouncedCustomerSearch = useDebouncedValue(customerSearch, 150);
  const [customerFilter, setCustomerFilter] = useState<'all' | 'with_debt' | 'no_debt'>('all');

  const handleClearSearch = useCallback(() => {
    setCustomerSearch('');
  }, []);

  const filteredCustomers = useMemo(() => {
    const term = debouncedCustomerSearch.trim().toLowerCase();
    return customers.filter((c) => {
      const debt = Number(c.currentDebt) || 0;
      if (customerFilter === 'with_debt' && debt <= 0) return false;
      if (customerFilter === 'no_debt' && debt > 0) return false;
      if (!term) return true;
      const name = (c.name || '').toLowerCase();
      const docNum = (c.documentNumber || '').toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      return name.includes(term) || docNum.includes(term) || phone.includes(term);
    });
  }, [customers, customerFilter, debouncedCustomerSearch]);

  const kpisCartera = useMemo(() => {
    let totalDebt = 0;
    let debtorsCount = 0;
    customers.forEach((c) => {
      const debt = Number(c.currentDebt) || 0;
      if (debt > 0) {
        totalDebt += debt;
        debtorsCount += 1;
      }
    });
    return {
      totalDebt: Math.round(totalDebt * 100) / 100,
      debtorsCount,
      totalCustomers: customers.length,
    };
  }, [customers]);

  const customerKeyExtractor = useCallback(
    (item: CustomerData, index: number) => item.id || `cust_${index}`,
    []
  );
  const getCustomerItemType = useCallback(
    (item: CustomerData) => ((Number(item.currentDebt) || 0) > 0 ? 'debtor' : 'clear'),
    []
  );
  const renderCustomerItem = useCallback(
    ({ item }: { item: CustomerData }) => (
      <CustomerCardItem
        cust={item}
        onCollectDebt={onCollectDebt}
        onOpenDetail={onOpenDetail}
      />
    ),
    [onCollectDebt, onOpenDetail]
  );

  const listHeaderElement = (
    <CrmListHeader
      totalDebt={kpisCartera.totalDebt}
      debtorsCount={kpisCartera.debtorsCount}
      totalCustomers={kpisCartera.totalCustomers}
      customerSearch={customerSearch}
      onChangeSearch={setCustomerSearch}
      onClearSearch={handleClearSearch}
      customerFilter={customerFilter}
      onChangeFilter={setCustomerFilter}
      onOpenNewCustomer={onOpenNewCustomer}
    />
  );

  const listEmptyElement = useMemo(() => {
    if (loadingCustomers) {
      return <ActivityIndicator color={ui.primary} style={{ marginVertical: 30 }} />;
    }
    return (
      <View style={styles.emptyContainer}>
        <Users size={40} color={ui.textMuted} />
        <Text style={styles.emptyText}>No se encontraron clientes en esta vista.</Text>
      </View>
    );
  }, [loadingCustomers]);

  return (
    <View style={{ flex: 1 }}>
      <FlashList
        data={filteredCustomers}
        renderItem={renderCustomerItem}
        keyExtractor={customerKeyExtractor}
        getItemType={getCustomerItemType}
        estimatedItemSize={155}
        contentContainerStyle={listContentContainerStyle}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={ListGap16}
        ListHeaderComponent={listHeaderElement}
        ListEmptyComponent={listEmptyElement}
      />
    </View>
  );
});
