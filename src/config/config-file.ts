// Git-committed project config: .cdkrd/config.json (cwd-relative, loaded once per run).
//
// Kept SEPARATE from the per-stack baseline file on purpose:
//   1. the baseline is a machine-generated artifact that `record` (writeBaseline)
//      rewrites WHOLESALE every time — hand-written ignore rules would be erased on
//      every record (and a carry-over special case would be an accident magnet);
//   2. ignore rules express an APP-WIDE intent ("this property is managed by an
//      external system"), not a per-stack/account/region fact, so they should live
//      once, not be duplicated into every baseline.
//
// The only field today is `ignore`: path-level rules for properties an external
// system legitimately keeps rewriting (Application Auto Scaling moving an ECS
// Service DesiredCount, DynamoDB autoscaled capacity, externally-managed Lambda
// reserved concurrency). Without this, `record` (a value snapshot) would re-detect
// and force a re-record every time the value moves — an infinite loop. This is the
// `.driftignore` / Terraform `ignore_changes` equivalent. The file is an extension
// point: future settings (concurrency, etc.) can be added here.
//
// Every ignore rule is an OBJECT `{ "path", "stack"?, "region"? }` — one uniform,
// self-labelling shape (no bare-string shorthand: `"*.DesiredCount"` alone reads as
// an unlabelled value, so the required `path` key spells out what it is). `path` is
// the property pattern; `stack` / `region` are optional scopes (absent = any). Region
// matters because the same stack name can be deployed to several regions (or be matched
// by a `*` glob) and a property may legitimately drift in only one — region is an
// independent axis from the stack name (which often, but not always, already encodes
// the region). All three of `path` / `stack` / `region` accept the same `*` / `?` glob.
//   "ignore": [
//     { "path": "ApiStack/ServiceRole.Policies" },                  // any stack, any region
//     { "path": "*.DesiredCount", "region": "us-*" },               // every us-* region
//     { "path": "Fn*.ReservedConcurrentExecutions", "stack": "Prod*", "region": "ap-northeast-1" }
//   ]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { matchesGlob, matchesPathGlob } from '../commands/glob-match.js';
import type { Finding } from '../types.js';

// An ignore rule. `path` is the glob against "<logicalId>.<path>" /
// "<constructPath>.<path>"; `stack` / `region` are optional globs that further restrict
// WHERE the rule applies (absent = any).
export interface IgnoreRuleObject {
  path: string;
  stack?: string;
  region?: string;
}

export interface CdkrdConfig {
  ignore: IgnoreRuleObject[];
}

const CONFIG_PATH = '.cdkrd/config.json';
const KNOWN_KEYS = new Set(['ignore']);
const RULE_OBJECT_KEYS = new Set(['path', 'stack', 'region']);

/**
 * Load `.cdkrd/config.json` (cwd-relative). Absent file -> empty config (backward
 * compatible, no migration needed). Invalid JSON, a wrong-typed `ignore`, or an
 * unknown top-level key throws a clear error (caller surfaces exit 2): a
 * silently-ignored ignore-rule file is the most dangerous failure mode (the user
 * thinks a property is suppressed when it is not), so this fails fast. Unknown-key
 * rejection closes the typo variant of the same mode (`"ignroe"` would otherwise
 * load as an empty config without a sound).
 */
export async function loadConfig(): Promise<CdkrdConfig> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ignore: [] };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CONFIG_PATH} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${CONFIG_PATH} must be a JSON object`);
  const unknown = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0)
    throw new Error(
      `${CONFIG_PATH}: unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')} — known keys: ${[...KNOWN_KEYS].map((k) => `"${k}"`).join(', ')}`
    );
  const ignore = (parsed as Record<string, unknown>).ignore ?? [];
  if (!Array.isArray(ignore)) throw new Error(`${CONFIG_PATH}: "ignore" must be an array`);
  ignore.forEach((entry, i) => validateIgnoreEntry(entry, i));
  return { ignore: ignore as IgnoreRuleObject[] };
}

/**
 * Validate one `ignore` array entry: an object with a required string `path` and
 * optional string `stack` / `region` (and no other keys — the same fail-fast typo
 * guard as the unknown-top-level-key check, so a mistyped `"reigon"` is rejected
 * rather than silently ignored, which would leave a property unscoped).
 */
function validateIgnoreEntry(entry: unknown, index: number): void {
  const at = `${CONFIG_PATH}: "ignore"[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    throw new Error(`${at} must be an object { "path", "stack"?, "region"? }`);
  const obj = entry as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !RULE_OBJECT_KEYS.has(k));
  if (unknown.length > 0)
    throw new Error(
      `${at}: unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')} — known keys: "path", "stack", "region"`
    );
  if (typeof obj.path !== 'string')
    throw new Error(`${at}: "path" is required and must be a string`);
  for (const k of ['stack', 'region'] as const)
    if (obj[k] !== undefined && typeof obj[k] !== 'string')
      throw new Error(`${at}: "${k}" must be a string`);
}

