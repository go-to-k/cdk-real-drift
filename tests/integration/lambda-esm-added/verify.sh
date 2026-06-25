#!/usr/bin/env bash
# cdk-real-drift `added` integ test for Lambda (the FOURTH CHILD_ENUMERATORS member).
#   deploy fixture (Function + declared SQS event source mapping) -> record -> CLEAN
#   -> create-event-source-mapping to an undeclared queue out of band -> check reports
#      the mapping under [Potential Drift] and is NOT drift (exit 0) -> `record` snapshots
#      it (proves CC GetResource + normalize for AWS::Lambda::EventSourceMapping) -> CLEAN
#   -> add ANOTHER out-of-band mapping -> `revert --remove-unrecorded` DELETES it via
#      Cloud Control DeleteResource -> check CLEAN -> destroy.
# `cdk drift` / CFn drift detection miss this (template-only). A cleanup trap destroys
# the stack even on failure; the mappings are removed with the function/queues.
#
# Requires: AWS credentials, a bootstrapped account (CDKToolkit).
# Usage:  cd tests/integration/lambda-esm-added && npm install && bash verify.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
STACK=CdkrdIntegLambdaEsmAdded
REGION="${AWS_REGION:-us-east-1}"
CLI="node $ROOT/dist/cli.js"

cleanup() {
  echo "--- cleanup ---"
  delstack cdk -a cdk.out -r "$REGION" -f -y >/dev/null 2>&1 || npx cdk destroy -f "$STACK" >/dev/null 2>&1 || true
  rm -rf .cdkrd cdk.out
}
trap cleanup EXIT

fail() { echo "INTEG FAIL: $*"; exit 1; }

queue_arn_by_logical() { # $1 = logical-id prefix -> echoes the queue ARN
  local url
  url="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResources[?ResourceType=='AWS::SQS::Queue' && starts_with(LogicalResourceId, '$1')].PhysicalResourceId | [0]" \
    --output text)"
  [ -n "$url" ] && [ "$url" != "None" ] || fail "could not resolve queue url for $1"
  aws sqs get-queue-attributes --queue-url "$url" --attribute-names QueueArn --region "$REGION" \
    --query Attributes.QueueArn --output text
}

inject_mapping() { # $1 = event source queue ARN -> echoes the new mapping UUID
  aws lambda create-event-source-mapping --function-name "$FN_NAME" --event-source-arn "$1" \
    --region "$REGION" --query UUID --output text || fail "create-event-source-mapping"
}

echo "=== build cdk-real-drift ==="
(cd "$ROOT" && vp run build) || fail "build"

echo "=== deploy fixture ==="
npx cdk deploy -f "$STACK" --require-approval never || fail "deploy"

echo "=== record (write baseline) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record"

echo "=== check should be CLEAN ==="
$CLI check "$STACK" --region "$REGION" --fail
[ $? -eq 0 ] || fail "expected CLEAN (exit 0) right after record"

FN_NAME="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)"
[ -n "$FN_NAME" ] || fail "could not resolve Function name"
QUEUE_RECORD_ARN="$(queue_arn_by_logical QueueRecord)"
QUEUE_REVERT_ARN="$(queue_arn_by_logical QueueRevert)"

echo "=== wire an undeclared event source mapping out of band ==="
inject_mapping "$QUEUE_RECORD_ARN" >/dev/null

echo "=== check reports the mapping as Not-Recorded inventory, NOT drift (PR4) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-esm.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 (unrecorded added is NOT drift), got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-esm.out || fail "added mapping not under [Potential Drift]"
grep -q "AWS::Lambda::EventSourceMapping" /tmp/cdkrd-integ-esm.out || fail "the out-of-band mapping not reported"
grep -q "added=" /tmp/cdkrd-integ-esm.out && fail "unrecorded added must not count as drift" || true

echo "=== record the added mapping (snapshot; KEEP watching) ==="
$CLI record "$STACK" --region "$REGION" --yes || fail "record (added)"

echo "=== check should be CLEAN (proves CC GetResource + normalize for EventSourceMapping) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-esm-clean.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected CLEAN (exit 0) after recording the added mapping, got $rc"
grep -q "Potential Drift" /tmp/cdkrd-integ-esm-clean.out && fail "still Not-Recorded after record (GetResource likely failed)" || true

echo "=== add ANOTHER out-of-band mapping (distinct source) for the revert path ==="
UUID2="$(inject_mapping "$QUEUE_REVERT_ARN")"

echo "=== check reports the new one under [Potential Drift] (exit 0) ==="
$CLI check "$STACK" --region "$REGION" --fail | tee /tmp/cdkrd-integ-esm-rev.out
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || fail "expected exit 0 for the second unrecorded added, got $rc"

echo "=== revert --remove-unrecorded DELETES it (Cloud Control DeleteResource) ==="
$CLI revert "$STACK" --region "$REGION" --yes --remove-unrecorded | tee /tmp/cdkrd-integ-esm-revert.out
grep -q "reverted:" /tmp/cdkrd-integ-esm-revert.out || fail "revert did not report a reverted item"
grep -q "CLEAN after revert" /tmp/cdkrd-integ-esm-revert.out || fail "revert did not converge to CLEAN"

echo "=== the second mapping must be gone from AWS ==="
if aws lambda get-event-source-mapping --uuid "$UUID2" --region "$REGION" >/dev/null 2>&1; then
  fail "the reverted mapping still exists (delete did not take effect)"
fi

echo "INTEG PASS"
