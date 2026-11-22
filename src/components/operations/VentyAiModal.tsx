import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { AlertCircle, AlertTriangle, Send, X } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import { askVentyAI } from '@/services/crm-operations-service';
import { operationsStyles as styles } from './operationsStyles';
import type { VentyChatMessage } from './types';

const VENTY_QUICK_CHIPS = [
  '¿Cuánto efectivo hay en caja?',
  '¿Quiénes tienen fiados pendientes?',
  'Resumen de ventas del turno',
] as const;

const createWelcomeMessage = (): VentyChatMessage => ({
  id: 'venty_welcome',
  sender: 'ai',
  text: '¡Hola! Soy Venty IA. Puedo analizar tu caja actual, ventas, stock crítico o cuentas por cobrar. ¿Qué deseas consultar?',
  timestamp: Date.now(),
});

const VentyMessageSeparator = () => <View style={styles.listSeparator12} />;

interface VentyMessageBubbleProps {
  msg: VentyChatMessage;
  loading: boolean;
}

const VentyMessageBubble = React.memo<VentyMessageBubbleProps>(({ msg, loading }) => {
  const isAi = msg.sender === 'ai';
  return (
    <View
      style={[
        styles.ventyBubble,
        isAi ? styles.ventyBubbleAi : styles.ventyBubbleUser,
        msg.isError && styles.ventyBubbleError,
      ]}
    >
      <Text
        style={[
          styles.ventyBubbleText,
          isAi ? styles.ventyBubbleTextAi : styles.ventyBubbleTextUser,
          msg.isError && styles.ventyBubbleTextError,
        ]}
      >
        {msg.text || (isAi && loading ? 'Analizando datos en tiempo real...' : '')}
      </Text>
    </View>
  );
});

export interface VentyAiModalProps {
  visible: boolean;
  onClose: () => void;
  accountId?: string | null;
  branchId?: string | null;
  isOnline: boolean;
}

