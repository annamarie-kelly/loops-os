'use client';

// LoopDrawer: compact scrollable list of loops for Plan mode.
// Lives in a left rail. Drag a row onto the day canvas to block it.
//
// Grouping modes:
//   tier — Now / Soon / Someday (default)
//   spec — by parent spec from the Design board
//
// Sort, subgroup collapse, and summary stats are persisted in localStorage.

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import type { Loop, Tier } from '@/lib/types';
import type { SpecDoc } from '@/lib/types';
import { formatMinutes, weekDates } from '@/lib/types';
import { sortLoops } from '@/lib/ui';
import type { SortBy } from '@/lib/ui';
import { LoopRow } from './LoopRow';
import { LoopForm } from './LoopForm';
import { TierDot } from './PriorityDot';

type ScheduleFilter = 'all' | 'unscheduled' | 'scheduled';
type GroupBy = 'tier' | 'spec';

const LS_SCHEDULE_FILTER = 'loops-ui:schedule-filter';
const LS_SORT_BY = 'loops-ui:sort-by';
const LS_GROUP_BY = 'loops-ui:group-by';
const LS_COLLAPSED = 'loops-ui:collapsed-subs';

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'default', label: 'Priority' },
  { value: 'time', label: 'Time' },
  { value: 'difficulty', label: 'Difficulty' },
  { value: 'due', label: 'Due date' },
  { value: 'subgroup', label: 'Subgroup' },
];

const SPEC_STATUS_DOT: Record<string, string> = {
  drafting: 'bg-tan-fill',
  ready: 'bg-sage-fill',
  building: 'bg-[var(--ocean,#7A9AA0)]',
  shipped: 'bg-ink-ghost',
};

const SPEC_STATUS_ORDER: Record<string, number> = {
  building: 0,
  ready: 1,
  drafting: 2,
  shipped: 3,
};

