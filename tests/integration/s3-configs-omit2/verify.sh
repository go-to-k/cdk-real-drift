#!/usr/bin/env bash
# Regression integration test (real AWS) for "absent declared collection → drift by
# default". S3 OMITS every sub-config when removed; this fixture declares five of them
# (Website, OwnershipControls, Metrics, IntelligentTiering, Analytics) — NONE of which
# is in any per-type table — and proves they are ALL detected on removal and reverted.
# deploy -> record -> delete all 5 configs -> check MUST detect 5 -> revert -> CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegS3ConfigsOmit2
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"
BUCKET=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)
[ -n "$BUCKET" ] || fail "no bucket"

echo "=== [$STACK] record ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] remove all 5 sub-configs out of band (CC omits them) ==="
aws s3api delete-bucket-website --bucket "$BUCKET" --region "$REGION" || fail "rm website"
aws s3api delete-bucket-ownership-controls --bucket "$BUCKET" --region "$REGION" || fail "rm ownership"
aws s3api delete-bucket-metrics-configuration --bucket "$BUCKET" --id EntireBucket --region "$REGION" || fail "rm metrics"
aws s3api delete-bucket-intelligent-tiering-configuration --bucket "$BUCKET" --id archive --region "$REGION" || fail "rm tiering"
aws s3api delete-bucket-analytics-configuration --bucket "$BUCKET" --id a1 --region "$REGION" || fail "rm analytics"

echo "=== [$STACK] check MUST detect all 5 (regression: were silent readGap FNs) ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: removed S3 configs not detected (got CLEAN)"
N=$($CLI check "$STACK" --region "$REGION" 2>/dev/null | grep -cE "AWS::S3::Bucket")
[ "$N" -ge 5 ] || fail "expected >=5 declared S3 findings, got $N"

echo "=== [$STACK] revert all 5 ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"
