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
# account, so it drops the MODEL half -- and that is all it does. It is deliberately not
# a full stand-down: the `systemMessage` above is promised on every fire, and the
# condition can first become true DURING a continuation another hook forced (that
# continuation runs a deploy, `deploy-autoarm-gate.sh` arms, and this pass is the first
# time there is anything to say).
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

# Three candidates, tried in order, because a `cwd` that is merely WRONG is the
# common failure and used to be indistinguishable from a correct one: the payload
# names a directory that has since been removed (a worktree cleaned up mid-session),
# `git -C` fails, and this hook exits 0 -- silent about resources that are still
# billing. Only an EMPTY `cwd` fell back before, so the stale case went unnoticed.
#
#   1. the event payload's `cwd` -- authoritative when it resolves.
#   2. `$PWD` -- the directory the harness launched the hook from.
#   3. this hook copy's own checkout, via BASH_SOURCE -- the last resort, and the
#      anchor stop-unmerged-lane-warn.sh next door already uses for the same reason.
#
# Only if none of the three is inside a git repository does the hook stand down.
self_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || self_root=""
target_dir=""
for cand in "$hook_cwd" "$PWD" "$self_root"; do
  [ -n "$cand" ] || continue
  if git -C "$cand" rev-parse --git-dir >/dev/null 2>&1; then
    target_dir="$cand"
    break
  fi
done
[ -n "$target_dir" ] || exit 0

# Resolve the shared main-tree root (parent of the common .git dir) so the sentinel
# path matches what bughunt-track.sh / bughunt-clean-gate.sh use.
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
[ -n "$sid_key" ] || sid_key="shared"
autoarm_file="${pending_dir}/autoarm-${sid_key}"

# The sid goes into a TAB-separated record that is read back with `IFS=<TAB> read`,
# and a tab is IFS *whitespace*: a run of them collapses and a LEADING empty field
# is dropped outright. So an empty sid (no `CLAUDE_CODE_SESSION_ID`, no `session_id`
# in the payload) wrote `<TAB>subject<TAB>...`, which read back one field to the
# left -- `prev_sid` held the SUBJECT, never compared equal, and the cadence never
# armed down. The nudge then fired on every single turn-end, spending the shared
# `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` budget the cadence exists to protect. A sid
# CONTAINING a tab did the same from the other direction. Normalised ONCE here, so
# the comparison below and the record it is compared against cannot disagree; the
# filename key above was already defaulted, this is the same defaulting for the
# value itself. (`stop-unmerged-lane-warn.sh` defends both halves already.)
sid=$(printf '%s' "$sid" | tr '\t\n' '  ')
[ -n "$sid" ] || sid="shared"

# The armed TOKENS, not just how many: the set of them is the cadence subject below,
# so a stack deployed or cleaned re-arms the nudge while an ordinary turn does not.
armed=$(cat "$owner_file" "$autoarm_file" "$legacy" 2>/dev/null | grep -vE '^[[:space:]]*$' || true)
[ -n "$armed" ] || exit 0

# Tabs are folded to spaces because the record below is tab-separated, and a token
# carrying one would shift every later field. `LC_ALL=C sort -u` makes the subject
# ORDER-independent (the three sentinel files are concatenated, so the same set can
# arrive in different orders and must not read as a new subject) as well as
# duplicate-free (the legacy flat file and the owner file legitimately name the same
# stack).
#
# `count` is derived from the SAME deduped set the message lists, not from the raw
# lines: counting raw while listing deduped made the text say "2 token(s)" and then
# name one, which reads as a bug in the sentinel rather than in the counting.
armed_set=$(printf '%s\n' "$armed" | tr '\t' ' ' | LC_ALL=C sort -u)
count=$(printf '%s\n' "$armed_set" | grep -c '' 2>/dev/null || echo 0)
subject=$(printf '%s\n' "$armed_set" | tr '\n' ',')
subject="${subject%,}"

