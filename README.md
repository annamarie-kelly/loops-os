# Loops

**A local-first AI planner for Obsidian vaults.** Scans every `- [ ]` across your notes, infers priority from natural language, lays out a week canvas that routes around your calendar, and keeps the source of truth in markdown — no database, no cloud, no vendor.

Ships with the vault scaffolding Loops was built around (`vault-template/`) so you can try it against a working example before pointing it at your own vault.

```
loops-ui/          The Next.js 16 app. Triage / Plan / Focus / Reflect modes.
vault-template/    The vault conventions + slash commands Loops reads.
```

## What it does

- **Priority inference** — no tags, no labels. Reads natural language: "due Thursday", "blocking", "@waiting", "brainstorm" → sorted into 🔴 Now / 🟡 Soon / 🟢 Someday. Time-aware: "due Thursday" on a Wednesday is urgent, on a Monday it isn't.
- **Triage queue** — card-by-card walk through new loops. Accept, park, drop, snooze. Keyboard-driven: `1`/`2`/`3` for priority, `H` to snooze, `S` to change stakeholder, `D` to open detail. The capacity gate blocks you from adding a ninth P1 before you drop one.
- **Week canvas** — drag loops onto a weekday; timeblocks schedule around calendar events pulled from `06-Loops/calendar-today.json`. Overcommit is flagged, not allowed.
- **Focus mode** — one loop at a time. Vim-style nav (`j`/`k`), `space` to close, `w` to pin. Everything else disappears.
- **Reflect mode** — 30-day pressure heatmap, triage decision stats, weekly stakeholder summary draft (toggle via config).
- **Markdown round-trip** — reads `- [ ]` from your notes, writes `- [x]` back when you close a loop. Your vault stays the source of truth. Close Loops, re-open in Obsidian, nothing is lost.

## Quickstart

The fastest path from a fresh clone:

```bash
git clone <repo> && cd <repo>
claude                  # open Claude Code in this directory
/start                  # one-command onboarding
```

`/start` installs dependencies, seeds example loops, spins up the dev server in the background, opens the browser, and offers to pull your inbox from any MCP sources you've wired up. See [`.claude/commands/start.md`](./.claude/commands/start.md) for exactly what it does.

**Manual path** — if you'd rather run the steps yourself:

```bash
cd loops-ui
npm install
node scripts/seed-loops.mjs    # populate example loops in vault-template/
npm run dev                    # open http://localhost:3000
```

Full setup walkthrough, first-session tour, and calendar-integration examples in [`loops-ui/README.md`](./loops-ui/README.md).

## Architecture — three parts, decoupled

**`loops-ui/`** — a Next.js 16 + React 19 app. Pure file I/O; no database, no auth. Reads and writes under `06-Loops/` in whatever vault directory you point it at via `LOOPS_UI_VAULT_ROOT`.

**`vault-template/`** — the Obsidian vault conventions Loops was built around. Folders (`00-Inbox`, `01-Building`, `02-Thinking`, `03-Working`, `04-Living`, `05-Relating`, `06-Loops`, `07-Archive`), a templates directory, and 11 Claude Code slash commands for capture / triage / distillation / pruning. Copy it into your own Obsidian vault, or just use it as the example Loops runs against out of the box.

**The contract between them** — `06-Loops/loops.json`. The app reads it on every request. Any scanner that can produce the same shape (including the bundled `refresh-loops.mjs`, or your own MCP-driven `/inbox` pipeline) can feed Loops.

## The vault template (optional, but the interesting bit)

The `vault-template/` directory ships a **two-axis memory model** for notes. Every note picks:

- A **domain** (folder): `01-Building`, `02-Thinking`, `03-Working`, `04-Living`, `05-Relating`.
- A **memory type** (frontmatter `type:`): episodic (`episode`), semantic (`pattern` / `decision` / `failure` / `convention` / `essay` / `reference`), procedural (`playbook`).

One folder per note + one memory type = cross-axis retrieval. "Show me every failure across building and working." "Find all playbooks." "What episodes produced this pattern." A one-field change per note that unlocks compound knowledge retrieval.

The eleven slash commands that come with the template:

| Command | What it does |
|---|---|
| `/setup` | Interactive walkthrough to customize the vault to your role, domains, and tools |
| `/inbox` | Pull external context (calendar, CRM, task board) from MCP sources into the inbox |
| `/triage` | Route inbox notes to the right domain + memory type; delegate investigations to background agents |
| `/distill` | Classify raw input by memory type and create properly-typed notes |
| `/loops` | Terminal-friendly priority-sorted snapshot of every open `- [ ]` |
| `/commitments` | Relationship view of the same data — what you owe people, what they owe you |
| `/find-connections` | Surface orphaned notes, suggest missing `[[wikilinks]]` |
| `/conductor` | Scan git worktrees for in-progress work |
| `/reindex` | Regenerate `_patterns.md` / `_episodes.md` / `_playbooks.md` from frontmatter |
| `/prune` | Archive notes whose `shelf-life` has expired (14 days tactical / 30 days observational) |
| `/review` | Weekly metacognition — what changed, what's emerging, what's orphaned |

See [`vault-template/CLAUDE.md`](./vault-template/CLAUDE.md) for the full vault conventions, frontmatter schema, and record-type guidance.

## Point at your own vault

Already have an Obsidian vault? Point Loops at it:

```bash
export LOOPS_UI_VAULT_ROOT=/absolute/path/to/your/vault
cd loops-ui
npm run dev
```

The only hard requirement is a `06-Loops/` directory for the ledger (auto-created on first run). The folder conventions above are the default scan set, but any folders you want scanned can be listed in [`loops-ui/loops.config.json`](./loops-ui/loops.config.json) under `vault.scanFolders`.

## Configurable

[`loops-ui/loops.config.json`](./loops-ui/loops.config.json) controls the primary stakeholder (name, tag, capacity cap, weekly summary), the `P1:self` capacity cap, flat priority caps, scanner stakeholder keywords, and subgroup→work-mode hints. No code edits required to retarget.

## What's deliberately unfinished

- **No calibrated-from-history time estimation.** Estimation is a static `difficulty → minutes` lookup. `doneAt` is recorded but not yet fed back to calibrate. A good next iteration: prompt on close for actual duration, recompute the table from history.
- **No Linear / Jira auto-sync.** `linear_ticket_id` exists as an optional display field; wire your own sync to populate it.
- **No unit tests.** Every mutation routes through `applyEventToDisk` which is testable; no `.test.ts` files ship yet.

## License

MIT.
