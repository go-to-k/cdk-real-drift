#!/usr/bin/env bash
# AutoScaling LifecycleHook detect + revert integration test (real AWS): the "someone
# changed it in the console" scenario, which also exercises the new composite
# AutoScalingGroupName|LifecycleHookName CC identifier read path end to end. Deploy ->
# record -> change HeartbeatTimeout out of band (a declared, MUTABLE property) -> check
# MUST DETECT the declared drift (exit 1) -> revert -> check MUST be CLEAN and the live
# timeout MUST be restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAutoScalingLifecycleHookRich
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

ASG="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::AutoScaling::AutoScalingGroup'].PhysicalResourceId" --output text)"
[ -n "$ASG" ] || fail "could not resolve ASG name"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: change HeartbeatTimeout 300 -> 120 (console-edit) ==="
aws autoscaling put-lifecycle-hook --auto-scaling-group-name "$ASG" --region "$REGION" \
  --lifecycle-hook-name cdkrd-launch-hook \
  --lifecycle-transition autoscaling:EC2_INSTANCE_LAUNCHING \
  --heartbeat-timeout 120 >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-hook-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "HeartbeatTimeout" /tmp/cdkrd-hook-detect.out || fail "HeartbeatTimeout drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live HeartbeatTimeout MUST be restored ==="
GOT="$(aws autoscaling describe-lifecycle-hooks --auto-scaling-group-name "$ASG" --region "$REGION" \
  --query "LifecycleHooks[?LifecycleHookName=='cdkrd-launch-hook'].HeartbeatTimeout | [0]" --output text)"
[ "$GOT" = "300" ] || fail "live HeartbeatTimeout not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
