#!/usr/bin/env bash
# False-positive + detection integration test (real AWS), #1536:
# deploy -> FIRST check (pre-record) must show ZERO drift AND ZERO skipped
# (the LakeFormation physical-id prefix regression skips the resource) ->
# record -> check CLEAN -> out-of-band hybrid-access re-registration must be
# DETECTED -> restore -> check CLEAN again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713MiscReaders
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
LF_ARN="arn:aws:s3:::cdkrd-hunt-lf-bucket-x9z7q"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): zero drift, zero skipped ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out" && fail "first check must be drift-free"
grep -q "skipped=" "/tmp/cdkrd-$STACK.first.out" && fail "LakeFormation Resource skipped — #1536 physical-id prefix regression"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] out-of-band hybrid-access re-registration MUST be detected ==="
aws lakeformation deregister-resource --resource-arn "$LF_ARN" --region "$REGION" >/dev/null || fail "deregister"
aws lakeformation register-resource --resource-arn "$LF_ARN" --use-service-linked-role --hybrid-access-enabled --region "$REGION" >/dev/null || fail "re-register"
$CLI check "$STACK" --region "$REGION" --fail
[ "$?" -eq 1 ] || fail "expected drift exit 1 after hybrid-access re-registration"

echo "=== [$STACK] restore -> CLEAN ==="
aws lakeformation deregister-resource --resource-arn "$LF_ARN" --region "$REGION" >/dev/null || fail "deregister-2"
aws lakeformation register-resource --resource-arn "$LF_ARN" --use-service-linked-role --region "$REGION" >/dev/null || fail "restore"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after restore"

echo "INTEG PASS ($STACK)"
