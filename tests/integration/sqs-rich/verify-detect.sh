#!/usr/bin/env bash
# SQS detect + revert integration test (real AWS): the "someone changed the queue
# settings in the console" scenario. Deploy -> record -> change the DECLARED
# MUTABLE VisibilityTimeout (60->120) out of band -> check MUST DETECT (exit 1)
# -> revert -> check MUST be CLEAN and the live value restored to 60.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSqsRich
QNAME=cdkrd-sqs-rich
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

QURL="$(aws sqs get-queue-url --queue-name "$QNAME" --region "$REGION" --query QueueUrl --output text)"
[ -n "$QURL" ] || fail "could not resolve queue url"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: VisibilityTimeout 60->120 (console-edit) ==="
aws sqs set-queue-attributes --queue-url "$QURL" --attributes VisibilityTimeout=120 \
  --region "$REGION" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sqs-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "VisibilityTimeout" /tmp/cdkrd-sqs-detect.out || fail "VisibilityTimeout not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

echo "=== live VisibilityTimeout MUST be restored to 60 ==="
GOT="$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names VisibilityTimeout \
  --region "$REGION" --query "Attributes.VisibilityTimeout" --output text)"
[ "$GOT" = "60" ] || fail "live VisibilityTimeout not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
