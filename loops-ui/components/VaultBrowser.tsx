'use client';

// VaultBrowser — slide-in left drawer that lists every .md file in
// the vault. Folders are collapsed by default (search-first model);
// typing in the search box flattens everything to a filtered file
// list. "+ new note" creates a file in 00-Inbox/ and opens it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invalidateVaultFileCache } from '@/components/MarkdownEditor';

interface FileNode {
  name: string;
  path: string;
  type: 'file';
  size: number;
  mtime: number;
}

interface FolderNode {
  name: string;
  path: string;
  type: 'folder';
  children: TreeNode[];
}

type TreeNode = FileNode | FolderNode;

interface VaultBrowserProps {
  open: boolean;
  onClose: () => void;
  // `opts.edit` signals "we just created this — open it in edit mode"
  // so the user lands on a cursor, not a render of an empty page.
  onSelect: (filePath: string, opts?: { edit?: boolean }) => void;
  activeFilePath?: string | null;
  // Bumping this number forces a refetch (after a write/create).
  refreshKey?: number;
}

function flatten(nodes: TreeNode[], acc: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.type === 'file') acc.push(n);
    else flatten(n.children, acc);
  }
  return acc;
}

export function VaultBrowser({
  open,
  onClose,
  onSelect,
  activeFilePath,
  refreshKey = 0,
}: VaultBrowserProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search box gets focus when the drawer opens — typing should
  // start filtering immediately, no pre-click needed.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open]);

  // Fetch tree when drawer opens, and on refresh bumps.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch('/api/vault/list')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setTree(data.tree ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey]);

  // Esc closes the drawer (unless we're inside the new-note input).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (creating) {
          setCreating(false);
          setNewTitle('');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose, creating]);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) {
      setCreating(false);
      return;
    }
    // Strip path separators, control chars, and leading dots; cap
    // length so very long titles don't trip filesystem limits.
    const safe = title
      .replace(/[\x00-\x1f]/g, '')
      .replace(/[/\\]/g, '—')
      .replace(/^\.+/, '')
      .slice(0, 120)
      .trim();
    if (!safe) {
      setCreating(false);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const filePath = `00-Inbox/${safe}.md`;
    const body = `---\ncreated: ${today}\ntype: reference\nstatus: active\ntags: []\n---\n\n# ${title}\n\n`;
    try {
      await fetch('/api/vault/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath, content: body, raw: true }),
      });
      invalidateVaultFileCache();
      setCreating(false);
      setNewTitle('');
      // Open immediately in edit mode — fresh notes need a cursor,
      // not a static render of the placeholder body.
      onSelect(filePath, { edit: true });
    } catch {
      // Surface gently — the field stays open so the user can retry.
      console.error('Failed to create note');
    }
  }, [newTitle, onSelect]);

  // Open (or create-then-open) today's daily note. Lives at
  // 00-Inbox/Daily/{YYYY-MM-DD}.md so it slots into the existing
  // inbox-triage convention without needing a new top-level folder.
  const openDailyNote = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const filePath = `00-Inbox/Daily/${today}.md`;
    // Probe by reading; if missing, create first.
    const probe = await fetch(`/api/vault/read?file=${encodeURIComponent(filePath)}`);
    const data = await probe.json();
    if (!data.available) {
      const body = `---\ncreated: ${today}\ntype: daily\nstatus: active\ntags: [daily]\n---\n\n# ${today}\n\n## Notes\n\n\n## Done today\n\n\n## Tomorrow\n\n`;
      try {
        await fetch('/api/vault/write', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: filePath, content: body, raw: true }),
        });
        invalidateVaultFileCache();
        // Brand-new daily note: drop into edit mode so the user can
        // start journaling immediately.
        onSelect(filePath, { edit: true });
        return;
      } catch {
        console.error('Failed to create daily note');
        return;
      }
    }
    // Existing daily note — open in read mode (preserves the user's
    // working position if they left mid-edit).
    onSelect(filePath);
  }, [onSelect]);

  // When a search query is present, flatten and filter; otherwise
  // render the tree with folder collapsing.
  const flatMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const all = flatten(tree);
    return all
      .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);
  }, [tree, query]);

  return (
    <>
      {/* Backdrop — clicking it closes the drawer. */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Drawer */}
      <aside
        className={`fixed top-0 left-0 bottom-0 z-50 w-[320px] bg-[var(--surface-page)] border-r border-edge flex flex-col transform transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="px-3 py-3 border-b border-edge flex items-center gap-2 shrink-0">
          <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost flex-1">
            Vault
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-ghost hover:text-ink text-[12px] px-1.5 py-0.5 rounded hover:bg-inset"
            title="Close (Esc)"
          >
            &#x2715;
          </button>
        </div>

        {/* Today shortcut — daily note in 00-Inbox/Daily/. */}
        <div className="px-3 py-2 border-b border-edge shrink-0">
          <button
            type="button"
            onClick={() => void openDailyNote()}
            className="w-full text-left text-[11px] text-ink-soft hover:text-ink px-2 py-1.5 rounded border border-edge hover:border-edge-hover hover:bg-inset transition-colors flex items-center gap-2"
            title="Open today's daily note"
          >
            <span className="w-[6px] h-[6px] rounded-full bg-[var(--mauve)]" aria-hidden />
            <span className="font-medium">Today</span>
            <span className="text-ink-ghost ml-auto tabular-nums text-[10px]">
              {new Date().toISOString().slice(0, 10)}
            </span>
          </button>
        </div>

        {/* Search + new */}
        <div className="px-3 py-2 flex items-center gap-2 border-b border-edge shrink-0">
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes..."
            className="flex-1 text-[11px] px-2 py-1 rounded border border-edge bg-surface text-ink placeholder:text-ink-ghost focus:outline-none focus:border-edge-hover"
          />
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setTimeout(() => newInputRef.current?.focus(), 50);
            }}
            className="text-[11px] text-ink-soft hover:text-ink px-2 py-1 rounded border border-edge hover:border-edge-hover"
            title="New note"
          >
            + new
          </button>
        </div>

        {creating && (
          <div className="px-3 py-2 border-b border-edge shrink-0">
            <input
              ref={newInputRef}
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                else if (e.key === 'Escape') {
                  setCreating(false);
                  setNewTitle('');
                }
              }}
              placeholder="Title — Enter to create in 00-Inbox/"
              className="w-full text-[11px] px-2 py-1 rounded border border-[var(--mauve)] bg-surface text-ink placeholder:text-ink-ghost focus:outline-none"
            />
          </div>
        )}

        {/* Tree / search results */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle py-1">
          {loading && tree.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-ink-ghost italic">
              Loading vault...
            </div>
          ) : flatMatches ? (
            flatMatches.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-ink-ghost italic">
                No notes match &ldquo;{query}&rdquo;.
              </div>
            ) : (
              <ul>
                {flatMatches.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    depth={0}
                    showPath
                    active={f.path === activeFilePath}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )
          ) : tree.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-ink-ghost italic">
              Empty vault. Click &ldquo;+ new&rdquo; to start.
            </div>
          ) : (
            <ul>
              {tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleFolder}
                  activeFilePath={activeFilePath ?? null}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  activeFilePath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  activeFilePath: string | null;
  onSelect: (filePath: string) => void;
}) {
  if (node.type === 'file') {
    return (
      <FileRow
        file={node}
        depth={depth}
        active={node.path === activeFilePath}
        onSelect={onSelect}
      />
    );
  }
  const isOpen = expanded.has(node.path);
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="w-full flex items-center gap-1.5 text-left px-3 py-1 hover:bg-inset transition-colors"
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        <span className="text-[10px] text-ink-ghost w-3 inline-block">
          {isOpen ? '▾' : '▸'}
        </span>
        <span className="text-[11px] text-ink-soft truncate">{node.name}</span>
        <span className="text-[10px] text-ink-ghost ml-auto pl-2">
          {node.children.length || ''}
        </span>
      </button>
      {isOpen && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              activeFilePath={activeFilePath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function FileRow({
  file,
  depth,
  showPath,
  active,
  onSelect,
}: {
  file: FileNode;
  depth: number;
  showPath?: boolean;
  active: boolean;
  onSelect: (filePath: string) => void;
}) {
  const display = file.name.replace(/\.md$/, '');
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file.path)}
        className={`w-full text-left px-3 py-1 transition-colors ${
          active ? 'bg-inset text-ink' : 'hover:bg-inset text-ink-soft'
        }`}
        style={{ paddingLeft: `${12 + depth * 12 + (showPath ? 0 : 16)}px` }}
        title={file.path}
      >
        <div className="text-[11px] truncate">{display}</div>
        {showPath && (
          <div className="text-[9px] text-ink-ghost truncate font-mono">
            {file.path}
          </div>
        )}
      </button>
    </li>
  );
}
