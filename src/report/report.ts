// Tiered, CI-greppable report. Plain text or --json. No TUI/panes.
// Exit: 0 clean / 1 drift. --fail-on selects which tiers count as failure.
//
// Default layout is deliberately terse (a 40-resource CLEAN stack was 30+ lines):
//   header -> DRIFT tier sections (full detail) -> result: -> info: footer
// No blank line before the header or the result: line (R37) — a CLEAN stack with
// one informational tier is exactly 3 lines. Blank lines remain BETWEEN the header
// and drift sections, and between sections (visual grouping). DRIFT tiers
// (deleted/declared/undeclared) are ALWAYS shown in full — they are the point.
// INFORMATIONAL tiers (readGap/unresolved/skipped) are folded into the `info:`
// footer (counts + reason breakdown): one line when a single tier is present, a
// one-line-per-tier bullet list when 2+ (R37); `--verbose` expands them to full
// sections (below result, as a footer). 0-count tiers are never printed. The
// "surfaced, never silently dropped" invariant is preserved by the counts.
import type { Finding, Tier } from '../types.js';
import { style } from './style.js';

const TIER_TITLES: Record<Tier, string> = {
  deleted: 'DELETED (resource deleted out of band — always drift)',
  declared: 'DECLARED DRIFT',
  undeclared: 'UNDECLARED DRIFT (the differentiator)',
  ignored: 'IGNORED (matched a .cdkrd/config.json ignore rule — not drift)',
  readGap: 'READ GAP (declared but not returned by live read — not drift)',
  unresolved: 'UNRESOLVED (declared paths needing GetAtt — skipped, not drift)',
  skipped: 'SKIPPED (CC API unsupported / no physical id)',
};
const DRIFT_TIERS: Tier[] = ['deleted', 'declared', 'undeclared'];
const INFO_TIERS: Tier[] = ['ignored', 'readGap', 'unresolved', 'skipped'];

export type FailOn = 'declared' | 'undeclared';
export interface ReportOptions {
  json?: boolean;
  failOn?: FailOn; // default 'undeclared' (declared + undeclared both fail)
  verbose?: boolean; // expand informational tiers (readGap/unresolved/skipped) to full lists
  log?: (s: string) => void;
}

export function formatFinding(f: Finding): string {
  // prefer the CDK construct path for the human-facing id; fall back to logical id
  // (the id stays uncolored — it gets copy-pasted; only the values are styled,
  // and style.* is the identity when stdout is not a TTY, so piped output and
  // unit-test assertions see plain text)
  const id = f.constructPath ?? f.logicalId;
  let s = `${f.path ? `${id}.${f.path}` : id} (${f.resourceType})`;
  if (f.note) s += ` — ${f.note}`;
  if (f.tier === 'declared')
    s += `\n      desired=${style.desired(j(f.desired))}\n      actual =${style.actual(j(f.actual))}`;
  else if (f.tier === 'undeclared') s += ` = ${style.actual(j(f.actual))}`;
  return s;
}

// section-title color by tier: deleted/declared = red (drift), undeclared =
// yellow (the differentiator), informational tiers = dim.
function tierStyle(t: Tier): (s: string) => string {
  if (t === 'undeclared') return style.undeclaredTier;
  if (t === 'deleted' || t === 'declared') return style.driftTier;
  return style.infoTier;
}

// `deleted` is ALWAYS a failure (the most blatant drift), independent of --fail-on.
function failTiers(failOn: FailOn): Tier[] {
  return failOn === 'declared' ? ['deleted', 'declared'] : ['deleted', 'declared', 'undeclared'];
}

// The exit code for a set of findings WITHOUT printing — used to re-evaluate a stack
// after an interactive accept (R28) blessed some/all of its undeclared drift.
export function exitCode(findings: Finding[], failOn: FailOn = 'undeclared'): number {
  const fail = failTiers(failOn);
  return findings.some((f) => fail.includes(f.tier)) ? 1 : 0;
}

// A short, human label for WHY an informational finding is not actionable drift, so
// the `info:` summary can break a tier's count down by cause.
function reasonKey(f: Finding): string {
  const n = f.note ?? '';
  if (f.tier === 'ignored') return n.replace(/^ignored by config rule /, '') || 'ignored';
  if (f.tier === 'unresolved') return 'GetAtt unresolved';
  if (n.includes('write-only')) return 'write-only';
  if (n.startsWith('custom resource')) return 'custom resource';
  if (n.includes('target not resolvable')) return 'override target unresolved';
  if (n.startsWith('CC API: ')) return `CC ${n.slice('CC API: '.length)}`;
  if (n === 'no physical id') return 'no physical id';
  return n || 'other';
}

function groupReasons(items: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of items) {
    const k = reasonKey(f);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, c]) => `${k} ${c}`)
    .join(', ');
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
  const section = (tier: Tier): void => {
    const items = byTier(tier);
    if (items.length === 0) return; // 0-count tiers are never printed
    log('\n' + tierStyle(tier)(`[${TIER_TITLES[tier]}] ${items.length}`));
    for (const f of items) log('  ' + formatFinding(f));
  };

  log(style.header(`=== cdkrd check: ${header} ===`));
  // DRIFT tiers: always full detail (the point of the tool)
  for (const tier of DRIFT_TIERS) section(tier);
  // result: line — the conclusion. Lists ONLY the non-zero DRIFT tier counts (the
  // informational breakdown lives on the `info:` line, so the two never duplicate);
  // CLEAN prints just `CLEAN`. `fail-on` is noted only when non-default (it changes
  // the verdict). `^result:` stays greppable for the verdict; the formal
  // machine-readable contract is `--json` (the info: footer may span lines).
  const driftCounts = DRIFT_TIERS.filter((t) => byTier(t).length > 0)
    .map((t) => `${t}=${byTier(t).length}`)
    .join(' ');
  const failNote = (opts.failOn ?? 'undeclared') === 'declared' ? ' (fail-on=declared)' : '';
  // the verdict is the one line that must stand out: green CLEAN / red drift count
  const verdict =
    drifted === 0 ? style.clean('CLEAN') : `${style.drift(`${drifted} drift(s)`)} (${driftCounts})`;
  log(`result: ${verdict}${failNote}`);
  // INFORMATIONAL tiers: footer below result — full sections under --verbose, else a
  // folded summary (counts + reason breakdown): one `info: ...` line for a single
  // tier, a one-line-per-tier bullet list (with ONE --verbose hint) for 2+ (R37).
  if (opts.verbose) {
    for (const tier of INFO_TIERS) section(tier);
  } else {
    const summaries = INFO_TIERS.map((t) => {
      const items = byTier(t);
      return items.length ? `${t}=${items.length} (${groupReasons(items)})` : null;
    }).filter((s): s is string => s !== null);
    if (summaries.length === 1) {
      log(style.infoTier(`info: ${summaries[0]} — run with --verbose for the list`));
    } else if (summaries.length > 1) {
      log(style.infoTier('info:'));
      for (const s of summaries) log(style.infoTier(`  - ${s}`));
      log(style.infoTier('  run with --verbose for the list'));
    }
  }
  return drifted === 0 ? 0 : 1;
}

// R37: multi-stack runs print ONE blank line between consecutive stack reports —
// never before the first (so a single-stack run has no stray leading blank). Lives
// at the check-loop call site, not inside report(); exported pure for unit tests.
export function stackSeparator(log: (s: string) => void = console.log): () => void {
  let first = true;
  return () => {
    if (first) first = false;
    else log('');
  };
}
function j(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 200 ? s.slice(0, 200) + '…' : s;
}
