'use client';

// WeekCanvas: the hero of Plan mode. Seven day columns side-by-side
// (Sunday to Saturday), each rendering calendar events and loop blocks
// proportionally. A shared left rail shows hour labels so they render
// once for the whole week. Pixels-per-minute is computed on mount and
// resize so the full 8a to 7p window fits the viewport without scrolling.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { CalendarEvent, CalendarFile, Loop, Timeblock } from '@/lib/types';
import { formatMinutes, formatTime, shortDayLabel, todayISO, weekDates } from '@/lib/types';
import { busyIntervals, type Interval } from '@/lib/schedule';
import {
  DAY_END_MIN,
  DAY_START_MIN,
  DAY_TOTAL_MIN,
  HEALTHY_DAY_MINUTES,
  SLOT_MIN,
  durationToPct,
  eventKindClasses,
  inferEventKind,
  minutesToPct,
} from '@/lib/ui';

const LEFT_RAIL_PX = 52;
const HEADER_ROW_PX = 40;
const MIN_PX_PER_MIN = 1.0;
const MAX_PX_PER_MIN = 1.6;

// Horizontal gap between adjacent lanes so borders don't touch.
const LANE_GAP_PX = 2;
// Left edge inset that matches the original `left-1 right-1` styling
// (Tailwind's `1` = 4px) so single-lane blocks render in the same spot
// they did before overlap handling.
const COLUMN_INSET_PX = 4;

type LayoutInput = {
  id: string;
  startMinute: number;
  endMinute: number;
  kind: 'event' | 'loop';
};

type LaneInfo = { lane: number; laneCount: number };

// Interval-graph lane assignment for overlapping blocks in a single day
// column. Implements the standard "meeting rooms" sweep: sort by start
// time, place each block in the first lane whose last block has ended,
// and emit a cluster once no active block extends into the next start.
// Every block in a cluster is tagged with the cluster's max concurrency
// so each renders at 1/laneCount width.
function assignLanes(inputs: LayoutInput[]): Map<string, LaneInfo> {
  const result = new Map<string, LaneInfo>();
  if (inputs.length === 0) return result;

  const sorted = [...inputs].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    const da = a.endMinute - a.startMinute;
    const db = b.endMinute - b.startMinute;
    return db - da;
  });

  // A cluster is a contiguous group of blocks where at least one overlaps
  // another. We finalize a cluster when the next block starts at or after
  // every active block's end.
  let clusterIds: string[] = [];
  let lanes: number[] = []; // lanes[i] = endMinute of last block in lane i
  let clusterMaxLanes = 0;

  const flush = () => {
    for (const id of clusterIds) {
      const existing = result.get(id);
      if (existing) {
        result.set(id, { lane: existing.lane, laneCount: clusterMaxLanes });
      }
    }
    clusterIds = [];
    lanes = [];
    clusterMaxLanes = 0;
  };

  for (const block of sorted) {
    // If no active lane extends past this block's start, the previous
    // cluster has ended and we can flush it.
    const anyActive = lanes.some((end) => end > block.startMinute);
    if (!anyActive) {
      flush();
    }

    // Find the first lane whose last block ended at or before this start.
    let laneIdx = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] <= block.startMinute) {
        laneIdx = i;
        break;
      }
    }
    if (laneIdx === -1) {
      laneIdx = lanes.length;
      lanes.push(block.endMinute);
    } else {
      lanes[laneIdx] = block.endMinute;
    }

    clusterIds.push(block.id);
    result.set(block.id, { lane: laneIdx, laneCount: 1 });
    if (lanes.length > clusterMaxLanes) clusterMaxLanes = lanes.length;
  }
  flush();

  return result;
}

// Render-time helper: convert a lane assignment into CSS left/width values.
// Single-lane blocks (laneCount === 1) keep the original 4px inset so the
// common case is unchanged. Multi-lane blocks split the column evenly with
// a small gap between lanes.
function lanePosition(lane: number, laneCount: number): { left: string; width: string } {
  if (laneCount <= 1) {
    return { left: `${COLUMN_INSET_PX}px`, width: `calc(100% - ${COLUMN_INSET_PX * 2}px)` };
  }
  const pct = 100 / laneCount;
  return {
    left: `calc(${lane * pct}% + ${COLUMN_INSET_PX}px)`,
    width: `calc(${pct}% - ${COLUMN_INSET_PX * 2 + LANE_GAP_PX}px)`,
  };
}

