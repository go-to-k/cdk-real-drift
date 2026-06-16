#!/usr/bin/env bash
# cdk-real-drift WRAPPED inline-policy STATEMENT sub-key integration test (real AWS).
#
# Proves WAVE20-F3: a live-only sub-key added out of band to a statement INSIDE a
# declared inline policy (`Properties.Policies[].PolicyDocument.Statement[]`) is
# detected. Before the fix the statement subset-descent (#151) only reached TOP-LEVEL
# policy documents (BucketPolicy / KMS key policy); the IAM Role `Policies[]` wrapper is
# identity-less and its elements aren't statements, so the descent never reached the
# wrapped statement — an out-of-band `Condition` narrowing/widening access was invisible.
#
#   deploy fixture (role with a DECLARED inline policy) -> record -> check CLEAN
#     (CLEAN here is the FP-safety proof: the new descent runs on the real declared
#      inline policy and must NOT emit a false undeclared)
#   -> put-role-policy: re-PUT the SAME declared statement + a live-only Condition
#   -> check DETECTS an undeclared Policies[...].PolicyDocument.Statement[...].Condition
#
# A cleanup trap destroys the stack + removes the baseline even on failure.
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/iam && npm install && bash verify-inline-statement-subkey.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegIamDeclared
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
DECLARED=DeclaredPolicy

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
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

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN (FP-safety: descent on the real declared inline policy) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record — new descent must not FP"

echo "=== inject a live-only Condition INTO the declared statement (out of band) ==="
# Same Effect/Action/Resource as the declared statement, PLUS a Condition the template
# never declared. This is NOT a whole-array change (still one inline policy, one
# statement) — only a sub-key was added, the exact class #151 covered for top-level docs.
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$DECLARED" \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListAllMyBuckets","Resource":"*","Condition":{"StringEquals":{"aws:PrincipalOrgID":"o-rogue"}}}]}' \
  || fail "inject Condition"

echo "=== check should DETECT the undeclared Condition sub-key ==="
OUT=/tmp/cdk-real-drift-integ-iam-subkey.out
$CLI check "$STACK" --region "$REGION" --fail | tee "$OUT"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc — the wrapped statement sub-key was invisible"
grep -q "Condition" "$OUT" || fail "the undeclared Condition was not reported"

echo "INTEG PASS"
