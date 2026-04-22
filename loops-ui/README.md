# Loops UI

A local-first planning surface for your Obsidian vault. Scans every `- [ ]` open item across your notes, groups them by domain and priority, lets you triage / time-block / review — all while keeping Markdown as the source of truth.

Built to live inside a vault (this repo is one), but it will happily point at any vault you like.

## What it does

- **Scan your vault** for every unchecked `- [ ]` item and index it as a "loop."
- **Triage gate** — new loops land in a queue; you accept, park, snooze, or drop. Capacity caps keep the P1 bucket from drifting past a ceiling.
- **Plan mode** — drag loops onto a weekday canvas; timeblocks schedule around calendar events pulled from `06-Loops/calendar-today.json`.
- **Focus mode** — one loop at a time with keyboard nav.
- **Reflect mode** — 30-day pressure heatmap, weekly pattern scan, stakeholder weekly summary draft.
- **Round-trip with markdown** — the UI reads `- [ ]` from your notes and writes `- [x]` back when you close a loop. Edit in Obsidian; refresh the scanner; the UI picks up the change.

The app is plain file I/O: no database, no external auth, no analytics. Everything lives under `06-Loops/` in your vault.

## Setup

### Prerequisites

- Node 20+
- An Obsidian vault (or any directory with the expected folder layout — see below)

### 1. Install

```bash
cd loops-ui
npm install
```

### 2. Configure

Open [`loops.config.json`](./loops.config.json) and edit:

```jsonc
{
  "stakeholder": {
    "name": "Boss",            // display name: "Boss update — draft"
    "tag": "Boss",             // tag used in pLevel strings: "P1:Boss"
    "capacityMax": 8,          // hard cap on active P1:Boss loops
    "weeklySummary": true,     // show the StakeholderUpdateCard in Reflect
    "staleDays": 5             // flag P1:Boss loops untouched this long
  },
  "self": {
    "capacityMax": 5           // hard cap on active P1:self loops
  },
  "priorityCaps": {
    "P1Flat": 8,               // triage-gate total-P1 cap (any stakeholder)
    "P2Flat": 20
  },
  "scannerStakeholders": [
    { "keyword": "alice", "name": "Alice" },
    { "keyword": "bob",   "name": "Bob" }
  ]
}
```

**What each knob does:**

- `stakeholder` — the primary human you answer to (manager, collaborator, investor). The app filters `P1:<tag>` loops into a separate capacity bucket, and renders a weekly summary card for them. Set `weeklySummary: false` to hide the card entirely.
- `self` — `P1:self` is a second bucket for "things only you care about protecting this week." Keep the cap low; its job is to block you from filling your own queue.
- `scannerStakeholders` — extra names the vault scanner should detect in task text and tag as `P3:<Name>`. Useful if you have a small roster of collaborators whose asks should auto-group in the backlog. The primary `stakeholder.tag` is always detected too.

### 3. Point at your vault

The app defaults to the sibling `../vault-template/` directory — the
scaffolding that ships with this repo — so `npm run dev` works
out-of-the-box on a fresh clone. Point it at your own vault once
you're ready for real data:

```bash
export LOOPS_UI_VAULT_ROOT=/absolute/path/to/your/vault
```

To make "open in Obsidian" links work, set:

```bash
export NEXT_PUBLIC_OBSIDIAN_VAULT=your-vault-folder-name
```

### 4. Seed or scan

```bash
# First time — write a small set of example loops so the UI has something to render:
node scripts/seed-loops.mjs

# Or, if your vault already has `- [ ]` items, scan it:
npm run refresh-loops
```

### 5. Run

```bash
npm run dev
open http://localhost:3456
```

## First session: a 10-minute tour

After `npm run dev`, open `http://localhost:3456`. You'll land in **Focus mode** with the seeded example loops already indexed. Here's the recommended first pass.

The top header has four mode tabs: **Focus · Triage · Plan · Reflect**. Each is a different lens on the same `06-Loops/loops.json`. Click to switch. There's also a hidden **Backlog** and **Someday** toggle on the header's right side.

### 1. Triage (2–3 min)

Click **Triage**. You'll see a card-by-card queue: each loop shows its text, an AI-seeded priority guess, and four decision buttons.

