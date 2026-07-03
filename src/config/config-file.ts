// Git-committed project config: .cdkrd/ignore.yaml (cwd-relative, loaded once per run).
//
// YAML, not JSON, ON PURPOSE: this is a hand-edited POLICY file (the ignore-file
// family — .gitignore / .dockerignore / .trivyignore — is conventionally comment-bearing,
// never JSON), and the single most valuable hand-edit is recording WHY a property is
// ignored. JSON cannot hold a comment; YAML can. The companion baseline file stays JSON
// because it is the opposite — a machine-generated, wholesale-rewritten data artifact, not
// a human policy. The file format itself signals the role: data = JSON, policy = YAML.
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
// Every ignore rule is a MAPPING `{ path, stack?, account?, region? }` — one uniform,
// self-labelling shape (no bare-string shorthand: `"*.DesiredCount"` alone reads as
// an unlabelled value, so the required `path` key spells out what it is). `path` is
// the property pattern; `stack` / `account` / `region` are optional scopes (absent =
// any). These three scope axes are EXACTLY the baseline file's identity axes (stack ×
// account × region): the same stack name can be deployed to several accounts and/or
// regions (the common `env: { account, region }` CDK pattern, or a `*` stack glob), and
// a property may legitimately drift in only one of those — so a rule must be able to
// narrow to any of the three. `account` matters for the same reason `region` does:
// stack-name uniqueness only holds WITHIN one account/App, so without it a `stack: "Prod*"`
// rule leaks into a same-named stack in another account. All four of `path` / `stack` /
// `account` / `region` accept the same `*` / `?` glob.
//   ignore:
//     # ServiceRole inline policies are managed by an external system
//     - path: ApiStack/ServiceRole.Policies              # any stack, account, region
//     - path: "*.DesiredCount"                            # us-* regions, prod account only
//       account: "111111111111"
//       region: us-*
//     - path: Fn*.ReservedConcurrentExecutions
//       stack: Prod*
//       region: ap-northeast-1

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Document, isSeq, parseDocument, YAMLSeq } from 'yaml';
import { matchesGlob, matchesPathGlob } from '../commands/glob-match.js';
import { withinStackPath } from '../construct-path.js';
import type { Finding } from '../types.js';

// An ignore rule. `path` is the glob against "<logicalId>.<path>" /
// "<constructPath>.<path>"; `stack` / `account` / `region` are optional globs that further
// restrict WHERE the rule applies (absent = any) — the baseline file's three identity axes.
export interface IgnoreRuleObject {
  path: string;
  stack?: string;
  account?: string;
  region?: string;
}

export interface CdkrdConfig {
  ignore: IgnoreRuleObject[];
}

const CONFIG_PATH = '.cdkrd/ignore.yaml';
const KNOWN_KEYS = new Set(['ignore']);
const RULE_OBJECT_KEYS = new Set(['path', 'stack', 'account', 'region']);

// Header written above a freshly-created ignore.yaml so a hand-editor immediately sees the
// shape and the comment convention. Existing files keep their own comments (append-only).
const FILE_HEADER =
  '# cdkrd ignore rules — properties cdkrd should stop reporting as drift.\n' +
  '# Each rule: { path, stack?, account?, region? }; `path` is a\n' +
  '# "<constructPath|logicalId>.<property>" glob, the scopes narrow WHERE it applies.\n' +
  '# Add a comment above a rule to record WHY it is ignored.\n';

