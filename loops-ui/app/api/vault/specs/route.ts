import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { SpecDoc, SpecStatus } from '@/lib/types';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

const SPECS_FOLDER = '01-Creating/Oasis — Agent Specs';
// Codebase docs folders — HTML files here show as "shipped" artifacts.
const CODEBASE_DOCS: { dir: string; repo: string }[] = [
  { dir: path.resolve(process.env.HOME || '', 'dev/digital-garden/docs'), repo: 'backend' },
  { dir: path.resolve(process.env.HOME || '', 'dev/ios-oasis/docs'), repo: 'ios' },
  { dir: path.resolve(process.env.HOME || '', 'dev/web-oasis/docs'), repo: 'web' },
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
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    result[key] = val;
  }
  return result;
}

function extractTitle(content: string): string {
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  const h1 = stripped.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : '';
}

// Extract items from ## Open Questions section
function extractOpenQuestions(content: string): string[] {
  const match = content.match(/##\s+Open\s+Questions\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
  if (!match) return [];
  const section = match[1];
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*+]\s+\[?\s?\]?\s*(.+)/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

// Derive spec status from frontmatter. Existing specs use "active" —
// map that to our SpecStatus. New specs will use drafting/ready/building/shipped.
function deriveSpecStatus(fm: Record<string, unknown>): SpecStatus {
  const raw = (fm.status as string) || '';
  if (['drafting', 'ready', 'building', 'shipped'].includes(raw)) {
    return raw as SpecStatus;
  }
  // Legacy mapping
  if (raw === 'active') return 'ready';
  if (raw === 'done' || raw === 'archived') return 'shipped';
  if (raw === 'someday') return 'drafting';
  return 'drafting';
}

// Count loops whose text or source.file references this spec
function countLinkedLoops(
  specRelPath: string,
  loopsData: { loops?: Array<{ text?: string; source?: { file?: string }; done?: boolean }> },
): number {
  if (!loopsData?.loops) return 0;
  const specName = specRelPath.replace(/\.md$/, '');
  return loopsData.loops.filter((l) => {
    if (l.done) return false;
    const inSource = l.source?.file?.includes(specRelPath) ?? false;
    const inText = l.text?.includes(specName) ?? false;
    return inSource || inText;
  }).length;
}

export async function GET() {
  const specsDir = path.join(VAULT_ROOT, SPECS_FOLDER);

  // Load loops.json for cross-referencing
  let loopsData: { loops?: Array<{ text?: string; source?: { file?: string }; done?: boolean }> } = {};
  try {
    const raw = await fs.readFile(path.join(VAULT_ROOT, '06-Loops/loops.json'), 'utf-8');
    loopsData = JSON.parse(raw);
  } catch {}

  let entries: Dirent[];
  try {
    entries = await fs.readdir(specsDir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return NextResponse.json({ specs: [] });
  }

  const specs: SpecDoc[] = [];

  for (const entry of entries) {
    const name = String(entry.name);
    if (!entry.isFile() || !name.endsWith('.md')) continue;
    if (name.startsWith('_')) continue;

    const abs = path.join(specsDir, name);
    const rel = path.relative(VAULT_ROOT, abs);

    try {
      const [content, stat] = await Promise.all([
        fs.readFile(abs, 'utf-8'),
        fs.stat(abs),
      ]);

      const fm = parseYamlFrontmatter(content);
      const title = extractTitle(content) || name.replace('.md', '');
      const createdAt = (fm.created as string) || stat.birthtime.toISOString().slice(0, 10);
      const updatedAt = stat.mtime.toISOString();
      const staleDays = Math.floor(
        (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24),
      );

      const sourceResearch: string[] = [];
      if (fm.source_research) {
        if (Array.isArray(fm.source_research)) {
          sourceResearch.push(...(fm.source_research as string[]));
        } else if (typeof fm.source_research === 'string') {
          sourceResearch.push(fm.source_research);
        }
      }
      // Also extract wikilink references to 02-Thinking
      const wikiRefs = content.match(/\[\[02-Thinking\/[^\]]+\]\]/g);
      if (wikiRefs) {
        for (const ref of wikiRefs) {
          const p = ref.replace('[[', '').replace(']]', '');
          if (!sourceResearch.includes(p)) sourceResearch.push(p);
        }
      }

      specs.push({
        id: crypto.createHash('md5').update(rel).digest('hex').slice(0, 12),
        title,
        filePath: rel,
        status: deriveSpecStatus(fm),
        effortEstimate: (fm.effort as string) || null,
        openQuestions: extractOpenQuestions(content),
        createdAt,
        updatedAt,
        staleDays,
        sourceResearch,
        linkedLoopCount: countLinkedLoops(rel, loopsData),
        sizeBytes: stat.size,
      });
    } catch {}
  }

  // Scan codebase docs/ folders for shipped HTML artifacts.
  // These are the real documentation files living in each repo.
  const seenDocs = new Set<string>();
  for (const { dir, repo } of CODEBASE_DOCS) {
    let docEntries: Dirent[];
    try {
      docEntries = await fs.readdir(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch { continue; }

    for (const entry of docEntries) {
      const name = String(entry.name);
      if (!entry.isFile() || !name.endsWith('.html')) continue;
      if (name.startsWith('_') || name === 'skeleton.html') continue;
      if (seenDocs.has(name)) continue; // dedupe across repos
      seenDocs.add(name);

      const abs = path.join(dir, name);
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(abs, 'utf-8'),
          fs.stat(abs),
        ]);
        const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
        const rawTitle = titleMatch
          ? titleMatch[1].replace(/^Oasis\s*[—–-]\s*/, '')
          : name.replace('.html', '');
        // Decode HTML entities in title
        const title = rawTitle.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

        // Use the absolute path as the filePath since these are outside the vault
        specs.push({
          id: crypto.createHash('md5').update(abs).digest('hex').slice(0, 12),
          title,
          filePath: abs, // absolute path — reader needs to handle this
          status: 'shipped',
          effortEstimate: repo,
          openQuestions: [],
          createdAt: stat.birthtime.toISOString().slice(0, 10),
          updatedAt: stat.mtime.toISOString(),
          staleDays: Math.floor((Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24)),
          sourceResearch: [],
          linkedLoopCount: 0,
          sizeBytes: stat.size,
          isHtml: true,
        });
      } catch {}
    }
  }

  // Sort: drafting first, then ready, then building, then shipped
  const statusOrder: Record<string, number> = { drafting: 0, ready: 1, building: 2, shipped: 3 };
  specs.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  return NextResponse.json({ specs });
}
