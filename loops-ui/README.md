# Loops UI

A thinking surface for the loose ends in your head — capture them, sort them, schedule them, look back at them — without ever leaving the keyboard.

Most task tools optimize for ticking boxes. This one optimizes for the moment before that: deciding what's worth a box at all, where it sits relative to everything else, and whether you've been spending your week on the things you said mattered. Everything you do here writes plain markdown to a folder on disk, so you own the data and nothing is locked in.

> **New here?** Read the [complete guide](https://annamarie-kelly.github.io/loops-os/) for the full tour, or skip to the [install](#quick-start) below. Questions live in [Discussions](https://github.com/annamarie-kelly/loops-os/discussions); bugs in [Issues](https://github.com/annamarie-kelly/loops-os/issues).

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

## Quick start

You need **Node 20+**. Everything else is optional.

```bash
curl -fsSL https://raw.githubusercontent.com/annamarie-kelly/loops-os/main/install.sh | bash
```

The script is short and readable — [review it on GitHub](https://github.com/annamarie-kelly/loops-os/blob/main/install.sh) before piping if you're cautious. It checks your platform, Node version, and git, clones the repo to `~/loops-os` (override with `LOOPS_OS_DIR=/path`), then hands off to `npm run start`.

That handoff runs preflight checks (Node version, port 3456, Claude Code CLI, Obsidian), installs deps, offers to seed the bundled vault with example loops, starts the dev server, and opens the browser. Ctrl-C to stop.

**Windows users:** the installer doesn't support Windows yet — use the manual path below.

### Or, manually

```bash
git clone https://github.com/annamarie-kelly/loops-os.git
cd loops-os/loops-ui
npm run start
```

If you have Claude Code installed, you can also run the `/start` slash command from inside Claude Code at the repo root for a guided walkthrough.

### What you'll see on first run

The bundled `vault-template/` ships as the default vault — `LOOPS_UI_VAULT_ROOT` points at it out of the box, so the app boots with seeded demo loops and you can click through Triage, Plan, and Focus immediately. When you're ready to bring your own:

```bash
export LOOPS_UI_VAULT_ROOT=/absolute/path/to/your/vault
```

See [`.env.example`](./.env.example) for every recognized environment variable. All optional.

### The Chrome capture extension

Capture from any browser tab into your triage inbox with `⌘⇧L`:

1. Open `chrome://extensions` → enable Developer mode
2. **Load unpacked** → point at `loops-ui/tools/loops-capture-extension/`
3. Pin the icon. Press `⌘⇧L` from any page.

The extension talks only to localhost. No external endpoints.

### Pointing at an existing vault

If you already have a folder with `- [ ]` items in it:

```bash
npm run refresh-loops    # scan existing tasks into 06-Loops/loops.json
```

If your vault is empty, seed examples so the UI has something to render:

```bash
npm run seed-loops
```

Edit [`loops.config.json`](./loops.config.json) to name your primary stakeholder and set capacity caps (see [Configuration](#configuration) below).

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
