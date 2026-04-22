# AGENTS.md

This file is read by two audiences:

1. **Engineers** skimming the code to understand how it's built. Sections 1–5 are the architecture deep-dive the top-level README stays out of.
2. **AI agents** (Claude Code, or any LLM helping a user adopt this system) walking a new user through setup. Section 6 is the onboarding script — what to ask, what to save, what to skip.

---

## 1. Architecture in one page

```
                            ┌──────────────────────────┐
  user typing in            │   vault (any directory)  │
  Obsidian / terminal       │                          │
          │                 │   00-Inbox/              │
          ▼                 │   01-Building/           │
    ┌──────────┐  scans ──▶│   …                      │
    │ refresh- │           │   06-Loops/loops.json    │
    │ loops.mjs│  writes ──│   ← source of truth      │
    └──────────┘           └────────────┬─────────────┘
                                        │ reads/writes
                                        ▼
          ┌─────────────────────────────────────────────┐
          │             Next.js app (loops-ui/)          │
          │                                              │
          │   Triage mode    Plan mode    Focus mode     │
          │                                              │
          │   All mutations → applyEventToDisk →         │
          │     gates (capacity, triage, close-out) →    │
          │       atomic file write + audit log          │
          └─────────────────────────────────────────────┘
```

Three architectural commitments:

- **Markdown is the source of truth.** The UI's job is to make the ledger tractable, not to own it. Close a loop in the UI → the `- [ ]` in the underlying markdown file flips to `- [x]`.
- **Every mutation is an event.** The web API, the CLI scripts, and any future agent go through the same `applyEventToDisk` entry point. Gates run exactly once; audit trail is free.
- **Configuration over code.** The primary stakeholder, capacity thresholds, scan folders, and subgroup hints live in `loops-ui/loops.config.json`. No code edits to retarget.

---

## 2. The planning algorithm

Lives in [`loops-ui/lib/schedule.ts`](./loops-ui/lib/schedule.ts). Pure functions; testable without a React tree.

When a user drags a loop onto a day on the week canvas, `splitAroundConflicts(date, startMinute, durationMinutes, events, loops, skipLoopId)` figures out where the timeblock actually goes. Three phases:

### Phase 1 — Busy interval construction
`busyIntervals(...)` collects all competing time on the target day:
- Every calendar event on that date (read from `06-Loops/calendar-today.json`).
- Every existing timeblock on any other loop on that date.
- Merges overlaps via `mergeIntervals(...)` so the free-space computation doesn't straddle an overlap.

The dropped loop is excluded from its own busy set via `skipLoopId` so moving an existing block doesn't see itself as a conflict.

### Phase 2 — Quick path for uncluttered days
Before doing interval math, check if the naive placement (`[startMinute, startMinute + durationMinutes]`) fits without overlapping anything. If yes, emit one block at exactly that position. This preserves the "drag drops where I pointed" feel in the common uncluttered case.

### Phase 3 — Free interval subtraction + greedy fill
If there's a conflict, `freeIntervals(windowStart, windowEnd, busy)` subtracts busy from `[windowStart, DAY_END_MIN]` and returns chronologically ordered free gaps large enough to be useful (≥ `SLOT_MIN` = 15 min).

Then walk the free intervals in order and greedily carve off chunks until `durationMinutes` is placed. A 90-minute task dropped on a day with two meetings might emit two timeblocks of `[9:00–10:00, 11:30–12:00]` that sum to 90 minutes — the app tolerates split blocks so users can schedule across fragmented days.

Falls back to a single block at the drop point if the day is so packed no chunk ≥ 15min fits. The UI renders this case as an obvious overcommit so the user sees it.

---

## 3. Priority inference

Lives in [`loops-ui/scripts/refresh-loops.mjs`](./loops-ui/scripts/refresh-loops.mjs) (`inferTier` + `inferPLevel`). Deterministic keyword-based, not LLM-based — runs in milliseconds on every scan.

**Tier** (🔴 Now / 🟡 Soon / 🟢 Someday) is derived from task text + file metadata:

| Signal | Outcome |
|---|---|
| `@waiting` | 🟢 someday |
| `pressing`, `urgent`, `blocking`, `blocker`, `today`, `tomorrow`, `asap`, `overdue`, `eod`, `by friday`, `by monday` | 🔴 now |
| `someday`, `eventually`, `brainstorm`, `phase 3`, `explore`, `maybe`, `nice to have` | 🟢 someday |
| File is in `00-Inbox/` and <3 days old | 🟡 soon |
| File untouched >14 days | 🟢 someday |
| Default | 🟡 soon |

Tier is **time-aware**: "due Thursday" on a Wednesday fires the `tomorrow` signal and lands in 🔴. On a Monday it falls through to the default (🟡). No explicit date parsing — the keyword list is intentionally shallow because the user can always override via the triage gate.

**pLevel** follows the same pattern but deliberately conservative:

