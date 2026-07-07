#!/usr/bin/env bash
# EventBridge ApiDestination detect + revert integration test (real AWS): the
# "someone changed the HTTP method in the console" scenario. Deploy -> record ->
# flip the DECLARED MUTABLE HttpMethod POST->PUT out of band -> check MUST DETECT
# (exit 1) -> revert -> check MUST be CLEAN and HttpMethod restored to POST.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEventsApiDestRich
NAME=cdkrd-apidest-rich
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

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: HttpMethod POST->PUT (console-edit) ==="
aws events update-api-destination --name "$NAME" --region "$REGION" \
  --http-method PUT >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-apidest-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "HttpMethod" /tmp/cdkrd-apidest-detect.out || fail "HttpMethod not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live HttpMethod MUST be restored to POST ==="
GOT="$(aws events describe-api-destination --name "$NAME" --region "$REGION" --query "HttpMethod" --output text)"
[ "$GOT" = "POST" ] || fail "live HttpMethod not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
