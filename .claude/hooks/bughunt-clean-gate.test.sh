#!/usr/bin/env bash
# Smoke tests for bughunt-clean-gate.sh
#
# Sets up a throwaway git repo, optionally arms the bug-hunt sentinel at the repo
# root, runs the hook against simulated tool input, and asserts the expected
# pass (0) / block (2) behavior. Run: bash .claude/hooks/bughunt-clean-gate.test.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/bughunt-clean-gate.sh"
PASS=0
FAIL=0

# run <name> <armed:0|1> <cmd> <expect_exit>
run() {
  local name="$1" armed="$2" cmd="$3" expect="$4"

  local tmp
  tmp=$(mktemp -d)
  pushd "$tmp" >/dev/null

  git init -q -b main
  git config user.email t@t
  git config user.name t
  : > seed
  git add -A
  git commit -q -m init

  if [ "$armed" = "1" ]; then
    printf 'CdkRealDriftIntegFoo\nCdkRealDriftIntegBar\n' > "$tmp/.markgate-bughunt-pending"
  fi

  local payload exit_code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\"}"
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  exit_code=$?
  set -e

  popd >/dev/null
  rm -rf "$tmp"

  if [ "$exit_code" -eq "$expect" ]; then
    PASS=$((PASS + 1))
    echo "ok   - $name (exit $exit_code)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL - $name (got $exit_code, expected $expect)"
  fi
}

# Disarmed: every command passes through.
run "disarmed + git commit passes"        0 "git commit -m x"        0
run "disarmed + gh pr merge passes"       0 "gh pr merge 5 --squash" 0

# Armed: gated commands block.
run "armed + git commit blocks"           1 "git commit -m x"        2
run "armed + git -C commit blocks"        1 "git -C . commit -m x"   2
run "armed + gh pr create blocks"         1 "gh pr create --fill"    2
run "armed + gh pr merge blocks"          1 "gh pr merge 5 --squash" 2

# Armed: non-gated commands still pass.
run "armed + git status passes"           1 "git status"            0
run "armed + git push passes"             1 "git push origin main"  0

# Armed: quoted-body false positives must NOT block (line-start anchoring).
run "armed + echo mentioning git commit"  1 "echo 'run git commit later'"           0
run "armed + echo mentioning gh pr merge" 1 "echo 'remember to gh pr merge soon'"   0

# ---------------------------------------------------------------------------
# Parallel-safe (per-owner) coverage + the SPOF regression.
#
# The tracker resolves REPO_ROOT from its OWN location (SCRIPT_DIR), so to drive it
# against a throwaway repo we copy it into that repo's skill path and run the COPY —
# then the tracker and the cwd-resolving gate agree on the temp repo root. The
# tracker under test defaults to this worktree's copy, but can be overridden to the
# OLD single-file tracker via BUGHUNT_TRACKER_OVERRIDE to prove the SPOF case fails
# against pre-port code.
# ---------------------------------------------------------------------------
TRACKER="${BUGHUNT_TRACKER_OVERRIDE:-$(cd "$(dirname "$0")/../skills/hunt-bugs" && pwd)/bughunt-track.sh}"

# gate_exit <tmp> <cmd> -> echoes the hook's exit code
gate_exit() {
  local tmp="$1" cmd="$2" payload code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\"}"
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}

# check <name> <actual> <expect>
check() {
  if [ "$2" -eq "$3" ]; then
    PASS=$((PASS + 1)); echo "ok   - $1 (exit $2)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $1 (got $2, expected $3)"
  fi
}

# assert_file <name> <test-expr...> (e.g. -s path / ! -e path)
assert_file() {
  local name="$1"; shift
  if [ "$@" ]; then
    PASS=$((PASS + 1)); echo "ok   - $name"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $name"
  fi
}

# Make a throwaway repo with a copy of the tracker at its skill path.
spof_setup() {
  local tmp; tmp=$(mktemp -d)
  (
    cd "$tmp"
    git init -q -b main
    git config user.email t@t
    git config user.name t
    : > seed
    git add -A
    git commit -q -m init
  )
  mkdir -p "$tmp/.claude/skills/hunt-bugs"
  cp "$TRACKER" "$tmp/.claude/skills/hunt-bugs/bughunt-track.sh"
  printf '%s' "$tmp"
}

# Empty .d/ → pass.
T=$(spof_setup)
mkdir -p "$T/.markgate-bughunt-pending.d"
check "empty .d/ passes git commit" "$(gate_exit "$T" "git commit -m x")" 0
rm -rf "$T"

# Armed via .d/ (per-owner) → block all three gated commands.
T=$(spof_setup)
TR="$T/.claude/skills/hunt-bugs/bughunt-track.sh"
CDKRD_BUGHUNT_OWNER=ownerA bash "$TR" add CdkRealDriftIntegA >/dev/null
check "armed via .d/ blocks git commit"   "$(gate_exit "$T" "git commit -m x")"        2
check "armed via .d/ blocks gh pr create" "$(gate_exit "$T" "gh pr create --fill")"    2
check "armed via .d/ blocks gh pr merge"  "$(gate_exit "$T" "gh pr merge 5 --squash")" 2
rm -rf "$T"

# SPOF regression: two distinct owners; A's clear must NOT release B's pending stacks.
T=$(spof_setup)
TR="$T/.claude/skills/hunt-bugs/bughunt-track.sh"
CDKRD_BUGHUNT_OWNER=ownerA bash "$TR" add CdkRealDriftIntegA >/dev/null
CDKRD_BUGHUNT_OWNER=ownerB bash "$TR" add CdkRealDriftIntegB >/dev/null
check "both owners armed -> gate blocks" "$(gate_exit "$T" "git commit -m x")" 2
CDKRD_BUGHUNT_OWNER=ownerA bash "$TR" clear >/dev/null
# THE proof the SPOF is closed — fails on the old single-file tracker (A's clear
# wiped the whole file, releasing B), passes on the per-owner port.
check "after A clears, B still pending -> gate STILL blocks" "$(gate_exit "$T" "git commit -m x")" 2
assert_file "B's owner file survived A's clear" -s "$T/.markgate-bughunt-pending.d/ownerB"
assert_file "A's owner file removed by A's clear" ! -e "$T/.markgate-bughunt-pending.d/ownerA"
CDKRD_BUGHUNT_OWNER=ownerB bash "$TR" clear >/dev/null
check "after both owners clear -> gate releases" "$(gate_exit "$T" "git commit -m x")" 0
rm -rf "$T"

# Legacy flat file still honored (back-compat with a session armed pre-port).
T=$(spof_setup)
printf 'CdkRealDriftIntegLegacy\n' > "$T/.markgate-bughunt-pending"
check "legacy flat file still blocks" "$(gate_exit "$T" "git commit -m x")" 2
rm -rf "$T"

echo
echo "bughunt-clean-gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
