// Tiered, CI-greppable report. Plain text or --json. No TUI/panes.
// Exit: report() returns 0 clean / 1 drift; check maps 1→0 unless --fail (R53).
//
// Default layout is deliberately terse (a 40-resource CLEAN stack was 30+ lines):
//   header -> DRIFT tier sections (full detail) -> result: -> info: footer
// Spacing (R37, revised by R48): no blank line before the header; the FIRST drift
// section follows the header directly (no stray blank); subsequent sections get a
// blank line between them (grouping); when at least one drift section was printed
// `result:` is FRAMED by a horizontal rule above and below (with a blank line before
// the frame) so the verdict stands out from the wall of findings — bold alone got lost;
// a CLEAN stack (no sections) skips the frame and stays exactly 3 lines. `result:` keeps
// column 0 for the `^result:` grep contract (the rules are their own lines). Section
// headers carry the count INSIDE the brackets
// (`[CFn-Declared Drift: 3]`) — a bare digit to the right of `]` read as noise (R48);
// the explanatory note follows outside the brackets. DRIFT tiers
// (deleted/declared/undeclared) are ALWAYS shown in full — they are the point.
// INFORMATIONAL tiers (readGap/unresolved/skipped) are folded into the `info:`
// footer (counts + reason breakdown): one line when a single tier is present, a
// one-line-per-tier bullet list when 2+ (R37); `--verbose` expands them to full
// sections (below result, as a footer). 0-count tiers are never printed. The
// "surfaced, never silently dropped" invariant is preserved by the counts.
import { withinStackPath } from '../construct-path.js';
import { deepEqual } from '../diff/drift-calculator.js';
import { annotateHints } from '../diff/hints.js';
import { UNRESOLVED } from '../normalize/intrinsic-resolver.js';
import type { ArrayDelta, Finding, Tier } from '../types.js';
import { style } from './style.js';

// The report header is `<stackName> (<region>)`; recover the bare stack name (used to
// strip the stack/Stage prefix off each finding's construct path). Only a TRAILING
// ` (...)` is removed, so a stack name that itself contains parens survives.
function stackNameFromHeader(header: string): string {
  return header.replace(/\s*\([^)]*\)\s*$/, '');
}

// Strip SGR color codes to measure a line's VISIBLE width (for the result-line rule).
// Built from the ESC char via fromCharCode so no control byte sits in a regex literal.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// Section headers are Title Case (not all-caps) — uniform and readable, and crucially
// so `CFn-Declared Drift` vs `CFn-Undeclared Drift`, which share the `CFn-` prefix, the
// ` Drift` suffix, and the same red colour, read as distinct WORDS at a glance instead
// of two near-identical all-caps tokens (R130 dogfood). `CFn` / `AWS` stay as the
// acronyms they are. The not-in-baseline section is `[Potential Drift]` (literal below):
// live-only values with no baseline yet, so cdkrd can't confirm them as drift or not —
// it ties directly to the `cdkrd record` verb (record resolves the ambiguity).
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
    'a WHOLE live resource not in your CloudFormation template (the resource-level counterpart of CFn-Undeclared) — created out of band under a declared parent, changed from your .cdkrd baseline (an unrecorded one is Potential Drift, not confirmed drift)',
  declared: 'declared in your CloudFormation template — the live value differs',
  undeclared:
    'live-only (not in your CloudFormation template), changed from your .cdkrd baseline — the differentiator',
  atDefault: 'undeclared, but the live value matches a known AWS default — not drift',
  generated: 'auto-generated identifier not in your template (AWS-assigned at deploy) — not drift',
  ignored: 'matched a .cdkrd/ignore.yaml ignore rule — not drift',
  readGap: "declared, but AWS doesn't return it on read so cdkrd can't verify it — not drift",
  unresolved:
    "declared, but its value references a CloudFormation intrinsic cdkrd couldn't resolve to a concrete value — e.g. Fn::GetAZs, a {{resolve:...}} dynamic reference, or an Fn::GetAtt whose target wasn't readable — so it can't be compared, not drift",
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
  // --pre-deploy: a `skipped: no physical id` finding is a not-yet-deployed LOCAL resource
  // (the declared source is the synth template), NOT a coverage gap — the next deploy will
  // create it. When set, the footer renders those pending-creation skips as their OWN
  // `pending creation` group instead of branding them "coverage incomplete", so the text
  // report agrees with check.ts's #727 stderr note (#883). Genuine gaps (CC-unsupported,
  // read errors) still render as "coverage incomplete".
  preDeploy?: boolean;
  log?: (s: string) => void;
}

