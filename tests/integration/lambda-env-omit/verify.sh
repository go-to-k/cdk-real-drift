#!/usr/bin/env bash
# Regression integration test (real AWS) for the OMITTED_WHEN_EMPTY_PATHS fix on
# Lambda Environment: Cloud Control OMITS Environment once the env vars are cleared,
# so declared env vars wiped out of band used to classify as a readGap -> CLEAN ->
# SILENT FALSE NEGATIVE.
# deploy -> record -> clear env vars -> check MUST detect -> revert MUST re-apply them
# -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLambdaEnvOmit
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

FN=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
[ -n "$FN" ] || fail "no function"
echo "fn=$FN"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] clear env vars out of band (CC will omit Environment) ==="
aws lambda update-function-configuration --function-name "$FN" --environment '{"Variables":{}}' \
  --region "$REGION" >/dev/null || fail "clear-env"
sleep 5

echo "=== [$STACK] check MUST detect (regression: was a readGap FN) ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: cleared env vars not detected (got CLEAN)"

echo "=== [$STACK] revert (must re-apply Environment via top-level add) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"
sleep 5

echo "=== [$STACK] live env after revert ==="
V=$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query 'Environment.Variables.FOO' --output text)
[ "$V" = "bar" ] || fail "revert did not restore env vars (FOO=$V)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"
