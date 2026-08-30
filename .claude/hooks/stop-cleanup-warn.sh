#!/usr/bin/env bash
# stop-cleanup-warn.sh
#
# Stop hook. Closes hole B -- "deployed real AWS resources, then ended the session
# WITHOUT committing" -- which the commit/PR gate (bughunt-clean-gate) never sees
# because no commit/PR is attempted. At session end, if THIS session/owner's
# bughunt-clean sentinel is armed, say so.
#
# PER-SESSION scope (mirrors bughunt-clean-gate exactly): warn only about resources
# THIS session/owner is responsible for -- (a) the cwd worktree's owner file (per-stack
# tracking) and (b) this session's autoarm-<session> token -- NOT a peer session's live
# hunt (its stacks are uniquely named; its own gate/warn covers them). Warning about a
# peer's resources here would be a false "you forgot to clean up". The legacy flat
# sentinel stays global for back-compat.
#
# WARN ONLY (exit 0): a /hunt-bugs session legitimately keeps resources live between
# turns, so this must NOT hard-block stopping (that is the commit/PR gate's job).
# It only surfaces outstanding resources so they are never SILENTLY forgotten.
#
# CHANNELS. Until go-to-k/cdk-real-drift#1844 this "surfacing" was an `echo ... >&2`
# followed by `exit 0`, which reaches NOBODY: a hook's stderr is surfaced only on a
# NON-ZERO exit, and stdout at exit 0 is parsed as JSON and discarded when it is not.
# So a billing guardrail printed its warning into a hole. The three Stop channels are:
#
#   hookSpecificOutput.additionalContext -- the MODEL, and the turn CONTINUES
#   systemMessage                        -- the USER only, and the turn ends
#   stdout / stderr at exit 0            -- nobody
#
# This hook is the one place in the repo that emits BOTH of the first two, and the
# two branches are independent in the harness so both can be present at once:
#
#   systemMessage      -- on EVERY turn it fires. A billing guardrail must never be
#                         silent to the human, whatever the model is or is not being
#                         told. This is a different trade from stop-unmerged-lane-warn
#                         next door, where the same wall of text every turn WAS the
#                         complaint; an unmerged lane costs nothing while it sits.
#   additionalContext  -- additionally, when the cadence below arms. The text names a
#                         command to run (`/sweep-resources`), so it is written at the
#                         model, and only the model can act on it.
#
# CADENCE. `stop_hook_active` marks a turn the harness has already resumed on a hook's
# account, so it stops a nudge SPINNING inside one turn -- and that is all it does.
# Across turns the armed sentinel persists until the resources are actually deleted, so
# an unconditional `additionalContext` would fire at every turn-end for as long as they
# live. That is not merely slow: a Stop hook's `additionalContext` travels in the same
# return value as a `decision: "block"`, so both spend one budget --
# `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, 8 consecutive blocks by default -- after which the
# harness overrides the hook and ends the turn. The hook that spends the budget is not
# necessarily the one with something urgent to say.
#
# So the model is nudged at most once per distinct SUBJECT, and the subject is the
# SORTED SET OF ARMED TOKENS: deploying another stack or clearing one changes it and
# re-arms, while ordinary turns do not. Two deliberate differences from the lane hook:
#
#   1. a WALL-CLOCK re-arm (REARM_SECONDS below) fires even when the subject is
#      unchanged, because money accrues on the clock rather than per turn. An idle
#      session sitting on a live NAT gateway is exactly the case a subject-only rule
#      would go quiet on. The escalated message says how long the tokens have been
#      armed, so the second telling carries information the first did not.
#   2. `systemMessage` on EVERY fire, per the channel note above.
#
# The record is one file in the PER-WORKTREE git dir, holding
# `<session id>TAB<subject>TAB<last nudge epoch>TAB<armed since epoch>`, written
# tmp-then-`mv`. The first three fields are the shape the sibling Stop hooks use; the
# fourth exists only here, to answer "how long" without being reset by each nudge.
# Per-worktree because that is where markgate keeps its markers, and because removing a
# worktree takes its record with it. ONE file rather than one per session, because a
# per-session file would accumulate with nobody to clean it up; a concurrent session in
# the same worktree can therefore clobber it, which costs an EXTRA nudge rather than a
# missed one -- the safe direction for a guardrail about money.

set -u

# How long an unchanged subject may stay quiet before the model is told again.
REARM_SECONDS=1200 # 20 minutes

input=$(cat 2>/dev/null || true)

# `jq` builds the payload as well as parsing the event. Without it this script would
# end on a `command not found` and return 127 -- a hook ERROR reported on every single
# turn, from a hook that is advisory by design. Say nothing instead. (Every other gate
# in this repo assumes `jq` unguarded; the difference is that they run per tool call
# and this one runs per turn-end.)
command -v jq >/dev/null 2>&1 || exit 0

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

