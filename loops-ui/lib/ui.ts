// Shared UI constants and tiny helpers for loops-ui.
// Keep this file narrow: constants, formatters, small pure functions.

import type { Loop, Tier, WorkMode, Domain } from './types';
import { DOMAIN_EMOJI } from './types';
import { config } from './config';
export type { WorkMode };

/**
 * Plain-text fallback for places that need a string (title attributes,
 * aria-labels, search needles). Strips all markdown ornaments and
 * returns clean content. For rendered output with real <strong>/<code>
 * markup use `renderInlineMarkdown` from lib/markdown.tsx.
 */
export function stripInlineMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, tgt, alias) => {
      const s = alias || tgt;
      return s.split('/').pop() ?? s;
    })
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1');
}

// ─── Work mode classification ────────────────────────────────────────
// Coarse 5-bucket "what kind of brain does this need?" tag. Inferred
// from the loop text via first-match keyword lookup; users can pin a
// loop manually via loop.workMode + loop.workModeSource='manual'.

export const WORK_MODES: WorkMode[] = [
  'build',
  'design',
  'communicate',
  'research',
  'ops',
  'unsorted',
];

export const WORK_MODE_META: Record<WorkMode, { label: string; accent: string }> = {
  build: { label: 'Build', accent: '--sage' },
  design: { label: 'Design', accent: '--mauve' },
  communicate: { label: 'Communicate', accent: '--slate' },
  research: { label: 'Research', accent: '--tan' },
  ops: { label: 'Ops', accent: '--rose' },
  unsorted: { label: 'Unsorted', accent: '--text-ghost' },
};

// Ordered keyword buckets. First match wins. Research/Design run BEFORE
// Build so "spec"/"architect"/"scope" don't get absorbed into Build when
// they co-occur with generic words like "build".
const WORK_MODE_KEYWORDS: { mode: WorkMode; words: string[] }[] = [
  {
    mode: 'research',
    words: [
      'scope', 'investigat', 'audit', 'analyz', 'compar', 'evaluat', 'assess',
      'benchmark', 'explor', 'rethink', 'full waterfall', 'inventory',
      'waterfall',
    ],
  },
  {
    mode: 'design',
    words: [
      'spec', 'design', 'architect', 'mapping', 'model', 'manifest',
      'boundary', 'framework', 'schema', 'ledger', 'snapshot', 'tripwire',
      'gate', 'template', 'decide', 'defin', 'outline', 'strateg', 'roadmap',
      'align', 'ownership', 'capacity',
    ],
  },
  {
    mode: 'communicate',
    words: [
      'email', 'send', 'push', 'share', 'sync', 'status', 'notify', 'ask',
      'follow up', 'slack', 'weekly', 'prep for', 'handoff', 'onboard',
      'checklist', 'review',
    ],
  },
  {
    mode: 'ops',
    words: [
      'retire', 'clean', 'maintain', 'monitor', 'check', 'verify', 'validat',
      'test', 'run ', 'dedup', 'compress', 'cleanup', 'retirement', 'fix',
      'debug', 'migration', 'bug',
    ],
  },
  {
    mode: 'build',
    words: [
      'code', 'build', 'implement', 'wire', 'wiring', 'create', 'scaffold',
      'connector', 'pipeline', 'router', 'consolidat', 'ship', 'deploy',
      'refactor',
    ],
  },
];

// Subgroup-name fallback. Applied only when keyword lookup misses or
// would put something obviously wrong. Keys are lowercase subGroup
// substrings; the first matching entry wins. Extend via
// loops.config.json → subgroupHints.
const SUBGROUP_HINTS: { match: string; mode: WorkMode }[] =
  config.subgroupHints.map((h) => ({ match: h.match, mode: h.mode as WorkMode }));

function classifyBySubgroup(subGroup: string | null | undefined): WorkMode | null {
  if (!subGroup) return null;
  const s = subGroup.toLowerCase();
  for (const { match, mode } of SUBGROUP_HINTS) {
    if (s.includes(match)) return mode;
  }
  return null;
}

