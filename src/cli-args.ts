// Tiny shared CLI arg parser (no dependency).
import { DEFAULT_WAIT_MS, parseDurationMs } from './revert/transient.js';

// The complete known-option surface. parseCommonArgs is shared by all three
// verbs, so verb-specific flags (--dry-run) are recorded here and interpreted
// by the verb. Anything NOT listed is a fail-fast error — a typo'd flag must
// never silently turn its value into a positional stack name (cdkrd has an
// AWS-mutating verb, so a misparse can target the wrong stacks).
const VALUE_FLAGS = new Set(['--region', '--profile', '--app', '-a', '-c', '--context']);
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--fail',
  '--show-all',
  '--yes',
  '-y',
  '--pre-deploy',
  '--undeclared-only',
  '--declared-only',
  '--dry-run',
  '--remove-unrecorded',
  '--verbose',
  '-v',
  '--strict',
  '--all',
]);

export interface CommonArgs {
  stackNames: string[]; // positional stack names (may be empty → all stacks the CDK app defines)
  all: boolean; // explicitly target EVERY stack the app defines (the default when no name is given); overrides any positional names
  region: string | undefined; // resolved region (no silent default — caller errors if absent)
  profile: string | undefined; // AWS profile (--profile or $AWS_PROFILE)
  app: string | undefined; // CDK app command OR pre-synthesized cloud-assembly dir
  context: Record<string, string>; // -c/--context key=value overrides for synth (cdk.json is the base layer)
  json: boolean;
  showAll: boolean; // inventory mode: ignore baseline, show ALL undeclared values
  yes: boolean;
  preDeploy: boolean; // compare live vs the LOCAL synth template (drift your next deploy would clobber)
  // (check) scope flags (R59) — at most ONE of --pre-deploy / --declared-only /
  // --undeclared-only; the parser rejects combinations.
  // --undeclared-only skips the declared-side comparison entirely — for pairing
  // cdkrd with `cdk drift` / CFn drift detection, which already own declared
  // drift. Deleted resources still report (a gone resource has no undeclared
  // values to check; silence would be a lie).
  undeclaredOnly: boolean;
  // --declared-only skips the undeclared tier (baseline untouched): declared
  // drift vs the DEPLOYED template only. NOT the same as --pre-deploy, which
  // compares against the LOCAL SYNTH template (a different question: what would
  // my next deploy clobber).
  declaredOnly: boolean;
  // (check) automation mode, following the `cdk diff --fail` / `cdk drift --fail`
  // convention (R53): drift sets exit 1 and prompts are suppressed. Without it,
  // check REPORTS drift but exits 0 (report-only).
  fail: boolean;
  // (check) coverage axis, ORTHOGONAL to --fail (which is about drift): make a run
  // whose coverage was incomplete — any resource SKIPPED (CC-unsupported + no SDK
  // override, a read error, a missing physical id) or any nested stack not recursed
  // into — exit non-zero. A loud coverage `warning:` always prints regardless of this
  // flag; --strict additionally turns that gap into a CI-failing exit. Does not change
  // the --fail default (a transient throttle should not silently start failing CI).
  strict: boolean;
  removeUnrecorded: boolean; // (revert) opt in to REMOVING undeclared drift on a stack with no baseline
  verbose: boolean; // (check) expand informational tiers / (revert) the NOT-revertable summary to full lists
  // (revert) `--wait[=DURATION]`: block on a TRANSIENT "resource is mid-update" failure
  // (RSLVR-00705 & friends), retrying until the resource settles instead of stopping at
  // the short default backoff. undefined = not requested (default short backoff → hint);
  // a number = the wait budget in ms (bare `--wait` = DEFAULT_WAIT_MS). Issue #467.
  waitMs: number | undefined;
}

