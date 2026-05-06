// popup.js — gathers the active tab as page context, lets the user
// add a note, POSTs to /api/loops/capture on the configured Loops UI.
// Page link auto-fills as a removable chip; the note textarea is the
// primary input.
//
// Connection logic:
//   1. If a URL is saved (Options page), use it.
//   2. Otherwise auto-detect: probe /api/loops on a few common ports
//      in parallel and pick the first that returns a loops.json shape.
//   3. If a saved URL fails (e.g. port shuffled), fall back to
//      auto-detect, save the new URL, and retry the capture once.

const noteEl = document.getElementById('note');
const pillsEl = document.getElementById('pills');
const pillAddBtn = document.getElementById('pill-add');
const pillInputEl = document.getElementById('pill-input');
const captureBtn = document.getElementById('capture');
const kindToggleEl = document.querySelector('.kind-toggle');
const kindPillEls = Array.from(document.querySelectorAll('.kind-pill'));
const statusEl = document.getElementById('status');
const settingsLink = document.getElementById('settings-link');
const contextEl = document.getElementById('context');
const ctxTitleEl = document.getElementById('ctx-title');
const ctxUrlEl = document.getElementById('ctx-url');
const ctxRemoveBtn = document.getElementById('ctx-remove');

const DEFAULT_URL = 'http://localhost:3456';
const PROBE_PORTS = [3456, 3457, 3458, 3000, 3001];
const PROBE_TIMEOUT_MS = 1500;

let pageContext = null;
// 'loop' (default) → triage inbox. 'clip' → vault markdown file.
// Selection prefill flips the default to 'clip' since the user
// highlighted something to keep.
let kind = 'loop';

function setKind(next) {
  kind = next === 'clip' ? 'clip' : 'loop';
  kindPillEls.forEach((el) => {
    el.classList.toggle('selected', el.dataset.kind === kind);
  });
}

kindPillEls.forEach((el) => {
  el.addEventListener('click', () => setKind(el.dataset.kind));
});
setKind('loop');

function showContext(title, url) {
  pageContext = { title, url };
  ctxTitleEl.textContent = title || '(untitled)';
  ctxUrlEl.textContent = url;
  contextEl.hidden = false;
}

function hideContext() {
  pageContext = null;
  contextEl.hidden = true;
}

// Page-context auto-fill — pull the active tab's title + URL, plus
// any selected text on the page so a "clip this quote" capture is
// a single click. Skip chrome:// and extension:// pages.
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (!tab || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return;
  }
  showContext(tab.title || '', tab.url);

  // Grab the user's text selection on the page, if any. Requires the
  // `scripting` permission + activeTab grant (set when the user clicked
  // the action icon). Some pages (PDF, Chrome internals, restricted
  // origins) refuse injection — we just skip silently.
  if (!tab.id) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection()?.toString() ?? '').trim(),
    });
    const selection = results?.[0]?.result;
    if (typeof selection === 'string' && selection.length > 0) {
      // Render the selection as a markdown blockquote so the saved
      // file/card shows it formatted. Cursor lands AFTER the quote so
      // the user can type their commentary immediately. A selection
      // also flips the default to "clip" — they highlighted something
      // to keep, not a thought needing a triage decision.
      const quoted = selection
        .split('\n')
        .map((line) => `> ${line.trim()}`)
        .filter((line) => line !== '> ')
        .join('\n');
      noteEl.value = `${quoted}\n\n`;
      noteEl.setSelectionRange(noteEl.value.length, noteEl.value.length);
      noteEl.focus();
      setKind('clip');
    }
  } catch {
    // Selection grab failed — fine, the user can still type a note.
  }
});

ctxRemoveBtn.addEventListener('click', () => {
  hideContext();
  noteEl.focus();
});

// Pill toggle — click to select / unselect any tag pill (default or
// user-added). Uses event delegation so dynamically inserted pills
// from the "+" input are wired automatically.
const selectedPills = new Set();

function togglePill(el) {
  const tag = el.dataset.tag;
  if (!tag) return;
  if (selectedPills.has(tag)) {
    selectedPills.delete(tag);
    el.classList.remove('selected');
  } else {
    selectedPills.add(tag);
    el.classList.add('selected');
  }
}

pillsEl.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target === pillAddBtn || target === pillInputEl) return;
  const pill = target.closest('.pill');
  if (pill instanceof HTMLElement && pill.dataset.tag) {
    togglePill(pill);
  }
});

