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

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pid } from 'node:process';
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

// Decode an ignore.yaml buffer via the same BOM/UTF-16 sniff resolveApp gained for cdk.json
// (#1076) and the baseline reader got in #1137 — the config reader is the remaining sibling
// (#1291). A UTF-16 LE file (FF FE — Windows PowerShell 5.1's DEFAULT for `Out-File` / `>`)
// or UTF-16 BE (FE FF) decoded with Node's `readFile(…, 'utf8')` becomes NUL-interleaved
// mojibake that the YAML parser reads as a SINGLE scalar, so a perfectly valid mapping is
// mis-diagnosed as "must be a YAML mapping". A default TextDecoder consumes the BOM
// (`ignoreBOM` defaults to false), so a UTF-8 BOM (EF BB BF) is also stripped here — the
// yaml parser already tolerates a UTF-8 BOM, so this only makes the two paths agree; the
// UTF-16 cases are the ones Node's 'utf8' decode genuinely mangles.
//
// Beyond the BOM sniff (resolveApp's cdk.json only ever sees BOM-prefixed UTF-16), we also
// detect BOM-LESS UTF-16 from the NUL-interleaving the issue calls out: ignore.yaml is a
// hand-edited file, and some editors write UTF-16 without a BOM. UTF-16-LE ASCII-range text
// is `<byte> 00 <byte> 00 …` and UTF-16-BE is `00 <byte> 00 <byte> …`; a legitimate UTF-8
// ignore.yaml contains no NUL bytes at all, so a NUL at every odd (LE) or even (BE) index in
// the leading window is an unambiguous UTF-16 signal.
function looksUtf16(buf: Buffer, nulAtOddIndex: boolean): boolean {
  const n = Math.min(buf.length, 64);
  if (n < 2) return false;
  let pairs = 0;
  for (let i = nulAtOddIndex ? 1 : 0; i < n; i += 2) {
    if (buf[i] !== 0x00) return false;
    pairs++;
  }
  return pairs > 0;
}

function decodeConfig(buf: Buffer): string {
  const encoding =
    buf[0] === 0xff && buf[1] === 0xfe
      ? 'utf-16le'
      : buf[0] === 0xfe && buf[1] === 0xff
        ? 'utf-16be'
        : looksUtf16(buf, /* nulAtOddIndex (LE) */ true)
          ? 'utf-16le'
          : looksUtf16(buf, /* nulAtEvenIndex (BE) */ false)
            ? 'utf-16be'
            : 'utf-8';
  return new TextDecoder(encoding).decode(buf);
}

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
    // Read as a Buffer (no encoding) and decode via the BOM/UTF-16 sniff (#1291): a
    // Windows-authored UTF-16 file decoded as 'utf8' becomes mojibake the YAML parser
    // mis-reads as a single scalar, throwing the misleading "must be a YAML mapping" on a
    // file that IS a valid mapping. `decodeConfig` strips a BOM / handles UTF-16 like the
    // real `cdk` CLI does for cdk.json (resolveApp, #1076) and the baseline reader (#1137).
    raw = decodeConfig(await readFile(CONFIG_PATH));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ignore: [] };
    throw e;
  }
  return parseConfigRaw(raw);
}

/**
 * Validate-and-parse the decoded `.cdkrd/ignore.yaml` text into a `CdkrdConfig`. This is
 * loadConfig's body AFTER the read+decode, factored out so a caller that ALREADY holds the
 * raw bytes (addIgnoreRules' pre-write `existingRaw`) can derive the same validated config
 * from the SAME snapshot — without a second `readFile`. Sharing one snapshot between the
 * write basis and the dedupe basis is the #1290 fix: a peer rule that landed on disk between
 * two separate reads would otherwise be in the dedupe basis but not the write basis, and get
 * clobbered. Applies every guard loadConfig applied on read (syntax errors, alias/anchor,
 * non-mapping, unknown top-level key, `ignore` typed as an array, per-entry validation).
 */
