# /start — first-run onboarding

Bring a freshly-cloned `loops-os` repo from zero to "server running, ready to triage" in one command.

## What to do

### Preflight (run BEFORE `npm install`)

Run all four checks. Abort only on hard failures (node version). Warnings are non-blocking.

1. **Node version.** Run `node -v`. If the major version is <20, abort with:
   > "Node 20+ required. Install via `brew install node@20` (macOS) or download from https://nodejs.org/. Re-run `/start` after install."

2. **Port 3456 free?** Run `lsof -ti:3456`. If it returns a PID, ask the user:
   > "Port 3456 is in use (PID `<pid>`). Options:
   > 1. Kill that process (`kill <pid>`)
   > 2. Use port 3457 instead (export `PORT=3457`)
   > 3. Abort
   > Which? (1/2/3)"
   Honor the choice: run `kill <pid>`, set `PORT=3457` in the env for the dev server, or stop.

3. **Claude Code CLI.** Run `which claude`. If missing, warn (do NOT abort):
   > "Claude Code CLI not found. The in-app chat panel won't work without it. Install later from https://docs.claude.com/en/docs/claude-code if you want it. Everything else works fine."

4. **Obsidian (optional).** On macOS, check `/Applications/Obsidian.app`; on Linux, run `which obsidian`. If found, mention:
   > "Obsidian detected — set `NEXT_PUBLIC_OBSIDIAN_VAULT=vault-template` in `loops-ui/.env.local` if you want 'Open in Obsidian' buttons in the UI."
   If not found, skip silently.

### Setup + start

5. **Check `loops-ui/node_modules/`.** If it doesn't exist, run:
   ```bash
   cd loops-ui && npm install
   ```
   Tell the user this will take ~30–60 seconds on a cold cache. Error out cleanly if install fails (don't try to start the server).

6. **First-run config.** Read `loops-ui/loops.config.json`. If `stakeholder.name` is empty, ask:
   > "Primary stakeholder name? (e.g. boss, manager, partner — Enter to skip)"

   If they answer: write the name into `stakeholder.name`, derive `stakeholder.tag` by stripping whitespace from the name, and set `stakeholder.weeklySummary: true`. Save the file. If they skip, leave empty — they can configure later via the System panel (`s` in app).

7. **Check `vault-template/06-Loops/loops.json`.** If it doesn't exist, ask:
   > "Seed the vault-template with 10 example loops so you have something to click through? (Y/n)"

   If yes, run:
   ```bash
   cd loops-ui && node scripts/seed-loops.mjs
   ```
   If no, skip — the app auto-creates an empty ledger on first GET.

8. **Start the dev server in the background.** Use `run_in_background: true`:
   ```bash
   cd loops-ui && npm run dev
   ```
   (If preflight step 2 set `PORT=3457`, prepend `PORT=3457 ` to the command.)
   Then use the Monitor tool to wait for the "Ready" signal in stdout (timeout 30s). Capture the URL from the output.

9. **Open the browser.** Run `open <url>` (macOS) or `xdg-open <url>` (Linux) or print the URL for the user to click. Do this even if `open` fails — the URL should be visible either way.

10. **Ask about inbox.** If the user has wired their own MCP sources (calendar, email, task tracker, meeting transcripts) into `vault-template/.claude/commands/inbox.md`, ask:
    > "Want me to pull today's inbox from your MCP sources? (y/N)"

    If yes: the `/inbox` command lives in `vault-template/.claude/commands/`. From the repo root, the user can either `cd vault-template` and run `/inbox` there, or you can read `vault-template/.claude/commands/inbox.md` and execute the steps inline. Tell the user which sources pulled and how many items landed in `00-Inbox/`.

    If no or the user hasn't configured MCPs yet: skip.

11. **Offer Chrome extension install.** Ask:
    > "Want the Chrome capture extension? (y/N)"

    If yes, print:
    > "Open `chrome://extensions` → toggle on **Developer mode** (top right) → click **Load unpacked** → point at `tools/loops-capture-extension/` in this repo. Then press ⌘⇧L (Cmd+Shift+L) on any page to capture text or selection straight into your loops inbox."
    If no, skip.

12. **Print a summary.** Include:
    - The URL the server is running on
    - Whether loops were seeded (and how many)
    - Whether inbox was pulled (and counts, if applicable)
    - Whether the Chrome extension prompt was accepted
    - One suggested next action: "Click through Triage mode to walk the queue — keyboard shortcuts are documented in `loops-ui/README.md`."

## Stopping the server

If the user wants to stop the server, they can Ctrl-C the background task or ask you to kill the process on the port (`kill $(lsof -ti:3456)`).

## Not doing

- Don't prompt for a non-default vault path — if the user wants that, they set `LOOPS_UI_VAULT_ROOT` themselves before calling `/start`.
- Don't try to auto-detect and wire MCP sources — that's the user's setup. Just ask whether to run the existing `/inbox` flow.
