'use client';

// TriageView — the keyboard-driven intake gate.
//
// Loops with status === 'triage' are processed one at a time in Card
// mode (default) or scanned in List mode (M to toggle). Each card
// shows the loop + the heuristic seeder's recommendation; the user
// accepts (1), someday (2), drops (3), snoozes (H), overrides
// priority (↑/↓), sets stakeholder (S), opens the detail drawer (D),
// undoes (Z), or skips (Space). The capacity gate fires when
// accepting a loop would push P1 or P2 past its flat cap.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Loop,
  TriageDecision,
  TriagePriority,
  TriageRecommendation,
} from '@/lib/types';
import { STAKEHOLDERS, type Stakeholder } from '@/lib/ui';
import { composePLevel } from '@/lib/types';
import { appendBoundaryLog } from '@/lib/tend';
import {
  P1_FLAT_CAP,
  P2_FLAT_CAP,
  checkCapacityGate,
  countFlatPriority,
} from '@/lib/tend-gates';
import { seedLoop } from '@/lib/tend-triage-seed';
import { renderInlineMarkdown } from '@/lib/markdown';
import { CapacityGateModal } from './CapacityGateModal';

type Disposition = 'accept' | 'someday' | 'drop' | 'snooze';

type DecisionLogEntry = {
  loop_id: string;
  previous: Partial<Loop>;
};

interface SessionCounts {
  processed: number;
  accepted: number;
  someday: number;
  dropped: number;
  snoozed: number;
  skipped: number;
  matchedAi: number;
  overcommitShown: boolean;
}

const EMPTY_COUNTS: SessionCounts = {
  processed: 0,
  accepted: 0,
  someday: 0,
  dropped: 0,
  snoozed: 0,
  skipped: 0,
  matchedAi: 0,
  overcommitShown: false,
};

const OVERCOMMIT_THRESHOLD = 20;
const OVERCOMMIT_RATE = 0.8;

