import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

const SPECS_FOLDER = '01-Creating/Oasis — Agent Specs';

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

function extractFirstParagraphs(content: string, count: number): string {
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  const lines = stripped.split('\n');
  const paragraphs: string[] = [];
  let current: string[] = [];
  let pastTitle = false;

  for (const line of lines) {
    if (!pastTitle) {
      if (line.startsWith('# ')) { pastTitle = true; continue; }
      continue;
    }
    if (line.startsWith('#') || line.startsWith('---')) {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'));
        current = [];
        if (paragraphs.length >= count) break;
      }
      continue;
    }
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'));
        current = [];
        if (paragraphs.length >= count) break;
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0 && paragraphs.length < count) {
    paragraphs.push(current.join('\n'));
  }
  return paragraphs.join('\n\n');
}

function extractOpenTasks(content: string): string[] {
  const tasks: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*-\s+\[\s\]\s+(.+)/);
    if (m) tasks.push(m[1].trim());
  }
  return tasks;
}

function extractKeyFindings(content: string): string[] {
  const findings: string[] = [];
  // Look for numbered or bulleted items in key sections
  const sections = content.split(/\n##\s+/);
  for (const section of sections) {
    const lines = section.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*[-*+]\s+\*\*(.+?)\*\*/);
      if (m) findings.push(m[1].trim());
      if (findings.length >= 8) break;
    }
    if (findings.length >= 8) break;
  }
  // Fallback: grab H3 titles as key findings
  if (findings.length === 0) {
    const h3s = content.match(/^###\s+(.+)$/gm);
    if (h3s) {
      for (const h of h3s.slice(0, 8)) {
        findings.push(h.replace(/^###\s+/, ''));
      }
    }
  }
  return findings;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function POST(request: Request) {
  let body: { researchDocPath?: string; loopTitle?: string; loopContext?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // ─── Scaffold from loop (minimal stub) ───
  if (body.loopTitle) {
    const specName = body.loopTitle.replace(/[/:*?"<>|]/g, '').trim();
    const specFile = `${specName} — Agent Spec.md`;
    const specAbs = path.join(VAULT_ROOT, SPECS_FOLDER, specFile);

    try {
      await fs.access(specAbs);
      return NextResponse.json(
        { error: 'spec already exists', path: path.relative(VAULT_ROOT, specAbs) },
        { status: 409 },
      );
    } catch {
      // Good — file doesn't exist
    }

    const specContent = `---
created: ${todayISO()}
type: spec
status: drafting
source_loop: ${body.loopTitle}
effort: null
tags: [digital-oasis]
---
# ${specName} — Agent Spec

Origin: loop — "${body.loopTitle}"

---

## Context

${body.loopContext || '- [ ] Add context for this spec'}

---

## Requirements

- [ ] Define implementation requirements

---

## Open Questions

- [ ] What does "done" look like?
- [ ] What research is needed first?

---

## Decomposition

*To be filled by \`/decompose\`*
`;

    try {
      await fs.mkdir(path.join(VAULT_ROOT, SPECS_FOLDER), { recursive: true });
      await fs.writeFile(specAbs, specContent, 'utf-8');
    } catch (err) {
      return NextResponse.json(
        { error: `failed to write spec: ${err}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      path: path.relative(VAULT_ROOT, specAbs),
      title: specName,
    });
  }

  // ─── Scaffold from research doc ───
  const { researchDocPath } = body;
  if (!researchDocPath) {
    return NextResponse.json({ error: 'researchDocPath required' }, { status: 400 });
  }

  // Read the research doc
  const researchAbs = path.join(VAULT_ROOT, researchDocPath);
  const resolved = path.resolve(researchAbs);
  if (!resolved.startsWith(VAULT_ROOT)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  let content: string;
  try {
    content = await fs.readFile(resolved, 'utf-8');
  } catch {
    return NextResponse.json({ error: 'research doc not found' }, { status: 404 });
  }

  const title = extractTitle(content) || path.basename(researchDocPath, '.md');
  const context = extractFirstParagraphs(content, 2);
  const keyFindings = extractKeyFindings(content);
  const openTasks = extractOpenTasks(content);

  // Generate spec filename
  const specName = title.replace(/[/:*?"<>|]/g, '').trim();
  const specFile = `${specName} — Agent Spec.md`;
  const specAbs = path.join(VAULT_ROOT, SPECS_FOLDER, specFile);

  // Don't overwrite existing specs
  try {
    await fs.access(specAbs);
    return NextResponse.json(
      { error: 'spec already exists', path: path.relative(VAULT_ROOT, specAbs) },
      { status: 409 },
    );
  } catch {
    // Good — file doesn't exist
  }

  // Build the spec content
  const findingsBullets = keyFindings.length > 0
    ? keyFindings.map((f) => `- ${f}`).join('\n')
    : '- [ ] Extract key findings from research';

  const openQuestionsBullets = openTasks.length > 0
    ? openTasks.slice(0, 10).map((t) => `- [ ] ${t}`).join('\n')
    : '- [ ] Define open questions';

  const specContent = `---
created: ${todayISO()}
type: spec
status: drafting
source_research: [${researchDocPath}]
effort: null
tags: [digital-oasis]
---
# ${specName} — Agent Spec

Research basis: [[${researchDocPath.replace(/\.md$/, '')}]]

---

## Context

${context || 'See linked research document.'}

---

## Key Findings (from research)

${findingsBullets}

---

## Requirements

- [ ] Define implementation requirements

---

## Open Questions

${openQuestionsBullets}

---

## Decomposition

*To be filled by \`/decompose\`*
`;

  try {
    await fs.writeFile(specAbs, specContent, 'utf-8');
  } catch (err) {
    return NextResponse.json(
      { error: `failed to write spec: ${err}` },
      { status: 500 },
    );
  }

  const relPath = path.relative(VAULT_ROOT, specAbs);
  return NextResponse.json({ path: relPath, title: specName });
}
