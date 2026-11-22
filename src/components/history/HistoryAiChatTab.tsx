import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Send, Trash2 } from 'lucide-react-native';

import { ui } from '@/lib/theme';
import { askVentyAI } from '@/services/crm-operations-service';

import { historyStyles as styles } from './historyStyles';
import {
  AI_QUICK_CHIPS,
  AI_WELCOME_MESSAGE,
  VENTY_ICON,
  type ChatMessage,
} from './historyTypes';

const ChatMessageRow = React.memo<{ msg: ChatMessage }>(({ msg }) => {
  const isAi = msg.sender === 'ai';
  return (
    <View
      style={[
        styles.chatBubbleWrapper,
        isAi ? styles.chatBubbleAiWrapper : styles.chatBubbleUserWrapper,
      ]}
    >
      {isAi && (
        <View style={styles.aiAvatar}>
          <Image source={VENTY_ICON} style={styles.aiAvatarImg} contentFit="contain" />
        </View>
      )}
      <View style={[styles.chatBubble, isAi ? styles.chatBubbleAi : styles.chatBubbleUser]}>
        <Text style={[styles.chatText, isAi ? styles.chatTextAi : styles.chatTextUser]}>
          {msg.text}
        </Text>
      </View>
    </View>
  );
});

interface AiChatInputBarProps {
  bottomInset: number;
  isAiLoading: boolean;
  onSend: (text: string) => void;
}

const AiChatInputBar = React.memo<AiChatInputBarProps>(
  ({ bottomInset, isAiLoading, onSend }) => {
    const [chatInput, setChatInput] = useState('');
    const chatInputRef = useRef('');

    const handleChangeText = useCallback((text: string) => {
      chatInputRef.current = text;
      setChatInput(text);
    }, []);

    const handlePressSend = useCallback(() => {
      const trimmed = chatInputRef.current.trim();
      if (!trimmed || isAiLoading) return;
      chatInputRef.current = '';
      setChatInput('');
      onSend(trimmed);
    }, [isAiLoading, onSend]);

    const barStyle = useMemo(
      () => [styles.chatInputBar, { paddingBottom: Math.max(bottomInset, 12) }],
      [bottomInset]
    );
    const hasInput = chatInput.trim().length > 0;
    const sendDisabled = !hasInput || isAiLoading;

    return (
      <View style={barStyle}>
        <TextInput
          style={styles.chatTextInput}
          accessibilityLabel="Escribe una pregunta para Venty IA"
          placeholder="Pregúntale a Venty IA sobre tu negocio..."
          placeholderTextColor={ui.textMuted}
          value={chatInput}
          onChangeText={handleChangeText}
          onSubmitEditing={handlePressSend}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[styles.chatSendButton, !hasInput && styles.chatSendButtonDisabled]}
          onPress={handlePressSend}
          disabled={sendDisabled}
          accessibilityRole="button"
          accessibilityLabel={isAiLoading ? 'Venty IA está respondiendo' : 'Enviar pregunta'}
          accessibilityState={{ disabled: sendDisabled, busy: isAiLoading }}
        >
          <Send size={18} color={ui.onPrimary} />
        </TouchableOpacity>
      </View>
    );
  }
);

