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

# run <name> <armed:0|1> <expect_warn:0|1>
run() {
  local name="$1" armed="$2" expect_warn="$3"

  local tmp
  tmp=$(mktemp -d)
  ( cd "$tmp" && git init -q -b main && git config user.email t@t && git config user.name t && : > seed && git add -A && git commit -q -m init )

  if [ "$armed" = "1" ]; then
    mkdir -p "$tmp/.markgate-bughunt-pending.d"
    printf 'AUTODEPLOY-pending-verify\n' > "$tmp/.markgate-bughunt-pending.d/autoarm"
  fi

  local out exit_code
  set +e
  out=$(printf '{"cwd":"%s"}' "$tmp" | bash "$HOOK" 2>&1)
  exit_code=$?
  set -e

  local warned=0
  printf '%s' "$out" | grep -q "cleanup reminder" && warned=1

  local ok=1
  [ "$exit_code" -eq 0 ] || ok=0        # warn-only, never blocks
  [ "$warned" -eq "$expect_warn" ] || ok=0

  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1)); echo "ok   - $name (exit=$exit_code warned=$warned)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $name (exit=$exit_code warned=$warned, want warn=$expect_warn)"
  fi
  rm -rf "$tmp"
}

run "armed sentinel warns"      1 1
run "empty sentinel is silent"  0 0

echo "----"
echo "stop-cleanup-warn: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
