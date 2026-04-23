import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Polling clients hit this route every 10 s while visible. Force the
// handler dynamic so Next doesn't cache the response at build time
// and our If-None-Match / 304 logic can run per request.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');
const LOOPS_PATH = path.join(VAULT_ROOT, '06-Loops/loops.json');

// Self-healing done-state reconciler. The principle the user asked for:
// "if it's checked off anywhere it's done." The UI mutates both the
// source file and loops.json when you press Done/Drop, but the vault
// can also be edited directly in Obsidian. On every GET we walk loops,
// look up the source line in its markdown file, and do a union:
//
//     effectiveDone = loops.json.done OR sourceHas[x]
//
// When the two sides disagree we also fix the disagreement so they
// stop drifting: loops.json gets done=true and the source gets [x]
// written if needed. Fuzzy line matching (by word overlap) absorbs
// the common case where text drifts after the initial scan.
const CHECKBOX_RE = /- \[([ xX\-])\]/;

import { similarity } from '@/lib/fuzzy-match';

type Tier = 'now' | 'soon' | 'someday';

type Loop = {
  id: string;
  text: string;
  tier?: Tier;
  done?: boolean;
  closedAs?: 'done' | 'dropped';
  pLevel?: string | null;
  priority?: string | null;
  pinned_to_week?: boolean;
  timeblocks?: Array<{ date?: string; startMinute?: number; endMinute?: number }>;
  source?: { file: string; line: number };
  [k: string]: unknown;
};

type FileCache = Map<string, string[]>;

async function readSourceLines(
  relFile: string,
  cache: FileCache,
): Promise<string[] | null> {
  if (cache.has(relFile)) return cache.get(relFile)!;
  try {
    const abs = path.join(VAULT_ROOT, relFile);
    const content = await fs.readFile(abs, 'utf-8');
    const lines = content.split('\n');
    cache.set(relFile, lines);
    return lines;
  } catch {
    return null;
  }
}

// Returns the index (0-based) of the checkbox line matching this loop,
// or -1. Prefers the stored line number, falls back to fuzzy similarity
// against all checkbox lines in the file.
function findLineIdx(loop: Loop, lines: string[]): number {
  const stored = (loop.source?.line ?? 0) - 1;
  if (stored >= 0 && stored < lines.length && CHECKBOX_RE.test(lines[stored])) {
    // Only trust the stored line if it's clearly the same task.
    if (similarity(loop.text, lines[stored]) >= 0.4) return stored;
  }
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!CHECKBOX_RE.test(lines[i])) continue;
    const s = similarity(loop.text, lines[i]);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return bestScore >= 0.5 ? bestIdx : -1;
}

function lineIsDone(line: string): boolean {
  const m = line.match(CHECKBOX_RE);
  if (!m) return false;
  const ch = m[1];
  return ch === 'x' || ch === 'X' || ch === '-';
}

async function reconcileDoneState(
  parsed: { loops?: Loop[] },
): Promise<{ changedInJson: boolean; sourceWrites: Set<string> }> {
  if (!Array.isArray(parsed?.loops)) {
    return { changedInJson: false, sourceWrites: new Set() };
  }
  const cache: FileCache = new Map();
  const sourceWrites = new Set<string>();
  let changedInJson = false;
  const now = new Date().toISOString();

  for (const loop of parsed.loops) {
    if (!loop.source?.file) continue;
    const lines = await readSourceLines(loop.source.file, cache);
    if (!lines) continue;
    const idx = findLineIdx(loop, lines);
    if (idx < 0) continue;
    const vaultDone = lineIsDone(lines[idx]);
    const jsonDone = !!loop.done;

    if (vaultDone && !jsonDone) {
      // Vault says done, JSON says open → JSON catches up.
      loop.done = true;
      if (!loop.closedAs) loop.closedAs = 'done';
      if (!loop.doneAt) loop.doneAt = now;
      loop.updatedAt = now;
      changedInJson = true;
    } else if (!vaultDone && jsonDone) {
      // JSON says done, vault still open → write it back to vault.
      // Preserve the close disposition: drop → [-], done → [x].
      const marker = loop.closedAs === 'dropped' ? '- [-]' : '- [x]';
      lines[idx] = lines[idx].replace(CHECKBOX_RE, marker);
      sourceWrites.add(loop.source.file);
    }
  }

  for (const file of sourceWrites) {
    const lines = cache.get(file);
    if (!lines) continue;
    const abs = path.join(VAULT_ROOT, file);
    const tmp = `${abs}.tmp`;
    try {
      await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
      await fs.rename(tmp, abs);
    } catch {
      // If we can't write, the vault stays out of sync but the JSON
      // state wins. Not fatal — next GET will try again.
    }
  }

  return { changedInJson, sourceWrites };
}

