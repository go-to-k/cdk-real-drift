#!/usr/bin/env bash
# Regression integration test (real AWS) for the OMITTED_WHEN_EMPTY_PATHS fix on IAM
# inline Policies: Cloud Control OMITS `Policies` when a role has no inline policies,
# so deleting the only inline policy out of band (a security-relevant change) used to
# classify as a readGap -> CLEAN -> SILENT FALSE NEGATIVE.
# deploy -> record -> delete-role-policy -> check MUST detect -> revert MUST re-create
# it -> check MUST be CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIamInlinePolicyOmit
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

ROLE=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId" --output text)
[ -n "$ROLE" ] || fail "no role name"
echo "role=$ROLE"

echo "=== [$STACK] record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] delete the only inline policy out of band (CC will omit Policies) ==="
aws iam delete-role-policy --role-name "$ROLE" --policy-name cdkrd-inline-1 --region "$REGION" || fail "delete-role-policy"

echo "=== [$STACK] check MUST detect the removed policy (regression: was a readGap FN) ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -ne 0 ] || fail "FALSE NEGATIVE: removed inline policy not detected (got CLEAN)"

echo "=== [$STACK] revert (must re-create the inline policy) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert errored"

echo "=== [$STACK] live inline policies after revert ==="
P=$(aws iam list-role-policies --role-name "$ROLE" --region "$REGION" --query 'PolicyNames[0]' --output text)
[ "$P" = "cdkrd-inline-1" ] || fail "revert did not re-create the inline policy (got: $P)"

echo "=== [$STACK] check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail; rc=$?
[ "$rc" -eq 0 ] || fail "expected CLEAN after revert, got $rc"

echo "INTEG PASS ($STACK)"
