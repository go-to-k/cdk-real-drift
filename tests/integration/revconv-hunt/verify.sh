#!/usr/bin/env bash
# Revert-convergence probe (real AWS): deploy barest Lambda/SQS/KMS/ECR, first
# check MUST be CLEAN, record, mutate the four folded defaults out of band,
# check MUST detect all four, revert, then assert each LIVE value actually
# returned to its default (a silent revert no-op = REVERT_SET_DEFAULT_PATHS gap).
set -uo pipefail
export AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevConv0714
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() { echo "--- cleanup ($STACK) ---"; delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true; rm -rf .cdkrd cdk.out; }
trap cleanup EXIT
fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

FN=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id ConvFn0714 --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)
QURL=$(aws sqs get-queue-url --queue-name "$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id ConvQueue0714 --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text | awk -F/ '{print $NF}')" --region "$REGION" --query QueueUrl --output text)
KEYID=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id ConvKey0714 --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)
REPO=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id ConvRepo0714 --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)
echo "FN=$FN QURL=$QURL KEYID=$KEYID REPO=$REPO"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR=/tmp/corpus-revconv $CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check reported potential drift on a clean deploy (fold gap)"

echo "=== [$STACK] record ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] mutate all four folded defaults out of band ==="
aws lambda update-function-configuration --function-name "$FN" --tracing-config Mode=Active --region "$REGION" >/dev/null || fail "lambda mutate"
aws lambda wait function-updated --function-name "$FN" --region "$REGION" || true
aws sqs set-queue-attributes --queue-url "$QURL" --attributes DelaySeconds=30 --region "$REGION" || fail "sqs mutate"
aws kms disable-key --key-id "$KEYID" --region "$REGION" || fail "kms mutate"
aws ecr put-image-tag-mutability --repository-name "$REPO" --image-tag-mutability IMMUTABLE --region "$REGION" >/dev/null || fail "ecr mutate"
sleep 5

echo "=== [$STACK] check MUST detect all four ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-detect.out"
[ "${PIPESTATUS[0]}" -eq 1 ] || fail "expected drift exit 1 after mutations"
for want in TracingConfig DelaySeconds Enabled ImageTagMutability; do
  grep -q "$want" "/tmp/cdkrd-$STACK-detect.out" || fail "mutation NOT detected: $want (FN)"
done

echo "=== [$STACK] revert ==="
$CLI revert "$STACK" --region "$REGION" --yes | tee "/tmp/cdkrd-$STACK-revert.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "revert"
sleep 10

echo "=== [$STACK] assert LIVE values converged back to defaults ==="
TRC=$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" --query 'TracingConfig.Mode' --output text)
[ "$TRC" = "PassThrough" ] || fail "Lambda TracingConfig did NOT converge (live=$TRC) — RSDP candidate"
DLY=$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names DelaySeconds --region "$REGION" --query 'Attributes.DelaySeconds' --output text)
[ "$DLY" = "0" ] || fail "SQS DelaySeconds did NOT converge (live=$DLY) — RSDP candidate"
KEN=$(aws kms describe-key --key-id "$KEYID" --region "$REGION" --query 'KeyMetadata.Enabled' --output text)
[ "$KEN" = "True" ] || [ "$KEN" = "true" ] || fail "KMS Enabled did NOT converge (live=$KEN) — RSDP candidate"
TAGMUT=$(aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" --query 'repositories[0].imageTagMutability' --output text)
[ "$TAGMUT" = "MUTABLE" ] || fail "ECR ImageTagMutability did NOT converge (live=$TAGMUT) — RSDP candidate"

echo "=== [$STACK] final check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN after revert"
echo "INTEG OK ($STACK)"