export const VentyAiModal = React.memo<VentyAiModalProps>(({
  visible,
  onClose,
  accountId,
  branchId,
  isOnline,
}) => {
  const [ventyInput, setVentyInput] = useState<string>('');
  const [ventyLoading, setVentyLoading] = useState<boolean>(false);
  const [ventyError, setVentyError] = useState<string | null>(null);
  const [ventyMessages, setVentyMessages] = useState<VentyChatMessage[]>(() => [
    createWelcomeMessage(),
  ]);

  const ventyListRef = useRef<FlashList<VentyChatMessage> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<number>(0);
  const ventyStreamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ventyScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ventyLatestChunkRef = useRef<string>('');
  const ventyLastFlushAtRef = useRef<number>(0);
  const lastAccountIdRef = useRef<string | null | undefined>(accountId);
  const messagesRef = useRef<VentyChatMessage[]>(ventyMessages);
  messagesRef.current = ventyMessages;

  const cancelActiveStream = useCallback(() => {
    requestIdRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (ventyStreamTimerRef.current) {
      clearTimeout(ventyStreamTimerRef.current);
      ventyStreamTimerRef.current = null;
    }
    if (ventyScrollTimerRef.current) {
      clearTimeout(ventyScrollTimerRef.current);
      ventyScrollTimerRef.current = null;
    }
    setVentyLoading(false);
  }, []);

  useEffect(() => {
    if (lastAccountIdRef.current !== accountId) {
      lastAccountIdRef.current = accountId;
      cancelActiveStream();
      setVentyMessages([createWelcomeMessage()]);
      setVentyError(null);
      setVentyInput('');
    }
  }, [accountId, cancelActiveStream]);

  useEffect(() => {
    if (!visible) {
      cancelActiveStream();
    }
  }, [visible, cancelActiveStream]);

  useEffect(() => {
    return () => {
      cancelActiveStream();
    };
  }, [cancelActiveStream]);

  const scrollListToEnd = useCallback((animated: boolean) => {
    try {
      ventyListRef.current?.scrollToEnd({ animated });
    } catch {
      // Ignore layout timing errors before first measurement
    }
  }, []);

  const handleSendVentyMessage = useCallback(async (customText?: string) => {
    const question = (customText ?? ventyInput).trim();
    if (!question) return;

    setVentyError(null);
    if (!isOnline) {
      setVentyError('Sin conexión a internet. Venty IA necesita conexión activa.');
      return;
    }

    // Cancel any previous in-flight SSE stream before starting a new prompt
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (ventyStreamTimerRef.current) {
      clearTimeout(ventyStreamTimerRef.current);
      ventyStreamTimerRef.current = null;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const reqId = ++requestIdRef.current;

    const now = Date.now();
    const userMsg: VentyChatMessage = {
      id: `v_u_${now}_${reqId}`,
      sender: 'user',
      text: question,
      timestamp: now,
    };
    const streamAiId = `v_ai_${now + 1}_${reqId}`;
    const placeholderAi: VentyChatMessage = {
      id: streamAiId,
      sender: 'ai',
      text: '',
      timestamp: now,
    };

    const historyPayload = messagesRef.current
      .filter((m) => m.id !== 'venty_welcome' && !m.isError && m.text.trim().length > 0)
      .slice(-8)
      .map((m) => ({
        role: m.sender === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      }));

    setVentyMessages((prev) => [
      ...prev.filter((m) => !(m.sender === 'ai' && m.text === '')),
      userMsg,
      placeholderAi,
    ]);
    if (!customText) setVentyInput('');
    setVentyLoading(true);
    ventyLatestChunkRef.current = '';
    ventyLastFlushAtRef.current = 0;

    if (ventyScrollTimerRef.current) clearTimeout(ventyScrollTimerRef.current);
    ventyScrollTimerRef.current = setTimeout(() => {
      ventyScrollTimerRef.current = null;
      scrollListToEnd(true);
    }, 80);

    const flushVentyChunk = (text: string) => {
      if (requestIdRef.current !== reqId || controller.signal.aborted) return;
      ventyLastFlushAtRef.current = Date.now();
      setVentyMessages((prev) =>
        prev.map((m) => (m.id === streamAiId ? { ...m, text } : m))
      );
      scrollListToEnd(false);
    };

    try {
      const finalReply = await askVentyAI({
        question,
        accountId: accountId || undefined,
        branchId: branchId || undefined,
        conversationHistory: historyPayload,
        signal: controller.signal,
        onChunk: (accumulatedText) => {
          if (requestIdRef.current !== reqId || controller.signal.aborted) return;
          ventyLatestChunkRef.current = accumulatedText;
          const elapsed = Date.now() - ventyLastFlushAtRef.current;
          if (elapsed >= 60) {
            if (ventyStreamTimerRef.current) {
              clearTimeout(ventyStreamTimerRef.current);
              ventyStreamTimerRef.current = null;
            }
            flushVentyChunk(accumulatedText);
          } else if (!ventyStreamTimerRef.current) {
            ventyStreamTimerRef.current = setTimeout(() => {
              ventyStreamTimerRef.current = null;
              flushVentyChunk(ventyLatestChunkRef.current);
            }, 60 - elapsed);
          }
        },
      });

      if (ventyStreamTimerRef.current) {
        clearTimeout(ventyStreamTimerRef.current);
        ventyStreamTimerRef.current = null;
      }

      if (requestIdRef.current !== reqId || controller.signal.aborted) {
        return;
      }

      const resolvedText = finalReply?.trim() || 'No se recibió respuesta de Venty IA.';
      const looksLikeError =
        resolvedText.startsWith('Sin conexión') ||
        resolvedText.startsWith('Venty IA tardó') ||
        resolvedText.startsWith('Venty IA no pudo') ||
        resolvedText.startsWith('No se pudo validar') ||
        resolvedText.startsWith('No se pudo identificar');

      setVentyMessages((prev) =>
        prev.map((m) =>
          m.id === streamAiId ? { ...m, text: resolvedText, isError: looksLikeError } : m
        )
      );
      if (looksLikeError) {
        setVentyError(resolvedText);
      }
    } catch (err: any) {
      if (ventyStreamTimerRef.current) {
        clearTimeout(ventyStreamTimerRef.current);
        ventyStreamTimerRef.current = null;
      }
      if (requestIdRef.current !== reqId || controller.signal.aborted) {
        return;
      }
      const errText = err?.message || 'Ocurrió un error al consultar a Venty IA.';
      setVentyError(errText);
      setVentyMessages((prev) =>
        prev.map((m) => (m.id === streamAiId ? { ...m, text: errText, isError: true } : m))
      );
    } finally {
      if (requestIdRef.current === reqId) {
        if (ventyStreamTimerRef.current) {
          clearTimeout(ventyStreamTimerRef.current);
          ventyStreamTimerRef.current = null;
        }
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setVentyLoading(false);
        if (ventyScrollTimerRef.current) clearTimeout(ventyScrollTimerRef.current);
        ventyScrollTimerRef.current = setTimeout(() => {
          ventyScrollTimerRef.current = null;
          scrollListToEnd(true);
        }, 80);
      }
    }
  }, [ventyInput, isOnline, accountId, branchId, scrollListToEnd]);

  const handleClose = useCallback(() => {
    cancelActiveStream();
    onClose();
  }, [cancelActiveStream, onClose]);

  const keyExtractor = useCallback((item: VentyChatMessage) => item.id, []);
  const getItemType = useCallback((item: VentyChatMessage) => item.sender, []);
  const renderItem = useCallback(
    ({ item }: { item: VentyChatMessage }) => (
      <VentyMessageBubble msg={item} loading={ventyLoading} />
    ),
    [ventyLoading]
  );

  const listFooterElement = useMemo(
    () => (
      <View style={styles.ventyChipsWrap}>
        {VENTY_QUICK_CHIPS.map((chip) => (
          <TouchableOpacity
            key={chip}
            style={styles.ventyQuickChip}
            onPress={() => void handleSendVentyMessage(chip)}
          >
            <Text style={styles.ventyQuickChipText}>{chip}</Text>
          </TouchableOpacity>
        ))}
      </View>
    ),
    [handleSendVentyMessage]
  );

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView edges={['top', 'bottom']} style={styles.fullSheetContainer}>
        <View style={styles.fullSheetHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
            <Image
              source={require('../../../assets/venty-icon.webp')}
              style={{ width: 28, height: 28, borderRadius: 14 }}
              contentFit="cover"
            />
            <View>
              <Text style={styles.modalTitle}>Venty IA</Text>
              <Text style={styles.modalSub}>Asistente operativo en tiempo real</Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Cerrar Venty IA"
          >
            <X size={20} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {!isOnline && (
          <View style={styles.ventyOfflineBanner}>
            <AlertTriangle size={16} color={ui.warning} />
            <Text style={styles.ventyOfflineText}>
              Sin conexión a internet. Conéctate para consultar a Venty IA.
            </Text>
          </View>
        )}

        {ventyError && isOnline ? (
          <View style={styles.ventyErrorBanner}>
            <AlertCircle size={16} color={ui.danger} />
            <Text style={styles.ventyErrorText} numberOfLines={2}>
              {ventyError}
            </Text>
          </View>
        ) : null}

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <FlashList
            ref={ventyListRef}
            data={ventyMessages}
            extraData={ventyLoading}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            estimatedItemSize={76}
            ItemSeparatorComponent={VentyMessageSeparator}
            contentContainerStyle={styles.ventyMessagesContent}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={listFooterElement}
          />

          <View style={styles.ventyInputBar}>
            <TextInput
              style={styles.ventyTextInput}
              placeholder="Pregúntale a Venty IA..."
              placeholderTextColor={ui.textMuted}
              value={ventyInput}
              onChangeText={setVentyInput}
              onSubmitEditing={() => void handleSendVentyMessage()}
              returnKeyType="send"
            />
            <TouchableOpacity
              style={[
                styles.ventySendBtn,
                !ventyInput.trim() && styles.buttonDisabled,
              ]}
              onPress={() => void handleSendVentyMessage()}
              disabled={!ventyInput.trim()}
            >
              {ventyLoading && !ventyInput.trim() ? (
                <ActivityIndicator size="small" color={ui.onPrimary} />
              ) : (
                <Send size={18} color={ui.onPrimary} />
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
});
