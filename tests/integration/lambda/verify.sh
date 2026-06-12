#!/usr/bin/env bash
# cdk-real-drift Lambda integration test (real AWS).
#   deploy fixture -> accept (baseline) -> check CLEAN -> inject undeclared drift
#   (set reserved concurrent executions the CDK stack never declared)
#   -> check DETECTS it -> destroy. A cleanup trap destroys + removes the baseline
#   even on failure, so a failed run leaves no orphan resources.
#
# Note: if Cloud Control's Lambda model does not return ReservedConcurrentExecutions
# in its read-back, switch the injection below to a custom tag instead:
#   aws lambda tag-resource --resource "$FN_ARN" --tags DriftKey=DriftValue --region "$REGION"
# and assert on "Tags" rather than "ReservedConcurrentExecutions" in the grep.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/lambda && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLambda
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

echo "=== inject undeclared drift (set reserved concurrent executions) ==="
FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function physical id"
aws lambda put-function-concurrency \
  --function-name "$FN_NAME" \
  --reserved-concurrent-executions 1 \
  --region "$REGION" || fail "inject drift"

echo "=== check should DETECT the undeclared drift ==="
$CLI check "$STACK" --region "$REGION" --no-interactive | tee /tmp/cdk-real-drift-integ-lambda.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "ReservedConcurrentExecutions" /tmp/cdk-real-drift-integ-lambda.out || fail "ReservedConcurrentExecutions not reported"

echo "INTEG PASS"
