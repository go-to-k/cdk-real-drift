#!/usr/bin/env bash
# branch-gate.sh
#
# PreToolUse hook. Blocks `git commit` and `git push` when the working
# tree the command will actually act on is on `main` / `master`. All
# changes to cdk-real-drift must land via PR from a feature branch —
# direct commits/pushes to main are not allowed.
#
# WHY the cwd-aware resolution matters: this repo is regularly worked
# in via `git worktree`. The previous implementation derived the repo
# root from `BASH_SOURCE` (the hook script's location), which in a
# worktree-copy invocation pointed at the worktree itself — so the
# hook checked the worktree's branch (a feature branch) and allowed
# the commit, even when the user's actual command did
# `cd /path/to/parent && git commit` and the commit landed on the
# parent worktree's `main`. Real-world incident: 2026-05-04 lambda fix
# session, see memory feedback_git_use_C_in_worktree.md.
#
# Resolution order for "where will the git command actually run":
#   1. Explicit `git -C <path> commit/push` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook input's `cwd` field (the Bash tool's persisted cwd).
#   4. The hook process's own $PWD (fallback, almost never reached).

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `git commit` / `git push` — any other command passes through.
#
# The trigger is DERIVED from the shared constants further down; this comment
# used to describe a hand-rolled regex, character class by character class, and
# that regex is gone. It also still advertised a limitation the shared matcher
# had already closed: it claimed the pattern was LINE-START anchored so a verb
# inside a quoted body could not false-positive, and that `` `git push` `` in a
# substitution matched. `gate_segments` supersedes both — it splits a command
# LIST and anchors each verb at a SEGMENT start, so `git add -A && git commit` is
# caught while a quoted mention still is not.
#
# Substitutions, precisely -- the replaced comment was wrong in BOTH directions,
# and so was its first replacement. Measured: `` echo `git push` `` matches and
# `foo=$(git commit -m x)` matches, but `echo "$(git commit -m x)"` does NOT: a
# `$(` inside a quoted span becomes the GATE_SEP_SUBST placeholder rather than a
# split point. So the UNQUOTED substitution forms are caught; the quoted one is
# the remaining false-negative.
#
# Keeping the old text was the exact hazard this lane's own thesis names: a stale
# local COPY of a shared thing. A prose copy rots the same way a regex copy does,
# and is harder to notice because nothing runs it -- which is why an orphaned tail
# of it survived the first rewrite and contradicted the paragraph above it.
# Fail CLOSED if the shared matcher is missing or does not load: a gate that
# cannot decide must not wave the command through. `[ -r … ] || exit 0` was the
# first shape here, and it silently disabled the gate whenever the library was
# unreadable or truncated — with the sibling gates' own comments claiming the
# opposite (go-to-k/cdkd#2130 review). The `declare -F` check catches a partial
# source, where `.` succeeds but the function is missing.
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/_command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/_command-match.sh loaded but gate_matches is undefined (truncated file?)." >&2
  exit 2
fi

# Which commands this gate applies to. The segment matcher sees a gated verb in
# ANY position — `git add -A && git commit` used to run ungated
# (go-to-k/cdk-real-drift#1803).
# DERIVED from the shared constants, never hand-rolled. This was the FOURTH
# local copy of a shared pattern, and it had frozen at the PRE-`GATE_FLAGS`
# token: its flag-value alternative was a bare `[^[:space:]-][^[:space:]]*`, with
# no quoted alternative, so a `-C` path containing a SPACE made the verb
# unreachable. Measured 2026-08-25 on an opted-in fixture repo sitting on `main`:
#
#   git -C /tmp/nospace commit -m x        rc=2
#   git -C "/tmp/bg fix" commit -m x       rc=0   <- commits straight to main
#   cd "/tmp/bg fix" && git commit -m x    rc=2
#
# `GATE_FLAGS` carries both quote characters as value alternatives, which is
# exactly the go-to-k/cdk-local#542 fix that this copy never received. A local
# copy of a shared pattern does not inherit its fixes -- the same lesson as the
# three `gh pr` gates in the previous commit.
GATE_RE_COMMIT_OR_PUSH=$(gate_re_any "$GATE_RE_GIT_COMMIT" "$GATE_RE_GIT_PUSH")
gate_matches "$cmd" "$GATE_RE_COMMIT_OR_PUSH" || exit 0

# Resolve where the command will actually run: a `-C <path>` in the matched
# segment wins, else the last `cd <path>` segment before it, else the payload cwd.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_COMMIT_OR_PUSH")

# Repo opt-in scope (cdkd#1259): this gate protects repos that follow
# the feature-branch + PR + markgate convention. A session rooted in
# such a repo can still run git against OTHER repos (a personal blog, a
# scratch clone) where committing straight to main is the normal
# workflow; the gate must not fire there. Opt-in signal: a
# `.markgate.yml` at the resolved target repo's top level. Repos
# without it pass through untouched.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

# Read the branch from the resolved target dir. `-C` lets git operate on a
# directory that isn't our cwd. An EMPTY answer is not one condition -- see the
# `if [ -z "$branch" ]` arm below, which is where that used to be got wrong.
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

