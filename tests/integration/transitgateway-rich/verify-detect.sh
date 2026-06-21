#!/usr/bin/env bash
# Transit Gateway detect + revert integration test (real AWS): the "someone changed
# it in the console" scenario. Deploy -> record -> change the Description out of band
# (a declared, MUTABLE top-level property) -> check MUST DETECT the declared drift
# (exit 1) -> revert -> check MUST be CLEAN and the live Description MUST be restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegTransitGatewayRich
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

TGW="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::TransitGateway'].PhysicalResourceId" --output text)"
[ -n "$TGW" ] || fail "could not resolve transit gateway id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: change the Description (console-edit) ==="
aws ec2 modify-transit-gateway --transit-gateway-id "$TGW" --region "$REGION" \
  --description "drifted out of band" >/dev/null || fail "inject drift"

echo "=== wait for TGW to settle (modifying -> available) ==="
for i in $(seq 1 30); do
  ST="$(aws ec2 describe-transit-gateways --transit-gateway-ids "$TGW" --region "$REGION" \
    --query "TransitGateways[0].State" --output text 2>/dev/null)"
  [ "$ST" = "available" ] && break
  sleep 10
done

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-tgw-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "Description" /tmp/cdkrd-tgw-detect.out || fail "Description drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live Description MUST be restored ==="
GOT="$(aws ec2 describe-transit-gateways --transit-gateway-ids "$TGW" --region "$REGION" \
  --query "TransitGateways[0].Description" --output text)"
[ "$GOT" = "cdk-real-drift integ transit gateway" ] || fail "live Description not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
