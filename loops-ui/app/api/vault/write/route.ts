import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

export async function PUT(request: Request) {
  const { file, content } = (await request.json()) as {
    file: string;
    content: string;
  };

  if (!file || typeof content !== 'string') {
    return NextResponse.json({ error: 'file and content required' }, { status: 400 });
  }

  const abs = path.resolve(path.join(VAULT_ROOT, file));
  if (!abs.startsWith(VAULT_ROOT)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  try {
    // Read existing file to preserve frontmatter
    let existing = '';
    try {
      existing = await fs.readFile(abs, 'utf-8');
    } catch {
      // New file — no frontmatter to preserve
    }

    // If existing file has frontmatter, re-attach it
    const fmMatch = existing.match(/^(---\n[\s\S]*?\n---\n*)/);
    const frontmatter = fmMatch ? fmMatch[1] : '';
    const fullContent = frontmatter + content;

    await fs.writeFile(abs, fullContent, 'utf-8');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: `write failed: ${err}` }, { status: 500 });
  }
}
