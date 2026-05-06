'use client';

// CheckpointModal: the 5pm non-dismissible checkpoint.
//
// Appears once the clock has crossed 17:00 local AND no checkpoint has
// been saved for today's YYYY-MM-DD. Cannot be dismissed by Escape or
// backdrop click — the only exits are "Done" (after filling Section 2
// + at least one tomorrow intent) or the 6pm auto-skip fallback
// handled by CheckpointSkipBanner.
//
// Cross-tab coordination: first tab to acquire the localStorage-backed
// lock (see lib/tend.ts) owns the modal. Other tabs stay quiet until
// the lock expires or is released.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Checkpoint, CheckpointTouchedLoop, Loop } from '@/lib/types';
import {
  acquireCheckpointLock,
  appendBoundaryLog,
  countActiveP1Stakeholder,
  countActiveP1Self,
  overrideCountThisWeek,
  readCheckpoint,
  releaseCheckpointLock,
  todayLocalDate,
  writeCheckpoint,
} from '@/lib/tend';
import { P1_STAKEHOLDER } from '@/lib/config';
import { renderInlineMarkdown } from '@/lib/markdown';

const CHECKPOINT_HOUR = 15; // 3pm local — moved earlier so it lands before logoff
const SKIP_HOUR = 16; // 4pm local — CheckpointSkipBanner takes over after this
const LS_FORCE_OPEN = 'loops-ui:tend:checkpoint_force_open';

type PressureKey = 'building' | 'improving' | 'fixing' | 'supporting';

const PRESSURE_OPTIONS: {
  key: PressureKey;
  label: string;
  accent: string;
  fill: string;
  text: string;
}[] = [
  {
    key: 'building',
    label: 'Building new things',
    accent: 'var(--sage)',
    fill: 'bg-sage-fill',
    text: 'text-sage-text',
  },
  {
    key: 'improving',
    label: 'Improving what exists',
    accent: 'var(--mauve)',
    fill: 'bg-mauve-fill',
    text: 'text-mauve-text',
  },
  {
    key: 'fixing',
    label: 'Fixing & debugging',
    accent: 'var(--tan)',
    fill: 'bg-tan-fill',
    text: 'text-tan-text',
  },
  {
    key: 'supporting',
    label: 'Supporting & responding',
    accent: 'var(--rose)',
    fill: 'bg-rose-fill',
    text: 'text-rose-text',
  },
];

// A loop qualifies for Section 1 only if the user actually touched it
// today. `updatedAt` is NOT a reliable signal — the background vault
// scanner rewrites it on every rescan, so it lights up for loops the
// user never opened. We use three real-action signals instead:
//   1. Closed today                       (doneAt)
//   2. User note created today            (notes[].createdAt, non-system)
//   3. Had a timeblock scheduled for today (timeblocks[].date)
function pickTouchedLoops(loops: Loop[], today: string): CheckpointTouchedLoop[] {
  const rows: CheckpointTouchedLoop[] = [];
  for (const l of loops) {
    const nonSystem = (l.notes ?? []).filter((n) => !n.system);
    const hasNoteToday = nonSystem.some(
      (n) => n.createdAt.slice(0, 10) === today,
    );
    const closedToday = (l.doneAt ?? '').slice(0, 10) === today;
    const scheduledToday = l.timeblocks.some((tb) => tb.date === today);
    if (!hasNoteToday && !closedToday && !scheduledToday) continue;

    // Latest note: prefer one written today, else the most recent
    // user note overall.
    const todayNotes = nonSystem.filter(
      (n) => n.createdAt.slice(0, 10) === today,
    );
    const pool = todayNotes.length > 0 ? todayNotes : nonSystem;
    const latestNote = pool.length > 0 ? pool[pool.length - 1].text : undefined;

    rows.push({
      loop_id: l.id,
      title: l.text,
      status: l.done ? (l.closedAs === 'dropped' ? 'dropped' : 'done') : l.tier,
      latest_note: latestNote
        ? latestNote.length > 120
          ? latestNote.slice(0, 120).trimEnd() + '…'
          : latestNote
        : undefined,
      annotation: undefined,
    });
  }
  return rows;
}

function makeTabId(): string {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  );
}