export function classifyWorkMode(title: string, subGroup?: string | null): WorkMode {
  const lower = (title ?? '').toLowerCase();
  for (const { mode, words } of WORK_MODE_KEYWORDS) {
    for (const w of words) if (lower.includes(w)) return mode;
  }
  // Keyword miss → try the subgroup name as a secondary signal.
  const hint = classifyBySubgroup(subGroup);
  if (hint) return hint;
  return 'unsorted';
}

export function effectiveWorkMode(loop: Loop): WorkMode {
  return loop.workMode ?? classifyWorkMode(loop.text, loop.subGroup);
}

// ─── Triage grouping helpers ─────────────────────────────────────────

export type GroupDim = 'mode' | 'size' | 'person' | 'subgroup' | 'domain';

export interface TriageGroup {
  key: string;
  label: string;
  accent?: string;
  loops: Loop[];
}

export type SizeBucket = 'quick' | 'short' | 'medium' | 'deep' | 'unsized';

export function sizeBucket(m: number | null): SizeBucket {
  if (m == null) return 'unsized';
  if (m <= 15) return 'quick';
  if (m <= 45) return 'short';
  if (m <= 120) return 'medium';
  return 'deep';
}

const SIZE_ORDER: SizeBucket[] = ['quick', 'short', 'medium', 'deep', 'unsized'];
const SIZE_LABEL: Record<SizeBucket, string> = {
  quick: 'Quick (≤15m)',
  short: 'Short (≤45m)',
  medium: 'Medium (≤2h)',
  deep: 'Deep (2h+)',
  unsized: 'Unsized',
};

export function personFromPLevel(p: string | null): string | null {
  if (!p) return null;
  const colon = p.indexOf(':');
  if (colon < 0) return null;
  const rest = p.slice(colon + 1).trim();
  return rest.length > 0 ? rest : null;
}

function percentScheduled(list: Loop[]): number {
  if (list.length === 0) return 0;
  const scheduled = list.filter((l) => l.timeblocks.length > 0).length;
  return scheduled / list.length;
}

function sumMinutes(list: Loop[]): number {
  return list.reduce((s, l) => s + (l.timeEstimateMinutes ?? 0), 0);
}

export function buildGroups(loops: Loop[], dim: GroupDim): TriageGroup[] {
  if (dim === 'mode') {
    const buckets = new Map<WorkMode, Loop[]>();
    for (const m of WORK_MODES) buckets.set(m, []);
    for (const l of loops) buckets.get(effectiveWorkMode(l))!.push(l);
    return WORK_MODES.map((m) => ({
      key: `mode-${m}`,
      label: WORK_MODE_META[m].label,
      accent: WORK_MODE_META[m].accent,
      loops: buckets.get(m)!,
    })).filter((g) => g.loops.length > 0);
  }

  if (dim === 'size') {
    const buckets: Record<SizeBucket, Loop[]> = {
      quick: [],
      short: [],
      medium: [],
      deep: [],
      unsized: [],
    };
    for (const l of loops) buckets[sizeBucket(l.timeEstimateMinutes)].push(l);
    return SIZE_ORDER.map((k) => ({
      key: `size-${k}`,
      label: SIZE_LABEL[k],
      accent: k === 'unsized' ? '--rose' : undefined,
      loops: buckets[k],
    })).filter((g) => g.loops.length > 0);
  }

  if (dim === 'domain') {
    const buckets = new Map<string, Loop[]>();
    for (const l of loops) {
      const d = l.domain || 'personal';
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d)!.push(l);
    }
    const order: string[] = Object.keys(DOMAIN_EMOJI);
    const entries = [...buckets.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
    return entries
      .filter(([, list]) => list.length > 0)
      .map(([domain, list]) => ({
        key: `domain-${domain}`,
        label: `${DOMAIN_EMOJI[domain as Domain] ?? ''} ${domain.charAt(0).toUpperCase() + domain.slice(1)}`.trim(),
        loops: list,
      }));
  }

  if (dim === 'person') {
    const buckets = new Map<string, Loop[]>();
    for (const l of loops) {
      const person = personFromPLevel(l.pLevel) ?? 'Nobody';
      if (!buckets.has(person)) buckets.set(person, []);
      buckets.get(person)!.push(l);
    }
    const entries = [...buckets.entries()];
    entries.sort((a, b) => {
      if (a[0] === 'Nobody') return 1;
      if (b[0] === 'Nobody') return -1;
      return b[1].length - a[1].length;
    });
    return entries
      .filter(([, list]) => list.length > 0)
      .map(([person, list]) => ({
        key: `person-${person}`,
        label: person,
        loops: list,
      }));
  }

  // subgroup
  const buckets = new Map<string, Loop[]>();
  for (const l of loops) {
    const key = (l.subGroup ?? 'Other').trim() || 'Other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(l);
  }
  const other: Loop[] = buckets.get('Other') ?? [];
  const multi: { key: string; list: Loop[] }[] = [];
  for (const [k, list] of buckets.entries()) {
    if (k === 'Other') continue;
    if (list.length <= 1) {
      for (const l of list) other.push(l);
    } else {
      multi.push({ key: k, list });
    }
  }
  multi.sort((a, b) => {
    const ps = percentScheduled(a.list) - percentScheduled(b.list);
    if (ps !== 0) return ps;
    return sumMinutes(b.list) - sumMinutes(a.list);
  });
  const CAP = 5;
  const kept = multi.slice(0, CAP);
  const overflow = multi.slice(CAP);
  for (const { list } of overflow) for (const l of list) other.push(l);

  const groups: TriageGroup[] = kept.map(({ key, list }) => ({
    key: `sub-${key}`,
    label: key,
    loops: list,
  }));
  if (other.length > 0) {
    groups.push({ key: 'sub-Other', label: 'Other', loops: other });
  }
  return groups.filter((g) => g.loops.length > 0);
}