export interface HistoryAiChatTabProps {
  accountId: string | null;
  branchId: string | null;
  bottomInset: number;
  chatMessages: ChatMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export const HistoryAiChatTab = React.memo<HistoryAiChatTabProps>(
  ({ accountId, branchId, bottomInset, chatMessages, setChatMessages }) => {
    const [isAiLoading, setIsAiLoading] = useState(false);
    const chatListRef = useRef<FlashList<ChatMessage>>(null);
    const chatScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const isMountedRef = useRef(true);
    const chatMessagesRef = useRef(chatMessages);
    chatMessagesRef.current = chatMessages;

    useEffect(() => {
      isMountedRef.current = true;
      return () => {
        isMountedRef.current = false;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        if (chatScrollTimerRef.current) {
          clearTimeout(chatScrollTimerRef.current);
          chatScrollTimerRef.current = null;
        }
      };
    }, []);

    const scheduleChatScrollToEnd = useCallback(() => {
      if (chatScrollTimerRef.current) {
        clearTimeout(chatScrollTimerRef.current);
      }
      chatScrollTimerRef.current = setTimeout(() => {
        chatListRef.current?.scrollToEnd({ animated: true });
        chatScrollTimerRef.current = null;
      }, 100);
    }, []);

    const handleClearChat = useCallback(() => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setIsAiLoading(false);
      setChatMessages([{ ...AI_WELCOME_MESSAGE, timestamp: Date.now() }]);
    }, [setChatMessages]);

    const handleSendAiMessage = useCallback(
      async (textToSend: string) => {
        const trimmed = textToSend.trim();
        if (!trimmed) return;

        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const conversationHistory = chatMessagesRef.current
          .filter((m) => m.id !== 'welcome' && m.text.trim().length > 0)
          .slice(-10)
          .map((m) => ({
            role: m.sender === 'ai' ? ('assistant' as const) : ('user' as const),
            content: m.text,
          }));

        const userMsg: ChatMessage = {
          id: `u_${Date.now()}`,
          sender: 'user',
          text: trimmed,
          timestamp: Date.now(),
        };

        setChatMessages((prev) => [...prev, userMsg]);
        setIsAiLoading(true);
        scheduleChatScrollToEnd();

        try {
          const response = await askVentyAI({
            question: trimmed,
            accountId: accountId || undefined,
            branchId: branchId || undefined,
            conversationHistory,
            signal: controller.signal,
          });

          if (controller.signal.aborted || !isMountedRef.current) return;

          const replyText =
            typeof response === 'string' ? response : (response as any)?.reply || '';
          if (!replyText.trim()) return;

          const aiMsg: ChatMessage = {
            id: `ai_${Date.now()}`,
            sender: 'ai',
            text: replyText,
            timestamp: Date.now(),
          };
          setChatMessages((prev) => [...prev, aiMsg]);
        } catch {
          if (controller.signal.aborted || !isMountedRef.current) return;
          const errReply: ChatMessage = {
            id: `err_${Date.now()}`,
            sender: 'ai',
            text: 'Lo siento, ocurrió un error temporal al procesar la respuesta. Por favor intenta nuevamente.',
            timestamp: Date.now(),
          };
          setChatMessages((prev) => [...prev, errReply]);
        } finally {
          if (isMountedRef.current && abortControllerRef.current === controller) {
            abortControllerRef.current = null;
            setIsAiLoading(false);
            scheduleChatScrollToEnd();
          }
        }
      },
      [accountId, branchId, scheduleChatScrollToEnd, setChatMessages]
    );

    const renderChatMessageItem = useCallback(
      ({ item }: { item: ChatMessage }) => <ChatMessageRow msg={item} />,
      []
    );
    const chatKeyExtractor = useCallback((item: ChatMessage) => item.id, []);
    const chatItemType = useCallback((item: ChatMessage) => item.sender, []);
    const chatListContentStyle = useMemo(() => ({ padding: 16, paddingBottom: 20 }), []);
    const hasConversation = chatMessages.length > 1;

    const chatFooterElement = useMemo(
      () => (
        <>
          {isAiLoading && (
            <View style={styles.aiTypingBox}>
              <Image source={VENTY_ICON} style={styles.aiTypingImg} contentFit="contain" />
              <ActivityIndicator size="small" color={ui.primary} />
              <Text style={styles.aiTypingText}>Venty IA está analizando los datos...</Text>
            </View>
          )}
          <View style={styles.quickQuestionsContainer}>
            <View style={styles.quickQuestionsHeaderRow}>
              <View style={styles.quickQuestionsTitleRow}>
                <Image
                  source={VENTY_ICON}
                  style={{ width: 18, height: 18, borderRadius: 9 }}
                  contentFit="cover"
                />
                <Text style={styles.quickQuestionsTitle}>Consultas rápidas:</Text>
              </View>
              {hasConversation ? (
                <TouchableOpacity
                  style={styles.clearChatBtn}
                  onPress={handleClearChat}
                  accessibilityRole="button"
                  accessibilityLabel="Limpiar conversación con Venty IA"
                >
                  <Trash2 size={12} color={ui.textSecondary} />
                  <Text style={styles.clearChatBtnText}>Limpiar</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <View style={styles.quickChipsGrid}>
              {AI_QUICK_CHIPS.map((chip, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.quickChip}
                  onPress={() => void handleSendAiMessage(chip)}
                >
                  <Text style={styles.quickChipText}>{chip}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </>
      ),
      [isAiLoading, hasConversation, handleClearChat, handleSendAiMessage]
    );

    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex1}
      >
        <View style={styles.chatScroll}>
          <FlashList
            ref={chatListRef}
            data={chatMessages}
            renderItem={renderChatMessageItem}
            keyExtractor={chatKeyExtractor}
            getItemType={chatItemType}
            estimatedItemSize={88}
            ListFooterComponent={chatFooterElement}
            contentContainerStyle={chatListContentStyle}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            showsVerticalScrollIndicator={false}
          />
        </View>

        <AiChatInputBar
          bottomInset={bottomInset}
          isAiLoading={isAiLoading}
          onSend={handleSendAiMessage}
        />
      </KeyboardAvoidingView>
    );
  }
);
