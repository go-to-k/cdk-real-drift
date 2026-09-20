# When a hook may BLOCK, and when it may exist at all

**A gate may block only when the harm completes at the moment of the action AND
lands irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work, or on
the MAINTAINER's AWS account.** Everything else becomes a sentence in AGENTS.md,
a unit test over `src/**`, or nothing. Ask the two clauses separately — is the
harm reversible, and whose artifact does it land on — never one about severity:
irreversibility alone would block a duplicate issue, the filer's own artifact.

**And a third question, asked before either: does the SERVER already refuse it?**
The `main` ruleset (`gh api repos/go-to-k/cdk-real-drift/rulesets`) carries
`deletion`, `non_fast_forward` and `required_status_checks` — `ci-ok`, `check`
and `English-only (PR title / body)` — over the default branch with **zero
bypass actors**. **Know its EDGE before leaning on it, because it is narrower
than "the server refuses a push to `main`":**

- `deletion` and `non_fast_forward` do not bear on an ordinary push at all.
- `required_status_checks` is evaluated against the SHA BEING PUSHED, at push
  time. A commit no pull request ever produced cannot carry `check` or
  `English-only (PR title / body)`, because `pr-title-check.yml` and
  `pr-content-checks.yml` trigger on `pull_request` ONLY — so that push is
  refused. (`ci-ok` is not the load-bearing one here: `ci.yml` also runs on
  `push`, so a pushed commit can acquire it, but only AFTER the push.)
- **The residual:** a PR head whose three contexts are ALREADY green satisfies
  the rule, so `git merge --ff-only <that sha>` followed by `git push origin
main` is ACCEPTED — landing un-squashed history without the merge button.
  `branch-gate` refused that shape and nothing does now. Accepted knowingly; the
  row is in [docs/tooling-backlog.md](../../docs/tooling-backlog.md).

`git push --dry-run` does NOT probe any of this, so do not reach for it as
evidence.

A local hook restating what the server DOES refuse adds no refusal the flow does
not already meet; it adds a second place to keep in step, and it reads as
protection while the real protection is elsewhere. `branch-gate.sh` (a commit or
push on `main`) and `ci-green-gate.sh` (a merge over a red or pending check)
were deleted for that reason. What the server does NOT see is still
fair game — `stale-base-gate` is the standing example: the branch it refuses is
a legitimate fast-forward that happens to revert another lane's work.

**A hook that fails OPEN on an exotic shell shape is accepted as-is.** Quoting,
heredocs, substitutions, `bash -c`, `eval`, case arms and redirections can all
steer a command past a matcher. These hooks steer a COOPERATIVE agent away from
foot-guns; they are not a security boundary, and `main` is protected server-side
by a GitHub ruleset. Such a miss is not issue-worthy — record it in
[docs/tooling-backlog.md](../../docs/tooling-backlog.md) and build nothing until
it bites a SECOND time.

# The roster

## The shared `main` and other sessions' work

- **`stale-base-gate.sh`** — blocks `git push` of a branch that sits ON TOP of
  the current `origin/main` (origin/main is an ancestor of HEAD) yet whose net
  diff REVERTS files recent `origin/main` commits changed. That is the
  stale-base soft-reset clobber: `git reset --soft origin/main` over a stale
  tree produces a commit that silently rolls another lane's merged PR back.
  Fires only when origin/main is already an ancestor of HEAD, and every git
  failure falls through to `exit 0` — it never blocks what it cannot prove.
  NOT to be confused with warning that a branch is BEHIND main; this is the
  opposite condition.

- **`worktree-guard.sh`** — PreToolUse (`Edit|Write|NotebookEdit`). Blocks a
  file-tool write to the MAIN checkout's `src/**` or `tests/**` while a
  `.worktrees/` worktree exists. A `Write` there overwrites whatever uncommitted
  content another session left in the shared tree and nothing in git holds a
  copy; a `cp`-recovery out of a contaminated main then pulls another session's
  freshly-merged work into an unrelated branch. Fail-OPEN on any ambiguity: no
  path, a relative path, no git context, or only the main worktree existing.

## The maintainer's AWS account

- **`bughunt-clean-gate.sh`** — blocks `git commit`, `gh pr create` and
  `gh pr merge` while the sentinel still lists un-deleted AWS resources. Only
  `bughunt-track.sh clear`, after delete + orphan-zero verification, releases
  it. The sentinel directory is resolved at the SHARED main-tree root
  (`--git-common-dir`) so a tracker armed in one worktree and a gate run from
  another agree on one location. **Per-owner**: the block is decided against the
  COMMITTING owner alone (`$CDKRD_BUGHUNT_OWNER`, else the committing worktree's
  sanitized toplevel), because bug-hunt stacks are uniquely named and a peer's
  live hunt creates no contention. The legacy flat
  `.markgate-bughunt-pending` file stays a GLOBAL block.

- **`deploy-autoarm-gate.sh`** — NON-BLOCKING; always exits 0. Arms the
  bughunt-clean sentinel the moment a deploy-shaped command
  (`aws cloudformation deploy` / `create-stack` / `update-stack`, `cdk deploy`,
  `sam deploy`) is about to run, so a throwaway live test cannot be forgotten
  when nobody called `bughunt-track.sh add`. It arms a GENERIC token, never a
  parsed stack name: a misparse tracks the WRONG name, which `verify` finds
  "gone" and passes while the real stack leaks. `bughunt-track verify` always
  runs the tag-based account-wide sweep, so the token only holds the gate until
  that proof passes. The owner key is PER SESSION (`autoarm-<session>`, from
  `$CLAUDE_CODE_SESSION_ID`, else the payload's `session_id`, else the shared
  `autoarm-shared` token = fail-safe global block), so your deploy blocks your
  own commit and not a peer's.

