#!/usr/bin/env bash
# Smoke test for stop-unmerged-lane-warn.sh.
#
# Run from BESIDE the hook (`bash .claude/hooks/stop-unmerged-lane-warn.test.sh`):
# the path below is `${BASH_SOURCE[0]}`-relative, so a copy run from a scratch
# directory resolves a hook that is not there and every case fails with 127.
#
# Both polarities are exercised. A Stop hook that only ever proves it FIRES
# cannot notice itself starting to fire on every turn, and a warning that cries
# wolf on a clean tree is one people learn to scroll past -- which is the same
# outcome as not having it.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop-unmerged-lane-warn.sh"

pass=0
fail=0
fail_log=""

# --- BASH 3.2 FENCE ---
# macOS ships bash 3.2 as /bin/bash and this repo runs on it, so the hook has to
# stay 3.2-clean. It was, but only ACCIDENTALLY: every case here launches the hook
# as `bash "$hook"`, which resolves through PATH -- normally a modern Homebrew
# build -- and the shebang is `#!/usr/bin/env bash`, which resolves the same way.
# So running this SUITE under /bin/bash proved nothing whatsoever about the hook;
# both interpreters stayed 5.x.
#
# A shim directory holding one symlink named `bash` goes FIRST on PATH, so every
# child `bash` -- the explicit invocations, the shebang, and the ones inside the
# stubbed-PATH case, whose `command -v bash` now resolves here -- is the fenced
# interpreter. Default /bin/bash (3.2 on macOS, whatever the distro ships
# elsewhere); override with HOOK_BASH to take the other tally.
#
# An explicitly set HOOK_BASH that is not executable is a FATAL error rather than a
# silent fall back to PATH bash: falling back hides a typo in the one setting this
# fence exists to pin, and the run would then report a tally under an interpreter
# nobody asked for. Only the built-in DEFAULT may fall back, since a machine
# without /bin/bash is a fact rather than a mistake.
#
# The shim is trapped for removal the moment it exists, not once the sandbox is
# built: an early failure between the two leaked a directory per run.
SHIMDIR="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$SHIMDIR"' EXIT
if [ -n "${HOOK_BASH:-}" ]; then
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 2
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook interpreter\n' >&2
    exit 2
  }
fi
ln -sf "$HOOK_BASH" "$SHIMDIR/bash"
PATH="$SHIMDIR:$PATH"
export PATH
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

check() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want '$want', got '$got'\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# Since go-to-k/cdk-real-drift#1844 the hook READS the Stop event's JSON from
# stdin, so every invocation has to feed it one. Left unfed, `cat` inherits this
# script's stdin and a case can hang instead of failing -- and a Stop hook that
# hangs never lets a turn end.
#
# Every call starts from a CLEAN nudge record unless a case opts out with
# `run_hook_keep`. The hook nudges the model at most once per subject per
# session and downgrades a repeat to the user channel, so without this reset the
# cases below would each depend on how many earlier ones happened to share their
# branch -- and every case that asserts `ctx` would pass or fail on its POSITION
# in the file rather than on the hook's behaviour.
clear_nudge_records() {
  find "$SANDBOX" -name 'stop-nudge-lane' -type f -delete 2>/dev/null || true
}

run_hook() {
  clear_nudge_records
  run_hook_keep "$@"
}

# The same call WITHOUT the reset -- for the cadence cases, which are precisely
# about what a second invocation does.
run_hook_keep() {
  local dir="$1" hook="$2" stdin="${3-}"
  [ "$#" -ge 3 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$dir" && bash "$hook")
  # The exit STATUS, parked in a file because every call site is a `$(...)`
  # subshell. Silence is not the same as success here: on `Stop` a non-zero exit
  # is a hook ERROR, and every case below that asserts empty output would pass
  # against a hook that crashed before printing.
  printf '%s' "$?" > "$RC_FILE"
}

# The same run with the session id supplied ONLY through the environment, and no
# `session_id` in the payload. That is a SECOND source for `sid`, reached by a line
# that sits after the JSON parse -- so nothing in this file exercised it: every
# payload above carries `session_id`, which means the environment fallback had zero
# coverage and its value reached the cadence record unnormalised.
# Named `_keep` like its sibling because it does NOT clear the nudge record --
# the cadence is the whole subject of the cases that use it, and a helper whose
# name does not encode that is how a later case gets its reset silently removed.
run_hook_env_keep() { # <dir> <hook> <session-id-from-env> [stdin]
  local dir="$1" hook="$2" sess="$3" stdin="${4-}"
  # `$#`, not `-n`: an explicitly EMPTY payload is a case (the hook must survive
  # unparseable stdin), and `-n` would silently replace it with `{}`.
  [ "$#" -ge 4 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$dir" && CLAUDE_CODE_SESSION_ID="$sess" bash "$hook")
  printf '%s' "$?" > "$RC_FILE"
}

# `rc_of` -> the status of the most recent run_hook call.
rc_of() { cat "$RC_FILE"; }

# `has <output> <grep-args...>` -> yes | no. Used by the VOICE cases, where the
# question is which of two texts the payload carries rather than which field.
has() {
  local out="$1"
  shift
  printf '%s' "$out" | grep -q "$@" && echo yes || echo no
}

# `lanes_in <output>` -> how many branch lines the payload named, whichever
# channel carried it. Deliberately channel-AGNOSTIC: the cases below split into
# two groups, and only one of them is about the channel. Every count assertion
# is about which BRANCHES got enumerated, and folding the channel into it would
# make each of those fail for two unrelated reasons at once.
lanes_in() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print(0); raise SystemExit
d = json.loads(raw)
msg = d.get("hookSpecificOutput", {}).get("additionalContext") or d.get("systemMessage") or ""
print(sum(1 for line in msg.splitlines() if line.startswith("  ")))
'
}

# `channel_of <output>` -> ctx | sys | none | BOTH.
#
# On the Stop event the channel IS the behaviour, not a formatting detail:
# `additionalContext` is delivered to the model and CONTINUES the turn, while
# `systemMessage` is shown to the user and lets it end. `BOTH` is reported
# rather than silently preferring one, because a payload carrying both fields
# would continue the turn AND print to the user -- neither of the two designs
# this hook chooses between, and something a test that reads only its own key
# cannot see. (`stop-cleanup-warn.sh` next door deliberately DOES emit both;
# this hook must not.)
channel_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("none"); raise SystemExit
d = json.loads(raw)
ctx = bool(d.get("hookSpecificOutput", {}).get("additionalContext"))
sysm = bool(d.get("systemMessage"))
print("BOTH" if ctx and sysm else "ctx" if ctx else "sys" if sysm else "none")
'
}