# The armed TOKENS, not just how many: the set of them is the cadence subject below,
# so a stack deployed or cleaned re-arms the nudge while an ordinary turn does not.
armed=$(cat "$owner_file" "$autoarm_file" "$legacy" 2>/dev/null | grep -vE '^[[:space:]]*$' || true)
[ -n "$armed" ] || exit 0
count=$(printf '%s\n' "$armed" | grep -c '' 2>/dev/null || echo 0)

# Tabs are folded to spaces because the record below is tab-separated, and a token
# carrying one would shift every later field.
subject=$(printf '%s\n' "$armed" | tr '\t' ' ' | LC_ALL=C sort -u | tr '\n' ',')
subject="${subject%,}"

# `stop_hook_active` is a required boolean on the Stop payload. A STRING "false" is
# truthy to a naive read, so the textual spellings are folded down rather than trusted;
# reading one as "already continued" would silence this hook permanently.
active=$(printf '%s' "$input" | jq -r '
  (.stop_hook_active // false) as $f
  | if ($f | type) == "string"
    then (if ($f | ascii_downcase | gsub("^\\s+|\\s+$"; "") | . == "" or . == "false" or . == "0" or . == "no") then "0" else "1" end)
    else (if $f then "1" else "0" end) end' 2>/dev/null || echo "0")

# Already surfaced once this turn and the model came back to Stop. Repeating it would
# spin the turn instead of ending it, and the human has already seen the systemMessage
# from the earlier pass of this same turn, so stand down entirely.
[ "$active" = "1" ] && exit 0

now=$(date +%s)
armed_since="$now"
arm=1
arm_reason="new"

git_dir=$(git -C "$target_dir" rev-parse --absolute-git-dir 2>/dev/null || true)
state_file=""
if [ -n "$git_dir" ]; then
  state_file="${git_dir}/stop-nudge-cleanup"
  prev_sid=""
  prev_subject=""
  prev_nudge=""
  prev_since=""
  if [ -r "$state_file" ]; then
    IFS="$(printf '\t')" read -r prev_sid prev_subject prev_nudge prev_since <"$state_file" 2>/dev/null || true
  fi
  if [ "$prev_sid" = "$sid" ] && [ "$prev_subject" = "$subject" ]; then
    case "$prev_since" in '' | *[!0-9]*) prev_since="$prev_nudge" ;; esac
    case "$prev_since" in '' | *[!0-9]*) prev_since="$now" ;; esac
    armed_since="$prev_since"
    case "$prev_nudge" in '' | *[!0-9]*) prev_nudge=0 ;; esac
    # Same tokens, same session: quiet, UNLESS the wall clock says these resources have
    # been billing for another REARM_SECONDS since the model was last told.
    if [ "$((now - prev_nudge))" -ge "$REARM_SECONDS" ]; then
      arm_reason="clock"
    else
      arm=0
    fi
  fi
fi

armed_minutes=$(((now - armed_since) / 60))

user_msg="cdkrd cleanup reminder: ${count} deploy/stack token(s) are still ARMED in the bughunt-clean
sentinel -- real AWS resources were deployed this session and have NOT been verified gone. They are
still billing. Clear them with /sweep-resources (or: delstack the stacks, run bughunt-track.sh verify,
then clear).
Armed token(s): ${subject}"

model_msg="WARNING: ${count} deploy/stack token(s) are still ARMED in the bughunt-clean sentinel -- you
deployed real AWS resources this session and have NOT yet verified them gone. Do not leave them billing:
  /sweep-resources        # discover + delete cdkrd test resources, then release the gate
(or: delstack the stacks, run bughunt-track.sh verify, then clear).
Armed token(s): ${subject}"

if [ "$arm_reason" = "clock" ]; then
  model_msg="${model_msg}
This is a REPEAT: the same token(s) have now been armed for ~${armed_minutes} minute(s) of wall clock and
are still billing. Nothing here goes away on its own -- clean up now, or say explicitly why the resources
must stay live."
fi

if [ "$arm" = "1" ] && [ -n "$state_file" ]; then
  # tmp + `mv` so a Stop racing another never leaves a half-written line behind.
  tmp="${state_file}.$$"
  if printf '%s\t%s\t%s\t%s\n' "$sid" "$subject" "$now" "$armed_since" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$state_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
fi

if [ "$arm" = "1" ]; then
  jq -n --arg sys "$user_msg" --arg ctx "$model_msg" \
    '{systemMessage: $sys, hookSpecificOutput: {hookEventName: "Stop", additionalContext: $ctx}}'
else
  jq -n --arg sys "$user_msg" '{systemMessage: $sys}'
fi
exit 0
