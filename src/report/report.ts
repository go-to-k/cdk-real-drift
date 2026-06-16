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
import type { ArrayDelta, Finding, Tier } from '../types.js';
import { style } from './style.js';

// Section headers are Title Case (not all-caps) — uniform and readable, and crucially
// so `CFn-Declared Drift` vs `CFn-Undeclared Drift`, which share the `CFn-` prefix, the
// ` Drift` suffix, and the same red colour, read as distinct WORDS at a glance instead
// of two near-identical all-caps tokens (R130 dogfood). `CFn` / `AWS` stay as the
// acronyms they are. The not-in-baseline section is `[Not Recorded]` (literal below),
// which ties directly to the `cdkrd record` verb.
const TIER_NAMES: Record<Tier, string> = {
  deleted: 'Deleted',
  added: 'Added Resource',
  declared: 'CFn-Declared Drift',
  undeclared: 'CFn-Undeclared Drift',
  atDefault: 'At AWS Default',
  generated: 'AWS Generated',
  ignored: 'Ignored',
  readGap: 'Read Gap',
  unresolved: 'Unresolved',
  skipped: 'Skipped',
};
// Explanation printed after the bracketed name+count, outside the brackets.
// The notes anchor the THREE sources cdkrd touches, so "declared" is never misread as
// "in my CDK code" or "in the .cdkrd baseline": (1) the DEPLOYED CloudFormation template
// (declared/undeclared), (2) the live resource (undeclared = live-only), (3) the .cdkrd
// baseline file (recorded/unrecorded — a separate axis).
const TIER_NOTES: Partial<Record<Tier, string>> = {
  deleted: 'resource deleted out of band — always drift',
  added:
    'a WHOLE live resource not in your CloudFormation template (the resource-level counterpart of CFn-Undeclared) — created out of band under a declared parent, changed from your .cdkrd baseline (an unrecorded one is Not Recorded, not drift)',
  declared: 'declared in your CloudFormation template — the live value differs',
  undeclared:
    'live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator',
  atDefault: 'undeclared, but the live value matches a known AWS default — not drift',
  generated: 'auto-generated identifier not in your template (AWS-assigned at deploy) — not drift',
  ignored: 'matched a .cdkrd/config.json ignore rule — not drift',
  readGap: "declared, but AWS doesn't return it on read so cdkrd can't verify it — not drift",
  unresolved: 'declared paths needing GetAtt — skipped, not drift',
  skipped:
    'NOT checked (coverage incomplete) — CC API unsupported / no physical id / custom resource',
};
// Section + result-line order (both iterate this). `added` (whole out-of-band
// resources) sorts AFTER the property tiers — declared/undeclared are the per-property
// differentiator the report leads with, and the resource-level `added` follows them.
// `deleted` stays first (the most blatant drift).
const DRIFT_TIERS: Tier[] = ['deleted', 'declared', 'undeclared', 'added'];
// atDefault leads the informational footer: it is the bulk of a first run (undeclared
// values sitting at their AWS default) and folding it is the whole point of R86 — the
// report states the complete undeclared count but lists only the values that actually
// diverge, with the at-default remainder collapsed to a count (expanded by --verbose
// or --show-all).
const INFO_TIERS: Tier[] = [
  'atDefault',
  'generated',
  'ignored',
  'readGap',
  'unresolved',
  'skipped',
];

export interface ReportOptions {
  json?: boolean;
  verbose?: boolean; // expand informational tiers (readGap/unresolved/skipped) to full lists
  expandAtDefault?: boolean; // expand ONLY the atDefault tier to a full list (--show-all inventory mode)
  log?: (s: string) => void;
}
// Unrecorded values (R60, per finding since R62): an undeclared finding tagged
// `unrecorded` by applyBaseline (no baseline entry, resource never
// snapshot-complete) is an inventory awaiting a decision, not drift — the
// baseline entry is the contract that defines undeclared drift, and with no
// entry there is nothing to violate. They render as their own [UNRECORDED: N]
// section, are excluded from the drift verdict/exit, and the result line points
// at `cdkrd record`.

