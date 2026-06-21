#!/usr/bin/env bash
# ALB detect + revert integration test (real AWS): the "someone changed an LB
# attribute in the console" scenario. Deploy -> record -> change a DECLARED
# MUTABLE attribute (idle_timeout.timeout_seconds 120->240) out of band via
# modify-load-balancer-attributes -> check MUST DETECT (exit 1) -> revert ->
# check MUST be CLEAN and the live value restored to 120.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAlbRich
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

ARN="$(aws elbv2 describe-load-balancers --names cdkrd-alb-rich --region "$REGION" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text)"
[ -n "$ARN" ] || fail "could not resolve LB arn"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: idle_timeout 120->240 (console-edit) ==="
aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ARN" \
  --attributes Key=idle_timeout.timeout_seconds,Value=240 --region "$REGION" >/dev/null \
  || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-alb-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "idle_timeout" /tmp/cdkrd-alb-detect.out || fail "idle_timeout not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live idle_timeout MUST be restored to 120 ==="
GOT="$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$ARN" --region "$REGION" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" --output text)"
[ "$GOT" = "120" ] || fail "live idle_timeout not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