// Work-mode classifier is shared with the client UI via lib/ui.ts.
import { classifyWorkMode } from '@/lib/ui';

/**
 * Tier is derived on every read, not user-set. Rules:
 *
 *   'now'     — has a live timeblock today OR has any timeblock in
 *               the current week OR pinned_to_week === true
 *   'soon'    — priority ∈ {P0, P1} or pLevel starts with 'P0'|'P1'
 *               and not already 'now'
 *   'someday' — everything else
 *
 * Clients keep reading `loop.tier` without knowing it's derived. The
 * `pinned_to_week` flag is the user's manual override: toggle it with
 * `w` in Plan mode to force a loop into Now without scheduling it on
 * the calendar.
 */
function deriveTierForAll(loops: Loop[]): number {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  const nowMinute = now.getHours() * 60 + now.getMinutes();

  // Week window: Monday 00:00 through Sunday 23:59 local.
  const dow = now.getDay(); // 0 = Sunday
  const daysSinceMonday = (dow + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  const toISO = (dt: Date): string => {
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  const mondayISO = toISO(monday);
  const sundayISO = toISO(sunday);

  let changed = 0;
  for (const loop of loops) {
    if (loop.done || loop.closedAs) continue;

    let next: Tier = 'someday';

    // Rule 1: live or scheduled this week → now
    const blocks = (loop.timeblocks as
      | { date?: string; startMinute?: number; endMinute?: number }[]
      | undefined) ?? [];
    let hasWeekBlock = false;
    let hasLiveTodayBlock = false;
    for (const b of blocks) {
      if (!b?.date) continue;
      if (b.date >= mondayISO && b.date <= sundayISO) hasWeekBlock = true;
      if (b.date === today) {
        const end = typeof b.endMinute === 'number' ? b.endMinute : b.startMinute ?? 0;
        if (end >= nowMinute) hasLiveTodayBlock = true;
      }
    }

    if (hasLiveTodayBlock || hasWeekBlock || loop.pinned_to_week) {
      next = 'now';
    } else {
      // Rule 2: high-priority but not yet scheduled → soon
      const priority = loop.priority as string | null | undefined;
      const pLevelHead = (loop.pLevel ?? '').split(':')[0];
      const isHigh =
        priority === 'P0' || priority === 'P1' ||
        pLevelHead === 'P0' || pLevelHead === 'P1';
      next = isHigh ? 'soon' : 'someday';
    }

    if (loop.tier !== next) {
      loop.tier = next;
      changed++;
    }
  }
  return changed;
}

// Triage gate migration — idempotent. For every loop without
// `legacy_priority`, split the existing pLevel into flat priority +
// stakeholder fields, stash the original pLevel in legacy_priority,
// and derive a status from the legacy done/blocked/closedAs state.
// Returns true if any loop was touched so the caller can persist.
function migrateTriageFields(parsed: { loops?: Loop[] }): boolean {
  if (!Array.isArray(parsed?.loops)) return false;
  let changed = false;
  for (const l of parsed.loops as Loop[] & Record<string, unknown>[]) {
    // Priority migration: gated on legacy_priority presence so we
    // never overwrite user edits.
    if (l.legacy_priority === undefined || l.legacy_priority === null) {
      const p = typeof l.pLevel === 'string' ? l.pLevel : null;
      l.legacy_priority = p ?? '';
      if (p) {
        const colon = p.indexOf(':');
        const left = colon >= 0 ? p.slice(0, colon) : p;
        const right = colon >= 0 ? p.slice(colon + 1).trim() : '';
        let priority: 'P0' | 'P1' | 'P2' | 'P3' | null = null;
        if (left === 'P0') priority = 'P0';
        else if (left === 'P1') priority = 'P1';
        else if (left === 'P2') priority = 'P2';
        else if (left === 'P3' || left === 'P4') priority = 'P3';
        if (l.priority === undefined) l.priority = priority;
        if (l.stakeholder === undefined) {
          const raw = right.length > 0 ? right : null;
          l.stakeholder =
            raw && raw.toLowerCase() === 'self' ? 'Self' : raw;
        }
      } else {
        if (l.priority === undefined) l.priority = null;
        if (l.stakeholder === undefined) l.stakeholder = null;
      }
      changed = true;
    }
    // Status derivation — only when field is missing.
    if (l.status === undefined) {
      if (l.done) {
        l.status = l.closedAs === 'dropped' ? 'dropped' : 'completed';
      } else if (l.blocked) {
        l.status = 'blocked';
      } else {
        l.status = 'active';
      }
      changed = true;
    }
  }
  return changed;
}

// Compute a weak ETag from mtime + size + loop count. Cheap enough
// to run on every GET; sufficient to detect genuine changes without
// hashing the whole file. Clients sending `If-None-Match` with a
// matching tag get a 304 with no body.
async function computeLoopsEtag(
  stat: { mtimeMs: number; size: number },
  loopCount: number,
): Promise<string> {
  const basis = `${stat.mtimeMs}:${stat.size}:${loopCount}`;
  const hash = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
  return `W/"loops-${hash}"`;
}

// Best-effort: on a cold-clone first boot, the vault won't have a
// `06-Loops/loops.json` yet. Rather than 500 the UI into a scary error
// screen, we create an empty file so the GET proceeds normally and the
// user sees an empty board. Idempotent: once the file exists, this
// no-ops.
async function ensureLoopsFile(): Promise<void> {
  try {
    await fs.access(LOOPS_PATH);
    return;
  } catch {
    // fall through to create
  }
  try {
    const dir = path.dirname(LOOPS_PATH);
    await fs.mkdir(dir, { recursive: true });
    const empty = JSON.stringify({ lastScanned: '', loops: [] }, null, 2);
    const tmp = `${LOOPS_PATH}.init.tmp`;
    await fs.writeFile(tmp, empty, 'utf-8');
    await fs.rename(tmp, LOOPS_PATH);
  } catch {
    // Non-fatal — the main GET will surface any permission issue.
  }
}

export async function GET(request: Request) {
  try {
    await ensureLoopsFile();
    const stat = await fs.stat(LOOPS_PATH);
    const raw = await fs.readFile(LOOPS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const loopCount = Array.isArray(parsed?.loops) ? parsed.loops.length : 0;
    const etag = await computeLoopsEtag(stat, loopCount);
    const incoming = request.headers.get('if-none-match');
    if (incoming && incoming === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Work-mode backfill (same as before).
    if (Array.isArray(parsed?.loops)) {
      for (const l of parsed.loops) {
        if (l.workModeSource === 'manual' && l.workMode) continue;
        l.workMode = classifyWorkMode(l.text, l.subGroup);
        l.workModeSource = 'auto';
      }
    }

    // Derive tier for every loop based on schedule + pin + priority.
    // This overwrites whatever refresh-loops or a stale client wrote.
    let tierPromoted = 0;
    if (Array.isArray(parsed?.loops)) {
      tierPromoted = deriveTierForAll(parsed.loops as Loop[]);
    }

    // Triage gate priority + status migration (idempotent).
    const triageChanged = migrateTriageFields(parsed);

    // Self-healing done-state reconciliation. See reconcileDoneState
    // above for the full rule set. If either side (vault or
    // loops.json) says a loop is done, both sides get flipped to done.
    const { changedInJson } = await reconcileDoneState(parsed);
    if (changedInJson || triageChanged || tierPromoted > 0) {
      try {
        const tmp = `${LOOPS_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf-8');
        await fs.rename(tmp, LOOPS_PATH);
      } catch {
        // Non-fatal — return the reconciled view even if we can't
        // persist the write. Next GET will retry.
      }
    }

    // If the reconcile pass rewrote loops.json, recompute the ETag
    // against the fresh stat so clients cache the post-reconcile
    // shape (otherwise a follow-up poll would send an ETag that
    // matches the now-stale pre-reconcile response and we'd 304
    // them onto their stale copy).
    let responseEtag = etag;
    if (changedInJson || triageChanged) {
      try {
        const freshStat = await fs.stat(LOOPS_PATH);
        responseEtag = await computeLoopsEtag(freshStat, loopCount);
      } catch {
        /* fall back to the pre-reconcile tag */
      }
    }
    // Inject _sourceLineCount for context hygiene indicators. Uses a
    // lightweight stat pass — only reads files we haven't already cached.
    if (Array.isArray(parsed?.loops)) {
      const lineCountCache = new Map<string, number>();
      for (const l of parsed.loops) {
        const file = l.source?.file;
        if (!file) continue;
        if (lineCountCache.has(file)) {
          (l as Record<string, unknown>)._sourceLineCount = lineCountCache.get(file);
          continue;
        }
        try {
          const abs = path.join(VAULT_ROOT, file);
          const content = await fs.readFile(abs, 'utf-8');
          const count = content.split('\n').length;
          lineCountCache.set(file, count);
          (l as Record<string, unknown>)._sourceLineCount = count;
        } catch {
          lineCountCache.set(file, 0);
        }
      }
    }

    return NextResponse.json(parsed, {
      headers: {
        ETag: responseEtag,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read loops.json: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();

    // Merge-by-id against disk instead of replacing wholesale. Stale
    // clients that loaded before a refresh-loops.mjs run must not be
    // able to drop the loops they never saw. Rules:
    //   - Loop in both body and disk → client wins (it's their edit).
    //   - Loop on disk only → keep as-is (client didn't touch it).
    //   - Loop in body only → accept as new (client added it).
    //   - Deletion is out-of-band (vault edit → next rescan).
    //
    // Also stamps updatedAt on any client-edited loop whose tracked
    // field serialization differs from disk.
    const now = new Date().toISOString();
    let diskById = new Map<string, Record<string, unknown>>();
    try {
      const prevRaw = await fs.readFile(LOOPS_PATH, 'utf-8');
      const prev = JSON.parse(prevRaw);
      if (Array.isArray(prev?.loops)) {
        for (const l of prev.loops) diskById.set(l.id, l);
      }
    } catch {
      diskById = new Map();
    }

    const TRACKED = [
      'text',
      'tier',
      'pLevel',
      'difficulty',
      'timeEstimateMinutes',
      'subGroup',
      'timeblocks',
      'notes',
      'workMode',
      'workModeSource',
      'blocked',
      'dueDate',
      'closedAs',
      'done',
    ] as const;

    if (Array.isArray(body?.loops)) {
      const bodyIds = new Set<string>();
      const merged: Record<string, unknown>[] = [];

      for (const l of body.loops) {
        bodyIds.add(l.id);
        const disk = diskById.get(l.id);
        if (!disk) {
          l.updatedAt = now;
        } else {
          const changed = TRACKED.some(
            (k) => JSON.stringify(disk[k]) !== JSON.stringify(l[k]),
          );
          if (changed) l.updatedAt = now;
        }
        merged.push(l);
      }
      // Preserve disk-only loops (the ones the client never had in
      // memory). This is the whole point of the merge — a client that
      // loaded 293 loops yesterday should not be able to delete the 88
      // loops that refresh-loops.mjs discovered this morning.
      for (const [id, disk] of diskById) {
        if (!bodyIds.has(id)) merged.push(disk);
      }
      body.loops = merged;
    }

    // Re-derive tier on write too so a client-side optimistic
    // update can't persist a wrong tier to disk.
    if (Array.isArray(body?.loops)) {
      deriveTierForAll(body.loops as Loop[]);
    }
    const tmpPath = `${LOOPS_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(body, null, 2), 'utf-8');
    await fs.rename(tmpPath, LOOPS_PATH);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to write loops.json: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
