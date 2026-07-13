#!/usr/bin/env bash
# False-positive integration test (real AWS): barest oracle-se2 DBInstance (the
# one engine family with zero prior corpus/fixture coverage) -> FIRST check
# (pre-record) must show ZERO drift (every line is an oracle engine-default
# fold gap) -> record -> check CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0714RdsOracle
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture (~15 min) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): every drift line is a fold gap ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
if grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out"; then
  fail "first check must be drift-free (oracle engine-default fold gap)"
fi

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "INTEG PASS ($STACK)"
