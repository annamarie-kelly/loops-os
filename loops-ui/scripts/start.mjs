#!/usr/bin/env node
// Loops OS · non-Claude entry point.
// Mirrors the /start slash command's preflight + setup, for users without Claude Code.
// Runnable as `npm run start` from loops-ui/.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOPS_UI_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(LOOPS_UI_DIR, '..');
const VAULT_LOOPS_JSON = resolve(REPO_ROOT, 'vault-template', '06-Loops', 'loops.json');
const LOOPS_CONFIG = resolve(LOOPS_UI_DIR, 'loops.config.json');
const NODE_MODULES = resolve(LOOPS_UI_DIR, 'node_modules');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function banner() {
  console.log('');
  console.log(`${C.bold}${C.cyan}Loops OS${C.reset} ${C.dim}·${C.reset} ${C.bold}setup${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(40)}${C.reset}`);
}

function info(msg) { console.log(`${C.blue}·${C.reset} ${msg}`); }
function ok(msg)   { console.log(`${C.green}✓${C.reset} ${msg}`); }
function warn(msg) { console.log(`${C.yellow}!${C.reset} ${msg}`); }
function fail(msg) { console.log(`${C.red}✗${C.reset} ${msg}`); }

async function ask(question, fallback = '') {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${C.cyan}?${C.reset} ${question} `);
    return (answer || fallback).trim();
  } finally {
    rl.close();
  }
}

function isYes(answer, defaultYes = true) {
  const a = answer.toLowerCase();
  if (!a) return defaultYes;
  return a === 'y' || a === 'yes';
}

// ── Preflight ────────────────────────────────────────────────────────────────

function checkNode() {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0], 10);
  if (major < 20) {
    fail(`Node ${v} detected. Node 20+ required.`);
    const hint = platform() === 'darwin'
      ? 'Install: brew install node@20'
      : 'Install: https://nodejs.org/';
    console.log(`  ${hint}`);
    process.exit(1);
  }
  ok(`Node ${v}`);
}

function checkPort(port) {
  // lsof is not available everywhere; gracefully skip on failure.
  const r = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  if (r.error || r.status === 1) return null; // free or lsof missing
  const pid = r.stdout.trim().split('\n')[0];
  return pid || null;
}

async function preflightPort() {
  const pid = checkPort(3456);
  if (!pid) {
    ok('Port 3456 free');
    return 3456;
  }
  warn(`Port 3456 is in use (PID ${pid}).`);
  console.log(`  1) kill ${pid}`);
  console.log(`  2) use port 3457`);
  console.log(`  3) abort`);
  const choice = await ask('Choose 1/2/3:', '3');
  if (choice === '1') {
    const k = spawnSync('kill', [pid]);
    if (k.status !== 0) {
      fail(`Could not kill PID ${pid}. Aborting.`);
      process.exit(1);
    }
    ok(`Killed PID ${pid}`);
    return 3456;
  }
  if (choice === '2') {
    ok('Will use port 3457');
    return 3457;
  }
  info('Aborting at user request.');
  process.exit(0);
}

function checkClaudeCli() {
  const r = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    ok('Claude Code CLI detected');
  } else {
    warn('Claude Code CLI not found — in-app chat panel will be inert.');
    console.log('  Install later: https://docs.claude.com/en/docs/claude-code');
  }
}

function checkObsidian() {
  if (platform() === 'darwin') {
    if (existsSync('/Applications/Obsidian.app')) {
      info('Obsidian detected — set NEXT_PUBLIC_OBSIDIAN_VAULT=vault-template in .env.local for "Open in Obsidian" buttons.');
    }
    return;
  }
  const r = spawnSync('which', ['obsidian'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    info('Obsidian detected — set NEXT_PUBLIC_OBSIDIAN_VAULT=vault-template in .env.local for "Open in Obsidian" buttons.');
  }
}

// ── Setup steps ──────────────────────────────────────────────────────────────

function runForeground(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', code => code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}`)));
    p.on('error', rej);
  });
}

async function ensureInstall() {
  if (existsSync(NODE_MODULES)) {
    ok('node_modules present');
    return;
  }
  info('Installing dependencies (~30–60s on cold cache)...');
  await runForeground('npm', ['install'], { cwd: LOOPS_UI_DIR });
  ok('Dependencies installed');
}

async function maybeConfigure() {
  // First-run config: ask for the primary stakeholder name when it's
  // blank. One question, skippable. Everything else stays at defaults
  // — users discover the rest via the System panel (`s`) and edit
  // loops.config.json or .env.local when they want to customize.
  if (!existsSync(LOOPS_CONFIG)) return;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(LOOPS_CONFIG, 'utf-8'));
  } catch {
    return;
  }
  const currentName = cfg?.stakeholder?.name?.trim();
  if (currentName) {
    ok(`Stakeholder configured: ${currentName}`);
    return;
  }
  const name = await ask(
    'Primary stakeholder name? (e.g. boss, manager, partner — Enter to skip)',
    '',
  );
  if (!name) {
    info('Skipped — set stakeholder.name in loops.config.json later, or via the System panel (`s` in app).');
    return;
  }
  const tag = name.replace(/\s+/g, '');
  cfg.stakeholder = {
    ...(cfg.stakeholder ?? {}),
    name,
    tag,
    weeklySummary: cfg.stakeholder?.weeklySummary ?? true,
  };
  writeFileSync(LOOPS_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  ok(`Stakeholder set to ${name} (tag: ${tag})`);
}

async function maybeSeed() {
  if (existsSync(VAULT_LOOPS_JSON)) {
    ok('vault-template seed present');
    return;
  }
  const ans = await ask('Seed vault-template with 10 example loops? (Y/n)', 'y');
  if (!isYes(ans, true)) {
    info('Skipping seed — app will auto-create an empty ledger on first GET.');
    return;
  }
  await runForeground('node', ['scripts/seed-loops.mjs'], { cwd: LOOPS_UI_DIR });
  ok('Loops seeded');
}

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open'
            : platform() === 'win32'  ? 'start'
            :                            'xdg-open';
  const r = spawnSync(cmd, [url], { stdio: 'ignore' });
  if (r.status !== 0) {
    info(`Open this URL in your browser: ${url}`);
  }
}

function runDev(port) {
  const env = { ...process.env };
  if (port !== 3456) env.PORT = String(port);
  const args = port === 3456 ? ['run', 'dev'] : ['run', 'dev', '--', '-p', String(port)];
  console.log('');
  info(`Starting dev server on port ${port}...`);
  console.log(`${C.dim}${'─'.repeat(40)}${C.reset}`);
  const child = spawn('npm', args, { cwd: LOOPS_UI_DIR, stdio: 'inherit', env });

  let killed = false;
  const shutdown = () => {
    if (killed) return;
    killed = true;
    console.log('');
    info('Shutting down dev server...');
    try { child.kill('SIGINT'); } catch {}
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  child.on('exit', code => process.exit(code ?? 0));

  setTimeout(() => openBrowser(`http://localhost:${port}`), 2000).unref();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner();
  checkNode();
  const port = await preflightPort();
  checkClaudeCli();
  checkObsidian();
  console.log('');

  await ensureInstall();
  await maybeConfigure();
  await maybeSeed();

  console.log('');
  console.log(`${C.dim}Tip: Ctrl-C stops the server.${C.reset}`);
  runDev(port);
}

main().catch(err => {
  fail(err.message || String(err));
  process.exit(1);
});
