import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// Every PreToolUse gate must actually BE SELECTED for the commands it guards.
//
// Two failures, a day apart, both silent:
//
// 1. go-to-k/cdk-real-drift#1786 — the `cd <worktree> && <cmd>` spelling section 5
//    mandates was missing from three gates' matchers, so `cd <wt> && git commit`
//    bypassed check-gate and `cd <wt> && gh pr create` bypassed verify-pr-gate and
//    the English-only gate. Fixed by adding a second and third anchored alternative
//    per verb, joined with ` or `.
// 2. go-to-k/cdk-real-drift#1801 — that join is not a supported expression. An `if`
//    holding `A or B` matches NOTHING, so all eight gates were inert: on 2026-08-20
//    `git commit` on `main` with no markers reached git in both a VS Code session
//    and a plain terminal one, while running `branch-gate.sh` by hand on the same
//    payload blocked with exit 2. Probed with three throwaway hooks: an `if`-less
//    hook fired, `if: "Bash(git status*)"` fired, and
//    `if: "Bash(git commit*) or Bash(git status*)"` did not.
//
// So an `if` carries exactly ONE pattern, and a gate that guards two verbs gets two
// ENTRIES. The pattern is deliberately UNANCHORED (`*git commit*`): every gate script
// already re-derives its own target and re-matches the command precisely, so the
// matcher's only job is to hand it every command that could possibly be one — an
// anchored matcher cannot see `git add -A && git commit`, which is the commonest
// spelling there is.
//
// This test failed to catch (2) because it only compared the clauses against each
// other. It now asserts the property that made them inert.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = path.join(ROOT, '.claude', 'settings.json');

/** What each gate must be selected for. `deploy-autoarm` matches a command SHAPE. */
const REQUIRED: Record<string, string[]> = {
  'check-gate.sh': ['Bash(*git*commit*)'],
  'branch-gate.sh': ['Bash(*git*commit*)', 'Bash(*git*push*)'],
  'bughunt-clean-gate.sh': ['Bash(*git*commit*)', 'Bash(*gh*pr*create*)', 'Bash(*gh*pr*merge*)'],
  'stale-base-gate.sh': ['Bash(*git*push*)'],
  'verify-pr-gate.sh': ['Bash(*gh*pr*create*)', 'Bash(*gh*pr*merge*)'],
  'ci-green-gate.sh': ['Bash(*gh*pr*merge*)'],
  'non-english-text-gate.sh': ['Bash(*gh*pr*create*)', 'Bash(*gh*pr*edit*)', 'Bash(*gh*pr*merge*)'],
  'deploy-autoarm-gate.sh': ['Bash(*deploy*)', 'Bash(*create-stack*)', 'Bash(*update-stack*)'],
};

interface GateHook {
  name: string;
  condition: string;
}

function gateHooks(): GateHook[] {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as {
    hooks?: {
      PreToolUse?: { matcher?: string; if?: string; hooks?: { command?: string; if?: string }[] }[];
    };
  };
  const out: GateHook[] = [];
  for (const matcher of settings.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks ?? []) {
      const command = hook.command ?? '';
      if (!command.includes('.claude/hooks/')) continue;
      out.push({
        name: path.basename(command.split(/\s+/)[0] ?? command),
        condition: matcher.if ?? hook.if ?? '',
      });
    }
  }
  return out;
}

