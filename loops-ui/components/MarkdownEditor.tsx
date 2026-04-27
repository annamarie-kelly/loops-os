'use client';

// MarkdownEditor — CodeMirror 6 instance themed to match loops-ui.
// Controlled component: pass `value` + `onChange`. Optional `onSave`
// fires on ⌘S / Ctrl+S. Optional `onBlur` fires on focus loss.

import { useEffect, useRef } from 'react';
import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView,
  keymap,
  placeholder as placeholderExt,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, syntaxTree } from '@codemirror/language';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

// ─── Wikilink autocomplete ────────────────────────────────────────
// Triggered when the user types `[[`. Lazy-fetches the vault file
// list once and caches it for the session. Inserts the basename when
// unique; falls back to `Folder/Name` when the basename collides.

interface VaultFileLite {
  name: string;
  path: string;
}

let vaultFileListPromise: Promise<VaultFileLite[]> | null = null;

// Callers (VaultBrowser, NoteReader) invalidate after a write so the
// next `[[` autocomplete sees newly created notes without a refresh.
export function invalidateVaultFileCache(): void {
  vaultFileListPromise = null;
}

function loadVaultFiles(): Promise<VaultFileLite[]> {
  if (vaultFileListPromise) return vaultFileListPromise;
  vaultFileListPromise = fetch('/api/vault/list')
    .then((r) => r.json())
    .then((data) => {
      const flat: VaultFileLite[] = [];
      const walk = (nodes: Array<{ type: string; name: string; path: string; children?: unknown[] }>) => {
        for (const n of nodes) {
          if (n.type === 'file') flat.push({ name: n.name, path: n.path });
          else if (n.type === 'folder' && Array.isArray(n.children)) {
            walk(n.children as typeof nodes);
          }
        }
      };
      walk(data.tree ?? []);
      return flat;
    })
    .catch(() => []);
  return vaultFileListPromise;
}

async function wikilinkCompletions(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // Match an open wikilink `[[…` up to the cursor. Stop at `]]`.
  const match = context.matchBefore(/\[\[[^\]\n]*/);
  if (!match) return null;
  // Anchor `from` after the opening `[[` so the completion only
  // replaces the query, not the brackets.
  const queryStart = match.from + 2;
  const query = context.state.sliceDoc(queryStart, context.pos).toLowerCase();

  const files = await loadVaultFiles();
  if (files.length === 0) return null;

  // Count basenames so we can disambiguate when needed.
  const counts = new Map<string, number>();
  for (const f of files) {
    const base = f.name.replace(/\.md$/, '');
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  const ranked = files
    .map((f) => {
      const base = f.name.replace(/\.md$/, '');
      const inName = base.toLowerCase().includes(query);
      const inPath = f.path.toLowerCase().includes(query);
      if (!inName && !inPath) return null;
      return {
        file: f,
        base,
        score: (inName ? 2 : 0) + (base.toLowerCase().startsWith(query) ? 1 : 0),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score || a.base.localeCompare(b.base))
    .slice(0, 50);

  if (ranked.length === 0) return null;

  return {
    from: queryStart,
    to: context.pos,
    filter: false,
    options: ranked.map(({ file, base }) => {
      const ambiguous = (counts.get(base) ?? 0) > 1;
      // When the basename is unique, store just the basename — clean
      // wikilinks. When it collides, store folder-qualified path so
      // navigation resolves unambiguously.
      const insertTarget = ambiguous ? file.path.replace(/\.md$/, '') : base;
      return {
        label: base,
        detail: file.path,
        apply: insertTarget,
      };
    }),
  };
}

// ─── Live-preview decorations ─────────────────────────────────────
// Hide markdown syntax markers (`# `, `**`, `*`, `_`) when the
// cursor is not on the same line. The result reads like rendered
// prose; the moment you click into a line the markers reappear so
// you can edit cleanly. Same idea as Obsidian's live preview.
const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = compute(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = compute(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

function compute(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sel = view.state.selection.main;
  // A line is "active" if the cursor is on it OR any selection
  // touches it. Active lines render the raw markdown so the user
  // can see what they're editing.
  const startLine = view.state.doc.lineAt(sel.from).number;
  const endLine = view.state.doc.lineAt(sel.to).number;
  const hide = Decoration.replace({});
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'HeaderMark' && node.name !== 'EmphasisMark') return;
        const line = view.state.doc.lineAt(node.from).number;
        if (line >= startLine && line <= endLine) return;
        if (node.name === 'HeaderMark') {
          // Eat the trailing space too so the line aligns left.
          const next = view.state.doc.sliceString(node.to, node.to + 1);
          const end = next === ' ' ? node.to + 1 : node.to;
          builder.add(node.from, end, hide);
        } else {
          builder.add(node.from, node.to, hide);
        }
      },
    });
  }
  return builder.finish();
}

const editorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text-primary)',
      backgroundColor: 'transparent',
      height: '100%',
      fontSize: '14px',
    },
    '.cm-content': {
      caretColor: 'var(--text-primary)',
      // Proportional font so the editor reads as prose, not code.
      fontFamily:
        'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: '0',
      lineHeight: '1.7',
    },
    // Container handles horizontal padding now (max-width column) so
    // remove the per-line padding that was here for the edge-to-edge
    // layout.
    '.cm-line': {
      padding: '0',
    },
    // Subtle vertical rhythm around lines that contain heading marks
    // so they feel like headings, not just big text.
    '.cm-line:has(> .cm-heading-1)': { marginTop: '0.6em', marginBottom: '0.2em' },
    '.cm-line:has(> .cm-heading-2)': { marginTop: '0.5em', marginBottom: '0.2em' },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--text-primary)',
    },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, ::selection, .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--slate) 30%, transparent)',
    },
    '.cm-gutters': { display: 'none' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-placeholder': { color: 'var(--text-ghost)', fontStyle: 'italic' },
    '.cm-scroller': { overflow: 'auto' },
    // Autocomplete tooltip — match the loops-ui surface so the
    // wikilink dropdown reads as part of the app, not a default
    // CodeMirror artifact.
    '.cm-tooltip.cm-tooltip-autocomplete': {
      backgroundColor: 'var(--surface-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '11px',
    },
    '.cm-tooltip-autocomplete > ul': { maxHeight: '240px' },
    '.cm-tooltip-autocomplete > ul > li': {
      padding: '3px 8px',
      color: 'var(--text-secondary)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'color-mix(in srgb, var(--mauve) 25%, transparent)',
      color: 'var(--text-primary)',
    },
    '.cm-completionLabel': { color: 'var(--text-primary)' },
    '.cm-completionDetail': {
      color: 'var(--text-ghost)',
      fontStyle: 'normal',
      fontSize: '10px',
      marginLeft: '8px',
    },
  },
  { dark: false },
);

