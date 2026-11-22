import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { CreditCard, ImagePlus, QrCode, Save, Trash2 } from 'lucide-react-native';

import { SectionHeading } from '@/components/ui';
import { app } from '@/lib/firebase';
import { ui } from '@/lib/theme';
import type { PosPaymentMethodConfig, PosSettings } from '@/types';

import { settingsStyles as styles } from './settingsStyles';

interface QrMethodCardProps {
  method: PosPaymentMethodConfig;
  canManageSettings: boolean;
  isUploading: boolean;
  onUploadQr: (methodId: string) => void;
  onUpdateQrUrl: (methodId: string, qrUrl: string) => void;
}

const QrMethodCard = React.memo<QrMethodCardProps>(
  ({ method, canManageSettings, isUploading, onUploadQr, onUpdateQrUrl }) => (
    <View style={styles.qrMethodBox}>
      <View style={styles.inlineBetween}>
        <Text style={styles.digitalPayTitle}>QR {method.name}</Text>
        {method.qrUrl && canManageSettings ? (
          <TouchableOpacity
            onPress={() => onUpdateQrUrl(method.id, '')}
            style={styles.iconActionBtn}
            accessibilityLabel={`Quitar QR de ${method.name}`}
          >
            <Trash2 size={16} color={ui.danger} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.qrPreviewRow}>
        {method.qrUrl ? (
          <Image
            source={{ uri: method.qrUrl }}
            style={styles.qrPreviewImage}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={styles.qrPlaceholder}>
            <QrCode size={26} color={ui.textMuted} />
          </View>
        )}

        <View style={styles.flex1}>
          {canManageSettings ? (
            <TouchableOpacity
              style={styles.secondaryOutlineBtn}
              onPress={() => onUploadQr(method.id)}
              disabled={isUploading}
            >
              {isUploading ? (
                <ActivityIndicator size="small" color={ui.primary} />
              ) : (
                <>
                  <ImagePlus size={16} color={ui.primary} />
                  <Text style={styles.secondaryOutlineBtnText}>
                    {method.qrUrl ? 'Reemplazar desde Galería' : 'Subir QR desde Galería'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
          <TextInput
            style={[
              styles.textInput,
              styles.qrUrlInput,
              !canManageSettings && styles.inputReadOnly,
            ]}
            placeholder="O pega URL directa del QR (https://...)"
            placeholderTextColor={ui.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            value={method.qrUrl || ''}
            onChangeText={(txt) => onUpdateQrUrl(method.id, txt)}
            editable={canManageSettings}
          />
        </View>
      </View>
    </View>
  )
);

interface PaymentMethodRowProps {
  method: PosPaymentMethodConfig;
  isDefault: boolean;
  canManageSettings: boolean;
  onSetDefault: (methodId: string) => void;
  onToggleEnabled: (methodId: string, enabled: boolean) => void;
}

const PaymentMethodRow = React.memo<PaymentMethodRowProps>(
  ({ method, isDefault, canManageSettings, onSetDefault, onToggleEnabled }) => (
    <View style={styles.switchRow}>
      <TouchableOpacity
        style={styles.flex1}
        onPress={() => canManageSettings && method.enabled && onSetDefault(method.id)}
        disabled={!canManageSettings || !method.enabled}
      >
        <View style={styles.inlineRow}>
          <CreditCard size={16} color={method.enabled ? ui.primary : ui.textMuted} />
          <Text style={styles.switchTitle}>{method.name}</Text>
          {isDefault ? (
            <View style={[styles.pillBadge, { backgroundColor: ui.primarySoft }]}>
              <Text style={[styles.pillBadgeText, { color: ui.primary }]}>Por defecto</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.switchSubtitle}>
          Categoría: {method.reportCategory.toUpperCase()}
          {method.terminalName ? ` · ${method.terminalName}` : ''}
        </Text>
      </TouchableOpacity>
      <Switch
        value={method.enabled !== false}
        onValueChange={(enabled) => onToggleEnabled(method.id, enabled)}
        disabled={!canManageSettings}
        trackColor={{ false: ui.border, true: ui.primary }}
      />
    </View>
  )
);

export interface PaymentsSettingsTabProps {
  accountId: string | null;
  canManageSettings: boolean;
  posSettings: PosSettings;
  allPaymentMethods: PosPaymentMethodConfig[];
  updatePosSettings: (patch: Partial<PosSettings>) => Promise<void>;
}

export const PaymentsSettingsTab = React.memo<PaymentsSettingsTabProps>(
  ({ accountId, canManageSettings, posSettings, allPaymentMethods, updatePosSettings }) => {
    const [yapeNumber, setYapeNumber] = useState('');
    const [yapeHolder, setYapeHolder] = useState('');
    const [allowMixedPayment, setAllowMixedPayment] = useState(true);
    const [paymentMethodsDraft, setPaymentMethodsDraft] = useState<PosPaymentMethodConfig[]>([]);
    const [defaultMethodId, setDefaultMethodId] = useState('efectivo');
    const [uploadingMethodId, setUploadingMethodId] = useState<string | null>(null);
    const [isSavingPayments, setIsSavingPayments] = useState(false);

    useEffect(() => {
      if (posSettings) {
        const yapeMethod = posSettings.methods?.find(
          (m) => m.id === 'yape' || m.provider === 'yape'
        );
        setYapeNumber(posSettings.digitalPhone || yapeMethod?.qrLabel || '');
        setYapeHolder(posSettings.digitalName || '');
        setAllowMixedPayment(posSettings.allowMixedPayment !== false);
        setDefaultMethodId(posSettings.defaultMethodId || 'efectivo');
      }
    }, [posSettings]);

    useEffect(() => {
      if (Array.isArray(posSettings?.methods) && posSettings.methods.length > 0) {
        setPaymentMethodsDraft(posSettings.methods);
      } else if (allPaymentMethods.length > 0) {
        setPaymentMethodsDraft(allPaymentMethods);
      }
    }, [posSettings?.methods, allPaymentMethods]);

    const updateDraftMethod = useCallback(
      (methodId: string, patch: Partial<PosPaymentMethodConfig>) => {
        setPaymentMethodsDraft((prev) =>
          prev.map((m) => (m.id === methodId ? { ...m, ...patch } : m))
        );
      },
      []
    );

    const handleUpdateQrUrl = useCallback(
      (methodId: string, qrUrl: string) => {
        updateDraftMethod(methodId, { qrUrl });
      },
      [updateDraftMethod]
    );

    const handleToggleMethodEnabled = useCallback(
      (methodId: string, enabled: boolean) => {
        updateDraftMethod(methodId, { enabled });
      },
      [updateDraftMethod]
    );

    const handleUploadMethodQr = useCallback(
      async (methodId: string) => {
        if (!canManageSettings || !accountId) return;
        try {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.85,
          });

          if (result.canceled || !result.assets || result.assets.length === 0) return;

          const asset = result.assets[0];
          setUploadingMethodId(methodId);

          const response = await fetch(asset.uri);
          const blob = await response.blob();
          const rawName = asset.fileName || asset.uri.split('/').pop() || 'qr.jpg';
          const ext =
            (rawName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') ||
            'jpg';
          const mime =
            asset.mimeType ||
            (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');

          // Dynamic import avoids loading firebase/storage until user actually uploads an image
          const {
            getStorage,
            ref: storageRef,
            uploadBytes,
            getDownloadURL,
          } = await import('firebase/storage');

          // `storage.rules` permite lectura pública y escritura autenticado bajo `products/{accountId}/{file}`
          const objectPath = `products/${accountId}/qr_${methodId}_${Date.now()}.${ext}`;
          const storage = getStorage(app);
          const fileRef = storageRef(storage, objectPath);
          await uploadBytes(fileRef, blob, { contentType: mime });
          const downloadUrl = await getDownloadURL(fileRef);

          const nextMethods = paymentMethodsDraft.map((m) =>
            m.id === methodId ? { ...m, qrUrl: downloadUrl } : m
          );
          setPaymentMethodsDraft(nextMethods);
          await updatePosSettings({ methods: nextMethods });

          Alert.alert(
            'QR Actualizado',
            'El código QR se subió correctamente y ya está activo en caja.'
          );
        } catch (err: any) {
          Alert.alert(
            'Error al Subir QR',
            err?.message ||
              'No se pudo subir la imagen del QR. También puedes pegar una URL directa.'
          );
        } finally {
          setUploadingMethodId(null);
        }
      },
      [accountId, canManageSettings, paymentMethodsDraft, updatePosSettings]
    );

    const handleTriggerUploadQr = useCallback(
      (methodId: string) => {
        void handleUploadMethodQr(methodId);
      },
      [handleUploadMethodQr]
    );

    const handleSavePayments = async () => {
      if (!canManageSettings) {
        Alert.alert('Acceso Denegado', 'Solo administradores pueden editar métodos de pago.');
        return;
      }

      setIsSavingPayments(true);
      try {
        const cleanNumber = yapeNumber.trim();
        const cleanHolder = yapeHolder.trim();

        const updatedMethods = paymentMethodsDraft.map((m) => {
          if (
            m.id === 'yape' ||
            m.id === 'plin' ||
            m.provider === 'yape' ||
            m.provider === 'plin'
          ) {
            return {
              ...m,
              qrLabel: cleanNumber || m.qrLabel || '',
            };
          }
          return m;
        });

        await updatePosSettings({
          digitalPhone: cleanNumber,
          digitalName: cleanHolder,
          allowMixedPayment,
          defaultMethodId,
          methods: updatedMethods,
        });

        Alert.alert(
          'Cobros Actualizados',
          'Los datos de Yape/Plin (número, titular, QR) y métodos de pago se guardaron correctamente.'
        );
      } catch (err: any) {
        Alert.alert(
          'Error al Guardar',
          err?.message || 'No se pudieron guardar los métodos de pago.'
        );
      } finally {
        setIsSavingPayments(false);
      }
    };

    const digitalMethods = useMemo(
      () => paymentMethodsDraft.filter((m) => m.kind === 'digital'),
      [paymentMethodsDraft]
    );

    const nonMixedMethods = useMemo(
      () => paymentMethodsDraft.filter((m) => m.kind !== 'mixed'),
      [paymentMethodsDraft]
    );

    return (
      <>
        <SectionHeading
          title="Cobros Digitales (Yape / Plin)"
          subtitle="Número, titular y código QR visibles al cobrar"
        />
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconBadge, { backgroundColor: ui.accentSoft }]}>
              <QrCode size={22} color={ui.accent} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Yape / Plin en Caja</Text>
              <Text style={styles.cardSubtitle}>
                Los datos del titular se guardan en digitalName sin alterar terminales
              </Text>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Número de Celular Yape / Plin</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="987654321"
              placeholderTextColor={ui.textMuted}
              keyboardType="phone-pad"
              value={yapeNumber}
              onChangeText={setYapeNumber}
              editable={canManageSettings}
              accessibilityLabel="Número de celular Yape o Plin"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Titular de la Cuenta Digital</Text>
            <TextInput
              style={[styles.textInput, !canManageSettings && styles.inputReadOnly]}
              placeholder="Ej. Comercial Los Andes S.A.C."
              placeholderTextColor={ui.textMuted}
              value={yapeHolder}
              onChangeText={setYapeHolder}
              editable={canManageSettings}
              accessibilityLabel="Titular de la cuenta digital"
            />
          </View>

          {digitalMethods.map((m) => (
            <QrMethodCard
              key={m.id}
              method={m}
              canManageSettings={canManageSettings}
              isUploading={uploadingMethodId === m.id}
              onUploadQr={handleTriggerUploadQr}
              onUpdateQrUrl={handleUpdateQrUrl}
            />
          ))}
        </View>

        <SectionHeading title="Métodos de Pago" subtitle="Activa los medios aceptados en caja" />
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={styles.flex1}>
              <Text style={styles.switchTitle}>Permitir Pagos Mixtos</Text>
              <Text style={styles.switchSubtitle}>
                Dividir cobro entre efectivo, Yape, Plin o tarjeta
              </Text>
            </View>
            <Switch
              value={allowMixedPayment}
              onValueChange={setAllowMixedPayment}
              disabled={!canManageSettings}
              trackColor={{ false: ui.border, true: ui.primary }}
            />
          </View>

          {nonMixedMethods.map((m) => (
            <PaymentMethodRow
              key={m.id}
              method={m}
              isDefault={defaultMethodId === m.id}
              canManageSettings={canManageSettings}
              onSetDefault={setDefaultMethodId}
              onToggleEnabled={handleToggleMethodEnabled}
            />
          ))}

          {canManageSettings ? (
            <TouchableOpacity
              style={[styles.saveButton, isSavingPayments && styles.buttonDisabled]}
              onPress={handleSavePayments}
              disabled={isSavingPayments}
            >
              {isSavingPayments ? (
                <ActivityIndicator color={ui.onPrimary} />
              ) : (
                <>
                  <Save size={18} color={ui.onPrimary} />
                  <Text style={styles.saveButtonText}>Guardar Métodos y QR</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </>
    );
  }
);
