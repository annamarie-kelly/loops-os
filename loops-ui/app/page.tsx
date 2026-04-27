'use client';

// Page shell: data fetching, selection model, keyboard shortcuts,
// DnD context, mode switching. Delegates rendering to PlanMode /
// TriageMode / DetailDrawer / Header.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type {
  CalendarFile,
  ContextFile,
  Loop,
  LoopsFile,
  ResearchDoc,
  SpecDoc,
  Tier,
  Timeblock,
} from '@/lib/types';
import { splitAroundConflicts } from '@/lib/schedule';
import { formatMinutes, migrateLoopsFile, todayISO, weekDates } from '@/lib/types';
import {
  DAY_END_MIN,
  DAY_START_MIN,
  DAY_TOTAL_MIN,
  LS_MODE,
  type Mode,
  SLOT_MIN,
  type SortBy,
  makeHashId,
  pBarColor,
} from '@/lib/ui';
import { Header } from '@/components/Header';
import { PlanMode } from '@/components/PlanMode';
import { TriageMode } from '@/components/TriageMode';
import { FocusMode } from '@/components/FocusMode';
import { DetailDrawer } from '@/components/DetailDrawer';
import { SearchOverlay } from '@/components/SearchOverlay';
import { BoundaryLogPanel } from '@/components/BoundaryLogPanel';
import { CapacityGateModal } from '@/components/CapacityGateModal';
import { CheckpointModal } from '@/components/CheckpointModal';
import { CheckpointSkipBanner } from '@/components/CheckpointSkipBanner';
import { ReflectionView } from '@/components/ReflectionView';
import { AdoptLoopDialog } from '@/components/AdoptLoopDialog';
import { TriageView } from '@/components/TriageView';
import { SomedayView } from '@/components/SomedayView';
import { ResearchShelf } from '@/components/ResearchShelf';
import { DesignBench } from '@/components/DesignBench';
import { DesignBoard } from '@/components/DesignBoard';
import { PlanHub } from '@/components/PlanHub';
import { TriageMigrationModal } from '@/components/TriageMigrationModal';
import { ClaudeChat } from '@/components/ClaudeChat';
import { VaultBrowser } from '@/components/VaultBrowser';
import { NoteReader } from '@/components/NoteReader';
import { CaptureBar } from '@/components/CaptureBar';
import { FirstLaunchRitual } from '@/components/FirstLaunchRitual';
import { loadDemoSeed } from '@/lib/demo-seed';
import { appendBoundaryLog } from '@/lib/tend';
import {
  checkCapacityGate,
  countActiveP1Stakeholder,
  countActiveP1Self,
} from '@/lib/tend-gates';
import { P1_STAKEHOLDER, P1_SELF } from '@/lib/config';
import { useVisiblePoll } from '@/hooks/useVisiblePoll';

