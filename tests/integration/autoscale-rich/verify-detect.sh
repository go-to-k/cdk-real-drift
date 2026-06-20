#!/usr/bin/env bash
# Application Auto Scaling detect + revert integration test (real AWS): the
# "someone bumped the scaling ceiling in the console" scenario. Deploy -> record
# -> change a DECLARED MUTABLE prop (the read ScalableTarget MaxCapacity 50->100)
# out of band -> check MUST DETECT the declared drift (exit 1) -> revert -> check
# MUST be CLEAN and the live MaxCapacity MUST be restored to 50.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegAutoScaleRich
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

TABLE="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text)"
[ -n "$TABLE" ] || fail "could not resolve table physical id"
RES_ID="table/$TABLE"
DIM="dynamodb:table:ReadCapacityUnits"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: read MaxCapacity 50->100 (console-edit) ==="
aws application-autoscaling register-scalable-target --service-namespace dynamodb \
  --resource-id "$RES_ID" --scalable-dimension "$DIM" \
  --min-capacity 5 --max-capacity 100 --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-autoscale-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "MaxCapacity" /tmp/cdkrd-autoscale-detect.out || fail "MaxCapacity not reported"

echo "=== revert (write declared values back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live MaxCapacity MUST be restored to 50 ==="
GOT="$(aws application-autoscaling describe-scalable-targets --service-namespace dynamodb \
  --resource-ids "$RES_ID" --region "$REGION" \
  --query "ScalableTargets[?ScalableDimension=='$DIM'].MaxCapacity" --output text)"
[ "$GOT" = "50" ] || fail "live MaxCapacity not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