# `stop_hook_active` is a required boolean on the Stop payload. A STRING "false" is
# truthy to a naive read, so the textual spellings are folded down rather than trusted;
# reading one as "already continued" would silence this hook's model half permanently.
# The non-string arm is `$f == true` rather than jq truthiness, because jq and Python
# disagree on exactly the values a malformed payload carries -- `0`, `[]` and `{}` are
# all TRUTHY in jq and all falsy in Python. Left as truthiness, this hook read them as a
# continuation while stop-unmerged-lane-warn.sh next door did not, and this is the one
# that goes quiet about money.
active=$(printf '%s' "$input" | jq -r '
  (.stop_hook_active // false) as $f
  | if ($f | type) == "string"
    then (if ($f | ascii_downcase | gsub("^\\s+|\\s+$"; "") | . == "" or . == "false" or . == "0" or . == "no") then "0" else "1" end)
    else (if ($f == true) then "1" else "0" end) end' 2>/dev/null || echo "0")

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
    case "$prev_nudge" in '' | *[!0-9]*) prev_nudge=0 ;; esac
    # `10#` because the sanitisers above accept a LEADING ZERO -- it is a digit -- and
    # bash then reads `08` as octal and aborts the arithmetic with "value too great for
    # base", on the hook's real stderr, every turn.
    prev_since=$((10#$prev_since))
    prev_nudge=$((10#$prev_nudge))
    # A stamp in the FUTURE is not hypothetical: a forward clock jump plus the NTP
    # correction that follows it leaves one behind, and bash WRAPS an over-long value
    # silently rather than refusing it. Unclamped, `now - prev_nudge` is negative, never
    # reaches REARM_SECONDS, and the model is silent about live resources for as long as
    # the stamp says -- the same unbounded-silence failure as a record that never
    # compares equal, in the opposite direction. Treat anything not in [0, now] as 0.
    if [ "$prev_nudge" -gt "$now" ] || [ "$prev_nudge" -lt 0 ]; then prev_nudge=0; fi
    if [ "$prev_since" -gt "$now" ] || [ "$prev_since" -lt 0 ]; then prev_since="$now"; fi
    armed_since="$prev_since"
    # Same tokens, same session: quiet, UNLESS the wall clock says these resources have
    # been billing for another REARM_SECONDS since the model was last told.
    if [ "$((now - prev_nudge))" -ge "$REARM_SECONDS" ]; then
      arm_reason="clock"
    else
      arm=0
    fi
  fi
fi

# No clamp here, deliberately. "armed for ~-5256000 minute(s)" is the visible half of
# the future-stamp bug, but the fix belongs at the SOURCE: `armed_since` is either
# `now` or a `prev_since` already clamped into [0, now] above, so this difference
# cannot be negative. A second clamp here would be a fence no test can trip -- probed
# by deleting it, which left the suite green because the clamp above had already made
# the case unreachable.
armed_minutes=$(((now - armed_since) / 60))

# `stop_hook_active` marks a pass the harness has ALREADY resumed on some hook's
# account. Emitting `additionalContext` again would spin the turn instead of ending it,
# so the MODEL half stands down -- and only that half. This used to `exit 0` outright,
# which took the `systemMessage` with it and broke the promise this file's header makes
# (the user hears about live resources on every turn it fires). The justification was
# that the human saw it on the earlier pass, and that is FALSE whenever the tokens were
# not armed then: the neighbouring Stop hook forces a continuation, the model runs a
# deploy inside it, `deploy-autoarm-gate.sh` arms, and this pass is the FIRST time the
# condition holds at all. A bare `systemMessage` does not continue a turn, so nothing
# spins.
if [ "$active" = "1" ]; then
  arm=0
  arm_reason="active"
fi

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

# The record is what BOUNDS the nudge, so failing to persist it is not a cosmetic
# problem: an unwritable git dir (a read-only checkout, a full disk, a directory owned
# by another user) leaves every later turn re-arming, which is the same unbounded
# `additionalContext` the cadence exists to prevent. When the record cannot be kept,
# the model half is dropped for THIS turn and the user still hears it -- one telling
# lost is cheaper than a spin that the harness eventually overrides.
#
# `2>/dev/null >"$tmp"`, in that order: applied the other way round, bash has already
# replaced fd 2 with the tmp file by the time it tries to open it, so the failure to
# open is reported on the hook's REAL stderr -- a "Permission denied" line surfacing
# from an advisory hook on every turn.
if [ "$arm" = "1" ]; then
  wrote=0
  if [ -n "$state_file" ]; then
    # tmp + `mv` so a Stop racing another never leaves a half-written line behind.
    tmp="${state_file}.$$"
    if printf '%s\t%s\t%s\t%s\n' "$sid" "$subject" "$now" "$armed_since" 2>/dev/null >"$tmp"; then
      if mv -f "$tmp" "$state_file" 2>/dev/null; then
        wrote=1
      else
        rm -f "$tmp" 2>/dev/null || true
      fi
    else
      rm -f "$tmp" 2>/dev/null || true
    fi
  fi
  [ "$wrote" = "1" ] || arm=0
fi

if [ "$arm" = "1" ]; then
  jq -n --arg sys "$user_msg" --arg ctx "$model_msg" \
    '{systemMessage: $sys, hookSpecificOutput: {hookEventName: "Stop", additionalContext: $ctx}}'
else
  jq -n --arg sys "$user_msg" '{systemMessage: $sys}'
fi
exit 0
