#!/usr/bin/env node
// cdk-real-drift CLI entry. Dispatches: check | record | ignore | revert (+ help/version).
// check/record/ignore never write to AWS (record writes only the baseline FILE; ignore
// writes only .cdkrd/ignore.yaml); revert is the one AWS-mutating command.
import { readFileSync } from 'node:fs';
import { flushAndExit } from './exit.js';
import { runRecord } from './commands/record.js';
import { runIgnore } from './commands/ignore.js';
import { runCheck } from './commands/check.js';
import { runRevert } from './commands/revert.js';

const HELP = `cdkrd — drift detection + revert for AWS CDK, including UNDECLARED
properties that 'cdk drift' / CloudFormation drift detection never see.

USAGE
  cdkrd check  [<stack>...]   detect drift (read-only)
  cdkrd record [<stack>...]   snapshot current undeclared state + out-of-band added
                              resources into the baseline — KEEPS watching
                              (re-surfaces if the value/resource changes)
  cdkrd ignore [<stack>...]   stop reporting the chosen drift (writes ignore.yaml)
                              — STOPS watching (declared, undeclared, or added)
  cdkrd revert [<stack>...]   write the desired value back to AWS (confirms)

  \`cdkrd check\` is the entry point: run it and act from its prompt — it
  establishes the first baseline and offers record / revert / ignore inline on
  whatever it finds, so day to day you only run check. The standalone verbs above
  are the SAME actions for scripts / non-TTY / CI (with --yes); a human rarely
  needs them directly.

  cdkrd is CDK-only: it synthesizes the CDK app (--app / cdk.json, or a
  pre-synthesized cdk.out) to discover stacks. With no stack argument (or --all),
  every stack the app defines is targeted; a <stack> arg (exact or a *?-glob)
  selects among them. The drift comparison itself reads each stack's DEPLOYED
  template + live state from AWS.

OPTIONS
  --region <r>                AWS region (or $AWS_REGION / $AWS_DEFAULT_REGION);
                              CDK stacks with explicit env.region are auto-detected.
                              An env-agnostic stack with none of these falls back to
                              the active --profile's configured region (~/.aws/config)
  --profile <p>               AWS profile (or $AWS_PROFILE)
  -a, --app <cmd|cdk.out>     CDK app command or pre-synthesized assembly dir
                              (or $CDKRD_APP / cdk.json "app") — enables stack
                              auto-discovery + construct-path output
  -c, --context key=value     context for synth (repeatable; cdk.json is the base)
  --all                       target EVERY stack the app defines (the default when
                              no <stack> is named; overrides any positional names)
  --json                      machine-readable output
  --fail                      (check) exit 1 on drift + never prompt — for
                              scripts/CI (same convention as \`cdk diff --fail\`);
                              without it, check REPORTS drift but exits 0
  --strict                    (check) exit 1 when coverage is INCOMPLETE — any
                              resource skipped (unread) or a nested stack not
                              recursed into. A loud coverage warning always prints;
                              --strict makes it CI-failing. Orthogonal to --fail
  --show-all                  inventory mode: show ALL current undeclared state
                              (not just changes since record)
  --verbose                   (check) expand informational tiers / (revert) the
                              NOT-revertable summary to full per-finding lists
  --pre-deploy                (check) compare live state vs the LOCAL synth template
                              — the declared drift your next deploy would overwrite
  --undeclared-only           (check) undeclared drift only — pair cdkrd with
                              \`cdk drift\` / CFn drift detection for the declared side
  --declared-only             (check) declared drift vs the DEPLOYED template only
                              (undeclared tier skipped; baseline untouched)
  --dry-run                   (revert) print the plan; make no changes
  --wait[=DURATION]           (revert) on a transient "resource is mid-update" error
                              (e.g. RSLVR-00705) keep retrying until it settles, up to
                              DURATION (default 10m; e.g. --wait=5m, --wait=90s)
  --remove-unrecorded         (revert) REMOVE unrecorded values + DELETE unrecorded
                              added resources (never recorded; default: refuse —
                              record the ones that are right)
  --yes, -y                   skip the write confirm AND the op multiselect — apply the
                              FULL plan (revert) / skip the selection multiselect +
                              overwrite notice, record ALL (record) / ignore ALL shown
                              drift without the multiselect (ignore)
  --help, -h    --version, -v

  Automation: check --fail / record --yes / ignore --yes / revert --yes (or
  --dry-run); non-TTY runs never prompt.

EXIT CODES
  check:  0 = clean (or drift without --fail)   1 = drift (--fail) / incomplete coverage (--strict)   2 = error
  record: 0 = written   2 = error/refused
  ignore: 0 = rule(s) written / nothing to ignore   2 = error/refused
  revert: 0 = converged/aborted   1 = drift remains   2 = error/apply failure

The baseline lives at .cdkrd/baselines/<stack>.<accountId>.<region>.json — commit it; review
its diff in PRs. Ignore rules live in .cdkrd/ignore.yaml — also git-committed.`;

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
    case 'record':
      return runRecord(rest);
    case 'ignore':
      return runIgnore(rest);
    case 'revert':
      return runRevert(rest);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      return 2;
  }
}

const argv = process.argv.slice(2);
main(argv)
  .then((code) => flushAndExit(code))
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
    // A throw that escapes a verb BEFORE it could emit its JSON — e.g. parseCommonArgs
    // rejecting a bad flag at the top of run*, or check's --pre-deploy second synth — must
    // still leave --json stdout a single JSON.parse-able value (`[]`), never empty bytes.
    // The caught loadConfig/resolveStacks paths return a code (they don't reach here), so
    // this central guard and those per-verb emits are mutually exclusive. (#943, #989)
    if (argv.includes('--json')) console.log('[]');
    return flushAndExit(2);
  });