- `error`, `broken`, `down`, `incident`, `production is broken`, `p0` → `P0`
- Stakeholder keyword match (from `loops.config.json → stakeholder` + `scannerStakeholders`) → `P3:<Name>`
- Default → `P3`

The scanner **never assigns P1**. P1 is reserved for loops the user explicitly accepts through the triage gate. This prevents the bucket-inflation failure mode where every mention of a colleague auto-becomes a P1.

---

## 4. The write layer — event sourcing with gates

Lives in [`loops-ui/lib/tend-events.ts`](./loops-ui/lib/tend-events.ts). Every state-mutating operation — create, accept, priority change, schedule, close, drop, snooze, log checkpoint, log boundary — flows through `applyEventToDisk(event, actor)`.

### Event kinds

```ts
| 'create_loop'       | 'accept_loop'        | 'update_priority'
| 'update_stakeholder'| 'update_status'      | 'add_note'
| 'schedule_block'    | 'clear_block'
| 'close_loop'        | 'drop_loop'          | 'snooze_loop'
| 'log_checkpoint'    | 'log_boundary'       | 'scan_detected_loop'
```

Each has a typed payload. The handler for each kind is a pure function: `(state, payload) → state' | GateResult`.

### The pipeline

1. **Acquire file lock** (`withLock`) — prevents concurrent writes from the web API and CLI stepping on each other.
2. **Read current state** from `06-Loops/loops.json` (with migration to the current schema).
3. **Route to handler** — dispatches by `event.kind`.
4. **Gate check** — the handler calls gate functions (`checkCapacityGate`, `checkCloseOutGate`) before mutating. Gates return `{ok: true}` or `{ok: false, reason, suggestion, context}`. If not-ok, the event is not applied and the gated result bubbles back to the caller.
5. **Mutate + stamp** — on gate pass, the handler returns the new loops array. The pipeline stamps `updatedAt`, assigns a ULID, and builds an `AuditEntry`.
6. **Write atomically** (tmp + rename) to `06-Loops/loops.json`.
7. **Append to audit log** (`06-Loops/events.log.jsonl`) — one JSON line per event. Debuggable with `tail -f`.

The API route, the CLI scripts (`refresh-loops.mjs`, `tend-event.mjs`), and the in-UI action handlers all call the same pipeline. Gates fire exactly once per mutation; audit entries are never dropped; replay is trivial (concatenate the events log).

---

## 5. The stakeholder / capacity model

Three coupled pieces, all driven by [`loops-ui/loops.config.json`](./loops-ui/loops.config.json).

### Primary stakeholder

```json
"stakeholder": {
  "name": "Boss",        // display name shown in the UI
  "tag": "Boss",         // used in pLevel strings: "P1:Boss"
  "capacityMax": 8,      // hard cap on active P1:<tag> loops
  "weeklySummary": true, // show the StakeholderUpdateCard in Reflect mode
  "staleDays": 5         // P1:<tag> loops untouched this long get flagged
}
```

The stakeholder is the person whose asks get their own P1 capacity bucket and weekly summary draft. Typically a manager, primary collaborator, or investor. There's exactly one. Set `weeklySummary: false` to hide the summary card entirely if the concept doesn't apply.

### Self bucket

```json
"self": { "capacityMax": 5 }
```

`P1:self` is the parallel bucket for things only you care about protecting this week. Keep the cap low — its job is to stop you from filling your own queue faster than you can clear it.

### Flat caps

```json
"priorityCaps": { "P1Flat": 8, "P2Flat": 20 }
```

Absolute caps across all stakeholders combined. P1 ≤ 8 total regardless of whose bucket; P2 ≤ 20 total. Fires from the triage-gate accept flow.

### The three coupled behaviors

1. **Capacity gate fires** when a create or promotion would push any bucket past its ceiling. Blocks the write; user must type ≥10 chars of override reason or drop something first. Every override lands in `boundary_log.json` with a timestamp and reason.
2. **Weekly summary draft** compiles Completed / Started / Blocked / Flags for P1:`<tag>` loops over the last 7 days. Lives in the Reflect view; copyable as plain text for email.
3. **Stale flags** highlight P1:`<tag>` loops that haven't had an `updatedAt` bump in `staleDays` days. Visual reminder the stakeholder's work is quietly aging.

### Scanner keywords

```json
"scannerStakeholders": [
  { "keyword": "alice", "name": "Alice" }
]
```

Secondary names the vault scanner should detect in task text and tag as `P3:<Name>` so the backlog groups by person. The primary stakeholder's `tag` is always detected too. These are pure display groupings — no capacity gates.

---

## 6. Onboarding script (for AI agents)

When an agent (Claude Code via `/start`, or any LLM helping a user adopt loops-os) walks a new user through setup, these are the questions to ask and what to save.

### Before asking anything: save what you already know

If the user has an existing vault, scan it first to infer:
- What folder structure they use (do they already have `00-Inbox`, or something else?)
- What notes mention their stakeholders (grep `05-Relating/` or equivalent)
- Whether they have calendar / email / task-tracker MCPs configured

Skip questions where you already have a confident answer. Confirm rather than ask.

