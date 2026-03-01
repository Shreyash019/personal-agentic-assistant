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
  Animated,
  Easing,
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

import { useHealth } from '@/hooks/use-health';
import { useSSEChat, type ChatMessage } from '@/hooks/use-sse-chat';
import { useUserID } from '@/hooks/use-user-id';

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
  const userID = useUserID();
  const health = useHealth(BASE_URL);
  const { messages, isExecutingTool, isStreaming, error, sendMessage, reset } =
    useSSEChat(BASE_URL, { userID });
  const insets = useSafeAreaInsets();

  const [inputText, setInputText] = useState('');
  const [taskModeEnabled, setTaskModeEnabled] = useState(false);
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
    sendMessage(trimmed, { forceTask: taskModeEnabled });
    setInputText('');
  }, [inputText, isStreaming, sendMessage, taskModeEnabled]);

  const keyExtractor = useCallback((_: ChatMessage, i: number) => String(i), []);

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => (
      <MessageRow
        message={item}
        isStreaming={isStreaming}
        isLatest={index === messages.length - 1}
      />
    ),
    [isStreaming, messages.length],
  );

  const isOffline = health === 'offline';
  const sendDisabled = isStreaming || !inputText.trim() || isOffline;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Assistant</Text>
            <ConnectionDot status={health} />
          </View>
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

        {/* ── Offline banner ── */}
        {isOffline && <OfflineBanner />}

        {/* ── Tool execution banner ── */}
        {isExecutingTool && <ExecutingBanner />}

        {/* ── Error banner ── */}
        {error ? <ErrorBanner /> : null}

        {/* ── Input bar ── */}
        <View style={[styles.inputBar, { paddingBottom: 10 + insets.bottom }]}>
          <Pressable
            onPress={() => setTaskModeEnabled((prev) => !prev)}
            disabled={isStreaming || isOffline}
            style={({ pressed }) => [
              styles.taskModeBtn,
              taskModeEnabled && styles.taskModeBtnEnabled,
              (isStreaming || isOffline) && styles.taskModeBtnDisabled,
              pressed && !(isStreaming || isOffline) && styles.sendBtnPressed,
            ]}
            accessibilityRole="switch"
            accessibilityState={{ checked: taskModeEnabled, disabled: isStreaming || isOffline }}
            accessibilityLabel="Task mode"
          >
            <Text
              style={[
                styles.taskModeBtnText,
                taskModeEnabled && styles.taskModeBtnTextEnabled,
              ]}
            >
              ✓
            </Text>
          </Pressable>

          <TextInput
            value={inputText}
            onChangeText={setInputText}
            placeholder="Message…"
            placeholderTextColor="#9CA3AF"
            multiline
            style={styles.textInput}
            editable={!isStreaming && !isOffline}
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

function MessageRow({
  message,
  isStreaming,
  isLatest,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  isLatest: boolean;
}) {
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
    if (message.content === '__TASK_CREATED__') {
      return (
        <View style={styles.systemTaskRow}>
          <View style={styles.systemTaskPill}>
            <Text style={styles.systemTaskIcon}>🗂️</Text>
            <Text style={styles.systemTaskCheck}>✓</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.content}</Text>
      </View>
    );
  }

  // assistant
  if (isStreaming && isLatest && !message.content.trim()) {
    return (
      <View style={styles.assistantRow}>
        <View style={styles.assistantBubble}>
          <GeneratingDots />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantBubble}>
        <Text style={styles.assistantText}>{message.content}</Text>
      </View>
    </View>
  );
}

function GeneratingDots() {
  const dot1 = useRef(new Animated.Value(0.25)).current;
  const dot2 = useRef(new Animated.Value(0.25)).current;
  const dot3 = useRef(new Animated.Value(0.25)).current;

  useEffect(() => {
    const pulse = (value: Animated.Value) =>
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 220,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0.25,
          duration: 220,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]);

    const loop = Animated.loop(
      Animated.stagger(120, [pulse(dot1), pulse(dot2), pulse(dot3)]),
    );

    loop.start();
    return () => loop.stop();
  }, [dot1, dot2, dot3]);

  return (
    <View style={styles.generatingRow}>
      <Animated.View style={[styles.generatingDot, { opacity: dot1 }]} />
      <Animated.View style={[styles.generatingDot, { opacity: dot2 }]} />
      <Animated.View style={[styles.generatingDot, { opacity: dot3 }]} />
      <Text style={styles.generatingLabel}>Generating…</Text>
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

/** ConnectionDot — a small coloured circle in the header reflecting GET /health. */
function ConnectionDot({ status }: { status: 'checking' | 'online' | 'offline' }) {
  const dotColor =
    status === 'online' ? '#22C55E' : status === 'offline' ? '#EF4444' : '#F59E0B';
  const label =
    status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Connecting…';
  return (
    <View style={styles.connectionRow} accessibilityLabel={`Server ${label}`}>
      <View style={[styles.connectionDot, { backgroundColor: dotColor }]} />
      <Text style={[styles.connectionLabel, { color: dotColor }]}>{label}</Text>
    </View>
  );
}

function OfflineBanner() {
  return (
    <View style={styles.offlineBanner}>
      <Text style={styles.offlineText}>⚠ Assistant is unavailable. Please check your connection.</Text>
    </View>
  );
}

function ErrorBanner() {
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorText}>⚠ Something went wrong. Please try again.</Text>
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
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  connectionLabel: {
    fontSize: 11,
    fontWeight: '500',
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
    paddingHorizontal: 8,
  },
  userBubble: {
    backgroundColor: '#0a7ea4',
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: '80%',
  },
  userText: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '400',
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
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '400',
  },
  generatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 16,
  },
  generatingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#6B7280',
  },
  generatingLabel: {
    marginLeft: 2,
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },

  // ── System message ──
  systemRow: {
    alignItems: 'center',
    marginVertical: 6,
    paddingHorizontal: 16,
  },
  systemText: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
  },
  systemTaskRow: {
    alignItems: 'center',
    marginVertical: 6,
    paddingHorizontal: 16,
  },
  systemTaskPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  systemTaskIcon: {
    fontSize: 14,
  },
  systemTaskCheck: {
    fontSize: 14,
    color: '#047857',
    fontWeight: '700',
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

  // ── Offline banner ──
  offlineBanner: {
    marginHorizontal: 12,
    marginVertical: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFBEB',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FCD34D',
  },
  offlineText: {
    fontSize: 13,
    color: '#92400E',
    fontWeight: '500',
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
  taskModeBtn: {
    width: 40,
    height: 40,
    borderRadius: 4,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskModeBtnEnabled: {
    backgroundColor: '#0a7ea4',
    borderColor: '#0a7ea4',
  },
  taskModeBtnDisabled: {
    opacity: 0.6,
  },
  taskModeBtnText: {
    fontSize: 18,
    color: '#6B7280',
    fontWeight: '700',
    lineHeight: 22,
  },
  taskModeBtnTextEnabled: {
    color: '#FFFFFF',
  },
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
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '400',
    color: '#111827',
    maxHeight: 120,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 4,
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
