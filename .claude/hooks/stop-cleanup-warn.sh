#!/usr/bin/env bash
# stop-cleanup-warn.sh
#
# Stop hook. Closes hole B — "deployed real AWS resources, then ended the session
# WITHOUT committing" — which the commit/PR gate (bughunt-clean-gate) never sees
# because no commit/PR is attempted. At session end, if the bughunt-clean sentinel
# is armed (a tracked stack, or the generic autoarm token from deploy-autoarm-gate),
# print a prominent reminder to clean up.
#
# WARN ONLY (exit 0): a /hunt-bugs session legitimately keeps resources live between
# turns, so this must NOT hard-block stopping (that is the commit/PR gate's job).
# It only surfaces outstanding resources so they are never SILENTLY forgotten.

set -u

input=$(cat 2>/dev/null || true)
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
target_dir="${hook_cwd:-$PWD}"

# Resolve the shared main-tree root (parent of the common .git dir) so the sentinel
# path matches what bughunt-track.sh / bughunt-clean-gate.sh use.
git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0
git_common="$(git -C "$target_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$git_common" ]; then
  main_root="$(dirname "$git_common")"
else
  main_root="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "$target_dir")"
fi

pending_dir="${main_root}/.markgate-bughunt-pending.d"
legacy="${main_root}/.markgate-bughunt-pending"

count=0
if [ -d "$pending_dir" ]; then
  while IFS= read -r f; do
    [ -s "$f" ] && count=$((count + $(grep -cvE '^[[:space:]]*$' "$f" 2>/dev/null || echo 0)))
  done < <(find "$pending_dir" -type f 2>/dev/null)
fi
[ -s "$legacy" ] && count=$((count + $(grep -cvE '^[[:space:]]*$' "$legacy" 2>/dev/null || echo 0)))

[ "$count" -gt 0 ] || exit 0

{
  echo "⚠️  cdkrd cleanup reminder: ${count} deploy/stack token(s) are still ARMED in the"
  echo "    bughunt-clean sentinel — you deployed real AWS resources this session and have"
  echo "    NOT yet verified them gone. Do not leave them billing:"
  echo "      /sweep-resources        # discover + delete cdkrd test resources, then release the gate"
  echo "    (or: delstack the stacks, run bughunt-track.sh verify, then clear)."
} >&2
exit 0
