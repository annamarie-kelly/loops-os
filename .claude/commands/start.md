# /start — first-run onboarding

Bring a freshly-cloned `loops-os` repo from zero to "server running, ready to triage" in one command.

## What to do

1. **Check `loops-ui/node_modules/`.** If it doesn't exist, run:
   ```bash
   cd loops-ui && npm install
   ```
   Tell the user this will take ~30–60 seconds on a cold cache. Error out cleanly if install fails (don't try to start the server).

2. **Check `vault-template/06-Loops/loops.json`.** If it doesn't exist, ask:
   > "Seed the vault-template with 10 example loops so you have something to click through? (Y/n)"

   If yes, run:
   ```bash
   cd loops-ui && node scripts/seed-loops.mjs
   ```
   If no, skip — the app auto-creates an empty ledger on first GET.

3. **Start the dev server in the background.** Use `run_in_background: true`:
   ```bash
   cd loops-ui && npm run dev
   ```
   Then use the Monitor tool to wait for the "Ready" signal in stdout (timeout 30s). Capture the URL from the output (typically `http://localhost:3000`; may be a different port if 3000 is taken).

4. **Open the browser.** Run `open <url>` (macOS) or `xdg-open <url>` (Linux) or print the URL for the user to click. Do this even if `open` fails — the URL should be visible either way.

5. **Ask about inbox.** If the user has wired their own MCP sources (calendar, email, task tracker, meeting transcripts) into `vault-template/.claude/commands/inbox.md`, ask:
   > "Want me to pull today's inbox from your MCP sources? (y/N)"

   If yes: the `/inbox` command lives in `vault-template/.claude/commands/`. From the repo root, the user can either `cd vault-template` and run `/inbox` there, or you can read `vault-template/.claude/commands/inbox.md` and execute the steps inline. Tell the user which sources pulled and how many items landed in `00-Inbox/`.

   If no or the user hasn't configured MCPs yet: skip.

6. **Print a summary.** Include:
   - The URL the server is running on
   - Whether loops were seeded (and how many)
   - Whether inbox was pulled (and counts, if applicable)
   - One suggested next action: "Click through Triage mode to walk the queue — keyboard shortcuts are documented in `loops-ui/README.md`."

## Stopping the server

If the user wants to stop the server, they can Ctrl-C the background task or ask you to kill the process on the port (`kill $(lsof -ti:3000)`).

## Not doing

- Don't prompt for a non-default vault path — if the user wants that, they set `LOOPS_UI_VAULT_ROOT` themselves before calling `/start`.
- Don't try to auto-detect and wire MCP sources — that's the user's setup. Just ask whether to run the existing `/inbox` flow.
