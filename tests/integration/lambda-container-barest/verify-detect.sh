#!/usr/bin/env bash
# Detection (FN) + revert integration test for the container-image Lambda. MemorySize is
# a declared MUTABLE property; mutate it out of band → check must DETECT (exit 1) →
# revert restores it → check CLEAN. Assumes verify.sh already deployed the stack in this
# run (reuses cdk.out + CDKRD_HUNT_IMAGE_URI).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntLambdaImg0713
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
fail() { echo "DETECT FAIL ($STACK): $*"; exit 1; }

# The barest function declares no MemorySize, so it deploys at the AWS default (128) and
# folds to atDefault on a first check. `record` snapshots that undeclared 128 into the
# baseline; mutating it out of band then re-surfaces as a recorded-undeclared drift
# (record KEEPS watching), which revert restores to the recorded 128.
FN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN" ] || fail "could not resolve function name"

echo "=== [$STACK] record clean baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after record"

echo "=== [$STACK] mutate MemorySize out of band (128 -> 512) ==="
aws lambda update-function-configuration --function-name "$FN" --memory-size 512 --region "$REGION" >/dev/null || fail "update-function-configuration"
aws lambda wait function-updated --function-name "$FN" --region "$REGION" || true

echo "=== [$STACK] check MUST DETECT the MemorySize change (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "check did NOT detect the MemorySize mutation (FN)"

echo "=== [$STACK] revert MUST restore MemorySize ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK-revert.out" || fail "revert"
aws lambda wait function-updated --function-name "$FN" --region "$REGION" || true

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"
LIVE_MEM="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" --query MemorySize --output text)"
[ "$LIVE_MEM" = "128" ] || fail "live MemorySize is $LIVE_MEM, expected 128 after revert"
echo "DETECT PASS ($STACK)"
