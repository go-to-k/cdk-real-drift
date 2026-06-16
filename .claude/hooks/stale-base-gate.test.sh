#!/usr/bin/env bash
# Smoke test for stale-base-gate.sh.
#
# Builds fixture git repos with a real `refs/remotes/origin/main` and asserts
# the BLOCK (exit 2) vs ALLOW (exit 0) outcomes of the stale-base soft-reset
# clobber detector. Run from the repo root:
#   bash .claude/hooks/stale-base-gate.test.sh
#
# Why a shell script (not vitest): the hook IS a shell script; its contract is
# the stdin JSON payload + exit code. A TS wrapper would test the wrapper.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stale-base-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

git_q() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }

# Build a repo with:
#   main:        A (f=v0) -> B (f=v1)   [B is origin/main tip]
#   feature_rev: forks at B, reverts f back to v0   -> clobber (BLOCK)
#   feature_new: forks at B, adds a NEW file g       -> clean (ALLOW)
#   feature_behind: forks at A, edits unrelated h    -> behind main (ALLOW)
repo="$TMPDIR/repo"
git init -q -b main "$repo"
printf 'v0\n' > "$repo/f"; git_q "$repo" add f; git_q "$repo" commit -q -m A
printf 'v1\n' > "$repo/f"; git_q "$repo" add f; git_q "$repo" commit -q -m B
B=$(git_q "$repo" rev-parse HEAD)
A=$(git_q "$repo" rev-parse HEAD~1)
git_q "$repo" update-ref refs/remotes/origin/main "$B"

# feature_rev: on top of B (origin/main) but tree reverts f to v0 (== A's f).
git_q "$repo" checkout -q -b feature_rev "$B"
printf 'v0\n' > "$repo/f"; git_q "$repo" add f; git_q "$repo" commit -q -m "revert f"

# feature_new: on top of B, adds a brand-new file.
git_q "$repo" checkout -q -b feature_new "$B"
printf 'x\n' > "$repo/g"; git_q "$repo" add g; git_q "$repo" commit -q -m "add g"

# feature_behind: forks at A (behind origin/main), edits unrelated file.
git_q "$repo" checkout -q -b feature_behind "$A"
printf 'h\n' > "$repo/h"; git_q "$repo" add h; git_q "$repo" commit -q -m "add h"

pass=0; fail=0; fail_log=""
# run_case <name> <expect_exit> <command> <checkout_branch>
run_case() {
  local name="$1" want="$2" command="$3" branch="$4" got out
  git_q "$repo" checkout -q "$branch"
  local payload; payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$command")
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1); true
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1; got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want $want got $got\n  out: $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# ALLOW: non-push command passes through untouched (even from a clobber branch).
run_case "non-push command allowed" 0 "git status" feature_rev
# ALLOW: a real clobber branch but the command is not a push.
run_case "git diff on clobber branch allowed" 0 "git diff" feature_rev
# BLOCK: pushing the stale-base clobber branch.
run_case "push of stale-base clobber blocked" 2 "git push origin HEAD" feature_rev
# ALLOW: pushing a branch that adds a new file on top of origin/main.
run_case "push of clean on-top branch allowed" 0 "git push origin HEAD" feature_new
# ALLOW: pushing a branch merely BEHIND origin/main (normal worktree case).
run_case "push of behind-main branch allowed" 0 "git push origin HEAD" feature_behind
# ALLOW: non-git target dir (cannot judge) passes through.
bare="$TMPDIR/not-a-repo"; mkdir -p "$bare"
payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push"}}' "$bare")
printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
if [[ $? == 0 ]]; then pass=$((pass + 1)); echo "OK   non-git target dir allowed (exit 0)"; else
  fail=$((fail + 1)); echo "FAIL non-git target dir allowed"; fi

echo
echo "stale-base-gate.test: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then printf '%b' "$fail_log"; exit 1; fi
