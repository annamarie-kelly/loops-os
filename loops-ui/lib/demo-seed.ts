// demo-seed — opt-in onboarding seed. Drops a small set of varied
// loops into the inbox plus a couple of realistic vault docs so the
// surfaces (research shelf, captured.md) have something to render
// for an explorer. Doesn't know about page state — takes createLoop
// as a parameter and writes vault files via the existing API.

import type { Loop } from '@/lib/types';

const DEMO_FLAG = 'loops-ui:demo-seeded';

interface DemoLoop {
  text: string;
  pLevel: string;
  domain: string;
  timeEstimateMinutes: number | null;
}

const DEMO_LOOPS: DemoLoop[] = [
  {
    text: 'Reply to Sarah about the redesign brief',
    pLevel: 'P1:Sarah',
    domain: 'work',
    timeEstimateMinutes: 20,
  },
  {
    text: 'Draft Q3 OKRs',
    pLevel: 'P2',
    domain: 'work',
    timeEstimateMinutes: 90,
  },
  {
    text: 'Investigate the Tuesday outage',
    pLevel: 'P1:self',
    domain: 'work',
    timeEstimateMinutes: 60,
  },
  {
    text: 'Schedule 1:1 with Marcus',
    pLevel: 'P3',
    domain: 'work',
    timeEstimateMinutes: 10,
  },
  {
    text: "Read the 'Thinking in Systems' chapter Anna recommended",
    pLevel: 'P3',
    domain: 'personal',
    timeEstimateMinutes: 45,
  },
];

const DEMO_DOCS: Array<{ file: string; content: string }> = [
  {
    file: '00-Inbox/Demo - Output Templates.md',
    content: `# Output Templates

Quick reference for the shapes we ship most often. Treat each section as a starting point, not a contract.

## One-pager
Lead with the decision being asked, not the background. Two sentences of context, then the ask, then the options. Reviewers are skimming.

## Status update
Three bullets: what shipped, what's in flight, what's blocked. Keep blockers concrete — name the person or the dependency, not just "waiting on X."

## Postmortem
Timeline, contributing factors, what surprised us. Avoid root-cause language; most outages have several causes that compounded.
`,
  },
  {
    file: '02-Thinking/Demo - Pricing experiments.md',
    content: `# Pricing experiments

Rough notes from the pricing thread last week. Not a proposal yet — just trying to map what we'd actually need to learn before changing the public page.

## What we don't know
We don't have a clean read on willingness-to-pay above the current top tier. The handful of customers who asked about higher seats all came in through sales, so the data is filtered. A self-serve experiment would tell us more in two weeks than another quarter of anecdotes.

## Smallest first move
Run a price test on the new "team" tier, holding seat count constant. Vary list price across three buckets. Measure conversion and time-to-close, not just revenue per signup — a higher price that slows everything down isn't a win.

## What I'm worried about
The brand cost of getting caught running a test. Worth a conversation with Sarah before we ship anything that varies by visitor.
`,
  },
];

export async function loadDemoSeed(
  createLoop: (draft: Omit<Loop, 'id'>) => Promise<void> | void,
): Promise<void> {
  const now = new Date().toISOString();
  for (const seed of DEMO_LOOPS) {
    const draft: Omit<Loop, 'id'> = {
      tier: 'now',
      text: seed.text,
      pLevel: seed.pLevel,
      // Skip triage for demo data — explorers want to see the
      // surfaces populated, not run the triage flow on fake loops.
      status: 'active',
      difficulty: null,
      timeEstimateMinutes: seed.timeEstimateMinutes,
      subGroup: null,
      domain: seed.domain,
      source: { file: '00-Inbox/captured.md', line: 1 },
      timeblocks: [],
      done: false,
      updatedAt: now,
      // 'demo' marker lets the Header surface a "clear demo" pill
      // once the user starts capturing their own loops.
      tendSource: 'demo',
    };
    await createLoop(draft);
  }

  // Best-effort vault writes — failures are non-fatal so the demo
  // still works on a misconfigured vault path.
  await Promise.all(
    DEMO_DOCS.map((doc) =>
      fetch('/api/vault/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: doc.file, content: doc.content }),
      }).catch(() => undefined),
    ),
  );

  try {
    localStorage.setItem(DEMO_FLAG, new Date().toISOString());
  } catch {
    // localStorage access can throw in some private modes; ignore.
  }
}

// Marks every demo loop as done — same shape as a normal "drop"
// disposition, so the rest of the system treats them as triaged-out
// rather than sitting in the active set. Caller invalidates state.
export function isDemoLoop(loop: { tendSource?: string }): boolean {
  return loop.tendSource === 'demo';
}

export async function clearDemoSeed(
  updateLoop: (id: string, patch: Partial<Loop>) => Promise<void> | void,
  loops: Loop[],
): Promise<void> {
  const demos = loops.filter((l) => isDemoLoop(l) && !l.done);
  for (const l of demos) {
    // Same shape as a "drop" disposition — status:'dropped' + done.
    await updateLoop(l.id, { status: 'dropped', done: true });
  }
  try {
    localStorage.removeItem(DEMO_FLAG);
  } catch {
    // ignore
  }
}