### Questions, in order

**1. Primary stakeholder.** The single load-bearing question — everything else flows from it.

> "Who do you answer to most directly? This could be a manager, a primary collaborator, an investor you report to, a co-founder. I'll make them the primary stakeholder in your config, which means their asks get a dedicated P1 capacity bucket (max 8 active at a time) and a weekly summary draft."

Follow-ups:
- If the user says "nobody" or "I don't have one": set `stakeholder.weeklySummary: false` and use `self` as the main bucket. Don't press.
- If the user names a person: save `stakeholder.name` = their display name (e.g. "Dave"), `stakeholder.tag` = same or a no-spaces version (e.g. "Dave"). These should almost always match.
- Default `capacityMax: 8` unless the user says they're senior / under heavier load (try 10) or junior / exploratory (try 5).

Save to memory: `project_stakeholder` → name, relationship, why they matter.

**2. Typical day structure.** Sets calendar defaults.

> "What hours do you work? When do you most want to do deep work?"

Default: 8am–7pm work window, deep work in the morning. Update `loops-ui/lib/ui.ts` `DAY_START_MIN` / `DAY_END_MIN` if the user's window is materially different. (Rare.)

**3. MCP sources.** Gates the `/inbox` flow.

> "Do you use any tools I should pull from for your daily inbox? Calendar, email, task tracker, meeting transcripts — whatever has stuff you commit to but might forget."

For each source the user names, confirm the MCP server is installed (check `claude mcp list`). If they mention something without an MCP yet, note it as a follow-up but don't block on it.

Save to memory: `reference_mcp_sources` → which MCPs and what they pull.

**4. Other people who come up a lot.** Populates `scannerStakeholders`.

> "Besides your primary stakeholder, which 3–5 names come up in your notes and tasks most often? Direct reports, close collaborators, external contacts whose requests you track."

For each, add to `scannerStakeholders` with the lowercase first name as `keyword` and capitalized as `name`. Keep the list short — every keyword match costs a regex pass on every scanner run.

Save to memory: `reference_collaborators` → list of names + brief relationship notes.

**5. Capacity self-read.** Sets `self.capacityMax`.

> "How many personal-priority items can you actually make progress on in parallel? Not 'wish I could' — 'actually do.'"

Default 5 if unsure. Sub-3 if user sounds overcommitted already; they need a tighter cap to protect themselves.

Save to memory: `feedback_capacity` → the number + one line of context on why.

### What to skip on first setup

- Subgroup hints (`subgroupHints` in config) — the defaults are fine for most users; they can customize later if they notice the work-mode classifier miscategorizing their tasks.
- Shelf-life defaults — explained in `vault-template/CLAUDE.md`; most users never touch this.
- The two-axis memory model — powerful but a lot to explain upfront. Let them discover it through `/distill` output rather than front-loading.
- The graph system — doesn't exist (removed as scaffolding). Don't offer.

### What to save to memory (summary)

After a successful `/start` run, the agent should have saved:

- `project_loops_os` — that this user runs loops-os, where their vault lives, what's in their `loops.config.json`
- `project_stakeholder` — primary stakeholder name + relationship + why they matter
- `reference_collaborators` — scanner stakeholder list with one-line relationship notes each
- `reference_mcp_sources` — which calendar / email / task tracker / transcript MCPs are wired
- `feedback_capacity` — self-reported parallel-work capacity
- `user_profile` (append to existing) — that the user is adopting loops-os as their planning layer, not just an ad-hoc todo app

### What to ask *after* the first session, not during

Defer until the user has used the app for a week:

- Whether the priority inference is miscategorizing things (if so, they can edit the keyword lists in `refresh-loops.mjs`)
- Whether the capacity caps are right (raise or lower `capacityMax` based on how often the gate fires vs. feels protective)
- Whether to customize the stakeholder weekly summary format (the draft generator in `lib/tend-stakeholder-draft.ts`)
- Whether to expand the vault-template folder structure for their domains

Onboarding should be fast and usable. Depth comes from iteration, not from the first question.

---

## 7. Where to look when something breaks

| Symptom | First place to look |
|---|---|
| API route 500s | `06-Loops/events.log.jsonl` tail — every mutation is logged |
| UI shows stale data | `06-Loops/.loops.lock` — stale lock from a crashed process blocks writes |
| Capacity gate never fires | Check `loops.config.json` — `stakeholder.tag` must match the `:<tag>` in pLevels |
| Scheduling puts blocks in wrong places | `lib/schedule.ts:busyIntervals` — calendar events not in `calendar-today.json` don't exist to the algorithm |
| `- [ ]` in a note not picked up | `scripts/refresh-loops.mjs:SCAN_DIRS` — the folder must be listed |
| Weekly summary is empty | `lib/loops-windowing.ts` — the 7-day window needs `doneAt` timestamps on loops |

The events log is the single richest debugging source. `tail -f 06-Loops/events.log.jsonl | jq` gives a live view of every mutation with its actor, kind, payload, and gate result.
