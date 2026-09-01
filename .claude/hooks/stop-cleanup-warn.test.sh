#!/usr/bin/env bash
# Smoke tests for stop-cleanup-warn.sh
#
# Sets up a throwaway git repo, optionally arms the sentinel, runs the Stop hook, and
# asserts it exits 0 always (warn-only) and reports ONLY when armed.
# Run: bash .claude/hooks/stop-cleanup-warn.test.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/stop-cleanup-warn.sh"
PASS=0
FAIL=0

# --- BASH 3.2 FENCE ---
# macOS ships bash 3.2 as /bin/bash and this repo runs on it, so the hook has to
# stay 3.2-clean. It was, but only ACCIDENTALLY: every case here launches the hook
# as `bash "$HOOK"`, which resolves through PATH -- normally a modern Homebrew
# build -- and the shebang is `#!/usr/bin/env bash`, which resolves the same way.
# So running this SUITE under /bin/bash proved nothing whatsoever about the hook;
# both interpreters were 5.x either way.
#
# A shim directory holding one symlink named `bash` goes FIRST on PATH, so every
# child `bash` -- the explicit invocations, the shebang, and the ones inside the
# stubbed-PATH cases, whose `command -v bash` now resolves here -- is the fenced
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

# The warn is PER-SESSION (mirrors bughunt-clean-gate): it fires only for THIS
# session/owner's resources — the cwd worktree's owner file, this session's
# autoarm-<session> token, or the legacy flat file — never a peer's.
#
# check <name> <arm-spec> <session-id> <expect_warn:0|1>
#   arm-spec: "" none | "legacy" | "OWNER" (this cwd's own owner key) |
#             any other string = a filename under .markgate-bughunt-pending.d/
check() {
  local name="$1" arm="$2" sess="$3" expect="$4"

  local tmp
  tmp=$(mktemp -d)
  ( cd "$tmp" && git init -q -b main && git config user.email t@t && git config user.name t && : > seed && git add -A && git commit -q -m init )
  mkdir -p "$tmp/.markgate-bughunt-pending.d"
  case "$arm" in
    "") : ;;
    legacy) printf 'X\n' > "$tmp/.markgate-bughunt-pending" ;;
    OWNER)
      local key
      key=$(printf '%s' "$(git -C "$tmp" rev-parse --show-toplevel)" | sed 's#[^A-Za-z0-9._-]#_#g')
      printf 'X\n' > "$tmp/.markgate-bughunt-pending.d/$key" ;;
    *) printf 'X\n' > "$tmp/.markgate-bughunt-pending.d/$arm" ;;
  esac

  local out exit_code
  set +e
  out=$(printf '{"cwd":"%s","session_id":"%s"}' "$tmp" "$sess" | CLAUDE_CODE_SESSION_ID="$sess" bash "$HOOK" 2>&1)
  exit_code=$?
  set -e

  local warned=0
  printf '%s' "$out" | grep -q "cleanup reminder" && warned=1

  local ok=1
  [ "$exit_code" -eq 0 ] || ok=0        # warn-only, never blocks
  [ "$warned" -eq "$expect" ] || ok=0

  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1)); echo "ok   - $name (exit=$exit_code warned=$warned)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $name (exit=$exit_code warned=$warned, want warn=$expect)"
  fi
  rm -rf "$tmp"
}

# Warns for THIS session/owner's resources.
check "this session's autoarm token warns"     "autoarm-mySess" "mySess" 1
check "this cwd worktree's owner warns"        "OWNER"          "mySess" 1
check "legacy flat sentinel warns (global)"    "legacy"         "mySess" 1
check "no session id -> autoarm-shared warns"  "autoarm-shared" ""       1
# Does NOT warn for a peer's resources (the whole point of per-session).
check "a PEER session's autoarm does NOT warn" "autoarm-peer"   "mySess" 0
check "a PEER worktree's owner does NOT warn"  "someOtherOwner" "mySess" 0
# Silent when nothing is armed.
check "empty sentinel is silent"               ""               "mySess" 0

