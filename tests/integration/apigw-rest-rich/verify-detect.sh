#!/usr/bin/env bash
# API Gateway REST detect + revert integration test (real AWS): the "someone toggled
# X-Ray tracing on the stage in the console" scenario. Deploy -> record -> flip the
# DECLARED MUTABLE Stage TracingEnabled (false->true) out of band -> check MUST DETECT
# (exit 1) -> revert -> check MUST be CLEAN and the live value restored to false.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApigwRestRich
APINAME=cdkrd-apigw-rest-rich
STAGE=prod
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

APIID="$(aws apigateway get-rest-apis --region "$REGION" \
  --query "items[?name=='$APINAME'].id | [0]" --output text)"
[ -n "$APIID" ] && [ "$APIID" != "None" ] || fail "could not resolve rest-api id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: Stage TracingEnabled false->true (console-edit) ==="
aws apigateway update-stage --rest-api-id "$APIID" --stage-name "$STAGE" \
  --patch-operations op=replace,path=/tracingEnabled,value=true \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-apigw-rest-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "TracingEnabled" /tmp/cdkrd-apigw-rest-detect.out || fail "TracingEnabled not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live TracingEnabled MUST be restored to false ==="
GOT="$(aws apigateway get-stage --rest-api-id "$APIID" --stage-name "$STAGE" \
  --region "$REGION" --query "tracingEnabled" --output text)"
[ "$GOT" = "False" ] || fail "live TracingEnabled not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
