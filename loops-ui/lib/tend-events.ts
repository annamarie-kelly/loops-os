// Shared write library — the single entry point for every state-mutating
// operation. Both the web API routes and the CLI scripts feed typed
// events through `applyEvent` / `applyEventToDisk` so the gates
// (capacity, triage, close-out) and the audit trail run exactly once
// per mutation.
//
// PURE NODE + TYPESCRIPT ONLY. No React, no Next, no browser APIs.
// If you need to render UI, do that in the caller.

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  Loop,
  LoopsFile,
  LoopNote,
  Timeblock,
  TriagePriority,
  TriageStatus,
  Checkpoint,
  BoundaryLogEntry,
} from './types';
import { migrateLoopsFile } from './types';
import {
  checkCapacityGate,
  checkCloseOutGate,
  type CloseoutPayload,
  type GateReason,
} from './tend-gates';
import {
  type Actor,
  type AuditEntry,
  appendAuditEntry,
  makeAuditEntry,
  readLoopsJson,
  writeLoopsJson,
  resolveVaultRoot,
  withLock,
  ulid,
} from './tend-audit';
import { similarity } from './fuzzy-match';

// ─── Event payloads ─────────────────────────────────────────────────

export interface CreateLoopPayload {
  title: string;
  notes?: string;
  sourceFile?: string;
  sourceLine?: number;
  pLevel?: string | null;
  priority?: TriagePriority | null;
  stakeholder?: string | null;
  subGroup?: string | null;
  timeEstimateMinutes?: number | null;
  skipTriage?: boolean;
  timeblock?: { date: string; startMinute: number; endMinute: number };
  // Escape hatch for capacity gate — matches the web UI's override
  // flow. If present + non-empty, the gate is skipped and the
  // override is recorded in the audit entry.
  override_reason?: string;
}

export interface AcceptLoopPayload {
  loop_id: string;
  priority: TriagePriority;
  stakeholder?: string | null;
  override_reason?: string;
}

export interface UpdatePriorityPayload {
  loop_id: string;
  priority?: TriagePriority | null;
  pLevel?: string | null;
  stakeholder?: string | null;
  override_reason?: string;
}

export interface UpdateStakeholderPayload {
  loop_id: string;
  stakeholder: string | null;
}

export interface UpdateStatusPayload {
  loop_id: string;
  status: TriageStatus;
}

export interface AddNotePayload {
  loop_id: string;
  text: string;
  system?: boolean;
}

export interface ScheduleBlockPayload {
  loop_id: string;
  block: Timeblock;
  // Optional index — if present, replaces that block; otherwise
  // appended.
  index?: number;
}

export interface ClearBlockPayload {
  loop_id: string;
  // If omitted, clears all blocks on the loop.
  index?: number;
}

export interface CloseLoopPayload {
  loop_id: string;
  closeout: CloseoutPayload;
}

export interface DropLoopPayload {
  loop_id: string;
  reason?: string;
}

export interface SnoozeLoopPayload {
  loop_id: string;
  until: string; // YYYY-MM-DD
}

export interface LogCheckpointPayload {
  date?: string;
  pressure: 'building' | 'improving' | 'fixing' | 'supporting' | 'chose' | 'reactive' | 'task_monkey';
  tomorrow_intent?: string[];
  loops_touched?: Checkpoint['loops_touched'];
  annotation?: string;
  source?: 'web' | 'terminal' | 'backfill';
}

export interface LogBoundaryPayload {
  type: BoundaryLogEntry['type'];
  context: string;
  reason?: string;
  loop_id?: string;
  counts_at_time?: { p1_stakeholder: number; p1_self: number };
}

export interface ScanDetectedLoopPayload {
  // Stable id from refresh-loops' hash of (source file, text). Used
  // for exact-match preservation. When refresh-loops rekeys via its
  // fuzzy pass, it passes the PREV loop's id here so the handler
  // updates that existing loop instead of creating a new one.
  stable_id?: string;
  title: string;
  sourceFile: string;
  sourceLine: number;
  subGroup?: string | null;
  pLevel?: string | null;
  difficulty?: number | null;
  timeEstimateMinutes?: number | null;
  // Extended classifier fields so refresh-loops can pass the full
  // output of scanFile without a second classification pass inside
  // the handler. All optional; omitted fields fall back to the
  // existing loop's value (preserve) or a reasonable default for
  // brand-new creates.
  tier?: 'now' | 'soon' | 'someday' | null;
  domain?: string | null;
  workMode?: string | null;
  workModeSource?: 'auto' | 'manual' | null;
}

