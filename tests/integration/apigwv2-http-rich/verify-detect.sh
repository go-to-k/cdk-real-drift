#!/usr/bin/env bash
# HTTP Api detect + revert integration test (real AWS): the "someone edited the API
# description in the console" scenario. Deploy -> record -> change the DECLARED MUTABLE
# Api Description out of band -> check MUST DETECT (exit 1) -> revert -> check MUST be
# CLEAN and the live value restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegApigwv2HttpRich
APINAME=cdkrd-httpapi-rich
WANT="cdkrd http api rich"
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

APIID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='$APINAME'].ApiId | [0]" --output text)"
[ -n "$APIID" ] && [ "$APIID" != "None" ] || fail "could not resolve http api id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: Api Description -> 'changed by console' ==="
aws apigatewayv2 update-api --api-id "$APIID" --description "changed by console" \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-httpapi-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "Description" /tmp/cdkrd-httpapi-detect.out || fail "Description not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live Description MUST be restored ==="
GOT="$(aws apigatewayv2 get-api --api-id "$APIID" --region "$REGION" --query "Description" --output text)"
[ "$GOT" = "$WANT" ] || fail "live Description not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
