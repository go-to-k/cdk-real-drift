#!/usr/bin/env bash
# Post-update echo materialization probe (real AWS): deploy ~15 barest common
# types, assert the FIRST check (before record) is CLEAN, then run a harmless
# stack UPDATE (tag/description bump via `-c rev=2`) and assert the check is
# STILL clean. Any undeclared property materializing only after the update is
# the #1569 (Glue sizing echo) FP class on a new type.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntEcho0714
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy v1 ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy v1"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR=/tmp/corpus-echo-v1 $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK-v1.out"
V1=${PIPESTATUS[0]}
# `--fail` exits 0 on baseline-less potential drift — the invariant is ZERO, so grep too.
grep -q "Potential Drift" "/tmp/cdkrd-$STACK-v1.out" && V1=10

echo "=== [$STACK] deploy v2 (harmless tag/description bump) ==="
npx cdk deploy -f "$STACK" -c rev=2 --require-approval never || fail "deploy v2"

echo "=== [$STACK] check after UPDATE MUST STILL be clean ==="
CDKRD_CORPUS_DIR=/tmp/corpus-echo-v2 $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK-v2.out"
V2=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK-v2.out" && V2=10

[ "$V1" -eq 0 ] || fail "FIRST check reported potential drift on a clean deploy (fold gap)"
[ "$V2" -eq 0 ] || fail "post-update check reported drift (post-update echo materialization)"
echo "INTEG OK ($STACK)"