export const DAY_START_MIN = 7 * 60; // 7am — grid floor
export const DAY_END_MIN = 24 * 60; // midnight — grid ceiling
// Healthy working-hours budget used for the capacity bar + "free time" math.
export const HEALTHY_DAY_MINUTES = 12 * 60; // 7am-7pm working window
export const DAY_TOTAL_MIN = DAY_END_MIN - DAY_START_MIN;
export const SLOT_MIN = 15;

export const LS_MODE = 'loops-ui:mode';
export const LS_COLLAPSED_SUBGROUPS = 'loops-ui:collapsed-subgroups';
export const LS_INITIALIZED = 'loops-ui:initialized';
export const LS_SOMEDAY_EXPANDED = 'loops-ui:someday-expanded';

// UI modes. `triage` is the card-by-card intake queue for new loops;
// `backlog` is the group-by-Mode/Size/Person/Subgroup canvas; `someday`
// is the parked-items view (kept for backwards compat).
// SDLC pipeline modes: `research` surfaces vault research docs,
// `design` shows agent specs, `ship` is deploy verification + visual differ.
export type Mode =
  | 'focus'
  | 'plan'
  | 'triage'
  | 'backlog'
  | 'someday'
  | 'reflect'
  | 'research'
  | 'design'
  | 'ship';

// Canonical stakeholder list for the flat priority model. Derived at
// startup from loops.config.json so users can add their own colleagues
// / managers / collaborators without touching source. "Self" and
// "None" are always present: "Self" marks your own priorities,
// "None" means "no single stakeholder; this is yours to weigh."
export const STAKEHOLDERS: readonly string[] = [
  ...(config.stakeholder.name ? [config.stakeholder.name] : []),
  'Self',
  ...config.scannerStakeholders.map((s) => s.name),
  'None',
];
export type Stakeholder = string;

export type SortBy = 'default' | 'difficulty' | 'time' | 'subgroup' | 'due';

// P-level options surfaced in the LoopForm / BacklogProcessor drop-
// downs. P1:<stakeholder> pulls the primary stakeholder tag from
// config; P2:<name> rows are added per entry in scannerStakeholders.
export const P_LEVEL_OPTIONS: string[] = [
  'P0',
  'P1:self',
  `P1:${config.stakeholder.tag}`,
  'P2',
  ...config.scannerStakeholders.map((s) => `P2:${s.name}`),
  'P3',
  'P4',
];

