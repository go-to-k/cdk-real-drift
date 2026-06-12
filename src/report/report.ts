// Tiered, CI-greppable report. Plain text or --json. No TUI/panes.
// Exit: report() returns 0 clean / 1 drift; check maps 1→0 unless --fail (R53).
//
// Default layout is deliberately terse (a 40-resource CLEAN stack was 30+ lines):
//   header -> DRIFT tier sections (full detail) -> result: -> info: footer
// Spacing (R37, revised by R48): no blank line before the header; the FIRST drift
// section follows the header directly (no stray blank); subsequent sections get a
// blank line between them (grouping); `result:` gets a blank line before it ONLY
// when at least one drift section was printed — so the verdict never reads as a
// member of the section above it, while a CLEAN stack with one informational tier
// stays exactly 3 lines. Section headers carry the count INSIDE the brackets
// (`[DECLARED DRIFT: 3]`) — a bare digit to the right of `]` read as noise (R48);
// the explanatory note follows outside the brackets. DRIFT tiers
// (deleted/declared/undeclared) are ALWAYS shown in full — they are the point.
// INFORMATIONAL tiers (readGap/unresolved/skipped) are folded into the `info:`
// footer (counts + reason breakdown): one line when a single tier is present, a
// one-line-per-tier bullet list when 2+ (R37); `--verbose` expands them to full
// sections (below result, as a footer). 0-count tiers are never printed. The
// "surfaced, never silently dropped" invariant is preserved by the counts.
import type { Finding, Tier } from '../types.js';
import { style } from './style.js';

const TIER_NAMES: Record<Tier, string> = {
  deleted: 'DELETED',
  declared: 'DECLARED DRIFT',
  undeclared: 'UNDECLARED DRIFT',
  ignored: 'IGNORED',
  readGap: 'READ GAP',
  unresolved: 'UNRESOLVED',
  skipped: 'SKIPPED',
};
// Explanation printed after the bracketed name+count, outside the brackets.
const TIER_NOTES: Partial<Record<Tier, string>> = {
  deleted: 'resource deleted out of band — always drift',
  undeclared: 'not declared in your template — the differentiator',
  ignored: 'matched a .cdkrd/config.json ignore rule — not drift',
  readGap: 'declared but not returned by live read — not drift',
  unresolved: 'declared paths needing GetAtt — skipped, not drift',
  skipped: 'CC API unsupported / no physical id',
};
const DRIFT_TIERS: Tier[] = ['deleted', 'declared', 'undeclared'];
const INFO_TIERS: Tier[] = ['ignored', 'readGap', 'unresolved', 'skipped'];

export interface ReportOptions {
  json?: boolean;
  verbose?: boolean; // expand informational tiers (readGap/unresolved/skipped) to full lists
  log?: (s: string) => void;
}
// Unrecorded values (R60, per finding since R62): an undeclared finding tagged
// `unrecorded` by applyBaseline (no baseline entry, resource never
// snapshot-complete) is an inventory awaiting a decision, not drift — the
// baseline entry is the contract that defines undeclared drift, and with no
// entry there is nothing to violate. They render as their own [UNRECORDED: N]
// section, are excluded from the drift verdict/exit, and the result line points
// at `cdkrd accept`.

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
  // unrecorded findings (R60/R62): an inventory awaiting a baseline decision,
  // not drift — they never count toward the verdict or the exit.
  const isDriftHere = (f: Finding): boolean => DRIFT_TIERS.includes(f.tier) && !f.unrecorded;
  const drifted = findings.filter(isDriftHere).length;

  if (opts.json) {
    log(JSON.stringify({ stack: header, drifted, findings }, null, 2));
    return drifted === 0 ? 0 : 1;
  }

  const byTier = (t: Tier) => findings.filter((f) => f.tier === t && !f.unrecorded);
  const unrecordedItems = findings.filter((f) => f.unrecorded === true);
  // Count inside the brackets (`[NAME: N]`), explanation outside (dim) — see the
  // layout comment at the top (R48). `leadingBlank` separates a section from
  // whatever precedes it; the FIRST drift section sits directly under the header.
  const section = (
    items: Finding[],
    name: string,
    note: string | undefined,
    color: (s: string) => string,
    leadingBlank: boolean
  ): boolean => {
    if (items.length === 0) return false; // 0-count tiers are never printed
    log(
      (leadingBlank ? '\n' : '') +
        color(`[${name}: ${items.length}]`) +
        (note ? ' ' + style.infoTier(`(${note})`) : '')
    );
    for (const f of items) log('  ' + formatFinding(f));
    return true;
  };
  const tierSection = (tier: Tier, leadingBlank: boolean): boolean =>
    section(byTier(tier), TIER_NAMES[tier], TIER_NOTES[tier], tierStyle(tier), leadingBlank);

  log(style.header(`=== cdkrd check: ${header} ===`));
  // DRIFT tiers: always full detail (the point of the tool)
  let driftSections = 0;
  for (const tier of DRIFT_TIERS) {
    if (tierSection(tier, driftSections > 0)) driftSections++;
  }
  // UNRECORDED: full detail like a drift section (these values await a decision —
  // hiding them would defeat the differentiator), but kept OUT of the verdict.
  if (
    section(
      unrecordedItems,
      'UNRECORDED',
      'not declared in your template; not in the baseline yet — accept to record',
      style.undeclaredTier,
      driftSections > 0
    )
  )
    driftSections++;
  // result: line — the conclusion. Lists ONLY the non-zero DRIFT tier counts (the
  // informational breakdown lives on the `info:` line, so the two never duplicate);
  // CLEAN prints just `CLEAN`. `^result:` stays greppable for the verdict; the formal
  // machine-readable contract is `--json` (the info: footer may span lines).
  const driftCounts = DRIFT_TIERS.filter((t) => byTier(t).length > 0)
    .map((t) => `${t}=${byTier(t).length}`)
    .join(' ');
  // the verdict is the one line that must stand out: green CLEAN / red drift count
  const verdict =
    drifted === 0 ? style.clean('CLEAN') : `${style.drift(`${drifted} drift(s)`)} (${driftCounts})`;
  // unrecorded values are stated NEXT TO the verdict (not as drift): the count
  // and the way out, in one place (R60).
  const unrecordedNote =
    unrecordedItems.length > 0
      ? style.infoTier(
          ` — ${unrecordedItems.length} unrecorded value(s) await a baseline (run cdkrd accept)`
        )
      : '';
  // A blank line before the verdict ONLY when drift sections were printed — it must
  // not read as a member of the last section (R48); a CLEAN stack stays 3 lines.
  log((driftSections > 0 ? '\n' : '') + `result: ${verdict}${unrecordedNote}`);
  // INFORMATIONAL tiers: footer below result — full sections under --verbose, else a
  // folded summary (counts + reason breakdown): one `info: ...` line for a single
  // tier, a one-line-per-tier bullet list (with ONE --verbose hint) for 2+ (R37).
  if (opts.verbose) {
    for (const tier of INFO_TIERS) tierSection(tier, true);
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
