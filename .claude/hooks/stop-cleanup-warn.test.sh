#!/usr/bin/env bash
# Smoke tests for stop-cleanup-warn.sh
#
# Sets up a throwaway git repo, optionally arms the sentinel, runs the Stop hook, and
# asserts it exits 0 always (warn-only) and prints a reminder ONLY when armed.
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

echo "----"
echo "stop-cleanup-warn: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