export default function Page() {
  const [data, setData] = useState<LoopsFile | null>(null);
  const [calendar, setCalendar] = useState<CalendarFile | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingTier, setAddingTier] = useState<Tier | null>(null);
  const [mode, setMode] = useState<Mode>('focus');
  const [focusInitialPickId, setFocusInitialPickId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('default');
  const [filterPBuckets, setFilterPBuckets] = useState<Set<string>>(new Set());
  const [filterStakeholders, setFilterStakeholders] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [contextData, setContextData] = useState<ContextFile | null>(null);
  const [focusContext, setFocusContext] = useState<ContextFile | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // ─── Tend self-protection layer surfaces ─────────────────────────
  const [boundaryPanelOpen, setBoundaryPanelOpen] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [claudeChatOpen, setClaudeChatOpen] = useState(false);
  // ─── Vault browser (replaces Obsidian's left sidebar) ───────────
  const [vaultBrowserOpen, setVaultBrowserOpen] = useState(false);
  const [openNotePath, setOpenNotePath] = useState<string | null>(null);
  // Bumping this number after a save/create makes VaultBrowser refetch.
  const [vaultRefreshKey, setVaultRefreshKey] = useState(0);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [ritualDismissed, setRitualDismissed] = useState(false);
  const [capacityGate, setCapacityGate] = useState<{
    open: boolean;
    kind: 'P1:stakeholder' | 'P1:self' | 'P1-cap' | 'P2-cap';
    currentCount: number;
    max: number;
    // The pending loop draft — stashed while the user confirms the override.
    pending: Omit<Loop, 'id'> | null;
  }>({ open: false, kind: 'P1:stakeholder', currentCount: 0, max: 0, pending: null });
  const pendingPromotionIdRef = useRef<string | null>(null);

  // ─── Mission Control: Research Shelf ────────────────────────────
  const [researchDocs, setResearchDocs] = useState<ResearchDoc[]>([]);
  const researchFetcher = useCallback(
    async (signal: AbortSignal) => {
      const res = await fetch('/api/vault/research', {
        cache: 'no-cache',
        signal,
      });
      if (res.status === 304) return null;
      if (!res.ok) return null;
      const json = await res.json();
      return json.docs as ResearchDoc[];
    },
    [],
  );
  // Poll research docs every 30s (less frequent than loops since vault
  // files change slowly). Only poll when in research mode.
  const { data: polledResearch } = useVisiblePoll<ResearchDoc[]>(
    researchFetcher,
    30_000,
    mode === 'research',
  );
  useEffect(() => {
    if (polledResearch) setResearchDocs(polledResearch);
  }, [polledResearch]);

  // ─── Mission Control: Design Bench ──────────────────────────────
  const [specDocs, setSpecDocs] = useState<SpecDoc[]>([]);
  const specsFetcher = useCallback(
    async (signal: AbortSignal) => {
      const res = await fetch('/api/vault/specs', {
        cache: 'no-cache',
        signal,
      });
      if (res.status === 304) return null;
      if (!res.ok) return null;
      const json = await res.json();
      return json.specs as SpecDoc[];
    },
    [],
  );
  const specWriteInFlightRef = useRef(0);
  const { data: polledSpecs } = useVisiblePoll<SpecDoc[]>(
    specsFetcher,
    30_000,
    mode === 'design',
  );
  useEffect(() => {
    if (polledSpecs && specWriteInFlightRef.current === 0) setSpecDocs(polledSpecs);
  }, [polledSpecs]);

  const refetchSpecs = useCallback(async () => {
    const res = await fetch('/api/vault/specs', { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      setSpecDocs(json.specs as SpecDoc[]);
    }
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Track whether a PUT is currently in flight so the poll doesn't
  // overwrite a mid-save optimistic update. Incremented on PUT
  // start, decremented on completion.
  const inFlightPutsRef = useRef(0);

  // Visible-tab poll of /api/loops. Paused whenever the capacity
  // gate is open (mid-override flow) OR the search overlay / boundary
  // panel / adopt dialog is up OR a save is in flight. Matches the
  // spec: "auto-refresh should not blow away a user's mid-edit
  // state." The hook uses `cache: 'no-cache'` so the browser
  // revalidates the ETag on every poll and the server returns 304
  // for unchanged loops.json — cheap enough to run every 10 s.
  const isQuiet =
    !capacityGate.open && !searchOpen && !adoptOpen && !boundaryPanelOpen;
  const loopsFetcher = useCallback(
    async (signal: AbortSignal) => {
      if (inFlightPutsRef.current > 0) return null;
      const res = await fetch('/api/loops', {
        cache: 'no-cache',
        signal,
      });
      if (res.status === 304) return null;
      if (!res.ok) throw new Error(`loops fetch failed: ${res.status}`);
      const json = await res.json();
      return migrateLoopsFile(json);
    },
    [],
  );
  const { data: polledData, error: pollError } = useVisiblePoll<LoopsFile>(
    loopsFetcher,
    10_000,
    isQuiet,
  );

  // Apply polled data to local state. We drop polled updates while a
  // PUT is mid-flight so the round-trip never overwrites a freshly
  // saved optimistic mutation. When the poll returns, per-loop we
  // take whichever side has the more recent updatedAt.
  useEffect(() => {
    if (!polledData) return;
    if (inFlightPutsRef.current > 0) return;
    setData((prev) => {
      if (!prev) {
        setLoading(false);
        return polledData;
      }
      const polledById = new Map(polledData.loops.map((l) => [l.id, l]));
      const mergedLoops = prev.loops.map((local) => {
        const remote = polledById.get(local.id);
        if (!remote) return local;
        const localTs = local.updatedAt ?? '';
        const remoteTs = remote.updatedAt ?? '';
        return remoteTs > localTs ? remote : local;
      });
      // Pick up any loops the poll knows about that local doesn't
      // (e.g. created by the CLI since the last fetch).
      const localIds = new Set(prev.loops.map((l) => l.id));
      for (const remote of polledData.loops) {
        if (!localIds.has(remote.id)) mergedLoops.push(remote);
      }
      return { ...polledData, loops: mergedLoops };
    });
  }, [polledData]);

  useEffect(() => {
    if (pollError) setError(String(pollError));
  }, [pollError]);

  useEffect(() => {
    const week = weekDates(new Date());
    const start = week[0];
    const end = week[week.length - 1];
    fetch(`/api/calendar?start=${start}&end=${end}`)
      .then((r) => r.json())
      .then((c) => setCalendar(c))
      .catch(() => setCalendar({ date: null, events: [], available: false }));
  }, []);

  // Hydrate the first-launch onboarded flag — set on any of the
  // ritual's three exits (capture, demo, skip).
  useEffect(() => {
    try {
      if (localStorage.getItem('loops-ui:onboarded')) {
        setRitualDismissed(true);
      }
    } catch {}
  }, []);

  // Hydrate mode from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_MODE);
      if (
        raw === 'focus' ||
        raw === 'plan' ||
        raw === 'triage' ||
        raw === 'backlog' ||
        raw === 'someday' ||
        raw === 'reflect'
      )
        setMode(raw);
    } catch {}
  }, []);

  // Persist mode
  useEffect(() => {
    try {
      localStorage.setItem(LS_MODE, mode);
    } catch {}
  }, [mode]);

  // Fetch context when detail opens
  useEffect(() => {
    if (!detailId || !data) {
      setContextData(null);
      return;
    }
    const loop = data.loops.find((l) => l.id === detailId);
    if (!loop) {
      setContextData(null);
      return;
    }
    const params = new URLSearchParams({
      file: loop.source.file,
      line: String(loop.source.line),
    });
    fetch(`/api/context?${params}`)
      .then((r) => r.json())
      .then((c) => setContextData(c))
      .catch(() => setContextData(null));
  }, [detailId, data]);

  // Pick the focus loop at page level (same rules as FocusMode's own
  // picker) so we can fetch its source context in the background.
  // Recomputing on data change keeps the preview fresh after edits.
  const focusLoopId = useMemo(() => {
    if (mode !== 'focus' || !data) return null;
    const today = todayISO();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const live = data.loops.filter((l) => !l.done);

    for (const l of live) {
      for (const tb of l.timeblocks) {
        if (
          tb.date === today &&
          tb.startMinute <= nowMin &&
          tb.endMinute > nowMin
        ) {
          return l.id;
        }
      }
    }
    let bestId: string | null = null;
    let bestStart = Infinity;
    for (const l of live) {
      for (const tb of l.timeblocks) {
        if (tb.date === today && tb.startMinute >= nowMin && tb.startMinute < bestStart) {
          bestStart = tb.startMinute;
          bestId = l.id;
        }
      }
    }
    if (bestId) return bestId;
    const nowTierLoops = live.filter((l) => l.tier === 'now');
    if (nowTierLoops.length > 0) return nowTierLoops[0].id;
    const soonLoops = live.filter((l) => l.tier === 'soon');
    return soonLoops[0]?.id ?? null;
  }, [mode, data]);

  useEffect(() => {
    if (!focusLoopId || !data) {
      setFocusContext(null);
      return;
    }
    const loop = data.loops.find((l) => l.id === focusLoopId);
    if (!loop) {
      setFocusContext(null);
      return;
    }
    const params = new URLSearchParams({
      file: loop.source.file,
      line: String(loop.source.line),
    });
    fetch(`/api/context?${params}`)
      .then((r) => r.json())
      .then((c) => setFocusContext(c))
      .catch(() => setFocusContext(null));
  }, [focusLoopId, data]);

  const refetch = useCallback(async () => {
    const fresh = await fetch('/api/loops').then((r) => r.json());
    setData(migrateLoopsFile(fresh));
  }, []);

  const saveData = useCallback(async (next: LoopsFile) => {
    setData(next);
    inFlightPutsRef.current += 1;
    try {
      const res = await fetch('/api/loops', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) setError('Failed to save');
    } finally {
      inFlightPutsRef.current = Math.max(0, inFlightPutsRef.current - 1);
    }
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Loops that are surfaced to the planning UI. Done loops are
  // excluded from every surface except the week canvas (where they
  // show as dimmed record blocks). Loops in status `triage` or
  // `someday` are excluded from planning surfaces too — they only
  // appear in their dedicated views.
  // Exception: a triage loop that already has a placed timeblock leaks
  // through. Scheduling is a stronger intent signal than the triage
  // gate enforces, and the next mutation will auto-promote it via
  // `promoteIfScheduled` below. Without this exception a user can
  // schedule a fresh loop and have it silently vanish from Plan/Focus.
  const activeLoops = useMemo(() => {
    if (!data) return [] as Loop[];
    return data.loops.filter((l) => {
      if (l.done) return false;
      if (l.status === 'someday') return false;
      if (l.status === 'triage' && (l.timeblocks?.length ?? 0) === 0) return false;
      return true;
    });
  }, [data]);

  const visibleIdsOrdered = useMemo(() => {
    const order: Tier[] = ['now', 'soon', 'someday'];
    return order.flatMap((t) =>
      activeLoops.filter((l) => l.tier === t).map((l) => l.id)
    );
  }, [activeLoops]);

  const toggleSelect = useCallback(
    (id: string, shiftKey: boolean, cmdKey: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (shiftKey && lastSelectedId && visibleIdsOrdered.includes(lastSelectedId)) {
          const lastIdx = visibleIdsOrdered.indexOf(lastSelectedId);
          const curIdx = visibleIdsOrdered.indexOf(id);
          const [lo, hi] = [Math.min(lastIdx, curIdx), Math.max(lastIdx, curIdx)];
          for (let i = lo; i <= hi; i++) next.add(visibleIdsOrdered[i]);
          setDetailId(null);
        } else if (cmdKey) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
          if (next.size > 1) setDetailId(null);
        } else {
          next.clear();
          next.add(id);
          // Plain click always opens the detail drawer for this loop.
          // Re-clicking the same card does NOT close it — that was confusing
          // because the row looked selected but the drawer disappeared.
          // Close happens via Esc or the drawer's × button.
          setDetailId(id);
        }
        return next;
      });
      setLastSelectedId(id);
    },
    [lastSelectedId, visibleIdsOrdered]
  );

  const moveSelectedToTier = useCallback(
    async (tier: Tier) => {
      if (!data || selectedIds.size === 0) return;
      const next = {
        ...data,
        loops: data.loops.map((l) => (selectedIds.has(l.id) ? { ...l, tier } : l)),
      };
      await saveData(next);
      clearSelection();
    },
    [data, selectedIds, saveData, clearSelection]
  );

  // Kill = low-friction release (soft-drop a single loop on × click).
  // No confirm, no bulk: this is the "let it go" gesture. Uses the
  // dedicated 'drop' action so the closure disposition ends up as
  // `closedAs: 'dropped'` in loops.json — distinguishing pruning from
  // completion in the streak counter.
  const killLoop = useCallback(
    async (id: string) => {
      const res = await fetch('/api/loops/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'drop', ids: [id] }),
      });
      if (res.ok) await refetch();
    },
    [refetch],
  );

  const closeLoopById = useCallback(
    async (id: string) => {
      const res = await fetch('/api/loops/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close', ids: [id] }),
      });
      if (res.ok) await refetch();
    },
    [refetch],
  );

  const actOnSelected = useCallback(
    async (action: 'close' | 'delete') => {
      if (!data || selectedIds.size === 0) return;
      // Done loops are a visualization-only artifact: exclude them from
      // any bulk action target so we don't double-close or re-delete.
      const doneSet = new Set(data.loops.filter((l) => l.done).map((l) => l.id));
      const targetIds = [...selectedIds].filter((id) => !doneSet.has(id));
      if (targetIds.length === 0) return;
      if (action === 'delete') {
        if (!confirm(`Delete ${targetIds.length} task(s) from source files?`)) return;
      }
      const res = await fetch('/api/loops/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids: targetIds }),
      });
      if (res.ok) {
        await refetch();
        clearSelection();
      } else {
        setError(`Failed to ${action}`);
      }
    },
    [data, selectedIds, refetch, clearSelection]
  );

  // Scheduling a triage loop is a stronger intent signal than the
  // triage gate exists to enforce, so any time a loop ends up with at
  // least one timeblock we auto-promote it out of triage. The fields
  // mirror what TriageView sets on accept: status='active' and a
  // decision record so the audit trail reflects *how* the promotion
  // happened. Leaves non-triage loops alone.
  const promoteIfScheduled = useCallback(
    (l: Loop, nextBlocks: Timeblock[]): Loop => {
      if (l.status !== 'triage') return l;
      if (nextBlocks.length === 0) return l;
      return {
        ...l,
        status: 'active',
        triage_decision: {
          disposition: 'accept',
          matched_ai: false,
          decided_at: new Date().toISOString(),
        },
      };
    },
    [],
  );

  const setLoopTimeblocks = useCallback(
    async (id: string, timeblocks: Timeblock[]) => {
      if (!data) return;
      const next = {
        ...data,
        loops: data.loops.map((l) =>
          l.id === id ? promoteIfScheduled({ ...l, timeblocks }, timeblocks) : l,
        ),
      };
      await saveData(next);
    },
    [data, saveData, promoteIfScheduled]
  );

  // Manual split: cut the block at `idx` in half at its midpoint (rounded
  // to SLOT_MIN) and replace it with two half-sized blocks at the same
  // position. The user can then drag either half elsewhere. No auto-gap.
  const splitBlockAt = useCallback(
    async (id: string, idx: number) => {
      if (!data) return;
      const loop = data.loops.find((l) => l.id === id);
      if (!loop) return;
      const tb = loop.timeblocks[idx];
      if (!tb) return;
      const total = tb.endMinute - tb.startMinute;
      if (total < SLOT_MIN * 2) return; // too small to split meaningfully
      const rawMid = tb.startMinute + total / 2;
      const mid = Math.round(rawMid / SLOT_MIN) * SLOT_MIN;
      if (mid <= tb.startMinute || mid >= tb.endMinute) return;
      const first: Timeblock = { date: tb.date, startMinute: tb.startMinute, endMinute: mid };
      const second: Timeblock = { date: tb.date, startMinute: mid, endMinute: tb.endMinute };
      const nextBlocks = [...loop.timeblocks];
      nextBlocks.splice(idx, 1, first, second);
      await setLoopTimeblocks(id, nextBlocks);
    },
    [data, setLoopTimeblocks]
  );

  // Remove a single placed block without affecting siblings.
  const removeBlockAt = useCallback(
    async (id: string, idx: number) => {
      if (!data) return;
      const loop = data.loops.find((l) => l.id === id);
      if (!loop) return;
      const nextBlocks = loop.timeblocks.filter((_, i) => i !== idx);
      await setLoopTimeblocks(id, nextBlocks);
    },
    [data, setLoopTimeblocks]
  );

  // Update a single timeblock at `idx` within a loop's timeblocks array.
  // Used when dragging a specific placed block (drag id = `${loopId}:${idx}`).
  // If the resulting total scheduled time exceeds the loop's estimate,
  // bump the estimate to match so a deliberate resize doesn't get
  // flagged as "over-allocated". Estimate never shrinks automatically —
  // user has to lower it manually from the detail drawer.
  const updateLoopTimeblockAt = useCallback(
    async (id: string, idx: number, tb: Timeblock) => {
      if (!data) return;
      const next = {
        ...data,
        loops: data.loops.map((l) => {
          if (l.id !== id) return l;
          const copy = [...l.timeblocks];
          copy[idx] = tb;
          const scheduled = copy.reduce(
            (sum, b) => sum + (b.endMinute - b.startMinute),
            0,
          );
          const est = l.timeEstimateMinutes;
          const nextEst = est == null || scheduled > est ? scheduled : est;
          const patched: Loop = {
            ...l,
            timeblocks: copy,
            timeEstimateMinutes: nextEst,
          };
          return promoteIfScheduled(patched, copy);
        }),
      };
      await saveData(next);
    },
    [data, saveData, promoteIfScheduled]
  );

  const updateLoop = useCallback(
    async (id: string, patch: Partial<Loop>) => {
      if (!data) return;
      // Capacity gate intercept: promoting a loop INTO P1:<stakeholder>
      // or P1:self that would exceed the ceiling stashes the patch and
      // opens the gate. Gate policy lives in lib/tend-gates.ts so
      // the same threshold checks run here, in TriageView, and in
      // the shared applyEvent pipeline.
      if (patch.pLevel === P1_STAKEHOLDER || patch.pLevel === P1_SELF) {
        const existing = data.loops.find((l) => l.id === id);
        // Only gate when this is a genuine promotion — not a no-op.
        if (existing && existing.pLevel !== patch.pLevel) {
          const gate = checkCapacityGate(data, { pLevel: patch.pLevel });
          if (!gate.ok) {
            const ctx = (gate.context ?? {}) as {
              current?: number;
              max?: number;
            };
            setCapacityGate({
              open: true,
              kind: patch.pLevel === P1_STAKEHOLDER ? 'P1:stakeholder' : 'P1:self',
              currentCount: ctx.current ?? 0,
              max: ctx.max ?? 0,
              pending: { ...existing, ...patch } as Omit<Loop, 'id'>,
            });
            // The gate "proceed" path falls back to a plain saveData
            // update rather than commitCreate so the id is preserved.
            pendingPromotionIdRef.current = id;
            return;
          }
        }
      }
      const next = {
        ...data,
        loops: data.loops.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      };
      await saveData(next);
    },
    [data, saveData]
  );

  // Internal: actually commit a new loop to loops.json. Used by
  // createLoop (after the capacity gate) and by the gate's "proceed"
  // handler.
  const commitCreate = useCallback(
    async (draft: Omit<Loop, 'id'>) => {
      if (!data) return;
      const id = await makeHashId(draft.source.file, draft.text);
      // Triage Gate default: new loops land in `triage` status so
      // they sit out of Focus/Plan/Backlog/Reflect until accepted.
      // P0 bypasses triage (deliberate — P0 is "drop everything").
      const defaultStatus: Loop['status'] =
        draft.priority === 'P0' || draft.pLevel === 'P0'
          ? 'active'
          : 'triage';
      const loop: Loop = {
        ...draft,
        id,
        status: draft.status ?? defaultStatus,
      };
      const next = { ...data, loops: [...data.loops, loop] };
      await saveData(next);
    },
    [data, saveData]
  );

  const createLoop = useCallback(
    async (draft: Omit<Loop, 'id'>) => {
      if (!data) return;
      // Capacity gate via the shared policy module. Only
      // P1:<stakeholder> / P1:self creates fire; the pure lib function
      // does the count.
      const p = draft.pLevel;
      if (p === P1_STAKEHOLDER || p === P1_SELF) {
        const gate = checkCapacityGate(data, { pLevel: p });
        if (!gate.ok) {
          const ctx = (gate.context ?? {}) as {
            current?: number;
            max?: number;
          };
          setCapacityGate({
            open: true,
            kind: p === P1_STAKEHOLDER ? 'P1:stakeholder' : 'P1:self',
            currentCount: ctx.current ?? 0,
            max: ctx.max ?? 0,
            pending: draft,
          });
          return;
        }
      }
      await commitCreate(draft);
    },
    [data, commitCreate]
  );

  const addToNextOpenSlot = useCallback(
    (loopId: string) => {
      if (!data) return;
      const loop = data.loops.find((l) => l.id === loopId);
      if (!loop) return;
      const duration = loop.timeEstimateMinutes ?? 30;

      const today = todayISO();
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const searchStart = Math.max(
        DAY_START_MIN,
        Math.ceil(nowMin / SLOT_MIN) * SLOT_MIN,
      );
      const blocks = splitAroundConflicts(
        today,
        searchStart,
        duration,
        calendar?.events,
        data.loops,
        loopId,
      );
      setLoopTimeblocks(loopId, blocks);
    },
    [data, calendar, setLoopTimeblocks],
  );

  // Schedule just the unblocked remainder — used by the "open Xm"
  // chip in the detail drawer. Unlike addToNextOpenSlot, this APPENDS
  // new blocks to the existing timeblocks instead of replacing them
  // so already-scheduled time isn't clobbered.
  const scheduleRemainder = useCallback(
    (loopId: string) => {
      if (!data) return;
      const loop = data.loops.find((l) => l.id === loopId);
      if (!loop) return;
      const estimate = loop.timeEstimateMinutes ?? 0;
      const alreadyBlocked = loop.timeblocks.reduce(
        (sum, tb) => sum + (tb.endMinute - tb.startMinute),
        0,
      );
      const remainder = Math.max(0, estimate - alreadyBlocked);
      if (remainder <= 0) return;

      const today = todayISO();
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const searchStart = Math.max(
        DAY_START_MIN,
        Math.ceil(nowMin / SLOT_MIN) * SLOT_MIN,
      );
      const newBlocks = splitAroundConflicts(
        today,
        searchStart,
        remainder,
        calendar?.events,
        data.loops,
        loopId,
      );
      if (newBlocks.length === 0) return;
      setLoopTimeblocks(loopId, [...loop.timeblocks, ...newBlocks]);
    },
    [data, calendar, setLoopTimeblocks],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingId(null);
      const { active, over } = event;
      if (!over || !data) return;
      const overId = String(over.id);
      const activeId = String(active.id);
      // Composite drag ids: `${loopId}:${idx}` when dragging a specific
      // placed block. Bare loopId when dragging from the list.
      const colonIdx = activeId.indexOf(':');
      const loopId = colonIdx >= 0 ? activeId.slice(0, colonIdx) : activeId;
      const blockIdx = colonIdx >= 0 ? parseInt(activeId.slice(colonIdx + 1), 10) : -1;
      const loop = data.loops.find((l) => l.id === loopId);
      if (!loop) return;

      if (overId.startsWith('slot-')) {
        // id shape: slot-YYYY-MM-DD-{minutes}
        const rest = overId.slice(5);
        const lastDash = rest.lastIndexOf('-');
        if (lastDash < 0) return;
        const date = rest.slice(0, lastDash);
        const startMinute = parseInt(rest.slice(lastDash + 1), 10);
        if (Number.isNaN(startMinute)) return;

        if (blockIdx >= 0) {
          // Moving a single placed block: preserve its original duration.
          const existing = loop.timeblocks[blockIdx];
          if (!existing) return;
          const duration = existing.endMinute - existing.startMinute;
          const endMinute = Math.min(startMinute + duration, DAY_END_MIN);
          updateLoopTimeblockAt(loopId, blockIdx, { date, startMinute, endMinute });
          return;
        }

        // Dragging a whole loop from the list: auto-split around conflicts.
        const duration = loop.timeEstimateMinutes ?? 30;
        const blocks = splitAroundConflicts(
          date,
          startMinute,
          duration,
          calendar?.events,
          data.loops,
          loopId,
        );
        setLoopTimeblocks(loopId, blocks);
        return;
      }

      if (overId.startsWith('column-')) {
        const tier = overId.slice(7) as Tier;
        if (loop.tier === tier) return;
        const next = {
          ...data,
          loops: data.loops.map((l) => (l.id === loopId ? { ...l, tier } : l)),
        };
        saveData(next);
        return;
      }

      // Triage view groups. Each grouping dimension has its own drop
      // semantic: Mode sets workMode + pins manual. Subgroup rewrites
      // loop.subGroup. Person rewrites the stakeholder half of pLevel
      // while preserving the bare level. Size is derived from estimate
      // so drops are no-ops.
      if (overId.startsWith('group-mode-')) {
        const mode = overId.slice('group-mode-'.length);
        if (loop.workMode === mode && loop.workModeSource === 'manual') return;
        const next = {
          ...data,
          loops: data.loops.map((l) =>
            l.id === loopId
              ? {
                  ...l,
                  workMode: mode as Loop['workMode'],
                  workModeSource: 'manual' as const,
                }
              : l,
          ),
        };
        saveData(next);
        return;
      }

      if (overId.startsWith('group-sub-')) {
        const sub = overId.slice('group-sub-'.length);
        // "Other" is a virtual bucket (catch-all for singletons); dropping
        // onto it shouldn't rename anything.
        if (sub === 'Other') return;
        if (loop.subGroup === sub) return;
        const next = {
          ...data,
          loops: data.loops.map((l) =>
            l.id === loopId ? { ...l, subGroup: sub } : l,
          ),
        };
        saveData(next);
        return;
      }

      if (overId.startsWith('group-person-')) {
        const person = overId.slice('group-person-'.length);
        // Preserve the bare level (P0/P1/P2/P3/P4). If dropping onto
        // "Nobody" drop the stakeholder suffix. Default level is P2.
        const cur = loop.pLevel ?? '';
        const colon = cur.indexOf(':');
        const level = colon >= 0 ? cur.slice(0, colon) : cur || 'P2';
        const nextLevel = person === 'Nobody' ? level : `${level}:${person}`;
        if (nextLevel === cur) return;
        const next = {
          ...data,
          loops: data.loops.map((l) =>
            l.id === loopId ? { ...l, pLevel: nextLevel } : l,
          ),
        };
        saveData(next);
        return;
      }

      // group-size-* drops are no-ops — size is derived from the
      // time estimate field, not an assignable column.
    },
    [data, calendar, setLoopTimeblocks, updateLoopTimeblockAt, saveData]
  );

  // Keyboard shortcuts (same set as before)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // ⌘K / Ctrl+K opens the global search overlay from anywhere, even
      // while a field is focused — search is a navigation gesture, not
      // an edit.
      // ⌘⇧B opens the boundary log panel.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setBoundaryPanelOpen((v) => !v);
        return;
      }
      // ⌘⇧A opens the Adopt a loop dialog.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setAdoptOpen(true);
        return;
      }
      // ⌘⇧C opens the Claude chat panel.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        setClaudeChatOpen((v) => !v);
        return;
      }
      // ⌘\ toggles the vault browser.
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setVaultBrowserOpen((v) => !v);
        return;
      }
      // `c` (no modifiers) opens the capture bar — the "always on"
      // way to drop a thought into the triage inbox without leaving
      // the current view.
      if (!inEditable && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        setCaptureOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }

      if (inEditable) return;

      // Sidebar collapse (plan mode only, but harmless otherwise).
      if (e.key === '[') {
        e.preventDefault();
        setSidebarCollapsed(true);
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        setSidebarCollapsed(false);
        return;
      }

      if (!data || visibleIdsOrdered.length === 0) return;

      const currentIdx = focusedId ? visibleIdsOrdered.indexOf(focusedId) : -1;

      switch (e.key) {
        case 'j': {
          e.preventDefault();
          const nextIdx = Math.min(visibleIdsOrdered.length - 1, currentIdx + 1);
          setFocusedId(visibleIdsOrdered[nextIdx] ?? visibleIdsOrdered[0]);
          break;
        }
        case 'k': {
          e.preventDefault();
          const prevIdx = Math.max(0, currentIdx - 1);
          setFocusedId(visibleIdsOrdered[prevIdx] ?? visibleIdsOrdered[0]);
          break;
        }
        case 'x': {
          e.preventDefault();
          if (!focusedId) return;
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(focusedId)) next.delete(focusedId);
            else next.add(focusedId);
            return next;
          });
          setLastSelectedId(focusedId);
          break;
        }
        case ' ': {
          e.preventDefault();
          // No-op on already-done loops. Space should only close live work.
          const focusedLoop = focusedId
            ? data.loops.find((l) => l.id === focusedId)
            : null;
          if (selectedIds.size > 0) {
            actOnSelected('close');
          } else if (focusedId && focusedLoop && !focusedLoop.done) {
            (async () => {
              await fetch('/api/loops/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'close', ids: [focusedId] }),
              });
              await refetch();
            })();
          }
          break;
        }
        case '1':
        case '2':
        case '3': {
          // Tier is now derived (lib/api/loops/route.ts deriveTierForAll)
          // so 1/2/3 map to the underlying signals that drive derivation:
          //   1 → pinned_to_week = true (force into Now)
          //   2 → clear the pin (fall back to priority-based)
          //   3 → clear the pin (same as 2 for focused single loop)
          // For bulk selection, the old moveSelectedToTier contract still
          // holds via the tier value — useful during triage bulk moves.
          e.preventDefault();
          const tier: Tier = e.key === '1' ? 'now' : e.key === '2' ? 'soon' : 'someday';
          if (selectedIds.size > 0) {
            moveSelectedToTier(tier);
          } else if (focusedId && data) {
            const pinned = e.key === '1';
            saveData({
              ...data,
              loops: data.loops.map((l) =>
                l.id === focusedId ? { ...l, pinned_to_week: pinned } : l,
              ),
            });
          }
          break;
        }
        case 'w':
        case 'W': {
          // Toggle the week pin on the focused loop. When pinned, the
          // loop derives to tier='now' regardless of schedule/priority.
          e.preventDefault();
          if (focusedId && data) {
            const focusedLoop = data.loops.find((l) => l.id === focusedId);
            if (!focusedLoop) break;
            saveData({
              ...data,
              loops: data.loops.map((l) =>
                l.id === focusedId
                  ? { ...l, pinned_to_week: !l.pinned_to_week }
                  : l,
              ),
            });
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          if (claudeChatOpen) { setClaudeChatOpen(false); }
          else if (detailId) setDetailId(null);
          else clearSelection();
          break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    data,
    visibleIdsOrdered,
    focusedId,
    selectedIds,
    actOnSelected,
    refetch,
    moveSelectedToTier,
    saveData,
    clearSelection,
    detailId,
  ]);

  const weekBlocks = useMemo(() => {
    if (!data) return [] as Loop[];
    const week = new Set(weekDates(new Date()));
    return data.loops.filter((l) => (l.timeblocks ?? []).some((tb) => week.has(tb.date)));
  }, [data]);

  // Committed minutes is still today-only. The rest of the week is shown
  // on the canvas but does not count against today's capacity. Includes
  // done loops' timeblocks so the bar reflects real committed time.
  const committedMinutes = useMemo(() => {
    if (!data) return 0;
    const today = todayISO();
    return data.loops.reduce((sum, l) => {
      for (const tb of l.timeblocks) {
        if (tb.date === today) sum += tb.endMinute - tb.startMinute;
      }
      return sum;
    }, 0);
  }, [data]);

  // The drag id is either a bare loopId or `${loopId}:${idx}`. Split it so
  // we know both the loop being dragged and (for re-drags of an already
  // placed block) which specific block. The block index drives the
  // ghost-preview duration in WeekCanvas.
  const { draggingLoop, draggingBlockIdx } = useMemo(() => {
    if (!draggingId || !data) return { draggingLoop: null as Loop | null, draggingBlockIdx: -1 };
    const colonIdx = draggingId.indexOf(':');
    const loopId = colonIdx >= 0 ? draggingId.slice(0, colonIdx) : draggingId;
    const idx =
      colonIdx >= 0 ? parseInt(draggingId.slice(colonIdx + 1), 10) : -1;
    const loop = data.loops.find((l) => l.id === loopId) ?? null;
    return { draggingLoop: loop, draggingBlockIdx: Number.isNaN(idx) ? -1 : idx };
  }, [draggingId, data]);

  if (loading) {
    return (
      <div className="h-screen bg-page text-ink-faint flex items-center justify-center">
        Loading loops…
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-screen bg-page text-rose-text flex items-center justify-center">
        Error: {error}
      </div>
    );
  }
  if (!data) return null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div
        className={`h-screen max-h-screen bg-page text-ink flex flex-col overflow-hidden transition-[padding] duration-200 ${
          detailId && !claudeChatOpen ? 'min-[1400px]:pr-[420px]' : ''
        } ${
          claudeChatOpen ? 'pr-[440px]' : ''
        }`}
      >
        <Header
          mode={mode}
          onSetMode={setMode}
          totalCount={activeLoops.length}
          lastScanned={data.lastScanned}
          committedMinutes={committedMinutes}
          availableMinutes={DAY_TOTAL_MIN}
          selectedCount={selectedIds.size}
          onClearSelection={clearSelection}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenBoundaryLog={() => setBoundaryPanelOpen(true)}
          onOpenVaultBrowser={() => setVaultBrowserOpen(true)}
          sortBy={sortBy}
          onSetSortBy={setSortBy}
          filterPBuckets={filterPBuckets}
          onTogglePBucket={(p) => {
            setFilterPBuckets((prev) => {
              const next = new Set(prev);
              if (next.has(p)) next.delete(p);
              else next.add(p);
              return next;
            });
          }}
          onClearPBuckets={() => setFilterPBuckets(new Set())}
          filterStakeholders={filterStakeholders}
          onToggleStakeholder={(s) => {
            setFilterStakeholders((prev) => {
              const next = new Set(prev);
              if (next.has(s)) next.delete(s);
              else next.add(s);
              return next;
            });
          }}
          onClearStakeholders={() => setFilterStakeholders(new Set())}
          triageBadgeCount={
            data
              ? data.loops.filter((l) => !l.done && l.status === 'triage').length
              : 0
          }
        />

        {mode === 'focus' ? (
          <FocusMode
            loops={activeLoops}
            allLoops={data.loops}
            calendar={calendar}
            context={focusContext}
            onOpenDetail={(id) => setDetailId(id)}
            onUpdateLoop={updateLoop}
            onAddToNextOpenSlot={addToNextOpenSlot}
            onScheduleRemainder={scheduleRemainder}
            onCloseLoop={async (id) => {
              await fetch('/api/loops/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'close', ids: [id] }),
              });
              await refetch();
            }}
            onDropLoop={killLoop}
            onSplitBlock={splitBlockAt}
            onRemoveBlock={removeBlockAt}
            initialPickId={focusInitialPickId}
            onClearInitialPick={() => setFocusInitialPickId(null)}
            onPlanViaChat={(title) => {
              setClaudeChatOpen(true);
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('claude-chat:send', { detail: { prompt: `/plan ${title}` } }));
              }, 200);
            }}
            onSpecViaChat={(fp) => {
              setClaudeChatOpen(true);
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('claude-chat:send', { detail: { prompt: `/spec ${fp}` } }));
              }, 200);
            }}
            onDecomposeViaChat={(fp) => {
              setClaudeChatOpen(true);
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('claude-chat:send', { detail: { prompt: `/decompose ${fp}` } }));
              }, 200);
            }}
            onHandoffViaChat={(fp) => {
              setClaudeChatOpen(true);
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('claude-chat:send', { detail: { prompt: `/handoff ${fp}` } }));
              }, 200);
            }}
          />
        ) : mode === 'plan' || mode === 'research' || mode === 'design' || mode === 'ship' ? (
          <PlanHub activeTab={mode} onSetTab={setMode}>
            {mode === 'plan' ? (
              <PlanMode
                loops={activeLoops}
                specs={specDocs}
                weekBlocks={weekBlocks}
                mode={mode}
                committedMinutes={committedMinutes}
                calendar={calendar}
                draggingLoop={draggingLoop}
                draggingBlockIdx={draggingBlockIdx}
                selectedIds={selectedIds}
                focusedId={focusedId}
                editingId={editingId}
                sidebarCollapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
                onToggleSelect={toggleSelect}
                onStartEdit={setEditingId}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={async (id, patch) => {
                  await updateLoop(id, patch);
                  setEditingId(null);
                }}
                onClearTimeblock={(id) => setLoopTimeblocks(id, [])}
                onOpenDetail={(id) => setDetailId(id)}
                onCreate={createLoop}
                onKill={killLoop}
                onQuickSchedule={addToNextOpenSlot}
              />
            ) : mode === 'research' ? (
              <ResearchShelf
                docs={researchDocs}
                onSwitchToDesign={() => setMode('design')}
                onArtifactViaChat={(doc) => {
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('claude-chat:send', {
                        detail: {
                          prompt: `/artifact ${doc.filePath}`,
                        },
                      }),
                    );
                  }, 200);
                }}
                onFocusViaChat={(doc) => {
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('claude-chat:send', {
                        detail: {
                          prompt: `/focus ${doc.title}`,
                        },
                      }),
                    );
                  }, 200);
                }}
              />
            ) : mode === 'design' ? (
              <DesignBench
                specs={specDocs}
                onRefetch={refetchSpecs}
                onUpdateSpecStatus={(specId, newStatus) => {
                  setSpecDocs((prev) =>
                    prev.map((s) => (s.id === specId ? { ...s, status: newStatus as any } : s)),
                  );
                  specWriteInFlightRef.current += 1;
                }}
                onWriteComplete={() => {
                  specWriteInFlightRef.current = Math.max(0, specWriteInFlightRef.current - 1);
                }}
                onDecomposeViaChat={(spec) => {
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('claude-chat:send', {
                        detail: {
                          prompt: `/decompose ${spec.filePath}`,
                        },
                      }),
                    );
                  }, 200);
                }}
                onSpecViaChat={(spec) => {
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('claude-chat:send', {
                        detail: {
                          prompt: `/spec ${spec.filePath}`,
                        },
                      }),
                    );
                  }, 200);
                }}
                onHandoffViaChat={(spec) => {
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('claude-chat:send', {
                        detail: {
                          prompt: `/handoff ${spec.filePath}`,
                        },
                      }),
                    );
                  }, 200);
                }}
                onPlanViaChat={(spec) => {
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('claude-chat:send', {
                        detail: {
                          prompt: `/plan ${spec.title}`,
                        },
                      }),
                    );
                  }, 200);
                }}
                onFocusSpec={async (spec) => {
                  if (!data) { setMode('focus'); return; }
                  const specName = spec.filePath.replace(/\.md$/, '');
                  const linked = data.loops.find(
                    (l) =>
                      !l.done &&
                      ((l.source?.file?.includes(spec.filePath) ?? false) ||
                       (l.text?.includes(specName) ?? false)),
                  );
                  if (linked) {
                    addToNextOpenSlot(linked.id);
                    setFocusInitialPickId(linked.id);
                  } else {
                    // Create an ad-hoc loop from the spec title and schedule it
                    const title = spec.title.replace(/\s*—\s*Agent Spec$/, '');
                    await commitCreate({
                      text: title,
                      tier: 'now',
                      pLevel: null,
                      difficulty: null,
                      subGroup: null,
                      domain: 'project',
                      status: 'active',
                      timeEstimateMinutes: 60,
                      timeblocks: [],
                      notes: [],
                      source: { file: spec.filePath, line: 0 },
                    } as Omit<Loop, 'id'>);
                    await refetch();
                    // The picker will auto-find the new loop
                  }
                  setMode('focus');
                }}
              />
            ) : (
              <DesignBoard
                onFix={(imgPath, annotations, captions) => {
                  const annList = annotations
                    .filter((a) => a.comment)
                    .map((a) => `${a.index}. ${a.comment}`)
                    .join('\n');
                  const capList = (captions || [])
                    .map((c, i) => `${i + 1}. ${c}`)
                    .join('\n');
                  const prompt = `/annotation-intake ${imgPath}\n\n${capList ? `Captions:\n${capList}\n\n` : ''}Annotations:\n${annList || '(no comments — review the image)'}`;
                  setClaudeChatOpen(true);
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('claude-chat:send', { detail: { prompt } }));
                  }, 300);
                }}
              />
            )}
          </PlanHub>
        ) : mode === 'reflect' ? (
          <ReflectionView
            loops={activeLoops}
            allLoops={data.loops}
            onOpenDetail={(id) => setDetailId(id)}
          />
        ) : mode === 'triage' ? (
          <TriageView
            loops={data.loops}
            onRefetch={refetch}
            onOpenDetail={(id) => setDetailId(id)}
            onUpdateLoop={updateLoop}
            onSwitchToBacklog={() => setMode('backlog')}
          />
        ) : mode === 'someday' ? (
          <SomedayView
            loops={data.loops}
            onUpdateLoop={updateLoop}
            onOpenDetail={(id) => setDetailId(id)}
          />
        ) : (
          <TriageMode
            loops={activeLoops}
            selectedIds={selectedIds}
            focusedId={focusedId}
            editingId={editingId}
            addingTier={addingTier}
            sortBy={sortBy}
            filterPBuckets={filterPBuckets}
            onToggleSelect={toggleSelect}
            onStartEdit={setEditingId}
            onCancelEdit={() => setEditingId(null)}
            onSaveEdit={async (id, patch) => {
              await updateLoop(id, patch);
              setEditingId(null);
            }}
            onStartAdd={(t) => setAddingTier(t)}
            onCancelAdd={() => setAddingTier(null)}
            onSaveAdd={async (draft) => {
              await createLoop(draft);
              setAddingTier(null);
            }}
            onKill={killLoop}
            onCloseLoop={closeLoopById}
            onQuickSchedule={addToNextOpenSlot}
          />
        )}

        {detailId && (
          <DetailDrawer
            loop={data.loops.find((l) => l.id === detailId) ?? null}
            context={contextData}
            allLoops={activeLoops}
            onSplitBlock={splitBlockAt}
            onRemoveBlock={removeBlockAt}
            onClose={() => setDetailId(null)}
            onUpdateLoop={updateLoop}
            onAddToNextOpenSlot={addToNextOpenSlot}
            onScheduleRemainder={scheduleRemainder}
            onCloseLoop={async (id) => {
              await fetch('/api/loops/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'close', ids: [id] }),
              });
              await refetch();
              setDetailId(null);
            }}
            onDropLoop={async (id) => {
              await killLoop(id);
              setDetailId(null);
            }}
            onOpenDetail={(id) => setDetailId(id)}
            onSwitchToDesign={() => { setDetailId(null); setMode('design'); }}
            onCreateFollowThrough={async ({ title, dueDate, sourceLoop, artifact }) => {
              const nowIso = new Date().toISOString();
              const noteId = Math.random().toString(36).slice(2, 10);
              await createLoop({
                tier: 'soon',
                text: title,
                pLevel: sourceLoop.pLevel ?? null,
                difficulty: null,
                timeEstimateMinutes: 30,
                subGroup: sourceLoop.subGroup ?? null,
                domain: sourceLoop.domain,
                source: { file: '00-Inbox/close-outs.md', line: 1 },
                timeblocks: [],
                done: false,
                updatedAt: nowIso,
                dueDate,
                tendSource: 'manual',
                notes: [
                  {
                    id: noteId,
                    createdAt: nowIso,
                    text: `Follow-through for ${sourceLoop.id}. Close-out artifact:\n\n${artifact}`,
                    system: true,
                  },
                ],
              });
            }}
          />
        )}

        <SearchOverlay
          open={searchOpen}
          loops={activeLoops}
          onClose={() => setSearchOpen(false)}
          onPick={(id) => setDetailId(id)}
        />

        <BoundaryLogPanel
          open={boundaryPanelOpen}
          onClose={() => setBoundaryPanelOpen(false)}
        />

        <CapacityGateModal
          open={capacityGate.open}
          kind={capacityGate.kind}
          currentCount={capacityGate.currentCount}
          max={capacityGate.max}
          pendingTitle={capacityGate.pending?.text ?? ''}
          onCancel={() => {
            pendingPromotionIdRef.current = null;
            setCapacityGate((g) => ({ ...g, open: false, pending: null }));
          }}
          onProceed={async (reason) => {
            const pending = capacityGate.pending;
            const kind = capacityGate.kind;
            // Take a snapshot of counts BEFORE the write so the
            // boundary log entry reflects the state the user pushed
            // through.
            const snapshot = {
              p1_stakeholder: data ? countActiveP1Stakeholder(data.loops) : 0,
              p1_self: data ? countActiveP1Self(data.loops) : 0,
            };
            const promotionId = pendingPromotionIdRef.current;
            pendingPromotionIdRef.current = null;
            setCapacityGate((g) => ({ ...g, open: false, pending: null }));
            if (!pending || !data) return;
            // Human-readable label for the audit context string. The
            // 'P1:stakeholder' discriminator is internal-only.
            const kindLabel =
              kind === 'P1:stakeholder'
                ? P1_STAKEHOLDER
                : kind === 'P1:self'
                  ? P1_SELF
                  : kind;
            if (promotionId) {
              // Promotion path — preserve existing id.
              const next = {
                ...data,
                loops: data.loops.map((l) =>
                  l.id === promotionId ? { ...l, ...pending } : l,
                ),
              };
              await saveData(next);
              appendBoundaryLog({
                type: 'capacity_override',
                context: `Promoted to ${kindLabel} past the ${capacityGate.max}-loop ceiling`,
                reason,
                loop_id: promotionId,
                counts_at_time: snapshot,
              });
            } else {
              await commitCreate(pending);
              appendBoundaryLog({
                type: 'capacity_override',
                context: `Created a new ${kindLabel} loop past the ${capacityGate.max}-loop ceiling`,
                reason,
                counts_at_time: snapshot,
              });
            }
          }}
        />

        <CheckpointModal
          loops={activeLoops}
          onCompleted={() => { /* no-op; store updates via tend event */ }}
        />

        <CheckpointSkipBanner />

        <AdoptLoopDialog
          open={adoptOpen}
          onClose={() => setAdoptOpen(false)}
          onAdopt={async (draft) => {
            await createLoop(draft);
            setAdoptOpen(false);
          }}
        />

        <TriageMigrationModal
          loops={data.loops}
          onBulkUpdate={async (patches) => {
            if (!data) return;
            const patchMap = new Map(patches.map((p) => [p.id, p.patch]));
            const next = {
              ...data,
              loops: data.loops.map((l) => {
                const p = patchMap.get(l.id);
                return p ? { ...l, ...p } : l;
              }),
            };
            await saveData(next);
          }}
        />

        <ClaudeChat
          open={claudeChatOpen}
          onClose={() => setClaudeChatOpen(false)}
          loops={activeLoops}
          allLoops={data.loops}
          focusedLoop={
            focusedId ? data.loops.find((l) => l.id === focusedId) ?? null : null
          }
          specs={specDocs}
          pageContext={(() => {
            const parts: string[] = [`Mode: ${mode}`];
            if (mode === 'focus') {
              const fl = focusedId ? data.loops.find((l) => l.id === focusedId) : null;
              if (fl) parts.push(`Focused on: "${fl.text}" (${fl.source.file}), status: ${fl.status}, priority: ${fl.priority ?? fl.pLevel ?? 'none'}`);
              parts.push(`Active loops: ${activeLoops.length}`);
            } else if (mode === 'triage') {
              const triageLoops = data.loops.filter((l) => !l.done && l.status === 'triage');
              parts.push(`Triage queue: ${triageLoops.length} items`);
              triageLoops.slice(0, 10).forEach((l) => parts.push(`  - "${l.text}" (${l.source.file})`));
            } else if (mode === 'backlog') {
              parts.push(`Backlog: ${activeLoops.length} active loops`);
              const byGroup = new Map<string, number>();
              activeLoops.forEach((l) => { const g = l.subGroup || 'ungrouped'; byGroup.set(g, (byGroup.get(g) || 0) + 1); });
              byGroup.forEach((count, group) => parts.push(`  - ${group}: ${count}`));
            } else if (mode === 'research' || mode === 'design') {
              if (mode === 'research') {
                parts.push(`Research shelf: ${researchDocs.length} docs`);
                researchDocs.slice(0, 8).forEach((d) => parts.push(`  - "${d.title}" (${d.filePath}, ${d.staleDays}d old)`));
              } else {
                parts.push(`Design bench: ${specDocs.length} specs`);
                specDocs.forEach((s) => parts.push(`  - "${s.title}" [${s.status}] ${s.linkedLoopCount} loops (${s.filePath})`));
              }
            } else if (mode === 'plan') {
              parts.push(`Plan mode — week canvas with ${activeLoops.filter((l) => l.timeblocks.length > 0).length} scheduled loops`);
            } else if (mode === 'reflect') {
              const done = data.loops.filter((l) => l.done).length;
              const stale = activeLoops.filter((l) => { if (!l.updatedAt) return false; return Date.now() - new Date(l.updatedAt).getTime() > 7 * 86400000; }).length;
              parts.push(`Reflect: ${activeLoops.length} active, ${done} done, ${stale} stale`);
            }
            if (detailId) {
              const dl = data.loops.find((l) => l.id === detailId);
              if (dl) parts.push(`Detail drawer open for: "${dl.text}" (${dl.source.file})`);
            }
            return parts.join('\n');
          })()}
        />

        {/* Claude chat trigger */}
        {!claudeChatOpen && (
          <button
            type="button"
            onClick={() => setClaudeChatOpen(true)}
            className="fixed bottom-5 right-5 z-40 w-10 h-10 rounded-full bg-[var(--mauve)] text-white shadow-lg hover:opacity-90 transition-opacity flex items-center justify-center"
            title="Claude Chat (⌘⇧C)"
            aria-label="Open Claude chat"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}

        {/* Drag overlay sized to task duration so what you see is what you get */}
        <DragOverlay dropAnimation={null}>
          {draggingLoop ? (
            <DragPill loop={draggingLoop} extraCount={selectedIds.size - 1} />
          ) : null}
        </DragOverlay>

        {/* Vault browser — slide-in left drawer (Obsidian replacement). */}
        <VaultBrowser
          open={vaultBrowserOpen}
          onClose={() => setVaultBrowserOpen(false)}
          onSelect={(p) => {
            setOpenNotePath(p);
            setVaultBrowserOpen(false);
          }}
          activeFilePath={openNotePath}
          refreshKey={vaultRefreshKey}
        />

        {/* Note reader — fullscreen overlay for any vault file.
            Always opens in edit mode; click "Preview" for the
            rendered view. */}
        {openNotePath && (
          <NoteReader
            key={openNotePath}
            filePath={openNotePath}
            onClose={() => setOpenNotePath(null)}
            onSaved={() => setVaultRefreshKey((k) => k + 1)}
            onNavigate={(next) => setOpenNotePath(next)}
          />
        )}

        {/* Capture bar — `c` from anywhere; lands in triage. */}
        <CaptureBar
          open={captureOpen}
          onClose={() => setCaptureOpen(false)}
          onCapture={createLoop}
        />

        {/* First-launch ritual — only when fully empty and unflagged. */}
        {!ritualDismissed && data?.loops.length === 0 && (
          <FirstLaunchRitual
            onCapture={createLoop}
            onLoadDemo={() => loadDemoSeed(createLoop)}
            onComplete={() => {
              setRitualDismissed(true);
              setMode('triage');
            }}
            onSkip={() => setRitualDismissed(true)}
          />
        )}
      </div>
    </DndContext>
  );
}

