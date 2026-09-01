#!/usr/bin/env bash
# Smoke test for main-tree-branch-gate.sh.
#
# Builds fixture main-checkout + linked-worktree pairs and drives the hook with
# real payloads, asserting BLOCK (exit 2) and ALLOW (exit 0) outcomes. Run from
# the repo root:  bash .claude/hooks/main-tree-branch-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-branch-gate.sh"

TMPROOT="$(cd "$(mktemp -d)" && pwd -P)"

# --- BASH 3.2 FENCE ---
# macOS ships bash 3.2 as /bin/bash and this repo runs on it, so the hook has to
# stay 3.2-clean. Running THIS FILE under /bin/bash proves nothing about the
# hook: every case invokes it as "$HOOK", whose shebang is `#!/usr/bin/env bash`
# and resolves through PATH — normally a Homebrew 5.x build. So a shim directory
# holding one symlink named `bash` goes FIRST on PATH, and every child `bash`
# (the shebang included) is the fenced interpreter.
#
# Default /bin/bash; override with HOOK_BASH to take the other tally. An
# explicitly set HOOK_BASH that is not executable is FATAL rather than a silent
# fall back to PATH bash — falling back hides a typo in the one setting this
# fence exists to pin and reports a tally under an interpreter nobody asked for.
# Only the built-in DEFAULT may fall back, since a machine without /bin/bash is a
# fact rather than a mistake.
SHIMDIR="$TMPROOT/bash-shim"
mkdir -p "$SHIMDIR"
trap 'rm -rf "$TMPROOT"' EXIT
if [ -n "${HOOK_BASH:-}" ]; then
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 2
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook interpreter\n' >&2
    exit 2
  }
fi
ln -sf "$HOOK_BASH" "$SHIMDIR/bash"
PATH="$SHIMDIR:$PATH"
export PATH
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

# --- fixtures ----------------------------------------------------------------
#
# A main checkout with `.markgate.yml` (the repo opt-in signal) and one linked
# worktree at `.worktrees/feat-x`, which is where this repo's lanes live.
main_repo="$TMPROOT/main-repo"
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$main_repo/.markgate.yml"
git -C "$main_repo" branch wt-feat-x
git -C "$main_repo" branch some-feature
# A REMOTE-tracking ref with no local branch behind it: the shape a lane's
# branch has in a fresh clone, and the one `git checkout <name>` DWIMs into a
# local branch + switch.
git -C "$main_repo" update-ref refs/remotes/origin/wt-remote-only "$(git -C "$main_repo" rev-parse HEAD)"
git -C "$main_repo" update-ref refs/remotes/origin/topic/nested-remote-only "$(git -C "$main_repo" rev-parse HEAD)"
mkdir -p "$main_repo/.worktrees"
worktree_dir="$main_repo/.worktrees/feat-x"
git -C "$main_repo" worktree add -q "$worktree_dir" wt-feat-x

# A SECOND main checkout whose path contains a SPACE. `main_tree_of` reads the
# `git worktree list --porcelain` line with `substr($0, 10)`; the `$2` spelling
# the sibling cdk-local carried truncates at the space, so the compare against
# the target dir never matches and the gate stands down over a main checkout it
# mis-read. Every fixture path in that suite was space-free, which is why it
# stayed green over the defect.
space_repo="$TMPROOT/main repo with spaces"
git init -q -b main "$space_repo"
git -C "$space_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$space_repo/.markgate.yml"

# A repo that does NOT opt in (no `.markgate.yml`): a personal blog or scratch
# clone worked on from this session has no parallel-lane contention.
optout_repo="$TMPROOT/optout-repo"
git init -q -b main "$optout_repo"
git -C "$optout_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

pass=0
fail=0
fail_log=""

# run_case <name> <want-exit> <payload>
run_case() {
  local name="$1" want="$2" payload="$3"
  local out got
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1)
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: want exit $want, got $got\n"
    fail_log="${fail_log}  payload: $payload\n"
    fail_log="${fail_log}  output : $out\n"
  fi
}

