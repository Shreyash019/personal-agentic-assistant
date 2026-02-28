import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import type { ToolCallPart, ToolResultPart } from '@/hooks/use-sse-chat';

type Props = { part: ToolCallPart | ToolResultPart };

/**
 * Renders a compact status card for tool_call and tool_result parts.
 *
 *   tool_call   → pulsing amber card  "Executing Task..."
 *   tool_result → green card  "Task created · ID: <id>"
 *               → red card   "Task failed · <error_msg>"
 */
export function ToolStatus({ part }: Props) {
  if (part.kind === 'tool_call') {
    return <ExecutingCard tool={part.tool} />;
  }

  const success = part.status === 'success';

  return (
    <View style={[styles.card, success ? styles.cardSuccess : styles.cardError]}>
      <Text style={styles.icon}>{success ? '✓' : '✕'}</Text>
      <View style={styles.textBlock}>
        <Text style={[styles.label, success ? styles.labelSuccess : styles.labelError]}>
          {success ? 'Task created' : 'Task failed'}
        </Text>
        {success && part.taskId ? (
          <Text style={styles.sub}>ID: {part.taskId}</Text>
        ) : null}
        {!success && part.errorMsg ? (
          <Text style={styles.sub}>{part.errorMsg}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Executing indicator ───────────────────────────────────────────────────────

function ExecutingCard({ tool }: { tool: string }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 650,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 650,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View style={[styles.card, styles.cardExecuting, { opacity }]}>
      <Text style={styles.icon}>⚙</Text>
      <View style={styles.textBlock}>
        <Text style={[styles.label, styles.labelExecuting]}>Executing Task...</Text>
        <Text style={styles.sub}>{tool}</Text>
      </View>
    </Animated.View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  cardExecuting: {
    backgroundColor: '#FEF3C7', // amber-50
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  cardSuccess: {
    backgroundColor: '#DCFCE7', // green-100
    borderWidth: 1,
    borderColor: '#16A34A',
  },
  cardError: {
    backgroundColor: '#FEE2E2', // red-100
    borderWidth: 1,
    borderColor: '#DC2626',
  },
  icon: {
    fontSize: 16,
  },
  textBlock: {
    flexShrink: 1,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  labelExecuting: {
    color: '#92400E', // amber-800
  },
  labelSuccess: {
    color: '#166534', // green-800
  },
  labelError: {
    color: '#991B1B', // red-800
  },
  sub: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 1,
  },
});
