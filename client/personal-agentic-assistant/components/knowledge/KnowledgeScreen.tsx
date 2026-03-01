/**
 * KnowledgeScreen — document ingestion UI for POST /api/v1/documents.
 *
 * Lets the user add text to the RAG knowledge base in two scopes:
 *   Personal  → visible only to this device (user_id = UUID)
 *   Shared    → visible to all users (user_id = "admin")
 *
 * After submission the server chunks the text (400-char windows, 50-char
 * overlap), embeds each chunk with nomic-embed-text, and upserts into Qdrant.
 * The screen shows how many chunks were created so the user understands the split.
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useIngest, type IngestScope } from '@/hooks/use-ingest';
import { useUserID } from '@/hooks/use-user-id';

// ── Config ────────────────────────────────────────────────────────────────────

const PHYSICAL_DEVICE_HOST = '192.168.1.15';
const BASE_URL = `http://${PHYSICAL_DEVICE_HOST}:8080`;

// ── KnowledgeScreen ───────────────────────────────────────────────────────────

export default function KnowledgeScreen() {
  const userID = useUserID();
  const { ingest, isLoading, result, error, reset } = useIngest(BASE_URL, userID);

  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [scope, setScope] = useState<IngestScope>('personal');

  const handleSubmit = useCallback(async () => {
    if (!text.trim() || !userID) return;
    await ingest(text, source, scope);
    // Clear the text on success so the user can add another document.
    if (!error) {
      setText('');
      setSource('');
    }
  }, [text, source, scope, userID, ingest, error]);

  const handleReset = useCallback(() => {
    reset();
    setText('');
    setSource('');
  }, [reset]);

  const submitDisabled = isLoading || !text.trim() || !userID;
  const charCount = text.length;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Knowledge Base</Text>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Info card ── */}
          <InfoCard />

          {/* ── Scope toggle ── */}
          <View style={styles.section}>
            <Text style={styles.label}>Scope</Text>
            <ScopeToggle value={scope} onChange={setScope} />
            <Text style={styles.scopeHint}>
              {scope === 'personal'
                ? 'Only you can retrieve this content in chat.'
                : 'All users can retrieve this content in chat.'}
            </Text>
          </View>

          {/* ── Source name ── */}
          <View style={styles.section}>
            <Text style={styles.label}>Source name (optional)</Text>
            <TextInput
              value={source}
              onChangeText={setSource}
              placeholder="e.g. about-me.txt, project-notes.md"
              placeholderTextColor="#9CA3AF"
              style={styles.sourceInput}
              editable={!isLoading}
              returnKeyType="next"
            />
          </View>

          {/* ── Content input ── */}
          <View style={styles.section}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>Content</Text>
              <Text style={styles.charCount}>{charCount.toLocaleString()} chars</Text>
            </View>
            <TextInput
              value={text}
              onChangeText={(v) => {
                setText(v);
                if (result || error) reset();
              }}
              placeholder="Paste or type the text you want the assistant to know about…"
              placeholderTextColor="#9CA3AF"
              multiline
              style={styles.textInput}
              editable={!isLoading}
              textAlignVertical="top"
            />
            <Text style={styles.hint}>
              Text is split into ~400-character chunks with 50-character overlap before embedding.
            </Text>
          </View>

          {/* ── Result / Error feedback ── */}
          {result && <SuccessBanner result={result} scope={scope} onDismiss={handleReset} />}
          {error && <ErrorBanner message={error} onDismiss={reset} />}

          {/* ── Submit ── */}
          <Pressable
            onPress={handleSubmit}
            disabled={submitDisabled}
            style={({ pressed }) => [
              styles.submitBtn,
              submitDisabled && styles.submitBtnDisabled,
              pressed && !submitDisabled && styles.submitBtnPressed,
            ]}
            accessibilityRole="button"
          >
            {isLoading ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={[styles.submitBtnText, submitDisabled && styles.submitBtnTextDisabled]}>
                Add to Knowledge Base
              </Text>
            )}
          </Pressable>

          {isLoading && (
            <Text style={styles.loadingNote}>
              Embedding chunks… this may take a few seconds.
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InfoCard() {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoIcon}>💡</Text>
      <Text style={styles.infoText}>
        Text added here is embedded and stored in your local vector store. The assistant retrieves
        it automatically when you use{' '}
        <Text style={styles.infoCode}>RAG mode</Text>
        {' '}in chat (include "knowledge" or "rag" in a system message).
      </Text>
    </View>
  );
}

