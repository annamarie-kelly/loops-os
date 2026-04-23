'use client';

// TriageMode: dynamic group-by view. Columns are generated at render
// time from the active grouping dimension (mode / size / person /
// subgroup) combined with a scheduled-state filter. Tier is now a
// property — not the primary axis. The calendar still answers "when",
// triage answers "what is this and who cares about it."

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Loop, Tier } from '@/lib/types';
import { formatMinutes, weekDates } from '@/lib/types';
import {
  type GroupDim,
  type TriageGroup,
  buildGroups,
  effectiveWorkMode,
  pLevelBucket,
  personFromPLevel,
  sortLoops,
  type SortBy,
} from '@/lib/ui';
import { GroupColumn, type GroupColumnMeta } from './GroupColumn';
import { LoopForm } from './LoopForm';
import { BacklogProcessor } from './BacklogProcessor';

const LS_GROUP = 'tend:triage-group';
const LS_FILTER = 'tend:triage-filter';

type ScheduleFilter = 'all' | 'unscheduled' | 'scheduled';

const GROUP_OPTIONS: { value: GroupDim; label: string; shortcut: string }[] = [
  { value: 'mode', label: 'Mode', shortcut: '⇧1' },
  { value: 'size', label: 'Size', shortcut: '⇧2' },
  { value: 'person', label: 'Person', shortcut: '⇧3' },
  { value: 'subgroup', label: 'Subgroup', shortcut: '⇧4' },
  { value: 'domain', label: 'Domain', shortcut: '⇧5' },
];

const FILTER_OPTIONS: { value: ScheduleFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unscheduled', label: 'Unscheduled' },
  { value: 'scheduled', label: 'Scheduled' },
];

