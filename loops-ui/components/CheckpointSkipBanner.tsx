'use client';

// CheckpointSkipBanner: a persistent top-of-app banner that surfaces
// skipped checkpoints — today's (after the skip hour) plus yesterday's
// if the user forgot. Today's banner offers "Do it now" which force-
// opens the full checkpoint modal. Yesterday's banner offers an inline
// 3-button pressure picker so the heatmap gets a cell without having
// to reconstruct all three sections of the full modal.

import { useEffect, useMemo, useState } from 'react';
import type { Checkpoint } from '@/lib/types';
import {
  appendBoundaryLog,
  readCheckpoint,
  TEND_EVENT,
  todayLocalDate,
  writeCheckpoint,
} from '@/lib/tend';

const SKIP_HOUR = 16; // 4pm local — matches CheckpointModal

type Pressure = 'building' | 'improving' | 'fixing' | 'supporting';

const PRESSURE_OPTIONS: { key: Pressure; label: string; accent: string }[] = [
  { key: 'building', label: 'building', accent: 'var(--sage)' },
  { key: 'improving', label: 'improving', accent: 'var(--mauve)' },
  { key: 'fixing', label: 'fixing', accent: 'var(--tan)' },
  { key: 'supporting', label: 'supporting', accent: 'var(--rose)' },
];

function yesterdayLocalDate(reference: Date): string {
  const d = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() - 1,
  );
  return todayLocalDate(d);
}

