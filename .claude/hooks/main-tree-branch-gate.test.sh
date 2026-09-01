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
# THE FENCE ONLY CATCHES PARSE-TIME CONSTRUCTS, and the proof has to NAME the one
# it used, because the count is not a property of "bash 4" but of where the
# construct fails. Measured 2026-09-01 on this suite:
#
#   `${verb^^}` (case modification) inside `verdict_for`
#       -> 53 red under 3.2.57, 0 red under 5.3.9.  bash 3.2 answers
#          `${x^^}: bad substitution` and ABORTS the hook.
#   `declare -A x=()` at the top of the hook
#       -> 0 red under BOTH. bash 3.2 answers `declare: -A: invalid option` on
#          stderr and KEEPS GOING, so the gate still reaches its verdict and the
#          exit code never moves. A runtime error is invisible to this fence.
#
# So a future "is the hook still 3.2-clean?" probe must inject a construct that
# fails at PARSE time; a `declare -A` probe coming back green proves nothing.
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
# `master` as a real local branch, so checkout's `main|master` pass arm is
# DISCRIMINATING: without a branch of that name the `show-ref` below misses and
# the command passes whether the arm exists or not.
git -C "$main_repo" branch master

# A REMOTE-tracking ref with no local branch behind it: the shape a lane's
# branch has in a fresh clone, and the one `git checkout <name>` DWIMs into a
# local branch + switch.
#
# THE REMOTE IS CONFIGURED, not just fabricated in the ref namespace, and that
# correction matters because the earlier fixture only ran `update-ref`. Measured:
# with `refs/remotes/origin/ghost` present but NO `origin` in `git remote`,
# `git checkout ghost` is `error: pathspec 'ghost' did not match any file(s)` and
# HEAD stays — git's DWIM iterates the CONFIGURED remotes and their refspecs, it
# does not glob the ref namespace. So the two DWIM cases below used to assert a
# BLOCK for a command real git refuses, and only passed because the gate read the
# namespace directly. `wt-ghost-only` keeps that shape as its own control.
git -C "$main_repo" remote add origin "$main_repo"
git -C "$main_repo" update-ref refs/remotes/origin/wt-remote-only "$(git -C "$main_repo" rev-parse HEAD)"
git -C "$main_repo" update-ref refs/remotes/origin/topic/nested-remote-only "$(git -C "$main_repo" rev-parse HEAD)"
# `refs/remotes/origin/HEAD` is a SYMREF, present in essentially every clone, and
# `%(refname:lstrip=3)` renders it as the bare name `HEAD`.
git -C "$main_repo" update-ref refs/remotes/origin/main "$(git -C "$main_repo" rev-parse HEAD)"
git -C "$main_repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
# A remote whose NAME CONTAINS A SLASH. `git remote add a/b <url>` is accepted by
# real git — measured — and its branches land two levels deep, so a fixed
# `lstrip=3` yields `remote/wt-slashed-remote-only` while git DWIMs the bare name.
git -C "$main_repo" remote add nested/remote "$main_repo"
git -C "$main_repo" update-ref refs/remotes/nested/remote/wt-slashed-remote-only "$(git -C "$main_repo" rev-parse HEAD)"
# A ref under a remote that is NOT configured: real git does not DWIM it.
git -C "$main_repo" update-ref refs/remotes/ghostremote/wt-ghost-only "$(git -C "$main_repo" rev-parse HEAD)"
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