const mdHighlight = HighlightStyle.define([
  // Heading sizes large enough that hidden `#` markers still visually
  // read as headings — the live-preview effect.
  { tag: t.heading1, color: 'var(--text-primary)', fontWeight: '700', fontSize: '24px' },
  { tag: t.heading2, color: 'var(--text-primary)', fontWeight: '600', fontSize: '20px' },
  { tag: t.heading3, color: 'var(--text-primary)', fontWeight: '600', fontSize: '17px' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--text-primary)', fontWeight: '600', fontSize: '15px' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text-primary)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--slate)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--slate)' },
  { tag: t.monospace, color: 'var(--tan)', fontFamily: 'ui-monospace, monospace' },
  { tag: t.list, color: 'var(--text-secondary)' },
  { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: t.atom, color: 'var(--mauve)' },
  { tag: t.meta, color: 'var(--text-tertiary)' },
  { tag: t.processingInstruction, color: 'var(--text-ghost)' },
]);

export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave?: (current: string) => void;
  onBlur?: (current: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onBlur,
  placeholder,
  autoFocus,
  className,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Stash the latest callbacks so the editor's keymap closure always
  // sees fresh values without us having to rebuild the editor.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onBlurRef = useRef(onBlur);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onBlurRef.current = onBlur;

  // One-time editor construction. We deliberately don't put `value` in
  // deps — value updates flow in via the setState effect below.
  useEffect(() => {
    if (!hostRef.current) return;

    const saveCompartment = new Compartment();

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        indentOnInput(),
        bracketMatching(),
        markdown({ base: markdownLanguage, addKeymap: true }),
        syntaxHighlighting(mdHighlight),
        livePreview,
        autocompletion({
          override: [wikilinkCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
        }),
        editorTheme,
        EditorView.lineWrapping,
        placeholder ? placeholderExt(placeholder) : [],
        saveCompartment.of(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: (view) => {
                onSaveRef.current?.(view.state.doc.toString());
                return true;
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          blur: (_e, view) => {
            onBlurRef.current?.(view.state.doc.toString());
            return false;
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    if (autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external `value` updates into the editor without losing
  // user focus or selection unless the doc actually differs.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} className={className} />;
}
