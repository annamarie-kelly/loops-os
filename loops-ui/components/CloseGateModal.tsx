'use client';

// CloseGateModal: a lightweight close-out check. Three quick fields
// (docs, stakeholder, artifact link) plus an optional follow-through
// toggle. Non-blocking in the UI — "Ship it" is always enabled. The
// modal's job is to leave a legible audit trail in the boundary log,
// not to interrogate.
//
// Hard-gate policy lives in lib/tend-gates.ts: `checkCloseOutGate`
// treats `close_out_missing_stakeholder` as the single reason to
// actually block a close event through `applyEvent` (web API + CLI
// path). Everything else here is advisory surface. If you change the
// threshold, change it in lib/tend-gates.ts — this component only
// renders status dots.
//
// The "Linear" check row was intentionally removed — wire it back in
// if you run Linear and want ticket-closure to block the gate.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CloseOutCheckStatus, CloseOutEntry, Loop } from '@/lib/types';
import { appendCloseOut, detectFollowThroughKeywords } from '@/lib/tend';
import { STAKEHOLDERS } from '@/lib/ui';
import { renderInlineMarkdown } from '@/lib/markdown';

type CheckKey = 'docs' | 'stakeholder' | 'artifact' | 'follow_through';

const CHECK_LABELS: Record<CheckKey, string> = {
  docs: 'Docs touched',
  stakeholder: 'Stakeholder notified',
  artifact: 'Artifact attached',
  follow_through: 'Follow-through loop',
};

function statusColor(s: CloseOutCheckStatus | 'n/a'): string {
  switch (s) {
    case 'green':
      return 'var(--sage)';
    case 'red':
      return 'var(--rose)';
    case 'accepted':
      return 'var(--tan)';
    case 'n/a':
    default:
      return 'var(--edge)';
  }
}

function plusDaysISO(days: number, reference: Date = new Date()): string {
  const d = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() + days,
  );
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface CloseGateProceedResult {
  followThroughRequested: boolean;
  followThroughDate: string;
  followThroughTitle: string;
  artifact: string;
}