# The SAME main checkout reached through a SYMLINK. macOS resolves `/tmp` to
# `/private/tmp`, so a payload cwd routinely carries a spelling that
# `git worktree list --porcelain` never emits — it always prints the real path.
# `canonicalize` is what makes the two compare equal, and NOTHING in this suite
# could see it, because the fixture root is `pwd -P`'d at the top and every path
# built from it is already canonical. The fence has to feed the symlinked
# spelling deliberately.
symlinked_main="$TMPROOT/symlinked-main"
ln -s "$main_repo" "$symlinked_main"

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
  # ONE hook run per case. The earlier shape ran the hook a SECOND time only to
  # read `$?`, so every case paid twice and the verdict came from a different
  # process than the message printed beside it. `$?` after the assignment is the
  # pipeline's status, and the hook is its last stage.
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1)
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
# NOT `run_case`: with EITHER of the two arms that produce this verdict deleted,
# the OTHER one still blocks, so an exit-code-only case is a control that reads as
# a fence. The MESSAGE is what separates them — drop the `-` token arm and `-`
# falls through as a plain positional, reported as "switches to feature branch
# '-'", a name the reader is then told to replay in a worktree.
run_case_msg "git switch - in main checkout blocked conservatively" 2 \
  "$(payload "$main_repo" 'git switch -')" \
  "switches to the previous branch" "feature branch '-'"
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
# The `have=` is the WHOLE PHRASE, not the bare name: the refusal echoes the
# command it blocked (`command: git switch -f some-feature`), so a bare
# `some-feature` matches that echo and only the `nothave` half discriminates.
run_case_msg "git switch -f <branch> names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git switch -f some-feature')" \
  "switches to feature branch 'some-feature'" "feature branch '-f'"
# `--orphan` creates a branch under both verbs.
run_case_msg "git switch --orphan names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git switch --orphan wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--orphan'"
run_case_msg "git checkout --orphan names the branch, not the flag" 2 \
  "$(payload "$main_repo" 'git checkout --orphan wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--orphan'"
# `--help` prints text and touches no tree.
# A FENCE: delete the `--help` arm and this becomes a bare `git switch` with no
# positional, which the conservative arm blocks.
run_case "git switch --help allowed" 0 \
  "$(payload "$main_repo" 'git switch --help')"
# A CONTROL, labelled as one rather than dressed up. Under `checkout` a missing
# `--help` arm leaves zero positionals, which the `npos -ne 1` restore arm allows
# anyway, so no mutation of the `--help` handling can redden this line. It is kept
# because it pins the OUTCOME users depend on, not because it discriminates.
run_case "git checkout --help allowed (control: no mutation reddens it)" 0 \
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
# `refs/remotes/origin/HEAD` is a SYMREF and exists in essentially every clone.
# Under `%(refname:lstrip=3)` it renders as the bare name `HEAD`, so
# `git checkout HEAD` was BLOCKED as "creates a local branch tracking remote
# 'HEAD'". Real git leaves HEAD exactly where it was — measured, `before=main
# after=main` — and refuses to create a branch of that name at all ("'HEAD' is
# not a valid branch name"), so there is no candidate being given up.
run_case "git checkout HEAD is not a DWIM branch create, allowed" 0 \
  "$(payload "$main_repo" 'git checkout HEAD')"
# A remote whose NAME CONTAINS A SLASH defeats a fixed `lstrip=3`: `git remote add
# a/b <url>` is accepted by real git and its `deep-only` branch lands at
# `refs/remotes/a/b/deep-only`, which lstrips to `b/deep-only` while git DWIMs the
# bare `deep-only` — measured, "Switched to a new branch 'deep-only'", HEAD moved.
run_case "git checkout <branch on a SLASHED remote> blocked" 2 \
  "$(payload "$main_repo" 'git checkout wt-slashed-remote-only')"
# CONTROL, and it is the correction the fixture above records: a ref sitting under
# `refs/remotes/<x>/` whose `<x>` is NOT a configured remote is not DWIMed by git.
# Measured — `error: pathspec 'ghost' did not match any file(s) known to git`,
# HEAD unmoved — because git iterates the configured remotes and their refspecs
# rather than globbing the ref namespace.
run_case "a ref under an UNCONFIGURED remote is not DWIMed, allowed" 0 \
  "$(payload "$main_repo" 'git checkout wt-ghost-only')"

