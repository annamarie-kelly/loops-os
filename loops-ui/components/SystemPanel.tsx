'use client';

// SystemPanel — a modal that shows what's wired up and what each
// connection unlocks. Designed for someone who just cloned the public
// repo: at a glance they see green ✓ for "this is on" and red ✗ for
// "this is required and missing" plus a one-line "what this enables"
// hint. Optional integrations get a quiet ○.
//
// Opens via the Header cog or `s` (when no input is focused). Loads
// /api/system on demand — no preflight on mount.

import { useEffect, useState } from 'react';

interface SystemSnapshot {
  vault: {
    path: string;
    exists: boolean;
    loopsCount: number;
    lastScan: string | null;
    fileCount: number;
  };
  config: {
    present: boolean;
    stakeholderName: string | null;
    p1Cap: number | null;
    selfCap: number | null;
  };
  calendar: {
    present: boolean;
    eventCount: number;
    lastSynced: string | null;
  };
  claudeCli: {
    detected: boolean;
    path: string | null;
  };
  obsidian: {
    envSet: boolean;
    vaultName: string | null;
  };
  extension: {
    likelyInstalled: boolean;
    lastCapture: string | null;
  };
  mcp: {
    inboxSkillPresent: boolean;
    skillCount: number;
  };
  env: {
    nodeVersion: string;
    cwd: string;
  };
}

type IconKind = 'ok' | 'missing' | 'optional';

function StatusIcon({ kind }: { kind: IconKind }) {
  if (kind === 'ok') {
    return (
      <span className="text-emerald-400 font-mono text-[13px] leading-none w-4 inline-flex justify-center">
        ✓
      </span>
    );
  }
  if (kind === 'missing') {
    return (
      <span className="text-rose-text font-mono text-[13px] leading-none w-4 inline-flex justify-center">
        ✗
      </span>
    );
  }
  return (
    <span className="text-ink-ghost font-mono text-[13px] leading-none w-4 inline-flex justify-center">
      ○
    </span>
  );
}

