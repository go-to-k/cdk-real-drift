#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless both the `check` and `docs`
# markgate markers are fresh for the current content state. Each gate is
# scoped (see .markgate.yml) so edits to tests-only invalidate only `check`,
# and edits to docs-only invalidate only `docs`. The error message names the
# skill to re-run.
#
# cdk-real-drift is a smaller repo than cdkd, so only a subset of cdkd's
# gate suite is wired: this hook plus branch-gate, verify-pr-gate,
# ci-green-gate, stale-base-gate, and non-english-text-gate (R83). The
# pr-review and integ-* gates stay UNPORTED on purpose — pr-review needs the
# multi-agent reviewers in `.claude/agents` cdkrd lacks, and integ-* depends
# on cdkd's deploy/destroy paths cdkrd does not have (see .markgate.yml).
# Adapted from cdkd's check-gate.sh; the
# cwd-aware target-dir resolution is kept because work happens via
# `git worktree` and markgate stores marker state per-worktree.

set -u

# Read the entire stdin payload once; we need both .tool_input.command and
# .cwd from it (two separate jq reads would consume stdin twice).
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit; any other command passes through. Line-start anchored
# so a `git commit` substring inside a quoted argument body does not
# false-positive. Tolerates `git -C <path> commit` / `git -c k=v commit` and
# an optional leading `cd <path> &&` worktree prefix.
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

# Which commands this gate applies to. The segment matcher sees a gated verb
# in ANY position — `git add -A && git commit` used to run ungated
# (go-to-k/cdk-real-drift#1803).
GATE_RE="$GATE_RE_GIT_COMMIT"
gate_matches "$cmd" "$GATE_RE" || exit 0

# Resolve where the command will actually run: a `-C <path>` in the matched
# segment wins, else the last `cd <path>` segment before it, else the payload cwd.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE")

# Repo opt-in scope, mirroring branch-gate (go-to-k/cdkd#1259): this gate belongs
# to repos that follow the markgate convention. A session rooted in one of them
# still runs git against OTHER repos — a dotfiles checkout, a scratch clone —
# where committing to main is the normal workflow and no marker exists to be
# fresh. Without this the gate blocked those commits with a message naming skills
# that repo does not have (hit on 2026-08-20 committing to `dotfiles` from a
# cdk-real-drift session). Opt-in signal: a `.markgate.yml` at the target repo's
# top level.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$target_top" ] || [ ! -f "$target_top/.markgate.yml" ]; then
  exit 0
fi

# If the resolved target dir is not a git repo, silently pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Prefer the .mise.toml-pinned markgate via `mise exec --` so the repo's
# canonical version wins over an older PATH binary. Falls back to PATH.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by check-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify check >/dev/null 2>&1
check_status=$?

"${markgate[@]}" verify docs >/dev/null 2>&1
docs_status=$?

if [ "$check_status" -eq 0 ] && [ "$docs_status" -eq 0 ]; then
  exit 0
fi

msg="Blocked by check-gate:"
if [ "$check_status" -ne 0 ]; then
  msg="$msg run /check first (or re-run if src/tests/config changed);"
fi
if [ "$docs_status" -ne 0 ]; then
  msg="$msg run /check-docs first (or re-run if src/docs/README/DESIGN changed);"
fi
msg="$msg then retry the commit."
echo "$msg" >&2
exit 2
