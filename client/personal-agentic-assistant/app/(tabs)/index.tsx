import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChatInput } from '@/components/chat/chat-input';
import { MessageBubble } from '@/components/chat/message-bubble';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSSEChat, type ChatMessage, type ChatMode } from '@/hooks/use-sse-chat';

// ── Backend URL ───────────────────────────────────────────────────────────────
// On a physical device replace with your machine's LAN IP, e.g. "http://192.168.1.42:8000".
// On an iOS simulator "localhost" routes to the host machine directly.
const BASE_URL =
  Platform.OS === 'android'
    ? 'http://10.0.2.2:8000' // Android emulator host alias
    : 'http://localhost:8000';

// ── Chat screen ───────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { state, sendMessage, reset } = useSSEChat({ baseUrl: BASE_URL });
  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  // Auto-scroll to the bottom whenever a new message part arrives.
  useEffect(() => {
    if (state.messages.length > 0) {
      // Small delay lets the layout finish measuring before scrolling.
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [state.messages]);

  const handleSend = useCallback(
    (query: string, mode: ChatMode) => {
      sendMessage(query, mode);
    },
    [sendMessage],
  );

  const keyExtractor = useCallback(
    (_: ChatMessage, index: number) => String(index),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageBubble message={item} />,
    [],
  );

  return (
    <SafeAreaView
      style={[styles.safe, isDark ? styles.safeDark : styles.safeLight]}
      edges={['top', 'left', 'right']}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* ── Header ── */}
        <View style={[styles.header, isDark ? styles.headerDark : styles.headerLight]}>
          <Text style={[styles.headerTitle, isDark ? styles.textDark : styles.textLight]}>
            Assistant
          </Text>
          {state.messages.length > 0 && (
            <Text
              onPress={reset}
              style={styles.clearButton}
              accessibilityRole="button"
              accessibilityLabel="Clear chat"
            >
              Clear
            </Text>
          )}
        </View>

        {/* ── Message list ── */}
        {state.messages.length === 0 ? (
          <EmptyState isDark={isDark} />
        ) : (
          <FlatList
            ref={flatListRef}
            data={state.messages}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            // Keep the list pinned to the bottom while streaming.
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
        )}

        {/* ── Streaming indicator (shows between messages while waiting for response start) ── */}
        {state.isStreaming && state.messages[state.messages.length - 1]?.role === 'user' && (
          <TypingIndicator isDark={isDark} />
        )}

        {/* ── Error banner ── */}
        {state.error ? <ErrorBanner message={state.error} /> : null}

        {/* ── Input bar ── */}
        <ChatInput onSend={handleSend} disabled={state.isStreaming} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EmptyState({ isDark }: { isDark: boolean }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>💬</Text>
      <Text style={[styles.emptyTitle, isDark ? styles.textDark : styles.textLight]}>
        Personal Assistant
      </Text>
      <Text style={styles.emptyHint}>
        Switch to <Text style={styles.emptyHintBold}>Agent</Text> mode to create tasks, or{' '}
        <Text style={styles.emptyHintBold}>RAG</Text> to query your knowledge base.
      </Text>
    </View>
  );
}

function TypingIndicator({ isDark }: { isDark: boolean }) {
  return (
    <View style={styles.typingRow}>
      <View style={[styles.typingBubble, isDark ? styles.typingBubbleDark : styles.typingBubbleLight]}>
        <ActivityIndicator size="small" color="#6B7280" />
        <Text style={styles.typingText}>Thinking...</Text>
      </View>
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

  safe: { flex: 1 },
  safeLight: { backgroundColor: '#FFFFFF' },
  safeDark: { backgroundColor: '#09090B' },

  textLight: { color: '#111827' },
  textDark: { color: '#F9FAFB' },

  // ── Header ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLight: {
    backgroundColor: '#FFFFFF',
    borderBottomColor: '#E5E7EB',
  },
  headerDark: {
    backgroundColor: '#09090B',
    borderBottomColor: '#27272A',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  clearButton: {
    fontSize: 14,
    color: '#0a7ea4',
    fontWeight: '500',
  },

  // ── Message list ──
  listContent: {
    paddingVertical: 12,
    flexGrow: 1,
  },

  // ── Empty state ──
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyHintBold: {
    fontWeight: '600',
    color: '#0a7ea4',
  },

  // ── Typing indicator ──
  typingRow: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  typingBubbleLight: { backgroundColor: '#F3F4F6' },
  typingBubbleDark: { backgroundColor: '#27272A' },
  typingText: {
    fontSize: 14,
    color: '#6B7280',
  },

  // ── Error banner ──
  errorBanner: {
    marginHorizontal: 12,
    marginVertical: 4,
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: {
    fontSize: 13,
    color: '#991B1B',
  },
});
