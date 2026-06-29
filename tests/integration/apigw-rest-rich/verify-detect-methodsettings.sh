#!/usr/bin/env bash
# API Gateway Stage MethodSettings nested detect + revert integration test (real AWS):
# the "someone changed a method's cache TTL in the console" scenario. The Stage declares
# only throttling MethodSettings; AWS materializes the caching scalar defaults
# (CacheTtlInSeconds 300, the `false` siblings) into the live `*/*` setting — folded via
# NESTED_ARRAY_IDENTITY + KNOWN_DEFAULT_PATHS so a clean record->check is CLEAN. Here we
# flip the UNDECLARED CacheTtlInSeconds (300->600) out of band -> check MUST DETECT the
# nested undeclared drift (exit 1) -> revert (SETs the 300 default at the live index) ->
# check MUST be CLEAN and the live value restored to 300.
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

echo "=== check MUST be CLEAN (caching defaults fold) ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN before mutation"

echo "=== out-of-band: MethodSettings */* CacheTtlInSeconds 300->600 (console-edit) ==="
aws apigateway update-stage --rest-api-id "$APIID" --stage-name "$STAGE" \
  --patch-operations 'op=replace,path=/*/*/caching/ttlInSeconds,value=600' \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT nested undeclared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-apigw-methodsettings-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "CacheTtlInSeconds" /tmp/cdkrd-apigw-methodsettings-detect.out || fail "CacheTtlInSeconds not reported"

echo "=== revert (SET the 300 default back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN (exit 0) after revert"

echo "=== live CacheTtlInSeconds MUST be restored to 300 ==="
GOT="$(aws apigateway get-stage --rest-api-id "$APIID" --stage-name "$STAGE" \
  --region "$REGION" --query "methodSettings.\"*/*\".cacheTtlInSeconds" --output text)"
[ "$GOT" = "300" ] || fail "live CacheTtlInSeconds not restored (got: $GOT)"

echo "INTEG PASS ($STACK MethodSettings nested detect+revert)"
