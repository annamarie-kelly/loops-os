import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

// Containment check: a bare prefix match lets a sibling directory
// "../vault2/x" sneak past `startsWith(VAULT_ROOT)`. Require either an
// exact match or a path-separator boundary.
function containsInVault(abs: string): boolean {
  return abs === VAULT_ROOT || abs.startsWith(VAULT_ROOT + path.sep);
}

export async function PUT(request: Request) {
  const body = (await request.json()) as {
    file: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
    raw?: boolean;
  };
  const { file, content, encoding, raw } = body;

  if (!file || typeof content !== 'string') {
    return NextResponse.json({ error: 'file and content required' }, { status: 400 });
  }

  const abs = path.resolve(path.join(VAULT_ROOT, file));
  if (!containsInVault(abs)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  try {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(abs), { recursive: true });

    if (encoding === 'base64') {
      // Binary write (images, etc.)
      await fs.writeFile(abs, Buffer.from(content, 'base64'));
    } else {
      if (raw) {
        // Raw write — content includes frontmatter, write as-is
        await fs.writeFile(abs, content, 'utf-8');
      } else {
        // Text write — preserve frontmatter from existing file
        let existing = '';
        try {
          existing = await fs.readFile(abs, 'utf-8');
        } catch {
          // New file — no frontmatter to preserve
        }
        const fmMatch = existing.match(/^(---\n[\s\S]*?\n---\n*)/);
        const frontmatter = fmMatch ? fmMatch[1] : '';
        const fullContent = frontmatter + content;
        await fs.writeFile(abs, fullContent, 'utf-8');
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: `write failed: ${err}` }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { file: string };
  const { file } = body;

  if (!file) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }

  const abs = path.resolve(path.join(VAULT_ROOT, file));
  if (!containsInVault(abs)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  try {
    await fs.unlink(abs);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true }); // already gone
  }
}
