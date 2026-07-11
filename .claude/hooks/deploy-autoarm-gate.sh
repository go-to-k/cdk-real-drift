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
#
# ROBUST resolution (#1423): the earlier version resolved TRACK purely from
# ${BASH_SOURCE[0]}/../skills/... and then SILENTLY no-op'd when that path was not
# executable — so a deploy ran UNARMED with zero signal (the exact #1423 symptom:
# a real `aws cloudformation deploy` left no autoarm token and printed nothing). Two
# swallowed-failure surfaces caused it: (A) [ -x "$TRACK" ] false → whole arm block
# skipped in silence; (B) `add … || true` swallowing a tracker error while the
# "ARMED" message still printed (false assurance). Both are now made OBSERVABLE:
# the failure is always reported to stderr, and the "ARMED" message prints only when
# the arm actually SUCCEEDED. The hook still exits 0 unconditionally — it must never
# block the deploy — but it can no longer fail silently.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
# CDKRD_AUTOARM_TRACK lets the self-test point at a stub instead of arming the real
# sentinel; otherwise resolve the sibling bughunt-track.sh. Try the BASH_SOURCE-derived
# location first, then a git-toplevel fallback (covers a relative-path invocation from
# an unexpected cwd where BASH_SOURCE alone would not resolve to the checkout).
TRACK="${CDKRD_AUTOARM_TRACK:-}"
if [ -z "$TRACK" ]; then
  for cand in \
    "${HOOK_DIR}/../skills/hunt-bugs/bughunt-track.sh" \
    "$(git rev-parse --show-toplevel 2>/dev/null)/.claude/skills/hunt-bugs/bughunt-track.sh"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      TRACK="$cand"
      break
    fi
  done
fi

if [ -n "$TRACK" ] && [ -x "$TRACK" ]; then
  if CDKRD_BUGHUNT_OWNER="$AUTOARM_OWNER" "$TRACK" add "AUTODEPLOY-pending-verify" >/dev/null 2>&1; then
    {
      echo "[deploy-autoarm] A deploy-shaped command was detected — the bughunt-clean"
      echo "gate is now ARMED for THIS session (owner: ${AUTOARM_OWNER}). Before you can"
      echo "commit / open a PR, prove the account is clean and release it:"
      echo "  /sweep-resources          # or, manually:"
      echo "  CDKRD_BUGHUNT_OWNER=${AUTOARM_OWNER} ${TRACK} verify --region <region>"
      echo "  CDKRD_BUGHUNT_OWNER=${AUTOARM_OWNER} ${TRACK} clear"
    } >&2
  else
    # The tracker was found+executable but `add` FAILED (surface B). Do NOT claim
    # ARMED — the gate is NOT holding. Make it loud so the operator arms it manually.
    {
      echo "[deploy-autoarm] WARNING: a deploy-shaped command was detected but arming the"
      echo "bughunt-clean gate FAILED (tracker '${TRACK}' add exited non-zero). The gate is"
      echo "NOT holding — you MUST clean up manually after this deploy. Arm it by hand:"
      echo "  CDKRD_BUGHUNT_OWNER=${AUTOARM_OWNER} ${TRACK} add <StackName>"
    } >&2
  fi
else
  # The tracker could not be located/executed (surface A). Previously SILENT — now
  # reported so an unarmed deploy is never invisible.
  {
    echo "[deploy-autoarm] WARNING: a deploy-shaped command was detected but the bughunt"
    echo "tracker could not be found or is not executable (looked for CDKRD_AUTOARM_TRACK"
    echo "or .claude/skills/hunt-bugs/bughunt-track.sh; HOOK_DIR='${HOOK_DIR}'). The"
    echo "bughunt-clean gate is NOT armed for this deploy — remember to clean up and"
    echo "run /sweep-resources manually after it."
  } >&2
fi

exit 0
