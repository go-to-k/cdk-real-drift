#!/usr/bin/env bash
# DOGFOOD false-positive integration test (real AWS): a realistic SERVERLESS API
# stack (REST API Gateway with Lambda-integrated methods behind a Cognito User Pools
# authorizer + a usage plan/API key, backed by DynamoDB + an SQS DLQ). Unlike the
# single-type fixtures this exercises the INTERACTION of the API Gateway child-resource
# family (RestApi/Resource/Method/Deployment/Stage/Authorizer/UsagePlan), Cognito,
# Lambda (incl. the apigw->lambda invoke Permissions), DynamoDB and the IAM grants.
# A clean `record` -> `check` MUST be CLEAN; any declared drift is a default-folding FP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegDogfoodServerlessApi
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
