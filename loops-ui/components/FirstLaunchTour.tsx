'use client';

// FirstLaunchTour — second-stage onboarding that runs after the
// FirstLaunchRitual has captured at least one loop. A small,
// self-contained, bottom-right card walks through the four primary
// modes (triage → backlog → plan → focus), nudging `mode` on the
// parent so each step actually shows what it's describing. Not a
// modal, not a scrim — the app stays usable behind it. Dismissed
// (and never shown again) via Skip, Finish, or Escape; parent
// persists completion in localStorage under 'loops-ui:tour-completed'.

import { useEffect, useState } from 'react';
import type { Mode } from '@/lib/ui';

interface FirstLaunchTourProps {
  onSetMode: (m: Mode) => void;
  onComplete: () => void;
}

const STEPS: Array<{ mode: Mode; title: string; body: string }> = [
  {
    mode: 'triage',
    title: 'Triage is the front door.',
    body: "Everything new lands here. Sort into Now, Next, or Later, or trash it. Don't think hard; just decide if it's alive.",
  },
  {
    mode: 'backlog',
    title: 'Backlog is the holding pen.',
    body: "Loops you've decided matter, but aren't doing yet. Group them, rank them, let them wait without rotting in your inbox.",
  },
  {
    mode: 'plan',
    title: 'Plan is where time meets intent.',
    body: "Drag loops onto the calendar to commit. If it's not on here, you're not doing it this week.",
  },
  {
    mode: 'focus',
    title: 'Focus is one thing at a time.',
    body: "Pick a loop, dim the rest of the world, and ship. This is the mode you'll live in most days.",
  },
];

export function FirstLaunchTour({ onSetMode, onComplete }: FirstLaunchTourProps) {
  const [step, setStep] = useState(0);

  // Each step swaps the visible mode so the user sees what's described.
  useEffect(() => {
    onSetMode(STEPS[step].mode);
  }, [step, onSetMode]);

  const isLast = step === STEPS.length - 1;

  const advance = () => {
    if (isLast) {
      onComplete();
    } else {
      setStep((s) => s + 1);
    }
  };

  const back = () => {
    if (step > 0) setStep((s) => s - 1);
  };

  const complete = () => onComplete();

  // Keyboard nav. Defensive: drop events that other layers (drawer
  // Esc, search overlay, inputs) have already claimed or that
  // originate from typeable surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        complete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isLast]);

  const current = STEPS[step];

  return (
    <div
      role="dialog"
      aria-label="First launch tour"
      className="fixed bottom-6 right-6 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-[var(--surface-page)] shadow-xl p-5"
    >
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost mb-2">
        {step + 1} of {STEPS.length}
      </div>
      <div className="text-base font-medium mb-2">{current.title}</div>
      <div className="text-sm text-ink-ghost mb-4 leading-relaxed">
        {current.body}
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={complete}
          className="text-[12px] text-ink-ghost hover:text-ink-soft underline-offset-2 hover:underline"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={back}
              className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 rounded-md hover:bg-inset transition-colors"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={advance}
            className="bg-[var(--mauve)] text-white text-[13px] px-4 py-2 rounded-md hover:opacity-90"
          >
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
