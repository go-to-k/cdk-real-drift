#!/usr/bin/env bash
# Detect + revert integration test (real AWS): the "someone changed it in the
# console" scenario for an ECS capacity provider. Deploy -> record -> lower
# ManagedScaling.TargetCapacity out of band (80 -> 50) -> check MUST DETECT the
# declared drift (exit 1) -> revert -> check MUST be CLEAN and the live value
# MUST be 80 again. TargetCapacity is declared and FULLY_MUTABLE, so the whole
# detect -> revert -> clean cycle must close.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEcsCapacityProvider
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CP_NAME=cdkrd-hunt-cp

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

echo "=== out-of-band: ManagedScaling TargetCapacity 80 -> 50 (console-edit) ==="
aws ecs update-capacity-provider --name "$CP_NAME" --region "$REGION" \
  --auto-scaling-group-provider 'managedScaling={targetCapacity=50}' >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "TargetCapacity" "/tmp/cdkrd-$STACK-detect.out" || fail "TargetCapacity drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

LIVE="$(aws ecs describe-capacity-providers --capacity-providers "$CP_NAME" --region "$REGION" \
  --query 'capacityProviders[0].autoScalingGroupProvider.managedScaling.targetCapacity' --output text)"
[ "$LIVE" = "80" ] || fail "live TargetCapacity not restored (got $LIVE)"

echo "INTEG PASS ($STACK detect+revert)"