/**
 * Load `.cdkrd/ignore.yaml` (cwd-relative). Absent file -> empty config (no migration
 * needed). A comments-only / empty file parses to null -> empty config too. Invalid
 * YAML, a wrong-typed `ignore`, or an unknown top-level key throws a clear error (caller
 * surfaces exit 2): a silently-ignored ignore-rule file is the most dangerous failure
 * mode (the user thinks a property is suppressed when it is not), so this fails fast.
 * Unknown-key rejection closes the typo variant of the same mode (`ignroe` would
 * otherwise load as an empty config without a sound).
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
  // parseDocument collects syntax problems in `doc.errors` (it does NOT throw), so check
  // them explicitly to fail fast. YAML is a JSON superset, so this also reads a legacy
  // all-JSON ignore.yaml.
  const doc = parseDocument(raw, { prettyErrors: true });
  if (doc.errors.length > 0) throw new Error(`${CONFIG_PATH} is not valid YAML`);
  try {
    parsed = doc.toJS();
  } catch {
    throw new Error(`${CONFIG_PATH} is not valid YAML`);
  }
  // A file that is empty or only comments parses to null/undefined — an empty config,
  // not an error (the `ignore` verb writes a header-comment-only file before any rule).
  if (parsed === null || parsed === undefined) return { ignore: [] };
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${CONFIG_PATH} must be a YAML mapping`);
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
 * Validate one `ignore` array entry: a mapping with a required string `path` and
 * optional string `stack` / `account` / `region` (and no other keys — the same fail-fast
 * typo guard as the unknown-top-level-key check, so a mistyped `reigon` is rejected
 * rather than silently ignored, which would leave a property unscoped).
 */
function validateIgnoreEntry(entry: unknown, index: number): void {
  const at = `${CONFIG_PATH}: "ignore"[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    throw new Error(`${at} must be a mapping { path, stack?, account?, region? }`);
  const obj = entry as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !RULE_OBJECT_KEYS.has(k));
  if (unknown.length > 0)
    throw new Error(
      `${at}: unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')} — known keys: "path", "stack", "account", "region"`
    );
  if (typeof obj.path !== 'string')
    throw new Error(`${at}: "path" is required and must be a string`);
  if (obj.path === '')
    // an empty path matches NOTHING (the glob `^$` never matches a `<id>.<path>` target
    // and the ancestor walk never reaches empty) — a silent no-op rule the user believes
    // is suppressing a property. Reject it loudly so the no-op can't masquerade as active.
    throw new Error(`${at}: "path" must not be empty`);
  for (const k of ['stack', 'account', 'region'] as const)
    if (obj[k] !== undefined && typeof obj[k] !== 'string')
      throw new Error(`${at}: "${k}" must be a string`);
}

/**
 * The exact ignore rule the `ignore` verb writes for a finding — always the unscoped
 * rule (just `path`); the optional `stack` / `region` scopes stay hand-authored (the
 * verb writes the simplest rule; narrowing is a manual edit). Prefer the human-friendly
 * `<constructPath>.<path>` when present (CDK stacks): it is what `cdk-local` targets on
 * and readable in the git-committed config diff. The construct path is written WITHIN the
 * stack (the stack/Stage prefix stripped, given `stackName`) so it is byte-identical to
 * what the report prints for the finding — copy what you see. Naturally stack-scoped even
 * without the prefix (a `stack:` scope narrows further). Falls back to `<logicalId>.<path>`,
 * ALWAYS present (the CloudFormation key) so a rule is writable even on a non-CDK /
 * metadata-stripped stack. Pure + exported; `applyIgnores` matches the within-stack path,
 * the full construct path (older rules), AND the logicalId, so every form works.
 */
export function ignoreRuleFor(finding: Finding, stackName = ''): IgnoreRuleObject {
  const id = finding.constructPath
    ? withinStackPath(finding.constructPath, stackName)
    : finding.logicalId;
  return { path: finding.path ? `${id}.${finding.path}` : id };
}

/** Canonical identity of a rule (path + the three optional scopes), for dedupe. */
function ruleKey(r: IgnoreRuleObject): string {
  return JSON.stringify([r.path, r.stack ?? null, r.account ?? null, r.region ?? null]);
}

/** A rule as a plain object with keys in canonical order (path, stack, account, region),
 *  undefined scopes omitted — the shape serialized into a YAML mapping node. */
