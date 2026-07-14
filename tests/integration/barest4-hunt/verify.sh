#!/usr/bin/env bash
# Barest-form first-run FP probe batch 4 (real AWS): deploy the barest form of
# eight rich-only-covered types across two stacks, assert the FIRST check
# (before record) is CLEAN, then record and assert check --fail is still clean.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACKS=(CdkrdHunt0714Barest4A CdkrdHunt0714Barest4B)
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup (${STACKS[*]}) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (barest4-hunt): $*"; exit 1; }

echo "=== deploy (both stacks) ==="
npx cdk deploy -f --all --require-approval never || fail "deploy"

for STACK in "${STACKS[@]}"; do
  echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
  CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-barest4}" $CLI check "$STACK" --region "$REGION" --fail \
    | tee "/tmp/cdkrd-$STACK.pre.out"
  RC=${PIPESTATUS[0]}
  # `--fail` exits 0 on baseline-less potential drift — the invariant is ZERO, so grep too.
  grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
  [ "$RC" -eq 0 ] || fail "[$STACK] first check not clean (rc=$RC)"

  echo "=== [$STACK] record + check --fail ==="
  $CLI record "$STACK" --region "$REGION" --yes || fail "[$STACK] record"
  $CLI check "$STACK" --region "$REGION" --fail || fail "[$STACK] post-record check not clean"
done

echo "INTEG OK (barest4-hunt)"
