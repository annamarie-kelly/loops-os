import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { ResearchCategory, ResearchDoc } from '@/lib/types';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

// Folder → category mapping
const FOLDER_CATEGORIES: Array<{
  folder: string;
  category: ResearchCategory;
  recursive: boolean;
  extensions?: string[];
}> = [
  { folder: '01-Creating/artifacts', category: 'artifact', recursive: false, extensions: ['.html'] },
  { folder: '02-Thinking/reports', category: 'strategic-research', recursive: false },
  { folder: '02-Thinking/Agent Investigations', category: 'technical-investigation', recursive: false },
  { folder: '02-Thinking', category: 'foundational', recursive: false },
];

// Inbox patterns that count as strategic research
const INBOX_PATTERNS = ['Deep Research'];

// Keywords that indicate design-research (vs foundational)
const DESIGN_KEYWORDS = [
  'psychological', 'interaction', 'cognitive', 'therapeutic',
  'theory of mind', 'emotional', 'narrative', 'person model',
];

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let val: unknown = line.slice(colon + 1).trim();
    // Handle array syntax: [tag1, tag2]
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    result[key] = val;
  }
  return result;
}

function extractTitle(content: string): string {
  // Look for first H1 after frontmatter
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  const h1 = stripped.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : '';
}

function extractSummary(content: string): string {
  // First non-empty, non-heading paragraph after the title
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  const lines = stripped.split('\n');
  let pastTitle = false;
  const paragraph: string[] = [];
  for (const line of lines) {
    if (!pastTitle) {
      if (line.startsWith('# ')) { pastTitle = true; continue; }
      if (line.trim() === '') continue;
      // No H1 found, start collecting
      pastTitle = true;
    }
    if (line.trim() === '' && paragraph.length > 0) break;
    if (line.startsWith('#') || line.startsWith('---')) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.trim()) paragraph.push(line.trim());
  }
  const full = paragraph.join(' ');
  return full.length > 200 ? full.slice(0, 197) + '...' : full;
}

function countOpenTasks(content: string): number {
  return (content.match(/- \[ \]/g) || []).length;
}

function categorizeThinkingDoc(
  filePath: string,
  content: string,
): ResearchCategory {
  const lower = (filePath + ' ' + content.slice(0, 2000)).toLowerCase();
  if (DESIGN_KEYWORDS.some((kw) => lower.includes(kw))) {
    return 'design-research';
  }
  return 'foundational';
}

