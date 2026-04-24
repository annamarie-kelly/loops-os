import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  if (!file) {
    return new Response('file param required', { status: 400 });
  }

  const abs = path.resolve(VAULT_ROOT, file);
  if (!abs.startsWith(VAULT_ROOT)) {
    return new Response('invalid path', { status: 400 });
  }

  try {
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    return new Response(data, {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