# The MAIN-vs-LINKED distinction, in the shape `main-tree-branch-gate.sh`
# already uses: the main checkout is whatever `git worktree list --porcelain`
# lists FIRST. Reused rather than re-invented, per go-to-k/cdkd#2402 -- but two
# parts of that shape are deliberately NOT copied here, because each was
# measured to buy nothing at this call site:
#
#   NO MEMO. That gate asks the question once per matched SEGMENT and caches the
#   last answer in a pair of globals. This gate asks at most once per command,
#   so a memo would cache nothing.
#
#   NO `canonicalize`. That gate compares its RAW `<dir>` argument -- a payload
#   cwd, which may still carry a symlink -- against the porcelain path, so it
#   must resolve both. This gate compares `$target_top`, which git has ALREADY
#   resolved. Probed against git 2.x on macOS, where `/var` is a symlink to
#   `/private/var`, with `<dir>` also reached through a symlinked parent and
#   through a subdir under one -- `rev-parse --show-toplevel` returned the fully
#   resolved real path in all four shapes, byte-identical to `worktree list
#   --porcelain`'s first entry. A local `canonicalize` copy was written here
#   first and NO mutation could kill it, which is what sent the question to a
#   probe. If a future git ever stopped resolving `--show-toplevel`, this
#   compare would fail OPEN and the five BLOCK cases in `branch-gate.test.sh`
#   are what go red.
if [ -z "$branch" ]; then
  # `symbolic-ref --short HEAD` prints NOTHING in two situations that are not
  # the same thing, and the comment that used to stand here asserted only the
  # harmless one ("if the dir doesn't exist or isn't inside a git repo ... we
  # can't gate what we can't see"):
  #
  #   (a) there is no repo to read       -> genuinely invisible; pass through.
  #   (b) a real repo with a DETACHED HEAD -> the tree has LEFT `main`, which is
  #       exactly the state this gate exists to catch, wearing a spelling it
  #       could not see because it recognised the state only by branch NAME.
  #
  # (b) is reachable from the documented flow. `main-tree-branch-gate.sh`
  # deliberately passes `git checkout <sha>` in the main checkout (its own
  # `--detach` note carries the measurement, and keeps the verdict); the tree
  # detaches, and this gate then waved a commit straight into the SHARED main
  # checkout. Measured on a scratch opted-in repo before this arm existed,
  # driving this hook with a `git commit -m x` payload: rc=2 on `main`, rc=0
  # once detached. Two gates, a hole neither has alone (go-to-k/cdkd#2402).
  #
  # THE DISCRIMINATOR IS ALREADY IN HAND. `$target_top` is `rev-parse
  # --show-toplevel` from this same dir, and it is non-empty here because the
  # opt-in check above returned early otherwise. A non-empty toplevel IS a real
  # repo with a work tree, so an empty branch beside it can only mean a detached
  # HEAD; a second `rev-parse --git-dir` probe would fork again to re-learn what
  # `$target_top` already said.
  #
  # IT COMPARES TOPLEVELS, NOT THE RAW DIR, and that single choice removes TWO
  # independent failures. `main_tree_of` in the sibling gate compares its
  # `<dir>` argument, which is the payload cwd, so (i) a cwd one level down
  # (`cd <repo>/src && ...`) is not equal to the checkout root, and (ii) the cwd
  # still carries whatever symlink the caller typed, while the porcelain path
  # does not. `$target_top` has neither problem: git resolves both out of
  # `--show-toplevel`. Measured -- swapping this compare to `$target_dir` turns
  # ALL FIVE block rows in `branch-gate.test.sh` red, the subdir row for reason
  # (i) and the other four for reason (ii), since a macOS `mktemp -d` hands out
  # a `/var` path that git reports as `/private/var`.
  #
  # BLOCKED ONLY IN THE MAIN CHECKOUT. A detached HEAD in a LINKED worktree is
  # the remedy this repo's own Stop hook prints -- `stop-unmerged-lane-warn.sh`
  # tells a session that must not remove its worktree to run
  # `git switch --detach origin/main`, "because a worktree with no current
  # branch is not a lane". Blocking that would refuse a documented instruction.
  #
  # `substr($0, 10)` rather than `$2`, for the reason the sibling gate records:
  # awk splits on whitespace, so a checkout path containing a SPACE is truncated
  # at it and the compare below then never matches -- the gate standing down
  # over a main checkout it had mis-read. Fenced by the spaced-path case in
  # `branch-gate.test.sh`.
  main_checkout=$(git -C "$target_dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  if [ "$target_top" = "$main_checkout" ]; then
    echo "Blocked by branch-gate: target git working tree has a DETACHED HEAD in the MAIN checkout." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  main checkout      : $main_checkout" >&2
    echo "  HEAD               : $(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || echo '?')" >&2
    echo "  command: $cmd" >&2
    echo "A detached HEAD is not a feature branch, and this is the SHARED main checkout," >&2
    echo "so a commit here puts off-branch work in the tree every other lane reads." >&2
    echo "Re-attach first: git -C \"$main_checkout\" switch main" >&2
    echo "Then do the work in its own worktree: git worktree add <path> -b fix/xxx origin/main" >&2
    echo "A detached HEAD in a LINKED worktree is NOT blocked -- that is the documented" >&2
    echo "way to clear a lane." >&2
    exit 2
  fi
  # FAIL-OPEN, deliberate and stated. Three readings reach this line, and the
  # compare above sends all three here without needing a guard of their own,
  # since `$target_top` is non-empty and so can equal none of the empty answers:
  #   - `git worktree list` gave nothing (not a repo we can read) -- we do not
  #     gate what we cannot see;
  #   - the awk found no `worktree ` line at all -- same reading;
  #   - the detached tree is a LINKED worktree, the sanctioned lane-clearing
  #     state named above.
  exit 0
fi

case "$branch" in
  main|master)
    echo "Blocked by branch-gate: target git working tree is on branch '$branch'." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  command: $cmd" >&2
    echo "Create a feature branch and open a PR instead (e.g. 'git -C \"$target_dir\" switch -c fix/xxx')." >&2
    echo "Direct commits/pushes to main are not allowed in this repo." >&2
    exit 2
    ;;
esac

exit 0
