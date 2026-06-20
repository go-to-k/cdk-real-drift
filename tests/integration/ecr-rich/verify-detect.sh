#!/usr/bin/env bash
# ECR detect + revert integration test (real AWS): the "someone changed it in the
# console" scenario. Deploy -> record -> flip ImageTagMutability IMMUTABLE->MUTABLE
# out of band (a declared, MUTABLE property) -> check MUST DETECT the declared drift
# (exit 1) -> revert -> check MUST be CLEAN and the live mutability MUST be back to
# IMMUTABLE. The tag-mutability flip is near-instant, so this is a fast, reliable
# detection oracle for a declared top-level enum property.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegEcrRich
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
[ -n "$REPO" ] || fail "could not resolve repository physical id"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: flip image tag mutability to MUTABLE (console-edit) ==="
aws ecr put-image-tag-mutability --repository-name "$REPO" --region "$REGION" \
  --image-tag-mutability MUTABLE >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-ecr-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -qi "ImageTagMutability" /tmp/cdkrd-ecr-detect.out || fail "ImageTagMutability drift not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live mutability MUST be back to IMMUTABLE ==="
GOT="$(aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" \
  --query "repositories[0].imageTagMutability" --output text)"
[ "$GOT" = "IMMUTABLE" ] || fail "live mutability not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
