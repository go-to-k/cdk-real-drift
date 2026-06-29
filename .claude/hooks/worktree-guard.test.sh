#!/usr/bin/env bash
# Smoke tests for worktree-guard.sh
#
# Builds a throwaway git repo (optionally with a worktree under .worktrees/),
# runs the hook against simulated Edit/Write/NotebookEdit tool input, and asserts
# the expected pass (0) / block (2) behavior.
# Run: bash .claude/hooks/worktree-guard.test.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/worktree-guard.sh"
PASS=0
FAIL=0

# make_repo <with_worktree:0|1> -> echoes the repo root path
make_repo() {
  local with_wt="$1" tmp
  tmp=$(mktemp -d)
  git -C "$tmp" init -q -b main
  git -C "$tmp" config user.email t@t
  git -C "$tmp" config user.name t
  mkdir -p "$tmp/src" "$tmp/tests" "$tmp/docs"
  : > "$tmp/src/seed.ts"
  : > "$tmp/seed"
  git -C "$tmp" add -A
  git -C "$tmp" commit -q -m init
  if [ "$with_wt" = "1" ]; then
    git -C "$tmp" worktree add -q "$tmp/.worktrees/wt" -b wt main
  fi
  printf '%s' "$tmp"
}

# run <name> <repo_root> <field> <path> <expect_exit>
#   field = file_path | notebook_path
run() {
  local name="$1" root="$2" field="$3" path="$4" expect="$5"
  local payload code
  payload="{\"tool_input\":{\"${field}\":$(printf '%s' "$path" | jq -Rs .)},\"cwd\":\"$root\"}"
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  code=$?
  set -e
  if [ "$code" -eq "$expect" ]; then
    PASS=$((PASS + 1)); echo "ok   - $name (exit $code)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $name (got $code, expected $expect)"
  fi
}

# --- no worktree: editing main src/tests is allowed (solo / integration) ---
R0=$(make_repo 0)
run "no worktree: edit main src passes"        "$R0" file_path "$R0/src/foo.ts"          0
run "no worktree: edit main tests passes"      "$R0" file_path "$R0/tests/foo.test.ts"   0

# --- worktree present: editing the MAIN checkout's src/tests is BLOCKED ---
R1=$(make_repo 1)
run "worktree: edit main src blocks"           "$R1" file_path "$R1/src/foo.ts"          2
run "worktree: edit main nested src blocks"    "$R1" file_path "$R1/src/a/b/c.ts"        2
run "worktree: edit main tests blocks"         "$R1" file_path "$R1/tests/x.test.ts"     2
run "worktree: write NEW main src file blocks" "$R1" file_path "$R1/src/new/dir/n.ts"    2
run "worktree: NotebookEdit main src blocks"   "$R1" notebook_path "$R1/src/nb.ipynb"    2

# --- worktree present: editing INSIDE the worktree is allowed (correct place) ---
run "worktree: edit inside worktree passes"    "$R1" file_path "$R1/.worktrees/wt/src/foo.ts" 0

# --- worktree present: non-src/tests main files are not guarded ---
run "worktree: edit main docs passes"          "$R1" file_path "$R1/docs/x.md"           0
run "worktree: edit main README passes"        "$R1" file_path "$R1/README.md"           0

# --- defensive: ambiguous inputs fail OPEN ---
run "worktree: relative path passes"           "$R1" file_path "src/foo.ts"              0
run "worktree: empty path passes"              "$R1" file_path ""                        0
run "non-git absolute path passes"             "$R1" file_path "/tmp/$$/elsewhere.ts"    0

rm -rf "$R0" "$R1"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
