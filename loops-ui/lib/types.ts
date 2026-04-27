export type Tier = 'now' | 'soon' | 'someday';

export type Domain = string;

export interface Timeblock {
  date: string; // ISO date "YYYY-MM-DD"
  startMinute: number; // minutes from midnight
  endMinute: number;
}

// Notes on a loop. User notes are plain text; system notes are
// auto-generated activity records (tier moves, etc.). Both interleave
// chronologically in the detail panel.
export interface LoopNote {
  id: string;
  createdAt: string; // ISO timestamp
  text: string;
  system?: boolean;
}

export interface Loop {
  id: string;
  tier: Tier;
  text: string;
  pLevel: string | null;
  difficulty: number | null;
  timeEstimateMinutes: number | null;
  subGroup: string | null;
  domain: Domain;
  source: { file: string; line: number };
  // Multiple timeblocks let a task split around conflicts. Empty array
  // when the task is unscheduled. Sum of block durations should equal
  // timeEstimateMinutes in the common case, but the UI tolerates drift.
  timeblocks: Timeblock[];
  // When true the loop has been closed. Closed loops remain in the JSON
  // (and render dimmed on the week canvas) but are filtered from all
  // planning surfaces: tier columns, drawer, counts, keyboard nav.
  done?: boolean;
  // Closure disposition — 'done' (shipped) vs 'dropped' (let go).
  // Used by the Focus view's streak/momentum counter to celebrate
  // both completion and pruning.
  closedAs?: 'done' | 'dropped';
  doneAt?: string; // ISO timestamp of closure
  // ISO timestamp of last user-facing field change. Used to surface
  // staleness on cards ("3d ago", "47d ago") without a separate
  // staleness indicator field.
  updatedAt?: string;
  // Waiting on someone or something external. Dimmed on triage cards
  // with a small "blocked" label so the work is visible but clearly
  // separated from actionable items.
  blocked?: boolean;
  // Hard external deadline. ISO date ("YYYY-MM-DD"). Rendered as a
  // "due in Xd" tag on cards and nudges things into Now as the date
  // approaches.
  dueDate?: string;
  // User + system notes. Optional so older loops.json without notes
  // still round-trip correctly.
  notes?: LoopNote[];
  // Work-mode classification — the kind of brain the task needs.
  // Populated by the keyword classifier in lib/ui.ts (auto) or by the
  // user via the detail panel (manual). The frontend always has a
  // fallback, so this field being absent is safe.
  workMode?: WorkMode;
  workModeSource?: 'auto' | 'manual';
  // ─── Tend self-protection layer (additive, all optional) ─────────
  // A loop can carry scope questions captured from other surfaces.
  // The detail drawer lets the user acknowledge or log a boundary
  // against each question.
  scope_questions?: ScopeQuestion[];
  // Optional. Set if this loop mirrors a ticket in an external task
  // tracker (Linear, Jira, etc.). Displayed in the detail panel so
  // you can jump to the ticket. Integrations live outside this repo
  // — wire your own sync job to set this field.
  linear_ticket_id?: string;
  // Optional free-text blocker description — populated from the
  // "Log boundary" scope action and surfaced in the detail drawer.
  blocker_reason?: string;
  // How the loop entered the system. 'manual' = created via the
  // Adopt dialog. Existing loops without this field are treated as
  // scanned from the vault.
  tendSource?: 'manual' | 'scanned' | 'linear' | 'demo';
  // User-set pin that forces this loop into the derived Now tier
  // regardless of schedule or priority. The Plan-mode keyboard `w`
  // shortcut toggles it. Cleared automatically when the loop is
  // closed or dropped. Renderer reads this via deriveTier() on every
  // GET + PUT so old callers still read loop.tier directly.
  pinned_to_week?: boolean;

