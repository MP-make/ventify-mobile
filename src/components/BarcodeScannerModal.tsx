import React, { useState, useRef, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CameraView,
  useCameraPermissions,
  BarcodeScanningResult,
} from 'expo-camera';
import {
  X,
  Zap,
  ZapOff,
  Keyboard,
  Camera,
  Check,
  AlertCircle,
  Repeat,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ui } from '@/lib/theme';

export interface BarcodeScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScan: (code: string) => void;
  title?: string;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  visible,
  onClose,
  onScan,
  title = 'Escanear Código de Barras',
}) => {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  const [torch, setTorch] = useState<boolean>(false);
  const [continuousMode, setContinuousMode] = useState<boolean>(true);
  const [manualInputVisible, setManualInputVisible] = useState<boolean>(false);
  const [manualCode, setManualCode] = useState<string>('');
  const [lastScannedFeedback, setLastScannedFeedback] = useState<string | null>(null);

  const lastScannedCode = useRef<string>('');
  const lastScannedTime = useRef<number>(0);
  const isCooldownActive = useRef<boolean>(false);

  // Manejo de lectura de código por la cámara nativa
  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      const { data } = result;
      if (!data) return;

      const trimmed = data.trim();
      const now = Date.now();

      // Enfriamiento anti-rebote de 1.2s para evitar lecturas duplicadas inmediatas
      if (
        isCooldownActive.current ||
        (trimmed === lastScannedCode.current && now - lastScannedTime.current < 1200)
      ) {
        return;
      }

      lastScannedCode.current = trimmed;
      lastScannedTime.current = now;
      isCooldownActive.current = true;

      // Feedback háptico
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      // Notificación flotante de confirmación de lectura
      setLastScannedFeedback(`Código detectado: ${trimmed}`);
      setTimeout(() => {
        setLastScannedFeedback(null);
      }, 1500);

      // Emitir resultado al callback
      onScan(trimmed);

      // Si no es modo continuo, cerrar de inmediato
      if (!continuousMode) {
        setTimeout(() => {
          isCooldownActive.current = false;
          onClose();
        }, 200);
      } else {
        setTimeout(() => {
          isCooldownActive.current = false;
        }, 800);
      }
    },
    [continuousMode, onScan, onClose]
  );

  // Confirmar código manual
  const handleManualSubmit = () => {
    const clean = manualCode.trim();
    if (!clean) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onScan(clean);
    setManualCode('');
    setManualInputVisible(false);

    if (!continuousMode) {
      onClose();
    }
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Vista de Cámara o Solicitud de Permisos */}
        {!permission ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.permissionText}>Comprobando permisos de cámara...</Text>
          </View>
        ) : !permission.granted ? (
          <View style={styles.centerContainer}>
            <View style={styles.permissionIconBadge}>
              <Camera size={36} color={ui.primary} />
            </View>
            <Text style={styles.permissionTitle}>Permiso de Cámara Requerido</Text>
            <Text style={styles.permissionText}>
              Ventify necesita acceso a la cámara de tu dispositivo para leer códigos de barra y QR instantáneamente.
            </Text>
            <TouchableOpacity
              onPress={requestPermission}
              style={styles.permissionButton}
              activeOpacity={0.8}
            >
              <Text style={styles.permissionButtonText}>Conceder Acceso</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            enableTorch={torch}
            barcodeScannerSettings={{
              barcodeTypes: [
                'ean13',
                'ean8',
                'code128',
                'code39',
                'upc_a',
                'upc_e',
                'qr',
              ],
            }}
            onBarcodeScanned={handleBarcodeScanned}
          />
        )}

        {/* Overlay con Recuadro de Enfoque */}
        {permission?.granted && (
          <View style={styles.overlay} pointerEvents="box-none">
            {/* Barra Superior */}
            <View
              style={[
                styles.topBar,
                { paddingTop: Math.max(insets.top, Platform.OS === 'ios' ? 44 : 20) + 8 },
              ]}
            >
              {/* Botón Cerrar */}
              <TouchableOpacity
                onPress={onClose}
                style={styles.iconButton}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Cerrar escáner"
              >
                <X size={20} color={ui.onPrimary} />
              </TouchableOpacity>

              {/* Título Central */}
              <View style={styles.titleContainer}>
                <Text style={styles.titleText}>{title}</Text>
                <Text style={styles.modeText}>
                  {continuousMode ? 'Modo Continuo' : 'Escaneo Único'}
                </Text>
              </View>

              {/* Botón Linterna */}
              <TouchableOpacity
                onPress={() => setTorch((prev) => !prev)}
                style={[styles.iconButton, torch && styles.iconButtonActive]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={torch ? 'Apagar linterna' : 'Encender linterna'}
                accessibilityState={{ selected: torch }}
              >
                {torch ? (
                  <Zap size={20} color="#F59E0B" fill="#F59E0B" />
                ) : (
                  <ZapOff size={20} color={ui.onPrimary} />
                )}
              </TouchableOpacity>
            </View>

            {/* Recuadro Central de Enfoque */}
            <View style={styles.reticleContainer}>
              <View style={styles.reticleBox}>
                {/* Esquinas Verdes Esmeralda */}
                <View style={[styles.corner, styles.cornerTL]} />
                <View style={[styles.corner, styles.cornerTR]} />
                <View style={[styles.corner, styles.cornerBL]} />
                <View style={[styles.corner, styles.cornerBR]} />

                {/* Línea Central Láser */}
                <View style={styles.laserLine} />
              </View>

              {/* Feedback de Escaneo Exitoso */}
              {lastScannedFeedback ? (
                <View style={styles.feedbackBadge}>
                  <Check size={14} color={ui.primary} />
                  <Text style={styles.feedbackText}>{lastScannedFeedback}</Text>
                </View>
              ) : (
                <Text style={styles.reticleHint}>
                  Centra el código de barras dentro del marco
                </Text>
              )}
            </View>

            {/* Barra Inferior de Controles */}
            <View
              style={[
                styles.bottomBar,
                { paddingBottom: Math.max(insets.bottom, 24) },
              ]}
            >
              {/* Alternar Modo Continuo */}
              <TouchableOpacity
                onPress={() => setContinuousMode((prev) => !prev)}
                style={[
                  styles.bottomButton,
                  continuousMode && styles.bottomButtonActive,
                ]}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={continuousMode ? 'Cambiar a escaneo único' : 'Activar escaneo continuo'}
                accessibilityState={{ selected: continuousMode }}
              >
                <Repeat size={18} color={continuousMode ? ui.primary : ui.textMuted} />
                <Text
                  style={[
                    styles.bottomButtonText,
                    continuousMode && styles.bottomButtonTextActive,
                  ]}
                >
                  {continuousMode ? 'Continuo: ON' : 'Único: ON'}
                </Text>
              </TouchableOpacity>

              {/* Botón Entrada Manual */}
              <TouchableOpacity
                onPress={() => setManualInputVisible(true)}
                style={styles.bottomButton}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Ingresar código manualmente"
              >
                <Keyboard size={18} color={ui.textMuted} />
                <Text style={styles.bottomButtonText}>Entrada Manual</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Modal de Entrada Manual de Código */}
        <Modal
          visible={manualInputVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setManualInputVisible(false)}
        >
          <KeyboardAvoidingView
            style={styles.manualOverlay}
                  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={styles.manualCard}>
              <View style={styles.manualHeader}>
                <Text style={styles.manualTitle}>Ingresar Código Manual</Text>
                <TouchableOpacity
                  onPress={() => setManualInputVisible(false)}
                  style={styles.manualClose}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar ingreso manual"
                >
                  <X size={18} color={ui.textMuted} />
                </TouchableOpacity>
              </View>

              <Text style={styles.manualSubtitle}>
                Escribe el código de barras o SKU del producto
              </Text>

              <TextInput
                accessibilityLabel="Código de barras o SKU"
                value={manualCode}
                onChangeText={setManualCode}
                placeholder="Ej. 7751234567891 o SKU-001"
                placeholderTextColor="#6B7280"
                style={styles.manualInput}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleManualSubmit}
              />

              <View style={styles.manualActions}>
                <TouchableOpacity
                  onPress={() => setManualInputVisible(false)}
                  style={styles.manualCancelButton}
                  accessibilityRole="button"
                >
                  <Text style={styles.manualCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleManualSubmit}
                  style={styles.manualSubmitButton}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Buscar y agregar código"
                >
                  <Text style={styles.manualSubmitText}>Buscar y Agregar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  centerContainer: { flex: 1, backgroundColor: ui.background, alignItems: 'center', justifyContent: 'center', padding: 24 },
  permissionIconBadge: { width: 72, height: 72, borderRadius: 20, backgroundColor: ui.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  permissionTitle: { fontSize: 20, fontWeight: '700', color: ui.text, marginBottom: 8, textAlign: 'center' },
  permissionText: { fontSize: 15, color: ui.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 24, maxWidth: 320 },
  permissionButton: { minHeight: 52, justifyContent: 'center', backgroundColor: ui.primary, paddingHorizontal: 24, borderRadius: 12 },
  permissionButtonText: { color: ui.onPrimary, fontWeight: '700', fontSize: 15, textAlign: 'center' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 16, backgroundColor: 'rgba(0, 0, 0, 0.65)' },
  iconButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255, 255, 255, 0.15)', alignItems: 'center', justifyContent: 'center' },
  iconButtonActive: { backgroundColor: 'rgba(245, 158, 11, 0.3)', borderWidth: 1, borderColor: ui.warning },
  titleContainer: { alignItems: 'center', flex: 1, marginHorizontal: 8 },
  titleText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  modeText: { fontSize: 13, color: ui.primary, fontWeight: '600', marginTop: 2 },
  reticleContainer: { alignItems: 'center', justifyContent: 'center' },
  reticleBox: { width: 280, height: 180, borderRadius: 16, position: 'relative', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 0, 0, 0.1)' },
  corner: { position: 'absolute', width: 24, height: 24, borderColor: ui.primary },
  cornerTL: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 },
  cornerTR: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 },
  cornerBL: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 },
  cornerBR: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 },
  laserLine: { position: 'absolute', left: 12, right: 12, height: 2, backgroundColor: ui.primary, opacity: 0.9 },
  reticleHint: { marginTop: 18, color: 'rgba(255, 255, 255, 0.85)', fontSize: 14, fontWeight: '500', textAlign: 'center' },
  feedbackBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ui.success, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, marginTop: 16 },
  feedbackText: { color: ui.onPrimary, fontSize: 13, fontWeight: '700' },
  bottomBar: { flexDirection: 'row', justifyContent: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 16, backgroundColor: 'rgba(0, 0, 0, 0.65)' },
  bottomButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255, 255, 255, 0.12)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: 'transparent' },
  bottomButtonActive: { backgroundColor: 'rgba(49, 91, 232, 0.3)', borderColor: ui.primary },
  bottomButtonText: { color: '#E5E7EB', fontSize: 14, fontWeight: '600' },
  bottomButtonTextActive: { color: '#FFFFFF', fontWeight: '700' },
  manualOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  manualCard: { width: '100%', maxWidth: 360, backgroundColor: ui.surface, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: ui.border },
  manualHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  manualTitle: { fontSize: 18, fontWeight: '700', color: ui.text },
  manualClose: { width: 48, height: 48, borderRadius: 12, backgroundColor: ui.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  manualSubtitle: { fontSize: 14, color: ui.textSecondary, marginTop: 4, marginBottom: 16, lineHeight: 20 },
  manualInput: { backgroundColor: ui.surface, borderWidth: 1, borderColor: ui.border, borderRadius: 12, paddingHorizontal: 14, minHeight: 52, fontSize: 16, color: ui.text, marginBottom: 16 },
  manualActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  manualCancelButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, backgroundColor: ui.surfaceMuted },
  manualCancelText: { color: ui.textSecondary, fontSize: 14, fontWeight: '600' },
  manualSubmitButton: { minHeight: 48, justifyContent: 'center', backgroundColor: ui.primary, paddingHorizontal: 18, borderRadius: 10 },
  manualSubmitText: { color: ui.onPrimary, fontSize: 14, fontWeight: '700' },
});
