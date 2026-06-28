#!/usr/bin/env bash
# ECS Service VolumeConfigurations writeOnly-read-gap integration test (real AWS).
#
# VolumeConfigurations (managed EBS volumes attached at deploy) is writeOnly — Cloud
# Control never echoes it (it lives on the service's deployments), so an out-of-band
# change to a volume's size/type was silently invisible. The SDK_SUPPLEMENTS reader
# reconstructs it from the PRIMARY deployment (PascalCased, AWS-defaulted FilesystemType
# "xfs" dropped). This test proves: clean record -> check is CLEAN (no FP), an out-of-band
# volume size change is DETECTED, and revert restores it via ecs:UpdateService.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEcsVolumeReadgap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
export CDK_DEFAULT_ACCOUNT="${CDK_DEFAULT_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}"
export CDK_DEFAULT_REGION="$REGION"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

CLUSTER=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECS::Cluster'].PhysicalResourceId | [0]" --output text)
SVC=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECS::Service'].PhysicalResourceId | [0]" --output text)
[ -n "$SVC" ] && [ "$SVC" != "None" ] || fail "could not resolve ECS service"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN (VolumeConfigurations reconstruction; FilesystemType folded) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.clean.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE on a clean stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "=== [$STACK] mutate the managed EBS volume size out of band (10 -> 20 GiB) ==="
CFG=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" --region "$REGION" \
  --query "services[0].deployments[?status=='PRIMARY'].volumeConfigurations | [0]" --output json)
echo "$CFG" | python3 -c "import sys,json; v=json.load(sys.stdin); v[0]['managedEBSVolume']['sizeInGiB']=20; print(json.dumps({'cluster':'$CLUSTER','service':'$SVC','volumeConfigurations':v}))" > /tmp/cdkrd-vol-upd.json
aws ecs update-service --cli-input-json file:///tmp/cdkrd-vol-upd.json --region "$REGION" >/dev/null || fail "update-service"
sleep 12

echo "=== [$STACK] check MUST DETECT the volume size drift (no false negative) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.drift.out"
rc=${PIPESTATUS[0]}
[ "$rc" -ne 0 ] || { echo "--- FALSE NEGATIVE: volume size change not detected ---"; fail "expected drift (exit 1), got $rc"; }
grep -qi "VolumeConfigurations" "/tmp/cdkrd-$STACK.drift.out" || fail "drift output does not mention VolumeConfigurations"

echo "=== [$STACK] revert (re-supplies the declared volume config via UpdateService) ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out"
grep -qi "reverted:" "/tmp/cdkrd-$STACK.revert.out" || fail "revert did not run the UpdateService writer"
grep -qi "CLEAN after revert" "/tmp/cdkrd-$STACK.revert.out" || fail "revert did not converge"
sleep 20

echo "=== [$STACK] check MUST be CLEAN again after revert ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.post.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert (exit 0), got $rc"

echo "INTEG PASS ($STACK)"