export function CloseGateModal({
  open,
  loop,
  onCancel,
  onProceed,
}: {
  open: boolean;
  loop: Loop | null;
  onCancel: () => void;
  onProceed: (result: CloseGateProceedResult) => void | Promise<void>;
}) {
  // Docs: single free-text input or "no doc change needed"
  const [docs, setDocs] = useState('');
  const [noDocs, setNoDocs] = useState(false);

  // Stakeholder
  const [stakeholder, setStakeholder] = useState<string>('');
  const [audience, setAudience] = useState('');

  // Artifact: URL or path to an HTML artifact / folder / file.
  // `artifactKind` tracks whether it was typed or picked via the
  // folder chooser so the audit trail makes sense.
  const [artifactPath, setArtifactPath] = useState('');
  const [artifactKind, setArtifactKind] = useState<'none' | 'link' | 'folder'>('none');

  // Follow-through toggle (auto-suggests when validation vocab shows up).
  const [followThroughChecked, setFollowThroughChecked] = useState(false);
  const [followThroughDate, setFollowThroughDate] = useState(plusDaysISO(14));

  // Optional short note. Not required.
  const [note, setNote] = useState('');

  const folderInputRef = useRef<HTMLInputElement>(null);

  const autoFollowThrough = useMemo(() => {
    if (!loop) return false;
    return detectFollowThroughKeywords(`${loop.text} ${loop.source.file}`);
  }, [loop]);

  // Reset state every time the modal opens on a new loop.
  useEffect(() => {
    if (!open || !loop) return;
    setDocs('');
    setNoDocs(false);
    const p = loop.pLevel ?? '';
    const colonIdx = p.indexOf(':');
    const defaultStakeholder =
      colonIdx >= 0 ? p.slice(colonIdx + 1) : '';
    setStakeholder(defaultStakeholder);
    setAudience('');
    setArtifactPath('');
    setArtifactKind('none');
    setFollowThroughChecked(autoFollowThrough);
    setFollowThroughDate(plusDaysISO(14));
    setNote('');
  }, [open, loop, autoFollowThrough]);

  // Escape closes — the gate is advisory, not blocking.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open || !loop) return null;

  // ─── Derive status dots (visual cue only, no gating) ──────────────
  const docsStatus: CloseOutCheckStatus =
    noDocs ? 'accepted' : docs.trim().length > 0 ? 'green' : 'red';
  const stakeholderStatus: CloseOutCheckStatus =
    stakeholder.trim().length > 0 || audience.trim().length > 0 ? 'green' : 'red';
  const artifactStatus: CloseOutCheckStatus =
    artifactPath.trim().length > 0 ? 'green' : 'accepted';
  const followThroughStatus: CloseOutCheckStatus | 'n/a' =
    followThroughChecked ? 'green' : autoFollowThrough ? 'red' : 'n/a';

  const onPickFolder: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // webkitRelativePath is "folder/subfolder/file.ext" — take the
    // top-level folder name as the artifact label.
    const first = files[0];
    const rel: string =
      (first as File & { webkitRelativePath?: string }).webkitRelativePath ||
      first.name;
    const folder = rel.split('/')[0] || rel;
    setArtifactPath(folder);
    setArtifactKind('folder');
  };

  const buildArtifact = (): string => {
    const lines: string[] = [];
    lines.push(`Close-out: ${loop.text} (${loop.id})`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(
      `Docs: ${docsStatus}${docs ? ` -> ${docs}` : noDocs ? ' -> n/a' : ''}`,
    );
    const stakeParts: string[] = [];
    if (stakeholder) stakeParts.push(stakeholder);
    if (audience) stakeParts.push(audience);
    lines.push(
      `Stakeholder: ${stakeholderStatus}${
        stakeParts.length ? ` -> ${stakeParts.join(', ')}` : ''
      }`,
    );
    lines.push(
      `Artifact: ${artifactStatus}${
        artifactPath ? ` -> ${artifactKind}: ${artifactPath}` : ''
      }`,
    );
    lines.push(
      `Follow-through: ${
        followThroughStatus === 'n/a'
          ? 'n/a'
          : followThroughChecked
            ? `scheduled ${followThroughDate}`
            : 'skipped'
      }`,
    );
    if (note.trim()) {
      lines.push('');
      lines.push(`Note: ${note.trim()}`);
    }
    return lines.join('\n');
  };

  const handleProceed = async () => {
    const artifact = buildArtifact();
    const entry: CloseOutEntry = {
      loop_id: loop.id,
      loop_title: loop.text,
      timestamp: new Date().toISOString(),
      checks: {
        docs: docsStatus,
        stakeholder: stakeholderStatus,
        // `handoff` in the ledger type now maps to the artifact field.
        handoff: artifactStatus,
        follow_through: followThroughStatus,
      },
      gaps_accepted: [],
      reason: note.trim() || undefined,
      artifact,
    };
    appendCloseOut(entry);
    await onProceed({
      followThroughRequested: followThroughChecked,
      followThroughDate,
      followThroughTitle: `Follow-through: ${loop.text}`,
      artifact,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Close-out gate"
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] px-4"
    >
      <div
        className="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
        aria-hidden
        onClick={onCancel}
      />
      <div
        className="relative w-[540px] max-w-full max-h-[78vh] bg-elevated border border-edge rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-edge-subtle shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="w-[8px] h-[8px] rounded-full"
              style={{ background: 'var(--mauve)' }}
              aria-hidden
            />
            <span className="text-[10px] uppercase tracking-[0.12em] text-mauve-text">
              Close-out
            </span>
          </div>
          <div className="text-[14px] text-ink font-medium leading-snug">
            {renderInlineMarkdown(loop.text)}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-subtle px-5 py-4 flex flex-col gap-4">
          {/* Docs */}
          <CheckRow label="Docs touched" status={docsStatus}>
            <input
              type="text"
              value={docs}
              onChange={(e) => setDocs(e.target.value)}
              placeholder="skill card, _patterns.md, etc. (blank = n/a)"
              disabled={noDocs}
              className="w-full text-[12px] text-ink bg-card border border-edge rounded-md px-2.5 py-1.5 placeholder:text-ink-ghost/60 focus:outline-none focus:border-[var(--sage)]/50 disabled:opacity-40 transition-colors"
            />
            <label className="flex items-center gap-2 text-[11px] text-ink-soft mt-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={noDocs}
                onChange={(e) => setNoDocs(e.target.checked)}
                className="accent-[var(--tan)]"
              />
              no doc change needed
            </label>
          </CheckRow>

          {/* Stakeholder */}
          <CheckRow label="Stakeholder notified" status={stakeholderStatus}>
            <div className="flex gap-2">
              <select
                value={stakeholder}
                onChange={(e) => setStakeholder(e.target.value)}
                className="text-[12px] text-ink bg-card border border-edge rounded-md px-2 py-1.5 focus:outline-none focus:border-[var(--sage)]/50"
              >
                <option value="">select</option>
                {STAKEHOLDERS.filter((s) => s !== 'None').map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value="self">self</option>
              </select>
              <input
                type="text"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="or free-text"
                className="flex-1 text-[12px] text-ink bg-card border border-edge rounded-md px-2.5 py-1.5 placeholder:text-ink-ghost/60 focus:outline-none focus:border-[var(--sage)]/50 transition-colors"
              />
            </div>
          </CheckRow>

          {/* Artifact */}
          <CheckRow label="Artifact" status={artifactStatus}>
            <div className="flex gap-2">
              <input
                type="text"
                value={artifactPath}
                onChange={(e) => {
                  setArtifactPath(e.target.value);
                  setArtifactKind(e.target.value.trim() ? 'link' : 'none');
                }}
                placeholder="URL, file, or folder name (optional)"
                className="flex-1 text-[12px] text-ink bg-card border border-edge rounded-md px-2.5 py-1.5 placeholder:text-ink-ghost/60 focus:outline-none focus:border-[var(--sage)]/50 transition-colors"
              />
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="text-[11px] text-ink-soft hover:text-ink px-2.5 py-1 rounded-md border-[0.5px] border-edge hover:border-[var(--sage)]/40 hover:bg-sage-fill hover:text-sage-text transition-colors whitespace-nowrap"
              >
                pick folder
              </button>
              {/* Hidden folder input — webkitdirectory is non-standard
                  but supported in all Chromium + Safari + Firefox. */}
              <input
                ref={folderInputRef}
                type="file"
                /* @ts-expect-error webkitdirectory is non-standard */
                webkitdirectory=""
                directory=""
                className="hidden"
                onChange={onPickFolder}
              />
            </div>
            <div className="text-[10px] text-ink-ghost mt-1 italic">
              optional — gap accepted if blank
            </div>
          </CheckRow>

          {/* Follow-through */}
          <CheckRow label="Follow-through loop" status={followThroughStatus}>
            <label className="flex items-center gap-2 text-[12px] text-ink-soft cursor-pointer">
              <input
                type="checkbox"
                checked={followThroughChecked}
                onChange={(e) => setFollowThroughChecked(e.target.checked)}
                className="accent-[var(--sage)]"
              />
              create a follow-through check-in loop
            </label>
            {autoFollowThrough && !followThroughChecked && (
              <div className="text-[10px] text-rose-text mt-1 italic">
                validation vocab detected — worth a follow-through
              </div>
            )}
            {followThroughChecked && (
              <div className="flex items-center gap-2 mt-2">
                <label className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
                  due
                </label>
                <input
                  type="date"
                  value={followThroughDate}
                  onChange={(e) => setFollowThroughDate(e.target.value)}
                  className="text-[12px] text-ink bg-card border border-edge rounded-md px-2 py-1 focus:outline-none focus:border-[var(--sage)]/50"
                />
              </div>
            )}
          </CheckRow>

          {/* Optional note */}
          <div className="border-t border-edge-subtle pt-3">
            <label className="text-[10px] uppercase tracking-[0.08em] text-ink-ghost">
              Note (optional)
            </label>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="anything worth remembering about how this wrapped up"
              className="mt-1 w-full text-[12px] text-ink bg-card border border-edge rounded-md px-2.5 py-2 placeholder:text-ink-ghost/60 focus:outline-none focus:border-[var(--sage)]/50 leading-relaxed transition-all"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-edge-subtle flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] text-ink-soft hover:text-ink px-3 py-1.5 rounded-md hover:bg-inset transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleProceed}
            className="text-[12px] text-ink bg-inset hover:bg-sage-fill hover:text-sage-text px-3 py-1.5 rounded-md border-[0.5px] border-edge hover:border-[var(--sage)]/40 transition-all"
          >
            Ship it
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckRow({
  label,
  status,
  children,
}: {
  label: string;
  status: CloseOutCheckStatus | 'n/a';
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        className="w-[10px] h-[10px] rounded-full shrink-0 mt-1.5"
        style={{ background: statusColor(status) }}
        aria-hidden
        title={status}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-ink font-medium mb-1.5">{label}</div>
        {children}
      </div>
    </div>
  );
}
