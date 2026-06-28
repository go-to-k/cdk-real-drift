#!/usr/bin/env bash
# Regression integration test (real AWS) for the OMITTED_WHEN_EMPTY_PATHS fix on S3
# object-valued sub-configs: Cloud Control OMITS CorsConfiguration /
# LifecycleConfiguration once removed, so a declared config deleted out of band used
# to classify as a readGap -> CLEAN -> SILENT FALSE NEGATIVE.
# deploy -> record -> delete cors + lifecycle -> check MUST detect (2 whole-property
# drifts) -> revert MUST re-apply them -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegS3ConfigOmit
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
echo "bucket=$BUCKET"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] remove cors + lifecycle out of band (CC will omit them) ==="
aws s3api delete-bucket-cors --bucket "$BUCKET" --region "$REGION" || fail "delete-cors"
aws s3api delete-bucket-lifecycle --bucket "$BUCKET" --region "$REGION" || fail "delete-lifecycle"

echo "=== [$STACK] check MUST detect (regression: was a readGap FN) ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: removed S3 configs not detected (got CLEAN)"

echo "=== [$STACK] revert (must re-apply both configs via top-level add) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] live configs after revert ==="
aws s3api get-bucket-cors --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 || fail "cors not restored"
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 || fail "lifecycle not restored"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"
