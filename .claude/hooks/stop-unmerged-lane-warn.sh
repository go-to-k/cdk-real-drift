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
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
# `[ -n "$REPO" ]` FIRST, and it is not belt-and-braces. When the subshell above
# fails, `REPO` is EMPTY, and `cd "" || exit 0` does not stand the hook down:
# measured, `cd ""` returns 0 on bash 3.2 (macOS's /bin/bash, which
# `#!/usr/bin/env bash` finds on a machine without Homebrew bash first on PATH)
# and 1 on bash 5.3. So on 3.2 the guard passed and the hook went on to run
# `git` against whatever cwd the harness happened to hand it. The `2>/dev/null`
# on the assignment is the same correction one line up: the sibling hook has it
# and this one did not, so a failing `cd` also wrote to the hook's REAL stderr.
[ -n "$REPO" ] || exit 0
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
# EVERY worktree, not only the lanes: the no-lane exit below has to be able
# to clear a cadence record wherever one was left.
all_worktrees=""
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  all_worktrees="${all_worktrees}${wt}
"
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

if [ -z "$lanes" ]; then
  # The condition has CLEARED: no worktree in this repo is ahead of
  # `origin/main`. Drop every cadence record, so the NEXT lane starts ARMED.
  #
  # Without this the record outlived the condition, and the miss is reachable
  # by the very remedy this hook prints. Measured: nudge (ctx), repeat (sys),
  # `git switch --detach origin/main` so nothing is a lane, re-attach and
  # commit again in the SAME session -> `sys`, never `ctx`. The subject is
  # `<branch>:<push state>`, so returning to the same branch in the same push
  # state reproduces the stored subject exactly and the nudge is SWALLOWED --
  # a MISSED nudge, which this file and `CLAUDE.md` both call the
  # unsafe direction. `stop-warn.sh` in the sibling repo has always dropped its
  # record on the clean-tree exit for exactly this reason.
  #
  # EVERY worktree's record is dropped, including other sessions'. "No lane is
  # ahead" is a REPO-GLOBAL fact, so no session has anything left to be quiet
  # about; and the cost of being wrong is one EXTRA nudge, which is the trade
  # the record's own concurrent-clobber comment already accepts.
  #
  # The git dir is derived without forking -- a main worktree has `.git` as a
  # DIRECTORY, a linked one has it as a FILE holding `gitdir: <path>`. This
  # runs on the silent path, which is most turns, so a `git rev-parse` per
  # worktree here would be a per-turn cost paid by every clean session.
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    wt_git_dir=""
    if [ -d "$wt/.git" ]; then
      wt_git_dir="$wt/.git"
    elif [ -f "$wt/.git" ]; then
      IFS=' ' read -r _ wt_git_dir <"$wt/.git" 2>/dev/null || wt_git_dir=""
    fi
    # git writes an ABSOLUTE `gitdir:`; a relative one would resolve against
    # this hook's own cwd and the `rm -f` would simply find nothing, which is
    # the safe direction (an extra nudge, never a missed one).
    [ -n "$wt_git_dir" ] || continue
    rm -f "$wt_git_dir/stop-nudge-lane" 2>/dev/null || true
  done <<CLEAR_RECORDS_EOF
$all_worktrees
CLEAR_RECORDS_EOF
  exit 0