# The exit code alone cannot say WHAT a block is about, and the message is the
# whole product of a block — it names the branch to replay in a worktree. So a
# gate that blocks for the right reason and NAMES THE WRONG THING is green under
# `run_case`.
#
# run_case_msg <name> <want-exit> <payload> <must-contain> [<must-not-contain>]
run_case_msg() {
  local name="$1" want="$2" payload="$3" have="$4" nothave="${5:-}"
  local out got why=""
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1)
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  [ "$got" = "$want" ] || why="want exit $want, got $got"
  printf '%s' "$out" | grep -qF -- "$have" || why="${why:+$why; }message lacks [$have]"
  if [ -n "$nothave" ] && printf '%s' "$out" | grep -qF -- "$nothave"; then
    why="${why:+$why; }message wrongly contains [$nothave]"
  fi
  if [ -z "$why" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s, names [%s])\n' "$name" "$got" "$have"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: $why\n"
    fail_log="${fail_log}  payload: $payload\n"
    fail_log="${fail_log}  output : $out\n"
  fi
}

# payload <dir> <command>
payload() { jq -cn --arg d "$1" --arg c "$2" '{cwd:$d,tool_input:{command:$c}}'; }

# --- ALLOW cases --------------------------------------------------------------

run_case "git switch main in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git switch main')"
run_case "git checkout main in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git checkout main')"
run_case "git switch master in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git switch master')"
run_case "git switch -c <feat> in a worktree allowed" 0 \
  "$(payload "$worktree_dir" 'git switch -c wt-feat-new')"
run_case "git switch <feat> in a worktree allowed" 0 \
  "$(payload "$worktree_dir" 'git switch some-feature')"
run_case "git checkout -- <pathspec> in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git checkout -- README.md')"
HEAD_SHA=$(git -C "$main_repo" rev-parse HEAD)
run_case "git checkout <sha> in main checkout allowed" 0 \
  "$(payload "$main_repo" "git checkout $HEAD_SHA")"
run_case "git worktree add in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git worktree add .worktrees/x -b wt-x origin/main')"
run_case "git status in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git status')"
run_case "empty payload allowed" 0 ''
run_case "git switch -c <feat> in a NON-opted-in repo allowed" 0 \
  "$(payload "$optout_repo" 'git switch -c wt-feat-new')"
run_case "non-repo target dir passes through" 0 \
  "$(payload "$TMPROOT" 'git switch foo')"

# --- BLOCK cases --------------------------------------------------------------

run_case "git switch -c <feat> in main checkout blocked" 2 \
  "$(payload "$main_repo" 'git switch -c wt-feat-new')"
run_case "git checkout -b <feat> in main checkout blocked" 2 \
  "$(payload "$main_repo" 'git checkout -b wt-feat-new')"
run_case "git switch - in main checkout blocked conservatively" 2 \
  "$(payload "$main_repo" 'git switch -')"
run_case "cd <main> && git switch <feat> from a worktree blocked" 2 \
  "$(payload "$worktree_dir" "cd $main_repo && git switch some-feature")"
run_case "git -C <main> switch <feat> blocked" 2 \
  "$(payload "$worktree_dir" "git -C $main_repo switch some-feature")"

# --- THE BLOCKING ARMS, PINNED ------------------------------------------------
#
# In the sibling cdk-local, DELETING `verdict_for`'s plain-switch arm or its
# `show-ref` local-branch arm left the whole suite GREEN: every pass arm was
# pinned and neither block arm was. Both are pinned here WITH the control that
# makes them discriminating — an arm asserted only by its BLOCK case is also
# satisfied by a gate that blocks everything.

# switch's `*)` arm: a bare name that is not main/master.
run_case "git switch <other-branch> in main checkout blocked" 2 \
  "$(payload "$main_repo" 'git switch some-feature')"
# checkout's show-ref arm: the name resolves to a LOCAL branch -> block...
run_case "git checkout <existing local branch> in main checkout blocked" 2 \
  "$(payload "$main_repo" 'git checkout some-feature')"
# ...and its CONTROL: an identical shape whose name is NOT a local branch is a
# pathspec / sha and must pass. Without this, "block on any bare token" scores
# green on the case above.
run_case "git checkout <name that is not a local branch> allowed" 0 \
  "$(payload "$main_repo" 'git checkout docs/no-such-branch-here')"

