#!/usr/bin/env node
// cdkdrift CLI entry. Dispatches: check | accept | init.
// Detect-only — no command writes to AWS (accept/init write only the baseline FILE).
import { runCheck } from './commands/check.js';
import { runAccept } from './commands/accept.js';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'check':
      return runCheck(rest);
    case 'accept':
    case 'init': // init is accept's first-run alias
      return runAccept(rest);
    default:
      console.error('usage: cdkdrift <check|accept|init> <stack> [--region r] [--json] [--fail-on declared|undeclared] [--no-baseline]');
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
