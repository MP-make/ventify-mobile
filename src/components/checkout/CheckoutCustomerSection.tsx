import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { AlertCircle, Check, Search, User, X } from 'lucide-react-native';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { isValidDNI, isValidRUC } from '@/lib/invoicing/types';
import { DocumentLookupResult, lookupDocument } from '@/lib/dni-ruc-service';
import { ui } from '@/lib/theme';
import type { Customer } from '@/types';
import type { CheckoutCustomerFormValues, CheckoutDocType } from './checkout-types';

export interface CheckoutCustomerSectionProps {
  visible: boolean;
  docType: CheckoutDocType;
  docTypeRef: React.MutableRefObject<CheckoutDocType>;
  documentSelectionLockedRef: React.MutableRefObject<boolean>;
  invoicingEnabled: boolean;
  safeTotal: number;
  cartCustomer: Customer | null;
  customersList: Customer[];
  showCustomerPicker: boolean;
  onToggleCustomerPicker: () => void;
  onCloseCustomerPicker: () => void;
  customerFormRef: React.MutableRefObject<CheckoutCustomerFormValues>;
  onSetDocType: (nextDocType: CheckoutDocType) => void;
  onSelectedCustomerChange: (customer: Customer | null) => void;
  onFacturaValidChange: (isValid: boolean) => void;
  onSyncCustomerToCart: (patch?: Partial<Omit<CheckoutCustomerFormValues, 'selectedCustomer'>>) => void;
  onSetCartCustomerDirect: (customer: Customer) => void;
}

/**
 * Self-contained customer directory picker + RENIEC/SUNAT doc inputs.
 * Typing into DNI, RUC, name, address, phone, or search query only re-renders
 * this subcomponent instead of the entire CheckoutModal.
 */
