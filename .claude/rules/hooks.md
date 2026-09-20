# When a hook may BLOCK, and when it may exist at all

**A gate may block only when the harm completes at the moment of the action AND
lands irreversibly on a THIRD PARTY's artifact, on ANOTHER SESSION's work, or on
the MAINTAINER's AWS account.** Everything else becomes a sentence in CLAUDE.md,
a unit test over `src/**`, or nothing. Ask the two clauses separately — is the
harm reversible, and whose artifact does it land on — never one about severity:
irreversibility alone would block a duplicate issue, the filer's own artifact.

**A hook that fails OPEN on an exotic shell shape is accepted as-is.** Quoting,
heredocs, substitutions, `bash -c`, `eval`, case arms and redirections can all
steer a command past a matcher. These hooks steer a COOPERATIVE agent away from
foot-guns; they are not a security boundary, and `main` is protected server-side
by a GitHub ruleset. Such a miss is not issue-worthy — record it in
[docs/tooling-backlog.md](../../docs/tooling-backlog.md) and build nothing until
it bites a SECOND time.

# The roster

## The shared `main` and other sessions' work

- **`branch-gate.sh`** — blocks `git commit` / `git push` when the TARGET
  working tree is on `main` / `master`, and when the MAIN checkout is on a
  DETACHED HEAD. A detached LINKED worktree keeps passing: that is the
  documented wind-down state for a lane that must not remove its worktree. The
  branch-NAME read alone could not see the detached case, and nothing refuses
  `git checkout <sha>` in the main checkout, so the hole was one allowed command
  away (go-to-k/cdkd#2402). The printed remedy follows the operation in
  progress, read from git's own state.

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

## Third-party artifacts

- **`ci-green-gate.sh`** — blocks `gh pr merge` unless EVERY GitHub Actions
  check on the target PR reports `pass` or `skipping`; `fail`, `pending` and
  "no checks reported" exit 2. A LIVE query, not a marker. An explicit `--admin`
  is the maintainer's conscious override and passes; the agent must never add it
  to get past a red CI. Fails OPEN when it cannot audit (no `gh`, not a git
  repo, no resolvable PR) — it blocks only when it can PROVE CI is not green.
  **A PR number does not name a pull request**: `42` exists in every repository,
  so the gate resolves the selector from the MATCHED verb's own segment and
  refuses a non-numeric token rather than letting a later bare `gh pr merge`
  inherit an earlier number.

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

**Repo opt-in.** `branch-gate.sh` fires ONLY in a repo carrying `.markgate.yml`
at the resolved target repo's top level. That file must therefore keep existing
even though only the unwired `integ` gate is declared in it.

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

Hooks must be bash 3.2 compatible. `branch-gate.test.sh` is the harness that
pins the interpreter: it puts a one-symlink shim directory first on PATH so
every child `bash` is the fenced one — `/bin/bash` by default, `HOOK_BASH=<path>`
for the other tally — prints on its first line which one it used, and treats an
explicitly set but non-executable `HOOK_BASH` as FATAL rather than falling back
to PATH bash. `scripts/run-hook-tests.sh` itself exports nothing; run it a second
time under `/bin/bash` to get the 3.2 tally. Every hook has a `.test.sh` beside
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
