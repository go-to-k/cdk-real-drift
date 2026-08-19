import { describe, expect, it } from 'vite-plus/test';
import config from '../vite.config.js';

/**
 * #1761 — `vp run check` aborted with exit 134 ("Vite+ panicked … failed printing to
 * stdout: Resource temporarily unavailable") on a tree with 0 lint/format ERRORS,
 * because the Rust oxc binary cannot write its large output to the NON-BLOCKING pipe
 * `vp run` gives a task. The fix redirects that output to a file and prints it only on
 * failure — the same workaround `.github/workflows/ci.yml` already applies.
 *
 * This guards the shape of the workaround: a "simplification" back to a bare
 * `vp check` re-introduces the abort, and dropping the unconditional `exit 1` would
 * make a REAL lint/format error exit 0 (a green gate on a red tree).
 */
describe('vite.config.ts: the `check` run-task avoids the Vite+ stdout panic (#1761)', () => {
  const command = (config as { run: { tasks: Record<string, { command: string }> } }).run.tasks
    .check.command;

  it('redirects `vp check` output to a file instead of the run-task pipe', () => {
    expect(command).toMatch(/vp check\s+>\S*vpcheck\.log\s+2>&1/);
    expect(command).not.toMatch(/^\s*vp check\s*$/);
  });

  it('keeps the log out of the working tree so `git add -A` cannot sweep it up', () => {
    expect(command).toContain('node_modules/');
  });

  it('still fails the task on a real lint/format error, printing the captured output', () => {
    expect(command).toContain('cat ');
    expect(command).toContain('exit 1');
  });

  it('creates the log directory first (a fresh worktree has no node_modules/.cache)', () => {
    expect(command).toMatch(/^mkdir -p node_modules\/\.cache &&/);
  });
});