export function formatFinding(f: Finding): string {
  // prefer the CDK construct path for the human-facing id; fall back to logical id
  // (the id stays uncolored — it gets copy-pasted; only the values are styled,
  // and style.* is the identity when stdout is not a TTY, so piped output and
  // unit-test assertions see plain text)
  const id = f.constructPath ?? f.logicalId;
  // R78: an ELB attribute-bag drift names the changed attribute by Key
  // (LoadBalancerAttributes[idle_timeout.timeout_seconds]) rather than a bare
  // array index, so the report points at the exact setting.
  const pathDisplay = f.attributeKey ? `${f.path}[${f.attributeKey}]` : f.path;
  let s = `${pathDisplay ? `${id}.${pathDisplay}` : id} (${f.resourceType})`;
  if (f.note) s += ` — ${f.note}`;
  if (f.tier === 'declared') {
    const { a: d, b: act } = jPair(f.desired, f.actual);
    s += `\n      desired=${style.desired(d)}\n      actual =${style.actual(act)}`;
  } else if (f.tier === 'added' && f.desired !== undefined) {
    // PR4: a recorded `added` resource whose live model CHANGED since record — show the
    // recorded baseline model vs the live one (pair-truncated to the divergence) so the
    // user sees WHAT changed, mirroring the declared tier's desired/actual layout. A
    // first-seen / unrecorded added resource has no `desired`, so it stays a one-liner.
    const { a: base, b: act } = jPair(f.desired, f.actual);
    s += `\n      baseline=${style.desired(base)}\n      actual  =${style.actual(act)}`;
  } else if (f.tier === 'undeclared' && f.arrayDelta)
    // R128: a recorded identity-keyed array changed — show the element delta, not the
    // whole array dump (the property stays recorded; this is the WHICH-element view).
    s += formatArrayDelta(f.arrayDelta);
  else if (f.tier === 'undeclared' || f.tier === 'atDefault' || f.tier === 'generated')
    s += ` = ${style.actual(j(f.actual))}`;
  return s;
}

// R128/R130: render an identity-keyed array delta as one block per changed element
// (added / changed / removed), keyed by its identity value — far more legible than a
// whole-array dump when only one element of many differs. The element id sits on its
// own marker line (+ added / ~ changed / - removed); the baseline / actual value(s)
// follow on their own indented lines (mirrors the declared tier's desired/actual
// layout — `baseline`/`actual` are padded so the `=` aligns), so two long policy
// documents are read top-to-bottom instead of wrapping on one line (R130).
function formatArrayDelta(d: ArrayDelta): string {
  // 8 = len('baseline'); pad 'actual' to match so the '=' column lines up.
  const baseline = (v: unknown): string => `\n          baseline=${style.desired(j(v))}`;
  const actual = (v: unknown): string => `\n          actual  =${style.actual(j(v))}`;
  let s = ` — ${d.identityField}-keyed element(s) changed vs .cdkrd baseline:`;
  for (const a of d.added) s += `\n      + [${a.id}]${actual(a.value)}`;
  for (const c of d.changed) {
    // pair-aware truncation so a long recorded-vs-live element shows WHERE it diverges
    const { a: base, b: act } = jPair(c.recorded, c.actual);
    s += `\n      ~ [${c.id}]\n          baseline=${style.desired(base)}\n          actual  =${style.actual(act)}`;
  }
  for (const r of d.removed) s += `\n      - [${r.id}]${baseline(r.value)}`;
  return s;
}

