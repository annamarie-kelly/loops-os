// background.js — service worker for the Loops Capture extension.
// Owns the right-click "Clip selection to Loops" context menu: a
// one-shot capture that bypasses the popup. Highlight text on any
// page → right-click → it's in your triage inbox.
//
// Feedback is rendered via the action icon's badge (no popup, no
// notifications permission) — green "+" on success, red "!" on
// failure, clears after a few seconds.

const DEFAULT_URL = 'http://localhost:3456';
const PROBE_PORTS = [3456, 3457, 3458, 3000, 3001];
const PROBE_TIMEOUT_MS = 1500;
const MENU_ID = 'loops-clip-selection';

// Register the context menu on install / on browser start.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Clip selection to Loops',
    contexts: ['selection'],
  });
});
chrome.runtime.onStartup?.addListener(() => {
  // Re-create — onInstalled doesn't fire on browser start. Use try/catch
  // to swallow the "duplicate id" error if it's still around.
  chrome.contextMenus.create(
    { id: MENU_ID, title: 'Clip selection to Loops', contexts: ['selection'] },
    () => void chrome.runtime.lastError,
  );
});

// ─── Probe / saved URL helpers ───────────────────────────────────

async function probePort(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${port}/api/loops`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.loops)) return `http://localhost:${port}`;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function autoDetectLoopsUrl() {
  const results = await Promise.all(PROBE_PORTS.map(probePort));
  return results.find((r) => r) ?? null;
}

async function getSavedLoopsUrl() {
  try {
    const { loopsUrl } = await chrome.storage.local.get('loopsUrl');
    return loopsUrl ? loopsUrl.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

async function setSavedLoopsUrl(url) {
  try {
    await chrome.storage.local.set({ loopsUrl: url });
  } catch {
    // ignore
  }
}

// ─── Badge feedback ──────────────────────────────────────────────

async function flashBadge(text, color, ttlMs = 2200) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch {
    return;
  }
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }, ttlMs);
}

// ─── Capture POST ────────────────────────────────────────────────

async function postCapture(baseUrl, body) {
  return fetch(`${baseUrl}/api/loops/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function captureWithFallback(body) {
  let url = (await getSavedLoopsUrl()) || DEFAULT_URL;
  let res = await postCapture(url, body).catch(() => null);
  if (!res || !res.ok) {
    const detected = await autoDetectLoopsUrl();
    if (detected && detected !== url) {
      await setSavedLoopsUrl(detected);
      url = detected;
      res = await postCapture(url, body).catch(() => null);
    }
  }
  return res && res.ok;
}

// ─── Context menu click handler ──────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const selection = (info.selectionText ?? '').trim();
  if (!selection) return;

  // Render the selection as a markdown blockquote so it shows
  // formatted in the Triage card.
  const quoted = selection
    .split('\n')
    .map((line) => `> ${line.trim()}`)
    .filter((line) => line !== '> ')
    .join('\n');

  const body = {
    text: quoted,
    source: tab && tab.url ? { title: tab.title || '', url: tab.url } : undefined,
    // Right-click always saves as a clip (vault markdown file). The
    // user explicitly highlighted something to keep — no triage.
    kind: 'clip',
  };

  const ok = await captureWithFallback(body);
  await flashBadge(ok ? '+' : '!', ok ? '#6B7D6B' : '#C4827A');
});
