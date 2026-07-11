#!/usr/bin/env bash
# Detection (false-negative) integration test (real AWS):
# deploy -> record -> check CLEAN -> mutate out of band (declared SQS
# VisibilityTimeout + undeclared DMS SslMode) -> check MUST detect BOTH ->
# revert the SQS drift -> restore the DMS SslMode manually (no SDK writer) ->
# check MUST be CLEAN again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegFnRevertMin
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

echo "=== [$STACK] pre-mutation check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN before mutation"

QUEUE_URL=$(aws sqs list-queues --region "$REGION" --query 'QueueUrls' --output text | tr '\t' '\n' | grep -i "$STACK" | head -1)
[ -n "$QUEUE_URL" ] || fail "queue url not found"
DMS_ARN=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::DMS::Endpoint'].PhysicalResourceId" --output text)
[ -n "$DMS_ARN" ] || fail "dms endpoint arn not found"

echo "=== [$STACK] mutate OUT OF BAND (VisibilityTimeout 45->120, SslMode none->require) ==="
aws sqs set-queue-attributes --region "$REGION" --queue-url "$QUEUE_URL" \
  --attributes VisibilityTimeout=120 || fail "sqs mutate"
aws dms modify-endpoint --region "$REGION" --endpoint-arn "$DMS_ARN" --ssl-mode require >/dev/null || fail "dms mutate"
sleep 10

echo "=== [$STACK] check MUST detect BOTH drifts (exit 1) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.detect.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift (exit 1), got $rc"
grep -q "VisibilityTimeout" "/tmp/cdkrd-$STACK.detect.out" || fail "SQS VisibilityTimeout drift NOT detected (FN)"
grep -q "SslMode" "/tmp/cdkrd-$STACK.detect.out" || fail "DMS SslMode drift NOT re-surfaced (FN — equality gate broken)"

echo "=== [$STACK] revert the SQS declared drift ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK.revert.out" || fail "revert"

echo "=== [$STACK] restore DMS SslMode manually (type has no SDK writer) ==="
aws dms modify-endpoint --region "$REGION" --endpoint-arn "$DMS_ARN" --ssl-mode none >/dev/null || fail "dms restore"
sleep 10

echo "=== [$STACK] final check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert/restore"

VT=$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$QUEUE_URL" \
  --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text)
[ "$VT" = "45" ] || fail "live VisibilityTimeout not restored (got $VT)"

echo "INTEG PASS ($STACK)"