// section-title color by tier: deleted/declared = red (drift), undeclared =
// yellow (the differentiator), informational tiers = dim.
function tierStyle(t: Tier): (s: string) => string {
  // All three DRIFT tiers are RED — they are drift (exit-affecting). undeclared was
  // previously yellow (undeclaredTier), which collided with the [UNRECORDED] section
  // (also yellow) and made a real undeclared DRIFT look identical to a not-drift
  // unrecorded value. Yellow (undeclaredTier) is now reserved for UNRECORDED / "to
  // review" — so colour alone separates drift (red) from to-review (yellow). R125.
  if (t === 'deleted' || t === 'added' || t === 'declared' || t === 'undeclared')
    return style.driftTier;
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
  // R96: a NESTED unrecorded value (a live sub-key inside a DECLARED object the
  // template never set) folds by default — the live model carries many nested AWS
  // defaults, so listing them all would re-flood the first run R86 worked to quiet.
  // Top-level unrecorded values still list in full in [UNRECORDED]; the nested ones
  // collapse to one `info:` count, expanded by --verbose or --show-all. Either way
  // record records them, so a later out-of-band change to one surfaces as drift.
  const expandNested = !!opts.verbose || !!opts.expandAtDefault;
  const unrecordedShown = expandNested ? unrecordedItems : unrecordedItems.filter((f) => !f.nested);
  const nestedFolded = expandNested ? [] : unrecordedItems.filter((f) => f.nested === true);
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
      unrecordedShown,
      'Not Recorded',
      'not drift — a live-only value not yet in your .cdkrd baseline; run cdkrd record to track it',
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
  const unrecordedFoldedCount = unrecordedItems.length - unrecordedShown.length;
  // R114: when DRIFT and standout UNRECORDED values are BOTH visible, a lone
  // "1 drift(s)" verdict reads as a mismatch against the 2+ printed blocks (the user
  // sees [DECLARED DRIFT: 1] + [UNRECORDED: 2] but a single "1 drift"). Combine them
  // under one findings count — `N findings — X drift (...) + Y undeclared to review` —
  // keeping the red drift verdict and its breakdown so exit-1 stays legible, and
  // counting only what is SHOWN (folded values are not findings, just a parenthetical).
  // The combined framing fires ONLY in this mixed case; single-category runs keep their
  // natural verdict (CLEAN / N drift / inventory note) — the mismatch can't arise there.
  const mixed = drifted > 0 && unrecordedShown.length > 0;
  let resultBody: string;
  if (mixed) {
    const foldedHint =
      unrecordedFoldedCount > 0
        ? `${unrecordedFoldedCount} folded; run cdkrd record`
        : 'run cdkrd record';
    resultBody =
      `${drifted + unrecordedShown.length} findings — ${style.drift(`${drifted} drift`)} (${driftCounts})` +
      ` + ${style.undeclaredTier(`${unrecordedShown.length} undeclared to review`)}` +
      style.infoTier(` (${foldedHint})`);
  } else {
    // the verdict is the one line that must stand out: green CLEAN / red drift count
    const verdict =
      drifted === 0
        ? style.clean('CLEAN')
        : `${style.drift(`${drifted} drift(s)`)} (${driftCounts})`;
    // unrecorded values are stated NEXT TO the verdict (not as drift): the count
    // and the way out, in one place (R60). The total counts ALL unrecorded values
    // but the [UNRECORDED] section lists only the standout (non-folded) ones, so name
    // the split (R112) — otherwise "25 await a baseline" reads as a mismatch against a
    // visible "[UNRECORDED: 2]".
    const unrecordedNote =
      unrecordedItems.length > 0
        ? style.infoTier(
            unrecordedFoldedCount > 0
              ? ` — ${unrecordedItems.length} unrecorded value(s) await a baseline (${unrecordedShown.length} shown, ${unrecordedFoldedCount} folded; run cdkrd record)`
              : ` — ${unrecordedItems.length} unrecorded value(s) await a baseline (run cdkrd record)`
          )
        : '';
    resultBody = `${verdict}${unrecordedNote}`;
  }
  // A blank line before the verdict ONLY when drift sections were printed — it must
  // not read as a member of the last section (R48); a CLEAN stack stays 3 lines.
  log((driftSections > 0 ? '\n' : '') + `result: ${resultBody}`);
  // INFORMATIONAL tiers: footer below result. Each tier is either EXPANDED to a full
  // section or FOLDED into the `info:` summary. --verbose expands all of them;
  // --show-all expands ONLY atDefault (inventory mode lists every undeclared value but
  // keeps the read-gap/skip breakdown terse). A tier's count is always stated, so the
  // "surfaced, never silently dropped" invariant holds whichever way it renders.
  const isExpanded = (t: Tier): boolean =>
    !!opts.verbose || (t === 'atDefault' && !!opts.expandAtDefault);
  for (const tier of INFO_TIERS) if (isExpanded(tier)) tierSection(tier, true);
  const summaryFor = (t: Tier, items: Finding[]): string => {
    // atDefault / generated each have a single cause, so the generic reason-breakdown
    // would just echo the count — give them a plain-English label instead.
    if (t === 'atDefault')
      return `atDefault=${items.length} (undeclared values matching a known AWS default — not drift)`;
    if (t === 'generated')
      return `generated=${items.length} (auto-generated identifiers not in your template, AWS-assigned at deploy — not drift)`;
    // readGap is jargon ("not returned by live read"): spell out that these are declared
    // values cdkrd could not VERIFY because AWS does not return them on read, and split
    // the cause (write-only props are never readable by design vs simply not returned).
    if (t === 'readGap') {
      const writeOnly = items.filter((f) => (f.note ?? '').includes('write-only')).length;
      const notReturned = items.length - writeOnly;
      const parts = [
        ...(notReturned > 0 ? [`${notReturned} not returned by AWS`] : []),
        ...(writeOnly > 0 ? [`${writeOnly} write-only`] : []),
      ];
      return `readGap=${items.length} (declared but unverifiable — AWS doesn't return them on read, not drift: ${parts.join(', ')})`;
    }
    // skipped = resources cdkrd genuinely could NOT read this run (CC-unsupported with
    // no SDK override, read error, missing physical id, custom resource). It is the one
    // info: tier that is a COVERAGE GAP, not a not-drift classification — so it carries
    // the "NOT checked / coverage incomplete" framing here (R28-era loud coverage warning,
    // folded into the footer in R127 so the drift result stays the first thing on screen).
    if (t === 'skipped')
      return `skipped=${items.length} — NOT checked (coverage incomplete: ${groupReasons(items)})`;
    return `${t}=${items.length} (${groupReasons(items)})`;
  };
  const summaries = INFO_TIERS.filter((t) => !isExpanded(t))
    .map((t) => {
      const items = byTier(t);
      return items.length ? summaryFor(t, items) : null;
    })
    .filter((s): s is string => s !== null);
  // R96: the folded nested-unrecorded count joins the info: footer (--show-all lists them).
  if (nestedFolded.length > 0)
    summaries.push(
      `nested=${nestedFolded.length} (undeclared values nested in a declared object — record to record; --show-all to list)`
    );
  if (summaries.length === 1) {
    log(style.infoTier(`info: ${summaries[0]} — run with --verbose for the list`));
  } else if (summaries.length > 1) {
    log(style.infoTier('info:'));
    for (const s of summaries) log(style.infoTier(`  - ${s}`));
    log(style.infoTier('  run with --verbose for the list'));
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
const VALUE_CAP = 200;
function j(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > VALUE_CAP ? s.slice(0, VALUE_CAP) + '…' : (s ?? String(v));
}

// Truncate a desired/actual (or baseline/actual) PAIR so the FIRST point at which the
// two diverge is visible even when both exceed the cap — one shared window centered on
// the divergence, applied to both. Independently slicing each at a fixed 200-char prefix
// (the old behavior) made two long values that differ only PAST the cap render as
// identical blobs, hiding the very change the report exists to show (common for long
// inline-policy / bucket-policy documents). Pure + exported for tests.
export function jPair(a: unknown, b: unknown): { a: string; b: string } {
  const as = JSON.stringify(a) ?? String(a);
  const bs = JSON.stringify(b) ?? String(b);
  if (as.length <= VALUE_CAP && bs.length <= VALUE_CAP) return { a: as, b: bs };
  let i = 0;
  const min = Math.min(as.length, bs.length);
  while (i < min && as[i] === bs[i]) i++; // first index at which they differ
  const CONTEXT = 40; // chars of shared lead-in kept before the divergence, for orientation
  const start = Math.max(0, i - CONTEXT);
  const window = (s: string): string => {
    let out = s.slice(start, start + VALUE_CAP);
    if (start > 0) out = `…${out}`;
    if (start + VALUE_CAP < s.length) out = `${out}…`;
    return out;
  };
  return { a: window(as), b: window(bs) };
}
