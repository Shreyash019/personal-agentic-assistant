import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type SettingsSection = 'about' | 'privacy';

const ABOUT_TEXT = `Personal Agentic Assistant is a local-first mobile assistant that helps with conversations and task management.

Current capabilities:
• Chat with an assistant over streaming responses
• Create and manage tasks
• Use optional task mode toggle for explicit task actions
• Scope task data by user ID

Version: 1.0.0`;

const PRIVACY_TEXT = `Privacy Policy

1. Data We Store
- Task data you create (title, description, priority, status)
- Chat requests/responses required to deliver assistant features
- Device-generated user ID used for data scoping

2. Storage Location
- Data is stored in your configured local services (Postgres/Qdrant) in development setup.

3. Data Usage
- Data is used only to provide chat, task, and knowledge features.
- No third-party analytics is integrated in this mobile app layer.

4. Control
- You can delete tasks from the app.
- You can reset local infrastructure to clear stored data.

5. Contact
- For policy updates, review project documentation and release notes.`;

export default function SettingsScreen() {
  const [selectedSection, setSelectedSection] = useState<SettingsSection | null>(null);

  const content = useMemo(() => {
    if (selectedSection === 'about') {
      return { title: 'ABOUT', body: ABOUT_TEXT };
    }
    if (selectedSection === 'privacy') {
      return { title: 'PRIVACY POLICY', body: PRIVACY_TEXT };
    }
    return null;
  }, [selectedSection]);

  if (content) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => setSelectedSection(null)}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.headerTitle}>{content.title}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.detailContainer}>
          <Text style={styles.detailText}>{content.body}</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <View style={styles.listContainer}>
        <Pressable
          style={styles.listItem}
          onPress={() => setSelectedSection('about')}
          accessibilityRole="button"
        >
          <Text style={styles.listItemTitle}>ABOUT</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          style={styles.listItem}
          onPress={() => setSelectedSection('privacy')}
          accessibilityRole="button"
        >
          <Text style={styles.listItemTitle}>PRIVACY POLICY</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  headerSpacer: {
    width: 48,
  },
  backText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  listContainer: {
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 8,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  listItemTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    letterSpacing: 0.3,
  },
  chevron: {
    fontSize: 20,
    color: '#9CA3AF',
    lineHeight: 20,
  },
  detailContainer: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  detailText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#374151',
  },
});
