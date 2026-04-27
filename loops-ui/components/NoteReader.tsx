'use client';

// NoteReader — generic full-page reader/editor for any markdown file
// in the vault. Opened from VaultBrowser. Read-mode renders via the
// shared renderMarkdown; Edit-mode swaps in MarkdownEditor.

import { useCallback, useEffect, useRef, useState } from 'react';
import { renderMarkdown } from '@/lib/renderMarkdown';
import { MarkdownEditor } from '@/components/MarkdownEditor';

interface NoteReaderProps {
  filePath: string;
  onClose: () => void;
  onSaved?: () => void;
  // When the user clicks a wikilink that resolves to another vault
  // file, the parent decides what to do (typically: navigate this
  // reader to the new path).
  onNavigate?: (filePath: string) => void;
}

interface Backlink {
  path: string;
  excerpt: string;
}

export function NoteReader({
  filePath,
  onClose,
  onSaved,
  onNavigate,
}: NoteReaderProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Default mode is `edit` — clicking a note drops you straight onto
  // a cursor. Switch to `preview` from the toolbar when you want
  // rendered output (clickable wikilinks, formatted headings, etc.).
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [editBuffer, setEditBuffer] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  // The path the read endpoint actually resolved for us. May differ
  // from `filePath` when the user clicked a basename-only wikilink.
  // Save + backlinks must use this so writes hit the real file.
  const [resolvedPath, setResolvedPath] = useState(filePath);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch content on mount + when path changes.
  useEffect(() => {
    setLoading(true);
    setContent(null);
    setMode('edit');
    setEditBuffer('');
    setDirty(false);
    setBacklinks(null);
    setResolvedPath(filePath);
    const params = new URLSearchParams({ file: filePath });
    fetch(`/api/vault/read?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const body = data.content || '';
        setContent(body);
        // Populate the buffer immediately so the editor renders the
        // file content the moment the fetch lands.
        setEditBuffer(body);
        setLoading(false);
        // The read API returns the path it actually resolved (may
        // differ from `filePath` for basename-only wikilinks).
        if (data.file && data.file !== filePath) {
          setResolvedPath(data.file);
        }
        scrollRef.current?.scrollTo(0, 0);
      })
      .catch(() => {
        setContent('Failed to load note.');
        setLoading(false);
      });
    // Fire-and-forget backlinks lookup. Slow on large vaults but
    // non-blocking — the panel just appears when ready.
    fetch(`/api/vault/backlinks?${params}`)
      .then((r) => r.json())
      .then((data) => setBacklinks(data.backlinks ?? []))
      .catch(() => setBacklinks([]));
  }, [filePath]);

  // Esc closes — but if the user has unsaved edits, confirm before
  // discarding them. Cheap protection against fat-fingering Esc when
  // they meant ⌘S.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dirty && !window.confirm('Discard unsaved changes?')) return;
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, dirty]);

  const saveEdit = useCallback(async () => {
    setSaving(true);
    try {
      // raw: false → API preserves the existing file's frontmatter
      // (read endpoint stripped it before we saw the buffer).
      // Write to the resolved path so basename-only wikilinks save
      // back into the right folder.
      await fetch('/api/vault/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: resolvedPath, content: editBuffer }),
      });
      setContent(editBuffer);
      setDirty(false);
      onSaved?.();
    } catch {
      console.error('Save failed');
    } finally {
      setSaving(false);
    }
  }, [resolvedPath, editBuffer, onSaved]);

  // Debounced auto-save: 1.2s after the last keystroke, flush the
  // buffer to disk. Plus the editor's onBlur save (below). Means
  // the file is durable without the user ever pressing ⌘S.
  useEffect(() => {
    if (!dirty || mode !== 'edit') return;
    const timer = window.setTimeout(() => {
      void saveEdit();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [editBuffer, dirty, mode, saveEdit]);

  // Wikilink clicks → ask parent to navigate.
  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a[data-vault-link]') as HTMLAnchorElement | null;
      if (link) {
        e.preventDefault();
        const vaultPath = link.getAttribute('data-vault-link');
        if (vaultPath) onNavigate?.(vaultPath);
      }
    },
    [onNavigate],
  );

  const title = filePath.split('/').pop()?.replace(/\.md$/, '') || filePath;

  return (
    <div className="fixed inset-0 z-30 bg-[var(--surface-page)] flex flex-col">
      {/* Header */}
      <div className="px-5 py-3 flex items-center gap-3 border-b border-edge shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-[14px] font-medium text-ink truncate">{title}</h2>
          <div className="text-[10px] text-ink-ghost mt-0.5 truncate font-mono">
            {filePath}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-ink-ghost tabular-nums">
            {saving ? 'saving…' : dirty ? 'unsaved' : 'saved'}
          </span>
          <button
            type="button"
            onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
            className="text-[11px] text-ink-soft hover:text-ink px-2.5 py-1 rounded-md border border-edge hover:border-edge-hover transition-colors"
            title={mode === 'edit' ? 'Render preview' : 'Back to edit'}
          >
            {mode === 'edit' ? 'Preview' : 'Edit'}
          </button>
          <span className="text-[9px] text-ink-ghost ml-1">esc</span>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-ghost hover:text-ink text-[14px] px-1.5 py-0.5 rounded hover:bg-inset"
            title="Close (Esc)"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Body */}
      {mode === 'edit' ? (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle">
          <div className="max-w-[760px] mx-auto px-8 py-10">
            <MarkdownEditor
              value={editBuffer}
              onChange={(next) => {
                setEditBuffer(next);
                setDirty(true);
              }}
              onSave={() => {
                if (dirty) void saveEdit();
              }}
              onBlur={() => {
                // Click-out save — feels like Notion / Obsidian: walk
                // away and the file is on disk.
                if (dirty) void saveEdit();
              }}
              autoFocus
              className="w-full min-h-[calc(100vh-200px)]"
            />
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle"
          onClick={handleContentClick}
        >
          <div className="max-w-[760px] mx-auto px-8 py-8">
            {loading ? (
              <div className="text-[11px] text-ink-ghost animate-pulse">
                Loading...
              </div>
            ) : content ? (
              <div
                className="research-reader"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
            ) : (
              <div className="text-[11px] text-ink-ghost italic">
                Empty note. Click Edit to start writing.
              </div>
            )}

            {/* Backlinks — fire-and-forget; only renders when we have
                results. Quiet by design. */}
            {backlinks && backlinks.length > 0 && (
              <section className="mt-12 pt-6 border-t border-edge">
                <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost mb-3">
                  Linked from {backlinks.length}{' '}
                  {backlinks.length === 1 ? 'note' : 'notes'}
                </div>
                <ul className="flex flex-col gap-2">
                  {backlinks.map((b) => (
                    <li key={b.path}>
                      <button
                        type="button"
                        onClick={() => onNavigate?.(b.path)}
                        className="w-full text-left px-3 py-2 rounded-md hover:bg-inset transition-colors"
                      >
                        <div className="text-[11px] text-ink truncate">
                          {b.path.split('/').pop()?.replace(/\.md$/, '')}
                        </div>
                        <div className="text-[10px] text-ink-ghost truncate font-mono">
                          {b.path}
                        </div>
                        {b.excerpt && (
                          <div className="text-[11px] text-ink-soft mt-1 italic line-clamp-2">
                            {b.excerpt}
                          </div>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