# `pwd -P` is load-bearing, not tidiness. On macOS `mktemp -d` hands back a
# path under `/var/folders/...` whose real location is `/private/var/...`, and
# the hook derives its own root with `cd ... && pwd`, which canonicalises. Git,
# meanwhile, records a worktree under whatever path it was CREATED with. So an
# uncanonicalised sandbox makes the hook's root and git's listing two spellings
# of one directory that never compare equal -- and any case whose subject is an
# equality between those two paths passes no matter what the hook does. That is
# how the self-lane case below was measured VACUOUS on its first attempt: the
# defect it was written for (a skip keyed on the hook's own checkout) could be
# reintroduced and the suite stayed green.
SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$SANDBOX" "$SHIMDIR"' EXIT

RC_FILE="$SANDBOX/rc"

REPO="$SANDBOX/repo"
mkdir -p "$REPO/.claude/hooks"
cp "$HOOK" "$REPO/.claude/hooks/"
RUN="$REPO/.claude/hooks/$(basename "$HOOK")"

git -C "$REPO" init -q .
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$REPO" update-ref refs/remotes/origin/main HEAD

# --- SILENT: nothing unmerged. The expensive half to get right, because a
# false alarm every turn is indistinguishable from noise. ---
out=$(run_hook "$REPO" "$RUN")
check "silent when no worktree exists" "" "$out"
check "...and silent means exit 0, not a crash" "0" "$(rc_of)"

# --- SILENT: a worktree that is level with origin/main is not a lane. ---
git -C "$REPO" worktree add -q "$REPO/wt-level" -b feat/level HEAD
out=$(run_hook "$REPO" "$RUN")
check "silent for a worktree with no commits of its own" "" "$out"

# --- SILENT: a DETACHED worktree has no branch to report. It is committed
# AHEAD on purpose: added at HEAD and left alone, the ahead-count check already
# excludes it and the `[ -n "$br" ]` guard this case is named for is never what
# makes it pass. Ahead and branchless, the guard is the only thing standing
# between this and a lane line with an empty branch name.
git -C "$REPO" worktree add -q "$REPO/wt-detached" --detach HEAD
git -C "$REPO/wt-detached" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'detached work'
out=$(run_hook "$REPO" "$RUN")
check "silent for a detached worktree that is ahead" "" "$out"

# --- FIRES: one lane with a commit of its own. ---
git -C "$REPO/wt-level" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "names the one lane that is ahead" "1" "$(lanes_in "$out")"

# --- FIRES: counts each lane separately, and still ignores the detached one. ---
git -C "$REPO" worktree add -q "$REPO/wt-two" -b feat/two HEAD
git -C "$REPO/wt-two" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "names both lanes, not the detached worktree" "2" "$(lanes_in "$out")"

# --- FIRES: run from INSIDE a lane worktree, that lane must still be named. ---
# The case the hook exists for, and the one every case above misses: they all
# `cd "$REPO"` (the main tree), so a skip keyed on the hook's OWN checkout was
# invisible to all of them. An earlier revision derived the skip from
# `BASH_SOURCE` and went silent for exactly this run. The main tree is excluded
# by BRANCH, so removing that skip costs nothing here -- which this case pins
# from the other side, by asserting the count is 2 rather than 3.
mkdir -p "$REPO/wt-two/.claude/hooks"
cp "$HOOK" "$REPO/wt-two/.claude/hooks/"
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")")
check "names its OWN lane when run from inside it" "2" "$(lanes_in "$out")"
# Bind to the SELF line, not to the enumeration. The payload lists every lane,
# so `grep feat/two` is satisfied by the listing no matter which branch the
# message calls the session's own. `-F` plus the trailing comma so `feat/two-x`
# cannot satisfy it either.
if printf '%s' "$out" | grep -qF "This session's worktree is on 'feat/two',"; then
  pass=$((pass + 1)); printf 'OK   the self-lane is the one the message names\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the message names the wrong self-lane\n"; printf 'FAIL the self-lane is the one the message names\n'
fi

# --- SILENT: the main tree ON `main`, ahead of origin/main, is NOT a lane.
# Without this the `main`/`master` filter is unfenced: everywhere else in this
# sandbox the main tree is LEVEL with origin/main, so the ahead-count check
# already excludes it and deleting the branch filter changes nothing. Measured:
# with this case absent, dropping `case "$br" in main|master) continue` left the
# suite green. Direct commits on `main` are a different problem with its own
# gate; this hook reports unmerged LANES.
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'on main'
out=$(run_hook "$REPO" "$RUN")
check "the main tree on main is not a lane even when ahead" "2" "$(lanes_in "$out")"

# --- The BRANCH filter, not the path, is what excludes the main tree. Put the
# main tree on a feature branch that is ahead and it must be named like any
# other lane; otherwise the two filters mask each other and neither is fenced.
git -C "$REPO" checkout -q -b feat/main-tree-lane
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "the main tree on a feature branch is a lane too" "3" "$(lanes_in "$out")"
git -C "$REPO" checkout -q -
git -C "$REPO" branch -q -D feat/main-tree-lane

# --- The payload has to be valid JSON, or the harness swallows it silently. ---
if printf '%s' "$out" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
  pass=$((pass + 1)); printf 'OK   payload is valid JSON\n'
else
  fail=$((fail + 1)); fail_log+="FAIL payload is not valid JSON\n"; printf 'FAIL payload is valid JSON\n'
fi

# --- SILENT, and exit 0, when `python3` is not installed. Everything past the
# lane check is built by `python3`, so without the guard the script ends on a
# `command not found` and returns 127 -- an ERROR reported on every single turn,
# from a hook whose entire job is advisory. ---
# The list is every external the hook reaches for BEFORE the guard, `bash` and
# `env` included -- `PATH=... bash` resolves `bash` through the replaced PATH
# too, and the shebang is `env bash`. Each of them was added because its absence
# produced a DIFFERENT failure than the one under test, which is the trap here:
# a stub PATH that is too small makes the case pass for the wrong reason.
STUBBIN="$SANDBOX/no-python"
mkdir -p "$STUBBIN"
for c in bash env dirname git awk sed cat; do
  ln -sf "$(command -v "$c")" "$STUBBIN/$c"
done
out=$( (cd "$REPO" && printf '%s' '{}' | PATH="$STUBBIN" bash "$RUN"); printf '%s' "$?" > "$RC_FILE")
check "silent when python3 is unavailable" "" "$out"
check "...and exits 0 rather than 127" "0" "$(rc_of)"

# --- SILENT: no `origin/main` at all (a fresh clone before the first fetch)
# must not error or spam. ---
BARE="$SANDBOX/norem"
mkdir -p "$BARE/.claude/hooks"
cp "$HOOK" "$BARE/.claude/hooks/"
git -C "$BARE" init -q .
git -C "$BARE" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
out=$(run_hook "$BARE" "$BARE/.claude/hooks/$(basename "$HOOK")")
check "silent when origin/main is unresolvable" "" "$out"
check "...and that too is exit 0" "0" "$(rc_of)"