/**
 * Whether prompts may be shown: only in a real TTY. Non-interactive now simply means
 * non-TTY (real CI/cron/pipes). The single source of truth — command code threads this
 * in rather than reading `process.stdin.isTTY` directly. Optional prompts skip when
 * false; required-decision prompts error (exit 2) when false.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

export function parseCommonArgs(args: string[]): CommonArgs {
  const values: Record<string, string> = {}; // canonical value-flag → its (last) value
  const found = new Set<string>(); // boolean flags seen
  const stackNames: string[] = [];
  const context: Record<string, string> = {};
  let waitMs: number | undefined; // (revert) --wait[=DURATION]; undefined = not requested

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (!a.startsWith('-')) {
      stackNames.push(a);
      continue;
    }
    // Record `--flag=value` (and `-a=value`) like the cdk CLI / yargs do. Split on
    // the FIRST '=' only so `--context=env=prod` keeps the value "env=prod" whole.
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = eq > 0 ? a.slice(eq + 1) : undefined;

    if (VALUE_FLAGS.has(flag)) {
      let v: string;
      if (inlineValue !== undefined) {
        // `--app=` with nothing after the '=' is still a missing value
        if (inlineValue === '') {
          throw new Error(`option "${flag}" requires a value — see cdkrd --help`);
        }
        v = inlineValue;
      } else {
        const next = args[i + 1];
        // a following token that is itself a flag is NOT a value (catches `--region --json`).
        // An empty token (`--region ""`) is also "no value": accepting it would let `''`
        // shadow the env fallback (`?? process.env.AWS_REGION` does not fire on `''`),
        // and the inline form `--region=` already rejects empty — stay consistent.
        if (next === undefined || next === '' || next.startsWith('-')) {
          throw new Error(`option "${flag}" requires a value — see cdkrd --help`);
        }
        v = next;
        i++; // consume the value
      }
      if (flag === '-c' || flag === '--context') {
        const kvEq = v.indexOf('=');
        if (kvEq <= 0) {
          throw new Error(`option "${flag}" expects key=value, got "${v}" — see cdkrd --help`);
        }
        context[v.slice(0, kvEq)] = v.slice(kvEq + 1);
      } else {
        values[flag === '-a' ? '--app' : flag] = v;
      }
      continue;
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      // a boolean flag takes no value: `--json=true` is a mistake, not a stack name
      if (inlineValue !== undefined) {
        throw new Error(`option "${flag}" does not take a value — see cdkrd --help`);
      }
      found.add(flag);
      continue;
    }
    // `--wait` (revert): optional value, INLINE form only (`--wait` or `--wait=5m`). A
    // following separate token is deliberately NOT consumed — `--wait 5m` would be
    // ambiguous with a positional stack name, the exact misparse this parser guards
    // against for an AWS-mutating verb.
    if (flag === '--wait') {
      waitMs = inlineValue === undefined ? DEFAULT_WAIT_MS : parseDurationMs(inlineValue);
      continue;
    }
    throw new Error(`unknown option "${a}" — see cdkrd --help`);
  }

  const has = (flag: string): boolean => found.has(flag);
  // scope flags select WHICH comparison runs — more than one is contradictory
  // (--pre-deploy + --undeclared-only would compare nothing) or redundant
  // (--pre-deploy is already declared-side). Reject at parse.
  const scopes = ['--pre-deploy', '--declared-only', '--undeclared-only'].filter(has);
  if (scopes.length > 1) {
    throw new Error(`${scopes.join(' and ')} are mutually exclusive — see cdkrd --help`);
  }
  return {
    stackNames,
    all: has('--all'),
    context,
    region: values['--region'] ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    profile: values['--profile'] ?? process.env.AWS_PROFILE,
    // -a/--app > CDKRD_APP env (cdk.json "app" fallback resolved in the synth layer)
    app: values['--app'] ?? process.env.CDKRD_APP,
    json: has('--json'),
    fail: has('--fail'),
    strict: has('--strict'),
    showAll: has('--show-all'),
    yes: has('--yes') || has('-y'),
    preDeploy: has('--pre-deploy'),
    undeclaredOnly: has('--undeclared-only'),
    declaredOnly: has('--declared-only'),
    removeUnrecorded: has('--remove-unrecorded'),
    verbose: has('--verbose') || has('-v'),
    waitMs,
  };
}
