import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

interface SearchResult {
  filePath: string;
  title: string;
  snippet: string;
  score: number;
}

async function collectMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, String(entry.name));
    if (entry.isDirectory() && !String(entry.name).startsWith('.') && String(entry.name) !== '05-Archive') {
      results.push(...(await collectMdFiles(full)));
    } else if (entry.isFile() && String(entry.name).endsWith('.md') && !String(entry.name).startsWith('_')) {
      results.push(full);
    }
  }
  return results;
}

function extractTitle(content: string): string {
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  const h1 = stripped.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : '';
}

function findSnippet(content: string, terms: string[]): string {
  const stripped = content.replace(/^---[\s\S]*?---\n*/, '');
  const lines = stripped.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (terms.some((t) => lower.includes(t)) && line.trim().length > 20) {
      const trimmed = line.trim();
      return trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
    }
  }
  // Fallback: first non-heading paragraph
  for (const line of lines) {
    if (line.trim() && !line.startsWith('#') && !line.startsWith('---') && line.trim().length > 20) {
      const trimmed = line.trim();
      return trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
    }
  }
  return '';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);

  if (!query) {
    return NextResponse.json({ error: 'q param required' }, { status: 400 });
  }

  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const files = await collectMdFiles(VAULT_ROOT);
  const results: SearchResult[] = [];

  for (const abs of files) {
    try {
      const content = await fs.readFile(abs, 'utf-8');
      const lower = content.toLowerCase();

      // Score: count term matches weighted by location
      let score = 0;
      for (const term of terms) {
        const titleMatch = extractTitle(content).toLowerCase().includes(term);
        if (titleMatch) score += 3;
        // Count occurrences in body (capped)
        const matches = (lower.match(new RegExp(term, 'g')) || []).length;
        score += Math.min(matches, 10);
      }

      if (score > 0) {
        results.push({
          filePath: path.relative(VAULT_ROOT, abs),
          title: extractTitle(content) || path.basename(abs, '.md'),
          snippet: findSnippet(content, terms),
          score,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  results.sort((a, b) => b.score - a.score);
  return NextResponse.json({ results: results.slice(0, limit) });
}