/**
 * The exact ignore rule the `ignore` verb writes for a finding — always the unscoped
 * rule (just `path`); the optional `stack` / `region` scopes stay hand-authored (the
 * verb writes the simplest rule; narrowing is a manual edit). Prefer the human-friendly
 * `<constructPath>.<path>` when present (CDK stacks): it is what `cdk-local` targets on
 * and it embeds the stack name, so it is naturally stack-scoped and readable in the
 * git-committed config diff. Falls back to `<logicalId>.<path>`, which is ALWAYS present
 * (the CloudFormation key) so a rule is always writable even on a non-CDK / metadata-
 * stripped stack. Pure + exported; `applyIgnores` matches on EITHER target, so both work.
 */
export function ignoreRuleFor(finding: Finding): IgnoreRuleObject {
  const id = finding.constructPath ?? finding.logicalId;
  return { path: finding.path ? `${id}.${finding.path}` : id };
}

/** Canonical identity of a rule (path + the two optional scopes), for dedupe. */
function ruleKey(r: IgnoreRuleObject): string {
  return JSON.stringify([r.path, r.stack ?? null, r.region ?? null]);
}

/**
 * Union new rules into an existing rule list: dedupe by full identity (path + stack +
 * region — so a scoped rule never collides with the unscoped one for the same path),
 * drop already-present ones, and keep a stable order so the committed `config.json` diff
 * is reviewable and order-independent (sort by path, then stack, then region). Pure +
 * exported — the IO wrapper `addIgnoreRules` is a thin shell over this so the merge logic
 * is unit-tested without touching disk.
 */
export function mergeIgnoreRules(
  existing: IgnoreRuleObject[],
  incoming: IgnoreRuleObject[]
): { merged: IgnoreRuleObject[]; added: IgnoreRuleObject[]; alreadyPresent: IgnoreRuleObject[] } {
  const have = new Set(existing.map(ruleKey));
  const added: IgnoreRuleObject[] = [];
  const alreadyPresent: IgnoreRuleObject[] = [];
  // dedupe the incoming list against itself too (a stack can surface the same rule twice)
  const seen = new Set<string>();
  for (const rule of incoming) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    if (have.has(key)) alreadyPresent.push(rule);
    else added.push(rule);
  }
  // Byte-stable comparator (NOT localeCompare): `config.json` is git-committed, so
  // its order must be identical across machines/locales — the same requirement
  // `baseline-file.ts`'s `sortRecorded` meets with the same `<`/`>` comparator.
  // localeCompare is ICU/locale-dependent and would churn the committed file's diff.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byKey = new Map([...existing, ...added].map((r) => [ruleKey(r), r]));
  const merged = [...byKey.values()].sort(
    (a, b) =>
      cmp(a.path, b.path) ||
      cmp(a.stack ?? '', b.stack ?? '') ||
      cmp(a.region ?? '', b.region ?? '')
  );
  return { merged, added, alreadyPresent };
}

/**
 * Append ignore rules to `.cdkrd/config.json` (cwd-relative), creating the file (and
 * the `.cdkrd/` dir) if absent. Idempotent: rules already present are reported, not
 * duplicated. Loads through `loadConfig` first so a malformed config fails fast rather
 * than being silently overwritten. Returns the path + what changed so the caller can
 * report it. The only mutating entry point for config (parallel to `writeBaseline`).
 */
