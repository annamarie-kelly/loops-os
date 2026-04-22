# loops-os

**A local-first AI planner for Obsidian vaults.** Scans every `- [ ]` across your notes, infers priority from natural language, and lays out a week canvas that routes around your calendar — all while keeping the source of truth in markdown. No database, no cloud, no vendor.

---

## What it does

- **Reads your whole vault.** Every unchecked `- [ ]` in any markdown file becomes a loop the system tracks.
- **Infers priority from how you wrote it.** "Due Thursday" on a Wednesday is urgent. "Blocking" escalates. "@waiting" de-escalates. No tags, no labels.
- **Schedules your week.** Drag a loop onto Tuesday; the system carves a timeblock that routes around the calendar events already on that day. Overcommit is flagged.
- **Protects your attention.** Capacity gates block you from queueing a ninth P1 before you drop one. Configurable ceilings for your primary stakeholder (default 8) and your own priorities (default 5).
- **Round-trips through markdown.** Close a loop in the app → the source markdown file's `- [ ]` flips to `- [x]`. Edit in Obsidian → the scanner picks up the change. Neither side is authoritative over the other; both point at the same files.
- **Four focused modes.** Triage a new-loop queue card-by-card. Plan the week on a drag-drop canvas. Focus on one loop at a time, vim-style. Reflect on a 30-day pressure heatmap with a weekly stakeholder summary draft.

---

## Quickstart

The fastest path from a fresh clone:

```bash
git clone git@github.com:annamarie-kelly/loops-os.git
cd loops-os
claude                  # open Claude Code in this directory
/start                  # one-command onboarding
```

`/start` installs dependencies, seeds example loops, spins up the dev server, opens the browser, and offers to pull your inbox from any MCP sources you have wired. See [`.claude/commands/start.md`](./.claude/commands/start.md) for the exact sequence.

**Manual path** — if you'd rather run the steps yourself:

```bash
cd loops-ui
npm install
node scripts/seed-loops.mjs
npm run dev                    # opens on http://localhost:3000
```

Full setup walkthrough, first-session tour, and calendar-integration examples in [`loops-ui/README.md`](./loops-ui/README.md).

---

## Repo shape

```
loops-os/
├── loops-ui/                 The Next.js 16 + React 19 app.
│   ├── app/                  Routes (one page + 8 API endpoints)
│   ├── components/           30 components, four-mode dashboard
│   ├── lib/                  Pure TypeScript — types, config, gates,
│   │                         events, scheduling, fuzzy-match
│   └── scripts/              Vault scanners + CLI
├── vault-template/           The vault scaffolding loops-os was built
│   │                         around. Copy into your own Obsidian vault,
│   │                         point the app at it, or use as the demo.
│   ├── 00-Inbox/ … 07-Archive/
│   ├── Templates/
│   ├── .claude/commands/     11 vault-level slash commands
│   └── CLAUDE.md             Two-axis memory model + vault conventions
├── .claude/commands/start.md Repo-level /start command
├── README.md                 This file
└── AGENTS.md                 Architecture deep-dive + agent onboarding script
```

Three decoupled parts:

- **`loops-ui/`** — the app. Pure file I/O, no database, no auth. Points at any directory matching the schema via `LOOPS_UI_VAULT_ROOT`.
- **`vault-template/`** — the conventions + slash commands. Optional if you already have an Obsidian vault you want to use.
- **`06-Loops/loops.json`** — the contract between them. Any scanner producing this shape can feed the app.

For the architecture deep-dive — the planning algorithm, the event-sourced write layer, the stakeholder/capacity model, the priority-inference heuristics — see **[AGENTS.md](./AGENTS.md)**. It's also the guide for AI agents walking a new user through onboarding.

---

## The vault template

`vault-template/` ships a **two-axis memory model** for notes. Every note picks:

- A **domain** (folder): `01-Building`, `02-Thinking`, `03-Working`, `04-Living`, `05-Relating`.
- A **memory type** (`type:` frontmatter): episodic (`episode`), semantic (`pattern` / `decision` / `failure` / `convention` / `essay` / `reference`), or procedural (`playbook`).

One folder per note + one memory type = cross-axis retrieval. "Show me every failure across building and working." "Find all playbooks." "What episodes produced this pattern." A one-field change per note that unlocks compound knowledge retrieval.

Eleven slash commands come with the template:

| Command | What it does |
|---|---|
| `/setup` | Interactive walkthrough to customize the vault to your role and tools |
| `/inbox` | Pull external context (calendar, CRM, task board) via MCP into the inbox |
| `/triage` | Route inbox notes to the right domain + memory type |
| `/distill` | Classify raw input by memory type and create properly-typed notes |
| `/loops` | Terminal snapshot of every open `- [ ]`, priority-sorted |
| `/commitments` | Relationship view: what you owe people, what they owe you |
| `/find-connections` | Surface orphaned notes, suggest missing `[[wikilinks]]` |
| `/conductor` | Scan git worktrees for in-progress work |
| `/reindex` | Regenerate per-folder `_patterns.md` / `_episodes.md` / `_playbooks.md` |
| `/prune` | Archive notes whose `shelf-life` has expired |
| `/review` | Weekly metacognition — what changed, what's emerging, what's orphaned |

See [`vault-template/CLAUDE.md`](./vault-template/CLAUDE.md) for the full vault conventions and [`vault-template/README.md`](./vault-template/README.md) for three ways to adopt the template (copy in, point at your own, demo as-is).

---

## Point at your own vault

Already have an Obsidian vault?

```bash
export LOOPS_UI_VAULT_ROOT=/absolute/path/to/your/vault
cd loops-ui && npm run dev
```

The only hard requirement is a `06-Loops/` directory for the ledger (auto-created on first run). The folder conventions above are the scanner's defaults, but any folders you want scanned can be listed in [`loops-ui/loops.config.json`](./loops-ui/loops.config.json) under `vault.scanFolders`.

---

## Configurable

[`loops-ui/loops.config.json`](./loops-ui/loops.config.json) controls the primary stakeholder (name, tag, capacity cap, weekly summary), the `P1:self` capacity cap, flat priority caps, scanner keywords, and subgroup→work-mode hints. No code edits required to retarget the app at a new person.

See the stakeholder/capacity model deep-dive in [AGENTS.md](./AGENTS.md#5-the-stakeholder--capacity-model) for what each knob does and how the three coupled behaviors (capacity gate, weekly summary, stale flags) interact.

---

## What's deliberately unfinished

- **No calibrated-from-history time estimation.** Estimation is a static `difficulty → minutes` lookup. `doneAt` is recorded but not yet fed back to calibrate.
- **No Linear / Jira auto-sync.** `linear_ticket_id` exists as an optional display field; wire your own sync to populate it.
- **No unit tests.** Every mutation routes through `applyEventToDisk` which is testable; no `.test.ts` files ship yet.

---

## License

MIT.
