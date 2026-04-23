'use client';

// ReflectionView: the Reflect mode surface. Composes:
//   - PressureHeatmap (30-day calendar grid)
//   - WeeklyPatternCard (manual scan result)
//   - StakeholderUpdateCard (manual weekly draft)
//   - checkpoint drill panel (click a day → full checkpoint data)
//
// All colors come from semantic tokens; no emoji anywhere.

import { useEffect, useMemo, useState } from 'react';
import type { Checkpoint, Loop, WeeklyPattern } from '@/lib/types';
import {
  readCheckpoints,
  readWeeklyPattern,
  TEND_EVENT,
  writeWeeklyPattern,
} from '@/lib/tend';
import { scanWeeklyPattern } from '@/lib/tend-pattern-scan';
import { buildStakeholderDraft, currentStakeholderWindow } from '@/lib/tend-stakeholder-draft';
import { mirrorStakeholderWindowToFile } from '@/lib/tend-mirror';
import { config } from '@/lib/config';
import { PressureHeatmap } from './PressureHeatmap';
import { WeeklyPatternCard } from './WeeklyPatternCard';
import { StakeholderUpdateCard } from './StakeholderUpdateCard';

export function ReflectionView({
  loops,
  allLoops,
  onOpenDetail,
}: {
  loops: Loop[];
  allLoops: Loop[];
  onOpenDetail: (id: string) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<Record<string, Checkpoint>>({});
  const [pattern, setPattern] = useState<WeeklyPattern | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    // One-time cleanup: wipe synthesized sample checkpoints that were
    // seeded during early UI testing. Self-removes after first run.
    try {
      const SENTINEL = 'loops-ui:tend:sample-cleared-v1';
      if (!localStorage.getItem(SENTINEL)) {
        localStorage.removeItem('loops-ui:tend:checkpoints');
        localStorage.setItem(SENTINEL, '1');
      }
    } catch {}
    const refresh = () => {
      setCheckpoints(readCheckpoints());
      setPattern(readWeeklyPattern());
    };
    refresh();
    const handler = () => refresh();
    window.addEventListener(TEND_EVENT, handler);
    return () => window.removeEventListener(TEND_EVENT, handler);
  }, []);

  const drill = selectedDate ? checkpoints[selectedDate] ?? null : null;

  const runScan = () => {
    const scanned = scanWeeklyPattern(allLoops);
    writeWeeklyPattern(scanned);
  };

  const dismissPattern = () => {
    if (!pattern) return;
    writeWeeklyPattern({ ...pattern, dismissed: true });
  };

  const stakeholderDraft = useMemo(
    () => buildStakeholderDraft(allLoops),
    [allLoops],
  );

  // Mirror the StakeholderWindow to 06-Loops/stakeholder-window.json
  // whenever the live loops change. Fire-and-forget, errors are
  // swallowed in tend-mirror. External CLI tooling reads this file.
  useEffect(() => {
    void mirrorStakeholderWindowToFile(currentStakeholderWindow(allLoops));
  }, [allLoops]);

  return (
    <main className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle">
      <div className="max-w-[920px] mx-auto px-8 py-10 flex flex-col gap-10">
        <header>
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost mb-1">
            Reflect
          </div>
          <h1 className="text-[20px] font-medium text-ink">
            How the last few weeks have gone
          </h1>
          <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
            Heatmap reads from your daily checkpoints. Weekly patterns
            and the {config.stakeholder.name.toLowerCase()} draft are
            manual — triggered here, not on a cron.
          </p>
        </header>

        <section>
          <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-3">
            Pressure · last 30 days
          </div>
          <PressureHeatmap
            checkpoints={checkpoints}
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
          />
          {drill && (
            <div className="mt-4 bg-card border border-edge rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[11px] text-ink font-mono tabular-nums">
                  {drill.date}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDate(null)}
                  className="text-[10px] text-ink-ghost hover:text-ink-soft"
                >
                  close
                </button>
              </div>
              <CheckpointDrill checkpoint={drill} onOpenDetail={onOpenDetail} />
            </div>
          )}
        </section>

        <TriageStatsSection allLoops={allLoops} />

        <WeeklyPatternCard
          pattern={pattern}
          onScan={runScan}
          onDismiss={dismissPattern}
          onOpenDetail={onOpenDetail}
        />

        {config.stakeholder.weeklySummary && (
          <StakeholderUpdateCard draft={stakeholderDraft} />
        )}
      </div>
    </main>
  );
}