export function TriageMode({
  loops,
  selectedIds,
  focusedId,
  editingId,
  addingTier,
  sortBy,
  filterPBuckets,
  onToggleSelect,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onStartAdd,
  onCancelAdd,
  onSaveAdd,
  onKill,
  onCloseLoop,
  onQuickSchedule,
}: {
  loops: Loop[];
  selectedIds: Set<string>;
  focusedId: string | null;
  editingId: string | null;
  addingTier: Tier | null;
  sortBy: SortBy;
  filterPBuckets: Set<string>;
  onToggleSelect: (id: string, shiftKey: boolean, cmdKey: boolean) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, patch: Partial<Loop>) => Promise<void>;
  onStartAdd: (tier: Tier) => void;
  onCancelAdd: () => void;
  onSaveAdd: (draft: Omit<Loop, 'id'>) => Promise<void>;
  onKill?: (id: string) => void;
  onCloseLoop?: (id: string) => Promise<void>;
  onQuickSchedule?: (id: string) => void;
}) {
  const [groupDim, setGroupDim] = useState<GroupDim>('mode');
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [switching, setSwitching] = useState(false);
  const [processorOpen, setProcessorOpen] = useState(false);
  const week = useMemo(() => new Set(weekDates()), []);
  const addFormRef = useRef<HTMLDivElement>(null);

  // Click outside the add-loop form dismisses it.
  useEffect(() => {
    if (!addingTier) return;
    const handler = (e: MouseEvent) => {
      if (addFormRef.current && !addFormRef.current.contains(e.target as Node)) {
        onCancelAdd();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [addingTier, onCancelAdd]);

  // Hydrate persisted controls.
  useEffect(() => {
    try {
      const g = localStorage.getItem(LS_GROUP);
      if (g === 'mode' || g === 'size' || g === 'person' || g === 'subgroup') {
        setGroupDim(g);
      }
      const f = localStorage.getItem(LS_FILTER);
      if (f === 'all' || f === 'unscheduled' || f === 'scheduled') {
        setFilter(f);
      }
    } catch {}
  }, []);

  // Shift+1..4 to switch grouping without colliding with the existing
  // bare 1/2/3 tier-move shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
        return;
      const map: Record<string, GroupDim> = {
        '!': 'mode',     // Shift+1
        '@': 'size',     // Shift+2
        '#': 'person',   // Shift+3
        '$': 'subgroup', // Shift+4
        '%': 'domain',   // Shift+5
      };
      const target_dim = map[e.key];
      if (target_dim) {
        e.preventDefault();
        changeGroup(target_dim);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistGroup = (g: GroupDim) => {
    try {
      localStorage.setItem(LS_GROUP, g);
    } catch {}
  };
  const persistFilter = (f: ScheduleFilter) => {
    try {
      localStorage.setItem(LS_FILTER, f);
    } catch {}
  };

  const changeGroup = (g: GroupDim) => {
    if (g === groupDim) return;
    setSwitching(true);
    persistGroup(g);
    // 100ms fade out, then swap + fade in
    setTimeout(() => {
      setGroupDim(g);
      setSwitching(false);
    }, 100);
  };

  // Apply P-filter + schedule-state filter before grouping so buckets
  // reflect what's actually visible. Filters compose.
  const filtered = useMemo(() => {
    return loops.filter((l) => {
      if (filterPBuckets.size > 0 && !filterPBuckets.has(pLevelBucket(l.pLevel)))
        return false;
      if (filter !== 'all') {
        const scheduled = l.timeblocks.length > 0;
        if (filter === 'scheduled' && !scheduled) return false;
        if (filter === 'unscheduled' && scheduled) return false;
      }
      return true;
    });
  }, [loops, filterPBuckets, filter]);

  const groups: TriageGroup[] = useMemo(
    () => buildGroups(filtered, groupDim),
    [filtered, groupDim],
  );

  // Time debt: unscheduled active backlog in hours. Reframes "N tasks"
  // as "N days of work sitting in the queue" so pruning feels earned
  // rather than arbitrary. Counts every active loop with no timeblocks.
  const backlog = useMemo(() => {
    let items = 0;
    let minutes = 0;
    for (const l of loops) {
      if (l.timeblocks.length > 0) continue;
      items += 1;
      minutes += l.timeEstimateMinutes ?? 0;
    }
    const hours = minutes / 60;
    const days = hours / 8;
    return { items, hours, days };
  }, [loops]);

  // Sort each group by the existing SortBy.
  const sortedGroups = useMemo(
    () => groups.map((g) => ({ ...g, loops: sortLoops(g.loops, sortBy) })),
    [groups, sortBy],
  );

  // Build per-column meta based on grouping dim.
  const groupsWithMeta: (TriageGroup & { meta?: GroupColumnMeta })[] = useMemo(() => {
    return sortedGroups.map((g) => {
      if (groupDim === 'mode') {
        const sch = g.loops.filter((l) => l.timeblocks.length > 0).length;
        const open = g.loops.length - sch;
        return {
          ...g,
          meta: sch > 0 ? { subline: `${sch} scheduled · ${open} open` } : undefined,
        };
      }
      if (groupDim === 'size') {
        if (g.key === 'size-unsized' && g.loops.length > 5) {
          return {
            ...g,
            meta: {
              warning: `${g.loops.length} loops have no estimate — hard to schedule without sizing`,
            },
          };
        }
        return g;
      }
      if (groupDim === 'person') {
        const pressing = g.loops.filter((l) =>
          l.pLevel && /^P[01]/.test(l.pLevel),
        ).length;
        // Stale = not scheduled and lives in someday tier. Lightweight
        // proxy until we track last-touched timestamps.
        const stale = g.loops.filter(
          (l) => l.timeblocks.length === 0 && l.tier === 'someday',
        ).length;
        const parts: string[] = [];
        if (pressing > 0) parts.push(`${pressing} pressing`);
        if (stale > 0) parts.push(`${stale} stale`);
        return {
          ...g,
          meta: parts.length > 0 ? { subline: parts.join(' · ') } : undefined,
        };
      }
      // subgroup
      const scheduled = g.loops.filter((l) => l.timeblocks.length > 0).length;
      const total = g.loops.length;
      const ratio = total > 0 ? scheduled / total : 0;
      return {
        ...g,
        meta: {
          progress: ratio,
          progressLabel: `${scheduled} of ${total} scheduled`,
        },
      };
    });
  }, [sortedGroups, groupDim]);

  // Void unused refs to keep the compiler happy — these are provided
  // by the parent because triage used to do bulk moves, but we kept
  // the prop signature stable so page.tsx doesn't need to change.
  void effectiveWorkMode;
  void personFromPLevel;
  void week;

  const columnCount = groupsWithMeta.length;

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Controls row: group-by toggle + schedule filter */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-0 rounded-lg bg-inset p-0.5">
          {GROUP_OPTIONS.map((opt) => {
            const active = groupDim === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => changeGroup(opt.value)}
                className={`px-3 py-1 rounded-md text-[12px] transition-all flex items-center gap-1.5 ${
                  active
                    ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'text-ink-soft hover:text-ink'
                }`}
                title={`Group by ${opt.label.toLowerCase()} (${opt.shortcut})`}
              >
                <span>{opt.label}</span>
                {active && (
                  <kbd className="hidden md:inline text-[9px] font-mono text-ink-ghost">
                    {opt.shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>

        {/* Time-debt subtitle. Hidden when the backlog is tiny so it
            doesn't nag — only shows when there's real weight to prune. */}
        {backlog.items >= 5 && (
          <div className="ml-auto text-[11px] text-ink-ghost tabular-nums">
            <span className="text-ink-soft">{backlog.items}</span> unscheduled ·{' '}
            <span className="text-ink-soft">
              ~{backlog.hours < 10 ? backlog.hours.toFixed(1) : Math.round(backlog.hours)}h
            </span>{' '}
            backlog
            {backlog.days >= 2 && (
              <span className="text-ink-ghost">
                {' '}
                ({Math.round(backlog.days)}d)
              </span>
            )}
          </div>
        )}

        <div className={`flex items-center gap-0 rounded-md bg-inset p-0.5 ${backlog.items >= 5 ? '' : 'ml-auto'}`}>
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setFilter(opt.value);
                  persistFilter(opt.value);
                }}
                className={`px-2.5 py-0.5 rounded text-[11px] transition-all ${
                  active
                    ? 'bg-card text-ink font-medium'
                    : 'text-ink-soft hover:text-ink'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setProcessorOpen(true)}
          className="px-3 py-1 rounded-md border-[0.5px] border-edge text-[11px] text-ink-soft hover:border-[var(--mauve)] hover:bg-mauve-fill hover:text-mauve-text transition-colors"
          title="Cycle through visible loops with keyboard shortcuts"
        >
          ↻ Process
        </button>
      </div>

      {/* Columns: fluid widths keyed to item count.
          sparse (≤2 items): narrow fixed basis
          default (3-9): equal share
          dense (10+): grows 1.6x */}
      <div
        className={`flex-1 min-h-0 flex gap-3 px-4 pb-4 overflow-x-auto overflow-y-hidden items-stretch scrollbar-subtle transition-opacity duration-150 ${
          switching ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {groupsWithMeta.length > 0 ? (
          groupsWithMeta.map((g) => {
            const n = g.loops.length;
            const density =
              n <= 2
                ? 'sparse'
                : n >= 10
                  ? 'dense'
                  : 'default';
            // When there are few columns (≤4), let them stretch to fill
            // the viewport. Cap only kicks in for 5+ columns so dense
            // layouts don't become absurdly wide.
            const capMaxWidth = columnCount >= 5;
            return (
              <div
                key={g.key}
                className="min-h-0 flex flex-col"
                style={{
                  flex:
                    density === 'dense'
                      ? '1.6 1 320px'
                      : '1 1 300px',
                  minWidth: '280px',
                  maxWidth: capMaxWidth ? '440px' : 'none',
                }}
              >
                <GroupColumn
                  groupKey={g.key}
                  title={g.label}
                  accent={g.accent}
                  loops={g.loops}
                  meta={g.meta}
                  collapseSubgroups={groupDim === 'subgroup'}
                  selectedIds={selectedIds}
                  focusedId={focusedId}
                  editingId={editingId}
                  onToggleSelect={onToggleSelect}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSaveEdit={onSaveEdit}
                  onKill={onKill}
                  onQuickSchedule={onQuickSchedule}
                />
              </div>
            );
          })
        ) : (
          <div className="flex-1 flex items-center justify-center text-[12px] text-ink-ghost italic">
            nothing here · try a different filter
          </div>
        )}
      </div>

      {/* Quick-add row pinned at the bottom */}
      <div className="px-4 pb-3 shrink-0">
        {addingTier ? (
          <div
            ref={addFormRef}
            className="rounded-md border border-[var(--slate)] bg-slate-fill px-3 py-2 max-w-md"
          >
            <LoopForm
              initial={{
                tier: addingTier,
                text: '',
                pLevel: null,
                difficulty: null,
                timeEstimateMinutes: null,
                subGroup: 'Manual loops',
                domain: 'personal',
                source: { file: '00-Inbox/manual-loops.md', line: 0 },
                timeblocks: [],
              }}
              onSave={async (patch) => {
                await onSaveAdd({
                  tier: addingTier,
                  text: patch.text ?? '',
                  pLevel: patch.pLevel ?? null,
                  difficulty: patch.difficulty ?? null,
                  timeEstimateMinutes: patch.timeEstimateMinutes ?? null,
                  subGroup: 'Manual loops',
                  domain: 'personal',
                  source: { file: '00-Inbox/manual-loops.md', line: 0 },
                  timeblocks: [],
                });
              }}
              onCancel={onCancelAdd}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onStartAdd('now')}
            className="text-[12px] text-ink-ghost hover:text-ink-soft hover:bg-inset rounded-md border border-dashed border-edge hover:border-edge-hover px-3 py-1.5 transition-colors"
          >
            + New loop
          </button>
        )}
      </div>

      {processorOpen && (
        <BacklogProcessor
          loops={groupsWithMeta.flatMap((g) => g.loops)}
          onUpdateLoop={onSaveEdit}
          onKill={onKill}
          onCloseLoop={onCloseLoop}
          onClose={() => setProcessorOpen(false)}
        />
      )}
    </main>
  );
}

// Re-export so page.tsx's existing SortBy import stays stable even if
// TriageMode is eventually moved around.
export type { SortBy };
