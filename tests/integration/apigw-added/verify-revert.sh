#!/usr/bin/env bash
# cdk-real-drift `added` (out-of-band resource) REVERT integration test (real AWS).
#   deploy fixture (REST API, GET / + POST /scoring) -> record -> check CLEAN
#   -> inject an out-of-band ANY method on the ROOT `/` resource -> check DETECTS it
#   (added=1) -> `cdkrd revert --yes` DELETES it via Cloud Control DeleteResource
#   -> check is CLEAN (the method is gone) -> destroy.
# This exercises the one AWS-MUTATING path for the added tier: revert = delete.
# A cleanup trap destroys the stack even on failure, so no orphan resources remain.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/apigw-added && npm install && bash verify-revert.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegApigwAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== inject out-of-band ANY method on root / ==="
API_ID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].PhysicalResourceId" --output text)"
[ -n "$API_ID" ] || fail "could not resolve RestApi id"
ROOT_ID="$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
  --query "items[?path=='/'].id" --output text)"
[ -n "$ROOT_ID" ] || fail "could not resolve root resource id"
aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method ANY --authorization-type NONE --region "$REGION" >/dev/null || fail "inject ANY /"

echo "=== check should DETECT the added method ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 before revert, got $rc"
grep -q "added=1" /tmp/cdk-real-drift-integ-added-rev.out || fail "expected added=1 before revert"

echo "=== revert DELETES the added method (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee /tmp/cdk-real-drift-integ-revert.out
rc=${PIPESTATUS[0]}
grep -q "reverted:" /tmp/cdk-real-drift-integ-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdk-real-drift-integ-revert.out || fail "revert did not converge to CLEAN"

echo "=== the ANY method must be gone from AWS ==="
if aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method ANY --region "$REGION" >/dev/null 2>&1; then
  fail "ANY / still exists after revert (delete did not take effect)"
fi

echo "=== check should now be CLEAN (added method deleted) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert deleted the added method"

echo "INTEG PASS"