// ─── Event union ────────────────────────────────────────────────────
export type TendEvent =
  | { kind: 'create_loop'; payload: CreateLoopPayload }
  | { kind: 'accept_loop'; payload: AcceptLoopPayload }
  | { kind: 'update_priority'; payload: UpdatePriorityPayload }
  | { kind: 'update_stakeholder'; payload: UpdateStakeholderPayload }
  | { kind: 'update_status'; payload: UpdateStatusPayload }
  | { kind: 'add_note'; payload: AddNotePayload }
  | { kind: 'schedule_block'; payload: ScheduleBlockPayload }
  | { kind: 'clear_block'; payload: ClearBlockPayload }
  | { kind: 'close_loop'; payload: CloseLoopPayload }
  | { kind: 'drop_loop'; payload: DropLoopPayload }
  | { kind: 'snooze_loop'; payload: SnoozeLoopPayload }
  | { kind: 'log_checkpoint'; payload: LogCheckpointPayload }
  | { kind: 'log_boundary'; payload: LogBoundaryPayload }
  | { kind: 'scan_detected_loop'; payload: ScanDetectedLoopPayload };

export type TendEventKind = TendEvent['kind'];

// ─── ApplyResult ────────────────────────────────────────────────────
export type ApplyResult =
  | {
      status: 'applied';
      state: LoopsFile;
      audit: AuditEntry;
      loop_id?: string;
      // When true, applyEventToDisk skips BOTH the loops.json write
      // AND the events.log append. Used by `scan_detected_loop` when
      // a refresh pass finds an existing loop with nothing to update:
      // there's no state delta to persist and no signal worth
      // recording in the audit trail.
      noop?: boolean;
    }
  | {
      status: 'gated';
      gate: GateReason;
      suggestion?: string;
      context?: Record<string, unknown>;
      audit: AuditEntry;
    }
  | { status: 'rejected'; error: string; audit?: AuditEntry };

// ─── Public API ─────────────────────────────────────────────────────

// In-memory apply: caller supplies the current state, we return the
// next state. Used by unit tests and by the HTTP endpoint when it
// already has fresh state in hand. Does NOT acquire the file lock or
// write to disk; caller is responsible for persistence.
export function applyEventInMemory(
  state: LoopsFile,
  event: TendEvent,
  actor: Actor,
): ApplyResult {
  const handler = HANDLERS[event.kind] as EventHandler<typeof event>;
  return handler(state, event, actor);
}

// Read-lock-apply-write-release cycle. This is the canonical CLI
// entry point. Callers from the web HTTP layer can also use it when
// they don't have a local state cache.
export async function applyEventToDisk(
  event: TendEvent,
  actor: Actor,
  root: string = resolveVaultRoot(),
): Promise<ApplyResult> {
  try {
    return await withLock(async () => {
      // Some events don't touch loops.json at all (boundary log,
      // checkpoint). They still get an audit entry but don't need a
      // loops.json round-trip. We read loops.json anyway so the
      // audit entries have consistent state in case the handler
      // needs it.
      let state: LoopsFile;
      try {
        const raw = (await readLoopsJson(root)) as {
          lastScanned?: string;
          loops?: unknown[];
        };
        state = migrateLoopsFile(
          raw as { lastScanned?: string; loops?: Parameters<typeof migrateLoopsFile>[0]['loops'] },
        );
      } catch {
        state = { lastScanned: '', loops: [] };
      }

      const result = applyEventInMemory(state, event, actor);

      if (result.status === 'applied' && !result.noop) {
        // Persist the updated state.
        await writeLoopsJson(result.state, root);
        // Side-effect handlers (checkpoints, boundary log, markdown
        // checkboxes) run after loops.json is safely on disk so a
        // crash mid-way doesn't leave them orphaned.
        await runSideEffects(event, result, root);
      }

      // Every result — applied, gated, or rejected — gets an audit
      // entry. The handler already populated `result.audit`.
      // Exception: `noop` applied results deliberately skip the log
      // so refresh rescans of an unchanged vault stay silent.
      if (
        'audit' in result &&
        result.audit &&
        !(result.status === 'applied' && result.noop)
      ) {
        await appendAuditEntry(result.audit, root);
      }

      return result;
    }, root);
  } catch (err) {
    const msg = (err as Error)?.message || 'unknown_error';
    const audit = makeAuditEntry(event.kind, 'rejected', actor, {
      summary: msg,
    });
    try {
      await appendAuditEntry(audit, root);
    } catch {
      /* best effort */
    }
    return { status: 'rejected', error: msg, audit };
  }
}

// ─── Internal: handler map ──────────────────────────────────────────

