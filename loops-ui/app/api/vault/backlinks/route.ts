import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

const HIDDEN = new Set([
  '.obsidian',
  '.git',
  '.claude',
  'node_modules',
  '.DS_Store',
  '06-Loops',
]);

async function* walkMarkdown(dir: string, relRoot: string): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (HIDDEN.has(entry.name) || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkMarkdown(abs, rel);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield { abs, rel };
    }
  }
}

interface Backlink {
  path: string;
  excerpt: string;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('file');
  if (!target) {
    return NextResponse.json({ error: 'file param required' }, { status: 400 });
  }

  // The wikilink target can be matched by either the full vault path
  // or just the basename. Build a regex that accepts both.
  const baseName = target.replace(/^.*\//, '').replace(/\.md$/, '');
  const targetWithoutExt = target.replace(/\.md$/, '');
  // Escape regex specials in the captured names.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkRe = new RegExp(
    `\\[\\[(?:${esc(targetWithoutExt)}|${esc(baseName)})(?:\\|[^\\]]+)?\\]\\]`,
    'i',
  );

  const results: Backlink[] = [];
  for await (const file of walkMarkdown(VAULT_ROOT, '')) {
    if (file.rel === target) continue; // skip self
    let content: string;
    try {
      content = await fs.readFile(file.abs, 'utf-8');
    } catch {
      continue;
    }
    if (!linkRe.test(content)) continue;
    // Pull the first matching line as an excerpt for context.
    const lines = content.split('\n');
    const hitLine = lines.find((l) => linkRe.test(l)) ?? '';
    const excerpt = hitLine.trim().slice(0, 200);
    results.push({ path: file.rel, excerpt });
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return NextResponse.json({ backlinks: results });
}
