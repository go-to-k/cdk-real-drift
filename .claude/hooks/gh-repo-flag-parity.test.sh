#!/usr/bin/env bash
# gh-repo-flag-parity.test.sh — cross-gate fence.
#
# THE PROPERTY: naming the repo on the command line must not change any gate's
# verdict. `-R <owner/repo>` says where the PR LIVES; it says nothing about what
# the command DOES, so a gate that refuses `gh pr merge` and permits
# `gh -R o/r pr merge` is simply wrong.
#
# This is the assertion that would have caught the 2026-08-25 bypass, and no
# per-gate harness could: each one drove its own hook with its own spelling and
# was green, because a bypassed gate returns the 0 that a PASS case expects.
# Measured against the shipped hooks, on the fixture below:
#
#   gate                    plain   -R form
#   verify-pr-gate            2        0     <- merges past /verify-pr
#   ci-green-gate             2        0     <- merges past red CI
#   bughunt-clean-gate        2        0     <- merges with live AWS resources
#
# THREE SPELLINGS, because `gh` accepts a flag value with a space, with `=`, or
# with NO SEPARATOR AT ALL. Verified against gh 2.89.0, all three returning the
# same PR number:
#
#   gh pr list --repo=go-to-k/cdkd   -> 2195
#   gh pr list -R=go-to-k/cdkd       -> 2195
#   gh pr list -Rgo-to-k/cdkd        -> 2195
#
# The glued form is the one a hand-written `(-C|-R|--repo)` alternation misses,
# which is why `GATE_GH_C` is `GATE_FLAGS`-style tokenisation instead.
#
# EVERY CASE ASSERTS NON-VACUITY TOO: the plain form must actually BLOCK. Parity
# alone is satisfied by a gate that is inert in both directions — which is
# exactly the state non-english-text-gate was in until `gh -C` was removed from
# its calls, and exactly how a suite can be green over a gate enforcing nothing.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/gh-repo-flag-parity.test.sh"
HOOKS_DIR="$(dirname "$HOOK")"
REPO=go-to-k/cdk-real-drift
PASS=0
FAIL=0

# A fixture where EVERY gate has a reason to block: a `src/**` diff vs a base
# (defeats verify-pr-gate's docs-only exemption), no markgate markers, an armed
# bug-hunt sentinel, and a committed non-English line. Real git repos rather than
# mocks — each gate decides from what `git`/`markgate` actually report.
FIX=$(mktemp -d)
trap 'rm -rf "$FIX"' EXIT
git -C "$FIX" init -q -b main
printf 'gates: {}\n' > "$FIX/.markgate.yml"
mkdir -p "$FIX/src"
printf 'export const a = 1;\n' > "$FIX/src/x.ts"
git -C "$FIX" add -A >/dev/null 2>&1
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm base >/dev/null 2>&1
git -C "$FIX" update-ref refs/remotes/origin/main "$(git -C "$FIX" rev-parse main)"
git -C "$FIX" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "$FIX" checkout -q -b feat
printf 'export const a = 2;\n' > "$FIX/src/x.ts"
# A Japanese comment, so non-english-text-gate has something to refuse.
printf '// \xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\n' > "$FIX/src/jp.ts"
git -C "$FIX" add -A >/dev/null 2>&1
git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm change >/dev/null 2>&1
printf 'stack-a\n' > "$FIX/.markgate-bughunt-pending"
printf 'stack-a\n' > "$FIX/.markgate-bughunt-pending-$(id -un)"

drive() { # <hook.sh> <command> -> exit code
  local rc
  jq -n --arg c "$2" --arg d "$FIX" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
    | bash "$HOOKS_DIR/$1" >/dev/null 2>&1 && rc=0 || rc=$?
  printf '%s' "$rc"
}

# parity <hook.sh> <plain command>
# The repo flag is spliced in right after `gh`, in all three spellings.
parity() {
  local hook="$1" plain="$2" base rc_plain spelling rc
  base=$(drive "$hook" "$plain")

  # Non-vacuity: parity over two passes proves nothing.
  if [ "$base" = "2" ]; then
    echo "PASS: $hook blocks the plain form (exit 2, so parity is not vacuous)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $hook did NOT block the plain form (exit $base) — the gate is inert"
    echo "      command: $plain"
    FAIL=$((FAIL + 1))
    return
  fi

  for spelling in "-R $REPO" "--repo $REPO" "--repo=$REPO" "-R=$REPO" "-R$REPO"; do
    rc=$(drive "$hook" "${plain/gh /gh $spelling }")
    if [ "$rc" = "$base" ]; then
      echo "PASS: $hook — \`gh $spelling …\` matches the plain verdict (exit $rc)"
      PASS=$((PASS + 1))
    else
      echo "FAIL: $hook — \`gh $spelling …\` returned $rc, plain returned $base (BYPASS)"
      FAIL=$((FAIL + 1))
    fi
  done
}

parity verify-pr-gate.sh        "gh pr merge 1 --squash"
parity ci-green-gate.sh         "gh pr merge 1 --squash"
parity bughunt-clean-gate.sh    "gh pr merge 1 --squash"
parity non-english-text-gate.sh "gh pr create --title t"
# The issue-mint gate is not a `pr` verb, but it reads the same flag absorber and
# `-R` is the cross-repo mirror flow's own spelling — its primary shape.
parity issue-dup-check-gate.sh  "gh issue create --title t --body 'no marker here'"

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
