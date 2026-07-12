#!/usr/bin/env bash
# False-positive + detection integration test (real AWS), #1535:
# deploy -> FIRST check (pre-record) must show ZERO drift of any tier ->
# record -> check CLEAN -> out-of-band queue PAUSE must be DETECTED ->
# restore ACTIVE -> check CLEAN again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713MediaConv
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): every drift line is a fold gap ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
if grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out"; then
  fail "first check must be drift-free (#1535 fold gap regression)"
fi

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] out-of-band pause MUST be detected (equality gate) ==="
aws mediaconvert update-queue --name cdkrd-hunt-mc-queue --status PAUSED --region "$REGION" >/dev/null || fail "mutate"
$CLI check "$STACK" --region "$REGION" --fail
[ "$?" -eq 1 ] || fail "expected drift exit 1 after out-of-band PAUSED"

echo "=== [$STACK] restore ACTIVE -> CLEAN ==="
aws mediaconvert update-queue --name cdkrd-hunt-mc-queue --status ACTIVE --region "$REGION" >/dev/null || fail "restore"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after restore"

echo "INTEG PASS ($STACK)"