# --- ARGUMENT SHAPES THE TWO-TOKEN PORT GOT WRONG ------------------------------
#
# The sibling shape read token 1 and token 2 only. Both directions were wrong,
# and both were measured against a real repo before these cases were written
# (HEAD printed before and after each command):
#
#   git checkout <branch> -- <paths>   BLOCKED, and must not be. It restores
#     FILES; HEAD stayed on `main`. It is also the spelling CLAUDE.md MANDATES
#     for the orchestrator ("integrates by `git checkout <branch> -- <files>`,
#     NEVER `git merge`") — so the ported gate refuses this repo's own
#     integration step. The `--`-less form behaves identically.
#   git checkout -f <branch>           ALLOWED, and must not be. `-f` was read AS
#     the branch name, `refs/heads/-f` does not resolve, and the gate passed;
#     the command switched the tree to `feat`.
run_case "git checkout <branch> -- <path> is a file restore, allowed" 0 \
  "$(payload "$main_repo" 'git checkout some-feature -- README.md')"
run_case "git checkout <branch> <path> without -- is also a restore, allowed" 0 \
  "$(payload "$main_repo" 'git checkout some-feature README.md')"
run_case "git checkout -f <branch> blocked (a flag is not the branch name)" 2 \
  "$(payload "$main_repo" 'git checkout -f some-feature')"
# Under `switch` a leading flag blocks EITHER WAY (the sibling shape reads `-f`
# as the branch name and blocks because it is not main/master), so the exit code
# alone fences nothing here — the MESSAGE is what differs, and it is the name the
# refusal tells you to replay in a worktree.
run_case_msg "git switch -f <branch> names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git switch -f some-feature')" \
  "some-feature" "feature branch '-f'"
# `--orphan` creates a branch under both verbs.
run_case_msg "git switch --orphan names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git switch --orphan wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--orphan'"
run_case_msg "git checkout --orphan names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git checkout --orphan wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--orphan'"
# `--help` prints text and touches no tree.
run_case "git switch --help allowed" 0 \
  "$(payload "$main_repo" 'git switch --help')"
run_case "git checkout --help allowed" 0 \
  "$(payload "$main_repo" 'git checkout --help')"

# --- DWIM / --track: a branch that exists only on a REMOTE ---------------------
#
# All three implementations passed these, and both CREATE a local branch and
# switch to it — measured on a real clone: HEAD went `main` -> `feat`, git
# printing "Switched to a new branch". The local-only `show-ref` was blind to the
# way a lane's branch usually FIRST appears in a checkout.
run_case "git checkout <remote-only branch> blocked (DWIM creates + switches)" 2 \
  "$(payload "$main_repo" 'git checkout wt-remote-only')"
run_case_msg "git checkout -t origin/<b> names the LOCAL branch it creates" 2 \
  "$(payload "$main_repo" 'git checkout -t origin/wt-remote-only')" \
  "creates new feature branch 'wt-remote-only'" "origin/wt-remote-only'"
# CONTROL: a name that is neither local nor remote is a pathspec / sha and must
# still pass. Without it, "block any bare token" scores green above.
run_case "git checkout <name on no remote either> still allowed" 0 \
  "$(payload "$main_repo" 'git checkout wt-remote-onl')"
# A SLASHED remote branch name. `for-each-ref 'refs/remotes/*/*'` does not list
# it — a `*` does not cross a `/` there — so the first revision of the DWIM arm
# was fail-open for every branch name with a slash, which is most of them in this
# flow. Measured: git DWIMs it just the same ("Switched to a new branch
# 'topic/nested'").
run_case "git checkout <nested remote-only branch> blocked too" 2 \
  "$(payload "$main_repo" 'git checkout topic/nested-remote-only')"

# --- QUOTED-BODY false positives ---------------------------------------------
#
# The literal substrings must not fire from inside a quoted argument of an
# unrelated command, plain and chained.
run_case "gh issue body quoting 'git switch' allowed" 0 \
  "$(payload "$main_repo" 'gh issue create --body "remember to git switch back to main after"')"
run_case "echo body quoting 'git checkout' allowed" 0 \
  "$(payload "$main_repo" 'echo "tip: git checkout -b some-feature in a worktree"')"