type EventHandler<E extends TendEvent> = (
  state: LoopsFile,
  event: E,
  actor: Actor,
) => ApplyResult;

// Bump `updatedAt` and `last_event_id` atomically on whichever loop a
// mutation touches. Returns a shallow copy with the fields stamped.
function stampLoop(loop: Loop, eventId: string, now: string): Loop {
  return { ...loop, updatedAt: now, last_event_id: eventId };
}

function nowIso(): string {
  return new Date().toISOString();
}

function findLoop(state: LoopsFile, id: string): Loop | undefined {
  return state.loops.find((l) => l.id === id);
}

function replaceLoop(state: LoopsFile, id: string, next: Loop): LoopsFile {
  return {
    ...state,
    loops: state.loops.map((l) => (l.id === id ? next : l)),
  };
}

// Stable id generator for new loops. Matches refresh-loops.mjs / the
// web UI hash scheme (sha256 of source file + text, first 12 hex).
async function hashIdForLoop(
  sourceFile: string,
  text: string,
): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(`${sourceFile}::${text}`)
    .digest('hex')
    .slice(0, 12);
}

// ─── Handlers ───────────────────────────────────────────────────────

const createLoopHandler: EventHandler<Extract<TendEvent, { kind: 'create_loop' }>> = (
  state,
  event,
  actor,
) => {
  const p = event.payload;
  const title = (p.title || '').trim();
  if (!title) {
    const audit = makeAuditEntry('create_loop', 'rejected', actor, {
      summary: 'empty_title',
    });
    return { status: 'rejected', error: 'empty_title', audit };
  }

  // Capacity gate — skipped when override_reason is present.
  if (!p.override_reason) {
    const gate = checkCapacityGate(state, {
      pLevel: p.pLevel ?? null,
      priority: p.priority ?? null,
      stakeholder: p.stakeholder ?? null,
    });
    if (!gate.ok) {
      const audit = makeAuditEntry('create_loop', 'gated', actor, {
        summary: title,
        context: { gate: gate.reason, ...gate.context },
      });
      return {
        status: 'gated',
        gate: gate.reason,
        suggestion: gate.suggestion,
        context: gate.context,
        audit,
      };
    }
  }

  // Build the new loop. Triage status by default unless caller
  // explicitly bypassed (P0 or skipTriage).
  const skipTriage =
    p.skipTriage === true ||
    p.priority === 'P0' ||
    p.pLevel === 'P0';
  const defaultStatus: TriageStatus = skipTriage ? 'active' : 'triage';
  const sourceFile = p.sourceFile ?? '00-Inbox/manual-loops.md';
  const sourceLine = p.sourceLine ?? 0;

  // Synchronous hash fallback — we cannot `await` inside a pure
  // handler. Use a simple djb2-style hash instead; it is stable
  // enough for the de-dup check and matches the shape (12 hex
  // chars). Refresh-loops' sha256 id will still round-trip because
  // it goes through `scan_detected_loop` which uses its own hash.
  const id = syncHashId(sourceFile, title);

  // Duplicate id check — matches the stable-id collision semantics
  // the spec mentions.
  if (state.loops.some((l) => l.id === id)) {
    const audit = makeAuditEntry('create_loop', 'gated', actor, {
      summary: title,
      loop_id: id,
      context: { gate: 'duplicate_loop_id' },
    });
    return {
      status: 'gated',
      gate: 'duplicate_loop_id',
      suggestion: 'A loop with this source + title already exists.',
      audit,
    };
  }

  const eventId = ulid();
  const now = nowIso();
  const loop: Loop = {
    id,
    tier: 'soon',
    text: title,
    pLevel: p.pLevel ?? null,
    difficulty: null,
    timeEstimateMinutes: p.timeEstimateMinutes ?? null,
    subGroup: p.subGroup ?? null,
    domain: 'personal',
    source: { file: sourceFile, line: sourceLine },
    timeblocks: p.timeblock ? [p.timeblock] : [],
    done: false,
    priority: p.priority ?? null,
    stakeholder: p.stakeholder ?? null,
    status: defaultStatus,
    notes: p.notes
      ? [
          {
            id: ulid(),
            createdAt: now,
            text: p.notes,
          } as LoopNote,
        ]
      : undefined,
    updatedAt: now,
    last_event_id: eventId,
    tendSource: 'manual',
  };

  const nextState: LoopsFile = { ...state, loops: [...state.loops, loop] };
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'create_loop',
    result: 'applied',
    loop_id: id,
    summary: title,
    context: p.override_reason
      ? { override_reason: p.override_reason }
      : undefined,
  };
  return { status: 'applied', state: nextState, audit, loop_id: id };
};