| Key | Action |
|---|---|
| `1` | Accept — promote from triage to active, at the suggested priority |
| `2` | Someday — park without dropping |
| `3` | Drop — archive with no further surfacing |
| `H` | Snooze until a date |
| `S` | Change stakeholder before accepting |
| `D` | Open the detail drawer |
| `Z` | Undo the last decision |
| `space` | Skip (move to next without deciding) |
| `↑` / `↓` | Cycle the suggested priority before accepting |
| `M` | Switch to a grouped list view (instead of card-at-a-time) |

Walk through the ~10 seeded loops; the queue empties when you're done. You'll end with a set of "accepted" loops that show up in the other modes.

### 2. Plan (3–5 min)

Click **Plan**. The left sidebar lists your accepted loops; the main canvas is Monday–Friday with 15-minute rows.

- **Drag a loop** onto a day to create a timeblock. The calendar-today.json events render as greyed-out fixed blocks — your loops route around them.
- **Drag an existing timeblock** to resize or move it.
- Keys:
  - `[` collapse sidebar, `]` expand
  - `⌘K` / `Ctrl+K` open global search
  - `⌘⇧A` / `Ctrl+Shift+A` adopt a new loop (manual capture)
  - `⌘⇧B` / `Ctrl+Shift+B` open the boundary log (audit trail of capacity overrides)

Timeblock sum appears per-day so you can spot overcommitment at a glance.

### 3. Focus (whenever)

Click **Focus**. Pick one loop from the two-step picker. The loop fills the canvas and everything else disappears.

- `j` / `k` — next / previous loop (vim-style)
- `space` — close (mark done) the focused loop
- `1` — pin the focused loop into this week's Now
- `2` / `3` — unpin (fall back to priority-derived tier)
- `w` — toggle "pinned to this week" on the focused loop
- `x` — toggle selection (for bulk actions with `space` / `1` / `2` / `3`)
- `Esc` — clear selection or close detail drawer

Focus mode is for when you've already decided what to work on and want the rest to go away.

### 4. Reflect (Fridays or month-end)

Click **Reflect**. Four panels stack top-to-bottom:

- **Pressure heatmap** — 30-day grid coloured by your daily checkpoint "pressure" read (chose / reactive / task-monkey / empty). Click a day to drill in.
- **Triage stats** — last-7-day totals: how many you accepted vs. someday'd vs. dropped, plus AI match rate.
- **Weekly pattern scan** — run a scan button that surfaces repeating words in your loops (e.g. you keep seeing "audit" — maybe there's a parent project hiding).
- **Stakeholder update draft** — a plain-text weekly summary (Completed / Started / Blocked / Flags) you can copy into an email. Only shown if `stakeholder.weeklySummary: true` in `loops.config.json`.

### Where things land on disk

Every mutation you make in the UI writes back to `06-Loops/` in real time:

- Accepting / dropping / closing a loop updates `loops.json` and flips the `- [ ]` checkbox in the source markdown file.
- A capacity override writes an entry to `boundary_log.json` (visible via `⌘⇧B`).
- A daily checkpoint writes to `tend-export.json`.
- A refresh of the stakeholder summary writes to `stakeholder-window.json`.

Close the browser and everything is in your vault. Re-open it and the state is still there. No database, no login.

## Connecting a calendar

The week canvas reads `06-Loops/calendar-today.json` and overlays the events as fixed blocks. The file format is (see [`../vault-template/06-Loops/README.md`](../vault-template/06-Loops/README.md) for full schema):

```json
{
  "lastSynced": "2026-04-22T08:00:00Z",
  "events": [
    { "id": "e-001", "date": "2026-04-22", "title": "Team standup",  "startMinute": 540, "endMinute": 570 },
    { "id": "e-002", "date": "2026-04-22", "title": "1:1 with Alex", "startMinute": 900, "endMinute": 930 }
  ]
}
```

`startMinute` / `endMinute` are minutes-from-midnight in local time (540 = 9:00 am). The app is **read-only** against this file; you write it however you like.

### Option A — Hand-maintain

Good for a first week. Edit `06-Loops/calendar-today.json` in your editor whenever your schedule changes. Takes 30 seconds and teaches you the shape.

### Option B — Google Calendar via a small cron

If your calendar lives in Google, a ~50-line script pulls events and writes the file. Minimal working example:

```js
// loops-ui/scripts/sync-gcal.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT;
const OUT = path.join(VAULT_ROOT, '06-Loops/calendar-today.json');

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GCAL_SERVICE_ACCOUNT_JSON,
  scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
});
const calendar = google.calendar({ version: 'v3', auth });

const now = new Date();
const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

const { data } = await calendar.events.list({
  calendarId: 'primary',
  timeMin: now.toISOString(),
  timeMax: weekEnd.toISOString(),
  singleEvents: true,
  orderBy: 'startTime',
});

const events = (data.items ?? [])
  .filter((e) => e.start?.dateTime) // skip all-day events
  .map((e) => {
    const start = new Date(e.start.dateTime);
    const end = new Date(e.end.dateTime);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return {
      id: e.id,
      date,
      title: e.summary ?? '(untitled)',
      startMinute: start.getHours() * 60 + start.getMinutes(),
      endMinute: end.getHours() * 60 + end.getMinutes(),
    };
  });

await fs.writeFile(
  OUT,
  JSON.stringify({ lastSynced: new Date().toISOString(), events }, null, 2),
);
console.log(`Wrote ${events.length} events to ${OUT}`);
```

Install deps (`npm i googleapis` inside `loops-ui/`), set up a [Google Cloud service account](https://developers.google.com/workspace/guides/create-credentials#service-account) with read-only calendar scope, export `GCAL_SERVICE_ACCOUNT_JSON` and `LOOPS_UI_VAULT_ROOT`, then run on a cron:

```bash
*/15 * * * * /usr/local/bin/node /path/to/loops-ui/scripts/sync-gcal.mjs
```

The UI polls `calendar-today.json` every 10 seconds while visible, so your canvas updates within a minute of the cron running.

### Option C — Anything else

Slack status, Fantastical export, a MCP tool you write inside a Claude skill, a shell one-liner against `icalBuddy` on macOS — it all works the same way. Write valid JSON to `06-Loops/calendar-today.json` and the canvas picks it up.

## How it talks to the vault

The app is **file-based**. It reads and writes under your vault's `06-Loops/` directory:

| File | Read | Write |
|---|:---:|:---:|
| `06-Loops/loops.json` | yes | yes |
| `06-Loops/events.log.jsonl` | yes | append |
| `06-Loops/boundary_log.json` | yes | yes |
| `06-Loops/tend-export.json` | yes | yes |
| `06-Loops/stakeholder-window.json` | no | yes |
| `06-Loops/calendar-today.json` | yes | no |
| `00-Inbox/manual-loops.md` | no | append (manual loop creation) |
| any `*.md` in scan folders | yes | yes (flips `- [ ]` ↔ `- [x]`) |

There is **no MCP client, no API key, no external service call**. If you want calendar integration or email / Slack nudges, write `06-Loops/calendar-today.json` yourself — from a cron pulling Google Calendar, a Claude skill, an MCP server, or whatever fits your setup. See [`06-Loops/README.md`](../vault-template/06-Loops/README.md) for the calendar schema.

## Vault layout assumptions

The scanner expects a domain-folder vault structure (override via `loops.config.json → vault.scanFolders`):

```
00-Inbox/       capture bucket — manual loops land in 00-Inbox/manual-loops.md
01-Building/    projects and patterns
02-Thinking/    essays, ideas, references
03-Working/     operations, stakeholders
04-Living/      personal
05-Relating/    people notes
06-Loops/       loops data dir (required)
```

If your vault is flatter, add whichever folders you want scanned to the config.

## Troubleshooting

**"loops.json not found" on startup** — run `node scripts/seed-loops.mjs` or `npm run refresh-loops`.

**Calendar column is empty** — the app reads `06-Loops/calendar-today.json`. It's optional; create it to enable the week canvas calendar overlay.

**My stakeholder's name shows as "Stakeholder"** — edit `loops.config.json` and restart `npm run dev`. JSON config is imported at build time.

**The capacity gate never fires** — check that your loops' `pLevel` values match the configured tag (e.g. `P1:Boss` if `stakeholder.tag` is `"Boss"`). Old loops from a different stakeholder name won't trip the gate until re-tagged.

## Architecture

- **Next.js 16** (app router) on the server; React 19 on the client.
- **Tailwind v4** for styles; CSS custom properties for light/dark theming.
- **dnd-kit** for drag-drop on the week canvas.
- Zero external services. `/api/*` routes are thin wrappers around file I/O.

See [`AGENTS.md`](./AGENTS.md) if you're working on this with an AI coding agent — Next 16 has breaking changes from older versions.

## License

MIT.
