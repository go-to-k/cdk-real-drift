#!/usr/bin/env bash
# cdk-real-drift #1958 integration test (real AWS): an out-of-band Lambda code swap made
# AFTER a legit CloudFormation code redeploy must still be detected.
#   deploy v1 -> record -> check CLEAN
#   -> deploy v2 (legit code redeploy, new asset key) -> check CLEAN (#1606 void, verified
#      against the deployed S3 asset: no "could not verify" note)
#   -> update-function-code v3 out of band -> check DETECTS CodeSha256 (exit 1)
# A cleanup trap destroys the stack and removes the baseline even on failure.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/lambda-code-swap-1958 && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdInteg1958LambdaSwap
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT="$(mktemp -d)"

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out "$OUT"
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy v1 ==="
CODE_VERSION=v1 npx cdk deploy -f "$STACK" --require-approval never || fail "deploy v1"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
grep -q recordedSourceFingerprints .cdkrd/baselines/*.json || fail "baseline has no source fingerprint"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN right after record"

echo "=== deploy v2 (legit code redeploy) ==="
CODE_VERSION=v2 npx cdk deploy -f "$STACK" --require-approval never || fail "deploy v2"

echo "=== check should be CLEAN, verified against the deployed asset ==="
$CLI check "$STACK" --region "$REGION" --fail >"$OUT/v2.out" 2>&1
rc=$?
cat "$OUT/v2.out"
[ $rc -eq 0 ] || fail "expected CLEAN after a legit code redeploy (rc=$rc)"
grep -q "redeployed via CloudFormation since record" "$OUT/v2.out" || fail "missing re-record nudge"
if grep -q "could not verify" "$OUT/v2.out"; then fail "asset hash was not verified"; fi

echo "=== swap the code out of band ==="
FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve function physical id"
mkdir -p "$OUT/v3"
echo 'exports.handler = async () => ({ statusCode: 200, body: "swapped" });' >"$OUT/v3/index.js"
(cd "$OUT/v3" && zip -q ../v3.zip index.js) || fail "zip"
aws lambda update-function-code --function-name "$FN_NAME" --zip-file "fileb://$OUT/v3.zip" \
  --region "$REGION" >/dev/null || fail "update-function-code"
aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION" || true

echo "=== check should DETECT the swap ==="
$CLI check "$STACK" --region "$REGION" --fail >"$OUT/v3.out" 2>&1
rc=$?
cat "$OUT/v3.out"
[ $rc -eq 1 ] || fail "expected drift (exit 1) after an out-of-band code swap (rc=$rc)"
grep -q "CodeSha256" "$OUT/v3.out" || fail "CodeSha256 not reported"

echo "INTEG PASS"
