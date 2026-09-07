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
// The second case fences the REASON, and it resolves the entry BY THE HOOK SCRIPT
// IT REGISTERS rather than by matcher text. The sibling fence in cdkd first looked
// entries up by matcher, and review found four mutations that left it green:
// the gate's command swapped for `/bin/true`, its `hooks` array emptied, a decoy
// `Edit|Write|NotebookEdit` entry inserted ahead of the real one while the real one
// gained `Bash`, and — there — a second file-tool entry deleted with its matcher
// kept. A fence whose job is "the protection is still there" must not be
// satisfiable with the protection gone.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = path.join(ROOT, '.claude', 'settings.json');
const WORKTREE_GUARD = path.join(ROOT, '.claude', 'hooks', 'worktree-guard.sh');

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

/** Every entry of `event` registering a hook whose command matches `needle`. */
function entriesRegistering(event: string, needle: RegExp): HookEntry[] {
  return (settings.hooks?.[event] ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => needle.test(h.command ?? ''))
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
    expect(String(value)).toBe(PINNED_OFF);
  });

  it('still has the file-tool-only surface the pin protects', () => {
    const guard = entriesRegistering('PreToolUse', /\/worktree-guard\.sh$/);
    expect(guard.length, 'expected exactly one worktree-guard entry').toBe(1);
    // No `Bash` alternative -> a Bash-written file is invisible to it, which is
    // what makes the pin load-bearing rather than a preference. Should the guard
    // ever learn to parse Bash commands, this case fails and the pin's rationale
    // must be re-derived rather than trusted.
    expect(alternatives(guard[0]?.matcher)).toEqual(['Edit', 'NotebookEdit', 'Write']);
    expect(existsSync(WORKTREE_GUARD)).toBe(true);
  });
});
