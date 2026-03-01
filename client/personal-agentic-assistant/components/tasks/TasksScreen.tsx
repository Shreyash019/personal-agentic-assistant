/**
 * TasksScreen — per-user task manager.
 *
 * Fetches tasks from GET /api/v1/tasks?user_id=<uuid>, renders them in a
 * FlatList, and lets the user mark tasks done or delete them.
 *
 * Uses only React Native core primitives — no third-party UI library.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useUserID } from '@/hooks/use-user-id';

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'in_progress' | 'done';
type TaskPriority = 'low' | 'medium' | 'high';

type Task = {
  id: number;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  user_id: string;
  created_at: string;
};

// ── Config ────────────────────────────────────────────────────────────────────

const PHYSICAL_DEVICE_HOST = '192.168.1.15';
const BASE_URL = `http://${PHYSICAL_DEVICE_HOST}:8080`;

// ── TasksScreen ───────────────────────────────────────────────────────────────

export default function TasksScreen() {
  const userID = useUserID();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async (isRefresh = false) => {
    if (!userID) return; // wait until userID is loaded from AsyncStorage
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_URL}/api/v1/tasks?user_id=${encodeURIComponent(userID)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Task[] = await res.json();
      setTasks(data);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load tasks');
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, [userID]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const markDone = useCallback(async (task: Task) => {
    const nextStatus: TaskStatus = task.status === 'done' ? 'pending' : 'done';
    try {
      const res = await fetch(`${BASE_URL}/api/v1/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus, user_id: userID }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)),
      );
    } catch (e: any) {
      setError(e.message ?? 'Failed to update task');
    }
  }, [userID]);

  const deleteTask = useCallback(async (task: Task) => {
    try {
      const res = await fetch(
        `${BASE_URL}/api/v1/tasks/${task.id}?user_id=${encodeURIComponent(userID)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    } catch (e: any) {
      setError(e.message ?? 'Failed to delete task');
    }
  }, [userID]);

  const renderItem = useCallback(
    ({ item }: { item: Task }) => (
      <TaskCard task={item} onToggleDone={markDone} onDelete={deleteTask} />
    ),
    [markDone, deleteTask],
  );

  const keyExtractor = useCallback((item: Task) => String(item.id), []);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#0a7ea4" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Tasks</Text>
        <Pressable onPress={() => fetchTasks(true)} accessibilityRole="button">
          <Text style={styles.refreshBtn}>↻ Refresh</Text>
        </Pressable>
      </View>

      {/* Error banner */}
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠ {error}</Text>
        </View>
      ) : null}

      {/* Task list */}
      {tasks.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>✅</Text>
          <Text style={styles.emptyTitle}>No tasks yet</Text>
          <Text style={styles.emptyHint}>
            Ask the assistant to create a task and it will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchTasks(true)}
              tintColor="#0a7ea4"
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  onToggleDone,
  onDelete,
}: {
  task: Task;
  onToggleDone: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const isDone = task.status === 'done';

  return (
    <View style={[styles.card, isDone && styles.cardDone]}>
      {/* Top row: title + priority badge */}
      <View style={styles.cardTop}>
        <Text style={[styles.cardTitle, isDone && styles.cardTitleDone]} numberOfLines={2}>
          {task.title}
        </Text>
        <PriorityBadge priority={task.priority} />
      </View>

      {/* Description */}
      {task.description ? (
        <Text style={styles.cardDescription} numberOfLines={3}>
          {task.description}
        </Text>
      ) : null}

      {/* Status + date */}
      <View style={styles.cardMeta}>
        <StatusPill status={task.status} />
        <Text style={styles.cardDate}>{formatDate(task.created_at)}</Text>
      </View>

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable
          onPress={() => onToggleDone(task)}
          style={[styles.actionBtn, isDone ? styles.actionBtnUndo : styles.actionBtnDone]}
          accessibilityRole="button"
        >
          <Text style={styles.actionBtnText}>{isDone ? 'Undo' : 'Mark Done'}</Text>
        </Pressable>
        <Pressable
          onPress={() => onDelete(task)}
          style={[styles.actionBtn, styles.actionBtnDelete]}
          accessibilityRole="button"
        >
          <Text style={styles.actionBtnText}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<TaskPriority, { bg: string; text: string }> = {
  low:    { bg: '#DCFCE7', text: '#166534' },
  medium: { bg: '#FEF9C3', text: '#713F12' },
  high:   { bg: '#FEE2E2', text: '#991B1B' },
};

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const colors = PRIORITY_COLORS[priority] ?? PRIORITY_COLORS.medium;
  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.badgeText, { color: colors.text }]}>
        {priority.toUpperCase()}
      </Text>
    </View>
  );
}

const STATUS_COLORS: Record<TaskStatus, { bg: string; text: string }> = {
  pending:     { bg: '#E5E7EB', text: '#374151' },
  in_progress: { bg: '#DBEAFE', text: '#1E40AF' },
  done:        { bg: '#D1FAE5', text: '#065F46' },
};

function StatusPill({ status }: { status: TaskStatus }) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.pending;
  const label = status === 'in_progress' ? 'In Progress' : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View style={[styles.pill, { backgroundColor: colors.bg }]}>
      <Text style={[styles.pillText, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#111827' },
  refreshBtn: { fontSize: 14, color: '#0a7ea4', fontWeight: '500' },

  errorBanner: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: { fontSize: 13, color: '#991B1B' },

  listContent: { padding: 12, gap: 10 },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#111827' },
  emptyHint: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 20 },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardDone: { opacity: 0.65 },

  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#111827' },
  cardTitleDone: { textDecorationLine: 'line-through', color: '#6B7280' },

  cardDescription: { fontSize: 13, color: '#6B7280', lineHeight: 18 },

  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardDate: { fontSize: 12, color: '#9CA3AF', marginLeft: 'auto' },

  cardActions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  actionBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  actionBtnDone:   { backgroundColor: '#0a7ea4' },
  actionBtnUndo:   { backgroundColor: '#6B7280' },
  actionBtnDelete: { backgroundColor: '#EF4444' },
  actionBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },

  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  pillText: { fontSize: 11, fontWeight: '600' },
});
