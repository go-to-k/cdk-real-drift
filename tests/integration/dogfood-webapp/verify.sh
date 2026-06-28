#!/usr/bin/env bash
# DOGFOOD false-positive integration test (real AWS): a realistic multi-resource
# web-app + async-worker stack (ALB + ECS Fargate service/task + CloudWatch logs +
# IAM roles/policies + security groups + DynamoDB + SQS + a Lambda consumer + S3 +
# a Secret), wired with grants the way a real CDK user writes them. Unlike the
# single-type fixtures this exercises the INTERACTION of ~28 resource types with
# their real defaults. A clean `record` -> `check` MUST be CLEAN; any declared drift
# is a normalization / default-folding FP from a real property combination.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDogfoodWebapp
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

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN (no interaction FP) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"
