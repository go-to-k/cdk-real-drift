#!/usr/bin/env bash
# stop-cleanup-warn.sh
#
# Stop hook. Closes hole B — "deployed real AWS resources, then ended the session
# WITHOUT committing" — which the commit/PR gate (bughunt-clean-gate) never sees
# because no commit/PR is attempted. At session end, if THIS session/owner's
# bughunt-clean sentinel is armed, print a prominent reminder to clean up.
#
# PER-SESSION scope (mirrors bughunt-clean-gate exactly): warn only about resources
# THIS session/owner is responsible for — (a) the cwd worktree's owner file (per-stack
# tracking) and (b) this session's autoarm-<session> token — NOT a peer session's live
# hunt (its stacks are uniquely named; its own gate/warn covers them). Warning about a
# peer's resources here would be a false "you forgot to clean up". The legacy flat
# sentinel stays global for back-compat.
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

# This owner (cwd worktree toplevel, mirrors bughunt-track.sh / bughunt-clean-gate).
owner_raw="${CDKRD_BUGHUNT_OWNER:-}"
if [ -z "$owner_raw" ]; then
  owner_raw="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "$target_dir")"
fi
owner_key="$(printf '%s' "$owner_raw" | sed 's#[^A-Za-z0-9._-]#_#g')"
owner_file="${pending_dir}/${owner_key}"

# This session's deploy-autoarm token (mirrors bughunt-clean-gate / deploy-autoarm).
sid="${CLAUDE_CODE_SESSION_ID:-}"
[ -z "$sid" ] && sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || echo "")
sid_key="$(printf '%s' "$sid" | sed 's#[^A-Za-z0-9._-]#_#g')"
autoarm_file="${pending_dir}/autoarm-${sid_key:-shared}"

count=0
for f in "$owner_file" "$autoarm_file" "$legacy"; do
  [ -s "$f" ] && count=$((count + $(grep -cvE '^[[:space:]]*$' "$f" 2>/dev/null || echo 0)))
done

[ "$count" -gt 0 ] || exit 0

{
  echo "⚠️  cdkrd cleanup reminder: ${count} deploy/stack token(s) are still ARMED in the"
  echo "    bughunt-clean sentinel — you deployed real AWS resources this session and have"
  echo "    NOT yet verified them gone. Do not leave them billing:"
  echo "      /sweep-resources        # discover + delete cdkrd test resources, then release the gate"
  echo "    (or: delstack the stacks, run bughunt-track.sh verify, then clear)."
} >&2
exit 0