  // ─── Tend triage gate (additive, all optional until migrated) ────
  // Flat priority axis. Separated from stakeholder so "all P1s" and
  // "everything my stakeholder cares about" are independent queries. Migrated
  // from pLevel by splitting on the colon. Nullable because
  // unprioritized loops are a real state.
  priority?: TriagePriority | null;
  // Stakeholder axis. Who cares about this? No ranking — all
  // stakeholders are equal inputs, the user weights them at accept
  // time. Stored as the raw name so migration can preserve unknown
  // values (e.g. a new colleague's name) without a type error.
  // Stakeholder values are plain strings so new names don't need a
  // type migration.
  stakeholder?: string | null;
  // Permanent audit trail of the pre-migration pLevel string. Never
  // cleared. Used by the Reflection view to show how the priority
  // model shifted over time.
  legacy_priority?: string | null;
  // Explicit status field. Replaces the derived tier+done combo for
  // new loops. Old loops without this field get a derived value at
  // read time (see statusFromLegacy). Migration writes it back so
  // subsequent reads are cheap.
  status?: TriageStatus;
  // AI seeding output for the triage card. Cleared when the user
  // processes the loop (or triggers a re-seed).
  ai_recommendation?: TriageRecommendation | null;
  // Snapshot of what the user decided in the triage gate. Stored
  // for the Reflection view's "AI match rate" and weekly
  // disposition breakdown.
  triage_decision?: TriageDecision | null;
  // When a snoozed loop comes due (ISO date), the daily reaper moves
  // it back to status=triage. Ignored when status !== 'triage' and
  // the loop is not snoozed.
  snooze_until?: string | null;

  // ─── Tend write unification (additive) ───────────────────────────
  // ULID of the most recent applied event that touched this loop.
  // Optional so older loops.json files deserialize without migration.
  // Set by `applyEvent` in `lib/tend-events.ts` whenever it mutates
  // the loop. Cheap provenance for debugging divergence between the
  // web UI and terminal agents.
  last_event_id?: string;
}

export type TriagePriority = 'P0' | 'P1' | 'P2' | 'P3';

export type TriageStatus =
  | 'triage'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'dropped'
  | 'someday';

export interface TriageRecommendation {
  suggested_disposition: 'accept' | 'someday' | 'drop' | 'snooze';
  suggested_priority?: TriagePriority;
  suggested_stakeholder?: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  signals: string[];
  seeded_at: string;
}

export interface TriageDecision {
  disposition: 'accept' | 'someday' | 'drop' | 'snooze';
  priority?: TriagePriority;
  stakeholder?: string | null;
  matched_ai: boolean;
  decided_at: string;
  snooze_until?: string;
  prioritize_answers?: {
    externally_blocked: boolean;
    displaces_p1: boolean;
    displaced_item?: string;
    asked_or_decided: 'asked' | 'decided';
    what_displaced?: string;
    why_today?: string;
  };
}

// Session-scoped triage stats — used by the Reflection view. Stored in
// localStorage; not part of the Loop schema.
export interface TriageSessionStats {
  session_start: string;
  processed: number;
  accepted: number;
  someday: number;
  dropped: number;
  snoozed: number;
  skipped: number;
  ai_match_rate: number;
  overcommit_warning_shown: boolean;
}

export interface ScopeQuestion {
  text: string;
  acknowledged_at?: string;
}

// ─── Tend boundary log ──────────────────────────────────────────────
export interface BoundaryLogEntry {
  id: string;
  timestamp: string;
  type:
    | 'capacity_override'
    | 'scope_acknowledge'
    | 'scope_boundary'
    | 'linear_conflict'
    | 'checkpoint_skip';
  context: string;
  reason?: string;
  loop_id?: string;
  counts_at_time?: { p1_stakeholder: number; p1_self: number };
}

// ─── Tend close-out (5-check gate on the Done button) ──────────────
// Persisted to localStorage under `loops-ui:tend:close_outs`. The
// client-side close gate writes one entry per Done click the user
// actually confirms, and BoundaryLogPanel reads them back as an audit
// trail. The loop itself never carries close-out state: it is a pure
// observation ledger next to the loop mutation.
export type CloseOutCheckStatus = 'green' | 'red' | 'accepted';

export interface CloseOutChecks {
  // `linear` is legacy — the close-out gate no longer asks about
  // Linear. Kept optional so older ledger entries still deserialize.
  linear?: CloseOutCheckStatus;
  docs: CloseOutCheckStatus;
  stakeholder: CloseOutCheckStatus;
  handoff: CloseOutCheckStatus;
  follow_through: CloseOutCheckStatus | 'n/a';
}

export interface CloseOutEntry {
  loop_id: string;
  loop_title: string;
  timestamp: string;
  checks: CloseOutChecks;
  gaps_accepted: string[];
  reason?: string;
  artifact: string;
}

// ─── Tend checkpoint ────────────────────────────────────────────────
export interface CheckpointTouchedLoop {
  loop_id: string;
  title: string;
  status: string;
  latest_note?: string;
  annotation?: string;
}

