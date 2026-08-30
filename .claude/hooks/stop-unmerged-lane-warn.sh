#!/usr/bin/env bash
# stop-unmerged-lane-warn.sh
#
# Stop hook. It catches the quiet half of unfinished work: a feature worktree
# whose branch is COMMITTED but still ahead of `origin/main` -- a lane that is
# finished as far as the editor is concerned and unfinished as far as the repo
# is. (The sibling cdkd repo pairs this with a `stop-warn.sh` covering the
# UNCOMMITTED half in the main tree. This repo has no such hook, so do not read
# the pair as coverage here; an earlier revision of this comment named it as if
# it sat next to this file. The other Stop hook registered here,
# `stop-cleanup-warn.sh`, covers a different axis entirely -- real AWS resources
# left running -- and shares only the channel and cadence rules below.)
#
# Why this is a hook rather than another sentence. CLAUDE.md already says a
# NOT-CLOSEABLE verdict is a to-do list and not a stopping point, and already
# says that if you cannot name a signal that will re-invoke you then you are
# STOPPED rather than WAITING. Both were violated repeatedly in one session on
# 2026-08-26: turns ended with `Mode: WAITING` next to `Waiting on: none`, and
# with `Verdict: NOT CLOSEABLE` in the same report as the stop. A rule that is
# already in the text and gets violated anyway is not made load-bearing by a
# third spelling of it (`/work-issues` section 10-b says to escalate rather
# than restate), so this computes the verdict from the REPO instead of from the
# agent's own self-report -- which is the part that was wrong.
#
# Deliberately does NOT call `gh`: a Stop hook runs on every turn, and a network
# round-trip per turn is a cost this warning does not justify. Branch state
# alone separates "there is unmerged work here" from "there is not".
set -u

# The Stop event's JSON arrives on stdin, and is consumed here rather than
# lazily: the payload has to be drained whether or not this hook goes on to use
# it. Three fields are PARSED out of it further down, once a lane has actually
# been found -- `stop_hook_active` (has the harness already continued this
# turn?), `cwd` (which worktree is the session in?) and `session_id` (whose
# nudge record is this?). Claude Code writes the payload and closes the pipe, so
# this does not block.
input=$(cat 2>/dev/null || true)

# BASH_SOURCE resolves to whichever checkout this copy of the hook lives in --
# in a linked worktree that is the LANE, not the main tree. That is fine as a
# place to run `git` from (every worktree shares one object store and one
# `origin/main`), but it must NOT be used to decide which worktree to skip: the
# session ending inside its own lane is the case this hook exists for, and an
# earlier revision skipped exactly that one. Measured from a lane 5 commits
# ahead: the hook printed nothing. The main tree is excluded by BRANCH below
# (`main`/`master`), which is the property that actually identifies it.
#
# BASH_SOURCE is not banned here, only that USE of it. The same value is the
# fallback for `session_root` further down, where it answers the opposite
# question -- which worktree IS the session's -- and being the lane is exactly
# what makes it the right answer there.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" 2>/dev/null || exit 0

# Cheap: no fetch. A stale `origin/main` can only OVER-report: `rev-list --count
# origin/main..$br` only grows as `origin/main` ages, so a branch whose work has
# already merged keeps reading as ahead. That is the safe direction -- the
# failure that matters is MISSING a real lane, and staleness cannot cause it.
# (This comment said UNDER-report until go-to-k/cdk-real-drift#1844, copying a
# sentence the sibling repo had already corrected.)
git rev-parse --verify origin/main >/dev/null 2>&1 || exit 0

# `lane_paths` carries the same rows as `lanes` in a machine-readable form --
# BRANCH, TAB, worktree path -- so the session's OWN lane can be picked out of
# them below. The branch comes FIRST because it is the field that is safe to
# bound a split by: git refnames may not contain a tab, a space or a backslash,
# while a worktree PATH may contain all three.
#
# `substr($0, 10)`, not `$2`: `git worktree list --porcelain` prints
# `worktree <path>` with the path unquoted and unescaped, so `$2` truncates at
# the first space. A truncated path makes `git -C` fail and the lane vanishes
# from BOTH the enumeration and the ownership comparison -- the hook goes SILENT
# about a lane that exists, which is the one failure direction it must not have.
lanes=""
lane_paths=""
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  br=$(git -C "$wt" branch --show-current 2>/dev/null) || continue
  [ -n "$br" ] || continue
  case "$br" in main | master) continue ;; esac
  ahead=$(git -C "$wt" rev-list --count "origin/main..$br" 2>/dev/null) || continue
  [ "${ahead:-0}" -gt 0 ] || continue
  lanes="${lanes}  ${br}  (${ahead} commit(s) ahead, worktree ${wt##*/})
