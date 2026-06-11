// Tiny shared CLI arg parser (no dependency).
import type { FailOn } from './report/report.js';

const VALUE_FLAGS = new Set(['--region', '--fail-on']);

export interface CommonArgs {
  stackNames: string[]; // positional stack names (may be empty when --all)
  region: string;
  json: boolean;
  failOn: FailOn;
  noBaseline: boolean;
  all: boolean;
  yes: boolean;
}

export function parseCommonArgs(args: string[]): CommonArgs {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  // positionals = tokens that are neither a flag nor the value following a value-flag
  const stackNames: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++; // skip its value
      continue;
    }
    stackNames.push(a);
  }

  return {
    stackNames,
    region: get('--region') ?? process.env.AWS_REGION ?? 'us-east-1',
    json: has('--json'),
    failOn: get('--fail-on') === 'declared' ? 'declared' : 'undeclared',
    noBaseline: has('--no-baseline'),
    all: has('--all'),
    yes: has('--yes') || has('-y'),
  };
}
