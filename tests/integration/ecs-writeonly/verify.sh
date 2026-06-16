#!/usr/bin/env bash
# cdkrd ECS Service integration test (real AWS, AWS-mutating revert). Covers two
# coupled fixes (R102):
#   1. AWS::ECS::Service is now READABLE — its CC primaryIdentifier is composite
#      [ServiceArn, Cluster]; without the router adapter cdkrd passed the bare ARN
#      and CC GetResource ValidationException'd → the service was SKIPPED (drift
#      invisible).
#   2. Reverting it no longer drops the write-only VolumeConfigurations — Cloud
#      Control's read-modify-write can't read write-only props, so a minimal patch
#      (just the drifted DesiredCount) used to drop VolumeConfigurations and
#      UpdateService hard-failed with "Task definition has configuredAtLaunch
#      volume but no volume configuration provided at runtime" (cdkd #812). The
#      revert now re-includes declared write-only props.
#
# Flow: deploy -> check (Service READ, not skipped) -> drift DesiredCount 0->1 out
# of band -> check DETECTS the declared drift -> revert --yes SUCCEEDS (no volume
# hard-fail) -> DesiredCount back to 0 + clean -> destroy. desiredCount 0 → no task
# launches → fast. Self-cleaning trap.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegEcsWriteonly
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

CLUSTER="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECS::Cluster'].PhysicalResourceId" --output text)"
SERVICE="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECS::Service'].PhysicalResourceId" --output text)"
[ -n "$CLUSTER" ] && [ -n "$SERVICE" ] || fail "could not resolve cluster/service"

echo "=== check: ECS Service is READ (composite identifier), not skipped ==="
$CLI check "$STACK" --region "$REGION" --json > /tmp/cdkrd-ecs-clean.json 2>/tmp/cdkrd-ecs-clean.err \
  || { cat /tmp/cdkrd-ecs-clean.err; fail "check errored"; }
node -e '
  const j = require("/tmp/cdkrd-ecs-clean.json");
  const svc = (j.findings||[]).filter(f => f.resourceType === "AWS::ECS::Service");
  if (svc.some(f => f.tier === "skipped")) { console.error("ECS Service was SKIPPED — adapter not applied"); process.exit(1); }
  if (svc.some(f => f.tier === "declared")) { console.error("unexpected declared drift pre-mutation:\n"+JSON.stringify(svc,null,2)); process.exit(1); }
  console.log("ECS Service read, no false declared drift ✓");
' || fail "ECS Service not readable / false drift"

echo "=== drift: DesiredCount 0 -> 1 out of band ==="
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 \
  --region "$REGION" >/dev/null || fail "update-service drift"
sleep 4

echo "=== check DETECTS the DesiredCount declared drift ==="
$CLI check "$STACK" --region "$REGION" --json > /tmp/cdkrd-ecs-drift.json 2>/dev/null
node -e '
  const j = require("/tmp/cdkrd-ecs-drift.json");
  const hit = (j.findings||[]).some(f => f.resourceType === "AWS::ECS::Service" && f.tier === "declared" && String(f.path).includes("DesiredCount"));
  if (!hit) { console.error("DesiredCount drift NOT detected"); process.exit(1); }
  console.log("DesiredCount drift detected ✓");
' || fail "DesiredCount drift not detected"

echo "=== revert --yes: SUCCEEDS (write-only VolumeConfigurations re-included) ==="
$CLI revert "$STACK" --region "$REGION" --yes > /tmp/cdkrd-ecs-revert.out 2>&1
grep -q "reverted: " /tmp/cdkrd-ecs-revert.out || { cat /tmp/cdkrd-ecs-revert.out; fail "revert did not report success"; }
if grep -qi "configuredAtLaunch volume but no volume configuration" /tmp/cdkrd-ecs-revert.out; then
  cat /tmp/cdkrd-ecs-revert.out; fail "revert hit the write-only VolumeConfigurations drop (the bug this fixes)"
fi
echo "revert succeeded ✓"

echo "=== confirm DesiredCount back to 0 ==="
sleep 3
DC="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].desiredCount' --output text)"
[ "$DC" = "0" ] || fail "DesiredCount is $DC, expected 0 after revert"
echo "DesiredCount reverted to 0 ✓"

echo "INTEG PASS"