export function CheckpointModal({
  loops,
  onCompleted,
}: {
  loops: Loop[];
  onCompleted?: () => void;
}) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [open, setOpen] = useState(false);
  const [ownsLock, setOwnsLock] = useState(false);
  const tabIdRef = useRef<string>(makeTabId());
  const bcRef = useRef<BroadcastChannel | null>(null);

  // Tick every 60s and re-check whether the modal should appear.
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const id = setInterval(tick, 60_000);
    // Also tick when the tab regains focus so a laptop that slept
    // through 5pm catches up immediately.
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // BroadcastChannel election. If another tab signals it has taken
  // the modal we back off; if we close the modal we broadcast the
  // release.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
      return;
    }
    const bc = new BroadcastChannel('tend');
    bcRef.current = bc;
    bc.onmessage = (ev) => {
      if (ev.data?.kind === 'checkpoint:taken' && ev.data.tabId !== tabIdRef.current) {
        setOpen(false);
      }
    };
    return () => {
      bc.close();
      bcRef.current = null;
    };
  }, []);

  const today = todayLocalDate(new Date(nowMs));
  const existing = readCheckpoint(today);
  const nowLocal = new Date(nowMs);
  const hour = nowLocal.getHours();
  const pastCheckpoint = hour >= CHECKPOINT_HOUR;
  const pastSkip = hour >= SKIP_HOUR;

  // `forced` lets the skip banner's "Do it now" re-open the modal
  // even after 6pm. Toggled via localStorage so a tab refresh doesn't
  // lose the intent.
  const [forced, setForced] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LS_FORCE_OPEN) === today) {
        setForced(true);
      }
    } catch {}
    const onForce = () => setForced(true);
    window.addEventListener('tend:checkpoint:force', onForce);
    return () => window.removeEventListener('tend:checkpoint:force', onForce);
  }, [today]);

  // Decide whether to open. Rules:
  // - First-run guard: don't auto-open until the user has completed the
  //   FirstLaunchRitual. A stranger cloning the repo at 3:30pm shouldn't
  //   be greeted by "How did today go?" on a fresh install.
  // - If today's checkpoint exists and is complete (not skipped), don't open.
  // - If forced (user clicked "Do it now" on the skip banner), always
  //   try to acquire the lock regardless of hour.
  // - Otherwise: auto-open only in the 3pm-4pm window.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        if (window.localStorage.getItem('loops-ui:onboarded') !== '1') {
          if (open) setOpen(false);
          return;
        }
      } catch {
        /* non-fatal */
      }
    }
    const completedToday =
      !!existing && !existing.skipped && !!existing.completed_at;
    if (completedToday) {
      if (open) setOpen(false);
      return;
    }
    const shouldTryOpen = forced || (pastCheckpoint && !pastSkip);
    if (!shouldTryOpen) {
      if (open) setOpen(false);
      return;
    }
    if (!open) {
      const won = acquireCheckpointLock(tabIdRef.current);
      if (won) {
        setOwnsLock(true);
        setOpen(true);
        bcRef.current?.postMessage({
          kind: 'checkpoint:taken',
          tabId: tabIdRef.current,
        });
      }
    }
  }, [forced, pastCheckpoint, pastSkip, existing, open]);

  // Clear the force flag when the modal transitions from open → closed
  // (after submit or cancel). We track the previous open state to avoid
  // clearing forced before the modal ever opens.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (prevOpenRef.current && !open && forced) {
      try {
        window.localStorage.removeItem(LS_FORCE_OPEN);
      } catch {}
      setForced(false);
    }
    prevOpenRef.current = open;
  }, [open, forced]);

  // Release the lock on unmount.
  useEffect(() => {
    return () => {
      if (ownsLock) releaseCheckpointLock(tabIdRef.current);
    };
  }, [ownsLock]);

  // ─── Form state ────────────────────────────────────────────────
  const [touched, setTouched] = useState<CheckpointTouchedLoop[]>([]);
  useEffect(() => {
    if (open) setTouched(pickTouchedLoops(loops, today));
  }, [open, loops, today]);

  const [pressure, setPressure] = useState<Set<PressureKey>>(new Set());
  const [selectedIntent, setSelectedIntent] = useState<Set<string>>(new Set());
  const [freeIntentText, setFreeIntentText] = useState('');
  useEffect(() => {
    if (open) {
      setPressure(new Set());
      setSelectedIntent(new Set());
      setFreeIntentText('');
    }
  }, [open]);

  const p1Stakeholder = useMemo(() => countActiveP1Stakeholder(loops), [loops]);
  const p1Self = useMemo(() => countActiveP1Self(loops), [loops]);
  const overrides = useMemo(() => overrideCountThisWeek(new Date(nowMs)), [nowMs]);

  const activeChoices = useMemo(
    () => loops.filter((l) => !l.done).sort((a, b) => a.text.localeCompare(b.text)),
    [loops],
  );

  if (!open) return null;

  const canSubmit = pressure.size > 0;

  const toggleIntent = (id: string) => {
    setSelectedIntent((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 3) return prev;
        next.add(id);
      }
      return next;
    });
  };

  const setAnnotation = (idx: number, annotation: string) => {
    setTouched((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, annotation } : row)),
    );
  };

  const submit = () => {
    if (!canSubmit || pressure.size === 0) return;
    const cp: Checkpoint = {
      date: today,
      completed_at: new Date().toISOString(),
      skipped: false,
      loops_touched: touched,
      pressure: [...pressure],
      tomorrow_intent: [
        ...selectedIntent,
        ...freeIntentText.trim().split('\n').map(s => s.trim()).filter(Boolean),
      ],
    };
    writeCheckpoint(cp);
    releaseCheckpointLock(tabIdRef.current);
    setOwnsLock(false);
    setOpen(false);
    onCompleted?.();
  };

  const skipForNow = () => {
    // Soft escape hatch. Writes a skipped checkpoint for today, releases
    // the lock, removes the force flag (so the skip banner can take over
    // for the rest of the day), and closes. Different from auto-skip:
    // this is an explicit "not now" gesture, logged for the boundary log.
    const cp: Checkpoint = {
      date: today,
      skipped: true,
      loops_touched: [],
      pressure: null,
      tomorrow_intent: [],
    };
    writeCheckpoint(cp);
    appendBoundaryLog({
      type: 'checkpoint_skip',
      context: `User skipped checkpoint via modal on ${today}`,
    });
    try {
      window.localStorage.setItem('loops-ui:tend:checkpoint_skip_logged', today);
      window.localStorage.removeItem(LS_FORCE_OPEN);
    } catch {
      /* non-fatal */
    }
    releaseCheckpointLock(tabIdRef.current);
    setOwnsLock(false);
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Daily checkpoint"
      // Non-dismissible: no onClick handler on the backdrop, and no
      // Escape listener anywhere in this component.
      className="fixed inset-0 z-[70] flex items-center justify-center px-4 py-8"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[3px]" aria-hidden />
      <div
        className="relative w-[680px] max-w-full max-h-full bg-elevated border border-edge rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-6 pt-5 pb-4 border-b border-edge-subtle shrink-0">
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost">
            Tend — daily checkpoint
          </div>
          <div className="text-[17px] font-medium text-ink mt-1">
            How did today go?
          </div>
          <div className="text-[11px] text-ink-faint mt-1.5">
            Three quick sections. Skip if you're not ready.
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle">
          {/* Section 1 — What happened today */}
          <section className="px-6 py-5 border-b border-edge-subtle">
            <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-3">
              1 · What happened today
            </div>
            {touched.length === 0 ? (
              <div className="text-[12px] text-ink-faint italic">
                No loops touched today.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {touched.map((row, idx) => (
                  <li
                    key={row.loop_id}
                    className="bg-inset rounded-md px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <span className="flex-1 min-w-0 text-[12px] text-ink leading-relaxed">
                        {row.title}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-ink-ghost font-mono shrink-0">
                        {row.status}
                      </span>
                    </div>
                    {row.latest_note && (
                      <div className="text-[11px] text-ink-faint italic leading-relaxed mt-1">
                        &ldquo;{row.latest_note}&rdquo;
                      </div>
                    )}
                    <input
                      type="text"
                      value={row.annotation ?? ''}
                      onChange={(e) => setAnnotation(idx, e.target.value)}
                      placeholder="one-line annotation (optional)…"
                      className="w-full text-[11px] text-ink bg-card border border-edge rounded px-2 py-1 mt-2 placeholder:text-ink-ghost/60 focus:outline-none focus:border-[var(--slate)]/50"
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Section 2 — Pressure check */}
          <section className="px-6 py-5 border-b border-edge-subtle">
            <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-3">
              2 · What kind of work? <span className="text-rose-text">*</span>
            </div>
            <div className="flex flex-col gap-2">
              {PRESSURE_OPTIONS.map((opt) => {
                const active = pressure.has(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setPressure((prev) => {
                      const next = new Set(prev);
                      if (next.has(opt.key)) next.delete(opt.key);
                      else next.add(opt.key);
                      return next;
                    })}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-md border-[0.5px] transition-all text-left ${
                      active
                        ? `${opt.fill} ${opt.text} border-[${opt.accent}]/60 shadow-[inset_0_0_0_1px_${opt.accent}]`
                        : 'bg-card text-ink-soft border-edge hover:border-edge-hover hover:bg-inset'
                    }`}
                    style={
                      active
                        ? { borderColor: opt.accent, boxShadow: `inset 0 0 0 1px ${opt.accent}` }
                        : undefined
                    }
                  >
                    <span
                      className="w-[10px] h-[10px] rounded-full shrink-0"
                      style={{ background: opt.accent }}
                      aria-hidden
                    />
                    <span className="text-[12px] font-medium">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Section 3 — Tomorrow's intent */}
          <section className="px-6 py-5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost mb-2">
              3 · Tomorrow&rsquo;s intent <span className="text-rose-text">*</span>
            </div>
            <div className="text-[11px] text-ink-faint mb-3 leading-relaxed">
              Pick 1–3 loops. Current state:{' '}
              <span className="font-mono tabular-nums">
                {P1_STAKEHOLDER} {p1Stakeholder}
              </span>
              {' · '}
              <span className="font-mono tabular-nums">
                P1:self {p1Self}
              </span>
              {' · '}
              <span className="font-mono tabular-nums">
                {overrides} override{overrides === 1 ? '' : 's'} this week
              </span>
            </div>
            <div className="max-h-[220px] overflow-y-auto scrollbar-subtle border border-edge-subtle rounded-md">
              <ul className="flex flex-col">
                {activeChoices.map((l) => {
                  const active = selectedIntent.has(l.id);
                  const full = !active && selectedIntent.size >= 3;
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        onClick={() => toggleIntent(l.id)}
                        disabled={full}
                        className={`w-full text-left flex items-center gap-3 px-3 py-2 border-b border-edge-subtle last:border-b-0 transition-colors ${
                          active
                            ? 'bg-mauve-fill text-mauve-text'
                            : 'hover:bg-inset text-ink-soft'
                        } ${full ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        <span
                          className={`w-[12px] h-[12px] rounded-sm border shrink-0 flex items-center justify-center ${
                            active
                              ? 'border-[var(--mauve)] bg-[var(--mauve)]'
                              : 'border-edge'
                          }`}
                          aria-hidden
                        >
                          {active && (
                            <span
                              className="block w-[6px] h-[6px] rounded-full"
                              style={{ background: 'white' }}
                            />
                          )}
                        </span>
                        <span className="flex-1 min-w-0 text-[12px] truncate">
                          {renderInlineMarkdown(l.text)}
                        </span>
                        {l.pLevel && (
                          <span className="text-[9px] font-mono text-ink-ghost shrink-0">
                            {l.pLevel}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="text-[10px] text-ink-ghost tabular-nums font-mono mt-1.5">
              {selectedIntent.size}/3 selected
            </div>
            <textarea
              value={freeIntentText}
              onChange={(e) => setFreeIntentText(e.target.value)}
              placeholder="or type tomorrow's intent here (one per line)"
              rows={2}
              className="mt-3 w-full text-[12px] bg-inset border border-edge rounded-md px-3 py-2 text-ink placeholder:text-ink-ghost/50 focus:outline-none focus:ring-1 focus:ring-[var(--slate)] resize-none"
            />
          </section>
        </div>

        <div className="px-6 py-3 border-t border-edge-subtle flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={skipForNow}
            className="text-[11px] text-ink-ghost hover:text-ink-soft underline-offset-2 hover:underline transition-colors"
          >
            Skip for now
          </button>
          <div className="flex items-center gap-3">
            <div className="text-[10px] text-ink-ghost">
              {canSubmit ? 'Ready' : 'Pick a pressure read above to continue'}
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="text-[12px] text-ink bg-inset hover:bg-[var(--mauve)]/10 hover:text-mauve-text px-4 py-1.5 rounded-md border-[0.5px] border-edge hover:border-[var(--mauve)]/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-inset disabled:hover:text-ink disabled:hover:border-edge transition-all"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Note: the "selected" indicator inside the intent checkbox is a
// plain CSS white dot — no Unicode check-mark, no emoji.
