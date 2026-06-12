// Git-committed project config: .cdkrd/config.json (cwd-relative, loaded once per run).
//
// Kept SEPARATE from the per-stack baseline file on purpose:
//   1. the baseline is a machine-generated artifact that `accept` (writeBaseline)
//      rewrites WHOLESALE every time — hand-written ignore rules would be erased on
//      every accept (and a carry-over special case would be an accident magnet);
//   2. ignore rules express an APP-WIDE intent ("this property is managed by an
//      external system"), not a per-stack/account/region fact, so they should live
//      once, not be duplicated into every baseline.
//
// The only field today is `ignore`: path-level rules for properties an external
// system legitimately keeps rewriting (Application Auto Scaling moving an ECS
// Service DesiredCount, DynamoDB autoscaled capacity, externally-managed Lambda
// reserved concurrency). Without this, `accept` (a value snapshot) would re-detect
// and force a re-accept every time the value moves — an infinite loop. This is the
// `.driftignore` / Terraform `ignore_changes` equivalent. The file is an extension
// point: future settings (concurrency, etc.) can be added here.

import { readFile } from 'node:fs/promises';
import { matchesGlob } from '../commands/glob-match.js';
import type { Finding } from '../types.js';

export interface CdkrdConfig {
  ignore: string[];
}

const CONFIG_PATH = '.cdkrd/config.json';

/**
 * Load `.cdkrd/config.json` (cwd-relative). Absent file -> empty config (backward
 * compatible, no migration needed). Invalid JSON or a wrong-typed `ignore` throws
 * a clear error (caller surfaces exit 2): a silently-ignored ignore-rule file is
 * the most dangerous failure mode (the user thinks a property is suppressed when it
 * is not), so this fails fast.
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
  const ignore = (parsed as Record<string, unknown>).ignore ?? [];
  if (!Array.isArray(ignore) || !ignore.every((x) => typeof x === 'string'))
    throw new Error(`${CONFIG_PATH}: "ignore" must be an array of strings`);
  return { ignore: ignore as string[] };
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
