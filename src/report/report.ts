// Tiered, CI-greppable report. Plain text or --json. No TUI/panes.
// Exit: 0 clean / 1 drift. --fail-on selects which tiers count as failure.
import type { Finding, Tier } from '../types.js';

const TIER_TITLES: Record<Tier, string> = {
  declared: 'DECLARED DRIFT',
  undeclared: 'UNDECLARED DRIFT (the differentiator)',
  readGap: 'READ GAP (declared but not returned by live read — not drift)',
  unresolved: 'UNRESOLVED (declared paths needing GetAtt — skipped, not drift)',
  skipped: 'SKIPPED (CC API unsupported / no physical id)',
};
const ORDER: Tier[] = ['declared', 'undeclared', 'readGap', 'unresolved', 'skipped'];

export type FailOn = 'declared' | 'undeclared';
export interface ReportOptions {
  json?: boolean;
  failOn?: FailOn; // default 'undeclared' (declared + undeclared both fail)
  log?: (s: string) => void;
}

export function formatFinding(f: Finding): string {
  let s = `${f.path ? `${f.logicalId}.${f.path}` : f.logicalId} (${f.resourceType})`;
  if (f.note) s += ` — ${f.note}`;
  if (f.tier === 'declared') s += `\n      desired=${j(f.desired)}\n      actual =${j(f.actual)}`;
  else if (f.tier === 'undeclared') s += ` = ${j(f.actual)}`;
  return s;
}

function failTiers(failOn: FailOn): Tier[] {
  return failOn === 'declared' ? ['declared'] : ['declared', 'undeclared'];
}

export function report(findings: Finding[], header: string, opts: ReportOptions = {}): number {
  const log = opts.log ?? console.log;
  const fail = failTiers(opts.failOn ?? 'undeclared');
  const drifted = findings.filter((f) => fail.includes(f.tier)).length;

  if (opts.json) {
    log(JSON.stringify({ stack: header, drifted, findings }, null, 2));
    return drifted === 0 ? 0 : 1;
  }

  const byTier = (t: Tier) => findings.filter((f) => f.tier === t);
  log(`\n=== cdkdrift check: ${header} ===`);
  for (const tier of ORDER) {
    const items = byTier(tier);
    log(`\n[${TIER_TITLES[tier]}] ${items.length}`);
    for (const f of items) log('  ' + formatFinding(f));
  }
  const counts = ORDER.map((t) => `${t}=${byTier(t).length}`).join(' ');
  log(`\nresult: ${drifted === 0 ? 'CLEAN' : `${drifted} drift(s)`} (${counts}; fail-on=${opts.failOn ?? 'undeclared'})`);
  return drifted === 0 ? 0 : 1;
}
function j(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 200 ? s.slice(0, 200) + '…' : s;
}