run_case "chained quoted mention of git switch -c allowed" 0 \
  "$(payload "$main_repo" 'git status && echo "do not run: git switch -c wt-probe"')"

# --- CHAINED command position -------------------------------------------------
#
# The awk walker these gates used to carry skipped to the FIRST `git` token in
# the WHOLE command, so `git fetch && git switch -c <b>` read `sub=fetch`, fell
# to its "unrecognised subcommand, fail open" arm and exited 0 — a live bypass in
# the exact spelling this repo's own skills print. The sibling suites had a
# `cd <main> && git switch` case and no `git <verb> && git switch` one, which is
# why it survived.
run_case "git fetch && git switch -c <feat> in main checkout blocked" 2 \
  "$(payload "$main_repo" 'git fetch origin && git switch -c wt-probe origin/main')"
run_case "git status; git checkout -b <feat> in main checkout blocked" 2 \
  "$(payload "$main_repo" 'git status --short; git checkout -b wt-probe')"
# The allowances must still hold when chained — otherwise the two cases above are
# satisfied by a gate that blocks any chained git.
run_case "git fetch && git switch main in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git fetch origin && git switch main')"
run_case "git status && git checkout -- <path> in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git status --short && git checkout -- README.md')"
run_case "git fetch && git switch -c <feat> in a WORKTREE allowed" 0 \
  "$(payload "$worktree_dir" 'git fetch origin && git switch -c wt-probe origin/main')"
# The verdict must come from the RIGHT segment: an allowed switch in segment 1
# must not excuse a blocking one in segment 2. A gate reading only the first
# matching segment passes this and fences nothing.
run_case "an allowed switch first does not excuse a blocking one after it" 2 \
  "$(payload "$main_repo" 'git switch main && git switch -c wt-probe')"

# --- PER-SEGMENT TREE RESOLUTION ---------------------------------------------
#
# The defect this port exists to NOT reproduce. Both siblings resolved the target
# tree ONCE per verb candidate, OUTSIDE the segment walk, so a command spanning
# two trees was judged against whichever tree the FIRST matching segment named.
# Measured against a real main checkout with a real linked worktree:
#
#                                                   before  after  want
#   git -C <wt> switch -c a && git switch -c b          0      2     2
#   git -C <wt> checkout -b a && git checkout -b b      0      2     2
#   git switch main && git -C <wt> switch -c a          2      0     0
#
# The first two let a branch be created in the SHARED main checkout unjudged; the
# third refuses the worktree branch creation the convention mandates.
run_case "worktree segment first does not excuse a main-checkout switch after it" 2 \
  "$(payload "$main_repo" "git -C $worktree_dir switch -c a && git switch -c wt-probe")"
run_case "worktree segment first does not excuse a main-checkout checkout after it" 2 \
  "$(payload "$main_repo" "git -C $worktree_dir checkout -b a && git checkout -b wt-probe")"
run_case "a main-checkout segment first does not condemn a worktree one after it" 0 \
  "$(payload "$main_repo" "git switch main && git -C $worktree_dir switch -c a")"
# A `cd` PERSISTS into later segments while a `-C` binds only its own command —
# the two halves of the per-segment resolution, each with its own false direction.
run_case "cd into a worktree carries into the next segment (allowed)" 0 \
  "$(payload "$main_repo" "cd $worktree_dir && git switch -c a && git switch -c b")"
run_case "a -C back at the main checkout after a cd to a worktree still blocks" 2 \
  "$(payload "$main_repo" "cd $worktree_dir && git switch -c a && git -C $main_repo switch -c wt-probe")"

# --- PATHS CONTAINING A SPACE -------------------------------------------------
#
# `main_tree_of`'s awk must read the WHOLE `worktree ` field. With `$2` the path
# is truncated at the first space, the canonicalized compare fails, and the gate
# stands down over a main checkout it mis-read.
run_case "git switch -c <feat> in a main checkout whose path has a space blocked" 2 \
  "$(payload "$space_repo" 'git switch -c wt-feat-new')"
run_case "git switch main in a main checkout whose path has a space allowed" 0 \
  "$(payload "$space_repo" 'git switch main')"

