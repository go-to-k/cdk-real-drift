import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Every PreToolUse gate must catch a gated command written in ALL the invocation
// forms this repo's flow actually produces — the bare one, the `git -C <path>` /
// `gh -C <path>` one, and `cd <worktree> && <cmd>`.
//
// `.claude/skills/work-issues/SKILL.md` section 5 mandates working from a worktree,
// and section 6 tells the agent to prefix commands with an explicit `cd <worktree> &&`
// because shell cwd does not persist across tool calls. That guidance is only safe if
// the gates SEE those forms. On 2026-08-19 (go-to-k/cdk-real-drift#1786) they did not:
// `branch-gate`, `bughunt-clean-gate`, `stale-base-gate` and `ci-green-gate` each
// carried a `Bash(cd * && …)` alternative, while `check-gate`, `verify-pr-gate` and
// `non-english-text-gate` did not — so `cd <wt> && git commit` bypassed check-gate
// outright, and `cd <wt> && gh pr create` bypassed BOTH verify-pr-gate and the
// English-only gate. The bypass is silent: the command simply succeeds ungated.
//
// A hook `if` clause is plain configuration that nothing else re-reads, and the drift
// was invisible precisely because each clause looks reasonable on its own.
//
// The first version of this test derived its POPULATION from the defect it hunts —
// `hooks.filter(h => h.condition.includes('Bash(git commit*)'))` — so DELETING the
// bare form dropped the gate out of the population instead of failing, and a gate
// neutered wholesale (its `if` replaced by a pattern that matches nothing) was not
// looked at by any case. Both probes were green on 2026-08-20 with `stale-base-gate`
// and `ci-green-gate` fully disarmed. The population below is therefore DECLARED —
// which gate owes which verb — and a completeness case fails when a hook exists in
// `settings.json` that the table does not mention, so a new gate cannot be added
// silently either.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = path.join(ROOT, '.claude', 'settings.json');

/** Every gated verb a gate can owe, with the three spellings each one has. */
const FORMS: Record<string, (verb: string) => string[]> = {
  git: (verb) => [`Bash(git ${verb}*)`, `Bash(git -C * ${verb}*)`, `Bash(cd * && git ${verb}*)`],
  gh: (verb) => [
    `Bash(gh pr ${verb}*)`,
    `Bash(gh -C * pr ${verb}*)`,
    `Bash(cd * && gh pr ${verb}*)`,
  ],
};

const gitVerb = (verb: string) => ({ label: `git ${verb}`, patterns: FORMS['git']!(verb) });
const ghVerb = (verb: string) => ({ label: `gh pr ${verb}`, patterns: FORMS['gh']!(verb) });

/**
 * What each gate MUST guard. Declared, not derived from the conditions being
 * tested — see the header. `deploy-autoarm-gate` is deliberately listed with no
 * verbs: it matches on a command SHAPE (`Bash(*deploy*)`), not on these verbs.
 */
const REQUIRED: Record<string, { label: string; patterns: string[] }[]> = {
  'check-gate.sh': [gitVerb('commit')],
  'branch-gate.sh': [gitVerb('commit'), gitVerb('push')],
  'bughunt-clean-gate.sh': [gitVerb('commit'), ghVerb('create'), ghVerb('merge')],
  'stale-base-gate.sh': [gitVerb('push')],
  'verify-pr-gate.sh': [ghVerb('create'), ghVerb('merge')],
  'ci-green-gate.sh': [ghVerb('merge')],
  'non-english-text-gate.sh': [ghVerb('create'), ghVerb('edit'), ghVerb('merge')],
  'deploy-autoarm-gate.sh': [],
};

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

describe('PreToolUse gate coverage parity across invocation forms (go-to-k/cdk-real-drift#1786)', () => {
  const hooks = gateHooks();
  const byName = new Map(hooks.map((h) => [h.name, h.condition]));

  it('finds the repo gate hooks', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(8);
    const names = hooks.map((h) => h.name);
    expect(names).toContain('check-gate.sh');
    expect(names).toContain('verify-pr-gate.sh');
    expect(names).toContain('non-english-text-gate.sh');
  });

  // The population is the DECLARED table, so a gate cannot leave it by losing a
  // pattern; and it cannot enter unnoticed either.
  it('every gate hook in settings.json is accounted for in the required table', () => {
    const undeclared = hooks.map((h) => h.name).filter((n) => !(n in REQUIRED));
    expect(
      undeclared,
      'a new PreToolUse gate must declare which verbs it guards in REQUIRED'
    ).toEqual([]);
    const missing = Object.keys(REQUIRED).filter((n) => !byName.has(n));
    expect(missing, 'REQUIRED names a gate that settings.json no longer wires').toEqual([]);
  });

  for (const [gate, verbs] of Object.entries(REQUIRED)) {
    for (const verb of verbs) {
      it(`${gate} guards "${verb.label}" in every invocation form`, () => {
        const condition = byName.get(gate) ?? '';
        const gaps = verb.patterns.filter((p) => !condition.includes(p));
        expect(gaps, `${gate} is missing ${gaps.join(', ')}`).toEqual([]);
      });
    }
  }

  it('a gate that guards a verb in ANY form owes it in ALL forms', () => {
    // Backstop for a verb reached by a gate the table does not require it for —
    // the drift go-to-k/cdk-real-drift#1786 actually was.
    const gaps: string[] = [];
    for (const { name, condition } of hooks) {
      for (const family of ['git', 'gh'] as const) {
        const verbs = family === 'git' ? ['commit', 'push'] : ['create', 'edit', 'merge'];
        for (const verb of verbs) {
          const patterns = FORMS[family]!(verb);
          if (!patterns.some((p) => condition.includes(p))) continue;
          for (const missing of patterns.filter((p) => !condition.includes(p))) {
            gaps.push(`${name}: ${missing}`);
          }
        }
      }
    }
    expect(gaps).toEqual([]);
  });
});
