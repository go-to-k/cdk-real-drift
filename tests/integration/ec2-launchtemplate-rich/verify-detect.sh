#!/usr/bin/env bash
# Detection (FN) integration test for the EC2 LaunchTemplate SDK override: deploy ->
# record (CLEAN) -> mutate the DEFAULT version out of band (publish a new version with
# a changed InstanceType and point $Default at it) -> `check` MUST detect the
# LaunchTemplateData.InstanceType drift. This proves the override actually READS the
# live LaunchTemplateData (without it the data is a readGap and the change is invisible).
# LaunchTemplate versions are immutable, so there is no SDK writer / revert; the change
# is undone by repointing the default version (and teardown deletes the stack anyway).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEc2LaunchTemplateRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
LT_NAME=cdkrd-integ-launchtemplate

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN before mutation"

echo "=== [$STACK] mutate: publish a new default version with InstanceType t3.small ==="
aws ec2 create-launch-template-version --region "$REGION" \
  --launch-template-name "$LT_NAME" --source-version 1 \
  --launch-template-data '{"InstanceType":"t3.small"}' >/dev/null || fail "create-version"
aws ec2 modify-launch-template --region "$REGION" \
  --launch-template-name "$LT_NAME" --default-version 2 >/dev/null || fail "modify-default"

echo "=== [$STACK] check MUST DETECT the InstanceType drift (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift detected (exit 1), got $rc"
grep -q "InstanceType" "/tmp/cdkrd-$STACK-detect.out" || fail "drift did not mention InstanceType"

echo "=== [$STACK] restore default version (no SDK writer for LaunchTemplate) ==="
aws ec2 modify-launch-template --region "$REGION" \
  --launch-template-name "$LT_NAME" --default-version 1 >/dev/null || true

echo "INTEG PASS ($STACK detection)"
