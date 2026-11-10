/**
 * Ventify Mobile - Companion Scanner Modal (Escáner Remoto Vinculado a PC)
 * 
 * Componente modal nativo a pantalla completa que transforma el smartphone
 * en una pistola lectora láser de código de barras inalámbrica conectada en
 * tiempo real con Ventify Web POS en la PC del mostrador.
 * 
 * - Estado 1: Modo Vinculación (Escaneo de QR o ingreso manual del enlace).
 * - Estado 2: Modo Pistola Lectora Inalámbrica con mira láser animada,
 *   indicador verde pulsante "VINCULADO A PC MOSTRADOR", búsqueda local O(1)
 *   en useProducts(), transmisión instantánea en <50ms y registro histórico.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  ScrollView,
  Animated,
  Easing,
  Alert,
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
  Monitor,
  Laptop,
  Smartphone,
  Unplug,
  CheckCircle2,
  Trash2,
  Scan,
  Radio,
  Target,
  RefreshCw,
  ExternalLink,
} from 'lucide-react-native';

import { useProducts } from '@/context/ProductsContext';
import { formatPEN, ui } from '@/lib/theme';
import {
  connectScannerSession,
  sendScannedCodeToDesktop,
  subscribeToScannerSession,
  disconnectScannerSession,
  triggerScanHaptic,
  formatSessionPurpose,
  generateScanId,
  type CompanionSessionData,
  type ScannedCodeHistoryItem,
  type ProductPreview,
  SCAN_DEBOUNCE_COOLDOWN_MS,
} from '@/services/companion-scanner-service';

// ============================================================================
// PROPS DEL COMPONENTE
// ============================================================================

export interface CompanionScannerModalProps {
  visible: boolean;
  onClose: () => void;
  initialSessionId?: string;
  onSessionConnected?: (session: CompanionSessionData) => void;
}

export const CompanionScannerModal: React.FC<CompanionScannerModalProps> = ({
  visible,
  onClose,
  initialSessionId,
  onSessionConnected,
}) => {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const { findByBarcode } = useProducts();

  // Estados de vinculación y sesión
  const [session, setSession] = useState<CompanionSessionData | null>(null);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [manualSessionInput, setManualSessionInput] = useState<string>('');
  const [manualInputModalVisible, setManualInputModalVisible] = useState<boolean>(false);

  // Estados de la cámara y controles del escáner
  const [torch, setTorch] = useState<boolean>(false);
  const [continuousMode, setContinuousMode] = useState<boolean>(true);
  const [isArmed, setIsArmed] = useState<boolean>(true);
  const [manualBarcodeText, setManualBarcodeText] = useState<string>('');
  const [manualBarcodeModalVisible, setManualBarcodeModalVisible] = useState<boolean>(false);

  // Historial de lecturas enviadas a la PC
  const [scannedHistory, setScannedHistory] = useState<ScannedCodeHistoryItem[]>([]);
  const [lastDetectedBanner, setLastDetectedBanner] = useState<{
    name: string;
    price?: number;
    code: string;
  } | null>(null);

  // Referencias para control de anti-rebote de escaneo
  const lastScannedCodeRef = useRef<string>('');
  const lastScannedTimeRef = useRef<number>(0);
  const isScanBusyRef = useRef<boolean>(false);

  // ============================================================================
  // ANIMACIONES: LÁSER Y PULSO DE VINCULACIÓN
  // ============================================================================

  const laserAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const bannerOpacityAnim = useRef(new Animated.Value(0)).current;
  const bannerTranslateAnim = useRef(new Animated.Value(-15)).current;

  // Animación del láser escaneador (sube y baja continuamente)
  useEffect(() => {
    if (!visible) return;

    const laserLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(laserAnim, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(laserAnim, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    laserLoop.start();
    return () => laserLoop.stop();
  }, [visible, laserAnim]);

  // Animación de pulso verde para el indicador "VINCULADO A PC MOSTRADOR"
  useEffect(() => {
    if (!visible || !session) return;

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.4,
          duration: 800,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 800,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    pulseLoop.start();
    return () => pulseLoop.stop();
  }, [visible, session, pulseAnim]);

  // Efecto visual para mostrar el HUD del producto recién detectado
  const showDetectedBanner = useCallback(() => {
    bannerOpacityAnim.setValue(0);
    bannerTranslateAnim.setValue(-15);

    Animated.parallel([
      Animated.timing(bannerOpacityAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(bannerTranslateAnim, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.back(1.5)),
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-ocultar después de 2.2 segundos
    setTimeout(() => {
      Animated.timing(bannerOpacityAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setLastDetectedBanner(null);
      });
    }, 2200);
  }, [bannerOpacityAnim, bannerTranslateAnim]);

  // ============================================================================
  // GESTIÓN DE SESIÓN Y SUSCRIPCIÓN EN TIEMPO REAL
  // ============================================================================

  // Conexión automática si se pasa initialSessionId
  useEffect(() => {
    if (visible && initialSessionId && !session && !isConnecting) {
      void handleConnect(initialSessionId);
    }
  }, [visible, initialSessionId]);

  // Suscripción a Firestore onSnapshot mientras la sesión esté activa
  useEffect(() => {
    if (!session?.sessionId || !visible) return;

    const unsubscribe = subscribeToScannerSession(
      session.sessionId,
      (updatedSession) => {
        if (updatedSession.revoked) {
          Alert.alert(
            'Vínculo Finalizado',
            'La computadora ha cerrado o revocado la vinculación del escáner.',
            [{ text: 'Entendido', onPress: () => setSession(null) }]
          );
          return;
        }

        // Actualizar datos de sesión si cambió el propósito o la respuesta de la PC
        setSession((prev) => (prev ? { ...prev, ...updatedSession } : updatedSession));

        // Actualizar estado del historial cuando la PC procesa la lectura
        const lastScan = updatedSession.scan;
        if (lastScan && lastScan.result !== 'pending') {
          setScannedHistory((prev) =>
            prev.map((item) =>
              item.code === lastScan.code
                ? {
                    ...item,
                    status: lastScan.result === 'rejected' ? 'rejected' : 'added',
                    message: lastScan.message || item.message,
                  }
                : item
            )
          );
        }
      },
      (error) => {
        console.warn('[CompanionModal] Error en la conexión reactiva:', error);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [session?.sessionId, visible]);

  // ============================================================================
  // HANDLERS DE ACCIONES DE VINCULACIÓN
  // ============================================================================

  const handleConnect = async (rawCodeOrUrl: string) => {
    if (!rawCodeOrUrl.trim()) return;

    setIsConnecting(true);
    setConnectionError(null);
    void triggerScanHaptic('light');

    try {
      const activeSession = await connectScannerSession(rawCodeOrUrl);
      setSession(activeSession);
      void triggerScanHaptic('success');
      setManualInputModalVisible(false);
      setManualSessionInput('');
      if (onSessionConnected) onSessionConnected(activeSession);
    } catch (err: any) {
      const msg = err?.message || 'No se pudo conectar con la computadora. Revisa el código QR e intenta de nuevo.';
      setConnectionError(msg);
      void triggerScanHaptic('error');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!session) return;

    Alert.alert(
      'Desvincular Escáner',
      '¿Deseas cerrar la vinculación con la PC? El celular dejará de transmitir lecturas al mostrador.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Desvincular',
          style: 'destructive',
          onPress: async () => {
            void triggerScanHaptic('warning');
            try {
              await disconnectScannerSession(session.sessionId);
            } catch {}
            setSession(null);
            setScannedHistory([]);
            setLastDetectedBanner(null);
          },
        },
      ]
    );
  };

  // ============================================================================
  // HANDLERS DE ESCANEO DE CÓDIGO DE BARRAS
  // ============================================================================

  const handleBarcodeScanned = useCallback(
    async (result: BarcodeScanningResult) => {
      const { data } = result;
      if (!data) return;

      const trimmedCode = data.trim();
      if (!trimmedCode) return;

      // ESTADO 1: Si aún no está vinculado, este escáner busca el código QR de la PC
      if (!session) {
        if (isConnecting) return;
        void handleConnect(trimmedCode);
        return;
      }

      // ESTADO 2: Pistola inalámbrica vinculada a PC
      const now = Date.now();

      // En modo disparo manual, verificar que esté armado
      if (!continuousMode && !isArmed) {
        return;
      }

      // Enfriamiento anti-rebote de 1.2s para evitar lecturas duplicadas continuas
      if (
        isScanBusyRef.current ||
        (trimmedCode === lastScannedCodeRef.current &&
          now - lastScannedTimeRef.current < SCAN_DEBOUNCE_COOLDOWN_MS)
      ) {
        return;
      }

      lastScannedCodeRef.current = trimmedCode;
      lastScannedTimeRef.current = now;
      isScanBusyRef.current = true;

      // Si no es modo continuo, desarmar hasta la siguiente pulsación
      if (!continuousMode) {
        setIsArmed(false);
      }

      // 1. Búsqueda local ultrarrápida O(1) en el catálogo de useProducts()
      const match = findByBarcode(trimmedCode);
      const matchedProduct = match?.product;
      const matchedPresentation = match?.matchedPresentation;
      const matchedVariant = match?.matchedVariant;

      const productName = matchedProduct
        ? `${matchedProduct.name}${matchedPresentation ? ` (${matchedPresentation.name})` : ''}${
            matchedVariant ? ` [${matchedVariant.name}]` : ''
          }`
        : `Código: ${trimmedCode}`;

      const productPrice =
        matchedPresentation?.price ?? matchedProduct?.suggestedPrice ?? matchedProduct?.price;

      const preview: ProductPreview = {
        id: matchedProduct?.id,
        name: productName,
        price: productPrice,
        sku: matchedProduct?.sku,
        barcode: trimmedCode,
        imageUrl: matchedProduct?.imageUrl || matchedProduct?.thumbUrl,
      };

      // 2. Feedback háptico instantáneo al detectar código
      void triggerScanHaptic('success');

      // 3. Notificación HUD en pantalla con nombre y precio
      setLastDetectedBanner({
        name: productName,
        price: productPrice,
        code: trimmedCode,
      });
      showDetectedBanner();

      // 4. Registro optimista en el historial de lecturas enviadas
      const newHistoryItem: ScannedCodeHistoryItem = {
        id: generateScanId(),
        code: trimmedCode,
        timestamp: now,
        status: 'sent',
        productName,
        productPrice,
        message: matchedProduct ? 'Transmitido a PC' : 'Código no catalogado (enviado)',
      };

      setScannedHistory((prev) => [newHistoryItem, ...prev]);

      // 5. Transmisión en milisegundos a la PC
      try {
        await sendScannedCodeToDesktop(
          session.sessionId,
          trimmedCode,
          session.token,
          preview
        );
      } catch (err) {
        console.warn('[CompanionModal] Advertencia al transmitir lectura a PC:', err);
      } finally {
        setTimeout(() => {
          isScanBusyRef.current = false;
        }, 500);
      }
    },
    [session, isConnecting, continuousMode, isArmed, findByBarcode, showDetectedBanner]
  );

  // Envío de código escrito manualmente a la PC
  const handleManualBarcodeSubmit = async () => {
    const code = manualBarcodeText.trim();
    if (!code || !session) return;

    void triggerScanHaptic('light');

    const now = Date.now();
    const match = findByBarcode(code);
    const prod = match?.product;
    const pres = match?.matchedPresentation;
    const vari = match?.matchedVariant;

    const prodName = prod
      ? `${prod.name}${pres ? ` (${pres.name})` : ''}${vari ? ` [${vari.name}]` : ''}`
      : `Código manual: ${code}`;
    const prodPrice = pres?.price ?? prod?.suggestedPrice ?? prod?.price;

    const preview: ProductPreview = {
      id: prod?.id,
      name: prodName,
      price: prodPrice,
      sku: prod?.sku,
      barcode: code,
    };

    setLastDetectedBanner({
      name: prodName,
      price: prodPrice,
      code,
    });
    showDetectedBanner();

    const historyItem: ScannedCodeHistoryItem = {
      id: generateScanId(),
      code,
      timestamp: now,
      status: 'sent',
      productName: prodName,
      productPrice: prodPrice,
      message: 'Ingreso manual transmitido',
    };

    setScannedHistory((prev) => [historyItem, ...prev]);
    setManualBarcodeText('');
    setManualBarcodeModalVisible(false);

    try {
      await sendScannedCodeToDesktop(session.sessionId, code, session.token, preview);
      void triggerScanHaptic('success');
    } catch (err) {
      console.warn('[CompanionModal] Error al enviar código manual:', err);
    }
  };

  const handleClearHistory = () => {
    Alert.alert('Limpiar Historial', '¿Deseas reiniciar la lista de lecturas de esta sesión?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Limpiar',
        style: 'destructive',
        onPress: () => {
          setScannedHistory([]);
          void triggerScanHaptic('light');
        },
      },
    ]);
  };

  if (!visible) return null;

  // ============================================================================
  // RENDER: PANTALLA COMPLETA
  // ============================================================================

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* ================================================================= */}
        {/* COMPROBACIÓN DE PERMISOS DE CÁMARA */}
        {/* ================================================================= */}
        {!permission ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={ui.primary} />
            <Text style={styles.loadingText}>Iniciando cámara de alta velocidad...</Text>
          </View>
        ) : !permission.granted ? (
          <View style={styles.centerContainer}>
            <View style={styles.permissionBadge}>
              <Camera size={40} color={ui.primary} />
            </View>
            <Text style={styles.permissionTitle}>Permiso de Cámara Requerido</Text>
            <Text style={styles.permissionText}>
              Para transformar este teléfono en una pistola lectora láser y escanear códigos de barra
              al mostrador, Ventify necesita acceso a la cámara.
            </Text>
            <TouchableOpacity
              onPress={requestPermission}
              style={styles.primaryActionButton}
              activeOpacity={0.8}
            >
              <Text style={styles.primaryActionButtonText}>Conceder Acceso</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={styles.secondaryTextButton}>
              <Text style={styles.secondaryTextButtonLabel}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* ================================================================= */
          /* VISTA PRINCIPAL DE CÁMARA NATIVA (EXPO-CAMERA) */
          /* ================================================================= */
          <View style={StyleSheet.absoluteFillObject}>
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

            {/* =============================================================== */}
            {/* OVERLAY NATIVO ESMERALDA: ESTADO 1 vs ESTADO 2 */}
            {/* =============================================================== */}
            <View style={styles.overlayContainer} pointerEvents="box-none">
              {/* BARRA SUPERIOR DE ENCABEZADO */}
              <View
                style={[
                  styles.headerBar,
                  { paddingTop: Math.max(insets.top, Platform.OS === 'ios' ? 44 : 24) + 6 },
                ]}
              >
                {/* Botón Cerrar */}
                <TouchableOpacity
                  onPress={onClose}
                  style={styles.headerIconButton}
                  activeOpacity={0.7}
                  accessibilityLabel="Cerrar modal"
                >
                  <X size={20} color="#F9FAFB" />
                </TouchableOpacity>

                {/* Título Central / Indicador de Vinculación */}
                {session ? (
                  <View style={styles.headerSessionInfo}>
                    {/* Indicador Verde Pulsante */}
                    <View style={styles.pulseContainer}>
                      <Animated.View
                        style={[
                          styles.pulseRing,
                          {
                            transform: [{ scale: pulseAnim }],
                            opacity: pulseAnim.interpolate({
                              inputRange: [1, 1.4],
                              outputRange: [0.8, 0],
                            }),
                          },
                        ]}
                      />
                      <View style={styles.pulseDot} />
                    </View>

                    <View style={styles.headerTitleColumn}>
                      <Text style={styles.connectedTitleText}>VINCULADO A PC MOSTRADOR</Text>
                      <View style={styles.purposePill}>
                        <Monitor size={10} color={ui.success} />
                        <Text style={styles.purposePillText}>
                          {formatSessionPurpose(session.purpose)}
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : (
                  <View style={styles.headerTitleColumn}>
                    <Text style={styles.headerMainTitle}>Vincular Escáner a PC</Text>
                    <Text style={styles.headerSubTitle}>Lector Inalámbrico Ventify</Text>
                  </View>
                )}

                {/* Acciones Derecha: Linterna y Desvincular */}
                <View style={styles.headerActionsRight}>
                  <TouchableOpacity
                    onPress={() => setTorch((prev) => !prev)}
                    style={[styles.headerIconButton, torch && styles.headerIconButtonActive]}
                    activeOpacity={0.7}
                    accessibilityLabel="Alternar linterna"
                  >
                    {torch ? (
                      <Zap size={19} color="#F59E0B" fill="#F59E0B" />
                    ) : (
                      <ZapOff size={19} color="#F9FAFB" />
                    )}
                  </TouchableOpacity>

                  {session && (
                    <TouchableOpacity
                      onPress={handleDisconnect}
                      style={[styles.headerIconButton, styles.disconnectButton]}
                      activeOpacity={0.7}
                      accessibilityLabel="Desvincular celular"
                    >
                      <Unplug size={18} color="#EF4444" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* ============================================================= */}
              {/* MIRA LÁSER ANIMADA Y ÁREA DE ENFOQUE */}
              {/* ============================================================= */}
              <View style={styles.reticleSection} pointerEvents="box-none">
                {/* HUD Banner Flotante al detectar producto */}
                {lastDetectedBanner && (
                  <Animated.View
                    style={[
                      styles.hudBannerCard,
                      {
                        opacity: bannerOpacityAnim,
                        transform: [{ translateY: bannerTranslateAnim }],
                      },
                    ]}
                  >
                    <View style={styles.hudBadgeIcon}>
                      <CheckCircle2 size={18} color={ui.success} />
                    </View>
                    <View style={styles.hudContent}>
                      <Text style={styles.hudProductName} numberOfLines={1}>
                        {lastDetectedBanner.name}
                      </Text>
                      <View style={styles.hudMetaRow}>
                        {lastDetectedBanner.price !== undefined && (
                          <Text style={styles.hudProductPrice}>
                            {formatPEN(lastDetectedBanner.price)}
                          </Text>
                        )}
                        <Text style={styles.hudCodeText}>{lastDetectedBanner.code}</Text>
                        <View style={styles.hudSentPill}>
                          <Text style={styles.hudSentPillText}>ENVIADO A PC ✓</Text>
                        </View>
                      </View>
                    </View>
                  </Animated.View>
                )}

                {/* Recuadro de la Mira */}
                <View
                  style={[
                    styles.reticleFrame,
                    !session && styles.reticleFrameQr, // Más cuadrado para QR en estado 1
                  ]}
                >
                  {/* Esquinas Esmeralda */}
                  <View style={[styles.reticleCorner, styles.cornerTL]} />
                  <View style={[styles.reticleCorner, styles.cornerTR]} />
                  <View style={[styles.reticleCorner, styles.cornerBL]} />
                  <View style={[styles.reticleCorner, styles.cornerBR]} />

                  {/* Mira Central de Cruz Suave */}
                  <View style={styles.reticleCrosshair} />

                  {/* Haz de Luz Láser Verde Animado */}
                  <Animated.View
                    style={[
                      styles.animatedLaserBeam,
                      {
                        transform: [
                          {
                            translateY: laserAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [10, session ? 150 : 210],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                </View>

                {/* Instrucción bajo la mira */}
                <Text style={styles.reticleInstruction}>
                  {session
                    ? continuousMode
                      ? 'Apunta al código de barras del producto (Modo Ráfaga)'
                      : isArmed
                      ? 'Lector listo. Centra el código de barras'
                      : 'Presiona "Disparar Escáner" para la siguiente lectura'
                    : 'Apunta al código QR en la pantalla de la PC'}
                </Text>

                {/* Banner de error de conexión en estado 1 */}
                {connectionError && !session && (
                  <View style={styles.errorAlertBanner}>
                    <AlertCircle size={16} color="#EF4444" />
                    <Text style={styles.errorAlertText}>{connectionError}</Text>
                  </View>
                )}

                {/* Spinner de conexión en proceso */}
                {isConnecting && (
                  <View style={styles.connectingToast}>
                    <ActivityIndicator size="small" color={ui.primary} />
                    <Text style={styles.connectingToastText}>Conectando con Ventify Web...</Text>
                  </View>
                )}
              </View>

              {/* ============================================================= */}
              {/* BARRA INFERIOR / MODO DE DISPARO Y CONTROLES */}
              {/* ============================================================= */}
              <View
                style={[
                  styles.bottomSheet,
                  { paddingBottom: Math.max(insets.bottom, 16) + 4 },
                ]}
              >
                {/* ESTADO 1: SIN VINCULAR */}
                {!session ? (
                  <View style={styles.unlinkedControls}>
                    <Text style={styles.unlinkedHelperText}>
                      En Ventify Web en tu computadora, haz clic en{' '}
                      <Text style={styles.boldWhite}>"Vincular celular"</Text> dentro de Ventas o
                      Productos y apunta aquí.
                    </Text>

                    <TouchableOpacity
                      onPress={() => setManualInputModalVisible(true)}
                      style={styles.manualEntryButton}
                      activeOpacity={0.8}
                    >
                      <Keyboard size={18} color={ui.primary} />
                      <Text style={styles.manualEntryButtonText}>
                        Pegar enlace o código manualmente
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  /* ESTADO 2: VINCULADO (PISTOLA LECTORA INALÁMBRICA) */
                  <View style={styles.linkedControlsContainer}>
                    {/* Fila de Selector de Modo (Ráfaga vs Disparo Manual) */}
                    <View style={styles.modeToggleRow}>
                      <TouchableOpacity
                        onPress={() => {
                          setContinuousMode(true);
                          setIsArmed(true);
                          void triggerScanHaptic('light');
                        }}
                        style={[
                          styles.modeToggleButton,
                          continuousMode && styles.modeToggleButtonActive,
                        ]}
                        activeOpacity={0.8}
                      >
                        <Repeat size={16} color={continuousMode ? ui.primary : ui.textMuted} />
                        <Text
                          style={[
                            styles.modeToggleText,
                            continuousMode && styles.modeToggleTextActive,
                          ]}
                        >
                          Ráfaga Continua
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => {
                          setContinuousMode(false);
                          setIsArmed(true);
                          void triggerScanHaptic('light');
                        }}
                        style={[
                          styles.modeToggleButton,
                          !continuousMode && styles.modeToggleButtonActive,
                        ]}
                        activeOpacity={0.8}
                      >
                        <Target size={16} color={!continuousMode ? ui.primary : ui.textMuted} />
                        <Text
                          style={[
                            styles.modeToggleText,
                            !continuousMode && styles.modeToggleTextActive,
                          ]}
                        >
                          Disparo Manual
                        </Text>
                      </TouchableOpacity>

                      {/* Botón de Entrada Manual de Código de Barras */}
                      <TouchableOpacity
                        onPress={() => setManualBarcodeModalVisible(true)}
                        style={styles.keyboardIconBtn}
                        activeOpacity={0.8}
                        accessibilityLabel="Escribir código de barras manualmente"
                      >
                        <Keyboard size={18} color={ui.textMuted} />
                      </TouchableOpacity>
                    </View>

                    {/* Botón Gatillo de Disparo (si está en modo manual) */}
                    {!continuousMode && (
                      <TouchableOpacity
                        onPress={() => {
                          setIsArmed(true);
                          void triggerScanHaptic('light');
                        }}
                        style={[
                          styles.triggerGunButton,
                          isArmed && styles.triggerGunButtonArmed,
                        ]}
                        activeOpacity={0.7}
                      >
                        <Scan size={22} color={isArmed ? ui.onPrimary : ui.primary} />
                        <Text
                          style={[
                            styles.triggerGunButtonText,
                            isArmed && styles.triggerGunButtonTextArmed,
                          ]}
                        >
                          {isArmed ? 'APUNTA AL CÓDIGO (ARMADO)' : 'PRESIONAR PARA ESCANEAR'}
                        </Text>
                      </TouchableOpacity>
                    )}

                    {/* Resumen de Historial y Contador de Ítems */}
                    <View style={styles.historyHeaderRow}>
                      <View style={styles.historyCounterBadge}>
                        <Check size={14} color={ui.success} />
                        <Text style={styles.historyCounterText}>
                          {scannedHistory.length}{' '}
                          {scannedHistory.length === 1 ? 'ítem transmitido' : 'ítems transmitidos'}
                        </Text>
                      </View>

                      {scannedHistory.length > 0 && (
                        <TouchableOpacity
                          onPress={handleClearHistory}
                          style={styles.clearHistoryButton}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Trash2 size={14} color="#6B7280" />
                          <Text style={styles.clearHistoryText}>Limpiar</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {/* Lista Horizontal de Lecturas Recientes */}
                    {scannedHistory.length > 0 ? (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.historyScrollContent}
                      >
                        {scannedHistory.slice(0, 15).map((item) => (
                          <View key={item.id} style={styles.historyCardItem}>
                            <View style={styles.historyCardTop}>
                              <Text style={styles.historyCardCode} numberOfLines={1}>
                                {item.code}
                              </Text>
                              <View
                                style={[
                                  styles.historyStatusDot,
                                  item.status === 'rejected' && styles.historyStatusDotRejected,
                                ]}
                              />
                            </View>
                            <Text style={styles.historyCardName} numberOfLines={1}>
                              {item.productName || 'Producto'}
                            </Text>
                            {item.productPrice !== undefined && (
                              <Text style={styles.historyCardPrice}>
                                {formatPEN(item.productPrice)}
                              </Text>
                            )}
                          </View>
                        ))}
                      </ScrollView>
                    ) : (
                      <View style={styles.emptyHistoryBox}>
                        <Text style={styles.emptyHistoryText}>
                          Listo para escanear. Los productos leídos aparecerán aquí y en la PC al
                          instante.
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* =================================================================== */}
        {/* MODAL 1: PEGAR ENLACE O SESIÓN MANUAL (ESTADO 1) */}
        {/* =================================================================== */}
        <Modal
          visible={manualInputModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setManualInputModalVisible(false)}
        >
          <KeyboardAvoidingView
            style={styles.modalBackdrop}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.modalCard}>
              <View style={styles.modalCardHeader}>
                <Text style={styles.modalCardTitle}>Vinculación Manual</Text>
                <TouchableOpacity
                  onPress={() => setManualInputModalVisible(false)}
                  style={styles.modalCloseButton}
                >
                  <X size={18} color={ui.textMuted} />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalCardSubtitle}>
                Pega la URL de vinculación o escribe el ID de sesión generado por Ventify Web en la
                computadora.
              </Text>

              <TextInput
                value={manualSessionInput}
                onChangeText={setManualSessionInput}
                placeholder="https://ventify.com.pe/scanner/... o ID de sesión"
                placeholderTextColor="#6B7280"
                style={styles.textInputField}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />

              <View style={styles.modalActionButtons}>
                <TouchableOpacity
                  onPress={() => setManualInputModalVisible(false)}
                  style={styles.cancelButton}
                >
                  <Text style={styles.cancelButtonText}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleConnect(manualSessionInput)}
                  style={styles.confirmActionButton}
                  disabled={isConnecting || !manualSessionInput.trim()}
                  activeOpacity={0.8}
                >
                  {isConnecting ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.confirmActionButtonText}>Vincular</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* =================================================================== */}
        {/* MODAL 2: INGRESO MANUAL DE CÓDIGO DE BARRAS (ESTADO 2) */}
        {/* =================================================================== */}
        <Modal
          visible={manualBarcodeModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setManualBarcodeModalVisible(false)}
        >
          <KeyboardAvoidingView
            style={styles.modalBackdrop}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.modalCard}>
              <View style={styles.modalCardHeader}>
                <Text style={styles.modalCardTitle}>Escribir Código Manual</Text>
                <TouchableOpacity
                  onPress={() => setManualBarcodeModalVisible(false)}
                  style={styles.modalCloseButton}
                >
                  <X size={18} color={ui.textMuted} />
                </TouchableOpacity>
              </View>

              <Text style={styles.modalCardSubtitle}>
                Si un código de barras está dañado o no es legible por la cámara, escríbelo aquí y se
                transmitirá al carrito de la PC.
              </Text>

              <TextInput
                value={manualBarcodeText}
                onChangeText={setManualBarcodeText}
                placeholder="Ej. 7751234567891 o SKU-001"
                placeholderTextColor="#6B7280"
                style={styles.textInputField}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={handleManualBarcodeSubmit}
              />

              <View style={styles.modalActionButtons}>
                <TouchableOpacity
                  onPress={() => setManualBarcodeModalVisible(false)}
                  style={styles.cancelButton}
                >
                  <Text style={styles.cancelButtonText}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleManualBarcodeSubmit}
                  style={styles.confirmActionButton}
                  disabled={manualBarcodeText.trim().length < 2}
                  activeOpacity={0.8}
                >
                  <Text style={styles.confirmActionButtonText}>Transmitir a PC</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </Modal>
  );
};

// ============================================================================
// ESTILOS NATIVOS DARK ESMERALDA DE VENTIFY
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  centerContainer: {
    flex: 1,
    backgroundColor: ui.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  permissionBadge: {
    width: 76,
    height: 76,
    borderRadius: 24,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: ui.border,
  },
  permissionTitle: {
    fontSize: 19,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 10,
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 13,
    color: ui.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    maxWidth: 320,
  },
  primaryActionButton: {
    backgroundColor: ui.primary,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    width: '100%',
    maxWidth: 280,
    alignItems: 'center',
  },
  primaryActionButtonText: {
    color: ui.onPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
  secondaryTextButton: {
    marginTop: 16,
    padding: 8,
  },
  secondaryTextButtonLabel: {
    color: ui.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 14,
    backgroundColor: 'rgba(11, 15, 23, 0.88)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(31, 41, 55, 0.6)',
  },
  headerIconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconButtonActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.25)',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  disconnectButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    marginLeft: 8,
  },
  headerActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitleColumn: {
    alignItems: 'center',
  },
  headerMainTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  headerSubTitle: {
    fontSize: 11,
    color: '#10B981',
    fontWeight: '600',
    marginTop: 2,
  },
  headerSessionInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pulseContainer: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  pulseRing: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#10B981',
  },
  pulseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10B981',
  },
  connectedTitleText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#10B981',
    letterSpacing: 0.5,
  },
  purposePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    marginTop: 2,
    alignSelf: 'center',
  },
  purposePillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#34D399',
  },
  reticleSection: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  hudBannerCard: {
    position: 'absolute',
    top: -85,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1.5,
    borderColor: '#10B981',
    maxWidth: '90%',
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
    zIndex: 10,
  },
  hudBadgeIcon: {
    marginRight: 10,
  },
  hudContent: {
    flex: 1,
  },
  hudProductName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  hudMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  hudProductPrice: {
    fontSize: 12,
    fontWeight: '800',
    color: '#10B981',
  },
  hudCodeText: {
    fontSize: 12,
    color: ui.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  hudSentPill: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  hudSentPillText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#34D399',
  },
  reticleFrame: {
    width: 290,
    height: 180,
    borderRadius: 16,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
  },
  reticleFrameQr: {
    width: 250,
    height: 250,
  },
  reticleCorner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: ui.primary,
  },
  cornerTL: {
    top: -2,
    left: -2,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 16,
  },
  cornerTR: {
    top: -2,
    right: -2,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 16,
  },
  cornerBL: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 16,
  },
  cornerBR: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 16,
  },
  reticleCrosshair: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  animatedLaserBeam: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 2,
    backgroundColor: ui.primary,
    shadowColor: ui.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
    elevation: 4,
  },
  reticleInstruction: {
    marginTop: 18,
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  errorAlertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    marginTop: 14,
    maxWidth: '85%',
  },
  errorAlertText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  connectingToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#111827',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#10B981',
  },
  connectingToastText: {
    color: '#F9FAFB',
    fontSize: 13,
    fontWeight: '600',
  },
  bottomSheet: {
    backgroundColor: ui.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: ui.border,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  unlinkedControls: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  unlinkedHelperText: {
    fontSize: 12,
    color: ui.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
    maxWidth: 320,
  },
  boldWhite: {
    color: ui.text,
    fontWeight: '700',
  },
  manualEntryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primarySoft,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
  },
  manualEntryButtonText: {
    color: ui.primary,
    fontWeight: '700',
    fontSize: 14,
  },
  linkedControlsContainer: {
    gap: 12,
  },
  modeToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modeToggleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: ui.surfaceMuted,
    minHeight: 48,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modeToggleButtonActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  modeToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  modeToggleTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  keyboardIconBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  triggerGunButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    paddingVertical: 14,
    borderRadius: 14,
  },
  triggerGunButtonArmed: {
    backgroundColor: ui.primary,
  },
  triggerGunButtonText: {
    color: ui.primary,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  triggerGunButtonTextArmed: {
    color: ui.onPrimary,
  },
  historyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
  },
  historyCounterBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.successSoft,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  historyCounterText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.success,
  },
  clearHistoryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    padding: 4,
  },
  clearHistoryText: {
    fontSize: 13,
    color: ui.textSecondary,
    fontWeight: '600',
  },
  historyScrollContent: {
    gap: 8,
    paddingVertical: 4,
  },
  historyCardItem: {
    width: 140,
    backgroundColor: ui.surface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: ui.border,
  },
  historyCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  historyCardCode: {
    fontSize: 12,
    color: ui.textSecondary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  historyStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
  },
  historyStatusDotRejected: {
    backgroundColor: '#EF4444',
  },
  historyCardName: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.text,
    marginBottom: 2,
  },
  historyCardPrice: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.success,
  },
  emptyHistoryBox: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  emptyHistoryText: {
    fontSize: 12,
    color: ui.textSecondary,
    textAlign: 'center',
    lineHeight: 16,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: ui.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: ui.border,
  },
  modalCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  modalCloseButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCardSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 16,
  },
  textInputField: {
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: ui.text,
    minHeight: 52,
    marginBottom: 18,
  },
  modalActionButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  cancelButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    minHeight: 48,
  },
  cancelButtonText: {
    color: ui.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  confirmActionButton: {
    backgroundColor: ui.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 88,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmActionButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
