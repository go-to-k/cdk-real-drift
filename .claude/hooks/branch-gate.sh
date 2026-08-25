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

# Read the branch from the resolved target dir. `-C` lets git operate
# on a directory that isn't our cwd; if the dir doesn't exist or isn't
# inside a git repo, symbolic-ref returns empty and we fall through to
# the safe `exit 0` below (we can't gate what we can't see).
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

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