fi

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
# Tabs are stripped from NEITHER here, and that is not the asymmetry this
# comment used to describe. `cwd` must keep its tabs: it is only ever compared
# against a worktree path, a tab is legal in one, and folding it would break the
# tab-in-path case this suite fences. `session_id` must lose them, because it is
# written into a tab-separated record -- but that fold now happens ONCE, below,
# after BOTH of its sources have been consulted. Doing it here as well was a
# second spelling of the same rule that covered only one of the two paths.
# `str()` around each, because `(data.get(x) or "")` is only a STRING when the
# field is absent, null or a string. A payload whose `cwd` is a number or a list
# hands `.replace` a non-string and raises AttributeError -- an advisory hook
# writing a traceback to its REAL stderr, which is the one thing this file
# spends paragraphs avoiding, and `cwd` prints first so BOTH values are lost.
# The block already hardens `json.loads` and `isinstance(data, dict)`; this is
# that same check, stopped one field short. (`stop-cleanup-warn.sh` reads its
# fields with `jq -r`, which COERCES instead of raising, so the pair diverged
# here too.)
print(str(data.get("cwd") or "").replace("\n", " "))
print(str(data.get("session_id") or "").replace("\n", " "))
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
# true-of-one-path.
#
# `stop-cleanup-warn.sh` next door has the same two sources and the same single
# fold, but NOT the same PRECEDENCE, and both files used to claim symmetry they
# do not have. This hook is PAYLOAD-first (the harness's `session_id` is the
# authority on which session this is; the env var is the fallback for a payload
# that omits it). That hook is ENV-first, because its sid also keys the
# `autoarm-<sid>` sentinel filename it shares with `deploy-autoarm-gate.sh` and
# `bughunt-clean-gate.sh`, which read the env var and never see a Stop payload.
# The two agree whenever both sources are present and identical, which is every
# real session; they are left divergent because converging them would rename
# that shared sentinel.
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
  # The user text says nothing about whether the AGENT has been told, and that
  # omission is deliberate. One string reaches all THREE downgrade paths --
  # cadence repeat, unpersistable record, resumed pass -- and "the agent has
  # already been nudged once" is true only of the first. On the other two no
  # nudge was ever spent, and on the unpersistable one the model half is dropped
  # precisely BECAUSE the record cannot be kept, so the agent will never be told
  # and the claim would repeat every turn. That is the same one-emitter,
  # three-paths shape this comment block was written about, reproduced in the
  # TEXT rather than in the code -- and the paragraph above already argues that
  # "the human has already seen it" is false on the resumed path.
  user_msg="NOTE: this session's own lane is unmerged -- '$self_branch' is committed but not on origin/main.
$push_note
If the session ends here, the work stays on the branch and nothing carries it to main. One false positive
is expected and is cheap to clear -- this repo SQUASH-merges, so an already-merged branch keeps reading as
ahead, and clearing that one means removing its worktree and deleting the branch rather than opening
another PR.
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
    prev_ts=""
    prev_rest=""
    if [ -r "$state_file" ]; then
      IFS="$TAB" read -r prev_sid prev_subject prev_ts prev_rest <"$state_file" 2>/dev/null || true
    fi
    # A record is consulted only when it is WELL-FORMED: exactly three
    # tab-separated fields with a numeric epoch. Anything else -- an empty file,
    # a truncated write, a fourth field from a future format, a clobber that
    # interleaved two writers -- is treated as NO record, which falls to ARM.
    # That is the safe direction: an extra nudge, never a missed one.
    #
    # It is also what makes the record's THIRD field load-bearing. Before this
    # the epoch was written on every turn and read by nothing, while CLAUDE.md
    # documented it as part of the shape -- and its absence was precisely what
    # could not be detected. A TAB is IFS *whitespace*, so `read` folds a RUN of
    # them into one separator: a record with an EMPTY subject field
    # (`<sid><TAB><TAB><subject>`) shifted the real subject INTO `prev_subject`,
    # the predicate below matched it, and the lane went QUIET -- a malformed
    # record SILENCING the nudge, the one direction this must not fail in. With
    # the shape check that same record leaves `prev_ts` empty and arms.
    # (Ported from go-to-k/cdk-local's copy of this hook, which had it; this one
    # did not, so only the twin that already had the fix could detect its own
    # regression.)
    case "$prev_ts" in
      "" | *[!0-9]*) prev_sid=""; prev_subject="" ;;
    esac
    [ -z "$prev_rest" ] || { prev_sid=""; prev_subject=""; }
    # A refname may not contain a colon, so the LAST one splits the subject
    # unambiguously. A subject carrying none is not a subject this hook wrote --
    # treat it as absent, which arms, the safe direction. Reachable only through
    # a HAND-EDITED record now that the shape check above runs first: this hook
    # never writes a colon-free subject, and any record it did not write is
    # already rejected unless it also carries a numeric third field.
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
      # `mv -f <file> <dir>` returns SUCCESS -- it moves the tmp INSIDE the
      # directory -- so `mv` alone certified a record that was never written.
      # The readback next turn then found nothing, `persisted` was 1 anyway,
      # and every later turn re-armed: the UNBOUNDED model channel this whole
      # cadence exists to remove, arriving through the success check.
      # Measured: `mv -f <file> <dir>` -> rc 0, file inside the directory.
      # So the destination is confirmed to be a regular FILE, and the tmp the
      # non-move left inside it is swept -- otherwise the git dir grows one
      # orphan per turn.
      if mv -f "$tmp" "$state_file" 2>/dev/null && [ -f "$state_file" ]; then
        persisted=1
      else
        rm -f "$tmp" "$state_file/${tmp##*/}" 2>/dev/null || true
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
