#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless both the `check` and `docs`
# markgate markers are fresh for the current content state. Each gate is
# scoped (see .markgate.yml) so edits to tests-only invalidate only `check`,
# and edits to docs-only invalidate only `docs`. The error message names the
# skill to re-run.
#
# cdk-real-drift is a smaller, solo, local-only repo (no GitHub remote yet),
# so this is the ONLY commit/merge gate wired up. Branch-protection,
# verify-pr-merge, pr-review, and integ-* gates are deferred until Phase 4
# (when the repo gets a remote). Adapted from cdkd's check-gate.sh; the
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
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+commit([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the git command will actually run (cwd-aware).
target_dir="${hook_cwd:-$PWD}"

# `cd <path>` at the start of the command shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# `git -C <path>` beats any earlier cd; pick the LAST occurrence.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
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
