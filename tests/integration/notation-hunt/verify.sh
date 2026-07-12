#!/usr/bin/env bash
# Raw-CFn notation integration test (real AWS): template.yaml (short-form intrinsics,
# Conditions, Mappings, Parameters) is deployed via plain `aws cloudformation deploy`
# (NOT cdk); app.ts is only the discovery shim. Asserts: first check CLEAN (every
# intrinsic resolves), an out-of-band change to a !Ref-parameterized declared value is
# detected against the RESOLVED desired value, and revert converges.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHuntNotation0712c
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack -s "$STACK" -r "$REGION" -y -f >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy raw-CFn template ==="
aws cloudformation deploy --template-file template.yaml --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM --tags cdkrd:ephemeral=1 --region "$REGION" || fail "deploy"

echo "=== [$STACK] FIRST check (no baseline) MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK-first.out"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "first check not CLEAN (intrinsic/notation FP)"

echo "=== [$STACK] record + OOB change to a !Ref-parameterized declared value ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
QURL="$(aws sqs get-queue-url --queue-name "$STACK-q" --region "$REGION" --query QueueUrl --output text)"
aws sqs set-queue-attributes --queue-url "$QURL" \
  --attributes MessageRetentionPeriod=7200 --region "$REGION" || fail "sqs mutate"
sleep 5
$CLI check "$STACK" --region "$REGION" --fail && fail "retention change NOT detected"

echo "=== [$STACK] revert MUST converge to the resolved desired (3600) ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
VAL="$(aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names MessageRetentionPeriod \
  --region "$REGION" --query 'Attributes.MessageRetentionPeriod' --output text)"
[ "$VAL" = "3600" ] || fail "retention not restored (got $VAL)"
$CLI check "$STACK" --region "$REGION" --fail || fail "not CLEAN after revert"

echo "INTEG PASS ($STACK)"