function orderedRule(r: IgnoreRuleObject): Record<string, string> {
  const o: Record<string, string> = { path: r.path };
  if (r.stack !== undefined) o.stack = r.stack;
  if (r.account !== undefined) o.account = r.account;
  if (r.region !== undefined) o.region = r.region;
  return o;
}

/**
 * Union new rules into an existing rule list: dedupe by full identity (path + stack +
 * account + region — so a scoped rule never collides with the unscoped one for the same
 * path), drop already-present ones. APPEND-ONLY: new rules go to the END, existing order
 * untouched. Unlike the baseline (machine-rewritten, so a stable sort keeps its diff
 * clean), ignore.yaml is HAND-CURATED with `#` comments that group and explain rules —
 * re-sorting on every append would shuffle the user's layout and detach those comments.
 * The user owns the order; the verb only appends. Pure + exported — the IO wrapper
 * `addIgnoreRules` is a thin shell over this so the merge logic is unit-tested off disk.
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
  return { merged: [...existing, ...added], added, alreadyPresent };
}

/**
 * Serialize an append: parse the existing YAML (preserving its comments + layout via the
 * document/CST model), append the new rules to the `ignore` sequence, and re-emit. A fresh
 * file starts from `FILE_HEADER` so a first-time hand-editor sees the shape + the comment
 * convention. Comment-preserving is the whole point of choosing YAML — a naive parse->emit
 * (like `JSON.stringify`) would erase the user's "why" comments on every `ignore` run.
 */
function appendRulesToYaml(existingRaw: string | undefined, added: IgnoreRuleObject[]): string {
  const doc: Document =
    existingRaw !== undefined && existingRaw.trim() !== ''
      ? parseDocument(existingRaw)
      : parseDocument(`${FILE_HEADER}ignore:\n`);
  let seq = doc.get('ignore');
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set('ignore', seq);
  }
  for (const rule of added) (seq as YAMLSeq).add(doc.createNode(orderedRule(rule)));
  return doc.toString();
}

/**
 * Append ignore rules to `.cdkrd/ignore.yaml` (cwd-relative), creating the file (and
 * the `.cdkrd/` dir) if absent. Idempotent: rules already present are reported, not
 * duplicated. Loads through `loadConfig` first so a malformed config fails fast rather
 * than being silently overwritten. Returns the path + what changed so the caller can
 * report it. The only mutating entry point for config (parallel to `writeBaseline`).
 */
