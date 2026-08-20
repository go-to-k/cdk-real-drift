#!/usr/bin/env bash
# Run every PreToolUse / Stop hook harness under .claude/hooks/.
#
# The harnesses existed for months with nothing invoking them: no `vp run` task
# and no CI step, so a hook could rot and its own smoke test would never say so
# (found 2026-08-20, go-to-k/cdk-real-drift#1797). A fence nobody runs is not a
# fence. Wired as `vp run test:hooks` and into the CI check job.
#
# Each harness resolves its subject from its OWN path (asserted by
# tests/skill-doc-paths.test.ts), so they run in place, from the repo root.

set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 2

failed=0
ran=0
for harness in .claude/hooks/*.test.sh; do
  [ -e "$harness" ] || continue
  ran=$((ran + 1))
  printf '\n=== %s\n' "$harness"
  if ! bash "$harness"; then
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
