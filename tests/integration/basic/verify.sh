#!/usr/bin/env bash
# cdk-real-drift basic integration test (real AWS).
#   deploy fixture -> accept (baseline) -> check CLEAN -> inject undeclared drift
#   -> check DETECTS it -> destroy. A cleanup trap destroys + removes the baseline
#   even on failure, so a failed run leaves no orphan resources.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/basic && npm install && bash verify.sh
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

echo "=== accept (write baseline) ==="
$CLI accept "$STACK" --region "$REGION" --yes --no-interactive || fail "accept"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --no-interactive
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after accept"

echo "=== inject undeclared drift (enable transfer acceleration) ==="
BUCKET="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)"
[ -n "$BUCKET" ] || fail "could not resolve bucket physical id"
aws s3api put-bucket-accelerate-configuration --bucket "$BUCKET" \
  --accelerate-configuration Status=Enabled --region "$REGION" || fail "inject drift"

echo "=== check should DETECT the undeclared drift ==="
$CLI check "$STACK" --region "$REGION" --no-interactive | tee /tmp/cdk-real-drift-integ.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "AccelerateConfiguration" /tmp/cdk-real-drift-integ.out || fail "AccelerateConfiguration not reported"

echo "INTEG PASS"
