'use client';

// DetailDrawer: right-edge overlay drawer.
// Slides in over the main content without replacing the day canvas.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextFile, Loop, Tier } from '@/lib/types';
import { TIER_META, formatMinutes, formatTime } from '@/lib/types';
import {
  DIFFICULTY_OPTIONS,
  WORK_MODES,
  WORK_MODE_META,
  effectiveWorkMode,
  pBarColor,
  pPillClass,
} from '@/lib/ui';
import { renderInlineMarkdown } from '@/lib/markdown';
import { TierDot } from './PriorityDot';
import { ScopeActionButtons } from './ScopeActionButtons';
import { CloseGateModal, type CloseGateProceedResult } from './CloseGateModal';

// Parse "P1:Boss" → { level: "P1", stakeholder: "Boss" }.
// "P1:self" → { level: "P1", stakeholder: "self" }.
// Bare "P1" → { level: "P1", stakeholder: null }.
function parsePLevel(p: string | null): { level: string | null; stakeholder: string | null } {
  if (!p) return { level: null, stakeholder: null };
  const idx = p.indexOf(':');
  if (idx < 0) return { level: p, stakeholder: null };
  return { level: p.slice(0, idx), stakeholder: p.slice(idx + 1) || null };
}

// Folder segments → breadcrumb tokens. Strip ".md" from the final segment
// and replace hyphens with spaces for readability, but keep the raw path
// accessible via the tooltip on the container.
function pathBreadcrumb(file: string): string[] {
  const parts = file.split('/').filter(Boolean);
  return parts.map((p, i) => {
    if (i === parts.length - 1) return p.replace(/\.md$/i, '');
    return p;
  });
}

