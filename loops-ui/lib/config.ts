// Central config loader. Reads loops.config.json (at the repo root)
// at build time and exposes typed accessors. All "who is the primary
// stakeholder" / "how full can a priority bucket get" decisions flow
// through this module so the app can be retargeted without editing
// source.
//
// Users edit loops.config.json directly; there is no runtime mutation.
// Because Next.js imports JSON at build time, changes require a dev
// server restart (or rebuild in production).

import raw from '../loops.config.json';

export interface StakeholderConfig {
  name: string;
  tag: string;
  capacityMax: number;
  weeklySummary: boolean;
  staleDays: number;
}

export interface RepoConfig {
  name: string;
  path: string;
}

export type ResearchCategory =
  | 'strategic-research'
  | 'technical-investigation'
  | 'design-research'
  | 'foundational'
  | 'artifact';

export interface ResearchFolderConfig {
  folder: string;
  category: ResearchCategory;
  recursive: boolean;
  extensions?: string[];
}

export interface LoopsConfig {
  vault: {
    scanFolders: string[];
    inboxFile: string;
    adoptedFile: string;
    closeOutsFile: string;
  };
  stakeholder: StakeholderConfig;
  self: { capacityMax: number };
  priorityCaps: { P1Flat: number; P2Flat: number };
  scannerStakeholders: Array<{ keyword: string; name: string }>;
  subgroupHints: Array<{ match: string; mode: 'build' | 'design' | 'communicate' | 'research' | 'ops' }>;
  // Codebases the user works in. Surfaces as the ClaudeChat repo
  // picker so a chat session can run `claude -p` against the right
  // tree (instead of always defaulting to the vault).
  repos?: RepoConfig[];
  // Vault folders the Research shelf scans. When omitted, falls
  // back to the public-template defaults (01-Creating/artifacts,
  // 02-Thinking/reports, ...). Override per-user when the vault
  // layout differs.
  researchFolders?: ResearchFolderConfig[];
}

export const config: LoopsConfig = raw as LoopsConfig;

// Convenience: the composed pLevel strings the app filters on. Keeping
// these in one place means renaming the stakeholder only touches the
// config file.
export const P1_STAKEHOLDER = `P1:${config.stakeholder.tag}` as const;
export const P1_SELF = 'P1:self' as const;
