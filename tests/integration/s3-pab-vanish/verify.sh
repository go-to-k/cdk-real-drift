#!/usr/bin/env bash
# #1637 vanished-observed-default integration test (real AWS): deploy a barest bucket ->
# record (persists the PublicAccessBlockConfiguration observation) -> out-of-band
# `delete-public-access-block` (the whole value VANISHES from the Cloud Control read —
# pre-#1637 this was structurally invisible) -> check MUST detect (exit 1) -> revert
# MUST restore the all-true default -> final check CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdVerify1637PabVanish
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] first check MUST be CLEAN, then record ==="
$CLI check "$STACK" --region "$REGION" | tee /tmp/cdkrd-1637-first.out
grep -q "Potential Drift" /tmp/cdkrd-1637-first.out && fail "first-run FP on a fresh bucket"
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
grep -q '"observedDefaults"' .cdkrd/baselines/"$STACK".*.json || fail "record did not persist the PAB observation"

echo "=== [$STACK] out-of-band delete-public-access-block ==="
BUCKET=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text)
aws s3api delete-public-access-block --bucket "$BUCKET" --region "$REGION" || fail "delete-public-access-block"

echo "=== [$STACK] check MUST detect the vanished default (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-1637-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc — the deletion is invisible"
grep -q "observed default deleted since record" /tmp/cdkrd-1637-detect.out || fail "vanish note missing"

echo "=== [$STACK] revert MUST restore the all-true default ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
[ "$(aws s3api get-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --query PublicAccessBlockConfiguration.BlockPublicAcls --output text)" = "True" ] || fail "PAB not restored"

echo "=== [$STACK] final check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"

echo "INTEG PASS ($STACK)"
