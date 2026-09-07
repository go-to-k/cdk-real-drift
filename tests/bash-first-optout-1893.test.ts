import { spawnSync } from 'node:child_process';
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
// flip, or removal of that short-circuit makes the pin a no-op with the other
// cases still green, so the third case pins the Claude Code line the
// measurement was taken on. It is a REMINDER to re-run the probe above, not a
// detector — only running the probe observes the vendor's behavior, and what a
// test can do is refuse to let the measurement go quietly out of date.
// (Ported from the go-to-k/cdkd twin, issue go-to-k/cdkd#2737.)
//
// It also cannot see `.claude/settings.local.json`, which OUTRANKS the file it
// reads: the pin is this repo's DEFAULT, not an unescapable one. What it removes
// is the SILENT version, where a server-side cohort decides and nobody chose.
//
// The second case fences the REASON, and it resolves the entry BY WHAT IT RUNS
// rather than by matcher text or a command substring. Review of the sibling fence
// in cdkd cleared the weaker lookups five ways that apply here: matcher text alone
// by swapping the gate's command for `/bin/true`, by emptying its `hooks` array,
// and by a decoy `Edit|Write|NotebookEdit` entry inserted ahead of the real one;
// a command SUBSTRING by demoting the path to a trailing `#` comment and by
// repointing it into a `disabled/` directory while `existsSync` still stated the
// hard-coded original. So the command must be exactly the project-dir prefix plus
// one script path, and that script must exist on disk.

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

/**
 * The Claude Code build the pin's behavior was MEASURED against, and when. Both
 * move together, and only after re-running BOTH probe arms above — bumping the
 * version to clear a red without re-probing is the one way to make this case
 * worse than useless.
 */
const PROBED_CLAUDE_VERSION = '2.1.263';
const PROBED_ON = '2026-09-07';

/**
 * Compared at MAJOR.MINOR, deliberately not at the patch. Claude Code patches
 * land often enough that an exact pin would red an unrelated commit most weeks,
 * and a red that arrives that often gets discharged by editing the constant
 * rather than by re-probing. A minor bump is where an experiment's default
 * flips or a flag is retired. The BOUND is real: a behavior change shipped
 * inside a patch release passes here silently.
 */
function minorOf(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

/**
 * The installed Claude Code version, or `undefined` when no binary answers — CI
 * has none, and there the pin's behavior is unobservable rather than wrong.
 * `CDKRD_CLAUDE_BIN` is a test seam so the absent-binary arm can be probed.
 */
function installedClaudeVersion(): string | undefined {
  const bin = process.env['CDKRD_CLAUDE_BIN'] ?? 'claude';
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (res.error || res.status !== 0) return undefined;
  return /^(\d+\.\d+\.\d+)/.exec((res.stdout ?? '').trim())?.[1];
}

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
 * Whether a matcher SELECTS the Bash tool, by the rule the 2.1.263 binary uses:
 * a matcher matching `[a-zA-Z0-9_|, -]+` is an exact name list, and anything
 * else is compiled as a regular expression. `not.toContain('Bash')` reads the
 * name list only, so a regex-spelled alternative escapes it.
 */
function matchesBash(matcher: string | undefined): boolean {
  const m = matcher ?? '';
  if (/^[a-zA-Z0-9_|, -]+$/.test(m)) return alternatives(m).includes('Bash');
  try {
    return new RegExp(m).test('Bash');
  } catch {
    // An uncompilable matcher selects nothing; treat it as not selecting Bash
    // rather than throwing here — the arrayContaining assertion already reds.
    return false;
  }
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
    // Compared against the STRING, never `String(value)`: Claude Code's `env`
    // map expects strings, and a JSON number `0` must red rather than coerce.
    expect(value).toBe(PINNED_OFF);
  });

  it('still has the file-tool-only surface the pin protects', () => {
    const guard = entriesRunningScript('PreToolUse', WORKTREE_GUARD_SCRIPT);
    expect(guard.length, `expected exactly one entry running ${WORKTREE_GUARD_SCRIPT}`).toBe(1);
    // The script must also EXIST: a registration is not an installed hook, and
    // deleting the file while leaving the entry in place is the one shape the
    // count above cannot see. (Repointing the command is caught by that count,
    // not here — the filter admits only the exact path, so this join can never
    // disagree with it.)
    expect(existsSync(path.join(ROOT, WORKTREE_GUARD_SCRIPT))).toBe(true);
    // The invariant is the ABSENCE of `Bash` plus the three file tools being
    // present. A set equality false-reds a strictly STRONGER matcher — adding
    // `MultiEdit` widens the guard and must stay green.
    const alts = alternatives(guard[0]?.matcher);
    expect(alts).toEqual(expect.arrayContaining(['Edit', 'NotebookEdit', 'Write']));
    expect(alts).not.toContain('Bash');
    // Measured in the 2.1.263 binary: a matcher of `[a-zA-Z0-9_|, -]+` is an
    // exact NAME LIST, anything else is compiled as a RegExp against the tool
    // name. So `|Bash.*` or `|.*` selects Bash while clearing the check above —
    // and it is THIS assertion that fails should the guard ever start seeing
    // Bash, at which point the pin's rationale must be re-derived.
    expect(matchesBash(guard[0]?.matcher)).toBe(false);
  });

  it('still runs on the Claude Code line the pin was measured against', () => {
    // The recorded measurement must be well-formed whether or not a binary
    // answers — otherwise the absent-binary arm below would pass on a receipt
    // nobody could read.
    expect(PROBED_CLAUDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROBED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const installed = installedClaudeVersion();
    if (installed === undefined) {
      // Not a silent skip: there is no Claude Code here to disagree with, so
      // the receipt above is the whole of what this environment can assert.
      return;
    }

    expect(
      minorOf(installed),
      `the bash-first pin was measured against Claude Code ${PROBED_CLAUDE_VERSION} ` +
        `on ${PROBED_ON}; ${installed} is a different line. Re-run BOTH probe arms ` +
        'from the header above (value flipped to "1" must answer PRESENT, "0" must ' +
        'answer ABSENT), then update PROBED_CLAUDE_VERSION and PROBED_ON together. ' +
        'Do not bump them without re-probing.'
    ).toBe(minorOf(PROBED_CLAUDE_VERSION));
  }, 60_000);
});
