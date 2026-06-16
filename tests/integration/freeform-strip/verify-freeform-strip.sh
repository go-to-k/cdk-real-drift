#!/usr/bin/env bash
# cdk-real-drift free-form-map cc-api-strip FALSE-NEGATIVE integration test (real AWS).
#
# cc-api-strip removes AWS-managed field NAMES (LastModified, OwnerId, CreatedBy, …) at
# ANY depth. Inside a USER free-form map — a Lambda Environment.Variables, a Glue
# Parameter, a map-shaped Tag — a key with one of those names is the USER's data, so
# stripping it SILENTLY hid a real out-of-band change. The fix stops stripping inside
# free-form maps.
#
#   deploy (1 declared env var) -> record -> check CLEAN
#   -> add an out-of-band env var keyed `LastModified` (a managed-field name)
#   -> check DETECTS it  (before the fix: silently CLEAN — the false negative)
#
# A cleanup trap destroys the stack + removes the baseline even on failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegFreeform
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

echo "=== deploy fixture (Lambda with 1 declared env var) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function physical id"
echo "function=$FN_NAME"

echo "=== record + check should be CLEAN ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN right after record"

echo "=== inject out-of-band env var keyed LastModified (a managed-field NAME) ==="
aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
  --environment "Variables={APP_VERSION=x,LastModified=sneaky-out-of-band}" >/dev/null \
  || fail "inject env var"
# wait for the update to settle
aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true

echo "=== check MUST now DETECT the env var (previously stripped -> silent CLEAN) ==="
OUT=/tmp/cdk-real-drift-integ-freeform.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1 (the out-of-band env var must be detected, not stripped), got $rc"
grep -qi "LastModified" "$OUT" || fail "the LastModified env var was not reported — still stripped?"

echo "INTEG PASS"
