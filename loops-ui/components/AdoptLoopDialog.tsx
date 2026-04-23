'use client';

// AdoptLoopDialog: minimal "Adopt a loop" modal. Captures title,
// priority (default P2), stakeholder. On submit emits a Loop draft
// that gets piped through createLoop in app/page.tsx — which means
// it also runs through the capacity gate automatically.
//
// Opened via cmd+shift+A. Matches the SearchOverlay modal pattern.

import { useEffect, useRef, useState } from 'react';
import type { Loop } from '@/lib/types';
import { P_LEVEL_OPTIONS } from '@/lib/ui';

export function AdoptLoopDialog({
  open,
  onClose,
  onAdopt,
}: {
  open: boolean;
  onClose: () => void;
  onAdopt: (draft: Omit<Loop, 'id'>) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<string>('P2');
  const [stakeholder, setStakeholder] = useState<string>('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setPriority('P2');
      setStakeholder('');
      requestAnimationFrame(() => titleRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = title.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    const pLevel = stakeholder.trim()
      ? `${priority}:${stakeholder.trim()}`
      : priority;
    const now = new Date().toISOString();
    const draft: Omit<Loop, 'id'> = {
      tier: 'now',
      text: title.trim(),
      pLevel,
      difficulty: null,
      timeEstimateMinutes: null,
      subGroup: null,
      domain: 'personal',
      source: { file: '00-Inbox/adopted.md', line: 1 },
      timeblocks: [],
      done: false,
      updatedAt: now,
      tendSource: 'manual',
    };
    await onAdopt(draft);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Adopt a loop"
      className="fixed inset-0 z-[60] flex justify-center pt-[16vh] px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" aria-hidden />
      <div
        className="relative w-[440px] max-w-full bg-elevated border border-edge rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b border-edge-subtle">
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost mb-1">
            Tend — adopt
          </div>
          <div className="text-[14px] font-medium text-ink">Adopt a loop</div>
          <div className="text-[11px] text-ink-faint mt-1">
            Routes through the capacity gate — if you&rsquo;re already at
            ceiling you&rsquo;ll be asked to justify.
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
              Title
            </span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="text-[12px] text-ink bg-card border border-edge rounded-md px-2.5 py-1.5 focus:outline-none focus:border-[var(--mauve)]/50 focus:ring-2 focus:ring-[var(--mauve)]/15"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
                Priority
              </span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value.split(':')[0])}
                className="text-[12px] text-ink bg-card border border-edge rounded-md px-2 py-1.5 focus:outline-none focus:border-[var(--mauve)]/50"
              >
                {['P0', 'P1', 'P2', 'P3', 'P4'].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
                Stakeholder
              </span>
              <input
                type="text"
                value={stakeholder}
                onChange={(e) => setStakeholder(e.target.value)}
                placeholder="(optional)"
                list="adopt-stakeholders"
                className="text-[12px] text-ink bg-card border border-edge rounded-md px-2.5 py-1.5 placeholder:text-ink-ghost/60 focus:outline-none focus:border-[var(--mauve)]/50"
              />
              <datalist id="adopt-stakeholders">
                {P_LEVEL_OPTIONS.filter((p) => p.includes(':')).map((p) => (
                  <option key={p} value={p.split(':')[1]} />
                ))}
              </datalist>
            </label>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-edge-subtle flex items-center justify-between">
          <span className="text-[10px] text-ink-ghost font-mono">
            <kbd className="border border-edge rounded px-1">↵</kbd> adopt
            <span className="mx-1.5 opacity-40">·</span>
            <kbd className="border border-edge rounded px-1">esc</kbd> cancel
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-[12px] text-ink-soft hover:text-ink px-3 py-1 rounded-md hover:bg-inset transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="text-[12px] text-ink bg-inset hover:bg-[var(--mauve)]/10 hover:text-mauve-text px-3 py-1 rounded-md border-[0.5px] border-edge hover:border-[var(--mauve)]/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Adopt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
