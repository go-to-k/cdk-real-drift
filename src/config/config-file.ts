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
// An ignore rule is EITHER a bare string (the unscoped common case — applies to any
// stack in any region) OR an object that scopes the same path pattern to a stack
// and/or a region (`{ "path": ..., "stack"?: ..., "region"?: ... }`). The string is
// shorthand for `{ "path": <string> }`. Scoping by region matters because the same
// stack name can be deployed to several regions (or matched by a `*` glob) and a
// property may legitimately drift in only one — region is an independent axis from
// the stack name (which often, but not always, already encodes the region). All
// three of `path` / `stack` / `region` accept the same `*` / `?` glob.
//   "ignore": [
//     "ApiStack/ServiceRole.Policies",                              // any stack, any region
//     { "path": "*.DesiredCount", "region": "us-*" },               // every us-* region
//     { "path": "Fn*.ReservedConcurrentExecutions", "stack": "Prod*", "region": "ap-northeast-1" }
//   ]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { matchesGlob } from '../commands/glob-match.js';
import type { Finding } from '../types.js';

// A scoped ignore rule. `path` is the glob against "<logicalId>.<path>" /
// "<constructPath>.<path>" (the same target as a bare-string rule); `stack` / `region`
// are optional globs that further restrict WHERE the rule applies (absent = any).
export interface IgnoreRuleObject {
  path: string;
  stack?: string;
  region?: string;
}
// One entry of `config.ignore`: the bare-string shorthand or the scoped object form.
export type IgnoreEntry = string | IgnoreRuleObject;

export interface CdkrdConfig {
  ignore: IgnoreEntry[];
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
  return { ignore: ignore as IgnoreEntry[] };
}

/**
 * Validate one `ignore` array entry: a string, or an object with a required string
 * `path` and optional string `stack` / `region` (and no other keys — the same
 * fail-fast typo guard as the unknown-top-level-key check, so a mistyped `"reigon"`
 * is rejected rather than silently ignored, which would leave a property unscoped).
 */
function validateIgnoreEntry(entry: unknown, index: number): void {
  const at = `${CONFIG_PATH}: "ignore"[${index}]`;
  if (typeof entry === 'string') return;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    throw new Error(`${at} must be a string or an object`);
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
 * The exact ignore rule the `ignore` verb writes for a finding — always the bare-string
 * (unscoped) form; the SCOPED object form (`stack` / `region`) stays hand-authored, the
 * same philosophy as before (the verb writes the simplest rule; narrowing is a manual
 * edit). Prefer the human-friendly `<constructPath>.<path>` when present (CDK stacks): it
 * is what `cdk-local` targets on and it embeds the stack name, so it is naturally
 * stack-scoped and readable in the git-committed config diff. Falls back to
 * `<logicalId>.<path>`, which is ALWAYS present (the CloudFormation key) so a rule is
 * always writable even on a non-CDK / metadata-stripped stack. Pure + exported so the
 * choice is unit-tested; `applyIgnores` matches on EITHER target, so both forms work.
 */
export function ignoreRuleFor(finding: Finding): string {
  const id = finding.constructPath ?? finding.logicalId;
  return finding.path ? `${id}.${finding.path}` : id;
}

/**
 * Union new (bare-string) rules into an existing rule list. Dedupe new strings against
 * the existing STRING entries only (an object entry is a different, scoped rule — never
 * deduped against a bare string); existing OBJECT entries are preserved untouched. Keep
 * a stable order so the committed `config.json` diff is reviewable and order-independent:
 * the string rules sort lexicographically and lead, the hand-authored objects keep their
 * original relative order after them. Pure + exported — the IO wrapper `addIgnoreRules`
 * is a thin shell over this so the merge logic is unit-tested without touching disk.
 */
export function mergeIgnoreRules(
  existing: IgnoreEntry[],
  incoming: string[]
): { merged: IgnoreEntry[]; added: string[]; alreadyPresent: string[] } {
  const existingStrings = existing.filter((e): e is string => typeof e === 'string');
  const objects = existing.filter((e): e is IgnoreRuleObject => typeof e !== 'string');
  const have = new Set(existingStrings);
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  // dedupe the incoming list against itself too (a stack can surface the same rule twice)
  const seen = new Set<string>();
  for (const rule of incoming) {
    if (seen.has(rule)) continue;
    seen.add(rule);
    if (have.has(rule)) alreadyPresent.push(rule);
    else added.push(rule);
  }
  const mergedStrings = [...new Set([...existingStrings, ...added])].sort((a, b) =>
    a.localeCompare(b)
  );
  return { merged: [...mergedStrings, ...objects], added, alreadyPresent };
}

/**
 * Append ignore rules to `.cdkrd/config.json` (cwd-relative), creating the file (and
 * the `.cdkrd/` dir) if absent. Idempotent: rules already present are reported, not
 * duplicated. Loads through `loadConfig` first so a malformed config fails fast rather
 * than being silently overwritten. Returns the path + what changed so the caller can
 * report it. The only mutating entry point for config (parallel to `writeBaseline`).
 */
export async function addIgnoreRules(
  newRules: string[]
): Promise<{ path: string; added: string[]; alreadyPresent: string[] }> {
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
 * Normalize one ignore entry into a matchable rule. A bare string is the unscoped
 * common case (path pattern, any stack, any region). An object scopes the same path
 * pattern by an optional `stack` and/or `region` glob. All three fields reuse the
 * existing `*` / `?` glob. `raw` is a readable rendering for the report's "ignored by
 * config rule …" note (the scoped object form shows its scope in parentheses).
 */
export function parseIgnoreRule(entry: IgnoreEntry): IgnoreRule {
  if (typeof entry === 'string') return { raw: entry, pathPattern: entry };
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
 * as a PARENT segment: a rule "X.Policies" also ignores child paths like
 * "X.Policies.0.PolicyName" (so ignoring a structured property covers its leaves).
 * Parent matching is at dot-segment boundaries only, combined with the glob.
 */
function pathMatches(pattern: string, target: string): boolean {
  if (matchesGlob(pattern, target)) return true;
  const segs = target.split('.');
  for (let i = 1; i < segs.length; i++) {
    if (matchesGlob(pattern, segs.slice(0, i).join('.'))) return true;
  }
  return false;
}

/**
 * Re-tag declared/undeclared findings that match an ignore rule to the `ignored`
 * tier (informational) — they are SURFACED, never silently dropped, preserving the
 * "everything is reported" invariant. `deleted` is never ignorable (a path rule must
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
    if (f.tier !== 'declared' && f.tier !== 'undeclared') return f;
    const targets = [`${f.logicalId}.${f.path}`];
    if (f.constructPath) targets.push(`${f.constructPath}.${f.path}`);
    const hit = rules.find(
      (r) =>
        (r.stackGlob === undefined || matchesGlob(r.stackGlob, stackName)) &&
        (r.regionGlob === undefined || matchesGlob(r.regionGlob, region)) &&
        targets.some((t) => pathMatches(r.pathPattern, t))
    );
    if (!hit) return f;
    return { ...f, tier: 'ignored', note: `ignored by config rule "${hit.raw}"` };
  });
}