export function WeekCanvas({
  loops,
  calendar,
  committedMinutes,
  draggingLoop,
  draggingBlockIdx,
  onClearTimeblock,
  onOpenDetail,
  onCreate,
  selectedIds,
  mode,
}: {
  loops: Loop[];
  calendar: CalendarFile | null;
  committedMinutes: number;
  draggingLoop: Loop | null;
  draggingBlockIdx: number;
  onClearTimeblock: (id: string) => void;
  onOpenDetail?: (id: string) => void;
  onCreate?: (draft: Omit<Loop, 'id'>) => Promise<void>;
  selectedIds: Set<string>;
  mode: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Seven ISO dates for the current week.
  const days = useMemo(() => weekDates(new Date()), []);
  const today = todayISO();

  // Current time in minutes. Refresh each minute so the red "now" line slides.
  const nowMin = useNowMinute();
  const nowInRange = nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN;

  // Fit the canvas to available viewport height. Computed on mount and resize.
  const [canvasHeightPx, setCanvasHeightPx] = useState<number>(() => {
    if (typeof window === 'undefined') return 560;
    const target = Math.round(window.innerHeight * 0.62);
    return clampCanvasHeight(target);
  });

  useLayoutEffect(() => {
    function recompute() {
      const outer = outerRef.current;
      if (!outer) return;
      // The outer section occupies the plan mode's main column. Its parent
      // clientHeight is the space between header and viewport bottom.
      const parent = outer.parentElement;
      const parentH = parent ? parent.clientHeight : window.innerHeight;
      // subtract the canvas header row and a little footer padding.
      const available = parentH - HEADER_ROW_PX - 24;
      setCanvasHeightPx(clampCanvasHeight(available));
    }
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, []);

  // Auto-scroll so the current time is visible on mount. Scrolls
  // vertically to center the "now" line and horizontally to center
  // today's column.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    // Horizontal: center today's column.
    const todayIdx = days.indexOf(today);
    if (todayIdx >= 0) {
      const col = grid.children[todayIdx] as HTMLElement | undefined;
      if (col && grid.scrollWidth > grid.clientWidth) {
        const target = col.offsetLeft - (grid.clientWidth - col.clientWidth) / 2;
        grid.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
      }
    }
    // Vertical: scroll the parent so the current time is visible.
    const parent = grid.parentElement;
    if (parent && nowInRange) {
      const pct = (nowMin - DAY_START_MIN) / DAY_TOTAL_MIN;
      const targetY = pct * canvasHeightPx - parent.clientHeight / 3;
      parent.scrollTo({ top: Math.max(0, targetY), behavior: 'auto' });
    }
  }, [mode, days, today]);

  const pxPerMin = canvasHeightPx / DAY_TOTAL_MIN;

  // Hour and half-hour gridlines shared across all columns.
  const hourLines = useMemo(() => {
    const arr: number[] = [];
    for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 60) arr.push(m);
    return arr;
  }, []);
  const halfHourLines = useMemo(() => {
    const arr: number[] = [];
    for (let m = DAY_START_MIN + 30; m < DAY_END_MIN; m += 60) arr.push(m);
    return arr;
  }, []);

  const slots = useMemo(() => {
    const arr: number[] = [];
    for (let m = DAY_START_MIN; m < DAY_END_MIN; m += SLOT_MIN) arr.push(m);
    return arr;
  }, []);

  // Group events and loop blocks by date for cheap per-column lookup.
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of calendar?.events ?? []) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [calendar]);

  // Per-date placement list. Each entry is a (loop, timeblock, idx) triple
  // so a loop that's been split into several blocks shows up once per block.
  type Placement = { loop: Loop; tb: Timeblock; idx: number };
  const placementsByDate = useMemo(() => {
    const map = new Map<string, Placement[]>();
    for (const l of loops) {
      l.timeblocks.forEach((tb, idx) => {
        if (!map.has(tb.date)) map.set(tb.date, []);
        map.get(tb.date)!.push({ loop: l, tb, idx });
      });
    }
    return map;
  }, [loops]);

  // Today's committed summary. Scored against a 9a-5p working-hours budget,
  // not the 8a-7p grid span — prevents the bar from normalizing overwork.
  // If committed > 8h, the bar caps at 100% and the free number goes to 0;
  // the overflow shows as blocks placed outside 9-5 on the grid.
  const committedPct = Math.min(100, (committedMinutes / HEALTHY_DAY_MINUTES) * 100);
  const freeMinutes = Math.max(0, HEALTHY_DAY_MINUTES - committedMinutes);

  // Effective duration of what's being dragged. For re-drags of a specific
  // placed block (drag id = `${loopId}:${idx}`) this is the block's own
  // duration, not the whole loop's estimate. For list drags we fall back to
  // the loop's estimate.
  const draggingDurationMin = useMemo(() => {
    if (!draggingLoop) return 0;
    if (draggingBlockIdx >= 0) {
      const tb = draggingLoop.timeblocks[draggingBlockIdx];
      if (tb) return tb.endMinute - tb.startMinute;
    }
    return draggingLoop.timeEstimateMinutes ?? 30;
  }, [draggingLoop, draggingBlockIdx]);

  return (
    <section ref={outerRef} className="flex flex-col min-w-0 h-full">
      {/* Canvas header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-edge shrink-0"
        style={{ height: `${HEADER_ROW_PX}px` }}
      >
        <div className="flex items-baseline gap-3">
          <h2 className="text-[13px] font-medium tracking-tight text-ink">This week</h2>
          <span className="text-[11px] text-ink-faint tabular-nums">
            Today: {formatMinutes(committedMinutes)} committed / {formatMinutes(freeMinutes)} free
          </span>
        </div>
        <div className="text-[10px] text-ink-ghost tabular-nums">
          {calendar?.available ? 'calendar linked' : 'no calendar'}
        </div>
      </div>

      {/* Canvas body: left rail + 7 day columns */}
      <div
        ref={gridRef}
        className="flex-1 min-h-0 flex overflow-x-auto overflow-y-auto"
        style={{ paddingTop: '4px' }}
      >
        {/* Left rail with hour labels. Shared across all columns. */}
        <div
          className="shrink-0 relative"
          style={{ width: `${LEFT_RAIL_PX}px`, height: `${canvasHeightPx + 28}px` }}
          aria-hidden
        >
          {/* Spacer matching day header row */}
          <div style={{ height: '28px' }} />
          <div className="relative" style={{ height: `${canvasHeightPx}px` }}>
            {hourLines.map((m) => {
              const top = minutesToPct(m);
              return (
                <div
                  key={`rail-${m}`}
                  className="absolute right-0 text-[10px] font-mono text-ink-ghost tabular-nums pr-2"
                  style={{ top: `calc(${top}% - 6px)` }}
                >
                  {formatTime(m)}
                </div>
              );
            })}
          </div>
        </div>

        {/* Day columns (Mon-Fri) */}
        <div className="flex-1 min-w-0 grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gap: '1px' }}>
          {days.map((date) => {
            const isToday = date === today;
            const dayEvents = eventsByDate.get(date) ?? [];
            const dayPlacements = placementsByDate.get(date) ?? [];
            return (
              <DayColumn
                key={date}
                date={date}
                isToday={isToday}
                canvasHeightPx={canvasHeightPx}
                pxPerMin={pxPerMin}
                hourLines={hourLines}
                halfHourLines={halfHourLines}
                slots={slots}
                events={dayEvents}
                placements={dayPlacements}
                draggingLoop={draggingLoop}
                draggingDurationMin={draggingDurationMin}
                allLoops={loops}
                onClearTimeblock={onClearTimeblock}
                onOpenDetail={onOpenDetail}
                onCreate={onCreate}
                selectedIds={selectedIds}
                committedPct={isToday ? committedPct : null}
                nowMin={nowInRange && isToday ? nowMin : null}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function clampCanvasHeight(targetPx: number): number {
  // Enforce the effective px/min window: min 0.7, max 1.6.
  const minPx = DAY_TOTAL_MIN * MIN_PX_PER_MIN;
  const maxPx = DAY_TOTAL_MIN * MAX_PX_PER_MIN;
  if (targetPx < minPx) return minPx;
  if (targetPx > maxPx) return maxPx;
  return targetPx;
}

type Placement = { loop: Loop; tb: Timeblock; idx: number };

function DayColumn({
  date,
  isToday,
  canvasHeightPx,
  pxPerMin,
  hourLines,
  halfHourLines,
  slots,
  events,
  placements,
  draggingLoop,
  draggingDurationMin,
  allLoops,
  onClearTimeblock,
  onOpenDetail,
  onCreate,
  selectedIds,
  committedPct,
  nowMin,
}: {
  date: string;
  isToday: boolean;
  canvasHeightPx: number;
  pxPerMin: number;
  hourLines: number[];
  halfHourLines: number[];
  slots: number[];
  events: CalendarEvent[];
  placements: Placement[];
  draggingLoop: Loop | null;
  draggingDurationMin: number;
  allLoops: Loop[];
  onClearTimeblock: (id: string) => void;
  onOpenDetail?: (id: string) => void;
  onCreate?: (draft: Omit<Loop, 'id'>) => Promise<void>;
  selectedIds: Set<string>;
  committedPct: number | null;
  nowMin: number | null;
}) {
  // ─── Drag-to-create ────────────────────────────────────────────
  // Tracks an in-progress click+drag on empty canvas. On pointer
  // down we record the starting minute; on pointer move we update
  // the end minute; on pointer up we either open the inline title
  // input at the selection (if the drag was meaningful) or cancel.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<null | {
    startMin: number;
    endMin: number;
  }>(null);
  const [draftAt, setDraftAt] = useState<null | {
    startMin: number;
    endMin: number;
  }>(null);

  // Convert a clientY to the snapped minute within this column.
  const yToMinute = useCallback(
    (clientY: number): number | null => {
      const body = bodyRef.current;
      if (!body) return null;
      const rect = body.getBoundingClientRect();
      const rel = clientY - rect.top;
      const frac = Math.max(0, Math.min(1, rel / rect.height));
      const raw = DAY_START_MIN + frac * (DAY_END_MIN - DAY_START_MIN);
      const snapped = Math.round(raw / SLOT_MIN) * SLOT_MIN;
      return Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, snapped));
    },
    [],
  );

  const onBodyPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only react to plain left-button drags on the empty canvas.
      // Allowed start targets: the column body itself, or a drop
      // slot (which covers empty time space). Anything else — a
      // placed loop block, a calendar event, the draft input — is
      // a different interaction and must not trigger drag-to-create.
      const target = e.target as HTMLElement;
      const isBody = target === e.currentTarget;
      const isSlot =
        target.dataset?.dropSlot === 'true' ||
        target.closest?.('[data-drop-slot="true"]') !== null;
      if (!isBody && !isSlot) return;
      if (e.button !== 0) return;
      if (draggingLoop) return; // existing drag-move flow wins
      if (!onCreate) return;
      if (draftAt) return; // title input is open — don't start a new drag
      const start = yToMinute(e.clientY);
      if (start == null) return;
      e.preventDefault();
      setSelection({ startMin: start, endMin: start + SLOT_MIN });

      const onMove = (ev: PointerEvent) => {
        const m = yToMinute(ev.clientY);
        if (m == null) return;
        setSelection((sel) =>
          sel ? { ...sel, endMin: Math.max(m, sel.startMin + SLOT_MIN) } : sel,
        );
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const finalEnd = yToMinute(ev.clientY);
        setSelection((sel) => {
          if (!sel) return null;
          const endMin = Math.max(
            finalEnd ?? sel.endMin,
            sel.startMin + SLOT_MIN,
          );
          // If the user clicked without dragging, default to a 30m block.
          const blockEnd =
            endMin === sel.startMin + SLOT_MIN
              ? sel.startMin + 30
              : endMin;
          setDraftAt({ startMin: sel.startMin, endMin: blockEnd });
          return null;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [draggingLoop, onCreate, yToMinute, draftAt],
  );

  const commitDraft = useCallback(
    async (title: string) => {
      if (!draftAt || !onCreate) {
        setDraftAt(null);
        return;
      }
      const clean = title.trim();
      if (!clean) {
        setDraftAt(null);
        return;
      }
      const draft: Omit<Loop, 'id'> = {
        tier: 'now',
        text: clean,
        pLevel: null,
        difficulty: null,
        timeEstimateMinutes: draftAt.endMin - draftAt.startMin,
        subGroup: null,
        source: { file: '00-Inbox/manual-loops.md', line: 0 },
        timeblocks: [
          {
            date,
            startMinute: draftAt.startMin,
            endMinute: draftAt.endMin,
          },
        ],
      } as unknown as Omit<Loop, 'id'>;
      setDraftAt(null);
      await onCreate(draft);
    },
    [draftAt, onCreate, date],
  );
  const { dow, dom } = shortDayLabel(date);

  // Busy intervals on this date for conflict-aware ghost coloring. Excludes
  // the loop being dragged so a re-drag doesn't collide with its own other
  // blocks. Recomputed only when the drag target or underlying data changes.
  const busy = useMemo<Interval[]>(() => {
    if (!draggingLoop) return [];
    return busyIntervals(date, events, allLoops, draggingLoop.id);
  }, [date, events, allLoops, draggingLoop]);

  return (
    <div className="flex flex-col min-w-0 bg-page">
      {/* Day header */}
      <div
        className={`flex items-center justify-between px-2 shrink-0 border-b ${
          isToday ? 'bg-slate-fill border-[var(--slate)]/40' : 'bg-page border-edge-subtle'
        }`}
        style={{ height: '28px' }}
      >
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span
            className={`text-[10px] uppercase tracking-wider font-normal ${
              isToday ? 'text-slate-text' : 'text-ink-ghost'
            }`}
          >
            {dow}
          </span>
          <span
            className={`text-[11px] tabular-nums ${
              isToday ? 'text-ink font-medium' : 'text-ink-faint'
            }`}
          >
            {dom}
          </span>
        </div>
        {isToday && committedPct != null && (
          <div
            className="h-1 w-8 bg-inset rounded-full overflow-hidden"
            title={`${Math.round(committedPct)}% committed`}
          >
            <div
              className="h-full bg-[var(--sage)]"
              style={{ width: `${committedPct}%` }}
            />
          </div>
        )}
      </div>

      {/* Column body */}
      <div
        ref={bodyRef}
        className="relative"
        style={{ height: `${canvasHeightPx}px` }}
        onPointerDown={onBodyPointerDown}
      >
        {/* Flat calendar surface. Morning / afternoon / evening tinting
            created a weird gradient in light mode — the whole day column
            now sits on a single surface. Time-of-day is already signaled
            by the hour gridlines + the red "now" line. */}

        {/* Hour gridlines */}
        {hourLines.map((m) => (
          <div
            key={`h-${date}-${m}`}
            aria-hidden
            className="absolute left-0 right-0 border-t border-edge-subtle"
            style={{ top: `${minutesToPct(m)}%` }}
          />
        ))}
        {/* Half-hour gridlines, fainter */}
        {halfHourLines.map((m) => (
          <div
            key={`hh-${date}-${m}`}
            aria-hidden
            className="absolute left-0 right-0 border-t border-edge-subtle/40"
            style={{ top: `${minutesToPct(m)}%` }}
          />
        ))}

        {/* Drop zones, invisible overlay, snap to 15-min */}
        {slots.map((startMin) => (
          <DropSlot
            key={`${date}-${startMin}`}
            date={date}
            startMinute={startMin}
            draggingLoop={draggingLoop}
            draggingDurationMin={draggingDurationMin}
            busy={busy}
            pxPerMin={pxPerMin}
          />
        ))}

        {/* Calendar events + loop blocks share lane layout so overlaps split
            the column width instead of stacking on top of each other. */}
        {(() => {
          const inputs: LayoutInput[] = [];
          for (const e of events) {
            inputs.push({
              id: `e:${e.id}`,
              startMinute: e.startMinute,
              endMinute: e.endMinute,
              kind: 'event',
            });
          }
          for (const p of placements) {
            inputs.push({
              id: `l:${p.loop.id}:${p.idx}`,
              startMinute: p.tb.startMinute,
              endMinute: p.tb.endMinute,
              kind: 'loop',
            });
          }
          const layout = assignLanes(inputs);
          const nodes: React.ReactNode[] = [];
          for (const e of events) {
            const pos = layout.get(`e:${e.id}`);
            if (!pos) continue;
            nodes.push(
              <CalendarBlock key={e.id} event={e} lane={pos.lane} laneCount={pos.laneCount} />,
            );
          }
          for (const p of placements) {
            const pos = layout.get(`l:${p.loop.id}:${p.idx}`);
            if (!pos) continue;
            const count = p.loop.timeblocks.length;
            nodes.push(
              <LoopBlock
                key={`${p.loop.id}:${p.idx}`}
                loop={p.loop}
                tb={p.tb}
                blockIdx={p.idx}
                blockCount={count}
                selected={selectedIds.has(p.loop.id)}
                onClear={() => onClearTimeblock(p.loop.id)}
                onOpen={onOpenDetail ? () => onOpenDetail(p.loop.id) : undefined}
                lane={pos.lane}
                laneCount={pos.laneCount}
              />,
            );
          }
          return nodes;
        })()}

        {/* Drag-to-create selection ghost */}
        {selection && (
          <div
            aria-hidden
            className="absolute left-1 right-1 z-25 pointer-events-none rounded-md border border-[var(--sage)]/60 bg-sage-fill/40"
            style={{
              top: `${minutesToPct(selection.startMin)}%`,
              height: `${durationToPct(Math.max(SLOT_MIN, selection.endMin - selection.startMin))}%`,
            }}
          />
        )}

        {/* Inline new-loop input after the drag is released */}
        {draftAt && (
          <div
            className="absolute left-1 right-1 z-30 rounded-md border border-[var(--sage)]/60 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)] overflow-hidden"
            style={{
              top: `${minutesToPct(draftAt.startMin)}%`,
              height: `${durationToPct(Math.max(SLOT_MIN, draftAt.endMin - draftAt.startMin))}%`,
              minHeight: '28px',
            }}
          >
            <NewBlockInput
              startMin={draftAt.startMin}
              endMin={draftAt.endMin}
              onCommit={commitDraft}
              onCancel={() => setDraftAt(null)}
            />
          </div>
        )}

        {/* Red "now" line only for today */}
        {nowMin != null && (
          <div
            aria-hidden
            className="absolute left-0 right-0 z-20 pointer-events-none"
            style={{ top: `${minutesToPct(nowMin)}%` }}
          >
            <div className="h-[2px] bg-[var(--rose)]" />
          </div>
        )}
      </div>
    </div>
  );
}

function NewBlockInput({
  startMin,
  endMin,
  onCommit,
  onCancel,
}: {
  startMin: number;
  endMin: number;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const label = `${formatMinAsHHMM(startMin)}–${formatMinAsHHMM(endMin)}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(value);
      }}
      className="w-full h-full flex flex-col justify-start px-2 py-1.5 gap-0.5"
    >
      <div className="text-[9px] uppercase tracking-wider text-ink-ghost tabular-nums">
        {label}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (value.trim()) {
            onCommit(value);
          } else {
            onCancel();
          }
        }}
        placeholder="new loop…"
        className="w-full bg-transparent text-[11px] text-ink placeholder:text-ink-ghost/60 focus:outline-none"
      />
    </form>
  );
}

function formatMinAsHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? 'p' : 'a';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh}${period}` : `${hh}:${String(m).padStart(2, '0')}${period}`;
}

function DropSlot({
  date,
  startMinute,
  draggingLoop,
  draggingDurationMin,
  busy,
  pxPerMin,
}: {
  date: string;
  startMinute: number;
  draggingLoop: Loop | null;
  draggingDurationMin: number;
  busy: Interval[];
  pxPerMin: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot-${date}-${startMinute}` });
  const top = minutesToPct(startMinute);
  const height = durationToPct(SLOT_MIN);

  // Ghost: clamp to day end so it doesn't bleed past the canvas. The actual
  // drop behavior auto-splits around conflicts, so this is purely preview.
  const ghostEnd = Math.min(startMinute + draggingDurationMin, DAY_END_MIN);
  const ghostDuration = Math.max(0, ghostEnd - startMinute);
  const ghostHeightPx = ghostDuration * pxPerMin;

  // Conflict check: any busy interval that overlaps [startMinute, ghostEnd).
  const hasConflict =
    draggingLoop != null &&
    busy.some((b) => b.start < ghostEnd && b.end > startMinute);

  const showGhost = isOver && draggingLoop != null && ghostDuration > 0;

  // Thinner, less saturated ghost. Theme variables so the fill tracks
  // light/dark mode — previously hard-coded rgba made the ghost
  // disappear against the dark surface.
  const ghostClass = hasConflict
    ? 'border-[var(--rose)]/70 bg-rose-fill'
    : 'border-[var(--sage)]/70 bg-sage-fill';

  return (
    <div
      ref={setNodeRef}
      data-drop-slot="true"
      className="absolute left-0 right-0"
      style={{ top: `${top}%`, height: `${height}%` }}
    >
      {showGhost && (
        <div
          className={`absolute left-1 right-1 rounded-md border pointer-events-none z-10 ${ghostClass}`}
          style={{ top: 0, height: `${ghostHeightPx}px` }}
          aria-hidden
        />
      )}
    </div>
  );
}

function CalendarBlock({
  event,
  lane,
  laneCount,
}: {
  event: CalendarEvent;
  lane: number;
  laneCount: number;
}) {
  const top = minutesToPct(event.startMinute);
  const height = durationToPct(event.endMinute - event.startMinute);
  const { left, width } = lanePosition(lane, laneCount);
  const kind = inferEventKind(event.title);
  const classes = eventKindClasses(kind);
  return (
    <div
      className={`absolute rounded-r-md border-l-[3px] px-2 py-1 text-[10px] z-10 overflow-hidden ${classes.border} ${classes.fill} ${classes.text}`}
      style={{
        top: `${top}%`,
        height: `${height}%`,
        minHeight: '18px',
        left,
        width,
      }}
      title={`${event.title} ${formatTime(event.startMinute)} to ${formatTime(event.endMinute)}`}
    >
      <div className="font-medium leading-tight truncate">{event.title}</div>
      <div className="text-[9px] font-mono tabular-nums truncate opacity-70 mt-[1px]">
        {formatTime(event.startMinute)}
      </div>
    </div>
  );
}

function LoopBlock({
  loop,
  tb,
  blockIdx,
  blockCount,
  selected,
  onClear,
  onOpen,
  lane,
  laneCount,
}: {
  loop: Loop;
  tb: Timeblock;
  blockIdx: number;
  blockCount: number;
  selected: boolean;
  onClear: () => void;
  onOpen?: () => void;
  lane: number;
  laneCount: number;
}) {
  const isDone = !!loop.done;
  // Drag id encodes both loop and block index so the page-level drag
  // handler can update only the specific block being moved.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${loop.id}:${blockIdx}`,
    disabled: isDone,
  });

  const top = minutesToPct(tb.startMinute);
  const height = durationToPct(tb.endMinute - tb.startMinute);
  const { left, width } = lanePosition(lane, laneCount);

  // Loop blocks use the mauve accent to stay visually distinct from
  // calendar events (which use the full semantic palette). Selected state
  // amps the fill; done state fades to a dimmed record.
  const baseClasses = isDone
    ? 'border-l-[var(--text-ghost)] bg-transparent text-ink-ghost cursor-pointer'
    : selected
      ? 'border-l-[var(--mauve)] bg-mauve-fill ring-1 ring-[var(--mauve)] text-mauve-text cursor-grab active:cursor-grabbing'
      : 'border-l-[var(--mauve)] bg-mauve-fill text-mauve-text hover:bg-[var(--mauve)]/20 cursor-grab active:cursor-grabbing';

  return (
    <div
      ref={setNodeRef}
      {...(isDone ? {} : attributes)}
      {...(isDone ? {} : listeners)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
      className={`group/block absolute rounded-r-md border-l-2 px-2 py-1 text-[10px] z-10 overflow-hidden transition-colors ${baseClasses} ${
        isDragging ? 'opacity-30' : ''
      } ${isDone ? 'opacity-50' : ''}`}
      style={{ top: `${top}%`, height: `${height}%`, minHeight: '18px', left, width }}
      title={`${loop.text}${isDone ? ' (done)' : ''}`}
    >
      <div
        className={`font-medium leading-tight truncate pr-4 ${
          isDone ? 'line-through' : ''
        }`}
      >
        {loop.text}
      </div>
      <div className="text-[9px] font-mono tabular-nums flex items-center gap-1 opacity-70 mt-[1px]">
        <span>{formatTime(tb.startMinute)}</span>
        {blockCount > 1 && (
          <span>
            · {blockIdx + 1}/{blockCount}
          </span>
        )}
      </div>
      {isDone && (
        <span
          className="absolute top-0.5 right-0.5 text-sage-text text-[10px] leading-none"
          aria-hidden
          title="Done"
        >
          ✓
        </span>
      )}
      {/* Clear button hidden on done loops so their history can't be
          nuked by accident. Live loops keep the hover affordance. */}
      {!isDone && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="absolute top-0.5 right-0.5 opacity-0 group-hover/block:opacity-100 text-ink-ghost hover:text-rose-text text-[10px] w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-rose-fill z-20"
          title="Clear timeblock"
        >
          ×
        </button>
      )}
    </div>
  );
}

function useNowMinute(): number {
  const [now, setNow] = useState<number>(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });
  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setNow(d.getHours() * 60 + d.getMinutes());
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
