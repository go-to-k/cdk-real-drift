#!/usr/bin/env bash
# Run every hook harness under .claude/hooks/.
#
# The harnesses existed for months with nothing invoking them: no `vp run` task
# and no CI step, so a hook could rot and its own smoke test would never say so
# (found 2026-08-20, go-to-k/cdk-real-drift#1797). A fence nobody runs is not a
# fence. Wired as `vp run test:hooks` and into the CI check job.
#
# Each harness resolves its subject from its OWN path (asserted by
# tests/skill-doc-paths.test.ts), so they run in place, from the repo root.
#
# THE INTERPRETER IS A PARAMETER, and that is the whole of the bash-3.2 promise.
# Hooks must run under bash 3.2 (macOS `/bin/bash`), and a plain `bash` here
# resolves through PATH to whatever the developer installed -- 5.x on most
# machines, and 5.x on CI. Running this script under `/bin/bash` was NOT enough
# on its own: the loop below still spawned PATH's `bash` for every harness, so
# the "3.2 tally" measured 5.x and read as a pass. `HOOK_BASH` fixes that, and
# the guard resolves a BARE NAME before testing it (`-x` does no PATH lookup, so
# `HOOK_BASH=bash` would FATAL on a perfectly good interpreter). Take both
# tallies:
#
#   bash scripts/run-hook-tests.sh                              # 5.x
#   HOOK_BASH=/bin/bash bash scripts/run-hook-tests.sh          # 3.2
#
# The guard used to live in `branch-gate.test.sh`, which also planted a PATH
# shim so the HOOK's own children were pinned too; both went with that hook.
# What is restored here is the harness-level half. A hook spawning a nested
# `bash` is still unpinned -- none does today.

set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2

if [ -n "${HOOK_BASH:-}" ]; then
  case "$HOOK_BASH" in
    */*) ;;
    *) HOOK_BASH="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")" ;;
  esac
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 2
  fi
else
  HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found\n' >&2
    exit 2
  }
fi
printf 'interpreter: %s (%s)\n' "$HOOK_BASH" "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

failed=0
ran=0
for harness in .claude/hooks/*.test.sh; do
  [ -e "$harness" ] || continue
  ran=$((ran + 1))
  printf '\n=== %s\n' "$harness"
  if ! "$HOOK_BASH" "$harness"; then
    failed=$((failed + 1))
    printf 'FAILED: %s\n' "$harness"
  fi
done

if [ "$ran" -eq 0 ]; then
  echo "run-hook-tests: no harness found under .claude/hooks/ — the glob is wrong" >&2
  exit 2
fi

printf '\nharnesses run: %s  failed: %s\n' "$ran" "$failed"
[ "$failed" -eq 0 ]
