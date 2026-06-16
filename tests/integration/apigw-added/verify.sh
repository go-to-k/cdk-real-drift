#!/usr/bin/env bash
# cdk-real-drift `added` (out-of-band resource) integration test (real AWS).
#   deploy fixture (REST API, POST /scoring) -> record -> check CLEAN
#   -> inject an out-of-band ANY method on the ROOT `/` resource (aws apigateway
#      put-method) -> check DETECTS it under [Added Resource] -> destroy.
# This is the case CFn drift / cdk drift / driftctl all miss: a WHOLE resource
# (an API Gateway Method) created out of band, not just an undeclared property.
# A cleanup trap destroys the stack even on failure, so no orphan resources remain.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/apigw-added && npm install && bash verify.sh
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
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Added Resource" /tmp/cdk-real-drift-integ-added.out || fail "added section not reported"
grep -q "ANY /" /tmp/cdk-real-drift-integ-added.out || fail "ANY / method not reported"
# Exactly ONE added finding: the declared GET / (ResourceId = GetAtt RootResourceId)
# must re-resolve to the live root id and NOT false-positive as added (added=1, not 2).
grep -q "added=1" /tmp/cdk-real-drift-integ-added.out || fail "expected exactly added=1 (declared GET / must not false-positive)"

echo "=== ignore the added method (writes .cdkrd/config.json) ==="
$CLI ignore "$STACK" --region "$REGION" --yes || fail "ignore"
grep -q "ANY" .cdkrd/config.json || fail "ignore rule for the added method not written to config.json"

echo "=== check should now be CLEAN (added method ignored) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added-ignored.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after ignore, got $rc"
grep -q "added=" /tmp/cdk-real-drift-integ-added-ignored.out && fail "added drift still reported after ignore" || true

echo "INTEG PASS"