# Re-run against the two-lane sandbox: the case above left `$out` empty (it ran
# in the no-remote repo), and an assertion about the payload's SHAPE cannot be
# made against no payload.
out=$(run_hook "$REPO" "$RUN")
check "still names both lanes on re-run" "2" "$(lanes_in "$out")"

# --- CHANNEL (go-to-k/cdk-real-drift#1844): the session's OWN lane reaches the
# MODEL. `additionalContext` is the only field that does, and it continues the
# turn so the model can act -- which is the failure this hook was written for,
# an agent ending the turn with its own branch committed and no PR. Until #1844
# every word left as `systemMessage`, the USER-only channel: a message written
# at the AGENT reached only the party who cannot act on it. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")")
check "own lane goes to the model" "ctx" "$(channel_of "$out")"
check "own lane payload still enumerates every lane" "2" "$(lanes_in "$out")"
if printf '%s' "$out" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
sys.exit(0 if d["hookSpecificOutput"]["hookEventName"] == "Stop" else 1)
'; then
  pass=$((pass + 1)); printf 'OK   the hookEventName is Stop\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the hookEventName is not Stop\n"; printf 'FAIL the hookEventName is Stop\n'
fi

# --- CHANNEL: lanes that belong to SOMEONE ELSE go to the user instead. The
# model cannot act on another session's worktree, so continuing the turn buys
# one extra reply that can only say "not mine". This repo SQUASH-merges, so a
# merged branch reads as ahead forever and one un-removed worktree would have
# made that permanent. ---
out=$(run_hook "$REPO" "$RUN")
check "other sessions' lanes go to the user" "sys" "$(channel_of "$out")"
check "the user-facing payload still enumerates them" "2" "$(lanes_in "$out")"

# --- The OWNERSHIP test reads `cwd` out of the event payload, not just the path
# the hook was launched from. Run from the main tree while `cwd` names the lane:
# without reading `cwd` this answers `sys`, so the two cases above cannot see
# the difference on their own -- each of them has the launch path and `cwd`
# agreeing, which is exactly the pair that makes either signal look sufficient.
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-two\"}")
check "cwd naming a lane makes it the session's own" "ctx" "$(channel_of "$out")"

# --- ...and the same field pointing at a NON-lane worktree must NOT. Otherwise
# "cwd is set" rather than "cwd is a lane" would be what flips the channel, and
# the case above would pass under a hook that simply believes any cwd. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-detached\"}")
check "cwd naming a non-lane worktree stays user-facing" "sys" "$(channel_of "$out")"

# --- The session reached through a SYMLINKED spelling of its lane is still the
# owner of that lane. No `cwd` in the payload, so the BASH_SOURCE fallback is
# what has to answer -- and that path is built with `cd ... && pwd`, which keeps
# the spelling it was reached BY, while git reports the real one. Without the
# canonicalisation this compares a symlink to a real path, never matches, and
# quietly hands the agent its own lane on the user-only channel.
#
# Every other case here is blind to that: git canonicalises both of ITS answers,
# so the two sides agree no matter what, and dropping the canonicalisation
# leaves the suite green. ---
ln -s "$REPO/wt-two" "$SANDBOX/wt-two-link"
out=$(run_hook "$SANDBOX/wt-two-link" "$SANDBOX/wt-two-link/.claude/hooks/$(basename "$HOOK")")
check "a symlinked lane path is still the session's own lane" "ctx" "$(channel_of "$out")"

# --- USER-ONLY on the continuation pass. `additionalContext` CONTINUES the turn,
# so a hook that keeps emitting it turns one nudge into a spin: the model is
# pushed back to work, reaches Stop again with the same unmerged lane, and is
# pushed again. The harness marks that second pass with `stop_hook_active`, and
# dropping the MODEL half on it is what bounds this hook to a single forced
# continuation. Without this case that branch is unfenced -- every case above
# passes `{}`, where the flag is absent, so it could be deleted and the suite stay
# green.
#
# It used to go fully SILENT here, which was wrong for the same reason the
# neighbouring stop-cleanup-warn.sh was: the condition can first become TRUE
# during the continuation. The continuation exists to push the model back to work,
# and committing the lane is exactly that work -- so this pass can be the first on
# which there is any lane at all, and a silent hook means nobody ever learns. A
# bare `systemMessage` does not continue a turn, so the user half costs nothing. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")" '{"stop_hook_active": true}')
check "a resumed pass drops the model half but still tells the user" "sys" "$(channel_of "$out")"
check "...and still enumerates the lanes" "2" "$(lanes_in "$out")"
check "...standing down is exit 0, not a crash" "0" "$(rc_of)"

# --- ...and NOT silent when the flag is present but false, which is the shape
# every ordinary turn actually sends. A truthiness check that reads the KEY
# rather than its VALUE would go permanently silent here, and the case above
# cannot see that -- it only ever sends `true`. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")" '{"stop_hook_active": false}')
check "fires when the continuation flag is present but false" "2" "$(lanes_in "$out")"
check "...and still reaches the model, not just the user" "ctx" "$(channel_of "$out")"

# --- A worktree path containing a SPACE is still a lane. `git worktree list
# --porcelain` prints `worktree <path>` with the path unquoted and unescaped, so
# reading it with `$2` -- which is what this hook did until #1844 -- truncates at
# the first space; `git -C <truncated>` then fails and the lane is dropped from
# BOTH the enumeration and the ownership comparison, so the hook goes silent
# about a lane that exists. That is the one failure direction it must not have. ---
git -C "$REPO" worktree add -q "$REPO/wt with space" -b feat/spaced HEAD
git -C "$REPO/wt with space" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "a worktree path with a space is still enumerated" "3" "$(lanes_in "$out")"
if printf '%s' "$out" | grep -q 'feat/spaced'; then
  pass=$((pass + 1)); printf 'OK   the spaced lane is named\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the spaced lane is not named\n"; printf 'FAIL the spaced lane is named\n'
fi

# --- ...and it can be the session's OWN lane. Enumeration and ownership read
# the same path through two different paths in the script, so a truncation that
# still enumerates could break only the comparison. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt with space\"}")
check "a spaced path can be the session's own lane" "ctx" "$(channel_of "$out")"
git -C "$REPO" worktree remove --force "$REPO/wt with space"
git -C "$REPO" branch -q -D feat/spaced

