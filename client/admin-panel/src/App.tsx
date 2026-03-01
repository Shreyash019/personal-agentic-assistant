import React, { useEffect, useRef, useState } from 'react';
import { uploadDoc } from './api';
import { useDocs } from './hooks/useDocs';
import { useToast } from './hooks/useToast';
import type { ToastItem } from './hooks/useToast';
import type { AdminDoc, IngestResult, UpdateResult } from './types';

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  accent:        '#0a7ea4',
  accentLight:   '#EFF6FF',
  danger:        '#DC2626',
  surface:       '#FFFFFF',
  bg:            '#F3F4F6',
  bgMuted:       '#F9FAFB',
  border:        '#E5E7EB',
  textPrimary:   '#111827',
  textSecondary: '#6B7280',
  textMuted:     '#9CA3AF',
  success:       '#065F46',
  successBg:     '#D1FAE5',
  successBorder: '#6EE7B7',
  errorBg:       '#FEE2E2',
  errorBorder:   '#FCA5A5',
  errorText:     '#991B1B',
  warnBg:        '#FFFBEB',
  warnBorder:    '#FCD34D',
  warnText:      '#92400E',
} as const;

type HealthStatus = 'checking' | 'online' | 'offline';

// ── App ────────────────────────────────────────────────────────────────────────

