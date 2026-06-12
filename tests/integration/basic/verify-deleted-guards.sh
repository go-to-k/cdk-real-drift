#!/usr/bin/env bash
# cdk-real-drift DELETED-tier + REVERT-GUARD integration test (real AWS).
# Reuses the basic fixture's single versioned S3 bucket. Covers two paths the
# `basic` / `revert` verify.sh do not:
#   R2  revert guard: on a stack with NO baseline, undeclared drift is reported
#       as NOT revertable (refuses a destructive bulk removal) unless
#       --remove-unaccepted is passed; declared drift IS revertable regardless.
#   R1  deleted tier: a resource deleted out of band is reported in the `deleted`
#       tier (exit 1 regardless of --fail-on) and is NOT revertable (recreate via
#       cdk deploy).
# Self-cleaning trap destroys the stack + removes the baseline even on failure.
#
# Usage:  cd tests/integration/basic && npm install && bash verify-deleted-guards.sh
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

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "could not resolve bucket physical id"
echo "bucket=$BUCKET"

# -------- R2: revert guard on a stack with NO baseline --------
# Inject BOTH a declared drift (suspend versioning, template says Enabled) and an
# undeclared drift (enable transfer acceleration). Do NOT `accept` -> no baseline.
echo "=== R2: inject declared + undeclared drift, NO baseline ==="
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Suspended --region "$REGION" || fail "inject versioning"
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" \
  --accelerate-configuration Status=Enabled --region "$REGION" || fail "inject accel"
sleep 5

echo "=== R2: revert --dry-run refuses the unaccepted undeclared value ==="
$CLI revert "$STACK" --region "$REGION" --dry-run --verbose | tee /tmp/cdkrd-guard-noremove.out
grep -q "NOT revertable" /tmp/cdkrd-guard-noremove.out || fail "R2: expected a NOT revertable section"
grep -q "AccelerateConfiguration.*no baseline" /tmp/cdkrd-guard-noremove.out \
  || fail "R2: undeclared accel should be not-revertable (no baseline)"
# declared versioning drift IS revertable even without a baseline (template is its source)
grep -q "VersioningConfiguration" /tmp/cdkrd-guard-noremove.out \
  || fail "R2: declared versioning drift should be in the plan"

echo "=== R2: --remove-unaccepted opts in to removing the undeclared value ==="
$CLI revert "$STACK" --region "$REGION" --dry-run --remove-unaccepted | tee /tmp/cdkrd-guard-remove.out
grep -qE "would apply [1-9][0-9]* op" /tmp/cdkrd-guard-remove.out \
  || fail "R2: --remove-unaccepted should plan op(s) including the undeclared removal"

# -------- R1: deleted tier --------
echo "=== R1: delete the bucket out of band ==="
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" || fail "delete-bucket"
sleep 5

echo "=== R1: check reports the deleted tier + exit 1 ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-guard-deleted.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "R1: expected exit 1 on a deleted resource, got $rc"
grep -qi "resource deleted out of band" /tmp/cdkrd-guard-deleted.out \
  || fail "R1: deleted tier header not reported"

echo "=== R1: deleted tier is NOT revertable (recreate via cdk deploy) ==="
$CLI revert "$STACK" --region "$REGION" --dry-run | tee /tmp/cdkrd-guard-deleted-revert.out
grep -q "deleted — recreate via cdk deploy" /tmp/cdkrd-guard-deleted-revert.out \
  || fail "R1: deleted resource should be not-revertable with the recreate reason"

echo "INTEG PASS"
