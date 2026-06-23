#!/usr/bin/env bash
# Lambda config-rich: harvest the live read into the golden corpus (fresh deploy,
# pre-record) THEN run the detect + revert false-negative test. Deploy -> harvest
# corpus -> record -> change a DECLARED MUTABLE prop (MemorySize) out of band ->
# check MUST DETECT (exit 1) -> revert -> check MUST be CLEAN -> live restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegLambdaConfigRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CORPUS_DIR="${CORPUS_DIR:-/tmp/corpus-lambda-config}"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

FN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN" ] || fail "could not resolve function physical id"

echo "=== harvest corpus (fresh, pre-record) -> $CORPUS_DIR ==="
rm -rf "$CORPUS_DIR"
CDKRD_CORPUS_DIR="$CORPUS_DIR" $CLI check "$STACK" --region "$REGION" || true

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: MemorySize 256->512 (console-edit) ==="
aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
  --memory-size 512 >/dev/null || fail "inject drift"
aws lambda wait function-updated --function-name "$FN" --region "$REGION"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-lambda-config-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "MemorySize" /tmp/cdkrd-lambda-config-detect.out || fail "MemorySize not reported"

echo "=== revert (write declared value back) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert"

GOT="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query "MemorySize" --output text)"
[ "$GOT" = "256" ] || fail "live MemorySize not restored (got: $GOT)"

echo "INTEG PASS ($STACK detect+revert)"