export const CheckoutCustomerSection = React.memo<CheckoutCustomerSectionProps>(({
  visible,
  docType,
  docTypeRef,
  documentSelectionLockedRef,
  invoicingEnabled,
  safeTotal,
  cartCustomer,
  customersList,
  showCustomerPicker,
  onToggleCustomerPicker,
  onCloseCustomerPicker,
  customerFormRef,
  onSetDocType,
  onSelectedCustomerChange,
  onFacturaValidChange,
  onSyncCustomerToCart,
  onSetCartCustomerDirect,
}) => {
  const [customerDni, setCustomerDni] = useState('');
  const [customerRuc, setCustomerRuc] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const debouncedCustomerSearch = useDebouncedValue(customerSearchQuery, 150);

  const [isSearchingDoc, setIsSearchingDoc] = useState(false);
  const [docSearchSuccess, setDocSearchSuccess] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  const lookupAbortRef = useRef<AbortController | null>(null);
  const lookupSeqRef = useRef<number>(0);
  const skipNextLookupDocRef = useRef<string | null>(null);
  const lastAutoLookedUpRef = useRef<{ dni: string; ruc: string }>({ dni: '', ruc: '' });
  const wasVisibleRef = useRef(false);

  customerFormRef.current = {
    name: customerName,
    dni: customerDni,
    ruc: customerRuc,
    phone: customerPhone,
    address: customerAddress,
    selectedCustomer,
  };

  useEffect(() => {
    return () => {
      lookupAbortRef.current?.abort();
    };
  }, []);

  // Initialize from cartCustomer on closed -> open transition
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      wasVisibleRef.current = true;
      setDocError(null);
      setDocSearchSuccess(null);
      setCustomerSearchQuery('');
      lastAutoLookedUpRef.current = { dni: '', ruc: '' };

      if (cartCustomer) {
        setSelectedCustomer(cartCustomer);
        onSelectedCustomerChange(cartCustomer);
        setCustomerName(cartCustomer.name || '');
        if (cartCustomer.ruc) {
          const cleanR = cartCustomer.ruc.trim().replace(/\D/g, '');
          if (cleanR.length === 11) {
            skipNextLookupDocRef.current = cleanR;
            lastAutoLookedUpRef.current.ruc = cleanR;
          }
          setCustomerRuc(cartCustomer.ruc);
          setCustomerDni('');
        } else if (cartCustomer.dni) {
          const cleanD = cartCustomer.dni.trim().replace(/\D/g, '');
          if (cleanD.length === 8) {
            skipNextLookupDocRef.current = cleanD;
            lastAutoLookedUpRef.current.dni = cleanD;
          }
          setCustomerDni(cartCustomer.dni);
          setCustomerRuc('');
        } else {
          setCustomerDni('');
          setCustomerRuc('');
        }
        setCustomerAddress(cartCustomer.address || '');
        setCustomerPhone(cartCustomer.phone || '');
      } else {
        skipNextLookupDocRef.current = null;
        setSelectedCustomer(null);
        onSelectedCustomerChange(null);
        setCustomerDni('');
        setCustomerRuc('');
        setCustomerName('');
        setCustomerAddress('');
        setCustomerPhone('');
      }
    } else if (!visible) {
      wasVisibleRef.current = false;
      lookupAbortRef.current?.abort();
      lookupAbortRef.current = null;
    }
  }, [visible, cartCustomer, onSelectedCustomerChange]);

  const cleanRucForFactura = customerRuc.trim().replace(/\D/g, '');
  const isFacturaValid =
    cleanRucForFactura.length === 11 &&
    isValidRUC(cleanRucForFactura) &&
    Boolean(customerName.trim());

  useEffect(() => {
    onFacturaValidChange(isFacturaValid);
  }, [isFacturaValid, onFacturaValidChange]);

  // Decoupled from docType via docTypeRef so switching nota_venta/boleta/factura never re-triggers HTTP lookups
  const handleLookup = useCallback(async (type: 'dni' | 'ruc', number: string) => {
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;
    const reqId = ++lookupSeqRef.current;

    try {
      setIsSearchingDoc(true);
      setDocError(null);
      setDocSearchSuccess(null);

      const res: DocumentLookupResult = await lookupDocument(type, number, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || lookupSeqRef.current !== reqId) {
        if (lastAutoLookedUpRef.current[type] === number) {
          lastAutoLookedUpRef.current[type] = '';
        }
        return;
      }

      if (res && res.name) {
        setCustomerName(res.name);
        if (res.address) {
          setCustomerAddress(res.address);
        }
        setDocSearchSuccess(`${type.toUpperCase()} verificado: ${res.name}`);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onSyncCustomerToCart({
          name: res.name,
          address: res.address || customerFormRef.current.address,
          dni: type === 'dni' ? number : customerFormRef.current.dni,
          ruc: type === 'ruc' ? number : customerFormRef.current.ruc,
        });
        if (
          invoicingEnabled &&
          !documentSelectionLockedRef.current &&
          docTypeRef.current !== 'cotizacion'
        ) {
          if (type === 'ruc') onSetDocType('factura');
          else if (type === 'dni') onSetDocType('boleta');
        }
      }
    } catch (err: any) {
      if (err?.code === 'ABORTED' || controller.signal.aborted || lookupSeqRef.current !== reqId) {
        if (lastAutoLookedUpRef.current[type] === number) {
          lastAutoLookedUpRef.current[type] = '';
        }
        return;
      }
      setDocError(err?.message || `No se encontró información para este ${type.toUpperCase()}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      if (lookupSeqRef.current === reqId) {
        setIsSearchingDoc(false);
      }
    }
  }, [invoicingEnabled, onSyncCustomerToCart, onSetDocType, docTypeRef, documentSelectionLockedRef, customerFormRef]);

  // Debounced DNI auto-lookup (>= 450ms) with duplicate guard
  useEffect(() => {
    if (!visible) return;
    const cleanDni = customerDni.trim().replace(/\D/g, '');
    if (cleanDni.length !== 8 || !isValidDNI(cleanDni)) {
      lastAutoLookedUpRef.current.dni = '';
      return;
    }
    if (skipNextLookupDocRef.current === cleanDni) {
      skipNextLookupDocRef.current = null;
      lastAutoLookedUpRef.current.dni = cleanDni;
      return;
    }
    if (lastAutoLookedUpRef.current.dni === cleanDni) {
      return;
    }
    const timer = setTimeout(() => {
      lastAutoLookedUpRef.current.dni = cleanDni;
      void handleLookup('dni', cleanDni);
    }, 500);
    return () => {
      clearTimeout(timer);
      lookupAbortRef.current?.abort();
    };
  }, [visible, customerDni, handleLookup]);

  // Debounced RUC auto-lookup (>= 450ms) with duplicate guard
  useEffect(() => {
    if (!visible) return;
    const cleanRuc = customerRuc.trim().replace(/\D/g, '');
    if (cleanRuc.length !== 11 || !isValidRUC(cleanRuc)) {
      lastAutoLookedUpRef.current.ruc = '';
      return;
    }
    if (skipNextLookupDocRef.current === cleanRuc) {
      skipNextLookupDocRef.current = null;
      lastAutoLookedUpRef.current.ruc = cleanRuc;
      return;
    }
    if (lastAutoLookedUpRef.current.ruc === cleanRuc) {
      return;
    }
    const timer = setTimeout(() => {
      lastAutoLookedUpRef.current.ruc = cleanRuc;
      void handleLookup('ruc', cleanRuc);
    }, 500);
    return () => {
      clearTimeout(timer);
      lookupAbortRef.current?.abort();
    };
  }, [visible, customerRuc, handleLookup]);

  const filteredPickerCustomers = useMemo(() => {
    const q = debouncedCustomerSearch.trim().toLowerCase();
    if (!q) return customersList.slice(0, 6);
    return customersList
      .filter((c) => {
        const name = (c.name || '').toLowerCase();
        const dni = (c.dni || '').toLowerCase();
        const ruc = (c.ruc || '').toLowerCase();
        const phone = (c.phone || '').toLowerCase();
        return name.includes(q) || dni.includes(q) || ruc.includes(q) || phone.includes(q);
      })
      .slice(0, 12);
  }, [customersList, debouncedCustomerSearch]);

  const handleBlurSync = useCallback(() => {
    onSyncCustomerToCart();
  }, [onSyncCustomerToCart]);

  const handleSelectExistingCustomer = (c: Customer) => {
    setSelectedCustomer(c);
    onSelectedCustomerChange(c);
    setCustomerName(c.name || '');
    if (c.ruc) {
      const cleanR = c.ruc.trim().replace(/\D/g, '');
      if (cleanR.length === 11) {
        skipNextLookupDocRef.current = cleanR;
        lastAutoLookedUpRef.current.ruc = cleanR;
      }
      setCustomerRuc(c.ruc);
      if (
        invoicingEnabled &&
        !documentSelectionLockedRef.current &&
        docTypeRef.current !== 'cotizacion'
      ) {
        onSetDocType('factura');
      }
    } else if (c.dni) {
      const cleanD = c.dni.trim().replace(/\D/g, '');
      if (cleanD.length === 8) {
        skipNextLookupDocRef.current = cleanD;
        lastAutoLookedUpRef.current.dni = cleanD;
      }
      setCustomerDni(c.dni);
      if (
        invoicingEnabled &&
        !documentSelectionLockedRef.current &&
        docTypeRef.current !== 'cotizacion'
      ) {
        onSetDocType('boleta');
      }
    }
    setCustomerAddress(c.address || '');
    setCustomerPhone(c.phone || '');
    setCustomerSearchQuery('');
    onCloseCustomerPicker();
    setDocSearchSuccess(`Cliente: ${c.name}`);
    onSetCartCustomerDirect(c);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <View style={styles.customerBoxCompact}>
      <View style={styles.customerBoxHeader}>
        <View style={styles.customerHeaderLeft}>
          <User size={14} color={ui.text} />
          <Text style={styles.customerBoxTitleCompact}>Datos del Cliente</Text>
        </View>
        <TouchableOpacity
          style={styles.customerDirectoryBtn}
          onPress={() => {
            if (showCustomerPicker) setCustomerSearchQuery('');
            onToggleCustomerPicker();
          }}
          accessibilityRole="button"
          accessibilityLabel={showCustomerPicker ? 'Cerrar búsqueda de clientes' : 'Buscar cliente'}
          accessibilityState={{ expanded: showCustomerPicker }}
        >
          {showCustomerPicker ? (
            <X size={12} color={ui.primary} />
          ) : (
            <Search size={12} color={ui.primary} />
          )}
          <Text style={styles.customerDirectoryBtnText}>
            {showCustomerPicker ? 'Cerrar' : 'Buscar'}
          </Text>
        </TouchableOpacity>
      </View>

      {showCustomerPicker ? (
        <View style={styles.customerPickerDropdown}>
          <View style={styles.customerSearchInputRow}>
            <Search size={14} color={ui.textMuted} />
            <TextInput
              style={styles.customerSearchInput}
              value={customerSearchQuery}
              onChangeText={setCustomerSearchQuery}
              placeholder="Buscar por nombre, DNI, RUC o teléfono..."
              placeholderTextColor={ui.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {customerSearchQuery.length > 0 ? (
              <TouchableOpacity onPress={() => setCustomerSearchQuery('')} hitSlop={6}>
                <X size={14} color={ui.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
          <Text style={styles.pickerHeading}>
            {customerSearchQuery.trim() ? 'Resultados:' : 'Clientes Frecuentes:'}
          </Text>
          {filteredPickerCustomers.length === 0 ? (
            <Text style={styles.pickerEmptyText}>
              {customersList.length === 0
                ? 'No hay clientes guardados todavía.'
                : 'No se encontraron clientes con esa búsqueda.'}
            </Text>
          ) : (
            filteredPickerCustomers.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={styles.pickerItem}
                onPress={() => handleSelectExistingCustomer(c)}
                accessibilityRole="button"
                accessibilityLabel={`Seleccionar cliente ${c.name}${c.ruc ? `, RUC ${c.ruc}` : c.dni ? `, DNI ${c.dni}` : ''}`}
              >
                <Text style={styles.pickerItemName}>{c.name}</Text>
                <Text style={styles.pickerItemDoc}>
                  {c.ruc ? `RUC: ${c.ruc}` : c.dni ? `DNI: ${c.dni}` : 'Sin doc'}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      ) : (
        <>
          {docType === 'factura' ? (
            <View style={styles.formGroupCompact}>
              <Text style={styles.inputLabelCompact}>
                RUC (11 dígitos) <Text style={styles.required}>*</Text>
              </Text>
              <View style={styles.inputSearchRow}>
                <TextInput
                  style={[styles.inputCompact, styles.inputFlex]}
                  accessibilityLabel="RUC, 11 dígitos"
                  value={customerRuc}
                  onChangeText={(val) => {
                    customerFormRef.current.ruc = val;
                    setCustomerRuc(val);
                  }}
                  onBlur={handleBlurSync}
                  placeholder="20XXXXXXXXX"
                  keyboardType="numeric"
                  maxLength={11}
                  placeholderTextColor={ui.textMuted}
                />
                {isSearchingDoc ? (
                  <View style={styles.searchLoader}>
                    <ActivityIndicator size="small" color={ui.primary} />
                  </View>
                ) : null}
              </View>
              <Text style={styles.inputLabelCompact}>Razón Social SUNAT</Text>
              <TextInput
                style={styles.inputCompact}
                accessibilityLabel="Razón social SUNAT"
                value={customerName}
                onChangeText={(val) => {
                  customerFormRef.current.name = val;
                  setCustomerName(val);
                }}
                onBlur={handleBlurSync}
                placeholder="Nombre o Razón Social"
                placeholderTextColor={ui.textMuted}
              />
              <View style={styles.rowTwoCols}>
                <View style={[styles.formGroupCompact, styles.colFlex]}>
                  <Text style={styles.inputLabelCompact}>Dirección Fiscal</Text>
                  <TextInput
                    style={styles.inputCompact}
                    value={customerAddress}
                    onChangeText={(val) => {
                      customerFormRef.current.address = val;
                      setCustomerAddress(val);
                    }}
                    onBlur={handleBlurSync}
                    placeholder="Dirección fiscal"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={[styles.formGroupCompact, styles.colFlex]}>
                  <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
                  <TextInput
                    style={styles.inputCompact}
                    value={customerPhone}
                    onChangeText={(val) => {
                      customerFormRef.current.phone = val;
                      setCustomerPhone(val);
                    }}
                    onBlur={handleBlurSync}
                    placeholder="9XXXXXXXX"
                    keyboardType="phone-pad"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>
            </View>
          ) : docType === 'boleta' ? (
            <View style={styles.formGroupCompact}>
              <Text style={styles.inputLabelCompact}>
                DNI {safeTotal >= 700 ? '(Obligatorio > S/700)' : '(Prioridad)'}
              </Text>
              <View style={styles.inputSearchRow}>
                <TextInput
                  style={[styles.inputCompact, styles.inputFlex]}
                  value={customerDni}
                  onChangeText={(val) => {
                    customerFormRef.current.dni = val;
                    setCustomerDni(val);
                  }}
                  onBlur={handleBlurSync}
                  placeholder="8 dígitos"
                  keyboardType="numeric"
                  maxLength={8}
                  placeholderTextColor={ui.textMuted}
                />
                {isSearchingDoc ? (
                  <View style={styles.searchLoader}>
                    <ActivityIndicator size="small" color={ui.primary} />
                  </View>
                ) : null}
              </View>
              <View style={styles.rowTwoCols}>
                <View style={[styles.formGroupCompact, { flex: 1.4 }]}>
                  <Text style={styles.inputLabelCompact}>Nombre del Cliente</Text>
                  <TextInput
                    style={styles.inputCompact}
                    value={customerName}
                    onChangeText={(val) => {
                      customerFormRef.current.name = val;
                      setCustomerName(val);
                    }}
                    onBlur={handleBlurSync}
                    placeholder="Público General"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={[styles.formGroupCompact, styles.colFlex]}>
                  <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
                  <TextInput
                    style={styles.inputCompact}
                    value={customerPhone}
                    onChangeText={(val) => {
                      customerFormRef.current.phone = val;
                      setCustomerPhone(val);
                    }}
                    onBlur={handleBlurSync}
                    placeholder="9XXXXXXXX"
                    keyboardType="phone-pad"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>
            </View>
          ) : (
            <View style={styles.formGroupCompact}>
              <Text style={styles.inputLabelCompact}>Nombre del Cliente (Prioridad)</Text>
              <TextInput
                style={styles.inputCompact}
                value={customerName}
                onChangeText={(val) => {
                  customerFormRef.current.name = val;
                  setCustomerName(val);
                }}
                onBlur={handleBlurSync}
                placeholder="Público General"
                placeholderTextColor={ui.textMuted}
              />
              <View style={styles.rowTwoCols}>
                <View style={[styles.formGroupCompact, styles.colFlex]}>
                  <Text style={styles.inputLabelCompact}>DNI (Opcional)</Text>
                  <TextInput
                    style={styles.inputCompact}
                    value={customerDni}
                    onChangeText={(val) => {
                      customerFormRef.current.dni = val;
                      setCustomerDni(val);
                    }}
                    onBlur={handleBlurSync}
                    placeholder="8 dígitos"
                    keyboardType="numeric"
                    maxLength={8}
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={[styles.formGroupCompact, styles.colFlex]}>
                  <Text style={styles.inputLabelCompact}>WhatsApp (Opcional)</Text>
                  <TextInput
                    style={styles.inputCompact}
                    value={customerPhone}
                    onChangeText={(val) => {
                      customerFormRef.current.phone = val;
                      setCustomerPhone(val);
                    }}
                    onBlur={handleBlurSync}
                    placeholder="9XXXXXXXX"
                    keyboardType="phone-pad"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>
            </View>
          )}

          {docSearchSuccess ? (
            <View style={styles.docSuccessBadge}>
              <Check size={14} color={ui.success} />
              <Text style={styles.docSuccessText}>{docSearchSuccess}</Text>
            </View>
          ) : null}
          {docError ? (
            <View style={styles.docErrorBadge}>
              <AlertCircle size={14} color={ui.danger} />
              <Text style={styles.docErrorText}>{docError}</Text>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  customerBoxCompact: {
    backgroundColor: ui.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: ui.border,
    padding: 10,
    marginBottom: 10,
  },
  customerBoxHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  customerHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  customerBoxTitleCompact: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  customerDirectoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  customerDirectoryBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  customerPickerDropdown: {
    marginTop: 8,
    marginBottom: 4,
    padding: 10,
    borderRadius: 10,
    backgroundColor: ui.background,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 6,
  },
  customerSearchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 38,
    marginBottom: 4,
  },
  customerSearchInput: {
    flex: 1,
    fontSize: 13,
    color: ui.text,
    paddingVertical: 0,
  },
  pickerHeading: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.textSecondary,
    marginBottom: 6,
  },
  pickerItem: {
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: ui.surfaceMuted,
  },
  pickerItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  pickerItemDoc: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  pickerEmptyText: {
    color: ui.textSecondary,
    fontSize: 13,
    paddingVertical: 8,
  },
  formGroupCompact: {
    marginBottom: 6,
  },
  inputLabelCompact: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.textSecondary,
    marginBottom: 3,
  },
  required: {
    color: ui.danger,
  },
  inputCompact: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: ui.text,
  },
  inputSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputFlex: {
    flex: 1,
  },
  searchLoader: {
    position: 'absolute',
    right: 12,
  },
  rowTwoCols: {
    flexDirection: 'row',
    gap: 10,
  },
  colFlex: {
    flex: 1,
  },
  docSuccessBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.successSoft,
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  docSuccessText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.success,
  },
  docErrorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.dangerSoft,
    padding: 8,
    borderRadius: 8,
    marginTop: 6,
  },
  docErrorText: {
    fontSize: 11,
    fontWeight: '600',
    color: ui.danger,
  },
});