// Synchronous 12-hex-char hash. Used only as a fallback for the
// create_loop in-memory path (which can't await). Matches neither
// sha256 nor the web UI's scheme exactly, but is deterministic per
// (source, text).
function syncHashId(sourceFile: string, text: string): string {
  let h1 = 0x12345678;
  let h2 = 0x87654321;
  const s = `${sourceFile}::${text}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c) * 0x01000193;
    h1 = h1 >>> 0;
    h2 = h2 >>> 0;
  }
  return (
    h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(4, '0')
  ).slice(0, 12);
}

const acceptLoopHandler: EventHandler<Extract<TendEvent, { kind: 'accept_loop' }>> = (
  state,
  event,
  actor,
) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('accept_loop', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  if (loop.status !== 'triage') {
    const audit = makeAuditEntry('accept_loop', 'gated', actor, {
      loop_id: p.loop_id,
      context: { gate: 'already_accepted', current_status: loop.status },
    });
    return {
      status: 'gated',
      gate: 'already_accepted',
      suggestion: `Loop already in status ${loop.status}.`,
      audit,
    };
  }

  if (!p.override_reason) {
    const gate = checkCapacityGate(state, {
      priority: p.priority,
      stakeholder: p.stakeholder ?? null,
    });
    if (!gate.ok) {
      const audit = makeAuditEntry('accept_loop', 'gated', actor, {
        loop_id: p.loop_id,
        context: { gate: gate.reason, ...gate.context },
      });
      return {
        status: 'gated',
        gate: gate.reason,
        suggestion: gate.suggestion,
        context: gate.context,
        audit,
      };
    }
  }

  const eventId = ulid();
  const now = nowIso();
  const nextLoop: Loop = stampLoop(
    {
      ...loop,
      priority: p.priority,
      stakeholder: p.stakeholder ?? loop.stakeholder ?? null,
      status: 'active',
      triage_decision: {
        disposition: 'accept',
        priority: p.priority,
        stakeholder: p.stakeholder ?? null,
        matched_ai: false,
        decided_at: now,
      },
    },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'accept_loop',
    result: 'applied',
    loop_id: loop.id,
    summary: loop.text,
    context: p.override_reason ? { override_reason: p.override_reason } : undefined,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const updatePriorityHandler: EventHandler<
  Extract<TendEvent, { kind: 'update_priority' }>
> = (state, event, actor) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('update_priority', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }

  // No-op short-circuit: matches page.tsx's "only gate on genuine
  // promotion" behavior.
  const samePLevel = p.pLevel === undefined || p.pLevel === loop.pLevel;
  const samePriority = p.priority === undefined || p.priority === loop.priority;
  const sameStakeholder =
    p.stakeholder === undefined || p.stakeholder === loop.stakeholder;
  if (samePLevel && samePriority && sameStakeholder) {
    // Nothing to do — still record an applied audit so the trail is
    // complete, but don't mutate state.
    const audit = makeAuditEntry('update_priority', 'applied', actor, {
      loop_id: loop.id,
      summary: 'noop',
    });
    return { status: 'applied', state, audit, loop_id: loop.id };
  }

  if (!p.override_reason) {
    const gate = checkCapacityGate(state, {
      pLevel: p.pLevel ?? null,
      priority: p.priority ?? null,
      stakeholder: p.stakeholder ?? null,
    });
    if (!gate.ok) {
      const audit = makeAuditEntry('update_priority', 'gated', actor, {
        loop_id: loop.id,
        context: { gate: gate.reason, ...gate.context },
      });
      return {
        status: 'gated',
        gate: gate.reason,
        suggestion: gate.suggestion,
        context: gate.context,
        audit,
      };
    }
  }

  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop(
    {
      ...loop,
      pLevel: p.pLevel !== undefined ? p.pLevel : loop.pLevel,
      priority: p.priority !== undefined ? p.priority : loop.priority,
      stakeholder:
        p.stakeholder !== undefined ? p.stakeholder : loop.stakeholder,
    },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'update_priority',
    result: 'applied',
    loop_id: loop.id,
    summary: loop.text,
    context: p.override_reason ? { override_reason: p.override_reason } : undefined,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const updateStakeholderHandler: EventHandler<
  Extract<TendEvent, { kind: 'update_stakeholder' }>
> = (state, event, actor) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('update_stakeholder', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop(
    { ...loop, stakeholder: p.stakeholder },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'update_stakeholder',
    result: 'applied',
    loop_id: loop.id,
    summary: loop.text,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const updateStatusHandler: EventHandler<
  Extract<TendEvent, { kind: 'update_status' }>
> = (state, event, actor) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('update_status', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop({ ...loop, status: p.status }, eventId, now);
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'update_status',
    result: 'applied',
    loop_id: loop.id,
    summary: `${loop.text} -> ${p.status}`,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const addNoteHandler: EventHandler<Extract<TendEvent, { kind: 'add_note' }>> = (
  state,
  event,
  actor,
) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('add_note', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  const text = (p.text || '').trim();
  if (!text) {
    const audit = makeAuditEntry('add_note', 'rejected', actor, {
      loop_id: loop.id,
      summary: 'empty_note',
    });
    return { status: 'rejected', error: 'empty_note', audit };
  }
  const eventId = ulid();
  const now = nowIso();
  const newNote: LoopNote = {
    id: ulid(),
    createdAt: now,
    text,
    system: p.system,
  };
  const nextLoop = stampLoop(
    { ...loop, notes: [...(loop.notes ?? []), newNote] },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'add_note',
    result: 'applied',
    loop_id: loop.id,
    summary: text.slice(0, 80),
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const scheduleBlockHandler: EventHandler<
  Extract<TendEvent, { kind: 'schedule_block' }>
> = (state, event, actor) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('schedule_block', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  const blocks = [...loop.timeblocks];
  if (typeof p.index === 'number' && p.index >= 0 && p.index < blocks.length) {
    blocks[p.index] = p.block;
  } else {
    blocks.push(p.block);
  }
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop({ ...loop, timeblocks: blocks }, eventId, now);
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'schedule_block',
    result: 'applied',
    loop_id: loop.id,
    summary: `${p.block.date} ${p.block.startMinute}-${p.block.endMinute}`,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const clearBlockHandler: EventHandler<
  Extract<TendEvent, { kind: 'clear_block' }>
> = (state, event, actor) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('clear_block', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  const blocks =
    typeof p.index === 'number'
      ? loop.timeblocks.filter((_, i) => i !== p.index)
      : [];
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop({ ...loop, timeblocks: blocks }, eventId, now);
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'clear_block',
    result: 'applied',
    loop_id: loop.id,
    summary: loop.text,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const closeLoopHandler: EventHandler<Extract<TendEvent, { kind: 'close_loop' }>> = (
  state,
  event,
  actor,
) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('close_loop', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  const gate = checkCloseOutGate(state, loop, p.closeout);
  if (!gate.ok) {
    const audit = makeAuditEntry('close_loop', 'gated', actor, {
      loop_id: loop.id,
      context: { gate: gate.reason },
    });
    return {
      status: 'gated',
      gate: gate.reason,
      suggestion: gate.suggestion,
      audit,
    };
  }
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop(
    {
      ...loop,
      done: true,
      closedAs: 'done',
      doneAt: now,
      status: 'completed',
    },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'close_loop',
    result: 'applied',
    loop_id: loop.id,
    summary: loop.text,
    context: {
      docs: p.closeout.docs,
      stakeholder_notified: p.closeout.stakeholder_notified,
      artifact_path: p.closeout.artifact_path,
      follow_through_date: p.closeout.follow_through_date,
    },
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const dropLoopHandler: EventHandler<Extract<TendEvent, { kind: 'drop_loop' }>> = (
  state,
  event,
  actor,
) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('drop_loop', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  if (loop.done) {
    const audit = makeAuditEntry('drop_loop', 'gated', actor, {
      loop_id: loop.id,
      context: { gate: 'already_closed' },
    });
    return { status: 'gated', gate: 'already_closed', audit };
  }
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop(
    {
      ...loop,
      done: true,
      closedAs: 'dropped',
      doneAt: now,
      status: 'dropped',
    },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'drop_loop',
    result: 'applied',
    loop_id: loop.id,
    summary: loop.text,
    context: p.reason ? { reason: p.reason } : undefined,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const snoozeLoopHandler: EventHandler<Extract<TendEvent, { kind: 'snooze_loop' }>> = (
  state,
  event,
  actor,
) => {
  const p = event.payload;
  const loop = findLoop(state, p.loop_id);
  if (!loop) {
    const audit = makeAuditEntry('snooze_loop', 'rejected', actor, {
      loop_id: p.loop_id,
      summary: 'loop_not_found',
    });
    return { status: 'rejected', error: 'loop_not_found', audit };
  }
  // Guard against past dates — a nonsense snooze should be rejected
  // rather than silently fail.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const untilDate = new Date(`${p.until}T00:00:00`);
  if (!Number.isFinite(untilDate.getTime()) || untilDate.getTime() < today.getTime()) {
    const audit = makeAuditEntry('snooze_loop', 'gated', actor, {
      loop_id: loop.id,
      context: { gate: 'snooze_date_in_past', until: p.until },
    });
    return {
      status: 'gated',
      gate: 'snooze_date_in_past',
      suggestion: 'Pass --until as a future YYYY-MM-DD.',
      audit,
    };
  }
  const eventId = ulid();
  const now = nowIso();
  const nextLoop = stampLoop(
    { ...loop, snooze_until: p.until, status: 'triage' },
    eventId,
    now,
  );
  const nextState = replaceLoop(state, loop.id, nextLoop);
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'snooze_loop',
    result: 'applied',
    loop_id: loop.id,
    summary: `snooze until ${p.until}`,
  };
  return { status: 'applied', state: nextState, audit, loop_id: loop.id };
};

const logCheckpointHandler: EventHandler<
  Extract<TendEvent, { kind: 'log_checkpoint' }>
> = (state, event, actor) => {
  // Checkpoints are session-scoped localStorage state on the web side;
  // on the terminal side they land in 06-Loops/checkpoints.json via
  // the side-effect handler. We do not mutate loops.json here.
  const eventId = ulid();
  const now = nowIso();
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'log_checkpoint',
    result: 'applied',
    summary: `${event.payload.date ?? todayLocal()} ${Array.isArray(event.payload.pressure) ? event.payload.pressure.join('+') : event.payload.pressure}`,
    context: {
      tomorrow_intent: event.payload.tomorrow_intent,
      source: event.payload.source,
      annotation: event.payload.annotation,
    },
  };
  return { status: 'applied', state, audit };
};

const logBoundaryHandler: EventHandler<
  Extract<TendEvent, { kind: 'log_boundary' }>
> = (state, event, actor) => {
  const eventId = ulid();
  const now = nowIso();
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'log_boundary',
    result: 'applied',
    loop_id: event.payload.loop_id,
    summary: event.payload.context,
    context: {
      type: event.payload.type,
      reason: event.payload.reason,
      counts_at_time: event.payload.counts_at_time,
    },
  };
  return { status: 'applied', state, audit };
};

// Fields refresh-loops preserves from the previous loop across a
// rescan. Mirrors `PRESERVED_FIELDS` in scripts/refresh-loops.mjs
// so the `scan_detected_loop` handler is the single source of truth
// for merge semantics.
const SCAN_PRESERVED_FIELDS: Array<keyof Loop> = [
  'timeblocks',
  'done',
  'closedAs',
  'doneAt',
  'notes',
  'blocked',
  'dueDate',
  'updatedAt',
  'priority',
  'stakeholder',
  'status',
  'legacy_priority',
  'triage_decision',
  'ai_recommendation',
  'snooze_until',
  'last_event_id',
];

// Deep-ish shallow compare for detecting "nothing changed" on an
// exact-id scan. Only compares the scanner-controlled fields; user
// fields are already preserved so they trivially match.
function scanFieldsEqual(prev: Loop, next: Loop): boolean {
  if (prev.text !== next.text) return false;
  if (prev.tier !== next.tier) return false;
  if (prev.pLevel !== next.pLevel) return false;
  if (prev.difficulty !== next.difficulty) return false;
  if (prev.timeEstimateMinutes !== next.timeEstimateMinutes) return false;
  if (prev.subGroup !== next.subGroup) return false;
  if (prev.domain !== next.domain) return false;
  if (prev.workMode !== next.workMode) return false;
  if (prev.workModeSource !== next.workModeSource) return false;
  const prevSrc = prev.source ?? { file: '', line: 0 };
  const nextSrc = next.source ?? { file: '', line: 0 };
  if (prevSrc.file !== nextSrc.file) return false;
  if (prevSrc.line !== nextSrc.line) return false;
  return true;
}

const scanDetectedLoopHandler: EventHandler<
  Extract<TendEvent, { kind: 'scan_detected_loop' }>
> = (state, event, actor) => {
  const p = event.payload;
  const id =
    p.stable_id ?? syncHashId(p.sourceFile, p.title);
  const existing = findLoop(state, id);
  const eventId = ulid();
  const now = nowIso();
  if (existing) {
    // Fresh scanner fields with existing user fields preserved.
    // Mirrors `preserveFrom` in refresh-loops.mjs exactly: take the
    // fresh scan's text + classifier output, but keep every field in
    // SCAN_PRESERVED_FIELDS untouched.
    const merged: Loop = {
      ...existing,
      text: p.title,
      source: { file: p.sourceFile, line: p.sourceLine },
      subGroup: p.subGroup ?? existing.subGroup ?? null,
      pLevel: p.pLevel !== undefined ? p.pLevel : existing.pLevel,
      difficulty: p.difficulty !== undefined ? p.difficulty : existing.difficulty,
      timeEstimateMinutes:
        p.timeEstimateMinutes !== undefined
          ? p.timeEstimateMinutes
          : existing.timeEstimateMinutes,
      tier: p.tier ?? existing.tier,
      domain: (p.domain as Loop['domain']) ?? existing.domain,
      workMode:
        existing.workModeSource === 'manual'
          ? existing.workMode
          : (p.workMode as Loop['workMode']) ?? existing.workMode,
      workModeSource:
        existing.workModeSource === 'manual'
          ? 'manual'
          : (p.workModeSource as Loop['workModeSource']) ?? 'auto',
    };
    // Re-apply preserved fields verbatim (paranoia — the spread
    // above already handles it, but this keeps the intent loud).
    for (const f of SCAN_PRESERVED_FIELDS) {
      if (existing[f] !== undefined) {
        (merged as unknown as Record<string, unknown>)[f] =
          existing[f] as unknown;
      }
    }

    // No-op short-circuit. If nothing scanner-controlled changed,
    // return a noop result: applyEventToDisk will skip both the
    // loops.json write and the events.log append, keeping refresh
    // idempotent against an unchanged vault.
    if (scanFieldsEqual(existing, merged)) {
      const audit: AuditEntry = {
        event_id: eventId,
        timestamp: now,
        actor,
        kind: 'scan_detected_loop',
        result: 'applied',
        loop_id: id,
        summary: 'noop',
      };
      return {
        status: 'applied',
        state,
        audit,
        loop_id: id,
        noop: true,
      };
    }

    const nextLoop = stampLoop(merged, eventId, now);
    const nextState = replaceLoop(state, id, nextLoop);
    const audit: AuditEntry = {
      event_id: eventId,
      timestamp: now,
      actor,
      kind: 'scan_detected_loop',
      result: 'applied',
      loop_id: id,
      summary: `refresh: preserve ${p.title.slice(0, 60)}`,
    };
    return { status: 'applied', state: nextState, audit, loop_id: id };
  }
  const loop: Loop = {
    id,
    tier: p.tier ?? 'soon',
    text: p.title,
    pLevel: p.pLevel ?? null,
    difficulty: p.difficulty ?? null,
    timeEstimateMinutes: p.timeEstimateMinutes ?? null,
    subGroup: p.subGroup ?? null,
    domain: (p.domain as Loop['domain']) ?? 'building',
    source: { file: p.sourceFile, line: p.sourceLine },
    timeblocks: [],
    done: false,
    status: 'triage',
    priority: null,
    stakeholder: null,
    workMode: p.workMode as Loop['workMode'],
    workModeSource: (p.workModeSource as Loop['workModeSource']) ?? 'auto',
    tendSource: 'scanned',
    updatedAt: now,
    last_event_id: eventId,
  };
  const nextState: LoopsFile = { ...state, loops: [...state.loops, loop] };
  const audit: AuditEntry = {
    event_id: eventId,
    timestamp: now,
    actor,
    kind: 'scan_detected_loop',
    result: 'applied',
    loop_id: id,
    summary: `refresh: new ${p.title.slice(0, 60)}`,
  };
  return { status: 'applied', state: nextState, audit, loop_id: id };
};

// ─── Handler map ────────────────────────────────────────────────────
type HandlerMap = {
  [K in TendEventKind]: EventHandler<Extract<TendEvent, { kind: K }>>;
};

const HANDLERS: HandlerMap = {
  create_loop: createLoopHandler,
  accept_loop: acceptLoopHandler,
  update_priority: updatePriorityHandler,
  update_stakeholder: updateStakeholderHandler,
  update_status: updateStatusHandler,
  add_note: addNoteHandler,
  schedule_block: scheduleBlockHandler,
  clear_block: clearBlockHandler,
  close_loop: closeLoopHandler,
  drop_loop: dropLoopHandler,
  snooze_loop: snoozeLoopHandler,
  log_checkpoint: logCheckpointHandler,
  log_boundary: logBoundaryHandler,
  scan_detected_loop: scanDetectedLoopHandler,
};

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Side effects (file-system writes beyond loops.json) ────────────
//
// Vault markdown checkbox flipping (close/drop), checkpoint journal
// writes, and boundary-log JSON mirroring all happen here so they run
// once per applied event regardless of whether the caller is the web
// route or the CLI. Fire-and-forget: failures here don't invalidate
// the applied result but are logged to stderr.

async function runSideEffects(
  event: TendEvent,
  result: Extract<ApplyResult, { status: 'applied' }>,
  root: string,
): Promise<void> {
  try {
    if (event.kind === 'close_loop' || event.kind === 'drop_loop') {
      const loop = result.state.loops.find((l) => l.id === result.loop_id);
      if (loop && loop.source?.file) {
        await mutateSourceFile(
          root,
          loop.source.file,
          loop.source.line ?? 0,
          loop.text,
          event.kind === 'drop_loop' ? 'drop' : 'close',
        );
      }
    }
    if (event.kind === 'log_checkpoint') {
      await appendCheckpointToFile(event.payload, root);
    }
    if (event.kind === 'log_boundary') {
      await appendBoundaryToFile(event.payload, result.audit, root);
    }
  } catch (err) {
    // Non-fatal — surface to stderr so the CLI user sees it.
    process.stderr.write(
      `[tend-events] side-effect failure on ${event.kind}: ${
        (err as Error).message
      }\n`,
    );
  }
}

// ─── Vault markdown checkbox round-trip (mirrors action/route.ts) ──
const CHECKBOX_RE = /- \[([ xX\-])\]/;

async function mutateSourceFile(
  root: string,
  sourceFile: string,
  storedLine: number,
  taskText: string,
  action: 'close' | 'drop',
): Promise<void> {
  const abs = path.join(root, sourceFile);
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf-8');
  } catch {
    // Stub missing manual-loop file.
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const marker = action === 'drop' ? '[-]' : '[x]';
      const stub = `# Manual loops\n\nCaptures created in Tend that don't have a vault source yet.\n\n- ${marker} ${taskText}\n`;
      await fs.writeFile(abs, stub, 'utf-8');
    } catch {
      /* non-fatal */
    }
    return;
  }
  const lines = content.split('\n');
  let matchIdx = -1;
  const storedIdx = storedLine - 1;
  if (
    storedIdx >= 0 &&
    storedIdx < lines.length &&
    CHECKBOX_RE.test(lines[storedIdx]) &&
    similarity(taskText, lines[storedIdx]) >= 0.4
  ) {
    matchIdx = storedIdx;
  }
  if (matchIdx === -1) {
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!CHECKBOX_RE.test(lines[i])) continue;
      const s = similarity(taskText, lines[i]);
      if (s > bestScore) {
        bestScore = s;
        matchIdx = i;
      }
    }
    if (bestScore < 0.5) matchIdx = -1;
  }
  if (matchIdx === -1) return;
  const marker = action === 'drop' ? '- [-]' : '- [x]';
  lines[matchIdx] = lines[matchIdx].replace(CHECKBOX_RE, marker);
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
  await fs.rename(tmp, abs);
}