# --- GLUED FLAG VALUES: git's parse-options, not a list of spellings ----------
#
# SIX LIVE FAIL-OPENS, each a command that really moves HEAD and each scoring
# rc=0 against the first revision of this gate. Every "want" was settled against
# real git first, printing HEAD before and after:
#
#   git checkout -bfeat                          rc=0  want 2  (HEAD main->feat)
#   git checkout -Bfeat                          rc=0  want 2  (HEAD main->feat)
#   git checkout --orphan=feat                   rc=0  want 2  (HEAD main->feat)
#   git checkout --track=direct origin/<b>       rc=0  want 2  (creates <b>)
#   git checkout -tdirect origin/<b>             rc=0  want 2  (creates <b>)
#   git checkout --conflict merge some-feature   rc=0  want 2  (HEAD main->some-feature)
#
# The cause is not six missing arms: git takes the REMAINDER of a short cluster
# as the option's value (`git checkout -fb clus` and `git checkout -qbclus` both
# created `clus` — measured) and takes `--long=value`. So the walk parses, and
# these cases pin the parse rather than the spellings.
run_case_msg "glued -b<branch> creates a branch" 2 \
  "$(payload "$main_repo" 'git checkout -bwt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'-bwt-feat-new'"
run_case_msg "glued -B<branch> creates a branch" 2 \
  "$(payload "$main_repo" 'git checkout -Bwt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'-Bwt-feat-new'"
run_case_msg "glued -c<branch> creates a branch" 2 \
  "$(payload "$main_repo" 'git switch -cwt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "no resolvable target"
run_case_msg "glued -C<branch> creates a branch" 2 \
  "$(payload "$main_repo" 'git switch -Cwt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "no resolvable target"
run_case_msg "--create=<branch> creates a branch" 2 \
  "$(payload "$main_repo" 'git switch --create=wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "no resolvable target"
run_case_msg "--force-create=<branch> creates a branch" 2 \
  "$(payload "$main_repo" 'git switch --force-create=wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "no resolvable target"
run_case_msg "--orphan=<branch> creates a branch under checkout" 2 \
  "$(payload "$main_repo" 'git checkout --orphan=wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'--orphan=wt-feat-new'"
run_case_msg "--orphan=<branch> creates a branch under switch" 2 \
  "$(payload "$main_repo" 'git switch --orphan=wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "no resolvable target"
# A cluster with BOOLEAN letters in front of the create letter. `-fb clus`
# created `clus` in real git, so a walk that only recognises a token EQUAL to
# `-b` misses it.
run_case_msg "a boolean letter before the create letter in one cluster" 2 \
  "$(payload "$main_repo" 'git checkout -fbwt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'-fbwt-feat-new'"
run_case_msg "a cluster whose create letter takes the NEXT token" 2 \
  "$(payload "$main_repo" 'git checkout -fb wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'-fb'"
# `--track` / `-t` take an OPTIONAL value, so the ref after them is a start-point
# POSITIONAL and the branch git creates is its last segment — measured, HEAD went
# `main` -> `remote-only` for `git checkout -t origin/remote-only`.
run_case_msg "--track=<mode> still names the LOCAL branch git creates" 2 \
  "$(payload "$main_repo" 'git checkout --track=direct origin/wt-remote-only')" \
  "creates new feature branch 'wt-remote-only'" "origin/wt-remote-only'"
run_case_msg "-t<mode> glued still names the LOCAL branch git creates" 2 \
  "$(payload "$main_repo" 'git checkout -tdirect origin/wt-remote-only')" \
  "creates new feature branch 'wt-remote-only'" "origin/wt-remote-only'"
run_case_msg "long-form --track names the LOCAL branch git creates" 2 \
  "$(payload "$main_repo" 'git checkout --track origin/wt-remote-only')" \
  "creates new feature branch 'wt-remote-only'" "origin/wt-remote-only'"
# The `-t` PRECEDENCE guard: an explicit create flag names the branch outright,
# whichever side of `-t` it sits on. Measured: git creates `wt-feat-new` for both
# orders.
run_case_msg "-b wins over -t whichever order they appear in" 2 \
  "$(payload "$main_repo" 'git checkout -b wt-feat-new -t origin/wt-remote-only')" \
  "creates new feature branch 'wt-feat-new'" "'wt-remote-only'"
run_case_msg "-t before -b still names the -b branch" 2 \
  "$(payload "$main_repo" 'git checkout -t origin/wt-remote-only -b wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'wt-remote-only'"