// Sanitize once on the client to mirror the server's rules so the
// pill we render is the same string the server will store.
function cleanTag(raw) {
  return raw.trim().replace(/^#/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

function commitTagInput() {
  const raw = pillInputEl.value;
  if (raw.trim()) {
    const tags = raw
      .split(/[,\s]+/)
      .map(cleanTag)
      .filter(Boolean);
    for (const tag of tags) {
      // Skip duplicates of existing pills — just toggle them on instead.
      const existing = pillsEl.querySelector(
        `.pill[data-tag="${CSS.escape(tag)}"]`,
      );
      if (existing instanceof HTMLElement) {
        if (!selectedPills.has(tag)) togglePill(existing);
        continue;
      }
      // Insert a new pill before the "+" button, pre-selected.
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pill selected';
      pill.dataset.tag = tag;
      pill.textContent = tag;
      pillsEl.insertBefore(pill, pillAddBtn);
      selectedPills.add(tag);
    }
  }
  pillInputEl.value = '';
  pillInputEl.hidden = true;
  pillAddBtn.hidden = false;
}

function openTagInput() {
  pillAddBtn.hidden = true;
  pillInputEl.hidden = false;
  pillInputEl.value = '';
  // Focus needs the next tick so the element is actually shown.
  requestAnimationFrame(() => pillInputEl.focus());
}

function cancelTagInput() {
  pillInputEl.value = '';
  pillInputEl.hidden = true;
  pillAddBtn.hidden = false;
}

pillAddBtn.addEventListener('click', openTagInput);
pillInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitTagInput();
    // Re-open immediately so the user can chain multiple tags fast.
    openTagInput();
  } else if (e.key === ',' || e.key === ' ') {
    // Comma or space also commits the current token but stays open.
    e.preventDefault();
    commitTagInput();
    openTagInput();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelTagInput();
    noteEl.focus();
  } else if (e.key === 'Backspace' && pillInputEl.value === '') {
    // Empty Backspace nukes the most recent user-added pill.
    e.preventDefault();
    const lastUserPill = Array.from(pillsEl.querySelectorAll('.pill[data-tag]'))
      .filter((p) => !['task','read','research','idea','design'].includes(p.dataset.tag ?? ''))
      .pop();
    if (lastUserPill instanceof HTMLElement) {
      const tag = lastUserPill.dataset.tag;
      if (tag) selectedPills.delete(tag);
      lastUserPill.remove();
    }
  }
});
pillInputEl.addEventListener('blur', () => {
  // Commit-on-blur — if user clicks away with text typed, capture it.
  if (pillInputEl.value.trim()) commitTagInput();
  else cancelTagInput();
});

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

function setStatus(text, tone = 'normal') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

// Probe a single port: only counts as a hit if /api/loops returns a
// loops.json-shaped JSON, so we don't accidentally pin to some other
// dev server happening to listen on the same port.
async function probePort(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${port}/api/loops`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.loops)) {
      return `http://localhost:${port}`;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function autoDetectLoopsUrl() {
  // First-port-to-respond wins. Probes run in parallel.
  const probes = PROBE_PORTS.map(probePort);
  const results = await Promise.all(probes);
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
    // ignore — capture still works, just won't persist.
  }
}

async function postCapture(url, body) {
  return fetch(`${url}/api/loops/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function capture() {
  const text = noteEl.value.trim();
  if (!text && !pageContext) {
    setStatus('add a note or keep the link', 'warn');
    noteEl.focus();
    return;
  }
  captureBtn.disabled = true;
  setStatus('capturing…');

  // If the user is mid-typing in the inline tag input when they hit
  // Capture, fold that text in too so they don't lose it.
  if (!pillInputEl.hidden && pillInputEl.value.trim()) {
    commitTagInput();
  }
  const tags = Array.from(selectedPills);

  const body = {
    text,
    source: pageContext || undefined,
    tags: tags.length > 0 ? tags : undefined,
    kind,
  };

  try {
    let url = (await getSavedLoopsUrl()) || DEFAULT_URL;
    let res = await postCapture(url, body).catch(() => null);

    // Saved URL didn't reach a loops-ui that knows /capture.
    // Auto-detect, save the winner, and retry once.
    if (!res || !res.ok) {
      setStatus('finding loops-ui…');
      const detected = await autoDetectLoopsUrl();
      if (detected && detected !== url) {
        await setSavedLoopsUrl(detected);
        url = detected;
        res = await postCapture(url, body).catch(() => null);
      }
    }

    if (!res || !res.ok) {
      const errBody = res ? await res.json().catch(() => ({})) : {};
      const detail = errBody.error || (res ? `HTTP ${res.status}` : 'no response');
      throw new Error(detail);
    }

    setStatus(kind === 'clip' ? '→ Vault' : '→ Triage', 'ok');
    setTimeout(() => window.close(), 700);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`error — is loops-ui running?  ${msg}`, 'error');
    captureBtn.disabled = false;
  }
}

captureBtn.addEventListener('click', capture);

// ⌘↵ / Ctrl+↵ submits from the textarea; Enter from the tags input
// also submits (it's a single-line field). The pill-input handles its
// own Enter for tag-commit, so we don't bind capture there.
noteEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    capture();
  }
});
