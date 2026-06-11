// Tiny shared CLI arg parser (no dependency).
import type { FailOn } from './report/report.js';

const VALUE_FLAGS = new Set(['--region', '--profile', '--fail-on', '--app', '-c', '--context']);

export interface CommonArgs {
  stackNames: string[]; // positional stack names (may be empty: --all or synth-discovery)
  region: string | undefined; // resolved region (no silent default — caller errors if absent)
  profile: string | undefined; // AWS profile (--profile or $AWS_PROFILE)
  app: string | undefined; // CDK app command OR pre-synthesized cloud-assembly dir
  context: Record<string, string>; // -c/--context key=value overrides for synth (cdk.json is the base layer)
  json: boolean;
  failOn: FailOn;
  showAll: boolean; // inventory mode: ignore baseline, show ALL undeclared values
  all: boolean; // every deployed stack in the region
  yes: boolean;
}

export function parseCommonArgs(args: string[]): CommonArgs {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  // positionals = tokens that are neither a flag nor the value following a value-flag;
  // collect repeatable -c/--context key=value overrides along the way
  const stackNames: string[] = [];
  const context: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('-')) {
      if ((a === '-c' || a === '--context') && i + 1 < args.length) {
        const kv = args[i + 1] ?? '';
        const eq = kv.indexOf('=');
        if (eq > 0) context[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      if (VALUE_FLAGS.has(a)) i++; // skip its value
      continue;
    }
    stackNames.push(a);
  }

  return {
    stackNames,
    context,
    region: get('--region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    profile: get('--profile') ?? process.env.AWS_PROFILE,
    // --app > CDKRD_APP env (cdk.json "app" fallback resolved in the synth layer)
    app: get('--app') ?? process.env.CDKRD_APP,
    json: has('--json'),
    failOn: get('--fail-on') === 'declared' ? 'declared' : 'undeclared',
    showAll: has('--show-all'),
    all: has('--all'),
    yes: has('--yes') || has('-y'),
  };
}
