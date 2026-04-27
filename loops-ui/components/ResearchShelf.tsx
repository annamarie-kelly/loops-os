'use client';

// ResearchShelf — Mission Control surface for vault research docs.
// Cards grouped by category with staleness indicators, filter chips,
// and a "Promote to spec" action. Clicking a card opens a reader
// panel showing the full markdown content.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResearchCategory, ResearchDoc } from '@/lib/types';
import { renderMarkdown, escapeHtml, inlineFormat } from '@/lib/renderMarkdown';
import { obsidianUrl } from '@/lib/ui';
import { MarkdownEditor, invalidateVaultFileCache } from '@/components/MarkdownEditor';

const CATEGORY_META: Record<
  ResearchCategory,
  { label: string; order: number }
> = {
  'strategic-research': { label: 'Strategic Research', order: 0 },
  'technical-investigation': { label: 'Technical Investigation', order: 1 },
  'design-research': { label: 'Design Research', order: 2 },
  foundational: { label: 'Foundational', order: 3 },
  artifact: { label: 'Artifacts', order: 4 },
};

function staleTone(days: number): string {
  if (days <= 14) return 'bg-sage-fill text-sage-text';
  if (days <= 30) return 'bg-tan-fill text-tan-text';
  return 'bg-rose-fill text-rose-text';
}

function staleLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Components ───────────────────────────────────────────────────

