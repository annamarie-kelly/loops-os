'use client';

// FirstLaunchRitual — fullscreen first-run prompt that lands the user
// straight into capture. Asks "what are you trying to ship?", takes
// newline-separated lines into the triage inbox, and offers a demo
// seed for explorers. Shown only when localStorage flag is unset and
// the loops list is empty; setting the flag (any path: capture, demo,
// or skip) prevents it from re-appearing.

import { useEffect, useRef, useState } from 'react';
import type { Loop } from '@/lib/types';

const ONBOARDED_KEY = 'loops-ui:onboarded';

interface FirstLaunchRitualProps {
  onCapture: (draft: Omit<Loop, 'id'>) => void | Promise<void>;
  onLoadDemo: () => void | Promise<void>;
  onComplete: () => void;
  onSkip: () => void;
}

export function FirstLaunchRitual({
  onCapture,
  onLoadDemo,
  onComplete,
  onSkip,
}: FirstLaunchRitualProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const lines = value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const canSubmit = lines.length > 0 && !busy;

  const handleStart = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      for (const text of lines) {
        const draft: Omit<Loop, 'id'> = {
          tier: 'now',
          text,
          pLevel: 'P3',
          difficulty: null,
          timeEstimateMinutes: null,
          subGroup: null,
          domain: 'personal',
          source: { file: '00-Inbox/captured.md', line: 1 },
          timeblocks: [],
          done: false,
          updatedAt: now,
          tendSource: 'manual',
        };
        await onCapture(draft);
      }
      localStorage.setItem(ONBOARDED_KEY, '1');
      onComplete();
    } finally {
      setBusy(false);
    }
  };

  const handleDemo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onLoadDemo();
      localStorage.setItem(ONBOARDED_KEY, '1');
      onComplete();
    } finally {
      setBusy(false);
    }
  };

  const handleSkip = () => {
    if (busy) return;
    localStorage.setItem(ONBOARDED_KEY, '1');
    onSkip();
  };

  return (
    <div className="fixed inset-0 z-[70] bg-page overflow-y-auto">
      <div className="min-h-full flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-[640px] flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <span className="text-[10px] uppercase tracking-[0.18em] text-ink-ghost">
              First time
            </span>
            <h1 className="text-[22px] leading-tight text-ink font-medium">
              What are you trying to ship in the next two weeks?
            </h1>
            <p className="text-[13px] text-ink-soft leading-relaxed">
              One thing per line. Capture whatever&rsquo;s loud right now &mdash; you&rsquo;ll triage them in a minute.
            </p>
          </div>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={10}
            placeholder={'Reply to Sarah’s email…\nFinish the Q3 plan…\nFigure out next steps on the API redesign…'}
            className="w-full text-[13px] leading-relaxed px-4 py-3 bg-card text-ink placeholder:text-ink-ghost border border-edge rounded-md focus:outline-none focus:border-[var(--mauve)] resize-y"
          />

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleStart}
              disabled={!canSubmit}
              className="bg-[var(--mauve)] text-white text-[13px] px-4 py-2 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
            >
              Start triaging &rarr;
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={busy}
              className="text-[12px] text-ink-ghost hover:text-ink-soft underline-offset-2 hover:underline"
            >
              Skip for now
            </button>
            {lines.length > 0 && (
              <span className="text-[11px] text-ink-ghost tabular-nums ml-auto">
                {lines.length} &rarr; Triage
              </span>
            )}
          </div>

          <hr className="border-edge" />

          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-ink-soft">
              Just exploring? Try it with sample data instead.
            </p>
            <div>
              <button
                type="button"
                onClick={handleDemo}
                disabled={busy}
                className="text-[12px] px-3 py-1.5 rounded-md border border-edge text-ink-soft hover:text-ink hover:border-[var(--border-hover)] disabled:opacity-40"
              >
                Load demo data
              </button>
            </div>
          </div>

          <p className="text-[11px] text-ink-ghost mt-4">
            On top of your Obsidian vault. You can clear everything later.
          </p>
        </div>
      </div>
    </div>
  );
}
