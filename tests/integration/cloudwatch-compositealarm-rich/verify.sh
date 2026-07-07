#!/usr/bin/env bash
# cdk-real-drift integration test (real AWS) for CdkRealDriftIntegCompositeAlarmRich.
#   deploy fixture -> check BEFORE record (must be CLEAN: zero potential drift on a
#   fresh un-mutated deploy) -> record (baseline) -> check --fail must be CLEAN.
# A cleanup trap force-deletes the stack even on failure (delstack, not cdk destroy).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegCompositeAlarmRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== check BEFORE record (must be CLEAN — zero potential drift) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-$STACK-pre.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN before record (exit 0), got $rc — fold gap (FP)"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN after record ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "INTEG PASS"
