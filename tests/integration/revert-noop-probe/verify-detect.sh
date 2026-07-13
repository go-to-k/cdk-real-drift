#!/usr/bin/env bash
# #1583 revert-convergence regression (real AWS): SQS MaximumMessageSize + Lambda
# Url InvokeMode both no-op on a bare `remove` revert (the provider ignores the
# omitted property), so revert must write their KNOWN_DEFAULTS defaults explicitly.
# We deliberately mutate/revert ONLY these two (never a Lambda Function property) so
# the revert never re-uploads Code.ZipFile — that would change the generated
# CodeSha256 and add unrelated noise to the convergence check.
#
# The four converging SQS scalars (VisibilityTimeout / MessageRetentionPeriod /
# DelaySeconds / ReceiveMessageWaitTimeSeconds) are mutated too, as a CONTROL that
# they converge via the bare `remove` (they are intentionally NOT in
# REVERT_SET_DEFAULT_PATHS — the non-uniformity guard).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntRevertNoop0714
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

QURL="$(aws sqs get-queue-url --queue-name "$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK" --logical-resource-id Queue --region "$REGION" \
  --query 'StackResourceDetail.PhysicalResourceId' --output text | sed 's#.*/##')" \
  --region "$REGION" --query QueueUrl --output text)"
FN="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id Fn \
  --region "$REGION" --query 'StackResourceDetail.PhysicalResourceId' --output text)"
[ -n "$QURL" ] && [ -n "$FN" ] || fail "could not resolve Queue/Fn physical ids"

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band mutations (2 no-op targets + 4 converging controls) ==="
aws sqs set-queue-attributes --queue-url "$QURL" --region "$REGION" --attributes \
  MaximumMessageSize=262144,VisibilityTimeout=60,MessageRetentionPeriod=1209600,DelaySeconds=30,ReceiveMessageWaitTimeSeconds=20 \
  || fail "sqs mutate"
aws lambda update-function-url-config --function-name "$FN" --region "$REGION" \
  --invoke-mode RESPONSE_STREAM >/dev/null || fail "url mutate"

echo "=== check MUST DETECT (>=6 undeclared drifts) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-noop-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "MaximumMessageSize" /tmp/cdkrd-noop-detect.out || fail "MaximumMessageSize not reported"
grep -q "InvokeMode" /tmp/cdkrd-noop-detect.out || fail "InvokeMode not reported"

echo "=== revert (write defaults back for the no-op targets, remove for the controls) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"

echo "=== check MUST be CLEAN after revert (convergence) ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) after revert — a revert did not converge"

echo "=== live values MUST be restored to defaults ==="
MMS="$(aws sqs get-queue-attributes --queue-url "$QURL" --region "$REGION" \
  --attribute-names MaximumMessageSize --query 'Attributes.MaximumMessageSize' --output text)"
IM="$(aws lambda get-function-url-config --function-name "$FN" --region "$REGION" \
  --query 'InvokeMode' --output text)"
[ "$MMS" = "1048576" ] || fail "MaximumMessageSize not restored (got: $MMS)"
[ "$IM" = "BUFFERED" ] || fail "InvokeMode not restored (got: $IM)"

echo "INTEG PASS ($STACK detect+revert, #1583)"
