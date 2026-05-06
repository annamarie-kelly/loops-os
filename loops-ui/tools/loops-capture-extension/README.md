# Loops Capture (Chrome extension)

Capture the active tab plus a thought into your Loops triage inbox.

## Install (unpacked)

1. Run `npm run dev` in your `loops-ui/` directory so the API is reachable.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select this folder
   (`tools/loops-ui/tools/loops-capture-extension`).
5. Pin the action icon to the toolbar (puzzle-piece menu → pin Loops Capture).

## Connect

The extension talks to your local loops-ui's `/api/loops/capture` endpoint.

**It auto-detects** which port loops-ui is on. On first capture (or whenever
the saved URL stops responding), the extension probes a handful of common
ports (3456, 3457, 3458, 3000, 3001) in parallel, picks the first one that
returns a real loops-ui response, and saves it. Move your dev server to a
new port and the next capture re-detects automatically.

**Default URL:** `http://localhost:3456` — the loops-ui dev server's
default port. Override via the options page if you want to pin to something
else:

1. Right-click the toolbar icon → **Options** (or visit
   `chrome://extensions` → Loops Capture → **Details** → **Extension options**).
2. Set the URL to wherever your dev server is listening
   (`http://localhost:<your-port>`).
3. Click **Save**.

The URL is stored in `chrome.storage.local` and read on every capture, so
you can switch between dev servers without reloading the extension.

### Verify the connection

Open the popup, type "ping", click **Capture**. Within a second you should
see the green **→ Triage** confirmation, the popup auto-closes, and the
loop appears in your Triage view in the loops-ui app.

If you see `error — is loops-ui running?`:

- Confirm `npm run dev` is active in your loops-ui terminal.
- Confirm the port matches what's in **Options**.
- Try `curl http://localhost:<port>/api/loops/capture -X POST -H 'Content-Type: application/json' -d '{"text":"curl test"}'` — you should get `{"ok":true,"id":"..."}` back.
- If `curl` works but the extension still errors, reload the extension at
  `chrome://extensions` (⟳ refresh icon on the extension card).

## Use

Two destinations, picked via a toggle at the top of the popup:

- **Loop → Triage** — for thoughts/tasks that need a decision. Lands in
  `06-Loops/loops.json` with `status: triage`. Process via the in-app
  Triage view (`1` accept / `2` someday / `3` drop).
- **Clip → Vault** — for quotes, articles, anything you want to keep
  without going through triage. Lands as a markdown file at
  `00-Inbox/clips/<date>-<slug>.md` with frontmatter (source URL, title,
  tags) and shows up in the Research shelf.

The toggle defaults to **Loop**. It auto-flips to **Clip** when the popup
detects a text selection on the page (you highlighted something to keep).

### Popup capture

- Click the toolbar icon (or hit **⌘⇧L** / **Ctrl+Shift+L**).
- The popup auto-fills the page link as a removable chip below the textarea.
- If you've selected text on the page, it pre-fills as a markdown blockquote
  and switches the toggle to **Clip**.
- Pick tags from the row of pills — `task / read / research / idea / design`
  — or click **+** to add custom tags inline.
- Type your note. **⌘↵** to capture, **Esc** to close, **×** to drop the link.

### One-shot clip (no popup)

Highlight any text on a page → **right-click** → **Clip selection to Loops**.
Always saves as a clip (vault markdown file). The action icon flashes a green
**+** on success, red **!** if it can't reach loops-ui — clears after a
couple seconds.

## Notes

- The extension only talks to localhost. No external endpoints, no telemetry.
- Captures don't write any markdown file — they go straight into
  `06-Loops/loops.json` as a triage-status loop.
- Page context is captured via `activeTab` permission — only the page you're
  looking at when you open the popup, never background tabs.