# --- A worktree path containing a BACKSLASH or a TAB is still matched. Both
# are legal in a path and neither is legal in a git refname, which is why the
# row is `branch<TAB>path` and split at the FIRST tab -- the branch side cannot
# contain one, so whatever follows is the whole path however it is spelled.
# These fence the two awk spellings that were tried and rejected: `-v root=...`
# expands backslash escapes in the value (the backslash case), and `-F'\t'`
# puts a tabbed path in the wrong field (the tab case). Neither is visible to
# any other case -- both mismatch quietly and fall through to the not-mine
# branch, which is the safe direction and therefore the silent one. ---
#
# The payload is built with `json.dumps`, not `printf`: a literal backslash or
# tab inside a JSON string is not valid JSON, so hand-formatting one makes the
# hook fall back to BASH_SOURCE and the case then passes or fails for a reason
# that has nothing to do with the path. A real harness escapes these; the
# fixture must too.
odd_n=0
for odd in 'bs\path' "$(printf 'tab\tpath')"; do
  odd_n=$((odd_n + 1))
  git -C "$REPO" worktree add -q "$REPO/$odd" -b "feat/odd-$odd_n" HEAD
  git -C "$REPO/$odd" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
  payload=$(CWD="$REPO/$odd" python3 -c 'import json, os; print(json.dumps({"cwd": os.environ["CWD"]}))')
  out=$(run_hook "$REPO" "$RUN" "$payload")
  check "a path with a backslash or tab is the session's own lane [$odd_n]" "ctx" "$(channel_of "$out")"
  git -C "$REPO" worktree remove --force "$REPO/$odd"
  git -C "$REPO" branch -q -D "feat/odd-$odd_n"
done

# --- `stop_hook_active` as the STRING "false" must not be read as a
# continuation. Python treats any non-empty string as truthy, so the naive read
# makes this the same as `true`. The boolean cases above cannot see it.
#
# Both run from INSIDE a lane, which is now the load-bearing half: since a
# resumed pass emits `systemMessage` rather than nothing, the flag no longer
# separates silence from output -- it separates the MODEL channel from the user
# one, and only a session standing in its own lane has a model channel to lose.
# Run from the main tree these two would read `sys` either way. ---
WT_TWO_HOOK="$REPO/wt-two/.claude/hooks/$(basename "$HOOK")"
out=$(run_hook "$REPO/wt-two" "$WT_TWO_HOOK" '{"stop_hook_active": "false"}')
check "the string \"false\" does not count as a continuation" "ctx" "$(channel_of "$out")"
check "...and it still enumerates every lane" "2" "$(lanes_in "$out")"
out=$(run_hook "$REPO/wt-two" "$WT_TWO_HOOK" '{"stop_hook_active": "true"}')
check "the string \"true\" does count as one" "sys" "$(channel_of "$out")"
check "...and a continuation still enumerates the lanes for the user" "2" "$(lanes_in "$out")"

# --- ...and the NON-boolean shapes must be read the same way `stop-cleanup-warn.sh`
# reads them. That hook parses this field with `jq`, this one with `python3`, and
# the two spellings do not agree by default -- jq truthiness makes `0` a
# continuation, `$f == true` makes `1` an ordinary turn, and Python does neither.
# Python's rule is the one both now follow, so these pin this side of the pair.
out=$(run_hook "$REPO/wt-two" "$WT_TWO_HOOK" '{"stop_hook_active": 1}')
check "a TRUTHY number counts as a continuation" "sys" "$(channel_of "$out")"
out=$(run_hook "$REPO/wt-two" "$WT_TWO_HOOK" '{"stop_hook_active": 0}')
check "...and a falsy one does not" "ctx" "$(channel_of "$out")"
out=$(run_hook "$REPO/wt-two" "$WT_TWO_HOOK" '{"stop_hook_active": []}')
check "...nor does an empty array" "ctx" "$(channel_of "$out")"

# --- Malformed / absent stdin must not take the warning down with it. The hook
# reads stdin only to find three fields; a harness that sends nothing parseable
# is not a reason to go quiet about an unmerged lane. ---
# The channel is asserted alongside the count, not just the count: an
# unparseable payload yields no `cwd`, and a hook that fell back to claiming the
# FIRST lane as the session's own would still enumerate two and pass on the
# count alone.
out=$(run_hook "$REPO" "$RUN" 'not json at all')
check "fires when the event JSON is unparseable" "2" "$(lanes_in "$out")"
check "...and does not claim a lane it cannot attribute" "sys" "$(channel_of "$out")"
out=$(run_hook "$REPO" "$RUN" '')
check "fires when stdin is empty" "2" "$(lanes_in "$out")"
check "...and likewise claims nothing" "sys" "$(channel_of "$out")"

# --- The realistic `cwd`: a session sits SOMEWHERE INSIDE its worktree, rarely
# at the root. Resolution is via `rev-parse --show-toplevel`, so a subdirectory
# must attribute the same as the root; a naive string compare would not. ---
mkdir -p "$REPO/wt-two/src/deep"
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-two/src/deep\"}")
check "a subdirectory of a lane attributes to that lane" "ctx" "$(channel_of "$out")"

# --- `cwd` in no git repository at all, and `cwd` in the MAIN tree: both are
# "not a lane of mine", and neither may error out. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$SANDBOX\"}")
check "cwd outside any repo stays user-facing" "sys" "$(channel_of "$out")"
check "...and still exits 0" "0" "$(rc_of)"
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO\"}")
check "cwd in the main tree stays user-facing" "sys" "$(channel_of "$out")"

# --- CADENCE (go-to-k/cdk-real-drift#1844). `stop_hook_active` stops a nudge
# spinning INSIDE one turn; nothing stops it firing again at every later
# turn-end for as long as the lane exists, and a Stop `additionalContext` spends
# the same 8-block budget a `decision: "block"` does. Every case here fails
# against a hook with no record to consult, which answers `ctx` unconditionally.
#
# These build their OWN lanes rather than reusing the ones above, several of
# which have been removed by this point in the file -- reusing one would measure
# the not-my-lane branch and pass or fail on where it sits, exactly the
# order-dependence `clear_nudge_records` exists to remove. They are also the
# only cases that must NOT reset the record, so they call `run_hook_keep`.
git -C "$REPO" worktree add -q "$REPO/wt-cad-a" -b feat/cad-a HEAD
git -C "$REPO/wt-cad-a" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
git -C "$REPO" worktree add -q "$REPO/wt-cad-b" -b feat/cad-b HEAD
git -C "$REPO/wt-cad-b" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work

A1="{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-one\"}"
A2="{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-two\"}"
B1="{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-one\"}"

clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "first sight of a lane nudges the model" "ctx" "$(channel_of "$out")"
# The armed half is the control for the voice cases below: without it a hook that
# sent the USER text on both channels would satisfy every "not addressed to the
# agent" check and lose the nudge's entire content.
check "...and the model half is the text written AT the agent" "yes" \
  "$(has "$out" -F 'WARNING: YOUR OWN lane is unmerged')"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the same lane again does NOT force a second turn" "sys" "$(channel_of "$out")"
# --- ...and the downgrade changes VOICE, not only audience. The model text is
# written AT the agent ("YOUR OWN lane", "rebase, run the gates", "the honest label
# is STOPPED"); routing it to `systemMessage` hands a human a list of instructions
# addressed to somebody else, which is go-to-k/cdkd#2389 in miniature -- the very
# defect this hook was rewritten to fix. There are THREE paths that downgrade a
# self-lane warning (this cadence repeat, an unpersistable record, a resumed pass)
# and each is checked, since one shared emitter is exactly the shape where fixing
# one path leaves the others.
check "...and the downgraded text carries nothing addressed to the agent" "no" \
  "$(has "$out" -E 'YOUR OWN lane|rebase, run the gates|the honest label is STOPPED')"