export function CheckpointSkipBanner() {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const refresh = () => setVersion((v) => v + 1);
    window.addEventListener(TEND_EVENT, refresh);
    return () => window.removeEventListener(TEND_EVENT, refresh);
  }, []);

  const today = todayLocalDate(new Date(nowMs));
  const yesterday = useMemo(() => yesterdayLocalDate(new Date(nowMs)), [nowMs]);
  const nowLocal = new Date(nowMs);
  const hour = nowLocal.getHours();
  const pastSkip = hour >= SKIP_HOUR;
  const todayCp = readCheckpoint(today);
  const yesterdayCp = readCheckpoint(yesterday);
  const completed = !!todayCp?.completed_at && !todayCp.skipped;

  // Auto-mark today's skip exactly once per day once the skip hour
  // passes. Three guards beyond the obvious:
  //   1. First-run: don't auto-skip (or stack boundary-log entries) until
  //      the user has completed the FirstLaunchRitual. A stranger cloning
  //      the repo at 5pm shouldn't have "Checkpoint skipped today" land
  //      before they've used the app.
  //   2. `checkpoint_force_open === today` means the user just hit "Do
  //      it now" to reopen the modal. Don't immediately re-skip.
  //   3. `checkpoint_skip_logged === today` means we already wrote a
  //      boundary-log entry for today's skip. Don't stack duplicates.
  useEffect(() => {
    if (!pastSkip) return;
    if (completed) return;
    if (todayCp?.skipped) return;
    try {
      if (window.localStorage.getItem('loops-ui:onboarded') !== '1') return;
      const forceOpen = window.localStorage.getItem(
        'loops-ui:tend:checkpoint_force_open',
      );
      if (forceOpen === today) return;
    } catch {
      /* non-fatal */
    }
    const skipped: Checkpoint = {
      date: today,
      skipped: true,
      loops_touched: [],
      pressure: null,
      tomorrow_intent: [],
    };
    writeCheckpoint(skipped);
    let alreadyLogged = false;
    try {
      alreadyLogged =
        window.localStorage.getItem('loops-ui:tend:checkpoint_skip_logged') ===
        today;
    } catch {
      /* non-fatal */
    }
    if (!alreadyLogged) {
      appendBoundaryLog({
        type: 'checkpoint_skip',
        context: `Checkpoint skipped on ${today}`,
      });
      try {
        window.localStorage.setItem(
          'loops-ui:tend:checkpoint_skip_logged',
          today,
        );
      } catch {
        /* non-fatal */
      }
    }
  }, [pastSkip, completed, todayCp, today, version]);

  void version;

  // A "backfillable" yesterday is one that was marked skipped AND
  // never recorded a pressure read. If the user has already answered
  // a prior banner we leave the cell alone.
  const yesterdayBackfillable =
    !!yesterdayCp &&
    yesterdayCp.skipped === true &&
    yesterdayCp.pressure == null;

  const showTodaySkip = pastSkip && !completed && !!todayCp?.skipped;

  // First-run guard: hide the banner entirely until the user has
  // completed the FirstLaunchRitual. The banner's "Checkpoint skipped
  // today" framing is meaningless on a fresh install.
  let onboarded = false;
  try {
    onboarded = typeof window !== 'undefined' &&
      window.localStorage.getItem('loops-ui:onboarded') === '1';
  } catch {
    /* non-fatal */
  }

  if (!onboarded) return null;
  if (!showTodaySkip && !yesterdayBackfillable) return null;

  const doItNow = () => {
    const all = JSON.parse(
      window.localStorage.getItem('loops-ui:tend:checkpoints') ?? '{}',
    );
    delete all[today];
    window.localStorage.setItem(
      'loops-ui:tend:checkpoints',
      JSON.stringify(all),
    );
    window.localStorage.setItem('loops-ui:tend:checkpoint_force_open', today);
    // Clear any stale checkpoint lock so the modal can always open.
    window.localStorage.removeItem('loops-ui:tend:checkpoint_lock');
    // Let the auto-skip effect know we already logged a skip for today
    // so it doesn't immediately re-mark and stack a duplicate.
    window.localStorage.setItem('loops-ui:tend:checkpoint_skip_logged', today);
    window.dispatchEvent(new CustomEvent('tend:checkpoint:force'));
    window.dispatchEvent(
      new CustomEvent(TEND_EVENT, { detail: { kind: 'checkpoint' } }),
    );
    // Only log a reopen once per day, otherwise repeated clicks on
    // "Do it now" flood the boundary log.
    const already =
      window.localStorage.getItem('loops-ui:tend:checkpoint_reopen_logged') ===
      today;
    if (!already) {
      appendBoundaryLog({
        type: 'checkpoint_skip',
        context: `User re-opened skipped checkpoint for ${today}`,
      });
      window.localStorage.setItem(
        'loops-ui:tend:checkpoint_reopen_logged',
        today,
      );
    }
  };

  const backfillYesterday = (pressure: Pressure) => {
    const cp: Checkpoint = {
      date: yesterday,
      completed_at: new Date().toISOString(),
      skipped: false,
      loops_touched: [],
      pressure: [pressure],
      tomorrow_intent: [],
    };
    writeCheckpoint(cp);
    appendBoundaryLog({
      type: 'checkpoint_skip',
      context: `Backfilled pressure=${pressure} for ${yesterday}`,
    });
  };

  const dismissYesterday = () => {
    // Mark yesterday as deliberately not backfilled so the banner
    // stops surfacing it. Stores a sentinel pressure of null + keeps
    // skipped=true but stamps completed_at so the "pressure == null"
    // gate above flips false.
    const cp: Checkpoint = {
      date: yesterday,
      completed_at: new Date().toISOString(),
      skipped: true,
      loops_touched: [],
      pressure: null,
      tomorrow_intent: [],
    };
    writeCheckpoint(cp);
  };

  return (
    <div
      role="status"
      className="sticky top-0 z-[40] border-b border-[var(--rose)]/30 bg-rose-fill text-rose-text"
    >
      {showTodaySkip && (
        <button
          type="button"
          onClick={doItNow}
          className="w-full px-5 py-1.5 flex items-center justify-between gap-4 text-[11px] border-b border-[var(--rose)]/20 hover:bg-rose-fill/80 transition-colors cursor-pointer text-left"
        >
          <div className="flex items-center gap-2">
            <span
              className="w-[6px] h-[6px] rounded-full"
              style={{ background: 'var(--rose)' }}
              aria-hidden
            />
            <span className="font-medium">Checkpoint skipped today.</span>
            <span className="opacity-80">
              No pressure read logged — tomorrow&rsquo;s badges will be blank.
            </span>
          </div>
          <span className="underline underline-offset-2 shrink-0">
            Do it now
          </span>
        </button>
      )}
      {yesterdayBackfillable && (
        <div className="px-5 py-1.5 flex items-center justify-between gap-4 text-[11px]">
          <div className="flex items-center gap-2">
            <span
              className="w-[6px] h-[6px] rounded-full opacity-60"
              style={{ background: 'var(--rose)' }}
              aria-hidden
            />
            <span className="font-medium">Yesterday was skipped.</span>
            <span className="opacity-80">Backfill the pressure read:</span>
          </div>
          <div className="flex items-center gap-1.5">
            {PRESSURE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => backfillYesterday(opt.key)}
                className="flex items-center gap-1.5 text-[11px] text-ink-soft hover:text-ink px-2 py-0.5 rounded-md border border-edge hover:border-[var(--slate)]/40 bg-card transition-colors"
                title={`Mark yesterday as ${opt.label}`}
              >
                <span
                  className="w-[6px] h-[6px] rounded-full"
                  style={{ background: opt.accent }}
                  aria-hidden
                />
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              onClick={dismissYesterday}
              className="text-[11px] text-ink-ghost hover:text-ink-soft px-2 py-0.5 rounded-md hover:bg-card/40 transition-colors"
              title="Dismiss without backfilling"
            >
              dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