# --- A VALUE-TAKING FLAG IS NOT A POSITIONAL ---------------------------------
#
# `[ "$npos" -ne 1 ] && return 1` read any command with two leftover positionals
# as a file restore, so ONE required-value flag in front of the branch turned a
# real switch into an allow. Measured: `git checkout --conflict merge
# some-feature` moved HEAD from `main` to `some-feature` and scored rc=0.
run_case_msg "a value-taking flag before the branch does not make it a restore" 2 \
  "$(payload "$main_repo" 'git checkout --conflict merge some-feature')" \
  "switches to feature branch 'some-feature'" "'merge'"
# The same shape under `switch` BLOCKED either way (any non-main positional does),
# so only the message discriminates — and it named `merge`, a branch that does not
# exist, in the recipe telling the reader what to replay in a worktree.
run_case_msg "a value-taking flag under switch names the branch, not its value" 2 \
  "$(payload "$main_repo" 'git switch --conflict merge some-feature')" \
  "switches to feature branch 'some-feature'" "feature branch 'merge'"
# CONTROL: the `=` spelling glues the value, so nothing is consumed and the
# positional count is unchanged. Both spellings must reach the same verdict.
run_case_msg "the --conflict=<style> spelling reaches the same verdict" 2 \
  "$(payload "$main_repo" 'git checkout --conflict=merge some-feature')" \
  "switches to feature branch 'some-feature'" "'merge'"

# --- `-` AND `@{-1}` ARE THE PREVIOUS BRANCH UNDER BOTH VERBS -----------------
#
# Only `switch` had an arm; the comment claimed `checkout` "counted it as a
# positional and judged below", where the judging is `show-ref refs/heads/-` plus
# a DWIM lookup — both miss, so it fell through to allow. Measured with a real
# previous branch: all four spellings moved HEAD from `main` to `some-feature`.
run_case_msg "git checkout - is the previous branch, blocked" 2 \
  "$(payload "$main_repo" 'git checkout -')" \
  "switches to the previous branch"
run_case_msg "git checkout @{-1} is the previous branch, blocked" 2 \
  "$(payload "$main_repo" 'git checkout @{-1}')" \
  "switches to the previous branch"
run_case_msg "git switch @{-1} is the previous branch, blocked" 2 \
  "$(payload "$main_repo" 'git switch @{-1}')" \
  "switches to the previous branch"
# CONTROLS: with a `--` the same token is a tree-ish to restore FROM and HEAD
# stays — measured for both spellings. Without these, "block any command
# containing `-`" scores green above.
run_case "git checkout - -- <path> is a restore, allowed" 0 \
  "$(payload "$main_repo" 'git checkout - -- README.md')"
run_case "git checkout @{-1} -- <path> is a restore, allowed" 0 \
  "$(payload "$main_repo" 'git checkout @{-1} -- README.md')"

# --- FILE-RESTORE FLAGS ARE NOT BRANCH SWITCHES ------------------------------
#
# `git checkout -p <branch>` prints a hunk picker and leaves HEAD alone —
# measured, `before=main after=main` — and `--ours` / `--theirs` are refused
# outright when combined with a switch ("fatal: '--ours/--theirs' cannot be used
# with switching branches"). Blocking them is the same false-block family as the
# `<branch> -- <paths>` restore this gate already fixed.
run_case "git checkout -p <branch> is a hunk picker, allowed" 0 \
  "$(payload "$main_repo" 'git checkout -p some-feature')"
run_case "git checkout -U3 -p <branch> is a hunk picker too, allowed" 0 \
  "$(payload "$main_repo" 'git checkout -U3 -p some-feature')"
run_case "git checkout --ours <path> is a restore, allowed" 0 \
  "$(payload "$main_repo" 'git checkout --ours README.md')"
# CONTROL: without a restore flag the identical positional blocks, so the three
# cases above are not satisfied by "allow anything naming some-feature".
run_case "git checkout <branch> alone still blocks" 2 \
  "$(payload "$main_repo" 'git checkout some-feature')"

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

# --- ARMS THAT SURVIVED DELETION ALONE ---------------------------------------
#
# Each of these arms could be deleted with the suite still green: nothing drove
# the arm as the DECIDING one. An arm no case can redden is not covered, it is
# only present.

