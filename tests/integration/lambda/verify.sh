#!/usr/bin/env bash
# cdk-real-drift Lambda integration test (real AWS).
#   deploy fixture -> record (baseline) -> check CLEAN -> inject undeclared drift
#   (set a Timeout the CDK stack never declared) -> check DETECTS it -> destroy.
#   A cleanup trap destroys + removes the baseline even on failure, so a failed run
#   leaves no orphan resources.
#
# Timeout (an undeclared scalar always in Cloud Control's Lambda model) is the
# injected drift instead of ReservedConcurrentExecutions: reserving concurrency needs
# the account's unreserved pool to stay >= its floor (10), so on an account at the
# default concurrency limit the injection erred BEFORE cdkrd ran. Timeout has no such
# account-quota dependency. If Timeout is ever declared in app.ts, switch to another
# undeclared scalar (e.g. MemorySize) or a custom tag.
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
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== inject undeclared drift (set a Timeout the template never declared) ==="
FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function physical id"
aws lambda update-function-configuration \
  --function-name "$FN_NAME" \
  --timeout 15 \
  --region "$REGION" || fail "inject drift"
# update-function-configuration is async; wait until the change is settled so the
# subsequent read sees Timeout=15 (not a transient in-progress value).
aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true

echo "=== check should DETECT the undeclared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdk-real-drift-integ-lambda.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Timeout" /tmp/cdk-real-drift-integ-lambda.out || fail "Timeout not reported"

echo "INTEG PASS"