export function parseConfigRaw(raw: string): CdkrdConfig {
  let parsed: unknown;
  // parseDocument collects syntax problems in `doc.errors` (it does NOT throw), so check
  // them explicitly to fail fast. YAML is a JSON superset, so this also reads a legacy
  // all-JSON ignore.yaml.
  const doc = parseDocument(raw, { prettyErrors: true });
  const [firstError] = doc.errors;
  if (firstError !== undefined) {
    // `prettyErrors` renders each `doc.errors[i].message` with a line/column and a code
    // (e.g. `MULTILINE_IMPLICIT_KEY`, `DUPLICATE_KEY`). Surfacing the FIRST diagnostic —
    // not just the bare "is not valid YAML" — is the whole actionability fix (#1049): the
    // #1 real-world damage to this shared merge-magnet file is an unresolved git conflict
    // marker (`<<<<<<< HEAD`), which yields "Implicit keys need to be on a single line at
    // line N, column M". Without the line/column the user can't find the damage. Append a
    // count when there is more than one so they know the first is not the only one.
    const more = doc.errors.length > 1 ? ` (+${doc.errors.length - 1} more)` : '';
    throw new Error(`${CONFIG_PATH} is not valid YAML: ${firstError.message}${more}`);
  }
  try {
    parsed = doc.toJS();
  } catch (e) {
    // A file can collect ZERO `doc.errors` yet still fail here — the classic case is an
    // unquoted glob whose first char is a YAML sigil: `- path: *.DesiredCount` parses the
    // `*` as an ALIAS reference, so `toJS()` throws "Unresolved alias ...". Surface the
    // message (was swallowed) and, for the alias/anchor case, add the documented remedy:
    // quote a `path` that starts with `*` / `?` so it is a literal glob, not YAML syntax.
    const msg = (e as Error).message;
    const hint = /alias|anchor/i.test(msg)
      ? ' — a glob path starting with "*" or "?" must be quoted (e.g. `path: "*.DesiredCount"`) so it is read as a literal, not YAML alias/anchor syntax'
      : '';
    throw new Error(`${CONFIG_PATH} is not valid YAML: ${msg}${hint}`);
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
 * True when `path` is an all-wildcard universal matcher — a pattern with NO literal
 * segment content, made only of the glob metachars (`*` / `?`) and the segment
 * separators (`.` `[` `]` `/`). Examples: `*`, `**`, `*.*`, `?`, a slash-joined
 * `*` pair, `*.*[*]`.
 * Such a rule ignores EVERY finding (issue #842), so the validator rejects it the same
 * way it rejects an empty path. A pattern with even one literal character (`Foo*`,
 * `*.DesiredCount`, `MyApi/*`) is NOT universal and is allowed. Exported for tests.
 */
export function isUniversalPath(path: string): boolean {
  // Strip every wildcard and separator; if anything is left, the path names a literal
  // segment and is a real scope. If NOTHING is left, it is pure wildcards/separators —
  // a universal matcher. (A path that is only separators like `.` has no wildcard, so it
  // matches nothing rather than everything, but it is an equally useless no-op and the
  // same "name a literal segment" guidance applies, so we reject it here too.)
  return path.replace(/[*?.[\]/]/g, '') === '';
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
  if (isUniversalPath(obj.path))
    // The mirror-image catastrophe of the empty path: a path made ONLY of wildcards and
    // segment separators (`*`, `**`, `*.*`, `?`, `*/*`, `*.*[*]`, …) has no literal
    // content, so — via `pathMatches`'s per-segment glob AND its ancestor walk — it
    // silences EVERY declared / undeclared / added finding, not the one property the
    // author meant to suppress (issue #842). That is a foot-gun the size of the whole
    // report, so reject it as loudly as the empty path; a real rule must name at least
    // one literal path segment to scope what it ignores.
    throw new Error(
      `${at}: "path" must not be an all-wildcard pattern ("${obj.path}") — it would ignore every finding; name at least one literal path segment`
    );
  for (const k of ['stack', 'account', 'region'] as const) {
    if (obj[k] !== undefined && typeof obj[k] !== 'string')
      throw new Error(`${at}: "${k}" must be a string`);
    if (obj[k] === '')
      // a present-but-empty scope axis matches NOTHING (the glob `^$` never matches a
      // real stack/account/region), so the whole rule silently suppresses nothing — the
      // same silent no-op trap as an empty `path`. Reject it loudly; omit the key to
      // leave the axis unscoped (match-all).
      throw new Error(`${at}: "${k}" must not be empty (omit it to leave the axis unscoped)`);
  }
}

/**
 * The exact ignore rule the `ignore` verb (and check's inline ignore) writes for a
 * finding. The rule is STAMPED with the current stack / account / region scope (the same
 * three identity axes a baseline file is keyed on), so ignoring a within-stack path on one
 * stack does NOT leak to a same-named twin stack in another account/region — an unscoped
 * `{ path }` was match-all, silently silencing the identical path everywhere (issue #757).
 * The literal identity values are valid exact globs; hand-widening to a `*` glob stays a
 * manual edit. A scope field is omitted only when genuinely unavailable (empty string).
 * Prefer the human-friendly `<constructPath>.<path>` for `path` when present (CDK stacks):
 * it is what `cdk-local` targets on and readable in the git-committed config diff. The
 * construct path is written WITHIN the stack (the stack/Stage prefix stripped, given
 * `stackName`) so it is byte-identical to what the report prints for the finding — copy
 * what you see. Falls back to `<logicalId>.<path>`, ALWAYS present (the CloudFormation
 * key) so a rule is writable even on a non-CDK / metadata-stripped stack. Pure + exported;
 * `applyIgnores` matches the within-stack path, the full construct path (older rules), AND
 * the logicalId, so every form works.
 *
 * EXCEPTION — an `added`-tier finding always keys on `logicalId`, NEVER constructPath
 * (issue #802). For an added child the constructPath is a display LABEL
 * (`<parent> ▸ <label>`, gather.ts) built from a NON-unique, human name — a Cognito
 * UserPoolClient's ClientName, an SNS subscription's `protocol endpoint` — so a rule
 * written against it silently ignores EVERY same-labelled added child under the parent,
 * present and future. The label can also carry glob metacharacters (an https endpoint's
 * `?query` turns the `?` into a wildcard). The logicalId form `<parent>/<CC-identifier>`
 * is the UNIQUE identity (and `applyIgnores` matches logicalId targets), so it is the only
 * safe thing to write. This is scoped to `added` only; declared/undeclared keep the
 * human-friendly constructPath, whose path IS unique.
 */
export function ignoreRuleFor(
  finding: Finding,
  stackName = '',
  accountId = '',
  region = ''
): IgnoreRuleObject {
  const withinStack =
    finding.constructPath && finding.tier !== 'added'
      ? withinStackPath(finding.constructPath, stackName)
      : finding.logicalId;
  // `withinStackPath` returns '' when the construct path is the stack root itself
  // (`'MyStack/'` -> ''); with an empty `finding.path` that would strip the id to '' and
  // yield `rule.path === ''` — the exact empty-path poison pill `loadConfig` rejects
  // (issue #991). Fall back to `logicalId` (the CloudFormation key, ALWAYS present and
  // non-empty) so the id — and thus the rule path — can never be empty.
  const id = withinStack || finding.logicalId;
  // A finding path can legitimately CONTAIN a literal `*` / `?`: an API Gateway
  // `MethodSettings[*]` bracket key (from `HttpMethod: '*'`), an S3 lifecycle `Id`
  // like `clean*tmp`, a free-form Glue/ECS map key. Written verbatim, the glob matcher
  // would reinterpret each `*` / `?` as a wildcard and silently widen the rule to every
  // sibling (issue #776). Escape them (and any pre-existing `\`) so the rule matches ONLY
  // the finding it came from — `escapeGlobLiterals` is the inverse of the grammar's
  // `\`-escape in glob-match.ts. Escape `\` FIRST so the `*` / `?` escapes we add are not
  // themselves re-escaped.
  const rawPath = finding.path ? `${id}.${finding.path}` : id;
  const rule: IgnoreRuleObject = { path: escapeGlobLiterals(rawPath) };
  // Only stamp a scope field when the value is actually known — an empty string would
  // write `stack: ""`, a glob that matches nothing (silently disabling the rule).
  if (stackName) rule.stack = stackName;
  if (accountId) rule.account = accountId;
  if (region) rule.region = region;
  return rule;
}

/**
 * Backslash-escape the glob metacharacters (`\`, `*`, `?`) in a literal path so the glob
 * matcher treats them as literals, not wildcards. The inverse of the `\`-escape grammar in
 * glob-match.ts. `\` is escaped FIRST so the `*` / `?` escapes we add are not re-escaped
 * (otherwise `\*` would become `\\*` = a literal `\` + a wildcard). Structural separators
 * (`.` `[` `]` `/`) are intentionally left alone — they are the rule's segment grammar, not
 * data. Exported for tests.
 */
export function escapeGlobLiterals(literal: string): string {
  return literal.replace(/\\/g, '\\\\').replace(/[*?]/g, '\\$&');
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
 * Atomically replace `dest` with `content` (same filesystem): write to a sibling temp file
 * in the SAME directory, then `rename` it over `dest`. `rename` is atomic on one filesystem,
 * so a concurrent reader (`loadConfig`) never observes a half-written file — it sees either
 * the old bytes or the new bytes in full, never a TRUNCATED-but-still-valid YAML (issue
 * #759): a crash/Ctrl-C mid-`writeFile` could otherwise leave e.g. a truncated bare-scalar
 * glob `path: Api` that OVER-matches, which `loadConfig` would accept silently. The temp file
 * MUST be a SIBLING (same dir) so the rename stays within one filesystem — a rename across
 * filesystems is not atomic (it degrades to copy+unlink). The pid + a monotonic counter keep
 * the temp name unique per concurrent writer so two racing processes don't clobber each
 * other's temp file. On any failure the temp file is cleaned up so it can't accumulate.
 */
let tmpCounter = 0;
async function atomicWrite(dest: string, content: string): Promise<void> {
  const tmp = `${dest}.${pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, dest);
  } catch (e) {
    // Best-effort cleanup of the orphaned temp file (rename may have already consumed it,
    // in which case unlink ENOENTs — ignore that and any other cleanup error, and rethrow
    // the ORIGINAL failure that matters).
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Append ignore rules to `.cdkrd/ignore.yaml` (cwd-relative), creating the file (and
 * the `.cdkrd/` dir) if absent. Idempotent: rules already present are reported, not
 * duplicated. Loads through `loadConfig` first so a malformed config fails fast rather
 * than being silently overwritten. Returns the path + what changed so the caller can
 * report it. The only mutating entry point for config (parallel to `writeBaseline`).
 *
 * The write is ATOMIC (tmp file + `rename`, see `atomicWrite`) so a crash mid-write can
 * never leave a truncated-but-valid config (#759). To narrow the read-merge-write race with
 * a concurrent `cdkrd` process, the on-disk config is RE-READ immediately before the write
 * and the incoming rules merged against THAT fresh state — so a rule another process
 * appended between our initial `loadConfig` and our write is preserved, not clobbered.
 * The re-read is a SINGLE snapshot: both the write basis (`existingRaw`, re-emitted with its
 * comments) and the dedupe basis (`parseConfigRaw(existingRaw)`) come from those same bytes,
 * so a peer rule on disk is BOTH carried forward AND deduped against — never in one but not
 * the other (#1290).
 */
export async function addIgnoreRules(
  newRules: IgnoreRuleObject[]
): Promise<{ path: string; added: IgnoreRuleObject[]; alreadyPresent: IgnoreRuleObject[] }> {
  const config = await loadConfig(); // validates first — a malformed file throws, not overwritten
  const firstPass = mergeIgnoreRules(config.ignore, newRules);
  // Re-validate the rules we are ABOUT to write with the SAME guards `loadConfig` applies
  // on read (`validateIgnoreEntry`: empty-path + `isUniversalPath` + typed keys). This is
  // the write-side twin of the read-side fail-fast: without it, a rule whose `path` is
  // empty (`""`) or an all-wildcard universal pattern (`"*/*"`, `"**"`) would be written
  // silently, then detonate (exit 2) on the NEXT `loadConfig` — which every verb calls —
  // permanently bricking the file, i.e. the user's own `ignore` silently disables the
  // tool (issue #991). Fail fast BEFORE writeFile so `ignore` can never write a poison
  // pill (also self-guards a hand-authored bad rule appended through the verb).
  firstPass.added.forEach((rule, i) => validateIgnoreEntry(rule, i));
  // Only touch disk when something actually changed — an all-already-present run leaves
  // the file (and its git status) untouched.
  if (firstPass.added.length === 0) {
    return { path: CONFIG_PATH, added: firstPass.added, alreadyPresent: firstPass.alreadyPresent };
  }
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  // Narrow the read-merge-write race (#759): RE-READ the file right before the write and
  // merge the requested rules against THAT fresh on-disk state. If a concurrent process
  // appended rules between our initial `loadConfig` and here, its rules are in `existingRaw`
  // and are carried forward (we append to them) instead of being clobbered by a write built
  // from the stale first read.
  let existingRaw: string | undefined;
  try {
    // Same BOM/UTF-16 decode as loadConfig (#1291): this raw text is re-parsed by
    // appendRulesToYaml to preserve the user's comments/layout, so it must be decoded the
    // same way — a UTF-16 file read as 'utf8' here would corrupt the append.
    existingRaw = decodeConfig(await readFile(CONFIG_PATH));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // Derive the dedupe basis from the SAME `existingRaw` bytes the write is built from —
  // `parseConfigRaw(existingRaw)`, NOT a second `loadConfig()` read (#1290). A separate
  // re-read could observe a peer's just-appended rule that `existingRaw` did not: the peer
  // rule would then be in the dedupe basis but absent from the write basis, so our rules
  // still count as new and we'd write `existingRaw + ours`, silently clobbering the peer's
  // rule that WAS on disk. One snapshot for both bases keeps the carried-forward claim true.
  const existingRules =
    existingRaw !== undefined && existingRaw.trim() !== ''
      ? parseConfigRaw(existingRaw).ignore
      : [];
  const { added, alreadyPresent } = mergeIgnoreRules(existingRules, newRules);
  if (added.length === 0) {
    // A concurrent writer already added every rule we wanted between our two reads — report
    // them as already-present and leave the file untouched.
    return { path: CONFIG_PATH, added, alreadyPresent };
  }
  await atomicWrite(CONFIG_PATH, appendRulesToYaml(existingRaw, added));
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
 * True when `pattern` matches `target` (= "<logicalId>.<path>" / a `/`-joined construct
 * path), either exactly or as a PARENT path: a rule "X.Policies" also ignores child paths
 * like "X.Policies.0.PolicyName" AND "X.Policies[MyPol].PolicyName" (so ignoring a
 * structured property covers its leaves, including array / identity-keyed elements), and a
 * rule "MyApi/Res" covers its whole construct-path subtree "MyApi/Res/Method.Prop".
 * Parent matching walks ancestors at each `.`, `[`, OR `/` boundary, combined with the glob.
 *
 * `wholeResource` marks an atomic, whole-resource target (an `added` finding — empty property
 * path, so the target is just `<parentLogicalId>/<CC-identifier>`). Such a target has NO
 * property subtree: everything after the FIRST `/` is the OPAQUE CC identifier — and it may
 * itself contain `.`, `[`, `|`, OR `/` (a Cognito ResourceServer URI identifier
 * `https://api.example.com/v2`, an ARN, a log-group name). None of those are property or
 * resource separators; they are DATA inside one atomic id, so the segment-bounded ancestor
 * walk below MUST NOT run — an intermediate `.` / `[` / `/`-prefix is a truncation of the
 * identifier that reaches a DIFFERENT sibling (`MyApi/a` swallowing `MyApi/a.b` or
 * `MyApi/a[0]` — #990; a LITERAL rule `.../api.example.com` swallowing the extended sibling
 * `.../api.example.com/v2` — #1061). Instead we test exactly two things, both with the
 * identifier treated ATOMICALLY (the UNBOUNDED `matchesGlob`, whose `*` / `?` span `/`, since
 * a `/` inside the identifier is data, not a boundary):
 *   1. the FULL target — a LITERAL rule (what `ignoreRuleFor` writes, metachars escaped) then
 *      matches ONLY its own exact id, never a `/`-extended sibling; a user-authored parent
 *      glob (`MyLb/*`) still spans the whole atomic identifier of a child; and
 *   2. the BARE PARENT logical id — the single segment BEFORE the first `/` — so a bare
 *      parent-RESOURCE rule (`MyLb`, issue #903) still covers a child whose id is an ARN full
 *      of `/`.
 */
function pathMatches(pattern: string, target: string, wholeResource = false): boolean {
  if (matchesPathGlob(pattern, target)) return true;
  if (wholeResource) {
    // Identifier is atomic — test the full target and the bare-parent prefix with the
    // unbounded glob (no walk into the identifier). See the doc comment (#903 / #990 / #1061).
    if (matchesGlob(pattern, target)) return true;
    const firstSlash = target.indexOf('/');
    return firstSlash > 0 && matchesGlob(pattern, target.slice(0, firstSlash));
  }
  // A rule on a PARENT property ignores its whole subtree — including array / identity-
  // keyed children whose path glues the index to its key inside ONE dot-segment
  // (`Policies[MyPol].PolicyName`, `Statement[0].Condition`, `Tags[env]`) AND deeper
  // construct-path descendants across `/` (`MyApi/Res/Method.Prop` under `MyApi/Res`, or
  // an `added` child whose id is an ARN full of `/`). Walk ancestor paths by trimming at
  // each `.`, `[`, OR `/` boundary, so a rule `X.Policies` covers `X.Policies[MyPol].Name`,
  // `X.Statement` covers `X.Statement[0].Condition`, and `MyApi/Res` covers its `/`-subtree
  // — symmetric with the `.` case (the dot/bracket-only split silently failed across `/`).
  // (A whole-resource `added` target returns above; this walk is property-subtree only.)
  let t = target;
  while (true) {
    const cut = Math.max(t.lastIndexOf('.'), t.lastIndexOf('['), t.lastIndexOf('/'));
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
    // An `added` finding is an atomic whole resource (`<parent>/<CC-identifier>`, empty
    // path): its identifier's `.` / `[` are data, not a property subtree, so the ancestor
    // walk must trim ONLY at `/` (parent-resource coverage) — otherwise a rule for one
    // added resource over-suppresses a sibling whose id is this one extended by `.`/`[`
    // (`P/a` swallowing `P/a.b.c`, `P/a[0]`) — a silent detection hole in `added` (#990).
    const wholeResource = f.tier === 'added';
    const targets = [`${f.logicalId}${suffix}`];
    if (f.constructPath) {
      // The within-stack path is what the report shows and what `ignoreRuleFor` now writes;
      // the FULL construct path is kept too so rules authored before the strip (or a
      // Stage's full `my-app/Rds/...` form) still match. When there is no stack
      // prefix to strip, both are identical — a harmless duplicate (`some` short-circuits).
      targets.push(`${withinStackPath(f.constructPath, stackName)}${suffix}`);
      targets.push(`${f.constructPath}${suffix}`);
    }
    const hit = rules.find(
      (r) =>
        (r.stackGlob === undefined || matchesGlob(r.stackGlob, stackName)) &&
        (r.accountGlob === undefined || matchesGlob(r.accountGlob, accountId)) &&
        (r.regionGlob === undefined || matchesGlob(r.regionGlob, region)) &&
        targets.some((t) => pathMatches(r.pathPattern, t, wholeResource))
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
