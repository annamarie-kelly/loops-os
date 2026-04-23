import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

// Allowed roots for reading files (vault + codebase docs)
const ALLOWED_ROOTS = [
  VAULT_ROOT,
  path.resolve(process.env.HOME || '', 'dev/digital-garden/docs'),
  path.resolve(process.env.HOME || '', 'dev/ios-oasis/docs'),
  path.resolve(process.env.HOME || '', 'dev/web-oasis/docs'),
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  if (!file) {
    return NextResponse.json({ error: 'file param required' }, { status: 400 });
  }

  // Support both vault-relative and absolute paths
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(VAULT_ROOT, file);
  if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root))) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  try {
    const content = await fs.readFile(resolved, 'utf-8');
    const isHtml = file.endsWith('.html');
    // Strip YAML frontmatter for markdown; serve HTML raw
    const body = isHtml ? content : content.replace(/^---[\s\S]*?---\n*/, '');
    return NextResponse.json({ file, content: body, available: true, isHtml });
  } catch {
    return NextResponse.json({ file, content: '', available: false });
  }
}
