/**
 * ChatScreen — headless, zero-dependency chat interface.
 *
 * Renders using only React Native core primitives:
 *   View, Text, TextInput, FlatList, Pressable, ActivityIndicator.
 *
 * All network logic lives in useSSEChat. This component is purely presentational.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSSEChat, type ChatMessage } from '@/hooks/use-sse-chat';

// ── Constants ─────────────────────────────────────────────────────────────────

// ── Backend URL ───────────────────────────────────────────────────────────────
// iOS Simulator  → localhost resolves to the host Mac. ✓
// Android Emu    → 10.0.2.2 is the host alias inside the emulator. ✓
// Physical device → replace PHYSICAL_DEVICE_HOST with your Mac's LAN IP
//                   (run `ipconfig getifaddr en0` to find it).
// Mac's LAN IP — physical Android device must be on the same Wi-Fi network.
const PHYSICAL_DEVICE_HOST = '192.168.1.15';
const BASE_URL = `http://${PHYSICAL_DEVICE_HOST}:8080`;

// ── ChatScreen ────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { messages, isExecutingTool, isStreaming, error, sendMessage, reset } =
    useSSEChat(BASE_URL);
  const insets = useSafeAreaInsets();

  const [inputText, setInputText] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  // Auto-scroll to the bottom whenever the message list changes.
  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = inputText.trim();
    if (!trimmed || isStreaming) return;
    sendMessage(trimmed);
    setInputText('');
  }, [inputText, isStreaming, sendMessage]);

  const keyExtractor = useCallback((_: ChatMessage, i: number) => String(i), []);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageRow message={item} />,
    [],
  );

  const sendDisabled = isStreaming || !inputText.trim();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Assistant</Text>
          {messages.length > 0 && (
            <Pressable onPress={reset} accessibilityRole="button">
              <Text style={styles.clearBtn}>Clear</Text>
            </Pressable>
          )}
        </View>

        {/* ── Message list ── */}
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* ── Tool execution banner ── */}
        {isExecutingTool && <ExecutingBanner />}

        {/* ── Error banner ── */}
        {error ? <ErrorBanner message={error} /> : null}

        {/* ── Input bar ── */}
        <View style={[styles.inputBar, { paddingBottom: 10 + insets.bottom }]}>
          <TextInput
            value={inputText}
            onChangeText={setInputText}
            placeholder="Message…"
            placeholderTextColor="#9CA3AF"
            multiline
            style={styles.textInput}
            editable={!isStreaming}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
          />
          <Pressable
            onPress={handleSend}
            disabled={sendDisabled}
            style={({ pressed }) => [
              styles.sendBtn,
              sendDisabled && styles.sendBtnDisabled,
              pressed && !sendDisabled && styles.sendBtnPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <Text style={[styles.sendBtnText, sendDisabled && styles.sendBtnTextDisabled]}>
              ↑
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{message.content}</Text>
        </View>
      </View>
    );
  }

  if (message.role === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.content}</Text>
      </View>
    );
  }

  // assistant
  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantBubble}>
        <Text style={styles.assistantText}>{message.content}</Text>
      </View>
    </View>
  );
}

/**
 * ExecutingBanner — shown while isExecutingTool is true.
 * Sits between the message list and the input bar so it's always visible.
 */
function ExecutingBanner() {
  return (
    <View style={styles.executingBanner}>
      <ActivityIndicator size="small" color="#92400E" />
      <Text style={styles.executingText}>🤖 Executing Task...</Text>
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>💬</Text>
      <Text style={styles.emptyTitle}>Personal Assistant</Text>
      <Text style={styles.emptyHint}>
        Ask me anything or tell me to create a task.
      </Text>
    </View>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorText}>⚠ {message}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#FFFFFF' },

  // ── Header ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  clearBtn: {
    fontSize: 14,
    color: '#0a7ea4',
    fontWeight: '500',
  },

  // ── Message list ──
  listContent: {
    paddingVertical: 12,
    flexGrow: 1,
  },

  // ── User bubble ──
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  userBubble: {
    backgroundColor: '#0a7ea4',
    borderRadius: 18,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '80%',
  },
  userText: {
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 21,
  },

  // ── Assistant bubble ──
  assistantRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  assistantBubble: {
    backgroundColor: '#F3F4F6',
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '85%',
  },
  assistantText: {
    color: '#111827',
    fontSize: 15,
    lineHeight: 22,
  },

  // ── System message ──
  systemRow: {
    alignItems: 'center',
    marginVertical: 6,
    paddingHorizontal: 16,
  },
  systemText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
  },

  // ── Executing banner ──
  executingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginVertical: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  executingText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#92400E',
  },

  // ── Error banner ──
  errorBanner: {
    marginHorizontal: 12,
    marginVertical: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: {
    fontSize: 13,
    color: '#991B1B',
  },

  // ── Empty state ──
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyIcon: { fontSize: 48 },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  emptyHint: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Input bar ──
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  textInput: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 22,
    color: '#111827',
    maxHeight: 120,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#E5E7EB' },
  sendBtnPressed: { opacity: 0.75 },
  sendBtnText: {
    fontSize: 18,
    color: '#FFFFFF',
    fontWeight: '700',
    lineHeight: 22,
  },
  sendBtnTextDisabled: { color: '#9CA3AF' },
});
