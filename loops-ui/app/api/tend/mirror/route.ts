import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

// Writes the in-UI Tend state out to JSON files in `06-Loops/` so
// the CLI slash commands can read them. Localhost-only; no auth.
//
// Mirror direction is strictly one-way (UI -> disk). The CLI never
// writes back, so there is no sync loop to worry about.

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

const LOOPS_DIR = path.join(VAULT_ROOT, '06-Loops');

const FILE_BY_KIND: Record<string, string> = {
  boundary_log: 'boundary_log.json',
  tend_export: 'tend-export.json',
  stakeholder_window: 'stakeholder-window.json',
};

async function atomicWrite(abs: string, body: string): Promise<number> {
  // Per-call tmp filename — concurrent writes of the same kind would
  // otherwise both target `${abs}.tmp` and race the rename, leaving
  // the loser with ENOENT.
  const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, body, 'utf-8');
  await fs.rename(tmp, abs);
  return Buffer.byteLength(body, 'utf-8');
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      kind?: string;
      data?: unknown;
    };
    const { kind, data } = body;
    if (!kind || !(kind in FILE_BY_KIND)) {
      return NextResponse.json(
        { error: `Unknown mirror kind: ${kind ?? 'undefined'}` },
        { status: 400 },
      );
    }
    if (data == null || typeof data !== 'object') {
      return NextResponse.json(
        { error: 'Missing or invalid `data` object' },
        { status: 400 },
      );
    }
    const filename = FILE_BY_KIND[kind];
    const abs = path.join(LOOPS_DIR, filename);
    const serialized = JSON.stringify(data, null, 2);
    const bytes_written = await atomicWrite(abs, serialized);
    return NextResponse.json({ ok: true, bytes_written, file: filename });
  } catch (err) {
    return NextResponse.json(
      { error: `Mirror write failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