# ---------------------------------------------------------------------------
# CHANNELS and CADENCE (go-to-k/cdk-real-drift#1844).
#
# Until #1844 the reminder above was an `echo >&2` followed by `exit 0`, which
# reaches NOBODY: hook stderr surfaces only on a NON-zero exit, and stdout at
# exit 0 is parsed as JSON and dropped when it is not. So the seven cases above
# were green while the guardrail delivered its warning into a hole -- they grep
# a combined `2>&1` capture, which cannot tell the difference. Everything below
# reads the CHANNEL out of the JSON, which is what decides who sees it.
#
#   systemMessage      -> the USER, turn ends.        Emitted on EVERY fire: a
#                         billing guardrail must never go silent to the human.
#   additionalContext  -> the MODEL, turn CONTINUES.  Emitted additionally when
#                         the cadence arms; the text names /sweep-resources, so
#                         only the model can act on it.
#
# The cadence bounds the second one: at most one nudge per distinct SUBJECT (the
# sorted set of armed tokens), plus a WALL-CLOCK re-arm, because money accrues on
# the clock and an idle session sitting on a live stack is exactly what a
# subject-only rule would go quiet on.
# ---------------------------------------------------------------------------

check2() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf 'ok   - %s\n' "$name"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL - %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# `require_state <label>` -- assert the hook actually WROTE a cadence record,
# and report it as a case. Every block below that AGES the record needs one to
# age, and a bare `awk ... "$STATE"` on a missing file aborts this `set -e`
# suite mid-file. Measured before this was shared: the suite died at the
# future-stamp block with `awk: can't open file .../stop-nudge-cleanup`, rc=2,
# after emitting 60 of 71 cases -- ELEVEN cases hidden by ANY mutation that
# stops the hook writing a record, which is exactly the class a mutation probe
# is looking for. rc=2 is loud, so it was never a false green; the mutation
# tallies taken through it were simply not re-derivable. One site was guarded
# and two were not, which is why this is a helper rather than a third copy.
require_state() {
  if [ -r "$STATE" ]; then
    PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; return 0
  fi
  FAIL=$((FAIL + 1)); printf 'FAIL - %s (no record was written)\n' "$1"; return 1
}

# `pwd -P` is load-bearing, not tidiness: on macOS `mktemp -d` returns a
# `/var/folders/...` path whose real location is `/private/var/...`, while git
# canonicalises every path it reports. An uncanonicalised sandbox therefore makes
# the OWNER key computed here and the one the hook computes two different
# strings, the owner file is never found, and every case below measures the
# nothing-armed branch instead of the one it names.
SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$SANDBOX" "$SHIMDIR"' EXIT

FIX="$SANDBOX/repo"
mkdir -p "$FIX/.markgate-bughunt-pending.d"
git -C "$FIX" init -q -b main .
git -C "$FIX" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# The OWNER file, not an `autoarm-<session>` one: the owner key is the worktree
# toplevel, so it is the same for every session. The cadence cases below compare
# what TWO sessions see, and a per-session sentinel would give the second one an
# empty token set -- the case would then pass for "nothing armed" reasons.
OWNER_KEY=$(printf '%s' "$(git -C "$FIX" rev-parse --show-toplevel)" | sed 's#[^A-Za-z0-9._-]#_#g')
OWNER_FILE="$FIX/.markgate-bughunt-pending.d/$OWNER_KEY"
STATE="$FIX/.git/stop-nudge-cleanup"
# The other two sentinel files the hook unions in. The cadence cases below used to
# write ONLY the owner file, so the union itself was unfenced: a hook that read
# just that one file passed every cadence case.
AUTOARM_FILE="$FIX/.markgate-bughunt-pending.d/autoarm-s1"
LEGACY_FILE="$FIX/.markgate-bughunt-pending"

# A copy of the hook INSIDE the fixture, for the cases about where the hook looks
# when the payload `cwd` is unusable: the fallback of last resort is this file's
# own checkout, and the real one has nothing armed in it.
mkdir -p "$FIX/.claude/hooks"
cp "$HOOK" "$FIX/.claude/hooks/"
FIX_HOOK="$FIX/.claude/hooks/$(basename "$HOOK")"

# The exit STATUS is parked in a FILE, not a variable: every call site is a
# `$(...)` subshell, so an assignment made here dies with it and the assertion
# reads an empty string. Silence is not success on `Stop` -- a non-zero exit is a
# hook ERROR -- so every case that asserts empty output would otherwise pass
# against a hook that crashed before printing. Measured: with `RC2=$?` the three
# exit-status cases below reported `want 0, got ''`.
RC_FILE="$SANDBOX/rc"
run_cleanup() { # <session-id> [extra-json-fragment, e.g. ,"stop_hook_active":true]
  local sess="$1" extra="${2-}" out rc
  set +e
  out=$(printf '{"cwd":"%s","session_id":"%s"%s}' "$FIX" "$sess" "$extra" |
    CLAUDE_CODE_SESSION_ID="$sess" bash "$HOOK" 2>/dev/null)
  rc=$?
  set -e
  printf '%s' "$rc" > "$RC_FILE"
  printf '%s' "$out"
}