// #883: a `skipped: no physical id` finding is a not-yet-deployed LOCAL resource under
// --pre-deploy (the same predicate check.ts's #727 fix uses). Kept local to the report so
// the footer can peel pending-creation skips out of the "coverage incomplete" bucket.
function isPendingCreationSkip(f: Finding): boolean {
  return f.tier === 'skipped' && f.note === 'no physical id';
}
// Unrecorded values (R60, per finding since R62): an undeclared finding tagged
// `unrecorded` by applyBaseline (no baseline entry, resource never
// snapshot-complete) is an inventory awaiting a decision, not drift — the
// baseline entry is the contract that defines undeclared drift, and with no
// entry there is nothing to violate. They render as their own [Potential Drift: N]
// section, are excluded from the drift verdict/exit, and the result line points
// at `cdkrd record`.

export function formatFinding(f: Finding, stackName = ''): string {
  // prefer the CDK construct path for the human-facing id; fall back to logical id
  // (the id stays uncolored — it gets copy-pasted; only the values are styled,
  // and style.* is the identity when stdout is not a TTY, so piped output and
  // unit-test assertions see plain text). The construct path is shown WITHIN its stack
  // (the stack/Stage prefix stripped — the header already names the stack), so a Stage's
  // `my-app/Rds/...` no longer sits beside the `my-app-Rds` header looking
  // like a different id. `stackName` defaults to '' (no strip) for direct unit calls; the
  // report passes the real name. The displayed id stays byte-identical to the ignore-rule
  // path token (both are `withinStackPath(...).<path>`), so what you see IS what an
  // ignore.yaml rule uses.
  const id = f.constructPath ? withinStackPath(f.constructPath, stackName) : f.logicalId;
  // R78: an ELB attribute-bag drift names the changed attribute by Key
  // (LoadBalancerAttributes[idle_timeout.timeout_seconds]) rather than a bare
  // array index, so the report points at the exact setting.
  const pathDisplay = f.attributeKey ? `${f.path}[${sanitizeForTerminal(f.attributeKey)}]` : f.path;
  let s = `${pathDisplay ? `${id}.${pathDisplay}` : id} (${f.resourceType})`;
  if (f.note) s += ` — ${sanitizeForTerminal(f.note)}`;
  if (f.tier === 'declared') {
    // A map-valued drift (both sides objects) is shown as a per-KEY delta, not a truncated
    // whole-object dump (see formatMapDelta) — the user's case: one ResponseParameters
    // header value changed but the raw pair-truncation windowed on the template-vs-live key
    // ORDER and hid it. A scalar drift keeps the plain desired/actual lines.
    if (isRecord(f.desired) && isRecord(f.actual)) s += formatMapDelta(f.desired, f.actual, false);
    else {
      const { a: d, b: act } = jPair(f.desired, f.actual);
      s += `\n      desired=${style.desired(d)}\n      actual =${style.actual(act)}`;
    }
  } else if (f.tier === 'added' && f.desired !== undefined) {
    // PR4: a recorded `added` resource whose live model CHANGED since record — show the
    // recorded baseline model vs the live one so the user sees WHAT changed. Both are full
    // models (objects), so the same per-key delta applies (baseline-vs-actual labels).
    if (isRecord(f.desired) && isRecord(f.actual)) s += formatMapDelta(f.desired, f.actual, true);
    else {
      const { a: base, b: act } = jPair(f.desired, f.actual);
      s += `\n      baseline=${style.desired(base)}\n      actual  =${style.actual(act)}`;
    }
  } else if (f.tier === 'added' && f.actual !== undefined) {
    // #1057: an UNRECORDED `added` resource (no baseline `desired`) — there is no delta to
    // show, so render its LIVE model (`f.actual`, the full out-of-band-created content) on
    // its own indented line, so the text report reveals WHAT the rogue resource is instead
    // of a bare id+type line (the live model was previously only visible under --json). The
    // `f.actual !== undefined` guard keeps a degraded read (identity-only, no model) rendering
    // as its bare id+type line rather than a stray `actual =undefined`.
    s += `\n      actual =${style.actual(j(f.actual))}`;
  } else if (f.tier === 'undeclared' && f.arrayDelta)
    // R128: a recorded identity-keyed array changed — show the element delta, not the
    // whole array dump (the property stays recorded; this is the WHICH-element view).
    s += formatArrayDelta(f.arrayDelta);
  else if (f.tier === 'undeclared' && f.desired !== undefined) {
    // #758 follow-up: a RECORDED undeclared value that CHANGED out of band since record —
    // applyBaseline (baseline-file.ts) threads the recorded baseline value onto `f.desired`
    // (mirroring the `added` tier). Show the recorded-vs-live delta so the user sees WHAT the
    // value changed FROM, not just the (possibly attacker-set) live value. Same `baseline`-vs-
    // `actual` wording as the recorded `added` tier: a per-key delta for maps (both objects),
    // stacked `baseline=`/`actual  =` lines for scalars.
    if (isRecord(f.desired) && isRecord(f.actual)) s += formatMapDelta(f.desired, f.actual, true);
    else {
      const { a: base, b: act } = jPair(f.desired, f.actual);
      s += `\n      baseline=${style.desired(base)}\n      actual  =${style.actual(act)}`;
    }
  } else if (f.tier === 'undeclared' || f.tier === 'atDefault' || f.tier === 'generated')
    // Put the live value on its OWN indented line, aligned with declared's `actual =`
    // column — a long ARN/JSON list crammed inline after the id was unreadable, and it read
    // inconsistently next to a declared drift's stacked desired/actual. An undeclared value
    // has only the live side, so it's a single `actual =` line (no desired to contrast).
    s += `\n      actual =${style.actual(j(f.actual))}`;
  // A non-classifying origin hint (diff/hints.ts) — the finding is still real drift; this
  // just names where the live value likely came from. Readable (style.note) trailing line
  // below the values — it is meant to be read, so NOT dim.
  if (f.hint) s += `\n      ${style.note(`↳ ${sanitizeForTerminal(f.hint)}`)}`;
  return s;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Render a CHANGED MAP as a per-key delta — only the keys that actually differ — instead of
// a truncated whole-object dump of both sides. A free-form map whose keys hold the path
// grammar's separators (`method.response.header.X`, a Docker label `com.example.x`, a tag
// key with a `.`) is emitted WHOLE by the drift calculator (the dotted key can't ride the
// finding path safely — drift-calculator `hasPathUnsafeKey`). So `desired`/`actual` are the
// full maps, and because the deployed template's key ORDER differs from the live read's, a
// raw `jPair` pair-truncation windows on the key-order divergence and HIDES the one value
// the user changed (e.g. an Access-Control-Allow-Origin header). Showing only the diverging
// keys pinpoints the change. Walks the UNION so a key present on one side only is shown too;
// a value change uses `jPair` so a long value still truncates around its divergence.
// `baselineLabels` swaps desired/actual wording for the `added` (baseline-vs-live) tier.
function formatMapDelta(
  desired: Record<string, unknown>,
  actual: Record<string, unknown>,
  baselineLabels: boolean
): string {
  const lhs = baselineLabels ? 'baseline' : 'desired';
  const rhs = baselineLabels ? 'actual  ' : 'actual ';
  const keys = [...new Set([...Object.keys(desired), ...Object.keys(actual)])].sort();
  let s = '';
  for (const k of keys) {
    const inD = Object.hasOwn(desired, k);
    const inA = Object.hasOwn(actual, k);
    if (inD && inA) {
      if (deepEqual(desired[k], actual[k])) continue;
      const { a, b } = jPair(desired[k], actual[k]);
      const sk = sanitizeForTerminal(k);
      s += `\n      ~ ${sk}\n          ${lhs}=${style.desired(a)}\n          ${rhs}=${style.actual(b)}`;
    } else if (inD) {
      s += `\n      - ${sanitizeForTerminal(k)} (in ${baselineLabels ? 'baseline' : 'template'}, absent in live)\n          ${lhs}=${style.desired(j(desired[k]))}`;
    } else {
      s += `\n      + ${sanitizeForTerminal(k)} (in live, not in ${baselineLabels ? 'baseline' : 'template'})\n          ${rhs}=${style.actual(j(actual[k]))}`;
    }
  }
  // A whole-object swap with NO per-key difference shouldn't happen (deepEqual gates the
  // finding), but fall back to the plain pair so a finding never renders value-less.
  if (s === '') {
    const { a, b } = jPair(desired, actual);
    s = `\n      ${lhs}=${style.desired(a)}\n      ${rhs}=${style.actual(b)}`;
  }
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
  let s = ` — ${sanitizeForTerminal(d.identityField)}-keyed element(s) changed vs .cdkrd baseline:`;
  for (const a of d.added) s += `\n      + [${sanitizeForTerminal(a.id)}]${actual(a.value)}`;
  for (const c of d.changed) {
    // pair-aware truncation so a long recorded-vs-live element shows WHERE it diverges
    const { a: base, b: act } = jPair(c.recorded, c.actual);
    s += `\n      ~ [${sanitizeForTerminal(c.id)}]\n          baseline=${style.desired(base)}\n          actual  =${style.actual(act)}`;
  }
  for (const r of d.removed) s += `\n      - [${sanitizeForTerminal(r.id)}]${baseline(r.value)}`;
  return s;
}

// section-title color by tier: deleted/declared = red (drift), undeclared =
// yellow (the differentiator), informational tiers = readable default (style.note,
// not dim — a --verbose info section is content to read).
function tierStyle(t: Tier): (s: string) => string {
  // All three DRIFT tiers are RED — they are drift (exit-affecting). undeclared was
  // previously yellow (undeclaredTier), which collided with the [Potential Drift] section
  // (also yellow) and made a real undeclared DRIFT look identical to a not-drift
  // unrecorded value. Yellow (undeclaredTier) is now reserved for UNRECORDED / "to
  // review" — so colour alone separates drift (red) from to-review (yellow). R125.
  if (t === 'deleted' || t === 'added' || t === 'declared' || t === 'undeclared')
    return style.driftTier;
  return style.note;
}

// A short, human label for WHY an informational finding is not actionable drift, so
// the `info:` summary can break a tier's count down by cause.
function reasonKey(f: Finding): string {
  const n = f.note ?? '';
  if (f.tier === 'ignored') return n.replace(/^ignored by config rule /, '') || 'ignored';
  if (f.tier === 'unresolved') return 'intrinsic unresolved';
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

// The `--json` payload for a SINGLE stack: `{ stack, drifted, findings }` plus the
// exit code the same findings map to. Pure + exported so the multi-stack check loop
// can COLLECT one object per stack and serialize a single top-level JSON ARRAY at the
// end (issue #755) — instead of each stack's report() printing its own pretty-printed
// object inline, which concatenated into `{...}\n{...}`: not a single parseable JSON
// value and not JSONL. The array is the machine contract for a whole invocation; a lone
// stack is simply an array of one (kept uniform so `JSON.parse` always yields an array —
// see README "JSON output contract"). `report()`'s own json path still logs the bare
// object so report-level unit tests / any single-report caller are unchanged; the ARRAY
// framing is owned by the check loop.
export interface StackJsonReport {
  stack: string;
  drifted: number;
  findings: Finding[];
  // Present ONLY on a stack that ERRORED before it could be checked — so a --json
  // consumer sees WHICH stacks ran and which failed, rather than a silent omission (the
  // pre-#755 behavior printed nothing for an errored stack). Never set on a
  // successfully-checked stack.
  error?: string;
  // Set ONLY on a stack whose committed baseline proves it was once deployed but which is
  // now GONE from CloudFormation (deleted out of band). This is the STRONGEST drift, not a
  // pre-check error, so it carries `drifted: 1` (never `error`): a consumer summing
  // `drifted` across stacks must see it. Absent on every other stack. (#871)
  stackDeleted?: boolean;
}

// The --json element for a stack DELETED out of band (#871): the STRONGEST drift, so
// `drifted: 1` + `stackDeleted: true` — never the `drifted: 0` + `error` shape (`error`
// is reserved for a stack that failed BEFORE it could be checked). A consumer summing
// `drifted` across stacks must see the deleted stack. Used by check.ts's not-deployed
// catch when a committed baseline proves the stack was once deployed.
export function deletedStackReport(label: string): StackJsonReport {
  return { stack: label, drifted: 1, findings: [], stackDeleted: true };
}

export function buildStackJson(
  rawFindings: Finding[],
  header: string
): { json: StackJsonReport; code: number } {
  // Annotate origin hints (diff/hints.ts) so the --json payload carries them exactly as
  // the text path does — the single render chokepoint. A hint is display-only.
  const findings = annotateHints(rawFindings);
  // unrecorded findings (R60/R62): inventory awaiting a baseline decision, not drift —
  // never counted toward the verdict/exit.
  const isDriftHere = (f: Finding): boolean => DRIFT_TIERS.includes(f.tier) && !f.unrecorded;
  const drifted = findings.filter(isDriftHere).length;
  return { json: { stack: header, drifted, findings }, code: drifted === 0 ? 0 : 1 };
}

export function report(rawFindings: Finding[], header: string, opts: ReportOptions = {}): number {
  const log = opts.log ?? console.log;
  const stackName = stackNameFromHeader(header);
  // Annotate origin hints (diff/hints.ts) here, at the single render chokepoint, so the
  // text report, the --json payload, and the --pre-deploy report all carry them. A hint is
  // display-only — it never changes a tier — so the `drifted` verdict below is unaffected.
  const findings = annotateHints(rawFindings);
  // unrecorded findings (R60/R62): an inventory awaiting a baseline decision,
  // not drift — they never count toward the verdict or the exit.
  const isDriftHere = (f: Finding): boolean => DRIFT_TIERS.includes(f.tier) && !f.unrecorded;
  const drifted = findings.filter(isDriftHere).length;

  if (opts.json) {
    // Single-report json (direct callers / unit tests): the bare object. The multi-stack
    // check loop does NOT route through here for --json — it collects buildStackJson()
    // objects and prints one top-level array (issue #755).
    log(JSON.stringify(buildStackJson(rawFindings, header).json, null, 2));
    return drifted === 0 ? 0 : 1;
  }

  const byTier = (t: Tier) => findings.filter((f) => f.tier === t && !f.unrecorded);
  const unrecordedItems = findings.filter((f) => f.unrecorded === true);
  // SURFACE every nested undeclared value (a live sub-key inside a DECLARED object the
  // template never set) in [Potential Drift], like a top-level one. R96 originally FOLDED
  // them behind a count + --show-all because the live model materializes many nested AWS
  // defaults. But those catalogued defaults are already removed UPSTREAM (atDefault /
  // generated / KNOWN_DEFAULT_PATHS / schema defaults), so what still reaches the report as
  // tier:undeclared nested is a NON-default value the user most likely set out of band —
  // e.g. an ApiGateway Method Integration.PassthroughBehavior=NEVER or an
  // IntegrationResponses[x].SelectionPattern. That undeclared-property dimension IS cdkrd's
  // differentiator, so hiding it defeated the point. An uncatalogued AWS-populated nested
  // value that slips through is quieted by EXTENDING KNOWN_DEFAULT_PATHS (the same catalogue
  // model as top-level), never by hiding the whole class. `nestedFolded` stays (empty) so the
  // folded-count machinery below is a no-op rather than a special case.
  const unrecordedShown = unrecordedItems;
  const nestedFolded: Finding[] = [];
  // Count inside the brackets (`[NAME: N]`), explanation outside (readable — style.note,
  // not dim: it is meant to be read) — see the
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
        (note ? ' ' + style.note(`(${note})`) : '')
    );
    for (const f of items) log('  ' + formatFinding(f, stackName));
    return true;
  };
  const tierSection = (tier: Tier, leadingBlank: boolean): boolean =>
    section(byTier(tier), TIER_NAMES[tier], TIER_NOTES[tier], tierStyle(tier), leadingBlank);

  log(style.header(`=== check: ${header} ===`));
  // When STANDOUT live-only values have no baseline yet, say so up front: with nothing
  // to compare against, cdkrd genuinely CANNOT tell whether they are intentional or an
  // out-of-band change — that ambiguity (not "all clear") is why they are POTENTIAL
  // drift. Gated on the SHOWN count: nested undeclared values now surface too (R96 fold
  // removed), and they are exactly the live-only sub-keys this preamble describes.
  if (unrecordedShown.length > 0) {
    log(
      style.undeclaredTier(
        "No baseline yet — these live-only values can't be confirmed as drift. Record them right from this `cdkrd check` prompt, or run `cdkrd record`."
      )
    );
    log(''); // blank line so the no-baseline note reads as its own preamble, not a section header
  }
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
      'Potential Drift',
      "live-only and not yet in your .cdkrd baseline, so cdkrd can't tell whether it's intended or an out-of-band change — Record to accept it, or Revert to remove it",
      style.undeclaredTier,
      driftSections > 0
    )
  ) {
    driftSections++;
    // Potential drift is UNCONFIRMED by definition (no baseline), so it is the one tier
    // where a value can be a false positive — an AWS-managed default or noise that slipped
    // the fold tables. Point the user at the issue tracker so those become fold-table fixes.
    // Scoped to THIS tier only (a `↳` note like the origin hint): declared / deleted drift
    // is confirmed against the template, never guessed, so it carries no such caveat.
    log(
      style.note(
        '  ↳ this tier is a best-effort guess and can include false positives — if a value here is really an AWS-managed default or noise, please report it: https://github.com/go-to-k/cdk-real-drift/issues'
      )
    );
  }
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
  // sees [CFn-Declared Drift: 1] + [Potential Drift: 2] but a single "1 drift"). Combine them
  // under one findings count — `N findings — X drift (...) + Y potential drift` —
  // keeping the red drift verdict and its breakdown so exit-1 stays legible, and
  // counting only what is SHOWN (folded values are not findings, just a parenthetical).
  // The combined framing fires ONLY in this mixed case; single-category runs keep their
  // natural verdict (CLEAN / N drift / inventory note) — the mismatch can't arise there.
  // "potential drift" counts the SHOWN live-only values — which now include nested
  // undeclared sub-keys (R96's fold was removed: catalogued AWS defaults are stripped
  // upstream, so a surviving nested undeclared value is a real out-of-band setting worth
  // surfacing). `folded` is therefore 0 in practice; the `(+ N nested live-only to record)`
  // tail and the folded branches below stay only so a future re-fold needs no rewiring.
  const shown = unrecordedShown.length;
  const folded = unrecordedFoldedCount;
  const nestedTail = folded > 0 ? ` (+ ${folded} nested live-only to record)` : '';
  const mixed = drifted > 0 && shown > 0;
  let resultBody: string;
  if (mixed) {
    // R114: DRIFT + standout potential both visible -> one combined findings count so the
    // verdict matches the printed blocks (was a lone "1 drift(s)" beside 2 sections).
    resultBody =
      `${drifted + shown} findings — ${style.drift(`${drifted} drift`)} (${driftCounts})` +
      ` + ${style.undeclaredTier(`${shown} potential drift`)}` +
      style.note(nestedTail);
  } else {
    // the verdict is the one line that must stand out: green CLEAN / red drift count.
    // "CLEAN" is reserved for a truly clean stack (nothing unrecorded). With only FOLDED
    // nested live-only values it is "no confirmed drift" + a neutral "to record" count
    // (NOT potential drift). With SHOWN standout values it is "no confirmed drift · N
    // potential drift" — those are what cdkrd genuinely cannot yet judge.
    const verdict =
      drifted > 0
        ? `${style.drift(`${drifted} drift(s)`)} (${driftCounts})`
        : shown > 0 || folded > 0
          ? 'no confirmed drift'
          : style.clean('CLEAN');
    const unrecordedNote =
      shown > 0
        ? style.undeclaredTier(` · ${shown} potential drift`) + style.note(nestedTail)
        : folded > 0
          ? style.note(` · ${folded} live-only value(s) to record as baseline (run cdkrd record)`)
          : '';
    resultBody = `${verdict}${unrecordedNote}`;
  }
  // The verdict is the one line that must stand out. Bold alone got lost under a wall of
  // findings, so when drift sections were printed the verdict is FRAMED with a horizontal
  // rule above and below (and a blank line separating it from the section above — R48). A
  // leading glyph was rejected: `result:` must stay at column 0 for the `^result:` CI/integ
  // grep contract, and the rules are their own lines so grep is untouched. The rule width
  // tracks the (uncolored) verdict length so it reads intentional. A CLEAN stack (no
  // sections) keeps its compact 3-line form — nothing above it to get lost under.
  const resultLine = `${style.resultLabel('result:')} ${resultBody}`;
  if (driftSections > 0) {
    const width = resultLine.replace(ANSI_RE, '').length;
    const rule = style.note('─'.repeat(width));
    log('\n' + rule);
    log(resultLine);
    log(rule);
  } else {
    log(resultLine);
  }
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
    // unresolved is jargon too: these are declared values whose CloudFormation intrinsic
    // cdkrd could not resolve to a concrete value, so there is nothing concrete to compare
    // against live — unverifiable, not drift. The representative examples are ones that are
    // resolution-unable BY NATURE: Fn::GetAZs and {{resolve:...}} dynamic references (SSM /
    // Secrets Manager). Fn::GetAtt is NOT listed bare — cdkrd re-resolves it once the target
    // is read live (gather.ts), so it lands here only when the target itself wasn't readable.
    // The generic groupReasons breakdown would just echo "intrinsic unresolved N", so spell it out.
    if (t === 'unresolved')
      return `unresolved=${items.length} (declared values whose CloudFormation intrinsic cdkrd couldn't resolve to a concrete value — e.g. Fn::GetAZs, a {{resolve:...}} dynamic reference, or an Fn::GetAtt whose target wasn't readable — unverifiable, not drift)`;
    // skipped = resources cdkrd genuinely could NOT read this run (CC-unsupported with
    // no SDK override, read error, missing physical id, custom resource). It is the one
    // info: tier that is a COVERAGE GAP, not a not-drift classification — so it carries
    // the "NOT checked / coverage incomplete" framing here (R28-era loud coverage warning,
    // folded into the footer in R127 so the drift result stays the first thing on screen).
    if (t === 'skipped')
      return `skipped=${items.length} — NOT checked (coverage incomplete: ${groupReasons(items)})`;
    return `${t}=${items.length} (${groupReasons(items)})`;
  };
  // #883: under --pre-deploy a `skipped: no physical id` finding is a not-yet-deployed
  // LOCAL resource (the next deploy creates it), NOT a coverage gap — so it must not carry
  // the "coverage incomplete" framing (that would contradict check.ts's #727 stderr note).
  // Peel those pending-creation skips out and render them as their own `pending creation`
  // line; any GENUINE gap (CC-unsupported, read error) stays in the "coverage incomplete"
  // skipped line. `pendingSkipSummary` returns null when there are none (non-pre-deploy runs
  // and pre-deploy runs with only genuine gaps are byte-identical to before).
  const skippedSummaryFor = (items: Finding[]): string[] => {
    if (!opts.preDeploy) return [summaryFor('skipped', items)];
    const pending = items.filter(isPendingCreationSkip);
    const gaps = items.filter((f) => !isPendingCreationSkip(f));
    const lines: string[] = [];
    if (gaps.length > 0) lines.push(summaryFor('skipped', gaps));
    if (pending.length > 0)
      lines.push(
        `pending creation=${pending.length} (not yet deployed — the next deploy will create them, not a coverage gap)`
      );
    return lines;
  };
  const summaries = INFO_TIERS.filter((t) => !isExpanded(t))
    .flatMap((t) => {
      const items = byTier(t);
      if (items.length === 0) return [];
      if (t === 'skipped') return skippedSummaryFor(items);
      return [summaryFor(t, items)];
    })
    .filter((s): s is string => s !== null);
  // R96: the folded nested-unrecorded count joins the info: footer (--show-all lists them).
  // Labelled `undeclared-subkey` rather than the bare `nested` — "nested" reads as a
  // nested STACK, but these are undeclared live-only sub-keys INSIDE a declared object,
  // not a stack relationship.
  if (nestedFolded.length > 0)
    summaries.push(
      `undeclared-subkey=${nestedFolded.length} (undeclared live-only values inside a declared object — record to record; --show-all to list)`
    );
  if (summaries.length === 1) {
    log(style.note(`info: ${summaries[0]} — run with --verbose for the list`));
  } else if (summaries.length > 1) {
    log(style.note('info:'));
    for (const s of summaries) log(style.note(`  - ${s}`));
    log(style.note('  run with --verbose for the list'));
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

// Slice on SAFE boundaries so truncating a JSON-stringified value never splits a
// surrogate pair (a lone surrogate renders as the replacement char `�`) or a JSON
// escape (a dangling odd run of backslashes would escape the following `…`). Trims a
// leading low-surrogate / trailing high-surrogate left by a mid-pair cut and a
// trailing odd backslash run left by a mid-escape cut. Cosmetic-only (TEXT mode; the
// `--json` path emits the raw untruncated value), but keeps long policy-doc values
// from rendering as corrupted `\uD83C…` / `…\\n\\…`.
export function safeSlice(s: string, start: number, end: number): string {
  let out = s.slice(start, end);
  if (out.length > 0) {
    const first = out.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1); // leading low surrogate
  }
  if (out.length > 0) {
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // trailing high surrogate
  }
  let bs = 0;
  for (let k = out.length - 1; k >= 0 && out[k] === '\\'; k--) bs++;
  if (bs % 2 === 1) out = out.slice(0, -1); // trailing half-escape (odd backslash run)
  return out;
}

