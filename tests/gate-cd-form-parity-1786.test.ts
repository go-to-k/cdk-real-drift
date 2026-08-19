import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Every PreToolUse gate must catch a gated command written in ALL the invocation
// forms this repo's flow actually produces — including `cd <worktree> && <cmd>`.
//
// `.claude/skills/work-issues/SKILL.md` section 5 mandates working from a worktree,
// and section 6 now tells the agent to prefix commands with an explicit
// `cd <worktree> &&` because shell cwd does not persist across tool calls. That
// guidance is only safe if the gates SEE that form. On 2026-08-19
// (go-to-k/cdk-real-drift#1786) they did not: `branch-gate`, `bughunt-clean-gate`,
// `stale-base-gate` and `ci-green-gate` each carried a `Bash(cd * && …)`
// alternative, while `check-gate`, `verify-pr-gate` and `non-english-text-gate` did
// not — so `cd <wt> && git commit` bypassed check-gate outright, and
// `cd <wt> && gh pr create` bypassed BOTH verify-pr-gate and the English-only gate.
// The bypass is silent: the command simply succeeds ungated.
//
// A hook `if` clause is plain configuration that nothing else re-reads, and the
// drift was invisible precisely because each clause looks reasonable on its own.
// This test compares them against each other instead.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = path.join(ROOT, '.claude', 'settings.json');

// The command forms the gates guard. A gate that matches the bare form of one of
// these owes the `cd * && ` form too.
const GATED_COMMANDS = ['git commit', 'git push', 'gh pr create', 'gh pr edit', 'gh pr merge'];

interface GateHook {
  name: string;
  condition: string;
}

function gateHooks(): GateHook[] {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as {
    hooks?: {
      PreToolUse?: { if?: string; hooks?: { command?: string; if?: string }[] }[];
    };
  };
  const matchers = settings.hooks?.PreToolUse ?? [];
  const out: GateHook[] = [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks ?? []) {
      const command = hook.command ?? '';
      if (!command.includes('.claude/hooks/')) continue;
      const name = path.basename(command.split(/\s+/)[0] ?? command);
      const condition = matcher.if ?? hook.if ?? '';
      if (condition) out.push({ name, condition });
    }
  }
  return out;
}

// `Bash(git commit*)` is ANCHORED, so it does not match `cd x && git commit`.
// `Bash(cd * && git commit*)` is the separate alternative that does.
const bareForm = (cmd: string) => `Bash(${cmd}`;
const cdForm = (cmd: string) => `Bash(cd * && ${cmd}`;

describe('PreToolUse gate coverage parity across invocation forms (go-to-k/cdk-real-drift#1786)', () => {
  const hooks = gateHooks();

  it('finds the repo gate hooks', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(8);
    const names = hooks.map((h) => h.name);
    expect(names).toContain('check-gate.sh');
    expect(names).toContain('verify-pr-gate.sh');
    expect(names).toContain('non-english-text-gate.sh');
  });

  for (const cmd of GATED_COMMANDS) {
    it(`every gate guarding "${cmd}" also guards "cd … && ${cmd}"`, () => {
      const gaps = hooks
        .filter((h) => h.condition.includes(bareForm(cmd)))
        .filter((h) => !h.condition.includes(cdForm(cmd)))
        .map((h) => h.name);
      expect(gaps).toEqual([]);
    });
  }

  it('the three gates that carried the gap now cover the cd form', () => {
    const byName = new Map(hooks.map((h) => [h.name, h.condition]));
    expect(byName.get('check-gate.sh')).toContain('Bash(cd * && git commit*)');
    expect(byName.get('verify-pr-gate.sh')).toContain('Bash(cd * && gh pr create*)');
    expect(byName.get('verify-pr-gate.sh')).toContain('Bash(cd * && gh pr merge*)');
    expect(byName.get('non-english-text-gate.sh')).toContain('Bash(cd * && gh pr edit*)');
  });
});
