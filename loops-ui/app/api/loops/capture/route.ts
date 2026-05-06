import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// POST /api/loops/capture — single-entry capture endpoint used by the
// Chrome extension (and any other client). Two flavours:
//
//   kind: 'loop' (default)  → appends a triage-status loop to
//                              06-Loops/loops.json. Use this for
//                              thoughts/tasks that need a decision.
//   kind: 'clip'            → writes a markdown file to
//                              00-Inbox/clips/<date>-<slug>.md with
//                              frontmatter. Use this for quotes,
//                              articles, anything you want to keep
//                              without going through triage.
//
// Body: { text, source?, priority?, stakeholder?, tags?, kind? }
// Response: { ok: true, id?, path? }

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

const LOOPS_FILE = path.join(VAULT_ROOT, '06-Loops/loops.json');
const CLIPS_DIR = path.join(VAULT_ROOT, '00-Inbox/clips');

interface CaptureBody {
  text?: string;
  source?: { title?: string; url?: string };
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  stakeholder?: string;
  // Free-form tags. For loops they get appended as inline #tag markers
  // (so they're searchable). For clips they go into frontmatter.
  tags?: string[];
  // 'loop' (default) → triage-status loop in loops.json.
  // 'clip' → markdown file in 00-Inbox/clips/. No triage decision.
  kind?: 'loop' | 'clip';
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timestampSuffix(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}

function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((t) => String(t).trim().replace(/^#/, '').replace(/[^a-zA-Z0-9_-]/g, ''))
        .filter((t) => t.length > 0 && t.length <= 32),
    ),
  );
}

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  let body: CaptureBody;
  try {
    body = (await request.json()) as CaptureBody;
  } catch {
    return NextResponse.json(
      { error: 'invalid JSON' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const note = (body.text ?? '').trim();
  const title = body.source?.title?.trim() ?? '';
  const url = body.source?.url?.trim() ?? '';
  const tags = sanitizeTags(body.tags);
  const kind: 'loop' | 'clip' = body.kind === 'clip' ? 'clip' : 'loop';

  if (!note && !url && !title) {
    return NextResponse.json(
      { error: 'text or source.url required' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // ─── Clip → write a markdown file ────────────────────────────────
  if (kind === 'clip') {
    // Filename: <date>-<slug>.md, deduped with a HHmm timestamp on
    // collision. Slug seeded from the user's note (first non-empty
    // line) or the page title.
    const seedRaw =
      (note.split('\n').find((l) => l.trim().length > 0) ?? '').trim() ||
      title ||
      'clip';
    const slugBase = slugify(seedRaw) || 'clip';
    const date = todayISO();

    let filename = `${date}-${slugBase}.md`;
    let absPath = path.join(CLIPS_DIR, filename);
    try {
      await fs.access(absPath);
      filename = `${date}-${slugBase}-${timestampSuffix()}.md`;
      absPath = path.join(CLIPS_DIR, filename);
    } catch {
      // File doesn't exist yet — go with the simple name.
    }

    const fmTags = tags.length > 0 ? `[${tags.join(', ')}]` : '[]';
    const frontmatter = [
      '---',
      `created: ${date}`,
      `type: clip`,
      `status: active`,
      `tags: ${fmTags}`,
      title ? `source_title: ${JSON.stringify(title)}` : null,
      url ? `source_url: ${url}` : null,
      '---',
    ]
      .filter((line) => line !== null)
      .join('\n');

    // Body: user's note + page link footer. Note may already contain
    // a blockquote (the popup renders selections as `> `).
    const bodyParts: string[] = [];
    if (title) bodyParts.push(`# ${title}`);
    if (note) bodyParts.push(note);
    if (url) {
      bodyParts.push(
        `— from ${title ? `[${title}](${url})` : url}`,
      );
    }
    const fileContent = `${frontmatter}\n\n${bodyParts.join('\n\n')}\n`;

    try {
      await fs.mkdir(CLIPS_DIR, { recursive: true });
      await fs.writeFile(absPath, fileContent, 'utf-8');
    } catch (err) {
      return NextResponse.json(
        { error: `clip write failed: ${err}` },
        { status: 500, headers: CORS_HEADERS },
      );
    }

    const relPath = path.relative(VAULT_ROOT, absPath);
    return NextResponse.json(
      { ok: true, kind: 'clip', path: relPath },
      { headers: CORS_HEADERS },
    );
  }

  // ─── Loop → triage-status loop in loops.json ─────────────────────
  let text: string;
  if (note && url) {
    text = `${note}\n\n— from ${title ? `[${title}](${url})` : url}`;
  } else if (note) {
    text = note;
  } else if (title && url) {
    text = `[${title}](${url})`;
  } else {
    text = url || title;
  }
  if (tags.length > 0) {
    text = `${text}\n\n${tags.map((t) => `#${t}`).join(' ')}`;
  }

  const priority = body.priority ?? 'P3';
  const pLevel = body.stakeholder
    ? `${priority}:${body.stakeholder}`
    : priority;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const loop = {
    id,
    tier: 'now',
    text,
    pLevel,
    status: 'triage',
    difficulty: null,
    timeEstimateMinutes: null,
    subGroup: null,
    domain: 'personal',
    source: { file: '00-Inbox/captured.md', line: 1 },
    timeblocks: [],
    done: false,
    updatedAt: now,
    tendSource: 'manual',
  };

  let data: { lastScanned: string; loops: unknown[] };
  try {
    const raw = await fs.readFile(LOOPS_FILE, 'utf-8');
    data = JSON.parse(raw);
    if (!Array.isArray(data.loops)) data.loops = [];
  } catch {
    data = { lastScanned: '', loops: [] };
  }
  data.loops.push(loop);

  try {
    await fs.mkdir(path.dirname(LOOPS_FILE), { recursive: true });
    await fs.writeFile(LOOPS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    return NextResponse.json(
      { error: `write failed: ${err}` },
      { status: 500, headers: CORS_HEADERS },
    );
  }

  return NextResponse.json(
    { ok: true, kind: 'loop', id },
    { headers: CORS_HEADERS },
  );
}