check "...while still naming the lane as the session's own" "yes" \
  "$(has "$out" -F "own lane is unmerged -- 'feat/cad-a'")"
# The downgrade must not be a MUTE. Choosing `systemMessage` over silence is the
# whole point -- the human keeps seeing the lane -- and a hook that simply
# exited would also read as "not ctx" and pass the line above.
if printf '%s' "$out" | grep -q 'feat/cad-a'; then
  pass=$((pass + 1)); printf 'OK   ...but the user is still told which lane\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the downgraded warning still names the lane\n"; printf 'FAIL the downgraded warning still names the lane\n'
fi

# A different LANE is a different subject, so it re-arms. Without this the first
# lane of a session would silence every later one -- strictly worse than the
# bounded cost being paid here. The two lanes keep SEPARATE records, since each
# lives in its own worktree git dir, so this cannot be satisfied by a single
# shared slot.
out=$(run_hook_keep "$REPO" "$RUN" "$B1")
check "a different lane in the same session nudges again" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and the first lane stays quiet, records being per-worktree" "sys" "$(channel_of "$out")"

# A different SESSION gets its own one nudge. It also overwrites the record --
# one file per worktree, not one per session, so nothing accumulates in the git
# dir with no one to clean it up. The cost is that the earlier session re-arms
# once, which is an EXTRA nudge rather than a missed one; that direction is the
# reason the trade is acceptable, so it is pinned rather than left to be
# rediscovered as a bug.
out=$(run_hook_keep "$REPO" "$RUN" "$A2")
check "a DIFFERENT session gets its own one nudge" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and a concurrent session's write costs an extra nudge, not a lost one" "ctx" "$(channel_of "$out")"

# --- PUSH STATE. It is in the SUBJECT (so unpushed -> pushed re-arms exactly
# once) and in the TEXT (so the message names which half of the work is left) --
# but NOT in the channel decision, which would go quiet on a branch pushed with
# NO PR: a real failure, and one of the two this hook exists to catch.
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an unpushed lane says so in the text" "yes" "$(printf '%s' "$out" | grep -qF 'no upstream yet' && echo yes || echo no)"

# `remote.origin.fetch` is load-bearing, not boilerplate: without the refspec
# git refuses `@{u}` with "upstream branch ... not stored as a remote-tracking
# branch", the hook reads that as unpushed, and the two cases below pass or fail
# for a reason that has nothing to do with the cadence.
git -C "$REPO" config remote.origin.url "$REPO"
git -C "$REPO" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$REPO" update-ref "refs/remotes/origin/feat/cad-a" "$(git -C "$REPO" rev-parse feat/cad-a)"
git -C "$REPO" config "branch.feat/cad-a.remote" origin
git -C "$REPO" config "branch.feat/cad-a.merge" refs/heads/feat/cad-a
check "the fixture really did give the lane an upstream" "0" "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "pushing the lane re-arms the nudge once" "ctx" "$(channel_of "$out")"
check "...and the text switches to the pushed-but-maybe-no-PR wording" "yes" "$(printf '%s' "$out" | grep -qF 'pushed branch with NO PR' && echo yes || echo no)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and a pushed lane stops nagging again after that one" "sys" "$(channel_of "$out")"

# --- The predicate is DIRECTED, and a plain `prev_subject != subject` was not a
# simplification of it but a bug. `pushed -> unpushed` is what an ordinary COMMIT
# looks like, so an undirected test re-armed on every commit and again on every
# push: measured on one lane as `commit ctx, repeat sys, push ctx, repeat sys,
# commit ctx, push ctx, ...` -- two forced continuations per commit/push cycle,
# forever, which is the per-commit cadence this hook's own comment disclaims. Only
# `unpushed -> pushed` re-arms, because only that transition opens an action the
# model did not have before (a PR should now exist, and a pushed branch with none
# is the failure this hook is for). ---
git -C "$REPO/wt-cad-a" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'more work'
check "the fixture really did leave a commit unpushed" "1" \
  "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a COMMIT on a pushed lane does NOT re-arm the nudge" "sys" "$(channel_of "$out")"
# ...and while it is there, the MIDDLE push arm. Three arms exist -- no upstream,
# N commits unpushed, fully pushed -- and only the outer two were ever asserted:
# corrupting this one's wording left the suite 56/56 green.
check "...and the text names how many commits are unpushed" "yes" \
  "$(printf '%s' "$out" | grep -qF '1 commit(s) not yet pushed' && echo yes || echo no)"

# --- The record is written on BOTH arms, because it holds the last OBSERVED
# subject rather than the last NUDGED one. Recording only when arming freezes
# `prev_push` at whatever state last nudged -- here `pushed`, from before the
# commit above -- so the next genuine `unpushed -> pushed` compares against a
# stale half and goes silent. This is the case that separates the two: it can
# only pass if the quiet turn above still wrote what it saw. ---
git -C "$REPO" update-ref "refs/remotes/origin/feat/cad-a" "$(git -C "$REPO" rev-parse feat/cad-a)"
check "the fixture really did push the new commit" "0" \
  "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...so the NEXT genuine unpushed -> pushed still re-arms" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and then goes quiet again" "sys" "$(channel_of "$out")"

# --- A MALFORMED record falls to ARMING, the safe direction. Nothing here ever
# wrote one, so every shape below was unfenced -- while in production a record is
# exactly what an interrupted write, a concurrent session or an older version of
# this hook can leave behind in a shape this one does not expect. A subject that
# cannot be split into `<branch>:<pushed|unpushed>` is not a subject this hook
# wrote, and treating it as a match would silence a real lane. ---
CAD_A_STATE="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)/stop-nudge-lane"
mal_n=0
for mal in \
  'sess-one' \
  "$(printf 'sess-one\t\t123')" \
  "$(printf 'sess-one\tfeat/cad-a\t123')" \
  "$(printf 'sess-one\tfeat/cad-a:banana\t123')" \
  'total garbage'; do
  mal_n=$((mal_n + 1))
  printf '%s\n' "$mal" > "$CAD_A_STATE"
  out=$(run_hook_keep "$REPO" "$RUN" "$A1")
  check "a record this hook cannot parse re-arms rather than silencing [$mal_n]" "ctx" "$(channel_of "$out")"
done

# --- A record that cannot be PERSISTED costs the MODEL channel, not the warning.
# The record is what BOUNDS the nudge, so an unwritable git dir (a read-only
# checkout, a full disk, a directory owned by another user) meant every later turn
# re-armed -- unbounded, which is the failure the cadence exists to remove. ---
CAD_A_GITDIR="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)"
clear_nudge_records
chmod 555 "$CAD_A_GITDIR"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
chmod 755 "$CAD_A_GITDIR"
check "an unpersistable record downgrades to the user channel" "sys" "$(channel_of "$out")"
check "...but the user is still told which lane" "yes" "$(has "$out" -F 'feat/cad-a')"
check "...in the user's voice, not the agent's" "no" \
  "$(has "$out" -E 'YOUR OWN lane|rebase, run the gates')"
