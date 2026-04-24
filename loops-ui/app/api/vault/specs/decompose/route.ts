import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

import { applyEventToDisk } from '@/lib/tend-events';
import type { TendEvent } from '@/lib/tend-events';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

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

// Extract actionable items from the spec. Looks for:
// 1. Unchecked tasks (- [ ] ...) in any section
// 2. H3 subsections under architecture/implementation headings as task titles
// 3. Bold items in numbered/bulleted lists under actionable sections
// Skips meta sections like "What this gives the system", "Safety Constraints", "Open Questions"
const SKIP_SECTIONS = new Set([
  'what this gives the system',
  'safety constraints',
  'open questions',
  'effort estimate',
  'validation plan',
]);

function extractTasks(content: string): Array<{ text: string; line: number }> {
  const lines = content.split('\n');
  const tasks: Array<{ text: string; line: number }> = [];
  const seen = new Set<string>();
  let currentH2 = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track H2 sections
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      currentH2 = h2Match[1].trim().toLowerCase();
      continue;
    }

    // Skip non-actionable sections
    if (SKIP_SECTIONS.has(currentH2)) continue;

    // Priority 1: Unchecked tasks anywhere
    const taskMatch = line.match(/^\s*-\s+\[\s\]\s+(.+)/);
    if (taskMatch) {
      const text = taskMatch[1].trim();
      if (!text.toLowerCase().includes('placeholder') && !seen.has(text)) {
        seen.add(text);
        tasks.push({ text, line: i + 1 });
      }
      continue;
    }

    // Priority 2: H3 headings under architecture/implementation sections as task titles
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      const heading = h3Match[1].trim();
      // Strip markdown formatting from heading
      const clean = heading.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1');
      // Only use H3s that look like implementation steps (not just labels)
      if (clean.length > 5 && clean.length < 120 && !seen.has(clean)) {
        seen.add(clean);
        tasks.push({ text: `Implement ${clean}`, line: i + 1 });
      }
      continue;
    }
  }

  return tasks;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function POST(request: Request) {
  let body: { specPath?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { specPath } = body;
  if (!specPath) {
    return NextResponse.json({ error: 'specPath required' }, { status: 400 });
  }

  const specAbs = path.join(VAULT_ROOT, specPath);
  const resolved = path.resolve(specAbs);
  if (!resolved.startsWith(VAULT_ROOT)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  let content: string;
  try {
    content = await fs.readFile(resolved, 'utf-8');
  } catch {
    return NextResponse.json({ error: 'spec not found' }, { status: 404 });
  }

  const specTitle = extractTitle(content) || path.basename(specPath, '.md');
  const tasks = extractTasks(content);

  if (tasks.length === 0) {
    return NextResponse.json(
      { error: 'No unchecked tasks found in Requirements or Decomposition sections' },
      { status: 422 },
    );
  }

  // Derive domain from spec tags
  const fm = parseYamlFrontmatter(content);
  const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
  const domain = tags[0] || 'personal';

  // Create loops for each task
  const createdIds: string[] = [];
  const errors: string[] = [];

  for (const task of tasks) {
    const event: TendEvent = {
      kind: 'create_loop',
      payload: {
        title: task.text,
        sourceFile: specPath,
        sourceLine: task.line,
        subGroup: specTitle,
        skipTriage: false, // land in triage for review
      },
    };

    try {
      const result = await applyEventToDisk(event, 'agent:mission-control', VAULT_ROOT);
      if (result.status === 'applied' && result.loop_id) {
        createdIds.push(result.loop_id);
      } else if (result.status !== 'applied') {
        errors.push(`Failed to create loop for "${task.text}": ${result.status}`);
      }
    } catch (err) {
      errors.push(`Error creating loop for "${task.text}": ${(err as Error).message}`);
    }
  }

  // Update spec status to 'building' in frontmatter
  try {
    const updated = content.replace(
      /^(status:\s*).+$/m,
      '$1building',
    );
    await fs.writeFile(resolved, updated, 'utf-8');
  } catch {
    // Non-fatal — loops were created even if status update failed
  }

  return NextResponse.json({
    created: createdIds.length,
    errors: errors.length > 0 ? errors : undefined,
    loopIds: createdIds,
  });
}
