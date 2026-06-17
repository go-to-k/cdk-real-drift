#!/usr/bin/env bash
# cdk-real-drift `added` integ test for API Gateway REST API GATEWAY RESPONSES (an
# extension of the RestApi CHILD_ENUMERATORS member, which already covers Resources +
# Methods + Authorizers + Models + RequestValidators).
#   deploy fixture (RestApi + one method + one DECLARED GatewayResponse DEFAULT_4XX)
#   -> record -> CLEAN (the DECLARED DEFAULT_4XX is NOT flagged; the ~17 API
#      Gateway-generated un-customized defaults are NOT flagged thanks to the
#      `defaultResponse: false` filter)
#   -> put-gateway-response DEFAULT_5XX (undeclared) on the SAME api out of band ->
#      check reports it under [Not Recorded] with AWS::ApiGateway::GatewayResponse,
#      NOT drift (exit 0)
#   -> `record` snapshots it (proves CC GetResource on the composite RestApiId|ResponseType)
#      -> CLEAN
#   -> customize ANOTHER out-of-band response (UNAUTHORIZED) -> `revert --remove-unrecorded`
#      DELETES it via Cloud Control DeleteResource (which resets it to the built-in default)
#      -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; deleting the RestApi cascades its gateway responses (no orphan).
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/restapi-gatewayresponse-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegRestApiGatewayResponseAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_response() { # $1 = response type, $2 = status code -> customizes a gateway response
  aws apigateway put-gateway-response --rest-api-id "$API" --response-type "$1" \
    --status-code "$2" \
    --region "$REGION" >/dev/null || fail "put-gateway-response $1"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

API="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].PhysicalResourceId" --output text)"
[ -n "$API" ] || fail "could not resolve RestApi id"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared DEFAULT_4XX + the un-customized defaults NOT flagged) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-gr-clean0.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) right after record"
grep -q "AWS::ApiGateway::GatewayResponse" /tmp/cdkrd-integ-gr-clean0.out && fail "a gateway response was falsely flagged after record (defaultResponse filter likely missing)" || true

echo "=== customize an undeclared gateway response (DEFAULT_5XX) out of band ==="
inject_response DEFAULT_5XX 500

echo "=== check reports it as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-gr.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-gr.out || fail "added gateway response not under [Not Recorded]"
grep -q "AWS::ApiGateway::GatewayResponse" /tmp/cdkrd-integ-gr.out || fail "the out-of-band gateway response not reported"
grep -q "added=" /tmp/cdkrd-integ-gr.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added gateway response (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the composite RestApiId|ResponseType) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-gr-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added gateway response, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-gr-clean.out && fail "still Not-Recorded after record (GetResource on the composite id likely failed)" || true

echo "=== customize ANOTHER out-of-band response (UNAUTHORIZED) for the revert path ==="
inject_response UNAUTHORIZED 401

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-gr-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-gr-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-gr-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-gr-revert.out || fail "revert did not converge to CLEAN"

echo "=== the UNAUTHORIZED response must no longer be customized (back to the built-in default) ==="
isdefault="$(aws apigateway get-gateway-response --rest-api-id "$API" --response-type UNAUTHORIZED \
  --region "$REGION" --query "defaultResponse" --output text)"
[ "$isdefault" = "True" ] || fail "the reverted gateway response is still customized (delete did not take effect)"

echo "INTEG PASS"
