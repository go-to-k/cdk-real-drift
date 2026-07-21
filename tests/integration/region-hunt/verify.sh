#!/usr/bin/env bash
# Non-default-region probe (ap-northeast-1): barest pack of wide-fold-surface
# types. First check MUST be CLEAN (any FP = region-sensitive default baked as a
# constant). Then the FN+revert leg in the same region: record, mutate the queue's
# undeclared VisibilityTimeout out of band, assert check --fail DETECTS (exit 1),
# revert, assert the live value is restored and check is CLEAN again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdHunt0721Apne1
REGION="ap-northeast-1"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ($STACK) ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL (region-hunt): $*"; exit 1; }

echo "=== deploy (ap-northeast-1) ==="
AWS_REGION="$REGION" npx cdk deploy -f --all --require-approval never || fail "deploy"

echo "=== FIRST check (no baseline) MUST be CLEAN ==="
CDKRD_CORPUS_DIR="${CDKRD_HUNT_CORPUS_DIR:-/tmp/corpus-region}" $CLI check "$STACK" --region "$REGION" --fail \
  | tee "/tmp/cdkrd-$STACK.pre.out"
RC=${PIPESTATUS[0]}
grep -q "Potential Drift" "/tmp/cdkrd-$STACK.pre.out" && RC=10
[ "$RC" -eq 0 ] || fail "first check not clean (rc=$RC)"

echo "=== record + check --fail ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-record check not clean"

echo "=== FN leg: OOB VisibilityTimeout mutate must be DETECTED ==="
QURL=$(aws sqs list-queues --region "$REGION" --queue-name-prefix "$STACK" \
  --query 'QueueUrls[0]' --output text)
[ -n "$QURL" ] && [ "$QURL" != "None" ] || fail "queue url not found"
aws sqs set-queue-attributes --region "$REGION" --queue-url "$QURL" \
  --attributes VisibilityTimeout=45 || fail "oob mutate"
sleep 5
$CLI check "$STACK" --region "$REGION" --fail && fail "OOB VisibilityTimeout change NOT detected (FN)"

echo "=== revert must restore the default ==="
$CLI revert "$STACK" --region "$REGION" --yes || fail "revert"
VT=$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$QURL" \
  --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text)
[ "$VT" = "30" ] || fail "revert did not restore VisibilityTimeout (live=$VT)"
$CLI check "$STACK" --region "$REGION" --fail || fail "post-revert check not clean"

echo "INTEG OK (region-hunt)"
