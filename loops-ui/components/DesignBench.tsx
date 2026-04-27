'use client';

// DesignBench — Mission Control surface for agent specs.
// Kanban columns: Drafting → Ready → Building → Shipped.
// Clicking a card opens the spec in a reader panel (same split-pane
// pattern as ResearchShelf).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { SpecDoc, SpecStatus } from '@/lib/types';
import { renderMarkdown, escapeHtml, inlineFormat } from '@/lib/renderMarkdown';
import { MarkdownEditor } from '@/components/MarkdownEditor';

const COLUMNS: { status: SpecStatus; label: string; emptyHint: string }[] = [
  { status: 'drafting', label: 'Drafting', emptyHint: 'Promote research docs to start specs here' },
  { status: 'ready', label: 'Ready', emptyHint: 'Specs ready to decompose into tasks' },
  { status: 'building', label: 'Building', emptyHint: 'Specs with active build tasks' },
  { status: 'shipped', label: 'Shipped', emptyHint: 'Completed specs' },
];

const STATUS_DOT: Record<SpecStatus, string> = {
  drafting: 'bg-tan-fill',
  ready: 'bg-sage-fill',
  building: 'bg-[var(--ocean,#7A9AA0)]',
  shipped: 'bg-ink-ghost',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Main component ───────────────────────────────────────────────

export function DesignBench({
  specs,
  onRefetch,
  onDecomposeViaChat,
  onSpecViaChat,
  onHandoffViaChat,
  onPlanViaChat,
  onFocusSpec,
  onUpdateSpecStatus,
  onWriteComplete,
}: {
  specs: SpecDoc[];
  onRefetch?: () => void | Promise<void>;
  onDecomposeViaChat?: (spec: SpecDoc) => void;
  onSpecViaChat?: (spec: SpecDoc) => void;
  onHandoffViaChat?: (spec: SpecDoc) => void;
  onPlanViaChat?: (spec: SpecDoc) => void;
  onFocusSpec?: (spec: SpecDoc) => void;
  onUpdateSpecStatus?: (specId: string, newStatus: SpecStatus) => void;
  onWriteComplete?: () => void;
}) {
  const [decomposing, setDecomposing] = useState<string | null>(null);

  const decomposeSpec = useCallback(async (spec: SpecDoc) => {
    setDecomposing(spec.id);
    try {
      const res = await fetch('/api/vault/specs/decompose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specPath: spec.filePath }),
      });
      const data = await res.json();
      if (res.ok) {
        onRefetch?.();
      } else {
        console.error('Decompose failed:', data.error);
      }
    } catch (err) {
      console.error('Decompose error:', err);
    } finally {
      setDecomposing(null);
    }
  }, [onRefetch]);
  const [openSpec, setOpenSpec] = useState<SpecDoc | null>(null);
  const [splitPct, setSplitPct] = useState(25);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Give HTML artifacts more room
  useEffect(() => {
    if (openSpec?.isHtml) setSplitPct(15);
    else if (openSpec) setSplitPct(25);
  }, [openSpec?.id, openSpec?.isHtml]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
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

  const grouped = useMemo(() => {
    const map = new Map<SpecStatus, SpecDoc[]>();
    for (const s of specs) {
      const existing = map.get(s.status) || [];
      existing.push(s);
      map.set(s.status, existing);
    }
    return map;
  }, [specs]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const [draggingSpecId, setDraggingSpecId] = useState<string | null>(null);
  const draggingSpec = draggingSpecId ? specs.find((s) => s.id === draggingSpecId) ?? null : null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingSpecId(String(event.active.id));
  }, []);

  // Queue writes so rapid drags don't race — each write waits for the
  // previous one to finish before reading from disk.
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingSpecId(null);
    const { active, over } = event;
    if (!over) return;
    const specId = String(active.id);
    const newStatus = String(over.id) as SpecStatus;
    const spec = specs.find((s) => s.id === specId);
    if (!spec || spec.status === newStatus) return;

    // Optimistic: update parent state immediately
    onUpdateSpecStatus?.(specId, newStatus);

    // Queue the disk write so rapid drags serialize
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      try {
        const res = await fetch(`/api/vault/read?${new URLSearchParams({ file: spec.filePath, raw: '1' })}`);
        const data = await res.json();
        if (!data.content) return;
        const c: string = data.content;
        let updated: string;
        const fmMatch = c.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch && /^status:\s*.+$/m.test(fmMatch[1])) {
          // Frontmatter exists with status field — replace value
          updated = c.replace(/^(---\n[\s\S]*?)(status:\s*).+$/m, `$1$2${newStatus}`);
        } else if (fmMatch) {
          // Frontmatter exists but no status — insert it
          updated = c.replace(/^---\n/, `---\nstatus: ${newStatus}\n`);
        } else {
          // No frontmatter — prepend one
          updated = `---\nstatus: ${newStatus}\n---\n\n${c}`;
        }
        await fetch('/api/vault/write', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: spec.filePath, content: updated, raw: true }),
        });
        // Refetch so the poll cache has the correct status from disk
        await onRefetch?.();
        onWriteComplete?.();
      } catch {
        onWriteComplete?.();
      }
    });
  }, [specs, onUpdateSpecStatus, onRefetch, onWriteComplete]);

  return (
    <main ref={containerRef} className="flex-1 min-h-0 flex overflow-hidden">
      {/* Kanban */}
      <div
        className="min-h-0 flex flex-col overflow-hidden"
        style={{ width: openSpec ? `${splitPct}%` : '100%', transition: draggingRef.current ? 'none' : 'width 0.2s' }}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-3 flex items-center gap-3 shrink-0">
          <div>
            <h2 className="text-[14px] font-medium text-ink">Build Queue</h2>
            <p className="text-[11px] text-ink-ghost">
              Agent specs. Decompose when ready to build.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-ink-ghost tabular-nums">
              {specs.length} spec{specs.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Kanban columns */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5 scrollbar-subtle">
          {specs.length === 0 ? (
            <div className="text-[12px] text-ink-ghost italic pt-10 text-center">
              No specs yet. Promote a research doc from the Research shelf.
            </div>
          ) : (
            <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className={`grid gap-4 ${openSpec ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4'}`}>
              {COLUMNS.map(({ status, label, emptyHint }) => {
                const items = grouped.get(status) || [];
                return (
                  <KanbanColumn key={status} status={status} label={label} emptyHint={emptyHint} count={items.length}>
                    {items.map((spec) => (
                          <DraggableSpecCard
                            key={spec.id}
                            spec={spec}
                            isActive={openSpec?.id === spec.id}
                            isDecomposing={decomposing === spec.id}
                            onOpen={() => setOpenSpec(spec)}
                            onDecompose={() => decomposeSpec(spec)}
                          />
                    ))}
                  </KanbanColumn>
                );
              })}
            </div>
            <DragOverlay dropAnimation={null}>
              {draggingSpec && (
                <div className="rounded-lg bg-card/95 border border-edge shadow-lg px-3 py-2 w-[260px] opacity-90" style={{ transform: 'rotate(-1deg)' }}>
                  <div className="text-[12px] font-medium text-ink truncate">{draggingSpec.title}</div>
                  <div className="text-[10px] text-ink-ghost mt-0.5">{draggingSpec.status}</div>
                </div>
              )}
            </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {/* Drag handle + Reader */}
      {openSpec && (
        <>
          <div
            className="w-1.5 shrink-0 cursor-col-resize group flex items-center justify-center hover:bg-edge/40 active:bg-edge/60 transition-colors"
            onMouseDown={onDragStart}
            title="Drag to resize"
          >
            <div className="w-[3px] h-8 rounded-full bg-edge group-hover:bg-ink-ghost group-active:bg-ink-soft transition-colors" />
          </div>
          <SpecReader
            spec={openSpec}
            onClose={() => setOpenSpec(null)}
            onDecompose={onDecomposeViaChat ? () => onDecomposeViaChat(openSpec) : undefined}
            onSpec={onSpecViaChat ? () => onSpecViaChat(openSpec) : undefined}
            onHandoff={onHandoffViaChat ? () => onHandoffViaChat(openSpec) : undefined}
            onPlan={onPlanViaChat ? () => onPlanViaChat(openSpec) : undefined}
            onFocus={onFocusSpec ? () => onFocusSpec(openSpec) : undefined}
          />
        </>
      )}
    </main>
  );
}

// ─── Spec card ────────────────────────────────────────────────────

// ─── Droppable kanban column ─────────────────────────────────────

function KanbanColumn({
  status,
  label,
  emptyHint,
  count,
  children,
}: {
  status: SpecStatus;
  label: string;
  emptyHint: string;
  count: number;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef} className={`flex flex-col min-h-[80px] transition-colors rounded-lg ${isOver ? 'bg-sage-fill/30' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-2 h-2 rounded-full ${STATUS_DOT[status]}`} />
        <h3 className="text-[11px] font-medium text-ink-soft uppercase tracking-wider">{label}</h3>
        <span className="text-[10px] text-ink-ghost tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-2">
        {count === 0 ? (
          <div className="text-[10px] text-ink-ghost italic py-4 px-2 border border-dashed border-edge-subtle rounded-lg text-center">
            {emptyHint}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// ─── Draggable spec card wrapper ─────────────────────────────────

function DraggableSpecCard(props: {
  spec: SpecDoc;
  isActive: boolean;
  isDecomposing: boolean;
  onOpen: () => void;
  onDecompose: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.spec.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.3 : 1 }}
    >
      <SpecCard {...props} />
    </div>
  );
}

// ─── Spec card ────────────────────────────────────────────────────

function SpecCard({
  spec,
  isActive,
  isDecomposing,
  onOpen,
  onDecompose,
}: {
  spec: SpecDoc;
  isActive: boolean;
  isDecomposing: boolean;
  onOpen: () => void;
  onDecompose: () => void;
}) {
  return (
    <div
      className={`group bg-card border rounded-lg p-3 hover:border-edge-hover transition-colors cursor-pointer ${
        isActive ? 'border-[var(--sage)] bg-sage-fill/20' : 'border-edge'
      }`}
      onClick={onOpen}
    >
      <h4 className="text-[12px] font-medium text-ink leading-tight mb-1.5 line-clamp-2">
        {spec.title}
      </h4>

      {/* Metadata */}
      <div className="flex items-center gap-2 text-[10px] text-ink-ghost flex-wrap">
        <span>{spec.createdAt}</span>
        <span>{formatSize(spec.sizeBytes)}</span>
        {spec.effortEstimate && (
          <span className="px-1 py-[1px] rounded bg-inset">{spec.effortEstimate}</span>
        )}
        {spec.linkedLoopCount > 0 && (
          <span className="px-1 py-[1px] rounded bg-sage-fill text-sage-text">
            {spec.linkedLoopCount} loop{spec.linkedLoopCount !== 1 ? 's' : ''}
          </span>
        )}
        {spec.openQuestions.length > 0 && (
          <span className="px-1 py-[1px] rounded bg-tan-fill text-tan-text">
            {spec.openQuestions.length} question{spec.openQuestions.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Source research links */}
      {spec.sourceResearch.length > 0 && (
        <div className="mt-1.5 text-[9px] text-ink-ghost truncate">
          from: {spec.sourceResearch.map((r) => r.split('/').pop()?.replace(/\.md$/, '')).join(', ')}
        </div>
      )}

      {/* Decompose action — available on drafting and ready specs */}
      {(spec.status === 'drafting' || spec.status === 'ready') && (
        <div className="mt-2 pt-2 border-t border-edge-subtle">
          <button
            type="button"
            disabled={isDecomposing}
            className="text-[10px] text-ink-soft hover:text-ink hover:bg-sage-fill hover:text-sage-text px-2 py-0.5 rounded-md border border-transparent hover:border-[var(--sage)]/40 transition-colors disabled:opacity-50"
            title="Extract tasks from Requirements/Decomposition and create build loops"
            onClick={(e) => { e.stopPropagation(); onDecompose(); }}
          >
            {isDecomposing ? 'Decomposing...' : 'Decompose'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Spec reader ──────────────────────────────────────────────────

function SpecReader({
  spec,
  onClose,
  onDecompose,
  onSpec,
  onHandoff,
  onPlan,
  onFocus,
}: {
  spec: SpecDoc;
  onClose: () => void;
  onDecompose?: () => void;
  onSpec?: () => void;
  onHandoff?: () => void;
  onPlan?: () => void;
  onFocus?: () => void;
}) {
  const [filePath, setFilePath] = useState(spec.filePath);
  const [title, setTitle] = useState(spec.title);
  const [content, setContent] = useState<string | null>(null);
  const [isHtml, setIsHtml] = useState(spec.isHtml ?? false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFilePath(spec.filePath);
    setTitle(spec.title);
    setIsHtml(spec.isHtml ?? false);
    setHistory([]);
    setEditing(false);
    setDirty(false);
  }, [spec.filePath, spec.title, spec.isHtml]);

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
        if (filePath !== spec.filePath && data.content) {
          const h1 = data.content.match(/^#\s+(.+)$/m);
          if (h1) setTitle(h1[1].trim());
          else setTitle(filePath.split('/').pop()?.replace(/\.(md|html)$/, '') || filePath);
        }
      })
      .catch(() => {
        setContent('Failed to load spec.');
        setLoading(false);
      });
  }, [filePath, spec.filePath]);

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

  const startEditing = useCallback(() => {
    setEditBuffer(content || '');
    setEditing(true);
    setDirty(false);
  }, [content]);

  const saveEdit = useCallback(async () => {
    setSaving(true);
    try {
      // raw: false → API preserves existing frontmatter (read endpoint
      // strips it, so editBuffer never contains it).
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

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface">
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-edge shrink-0">
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
          <h3 className="text-[13px] font-medium text-ink truncate">{title}</h3>
          <div className="text-[10px] text-ink-ghost mt-0.5 flex items-center gap-2">
            <span>{filePath}</span>
            <span className={`px-1.5 py-[1px] rounded-full ${STATUS_DOT[spec.status]} text-ink`}>
              {spec.status}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Focus — always available, any stage */}
          {onFocus && spec.status !== 'shipped' && (
            <button
              type="button"
              onClick={onFocus}
              className="text-[10px] font-medium text-ink bg-inset hover:bg-edge px-2.5 py-1 rounded-md border border-edge hover:border-edge-hover transition-colors"
              title="Focus on this spec — switch to Focus mode and add to calendar"
            >
              Focus
            </button>
          )}

          {/* Pipeline buttons */}
          {spec.status !== 'shipped' && (
            <>
              {/* Upgrade status: drafting→ready→building→shipped */}
              <button
                type="button"
                onClick={async () => {
                  const next: Record<string, string> = { drafting: 'ready', ready: 'building', building: 'shipped' };
                  const nextStatus = next[spec.status];
                  if (!nextStatus) return;
                  try {
                    const rawRes = await fetch(`/api/vault/read?${new URLSearchParams({ file: filePath, raw: '1' })}`);
                    const rawData = await rawRes.json();
                    if (!rawData.content) return;
                    await fetch('/api/vault/write', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        file: filePath,
                        content: rawData.content.replace(
                          /^(status:\s*).+$/m,
                          `$1${nextStatus}`,
                        ),
                        raw: true,
                      }),
                    });
                  } catch { /* ignore */ }
                }}
                className="text-[10px] font-medium text-sage-text bg-sage-fill hover:bg-sage-fill/70 px-2.5 py-1 rounded-md border border-[var(--sage)]/20 hover:border-[var(--sage)]/40 transition-colors"
                title={`Move to ${spec.status === 'drafting' ? 'ready' : spec.status === 'ready' ? 'building' : 'shipped'}`}
              >
                {spec.status === 'drafting' ? 'Ready →' : spec.status === 'ready' ? 'Building →' : 'Ship →'}
              </button>

            </>
          )}

          <button
            type="button"
            onClick={() => {
              if (editing) {
                if (dirty && !window.confirm('Discard unsaved changes?')) return;
                setEditing(false);
                setDirty(false);
              } else {
                onClose();
              }
            }}
            className="text-ink-ghost hover:text-ink text-[14px] px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Content */}
      {isHtml && content ? (
        <iframe
          srcDoc={content}
          className="flex-1 min-h-0 w-full border-none"
          sandbox="allow-scripts allow-same-origin"
          title={title}
        />
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-5 py-4 scrollbar-subtle"
          onClick={editing ? undefined : handleContentClick}
        >
          {loading ? (
            <div className="text-[11px] text-ink-ghost animate-pulse pt-4">Loading...</div>
          ) : editing ? (
            <MarkdownEditor
              value={editBuffer}
              onChange={(next) => { setEditBuffer(next); setDirty(true); }}
              onSave={() => { if (dirty) void saveEdit(); }}
              autoFocus
              className="w-full h-full"
            />
          ) : content ? (
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
          ) : (
            <div className="text-[11px] text-ink-ghost italic pt-4">Empty spec.</div>
          )}
        </div>
      )}
    </div>
  );
}
