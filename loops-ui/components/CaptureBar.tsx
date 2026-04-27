'use client';

// CaptureBar — a slide-up capture surface that lands lines as
// triage-inbox loops. Triggered by `c` from anywhere (when no input
// is focused). Stays open after each Enter so the user can rattle
// off several captures in a row.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Loop } from '@/lib/types';

interface CaptureBarProps {
  open: boolean;
  onClose: () => void;
  onCapture: (draft: Omit<Loop, 'id'>) => void | Promise<void>;
}

export function CaptureBar({ open, onClose, onCapture }: CaptureBarProps) {
  const [value, setValue] = useState('');
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fadeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setLastCaptured(null);
      setCount(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Esc closes the bar.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Fade the "captured X" hint after a moment so chained captures
  // feel ambient, not noisy.
  useEffect(() => {
    if (!lastCaptured) return;
    if (fadeTimerRef.current != null) window.clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = window.setTimeout(() => {
      setLastCaptured(null);
    }, 2400);
    return () => {
      if (fadeTimerRef.current != null) window.clearTimeout(fadeTimerRef.current);
    };
  }, [lastCaptured]);

  const submit = useCallback(async () => {
    const text = value.trim();
    if (!text) {
      // Stay open — empty Enter is a no-op so chained capture
      // doesn't get accidentally torn down. Esc closes.
      return;
    }
    const now = new Date().toISOString();
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
    setLastCaptured(text);
    setCount((n) => n + 1);
    setValue('');
  }, [value, onCapture]);

  if (!open) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[55] pointer-events-none">
      {/* Subtle backdrop on the upper edge so the bar reads as a layer
          without dimming the whole screen. */}
      <div className="pointer-events-auto bg-[var(--surface-page)]/95 backdrop-blur border-t border-edge shadow-2xl">
        <div className="max-w-[760px] mx-auto px-5 py-3 flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost shrink-0">
            Capture
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="What's loud right now? Enter to send to triage, Esc to close"
            className="flex-1 text-[13px] px-2 py-1.5 bg-transparent text-ink placeholder:text-ink-ghost focus:outline-none border-b border-edge focus:border-[var(--mauve)]"
          />
          <div className="text-[10px] text-ink-ghost shrink-0 tabular-nums">
            {count > 0 ? `${count} captured` : 'inbox'}
          </div>
        </div>
        {lastCaptured && (
          <div className="max-w-[760px] mx-auto px-5 pb-2 text-[10px] text-ink-faint italic truncate">
            ↳ &ldquo;{lastCaptured}&rdquo;
          </div>
        )}
      </div>
    </div>
  );
}