export async function addIgnoreRules(
  newRules: IgnoreRuleObject[]
): Promise<{ path: string; added: IgnoreRuleObject[]; alreadyPresent: IgnoreRuleObject[] }> {
  const config = await loadConfig(); // validates first — a malformed file throws, not overwritten
  const { added, alreadyPresent } = mergeIgnoreRules(config.ignore, newRules);
  // Only touch disk when something actually changed — an all-already-present run leaves
  // the file (and its git status) untouched.
  if (added.length > 0) {
    let existingRaw: string | undefined;
    try {
      existingRaw = await readFile(CONFIG_PATH, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, appendRulesToYaml(existingRaw, added));
  }
  return { path: CONFIG_PATH, added, alreadyPresent };
}

interface IgnoreRule {
  raw: string; // human-readable form for the "ignored by config rule ..." note
  pathPattern: string; // glob against "<logicalId>.<path>" / "<constructPath>.<path>"
  stackGlob?: string | undefined; // when set, the rule applies only to stacks whose name matches it
  accountGlob?: string | undefined; // when set, the rule applies only in accounts matching it
  regionGlob?: string | undefined; // when set, the rule applies only in regions matching it
}

/**
 * Normalize one ignore rule object into a matchable rule. `path` is the pattern; an
 * optional `stack` / `account` / `region` glob scopes it (absent = any). All four reuse
 * the existing `*` / `?` glob. `raw` is a readable rendering for the report's "ignored by
 * config rule …" note (a scoped rule shows its scope in parentheses).
 */
export function parseIgnoreRule(entry: IgnoreRuleObject): IgnoreRule {
  const scope = [
    entry.stack !== undefined ? `stack:${entry.stack}` : undefined,
    entry.account !== undefined ? `account:${entry.account}` : undefined,
    entry.region !== undefined ? `region:${entry.region}` : undefined,
  ].filter((s): s is string => s !== undefined);
  return {
    raw: scope.length > 0 ? `${entry.path} (${scope.join(', ')})` : entry.path,
    pathPattern: entry.path,
    stackGlob: entry.stack,
    accountGlob: entry.account,
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
 * A scoped object rule additionally gates on `stack` / `account` / `region` globs (absent
 * = any) — the baseline file's three identity axes. `account` and `region` are independent
 * axes from the stack name: the same stack can be deployed to multiple accounts and/or
 * regions (or be matched by a `*` stack glob), and a property may legitimately drift in only
 * one — so the caller passes the current env via `scope`. Without `account`, a
 * `stack: "Prod*"` rule would leak into a same-named stack in another account.
 *
 * `scope` is an OBJECT, not positional args: `accountId` and `region` are both strings on
 * adjacent axes, so a positional `(…, accountId, region, …)` signature invites a silent
 * transposition at the 11 call sites (the compiler can't tell two strings apart). The named
 * `{ stackName, accountId, region }` makes a swap a compile error and self-documents intent.
 */
export interface IgnoreScope {
  stackName: string;
  accountId: string;
  region: string;
}

export function applyIgnores(
  findings: Finding[],
  scope: IgnoreScope,
  config: CdkrdConfig
): Finding[] {
  if (config.ignore.length === 0) return findings;
  const { stackName, accountId, region } = scope;
  const rules = config.ignore.map(parseIgnoreRule);
  return findings.map((f) => {
    if (f.tier !== 'declared' && f.tier !== 'undeclared' && f.tier !== 'added') return f;
    // A whole-resource `added` finding has an empty path, so omit the `.<path>` suffix:
    // the rule target is then just the id, matching ignoreRuleFor's empty-path form
    // (a trailing dot would only match via the parent-segment fallback — fragile).
    const suffix = f.path ? `.${f.path}` : '';
    const targets = [`${f.logicalId}${suffix}`];
    if (f.constructPath) {
      // The within-stack path is what the report shows and what `ignoreRuleFor` now writes;
      // the FULL construct path is kept too so rules authored before the strip (or a
      // Stage's full `dev-main/AuroraDB/...` form) still match. When there is no stack
      // prefix to strip, both are identical — a harmless duplicate (`some` short-circuits).
      targets.push(`${withinStackPath(f.constructPath, stackName)}${suffix}`);
      targets.push(`${f.constructPath}${suffix}`);
    }
    const hit = rules.find(
      (r) =>
        (r.stackGlob === undefined || matchesGlob(r.stackGlob, stackName)) &&
        (r.accountGlob === undefined || matchesGlob(r.accountGlob, accountId)) &&
        (r.regionGlob === undefined || matchesGlob(r.regionGlob, region)) &&
        targets.some((t) => pathMatches(r.pathPattern, t))
    );
    if (!hit) return f;
    // Clear the `unrecorded` flag (set by applyBaseline for a not-yet-recorded
    // undeclared/added value): an `ignored` finding is a DECIDED value — the user told
    // cdkrd to STOP reporting it — so it must not still surface under `[Potential Drift]`
    // nor nag "run cdkrd record" (report/stack-actions filter that section by the FLAG,
    // not the tier). This upholds the `record` vs `ignore` invariant (ignore stops
    // watching). The exit code was always safe (ignored is not a drift tier); this fixes
    // the spurious reporting that defeated the purpose of `ignore`.
    const { unrecorded: _unrecorded, ...rest } = f;
    return { ...rest, tier: 'ignored', note: `ignored by config rule "${hit.raw}"` };
  });
}