export function LoopDrawer({
  loops,
  specs,
  selectedIds,
  focusedId,
  editingId,
  onToggleSelect,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onCreate,
  onKill,
  onQuickSchedule,
}: {
  loops: Loop[];
  specs?: SpecDoc[];
  selectedIds: Set<string>;
  focusedId: string | null;
  editingId: string | null;
  onToggleSelect: (id: string, shiftKey: boolean, cmdKey: boolean) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, patch: Partial<Loop>) => Promise<void>;
  onCreate?: (draft: Omit<Loop, 'id'>) => Promise<void>;
  onKill?: (id: string) => void;
  onQuickSchedule?: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [scheduleFilter, setScheduleFilter] = useState<ScheduleFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('default');
  const [groupBy, setGroupBy] = useState<GroupBy>('tier');
  const [collapsedSubs, setCollapsedSubs] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const week = useMemo(() => new Set(weekDates()), []);

  // Restore persisted state from localStorage.
  useEffect(() => {
    try {
      const rawFilter = localStorage.getItem(LS_SCHEDULE_FILTER);
      if (rawFilter === 'all' || rawFilter === 'unscheduled' || rawFilter === 'scheduled') {
        setScheduleFilter(rawFilter);
      }
      const rawSort = localStorage.getItem(LS_SORT_BY);
      if (rawSort && SORT_OPTIONS.some((o) => o.value === rawSort)) {
        setSortBy(rawSort as SortBy);
      }
      const rawGroup = localStorage.getItem(LS_GROUP_BY);
      if (rawGroup === 'tier' || rawGroup === 'spec') {
        setGroupBy(rawGroup);
      }
      const rawCollapsed = localStorage.getItem(LS_COLLAPSED);
      if (rawCollapsed) {
        try {
          const arr = JSON.parse(rawCollapsed);
          if (Array.isArray(arr)) setCollapsedSubs(new Set(arr));
        } catch {}
      }
    } catch {}
  }, []);

  const persist = useCallback((key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch {}
  }, []);

  const setScheduleFilterPersist = (f: ScheduleFilter) => {
    setScheduleFilter(f);
    persist(LS_SCHEDULE_FILTER, f);
  };
  const setSortByPersist = (s: SortBy) => {
    setSortBy(s);
    persist(LS_SORT_BY, s);
  };
  const setGroupByPersist = (g: GroupBy) => {
    setGroupBy(g);
    persist(LS_GROUP_BY, g);
  };
  const toggleCollapsed = (key: string) => {
    setCollapsedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  // Keyboard shortcuts: `/` for search, `s` to cycle sort.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;

      if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSortBy((prev) => {
          const idx = SORT_OPTIONS.findIndex((o) => o.value === prev);
          const next = SORT_OPTIONS[(idx + 1) % SORT_OPTIONS.length].value;
          persist(LS_SORT_BY, next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [persist]);

  // Active set: everything except done.
  const active = useMemo(() => {
    return loops
      .filter((l) => !l.done)
      .map((l) => ({
        loop: l,
        onCalendar: l.timeblocks.some((tb) => week.has(tb.date)),
      }));
  }, [loops, week]);

  // Apply schedule-state filter, then text query.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active
      .filter(({ onCalendar }) => {
        if (scheduleFilter === 'unscheduled') return !onCalendar;
        if (scheduleFilter === 'scheduled') return onCalendar;
        return true;
      })
      .filter(({ loop }) => {
        if (!q) return true;
        const hay =
          `${loop.text} ${loop.pLevel ?? ''} ${loop.subGroup ?? ''}`.toLowerCase();
        return hay.includes(q);
      });
  }, [active, query, scheduleFilter]);

  // ── Grouping: Tier mode ──
  const groupedByTier = useMemo(() => {
    const g: Record<Tier, { loop: Loop; onCalendar: boolean }[]> = {
      now: [],
      soon: [],
      someday: [],
    };
    for (const row of filtered) g[row.loop.tier].push(row);
    // Apply sort within each tier
    for (const tier of ['now', 'soon', 'someday'] as Tier[]) {
      const loops = g[tier].map((r) => r.loop);
      const sorted = sortLoops(loops, sortBy);
      const calMap = new Map(g[tier].map((r) => [r.loop.id, r.onCalendar]));
      g[tier] = sorted.map((l) => ({ loop: l, onCalendar: calMap.get(l.id) ?? false }));
    }
    return g;
  }, [filtered, sortBy]);

  // ── Grouping: Spec mode ──
  const groupedBySpec = useMemo(() => {
    if (!specs || specs.length === 0) return [];

    // Match loops to specs by source file path or subGroup containing spec title
    const specGroups: { spec: SpecDoc; rows: { loop: Loop; onCalendar: boolean }[] }[] = [];
    const matched = new Set<string>();

    for (const spec of specs) {
      // Skip shipped specs (they're done)
      if (spec.status === 'shipped') continue;
      const specName = spec.title.replace(/\s*—\s*Agent Spec$/, '');
      const specPath = spec.filePath;
      const rows = filtered.filter(({ loop }) => {
        if (matched.has(loop.id)) return false;
        // Match by source file containing spec path, or subGroup matching spec title
        const byFile = specPath && loop.source.file.includes(specPath.replace(/\.md$/, '').split('/').pop() ?? '');
        const bySub = loop.subGroup && (
          loop.subGroup.toLowerCase().includes(specName.toLowerCase()) ||
          specName.toLowerCase().includes(loop.subGroup.toLowerCase())
        );
        return byFile || bySub;
      });
      for (const r of rows) matched.add(r.loop.id);
      if (rows.length > 0) {
        // Apply sort
        const loops = rows.map((r) => r.loop);
        const sorted = sortLoops(loops, sortBy);
        const calMap = new Map(rows.map((r) => [r.loop.id, r.onCalendar]));
        specGroups.push({
          spec,
          rows: sorted.map((l) => ({ loop: l, onCalendar: calMap.get(l.id) ?? false })),
        });
      }
    }

    // Sort spec groups by status (building first, then ready, then drafting)
    specGroups.sort((a, b) =>
      (SPEC_STATUS_ORDER[a.spec.status] ?? 99) - (SPEC_STATUS_ORDER[b.spec.status] ?? 99)
    );

    // Ungrouped bucket
    const ungrouped = filtered.filter(({ loop }) => !matched.has(loop.id));
    if (ungrouped.length > 0) {
      const loops = ungrouped.map((r) => r.loop);
      const sorted = sortLoops(loops, sortBy);
      const calMap = new Map(ungrouped.map((r) => [r.loop.id, r.onCalendar]));
      specGroups.push({
        spec: { id: '__ungrouped', filePath: '', title: 'Ungrouped', status: 'drafting' as const, effortEstimate: null, openQuestions: [], createdAt: '', updatedAt: '', staleDays: 0, sourceResearch: [], linkedLoopCount: 0, sizeBytes: 0 },
        rows: sorted.map((l) => ({ loop: l, onCalendar: calMap.get(l.id) ?? false })),
      });
    }

    return specGroups;
  }, [filtered, specs, sortBy]);

  // Counts for the filter pills.
  const counts = useMemo(() => {
    let all = 0;
    let unsched = 0;
    let sched = 0;
    for (const { onCalendar } of active) {
      all += 1;
      if (onCalendar) sched += 1;
      else unsched += 1;
    }
    return { all, unsched, sched };
  }, [active]);

  const sections: { tier: Tier; label: string }[] = [
    { tier: 'now', label: 'Now' },
    { tier: 'soon', label: 'Soon' },
    { tier: 'someday', label: 'Someday' },
  ];

  const isFiltering = query.trim().length > 0;
  const matchCount = filtered.length;
  const headerTotalMinutes = active.reduce(
    (sum, r) => sum + (r.loop.timeEstimateMinutes ?? 0),
    0,
  );

  const filterOptions: { value: ScheduleFilter; label: string; n: number }[] = [
    { value: 'all', label: 'All', n: counts.all },
    { value: 'unscheduled', label: 'Unscheduled', n: counts.unsched },
    { value: 'scheduled', label: 'Scheduled', n: counts.sched },
  ];

  const hasSpecs = specs && specs.length > 0;

  // Helper: sum time estimate for a list of rows
  const sumMinutes = (rows: { loop: Loop }[]) =>
    rows.reduce((s, r) => s + (r.loop.timeEstimateMinutes ?? 0), 0);

  // Render a list of loop rows (shared between tier and spec grouping)
  const renderRows = (rows: { loop: Loop; onCalendar: boolean }[]) => (
    <ul className="flex flex-col gap-[1px]">
      {rows.map(({ loop, onCalendar }) =>
        editingId === loop.id ? (
          <li
            key={loop.id}
            className="px-3 py-2 border-b border-edge-subtle bg-inset"
          >
            <LoopForm
              initial={loop}
              onSave={(patch) => onSaveEdit(loop.id, patch)}
              onCancel={onCancelEdit}
            />
          </li>
        ) : (
          <LoopRow
            key={loop.id}
            loop={loop}
            selected={selectedIds.has(loop.id)}
            focused={focusedId === loop.id}
            density="sidebar"
            onCalendar={onCalendar}
            onToggleSelect={onToggleSelect}
            onStartEdit={onStartEdit}
            onSaveEdit={onSaveEdit}
            onKill={onKill}
            onQuickSchedule={onQuickSchedule}
          />
        ),
      )}
    </ul>
  );

  return (
    <aside className="flex flex-col min-w-0 h-full bg-page border-r border-edge">
      <div className="px-4 py-3 border-b border-edge shrink-0">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium text-ink">Work</h2>
          <span className="text-[11px] text-ink-ghost tabular-nums">
            {isFiltering
              ? `${matchCount} / ${counts.all}`
              : `${counts.all} · ${formatMinutes(headerTotalMinutes)}`}
          </span>
        </div>
        <p className="text-[10px] text-ink-ghost mt-0.5">
          click to open · drag to block · / search · s sort
        </p>
      </div>

      {/* Search + Sort row */}
      <div className="px-3 pt-2 pb-2 shrink-0 flex gap-1.5 items-center">
        <div className="relative flex-1 min-w-0">
          <span
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost text-[11px] pointer-events-none"
            aria-hidden
          >
            ⌕
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search loops"
            className="w-full pl-7 pr-7 py-1.5 text-[13px] bg-inset border border-edge rounded-md text-ink placeholder:text-ink-ghost focus:outline-none focus:border-[var(--slate)] focus:bg-card transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-ghost hover:text-ink-soft text-[11px] w-4 h-4 flex items-center justify-center rounded-full hover:bg-card"
              title="Clear search"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortByPersist(e.target.value as SortBy)}
          className="shrink-0 text-[11px] bg-inset border border-edge rounded-md text-ink-soft py-1.5 px-2 focus:outline-none focus:border-[var(--slate)] cursor-pointer appearance-none"
          style={{ backgroundImage: 'none' }}
          title="Sort order (press s to cycle)"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Schedule-state filter + grouping toggle */}
      <div className="px-3 pb-2 shrink-0 flex gap-1.5 items-center">
        <div className="flex items-center gap-0 rounded-md bg-inset p-0.5 flex-1">
          {filterOptions.map((opt) => {
            const isActive = scheduleFilter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setScheduleFilterPersist(opt.value)}
                className={`flex-1 px-2 py-1 rounded text-[11px] transition-all flex items-center justify-center gap-1 ${
                  isActive
                    ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'text-ink-soft hover:text-ink'
                }`}
                title={`${opt.label} (${opt.n})`}
              >
                <span>{opt.label}</span>
                <span className="text-[10px] text-ink-ghost tabular-nums">
                  {opt.n}
                </span>
              </button>
            );
          })}
        </div>
        {hasSpecs && (
          <div className="flex items-center gap-0 rounded-md bg-inset p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setGroupByPersist('tier')}
              className={`px-2 py-1 rounded text-[10px] transition-all ${
                groupBy === 'tier'
                  ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-ink-soft hover:text-ink'
              }`}
              title="Group by tier (Now/Soon/Someday)"
            >
              Tier
            </button>
            <button
              type="button"
              onClick={() => setGroupByPersist('spec')}
              className={`px-2 py-1 rounded text-[10px] transition-all ${
                groupBy === 'spec'
                  ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                  : 'text-ink-soft hover:text-ink'
              }`}
              title="Group by spec (Design board)"
            >
              Spec
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-scroll scrollbar-visible">
        {/* ── Tier grouping ── */}
        {groupBy === 'tier' && sections.map(({ tier, label }) => {
          const list = groupedByTier[tier];
          if (list.length === 0) return null;
          const tierMinutes = sumMinutes(list);
          // Secondary grouping by subGroup
          const bySubgroup = new Map<string, { loop: Loop; onCalendar: boolean }[]>();
          for (const row of list) {
            const key = (row.loop.subGroup ?? 'Other').trim() || 'Other';
            if (!bySubgroup.has(key)) bySubgroup.set(key, []);
            bySubgroup.get(key)!.push(row);
          }
          return (
            <div key={tier} className="border-b border-edge-subtle last:border-b-0 pb-3">
              <div className="sticky top-0 z-10 px-4 py-1.5 bg-page/95 backdrop-blur border-b border-edge-subtle flex items-center gap-2">
                <TierDot tier={tier} size="sm" />
                <span className="text-[11px] uppercase tracking-[0.04em] text-ink-soft font-medium">
                  {label}
                </span>
                <span className="text-[10px] text-ink-ghost tabular-nums ml-auto">
                  {list.length} · {formatMinutes(tierMinutes)}
                </span>
              </div>
              {[...bySubgroup.entries()].map(([sub, rows], subIdx) => {
                const subKey = `${tier}:${sub}`;
                const isCollapsed = collapsedSubs.has(subKey);
                const subMinutes = sumMinutes(rows);
                return (
                  <div key={sub} className={subIdx > 0 ? 'mt-3' : 'mt-1'}>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(subKey)}
                      className="w-full px-4 pt-1 pb-0.5 flex items-baseline justify-between hover:bg-inset/40 transition-colors rounded-sm group/sub cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={`text-[9px] text-ink-ghost transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                          ▸
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.04em] text-ink-ghost font-normal truncate">
                          {sub}
                        </span>
                      </span>
                      <span className="text-[9px] text-ink-ghost tabular-nums shrink-0 ml-2">
                        {rows.length} · {formatMinutes(subMinutes)}
                      </span>
                    </button>
                    {!isCollapsed && renderRows(rows)}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* ── Spec grouping ── */}
        {groupBy === 'spec' && groupedBySpec.map(({ spec, rows }) => {
          const specKey = `spec:${spec.id}`;
          const isCollapsed = collapsedSubs.has(specKey);
          const specMinutes = sumMinutes(rows);
          const isUngrouped = spec.id === '__ungrouped';
          return (
            <div key={spec.id} className="border-b border-edge-subtle last:border-b-0 pb-3">
              <button
                type="button"
                onClick={() => toggleCollapsed(specKey)}
                className="w-full sticky top-0 z-10 px-4 py-1.5 bg-page/95 backdrop-blur border-b border-edge-subtle flex items-center gap-2 hover:bg-inset/40 transition-colors cursor-pointer"
              >
                <span className={`text-[9px] text-ink-ghost transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                  ▸
                </span>
                {!isUngrouped && (
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${SPEC_STATUS_DOT[spec.status] ?? 'bg-ink-ghost'}`}
                    title={spec.status}
                  />
                )}
                <span className={`text-[11px] font-medium truncate ${isUngrouped ? 'text-ink-ghost' : 'text-ink-soft'}`}>
                  {spec.title.replace(/\s*—\s*Agent Spec$/, '')}
                </span>
                <span className="text-[10px] text-ink-ghost tabular-nums ml-auto shrink-0">
                  {rows.length} · {formatMinutes(specMinutes)}
                </span>
              </button>
              {!isCollapsed && (
                <div className="mt-1">
                  {renderRows(rows)}
                </div>
              )}
            </div>
          );
        })}

        {/* Empty states */}
        {isFiltering && matchCount === 0 && (
          <div className="text-[12px] text-ink-ghost italic px-4 py-10 text-center">
            no loops match &ldquo;{query}&rdquo;
          </div>
        )}
        {!isFiltering && matchCount === 0 && scheduleFilter === 'unscheduled' && (
          <div className="text-[12px] text-ink-ghost italic px-4 py-10 text-center">
            Everything&rsquo;s on the calendar this week
          </div>
        )}
        {!isFiltering && matchCount === 0 && scheduleFilter !== 'unscheduled' && (
          <div className="text-[12px] text-ink-ghost italic px-4 py-10 text-center">
            nothing here
          </div>
        )}
      </div>

      {/* Quick-add at bottom */}
      {onCreate && (
        <div className="px-3 py-2 border-t border-edge shrink-0">
          {adding ? (
            <div className="rounded-md border border-[var(--slate)] bg-slate-fill px-3 py-2">
              <LoopForm
                initial={{
                  tier: 'now',
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
                  await onCreate({
                    tier: 'now',
                    text: patch.text ?? '',
                    pLevel: patch.pLevel ?? null,
                    difficulty: patch.difficulty ?? null,
                    timeEstimateMinutes: patch.timeEstimateMinutes ?? null,
                    subGroup: 'Manual loops',
                    domain: 'personal',
                    source: { file: '00-Inbox/manual-loops.md', line: 0 },
                    timeblocks: [],
                  });
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="w-full text-[12px] text-ink-ghost hover:text-ink-soft hover:bg-inset rounded-md border border-dashed border-edge hover:border-edge-hover px-3 py-2 transition-colors"
            >
              + add task
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
