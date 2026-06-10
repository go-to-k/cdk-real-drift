#!/usr/bin/env node
// cdkdrift CLI entry. Dispatches: check | accept | init.
// Detect-only MVP — no command writes to AWS (accept writes only the baseline FILE).
import { runCheck } from './commands/check.js';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'check':
      return runCheck(rest);
    case 'accept':
    case 'init':
      // TODO(phase2): baseline write commands
      console.error(`'${cmd}' not implemented yet`);
      return 2;
    default:
      console.error('usage: cdkdrift <check|accept|init> <stack> [--region r] [--pre-deploy] [--fail-on tier] [--json]');
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