// #1059: JSON.stringify SILENTLY drops an object property whose VALUE is a symbol and
// turns a symbol ARRAY ELEMENT into `null` — so a nested UNRESOLVED symbol (the
// intrinsic-resolver marker a declared value may carry) VANISHES from a rendered diff,
// producing a phantom "key appeared in live" / a wrong delta. Stringify through a replacer
// that maps a symbol to a VISIBLE marker so it renders instead of being dropped. UNRESOLVED
// gets its own `⟨unresolved⟩` label (matching how the footer names an unresolved intrinsic);
// any other symbol falls back to its description. The replacer only sees object-property /
// array-element values; a TOP-LEVEL symbol (`JSON.stringify(sym)` → undefined) is handled
// by symbolMarker before the stringify.
function symbolMarker(v: symbol): string {
  return v === UNRESOLVED ? '⟨unresolved⟩' : `⟨${v.description ?? 'symbol'}⟩`;
}
const symbolReplacer = (_k: string, value: unknown): unknown =>
  typeof value === 'symbol' ? symbolMarker(value) : value;
// JSON.stringify with symbol defense: a top-level symbol stringifies to `undefined`, so
// substitute its marker directly; nested symbols are caught by the replacer.
function stringifySymbolSafe(v: unknown): string | undefined {
  if (typeof v === 'symbol') return JSON.stringify(symbolMarker(v));
  return JSON.stringify(v, symbolReplacer);
}