# The same run with the session id supplied ONLY through the environment, and no
# `session_id` in the payload. Needed because the odd session ids below (empty, and
# one containing a TAB) cannot be interpolated into a hand-built JSON string: a raw
# tab is not legal inside a JSON string, `jq` would then fail on the WHOLE payload,
# `cwd` would be lost with it, and the case would silently measure a different
# fixture instead of the one it names.
run_cleanup_env() { # <session-id>
  local sess="$1" out rc
  set +e
  out=$(printf '{"cwd":"%s"}' "$FIX" | CLAUDE_CODE_SESSION_ID="$sess" bash "$HOOK" 2>/dev/null)
  rc=$?
  set -e
  printf '%s' "$rc" > "$RC_FILE"
  printf '%s' "$out"
}

rc_of() { cat "$RC_FILE"; }

# The token count the user-facing line claims, and the armed duration the escalated
# model line claims. Both are NUMBERS the message states, and nothing asserted them
# before: a hook that hard-coded either passed every case in this file.
count_in() {
  printf '%s' "$1" | jq -r '.systemMessage // ""' |
    sed -n 's/^cdkrd cleanup reminder: \([0-9][0-9]*\) deploy.*/\1/p'
}
minutes_in() {
  printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // ""' |
    sed -n 's/.*armed for ~\(-*[0-9][0-9]*\) minute(s).*/\1/p'
}

