import { StyleSheet, Text, View } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import type { AssistantMessage, ChatMessage, TextPart, UserMessage } from '@/hooks/use-sse-chat';
import { ToolStatus } from './tool-status';

type Props = { message: ChatMessage };

/**
 * Renders one chat turn.
 *
 *   user      → right-aligned blue bubble
 *   assistant → left-aligned, maps over parts:
 *                 TextPart      → inline prose text
 *                 ToolCallPart  → <ToolStatus> executing card
 *                 ToolResultPart→ <ToolStatus> result card
 */
export function MessageBubble({ message }: Props) {
  if (message.role === 'user') {
    return <UserBubble message={message} />;
  }
  return <AssistantBubble message={message} />;
}

// ── User bubble ───────────────────────────────────────────────────────────────

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{message.text}</Text>
      </View>
    </View>
  );
}

// ── Assistant bubble ──────────────────────────────────────────────────────────

function AssistantBubble({ message }: { message: AssistantMessage }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  // Collect consecutive TextParts so they render as a single block of prose,
  // while ToolCall / ToolResult parts remain as discrete cards.
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];

    if (part.kind === 'text') {
      // Merge adjacent text parts into one Text node.
      let combined = part.content;
      while (i + 1 < message.parts.length && message.parts[i + 1].kind === 'text') {
        i++;
        combined += (message.parts[i] as TextPart).content;
      }
      if (combined) {
        nodes.push(
          <Text
            key={`text-${i}`}
            style={[styles.assistantText, isDark ? styles.assistantTextDark : styles.assistantTextLight]}
          >
            {combined}
          </Text>,
        );
      }
    } else {
      // ToolCallPart or ToolResultPart
      nodes.push(<ToolStatus key={`tool-${i}`} part={part} />);
    }
  }

  if (nodes.length === 0) return null;

  return (
    <View style={styles.assistantRow}>
      <View
        style={[
          styles.assistantBubble,
          isDark ? styles.assistantBubbleDark : styles.assistantBubbleLight,
        ]}
      >
        {nodes}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── user ──
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

  // ── assistant ──
  assistantRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  assistantBubble: {
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '85%',
  },
  assistantBubbleLight: {
    backgroundColor: '#F3F4F6',
  },
  assistantBubbleDark: {
    backgroundColor: '#27272A',
  },
  assistantText: {
    fontSize: 15,
    lineHeight: 22,
  },
  assistantTextLight: {
    color: '#111827',
  },
  assistantTextDark: {
    color: '#F9FAFB',
  },
});