function j(v: unknown): string {
  const s = stringifySymbolSafe(v);
  return s && s.length > VALUE_CAP ? safeSlice(s, 0, VALUE_CAP) + '…' : (s ?? String(v));
}

// #829: drift VALUES are JSON.stringify-escaped (via j()/jPair()), but several live-derived
// KEYS/IDS and note/hint lines are printed RAW — a live map key, ELB attributeKey, or
// array-delta identity id (all charset-permissive: env-var names, header/param names, policy
// names, custom-resource property keys) can carry control bytes. A key like
// `owner\r\nresult: CLEAN\x1b[2K` would inject a physical line that matches report.ts's
// documented `^result:` CI grep verdict — spoofing a CLEAN result past grep-based automation —
// or use CR + ANSI escapes to overwrite a real drift line on a TTY. Escape ASCII control
// chars (C0 range + DEL) to a visible `\xNN` form so a hostile key can never emit a raw
// newline / CR / ESC; printable text (incl. non-ASCII) is untouched. Pure + exported for tests.
//
// #1058: C0 + DEL is not enough — the Unicode bidi/format controls reorder or HIDE text on a
// bidi-aware terminal without any C0 byte. A RIGHT-TO-LEFT OVERRIDE (U+202E) or a bidi isolate
// (U+2066-U+2069) can cosmetically flip a key's rendered direction; a bidi embedding/override
// (U+202A-U+202E); and the zero-width set (U+200B-U+200F, U+FEFF) can vanish characters
// entirely — so a hostile key could still visually spoof a benign one. Escape those too, to a
// visible `\u{XXXX}` form. Ordinary printable non-ASCII (CJK, accents, emoji) stays untouched.
export function sanitizeForTerminal(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // C0 controls (\x00-\x1f) + DEL (\x7f) -> visible \xNN; a raw CR/LF/ESC could
    // else inject a spoofed `result:` line or overwrite a real drift line on a TTY.
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else if (isBidiOrZeroWidth(code)) {
      // Unicode bidi/format controls -> visible \u{XXXX}; else they reorder/hide text.
      out += `\\u{${code.toString(16).toUpperCase()}}`;
    } else {
      out += ch;
    }
  }
  return out;
}

