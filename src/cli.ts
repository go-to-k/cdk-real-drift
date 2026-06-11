#!/usr/bin/env node
// cdk-real-drift CLI entry. Dispatches: check | accept | init (+ help/version).
// Detect-only — no command writes to AWS (accept/init write only the baseline FILE).
import { readFileSync } from 'node:fs';
import { runAccept } from './commands/accept.js';
import { runCheck } from './commands/check.js';

const HELP = `cdkrd — drift detection for AWS CDK/CloudFormation, including UNDECLARED
properties that 'cdk drift' / CloudFormation drift never see. No AWS Config needed.

USAGE
  cdkrd check  <stack>... | --all   detect drift (read-only)
  cdkrd accept <stack>... | --all   bless current state into the baseline file
  cdkrd init   <stack>              first-time baseline (alias of accept)

OPTIONS
  --region <r>                AWS region (or $AWS_REGION / $AWS_DEFAULT_REGION)
  --app <cmd|cdk.out>         CDK app command or pre-synthesized assembly dir
                              (or $CDKRD_APP / cdk.json "app") — enables stack
                              auto-discovery + construct-path output
  -c, --context key=value     context for synth (repeatable; cdk.json is the base)
  --json                      machine-readable output
  --fail-on declared|undeclared   which tier sets exit 1 (default: undeclared = both)
  --show-all                  inventory mode: show ALL current undeclared state
                              (not just changes since accept)
  --all                       all deployed stacks in the region
  --yes, -y                   skip the baseline-overwrite notice (accept)
  --help, -h    --version, -v

EXIT CODES
  0 = clean   1 = drift detected   2 = error

The baseline lives at .cdkrd/<stack>.<region>.json — commit it; review its diff in PRs.`;

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(version());
    return 0;
  }
  switch (cmd) {
    case 'check':
      return runCheck(rest);
    case 'accept':
    case 'init': // init is accept's first-run alias
      return runAccept(rest);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const msg = (e as { message?: string })?.message ?? String(e);
    if (/credential|could not load cred|security token/i.test(msg)) {
      console.error(
        'error: no AWS credentials available. Configure them (aws configure / AWS_PROFILE / env vars) and retry.'
      );
    } else if (/stack/i.test(msg) && /(does not exist|ValidationError)/i.test(msg)) {
      console.error(
        'error: stack not found in this account/region. Check the stack name and --region.'
      );
    } else if (/AccessDenied|not authorized/i.test(msg)) {
      console.error(`error: access denied — ${msg}`);
    } else {
      console.error(`error: ${msg}`);
    }
    process.exit(2);
  });
