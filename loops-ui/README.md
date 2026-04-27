# Loops UI

A thinking surface for the loose ends in your head — capture them, sort them, schedule them, look back at them — without ever leaving the keyboard.

Most task tools optimize for ticking boxes. This one optimizes for the moment before that: deciding what's worth a box at all, where it sits relative to everything else, and whether you've been spending your week on the things you said mattered. Everything you do here writes plain markdown to a folder on disk, so you own the data and nothing is locked in.

## What you do here

- **Focus** — one loop on the screen, everything else hidden. For when you've already decided what to work on.
- **Plan** — drag loops onto a Mon–Fri canvas; calendar events render as fixed blocks so your week routes around them.
- **Triage** — a card-by-card queue for new captures: accept, park for someday, drop, or snooze. Capacity caps stop the P1 bucket from quietly drifting past a ceiling.
- **Reflect** — a 30-day pressure heatmap, last-week triage stats, a pattern scan that surfaces repeating words across your loops, and an optional weekly stakeholder update draft.

## How it feels

Four keyboard moves cover the bulk of the day:

- `c` — Capture a thought into your triage inbox from anywhere. Stays open for chained capture; Esc to close.
- `⌘\` — Open the vault drawer. Browse files, search, create a new note in `00-Inbox/`, jump to today's daily note.
- `⌘K` — Search every loop by text, stakeholder, or tag.
- `⌘⇧A` — Adopt a loop with a structured form (text, priority, stakeholder, estimate).

Plus the obvious ones inside each mode: `j`/`k` to move between loops in Focus, `1`/`2`/`3` for triage decisions, `[`/`]` to collapse the Plan sidebar, `Esc` to back out of anything.

## Mental model

A loop moves through four states. The four modes are the surfaces for each.

```
capture → Triage (decide) → Backlog (commit) → Plan (schedule) → Focus (do)
              ↘ Someday (defer) / Done (drop)
```

- **Triage** answers *"what just landed and needs a decision?"* — only items with `status: 'triage'`. One card at a time; `1`/`2`/`3` move them out fast. Empty Triage is the goal state.
- **Backlog** answers *"what am I committed to but not working on right now?"* — your active working set. Loops only land here after you accept them in Triage (or mark them P0 to bypass).
- **Plan** is where Backlog items get pushed onto a calendar. Drag to schedule.
- **Focus** is *right now*: the active timeblock or the next one starting today.

Triage is the **gate**. Backlog is the **garden**. Focus is **right now**. Nothing skips ahead without a decision — that's the whole point.

## Getting started

You need Node 20+ and a folder you'd like to use as a vault. If you don't have one, the repo ships with `../vault-template/` and the dev server points at it by default.

```bash
npm install
```

Edit `loops.config.json` to name your primary stakeholder and set capacity caps (see [Configuration](#configuration) below). Then:

```bash
npm run dev
open http://localhost:3456
```

To point at your own vault instead of the bundled template:

```bash
export LOOPS_UI_VAULT_ROOT=/absolute/path/to/your/vault
```

If your vault has no `- [ ]` items yet, seed some examples so the UI has something to render:

```bash
npm run seed-loops
```

If it already has tasks, scan them in:

```bash
npm run refresh-loops
```

## On top of an Obsidian vault — but you don't need to open Obsidian

The app reads and writes plain markdown files in a folder structure that happens to be Obsidian-compatible. If you already use Obsidian, point this at the same folder and both surfaces stay in sync — edit a `- [ ]` in either place and the other picks it up.

But you don't need Obsidian. The vault drawer (`⌘\`) browses files, the editor handles `[[wikilinks]]` with autocomplete, the note reader resolves backlinks, and `c` captures straight to the triage inbox. The full edit-create-search-link loop runs without ever opening Obsidian, by design.

If you do want both surfaces, set `NEXT_PUBLIC_OBSIDIAN_VAULT` to your vault folder name and "Open in Obsidian" buttons appear in a few places.

## Vault layout

The scanner expects a domain-folder structure. Override via `loops.config.json → vault.scanFolders`.

```
00-Inbox/       capture bucket — `c` lands here; daily notes under 00-Inbox/Daily/
01-Creating/    projects and patterns
02-Thinking/    essays, ideas, references
03-Living/      personal
04-Relating/    people notes
06-Loops/       state files (required) — loops.json, calendar-today.json, logs
```

Only `06-Loops/` is required; it holds the index, event log, boundary log, daily checkpoints, and the calendar overlay. The rest is convention — flatter vaults work, just list whatever folders you want scanned.

## Configuration

`loops.config.json` is read at build time. Restart `npm run dev` after editing.

```jsonc
{
  "vault": {
    "scanFolders": ["00-Inbox", "01-Creating", "02-Thinking", "03-Living", "04-Relating"],
    "inboxFile": "00-Inbox/manual-loops.md",
    "adoptedFile": "00-Inbox/adopted.md",
    "closeOutsFile": "00-Inbox/close-outs.md"
  },
  "stakeholder": {
    "name": "Boss",            // display name on the weekly summary card
    "tag": "Boss",             // tag used in pLevel strings: "P1:Boss"
    "capacityMax": 8,          // hard cap on active P1:Boss loops
    "weeklySummary": true,     // render the StakeholderUpdateCard in Reflect
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

`stakeholder` is the primary human you answer to — manager, collaborator, investor. The app filters `P1:<tag>` loops into a separate capacity bucket and renders an optional weekly summary draft. `self` is a second bucket for "things only you care about protecting." Keep its cap low; its job is to stop you from filling your own queue. `scannerStakeholders` lets the scanner detect extra names in task text and tag them as `P3:<Name>`.

For calendar overlay, write events to `06-Loops/calendar-today.json`; the canvas polls it every 10s. Schema and example sync scripts (Google Calendar via cron, etc.) live in `vault-template/06-Loops/README.md`.

## Commands reference

| Script | What it does |
|---|---|
| `npm run dev` | Start the app on port 3456 |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run seed-loops` | Write a small example set into `06-Loops/loops.json` |
| `npm run refresh-loops` | Scan the vault for `- [ ]` items and rebuild the index |
| `npm run refresh-loops:dry` | Preview the scan without writing |
| `npm run notes-index` | Rebuild the notes index used for backlinks and search |

See [`AGENTS.md`](./AGENTS.md) if you're working on this with an AI coding agent — Next 16 has breaking changes from older versions.

## License

MIT.
