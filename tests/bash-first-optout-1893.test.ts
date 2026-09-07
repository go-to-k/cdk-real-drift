import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

// `worktree-guard.sh` is registered on `Edit|Write|NotebookEdit` — the TOOLS, not
// the operation — so it stops firing entirely for a session in Claude Code's
// bash-first experiment (`CLAUDE_CODE_THRIFTY_SONIC`, go-to-k/cdk-real-drift#1893).
// With that flag on the session is told to read and WRITE files through
// `cat` / `sed -i` / heredocs instead of the file tools, so an Edit to the MAIN
// checkout's `src/**` spelled as a heredoc is refused by nothing: the one guard
// against the #408 cross-session contamination goes silently inert, and this
// repo carries no snapshot hook that would record the overwrite either.
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
// cases still green, so the VERSION case pins the Claude Code line the
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
const LOCAL_SETTINGS = '.claude/settings.local.json';
const HOOKS_RULE = path.join(ROOT, '.claude', 'rules', 'hooks.md');

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
 * The installed Claude Code version, `undefined` when the binary is ABSENT, and
 * a THROW when one answered but could not be read. Collapsing the three was the
 * round-4 finding on the cdkd twin: a non-zero exit, a timeout and a wrapper
 * printing an unrecognized version line all read as "no Claude Code here" and
 * early-returned the case to green — disarming it on exactly the vendor change
 * it exists to notice. `CDKRD_CLAUDE_BIN` is a test seam for both arms.
 */
function installedClaudeVersion(): string | undefined {
  const bin = process.env['CDKRD_CLAUDE_BIN'] ?? 'claude';
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`\`${bin} --version\` could not be run: ${code ?? res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`\`${bin} --version\` exited ${res.status}: ${(res.stderr ?? '').trim()}`);
  }
  const out = (res.stdout ?? '').trim();
  const version = /^(\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (version === undefined) {
    throw new Error(
      `no version could be read from \`${bin} --version\` (${JSON.stringify(out)}). ` +
        'If Claude Code reworked that line, re-run both probe arms from ' +
        '.claude/rules/hooks.md before touching this test.'
    );
  }
  return version;
}