describe('PreToolUse gate matchers (go-to-k/cdk-real-drift#1786, go-to-k/cdk-real-drift#1801)', () => {
  const hooks = gateHooks();
  const patternsOf = (gate: string) =>
    hooks.filter((h) => h.name === gate && h.condition).map((h) => h.condition);

  it('finds the repo gate hooks', () => {
    const names = new Set(hooks.map((h) => h.name));
    expect(names.has('check-gate.sh')).toBe(true);
    expect(names.has('verify-pr-gate.sh')).toBe(true);
    expect(names.has('non-english-text-gate.sh')).toBe(true);
  });

  // THE regression case for go-to-k/cdk-real-drift#1801. An `or` in an `if` disables
  // the hook outright, and nothing else in the repo would say so.
  it('no `if` joins patterns with `or` — that matches nothing and disables the hook', () => {
    const joined = hooks
      .filter((h) => / or |\|\||&&(?![^)]*\))/.test(h.condition))
      .map((h) => `${h.name}: ${h.condition}`);
    expect(
      joined,
      'an `if` takes ONE pattern; give the gate a second ENTRY instead of joining'
    ).toEqual([]);
  });

  it('every `if` holds a single well-formed Bash(...) pattern', () => {
    const malformed = hooks
      .filter((h) => h.condition)
      .filter((h) => !/^Bash\([^()]*\)$/.test(h.condition))
      .map((h) => `${h.name}: ${h.condition}`);
    expect(malformed).toEqual([]);
  });

  it('every gate hook in settings.json is accounted for in the required table', () => {
    const undeclared = [...new Set(hooks.map((h) => h.name))].filter(
      (n) => !(n in REQUIRED) && n !== 'worktree-guard.sh'
    );
    expect(undeclared, 'a new gate must declare which commands select it').toEqual([]);
    const missing = Object.keys(REQUIRED).filter((n) => patternsOf(n).length === 0);
    expect(missing, 'REQUIRED names a gate settings.json no longer wires').toEqual([]);
  });

  for (const [gate, patterns] of Object.entries(REQUIRED)) {
    it(`${gate} is selected for every command it guards`, () => {
      const present = patternsOf(gate);
      const gaps = patterns.filter((p) => !present.includes(p));
      expect(gaps, `${gate} is missing an entry for ${gaps.join(', ')}`).toEqual([]);
    });
  }

  // The matcher is a glob over the WHOLE command string, so an anchored pattern
  // cannot see a gated verb that follows another command. Keep them unanchored.
  // `git -C <path> commit` and `gh -R <owner/repo> pr create` put a FLAG between
  // the command and its verb, so a pattern demanding them adjacent
  // (`Bash(*git commit*)`) never selects those spellings — and this repo's own
  // memory rule tells an agent to use `git -C` in multi-repo sessions, so the
  // gap was being actively steered into (found 2026-08-21, the same class as
  // go-to-k/cdk-real-drift#1801). Simulate the glob to keep it closed.
  it('a flag between the command and its verb still selects the gate', () => {
    const globToRe = (pattern: string) =>
      new RegExp(
        `^${pattern
          .replace(/^Bash\(/, '')
          .replace(/\)$/, '')
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`
      );
    const spellings = [
      'git commit -m x',
      'git -C /w/t commit -m x',
      'git -c user.name=t commit -m x',
      'cd /w/t && git commit -m x',
      'git add -A && git commit -m x',
    ];
    const commitPatterns = hooks.filter((h) => h.name === 'check-gate.sh').map((h) => h.condition);
    for (const spelling of spellings) {
      expect(
        commitPatterns.some((p) => globToRe(p).test(spelling)),
        `no check-gate pattern selects: ${spelling}`
      ).toBe(true);
    }
    const ghPatterns = hooks.filter((h) => h.name === 'verify-pr-gate.sh').map((h) => h.condition);
    for (const spelling of ['gh pr create --fill', 'gh -R go-to-k/x pr create --fill']) {
      expect(
        ghPatterns.some((p) => globToRe(p).test(spelling)),
        `no verify-pr-gate pattern selects: ${spelling}`
      ).toBe(true);
    }
  });

  it('the guarded-verb patterns are unanchored, so a compound command still selects', () => {
    const anchored = hooks
      .filter((h) => /^Bash\((git|gh)\b/.test(h.condition))
      .map((h) => `${h.name}: ${h.condition}`);
    expect(
      anchored,
      'write Bash(*git commit*), not Bash(git commit*) — the latter misses ' +
        '`git add -A && git commit` and `cd <wt> && git commit`'
    ).toEqual([]);
  });
});