// #1058: the invisible/directional Unicode controls a hostile live key can carry —
// bidi embeddings/overrides + isolates (U+202A-U+202E, U+2066-U+2069) and the
// zero-width set (U+200B-U+200F, U+FEFF). All BMP, so a single charCode is the codepoint.
function isBidiOrZeroWidth(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings/overrides (LRE/RLE/PDF/LRO/RLO)
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates (LRI/RLI/FSI/PDI)
    (code >= 0x200b && code <= 0x200f) || // ZWSP/ZWNJ/ZWJ/LRM/RLM
    code === 0xfeff // BOM / zero-width no-break space
  );
}

// Truncate a desired/actual (or baseline/actual) PAIR so the FIRST point at which the
// two diverge is visible even when both exceed the cap — one shared window centered on
// the divergence, applied to both. Independently slicing each at a fixed 200-char prefix
// (the old behavior) made two long values that differ only PAST the cap render as
// identical blobs, hiding the very change the report exists to show (common for long
// inline-policy / bucket-policy documents). Pure + exported for tests.
export function jPair(a: unknown, b: unknown): { a: string; b: string } {
  const as = stringifySymbolSafe(a) ?? String(a);
  const bs = stringifySymbolSafe(b) ?? String(b);
  if (as.length <= VALUE_CAP && bs.length <= VALUE_CAP) return { a: as, b: bs };
  let i = 0;
  const min = Math.min(as.length, bs.length);
  while (i < min && as[i] === bs[i]) i++; // first index at which they differ
  const CONTEXT = 40; // chars of shared lead-in kept before the divergence, for orientation
  const start = Math.max(0, i - CONTEXT);
  const window = (s: string): string => {
    let out = safeSlice(s, start, start + VALUE_CAP);
    if (start > 0) out = `…${out}`;
    if (start + VALUE_CAP < s.length) out = `${out}…`;
    return out;
  };
  return { a: window(as), b: window(bs) };
}
