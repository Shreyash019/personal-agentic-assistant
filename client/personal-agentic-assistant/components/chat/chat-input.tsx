import { useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputKeyPressEventData,
  type NativeSyntheticEvent,
} from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import type { ChatMode } from '@/hooks/use-sse-chat';

type Props = {
  onSend: (query: string, mode: ChatMode) => void;
  disabled: boolean;
};

/**
 * Input bar at the bottom of the chat screen.
 *
 * - TextInput (multiline, max 5 rows)
 * - Mode pill toggle: Agent | RAG
 * - Send button (disabled while streaming or input is empty)
 */
export function ChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ChatMode>('agent');
  const inputRef = useRef<TextInput>(null);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, mode);
    setText('');
  }

  // Allow Cmd/Ctrl+Enter to submit on web / desktop simulators.
  function handleKeyPress(e: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    if (e.nativeEvent.key === 'Enter') {
      handleSend();
    }
  }

  const sendDisabled = disabled || !text.trim();

  return (
    <View style={[styles.container, isDark ? styles.containerDark : styles.containerLight]}>
      {/* ── Mode toggle ── */}
      <View style={styles.modeRow}>
        {(['agent', 'rag'] as ChatMode[]).map((m) => (
          <Pressable
            key={m}
            onPress={() => setMode(m)}
            style={[styles.modePill, mode === m && styles.modePillActive]}
          >
            <Text style={[styles.modePillText, mode === m && styles.modePillTextActive]}>
              {m === 'agent' ? 'Agent' : 'RAG'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Input row ── */}
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          onKeyPress={handleKeyPress}
          placeholder={mode === 'agent' ? 'Create a task...' : 'Ask your knowledge base...'}
          placeholderTextColor={isDark ? '#6B7280' : '#9CA3AF'}
          multiline
          numberOfLines={1}
          // Constrain height growth: 1 line ≈ 22 px, cap at 5 lines.
          style={[
            styles.input,
            isDark ? styles.inputDark : styles.inputLight,
            { maxHeight: 22 * 5 + 24 }, // 5 lines + vertical padding
          ]}
          editable={!disabled}
          returnKeyType="send"
          blurOnSubmit={false}
        />

        <Pressable
          onPress={handleSend}
          disabled={sendDisabled}
          style={({ pressed }) => [
            styles.sendButton,
            sendDisabled && styles.sendButtonDisabled,
            pressed && !sendDisabled && styles.sendButtonPressed,
          ]}
          accessibilityLabel="Send message"
          accessibilityRole="button"
        >
          <Text style={[styles.sendIcon, sendDisabled && styles.sendIconDisabled]}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  containerLight: {
    backgroundColor: '#FFFFFF',
    borderTopColor: '#E5E7EB',
  },
  containerDark: {
    backgroundColor: '#18181B',
    borderTopColor: '#3F3F46',
  },

  // ── Mode toggle ──
  modeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  modePill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  modePillActive: {
    backgroundColor: '#0a7ea4',
    borderColor: '#0a7ea4',
  },
  modePillText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6B7280',
  },
  modePillTextActive: {
    color: '#FFFFFF',
  },

  // ── Input row ──
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 22,
  },
  inputLight: {
    backgroundColor: '#F9FAFB',
    borderColor: '#D1D5DB',
    color: '#111827',
  },
  inputDark: {
    backgroundColor: '#27272A',
    borderColor: '#3F3F46',
    color: '#F9FAFB',
  },

  // ── Send button ──
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0a7ea4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#E5E7EB',
  },
  sendButtonPressed: {
    opacity: 0.75,
  },
  sendIcon: {
    fontSize: 18,
    color: '#FFFFFF',
    fontWeight: '700',
    lineHeight: 22,
  },
  sendIconDisabled: {
    color: '#9CA3AF',
  },
});
