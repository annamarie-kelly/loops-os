import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoopsFile } from '@/lib/types';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');
const LOOPS_PATH = path.join(VAULT_ROOT, '06-Loops/loops.json');

type Action = 'close' | 'delete' | 'drop';

async function readLoops(): Promise<LoopsFile> {
  const raw = await fs.readFile(LOOPS_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function writeLoops(data: LoopsFile): Promise<void> {
  const tmp = `${LOOPS_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, LOOPS_PATH);
}

const CHECKBOX_RE = /- \[([ xX\-])\]/;

import { similarity } from '@/lib/fuzzy-match';

async function mutateSourceFile(
  sourceFile: string,
  storedLine: number,
  taskText: string,
  action: Action,
): Promise<void> {
  const abs = path.join(VAULT_ROOT, sourceFile);
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf-8');
  } catch {
    // Source file doesn't exist. For manual loops created via the
    // + New loop button the file may never have been materialized —
    // create it on first close so the state round-trips next time.
    if (action === 'close' || action === 'drop') {
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const marker = action === 'drop' ? '[-]' : '[x]';
        const stub = `# Manual loops\n\nCaptures created in Tend that don't have a vault source yet.\n\n- ${marker} ${taskText}\n`;
        await fs.writeFile(abs, stub, 'utf-8');
      } catch {
        /* non-fatal */
      }
    }
    return;
  }

  const lines = content.split('\n');

  // Try the stored line number first. If it still has an open
  // checkbox AND the text overlaps meaningfully, use it directly.
  let matchIdx = -1;
  const storedIdx = storedLine - 1;
  if (
    storedIdx >= 0 &&
    storedIdx < lines.length &&
    CHECKBOX_RE.test(lines[storedIdx]) &&
    similarity(taskText, lines[storedIdx]) >= 0.4
  ) {
    matchIdx = storedIdx;
  }

  // Fuzzy fallback: scan every checkbox line and pick the highest
  // similarity score. Require ≥ 0.5 overlap so we don't mis-target.
  if (matchIdx === -1) {
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!CHECKBOX_RE.test(lines[i])) continue;
      const s = similarity(taskText, lines[i]);
      if (s > bestScore) {
        bestScore = s;
        matchIdx = i;
      }
    }
    if (bestScore < 0.5) matchIdx = -1;
  }

  if (matchIdx === -1) return;

  if (action === 'close') {
    lines[matchIdx] = lines[matchIdx].replace(CHECKBOX_RE, '- [x]');
  } else if (action === 'drop') {
    // Drop marks with [-] so it's visually distinct from shipped [x]
    // when the vault file is read directly. Both count as done to the
    // reconciler's "checked anywhere = done" rule.
    lines[matchIdx] = lines[matchIdx].replace(CHECKBOX_RE, '- [-]');
  } else if (action === 'delete') {
    lines.splice(matchIdx, 1);
  }

  const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
  await fs.rename(tmp, abs);
}

export async function POST(request: Request) {
  try {
    const { action, ids } = (await request.json()) as {
      action: Action;
      ids: string[];
    };
    if (!['close', 'delete', 'drop'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const data = await readLoops();
    const targets = data.loops.filter((l) => ids.includes(l.id));

    // Write each loop's disposition into its source file. Close → [x],
    // Drop → [-], Delete → line removed. Missing source files for
    // manual loops get stubbed on first write.
    for (const loop of targets) {
      await mutateSourceFile(
        loop.source.file,
        loop.source.line,
        loop.text,
        action,
      );
    }

    if (action === 'close' || action === 'drop') {
      const idSet = new Set(ids);
      const now = new Date().toISOString();
      const closedAs = action === 'drop' ? 'dropped' : 'done';
      data.loops = data.loops.map((l) =>
        idSet.has(l.id)
          ? {
              ...l,
              done: true,
              closedAs,
              doneAt: now,
              updatedAt: now,
            }
          : l,
      );
    } else {
      // Delete stays destructive: row is gone from JSON and source file.
      data.loops = data.loops.filter((l) => !ids.includes(l.id));
    }
    await writeLoops(data);

    return NextResponse.json({ ok: true, affected: targets.length });
  } catch (err) {
    return NextResponse.json(
      { error: `Action failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