function Row({
  icon,
  name,
  state,
  enables,
  fix,
}: {
  icon: IconKind;
  name: string;
  state: string;
  enables: string;
  fix?: { label: string; href?: string; hint?: string };
}) {
  return (
    <div className="px-5 py-2.5 border-b border-edge-subtle last:border-b-0 flex items-start gap-3">
      <div className="pt-[2px] shrink-0">
        <StatusIcon kind={icon} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-[12px] text-ink font-medium">{name}</span>
          <span className="text-[10px] font-mono text-ink-faint tabular-nums truncate">
            {state}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-ink-ghost flex items-baseline gap-1.5">
          <span className="text-ink-ghost/60">→</span>
          <span>{enables}</span>
        </div>
        {fix && (
          <div className="mt-1 text-[10px] text-ink-faint">
            {fix.href ? (
              <a
                href={fix.href}
                target="_blank"
                rel="noreferrer"
                className="text-ink-ghost hover:text-ink-soft underline decoration-dotted"
                title={fix.hint}
              >
                {fix.label}
              </a>
            ) : (
              <span title={fix.hint} className="text-ink-ghost">
                {fix.label}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function shortPath(p: string): string {
  // Tighten verbose absolute paths so the row state stays scannable.
  // process.env.HOME isn't available in the browser bundle — use a
  // generic /Users/<name> heuristic instead. macOS/Linux only; Windows
  // falls through unchanged.
  const m = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) return '~' + (m[1] ?? '');
  return p;
}

export function SystemPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<SystemSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open. Re-fetch each time the panel opens so a stranger
  // who just edited their .env / config sees the new state without
  // a hard reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/system')
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((j: SystemSnapshot) => {
        if (cancelled) return;
        setData(j);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'failed');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows: Array<{
    icon: IconKind;
    name: string;
    state: string;
    enables: string;
    fix?: { label: string; href?: string; hint?: string };
  }> = [];

  if (data) {
    // 1. Vault
    rows.push({
      icon: data.vault.exists ? 'ok' : 'missing',
      name: 'Vault',
      state: data.vault.exists
        ? `${shortPath(data.vault.path)} · ${data.vault.fileCount}${data.vault.fileCount >= 1000 ? '+' : ''} md · ${data.vault.loopsCount} loops`
        : `not found at ${shortPath(data.vault.path)}`,
      enables: 'Read & write surface for everything',
      fix: data.vault.exists
        ? undefined
        : {
            label: 'Set LOOPS_UI_VAULT_ROOT in .env.local',
          },
    });

    // 2. Loops config
    const cfgOk = data.config.present && !!data.config.stakeholderName;
    rows.push({
      icon: data.config.present ? (cfgOk ? 'ok' : 'optional') : 'missing',
      name: 'Loops config',
      state: data.config.present
        ? `stakeholder: ${data.config.stakeholderName ?? '—'} · P1 cap ${data.config.p1Cap ?? '—'} · self cap ${data.config.selfCap ?? '—'}`
        : 'loops.config.json missing',
      enables: 'Stakeholder used in P1:<name>, caps gate triage',
      fix: data.config.present
        ? data.config.stakeholderName
          ? undefined
          : { label: 'Set stakeholder.name in loops.config.json' }
        : { label: 'Create loops.config.json at repo root' },
    });

    // 3. Calendar
    rows.push({
      icon: data.calendar.present ? 'ok' : 'optional',
      name: 'Calendar',
      state: data.calendar.present
        ? `${data.calendar.eventCount} events · synced ${relativeTime(data.calendar.lastSynced)}`
        : '06-Loops/calendar-today.json missing',
      enables: 'Plan view shows fixed blocks',
      fix: data.calendar.present
        ? undefined
        : {
            label: 'Drop a calendar-today.json into 06-Loops/',
            hint: 'Schema: { lastSynced, events: [{id, date, title, startMinute, endMinute}] }',
          },
    });

    // 4. Claude Code CLI
    rows.push({
      icon: data.claudeCli.detected ? 'ok' : 'optional',
      name: 'Claude Code CLI',
      state: data.claudeCli.detected
        ? data.claudeCli.path ?? 'detected'
        : 'not detected',
      enables: 'Chat panel + skills',
      fix: data.claudeCli.detected
        ? undefined
        : { label: 'Install: claude.ai/code', href: 'https://claude.ai/code' },
    });

    // 5. Obsidian
    rows.push({
      icon: data.obsidian.envSet ? 'ok' : 'optional',
      name: 'Obsidian',
      state: data.obsidian.envSet
        ? `vault: ${data.obsidian.vaultName}`
        : 'NEXT_PUBLIC_OBSIDIAN_VAULT unset',
      enables: 'Open-in-Obsidian buttons in detail drawer',
      fix: data.obsidian.envSet
        ? undefined
        : { label: 'Set NEXT_PUBLIC_OBSIDIAN_VAULT in .env.local' },
    });

    // 6. Chrome extension
    rows.push({
      icon: data.extension.likelyInstalled ? 'ok' : 'optional',
      name: 'Chrome extension',
      state: data.extension.likelyInstalled
        ? `last capture ${relativeTime(data.extension.lastCapture)}`
        : 'no captures detected',
      enables: '⌘⇧L capture from any tab',
      fix: data.extension.likelyInstalled
        ? undefined
        : {
            label: 'Load unpacked from tools/loops-capture-extension/',
            hint: 'chrome://extensions → Developer mode → Load unpacked',
          },
    });

    // 7. MCP / Skills
    rows.push({
      icon: data.mcp.inboxSkillPresent ? 'ok' : 'optional',
      name: 'MCP / Skills',
      state: `${data.mcp.skillCount} skill${data.mcp.skillCount === 1 ? '' : 's'}${data.mcp.inboxSkillPresent ? ' · inbox ✓' : ''}`,
      enables: '/inbox, /triage, /distill etc. via /start or directly in Claude Code',
      fix: data.mcp.inboxSkillPresent
        ? undefined
        : { label: 'Add inbox.md to <vault>/.claude/commands/' },
    });

    // 8. Runtime — informational
    rows.push({
      icon: 'ok',
      name: 'Runtime',
      state: `node ${data.env.nodeVersion} · ${shortPath(data.env.cwd)}`,
      enables: 'Server process info',
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="System"
      className="fixed inset-0 z-[60] flex justify-center pt-[12vh] px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" aria-hidden />
      <div
        className="relative w-[520px] max-w-full max-h-[78vh] bg-elevated border border-edge rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-3 pb-2.5 border-b border-edge shrink-0 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.12em] text-ink-ghost mb-0.5">
              System
            </div>
            <div className="text-[12px] text-ink-soft">
              What's wired up and what it unlocks.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-ghost hover:text-ink text-xl leading-none shrink-0 w-7 h-7 flex items-center justify-center rounded-md hover:bg-inset"
            title="Close (esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle">
          {loading && (
            <div className="px-5 py-6 text-[12px] text-ink-ghost">
              Loading…
            </div>
          )}
          {!loading && error && (
            <div className="px-5 py-4 text-[12px] text-rose-text">
              Failed to load: {error}
            </div>
          )}
          {!loading && !error && data && (
            <div>
              {rows.map((r) => (
                <Row
                  key={r.name}
                  icon={r.icon}
                  name={r.name}
                  state={r.state}
                  enables={r.enables}
                  fix={r.fix}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-2 border-t border-edge-subtle shrink-0 text-[10px] text-ink-ghost flex items-center justify-between">
          <span>
            <kbd className="font-mono border border-edge rounded px-1 py-[1px]">s</kbd>{' '}
            to toggle ·{' '}
            <kbd className="font-mono border border-edge rounded px-1 py-[1px]">esc</kbd>{' '}
            to close
          </span>
          <span className="font-mono">
            ✓ on · ✗ required missing · ○ optional
          </span>
        </div>
      </div>
    </div>
  );
}
