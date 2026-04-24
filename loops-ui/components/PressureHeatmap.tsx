'use client';

// PressureHeatmap: 30-day calendar grid of daily checkpoints.
// Each cell gets a semantic color based on the work-type value:
//   building   → sage
//   improving  → mauve
//   fixing     → tan
//   supporting → rose
//   skipped    → edge (muted)
//   none       → inset (empty)
//
// Clicking a cell surfaces that day's full checkpoint via onSelect.

import type { Checkpoint } from '@/lib/types';
import { todayLocalDate } from '@/lib/tend';

function isoDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayLocalDate(d);
}

function cellAccent(cp: Checkpoint | undefined): {
  fill: string;
  border: string;
  label: string;
} {
  if (!cp) return { fill: 'var(--surface-inset)', border: 'var(--border-subtle)', label: 'no data' };
  if (cp.skipped) return { fill: 'var(--border-subtle)', border: 'var(--border-default)', label: 'skipped' };
  const primary = Array.isArray(cp.pressure) ? cp.pressure[0] : cp.pressure;
  switch (primary) {
    case 'building':
    case 'chose':
      return { fill: 'var(--sage-fill)', border: 'var(--sage)', label: 'building' };
    case 'improving':
      return { fill: 'var(--mauve-fill)', border: 'var(--mauve)', label: 'improving' };
    case 'fixing':
    case 'reactive':
      return { fill: 'var(--tan-fill)', border: 'var(--tan)', label: 'fixing' };
    case 'supporting':
    case 'task_monkey':
      return { fill: 'var(--rose-fill)', border: 'var(--rose)', label: 'supporting' };
    default:
      return { fill: 'var(--surface-inset)', border: 'var(--border-default)', label: 'incomplete' };
  }
}

export function PressureHeatmap({
  checkpoints,
  selectedDate,
  onSelect,
}: {
  checkpoints: Record<string, Checkpoint>;
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const days: { date: string; cp: Checkpoint | undefined }[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = isoDateNDaysAgo(i);
    days.push({ date, cp: checkpoints[date] });
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: 'repeat(30, minmax(0, 1fr))' }}
      >
        {days.map(({ date, cp }) => {
          const { fill, border, label } = cellAccent(cp);
          const active = selectedDate === date;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelect(date)}
              title={`${date} · ${label}`}
              aria-label={`${date} ${label}`}
              className="aspect-square rounded-sm transition-all"
              style={{
                background: fill,
                border: `1px solid ${border}`,
                outline: active ? `2px solid var(--mauve)` : 'none',
                outlineOffset: active ? '1px' : undefined,
              }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-ink-ghost">
        <LegendDot color="var(--sage)" label="building" />
        <LegendDot color="var(--mauve)" label="improving" />
        <LegendDot color="var(--tan)" label="fixing" />
        <LegendDot color="var(--rose)" label="supporting" />
        <LegendDot color="var(--border-default)" label="skipped" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="w-[8px] h-[8px] rounded-sm"
        style={{ background: color, border: `1px solid ${color}` }}
        aria-hidden
      />
      <span>{label}</span>
    </span>
  );
}
