import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

// Folders we never surface to the browser. `.obsidian` is workspace
// state; `06-Loops` holds JSON-only state files; node_modules in case
// the user pointed VAULT_ROOT at something weird.
const HIDDEN = new Set([
  '.obsidian',
  '.git',
  '.claude',
  'node_modules',
  '.DS_Store',
  '06-Loops',
]);

interface FileNode {
  name: string;
  path: string; // vault-relative
  type: 'file';
  size: number;
  mtime: number;
}

interface FolderNode {
  name: string;
  path: string; // vault-relative; '' for root
  type: 'folder';
  children: TreeNode[];
}

type TreeNode = FileNode | FolderNode;

async function walk(dir: string, relRoot: string): Promise<TreeNode[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TreeNode[] = [];
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = await walk(abs, rel);
      out.push({ name: entry.name, path: rel, type: 'folder', children });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const stat = await fs.stat(abs);
        out.push({
          name: entry.name,
          path: rel,
          type: 'file',
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  // Folders first, then files; both alphabetical.
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function GET() {
  const tree = await walk(VAULT_ROOT, '');
  return NextResponse.json({ tree });
}
