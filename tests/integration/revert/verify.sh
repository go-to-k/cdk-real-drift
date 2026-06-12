#!/usr/bin/env bash
# cdkrd REVERT integration test (real AWS, AWS-mutating).
#   deploy -> accept (baseline) -> check CLEAN
#   -> inject DECLARED drift (versioning) + UNDECLARED drift (transfer accel)
#   -> check DETECTS both -> revert --yes (Cloud Control UpdateResource)
#   -> check CLEAN -> destroy. Self-cleaning trap; no orphans on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegRevert
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "no bucket physical id"

# Enable acceleration BEFORE accept so the baseline records AccelerationStatus=Enabled.
# Revert of an undeclared CHANGE restores the baseline value (a reliable add op);
# reverting an undeclared ADDITION by removal is not always possible for toggle-style
# props (e.g. accel can't be "removed", only Suspended) — that is a documented limit.
echo "=== enable acceleration, then accept (baseline) ==="
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" --accelerate-configuration Status=Enabled --region "$REGION" || fail "enable accel"
sleep 5
$CLI accept "$STACK" --region "$REGION" --yes || fail accept
echo "=== check CLEAN ==="; $CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "expected CLEAN after accept"

echo "=== inject DECLARED drift (suspend versioning) + UNDECLARED drift (suspend accel from accepted Enabled) ==="
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Suspended --region "$REGION" || fail "inject versioning"
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" --accelerate-configuration Status=Suspended --region "$REGION" || fail "inject accel"
sleep 5

echo "=== check DETECTS drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-revert-pre.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1"
grep -q "VersioningConfiguration" /tmp/cdkrd-revert-pre.out || fail "declared versioning drift not reported"
grep -q "AccelerateConfiguration" /tmp/cdkrd-revert-pre.out || fail "undeclared accel drift not reported"

echo "=== revert --yes (writes to AWS via Cloud Control) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert returned non-zero"

echo "=== check CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; [ $? -eq 0 ] || fail "drift remains after revert"

# belt-and-suspenders: confirm AWS itself converged to the desired/baseline values
VSTATUS="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --region "$REGION" --query Status --output text)"
[ "$VSTATUS" = "Enabled" ] || fail "versioning not restored to template value (got $VSTATUS)"
ASTATUS="$(aws s3api get-bucket-accelerate-configuration --bucket "$BUCKET" --region "$REGION" --query Status --output text 2>/dev/null)"
[ "$ASTATUS" = "Enabled" ] || fail "acceleration not restored to baseline value (got $ASTATUS)"

echo "INTEG PASS"
