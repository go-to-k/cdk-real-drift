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
# Owner is the fixed key "autoarm" (not per-worktree): a deploy can run from a throwaway
# /tmp app with no worktree, and the clean-proof is account-global anyway, so any agent
# whose `verify` shows the account clean may clear it (the account being clean means
# every agent's ephemeral resources are already gone). Per-STACK tracking stays per-owner
# in bughunt-track; this generic flag is deliberately shared.

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

# Resolve this checkout's bughunt-track.sh (sibling skills dir) and arm the generic
# token under the fixed "autoarm" owner. Never let an arming failure block the deploy.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
# CDKRD_AUTOARM_TRACK lets the self-test point at a stub instead of arming the real
# sentinel; defaults to the sibling bughunt-track.sh.
TRACK="${CDKRD_AUTOARM_TRACK:-${HOOK_DIR}/../skills/hunt-bugs/bughunt-track.sh}"
if [ -x "$TRACK" ]; then
  CDKRD_BUGHUNT_OWNER=autoarm "$TRACK" add "AUTODEPLOY-pending-verify" >/dev/null 2>&1 || true
  {
    echo "[deploy-autoarm] A deploy-shaped command was detected — the bughunt-clean"
    echo "gate is now ARMED (owner: autoarm). Before you can commit / open a PR, prove"
    echo "the account is clean and release it:"
    echo "  /sweep-resources          # or, manually:"
    echo "  CDKRD_BUGHUNT_OWNER=autoarm ${TRACK} verify --region <region>"
    echo "  CDKRD_BUGHUNT_OWNER=autoarm ${TRACK} clear"
  } >&2
fi

exit 0
