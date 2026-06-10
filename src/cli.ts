#!/usr/bin/env node
import { runAccept } from "./commands/accept.js";
// cdk-real-drift CLI entry. Dispatches: check | accept | init.
// Detect-only — no command writes to AWS (accept/init write only the baseline FILE).
import { runCheck } from "./commands/check.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "check":
      return runCheck(rest);
    case "accept":
    case "init": // init is accept's first-run alias
      return runAccept(rest);
    default:
      console.error("usage: cdkrd <check|accept|init> <stack> [--region r] [--json] [--fail-on declared|undeclared] [--no-baseline]");
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const msg = (e as { message?: string })?.message ?? String(e);
    if (/credential|could not load cred|security token/i.test(msg)) {
      console.error("error: no AWS credentials available. Configure them (aws configure / AWS_PROFILE / env vars) and retry.");
    } else if (/stack/i.test(msg) && /(does not exist|ValidationError)/i.test(msg)) {
      console.error("error: stack not found in this account/region. Check the stack name and --region.");
    } else if (/AccessDenied|not authorized/i.test(msg)) {
      console.error(`error: access denied — ${msg}`);
    } else {
      console.error(`error: ${msg}`);
    }
    process.exit(2);
  });