export interface Checkpoint {
  date: string; // YYYY-MM-DD
  completed_at?: string;
  skipped: boolean;
  loops_touched: CheckpointTouchedLoop[];
  pressure: string[] | null;
  tomorrow_intent: string[];
}

// ─── Tend weekly pattern scan ───────────────────────────────────────
export interface WeeklyPatternTerm {
  term: string;
  frequency: number;
  loop_ids: string[];
  loop_titles: string[];
}

export interface WeeklyPattern {
  week_start: string;
  generated_at: string;
  terms: WeeklyPatternTerm[];
  dismissed: boolean;
}

export type WorkMode =
  | 'build'
  | 'design'
  | 'communicate'
  | 'research'
  | 'ops'
  | 'unsorted';

// ─── Mission Control: Research Shelf ───────────────────────────────
export type ResearchCategory =
  | 'strategic-research'
  | 'technical-investigation'
  | 'foundational'
  | 'design-research'
  | 'artifact';

export interface ResearchDoc {
  id: string;
  title: string;
  summary: string;
  filePath: string;
  category: ResearchCategory;
  createdAt: string;
  updatedAt: string;
  staleDays: number;
  tags: string[];
  type: string;
  status: string;
  sizeBytes: number;
  openTaskCount: number;
  favorite: boolean;
  /** true for .html visual artifacts (rendered in iframe, not markdown) */
  isHtml?: boolean;
}

// ─── Mission Control: Design Bench ─────────────────────────────────
export type SpecStatus = 'drafting' | 'ready' | 'building' | 'shipped';

export interface SpecDoc {
  id: string;
  title: string;
  filePath: string;
  status: SpecStatus;
  effortEstimate: string | null;
  openQuestions: string[];
  createdAt: string;
  updatedAt: string;
  staleDays: number;
  sourceResearch: string[];
  linkedLoopCount: number;
  sizeBytes: number;
  /** true for .html visual artifacts (rendered in iframe, not markdown) */
  isHtml?: boolean;
}

export interface LoopsFile {
  lastScanned: string;
  loops: Loop[];
}

// Raw loop shape from disk, used only by the migration helper. Older
// loops.json files store a singular `timeblock` field; newer ones use
// `timeblocks` directly. Accept both and normalize on read.
type RawLoop = Omit<Loop, 'timeblocks'> & {
  timeblock?: Timeblock | null;
  timeblocks?: Timeblock[];
};

// Parse a legacy pLevel string into the flat priority + stakeholder
// split. "P1:Boss" → { priority: 'P1', stakeholder: 'Boss' }.
// "P1:self" → { priority: 'P1', stakeholder: 'Self' } (canonicalized).
// "P3" → { priority: 'P3', stakeholder: null }.
// "P4" → { priority: 'P3', stakeholder: null } (the flat model has no
// P4; demote P4 into P3 so nothing gets lost). Unknown → nulls.
export function parsePLevel(p: string | null | undefined): {
  priority: TriagePriority | null;
  stakeholder: string | null;
} {
  if (!p) return { priority: null, stakeholder: null };
  const colon = p.indexOf(':');
  const left = colon >= 0 ? p.slice(0, colon) : p;
  const right = colon >= 0 ? p.slice(colon + 1).trim() : '';
  let priority: TriagePriority | null = null;
  if (left === 'P0') priority = 'P0';
  else if (left === 'P1') priority = 'P1';
  else if (left === 'P2') priority = 'P2';
  else if (left === 'P3' || left === 'P4') priority = 'P3';
  const stakeholderRaw = right.length > 0 ? right : null;
  // Canonicalize "self" → "Self" for the stakeholder axis. All other
  // names round-trip as-is to preserve the audit trail.
  const stakeholder =
    stakeholderRaw &&
    (stakeholderRaw.toLowerCase() === 'self' ? 'Self' : stakeholderRaw);
  return { priority, stakeholder };
}

// Inverse of parsePLevel — rebuild a colon-embedded pLevel string from
// the new flat fields so legacy reads keep working. "self" is lower-
// cased on the way back so existing bucketing helpers (P1:self) match.
export function composePLevel(
  priority: TriagePriority | null | undefined,
  stakeholder: string | null | undefined,
): string | null {
  if (!priority) return null;
  if (!stakeholder || stakeholder === 'None') return priority;
  const tag = stakeholder === 'Self' ? 'self' : stakeholder;
  return `${priority}:${tag}`;
}