// ─── Checkpoint / boundary-log journal files ────────────────────────
// The spec separates the cross-client audit log (events.log.jsonl,
// every event) from the existing UX-scoped boundary log (localStorage).
// For parity on the terminal side we also write simple JSON journal
// files so the CLI-only view can surface recent checkpoints / boundary
// entries without reaching into localStorage.

async function appendCheckpointToFile(
  payload: LogCheckpointPayload,
  root: string,
): Promise<void> {
  const file = path.join(root, '06-Loops/checkpoints.json');
  let map: Record<string, Checkpoint> = {};
  try {
    const raw = await fs.readFile(file, 'utf-8');
    map = JSON.parse(raw) as Record<string, Checkpoint>;
  } catch {
    /* first write */
  }
  const date = payload.date ?? todayLocal();
  map[date] = {
    date,
    completed_at: new Date().toISOString(),
    skipped: false,
    loops_touched: payload.loops_touched ?? [],
    pressure: Array.isArray(payload.pressure) ? payload.pressure : payload.pressure ? [payload.pressure] : null,
    tomorrow_intent: payload.tomorrow_intent ?? [],
  };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

async function appendBoundaryToFile(
  payload: LogBoundaryPayload,
  audit: AuditEntry,
  root: string,
): Promise<void> {
  const file = path.join(root, '06-Loops/boundary_log.json');
  let arr: BoundaryLogEntry[] = [];
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) arr = parsed as BoundaryLogEntry[];
  } catch {
    /* first write */
  }
  arr.push({
    id: audit.event_id,
    timestamp: audit.timestamp,
    type: payload.type,
    context: payload.context,
    reason: payload.reason,
    loop_id: payload.loop_id,
    counts_at_time: payload.counts_at_time,
  });
  // Cap at 500 entries like the localStorage version.
  if (arr.length > 500) arr = arr.slice(-500);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(arr, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}