function TriageStatsSection({ allLoops }: { allLoops: Loop[] }) {
  // Compute stats over the last 7 days of triage decisions. Every
  // triage_decision carries a decided_at ISO timestamp; we filter by
  // that. AI match rate tracks how often the user's disposition
  // equalled the seeder's recommendation.
  const stats = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const decided = allLoops
      .map((l) => l.triage_decision)
      .filter((d): d is NonNullable<typeof d> => {
        if (!d) return false;
        const t = new Date(d.decided_at).getTime();
        return Number.isFinite(t) && t >= cutoff;
      });
    const by = { accept: 0, someday: 0, drop: 0, snooze: 0 };
    let matched = 0;
    for (const d of decided) {
      by[d.disposition] += 1;
      if (d.matched_ai) matched += 1;
    }
    const total = decided.length;
    const rate = total > 0 ? matched / total : null;
    return { total, by, rate };
  }, [allLoops]);

  return (
    <section>
      <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-3">
        Triage · last 7 days
      </div>
      {stats.total === 0 ? (
        <div className="text-[12px] text-ink-faint italic">
          No triage decisions in the last week.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-card border border-edge rounded-lg p-4">
            <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-2">
              Disposition breakdown
            </div>
            <div className="text-[13px] text-ink leading-relaxed">
              <span className="tabular-nums font-medium">{stats.total}</span>{' '}
              processed
            </div>
            <div className="text-[11px] text-ink-soft mt-1 flex flex-wrap gap-x-3 gap-y-1">
              <span>{stats.by.accept} accepted</span>
              <span>{stats.by.someday} someday</span>
              <span>{stats.by.drop} dropped</span>
              <span>{stats.by.snooze} snoozed</span>
            </div>
          </div>
          <div className="bg-card border border-edge rounded-lg p-4">
            <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-2">
              AI match rate
            </div>
            <div className="text-[20px] text-ink font-medium tabular-nums">
              {stats.rate != null ? Math.round(stats.rate * 100) : 0}%
            </div>
            <div className="text-[10px] text-ink-ghost mt-1 leading-snug">
              {stats.rate != null && stats.rate < 0.5
                ? 'Below 50% — the heuristic may need recalibration.'
                : 'How often your decision matched the seeder.'}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CheckpointDrill({
  checkpoint,
  onOpenDetail,
}: {
  checkpoint: Checkpoint;
  onOpenDetail: (id: string) => void;
}) {
  if (checkpoint.skipped) {
    return (
      <div className="text-[12px] text-ink-faint italic">
        Skipped — no pressure read captured.
      </div>
    );
  }
  const PRESSURE_META: Record<string, { label: string; accent: string }> = {
    building: { label: 'Building new things', accent: 'var(--sage)' },
    improving: { label: 'Improving what exists', accent: 'var(--mauve)' },
    fixing: { label: 'Fixing & debugging', accent: 'var(--tan)' },
    supporting: { label: 'Supporting & responding', accent: 'var(--rose)' },
    chose: { label: 'Building new things', accent: 'var(--sage)' },
    reactive: { label: 'Fixing & debugging', accent: 'var(--tan)' },
    task_monkey: { label: 'Supporting & responding', accent: 'var(--rose)' },
  };
  const pressureVal = Array.isArray(checkpoint.pressure) ? checkpoint.pressure[0] : checkpoint.pressure;
  const meta = PRESSURE_META[pressureVal ?? ''] ?? { label: '—', accent: 'var(--text-ghost)' };
  const pressureLabel = Array.isArray(checkpoint.pressure) && checkpoint.pressure.length > 1
    ? checkpoint.pressure.map((p) => PRESSURE_META[p]?.label ?? p).join(' + ')
    : meta.label;
  const pressureAccent = meta.accent;
  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="flex items-center gap-2">
        <span
          className="w-[8px] h-[8px] rounded-full"
          style={{ background: pressureAccent }}
          aria-hidden
        />
        <span className="text-ink">{pressureLabel}</span>
      </div>
      {checkpoint.loops_touched.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-1.5">
            Touched
          </div>
          <ul className="flex flex-col gap-1">
            {checkpoint.loops_touched.map((row) => (
              <li key={row.loop_id}>
                <button
                  type="button"
                  onClick={() => onOpenDetail(row.loop_id)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-inset text-[11px] text-ink-soft"
                >
                  {row.title}
                  {row.annotation && (
                    <span className="text-ink-faint italic">
                      {' — '}
                      {row.annotation}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {checkpoint.tomorrow_intent.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-1.5">
            Tomorrow intent
          </div>
          <ul className="flex flex-col gap-1">
            {checkpoint.tomorrow_intent.map((id) => (
              <li key={id} className="text-[11px] text-ink-soft font-mono">
                {id}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
