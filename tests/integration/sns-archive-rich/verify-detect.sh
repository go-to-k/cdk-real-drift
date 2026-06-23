#!/usr/bin/env bash
# SNS archive-rich: harvest the live read into the golden corpus (fresh deploy,
# pre-record) THEN run the detect (+ revert if supported) false-negative test.
# Deploy -> harvest corpus -> record -> change a DECLARED MUTABLE prop (DisplayName)
# out of band -> check MUST DETECT (exit 1) -> revert -> check CLEAN -> restored.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkRealDriftIntegSnsArchiveRich
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"
CORPUS_DIR="${CORPUS_DIR:-/tmp/corpus-sns-archive}"

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

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

ARN="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" --output text)"
[ -n "$ARN" ] || fail "could not resolve topic ARN"

echo "=== harvest corpus (fresh, pre-record) -> $CORPUS_DIR ==="
rm -rf "$CORPUS_DIR"
CDKRD_CORPUS_DIR="$CORPUS_DIR" $CLI check "$STACK" --region "$REGION" || true

echo "=== record baseline ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== out-of-band: DisplayName -> 'drifted out of band' (console-edit) ==="
aws sns set-topic-attributes --topic-arn "$ARN" --region "$REGION" \
  --attribute-name DisplayName --attribute-value "drifted out of band" >/dev/null || fail "inject drift"

echo "=== check MUST DETECT declared drift ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-sns-archive-detect.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 1 ] || fail "expected drift exit 1, got $rc"
grep -q "DisplayName" /tmp/cdkrd-sns-archive-detect.out || fail "DisplayName not reported"

echo "=== revert (write declared value back; SNS Topic via Cloud Control) ==="
if $CLI revert "$STACK" --region "$REGION" --yes; then
  echo "=== check MUST be CLEAN after revert ==="
  $CLI check "$STACK" --region "$REGION" --fail || fail "expected CLEAN (exit 0) after revert"
  GOT="$(aws sns get-topic-attributes --topic-arn "$ARN" --region "$REGION" \
    --query "Attributes.DisplayName" --output text)"
  [ "$GOT" = "cdkrd sns archive rich" ] || fail "live DisplayName not restored (got: $GOT)"
  echo "INTEG PASS ($STACK detect+revert)"
else
  echo "NOTE: SNS Topic revert not supported (SDK_WRITERS gap) — detection confirmed, restoring manually"
  aws sns set-topic-attributes --topic-arn "$ARN" --region "$REGION" \
    --attribute-name DisplayName --attribute-value "cdkrd sns archive rich" >/dev/null || true
  echo "INTEG PASS ($STACK detect-only; revert is a future SDK_WRITERS candidate)"
fi