# ctx | sys | both | none. `both` is the ARMED shape here, unlike
# stop-unmerged-lane-warn.sh next door where it would be a defect: the two hooks
# make opposite trades, and reading only one key cannot see either.
channel_of() {
  [ -n "$1" ] || { printf 'none'; return; }
  printf '%s' "$1" | jq -r '
    ((.hookSpecificOutput.additionalContext // "") != "") as $c
    | ((.systemMessage // "") != "") as $s
    | if $c and $s then "both" elif $c then "ctx" elif $s then "sys" else "none" end' 2>/dev/null ||
    printf 'malformed'
}

rm -f "$STATE"
printf 'stack-a\n' > "$OWNER_FILE"

out=$(run_cleanup s1)
check2 "first sight of an armed token reaches the model AND the user" "both" "$(channel_of "$out")"
check2 "...and that is exit 0, not a crash" "0" "$(rc_of)"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "Stop"' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); printf 'ok   - the hookEventName is Stop\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the hookEventName is Stop\n'
fi
# The model half must carry the remedy, or the continuation it buys is wasted.
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' | grep -q '/sweep-resources'; then
  PASS=$((PASS + 1)); printf 'ok   - the model half names the command to run\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the model half names the command to run\n'
fi
# The user half must name the token, or a human reading it cannot tell WHICH
# resources are live. A hook that emitted an empty-but-present systemMessage
# would satisfy the channel assertion above and nothing else.
if printf '%s' "$out" | jq -r '.systemMessage' | grep -q 'stack-a'; then
  PASS=$((PASS + 1)); printf 'ok   - the user half names the armed token\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the user half names the armed token\n'
fi

out=$(run_cleanup s1)
check2 "the same token set again does NOT force a second turn" "sys" "$(channel_of "$out")"
# The downgrade is a DOWNGRADE, not a mute. This is the half that differs from
# the lane hook: there the repeat is the user's problem to notice, here the
# repeat is money still burning, so the human keeps being told every turn.
if printf '%s' "$out" | jq -r '.systemMessage' | grep -q 'stack-a'; then
  PASS=$((PASS + 1)); printf 'ok   - ...and the downgraded turn still NAMES the token\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the downgraded turn still names the token\n'
fi
if printf '%s' "$out" | jq -r '.systemMessage' | grep -q 'cleanup reminder'; then
  PASS=$((PASS + 1)); printf 'ok   - ...and the user is still told on the downgraded turn\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the user is still told on the downgraded turn\n'
fi

# A CHANGED token set is a different subject: another stack was deployed, which
# is exactly when the model needs telling again. Without this the first deploy of
# a session would silence every later one.
printf 'stack-a\nstack-b\n' > "$OWNER_FILE"
out=$(run_cleanup s1)
check2 "arming another stack re-arms the nudge" "both" "$(channel_of "$out")"
out=$(run_cleanup s1)
check2 "...and the new set then settles back to the user channel" "sys" "$(channel_of "$out")"

# A different SESSION gets its own one nudge. It also overwrites the single
# per-worktree record, so the earlier session re-arms once -- an EXTRA nudge
# rather than a missed one, which is the safe direction for money and is pinned
# here rather than left to be rediscovered as a bug.
out=$(run_cleanup s2)
check2 "a DIFFERENT session gets its own one nudge" "both" "$(channel_of "$out")"
out=$(run_cleanup s1)
check2 "...and a concurrent session's write costs an extra nudge, not a lost one" "both" "$(channel_of "$out")"
out=$(run_cleanup s1)
check2 "...settling again afterwards" "sys" "$(channel_of "$out")"

# --- WALL CLOCK. The subject has not changed, so the subject rule alone says
# quiet -- forever, while the resources bill. Age the LAST-NUDGE and ARMED-SINCE
# stamps in the record and the hook must speak to the model again. This is the
# case that separates this hook from stop-unmerged-lane-warn.sh, which has no
# wall-clock re-arm at all and must not grow one. ---
# Ageing the record is also the only case that asserts the hook WROTE one, so it
# is guarded rather than assumed: under a hook that keeps no record at all the
# bare `awk` would abort this `set -e` suite mid-file and hide every case after
# it, which is exactly what a mutation probe needs to see.
aged=$(( $(date +%s) - 3000 ))
if require_state "the hook wrote a cadence record to age"; then
  awk -v t="$aged" 'BEGIN{FS=OFS="\t"} {$3=t; $4=t; print}' "$STATE" > "$STATE.aged"
  mv -f "$STATE.aged" "$STATE"
fi
check2 "the fixture really did age the record" "$aged" "$(cut -f3 "$STATE" 2>/dev/null || echo MISSING)"
out=$(run_cleanup s1)
check2 "an unchanged subject re-arms on the WALL CLOCK" "both" "$(channel_of "$out")"
ctx_text=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
if printf '%s' "$ctx_text" | grep -q 'REPEAT'; then
  PASS=$((PASS + 1)); printf 'ok   - ...and the escalated text says it is a repeat\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the escalated text says it is a repeat\n'
fi
# The duration is the information the second telling adds. `~50 minute(s)` for a
# 3000s-old stamp; asserting the NUMBER rather than just the word is what stops a
# hard-coded "a while" from passing.
if printf '%s' "$ctx_text" | grep -q 'armed for ~50 minute(s)'; then
  PASS=$((PASS + 1)); printf 'ok   - ...and says how long it has been armed\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - says how long it has been armed (got: %s)\n' \
    "$(printf '%s' "$ctx_text" | grep -o 'armed for [^ ]* [^ ]*' || echo NONE)"
fi
out=$(run_cleanup s1)
check2 "...and the clock re-arm resets, so the next turn is quiet again" "sys" "$(channel_of "$out")"

# --- The continuation flag drops the MODEL half, and only that half.
# `additionalContext` CONTINUES the turn, so emitting it again on the resumed pass
# turns one nudge into a spin; the harness caps that at 8 and then overrides the
# hook entirely. The hook used to `exit 0` here, taking the `systemMessage` with
# it -- on the reasoning that the human had already seen it on the earlier pass of
# the same turn. That reasoning is FALSE whenever the tokens were not armed then:
# the neighbouring Stop hook forces a continuation, the model runs a deploy inside
# it, `deploy-autoarm-gate.sh` arms, and this pass is the first on which there is
# anything to say at all. A bare `systemMessage` does not continue a turn, so the
# user half costs nothing. ---
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":true')
check2 "a resumed turn drops the model half but still tells the user" "sys" "$(channel_of "$out")"
check2 "...and standing down is exit 0" "0" "$(rc_of)"
if printf '%s' "$out" | jq -r '.systemMessage' | grep -q 'stack-a'; then
  PASS=$((PASS + 1)); printf 'ok   - ...and the surviving half still NAMES the token\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the surviving half still names the token\n'
fi
# No nudge was spent on that pass, so none may be recorded either -- otherwise the
# resumed pass silently consumes this subject's one model nudge and the next
# ordinary turn-end, which CAN continue, says nothing.
out=$(run_cleanup s1)
check2 "...and no record was written, so the next ordinary turn still nudges" "both" "$(channel_of "$out")"
# ...and the flag as the STRING "false" must not be read as a continuation. A
# naive truthiness read makes it identical to `true`, and since a quiet hook
# still exits 0 the failure looks exactly like "nothing armed" forever.
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":"false"')
check2 "the string \"false\" does not count as a continuation" "both" "$(channel_of "$out")"
# ...nor may a NON-boolean. `jq` and Python disagree here in opposite directions --
# `0`, `[]` and `{}` are all truthy to jq and all falsy to Python -- so a plain
# truthiness read made this hook treat a malformed payload as a continuation while
# stop-unmerged-lane-warn.sh next door treated it as an ordinary turn. Measured:
# `"stop_hook_active": 0` went fully silent here and fired there.
# ...nor may a NON-boolean be read differently from how the sibling hook reads it.
# `stop-unmerged-lane-warn.sh` parses the same field with `python3`, so the pair has
# to agree on what a malformed payload MEANS, and the two obvious jq spellings each
# get it wrong in an opposite direction: plain truthiness makes `0`, `[]` and `{}`
# continuations (Python says no), while `$f == true` makes `1`, `[1]` and `{"a":1}`
# ordinary turns (Python says yes). Both directions are measured, and BOTH are
# fenced here -- the falsy shapes must fire, the truthy ones must not. The truthy
# half is the dangerous one for THIS hook: reading a resumed pass as fresh emits
# `additionalContext` again and spins the turn against the 8-block cap.
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":0')
check2 "a FALSY number is not a continuation" "both" "$(channel_of "$out")"
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":{}')
check2 "...and neither is an empty object" "both" "$(channel_of "$out")"
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":[]')
check2 "...nor an empty array" "both" "$(channel_of "$out")"
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":1')
check2 "a TRUTHY number IS a continuation, as python3 reads it next door" "sys" "$(channel_of "$out")"
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":[1]')
check2 "...and so is a non-empty array" "sys" "$(channel_of "$out")"
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":{"a":1}')
check2 "...and a non-empty object" "sys" "$(channel_of "$out")"

# --- Nothing armed: no payload at all, on either channel. The channel cases
# above all run armed, so without this a hook that emitted unconditionally would
# pass every one of them. ---
rm -f "$OWNER_FILE" "$STATE"
out=$(run_cleanup s1)
check2 "an empty sentinel emits nothing on any channel" "" "$out"
check2 "...and still exits 0" "0" "$(rc_of)"

# ---------------------------------------------------------------------------
# The SUBJECT and the RECORD. Everything above drives the cadence through one
# file and one well-formed session id, which left most of the machinery that
# builds the subject unfenced -- each of the mutations named below survived a
# full 33/33 green run before these cases existed.
# ---------------------------------------------------------------------------

# --- The session id goes into a TAB-separated record read back with `IFS=<TAB>
# read`, where a tab is IFS *whitespace*: a leading empty field is dropped and a
# run of tabs collapses. So an EMPTY id wrote `<TAB>subject<TAB>...`, every field
# read back one to the left, `prev_sid` never compared equal, and the cadence
# never armed down -- an unbounded `additionalContext` on the one hook that
# guards MONEY, which is precisely what the block-cap budget cannot afford. An id
# CONTAINING a tab did the same from the other side. Both are ordinary: the id is
# absent whenever the harness sends no `session_id` and no environment variable.
rm -f "$STATE" "$AUTOARM_FILE" "$LEGACY_FILE"
printf 'stack-a\n' > "$OWNER_FILE"
out=$(run_cleanup_env "")
check2 "an EMPTY session id nudges the first time" "both" "$(channel_of "$out")"
out=$(run_cleanup_env "")
check2 "...and the cadence still bounds it" "sys" "$(channel_of "$out")"

rm -f "$STATE"
TAB_SID=$(printf 'sess\tid')
out=$(run_cleanup_env "$TAB_SID")
check2 "a session id containing a TAB nudges the first time" "both" "$(channel_of "$out")"
out=$(run_cleanup_env "$TAB_SID")
check2 "...and the cadence still bounds that one too" "sys" "$(channel_of "$out")"

# --- The TOKENS get the same treatment, and for the same reason: a token
# carrying a tab lands in the subject field of a tab-separated record and shifts
# every field after it, so the read-back never matches and the nudge is unbounded
# again. Removing the tab fold left the suite green before this case.
rm -f "$STATE"
printf 'stack-a\tus-east-1\n' > "$OWNER_FILE"
out=$(run_cleanup s1)
check2 "a token containing a TAB nudges the first time" "both" "$(channel_of "$out")"
out=$(run_cleanup s1)
check2 "...and the record still reads back as four fields" "sys" "$(channel_of "$out")"

# --- The subject is a SORTED set, so the same tokens arriving in a different
# order are the same subject. They legitimately do: the three sentinel files are
# concatenated, and nothing orders the lines within one. Removing `LC_ALL=C sort`
# left the suite green.
rm -f "$STATE"
printf 'stack-b\nstack-a\n' > "$OWNER_FILE"
out=$(run_cleanup s1)
check2 "a two-token set nudges the first time" "both" "$(channel_of "$out")"
printf 'stack-a\nstack-b\n' > "$OWNER_FILE"
out=$(run_cleanup s1)
check2 "...and the SAME set in a different order is the same subject" "sys" "$(channel_of "$out")"

# --- ...and a DEDUPED one, which is also what the message counts. The legacy
# flat file and the owner file name the same stack whenever both are in use, and
# counting raw lines while listing the deduped set made the text say "2 token(s)"
# and then name one. No case asserted the NUMBER at all, so hard-coding `count=1`
# left the suite green.
rm -f "$STATE"
printf 'stack-a\n' > "$OWNER_FILE"
printf 'stack-a\n' > "$LEGACY_FILE"
out=$(run_cleanup s1)
check2 "one token armed through two files is counted once" "1" "$(count_in "$out")"
printf 'stack-a\n' > "$OWNER_FILE"
printf 'stack-z\n' > "$LEGACY_FILE"
rm -f "$STATE"
out=$(run_cleanup s1)
check2 "...and two distinct tokens are counted as two" "2" "$(count_in "$out")"

# --- The subject is the union of ALL THREE sentinel files. Every cadence case
# above writes only the owner file, so a hook that read just that one satisfied
# all of them -- while missing exactly the token `deploy-autoarm-gate.sh` writes,
# which is the one armed by a deploy the model itself just ran.
rm -f "$STATE" "$LEGACY_FILE" "$AUTOARM_FILE"
printf 'stack-a\n' > "$OWNER_FILE"
out=$(run_cleanup s1)
check2 "the owner file alone nudges once" "both" "$(channel_of "$out")"
out=$(run_cleanup s1)
check2 "...then settles" "sys" "$(channel_of "$out")"
printf 'autoarm-stack\n' > "$AUTOARM_FILE"
out=$(run_cleanup s1)
check2 "a token appearing in THIS SESSION'S autoarm file re-arms" "both" "$(channel_of "$out")"
check2 "...and both files' tokens are counted" "2" "$(count_in "$out")"
out=$(run_cleanup s1)
check2 "...then settles again" "sys" "$(channel_of "$out")"
printf 'legacy-stack\n' > "$LEGACY_FILE"
out=$(run_cleanup s1)
check2 "a token appearing in the LEGACY flat file re-arms too" "both" "$(channel_of "$out")"
check2 "...and all three files' tokens are counted" "3" "$(count_in "$out")"

# --- A MALFORMED record. Nothing here ever wrote one, so deleting BOTH `case`
# sanitisers left the suite green -- while in production a record is exactly the
# thing another process, an interrupted write or an older version of this hook
# can leave in a shape this one does not expect. Two properties: the arithmetic
# must not spill an error onto the hook's real stderr, and the hook must fall to
# ARMING rather than to silence, because silence about live resources is the
# direction that costs money.
rm -f "$LEGACY_FILE" "$AUTOARM_FILE"
printf 'stack-a\n' > "$OWNER_FILE"
malformed_record() { # <literal record line>
  printf '%s' "$1" > "$STATE"
}
err_of_run() { # stderr only, with stdout discarded
  printf '{"cwd":"%s","session_id":"s1"}' "$FIX" | CLAUDE_CODE_SESSION_ID=s1 bash "$HOOK" 2>&1 >/dev/null
}
malformed_record "$(printf 's1\tstack-a\tnotanumber\talsonot\n')"
check2 "a non-numeric stamp puts nothing on the hook's real stderr" "" "$(err_of_run)"
malformed_record "$(printf 's1\tstack-a\tnotanumber\talsonot\n')"
out=$(run_cleanup s1)
check2 "...and a record it cannot parse re-arms rather than freezing" "both" "$(channel_of "$out")"

# A LEADING ZERO passes a digits-only sanitiser and then fails ARITHMETIC: bash
# reads `08` as octal and aborts with "value too great for base", twice, on the
# hook's real stderr, every turn. `10#` is what makes the sanitiser's own output
# safe to do arithmetic on.
malformed_record "$(printf 's1\tstack-a\t08\t09\n')"
check2 "a leading-zero stamp is not read as octal" "" "$(err_of_run)"

# --- A FUTURE stamp. No attacker needed: a forward clock jump plus the NTP
# correction that follows leaves one behind, and bash WRAPS an over-long value
# silently rather than refusing it. The wall-clock test only asked whether enough
# time had PASSED, so a future last-nudge made `now - prev_nudge` negative and the
# model channel went silent for as long as the stamp said -- the same unbounded
# silence as a record that never matches, in the opposite direction.
rm -f "$STATE"
out=$(run_cleanup s1)
check2 "control: the future-stamp case starts from a real record" "both" "$(channel_of "$out")"
future=$(($(date +%s) + 315360000)) # ~10 years
if require_state "the future-stamp fixture has a record to age"; then
  awk -v t="$future" 'BEGIN{FS=OFS="\t"} {$3=t; $4=t; print}' "$STATE" > "$STATE.f"
  mv -f "$STATE.f" "$STATE"
fi
out=$(run_cleanup s1)
check2 "a FUTURE last-nudge stamp does not silence the model forever" "both" "$(channel_of "$out")"
check2 "...and a future armed-since never prints a negative duration" "0" "$(minutes_in "$out")"

# --- The fourth field, ARMED-SINCE, is what lets the escalated message say how
# long without a nudge resetting it. The wall-clock case above ages field 3 and
# field 4 to the SAME value, which makes them indistinguishable -- dropping the
# fourth field entirely (and measuring from the last nudge instead) left the
# suite green. These age them DIFFERENTLY, across two clock cycles, which is the
# only shape that separates the two readings.
rm -f "$STATE"
out=$(run_cleanup s1) # first nudge: the record is written with both stamps at now
base=$(date +%s)
age_record() { # <last-nudge epoch> <armed-since epoch>
  require_state "the armed-since fixture has a record to age" || return 0
  awk -v n="$1" -v a="$2" 'BEGIN{FS=OFS="\t"} {$3=n; $4=a; print}' "$STATE" > "$STATE.a"
  mv -f "$STATE.a" "$STATE"
}
age_record "$((base - 6000))" "$((base - 6000))"
out=$(run_cleanup s1)
check2 "the first clock re-arm measures the full armed age" "100" "$(minutes_in "$out")"
check2 "...and the nudge moved ONLY the last-nudge stamp" "$((base - 6000))" "$(cut -f4 "$STATE" 2>/dev/null || echo MISSING)"
# Second cycle: the last nudge is recent-ish, armed-since is old. Measuring from
# the wrong field now reads 50 rather than 100.
age_record "$((base - 3000))" "$((base - 6000))"
out=$(run_cleanup s1)
check2 "a second re-arm still measures from ARMED-SINCE, not the last nudge" "100" "$(minutes_in "$out")"

# --- A record that cannot be PERSISTED. The record is what bounds the nudge, so
# an unwritable git dir (a read-only checkout, a full disk, a directory owned by
# another user) meant every later turn re-armed -- unbounded, the failure the
# cadence exists to remove. The warning still has to reach the human; only the
# model half is dropped. And the redirect order is asserted separately: written
# `>"$tmp" 2>/dev/null`, bash has already replaced fd 2 by the time it fails to
# open the file, so "Permission denied" surfaces on the hook's real stderr.
rm -f "$STATE"
printf 'stack-a\n' > "$OWNER_FILE"
chmod 555 "$FIX/.git"
out=$(run_cleanup s1)
err=$(err_of_run)
chmod 755 "$FIX/.git"
check2 "an unpersistable record downgrades to the user channel" "sys" "$(channel_of "$out")"
check2 "...and the failed redirect stays off the hook's real stderr" "" "$err"
if printf '%s' "$out" | jq -r '.systemMessage' | grep -q 'stack-a'; then
  PASS=$((PASS + 1)); printf 'ok   - ...and the human is still told which token\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the human is still told which token\n'
fi

# --- A STALE `cwd`. Only an EMPTY one fell back before, so a payload naming a
# directory that has since been removed -- a worktree cleaned up mid-session --
# made `git -C` fail and the hook exit 0, silent about resources still billing.
# The last-resort anchor is this hook copy's own checkout, which is why the case
# runs the copy INSIDE the fixture: the real one has nothing armed. `$PWD` is
# deliberately outside any repository here, so the fallback under test is the
# BASH_SOURCE one and not the middle candidate.
rm -f "$STATE"
printf 'stack-a\n' > "$OWNER_FILE"
set +e
out=$( (cd "$SANDBOX" && printf '{"cwd":"%s","session_id":"s1"}' "$SANDBOX/removed-worktree" |
  CLAUDE_CODE_SESSION_ID=s1 bash "$FIX_HOOK" 2>/dev/null) )
set -e
check2 "a STALE cwd falls back to the hook's own checkout, not to silence" "both" "$(channel_of "$out")"

# --- SILENT without `jq`. It both parses the event and builds the payload, so
# without the guard the script ends on `command not found` -- a "jq: command not
# found" line on the hook's stderr on every single turn, from a hook that is
# advisory by design. The stub PATH carries every external the hook reaches for
# BEFORE the guard (and `bash`/`env` themselves, since `PATH=... bash` and the
# `env bash` shebang both resolve through it); a stub that is too small makes this
# pass for a different reason than the one under test.
#
# THE CWD IS INSIDE THE ARMED FIXTURE, and that is the load-bearing half. Run from
# anywhere else this case was VACUOUS: without `jq` the payload `cwd` cannot be
# parsed at all, `target_dir` falls back to `$PWD`, and from the suite's own
# directory nothing is armed -- so the hook returned at the not-armed check, long
# before it would have reached `jq -n`, and DELETING the guard left the suite
# 33/33 green. The control immediately below pins that the fixture really is armed
# under this same cwd, so a future change cannot quietly restore the vacuum.
#
# The old companion assertion ("...and exits 0 rather than 127") is gone rather
# than fixed: the hook ends on an unconditional `exit 0`, so no mutation of it can
# make that line fail. ---
printf 'stack-a\n' > "$OWNER_FILE"
rm -f "$STATE" "$AUTOARM_FILE" "$LEGACY_FILE"
set +e
out=$( (cd "$FIX" && printf '{}' | CLAUDE_CODE_SESSION_ID=s1 bash "$HOOK" 2>&1) )
set -e
check2 "control: jq present, cwd inside the armed fixture -> it speaks" "both" "$(channel_of "$out")"

rm -f "$STATE"
STUBBIN="$SANDBOX/no-jq"
mkdir -p "$STUBBIN"
for c in bash env cat git sed grep date tr sort dirname awk mv rm; do
  ln -sf "$(command -v "$c")" "$STUBBIN/$c"
done
set +e
out=$( (cd "$FIX" && printf '{"cwd":"%s","session_id":"s1"}' "$FIX" | PATH="$STUBBIN" bash "$HOOK" 2>&1) )
set -e
check2 "silent when jq is unavailable" "" "$out"

echo "----"
# --- The record path is a DIRECTORY. `mv -f <file> <dir>` returns SUCCESS -- it
# moves the tmp INSIDE the directory -- so `wrote` was set, the readback on the
# next turn found nothing, and EVERY turn re-armed `additionalContext` against
# CLAUDE_CODE_STOP_HOOK_BLOCK_CAP while the git dir grew one orphan tmp per
# turn. That is the unbounded cadence this whole mechanism exists to remove,
# arriving through the success check -- the one failure `mv`'s own exit code
# cannot report, so the unwritable-git-dir case above does not cover it.
# Measured with `mv` alone: `both both both both`. The shipped answer is
# `sys sys sys sys` -- the model half is dropped on EVERY turn including the
# first, because `[ "$wrote" = "1" ] || arm=0` is what a record that can never
# be written costs -- while the USER half is still promised on every one, which
# is this hook's whole point and the half the lane twin does not keep.
rm -f "$STATE"
mkdir -p "$STATE"
dir_channels=""
for _ in 1 2 3 4; do
  out=$(run_cleanup s1)
  dir_channels="${dir_channels}$(channel_of "$out") "
done
dir_orphans=$(find "$STATE" -type f 2>/dev/null | wc -l | tr -d ' ')
rm -f "$STATE"/* 2>/dev/null || true
rmdir "$STATE" 2>/dev/null || true
check2 "a record path that is a DIRECTORY never arms the model channel" "sys sys sys sys " "$dir_channels"
check2 "...and leaves no orphan tmp behind in the git dir" "0" "$dir_orphans"
# ...and the CONTROL: with the directory gone the hook arms again, so the four
# `sys` above are the directory's doing rather than a hook that stopped arming.
out=$(run_cleanup s1)
check2 "...and it arms again once the record path is writable" "both" "$(channel_of "$out")"


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=77
if [ "$((PASS + FAIL))" -lt "$CASE_FLOOR" ]; then
  FAIL=$((FAIL + 1))
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((PASS + FAIL))" "$CASE_FLOOR"
fi

echo "stop-cleanup-warn: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
