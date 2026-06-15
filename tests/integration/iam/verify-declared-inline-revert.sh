#!/usr/bin/env bash
# cdk-real-drift DECLARED inline-policy revert integration test (real AWS).
#
# Reproduces B1 end-to-end: a role that DECLARES an inline policy (template
# Properties.Policies non-empty) gets a rogue inline policy added out of band, which
# makes the live Policies a length-2 array vs the declared length-1 — a DECLARED
# whole-array drift. The fix gives the declared revert op a `prior` (the live value)
# so writeIamRoleInlinePolicies can DELETE the rogue entry; before the fix the
# declared op carried no `prior`, so revert re-PUT the declared policy but NEVER
# deleted the rogue one (a silent, security-relevant incomplete revert).
#
#   deploy fixture -> record -> check CLEAN
#   -> put-role-policy (rogue) -> check DETECTS declared Policies drift
#   -> revert --yes -> rogue GONE, DeclaredPolicy INTACT -> check CLEAN
#
# A cleanup trap destroys the stack + removes the baseline even on failure.
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/iam && npm install && bash verify-declared-inline-revert.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIamDeclared
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
ROGUE=CdkrdRogueInlinePolicy
DECLARED=DeclaredPolicy

cleanup() {
  echo "--- cleanup ---"
  npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture (role with a DECLARED inline policy) ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ROLE_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId" --output text)"
[ -n "$ROLE_NAME" ] || fail "could not resolve role physical id"
echo "role=$ROLE_NAME"

# sanity: the declared inline policy is live, and it is the ONLY inline policy
INITIAL="$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames' --output text)"
echo "initial inline policies: $INITIAL"
echo "$INITIAL" | grep -q "$DECLARED" || fail "fixture is missing its declared inline policy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (declared policy matches, no drift) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== inject DECLARED-side drift (rogue inline policy next to the declared one) ==="
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$ROGUE" \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:ListQueues","Resource":"*"}]}' \
  || fail "inject drift"

echo "=== check should DETECT a Policies drift naming the rogue ==="
OUT=/tmp/cdk-real-drift-integ-iam-declared.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "Policies" "$OUT" || fail "Policies drift not reported"
grep -q "$ROGUE" "$OUT" || fail "rogue policy name not in the reported value"

echo "=== revert should DELETE the rogue and KEEP the declared policy (the B1 fix) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

POLICIES="$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames' --output text)"
echo "post-revert inline policies: $POLICIES"
echo "$POLICIES" | grep -q "$ROGUE" && fail "rogue policy still attached after revert (B1: declared op had no prior)"
echo "$POLICIES" | grep -q "$DECLARED" || fail "revert wiped the DECLARED inline policy"
aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$DECLARED" \
  --query 'PolicyDocument.Statement[0].Action' --output text | grep -q "s3:ListAllMyBuckets" \
  || fail "declared inline policy document changed"

echo "=== check should be CLEAN again ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "INTEG PASS"
