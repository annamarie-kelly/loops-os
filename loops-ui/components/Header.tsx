'use client';

// Header: split chrome. Primary row is logo + segmented mode toggle + summary + bulk toolbar.
// Secondary row is only shown in Triage mode: sort + P0..P4 filter chips.

import { useEffect, useRef, useState } from 'react';
import type { Mode, SortBy, Theme } from '@/lib/ui';
import { formatMinutes } from '@/lib/types';
import { LS_THEME, applyTheme, STAKEHOLDERS } from '@/lib/ui';
import { OverrideBadge } from './OverrideBadge';

export function Header({
  mode,
  onSetMode,
  totalCount,
  lastScanned,
  committedMinutes,
  availableMinutes,
  selectedCount,
  onClearSelection,
  onOpenSearch,
  onOpenBoundaryLog,
  onOpenVaultBrowser,
  onOpenSystem,
  sortBy,
  onSetSortBy,
  filterPBuckets,
  onTogglePBucket,
  onClearPBuckets,
  filterStakeholders,
  onToggleStakeholder,
  onClearStakeholders,
  triageBadgeCount = 0,
  demoCount = 0,
  onClearDemo,
}: {
  mode: Mode;
  onSetMode: (m: Mode) => void;
  totalCount: number;
  lastScanned: string;
  committedMinutes: number;
  availableMinutes: number;
  selectedCount: number;
  onClearSelection: () => void;
  onOpenSearch?: () => void;
  onOpenBoundaryLog?: () => void;
  onOpenVaultBrowser?: () => void;
  onOpenSystem?: () => void;
  sortBy: SortBy;
  onSetSortBy: (s: SortBy) => void;
  filterPBuckets: Set<string>;
  onTogglePBucket: (p: string) => void;
  onClearPBuckets: () => void;
  filterStakeholders: Set<string>;
  onToggleStakeholder: (s: string) => void;
  onClearStakeholders: () => void;
  triageBadgeCount?: number;
  // Number of live demo loops; the pill only renders when > 0 AND a
  // real (non-demo) loop also exists — see app/page.tsx for that gate.
  demoCount?: number;
  onClearDemo?: () => void;
}) {
  const pct = Math.round((committedMinutes / availableMinutes) * 100);
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_THEME) as Theme | null;
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setTheme(raw);
        applyTheme(raw);
      }
    } catch {}
  }, []);

  const changeTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(LS_THEME, t);
    } catch {}
  };

  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-page/95 backdrop-blur shrink-0">
      {/* Primary row */}
      <div className="px-5 py-2.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5 min-w-0">
          <h1 className="shrink-0" aria-label="Tend">
            {onOpenVaultBrowser ? (
              <button
                type="button"
                onClick={onOpenVaultBrowser}
                className="rounded-md hover:opacity-80 transition-opacity"
                title="Open vault (⌘\\)"
              >
                <img
                  src="/icon_v5_cream_on_mauve.png"
                  alt=""
                  width={26}
                  height={26}
                  className="rounded-md"
                />
              </button>
            ) : (
              <img
                src="/icon_v5_cream_on_mauve.png"
                alt=""
                width={26}
                height={26}
                className="rounded-md"
              />
            )}
          </h1>

          {/* Primary segmented nav — just the four "what are you
              doing" surfaces. Backlog and Someday live as secondary
              links below so the primary nav reads as a linear
              workflow (triage → plan → focus → reflect). */}
          <div className="flex items-center gap-0 rounded-lg bg-inset p-0.5">
            <ModeButton active={mode === 'focus'} onClick={() => onSetMode('focus')}>
              Focus
            </ModeButton>
            <ModeButton
              active={mode === 'plan' || mode === 'research' || mode === 'design' || mode === 'ship'}
              onClick={() => onSetMode('research')}
            >
              Plan
            </ModeButton>
            <ModeButton active={mode === 'triage'} onClick={() => onSetMode('triage')}>
              <span className="flex items-center gap-1.5">
                Triage
                {triageBadgeCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-[14px] px-1 rounded-full bg-rose-fill text-rose-text text-[9px] tabular-nums font-medium">
                    {triageBadgeCount > 99 ? '99+' : triageBadgeCount}
                  </span>
                )}
              </span>
            </ModeButton>
            <ModeButton active={mode === 'reflect'} onClick={() => onSetMode('reflect')}>
              Reflect
            </ModeButton>
          </div>

          {/* Free-time chip — a single actionable number. Green when
              there's room, tan when things are tight, rose when
              over capacity. No committed-vs-window math in the UI. */}
          {(() => {
            const freeMin = Math.max(0, availableMinutes - committedMinutes);
            const tone =
              pct > 100
                ? 'bg-rose-fill text-rose-text'
                : pct > 85
                  ? 'bg-tan-fill text-tan-text'
                  : freeMin >= 120
                    ? 'bg-sage-fill text-sage-text'
                    : 'text-ink-faint';
            const label =
              pct > 100
                ? `over by ${formatMinutes(committedMinutes - availableMinutes)}`
                : freeMin === 0
                  ? 'fully booked'
                  : `${formatMinutes(freeMin)} free`;
            return (
              <div
                className={`hidden md:flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md tabular-nums transition-colors ${tone}`}
                title={`${formatMinutes(committedMinutes)} committed of ${Math.round(availableMinutes / 60)}h window (${pct}%)`}
              >
                <span className="font-medium">{label}</span>
              </div>
            );
          })()}

          <span className="hidden lg:inline text-[10px] text-ink-ghost tabular-nums">
            {totalCount} loops · {lastScanned}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {demoCount > 0 && onClearDemo && (
            <button
              type="button"
              onClick={onClearDemo}
              className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-soft px-2 py-1 rounded-md border border-edge hover:border-edge-hover hover:bg-inset transition-colors"
              title="Clear demo data — flips the seeded loops to done"
            >
              <span className="tabular-nums">{demoCount}</span>
              <span>demo</span>
              <span className="text-ink-ghost">×</span>
            </button>
          )}
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={onClearSelection}
              className="flex items-center gap-1.5 text-[11px] text-ink-soft hover:text-ink px-2 py-1 rounded-md hover:bg-inset transition-colors"
              title="Clear selection (Esc)"
            >
              <span className="tabular-nums">{selectedCount} selected</span>
              <span className="text-ink-ghost">×</span>
            </button>
          )}
          {onOpenSearch && (
            <button
              type="button"
              onClick={onOpenSearch}
              className="flex items-center gap-1.5 text-[11px] text-ink-ghost hover:text-ink-soft px-2 py-1 rounded-md hover:bg-inset transition-colors"
              title="Search loops (⌘K)"
            >
              <span>⌕</span>
              <kbd className="font-mono text-[10px] border border-edge rounded px-1 py-[1px]">
                ⌘K
              </kbd>
            </button>
          )}
          {/* OverrideBadge removed — boundary log accessible via ⌘⇧B */}
          {onOpenSystem && (
            <button
              type="button"
              onClick={onOpenSystem}
              className="w-7 h-7 rounded-lg bg-inset text-ink-soft hover:text-ink flex items-center justify-center text-[12px] transition-colors"
              title="System (s)"
              aria-label="Open system panel"
            >
              {'⚙'}
            </button>
          )}
          <ThemeToggle theme={theme} onChange={changeTheme} />
        </div>
      </div>

      {/* Secondary row: backlog mode. Sort + P0..P3 filter + stakeholder filter. */}
      {mode === 'backlog' && (
        <div className="px-5 py-1.5 flex items-center gap-3 border-t border-edge-subtle bg-page/80 flex-wrap">
          <select
            value={sortBy}
            onChange={(e) => onSetSortBy(e.target.value as SortBy)}
            className="text-[11px] bg-card border border-edge rounded-md px-2 py-1 text-ink-soft focus:outline-none focus:ring-1 focus:ring-[var(--slate)]"
            title="Sort by"
          >
            <option value="default">Sort: default</option>
            <option value="difficulty">Sort: difficulty</option>
            <option value="time">Sort: time</option>
            <option value="subgroup">Sort: subgroup</option>
          </select>

          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-ink-ghost mr-1">
              P
            </span>
            {['P0', 'P1', 'P2', 'P3'].map((p) => (
              <button
                key={p}
                onClick={() => onTogglePBucket(p)}
                className={`px-2 py-0.5 rounded-md text-[10px] font-mono border transition-colors ${
                  filterPBuckets.has(p)
                    ? 'bg-slate-fill text-slate-text border-[var(--slate)]'
                    : 'bg-card text-ink-faint border-edge hover:border-edge-hover hover:text-ink-soft'
                }`}
              >
                {p}
              </button>
            ))}
            {filterPBuckets.size > 0 && (
              <button
                onClick={onClearPBuckets}
                className="text-[10px] text-ink-ghost hover:text-ink-soft ml-1"
                title="Clear P filter"
              >
                clear
              </button>
            )}
          </div>

          {/* Stakeholder axis — independent of priority. Click to
              include / exclude names in the filter set. Empty set = no
              filter, all stakeholders visible. */}
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-ink-ghost mr-1">
              Who
            </span>
            {STAKEHOLDERS.map((s) => (
              <button
                key={s}
                onClick={() => onToggleStakeholder(s)}
                className={`px-2 py-0.5 rounded-md text-[10px] border transition-colors ${
                  filterStakeholders.has(s)
                    ? 'bg-tan-fill text-tan-text border-[var(--tan)]'
                    : 'bg-card text-ink-faint border-edge hover:border-edge-hover hover:text-ink-soft'
                }`}
              >
                {s}
              </button>
            ))}
            {filterStakeholders.size > 0 && (
              <button
                onClick={onClearStakeholders}
                className="text-[10px] text-ink-ghost hover:text-ink-soft ml-1"
                title="Clear stakeholder filter"
              >
                clear
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-[12px] transition-all ${
        active
          ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
          : 'text-ink-soft hover:text-ink font-normal'
      }`}
    >
      {children}
    </button>
  );
}

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  // Resolve "system" to its effective value so the toggle always flips
  // to the opposite of what's currently on-screen.
  const resolved: 'light' | 'dark' =
    theme === 'system'
      ? typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const next: 'light' | 'dark' = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      className="w-7 h-7 rounded-lg bg-inset text-ink-soft hover:text-ink flex items-center justify-center text-[12px] transition-colors"
      title={`Switch to ${next}`}
      aria-label={`Switch to ${next} theme`}
    >
      {resolved === 'dark' ? '\u263E' : '\u2609'}
    </button>
  );
}

const PIPELINE_ITEMS = [
  { mode: 'research' as const, label: 'Research', dot: 'bg-tan-fill' },
  { mode: 'design' as const, label: 'Design', dot: 'bg-[var(--ocean,#7A9AA0)]' },
  { mode: 'backlog' as const, label: 'Build', dot: 'bg-sage-fill' },
  { mode: 'ship' as const, label: 'Ship', dot: 'bg-ink-ghost' },
] as const;

function PipelineDropdown({
  mode,
  onSetMode,
}: {
  mode: Mode;
  onSetMode: (m: Mode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const activePipeline = PIPELINE_ITEMS.find((p) => p.mode === mode);

  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md transition-colors ${
          activePipeline
            ? 'text-ink bg-inset'
            : 'text-ink-ghost hover:text-ink-soft'
        }`}
      >
        {activePipeline && (
          <span className={`w-1.5 h-1.5 rounded-full ${activePipeline.dot}`} />
        )}
        {activePipeline?.label ?? 'Pipeline'}
        <span className="text-[9px] ml-0.5">▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-elevated border border-edge rounded-lg shadow-lg py-1 z-50 min-w-[120px]">
          {PIPELINE_ITEMS.map(({ mode: m, label, dot }) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                onSetMode(m as Mode);
                setOpen(false);
              }}
              className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors ${
                mode === m
                  ? 'text-ink bg-inset'
                  : 'text-ink-soft hover:text-ink hover:bg-inset/50'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