export default function App() {
  const { docs, loading, error, totalChunks, refresh, remove, update } = useDocs();
  const { toasts, toast, dismiss } = useToast();
  const [health, setHealth] = useState<HealthStatus>('checking');

  // Health check on mount — re-check when user clicks refresh.
  useEffect(() => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    fetch('http://localhost:8080/health', { signal: ctrl.signal })
      .then(r => setHealth(r.ok ? 'online' : 'offline'))
      .catch(() => setHealth('offline'))
      .finally(() => clearTimeout(timeout));
    return () => { ctrl.abort(); clearTimeout(timeout); };
  }, []);

  const isOffline = health === 'offline';

  function handleUploadSuccess(result: IngestResult) {
    toast('success', `Ingested ${result.chunks_ingested} chunk(s) from "${result.source}"`);
    void refresh();
  }

  async function handleDelete(source: string) {
    await remove(source);
    toast('success', `"${source}" removed from knowledge base`);
  }

  async function handleUpdate(
    oldSource: string,
    text: string,
    newSource: string,
  ): Promise<UpdateResult> {
    const result = await update(oldSource, text, newSource);
    toast('success', `"${result.source}" updated — ${result.chunks_ingested} chunk(s)`);
    return result;
  }

  return (
    <div style={s.root}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div>
            <h1 style={s.headerTitle}>Knowledge Base — Admin Panel</h1>
            <p style={s.headerSub}>
              Upload topic files to define the assistant's knowledge boundary.
              The assistant answers <em>only</em> from content uploaded here.
            </p>
          </div>
          <ConnectionPill status={health} />
        </div>
      </header>

      {/* ── Offline banner ── */}
      {isOffline && (
        <div style={s.offlineBanner} role="alert">
          <span style={{ fontSize: 16 }}>⚠</span>
          <span style={s.offlineBannerText}>
            System is offline. Start the Go server and refresh the page to continue.
          </span>
        </div>
      )}

      <main style={s.main}>
        {/* Stats */}
        <StatsBar docCount={docs.length} chunkCount={totalChunks} loading={loading} />

        {/* Upload */}
        <section style={s.card}>
          <h2 style={s.sectionTitle}>Upload Document</h2>
          <UploadForm
            isOffline={isOffline}
            onSuccess={handleUploadSuccess}
            onError={msg => toast('error', msg)}
          />
        </section>

        {/* Document list */}
        <section style={s.card}>
          {error
            ? <InlineBanner kind="error" message="Could not load documents. Check that the backend is running." />
            : <DocumentList
                docs={docs}
                loading={loading}
                isOffline={isOffline}
                onRefresh={() => void refresh()}
                onDelete={handleDelete}
                onUpdate={handleUpdate}
              />
          }
        </section>
      </main>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

// ── ConnectionPill ─────────────────────────────────────────────────────────────

function ConnectionPill({ status }: { status: HealthStatus }) {
  const dot   = status === 'online' ? '#10B981' : status === 'offline' ? '#EF4444' : '#F59E0B';
  const label = status === 'online' ? 'Backend online' : status === 'offline' ? 'Backend offline' : 'Connecting…';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: C.textSecondary, whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

// ── StatsBar ───────────────────────────────────────────────────────────────────

function StatsBar({
  docCount,
  chunkCount,
  loading,
}: {
  docCount: number;
  chunkCount: number;
  loading: boolean;
}) {
  const stats = [
    { label: 'Documents',       value: loading ? '—' : String(docCount),  icon: '📄' },
    { label: 'Total Chunks',    value: loading ? '—' : String(chunkCount), icon: '🔷' },
    { label: 'Embedding Model', value: 'nomic-embed-text',                  icon: '🤖' },
  ];

  return (
    <div style={s.statsBar}>
      {stats.map(st => (
        <div key={st.label} style={s.statCard}>
          <span style={s.statIcon}>{st.icon}</span>
          <div>
            <p style={s.statValue}>{st.value}</p>
            <p style={s.statLabel}>{st.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── UploadForm ─────────────────────────────────────────────────────────────────

type UploadMode = 'file' | 'paste';

function UploadForm({
  isOffline,
  onSuccess,
  onError,
}: {
  isOffline: boolean;
  onSuccess: (r: IngestResult) => void;
  onError: (msg: string) => void;
}) {
  const [mode, setMode] = useState<UploadMode>('file');
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fileLoaded, setFileLoaded] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const disabled = uploading || isOffline || !source.trim() || !text.trim();

  function loadFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'txt' && ext !== 'md') {
      onError('Only .txt and .md files are supported');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const content = (e.target?.result as string) ?? '';
      setText(content);
      if (!source.trim()) setSource(file.name);
      setFileLoaded(file.name);
    };
    reader.readAsText(file);
  }

  function clearFile() {
    setText('');
    setSource('');
    setFileLoaded(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (isOffline) return;
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setUploading(true);
    try {
      const result = await uploadDoc(text, source.trim());
      onSuccess(result);
      setSource('');
      setText('');
      setFileLoaded(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      onError('Upload failed. Please check the backend is running.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={s.form}>
      {/* Mode tabs */}
      <div style={s.tabs}>
        {(['file', 'paste'] as UploadMode[]).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            disabled={isOffline}
            style={{
              ...s.tab,
              ...(mode === m ? s.tabActive : {}),
              ...(isOffline ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
            }}
          >
            {m === 'file' ? '📎 Upload File' : '✏️ Paste Text'}
          </button>
        ))}
      </div>

      {/* File drop zone */}
      {mode === 'file' && (
        <div
          onDragOver={e => { e.preventDefault(); if (!isOffline) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => !fileLoaded && !isOffline && fileInputRef.current?.click()}
          style={{
            ...s.dropZone,
            borderColor: dragging ? C.accent : C.border,
            background: dragging ? C.accentLight : C.bgMuted,
            cursor: isOffline ? 'not-allowed' : fileLoaded ? 'default' : 'pointer',
            opacity: isOffline ? 0.5 : 1,
          }}
        >
          {fileLoaded ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>✅</span>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.success }}>{fileLoaded}</p>
                  <p style={{ margin: 0, fontSize: 12, color: C.textMuted }}>
                    {text.length.toLocaleString()} chars loaded
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); clearFile(); }}
                style={{ ...s.btn, ...s.btnOutline, padding: '5px 12px', fontSize: 12 }}
              >
                Clear
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <p style={{ margin: '0 0 4px', fontSize: 28 }}>📁</p>
              <p style={{ margin: '0 0 6px', fontSize: 14, color: C.textSecondary, fontWeight: 500 }}>
                Drop a .txt or .md file here
              </p>
              <p style={{ margin: '0 0 12px', fontSize: 12, color: C.textMuted }}>or</p>
              <button
                type="button"
                style={{ ...s.btn, ...(isOffline ? s.btnDisabled : s.btnOutline) }}
                disabled={isOffline}
                onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
              >
                Browse files
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) loadFile(file);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {/* Paste textarea */}
      {mode === 'paste' && (
        <div style={s.fieldGroup}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label style={s.label}>Content <span style={{ color: C.danger }}>*</span></label>
            <span style={s.charCount}>{text.length.toLocaleString()} chars</span>
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste the topic content here."
            style={s.textarea}
            disabled={uploading || isOffline}
            rows={10}
          />
          <span style={s.hint}>Text is split into ~400-char chunks with 50-char overlap before embedding.</span>
        </div>
      )}

      {/* Source name */}
      <div style={s.fieldGroup}>
        <label style={s.label}>Source name <span style={{ color: C.danger }}>*</span></label>
        <input
          value={source}
          onChange={e => setSource(e.target.value)}
          placeholder="e.g. pricing.md, refund-policy.txt"
          style={{ ...s.input, ...(isOffline ? { opacity: 0.5 } : {}) }}
          disabled={uploading || isOffline}
        />
        <span style={s.hint}>Used to identify and manage this document later.</span>
      </div>

      <button
        type="submit"
        style={{ ...s.btn, ...s.btnPrimary, ...(disabled ? s.btnDisabled : {}), alignSelf: 'flex-start' }}
        disabled={disabled}
        title={isOffline ? 'System is offline' : undefined}
      >
        {uploading ? 'Uploading…' : 'Add to Knowledge Base'}
      </button>
    </form>
  );
}

// ── DocumentList ───────────────────────────────────────────────────────────────

function DocumentList({
  docs,
  loading,
  isOffline,
  onRefresh,
  onDelete,
  onUpdate,
}: {
  docs: AdminDoc[];
  loading: boolean;
  isOffline: boolean;
  onRefresh: () => void;
  onDelete: (source: string) => Promise<void>;
  onUpdate: (oldSource: string, text: string, newSource: string) => Promise<UpdateResult>;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<AdminDoc | null>(null);

  const filtered = query.trim()
    ? docs.filter(d => d.source.toLowerCase().includes(query.toLowerCase()))
    : docs;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ ...s.sectionTitle, margin: 0, flex: 1 }}>
          Uploaded Topics
          {!loading && <span style={s.badge}>{docs.length}</span>}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.textMuted, fontSize: 13, pointerEvents: 'none' }}>
              🔍
            </span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter by name…"
              style={{ ...s.input, padding: '7px 10px 7px 30px', width: 180, fontSize: 13 }}
              disabled={isOffline}
            />
          </div>
          <button
            style={{ ...s.btn, ...(loading || isOffline ? s.btnDisabled : s.btnOutline), gap: 4 }}
            onClick={onRefresh}
            disabled={loading || isOffline}
            title={isOffline ? 'System is offline' : 'Refresh list'}
          >
            ↺ {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : docs.length === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <p style={s.emptyMsg}>
          No documents match "{query}".{' '}
          <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 13, padding: 0 }}>
            Clear filter
          </button>
        </p>
      ) : (
        <div>
          {filtered.map((doc, idx) => (
            <DocCard
              key={doc.source}
              doc={doc}
              isLast={idx === filtered.length - 1}
              isOffline={isOffline}
              onEdit={() => setEditing(doc)}
              onDelete={() => onDelete(doc.source)}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditModal
          doc={editing}
          isOffline={isOffline}
          onClose={() => setEditing(null)}
          onSaved={result => { setEditing(null); return result; }}
          onUpdate={onUpdate}
        />
      )}
    </>
  );
}

// ── DocCard ────────────────────────────────────────────────────────────────────

function DocCard({
  doc,
  isLast,
  isOffline,
  onEdit,
  onDelete,
}: {
  doc: AdminDoc;
  isLast: boolean;
  isOffline: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch {
      setDeleteError('Something went wrong. Please try again.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const actionsDisabled = deleting || isOffline;

  return (
    <div style={{ borderBottom: isLast ? 'none' : `1px solid ${C.border}`, padding: '16px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          style={{ ...s.btn, padding: '2px 6px', background: 'none', border: 'none', color: C.textMuted, fontSize: 12, flexShrink: 0 }}
        >
          {expanded ? '▼' : '▶'}
        </button>

        <span style={{ fontWeight: 600, fontSize: 14, color: C.textPrimary, fontFamily: 'monospace', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.source}
        </span>

        <span style={s.chunkBadge}>
          {doc.chunk_count} chunk{doc.chunk_count !== 1 ? 's' : ''}
        </span>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            style={{ ...s.btn, ...(actionsDisabled ? s.btnDisabled : s.btnOutline), padding: '5px 12px', fontSize: 12 }}
            onClick={onEdit}
            disabled={actionsDisabled}
            title={isOffline ? 'System is offline' : 'Edit document'}
          >
            ✏️ Edit
          </button>
          {confirmDelete ? (
            <>
              <button
                style={{ ...s.btn, ...(actionsDisabled ? s.btnDisabled : s.btnDanger), padding: '5px 12px', fontSize: 12 }}
                onClick={handleDelete}
                disabled={actionsDisabled}
              >
                {deleting ? 'Deleting…' : 'Confirm?'}
              </button>
              <button
                style={{ ...s.btn, ...s.btnOutline, padding: '5px 12px', fontSize: 12 }}
                onClick={() => setConfirmDelete(false)}
                disabled={actionsDisabled}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              style={{ ...s.btn, ...(actionsDisabled ? s.btnDisabled : s.btnOutlineDanger), padding: '5px 12px', fontSize: 12 }}
              onClick={handleDelete}
              disabled={actionsDisabled}
              title={isOffline ? 'System is offline' : 'Delete document'}
            >
              🗑 Delete
            </button>
          )}
        </div>
      </div>

      {!expanded && (
        <p style={{ margin: '6px 0 0 24px', fontSize: 13, color: C.textSecondary, lineHeight: 1.5 }}>
          {doc.preview}
        </p>
      )}

      {expanded && (
        <div style={{ margin: '10px 0 0 24px', animation: 'expandIn 0.2s ease' }}>
          <pre style={{
            background: C.bgMuted, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '12px 14px', fontSize: 12, lineHeight: 1.6, color: C.textPrimary,
            overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            margin: 0, fontFamily: 'ui-monospace, Menlo, monospace',
          }}>
            {doc.full_text}
          </pre>
        </div>
      )}

      {deleteError && (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: C.danger }}>{deleteError}</p>
      )}
    </div>
  );
}

// ── EditModal ──────────────────────────────────────────────────────────────────

function EditModal({
  doc,
  isOffline,
  onClose,
  onSaved,
  onUpdate,
}: {
  doc: AdminDoc;
  isOffline: boolean;
  onClose: () => void;
  onSaved: (result: UpdateResult) => UpdateResult;
  onUpdate: (oldSource: string, text: string, newSource: string) => Promise<UpdateResult>;
}) {
  const [source, setSource] = useState(doc.source);
  const [text, setText] = useState(doc.full_text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current && !saving) onClose();
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || isOffline) return;
    setSaving(true);
    setError(null);
    try {
      const result = await onUpdate(doc.source, text, source.trim() || doc.source);
      onSaved(result);
    } catch {
      setError('Save failed. Please check the backend is running.');
      setSaving(false);
    }
  }

  const hasChanges = text !== doc.full_text || source !== doc.source;
  const saveDisabled = !text.trim() || saving || !hasChanges || isOffline;

  return (
    <div ref={backdropRef} style={s.backdrop} onClick={handleBackdropClick}>
      <div style={s.modal} role="dialog" aria-modal="true" aria-label="Edit document">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.textPrimary }}>
              Edit Document
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: C.textMuted }}>
              ESC to close · Saving replaces {doc.chunk_count} existing chunk{doc.chunk_count !== 1 ? 's' : ''}
            </p>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close" disabled={saving}>✕</button>
        </div>

        {isOffline && (
          <div style={{ background: C.warnBg, border: `1px solid ${C.warnBorder}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }} role="alert">
            <span>⚠</span>
            <span style={{ fontSize: 13, color: C.warnText }}>System is offline — changes cannot be saved.</span>
          </div>
        )}

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={s.fieldGroup}>
            <label style={s.label}>Source name</label>
            <input value={source} onChange={e => setSource(e.target.value)} style={s.input} disabled={saving || isOffline} />
          </div>

          <div style={s.fieldGroup}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={s.label}>Content</label>
              <span style={s.charCount}>{text.length.toLocaleString()} chars</span>
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              style={{ ...s.textarea, minHeight: 320, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
              disabled={saving || isOffline}
              rows={16}
            />
            <span style={s.hint}>
              All {doc.chunk_count} existing chunks will be deleted and the updated text re-embedded.
            </span>
          </div>

          {hasChanges && !saving && !isOffline && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.warnText }}>
              <span>⚠</span><span>You have unsaved changes</span>
            </div>
          )}

          {error && <InlineBanner kind="error" message={error} />}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" style={{ ...s.btn, ...s.btnOutline }} onClick={onClose} disabled={saving}>Cancel</button>
            <button
              type="submit"
              style={{ ...s.btn, ...s.btnPrimary, ...(saveDisabled ? s.btnDisabled : {}) }}
              disabled={saveDisabled}
              title={isOffline ? 'System is offline' : undefined}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── ToastContainer ─────────────────────────────────────────────────────────────

function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 300, display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none' }}>
      {toasts.map(t => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: t.kind === 'success' ? '#065F46' : '#7F1D1D', color: '#fff', borderRadius: 10, padding: '12px 16px', fontSize: 13, fontWeight: 500, boxShadow: '0 4px 24px rgba(0,0,0,0.22)', minWidth: 280, maxWidth: 420, animation: 'toastIn 0.25s ease', pointerEvents: 'all' }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>{t.kind === 'success' ? '✓' : '✕'}</span>
          <span style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 16, padding: 0, flexShrink: 0, lineHeight: 1 }} aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}

// ── InlineBanner ───────────────────────────────────────────────────────────────

function InlineBanner({ kind, message }: { kind: 'success' | 'error'; message: string }) {
  const ok = kind === 'success';
  return (
    <div style={{ background: ok ? C.successBg : C.errorBg, border: `1px solid ${ok ? C.successBorder : C.errorBorder}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: ok ? C.success : C.errorText, lineHeight: 1.5 }}>
      {message}
    </div>
  );
}

// ── LoadingSkeleton / EmptyState ───────────────────────────────────────────────

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, #E5E7EB 25%, #F3F4F6 50%, #E5E7EB 75%)',
  backgroundSize: '200% 100%',
};

function LoadingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {[1, 2, 3].map(i => (
        <div key={i} style={{ padding: '16px 0', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ ...shimmer, width: 160, height: 14, borderRadius: 6 }} />
            <div style={{ ...shimmer, width: 60, height: 18, borderRadius: 20 }} />
          </div>
          <div style={{ ...shimmer, width: '75%', height: 12, borderRadius: 4 }} />
          <div style={{ ...shimmer, width: '55%', height: 12, borderRadius: 4 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '40px 24px', color: C.textMuted }}>
      <p style={{ fontSize: 40, margin: '0 0 12px' }}>📂</p>
      <p style={{ fontSize: 15, fontWeight: 600, color: C.textSecondary, margin: '0 0 6px' }}>No documents yet</p>
      <p style={{ fontSize: 13, margin: 0, maxWidth: 320, marginInline: 'auto' }}>
        Upload .txt or .md topic files above to build the assistant's knowledge boundary.
      </p>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', background: C.bg },

  header: { background: C.surface, borderBottom: `1px solid ${C.border}`, padding: '16px 24px', position: 'sticky', top: 0, zIndex: 10 },
  headerInner: { maxWidth: 900, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 },
  headerTitle: { margin: 0, fontSize: 20, fontWeight: 700, color: C.textPrimary },
  headerSub: { margin: '3px 0 0', fontSize: 13, color: C.textSecondary, maxWidth: 560 },

  offlineBanner: { background: C.warnBg, borderBottom: `1px solid ${C.warnBorder}`, padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 73, zIndex: 9 },
  offlineBannerText: { fontSize: 13, fontWeight: 500, color: C.warnText },

  main: { maxWidth: 900, margin: '0 auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: 24 },

  statsBar: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 },
  statCard: { background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 },
  statIcon: { fontSize: 22, flexShrink: 0 },
  statValue: { margin: 0, fontSize: 20, fontWeight: 700, color: C.textPrimary, lineHeight: 1.2 },
  statLabel: { margin: 0, fontSize: 12, color: C.textMuted, marginTop: 2 },

  card: { background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`, padding: 24 },
  sectionTitle: { margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: C.textPrimary, display: 'flex', alignItems: 'center', gap: 8 },
  badge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.accent, color: '#fff', borderRadius: 20, fontSize: 11, fontWeight: 600, minWidth: 20, height: 20, padding: '0 6px' },

  tabs: { display: 'flex', gap: 4, background: '#F3F4F6', borderRadius: 10, padding: 4, marginBottom: 4, width: 'fit-content' },
  tab: { padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: 'none', background: 'transparent', color: C.textSecondary, transition: 'all 0.15s' },
  tabActive: { background: C.surface, color: C.textPrimary, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' },

  dropZone: { border: `2px dashed ${C.border}`, borderRadius: 10, padding: '28px 20px', transition: 'all 0.15s', marginBottom: 4 },

  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: C.textPrimary },
  hint: { fontSize: 12, color: C.textMuted },
  charCount: { fontSize: 12, color: C.textMuted },
  emptyMsg: { color: C.textMuted, fontSize: 14, textAlign: 'center', padding: '24px 0', margin: 0 },

  input: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 14, color: C.textPrimary, outline: 'none', width: '100%', background: C.surface },
  textarea: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, color: C.textPrimary, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.6, width: '100%', background: C.surface },

  btn: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: 'none', transition: 'all 0.15s', whiteSpace: 'nowrap', flexShrink: 0 },
  btnPrimary: { background: C.accent, color: '#fff' },
  btnDisabled: { background: '#E5E7EB', color: C.textMuted, cursor: 'not-allowed' },
  btnOutline: { background: 'transparent', border: `1px solid ${C.border}`, color: C.textPrimary },
  btnDanger: { background: C.danger, color: '#fff' },
  btnOutlineDanger: { background: 'transparent', border: `1px solid ${C.danger}`, color: C.danger },

  chunkBadge: { fontSize: 11, fontWeight: 500, background: '#EFF6FF', color: '#1E40AF', border: '1px solid #BFDBFE', borderRadius: 20, padding: '2px 8px', flexShrink: 0 },

  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 24, animation: 'fadeIn 0.15s ease' },
  modal: { background: C.surface, borderRadius: 16, padding: 28, width: '100%', maxWidth: 700, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.28)' },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.textSecondary, padding: 4, lineHeight: 1, flexShrink: 0 },
};