interface HookSpec {
  type?: string;
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

/**
 * Whether a matcher SELECTS `tool`, transcribed from the 2.1.263 binary's own
 * decision (`Mmr` / `Tms`), measured rather than guessed:
 *
 *   - an empty matcher or `*` selects EVERY tool;
 *   - a matcher matching `/^[a-zA-Z0-9_|, -]+$/` is an exact NAME LIST, split
 *     on `/[|,]/` and trimmed (space is padding, never a separator);
 *   - anything else is compiled as a RegExp against the tool name, and an
 *     UNCOMPILABLE one selects nothing at all.
 *
 * Both halves of the assertion pair go through this. Reading the presence half
 * off a hand-split alternatives list was the round-4 finding on the cdkd twin:
 * splitting `Edit|Write|NotebookEdit|[` on `|` reported the three tools
 * present, so a matcher that compiles to NOTHING — the guard wholly inert —
 * left the case green.
 */
function selectsTool(matcher: string | undefined, tool: string): boolean {
  const m = matcher ?? '';
  if (m === '' || m === '*') return true;
  if (/^[a-zA-Z0-9_|, -]+$/.test(m)) {
    return m
      .split(/[|,]/)
      .map((a) => a.trim())
      .filter(Boolean)
      .includes(tool);
  }
  try {
    return new RegExp(m).test(tool);
  } catch {
    return false;
  }
}

/**
 * The repo-relative script a command runs, or `undefined` when the command is
 * anything else. The whole command must be the prefix plus one `.sh` path — a
 * trailing comment, an `&&` tail, or a wrapper all fall through, since each
 * would let an inert command answer for the gate it names.
 */
function registeredScript(hook: HookSpec | undefined): string | undefined {
  // A hook whose `type` is anything but `command` is not a command hook at all,
  // so a dropped or misspelled `type` must not answer for the gate either.
  if (hook?.type !== 'command') return undefined;
  const command = hook.command;
  if (!command?.startsWith(PROJECT_DIR_PREFIX)) return undefined;
  const rest = command.slice(PROJECT_DIR_PREFIX.length);
  return /^\/[\w./-]+\.sh$/.test(rest) ? rest.slice(1) : undefined;
}

/** Every entry of `event` whose command runs exactly `script`. */
function entriesRunningScript(event: string, script: string): HookEntry[] {
  return (settings.hooks?.[event] ?? []).filter((e) =>
    (e.hooks ?? []).some((h) => registeredScript(h) === script)
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
    // ...and be EXECUTABLE. A dropped exec bit makes the command exit 126,
    // which PreToolUse treats as non-blocking, so the guard goes inert with
    // every case here green — existence alone does not prove it can run.
    expect(() => accessSync(path.join(ROOT, WORKTREE_GUARD_SCRIPT), constants.X_OK)).not.toThrow();
    // ...and the INDEX must carry the bit too. `accessSync` reads the LOCAL
    // mode, so a file committed 100644 and `chmod +x`'d on this machine stays
    // green here while every other checkout exits 126.
    const staged = spawnSync(
      'git',
      ['-C', ROOT, 'ls-files', '--stage', '--', WORKTREE_GUARD_SCRIPT],
      { encoding: 'utf8' }
    );
    expect(staged.status).toBe(0);
    expect(
      (staged.stdout ?? '').split(/\s/)[0],
      `${WORKTREE_GUARD_SCRIPT} is not mode 100755 in the index; a fresh clone ` +
        'would get a non-executable hook, which exits 126 and does not block'
    ).toBe('100755');
    // Both halves read through the binary's own rule, so a matcher that compiles
    // to nothing cannot satisfy the presence half. A strictly STRONGER matcher
    // stays green: adding `MultiEdit` widens the guard, and a reordered list is
    // the same list. It is the Bash assertion that fails should the guard ever
    // start seeing Bash, at which point the pin's rationale must be re-derived.
    const guardMatcher = guard[0]?.matcher;
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(selectsTool(guardMatcher, tool), `guard no longer selects ${tool}`).toBe(true);
    }
    expect(selectsTool(guardMatcher, 'Bash')).toBe(false);
  });

  it('keeps the local override out of the repo', () => {
    // `.claude/settings.local.json` OUTRANKS the pinned file, so a COMMITTED one
    // carrying `"1"` beats the pin for everyone while every case above stays
    // green. The `.gitignore` line added with the pin is what stops that.
    //
    // `-v` rather than `-q`, and the SOURCE is asserted: measured on the cdkd
    // twin, deleting the line from the repo's own `.gitignore` still exits 0,
    // because a developer's `~/.config/git/ignore` covers the same path. A fence
    // whose verdict depends on what sits outside the checkout says nothing about
    // what a contributor cloning it gets.
    const ignored = spawnSync('git', ['-C', ROOT, 'check-ignore', '-v', LOCAL_SETTINGS], {
      encoding: 'utf8',
    });
    expect(
      ignored.status,
      `${LOCAL_SETTINGS} is not ignored by git; a committed one would outrank ` +
        '.claude/settings.json and silently beat the bash-first pin'
    ).toBe(0);
    expect(
      (ignored.stdout ?? '').trim(),
      `${LOCAL_SETTINGS} is ignored, but not by this repo's own .gitignore — a ` +
        "global or per-user ignore file covers it on THIS machine and nobody else's"
    ).toMatch(/^\.gitignore:/);

    const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '--', LOCAL_SETTINGS], {
      encoding: 'utf8',
    });
    expect(tracked.status).toBe(0);
    expect(
      (tracked.stdout ?? '').trim(),
      `${LOCAL_SETTINGS} is TRACKED; being gitignored does not untrack a file that ` +
        'was already added'
    ).toBe('');
  });

  it('still runs on the Claude Code line the pin was measured against', () => {
    // The recorded measurement must be well-formed whether or not a binary
    // answers — otherwise the absent-binary arm below would pass on a receipt
    // nobody could read.
    expect(PROBED_CLAUDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROBED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The measurement is written down TWICE — here and in the prose carrying the
    // probe recipe. Bumping one without the other leaves a reader re-probing
    // against a version nobody measured, and CI, which has no binary to compare
    // against, would otherwise certify nothing at all.
    expect(
      readFileSync(HOOKS_RULE, 'utf8'),
      `.claude/rules/hooks.md no longer names ${PROBED_CLAUDE_VERSION}; the probe ` +
        'recipe and this receipt must move together'
    ).toContain(PROBED_CLAUDE_VERSION);

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
