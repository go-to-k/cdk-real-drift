// Tiny shared CLI arg parser (no dependency).
import type { FailOn } from './report/report.js';

// The complete known-option surface. parseCommonArgs is shared by all three
// verbs, so verb-specific flags (--dry-run) are accepted here and interpreted
// by the verb. Anything NOT listed is a fail-fast error — a typo'd flag must
// never silently turn its value into a positional stack name (cdkrd has an
// AWS-mutating verb, so a misparse can target the wrong stacks).
const VALUE_FLAGS = new Set([
  '--region',
  '--profile',
  '--fail-on',
  '--app',
  '-a',
  '-c',
  '--context',
]);
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--show-all',
  '--yes',
  '-y',
  '--pre-deploy',
  '--dry-run',
  '--remove-unaccepted',
  '--verbose',
  '-v',
  '--no-interactive',
  '--fail',
]);

export interface CommonArgs {
  stackNames: string[]; // positional stack names (may be empty → all stacks the CDK app defines)
  region: string | undefined; // resolved region (no silent default — caller errors if absent)
  profile: string | undefined; // AWS profile (--profile or $AWS_PROFILE)
  app: string | undefined; // CDK app command OR pre-synthesized cloud-assembly dir
  context: Record<string, string>; // -c/--context key=value overrides for synth (cdk.json is the base layer)
  json: boolean;
  failOn: FailOn;
  showAll: boolean; // inventory mode: ignore baseline, show ALL undeclared values
  yes: boolean;
  preDeploy: boolean; // compare live vs the LOCAL synth template (drift your next deploy would clobber)
  // (check) automation mode, following the `cdk diff --fail` / `cdk drift --fail`
  // convention (R53): drift sets exit 1 and prompts are suppressed. Without it,
  // check REPORTS drift but exits 0 (report-only). Passing --fail-on <tier>
  // implies --fail (selecting which tiers fail only makes sense in fail mode).
  fail: boolean;
  removeUnaccepted: boolean; // (revert) opt in to REMOVING undeclared drift on a stack with no baseline
  verbose: boolean; // (check) expand informational tiers / (revert) the NOT-revertable summary to full lists
  noInteractive: boolean; // suppress all prompts; required-decision prompts then error instead of prompting
}

/**
 * Whether prompts may be shown: only in a real TTY AND when --no-interactive was not
 * passed. The single source of truth — command code threads this in rather than reading
 * `process.stdin.isTTY` directly. Optional prompts skip when false; required-decision
 * prompts error (exit 2) when false.
 */
export function isInteractive(a: CommonArgs): boolean {
  return Boolean(process.stdin.isTTY) && !a.noInteractive;
}

export function parseCommonArgs(args: string[]): CommonArgs {
  const values: Record<string, string> = {}; // canonical value-flag → its (last) value
  const found = new Set<string>(); // boolean flags seen
  const stackNames: string[] = [];
  const context: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (!a.startsWith('-')) {
      stackNames.push(a);
      continue;
    }
    // Accept `--flag=value` (and `-a=value`) like the cdk CLI / yargs do. Split on
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
        // a following token that is itself a flag is NOT a value (catches `--region --json`)
        if (next === undefined || next.startsWith('-')) {
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
    throw new Error(`unknown option "${a}" — see cdkrd --help`);
  }

  // Validate enumerated values during parse so a typo (`--fail-on declarred`) is a
  // loud error, not a silent fall-through to the `undeclared` default.
  const failOnRaw = values['--fail-on'];
  if (failOnRaw !== undefined && failOnRaw !== 'declared' && failOnRaw !== 'undeclared') {
    throw new Error(
      `--fail-on expects "declared" or "undeclared", got "${failOnRaw}" — see cdkrd --help`
    );
  }

  const has = (flag: string): boolean => found.has(flag);
  return {
    stackNames,
    context,
    region: values['--region'] ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    profile: values['--profile'] ?? process.env.AWS_PROFILE,
    // -a/--app > CDKRD_APP env (cdk.json "app" fallback resolved in the synth layer)
    app: values['--app'] ?? process.env.CDKRD_APP,
    json: has('--json'),
    failOn: failOnRaw === 'declared' ? 'declared' : 'undeclared',
    fail: has('--fail') || failOnRaw !== undefined, // --fail-on implies fail mode
    showAll: has('--show-all'),
    yes: has('--yes') || has('-y'),
    preDeploy: has('--pre-deploy'),
    removeUnaccepted: has('--remove-unaccepted'),
    verbose: has('--verbose') || has('-v'),
    noInteractive: has('--no-interactive'),
  };
}