export function DetailDrawer({
  loop,
  context,
  allLoops,
  onClose,
  onUpdateLoop,
  onAddToNextOpenSlot,
  onScheduleRemainder,
  onCloseLoop,
  onDropLoop,
  onOpenDetail,
  onSplitBlock,
  onRemoveBlock,
  onCreateFollowThrough,
  onSwitchToDesign,
  variant = 'overlay',
}: {
  loop: Loop | null;
  context: ContextFile | null;
  allLoops: Loop[];
  onClose: () => void;
  onUpdateLoop: (id: string, patch: Partial<Loop>) => Promise<void>;
  onAddToNextOpenSlot: (id: string) => void;
  onScheduleRemainder?: (id: string) => void;
  onCloseLoop: (id: string) => Promise<void>;
  onDropLoop?: (id: string) => Promise<void> | void;
  onOpenDetail: (id: string) => void;
  onSplitBlock: (id: string, idx: number) => Promise<void>;
  onRemoveBlock: (id: string, idx: number) => Promise<void>;
  // Optional: plumbed from page.tsx so the close gate's follow-through
  // loop gets created via the existing capacity-gated createLoop path.
  // If omitted (Focus mode passes nothing), the follow-through check
  // still runs but the new loop is not materialised.
  onCreateFollowThrough?: (args: {
    title: string;
    dueDate: string;
    sourceLoop: Loop;
    artifact: string;
  }) => Promise<void> | void;
  onSwitchToDesign?: () => void;
  // overlay = fixed right drawer with scrim (default, used by Plan/Triage)
  // inline  = flows as a regular block element (used by FocusMode center)
  variant?: 'overlay' | 'inline';
}) {
  const isInline = variant === 'inline';
  const [closeGateOpen, setCloseGateOpen] = useState(false);
  if (!loop) return null;
  const isDone = !!loop.done;

  const relatedBySource = allLoops.filter(
    (l) => l.id !== loop.id && l.source.file === loop.source.file,
  );
  const relatedBySubgroup = allLoops.filter(
    (l) =>
      l.id !== loop.id &&
      l.subGroup === loop.subGroup &&
      l.source.file !== loop.source.file,
  );

  // Facts at a glance ------------------------------------------------
  const { level: pureLevel, stakeholder } = parsePLevel(loop.pLevel);
  const breadcrumb = pathBreadcrumb(loop.source.file);

  // Time accounting: sum placed block minutes, compare to estimate.
  const scheduledMinutes = loop.timeblocks.reduce(
    (sum, tb) => sum + (tb.endMinute - tb.startMinute),
    0,
  );
  const estimateMinutes = loop.timeEstimateMinutes ?? 0;
  const remainingMinutes = Math.max(0, estimateMinutes - scheduledMinutes);
  const overBudget = estimateMinutes > 0 && scheduledMinutes > estimateMinutes;

  // Subgroup context: how many siblings are already on a calendar block.
  const subgroupSiblings = loop.subGroup
    ? allLoops.filter((l) => !l.done && l.subGroup === loop.subGroup)
    : [];
  const subgroupScheduled = subgroupSiblings.filter(
    (l) => l.timeblocks.length > 0,
  ).length;

  // Quick-pick priority values. Bare P-levels only (no stakeholder shaking).
  const priorityPicker: string[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

  // Source context is a reference lookup, not a primary action surface.
  // Keep it collapsed by default so the action footer is closer to the
  // top of the scroll. Persist preference across sessions.
  const [sourceOpen, setSourceOpen] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('loops-ui:detail-source-open');
      if (raw === 'true') setSourceOpen(true);
    } catch {}
  }, []);
  const toggleSourceOpen = () => {
    setSourceOpen((v) => {
      try {
        localStorage.setItem('loops-ui:detail-source-open', String(!v));
      } catch {}
      return !v;
    });
  };

  // The Obsidian app URL uses the vault folder name as an identifier.
  // Override via NEXT_PUBLIC_OBSIDIAN_VAULT (falls back to the vault
  // root's basename, which matches for most setups).
  const vaultName =
    (typeof process !== 'undefined' &&
      process.env?.NEXT_PUBLIC_OBSIDIAN_VAULT) ||
    'vault';
  const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(
    vaultName
  )}&file=${encodeURIComponent(loop.source.file)}`;

  const onFieldChange = async (patch: Partial<Loop>) => {
    // Auto-append a system note when the user changes tier. Gives the
    // loop a lightweight activity log so future-you remembers why it
    // moved without having to dig through git history.
    if (patch.tier && patch.tier !== loop.tier) {
      const prevLabel = TIER_META[loop.tier].label;
      const nextLabel = TIER_META[patch.tier].label;
      const existing = loop.notes ?? [];
      patch = {
        ...patch,
        notes: [
          ...existing,
          {
            id: Math.random().toString(36).slice(2, 10),
            createdAt: new Date().toISOString(),
            text: `→ Moved from ${prevLabel} to ${nextLabel}`,
            system: true,
          },
        ],
      };
    }
    await onUpdateLoop(loop.id, patch);
  };

  return (
    <>
      {/* Scrim: click to close. Only rendered for overlay variant.
          Hidden on wide screens where the overlay drawer becomes an
          inline right panel in the app shell. */}
      {!isInline && (
        <div
          className="fixed inset-0 bg-black/20 z-40 backdrop-blur-[1px] min-[1400px]:hidden"
          onClick={onClose}
        />
      )}
      <aside
        role={isInline ? undefined : 'dialog'}
        aria-label="Loop detail"
        className={
          isInline
            ? 'relative w-full max-h-full bg-card border border-edge rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] flex flex-col overflow-hidden'
            : 'fixed top-0 right-0 bottom-0 w-[420px] max-w-[92vw] bg-elevated border-l border-edge shadow-2xl z-50 flex flex-col min-[1400px]:shadow-none'
        }
      >
        {/* Header: tiny breadcrumb (whispers) + bold title + close */}
        <div className="px-5 pt-3 pb-3 border-b border-edge shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => {
                  // Use window.location for custom protocols —
                  // more reliable than <a href> on some browsers.
                  window.location.href = obsidianUrl;
                }}
                title={`Open ${loop.source.file}:${loop.source.line} in Obsidian`}
                className="block text-[10px] text-ink-ghost hover:text-ink-soft mb-1.5 font-mono truncate text-left w-full hover:underline"
              >
                {breadcrumb.join(' › ')} · L{loop.source.line} ↗
              </button>
              <EditableTitle
                value={loop.text}
                disabled={isDone}
                onSave={(text) => onFieldChange({ text })}
              />
            </div>
            {!isInline && (
              <button
                onClick={onClose}
                className="text-ink-ghost hover:text-ink text-xl leading-none shrink-0 w-7 h-7 flex items-center justify-center rounded-md hover:bg-inset"
                title="Close (esc)"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle">
          {/* Activity strip: cumulative memory for this loop. Whispers
              at the top of the body so "how have I engaged with this
              before" is visible the moment you open the drawer. */}
          <ActivityStrip loop={loop} />

          {/* Dense meta line: no field labels — the values are self-evident
              to a technical audience. Stakeholder · P-level · difficulty ·
              estimate, with tier right-aligned. Subgroup sits on a quiet
              second row. */}
          <div className="px-5 pt-3 pb-3 border-b border-edge-subtle">
            <div className="flex items-center gap-2 text-[12px] text-ink">
              <span className="text-ink capitalize">
                {stakeholder || <span className="text-ink-ghost">—</span>}
              </span>
              {pureLevel && (
                <>
                  <span className="text-ink-ghost">·</span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-[1px] rounded ${pPillClass(pureLevel)}`}
                  >
                    {pureLevel}
                  </span>
                </>
              )}
              <span className="text-ink-ghost">·</span>
              <EditableNumber
                value={loop.difficulty}
                disabled={isDone}
                options={DIFFICULTY_OPTIONS}
                placeholder="D—"
                prefix="D:"
                onSave={(n) => onFieldChange({ difficulty: n })}
              />
              <span className="text-ink-ghost">·</span>
              <EditableNumber
                value={loop.timeEstimateMinutes}
                disabled={isDone}
                step={15}
                suffix="m"
                placeholder="—"
                format={(n) => formatMinutes(n)}
                onSave={(n) => onFieldChange({ timeEstimateMinutes: n })}
              />
              <span className="text-ink-ghost">·</span>
              <ModeSelect
                loop={loop}
                disabled={isDone}
                onSave={(workMode) =>
                  onFieldChange({ workMode, workModeSource: 'manual' })
                }
              />
              <span className="ml-auto flex items-center gap-1.5 text-ink-soft">
                <TierDot tier={loop.tier} size="xs" />
                <span>{TIER_META[loop.tier].label}</span>
                {isDone && (
                  <span className="ml-1 text-[9px] px-1 py-[1px] rounded bg-sage-fill text-sage-text font-medium">
                    done
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1.5 text-[11px] text-ink-faint">
              <EditableText
                value={loop.subGroup ?? ''}
                disabled={isDone}
                placeholder="—"
                onSave={(v) => onFieldChange({ subGroup: v || null })}
              />
            </div>

            {/* Second line: blocked toggle + due date. Both optional;
                they surface here so you can set them without leaving
                the drawer. */}
            <div className="mt-2 flex items-center gap-3 text-[11px]">
              <button
                type="button"
                onClick={() => onFieldChange({ blocked: !loop.blocked })}
                disabled={isDone}
                className={`flex items-center gap-1 px-1.5 py-[2px] rounded transition-colors ${
                  loop.blocked
                    ? 'bg-berry-fill text-berry-text'
                    : 'text-ink-ghost hover:text-ink-soft hover:bg-inset'
                }`}
                title={
                  loop.blocked
                    ? 'Currently blocked — click to unblock'
                    : 'Mark as blocked / waiting'
                }
              >
                <span aria-hidden>{loop.blocked ? '⏸' : '▸'}</span>
                {loop.blocked ? 'blocked' : 'open'}
              </button>
              <DueDateField
                value={loop.dueDate ?? null}
                disabled={isDone}
                onSave={(d) => onFieldChange({ dueDate: d || undefined })}
              />
              {loop.updatedAt && (
                <span
                  className="text-[10px] text-ink-ghost italic ml-auto"
                  title={new Date(loop.updatedAt).toLocaleString()}
                >
                  touched {relativeTime(loop.updatedAt)}
                </span>
              )}
            </div>
          </div>

          {/* Scope actions. Only rendered when the loop carries
              scope_questions — otherwise invisible. */}
          <ScopeActionButtons
            loop={loop}
            onUpdateLoop={onUpdateLoop}
            disabled={isDone}
          />

          {!isInline && <SectionLabel>Scheduling</SectionLabel>}

          {/* Time accounting: estimated vs scheduled vs remaining. Only
              appears once there's something to compare. */}
          {(estimateMinutes > 0 || scheduledMinutes > 0) && !isInline && (
            <div className="px-5 pb-3">
              <div className="flex items-center gap-3 text-[11px] text-ink-soft tabular-nums">
                <span>
                  <span className="text-ink-ghost">est </span>
                  {formatMinutes(estimateMinutes)}
                </span>
                <span className="text-ink-ghost">·</span>
                <span>
                  <span className="text-ink-ghost">blocked </span>
                  {formatMinutes(scheduledMinutes)}
                </span>
                {!overBudget && estimateMinutes > 0 && remainingMinutes > 0 && (
                  <>
                    <span className="text-ink-ghost">·</span>
                    {onScheduleRemainder && !isDone && !isInline ? (
                      <button
                        type="button"
                        onClick={() => onScheduleRemainder(loop.id)}
                        className="group/open inline-flex items-center gap-1 rounded px-1.5 py-[1px] text-sage-text hover:bg-sage-fill transition-colors"
                        title={`Schedule ${formatMinutes(remainingMinutes)} into the next open slot today`}
                      >
                        <span className="text-ink-ghost group-hover/open:text-sage-text transition-colors">
                          open
                        </span>
                        <span className="tabular-nums">
                          {formatMinutes(remainingMinutes)}
                        </span>
                        <span className="text-[9px] opacity-0 group-hover/open:opacity-100 transition-opacity">
                          ↗
                        </span>
                      </button>
                    ) : (
                      <span>
                        <span className="text-ink-ghost">open </span>
                        {formatMinutes(remainingMinutes)}
                      </span>
                    )}
                  </>
                )}
                {overBudget && (
                  <>
                    <span className="text-ink-ghost">·</span>
                    <span className="text-rose-text">
                      over by {formatMinutes(scheduledMinutes - estimateMinutes)}
                    </span>
                  </>
                )}
                {estimateMinutes > 0 && (
                  <span className="ml-auto text-ink-ghost text-[10px]">
                    {Math.min(
                      999,
                      Math.round((scheduledMinutes / estimateMinutes) * 100),
                    )}
                    %
                  </span>
                )}
              </div>
              {estimateMinutes > 0 && (
                <div className="mt-2 h-1 rounded-full bg-inset overflow-hidden">
                  <div
                    className={`h-full ${overBudget ? 'bg-[var(--rose)]' : 'bg-[var(--sage)]'}`}
                    style={{
                      width: `${Math.min(
                        100,
                        (scheduledMinutes / estimateMinutes) * 100,
                      )}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Subgroup progress: sibling count + how many on the calendar. */}
          {subgroupSiblings.length > 0 && !isInline && (
            <div className="px-5 pb-3 text-[11px] text-ink-soft">
              <span className="text-ink-ghost">progress </span>
              <span className="tabular-nums">
                {subgroupScheduled} of {subgroupSiblings.length + 1} scheduled
              </span>
            </div>
          )}

          {/* Priority quick-pick: compact pills, no label. Preserves
              stakeholder suffix ("P1:Boss" → "P2:Boss"). Hidden in
              Focus/inline mode — priority is a planning decision, not
              something you re-litigate while doing the work. */}
          {!isDone && !isInline && (
            <div className="px-5 pb-3 flex items-center gap-1">
              {priorityPicker.map((p) => {
                const active = pureLevel === p;
                const nextValue = stakeholder ? `${p}:${stakeholder}` : p;
                return (
                  <button
                    key={p}
                    onClick={() => onFieldChange({ pLevel: nextValue })}
                    className={`text-[9px] font-mono px-1.5 h-[18px] rounded transition-all ${
                      active
                        ? `${pPillClass(p)} ring-1 ring-[var(--mauve)]`
                        : `${pPillClass(p)} opacity-40 hover:opacity-100`
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          )}

          {/* Time blocks list. Hidden in Focus mode — scheduling is
              done, now is the time to execute. Softer inset background
              so rows don't shout, split/remove only on hover. */}
          {loop.timeblocks.length > 0 && !isInline && (
            <div className="px-5 pb-3">
              <div className="text-[10px] text-ink-ghost mb-1.5">Time blocks</div>
              <ul className="flex flex-col gap-1">
                {loop.timeblocks.map((tb, idx) => {
                  const dur = tb.endMinute - tb.startMinute;
                  return (
                    <li
                      key={`${tb.date}-${tb.startMinute}-${idx}`}
                      className="group/tb flex items-center gap-2 text-[12px] bg-inset rounded-md px-2.5 py-1.5"
                    >
                      <span className="text-[10px] text-ink-faint tabular-nums w-12 shrink-0">
                        {tb.date.slice(5)}
                      </span>
                      <span className="text-ink font-medium tabular-nums">
                        {formatTime(tb.startMinute)}–{formatTime(tb.endMinute)}
                      </span>
                      <span className="text-[10px] text-ink-ghost tabular-nums">
                        {dur}m
                      </span>
                      {!isDone && (
                        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover/tb:opacity-100 transition-opacity">
                          <button
                            onClick={() => onSplitBlock(loop.id, idx)}
                            disabled={dur < 30}
                            className="px-1.5 py-0.5 rounded text-[10px] text-ink-ghost hover:text-ink-soft disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Split this block in half"
                          >
                            split
                          </button>
                          <button
                            onClick={() => onRemoveBlock(loop.id, idx)}
                            className="px-1.5 py-0.5 rounded text-[10px] text-ink-ghost hover:text-rose-text"
                            title="Remove this block"
                          >
                            remove
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Tier quick-pick with earthy dots. Hidden in Focus/inline
              mode for the same reason priority is: tier is a planning
              decision, not a doing decision. */}
          {!isDone && !isInline && (
            <div className="px-5 pb-4">
              <div className="flex items-center gap-0.5 rounded-md bg-inset p-0.5 w-fit">
                {(['now', 'soon', 'someday'] as Tier[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => onFieldChange({ tier: t })}
                    className={`px-3 py-1 rounded text-[11px] flex items-center gap-1.5 transition-colors ${
                      loop.tier === t
                        ? 'bg-card text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                        : 'text-ink-soft hover:text-ink'
                    }`}
                  >
                    <TierDot tier={t} size="xs" />
                    {TIER_META[t].label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ─── NOTES ─── */}
          <div className="border-t border-edge-subtle">
            <SectionLabel>Notes</SectionLabel>
          </div>
          <NotesSection
            notes={loop.notes ?? []}
            disabled={isDone}
            onSave={(notes) => onFieldChange({ notes })}
          />

          {/* ─── CONTEXT ───
              Only rendered when there's actual content to show: real
              source file available AND/OR related loops. A missing
              source is no longer an error state — we just hide it. */}
          {(context?.available ||
            relatedBySource.length > 0 ||
            relatedBySubgroup.length > 0) && (
            <div className="border-t border-edge-subtle">
              <SectionLabel>Context</SectionLabel>
            </div>
          )}

          {context?.available && (
            <div className="px-5 pb-3">
              <button
                type="button"
                onClick={toggleSourceOpen}
                className="w-full flex items-center gap-2 text-[10px] text-ink-ghost hover:text-ink-soft transition-colors"
              >
                <span className="w-2 text-[9px]">{sourceOpen ? '▾' : '▸'}</span>
                <span>View in Obsidian — source preview</span>
              </button>
              {sourceOpen && (
                <div className="mt-2">
                  <pre className="text-[11px] font-mono text-ink-soft whitespace-pre-wrap bg-inset rounded-md border border-edge-subtle p-2 overflow-x-auto">
                    {context.lines.map((line, i) => {
                      const isTarget = i === context.targetLineIndex;
                      return (
                        <div
                          key={i}
                          className={
                            isTarget
                              ? 'bg-slate-fill text-ink border-l-2 border-[var(--slate)] pl-1 -ml-1'
                              : ''
                          }
                        >
                          <span className="text-ink-ghost select-none">
                            {String(context.startLine + i).padStart(3, ' ')}│
                          </span>{' '}
                          {line || ' '}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Related loops — stays inside the Context group. */}
          {(relatedBySource.length > 0 || relatedBySubgroup.length > 0) && (
            <div className="px-5 pb-3">
              <div className="text-[10px] text-ink-ghost mb-2">Related loops</div>
              {relatedBySource.length > 0 && (
                <div className="mb-3">
                  <div className="text-[10px] text-ink-ghost mb-1">Same source file</div>
                  <ul className="flex flex-col gap-1">
                    {relatedBySource.slice(0, 6).map((r) => (
                      <li key={r.id}>
                        <button
                          onClick={() => onOpenDetail(r.id)}
                          className="text-[12px] text-ink-soft hover:text-ink text-left truncate w-full flex items-center gap-2"
                        >
                          <span
                            className={`inline-block w-1 h-1 rounded-full ${pBarColor(r.pLevel)}`}
                          />
                          <TierDot tier={r.tier} size="xs" />
                          <span className="truncate">{r.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {relatedBySubgroup.length > 0 && (
                <div>
                  <div className="text-[10px] text-ink-ghost mb-1">Same subgroup</div>
                  <ul className="flex flex-col gap-1">
                    {relatedBySubgroup.slice(0, 6).map((r) => (
                      <li key={r.id}>
                        <button
                          onClick={() => onOpenDetail(r.id)}
                          className="text-[12px] text-ink-soft hover:text-ink text-left truncate w-full flex items-center gap-2"
                        >
                          <span
                            className={`inline-block w-1 h-1 rounded-full ${pBarColor(r.pLevel)}`}
                          />
                          <TierDot tier={r.tier} size="xs" />
                          <span className="truncate">{r.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky actions footer. In Focus mode we drop the scheduling
            primary action — Focus is for *doing*, not planning. In
            overlay (Plan/Triage) mode we still offer the full-width
            "schedule next open slot" button. Done loops are read-only. */}
        <div className="px-5 py-3 border-t border-edge flex flex-col gap-2 shrink-0 bg-elevated">
          {!isDone && !isInline && (
            <button
              onClick={() => onAddToNextOpenSlot(loop.id)}
              className="w-full px-3 py-2.5 rounded-lg bg-inset hover:bg-edge/60 border-[0.5px] border-edge text-ink text-[13px] font-medium transition-colors"
              title="Find the next open block today and schedule it there"
            >
              {loop.timeEstimateMinutes != null
                ? `Schedule next open ${formatMinutes(loop.timeEstimateMinutes)} slot`
                : 'Schedule in next open slot'}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            {!isDone && (
              <>
                <button
                  onClick={() => setCloseGateOpen(true)}
                  className="flex-1 px-3 py-1.5 rounded-md bg-transparent border-[0.5px] border-edge text-ink-soft hover:border-[var(--sage)] hover:bg-sage-fill hover:text-sage-text text-[12px] transition-colors"
                  title="Mark shipped (runs the 5-check close-out gate)"
                >
                  Done
                </button>
                <button
                  onClick={() => (onDropLoop ? onDropLoop(loop.id) : onCloseLoop(loop.id))}
                  className="flex-1 px-3 py-1.5 rounded-md bg-transparent border-[0.5px] border-edge text-ink-soft hover:border-[var(--rose)] hover:bg-rose-fill hover:text-rose-text text-[12px] transition-colors"
                  title="Drop this loop — soft archive"
                >
                  Drop
                </button>
              </>
            )}
            {!isDone && (
              <button
                onClick={async () => {
                  // Scaffold a drafting spec from this loop
                  const res = await fetch('/api/vault/specs/scaffold', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      loopTitle: loop.text,
                      loopContext: loop.notes?.map((n) => n.text).filter(Boolean).join('\n') || undefined,
                    }),
                  });
                  // Update the loop with a note regardless of scaffold result
                  await onUpdateLoop(loop.id, {
                    status: 'someday' as Loop['status'],
                    notes: [
                      ...(loop.notes ?? []),
                      {
                        id: `ns-${Date.now()}`,
                        createdAt: new Date().toISOString(),
                        text: `Moved to Design Bench — ${res.ok ? 'spec created' : 'needs specification'}`,
                        system: true,
                      },
                    ],
                  });
                  onSwitchToDesign?.();
                }}
                className="px-3 py-1.5 rounded-md bg-transparent border-[0.5px] border-edge text-ink-soft hover:border-[var(--tan)] hover:bg-tan-fill hover:text-tan-text text-[12px] transition-colors"
                title="This task needs a spec before building"
              >
                Needs spec
              </button>
            )}
            <a
              href={obsidianUrl}
              className={`${isDone ? 'flex-1' : ''} px-3 py-1.5 rounded-md bg-transparent border-[0.5px] border-edge text-ink-soft hover:border-[var(--mauve)] hover:bg-mauve-fill hover:text-mauve-text text-[12px] text-center transition-colors`}
            >
              Obsidian ↗
            </a>
          </div>
        </div>
      </aside>
      <CloseGateModal
        open={closeGateOpen}
        loop={loop}
        onCancel={() => setCloseGateOpen(false)}
        onProceed={async (result: CloseGateProceedResult) => {
          setCloseGateOpen(false);
          // Fire-and-forget follow-through loop creation. Composes with
          // the existing capacity gate: createLoop on page.tsx runs its
          // own P1 ceiling check before materialising.
          if (result.followThroughRequested && onCreateFollowThrough) {
            try {
              await onCreateFollowThrough({
                title: result.followThroughTitle,
                dueDate: result.followThroughDate,
                sourceLoop: loop,
                artifact: result.artifact,
              });
            } catch {
              /* non-fatal: close-out already persisted */
            }
          }
          await onCloseLoop(loop.id);
        }}
      />
    </>
  );
}

// ─── Notes section ──────────────────────────────────────────────────

function NotesSection({
  notes,
  disabled,
  onSave,
}: {
  notes: { id: string; createdAt: string; text: string; system?: boolean }[];
  disabled?: boolean;
  onSave: (next: { id: string; createdAt: string; text: string; system?: boolean }[]) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(
    () => [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [notes],
  );
  const visible = showAll ? sorted : sorted.slice(0, 5);
  const hidden = sorted.length - visible.length;

  const submit = () => {
    const text = draft.trim();
    if (!text) {
      setComposing(false);
      setDraft('');
      return;
    }
    const newNote = {
      id: Math.random().toString(36).slice(2, 10),
      createdAt: new Date().toISOString(),
      text,
    };
    onSave([...notes, newNote]);
    setDraft('');
    setComposing(false);
  };

  const remove = (id: string) => {
    onSave(notes.filter((n) => n.id !== id));
  };

  return (
    <div className="px-5 pb-3">
      {visible.length > 0 && (
        <ul className="flex flex-col gap-1 mb-2">
          {visible.map((n) => (
            <li
              key={n.id}
              className={`group/note relative ${
                n.system
                  ? 'text-[11px] text-ink-ghost pl-2 border-l-2 border-edge-subtle py-1 flex items-baseline gap-3'
                  : 'text-[12px] text-ink bg-inset rounded-md px-3 py-2 flex items-baseline gap-3'
              }`}
            >
              <div className="flex-1 min-w-0 whitespace-pre-wrap leading-snug text-left">
                {n.text}
              </div>
              <div className="text-[9px] text-ink-ghost tabular-nums shrink-0">
                {relativeTime(n.createdAt)}
              </div>
              {!n.system && !disabled && (
                <button
                  onClick={() => remove(n.id)}
                  className="absolute top-1 right-1 w-4 h-4 rounded-full text-[10px] text-ink-ghost opacity-0 group-hover/note:opacity-60 hover:!opacity-100 hover:bg-rose-fill hover:text-rose-text flex items-center justify-center transition-all"
                  title="Delete note"
                  aria-label="Delete note"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[10px] text-ink-ghost hover:text-ink-soft mb-2"
        >
          show {hidden} older note{hidden === 1 ? '' : 's'}…
        </button>
      )}
      {!disabled &&
        (composing ? (
          <div>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setComposing(false);
                  setDraft('');
                }
              }}
              rows={3}
              placeholder="Add a note…"
              className="w-full text-[12px] text-ink bg-card border border-edge rounded-lg px-3 py-2.5 placeholder:text-ink-ghost/60 shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)] focus:outline-none focus:border-[var(--mauve)]/60 focus:ring-2 focus:ring-[var(--mauve)]/15 transition-all leading-relaxed"
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[10px] text-ink-ghost font-mono">
                <kbd className="mr-0.5">⌘↵</kbd> save
                <span className="mx-1.5 opacity-40">·</span>
                <kbd className="mr-0.5">esc</kbd> cancel
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setComposing(false);
                    setDraft('');
                  }}
                  className="text-[11px] text-ink-ghost hover:text-ink-soft px-2.5 py-1 rounded-md hover:bg-inset transition-colors"
                >
                  cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim()}
                  className="text-[11px] text-ink bg-inset hover:bg-[var(--mauve)]/10 hover:text-mauve-text px-3 py-1 rounded-md border-[0.5px] border-edge hover:border-[var(--mauve)]/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-inset disabled:hover:text-ink disabled:hover:border-edge transition-all"
                >
                  save
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="text-[11px] text-ink-ghost hover:text-ink-soft py-1.5 transition-colors"
          >
            + Add a note…
          </button>
        ))}
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── Inline editors ─────────────────────────────────────────────────

// ─── Activity strip ────────────────────────────────────────────────
// Whisper-weight strip at the top of the drawer body. Aggregates the
// existing `updatedAt`, `timeblocks`, `notes`, and `doneAt` fields into
// a one-line cumulative-memory summary so opening a loop answers
// "how have I been engaging with this?" without scrolling.

function ActivityStrip({ loop }: { loop: Loop }) {
  const totalBlockedMin = (loop.timeblocks ?? []).reduce(
    (sum, tb) => sum + (tb.endMinute - tb.startMinute),
    0,
  );
  const userNoteCount = (loop.notes ?? []).filter((n) => !n.system).length;
  const blockSessionCount = (loop.timeblocks ?? []).length;
  const touched = loop.updatedAt ?? null;

  // If there's no signal at all, render nothing — no need to show
  // "brand new loop" noise on every newly-scanned item.
  if (
    !touched &&
    totalBlockedMin === 0 &&
    userNoteCount === 0 &&
    blockSessionCount === 0
  ) {
    return null;
  }

  const parts: string[] = [];
  if (touched) parts.push(`touched ${relativeTime(touched)}`);
  if (totalBlockedMin > 0) {
    parts.push(
      `${formatMinutes(totalBlockedMin)} blocked across ${blockSessionCount} ${
        blockSessionCount === 1 ? 'session' : 'sessions'
      }`,
    );
  }
  if (userNoteCount > 0) {
    parts.push(`${userNoteCount} note${userNoteCount === 1 ? '' : 's'}`);
  }

  return (
    <div className="px-5 pt-3 pb-2 flex items-center gap-2 text-[10px] text-ink-ghost tabular-nums">
      <span className="uppercase tracking-[0.08em]">activity</span>
      <span className="opacity-50">·</span>
      <span className="text-ink-faint">{parts.join(' · ')}</span>
    </div>
  );
}

function DueDateField({
  value,
  disabled,
  onSave,
}: {
  value: string | null;
  disabled?: boolean;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  // Compute relative "due in 3d" so the chip tells you urgency at a glance.
  const dueDays = value
    ? Math.round(
        (new Date(value).getTime() - new Date().setHours(0, 0, 0, 0)) /
          86_400_000,
      )
    : null;
  const tone =
    dueDays == null
      ? 'text-ink-ghost hover:text-ink-soft hover:bg-inset'
      : dueDays < 0
        ? 'bg-rose-fill text-rose-text'
        : dueDays <= 2
          ? 'bg-rose-fill text-rose-text'
          : dueDays <= 7
            ? 'bg-tan-fill text-tan-text'
            : 'bg-inset text-ink-soft';
  const label =
    dueDays == null
      ? '+ due date'
      : dueDays < 0
        ? `overdue ${Math.abs(dueDays)}d`
        : dueDays === 0
          ? 'due today'
          : `due in ${dueDays}d`;

  if (editing) {
    return (
      <input
        autoFocus
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onSave(draft || null);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(value ?? '');
            setEditing(false);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            onSave(draft || null);
            setEditing(false);
          }
        }}
        className="text-[11px] bg-card border border-[var(--mauve)]/60 focus:ring-2 focus:ring-[var(--mauve)]/15 rounded px-1.5 py-0.5 text-ink focus:outline-none"
      />
    );
  }

  // Two siblings: the date chip button + an optional clear-× button.
  // Using a nested <button> inside a <button> was invalid DOM and
  // swallowed the click, which is why due date "didn't do anything".
  return (
    <span className={`inline-flex items-center gap-0.5 rounded transition-colors ${tone}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        className="flex items-center px-1.5 py-[2px] rounded"
        title={value ? `Due ${value} · click to change` : 'Set a due date'}
      >
        {label}
      </button>
      {value && !disabled && (
        <button
          type="button"
          aria-label="Clear due date"
          onClick={(e) => {
            e.stopPropagation();
            onSave(null);
          }}
          className="text-[10px] text-ink-ghost hover:text-ink-soft pr-1 leading-none"
        >
          ×
        </button>
      )}
    </span>
  );
}

function ModeSelect({
  loop,
  disabled,
  onSave,
}: {
  loop: Loop;
  disabled?: boolean;
  onSave: (mode: Loop['workMode']) => void;
}) {
  const current = effectiveWorkMode(loop);
  const meta = WORK_MODE_META[current];
  const isAuto = loop.workModeSource !== 'manual';

  return (
    <label
      className={`relative inline-flex items-center text-[11px] font-mono cursor-pointer ${
        disabled ? 'pointer-events-none opacity-50' : ''
      }`}
      style={{ color: `var(${meta.accent})`, opacity: isAuto ? 0.55 : 1 }}
      title={isAuto ? 'Inferred — click to pin' : 'Manually set'}
    >
      <span>{meta.label}</span>
      <span className="ml-[2px] text-[9px]">▾</span>
      <select
        className="absolute inset-0 opacity-0 cursor-pointer"
        value={current}
        disabled={disabled}
        onChange={(e) => onSave(e.target.value as Loop['workMode'])}
      >
        {WORK_MODES.map((m) => (
          <option key={m} value={m}>
            {WORK_MODE_META[m].label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 pt-3 pb-2 text-[9px] uppercase tracking-[0.08em] text-ink-ghost font-normal">
      {children}
    </div>
  );
}

function Fact({
  label,
  children,
  span = 1,
}: {
  label: string;
  children: React.ReactNode;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? 'col-span-2' : undefined}>
      <div className="text-[9px] uppercase tracking-wider text-ink-ghost mb-0.5">
        {label}
      </div>
      <div className="text-[12px] text-ink-soft flex items-center gap-1 min-h-[18px]">
        {children}
      </div>
    </div>
  );
}

function EditableTitle({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled?: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.select();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setEditing(true)}
        className={`text-[14px] text-ink leading-snug text-left w-full rounded-sm -mx-1 px-1 py-0.5 hover:bg-inset transition-colors ${
          disabled ? 'cursor-default line-through text-ink-ghost' : 'cursor-text'
        }`}
        title={disabled ? undefined : 'Click to edit'}
      >
        {renderInlineMarkdown(value)}
      </button>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    setEditing(false);
  };

  return (
    <textarea
      ref={taRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      rows={2}
      className="w-full text-[14px] text-ink leading-snug bg-card border border-edge rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--mauve)]/60 focus:ring-2 focus:ring-[var(--mauve)]/15 shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)] resize-y transition-all"
    />
  );
}

function EditableText({
  value,
  disabled,
  placeholder,
  onSave,
}: {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setEditing(true)}
        className={`text-[12px] text-ink-soft text-left rounded-sm px-1 -mx-1 hover:bg-inset transition-colors ${
          disabled ? 'cursor-default' : 'cursor-text'
        }`}
        title={disabled ? undefined : 'Click to edit'}
      >
        {value || <span className="text-ink-ghost">{placeholder ?? '—'}</span>}
      </button>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
    setEditing(false);
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full text-[12px] text-ink bg-card border border-edge rounded-md px-2 py-1 focus:outline-none focus:border-[var(--mauve)]/60 focus:ring-2 focus:ring-[var(--mauve)]/15 transition-all"
    />
  );
}

function EditableNumber({
  value,
  disabled,
  step = 1,
  options,
  placeholder,
  prefix,
  suffix,
  format,
  onSave,
}: {
  value: number | null;
  disabled?: boolean;
  step?: number;
  options?: readonly number[];
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  format?: (n: number) => string;
  onSave: (next: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value != null ? String(value) : '');

  useEffect(() => {
    if (!editing) setDraft(value != null ? String(value) : '');
  }, [value, editing]);

  const display = (() => {
    if (value == null) return null;
    if (format) return format(value);
    return `${prefix ?? ''}${value}${suffix ?? ''}`;
  })();

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setEditing(true)}
        className={`text-[12px] text-ink-soft text-left rounded-sm px-1 -mx-1 hover:bg-inset transition-colors tabular-nums ${
          disabled ? 'cursor-default' : 'cursor-text'
        }`}
        title={disabled ? undefined : 'Click to edit'}
      >
        {display ?? <span className="text-ink-ghost">{placeholder ?? '—'}</span>}
      </button>
    );
  }

  const commit = () => {
    if (draft.trim() === '') {
      if (value != null) onSave(null);
    } else {
      const n = Number(draft);
      if (Number.isFinite(n) && n !== value) onSave(n);
    }
    setEditing(false);
  };

  if (options) {
    return (
      <select
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="text-[12px] text-ink bg-card border border-edge rounded-md px-2 py-1 focus:outline-none focus:border-[var(--mauve)]/60 focus:ring-2 focus:ring-[var(--mauve)]/15 transition-all"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {prefix ?? ''}
            {o}
            {suffix ?? ''}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      autoFocus
      type="number"
      step={step}
      min={0}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className="w-20 text-[12px] text-ink bg-card border border-edge rounded-md px-2 py-1 focus:outline-none focus:border-[var(--mauve)]/60 focus:ring-2 focus:ring-[var(--mauve)]/15 tabular-nums transition-all"
    />
  );
}
