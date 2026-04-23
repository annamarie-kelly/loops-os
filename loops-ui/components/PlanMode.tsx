'use client';

// PlanMode: the week canvas is the hero, loops live in a left drawer.
// Drag from the drawer onto any day in the week to block time.
//
// The split between sidebar and canvas is resizable. Drag the handle at
// the sidebar's right edge to resize; width is clamped to [240, 520] and
// persisted in localStorage so each session reopens at your preferred
// ratio. Double-click the handle to reset to the default 340px.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarFile, Loop, SpecDoc } from '@/lib/types';
import { LoopDrawer } from './LoopDrawer';
import { WeekCanvas } from './WeekCanvas';

const LS_SIDEBAR_WIDTH = 'loops-ui:sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;

export function PlanMode({
  loops,
  specs,
  weekBlocks,
  committedMinutes,
  calendar,
  draggingLoop,
  draggingBlockIdx,
  selectedIds,
  focusedId,
  editingId,
  mode,
  sidebarCollapsed,
  onToggleCollapse,
  onToggleSelect,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onClearTimeblock,
  onOpenDetail,
  onCreate,
  onKill,
  onQuickSchedule,
}: {
  loops: Loop[];
  specs?: SpecDoc[];
  weekBlocks: Loop[];
  committedMinutes: number;
  calendar: CalendarFile | null;
  draggingLoop: Loop | null;
  draggingBlockIdx: number;
  selectedIds: Set<string>;
  focusedId: string | null;
  editingId: string | null;
  mode: string;
  sidebarCollapsed: boolean;
  onToggleCollapse: () => void;
  onToggleSelect: (id: string, shiftKey: boolean, cmdKey: boolean) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, patch: Partial<Loop>) => Promise<void>;
  onClearTimeblock: (id: string) => void;
  onOpenDetail: (id: string) => void;
  onCreate?: (draft: Omit<Loop, 'id'>) => Promise<void>;
  onKill?: (id: string) => void;
  onQuickSchedule?: (id: string) => void;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Hydrate width from localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_SIDEBAR_WIDTH);
      if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) {
          setSidebarWidth(clampWidth(n));
        }
      }
    } catch {}
  }, []);

  const persistWidth = useCallback((w: number) => {
    try {
      localStorage.setItem(LS_SIDEBAR_WIDTH, String(w));
    } catch {}
  }, []);

  // Pointer-driven resize. We bind to window so the drag keeps tracking
  // even if the cursor leaves the handle. Body gets a col-resize cursor
  // and user-select is disabled so text doesn't accidentally select.
  const onHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      dragStateRef.current = { startX, startWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      let currentWidth = startWidth;

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        currentWidth = clampWidth(startWidth + delta);
        setSidebarWidth(currentWidth);
      };
      const onUp = () => {
        dragStateRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        persistWidth(currentWidth);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [sidebarWidth, persistWidth],
  );

  const onHandleDoubleClick = useCallback(() => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    persistWidth(DEFAULT_SIDEBAR_WIDTH);
  }, [persistWidth]);

  const effectiveWidth = sidebarCollapsed ? 44 : sidebarWidth;

  return (
    <main
      className="flex-1 min-h-0 grid overflow-hidden"
      style={{
        gridTemplateColumns: `${effectiveWidth}px 1fr`,
        // Single full-height row that can shrink below its content.
        // Without this, grid-auto-rows defaults to 'auto' (fit content)
        // and h-full on the sidebar/canvas children never resolves,
        // so an overflowing LoopDrawer ends up uncontained instead of
        // becoming scrollable.
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      <div className="relative min-w-0 h-full">
        {sidebarCollapsed ? (
          <div className="h-full w-[44px] bg-page border-r border-edge flex flex-col items-center py-3 gap-2">
            <img
              src="/icon_v5_cream_on_mauve.png"
              alt="Tend"
              width={24}
              height={24}
              className="rounded-md mb-1"
            />
            <button
              onClick={onToggleCollapse}
              className="w-8 h-8 rounded-md hover:bg-inset text-ink-ghost hover:text-ink-soft flex items-center justify-center text-[14px]"
              title="Expand sidebar (])"
              aria-label="Expand sidebar"
            >
              ›
            </button>
          </div>
        ) : (
          <>
            <LoopDrawer
              loops={loops}
              specs={specs}
              selectedIds={selectedIds}
              focusedId={focusedId}
              editingId={editingId}
              onToggleSelect={onToggleSelect}
              onStartEdit={onStartEdit}
              onCancelEdit={onCancelEdit}
              onSaveEdit={onSaveEdit}
              onCreate={onCreate}
              onKill={onKill}
              onQuickSchedule={onQuickSchedule}
            />
            {/* Collapse button: tiny chevron in the top-right corner of
                the sidebar. Hovers into view so it doesn't compete with
                the list content. */}
            <button
              onClick={onToggleCollapse}
              className="absolute top-2 right-3 w-5 h-5 rounded-md hover:bg-inset text-ink-ghost hover:text-ink-soft flex items-center justify-center text-[12px] z-10"
              title="Collapse sidebar ([)"
              aria-label="Collapse sidebar"
            >
              ‹
            </button>
            {/* Resize handle: 6px hit target flush with the sidebar's right
                edge. A 1px visual line sits in the middle and thickens on
                hover so the affordance is discoverable without being noisy. */}
            <div
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              onPointerDown={onHandleDown}
              onDoubleClick={onHandleDoubleClick}
              className="group absolute top-0 bottom-0 -right-[3px] w-[6px] cursor-col-resize z-20"
              title="Drag to resize · double-click to reset"
            >
              <div className="absolute top-0 bottom-0 left-[2px] w-[1px] bg-[var(--border-default)] group-hover:w-[2px] group-hover:bg-[var(--slate)] transition-all" />
            </div>
          </>
        )}
      </div>
      <WeekCanvas
        loops={weekBlocks}
        calendar={calendar}
        committedMinutes={committedMinutes}
        draggingLoop={draggingLoop}
        draggingBlockIdx={draggingBlockIdx}
        onClearTimeblock={onClearTimeblock}
        onOpenDetail={onOpenDetail}
        onCreate={onCreate}
        selectedIds={selectedIds}
        mode={mode}
      />
    </main>
  );
}

function clampWidth(n: number): number {
  if (n < MIN_SIDEBAR_WIDTH) return MIN_SIDEBAR_WIDTH;
  if (n > MAX_SIDEBAR_WIDTH) return MAX_SIDEBAR_WIDTH;
  return n;
}
