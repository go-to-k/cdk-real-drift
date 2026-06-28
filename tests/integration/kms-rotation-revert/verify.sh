#!/usr/bin/env bash
# Revert-gap integration test (real AWS): deploy -> record -> mutate a declared
# MUTABLE prop (EnableKeyRotation) out of band -> check MUST detect -> revert MUST
# restore the live value -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegKmsRotationRevert
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

KEYID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::KMS::Key'].PhysicalResourceId" --output text)
[ -n "$KEYID" ] || fail "no key id"
echo "key=$KEYID"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate out of band: disable key rotation ==="
aws kms disable-key-rotation --key-id "$KEYID" --region "$REGION" || fail "disable-key-rotation"

echo "=== [$STACK] check MUST detect ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "expected detection (exit !=0), got CLEAN — FALSE NEGATIVE"

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] live rotation status after revert ==="
ROT=$(aws kms get-key-rotation-status --key-id "$KEYID" --region "$REGION" --query 'KeyRotationEnabled' --output text)
echo "KeyRotationEnabled=$ROT"
[ "$ROT" = "True" ] || fail "REVERT-GAP: rotation still disabled after revert (CC UpdateResource no-op)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"
