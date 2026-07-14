#!/usr/bin/env bash
# Barest first-run FP probe on nine uncovered types (two stacks): deploy,
# assert the FIRST check (before record) is CLEAN, then record and assert
# check --fail stays clean. Then the post-update echo probe: redeploy with
# -c rev=2 (neutral tag update) and assert the re-check is still clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACKS=(CdkrdHunt0715MissA CdkrdHunt0715MissB)
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup (${STACKS[*]}) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (misspack-hunt): $*"; exit 1; }

echo "=== deploy (both stacks) ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
  CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-misspack}" $CLI check "$STACK" --region "$REGION" --fail \
    | tee "/tmp/cdkrd-$STACK.pre.out"
  RC=${PIPESTATUS[0]}
  # `--fail` exits 0 on baseline-less potential drift — the invariant is ZERO, so grep too.
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] first check not clean (rc=$RC)"

  echo "=== [$STACK] record + check --fail ==="
  $CLI record "$STACK" --region "$REGION" --yes || fail "[$STACK] record"
  $CLI check "$STACK" --region "$REGION" --fail || fail "[$STACK] post-record check not clean"
done

echo "=== redeploy with -c rev=2 (post-update echo probe) ==="
npx cdk deploy -f --all --require-approval never -c rev=2 || fail "redeploy rev=2"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] post-update check MUST be CLEAN ==="
  $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.rev2.out"
  RC=${PIPESTATUS[0]}
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.rev2.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] post-update check not clean (rc=$RC)"
done

echo "INTEG OK (misspack-hunt)"
