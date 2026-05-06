import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Server-side introspection for the System panel. Every check is wrapped
// in try/catch — a stranger pointing at their own vault may be missing
// most of these files, and the panel needs a clean status for each row
// rather than a 500.
//
// The same VAULT_ROOT resolution every other route uses, so the System
// panel reports the path the rest of the app is actually reading.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

const LOOPS_PATH = path.join(VAULT_ROOT, '06-Loops/loops.json');
const CAL_PATH = path.join(VAULT_ROOT, '06-Loops/calendar-today.json');
const CONFIG_PATH = path.resolve(process.cwd(), 'loops.config.json');
const COMMANDS_DIR = path.join(VAULT_ROOT, '.claude/commands');
const INBOX_SKILL_PATH = path.join(COMMANDS_DIR, 'inbox.md');

const FILE_COUNT_CAP = 1000;

type Stat = Awaited<ReturnType<typeof fs.stat>>;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(p: string): Promise<Stat | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

// Recursive markdown count. Capped so a giant vault doesn't make the
// panel sluggish — once we hit FILE_COUNT_CAP we stop walking.
async function countMarkdown(root: string): Promise<number> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && count < FILE_COUNT_CAP) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (count >= FILE_COUNT_CAP) break;
      if (ent.name.startsWith('.')) continue; // skip dotdirs / dotfiles
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        count++;
      }
    }
  }
  return count;
}

async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface LoopsFile {
  lastScanned?: string;
  loops?: Array<{
    tendSource?: string;
    updatedAt?: string;
    source?: { url?: string };
  }>;
}

interface ConfigFile {
  stakeholder?: { name?: string };
  self?: { capacityMax?: number };
  priorityCaps?: { P1Flat?: number };
}

interface CalendarFile {
  lastSynced?: string;
  events?: unknown[];
}

function detectClaudeCli(): { detected: boolean; path: string | null } {
  if (process.platform === 'win32') {
    return { detected: false, path: null };
  }
  try {
    const out = execSync('which claude', { stdio: 'pipe' }).toString().trim();
    if (out) return { detected: true, path: out };
    return { detected: false, path: null };
  } catch {
    return { detected: false, path: null };
  }
}

export async function GET() {
  // Vault ───────────────────────────────────────────────────────────
  const vaultExists = await exists(VAULT_ROOT);
  const loopsJson = await readJson<LoopsFile>(LOOPS_PATH);
  const loopsCount = Array.isArray(loopsJson?.loops) ? loopsJson!.loops!.length : 0;
  const lastScan = loopsJson?.lastScanned ?? null;
  const fileCount = vaultExists ? await countMarkdown(VAULT_ROOT) : 0;

  // Config ──────────────────────────────────────────────────────────
  const configJson = await readJson<ConfigFile>(CONFIG_PATH);
  const configPresent = configJson !== null;
  const stakeholderRaw = configJson?.stakeholder?.name?.trim() ?? '';
  const stakeholderName = stakeholderRaw.length > 0 ? stakeholderRaw : null;
  const p1Cap = configJson?.priorityCaps?.P1Flat ?? null;
  const selfCap = configJson?.self?.capacityMax ?? null;

  // Calendar ────────────────────────────────────────────────────────
  const calendarJson = await readJson<CalendarFile>(CAL_PATH);
  const calendarPresent = calendarJson !== null;
  const eventCount = Array.isArray(calendarJson?.events)
    ? calendarJson!.events!.length
    : 0;
  const lastSynced = calendarJson?.lastSynced ?? null;

  // Claude CLI ──────────────────────────────────────────────────────
  const claude = detectClaudeCli();

  // Obsidian env ────────────────────────────────────────────────────
  const vaultName = process.env.NEXT_PUBLIC_OBSIDIAN_VAULT ?? null;
  const envSet = !!vaultName && vaultName.length > 0;

  // Extension heuristic ─────────────────────────────────────────────
  // Per spec: any loop with tendSource:'manual' AND a source.url field
  // implies the Chrome capture extension has fired at least once.
  // lastCapture is the most recent updatedAt across those loops.
  let likelyInstalled = false;
  let lastCapture: string | null = null;
  if (Array.isArray(loopsJson?.loops)) {
    for (const l of loopsJson!.loops!) {
      if (l?.tendSource === 'manual' && typeof l?.source?.url === 'string' && l.source.url.length > 0) {
        likelyInstalled = true;
        if (typeof l.updatedAt === 'string') {
          if (lastCapture === null || l.updatedAt > lastCapture) {
            lastCapture = l.updatedAt;
          }
        }
      }
    }
  }

  // MCP / skills ────────────────────────────────────────────────────
  const inboxSkillPresent = await exists(INBOX_SKILL_PATH);
  let skillCount = 0;
  try {
    const entries = await fs.readdir(COMMANDS_DIR, { withFileTypes: true });
    skillCount = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.md'),
    ).length;
  } catch {
    skillCount = 0;
  }

  return NextResponse.json({
    vault: {
      path: VAULT_ROOT,
      exists: vaultExists,
      loopsCount,
      lastScan,
      fileCount,
    },
    config: {
      present: configPresent,
      stakeholderName,
      p1Cap,
      selfCap,
    },
    calendar: {
      present: calendarPresent,
      eventCount,
      lastSynced,
    },
    claudeCli: {
      detected: claude.detected,
      path: claude.path,
    },
    obsidian: {
      envSet,
      vaultName,
    },
    extension: {
      likelyInstalled,
      lastCapture,
    },
    mcp: {
      inboxSkillPresent,
      skillCount,
    },
    env: {
      nodeVersion: process.version,
      cwd: process.cwd(),
    },
  });
}
