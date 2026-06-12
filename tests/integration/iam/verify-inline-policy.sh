#!/usr/bin/env bash
# cdk-real-drift IAM inline-policy integration test (real AWS).
#
# Reproduces the sibling-DefaultPolicy blind spot end-to-end: the fixture role
# carries a CDK-generated sibling AWS::IAM::Policy (addToPolicy -> DefaultPolicy),
# whose entry in the role's live Policies must be FILTERED (no false positive),
# while an inline policy added out-of-band NEXT TO it must be DETECTED as
# undeclared drift and REVERTED per-name — deleting only the rogue policy and
# leaving the DefaultPolicy untouched.
#
#   deploy fixture -> accept (baseline) -> check CLEAN (sibling filtered)
#   -> put-role-policy (rogue inline policy) -> check DETECTS Policies drift
#   -> revert --yes -> rogue policy GONE, DefaultPolicy INTACT -> check CLEAN
#
# A cleanup trap destroys the stack + removes the baseline even on failure.
# Requires: AWS credentials, a bootstrapped account (CDKToolkit), Docker NOT needed.
# Usage:  cd tests/integration/iam && npm install && bash verify-inline-policy.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIam
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ROGUE=CdkrdRogueInlinePolicy

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (role + sibling DefaultPolicy) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ROLE_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId" --output text)"
[ -n "$ROLE_NAME" ] || fail "could not resolve role physical id"
DEFAULT_POLICY="$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames[0]' --output text)"
[ -n "$DEFAULT_POLICY" ] && [ "$DEFAULT_POLICY" != "None" ] || fail "fixture has no sibling DefaultPolicy"
echo "role=$ROLE_NAME defaultPolicy=$DEFAULT_POLICY"

echo "=== accept (write baseline) ==="
$CLI accept "$STACK" --region "$REGION" --yes --no-interactive || fail "accept"

echo "=== check should be CLEAN (sibling DefaultPolicy filtered, no false positive) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after accept — sibling DefaultPolicy leaked as drift?"

echo "=== inject undeclared drift (out-of-band inline policy next to the sibling) ==="
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$ROGUE" \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:ListQueues","Resource":"*"}]}' \
  || fail "inject drift"

echo "=== check should DETECT the rogue inline policy (and ONLY it) ==="
OUT=/tmp/cdk-real-drift-integ-iam-inline.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Policies" "$OUT" || fail "Policies drift not reported"
grep -q "$ROGUE" "$OUT" || fail "rogue policy name not in the reported value"
grep -q "$DEFAULT_POLICY" "$OUT" && fail "sibling DefaultPolicy leaked into the finding"

echo "=== revert should delete ONLY the rogue policy ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

POLICIES="$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames' --output text)"
echo "post-revert inline policies: $POLICIES"
echo "$POLICIES" | grep -q "$ROGUE" && fail "rogue policy still attached after revert"
echo "$POLICIES" | grep -q "$DEFAULT_POLICY" || fail "revert wiped the sibling DefaultPolicy"
aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$DEFAULT_POLICY" \
  --query 'PolicyDocument.Statement[0].Action' --output text | grep -q "s3:ListAllMyBuckets" \
  || fail "sibling DefaultPolicy document changed"

echo "=== check should be CLEAN again ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "INTEG PASS"
