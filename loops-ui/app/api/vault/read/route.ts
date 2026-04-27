import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

// Allowed roots for reading files (vault + codebase docs)
const codebaseDocs: { dir: string }[] = process.env.LOOPS_CODEBASE_DOCS
  ? JSON.parse(process.env.LOOPS_CODEBASE_DOCS)
  : [];
const ALLOWED_ROOTS = [
  VAULT_ROOT,
  ...codebaseDocs.map((d: { dir: string }) => path.resolve(d.dir)),
];

// Containment requires an exact match or a path-separator boundary —
// a bare `startsWith` would let a sibling dir like "../vault2/x"
// sneak past when VAULT_ROOT happens to share a prefix.
function isContained(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  if (!file) {
    return NextResponse.json({ error: 'file param required' }, { status: 400 });
  }

  // Support both vault-relative and absolute paths
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(VAULT_ROOT, file);
  if (!ALLOWED_ROOTS.some((root) => isContained(resolved, root))) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  let actualPath = resolved;
  let actualRel = file;
  let exists = true;
  try {
    await fs.access(resolved);
  } catch {
    exists = false;
  }

  // Wikilink fallback: if the literal path doesn't exist AND the
  // request looks like a basename (no slash), scan the vault for any
  // file whose basename matches. Lets `[[Note]]` resolve regardless
  // of which folder it lives in.
  if (!exists && !file.includes('/') && !path.isAbsolute(file)) {
    const target = file.endsWith('.md') ? file : `${file}.md`;
    const found = await findByBasename(VAULT_ROOT, target);
    if (found) {
      actualPath = found.abs;
      actualRel = found.rel;
      exists = true;
    }
  }

  if (!exists) {
    return NextResponse.json({ file, content: '', available: false });
  }

  // `?serve=html` returns the file directly with text/html so it can
  // be embedded via <iframe src=...>. Anchor navigation, JS-driven
  // tab switching, and relative links all work in a real-URL iframe;
  // they're flaky in srcDoc / about:srcdoc. Only HTML files for now.
  const serve = url.searchParams.get('serve');
  if (serve === 'html' && actualRel.endsWith('.html')) {
    try {
      const buf = await fs.readFile(actualPath);
      return new Response(new Uint8Array(buf), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // Permissive cache for in-app iframe; revalidates on reload.
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }

  try {
    const content = await fs.readFile(actualPath, 'utf-8');
    const isHtml = actualRel.endsWith('.html');
    const raw = url.searchParams.get('raw') === '1';
    const body = (isHtml || raw) ? content : content.replace(/^---[\s\S]*?---\n*/, '');
    return NextResponse.json({ file: actualRel, content: body, available: true, isHtml });
  } catch {
    return NextResponse.json({ file: actualRel, content: '', available: false });
  }
}

async function findByBasename(
  root: string,
  basename: string,
): Promise<{ abs: string; rel: string } | null> {
  const HIDDEN = new Set(['.obsidian', '.git', '.claude', 'node_modules', '06-Loops']);
  async function walk(dir: string, rel: string): Promise<{ abs: string; rel: string } | null> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (HIDDEN.has(entry.name) || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const hit = await walk(abs, next);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name === basename) {
        return { abs, rel: next };
      }
    }
    return null;
  }
  return walk(root, '');
}