// Derive a status value for loops that predate the explicit status
// field. Used once at migration time and as a fallback at read time
// if the field is still absent (e.g. mid-write). Never overrides an
// existing status.
export function statusFromLegacy(l: {
  done?: boolean;
  blocked?: boolean;
  closedAs?: 'done' | 'dropped';
}): TriageStatus {
  if (l.done) {
    return l.closedAs === 'dropped' ? 'dropped' : 'completed';
  }
  if (l.blocked) return 'blocked';
  return 'active';
}

// Idempotent in-place migration: split pLevel → priority + stakeholder,
// backfill legacy_priority, derive status. Safe to run multiple times.
export function migrateLoopPriority(l: Loop): Loop {
  const next = { ...l };
  // legacy_priority is the idempotency flag. Once set we never
  // touch priority/stakeholder again (the user may have edited
  // them). For loops that never had a pLevel, set legacy_priority
  // to an empty string so we still mark them as migrated.
  if (next.legacy_priority === undefined || next.legacy_priority === null) {
    next.legacy_priority = next.pLevel ?? '';
    const { priority, stakeholder } = parsePLevel(next.pLevel);
    if (next.priority === undefined) next.priority = priority;
    if (next.stakeholder === undefined) next.stakeholder = stakeholder;
  }
  if (next.status === undefined) {
    next.status = statusFromLegacy(next);
  }
  return next;
}

// Normalize a loops.json payload from either the old singular-timeblock
// shape or the new timeblocks-array shape into the canonical in-memory
// form. Idempotent: running it on already-migrated data is a no-op.
export function migrateLoopsFile(raw: { lastScanned?: string; loops?: RawLoop[] }): LoopsFile {
  const loops: Loop[] = (raw.loops ?? []).map((l) => {
    const { timeblock, timeblocks, ...rest } = l;
    let next: Timeblock[];
    if (Array.isArray(timeblocks)) {
      next = timeblocks;
    } else if (timeblock) {
      next = [timeblock];
    } else {
      next = [];
    }
    const base: Loop = { ...rest, timeblocks: next, done: rest.done ?? false };
    return migrateLoopPriority(base);
  });
  return { lastScanned: raw.lastScanned ?? '', loops };
}

export interface CalendarEvent {
  id: string;
  title: string;
  startMinute: number;
  endMinute: number;
  // ISO date "YYYY-MM-DD" the event belongs to. Used by the week view
  // to place events in the correct day column.
  date: string;
}

export interface CalendarFile {
  // Start date of the loaded range (ISO). null if no calendar linked.
  date: string | null;
  events: CalendarEvent[];
  available: boolean;
}

export interface ContextFile {
  file: string;
  lines: string[];
  startLine: number;
  targetLineIndex: number;
  totalLines: number;
  available: boolean;
}

// Map your domains to emojis — customize to taste
export const DOMAIN_EMOJI: Record<string, string> = {
  personal: '❤️',
  work: '💼',
  project: '🌷',
};

// Tier ids stay 'now' | 'soon' | 'someday' so persisted state keeps
// working, but the display labels are reframed as a queue: Now → Next →
// Later. This nudges triage from "when might I do this" toward "what's
// the sequence."
export const TIER_META: Record<Tier, { label: string; dot: string; order: number }> = {
  now: { label: 'Now', dot: '🔴', order: 0 },
  soon: { label: 'Next', dot: '🟡', order: 1 },
  someday: { label: 'Later', dot: '🟢', order: 2 },
};

export function formatMinutes(m: number | null): string {
  if (m == null) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

export function formatTime(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

export function todayISO(): string {
  // Use local date parts so "today" matches the user's wall clock,
  // not UTC (which can roll over overnight and misplace events).
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns an array of 7 ISO dates for the full week (Monday to Sunday).
export function weekDates(reference: Date = new Date()): string[] {
  const ref = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const dow = ref.getDay(); // 0 = Sunday, 6 = Saturday
  const monday = new Date(ref);
  if (dow === 0) monday.setDate(ref.getDate() - 6);      // Sun → prev Mon
  else monday.setDate(ref.getDate() - (dow - 1));        // anchor to this Mon
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

// Short day label like "Sun 13" for column headers.
export function shortDayLabel(isoDate: string): { dow: string; dom: string } {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
  return { dow, dom: String(d) };
}
