#!/usr/bin/env bash
# False-positive + detection integration test (real AWS), #1546/#1547/#1548:
# GWLB + GENEVE TG + ALB-behind-NLB + MSK Serverless -> FIRST check (pre-record)
# must show ZERO drift AND ZERO skipped -> record -> check CLEAN -> out-of-band
# NLB listener idle-timeout change must be DETECTED -> restore -> CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0713bNetVariants
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
if [ -z "${CDKRD_KEEP_STACK:-}" ]; then trap cleanup EXIT; fi
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture (MSK Serverless ~5 min) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] FIRST check (pre-record): zero drift, zero skipped ==="
$CLI check "$STACK" --region "$REGION" | tee "/tmp/cdkrd-$STACK.first.out"
grep -q "Drift:" "/tmp/cdkrd-$STACK.first.out" && fail "first check must be drift-free (#1546/#1547 regression)"
grep -q "skipped=" "/tmp/cdkrd-$STACK.first.out" && fail "GWLB listener skipped — #1548 regression"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] out-of-band NLB idle-timeout change MUST be detected ==="
NLBL=$(aws elbv2 describe-listeners --load-balancer-arn "$(aws elbv2 describe-load-balancers --region "$REGION" --query "LoadBalancers[?Type=='network' && contains(LoadBalancerName,'HuntN')].LoadBalancerArn|[0]" --output text)" --region "$REGION" --query 'Listeners[0].ListenerArn' --output text)
aws elbv2 modify-listener-attributes --listener-arn "$NLBL" --attributes Key=tcp.idle_timeout.seconds,Value=500 --region "$REGION" >/dev/null || fail "mutate"
$CLI check "$STACK" --region "$REGION" --fail
[ "$?" -eq 1 ] || fail "expected drift exit 1 after idle-timeout change"

echo "=== [$STACK] restore -> CLEAN ==="
aws elbv2 modify-listener-attributes --listener-arn "$NLBL" --attributes Key=tcp.idle_timeout.seconds,Value=350 --region "$REGION" >/dev/null || fail "restore"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after restore"

echo "INTEG PASS ($STACK)"
