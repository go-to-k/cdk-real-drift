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

# `pwd -P` is load-bearing, not tidiness: on macOS `mktemp -d` returns a
# `/var/folders/...` path whose real location is `/private/var/...`, while git
# canonicalises every path it reports. An uncanonicalised sandbox therefore makes
# the OWNER key computed here and the one the hook computes two different
# strings, the owner file is never found, and every case below measures the
# nothing-armed branch instead of the one it names.
SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

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

rc_of() { cat "$RC_FILE"; }

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
if [ -r "$STATE" ]; then
  PASS=$((PASS + 1)); printf 'ok   - the hook wrote a cadence record to age\n'
  awk -v t="$aged" 'BEGIN{FS=OFS="\t"} {$3=t; $4=t; print}' "$STATE" > "$STATE.aged"
  mv -f "$STATE.aged" "$STATE"
else
  FAIL=$((FAIL + 1)); printf 'FAIL - the hook wrote a cadence record to age\n'
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

# --- The continuation flag outranks everything. `additionalContext` CONTINUES
# the turn, so a hook that emits it again on the resumed pass turns one nudge
# into a spin; the harness caps that at 8 and then overrides the hook entirely.
# Silence here is right even though the guardrail is armed: the human already saw
# the systemMessage on the earlier pass of this same turn. ---
rm -f "$STATE"
out=$(run_cleanup s1 ',"stop_hook_active":true')
check2 "a resumed turn stays silent even when armed" "" "$out"
check2 "...and standing down is exit 0" "0" "$(rc_of)"
# ...and the flag as the STRING "false" must not be read as a continuation. A
# naive truthiness read makes it identical to `true`, and since a quiet hook
# still exits 0 the failure looks exactly like "nothing armed" forever.
out=$(run_cleanup s1 ',"stop_hook_active":"false"')
check2 "the string \"false\" does not count as a continuation" "both" "$(channel_of "$out")"

# --- Nothing armed: no payload at all, on either channel. The channel cases
# above all run armed, so without this a hook that emitted unconditionally would
# pass every one of them. ---
rm -f "$OWNER_FILE" "$STATE"
out=$(run_cleanup s1)
check2 "an empty sentinel emits nothing on any channel" "" "$out"
check2 "...and still exits 0" "0" "$(rc_of)"

# --- SILENT, and exit 0, without `jq`. It both parses the event and builds the
# payload, so without the guard the script ends on `command not found` and
# returns 127 -- a hook ERROR on every single turn, from a hook that is advisory
# by design. The stub PATH carries every external the hook reaches for BEFORE the
# guard (and `bash`/`env` themselves, since `PATH=... bash` and the `env bash`
# shebang both resolve through it); a stub that is too small makes this pass for
# a different reason than the one under test. ---
printf 'stack-a\n' > "$OWNER_FILE"
STUBBIN="$SANDBOX/no-jq"
mkdir -p "$STUBBIN"
for c in bash env cat git sed grep date tr sort dirname awk mv rm; do
  ln -sf "$(command -v "$c")" "$STUBBIN/$c"
done
set +e
out=$(printf '{"cwd":"%s","session_id":"s1"}' "$FIX" | PATH="$STUBBIN" bash "$HOOK" 2>&1)
rc=$?
set -e
check2 "silent when jq is unavailable" "" "$out"
check2 "...and exits 0 rather than 127" "0" "$rc"

echo "----"
echo "stop-cleanup-warn: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