function ScopeToggle({
  value,
  onChange,
}: {
  value: IngestScope;
  onChange: (s: IngestScope) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Pressable
        onPress={() => onChange('personal')}
        style={[styles.toggleOption, value === 'personal' && styles.toggleOptionActive]}
        accessibilityRole="radio"
      >
        <Text style={[styles.toggleText, value === 'personal' && styles.toggleTextActive]}>
          🔒 Personal
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange('shared')}
        style={[styles.toggleOption, value === 'shared' && styles.toggleOptionActive]}
        accessibilityRole="radio"
      >
        <Text style={[styles.toggleText, value === 'shared' && styles.toggleTextActive]}>
          🌐 Shared
        </Text>
      </Pressable>
    </View>
  );
}

function SuccessBanner({
  result,
  scope,
  onDismiss,
}: {
  result: { chunksIngested: number; source: string };
  scope: IngestScope;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.successBanner}>
      <Text style={styles.successText}>
        ✅ Added {result.chunksIngested} chunk{result.chunksIngested !== 1 ? 's' : ''} from{' '}
        <Text style={styles.successBold}>{result.source}</Text>
        {' '}→ {scope === 'personal' ? 'Personal context' : 'Shared knowledge'}
      </Text>
      <Pressable onPress={onDismiss} style={styles.dismissBtn} accessibilityRole="button">
        <Text style={styles.dismissText}>Add more</Text>
      </Pressable>
    </View>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorText}>⚠ {message}</Text>
      <Pressable onPress={onDismiss} accessibilityRole="button">
        <Text style={styles.dismissText}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#F9FAFB' },

  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#111827' },

  content: { padding: 16, gap: 20, paddingBottom: 40 },

  infoCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  infoIcon: { fontSize: 18 },
  infoText: { flex: 1, fontSize: 13, color: '#1E40AF', lineHeight: 19 },
  infoCode: { fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  section: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', color: '#374151' },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  charCount: { fontSize: 12, color: '#9CA3AF' },

  toggle: {
    flexDirection: 'row',
    backgroundColor: '#E5E7EB',
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  toggleOption: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  toggleOptionActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
  toggleText: { fontSize: 13, fontWeight: '500', color: '#6B7280' },
  toggleTextActive: { color: '#111827', fontWeight: '600' },
  scopeHint: { fontSize: 12, color: '#6B7280' },

  sourceInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
  },

  textInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 14,
    color: '#111827',
    minHeight: 180,
    lineHeight: 20,
  },
  hint: { fontSize: 12, color: '#9CA3AF' },

  successBanner: {
    backgroundColor: '#D1FAE5',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#6EE7B7',
    gap: 8,
  },
  successText: { fontSize: 13, color: '#065F46', lineHeight: 19 },
  successBold: { fontWeight: '700' },
  dismissBtn: { alignSelf: 'flex-start' },
  dismissText: { fontSize: 13, color: '#0a7ea4', fontWeight: '500' },

  errorBanner: {
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    gap: 8,
  },
  errorText: { fontSize: 13, color: '#991B1B', lineHeight: 19 },

  submitBtn: {
    backgroundColor: '#0a7ea4',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitBtnDisabled: { backgroundColor: '#E5E7EB' },
  submitBtnPressed: { opacity: 0.8 },
  submitBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  submitBtnTextDisabled: { color: '#9CA3AF' },

  loadingNote: { fontSize: 12, color: '#6B7280', textAlign: 'center' },
});
