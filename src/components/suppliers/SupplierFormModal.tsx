import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Search, CheckCircle2, Check } from 'lucide-react-native';
import { useAuthSession } from '@/context/AuthContext';
import { lookupDocument, DocumentLookupResult } from '@/lib/dni-ruc-service';
import { ui } from '@/lib/theme';
import { assertOnlineForWrite } from '@/lib/online-guard';
import { SuppliersPOService, Supplier } from '@/services/suppliers-po-service';
import { suppliersStyles as styles } from './suppliersStyles';

const SUPPLIER_CATEGORIES = [
  'Mayorista',
  'Distribuidor',
  'Fabricante',
  'Importador',
  'Abarrotes',
  'Bebidas',
  'Insumos',
  'Servicios',
  'Otros',
];

const PAYMENT_TERMS_OPTIONS = [
  'Contado',
  'Crédito 7 días',
  'Crédito 15 días',
  'Crédito 30 días',
  'Crédito 60 días',
  'Contra entrega',
];

export interface SupplierFormModalProps {
  visible: boolean;
  editingSupplier: Supplier | null;
  onClose: () => void;
}

export const SupplierFormModal: React.FC<SupplierFormModalProps> = React.memo(({
  visible,
  editingSupplier,
  onClose,
}) => {
  const { accountId } = useAuthSession();
  const insets = useSafeAreaInsets();

  const [formRuc, setFormRuc] = useState<string>(() => editingSupplier?.taxId || '');
  const [formName, setFormName] = useState<string>(() => editingSupplier?.name || '');
  const [formContactName, setFormContactName] = useState<string>(() => editingSupplier?.contactName || '');
  const [formPhone, setFormPhone] = useState<string>(() => editingSupplier?.phone || '');
  const [formEmail, setFormEmail] = useState<string>(() => editingSupplier?.email || '');
  const [formAddress, setFormAddress] = useState<string>(() => editingSupplier?.address || '');
  const [formCategory, setFormCategory] = useState<string>(() => editingSupplier?.category || 'Mayorista');
  const [formPaymentTerms, setFormPaymentTerms] = useState<string>(() => editingSupplier?.paymentTerms || 'Contado');
  const [formNotes, setFormNotes] = useState<string>(() => editingSupplier?.notes || '');
  const [isLookingUpRuc, setIsLookingUpRuc] = useState<boolean>(false);
  const [sunatStatusMessage, setSunatStatusMessage] = useState<string | null>(null);
  const [isSavingSupplier, setIsSavingSupplier] = useState<boolean>(false);

  useEffect(() => {
    setFormRuc(editingSupplier?.taxId || '');
    setFormName(editingSupplier?.name || '');
    setFormContactName(editingSupplier?.contactName || '');
    setFormPhone(editingSupplier?.phone || '');
    setFormEmail(editingSupplier?.email || '');
    setFormAddress(editingSupplier?.address || '');
    setFormCategory(editingSupplier?.category || 'Mayorista');
    setFormPaymentTerms(editingSupplier?.paymentTerms || 'Contado');
    setFormNotes(editingSupplier?.notes || '');
    setSunatStatusMessage(null);
  }, [editingSupplier]);

  /**
   * Consulta oficial de RUC SUNAT con autocompletado inteligente
   */
  const handleLookupSunat = useCallback(async () => {
    const cleanRuc = formRuc.trim().replace(/\D/g, '');
    if (!cleanRuc || cleanRuc.length !== 11) {
      Alert.alert('RUC Inválido', 'El RUC debe constar de 11 dígitos numéricos.');
      return;
    }

    setIsLookingUpRuc(true);
    setSunatStatusMessage(null);

    try {
      await assertOnlineForWrite('consultar RUC en SUNAT');
      const result: DocumentLookupResult = await lookupDocument('ruc', cleanRuc);

      if (result && result.name) {
        setFormName(result.name);
        if (result.address) {
          setFormAddress(result.address);
        }

        const conditionInfo = [result.estado, result.condicion].filter(Boolean).join(' - ');
        setSunatStatusMessage(conditionInfo || 'RUC Verificado');

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Alert.alert('SUNAT', 'No se encontraron datos para el RUC ingresado.');
      }
    } catch (err: any) {
      console.warn('[handleLookupSunat] Error en consulta RUC:', err);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Consulta SUNAT',
        err?.message || 'No se pudo obtener información del RUC en SUNAT. Puedes completarlo manualmente.'
      );
    } finally {
      setIsLookingUpRuc(false);
    }
  }, [formRuc]);

  const handleSaveSupplier = useCallback(async () => {
    if (!accountId) {
      Alert.alert('Error', 'No hay cuenta de usuario activa.');
      return;
    }

    if (!formName.trim()) {
      Alert.alert('Campo Obligatorio', 'Ingresa la razón social o nombre del proveedor.');
      return;
    }

    setIsSavingSupplier(true);
    try {
      await assertOnlineForWrite('guardar un proveedor');
      await SuppliersPOService.saveSupplier({
        id: editingSupplier?.id,
        accountId,
        name: formName.trim(),
        taxId: formRuc.trim(),
        contactName: formContactName.trim() || undefined,
        phone: formPhone.trim() || undefined,
        email: formEmail.trim() || undefined,
        address: formAddress.trim() || undefined,
        category: formCategory.trim() || 'General',
        paymentTerms: formPaymentTerms.trim() || 'Contado',
        notes: formNotes.trim() || undefined,
        active: true,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        '¡Proveedor Guardado!',
        editingSupplier ? 'Los datos han sido actualizados.' : 'El proveedor fue registrado exitosamente.'
      );
      onClose();
    } catch (err: any) {
      console.error('[handleSaveSupplier] Error al guardar proveedor:', err);
      Alert.alert('Error', err?.message || 'No se pudo guardar el proveedor.');
    } finally {
      setIsSavingSupplier(false);
    }
  }, [
    accountId,
    editingSupplier,
    formName,
    formRuc,
    formContactName,
    formPhone,
    formEmail,
    formAddress,
    formCategory,
    formPaymentTerms,
    formNotes,
    onClose,
  ]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={[styles.modalSheetContainer, { paddingBottom: Math.max(12, insets.bottom) }]}
          collapsable={false}
        >
          <View style={styles.subModalHeader}>
            <View>
              <Text style={styles.subModalTitle}>
                {editingSupplier ? 'Editar Proveedor' : 'Nuevo Proveedor'}
              </Text>
              <Text style={styles.subModalSubtitle}>
                Directorio comercial y datos de facturación
              </Text>
            </View>
            <TouchableOpacity style={styles.closeSubModalBtn} onPress={onClose}>
              <X size={20} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.subModalBody} keyboardShouldPersistTaps="handled">
            <Text style={[styles.formSectionLabel, { marginTop: 2 }]}>Identificación fiscal</Text>
            {/* CAMPO RUC CON CONSULTA SUNAT */}
            <Text style={styles.inputLabel}>RUC (11 dígitos) *</Text>
            <View style={styles.rucInputRow}>
              <TextInput
                style={[styles.textInput, { flex: 1, marginBottom: 0 }]}
                placeholder="20XXXXXXXXX"
                placeholderTextColor={ui.textMuted}
                keyboardType="numeric"
                maxLength={11}
                value={formRuc}
                onChangeText={setFormRuc}
              />
              <TouchableOpacity
                style={[styles.sunatLookupBtn, isLookingUpRuc && styles.btnDisabled]}
                onPress={handleLookupSunat}
                disabled={isLookingUpRuc}
              >
                {isLookingUpRuc ? (
                  <ActivityIndicator size="small" color={ui.surface} />
                ) : (
                  <>
                    <Search size={15} color={ui.surface} />
                    <Text style={styles.sunatLookupBtnText}>SUNAT</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {sunatStatusMessage && (
              <View style={styles.sunatStatusBadge}>
                <CheckCircle2 size={14} color={ui.primary} />
                <Text style={styles.sunatStatusBadgeText}>{sunatStatusMessage}</Text>
              </View>
            )}

            {/* RAZÓN SOCIAL / NOMBRE */}
            <Text style={styles.inputLabel}>Razón Social / Nombre Comercial *</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Nombre de la empresa o distribuidora"
              placeholderTextColor={ui.textMuted}
              value={formName}
              onChangeText={setFormName}
            />

            <Text style={[styles.formSectionLabel, { marginTop: 10 }]}>Contacto</Text>
            {/* CONTACTO */}
            <Text style={styles.inputLabel}>Persona de Contacto</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Nombre del asesor de ventas / contacto"
              placeholderTextColor={ui.textMuted}
              value={formContactName}
              onChangeText={setFormContactName}
            />

            {/* TELÉFONO / CELULAR */}
            <Text style={styles.inputLabel}>Teléfono / WhatsApp</Text>
            <TextInput
              style={styles.textInput}
              placeholder="9XXXXXXXX o teléfono fijo"
              placeholderTextColor={ui.textMuted}
              keyboardType="phone-pad"
              value={formPhone}
              onChangeText={setFormPhone}
            />

            {/* EMAIL */}
            <Text style={styles.inputLabel}>Correo Electrónico</Text>
            <TextInput
              style={styles.textInput}
              placeholder="ventas@proveedor.pe"
              placeholderTextColor={ui.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              value={formEmail}
              onChangeText={setFormEmail}
            />

            {/* DIRECCIÓN */}
            <Text style={styles.inputLabel}>Dirección Fiscal / Almacén</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Av. Principal 123, Lima..."
              placeholderTextColor={ui.textMuted}
              value={formAddress}
              onChangeText={setFormAddress}
            />

            <Text style={[styles.formSectionLabel, { marginTop: 10 }]}>Condiciones comerciales</Text>
            {/* CATEGORÍA */}
            <Text style={styles.inputLabel}>Categoría</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoriesRow}>
              {SUPPLIER_CATEGORIES.map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.catOptionChip,
                    formCategory === cat && styles.catOptionChipActive,
                  ]}
                  onPress={() => setFormCategory(cat)}
                >
                  <Text
                    style={[
                      styles.catOptionChipText,
                      formCategory === cat && styles.catOptionChipTextActive,
                    ]}
                  >
                    {cat}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* CONDICIONES DE PAGO */}
            <Text style={styles.inputLabel}>Condiciones de Pago</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoriesRow}>
              {PAYMENT_TERMS_OPTIONS.map((term) => (
                <TouchableOpacity
                  key={term}
                  style={[
                    styles.catOptionChip,
                    formPaymentTerms === term && styles.catOptionChipActive,
                  ]}
                  onPress={() => setFormPaymentTerms(term)}
                >
                  <Text
                    style={[
                      styles.catOptionChipText,
                      formPaymentTerms === term && styles.catOptionChipTextActive,
                    ]}
                  >
                    {term}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* NOTAS */}
            <Text style={styles.inputLabel}>Notas / Datos Bancarios</Text>
            <TextInput
              style={[styles.textInput, { height: 65, textAlignVertical: 'top' }]}
              placeholder="Banco, número de cuenta CCI, días de visita..."
              placeholderTextColor={ui.textMuted}
              multiline
              numberOfLines={3}
              value={formNotes}
              onChangeText={setFormNotes}
            />

            <View style={{ height: 25 }} />
          </ScrollView>

          <View style={styles.subModalFooter}>
            <TouchableOpacity style={styles.subModalCancelBtn} onPress={onClose}>
              <Text style={styles.subModalCancelBtnText}>Cancelar</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveSupplierSubmitBtn, isSavingSupplier && styles.btnDisabled]}
              onPress={handleSaveSupplier}
              disabled={isSavingSupplier}
            >
              {isSavingSupplier ? (
                <ActivityIndicator size="small" color={ui.surface} />
              ) : (
                <>
                  <Check size={18} color={ui.surface} />
                  <Text style={styles.saveSupplierSubmitBtnText}>
                    {editingSupplier ? 'Actualizar' : 'Guardar Proveedor'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});