async function scanFolder(
  folderAbs: string,
  defaultCategory: ResearchCategory,
  recursive: boolean,
  extensions: string[] = ['.md'],
): Promise<ResearchDoc[]> {
  const docs: ResearchDoc[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(folderAbs, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return docs;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    const ext = path.extname(name);
    if (!entry.isFile() || !extensions.includes(ext)) continue;
    // Skip index/pattern files
    if (name.startsWith('_')) continue;

    const isHtml = ext === '.html';
    const abs = path.join(folderAbs, name);
    const rel = path.relative(VAULT_ROOT, abs);
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(abs, 'utf-8'),
        fs.stat(abs),
      ]);

      let title: string;
      let summary: string;
      let fm: Record<string, unknown> = {};
      if (isHtml) {
        // Extract title from <title> tag or filename
        const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
        title = titleMatch ? titleMatch[1].replace(/^[\w]+\s*[—–-]\s*/, '') : name.replace('.html', '');
        // Extract subtitle from .page-lead or meta description
        const leadMatch = content.match(/class="page-lead"[^>]*>([^<]+)/);
        summary = leadMatch ? leadMatch[1].trim() : 'Visual artifact';
      } else {
        fm = parseYamlFrontmatter(content);
        title = extractTitle(content) || name.replace('.md', '');
        summary = extractSummary(content);
      }

      const createdAt = (fm.created as string) || stat.birthtime.toISOString().slice(0, 10);
      const updatedAt = stat.mtime.toISOString();
      const staleDays = Math.floor(
        (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24),
      );

      // For top-level 02-Thinking, re-categorize based on content
      let category = defaultCategory;
      if (defaultCategory === 'foundational') {
        category = categorizeThinkingDoc(rel, content);
      }

      docs.push({
        id: crypto.createHash('md5').update(rel).digest('hex').slice(0, 12),
        title,
        summary,
        filePath: rel,
        category,
        createdAt,
        updatedAt,
        staleDays,
        tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
        type: isHtml ? 'artifact' : (fm.type as string) || 'unknown',
        status: (fm.status as string) || 'active',
        sizeBytes: stat.size,
        openTaskCount: isHtml ? 0 : countOpenTasks(content),
        favorite: fm.favorite === 'true' || fm.favorite === true,
        isHtml,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return docs;
}

async function scanInboxResearch(): Promise<ResearchDoc[]> {
  const inboxDir = path.join(VAULT_ROOT, '00-Inbox');
  const docs: ResearchDoc[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return docs;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    if (!entry.isFile() || !name.endsWith('.md')) continue;
    if (!INBOX_PATTERNS.some((p) => name.includes(p))) continue;

    const abs = path.join(inboxDir, name);
    const rel = path.relative(VAULT_ROOT, abs);
    try {
      const [content, stat] = await Promise.all([
        fs.readFile(abs, 'utf-8'),
        fs.stat(abs),
      ]);

      const fm = parseYamlFrontmatter(content);
      const title = extractTitle(content) || name.replace('.md', '');
      const summary = extractSummary(content);
      const createdAt = (fm.created as string) || stat.birthtime.toISOString().slice(0, 10);
      const updatedAt = stat.mtime.toISOString();
      const staleDays = Math.floor(
        (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24),
      );

      docs.push({
        id: crypto.createHash('md5').update(rel).digest('hex').slice(0, 12),
        title,
        summary,
        filePath: rel,
        category: 'strategic-research',
        createdAt,
        updatedAt,
        staleDays,
        tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
        type: (fm.type as string) || 'unknown',
        status: (fm.status as string) || 'unknown',
        sizeBytes: stat.size,
        openTaskCount: countOpenTasks(content),
        favorite: fm.favorite === 'true' || fm.favorite === true,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return docs;
}

export async function GET(request: Request) {
  // Dedupe by file path (02-Thinking top-level scan may overlap with
  // reports/ or Agent Investigations/ — those specific folders win)
  const seen = new Set<string>();
  const allDocs: ResearchDoc[] = [];

  // Scan specific folders first (they take priority)
  for (const { folder, category, recursive, extensions } of FOLDER_CATEGORIES) {
    const folderAbs = path.join(VAULT_ROOT, folder);
    const docs = await scanFolder(folderAbs, category, recursive, extensions);
    for (const doc of docs) {
      if (!seen.has(doc.filePath)) {
        seen.add(doc.filePath);
        allDocs.push(doc);
      }
    }
  }

  // Scan inbox for deep research docs
  const inboxDocs = await scanInboxResearch();
  for (const doc of inboxDocs) {
    if (!seen.has(doc.filePath)) {
      seen.add(doc.filePath);
      allDocs.push(doc);
    }
  }

  // Sort: stale first, then by title
  allDocs.sort((a, b) => b.staleDays - a.staleDays || a.title.localeCompare(b.title));

  // ETag based on newest mtime for 304 support
  const newestMtime = allDocs.reduce(
    (max, d) => Math.max(max, new Date(d.updatedAt).getTime()),
    0,
  );
  const etag = `"research-${newestMtime}-${allDocs.length}"`;
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  return NextResponse.json(
    { docs: allDocs },
    { headers: { ETag: etag, 'Cache-Control': 'no-cache' } },
  );
}

// ─── Toggle favorite ────────────────────────────────────────────
export async function PATCH(request: Request) {
  const { filePath, favorite } = await request.json() as {
    filePath: string;
    favorite: boolean;
  };

  if (!filePath || typeof favorite !== 'boolean') {
    return NextResponse.json({ error: 'Missing filePath or favorite' }, { status: 400 });
  }

  const abs = path.join(VAULT_ROOT, filePath);
  // Safety: ensure file is inside vault
  if (!abs.startsWith(VAULT_ROOT)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    let content = await fs.readFile(abs, 'utf-8');
    const hasFrontmatter = content.startsWith('---\n');

    if (hasFrontmatter) {
      const fmEnd = content.indexOf('\n---', 4);
      if (fmEnd >= 0) {
        const fm = content.slice(0, fmEnd);
        const rest = content.slice(fmEnd);
        if (/^favorite:\s*.+$/m.test(fm)) {
          // Replace existing favorite field
          content = fm.replace(/^favorite:\s*.+$/m, `favorite: ${favorite}`) + rest;
        } else {
          // Add favorite before closing ---
          content = fm + `\nfavorite: ${favorite}` + rest;
        }
      }
    } else {
      // No frontmatter — add it
      content = `---\nfavorite: ${favorite}\n---\n\n${content}`;
    }

    await fs.writeFile(abs, content, 'utf-8');
    return NextResponse.json({ ok: true, favorite });
  } catch {
    return NextResponse.json({ error: 'Failed to update file' }, { status: 500 });
  }
}
