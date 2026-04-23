'use client';

// PlanHub — the SDLC container. Shows a sub-nav bar with pipeline
// stages (Research → Design → Build → Ship) plus a Schedule tab for
// the week calendar. Lives under the top-level "Plan" mode.

import type { ReactNode } from 'react';
import type { Mode } from '@/lib/ui';

type PlanTab = 'research' | 'design' | 'ship' | 'plan';

const TABS: { id: PlanTab; label: string; dot: string }[] = [
  { id: 'research', label: 'Research', dot: 'bg-tan-fill' },
  { id: 'design', label: 'Design', dot: 'bg-[var(--ocean,#7A9AA0)]' },
  { id: 'ship', label: 'Ship', dot: 'bg-ink-ghost' },
  { id: 'plan', label: 'Schedule', dot: 'bg-[var(--mauve,#9A7A8B)]' },
];

export function PlanHub({
  activeTab,
  onSetTab,
  children,
}: {
  activeTab: Mode;
  onSetTab: (tab: Mode) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Sub-nav bar */}
      <div className="px-5 pt-2 pb-0 shrink-0 border-b border-edge-subtle">
        <div className="flex items-center gap-1">
          {TABS.map(({ id, label, dot }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSetTab(id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-t-md transition-colors border-b-2 ${
                activeTab === id
                  ? 'text-ink border-ink font-medium'
                  : 'text-ink-ghost hover:text-ink-soft border-transparent'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {children}
    </div>
  );
}
