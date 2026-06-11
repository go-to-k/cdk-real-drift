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
  '--remove-unblessed',
  '--verbose',
  '-v',
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
  removeUnblessed: boolean; // (revert) opt in to REMOVING undeclared drift on a stack with no baseline
  verbose: boolean; // (check) expand informational tiers (readGap/unresolved/skipped) to full lists
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
    if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      // a following token that is itself a flag is NOT a value (catches `--region --json`)
      if (v === undefined || v.startsWith('-')) {
        throw new Error(`option "${a}" requires a value — see cdkrd --help`);
      }
      if (a === '-c' || a === '--context') {
        const eq = v.indexOf('=');
        if (eq <= 0) {
          throw new Error(`option "${a}" expects key=value, got "${v}" — see cdkrd --help`);
        }
        context[v.slice(0, eq)] = v.slice(eq + 1);
      } else {
        values[a === '-a' ? '--app' : a] = v;
      }
      i++; // consume the value
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      found.add(a);
      continue;
    }
    throw new Error(`unknown option "${a}" — see cdkrd --help`);
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
    failOn: values['--fail-on'] === 'declared' ? 'declared' : 'undeclared',
    showAll: has('--show-all'),
    yes: has('--yes') || has('-y'),
    preDeploy: has('--pre-deploy'),
    removeUnblessed: has('--remove-unblessed'),
    verbose: has('--verbose') || has('-v'),
  };
}