function DragPill({ loop, extraCount }: { loop: Loop; extraCount: number }) {
  // Slim, quiet drag overlay. Earlier it was a 280px rectangle sized to
  // task duration, which felt like dragging a filing cabinet. Now it's a
  // compact pill that nudges with a subtle tilt and soft shadow so the
  // cursor stays readable and the user sees *what* they're moving
  // without the overlay eating the calendar they're dropping into.
  const duration = loop.timeEstimateMinutes ?? 30;
  return (
    <div
      className="relative rounded-md bg-card/95 backdrop-blur-[2px] border-[0.5px] border-edge flex items-center gap-2 px-2.5 py-1.5 overflow-hidden cursor-grabbing"
      style={{
        width: '220px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
        transform: 'rotate(-1deg)',
      }}
    >
      <span
        aria-hidden
        className={`w-[2px] h-4 rounded-full shrink-0 ${pBarColor(loop.pLevel)}`}
      />
      <span className="flex-1 min-w-0 text-[12px] text-ink leading-snug truncate">
        {loop.text}
      </span>
      <span className="text-[10px] text-ink-ghost tabular-nums shrink-0">
        {formatMinutes(duration)}
      </span>
      {extraCount > 0 && (
        <span className="absolute -top-1.5 -right-1.5 bg-[var(--mauve)] text-white text-[9px] font-medium rounded-full px-1.5 h-[14px] leading-[14px]">
          +{extraCount}
        </span>
      )}
    </div>
  );
}
