#!/usr/bin/env bash
# Detection (FN-half) integration test (real AWS): deploy -> first check must be
# CLEAN -> record -> out-of-band queue pause -> check MUST detect (exit 1) ->
# restore -> CLEAN. The record step matters: without a baseline an undeclared
# divergence is only [Potential Drift] and `--fail` stays exit 0.
# MediaConvert has no SDK writer yet, so this stops at detection (no revert leg).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegMediaConvertMin
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
QUEUE=cdkrd-hunt-mc-queue

cleanup() {
  echo "--- cleanup ($STACK) ---"
  aws mediaconvert update-queue --name "$QUEUE" --status ACTIVE --region "$REGION" >/dev/null 2>&1 || true
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check must be CLEAN (folds in place) ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "first check not CLEAN"

echo "=== [$STACK] record (baseline — a later divergence is then CONFIRMED drift, exit 1) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] OOB: pause the queue ==="
aws mediaconvert update-queue --name "$QUEUE" --status PAUSED --region "$REGION" >/dev/null || fail "update-queue PAUSED"

echo "=== [$STACK] check MUST detect the Status drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected detect (exit 1), got $rc"
grep -q 'Status' "/tmp/cdkrd-$STACK.detect.out" || fail "Status drift not in output"

echo "=== [$STACK] restore ACTIVE ==="
aws mediaconvert update-queue --name "$QUEUE" --status ACTIVE --region "$REGION" >/dev/null || fail "restore ACTIVE"

echo "=== [$STACK] check MUST be CLEAN again ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "post-restore not CLEAN"

echo "INTEG PASS ($STACK detect)"