# The `--` token arm. Only its ALLOW verdict was pinned, by
# `git checkout -- README.md`, whose name is not a branch — so deleting the arm
# left that case green (the `--` fell through as a flag, `README.md` as a lone
# positional that `show-ref` misses). With a name that IS a local branch the arm
# is load-bearing: real git treats it as a pathspec and refuses ("pathspec
# 'some-feature' did not match any file(s)"), HEAD unmoved.
run_case "git checkout -- <name that is also a branch> is a pathspec, allowed" 0 \
  "$(payload "$main_repo" 'git checkout -- some-feature')"
# checkout's `master` pass arm. `master` exists as a local branch in this fixture,
# so without the arm `show-ref` hits and the command blocks.
run_case "git checkout master in main checkout allowed" 0 \
  "$(payload "$main_repo" 'git checkout master')"
# switch's `-C` and checkout's `-B` force-create arms, each named rather than
# merely blocked: without the arm the flag falls through and the verdict is
# reported as a switch to a branch named `-C` / `-B` (or, under switch, as "no
# resolvable target").
run_case_msg "git switch -C <branch> is a create, and names the branch" 2 \
  "$(payload "$main_repo" 'git switch -C wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'-C'"
run_case_msg "git checkout -B <branch> is a create, and names the branch" 2 \
  "$(payload "$main_repo" 'git checkout -B wt-feat-new')" \
  "creates new feature branch 'wt-feat-new'" "'-B'"

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

# --- THE PAYLOAD CWD REACHED THROUGH A SYMLINK -------------------------------
#
# `canonicalize` was a LIVE BYPASS with no case: delete it and the whole suite
# still reads 54/0, because `TMPROOT` is `pwd -P`'d at the top and every fixture
# path built from it is already canonical, so the hook never sees a spelling that
# needs resolving. Real payloads do: macOS resolves `/tmp` to `/private/tmp`, and
# `git worktree list --porcelain` always emits the real path while the payload
# `cwd` may carry the symlink. Driven through the symlinked spelling the shipped
# gate is 2 and the same gate without `canonicalize` is 0.
run_case "git switch -c <feat> through a SYMLINKED main-checkout path blocked" 2 \
  "$(payload "$symlinked_main" 'git switch -c wt-feat-new')"
# ...and the allow side through the same spelling, so the case above is not
# satisfied by "block everything reached through a symlink".
run_case "git switch main through a SYMLINKED main-checkout path allowed" 0 \
  "$(payload "$symlinked_main" 'git switch main')"

# --- A `-C`-CARRYING CHECKOUT AS THE DECIDING SEGMENT ------------------------
#
# `GATE_RE_GIT_CHECKOUT` could lose its `${GATE_FLAGS}` run — the part that
# absorbs `git -C <path>` before the verb — and redden NOTHING in either suite:
# the library block binds only the switch ERE, and every gate case that carried a
# `-C` on a CHECKOUT had a different segment deciding the verdict.
run_case "git -C <main> checkout -b <feat> from a worktree blocked" 2 \
  "$(payload "$worktree_dir" "git -C $main_repo checkout -b wt-probe")"

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
# A SLASHED branch name must not print a NESTED lane directory. The convention is
# one flat `.worktrees/<name>` per lane, and `.worktrees/topic/nested` is a layout
# nothing else in this repo uses — `git worktree remove .worktrees/topic/nested`
# then leaves an empty `.worktrees/topic/` behind. The BRANCH keeps its slash,
# since that is what the reader asked for; only the directory is flattened.
run_case_msg "a slashed branch name still prints a FLAT lane directory" 2 \
  "$(payload "$main_repo" 'git switch -c wt-topic/nested')" \
  "git worktree add .worktrees/topic-nested -b wt-topic/nested origin/main" \
  ".worktrees/topic/nested"

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
CASE_FLOOR=92
# The total is read BEFORE the failure is counted. Incrementing first made the
# message report the floor's own failure as a case that ran, so a suite one case
# short printed "only 54 cases ran, expected at least 54".
ran=$((pass + fail))
if [ "$ran" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL case floor: only $ran cases ran, expected at least $CASE_FLOOR\n"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
