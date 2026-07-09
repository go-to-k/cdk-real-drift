#!/usr/bin/env bash
# deploy-autoarm-gate.sh
#
# PreToolUse hook (Bash). Closes the "forgot to arm the cleanup sentinel" hole
# (hole A): when a command that DEPLOYS real AWS resources is about to run, arm the
# bughunt-clean sentinel automatically so a commit / PR cannot land until the account
# is verified clean — even if the operator/skill never called `bughunt-track.sh add`.
#
# WHY generic, not per-stack: parsing the exact stack name from an arbitrary deploy
# command is fragile (a misparse tracks the WRONG name, which `verify` finds "gone"
# and passes — leaking the real stack). Instead we arm a single GENERIC token
# ("a deploy happened — prove the account clean before committing"). `bughunt-track
# verify` ALWAYS runs sweep-orphans.sh (now a tag-based, any-type net), so the real
# check is an account-wide clean-proof, not a name match. The token just holds the
# gate until that proof passes.
#
# NON-BLOCKING: this hook only ARMS (a side effect) and always exits 0 — it never
# blocks the deploy itself. The bughunt-clean-gate blocks the later commit/PR.
#
# Owner is a PER-SESSION key "autoarm-<session>" (not a single shared "autoarm", and not
# per-worktree — a deploy can run from a throwaway /tmp app with no worktree). Scoping the
# token to the deploying SESSION means your own deploy blocks your OWN commit/PR but does
# NOT block an unrelated peer session whose live hunt happens to leave the account dirty —
# bug-hunt stacks are uniquely named, so there is no cross-session resource contention.
# The session id comes from $CLAUDE_CODE_SESSION_ID (the same value /sweep-resources and
# the commit-side bughunt-clean-gate use), falling back to the hook payload's session_id,
# then to a shared "autoarm-shared" token if neither is available (fail safe = global
# block). Per-STACK tracking stays per-owner in bughunt-track.

set -u

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Strip quoted substrings first so a deploy phrase merely PRINTED inside a string
# (echo "aws cloudformation deploy …") does not false-positive — a real deploy verb
# is an unquoted command word. Then match deploy-shaped commands. Deliberately NOT
# matched: `cdk synth`, `cdk destroy`, `delstack` (synth/delete, not deploy).
unquoted=$(printf '%s' "$cmd" | sed "s/\"[^\"]*\"//g; s/'[^']*'//g")
deploy_re='(aws[[:space:]]+cloudformation[[:space:]]+(deploy|create-stack|update-stack)|(^|[[:space:]])cdk([[:space:]]+[^&|;]*)?[[:space:]]+deploy([[:space:]]|$)|(^|[[:space:]])sam[[:space:]]+deploy([[:space:]]|$))'
printf '%s' "$unquoted" | grep -qE "$deploy_re" || exit 0

# Resolve the deploying SESSION's autoarm owner key. Prefer $CLAUDE_CODE_SESSION_ID
# (env, what the /sweep-resources skill and bughunt-clean-gate also read), fall back to
# the hook payload's session_id, then to the shared "autoarm-shared" token (fail safe).
sid="${CLAUDE_CODE_SESSION_ID:-}"
[ -z "$sid" ] && sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || echo "")
sid_key="$(printf '%s' "$sid" | sed 's#[^A-Za-z0-9._-]#_#g')"
AUTOARM_OWNER="autoarm-${sid_key:-shared}"

# Resolve this checkout's bughunt-track.sh (sibling skills dir) and arm the token under
# the per-session owner. Never let an arming failure block the deploy.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
# CDKRD_AUTOARM_TRACK lets the self-test point at a stub instead of arming the real
# sentinel; defaults to the sibling bughunt-track.sh.
TRACK="${CDKRD_AUTOARM_TRACK:-${HOOK_DIR}/../skills/hunt-bugs/bughunt-track.sh}"
if [ -x "$TRACK" ]; then
  CDKRD_BUGHUNT_OWNER="$AUTOARM_OWNER" "$TRACK" add "AUTODEPLOY-pending-verify" >/dev/null 2>&1 || true
  {
    echo "[deploy-autoarm] A deploy-shaped command was detected — the bughunt-clean"
    echo "gate is now ARMED for THIS session (owner: ${AUTOARM_OWNER}). Before you can"
    echo "commit / open a PR, prove the account is clean and release it:"
    echo "  /sweep-resources          # or, manually:"
    echo "  CDKRD_BUGHUNT_OWNER=${AUTOARM_OWNER} ${TRACK} verify --region <region>"
    echo "  CDKRD_BUGHUNT_OWNER=${AUTOARM_OWNER} ${TRACK} clear"
  } >&2
fi

exit 0