export const DIFFICULTY_OPTIONS = [1, 2, 3, 5, 8, 13, 21];

export function pLevelRank(p: string | null): number {
  if (!p) return 99;
  if (p === 'P0') return 0;
  if (p.startsWith('P1')) return 1;
  if (p.startsWith('P2')) return 2;
  if (p.startsWith('P3')) return 3;
  if (p.startsWith('P4')) return 4;
  return 99;
}

export function pLevelBucket(p: string | null): string {
  if (!p) return 'P?';
  if (p.startsWith('P0')) return 'P0';
  if (p.startsWith('P1')) return 'P1';
  if (p.startsWith('P2')) return 'P2';
  if (p.startsWith('P3')) return 'P3';
  if (p.startsWith('P4')) return 'P4';
  return 'P?';
}

// Priority ramp — quiet semantic tokens mapped to the earthy accent palette.
// P0 = dusty rose (live fires), P1:self = sage (quiet urgency),
// P1 = warm tan (important, has a stakeholder), P2 = slate, P3/P4 = ghost.
export function pBarColor(p: string | null): string {
  if (!p) return 'bg-[var(--border-default)]';
  if (p.startsWith('P0')) return 'bg-[var(--rose)]';
  if (p.startsWith('P1:self')) return 'bg-[var(--sage)]';
  if (p.startsWith('P1')) return 'bg-[var(--tan)]';
  if (p.startsWith('P2')) return 'bg-[var(--slate)]';
  if (p.startsWith('P3')) return 'bg-[var(--text-ghost)]';
  if (p.startsWith('P4')) return 'bg-[var(--text-ghost)]';
  return 'bg-[var(--border-default)]';
}

export function pTextColor(p: string | null): string {
  if (!p) return 'text-ink-ghost';
  if (p.startsWith('P0')) return 'text-rose-text';
  if (p.startsWith('P1:self')) return 'text-sage-text';
  if (p.startsWith('P1')) return 'text-tan-text';
  if (p.startsWith('P2')) return 'text-slate-text';
  return 'text-ink-ghost';
}

// Pill background for priority badges. Quiet fills, not saturated.
export function pPillClass(p: string | null): string {
  if (!p) return 'bg-inset text-ink-ghost';
  if (p.startsWith('P0')) return 'bg-rose-fill text-rose-text';
  if (p.startsWith('P1:self')) return 'bg-sage-fill text-sage-text';
  if (p.startsWith('P1')) return 'bg-tan-fill text-tan-text';
  if (p.startsWith('P2')) return 'bg-slate-fill text-slate-text';
  if (p.startsWith('P3')) return 'bg-transparent text-ink-ghost';
  if (p.startsWith('P4')) return 'bg-transparent text-ink-ghost opacity-60';
  return 'bg-inset text-ink-ghost';
}

// localStorage key for theme preference (system | light | dark)
export const LS_THEME = 'loops-ui:theme';
export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

export function sortLoops(loops: Loop[], by: SortBy): Loop[] {
  const sorted = [...loops];
  sorted.sort((a, b) => {
    if (by === 'default') {
      const pa = pLevelRank(a.pLevel);
      const pb = pLevelRank(b.pLevel);
      if (pa !== pb) return pa - pb;
      return (a.difficulty ?? 99) - (b.difficulty ?? 99);
    }
    if (by === 'difficulty') return (a.difficulty ?? 99) - (b.difficulty ?? 99);
    if (by === 'time')
      return (a.timeEstimateMinutes ?? 999999) - (b.timeEstimateMinutes ?? 999999);
    if (by === 'subgroup') return (a.subGroup ?? '').localeCompare(b.subGroup ?? '');
    if (by === 'due') {
      const da = a.dueDate ?? '\uffff';
      const db = b.dueDate ?? '\uffff';
      if (da !== db) return da.localeCompare(db);
      return pLevelRank(a.pLevel) - pLevelRank(b.pLevel);
    }
    return 0;
  });
  return sorted;
}