export function TriageView({
  loops,
  onRefetch,
  onOpenDetail,
  onUpdateLoop,
  onSwitchToBacklog,
}: {
  loops: Loop[];
  onRefetch: () => Promise<void>;
  onOpenDetail: (id: string) => void;
  onUpdateLoop?: (id: string, patch: Partial<Loop>) => Promise<void>;
  onSwitchToBacklog?: () => void;
}) {
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [queueIdx, setQueueIdx] = useState(0);
  const [counts, setCounts] = useState<SessionCounts>(EMPTY_COUNTS);
  // Persistent pending priority — always editable with ↑/↓. Resets
  // to the suggested priority whenever the focused card changes.
  const [pendingPriority, setPendingPriority] = useState<TriagePriority | null>(null);
  // Cards the user has skipped this session — filtered out of the
  // primary queue so they don't come back into focus when the queue
  // shrinks from accepts. Comes back only if every unskipped card
  // has been processed.
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [undoStack, setUndoStack] = useState<DecisionLogEntry[]>([]);
  const [capacityGate, setCapacityGate] = useState<{
    open: boolean;
    kind: 'P1-cap' | 'P2-cap';
    currentCount: number;
    max: number;
    pending: (() => Promise<void>) | null;
    title: string;
  }>({ open: false, kind: 'P1-cap', currentCount: 0, max: 0, pending: null, title: '' });
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [stakeholderOpen, setStakeholderOpen] = useState(false);
  const [flashKind, setFlashKind] = useState<'match' | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  // Live triage queue — stable within a render, recomputed when the
  // loops array changes (after every save). Filters out:
  //  - done / dropped loops
  //  - loops snoozed until a future date (come back when time passes)
  //  - skipped-this-session loops are pushed to the end, not removed
  const queue = useMemo(() => {
    const now = Date.now();
    const all = loops.filter((l) => {
      if (l.done) return false;
      if (l.status !== 'triage') return false;
      if (l.snooze_until && Date.parse(l.snooze_until) > now) return false;
      return true;
    });
    const unskipped = all.filter((l) => !skippedIds.has(l.id));
    const skipped = all.filter((l) => skippedIds.has(l.id));
    return [...unskipped, ...skipped];
  }, [loops, skippedIds]);

  const current = queue[queueIdx] ?? null;
  const remaining = queue.length;

  // Keep queueIdx in range as the queue shrinks.
  useEffect(() => {
    if (queueIdx >= queue.length && queue.length > 0) {
      setQueueIdx(queue.length - 1);
    }
    if (queue.length === 0) setQueueIdx(0);
  }, [queue.length, queueIdx]);

  // Whenever the focused card changes, reset the pending priority to
  // whatever the seeder suggested (fall back to current priority → P3).
  const currentId = queue[queueIdx]?.id;
  useEffect(() => {
    if (!currentId) {
      setPendingPriority(null);
      return;
    }
    const loop = queue[queueIdx];
    if (!loop) return;
    const suggested =
      loop.ai_recommendation?.suggested_priority ??
      (loop.priority as TriagePriority | null) ??
      'P3';
    setPendingPriority(suggested);
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Seeding pipeline ────────────────────────────────────────────
  // Recommendations are computed on-render in CardSurface and the
  // list row renderer via seedLoop() + useMemo. Not persisted back
  // into loops.json — the heuristic is deterministic and fast enough
  // to recompute each render. Re-analyze just forces a re-render.
  const reAnalyze = useCallback(() => {
    // The on-render fallback will recompute automatically. If any
    // loops still have a persisted ai_recommendation from the old
    // background pipeline, clear it so the fresh heuristic shows.
    if (!onUpdateLoop) return;
    for (const l of queue) {
      if (l.ai_recommendation) onUpdateLoop(l.id, { ai_recommendation: null });
    }
  }, [queue, onUpdateLoop]);

  // ── Decision recording ─────────────────────────────────────────
  const flashMatch = useCallback(() => {
    setFlashKind('match');
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashKind(null), 200);
  }, []);

  const bumpCounts = useCallback(
    (disposition: Disposition, matched: boolean) => {
      setCounts((c) => ({
        ...c,
        processed: c.processed + 1,
        accepted: c.accepted + (disposition === 'accept' ? 1 : 0),
        someday: c.someday + (disposition === 'someday' ? 1 : 0),
        dropped: c.dropped + (disposition === 'drop' ? 1 : 0),
        snoozed: c.snoozed + (disposition === 'snooze' ? 1 : 0),
        matchedAi: c.matchedAi + (matched ? 1 : 0),
      }));
    },
    [],
  );

  const advance = useCallback(() => {
    // The queue will shrink once the backing store reflects the
    // save; until then, we just leave the index where it is — the
    // useEffect above clamps it to the new length.
    setQueueIdx((idx) => idx + 1);
  }, []);

  const commitDecision = useCallback(
    async (
      loop: Loop,
      decision: TriageDecision,
      targetStatus: Loop['status'],
      extraPatch: Partial<Loop> = {},
    ) => {
      if (!onUpdateLoop) return;
      const previous: Partial<Loop> = {
        status: loop.status,
        priority: loop.priority,
        stakeholder: loop.stakeholder,
        pLevel: loop.pLevel,
        triage_decision: loop.triage_decision,
        ai_recommendation: loop.ai_recommendation,
        snooze_until: loop.snooze_until,
      };
      setUndoStack((s) => [...s, { loop_id: loop.id, previous }]);
      const patch: Partial<Loop> = {
        status: targetStatus,
        triage_decision: decision,
        // Clear the recommendation — it's been used.
        ai_recommendation: null,
        ...extraPatch,
      };
      // Keep pLevel in sync with the new flat fields so legacy
      // code paths (filters, capacity gate) keep working.
      if (decision.disposition === 'accept') {
        patch.priority = decision.priority ?? null;
        patch.stakeholder = decision.stakeholder ?? null;
        patch.pLevel = composePLevel(decision.priority, decision.stakeholder);
      }
      await onUpdateLoop(loop.id, patch);
      const matched =
        loop.ai_recommendation?.suggested_disposition === decision.disposition;
      bumpCounts(decision.disposition, matched);
      if (matched) flashMatch();
      advance();
    },
    [onUpdateLoop, bumpCounts, flashMatch, advance],
  );

  // ── Action handlers ────────────────────────────────────────────
  // Accept is one keystroke. Priority comes from the pending-priority
  // state (default = seeder suggestion, editable via ↑/↓). Stakeholder
  // comes from the loop or seeder; edit later in detail drawer.
  const startAccept = useCallback(async () => {
    if (!current) return;
    const rec = current.ai_recommendation;
    const priority: TriagePriority =
      pendingPriority ??
      (current.priority as TriagePriority | null) ??
      rec?.suggested_priority ??
      'P3';
    const stakeholder =
      current.stakeholder ?? rec?.suggested_stakeholder ?? null;
    await confirmAcceptInline(priority, stakeholder);
  }, [current, pendingPriority]); // eslint-disable-line react-hooks/exhaustive-deps

  const cyclePendingPriority = useCallback((dir: 1 | -1) => {
    setPendingPriority((p) => {
      const order: TriagePriority[] = ['P0', 'P1', 'P2', 'P3'];
      const idx = Math.max(0, order.indexOf(p ?? 'P3'));
      const next = order[(idx + dir + order.length) % order.length];
      return next;
    });
  }, []);

  const confirmAcceptInline = useCallback(
    async (priority: TriagePriority, stakeholder: string | null) => {
      if (!current) return;
      // Capacity gate — delegated to lib/tend-gates so the threshold
      // lives in one place. Only P1/P2 accepts can fire the flat cap.
      const gate = checkCapacityGate(
        { lastScanned: '', loops },
        { priority, stakeholder },
      );
      const wouldExceed = !gate.ok;
      const ctx = (gate.ok ? {} : gate.context ?? {}) as {
        current?: number;
        max?: number;
      };
      const already = ctx.current ?? 0;
      const cap = ctx.max ?? (priority === 'P1' ? P1_FLAT_CAP : P2_FLAT_CAP);

      const decision: TriageDecision = {
        disposition: 'accept',
        priority,
        stakeholder,
        matched_ai:
          current.ai_recommendation?.suggested_disposition === 'accept',
        decided_at: new Date().toISOString(),
      };

      const doCommit = async () => {
        await commitDecision(current, decision, 'active');
      };

      if (wouldExceed) {
        setCapacityGate({
          open: true,
          kind: priority === 'P1' ? 'P1-cap' : 'P2-cap',
          currentCount: already,
          max: cap,
          pending: doCommit,
          title: current.text,
        });
        return;
      }
      await doCommit();
    },
    [current, loops, commitDecision],
  );

  const handleSomeday = useCallback(async () => {
    if (!current) return;
    await commitDecision(
      current,
      {
        disposition: 'someday',
        matched_ai:
          current.ai_recommendation?.suggested_disposition === 'someday',
        decided_at: new Date().toISOString(),
      },
      'someday',
    );
  }, [current, commitDecision]);

  const handleDrop = useCallback(async () => {
    if (!current) return;
    await commitDecision(
      current,
      {
        disposition: 'drop',
        matched_ai:
          current.ai_recommendation?.suggested_disposition === 'drop',
        decided_at: new Date().toISOString(),
      },
      'dropped',
    );
  }, [current, commitDecision]);

  const handleSnooze = useCallback(
    async (days: number) => {
      if (!current) return;
      const until = new Date();
      until.setDate(until.getDate() + days);
      const snoozeUntilIso = until.toISOString();
      await commitDecision(
        current,
        {
          disposition: 'snooze',
          matched_ai:
            current.ai_recommendation?.suggested_disposition === 'snooze',
          decided_at: new Date().toISOString(),
          snooze_until: snoozeUntilIso,
        },
        // Snoozed items stay in triage status so they re-appear
        // once the date passes; the daily reaper clears
        // snooze_until when it's time.
        'triage',
        { snooze_until: snoozeUntilIso },
      );
      setSnoozeOpen(false);
    },
    [current, commitDecision],
  );

  const handleSkip = useCallback(() => {
    if (!current) return;
    // Skip = move this card to the end of the queue by adding its id
    // to the skipped set. The queue useMemo places skipped ids after
    // the unskipped ones, so the user only sees skipped cards once
    // every un-skipped card has been processed.
    setSkippedIds((s) => {
      const next = new Set(s);
      next.add(current.id);
      return next;
    });
    setCounts((c) => ({ ...c, skipped: c.skipped + 1 }));
    // Don't advance the index — the card at this slot will naturally
    // become the next un-skipped one once the queue recomputes.
  }, [current]);

  const handleUndo = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last || !onUpdateLoop) return;
    await onUpdateLoop(last.loop_id, last.previous);
    setUndoStack((s) => s.slice(0, -1));
    // Roll the index back so the user sees what they undid.
    setQueueIdx((idx) => Math.max(0, idx - 1));
    setCounts((c) => ({ ...c, processed: Math.max(0, c.processed - 1) }));
  }, [undoStack, onUpdateLoop]);

  const setStakeholder = useCallback(
    async (name: string | null) => {
      if (!current || !onUpdateLoop) return;
      await onUpdateLoop(current.id, { stakeholder: name });
      setStakeholderOpen(false);
    },
    [current, onUpdateLoop],
  );

  // ── Keyboard handler ───────────────────────────────────────────
  useEffect(() => {
    if (viewMode !== 'card') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
        return;
      if (capacityGate.open || snoozeOpen || stakeholderOpen) return;
      if (!current) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        cyclePendingPriority(-1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cyclePendingPriority(1);
        return;
      }

      switch (e.key) {
        case '1':
          e.preventDefault();
          startAccept();
          break;
        case '2':
          e.preventDefault();
          handleSomeday();
          break;
        case '3':
          e.preventDefault();
          handleDrop();
          break;
        case 'h':
        case 'H':
          e.preventDefault();
          setSnoozeOpen(true);
          break;
        case 's':
        case 'S':
          e.preventDefault();
          setStakeholderOpen(true);
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          onOpenDetail(current.id);
          break;
        case 'z':
        case 'Z':
          e.preventDefault();
          handleUndo();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          setViewMode('list');
          break;
        case ' ':
          e.preventDefault();
          handleSkip();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    viewMode,
    current,
    capacityGate.open,
    snoozeOpen,
    stakeholderOpen,
    cyclePendingPriority,
    startAccept,
    handleSomeday,
    handleDrop,
    handleUndo,
    handleSkip,
    onOpenDetail,
  ]);

  // Overcommit nudge detector.
  const overcommit = useMemo(() => {
    if (counts.overcommitShown) return false;
    if (counts.processed < OVERCOMMIT_THRESHOLD) return false;
    const rate = counts.accepted / counts.processed;
    return rate > OVERCOMMIT_RATE;
  }, [counts]);

  useEffect(() => {
    if (overcommit) {
      setCounts((c) => ({ ...c, overcommitShown: true }));
      appendBoundaryLog({
        type: 'capacity_override',
        context: `Triage overcommit nudge — ${counts.accepted}/${counts.processed} accepted so far`,
      });
    }
  }, [overcommit, counts.accepted, counts.processed]);

  // Void onRefetch for future re-analyze flows that might need a hard refresh.
  void onRefetch;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden bg-page">
      <TriageProgress
        counts={counts}
        remaining={remaining}
        seeding={false}
        mode={viewMode}
        onSetMode={setViewMode}
        onReAnalyze={reAnalyze}
        onSwitchToBacklog={onSwitchToBacklog}
      />
      {overcommit && <OvercommitNudge counts={counts} />}

      {viewMode === 'card' ? (
        current ? (
          <CardSurface
            loop={current}
            allLoops={loops}
            flashKind={flashKind}
            pendingPriority={pendingPriority}
            onAccept={startAccept}
            onCyclePriority={cyclePendingPriority}
          />
        ) : (
          <EmptyState counts={counts} />
        )
      ) : (
        <ListSurface
          queue={queue}
          onFocus={(id) => {
            const idx = queue.findIndex((l) => l.id === id);
            if (idx >= 0) {
              setQueueIdx(idx);
              setViewMode('card');
            }
          }}
        />
      )}

      <SnoozePicker
        open={snoozeOpen}
        onCancel={() => setSnoozeOpen(false)}
        onPick={(days) => handleSnooze(days)}
      />
      <StakeholderQuickSelect
        open={stakeholderOpen}
        onCancel={() => setStakeholderOpen(false)}
        onPick={(name) => setStakeholder(name === 'None' ? null : name)}
      />

      <CapacityGateModal
        open={capacityGate.open}
        kind={capacityGate.kind}
        currentCount={capacityGate.currentCount}
        max={capacityGate.max}
        pendingTitle={capacityGate.title}
        onCancel={() => setCapacityGate((g) => ({ ...g, open: false, pending: null }))}
        onProceed={async (reason) => {
          const pending = capacityGate.pending;
          const kind = capacityGate.kind;
          const max = capacityGate.max;
          setCapacityGate((g) => ({ ...g, open: false, pending: null }));
          appendBoundaryLog({
            type: 'capacity_override',
            context: `Triage accept past the ${kind} ${max}-loop cap`,
            reason,
          });
          if (pending) await pending();
        }}
      />
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────

function TriageProgress({
  counts,
  remaining,
  seeding,
  mode,
  onSetMode,
  onReAnalyze,
  onSwitchToBacklog,
}: {
  counts: SessionCounts;
  remaining: number;
  seeding: boolean;
  mode: 'card' | 'list';
  onSetMode: (m: 'card' | 'list') => void;
  onReAnalyze: () => void;
  onSwitchToBacklog?: () => void;
}) {
  const total = counts.processed + remaining;
  return (
    <div className="px-5 py-3 flex items-center gap-3 border-b border-edge-subtle bg-page/90 flex-wrap shrink-0">
      <div className="text-[12px] text-ink">
        <span className="tabular-nums font-medium">{counts.processed}</span>{' '}
        / <span className="tabular-nums">{total}</span>{' '}
        <span className="text-ink-ghost">processed</span>
      </div>
      <div className="text-[11px] text-ink-soft flex items-center gap-2">
        <DispCount label="accepted" n={counts.accepted} tone="sage" />
        <DispCount label="someday" n={counts.someday} tone="slate" />
        <DispCount label="dropped" n={counts.dropped} tone="rose" />
        <DispCount label="snoozed" n={counts.snoozed} tone="tan" />
      </div>
      {seeding && (
        <div className="text-[10px] text-ink-ghost italic">
          Analyzing remaining loops...
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        {onSwitchToBacklog && (
          <button
            type="button"
            onClick={onSwitchToBacklog}
            className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 rounded-md bg-card border border-edge hover:border-edge-hover transition-colors"
            title="View all active loops grouped by mode, size, or domain"
          >
            Backlog
          </button>
        )}
        <button
          type="button"
          onClick={onReAnalyze}
          className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 rounded-md bg-card border border-edge hover:border-edge-hover transition-colors"
          title="Clear recommendations on un-processed triage items and re-seed"
        >
          Re-analyze
        </button>
        <div className="flex items-center gap-0 rounded-md bg-inset p-0.5">
          <button
            type="button"
            onClick={() => onSetMode('card')}
            className={`px-2.5 py-0.5 rounded text-[11px] transition-all ${
              mode === 'card'
                ? 'bg-card text-ink font-medium'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            Card
          </button>
          <button
            type="button"
            onClick={() => onSetMode('list')}
            className={`px-2.5 py-0.5 rounded text-[11px] transition-all ${
              mode === 'list'
                ? 'bg-card text-ink font-medium'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            List
          </button>
        </div>
      </div>
    </div>
  );
}

function DispCount({
  label,
  n,
  tone,
}: {
  label: string;
  n: number;
  tone: 'sage' | 'slate' | 'rose' | 'tan';
}) {
  if (n === 0) return null;
  const cls =
    tone === 'sage'
      ? 'bg-sage-fill text-sage-text'
      : tone === 'slate'
        ? 'bg-slate-fill text-slate-text'
        : tone === 'rose'
          ? 'bg-rose-fill text-rose-text'
          : 'bg-tan-fill text-tan-text';
  return (
    <span className={`px-1.5 py-0.5 rounded tabular-nums ${cls}`}>
      {n} {label}
    </span>
  );
}

function OvercommitNudge({ counts }: { counts: SessionCounts }) {
  const rate = Math.round((counts.accepted / counts.processed) * 100);
  return (
    <div className="mx-5 mt-3 rounded-md border border-[var(--tan)]/30 bg-tan-fill px-3 py-2 text-[11px] text-tan-text">
      You&apos;ve accepted {counts.accepted} of {counts.processed} ({rate}%) so
      far. Is the bar high enough?
    </div>
  );
}

function EmptyState({ counts }: { counts: SessionCounts }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <h2 className="text-[18px] font-medium text-ink mb-2">Inbox zero.</h2>
        <p className="text-[12px] text-ink-ghost leading-relaxed">
          Processed {counts.processed} this session —{' '}
          {counts.accepted} accepted, {counts.someday} someday&apos;d,{' '}
          {counts.dropped} dropped, {counts.snoozed} snoozed.
        </p>
      </div>
    </div>
  );
}

function CardSurface({
  loop,
  allLoops,
  flashKind,
  pendingPriority,
  onAccept,
  onCyclePriority,
}: {
  loop: Loop;
  allLoops: Loop[];
  flashKind: 'match' | null;
  pendingPriority: TriagePriority | null;
  onAccept: () => void;
  onCyclePriority: (dir: 1 | -1) => void;
}) {
  // Compute a local fallback recommendation synchronously if the
  // persisted one hasn't landed yet — keeps the card from flashing
  // "Analyzing..." while the background seeder round-trips.
  const rec = useMemo(() => {
    if (loop.ai_recommendation) return loop.ai_recommendation;
    try {
      return seedLoop(loop, {
        p1Count: countFlatPriority(allLoops, 'P1'),
        p2Count: countFlatPriority(allLoops, 'P2'),
        p3Count: countFlatPriority(allLoops, 'P3'),
        p1Cap: P1_FLAT_CAP,
        p2Cap: P2_FLAT_CAP,
        allLoops,
      });
    } catch {
      return null;
    }
  }, [loop, allLoops]);

  const currentPriorityLabel = loop.pLevel ?? loop.priority ?? '—';
  const currentStakeholder = loop.stakeholder ?? '—';
  const targetPriority = pendingPriority ?? rec?.suggested_priority ?? 'P3';
  const targetStakeholder =
    loop.stakeholder ?? rec?.suggested_stakeholder ?? null;
  const flashClass =
    flashKind === 'match'
      ? 'ring-2 ring-[var(--sage)]/60 transition-all duration-200'
      : 'transition-all duration-200';

  return (
    <div className="flex-1 min-h-0 flex items-start justify-center overflow-y-auto px-5 py-6 scrollbar-subtle">
      <div
        className={`w-full max-w-[720px] bg-card border border-edge rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${flashClass}`}
      >
        <div className="px-6 pt-6 pb-4">
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost mb-2">
            Triage card
          </div>
          <h2 className="text-[18px] text-ink font-medium leading-snug">
            {renderInlineMarkdown(loop.text)}
          </h2>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-ghost">
            {loop.subGroup && <span>{loop.subGroup}</span>}
            {loop.updatedAt && (
              <span>updated {timeAgo(loop.updatedAt)}</span>
            )}
            {loop.linear_ticket_id && (
              <span className="font-mono">{loop.linear_ticket_id}</span>
            )}
          </div>
          {loop.notes && loop.notes.length > 0 && (
            <p className="mt-3 text-[12px] text-ink-soft leading-relaxed line-clamp-3">
              {renderInlineMarkdown(loop.notes[0].text)}
            </p>
          )}
        </div>

        {/* Current → Target summary with keyboard-cyclable priority */}
        <div className="mx-6 mb-3 px-4 py-2.5 rounded-lg border border-edge-subtle bg-inset/30 flex items-center gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
              current
            </span>
            <span className="font-mono text-ink-soft tabular-nums">
              {currentPriorityLabel}
            </span>
            {currentStakeholder !== '—' && (
              <span className="text-ink-ghost">· {currentStakeholder}</span>
            )}
          </div>
          <span className="text-ink-ghost">→</span>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
              accept at
            </span>
            <button
              type="button"
              onClick={() => onCyclePriority(-1)}
              className="w-5 h-5 rounded text-ink-ghost hover:text-ink bg-card border border-edge text-[10px] tabular-nums"
              aria-label="priority up"
            >
              ↑
            </button>
            <span className="font-mono text-[13px] text-ink px-1.5 tabular-nums font-medium">
              {targetPriority}
            </span>
            <button
              type="button"
              onClick={() => onCyclePriority(1)}
              className="w-5 h-5 rounded text-ink-ghost hover:text-ink bg-card border border-edge text-[10px] tabular-nums"
              aria-label="priority down"
            >
              ↓
            </button>
            {targetStakeholder && (
              <span className="text-ink-soft ml-1">· {targetStakeholder}</span>
            )}
          </div>
          <span className="ml-auto text-[10px] text-ink-ghost">
            press <Kbd>1</Kbd> to accept
          </span>
        </div>

        {rec && (
          <div className="mx-6 mb-4 rounded-lg border border-edge-subtle bg-inset/40 px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <ConfidenceDot confidence={rec.confidence} />
              <span className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
                why
              </span>
            </div>
            <p className="text-[11px] text-ink-soft leading-relaxed">
              {rec.reasoning}
            </p>
            {rec.signals.length > 0 && (
              <details className="mt-2">
                <summary className="text-[10px] text-ink-ghost cursor-pointer hover:text-ink-soft">
                  Signals
                </summary>
                <div className="mt-1 flex flex-wrap gap-1">
                  {rec.signals.map((s) => (
                    <span
                      key={s}
                      className="text-[10px] text-ink-ghost font-mono px-1.5 py-0.5 rounded bg-card border border-edge-subtle"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        <KeyLegend acceptMode={false} onAccept={onAccept} />
      </div>
    </div>
  );
}

function KeyLegend({
  acceptMode,
  onAccept,
}: {
  acceptMode: boolean;
  onAccept: () => void;
}) {
  return (
    <div className="px-6 py-3 border-t border-edge-subtle flex items-center gap-3 text-[10px] text-ink-ghost flex-wrap">
      {!acceptMode && (
        <button
          type="button"
          onClick={onAccept}
          className="text-[11px] text-ink-soft hover:text-ink px-2 py-0.5 rounded hover:bg-inset"
        >
          <Kbd>1</Kbd> accept
        </button>
      )}
      <span>
        <Kbd>2</Kbd> someday
      </span>
      <span>
        <Kbd>3</Kbd> drop
      </span>
      <span>
        <Kbd>H</Kbd> snooze
      </span>
      <span>
        <Kbd>S</Kbd> stakeholder
      </span>
      <span>
        <Kbd>D</Kbd> detail
      </span>
      <span>
        <Kbd>Z</Kbd> undo
      </span>
      <span>
        <Kbd>Space</Kbd> skip
      </span>
      <span className="ml-auto">
        <Kbd>M</Kbd> list mode
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="font-mono text-[9px] border border-edge rounded px-1 py-[1px] mr-1">
      {children}
    </kbd>
  );
}

function ConfidenceDot({
  confidence,
}: {
  confidence: TriageRecommendation['confidence'];
}) {
  const cls =
    confidence === 'high'
      ? 'bg-sage-fill border-[var(--sage)]'
      : confidence === 'medium'
        ? 'bg-tan-fill border-[var(--tan)]'
        : 'bg-transparent border-dashed border-[var(--text-ghost)]';
  return (
    <span
      className={`inline-block w-[8px] h-[8px] rounded-full border ${cls}`}
      aria-label={`${confidence} confidence`}
    />
  );
}

function dispositionLabel(d: Disposition): string {
  if (d === 'accept') return 'Accept';
  if (d === 'someday') return 'Someday';
  if (d === 'drop') return 'Drop';
  return 'Snooze';
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const now = Date.now();
  const mins = Math.round((now - then) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function SnoozePicker({
  open,
  onCancel,
  onPick,
}: {
  open: boolean;
  onCancel: () => void;
  onPick: (days: number) => void;
}) {
  const [custom, setCustom] = useState('14');
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[20vh] px-4"
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" aria-hidden />
      <div
        className="relative w-[360px] max-w-full bg-elevated border border-edge rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[12px] text-ink font-medium mb-3">Snooze until</div>
        <div className="flex gap-2 mb-3">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              className="flex-1 text-[12px] text-ink-soft hover:text-ink bg-card hover:bg-inset border border-edge hover:border-edge-hover px-3 py-1.5 rounded-md transition-colors"
            >
              {d}d
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="flex-1 text-[12px] bg-card border border-edge rounded px-2 py-1 text-ink"
          />
          <button
            type="button"
            onClick={() => onPick(Number(custom) || 14)}
            className="text-[12px] text-ink bg-card hover:bg-slate-fill hover:text-slate-text border border-edge px-3 py-1 rounded transition-colors"
          >
            Custom
          </button>
        </div>
      </div>
    </div>
  );
}

function StakeholderQuickSelect({
  open,
  onCancel,
  onPick,
}: {
  open: boolean;
  onCancel: () => void;
  onPick: (name: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[20vh] px-4"
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" aria-hidden />
      <div
        className="relative w-[420px] max-w-full bg-elevated border border-edge rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[12px] text-ink font-medium mb-3">Stakeholder</div>
        <div className="grid grid-cols-3 gap-2">
          {STAKEHOLDERS.map((s: Stakeholder) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="text-[12px] text-ink-soft hover:text-ink bg-card hover:bg-tan-fill hover:text-tan-text border border-edge px-3 py-1.5 rounded-md transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ListSurface({
  queue,
  onFocus,
}: {
  queue: Loop[];
  onFocus: (id: string) => void;
}) {
  const [sortCol, setSortCol] = useState<'title' | 'disposition' | 'priority' | 'confidence' | 'stakeholder' | 'updated'>('updated');
  const [filterDisp, setFilterDisp] = useState<Disposition | 'all'>('all');

  const filtered = useMemo(() => {
    let rows = queue;
    if (filterDisp !== 'all') {
      rows = rows.filter(
        (l) => l.ai_recommendation?.suggested_disposition === filterDisp,
      );
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
      if (sortCol === 'title') return a.text.localeCompare(b.text);
      if (sortCol === 'priority') {
        return (
          priOrder(a.ai_recommendation?.suggested_priority) -
          priOrder(b.ai_recommendation?.suggested_priority)
        );
      }
      if (sortCol === 'disposition') {
        return (
          (a.ai_recommendation?.suggested_disposition ?? 'zzz').localeCompare(
            b.ai_recommendation?.suggested_disposition ?? 'zzz',
          )
        );
      }
      if (sortCol === 'confidence') {
        return confOrder(a.ai_recommendation?.confidence) - confOrder(b.ai_recommendation?.confidence);
      }
      if (sortCol === 'stakeholder') {
        return (a.stakeholder ?? 'zzz').localeCompare(b.stakeholder ?? 'zzz');
      }
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    });
    return sorted;
  }, [queue, sortCol, filterDisp]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-5 py-2 flex items-center gap-2 text-[11px] text-ink-soft shrink-0">
        <span>Filter:</span>
        {(['all', 'accept', 'someday', 'drop', 'snooze'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilterDisp(f)}
            className={`px-2 py-0.5 rounded border ${
              filterDisp === f
                ? 'bg-card text-ink border-[var(--slate)]'
                : 'bg-transparent text-ink-ghost border-edge hover:border-edge-hover'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5 scrollbar-subtle">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-ghost border-b border-edge-subtle">
              <Th label="Title" col="title" sortCol={sortCol} onClick={setSortCol} />
              <Th label="Disposition" col="disposition" sortCol={sortCol} onClick={setSortCol} />
              <Th label="Priority" col="priority" sortCol={sortCol} onClick={setSortCol} />
              <Th label="Stakeholder" col="stakeholder" sortCol={sortCol} onClick={setSortCol} />
              <Th label="Confidence" col="confidence" sortCol={sortCol} onClick={setSortCol} />
              <Th label="Updated" col="updated" sortCol={sortCol} onClick={setSortCol} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr
                key={l.id}
                onClick={() => onFocus(l.id)}
                className="border-b border-edge-subtle cursor-pointer hover:bg-inset/40"
              >
                <td className="py-2 pr-4 text-ink truncate max-w-[360px]">{l.text}</td>
                <td className="py-2 pr-4 text-ink-soft">
                  {l.ai_recommendation?.suggested_disposition ?? '—'}
                </td>
                <td className="py-2 pr-4 font-mono text-ink-soft">
                  {l.ai_recommendation?.suggested_priority ?? '—'}
                </td>
                <td className="py-2 pr-4 text-ink-soft">
                  {l.ai_recommendation?.suggested_stakeholder ?? '—'}
                </td>
                <td className="py-2 pr-4 text-ink-ghost">
                  {l.ai_recommendation?.confidence ?? '—'}
                </td>
                <td className="py-2 pr-4 text-ink-ghost">
                  {l.updatedAt ? timeAgo(l.updatedAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  label,
  col,
  sortCol,
  onClick,
}: {
  label: string;
  col: 'title' | 'disposition' | 'priority' | 'confidence' | 'stakeholder' | 'updated';
  sortCol: string;
  onClick: (c: 'title' | 'disposition' | 'priority' | 'confidence' | 'stakeholder' | 'updated') => void;
}) {
  return (
    <th
      onClick={() => onClick(col)}
      className={`py-2 pr-4 text-left cursor-pointer hover:text-ink-soft ${
        sortCol === col ? 'text-ink' : ''
      }`}
    >
      {label}
    </th>
  );
}

function priOrder(p: TriagePriority | undefined): number {
  if (!p) return 99;
  return ['P0', 'P1', 'P2', 'P3'].indexOf(p);
}

function confOrder(c: TriageRecommendation['confidence'] | undefined): number {
  if (c === 'high') return 0;
  if (c === 'medium') return 1;
  if (c === 'low') return 2;
  return 99;
}