export async function addIgnoreRules(
  newRules: IgnoreRuleObject[]
): Promise<{ path: string; added: IgnoreRuleObject[]; alreadyPresent: IgnoreRuleObject[] }> {
  const config = await loadConfig();
  const { merged, added, alreadyPresent } = mergeIgnoreRules(config.ignore, newRules);
  // Only touch disk when something actually changed — an all-already-present run leaves
  // the file (and its git status) untouched.
  if (added.length > 0) {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify({ ...config, ignore: merged }, null, 2)}\n`);
  }
  return { path: CONFIG_PATH, added, alreadyPresent };
}

interface IgnoreRule {
  raw: string; // human-readable form for the "ignored by config rule ..." note
  pathPattern: string; // glob against "<logicalId>.<path>" / "<constructPath>.<path>"
  stackGlob?: string | undefined; // when set, the rule applies only to stacks whose name matches it
  regionGlob?: string | undefined; // when set, the rule applies only in regions matching it
}

/**
 * Normalize one ignore rule object into a matchable rule. `path` is the pattern; an
 * optional `stack` and/or `region` glob scopes it (absent = any). All three reuse the
 * existing `*` / `?` glob. `raw` is a readable rendering for the report's "ignored by
 * config rule …" note (a scoped rule shows its scope in parentheses).
 */
export function parseIgnoreRule(entry: IgnoreRuleObject): IgnoreRule {
  const scope = [
    entry.stack !== undefined ? `stack:${entry.stack}` : undefined,
    entry.region !== undefined ? `region:${entry.region}` : undefined,
  ].filter((s): s is string => s !== undefined);
  return {
    raw: scope.length > 0 ? `${entry.path} (${scope.join(', ')})` : entry.path,
    pathPattern: entry.path,
    stackGlob: entry.stack,
    regionGlob: entry.region,
  };
}

/**
 * True when `pattern` matches `target` (= "<logicalId>.<path>"), either exactly or
 * as a PARENT path: a rule "X.Policies" also ignores child paths like
 * "X.Policies.0.PolicyName" AND "X.Policies[MyPol].PolicyName" (so ignoring a
 * structured property covers its leaves, including array / identity-keyed elements).
 * Parent matching walks ancestors at each `.` OR `[` boundary, combined with the glob.
 */
function pathMatches(pattern: string, target: string): boolean {
  if (matchesPathGlob(pattern, target)) return true;
  // A rule on a PARENT property ignores its whole subtree — including array / identity-
  // keyed children whose path glues the index to its key inside ONE dot-segment
  // (`Policies[MyPol].PolicyName`, `Statement[0].Condition`, `Tags[env]`). Walk ancestor
  // paths by trimming at each `.` OR `[` boundary (not just `.`), so a rule `X.Policies`
  // covers `X.Policies[MyPol].PolicyName` and `X.Statement` covers
  // `X.Statement[0].Condition` — the dot-only split silently failed for bracket children.
  let t = target;
  while (true) {
    const cut = Math.max(t.lastIndexOf('.'), t.lastIndexOf('['));
    if (cut <= 0) break;
    t = t.slice(0, cut);
    if (matchesPathGlob(pattern, t)) return true;
  }
  return false;
}

/**
 * Re-tag declared/undeclared/added findings that match an ignore rule to the
 * `ignored` tier (informational) — they are SURFACED, never silently dropped,
 * preserving the "everything is reported" invariant. `added` (a whole out-of-band
 * resource) is ignorable like declared/undeclared — accepting it is a deliberate
 * decision, symmetric with revert. `deleted` is never ignorable (a path rule must
 * not silence a resource deletion); readGap/unresolved/skipped are already
 * informational and left untouched. Pure: no IO.
 *
 * A rule matches against EITHER `<logicalId>.<path>` OR (when present)
 * `<constructPath>.<path>`, so both styles work:
 *   - logicalId (`ApiRole1234ABCD.Policies`) is the CloudFormation template's resource
 *     key — ALWAYS present, so a rule keyed on it works on ANY stack, CDK or not.
 *     This is what makes ignore rules usable on non-CDK / raw-CloudFormation stacks.
 *   - constructPath (`MyStack/ApiRole.Policies`) is the human-friendly path, the same
 *     id `cdk-local` uses for targeting. It comes from optional `aws:cdk:path`
 *     Metadata (absent on non-CDK stacks, disableable on CDK ones), so it is offered
 *     as an ADDITIONAL match target, never the only one — a rule written against it
 *     keeps working on CDK stacks while logicalId covers everything else.
 *
 * A scoped object rule additionally gates on `stack` and/or `region` globs (absent =
 * any). `region` is an independent axis from the stack name: the same stack can be
 * deployed to multiple regions (or be matched by a `*` stack glob), and a property may
 * legitimately drift in only one — so the caller passes the current `region` here.
 */
export function applyIgnores(
  findings: Finding[],
  stackName: string,
  region: string,
  config: CdkrdConfig
): Finding[] {
  if (config.ignore.length === 0) return findings;
  const rules = config.ignore.map(parseIgnoreRule);
  return findings.map((f) => {
    if (f.tier !== 'declared' && f.tier !== 'undeclared' && f.tier !== 'added') return f;
    // A whole-resource `added` finding has an empty path, so omit the `.<path>` suffix:
    // the rule target is then just the id, matching ignoreRuleFor's empty-path form
    // (a trailing dot would only match via the parent-segment fallback — fragile).
    const suffix = f.path ? `.${f.path}` : '';
    const targets = [`${f.logicalId}${suffix}`];
    if (f.constructPath) targets.push(`${f.constructPath}${suffix}`);
    const hit = rules.find(
      (r) =>
        (r.stackGlob === undefined || matchesGlob(r.stackGlob, stackName)) &&
        (r.regionGlob === undefined || matchesGlob(r.regionGlob, region)) &&
        targets.some((t) => pathMatches(r.pathPattern, t))
    );
    if (!hit) return f;
    // Clear the `unrecorded` flag (set by applyBaseline for a not-yet-recorded
    // undeclared/added value): an `ignored` finding is a DECIDED value — the user told
    // cdkrd to STOP reporting it — so it must not still surface under `[Not Recorded]`
    // nor nag "run cdkrd record" (report/stack-actions filter that section by the FLAG,
    // not the tier). This upholds the `record` vs `ignore` invariant (ignore stops
    // watching). The exit code was always safe (ignored is not a drift tier); this fixes
    // the spurious reporting that defeated the purpose of `ignore`.
    const { unrecorded: _unrecorded, ...rest } = f;
    return { ...rest, tier: 'ignored', note: `ignored by config rule "${hit.raw}"` };
  });
}
