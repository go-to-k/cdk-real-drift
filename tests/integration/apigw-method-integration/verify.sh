#!/usr/bin/env bash
# cdk-real-drift ApiGateway Method Integration-knob detect/revert integration test (real AWS).
#
# A REST API GET method with a MOCK integration + one integration response (200). The
# template declares neither the integration's PassthroughBehavior/ContentHandling nor the
# integration response's SelectionPattern/ContentHandling. verify.sh sets them OUT OF BAND
# and asserts:
#   (B) the undeclared knobs are SURFACED in the default report (no --show-all);
#   (C1) the ARRAY-ELEMENT ones (IntegrationResponses[200].{SelectionPattern,ContentHandling})
#        are DETECTED at all — the array is keyed by StatusCode (not a generic IDENTITY_FIELD)
#        so it was never descended before (a silent FN);
#   (C2) reverting RESETS every knob via the API Gateway SDK writer — PassthroughBehavior
#        back to its WHEN_NO_MATCH default, SelectionPattern / ContentHandling removed.
#
# Flow:
#   deploy -> check is CLEAN (FP guard: the new surfacing/detection must not false-drift a
#     fresh API) -> set the 3 knobs out of band -> check DETECTS + SURFACES all 3 (exit 1)
#   -> revert --remove-unrecorded -> re-read live: all 3 reset -> check CLEAN again
# A cleanup trap force-deletes the stack (delstack) and removes the baseline even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/apigw-method-integration && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApigwMethod
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

API_ID="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].PhysicalResourceId" --output text)"
[ -n "$API_ID" ] || fail "could not resolve RestApi id"
ROOT_ID="$(aws apigateway get-resources --rest-api-id "$API_ID" --region "$REGION" \
  --query "items[?path=='/'].id" --output text)"
[ -n "$ROOT_ID" ] || fail "could not resolve root resource id"
echo "api=$API_ID root=$ROOT_ID"

echo "=== PHASE A: fresh deploy must be CLEAN (no false drift from the new surfacing) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "phase A: expected CLEAN (exit 0) on a fresh API"

echo "=== set the 3 knobs OUT OF BAND ==="
aws apigateway update-integration --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --region "$REGION" \
  --patch-operations op=replace,path=/passthroughBehavior,value=NEVER >/dev/null \
  || fail "set passthroughBehavior"
aws apigateway update-integration-response --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --status-code 200 --region "$REGION" \
  --patch-operations 'op=replace,path=/selectionPattern,value=5\d\d' \
                     op=replace,path=/contentHandling,value=CONVERT_TO_TEXT >/dev/null \
  || fail "set selectionPattern/contentHandling"
# MethodResponses ResponseModels: AWS does NOT auto-materialize it (CFn-created reads null),
# so attaching the built-in "Error" model is a genuine undeclared value.
aws apigateway update-method-response --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --status-code 200 --region "$REGION" \
  --patch-operations op=add,path=/responseModels/application~1json,value=Error >/dev/null \
  || fail "set responseModels"

echo "=== PHASE B+C1: check must DETECT + SURFACE all 4 undeclared knobs ==="
# No baseline yet, so these are POTENTIAL drift (unrecorded) — that is exit 0 by design
# (only confirmed declared/undeclared drift sets exit 1). The assertion is that all are
# SURFACED in the default report (B) — including the array-element + method-response ones (C1).
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-integ-apigw-p2.out
grep -q "Integration.PassthroughBehavior" /tmp/cdkrd-integ-apigw-p2.out \
  || fail "PassthroughBehavior not surfaced"
grep -q "IntegrationResponses\[200\].SelectionPattern" /tmp/cdkrd-integ-apigw-p2.out \
  || fail "C1: array-element SelectionPattern not detected (StatusCode descent missing?)"
grep -q "IntegrationResponses\[200\].ContentHandling" /tmp/cdkrd-integ-apigw-p2.out \
  || fail "C1: array-element ContentHandling not detected"
grep -q "MethodResponses\[200\].ResponseModels" /tmp/cdkrd-integ-apigw-p2.out \
  || fail "C1: MethodResponses ResponseModels not detected (StatusCode descent missing?)"

echo "=== PHASE C2: revert (remove unrecorded) -> the SDK writer resets every knob ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-apigw-revert.out \
  || fail "revert command errored"
grep -qi "FAILED" /tmp/cdkrd-integ-apigw-revert.out && fail "revert reported a FAILED op"

echo "=== verify convergence on the live integration ==="
PASS_AFTER="$(aws apigateway get-integration --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --region "$REGION" --query 'passthroughBehavior' --output text)"
echo "passthroughBehavior after revert: '$PASS_AFTER'"
[ "$PASS_AFTER" = "WHEN_NO_MATCH" ] || fail "C2: PassthroughBehavior not reset (still '$PASS_AFTER')"

SEL_AFTER="$(aws apigateway get-integration-response --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --status-code 200 --region "$REGION" --query 'selectionPattern' --output text)"
echo "selectionPattern after revert: '$SEL_AFTER'"
[ "$SEL_AFTER" = "None" ] || [ -z "$SEL_AFTER" ] || fail "C2: SelectionPattern not removed (still '$SEL_AFTER')"

CH_AFTER="$(aws apigateway get-integration-response --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --status-code 200 --region "$REGION" --query 'contentHandling' --output text)"
echo "contentHandling after revert: '$CH_AFTER'"
[ "$CH_AFTER" = "None" ] || [ -z "$CH_AFTER" ] || fail "C2: ContentHandling not removed (still '$CH_AFTER')"

RM_AFTER="$(aws apigateway get-method-response --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET --status-code 200 --region "$REGION" --query 'responseModels' --output text)"
echo "responseModels after revert: '$RM_AFTER'"
[ "$RM_AFTER" = "None" ] || [ -z "$RM_AFTER" ] || fail "C2: ResponseModels not removed (still '$RM_AFTER')"

echo "=== PHASE D: check must be CLEAN again after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "phase D: expected CLEAN (exit 0) after revert"

echo "INTEG PASS"