export async function makeHashId(file: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${file}|${text}`);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .slice(0, 3)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function toggleSetValue<T>(
  setter: React.Dispatch<React.SetStateAction<Set<T>>>,
  value: T
) {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });
}

// Snap a minute-from-midnight value to the nearest SLOT_MIN multiple.
export function snapToSlot(min: number): number {
  return Math.round(min / SLOT_MIN) * SLOT_MIN;
}

export function minutesToPct(minutes: number): number {
  return ((minutes - DAY_START_MIN) / DAY_TOTAL_MIN) * 100;
}

export function durationToPct(duration: number): number {
  return (duration / DAY_TOTAL_MIN) * 100;
}

// Event type inference — until the calendar source tags types explicitly,
// we classify from the title string. Returns a semantic key that maps to
// the accent palette for left-border tinted event cards.
export type EventKind = 'deep' | 'urgent' | 'one-on-one' | 'team' | 'prep' | 'external' | 'low';

export function inferEventKind(title: string): EventKind {
  const t = title.toLowerCase();
  if (/\b(bug|fire|incident|oncall|urgent|p0|hotfix)\b/.test(t)) return 'urgent';
  if (/(1:1|1-1|one on one|sync w|sync with|chat w|catch.?up|<>| w\/ |weekly|monthly check)/.test(t)) return 'one-on-one';
  if (/\b(prep|prepare|review|read)\b/.test(t)) return 'prep';
  if (/\b(deep|focus|build|code|ship|write|draft|design)\b/.test(t)) return 'deep';
  if (/(standup|team|all hands|all-hands|retro|planning|demo|session|reset|sourcing|deal meeting)/.test(t)) return 'team';
  if (/(external|client|investor|board|dinner|lunch|coffee|offsite|teach.?in|kick.?off|portco)/.test(t)) return 'external';
  return 'low';
}

// Tailwind class triples for event blocks keyed by EventKind.
// border-l-2 left accent + 12% fill + darkened text.
export function eventKindClasses(kind: EventKind): {
  border: string;
  fill: string;
  text: string;
} {
  switch (kind) {
    case 'deep':
      return { border: 'border-l-[var(--sage)]', fill: 'bg-sage-fill', text: 'text-sage-text' };
    case 'urgent':
      return { border: 'border-l-[var(--rose)]', fill: 'bg-rose-fill', text: 'text-rose-text' };
    case 'one-on-one':
      return { border: 'border-l-[var(--berry)]', fill: 'bg-berry-fill', text: 'text-berry-text' };
    case 'team':
      return { border: 'border-l-[var(--slate)]', fill: 'bg-slate-fill', text: 'text-slate-text' };
    case 'prep':
      return { border: 'border-l-[var(--tan)]', fill: 'bg-tan-fill', text: 'text-tan-text' };
    case 'external':
      return { border: 'border-l-[var(--mauve)]', fill: 'bg-mauve-fill', text: 'text-mauve-text' };
    case 'low':
    default:
      return {
        border: 'border-l-[var(--slate)]',
        fill: 'bg-slate-fill',
        text: 'text-slate-text',
      };
  }
}

// Section labels for morning/afternoon/evening.
export const DAY_SECTIONS: { label: string; startMin: number; endMin: number }[] = [
  { label: 'morning', startMin: DAY_START_MIN, endMin: 12 * 60 },
  { label: 'afternoon', startMin: 12 * 60, endMin: 17 * 60 },
  { label: 'evening', startMin: 17 * 60, endMin: 21 * 60 },
  { label: 'night', startMin: 21 * 60, endMin: DAY_END_MIN },
];

export const TIER_LIST: Tier[] = ['now', 'soon', 'someday'];

// Domain icon mapping with ASCII fallbacks so we can keep emoji-dot use minimal.
export const DOMAIN_LABEL: Record<string, string> = {
  building: 'build',
  thinking: 'think',
  working: 'work',
  living: 'live',
  relating: 'relate',
};