# --- THE MESSAGE NAMES THE BRANCH, NOT THE FLAG -------------------------------
#
# Reported in the siblings' review: `--create` / `--force-create` / `--detach`
# were printed AS the branch name, which is the name the refusal then tells the
# reader to replay in a worktree. The verdict was already right; the text was not.
#
# These assert the WHOLE phrase (`creates new feature branch '<name>'`), not just
# the name. Under the token walk a dropped create-flag falls through to the
# positional arm, which ALSO names the branch correctly — it just calls the
# creation a switch. Asserting the name alone was satisfied by that, so the case
# was a control rather than a fence until the phrase went in.
run_case_msg "long-form --create names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git switch --create wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--create'"
run_case_msg "long-form --force-create names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git switch --force-create wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--force-create'"
run_case_msg "--detach is reported as a detach, not as a branch named --detach" 2 \
  "$(payload "$main_repo" 'git switch --detach origin/main')" \
  "detaches HEAD" "feature branch '--detach'"

# --- THE MESSAGE PRINTS THIS REPO'S RECIPE ------------------------------------
#
# The layout is `.worktrees/<name>` with a `wt-<name>` branch, NOT cdkd's
# `.claude/worktrees/<branch>`, and the base is `origin/main`:
# `stale-base-gate.sh` opens with
# `git merge-base --is-ancestor "$base" HEAD || exit 0`, so it is INERT for a lane
# cut from a stale LOCAL `main`. Basing on `origin/main` is what turns it on. A
# refusal that prints the sibling's recipe sends the reader into the wrong layout
# and the inert gate.
run_case_msg "the refusal prints this repo's worktree recipe" 2 \
  "$(payload "$main_repo" 'git switch -c wt-feat-new')" \
  "git worktree add .worktrees/feat-new -b wt-feat-new origin/main" \
  ".claude/worktrees"

# --- FAIL-CLOSED on a missing shared library ----------------------------------
#
# A gate that cannot decide must not wave the command through. The check names
# `gate_verb_args_dir` as well as `gate_matches`, because a library predating it
# yields NO lines from the process substitution, the loop body never runs, and
# the gate exits 0 — a silent bypass with no error anywhere.
lib_probe="$TMPROOT/lib-probe"
mkdir -p "$lib_probe"
cp "$HOOK" "$lib_probe/main-tree-branch-gate.sh"
out=$(payload "$main_repo" 'git switch -c wt-feat-new' | "$lib_probe/main-tree-branch-gate.sh" 2>&1)
payload "$main_repo" 'git switch -c wt-feat-new' | "$lib_probe/main-tree-branch-gate.sh" >/dev/null 2>&1
got=$?
if [ "$got" = 2 ] && printf '%s' "$out" | grep -qF '_command-match.sh is missing'; then
  pass=$((pass + 1)); printf 'OK   missing shared library fails CLOSED (exit 2)\n'
else
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL missing shared library must fail closed: got exit $got, output [$out]\n"
fi
# ...and the same for a library that LOADS but predates `gate_verb_args_dir`.
sed '/^gate_verb_args_dir()/,$d' "$(dirname "$HOOK")/_command-match.sh" > "$lib_probe/_command-match.sh"
out=$(payload "$main_repo" 'git switch -c wt-feat-new' | "$lib_probe/main-tree-branch-gate.sh" 2>&1)
payload "$main_repo" 'git switch -c wt-feat-new' | "$lib_probe/main-tree-branch-gate.sh" >/dev/null 2>&1
got=$?
if [ "$got" = 2 ] && printf '%s' "$out" | grep -qF 'gate_verb_args_dir is undefined'; then
  pass=$((pass + 1)); printf 'OK   stale shared library (no gate_verb_args_dir) fails CLOSED (exit 2)\n'
else
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL stale shared library must fail closed: got exit $got, output [$out]\n"
fi

# A FLOOR on the case total. Deleting a case removes assertions SILENTLY while
# the tally still reads `Fail: 0`, so the only thing standing between a gutted
# suite and a green run is somebody noticing the number move. Raise it when cases
# are added; never lower it to make a red run green.
CASE_FLOOR=54
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL case floor: only $((pass + fail)) cases ran, expected at least $CASE_FLOOR\n"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
