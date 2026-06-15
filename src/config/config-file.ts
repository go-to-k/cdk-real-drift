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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { matchesGlob } from '../commands/glob-match.js';
import type { Finding } from '../types.js';

export interface CdkrdConfig {
  ignore: string[];
}

const CONFIG_PATH = '.cdkrd/config.json';
const KNOWN_KEYS = new Set(['ignore']);

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
  if (!Array.isArray(ignore) || !ignore.every((x) => typeof x === 'string'))
    throw new Error(`${CONFIG_PATH}: "ignore" must be an array of strings`);
  return { ignore: ignore as string[] };
}

/**
 * The exact ignore rule the `ignore` verb writes for a finding (no glob, no `:`
 * stack scope — the hand-authored forms in `parseIgnoreRule` stay manual, R-PR-B).
 * Prefer the human-friendly `<constructPath>.<path>` when present (CDK stacks): it is
 * what `cdk-local` targets on and it embeds the stack name, so it is naturally
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
 * Union new rules into an existing rule list: dedupe, drop already-present ones,
 * keep a stable (sorted) order so the committed `config.json` diff is reviewable and
 * order-independent. Pure + exported — the IO wrapper `addIgnoreRules` is a thin shell
 * over this so the merge logic is unit-tested without touching the filesystem.
 */
export function mergeIgnoreRules(
  existing: string[],
  incoming: string[]
): { merged: string[]; added: string[]; alreadyPresent: string[] } {
  const have = new Set(existing);
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
  const merged = [...new Set([...existing, ...added])].sort((a, b) => a.localeCompare(b));
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
  raw: string;
  stackGlob?: string; // when set, the rule applies only to stacks whose name matches it
  idPathPattern: string; // glob against "<logicalId>.<path>"
}

/**
 * Parse one ignore pattern. Two forms:
 *   "<logicalId>.<property path>"                  — any stack
 *   "<stack name glob>:<logicalId>.<property path>" — stack-scoped (`:` separator)
 * Both parts reuse the existing stack-name glob (`*` / `?`). Split on the FIRST `:`
 * so a path with no colon never accidentally becomes stack-scoped.
 */
export function parseIgnoreRule(pattern: string): IgnoreRule {
  const colon = pattern.indexOf(':');
  if (colon === -1) return { raw: pattern, idPathPattern: pattern };
  return {
    raw: pattern,
    stackGlob: pattern.slice(0, colon),
    idPathPattern: pattern.slice(colon + 1),
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
 */
export function applyIgnores(
  findings: Finding[],
  stackName: string,
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
        targets.some((t) => pathMatches(r.idPathPattern, t))
    );
    if (!hit) return f;
    return { ...f, tier: 'ignored', note: `ignored by config rule "${hit.raw}"` };
  });
}
