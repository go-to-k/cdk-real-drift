#!/usr/bin/env bash
# False-positive integration test (real AWS): deploy -> record baseline -> check
# MUST be CLEAN. A freshly deployed + recorded stack with NO out-of-band change
# must report no drift; any drift here is a normalization / default-folding FP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSnsArchiveRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  # An SNS FIFO topic with an ArchivePolicy cannot be deleted until the policy is
  # cleared (AWS: "Cannot delete a topic with an ArchivePolicy"), which would
  # otherwise leave the stack DELETE_FAILED even under delstack. Clear it first.
  for arn in $(aws sns list-topics --region "$REGION" \
      --query "Topics[?contains(TopicArn,'$STACK')].TopicArn" --output text 2>/dev/null); do
    aws sns set-topic-attributes --topic-arn "$arn" --region "$REGION" \
      --attribute-name ArchivePolicy --attribute-value '{}' >/dev/null 2>&1 || true
  done
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL ($STACK): $*"; exit 1; }

echo "=== [$STACK] deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== [$STACK] record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== [$STACK] check MUST be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail | tee "/tmp/cdkrd-$STACK.out"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "--- FALSE POSITIVE: $STACK reported drift on a clean recorded stack ---"; fail "expected CLEAN (exit 0), got $rc"; }

echo "INTEG PASS ($STACK)"
