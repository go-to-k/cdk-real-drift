#!/usr/bin/env bash
# cdk-real-drift `added` (out-of-band resource) RECORD-WATCH integration test (real
# AWS) — PR4: `added` is now the resource-level sibling of an undeclared property, so
# it is reconciled against the baseline the same way (record it, watch it for changes).
#   deploy fixture (REST API, GET / + POST /scoring) -> record -> check CLEAN
#   -> inject an out-of-band ANY method on root `/` -> check reports it under
#      [Potential Drift] and is NOT drift (exit 0 — never decided, so no contract to
#      violate) -> `record` snapshots the ANY method -> check CLEAN
#   -> mutate the ANY method out of band (apiKeyRequired true) -> check flags it as
#      `added` drift "changed since record" (exit 1) -> `ignore` it -> check CLEAN
#   -> destroy.
# This is the case CFn drift / cdk drift / driftctl all miss: a WHOLE resource (an API
# Gateway Method) created out of band, then CHANGED out of band — both invisible to
# template-only drift tools. A cleanup trap destroys the stack even on failure.
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
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
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

echo "=== check reports the added method as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdk-real-drift-integ-added.out || fail "added method not under [Potential Drift]"
grep -q "ANY /" /tmp/cdk-real-drift-integ-added.out || fail "ANY / method not reported"
grep -q "added=1" /tmp/cdk-real-drift-integ-added.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added method (snapshot it; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (added method recorded + unchanged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added method, got $rc"
grep -q "Potential Drift" /tmp/cdk-real-drift-integ-added-clean.out && fail "added method still Not-Recorded after record" || true

echo "=== mutate the added method out of band (apiKeyRequired true) ==="
aws apigateway update-method --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method ANY --patch-operations op=replace,path=/apiKeyRequired,value=true \
  --region "$REGION" >/dev/null || fail "mutate ANY / apiKeyRequired"

echo "=== check should DETECT the changed-since-record added method (drift) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added-changed.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 for a changed-since-record added method, got $rc"
grep -q "Added Resource" /tmp/cdk-real-drift-integ-added-changed.out || fail "added section not reported"
grep -q "changed since record" /tmp/cdk-real-drift-integ-added-changed.out || fail "changed-since-record note not shown"
grep -q "added=1" /tmp/cdk-real-drift-integ-added-changed.out || fail "expected exactly added=1"

echo "=== ignore the added method (writes .cdkrd/ignore.yaml) ==="
$CLI ignore "$STACK" --region "$REGION" --yes || fail "ignore"
grep -q "ANY" .cdkrd/ignore.yaml || fail "ignore rule for the added method not written to ignore.yaml"

echo "=== check should now be CLEAN (added method ignored) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-added-ignored.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after ignore, got $rc"
grep -q "added=" /tmp/cdk-real-drift-integ-added-ignored.out && fail "added drift still reported after ignore" || true

echo "INTEG PASS"
