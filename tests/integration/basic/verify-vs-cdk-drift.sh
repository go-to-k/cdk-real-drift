#!/usr/bin/env bash
# cdkrd vs `cdk drift` comparison test (real AWS). Proves the README comparison
# table empirically, in both directions:
#   1. an UNDECLARED change (transfer acceleration; not in the template) is
#      INVISIBLE to `cdk drift` / CloudFormation drift detection but DETECTED
#      by cdkrd — the differentiator;
#   2. a DECLARED change (versioning suspended) is detected by BOTH — cdkrd is
#      a superset, not a sidegrade.
# If `cdk drift` ever starts seeing the undeclared change, this test FAILS —
# that is the signal to re-verify the README capability-table claims.
# Reuses the `basic` fixture/stack (run the basic scripts and this one
# sequentially, never concurrently). Needs aws-cdk new enough to have `cdk
# drift` (fixture pins ^2.0.0 -> latest v2). Drift detection takes ~30-60s.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkdriftIntegBasic
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL: $*"; exit 1; }

npx cdk drift --help >/dev/null 2>&1 || fail "this aws-cdk has no 'cdk drift' — update the fixture's aws-cdk"

echo "=== build ==="; (cd "$ROOT" && vp run build) || fail build
echo "=== deploy ==="; npx cdk deploy -f "$STACK" --require-approval never || fail deploy

BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "no bucket physical id"

# Undeclared DRIFT is defined against an recorded baseline (R60/R62): without
# one, an injected value is UNRECORDED — reported, but exit 0 even with --fail.
# The first live run (R70) failed exactly here; the script predated R60.
echo "=== record (snapshot-complete baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail record

echo "=== inject UNDECLARED drift (enable transfer acceleration) ==="
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" \
  --accelerate-configuration Status=Enabled --region "$REGION" || fail "inject accel"
sleep 5

echo "=== cdk drift must NOT see the undeclared change ==="
npx cdk drift "$STACK" --fail 2>&1 | tee /tmp/cdkrd-vs-drift-1.out
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "cdk drift detected the undeclared change — capability changed? Re-verify the README comparison table"

echo "=== cdkrd MUST see it ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-vs-drift-2.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "cdkrd missed the undeclared change"
grep -q "AccelerateConfiguration" /tmp/cdkrd-vs-drift-2.out || fail "AccelerateConfiguration not reported"

echo "=== inject DECLARED drift (suspend versioning) ==="
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Suspended --region "$REGION" || fail "inject versioning"
sleep 5

echo "=== declared parity: cdk drift sees it ... ==="
npx cdk drift "$STACK" --fail 2>&1 | tee /tmp/cdkrd-vs-drift-3.out
[ "${PIPESTATUS[0]}" -ne 0 ] || fail "cdk drift missed the declared change (expected --fail exit != 0)"

echo "=== ... and cdkrd sees BOTH ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-vs-drift-4.out
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "cdkrd expected drift exit 1"
grep -q "VersioningConfiguration" /tmp/cdkrd-vs-drift-4.out || fail "declared versioning drift not reported"
grep -q "AccelerateConfiguration" /tmp/cdkrd-vs-drift-4.out || fail "undeclared accel drift not reported"

echo "INTEG PASS (cdkrd superset of cdk drift confirmed: declared parity + undeclared exclusive)"
