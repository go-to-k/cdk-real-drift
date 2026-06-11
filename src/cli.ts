#!/usr/bin/env node
// cdk-real-drift CLI entry. Dispatches: check | accept | revert (+ help/version).
// check/accept never write to AWS (accept writes only the baseline FILE);
// revert is the one AWS-mutating command.
import { readFileSync } from 'node:fs';
import { runAccept } from './commands/accept.js';
import { runCheck } from './commands/check.js';
import { runRevert } from './commands/revert.js';

const HELP = `cdkrd — drift detection + revert for AWS CDK, including UNDECLARED
properties that 'cdk drift' / CloudFormation drift detection never see.

USAGE
  cdkrd check  [<stack>...]   detect drift (read-only)
  cdkrd accept [<stack>...]   bless current state into the baseline file
  cdkrd revert [<stack>...]   write the desired value back to AWS (confirms)

  cdkrd is CDK-only: it synthesizes the CDK app (--app / cdk.json, or a
  pre-synthesized cdk.out) to discover stacks. With no stack argument, every
  stack the app defines is targeted; a <stack> arg (exact or a *?-glob) selects
  among them. The drift comparison itself reads each stack's DEPLOYED template +
  live state from AWS.

OPTIONS
  --region <r>                AWS region (or $AWS_REGION / $AWS_DEFAULT_REGION);
                              CDK stacks with explicit env.region are auto-detected
  --profile <p>               AWS profile (or $AWS_PROFILE)
  -a, --app <cmd|cdk.out>     CDK app command or pre-synthesized assembly dir
                              (or $CDKRD_APP / cdk.json "app") — enables stack
                              auto-discovery + construct-path output
  -c, --context key=value     context for synth (repeatable; cdk.json is the base)
  --json                      machine-readable output
  --fail-on declared|undeclared   which tier sets exit 1 (default: undeclared = both)
  --show-all                  inventory mode: show ALL current undeclared state
                              (not just changes since accept)
  --pre-deploy                (check) compare live state vs the LOCAL synth template
                              — the declared drift your next deploy would overwrite
  --dry-run                   (revert) print the plan; make no changes
  --remove-unblessed          (revert) on a stack with NO baseline, REMOVE undeclared
                              drift (default: refuse — run \`cdkrd accept\` first)
  --yes, -y                   skip confirmation (revert) / overwrite notice (accept)
  --help, -h    --version, -v

EXIT CODES
  0 = clean   1 = drift detected   2 = error

The baseline lives at .cdkrd/<stack>.<accountId>.<region>.json — commit it; review its diff in PRs.`;

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
  // `cdkrd <verb> --help` — unknown options now fail fast, so route help here
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case 'check':
      return runCheck(rest);
    case 'accept':
      return runAccept(rest);
    case 'revert':
      return runRevert(rest);
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