# --- ...and it does not tell the human the AGENT has been told. That claim is
# the delta's central fix and NOTHING pinned it: the user text is one string
# reaching all three downgrade paths, and "the agent has already been nudged
# about this lane once, so this repeat is for you" is true of the cadence repeat
# ONLY. HERE it is worst -- the model half was dropped precisely BECAUSE the
# record cannot be written, so the agent will never be told and the false claim
# would repeat on every later turn. The voice checks above cannot see it: the
# sentence names no agent-voice phrase and does name the lane, so restoring it
# leaves them green: measured at the time, every OTHER case in this file passed
# with the sentence put back, and only the case below reddened. The figure that
# used to stand here was a case COUNT, which reads as a claim about this suite's
# current size and went stale the moment a case was added. The property is
# "every other case stays green", so it is stated that way instead. ---
check "...and does not claim the agent has already been nudged" "no" \
  "$(has "$out" -E 'already been nudged|already been told|this repeat is for you')"

# --- The continuation flag outranks the cadence: the harness has already resumed
# once inside this turn, so even a freshly-armed subject drops the MODEL half. It
# does NOT go silent -- the lane can be committed DURING the continuation (that is
# what the continuation pushed the model back to do), in which case this pass is
# the first on which there is any lane to report and silence means nobody ever
# learns. A bare `systemMessage` does not continue a turn, so nothing spins. ---
CAD_B_STATE="$(git -C "$REPO/wt-cad-b" rev-parse --absolute-git-dir)/stop-nudge-lane"
B3_RESUMED="{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-three\", \"stop_hook_active\": true}"
B3_PLAIN="{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-three\"}"
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$B3_RESUMED")
check "a resumed pass drops the model half but still tells the user" "sys" "$(channel_of "$out")"
check "...and still names the lane" "yes" "$(has "$out" -F 'feat/cad-b')"
check "...in the user's voice, not the agent's" "no" \
  "$(has "$out" -E 'YOUR OWN lane|rebase, run the gates')"
# The second of the two paths on which "the agent has already been nudged" is
# false: no nudge was spent here at all -- the subject is freshly armed and the
# model half is dropped only because the harness has already resumed once inside
# this turn. See the unpersistable case above for why the voice checks cannot
# stand in for this one.
check "...and does not claim the agent has already been nudged" "no" \
  "$(has "$out" -E 'already been nudged|already been told|this repeat is for you')"
# No nudge was spent, so none may be recorded: a record written here would consume
# this subject's one model nudge on a pass that reached the model with nothing.
check "...and it wrote no cadence record" "absent" \
  "$([ -e "$CAD_B_STATE" ] && echo present || echo absent)"
out=$(run_hook_keep "$REPO" "$RUN" "$B3_PLAIN")
check "...so the next ordinary turn still gets its nudge" "ctx" "$(channel_of "$out")"