"
  lane_paths="${lane_paths}${br}	${wt}
"
done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10)}')

[ -n "$lanes" ] || exit 0

# Everything past here builds a payload with `python3`. Without it the script
# would end on a `command not found` and exit 127 -- on every turn, for a hook
# whose entire job is advisory. Say nothing instead.
command -v python3 >/dev/null 2>&1 || exit 0

# Everything below decides WHICH CHANNEL the warning leaves by, and the three
# are not interchangeable -- on the Stop event they differ in who reads them and
# in whether the turn ends:
#
#   hookSpecificOutput.additionalContext -- delivered to the MODEL, and the turn
#     CONTINUES so it can act.
#   systemMessage -- shown to the USER only, and the turn ends normally.
#   stdout / stderr at exit 0 -- read by NOBODY.
#
# There is no fourth option that reaches the model without continuing the turn,
# which is the whole reason this hook has to choose. It used to emit
# `systemMessage` unconditionally, so every word of a message written AT THE
# AGENT ("you are not done", "the honest label is STOPPED") reached only the
# party that cannot act on it (go-to-k/cdkd#2389, ported here as
# go-to-k/cdk-real-drift#1844).
#
# The split is by OWNERSHIP, because that is what decides whether a continuation
# buys anything:
#
#   this session's own worktree is a lane -> additionalContext. This is the
#     failure the hook exists for -- ending the turn with your own branch
#     committed and no PR -- and a nudge the model may simply stop over is
#     exactly what did not work.
#   only OTHER worktrees are lanes -> systemMessage. The model cannot act on
#     someone else's lane, so continuing the turn would buy a second reply that
#     can only say "not mine". Measured in the sibling while fixing this: four
#     forced continuations in one session over ONE lane belonging to another
#     session, each producing a reply whose entire content was that it was not
#     this session's to touch. And because this repo SQUASH-merges, a merged
#     branch reads as ahead forever, so one un-removed worktree would have made
#     that permanent.
parsed=$(HOOK_INPUT="$input" python3 -c '
import json, os

try:
    data = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except ValueError:
    data = {}
if not isinstance(data, dict):
    data = {}

# The harness sends a JSON boolean. A STRING "false" is truthy in Python, and
# reading it as "already continued" would silence the hook permanently, so the
# textual spellings are folded down here rather than trusted.
flag = data.get("stop_hook_active")
if isinstance(flag, str):
    flag = flag.strip().lower() not in ("", "false", "0", "no")
print("1" if flag else "0")
# `cwd` is stripped of NEWLINES for the same reason `session_id` is: this block
# prints three LINES which the shell picks apart with `sed -n 1p/2p/3p`, so a
# newline inside an earlier value shifts every later one. Only `session_id` was
# stripped, so a `cwd` carrying a newline put the TAIL OF THE PATH into `sid` and
# the cadence record was keyed on a fragment of a directory name instead of the
# session. Measured: a payload whose `cwd` was "<lane path>\nJUNK" wrote
# `sid=JUNK`.
#
# Tabs are NOT stripped from `cwd`, and that asymmetry is deliberate. `sid` is
# written into a tab-separated record, so a tab in it would shift every field
# after it; `cwd` is only ever compared against a worktree path, and a tab is legal
# in one -- folding it would break the tab-in-path case this suite already fences.
print((data.get("cwd") or "").replace("\n", " "))
print((data.get("session_id") or "").replace("\t", " ").replace("\n", " "))
')
active=$(printf '%s\n' "$parsed" | sed -n 1p)
hook_cwd=$(printf '%s\n' "$parsed" | sed -n 2p)
sid=$(printf '%s\n' "$parsed" | sed -n 3p)
[ -n "$sid" ] || sid="${CLAUDE_CODE_SESSION_ID:-}"
# Normalised HERE rather than in the Python above, because there are TWO sources
# and only one of them went through it. The environment fallback lands after the
# parse, so `CLAUDE_CODE_SESSION_ID` reached the record RAW -- and the record is
# tab-separated, read back with `IFS=<TAB> read`, where a tab is IFS *whitespace*:
# a leading empty field is dropped and a run collapses. Measured in a sandbox lane
# with a payload carrying no `session_id`: `s1` gave `ctx, sys, sys` while
# `<TAB>abc`, `a<TAB>b` and `a<NL>b` each gave `ctx, ctx, ctx` -- an unbounded
# `additionalContext` against the 8-block cap, which is the whole failure the
# cadence exists to prevent. Doing it once, after both sources have been consulted,
# is what makes "every field is normalised before it is written" true rather than
# true-of-one-path. (`stop-cleanup-warn.sh` next door has the same two sources and
# the same single fold.)
sid=$(printf '%s' "$sid" | tr '\t\n' '  ')
[ -n "$sid" ] || sid="shared"

# Already nudged once this turn and the model came back to Stop. Repeating the
# MODEL half would spin the turn instead of ending it, so that half stands
# down -- but the warning still goes to the user. This used to `exit 0`
# outright, on the reasoning that the human had already seen it on the earlier
# pass of the same turn. That is false whenever the condition first becomes TRUE
# during the continuation: the lane can be committed inside it (the continuation
# exists precisely to push the model back to work), in which case this pass is
# the first on which there is anything to report, and a silent hook means nobody
# ever learns. A bare `systemMessage` does not continue a turn, so nothing spins.
# (`stop-cleanup-warn.sh` next door takes the same shape, for the same reason.)
resumed=0
[ "$active" = "1" ] && resumed=1

# Where is the SESSION? `cwd` from the event payload, resolved to its worktree
# root. Falling back to this hook copy's own checkout is correct rather than
# merely convenient: in a linked worktree BASH_SOURCE IS the lane. Note the
# POLARITY -- an earlier revision used that same path to SKIP a worktree and so
# went blind to the one case that matters; here it IDENTIFIES the lane instead.
session_root=""
[ -n "$hook_cwd" ] && session_root=$(git -C "$hook_cwd" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$session_root" ] || session_root="$REPO"
# `pwd -P` is the load-bearing half. The `git` answers above are already
# canonical, but the BASH_SOURCE fallback is not: `REPO` is built with `cd ...
# && pwd`, which keeps the spelling it was reached by, so a session launched
# through a symlinked worktree path compares a symlink against git's real path
# and never matches -- silently taking the not-mine branch for its OWN lane.
session_root=$(cd "$session_root" 2>/dev/null && pwd -P) || session_root=$(pwd -P)

# Plain shell rather than awk. Every awk spelling of this comparison mangles
# some path: `-v root=...` expands backslash escapes in the value, and `-F'\t'`
# splits a path containing a tab into the wrong field. Both are the same class
# as the space truncation fixed above, and parameter expansion has neither.
TAB=$(printf '\t')
self_branch=""
while IFS= read -r row; do
  [ -n "$row" ] || continue
  row_branch=${row%%"$TAB"*}
  row_path=${row#*"$TAB"}
  if [ "$row_path" = "$session_root" ]; then
    self_branch="$row_branch"
    break
  fi
done <<LANE_ROWS
$lane_paths
LANE_ROWS

if [ -n "$self_branch" ]; then
  # Whether the branch has been PUSHED is NOT used to decide the channel. It
  # would have gone quiet on a branch that is pushed with NO PR, which is a real
  # failure and one of the two this hook exists to catch. It earns its keep in
  # the TEXT instead, where it names which half of the remaining work is left,
  # and in the cadence SUBJECT below. No upstream at all reads as unpushed,
  # which is what it is.
  unpushed=$(git -C "$session_root" rev-list --count '@{u}..' 2>/dev/null || echo "")
  if [ -z "$unpushed" ]; then
    push_state="unpushed"
    push_line="It has no upstream yet, so nothing has been submitted: push it, open the PR, then merge."
    push_note="It has no upstream yet, so nothing has been submitted."
  elif [ "$unpushed" -gt 0 ]; then
    push_state="unpushed"
    push_line="It has ${unpushed} commit(s) not yet pushed, so nothing carrying them has been submitted: push, open or update the PR, then merge."
    push_note="It has ${unpushed} commit(s) not yet pushed, so nothing carrying them has been submitted."
  else
    push_state="pushed"
    push_line="It is fully pushed, so a PR may already be in flight -- but a pushed branch with NO PR is exactly the failure this catches. Check, and open one if there is none."
    push_note="It is fully pushed, so a PR may already be in flight -- but a pushed branch with NO PR is exactly the failure this catches."
  fi
  # TWO texts for the self-lane case, not one routed twice. The model text is
  # written AT the agent ("you are not done", "rebase, run the gates"), and every
  # path that downgrades it to `systemMessage` -- the cadence repeat, an
  # unpersistable record, a resumed pass -- would otherwise hand a human a list of
  # instructions addressed to somebody else. That is go-to-k/cdkd#2389 in
  # miniature, the very defect this hook was rewritten to fix, and the downgrades
  # added here would have widened it from one path to three.
  #
  # Both keep `$push_note` / `$push_line`, which share the three phrases that name
  # WHICH half of the work is left; only the framing around them changes voice.
  # (`stop-cleanup-warn.sh` next door has carried a `user_msg` / `model_msg` pair
  # from the start, for exactly this reason.)
  user_msg="NOTE: this session's own lane is unmerged -- '$self_branch' is committed but not on origin/main.
$push_note
The agent has already been nudged about this lane once, so this repeat is for you: if the session ends
here, the work stays on the branch and nothing carries it to main. One false positive is expected and is
cheap to clear -- this repo SQUASH-merges, so an already-merged branch keeps reading as ahead, and
clearing that one means removing its worktree and deleting the branch rather than opening another PR.
Every unmerged lane in this checkout:"
  model_msg="WARNING: YOUR OWN lane is unmerged -- a NOT-CLOSEABLE verdict is a TO-DO LIST, not a stopping point.
This session's worktree is on '$self_branch', which is committed but not on origin/main, so you are not
done: rebase, run the gates, open the PR, merge. $push_line
If you are ending the turn with nothing that will re-invoke you, the honest label is STOPPED, not WAITING.
One false positive is expected and is cheap to clear: this repo SQUASH-merges, so a merged branch never
becomes an ancestor of origin/main and keeps reading as ahead. If '$self_branch' is already merged, the
remaining work is to remove its worktree and delete the branch -- not to open another PR. When this tree
is one you must NOT remove (an outer tool owns it, or you were launched inside it), detach instead:
'git switch --detach origin/main' clears the lane here, because a worktree with no current branch is not
a lane at all.
Every unmerged lane in this checkout:"
  channel="ctx"
else
  # Only ever emitted on the user channel, so it needs no twin -- and it is
  # already written for a human: the model cannot act on another session's lane.
  model_msg=""
  user_msg="NOTE: unmerged lane(s) exist in this checkout, none of them this session's.
This session's worktree is not among them, so there is likely nothing here for it to do; they belong to
other sessions, or are already merged (this repo SQUASH-merges, so a merged branch never becomes an
ancestor of origin/main and keeps reading as ahead -- clearing one means removing its worktree and
deleting the branch, not opening another PR).
Lanes:"
  channel="sys"
fi

# CADENCE. `stop_hook_active` above stops a nudge from SPINNING inside one
# turn, and that is all it does. Across turns the condition persists, so an
# unconditional `additionalContext` costs one forced model turn at every single
# turn-end for as long as the lane exists -- including the two states where
# there is nothing left to do: the PR is open and CI is running (the session is
# legitimately WAITING), and the lane was squash-merged with its worktree left
# behind, which reads as ahead FOREVER. Worse than slow: a Stop hook's
# `additionalContext` travels in the same return value as a `decision: "block"`,
# so both spend one budget -- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, 8 consecutive
# blocks by default -- after which the harness overrides the hook and ends the
# turn. The hook that spends the budget is not necessarily the one with
# something urgent to say.
#
# So the model is nudged at most once per distinct SUBJECT, and a repeat of the
# same subject falls back to `systemMessage`: the user still sees it, the turn
# ends. The subject is the branch plus whether it is pushed, so:
#
#   a lane never nudged in this session -> nudge
#   the same lane, unpushed -> pushed   -> nudge (a PR should exist now, and a
#                                          pushed branch with none is the
#                                          failure this hook is for)
#   the same lane, same push state      -> quiet
#   the same lane, pushed -> unpushed   -> quiet (see the DIRECTED note below)
#   a DIFFERENT lane                    -> nudge (it is a different subject)
#
# The commit COUNT is deliberately not in the key: it changes every time the
# model commits, which would re-arm the nudge on ordinary work and leave the
# cadence as unbounded as it started.
#
# There is no WALL-CLOCK re-arm here, unlike `stop-cleanup-warn.sh` next door.
# The difference is deliberate: an unmerged lane costs nothing while it sits, so
# a second telling buys only annoyance, whereas that hook's subject is real AWS
# resources whose cost accrues on the clock.
#
# The record lives in the PER-WORKTREE git dir, so lanes never share one and
# removing a worktree takes its record with it -- the same resolution markgate
# uses for its marker store. One file rewritten in place, not one per session:
# a per-session file would accumulate with nobody to clean it up. A concurrent
# session in the same worktree can therefore clobber it, which costs an EXTRA
# nudge rather than a missed one, the safe direction.
if [ "$resumed" = "1" ]; then
  # A pass the harness already resumed never spends the model channel, and never
  # writes a record either: no nudge was spent, so the next ordinary turn-end is
  # still this subject's first. Recording here would consume the one nudge on a
  # pass that emitted nothing to the model.
  channel="sys"
elif [ "$channel" = "ctx" ]; then
  arm=1
  persisted=0
  git_dir=$(git -C "$session_root" rev-parse --absolute-git-dir 2>/dev/null || true)
  if [ -n "$git_dir" ]; then
    state_file="${git_dir}/stop-nudge-lane"
    subject="${self_branch}:${push_state}"
    prev_sid=""
    prev_subject=""
    if [ -r "$state_file" ]; then
      IFS="$TAB" read -r prev_sid prev_subject _ <"$state_file" 2>/dev/null || true
    fi
    # A refname may not contain a colon, so the LAST one splits the subject
    # unambiguously. A subject carrying none is not a subject this hook wrote --
    # treat it as absent, which arms, the safe direction.
    case "$prev_subject" in
      *:*)
        prev_branch=${prev_subject%:*}
        prev_push=${prev_subject##*:}
        ;;
      *)
        prev_branch=""
        prev_push=""
        ;;
    esac

    # The predicate is DIRECTED, and the plain equality it replaces was a real
    # bug rather than a simplification. `pushed -> unpushed` is what an ordinary
    # COMMIT looks like, so `prev_subject != subject` re-armed on every commit
    # and again on every push: measured on one lane as
    # `commit ctx, repeat sys, push ctx, repeat sys, commit ctx, push ctx, ...`
    # -- two forced continuations per commit/push cycle, forever, which is the
    # per-commit cadence the comment above explicitly disclaims.
    #
    # So the nudge arms on: a new session, a lane never seen, a DIFFERENT
    # branch, a record this hook cannot make sense of, or the one transition
    # that opens an action the model did not have before (`unpushed -> pushed`,
    # after which a PR should exist and its absence is the failure this hook is
    # for). Never `pushed -> unpushed`.
    if [ "$prev_sid" = "$sid" ] && [ -n "$prev_branch" ] && [ "$prev_branch" = "$self_branch" ] &&
      { [ "$prev_push" = "pushed" ] || [ "$prev_push" = "unpushed" ]; }; then
      if [ "$prev_push" = "unpushed" ] && [ "$push_state" = "pushed" ]; then
        arm=1
      else
        arm=0
      fi
    fi

    # Written on BOTH arms, because the record holds the last OBSERVED subject
    # rather than the last NUDGED one. Writing it only when arming freezes
    # `prev_push` at whatever state last nudged, so the next genuine
    # `unpushed -> pushed` compares against a stale half and goes silent. Only
    # the CHANNEL branches on `arm`.
    #
    # `2>/dev/null` precedes the write redirect, and the order is the whole point.
    # Redirections are applied left to right, and the one that FAILS here is the
    # fd-1 open of `$tmp`. Written `>"$tmp" 2>/dev/null` that open is attempted
    # while fd 2 is still the REAL stderr, so "Permission denied" is reported there
    # -- from an advisory hook, on every turn. Putting `2>/dev/null` first silences
    # fd 2 before the open that can fail.
    tmp="${state_file}.$$"
    if printf '%s\t%s\t%s\n' "$sid" "$subject" "$(date +%s)" 2>/dev/null >"$tmp"; then
      if mv -f "$tmp" "$state_file" 2>/dev/null; then
        persisted=1
      else
        rm -f "$tmp" 2>/dev/null || true
      fi
    else
      rm -f "$tmp" 2>/dev/null || true
    fi
  fi

  # A nudge that cannot be RECORDED cannot be bounded, and an unbounded one is
  # exactly what this mechanism exists to remove -- so an unresolvable or
  # unwritable git dir (a read-only checkout, a full disk, a dir owned by
  # someone else) costs the MODEL channel, not the warning itself.
  [ "$persisted" = "1" ] || arm=0
  [ "$arm" = "1" ] || channel="sys"
fi

# The channel decides WHICH text, not just which field: `additionalContext`
# carries the model text and `systemMessage` the user one, so a downgrade changes
# voice as well as audience.
if [ "$channel" = "ctx" ]; then
  msg="$model_msg"
else
  msg="$user_msg"
fi

MSG="$msg
$lanes" CHANNEL="$channel" python3 -c '
import json, os

msg = os.environ["MSG"]
if os.environ["CHANNEL"] == "ctx":
    payload = {"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": msg}}
else:
    payload = {"systemMessage": msg}
print(json.dumps(payload))
'