export function ResearchShelf({
  docs,
  onSwitchToDesign,
  onArtifactViaChat,
  onFocusViaChat,
}: {
  docs: ResearchDoc[];
  onSwitchToDesign?: () => void;
  onArtifactViaChat?: (doc: ResearchDoc) => void;
  onFocusViaChat?: (doc: ResearchDoc) => void;
}) {
  const [promoting, setPromoting] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<ResearchCategory>>(
    new Set(),
  );
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    return new Set(docs.filter((d) => d.favorite).map((d) => d.id));
  });
  const [openDoc, setOpenDoc] = useState<ResearchDoc | null>(null);
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  // Split ratio: percentage of width for the card grid (left pane).
  // 100 = reader closed, 50 = even split, 20 = mostly reader.
  const [splitPct, setSplitPct] = useState(25);

  // Give HTML artifacts more room
  useEffect(() => {
    if (openDoc?.isHtml) setSplitPct(15);
    else if (openDoc) setSplitPct(25);
  }, [openDoc?.id, openDoc?.isHtml]);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Sync favorites from doc data when docs change
  useEffect(() => {
    setFavorites(new Set(docs.filter((d) => d.favorite).map((d) => d.id)));
  }, [docs]);

  const promoteToSpec = useCallback(async (doc: ResearchDoc) => {
    setPromoting(doc.id);
    try {
      const res = await fetch('/api/vault/specs/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ researchDocPath: doc.filePath }),
      });
      if (res.ok) {
        onSwitchToDesign?.();
      } else {
        const data = await res.json();
        if (res.status === 409) {
          // Spec already exists — just switch to design
          onSwitchToDesign?.();
        } else {
          console.error('Scaffold failed:', data.error);
        }
      }
    } catch (err) {
      console.error('Scaffold error:', err);
    } finally {
      setPromoting(null);
    }
  }, [onSwitchToDesign]);

  const toggleFavorite = useCallback(async (doc: ResearchDoc) => {
    const newVal = !favorites.has(doc.id);
    // Optimistic update
    setFavorites((prev) => {
      const next = new Set(prev);
      if (newVal) next.add(doc.id);
      else next.delete(doc.id);
      return next;
    });
    try {
      await fetch('/api/vault/research', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: doc.filePath, favorite: newVal }),
      });
    } catch {
      // Revert on failure
      setFavorites((prev) => {
        const next = new Set(prev);
        if (newVal) next.delete(doc.id);
        else next.add(doc.id);
        return next;
      });
    }
  }, [favorites]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      // Clamp: min 15% for cards, min 20% for reader
      setSplitPct(Math.max(15, Math.min(80, pct)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const toggleFilter = (cat: ResearchCategory) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const filtered = useMemo(() => {
    let result = docs;
    if (activeFilters.size > 0) {
      result = result.filter((d) => activeFilters.has(d.category));
    }
    if (showFavoritesOnly) {
      result = result.filter((d) => favorites.has(d.id));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.summary.toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [docs, activeFilters, showFavoritesOnly, favorites, searchQuery]);

  const grouped = useMemo(() => {
    const groups = new Map<ResearchCategory, ResearchDoc[]>();
    for (const doc of filtered) {
      const existing = groups.get(doc.category) || [];
      existing.push(doc);
      groups.set(doc.category, existing);
    }
    return Array.from(groups.entries()).sort(
      ([a], [b]) =>
        CATEGORY_META[a].order - CATEGORY_META[b].order,
    );
  }, [filtered]);

  const categories = useMemo(() => {
    const cats = new Set<ResearchCategory>();
    for (const doc of docs) cats.add(doc.category);
    return Array.from(cats).sort(
      (a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order,
    );
  }, [docs]);

  const staleCount = useMemo(
    () => docs.filter((d) => d.staleDays > 30).length,
    [docs],
  );

  return (
    <main ref={containerRef} className="flex-1 min-h-0 flex overflow-hidden">
      {/* Card grid */}
      <div
        className="min-h-0 flex flex-col overflow-hidden"
        style={{ width: openDoc ? `${splitPct}%` : '100%', transition: draggingRef.current ? 'none' : 'width 0.2s' }}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-3 flex items-center gap-3 shrink-0">
          <div>
            <h2 className="text-[14px] font-medium text-ink">Research</h2>
            <p className="text-[11px] text-ink-ghost">
              Vault research docs. Promote to spec when ready to build.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-ink-ghost tabular-nums">
              {docs.length} docs
              {staleCount > 0 && (
                <span className="ml-1 text-rose-text">
                  ({staleCount} stale)
                </span>
              )}
            </span>
          </div>
        </div>

        {/* Search + filter bar */}
        <div className="px-5 pb-3 flex flex-col gap-2 shrink-0">
          {/* Search input + Add button */}
          <div className="flex items-center gap-2">
            <div className="relative max-w-[280px]">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search research..."
                className="w-full text-[11px] pl-7 pr-3 py-1.5 rounded-md border border-edge bg-surface text-ink placeholder:text-ink-ghost focus:outline-none focus:border-edge-hover transition-colors"
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-ghost" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6.5" cy="6.5" r="5" />
                <path d="M10.5 10.5L14.5 14.5" strokeLinecap="round" />
              </svg>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-ghost hover:text-ink text-[11px]"
                >
                  &#x2715;
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowNewDoc(true)}
              className="text-[11px] text-ink-soft hover:text-ink px-2.5 py-1.5 rounded-md border border-edge hover:border-edge-hover hover:bg-inset transition-colors shrink-0"
              title="Add research doc — paste markdown from Claude"
            >
              + Add
            </button>
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Favorites filter */}
            <button
              type="button"
              onClick={() => setShowFavoritesOnly((v) => !v)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors flex items-center gap-1 ${
                showFavoritesOnly
                  ? 'bg-[#E0848C]/10 border-[#E0848C]/30 text-[#E0848C]'
                  : 'border-transparent text-ink-ghost hover:text-ink-soft hover:border-edge'
              }`}
            >
              <span className="text-[11px]">{showFavoritesOnly ? '★' : '☆'}</span>
              Favorites
              <span className="tabular-nums">{favorites.size}</span>
            </button>

            <span className="w-px h-3 bg-edge mx-0.5" />

            {/* Category filters */}
            {categories.map((cat) => {
              const active = activeFilters.has(cat);
              const count = docs.filter((d) => d.category === cat).length;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleFilter(cat)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                    active
                      ? 'bg-inset border-edge-hover text-ink'
                      : 'border-transparent text-ink-ghost hover:text-ink-soft hover:border-edge'
                  }`}
                >
                  {CATEGORY_META[cat].label}
                  <span className="ml-1 tabular-nums">{count}</span>
                </button>
              );
            })}
            {(activeFilters.size > 0 || showFavoritesOnly || searchQuery) && (
              <button
                type="button"
                onClick={() => { setActiveFilters(new Set()); setShowFavoritesOnly(false); setSearchQuery(''); }}
                className="text-[10px] text-ink-ghost hover:text-ink-soft ml-1"
              >
                clear all
              </button>
            )}
          </div>
        </div>

        {/* Cards */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5 scrollbar-subtle">
          {grouped.length === 0 ? (
            <div className="pt-10 text-center">
              <div className="text-[12px] text-ink-ghost">No research docs found.</div>
              <div className="text-[11px] text-ink-ghost italic mt-1">
                Click + Add to paste markdown from Claude or another tool.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {grouped.map(([category, categoryDocs]) => (
                <section key={category}>
                  <h3 className="text-[11px] font-medium text-ink-soft uppercase tracking-wider mb-2">
                    {CATEGORY_META[category].label}
                  </h3>
                  <div className={`grid gap-3 ${openDoc && splitPct < 40 ? 'grid-cols-1' : openDoc ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'}`}>
                    {categoryDocs.map((doc) => (
                      <ResearchCard
                        key={doc.id}
                        doc={doc}
                        isActive={openDoc?.id === doc.id}
                        isPromoting={promoting === doc.id}
                        isFavorite={favorites.has(doc.id)}
                        hasArtifact={docs.some((d) => d.isHtml && d.category === 'artifact' && d.title.toLowerCase().includes(doc.title.toLowerCase().split('—')[0].trim().slice(0, 20)))}
                        onOpen={() => setOpenDoc(doc)}
                        onPromote={() => promoteToSpec(doc)}
                        onArtifact={onArtifactViaChat ? () => onArtifactViaChat(doc) : undefined}
                        onToggleFavorite={() => toggleFavorite(doc)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Drag handle + Reader panel */}
      {openDoc && (
        <>
          <div
            className="w-1.5 shrink-0 cursor-col-resize group flex items-center justify-center hover:bg-edge/40 active:bg-edge/60 transition-colors"
            onMouseDown={onDragStart}
            title="Drag to resize"
          >
            <div className="w-[3px] h-8 rounded-full bg-edge group-hover:bg-ink-ghost group-active:bg-ink-soft transition-colors" />
          </div>
          <ResearchReader
            doc={openDoc}
            onClose={() => setOpenDoc(null)}
            onFocus={onFocusViaChat ? (d) => onFocusViaChat(d) : undefined}
          />
        </>
      )}
      {/* New doc sheet — paste markdown from Claude */}
      {showNewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="bg-[var(--surface-page)] border border-edge rounded-xl shadow-xl w-[560px] max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-edge flex items-center gap-3">
              <h3 className="text-[14px] font-medium text-ink flex-1">Add research doc</h3>
              <button
                type="button"
                onClick={() => { setShowNewDoc(false); setNewDocTitle(''); setNewDocContent(''); }}
                className="text-ink-ghost hover:text-ink text-[14px] px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
              >
                &#x2715;
              </button>
            </div>
            <div className="px-5 py-3 space-y-3 flex-1 min-h-0 flex flex-col">
              <input
                type="text"
                value={newDocTitle}
                onChange={(e) => setNewDocTitle(e.target.value)}
                placeholder="Title (e.g. Market Sizing Notes)"
                className="w-full text-[12px] px-3 py-2 rounded-md border border-edge bg-surface text-ink placeholder:text-ink-ghost focus:outline-none focus:border-edge-hover"
                autoFocus
              />
              <div className="flex-1 min-h-[200px] w-full rounded-md border border-edge bg-surface focus-within:border-edge-hover overflow-hidden">
                <MarkdownEditor
                  value={newDocContent}
                  onChange={setNewDocContent}
                  placeholder="Paste or type markdown here..."
                  className="h-full overflow-auto scrollbar-subtle"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-edge flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setShowNewDoc(false); setNewDocTitle(''); setNewDocContent(''); }}
                className="text-[11px] text-ink-soft hover:text-ink px-3 py-1.5 rounded-md border border-edge hover:border-edge-hover transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!newDocTitle.trim() || !newDocContent.trim() || savingNew}
                onClick={async () => {
                  setSavingNew(true);
                  const fileName = newDocTitle.trim().replace(/[/\\]/g, '—');
                  const filePath = `02-Thinking/${fileName}.md`;
                  // Prepend frontmatter if not already present
                  let body = newDocContent;
                  if (!body.trimStart().startsWith('---')) {
                    const today = new Date().toISOString().slice(0, 10);
                    body = `---\ncreated: ${today}\ntype: reference\nstatus: active\ntags: []\n---\n\n${body}`;
                  }
                  try {
                    await fetch('/api/vault/write', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ file: filePath, content: body }),
                    });
                    invalidateVaultFileCache();
                    setShowNewDoc(false);
                    setNewDocTitle('');
                    setNewDocContent('');
                    // Docs will refresh on next poll cycle
                  } catch {
                    console.error('Failed to create doc');
                  } finally {
                    setSavingNew(false);
                  }
                }}
                className="text-[11px] font-medium text-white bg-[var(--mauve)] hover:opacity-90 px-3 py-1.5 rounded-md transition-opacity disabled:opacity-30"
              >
                {savingNew ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ResearchCard({
  doc,
  isActive,
  isPromoting,
  isFavorite,
  hasArtifact,
  onOpen,
  onPromote,
  onArtifact,
  onToggleFavorite,
}: {
  doc: ResearchDoc;
  isActive: boolean;
  isPromoting: boolean;
  isFavorite: boolean;
  hasArtifact?: boolean;
  onOpen: () => void;
  onPromote: () => void;
  onArtifact?: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div
      className={`group bg-card border rounded-lg p-3 hover:border-edge-hover transition-colors cursor-pointer ${
        isActive ? 'border-[var(--sage)] bg-sage-fill/20' : 'border-edge'
      }`}
      onClick={onOpen}
    >
      {/* Title + star + staleness */}
      <div className="flex items-start gap-2 mb-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className={`shrink-0 text-[14px] mt-[-1px] transition-colors ${
            isFavorite
              ? 'text-[#E0848C]'
              : 'text-ink-ghost/30 hover:text-[#E0848C]/60'
          }`}
          title={isFavorite ? 'Unstar' : 'Star'}
        >
          {isFavorite ? '★' : '☆'}
        </button>
        <h4 className="text-[12px] font-medium text-ink leading-tight flex-1 min-w-0 line-clamp-2">
          {doc.title}
        </h4>
        <span
          className={`shrink-0 text-[9px] px-1.5 py-[1px] rounded-full tabular-nums ${staleTone(doc.staleDays)}`}
        >
          {staleLabel(doc.staleDays)}
        </span>
      </div>

      {/* Summary — render inline markdown (bold, code, links) so cards
          don't show literal `**foo**` syntax. */}
      <p
        className="text-[11px] text-ink-soft leading-relaxed line-clamp-3 mb-2"
        dangerouslySetInnerHTML={{ __html: inlineFormat(doc.summary) }}
      />

      {/* Metadata row */}
      <div className="flex items-center gap-2 text-[10px] text-ink-ghost">
        <span>{doc.createdAt}</span>
        <span>{formatSize(doc.sizeBytes)}</span>
        {doc.openTaskCount > 0 && (
          <span className="inline-flex items-center gap-0.5 px-1 py-[1px] rounded bg-tan-fill text-tan-text">
            {doc.openTaskCount} open
          </span>
        )}
        {doc.type !== 'unknown' && (
          <span className="px-1 py-[1px] rounded bg-inset">{doc.type}</span>
        )}
      </div>

      {/* Tags */}
      {doc.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {doc.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="text-[9px] text-ink-ghost px-1 py-[1px] rounded bg-inset"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="mt-2 pt-2 border-t border-edge-subtle flex items-center gap-1.5">
        <button
          type="button"
          disabled={isPromoting}
          className="text-[10px] text-ink-soft hover:text-ink hover:bg-sage-fill hover:text-sage-text px-2 py-0.5 rounded-md border border-transparent hover:border-[var(--sage)]/40 transition-colors disabled:opacity-50"
          title="Create an agent spec from this research"
          onClick={(e) => { e.stopPropagation(); onPromote(); }}
        >
          {isPromoting ? 'Creating...' : 'Promote to spec'}
        </button>
        {onArtifact && (
          <button
            type="button"
            className={`text-[10px] px-2 py-0.5 rounded-md border border-transparent transition-colors ${
              hasArtifact
                ? 'text-[var(--ocean)] bg-[var(--ocean)]/8 border-[var(--ocean)]/20'
                : 'text-ink-soft hover:text-ink hover:bg-[var(--ocean)]/8 hover:text-[var(--ocean)] hover:border-[var(--ocean)]/20'
            }`}
            title={hasArtifact ? 'Artifact exists — regenerate' : 'Generate visual artifact from this research'}
            onClick={(e) => { e.stopPropagation(); onArtifact(); }}
          >
            {hasArtifact ? '◆ Artifact' : '/artifact'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Reader panel ─────────────────────────────────────────────────
// Slide-in panel that fetches and renders full markdown content.

function ResearchReader({
  doc,
  onClose,
  onFocus,
}: {
  doc: ResearchDoc;
  onClose: () => void;
  onFocus?: (doc: ResearchDoc) => void;
}) {
  const [filePath, setFilePath] = useState(doc.filePath);
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState<string | null>(null);
  const [isHtml, setIsHtml] = useState(doc.isHtml ?? false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset when doc changes externally
  useEffect(() => {
    setFilePath(doc.filePath);
    setTitle(doc.title);
    setIsHtml(doc.isHtml ?? false);
    setHistory([]);
    setEditing(false);
    setDirty(false);
  }, [doc.filePath, doc.title, doc.isHtml]);

  // Fetch content when filePath changes
  useEffect(() => {
    setLoading(true);
    setContent(null);
    const params = new URLSearchParams({ file: filePath });
    fetch(`/api/vault/read?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setContent(data.content || '');
        setIsHtml(data.isHtml ?? filePath.endsWith('.html'));
        setLoading(false);
        scrollRef.current?.scrollTo(0, 0);
        // Extract title from content if we navigated via wikilink
        if (filePath !== doc.filePath && data.content) {
          const h1 = data.content.match(/^#\s+(.+)$/m);
          if (h1) setTitle(h1[1].trim());
          else setTitle(filePath.split('/').pop()?.replace(/\.(md|html)$/, '') || filePath);
        }
      })
      .catch(() => {
        setContent('Failed to load document.');
        setLoading(false);
      });
  }, [filePath, doc.filePath]);

  // Esc to close (or exit edit mode). If the user has unsaved
  // changes, confirm before discarding — fat-fingering Esc when you
  // meant ⌘S shouldn't blow away work.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) {
        if (dirty && !window.confirm('Discard unsaved changes?')) return;
        setEditing(false);
        setDirty(false);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, editing, dirty]);

  const startEditing = useCallback(() => {
    setEditBuffer(content || '');
    setEditing(true);
    setDirty(false);
  }, [content]);

  const saveEdit = useCallback(async () => {
    setSaving(true);
    try {
      // raw: false → API preserves the existing file's frontmatter
      // and prepends it to our buffer (which is frontmatter-stripped
      // from the read endpoint).
      await fetch('/api/vault/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath, content: editBuffer }),
      });
      setContent(editBuffer);
      setEditing(false);
      setDirty(false);
    } catch {
      console.error('Save failed');
    } finally {
      setSaving(false);
    }
  }, [filePath, editBuffer]);

  // Built but currently unused — kept as the canonical hook for any
  // future "Open in Obsidian" affordance on the reader. Returns null
  // when NEXT_PUBLIC_OBSIDIAN_VAULT is unset, so consumers must guard.
  void obsidianUrl(filePath);

  // Handle wikilink clicks
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest('a[data-vault-link]') as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      const vaultPath = link.getAttribute('data-vault-link');
      if (vaultPath) {
        setHistory((prev) => [...prev, filePath]);
        setFilePath(vaultPath);
      }
    }
  }, [filePath]);

  const goBack = useCallback(() => {
    if (history.length > 0) {
      const prev = history[history.length - 1];
      setHistory((h) => h.slice(0, -1));
      setFilePath(prev);
    }
  }, [history]);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface">
      {/* Reader header */}
      <div className="px-4 py-3 flex items-center gap-3 border-b border-edge shrink-0">
        {history.length > 0 && (
          <button
            type="button"
            onClick={goBack}
            className="text-ink-ghost hover:text-ink text-[12px] px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
            title="Back to previous document"
          >
            ←
          </button>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-medium text-ink truncate">
            {title}
          </h3>
          <div className="text-[10px] text-ink-ghost mt-0.5 flex items-center gap-2">
            <span>{filePath}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onFocus && (
            <button
              type="button"
              onClick={() => onFocus(doc)}
              className="text-[10px] font-medium text-[var(--mauve)] bg-mauve-fill hover:bg-mauve-fill/70 px-2.5 py-1 rounded-md border border-[var(--mauve)]/20 hover:border-[var(--mauve)]/40 transition-colors"
              title="Start a focus session on this doc"
            >
              Focus
            </button>
          )}
          <span className="text-[9px] text-ink-ghost">esc</span>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-ghost hover:text-ink text-[14px] px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
            title="Close reader (Esc)"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Reader body */}
      {editing ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <MarkdownEditor
            value={editBuffer}
            onChange={(next) => { setEditBuffer(next); setDirty(true); }}
            onSave={() => { void saveEdit(); }}
            autoFocus
            className="flex-1 min-h-0 overflow-auto scrollbar-subtle"
          />
        </div>
      ) : isHtml && content ? (
        // Use a real URL (src=) instead of srcDoc so anchor links,
        // JS-driven tab navigation, and relative paths inside the
        // artifact work properly. about:srcdoc breaks all of those.
        <iframe
          src={`/api/vault/read?file=${encodeURIComponent(filePath)}&serve=html`}
          className="flex-1 min-h-0 w-full border-none"
          sandbox="allow-scripts allow-same-origin"
          title={title}
        />
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-5 py-4 scrollbar-subtle"
          onClick={handleContentClick}
        >
          {loading ? (
            <div className="text-[11px] text-ink-ghost animate-pulse pt-4">
              Loading...
            </div>
          ) : content ? (
            <div
              className="research-reader"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          ) : (
            <div className="text-[11px] text-ink-ghost italic pt-4">
              Empty document.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
