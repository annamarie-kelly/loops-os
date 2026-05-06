// options.js — single setting: where loops-ui lives. Stored in
// chrome.storage.local; popup.js reads it before each capture.

const urlInput = document.getElementById('url');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');

const DEFAULT_URL = 'http://localhost:3456';

function setStatus(text, tone = 'normal') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

chrome.storage.local.get('loopsUrl', ({ loopsUrl }) => {
  urlInput.value = loopsUrl || DEFAULT_URL;
});

saveBtn.addEventListener('click', async () => {
  const trimmed = urlInput.value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    setStatus('URL required', 'warn');
    return;
  }
  await chrome.storage.local.set({ loopsUrl: trimmed });
  setStatus('saved', 'ok');
  setTimeout(() => setStatus(''), 1500);
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});
