#!/usr/bin/env bash
# Smoke test for branch-gate.sh.
#
# Exercises the cwd-aware branch resolution against fixture git
# worktrees, asserting both the BLOCK (exit 2) and ALLOW (exit 0)
# outcomes. Run from the repo root: `bash .claude/hooks/branch-gate.test.sh`.
#
# Why a shell script and not a vitest test: the hook IS a shell
# script, the contract IS the stdin JSON payload + exit code. A
# TypeScript wrapper would test the wrapper, not the hook.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/branch-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# --- BASH INTERPRETER FENCE (go-to-k/cdkd#2402) ------------------------------
# Running this SUITE under bash 3.2 did NOT run the HOOK under it. The hook is
# `#!/usr/bin/env bash`, which resolves through PATH and finds whatever bash is
# first there -- the 5.x on a dev Mac -- so running this SUITE under 3.2 would
# still have exercised a 5.x SUBJECT.
#
# TWO SEPARATE GAPS, and this shim closes only the second. `scripts/run-hook-tests.sh`
# runs each harness under ONE bash -- it has no per-shell loop and exports no
# HOOK_BASH, unlike cdkd's `run-tests.sh` -- so nothing here ran under 3.2 at
# all. Taking the 3.2 tally is therefore an explicit invocation for now:
#
#   HOOK_BASH=/bin/bash /bin/bash .claude/hooks/branch-gate.test.sh
#
# The interpreter is an explicit symlink at the FRONT of PATH, the shape
# cdk-local's `gate-command-recognition.test.sh` already uses. Default
# `/bin/bash`; `HOOK_BASH=/opt/homebrew/bin/bash` takes the 5.x tally. An
# explicitly set HOOK_BASH that is not executable is FATAL rather than a silent
# fall-back: a typo'd override that quietly ran the default would report the
# version it did not run.
#
# PROVEN TO REACH THE HOOK, not merely to be exported. With `;;&` (a bash-4
# `case` terminator, a PARSE error under 3.2 and valid syntax under 5.x)
# injected into the hook's detached-HEAD arm, this suite reports
# 39 pass / 8 fail under `HOOK_BASH=/bin/bash` and 47 pass / 0 fail under
# `HOOK_BASH=/opt/homebrew/bin/bash` -- same suite, same mutant, only the
# interpreter differs. A shim that did not reach the subject would print the
# same tally twice.
#
# PATH keeps its existing entries after the shim rather than being replaced with
# `/usr/bin:/bin`: the hook needs `jq`, which is not in either on every machine.
if [ -n "${HOOK_BASH:-}" ]; then
  # RESOLVE A BARE NAME BEFORE TESTING IT. `run-tests.sh` loops over the
  # CANDIDATES `bash` and `/bin/bash` and exports `HOOK_BASH="$shell"`, so the
  # PATH shell arrives here as the bare word `bash` -- and `-x` does no PATH
  # lookup, so testing the raw value FATALs on a perfectly good interpreter.
  # Measured: the first shape of this block failed the whole suite with
  # `FATAL - HOOK_BASH is not an executable: bash` on the 5.x pass of
  # `bash .claude/hooks/run-tests.sh`, while the 3.2 pass (an absolute
  # `/bin/bash`) passed -- so half the matrix went missing and the tally said
  # FAIL rather than saying nothing, which is the only reason it was caught.
  # The `ln -sf` below needs an absolute target anyway.
  case "$HOOK_BASH" in
    */*) ;;
    *) HOOK_BASH="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")" ;;
  esac
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 1
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook\n' >&2
    exit 1
  }
fi
SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
ln -sf "$HOOK_BASH" "$SHIM/bash"
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

# Two fixture git working trees: one on `main`, one on a feature branch.
# Both have a config user so commit works if we ever exercise it.
main_repo="$TMPDIR/main-repo"
feature_repo="$TMPDIR/feature-repo"
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b feature/x "$feature_repo"
git -C "$feature_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# Opt the fixtures into the gate (cdkd#1259): the gate only protects
# repos with a .markgate.yml at the repo root.
touch "$main_repo/.markgate.yml" "$feature_repo/.markgate.yml"
# A repo WITHOUT .markgate.yml (e.g. a personal blog repo worked on
# from a session rooted here) must never be gated, even on main.
optout_repo="$TMPDIR/optout-repo"
git init -q -b main "$optout_repo"
git -C "$optout_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# A main-branch repo whose path contains a SPACE. The gate's verb regex was a
# hand-rolled copy frozen at the pre-`GATE_FLAGS` token — its flag-value
# alternative had no quoted form — so `git -C "<path with space>" commit` matched
# NOTHING and committed straight to main. Measured 2026-08-25: rc=0 quoted vs
# rc=2 unquoted on the same repo.
spaced_repo="$TMPDIR/main repo with spaces"
git init -q -b main "$spaced_repo"
touch "$spaced_repo/.markgate.yml"
git -C "$spaced_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# --- DETACHED-HEAD fixture (go-to-k/cdkd#2402) -------------------------------
# A MAIN checkout that owns a real LINKED worktree. `main_repo` above cannot
# discriminate the two halves of the detached verdict, because it has no linked
# worktree for the allowed half to live in.
mt_repo="$TMPDIR/mt-repo"
mt_wt="$TMPDIR/mt-wt"
git init -q -b main "$mt_repo"
touch "$mt_repo/.markgate.yml"
mkdir -p "$mt_repo/sub"
touch "$mt_repo/sub/f.txt"
git -C "$mt_repo" -c user.email=t@t -c user.name=t add -A
git -C "$mt_repo" -c user.email=t@t -c user.name=t commit -q -m init
mt_sha=$(git -C "$mt_repo" rev-parse HEAD)
git -C "$mt_repo" -c user.email=t@t -c user.name=t worktree add -q "$mt_wt" -b lane/y
# The same fixture at a path containing a SPACE. `git worktree list --porcelain`
# emits one `worktree <path>` line, and reading it with awk's `$2` truncates at
# the space -- the compare then never matches and the gate stands down over a
# main checkout it mis-read. `substr($0, 10)` reads the whole field; this case
# is what says so.
mt_spaced="$TMPDIR/mt repo spaces"
mt_spaced_wt="$TMPDIR/mt wt spaces"
git init -q -b main "$mt_spaced"
touch "$mt_spaced/.markgate.yml"
git -C "$mt_spaced" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
mt_spaced_sha=$(git -C "$mt_spaced" rev-parse HEAD)
git -C "$mt_spaced" -c user.email=t@t -c user.name=t worktree add -q "$mt_spaced_wt" -b lane/s

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1) || true
  got=$?
  # The above always evaluates to 0 (`|| true`), so capture status
  # via a separate run.
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- ALLOW cases ---

# 1. Non-git command always passes through.
run_case "non-git command always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$main_repo")"

# 2. git command other than commit/push (e.g. status) is allowed even on main.
run_case "git status on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$main_repo")"

# 3. git commit on a feature branch — the happy path.
run_case "git commit on feature branch allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$feature_repo")"

# 4. git -C <feature> commit, even when cwd is on main → ALLOW
#    (the actual git operation targets the feature working tree).
run_case "git -C <feature> commit from main-cwd allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m wip"}}' "$main_repo" "$feature_repo")"

# 5. cd <feature> && git commit, even when payload cwd is main.
run_case "cd <feature> && git commit from main-cwd allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m wip"}}' "$main_repo" "$feature_repo")"

# 6. A dir that is not inside a git repo at all: nothing to read, so nothing to
#    gate. This case's name USED TO SAY "Detached HEAD / non-git dir", which
#    collapsed two conditions that share one observable (an empty
#    `symbolic-ref`) and are not the same thing -- a detached HEAD is a real
#    repo whose tree has LEFT `main`. That conflation is go-to-k/cdkd#2402; the
#    detached rows now live in their own block below, and this row keeps only
#    the reading it actually exercises.
run_case "non-git target dir allowed (genuinely nothing to see)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$TMPDIR")"

# --- ALLOW cases for read-only `git` commands that contain the literal
# words `commit` / `push` in args or refspecs (issue #281).
#
# Pre-fix the regex `\bgit[^|;&]*\b(commit|push)\b` matched any git
# invocation that mentioned `commit` / `push` anywhere on the line —
# blocking legitimate read-only ops like `git rev-parse <sha>^{commit}`
# even on `main`. The tightened regex requires `commit` / `push` to
# appear in the GIT SUBCOMMAND POSITION.

# 7a. `git rev-parse <sha>^{commit}` — `^{commit}` is git's peel-to-commit
#     syntax, NOT the commit subcommand. Must pass-through even on main.
run_case "git rev-parse <sha>^{commit} on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git rev-parse abc123^{commit}"}}' "$main_repo")"

# 7b. `git cat-file -e <sha>^{commit}` — same peel-to-commit; this is the
#     exact repro from the issue body.
run_case "git cat-file -e <sha>^{commit} on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git cat-file -e abc^{commit}"}}' "$main_repo")"

# 7c. `git log --grep=commit` — `commit` is a literal in a search query,
#     not the subcommand.
run_case "git log --grep=commit on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git log --grep=commit"}}' "$main_repo")"

# 7d. `git log --grep=push` — same shape for the `push` keyword.
run_case "git log --grep=push on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git log --grep=push"}}' "$main_repo")"

# 7e. `git diff <range> -- '*push*.md'` — `push` is part of a pathspec.
run_case "git diff with push pathspec on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git diff abc def -- '\''*push*.md'\''"}}' "$main_repo")"

# 7f. `git diff <range> -- '*commit*.md'` — same shape for `commit`.
run_case "git diff with commit pathspec on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git diff abc def -- '\''*commit*.md'\''"}}' "$main_repo")"

# 7g. `git rev-list HEAD..main --oneline | head -5` — read-only revlist
#     that pipes into another command; no commit/push subcommand.
run_case "git rev-list piped on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git rev-list HEAD..main --oneline | head -5"}}' "$main_repo")"

# 7h. `git symbolic-ref HEAD` — pure read; trivially shouldn't trigger.
run_case "git symbolic-ref HEAD on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git symbolic-ref HEAD"}}' "$main_repo")"

# --- BLOCK cases ---

# 7. Plain git commit when cwd is on main.
run_case "git commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$main_repo")"

# 8. git push on main blocked too.
run_case "git push on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin main"}}' "$main_repo")"

# 9. cd <main> && git commit from a feature-branch cwd. The cd target
#    is what matters, not the inherited cwd. THIS is the regression
#    case the rewrite fixes.
run_case "cd <main> && git commit from feature-cwd blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m oops"}}' "$feature_repo" "$main_repo")"

# 10. git -C <main> commit. Same logic via -C.
run_case "git -C <main> commit blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m oops"}}' "$feature_repo" "$main_repo")"

# 11. Single-line `git -C <a> status; git -C <b> commit` — the commit is NOT at
#     line-start. This used to be an ACCEPTED FALSE-NEGATIVE: the matcher was
#     anchored at line start, saw `git -C <feature> status` (not a commit), and
#     short-circuited, so a commit to main in the second segment ran ungated.
#     go-to-k/cdk-real-drift#1803 replaced the anchor with the shared segment
#     matcher in `_command-match.sh`, which splits the command list and matches
#     each segment — the quoted-body false positives that motivated the anchor
#     are handled by blanking quoted spans instead. The case is now a true
#     positive, and its target dir resolves to the SECOND `-C`.
run_case "single-line chained git -C status; git -C commit is caught" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s status; git -C %s commit -m oops"}}' "$feature_repo" "$feature_repo" "$main_repo")"

# 11a. The spellings go-to-k/cdk-real-drift#1803 measured running UNGATED against
#      the old line-start anchor. Each must now block, and a mention inside a
#      quoted argument must still not.
run_case "git add -A && git commit on main is caught" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git add -A && git -C %s commit -m oops"}}' "$main_repo" "$main_repo")"
run_case "leading env assignment is caught" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"GIT_EDITOR=true git -C %s commit -m oops"}}' "$main_repo" "$main_repo")"
run_case "subshell is caught" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"(cd %s && git commit -m oops)"}}' "$main_repo" "$main_repo")"
run_case "commit named inside a quoted argument is not a commit" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \\"next: git commit -m x\\""}}' "$main_repo")"

# 11b. `git -c <key>=<val> commit` — global `-c` flag before commit
#      subcommand. The tightened regex must not get confused by the
#      `<key>=<val>` token (which can contain the literal substring
#      `commit`, e.g. `commit.gpgSign=false`).
run_case "git -c commit.gpgSign=false commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -c commit.gpgSign=false commit -m oops"}}' "$main_repo")"

# 11c. `git push --force` on main — `--force` after the subcommand.
run_case "git push --force on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin --force"}}' "$main_repo")"

# --- REPO OPT-IN SCOPE cases (cdkd#1259) ---
#
# The gate must fire ONLY in repos that carry a .markgate.yml at the
# repo root. Sessions rooted here can touch unrelated personal repos
# (blog drafts, scratch clones) whose normal workflow is committing
# straight to main; those must pass through untouched.

# 11d. git commit on main in a NON-opted-in repo → allow.
run_case "git commit on main in non-opted-in repo allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m ok"}}' "$optout_repo")"

# 11e. git push on main in a NON-opted-in repo → allow.
run_case "git push on main in non-opted-in repo allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin main"}}' "$optout_repo")"

# --- Edge cases ---

# 12. Missing .cwd in payload → fall back to hook process $PWD.
#    Not exercised end-to-end (we'd need to control $PWD); just
#    confirm the hook does not crash on missing cwd.
run_case "missing .cwd does not crash" 0 \
  '{"tool_input":{"command":"git status"}}'

# 13. Empty stdin payload → cmd empty → allowed (nothing to gate).
run_case "empty stdin allowed" 0 \
  ''

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `git commit` /
# `git push` appear inside a quoted argument body of an unrelated
# command. Per memory rule feedback_hook_command_match_line_start.md,
# applied to branch-gate.sh in issue #563 (mirroring the PR #562 fix
# to check-gate.sh).

# 14. `gh issue create --body "...git commit..."` on main: the body
#     mentions `git commit` but the command itself starts with `gh`.
#     MUST pass through (would otherwise block routine issue creation).
run_case "gh issue body quoting 'git commit' on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"we should add a git commit hook later\""}}' "$main_repo")"

# 15. `echo "...git push..."` on main: the body mentions `git push`
#     but the command starts with `echo`. MUST pass through.
run_case "echo body quoting 'git push' on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"reminder: git push origin main later\""}}' "$main_repo")"

# 16. A QUOTED `-C` path containing a space, on main. The quoted alternative
#     lives in `GATE_FLAGS`; the hand-rolled copy this gate used never received
#     the go-to-k/cdk-local#542 fix that added it.
run_case "git -C \"<main with spaces>\" commit blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"%s\\" commit -m oops"}}' "$feature_repo" "$spaced_repo")"

# 17. Same path reached by `cd` instead of `-C` — the control that shows case 16
#     is about the FLAG parsing and not about the path being unusable.
run_case "cd \"<main with spaces>\" && git commit blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd \\"%s\\" && git commit -m oops"}}' "$feature_repo" "$spaced_repo")"

# --- DETACHED HEAD (go-to-k/cdkd#2402) ---------------------------------------
#
# `symbolic-ref --short HEAD` is EMPTY on a detached HEAD, so the gate's
# `case "$branch" in main|master)` matched neither arm and fell to `exit 0`.
# Measured on a scratch opted-in repo before the fix, same payload both times:
# rc=2 on `main`, rc=0 once detached -- while `main-tree-branch-gate.sh` passes
# `git checkout <sha>` in the main checkout, so the route to that state is one
# allowed command.
#
# BOTH POLARITIES ARE PINNED, because the fix has an allowed half that is easy
# to lose: a detached HEAD in a LINKED worktree is what this repo's own
# `stop-unmerged-lane-warn.sh` tells a session to do (`git switch --detach
# origin/main`) when it must not remove its worktree.

git -C "$mt_repo" checkout -q --detach "$mt_sha"

run_case "detached HEAD in the MAIN checkout: commit BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"
run_case "detached HEAD in the MAIN checkout: push BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin HEAD"}}' "$mt_repo")"
# The cwd one level DOWN. The gate compares TOPLEVELS rather than the raw
# resolved dir, so a subdirectory of the main checkout is still the main
# checkout. `main_tree_of` in main-tree-branch-gate.sh compares the raw dir and
# would answer "not the main checkout" here.
run_case "detached HEAD in the MAIN checkout, cwd a SUBDIR: BLOCKED" 2 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"
# Reached by `-C` from a LINKED worktree cwd, so the verdict is on the RESOLVED
# tree and not on where the session happens to be sitting.
run_case "detached MAIN checkout via -C from a worktree: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m oops"}}' "$mt_wt" "$mt_repo")"
# Polarity control at the VERB level: the new arm must not turn this gate into
# "refuse everything in a detached main checkout".
run_case "detached HEAD in the MAIN checkout: git status still allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$mt_repo")"

# The LINKED worktree, while the MAIN checkout is still detached -- so a gate
# that blocked on "some tree in this repo is detached" would fail here.
run_case "LINKED worktree on a branch, main checkout detached: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"

git -C "$mt_repo" checkout -q main

# The main checkout on a FEATURE branch, with a linked worktree present: the
# control that says the block above is about DETACHMENT and not about being the
# main checkout of a repo that has worktrees.
git -C "$mt_repo" checkout -q -b feat/z
run_case "MAIN checkout on a feature branch: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_repo")"
git -C "$mt_repo" checkout -q main
# ...and back on `main` it blocks again, by NAME, exactly as before.
run_case "MAIN checkout re-attached to main: commit BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"

# The ALLOWED half: a detached HEAD in a LINKED worktree.
git -C "$mt_wt" switch -q --detach "$mt_sha"
run_case "detached HEAD in a LINKED worktree: STILL ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"
run_case "detached HEAD in a LINKED worktree, cwd a SUBDIR: STILL ALLOWED" 0 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"
run_case "detached LINKED worktree via -C from the main checkout: ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m wip"}}' "$mt_repo" "$mt_wt")"
git -C "$mt_wt" switch -q lane/y

# A detached MAIN checkout whose PATH CONTAINS A SPACE. Both polarities, so a
# reader can see the space is the only variable.
git -C "$mt_spaced" checkout -q --detach "$mt_spaced_sha"
run_case "detached HEAD in a SPACED main checkout: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_spaced")"
run_case "detached HEAD in a SPACED linked worktree: ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_spaced_wt")"
git -C "$mt_spaced" checkout -q main

# The OPT-IN still governs the new arm: a detached HEAD in a repo with no
# `.markgate.yml` is none of this gate's business.
git -C "$optout_repo" checkout -q --detach HEAD
run_case "detached HEAD in a NON-opted-in repo: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m ok"}}' "$optout_repo")"
git -C "$optout_repo" checkout -q main

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
