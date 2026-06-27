#!/usr/bin/env bash
# cdk-real-drift IAM sibling-policy-DOCUMENT integration test (real AWS).
#
# Finding 1: a role's by-name filter drops the sibling AWS::IAM::Policy entry from
# the role's live Policies (so it is not double-reported as undeclared on the role).
# The open question was whether an out-of-band edit to the SIBLING's OWN document is
# then a false-negative — i.e. does the AWS::IAM::Policy resource's OWN declared check
# still catch it? This proves it does, end-to-end:
#
#   deploy fixture (role + sibling DefaultPolicy) -> record -> check CLEAN
#   -> put-role-policy ON THE SIBLING's name with a CHANGED document
#   -> check DETECTS it as DECLARED drift on the AWS::IAM::Policy resource
#      (NOT swallowed by the role's by-name filter)
#   -> revert --yes restores the declared document -> check CLEAN
#
# The fixture is the same app.ts the other IAM scripts use (TestRole + its CDK
# DefaultPolicy, which carries an explicit PolicyName + Roles ref, so readIamPolicy
# resolves the live document via GetRolePolicy).
#
# A cleanup trap destroys the stack + removes the baseline even on failure.
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/iam && npm install && bash verify-sibling-policy-doc.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIam
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
OUT=/tmp/cdk-real-drift-integ-iam-sibling-doc.out

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
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

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (sibling filtered on the role, document matches) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

echo "=== modify the SIBLING's OWN document out of band (the Finding 1 scenario) ==="
# s3:ListAllMyBuckets (declared) -> s3:GetObject (out-of-band) on the SAME inline name
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$DEFAULT_POLICY" \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}' \
  || fail "modify sibling document"

echo "=== check must DETECT it as DECLARED drift on the AWS::IAM::Policy resource ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "FALSE NEGATIVE — sibling document change not detected (exit $rc, expected 1)"
grep -q "CFn-Declared Drift" "$OUT" || fail "not reported in the DECLARED tier — the sibling's own check did not fire"
grep -q "DefaultPolicy" "$OUT" || fail "the sibling AWS::IAM::Policy resource is not named in the finding"
grep -q "s3:GetObject" "$OUT" || fail "the out-of-band action is not shown as the live value"
# the role itself must NOT double-report this as undeclared (the by-name filter holds)
grep -q "CFn-Undeclared Drift" "$OUT" && fail "the role leaked the sibling change as undeclared drift (filter broke)"
echo "OK: sibling document change caught as DECLARED drift, not swallowed, not double-reported"

echo "=== revert should restore the declared document ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$DEFAULT_POLICY" \
  --query 'PolicyDocument.Statement[0].Action' --output text | grep -q "s3:ListAllMyBuckets" \
  || fail "revert did not restore the declared document"

echo "=== check should be CLEAN again ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "INTEG PASS"
