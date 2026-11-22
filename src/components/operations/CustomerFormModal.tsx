import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { lookupDocument } from '@/lib/dni-ruc-service';
import { ui } from '@/lib/theme';
import { saveCustomer } from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';

export interface CustomerFormModalProps {
  visible: boolean;
  accountId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export const CustomerFormModal = React.memo<CustomerFormModalProps>(({
  visible,
  accountId,
  onClose,
  onSaved,
}) => {
  const [docType, setDocType] = useState<'DNI' | 'RUC'>('DNI');
  const [docNumber, setDocNumber] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerEmail, setCustomerEmail] = useState<string>('');
  const [customerAddress, setCustomerAddress] = useState<string>('');
  const [creditLimitInput, setCreditLimitInput] = useState<string>('200');
  const [isLookingUpDoc, setIsLookingUpDoc] = useState<boolean>(false);
  const [isSavingCustomer, setIsSavingCustomer] = useState<boolean>(false);

  useEffect(() => {
    if (visible) {
      setDocType('DNI');
      setDocNumber('');
      setCustomerName('');
      setCustomerPhone('');
      setCustomerEmail('');
      setCustomerAddress('');
      setCreditLimitInput('200');
      setIsLookingUpDoc(false);
      setIsSavingCustomer(false);
    }
  }, [visible]);

  const handleLookupDoc = useCallback(async () => {
    if (!docNumber.trim()) {
      Alert.alert('Número Vacío', 'Ingrese el DNI o RUC a consultar.');
      return;
    }

    setIsLookingUpDoc(true);
    try {
      const res = await lookupDocument(
        docType.toLowerCase() as 'dni' | 'ruc',
        docNumber.trim()
      );
      if (res && res.name) {
        setCustomerName(res.name);
        if (res.address) {
          setCustomerAddress(res.address);
        }
      } else {
        Alert.alert(
          'No Encontrado',
          'No se hallaron datos para este documento en RENIEC/SUNAT.'
        );
      }
    } catch (err: any) {
      Alert.alert('Consulta Fallida', err?.message || 'Error consultando padrón oficial.');
    } finally {
      setIsLookingUpDoc(false);
    }
  }, [docNumber, docType]);

  const handleSaveCustomer = useCallback(async () => {
    if (!customerName.trim()) {
      Alert.alert(
        'Nombre Requerido',
        'Ingrese la razón social o nombre completo del cliente.'
      );
      return;
    }
    if (!accountId) return;

    const limitVal = parseFloat(creditLimitInput.replace(',', '.'));

    setIsSavingCustomer(true);
    try {
      await saveCustomer({
        accountId,
        name: customerName.trim(),
        documentType: docType,
        documentNumber: docNumber.trim() || undefined,
        phone: customerPhone.trim() || undefined,
        email: customerEmail.trim() || undefined,
        address: customerAddress.trim() || undefined,
        creditLimit: isNaN(limitVal) ? 200 : limitVal,
        currentDebt: 0,
      });

      onClose();
      onSaved();
      Alert.alert(
        'Cliente Guardado',
        'El cliente ha sido registrado exitosamente en la cartera.'
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'No se pudo guardar el cliente.');
    } finally {
      setIsSavingCustomer(false);
    }
  }, [
    customerName,
    accountId,
    creditLimitInput,
    docType,
    docNumber,
    customerPhone,
    customerEmail,
    customerAddress,
    onClose,
    onSaved,
  ]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!isSavingCustomer) onClose();
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.modalSafe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, styles.modalContentTall90]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nuevo Cliente en Cartera</Text>
              <TouchableOpacity
                onPress={() => {
                  if (!isSavingCustomer) onClose();
                }}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Cerrar formulario de cliente"
              >
                <X size={20} color={ui.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={styles.docTypeRow}>
                <TouchableOpacity
                  style={[styles.docTypeBtn, docType === 'DNI' && styles.docTypeBtnActive]}
                  onPress={() => setDocType('DNI')}
                >
                  <Text
                    style={[
                      styles.docTypeText,
                      docType === 'DNI' && styles.docTypeTextActive,
                    ]}
                  >
                    DNI (RENIEC)
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.docTypeBtn, docType === 'RUC' && styles.docTypeBtnActive]}
                  onPress={() => setDocType('RUC')}
                >
                  <Text
                    style={[
                      styles.docTypeText,
                      docType === 'RUC' && styles.docTypeTextActive,
                    ]}
                  >
                    RUC (SUNAT)
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Número de Documento</Text>
                <View style={styles.lookupInputRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder={docType === 'DNI' ? '8 dígitos' : '11 dígitos'}
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                    value={docNumber}
                    onChangeText={setDocNumber}
                  />
                  <TouchableOpacity
                    style={styles.lookupButton}
                    onPress={handleLookupDoc}
                    disabled={isLookingUpDoc}
                  >
                    {isLookingUpDoc ? (
                      <ActivityIndicator color={ui.onPrimary} size="small" />
                    ) : (
                      <Text style={styles.lookupButtonText}>Consultar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Nombre o Razón Social</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Nombre completo"
                  placeholderTextColor={ui.textMuted}
                  value={customerName}
                  onChangeText={setCustomerName}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Teléfono / WhatsApp</Text>
                <TextInput
                  style={styles.input}
                  placeholder="987654321"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="phone-pad"
                  value={customerPhone}
                  onChangeText={setCustomerPhone}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Dirección Fiscal / Entrega</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Av. Principal 123"
                  placeholderTextColor={ui.textMuted}
                  value={customerAddress}
                  onChangeText={setCustomerAddress}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Línea de Crédito Máxima (S/)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="200.00"
                  placeholderTextColor={ui.textMuted}
                  keyboardType="decimal-pad"
                  value={creditLimitInput}
                  onChangeText={setCreditLimitInput}
                />
              </View>
            </ScrollView>

            <TouchableOpacity
              style={[styles.primaryButton, isSavingCustomer && styles.buttonDisabled]}
              onPress={handleSaveCustomer}
              disabled={isSavingCustomer}
            >
              {isSavingCustomer ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <Text style={styles.primaryButtonText}>Guardar Cliente</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
