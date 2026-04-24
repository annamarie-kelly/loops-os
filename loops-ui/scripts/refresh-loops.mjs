#!/usr/bin/env node
/**
 * refresh-loops.mjs — walk the vault and reconcile `06-Loops/loops.json`
 * with the current set of `- [ ]` checkbox items found in markdown
 * files. Writes flow through the shared event library (`lib/tend-events.ts`)
 * so the web UI, CLI, and this script all share merge semantics:
 * user-edited fields are preserved, scanner-owned fields are refreshed,
 * no-ops are skipped, and every change is stamped to the events log.
 *
 * Match rules, in order:
 *   1. Exact stable_id match → update in place.
 *   2. Fuzzy (Jaccard ≥0.7) match against unused previous loops →
 *      emit a scan event that rekeys to the existing id.
 *   3. Unmatched previous loops that are manual captures
 *      (source `00-Inbox/manual-loops.md` or source.line === 0) or
 *      already `done` are left alone — no event, no overwrite.
 *
 * Timeblock tier promotion: a second pass finds loops with a live
 * timeblock on today and emits follow-up scan events to promote them
 * to tier 'now'.
 *
 * Invocation:
 *   node scripts/refresh-loops.mjs              # reconcile
 *   node scripts/refresh-loops.mjs --dry-run    # preview, no writes
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ─── paths ──────────────────────────────────────────────────────────

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOOPS_UI_ROOT = path.resolve(__dirname, '..');
const VAULT =
  process.env.LOOPS_UI_VAULT_ROOT
    ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
    : path.resolve(__dirname, '../../vault-template');
const LOOPS_JSON = path.join(VAULT, '06-Loops/loops.json');

const SCAN_DIRS = [
  '00-Inbox',
  '01-Creating',
  '02-Thinking',
  '03-Living',
  '04-Relating',
  'inbox',
];
const SKIP_SEGMENTS = new Set([
  'Templates',
  'templates',
  'assets',
  '05-Archive',
  '07-Archive',
  '06-Loops',
  '.claude',
  '.obsidian',
  'node_modules',
  'tools',
  '.next',
]);

// Filename prefixes that should never be scraped. Spec docs have long
// implementation checklists that are build-plans, not real open loops.
const SKIP_FILE_PREFIXES = ['SPEC --', 'SPEC—', 'SPEC -'];

function shouldSkipFile(basename) {
  for (const p of SKIP_FILE_PREFIXES) {
    if (basename.startsWith(p)) return true;
  }
  return false;
}

// ─── normalization + stable id ──────────────────────────────────────

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[.,;!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableId(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeText(text))
    .digest('hex')
    .slice(0, 8);
}

function wordSet(text) {
  return new Set(
    normalizeText(text)
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

function jaccard(a, b) {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersect = 0;
  for (const w of A) if (B.has(w)) intersect++;
  return intersect / (A.size + B.size - intersect);
}

// ─── classifiers ────────────────────────────────────────────────────

function inferTier(text, fileMtime, fileRel) {
  const t = text.toLowerCase();
  if (t.includes('@waiting')) return 'someday';
  if (
    /\b(pressing|urgent|blocking|blocker|today|tomorrow|asap|overdue|eod|by friday|by monday)\b/.test(
      t,
    )
  )
    return 'now';
  if (/\b(someday|eventually|brainstorm|phase 3|explore|maybe|nice to have)\b/.test(t))
    return 'someday';
  const ageDays = (Date.now() - fileMtime) / 86_400_000;
  if (fileRel.startsWith('00-Inbox/') && ageDays < 3) return 'soon';
  if (ageDays > 14) return 'someday';
  return 'soon';
}

// Priority inference is deliberately conservative:
// - Only explicit P0 signals (error/broken/incident) return P0
// - Stakeholder detection sets the pLevel suffix so the backlog can
//   still group by person, but priority defaults to P3
// - P1 is reserved for loops the user explicitly accepts through the
//   triage gate in the UI. The scanner never picks P1 on its own.
//
// The stakeholder keyword list is loaded from loops.config.json →
// stakeholder (the primary) + scannerStakeholders (others). Users
// extend it there without touching this script.
const SCANNER_PEOPLE = (() => {
  const out = [];
  try {
    const raw = fs.readFileSync(path.join(LOOPS_UI_ROOT, 'loops.config.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg?.stakeholder?.tag) {
      out.push([cfg.stakeholder.tag.toLowerCase(), cfg.stakeholder.name]);
    }
    for (const s of cfg?.scannerStakeholders ?? []) {
      if (s?.keyword && s?.name) out.push([s.keyword.toLowerCase(), s.name]);
    }
  } catch {
    // config missing — scanner produces unsuffixed P3 loops.
  }
  return out;
})();

function inferPLevel(text) {
  const t = text.toLowerCase();
  if (/\b(error|broken|down|incident|production is broken|p0)\b/.test(t)) return 'P0';
  for (const [k, name] of SCANNER_PEOPLE) if (t.includes(k)) return `P3:${name}`;
  return 'P3';
}

function inferDifficulty(text) {
  const t = text.toLowerCase();
  const len = text.length;
  if (/\b(architect|migrate whole|overhaul|massive|rethink the)\b/.test(t)) return 13;
  if (/\b(refactor|consolidate|build the|new system|multi-|cross-system)\b/.test(t))
    return 8;
  if (/\b(build|implement|create|set up|draft|write|design)\b/.test(t)) return 5;
  if (/\b(fix|verify|check|review|scope|investigate|audit|compare|test)\b/.test(t))
    return 3;
  if (/\b(send|email|ask|ping|note|reply|confirm|add a)\b/.test(t)) return 2;
  if (len < 50) return 2;
  if (len < 120) return 3;
  return 5;
}

function inferTimeMinutes(difficulty) {
  const base =
    { 1: 10, 2: 20, 3: 45, 5: 90, 8: 180, 13: 360, 21: 720 }[difficulty] ?? 60;
  return Math.round(base * 1.15);
}

const WORK_MODE_BUCKETS = [
  {
    mode: 'research',
    words: [
      'scope', 'investigat', 'audit', 'analyz', 'compar', 'evaluat', 'assess',
      'benchmark', 'explor', 'rethink', 'inventory',
    ],
  },
  {
    mode: 'design',
    words: [
      'spec', 'design', 'architect', 'mapping', 'model', 'manifest', 'boundary',
      'framework', 'schema', 'ledger', 'snapshot', 'tripwire', 'gate', 'template',
      'decide', 'defin', 'outline', 'strateg', 'roadmap', 'align', 'ownership',
      'capacity',
    ],
  },
  {
    mode: 'communicate',
    words: [
      'email', 'send', 'push', 'share', 'sync', 'status', 'notify', 'ask',
      'follow up', 'slack', 'weekly', 'prep for', 'handoff', 'onboard',
      'checklist', 'review',
    ],
  },
  {
    mode: 'ops',
    words: [
      'retire', 'clean', 'maintain', 'monitor', 'check', 'verify', 'validat',
      'test', 'run ', 'dedup', 'compress', 'cleanup', 'retirement', 'fix',
      'debug', 'migration', 'bug',
    ],
  },
  {
    mode: 'build',
    words: [
      'code', 'build', 'implement', 'wire', 'wiring', 'create', 'scaffold',
      'connector', 'pipeline', 'router', 'consolidat', 'ship', 'deploy', 'refactor',
    ],
  },
];

function classifyWorkMode(title, subGroup) {
  const lower = (title || '').toLowerCase();
  for (const { mode, words } of WORK_MODE_BUCKETS) {
    for (const w of words) if (lower.includes(w)) return mode;
  }
  if (subGroup) {
    const s = subGroup.toLowerCase();
    const hints = [
      ['sanity', 'design'],
      ['pattern', 'design'],
      ['review', 'communicate'],
      ['schedule', 'communicate'],
    ];
    for (const [m, mode] of hints) if (s.includes(m)) return mode;
  }
  return 'unsorted';
}

function domainFromFile(rel, text) {
  const lower = (rel + ' ' + (text || '')).toLowerCase();

  // Keyword-based: customize these patterns to match your projects
  // Example: if (/\b(myproject|deploy|backend)\b/.test(lower)) return 'work';

  // Folder-based fallback — maps vault folders to domains
  const seg = rel.split('/')[0];
  return (
    {
      '00-Inbox': 'personal',
      '01-Building': 'project',
      '02-Thinking': 'project',
      '03-Working': 'work',
      '04-Living': 'personal',
      '05-Relating': 'personal',
      'inbox': 'personal',
    }[seg] ?? 'personal'
  );
}

// ─── vault walker ───────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_SEGMENTS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) {
      if (shouldSkipFile(e.name)) continue;
      out.push(p);
    }
  }
  return out;
}

function scanFile(absPath, relPath) {
  const content = fs.readFileSync(absPath, 'utf-8');
  if (/^---[\s\S]*?\bloops-exclude:\s*true\b[\s\S]*?---/m.test(content)) {
    return [];
  }
  const stat = fs.statSync(absPath);
  const fileMtime = stat.mtimeMs;
  const lines = content.split('\n');

  let currentHeading = null;
  const loops = [];
  const CB = /^(\s*)- \[ \] (.+)$/;
  const HEAD = /^#{2,4}\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(HEAD);
    if (h) {
      currentHeading = h[1].replace(/\*+/g, '').trim();
      continue;
    }
    const m = line.match(CB);
    if (!m) continue;
    const rawText = m[2].trim();
    if (rawText.length < 3) continue;

    const tier = inferTier(rawText, fileMtime, relPath);
    const pLevel = inferPLevel(rawText);
    const difficulty = inferDifficulty(rawText);
    const timeEstimateMinutes = inferTimeMinutes(difficulty);
    const subGroup = currentHeading;
    const workMode = classifyWorkMode(rawText, subGroup);
    const id = stableId(rawText);

    loops.push({
      id,
      tier,
      text: rawText,
      pLevel,
      difficulty,
      timeEstimateMinutes,
      subGroup,
      domain: domainFromFile(relPath, rawText),
      sourceFile: relPath,
      sourceLine: i + 1,
      workMode,
      workModeSource: 'auto',
    });
  }

  return loops;
}

// ─── today-timeblock helpers for tier promotion ─────────────────────

function hasLiveTodayTimeblock(loop, now = new Date()) {
  const blocks = loop.timeblocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  for (const b of blocks) {
    if (b.date !== today) continue;
    const end = typeof b.endMinute === 'number' ? b.endMinute : b.startMinute;
    if (end >= nowMinute) return true;
  }
  return false;
}

// ─── upfront match resolution ───────────────────────────────────────
// Compute the (fresh -> prevId) mapping BEFORE we start emitting
// events so the library sees stable ids on every call. Pass 1 exact
// match + Pass 2 fuzzy Jaccard >= 0.7 are both resolved here.
function resolveStableIds(freshLoops, prevLoops) {
  const prevById = new Map(prevLoops.map((l) => [l.id, l]));
  const usedPrevIds = new Set();
  // Annotate each fresh loop with `stable_id` — either its own id
  // (new create or exact match) or the prev loop's id (fuzzy match).
  const resolved = freshLoops.map((l) => ({ ...l, stable_id: l.id }));

  // Pass 1: exact-id match. Mark prev as used; no id change needed.
  for (const l of resolved) {
    if (prevById.has(l.id)) usedPrevIds.add(l.id);
  }

  // Pass 2: fuzzy match for everything still unmatched.
  const unmatchedIdx = [];
  for (let i = 0; i < resolved.length; i++) {
    if (!usedPrevIds.has(resolved[i].stable_id)) unmatchedIdx.push(i);
  }
  const unusedPrev = prevLoops.filter((p) => !usedPrevIds.has(p.id));

  for (const idx of unmatchedIdx) {
    const l = resolved[idx];
    let best = null;
    let bestScore = 0;
    for (const p of unusedPrev) {
      if (usedPrevIds.has(p.id)) continue;
      const s = jaccard(l.text, p.text);
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    if (best && bestScore >= 0.7) {
      resolved[idx].stable_id = best.id;
      usedPrevIds.add(best.id);
    }
  }

  return resolved;
}

// ─── load prev via the audit library (no direct writes) ─────────────
function loadPrev() {
  try {
    return JSON.parse(fs.readFileSync(LOOPS_JSON, 'utf-8'));
  } catch {
    return { loops: [] };
  }
}

// ─── event emitter via tsx re-exec ──────────────────────────────────
// We import lib/tend-events.ts (TypeScript) through the same tsx
// trampoline the CLI uses. Same env-flag trick: re-exec under
// `node --import tsx` if we weren't launched that way.
if (!process.env.TEND_REFRESH_TSX) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', __filename, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: { ...process.env, TEND_REFRESH_TSX: '1' },
    },
  );
  if (result.status === null) {
    const tsxBin = path.join(LOOPS_UI_ROOT, 'node_modules/.bin/tsx');
    const r2 = spawnSync(tsxBin, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, TEND_REFRESH_TSX: '1' },
    });
    process.exit(r2.status ?? 2);
  }
  process.exit(result.status ?? 2);
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');

  const libUrl = pathToFileURL(
    path.join(LOOPS_UI_ROOT, 'lib/tend-events.ts'),
  ).href;
  const { applyEventToDisk } = await import(libUrl);
  if (typeof applyEventToDisk !== 'function') {
    console.error(
      'refresh-loops: could not import applyEventToDisk from lib/tend-events.ts',
    );
    process.exit(2);
  }

  const prev = loadPrev();
  const prevLoops = Array.isArray(prev.loops) ? prev.loops : [];

  // Walk vault -> fresh scan.
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(VAULT, d)));
  const freshLoops = [];
  for (const abs of files) {
    const rel = path.relative(VAULT, abs);
    try {
      freshLoops.push(...scanFile(abs, rel));
    } catch (err) {
      console.error(`skip ${rel}: ${err.message}`);
    }
  }

  // Resolve stable ids upfront (exact + fuzzy). Resolved loops carry
  // `stable_id` set to whichever prev id they should merge into (or
  // their own hash id for net-new creates).
  const resolved = resolveStableIds(freshLoops, prevLoops);

  // Dry run reports what would happen but never emits events.
  if (dryRun) {
    const prevIds = new Set(prevLoops.map((l) => l.id));
    const exact = resolved.filter((l) => prevIds.has(l.id)).length;
    const fuzzy = resolved.filter(
      (l) => !prevIds.has(l.id) && prevIds.has(l.stable_id),
    ).length;
    const newlyDiscovered = resolved.filter((l) => !prevIds.has(l.stable_id)).length;
    const resolvedIds = new Set(resolved.map((l) => l.stable_id));
    const unmatchedPrev = prevLoops.filter((p) => !resolvedIds.has(p.id));
    const pass3Preserved = unmatchedPrev.filter(
      (p) =>
        p.source?.file === '00-Inbox/manual-loops.md' ||
        p.source?.line === 0 ||
        p.done,
    ).length;
    console.log(
      JSON.stringify(
        {
          mode: 'dry-run',
          total: resolved.length,
          exactMatch: exact,
          fuzzyRekeyed: fuzzy,
          newlyDiscovered,
          pass3Preserved,
          unmatchedPrevDropped: unmatchedPrev.length - pass3Preserved,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Emit one scan_detected_loop event per resolved fresh loop.
  // applyEventToDisk handles the file lock, merge, audit trail, and
  // no-op short-circuit.
  const stats = {
    total: resolved.length,
    applied: 0,
    noop: 0,
    gated: 0,
    rejected: 0,
    errors: [],
  };
  for (const l of resolved) {
    const payload = {
      stable_id: l.stable_id,
      title: l.text,
      sourceFile: l.sourceFile,
      sourceLine: l.sourceLine,
      subGroup: l.subGroup ?? null,
      pLevel: l.pLevel ?? null,
      difficulty: l.difficulty ?? null,
      timeEstimateMinutes: l.timeEstimateMinutes ?? null,
      tier: l.tier ?? null,
      domain: l.domain ?? null,
      workMode: l.workMode ?? null,
      workModeSource: l.workModeSource ?? 'auto',
    };
    try {
      const r = await applyEventToDisk(
        { kind: 'scan_detected_loop', payload },
        'refresh',
      );
      if (r.status === 'applied') {
        if (r.noop) stats.noop++;
        else stats.applied++;
      } else if (r.status === 'gated') {
        stats.gated++;
      } else {
        stats.rejected++;
        stats.errors.push({ id: l.stable_id, error: r.error });
      }
    } catch (err) {
      stats.rejected++;
      stats.errors.push({ id: l.stable_id, error: err?.message ?? String(err) });
    }
  }

  // Tier promotion pass. Re-read loops.json (the library just wrote
  // it) and, for any loop with a live timeblock today that isn't
  // already in the 'now' tier, emit a follow-up scan event with
  // `tier: 'now'`. We reuse scan_detected_loop rather than a new
  // event kind: it already owns the merge-preserve semantics, so a
  // single field update flows through the same code path as any
  // other rescan.
  let promotions = 0;
  try {
    const after = JSON.parse(fs.readFileSync(LOOPS_JSON, 'utf-8'));
    const afterLoops = Array.isArray(after.loops) ? after.loops : [];
    for (const loop of afterLoops) {
      if (loop.done || loop.closedAs) continue;
      if (loop.tier === 'now') continue;
      if (!hasLiveTodayTimeblock(loop)) continue;
      const payload = {
        stable_id: loop.id,
        title: loop.text,
        sourceFile: loop.source?.file ?? '',
        sourceLine: loop.source?.line ?? 0,
        subGroup: loop.subGroup ?? null,
        pLevel: loop.pLevel ?? null,
        difficulty: loop.difficulty ?? null,
        timeEstimateMinutes: loop.timeEstimateMinutes ?? null,
        tier: 'now',
        domain: loop.domain ?? null,
        workMode: loop.workMode ?? null,
        workModeSource: loop.workModeSource ?? 'auto',
      };
      const r = await applyEventToDisk(
        { kind: 'scan_detected_loop', payload },
        'refresh',
      );
      if (r.status === 'applied' && !r.noop) promotions++;
    }
  } catch (err) {
    console.error(`refresh-loops: tier-promotion pass failed: ${err.message}`);
  }

  console.log(
    JSON.stringify(
      {
        mode: 'write',
        ...stats,
        timeblockTierPromotions: promotions,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`refresh-loops: ${err?.stack ?? err?.message ?? err}`);
  process.exit(2);
});