# --- `cwd` carrying a NEWLINE must not corrupt the session id. The payload is
# parsed by printing three LINES and picking them apart with `sed -n 1p/2p/3p`, so
# an unstripped newline in `cwd` shifts `session_id` off the end and `sid` becomes
# the TAIL OF THE PATH. Measured before the fix: a payload whose `cwd` was
# "<lane path>\nJUNK" wrote `sid=JUNK` into the cadence record -- keyed on a
# fragment of a directory name, so no two turns of one session ever agreed.
# Folded to a space, the value no longer names a directory and the hook falls to
# the not-mine channel, which is the safe direction for a field it cannot trust. ---
clear_nudge_records
NL_PAYLOAD=$(CWD="$REPO/wt-cad-b" python3 -c '
import json, os
print(json.dumps({"cwd": os.environ["CWD"] + "\nJUNK", "session_id": "sess-nl"}))
')
out=$(run_hook_keep "$REPO" "$RUN" "$NL_PAYLOAD")
check "a cwd containing a newline is not attributed to a lane" "sys" "$(channel_of "$out")"
check "...and no record was keyed on a fragment of the path" "absent" \
  "$([ -e "$CAD_B_STATE" ] && echo present || echo absent)"

# --- The session id read from the ENVIRONMENT. It is a SECOND source, consulted
# by a line that sits after the JSON parse, so the normalisation applied inside the
# parse never touched it -- and every other payload in this file carries a
# `session_id`, which left that line with no coverage at all. It reaches a
# tab-separated record read back with `IFS=<TAB> read`, where a tab is IFS
# *whitespace*: a leading empty field is dropped and a run collapses, so the
# read-back never compares equal and the nudge never arms down. Measured before the
# fix: `s1` gave `ctx, sys, sys` while `<TAB>abc`, `a<TAB>b` and `a<NL>b` each gave
# `ctx, ctx, ctx` -- an unbounded `additionalContext` against the 8-block cap. The
# well-formed id is included as the control that these measure the env path at all.
ENV_PAYLOAD="{\"cwd\": \"$REPO/wt-cad-b\"}"
env_n=0
for esid in 's1' "$(printf '\tabc')" "$(printf 'a\tb')" "$(printf 'a\nb')"; do
  env_n=$((env_n + 1))
  clear_nudge_records
  out=$(run_hook_env_keep "$REPO" "$RUN" "$esid" "$ENV_PAYLOAD")
  check "an env-supplied session id nudges the model once [$env_n]" "ctx" "$(channel_of "$out")"
  out=$(run_hook_env_keep "$REPO" "$RUN" "$esid" "$ENV_PAYLOAD")
  check "...and the cadence still bounds it [$env_n]" "sys" "$(channel_of "$out")"
done

# --- An EXPLICITLY EMPTY payload on the env path. `run_hook` has carried this
# case from the start ("fires when stdin is empty"); the env helper had none,
# which is why its payload guard could be written as `[ -n "$stdin" ]` -- a form
# that silently REPLACES an empty payload with `{}` -- with nothing to notice.
#
# Two cases, because the obvious one alone does not fence the guard. Through the
# real hook, empty stdin and `{}` are INDISTINGUISHABLE by construction: the
# parse is `json.loads(os.environ.get("HOOK_INPUT") or "{}")`, so an empty string
# IS `{}` there. Measured -- reverting the guard to `[ -n "$stdin" ]` leaves the
# case below green. It is still worth having (the hook must survive an empty
# payload on this path, and nothing said so), but it is documentation, not a
# fence.
clear_nudge_records
out=$(run_hook_env_keep "$REPO" "$RUN" 'sess-empty' '')
# By NAME rather than by count: this sits late in the file, after several
# worktrees have been added and removed, so a total would pass or fail on its
# position -- the order-dependence `clear_nudge_records` exists to remove,
# arriving through the assertion instead of through the record.
check "an empty payload on the env path still enumerates the lanes" "yes" \
  "$(has "$out" -F 'feat/cad-b')"
check "...and claims no lane it cannot attribute" "sys" "$(channel_of "$out")"
check "...and exits 0" "0" "$(rc_of)"

# --- The DISCRIMINATING malformed record: subject empty, and the field after it
# is a well-formed subject. A TAB is IFS *whitespace*, so `IFS=<TAB> read` folds
# a RUN of them into ONE separator and that field arrives as `prev_subject` --
# the predicate matches it and the lane goes QUIET. A malformed record SILENCING
# the nudge is the one direction this must not fail in, and none of the five
# shapes above reaches it: each hands `prev_subject` a value that cannot split
# into `<branch>:<state>`, so they arm under the fold too. The sibling repo's
# copy of this hook has carried the shape check that rejects this since its own
# review; this one did not.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the fold fixture starts from a real arm" "ctx" "$(channel_of "$out")"
REAL_SUBJECT=$(awk -F'\t' 'NR==1{print $2}' "$CAD_A_STATE")
check "...and the record really carries a subject to shift" "yes" \
  "$([ -n "$REAL_SUBJECT" ] && echo yes || echo no)"
printf 'sess-one\t\t%s\n' "$REAL_SUBJECT" > "$CAD_A_STATE"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an EMPTY subject field does not let the next field silence the lane" "ctx" "$(channel_of "$out")"
# A FOURTH field is the other half of the shape check, and the same argument: a
# record this hook did not write must not be trusted verbatim.
printf 'sess-one\t%s\t123\textra\n' "$REAL_SUBJECT" > "$CAD_A_STATE"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a record carrying a FOURTH field arms" "ctx" "$(channel_of "$out")"
# The control, so none of the above is satisfied by a hook that stopped reading
# the record: the WELL-FORMED record it writes itself is still trusted.
printf 'sess-one\t%s\t123\n' "$REAL_SUBJECT" > "$CAD_A_STATE"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...while a WELL-FORMED repeat still goes quiet" "sys" "$(channel_of "$out")"

# --- The record path is a DIRECTORY. `mv -f <file> <dir>` returns SUCCESS -- it
# moves the tmp INSIDE the directory -- so the write was certified, the readback
# next turn found nothing, and EVERY turn re-armed `additionalContext` against
# CLAUDE_CODE_STOP_HOOK_BLOCK_CAP while the git dir grew one orphan tmp per
# turn. That is the unbounded cadence this whole mechanism exists to remove,
# arriving through the success check -- the one failure `mv`'s own exit code
# cannot report, which is why the unwritable-git-dir case above does not cover
# it. Measured with `mv` alone: `ctx ctx ctx`.
clear_nudge_records
rm -f "$CAD_A_STATE"
mkdir -p "$CAD_A_STATE"
dir_channels=""
for _ in 1 2 3; do
  out=$(run_hook_keep "$REPO" "$RUN" "$A1")
  dir_channels="${dir_channels}$(channel_of "$out") "
done
dir_orphans=$(find "$CAD_A_STATE" -type f 2>/dev/null | wc -l | tr -d ' ')
rm -f "$CAD_A_STATE"/* 2>/dev/null || true
rmdir "$CAD_A_STATE" 2>/dev/null || true
check "a record path that is a DIRECTORY never arms the model channel" "sys sys sys " "$dir_channels"
check "...and leaves no orphan tmp behind in the git dir" "0" "$dir_orphans"

# --- The failed record write must not reach the hook's REAL stderr. The
# redirect is spelled `2>/dev/null >"$tmp"`, in that order, and the order is the
# whole point: redirections are applied left to right, and the open that FAILS
# is the fd-1 open of `$tmp`. Written `>"$tmp" 2>/dev/null` that open happens
# while fd 2 is still the real stderr, so "Permission denied" is printed there
# from an ADVISORY hook, on every turn. Swapping the two left this suite green
# because nothing here captured the hook's stderr at all; the cleanup twin has
# fenced this exact claim for two rounds.
clear_nudge_records
chmod 555 "$CAD_A_GITDIR"
err=$( (printf '%s' "$A1" | (cd "$REPO" && bash "$RUN")) 2>&1 >/dev/null )
chmod 755 "$CAD_A_GITDIR"
check "a failed record write says nothing on the hook's real stderr" "" "$err"

# --- The session-id SOURCES, keyed on the record rather than on the reset. The
# loop above clears the record between values, so it fences the tab/newline FOLD
# and not the `CLAUDE_CODE_SESSION_ID` fallback it names: with that line deleted
# every run reads `sid=shared`, and clearing the record first makes each value's
# FIRST run arm regardless. Driving A, B, A through ONE record is what separates
# them: three distinct sessions each get their own nudge, while a hook that
# cannot tell them apart swallows the second and third.
clear_nudge_records
env_src=""
for esid in 'src-a' 'src-b' 'src-a'; do
  out=$(run_hook_env_keep "$REPO" "$RUN" "$esid" "$ENV_PAYLOAD")
  env_src="${env_src}$(channel_of "$out") "
done
check "each env-supplied session gets its own nudge" "ctx ctx ctx " "$env_src"

# --- NEITHER source present. `sid` then defaults to `shared`, and the cadence
# has to bound that bucket like any other: without a default the record's first
# field is empty, which is where a tab-separated read is least forgiving.
clear_nudge_records
noid_channels=""
for _ in 1 2 3 4; do
  out=$(run_hook_env_keep "$REPO" "$RUN" "" "$ENV_PAYLOAD")
  noid_channels="${noid_channels}$(channel_of "$out") "
done
check "a session with no id at all is still bounded after one nudge" "ctx sys sys sys " "$noid_channels"

# --- A payload whose `cwd` / `session_id` are not STRINGS. `(data.get(x) or "")`
# is a string only when the field is absent, null or a string; a number or a
# list reaches `.replace` and raises AttributeError, so an advisory hook writes a
# TRACEBACK to its real stderr -- and `cwd` prints first, so both values are
# lost. The guard block already hardens `json.loads` and `isinstance(data, dict)`
# and stopped one field short of this.
clear_nudge_records
for badpay in '{"cwd": 42, "session_id": "sess-num"}' '{"cwd": ["a"], "session_id": ["b"]}' '{"cwd": {"x": 1}, "session_id": 7}'; do
  err=$( (printf '%s' "$badpay" | (cd "$REPO" && bash "$RUN")) 2>&1 >/dev/null )
  check "a non-string cwd/session_id writes nothing to real stderr" "" "$err"
  check "...and still exits 0" "0" "$(rc_of)"
done

# --- The cadence record must not OUTLIVE the condition. When no worktree is
# ahead of `origin/main` any more, the stored subject is stale, and returning
# to the same branch in the same push state reproduces it exactly -- so the
# next genuine first-sighting is DOWNGRADED. That is a MISSED nudge, the unsafe
# direction. Reachable through the very remedy this hook prints: nudge, repeat,
# `git switch --detach origin/main`, re-attach, commit. Its sibling
# `stop-warn.sh` has always dropped its record on the clean-tree exit.
#
# A SEPARATE sandbox repo, because the property is repo-GLOBAL ("no lane
# anywhere is ahead") and the fixtures above leave other lanes standing.
CLR_REPO="$SANDBOX/clear-repo"
mkdir -p "$CLR_REPO/.claude/hooks"
cp "$HOOK" "$CLR_REPO/.claude/hooks/"
CLR_RUN="$CLR_REPO/.claude/hooks/$(basename "$HOOK")"
git -C "$CLR_REPO" init -q .
git -C "$CLR_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$CLR_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$CLR_REPO" worktree add -q "$CLR_REPO/wt-clr" -b feat/clr HEAD
git -C "$CLR_REPO/wt-clr" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
CLR_PAYLOAD="{\"cwd\": \"$CLR_REPO/wt-clr\", \"session_id\": \"sess-clr\"}"
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "the clearing fixture arms once" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...and the repeat is downgraded" "sys" "$(channel_of "$out")"
# The condition CLEARS: the lane is no longer ahead of origin/main.
git -C "$CLR_REPO/wt-clr" reset -q --hard origin/main
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...the hook is silent once nothing is ahead" "" "$out"
check "...and the stale record is gone" "absent" \
  "$([ -e "$(git -C "$CLR_REPO/wt-clr" rev-parse --absolute-git-dir)/stop-nudge-lane" ] && echo present || echo absent)"
# ...and the same subject is a FIRST sighting again.
git -C "$CLR_REPO/wt-clr" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'work again'
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...so the SAME subject nudges the model again" "ctx" "$(channel_of "$out")"
git -C "$CLR_REPO" worktree remove --force "$CLR_REPO/wt-clr"


# --- The `pushed` arm has TWO texts, and which one is right is a PREDICATE
# rather than a constant. `verify-pr-gate.sh` EXEMPTS a diff touching no
# `src/**`, so only a src lane can be held PR-less by it; a docs-only lane told
# "verify-pr-gate is holding gh pr create" is handed an excuse in exactly the
# case this hook exists to catch. An earlier revision appended the qualifier
# UNCONDITIONALLY and this suite stayed green at 121/121, because the only
# pushed-arm assertion greps a phrase BOTH texts carry -- so both directions are
# pinned here, and the docs-only one is the direction that bites.
#
# A SEPARATE sandbox repo again: the fixtures above are cadence-ordered, and an
# extra hook invocation against them would shift every subject comparison after
# it.
SRC_REPO="$SANDBOX/src-lane-repo"
mkdir -p "$SRC_REPO/.claude/hooks"
cp "$HOOK" "$SRC_REPO/.claude/hooks/"
SRC_RUN="$SRC_REPO/.claude/hooks/$(basename "$HOOK")"
git -C "$SRC_REPO" init -q .
git -C "$SRC_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$SRC_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$SRC_REPO" config remote.origin.url "$SRC_REPO"
git -C "$SRC_REPO" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

# `push_state` must be `pushed` for either text to be reached at all, so each
# lane gets a real upstream -- the same refspec-and-config dance the cadence
# fixtures above needed, and for the same reason: without it `@{u}` fails, the
# hook reads the lane as unpushed, and both cases below would pass on the
# unpushed arm while asserting nothing about the one under test.
make_pushed_lane() {  # <worktree> <branch> <path-to-create>
  local wt="$1" br="$2" path="$3"
  git -C "$SRC_REPO" worktree add -q "$wt" -b "$br" HEAD
  mkdir -p "$(dirname "$wt/$path")"
  printf 'x\n' > "$wt/$path"
  git -C "$wt" add -A
  git -C "$wt" -c user.email=t@t -c user.name=t commit -q -m "work on $br"
  git -C "$SRC_REPO" update-ref "refs/remotes/origin/$br" "$(git -C "$SRC_REPO" rev-parse "$br")"
  git -C "$SRC_REPO" config "branch.$br.remote" origin
  git -C "$SRC_REPO" config "branch.$br.merge" "refs/heads/$br"
}

make_pushed_lane "$SRC_REPO/wt-docs" feat/docs docs/note.md
check "the docs lane fixture really is fully pushed" "0" \
  "$(git -C "$SRC_REPO/wt-docs" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$SRC_REPO" "$SRC_RUN" "{\"cwd\": \"$SRC_REPO/wt-docs\", \"session_id\": \"sess-docs\"}")
check "a docs-only lane still gets the pushed-arm warning" "yes" \
  "$(has "$out" -F 'pushed branch with NO PR')"
check "...and is NOT told a gate is holding gh pr create" "no" \
  "$(has "$out" -F 'verify-pr-gate')"

make_pushed_lane "$SRC_REPO/wt-src" feat/src src/thing.ts
out=$(run_hook_keep "$SRC_REPO" "$SRC_RUN" "{\"cwd\": \"$SRC_REPO/wt-src\", \"session_id\": \"sess-src\"}")
check "a src lane IS told verify-pr-gate may be holding the PR open" "yes" \
  "$(has "$out" -F 'verify-pr-gate')"
check "...and the predicate read THIS lane's own diff to decide" "yes" \
  "$(has "$out" -F 'touches src/**')"

git -C "$SRC_REPO" worktree remove --force "$SRC_REPO/wt-docs"
git -C "$SRC_REPO" worktree remove --force "$SRC_REPO/wt-src"


# The fence itself, aimed at the HELPER rather than at the hook: point it at a
# probe that reports the byte count of the stdin it was handed. `$#` keeps an
# explicit empty payload empty (0 bytes) and still defaults an OMITTED one to
# `{}` (2 bytes); `[ -n "$stdin" ]` cannot tell the two apart and sends `{}`
# both times. Both polarities are asserted, so neither a guard that always
# defaults nor one that never does can pass.
STDIN_PROBE="$SANDBOX/stdin-probe.sh"
cat > "$STDIN_PROBE" <<'PROBE'
#!/usr/bin/env bash
printf 'bytes=%s
' "$(cat | wc -c | tr -d ' ')"
PROBE
chmod +x "$STDIN_PROBE"
out=$(run_hook_env_keep "$REPO" "$STDIN_PROBE" 'sess-empty' '')
check "an explicitly empty env payload reaches the hook empty" "bytes=0" "$out"
out=$(run_hook_env_keep "$REPO" "$STDIN_PROBE" 'sess-empty')
check "...while an OMITTED env payload still defaults to {}" "bytes=2" "$out"

git -C "$REPO" worktree remove --force "$REPO/wt-cad-a"
git -C "$REPO" worktree remove --force "$REPO/wt-cad-b"
clear_nudge_records


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=126
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $((pass + fail)) cases ran, expected at least 126\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