**No hook reads `.markgate.yml` any more.** It was `branch-gate.sh`'s repo
opt-in signal — the one thing that kept it from firing in an unrelated
checkout — and that hook is gone. The file stays for its `integ` declaration; a
NEW hook that needs a repo opt-in has to re-establish one rather than assume the
file is still consulted.

# Authoring a hook

**An `if:` carries exactly ONE pattern.** `Bash(A) or Bash(B)` is not a
supported expression and matches NOTHING, which made every gate inert without an
error line (go-to-k/cdk-real-drift#1801). A gate guarding two verbs gets two
ENTRIES. Patterns are deliberately UNANCHORED (`Bash(*git*commit*)`): each gate
re-derives its own target and re-matches precisely, so the matcher's only job is
to hand it every command that could possibly be one — an anchored pattern cannot
see `git add -A && git commit`, and a pattern demanding the verb adjacent to the
command (`Bash(*git commit*)`) cannot see `git -C <path> commit`. Fenced by
`tests/gate-if-matchers-1801.test.ts`.

**A matcher names a TOOL, not an OPERATION, and a vendor prompt experiment
decides which tool the session uses** (go-to-k/cdk-real-drift#1893).
`worktree-guard.sh` is the only file-tool-matched hook here; under Claude Code's
bash-first experiment the session is told to write through `cat` / `sed -i` /
heredocs instead and the guard never fires, with no error line anywhere. An
EXPLICITLY SET `CLAUDE_CODE_THRIFTY_SONIC` short-circuits the server-side cohort
assignment, so `.claude/settings.json` pins it to `"0"` for every clone; a
maintainer's `~/.claude/settings.json` would fix one machine.
`.claude/settings.local.json` still outranks the committed file and is
gitignored — what the pin removes is the SILENT version where a cohort decides
and nobody chose. Fenced by `tests/bash-first-optout-1893.test.ts`.

**A refusal message printed with `cat >&2 <<EOF` is an UNQUOTED heredoc**, so
`$( )`, backticks and `$var` in the body EXECUTE at refusal time instead of
printing. QUOTE THE DELIMITER (`<<'EOF'`) and interpolate the few live values
with a separate `printf`. Assert the RENDERED message in the harness, never a
restatement of it.

**A blocking gate that cannot load the shared matcher exits 2**; a non-blocking
hook skips instead. An unreadable target directory is likewise a REFUSAL: a hook
receives command TEXT, not the shell's expansion, so `git -C "$W" commit`
arrives unexpanded and resolution must refuse rather than guess. These shapes
must NOT be refused: an absolute `-C` or `cd` mooting an earlier unreadable one,
a `cd` AFTER the verb, and a leading literal `~`.

Hooks must be bash 3.2 compatible. No harness pins the interpreter any more —
`branch-gate.test.sh` carried the one-symlink PATH shim that did, and it went
with its hook. `scripts/run-hook-tests.sh` exports nothing, so run it a second
time under `/bin/bash` to get the 3.2 tally, and treat that second run as the
contract rather than assuming a harness enforces it. Every hook has a `.test.sh` beside
it and every harness resolves its subject from its OWN script path — run a
harness from `.claude/hooks/`, never from a copy parked elsewhere, or every case
fails on exit 127 and reads as a regression (`tests/skill-doc-paths.test.ts`
fences both).

# The shared matcher (`.claude/hooks/_command-match.sh`)

Every Bash gate parses its command through this one library, sourced and never
executed. The model: a Bash tool call is a COMMAND LIST — segment it, then ask
whether any SEGMENT is the gated command. The pre-library gates anchored at line
start and tolerated at most one leading `cd <path> &&`, so `git add -A && git
commit`, `cd <wt>; git commit`, `(cd <wt> && git commit)` and
`GIT_EDITOR=true git commit` all reached git UNGATED.

- Separators inside quoted spans are **NEUTRALISED to a placeholder, never
  deleted**. Blanking the span also erased the PATH in `cd "<worktree>" && git
commit`, so target resolution fell back to the payload cwd and the gate passed
  a commit it should have blocked (go-to-k/cdk-local#542). Segments keep their
  original text; a verb inside a string still does not match, because each verb
  regex is anchored at the segment START.
- **Over-approximate the TRIGGER, stay strict on RESOLUTION.** `GATE_FLAGS`
  enumerates no flag spellings, so an unlisted one WIDENS the match rather than
  losing it. `gh` takes `-R` / `--repo` in two slots and all three separator
  spellings (space, `=`, GLUED); a hand-rolled `-C`-only absorber let
  `gh -R <owner/repo> pr merge` walk past every merge gate. Build a new verb
  regex from `GATE_GH_C`, never by hand.
- **An incomplete parse may not ALLOW.** A gate must never relax a verdict on a
  word whose expansion it cannot see. The library once carried an ARGV splitter
  and a word-literality test for exactly this; both went with the only gate that
  used them, so a new gate needing them restores them from history rather than
  writing a looser copy. Enumerating more shell forms is the losing move; it was
  tried three times.
- Target resolution reads the payload cwd, then a leading `cd <path>`, then the
  LAST `git`/`gh -C <path>` in the matched segment. An UNEXPANDED path
  (`cd "$WT"`) is not a path and is skipped, which falls back to the payload cwd
  and so fails CLOSED.
