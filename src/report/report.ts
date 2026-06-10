// NEW. Tiered, CI-greppable report. Plain text + optional --json. No TUI/panes.
// Tiers (most → least urgent):
//   clobber > declared > important-undeclared (curated pack) > watched > suggestions/skipped
//
// Exit code: 0 clean / 1 drift / 2 error. --fail-on <tier> chooses the threshold
// (default does NOT fail CI on undeclared-only noise).

export type Tier = 'clobber' | 'declared' | 'important-undeclared' | 'watched' | 'suggestion' | 'skipped';

export interface Finding {
  tier: Tier;
  logicalId: string;
  resourceType: string;
  path: string;
  desired?: unknown;
  actual?: unknown;
  note?: string;
}

export function report(_findings: Finding[], _opts: { failOn?: Tier; json?: boolean }): number {
  // TODO(phase2): group by tier, print, compute exit code per failOn
  throw new Error('not implemented');
}
