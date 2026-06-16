#!/usr/bin/env bash
# cdk-real-drift `added` integ test for API Gateway V2 (HTTP API) — the SECOND
# CHILD_ENUMERATORS member. Proves the whole arc on the new enumerator:
#   deploy fixture (HTTP API, declared GET /items) -> record -> check CLEAN
#   -> create a Route + Integration out of band (aws apigatewayv2) -> check reports them
#      under [Not Recorded] and is NOT drift (exit 0) -> `record` snapshots them
#      (proves CC GetResource + normalize work for V2 Route/Integration) -> check CLEAN
#   -> create ANOTHER out-of-band Route+Integration -> `revert --remove-unrecorded`
#      DELETES it via Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss all of this (template-only). A cleanup trap
# destroys the stack even on failure, so no orphan resources remain.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/apigwv2-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegApigwV2Added
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_route() { # $1 = route key (e.g. 'GET /admin')
  local int_id
  int_id="$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type HTTP_PROXY \
    --integration-uri https://example.org --integration-method GET --payload-format-version 1.0 \
    --region "$REGION" --query IntegrationId --output text)" || fail "create-integration"
  aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$int_id" \
    --region "$REGION" >/dev/null || fail "create-route $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

API_ID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text)"
[ -n "$API_ID" ] || fail "could not resolve HTTP Api id"

echo "=== inject an out-of-band Route (GET /admin) + Integration ==="
inject_route 'GET /admin'

echo "=== check reports them as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-v2.out || fail "added route/integration not under [Not Recorded]"
grep -q "GET /admin" /tmp/cdkrd-integ-v2.out || fail "the out-of-band route 'GET /admin' not reported"
grep -q "added=" /tmp/cdkrd-integ-v2.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added route+integration (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize work for V2) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added V2 children, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-v2-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== inject ANOTHER out-of-band Route (GET /audit) for the revert path ==="
inject_route 'GET /audit'

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-v2-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"
grep -q "GET /audit" /tmp/cdkrd-integ-v2-rev.out || fail "the second out-of-band route not reported"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-v2-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-v2-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-v2-revert.out || fail "revert did not converge to CLEAN"

echo "=== the GET /audit route must be gone from AWS ==="
if aws apigatewayv2 get-routes --api-id "$API_ID" --region "$REGION" \
  --query "Items[?RouteKey=='GET /audit'].RouteId" --output text | grep -q .; then
  fail "GET /audit still exists after revert (delete did not take effect)"
fi

echo "INTEG PASS"
