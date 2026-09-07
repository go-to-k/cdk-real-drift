import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// `worktree-guard.sh` is registered on `Edit|Write|NotebookEdit` — the TOOLS, not
// the operation — so it stops firing entirely for a session in Claude Code's
// bash-first experiment (`CLAUDE_CODE_THRIFTY_SONIC`, go-to-k/cdk-real-drift#1893).
// With that flag on the session is told to read and WRITE files through
// `cat` / `sed -i` / heredocs instead of the file tools, so an Edit to the MAIN
// checkout's `src/**` spelled as a heredoc is refused by nothing: the one guard
// against the #408 cross-session contamination goes silently inert, and the
// git-verb-scoped `restore-backup.sh` never sees the overwrite either.
//
// Measured on Claude Code 2.1.263: the native binary parses the variable as a
// tri-state bool and an EXPLICITLY SET value short-circuits the server-side
// cohort assignment — `if (env.CLAUDE_CODE_THRIFTY_SONIC !== undefined) return it`
// sits ahead of the `forced` / `cohort` branches. So the pin belongs in the REPO's
// settings: a maintainer's `~/.claude/settings.json` fixes one machine and leaves
// every contributor and every parallel lane in whatever cohort the server picked.
// Probe: with the value flipped to `"1"`, a `claude -p` asking whether the phrase
// `Do your work through the Bash tool` is in context answers PRESENT; at `"0"` and
// on the unset baseline it answers ABSENT — only the `"1"` arm discriminates.
//
// This file asserts a JSON STRING, never vendor behavior. A rename, a default
// flip, or removal of that short-circuit makes the pin a no-op with both cases
// still green, and nothing re-probes on upgrade — re-run the probe above when
// Claude Code moves off the version named here.
//
// It also cannot see `.claude/settings.local.json`, which OUTRANKS the file it
// reads: the pin is this repo's DEFAULT, not an unescapable one. What it removes
// is the SILENT version, where a server-side cohort decides and nobody chose.
//
// The second case fences the REASON, and it resolves the entry BY WHAT IT RUNS
// rather than by matcher text or a command substring. Two review rounds on the
// sibling fence in cdkd cleared the weaker lookups seven ways: matcher text alone
// by swapping the gate's command for `/bin/true`, by emptying its `hooks` array,
// and by a decoy `Edit|Write|NotebookEdit` entry inserted ahead of the real one;
// a command SUBSTRING by demoting the path to a trailing `#` comment and by
// repointing it into a `disabled/` directory while `existsSync` still stated the
// hard-coded original. So the command must be exactly the project-dir prefix plus
// a script path, and that DERIVED path is the one checked on disk.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = path.join(ROOT, '.claude', 'settings.json');

/** The prefix every hook command in this repo uses to reach the repo root. */
const PROJECT_DIR_PREFIX = '${CLAUDE_PROJECT_DIR:-.}';
const WORKTREE_GUARD_SCRIPT = '.claude/hooks/worktree-guard.sh';

/**
 * The only value measured against a discriminating twin. Other spellings the
 * vendor's tri-state parser may accept are deliberately NOT accepted here — a
 * second spelling buys nothing and would widen what this fence certifies beyond
 * what was measured.
 */
const PINNED_OFF = '0';

interface HookSpec {
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookSpec[];
}
interface Settings {
  env?: Record<string, string>;
  hooks?: Record<string, HookEntry[]>;
}

const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Settings;

/** Alternatives of an `A|B|C` matcher, trimmed and order-insensitive. */
function alternatives(matcher: string | undefined): string[] {
  return (matcher ?? '')
    .split('|')
    .map((a) => a.trim())
    .filter(Boolean)
    .sort();
}

/**
 * The repo-relative script a command runs, or `undefined` when the command is
 * anything else. The whole command must be the prefix plus one `.sh` path — a
 * trailing comment, an `&&` tail, or a wrapper all fall through, since each
 * would let an inert command answer for the gate it names.
 */
function registeredScript(command: string | undefined): string | undefined {
  if (!command?.startsWith(PROJECT_DIR_PREFIX)) return undefined;
  const rest = command.slice(PROJECT_DIR_PREFIX.length);
  return /^\/[\w./-]+\.sh$/.test(rest) ? rest.slice(1) : undefined;
}

/** Every entry of `event` whose command runs exactly `script`. */
function entriesRunningScript(event: string, script: string): HookEntry[] {
  return (settings.hooks?.[event] ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => registeredScript(h.command) === script)
  );
}

describe('.claude/settings.json bash-first opt-out (go-to-k/cdk-real-drift#1893)', () => {
  it('pins CLAUDE_CODE_THRIFTY_SONIC off', () => {
    const value = settings.env?.CLAUDE_CODE_THRIFTY_SONIC;
    expect(
      value,
      'env.CLAUDE_CODE_THRIFTY_SONIC is missing from .claude/settings.json; ' +
        'without it a contributor in the bash-first cohort silently loses ' +
        'worktree-guard, the one gate protecting the main checkout from a ' +
        'concurrent lane'
    ).toBeDefined();
    // A JSON number would read as `'0'` through `String()` while Claude Code's
    // `env` map expects strings, so the shape is asserted rather than coerced.
    expect(typeof value).toBe('string');
    expect(value).toBe(PINNED_OFF);
  });

  it('still has the file-tool-only surface the pin protects', () => {
    const guard = entriesRunningScript('PreToolUse', WORKTREE_GUARD_SCRIPT);
    expect(guard.length, `expected exactly one entry running ${WORKTREE_GUARD_SCRIPT}`).toBe(1);
    // The DERIVED path, not a hard-coded twin: repointing the command into a
    // `disabled/` directory must not leave the original still being stat'ed.
    expect(existsSync(path.join(ROOT, WORKTREE_GUARD_SCRIPT))).toBe(true);
    // The invariant is the ABSENCE of `Bash` plus the three file tools being
    // present. A set equality false-reds a strictly STRONGER matcher — adding
    // `MultiEdit` widens the guard and must stay green. Should the guard ever
    // learn to parse Bash commands, the second assertion fails and the pin's
    // rationale must be re-derived rather than trusted.
    const alts = alternatives(guard[0]?.matcher);
    expect(alts).toEqual(expect.arrayContaining(['Edit', 'NotebookEdit', 'Write']));
    expect(alts).not.toContain('Bash');
  });
});
