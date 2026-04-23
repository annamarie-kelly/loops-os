'use client';

// LoopRow: the durable atom of the UI.
// Quiet card atom — task text is loudest, everything else whispers.
// Density presets:
//   hero     — Now column in triage (15px, single line)
//   default  — generic medium (13px)
//   compact  — Someday / dense lists (12px)
//   sidebar  — LoopDrawer (13px title, wraps to 2 lines, roomier padding)

import { useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useDraggable } from '@dnd-kit/core';
import type { Loop } from '@/lib/types';
import { formatMinutes, formatTime, TIER_META } from '@/lib/types';
import { effectiveWorkMode, pPillClass, WORK_MODE_META } from '@/lib/ui';
import { renderInlineMarkdown } from '@/lib/markdown';
import { TierDot } from './PriorityDot';
import { TomorrowBadge } from './TomorrowBadge';

// ─── Inline priority picker ────────────────────────────────────────
// At rest: shows the pLevel pill. On click: expands to a row of 5
// small colored buttons. Click one to save, click away to dismiss.
const PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3', 'P4'];

function InlinePriorityPicker({
  value,
  onSave,
}: {
  value: string | null;
  onSave: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!open) {
    const display = value || 'P—';
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`font-mono px-1.5 py-[1px] rounded cursor-pointer hover:ring-1 hover:ring-[var(--slate)] transition-all ${pPillClass(value)}`}
        title="Click to change priority"
      >
        {display}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      className="flex items-center gap-[3px] animate-[fadeIn_80ms_ease]"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {PRIORITY_OPTIONS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSave(p);
            setOpen(false);
          }}
          className={`font-mono px-1 py-[1px] rounded text-[9px] cursor-pointer transition-all hover:scale-110 ${pPillClass(p)} ${
            value?.startsWith(p) ? 'ring-1 ring-[var(--slate)]' : ''
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// ─── Inline time picker ────────────────────────────────────────────
// At rest: shows formatted time. On click: small number input.
// Enter/blur saves, Escape cancels.
function InlineTimePicker({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (n: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(value != null ? String(value) : '');
    setEditing(true);
  }, [value]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const n = parseInt(draft, 10);
    onSave(isNaN(n) || n <= 0 ? null : n);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={startEdit}
        onPointerDown={(e) => e.stopPropagation()}
        className="cursor-pointer hover:text-ink-soft hover:underline transition-colors"
        title="Click to edit time estimate"
      >
        {value != null ? formatMinutes(value) : '—m'}
      </button>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-0.5 animate-[fadeIn_80ms_ease]"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
        onBlur={commit}
        step={15}
        min={0}
        className="w-[3.5rem] text-[10px] px-1 py-[1px] bg-inset border border-edge rounded text-ink tabular-nums focus:outline-none focus:border-[var(--slate)]"
        placeholder="min"
      />
      <span className="text-ink-ghost">m</span>
    </span>
  );
}

export type RowDensity = 'hero' | 'default' | 'compact' | 'sidebar';

export function LoopRow({
  loop,
  selected,
  focused,
  density = 'default',
  showTier = false,
  onCalendar,
  onToggleSelect,
  onStartEdit,
  onSaveEdit,
  onKill,
  onQuickSchedule,
}: {
  loop: Loop;
  selected: boolean;
  focused: boolean;
  density?: RowDensity;
  showTier?: boolean;
  onCalendar?: boolean;
  onToggleSelect: (id: string, shiftKey: boolean, cmdKey: boolean) => void;
  onStartEdit: (id: string) => void;
  onSaveEdit?: (id: string, patch: Partial<Loop>) => Promise<void>;
  onKill?: (id: string) => void;
  onQuickSchedule?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: loop.id,
  });

  // Hover card state. Tracked per-row so fixed positioning can follow
  // the actual row rect (measured on hover), and so the delay can be
  // cleanly cancelled on mouse leave.
  const rowRef = useRef<HTMLLIElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);

  const onMouseEnter = () => {
    if (isDragging) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (rowRef.current) setHoverRect(rowRef.current.getBoundingClientRect());
    }, 450);
  };
  const onMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverRect(null);
  };

  const firstBlock = loop.timeblocks[0] ?? null;
  const hasTimeblock = loop.timeblocks.length > 0;
  const blockCount = loop.timeblocks.length;

  // Staleness + deadline computation. Both feed the small metadata
  // indicators on the right edge of the row.
  const ageDays = loop.updatedAt
    ? Math.max(
        0,
        Math.round(
          (Date.now() - new Date(loop.updatedAt).getTime()) / 86_400_000,
        ),
      )
    : null;
  const isStale = ageDays != null && ageDays >= 14;
  const isVeryStale = ageDays != null && ageDays >= 30;

  const dueDays = loop.dueDate
    ? Math.round(
        (new Date(loop.dueDate).getTime() -
          new Date().setHours(0, 0, 0, 0)) /
          86_400_000,
      )
    : null;
  const dueUrgent = dueDays != null && dueDays <= 2;
  const dueSoon = dueDays != null && dueDays > 2 && dueDays <= 7;
  const dueLabel =
    dueDays == null
      ? null
      : dueDays < 0
        ? `overdue ${Math.abs(dueDays)}d`
        : dueDays === 0
          ? 'due today'
          : `due in ${dueDays}d`;

  const isBlocked = !!loop.blocked;

  const pad =
    density === 'hero'
      ? 'py-2.5 px-3'
      : density === 'compact'
        ? 'py-1.5 px-3'
        : density === 'sidebar'
          ? 'py-2 px-3'
          : 'py-2 px-3';

  const titleSize =
    density === 'hero'
      ? 'text-[15px]'
      : density === 'compact'
        ? 'text-[12px]'
        : density === 'sidebar'
          ? 'text-[13px]'
          : 'text-[13px]';

  const titleWeight = density === 'hero' ? 'font-medium' : 'font-normal';
  const titleColor = density === 'compact' ? 'text-ink-soft' : 'text-ink';

  // Default, sidebar, and hero densities all wrap to two lines so long
  // titles are readable — truncation was defeating the point of triage.
  // Compact (Someday) still truncates so Someday stays scannable.
  const titleClamp =
    density === 'compact'
      ? 'truncate'
      : 'line-clamp-2 whitespace-normal break-words';

  // Align items to the top when wrapping so the title anchors to row top.
  const alignCls = density === 'compact' ? 'items-center' : 'items-start';

  const setCombinedRef = (el: HTMLLIElement | null) => {
    rowRef.current = el;
    setNodeRef(el);
  };

  return (
    <li
      ref={setCombinedRef}
      {...listeners}
      {...attributes}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(e) => onToggleSelect(loop.id, e.shiftKey, e.metaKey || e.ctrlKey)}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onStartEdit(loop.id);
      }}
      className={`group relative flex ${alignCls} gap-2.5 cursor-pointer touch-none transition-[transform,border-color,background,opacity] duration-150 ${pad} ${
        selected
          ? 'bg-mauve-fill ring-1 ring-inset ring-[var(--mauve)]'
          : focused
            ? 'bg-inset'
            : isDragging
              ? ''
              : 'hover:bg-inset/60 hover:-translate-y-[0.5px]'
      } ${
        isDragging
          ? 'opacity-40 scale-[0.98]'
          : isBlocked
            ? 'opacity-65'
            : isVeryStale
              ? 'opacity-55'
              : isStale
                ? 'opacity-70'
                : ''
      }`}
      style={{ borderBottom: '0.5px solid var(--border-subtle)' }}
    >
      {/* Checkbox */}
      <div
        className={`shrink-0 h-3.5 w-3.5 rounded-[3px] border transition-colors ${
          density === 'sidebar' ? 'mt-[3px]' : ''
        } ${
          selected
            ? 'border-[var(--slate)] bg-[var(--slate)]'
            : 'border-edge group-hover:border-edge-hover'
        }`}
      />

      {/* Title + thin metadata strip */}
      <div className="flex-1 min-w-0">
        <div
          className={`leading-snug ${titleClamp} ${titleSize} ${titleWeight} ${titleColor} flex items-center gap-2`}
        >
          <span className="flex-1 min-w-0">
            {renderInlineMarkdown(loop.text)}
          </span>
          {loop.pinned_to_week && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider text-mauve-text font-medium"
              title="Pinned to this week (press w to unpin)"
              aria-label="Pinned to this week"
            >
              <span
                className="w-[5px] h-[5px] rounded-full"
                style={{ background: 'var(--mauve)' }}
                aria-hidden
              />
              week
            </span>
          )}
          <TomorrowBadge loopId={loop.id} />
        </div>
        {density === 'sidebar' && (
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-ghost tabular-nums flex-wrap">
            {onSaveEdit ? (
              <InlinePriorityPicker
                value={loop.pLevel}
                onSave={(p) => onSaveEdit(loop.id, { pLevel: p })}
              />
            ) : loop.pLevel ? (
              <span
                className={`font-mono px-1.5 py-[1px] rounded ${pPillClass(loop.pLevel)}`}
              >
                {loop.pLevel}
              </span>
            ) : null}
            {onSaveEdit ? (
              <InlineTimePicker
                value={loop.timeEstimateMinutes}
                onSave={(n) => onSaveEdit(loop.id, { timeEstimateMinutes: n })}
              />
            ) : loop.timeEstimateMinutes != null ? (
              <span>{formatMinutes(loop.timeEstimateMinutes)}</span>
            ) : null}
            {isBlocked && (
              <span className="inline-flex items-center gap-0.5 text-berry-text">
                <span aria-hidden>⏸</span> blocked
              </span>
            )}
            {dueLabel && (
              <span
                className={
                  dueDays != null && dueDays < 0
                    ? 'text-rose-text font-medium'
                    : dueUrgent
                      ? 'text-rose-text'
                      : dueSoon
                        ? 'text-tan-text'
                        : 'text-ink-ghost'
                }
              >
                {dueLabel}
              </span>
            )}
            {loop.subGroup && (
              <span className="truncate text-ink-ghost/80">· {loop.subGroup}</span>
            )}
            {ageDays != null && ageDays >= 7 && (
              <span className="text-ink-ghost italic">{ageDays}d ago</span>
            )}
            {onCalendar && (
              <span
                className="ml-auto flex items-center gap-1 text-mauve-text"
                title="Scheduled this week"
              >
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[var(--mauve)]"
                  aria-hidden
                />
                scheduled
              </span>
            )}
          </div>
        )}
        {showTier && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-ghost">
            <TierDot tier={loop.tier} size="xs" />
            <span>{TIER_META[loop.tier].label.toLowerCase()}</span>
            {loop.subGroup && (
              <>
                <span className="text-ink-ghost opacity-50">/</span>
                <span className="truncate">{loop.subGroup}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Right side for non-sidebar densities. Badges (due, blocked,
          stale) anchor to the top when title wraps to 2 lines so they
          don't float in mid-air. */}
      {density !== 'sidebar' && (
        <div
          className={`shrink-0 flex ${
            density === 'compact' ? 'items-center' : 'items-start pt-[2px]'
          } gap-1.5 tabular-nums`}
        >
          {dueLabel && (
            <span
              className={`text-[9px] font-mono px-1 py-[1px] rounded ${
                dueDays != null && dueDays < 0
                  ? 'bg-rose-fill text-rose-text'
                  : dueUrgent
                    ? 'bg-rose-fill text-rose-text'
                    : dueSoon
                      ? 'bg-tan-fill text-tan-text'
                      : 'text-ink-ghost'
              }`}
              title={loop.dueDate ?? undefined}
            >
              {dueLabel}
            </span>
          )}
          {isBlocked && (
            <span
              className="text-[9px] font-mono px-1 py-[1px] rounded bg-berry-fill text-berry-text"
              title="Blocked"
            >
              ⏸
            </span>
          )}
          {loop.pLevel && (
            <span
              className={`text-[10px] font-mono px-1.5 py-[1px] rounded ${pPillClass(loop.pLevel)}`}
            >
              {loop.pLevel}
            </span>
          )}
          {loop.timeEstimateMinutes != null && (
            <span className="text-[10px] text-ink-ghost tabular-nums min-w-[2.25rem] text-right opacity-40 group-hover:opacity-100 transition-opacity">
              {formatMinutes(loop.timeEstimateMinutes)}
            </span>
          )}
          {ageDays != null && ageDays >= 14 && (
            <span
              className="text-[9px] text-ink-ghost italic"
              title={`last touched ${ageDays}d ago`}
            >
              {ageDays}d
            </span>
          )}
          {(loop as unknown as Record<string, unknown>)._sourceLineCount != null &&
            ((loop as unknown as Record<string, unknown>)._sourceLineCount as number) > 500 && (
              <span
                className="text-[9px] px-1 py-[1px] rounded bg-rose-fill text-rose-text opacity-60 group-hover:opacity-100 transition-opacity"
                title={`Source file is ${(loop as unknown as Record<string, unknown>)._sourceLineCount}  lines — may need decomposition`}
              >
                ⚠
              </span>
          )}
          {(onCalendar || (hasTimeblock && firstBlock)) && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] opacity-70 mt-1"
              title={
                firstBlock
                  ? `scheduled ${formatTime(firstBlock.startMinute)}${blockCount > 1 ? ` (+${blockCount - 1})` : ''}`
                  : 'scheduled this week'
              }
            />
          )}
        </div>
      )}

      {/* Kill button only. Clicking the card already opens the detail
          drawer, so there's no need for a separate schedule icon — the
          drawer has the schedule action. × reveals on hover, quiet at
          rest, rose on intent. */}
      {onKill && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onKill(loop.id);
          }}
          className="absolute top-1/2 -translate-y-1/2 right-1 w-5 h-5 rounded-full flex items-center justify-center text-[12px] text-ink-ghost opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-rose-fill hover:text-rose-text transition-all z-20"
          title="Drop (let it go — soft archive)"
          aria-label="Drop loop"
        >
          ×
        </button>
      )}

      {/* Delayed hover card — portals to body so it escapes the column's
          overflow clip. Position computed from the row rect. */}
      {hoverRect && !isDragging && <HoverCard loop={loop} rect={hoverRect} />}
    </li>
  );
}

function HoverCard({ loop, rect }: { loop: Loop; rect: DOMRect }) {
  if (typeof document === 'undefined') return null;
  const mode = effectiveWorkMode(loop);
  const modeLabel = WORK_MODE_META[mode].label;
  const hasBlocks = loop.timeblocks.length > 0;
  const firstBlock = loop.timeblocks[0];

  const CARD_WIDTH = 320;
  const MARGIN = 12;
  // Place to the right of the row if there's room, otherwise left.
  const fitsRight = rect.right + MARGIN + CARD_WIDTH < window.innerWidth;
  const left = fitsRight
    ? rect.right + 8
    : Math.max(MARGIN, rect.left - CARD_WIDTH - 8);
  // Vertically clamp so the card doesn't leave the viewport.
  const top = Math.min(
    Math.max(MARGIN, rect.top - 4),
    window.innerHeight - 160,
  );

  return createPortal(
    <div
      className="pointer-events-none fixed z-[100] animate-[fadeIn_120ms_ease]"
      style={{ top: `${top}px`, left: `${left}px`, width: `${CARD_WIDTH}px` }}
    >
      <div className="rounded-lg border border-edge bg-elevated shadow-[0_12px_32px_rgba(0,0,0,0.14),0_2px_6px_rgba(0,0,0,0.08)] px-3.5 py-3">
        <div className="text-[13px] text-ink leading-snug whitespace-normal break-words">
          {renderInlineMarkdown(loop.text)}
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap text-[10px] text-ink-faint tabular-nums">
          {loop.pLevel && (
            <span
              className={`font-mono px-1.5 py-[1px] rounded ${pPillClass(loop.pLevel)}`}
            >
              {loop.pLevel}
            </span>
          )}
          {loop.difficulty != null && <span>D:{loop.difficulty}</span>}
          {loop.timeEstimateMinutes != null && (
            <span>{formatMinutes(loop.timeEstimateMinutes)}</span>
          )}
          <span
            className="font-mono"
            style={{ color: `var(${WORK_MODE_META[mode].accent})` }}
          >
            {modeLabel}
          </span>
          {loop.subGroup && (
            <>
              <span className="text-ink-ghost">·</span>
              <span className="truncate max-w-[220px]">{loop.subGroup}</span>
            </>
          )}
          {hasBlocks && firstBlock && (
            <>
              <span className="text-ink-ghost">·</span>
              <span className="text-mauve-text">
                {firstBlock.date.slice(5)} {formatTime(firstBlock.startMinute)}
              </span>
            </>
          )}
          {(loop as unknown as Record<string, unknown>)._sourceLineCount != null &&
            ((loop as unknown as Record<string, unknown>)._sourceLineCount as number) > 500 && (
              <span className="px-1 py-[1px] rounded bg-rose-fill text-rose-text" title="Large source file — may need decomposition">
                {(loop as unknown as Record<string, unknown>)._sourceLineCount as number}L
              </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
