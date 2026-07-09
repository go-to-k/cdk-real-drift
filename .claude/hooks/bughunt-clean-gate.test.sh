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
# Per-owner block semantics + the SPOF regression.
#
# The block is decided against the COMMITTING owner ONLY. For a `git commit` run from
# repo root R, that owner key is R's toplevel path (sanitized) — the SAME key the
# tracker derives when armed from R with NO $CDKRD_BUGHUNT_OWNER. So we arm the "self"
# owner by running the tracker with no env override, and arm an UNRELATED peer owner
# via $CDKRD_BUGHUNT_OWNER=ownerB. A peer's pending stacks must NOT block us (stacks
# are uniquely named — no cross-session contention). Real AWS is unreachable here, so
# clears use CDKRD_BUGHUNT_FORCE_CLEAR=1 to stand in for a passing verify.
#
# The tracker resolves REPO_ROOT from its OWN location (SCRIPT_DIR), so to drive it
# against a throwaway repo we copy it into that repo's skill path and run the COPY —
# then the tracker and the cwd-resolving gate agree on the temp repo root. The tracker
# under test defaults to this worktree's copy, overridable via BUGHUNT_TRACKER_OVERRIDE.
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

# The COMMITTING owner (self) armed → block all three gated commands.
T=$(spof_setup)
TR="$T/.claude/skills/hunt-bugs/bughunt-track.sh"
bash "$TR" add CdkRealDriftIntegSelf >/dev/null   # no $CDKRD_BUGHUNT_OWNER → owner = repo toplevel
check "self owner armed blocks git commit"   "$(gate_exit "$T" "git commit -m x")"        2
check "self owner armed blocks gh pr create" "$(gate_exit "$T" "gh pr create --fill")"    2
check "self owner armed blocks gh pr merge"  "$(gate_exit "$T" "gh pr merge 5 --squash")" 2
rm -rf "$T"

# PER-OWNER ISOLATION (the whole point): only an UNRELATED peer owner is armed →
# the self commit PASSES. A peer session's live hunt no longer blocks us.
T=$(spof_setup)
TR="$T/.claude/skills/hunt-bugs/bughunt-track.sh"
CDKRD_BUGHUNT_OWNER=ownerB bash "$TR" add CdkRealDriftIntegB >/dev/null
check "peer owner armed does NOT block self commit" "$(gate_exit "$T" "git commit -m x")" 0
assert_file "peer owner file present (not touched)" -s "$T/.markgate-bughunt-pending.d/ownerB"
rm -rf "$T"

# Combined + SPOF: self + peer both armed. Self is blocked; after self clears, the
# self commit passes EVEN THOUGH the peer is still pending (per-owner release), and
# the peer's file survived self's clear (the SPOF this design closes).
T=$(spof_setup)
TR="$T/.claude/skills/hunt-bugs/bughunt-track.sh"
bash "$TR" add CdkRealDriftIntegSelf >/dev/null
CDKRD_BUGHUNT_OWNER=ownerB bash "$TR" add CdkRealDriftIntegB >/dev/null
check "self armed (peer too) blocks self commit" "$(gate_exit "$T" "git commit -m x")" 2
CDKRD_BUGHUNT_FORCE_CLEAR=1 bash "$TR" clear >/dev/null   # self clear (no env → self owner)
check "after self clears, self commit passes despite peer pending" "$(gate_exit "$T" "git commit -m x")" 0
assert_file "peer file survived self's clear" -s "$T/.markgate-bughunt-pending.d/ownerB"
CDKRD_BUGHUNT_OWNER=ownerB CDKRD_BUGHUNT_FORCE_CLEAR=1 bash "$TR" clear >/dev/null
assert_file "peer file removed by peer's own clear" ! -e "$T/.markgate-bughunt-pending.d/ownerB"
rm -rf "$T"

# ---------------------------------------------------------------------------
# PER-SESSION deploy-autoarm token. deploy-autoarm-gate arms "autoarm-<session>" on a
# deploy; the gate blocks the SAME session's commit (session id from
# $CLAUDE_CODE_SESSION_ID or the payload session_id) but NOT a peer session's.
# ---------------------------------------------------------------------------
# gate_exit_sess <tmp> <cmd> <session-id> -> hook exit with CLAUDE_CODE_SESSION_ID set
gate_exit_sess() {
  local tmp="$1" cmd="$2" sess="$3" payload code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\",\"session_id\":\"$sess\"}"
  set +e
  printf '%s' "$payload" | CLAUDE_CODE_SESSION_ID="$sess" bash "$HOOK" >/dev/null 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}

# This session's autoarm token blocks this session's commit; a peer session's does not.
T=$(spof_setup)
mkdir -p "$T/.markgate-bughunt-pending.d"
printf 'AUTODEPLOY-pending-verify\n' > "$T/.markgate-bughunt-pending.d/autoarm-sessX"
check "own session's autoarm token blocks commit"   "$(gate_exit_sess "$T" "git commit -m x" "sessX")" 2
check "peer session's autoarm token does NOT block" "$(gate_exit_sess "$T" "git commit -m x" "sessY")" 0
check "no session id + autoarm-<sess> present -> pass (only autoarm-shared is global-ish)" \
  "$(gate_exit "$T" "git commit -m x")" 0
rm -rf "$T"

# Legacy flat file still a GLOBAL block (back-compat with a session armed pre-port).
T=$(spof_setup)
printf 'CdkRealDriftIntegLegacy\n' > "$T/.markgate-bughunt-pending"
check "legacy flat file still blocks" "$(gate_exit "$T" "git commit -m x")" 2
rm -rf "$T"

echo
echo "bughunt-clean-gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
