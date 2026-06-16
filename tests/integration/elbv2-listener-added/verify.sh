#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Elastic Load Balancing v2 (the EIGHTH
# CHILD_ENUMERATORS member).
#   deploy fixture (internal ALB + one declared Listener) -> record -> CLEAN
#   -> create-listener an undeclared listener on the SAME load balancer out of band ->
#      check reports the listener under [Not Recorded] and is NOT drift (exit 0) ->
#      `record` snapshots it (proves CC GetResource for AWS::ElasticLoadBalancingV2::Listener)
#      -> CLEAN
#   -> add ANOTHER out-of-band listener -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys the
# stack even on failure; the listeners cascade with the ALB. ALB+VPC teardown is slow
# (~3-5 min) and ENI-orphan-prone, so the trap explicitly verifies the VPC is gone.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/elbv2-listener-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegElbv2ListenerAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  # Deleting the ALB CASCADES its listeners, so no out-of-band listener can block the
  # ALB's deletion (unlike an SNS sub / EventBridge rule). delstack tears the stack down.
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

inject_listener() { # $1 = port -> creates a fixed-response listener on the ALB; echoes its ARN
  aws elbv2 create-listener --load-balancer-arn "$LB" --protocol HTTP --port "$1" \
    --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=200,ContentType=text/plain}' \
    --region "$REGION" --query 'Listeners[0].ListenerArn' --output text || fail "create-listener $1"
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

LB="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ElasticLoadBalancingV2::LoadBalancer'].PhysicalResourceId" --output text)"
[ -n "$LB" ] || fail "could not resolve LoadBalancer ARN"

echo "=== create-listener (undeclared) on the ALB out of band ==="
ARN1="$(inject_listener 8080)"
[ -n "$ARN1" ] || fail "no ARN for the first out-of-band listener"

echo "=== check reports the listener as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-elbv2.out || fail "added listener not under [Not Recorded]"
grep -q "AWS::ElasticLoadBalancingV2::Listener" /tmp/cdkrd-integ-elbv2.out || fail "the out-of-band listener not reported"
grep -q "added=" /tmp/cdkrd-integ-elbv2.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added listener (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource on the ListenerArn) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added listener, got $rc"
grep -q "Not Recorded" /tmp/cdkrd-integ-elbv2-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band listener for the revert path ==="
ARN2="$(inject_listener 8081)"
[ -n "$ARN2" ] || fail "no ARN for the second out-of-band listener"

echo "=== check reports the new one under [Not Recorded] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-elbv2-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-elbv2-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-elbv2-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-elbv2-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second listener must be gone from AWS ==="
if aws elbv2 describe-listeners --listener-arns "$ARN2" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted listener still exists (delete did not take effect)"
fi

echo "INTEG PASS"
