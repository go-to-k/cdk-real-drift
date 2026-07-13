#!/usr/bin/env bash
# #1580 revert-convergence regression (real AWS): ECR Repository ImageTagMutability.
# The barest repo leaves ImageTagMutability undeclared (folds atDefault=MUTABLE).
# Flip it to IMMUTABLE out of band -> check MUST DETECT (exit 1) -> revert MUST
# CONVERGE the live value back to MUTABLE (before the fix, revert planned a bare
# `remove` that ECR's partial-update CC handler IGNORED, leaving IMMUTABLE and
# never converging). Sequence needs a `record` between the clean check and the
# out-of-band mutation, else the drift only surfaces as [Potential Drift] and
# `check --fail` still exits 0.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntEcho0714
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

REPO="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::ECR::Repository'].PhysicalResourceId" --output text)"
[ -n "$REPO" ] || fail "could not resolve ECR repository physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: ImageTagMutability MUTABLE->IMMUTABLE (console-edit) ==="
aws ecr put-image-tag-mutability --repository-name "$REPO" --region "$REGION" \
  --image-tag-mutability IMMUTABLE >/dev/null || fail "inject drift"

echo "=== check MUST DETECT undeclared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-echo-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "ImageTagMutability" /tmp/cdkrd-echo-detect.out || fail "ImageTagMutability not reported"

echo "=== revert (write MUTABLE default back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert (convergence) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert — revert did not converge"

echo "=== live ImageTagMutability MUST be restored to MUTABLE ==="
GOT="$(aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" \
  --query 'repositories[0].imageTagMutability' --output text)"
[ "$GOT" = "MUTABLE" ] || fail "live ImageTagMutability not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert, #1580)"
