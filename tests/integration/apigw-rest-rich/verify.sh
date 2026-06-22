#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> check (pre-record) ->
# record baseline -> check MUST be CLEAN. A property-rich RestApi folds endpoint
# config / binary media types / minimum compression size and the deployed Stage's
# MethodSettings ("*/*") into AWS's own model with defaults. Any drift on a clean
# recorded stack is a normalization / default-folding false positive.
#
# REGRESSION GUARD (#293): AWS auto-creates two built-in default models (`Empty`,
# `Error`) on EVERY RestApi. They are never template resources, so the Model
# child-enumerator used to surface them as out-of-band `added` on a clean deploy
# (a `[Not Recorded: 2]` finding on the FIRST check, before any record). The
# pre-record check below asserts they DO NOT appear. The post-record check alone
# cannot catch this — `record` snapshots them, masking the regression.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApigwRestRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] pre-record check: AWS built-in Empty/Error models must NOT surface (#293) ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK-prerecord.out"
if grep -Eq '(Empty|Error) \(AWS::ApiGateway::Model\)' "/tmp/cdkrd-$STACK-prerecord.out"; then
  echo "--- FALSE POSITIVE: AWS built-in Empty/Error API Gateway models surfaced as added on a clean deploy ---"
  fail "built-in Empty/Error models must be filtered (regression of #293)"
fi

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"
